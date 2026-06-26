// Authoritative game simulation. Knows nothing about networking, nicknames, or the
// DOM — it just owns the ball(s), paddle positions, score, status and power-ups. The
// Lobby drives it (start/setTarget) and reads its state to broadcast.

import {
  COURT,
  PADDLE,
  BALL,
  CLOSING,
  WIN_SCORE,
  MAX_BOUNCE,
  SERVE_DELAY,
  PADDLE_BOOST,
  PADDLE_SHRINK,
  SMASH_BONUS,
  SLOW_SCALE,
  SLOW_TIME,
  MULTI_MAX,
  POWERUP_HITS,
  FREEZE_TIME,
  BLIND_TIME,
  MIRROR_TIME,
  GHOST_TIME,
  TINY_TIME,
  BIG_BALL_TIME,
  BIG_BALL_R,
  BLASTER,
  CURVE_SPIN,
  ROAM,
  GRAVITY_ACCEL,
  TURBO_SPEED_MULT,
  TURBO_SPEEDUP,
  LAYERED,
  DIAMOND,
  PINATA,
  BLOCK,
  POWERUPS,
  TARGET,
  BREAKOUT,
  BUMPER,
  BUMPER_POSITIONS,
  PowerupKind,
  Side,
  Status,
} from '../shared/types';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const other = (s: Side): Side => (s === 'left' ? 'right' : 'left');

// Default paddle center X for each side (closing mode slides these toward center).
const HOME_X: Record<Side, number> = {
  left: PADDLE.margin,
  right: COURT.w - PADDLE.margin,
};
// Furthest each paddle center may travel inward before the faces hit the min gap.
const MAX_INSET = (COURT.w - CLOSING.minGap) / 2 - PADDLE.margin - PADDLE.w / 2;

interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number; // rad/s; positive = counter-clockwise; decays each tick
}

// The piñata collector: a drifting beach ball, its visual rotation, and the balls
// currently clinging to its surface (each kept as a surface angle + the speed it carried,
// so a burst can fling it back out with its own momentum).
interface PinataObj {
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number; // accumulated rotation, radians (visual; also rotates stuck balls)
  stuck: { angle: number; speed: number }[];
}

// One player's paddle. A side may field several (team mode); they share the side's
// X, height and power-up state, but each eases toward its own target Y.
export interface PaddleEnt {
  id: string; // lobby connection id that drives this paddle
  y: number;
  targetY: number;
}

// Everything needed to resume the simulation after a restart. Mirrors the Game's own
// fields (including the private serve/target timers) so a saved match continues exactly
// where it left off. `paused` is deliberately omitted — a resumed match always starts
// frozen until the reconnected players re-capture their mice.
export interface GameSnapshot {
  ball: Ball;
  extraBalls: Ball[];
  // Per-player paddles are NOT stored here — their sockets don't survive a restart.
  // The lobby snapshot keeps each seat's paddle Y and re-adds paddles on reattach.
  paddleX: Record<Side, number>;
  score: { left: number; right: number };
  status: Status;
  closing: boolean;
  layered: boolean;
  diamond: boolean;
  diamondBlock: { x: number; y: number; vx: number; vy: number } | null;
  pinata: boolean;
  pinataObj: PinataObj | null;
  blocks?: { x: number; y: number; w: number; h: number }[];
  rotated: number;
  fritz?: boolean;
  disco?: boolean;
  minion?: boolean;
  earthquake?: boolean;
  blackout?: boolean; vortex?: boolean; glitch?: boolean; smoke?: boolean; tilt?: boolean;
  breakout?: boolean;
  brickAlive?: boolean[];
  fog?: boolean;
  portal?: boolean;
  bumpers?: boolean;
  bumperFlash?: boolean[];
  winnerSide: Side | null;
  lastHit: Side | null;
  target: { x: number; y: number; kind: PowerupKind } | null;
  growHits: Record<Side, number>;
  shrinkHits: Record<Side, number>;
  smashHits: Record<Side, number>;
  curveHits: Record<Side, number>;
  roamHits?: Record<Side, number>;
  roamX?: Record<Side, number>;
  roamTargetX?: Record<Side, number>;
  slowTimer: number;
  freezeTimer: Record<Side, number>;
  blindTimer: Record<Side, number>;
  mirrorTimer: Record<Side, number>;
  ghostTimer: number;
  tinyTimer: number;
  bigBallTimer: number;
  shielded: Record<Side, boolean>;
  pinataPendingSpawns: number;
  pinataBurstPending: boolean;
  serveTimer: number;
  serveDir: number;
  targetTimer: number;
  winScore?: number;
}

// Shortest distance from point p to the segment a→b (for swept target hit-testing,
// so a fast ball can't tunnel straight through the target between two ticks).
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export class Game {
  ball: Ball = { x: COURT.w / 2, y: COURT.h / 2, vx: 0, vy: 0, spin: 0 };
  extraBalls: Ball[] = []; // additional balls during a "multi" power-up
  players: Record<Side, PaddleEnt[]> = { left: [], right: [] }; // one paddle per seated player
  paddleX: Record<Side, number> = { ...HOME_X }; // current paddle center X (slides in closing mode)
  score = { left: 0, right: 0 };
  status: Status = 'waiting';
  closing = false; // "closing walls" mode armed; applies from the next match start
  gravity = false; // constant downward pull bends ball trajectory
  turbo = false; // faster serve speed and steeper per-hit speedup
  layered = false; // "layered teams" mode: teammates stagger forward by join order
  diamond = false; // "diamond hands" mode armed; spawns a drifting diamond obstacle
  // The live diamond obstacle while diamond-hands mode is on during a match (else null).
  diamondBlock: { x: number; y: number; vx: number; vy: number } | null = null;
  pinata = false; // "piñata" mode armed; spawns a drifting ball-collector
  pinataObj: PinataObj | null = null; // the live piñata during a match (else null)
  // Spectator-dropped obstacles. Like breakout bricks: the ball caroms off them and the
  // block shatters on contact. Center + size, court units. They accumulate as spectators
  // drop them (capped), get knocked out by rallies, and clear at the next match start.
  blocks: { x: number; y: number; w: number; h: number }[] = [];
  breakout = false; // "breakout" mode: destructible bricks across the centre of the court
  brickAlive: boolean[] = []; // which of the 28 bricks are still standing this point
  fog = false;    // "fog of war": server passes flag; visibility computed client-side
  portal = false; // "portal walls": top/bottom walls teleport instead of bounce
  bumpers = false; // "bumpers" mode: five static pinball pegs in the center
  bumperFlash: boolean[] = BUMPER_POSITIONS.map(() => false); // one-frame hit signal per peg
  pinataBurstFlash = false; // set for the single tick a burst happens (drives a client pulse)
  private pinataPendingSpawns = 0; // replacement balls owed this tick (one per ball stuck)
  private pinataBurstPending = false; // a 5th ball stuck this tick → release everything
  winnerSide: Side | null = null;
  lastHit: Side | null = null; // side whose paddle last touched any ball (null until first hit)
  hitSeq = 0; // incremented on every paddle bounce so clients can detect same-side repeat hits
  paused = false; // set by the lobby: freeze play until both players capture their mouse
  winScore = WIN_SCORE; // first-to-N; configurable per-room (default: shared constant)

  // Power-ups. A target floats on the board; bouncing the ball over it grants its kind.
  target: { x: number; y: number; kind: PowerupKind } | null = null;
  growHits: Record<Side, number> = { left: 0, right: 0 };
  shrinkHits: Record<Side, number> = { left: 0, right: 0 };
  smashHits: Record<Side, number> = { left: 0, right: 0 };
  curveHits: Record<Side, number> = { left: 0, right: 0 };
  // "Roam": hits left on the freed-paddle power-up, plus the current and desired inward
  // inset (court units) the paddle has pushed off its wall toward center.
  roamHits: Record<Side, number> = { left: 0, right: 0 };
  roamX: Record<Side, number> = { left: 0, right: 0 };
  roamTargetX: Record<Side, number> = { left: 0, right: 0 };
  slowTimer = 0;
  freezeTimer: Record<Side, number> = { left: 0, right: 0 };
  blindTimer: Record<Side, number> = { left: 0, right: 0 };
  mirrorTimer: Record<Side, number> = { left: 0, right: 0 };
  ghostTimer = 0;
  tinyTimer = 0;
  bigBallTimer = 0;
  shielded: Record<Side, boolean> = { left: false, right: false };
  rotated = 0; // "rotate" power-up: quarter-turns CW this point (0–3); resets each serve
  fritz = false; // "fritz" power-up: replaces background with fritz's photo for the point
  disco = false; // "disco" power-up: 3D disco ball, dance floor, colored lights for the point
  minion = false; // "minion" power-up: both paddles are drawn as a minion for the point
  earthquake = false; // "earthquake" power-up: court shakes and the ball jitters for the point
  blackout = false; vortex = false; glitch = false; smoke = false; tilt = false; // screen-effect power-ups (per point)
  coinGrant: Side | null = null; // transient: side that just collected the "coins" power-up (lobby pays out)
  // "Blaster": shots each side holds, projectiles in flight, and how long each paddle is locked.
  blasterAmmo: Record<Side, number> = { left: 0, right: 0 };
  disabledTimer: Record<Side, number> = { left: 0, right: 0 };
  projectiles: { side: Side; x: number; y: number; vx: number; vy: number; life: number }[] = [];
  private excludedPowerups: Set<PowerupKind> = new Set(['disco']); // disco off in 2D by default

  /** Called by Lobby whenever the shared viewMode changes. */
  setExcludedPowerups(excluded: PowerupKind[]) {
    this.excludedPowerups = new Set(excluded);
  }

  private serveTimer = 0;
  private serveDir = 1; // +1 = launch toward right, -1 = toward left
  private targetTimer = 0; // counts down to spawn (no target) or to despawn (target up)

  /** Capture the full simulation state for persistence across a restart. */
  serialize(): GameSnapshot {
    return {
      ball: { ...this.ball },
      extraBalls: this.extraBalls.map((b) => ({ ...b })),
      paddleX: { ...this.paddleX },
      score: { ...this.score },
      status: this.status,
      closing: this.closing,
      layered: this.layered,
      diamond: this.diamond,
      diamondBlock: this.diamondBlock ? { ...this.diamondBlock } : null,
      pinata: this.pinata,
      pinataObj: this.pinataObj
        ? { ...this.pinataObj, stuck: this.pinataObj.stuck.map((s) => ({ ...s })) }
        : null,
      blocks: this.blocks.map((bl) => ({ ...bl })),
      rotated: this.rotated,
      fritz: this.fritz,
      disco: this.disco,
      minion: this.minion,
      earthquake: this.earthquake,
      blackout: this.blackout, vortex: this.vortex,
      glitch: this.glitch, smoke: this.smoke, tilt: this.tilt,
      winnerSide: this.winnerSide,
      lastHit: this.lastHit,
      target: this.target ? { ...this.target } : null,
      growHits: { ...this.growHits },
      shrinkHits: { ...this.shrinkHits },
      smashHits: { ...this.smashHits },
      curveHits: { ...this.curveHits },
      roamHits: { ...this.roamHits },
      roamX: { ...this.roamX },
      roamTargetX: { ...this.roamTargetX },
      slowTimer: this.slowTimer,
      freezeTimer: { ...this.freezeTimer },
      blindTimer: { ...this.blindTimer },
      mirrorTimer: { ...this.mirrorTimer },
      ghostTimer: this.ghostTimer,
      tinyTimer: this.tinyTimer,
      bigBallTimer: this.bigBallTimer,
      shielded: { ...this.shielded },
      pinataPendingSpawns: this.pinataPendingSpawns,
      pinataBurstPending: this.pinataBurstPending,
      serveTimer: this.serveTimer,
      serveDir: this.serveDir,
      targetTimer: this.targetTimer,
      winScore: this.winScore,
      breakout: this.breakout,
      brickAlive: [...this.brickAlive],
      fog: this.fog,
      portal: this.portal,
      bumpers: this.bumpers,
    };
  }

  /** Restore a previously serialized state (after a restart). Resumes frozen. */
  restore(s: GameSnapshot) {
    this.ball = { ...s.ball, spin: s.ball.spin ?? 0 };
    this.extraBalls = s.extraBalls.map((b) => ({ ...b, spin: b.spin ?? 0 }));
    // Paddles are re-added (with their saved Y) by the lobby as players reattach.
    this.players = { left: [], right: [] };
    this.paddleX = { ...s.paddleX };
    this.score = { ...s.score };
    this.status = s.status;
    this.closing = s.closing;
    this.layered = s.layered ?? false;
    this.diamond = s.diamond ?? false;
    this.diamondBlock = s.diamondBlock ? { ...s.diamondBlock } : null;
    this.pinata = s.pinata ?? false;
    this.pinataObj = s.pinataObj
      ? { ...s.pinataObj, stuck: (s.pinataObj.stuck ?? []).map((x) => ({ ...x })) }
      : null;
    this.blocks = s.blocks ? s.blocks.map((bl) => ({ ...bl })) : [];
    this.rotated = typeof s.rotated === 'number' ? s.rotated : (s.rotated ? 1 : 0);
    this.fritz = s.fritz ?? false;
    this.disco = s.disco ?? false;
    this.minion = s.minion ?? false;
    this.earthquake = s.earthquake ?? false;
    this.blackout = s.blackout ?? false; this.vortex = s.vortex ?? false;
    this.glitch = s.glitch ?? false; this.smoke = s.smoke ?? false; this.tilt = s.tilt ?? false;
    this.breakout = s.breakout ?? false;
    this.brickAlive = s.brickAlive ? [...s.brickAlive] : this.freshBricks();
    this.fog = s.fog ?? false;
    this.portal = s.portal ?? false;
    this.bumpers = s.bumpers ?? false;
    this.winnerSide = s.winnerSide;
    this.lastHit = s.lastHit;
    this.target = s.target ? { ...s.target } : null;
    this.growHits = { ...s.growHits };
    this.shrinkHits = { ...s.shrinkHits };
    this.smashHits = { ...s.smashHits };
    this.curveHits = s.curveHits ? { ...s.curveHits } : { left: 0, right: 0 };
    this.roamHits = s.roamHits ? { ...s.roamHits } : { left: 0, right: 0 };
    this.roamX = s.roamX ? { ...s.roamX } : { left: 0, right: 0 };
    this.roamTargetX = s.roamTargetX ? { ...s.roamTargetX } : { left: 0, right: 0 };
    this.slowTimer = s.slowTimer;
    this.freezeTimer = s.freezeTimer ? { ...s.freezeTimer } : { left: 0, right: 0 };
    this.blindTimer = s.blindTimer ? { ...s.blindTimer } : { left: 0, right: 0 };
    this.mirrorTimer = s.mirrorTimer ? { ...s.mirrorTimer } : { left: 0, right: 0 };
    this.ghostTimer = s.ghostTimer ?? 0;
    this.tinyTimer = s.tinyTimer ?? 0;
    this.bigBallTimer = s.bigBallTimer ?? 0;
    this.shielded = s.shielded ? { ...s.shielded } : { left: false, right: false };
    this.pinataPendingSpawns = s.pinataPendingSpawns ?? 0;
    this.pinataBurstPending = s.pinataBurstPending ?? false;
    this.serveTimer = s.serveTimer;
    this.serveDir = s.serveDir;
    this.targetTimer = s.targetTimer;
    this.winScore = s.winScore ?? WIN_SCORE;
    // The sockets that drove this match (and their mouse-capture) are gone after a
    // restart, so always resume frozen — the reattached players unfreeze it by
    // capturing their mice again, exactly like the normal start-of-match flow.
    this.paused = true;
  }

  /** Current paddle half-height for a side — grown/shrunk by active power-ups. */
  halfH(side: Side): number {
    let h = PADDLE.h;
    if (this.growHits[side] > 0) h *= PADDLE_BOOST;
    if (this.shrinkHits[side] > 0) h *= PADDLE_SHRINK;
    return h / 2;
  }

  /** Seat a player on a side: give them their own paddle. */
  addPlayer(side: Side, id: string, y = COURT.h / 2) {
    if (this.players[side].some((p) => p.id === id)) return;
    this.players[side].push({ id, y, targetY: y });
  }

  /** Remove a player's paddle (they left their seat). */
  removePlayer(side: Side, id: string) {
    this.players[side] = this.players[side].filter((p) => p.id !== id);
  }

  /** A seated player's current paddle Y, or null if they have no paddle. */
  paddleYOf(side: Side, id: string): number | null {
    return this.players[side].find((p) => p.id === id)?.y ?? null;
  }

  /** Begin a fresh match (called once both sides have at least one player). */
  start() {
    this.score = { left: 0, right: 0 };
    this.winnerSide = null;
    // Spread each team's paddles evenly down the court so they don't start stacked.
    for (const side of ['left', 'right'] as Side[]) {
      const team = this.players[side];
      team.forEach((p, i) => {
        p.y = (COURT.h * (i + 1)) / (team.length + 1);
        p.targetY = p.y;
      });
    }
    this.paddleX = { ...HOME_X }; // paddles always start at full width
    this.blocks = []; // spectator blocks don't carry into a new match
    this.clearPowerups();
    this.target = null;
    this.targetTimer = this.nextTargetDelay();
    this.status = 'playing';
    // Diamond-hands mode: (re)spawn the drifting obstacle for the new match.
    if (this.diamond) this.spawnDiamond();
    else this.diamondBlock = null;
    // Piñata mode: (re)spawn the collector for the new match.
    if (this.pinata) this.spawnPinata();
    else this.pinataObj = null;
    this.serve(Math.random() < 0.5 ? 1 : -1);
  }

  /** Arm / disarm closing-walls mode. Disarming snaps paddles back to full width. */
  setClosing(on: boolean) {
    this.closing = on;
    if (!on) this.paddleX = { ...HOME_X };
  }

  setGravity(on: boolean) { this.gravity = on; }
  setTurbo(on: boolean) { this.turbo = on; }
  setLayered(on: boolean) { this.layered = on; } // positions are computed, so this applies live

  /** Arm / disarm diamond-hands mode. Toggling takes effect immediately during a live
   *  match (spawn the diamond on, remove it off); otherwise it spawns at the next start. */
  setDiamond(on: boolean) {
    this.diamond = on;
    if (on) {
      if (this.status === 'playing' && !this.diamondBlock) this.spawnDiamond();
    } else {
      this.diamondBlock = null;
    }
  }

  // Drop the diamond obstacle onto the board at a random central spot, drifting in a
  // random direction. Kept clear of the very center so it doesn't sit on the serve point.
  private spawnDiamond() {
    const angle = Math.random() * Math.PI * 2;
    const pad = DIAMOND.r + 40;
    this.diamondBlock = {
      x: COURT.w * 0.35 + Math.random() * COURT.w * 0.3,
      y: pad + Math.random() * (COURT.h - 2 * pad),
      vx: Math.cos(angle) * DIAMOND.speed,
      vy: Math.sin(angle) * DIAMOND.speed,
    };
  }

  // Drift the diamond and bounce it off the four walls (its vertices touch at ±r).
  private moveDiamond(dt: number, scale: number) {
    const d = this.diamondBlock;
    if (!d) return;
    d.x += d.vx * dt * scale;
    d.y += d.vy * dt * scale;
    if (d.x - DIAMOND.r < 0) { d.x = DIAMOND.r; d.vx = Math.abs(d.vx); }
    else if (d.x + DIAMOND.r > COURT.w) { d.x = COURT.w - DIAMOND.r; d.vx = -Math.abs(d.vx); }
    if (d.y - DIAMOND.r < 0) { d.y = DIAMOND.r; d.vy = Math.abs(d.vy); }
    else if (d.y + DIAMOND.r > COURT.h) { d.y = COURT.h - DIAMOND.r; d.vy = -Math.abs(d.vy); }
  }

  /** Arm / disarm piñata mode. Like diamond hands: takes effect immediately during a
   *  live match (spawn on, remove off); otherwise it spawns at the next match start. */
  setPinata(on: boolean) {
    this.pinata = on;
    if (on) {
      if (this.status === 'playing' && !this.pinataObj) this.spawnPinata();
    } else {
      this.pinataObj = null;
    }
  }

  // Drop the piñata onto the board at a random central spot, drifting in a random
  // direction with an empty stuck list.
  private spawnPinata() {
    const angle = Math.random() * Math.PI * 2;
    const pad = PINATA.r + 40;
    this.pinataObj = {
      x: COURT.w * 0.4 + Math.random() * COURT.w * 0.2,
      y: pad + Math.random() * (COURT.h - 2 * pad),
      vx: Math.cos(angle) * PINATA.speed,
      vy: Math.sin(angle) * PINATA.speed,
      spin: 0,
      stuck: [],
    };
    this.pinataPendingSpawns = 0;
    this.pinataBurstPending = false;
  }

  private freshBricks(): boolean[] {
    return new Array(BREAKOUT.cols * BREAKOUT.rows).fill(true);
  }

  setBreakout(on: boolean) {
    this.breakout = on;
    if (on) this.brickAlive = this.freshBricks();
    else    this.brickAlive = [];
  }

  setFog(on: boolean)     { this.fog = on; }
  setPortal(on: boolean)  { this.portal = on; }
  setBumpers(on: boolean) { this.bumpers = on; }

  // Drift the piñata, spin it, and bounce it off the four walls (radius PINATA.r).
  private movePinata(dt: number, scale: number) {
    const p = this.pinataObj;
    if (!p) return;
    p.x += p.vx * dt * scale;
    p.y += p.vy * dt * scale;
    p.spin += PINATA.spin * dt;
    if (p.x - PINATA.r < 0) { p.x = PINATA.r; p.vx = Math.abs(p.vx); }
    else if (p.x + PINATA.r > COURT.w) { p.x = COURT.w - PINATA.r; p.vx = -Math.abs(p.vx); }
    if (p.y - PINATA.r < 0) { p.y = PINATA.r; p.vy = Math.abs(p.vy); }
    else if (p.y + PINATA.r > COURT.h) { p.y = COURT.h - PINATA.r; p.vy = -Math.abs(p.vy); }
  }

  // A ball just touched the piñata: stick it to the surface. Records the contact angle
  // (relative to current rotation) and the ball's speed, then either owes a replacement
  // ball (1st–4th) or flags a burst (the 5th). The ball itself is consumed by the caller.
  private stickToPinata(b: Ball) {
    const p = this.pinataObj!;
    const angle = Math.atan2(b.y - p.y, b.x - p.x) - p.spin;
    const speed = Math.max(Math.hypot(b.vx, b.vy), BALL.speed);
    p.stuck.push({ angle, speed });
    if (p.stuck.length > PINATA.stickMax) this.pinataBurstPending = true; // the 5th — pop it
    else this.pinataPendingSpawns += 1; // 1st–4th — the piñata spits out a fresh ball
  }

  // After the per-ball step: emit replacement balls owed this tick and, on a burst, fling
  // every stuck ball back out radially. Returns the new balls to fold into play. `liveCount`
  // is the number already in play, so replacements respect the safety cap.
  private applyPinata(liveCount: number): Ball[] {
    const p = this.pinataObj;
    if (!p) {
      this.pinataPendingSpawns = 0;
      this.pinataBurstPending = false;
      return [];
    }
    const out: Ball[] = [];
    let budget = PINATA.maxBalls - liveCount; // cap replacements (bursts ignore the cap)
    while (this.pinataPendingSpawns > 0) {
      this.pinataPendingSpawns -= 1;
      if (budget > 0) { out.push(this.spawnFromPinata(Math.random() * Math.PI * 2, BALL.speed)); budget -= 1; }
    }
    if (this.pinataBurstPending) {
      for (const s of p.stuck) out.push(this.spawnFromPinata(s.angle + p.spin, s.speed));
      p.stuck = [];
      this.pinataBurstPending = false;
      this.pinataBurstFlash = true; // one-frame pulse for the client's pop animation
    }
    return out;
  }

  // Make a ball just outside the piñata's surface, heading outward along `angle` so it
  // can't immediately re-stick.
  private spawnFromPinata(angle: number, speed: number): Ball {
    const p = this.pinataObj!;
    const d = PINATA.r + this.ballR() + 6;
    return {
      x: p.x + Math.cos(angle) * d,
      y: p.y + Math.sin(angle) * d,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      spin: 0,
    };
  }

  /** Drop a solid obstacle block at a random central spot (clear of the paddles, the exact
   *  center serve point, and — best effort — other blocks). No-op when the board is full or
   *  no match is live. Returns true if a block was actually added. */
  addBlock(): boolean {
    if (this.status !== 'playing') return false;
    if (this.blocks.length >= BLOCK.maxCount) return false;
    for (let attempt = 0; attempt < 12; attempt++) {
      // Square, like a breakout brick (just bigger). One size drives both sides.
      const w = BLOCK.min + Math.random() * (BLOCK.max - BLOCK.min);
      const h = w;
      const x = COURT.w * 0.25 + Math.random() * COURT.w * 0.5;
      const y = (h / 2 + 16) + Math.random() * (COURT.h - h - 32);
      // Keep clear of the very center so it doesn't sit on the serve point.
      if (Math.hypot(x - COURT.w / 2, y - COURT.h / 2) < 90) continue;
      // Avoid heavy overlap with an existing block (best effort — small overlap is fine).
      const clash = this.blocks.some(
        (bl) => Math.abs(bl.x - x) < (bl.w + w) / 2 - 8 && Math.abs(bl.y - y) < (bl.h + h) / 2 - 8,
      );
      if (clash) continue;
      this.blocks.push({ x, y, w, h });
      return true;
    }
    return false;
  }

  // Carom a ball off any spectator-dropped block: an axis-aligned box reflect that also
  // pushes the ball back to the nearest face, so it can never wedge inside. No-op when the
  // ball isn't overlapping the (radius-expanded) box.
  private bounceBlocks(b: Ball) {
    const r = this.ballR();
    // Just like breakout bricks: reflect on the face the ball hit first (smaller overlap),
    // then destroy the block. One block per step so the ball can't tunnel through a seam.
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const bl = this.blocks[i];
      const left = bl.x - bl.w / 2, right = bl.x + bl.w / 2;
      const top = bl.y - bl.h / 2, bottom = bl.y + bl.h / 2;
      if (b.x + r <= left || b.x - r >= right || b.y + r <= top || b.y - r >= bottom) continue; // no overlap
      const overlapLeft = (b.x + r) - left;
      const overlapRight = right - (b.x - r);
      const overlapTop = (b.y + r) - top;
      const overlapBot = bottom - (b.y - r);
      const minH = Math.min(overlapLeft, overlapRight);
      const minV = Math.min(overlapTop, overlapBot);
      if (minH < minV) {
        b.vx = overlapLeft < overlapRight ? -Math.abs(b.vx) : Math.abs(b.vx);
      } else {
        b.vy = overlapTop < overlapBot ? -Math.abs(b.vy) : Math.abs(b.vy);
      }
      this.blocks.splice(i, 1); // one hit shatters it, like a breakout brick
      break;
    }
  }

  // Carom a ball off the diamond. The diamond is an L1 "circle" (|dx|+|dy| ≤ r), so its
  // faces are the four 45° lines; reflect the ball about the face of whichever quadrant
  // it's in. No-op when the ball is outside reach or already moving away (no trapping).
  private bounceDiamond(b: Ball) {
    const d = this.diamondBlock;
    if (!d) return;
    const dx = b.x - d.x;
    const dy = b.y - d.y;
    const reach = DIAMOND.r + this.ballR() * Math.SQRT2; // L1 offset for the ball radius
    const l1 = Math.abs(dx) + Math.abs(dy);
    if (l1 > reach) return;
    const inv = 1 / Math.SQRT2;
    const nx = (Math.sign(dx) || 1) * inv; // outward face normal for this quadrant
    const ny = (Math.sign(dy) || 1) * inv;
    const vn = b.vx * nx + b.vy * ny;
    if (vn >= 0) return; // moving away — don't yank it back
    b.vx -= 2 * vn * nx; // reflect velocity about the face normal
    b.vy -= 2 * vn * ny;
    b.spin = 0; // a clean carom drops any curve spin
    const push = (reach - l1) * inv; // shove the ball just outside the face
    b.x += nx * push;
    b.y += ny * push;
  }

  // Carom a ball off any static bumper peg. Circle-vs-circle: reflect about the outward
  // normal, apply a small speed boost (capped), push the ball clear, and flag the flash.
  private bounceBumpers(b: Ball) {
    if (!this.bumpers) return;
    const r = this.ballR();
    for (let i = 0; i < BUMPER_POSITIONS.length; i++) {
      const bp = BUMPER_POSITIONS[i];
      const dx = b.x - bp.x;
      const dy = b.y - bp.y;
      const dist = Math.hypot(dx, dy);
      const minDist = BUMPER.r + r;
      if (dist >= minDist) continue;
      const nx = dist > 0 ? dx / dist : 1;
      const ny = dist > 0 ? dy / dist : 0;
      const vn = b.vx * nx + b.vy * ny;
      if (vn >= 0) continue; // moving away — skip
      b.vx -= 2 * vn * nx;
      b.vy -= 2 * vn * ny;
      const speed = Math.hypot(b.vx, b.vy);
      const boosted = Math.min(speed * BUMPER.speedBoost, BALL.speed * 3);
      b.vx = (b.vx / speed) * boosted;
      b.vy = (b.vy / speed) * boosted;
      b.x += nx * (minDist - dist);
      b.y += ny * (minDist - dist);
      b.spin = 0;
      this.bumperFlash[i] = true;
    }
  }

  /** Center X of the i-th paddle on a side. In layered mode each later joiner sits a
   *  step further forward (toward mid-court), capped so no face crosses the middle.
   *  Stacks with the closing-walls inset, which moves the whole team's base X. */
  paddleXAt(side: Side, idx: number): number {
    let x = this.paddleX[side];
    if (this.layered && idx > 0) {
      const maxX = COURT.w / 2 - LAYERED.cap - PADDLE.w / 2;
      x = side === 'left'
        ? Math.min(x + LAYERED.step * idx, maxX)
        : Math.max(x - LAYERED.step * idx, COURT.w - maxX);
    }
    // "Roam" power-up: the freed paddle has pushed `roamX` units inward off its wall.
    if (this.roamX[side] > 0) x += side === 'left' ? this.roamX[side] : -this.roamX[side];
    return x;
  }

  /** A seated player's current paddle center X, found by their connection id. */
  paddleXOf(side: Side, id: string): number {
    const i = this.players[side].findIndex((p) => p.id === id);
    return i === -1 ? this.paddleX[side] : this.paddleXAt(side, i);
  }

  /** X of the i-th paddle's hitting face — its inner edge. */
  private faceXAt(side: Side, idx: number): number {
    const x = this.paddleXAt(side, idx);
    return side === 'left' ? x + PADDLE.w / 2 : x - PADDLE.w / 2;
  }

  /** Park the simulation back in the lobby (e.g. a player left mid-match). */
  toWaiting() {
    this.status = 'waiting';
    this.ball = { x: COURT.w / 2, y: COURT.h / 2, vx: 0, vy: 0, spin: 0 };
    this.extraBalls = [];
    this.lastHit = null;
    this.target = null;
    this.diamondBlock = null;
    this.pinataObj = null;
    this.pinataPendingSpawns = 0;
    this.pinataBurstPending = false;
    this.blocks = [];
    this.clearPowerups();
  }

  private clearPowerups() {
    this.growHits = { left: 0, right: 0 };
    this.shrinkHits = { left: 0, right: 0 };
    this.smashHits = { left: 0, right: 0 };
    this.curveHits = { left: 0, right: 0 };
    this.roamHits = { left: 0, right: 0 };
    this.roamX = { left: 0, right: 0 };
    this.roamTargetX = { left: 0, right: 0 };
    this.slowTimer = 0;
    this.freezeTimer = { left: 0, right: 0 };
    this.blindTimer = { left: 0, right: 0 };
    this.mirrorTimer = { left: 0, right: 0 };
    this.ghostTimer = 0;
    this.tinyTimer = 0;
    this.bigBallTimer = 0;
    this.shielded = { left: false, right: false };
    this.rotated = 0; // a new match always starts un-rotated
    this.blasterAmmo = { left: 0, right: 0 };
    this.disabledTimer = { left: 0, right: 0 };
    this.projectiles = [];
  }

  /** Current ball radius — enlarged while bigball power-up is active. */
  ballR(): number {
    return this.bigBallTimer > 0 ? BIG_BALL_R : BALL.r;
  }

  setWinScore(n: number) { this.winScore = Math.max(1, n); }

  setTarget(side: Side, id: string, y: number, x?: number) {
    const ent = this.players[side].find((p) => p.id === id);
    if (!ent) return;
    const half = this.halfH(side);
    // Mirror power-up: invert the client's desired y so controls feel upside-down.
    const effective = this.mirrorTimer[side] > 0 ? COURT.h - y : y;
    ent.targetY = clamp(effective, half, COURT.h - half);
    // Roam power-up: the client also sends a desired inward inset off the wall.
    if (typeof x === 'number' && Number.isFinite(x) && this.roamHits[side] > 0) {
      this.roamTargetX[side] = clamp(x, 0, ROAM.maxInset);
    }
  }

  private serve(dir: number) {
    this.serveDir = dir;
    this.serveTimer = SERVE_DELAY;
    this.ball = { x: COURT.w / 2, y: COURT.h / 2, vx: 0, vy: 0, spin: 0 };
    this.extraBalls = [];
    this.lastHit = null;
    // Clear all per-point effects so they don't bleed into the next rally.
    this.slowTimer = 0;
    this.freezeTimer = { left: 0, right: 0 };
    this.blindTimer = { left: 0, right: 0 };
    this.mirrorTimer = { left: 0, right: 0 };
    this.ghostTimer = 0;
    this.tinyTimer = 0;
    this.bigBallTimer = 0;
    this.curveHits = { left: 0, right: 0 };
    this.rotated = 0;
    this.fritz = false;
    this.disco = false;
    this.minion = false;
    this.earthquake = false;
    this.blackout = false; this.vortex = false;
    this.glitch = false; this.smoke = false; this.tilt = false;
    this.blasterAmmo = { left: 0, right: 0 };
    this.disabledTimer = { left: 0, right: 0 };
    this.projectiles = [];
    // Shield intentionally persists — an unused shield stays for the next point.
    // Piñata: drop anything stuck and clear pending effects; the collector keeps drifting.
    if (this.pinataObj) this.pinataObj.stuck = [];
    this.pinataPendingSpawns = 0;
    this.pinataBurstPending = false;
    // Breakout: reset the brick grid for each new point.
    if (this.breakout) this.brickAlive = this.freshBricks();
  }

  private launch() {
    const speed = this.turbo ? BALL.speed * TURBO_SPEED_MULT : BALL.speed;
    const angle = (Math.random() * 2 - 1) * 0.3; // small vertical spread on serve
    this.ball.vx = this.serveDir * speed * Math.cos(angle);
    this.ball.vy = speed * Math.sin(angle);
  }

  tick(dt: number) {
    this.pinataBurstFlash = false; // a burst this tick (if any) sets it back to true
    this.bumperFlash.fill(false);  // any bumper hits this tick set their slot to true
    // Paddles ease toward their target each tick; frozen paddles don't move.
    const maxStep = PADDLE.speed * dt;
    for (const side of ['left', 'right'] as Side[]) {
      if (this.freezeTimer[side] > 0 || this.disabledTimer[side] > 0) continue; // frozen / blaster-locked — skip easing
      for (const p of this.players[side]) {
        const diff = p.targetY - p.y;
        p.y += clamp(diff, -maxStep, maxStep);
      }
      // Roam: ease the paddle's inward inset toward its target. Once the power-up's hits
      // are spent the target is pinned home (0) so the paddle drifts back to its wall.
      if (this.roamHits[side] <= 0) this.roamTargetX[side] = 0;
      const dx = this.roamTargetX[side] - this.roamX[side];
      if (dx !== 0) this.roamX[side] = clamp(this.roamX[side] + clamp(dx, -maxStep, maxStep), 0, ROAM.maxInset);
    }

    if (this.status !== 'playing') return;

    // Frozen while waiting for both players to capture their mouse. Paddles still ease
    // (above) but the ball, serve countdown and power-up timers all hold.
    if (this.paused) return;

    // The diamond-hands obstacle drifts continuously while the match is live — including
    // through the brief serve countdown — so it never visibly freezes between points.
    this.moveDiamond(dt, this.slowTimer > 0 ? SLOW_SCALE : 1);
    this.movePinata(dt, this.slowTimer > 0 ? SLOW_SCALE : 1);

    if (this.serveTimer > 0) {
      this.serveTimer -= dt;
      if (this.serveTimer <= 0) this.launch();
      return;
    }

    if (this.slowTimer > 0) this.slowTimer -= dt;
    if (this.ghostTimer > 0) this.ghostTimer -= dt;
    if (this.tinyTimer > 0) this.tinyTimer -= dt;
    if (this.bigBallTimer > 0) this.bigBallTimer -= dt;
    for (const side of ['left', 'right'] as Side[]) {
      if (this.freezeTimer[side] > 0) this.freezeTimer[side] -= dt;
      if (this.disabledTimer[side] > 0) this.disabledTimer[side] -= dt;
      if (this.blindTimer[side] > 0) this.blindTimer[side] -= dt;
      if (this.mirrorTimer[side] > 0) this.mirrorTimer[side] -= dt;
    }
    // Blaster projectiles fly on their own clock (not slowed by the slow power-up).
    this.moveProjectiles(dt);
    const scale = this.slowTimer > 0 ? SLOW_SCALE : 1;

    // Advance every ball. A ball that leaves the court just drops out of play — NO point
    // is scored while other balls remain, so during multi-ball one ball going out never
    // ends the rally. Only once the court is completely empty does the last ball out
    // concede the single point for the rally.
    const prevExtras = this.extraBalls.length; // a multi power-up may append more below
    const survivors: Ball[] = [];
    let lastScorer: Side | null = null;
    for (const b of [this.ball, ...this.extraBalls]) {
      const scorer = this.stepBall(b, dt, scale);
      if (scorer === 'consumed') continue; // stuck to the piñata — removed from play
      if (scorer) lastScorer = scorer; // remember who'd score, but don't award yet
      else survivors.push(b);
    }

    this.updateTargetTimer(dt);

    // A "multi" power-up claimed this tick appends new balls past extraBalls' original
    // length; keep them alongside the survivors (otherwise the new ball is discarded).
    const spawned = this.extraBalls.slice(prevExtras);
    // Piñata: replacement balls for any that stuck, plus a burst's released balls.
    const released = this.applyPinata(survivors.length + spawned.length);
    const live = [...survivors, ...spawned, ...released];

    if (live.length > 0) {
      // Balls still in play: keep going, promoting one to the primary slot.
      this.ball = live[0];
      this.extraBalls = live.slice(1);
    } else if (lastScorer) {
      // Court is empty → award one point to the last ball's scorer, then end or re-serve.
      if (this.scorePoint(lastScorer)) {
        this.extraBalls = []; // match over
        return;
      }
      if (this.closing) this.paddleX = { ...HOME_X };
      this.serve(lastScorer === 'left' ? 1 : -1);
    }
  }

  // Move one ball a tick: integrate, bounce off walls/paddles, claim the target, and
  // return the scoring side if it left the court, 'consumed' if the piñata ate it, else null.
  private stepBall(b: Ball, dt: number, scale: number): Side | 'consumed' | null {
    // Spin (curve power-up): rotate velocity direction and decay.
    if (b.spin !== 0) {
      const speed = Math.hypot(b.vx, b.vy);
      const angle = Math.atan2(b.vy, b.vx) + b.spin * dt;
      b.vx = speed * Math.cos(angle);
      b.vy = speed * Math.sin(angle);
      b.spin *= Math.exp(-2 * dt); // ~0.5 s half-life
      if (Math.abs(b.spin) < 0.01) b.spin = 0;
    }

    // Gravity: accelerate downward before integrating position.
    if (this.gravity) b.vy += GRAVITY_ACCEL * dt * scale;

    // Earthquake: jitter the ball's heading a touch each tick so it wobbles unpredictably
    // (speed preserved — only the direction shakes).
    if (this.earthquake) {
      const a = (Math.random() * 2 - 1) * 3.5 * dt; // small per-tick angle nudge
      const cos = Math.cos(a), sin = Math.sin(a);
      const nvx = b.vx * cos - b.vy * sin;
      const nvy = b.vx * sin + b.vy * cos;
      b.vx = nvx; b.vy = nvy;
    }
    // Vortex: gently pull the ball toward court center, so its path spirals inward.
    if (this.vortex) {
      b.vx += (COURT.w / 2 - b.x) * 0.9 * dt;
      b.vy += (COURT.h / 2 - b.y) * 0.9 * dt;
    }
    // Tilt: the court leans, so the ball rolls steadily downward (a mild extra gravity).
    if (this.tilt) b.vy += 150 * dt * scale;

    const prevX = b.x;
    const prevY = b.y;
    b.x += b.vx * dt * scale;
    b.y += b.vy * dt * scale;

    const r = this.ballR();

    // Top / bottom walls — portal mode teleports instead of bouncing.
    if (b.y - r < 0) {
      if (this.portal) {
        b.y = COURT.h - r - 1;
        b.vy = -Math.abs(b.vy); // exits from the bottom heading upward
      } else {
        b.y = r;
        b.vy = Math.abs(b.vy);
      }
    } else if (b.y + r > COURT.h) {
      if (this.portal) {
        b.y = r + 1;
        b.vy = Math.abs(b.vy); // exits from the top heading downward
      } else {
        b.y = COURT.h - r;
        b.vy = -Math.abs(b.vy);
      }
    }

    // Breakout: check ball against surviving bricks.
    // Phase through the wall until the first paddle hit so the ball doesn't
    // spawn inside the wall and immediately destroy bricks on serve.
    if (this.breakout && this.brickAlive.length > 0 && this.lastHit !== null) {
      const { cols, rows, w, h, gap, left, top } = BREAKOUT;
      outer: for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const idx = row * cols + col;
          if (!this.brickAlive[idx]) continue;
          const bx = left + col * (w + gap);
          const by = top  + row * (h + gap);
          // AABB overlap test, expanded by ball radius on each side.
          if (b.x + r > bx && b.x - r < bx + w && b.y + r > by && b.y - r < by + h) {
            this.brickAlive[idx] = false;
            // Reflect on the axis with the smaller overlap (face that was hit first).
            const overlapLeft  = (b.x + r) - bx;
            const overlapRight = (bx + w) - (b.x - r);
            const overlapTop   = (b.y + r) - by;
            const overlapBot   = (by + h)  - (b.y - r);
            const minH = Math.min(overlapLeft, overlapRight);
            const minV = Math.min(overlapTop, overlapBot);
            if (minH < minV) {
              b.vx = overlapLeft < overlapRight ? -Math.abs(b.vx) : Math.abs(b.vx);
            } else {
              b.vy = overlapTop < overlapBot ? -Math.abs(b.vy) : Math.abs(b.vy);
            }
            break outer; // one brick per step to avoid tunnelling through a seam
          }
        }
      }
    }

    this.checkTargetHit(prevX, prevY, b);

    // Paddle collisions — a side may field several paddles, and in layered mode they
    // sit on different planes. Bounce off whichever face the ball is crossing.
    if (b.vx < 0) {
      const hit = this.paddleAt('left', b, r);
      if (hit) this.bounce('left', b, hit.ent, hit.idx);
    } else if (b.vx > 0) {
      const hit = this.paddleAt('right', b, r);
      if (hit) this.bounce('right', b, hit.ent, hit.idx);
    }

    // Diamond obstacle carom (diamond-hands mode); no-op when the mode is off.
    this.bounceDiamond(b);

    // Bumper peg caroms (bumpers mode); no-op when mode is off.
    this.bounceBumpers(b);

    // Spectator-dropped blocks carom (no-op when there are none).
    this.bounceBlocks(b);

    // Piñata collector (piñata mode): a touch sticks the ball and removes it from play.
    if (this.pinataObj) {
      const pdx = b.x - this.pinataObj.x;
      const pdy = b.y - this.pinataObj.y;
      if (Math.hypot(pdx, pdy) <= PINATA.r + r) {
        this.stickToPinata(b);
        return 'consumed';
      }
    }

    // Scoring — check shield before awarding the point.
    if (b.x < -r) {
      if (this.shielded.left) {
        // Shield absorbs the goal: bounce the ball back and clear the shield.
        b.x = r;
        b.vx = Math.abs(b.vx);
        b.spin = 0;
        this.shielded.left = false;
        return null;
      }
      return 'right';
    }
    if (b.x > COURT.w + r) {
      if (this.shielded.right) {
        b.x = COURT.w - r;
        b.vx = -Math.abs(b.vx);
        b.spin = 0;
        this.shielded.right = false;
        return null;
      }
      return 'left';
    }
    return null;
  }

  private nextTargetDelay(): number {
    return TARGET.minDelay + Math.random() * (TARGET.maxDelay - TARGET.minDelay);
  }

  /** Force a power-up onto the board now (the "/powerup [name]" command) — the given
   *  kind, or a random one when unnamed. Live matches only. */
  forceTarget(kind?: PowerupKind): boolean {
    if (this.status !== 'playing') return false;
    // "coins" can't be conjured manually — it only appears on the random auto-spawn roll.
    this.placeTarget(kind === 'coins' ? undefined : kind);
    return true;
  }

  // Drop a fresh power-up target onto the board, replacing any current one. A given `kind`
  // is honored as-is; otherwise a random kind is chosen, never "coins" (that has its own roll).
  private placeTarget(kind?: PowerupKind) {
    const margin = TARGET.r + 24; // keep it clear of the walls
    this.target = {
      x: COURT.w * 0.3 + Math.random() * COURT.w * 0.4, // central band, clear of paddles
      y: margin + Math.random() * (COURT.h - 2 * margin),
      kind: kind ?? (() => {
        const pool = POWERUPS.filter((k) => k !== 'coins' && !this.excludedPowerups.has(k));
        return pool[Math.floor(Math.random() * pool.length)];
      })(),
    };
    this.targetTimer = TARGET.life;
  }

  // Spawn or expire the power-up target on its own timer. Each auto-spawn has a 15% chance
  // to be the "coins" reward (the only way coins appears).
  private updateTargetTimer(dt: number) {
    this.targetTimer -= dt;
    if (!this.target) {
      if (this.targetTimer <= 0) this.placeTarget(Math.random() < 0.15 ? 'coins' : undefined);
    } else if (this.targetTimer <= 0) {
      this.target = null; // unclaimed; vanish and schedule the next one
      this.targetTimer = this.nextTargetDelay();
    }
  }

  // Award the target if a ball's path this tick crossed it (and the ball has actually
  // been struck, so a serve flying through doesn't gift a power-up).
  private checkTargetHit(prevX: number, prevY: number, b: Ball) {
    if (!this.target || !this.lastHit) return;
    const d = distToSegment(this.target.x, this.target.y, prevX, prevY, b.x, b.y);
    if (d > TARGET.r + this.ballR()) return;
    this.grant(this.target.kind, this.lastHit);
    this.target = null;
    this.targetTimer = this.nextTargetDelay();
  }

  private grant(kind: PowerupKind, side: Side) {
    switch (kind) {
      case 'grow':
        this.growHits[side] = POWERUP_HITS;
        break;
      case 'shrink':
        this.shrinkHits[other(side)] = POWERUP_HITS;
        break;
      case 'smash':
        this.smashHits[side] = POWERUP_HITS;
        break;
      case 'roam':
        this.roamHits[side] = ROAM.hits;
        break;
      case 'slow':
        this.slowTimer = SLOW_TIME;
        break;
      case 'multi':
        this.spawnExtraBall();
        this.spawnExtraBall();
        break;
      case 'freeze':
        this.freezeTimer[other(side)] = FREEZE_TIME;
        break;
      case 'curve':
        this.curveHits[side] = 1;
        break;
      case 'blind':
        this.blindTimer[other(side)] = BLIND_TIME;
        break;
      case 'mirror':
        this.mirrorTimer[other(side)] = MIRROR_TIME;
        break;
      case 'shield':
        this.shielded[side] = true;
        break;
      case 'ghost':
        this.ghostTimer = GHOST_TIME;
        break;
      case 'tiny':
        this.tinyTimer = TINY_TIME;
        break;
      case 'warp': {
        // Teleport the ball to a random mid-court position; preserve speed and direction.
        const margin = BALL.r + 40;
        this.ball.x = COURT.w * 0.25 + Math.random() * COURT.w * 0.5;
        this.ball.y = margin + Math.random() * (COURT.h - 2 * margin);
        this.ball.spin = 0;
        break;
      }
      case 'bigball':
        this.bigBallTimer = BIG_BALL_TIME;
        break;
      case 'rotate':
        // Each pickup adds 90° CW; 4 wraps back to 0 (full circle = normal).
        this.rotated = (this.rotated + 1) % 4;
        break;
      case 'fritz':
        this.fritz = true;
        break;
      case 'disco':
        this.disco = true;
        break;
      case 'minion':
        this.minion = true;
        break;
      case 'earthquake':
        this.earthquake = true;
        break;
      case 'blackout':
        this.blackout = true;
        break;
      case 'vortex':
        this.vortex = true;
        break;
      case 'glitch':
        this.glitch = true;
        break;
      case 'smoke':
        this.smoke = true;
        break;
      case 'tilt':
        this.tilt = true;
        break;
      case 'coins':
        // Transient economy reward — the lobby reads this and pays the side 100 coins.
        this.coinGrant = side;
        break;
      case 'blaster':
        this.blasterAmmo[side] = BLASTER.ammo;
        break;
    }
  }

  /** Blaster: fire a projectile from this side's paddle at the given vertical aim angle
   *  (radians, clamped to the aim cone). Forward is toward the opponent. No-op without ammo. */
  fire(side: Side, angle: number) {
    if (this.status !== 'playing' || this.paused) return;
    if (this.blasterAmmo[side] <= 0) return;
    const ent = this.players[side][0];
    if (!ent) return;
    const a = clamp(angle, -BLASTER.maxAngle, BLASTER.maxAngle);
    const dir = side === 'left' ? 1 : -1;
    // Launch just off the paddle's inner face so it doesn't immediately self-collide.
    const faceX = this.paddleX[side] + dir * (PADDLE.w / 2 + BLASTER.r + 1);
    this.blasterAmmo[side] -= 1;
    this.projectiles.push({
      side,
      x: faceX,
      y: ent.y,
      vx: dir * BLASTER.speed * Math.cos(a),
      vy: BLASTER.speed * Math.sin(a),
      life: BLASTER.life,
    });
  }

  /** Advance projectiles: bounce off top/bottom, lock a paddle on hit, expire off-court. */
  private moveProjectiles(dt: number) {
    const r = BLASTER.r;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // Bounce off the top/bottom walls so angled shots stay in play.
      if (p.y < r) { p.y = r; p.vy = Math.abs(p.vy); }
      else if (p.y > COURT.h - r) { p.y = COURT.h - r; p.vy = -Math.abs(p.vy); }
      // Hit the opponent's paddle? (rectangle around its center)
      const opp = other(p.side);
      const ent = this.players[opp][0];
      if (ent) {
        const halfH = this.halfH(opp);
        const cx = this.paddleX[opp];
        if (Math.abs(p.x - cx) <= PADDLE.w / 2 + r && Math.abs(p.y - ent.y) <= halfH + r) {
          this.disabledTimer[opp] = BLASTER.disable;
          this.projectiles.splice(i, 1);
          continue;
        }
      }
      // Off the court (past either wall) or fizzled out.
      if (p.life <= 0 || p.x < -20 || p.x > COURT.w + 20) this.projectiles.splice(i, 1);
    }
  }

  private spawnExtraBall() {
    if (this.extraBalls.length >= MULTI_MAX) return;
    const src = this.ball;
    // Random speed between the default serve speed and the primary ball's current
    // speed, fired in a random direction (random side + random vertical spread, but
    // always with a real horizontal component so it actually reaches a paddle).
    const current = Math.hypot(src.vx, src.vy);
    const speed = BALL.speed + Math.random() * Math.max(0, current - BALL.speed);
    const dirX = Math.random() < 0.5 ? -1 : 1;
    const angle = (Math.random() * 2 - 1) * (Math.PI / 3); // ±60° off horizontal
    this.extraBalls.push({
      x: src.x,
      y: src.y,
      vx: dirX * speed * Math.cos(angle),
      vy: speed * Math.sin(angle),
      spin: 0,
    });
  }

  // The paddle on `side` whose face the ball is currently crossing with Y overlap, or
  // null if none. Layered teammates have distinct faces — the ball meets the most
  // forward matching one first; same-plane ties go to the closest paddle center.
  private paddleAt(side: Side, b: Ball, r: number): { ent: PaddleEnt; idx: number } | null {
    const reach = this.halfH(side) + r;
    let best: { ent: PaddleEnt; idx: number; face: number } | null = null;
    const team = this.players[side];
    for (let i = 0; i < team.length; i++) {
      const face = this.faceXAt(side, i);
      const crossing =
        side === 'left'
          ? b.x - r <= face && b.x - r > face - 40
          : b.x + r >= face && b.x + r < face + 40;
      if (!crossing || Math.abs(b.y - team[i].y) > reach) continue;
      const better =
        !best ||
        (side === 'left' ? face > best.face : face < best.face) ||
        (face === best.face && Math.abs(b.y - team[i].y) < Math.abs(b.y - best.ent.y));
      if (better) best = { ent: team[i], idx: i, face };
    }
    return best ? { ent: best.ent, idx: best.idx } : null;
  }

  private bounce(side: Side, b: Ball, ent: PaddleEnt, idx: number) {
    this.lastHit = side;
    this.hitSeq++;
    const rel = clamp((b.y - ent.y) / this.halfH(side), -1, 1);
    const speedup = this.turbo ? TURBO_SPEEDUP : BALL.speedup;
    let speed = Math.hypot(b.vx, b.vy) * speedup;
    if (this.smashHits[side] > 0) speed *= SMASH_BONUS;
    const angle = rel * MAX_BOUNCE;
    const dir = side === 'left' ? 1 : -1;
    b.vx = dir * speed * Math.cos(angle);
    b.vy = speed * Math.sin(angle);

    // Closing-walls mode: drag both paddles a step toward center on every hit.
    if (this.closing) {
      this.paddleX.left = clamp(this.paddleX.left + CLOSING.step, HOME_X.left, HOME_X.left + MAX_INSET);
      this.paddleX.right = clamp(this.paddleX.right - CLOSING.step, HOME_X.right - MAX_INSET, HOME_X.right);
    }

    // Place the ball just off the hit paddle's (possibly moved) face so it can't re-trigger.
    const face = this.faceXAt(side, idx);
    b.x = side === 'left' ? face + this.ballR() : face - this.ballR();
    // Consume per-hit charges.
    if (this.growHits[side] > 0) this.growHits[side] -= 1;
    if (this.shrinkHits[side] > 0) this.shrinkHits[side] -= 1;
    if (this.smashHits[side] > 0) this.smashHits[side] -= 1;
    // Roam: every hit by the freed side burns a charge; when it runs out the paddle
    // eases home (the easing loop pins roamTargetX to 0 once roamHits hits 0).
    if (this.roamHits[side] > 0) this.roamHits[side] -= 1;
    if (this.curveHits[side] > 0) {
      // Spin direction based on hit position: top half curves one way, bottom the other.
      b.spin = CURVE_SPIN * (rel >= 0 ? 1 : -1);
      this.curveHits[side] -= 1;
    }
  }

  // Credit a point to the scoring side; returns true if that ended the match. Serving
  // the next ball is handled by tick() once the court is clear of balls.
  private scorePoint(scorer: Side): boolean {
    this.score[scorer] += 1;
    if (this.score[scorer] >= this.winScore) {
      this.status = 'over';
      this.winnerSide = scorer;
      return true;
    }
    return false;
  }
}
