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
  const splitBtn = document.getElementById('bjSplit') as HTMLButtonElement;
  const playerArea = document.getElementById('bjPlayerCards') as HTMLDivElement;
  const dealerArea = document.getElementById('bjDealerCards') as HTMLDivElement;
  const resultEl = document.getElementById('bjResult') as HTMLDivElement;
  const statusEl = document.getElementById('bjStatus') as HTMLDivElement;
  let coins = 0;

  function setActionBtns(playing: boolean, canDouble = false, canSplit = false) {
    hitBtn.disabled = !playing;
    standBtn.disabled = !playing;
    doubleBtn.disabled = !playing || !canDouble;
    splitBtn.disabled = !playing || !canSplit;
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
  // One seat of a split round: cards + a caption, dimmed when it's not the seat in play.
  function seatHtml(cards: string[], caption: string, opts: { dim?: boolean; gold?: boolean } = {}): string {
    return `<div style="display:inline-block;vertical-align:top;margin:0 6px;${opts.dim ? 'opacity:0.45;' : ''}">` +
      cards.map((c) => cardHtml(c)).join('') +
      `<div style="font-size:11px;margin-top:2px;font-weight:700;color:${opts.gold ? '#ffd166' : '#9fb0d8'};">${caption}</div></div>`;
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
  splitBtn.addEventListener('click', () => opts.send('bjAction', { action: 'split' }));

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
      if (msg.otherHand && msg.activeHand !== undefined) {
        // Split round: both seats side by side, the one being played lit up.
        const mine = seatHtml(msg.playerCards, `▶ Hand ${msg.activeHand + 1} · ${msg.playerTotal}`, { gold: true });
        const theirs = seatHtml(msg.otherHand.cards, `Hand ${msg.activeHand === 0 ? 2 : 1} · ${msg.otherHand.total}`, { dim: true });
        playerArea.innerHTML = msg.activeHand === 0 ? mine + theirs : theirs + mine;
        statusEl.textContent = `Playing hand ${msg.activeHand + 1} of 2`;
      } else {
        renderCards(playerArea, msg.playerCards);
        statusEl.textContent = `Your total: ${msg.playerTotal}`;
      }
      dealerArea.innerHTML = cardHtml(msg.dealerCard) + cardHtml('', true);
      setActionBtns(true, msg.canDouble, !!msg.canSplit);
      resultEl.textContent = '';
      resultEl.className = '';
    },
    onResult(msg: BjResultMsg) {
      if (msg.hands) {
        // Split showdown: each seat with its own verdict under it.
        const icon = (o: string) => o === 'win' ? '✅' : o === 'push' ? '🤝' : '❌';
        playerArea.innerHTML = msg.hands
          .map((h, i) => seatHtml(h.cards, `Hand ${i + 1} · ${h.total} ${icon(h.outcome)}`, { dim: h.outcome === 'lose' }))
          .join('');
        statusEl.textContent = `Dealer: ${msg.dealerTotal}`;
      } else {
        renderCards(playerArea, msg.playerCards);
        statusEl.textContent = `You: ${msg.playerTotal} · Dealer: ${msg.dealerTotal}`;
      }
      renderCards(dealerArea, msg.dealerCards);
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
