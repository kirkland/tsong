// Horse Racing: pick a horse, bet on it, watch the race.

import type { HorseCardMsg, HorseResultMsg } from '../shared/types';

export interface HorseHandle {
  setCoins(n: number): void;
  onCard(msg: HorseCardMsg): void;
  onResult(msg: HorseResultMsg): void;
}

// Distinct colors for the 5 horses
const HORSE_COLORS = ['#f97316', '#3b82f6', '#22d3ee', '#a855f7', '#22c55e'];

export function initHorse(opts: {
  sendReq: () => void;
  sendBet: (horse: number, amount: number) => void;
  playWin?: () => void;
  onSettled?: () => void;
}): HorseHandle {
  const btn = document.getElementById('horseBtn') as HTMLButtonElement;
  const panel = document.getElementById('horsePanel') as HTMLDivElement;
  const coinsEl = document.getElementById('horseCoins') as HTMLSpanElement;
  const betInput = document.getElementById('horseBet') as HTMLInputElement;
  const placeBetBtn = document.getElementById('horsePlaceBet') as HTMLButtonElement;
  const newRaceBtn = document.getElementById('horseNewRace') as HTMLButtonElement;
  const horseListEl = document.getElementById('horseList') as HTMLDivElement;
  const resultEl = document.getElementById('horseResult') as HTMLDivElement;
  const canvas = document.getElementById('horseCanvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;

  let selectedHorse = -1;
  let currentCard: { name: string; odds: number }[] | null = null;
  let animFrame = 0;

  function renderHorseList(horses: { name: string; odds: number }[], winnerIdx = -1, betOn = -1) {
    horseListEl.innerHTML = horses.map((h, i) => {
      let cls = 'horse-row';
      if (i === selectedHorse) cls += ' selected';
      if (winnerIdx >= 0 && i === winnerIdx) cls += ' winner';
      if (winnerIdx >= 0 && i === betOn && i !== winnerIdx) cls += ' loser';
      const emoji = `<span class="horse-emoji" style="color:${HORSE_COLORS[i]}">🐎</span>`;
      const odds = `<span class="horse-odds">${h.odds}×</span>`;
      const selBtn = winnerIdx < 0
        ? `<button class="horse-sel-btn" data-idx="${i}" type="button">Pick</button>`
        : '';
      return `<div class="${cls}" data-idx="${i}">${emoji}<span class="horse-name">${h.name}</span>${odds}${selBtn}</div>`;
    }).join('');

    // Wire up pick buttons
    horseListEl.querySelectorAll('.horse-sel-btn').forEach((b) => {
      (b as HTMLButtonElement).addEventListener('click', () => {
        selectedHorse = Number((b as HTMLButtonElement).dataset.idx);
        renderHorseList(horses);
        placeBetBtn.disabled = false;
      });
    });
  }

  function drawRaceIdle() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0e1830';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#2a3a50';
    ctx.font = '13px ui-sans-serif, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Race starts when you bet', W / 2, H / 2);
  }

  function drawRace(progress: number[], winner: number, done: boolean) {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0e1830';
    ctx.fillRect(0, 0, W, H);

    const n = progress.length;
    const trackH = H / n;

    for (let i = 0; i < n; i++) {
      const y = i * trackH;
      // Track lanes
      ctx.fillStyle = i % 2 === 0 ? '#0a1a2e' : '#0d1f35';
      ctx.fillRect(0, y, W, trackH);
      // Track line
      ctx.strokeStyle = '#1a2a40';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + trackH);
      ctx.lineTo(W, y + trackH);
      ctx.stroke();
      // Finish line
      ctx.strokeStyle = '#ffffff33';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(W - 20, y);
      ctx.lineTo(W - 20, y + trackH);
      ctx.stroke();
      ctx.setLineDash([]);
      // Horse emoji
      const x = 20 + progress[i] * (W - 60);
      const cy = y + trackH / 2;
      ctx.font = `${Math.round(trackH * 0.55)}px serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = HORSE_COLORS[i];
      ctx.fillText('🐎', x, cy);
      // Winner crown
      if (done && i === winner) {
        ctx.font = `${Math.round(trackH * 0.45)}px serif`;
        ctx.fillText('👑', x + Math.round(trackH * 0.55) + 2, cy - 4);
      }
    }
  }

  function animateRace(horses: { name: string; odds: number }[], winnerIdx: number, betOn: number, payout: number, bet: number) {
    const n = horses.length;
    // Build per-horse speed curves: winner reaches finish, others trail behind
    const finishTime = 120; // frames
    const positions = new Array(n).fill(0);
    const speeds = horses.map((_, i) => {
      // Winner finishes at frame finishTime; losers reach ~70-90% by then
      const base = i === winnerIdx ? 1.0 : 0.65 + Math.random() * 0.25;
      return base / finishTime;
    });
    let frame = 0;

    const tick = () => {
      frame++;
      for (let i = 0; i < n; i++) {
        // Use easing: slow acceleration then normal
        const t = frame / finishTime;
        const ease = t < 0.3 ? t * t * 3.3 : t;
        positions[i] = Math.min(1, speeds[i] * finishTime * ease);
        // Slight jitter for realism
        if (frame < finishTime && i !== winnerIdx) {
          positions[i] += (Math.random() - 0.5) * 0.01;
          positions[i] = Math.max(0, Math.min(0.97, positions[i]));
        }
      }
      const done = frame >= finishTime;
      if (done) positions[winnerIdx] = 1.0;
      drawRace(positions, winnerIdx, done);
      if (!done) {
        animFrame = requestAnimationFrame(tick);
      } else {
        renderHorseList(horses, winnerIdx, betOn);
        const won = betOn === winnerIdx;
        const net = payout - bet;
        if (won) {
          resultEl.textContent = `🏆 ${horses[winnerIdx].name} wins! +${net} 🪙`;
          resultEl.className = 'horse-win';
          opts.playWin?.();
        } else {
          resultEl.textContent = `💀 ${horses[winnerIdx].name} wins. Lost ${bet} 🪙`;
          resultEl.className = 'horse-lose';
        }
        newRaceBtn.hidden = false;
        opts.onSettled?.();
      }
    };
    animFrame = requestAnimationFrame(tick);
  }

  placeBetBtn.addEventListener('click', () => {
    if (selectedHorse < 0 || !currentCard) return;
    const amount = Math.max(1, Math.floor(Number(betInput.value)));
    placeBetBtn.disabled = true;
    newRaceBtn.hidden = true;
    resultEl.textContent = '';
    resultEl.className = '';
    opts.sendBet(selectedHorse, amount);
  });

  newRaceBtn.addEventListener('click', () => {
    selectedHorse = -1;
    currentCard = null;
    newRaceBtn.hidden = true;
    placeBetBtn.disabled = true;
    resultEl.textContent = '';
    resultEl.className = '';
    horseListEl.innerHTML = '<div class="horse-loading">🐎 Requesting new race…</div>';
    drawRaceIdle();
    opts.sendReq();
  });

  btn.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) {
      drawRaceIdle();
      if (!currentCard) {
        horseListEl.innerHTML = '<div class="horse-loading">🐎 Loading race…</div>';
        opts.sendReq();
      }
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

  drawRaceIdle();

  return {
    setCoins(n: number) { coinsEl.textContent = String(n); },
    onCard(msg: HorseCardMsg) {
      currentCard = msg.horses;
      selectedHorse = -1;
      placeBetBtn.disabled = true;
      newRaceBtn.hidden = true;
      resultEl.textContent = '';
      resultEl.className = '';
      renderHorseList(msg.horses);
      drawRaceIdle();
    },
    onResult(msg: HorseResultMsg) {
      currentCard = null; // consumed
      cancelAnimationFrame(animFrame);
      animateRace(msg.horses, msg.winner, msg.horse, msg.payout, msg.bet);
    },
  };
}
