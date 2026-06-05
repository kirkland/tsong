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
  speedup: 1.05, // multiplier applied on each paddle hit (no upper cap)
} as const;

// "Closing walls" mode: each paddle hit drags both paddles a step toward center.
export const CLOSING = {
  step: 12, // court units each paddle slides inward per paddle hit
  minGap: 200, // closest the two paddle faces may get (court units between faces)
} as const;

export const WIN_SCORE = 3;
export const PADDLE_BOOST = 1.5; // paddle height multiplier while "grow" is active
export const PADDLE_SHRINK = 0.6; // opponent paddle height multiplier while "shrink" is active
export const SMASH_BONUS = 1.35; // extra ball-speed multiplier applied on each "smash" hit
export const SLOW_SCALE = 0.6; // ball-speed multiplier during "slow" motion
export const SLOW_TIME = 4; // seconds a "slow" power-up lasts
export const MULTI_MAX = 2; // max simultaneous extra balls from "multi"
export const POWERUP_HITS = 3; // hits a per-hit power-up (grow/shrink/smash) lasts
export const FREEZE_TIME = 2; // seconds the opponent paddle is locked
export const BLIND_TIME = 3; // seconds the opponent's view is obscured
export const MIRROR_TIME = 3; // seconds the opponent's controls are inverted
export const GHOST_TIME = 3; // seconds the ball is invisible
export const TINY_TIME = 5; // seconds the ball is rendered tiny
export const CURVE_SPIN = 1.4; // spin (rad/s) applied to the ball on a curve hit
export const GRAVITY_ACCEL = 220; // court units/sec² downward pull in gravity mode
export const TURBO_SPEED_MULT = 1.5; // serve speed multiplier in turbo mode
export const TURBO_SPEEDUP = 1.1; // per-hit speedup in turbo mode (vs BALL.speedup = 1.05)
export const TARGET = {
  r: 24, // target radius, court units
  minDelay: 6, // min seconds before a target (re)appears
  maxDelay: 14, // max seconds before a target (re)appears
  life: 7, // seconds an unclaimed target lingers before vanishing
} as const;

// The power-up a target grants when the ball is bounced across it:
//   grow   — your paddle grows for your next 3 hits
//   shrink — the opponent's paddle shrinks for their next 3 hits
//   smash  — your next 3 hits launch the ball faster
//   slow   — the ball slows down for a few seconds
//   multi  — two extra balls join the rally until the next point
//   freeze — opponent's paddle locks in place for 2 s
//   curve  — your next hit puts spin on the ball, making it arc
//   blind  — opponent's view of their side goes dark for 3 s
//   mirror — opponent's up/down controls are inverted for 3 s
//   shield — absorbs the next goal scored against you
//   ghost  — ball turns invisible for 3 s
//   tiny   — ball shrinks to near-invisible size for 5 s
//   warp   — ball teleports to a random mid-court position
export const POWERUPS = [
  'grow', 'shrink', 'smash', 'slow', 'multi',
  'freeze', 'curve', 'blind', 'mirror', 'shield', 'ghost', 'tiny', 'warp',
] as const;
export type PowerupKind = (typeof POWERUPS)[number];
export const LEADERBOARD_MIN_GAMES = 3; // games needed before win% is ranked
export const LEADERBOARD_SIZE = 10;
export const CHAT_MAX_LEN = 200; // max characters per chat message
export const CHAT_HISTORY = 50; // recent messages kept/sent to new joiners
export const TICK_MS = 1000 / 60;
export const MAX_BOUNCE = Math.PI / 3; // steepest deflection off a paddle edge
export const SERVE_DELAY = 0.7; // seconds the ball pauses at center before launching
export const READY_TIMEOUT = 15; // seconds to wait for both players to ready up before clearing spots

export type Side = 'left' | 'right';
export type Role = Side | 'observer';
export type Status = 'waiting' | 'playing' | 'over';

// Finishing moves the winner can perform during the 'over' window (opt-in, see the
// "Fatalities" toggle on the client). The name is the wire value.
// SCREEN_MELT: the ball flares into a fireball and the losing paddle melts down the
// court like liquid wax.
// PADDLE_SPLIT: the losing paddle is dragged to center, split in half, and explodes.
// FROST_SHATTER: the losing paddle freezes, cracks, and shatters into ice shards.
// NOT_FOUND: the losing paddle glitches into a magenta/black missing-texture
// checkerboard, flickers under a "404 PADDLE NOT FOUND" tag, and blinks out.
export const FATALITY_MOVES = ['SCREEN_MELT', 'PADDLE_SPLIT', 'FROST_SHATTER', 'NOT_FOUND'] as const;
export type FatalityMove = (typeof FATALITY_MOVES)[number];

// --- Client -> Server ---
export type ClientMsg =
  // pid = stable per-browser identity; color = chosen paddle color
  | { type: 'join'; nickname: string; pid: string; color?: string }
  | { type: 'claim' }
  | { type: 'paddle'; y: number } // desired paddle center Y, in court units
  | { type: 'chat'; text: string }
  | { type: 'reaction'; emoji: string } // a floating emoji reaction, shown to everyone
  | { type: 'mode'; closing?: boolean; gravity?: boolean; turbo?: boolean } // toggle game modes
  | { type: 'fatality'; move: string } // winner-only, validated server-side
  | { type: 'setFatalities'; enabled: boolean } // flips the shared fatalities setting
  | { type: 'forfeit' } // "/ff": leave your paddle spot mid-game (and get shamed)
  | { type: 'spawnPowerup' } // "/powerup": spectators only — drop a random power-up target
  | { type: 'capture'; on: boolean } // whether this player's mouse is captured to the board
  | { type: 'kingExit' } // winner declines to stay as king of the court
  | { type: 'queueJoin' } // join the spectator queue
  | { type: 'queueLeave' } // leave the spectator queue
  | { type: 'ready' }; // ready up for the next match

// --- Server -> Client ---
export interface PaddleState {
  x: number; // paddle center X in court units (moves inward in "closing walls" mode)
  y: number; // paddle center Y in court units
  name: string | null; // nickname of the player on this side, or null if open
  color: string; // hex color for rendering
  h: number; // current paddle height in court units (taller while powered up)
  frozen: boolean; // paddle is temporarily immobile (freeze power-up)
  mirrored: boolean; // up/down controls are inverted (mirror power-up)
  shielded: boolean; // next goal against this side is absorbed (shield power-up)
  blinded: boolean; // opponent's half of the court is obscured (blind power-up)
  curveReady: boolean; // next hit will put spin on the ball (curve power-up)
}

export interface StateMsg {
  type: 'state';
  ball: { x: number; y: number; color: string }; // color = paddle that last hit it (neutral until first hit)
  // Extra balls in play during a "multi" power-up; empty the rest of the time.
  extraBalls: { x: number; y: number; color: string }[];
  ballSpeed: number; // current ball speed, court units / second
  paddles: { left: PaddleState; right: PaddleState };
  // Active power-up target, or null when none is on the board. `kind` picks its icon/effect.
  target: { x: number; y: number; kind: PowerupKind } | null;
  score: { left: number; right: number };
  status: Status;
  // True while an in-progress match is frozen waiting for both players to capture
  // their mouse (pointer lock). The client overlays a "capture to play" prompt.
  paused: boolean;
  closing: boolean; // whether "closing walls" mode is armed
  gravity: boolean; // whether gravity mode is active
  turbo: boolean; // whether turbo mode is active
  winner: string | null; // nickname of the winner when status === 'over'
  // Shared, room-wide toggle: when true, the match winner can perform a finishing move.
  // It's one setting for everyone (not per-user), so it rides along in the state.
  fatalitiesEnabled: boolean;
  // Set once the winner lands a finishing move; drives the on-court animation for
  // every client. `side` is the winning side; null until/unless a fatality happens.
  fatality: { side: Side; move: string } | null;
  watchers: string[]; // nicknames of joined observers
  king: string | null; // nickname of the king (winner who stayed), null if none
  kingWins: number; // the king's current win streak (consecutive match wins)
  queue: string[]; // ordered nicknames of spectators waiting to play
  ready: { left: boolean; right: boolean }; // ready-up status when match is over
  ghostBall: boolean; // ball is currently invisible (ghost power-up)
  tinyBall: boolean; // ball is currently rendered tiny (tiny power-up)
}

// Sent to a single connection whenever its own role changes (connect / claim / release).
export interface YouMsg {
  type: 'you';
  id: string;
  role: Role;
}

export interface LeaderboardRow {
  name: string;
  wins: number;
  losses: number;
}

// Broadcast on connect and whenever the standings change (after a match).
export interface LeaderboardMsg {
  type: 'leaderboard';
  rows: LeaderboardRow[];
}

export interface ChatLine {
  from: string;
  text: string;
  player: boolean; // true if the sender held a paddle when they sent it
  color: string; // hex color of the sender's name
}

// One line for a live message; the full recent history on connect. Client appends.
export interface ChatMsg {
  type: 'chat';
  lines: ChatLine[];
}

// A one-off emoji reaction, fanned out live to every client (not replayed on join).
export interface ReactionMsg {
  type: 'reaction';
  emoji: string;
}

// A one-off big center-screen banner (e.g. a forfeit). Transient; not replayed.
export interface AnnounceMsg {
  type: 'announce';
  text: string;
}

// The default quick-reaction row, in display order.
export const REACTIONS = ['🔥', '🎉', '🫵', '👍', '😂', '😮', '👏', '😡', '🖕'] as const;

// Special non-emoji reaction: a pong ball rendered in the live ball color. The
// color isn't sent — each client paints it with whatever its own ball shows.
export const BALL_REACTION = 'ball';

export type ServerMsg =
  | YouMsg
  | StateMsg
  | LeaderboardMsg
  | ChatMsg
  | ReactionMsg
  | AnnounceMsg;
