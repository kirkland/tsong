// Pure drawing: takes the latest server state and paints one frame. No game logic.

import { COURT, PADDLE, BALL, StateMsg } from '../shared/types';

const HALF_H = PADDLE.h / 2;

export function draw(ctx: CanvasRenderingContext2D, s: StateMsg) {
  // Court
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(0, 0, COURT.w, COURT.h);

  // Center line
  ctx.strokeStyle = '#222e4a';
  ctx.lineWidth = 3;
  ctx.setLineDash([10, 14]);
  ctx.beginPath();
  ctx.moveTo(COURT.w / 2, 0);
  ctx.lineTo(COURT.w / 2, COURT.h);
  ctx.stroke();
  ctx.setLineDash([]);

  // Paddles
  ctx.fillStyle = '#e8eefc';
  drawPaddle(ctx, PADDLE.margin, s.paddles.left.y);
  drawPaddle(ctx, COURT.w - PADDLE.margin, s.paddles.right.y);

  // Ball
  ctx.beginPath();
  ctx.arc(s.ball.x, s.ball.y, BALL.r, 0, Math.PI * 2);
  ctx.fill();

  // Score
  ctx.fillStyle = '#7da2ff';
  ctx.font = 'bold 44px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(String(s.score.left), COURT.w / 2 - 70, 18);
  ctx.fillText(String(s.score.right), COURT.w / 2 + 70, 18);

  // Current ball speed
  ctx.fillStyle = '#6b7796';
  ctx.font = '13px ui-monospace, monospace';
  ctx.fillText(`${Math.round(s.ballSpeed)}`, COURT.w / 2, 22);

  // Player names along the bottom
  ctx.fillStyle = '#9fb0d8';
  ctx.font = '16px system-ui, sans-serif';
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.fillText(s.paddles.left.name ?? '— open —', 16, COURT.h - 12);
  ctx.textAlign = 'right';
  ctx.fillText(s.paddles.right.name ?? '— open —', COURT.w - 16, COURT.h - 12);
}

function drawPaddle(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  ctx.fillRect(cx - PADDLE.w / 2, cy - HALF_H, PADDLE.w, PADDLE.h);
}
