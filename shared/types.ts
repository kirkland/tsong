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

export const WIN_SCORE = 3;
export const LEADERBOARD_MIN_GAMES = 3; // games needed before win% is ranked
export const LEADERBOARD_SIZE = 10;
export const CHAT_MAX_LEN = 200; // max characters per chat message
export const CHAT_HISTORY = 50; // recent messages kept/sent to new joiners
export const TICK_MS = 1000 / 60;
export const MAX_BOUNCE = Math.PI / 3; // steepest deflection off a paddle edge
export const SERVE_DELAY = 0.7; // seconds the ball pauses at center before launching

export type Side = 'left' | 'right';
export type Role = Side | 'observer';
export type Status = 'waiting' | 'playing' | 'over';

// Finishing moves the winner can perform during the 'over' window (opt-in, see the
// "Fatalities" toggle on the client). Start with one; the name is the wire value.
// SCREEN_MELT: the ball flares into a fireball and the losing paddle melts down the
// court like liquid wax.
export const FATALITY_MOVES = ['SCREEN_MELT'] as const;
export type FatalityMove = (typeof FATALITY_MOVES)[number];

// --- Client -> Server ---
export type ClientMsg =
  // pid = stable per-browser identity; color = chosen paddle color
  | { type: 'join'; nickname: string; pid: string; color?: string }
  | { type: 'claim' }
  | { type: 'paddle'; y: number } // desired paddle center Y, in court units
  | { type: 'chat'; text: string }
  | { type: 'reaction'; emoji: string } // a floating emoji reaction, shown to everyone
  | { type: 'fatality'; move: string } // winner-only, validated server-side
  | { type: 'setFatalities'; enabled: boolean }; // flips the shared fatalities setting

// --- Server -> Client ---
export interface PaddleState {
  y: number; // paddle center Y in court units
  name: string | null; // nickname of the player on this side, or null if open
  color: string; // hex color for rendering
}

export interface StateMsg {
  type: 'state';
  ball: { x: number; y: number; color: string }; // color = paddle that last hit it (neutral until first hit)
  ballSpeed: number; // current ball speed, court units / second
  paddles: { left: PaddleState; right: PaddleState };
  score: { left: number; right: number };
  status: Status;
  winner: string | null; // nickname of the winner when status === 'over'
  // Shared, room-wide toggle: when true, the match winner can perform a finishing move.
  // It's one setting for everyone (not per-user), so it rides along in the state.
  fatalitiesEnabled: boolean;
  // Set once the winner lands a finishing move; drives the on-court animation for
  // every client. `side` is the winning side; null until/unless a fatality happens.
  fatality: { side: Side; move: string } | null;
  watchers: string[]; // nicknames of joined observers
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

// Emojis the server will accept; anything else is dropped (keeps the air clean).
export const REACTIONS = ['👍', '❤️', '😂', '🎉', '🔥', '😮', '👏', '🏓', '😡', '🫵', '🖕'] as const;

// Special non-emoji reaction: a pong ball rendered in the live ball color. The
// color isn't sent — each client paints it with whatever its own ball shows.
export const BALL_REACTION = 'ball';

export type ServerMsg = YouMsg | StateMsg | LeaderboardMsg | ChatMsg | ReactionMsg;
