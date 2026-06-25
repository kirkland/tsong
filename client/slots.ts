// Slots: classic 3-reel slot machine. Server rolls and settles; client animates the spin.

import type { SlotsResultMsg, SlotsSymbol } from '../shared/types';
import { SLOTS_SYMBOLS, SLOTS_PAYOUTS } from '../shared/types';

export interface SlotsHandle {
  setCoins(n: number): void;
  onResult(msg: SlotsResultMsg): void;
}

export function initSlots(opts: {
  send: (amount: number) => void;
  playWin?: () => void;
  onSettled?: () => void;
}): SlotsHandle {
  const btn = document.getElementById('slotsBtn') as HTMLButtonElement;
  const panel = document.getElementById('slotsPanel') as HTMLDivElement;
  const coinsEl = document.getElementById('slotsCoins') as HTMLSpanElement;
  const betInput = document.getElementById('slotsBet') as HTMLInputElement;
  const spinBtn = document.getElementById('slotsSpin') as HTMLButtonElement;
  const reelEls = [
    document.getElementById('slotsReel0') as HTMLDivElement,
    document.getElementById('slotsReel1') as HTMLDivElement,
    document.getElementById('slotsReel2') as HTMLDivElement,
  ];
  const resultEl = document.getElementById('slotsResult') as HTMLDivElement;
  const payTableEl = document.getElementById('slotsPayTable') as HTMLDivElement;

  let spinning = false;
  // Each reel's current displayed symbols (top, center, bottom).
  let reelState: [SlotsSymbol[], SlotsSymbol[], SlotsSymbol[]] = [
    ['🍒', '🍋', '🍊'],
    ['⭐', '🍀', '💎'],
    ['🍋', '🍒', '⭐'],
  ];
  let animFrames: number[] = [];

  function randSymbol(): SlotsSymbol {
    return SLOTS_SYMBOLS[Math.floor(Math.random() * SLOTS_SYMBOLS.length)];
  }

  function renderReels(state: typeof reelState, highlight = false) {
    reelEls.forEach((el, i) => {
      el.innerHTML = state[i].map((sym, row) =>
        `<div class="slots-sym${row === 1 ? ' center' : ''}${highlight && row === 1 ? ' win-sym' : ''}">${sym}</div>`
      ).join('');
    });
  }

  function buildPayTable() {
    payTableEl.innerHTML = SLOTS_SYMBOLS.map((sym) =>
      `<div class="slots-pay-row"><span>${sym} ${sym} ${sym}</span><span class="slots-pay-mult">${SLOTS_PAYOUTS[sym]}×</span></div>`
    ).join('');
  }

  // Animate the reels spinning with random symbols, then snap to the result.
  function animateSpin(result: SlotsResultMsg, done: () => void) {
    const FRAMES = 24; // total animation frames before snapping
    const STAGGER = 6; // reel 1 stops 6 frames before reel 0, etc.
    let frame = 0;
    animFrames.forEach(cancelAnimationFrame);
    animFrames = [];

    const tick = () => {
      frame++;
      const current: typeof reelState = [
        result.reels[0].map((_, row) => frame >= FRAMES ? result.reels[0][row] : randSymbol()) as SlotsSymbol[],
        result.reels[1].map((_, row) => frame >= FRAMES - STAGGER ? result.reels[1][row] : randSymbol()) as SlotsSymbol[],
        result.reels[2].map((_, row) => frame >= FRAMES - STAGGER * 2 ? result.reels[2][row] : randSymbol()) as SlotsSymbol[],
      ];
      renderReels(current, false);
      if (frame < FRAMES) {
        animFrames.push(requestAnimationFrame(tick));
      } else {
        reelState = result.reels;
        renderReels(reelState, !!result.win);
        done();
      }
    };
    animFrames.push(requestAnimationFrame(tick));
  }

  spinBtn.addEventListener('click', () => {
    if (spinning) return;
    const amount = Math.max(1, Math.floor(Number(betInput.value)));
    spinning = true;
    spinBtn.disabled = true;
    resultEl.textContent = '';
    resultEl.className = '';
    opts.send(amount);
    // Kick off a purely cosmetic pre-spin (server result will arrive shortly).
    let frame = 0;
    const preSpinTick = () => {
      frame++;
      renderReels([
        [randSymbol(), randSymbol(), randSymbol()],
        [randSymbol(), randSymbol(), randSymbol()],
        [randSymbol(), randSymbol(), randSymbol()],
      ]);
      if (frame < 8) animFrames.push(requestAnimationFrame(preSpinTick));
    };
    animFrames.forEach(cancelAnimationFrame);
    animFrames = [];
    animFrames.push(requestAnimationFrame(preSpinTick));
  });

  btn.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) renderReels(reelState);
  });
  document.addEventListener('click', (e) => {
    if (panel.hidden) return;
    const t = e.target as Node;
    if (!panel.contains(t) && !btn.contains(t)) { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  });

  buildPayTable();
  renderReels(reelState);

  return {
    setCoins(n: number) { coinsEl.textContent = String(n); },
    onResult(msg: SlotsResultMsg) {
      animateSpin(msg, () => {
        spinning = false;
        spinBtn.disabled = false;
        if (msg.win) {
          const net = msg.payout - msg.bet;
          resultEl.textContent = `🎰 ${msg.win} ${msg.win} ${msg.win} — ${SLOTS_PAYOUTS[msg.win]}× · +${net} 🪙`;
          resultEl.className = 'slots-win';
          if (msg.win === '7️⃣') resultEl.className += ' slots-jackpot';
          opts.playWin?.();
        } else {
          resultEl.textContent = `No match — lost ${msg.bet} 🪙`;
          resultEl.className = 'slots-lose';
        }
        opts.onSettled?.();
      });
    },
  };
}
