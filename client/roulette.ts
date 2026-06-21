// Roulette: a self-contained casino-wheel panel in the top toolbar. The player picks a chip
// value, clicks the betting board to stake coins, then spins. The wheel spin is purely
// cosmetic — the SERVER rolls the number and settles the wallet (see lobby.roulette); this
// module just lands the wheel on whatever number the server reports and shows the outcome.

import {
  ROULETTE_RED,
  ROULETTE_WHEEL,
  ROULETTE_MAX_TOTAL,
  RouletteBet,
  RouletteBetKind,
} from '../shared/types';

// Outside bets, in board order: row of halves/colors/parities, then the three dozens.
const OUTSIDE: { kind: RouletteBetKind; label: string; cls?: string }[] = [
  { kind: 'low', label: '1–18' },
  { kind: 'even', label: 'EVEN' },
  { kind: 'red', label: 'RED', cls: 'red-out' },
  { kind: 'black', label: 'BLACK', cls: 'black-out' },
  { kind: 'odd', label: 'ODD' },
  { kind: 'high', label: '19–36' },
];
const DOZENS: { kind: RouletteBetKind; label: string }[] = [
  { kind: 'dozen1', label: '1st 12' },
  { kind: 'dozen2', label: '2nd 12' },
  { kind: 'dozen3', label: '3rd 12' },
];

// A stake is keyed by a stable string: 'n:<num>' for a straight number, or the bet kind for
// an outside bet. Value is the coins staked there.
type BetKey = string;
function straightKey(n: number): BetKey { return `n:${n}`; }

export interface RouletteHandle {
  /** Update the player's coin balance (drives the display + affordability gating). */
  setCoins(n: number): void;
  /** Land the wheel on the server's rolled number and settle up the on-screen state. */
  onResult(msg: { number: number; staked: number; payout: number }): void;
  /** True while a spin's wheel animation is still running (the result isn't revealed yet). */
  isSpinning(): boolean;
}

export function initRoulette(opts: {
  send: (bets: RouletteBet[]) => void;
  playWin?: () => void;
  /** Called when a spin's animation finishes — the moment it's safe to reveal the settled wallet. */
  onSettled?: () => void;
}): RouletteHandle {
  const btn = document.getElementById('rouletteBtn') as HTMLButtonElement;
  const panel = document.getElementById('roulettePanel') as HTMLDivElement;
  const coinsEl = document.getElementById('rouletteCoins') as HTMLSpanElement;
  const board = document.getElementById('rouletteBoard') as HTMLDivElement;
  const stakeEl = document.getElementById('rouletteStake') as HTMLSpanElement;
  const resultEl = document.getElementById('rouletteResult') as HTMLDivElement;
  const spinBtn = document.getElementById('rouletteSpin') as HTMLButtonElement;
  const clearBtn = document.getElementById('rouletteClear') as HTMLButtonElement;
  const chipsWrap = document.getElementById('rouletteChips') as HTMLDivElement;
  const wheel = document.getElementById('rouletteWheel') as HTMLCanvasElement;
  const wctx = wheel.getContext('2d')!;

  let coins = 0;
  let chip = 1; // current chip denomination
  let spinning = false;
  let rot = 0; // current wheel rotation, radians
  const bets = new Map<BetKey, number>(); // bet key → coins staked
  // Map each board cell to its bet key so we can paint stake badges back onto it.
  const cells = new Map<BetKey, HTMLElement>();

  const totalStaked = () => [...bets.values()].reduce((a, b) => a + b, 0);
  const cap = () => Math.min(ROULETTE_MAX_TOTAL, coins);

  // --- Build the betting board once ---
  function buildBoard() {
    board.innerHTML = '';
    cells.clear();

    const zero = document.createElement('button');
    zero.type = 'button';
    zero.className = 'rl-zero';
    zero.textContent = '0';
    bindCell(zero, straightKey(0));
    board.appendChild(zero);

    // 1–36 in three rows of twelve (top row 1..12, etc.), matching a real layout closely
    // enough to read. We lay it out row-major as a single 12-col grid of 3 rows.
    const grid = document.createElement('div');
    grid.className = 'rl-grid';
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 12; col++) {
        const n = row * 12 + col + 1;
        const c = document.createElement('button');
        c.type = 'button';
        c.className = `rl-num ${ROULETTE_RED.has(n) ? 'red' : 'black'}`;
        c.textContent = String(n);
        bindCell(c, straightKey(n));
        grid.appendChild(c);
      }
    }
    board.appendChild(grid);

    const dozens = document.createElement('div');
    dozens.className = 'rl-outs';
    for (const d of DOZENS) {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'rl-out';
      c.textContent = d.label;
      bindCell(c, d.kind);
      dozens.appendChild(c);
    }
    board.appendChild(dozens);

    const outs = document.createElement('div');
    outs.className = 'rl-outs';
    for (const o of OUTSIDE) {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = `rl-out ${o.cls ?? ''}`.trim();
      c.textContent = o.label;
      bindCell(c, o.kind);
      outs.appendChild(c);
    }
    board.appendChild(outs);
  }

  // Wire a board cell: left-click stakes the current chip; right-click clears that cell.
  function bindCell(el: HTMLElement, key: BetKey) {
    cells.set(key, el);
    el.addEventListener('click', () => addStake(key));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); clearCell(key); });
  }

  function addStake(key: BetKey) {
    if (spinning) return;
    const room = cap() - totalStaked();
    if (room <= 0) return; // can't afford / hit the per-spin cap
    const add = Math.min(chip, room);
    bets.set(key, (bets.get(key) ?? 0) + add);
    syncBadges();
  }

  function clearCell(key: BetKey) {
    if (spinning) return;
    if (bets.delete(key)) syncBadges();
  }

  function clearAll() {
    if (spinning) return;
    bets.clear();
    syncBadges();
  }

  // Paint stake badges on every cell + refresh the staked total and spin-button state.
  function syncBadges() {
    for (const [key, el] of cells) {
      const amt = bets.get(key) ?? 0;
      let badge = el.querySelector('.rl-stake-badge') as HTMLSpanElement | null;
      if (amt > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'rl-stake-badge';
          el.appendChild(badge);
        }
        badge.textContent = String(amt);
      } else if (badge) {
        badge.remove();
      }
    }
    const total = totalStaked();
    stakeEl.textContent = `Staked: ${total} 🪙`;
    spinBtn.disabled = spinning || total <= 0 || total > coins;
  }

  // --- Bet collection: board state → wire bets ---
  function collectBets(): RouletteBet[] {
    const out: RouletteBet[] = [];
    for (const [key, amount] of bets) {
      if (amount <= 0) continue;
      if (key.startsWith('n:')) out.push({ kind: 'straight', amount, number: Number(key.slice(2)) });
      else out.push({ kind: key as RouletteBetKind, amount });
    }
    return out;
  }

  // --- Wheel drawing + spin animation ---
  const SEG = (Math.PI * 2) / ROULETTE_WHEEL.length;

  function pocketColor(n: number): string {
    if (n === 0) return '#1f8a4c';
    return ROULETTE_RED.has(n) ? '#b6243a' : '#1b2236';
  }

  function drawWheel(r: number) {
    const W = wheel.width, cx = W / 2, cy = W / 2, R = W / 2 - 4;
    wctx.clearRect(0, 0, W, W);
    wctx.save();
    wctx.translate(cx, cy);
    for (let i = 0; i < ROULETTE_WHEEL.length; i++) {
      const n = ROULETTE_WHEEL[i];
      // Pocket i spans [i*SEG, (i+1)*SEG] measured clockwise from the top, plus rotation r.
      const a0 = -Math.PI / 2 + i * SEG + r;
      const a1 = a0 + SEG;
      wctx.beginPath();
      wctx.moveTo(0, 0);
      wctx.arc(0, 0, R, a0, a1);
      wctx.closePath();
      wctx.fillStyle = pocketColor(n);
      wctx.fill();
      // Number label, riding along the wedge.
      const mid = a0 + SEG / 2;
      wctx.save();
      wctx.rotate(mid);
      wctx.fillStyle = '#fff';
      wctx.font = '700 10px ui-monospace, monospace';
      wctx.textAlign = 'center';
      wctx.textBaseline = 'middle';
      wctx.fillText(String(n), R * 0.8, 0);
      wctx.restore();
    }
    // Hub + rim.
    wctx.beginPath();
    wctx.arc(0, 0, R, 0, Math.PI * 2);
    wctx.lineWidth = 3;
    wctx.strokeStyle = '#3a4566';
    wctx.stroke();
    wctx.beginPath();
    wctx.arc(0, 0, R * 0.26, 0, Math.PI * 2);
    wctx.fillStyle = '#0e1424';
    wctx.fill();
    wctx.strokeStyle = '#3a4566';
    wctx.lineWidth = 2;
    wctx.stroke();
    wctx.restore();
    // Fixed pointer at the very top, pointing down into the wheel.
    wctx.beginPath();
    wctx.moveTo(cx - 8, 1);
    wctx.lineTo(cx + 8, 1);
    wctx.lineTo(cx, 16);
    wctx.closePath();
    wctx.fillStyle = '#ffd166';
    wctx.fill();
  }

  // Rotation that puts pocket `idx` centered under the top pointer.
  function restAngleFor(idx: number): number {
    return -(idx * SEG + SEG / 2);
  }

  let rafId = 0;
  function animateTo(number: number, done: () => void) {
    const idx = ROULETTE_WHEEL.indexOf(number);
    const turns = 6; // full spins before settling, for drama
    const target = turns * Math.PI * 2 + restAngleFor(idx);
    // Start from the current resting rotation, normalized so the spin always goes forward.
    const start = rot % (Math.PI * 2);
    const dur = 4200;
    const t0 = performance.now();
    const ease = (x: number) => 1 - Math.pow(1 - x, 3); // easeOutCubic
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      rot = start + (target - start) * ease(p);
      drawWheel(rot);
      if (p < 1) {
        rafId = requestAnimationFrame(step);
      } else {
        rot = target % (Math.PI * 2);
        drawWheel(rot);
        done();
      }
    };
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(step);
  }

  // --- Spin: hand the bets to the server and wait for the result ---
  function spin() {
    if (spinning) return;
    const slate = collectBets();
    const total = totalStaked();
    if (!slate.length || total <= 0 || total > coins) return;
    spinning = true;
    spinBtn.disabled = true;
    clearBtn.disabled = true;
    resultEl.textContent = 'Spinning…';
    resultEl.className = '';
    opts.send(slate);
  }

  // Called by main.ts when the server's rouletteResult arrives.
  function onResult(msg: { number: number; staked: number; payout: number }) {
    if (!spinning) {
      // Spin happened in another context (shouldn't normally) — just snap the wheel.
      drawWheel(restAngleFor(ROULETTE_WHEEL.indexOf(msg.number)));
      return;
    }
    animateTo(msg.number, () => {
      spinning = false;
      clearBtn.disabled = false;
      const n = msg.number;
      const color = n === 0 ? 'green' : ROULETTE_RED.has(n) ? 'red' : 'black';
      const net = msg.payout - msg.staked;
      if (msg.payout > 0) {
        resultEl.className = 'rl-win';
        resultEl.textContent = `🎉 ${n} ${color} — won ${msg.payout} 🪙 (net ${net >= 0 ? '+' : ''}${net})`;
        opts.playWin?.();
      } else {
        resultEl.className = 'rl-lose';
        resultEl.textContent = `💀 ${n} ${color} — lost ${msg.staked} 🪙`;
      }
      bets.clear();
      syncBadges(); // also re-gates the spin button against the new balance
      opts.onSettled?.(); // wheel has landed — safe to reveal the settled wallet elsewhere now
    });
  }

  // --- Panel open/close (mirrors the other top-left dropdowns) ---
  btn.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) { syncBadges(); drawWheel(rot); }
  });
  document.addEventListener('click', (e) => {
    if (panel.hidden) return;
    const t = e.target as Node;
    if (!panel.contains(t) && !btn.contains(t)) { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  });

  // Chip selector.
  chipsWrap.querySelectorAll<HTMLButtonElement>('.rl-chip').forEach((b) => {
    b.addEventListener('click', () => {
      chip = Number(b.dataset.chip) || 1;
      chipsWrap.querySelectorAll('.rl-chip').forEach((x) => x.classList.toggle('active', x === b));
    });
  });
  spinBtn.addEventListener('click', spin);
  clearBtn.addEventListener('click', clearAll);

  buildBoard();
  drawWheel(0);
  syncBadges();

  return {
    setCoins(n: number) {
      coins = n;
      coinsEl.textContent = String(n);
      // A balance change can make the current slate unaffordable; re-gate the spin button.
      if (!spinning) syncBadges();
    },
    onResult,
    isSpinning: () => spinning,
  };
}
