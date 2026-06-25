// Plinko: drop a ball down an 8-row pegboard. Server rolls the path; client animates it.

import type { PlinkoResultMsg } from '../shared/types';
import { PLINKO_ROWS, PLINKO_PAYOUTS } from '../shared/types';

export interface PlinkoHandle {
  setCoins(n: number): void;
  onResult(msg: PlinkoResultMsg): void;
}

const PAD = 18;
const PAD_TOP = 28;
const PAD_BOT = 48;
const PEG_R = 4;
const BALL_R = 7;
// Slot colors from center outward (symmetric)
const SLOT_COLORS = ['#22d3ee', '#3b82f6', '#f59e0b', '#f97316', '#ef4444'];

export function initPlinko(opts: {
  send: (amount: number) => void;
  playWin?: () => void;
  onSettled?: () => void;
}): PlinkoHandle {
  const btn = document.getElementById('plinkoBtn') as HTMLButtonElement;
  const panel = document.getElementById('plinkoPanel') as HTMLDivElement;
  const coinsEl = document.getElementById('plinkoCoins') as HTMLSpanElement;
  const betInput = document.getElementById('plinkoBet') as HTMLInputElement;
  const dropBtn = document.getElementById('plinkoDrop') as HTMLButtonElement;
  const resultEl = document.getElementById('plinkoResult') as HTMLDivElement;
  const canvas = document.getElementById('plinkoCanvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;

  let animating = false;

  // Compute layout from canvas size
  function layout() {
    const W = canvas.width;
    const H = canvas.height;
    const usableW = W - 2 * PAD;
    const usableH = H - PAD_TOP - PAD_BOT;
    return { W, H, usableW, usableH };
  }

  // Peg center for row r (0=top), peg p (0-indexed) in that row
  function pegXY(r: number, p: number) {
    const { usableW, usableH } = layout();
    const x = PAD + (p + 0.5) * usableW / (r + 1);
    const y = PAD_TOP + (r + 1) * usableH / (PLINKO_ROWS + 1);
    return { x, y };
  }

  // Ball x,y at step k: k=0 above row 0, k=PLINKO_ROWS = landed
  function ballPos(path: boolean[], k: number) {
    const { usableW, usableH } = layout();
    const rights = path.slice(0, k).filter(Boolean).length;
    const x = PAD + (rights + 0.5) * usableW / (k + 1);
    const y = PAD_TOP + k * usableH / (PLINKO_ROWS + 1);
    return { x, y };
  }

  function slotColor(slot: number): string {
    const center = 4; // slot 4 is center of 0-8
    const dist = Math.abs(slot - center);
    return SLOT_COLORS[Math.min(dist, SLOT_COLORS.length - 1)];
  }

  function drawBoard(path: boolean[], step: number, highlight = -1) {
    const { W, H, usableW, usableH } = layout();
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = '#0a1020';
    ctx.fillRect(0, 0, W, H);

    // Pegs
    for (let r = 0; r < PLINKO_ROWS; r++) {
      for (let p = 0; p <= r; p++) {
        const { x, y } = pegXY(r, p);
        ctx.beginPath();
        ctx.arc(x, y, PEG_R, 0, Math.PI * 2);
        ctx.fillStyle = '#4a5568';
        ctx.fill();
      }
    }

    // Slot labels at bottom
    const slotY = H - PAD_BOT + 10;
    for (let s = 0; s <= PLINKO_ROWS; s++) {
      const x = PAD + (s + 0.5) * usableW / (PLINKO_ROWS + 1);
      const color = slotColor(s);
      const isWin = s === highlight;
      ctx.fillStyle = isWin ? color : color + '55';
      const bw = usableW / (PLINKO_ROWS + 1) - 3;
      ctx.fillRect(x - bw / 2, slotY - 8, bw, 24);
      ctx.fillStyle = isWin ? '#fff' : '#ccc';
      ctx.font = `bold ${isWin ? 10 : 9}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${PLINKO_PAYOUTS[s]}×`, x, slotY + 4);
    }

    // Slot dividers
    for (let s = 0; s <= PLINKO_ROWS + 1; s++) {
      const x = PAD + s * usableW / (PLINKO_ROWS + 1);
      ctx.strokeStyle = '#1e2a3a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, PAD_TOP + usableH * 0.92);
      ctx.lineTo(x, H - 4);
      ctx.stroke();
    }

    // Ball
    if (step >= 0 && path.length > 0) {
      const k = Math.min(step, PLINKO_ROWS);
      const { x, y } = ballPos(path, k);
      ctx.beginPath();
      ctx.arc(x, y, BALL_R, 0, Math.PI * 2);
      ctx.fillStyle = '#f9d71c';
      ctx.shadowColor = '#f9d71c';
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  function animate(msg: PlinkoResultMsg) {
    let step = 0;
    drawBoard(msg.path, step, -1);

    const tick = () => {
      step++;
      const landed = step >= PLINKO_ROWS;
      drawBoard(msg.path, step, landed ? msg.slot : -1);
      if (!landed) {
        setTimeout(tick, 180);
      } else {
        // Show result
        animating = false;
        dropBtn.disabled = false;
        const net = msg.payout - msg.bet;
        if (msg.payout > 0) {
          resultEl.textContent = `${msg.multiplier}× · +${net} 🪙`;
          resultEl.className = 'plinko-win';
          opts.playWin?.();
        } else {
          resultEl.textContent = `${msg.multiplier}× · lost ${msg.bet} 🪙`;
          resultEl.className = 'plinko-lose';
        }
        opts.onSettled?.();
      }
    };
    setTimeout(tick, 180);
  }

  dropBtn.addEventListener('click', () => {
    if (animating) return;
    const amount = Math.max(1, Math.floor(Number(betInput.value)));
    animating = true;
    dropBtn.disabled = true;
    resultEl.textContent = '';
    resultEl.className = '';
    opts.send(amount);
  });

  btn.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) {
      // Draw empty board
      drawBoard([], -1, -1);
    }
  });
  document.addEventListener('click', (e) => {
    if (panel.hidden) return;
    const t = e.target as Node;
    if (!panel.contains(t) && !btn.contains(t)) {
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
  });

  // Draw initial board
  drawBoard([], -1, -1);

  return {
    setCoins(n: number) { coinsEl.textContent = String(n); },
    onResult(msg: PlinkoResultMsg) {
      if (animating) animate(msg);
    },
  };
}
