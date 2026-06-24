// Crash: multiplayer casino game. A multiplier rises from 1.00× and crashes at a random
// point. Place your bet during the 8s window and cash out before the crash or lose it all.
// Server broadcasts CrashStateMsg every 100ms during the live phase to all clients.

import type { CrashStateMsg } from '../shared/types';

export interface CrashHandle {
  setCoins(n: number): void;
  onState(msg: CrashStateMsg): void;
}

export function initCrash(opts: {
  sendBet: (amount: number, autoCashout?: number) => void;
  sendCashout: () => void;
  playWin?: () => void;
}): CrashHandle {
  const btn = document.getElementById('crashBtn') as HTMLButtonElement;
  const panel = document.getElementById('crashPanel') as HTMLDivElement;
  const coinsEl = document.getElementById('crashCoins') as HTMLSpanElement;
  const betInput = document.getElementById('crashBet') as HTMLInputElement;
  const autoInput = document.getElementById('crashAuto') as HTMLInputElement;
  const betBtn = document.getElementById('crashBetBtn') as HTMLButtonElement;
  const cashoutBtn = document.getElementById('crashCashoutBtn') as HTMLButtonElement;
  const multEl = document.getElementById('crashMult') as HTMLDivElement;
  const statusEl = document.getElementById('crashStatus') as HTMLDivElement;
  const bettersEl = document.getElementById('crashBetters') as HTMLDivElement;
  const canvas = document.getElementById('crashCanvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;

  let lastPhase: string = 'betting';
  let multHistory: number[] = [1];
  let lastMsg: CrashStateMsg | null = null;
  let alreadyPlayedWin = false;

  function fmt(m: number) { return m.toFixed(2) + '×'; }

  function drawChart(crashed: boolean) {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (multHistory.length < 2) {
      ctx.fillStyle = '#1a2238';
      ctx.fillRect(0, 0, W, H);
      return;
    }
    ctx.fillStyle = '#0a1020';
    ctx.fillRect(0, 0, W, H);
    const maxM = Math.max(...multHistory, 2);
    const pts = multHistory.map((m, i) => ({
      x: 8 + (i / (multHistory.length - 1)) * (W - 16),
      y: H - 8 - ((m - 1) / (maxM - 1)) * (H - 16),
    }));
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = crashed ? '#ff4466' : '#22e8ff';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = crashed ? '#ff4466' : '#22e8ff';
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;
    // Fill
    ctx.lineTo(pts[pts.length - 1].x, H);
    ctx.lineTo(pts[0].x, H);
    ctx.closePath();
    ctx.fillStyle = crashed ? 'rgba(255,68,102,0.07)' : 'rgba(34,232,255,0.07)';
    ctx.fill();
    // Current mult label on the line
    if (!crashed && pts.length > 0) {
      const last = pts[pts.length - 1];
      ctx.fillStyle = '#22e8ff';
      ctx.font = 'bold 11px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(fmt(multHistory[multHistory.length - 1]), Math.min(last.x + 30, W - 2), Math.max(last.y - 6, 14));
    }
  }

  function renderBetters(msg: CrashStateMsg) {
    if (msg.bets.length === 0) {
      bettersEl.innerHTML = '<div class="crash-no-bets">No bets yet</div>';
      return;
    }
    bettersEl.innerHTML = msg.bets.map((b) => {
      let badge: string;
      if (b.cashedAt !== null) {
        badge = `<span class="crash-badge cashed">✅ ${fmt(b.cashedAt)}</span>`;
      } else if (msg.phase === 'ended') {
        badge = `<span class="crash-badge lost">💀</span>`;
      } else {
        badge = `<span class="crash-badge live">🟢</span>`;
      }
      return `<div class="crash-row"><span class="crash-row-name">${b.name}</span><span class="crash-row-amt">${b.amount}🪙</span>${badge}</div>`;
    }).join('');
  }

  function onState(msg: CrashStateMsg) {
    lastMsg = msg;
    const crashed = msg.phase === 'ended';

    if (msg.phase === 'live') {
      if (lastPhase !== 'live') multHistory = [1];
      multHistory.push(msg.multiplier);
    } else if (msg.phase === 'betting') {
      multHistory = [1];
      alreadyPlayedWin = false;
    }
    lastPhase = msg.phase;

    multEl.textContent = fmt(msg.multiplier);
    multEl.className = 'crash-mult ' + (crashed ? 'crashed' : msg.phase === 'live' ? 'live' : 'idle');

    drawChart(crashed);

    if (msg.phase === 'betting') {
      const s = Math.ceil(msg.timeLeft / 1000);
      statusEl.textContent = `Betting open — ${s}s to place bets`;
      betBtn.disabled = msg.yourBet !== null;
      cashoutBtn.hidden = true;
    } else if (msg.phase === 'live') {
      if (msg.yourBet !== null && msg.yourCashedAt === null) {
        statusEl.textContent = `🎰 In the air — cash out any time!`;
        cashoutBtn.hidden = false;
      } else if (msg.yourCashedAt !== null) {
        statusEl.textContent = `✅ Cashed out at ${fmt(msg.yourCashedAt)}`;
        cashoutBtn.hidden = true;
      } else {
        statusEl.textContent = `Watch the multiplier rise…`;
        cashoutBtn.hidden = true;
      }
      betBtn.disabled = true;
    } else {
      // ended
      cashoutBtn.hidden = true;
      betBtn.disabled = false;
      if (msg.yourBet !== null) {
        if (msg.yourCashedAt !== null) {
          const net = Math.floor(msg.yourBet * msg.yourCashedAt) - msg.yourBet;
          statusEl.textContent = `💥 Crashed at ${fmt(msg.crashedAt!)} — you cashed ${fmt(msg.yourCashedAt)} · +${net} 🪙`;
          if (!alreadyPlayedWin && net > 0) { opts.playWin?.(); alreadyPlayedWin = true; }
        } else {
          statusEl.textContent = `💥 Crashed at ${fmt(msg.crashedAt!)} — you lost ${msg.yourBet} 🪙`;
        }
      } else {
        statusEl.textContent = `💥 Crashed at ${fmt(msg.crashedAt!)}`;
      }
    }

    renderBetters(msg);
  }

  betBtn.addEventListener('click', () => {
    const amount = Math.max(1, Math.floor(Number(betInput.value)));
    const autoVal = parseFloat(autoInput.value);
    const auto = autoVal > 1 ? autoVal : undefined;
    opts.sendBet(amount, auto);
    betBtn.disabled = true;
  });
  cashoutBtn.addEventListener('click', () => { opts.sendCashout(); cashoutBtn.hidden = true; });

  btn.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open && lastMsg) { onState(lastMsg); }
  });
  document.addEventListener('click', (e) => {
    if (panel.hidden) return;
    const t = e.target as Node;
    if (!panel.contains(t) && !btn.contains(t)) { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  });

  // Draw empty chart initially
  drawChart(false);

  return {
    setCoins(n: number) { coinsEl.textContent = String(n); },
    onState,
  };
}
