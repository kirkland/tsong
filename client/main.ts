// Client entry point: nickname entry, render loop, paddle input (keyboard + mouse),
// and the Join button. Input is only sent when this client holds a paddle.

import { connect } from './net';
import { draw } from './render';
import { COURT, PADDLE, ChatLine, LeaderboardRow, Role, StateMsg } from '../shared/types';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

const overlay = document.getElementById('overlay') as HTMLDivElement;
const joinForm = document.getElementById('joinForm') as HTMLFormElement;
const nick = document.getElementById('nick') as HTMLInputElement;
const joinBtn = document.getElementById('join') as HTMLButtonElement;
const renameBtn = document.getElementById('rename') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const watchersEl = document.getElementById('watchers') as HTMLDivElement;
const leaderboardEl = document.getElementById('leaderboard') as HTMLDivElement;
const chatLog = document.getElementById('chatlog') as HTMLDivElement;
const chatForm = document.getElementById('chatForm') as HTMLFormElement;
const chatInput = document.getElementById('chatInput') as HTMLInputElement;

// Cookies (not localStorage, per request); ~1 year, scoped to the site.
const YEAR = 60 * 60 * 24 * 365;
function setCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=${YEAR};samesite=lax`;
}
function getCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

// Stable per-browser identity — the real leaderboard key. The nickname is just a
// display label; this id is what wins/losses are tied to, so renaming is safe.
function makeId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for non-secure contexts (e.g. plain http on a LAN IP).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
const myPid = getCookie('tsong_pid') ?? (() => {
  const id = makeId();
  setCookie('tsong_pid', id);
  return id;
})();

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
    } else if (msg.type === 'leaderboard') {
      renderLeaderboard(msg.rows);
    } else if (msg.type === 'chat') {
      msg.lines.forEach(addChatLine);
    }
  },
  // On (re)connect, join automatically if we already have a name. This is also what
  // delivers the cookie-remembered nickname once the socket is actually open.
  () => {
    if (myName) net.send({ type: 'join', nickname: myName, pid: myPid });
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
  setCookie('tsong_nick', myName);
  net.send({ type: 'join', nickname: myName, pid: myPid }); // repeat join = rename
  overlay.style.display = 'none';
  enableChat();
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

// --- chat ---
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  net.send({ type: 'chat', text });
  chatInput.value = '';
});

function enableChat() {
  chatInput.disabled = false;
}

// textContent (not innerHTML) keeps user-supplied names/messages from injecting markup.
function addChatLine(line: ChatLine) {
  const row = document.createElement('div');
  const who = document.createElement('span');
  who.className = line.player ? 'chatfrom tag' : 'chatfrom';
  who.textContent = line.player ? `${line.from} (playing)` : line.from;
  const body = document.createElement('span');
  body.className = 'chattext';
  body.textContent = `: ${line.text}`;
  row.append(who, body);
  chatLog.append(row);
  while (chatLog.childElementCount > 100) chatLog.firstElementChild!.remove();
  chatLog.scrollTop = chatLog.scrollHeight;
}

// --- startup: a remembered nickname skips the prompt (the actual join is sent in
// the onOpen handler once the socket connects). ---
const remembered = getCookie('tsong_nick');
if (remembered) {
  myName = remembered;
  nick.value = remembered;
  overlay.style.display = 'none';
  enableChat();
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

// Names come from arbitrary user input, so escape before inserting as HTML.
const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function renderLeaderboard(rows: LeaderboardRow[]) {
  if (!rows.length) {
    leaderboardEl.innerHTML = '';
    return;
  }
  const items = rows
    .map((r, i) => {
      const games = r.wins + r.losses;
      const pct = games ? Math.round((r.wins / games) * 100) : 0;
      return `<li><span class="rank">${i + 1}</span><span class="lbname">${escapeHtml(
        r.name,
      )}</span><span class="rec">${r.wins}–${r.losses}</span><span class="pct">${pct}%</span></li>`;
    })
    .join('');
  leaderboardEl.innerHTML = `<h2>Leaderboard</h2><ol>${items}</ol>`;
}
