// Pure drawing: takes the latest server state and paints one frame. No game logic.

import { COURT, PADDLE, BALL, TARGET, PowerupKind, StateMsg } from '../shared/types';

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
  if (s.target) drawTarget(ctx, s.target.x, s.target.y, s.target.kind);

  // Paddles — X and height both come from the server, so "closing walls" mode and
  // the grow/shrink power-ups render correctly.
  ctx.fillStyle = s.paddles.left.color;
  drawPaddle(ctx, s.paddles.left.x, s.paddles.left.y, s.paddles.left.h);
  ctx.fillStyle = s.paddles.right.color;
  drawPaddle(ctx, s.paddles.right.x, s.paddles.right.y, s.paddles.right.h);

  // Ball(s) — colored by whichever paddle last hit them. Extra balls = multi power-up.
  for (const b of [s.ball, ...s.extraBalls]) {
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL.r, 0, Math.PI * 2);
    ctx.fill();
  }

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

// Each power-up target gets its own ring color + glyph so players can read at a glance
// what bouncing the ball over it will do.
const TARGET_STYLE: Record<PowerupKind, { stroke: string; fill: string }> = {
  grow: { stroke: '#ffd166', fill: 'rgba(255, 209, 102, 0.12)' }, // amber
  shrink: { stroke: '#5ad1e6', fill: 'rgba(90, 209, 230, 0.12)' }, // cyan
  smash: { stroke: '#ff6b3d', fill: 'rgba(255, 107, 61, 0.13)' }, // orange-red
  slow: { stroke: '#7aa2ff', fill: 'rgba(122, 162, 255, 0.13)' }, // blue
  multi: { stroke: '#c08cff', fill: 'rgba(192, 140, 255, 0.14)' }, // violet
};

function drawTarget(ctx: CanvasRenderingContext2D, x: number, y: number, kind: PowerupKind) {
  const style = TARGET_STYLE[kind];
  ctx.save();

  // Ring
  ctx.beginPath();
  ctx.arc(x, y, TARGET.r, 0, Math.PI * 2);
  ctx.fillStyle = style.fill;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = style.stroke;
  ctx.stroke();

  ctx.fillStyle = style.stroke;
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  GLYPHS[kind](ctx, x, y);

  ctx.restore();
}

// Glyphs are drawn centered on (x, y) within the ring (radius TARGET.r ≈ 24).
const GLYPHS: Record<PowerupKind, (ctx: CanvasRenderingContext2D, x: number, y: number) => void> = {
  // grow: a tall bar with outward chevrons → "your paddle gets longer"
  grow(ctx, x, y) {
    const bh = TARGET.r;
    ctx.fillRect(x - 2.5, y - bh / 2, 5, bh);
    const reach = bh / 2 + 5;
    ctx.beginPath();
    ctx.moveTo(x - 5, y - reach + 5);
    ctx.lineTo(x, y - reach);
    ctx.lineTo(x + 5, y - reach + 5);
    ctx.moveTo(x - 5, y + reach - 5);
    ctx.lineTo(x, y + reach);
    ctx.lineTo(x + 5, y + reach - 5);
    ctx.stroke();
  },
  // shrink: a short bar with inward chevrons → "their paddle gets shorter"
  shrink(ctx, x, y) {
    ctx.fillRect(x - 2.5, y - 6, 5, 12);
    const reach = 12;
    ctx.beginPath();
    ctx.moveTo(x - 5, y - reach);
    ctx.lineTo(x, y - reach + 5);
    ctx.lineTo(x + 5, y - reach);
    ctx.moveTo(x - 5, y + reach);
    ctx.lineTo(x, y + reach - 5);
    ctx.lineTo(x + 5, y + reach);
    ctx.stroke();
  },
  // smash: a lightning bolt → "faster, harder hits"
  smash(ctx, x, y) {
    ctx.beginPath();
    ctx.moveTo(x + 3, y - 13);
    ctx.lineTo(x - 7, y + 2);
    ctx.lineTo(x - 1, y + 2);
    ctx.lineTo(x - 4, y + 13);
    ctx.lineTo(x + 7, y - 3);
    ctx.lineTo(x + 1, y - 3);
    ctx.closePath();
    ctx.fill();
  },
  // slow: an hourglass → "the ball slows down"
  slow(ctx, x, y) {
    const w = 11;
    const h = 14;
    ctx.beginPath();
    ctx.moveTo(x - w / 2, y - h / 2);
    ctx.lineTo(x + w / 2, y - h / 2);
    ctx.lineTo(x, y);
    ctx.closePath();
    ctx.moveTo(x - w / 2, y + h / 2);
    ctx.lineTo(x + w / 2, y + h / 2);
    ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(x - w / 2 - 1, y - h / 2 - 3, w + 2, 2.5);
    ctx.fillRect(x - w / 2 - 1, y + h / 2 + 0.5, w + 2, 2.5);
  },
  // multi: two dots → "an extra ball"
  multi(ctx, x, y) {
    ctx.beginPath();
    ctx.arc(x - 6, y, 4, 0, Math.PI * 2);
    ctx.arc(x + 6, y, 4, 0, Math.PI * 2);
    ctx.fill();
  },
};

// --- Fatality animations ------------------------------------------------------
// render is otherwise stateless, so we latch each animation's start time here.
let fxStart = 0;
let fxKey = '';

const MOLTEN = '#ff5a2a';

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
  const banner = () => drawFatalityBanner(ctx, t);

  switch (fx.move) {
    case 'SCREEN_MELT':
      drawScreenMelt(ctx, s, fx, t, banner);
      break;
    case 'PADDLE_SPLIT':
      drawPaddleSplit(ctx, s, fx, t, banner);
      break;
    case 'FROST_SHATTER':
      drawFrostShatter(ctx, s, fx, t, banner);
      break;
  }
}

// Shared FATALITY banner, pulsing in.
function drawFatalityBanner(ctx: CanvasRenderingContext2D, t: number) {
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

// --- Fatality: "Screen Melt" -------------------------------------------------
// The ball flares into a fireball, streaks into the losing paddle, and that paddle
// melts down the court like wax.
function drawScreenMelt(
  ctx: CanvasRenderingContext2D,
  s: StateMsg,
  fx: { side: 'left' | 'right' },
  t: number,
  banner: () => void,
) {
  const loserSide = fx.side === 'left' ? 'right' : 'left';
  const winner = s.paddles[fx.side];
  const loser = s.paddles[loserSide];
  const loserX = loser.x;
  const winFaceX = fx.side === 'left' ? winner.x + PADDLE.w / 2 : winner.x - PADDLE.w / 2;

  const FLY = 0.55;
  const MELT = 1.4;

  ctx.fillStyle = `rgba(4,7,16,${Math.min(0.5, t * 1.2)})`;
  ctx.fillRect(0, 0, COURT.w, COURT.h);

  ctx.fillStyle = '#0b1020';
  ctx.fillRect(loserX - PADDLE.w / 2 - 2, loser.y - loser.h / 2 - 2, PADDLE.w + 4, loser.h + 4);

  if (t < FLY) {
    const p = t / FLY;
    const bx = winFaceX + (loserX - winFaceX) * p;
    const by = winner.y + (loser.y - winner.y) * p;
    drawFireball(ctx, bx, by, BALL.r + p * 8);
  }

  const m = Math.max(0, t - FLY);
  const mp = Math.min(1, m / MELT);
  const topY = loser.y - loser.h / 2;
  const solidH = Math.max(0, loser.h * (1 - mp));
  const frontY = topY + solidH;

  ctx.fillStyle = blend(loser.color, MOLTEN, mp * 0.7);
  ctx.fillRect(loserX - PADDLE.w / 2, topY, PADDLE.w, solidH);

  const cols = 4;
  ctx.fillStyle = MOLTEN;
  for (let i = 0; i < cols; i++) {
    const cx = loserX - PADDLE.w / 2 + (i + 0.5) * (PADDLE.w / cols);
    const lead = 0.5 + ((i * 7) % 5) / 5;
    const bottom = Math.min(COURT.h - 4, frontY + (COURT.h - frontY) * Math.min(1, mp * lead));
    ctx.fillRect(cx - 2, frontY, 4, Math.max(0, bottom - frontY));
    ctx.beginPath();
    ctx.arc(cx, bottom, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = MOLTEN;
  ctx.beginPath();
  ctx.ellipse(loserX, COURT.h - 4, 8 + mp * 60, 5 + mp * 4, 0, 0, Math.PI * 2);
  ctx.fill();

  banner();
}

// --- Fatality: "Paddle Split" ------------------------------------------------
// The losing paddle is dragged to center, split in half, and explodes outward.
function drawPaddleSplit(
  ctx: CanvasRenderingContext2D,
  s: StateMsg,
  fx: { side: 'left' | 'right' },
  t: number,
  banner: () => void,
) {
  const loserSide = fx.side === 'left' ? 'right' : 'left';
  const loser = s.paddles[loserSide];

  const DRAG = 0.5;
  const EXPLODE = 1.0;
  const centerX = COURT.w / 2;

  ctx.fillStyle = `rgba(4,7,16,${Math.min(0.5, t * 1.2)})`;
  ctx.fillRect(0, 0, COURT.w, COURT.h);

  // Erase original paddle
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(loser.x - PADDLE.w / 2 - 2, loser.y - loser.h / 2 - 2, PADDLE.w + 4, loser.h + 4);

  // Drag paddle to center
  const dragP = Math.min(1, t / DRAG);
  const px = loser.x + (centerX - loser.x) * dragP;
  const py = loser.y;

  if (t < DRAG) {
    ctx.fillStyle = loser.color;
    ctx.fillRect(px - PADDLE.w / 2, py - loser.h / 2, PADDLE.w, loser.h);
  } else {
    // Split and explode
    const ep = Math.min(1, (t - DRAG) / EXPLODE);
    const halfW = PADDLE.w / 2;
    const spread = ep * 120;
    const flyUp = ep * 80;

    ctx.fillStyle = blend(loser.color, '#ff5a2a', ep * 0.5);
    // Left half flies left and up
    ctx.fillRect(px - halfW - spread, py - loser.h / 2 - flyUp, halfW, loser.h);
    // Right half flies right and up
    ctx.fillRect(px + spread, py - loser.h / 2 - flyUp, halfW, loser.h);

    // Particles
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2 + ep * 0.5;
      const dist = ep * (40 + (i * 13) % 30);
      const px2 = px + Math.cos(angle) * dist;
      const py2 = py + Math.sin(angle) * dist - ep * 20;
      ctx.fillStyle = i % 2 === 0 ? loser.color : '#ff5a2a';
      ctx.beginPath();
      ctx.arc(px2, py2, 3 + ep * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  banner();
}

// --- Fatality: "Frost Shatter" (MK-inspired) ---------------------------------
// The losing paddle freezes, cracks appear, then shatters into ice shards.
function drawFrostShatter(
  ctx: CanvasRenderingContext2D,
  s: StateMsg,
  fx: { side: 'left' | 'right' },
  t: number,
  banner: () => void,
) {
  const loserSide = fx.side === 'left' ? 'right' : 'left';
  const loser = s.paddles[loserSide];
  const loserX = loser.x;

  const FREEZE = 0.6;
  const SHATTER = 1.0;
  const ICE = '#b0e0ff';

  ctx.fillStyle = `rgba(4,7,16,${Math.min(0.5, t * 1.2)})`;
  ctx.fillRect(0, 0, COURT.w, COURT.h);

  ctx.fillStyle = '#0b1020';
  ctx.fillRect(loserX - PADDLE.w / 2 - 2, loser.y - loser.h / 2 - 2, PADDLE.w + 4, loser.h + 4);

  if (t < FREEZE) {
    // Freeze phase: paddle turns icy
    const fp = Math.min(1, t / FREEZE);
    ctx.fillStyle = blend(loser.color, ICE, fp * 0.8);
    ctx.fillRect(loserX - PADDLE.w / 2, loser.y - loser.h / 2, PADDLE.w, loser.h);

    // Frost crystals forming
    ctx.strokeStyle = `rgba(176, 224, 255, ${fp * 0.6})`;
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 6; i++) {
      const cx = loserX + (i - 2.5) * (PADDLE.w / 5);
      const cy = loser.y - loser.h / 2 + ((i * 17) % loser.h);
      const size = 4 + fp * 8;
      ctx.beginPath();
      ctx.moveTo(cx, cy - size);
      ctx.lineTo(cx, cy + size);
      ctx.moveTo(cx - size, cy);
      ctx.lineTo(cx + size, cy);
      ctx.moveTo(cx - size * 0.7, cy - size * 0.7);
      ctx.lineTo(cx + size * 0.7, cy + size * 0.7);
      ctx.moveTo(cx + size * 0.7, cy - size * 0.7);
      ctx.lineTo(cx - size * 0.7, cy + size * 0.7);
      ctx.stroke();
    }
  } else {
    // Shatter phase
    const sp = Math.min(1, (t - FREEZE) / SHATTER);

    // Cracks
    ctx.strokeStyle = `rgba(255, 255, 255, ${1 - sp})`;
    ctx.lineWidth = 2;
    for (let i = 0; i < 8; i++) {
      const startX = loserX + (i - 3.5) * (PADDLE.w / 7);
      const startY = loser.y - loser.h / 2 + ((i * 11) % loser.h);
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      const endX = startX + (Math.random() - 0.5) * 60 * sp;
      const endY = startY + (Math.random() - 0.5) * 60 * sp;
      ctx.lineTo(endX, endY);
      ctx.stroke();
    }

    // Ice shard debris flying outward
    for (let i = 0; i < 15; i++) {
      const angle = (i / 15) * Math.PI * 2 + sp * 0.3;
      const dist = sp * (30 + (i * 19) % 50);
      const sx = loserX + Math.cos(angle) * dist;
      const sy = loser.y + Math.sin(angle) * dist - sp * 30;
      const alpha = Math.max(0, 1 - sp * 1.2);
      ctx.fillStyle = `rgba(176, 224, 255, ${alpha})`;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(sp * i);
      ctx.fillRect(-3, -8, 6, 16);
      ctx.restore();
    }

    // Remaining frozen paddle fading out
    ctx.fillStyle = `rgba(176, 224, 255, ${Math.max(0, 1 - sp * 1.5)})`;
    ctx.fillRect(loserX - PADDLE.w / 2, loser.y - loser.h / 2, PADDLE.w, loser.h);
  }

  banner();
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
