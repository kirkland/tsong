// Plinko: drop a ball down an 8-row pegboard. Server rolls the path; client animates it.

import type { PlinkoResultMsg } from '../shared/types';
import { PLINKO_ROWS, PLINKO_PAYOUTS } from '../shared/types';

export interface PlinkoHandle {
  setCoins(n: number): void;
  onResult(msg: PlinkoResultMsg): void;
}

const PAD      = 18;
const PAD_TOP  = 30;
const PAD_BOT  = 54;
const PEG_R    = 5;
const BALL_R   = 7;
const STEP_MS  = 155; // ms per row — total animation ~1.2 s

// Slot colors center-out: cyan (26×) → blue → amber → orange → red
const SLOT_COLORS = ['#22d3ee', '#3b82f6', '#f59e0b', '#f97316', '#ef4444'];

function slotColor(slot: number): string {
  const dist = Math.abs(slot - 4); // slot 4 is center of 0-8
  return SLOT_COLORS[Math.min(dist, SLOT_COLORS.length - 1)];
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function initPlinko(opts: {
  send: (amount: number) => void;
  playWin?: () => void;
  onSettled?: () => void;
}): PlinkoHandle {
  const btn       = document.getElementById('plinkoBtn')    as HTMLButtonElement;
  const panel     = document.getElementById('plinkoPanel')  as HTMLDivElement;
  const coinsEl   = document.getElementById('plinkoCoins')  as HTMLSpanElement;
  const betInput  = document.getElementById('plinkoBet')    as HTMLInputElement;
  const dropBtn   = document.getElementById('plinkoDrop')   as HTMLButtonElement;
  const resultEl  = document.getElementById('plinkoResult') as HTMLDivElement;
  const canvas    = document.getElementById('plinkoCanvas') as HTMLCanvasElement;
  const ctx       = canvas.getContext('2d')!;

  let animating = false;
  let rafId     = 0;

  function layout() {
    const W = canvas.width, H = canvas.height;
    return { W, H, usableW: W - 2 * PAD, usableH: H - PAD_TOP - PAD_BOT };
  }

  function pegXY(r: number, p: number) {
    const { usableW, usableH } = layout();
    return {
      x: PAD + (p + 0.5) * usableW / (r + 1),
      y: PAD_TOP + (r + 1) * usableH / (PLINKO_ROWS + 1),
    };
  }

  function ballPos(path: boolean[], k: number) {
    const { usableW, usableH } = layout();
    const rights = path.slice(0, k).filter(Boolean).length;
    return {
      x: PAD + (rights + 0.5) * usableW / (k + 1),
      y: PAD_TOP + k * usableH / (PLINKO_ROWS + 1),
    };
  }

  // ─── Draw helpers ────────────────────────────────────────────────────────────

  function drawPeg(x: number, y: number, glow: number, traced: boolean) {
    ctx.save();
    if (glow > 0) { ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 14 * glow; }
    else if (traced) { ctx.shadowColor = '#22d3ee'; ctx.shadowBlur = 6; }
    const g = ctx.createRadialGradient(x - 1.5, y - 1.8, 0, x, y, PEG_R);
    const top = glow > 0 ? `rgba(255,255,255,${0.85 + 0.15 * glow})`
      : traced ? '#70c8f0' : '#9ab4cc';
    g.addColorStop(0,   top);
    g.addColorStop(0.4, traced ? '#3a7090' : '#4e6880');
    g.addColorStop(1,   '#1a2a3c');
    ctx.beginPath();
    ctx.arc(x, y, PEG_R, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  }

  function drawBall(x: number, y: number, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = '#f9d71c';
    ctx.shadowBlur  = 22;
    const g = ctx.createRadialGradient(x - 2.5, y - 2.5, 0.5, x, y, BALL_R);
    g.addColorStop(0,   '#fffde0');
    g.addColorStop(0.4, '#f9d71c');
    g.addColorStop(0.8, '#d97706');
    g.addColorStop(1,   '#92400e');
    ctx.beginPath();
    ctx.arc(x, y, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  }

  function drawScene(opts: {
    ballX: number; ballY: number; ballAlpha: number;
    hitPegs: Map<string, number>;
    tracedPegs: Set<string>;
    trail: { x: number; y: number; a: number }[];
    winSlot: number;
    winGlow: number;
  }) {
    const { W, H, usableW, usableH } = layout();
    ctx.clearRect(0, 0, W, H);

    // Background — subtle dark gradient
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0d1830');
    bg.addColorStop(1, '#070c18');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Dot grid for depth
    ctx.fillStyle = 'rgba(50,80,130,0.18)';
    for (let gx = 10; gx < W; gx += 20)
      for (let gy = 10; gy < H; gy += 20)
        ctx.fillRect(gx - 0.5, gy - 0.5, 1, 1);

    // Slot dividers (faint lines between buckets)
    for (let s = 0; s <= PLINKO_ROWS + 1; s++) {
      const x = PAD + s * usableW / (PLINKO_ROWS + 1);
      ctx.strokeStyle = 'rgba(30,42,60,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, PAD_TOP + usableH * 0.88);
      ctx.lineTo(x, H - PAD_BOT + 4);
      ctx.stroke();
    }

    // Slot buckets
    const slotTop = H - PAD_BOT + 6;
    const bw      = usableW / (PLINKO_ROWS + 1) - 4;
    const bh      = 28;
    for (let s = 0; s <= PLINKO_ROWS; s++) {
      const sx    = PAD + (s + 0.5) * usableW / (PLINKO_ROWS + 1);
      const color = slotColor(s);
      const isWin = s === opts.winSlot;
      const pulse = isWin ? opts.winGlow : 0;

      ctx.save();
      if (pulse > 0) { ctx.shadowColor = color; ctx.shadowBlur = 20 * pulse; }
      roundRect(ctx, sx - bw / 2, slotTop, bw, bh, 4);
      const sg = ctx.createLinearGradient(sx, slotTop, sx, slotTop + bh);
      const hi = isWin ? 'cc' : '40';
      const lo = isWin ? '55' : '1a';
      sg.addColorStop(0, color + hi);
      sg.addColorStop(1, color + lo);
      ctx.fillStyle = sg;
      ctx.fill();
      ctx.strokeStyle = color + (isWin ? 'ff' : '60');
      ctx.lineWidth   = isWin ? 1.5 : 0.75;
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle    = isWin ? '#ffffff' : '#b0c4d8';
      ctx.font         = `bold ${isWin ? 10 : 9}px ui-monospace, monospace`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${PLINKO_PAYOUTS[s]}×`, sx, slotTop + bh / 2);
    }

    // Pegs
    for (let r = 0; r < PLINKO_ROWS; r++) {
      for (let p = 0; p <= r; p++) {
        const { x, y } = pegXY(r, p);
        const glow   = opts.hitPegs.get(`${r},${p}`) ?? 0;
        const traced = opts.tracedPegs.has(`${r},${p}`);
        drawPeg(x, y, glow, traced);
      }
    }

    // Trail (fading ghost dots)
    for (const t of opts.trail) {
      ctx.save();
      ctx.globalAlpha = t.a * 0.55;
      ctx.shadowColor = '#f9d71c';
      ctx.shadowBlur  = 10;
      ctx.beginPath();
      ctx.arc(t.x, t.y, BALL_R * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = '#f9d71c';
      ctx.fill();
      ctx.restore();
    }

    // Ball
    if (opts.ballAlpha > 0) drawBall(opts.ballX, opts.ballY, opts.ballAlpha);

    // Win flash overlay
    if (opts.winGlow > 0.7) {
      ctx.save();
      ctx.globalAlpha = (opts.winGlow - 0.7) * 0.25;
      ctx.fillStyle   = slotColor(opts.winSlot);
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }

  function drawIdle() {
    drawScene({
      ballX: 0, ballY: 0, ballAlpha: 0,
      hitPegs: new Map(), tracedPegs: new Set(),
      trail: [], winSlot: -1, winGlow: 0,
    });
  }

  // ─── Animation ───────────────────────────────────────────────────────────────

  function animate(msg: PlinkoResultMsg) {
    if (rafId) cancelAnimationFrame(rafId);

    const startTs   = performance.now();
    const hitPegs   = new Map<string, number>();
    const tracedPegs = new Set<string>();
    const trail: { x: number; y: number; a: number }[] = [];
    let lastTrailX  = -999;
    let lastTrailY  = -999;
    let lastHitRow  = -1;

    let winGlow     = 0;
    let winSettled  = false;

    const frame = (now: number) => {
      const step = (now - startTs) / STEP_MS;
      const k    = Math.floor(step);
      const frac = step - k;

      // ── Landing phase ───────────────────────────────────────────────────────
      if (k >= PLINKO_ROWS) {
        if (!winSettled) {
          winSettled = true;
          winGlow    = 1.0;
          opts.playWin?.();
        }
        winGlow = Math.max(0, winGlow - 0.018);

        const { x, y } = ballPos(msg.path, PLINKO_ROWS);
        drawScene({ ballX: x, ballY: y, ballAlpha: 1, hitPegs, tracedPegs, trail: [], winSlot: msg.slot, winGlow });

        if (winGlow > 0) {
          rafId = requestAnimationFrame(frame);
        } else {
          animating = false;
          dropBtn.disabled = false;
          const net = msg.payout - msg.bet;
          if (msg.payout > 0) {
            resultEl.textContent = `${msg.multiplier}× · +${net} 🪙`;
            resultEl.className   = 'plinko-result plinko-win';
          } else {
            resultEl.textContent = `${msg.multiplier}× · lost ${msg.bet} 🪙`;
            resultEl.className   = 'plinko-result plinko-lose';
          }
          opts.onSettled?.();
        }
        return;
      }

      // ── Decay peg glows ─────────────────────────────────────────────────────
      for (const [key, val] of hitPegs) {
        const next = val - 0.07;
        if (next <= 0) hitPegs.delete(key);
        else hitPegs.set(key, next);
      }

      // ── Ball position (smooth interpolation with arc) ────────────────────────
      const from = ballPos(msg.path, k);
      const to   = ballPos(msg.path, k + 1);
      const t    = easeInOut(frac);
      // Slight downward arc mid-step (simulates gravity hang-time)
      const arc  = Math.sin(frac * Math.PI) * 5;
      const bx   = from.x + (to.x - from.x) * t;
      const by   = from.y + (to.y - from.y) * frac + arc;

      // ── Peg hit flash (first frame entering each row) ───────────────────────
      if (frac < 0.18 && k !== lastHitRow && k < PLINKO_ROWS) {
        lastHitRow = k;
        const rights = msg.path.slice(0, k).filter(Boolean).length;
        hitPegs.set(`${k},${rights}`, 1.0);
        tracedPegs.add(`${k},${rights}`);
      }

      // ── Trail ───────────────────────────────────────────────────────────────
      if (Math.abs(bx - lastTrailX) + Math.abs(by - lastTrailY) > 7) {
        trail.unshift({ x: bx, y: by, a: 0.9 });
        if (trail.length > 5) trail.pop();
        lastTrailX = bx; lastTrailY = by;
      }
      for (const t of trail) t.a *= 0.82;

      drawScene({ ballX: bx, ballY: by, ballAlpha: 1, hitPegs, tracedPegs, trail: [...trail], winSlot: -1, winGlow: 0 });
      rafId = requestAnimationFrame(frame);
    };

    rafId = requestAnimationFrame(frame);
  }

  // ─── Controls ────────────────────────────────────────────────────────────────

  dropBtn.addEventListener('click', () => {
    if (animating) return;
    const amount = Math.max(1, Math.floor(Number(betInput.value)));
    animating = true;
    dropBtn.disabled = true;
    resultEl.textContent = '';
    resultEl.className   = 'plinko-result';
    opts.send(amount);
  });

  btn.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) drawIdle();
  });

  document.addEventListener('click', (e) => {
    if (panel.hidden) return;
    const t = e.target as Node;
    if (!panel.contains(t) && !btn.contains(t)) {
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
  });

  drawIdle();

  return {
    setCoins(n: number) { coinsEl.textContent = String(n); },
    onResult(msg: PlinkoResultMsg) { if (animating) animate(msg); },
  };
}
