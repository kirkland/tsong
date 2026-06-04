// Tracks every connected socket, which two of them hold the paddle spots, and turns
// the Game's raw state into the broadcast message (attaching nicknames / watchers).

import type { WebSocket } from 'ws';
import { Game } from './game';
import {
  CHAT_HISTORY,
  CHAT_MAX_LEN,
  ChatLine,
  BALL_REACTION,
  LeaderboardRow,
  REACTIONS,
  Role,
  ServerMsg,
  Side,
  StateMsg,
} from '../shared/types';

const ALLOWED_REACTIONS = new Set<string>([...REACTIONS, BALL_REACTION]);
import { getLeaderboard, recordResult, updateName } from './db';

interface Conn {
  id: string; // per-connection id (used in `you` messages)
  pid: string; // stable per-browser identity (leaderboard key); '' until joined
  nickname: string; // '' until the client has sent `join`
  role: Role;
  color: string; // chosen paddle color
  lastChatAt: number; // ms timestamp of last chat message (light rate limiting)
}

const SIDES: Side[] = ['left', 'right'];

export class Lobby {
  private conns = new Map<WebSocket, Conn>();
  private sides: Record<Side, WebSocket | null> = { left: null, right: null };
  private winnerName: string | null = null;
  private overHandled = false; // guards the one-time spot reopening when a match ends
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
    if (!ALLOWED_REACTIONS.has(emoji)) return; // only known emojis
    const now = Date.now();
    if (now - conn.lastChatAt < 250) return; // share the chat throttle (light anti-spam)
    conn.lastChatAt = now;

    const data = JSON.stringify({ type: 'reaction', emoji });
    for (const sock of this.conns.keys()) {
      if (sock.readyState === sock.OPEN) sock.send(data);
    }
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
        for (const s of SIDES) this.release(s);
        this.overHandled = true;

        // Record against stable identities (pids), storing the current display names.
        if (winner?.pid && loser?.pid) {
          recordResult(winner.pid, winner.nickname, loser.pid, loser.nickname)
            .then(() => this.refreshLeaderboard())
            .catch((e) => console.error('leaderboard update failed:', e));
        }
      }
    } else {
      this.overHandled = false;
    }
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
    return {
      type: 'state',
      ball: {
        x: this.game.ball.x,
        y: this.game.ball.y,
        // Take on the color of the paddle that last hit it; neutral until first touch.
        color: lastHit ? this.colorOf(lastHit) : '#e8eefc',
      },
      ballSpeed: Math.hypot(this.game.ball.vx, this.game.ball.vy),
      paddles: {
        left: { x: this.game.paddleX.left, y: this.game.paddleY.left, name: this.nameOf('left'), color: this.colorOf('left') },
        right: { x: this.game.paddleX.right, y: this.game.paddleY.right, name: this.nameOf('right'), color: this.colorOf('right') },
      },
      score: { ...this.game.score },
      status: this.game.status,
      closing: this.game.closing,
      winner: this.game.status === 'over' ? this.winnerName : null,
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
