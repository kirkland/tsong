// "Bolwoing Alley" — server-authoritative turn-based bowling for 2–4 players.
//
// Players walk into the Bolwoing Alley and get queued into a room. Once 2+
// players are ready, the game starts. Each frame: the active player sends their
// throw ({offset, power}), the server simulates pin physics, and broadcasts the
// result to all players in the room. 10 standard frames, standard scoring
// (strikes, spares, 10th-frame bonus balls). Winner gets coins.

import type { WebSocket } from 'ws';

// --- Pin layout ---
// Pins 1–10, 0-indexed internally (0 = headpin, 9 = pin 10 in the back-right).
// Coordinates in "pin units": headpin at (0,0), each row steps back 1 unit,
// each diagonal neighbor steps 0.5 units to the side.
//   Row 1: pin 0 at (0,0)
//   Row 2: pins 1,2 at (-0.5,1),(0.5,1)
//   Row 3: pins 3,4,5 at (-1,2),(0,2),(1,2)
//   Row 4: pins 6,7,8,9 at (-1.5,3),(-0.5,3),(0.5,3),(1.5,3)
const PIN_XY: [number, number][] = [
  [0, 0],
  [-0.5, 1], [0.5, 1],
  [-1, 2], [0, 2], [1, 2],
  [-1.5, 3], [-0.5, 3], [0.5, 3], [1.5, 3],
];
const BALL_R = 0.38; // ball radius in pin units
const PIN_R  = 0.18; // pin radius in pin units
const HIT_D  = BALL_R + PIN_R; // direct ball–pin contact distance

/** Simulate a single ball roll. Returns new standing mask (true = still up).
 *  offset: -1..1 (left gutter to right gutter, 0 = lane center)
 *  power:  0..1 (affects a small random wobble — weak throws wobble more)
 *  standing: current pin state (true = standing)
 */
export function simulateThrow(standing: boolean[], offset: number, power: number, rng: () => number): boolean[] {
  // Map lane offset (−1..1) to pin-coordinate space (lane half-width ≈ 1.9 pin units)
  const laneX = offset * 1.9;

  // Weak throws get more wobble (up to ±0.4 pin units at power=0, ±0.05 at power=1)
  const wobble = (1 - power) * 0.4 * (rng() * 2 - 1);
  let bx = laneX + wobble;
  let by = -1.2; // start before the head pin

  // Ball travels mostly "into the lane" with a very slight hook toward center.
  // Keep the multiplier tiny — large values cause the ball to wildly overshoot
  // the opposite side of the lane by the time it reaches the pin deck.
  const dx = -bx * 0.002; // gentle hook (not overcorrection)
  const dy = 0.06;         // step size per iteration

  const result = [...standing];

  // Track flying pins (knocked pin + velocity) for chain reactions
  interface FlyPin { x: number; y: number; vx: number; vy: number; idx: number; }
  const flying: FlyPin[] = [];

  // Mark a pin as knocked; impart velocity based on impact direction
  const knock = (i: number, impactDX: number, impactDY: number, speed: number) => {
    if (!result[i]) return;
    result[i] = false;
    const [px, py] = PIN_XY[i];
    // Pin flies away from impact direction, slightly forward
    const len = Math.sqrt(impactDX * impactDX + impactDY * impactDY) || 1;
    flying.push({ x: px, y: py, vx: (impactDX / len) * speed, vy: (impactDY / len) * speed + 0.3, idx: i });
  };

  // Step ball through lane
  for (let step = 0; step < 120; step++) {
    bx += dx;
    by += dy;
    if (by > 4.5) break; // past all pins

    for (let i = 0; i < 10; i++) {
      if (!result[i]) continue;
      const [px, py] = PIN_XY[i];
      const ddx = bx - px, ddy = by - py;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d < HIT_D) {
        knock(i, ddx, ddy, 1.2 + rng() * 0.4);
      }
    }
  }

  // Simulate flying pins knocking over standing ones
  for (let iter = 0; iter < 4; iter++) {
    for (const fp of flying) {
      fp.x += fp.vx * 0.25;
      fp.y += fp.vy * 0.25;
      for (let i = 0; i < 10; i++) {
        if (!result[i] || i === fp.idx) continue;
        const [px, py] = PIN_XY[i];
        const ddx = fp.x - px, ddy = fp.y - py;
        const d = Math.sqrt(ddx * ddx + ddy * ddy);
        if (d < PIN_R * 2.8) {
          knock(i, ddx, ddy, 0.8 + rng() * 0.3);
        }
      }
    }
  }

  return result;
}

// --- Scoring ---
// A frame holds up to 3 rolls (in the 10th frame). Scoring is standard American.
type FrameRolls = number[]; // each entry: number of pins knocked in that ball

export function calcScore(frames: FrameRolls[]): number[] {
  const totals: number[] = [];
  let cumulative = 0;
  for (let f = 0; f < Math.min(frames.length, 10); f++) {
    const rolls = frames[f];
    if (rolls.length === 0) { totals.push(cumulative); continue; }
    const isStrike = rolls[0] === 10;
    const isSpare  = !isStrike && rolls.length >= 2 && rolls[0] + rolls[1] === 10;

    if (f < 9) {
      // Frames 1–9: standard scoring
      if (isStrike) {
        // 10 + next 2 balls from subsequent frames
        const bonus = lookAhead(frames, f + 1, 2);
        cumulative += 10 + bonus;
      } else if (isSpare) {
        const bonus = lookAhead(frames, f + 1, 1);
        cumulative += 10 + bonus;
      } else {
        cumulative += (rolls[0] ?? 0) + (rolls[1] ?? 0);
      }
    } else {
      // 10th frame: just sum all balls (no look-ahead)
      cumulative += rolls.reduce((s, x) => s + x, 0);
    }
    totals.push(cumulative);
  }
  return totals;
}

function lookAhead(frames: FrameRolls[], startFrame: number, n: number): number {
  let total = 0, count = 0;
  for (let f = startFrame; f < frames.length && count < n; f++) {
    for (const r of frames[f]) {
      total += r;
      count++;
      if (count >= n) break;
    }
  }
  return total;
}

// --- Room ---
const MAX_PLAYERS = 4;
const FRAMES = 10;
const START_GRACE_MS = 15_000; // wait up to 15s for more players after first ready
const COIN_PRIZES = [750, 300, 150, 0]; // 1st, 2nd, 3rd, 4th
const ROLL_TIMEOUT_MS = 45_000; // auto-gutter if player doesn't throw in time

export interface BowlPlayer {
  id: string;          // connection id
  pid: string;         // stable player id (for coin awards)
  name: string;
  color: string;
  frames: FrameRolls[]; // frames[0..9], each is an array of ball counts
  ws: WebSocket;
  ready: boolean;
  timedOut: boolean;
}

export type RoomPhase = 'lobby' | 'playing' | 'over';

export interface BowlRoom {
  id: string;
  phase: RoomPhase;
  players: BowlPlayer[];
  currentPlayerIdx: number; // whose turn it is
  pinState: boolean[];      // true = pin still standing (10 entries)
  startTimer: ReturnType<typeof setTimeout> | null;
  rollTimer: ReturnType<typeof setTimeout> | null;
}

export interface BowlingHooks {
  award(ws: WebSocket, pid: string, coins: number): void;
  announce(roomId: string, text: string): void;
}

export class BowlingManager {
  private rooms = new Map<string, BowlRoom>();
  private playerRoom = new Map<string, string>(); // conn id → room id
  private nextRoomId = 1;

  constructor(private hooks: BowlingHooks) {}

  /** A player enters the bowling alley. Returns their room id. */
  join(ws: WebSocket, connId: string, pid: string, name: string, color: string): void {
    // Already in a room?
    if (this.playerRoom.has(connId)) return;

    // Find a lobby-phase room with room
    let room = [...this.rooms.values()].find(
      (r) => r.phase === 'lobby' && r.players.length < MAX_PLAYERS
    );

    if (!room) {
      room = this.createRoom();
    }

    const player: BowlPlayer = { id: connId, pid, name, color, frames: [], ws, ready: false, timedOut: false };
    room.players.push(player);
    this.playerRoom.set(connId, room.id);
    this.broadcast(room, this.stateMsg(room));
  }

  /** Player marks themselves ready. */
  ready(connId: string): void {
    const room = this.getRoom(connId);
    if (!room || room.phase !== 'lobby') return;
    const p = room.players.find((x) => x.id === connId);
    if (!p) return;
    p.ready = true;

    this.broadcast(room, this.stateMsg(room));

    // All ready → start immediately; first ready → start grace timer
    const allReady = room.players.length >= 2 && room.players.every((x) => x.ready);
    if (allReady) {
      if (room.startTimer) { clearTimeout(room.startTimer); room.startTimer = null; }
      this.startGame(room);
      return;
    }
    const anyReady = room.players.some((x) => x.ready);
    if (anyReady && !room.startTimer && room.players.length >= 2) {
      room.startTimer = setTimeout(() => { this.startGame(room!); }, START_GRACE_MS);
    }
    // Solo start (1 player ready, nobody else joined after grace)
    if (room.players.length === 1 && !room.startTimer) {
      room.startTimer = setTimeout(() => { this.startGame(room!); }, START_GRACE_MS);
    }
  }

  /** Player makes a throw: offset (−1..1) and power (0..1). */
  throw(connId: string, offset: number, power: number): void {
    const room = this.getRoom(connId);
    if (!room || room.phase !== 'playing') return;
    const current = room.players[room.currentPlayerIdx];
    if (!current || current.id !== connId) return; // not your turn

    if (room.rollTimer) { clearTimeout(room.rollTimer); room.rollTimer = null; }

    // Validate inputs
    const off = Math.max(-1, Math.min(1, offset));
    const pow = Math.max(0, Math.min(1, power));

    // Use a deterministic-ish RNG seeded by this throw's specifics
    let seed = (off * 1000 + pow * 100 + Date.now()) | 0;
    const rng = () => {
      seed = (seed ^ (seed << 13)) >>> 0;
      seed = (seed ^ (seed >> 17)) >>> 0;
      seed = (seed ^ (seed << 5))  >>> 0;
      return seed / 0xffffffff;
    };

    const newPinState = simulateThrow(room.pinState, off, pow, rng);
    const pinsDown: number[] = [];
    for (let i = 0; i < 10; i++) {
      if (room.pinState[i] && !newPinState[i]) pinsDown.push(i);
    }
    room.pinState = newPinState;

    // Record this ball in the player's frame
    this.recordBall(room, current, pinsDown.length);

    // Tell everyone the result (include offset so clients can animate the roll)
    this.broadcast(room, {
      type: 'bowlThrowResult',
      roomId: room.id,
      playerId: connId,
      offset: off,
      power: pow,
      pinState: room.pinState,
      pinsDown,
      scores: this.allScores(room),
      frames: this.allFrames(room),
    });

    // Advance game
    setTimeout(() => this.advance(room!), 1500); // let animation play
  }

  /** Player leaves. Clean up their slot and notify the room. */
  leave(connId: string): void {
    const room = this.getRoom(connId);
    if (!room) return;
    this.playerRoom.delete(connId);
    room.players = room.players.filter((p) => p.id !== connId);

    if (room.players.length === 0) {
      if (room.startTimer) clearTimeout(room.startTimer);
      if (room.rollTimer) clearTimeout(room.rollTimer);
      this.rooms.delete(room.id);
    } else {
      // If current player left, skip their turn
      if (room.phase === 'playing') {
        if (room.currentPlayerIdx >= room.players.length) {
          room.currentPlayerIdx = 0;
        }
        this.broadcast(room, this.stateMsg(room));
        this.startRollTimer(room);
      } else {
        this.broadcast(room, this.stateMsg(room));
      }
    }
  }

  /** Return current room state for a reconnecting player (or null if not in one). */
  getState(connId: string): object | null {
    const room = this.getRoom(connId);
    return room ? this.stateMsg(room) : null;
  }

  // --- internals ---

  private createRoom(): BowlRoom {
    const id = `bowl-${this.nextRoomId++}`;
    const room: BowlRoom = {
      id, phase: 'lobby', players: [], currentPlayerIdx: 0,
      pinState: new Array(10).fill(true),
      startTimer: null, rollTimer: null,
    };
    this.rooms.set(id, room);
    return room;
  }

  private getRoom(connId: string): BowlRoom | undefined {
    const rid = this.playerRoom.get(connId);
    return rid ? this.rooms.get(rid) : undefined;
  }

  private startGame(room: BowlRoom): void {
    if (room.phase !== 'lobby' || room.players.length < 1) return;
    if (room.startTimer) { clearTimeout(room.startTimer); room.startTimer = null; }
    room.phase = 'playing';
    room.currentPlayerIdx = 0;
    room.pinState = new Array(10).fill(true);
    // Only give the first player their opening frame. Everyone else gets one
    // pushed in advance() the moment the turn rotates to them, so no player
    // ever starts with a ghost empty frame at index 0.
    for (const p of room.players) { p.frames = []; }
    room.players[0].frames = [[]];
    this.broadcast(room, { type: 'bowlStart', roomId: room.id, ...this.stateMsg(room) });
    this.startRollTimer(room);
  }

  private recordBall(_room: BowlRoom, player: BowlPlayer, knocked: number): void {
    const lastFrame = player.frames[player.frames.length - 1];
    lastFrame.push(knocked);
  }

  private advance(room: BowlRoom): void {
    if (room.phase !== 'playing') return;
    const current = room.players[room.currentPlayerIdx];
    if (!current) { this.endGame(room); return; }

    const frameIdx = current.frames.length - 1; // current frame index (0-based)
    const lastFrame = current.frames[frameIdx];
    const ballsThrown = lastFrame.length;
    const pinsFelled = lastFrame.reduce((s, x) => s + x, 0);
    const isStrike = ballsThrown === 1 && lastFrame[0] === 10;
    void pinsFelled; // used in strike/spare detection via pin state

    // Determine if this player needs another ball in this frame
    let nextBallInFrame = false;
    if (frameIdx < 9) {
      // Frames 1–9: strike = done (1 ball), spare = 2 balls, open = 2 balls
      nextBallInFrame = !isStrike && ballsThrown < 2;
    } else {
      // 10th frame: 3 balls if strike or spare; otherwise 2 balls
      const after2 = ballsThrown === 2;
      const eligibleFor3 = (lastFrame[0] === 10) || (lastFrame[0] + (lastFrame[1] ?? 0) === 10);
      nextBallInFrame = ballsThrown < 2 || (after2 && eligibleFor3 && ballsThrown < 3);
    }

    if (nextBallInFrame) {
      // Reset pins for second ball (if not in 10th frame after strike/bonus)
      if (!isStrike || frameIdx === 9) {
        // Keep remaining pins (don't reset between balls 1 and 2 in normal frames)
      }
      // In 10th frame, after a strike, reset all 10 pins for ball 2
      if (frameIdx === 9 && isStrike && ballsThrown === 1) {
        room.pinState = new Array(10).fill(true);
      }
      // In 10th frame, after strike+strike, reset again for ball 3
      if (frameIdx === 9 && ballsThrown === 2 && lastFrame[0] === 10 && lastFrame[1] === 10) {
        room.pinState = new Array(10).fill(true);
      }
      // In 10th frame, after spare, reset all 10 for ball 3
      if (frameIdx === 9 && ballsThrown === 2 && lastFrame[0] !== 10 && lastFrame[0] + lastFrame[1] === 10) {
        room.pinState = new Array(10).fill(true);
      }
      this.broadcast(room, { type: 'bowlNextBall', roomId: room.id,
        playerId: current.id, ball: ballsThrown + 1, pinState: room.pinState,
        scores: this.allScores(room), frames: this.allFrames(room) });
      this.startRollTimer(room);
      return;
    }

    // This player's frame is done. Move to next player.
    const nextPlayerIdx = (room.currentPlayerIdx + 1) % room.players.length;
    const completedFrames = current.frames.length;
    const nextPlayer = room.players[nextPlayerIdx];
    if (!nextPlayer) { this.endGame(room); return; }

    if (nextPlayerIdx <= room.currentPlayerIdx) {
      // Wrapped around — new frame for everyone
      // Check if game is over (all players finished 10 frames)
      if (completedFrames >= FRAMES && current.frames[FRAMES - 1].length > 0) {
        // Check if all players have FRAMES frames
        const allDone = room.players.every((p) => {
          if (p.frames.length < FRAMES) return false;
          const f = p.frames[FRAMES - 1];
          return f.length >= 2 || (f[0] === 10 && f.length >= 3) ||
                 (f[0] + (f[1] ?? 0) >= 10 && f.length >= 3);
        });
        if (allDone) { this.endGame(room); return; }
      }
    }

    // Start next player's frame
    room.currentPlayerIdx = nextPlayerIdx;
    room.pinState = new Array(10).fill(true);

    // Push a new empty frame for the next player
    if (nextPlayer.frames.length < FRAMES) {
      nextPlayer.frames.push([]);
    }

    this.broadcast(room, {
      type: 'bowlNextTurn',
      roomId: room.id,
      playerId: nextPlayer.id,
      frameIdx: nextPlayer.frames.length - 1,
      scores: this.allScores(room),
      frames: this.allFrames(room),
      pinState: room.pinState,
    });
    this.startRollTimer(room);
  }

  private endGame(room: BowlRoom): void {
    room.phase = 'over';
    if (room.rollTimer) { clearTimeout(room.rollTimer); room.rollTimer = null; }

    // Compute final scores and rank
    const ranked = room.players.map((p) => ({
      id: p.id, pid: p.pid, name: p.name, color: p.color,
      score: calcScore(p.frames).pop() ?? 0,
    })).sort((a, b) => b.score - a.score);

    // Award coins
    for (let rank = 0; rank < ranked.length; rank++) {
      const prize = COIN_PRIZES[rank] ?? 0;
      if (prize > 0) {
        const p = room.players.find((x) => x.id === ranked[rank].id);
        if (p) this.hooks.award(p.ws, p.pid, prize);
      }
    }

    this.broadcast(room, {
      type: 'bowlGameOver',
      roomId: room.id,
      ranked,
      scores: this.allScores(room),
      frames: this.allFrames(room),
    });

    // Clean up room after delay
    setTimeout(() => {
      if (this.rooms.has(room.id)) {
        for (const p of room.players) this.playerRoom.delete(p.id);
        this.rooms.delete(room.id);
      }
    }, 30_000);
  }

  private startRollTimer(room: BowlRoom): void {
    if (room.rollTimer) clearTimeout(room.rollTimer);
    room.rollTimer = setTimeout(() => {
      // Auto-gutter for the current player
      const current = room.players[room.currentPlayerIdx];
      if (current && room.phase === 'playing') {
        current.timedOut = true;
        // Fake a gutter ball
        this.throw(current.id, 1.2, 0.5);
      }
    }, ROLL_TIMEOUT_MS);
  }

  private allScores(room: BowlRoom): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const p of room.players) {
      out[p.id] = calcScore(p.frames);
    }
    return out;
  }

  private allFrames(room: BowlRoom): Record<string, FrameRolls[]> {
    const out: Record<string, FrameRolls[]> = {};
    for (const p of room.players) { out[p.id] = p.frames; }
    return out;
  }

  private stateMsg(room: BowlRoom): object {
    return {
      type: 'bowlState',
      roomId: room.id,
      phase: room.phase,
      players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color, ready: p.ready })),
      currentPlayerId: room.phase === 'playing' ? room.players[room.currentPlayerIdx]?.id : null,
      pinState: room.pinState,
      scores: this.allScores(room),
      frames: this.allFrames(room),
    };
  }

  private broadcast(room: BowlRoom, msg: object): void {
    const text = JSON.stringify(msg);
    for (const p of room.players) {
      try { p.ws.send(text); } catch {}
    }
  }

  /** Called from the Lobby every 60 Hz tick. Currently nothing time-sensitive. */
  tick(_dtSec: number): void {
    // No per-tick work needed; all timing is via setTimeout
  }
}
