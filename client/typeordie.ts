// "Type or Die" — the client for the co-op typing horde-defense minigame.
//
// Like the other minigames it's deliberately isolated: its own fullscreen overlay + canvas +
// input handling + render loop, all torn down on exit, never touching the Pong state. But unlike
// DOOM, the sim is SERVER-AUTHORITATIVE: the server (TypeGame) owns the monsters / base / score
// and streams them here as `tdState`. This module just renders that state and turns the player's
// keystrokes into a soft target-lock + a kill claim. Loaded lazily the first time it's opened.

import type { TdEnemy, TdPhase, TdPlayer, TypeDieScoreRow } from '../shared/types';

// Networking hooks into the shared websocket (provided by main.ts).
export interface TypeDieNet {
  join(): void;
  leave(): void;
  start(): void;
  target(id: number | null): void; // soft-lock the word you're typing (null = release)
  kill(id: number): void;          // claim a kill (you finished a word)
  name(): string;                  // this client's display name
  leaderboard(): TypeDieScoreRow[]; // latest best-wave board
}

interface State {
  phase: TdPhase;
  you: string;
  players: TdPlayer[];
  enemies: TdEnemy[];
  baseHp: number;
  baseMax: number;
  wave: number;
  score: number;
  countdown: number;
  overIn: number;
  mvp: string | null;
}

// --- module-level runtime (a single instance; opening again just re-shows the overlay) ---
let net: TypeDieNet | null = null;
let overlay: HTMLDivElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let raf = 0;
let running = false;
let lastFrame = 0;

let state: State | null = null;
const renderY = new Map<number, number>(); // smoothed on-screen y per enemy id
const renderX = new Map<number, number>();
let pops: { x: number; y: number; t: number; color: string }[] = []; // kill-burst effects

// Local typing state: which monster we're mid-word on, and how many chars we've matched.
let targetId: number | null = null;
let typed = 0;
let missFlash = 0; // brief red flash when a keystroke matches nothing

const KIND_COLOR: Record<string, string> = {
  normal: '#ef5350',
  fast: '#ffa726',
  boss: '#ab47bc',
  coin: '#ffd54f',
};
const KIND_R: Record<string, number> = { normal: 20, fast: 15, boss: 40, coin: 18 };

// The server pushes the leaderboard through main.ts → net.leaderboard(); state arrives here.
export function feedTdState(s: State) {
  state = s;
  // Reconcile smoothed positions: seed new enemies, drop departed ones.
  const live = new Set(s.enemies.map((e) => e.id));
  for (const id of [...renderY.keys()]) if (!live.has(id)) { renderY.delete(id); renderX.delete(id); }
  for (const e of s.enemies) {
    if (!renderY.has(e.id)) { renderY.set(e.id, e.y); renderX.set(e.id, e.x); }
  }
  // If our target died (someone else got it, or it reached the base), drop the lock.
  if (targetId !== null && !live.has(targetId)) { targetId = null; typed = 0; }
  // Typing only makes sense while playing.
  if (s.phase !== 'playing') { targetId = null; typed = 0; }
}

export function startTypeDie(n: TypeDieNet) {
  net = n;
  build();
  overlay!.style.display = 'block';
  running = true;
  lastFrame = performance.now();
  window.addEventListener('keydown', onKey, true);
  net.join();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(loop);
}

function exit() {
  running = false;
  cancelAnimationFrame(raf);
  window.removeEventListener('keydown', onKey, true);
  net?.leave();
  if (overlay) overlay.style.display = 'none';
  state = null;
  renderY.clear(); renderX.clear(); pops = [];
  targetId = null; typed = 0;
}

function build() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'typeDieOverlay';
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '9000', display: 'none',
    background: '#05070d', overflow: 'hidden',
  } as CSSStyleDeclaration);

  canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  overlay.appendChild(canvas);
  ctx = canvas.getContext('2d');

  // A clear way out (Esc also works).
  const close = document.createElement('button');
  close.textContent = '✕ exit';
  Object.assign(close.style, {
    position: 'absolute', top: '12px', right: '14px', zIndex: '9001',
    font: '700 13px system-ui, sans-serif', letterSpacing: '1px',
    padding: '6px 12px', borderRadius: '6px', border: '1px solid #3a4663',
    background: '#0e1422', color: '#9fb3d8', cursor: 'pointer',
  } as CSSStyleDeclaration);
  close.addEventListener('click', exit);
  overlay.appendChild(close);

  // Clicking the field starts a run from the waiting room (handy alongside ENTER).
  canvas.addEventListener('click', () => { if (state?.phase === 'lobby') net?.start(); });

  document.body.appendChild(overlay);
}

function onKey(e: KeyboardEvent) {
  if (!running) return;
  if (e.key === 'Escape') { e.preventDefault(); exit(); return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (state?.phase === 'lobby' || state?.phase === 'gameover') net?.start();
    return;
  }
  if (e.key === 'Backspace') { // bail out of the current word and pick a different one
    e.preventDefault();
    if (targetId !== null) { net?.target(null); targetId = null; typed = 0; }
    return;
  }
  if (/^[a-zA-Z]$/.test(e.key)) {
    e.preventDefault();
    handleLetter(e.key.toLowerCase());
  }
}

function handleLetter(ch: string) {
  if (!state || state.phase !== 'playing') return;

  if (targetId !== null) {
    const e = state.enemies.find((x) => x.id === targetId);
    if (!e) { targetId = null; typed = 0; }
    else {
      const w = e.word.toLowerCase();
      if (w[typed] === ch) {
        typed++;
        if (typed >= w.length) { // word complete — claim the kill
          net?.kill(e.id);
          const color = KIND_COLOR[e.kind] ?? '#fff';
          pops.push({ x: renderX.get(e.id) ?? e.x, y: renderY.get(e.id) ?? e.y, t: 1, color });
          net?.target(null);
          targetId = null; typed = 0;
        }
        return;
      }
      // Wrong key for the locked word — forgiving: ignore it (no progress lost).
      missFlash = 0.18;
      return;
    }
  }

  // No active target → lock the most urgent monster whose word starts with this letter.
  const mine = state.you;
  const cands = state.enemies.filter((e) => {
    const w = e.word.toLowerCase();
    return w[0] === ch && (!e.lockedBy || e.lockedBy === mine);
  });
  if (cands.length === 0) { missFlash = 0.18; return; }
  let best = cands[0];
  for (const e of cands) if ((renderY.get(e.id) ?? e.y) > (renderY.get(best.id) ?? best.y)) best = e;
  targetId = best.id;
  typed = 1;
  net?.target(best.id);
}

function loop(now: number) {
  if (!running) return;
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  step(dt);
  draw();
  raf = requestAnimationFrame(loop);
}

function step(dt: number) {
  if (missFlash > 0) missFlash = Math.max(0, missFlash - dt);
  for (const p of pops) p.t -= dt * 2.5;
  pops = pops.filter((p) => p.t > 0);
  if (!state) return;
  // Ease smoothed positions toward the latest snapshot (snapshots arrive ~30 Hz).
  const k = Math.min(1, dt * 14);
  for (const e of state.enemies) {
    const cy = renderY.get(e.id) ?? e.y;
    const cx = renderX.get(e.id) ?? e.x;
    renderY.set(e.id, cy + (e.y - cy) * k);
    renderX.set(e.id, cx + (e.x - cx) * k);
  }
}

// --- rendering -----------------------------------------------------------------------------

function fit(): { w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth, h = window.innerHeight;
  if (canvas!.width !== Math.round(w * dpr) || canvas!.height !== Math.round(h * dpr)) {
    canvas!.width = Math.round(w * dpr);
    canvas!.height = Math.round(h * dpr);
  }
  ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

function colorOf(playerId: string | null): string {
  if (!playerId || !state) return '#888';
  return state.players.find((p) => p.id === playerId)?.color ?? '#888';
}

function draw() {
  if (!ctx || !canvas) return;
  const { w, h } = fit();
  ctx.clearRect(0, 0, w, h);
  // Subtle starfield-ish backdrop.
  ctx.fillStyle = '#05070d';
  ctx.fillRect(0, 0, w, h);

  if (!state) { centerText('Connecting…', w / 2, h / 2, '#6b7a99', 22); return; }

  if (state.phase === 'lobby') return drawLobby(w, h);
  if (state.phase === 'gameover') return drawGameover(w, h);

  drawField(w, h);

  if (state.phase === 'countdown') {
    ctx.fillStyle = 'rgba(5,7,13,0.55)';
    ctx.fillRect(0, 0, w, h);
    centerText(state.countdown > 0 ? String(state.countdown) : 'GO!', w / 2, h / 2, '#ffd54f', 110, true);
    centerText('get ready to type', w / 2, h / 2 + 70, '#9fb3d8', 18);
  }
}

// The field: a top spawn band, monsters marching down, the base bar at the bottom, HUD overlays.
function drawField(w: number, h: number) {
  if (!state || !ctx) return;
  const padX = 40;
  const fieldTop = 70;
  const baseH = 46;
  const fieldH = h - fieldTop - baseH - 20;
  const fieldW = w - padX * 2;
  const X = (x: number) => padX + x * fieldW;
  const Y = (y: number) => fieldTop + Math.max(0, y) * fieldH;

  // base bar
  const baseY = h - baseH - 8;
  const frac = Math.max(0, state.baseHp / state.baseMax);
  ctx.fillStyle = '#10182a';
  ctx.fillRect(padX, baseY, fieldW, baseH);
  const grd = ctx.createLinearGradient(padX, 0, padX + fieldW * frac, 0);
  grd.addColorStop(0, '#1f9d55');
  grd.addColorStop(1, frac > 0.5 ? '#3ddc84' : frac > 0.25 ? '#ffb300' : '#ef5350');
  ctx.fillStyle = grd;
  ctx.fillRect(padX, baseY, fieldW * frac, baseH);
  ctx.strokeStyle = '#2a3550';
  ctx.lineWidth = 2;
  ctx.strokeRect(padX, baseY, fieldW, baseH);
  ctx.fillStyle = '#dbe6ff';
  ctx.font = '700 18px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(`🛡️ BASE  ${Math.ceil(state.baseHp)} / ${state.baseMax}`, w / 2, baseY + baseH / 2);

  // danger line (where monsters start hurting the base)
  ctx.strokeStyle = 'rgba(239,83,80,0.25)';
  ctx.setLineDash([6, 6]);
  ctx.beginPath(); ctx.moveTo(padX, Y(1) - 2); ctx.lineTo(padX + fieldW, Y(1) - 2); ctx.stroke();
  ctx.setLineDash([]);

  // monsters
  for (const e of state.enemies) {
    const ex = X(renderX.get(e.id) ?? e.x);
    const ey = Y(renderY.get(e.id) ?? e.y);
    drawMonster(e, ex, ey);
  }

  // kill bursts
  for (const p of pops) {
    const px = X(p.x), py = Y(p.y);
    ctx.globalAlpha = p.t;
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(px, py, (1 - p.t) * 40 + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  drawHud(w);
  if (missFlash > 0) {
    ctx.fillStyle = `rgba(239,83,80,${missFlash})`;
    ctx.fillRect(0, 0, w, h);
  }
}

function drawMonster(e: TdEnemy, x: number, y: number) {
  if (!ctx || !state) return;
  const r = KIND_R[e.kind] ?? 18;
  const isMine = e.id === targetId;
  const lockedByOther = !!e.lockedBy && e.lockedBy !== state.you;
  const body = KIND_COLOR[e.kind] ?? '#ef5350';

  // body
  ctx.save();
  ctx.globalAlpha = lockedByOther ? 0.5 : 1;
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  // simple eyes for a bit of character
  ctx.fillStyle = '#0b0e16';
  ctx.beginPath(); ctx.arc(x - r * 0.32, y - r * 0.15, r * 0.16, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(x + r * 0.32, y - r * 0.15, r * 0.16, 0, Math.PI * 2); ctx.fill();
  if (e.kind === 'boss') { ctx.fillStyle = '#fff'; ctx.font = '700 14px system-ui'; ctx.textAlign = 'center'; ctx.fillText('👑', x, y - r - 4); }
  if (e.kind === 'coin') { ctx.fillStyle = '#7a5c00'; ctx.font = `700 ${r}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('🪙', x, y + 1); }
  ctx.restore();

  // ring for locked monsters (mine = bright, others = their color)
  if (isMine || lockedByOther) {
    ctx.strokeStyle = isMine ? '#ffeb3b' : colorOf(e.lockedBy);
    ctx.lineWidth = isMine ? 3 : 2;
    ctx.beginPath(); ctx.arc(x, y, r + 5, 0, Math.PI * 2); ctx.stroke();
  }

  // word label with a pill background
  const word = e.word;
  ctx.font = '700 16px ui-monospace, monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const tw = ctx.measureText(word).width;
  const ly = y + r + 14;
  const lx = x - tw / 2;
  ctx.fillStyle = 'rgba(7,11,20,0.85)';
  roundRect(lx - 8, ly - 12, tw + 16, 24, 6);
  ctx.fill();
  if (isMine) {
    // green for the part you've typed, white for what's left
    const done = word.slice(0, typed);
    const rest = word.slice(typed);
    ctx.fillStyle = '#3ddc84';
    ctx.fillText(done, lx, ly);
    const dw = ctx.measureText(done).width;
    ctx.fillStyle = '#fff';
    ctx.fillText(rest, lx + dw, ly);
  } else {
    ctx.fillStyle = lockedByOther ? '#7e8aa6' : '#cdd9f2';
    ctx.fillText(word, lx, ly);
  }
}

function drawHud(w: number) {
  if (!ctx || !state) return;
  ctx.textBaseline = 'top';
  // wave + score, top-left
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffd54f';
  ctx.font = '800 22px system-ui, sans-serif';
  ctx.fillText(`WAVE ${state.wave}`, 18, 14);
  ctx.fillStyle = '#9fb3d8';
  ctx.font = '700 16px system-ui, sans-serif';
  ctx.fillText(`score ${state.score}`, 18, 42);

  // squad roster + kills, top area centered-ish (right side)
  ctx.textAlign = 'right';
  const sorted = [...state.players].sort((a, b) => b.kills - a.kills);
  let yy = 44;
  ctx.font = '700 13px system-ui, sans-serif';
  ctx.fillStyle = '#6b7a99';
  ctx.fillText(`${state.players.length} typing · ⚔ kills`, w - 18, 22);
  for (const p of sorted.slice(0, 8)) {
    ctx.fillStyle = p.id === state.you ? '#ffeb3b' : p.color || '#cdd9f2';
    ctx.fillText(`${p.name}  ${p.kills}`, w - 18, yy);
    yy += 18;
  }
}

function drawLobby(w: number, h: number) {
  if (!ctx || !state || !net) return;
  centerText('TYPE OR DIE', w / 2, h * 0.22, '#ffd54f', 56, true);
  centerText('Co-op typing horde defense — monsters carry words. Type a word to kill it.', w / 2, h * 0.22 + 48, '#9fb3d8', 17);
  centerText('Defend the shared base together. More typists = deeper waves.', w / 2, h * 0.22 + 72, '#6b7a99', 15);

  // who's here
  centerText(`In the arena (${state.players.length}):`, w / 2, h * 0.42, '#cdd9f2', 18);
  ctx.textAlign = 'center'; ctx.font = '700 16px system-ui, sans-serif';
  const names = state.players.map((p) => p.name).join('   ·   ') || '(just you so far)';
  ctx.fillStyle = '#7fd1ff';
  ctx.fillText(names, w / 2, h * 0.42 + 26);

  // start button
  const bw = 280, bh = 56, bx = w / 2 - bw / 2, by = h * 0.56;
  ctx.fillStyle = '#1f9d55';
  roundRect(bx, by, bw, bh, 10); ctx.fill();
  centerText('▶  START  (Enter / click)', w / 2, by + bh / 2 + 1, '#eafff2', 20, true);

  // leaderboard
  const board = net.leaderboard();
  centerText('🏆 Best waves', w / 2, h * 0.72, '#cdd9f2', 18);
  ctx.textAlign = 'center'; ctx.font = '600 15px ui-monospace, monospace';
  if (board.length === 0) {
    ctx.fillStyle = '#6b7a99';
    ctx.fillText('no runs yet — be the first', w / 2, h * 0.72 + 26);
  } else {
    let yy = h * 0.72 + 26;
    const cx = ctx;
    board.slice(0, 6).forEach((r, i) => {
      cx.fillStyle = i === 0 ? '#ffd54f' : '#9fb3d8';
      cx.fillText(`${i + 1}. ${r.name} — wave ${r.wave}`, w / 2, yy);
      yy += 22;
    });
  }
  centerText('Esc to exit', w / 2, h - 30, '#4a5670', 13);
}

function drawGameover(w: number, h: number) {
  if (!ctx || !state || !net) return;
  centerText('💀 BASE DESTROYED', w / 2, h * 0.2, '#ef5350', 48, true);
  centerText(`You reached WAVE ${state.wave}`, w / 2, h * 0.2 + 54, '#ffd54f', 28, true);
  centerText(`squad score ${state.score}`, w / 2, h * 0.2 + 90, '#9fb3d8', 18);
  if (state.mvp) centerText(`🧙 Word Wizard: ${state.mvp}`, w / 2, h * 0.2 + 118, '#7fd1ff', 18);

  // per-player kills
  const sorted = [...state.players].sort((a, b) => b.kills - a.kills);
  ctx.textAlign = 'center'; ctx.font = '700 16px system-ui, sans-serif';
  let yy = h * 0.46;
  for (const p of sorted.slice(0, 8)) {
    ctx.fillStyle = p.id === state.you ? '#ffeb3b' : p.color || '#cdd9f2';
    ctx.fillText(`${p.name} — ${p.kills} kills`, w / 2, yy);
    yy += 22;
  }
  centerText(`🪙 +${Math.min(state.wave, 20)} coins each for the run`, w / 2, yy + 10, '#ffd54f', 15);

  centerText(state.overIn > 0 ? `next round in ${state.overIn}…  (Enter to go now)` : 'returning…', w / 2, h * 0.78, '#9fb3d8', 18);
  centerText('Esc to exit', w / 2, h - 30, '#4a5670', 13);
}

// --- canvas helpers ---
function centerText(text: string, x: number, y: number, color: string, size: number, bold = false) {
  if (!ctx) return;
  ctx.fillStyle = color;
  ctx.font = `${bold ? 800 : 600} ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}
function roundRect(x: number, y: number, w: number, h: number, r: number) {
  if (!ctx) return;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
