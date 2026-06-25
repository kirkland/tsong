// Mines: flip tiles on a 5×5 grid, avoid hidden bombs, cash out whenever you like.

import type { MinesStateMsg, MinesResultMsg } from '../shared/types';
import { MINES_GRID } from '../shared/types';

export interface MinesHandle {
  setCoins(n: number): void;
  onState(msg: MinesStateMsg): void;
  onResult(msg: MinesResultMsg): void;
}

export function initMines(opts: {
  sendBet: (amount: number, mines: number) => void;
  sendReveal: (cell: number) => void;
  sendCashout: () => void;
  playWin?: () => void;
  onSettled?: () => void;
}): MinesHandle {
  const btn        = document.getElementById('minesBtn')       as HTMLButtonElement;
  const panel      = document.getElementById('minesPanel')     as HTMLDivElement;
  const coinsEl    = document.getElementById('minesCoins')     as HTMLSpanElement;
  const betInput   = document.getElementById('minesBetInput')  as HTMLInputElement;
  const minesSel   = document.getElementById('minesMineCount') as HTMLSelectElement;
  const startBtn   = document.getElementById('minesStartBtn')  as HTMLButtonElement;
  const multEl     = document.getElementById('minesMult')      as HTMLSpanElement;
  const payoutEl   = document.getElementById('minesPayout')    as HTMLSpanElement;
  const cashoutBtn = document.getElementById('minesCashoutBtn')as HTMLButtonElement;
  const grid       = document.getElementById('minesGrid')      as HTMLDivElement;
  const resultEl   = document.getElementById('minesResult')    as HTMLDivElement;

  let playing   = false;   // hand in progress
  let lastState: MinesStateMsg | null = null;

  // ── Build the tile grid ──────────────────────────────────────────────────────

  const tiles: HTMLButtonElement[] = [];
  for (let i = 0; i < MINES_GRID; i++) {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = 'mine-tile mine-tile-disabled';
    t.dataset.cell = String(i);
    grid.appendChild(t);
    tiles.push(t);
  }

  function resetTiles() {
    for (const t of tiles) {
      t.className = 'mine-tile' + (playing ? '' : ' mine-tile-disabled');
      t.textContent = '';
    }
  }

  function setTileSafe(i: number) {
    tiles[i].className = 'mine-tile safe';
    tiles[i].textContent = '💎';
  }

  function setTileBoom(i: number, isHit: boolean) {
    tiles[i].className = isHit ? 'mine-tile boom' : 'mine-tile mine-reveal';
    tiles[i].textContent = isHit ? '💥' : '💣';
  }

  function disableAll() {
    for (const t of tiles) t.classList.add('mine-tile-disabled');
  }

  // ── HUD helpers ──────────────────────────────────────────────────────────────

  function updateHud(state: MinesStateMsg) {
    multEl.textContent   = `${state.multiplier.toFixed(2)}×`;
    payoutEl.textContent = state.safeCount > 0 ? `→ ${state.pendingPayout} 🪙` : '';
    cashoutBtn.disabled  = state.safeCount === 0;
  }

  function setSetupEnabled(on: boolean) {
    betInput.disabled  = !on;
    minesSel.disabled  = !on;
    startBtn.disabled  = !on;
  }

  // ── Message handlers ─────────────────────────────────────────────────────────

  function handleState(msg: MinesStateMsg) {
    lastState = msg;
    playing   = true;
    setSetupEnabled(false);
    resultEl.textContent = '';
    resultEl.className   = 'mines-result';
    resetTiles();
    for (let i = 0; i < MINES_GRID; i++) {
      if (msg.revealed[i]) setTileSafe(i);
    }
    updateHud(msg);
  }

  function handleResult(msg: MinesResultMsg) {
    playing   = false;
    lastState = null;
    disableAll();
    // Reveal all mines
    for (const pos of msg.minePositions) {
      setTileBoom(pos, pos === msg.hitCell);
    }
    // Re-mark safe reveals that were already shown (keep the gems)
    // (tiles already set to safe are fine; just make sure they stay)
    cashoutBtn.disabled  = true;
    multEl.textContent   = '';
    payoutEl.textContent = '';

    if (msg.won) {
      resultEl.textContent = `+${msg.net} 🪙 · cashed out`;
      resultEl.className   = 'mines-result mines-win';
      opts.playWin?.();
    } else {
      resultEl.textContent = `−${-msg.net} 🪙 · kaboom 💥`;
      resultEl.className   = 'mines-result mines-lose';
    }

    setSetupEnabled(true);
    opts.onSettled?.();
  }

  // ── Tile clicks ───────────────────────────────────────────────────────────────

  grid.addEventListener('click', (e) => {
    if (!playing) return;
    const t = (e.target as HTMLElement).closest<HTMLButtonElement>('.mine-tile');
    if (!t || t.classList.contains('mine-tile-disabled') || t.classList.contains('safe') || t.classList.contains('boom') || t.classList.contains('mine-reveal')) return;
    const cell = Number(t.dataset.cell);
    opts.sendReveal(cell);
  });

  // ── Start ─────────────────────────────────────────────────────────────────────

  startBtn.addEventListener('click', () => {
    if (playing) return;
    const amount = Math.max(1, Math.floor(Number(betInput.value)));
    const mines  = Number(minesSel.value);
    resultEl.textContent = '';
    resultEl.className   = 'mines-result';
    resetTiles();
    cashoutBtn.disabled  = true;
    multEl.textContent   = '1.00×';
    payoutEl.textContent = '';
    opts.sendBet(amount, mines);
  });

  // ── Cash Out ──────────────────────────────────────────────────────────────────

  cashoutBtn.addEventListener('click', () => {
    if (!playing || !lastState || lastState.safeCount === 0) return;
    opts.sendCashout();
  });

  // ── Panel open/close ──────────────────────────────────────────────────────────

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

  return {
    setCoins(n: number) { coinsEl.textContent = String(n); },
    onState(msg: MinesStateMsg)  { handleState(msg); },
    onResult(msg: MinesResultMsg) { handleResult(msg); },
  };
}
