// The free-roam "World" overworld — server side. Tracks the live position of every avatar
// currently walking the map. Movement is client-authoritative (there's nothing to cheat at
// by walking around), so the server just stores each client's self-reported position, clamped
// to the map bounds, and the Lobby joins in each player's identity (name/color/id) and fans the
// set out to everyone in the world. Knows nothing about networking or the Pong game — like
// game.ts/polygame.ts it's a small, self-contained state holder the Lobby drives.

import type { WebSocket } from 'ws';
import { WORLD } from '../shared/types';

// One avatar's live state in the world. `a` (heading, radians) and `car` (driven car id, or
// null on foot) are purely cosmetic relay state — set from the client's worldMove and fanned
// back out so everyone renders the right thing (a walking avatar vs a pointed car).
interface WorldPos {
  x: number;
  y: number;
  a: number;
  car: string | null;
  pet: string | null;
}

export class World {
  // ws → its avatar's state. Membership in this map IS "is in the world".
  private pos = new Map<WebSocket, WorldPos>();

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

  positionOf(ws: WebSocket): WorldPos | undefined {
    return this.pos.get(ws);
  }

  /** Drop a fresh avatar in at the central plaza spawn (no-op if already in the world). */
  enter(ws: WebSocket): void {
    if (!this.pos.has(ws)) this.pos.set(ws, { x: WORLD.spawnX, y: WORLD.spawnY, a: 0, car: null, pet: null });
  }

  leave(ws: WebSocket): void {
    this.pos.delete(ws);
  }

  /** Store a self-reported position (clamped to the map) plus heading + driven car + trailing
   *  pet. Ignores non-finite input and any client that isn't in the world (e.g. a stray late
   *  message). */
  move(ws: WebSocket, x: number, y: number, a?: number, car?: string | null, pet?: string | null): void {
    const p = this.pos.get(ws);
    if (!p) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    p.x = Math.max(0, Math.min(WORLD.w, x));
    p.y = Math.max(0, Math.min(WORLD.h, y));
    if (typeof a === 'number' && Number.isFinite(a)) p.a = a;
    p.car = typeof car === 'string' ? car : null;
    p.pet = typeof pet === 'string' ? pet : null;
  }
}
