// Shared contracts and constants used by both the server and the browser client.
// Court coordinates are in abstract "court units" (not pixels); the client scales
// its canvas to this logical size, so both ends agree on geometry.

export const COURT = { w: 800, h: 500 } as const;

export const PADDLE = {
  w: 14, // paddle thickness
  h: 90, // paddle length
  margin: 24, // distance of paddle center from its wall
  speed: 900, // max paddle travel, court units / second
} as const;

export const BALL = {
  r: 9,
  speed: 480, // serve speed, court units / second
  speedup: 1.05, // multiplier applied on each paddle hit
  maxSpeed: 760,
} as const;

export const WIN_SCORE = 3;
export const TICK_MS = 1000 / 60;
export const MAX_BOUNCE = Math.PI / 3; // steepest deflection off a paddle edge
export const SERVE_DELAY = 0.7; // seconds the ball pauses at center before launching

export type Side = 'left' | 'right';
export type Role = Side | 'observer';
export type Status = 'waiting' | 'playing' | 'over';

// --- Client -> Server ---
export type ClientMsg =
  | { type: 'join'; nickname: string }
  | { type: 'claim' }
  | { type: 'paddle'; y: number }; // desired paddle center Y, in court units

// --- Server -> Client ---
export interface PaddleState {
  y: number; // paddle center Y in court units
  name: string | null; // nickname of the player on this side, or null if open
}

export interface StateMsg {
  type: 'state';
  ball: { x: number; y: number };
  paddles: { left: PaddleState; right: PaddleState };
  score: { left: number; right: number };
  status: Status;
  winner: string | null; // nickname of the winner when status === 'over'
  watchers: string[]; // nicknames of joined observers
}

// Sent to a single connection whenever its own role changes (connect / claim / release).
export interface YouMsg {
  type: 'you';
  id: string;
  role: Role;
}

export type ServerMsg = YouMsg | StateMsg;
