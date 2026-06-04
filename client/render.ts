// Pure drawing: takes the latest server state and paints one frame. No game logic.

import { COURT, PADDLE, BALL, TARGET, StateMsg } from '../shared/types';

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

  // Power-up target (drawn under the ball/paddles so they read on top)
  if (s.target) drawTarget(ctx, s.target.x, s.target.y);

  // Paddles — height comes from the server (taller while powered up)
  ctx.fillStyle = s.paddles.left.color;
  drawPaddle(ctx, PADDLE.margin, s.paddles.left.y, s.paddles.left.h);
  ctx.fillStyle = s.paddles.right.color;
  drawPaddle(ctx, COURT.w - PADDLE.margin, s.paddles.right.y, s.paddles.right.h);

  // Ball — colored by whichever paddle last hit it
  ctx.fillStyle = s.ball.color;
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

  // Finishing move plays over the top of the normal frame.
  if (s.fatality) {
    ctx.save();
    drawFatality(ctx, s, s.fatality);
    ctx.restore();
  } else {
    fxStart = 0;
    fxKey = '';
  }
}

function drawPaddle(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.fillRect(cx - PADDLE.w / 2, cy - h / 2, PADDLE.w, h);
}

// The "longer paddle" power-up badge: an amber ring around a tall bar with up/down
// chevrons, signaling that hitting the ball over it stretches your paddle.
function drawTarget(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const amber = '#ffd166';
  ctx.save();

  // Ring
  ctx.beginPath();
  ctx.arc(x, y, TARGET.r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 209, 102, 0.12)';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = amber;
  ctx.stroke();

  // Tall bar (a mini elongated paddle)
  const bw = 5;
  const bh = TARGET.r;
  ctx.fillStyle = amber;
  ctx.fillRect(x - bw / 2, y - bh / 2, bw, bh);

  // Up / down chevrons hinting "grow taller"
  const reach = bh / 2 + 5;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x - 5, y - reach + 5);
  ctx.lineTo(x, y - reach);
  ctx.lineTo(x + 5, y - reach + 5);
  ctx.moveTo(x - 5, y + reach - 5);
  ctx.lineTo(x, y + reach);
  ctx.lineTo(x + 5, y + reach - 5);
  ctx.stroke();

  ctx.restore();
}

// --- Fatality: "Screen Melt" -------------------------------------------------
// The ball flares into a fireball, streaks into the losing paddle, and that paddle
// melts down the court like wax while a FATALITY banner pulses over a darkened court.
// render is otherwise stateless, so we latch the animation's start time here.
let fxStart = 0;
let fxKey = '';

const MOLTEN = '#ff5a2a';
const FLY = 0.55; // seconds the fireball takes to cross to the loser
const MELT = 1.4; // seconds for the paddle to fully melt

function drawFatality(
  ctx: CanvasRenderingContext2D,
  s: StateMsg,
  fx: { side: 'left' | 'right'; move: string },
) {
  const now = performance.now();
  const key = fx.side + fx.move;
  if (fxKey !== key) {
    fxStart = now;
    fxKey = key;
  }
  const t = (now - fxStart) / 1000;

  const loserSide = fx.side === 'left' ? 'right' : 'left';
  const loser = s.paddles[loserSide];
  const winner = s.paddles[fx.side];
  const loserX = loserSide === 'left' ? PADDLE.margin : COURT.w - PADDLE.margin;
  const winFaceX =
    fx.side === 'left' ? PADDLE.margin + PADDLE.w / 2 : COURT.w - PADDLE.margin - PADDLE.w / 2;

  // 1) Dim the court.
  ctx.fillStyle = `rgba(4,7,16,${Math.min(0.5, t * 1.2)})`;
  ctx.fillRect(0, 0, COURT.w, COURT.h);

  // Erase the loser's intact paddle so we can render the melting version ourselves.
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(loserX - PADDLE.w / 2 - 2, loser.y - HALF_H - 2, PADDLE.w + 4, PADDLE.h + 4);

  // 2) Fireball streaks from the winner's face into the loser.
  if (t < FLY) {
    const p = t / FLY;
    const bx = winFaceX + (loserX - winFaceX) * p;
    const by = winner.y + (loser.y - winner.y) * p;
    drawFireball(ctx, bx, by, BALL.r + p * 8);
  }

  // 3) The loser melts.
  const m = Math.max(0, t - FLY);
  const mp = Math.min(1, m / MELT); // 0 → 1 melt progress
  const topY = loser.y - HALF_H;
  const solidH = Math.max(0, PADDLE.h * (1 - mp));
  const frontY = topY + solidH;

  // Remaining solid chunk, tinting molten as it goes.
  ctx.fillStyle = blend(loser.color, MOLTEN, mp * 0.7);
  ctx.fillRect(loserX - PADDLE.w / 2, topY, PADDLE.w, solidH);

  // Drips running down to the floor, each at its own pace.
  const cols = 4;
  ctx.fillStyle = MOLTEN;
  for (let i = 0; i < cols; i++) {
    const cx = loserX - PADDLE.w / 2 + (i + 0.5) * (PADDLE.w / cols);
    const lead = 0.5 + ((i * 7) % 5) / 5; // 0.5–1.5, deterministic spread
    const bottom = Math.min(COURT.h - 4, frontY + (COURT.h - frontY) * Math.min(1, mp * lead));
    ctx.fillRect(cx - 2, frontY, 4, Math.max(0, bottom - frontY));
    ctx.beginPath();
    ctx.arc(cx, bottom, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Puddle pooling at the base.
  ctx.fillStyle = MOLTEN;
  ctx.beginPath();
  ctx.ellipse(loserX, COURT.h - 4, 8 + mp * 60, 5 + mp * 4, 0, 0, Math.PI * 2);
  ctx.fill();

  // 4) FATALITY banner, pulsing in.
  if (t > 0.3) {
    const a = Math.min(1, (t - 0.3) * 3);
    const pulse = 1 + Math.sin(t * 8) * 0.02;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(COURT.w / 2, COURT.h / 2);
    ctx.scale(pulse, pulse);
    ctx.fillStyle = '#ff2b2b';
    ctx.font = 'bold 64px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#ff2b2b';
    ctx.shadowBlur = 24;
    ctx.fillText('FATALITY', 0, 0);
    ctx.restore();
  }
}

function drawFireball(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  const g = ctx.createRadialGradient(x, y, 1, x, y, r * 1.6);
  g.addColorStop(0, '#fff7d6');
  g.addColorStop(0.4, '#ffb547');
  g.addColorStop(1, 'rgba(255,80,20,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * 1.6, 0, Math.PI * 2);
  ctx.fill();
}

// Linearly blend two hex colors; t=0 → a, t=1 → b.
function blend(a: string, b: string, t: number): string {
  const pa = toRgb(a);
  const pb = toRgb(b);
  const c = (i: number) => Math.round(pa[i] + (pb[i] - pa[i]) * t);
  return `rgb(${c(0)},${c(1)},${c(2)})`;
}

function toRgb(h: string): [number, number, number] {
  const n = h.replace('#', '');
  const v = n.length === 3 ? n.split('').map((c) => c + c).join('') : n;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}
