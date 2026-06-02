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
  Side,
  Status,
} from '../shared/types';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const LEFT_FACE = PADDLE.margin + PADDLE.w / 2; // x of the left paddle's hitting face
const RIGHT_FACE = COURT.w - PADDLE.margin - PADDLE.w / 2;
const HALF_H = PADDLE.h / 2;

export class Game {
  ball = { x: COURT.w / 2, y: COURT.h / 2, vx: 0, vy: 0 };
  paddleY: Record<Side, number> = { left: COURT.h / 2, right: COURT.h / 2 };
  targetY: Record<Side, number> = { left: COURT.h / 2, right: COURT.h / 2 };
  score = { left: 0, right: 0 };
  status: Status = 'waiting';
  winnerSide: Side | null = null;

  private serveTimer = 0;
  private serveDir = 1; // +1 = launch toward right, -1 = toward left

  /** Begin a fresh match (called once both spots are filled). */
  start() {
    this.score = { left: 0, right: 0 };
    this.winnerSide = null;
    this.paddleY = { left: COURT.h / 2, right: COURT.h / 2 };
    this.targetY = { left: COURT.h / 2, right: COURT.h / 2 };
    this.status = 'playing';
    this.serve(Math.random() < 0.5 ? 1 : -1);
  }

  /** Park the simulation back in the lobby (e.g. a player left mid-match). */
  toWaiting() {
    this.status = 'waiting';
    this.ball = { x: COURT.w / 2, y: COURT.h / 2, vx: 0, vy: 0 };
  }

  setTarget(side: Side, y: number) {
    this.targetY[side] = clamp(y, HALF_H, COURT.h - HALF_H);
  }

  private serve(dir: number) {
    this.serveDir = dir;
    this.serveTimer = SERVE_DELAY;
    this.ball = { x: COURT.w / 2, y: COURT.h / 2, vx: 0, vy: 0 };
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

    // Paddle collisions
    if (
      b.vx < 0 &&
      b.x - BALL.r <= LEFT_FACE &&
      b.x - BALL.r > LEFT_FACE - 40 &&
      Math.abs(b.y - this.paddleY.left) <= HALF_H + BALL.r
    ) {
      this.bounce('left');
    } else if (
      b.vx > 0 &&
      b.x + BALL.r >= RIGHT_FACE &&
      b.x + BALL.r < RIGHT_FACE + 40 &&
      Math.abs(b.y - this.paddleY.right) <= HALF_H + BALL.r
    ) {
      this.bounce('right');
    }

    // Scoring (ball fully past a wall)
    if (b.x < -BALL.r) this.award('right');
    else if (b.x > COURT.w + BALL.r) this.award('left');
  }

  private bounce(side: Side) {
    const b = this.ball;
    const rel = clamp((b.y - this.paddleY[side]) / HALF_H, -1, 1);
    const speed = Math.min(Math.hypot(b.vx, b.vy) * BALL.speedup, BALL.maxSpeed);
    const angle = rel * MAX_BOUNCE;
    const dir = side === 'left' ? 1 : -1;
    b.vx = dir * speed * Math.cos(angle);
    b.vy = speed * Math.sin(angle);
    b.x = side === 'left' ? LEFT_FACE + BALL.r : RIGHT_FACE - BALL.r;
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
