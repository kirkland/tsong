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
  lastChatAt: number; // ms timestamp of last chat message (light rate limiting)
}

const SIDES: Side[] = ['left', 'right'];
const FATALITY_DISPLAY_MS = 4500; // how long the finishing move holds before the lobby resets

export class Lobby {
  private conns = new Map<WebSocket, Conn>();
  private sides: Record<Side, WebSocket | null> = { left: null, right: null };
  private winnerName: string | null = null;
  private overHandled = false; // guards the one-time spot reopening when a match ends
  // The winner is released to observer the instant the match ends, so we can't use the
  // side slots to authorize a finishing move — we remember who won by stable pid/side.
  private fatalityWinnerPid: string | null = null;
  private fatalityWinnerSide: Side | null = null;
  private activeFatality: { side: Side; move: string } | null = null;
  private fatalityAt = 0; // ms timestamp the finishing move started (0 = none)
  private fatalitiesEnabled = false; // shared room-wide toggle (off for everyone by default)
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
    if (!conn || !conn.nickname || conn.role !== 'observer') return; // must have joined first
    const side = SIDES.find((s) => this.sides[s] === null);
    if (!side) return; // no spot open
    this.sides[side] = ws;
    conn.role = side;
    this.tell(ws, { type: 'you', id: conn.id, role: side });
    if (this.sides.left && this.sides.right) this.game.start();
  }

  setPaddle(ws: WebSocket, y: number) {
    const side = this.sideOf(ws);
    if (side) this.game.setTarget(side, y);
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
    this.conns.delete(ws);
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
        // Capture both players before releasing (release nulls out the side slots).
        const winner = winnerSide ? this.connOn(winnerSide) : null;
        const loser = loserSide ? this.connOn(loserSide) : null;
        this.winnerName = winner?.nickname ?? null;
        // Remember the winner so a fatality message can be authorized after release.
        this.fatalityWinnerPid = winner?.pid ?? null;
        this.fatalityWinnerSide = winnerSide;
        this.activeFatality = null;
        for (const s of SIDES) this.release(s);
        this.overHandled = true;

        // Record against stable identities (pids), storing the current display names.
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
      }
    } else {
      this.overHandled = false;
      // Match no longer over (back to waiting/playing): clear the finishing-move window.
      this.fatalityWinnerPid = null;
      this.fatalityWinnerSide = null;
      this.activeFatality = null;
      this.fatalityAt = 0;
    }
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
        this.tell(ws, { type: 'you', id: conn.id, role: 'observer' });
      }
    }
    this.sides[side] = null;
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
      closing: this.game.closing,
      winner: this.game.status === 'over' ? this.winnerName : null,
      fatalitiesEnabled: this.fatalitiesEnabled,
      fatality: this.game.status === 'over' ? this.activeFatality : null,
      watchers,
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
