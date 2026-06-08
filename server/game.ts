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
  CURVE_SPIN,
  GRAVITY_ACCEL,
  TURBO_SPEED_MULT,
  TURBO_SPEEDUP,
  DIAMOND,
  PINATA,
  POWERUPS,
  TARGET,
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

// Everything needed to resume the simulation after a restart. Mirrors the Game's own
// fields (including the private serve/target timers) so a saved match continues exactly
// where it left off. `paused` is deliberately omitted — a resumed match always starts
// frozen until the reconnected players re-capture their mice.
export interface GameSnapshot {
  ball: Ball;
  extraBalls: Ball[];
  paddleY: Record<Side, number>;
  paddleX: Record<Side, number>;
  targetY: Record<Side, number>;
  score: { left: number; right: number };
  status: Status;
  closing: boolean;
  diamond: boolean;
  diamondBlock: { x: number; y: number; vx: number; vy: number } | null;
  pinata: boolean;
  pinataObj: PinataObj | null;
  winnerSide: Side | null;
  lastHit: Side | null;
  target: { x: number; y: number; kind: PowerupKind } | null;
  growHits: Record<Side, number>;
  shrinkHits: Record<Side, number>;
  smashHits: Record<Side, number>;
  slowTimer: number;
  serveTimer: number;
  serveDir: number;
  targetTimer: number;
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
  paddleY: Record<Side, number> = { left: COURT.h / 2, right: COURT.h / 2 };
  paddleX: Record<Side, number> = { ...HOME_X }; // current paddle center X (slides in closing mode)
  targetY: Record<Side, number> = { left: COURT.h / 2, right: COURT.h / 2 };
  score = { left: 0, right: 0 };
  status: Status = 'waiting';
  closing = false; // "closing walls" mode armed; applies from the next match start
  gravity = false; // constant downward pull bends ball trajectory
  turbo = false; // faster serve speed and steeper per-hit speedup
  diamond = false; // "diamond hands" mode armed; spawns a drifting diamond obstacle
  // The live diamond obstacle while diamond-hands mode is on during a match (else null).
  diamondBlock: { x: number; y: number; vx: number; vy: number } | null = null;
  pinata = false; // "piñata" mode armed; spawns a drifting ball-collector
  pinataObj: PinataObj | null = null; // the live piñata during a match (else null)
  pinataBurstFlash = false; // set for the single tick a burst happens (drives a client pulse)
  private pinataPendingSpawns = 0; // replacement balls owed this tick (one per ball stuck)
  private pinataBurstPending = false; // a 5th ball stuck this tick → release everything
  winnerSide: Side | null = null;
  lastHit: Side | null = null; // side whose paddle last touched any ball (null until first hit)
  paused = false; // set by the lobby: freeze play until both players capture their mouse

  // Power-ups. A target floats on the board; bouncing the ball over it grants its kind.
  target: { x: number; y: number; kind: PowerupKind } | null = null;
  growHits: Record<Side, number> = { left: 0, right: 0 };
  shrinkHits: Record<Side, number> = { left: 0, right: 0 };
  smashHits: Record<Side, number> = { left: 0, right: 0 };
  curveHits: Record<Side, number> = { left: 0, right: 0 };
  slowTimer = 0;
  freezeTimer: Record<Side, number> = { left: 0, right: 0 };
  blindTimer: Record<Side, number> = { left: 0, right: 0 };
  mirrorTimer: Record<Side, number> = { left: 0, right: 0 };
  ghostTimer = 0;
  tinyTimer = 0;
  bigBallTimer = 0;
  shielded: Record<Side, boolean> = { left: false, right: false };

  private serveTimer = 0;
  private serveDir = 1; // +1 = launch toward right, -1 = toward left
  private targetTimer = 0; // counts down to spawn (no target) or to despawn (target up)

  /** Capture the full simulation state for persistence across a restart. */
  serialize(): GameSnapshot {
    return {
      ball: { ...this.ball },
      extraBalls: this.extraBalls.map((b) => ({ ...b })),
      paddleY: { ...this.paddleY },
      paddleX: { ...this.paddleX },
      targetY: { ...this.targetY },
      score: { ...this.score },
      status: this.status,
      closing: this.closing,
      diamond: this.diamond,
      diamondBlock: this.diamondBlock ? { ...this.diamondBlock } : null,
      pinata: this.pinata,
      pinataObj: this.pinataObj
        ? { ...this.pinataObj, stuck: this.pinataObj.stuck.map((s) => ({ ...s })) }
        : null,
      winnerSide: this.winnerSide,
      lastHit: this.lastHit,
      target: this.target ? { ...this.target } : null,
      growHits: { ...this.growHits },
      shrinkHits: { ...this.shrinkHits },
      smashHits: { ...this.smashHits },
      slowTimer: this.slowTimer,
      serveTimer: this.serveTimer,
      serveDir: this.serveDir,
      targetTimer: this.targetTimer,
    };
  }

  /** Restore a previously serialized state (after a restart). Resumes frozen. */
  restore(s: GameSnapshot) {
    this.ball = { ...s.ball, spin: s.ball.spin ?? 0 };
    this.extraBalls = s.extraBalls.map((b) => ({ ...b, spin: b.spin ?? 0 }));
    this.paddleY = { ...s.paddleY };
    this.paddleX = { ...s.paddleX };
    this.targetY = { ...s.targetY };
    this.score = { ...s.score };
    this.status = s.status;
    this.closing = s.closing;
    this.diamond = s.diamond ?? false;
    this.diamondBlock = s.diamondBlock ? { ...s.diamondBlock } : null;
    this.pinata = s.pinata ?? false;
    this.pinataObj = s.pinataObj
      ? { ...s.pinataObj, stuck: (s.pinataObj.stuck ?? []).map((x) => ({ ...x })) }
      : null;
    this.winnerSide = s.winnerSide;
    this.lastHit = s.lastHit;
    this.target = s.target ? { ...s.target } : null;
    this.growHits = { ...s.growHits };
    this.shrinkHits = { ...s.shrinkHits };
    this.smashHits = { ...s.smashHits };
    this.slowTimer = s.slowTimer;
    this.serveTimer = s.serveTimer;
    this.serveDir = s.serveDir;
    this.targetTimer = s.targetTimer;
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

  /** Begin a fresh match (called once both spots are filled). */
  start() {
    this.score = { left: 0, right: 0 };
    this.winnerSide = null;
    this.paddleY = { left: COURT.h / 2, right: COURT.h / 2 };
    this.paddleX = { ...HOME_X }; // paddles always start at full width
    this.targetY = { left: COURT.h / 2, right: COURT.h / 2 };
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

  /** X of a paddle's hitting face — its inner edge, which moves with the paddle. */
  private faceX(side: Side): number {
    return side === 'left'
      ? this.paddleX.left + PADDLE.w / 2
      : this.paddleX.right - PADDLE.w / 2;
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
    this.clearPowerups();
  }

  private clearPowerups() {
    this.growHits = { left: 0, right: 0 };
    this.shrinkHits = { left: 0, right: 0 };
    this.smashHits = { left: 0, right: 0 };
    this.curveHits = { left: 0, right: 0 };
    this.slowTimer = 0;
    this.freezeTimer = { left: 0, right: 0 };
    this.blindTimer = { left: 0, right: 0 };
    this.mirrorTimer = { left: 0, right: 0 };
    this.ghostTimer = 0;
    this.tinyTimer = 0;
    this.bigBallTimer = 0;
    this.shielded = { left: false, right: false };
  }

  /** Current ball radius — enlarged while bigball power-up is active. */
  ballR(): number {
    return this.bigBallTimer > 0 ? BIG_BALL_R : BALL.r;
  }

  setTarget(side: Side, y: number) {
    const half = this.halfH(side);
    // Mirror power-up: invert the client's desired y so controls feel upside-down.
    const effective = this.mirrorTimer[side] > 0 ? COURT.h - y : y;
    this.targetY[side] = clamp(effective, half, COURT.h - half);
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
    // Shield intentionally persists — an unused shield stays for the next point.
    // Piñata: drop anything stuck and clear pending effects; the collector keeps drifting.
    if (this.pinataObj) this.pinataObj.stuck = [];
    this.pinataPendingSpawns = 0;
    this.pinataBurstPending = false;
  }

  private launch() {
    const speed = this.turbo ? BALL.speed * TURBO_SPEED_MULT : BALL.speed;
    const angle = (Math.random() * 2 - 1) * 0.3; // small vertical spread on serve
    this.ball.vx = this.serveDir * speed * Math.cos(angle);
    this.ball.vy = speed * Math.sin(angle);
  }

  tick(dt: number) {
    this.pinataBurstFlash = false; // a burst this tick (if any) sets it back to true
    // Paddles ease toward their target each tick; frozen paddles don't move.
    const maxStep = PADDLE.speed * dt;
    for (const side of ['left', 'right'] as Side[]) {
      if (this.freezeTimer[side] > 0) continue; // frozen — skip easing
      const diff = this.targetY[side] - this.paddleY[side];
      this.paddleY[side] += clamp(diff, -maxStep, maxStep);
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
      if (this.blindTimer[side] > 0) this.blindTimer[side] -= dt;
      if (this.mirrorTimer[side] > 0) this.mirrorTimer[side] -= dt;
    }
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

    const prevX = b.x;
    const prevY = b.y;
    b.x += b.vx * dt * scale;
    b.y += b.vy * dt * scale;

    const r = this.ballR();

    // Top / bottom walls
    if (b.y - r < 0) {
      b.y = r;
      b.vy = Math.abs(b.vy);
    } else if (b.y + r > COURT.h) {
      b.y = COURT.h - r;
      b.vy = -Math.abs(b.vy);
    }

    this.checkTargetHit(prevX, prevY, b);

    // Paddle collisions
    const leftFace = this.faceX('left');
    const rightFace = this.faceX('right');
    if (
      b.vx < 0 &&
      b.x - r <= leftFace &&
      b.x - r > leftFace - 40 &&
      Math.abs(b.y - this.paddleY.left) <= this.halfH('left') + r
    ) {
      this.bounce('left', b);
    } else if (
      b.vx > 0 &&
      b.x + r >= rightFace &&
      b.x + r < rightFace + 40 &&
      Math.abs(b.y - this.paddleY.right) <= this.halfH('right') + r
    ) {
      this.bounce('right', b);
    }

    // Diamond obstacle carom (diamond-hands mode); no-op when the mode is off.
    this.bounceDiamond(b);

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

  /** Force a random power-up onto the board now (the "/powerup" command). Live matches only. */
  forceTarget(): boolean {
    if (this.status !== 'playing') return false;
    this.placeTarget();
    return true;
  }

  // Drop a fresh random power-up target onto the board, replacing any current one.
  private placeTarget() {
    const margin = TARGET.r + 24; // keep it clear of the walls
    this.target = {
      x: COURT.w * 0.3 + Math.random() * COURT.w * 0.4, // central band, clear of paddles
      y: margin + Math.random() * (COURT.h - 2 * margin),
      kind: POWERUPS[Math.floor(Math.random() * POWERUPS.length)],
    };
    this.targetTimer = TARGET.life;
  }

  // Spawn or expire the power-up target on its own timer.
  private updateTargetTimer(dt: number) {
    this.targetTimer -= dt;
    if (!this.target) {
      if (this.targetTimer <= 0) this.placeTarget();
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

  private bounce(side: Side, b: Ball) {
    this.lastHit = side;
    const rel = clamp((b.y - this.paddleY[side]) / this.halfH(side), -1, 1);
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

    // Place the ball just off the (possibly moved) face so it can't re-trigger.
    b.x = side === 'left' ? this.faceX('left') + this.ballR() : this.faceX('right') - this.ballR();
    // Consume per-hit charges.
    if (this.growHits[side] > 0) this.growHits[side] -= 1;
    if (this.shrinkHits[side] > 0) this.shrinkHits[side] -= 1;
    if (this.smashHits[side] > 0) this.smashHits[side] -= 1;
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
    if (this.score[scorer] >= WIN_SCORE) {
      this.status = 'over';
      this.winnerSide = scorer;
      return true;
    }
    return false;
  }
}
