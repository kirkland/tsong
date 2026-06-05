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
// The losing paddle is dragged to center with a force-pull effect, cracks appear,
// then it splits in half and explodes outward with shrapnel, sparks, and shockwave.
function drawPaddleSplit(
  ctx: CanvasRenderingContext2D,
  s: StateMsg,
  fx: { side: 'left' | 'right' },
  t: number,
  banner: () => void,
) {
  const loserSide = fx.side === 'left' ? 'right' : 'left';
  const loser = s.paddles[loserSide];
  const winner = s.paddles[fx.side];

  const DRAG = 0.5;
  const CRACK = 0.25;
  const EXPLODE = 1.2;
  const centerX = COURT.w / 2;
  const centerY = COURT.h / 2;

  // --- Background dim with slight red tint during explosion ---
  const explosionActive = t > DRAG + CRACK;
  const ep = explosionActive ? Math.min(1, (t - DRAG - CRACK) / EXPLODE) : 0;
  const dimR = explosionActive ? 4 + Math.floor(ep * 20) : 4;
  ctx.fillStyle = `rgba(${dimR},7,16,${Math.min(0.55, t * 1.2)})`;
  ctx.fillRect(0, 0, COURT.w, COURT.h);

  // --- Erase original paddle position ---
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(loser.x - PADDLE.w / 2 - 2, loser.y - loser.h / 2 - 2, PADDLE.w + 4, loser.h + 4);

  // --- Easing: elastic pull for drag ---
  const rawDragP = Math.min(1, t / DRAG);
  const dragP = 1 - Math.pow(1 - rawDragP, 3); // ease-out cubic
  const px = loser.x + (centerX - loser.x) * dragP;
  const py = loser.y + (centerY - loser.y) * dragP * 0.3; // slight vertical pull toward center

  // --- Phase 1: Drag with force-pull trail ---
  if (t < DRAG + CRACK) {
    // Draw energy tether from winner to dragged paddle
    const winFaceX = fx.side === 'left' ? winner.x + PADDLE.w / 2 : winner.x - PADDLE.w / 2;
    const tethAlpha = 0.3 + 0.4 * rawDragP;
    const grad = ctx.createLinearGradient(winFaceX, winner.y, px, py);
    grad.addColorStop(0, `rgba(255,90,42,${tethAlpha})`);
    grad.addColorStop(0.5, `rgba(255,200,80,${tethAlpha * 0.6})`);
    grad.addColorStop(1, `rgba(255,90,42,${tethAlpha * 0.3})`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2 + rawDragP * 2;
    ctx.beginPath();
    // Slightly wavy tether
    const midX = (winFaceX + px) / 2;
    const midY = (winner.y + py) / 2 - Math.sin(t * 12) * 8 * (1 - rawDragP);
    ctx.moveTo(winFaceX, winner.y);
    ctx.quadraticCurveTo(midX, midY, px, py);
    ctx.stroke();

    // Ghost trail (afterimages during drag)
    if (rawDragP > 0.1 && rawDragP < 1) {
      for (let g = 0; g < 3; g++) {
        const gp = rawDragP - g * 0.08;
        if (gp < 0) continue;
        const gx = loser.x + (centerX - loser.x) * (1 - Math.pow(1 - gp, 3));
        const gy = loser.y + (centerY - loser.y) * gp * 0.3;
        ctx.fillStyle = `rgba(255,90,42,${0.12 - g * 0.03})`;
        ctx.fillRect(gx - PADDLE.w / 2, gy - loser.h / 2, PADDLE.w, loser.h);
      }
    }

    // Paddle shake increases as it approaches center
    const shake = t > DRAG ? Math.sin(t * 60) * 3 * Math.min(1, (t - DRAG) / CRACK) : 0;

    // Draw paddle
    ctx.fillStyle = loser.color;
    ctx.fillRect(px - PADDLE.w / 2 + shake, py - loser.h / 2, PADDLE.w, loser.h);

    // --- Phase 1b: Crack lines appear ---
    if (t > DRAG) {
      const cp = Math.min(1, (t - DRAG) / CRACK);
      ctx.strokeStyle = `rgba(255,200,80,${cp})`;
      ctx.lineWidth = 1.5 + cp;

      // Main vertical crack down the center
      const crackH = loser.h * cp;
      ctx.beginPath();
      ctx.moveTo(px + shake, py - crackH / 2);
      // Jagged line
      const segs = 6;
      for (let i = 1; i <= segs; i++) {
        const sy = py - crackH / 2 + (crackH * i) / segs;
        const sx = px + shake + ((i % 2 === 0 ? 1 : -1) * (2 + Math.random() * 2));
        ctx.lineTo(sx, sy);
      }
      ctx.stroke();

      // Secondary diagonal cracks
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(255,160,40,${cp * 0.6})`;
      for (let c = 0; c < 3; c++) {
        const cy = py - loser.h / 4 + (c * loser.h) / 4;
        const cLen = (PADDLE.w / 2) * cp * (0.4 + (c * 3) % 2 * 0.3);
        ctx.beginPath();
        ctx.moveTo(px + shake, cy);
        ctx.lineTo(px + shake + (c % 2 === 0 ? cLen : -cLen), cy + cp * 4);
        ctx.stroke();
      }

      // Glow from cracks
      const crackGlow = ctx.createRadialGradient(px, py, 0, px, py, PADDLE.w * 2);
      crackGlow.addColorStop(0, `rgba(255,200,80,${cp * 0.15})`);
      crackGlow.addColorStop(1, 'rgba(255,200,80,0)');
      ctx.fillStyle = crackGlow;
      ctx.beginPath();
      ctx.arc(px, py, PADDLE.w * 2, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // --- Phase 2: Split & Explode ---
    const halfH = loser.h / 2;
    const spread = ep * 160;
    const flyUp = ep * ep * 100; // accelerating upward
    const flyDown = ep * ep * 60;
    const rotation = ep * Math.PI * 0.8; // halves rotate as they fly
    const fadeOut = Math.max(0, 1 - ep * 0.6);

    // --- Shockwave ring ---
    if (ep < 0.6) {
      const ringR = ep * 200;
      const ringAlpha = 0.6 * (1 - ep / 0.6);
      ctx.strokeStyle = `rgba(255,200,80,${ringAlpha})`;
      ctx.lineWidth = 3 * (1 - ep / 0.6);
      ctx.beginPath();
      ctx.arc(px, py, ringR, 0, Math.PI * 2);
      ctx.stroke();

      // Second delayed ring
      if (ep > 0.1) {
        const ring2R = (ep - 0.1) * 180;
        const ring2Alpha = 0.3 * (1 - ep / 0.6);
        ctx.strokeStyle = `rgba(255,90,42,${ring2Alpha})`;
        ctx.lineWidth = 2 * (1 - ep / 0.6);
        ctx.beginPath();
        ctx.arc(px, py, ring2R, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // --- Central flash at moment of split ---
    if (ep < 0.15) {
      const flashP = ep / 0.15;
      const flashR = 20 + flashP * 60;
      const flashGrad = ctx.createRadialGradient(px, py, 0, px, py, flashR);
      flashGrad.addColorStop(0, `rgba(255,255,240,${0.9 * (1 - flashP)})`);
      flashGrad.addColorStop(0.4, `rgba(255,200,80,${0.5 * (1 - flashP)})`);
      flashGrad.addColorStop(1, 'rgba(255,90,42,0)');
      ctx.fillStyle = flashGrad;
      ctx.beginPath();
      ctx.arc(px, py, flashR, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- Flying halves with rotation ---
    ctx.save();
    // Top half flies left and up
    ctx.save();
    ctx.translate(px - spread, py - flyUp);
    ctx.rotate(-rotation);
    ctx.globalAlpha = fadeOut;
    ctx.fillStyle = blend(loser.color, '#ff5a2a', ep * 0.6);
    ctx.fillRect(-PADDLE.w / 2, -halfH, PADDLE.w, halfH);
    // Ember edge glow on half
    ctx.fillStyle = `rgba(255,200,80,${0.3 * fadeOut})`;
    ctx.fillRect(-PADDLE.w / 2, -2, PADDLE.w, 4);
    ctx.restore();

    // Bottom half flies right and down
    ctx.save();
    ctx.translate(px + spread, py + flyDown);
    ctx.rotate(rotation);
    ctx.globalAlpha = fadeOut;
    ctx.fillStyle = blend(loser.color, '#ff5a2a', ep * 0.6);
    ctx.fillRect(-PADDLE.w / 2, 0, PADDLE.w, halfH);
    ctx.fillStyle = `rgba(255,200,80,${0.3 * fadeOut})`;
    ctx.fillRect(-PADDLE.w / 2, -2, PADDLE.w, 4);
    ctx.restore();
    ctx.restore();

    // --- Shrapnel chunks ---
    const shrapnelCount = 8;
    for (let i = 0; i < shrapnelCount; i++) {
      const angle = (i / shrapnelCount) * Math.PI * 2 + 0.3;
      const speed = 60 + ((i * 17) % 11) * 8;
      const dist = ep * speed;
      const sx = px + Math.cos(angle) * dist;
      const sy = py + Math.sin(angle) * dist + ep * ep * 30; // gravity
      const size = 2 + ((i * 7) % 4);
      const alpha = Math.max(0, 1 - ep * 1.2);

      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(angle + ep * 4);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = i % 3 === 0 ? '#ff5a2a' : blend(loser.color, '#ff8844', 0.5);
      ctx.fillRect(-size / 2, -size / 2, size, size * 0.6);
      ctx.restore();
    }

    // --- Spark particles (smaller, faster, with trails) ---
    const sparkCount = 18;
    for (let i = 0; i < sparkCount; i++) {
      const angle = (i / sparkCount) * Math.PI * 2 + ep * 0.7;
      const speed = 40 + ((i * 13) % 30) + ((i * 7) % 20);
      const dist = ep * speed;
      const sx = px + Math.cos(angle) * dist;
      const sy = py + Math.sin(angle) * dist - ep * (15 + (i % 5) * 4);
      const sparkAlpha = Math.max(0, 1 - ep * 1.1) * (0.5 + ((i * 3) % 5) / 10);
      const sparkR = 1.5 + ((i * 11) % 3);

      // Spark trail
      if (ep > 0.05) {
        const trailDist = (ep - 0.04) * speed * 0.7;
        const tx = px + Math.cos(angle) * trailDist;
        const ty = py + Math.sin(angle) * trailDist - (ep - 0.04) * (15 + (i % 5) * 4);
        ctx.strokeStyle = `rgba(255,200,80,${sparkAlpha * 0.3})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(sx, sy);
        ctx.stroke();
      }

      ctx.fillStyle =
        i % 3 === 0
          ? `rgba(255,255,200,${sparkAlpha})`
          : i % 3 === 1
            ? `rgba(255,160,40,${sparkAlpha})`
            : `rgba(255,90,42,${sparkAlpha})`;
      ctx.beginPath();
      ctx.arc(sx, sy, sparkR, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- Floating embers (slow, drifting upward) ---
    const emberCount = 6;
    for (let i = 0; i < emberCount; i++) {
      const drift = Math.sin(t * 3 + i * 2) * 20;
      const rise = ep * (30 + i * 15);
      const ex = px - 40 + ((i * 37) % 80) + drift;
      const ey = py - rise;
      const emberAlpha = Math.max(0, ep - 0.2) * (1 - ep) * 2;
      const emberR = 1 + ((i * 3) % 2);

      ctx.fillStyle = `rgba(255,180,60,${emberAlpha})`;
      ctx.beginPath();
      ctx.arc(ex, ey, emberR, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- Lingering smoke wisps at center ---
    if (ep > 0.3) {
      const smokeP = (ep - 0.3) / 0.7;
      for (let i = 0; i < 3; i++) {
        const smokeX = px + Math.sin(t * 2 + i * 2.5) * (10 + i * 8);
        const smokeY = py - smokeP * (20 + i * 15);
        const smokeR = 8 + smokeP * 15 + i * 5;
        const smokeAlpha = 0.08 * (1 - smokeP);
        ctx.fillStyle = `rgba(180,160,140,${smokeAlpha})`;
        ctx.beginPath();
        ctx.arc(smokeX, smokeY, smokeR, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // --- Scorch mark on court ---
    const scorchAlpha = Math.min(0.25, ep * 0.3);
    const scorchGrad = ctx.createRadialGradient(px, py, 0, px, py, 40 + ep * 20);
    scorchGrad.addColorStop(0, `rgba(40,20,10,${scorchAlpha})`);
    scorchGrad.addColorStop(0.6, `rgba(30,15,5,${scorchAlpha * 0.5})`);
    scorchGrad.addColorStop(1, 'rgba(20,10,0,0)');
    ctx.fillStyle = scorchGrad;
    ctx.beginPath();
    ctx.ellipse(px, py, 50 + ep * 20, 30 + ep * 10, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  banner();
}

// --- Fatality: "Frost Shatter" (MK-inspired) ---------------------------------
// A freezing wave rolls over the losing paddle, ice crystallizes across its surface,
// frost cracks spiderweb outward, then it shatters into spinning ice shards with
// mist, sparkle, and frozen debris.
function drawFrostShatter(
  ctx: CanvasRenderingContext2D,
  s: StateMsg,
  fx: { side: 'left' | 'right' },
  t: number,
  banner: () => void,
) {
  const loserSide = fx.side === 'left' ? 'right' : 'left';
  const loser = s.paddles[loserSide];
  const winner = s.paddles[fx.side];
  const loserX = loser.x;

  const FREEZE = 0.6;
  const CRACK = 0.3;
  const SHATTER = 1.2;
  const ICE = '#b0e0ff';
  const ICE_BRIGHT = '#e0f4ff';
  const ICE_CORE = '#88ccee';
  const FROST_WHITE = '#ddeeff';

  // --- Background dim with cold blue tint ---
  const shatterActive = t > FREEZE + CRACK;
  const sp = shatterActive ? Math.min(1, (t - FREEZE - CRACK) / SHATTER) : 0;
  const dimB = shatterActive ? 16 + Math.floor(sp * 12) : 16;
  ctx.fillStyle = `rgba(4,7,${dimB},${Math.min(0.55, t * 1.2)})`;
  ctx.fillRect(0, 0, COURT.w, COURT.h);

  // --- Erase original paddle ---
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(loserX - PADDLE.w / 2 - 2, loser.y - loser.h / 2 - 2, PADDLE.w + 4, loser.h + 4);

  // --- Phase 1: Freeze ---
  if (t < FREEZE + CRACK) {
    const fp = Math.min(1, t / FREEZE);

    // Freeze wave sweeping across paddle (directional from winner side)
    const waveDir = fx.side === 'left' ? 1 : -1;
    const waveX = loserX - (PADDLE.w / 2) * waveDir + PADDLE.w * waveDir * fp;

    // Frozen portion of paddle
    ctx.fillStyle = blend(loser.color, ICE, fp * 0.85);
    ctx.fillRect(loserX - PADDLE.w / 2, loser.y - loser.h / 2, PADDLE.w, loser.h);

    // Ice surface sheen gradient
    if (fp > 0.2) {
      const sheenAlpha = (fp - 0.2) * 0.3;
      const sheenGrad = ctx.createLinearGradient(
        loserX - PADDLE.w / 2, loser.y - loser.h / 2,
        loserX + PADDLE.w / 2, loser.y + loser.h / 2,
      );
      sheenGrad.addColorStop(0, `rgba(255,255,255,${sheenAlpha * 0.1})`);
      sheenGrad.addColorStop(0.3, `rgba(224,244,255,${sheenAlpha})`);
      sheenGrad.addColorStop(0.5, `rgba(255,255,255,${sheenAlpha * 0.5})`);
      sheenGrad.addColorStop(0.7, `rgba(224,244,255,${sheenAlpha * 0.2})`);
      sheenGrad.addColorStop(1, `rgba(255,255,255,${sheenAlpha * 0.1})`);
      ctx.fillStyle = sheenGrad;
      ctx.fillRect(loserX - PADDLE.w / 2, loser.y - loser.h / 2, PADDLE.w, loser.h);
    }

    // Freeze wave leading edge glow
    if (fp < 1) {
      const edgeGrad = ctx.createLinearGradient(waveX - 8 * waveDir, 0, waveX + 8 * waveDir, 0);
      edgeGrad.addColorStop(0, 'rgba(176,224,255,0)');
      edgeGrad.addColorStop(0.5, `rgba(200,240,255,${0.6 * (1 - fp)})`);
      edgeGrad.addColorStop(1, 'rgba(176,224,255,0)');
      ctx.fillStyle = edgeGrad;
      ctx.fillRect(waveX - 10, loser.y - loser.h / 2 - 5, 20, loser.h + 10);
    }

    // Frost crystals — 6-pointed snowflake patterns
    ctx.strokeStyle = `rgba(200, 240, 255, ${fp * 0.7})`;
    ctx.lineWidth = 1;
    for (let i = 0; i < 8; i++) {
      const cx = loserX - PADDLE.w / 2 + ((i + 0.5) * PADDLE.w) / 8;
      const cy = loser.y - loser.h / 2 + ((i * 23 + 7) % Math.floor(loser.h));
      const size = 3 + fp * 10;
      const branches = 6;

      // Only draw crystal if freeze wave has passed this point
      const crystalProgress = fx.side === 'left'
        ? (cx - (loserX - PADDLE.w / 2)) / PADDLE.w
        : 1 - (cx - (loserX - PADDLE.w / 2)) / PADDLE.w;
      if (crystalProgress > fp) continue;

      const crystalAlpha = Math.min(1, (fp - crystalProgress) * 3);
      ctx.strokeStyle = `rgba(200, 240, 255, ${crystalAlpha * 0.7})`;

      for (let b = 0; b < branches; b++) {
        const angle = (b / branches) * Math.PI * 2;
        const endX = cx + Math.cos(angle) * size;
        const endY = cy + Math.sin(angle) * size;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(endX, endY);
        ctx.stroke();

        // Sub-branches
        if (fp > 0.5) {
          const subLen = size * 0.4 * ((fp - 0.5) * 2);
          const midX = cx + Math.cos(angle) * size * 0.6;
          const midY = cy + Math.sin(angle) * size * 0.6;
          ctx.beginPath();
          ctx.moveTo(midX, midY);
          ctx.lineTo(
            midX + Math.cos(angle + 0.6) * subLen,
            midY + Math.sin(angle + 0.6) * subLen,
          );
          ctx.moveTo(midX, midY);
          ctx.lineTo(
            midX + Math.cos(angle - 0.6) * subLen,
            midY + Math.sin(angle - 0.6) * subLen,
          );
          ctx.stroke();
        }
      }

      // Crystal center dot
      ctx.fillStyle = `rgba(255,255,255,${crystalAlpha * 0.5})`;
      ctx.beginPath();
      ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Frost mist particles drifting around paddle during freeze
    for (let i = 0; i < 10; i++) {
      const mx = loserX - PADDLE.w / 2 - 10 + Math.sin(t * 2 + i * 1.7) * (PADDLE.w / 2 + 15);
      const my = loser.y - loser.h / 2 - 8 + ((i * 19) % (Math.floor(loser.h) + 16));
      const mr = 3 + Math.sin(t * 3 + i) * 2;
      const mAlpha = fp * 0.15 * (0.5 + Math.sin(t * 4 + i * 2) * 0.5);
      ctx.fillStyle = `rgba(176,224,255,${mAlpha})`;
      ctx.beginPath();
      ctx.arc(mx, my, mr, 0, Math.PI * 2);
      ctx.fill();
    }

    // Cold aura glow around paddle
    const auraAlpha = fp * 0.12;
    const aura = ctx.createRadialGradient(loserX, loser.y, 0, loserX, loser.y, loser.h * 0.8);
    aura.addColorStop(0, `rgba(176,224,255,${auraAlpha})`);
    aura.addColorStop(0.6, `rgba(136,204,238,${auraAlpha * 0.4})`);
    aura.addColorStop(1, 'rgba(136,204,238,0)');
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(loserX, loser.y, loser.h * 0.8, 0, Math.PI * 2);
    ctx.fill();

    // --- Phase 1b: Cracks appear before shatter ---
    if (t > FREEZE) {
      const cp = Math.min(1, (t - FREEZE) / CRACK);

      // Paddle vibrates/shakes as pressure builds
      const shake = Math.sin(t * 80) * 2 * cp;

      // Redraw paddle with shake
      ctx.fillStyle = blend(loser.color, ICE, 0.85);
      ctx.fillRect(loserX - PADDLE.w / 2 + shake, loser.y - loser.h / 2, PADDLE.w, loser.h);

      // Spiderweb crack pattern from center
      ctx.strokeStyle = `rgba(255,255,255,${0.5 + cp * 0.5})`;
      ctx.lineWidth = 1 + cp;

      // Main cracks radiating from center
      const crackSeeds = [
        { angle: -0.3, len: 1.0 },
        { angle: 0.8, len: 0.8 },
        { angle: -1.2, len: 0.9 },
        { angle: 2.1, len: 0.7 },
        { angle: -2.5, len: 0.85 },
        { angle: 1.5, len: 0.75 },
      ];

      for (const seed of crackSeeds) {
        const maxLen = (loser.h / 2 + PADDLE.w / 2) * seed.len * cp;
        const segs = 5;
        ctx.beginPath();
        ctx.moveTo(loserX + shake, loser.y);
        let cx = loserX + shake;
        let cy = loser.y;
        for (let s = 1; s <= segs; s++) {
          const segLen = maxLen / segs;
          const jitter = (s % 2 === 0 ? 1 : -1) * (2 + (s * 3) % 4);
          cx += Math.cos(seed.angle + jitter * 0.05) * segLen;
          cy += Math.sin(seed.angle + jitter * 0.05) * segLen;
          ctx.lineTo(cx, cy);

          // Branch cracks
          if (s === 3 && cp > 0.5) {
            const branchCp = (cp - 0.5) * 2;
            const brLen = segLen * 0.6 * branchCp;
            ctx.moveTo(cx, cy);
            ctx.lineTo(
              cx + Math.cos(seed.angle + 0.8) * brLen,
              cy + Math.sin(seed.angle + 0.8) * brLen,
            );
            ctx.moveTo(cx, cy);
            ctx.lineTo(
              cx + Math.cos(seed.angle - 0.7) * brLen,
              cy + Math.sin(seed.angle - 0.7) * brLen,
            );
            ctx.moveTo(cx, cy);
          }
        }
        ctx.stroke();
      }

      // Bright light leaking through cracks
      const leakGrad = ctx.createRadialGradient(loserX, loser.y, 0, loserX, loser.y, PADDLE.w * 1.5);
      leakGrad.addColorStop(0, `rgba(224,244,255,${cp * 0.2})`);
      leakGrad.addColorStop(0.5, `rgba(176,224,255,${cp * 0.08})`);
      leakGrad.addColorStop(1, 'rgba(176,224,255,0)');
      ctx.fillStyle = leakGrad;
      ctx.beginPath();
      ctx.arc(loserX, loser.y, PADDLE.w * 1.5, 0, Math.PI * 2);
      ctx.fill();

      // Tiny ice chips flaking off during cracking
      for (let i = 0; i < 5; i++) {
        const chipAngle = (i / 5) * Math.PI * 2 + t * 3;
        const chipDist = cp * (8 + i * 4);
        const chipX = loserX + Math.cos(chipAngle) * chipDist;
        const chipY = loser.y + Math.sin(chipAngle) * chipDist;
        ctx.fillStyle = `rgba(224,244,255,${cp * 0.5})`;
        ctx.save();
        ctx.translate(chipX, chipY);
        ctx.rotate(chipAngle + t * 5);
        ctx.fillRect(-1.5, -1.5, 3, 3);
        ctx.restore();
      }
    }
  } else {
    // --- Phase 2: Shatter ---

    // --- Shatter flash ---
    if (sp < 0.12) {
      const flashP = sp / 0.12;
      const flashR = 30 + flashP * 80;
      const flashGrad = ctx.createRadialGradient(loserX, loser.y, 0, loserX, loser.y, flashR);
      flashGrad.addColorStop(0, `rgba(240,250,255,${0.9 * (1 - flashP)})`);
      flashGrad.addColorStop(0.3, `rgba(176,224,255,${0.6 * (1 - flashP)})`);
      flashGrad.addColorStop(1, 'rgba(136,204,238,0)');
      ctx.fillStyle = flashGrad;
      ctx.beginPath();
      ctx.arc(loserX, loser.y, flashR, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- Shockwave ring (ice-blue) ---
    if (sp < 0.5) {
      const ringR = sp * 220;
      const ringAlpha = 0.5 * (1 - sp / 0.5);
      ctx.strokeStyle = `rgba(176,224,255,${ringAlpha})`;
      ctx.lineWidth = 2.5 * (1 - sp / 0.5);
      ctx.beginPath();
      ctx.arc(loserX, loser.y, ringR, 0, Math.PI * 2);
      ctx.stroke();

      // Inner crystalline ring
      if (sp > 0.05) {
        const ring2R = (sp - 0.05) * 180;
        const ring2Alpha = 0.3 * (1 - sp / 0.5);
        ctx.strokeStyle = `rgba(200,240,255,${ring2Alpha})`;
        ctx.lineWidth = 1.5 * (1 - sp / 0.5);
        ctx.setLineDash([4, 6]);
        ctx.beginPath();
        ctx.arc(loserX, loser.y, ring2R, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // --- Ice shard debris — varied triangular/rectangular shards ---
    const shardCount = 20;
    for (let i = 0; i < shardCount; i++) {
      const angle = (i / shardCount) * Math.PI * 2 + 0.2;
      const speed = 50 + ((i * 19) % 60);
      const dist = sp * speed;
      const gravity = sp * sp * (15 + (i % 4) * 8);
      const sx = loserX + Math.cos(angle) * dist;
      const sy = loser.y + Math.sin(angle) * dist + gravity;
      const alpha = Math.max(0, 1 - sp * 1.1);
      const rotation = sp * (3 + (i * 7) % 5) * (i % 2 === 0 ? 1 : -1);

      // Vary shard shapes: triangles and rectangles
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(rotation);
      ctx.globalAlpha = alpha;

      if (i % 3 === 0) {
        // Triangular shard
        const shardH = 8 + ((i * 11) % 10);
        const shardW = 3 + ((i * 7) % 5);
        ctx.fillStyle = i % 2 === 0 ? ICE_BRIGHT : ICE;
        ctx.beginPath();
        ctx.moveTo(0, -shardH / 2);
        ctx.lineTo(-shardW / 2, shardH / 2);
        ctx.lineTo(shardW / 2, shardH / 2);
        ctx.closePath();
        ctx.fill();

        // Shard edge highlight
        ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.4})`;
        ctx.lineWidth = 0.5;
        ctx.stroke();
      } else if (i % 3 === 1) {
        // Rectangular shard
        const sw = 2 + ((i * 5) % 4);
        const sh = 10 + ((i * 13) % 12);
        ctx.fillStyle = ICE_CORE;
        ctx.fillRect(-sw / 2, -sh / 2, sw, sh);
        ctx.strokeStyle = `rgba(224,244,255,${alpha * 0.3})`;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(-sw / 2, -sh / 2, sw, sh);
      } else {
        // Diamond shard
        const ds = 4 + ((i * 9) % 6);
        ctx.fillStyle = FROST_WHITE;
        ctx.beginPath();
        ctx.moveTo(0, -ds);
        ctx.lineTo(-ds * 0.5, 0);
        ctx.lineTo(0, ds);
        ctx.lineTo(ds * 0.5, 0);
        ctx.closePath();
        ctx.fill();
      }

      ctx.restore();
    }

    // --- Sparkle/glint particles (like light refracting off ice) ---
    const sparkleCount = 14;
    for (let i = 0; i < sparkleCount; i++) {
      const angle = (i / sparkleCount) * Math.PI * 2 + sp * 0.5 + i * 0.3;
      const speed = 25 + ((i * 17) % 35);
      const dist = sp * speed;
      const sx = loserX + Math.cos(angle) * dist;
      const sy = loser.y + Math.sin(angle) * dist - sp * (10 + (i % 4) * 5);

      // Twinkling effect
      const twinkle = Math.sin(t * 12 + i * 2.5) * 0.5 + 0.5;
      const sparkAlpha = Math.max(0, 1 - sp * 1.3) * twinkle;
      const sparkR = 1 + twinkle * 2;

      // Draw 4-pointed star sparkle
      ctx.fillStyle = `rgba(255,255,255,${sparkAlpha})`;
      ctx.beginPath();
      ctx.moveTo(sx, sy - sparkR * 2);
      ctx.lineTo(sx - sparkR * 0.3, sy - sparkR * 0.3);
      ctx.lineTo(sx - sparkR * 2, sy);
      ctx.lineTo(sx - sparkR * 0.3, sy + sparkR * 0.3);
      ctx.lineTo(sx, sy + sparkR * 2);
      ctx.lineTo(sx + sparkR * 0.3, sy + sparkR * 0.3);
      ctx.lineTo(sx + sparkR * 2, sy);
      ctx.lineTo(sx + sparkR * 0.3, sy - sparkR * 0.3);
      ctx.closePath();
      ctx.fill();
    }

    // --- Frost mist / cold vapor billowing out ---
    const mistCount = 8;
    for (let i = 0; i < mistCount; i++) {
      const mAngle = (i / mistCount) * Math.PI * 2;
      const mDist = sp * (20 + i * 12);
      const mx = loserX + Math.cos(mAngle + t * 0.5) * mDist;
      const my = loser.y + Math.sin(mAngle + t * 0.5) * mDist - sp * 8;
      const mR = 10 + sp * 25 + ((i * 7) % 10);
      const mAlpha = 0.06 * Math.max(0, 1 - sp * 0.8);

      const mistGrad = ctx.createRadialGradient(mx, my, 0, mx, my, mR);
      mistGrad.addColorStop(0, `rgba(176,224,255,${mAlpha})`);
      mistGrad.addColorStop(0.6, `rgba(200,230,255,${mAlpha * 0.5})`);
      mistGrad.addColorStop(1, 'rgba(200,230,255,0)');
      ctx.fillStyle = mistGrad;
      ctx.beginPath();
      ctx.arc(mx, my, mR, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- Ice dust settling downward ---
    const dustCount = 12;
    for (let i = 0; i < dustCount; i++) {
      const dx = loserX - 50 + ((i * 31) % 100);
      const drift = Math.sin(t * 2 + i * 1.3) * 8;
      const fall = sp * sp * (40 + ((i * 13) % 30));
      const dy = loser.y + fall + drift;
      const dAlpha = Math.max(0, sp - 0.15) * (1 - sp) * 1.5;
      const dR = 1 + ((i * 3) % 2);

      ctx.fillStyle = `rgba(200,240,255,${dAlpha * 0.6})`;
      ctx.beginPath();
      ctx.arc(dx, dy, dR, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- Frozen floor deposit / ice puddle ---
    const iceFloorAlpha = Math.min(0.2, sp * 0.25);
    const iceFloorGrad = ctx.createRadialGradient(
      loserX, loser.y + loser.h / 2 + sp * 30, 0,
      loserX, loser.y + loser.h / 2 + sp * 30, 50 + sp * 40,
    );
    iceFloorGrad.addColorStop(0, `rgba(176,224,255,${iceFloorAlpha})`);
    iceFloorGrad.addColorStop(0.5, `rgba(136,204,238,${iceFloorAlpha * 0.4})`);
    iceFloorGrad.addColorStop(1, 'rgba(136,204,238,0)');
    ctx.fillStyle = iceFloorGrad;
    ctx.beginPath();
    ctx.ellipse(
      loserX,
      loser.y + loser.h / 2 + sp * 30,
      50 + sp * 40,
      12 + sp * 8,
      0, 0, Math.PI * 2,
    );
    ctx.fill();

    // --- Remaining paddle ghost fading ---
    if (sp < 0.4) {
      const ghostAlpha = Math.max(0, 0.3 * (1 - sp / 0.4));
      ctx.fillStyle = `rgba(176,224,255,${ghostAlpha})`;
      ctx.fillRect(loserX - PADDLE.w / 2, loser.y - loser.h / 2, PADDLE.w, loser.h);
    }
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
