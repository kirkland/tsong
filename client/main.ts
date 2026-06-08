// Client entry point: nickname entry, render loop, paddle input (keyboard + mouse),
// and the Join button. Input is only sent when this client holds a paddle.

import { connect } from './net';
import { draw, drawLegendIcon } from './render';
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
  PowerupKind,
} from '../shared/types';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

const overlay = document.getElementById('overlay') as HTMLDivElement;
const joinForm = document.getElementById('joinForm') as HTMLFormElement;
const nick = document.getElementById('nick') as HTMLInputElement;
const joinBtn = document.getElementById('join') as HTMLButtonElement;
const queueBtn = document.getElementById('queueBtn') as HTMLButtonElement;
const queueArea = document.getElementById('queueArea') as HTMLDivElement;
const readyBtn = document.getElementById('readyBtn') as HTMLButtonElement;
const renameBtn = document.getElementById('rename') as HTMLButtonElement;
const kingStatusEl = document.getElementById('kingStatus') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const watchersEl = document.getElementById('watchers') as HTMLDivElement;
const leaderboardEl = document.getElementById('leaderboard') as HTMLDivElement;
const colorPicker = document.getElementById('colorPicker') as HTMLDivElement;
const chatLog = document.getElementById('chatlog') as HTMLDivElement;
const chatForm = document.getElementById('chatForm') as HTMLFormElement;
const chatInput = document.getElementById('chatInput') as HTMLInputElement;
const closingModeEl = document.getElementById('closingMode') as HTMLInputElement;
const gravityModeEl = document.getElementById('gravityMode') as HTMLInputElement;
const turboModeEl = document.getElementById('turboMode') as HTMLInputElement;
const streamerModeEl = document.getElementById('streamerMode') as HTMLInputElement;
const reactionsEl = document.getElementById('reactions') as HTMLDivElement;
const recentReactionsEl = document.getElementById('recentReactions') as HTMLDivElement;
const ballReactionEl = document.getElementById('ballReaction') as HTMLDivElement;
const reactionLayer = document.getElementById('reactionLayer') as HTMLDivElement;
const fatalityCheck = document.getElementById('fatalityCheck') as HTMLInputElement;
const combosBtn = document.getElementById('combosBtn') as HTMLButtonElement;
const combosModal = document.getElementById('combosModal') as HTMLDivElement;
const combosCard = document.getElementById('combosCard') as HTMLDivElement;
const combosClose = document.getElementById('combosClose') as HTMLButtonElement;
const combosList = document.getElementById('combosList') as HTMLDivElement;

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
// Each finisher has its own arrow combo so the winner can pick which one to perform.
const FATALITIES = [
  { move: 'SCREEN_MELT', label: 'Melt', seq: ['arrowdown', 'arrowdown', 'arrowup'], hint: '↓↓↑', desc: 'The ball flares into a fireball and melts the loser down the court like wax.' },
  { move: 'PADDLE_SPLIT', label: 'Explode', seq: ['arrowup', 'arrowup', 'arrowdown'], hint: '↑↑↓', desc: 'The loser is dragged to center, cracks apart, and explodes in shrapnel.' },
  { move: 'FROST_SHATTER', label: 'Freeze', seq: ['arrowdown', 'arrowup', 'arrowdown'], hint: '↓↑↓', desc: 'The loser freezes solid, cracks, and shatters into a spray of ice shards.' },
  { move: 'NOT_FOUND', label: '404', seq: ['arrowup', 'arrowup', 'arrowup'], hint: '↑↑↑', desc: 'The loser glitches into a missing-texture checkerboard and blinks out: 404.' },
  { move: 'SINGULARITY', label: 'Black Hole', seq: ['arrowdown', 'arrowdown', 'arrowdown'], hint: '↓↓↓', desc: 'Space buckles. A black hole tears open at center court, spaghettifies the loser into its accretion disk, then implodes into a blinding singularity and detonates.' },
  { move: 'PAC_CHOMP', label: 'Pac-Man', seq: ['arrowup', 'arrowdown', 'arrowup'], hint: '↑↓↑', desc: 'You become a yellow Pac-Man and waka-waka down a trail of ping-pong pellets to the frozen loser, devour them, then balloon up and burst.' },
  { move: 'JSAV', label: 'Jsav', seq: ['arrowup', 'arrowdown', 'arrowdown'], hint: '↑↓↓', desc: "The loser becomes Jsav, whose face stretches taller and inflates ever bigger and wider until it swallows the whole court." },
] as const;
const COMBO_KEYS = new Set(FATALITIES.flatMap((f) => f.seq as readonly string[]));
const COMBO_WINDOW_MS = 1500; // presses older than this are forgotten
let fatalityDone = false; // already fired (or skipped) for the current 'over' screen

// "FINISH HIM!" announcer sting, played once when a match ends with fatalities armed.
const finishSound = new Audio('/finish-him.mp3');
finishSound.preload = 'auto';
// Per-fatality sounds, played for the duration of the finisher animation. Only two
// finishers have a sound; the rest play silently.
const pacmanSound = new Audio('/start-music.mp3'); // PAC_CHOMP only
pacmanSound.preload = 'auto';
const jsavSound = new Audio('/you-lose.mp3'); // JSAV only
jsavSound.preload = 'auto';
let prevStatus: StateMsg['status'] | null = null; // last seen status, to fire on the rising edge into 'over'
let prevFatality = false; // whether a fatality was playing last frame, to fire music on the rising edge
let comboBuf: { k: string; t: number }[] = [];

// Return the fatality move whose combo the recent keypresses just completed, or null.
function matchCombo(): string | null {
  for (const f of FATALITIES) {
    const tail = comboBuf.slice(-f.seq.length);
    if (tail.length === f.seq.length && tail.every((e, i) => e.k === f.seq[i])) return f.move;
  }
  return null;
}

function randomColor(): string {
  const hue = Math.random() * 360;
  const sat = 60 + Math.random() * 30;
  const lit = 50 + Math.random() * 25;
  return `hsl(${hue}, ${sat}%, ${lit}%)`;
}

// --- color swatch selection ---
colorPicker.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.swatch');
  if (!btn) return;
  const color = btn.id === 'randomColor' ? randomColor() : btn.dataset.color;
  if (color) {
    myColor = color;
    selectSwatch(color);
    // Update the random button background to show the current random color
    if (btn.id === 'randomColor') btn.style.background = color;
  }
});

const net = connect(
  (msg) => {
    if (msg.type === 'you') {
      myRole = msg.role;
      // Hand the cursor back when we're no longer holding a paddle (e.g. match ended).
      if (!isPlayer() && document.pointerLockElement === canvas) document.exitPointerLock();
    } else if (msg.type === 'state') {
      // Play the "FINISH HIM!" sting once, the instant the match ends with fatalities
      // armed (the moment the prompt appears for the winner). Edge-triggered so it
      // doesn't retrigger on every state frame while the 'over' screen lingers.
      if (msg.status === 'over' && prevStatus !== 'over' && msg.fatalitiesEnabled && msg.winner) {
        finishSound.currentTime = 0;
        finishSound.play().catch(() => {}); // ignore autoplay blocks (e.g. a spectator who never clicked)
      }
      // Play a finisher's sound for the duration of its animation: start it the frame
      // the fatality appears, stop it the frame it clears. Only Pac-Man and Jsav have
      // a sound; every other finisher is silent.
      const fatalityActive = !!msg.fatality;
      if (fatalityActive && !prevFatality) {
        const track =
          msg.fatality?.move === 'JSAV' ? jsavSound
          : msg.fatality?.move === 'PAC_CHOMP' ? pacmanSound
          : null;
        if (track) {
          finishSound.pause(); // hand off from the "FINISH HIM!" sting to the sound
          track.currentTime = 0;
          track.play().catch(() => {});
        }
      } else if (!fatalityActive && prevFatality) {
        pacmanSound.pause();
        pacmanSound.currentTime = 0;
        jsavSound.pause();
        jsavSound.currentTime = 0;
      }
      prevFatality = fatalityActive;
      prevStatus = msg.status;
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
    // The server replays recent chat history on every (re)connect. Clear the log first so
    // a reconnect (which keeps the page, and thus the old lines) doesn't duplicate them.
    chatLog.replaceChildren();
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

// --- queue: join/leave the spectator queue ---
let inQueue = false;
queueBtn.addEventListener('click', () => {
  if (inQueue) {
    net.send({ type: 'queueLeave' });
    inQueue = false;
    queueBtn.textContent = 'Join queue';
  } else {
    net.send({ type: 'queueJoin' });
    inQueue = true;
    queueBtn.textContent = 'Leave queue';
  }
});

// --- ready up for the next match ---
readyBtn.addEventListener('click', () => net.send({ type: 'ready' }));

// --- change name: reopen the prompt pre-filled with the current name ---
renameBtn.addEventListener('click', () => {
  nick.value = myName;
  overlay.style.display = 'flex';
  nick.focus();
  nick.select();
});

// --- claim a paddle spot ---
joinBtn.addEventListener('click', () => net.send({ type: 'claim' }));

// --- king exit: winner declines to stay ---
kingStatusEl.addEventListener('click', () => net.send({ type: 'kingExit' }));

// --- closing-walls game mode toggle (shared by everyone; applies next match) ---
closingModeEl.addEventListener('change', () =>
  net.send({ type: 'mode', closing: closingModeEl.checked }),
);
gravityModeEl.addEventListener('change', () =>
  net.send({ type: 'mode', gravity: gravityModeEl.checked }),
);
turboModeEl.addEventListener('change', () =>
  net.send({ type: 'mode', turbo: turboModeEl.checked }),
);
streamerModeEl.addEventListener('change', () =>
  net.send({ type: 'mode', streamer: streamerModeEl.checked }),
);

// --- slash commands ---
// Typing "/" in chat pops up this menu of commands; each only appears when usable.
interface ChatCommand {
  name: string; // the word after the slash, e.g. "ff"
  hint: string; // short description shown in the menu
  enabled: () => boolean; // whether it's currently usable (greyed out when false)
  disabledHint: string; // why it's unusable right now (shown greyed in its place)
  run: () => void; // what it does when chosen
}

const COMMANDS: ChatCommand[] = [
  {
    name: 'ff',
    hint: 'Forfeit the match',
    enabled: () => isPlayer(),
    disabledHint: "only while you're playing",
    run: () => net.send({ type: 'forfeit' }),
  },
  {
    name: 'powerup',
    hint: 'Spawn a random power-up',
    enabled: () => !isPlayer() && state?.status === 'playing',
    disabledHint: 'spectators only, during a live match',
    run: () => net.send({ type: 'spawnPowerup' }),
  },
];

// Every command whose name matches what's typed after "/", usable or not.
function matchingCommands(): ChatCommand[] {
  const v = chatInput.value;
  if (!v.startsWith('/')) return [];
  const prefix = v.slice(1).split(/\s+/)[0].toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(prefix));
}

const commandMenu = document.createElement('div');
commandMenu.id = 'commandMenu';
commandMenu.hidden = true;
chatForm.append(commandMenu);

let menuCmds: ChatCommand[] = [];
let menuIndex = 0;

function renderCommandMenu() {
  commandMenu.replaceChildren();
  const hdr = document.createElement('div');
  hdr.className = 'cmd-hdr';
  hdr.textContent = 'Commands';
  commandMenu.append(hdr);
  menuCmds.forEach((c, i) => {
    const ok = c.enabled();
    const row = document.createElement('div');
    row.className = 'cmd-row' + (i === menuIndex ? ' active' : '') + (ok ? '' : ' disabled');
    const name = document.createElement('span');
    name.className = 'cmd-name';
    name.textContent = `/${c.name}`;
    const hint = document.createElement('span');
    hint.className = 'cmd-hint';
    hint.textContent = ok ? c.hint : `${c.hint} — ${c.disabledHint}`;
    row.append(name, hint);
    // mousedown (not click) so the input doesn't blur out from under the selection.
    // Always preventDefault to keep focus; runCommand ignores disabled commands.
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      runCommand(c);
    });
    commandMenu.append(row);
  });
}

function refreshCommandMenu() {
  menuCmds = joined ? matchingCommands() : [];
  if (!menuCmds.length) {
    commandMenu.hidden = true;
    return;
  }
  if (menuIndex >= menuCmds.length) menuIndex = 0;
  renderCommandMenu();
  commandMenu.hidden = false;
}

function closeCommandMenu() {
  commandMenu.hidden = true;
}

function runCommand(cmd: ChatCommand) {
  if (!cmd.enabled()) return; // greyed out: leave the text so it's clear nothing happened
  cmd.run();
  chatInput.value = '';
  closeCommandMenu();
}

// --- chat ---
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  // A recognized "/command" runs (and is swallowed); unknown slash text falls through
  // to chat. Enter with the menu open is handled in the keydown listener below.
  if (text.startsWith('/')) {
    const name = text.slice(1).split(/\s+/)[0].toLowerCase();
    const cmd = COMMANDS.find((c) => c.name === name);
    if (cmd) {
      runCommand(cmd);
      return;
    }
  }
  net.send({ type: 'chat', text });
  chatInput.value = '';
  closeCommandMenu();
});

chatInput.addEventListener('input', refreshCommandMenu);
chatInput.addEventListener('focus', refreshCommandMenu);
chatInput.addEventListener('keydown', (e) => {
  if (commandMenu.hidden) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    menuIndex = (menuIndex + 1) % menuCmds.length;
    renderCommandMenu();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    menuIndex = (menuIndex - 1 + menuCmds.length) % menuCmds.length;
    renderCommandMenu();
  } else if (e.key === 'Enter') {
    // Run the highlighted command instead of submitting the raw text.
    e.preventDefault();
    runCommand(menuCmds[menuIndex]);
  } else if (e.key === 'Tab') {
    // Autocomplete the name without running it.
    e.preventDefault();
    chatInput.value = `/${menuCmds[menuIndex].name}`;
    refreshCommandMenu();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeCommandMenu();
  }
});
// Close the menu when focus/clicks leave the chat form.
document.addEventListener('click', (e) => {
  if (!commandMenu.hidden && !chatForm.contains(e.target as Node)) closeCommandMenu();
});

function enableChat() {
  joined = true;
  chatInput.disabled = false;
  closingModeEl.disabled = false;
  gravityModeEl.disabled = false;
  turboModeEl.disabled = false;
  streamerModeEl.disabled = false;
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
  who.style.color = line.color;
  const body = document.createElement('span');
  body.className = line.command ? 'chattext chatcmd' : 'chattext';
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

// --- Game Modes dropdown (top-left): game mode toggles ---
const gameModesBtn = document.getElementById('gameModesBtn') as HTMLButtonElement;
const gameModesPanel = document.getElementById('gameModesPanel') as HTMLDivElement;

function openGameModes() {
  gameModesPanel.hidden = false;
  gameModesBtn.setAttribute('aria-expanded', 'true');
}
function closeGameModes() {
  gameModesPanel.hidden = true;
  gameModesBtn.setAttribute('aria-expanded', 'false');
}
gameModesBtn.addEventListener('click', () =>
  gameModesPanel.hidden ? openGameModes() : closeGameModes(),
);
document.addEventListener('click', (e) => {
  if (gameModesPanel.hidden) return;
  const t = e.target as Node;
  if (!gameModesPanel.contains(t) && !gameModesBtn.contains(t)) closeGameModes();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !gameModesPanel.hidden) closeGameModes();
});

// --- Power-ups dropdown (top-left, next to MODES): legend of all power-ups ---
const powerupInfoBtn = document.getElementById('powerupInfoBtn') as HTMLButtonElement;
const powerupInfoPanel = document.getElementById('powerupInfoPanel') as HTMLDivElement;

function openPowerupInfo() {
  powerupInfoPanel.hidden = false;
  powerupInfoBtn.setAttribute('aria-expanded', 'true');
}
function closePowerupInfo() {
  powerupInfoPanel.hidden = true;
  powerupInfoBtn.setAttribute('aria-expanded', 'false');
}
powerupInfoBtn.addEventListener('click', () =>
  powerupInfoPanel.hidden ? openPowerupInfo() : closePowerupInfo(),
);
document.addEventListener('click', (e) => {
  if (powerupInfoPanel.hidden) return;
  const t = e.target as Node;
  if (!powerupInfoPanel.contains(t) && !powerupInfoBtn.contains(t)) closePowerupInfo();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !powerupInfoPanel.hidden) closePowerupInfo();
});

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
  // The paddle only moves while the mouse is captured to the board.
  if (!isPlayer() || !pointerLocked) return;
  const r = canvas.getBoundingClientRect();
  // Convert screen-pixel movement to court units (1:1 with what's drawn).
  target = clampPaddle(target + e.movementY * (COURT.h / r.height));
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

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (!canFinish()) return;
  const k = e.key.toLowerCase();
  if (!COMBO_KEYS.has(k)) return;
  e.preventDefault(); // arrows would otherwise scroll the page
  const t = performance.now();
  comboBuf = comboBuf.filter((entry) => t - entry.t < COMBO_WINDOW_MS);
  comboBuf.push({ k, t });
  const move = matchCombo();
  if (move) {
    net.send({ type: 'fatality', move });
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

// --- fatality combos reference modal ---
// Built once from FATALITIES so adding a finisher there auto-lists it here. Keys render
// as little ↑/↓ keycaps; the description explains what each finisher does.
const ARROW: Record<string, string> = { arrowup: '↑', arrowdown: '↓' };
function buildCombosList() {
  combosList.replaceChildren();
  for (const f of FATALITIES) {
    const row = document.createElement('div');
    row.className = 'combo-row';

    const keys = document.createElement('div');
    keys.className = 'combo-keys';
    for (const k of f.seq) {
      const cap = document.createElement('span');
      cap.className = 'combo-key';
      cap.textContent = ARROW[k] ?? k;
      keys.append(cap);
    }

    const info = document.createElement('div');
    info.className = 'combo-info';
    const name = document.createElement('span');
    name.className = 'combo-name';
    name.textContent = f.label;
    const desc = document.createElement('span');
    desc.className = 'combo-desc';
    desc.textContent = f.desc;
    info.append(name, desc);

    row.append(keys, info);
    combosList.append(row);
  }
}
buildCombosList();

function openCombos() {
  combosModal.hidden = false;
}
function closeCombos() {
  combosModal.hidden = true;
}
combosBtn.addEventListener('click', openCombos);
combosClose.addEventListener('click', closeCombos);
// Click the dim backdrop (but not the card) to dismiss.
combosModal.addEventListener('click', (e) => {
  if (!combosCard.contains(e.target as Node)) closeCombos();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !combosModal.hidden) closeCombos();
});

// --- main loop ---
function loop(t: number) {
  // Paddle input (mouse and keyboard) only applies while the mouse is captured.
  if (isPlayer() && pointerLocked) {
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

  if (state) draw(ctx, state, myRole);
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
  if (document.activeElement !== gravityModeEl && gravityModeEl.checked !== state.gravity) {
    gravityModeEl.checked = state.gravity;
  }
  if (document.activeElement !== turboModeEl && turboModeEl.checked !== state.turbo) {
    turboModeEl.checked = state.turbo;
  }
  if (document.activeElement !== streamerModeEl && streamerModeEl.checked !== state.streamerMode) {
    streamerModeEl.checked = state.streamerMode;
  }

  // Keep the checkbox in sync with the shared setting (another player may have flipped it).
  fatalityCheck.checked = state.fatalitiesEnabled;

  // The combos reference is only meaningful when fatalities are armed; hide it (and the
  // modal) otherwise.
  combosBtn.hidden = !state.fatalitiesEnabled;
  if (!state.fatalitiesEnabled) combosModal.hidden = true;

  // Once the match is no longer over, re-arm the finishing move for next time.
  if (state.status !== 'over') fatalityDone = false;

  if (state.status === 'waiting') statusEl.textContent = 'Waiting for players…';
  else if (state.status === 'over') {
    if (state.fatality) statusEl.textContent = '☠  F A T A L I T Y  ☠';
    else if (canFinish()) statusEl.textContent = '🔪 FINISH HIM!  ·  tap a combo (see Combos ▸)';
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

  // King of the court: show who's reigning and their win streak (to everyone); the
  // king themselves also gets a click-to-exit prompt between matches.
  const isKing = !!state.king && state.king === myName;
  if (state.king) {
    const n = state.kingWins;
    const streak = `${n} win${n === 1 ? '' : 's'} in a row`;
    kingStatusEl.style.display = 'block';
    if (isKing && state.status !== 'playing') {
      kingStatusEl.textContent = `👑 You're the king — ${streak}! Click to exit`;
      kingStatusEl.style.cursor = 'pointer';
    } else {
      kingStatusEl.textContent = `👑 ${state.king} — ${streak}`;
      kingStatusEl.style.cursor = 'default';
    }
  } else {
    kingStatusEl.style.display = 'none';
  }

  // Queue display
  if (state.queue.length > 0) {
    queueArea.style.display = 'block';
    queueArea.textContent = `Queue: ${state.queue.join(', ')}`;
  } else {
    queueArea.style.display = 'none';
  }
  // Queue button for observers
  if (myRole === 'observer' && joined) {
    queueBtn.style.display = 'inline-block';
  } else {
    queueBtn.style.display = 'none';
  }
  // Reset inQueue if we left observer state (e.g. we claimed a spot)
  if (myRole !== 'observer') inQueue = false;

  // Ready button when the match is over and you hold a paddle
  if (state.status === 'over' && isPlayer()) {
    readyBtn.style.display = 'inline-block';
    readyBtn.textContent = state.ready[myRole as 'left' | 'right'] ? '✓ Ready' : 'Ready?';
  } else {
    readyBtn.style.display = 'none';
  }

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

// Draw each power-up legend icon once at startup.
for (const canvas of document.querySelectorAll<HTMLCanvasElement>('.pu-icon')) {
  drawLegendIcon(canvas, canvas.dataset.kind as PowerupKind);
}

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
