// Client entry point: nickname entry, render loop, paddle input (keyboard + mouse),
// and the Join button. Input is only sent when this client holds a paddle.

import { connect } from './net';
import { draw } from './render';
import { COURT, PADDLE, Role, StateMsg } from '../shared/types';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

const overlay = document.getElementById('overlay') as HTMLDivElement;
const joinForm = document.getElementById('joinForm') as HTMLFormElement;
const nick = document.getElementById('nick') as HTMLInputElement;
const joinBtn = document.getElementById('join') as HTMLButtonElement;
const renameBtn = document.getElementById('rename') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const watchersEl = document.getElementById('watchers') as HTMLDivElement;

// Persist the nickname so returning visitors skip the prompt. Cookie (not
// localStorage) per request; ~1 year, scoped to the site.
const NICK_COOKIE = 'tsong_nick';
function saveNick(name: string) {
  document.cookie = `${NICK_COOKIE}=${encodeURIComponent(name)};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`;
}
function loadNick(): string | null {
  const m = document.cookie.match(new RegExp('(?:^|; )' + NICK_COOKIE + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

let myRole: Role = 'observer';
let myName = '';
let state: StateMsg | null = null;

let target = COURT.h / 2; // desired paddle center Y, court units
let lastSent = -1;
let lastSendAt = 0;
const keys = new Set<string>();

const net = connect(
  (msg) => {
    if (msg.type === 'you') {
      myRole = msg.role;
    } else if (msg.type === 'state') {
      state = msg;
      syncMyPaddleFromServer();
      updateUI();
    }
  },
  // On (re)connect, join automatically if we already have a name. This is also what
  // delivers the cookie-remembered nickname once the socket is actually open.
  () => {
    if (myName) net.send({ type: 'join', nickname: myName });
  },
);

const isPlayer = () => myRole === 'left' || myRole === 'right';

// Keep our local target aligned with the server's paddle when we're not the one
// driving it (e.g. right after claiming a spot), so it doesn't snap on first input.
function syncMyPaddleFromServer() {
  if (state && isPlayer() && lastSent < 0) {
    target = state.paddles[myRole as 'left' | 'right'].y;
  }
}

// --- nickname entry / rename (same form serves both) ---
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  myName = nick.value.trim().slice(0, 20) || 'anon';
  saveNick(myName);
  net.send({ type: 'join', nickname: myName }); // server treats a repeat join as a rename
  overlay.style.display = 'none';
});

// --- change name: reopen the prompt pre-filled with the current name ---
renameBtn.addEventListener('click', () => {
  nick.value = myName;
  overlay.style.display = 'flex';
  nick.focus();
  nick.select();
});

// --- claim a paddle spot ---
joinBtn.addEventListener('click', () => net.send({ type: 'claim' }));

// --- startup: a remembered nickname skips the prompt (the actual join is sent in
// the onOpen handler once the socket connects). ---
const remembered = loadNick();
if (remembered) {
  myName = remembered;
  nick.value = remembered;
  overlay.style.display = 'none';
} else {
  nick.focus();
}

// --- mouse control ---
canvas.addEventListener('mousemove', (e) => {
  if (!isPlayer()) return;
  const r = canvas.getBoundingClientRect();
  target = ((e.clientY - r.top) / r.height) * COURT.h;
});

// --- keyboard control ---
const MOVE_KEYS = new Set(['arrowup', 'arrowdown', 'w', 's']);
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (MOVE_KEYS.has(k)) {
    keys.add(k);
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

// --- main loop ---
function loop(t: number) {
  if (isPlayer()) {
    const step = PADDLE.speed / 60;
    if (keys.has('arrowup') || keys.has('w')) target -= step;
    if (keys.has('arrowdown') || keys.has('s')) target += step;
    target = Math.max(PADDLE.h / 2, Math.min(COURT.h - PADDLE.h / 2, target));

    // Send when it changed meaningfully, throttled to ~30/s.
    if (Math.abs(target - lastSent) > 0.5 && t - lastSendAt > 33) {
      net.send({ type: 'paddle', y: target });
      lastSent = target;
      lastSendAt = t;
    }
  }

  if (state) draw(ctx, state);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// --- HUD ---
function updateUI() {
  if (!state) return;

  if (state.status === 'waiting') statusEl.textContent = 'Waiting for players…';
  else if (state.status === 'over')
    statusEl.textContent = state.winner ? `🏆 ${state.winner} wins!` : 'Game over';
  else statusEl.textContent = '';

  const spotOpen = !state.paddles.left.name || !state.paddles.right.name;
  joinBtn.style.display = myRole === 'observer' && spotOpen ? 'inline-block' : 'none';
  renameBtn.style.display = myName ? 'inline-block' : 'none';

  canvas.style.cursor = isPlayer() ? 'none' : 'default';
  watchersEl.textContent = state.watchers.length
    ? `Watching: ${state.watchers.join(', ')}`
    : '';
}
