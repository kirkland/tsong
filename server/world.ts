// The free-roam "World" overworld — server side. Tracks the live position of every avatar
// currently walking the map. Movement is client-authoritative (there's nothing to cheat at
// by walking around), so the server just stores each client's self-reported position, clamped
// to the map bounds, and the Lobby joins in each player's identity (name/color/id) and fans the
// set out to everyone in the world. Knows nothing about networking or the Pong game — like
// game.ts/polygame.ts it's a small, self-contained state holder the Lobby drives.

import type { WebSocket } from 'ws';
import { WORLD } from '../shared/types';

export class World {
  // ws → its avatar's position. Membership in this map IS "is in the world".
  private pos = new Map<WebSocket, { x: number; y: number }>();

  has(ws: WebSocket): boolean {
    return this.pos.has(ws);
  }

  /** How many avatars are currently in the world. */
  get size(): number {
    return this.pos.size;
  }

  sockets(): IterableIterator<WebSocket> {
    return this.pos.keys();
  }

  positionOf(ws: WebSocket): { x: number; y: number } | undefined {
    return this.pos.get(ws);
  }

  /** Drop a fresh avatar in at the central plaza spawn (no-op if already in the world). */
  enter(ws: WebSocket): void {
    if (!this.pos.has(ws)) this.pos.set(ws, { x: WORLD.spawnX, y: WORLD.spawnY });
  }

  leave(ws: WebSocket): void {
    this.pos.delete(ws);
  }

  /** Store a self-reported position, clamped to the map. Ignores non-finite input and any
   *  client that isn't in the world (e.g. a stray message after leaving). */
  move(ws: WebSocket, x: number, y: number): void {
    const p = this.pos.get(ws);
    if (!p) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    p.x = Math.max(0, Math.min(WORLD.w, x));
    p.y = Math.max(0, Math.min(WORLD.h, y));
  }
}
