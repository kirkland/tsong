// Blackjack: player vs. dealer. Server deals from a 6-deck shoe and settles the wallet.
// Client renders cards and outcome; all logic is server-authoritative.

import { minBet } from '../shared/types';
import type { BjStateMsg, BjResultMsg } from '../shared/types';

export interface BlackjackHandle {
  setCoins(n: number): void;
  onState(msg: BjStateMsg): void;
  onResult(msg: BjResultMsg): void;
}

export function initBlackjack(opts: {
  send: (type: string, payload: object) => void;
  playWin?: () => void;
  onSettled?: () => void;
}): BlackjackHandle {
  const btn = document.getElementById('bjBtn') as HTMLButtonElement;
  const panel = document.getElementById('bjPanel') as HTMLDivElement;
  const coinsEl = document.getElementById('bjCoins') as HTMLSpanElement;
  const betInput = document.getElementById('bjBet') as HTMLInputElement;
  const dealBtn = document.getElementById('bjDeal') as HTMLButtonElement;
  const hitBtn = document.getElementById('bjHit') as HTMLButtonElement;
  const standBtn = document.getElementById('bjStand') as HTMLButtonElement;
  const doubleBtn = document.getElementById('bjDouble') as HTMLButtonElement;
  const playerArea = document.getElementById('bjPlayerCards') as HTMLDivElement;
  const dealerArea = document.getElementById('bjDealerCards') as HTMLDivElement;
  const resultEl = document.getElementById('bjResult') as HTMLDivElement;
  const statusEl = document.getElementById('bjStatus') as HTMLDivElement;
  let coins = 0;

  function setActionBtns(playing: boolean, canDouble = false) {
    hitBtn.disabled = !playing;
    standBtn.disabled = !playing;
    doubleBtn.disabled = !playing || !canDouble;
    dealBtn.disabled = playing;
    betInput.disabled = playing;
  }

  function cardHtml(card: string, faceDown = false): string {
    if (faceDown) return '<div class="bj-card back">🂠</div>';
    const r = card[0];
    const rank = r === 'T' ? '10' : r;
    const suit = card[1];
    const sym = ({ S: '♠', H: '♥', D: '♦', C: '♣' } as Record<string, string>)[suit] ?? suit;
    const red = suit === 'H' || suit === 'D';
    return `<div class="bj-card${red ? ' red' : ''}">${rank}<br><span>${sym}</span></div>`;
  }

  function renderCards(el: HTMLDivElement, cards: string[], hideSecond = false) {
    el.innerHTML = cards.map((c, i) => cardHtml(c, hideSecond && i === 1)).join('');
  }

  dealBtn.addEventListener('click', () => {
    const min = minBet(coins);
    const amount = Math.max(min, Math.floor(Number(betInput.value)));
    resultEl.textContent = '';
    resultEl.className = '';
    statusEl.textContent = '';
    playerArea.innerHTML = '';
    dealerArea.innerHTML = '';
    opts.send('bjBet', { amount });
  });
  hitBtn.addEventListener('click', () => opts.send('bjAction', { action: 'hit' }));
  standBtn.addEventListener('click', () => opts.send('bjAction', { action: 'stand' }));
  doubleBtn.addEventListener('click', () => opts.send('bjAction', { action: 'double' }));

  btn.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (panel.hidden) return;
    const t = e.target as Node;
    if (!panel.contains(t) && !btn.contains(t)) { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  });

  setActionBtns(false);

  return {
    setCoins(n: number) { coins = n; coinsEl.textContent = `${n} 🪙 (min ${minBet(n)})`; },
    onState(msg: BjStateMsg) {
      renderCards(playerArea, msg.playerCards);
      dealerArea.innerHTML = cardHtml(msg.dealerCard) + cardHtml('', true);
      statusEl.textContent = `Your total: ${msg.playerTotal}`;
      setActionBtns(true, msg.canDouble);
      resultEl.textContent = '';
      resultEl.className = '';
    },
    onResult(msg: BjResultMsg) {
      renderCards(playerArea, msg.playerCards);
      renderCards(dealerArea, msg.dealerCards);
      statusEl.textContent = `You: ${msg.playerTotal} · Dealer: ${msg.dealerTotal}`;
      setActionBtns(false);
      const net = msg.payout - msg.bet;
      if (msg.outcome === 'blackjack') {
        resultEl.textContent = `🃏 BLACKJACK! +${net} 🪙`;
        resultEl.className = 'bj-win bj-bj';
        opts.playWin?.();
      } else if (msg.outcome === 'win') {
        resultEl.textContent = `✅ WIN +${net} 🪙`;
        resultEl.className = 'bj-win';
        opts.playWin?.();
      } else if (msg.outcome === 'push') {
        resultEl.textContent = `🤝 Push — bet returned`;
        resultEl.className = 'bj-push';
      } else {
        resultEl.textContent = `❌ Bust / Lose −${msg.bet} 🪙`;
        resultEl.className = 'bj-lose';
      }
      opts.onSettled?.();
    },
  };
}
