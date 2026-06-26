// Pure drawing: takes the latest server state and paints one frame. No game logic.

import { COURT, PADDLE, BALL, BIG_BALL_R, BLASTER, DIAMOND, PINATA, TARGET, BREAKOUT, BUMPER, BUMPER_POSITIONS, COSMETICS, EXCLUSIVES, PowerupKind, StateMsg, PolyState, Role, Side } from '../shared/types';

// The display flair for an equipped title id (e.g. 'davisslayer' → '🏆 Davis Slayer'), or ''.
// Also searches EXCLUSIVES for exclusive titles (e.g. 'x-founder' → '🪙 Founder').
function titleFlair(id: string | null | undefined): string {
  if (!id) return '';
  const t = COSMETICS.find((c) => c.id === id && c.slot === 'title') ?? EXCLUSIVES.find((e) => e.id === id && e.slot === 'title');
  return t ? t.name : '';
}
// Title flair colour — most are gold; the "Ops Task Duty" title cycles the rainbow.
function titleColor(id: string | null | undefined): string {
  return id === 'opstask' ? `hsl(${(Date.now() / 10) % 360},90%,62%)` : '#ffd166';
}

const fritzImg = new Image();
fritzImg.src = '/fritz.jpg';
// "minion" power-up: both paddles are drawn as this image for the point.
const minionImg = new Image();
minionImg.src = '/minion.png';
const minionReady = () => minionImg.complete && minionImg.naturalWidth > 0;

// The local player's live blaster aim, set by main.ts while they hold the power-up.
// Drives the on-court aim line so they can see where a shot will go.
let blasterAim: { side: Side; angle: number } | null = null;
export function setBlasterAim(aim: { side: Side; angle: number } | null) {
  blasterAim = aim;
}

export function draw(ctx: CanvasRenderingContext2D, s: StateMsg, myRole: Role = 'observer') {
  // Arena (free-for-all polygon) mode renders its own court entirely; bail out early.
  if (s.poly) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawPoly(ctx, s, s.poly);
    return;
  }

  // "rotate" power-up: each pickup adds 90° CW. Transforms map court coords into the
  // canvas (portrait for 90°/270°, landscape for 0°/180°).
  if      (s.rotated === 1) ctx.setTransform(0,  1, -1,  0, COURT.h,  0);       // 90° CW
  else if (s.rotated === 2) ctx.setTransform(-1, 0,  0, -1, COURT.w,  COURT.h); // 180°
  else if (s.rotated === 3) ctx.setTransform(0, -1,  1,  0, 0,        COURT.w); // 270° CW
  else                      ctx.setTransform(1,  0,  0,  1, 0,        0);       // 0° (normal)

  // Court
  if (s.fritz && fritzImg.complete && fritzImg.naturalWidth > 0) {
    ctx.drawImage(fritzImg, 0, 0, COURT.w, COURT.h);
  } else {
    ctx.fillStyle = '#0b1020';
    ctx.fillRect(0, 0, COURT.w, COURT.h);
  }

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

  // Bumper pegs — drawn under ball/paddles
  if (s.bumpers) drawBumpers(ctx, s.bumperFlash);

  // Spectator-dropped blocks (solid obstacles the ball bounces off)
  for (const bl of s.blocks) drawBlock(ctx, bl.x, bl.y, bl.w, bl.h, bl.angle);

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
  const minionOn = s.minion && minionReady();
  for (const side of ['left', 'right'] as const) {
    const p = s.paddles[side];
    if (p.players.length) {
      for (const pl of p.players) {
        // Paddle trail (drawn under the paddle). Skipped while locked or minion-morphed.
        if (pl.trail && !p.disabled && !minionOn) drawTrail(ctx, `${side}:${pl.id}`, pl.x, pl.y, p.h, pl.trail);
        if (minionOn) {
          drawMinionPaddle(ctx, pl.x, pl.y, p.h);
        } else {
          // Cosmetic skin (a registered renderer) or solid color; locked paddles go gray.
          const skinFn = !p.disabled && pl.skin ? SKIN_RENDERERS[pl.skin] : undefined;
          if (skinFn) {
            skinFn(ctx, pl.x, pl.y, p.h);
          } else {
            ctx.fillStyle = p.disabled ? '#555a66' : pl.color;
            drawPaddle(ctx, pl.x, pl.y, p.h);
          }
          const hatFn = pl.hat ? HAT_RENDERERS[pl.hat] : undefined;
          if (hatFn) hatFn(ctx, pl.x, pl.y, p.h);
        }
      }
    } else if (minionOn) {
      drawMinionPaddle(ctx, p.x, p.y, p.h);
    } else {
      ctx.fillStyle = p.color;
      drawPaddle(ctx, p.x, p.y, p.h);
    }
    if (p.disabled) drawDisabled(ctx, p.x, p.y, p.h);
  }

  // Blaster: the local player's aim line, then every projectile in flight.
  drawBlaster(ctx, s);

  // Paddle status overlays (frozen, mirrored, curve-ready).
  drawPaddleEffects(ctx, s);

  // Breakout bricks — drawn behind the ball so the ball visually smashes through them.
  if (s.breakout && s.bricks) drawBricks(ctx, s.bricks, s.ballSpeed);

  // Portal wall rings — subtle glow on the top and bottom walls when active.
  if (s.portal) drawPortalWalls(ctx);

  // Ball(s) — colored by whichever paddle last hit them. Extra balls = multi power-up.
  const ballR = s.tinyBall ? 3 : s.bigBall ? BIG_BALL_R : BALL.r;
  for (const b of [s.ball, ...s.extraBalls]) {
    // Fog of war: hide the ball in mid-court (>120px from either paddle face).
    let alpha = s.ghostBall ? 0.12 : 1;
    if (s.fog && !s.ghostBall) {
      const distLeft  = b.x - s.paddles.left.x;
      const distRight = s.paddles.right.x - b.x;
      const nearest = Math.min(distLeft, distRight);
      if (nearest > 240) alpha = 0;
      else if (nearest > 120) alpha = 1 - (nearest - 120) / 120;
    }
    ctx.globalAlpha = alpha;
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

  // Player names along the bottom, with the lead player's equipped title as flair.
  const leftId = s.paddles.left.players[0]?.title;
  const rightId = s.paddles.right.players[0]?.title;
  const leftTitle = titleFlair(leftId);
  const rightTitle = titleFlair(rightId);
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  let lx = 16;
  ctx.fillStyle = '#9fb0d8';
  ctx.font = '16px system-ui, sans-serif';
  const leftName = s.paddles.left.name ?? '— open —';
  ctx.fillText(leftName, lx, COURT.h - 12);
  if (leftTitle) {
    lx += ctx.measureText(leftName).width + 8;
    ctx.fillStyle = titleColor(leftId);
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(leftTitle, lx, COURT.h - 13);
  }
  ctx.textAlign = 'right';
  let rx = COURT.w - 16;
  ctx.fillStyle = '#9fb0d8';
  ctx.font = '16px system-ui, sans-serif';
  const rightName = s.paddles.right.name ?? '— open —';
  ctx.fillText(rightName, rx, COURT.h - 12);
  if (rightTitle) {
    rx -= ctx.measureText(rightName).width + 8;
    ctx.fillStyle = titleColor(rightId);
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(rightTitle, rx, COURT.h - 13);
  }

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

// --- Arena (free-for-all polygon) ---------------------------------------------
// Each player owns one edge of a regular N-gon; their paddle slides along it. A ball
// caroms around the inside; slip past a living edge and you're knocked out (your edge
// becomes a solid wall). At 8 players the court is dressed up as a stop sign.
function drawPoly(ctx: CanvasRenderingContext2D, s: StateMsg, poly: PolyState) {
  ctx.fillStyle = '#0b1020';
  ctx.fillRect(0, 0, COURT.w, COURT.h);

  const { verts, players, n, stopSign } = poly;
  if (!verts.length) return;

  // Court face: a red stop-sign at 8 players, otherwise the usual deep-navy court.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(verts[0].x, verts[0].y);
  for (let i = 1; i < n; i++) ctx.lineTo(verts[i].x, verts[i].y);
  ctx.closePath();
  ctx.fillStyle = stopSign ? '#c8102e' : '#0e1530';
  ctx.shadowColor = stopSign ? 'rgba(255,80,80,0.5)' : 'rgba(90,120,220,0.25)';
  ctx.shadowBlur = 22;
  ctx.fill();
  ctx.shadowBlur = 0;
  // Stop signs get the iconic thick white rim (doubled up); other courts a subtle edge.
  ctx.strokeStyle = stopSign ? '#ffffff' : '#23335c';
  ctx.lineWidth = stopSign ? 6 : 2.5;
  ctx.stroke();
  if (stopSign) {
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(verts[0].x, verts[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(verts[i].x, verts[i].y);
    ctx.closePath();
    ctx.stroke();
    // The word every stop sign needs.
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.font = 'bold 86px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('STOP', poly.cx, poly.cy);
  }
  ctx.restore();

  // Eliminated edges read as solid walls; living edges carry the player's paddle.
  for (let i = 0; i < n; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    const pl = players[i];
    if (!pl) continue;
    if (!pl.alive) {
      ctx.save();
      ctx.strokeStyle = stopSign ? '#7a0c1d' : '#39477a';
      ctx.lineWidth = 8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Power-up target + ball(s), same look as the classic court.
  if (s.target) drawTarget(ctx, s.target.x, s.target.y, s.target.kind);

  // Paddles: a rounded bar lying along each living edge, in the player's color.
  for (let i = 0; i < n; i++) {
    const pl = players[i];
    if (!pl || !pl.alive) continue;
    drawPolyPaddle(ctx, poly, pl);
  }

  // Names, just outside each edge midpoint.
  ctx.font = '14px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const pl = players[i];
    if (!pl) continue;
    const a = verts[i];
    const b = verts[(i + 1) % n];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    // Outward direction = away from center.
    let ox = mx - poly.cx;
    let oy = my - poly.cy;
    const ol = Math.hypot(ox, oy) || 1;
    ox /= ol;
    oy /= ol;
    const tx = mx + ox * 18;
    const ty = my + oy * 18;
    ctx.fillStyle = pl.alive ? pl.color : '#5a648a';
    ctx.textAlign = ox > 0.3 ? 'left' : ox < -0.3 ? 'right' : 'center';
    ctx.fillText(pl.alive ? pl.name : `☠ ${pl.name}`, tx, ty);
  }

  // Ball(s).
  const ballR = s.tinyBall ? 3 : s.bigBall ? BIG_BALL_R : BALL.r;
  ctx.globalAlpha = s.ghostBall ? 0.12 : 1;
  for (const ball of [s.ball, ...s.extraBalls]) {
    ctx.fillStyle = ball.color;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ballR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Alive count, top-left; winner banner when the round is over.
  ctx.fillStyle = '#9fb0d8';
  ctx.font = '14px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`${poly.aliveCount} / ${n} alive`, 14, 12);

  if (s.status === 'over' && poly.winner) {
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#ffd23f';
    ctx.font = 'bold 40px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#ffd23f';
    ctx.shadowBlur = 20;
    ctx.fillText(`🏆 ${poly.winner}`, poly.cx, poly.cy);
    ctx.restore();
  }
}

// One arena paddle: a thick rounded bar straddling its edge, pushed inward, in the
// player's color. Shows a gold glow when shielded and a curve tick when curve is armed.
function drawPolyPaddle(ctx: CanvasRenderingContext2D, poly: PolyState, pl: PolyState['players'][number]) {
  const dx = Math.cos(pl.angle);
  const dy = Math.sin(pl.angle);
  // Inward normal: toward the polygon center from the paddle's spot on the edge.
  let nx = poly.cx - pl.cx;
  let ny = poly.cy - pl.cy;
  const nl = Math.hypot(nx, ny) || 1;
  nx /= nl;
  ny /= nl;
  const half = pl.len / 2;
  const t = PADDLE.w; // thickness, extending inward from the edge
  const x1 = pl.cx - dx * half;
  const y1 = pl.cy - dy * half;
  const x2 = pl.cx + dx * half;
  const y2 = pl.cy + dy * half;

  ctx.save();
  if (pl.shielded) {
    ctx.shadowColor = '#f5cc00';
    ctx.shadowBlur = 16;
  }
  ctx.fillStyle = pl.color;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x2 + nx * t, y2 + ny * t);
  ctx.lineTo(x1 + nx * t, y1 + ny * t);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  if (pl.shielded) {
    ctx.save();
    ctx.strokeStyle = '#f5cc00';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }
  if (pl.curveReady) {
    ctx.save();
    ctx.strokeStyle = '#7ddc4a';
    ctx.lineWidth = 2;
    const mx = pl.cx + nx * (t + 8);
    const my = pl.cy + ny * (t + 8);
    ctx.beginPath();
    ctx.arc(mx, my, 6, 0, Math.PI);
    ctx.stroke();
    ctx.restore();
  }
}

// Breakout mode: draw the surviving bricks as a vertical wall down the centre.
// Colour cycles in bands of 4 rows: blue → teal → amber → red (top → bottom).
const BRICK_HUES = [210, 170, 35, 0];

function drawBricks(ctx: CanvasRenderingContext2D, bricks: boolean[], ballSpeed: number) {
  const { cols, rows, w, h, gap, left, top } = BREAKOUT;
  // Before the first paddle hit the ball phases through — signal that with a
  // ghostly low-opacity render so players know the wall is "warming up".
  const phasing = ballSpeed === 0;
  ctx.save();
  ctx.globalAlpha = phasing ? 0.28 : 1;
  for (let row = 0; row < rows; row++) {
    const hue = BRICK_HUES[Math.floor(row / 2) % BRICK_HUES.length];
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      if (!bricks[idx]) continue;
      const bx = left + col * (w + gap);
      const by = top  + row * (h + gap);
      // Body
      ctx.fillStyle = `hsl(${hue}, 68%, 42%)`;
      ctx.beginPath();
      (ctx as CanvasRenderingContext2D & { roundRect?: (...a: unknown[]) => void }).roundRect?.(bx, by, w, h, 3) ?? ctx.rect(bx, by, w, h);
      ctx.fill();
      // Top-left highlight
      ctx.fillStyle = `hsla(${hue}, 75%, 75%, 0.50)`;
      ctx.fillRect(bx + 2, by + 2, w - 4, 3);
      // Bottom shadow
      ctx.fillStyle = `hsla(${hue}, 45%, 18%, 0.45)`;
      ctx.fillRect(bx + 2, by + h - 3, w - 4, 3);
    }
  }
  ctx.restore();
}

// Portal walls mode: draw glowing rings on the top and bottom walls.
function drawPortalWalls(ctx: CanvasRenderingContext2D) {
  const t = performance.now() / 1000;
  for (const wallY of [0, COURT.h]) {
    const ySign = wallY === 0 ? 1 : -1;
    const pulse = 0.55 + 0.45 * Math.sin(t * 3 + (wallY === 0 ? 0 : Math.PI));
    ctx.save();
    // Glow
    ctx.shadowBlur = 24 * pulse;
    ctx.shadowColor = `hsla(270, 90%, 70%, ${pulse})`;
    ctx.strokeStyle = `hsla(270, 90%, 75%, ${0.55 + 0.45 * pulse})`;
    ctx.lineWidth = 3;
    // Three staggered ovals along the wall
    for (let i = 0; i < 3; i++) {
      const cx = COURT.w * (0.25 + i * 0.25);
      const cy = wallY + ySign * 6;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 36, 8, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

// Bumper pegs — neon orange circles that flash white when hit.
const bumperHitAt: number[] = BUMPER_POSITIONS.map(() => -1e9);
function drawBumpers(ctx: CanvasRenderingContext2D, flash: boolean[]) {
  const now = performance.now();
  for (let i = 0; i < BUMPER_POSITIONS.length; i++) {
    if (flash[i]) bumperHitAt[i] = now;
    const { x, y } = BUMPER_POSITIONS[i];
    const t = Math.max(0, 1 - (now - bumperHitAt[i]) / 220); // 0..1 flash intensity
    const r = BUMPER.r;
    ctx.save();
    // Outer glow ring
    ctx.beginPath();
    ctx.arc(x, y, r + 4 + t * 8, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,120,20,${0.18 + t * 0.35})`;
    ctx.fill();
    // Body gradient
    const grad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
    grad.addColorStop(0, t > 0.05 ? `rgba(255,255,220,${0.9 + t * 0.1})` : '#ff8c30');
    grad.addColorStop(1, t > 0.05 ? `rgba(255,160,60,${0.95})` : '#c03a00');
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.shadowColor = t > 0.05 ? '#ffffc0' : '#ff6010';
    ctx.shadowBlur = 10 + t * 22;
    ctx.fill();
    // Shine dot
    ctx.beginPath();
    ctx.arc(x - r * 0.32, y - r * 0.32, r * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${0.45 + t * 0.4})`;
    ctx.shadowBlur = 0;
    ctx.fill();
    ctx.restore();
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

// A stable, varied hue for a spectator block, derived from its (fixed) position so its
// color never flickers as other blocks come and go. Shared with the 3D renderer.
export function blockHue(x: number, y: number): number {
  return ((Math.round(x) * 49 + Math.round(y) * 17) % 360 + 360) % 360;
}

// A spectator-dropped block, drawn exactly like a breakout brick — a colorful rounded
// rectangle with a top highlight and bottom shadow bar. Centered on (x, y).
function drawBlock(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, angle?: number) {
  const hue = blockHue(x, y);
  const r = Math.min(6, Math.min(w, h) * 0.18);
  const bar = Math.max(3, h * 0.08);
  ctx.save();
  if (angle) { ctx.translate(x, y); ctx.rotate(angle); ctx.translate(-x, -y); }
  const left = x - w / 2, top = y - h / 2;
  // Body
  ctx.fillStyle = `hsl(${hue}, 68%, 48%)`;
  ctx.beginPath();
  (ctx as CanvasRenderingContext2D & { roundRect?: (...a: unknown[]) => void }).roundRect?.(left, top, w, h, r) ?? ctx.rect(left, top, w, h);
  ctx.fill();
  // Top highlight
  ctx.fillStyle = `hsla(${hue}, 75%, 78%, 0.55)`;
  ctx.fillRect(left + 2, top + 2, w - 4, bar);
  // Bottom shadow
  ctx.fillStyle = `hsla(${hue}, 45%, 18%, 0.45)`;
  ctx.fillRect(left + 2, top + h - 2 - bar, w - 4, bar);
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

// Clip context to the paddle's rounded-pill shape so all skin fills stay within clean edges.
function clipPaddle(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const x = cx - PADDLE.w / 2, y = cy - h / 2, r = PADDLE.w / 2;
  ctx.beginPath();
  ctx.roundRect(x, y, PADDLE.w, h, r);
  ctx.clip();
}

// Subtle inner-edge highlight painted over every skin to add a sense of depth.
function skinHighlight(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const x = cx - PADDLE.w / 2, y = cy - h / 2;
  const hi = ctx.createLinearGradient(x, 0, x + PADDLE.w, 0);
  hi.addColorStop(0, 'rgba(255,255,255,0.30)');
  hi.addColorStop(0.35, 'rgba(255,255,255,0.08)');
  hi.addColorStop(1, 'rgba(0,0,0,0.20)');
  ctx.fillStyle = hi;
  ctx.fillRect(x, y, PADDLE.w, h);
}

// Cosmetic "rainbow" skin — animated: colours scroll down the paddle over time.
function fillRainbow(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save();
  clipPaddle(ctx, cx, cy, h);
  const top = cy - h / 2;
  const offset = (Date.now() / 10) % h;
  // draw twice so the scrolling loop wraps seamlessly
  for (const dy of [0, h]) {
    const g = ctx.createLinearGradient(0, top - offset + dy, 0, top - offset + dy + h);
    ['#ff3b30', '#ff9500', '#ffd60a', '#34c759', '#0a84ff', '#5e5ce6', '#bf5af2', '#ff3b30']
      .forEach((c, i, a) => g.addColorStop(i / (a.length - 1), c));
    ctx.fillStyle = g;
    ctx.fillRect(cx - PADDLE.w / 2, top, PADDLE.w, h);
  }
  skinHighlight(ctx, cx, cy, h);
  ctx.restore();
}

// Cosmetic "hot dog" skin (the Ruins vault-floor prize): a bun-wrapped sausage running the length of
// the paddle, with squiggles of ketchup + mustard down it.
function fillHotdog(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save();
  clipPaddle(ctx, cx, cy, h);
  const x = cx - PADDLE.w / 2, y = cy - h / 2, w = PADDLE.w;
  // bun (toasted, shaded toward the edges)
  const bun = ctx.createLinearGradient(x, 0, x + w, 0);
  bun.addColorStop(0, '#b07a36'); bun.addColorStop(0.5, '#ecc079'); bun.addColorStop(1, '#b07a36');
  ctx.fillStyle = bun; ctx.fillRect(x, y, w, h);
  // sausage down the middle
  const sw = w * 0.6, sx = cx - sw / 2;
  const saus = ctx.createLinearGradient(sx, 0, sx + sw, 0);
  saus.addColorStop(0, '#7c271a'); saus.addColorStop(0.4, '#c2503a'); saus.addColorStop(1, '#7c271a');
  ctx.fillStyle = saus; ctx.beginPath(); ctx.roundRect(sx, y + 2, sw, h - 4, sw / 2); ctx.fill();
  // ketchup + mustard squiggles
  const zig = (color: string, phase: number) => {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.5, sw * 0.15); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let yy = y + 5; yy <= y + h - 5; yy += 3) {
      const xx = cx + Math.sin(yy * 0.45 + phase) * sw * 0.2;
      if (yy === y + 5) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
    }
    ctx.stroke();
  };
  zig('#e8362a', 0);          // ketchup
  zig('#f6c61b', Math.PI);    // mustard
  skinHighlight(ctx, cx, cy, h);
  ctx.restore();
}

// Cosmetic registries — add new skins/hats here (id must match shared/types COSMETICS).
// Each draws purely visual decoration on the paddle; none affect the ball's collision.
type CosmeticDraw = (ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) => void;
const SKIN_RENDERERS: Record<string, CosmeticDraw> = {
  'skin-hotdog': fillHotdog,
  rainbow: fillRainbow,
  gold: fillGold,
  chrome: fillChrome,
  galaxy: fillGalaxy,
  lava: fillLava,
  ice: fillIce,
  camo: fillCamo,
  neon: fillNeon,
  stripes: fillStripes,
  glitch: fillGlitch,
  toxic: fillToxic,
  plasma: fillPlasma,
  wood: fillWood,
  hologram: fillHologram,
  venom: fillVenom,
  pickle: fillPickle,
  obsidian: fillObsidian,
  aurora: fillAurora,
  carbon: fillCarbon,
  mermaid: fillMermaid,
  'x-midas': fillMidas,
  'x-genesis': fillGenesis,
  'x-quantum': fillQuantum,
};
// Draw a live skin/hat preview onto a small canvas element (used in the shop UI).
// The canvas is scaled so the paddle fills it, then the skin is applied at full quality.
// Paddle trails: a soft, tapered streak of glowing blobs along the paddle's recent path.
// Each tint returns a solid color (alpha is applied separately so the trail stays translucent);
// animated styles use the time arg. Glowy styles blend additively for a light-trail look.
type TrailTint = (i: number, n: number, t: number) => string;
const TRAIL_TINTS: Record<string, TrailTint> = {
  comet: () => '#ff9632',
  frostwake: () => '#7adcff',
  shadow: () => '#14142a',
  ember: () => '#ff4619',
  neonstreak: () => '#ff3cdc',
  rainbowtrail: (i, _n, t) => `hsl(${(t / 12 + i * 26) % 360},92%,62%)`,
  stardust: (i) => (i % 2 ? '#ffffff' : '#9fd8ff'),
  inferno: (i, n) => `hsl(${20 + (i / n) * 35},100%,${50 + (i / n) * 12}%)`, // red tail → yellow head
  lightning: () => '#8ab4ff',
  phoenix: (i, _n, t) => `hsl(${(t / 14 + i * 18) % 60},100%,58%)`, // animated red↔gold fire
  // --- exclusive trails ---
  'x-eclipse': (i, n, t) => {
    const f = i / n;
    const pulse = 0.5 + 0.5 * Math.sin(t / 700 + i * 0.5);
    // Tail: deep void-violet → Head: blazing corona gold, with slow pulse
    const hue = 260 - f * 215;               // violet at tail → gold at head
    const light = 18 + f * 42 + pulse * 12;  // dark → blazing, animated
    return `hsl(${hue},100%,${light}%)`;
  },
  'x-singularity': (i, n, t) => {
    const f = i / n;
    // Spaghettification ring: white-hot at center → deep space blue at edges, with a rotating hue
    const hue = (t / 20 + 240 + f * 120) % 360;
    const light = 30 + f * 50 + 15 * Math.sin(t / 400 + i * 0.7);
    const sat = 70 + f * 30;
    return `hsl(${hue},${sat}%,${light}%)`;
  },
};
const TRAIL_GLOW = new Set(['comet', 'frostwake', 'ember', 'neonstreak', 'rainbowtrail', 'stardust', 'inferno', 'lightning', 'phoenix', 'x-eclipse', 'x-singularity']); // additive blend
const TRAIL_LEN = 14; // samples of paddle history kept for the streak
const trailHistory = new Map<string, { x: number; y: number }[]>();
function drawTrail(ctx: CanvasRenderingContext2D, key: string, cx: number, cy: number, h: number, id: string) {
  const tint = TRAIL_TINTS[id];
  if (!tint) return;
  let hist = trailHistory.get(key);
  if (!hist) { hist = []; trailHistory.set(key, hist); }
  hist.push({ x: cx, y: cy });
  if (hist.length > TRAIL_LEN) hist.shift();
  if (hist.length < 3) return;
  // Interpolate between samples so the streak reads as continuous, not stepped.
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < hist.length - 1; i++) {
    const a = hist[i], b = hist[i + 1];
    pts.push(a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
  const n = pts.length;
  const t = performance.now();
  const glow = TRAIL_GLOW.has(id);
  ctx.save();
  if (glow) ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const f = (i + 1) / n;                 // 0 → tail, 1 → head
    const alpha = 0.3 * Math.pow(f, 1.5);  // translucent, fading toward the tail
    if (alpha < 0.012) continue;
    const w = PADDLE.w * (0.3 + 0.7 * f);  // taper narrower toward the tail
    const hh = h * (0.5 + 0.5 * f);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = tint(i, n, t);
    ctx.beginPath();
    ctx.ellipse(pts[i].x, pts[i].y, w / 2, hh / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawCosmeticPreview(canvas: HTMLCanvasElement, id: string, slot: 'hat' | 'skin' | 'trail') {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  // Court-coordinate paddle
  const pH = PADDLE.h * 0.7; // slightly shorter so caps show
  const scale = H / (pH + PADDLE.w * 2); // fit vertically with some headroom for hats
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(scale, scale);
  const cx = 0, cy = 0, h = pH;
  if (slot === 'trail') {
    // A soft tapered streak trailing upward, then the paddle — suggests motion.
    const tint = TRAIL_TINTS[id];
    const glow = TRAIL_GLOW.has(id);
    const n = 6;
    ctx.save();
    if (glow) ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < n; i++) {
      const f = (i + 1) / n;
      ctx.globalAlpha = 0.32 * Math.pow(f, 1.4);
      ctx.fillStyle = tint ? tint(i, n, 0) : '#888';
      const w = PADDLE.w * (0.3 + 0.7 * f), hh = h * 0.55;
      ctx.beginPath();
      ctx.ellipse(cx, cy - h / 2 + (n - i) * 7, w / 2, hh / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = '#3a6df0';
    ctx.save(); clipPaddle(ctx, cx, cy, h);
    ctx.fillRect(cx - PADDLE.w / 2, cy - h / 2, PADDLE.w, h);
    ctx.restore();
    skinHighlight(ctx, cx, cy, h);
  } else if (slot === 'skin') {
    const fn = SKIN_RENDERERS[id];
    if (fn) {
      fn(ctx, cx, cy, h);
    } else {
      ctx.fillStyle = '#3a6df0';
      ctx.save(); clipPaddle(ctx, cx, cy, h);
      ctx.fillRect(cx - PADDLE.w / 2, cy - h / 2, PADDLE.w, h);
      ctx.restore();
    }
  } else {
    // Draw a plain blue paddle then the hat on top
    ctx.fillStyle = '#3a6df0';
    ctx.save(); clipPaddle(ctx, cx, cy, h);
    ctx.fillRect(cx - PADDLE.w / 2, cy - h / 2, PADDLE.w, h);
    ctx.restore();
    skinHighlight(ctx, cx, cy, h);
    const fn = HAT_RENDERERS[id];
    if (fn) fn(ctx, cx, cy, h);
  }
  ctx.restore();
}

const HAT_RENDERERS: Record<string, CosmeticDraw> = {
  tophat: drawTopHat,
  crown: drawCrown,
  party: drawParty,
  halo: drawHalo,
  cowboy: drawCowboy,
  wizard: drawWizard,
  horns: drawHorns,
  gradcap: drawGradCap,
  flame: drawFlame,
  helmet: drawHelmet,
  antennae: drawAntennae,
  mohawk: drawMohawk,
  bow: drawBow,
  pirate: drawPirate,
  santa: drawSanta,
  headphones: drawHeadphones,
  saturn: drawSaturn,
  propeller: drawPropeller,
  flamingcrown: drawFlamingCrown,
  diamondtiara: drawDiamondTiara,
  'x-jackpot': drawJackpotCrown,
  beret: drawBeret,
  catears: drawCatEars,
  'x-voidcrown': drawVoidCrown,
  'x-prismhalo': drawPrismHalo,
};

// Cosmetic "top hat": a little hat perched at the top end of the paddle. Visual only.
function drawTopHat(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2;
  const brimW = PADDLE.w + 12;
  const crownW = PADDLE.w + 2;
  const crownH = 12;
  const brimH = 3;
  ctx.save();
  ctx.fillStyle = '#15171c';
  // brim sits just above the paddle's top edge
  ctx.fillRect(cx - brimW / 2, top - brimH, brimW, brimH);
  // crown
  ctx.fillRect(cx - crownW / 2, top - brimH - crownH, crownW, crownH);
  // red band
  ctx.fillStyle = '#c0392b';
  ctx.fillRect(cx - crownW / 2, top - brimH - 4, crownW, 3);
  ctx.restore();
}

// --- additional cosmetic hats (all original procedural art; visual only) ---
function drawCrown(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2, w = PADDLE.w + 8, x = cx - w / 2, base = top - 2, ch = 11;
  ctx.save();
  ctx.fillStyle = '#ffd23f';
  ctx.beginPath();
  ctx.moveTo(x, base);
  ctx.lineTo(x, base - ch * 0.6);
  ctx.lineTo(x + w * 0.25, base - 2);
  ctx.lineTo(x + w * 0.5, base - ch);
  ctx.lineTo(x + w * 0.75, base - 2);
  ctx.lineTo(x + w, base - ch * 0.6);
  ctx.lineTo(x + w, base);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ff4d6d';
  ctx.fillRect(x + w * 0.46, base - ch - 2, 3, 3);
  ctx.restore();
}
function drawParty(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2;
  ctx.save();
  ctx.fillStyle = '#ff7eb3';
  ctx.beginPath();
  ctx.moveTo(cx, top - 18);
  ctx.lineTo(cx - 8, top);
  ctx.lineTo(cx + 8, top);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#7dd3fc';
  for (let i = 0; i < 3; i++) ctx.fillRect(cx - 6 + i * 5, top - 12 + i * 3, 2.5, 2.5);
  ctx.fillStyle = '#ffe066';
  ctx.beginPath(); ctx.arc(cx, top - 18, 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function drawHalo(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const bob = Math.sin(Date.now() / 300) * 2;
  const top = cy - h / 2 - 8 + bob;
  ctx.save();
  ctx.strokeStyle = '#ffe066';
  ctx.shadowColor = '#ffe066';
  ctx.shadowBlur = 8;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.ellipse(cx, top, PADDLE.w * 0.7, 3.2, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
// --- Premium hats ---
function drawSaturn(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2 - 11 + Math.sin(Date.now() / 400) * 1.5;
  ctx.save();
  // planet
  const g = ctx.createRadialGradient(cx - 2, top - 2, 1, cx, top, 6);
  g.addColorStop(0, '#ffd9a0'); g.addColorStop(0.6, '#e08a3c'); g.addColorStop(1, '#8a4a18');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, top, 5.5, 0, Math.PI * 2); ctx.fill();
  // tilted ring
  ctx.strokeStyle = '#e9c98a'; ctx.lineWidth = 2;
  ctx.save(); ctx.translate(cx, top); ctx.rotate(-0.5);
  ctx.beginPath(); ctx.ellipse(0, 0, 10, 3, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  ctx.restore();
}
function drawPropeller(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2;
  ctx.save();
  // beanie cap
  ctx.fillStyle = '#e8513b';
  ctx.beginPath(); ctx.arc(cx, top, PADDLE.w * 0.5, Math.PI, 0); ctx.fill();
  ctx.fillStyle = '#ffd23f'; ctx.fillRect(cx - PADDLE.w * 0.5, top - 1, PADDLE.w, 2);
  // spinning propeller
  const a = Date.now() / 90;
  ctx.translate(cx, top - 8); ctx.rotate(a);
  ctx.fillStyle = '#6cc1ff';
  for (const d of [0, Math.PI]) {
    ctx.save(); ctx.rotate(d);
    ctx.beginPath(); ctx.ellipse(7, 0, 7, 2.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = '#ffd23f';
  ctx.beginPath(); ctx.arc(0, 0, 1.8, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function drawFlamingCrown(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2, w = PADDLE.w + 4;
  ctx.save();
  ctx.fillStyle = '#ffd23f';
  ctx.fillRect(cx - w / 2, top - 6, w, 5);
  ctx.beginPath();
  for (let i = 0; i < 3; i++) { const sx = cx - w / 2 + (i + 0.5) * (w / 3); ctx.moveTo(sx - 3, top - 6); ctx.lineTo(sx, top - 12); ctx.lineTo(sx + 3, top - 6); }
  ctx.fill();
  const fl = Math.abs(Math.sin(Date.now() / 120));
  ctx.shadowColor = '#ff5a1c'; ctx.shadowBlur = 10;
  for (let i = 0; i < 3; i++) {
    const sx = cx - w / 2 + (i + 0.5) * (w / 3);
    ctx.fillStyle = i % 2 ? '#ff7a1c' : '#ffb01c';
    ctx.beginPath(); ctx.moveTo(sx - 3, top - 11); ctx.quadraticCurveTo(sx, top - 18 - fl * 5, sx + 3, top - 11); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}
function drawDiamondTiara(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2, w = PADDLE.w + 6;
  ctx.save();
  ctx.strokeStyle = '#dfe7f5'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(cx - w / 2, top - 2); ctx.quadraticCurveTo(cx, top - 9, cx + w / 2, top - 2); ctx.stroke();
  const spark = 0.6 + 0.4 * Math.abs(Math.sin(Date.now() / 200));
  ctx.shadowColor = '#bfe0ff'; ctx.shadowBlur = 8 * spark;
  const gx = [cx - w * 0.32, cx, cx + w * 0.32], gyv = [top - 4, top - 9, top - 4];
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i === 1 ? '#9fe0ff' : '#eaf4ff';
    ctx.beginPath(); ctx.moveTo(gx[i], gyv[i] - 3); ctx.lineTo(gx[i] + 2.4, gyv[i]); ctx.lineTo(gx[i], gyv[i] + 3); ctx.lineTo(gx[i] - 2.4, gyv[i]); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}
// --- Loot-box refresh hats ---
function drawBeret(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2, w = PADDLE.w + 10;
  ctx.save();
  ctx.fillStyle = '#c41e3a';
  ctx.beginPath();
  ctx.ellipse(cx, top - 4, w / 2, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#8a1528';
  ctx.fillRect(cx - w / 2, top - 1, w, 3);
  ctx.fillStyle = '#5a0e1a';
  ctx.fillRect(cx - 1.5, top - 12, 3, 4);
  ctx.restore();
}
function drawCatEars(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2, t = Date.now() / 300;
  ctx.save();
  const wiggle = Math.sin(t) * 1.5;
  ctx.fillStyle = '#2a1a3a';
  ctx.beginPath();
  ctx.moveTo(cx - 10, top - 2);
  ctx.lineTo(cx - 14 + wiggle, top - 16);
  ctx.lineTo(cx - 4 + wiggle, top - 2);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx + 10, top - 2);
  ctx.lineTo(cx + 14 - wiggle, top - 16);
  ctx.lineTo(cx + 4 - wiggle, top - 2);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#ff9eb5';
  ctx.beginPath();
  ctx.moveTo(cx - 8, top - 3);
  ctx.lineTo(cx - 11 + wiggle, top - 12);
  ctx.lineTo(cx - 5 + wiggle, top - 3);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx + 8, top - 3);
  ctx.lineTo(cx + 11 - wiggle, top - 12);
  ctx.lineTo(cx + 5 - wiggle, top - 3);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}
function drawJackpotCrown(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2, w = PADDLE.w + 8, t = Date.now() / 400;
  ctx.save();
  const gold = `hsl(${45 + Math.sin(t) * 5},90%,${55 + Math.sin(t * 1.3) * 8}%)`;
  ctx.fillStyle = gold;
  ctx.shadowColor = '#ffd700';
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, top - 2);
  for (let i = 0; i < 5; i++) {
    const px = cx - w / 2 + (w / 4) * i;
    const py = (i % 2 === 0) ? top - 14 : top - 4;
    ctx.lineTo(px, py);
  }
  ctx.lineTo(cx + w / 2, top - 2);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur = 0;
  for (let i = 0; i < 3; i++) {
    const gx = cx - w / 4 + (w / 4) * i;
    const gy = top - 10 + Math.sin(t + i * 2) * 1.5;
    const hue = (t * 50 + i * 120) % 360;
    ctx.fillStyle = `hsl(${hue},95%,60%)`;
    ctx.shadowColor = `hsl(${hue},95%,60%)`;
    ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.arc(gx, gy, 2.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
// --- Exclusive hats ---
function drawVoidCrown(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2, w = PADDLE.w + 6, x = cx - w / 2, t = Date.now() / 600;
  ctx.save();
  ctx.fillStyle = '#0a0012';
  ctx.shadowColor = '#6a00b0';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(x, top - 2);
  ctx.lineTo(x + w * 0.2, top - 14);
  ctx.lineTo(x + w * 0.35, top - 6);
  ctx.lineTo(x + w * 0.5, top - 18);
  ctx.lineTo(x + w * 0.65, top - 6);
  ctx.lineTo(x + w * 0.8, top - 14);
  ctx.lineTo(x + w, top - 2);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  for (let i = 0; i < 4; i++) {
    const px = cx + Math.sin(t + i * 2) * w * 0.3;
    const py = top - 8 + Math.cos(t * 1.3 + i) * 6;
    const size = 1.2 + 0.8 * Math.sin(t + i * 1.7);
    ctx.fillStyle = i % 2 ? '#c77dff' : '#9b30ff';
    ctx.beginPath(); ctx.arc(px, py, size, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
function drawPrismHalo(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const t = Date.now() / 500;
  const bob = Math.sin(t * 0.7) * 2;
  const top = cy - h / 2 - 7 + bob;
  ctx.save();
  ctx.translate(cx, top);
  ctx.rotate(t * 0.3);
  ctx.lineWidth = 2.8;
  ctx.strokeStyle = `hsl(${(t * 45) % 360},95%,62%)`;
  ctx.shadowColor = `hsl(${(t * 45 + 120) % 360},95%,62%)`;
  ctx.shadowBlur = 14;
  ctx.beginPath(); ctx.ellipse(0, 0, PADDLE.w * 0.7, 4, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.rotate(-t * 0.6);
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = `hsl(${(t * 45 + 180) % 360},90%,72%)`;
  ctx.shadowColor = `hsl(${(t * 45 + 300) % 360},90%,72%)`;
  ctx.beginPath(); ctx.ellipse(0, 0, PADDLE.w * 0.55, 3, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}
function drawCowboy(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2, brimW = PADDLE.w + 16;
  ctx.save();
  ctx.fillStyle = '#8a5a2b';
  ctx.beginPath();
  ctx.ellipse(cx, top - 2, brimW / 2, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#704821';
  ctx.fillRect(cx - (PADDLE.w) / 2, top - 11, PADDLE.w, 9);
  ctx.restore();
}
function drawWizard(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2;
  ctx.save();
  ctx.fillStyle = '#3b2e7e';
  ctx.beginPath();
  ctx.moveTo(cx, top - 22);
  ctx.lineTo(cx - 9, top);
  ctx.lineTo(cx + 9, top);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ffe066';
  ctx.fillRect(cx - 1, top - 12, 2, 2);
  ctx.fillRect(cx + 3, top - 7, 2, 2);
  ctx.fillRect(cx - 4, top - 5, 2, 2);
  ctx.restore();
}
function drawHorns(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2;
  ctx.save();
  ctx.fillStyle = '#c0392b';
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + dir * 4, top);
    ctx.quadraticCurveTo(cx + dir * 10, top - 4, cx + dir * 9, top - 11);
    ctx.quadraticCurveTo(cx + dir * 5, top - 5, cx + dir * 1, top);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
function drawGradCap(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2;
  ctx.save();
  ctx.fillStyle = '#15171c';
  ctx.fillRect(cx - PADDLE.w / 2, top - 7, PADDLE.w, 5); // band
  ctx.beginPath();
  ctx.moveTo(cx, top - 14);
  ctx.lineTo(cx - 12, top - 8);
  ctx.lineTo(cx, top - 4);
  ctx.lineTo(cx + 12, top - 8);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#ffd23f';
  ctx.beginPath(); ctx.moveTo(cx + 10, top - 8); ctx.lineTo(cx + 10, top + 1); ctx.stroke();
  ctx.restore();
}
function drawFlame(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2;
  const t = Date.now() / 90;
  ctx.save();
  for (let i = 0; i < 3; i++) {
    const sway = Math.sin(t + i) * 2;
    const fh = 14 - i * 4;
    ctx.fillStyle = i === 0 ? '#ff4d1c' : i === 1 ? '#ff922b' : '#ffe066';
    ctx.beginPath();
    ctx.moveTo(cx - 5 + i, top);
    ctx.quadraticCurveTo(cx + sway, top - fh, cx + 5 - i, top);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
function drawHelmet(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2;
  ctx.save();
  ctx.fillStyle = '#5a7d3a';
  ctx.beginPath();
  ctx.arc(cx, top, PADDLE.w * 0.7, Math.PI, 0);
  ctx.fill();
  ctx.fillRect(cx - PADDLE.w * 0.7, top - 1, PADDLE.w * 1.4, 2);
  ctx.restore();
}
function drawAntennae(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2;
  const wob = Math.sin(Date.now() / 200) * 2;
  ctx.save();
  ctx.strokeStyle = '#2a2a33';
  ctx.lineWidth = 1.5;
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + dir * 3, top);
    ctx.quadraticCurveTo(cx + dir * 6, top - 8, cx + dir * 8 + wob * dir, top - 14);
    ctx.stroke();
    ctx.fillStyle = '#ff5c5c';
    ctx.beginPath(); ctx.arc(cx + dir * 8 + wob * dir, top - 15, 2.4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawMohawk(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2;
  ctx.save();
  const colors = ['#ff3b30', '#ff9500', '#ffd60a', '#34c759', '#0a84ff', '#bf5af2'];
  const spikes = 5;
  const sw = PADDLE.w / spikes;
  for (let i = 0; i < spikes; i++) {
    const sx = cx - PADDLE.w / 2 + sw * i + sw / 2;
    const sh = 8 + (i % 2) * 6 + (i === 2 ? 4 : 0);
    ctx.fillStyle = colors[i % colors.length];
    ctx.beginPath();
    ctx.moveTo(sx - sw * 0.4, top);
    ctx.lineTo(sx, top - sh);
    ctx.lineTo(sx + sw * 0.4, top);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
function drawBow(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2 - 3;
  ctx.save();
  ctx.fillStyle = '#ff5c9e';
  // Left loop
  ctx.beginPath();
  ctx.ellipse(cx - 6, top - 5, 6, 4, -0.4, 0, Math.PI * 2);
  ctx.fill();
  // Right loop
  ctx.beginPath();
  ctx.ellipse(cx + 6, top - 5, 6, 4, 0.4, 0, Math.PI * 2);
  ctx.fill();
  // Tails
  ctx.beginPath();
  ctx.moveTo(cx, top - 4);
  ctx.quadraticCurveTo(cx - 8, top + 2, cx - 10, top + 5);
  ctx.lineTo(cx - 7, top + 5);
  ctx.quadraticCurveTo(cx - 5, top + 2, cx, top - 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, top - 4);
  ctx.quadraticCurveTo(cx + 8, top + 2, cx + 10, top + 5);
  ctx.lineTo(cx + 7, top + 5);
  ctx.quadraticCurveTo(cx + 5, top + 2, cx, top - 2);
  ctx.fill();
  // Centre knot
  ctx.fillStyle = '#ff2d7c';
  ctx.beginPath(); ctx.ellipse(cx, top - 4, 2.5, 2.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function drawPirate(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2;
  const brimW = PADDLE.w + 14;
  ctx.save();
  // Brim
  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath();
  ctx.ellipse(cx, top - 1, brimW / 2, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  // Main hat body (tricorn outline shape)
  ctx.beginPath();
  ctx.moveTo(cx - brimW / 2, top - 1);
  ctx.lineTo(cx - 4, top - 16);
  ctx.lineTo(cx, top - 18);
  ctx.lineTo(cx + 4, top - 16);
  ctx.lineTo(cx + brimW / 2, top - 1);
  ctx.closePath();
  ctx.fill();
  // Skull & crossbones
  ctx.fillStyle = '#e8e8e8';
  ctx.beginPath(); ctx.arc(cx, top - 10, 3, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#e8e8e8'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(cx - 3, top - 7); ctx.lineTo(cx + 3, top - 13); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx + 3, top - 7); ctx.lineTo(cx - 3, top - 13); ctx.stroke();
  ctx.restore();
}
function drawSanta(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2;
  ctx.save();
  // White brim band
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(cx - PADDLE.w / 2 - 2, top - 5, PADDLE.w + 4, 4);
  // Red hat body tapering to a point offset right
  ctx.fillStyle = '#d42b2b';
  ctx.beginPath();
  ctx.moveTo(cx - PADDLE.w / 2 - 2, top - 4);
  ctx.lineTo(cx + PADDLE.w / 2 + 2, top - 4);
  ctx.lineTo(cx + 6, top - 20);
  ctx.closePath();
  ctx.fill();
  // White pom-pom
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(cx + 6, top - 20, 3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function drawHeadphones(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const top = cy - h / 2;
  const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 120);
  ctx.save();
  // Arc headband
  ctx.strokeStyle = '#2a2a35';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(cx, top - 4, PADDLE.w * 0.7, Math.PI, 0);
  ctx.stroke();
  // Ear cups — animate their glow
  const cupColor = `hsl(${250 + pulse * 40},80%,${45 + pulse * 20}%)`;
  ctx.fillStyle = cupColor;
  ctx.shadowColor = cupColor; ctx.shadowBlur = 4 + pulse * 6;
  for (const dir of [-1, 1]) {
    const ex = cx + dir * PADDLE.w * 0.7;
    ctx.beginPath(); ctx.ellipse(ex, top - 4, 3.5, 4.5, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// --- additional cosmetic skins (fill the paddle rect; some animated; visual only) ---
function paddleRect(cx: number, cy: number, h: number) {
  return { x: cx - PADDLE.w / 2, y: cy - h / 2, w: PADDLE.w, h };
}
// --- Premium skins ---
function fillObsidian(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save(); clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  const g = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
  g.addColorStop(0, '#05060a'); g.addColorStop(0.5, '#1a1426'); g.addColorStop(1, '#05060a');
  ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
  const t = (Date.now() / 900) % 1, gy = r.y - 16 + (r.h + 32) * t;
  const glint = ctx.createLinearGradient(0, gy - 6, 0, gy + 6);
  glint.addColorStop(0, 'rgba(190,170,255,0)'); glint.addColorStop(0.5, 'rgba(205,185,255,0.5)'); glint.addColorStop(1, 'rgba(190,170,255,0)');
  ctx.fillStyle = glint; ctx.fillRect(r.x, r.y, r.w, r.h);
  skinHighlight(ctx, cx, cy, h); ctx.restore();
}
function fillAurora(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save(); clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  const s = Math.sin(Date.now() / 1000) * 30;
  const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
  g.addColorStop(0, `hsl(${150 + s},80%,55%)`);
  g.addColorStop(0.45, `hsl(${190 + s},85%,55%)`);
  g.addColorStop(0.7, `hsl(${275 + s},75%,62%)`);
  g.addColorStop(1, `hsl(${150 + s},80%,50%)`);
  ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
  skinHighlight(ctx, cx, cy, h); ctx.restore();
}
// --- Loot-box refresh skins ---
function fillCarbon(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save(); clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  const t = Date.now() / 600;
  const g = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
  g.addColorStop(0, '#1a1a1a'); g.addColorStop(0.3, '#2d2d2d'); g.addColorStop(0.5, '#404040'); g.addColorStop(0.7, '#2d2d2d'); g.addColorStop(1, '#1a1a1a');
  ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
  for (let i = 0; i < 4; i++) {
    const wy = r.y + r.h * (0.1 + 0.27 * i);
    ctx.strokeStyle = `rgba(80,80,80,${0.2 + 0.1 * Math.sin(t + i)})`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(r.x, wy); ctx.lineTo(r.x + r.w, wy); ctx.stroke();
  }
  skinHighlight(ctx, cx, cy, h); ctx.restore();
}
function fillMermaid(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save(); clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  const t = Date.now() / 900;
  const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
  g.addColorStop(0, '#004d40'); g.addColorStop(0.5, '#00897b'); g.addColorStop(1, '#004d40');
  ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
  for (let i = 0; i < 5; i++) {
    const sy = r.y + r.h * (0.1 + 0.2 * i);
    const sh = 4 + 3 * Math.sin(t + i * 1.5);
    ctx.fillStyle = `rgba(178,223,219,${0.15 + 0.1 * Math.sin(t + i * 0.7)})`;
    ctx.beginPath();
    ctx.ellipse(r.x + r.w / 2, sy, r.w * 0.3, sh, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  skinHighlight(ctx, cx, cy, h); ctx.restore();
}
function fillMidas(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save(); clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  const t = Date.now() / 500;
  const g = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
  g.addColorStop(0, '#8a6d10'); g.addColorStop(0.3, '#d4a820'); g.addColorStop(0.5, '#ffd700'); g.addColorStop(0.7, '#d4a820'); g.addColorStop(1, '#8a6d10');
  ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
  const wave = Math.sin(t) * 0.3 + 0.5;
  const glint = ctx.createLinearGradient(0, r.y - 8 + r.h * wave, 0, r.y + 8 + r.h * wave);
  glint.addColorStop(0, 'rgba(255,235,120,0)');
  glint.addColorStop(0.5, `rgba(255,235,120,${0.4 + 0.3 * Math.sin(t * 1.5)})`);
  glint.addColorStop(1, 'rgba(255,235,120,0)');
  ctx.fillStyle = glint; ctx.fillRect(r.x, r.y, r.w, r.h);
  skinHighlight(ctx, cx, cy, h); ctx.restore();
}
// Pickle Rick — "I turned myself into a paddle, Morty!" A bumpy green pickle with
// Rick's wide, darting eyes and worried grimace. Animated: the eyes glance around.
function fillPickle(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save(); clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  const t = Date.now() / 1000;
  // Pickle body — glossy green, darker at the edges
  const g = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
  g.addColorStop(0, '#3d5f1a'); g.addColorStop(0.45, '#7cb342'); g.addColorStop(0.6, '#9ccc65'); g.addColorStop(1, '#3d5f1a');
  ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
  // Warts / bumps speckled down the pickle
  for (let i = 0; i < 9; i++) {
    const bx = r.x + r.w * (0.3 + 0.4 * ((i * 0.37) % 1));
    const by = r.y + r.h * ((i + 0.5) / 9);
    ctx.fillStyle = 'rgba(40,70,15,0.55)';
    ctx.beginPath(); ctx.arc(bx, by, 1.3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(200,230,150,0.35)';
    ctx.beginPath(); ctx.arc(bx - 0.6, by - 0.6, 0.6, 0, Math.PI * 2); ctx.fill();
  }
  // Rick's face, near the top of the paddle
  const fy = r.y + r.h * 0.2;
  const er = r.w * 0.22;          // eye radius
  const ex = r.w * 0.24;          // eye horizontal offset from center
  const dart = Math.sin(t * 1.7) * er * 0.4; // pupils glance side to side
  const blink = (t % 5) > 4.85 ? 0.15 : 1;   // occasional quick blink
  for (const dir of [-1, 1]) {
    const px = cx + dir * ex;
    ctx.fillStyle = '#f5f5f0';
    ctx.beginPath(); ctx.ellipse(px, fy, er, er * blink, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath(); ctx.arc(px + dart, fy, er * 0.45 * blink, 0, Math.PI * 2); ctx.fill();
  }
  // Worried unibrow
  ctx.strokeStyle = '#2e4310'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - ex - er, fy - er * 1.1);
  ctx.quadraticCurveTo(cx, fy - er * 1.7, cx + ex + er, fy - er * 1.1);
  ctx.stroke();
  // Small grimace mouth
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(cx - er, fy + er * 1.8);
  ctx.quadraticCurveTo(cx, fy + er * 1.3, cx + er, fy + er * 1.8);
  ctx.stroke();
  skinHighlight(ctx, cx, cy, h); ctx.restore();
}
// --- Exclusive skins ---
function fillGenesis(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save(); clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  const t = Date.now() / 800;
  const g = ctx.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
  g.addColorStop(0, '#05001a'); g.addColorStop(0.5, '#1a0033'); g.addColorStop(1, '#05001a');
  ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
  for (let i = 0; i < 3; i++) {
    const wx = r.x + r.w * (0.2 + 0.6 * ((t + i * 1.2) % 1));
    const wy = r.y + r.h * (0.2 + 0.6 * ((t * 0.7 + i * 0.8) % 1));
    const wr = 12 + 8 * Math.sin(t + i);
    const wg = ctx.createRadialGradient(wx, wy, 0, wx, wy, wr);
    wg.addColorStop(0, `hsla(${270 + i * 30},80%,60%,0.25)`);
    wg.addColorStop(1, 'rgba(100,0,200,0)');
    ctx.fillStyle = wg; ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  skinHighlight(ctx, cx, cy, h); ctx.restore();
}
function fillQuantum(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save(); clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  const t = Date.now() / 400;
  const g = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
  g.addColorStop(0, '#002626'); g.addColorStop(0.3, '#004d4d'); g.addColorStop(0.5, '#00b3b3'); g.addColorStop(0.7, '#004d4d'); g.addColorStop(1, '#002626');
  ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
  for (let i = 0; i < 6; i++) {
    const waveY = r.y + r.h * (0.15 + 0.7 * ((t * 0.3 + i * 0.17) % 1));
    const waveA = Math.sin(t + i * 1.1) * 0.3 + 0.3;
    ctx.fillStyle = `rgba(0,255,255,${waveA * 0.15})`;
    ctx.fillRect(r.x, waveY - 2, r.w, 4);
  }
  for (let i = 0; i < 8; i++) {
    const dx = r.x + r.w * ((t * 0.2 + i * 0.12) % 1);
    const dy = r.y + r.h * ((t * 0.25 + i * 0.09) % 1);
    const ds = 1.5 + Math.sin(t * 2 + i) * 0.8;
    ctx.fillStyle = `rgba(0,255,200,${0.4 + 0.3 * Math.sin(t + i)})`;
    ctx.beginPath(); ctx.arc(dx, dy, ds, 0, Math.PI * 2); ctx.fill();
  }
  skinHighlight(ctx, cx, cy, h); ctx.restore();
}
function fillGold(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save();
  clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  // Base: warm gold gradient across the width
  const g = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
  g.addColorStop(0,   '#7a5c10');
  g.addColorStop(0.3, '#e8c840');
  g.addColorStop(0.5, '#fff2a0');
  g.addColorStop(0.7, '#e8c840');
  g.addColorStop(1,   '#7a5c10');
  ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
  // Animated diagonal glint that sweeps top-to-bottom
  const t = (Date.now() / 700) % 1;
  const gy = r.y - 20 + (r.h + 40) * t;
  const glint = ctx.createLinearGradient(0, gy - 8, 0, gy + 8);
  glint.addColorStop(0, 'rgba(255,255,230,0)');
  glint.addColorStop(0.5, 'rgba(255,255,230,0.85)');
  glint.addColorStop(1, 'rgba(255,255,230,0)');
  ctx.fillStyle = glint; ctx.fillRect(r.x, r.y, r.w, r.h);
  skinHighlight(ctx, cx, cy, h);
  ctx.restore();
}
function fillChrome(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save();
  clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  // Multi-band metallic reflection
  const g = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
  g.addColorStop(0,    '#3d4147');
  g.addColorStop(0.25, '#b0b8c8');
  g.addColorStop(0.45, '#f0f4f8');
  g.addColorStop(0.55, '#ffffff');
  g.addColorStop(0.75, '#b0b8c8');
  g.addColorStop(1,    '#3d4147');
  ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
  // Fast bright scan sweep
  const t = (Date.now() / 500) % 1;
  const sy = r.y - 10 + (r.h + 20) * t;
  const sweep = ctx.createLinearGradient(0, sy - 10, 0, sy + 10);
  sweep.addColorStop(0, 'rgba(255,255,255,0)');
  sweep.addColorStop(0.5, 'rgba(255,255,255,0.70)');
  sweep.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sweep; ctx.fillRect(r.x, r.y, r.w, r.h);
  skinHighlight(ctx, cx, cy, h);
  ctx.restore();
}
function fillGalaxy(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save();
  clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  // Deep space gradient
  const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
  g.addColorStop(0,    '#0d0b2a');
  g.addColorStop(0.35, '#1e0e4a');
  g.addColorStop(0.65, '#2a0d5e');
  g.addColorStop(1,    '#050820');
  ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
  // Nebula tint
  const neb = ctx.createRadialGradient(cx, cy, 1, cx, cy, r.h * 0.4);
  neb.addColorStop(0, 'rgba(120,60,200,0.35)');
  neb.addColorStop(1, 'rgba(60,20,120,0)');
  ctx.fillStyle = neb; ctx.fillRect(r.x, r.y, r.w, r.h);
  // Twinkling stars
  const now = Date.now();
  for (let i = 0; i < 18; i++) {
    const sx = r.x + ((i * 1973 + 7) % (r.w * 10)) / 10;
    const sy = r.y + ((i * 1031 + 3) % (r.h * 10)) / 10;
    const twinkle = 0.3 + 0.7 * Math.abs(Math.sin(now / 300 + i * 1.7));
    ctx.globalAlpha = twinkle;
    ctx.fillStyle = i % 3 === 0 ? '#c0aaff' : i % 3 === 1 ? '#aaddff' : '#ffffff';
    const sz = i % 5 === 0 ? 2 : 1;
    ctx.fillRect(sx, sy, sz, sz);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}
function fillLava(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save();
  clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  const t = Date.now() / 400;
  // Dark volcanic base
  ctx.fillStyle = '#200500'; ctx.fillRect(r.x, r.y, r.w, r.h);
  // Flowing lava bands with sinusoidal intensity
  for (let i = 0; i < 8; i++) {
    const yFrac = (i / 7);
    const yy = r.y + yFrac * r.h;
    const phase = t + i * 0.9;
    const intensity = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(phase));
    const red = (180 + intensity * 75) | 0;
    const grn = (20 + intensity * 80) | 0;
    const band = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
    band.addColorStop(0,   `rgba(${red},${grn},0,0)`);
    band.addColorStop(0.3, `rgba(${red},${grn},0,${intensity * 0.9})`);
    band.addColorStop(0.7, `rgba(${red},${grn},0,${intensity * 0.9})`);
    band.addColorStop(1,   `rgba(${red},${grn},0,0)`);
    ctx.fillStyle = band;
    ctx.fillRect(r.x, yy - 3, r.w, 5 + intensity * 4);
  }
  // Bright core hotspot
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, h * 0.25);
  core.addColorStop(0, 'rgba(255,200,80,0.4)');
  core.addColorStop(1, 'rgba(255,60,0,0)');
  ctx.fillStyle = core; ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}
function fillIce(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save();
  clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  // Crystalline blue-white gradient
  const g = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
  g.addColorStop(0,    '#5ba8cc');
  g.addColorStop(0.35, '#b8e4f8');
  g.addColorStop(0.55, '#eef9ff');
  g.addColorStop(0.75, '#b8e4f8');
  g.addColorStop(1,    '#5ba8cc');
  ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
  // Crystal facet lines radiating from center
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 0.8;
  const mx = cx, my = cy;
  const angles = [Math.PI / 5, Math.PI * 2 / 5, Math.PI * 3 / 5, Math.PI * 4 / 5];
  for (const a of angles) {
    const len = h * 0.55;
    ctx.beginPath();
    ctx.moveTo(mx + Math.cos(a) * 2, my + Math.sin(a) * 2);
    ctx.lineTo(mx + Math.cos(a) * len, my + Math.sin(a) * len);
    ctx.moveTo(mx - Math.cos(a) * 2, my - Math.sin(a) * 2);
    ctx.lineTo(mx - Math.cos(a) * len, my - Math.sin(a) * len);
    ctx.stroke();
  }
  // Shimmer at top
  const shimmer = 0.5 + 0.5 * Math.sin(Date.now() / 500);
  const sh = ctx.createLinearGradient(0, r.y, 0, r.y + r.h * 0.3);
  sh.addColorStop(0, `rgba(255,255,255,${shimmer * 0.45})`);
  sh.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sh; ctx.fillRect(r.x, r.y, r.w, r.h);
  skinHighlight(ctx, cx, cy, h);
  ctx.restore();
}
function fillCamo(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save();
  clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  ctx.fillStyle = '#4a5425'; ctx.fillRect(r.x, r.y, r.w, r.h);
  // Organic camo blobs using randomised-but-stable positions
  const palette = ['#2e3514', '#6b7a30', '#8a9a52', '#3a4218'];
  const seeds = [[3, 0.15, 0.12], [5, 0.55, 0.25], [7, 0.3, 0.55],
                 [11, 0.7, 0.42], [13, 0.1, 0.72], [2, 0.85, 0.15],
                 [17, 0.45, 0.82], [19, 0.65, 0.68], [23, 0.2, 0.38]];
  for (let i = 0; i < seeds.length; i++) {
    const [pi, fx, fy] = seeds[i];
    ctx.fillStyle = palette[pi % palette.length];
    const bx = r.x + fx * r.w;
    const by = r.y + fy * r.h;
    ctx.beginPath();
    ctx.ellipse(bx, by, 3 + (pi % 3), 4 + (pi % 4), (pi * 0.6), 0, Math.PI * 2);
    ctx.fill();
  }
  skinHighlight(ctx, cx, cy, h);
  ctx.restore();
}
function fillNeon(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save();
  clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 180);
  // Dark interior that glows faintly
  ctx.fillStyle = '#030810'; ctx.fillRect(r.x, r.y, r.w, r.h);
  const inner = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
  inner.addColorStop(0,   'rgba(0,255,80,0)');
  inner.addColorStop(0.4, `rgba(0,255,80,${0.08 + pulse * 0.10})`);
  inner.addColorStop(0.6, `rgba(0,255,80,${0.08 + pulse * 0.10})`);
  inner.addColorStop(1,   'rgba(0,255,80,0)');
  ctx.fillStyle = inner; ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.restore();
  // Outer glow — drawn WITHOUT clip so shadowBlur bleeds outside the paddle edges
  ctx.save();
  const glowAlpha = 0.55 + pulse * 0.45;
  ctx.strokeStyle = `rgba(0,255,80,${glowAlpha})`;
  ctx.shadowColor = '#00ff50';
  ctx.shadowBlur = 10 + pulse * 14;
  ctx.lineWidth = 1.5;
  const rad = PADDLE.w / 2;
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, rad);
  ctx.stroke();
  ctx.restore();
}
function fillStripes(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save();
  clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  ctx.fillStyle = '#f5c518'; ctx.fillRect(r.x, r.y, r.w, r.h);
  // Animated diagonal stripes
  const offset = (Date.now() / 30) % 16;
  ctx.fillStyle = '#111';
  for (let d = -r.h; d < r.h + r.w; d += 16) {
    ctx.beginPath();
    ctx.moveTo(r.x, r.y + d + offset);
    ctx.lineTo(r.x + r.w, r.y + d + offset - r.w);
    ctx.lineTo(r.x + r.w, r.y + d + offset - r.w + 8);
    ctx.lineTo(r.x, r.y + d + offset + 8);
    ctx.closePath();
    ctx.fill();
  }
  skinHighlight(ctx, cx, cy, h);
  ctx.restore();
}
function fillGlitch(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save();
  clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  ctx.fillStyle = '#0a0a14'; ctx.fillRect(r.x, r.y, r.w, r.h);
  const t = Math.floor(Date.now() / 60);
  // RGB channel slices — each colour is shifted slightly horizontally
  const channels: [string, number][] = [['#ff003c', -2], ['#00e5ff', 1], ['#b14fff', 0]];
  for (let i = 0; i < 9; i++) {
    const yy = r.y + (((i * 97 + t * 17) % (r.h * 4)) / 4);
    const bh = 2 + (i % 3);
    const [col, shift] = channels[(t + i) % 3];
    ctx.globalAlpha = 0.55 + 0.45 * ((t + i) % 2);
    ctx.fillStyle = col;
    ctx.fillRect(r.x + shift, yy, r.w, bh);
  }
  // Occasional bright full-height flash on a single channel
  if (t % 7 === 0) {
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = '#00e5ff';
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  ctx.globalAlpha = 1;
  // Scanline overlay
  for (let yy = r.y; yy < r.y + r.h; yy += 3) {
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = '#000';
    ctx.fillRect(r.x, yy, r.w, 1);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function fillToxic(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save();
  clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  const t = Date.now() / 350;
  // Dark sludge base
  const g = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
  g.addColorStop(0,   '#0a1a04');
  g.addColorStop(0.5, '#152805');
  g.addColorStop(1,   '#0a1a04');
  ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
  // Pulsing radioactive glow from center
  const pulse = 0.35 + 0.35 * Math.sin(t * 1.8);
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, r.h * 0.45);
  core.addColorStop(0, `rgba(120,255,30,${0.25 + pulse})`);
  core.addColorStop(0.5, `rgba(60,200,10,${0.10 + pulse * 0.5})`);
  core.addColorStop(1, 'rgba(20,80,0,0)');
  ctx.fillStyle = core; ctx.fillRect(r.x, r.y, r.w, r.h);
  // Floating bubble circles
  for (let i = 0; i < 6; i++) {
    const phase = t * 0.6 + i * 1.1;
    const bx = r.x + 2 + ((i * 317) % (r.w - 4));
    const by = r.y + r.h - 4 - ((((phase * 18) + i * 11) % (r.h - 8)));
    const br = 1.5 + (i % 3) * 0.8;
    const alpha = 0.4 + 0.5 * Math.abs(Math.sin(phase));
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#7fff20'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // Bright hazard-yellow edge stripe
  const edge = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
  edge.addColorStop(0, 'rgba(180,255,0,0.5)');
  edge.addColorStop(0.5, 'rgba(180,255,0,0.05)');
  edge.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = edge; ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}
function fillPlasma(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save();
  clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  const t = Date.now() / 200;
  // Dark base
  ctx.fillStyle = '#07000f'; ctx.fillRect(r.x, r.y, r.w, r.h);
  // Electric arc paths that shift over time
  const arcColors = ['#c06fff', '#60c0ff', '#e040ff'];
  for (let i = 0; i < 4; i++) {
    const yStart = r.y + (i / 3) * r.h;
    const yEnd = r.y + ((i + 1) / 3) * r.h;
    const midY = (yStart + yEnd) / 2 + Math.sin(t + i * 1.5) * (r.h / 8);
    const jitter = Math.cos(t * 1.7 + i) * 3;
    ctx.beginPath();
    ctx.moveTo(r.x, yStart);
    ctx.quadraticCurveTo(r.x + r.w / 2 + jitter, midY, r.x + r.w, yEnd);
    ctx.strokeStyle = arcColors[i % arcColors.length];
    ctx.shadowColor = arcColors[i % arcColors.length];
    ctx.shadowBlur = 5 + Math.abs(Math.sin(t + i)) * 8;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.6 + 0.4 * Math.abs(Math.sin(t * 0.9 + i));
    ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  // Central bright core
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, r.h * 0.3);
  core.addColorStop(0, 'rgba(200,100,255,0.35)');
  core.addColorStop(1, 'rgba(80,0,180,0)');
  ctx.fillStyle = core; ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}
function fillWood(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save();
  clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  // Warm wood base
  const g = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
  g.addColorStop(0,    '#5c3317');
  g.addColorStop(0.4,  '#8b4513');
  g.addColorStop(0.6,  '#a0522d');
  g.addColorStop(1,    '#5c3317');
  ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
  // Wood grain lines
  const grains = [
    [0.15, 0.08], [0.30, 0.12], [0.45, 0.06], [0.60, 0.14],
    [0.75, 0.09], [0.88, 0.11], [0.22, 0.05], [0.53, 0.10],
  ];
  ctx.strokeStyle = 'rgba(40,15,5,0.45)'; ctx.lineWidth = 0.8;
  for (const [fy, curve] of grains) {
    const y = r.y + fy * r.h;
    ctx.beginPath();
    ctx.moveTo(r.x, y);
    ctx.quadraticCurveTo(cx, y + curve * r.h * 2, r.x + r.w, y + curve * r.h);
    ctx.stroke();
  }
  // Subtle highlight for wood sheen
  skinHighlight(ctx, cx, cy, h);
  ctx.restore();
}
function fillHologram(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save();
  clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  const t = Date.now() / 600;
  // Shift hue over time for iridescent effect
  const hue = (t * 60) % 360;
  ctx.fillStyle = `hsl(${hue},70%,8%)`; ctx.fillRect(r.x, r.y, r.w, r.h);
  // Three overlapping colour bands that scroll and shift
  for (let i = 0; i < 3; i++) {
    const bandHue = (hue + i * 120) % 360;
    const yOff = ((t * 40 + i * r.h / 3) % r.h);
    const band = ctx.createLinearGradient(0, r.y + yOff, 0, r.y + yOff + r.h * 0.4);
    band.addColorStop(0, `hsla(${bandHue},100%,70%,0)`);
    band.addColorStop(0.4, `hsla(${bandHue},100%,70%,0.28)`);
    band.addColorStop(1, `hsla(${bandHue},100%,70%,0)`);
    ctx.fillStyle = band; ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  // Scanline grid for a holographic panel look
  for (let yy = r.y; yy < r.y + r.h; yy += 4) {
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = '#000';
    ctx.fillRect(r.x, yy, r.w, 1);
  }
  ctx.globalAlpha = 1;
  skinHighlight(ctx, cx, cy, h);
  ctx.restore();
}
function fillVenom(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save();
  clipPaddle(ctx, cx, cy, h);
  const r = paddleRect(cx, cy, h);
  const t = Date.now() / 250;
  // Black base with slight purple tint
  const g = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
  g.addColorStop(0,   '#0a000f');
  g.addColorStop(0.4, '#140018');
  g.addColorStop(0.6, '#100012');
  g.addColorStop(1,   '#0a000f');
  ctx.fillStyle = g; ctx.fillRect(r.x, r.y, r.w, r.h);
  // Green drip strands that fall down
  for (let i = 0; i < 4; i++) {
    const dx = r.x + 2 + (i / 3) * (r.w - 4);
    const dripLen = r.h * (0.3 + 0.25 * Math.abs(Math.sin(t * 0.5 + i)));
    const dripY = r.y + ((t * 25 + i * 20) % (r.h + 20));
    const drip = ctx.createLinearGradient(0, dripY - 4, 0, dripY + dripLen);
    drip.addColorStop(0, 'rgba(20,255,60,0)');
    drip.addColorStop(0.2, 'rgba(20,255,60,0.9)');
    drip.addColorStop(1, 'rgba(20,255,60,0)');
    ctx.strokeStyle = drip; ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(dx, dripY);
    ctx.lineTo(dx + Math.sin(t + i) * 1.5, dripY + dripLen);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // Venomous green glow at edges
  const glow = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
  glow.addColorStop(0, 'rgba(30,255,70,0.35)');
  glow.addColorStop(0.3, 'rgba(30,255,70,0)');
  glow.addColorStop(0.7, 'rgba(30,255,70,0)');
  glow.addColorStop(1, 'rgba(30,255,70,0.35)');
  ctx.fillStyle = glow; ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}

// "minion" power-up: draw the minion image centered on the paddle, sized to the paddle's
// current height (so it stays roughly paddle-sized) with the image's own aspect ratio.
function drawMinionPaddle(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  const aspect = minionImg.naturalWidth / minionImg.naturalHeight;
  const dh = h;
  const dw = dh * aspect;
  ctx.drawImage(minionImg, cx - dw / 2, cy - dh / 2, dw, dh);
}

// A "locked" marker over a paddle disabled by a blaster hit (gray sparks + ⚡).
function drawDisabled(ctx: CanvasRenderingContext2D, cx: number, cy: number, h: number) {
  ctx.save();
  ctx.strokeStyle = '#ff5c5c';
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(Date.now() / 90)); // flicker
  ctx.strokeRect(cx - PADDLE.w / 2 - 3, cy - h / 2 - 3, PADDLE.w + 6, h + 6);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffd166';
  ctx.font = 'bold 18px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('⚡', cx, cy);
  ctx.restore();
}

// Blaster: the local player's aim line plus every projectile currently in flight.
function drawBlaster(ctx: CanvasRenderingContext2D, s: StateMsg) {
  // Aim line for whoever is locally holding the blaster (set by main.ts).
  if (blasterAim) {
    const p = s.paddles[blasterAim.side];
    const dir = blasterAim.side === 'left' ? 1 : -1;
    const ox = p.x + dir * (PADDLE.w / 2 + 2);
    const len = 150;
    const ex = ox + dir * Math.cos(blasterAim.angle) * len;
    const ey = p.y + Math.sin(blasterAim.angle) * len;
    ctx.save();
    ctx.strokeStyle = p.color;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(ox, p.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // Arrowhead.
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.85;
    const a = Math.atan2(ey - p.y, ex - ox);
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - Math.cos(a - 0.4) * 10, ey - Math.sin(a - 0.4) * 10);
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - Math.cos(a + 0.4) * 10, ey - Math.sin(a + 0.4) * 10);
    ctx.stroke();
    ctx.restore();
  }
  // Projectiles — a bright green laser bolt with a fading trail behind it, oriented along
  // its travel direction.
  for (const pr of s.projectiles) {
    const sp = Math.hypot(pr.vx, pr.vy) || 1;
    const ux = pr.vx / sp;
    const uy = pr.vy / sp;
    const boltLen = 26; // length of the bright core bolt
    const trailLen = 64; // how far the fading trail reaches behind
    // tip slightly ahead of center, tail behind
    const tipX = pr.x + ux * boltLen * 0.5;
    const tipY = pr.y + uy * boltLen * 0.5;
    const tailX = pr.x - ux * boltLen * 0.5;
    const tailY = pr.y - uy * boltLen * 0.5;
    ctx.save();
    ctx.lineCap = 'round';
    // Trail: a gradient fading to transparent behind the bolt.
    const tx = pr.x - ux * trailLen;
    const ty = pr.y - uy * trailLen;
    const grad = ctx.createLinearGradient(tipX, tipY, tx, ty);
    grad.addColorStop(0, 'rgba(57,255,20,0.55)');
    grad.addColorStop(1, 'rgba(57,255,20,0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = BLASTER.r * 1.2;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    // Bright glowing core bolt.
    ctx.shadowColor = '#39ff14';
    ctx.shadowBlur = 14;
    ctx.strokeStyle = '#aaffa0';
    ctx.lineWidth = BLASTER.r * 0.9;
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.strokeStyle = '#39ff14';
    ctx.lineWidth = BLASTER.r * 1.8;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.restore();
  }
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
  fritz:   { stroke: '#f59e0b', fill: 'rgba(245, 158,  11, 0.13)' }, // amber
  disco:   { stroke: '#e040fb', fill: 'rgba(224,  64, 251, 0.14)' }, // neon magenta
  blaster: { stroke: '#ff4d4d', fill: 'rgba(255,  77,  77, 0.14)' }, // red
  minion:  { stroke: '#ffd21e', fill: 'rgba(255, 210,  30, 0.16)' }, // minion yellow
  earthquake: { stroke: '#b07a3a', fill: 'rgba(176, 122,  58, 0.16)' }, // dusty brown
  coins:   { stroke: '#ffcf33', fill: 'rgba(255, 207,  51, 0.18)' }, // gold
  blackout:   { stroke: '#9aa0b0', fill: 'rgba(20, 22, 30, 0.4)' }, // dark
  vortex:     { stroke: '#b97cff', fill: 'rgba(180, 120, 255, 0.16)' }, // purple
  glitch:     { stroke: '#00fff0', fill: 'rgba(0, 255, 240, 0.14)' }, // cyan
  smoke:      { stroke: '#c8c8d2', fill: 'rgba(190, 190, 200, 0.16)' }, // grey
  tilt:       { stroke: '#ffa94d', fill: 'rgba(255, 169, 77, 0.14)' }, // amber
  roam:       { stroke: '#4ade80', fill: 'rgba(74, 222, 128, 0.14)' }, // green
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
  // fritz: a smiley face → "fritz takes over the background"
  fritz(ctx, x, y) {
    // Head
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.stroke();
    // Eyes
    ctx.beginPath();
    ctx.arc(x - 3.5, y - 3, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x + 3.5, y - 3, 1.5, 0, Math.PI * 2);
    ctx.fill();
    // Smile
    ctx.beginPath();
    ctx.arc(x, y + 1, 5, 0.2, Math.PI - 0.2);
    ctx.stroke();
  },
  // disco: a circle with radiating lines → disco ball
  disco(ctx, x, y) {
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * 5, y + Math.sin(a) * 5);
      ctx.lineTo(x + Math.cos(a) * 13, y + Math.sin(a) * 13);
      ctx.stroke();
    }
  },
  // blaster: a little bullet/arrow flying right → "fire a projectile to disable a paddle"
  blaster(ctx, x, y) {
    // shaft
    ctx.beginPath();
    ctx.moveTo(x - 11, y);
    ctx.lineTo(x + 7, y);
    ctx.stroke();
    // arrowhead
    ctx.beginPath();
    ctx.moveTo(x + 11, y);
    ctx.lineTo(x + 3, y - 5);
    ctx.lineTo(x + 3, y + 5);
    ctx.closePath();
    ctx.fill();
  },
  // minion: a one-eyed goggle head → "both paddles become a minion"
  minion(ctx, x, y) {
    // head outline
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.stroke();
    // goggle ring
    ctx.beginPath();
    ctx.arc(x, y - 1, 6, 0, Math.PI * 2);
    ctx.stroke();
    // pupil
    ctx.beginPath();
    ctx.arc(x, y - 1, 2.2, 0, Math.PI * 2);
    ctx.fill();
    // strap
    ctx.beginPath();
    ctx.moveTo(x - 11, y - 1);
    ctx.lineTo(x - 6, y - 1);
    ctx.moveTo(x + 6, y - 1);
    ctx.lineTo(x + 11, y - 1);
    ctx.stroke();
  },
  // earthquake: a jagged seismograph line → "the court shakes"
  earthquake(ctx, x, y) {
    ctx.beginPath();
    ctx.moveTo(x - 12, y);
    ctx.lineTo(x - 7, y);
    ctx.lineTo(x - 4, y - 8);
    ctx.lineTo(x, y + 9);
    ctx.lineTo(x + 4, y - 6);
    ctx.lineTo(x + 7, y);
    ctx.lineTo(x + 12, y);
    ctx.stroke();
  },
  // coins: a coin with a star → "grab 5 coins"
  coins(ctx, x, y) {
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 5.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillRect(x - 1, y - 5.5, 2, 11); // simple coin mark
  },
  // blackout: a half-shaded circle → "the lights go out"
  blackout(ctx, x, y) {
    ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 11, -Math.PI / 2, Math.PI / 2); ctx.fill();
  },
  // vortex: a spiral → "swirl"
  vortex(ctx, x, y) {
    ctx.beginPath();
    for (let a = 0; a < Math.PI * 4; a += 0.3) {
      const r = a * 1.0;
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (a === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  },
  // glitch: offset jagged bars → "TV static"
  glitch(ctx, x, y) {
    ctx.fillRect(x - 11, y - 7, 14, 3);
    ctx.fillRect(x - 6, y - 1, 16, 3);
    ctx.fillRect(x - 10, y + 5, 12, 3);
  },
  // smoke: stacked puffs → "smoke bomb"
  smoke(ctx, x, y) {
    ctx.beginPath(); ctx.arc(x - 4, y + 2, 5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x + 4, y + 1, 6, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y - 5, 5, 0, Math.PI * 2); ctx.stroke();
  },
  // tilt: a tilted square → "the court leans"
  tilt(ctx, x, y) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(0.4);
    ctx.strokeRect(-9, -9, 18, 18);
    ctx.restore();
  },
  // roam: a paddle bar with a horizontal arrow → "your paddle breaks free sideways"
  roam(ctx, x, y) {
    const bh = TARGET.r - 2;
    ctx.fillRect(x - 11, y - bh / 2, 4, bh); // the freed paddle, at the wall
    // arrow pointing into the court (to the right)
    ctx.beginPath();
    ctx.moveTo(x - 4, y);
    ctx.lineTo(x + 9, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 3, y - 5);
    ctx.lineTo(x + 9, y);
    ctx.lineTo(x + 3, y + 5);
    ctx.stroke();
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

// Draw the diamond-hands gem centered and scaled to fill a canvas (for the 3D puck face).
export function drawDiamondIcon(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')!;
  const { width: w, height: h } = canvas;
  const margin = 4;
  const scale = (Math.min(w, h) / 2 - margin) / DIAMOND.r;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(scale, scale);
  drawDiamond(ctx, 0, 0);
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

// Cracked-glass overlay (transparent PNG), used by the MONITOR_BREAK fatality. Its 8:5
// aspect matches the court, so it stretches edge-to-edge with no distortion.
const crackedImg = new Image();
crackedImg.src = '/cracked-glass.png';
const crackedReady = () => crackedImg.complete && crackedImg.naturalWidth > 0;

// Avery's face, used by the AVERY jumpscare fatality. Loaded once; drawn only once ready.
const averyImg = new Image();
averyImg.src = '/avery.webp';
const averyReady = () => averyImg.complete && averyImg.naturalWidth > 0;

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
    case 'MONITOR_BREAK':
      drawMonitorBreak(ctx, s, fx, t, banner);
      break;
    case 'AVERY':
      drawAvery(ctx, s, fx, t, banner);
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

// --- Fatality: "Avery" (jumpscare) ------------------------------------------
// No slow build: the court snaps to black and Avery's face slams in full-frame,
// jittering violently in sync with a jumpscare sting. A sudden in-your-face scare.
function drawAvery(
  ctx: CanvasRenderingContext2D,
  _s: StateMsg,
  _fx: { side: 'left' | 'right' },
  t: number,
  banner: () => void,
) {
  // Hard cut to black behind everything.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, COURT.w, COURT.h);

  // A brief beat of darkness, then the face is just THERE — no ease-in.
  const LURK = 0.12; // seconds of black before the scare lands
  if (t < LURK) {
    banner();
    return;
  }

  const e = t - LURK;
  // Slam in slightly oversized, then settle — overshoot reads as a pounce.
  const pop = 1.18 - Math.min(0.18, e * 0.9);
  // Violent jitter that eases off as the scare holds.
  const shakeAmt = Math.max(0, 14 - e * 10);
  const sx = Math.sin(t * 83) * shakeAmt;
  const sy = Math.cos(t * 71) * shakeAmt;

  // Cover the whole court (slightly beyond, so the shake never bares an edge).
  const w = COURT.w * pop * 1.12;
  const h = COURT.h * pop * 1.12;
  const cx = COURT.w / 2 + sx;
  const cy = COURT.h / 2 + sy;

  if (averyReady()) {
    ctx.drawImage(averyImg, cx - w / 2, cy - h / 2, w, h);
  } else {
    // Fallback if the image hasn't loaded: a screaming red flash.
    ctx.fillStyle = '#b00010';
    ctx.fillRect(0, 0, COURT.w, COURT.h);
  }

  // A red strobe over the first instant for that flashbulb-of-terror punch.
  const flash = Math.max(0, 0.5 - e * 2);
  if (flash > 0) {
    ctx.save();
    ctx.globalAlpha = flash;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, COURT.w, COURT.h);
    ctx.restore();
  }

  banner();
}

// --- Fatality: "Monitor Break" ----------------------------------------------
// The ball screams into the screen, the court detonates in a billow of smoke, and a
// cracked-glass overlay snaps over everything as if the player's physical monitor just
// shattered. Render is stateless, so every particle is derived from its index (a cheap
// hash) plus the elapsed time `t` — no per-frame bookkeeping.
function hash01(i: number, salt: number): number {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function drawMonitorBreak(
  ctx: CanvasRenderingContext2D,
  s: StateMsg,
  fx: { side: 'left' | 'right' },
  t: number,
  banner: () => void,
) {
  const winner = s.paddles[fx.side];
  const winFaceX = fx.side === 'left' ? winner.x + PADDLE.w / 2 : winner.x - PADDLE.w / 2;

  // The winner lobs a smoke grenade that skips off the walls a couple of times and comes
  // to rest dead centre — where it detonates. Detonation point is the grenade's rest spot.
  const TOSS = 1.0; // grenade flight + bounces before it goes off
  const impactX = COURT.w / 2;
  const impactY = COURT.h / 2;

  const m = t - TOSS; // seconds since detonation (negative while the grenade is airborne)

  if (m < 0) {
    // Grenade in flight: a tumbling canister leaking a trail of smoke as it bounces.
    ctx.save();
    for (let k = 7; k >= 1; k--) {
      const tk = t - k * 0.05;
      if (tk < 0) continue;
      const past = grenadeAt(tk, winFaceX, winner.y, TOSS);
      const al = 0.16 * (1 - k / 8);
      const r = 7 + k * 5;
      const g = ctx.createRadialGradient(past.x, past.y, 1, past.x, past.y, r);
      g.addColorStop(0, `rgba(150,152,158,${al})`);
      g.addColorStop(1, 'rgba(150,152,158,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(past.x, past.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    const cur = grenadeAt(t, winFaceX, winner.y, TOSS);
    drawGrenade(ctx, cur.x, cur.y, 9, t);
    ctx.restore();
    banner();
    return;
  }

  // --- the smash ---
  ctx.save();
  // Violent screen-shake that decays over ~0.6s; applied to the smoke + glass layers.
  const shake = 18 * Math.exp(-m * 5);
  ctx.translate(Math.sin(t * 91) * shake, Math.cos(t * 83) * shake);

  // Blinding white flash at the moment of impact, gone in ~0.16s.
  const flash = Math.max(0, 1 - m / 0.16);
  if (flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${flash})`;
    ctx.fillRect(-40, -40, COURT.w + 80, COURT.h + 80);
  }

  // The "dead" screen behind the smoke goes near-black.
  ctx.fillStyle = `rgba(5,6,12,${Math.min(0.82, m * 2.2)})`;
  ctx.fillRect(-40, -40, COURT.w + 80, COURT.h + 80);

  // Billowing smoke: puffs fired radially from the impact, easing outward, swelling and
  // drifting upward as they fade. Staggered births keep it rolling rather than popping.
  const PUFFS = 46;
  for (let i = 0; i < PUFFS; i++) {
    const age = m - hash01(i, 3) * 0.18;
    if (age <= 0) continue;
    const ang = hash01(i, 1) * Math.PI * 2;
    const spd = 110 + hash01(i, 2) * 280;
    const dist = spd * (1 - Math.exp(-age * 2.6)); // ease-out drift
    const px = impactX + Math.cos(ang) * dist;
    const py = impactY + Math.sin(ang) * dist - age * 46; // smoke rises
    const r = 24 + age * 130 + hash01(i, 4) * 34;
    const al = Math.max(0, 0.55 * (1 - age / 2.4));
    if (al <= 0) continue;
    const tone = 96 + Math.floor(hash01(i, 5) * 48);
    const g = ctx.createRadialGradient(px, py, 1, px, py, r);
    g.addColorStop(0, `rgba(${tone},${tone},${tone + 8},${al})`);
    g.addColorStop(0.6, `rgba(${tone - 30},${tone - 30},${tone - 22},${al * 0.5})`);
    g.addColorStop(1, 'rgba(40,40,48,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // The shattered monitor glass drops over the whole picture, snapping in right at the
  // impact (hidden under the flash) and holding for the rest of the finisher.
  const glassA = Math.min(1, m / 0.1);
  if (crackedReady()) {
    ctx.globalAlpha = glassA;
    ctx.drawImage(crackedImg, 0, 0, COURT.w, COURT.h);
    ctx.globalAlpha = 1;
  } else {
    // Fallback if the PNG hasn't loaded: a few bright radial crack lines.
    ctx.strokeStyle = `rgba(220,235,255,${glassA})`;
    ctx.lineWidth = 2;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + hash01(i, 7);
      const len = 240 + hash01(i, 8) * 260;
      ctx.beginPath();
      ctx.moveTo(impactX, impactY);
      ctx.lineTo(impactX + Math.cos(a) * len, impactY + Math.sin(a) * len);
      ctx.stroke();
    }
  }
  ctx.restore();

  banner();
}

// Analytic path for the lobbed smoke grenade: it eases horizontally from the winner's
// paddle to court centre while a decaying triangle wave bounces it off the top/bottom
// walls (like the ball) a couple of times, settling to rest at centre by t = dur.
function grenadeAt(t: number, x0: number, y0: number, dur: number) {
  const cx = COURT.w / 2;
  const cy = COURT.h / 2;
  const u = Math.min(1, Math.max(0, t / dur));
  const x = x0 + (cx - x0) * (1 - Math.pow(1 - u, 2.4)); // ease-out to centre
  // Triangle wave gives the sharp "bounce" corners; envelope shrinks it to rest at cy.
  const tri = (p: number) => 2 * Math.abs(2 * (p - Math.floor(p + 0.5))) - 1;
  const env = Math.pow(1 - u, 0.7);
  const base = y0 + (cy - y0) * u; // launch height drifts toward centre
  const y = base + env * (cy - 16) * tri(u * 2.5);
  return { x, y };
}

// A little olive grenade: shaded body, metal spoon/cap, and a sputtering fuse spark.
function drawGrenade(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, t: number) {
  ctx.save();
  const body = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, 1, x, y, r);
  body.addColorStop(0, '#6b7d45');
  body.addColorStop(1, '#2b3318');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  // pin cap on top
  ctx.fillStyle = '#9a9a9a';
  ctx.fillRect(x - 2, y - r - 4, 4, 5);
  // fuse spark
  const fl = 0.6 + 0.4 * Math.sin(t * 40);
  const sg = ctx.createRadialGradient(x, y - r - 5, 0, x, y - r - 5, 6 * fl);
  sg.addColorStop(0, 'rgba(255,240,180,0.95)');
  sg.addColorStop(1, 'rgba(255,150,40,0)');
  ctx.fillStyle = sg;
  ctx.beginPath();
  ctx.arc(x, y - r - 5, 6 * fl, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
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

// Startup guard: warn about any exclusive cosmetic missing its client renderer entry.
(() => {
  const registries: Record<string, Record<string, unknown>> = {
    hat: HAT_RENDERERS,
    skin: SKIN_RENDERERS,
    trail: TRAIL_TINTS,
  };
  for (const ex of EXCLUSIVES) {
    const reg = registries[ex.slot === 'title' ? '' : ex.slot];
    if (ex.slot === 'title') continue; // titles use name lookup, not a draw registry
    if (reg && !(ex.id in reg)) {
      console.warn(`[render] Missing renderer for exclusive "${ex.id}" (slot:${ex.slot}) — it will render as nothing!`);
    }
  }
})();
