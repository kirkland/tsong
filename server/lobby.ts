// Tracks every connected socket, which two of them hold the paddle spots, and turns
// the Game's raw state into the broadcast message (attaching nicknames / watchers).

import type { WebSocket } from 'ws';
import { Game } from './game';
import { Role, ServerMsg, Side, StateMsg } from '../shared/types';

interface Conn {
  id: string;
  nickname: string; // '' until the client has sent `join`
  role: Role;
}

const SIDES: Side[] = ['left', 'right'];

export class Lobby {
  private conns = new Map<WebSocket, Conn>();
  private sides: Record<Side, WebSocket | null> = { left: null, right: null };
  private winnerName: string | null = null;
  private nextId = 1;

  constructor(private game: Game) {}

  add(ws: WebSocket) {
    const conn: Conn = { id: String(this.nextId++), nickname: '', role: 'observer' };
    this.conns.set(ws, conn);
    this.tell(ws, { type: 'you', id: conn.id, role: 'observer' });
  }

  join(ws: WebSocket, nickname: string) {
    const conn = this.conns.get(ws);
    if (!conn) return;
    conn.nickname = nickname.slice(0, 20).trim() || 'anon';
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
    if (this.game.status === 'over' && (this.sides.left || this.sides.right)) {
      const ws = this.game.winnerSide ? this.sides[this.game.winnerSide] : null;
      this.winnerName = ws ? this.conns.get(ws)?.nickname ?? null : null;
      for (const s of SIDES) this.release(s);
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
    return {
      type: 'state',
      ball: { x: this.game.ball.x, y: this.game.ball.y },
      paddles: {
        left: { y: this.game.paddleY.left, name: this.nameOf('left') },
        right: { y: this.game.paddleY.right, name: this.nameOf('right') },
      },
      score: { ...this.game.score },
      status: this.game.status,
      winner: this.game.status === 'over' ? this.winnerName : null,
      watchers,
    };
  }

  private nameOf(side: Side): string | null {
    const ws = this.sides[side];
    return ws ? this.conns.get(ws)?.nickname ?? null : null;
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
