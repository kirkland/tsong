// Hi-Lo: bet coins, get a card, guess Higher or Lower, chain multipliers, cashout any time.

import type { HiLoStateMsg, HiLoResultMsg } from '../shared/types';

export interface HiLoHandle {
  setCoins(n: number): void;
  onState(msg: HiLoStateMsg): void;
  onResult(msg: HiLoResultMsg): void;
}

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
// Alternate suits by value so the card feels distinct each draw
const SUITS = ['♠', '♥', '♦', '♣'];

function rankLabel(card: number): string {
  return RANKS[card - 1] ?? String(card);
}
function suitFor(card: number): string {
  return SUITS[(card - 1) % SUITS.length];
}
function suitColor(card: number): string {
  const s = suitFor(card);
  return s === '♥' || s === '♦' ? '#e85555' : '#e0e8f0';
}

export function initHilo(opts: {
  sendBet: (amount: number) => void;
  sendGuess: (guess: 'hi' | 'lo') => void;
  sendCashout: () => void;
  playWin?: () => void;
  onSettled?: () => void;
}): HiLoHandle {
  const btn = document.getElementById('hiloBtn') as HTMLButtonElement;
  const panel = document.getElementById('hiloPanel') as HTMLDivElement;
  const coinsEl = document.getElementById('hiloCoins') as HTMLSpanElement;
  const betInput = document.getElementById('hiloBet') as HTMLInputElement;
  const dealBtn = document.getElementById('hiloDeal') as HTMLButtonElement;
  const hiBtn = document.getElementById('hiloHi') as HTMLButtonElement;
  const loBtn = document.getElementById('hiloLo') as HTMLButtonElement;
  const cashoutBtn = document.getElementById('hiloCashoutBtn') as HTMLButtonElement;
  const newGameBtn = document.getElementById('hiloNewGame') as HTMLButtonElement;
  const cardEl = document.getElementById('hiloCard') as HTMLDivElement;
  const multEl = document.getElementById('hiloMult') as HTMLSpanElement;
  const pendingEl = document.getElementById('hiloPending') as HTMLSpanElement;
  const resultEl = document.getElementById('hiloResult') as HTMLDivElement;

  let inGame = false;

  function renderCard(card: number) {
    const rank = rankLabel(card);
    const suit = suitFor(card);
    const color = suitColor(card);
    cardEl.innerHTML = `
      <div class="hilo-card-inner" style="color:${color}">
        <div class="hilo-card-corner tl">${rank}<br>${suit}</div>
        <div class="hilo-card-center">${suit}</div>
        <div class="hilo-card-corner br">${rank}<br>${suit}</div>
      </div>`;
  }

  function setGameButtons(active: boolean, card: number) {
    dealBtn.disabled = active;
    betInput.disabled = active;
    hiBtn.hidden = !active;
    loBtn.hidden = !active;
    cashoutBtn.hidden = !active;
    newGameBtn.hidden = active;
    if (active) {
      hiBtn.disabled = card >= 13;
      loBtn.disabled = card <= 1;
    }
  }

  function resetUI() {
    inGame = false;
    cardEl.innerHTML = `<div class="hilo-card-inner hilo-card-back">?</div>`;
    multEl.textContent = '1.00×';
    pendingEl.textContent = '0';
    resultEl.textContent = '';
    resultEl.className = '';
    setGameButtons(false, 0);
  }

  dealBtn.addEventListener('click', () => {
    const amount = Math.max(1, Math.floor(Number(betInput.value)));
    resultEl.textContent = '';
    resultEl.className = '';
    dealBtn.disabled = true;
    opts.sendBet(amount);
  });

  hiBtn.addEventListener('click', () => {
    if (!inGame) return;
    hiBtn.disabled = true;
    loBtn.disabled = true;
    cashoutBtn.disabled = true;
    opts.sendGuess('hi');
  });

  loBtn.addEventListener('click', () => {
    if (!inGame) return;
    hiBtn.disabled = true;
    loBtn.disabled = true;
    cashoutBtn.disabled = true;
    opts.sendGuess('lo');
  });

  cashoutBtn.addEventListener('click', () => {
    if (!inGame) return;
    cashoutBtn.disabled = true;
    hiBtn.disabled = true;
    loBtn.disabled = true;
    opts.sendCashout();
  });

  newGameBtn.addEventListener('click', () => {
    resetUI();
  });

  btn.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (panel.hidden) return;
    const t = e.target as Node;
    if (!panel.contains(t) && !btn.contains(t)) {
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
  });

  resetUI();

  return {
    setCoins(n: number) { coinsEl.textContent = String(n); },

    onState(msg: HiLoStateMsg) {
      inGame = true;
      renderCard(msg.card);
      multEl.textContent = msg.multiplier.toFixed(2) + '×';
      pendingEl.textContent = String(msg.pendingPayout);
      resultEl.textContent = '';
      resultEl.className = '';
      setGameButtons(true, msg.card);
      cashoutBtn.disabled = msg.pendingPayout === 0; // can't cashout before first correct guess
    },

    onResult(msg: HiLoResultMsg) {
      inGame = false;
      renderCard(msg.newCard);
      setGameButtons(false, msg.newCard);
      newGameBtn.hidden = false;

      if (msg.won) {
        const net = msg.net;
        resultEl.textContent = `💰 Cashed out! +${net} 🪙 net`;
        resultEl.className = 'hilo-win';
        opts.playWin?.();
      } else {
        resultEl.textContent = `💀 Busted! Lost ${Math.abs(msg.net)} 🪙`;
        resultEl.className = 'hilo-lose';
      }
      multEl.textContent = '1.00×';
      pendingEl.textContent = '0';
      opts.onSettled?.();
    },
  };
}
