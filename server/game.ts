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
  CURVE_SPIN,
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
    this.serve(Math.random() < 0.5 ? 1 : -1);
  }

  /** Arm / disarm closing-walls mode. Disarming snaps paddles back to full width. */
  setClosing(on: boolean) {
    this.closing = on;
    if (!on) this.paddleX = { ...HOME_X };
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
    this.shielded = { left: false, right: false };
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
    this.curveHits = { left: 0, right: 0 };
    // Shield intentionally persists — an unused shield stays for the next point.
  }

  private launch() {
    const angle = (Math.random() * 2 - 1) * 0.3; // small vertical spread on serve
    this.ball.vx = this.serveDir * BALL.speed * Math.cos(angle);
    this.ball.vy = BALL.speed * Math.sin(angle);
  }

  tick(dt: number) {
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

    if (this.serveTimer > 0) {
      this.serveTimer -= dt;
      if (this.serveTimer <= 0) this.launch();
      return;
    }

    if (this.slowTimer > 0) this.slowTimer -= dt;
    if (this.ghostTimer > 0) this.ghostTimer -= dt;
    if (this.tinyTimer > 0) this.tinyTimer -= dt;
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
      if (scorer) lastScorer = scorer; // remember who'd score, but don't award yet
      else survivors.push(b);
    }

    this.updateTargetTimer(dt);

    // A "multi" power-up claimed this tick appends new balls past extraBalls' original
    // length; keep them alongside the survivors (otherwise the new ball is discarded).
    const spawned = this.extraBalls.slice(prevExtras);
    const live = [...survivors, ...spawned];

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
  // return the scoring side if it left the court (else null).
  private stepBall(b: Ball, dt: number, scale: number): Side | null {
    // Spin (curve power-up): rotate velocity direction and decay.
    if (b.spin !== 0) {
      const speed = Math.hypot(b.vx, b.vy);
      const angle = Math.atan2(b.vy, b.vx) + b.spin * dt;
      b.vx = speed * Math.cos(angle);
      b.vy = speed * Math.sin(angle);
      b.spin *= Math.exp(-2 * dt); // ~0.5 s half-life
      if (Math.abs(b.spin) < 0.01) b.spin = 0;
    }

    const prevX = b.x;
    const prevY = b.y;
    b.x += b.vx * dt * scale;
    b.y += b.vy * dt * scale;

    // Top / bottom walls
    if (b.y - BALL.r < 0) {
      b.y = BALL.r;
      b.vy = Math.abs(b.vy);
    } else if (b.y + BALL.r > COURT.h) {
      b.y = COURT.h - BALL.r;
      b.vy = -Math.abs(b.vy);
    }

    this.checkTargetHit(prevX, prevY, b);

    // Paddle collisions
    const leftFace = this.faceX('left');
    const rightFace = this.faceX('right');
    if (
      b.vx < 0 &&
      b.x - BALL.r <= leftFace &&
      b.x - BALL.r > leftFace - 40 &&
      Math.abs(b.y - this.paddleY.left) <= this.halfH('left') + BALL.r
    ) {
      this.bounce('left', b);
    } else if (
      b.vx > 0 &&
      b.x + BALL.r >= rightFace &&
      b.x + BALL.r < rightFace + 40 &&
      Math.abs(b.y - this.paddleY.right) <= this.halfH('right') + BALL.r
    ) {
      this.bounce('right', b);
    }

    // Scoring — check shield before awarding the point.
    if (b.x < -BALL.r) {
      if (this.shielded.left) {
        // Shield absorbs the goal: bounce the ball back and clear the shield.
        b.x = BALL.r;
        b.vx = Math.abs(b.vx);
        b.spin = 0;
        this.shielded.left = false;
        return null;
      }
      return 'right';
    }
    if (b.x > COURT.w + BALL.r) {
      if (this.shielded.right) {
        b.x = COURT.w - BALL.r;
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
    if (d > TARGET.r + BALL.r) return;
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
    let speed = Math.hypot(b.vx, b.vy) * BALL.speedup;
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
    b.x = side === 'left' ? this.faceX('left') + BALL.r : this.faceX('right') - BALL.r;
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
