// Client entry point: nickname entry, render loop, paddle input (keyboard + mouse),
// and the Join button. Input is only sent when this client holds a paddle.

import { connect } from './net';
import { draw } from './render';
import {
  COURT,
  PADDLE,
  BALL,
  REACTIONS,
  BALL_REACTION,
  ChatLine,
  LeaderboardRow,
  Role,
  StateMsg,
} from '../shared/types';

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
const colorPicker = document.getElementById('colorPicker') as HTMLDivElement;
const chatLog = document.getElementById('chatlog') as HTMLDivElement;
const chatForm = document.getElementById('chatForm') as HTMLFormElement;
const chatInput = document.getElementById('chatInput') as HTMLInputElement;
const closingModeEl = document.getElementById('closingMode') as HTMLInputElement;
const reactionsEl = document.getElementById('reactions') as HTMLDivElement;
const recentReactionsEl = document.getElementById('recentReactions') as HTMLDivElement;
const ballReactionEl = document.getElementById('ballReaction') as HTMLDivElement;
const reactionLayer = document.getElementById('reactionLayer') as HTMLDivElement;
const fatalityCheck = document.getElementById('fatalityCheck') as HTMLInputElement;

// Cookies (not localStorage, per request); ~1 year, scoped to the site.
const YEAR = 60 * 60 * 24 * 365;
function setCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=${YEAR};samesite=lax`;
}
function getCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function selectSwatch(color: string) {
  for (const btn of colorPicker.querySelectorAll<HTMLButtonElement>('.swatch')) {
    btn.classList.toggle('selected', btn.dataset.color === color);
  }
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
let myColor = '#e8eefc';
let state: StateMsg | null = null;
let ballColor = '#e8eefc'; // live pong-ball color, mirrored onto the ball reaction
let joined = false; // true once the player has entered a nickname (gates reactions)

let target = COURT.h / 2; // desired paddle center Y, court units
let lastSent = -1;
let lastSendAt = 0;
const keys = new Set<string>();

// --- fatalities (opt-in finishing move for the match winner) ---
// The one move we ship: a "Screen Melt". Its input combo is shown to the winner.
const FATALITY = {
  move: 'SCREEN_MELT',
  seq: ['arrowdown', 'arrowdown', 'arrowup'], // the "FINISH HIM" combo
  hint: '↓ ↓ ↑',
};
const COMBO_WINDOW_MS = 1500; // presses older than this are forgotten
let fatalityDone = false; // already fired (or skipped) for the current 'over' screen
let comboBuf: { k: string; t: number }[] = [];

// --- color swatch selection ---
colorPicker.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.swatch');
  if (!btn) return;
  const color = btn.dataset.color;
  if (color) {
    myColor = color;
    selectSwatch(color);
  }
});

const net = connect(
  (msg) => {
    if (msg.type === 'you') {
      myRole = msg.role;
      // Hand the cursor back when we're no longer holding a paddle (e.g. match ended).
      if (!isPlayer() && document.pointerLockElement === canvas) document.exitPointerLock();
    } else if (msg.type === 'state') {
      state = msg;
      syncMyPaddleFromServer();
      updateUI();
    } else if (msg.type === 'leaderboard') {
      renderLeaderboard(msg.rows);
    } else if (msg.type === 'chat') {
      msg.lines.forEach(addChatLine);
    } else if (msg.type === 'reaction') {
      spawnReaction(msg.emoji);
    } else if (msg.type === 'announce') {
      showAnnouncement(msg.text);
    }
  },
  () => {
    if (myName) net.send({ type: 'join', nickname: myName, pid: myPid, color: myColor });
    // Re-assert capture state after a (re)connect so the server's view stays in sync.
    if (pointerLocked) net.send({ type: 'capture', on: true });
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
  setCookie('tsong_color', myColor);
  // repeat join = rename; pid keeps the leaderboard identity stable
  net.send({ type: 'join', nickname: myName, pid: myPid, color: myColor });
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

// --- closing-walls game mode toggle (shared by everyone; applies next match) ---
closingModeEl.addEventListener('change', () =>
  net.send({ type: 'mode', closing: closingModeEl.checked }),
);

// --- chat ---
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  // "/ff" = forfeit: only does anything while you hold a paddle (the server validates
  // too). Swallow it either way so the command never shows up as a chat message.
  if (text.toLowerCase() === '/ff') {
    if (isPlayer()) net.send({ type: 'forfeit' });
    chatInput.value = '';
    return;
  }
  net.send({ type: 'chat', text });
  chatInput.value = '';
});

function enableChat() {
  joined = true;
  chatInput.disabled = false;
  closingModeEl.disabled = false;
  for (const btn of reactionsEl.querySelectorAll<HTMLButtonElement>('.reaction-btn')) {
    btn.disabled = false;
  }
  pickerBtn.disabled = false;
  ballBtn.disabled = false;
  renderRecent(); // re-render so the recent buttons pick up the enabled state
}

// --- emoji reactions (Zoom-style: click to fly an emoji up everyone's screen) ---
function sendReaction(emoji: string) {
  net.send({ type: 'reaction', emoji });
  pushRecent(emoji); // no-op for the defaults and the ball
}

// --- recently-used row: most-recent-first, capped to the default row's length, and
// excluding the defaults (which already have permanent buttons). Persisted in a cookie. ---
const DEFAULT_REACTIONS = new Set<string>(REACTIONS);
const RECENT_SLOTS = REACTIONS.length; // keep the recents row the same length as defaults

function loadRecent(): string[] {
  const raw = getCookie('tsong_recent');
  if (!raw) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e): e is string => typeof e === 'string' && !DEFAULT_REACTIONS.has(e))
      .slice(0, RECENT_SLOTS);
  } catch {
    return [];
  }
}
let recent = loadRecent();

function pushRecent(emoji: string) {
  if (emoji === BALL_REACTION || DEFAULT_REACTIONS.has(emoji)) return;
  recent = [emoji, ...recent.filter((e) => e !== emoji)].slice(0, RECENT_SLOTS);
  setCookie('tsong_recent', JSON.stringify(recent));
  renderRecent();
}

function renderRecent() {
  recentReactionsEl.replaceChildren();
  for (let i = 0; i < RECENT_SLOTS; i++) {
    const emoji = recent[i];
    if (emoji) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'reaction-btn';
      btn.textContent = emoji;
      btn.disabled = !joined;
      btn.setAttribute('aria-label', `react ${emoji}`);
      btn.addEventListener('click', () => sendReaction(emoji));
      recentReactionsEl.append(btn);
    } else {
      const slot = document.createElement('span');
      slot.className = 'recent-slot';
      recentReactionsEl.append(slot);
    }
  }
}
renderRecent();

for (const emoji of REACTIONS) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'reaction-btn';
  btn.textContent = emoji;
  btn.disabled = true; // enabled once the player has joined
  btn.setAttribute('aria-label', `react ${emoji}`);
  btn.addEventListener('click', () => sendReaction(emoji));
  reactionsEl.append(btn);
}

// --- "more emojis" button + Slack-style picker (lazy-loaded full emoji set) ---
interface EmojiEntry {
  emoji: string;
  name: string;
  slug: string;
}
interface EmojiGroup {
  name: string;
  emojis: EmojiEntry[];
}

const pickerBtn = document.createElement('button');
pickerBtn.type = 'button';
pickerBtn.className = 'reaction-btn more';
// Wrap the glyph so it can be nudged up (it sits low in its line box) like the
// CHANGELOG caret, without moving the button itself.
const pickerCaret = document.createElement('span');
pickerCaret.className = 'caret';
pickerCaret.textContent = '▾';
pickerBtn.append(pickerCaret);
pickerBtn.disabled = true;
pickerBtn.setAttribute('aria-label', 'more emojis');
pickerBtn.setAttribute('aria-expanded', 'false');
ballReactionEl.append(pickerBtn);

const picker = document.createElement('div');
picker.id = 'emojiPicker';
picker.hidden = true;
const searchInput = document.createElement('input');
searchInput.id = 'emojiSearch';
searchInput.type = 'text';
searchInput.placeholder = 'search emojis…';
searchInput.autocomplete = 'off';
const grid = document.createElement('div');
grid.id = 'emojiGrid';
grid.innerHTML = '<div class="emoji-loading">loading…</div>';
picker.append(searchInput, grid);
ballReactionEl.append(picker);

// Each category's label + cells, kept around so search can show/hide in place.
const sections: { label: HTMLElement; gridEl: HTMLElement; cells: { btn: HTMLElement; terms: string }[] }[] = [];
let emptyMsg: HTMLElement | null = null;
let pickerLoaded = false;

async function buildPicker() {
  if (pickerLoaded) return;
  pickerLoaded = true;
  // The full emoji dataset is ~200KB, so only fetch it the first time the picker opens.
  const mod = await import('unicode-emoji-json/data-by-group.json');
  const groups = (mod.default ?? mod) as unknown as EmojiGroup[];

  grid.innerHTML = '';
  for (const group of groups) {
    const label = document.createElement('div');
    label.className = 'emoji-cat-label';
    label.textContent = group.name;
    const catGrid = document.createElement('div');
    catGrid.className = 'emoji-cat-grid';
    const cells: { btn: HTMLElement; terms: string }[] = [];
    for (const e of group.emojis) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'emoji-cell';
      cell.textContent = e.emoji;
      cell.title = e.name;
      cell.addEventListener('click', () => {
        sendReaction(e.emoji);
        closePicker();
      });
      catGrid.append(cell);
      cells.push({ btn: cell, terms: `${e.name} ${e.slug}` });
    }
    grid.append(label, catGrid);
    sections.push({ label, gridEl: catGrid, cells });
  }

  emptyMsg = document.createElement('div');
  emptyMsg.className = 'emoji-empty';
  emptyMsg.textContent = 'no emojis match';
  emptyMsg.style.display = 'none';
  grid.append(emptyMsg);
}

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  let anyMatch = false;
  for (const s of sections) {
    let visible = false;
    for (const c of s.cells) {
      const show = !q || c.terms.includes(q);
      c.btn.style.display = show ? '' : 'none';
      if (show) visible = true;
    }
    s.label.style.display = visible ? '' : 'none';
    s.gridEl.style.display = visible ? '' : 'none';
    if (visible) anyMatch = true;
  }
  if (emptyMsg) emptyMsg.style.display = anyMatch ? 'none' : '';
});

function openPicker() {
  picker.hidden = false;
  pickerBtn.setAttribute('aria-expanded', 'true');
  void buildPicker().then(() => searchInput.focus());
}
function closePicker() {
  picker.hidden = true;
  pickerBtn.setAttribute('aria-expanded', 'false');
}
pickerBtn.addEventListener('click', () => (picker.hidden ? openPicker() : closePicker()));

// Dismiss on outside click or Escape.
document.addEventListener('click', (e) => {
  if (picker.hidden) return;
  const t = e.target as Node;
  if (!picker.contains(t) && !pickerBtn.contains(t)) closePicker();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !picker.hidden) closePicker();
});

// The pong-ball reaction: same circular button as the others, but the glyph is a
// flat dot in the live ball color instead of an emoji.
const ballBtn = document.createElement('button');
ballBtn.type = 'button';
ballBtn.className = 'reaction-btn';
ballBtn.disabled = true;
ballBtn.setAttribute('aria-label', 'throw the ball');
ballBtn.style.setProperty('--ball-color', ballColor);
const ballDot = document.createElement('span');
ballDot.className = 'ball-dot';
ballBtn.append(ballDot);
ballBtn.addEventListener('click', () => sendReaction(BALL_REACTION));
ballReactionEl.append(ballBtn);

// Float one emoji from the bottom of the viewport up to the top, with a little
// horizontal drift, wobble, and fade. Cleans itself up when the animation ends.
function spawnReaction(emoji: string) {
  const el = document.createElement('div');
  if (emoji === BALL_REACTION) {
    // Match the on-screen ball exactly: same color, and the same pixel size as the
    // canvas renders it (court radius scaled by the canvas's current display width).
    el.className = 'floating-ball';
    el.style.background = ballColor;
    const scale = canvas.getBoundingClientRect().width / COURT.w;
    const d = 2 * BALL.r * scale;
    el.style.width = `${d}px`;
    el.style.height = `${d}px`;
  } else {
    el.className = 'floating-reaction';
    el.textContent = emoji;
  }
  el.style.left = `${5 + Math.random() * 90}vw`;
  reactionLayer.append(el);

  const rise = window.innerHeight + 120; // travel fully off the top
  const drift = (Math.random() - 0.5) * 180; // px sideways by the time it exits
  const wobble = (Math.random() - 0.5) * 40; // mid-flight sway
  const duration = 2600 + Math.random() * 1600;

  const anim = el.animate(
    [
      { transform: 'translate(0, 0) scale(0.5)', opacity: 0 },
      { transform: `translate(${wobble}px, ${-rise * 0.15}px) scale(1)`, opacity: 1, offset: 0.12 },
      { transform: `translate(${drift - wobble}px, ${-rise * 0.6}px) scale(1.05)`, opacity: 1, offset: 0.65 },
      { transform: `translate(${drift}px, ${-rise}px) scale(1.1)`, opacity: 0 },
    ],
    { duration, easing: 'cubic-bezier(0.4, 0, 0.6, 1)' },
  );
  anim.onfinish = () => el.remove();
  anim.oncancel = () => el.remove();
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

// A big, transient banner across the middle of the screen (e.g. someone forfeits).
function showAnnouncement(text: string) {
  const el = document.createElement('div');
  el.className = 'announce-banner';
  el.textContent = text;
  reactionLayer.append(el);
  const anim = el.animate(
    [
      { opacity: 0, transform: 'translate(-50%, -50%) scale(0.7)' },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: 0.15 },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: 0.8 },
      { opacity: 0, transform: 'translate(-50%, -50%) scale(1.12)' },
    ],
    { duration: 3200, easing: 'ease-out' },
  );
  anim.onfinish = () => el.remove();
  anim.oncancel = () => el.remove();
}

// --- CHANGELOG dropdown (top-right): recent commit messages on main ---
const changelogBtn = document.getElementById('changelogBtn') as HTMLButtonElement;
const changelogPanel = document.getElementById('changelogPanel') as HTMLDivElement;

interface Commit {
  hash: string;
  subject: string;
  date: string;
}
let changelogLoaded = false;

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  let s = Math.max(0, (Date.now() - then) / 1000);
  const steps: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [30, 'day'],
    [12, 'month'],
  ];
  let unit = 'year';
  for (const [size, name] of steps) {
    if (s < size) {
      unit = name;
      break;
    }
    s /= size;
  }
  const n = Math.floor(s);
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

async function loadChangelog() {
  if (changelogLoaded) return;
  changelogLoaded = true;
  try {
    const res = await fetch('/api/changelog');
    const data: { commits?: Commit[] } = await res.json();
    const commits = data.commits ?? [];
    changelogPanel.replaceChildren();
    if (!commits.length) {
      const empty = document.createElement('div');
      empty.className = 'changelog-empty';
      empty.textContent = 'No commits to show.';
      changelogPanel.append(empty);
      return;
    }
    for (const c of commits) {
      const item = document.createElement('div');
      item.className = 'changelog-item';
      const subject = document.createElement('div');
      subject.className = 'changelog-subject';
      subject.textContent = c.subject;
      const meta = document.createElement('div');
      meta.className = 'changelog-meta';
      meta.textContent = `${c.hash} · ${timeAgo(c.date)}`;
      item.append(subject, meta);
      changelogPanel.append(item);
    }
  } catch {
    changelogLoaded = false; // let a later open retry
    changelogPanel.replaceChildren();
    const err = document.createElement('div');
    err.className = 'changelog-empty';
    err.textContent = 'Could not load changelog.';
    changelogPanel.append(err);
  }
}

function openChangelog() {
  changelogPanel.hidden = false;
  changelogBtn.setAttribute('aria-expanded', 'true');
  void loadChangelog();
}
function closeChangelog() {
  changelogPanel.hidden = true;
  changelogBtn.setAttribute('aria-expanded', 'false');
}
changelogBtn.addEventListener('click', () =>
  changelogPanel.hidden ? openChangelog() : closeChangelog(),
);
document.addEventListener('click', (e) => {
  if (changelogPanel.hidden) return;
  const t = e.target as Node;
  if (!changelogPanel.contains(t) && !changelogBtn.contains(t)) closeChangelog();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !changelogPanel.hidden) closeChangelog();
});

// --- startup: a remembered nickname skips the prompt (the actual join is sent in
// the onOpen handler once the socket connects). ---
const remembered = getCookie('tsong_nick');
const savedColor = getCookie('tsong_color');
if (savedColor) {
  myColor = savedColor;
  selectSwatch(savedColor);
}
if (remembered) {
  myName = remembered;
  nick.value = remembered;
  overlay.style.display = 'none';
  enableChat();
} else {
  nick.focus();
}

// --- mouse control ---
// While holding a paddle, lock the pointer to the board so a quick flick can't send the
// cursor out of the play area (which would freeze the paddle or land clicks on the chat
// and buttons). Locked → track relative movement; unlocked → fall back to absolute
// position over the canvas, and click the board to (re)capture the mouse.
let pointerLocked = false;
const clampPaddle = (y: number) => Math.max(PADDLE.h / 2, Math.min(COURT.h - PADDLE.h / 2, y));

canvas.addEventListener('click', () => {
  if (isPlayer() && !pointerLocked) canvas.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
  // Tell the server: the match stays paused until both players have captured.
  net.send({ type: 'capture', on: pointerLocked });
  updateUI();
});

canvas.addEventListener('mousemove', (e) => {
  if (!isPlayer()) return;
  const r = canvas.getBoundingClientRect();
  if (pointerLocked) {
    // Convert screen-pixel movement to court units (1:1 with what's drawn).
    target = clampPaddle(target + e.movementY * (COURT.h / r.height));
  } else {
    target = clampPaddle(((e.clientY - r.top) / r.height) * COURT.h);
  }
});

// --- keyboard control ---
const MOVE_KEYS = new Set(['arrowup', 'arrowdown', 'w', 's']);
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (overlay.style.display !== 'none') return;
  const k = e.key.toLowerCase();
  if (MOVE_KEYS.has(k)) {
    keys.add(k);
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  keys.delete(e.key.toLowerCase());
});

// --- fatality input ---
// The winner is released to "observer" the moment the match ends, so we can't use the
// role to know we won — we match the winning nickname instead (good enough; it's purely
// cosmetic and the server re-checks the real winner by stable id before honoring it).
function canFinish(): boolean {
  return (
    !!state &&
    state.fatalitiesEnabled &&
    state.status === 'over' &&
    !state.fatality &&
    !fatalityDone &&
    !!myName &&
    state.winner === myName
  );
}

// Record a keypress and report whether the tail of recent presses spells the combo.
function pushCombo(k: string, t: number): boolean {
  comboBuf = comboBuf.filter((e) => t - e.t < COMBO_WINDOW_MS);
  comboBuf.push({ k, t });
  const seq = FATALITY.seq;
  const tail = comboBuf.slice(-seq.length);
  return tail.length === seq.length && tail.every((e, i) => e.k === seq[i]);
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (!canFinish()) return;
  const k = e.key.toLowerCase();
  if (!FATALITY.seq.includes(k)) return;
  e.preventDefault(); // arrows would otherwise scroll the page
  if (pushCombo(k, performance.now())) {
    net.send({ type: 'fatality', move: FATALITY.move });
    fatalityDone = true;
    comboBuf = [];
  }
});

// --- fatalities toggle (shared room-wide setting, not per-user) ---
// The checkbox just requests a change; the server owns the value and broadcasts it to
// everyone in `state.fatalitiesEnabled`, which is what updateUI() renders the box from.
fatalityCheck.addEventListener('change', () => {
  net.send({ type: 'setFatalities', enabled: fatalityCheck.checked });
});

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

  // Mirror the live ball color onto the ball reaction button.
  if (state.ball.color !== ballColor) {
    ballColor = state.ball.color;
    ballBtn.style.setProperty('--ball-color', ballColor);
  }

  // Reflect the shared mode (another client may have toggled it). Don't fight the
  // user while they're interacting with the box.
  if (document.activeElement !== closingModeEl && closingModeEl.checked !== state.closing) {
    closingModeEl.checked = state.closing;
  }

  // Keep the checkbox in sync with the shared setting (another player may have flipped it).
  fatalityCheck.checked = state.fatalitiesEnabled;

  // Once the match is no longer over, re-arm the finishing move for next time.
  if (state.status !== 'over') fatalityDone = false;

  if (state.status === 'waiting') statusEl.textContent = 'Waiting for players…';
  else if (state.status === 'over') {
    if (state.fatality) statusEl.textContent = '☠  F A T A L I T Y  ☠';
    else if (canFinish()) statusEl.textContent = `🔪 FINISH HIM!  press  ${FATALITY.hint}`;
    else statusEl.textContent = state.winner ? `🏆 ${state.winner} wins!` : 'Game over';
  } else if (state.paused) {
    // Match is frozen until both players capture their mouse.
    if (isPlayer() && !pointerLocked)
      statusEl.textContent = '🖱 click the board to capture your mouse to start';
    else if (isPlayer())
      statusEl.textContent = '⏸ waiting for the other player to capture their mouse…';
    else statusEl.textContent = '⏸ paused — waiting for players to capture their mice';
  } else if (isPlayer() && !pointerLocked) {
    statusEl.textContent = '🖱 click the board to capture your mouse · Esc to release';
  } else statusEl.textContent = '';

  const spotOpen = !state.paddles.left.name || !state.paddles.right.name;
  joinBtn.style.display = myRole === 'observer' && spotOpen ? 'inline-block' : 'none';
  renameBtn.style.display = myName ? 'inline-block' : 'none';

  // Hidden once the pointer is captured (lock hides it natively anyway); visible while
  // unlocked so a player can see where to click to capture, and for observers.
  canvas.style.cursor = isPlayer() && pointerLocked ? 'none' : 'default';
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
