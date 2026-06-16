// Client entry point: nickname entry, render loop, paddle input (keyboard + mouse),
// and the Join button. Input is only sent when this client holds a paddle.

import { connect } from './net';
import { draw, drawLegendIcon } from './render';
import {
  COURT,
  PADDLE,
  BALL,
  ARENA,
  MAX_PLAYERS,
  REACTIONS,
  BALL_REACTION,
  BotLevel,
  ChatLine,
  LeaderboardRow,
  Role,
  Side,
  StateMsg,
  PowerupKind,
  POWERUPS,
  TEAM_MAX,
} from '../shared/types';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

const overlay = document.getElementById('overlay') as HTMLDivElement;
const joinForm = document.getElementById('joinForm') as HTMLFormElement;
const nick = document.getElementById('nick') as HTMLInputElement;
const joinBtn = document.getElementById('join') as HTMLButtonElement;
const joinLeftBtn = document.getElementById('joinLeft') as HTMLButtonElement;
const joinRightBtn = document.getElementById('joinRight') as HTMLButtonElement;
const queueBtn = document.getElementById('queueBtn') as HTMLButtonElement;
const queueArea = document.getElementById('queueArea') as HTMLDivElement;
const readyBtn = document.getElementById('readyBtn') as HTMLButtonElement;
const pingBtn = document.getElementById('pingBtn') as HTMLButtonElement;
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
const diamondModeEl = document.getElementById('diamondMode') as HTMLInputElement;
const pinataModeEl = document.getElementById('pinataMode') as HTMLInputElement;
const layeredModeEl = document.getElementById('layeredMode') as HTMLInputElement;
const arenaModeEl = document.getElementById('arenaMode') as HTMLInputElement;
const reactionsEl = document.getElementById('reactions') as HTMLDivElement;
const recentReactionsEl = document.getElementById('recentReactions') as HTMLDivElement;
const ballReactionEl = document.getElementById('ballReaction') as HTMLDivElement;
const reactionLayer = document.getElementById('reactionLayer') as HTMLDivElement;
const fatalityCheck = document.getElementById('fatalityCheck') as HTMLInputElement;
const combosBtn = document.getElementById('combosBtn') as HTMLButtonElement;
const muteBtn = document.getElementById('muteBtn') as HTMLButtonElement;
const puHudEl = document.getElementById('puHud') as HTMLDivElement;
const winScoreOpts = document.getElementById('winScoreOpts') as HTMLDivElement;
const game3dEl = document.getElementById('game3d') as HTMLDivElement;
const viewModeBtn = document.getElementById('viewModeBtn') as HTMLButtonElement;
const viewModePanel = document.getElementById('viewModePanel') as HTMLDivElement;
const fpPickerEl = document.getElementById('fpPicker') as HTMLDivElement;
const fpLeftBtn = document.getElementById('fpLeft') as HTMLButtonElement;
const fpRightBtn = document.getElementById('fpRight') as HTMLButtonElement;
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

// --- mute toggle ---
let muted = getCookie('tsong_muted') === '1';
function applyMute() {
  muteBtn.setAttribute('aria-pressed', String(muted));
  muteBtn.textContent = muted ? '🔇' : '🔊';
  finishSound.muted = muted;
  pacmanSound.muted = muted;
  jsavSound.muted = muted;
}
muteBtn.addEventListener('click', () => {
  muted = !muted;
  setCookie('tsong_muted', muted ? '1' : '0');
  applyMute();
});
// M key toggles mute from anywhere (except when typing in an input)
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key.toLowerCase() === 'm') {
    muted = !muted;
    setCookie('tsong_muted', muted ? '1' : '0');
    applyMute();
  }
});

// --- synthesized sound effects ---
function playHitSound() {
  if (muted) return;
  try {
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'square';
    osc.frequency.value = 300;
    gain.gain.setValueAtTime(0.06, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.035);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.04);
  } catch {}
}
function playScoreSound() {
  if (muted) return;
  try {
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, ac.currentTime);
    osc.frequency.exponentialRampToValueAtTime(260, ac.currentTime + 0.28);
    gain.gain.setValueAtTime(0.14, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.32);
  } catch {}
}

// Track previous state for detecting events client-side
let prevBallColor = '#e8eefc';
let prevScore = { left: 0, right: 0 };

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
let myId = ''; // per-connection id from the server; identifies our own paddle in state
let myName = '';
let myColor = '#e8eefc';
let state: StateMsg | null = null;
let ballColor = '#e8eefc'; // live pong-ball color, mirrored onto the ball reaction
let joined = false; // true once the player has entered a nickname (gates reactions)

// 3D / first-person view: driven by server state (state.viewMode). Three.js loads lazily.
let renderer3d: import('./render3d').Renderer3D | null = null;
let loading3d = false;
// Which side a spectator watches in first-person mode (doesn't affect players).
let fpSide: 'left' | 'right' = 'left';
// Fatalities are 2D-canvas cinematics; in 3D view we surface them on the 2D board for
// their duration (same footprint, so no layout jump), then drop back to 3D.
let fatality2dActive = false;

let target = COURT.h / 2; // desired paddle center Y, court units (duel)
let arenaTarget = 0; // desired paddle offset along my edge, court units (arena)
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
// Apply persisted mute state immediately (before applyMute() runs at definition time).
applyMute();
let prevStatus: StateMsg['status'] | null = null; // last seen status, to fire on the rising edge into 'over'
let prevFatality = false; // whether a fatality was playing last frame, to fire music on the rising edge

// Quiet notification beep for pings.
function playPingSound() {
  if (muted) return;
  try {
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.3);
  } catch {}
}

let pingTitleTimer: ReturnType<typeof setTimeout> | null = null;
let chatTitleTimer: ReturnType<typeof setTimeout> | null = null;
const ORIGINAL_TITLE = document.title;

function onPing(from: string) {
  playPingSound();
  document.title = `🔔 ${from} pinged — ${ORIGINAL_TITLE}`;
  if (pingTitleTimer) clearTimeout(pingTitleTimer);
  pingTitleTimer = setTimeout(() => { document.title = ORIGINAL_TITLE; }, 5000);
}

function notifyChatTitle(from: string) {
  document.title = `💬 ${from} — ${ORIGINAL_TITLE}`;
  if (chatTitleTimer) clearTimeout(chatTitleTimer);
  chatTitleTimer = setTimeout(() => { document.title = ORIGINAL_TITLE; }, 8000);
}

// Clear the chat notification the moment the user focuses the tab again.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && chatTitleTimer) {
    clearTimeout(chatTitleTimer);
    chatTitleTimer = null;
    document.title = ORIGINAL_TITLE;
  }
});
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
      myId = msg.id;
      lastSent = -1; // force a re-sync of our paddle target from the next state
      if (!isPlayer()) touchActive = false;
      // Hand the cursor back when we're no longer holding a paddle (e.g. match ended).
      if (!isPlayer() && isBoard(document.pointerLockElement)) {
        document.exitPointerLock();
      } else if (isPlayer() && pointerLocked) {
        // Our role changed while still mouse-captured (e.g. migrated from the duel box
        // onto the arena polygon). The server reset our capture flag, but no pointerlock
        // event fired — so re-assert it, or the match stays frozen waiting on us.
        net.send({ type: 'capture', on: true });
      }
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
      // Detect paddle hit (ball takes on new color) and score events for sound.
      if (msg.status === 'playing' && !msg.paused) {
        if (msg.ball.color !== '#e8eefc' && msg.ball.color !== prevBallColor) playHitSound();
        if (msg.score.left > prevScore.left || msg.score.right > prevScore.right) playScoreSound();
      }
      prevBallColor = msg.ball.color;
      prevScore = { ...msg.score };
      state = msg;
      syncMyPaddleFromServer();
      syncViewMode(msg.viewMode ?? 'normal');
      updateUI();
    } else if (msg.type === 'leaderboard') {
      renderLeaderboard(msg.rows);
    } else if (msg.type === 'chat') {
      msg.lines.forEach(addChatLine);
      // Notify via tab title for a single new message while the tab is backgrounded.
      // History replays (length > 1) are excluded to avoid spurious notifications on connect.
      if (msg.lines.length === 1 && document.hidden && msg.lines[0].from !== myName) {
        notifyChatTitle(msg.lines[0].from);
      }
    } else if (msg.type === 'reaction') {
      spawnReaction(msg.emoji);
    } else if (msg.type === 'announce') {
      showAnnouncement(msg.text);
    } else if (msg.type === 'ping') {
      onPing(msg.from);
    }
  },
  () => {
    // The server replays recent chat history on every (re)connect. Clear the log first so
    // a reconnect (which keeps the page, and thus the old lines) doesn't duplicate them.
    chatLog.replaceChildren();
    lastChatDate = '';
    if (myName) net.send({ type: 'join', nickname: myName, pid: myPid, color: myColor });
    // Re-assert capture state after a (re)connect so the server's view stays in sync.
    if (pointerLocked) net.send({ type: 'capture', on: true });
  },
);

const isPlayer = () => myRole === 'left' || myRole === 'right' || myRole === 'player';
const inArena = () => myRole === 'player';

// My paddle in the arena state (the polygon edge I own), or undefined.
function myPolyPlayer(s: StateMsg) {
  return s.poly?.players.find((p) => p.id === myId);
}

// Farthest my arena paddle may slide from its edge midpoint before overhanging a corner.
function arenaMaxPos(s: StateMsg, len: number): number {
  const n = s.poly?.n ?? 3;
  return Math.max(0, ARENA.radius * Math.sin(Math.PI / n) - len / 2);
}

// Keep our local target aligned with the server's paddle when we're not the one
// driving it (e.g. right after claiming a spot), so it doesn't snap on first input.
function syncMyPaddleFromServer() {
  if (!state || !isPlayer() || lastSent >= 0) return;
  if (state.poly) {
    const mine = myPolyPlayer(state);
    if (mine) {
      // Recover the paddle's offset along its edge from its reported center.
      const i = state.poly.players.indexOf(mine);
      const a = state.poly.verts[i];
      const b = state.poly.verts[(i + 1) % state.poly.n];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      arenaTarget = (mine.cx - mx) * Math.cos(mine.angle) + (mine.cy - my) * Math.sin(mine.angle);
    }
  } else if (myRole === 'left' || myRole === 'right') {
    const mine = state.paddles[myRole].players.find((p) => p.id === myId);
    if (mine) target = mine.y;
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

// --- ping: notify everyone you want players ---
pingBtn.addEventListener('click', () => net.send({ type: 'ping' }));

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
// Classic mode: one auto-assigned button. Layered-teams mode: pick your side
// (multiple players may share a side, staggered forward by join order).
joinBtn.addEventListener('click', () => net.send({ type: 'claim' }));
joinLeftBtn.addEventListener('click', () => net.send({ type: 'claim', side: 'left' }));
joinRightBtn.addEventListener('click', () => net.send({ type: 'claim', side: 'right' }));

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
diamondModeEl.addEventListener('change', () =>
  net.send({ type: 'mode', diamond: diamondModeEl.checked }),
);
pinataModeEl.addEventListener('change', () =>
  net.send({ type: 'mode', pinata: pinataModeEl.checked }),
);
layeredModeEl.addEventListener('change', () =>
  net.send({ type: 'mode', layered: layeredModeEl.checked }),
);
arenaModeEl.addEventListener('change', () =>
  net.send({ type: 'mode', arena: arenaModeEl.checked }),
);

// --- win score selector ---
for (const btn of winScoreOpts.querySelectorAll<HTMLButtonElement>('.ws-btn')) {
  btn.addEventListener('click', () => {
    const score = Number(btn.dataset.score);
    net.send({ type: 'setWinScore', score });
  });
}

// --- slash commands ---
// Typing "/" in chat pops up this menu of commands; each only appears when usable.
interface ChatCommand {
  name: string; // the word after the slash, e.g. "ff"
  hint: string; // short description shown in the menu
  enabled: () => boolean; // whether it's currently usable (greyed out when false)
  disabledHint: string; // why it's unusable right now (shown greyed in its place)
  run: (arg?: string) => boolean | void; // what it does when chosen; false = rejected (keep the typed text)
  argOptions?: () => string[]; // valid values for an optional argument (drives suggestions after a space)
  argHint?: (arg: string) => string; // menu hint for one suggested argument value
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
    hint: 'Spawn a power-up — add a name to pick one (e.g. /powerup smash)',
    enabled: () => !isPlayer() && state?.status === 'playing',
    disabledHint: 'spectators only, during a live match',
    argOptions: () => [...POWERUPS],
    argHint: (arg) => `Spawn the ${arg} power-up`,
    run: (arg) => {
      const kind = arg?.toLowerCase();
      // An unknown name is rejected so the typo stays visible instead of silently
      // spawning something random.
      if (kind && !(POWERUPS as readonly string[]).includes(kind)) return false;
      net.send({ type: 'spawnPowerup', kind });
    },
  },
];

// One row in the command menu: a command, optionally with a suggested argument value.
interface MenuItem {
  cmd: ChatCommand;
  arg?: string;
}

// Menu rows for what's typed after "/": command names while the name is being typed;
// once a space follows a known command, that command's argument values instead.
function matchingItems(): MenuItem[] {
  const v = chatInput.value;
  if (!v.startsWith('/')) return [];
  const m = v.slice(1).match(/^(\S*)(\s+(.*))?$/);
  if (!m) return [];
  const name = m[1].toLowerCase();
  if (m[2] !== undefined) {
    const cmd = COMMANDS.find((c) => c.name === name);
    const argPrefix = (m[3] ?? '').toLowerCase();
    return (cmd?.argOptions?.() ?? [])
      .filter((o) => o.startsWith(argPrefix))
      .map((arg) => ({ cmd: cmd!, arg }));
  }
  return COMMANDS.filter((c) => c.name.startsWith(name)).map((cmd) => ({ cmd }));
}

const commandMenu = document.createElement('div');
commandMenu.id = 'commandMenu';
commandMenu.hidden = true;
chatForm.append(commandMenu);

let menuItems: MenuItem[] = [];
let menuIndex = 0;

function renderCommandMenu() {
  commandMenu.replaceChildren();
  const hdr = document.createElement('div');
  hdr.className = 'cmd-hdr';
  hdr.textContent = menuItems[0]?.arg !== undefined ? `/${menuItems[0].cmd.name}` : 'Commands';
  commandMenu.append(hdr);
  menuItems.forEach((item, i) => {
    const ok = item.cmd.enabled();
    const row = document.createElement('div');
    row.className = 'cmd-row' + (i === menuIndex ? ' active' : '') + (ok ? '' : ' disabled');
    const name = document.createElement('span');
    name.className = 'cmd-name';
    name.textContent = item.arg !== undefined ? item.arg : `/${item.cmd.name}`;
    const hint = document.createElement('span');
    hint.className = 'cmd-hint';
    const base =
      item.arg !== undefined ? item.cmd.argHint?.(item.arg) ?? item.cmd.hint : item.cmd.hint;
    hint.textContent = ok ? base : `${base} — ${item.cmd.disabledHint}`;
    row.append(name, hint);
    // mousedown (not click) so the input doesn't blur out from under the selection.
    // Always preventDefault to keep focus; runCommand ignores disabled commands.
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      runCommand(item);
    });
    commandMenu.append(row);
    // Long lists scroll — keep the keyboard-highlighted row in view.
    if (i === menuIndex) row.scrollIntoView({ block: 'nearest' });
  });
}

function refreshCommandMenu() {
  menuItems = joined ? matchingItems() : [];
  if (!menuItems.length) {
    commandMenu.hidden = true;
    return;
  }
  if (menuIndex >= menuItems.length) menuIndex = 0;
  renderCommandMenu();
  commandMenu.hidden = false;
}

function closeCommandMenu() {
  commandMenu.hidden = true;
}

function runCommand(item: MenuItem) {
  if (!item.cmd.enabled()) return; // greyed out: leave the text so it's clear nothing happened
  if (item.cmd.run(item.arg) === false) return; // rejected (e.g. unknown power-up name)
  chatInput.value = '';
  closeCommandMenu();
}

// --- chat ---
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  // A recognized "/command [arg]" runs (and is swallowed); unknown slash text falls
  // through to chat. Enter with the menu open is handled in the keydown listener below.
  if (text.startsWith('/')) {
    const [name, ...rest] = text.slice(1).split(/\s+/);
    const cmd = COMMANDS.find((c) => c.name === name.toLowerCase());
    if (cmd) {
      runCommand({ cmd, arg: rest.join(' ') || undefined });
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
    menuIndex = (menuIndex + 1) % menuItems.length;
    renderCommandMenu();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    menuIndex = (menuIndex - 1 + menuItems.length) % menuItems.length;
    renderCommandMenu();
  } else if (e.key === 'Enter') {
    // Run the highlighted command instead of submitting the raw text.
    e.preventDefault();
    runCommand(menuItems[menuIndex]);
  } else if (e.key === 'Tab') {
    // Autocomplete without running: the highlighted argument value, or the command
    // name — with a trailing space when it takes one, so its suggestions open up.
    e.preventDefault();
    const item = menuItems[menuIndex];
    chatInput.value =
      item.arg !== undefined
        ? `/${item.cmd.name} ${item.arg}`
        : `/${item.cmd.name}${item.cmd.argOptions ? ' ' : ''}`;
    refreshCommandMenu();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeCommandMenu();
  }
});
// Press T (while not playing / not pointer-locked) to focus the chat input.
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (overlay.style.display !== 'none') return;
  if (e.key.toLowerCase() === 't' && !pointerLocked && joined) {
    e.preventDefault();
    chatInput.focus();
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
  diamondModeEl.disabled = false;
  pinataModeEl.disabled = false;
  layeredModeEl.disabled = false;
  arenaModeEl.disabled = false;
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
let lastChatDate = '';
const TZ = 'America/New_York';
function formatChatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
}
function formatChatDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions = { timeZone: TZ, month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}
function addChatLine(line: ChatLine) {
  const ts = line.time ?? Date.now();
  const timeStr = formatChatTime(ts);
  const dateStr = formatChatDate(ts);
  if (dateStr !== lastChatDate) {
    lastChatDate = dateStr;
    const sep = document.createElement('div');
    sep.className = 'chat-date-sep';
    sep.textContent = dateStr;
    chatLog.append(sep);
  }
  const row = document.createElement('div');
  row.className = 'chat-row';
  const stamp = document.createElement('span');
  stamp.className = 'chatstamp';
  stamp.textContent = timeStr;
  const who = document.createElement('span');
  who.className = line.player ? 'chatfrom tag' : 'chatfrom';
  who.textContent = line.player ? `${line.from} (playing)` : line.from;
  who.style.color = line.color;
  const body = document.createElement('span');
  body.className = line.command ? 'chattext chatcmd' : 'chattext';
  body.textContent = `: ${line.text}`;
  const content = document.createElement('span');
  content.className = 'chatbody';
  content.append(who, body);
  row.append(stamp, content);
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

// --- Add/kick bot dropdown (bottom-right) ---
// One button: a dropdown of difficulty levels when no bot is in play, or a one-click
// "kick bot" when one is. Visibility/label are driven from state in updateUI().
const botControl = document.getElementById('botControl') as HTMLDivElement;
const botBtn = document.getElementById('botBtn') as HTMLButtonElement;
const botPanel = document.getElementById('botPanel') as HTMLDivElement;

function openBotPanel() {
  botPanel.hidden = false;
  botBtn.setAttribute('aria-expanded', 'true');
}
function closeBotPanel() {
  botPanel.hidden = true;
  botBtn.setAttribute('aria-expanded', 'false');
}
botBtn.addEventListener('click', () => {
  // In "kick" mode the button is a direct action, not a dropdown trigger.
  if (botBtn.classList.contains('kick')) {
    net.send({ type: 'removeBot' });
    return;
  }
  botPanel.hidden ? openBotPanel() : closeBotPanel();
});
for (const opt of botPanel.querySelectorAll<HTMLButtonElement>('.bot-option')) {
  opt.addEventListener('click', () => {
    net.send({ type: 'addBot', level: opt.dataset.level as BotLevel });
    closeBotPanel();
  });
}
document.addEventListener('click', (e) => {
  if (botPanel.hidden) return;
  const t = e.target as Node;
  if (!botPanel.contains(t) && !botBtn.contains(t)) closeBotPanel();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !botPanel.hidden) closeBotPanel();
});

// Reflect the current bot state onto the button (label, mode, visibility). Cached so we
// only touch the DOM when the situation actually changes.
let lastBotState = '';
function syncBotControl(s: StateMsg) {
  const canBot = !s.poly && !s.arena; // duel only
  const sideOpen = !s.paddles.left.players.length || !s.paddles.right.players.length;
  const mode = !canBot ? 'hidden' : s.bot ? 'kick' : sideOpen ? 'add' : 'hidden';
  if (mode === lastBotState) return;
  lastBotState = mode;
  if (mode === 'hidden') {
    botControl.style.display = 'none';
    closeBotPanel();
    return;
  }
  botControl.style.display = 'block';
  if (mode === 'kick') {
    botBtn.classList.add('kick');
    botBtn.textContent = 'KICK BOT 🤖';
    closeBotPanel();
  } else {
    botBtn.classList.remove('kick');
    botBtn.innerHTML = 'ADD BOT <span class="caret">▾</span>';
  }
}

// --- CHANGELOG dropdown (top-right): recent commit messages on main ---
const changelogBtn = document.getElementById('changelogBtn') as HTMLButtonElement;
const changelogPanel = document.getElementById('changelogPanel') as HTMLDivElement;

interface Commit {
  hash: string;
  subject: string;
  date: string;
  url?: string; // GitHub link to the commit, when available
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
      if (c.url) {
        // Link the short hash to the commit on GitHub; open in a new tab.
        const link = document.createElement('a');
        link.className = 'changelog-hash';
        link.href = c.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = c.hash;
        meta.append(link, document.createTextNode(` · ${timeAgo(c.date)}`));
      } else {
        meta.textContent = `${c.hash} · ${timeAgo(c.date)}`;
      }
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

// --- loading splash: a hype screen on first paint — lightning bolts, an explosion of
// pong balls radiating from center, and rotating pro tips. Purely cosmetic; it dismisses
// after a short beat, or instantly when the user clicks / presses a key. ---
(() => {
  const screen = document.getElementById('loadingScreen');
  const ballsLayer = document.getElementById('loadBalls');
  const tipText = document.getElementById('loadTipText');
  if (!screen || !ballsLayer || !tipText) return;

  const BALL_COLORS = ['#e8eefc', '#7da2ff', '#9fb0d8', '#3a6df0', '#ffd23f'];
  const TIPS = [
    'Click the board to capture your mouse — your paddle stays put until you do.',
    'Press ↑/↓ or W/S to move, or just steer with your mouse.',
    'The ball takes on the color of whoever last hit it.',
    'Bounce the ball across a glowing target to grab its power-up.',
    'Spectators: type /powerup in chat to drop a random power-up mid-rally.',
    'Type /ff to forfeit the match… if you’re feeling cowardly.',
    'Win a match to become King of the Court — then defend your streak.',
    'Join the queue and you’ll auto-claim the next open paddle.',
    'Open MODES for chaos: Closing Walls, Gravity, Turbo, Diamond Hands, Piñata.',
    'Turn on Fatalities, then win a match to finish your opponent. ☠',
  ];
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // One explosion of balls bursting outward from the center of the screen.
  function burst(count: number) {
    const reach = Math.hypot(window.innerWidth, window.innerHeight) / 2 + 40;
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'load-ball';
      const size = 8 + Math.random() * 16;
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.margin = `${-size / 2}px 0 0 ${-size / 2}px`;
      el.style.background = BALL_COLORS[(Math.random() * BALL_COLORS.length) | 0];
      ballsLayer!.append(el);
      const ang = Math.random() * Math.PI * 2;
      const dist = reach * (0.5 + Math.random() * 0.6);
      const dx = Math.cos(ang) * dist;
      const dy = Math.sin(ang) * dist;
      const anim = el.animate(
        [
          { transform: 'translate(0, 0) scale(0.3)', opacity: 1 },
          { transform: `translate(${dx}px, ${dy}px) scale(1)`, opacity: 0 },
        ],
        { duration: 800 + Math.random() * 700, easing: 'cubic-bezier(0.15, 0.6, 0.3, 1)' },
      );
      anim.onfinish = () => el.remove();
      anim.oncancel = () => el.remove();
    }
  }

  let tipIdx = (Math.random() * TIPS.length) | 0;
  const showTip = () => {
    tipText!.textContent = TIPS[tipIdx % TIPS.length];
    tipIdx++;
  };
  showTip();

  let burstTimer = 0;
  let tipTimer = 0;
  if (!reduce) {
    burst(30);
    burstTimer = window.setInterval(() => burst(18), 650);
    tipTimer = window.setInterval(showTip, 1500);
  }

  let done = false;
  function dismiss() {
    if (done) return;
    done = true;
    clearInterval(burstTimer);
    clearInterval(tipTimer);
    screen!.classList.add('hiding');
    setTimeout(() => screen!.remove(), 500);
    window.removeEventListener('pointerdown', dismiss);
    window.removeEventListener('keydown', dismiss);
  }
  window.setTimeout(dismiss, reduce ? 1200 : 2400);
  window.addEventListener('pointerdown', dismiss);
  window.addEventListener('keydown', dismiss);
})();

// --- mouse control ---
// While holding a paddle, lock the pointer to the board so a quick flick can't send the
// cursor out of the play area (which would freeze the paddle or land clicks on the chat
// and buttons). Locked → track relative movement; unlocked → fall back to absolute
// position over the canvas, and click the board to (re)capture the mouse.
let pointerLocked = false;
const clampPaddle = (y: number) => Math.max(PADDLE.h / 2, Math.min(COURT.h - PADDLE.h / 2, y));

// The "board" you capture the mouse to is the canvas in 2D and the 3D container in 3D
// (the canvas is display:none in 3D, so it can neither be clicked nor receive mousemove).
const boardEl = () => (state?.viewMode !== 'normal' ? game3dEl : canvas);
const isBoard = (el: Element | null) => el === canvas || el === game3dEl;

function onBoardClick() {
  if (isPlayer() && !pointerLocked) boardEl().requestPointerLock();
}

function onBoardMouseMove(e: MouseEvent) {
  // The paddle only moves while the mouse is captured to the board.
  if (!isPlayer() || !pointerLocked) return;
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  // Arena: the paddle rides along its edge, so project mouse motion onto that edge.
  if (inArena() && state?.poly) {
    const me = myPolyPlayer(state);
    if (!me) return;
    const dx = e.movementX * (COURT.w / r.width);
    const dy = e.movementY * (COURT.h / r.height);
    const along = dx * Math.cos(me.angle) + dy * Math.sin(me.angle);
    const max = arenaMaxPos(state, me.len);
    arenaTarget = Math.max(-max, Math.min(max, arenaTarget + along));
    return;
  }
  // Convert screen-pixel movement to court units. In first-person the paddle appears
  // left/right on screen, so movementX drives it; direction flips for the right side.
  // When the court is rotated 90°, paddle slides horizontally too (movementX, same deal).
  if (state?.rotated) {
    target = clampPaddle(target - e.movementX * (COURT.h / r.width));
  } else if (state?.viewMode === 'firstperson') {
    const sign = myRole === 'right' ? -1 : 1;
    target = clampPaddle(target + sign * e.movementX * (COURT.h / r.width) * 1.5);
  } else {
    target = clampPaddle(target + e.movementY * (COURT.h / r.height));
  }
}

canvas.addEventListener('click', onBoardClick);
canvas.addEventListener('mousemove', onBoardMouseMove);
game3dEl.addEventListener('click', onBoardClick);
game3dEl.addEventListener('mousemove', onBoardMouseMove);

document.addEventListener('pointerlockchange', () => {
  pointerLocked = isBoard(document.pointerLockElement);
  // Tell the server: the match stays paused until both players have captured.
  net.send({ type: 'capture', on: pointerLocked });
  updateUI();
});

// --- keyboard control ---
// Left/right (and A/D) are captured too: when the court is rotated 90° the paddle moves
// horizontally, so those become the natural movement keys (see the loop below).
const MOVE_KEYS = new Set(['arrowup', 'arrowdown', 'w', 's', 'arrowleft', 'arrowright', 'a', 'd']);
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
    !state.poly && // arena is a free-for-all — no finishing moves
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

// Swap the canvas between landscape and portrait when the "rotate" power-up flips the
// court. The internal resolution swaps to COURT.h × COURT.w (the render transform maps
// court coords into it) and a CSS class switches the on-screen aspect ratio. Only touches
// the DOM when the value actually changes.
let canvasRotated = false;
function applyCanvasRotation(rotated: boolean) {
  if (rotated === canvasRotated) return;
  canvasRotated = rotated;
  if (rotated) {
    canvas.width = COURT.h;
    canvas.height = COURT.w;
    canvas.classList.add('rotated');
  } else {
    canvas.width = COURT.w;
    canvas.height = COURT.h;
    canvas.classList.remove('rotated');
  }
}

// --- main loop ---
// --- mobile tab bar ---
const mobileTabs = document.getElementById('mobileTabs') as HTMLDivElement;
function isMobileView(): boolean {
  return window.getComputedStyle(mobileTabs).display !== 'none';
}
function resetMobileLayout() {
  const stage = document.getElementById('stage') as HTMLDivElement;
  const chat = document.getElementById('chat') as HTMLDivElement;
  const lb = document.getElementById('leaderboard') as HTMLDivElement;
  stage.style.display = '';
  chat.style.display = '';
  lb.style.display = '';
}
for (const btn of mobileTabs.querySelectorAll<HTMLButtonElement>('.mob-tab')) {
  btn.addEventListener('click', () => {
    if (!isMobileView()) return;
    mobileTabs.querySelector('.active')?.classList.remove('active');
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    const stage = document.getElementById('stage') as HTMLDivElement;
    const chat = document.getElementById('chat') as HTMLDivElement;
    const lb = document.getElementById('leaderboard') as HTMLDivElement;
    if (tab === 'play') {
      stage.style.display = '';
      chat.style.display = 'none';
      lb.style.display = '';
    } else if (tab === 'chat') {
      stage.style.display = 'none';
      chat.style.display = '';
      lb.style.display = 'none';
    } else if (tab === 'leaderboard') {
      stage.style.display = 'none';
      chat.style.display = 'none';
      lb.style.display = '';
    }
  });
}
window.addEventListener('resize', () => {
  if (!isMobileView()) resetMobileLayout();
});
// Initial mobile layout: show Play tab, hide others
if (isMobileView()) {
  const stage = document.getElementById('stage') as HTMLDivElement;
  const chatEl = document.getElementById('chat') as HTMLDivElement;
  const lb = document.getElementById('leaderboard') as HTMLDivElement;
  stage.style.display = '';
  chatEl.style.display = 'none';
  lb.style.display = '';
}

// --- touch controls for paddle ---
let touchActive = false;
function onTouchStart() {
  touchActive = true;
  // On mobile, touch acts as capture (no pointer lock available)
  if (isPlayer() && !pointerLocked) net.send({ type: 'capture', on: true });
}
function onTouchEnd() {
  touchActive = false;
}
function onTouchMove(e: TouchEvent) {
  if (!isPlayer()) return;
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  const touch = e.touches[0];
  if (!touch) return;
  if (inArena() && state?.poly) {
    const me = myPolyPlayer(state);
    if (!me) return;
    const cx = touch.clientX - r.left;
    const cy = touch.clientY - r.top;
    const dx = (cx / r.width) * COURT.w - me.cx;
    const dy = (cy / r.height) * COURT.h - me.cy;
    const along = dx * Math.cos(me.angle) + dy * Math.sin(me.angle);
    const max = arenaMaxPos(state, me.len);
    arenaTarget = Math.max(-max, Math.min(max, along));
    return;
  }
  if (state?.viewMode === 'firstperson') {
    const relX = (touch.clientX - r.left) / r.width;
    target = clampPaddle((myRole === 'right' ? 1 - relX : relX) * COURT.h);
  } else {
    const relY = (touch.clientY - r.top) / r.height;
    target = clampPaddle(relY * COURT.h);
  }
}
canvas.addEventListener('touchstart', onTouchStart, { passive: true });
canvas.addEventListener('touchmove', onTouchMove, { passive: true });
canvas.addEventListener('touchend', onTouchEnd);
canvas.addEventListener('touchcancel', onTouchEnd);
game3dEl.addEventListener('touchstart', onTouchStart, { passive: true });
game3dEl.addEventListener('touchmove', onTouchMove, { passive: true });
game3dEl.addEventListener('touchend', onTouchEnd);
game3dEl.addEventListener('touchcancel', onTouchEnd);

// --- View mode dropdown (lazy-loads Three.js on first use) ---
// Open/close the panel.
viewModeBtn.addEventListener('click', () => {
  const open = viewModePanel.hidden;
  viewModePanel.hidden = !open;
  viewModeBtn.setAttribute('aria-expanded', String(open));
});
// Close when clicking outside.
document.addEventListener('click', (e) => {
  if (!viewModePanel.hidden && !viewModeBtn.closest('#viewMode')?.contains(e.target as Node)) {
    viewModePanel.hidden = true;
    viewModeBtn.setAttribute('aria-expanded', 'false');
  }
});
// Radio buttons send mode to server.
viewModePanel.querySelectorAll<HTMLInputElement>('input[name="viewMode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    if (radio.checked) {
      net.send({ type: 'mode', viewMode: radio.value });
      // Keep panel open only when first-person is selected (fpPicker needs to be accessible).
      if (radio.value !== 'firstperson') {
        viewModePanel.hidden = true;
        viewModeBtn.setAttribute('aria-expanded', 'false');
      }
    }
  });
});
// Left/right picker for spectators in first-person mode.
fpLeftBtn.addEventListener('click', () => {
  fpSide = 'left';
  fpLeftBtn.classList.add('active');
  fpRightBtn.classList.remove('active');
});
fpRightBtn.addEventListener('click', () => {
  fpSide = 'right';
  fpRightBtn.classList.add('active');
  fpLeftBtn.classList.remove('active');
});

// Lazily load Three.js and ensure the renderer exists whenever a 3D mode is active.
async function ensureRenderer3d() {
  if (renderer3d || loading3d) return;
  loading3d = true;
  try {
    const mod = await import('./render3d');
    renderer3d = mod.createRenderer(game3dEl);
    renderer3d.resize();
  } catch (e) {
    console.error('3D view failed to load:', e);
  } finally {
    loading3d = false;
  }
}

function syncViewMode(viewMode: 'normal' | '3d' | 'firstperson') {
  const is3d = viewMode !== 'normal';
  document.body.classList.toggle('view-3d', is3d);
  game3dEl.hidden = !is3d;
  canvas.hidden = is3d;
  // Sync the radio buttons to reflect server state.
  viewModePanel.querySelectorAll<HTMLInputElement>('input[name="viewMode"]').forEach((r) => {
    r.checked = r.value === viewMode;
  });
  // fpPicker is inside the panel; show it only for spectators in first-person.
  fpPickerEl.hidden = !(viewMode === 'firstperson' && myRole === 'observer');
  if (is3d) void ensureRenderer3d().then(() => renderer3d?.resize());
}
window.addEventListener('resize', () => {
  if (state?.viewMode !== 'normal') renderer3d?.resize();
});

function canControl(): boolean {
  return pointerLocked || touchActive;
}

function loop(t: number) {
  // Arena: keyboard nudges the paddle along its edge (mouse handled in mousemove).
  if (inArena() && canControl() && state?.poly) {
    const me = myPolyPlayer(state);
    if (me) {
      const step = PADDLE.speed / 60;
      // Screen-space intent from the arrow/WASD keys, projected onto the edge direction
      // so the key that points along the edge slides the paddle that way.
      let vx = 0;
      let vy = 0;
      if (keys.has('arrowleft') || keys.has('a')) vx -= 1;
      if (keys.has('arrowright') || keys.has('d')) vx += 1;
      if (keys.has('arrowup') || keys.has('w')) vy -= 1;
      if (keys.has('arrowdown') || keys.has('s')) vy += 1;
      const along = vx * Math.cos(me.angle) + vy * Math.sin(me.angle);
      if (along !== 0) {
        const max = arenaMaxPos(state, me.len);
        arenaTarget = Math.max(-max, Math.min(max, arenaTarget + along * step));
      }
    }
    if (Math.abs(arenaTarget - lastSent) > 0.5 && t - lastSendAt > 33) {
      net.send({ type: 'paddle', y: arenaTarget });
      lastSent = arenaTarget;
      lastSendAt = t;
    }
  } else if (isPlayer() && canControl()) {
    // Paddle input (mouse and keyboard) only applies while the mouse is captured.
    const step = PADDLE.speed / 60;
    if (state?.rotated) {
      // Court rotated 90°: paddle slides horizontally; right on screen = decreasing court-Y.
      if (keys.has('arrowright') || keys.has('d')) target -= step;
      if (keys.has('arrowleft') || keys.has('a')) target += step;
    } else if (state?.viewMode === 'firstperson') {
      // First-person: paddle appears left/right on screen, so left/right arrows drive it.
      // Direction flips for the right-side player (their right is court-Y decreasing).
      const sign = myRole === 'right' ? -1 : 1;
      if (keys.has('arrowright') || keys.has('d')) target += sign * step;
      if (keys.has('arrowleft') || keys.has('a')) target -= sign * step;
    } else {
      if (keys.has('arrowup') || keys.has('w')) target -= step;
      if (keys.has('arrowdown') || keys.has('s')) target += step;
    }
    target = Math.max(PADDLE.h / 2, Math.min(COURT.h - PADDLE.h / 2, target));

    // Send when it changed meaningfully, throttled to ~30/s.
    if (Math.abs(target - lastSent) > 0.5 && t - lastSendAt > 33) {
      net.send({ type: 'paddle', y: target });
      lastSent = target;
      lastSendAt = t;
    }
  }

  if (state) {
    // In 3D view, a fatality temporarily takes over the 2D board (the cinematics are 2D
    // canvas effects that composite over the full court frame). Swap surfaces on the edge.
    const showFatality2d = state.viewMode !== 'normal' && !!state.fatality;
    if (showFatality2d !== fatality2dActive) {
      fatality2dActive = showFatality2d;
      document.body.classList.toggle('fatality-2d', showFatality2d);
      if (!showFatality2d && state.viewMode !== 'normal') renderer3d?.resize();
    }
    if (state.viewMode !== 'normal' && renderer3d && !state.fatality) {
      const side = state.viewMode === 'firstperson'
        ? (myRole !== 'observer' ? (myRole as 'left' | 'right') : fpSide)
        : null;
      renderer3d.render(state, side);
    } else {
      applyCanvasRotation(state.rotated);
      draw(ctx, state, myRole);
    }
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// --- HUD ---
function updateUI() {
  if (!state) return;

  renderPuHud(state);

  // Sync win score buttons with the current room setting.
  for (const btn of winScoreOpts.querySelectorAll<HTMLButtonElement>('.ws-btn')) {
    btn.classList.toggle('active', Number(btn.dataset.score) === state.winScore);
  }

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
  if (document.activeElement !== diamondModeEl && diamondModeEl.checked !== state.diamond) {
    diamondModeEl.checked = state.diamond;
  }
  if (document.activeElement !== pinataModeEl && pinataModeEl.checked !== state.pinata) {
    pinataModeEl.checked = state.pinata;
  }
  if (document.activeElement !== layeredModeEl && layeredModeEl.checked !== state.layered) {
    layeredModeEl.checked = state.layered;
  }
  if (document.activeElement !== arenaModeEl && arenaModeEl.checked !== state.arena) {
    arenaModeEl.checked = state.arena;
  }

  // Add/kick-bot button: show the right control for the current match state.
  syncBotControl(state);

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
    // Match is frozen until both players capture their mouse. Once an opponent is ready,
    // a laggard is on the clock (captureCountdown) before being benched.
    const cd = state.captureCountdown;
    if (isPlayer() && !pointerLocked)
      statusEl.textContent =
        cd != null
          ? `🖱 click the board NOW — ${cd}s to capture your mouse or you're benched!`
          : '🖱 click the board to capture your mouse to start';
    else if (isPlayer())
      statusEl.textContent =
        cd != null
          ? `⏳ waiting on the other player — ${cd}s before they're benched`
          : '⏸ waiting for the other players to capture their mouse…';
    else
      statusEl.textContent =
        cd != null
          ? `⏳ waiting for players to capture — ${cd}s`
          : '⏸ paused — waiting for players to capture their mice';
  } else if (isPlayer() && !pointerLocked) {
    statusEl.textContent = '🖱 click the board to capture · ↑/↓ or W/S to move · Esc to release';
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

  // Ready button when the match is over and you hold a paddle (classic only — the arena
  // restarts on its own timer).
  if (state.status === 'over' && isPlayer() && !state.poly) {
    readyBtn.style.display = 'inline-block';
    readyBtn.textContent = state.ready[myRole as 'left' | 'right'] ? '✓ Ready' : 'Ready?';
  } else {
    readyBtn.style.display = 'none';
  }

  // Side-pick buttons belong to layered-teams mode (each shows its head count and
  // hides when full); classic mode gets the single auto-assign button instead. Arena
  // mode always uses the single button (the server picks your edge).
  for (const [btn, side] of [
    [joinLeftBtn, 'left'],
    [joinRightBtn, 'right'],
  ] as [HTMLButtonElement, Side][]) {
    const n = state.paddles[side].players.length;
    btn.style.display =
      myRole === 'observer' && state.layered && !state.arena && n < TEAM_MAX ? 'inline-block' : 'none';
    btn.textContent = `Join ${side} (${n}/${TEAM_MAX})`;
  }
  const spotOpen = !state.paddles.left.players.length || !state.paddles.right.players.length;
  const canJoin = state.arena
    ? (state.poly ? state.poly.n < MAX_PLAYERS : true) // arena: room for up to 8 edges
    : !state.layered && spotOpen;
  joinBtn.style.display = myRole === 'observer' && canJoin ? 'inline-block' : 'none';
  joinBtn.textContent = state.arena ? 'Join arena' : 'Join game';
  renameBtn.style.display = myName ? 'inline-block' : 'none';
  pingBtn.style.display = myName ? 'inline-block' : 'none';

  // Hidden once the pointer is captured (lock hides it natively anyway); visible while
  // unlocked so a player can see where to click to capture, and for observers.
  canvas.style.cursor = isPlayer() && pointerLocked ? 'none' : 'default';
  game3dEl.style.cursor = isPlayer() && pointerLocked ? 'none' : isPlayer() ? 'pointer' : 'default';
  watchersEl.textContent = state.watchers.length
    ? `Watching: ${state.watchers.join(', ')}`
    : '';
}

// --- active power-up HUD ---
// Colors mirror the in-game target ring palette (TARGET_STYLE in render.ts).
const PU_CHIP_COLOR: Record<string, string> = {
  slow: '#7aa2ff', ghost: '#c8beff', tiny: '#ff8c42', bigball: '#fb923c',
  freeze: '#88d8f7', blind: '#9988bb', mirror: '#ff7eb3',
  grow: '#ffd166', shrink: '#5ad1e6', smash: '#ff6b3d',
};

function renderPuHud(s: StateMsg) {
  const chips: string[] = [];
  const t1 = (n: number) => `${n.toFixed(1)}s`;

  if (s.slowTimer > 0)    chips.push(puChip('slow',    `slow ${t1(s.slowTimer)}`));
  if (s.ghostTimer > 0)   chips.push(puChip('ghost',   `ghost ${t1(s.ghostTimer)}`));
  if (s.tinyTimer > 0)    chips.push(puChip('tiny',    `tiny ${t1(s.tinyTimer)}`));
  if (s.bigBallTimer > 0) chips.push(puChip('bigball', `bigball ${t1(s.bigBallTimer)}`));

  for (const side of ['left', 'right'] as const) {
    const p = s.paddles[side];
    const tag = p.name ? p.name.split(' & ')[0].slice(0, 10) : side;
    if (p.growHits > 0)    chips.push(puChip('grow',   `${tag} grow ×${p.growHits}`));
    if (p.shrinkHits > 0)  chips.push(puChip('shrink', `${tag} shrink ×${p.shrinkHits}`));
    if (p.smashHits > 0)   chips.push(puChip('smash',  `${tag} smash ×${p.smashHits}`));
    if (p.freezeTimer > 0) chips.push(puChip('freeze', `${tag} frozen ${t1(p.freezeTimer)}`));
    if (p.blindTimer > 0)  chips.push(puChip('blind',  `${tag} blind ${t1(p.blindTimer)}`));
    if (p.mirrorTimer > 0) chips.push(puChip('mirror', `${tag} mirror ${t1(p.mirrorTimer)}`));
  }

  puHudEl.innerHTML = chips.join('');
}

function puChip(kind: string, label: string): string {
  const color = PU_CHIP_COLOR[kind] ?? '#9fb0d8';
  return `<span class="pu-chip" style="color:${color};border-color:${color}">${escapeHtml(label)}</span>`;
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
      return `<li><span class="rank">${i + 1}</span><span class="lbname">${escapeHtml(
        r.name,
      )}</span><span class="pct">${r.elo ?? 1000}</span></li>`;
    })
    .join('');
  leaderboardEl.innerHTML = `<h2>Leaderboard</h2><ol>${items}</ol>`;
}

// ----------------------------------------------------------------------------
const _kSeq = [
  'arrowup', 'arrowup', 'arrowdown', 'arrowdown',
  'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a',
];
let _kIdx = 0;
let _partyAnim: Animation | null = null;
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  _kIdx = k === _kSeq[_kIdx] ? _kIdx + 1 : k === _kSeq[0] ? 1 : 0;
  if (_kIdx < _kSeq.length) return;
  _kIdx = 0;
  if (_partyAnim) {
    _partyAnim.cancel();
    _partyAnim = null;
    canvas.style.filter = '';
    return;
  }
  _partyAnim = canvas.animate(
    [{ filter: 'hue-rotate(0deg) saturate(1.6)' }, { filter: 'hue-rotate(360deg) saturate(1.6)' }],
    { duration: 2200, iterations: Infinity },
  );
  for (let i = 0; i < 40; i++) setTimeout(() => spawnReaction(BALL_REACTION), i * 35);
});
