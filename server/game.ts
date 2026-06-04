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
  ball: Ball = { x: COURT.w / 2, y: COURT.h / 2, vx: 0, vy: 0 };
  extraBalls: Ball[] = []; // additional balls during a "multi" power-up
  paddleY: Record<Side, number> = { left: COURT.h / 2, right: COURT.h / 2 };
  paddleX: Record<Side, number> = { ...HOME_X }; // current paddle center X (slides in closing mode)
  targetY: Record<Side, number> = { left: COURT.h / 2, right: COURT.h / 2 };
  score = { left: 0, right: 0 };
  status: Status = 'waiting';
  closing = false; // "closing walls" mode armed; applies from the next match start
  winnerSide: Side | null = null;
  lastHit: Side | null = null; // side whose paddle last touched any ball (null until first hit)

  // Power-ups. A target floats on the board; bouncing the ball over it grants its kind.
  target: { x: number; y: number; kind: PowerupKind } | null = null;
  growHits: Record<Side, number> = { left: 0, right: 0 }; // taller paddle, per remaining hit
  shrinkHits: Record<Side, number> = { left: 0, right: 0 }; // shorter paddle, per remaining hit
  smashHits: Record<Side, number> = { left: 0, right: 0 }; // faster launch, per remaining hit
  slowTimer = 0; // seconds of slow-motion remaining (affects every ball)

  private serveTimer = 0;
  private serveDir = 1; // +1 = launch toward right, -1 = toward left
  private targetTimer = 0; // counts down to spawn (no target) or to despawn (target up)

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
    this.ball = { x: COURT.w / 2, y: COURT.h / 2, vx: 0, vy: 0 };
    this.extraBalls = [];
    this.lastHit = null;
    this.target = null;
    this.clearPowerups();
  }

  private clearPowerups() {
    this.growHits = { left: 0, right: 0 };
    this.shrinkHits = { left: 0, right: 0 };
    this.smashHits = { left: 0, right: 0 };
    this.slowTimer = 0;
  }

  setTarget(side: Side, y: number) {
    const half = this.halfH(side);
    this.targetY[side] = clamp(y, half, COURT.h - half);
  }

  private serve(dir: number) {
    this.serveDir = dir;
    this.serveTimer = SERVE_DELAY;
    this.ball = { x: COURT.w / 2, y: COURT.h / 2, vx: 0, vy: 0 };
    this.extraBalls = []; // multi-ball ends with the point
    this.slowTimer = 0; // slow-mo doesn't carry across serves
    this.lastHit = null; // neutral color until the next paddle touch
  }

  private launch() {
    const angle = (Math.random() * 2 - 1) * 0.3; // small vertical spread on serve
    this.ball.vx = this.serveDir * BALL.speed * Math.cos(angle);
    this.ball.vy = BALL.speed * Math.sin(angle);
  }

  tick(dt: number) {
    // Paddles always ease toward their target, capped by max paddle speed. This both
    // smooths movement and prevents a client from teleporting its paddle.
    const maxStep = PADDLE.speed * dt;
    for (const side of ['left', 'right'] as Side[]) {
      const diff = this.targetY[side] - this.paddleY[side];
      this.paddleY[side] += clamp(diff, -maxStep, maxStep);
    }

    if (this.status !== 'playing') return;

    if (this.serveTimer > 0) {
      this.serveTimer -= dt;
      if (this.serveTimer <= 0) this.launch();
      return;
    }

    if (this.slowTimer > 0) this.slowTimer -= dt;
    const scale = this.slowTimer > 0 ? SLOW_SCALE : 1;

    // Advance every ball; the first to leave the court decides the point.
    let scorer: Side | null = null;
    for (const b of [this.ball, ...this.extraBalls]) {
      const s = this.stepBall(b, dt, scale);
      if (s && !scorer) scorer = s;
    }

    this.updateTargetTimer(dt);

    if (scorer) this.award(scorer);
  }

  // Move one ball a tick: integrate, bounce off walls/paddles, claim the target, and
  // return the scoring side if it left the court (else null).
  private stepBall(b: Ball, dt: number, scale: number): Side | null {
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

    // Scoring (ball fully past a wall)
    if (b.x < -BALL.r) return 'right';
    if (b.x > COURT.w + BALL.r) return 'left';
    return null;
  }

  private nextTargetDelay(): number {
    return TARGET.minDelay + Math.random() * (TARGET.maxDelay - TARGET.minDelay);
  }

  // Spawn or expire the power-up target on its own timer.
  private updateTargetTimer(dt: number) {
    this.targetTimer -= dt;
    if (!this.target) {
      if (this.targetTimer <= 0) {
        const margin = TARGET.r + 24; // keep it clear of the walls
        this.target = {
          x: COURT.w * 0.3 + Math.random() * COURT.w * 0.4, // central band, clear of paddles
          y: margin + Math.random() * (COURT.h - 2 * margin),
          kind: POWERUPS[Math.floor(Math.random() * POWERUPS.length)],
        };
        this.targetTimer = TARGET.life;
      }
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
        break;
    }
  }

  private spawnExtraBall() {
    if (this.extraBalls.length >= MULTI_MAX) return;
    const src = this.ball;
    // Diverge from the primary ball: same speed, mirrored vertical component.
    const vy = src.vy !== 0 ? -src.vy : BALL.speed * 0.4;
    this.extraBalls.push({ x: src.x, y: src.y, vx: src.vx, vy });
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
    // Consume one of each per-hit charge that affects this side.
    if (this.growHits[side] > 0) this.growHits[side] -= 1;
    if (this.shrinkHits[side] > 0) this.shrinkHits[side] -= 1;
    if (this.smashHits[side] > 0) this.smashHits[side] -= 1;
  }

  private award(scorer: Side) {
    this.score[scorer] += 1;
    if (this.score[scorer] >= WIN_SCORE) {
      this.status = 'over';
      this.winnerSide = scorer;
      this.extraBalls = []; // tidy up any multi-balls when the match ends
    } else {
      // Serve toward the player who was just scored on.
      this.serve(scorer === 'left' ? 1 : -1);
    }
  }
}
