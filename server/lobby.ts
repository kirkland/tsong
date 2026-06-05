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
const RESUME_GRACE = 45; // seconds a resumed match waits for seated players to reconnect

// What a seat / queue spot needs to be reclaimed by the same identity after a restart.
interface SeatInfo {
  pid: string;
  nickname: string;
  color: string;
}

// Everything the lobby needs to put players back where they were after a restart.
// Seats, king and queue are stored by stable pid (sockets don't survive a restart);
// reconnecting clients reclaim them in join(). The rest is plain state.
export interface LobbySnapshot {
  sides: Record<Side, SeatInfo | null>;
  king: { side: Side; pid: string; nickname: string } | null;
  streakPid: string | null;
  kingStreak: number;
  fatalityWinnerPid: string | null;
  fatalityWinnerSide: Side | null;
  activeFatality: { side: Side; move: string } | null;
  fatalityAt: number;
  fatalitiesEnabled: boolean;
  queue: { pid: string; nickname: string }[];
  ready: Record<Side, boolean>;
  readyTimer: number;
  winnerName: string | null;
  overHandled: boolean;
  chatLog: ChatLine[];
}

export class Lobby {
  private conns = new Map<WebSocket, Conn>();
  private sides: Record<Side, WebSocket | null> = { left: null, right: null };
  private winnerName: string | null = null;
  private overHandled = false; // guards the one-time spot reopening when a match ends
  private king: { side: Side; pid: string; nickname: string; ws: WebSocket } | null = null;
  private streakPid: string | null = null; // pid of the player on the current win streak
  private kingStreak = 0; // consecutive match wins by that player (the king's reign length)
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

  // Restart resume: seats/king/queue a previous process held, keyed by stable pid,
  // waiting for those clients to reconnect and reclaim them (see restore/reattach).
  private pendingSides: Record<Side, SeatInfo | null> = { left: null, right: null };
  private pendingKing: { side: Side; pid: string; nickname: string } | null = null;
  private pendingQueue: { pid: string; nickname: string }[] = [];
  private resumeGrace = 0; // seconds left to reclaim seats before abandoning the resume

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

  // End the current win streak (a reign ended by something other than a win).
  private endStreak() {
    this.streakPid = null;
    this.kingStreak = 0;
  }

  /** "/ff": a player abandons their paddle mid-match and is publicly shamed for it. */
  forfeit(ws: WebSocket) {
    const side = this.sideOf(ws);
    if (!side) return; // only someone currently holding a paddle can forfeit
    const conn = this.conns.get(ws);
    const name = conn?.nickname || 'someone';
    if (conn?.pid === this.streakPid) this.endStreak(); // bailing forfeits the reign
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
    this.endStreak(); // stepping down ends the reign
    this.release(side);
    if (this.game.status === 'over') this.game.toWaiting();
  }

  /** "/powerup": drop a random power-up target. Spectators only — a player in the
   *  current match can't conjure power-ups for themselves. */
  spawnPowerup(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return; // must have joined
    if (this.sideOf(ws)) return; // not from someone currently holding a paddle
    this.game.forceTarget();
  }

  join(ws: WebSocket, nickname: string, pid: string, color?: string) {
    const conn = this.conns.get(ws);
    if (!conn) return;
    conn.pid = pid.slice(0, 64);
    conn.nickname = nickname.slice(0, 20).trim() || 'anon';
    if (color) conn.color = color;
    // Reclaim a seat / king / queue spot this identity held before a restart, if any.
    this.reattach(ws, conn);
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
    if (this.conns.get(ws)?.pid === this.streakPid) this.endStreak(); // streak holder left
    this.queueLeave(ws);
    this.conns.delete(ws);
    this.refreshPause();
  }

  /** Called every tick after game.tick(). Reopens both spots once a match ends. */
  sync() {
    this.expireResume();
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
          // Win streak: extend it if the same player just defended their throne,
          // otherwise this is a fresh king with a streak of one.
          this.kingStreak = winner.pid === this.streakPid ? this.kingStreak + 1 : 1;
          this.streakPid = winner.pid;
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
            this.endStreak(); // reign lapses if no rematch is readied in time
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
          frozen: this.game.freezeTimer.left > 0,
          mirrored: this.game.mirrorTimer.left > 0,
          shielded: this.game.shielded.left,
          blinded: this.game.blindTimer.left > 0,
          curveReady: this.game.curveHits.left > 0,
        },
        right: {
          x: this.game.paddleX.right,
          y: this.game.paddleY.right,
          name: this.nameOf('right'),
          color: this.colorOf('right'),
          h: this.game.halfH('right') * 2,
          frozen: this.game.freezeTimer.right > 0,
          mirrored: this.game.mirrorTimer.right > 0,
          shielded: this.game.shielded.right,
          blinded: this.game.blindTimer.right > 0,
          curveReady: this.game.curveHits.right > 0,
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
      kingWins: this.kingStreak,
      queue: this.queue.map((ws) => this.conns.get(ws)?.nickname ?? '').filter(Boolean),
      ready: { ...this.ready },
      ghostBall: this.game.ghostTimer > 0,
      tinyBall: this.game.tinyTimer > 0,
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

  // --- restart resume ---

  /** Snapshot the lobby for persistence across a restart (paired with restore). */
  serialize(): LobbySnapshot {
    const seat = (side: Side): SeatInfo | null => {
      const c = this.connOn(side);
      return c && c.pid ? { pid: c.pid, nickname: c.nickname, color: c.color } : null;
    };
    return {
      sides: { left: seat('left'), right: seat('right') },
      king: this.king
        ? { side: this.king.side, pid: this.king.pid, nickname: this.king.nickname }
        : null,
      streakPid: this.streakPid,
      kingStreak: this.kingStreak,
      fatalityWinnerPid: this.fatalityWinnerPid,
      fatalityWinnerSide: this.fatalityWinnerSide,
      activeFatality: this.activeFatality,
      fatalityAt: this.fatalityAt,
      fatalitiesEnabled: this.fatalitiesEnabled,
      queue: this.queue
        .map((ws) => this.conns.get(ws))
        .filter((c): c is Conn => !!c && !!c.pid && !!c.nickname)
        .map((c) => ({ pid: c.pid, nickname: c.nickname })),
      ready: { ...this.ready },
      readyTimer: this.readyTimer,
      winnerName: this.winnerName,
      overHandled: this.overHandled,
      chatLog: this.chatLog,
    };
  }

  /** Restore a snapshot after a restart. Seats/king/queue become pending reattachments
   *  that their clients reclaim by pid as they reconnect; the rest is set directly. */
  restore(s: LobbySnapshot) {
    this.pendingSides = s.sides ?? { left: null, right: null };
    this.pendingKing = s.king ?? null;
    this.pendingQueue = s.queue ?? [];
    this.streakPid = s.streakPid ?? null;
    this.kingStreak = s.kingStreak ?? 0;
    this.fatalityWinnerPid = s.fatalityWinnerPid ?? null;
    this.fatalityWinnerSide = s.fatalityWinnerSide ?? null;
    this.activeFatality = s.activeFatality ?? null;
    this.fatalityAt = s.fatalityAt ?? 0;
    this.fatalitiesEnabled = !!s.fatalitiesEnabled;
    this.ready = s.ready ?? { left: false, right: false };
    this.readyTimer = s.readyTimer ?? 0;
    this.winnerName = s.winnerName ?? null;
    this.overHandled = !!s.overHandled;
    this.chatLog = Array.isArray(s.chatLog) ? s.chatLog : [];
    // Give seated players a window to reconnect and reclaim their seats; if they don't,
    // expireResume() abandons the resume so the room isn't wedged on a frozen match.
    if (this.pendingSides.left || this.pendingSides.right) this.resumeGrace = RESUME_GRACE;
  }

  /** On (re)join, reclaim any seat / king / queue spot this identity held pre-restart. */
  private reattach(ws: WebSocket, conn: Conn) {
    if (!conn.pid) return;
    for (const side of SIDES) {
      const p = this.pendingSides[side];
      if (p && p.pid === conn.pid && this.sides[side] === null) {
        this.pendingSides[side] = null;
        this.sides[side] = ws;
        conn.role = side;
        conn.captured = false; // must re-capture the mouse to unfreeze the resumed match
        if (p.color) conn.color = p.color;
        this.tell(ws, { type: 'you', id: conn.id, role: side });
        // The reigning winner sits on their seat through the 'over' screen — restore it.
        if (this.pendingKing && this.pendingKing.pid === conn.pid) {
          this.king = { side, pid: conn.pid, nickname: conn.nickname, ws };
          this.pendingKing = null;
        }
        if (!this.pendingSides.left && !this.pendingSides.right) this.resumeGrace = 0;
        return;
      }
    }
    const qi = this.pendingQueue.findIndex((q) => q.pid === conn.pid);
    if (qi !== -1) {
      this.pendingQueue.splice(qi, 1);
      if (!this.queue.includes(ws) && !this.sideOf(ws)) this.queue.push(ws);
    }
  }

  /** Count down the resume window; when it lapses with seats still unclaimed, give up
   *  on the resume and return to the lobby so a missing player can't wedge the room. */
  private expireResume() {
    if (this.resumeGrace <= 0) return;
    this.resumeGrace -= TICK_MS / 1000;
    if (this.resumeGrace > 0) return;
    if (this.pendingSides.left || this.pendingSides.right) {
      this.pendingSides = { left: null, right: null };
      this.pendingKing = null;
      for (const side of SIDES) this.release(side);
      this.king = null;
      this.endStreak();
      if (this.game.status !== 'waiting') this.game.toWaiting();
    }
  }

  private tell(ws: WebSocket, msg: ServerMsg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}
