// Authoritative game simulation. Knows nothing about networking, nicknames, or the
// DOM — it just owns the ball, paddle positions, score and match status. The Lobby
// drives it (start/setTarget) and reads its state to broadcast.

import {
  COURT,
  PADDLE,
  BALL,
  CLOSING,
  WIN_SCORE,
  MAX_BOUNCE,
  SERVE_DELAY,
  Side,
  Status,
} from '../shared/types';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Default paddle center X for each side (closing mode slides these toward center).
const HOME_X: Record<Side, number> = {
  left: PADDLE.margin,
  right: COURT.w - PADDLE.margin,
};
const HALF_H = PADDLE.h / 2;
// Furthest each paddle center may travel inward before the faces hit the min gap.
const MAX_INSET = (COURT.w - CLOSING.minGap) / 2 - PADDLE.margin - PADDLE.w / 2;

export class Game {
  ball = { x: COURT.w / 2, y: COURT.h / 2, vx: 0, vy: 0 };
  paddleY: Record<Side, number> = { left: COURT.h / 2, right: COURT.h / 2 };
  paddleX: Record<Side, number> = { ...HOME_X }; // current paddle center X (slides in closing mode)
  targetY: Record<Side, number> = { left: COURT.h / 2, right: COURT.h / 2 };
  score = { left: 0, right: 0 };
  status: Status = 'waiting';
  closing = false; // "closing walls" mode armed; applies from the next match start
  winnerSide: Side | null = null;
  lastHit: Side | null = null; // side whose paddle last touched the ball (null until first hit)

  private serveTimer = 0;
  private serveDir = 1; // +1 = launch toward right, -1 = toward left

  /** Begin a fresh match (called once both spots are filled). */
  start() {
    this.score = { left: 0, right: 0 };
    this.winnerSide = null;
    this.paddleY = { left: COURT.h / 2, right: COURT.h / 2 };
    this.paddleX = { ...HOME_X }; // paddles always start at full width
    this.targetY = { left: COURT.h / 2, right: COURT.h / 2 };
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
    this.lastHit = null;
  }

  setTarget(side: Side, y: number) {
    this.targetY[side] = clamp(y, HALF_H, COURT.h - HALF_H);
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
    const leftFace = this.faceX('left');
    const rightFace = this.faceX('right');
    if (
      b.vx < 0 &&
      b.x - BALL.r <= leftFace &&
      b.x - BALL.r > leftFace - 40 &&
      Math.abs(b.y - this.paddleY.left) <= HALF_H + BALL.r
    ) {
      this.bounce('left');
    } else if (
      b.vx > 0 &&
      b.x + BALL.r >= rightFace &&
      b.x + BALL.r < rightFace + 40 &&
      Math.abs(b.y - this.paddleY.right) <= HALF_H + BALL.r
    ) {
      this.bounce('right');
    }

    // Scoring (ball fully past a wall)
    if (b.x < -BALL.r) this.award('right');
    else if (b.x > COURT.w + BALL.r) this.award('left');
  }

  private bounce(side: Side) {
    this.lastHit = side;
    const b = this.ball;
    const rel = clamp((b.y - this.paddleY[side]) / HALF_H, -1, 1);
    const speed = Math.hypot(b.vx, b.vy) * BALL.speedup;
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
