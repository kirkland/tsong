// Street Craps: pass line / don't pass bets with a come-out → point state machine.
// Server rolls the dice; client tracks the craps point across rolls.

import type { CrapsResultMsg } from '../shared/types';

export interface CrapsHandle {
  setCoins(n: number): void;
  onResult(msg: CrapsResultMsg): void;
}

export function initCraps(opts: {
  send: (pass: number, dontPass: number) => void;
  playWin?: () => void;
  onSettled?: () => void;
}): CrapsHandle {
  const btn = document.getElementById('crapsBtn') as HTMLButtonElement;
  const panel = document.getElementById('crapsPanel') as HTMLDivElement;
  const coinsEl = document.getElementById('crapsCoins') as HTMLSpanElement;
  const passInput = document.getElementById('crapsPass') as HTMLInputElement;
  const dontInput = document.getElementById('crapsDontPass') as HTMLInputElement;
  const rollBtn = document.getElementById('crapsRoll') as HTMLButtonElement;
  const diceEl = document.getElementById('crapsDice') as HTMLDivElement;
  const resultEl = document.getElementById('crapsResult') as HTMLDivElement;
  const pointEl = document.getElementById('crapsPoint') as HTMLDivElement;

  const FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  let point: number | null = null;
  let rolling = false;

  function updatePoint() {
    if (point !== null) {
      pointEl.textContent = `🎯 Point: ${point} — roll ${point} to win, 7 to lose`;
      pointEl.className = 'craps-point-active';
    } else {
      pointEl.textContent = `Come-out roll — 7/11 wins, 2/3/12 loses, any other sets the point`;
      pointEl.className = 'craps-point-comeout';
    }
  }

  rollBtn.addEventListener('click', () => {
    if (rolling) return;
    const pass = Math.max(0, Math.floor(Number(passInput.value))) || 0;
    const dontPass = Math.max(0, Math.floor(Number(dontInput.value))) || 0;
    if (pass + dontPass <= 0) return;
    rolling = true;
    rollBtn.disabled = true;
    resultEl.textContent = '🎲 Rolling…';
    resultEl.className = 'craps-rolling';
    opts.send(pass, dontPass);
  });

  btn.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) updatePoint();
  });
  document.addEventListener('click', (e) => {
    if (panel.hidden) return;
    const t = e.target as Node;
    if (!panel.contains(t) && !btn.contains(t)) { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  });

  updatePoint();

  return {
    setCoins(n: number) { coinsEl.textContent = String(n); },
    onResult(msg: CrapsResultMsg) {
      rolling = false;
      rollBtn.disabled = false;
      point = msg.newPoint;
      updatePoint();

      diceEl.textContent = `${FACES[msg.dice[0]]} ${FACES[msg.dice[1]]}`;
      diceEl.classList.add('craps-roll-pop');
      setTimeout(() => diceEl.classList.remove('craps-roll-pop'), 500);

      const pass = Math.max(0, Math.floor(Number(passInput.value))) || 0;
      const dontPass = Math.max(0, Math.floor(Number(dontInput.value))) || 0;

      if (msg.outcome === 'win') {
        const net = msg.passPayout + msg.dontPassPayout - pass - dontPass;
        resultEl.textContent = msg.prevPoint === null
          ? `🎉 Natural! ${msg.total} — Pass wins! +${net} 🪙`
          : `🎉 Point hit! ${msg.total} — Pass wins! +${net} 🪙`;
        resultEl.className = 'craps-win';
        opts.playWin?.();
        opts.onSettled?.();
      } else if (msg.outcome === 'lose') {
        if (msg.push12) {
          resultEl.textContent = `🎲 12 — Pass loses, Don't Pass pushes`;
          resultEl.className = 'craps-push';
        } else if (msg.prevPoint === null) {
          const net = msg.passPayout + msg.dontPassPayout - pass - dontPass;
          resultEl.textContent = `💀 Craps! ${msg.total} — ${net >= 0 ? `+${net}` : `${net}`} 🪙`;
          resultEl.className = net >= 0 ? 'craps-win' : 'craps-lose';
          if (net < 0) opts.playWin?.();
        } else {
          const net = msg.passPayout + msg.dontPassPayout - pass - dontPass;
          resultEl.textContent = `💀 Seven out! — ${net >= 0 ? `+${net}` : `${net}`} 🪙`;
          resultEl.className = net >= 0 ? 'craps-win' : 'craps-lose';
        }
        opts.onSettled?.();
      } else {
        if (msg.prevPoint === null) {
          resultEl.textContent = `🎯 Point set: ${msg.total}. Roll again!`;
        } else {
          resultEl.textContent = `↩️ ${msg.total} — no count. Point still ${point}. Keep rolling.`;
        }
        resultEl.className = 'craps-neutral';
      }
    },
  };
}
