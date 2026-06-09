// Pure drawing: takes the latest server state and paints one frame. No game logic.

import { COURT, PADDLE, BALL, BIG_BALL_R, DIAMOND, PINATA, TARGET, PowerupKind, StateMsg, Role } from '../shared/types';

export function draw(ctx: CanvasRenderingContext2D, s: StateMsg, myRole: Role = 'observer') {
  // "rotate" power-up: flip the whole court 90° clockwise. Everything below draws in
  // court coordinates as usual; the transform maps them into the (portrait) canvas, which
  // main.ts has resized to COURT.h × COURT.w. Identity transform when un-rotated.
  if (s.rotated) ctx.setTransform(0, 1, -1, 0, COURT.h, 0);
  else ctx.setTransform(1, 0, 0, 1, 0, 0);

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

  // Diamond-hands obstacle (drawn under the ball/paddles so they read on top)
  if (s.diamondPos) drawDiamond(ctx, s.diamondPos.x, s.diamondPos.y);

  // Piñata collector + the balls stuck to it (under the live ball/paddles)
  if (s.pinataPos) drawPinata(ctx, s.pinataPos, s.ball.color);

  // Shield glow — a gold bar at the goal wall when a side has shield active.
  for (const side of ['left', 'right'] as const) {
    if (!s.paddles[side].shielded) continue;
    const sx = side === 'left' ? 0 : COURT.w;
    ctx.save();
    ctx.strokeStyle = '#f5cc00';
    ctx.lineWidth = 5;
    ctx.shadowColor = '#f5cc00';
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, COURT.h);
    ctx.stroke();
    ctx.restore();
  }

  // Paddles — X and height both come from the server, so "closing walls" mode and
  // the grow/shrink power-ups render correctly. Each seated player draws their own
  // paddle in their own color; an open side shows a neutral placeholder paddle.
  for (const side of ['left', 'right'] as const) {
    const p = s.paddles[side];
    if (p.players.length) {
      for (const pl of p.players) {
        ctx.fillStyle = pl.color;
        drawPaddle(ctx, pl.x, pl.y, p.h);
      }
    } else {
      ctx.fillStyle = p.color;
      drawPaddle(ctx, p.x, p.y, p.h);
    }
  }

  // Paddle status overlays (frozen, mirrored, curve-ready).
  drawPaddleEffects(ctx, s);

  // Ball(s) — colored by whichever paddle last hit them. Extra balls = multi power-up.
  const ballR = s.tinyBall ? 3 : s.bigBall ? BIG_BALL_R : BALL.r;
  ctx.globalAlpha = s.ghostBall ? 0.12 : 1;
  for (const b of [s.ball, ...s.extraBalls]) {
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.arc(b.x, b.y, ballR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Blind overlay — drawn over the opponent's half so the blinded player can't
  // read the ball trajectory until it crosses into their side.
  if (myRole === 'left' && s.paddles.left.blinded) {
    ctx.fillStyle = 'rgba(6, 9, 18, 0.82)';
    ctx.fillRect(COURT.w / 2, 0, COURT.w / 2, COURT.h);
  } else if (myRole === 'right' && s.paddles.right.blinded) {
    ctx.fillStyle = 'rgba(6, 9, 18, 0.82)';
    ctx.fillRect(0, 0, COURT.w / 2, COURT.h);
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

// The diamond-hands obstacle: a blue-and-white gem with faceted highlights and a glow.
function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const r = DIAMOND.r;
  ctx.save();
  ctx.translate(x, y);

  // Body — a vertical blue gradient, with a soft blue glow.
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r, 0);
  ctx.lineTo(0, r);
  ctx.lineTo(-r, 0);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, -r, 0, r);
  grad.addColorStop(0, '#cfe0ff');
  grad.addColorStop(0.5, '#3f6fe0');
  grad.addColorStop(1, '#23409c');
  ctx.shadowColor = '#5b8cff';
  ctx.shadowBlur = 16;
  ctx.fillStyle = grad;
  ctx.fill();

  // Bright white outline.
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#eef4ff';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Inner facet lines for a cut-gem look.
  const g = r * 0.42; // girdle height (the diamond's widest cross-line)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-g, -g); // girdle
  ctx.lineTo(g, -g);
  ctx.moveTo(0, -r); // crown facets from the top point
  ctx.lineTo(-g, -g);
  ctx.moveTo(0, -r);
  ctx.lineTo(g, -g);
  ctx.moveTo(-r, 0); // crown facets from the side points
  ctx.lineTo(-g, -g);
  ctx.moveTo(r, 0);
  ctx.lineTo(g, -g);
  ctx.moveTo(-g, -g); // pavilion facets down to the bottom point
  ctx.lineTo(0, r);
  ctx.moveTo(g, -g);
  ctx.lineTo(0, r);
  ctx.stroke();

  ctx.restore();
}

// The piñata: a colorful beach ball that inflates as balls stick to it, then flashes a
// bursting ring when it pops. Stuck balls cling to its surface; positions come from the
// server. `ballColor` is the shared live-ball color so clinging balls match the rally.
let pinataBurstAt = -1e9; // performance.now() of the last burst, for the pop animation
function drawPinata(
  ctx: CanvasRenderingContext2D,
  p: NonNullable<StateMsg['pinataPos']>,
  ballColor: string,
) {
  const now = performance.now();
  if (p.burst) pinataBurstAt = now;
  const fill = p.stuck.length;
  const R = PINATA.r * (1 + fill * 0.06); // inflates with each ball it holds

  ctx.save();
  ctx.translate(p.x, p.y);

  // Burst flash: a quick expanding white ring right after it pops.
  const bt = (now - pinataBurstAt) / 340;
  if (bt >= 0 && bt < 1) {
    ctx.save();
    ctx.globalAlpha = (1 - bt) * 0.85;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(0, 0, PINATA.r + bt * 110, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Beach-ball body: colored wedges rotating with the piñata's spin, a white rim and hub.
  ctx.save();
  ctx.rotate(p.spin);
  const colors = ['#ff5252', '#ffd23f', '#4dd964', '#3fa9ff', '#b066ff', '#ffffff'];
  const seg = (Math.PI * 2) / colors.length;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
  ctx.shadowBlur = 12;
  for (let i = 0; i < colors.length; i++) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, i * seg, (i + 1) * seg);
    ctx.closePath();
    ctx.fillStyle = colors[i];
    ctx.fill();
  }
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.restore();

  // Balls clinging to the surface (absolute positions from the server).
  for (const b of p.stuck) {
    ctx.fillStyle = ballColor;
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawPaddle(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.fillRect(cx - PADDLE.w / 2, cy - h / 2, PADDLE.w, h);
}

function drawPaddleEffects(ctx: CanvasRenderingContext2D, s: StateMsg) {
  for (const side of ['left', 'right'] as const) {
    const p = s.paddles[side];
    const hh = p.h / 2;

    // Power-up state is team-wide, so every paddle on the side shows the effect —
    // each at its own position (layered mode staggers teammates' X).
    for (const { x: px, y: py } of p.players.length ? p.players : [{ x: p.x, y: p.y }]) {
      // Frozen: ice-blue crosshatch lines across the paddle face.
      if (p.frozen) {
        ctx.save();
        ctx.strokeStyle = '#88d8f7';
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.7;
        for (let dy = -hh + 6; dy < hh; dy += 10) {
          ctx.beginPath();
          ctx.moveTo(px - PADDLE.w / 2, py + dy);
          ctx.lineTo(px + PADDLE.w / 2, py + dy);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Mirrored: ↕ indicator just outside the paddle.
      if (p.mirrored) {
        const ix = side === 'left' ? px + PADDLE.w / 2 + 10 : px - PADDLE.w / 2 - 10;
        ctx.save();
        ctx.fillStyle = '#ff7eb3';
        ctx.font = 'bold 14px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('↕', ix, py);
        ctx.restore();
      }

      // Curve ready: a small arc indicator above the paddle.
      if (p.curveReady) {
        const ix = side === 'left' ? px + PADDLE.w / 2 + 10 : px - PADDLE.w / 2 - 10;
        ctx.save();
        ctx.strokeStyle = '#7ddc4a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(ix, py - hh - 10, 6, Math.PI, 0);
        ctx.stroke();
        ctx.restore();
      }
    }
  }
}

// Each power-up target gets its own ring color + glyph so players can read at a glance
// what bouncing the ball over it will do.
const TARGET_STYLE: Record<PowerupKind, { stroke: string; fill: string }> = {
  grow:   { stroke: '#ffd166', fill: 'rgba(255, 209, 102, 0.12)' }, // amber
  shrink: { stroke: '#5ad1e6', fill: 'rgba(90,  209, 230, 0.12)' }, // cyan
  smash:  { stroke: '#ff6b3d', fill: 'rgba(255, 107,  61, 0.13)' }, // orange-red
  slow:   { stroke: '#7aa2ff', fill: 'rgba(122, 162, 255, 0.13)' }, // blue
  multi:  { stroke: '#c08cff', fill: 'rgba(192, 140, 255, 0.14)' }, // violet
  freeze: { stroke: '#88d8f7', fill: 'rgba(136, 216, 247, 0.12)' }, // ice blue
  curve:  { stroke: '#7ddc4a', fill: 'rgba(125, 220,  74, 0.12)' }, // lime green
  blind:  { stroke: '#9988bb', fill: 'rgba(153, 136, 187, 0.12)' }, // muted purple
  mirror: { stroke: '#ff7eb3', fill: 'rgba(255, 126, 179, 0.12)' }, // hot pink
  shield: { stroke: '#f5cc00', fill: 'rgba(245, 204,   0, 0.12)' }, // gold
  ghost:   { stroke: '#c8beff', fill: 'rgba(200, 190, 255, 0.12)' }, // pale lavender
  tiny:    { stroke: '#ff8c42', fill: 'rgba(255, 140,  66, 0.12)' }, // warm orange
  warp:    { stroke: '#e040fb', fill: 'rgba(224,  64, 251, 0.12)' }, // magenta
  bigball: { stroke: '#fb923c', fill: 'rgba(251, 146,  60, 0.14)' }, // deep orange
  rotate:  { stroke: '#2ee6c9', fill: 'rgba( 46, 230, 201, 0.13)' }, // teal
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
  // freeze: snowflake — three lines through center with branch ticks
  freeze(ctx, x, y) {
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI) / 3;
      const cos = Math.cos(a), sin = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(x + cos * 14, y + sin * 14);
      ctx.lineTo(x - cos * 14, y - sin * 14);
      for (const sign of [1, -1]) {
        const bx = x + cos * 7 * sign, by = y + sin * 7 * sign;
        const tx = Math.cos(a + Math.PI / 2) * 5, ty = Math.sin(a + Math.PI / 2) * 5;
        ctx.moveTo(bx + tx, by + ty);
        ctx.lineTo(bx - tx, by - ty);
      }
      ctx.stroke();
    }
  },
  // curve: ¾-circle arc with arrowhead → "ball will arc after your hit"
  curve(ctx, x, y) {
    const r = 11, startA = 0.6, endA = 0.6 + Math.PI * 1.75;
    ctx.beginPath();
    ctx.arc(x, y, r, startA, endA);
    ctx.stroke();
    const ex = x + Math.cos(endA) * r, ey = y + Math.sin(endA) * r;
    const ta = endA + Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(ex + Math.cos(ta - 0.45) * 5, ey + Math.sin(ta - 0.45) * 5);
    ctx.lineTo(ex, ey);
    ctx.lineTo(ex + Math.cos(ta + 0.45) * 5, ey + Math.sin(ta + 0.45) * 5);
    ctx.stroke();
  },
  // blind: eye with a slash → "opponent loses sight"
  blind(ctx, x, y) {
    ctx.beginPath();
    ctx.moveTo(x - 13, y);
    ctx.quadraticCurveTo(x, y - 9, x + 13, y);
    ctx.quadraticCurveTo(x, y + 9, x - 13, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - 10, y + 11);
    ctx.lineTo(x + 10, y - 11);
    ctx.stroke();
  },
  // mirror: horizontal mirror line with arrows above and below → "controls flip"
  mirror(ctx, x, y) {
    ctx.beginPath();
    ctx.moveTo(x - 12, y);
    ctx.lineTo(x + 12, y);
    ctx.stroke();
    for (const sign of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(x, y + sign * 5);
      ctx.lineTo(x, y + sign * 12);
      ctx.moveTo(x - 4, y + sign * 9);
      ctx.lineTo(x, y + sign * 13);
      ctx.lineTo(x + 4, y + sign * 9);
      ctx.stroke();
    }
  },
  // shield: pentagon shield shape → "absorbs the next goal"
  shield(ctx, x, y) {
    ctx.beginPath();
    ctx.moveTo(x - 10, y - 13);
    ctx.lineTo(x + 10, y - 13);
    ctx.lineTo(x + 13, y - 3);
    ctx.lineTo(x, y + 13);
    ctx.lineTo(x - 13, y - 3);
    ctx.closePath();
    ctx.stroke();
  },
  // ghost: pac-ghost shape → "ball goes invisible"
  ghost(ctx, x, y) {
    const r = 10;
    ctx.beginPath();
    ctx.arc(x, y - 3, r, Math.PI, 0);
    ctx.lineTo(x + r, y + 9);
    ctx.quadraticCurveTo(x + r - 4, y + 13, x + r - 7, y + 9);
    ctx.quadraticCurveTo(x + r - 10, y + 5, x, y + 9);
    ctx.quadraticCurveTo(x - r + 10, y + 13, x - r + 7, y + 9);
    ctx.lineTo(x - r, y - 3);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x - 4, y - 5, 2.5, 0, Math.PI * 2);
    ctx.arc(x + 4, y - 5, 2.5, 0, Math.PI * 2);
    ctx.fill();
  },
  // tiny: small dot → "ball shrinks"
  tiny(ctx, x, y) {
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  },
  // warp: diamond with center dot → "ball teleports"
  warp(ctx, x, y) {
    ctx.beginPath();
    ctx.moveTo(x, y - 14);
    ctx.lineTo(x + 10, y);
    ctx.lineTo(x, y + 14);
    ctx.lineTo(x - 10, y);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  },
  // bigball: a large filled circle with a small circle inside → "ball gets huge"
  bigball(ctx, x, y) {
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  },
  // rotate: a circular arrow → "the whole court spins 90°"
  rotate(ctx, x, y) {
    const r = 11;
    const start = -Math.PI / 2 + 0.6;
    const end = start + Math.PI * 1.7;
    ctx.beginPath();
    ctx.arc(x, y, r, start, end);
    ctx.stroke();
    // Arrowhead at the arc's end, pointing along the tangent (clockwise).
    const ex = x + Math.cos(end) * r, ey = y + Math.sin(end) * r;
    const ta = end + Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(ex + Math.cos(ta - 0.5) * 6, ey + Math.sin(ta - 0.5) * 6);
    ctx.lineTo(ex, ey);
    ctx.lineTo(ex + Math.cos(ta + 0.5) * 6, ey + Math.sin(ta + 0.5) * 6);
    ctx.stroke();
  },
};

// Draws a single power-up icon (ring + glyph) centered in the given canvas.
// Used by the in-page legend; reuses the same TARGET_STYLE and GLYPHS maps so
// the legend icons are always pixel-identical to the in-game targets.
export function drawLegendIcon(canvas: HTMLCanvasElement, kind: PowerupKind) {
  const ctx = canvas.getContext('2d')!;
  const { width: w, height: h } = canvas;
  const margin = 3;
  const scale = (Math.min(w, h) / 2 - margin) / TARGET.r;
  const style = TARGET_STYLE[kind];

  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(scale, scale);

  ctx.beginPath();
  ctx.arc(0, 0, TARGET.r, 0, Math.PI * 2);
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
  GLYPHS[kind](ctx, 0, 0);

  ctx.restore();
}

// --- Fatality animations ------------------------------------------------------
// render is otherwise stateless, so we latch each animation's start time here.
let fxStart = 0;
let fxKey = '';

const MOLTEN = '#ff5a2a';

// Jsav's face, used by the JSAV fatality. Loaded once; drawn only once ready.
const jsavImg = new Image();
jsavImg.src = '/jsav.jpg';
const jsavReady = () => jsavImg.complete && jsavImg.naturalWidth > 0;

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
  // JSAV gets its own "JSAVALITY" banner; everything else reads "FATALITY".
  const bannerText = fx.move === 'JSAV' ? 'JSAVALITY' : 'FATALITY';
  const banner = () => drawFatalityBanner(ctx, t, bannerText);

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
    case 'NOT_FOUND':
      drawNotFound(ctx, s, fx, t, banner);
      break;
    case 'SINGULARITY':
      drawSingularity(ctx, s, fx, t, banner);
      break;
    case 'PAC_CHOMP':
      drawPacChomp(ctx, s, fx, t, banner);
      break;
    case 'JSAV':
      drawJsavStretch(ctx, s, fx, t, banner);
      break;
  }
}

// Shared finisher banner, pulsing in. Text defaults to "FATALITY".
function drawFatalityBanner(ctx: CanvasRenderingContext2D, t: number, text = 'FATALITY') {
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
    ctx.fillText(text, 0, 0);
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

// --- Fatality: "404 Not Found" -----------------------------------------------
// The losing paddle glitches into a magenta/black missing-texture checkerboard, flickers
// under a "404 PADDLE NOT FOUND" tag, then strobes out of existence. A meta finisher —
// the game pretending it can't find the loser's asset.
function drawNotFound(
  ctx: CanvasRenderingContext2D,
  s: StateMsg,
  fx: { side: 'left' | 'right' },
  t: number,
  banner: () => void,
) {
  const loserSide = fx.side === 'left' ? 'right' : 'left';
  const loser = s.paddles[loserSide];
  const px = loser.x - PADDLE.w / 2;
  const pw = PADDLE.w;
  const top = loser.y - loser.h / 2;
  const ph = loser.h;

  const GLITCH = 0.35; // initial RGB-split tearing
  const TAG_AT = 0.5; // when the "404" tag pops in
  const BLINK_AT = 1.6; // when the paddle starts strobing out

  // Court faults to black as the "asset" fails to load.
  ctx.fillStyle = `rgba(4,7,16,${Math.min(0.45, t)})`;
  ctx.fillRect(0, 0, COURT.w, COURT.h);

  // Blank the real paddle so it reads as replaced by the broken texture.
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(px - 2, top - 2, pw + 4, ph + 4);

  // Visibility: dropout flicker while "loading wrong", strobing fade once it blinks out.
  let alpha: number;
  if (t >= BLINK_AT) {
    const fade = Math.max(0, 1 - (t - BLINK_AT) / 0.8);
    alpha = fade * (Math.sin(t * 60) > 0 ? 1 : 0.15);
  } else {
    alpha = Math.sin(t * 47) > -0.75 ? 1 : 0.25;
  }

  // Horizontal glitch jitter — violent at first, then a faint persistent wobble.
  const glitchAmt = t < GLITCH ? 1 - t / GLITCH : 0.12 + 0.12 * Math.abs(Math.sin(t * 9));
  const jx = Math.sin(t * 60) * 6 * glitchAmt;

  ctx.save();
  ctx.globalAlpha = alpha;

  // Missing-texture checkerboard (magenta / near-black), keyed to court space so the
  // pattern stays put as the height varies.
  const cell = 7;
  for (let cy = 0; cy < ph; cy += cell) {
    for (let cx = 0; cx < pw; cx += cell) {
      const odd = (Math.floor(cx / cell) + Math.floor((top + cy) / cell)) % 2 === 0;
      ctx.fillStyle = odd ? '#ff00dc' : '#16121c';
      ctx.fillRect(px + cx + jx, top + cy, Math.min(cell, pw - cx), Math.min(cell, ph - cy));
    }
  }

  // RGB-split ghost slices during the initial tear.
  if (t < GLITCH + 0.4) {
    const slices = 5;
    for (let i = 0; i < slices; i++) {
      const off = Math.sin(t * 30 + i * 2) * 7 * (glitchAmt + 0.2);
      ctx.globalAlpha = alpha * 0.4;
      ctx.fillStyle = i % 2 ? '#00e5ff' : '#ff2bd0';
      ctx.fillRect(px + off, top + (i / slices) * ph, pw, (ph / slices) * 0.7);
    }
  }
  ctx.restore();

  // "404 PADDLE NOT FOUND" tag, nudged toward court center so the wall doesn't clip it.
  if (t >= TAG_AT) {
    const tp = Math.min(1, (t - TAG_AT) / 0.25);
    const boxW = 150;
    const boxH = 48;
    const cx = loserSide === 'left' ? loser.x + 30 + boxW / 2 : loser.x - 30 - boxW / 2;
    const bx = cx - boxW / 2;
    const by = Math.max(6, Math.min(COURT.h - boxH - 6, loser.y - boxH / 2));
    ctx.save();
    ctx.globalAlpha = (t >= BLINK_AT ? alpha : 1) * tp * (Math.sin(t * 41) < -0.8 ? 0.4 : 1);
    ctx.fillStyle = '#16121c';
    ctx.strokeStyle = '#ff00dc';
    ctx.lineWidth = 2;
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.strokeRect(bx, by, boxW, boxH);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff00dc';
    ctx.font = 'bold 22px ui-monospace, monospace';
    ctx.fillText('404', cx, by + 17);
    ctx.fillStyle = '#cfe0ff';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText('PADDLE NOT FOUND', cx, by + 35);
    ctx.restore();
  }

  banner();
}

// --- Fatality: "Singularity" (Black Hole) ------------------------------------
// Space buckles. A black hole tears open at court center: gravitational lensing
// rings ripple out, the surrounding starfield spirals inward and redshifts, the
// losing paddle is spaghettified along a tidal stream into a glowing accretion
// disk, then the whole thing collapses to a blinding point and detonates.
function drawSingularity(
  ctx: CanvasRenderingContext2D,
  s: StateMsg,
  fx: { side: 'left' | 'right' },
  t: number,
  banner: () => void,
) {
  const loserSide = fx.side === 'left' ? 'right' : 'left';
  const loser = s.paddles[loserSide];
  const cx = COURT.w / 2;
  const cy = COURT.h / 2;
  const TAU = Math.PI * 2;
  // Stable per-index pseudo-random in [0,1) — Math.random() drifts every frame.
  const hash = (n: number) => {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };

  const FORM = 0.45; // hole tears open, lensing ripples, starfield begins to fall in
  const DEVOUR = 1.3; // accretion disk ignites, the paddle is spaghettified inward
  const IMPLODE = 0.7; // collapse to a point, blinding flash, detonation shockwave

  const formP = Math.min(1, t / FORM);
  const devourActive = t >= FORM;
  const dp = devourActive ? Math.min(1, (t - FORM) / DEVOUR) : 0;
  const implodeActive = t >= FORM + DEVOUR;
  const ip = implodeActive ? Math.min(1, (t - FORM - DEVOUR) / IMPLODE) : 0;

  // Deep-space blackout — darker than the other finishers; space itself is eaten.
  ctx.fillStyle = `rgba(2,3,10,${Math.min(0.9, t * 1.5)})`;
  ctx.fillRect(0, 0, COURT.w, COURT.h);

  // Erase the loser paddle from its home cell — its matter is the disk now.
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(loser.x - PADDLE.w / 2 - 2, loser.y - loser.h / 2 - 2, PADDLE.w + 4, loser.h + 4);

  // Event horizon: grows as it forms, then collapses to nothing during the implosion.
  const baseR = 7 + formP * 26;
  const horizonR = implodeActive ? Math.max(0, baseR * (1 - ip)) : baseR;

  // --- Infalling starfield: points spiraling in, redshifting and accelerating ---
  if (!implodeActive || ip < 0.5) {
    const span = Math.max(COURT.w, COURT.h);
    const pull = formP * 0.28 + dp * 0.72; // 0 → undisturbed, 1 → fully consumed
    for (let i = 0; i < 90; i++) {
      const a0 = hash(i) * TAU;
      const r0 = 70 + hash(i + 99) * span * 0.7;
      const g = Math.min(1, pull * (0.6 + hash(i + 7) * 0.7));
      const dist = r0 * Math.pow(1 - g, 1.8) + horizonR;
      if (dist <= horizonR + 1) continue; // already swallowed
      const ang = a0 + g * (3 + hash(i + 41) * 4) * TAU * (i % 2 === 0 ? 1 : -1);
      const sx = cx + Math.cos(ang) * dist;
      const sy = cy + Math.sin(ang) * dist;
      // Redshift: white/blue far out, deep red as it nears the horizon.
      const near = 1 - Math.min(1, (dist - horizonR) / (span * 0.5));
      const col = blend('#cfe0ff', '#ff3a1a', near);
      const r = 0.6 + hash(i + 13) * 1.4;
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.5 + 0.5 * near;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // --- Gravitational lensing rings rippling outward as the hole tears open ---
  if (formP < 1 || t < FORM + 0.4) {
    const rip = (t / 0.7) % 1;
    for (let k = 0; k < 3; k++) {
      const rp = (rip + k / 3) % 1;
      const rr = horizonR + rp * 130;
      const alpha = 0.35 * (1 - rp) * Math.min(1, formP * 1.5);
      ctx.strokeStyle = `rgba(150,120,255,${alpha})`;
      ctx.lineWidth = 2 * (1 - rp);
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, TAU);
      ctx.stroke();
    }
  }

  // --- Accretion disk: a tilted, spinning ring of superheated matter ---
  if (devourActive && !(implodeActive && ip > 0.4)) {
    const intensity = Math.min(1, dp * 1.5) * (implodeActive ? 1 - ip / 0.4 : 1);
    const tilt = 0.34; // vertical squash → disk seen near edge-on
    const inner = horizonR * 1.1;
    const outer = horizonR * 3.2 + 30;
    ctx.save();
    ctx.translate(cx, cy);
    // Soft hot haze of the disk.
    const haze = ctx.createRadialGradient(0, 0, inner, 0, 0, outer);
    haze.addColorStop(0, `rgba(255,240,200,${0.22 * intensity})`);
    haze.addColorStop(0.5, `rgba(255,140,40,${0.16 * intensity})`);
    haze.addColorStop(1, 'rgba(255,80,20,0)');
    ctx.save();
    ctx.scale(1, tilt);
    ctx.fillStyle = haze;
    ctx.beginPath();
    ctx.arc(0, 0, outer, 0, TAU);
    ctx.fill();
    ctx.restore();
    // Streaking orbital particles, brighter on the Doppler-boosted approaching side.
    for (let i = 0; i < 70; i++) {
      const orbit = inner + hash(i) * (outer - inner);
      const speed = 5 + (1 - (orbit - inner) / (outer - inner)) * 7; // inner orbits faster
      const ang = hash(i + 200) * TAU + t * speed * (1 + dp);
      const ox = Math.cos(ang) * orbit;
      const oy = Math.sin(ang) * orbit * tilt;
      // Approaching side (left half here) beams brighter and bluer-white.
      const boost = 0.45 + 0.55 * (Math.cos(ang) * 0.5 + 0.5);
      const col = blend('#ff5a14', '#fff4d0', boost);
      ctx.globalAlpha = intensity * (0.4 + 0.6 * boost);
      ctx.fillStyle = col;
      const ps = 1 + hash(i + 5) * 1.6;
      ctx.beginPath();
      ctx.arc(ox, oy, ps, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // --- Spaghettification: the paddle stretched into a tidal stream and spiraled in ---
  if (devourActive && dp < 1) {
    const segs = 16;
    const pp = dp * dp; // accelerating infall
    for (let i = 0; i <= segs; i++) {
      const frac = i / segs;
      const hx = loser.x;
      const hy = loser.y - loser.h / 2 + frac * loser.h;
      const ang0 = Math.atan2(hy - cy, hx - cx);
      const dist0 = Math.hypot(hx - cx, hy - cy);
      // Each segment winds inward; outer-of-paddle lags, near-edge leads → stretch.
      const lead = pp * (1 + frac * 0.6);
      const ang = ang0 + lead * 7;
      const dist = Math.max(horizonR, dist0 * Math.pow(1 - Math.min(1, lead), 1.5));
      const x = cx + Math.cos(ang) * dist;
      const y = cy + Math.sin(ang) * dist;
      // Stretch streak pointing back along its orbit, lengthening as it falls in.
      const tail = 10 + pp * 60;
      const tx = cx + Math.cos(ang - 0.5) * (dist + tail);
      const ty = cy + Math.sin(ang - 0.5) * (dist + tail);
      const heat = Math.min(1, (1 - dist / (dist0 + 1)) + pp * 0.4);
      const col = blend(loser.color, '#fff4d0', heat);
      ctx.strokeStyle = col;
      ctx.globalAlpha = Math.max(0, 1 - pp * 0.7);
      ctx.lineWidth = Math.max(0.5, (PADDLE.w * 0.6) * (1 - heat * 0.7));
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
  }

  // --- Photon ring + event horizon (drawn over the disk so the void reads on top) ---
  if (horizonR > 0.5) {
    // Bright photon ring hugging the horizon.
    ctx.save();
    ctx.strokeStyle = 'rgba(255,236,190,0.9)';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = '#ffd27a';
    ctx.shadowBlur = 22;
    ctx.beginPath();
    ctx.arc(cx, cy, horizonR * 1.18, 0, TAU);
    ctx.stroke();
    ctx.restore();
    // The void itself.
    const hole = ctx.createRadialGradient(cx, cy, 0, cx, cy, horizonR * 1.1);
    hole.addColorStop(0, '#000000');
    hole.addColorStop(0.82, '#000000');
    hole.addColorStop(1, 'rgba(40,20,60,0.6)');
    ctx.fillStyle = hole;
    ctx.beginPath();
    ctx.arc(cx, cy, horizonR * 1.1, 0, TAU);
    ctx.fill();
  }

  // --- Implosion: blinding flash, then a detonation shockwave ---
  if (implodeActive) {
    // Collapse flash — everything piles into the point and ignites.
    if (ip < 0.35) {
      const fp = ip / 0.35;
      const fr = 20 + fp * 260;
      const flash = ctx.createRadialGradient(cx, cy, 0, cx, cy, fr);
      flash.addColorStop(0, `rgba(255,255,255,${0.95 * (1 - fp * 0.3)})`);
      flash.addColorStop(0.3, `rgba(220,200,255,${0.7 * (1 - fp)})`);
      flash.addColorStop(1, 'rgba(150,120,255,0)');
      ctx.fillStyle = flash;
      ctx.beginPath();
      ctx.arc(cx, cy, fr, 0, TAU);
      ctx.fill();
    }
    // Detonation shockwave ring blasting outward.
    if (ip > 0.2) {
      const wp = (ip - 0.2) / 0.8;
      const wr = wp * Math.max(COURT.w, COURT.h) * 0.75;
      const wAlpha = 0.6 * (1 - wp);
      ctx.strokeStyle = `rgba(190,170,255,${wAlpha})`;
      ctx.lineWidth = 6 * (1 - wp);
      ctx.beginPath();
      ctx.arc(cx, cy, wr, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${wAlpha * 0.7})`;
      ctx.lineWidth = 2 * (1 - wp);
      ctx.beginPath();
      ctx.arc(cx, cy, wr * 0.88, 0, TAU);
      ctx.stroke();
    }
  }

  banner();
}

// --- Fatality: "Pac-Man" -----------------------------------------------------
// The WINNER (not the loser) is the star here: their paddle morphs into a yellow
// Pac-Man, which waka-wakas along a trail of ping-pong pellets across the court to
// the frozen, increasingly-nervous loser, devours them, balloons up fat, and bursts.
function drawPacChomp(
  ctx: CanvasRenderingContext2D,
  s: StateMsg,
  fx: { side: 'left' | 'right' },
  t: number,
  banner: () => void,
) {
  const loserSide = fx.side === 'left' ? 'right' : 'left';
  const winner = s.paddles[fx.side];
  const loser = s.paddles[loserSide];
  const dir = fx.side === 'left' ? 1 : -1; // travel direction across the court
  const facing = dir === 1 ? 0 : Math.PI; // mouth points the way Pac travels
  const TAU = Math.PI * 2;

  const PAC_R = 20; // starting Pac radius
  const GROW = 2.4; // radius gained per pellet eaten

  const MORPH = 0.5; // paddle morphs into Pac, pellets fade in
  const TRAVEL = 1.6; // chomp along the trail
  const DEVOUR = 0.4; // swallow the loser
  const EXPLODE = 1.0; // balloon and burst
  const tTravel = MORPH;
  const tDevour = MORPH + TRAVEL;
  const tExplode = MORPH + TRAVEL + DEVOUR;

  // Path: from just in front of the winner to just in front of the loser.
  const startX = winner.x + dir * (PADDLE.w / 2 + 16);
  const startY = winner.y;
  const stopX = loser.x - dir * (PADDLE.w / 2 + 4);
  const stopY = loser.y;
  const lerpPath = (f: number) => ({ x: startX + (stopX - startX) * f, y: startY + (stopY - startY) * f });

  // Evenly-spaced pellets along the path.
  const pelletCount = Math.max(3, Math.round(Math.abs(stopX - startX) / 34));
  const pelletFrac = (i: number) => (i + 0.5) / pelletCount;

  // How far Pac is along the path right now (eased), and its current fatness.
  let pacFrac = 0;
  if (t >= tTravel) pacFrac = Math.min(1, (t - tTravel) / TRAVEL);
  const easedFrac = pacFrac < 0.5 ? 2 * pacFrac * pacFrac : 1 - Math.pow(-2 * pacFrac + 2, 2) / 2;
  const eaten = t < tTravel ? 0 : Math.min(pelletCount, Math.floor(easedFrac * pelletCount + 0.5));
  const pac = t < tTravel ? { x: startX, y: startY } : lerpPath(easedFrac);

  // Background dim (dark, arcade-maze blue-black).
  ctx.fillStyle = `rgba(2,4,14,${Math.min(0.7, t * 1.3)})`;
  ctx.fillRect(0, 0, COURT.w, COURT.h);

  // Erase both real paddles — winner becomes Pac, loser is drawn by us below.
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(winner.x - PADDLE.w / 2 - 2, winner.y - loser.h / 2 - 2, PADDLE.w + 4, winner.h + 4);
  ctx.fillRect(loser.x - PADDLE.w / 2 - 2, loser.y - loser.h / 2 - 2, PADDLE.w + 4, loser.h + 4);

  // --- Ping-pong pellet trail (drawn under Pac) ---
  if (t < tExplode) {
    for (let i = 0; i < pelletCount; i++) {
      if (t >= tTravel && pelletFrac(i) <= easedFrac) continue; // already eaten
      const p = lerpPath(pelletFrac(i));
      const fadeIn = Math.min(1, t / MORPH);
      const bob = Math.sin(t * 6 + i) * 1.5;
      drawPellet(ctx, p.x, p.y + bob, 5, fadeIn);
    }
  }

  // --- The loser: frozen, shaking harder the closer Pac gets, then swallowed ---
  if (t < tDevour) {
    const nearness = t < tTravel ? 0 : easedFrac;
    const shake = Math.sin(t * 38) * (0.4 + nearness * 4);
    ctx.fillStyle = loser.color;
    ctx.fillRect(loser.x - PADDLE.w / 2 + shake, loser.y - loser.h / 2, PADDLE.w, loser.h);
    // Wide, nervous eyes that grow as doom approaches.
    const eyeR = 2 + nearness * 2;
    ctx.fillStyle = '#fff';
    for (const dy of [-loser.h * 0.18, loser.h * 0.06]) {
      ctx.beginPath();
      ctx.arc(loser.x + shake - dir * 2, loser.y + dy, eyeR, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#0b1020';
      ctx.beginPath();
      ctx.arc(loser.x + shake - dir * 2, loser.y + dy, eyeR * 0.5, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#fff';
    }
    // Sweat bead near the top once Pac is close.
    if (nearness > 0.4) {
      ctx.fillStyle = `rgba(120,200,255,${(nearness - 0.4) * 1.6})`;
      ctx.beginPath();
      ctx.arc(loser.x + shake - dir * 6, loser.y - loser.h / 2 + 6, 2.5, 0, TAU);
      ctx.fill();
    }
  } else if (t < tExplode) {
    // Being swallowed: the paddle shrinks toward Pac's mouth.
    const dvp = (t - tDevour) / DEVOUR;
    const h = loser.h * (1 - dvp);
    const lx = loser.x + (pac.x - loser.x) * dvp;
    ctx.globalAlpha = 1 - dvp * 0.5;
    ctx.fillStyle = loser.color;
    ctx.fillRect(lx - PADDLE.w / 2, loser.y - h / 2, PADDLE.w, h);
    ctx.globalAlpha = 1;
  }

  // --- Pac-Man ---
  const pacR = PAC_R + eaten * GROW;
  if (t < MORPH) {
    // Morph: winner paddle squashes into a growing yellow ball.
    const mp = t / MORPH;
    const w = PADDLE.w + (pacR * 2 - PADDLE.w) * mp;
    const h = winner.h + (pacR * 2 - winner.h) * mp;
    ctx.fillStyle = blend(winner.color, '#ffe600', mp);
    if (mp < 0.6) {
      roundRect(ctx, winner.x - w / 2, winner.y - h / 2, w, h, pacR * mp);
      ctx.fill();
    } else {
      const mouth = (mp - 0.6) / 0.4 * 0.3 * Math.PI;
      pacMan(ctx, winner.x, winner.y, pacR, facing, mouth);
    }
  } else if (t < tExplode) {
    // Chomp! Mouth opens and closes as it travels / devours.
    const chomp = Math.abs(Math.sin(t * 16));
    const mouth = (0.05 + chomp * 0.3) * Math.PI;
    pacMan(ctx, pac.x, pac.y, pacR, facing, mouth);
    // Little motion-puff dots trailing behind during travel.
    if (t < tDevour) {
      for (let i = 1; i <= 3; i++) {
        const bp = easedFrac - i * 0.03;
        if (bp < 0) continue;
        const b = lerpPath(bp);
        ctx.fillStyle = `rgba(255,230,0,${0.12 / i})`;
        ctx.beginPath();
        ctx.arc(b.x, b.y, pacR * (1 - i * 0.12), 0, TAU);
        ctx.fill();
      }
    }
  } else {
    // --- Balloon & burst ---
    const ep = Math.min(1, (t - tExplode) / EXPLODE);
    const POP = 0.4;
    const bigR = pacR + 26;
    if (ep < POP) {
      // Swell, straining and reddening, with a nervous wobble before it goes.
      const sp = ep / POP;
      const wobble = 1 + Math.sin(t * 40) * 0.04 * sp;
      const r = (bigR + sp * 60) * wobble;
      ctx.fillStyle = blend('#ffe600', '#ff5a2a', sp * 0.5);
      pacMan(ctx, pac.x, pac.y, r, facing, (0.05 + sp * 0.1) * Math.PI);
      // Strain glints.
      ctx.strokeStyle = `rgba(255,255,255,${sp * 0.5})`;
      ctx.lineWidth = 2;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + t;
        ctx.beginPath();
        ctx.moveTo(pac.x + Math.cos(a) * r * 0.6, pac.y + Math.sin(a) * r * 0.6);
        ctx.lineTo(pac.x + Math.cos(a) * r * 0.9, pac.y + Math.sin(a) * r * 0.9);
        ctx.stroke();
      }
    } else {
      // POP: flash, shockwave, yellow shards + raining pellets.
      const bp = (ep - POP) / (1 - POP);
      if (bp < 0.3) {
        const fp = bp / 0.3;
        const fr = bigR + fp * 200;
        const flash = ctx.createRadialGradient(pac.x, pac.y, 0, pac.x, pac.y, fr);
        flash.addColorStop(0, `rgba(255,255,210,${0.9 * (1 - fp)})`);
        flash.addColorStop(0.5, `rgba(255,230,0,${0.5 * (1 - fp)})`);
        flash.addColorStop(1, 'rgba(255,180,0,0)');
        ctx.fillStyle = flash;
        ctx.beginPath();
        ctx.arc(pac.x, pac.y, fr, 0, TAU);
        ctx.fill();
      }
      // Shockwave ring.
      const wr = bp * 260;
      ctx.strokeStyle = `rgba(255,230,0,${0.6 * (1 - bp)})`;
      ctx.lineWidth = 5 * (1 - bp);
      ctx.beginPath();
      ctx.arc(pac.x, pac.y, wr, 0, TAU);
      ctx.stroke();
      // Yellow Pac-wedge shards spinning out.
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * TAU + 0.2;
        const dist = bp * (80 + ((i * 17) % 60));
        const sx = pac.x + Math.cos(a) * dist;
        const sy = pac.y + Math.sin(a) * dist + bp * bp * 40; // gravity
        const alpha = Math.max(0, 1 - bp * 1.2);
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(a + bp * 6);
        ctx.globalAlpha = alpha;
        pacMan(ctx, 0, 0, 6 + (i % 3) * 2, 0, 0.35 * Math.PI);
        ctx.restore();
      }
      // Eaten pellets raining back out.
      for (let i = 0; i < pelletCount; i++) {
        const a = (i / pelletCount) * TAU + 1.1;
        const dist = bp * (50 + ((i * 23) % 70));
        const px = pac.x + Math.cos(a) * dist;
        const py = pac.y + Math.sin(a) * dist + bp * bp * 55;
        drawPellet(ctx, px, py, 5, Math.max(0, 1 - bp * 1.3));
      }
      ctx.globalAlpha = 1;
    }
  }

  banner();
}

// A glossy white ping-pong pellet.
function drawPellet(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(1, '#cdd6e6');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Draw a Pac-Man: a yellow disk with a wedge mouth cut out, mouth pointed along
// `facing` (radians) and opened by `mouth` (radians, 0 = closed).
function pacMan(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  facing: number,
  mouth: number,
) {
  ctx.save();
  ctx.fillStyle = '#ffe600';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.arc(x, y, r, facing + mouth, facing + Math.PI * 2 - mouth);
  ctx.closePath();
  ctx.fill();
  // Eye: up and slightly toward the front.
  const ex = x + Math.cos(facing) * r * 0.2;
  const ey = y - r * 0.45;
  ctx.fillStyle = '#0b1020';
  ctx.beginPath();
  ctx.arc(ex, ey, Math.max(1.2, r * 0.12), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Path a rounded rectangle (used for the paddle→Pac morph).
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// --- Fatality: "Jsav" --------------------------------------------------------
// The losing paddle becomes Jsav's face, which stretches taller and then inflates
// ever bigger and wider — accelerating, jiggling — until it engulfs the court.
function drawJsavStretch(
  ctx: CanvasRenderingContext2D,
  s: StateMsg,
  fx: { side: 'left' | 'right' },
  t: number,
  banner: () => void,
) {
  const loserSide = fx.side === 'left' ? 'right' : 'left';
  const loser = s.paddles[loserSide];

  const MORPH = 0.4; // paddle morphs into the face
  const g = Math.max(0, t - MORPH); // seconds spent growing

  // Background creeps to black as the face takes over the screen.
  ctx.fillStyle = `rgba(2,3,10,${Math.min(0.92, 0.25 + g * 0.5)})`;
  ctx.fillRect(0, 0, COURT.w, COURT.h);

  // Erase the real loser paddle — it's the face now.
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(loser.x - PADDLE.w / 2 - 2, loser.y - loser.h / 2 - 2, PADDLE.w + 4, loser.h + 4);

  // Start recognizably face-shaped (a touch wide, not a thin paddle sliver) so it
  // reads as Jsav from the first frame, then stretch from there.
  const BASE_W = 108;
  const BASE_H = 84;
  // Vertical stretch leads; width catches up and both balloon, accelerating.
  const vGrow = 1 + g * 4.5 + g * g * 3.5;
  const wGrow = 1 + g * 1.1 + g * g * 2.2;
  const jiggle = 1 + Math.sin(t * 20) * 0.04 * Math.min(1, g * 2);
  let w = Math.min(BASE_W * wGrow * jiggle, COURT.w * 2.6);
  let h = Math.min(BASE_H * vGrow * jiggle, COURT.h * 2.6);

  // Recenter from the paddle toward court center as the head swells, so it fills
  // the screen rather than spilling off one wall.
  const drift = Math.min(1, g / 1.4);
  const cx = loser.x + (COURT.w / 2 - loser.x) * drift;
  const cy = loser.y + (COURT.h / 2 - loser.y) * drift;

  // Mild zoom-shake as it gets huge, for that unsettling in-your-face energy.
  const shake = Math.min(8, g * 4);
  const sx = cx + Math.sin(t * 47) * shake;
  const sy = cy + Math.cos(t * 39) * shake;

  if (jsavReady()) {
    // Fade the image in over the paddle during the morph, then full opacity.
    ctx.globalAlpha = Math.min(1, t / MORPH);
    ctx.drawImage(jsavImg, sx - w / 2, sy - h / 2, w, h);
    ctx.globalAlpha = 1;
  } else {
    // Fallback if the image hasn't loaded: a stretching colored block.
    ctx.fillStyle = loser.color;
    ctx.fillRect(sx - w / 2, sy - h / 2, w, h);
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
