// Tracks every connected socket, which two of them hold the paddle spots, and turns
// the Game's raw state into the broadcast message (attaching nicknames / watchers).

import type { WebSocket } from 'ws';
import { Game } from './game';
import {
  CHAT_HISTORY,
  CHAT_MAX_LEN,
  ChatLine,
  BALL_REACTION,
  FATALITY_MOVES,
  LeaderboardRow,
  Role,
  ServerMsg,
  Side,
  StateMsg,
} from '../shared/types';
import { getLeaderboard, recordResult, updateName } from './db';
import { READY_TIMEOUT, TICK_MS } from '../shared/types';

// A reaction is valid if it's the ball sentinel or a short string made only of
// emoji code points (pictographs, components, ZWJ, variation selectors, flags).
// This lets the full picker through while blocking arbitrary text / markup.
const EMOJI_ONLY =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Regional_Indicator}|‍|️)+$/u;
function isValidReaction(emoji: string): boolean {
  if (emoji === BALL_REACTION) return true;
  return emoji.length > 0 && emoji.length <= 16 && EMOJI_ONLY.test(emoji);
}

interface Conn {
  id: string; // per-connection id (used in `you` messages)
  pid: string; // stable per-browser identity (leaderboard key); '' until joined
  nickname: string; // '' until the client has sent `join`
  role: Role;
  color: string; // chosen paddle color
  captured: boolean; // mouse captured to the board (pointer lock); gates play start
  lastChatAt: number; // ms timestamp of last chat message (light rate limiting)
}

const SIDES: Side[] = ['left', 'right'];
const FATALITY_DISPLAY_MS = 4500; // how long the finishing move holds before the lobby resets

export class Lobby {
  private conns = new Map<WebSocket, Conn>();
  private sides: Record<Side, WebSocket | null> = { left: null, right: null };
  private winnerName: string | null = null;
  private overHandled = false; // guards the one-time spot reopening when a match ends
  private king: { side: Side; pid: string; nickname: string; ws: WebSocket } | null = null;
  // The winner is released to observer the instant the match ends, so we can't use the
  // side slots to authorize a finishing move — we remember who won by stable pid/side.
  private fatalityWinnerPid: string | null = null;
  private fatalityWinnerSide: Side | null = null;
  private activeFatality: { side: Side; move: string } | null = null;
  private fatalityAt = 0; // ms timestamp the finishing move started (0 = none)
  private fatalitiesEnabled = false; // shared room-wide toggle (off for everyone by default)
  private queue: WebSocket[] = []; // ordered spectators waiting to play
  private ready: Record<Side, boolean> = { left: false, right: false };
  private readyTimer = 0; // seconds remaining for ready-up; 0 = no timer active
  private leaderboard: LeaderboardRow[] = []; // cached standings, pushed to clients
  private chatLog: ChatLine[] = []; // recent chat, replayed to new connections
  private nextId = 1;

  constructor(private game: Game) {}

  add(ws: WebSocket) {
    const conn: Conn = {
      id: String(this.nextId++),
      pid: '',
      nickname: '',
      role: 'observer',
      color: '#e8eefc',
      captured: false,
      lastChatAt: 0,
    };
    this.conns.set(ws, conn);
    this.tell(ws, { type: 'you', id: conn.id, role: 'observer' });
    this.tell(ws, { type: 'leaderboard', rows: this.leaderboard });
    if (this.chatLog.length) this.tell(ws, { type: 'chat', lines: this.chatLog });
  }

  chat(ws: WebSocket, text: string) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return; // must have joined
    const now = Date.now();
    if (now - conn.lastChatAt < 400) return; // light anti-spam throttle
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LEN);
    if (!clean) return;
    conn.lastChatAt = now;

    const line: ChatLine = {
      from: conn.nickname,
      text: clean,
      player: conn.role === 'left' || conn.role === 'right',
      color: conn.color,
    };
    this.chatLog.push(line);
    if (this.chatLog.length > CHAT_HISTORY) this.chatLog.shift();

    const data = JSON.stringify({ type: 'chat', lines: [line] });
    for (const sock of this.conns.keys()) {
      if (sock.readyState === sock.OPEN) sock.send(data);
    }
  }

  reaction(ws: WebSocket, emoji: string) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return; // must have joined
    if (!isValidReaction(emoji)) return; // emoji (or the ball sentinel) only
    const now = Date.now();
    if (now - conn.lastChatAt < 250) return; // share the chat throttle (light anti-spam)
    conn.lastChatAt = now;

    const data = JSON.stringify({ type: 'reaction', emoji });
    for (const sock of this.conns.keys()) {
      if (sock.readyState === sock.OPEN) sock.send(data);
    }
  }

  /** "/ff": a player abandons their paddle mid-match and is publicly shamed for it. */
  forfeit(ws: WebSocket) {
    const side = this.sideOf(ws);
    if (!side) return; // only someone currently holding a paddle can forfeit
    const conn = this.conns.get(ws);
    const name = conn?.nickname || 'someone';
    // Vacate the spot (and drop a live match back to waiting), like a quiet leave...
    this.release(side);
    if (this.game.status === 'playing') this.game.toWaiting();
    // ...but loudly, so everyone knows.
    this.announce(`Booo, ${name} quit the game`);
  }

  /** Join the spectator queue. */
  queueJoin(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return;
    if (this.queue.includes(ws)) return;
    // Don't queue if already holding a paddle
    if (this.sideOf(ws)) return;
    this.queue.push(ws);
  }

  /** Leave the spectator queue. */
  queueLeave(ws: WebSocket) {
    const i = this.queue.indexOf(ws);
    if (i !== -1) this.queue.splice(i, 1);
  }

  /** Auto-assign the next queued spectator to an open paddle spot. */
  private claimFromQueue() {
    while (this.queue.length > 0) {
      const openSide = SIDES.find((s) => this.sides[s] === null);
      if (!openSide) break;
      const next = this.queue.shift()!;
      const conn = this.conns.get(next);
      if (!conn || !conn.nickname) continue; // stale entry
      this.sides[openSide] = next;
      conn.role = openSide;
      conn.captured = false;
      this.tell(next, { type: 'you', id: conn.id, role: openSide });
    }
  }

  /** Toggle ready state for a player. */
  setReady(ws: WebSocket) {
    const side = this.sideOf(ws);
    if (!side) return;
    if (this.game.status !== 'over') return;
    this.ready[side] = !this.ready[side];
    // Start the ready timer when the first player readies up
    if (this.ready[side] && this.readyTimer <= 0) {
      this.readyTimer = READY_TIMEOUT;
    }
  }

  /** The winner (king) declines to stay — releases their spot. */
  kingExit(ws: WebSocket) {
    if (!this.king || this.king.ws !== ws) return; // only the king can exit
    const side = this.king.side;
    this.king = null;
    this.release(side);
    if (this.game.status === 'over') this.game.toWaiting();
  }

  /** "/powerup": drop a random power-up target onto the board. Live matches only. */
  spawnPowerup(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return; // must have joined
    this.game.forceTarget();
  }

  join(ws: WebSocket, nickname: string, pid: string, color?: string) {
    const conn = this.conns.get(ws);
    if (!conn) return;
    conn.pid = pid.slice(0, 64);
    conn.nickname = nickname.slice(0, 20).trim() || 'anon';
    if (color) conn.color = color;
    // If this identity already has a leaderboard record, reflect the (possibly new)
    // display name right away — a rename shows on the board without playing again.
    updateName(conn.pid, conn.nickname)
      .then((changed) => {
        if (changed) this.refreshLeaderboard();
      })
      .catch((e) => console.error('name update failed:', e));
  }

  claim(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || conn.role !== 'observer') return;
    // Remove from queue if they were in it
    this.queueLeave(ws);
    const side = SIDES.find((s) => this.sides[s] === null);
    if (!side) return;
    this.sides[side] = ws;
    conn.role = side;
    conn.captured = false;
    this.tell(ws, { type: 'you', id: conn.id, role: side });
    // Don't auto-start if both are filled — wait for ready-up if coming from an 'over' state
    if (this.sides.left && this.sides.right) {
      if (this.game.status === 'over') {
        // Both spots filled after game: wait for ready-ups
        this.ready = { left: false, right: false };
        this.readyTimer = 0;
      } else {
        this.game.start();
      }
    }
    this.refreshPause();
  }

  setPaddle(ws: WebSocket, y: number) {
    const side = this.sideOf(ws);
    if (side) this.game.setTarget(side, y);
  }

  // A player's mouse-capture (pointer lock) state changed. The match stays frozen until
  // both side players have their mouse captured.
  setCapture(ws: WebSocket, on: boolean) {
    const conn = this.conns.get(ws);
    if (!conn) return;
    conn.captured = on;
    this.refreshPause();
  }

  private isCaptured(side: Side): boolean {
    const ws = this.sides[side];
    return ws ? this.conns.get(ws)?.captured ?? false : false;
  }

  private refreshPause() {
    this.game.paused = !(this.isCaptured('left') && this.isCaptured('right'));
  }

  // Any joined client may arm/disarm closing-walls mode; it applies from the next match.
  setMode(ws: WebSocket, closing: boolean) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return;
    this.game.setClosing(closing);
  }

  remove(ws: WebSocket) {
    const side = this.sideOf(ws);
    if (side) {
      this.sides[side] = null;
      if (this.game.status === 'playing') this.game.toWaiting();
    }
    if (this.king && this.king.ws === ws) this.king = null;
    this.queueLeave(ws);
    this.conns.delete(ws);
    this.refreshPause();
  }

  /** Called every tick after game.tick(). Reopens both spots once a match ends. */
  sync() {
    // Reopen both spots exactly once, when the match first ends. Doing this every
    // tick would re-release the next player the instant they claim a spot, making it
    // impossible to start a second game.
    if (this.game.status === 'over') {
      if (!this.overHandled) {
        const winnerSide = this.game.winnerSide;
        const loserSide: Side | null = winnerSide
          ? winnerSide === 'left'
            ? 'right'
            : 'left'
          : null;
        const winner = winnerSide ? this.connOn(winnerSide) : null;
        const loser = loserSide ? this.connOn(loserSide) : null;
        this.winnerName = winner?.nickname ?? null;
        this.fatalityWinnerPid = winner?.pid ?? null;
        this.fatalityWinnerSide = winnerSide;
        this.activeFatality = null;
        // Release the loser; winner stays as king
        if (loserSide) this.release(loserSide);
        if (winner && winnerSide) {
          this.king = {
            side: winnerSide,
            pid: winner.pid,
            nickname: winner.nickname,
            ws: this.sides[winnerSide]!,
          };
        }
        this.overHandled = true;

        if (winner?.pid && loser?.pid) {
          recordResult(winner.pid, winner.nickname, loser.pid, loser.nickname)
            .then(() => this.refreshLeaderboard())
            .catch((e) => console.error('leaderboard update failed:', e));
        }
      } else if (this.activeFatality && Date.now() - this.fatalityAt > FATALITY_DISPLAY_MS) {
        // Once the finishing move has played out, return to the lobby so the frozen
        // FATALITY screen clears and a fresh match can be started.
        this.activeFatality = null;
        this.game.toWaiting();
      } else if (this.sides.left && this.sides.right) {
        // Both spots filled after game: wait for ready-up
        if (this.ready.left && this.ready.right) {
          // Both ready: start the next match
          this.ready = { left: false, right: false };
          this.readyTimer = 0;
          this.overHandled = false;
          this.fatalityWinnerPid = null;
          this.fatalityWinnerSide = null;
          this.activeFatality = null;
          this.fatalityAt = 0;
          this.game.start();
        } else if (this.readyTimer > 0) {
          this.readyTimer -= TICK_MS / 1000;
          if (this.readyTimer <= 0) {
            // Timeout: release both spots
            for (const s of SIDES) this.release(s);
            this.ready = { left: false, right: false };
            this.readyTimer = 0;
            this.game.toWaiting();
          }
        }
      }
    } else {
      this.overHandled = false;
      this.fatalityWinnerPid = null;
      this.fatalityWinnerSide = null;
      this.activeFatality = null;
      this.fatalityAt = 0;
      this.ready = { left: false, right: false };
      this.readyTimer = 0;
      if (this.game.status === 'playing') this.king = null;
      // Catch-all: idle in the lobby with both spots filled (e.g. the queue auto-filled
      // a seat after a forfeit, a leave, or a ready-timeout). Kick off the match —
      // otherwise it sits frozen in 'waiting' with two players present.
      if (this.game.status === 'waiting' && this.sides.left && this.sides.right) {
        this.game.start();
      }
    }
    // Keep the pause flag honest every tick: a live match only advances once both
    // players have captured their mouse, no matter how the seats got filled.
    this.refreshPause();
  }

  /** Flip the shared fatalities toggle for the whole room. Any joined user may change it. */
  setFatalities(ws: WebSocket, enabled: boolean) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return; // must have joined
    this.fatalitiesEnabled = enabled;
  }

  /**
   * Perform the winner's finishing move. Cosmetic only (no leaderboard impact), so the
   * checks are light — but we still confirm the sender is the actual winner (by stable
   * pid), that the match is over, and that the move is one we know about, so a random
   * observer can't trigger or spoof a fatality.
   */
  fatality(ws: WebSocket, move: string) {
    if (!this.fatalitiesEnabled) return; // disabled room-wide
    if (this.game.status !== 'over') return;
    if (!this.fatalityWinnerSide || this.activeFatality) return; // no winner, or already done
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid || conn.pid !== this.fatalityWinnerPid) return; // not the winner
    if (!(FATALITY_MOVES as readonly string[]).includes(move)) return; // unknown move
    this.activeFatality = { side: this.fatalityWinnerSide, move };
    this.fatalityAt = Date.now();
  }

  /** Re-query the standings, cache them, and push to every connected client. */
  async refreshLeaderboard() {
    this.leaderboard = await getLeaderboard();
    const data = JSON.stringify({ type: 'leaderboard', rows: this.leaderboard });
    for (const ws of this.conns.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  broadcast() {
    const msg = this.buildState();
    const data = JSON.stringify(msg);
    for (const ws of this.conns.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  // --- internals ---

  /** Fan a big center-screen banner out to every client (transient, not kept). */
  private announce(text: string) {
    const data = JSON.stringify({ type: 'announce', text });
    for (const sock of this.conns.keys()) {
      if (sock.readyState === sock.OPEN) sock.send(data);
    }
  }

  private release(side: Side) {
    const ws = this.sides[side];
    if (ws) {
      const conn = this.conns.get(ws);
      if (conn) {
        conn.role = 'observer';
        conn.captured = false;
        this.tell(ws, { type: 'you', id: conn.id, role: 'observer' });
      }
    }
    this.sides[side] = null;
    this.ready[side] = false;
    // Clear king if their side was released
    if (this.king && this.king.side === side) this.king = null;
    // Auto-claim from queue if someone is waiting
    this.claimFromQueue();
  }

  private buildState(): StateMsg {
    const watchers: string[] = [];
    for (const c of this.conns.values()) {
      if (c.role === 'observer' && c.nickname) watchers.push(c.nickname);
    }
    const lastHit = this.game.lastHit;
    const ballColor = lastHit ? this.colorOf(lastHit) : '#e8eefc';
    return {
      type: 'state',
      ball: {
        x: this.game.ball.x,
        y: this.game.ball.y,
        // Take on the color of the paddle that last hit it; neutral until first touch.
        color: ballColor,
      },
      extraBalls: this.game.extraBalls.map((b) => ({ x: b.x, y: b.y, color: ballColor })),
      ballSpeed: Math.hypot(this.game.ball.vx, this.game.ball.vy),
      paddles: {
        left: {
          x: this.game.paddleX.left,
          y: this.game.paddleY.left,
          name: this.nameOf('left'),
          color: this.colorOf('left'),
          h: this.game.halfH('left') * 2,
        },
        right: {
          x: this.game.paddleX.right,
          y: this.game.paddleY.right,
          name: this.nameOf('right'),
          color: this.colorOf('right'),
          h: this.game.halfH('right') * 2,
        },
      },
      target: this.game.target
        ? { x: this.game.target.x, y: this.game.target.y, kind: this.game.target.kind }
        : null,
      score: { ...this.game.score },
      status: this.game.status,
      paused: this.game.status === 'playing' && this.game.paused,
      closing: this.game.closing,
      winner: this.game.status === 'over' ? this.winnerName : null,
      fatalitiesEnabled: this.fatalitiesEnabled,
      fatality: this.game.status === 'over' ? this.activeFatality : null,
      watchers,
      king: this.king?.nickname ?? null,
      queue: this.queue.map((ws) => this.conns.get(ws)?.nickname ?? '').filter(Boolean),
      ready: { ...this.ready },
    };
  }

  private nameOf(side: Side): string | null {
    const ws = this.sides[side];
    return ws ? this.conns.get(ws)?.nickname ?? null : null;
  }

  private colorOf(side: Side): string {
    const ws = this.sides[side];
    return ws ? this.conns.get(ws)?.color ?? '#e8eefc' : '#e8eefc';
  }

  private connOn(side: Side): Conn | null {
    const ws = this.sides[side];
    return ws ? this.conns.get(ws) ?? null : null;
  }

  private sideOf(ws: WebSocket): Side | null {
    if (this.sides.left === ws) return 'left';
    if (this.sides.right === ws) return 'right';
    return null;
  }

  private tell(ws: WebSocket, msg: ServerMsg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}
