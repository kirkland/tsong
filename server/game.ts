// Authoritative game simulation. Knows nothing about networking, nicknames, or the
// DOM — it just owns the ball, paddle positions, score and match status. The Lobby
// drives it (start/setTarget) and reads its state to broadcast.

import {
  COURT,
  PADDLE,
  BALL,
  WIN_SCORE,
  MAX_BOUNCE,
  SERVE_DELAY,
  PADDLE_BOOST,
  POWERUP_HITS,
  TARGET,
  Side,
  Status,
} from '../shared/types';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const LEFT_FACE = PADDLE.margin + PADDLE.w / 2; // x of the left paddle's hitting face
const RIGHT_FACE = COURT.w - PADDLE.margin - PADDLE.w / 2;

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
  ball = { x: COURT.w / 2, y: COURT.h / 2, vx: 0, vy: 0 };
  paddleY: Record<Side, number> = { left: COURT.h / 2, right: COURT.h / 2 };
  targetY: Record<Side, number> = { left: COURT.h / 2, right: COURT.h / 2 };
  score = { left: 0, right: 0 };
  status: Status = 'waiting';
  winnerSide: Side | null = null;
  lastHit: Side | null = null; // side whose paddle last touched the ball (null until first hit)

  // "Longer paddle" power-up. A target floats on the board; bouncing the ball over it
  // grants the side that last hit it a few oversized hits.
  target: { x: number; y: number } | null = null;
  powerHits: Record<Side, number> = { left: 0, right: 0 }; // remaining boosted hits per side

  private serveTimer = 0;
  private serveDir = 1; // +1 = launch toward right, -1 = toward left
  private targetTimer = 0; // counts down to spawn (no target) or to despawn (target up)

  /** Current paddle half-height for a side — taller while its power-up is active. */
  halfH(side: Side): number {
    return (this.powerHits[side] > 0 ? PADDLE.h * PADDLE_BOOST : PADDLE.h) / 2;
  }

  /** Begin a fresh match (called once both spots are filled). */
  start() {
    this.score = { left: 0, right: 0 };
    this.winnerSide = null;
    this.paddleY = { left: COURT.h / 2, right: COURT.h / 2 };
    this.targetY = { left: COURT.h / 2, right: COURT.h / 2 };
    this.powerHits = { left: 0, right: 0 };
    this.target = null;
    this.targetTimer = this.nextTargetDelay();
    this.status = 'playing';
    this.serve(Math.random() < 0.5 ? 1 : -1);
  }

  /** Park the simulation back in the lobby (e.g. a player left mid-match). */
  toWaiting() {
    this.status = 'waiting';
    this.ball = { x: COURT.w / 2, y: COURT.h / 2, vx: 0, vy: 0 };
    this.lastHit = null;
    this.target = null;
    this.powerHits = { left: 0, right: 0 };
  }

  setTarget(side: Side, y: number) {
    const half = this.halfH(side);
    this.targetY[side] = clamp(y, half, COURT.h - half);
  }

  private serve(dir: number) {
    this.serveDir = dir;
    this.serveTimer = SERVE_DELAY;
    this.ball = { x: COURT.w / 2, y: COURT.h / 2, vx: 0, vy: 0 };
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

    const b = this.ball;
    const prevX = b.x;
    const prevY = b.y;
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // Top / bottom walls
    if (b.y - BALL.r < 0) {
      b.y = BALL.r;
      b.vy = Math.abs(b.vy);
    } else if (b.y + BALL.r > COURT.h) {
      b.y = COURT.h - BALL.r;
      b.vy = -Math.abs(b.vy);
    }

    this.updateTarget(dt, prevX, prevY);

    // Paddle collisions
    if (
      b.vx < 0 &&
      b.x - BALL.r <= LEFT_FACE &&
      b.x - BALL.r > LEFT_FACE - 40 &&
      Math.abs(b.y - this.paddleY.left) <= this.halfH('left') + BALL.r
    ) {
      this.bounce('left');
    } else if (
      b.vx > 0 &&
      b.x + BALL.r >= RIGHT_FACE &&
      b.x + BALL.r < RIGHT_FACE + 40 &&
      Math.abs(b.y - this.paddleY.right) <= this.halfH('right') + BALL.r
    ) {
      this.bounce('right');
    }

    // Scoring (ball fully past a wall)
    if (b.x < -BALL.r) this.award('right');
    else if (b.x > COURT.w + BALL.r) this.award('left');
  }

  private nextTargetDelay(): number {
    return TARGET.minDelay + Math.random() * (TARGET.maxDelay - TARGET.minDelay);
  }

  // Spawn/expire the power-up target and detect the ball sweeping across it.
  private updateTarget(dt: number, prevX: number, prevY: number) {
    this.targetTimer -= dt;

    if (!this.target) {
      if (this.targetTimer <= 0) {
        // Place it in the central band, clear of the paddles and walls.
        const margin = TARGET.r + 24;
        this.target = {
          x: COURT.w * 0.3 + Math.random() * COURT.w * 0.4,
          y: margin + Math.random() * (COURT.h - 2 * margin),
        };
        this.targetTimer = TARGET.life;
      }
      return;
    }

    // Active target: award it if the ball's path this tick crossed it (and the ball
    // has actually been struck, so a serve flying through doesn't gift a power-up).
    const hit =
      this.lastHit &&
      distToSegment(this.target.x, this.target.y, prevX, prevY, this.ball.x, this.ball.y) <=
        TARGET.r + BALL.r;
    if (hit) {
      this.powerHits[this.lastHit!] = POWERUP_HITS;
      this.target = null;
      this.targetTimer = this.nextTargetDelay();
    } else if (this.targetTimer <= 0) {
      this.target = null; // unclaimed; vanish and schedule the next one
      this.targetTimer = this.nextTargetDelay();
    }
  }

  private bounce(side: Side) {
    this.lastHit = side;
    const b = this.ball;
    const rel = clamp((b.y - this.paddleY[side]) / this.halfH(side), -1, 1);
    const speed = Math.hypot(b.vx, b.vy) * BALL.speedup;
    const angle = rel * MAX_BOUNCE;
    const dir = side === 'left' ? 1 : -1;
    b.vx = dir * speed * Math.cos(angle);
    b.vy = speed * Math.sin(angle);
    b.x = side === 'left' ? LEFT_FACE + BALL.r : RIGHT_FACE - BALL.r;
    if (this.powerHits[side] > 0) this.powerHits[side] -= 1; // consume one boosted hit
  }

  private award(scorer: Side) {
    this.score[scorer] += 1;
    if (this.score[scorer] >= WIN_SCORE) {
      this.status = 'over';
      this.winnerSide = scorer;
    } else {
      // Serve toward the player who was just scored on.
      this.serve(scorer === 'left' ? 1 : -1);
    }
  }
}
