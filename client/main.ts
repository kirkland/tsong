// Client entry point: nickname entry, render loop, paddle input (keyboard + mouse),
// and the Join button. Input is only sent when this client holds a paddle.

import { connect } from './net';
import { initRoulette } from './roulette';
import { initBlackjack } from './blackjack';
import { initCraps } from './craps';
import { initCrash } from './crash';
import { initSlots } from './slots';
import { initPlinko } from './plinko';
import { initHorse } from './horse';
import { initHilo } from './hilo';
import { initMines } from './mines';
import { initAds, revealAds } from './ads';
import { initFlyover, startFlyovers, flySummoned } from './flyover';
import { draw, drawLegendIcon, setBlasterAim, drawCosmeticPreview } from './render';
import {
  COURT,
  PADDLE,
  BALL,
  BLASTER,
  ROAM,
  ARENA,
  MAX_PLAYERS,
  REACTIONS,
  BALL_REACTION,
  BotLevel,
  ChatLine,
  LeaderboardRow,
  NetWorthRow,
  BalanceSheetMsg,
  EloProfileMsg,
  Role,
  Side,
  StateMsg,
  PowerupKind,
  POWERUPS,
  TEAM_MAX,
  COSMETICS,
  carById,
  petById,
  SPIN_SEGMENTS,
  STOCKS,
  StockSide,
  StockTf,
  positionWorth,
  FAST_SELL_BRACKETS,
  TickHealth,
  EXCLUSIVES,
  ExclusiveItem,
  LootResultMsg,
  MarketItemView,
  LoanBookMsg,
  NetizenInfoMsg,
  NewsItem,
  HouseStateMsg,
  LOOT_TABLE,
  minBet,
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
const rematchBtn = document.getElementById('rematchBtn') as HTMLButtonElement;
const quitBtn = document.getElementById('quitBtn') as HTMLButtonElement;
const pingBtn = document.getElementById('pingBtn') as HTMLButtonElement;
const renameBtn = document.getElementById('rename') as HTMLButtonElement;
const kingStatusEl = document.getElementById('kingStatus') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const watchersEl = document.getElementById('watchers') as HTMLDivElement;
const leaderboardEl = document.getElementById('leaderboard') as HTMLDivElement;
const netWorthEl = document.getElementById('netWorth') as HTMLDivElement;
const colorPicker = document.getElementById('colorPicker') as HTMLDivElement;
const chatLog = document.getElementById('chatlog') as HTMLDivElement;
const chatEl = document.getElementById('chat') as HTMLDivElement;
const chatForm = document.getElementById('chatForm') as HTMLFormElement;
const chatInput = document.getElementById('chatInput') as HTMLInputElement;
const hideCmdsEl = document.getElementById('hideCmds') as HTMLInputElement;
const hideTimestampsEl = document.getElementById('hideTimestamps') as HTMLInputElement;
const hideNetizenChatEl = document.getElementById('hideNetizenChat') as HTMLInputElement;
const closingModeEl = document.getElementById('closingMode') as HTMLInputElement;
const gravityModeEl = document.getElementById('gravityMode') as HTMLInputElement;
const turboModeEl = document.getElementById('turboMode') as HTMLInputElement;
const streamerModeEl = document.getElementById('streamerMode') as HTMLInputElement;
const diamondModeEl = document.getElementById('diamondMode') as HTMLInputElement;
const pinataModeEl = document.getElementById('pinataMode') as HTMLInputElement;
const layeredModeEl = document.getElementById('layeredMode') as HTMLInputElement;
const arenaModeEl = document.getElementById('arenaMode') as HTMLInputElement;
const breakoutModeEl = document.getElementById('breakoutMode') as HTMLInputElement;
const fogModeEl = document.getElementById('fogMode') as HTMLInputElement;
const portalModeEl = document.getElementById('portalMode') as HTMLInputElement;
const bumpersModeEl = document.getElementById('bumpersMode') as HTMLInputElement;
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
const balanceModal = document.getElementById('balanceModal') as HTMLDivElement;
const balanceCard = document.getElementById('balanceCard') as HTMLDivElement;
const balanceClose = document.getElementById('balanceClose') as HTMLButtonElement;
const balanceName = document.getElementById('balanceName') as HTMLSpanElement;
const balanceBody = document.getElementById('balanceBody') as HTMLDivElement;
const eloModal = document.getElementById('eloModal') as HTMLDivElement;
const eloCard = document.getElementById('eloCard') as HTMLDivElement;
const eloClose = document.getElementById('eloClose') as HTMLButtonElement;
const eloNameEl = document.getElementById('eloName') as HTMLSpanElement;
const eloBody = document.getElementById('eloBody') as HTMLDivElement;
const tipModal = document.getElementById('tipModal') as HTMLDivElement;
const tipCard = document.getElementById('tipCard') as HTMLDivElement;
const tipClose = document.getElementById('tipClose') as HTMLButtonElement;
const tipTitle = document.getElementById('tipTitle') as HTMLSpanElement;
const tipBalance = document.getElementById('tipBalance') as HTMLDivElement;
const tipPresets = document.getElementById('tipPresets') as HTMLDivElement;
const tipAmount = document.getElementById('tipAmount') as HTMLInputElement;
const tipStatus = document.getElementById('tipStatus') as HTMLDivElement;
const tipSend = document.getElementById('tipSend') as HTMLButtonElement;
const mobileControlsEl = document.getElementById('mobileControls') as HTMLDivElement;

// --- Netizen Challenge dialog ---
const ncModal = document.getElementById('netizenChallengeModal') as HTMLDivElement;
const ncName = document.getElementById('netizenChallengeName') as HTMLSpanElement;
const ncNetWorth = document.getElementById('netizenChallengeNetWorth') as HTMLSpanElement;
const ncWarn = document.getElementById('netizenChallengeWarn') as HTMLDivElement;
const ncRow = document.getElementById('netizenChallengeRow') as HTMLDivElement;
const ncWager = document.getElementById('ncWager') as HTMLInputElement;
const ncMaxWin = document.getElementById('ncMaxWin') as HTMLDivElement;
const ncChallengeBtn = document.getElementById('netizenChallengeBtn') as HTMLButtonElement;
const ncClose = document.getElementById('netizenChallengeClose') as HTMLButtonElement;
const ncMinus = document.getElementById('ncWagerMinus') as HTMLButtonElement;
const ncPlus = document.getElementById('ncWagerPlus') as HTMLButtonElement;
const mobUpBtn = document.getElementById('mobUp') as HTMLButtonElement;
const mobDownBtn = document.getElementById('mobDown') as HTMLButtonElement;

// Cookies (not localStorage, per request); ~1 year, scoped to the site.
const YEAR = 60 * 60 * 24 * 365;
function setCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=${YEAR};samesite=lax`;
}
function getCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

// --- user settings: cookie-backed (works for anonymous users + fast local reads) and, for
// signed-in players, synced to their account via the server so they follow them across devices.
// On join the server sends the stored set, which seeds `prefs` and wins over the local cookie. ---
const prefs: Record<string, string> = {};
function prefGet(key: string, fallback: string): string {
  return prefs[key] ?? getCookie('tsong_' + key) ?? fallback;
}
function prefSet(key: string, value: string) {
  prefs[key] = value;
  setCookie('tsong_' + key, value);
  net.send({ type: 'prefs', prefs: { [key]: value } }); // no-op until the socket is open
}
// Checkbox-backed prefs register an applier here so a server sync can re-check + re-apply them.
const checkboxAppliers = new Map<string, (checked: boolean) => void>();
function bindCheckboxPref(el: HTMLInputElement, key: string, apply: (checked: boolean) => void) {
  const set = (checked: boolean) => { el.checked = checked; apply(checked); };
  set(prefGet(key, '0') === '1'); // initial value from cookie / default
  el.addEventListener('change', () => { apply(el.checked); prefSet(key, el.checked ? '1' : '0'); });
  checkboxAppliers.set(key, set);
}
// Apply the full synced set to the UI (called when the server pushes the stored prefs on join).
function applyPrefs() {
  const m = prefGet('muted', '0') === '1';
  if (m !== muted) { muted = m; applyMute(); }
  for (const [key, set] of checkboxAppliers) set(prefGet(key, '0') === '1');
  setBossKeyTarget(prefGet('bosskey', 'spreadsheet') === 'terminal' ? 'terminal' : 'spreadsheet', false);
}

// --- mute toggle ---
let muted = prefGet('muted', '0') === '1';
function applyMute() {
  muteBtn.setAttribute('aria-pressed', String(muted));
  muteBtn.textContent = muted ? '🔇' : '🔊';
  finishSound.muted = muted;
  pacmanSound.muted = muted;
  jsavSound.muted = muted;
  averySound.muted = muted;
  discoSound.muted = muted;
  blasterSound.muted = muted;
  minionSound.muted = muted;
  chaChing.muted = muted;
  yaySound.muted = muted;
  themeSound.muted = muted;
  previewSound.muted = muted;
}
muteBtn.addEventListener('click', () => {
  muted = !muted;
  prefSet('muted', muted ? '1' : '0');
  applyMute();
});
// M key toggles mute from anywhere (except when typing in an input)
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key.toLowerCase() === 'm') {
    muted = !muted;
    prefSet('muted', muted ? '1' : '0');
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
// `let` so a Google login can upgrade it to the stable g:xxx pid at runtime.
let myPid = getCookie('tsong_pid') ?? (() => {
  const id = makeId();
  setCookie('tsong_pid', id);
  return id;
})();

// --- Google auth chip ---
const authChip    = document.getElementById('authChip')    as HTMLDivElement;
const signInLink  = document.getElementById('signInLink')  as HTMLAnchorElement;

interface AuthMe { pid?: string; name?: string; email?: string; oauthEnabled?: boolean; }
fetch('/auth/me')
  .then((r) => r.json() as Promise<AuthMe>)
  .then((data) => {
    if (data.pid) {
      const oldPid = myPid; // UUID that was active before we knew the Google pid
      myPid = data.pid;
      if (!getCookie('tsong_nick') && !nick.value) nick.value = data.name ?? '';
      authChip.hidden = false;
      authChip.replaceChildren();
      const label = document.createTextNode(`Signed in as ${data.name ?? data.email ?? ''} · `);
      const out = document.createElement('a');
      out.href = '/auth/logout';
      out.textContent = 'Sign out';
      authChip.append(label, out);
      // If the player has an existing UUID account, migrate it into the Google account.
      // Send after join so the server's conn.pid is already set when the wallet refresh arrives.
      if (oldPid && oldPid !== myPid && !oldPid.startsWith('g:')) {
        const doMigrate = () => net.send({ type: 'migrate', oldPid });
        // If already joined, fire immediately; otherwise wait until after the join message.
        if (myName) doMigrate(); else pendingMigrate = doMigrate;
      }
    } else if (data.oauthEnabled) {
      signInLink.hidden = false;
    }
  })
  .catch(() => { /* OAuth not configured or network error — guest mode continues as-is */ });

let pendingMigrate: (() => void) | null = null; // fired once, right after the first join message

let myRole: Role = 'observer';
let myId = ''; // per-connection id from the server; identifies our own paddle in state
let myName = '';
let myColor = '#e8eefc';
let state: StateMsg | null = null;
let ballColor = '#e8eefc'; // live pong-ball color, mirrored onto the ball reaction
let joined = false; // true once the player has entered a nickname (gates reactions)
let drunkLevel = 0; // 0 = sober … 6 = cut off (from the Tavern); wobbles the paddle + blurs the canvas
let worldJailed = false; // true while locked in the world's jail cell (drunk-driving bust)
let dayNightOffset = 0; // ms offset for the day/night clock, randomized per server boot

// Last rows each board was rendered with, so we can repaint (e.g. to add tip buttons the
// moment you join) without waiting for the next server push. Declared up here so the
// auto-rejoin path (which can run enableChat during module init) never hits them in the TDZ.
let lastLbRows: LeaderboardRow[] = [];
let lastNwRows: NetWorthRow[] = [];
// Cached "self" pin-rows so plain re-renders (e.g. on a bounty update) keep showing the
// player's own row when they're below the visible top-N.
let lastLbSelfElo: number | undefined;
let lastLbSelfRank: number | undefined;
let lastNwSelfRow: NetWorthRow | undefined;
let lastNwSelfRank: number | undefined;
// Rolling buffer of recent chat lines, surfaced as a "memos" column in Work mode.
const workChat: string[] = [];
// Active bounties, keyed by lowercased player name → pot. Drives the 🎯 badge on the boards.
const bounties = new Map<string, number>();

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
let targetX = 0; // desired inward inset off my wall while "roam" is active, court units (duel)
// Blaster: the local player's current aim angle (vertical deflection off straight-across).
let aimAngle = 0;
let lastSent = -1;
let lastSentX = 0;
let lastSendAt = 0;
const keys = new Set<string>();
// Mobile touch state: once the player taps the board we consider them "captured"
// (pointer lock is unavailable on mobile). Unlike touchActive, this stays true
// between individual taps so the game doesn't think they've un-captured.
let mobileCaptured = false;
let mobileUpHeld = false;
let mobileDownHeld = false;

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
  { move: 'MONITOR_BREAK', label: 'Smash', seq: ['arrowdown', 'arrowup', 'arrowup'], hint: '↓↑↑', desc: 'The ball rockets into the screen, the court erupts in smoke, and the glass shatters as if your monitor just broke.' },
  { move: 'AVERY', label: 'Avery', seq: ['arrowleft', 'arrowleft', 'arrowright'], hint: '←←→', desc: "The screen snaps to black and Avery's face slams in full-frame, jittering, as a jumpscare blares. Don't say we didn't warn you." },
] as const;
const COMBO_KEYS = new Set(FATALITIES.flatMap((f) => f.seq as readonly string[]));
const COMBO_WINDOW_MS = 1500; // presses older than this are forgotten
let fatalityDone = false; // already fired (or skipped) for the current 'over' screen
let pongWinCounted = false; // counted this 'over' screen toward the World "win 10 games" objective

// "FINISH HIM!" announcer sting, played once when a match ends with fatalities armed.
const finishSound = new Audio('/finish-him.mp3');
finishSound.preload = 'auto';
// Per-fatality sounds, played for the duration of the finisher animation. Only two
// finishers have a sound; the rest play silently.
const pacmanSound = new Audio('/start-music.mp3'); // PAC_CHOMP only
pacmanSound.preload = 'auto';
const jsavSound = new Audio('/you-lose.mp3'); // JSAV only
jsavSound.preload = 'auto';
const averySound = new Audio('/jumpscare.mp3'); // AVERY only
averySound.preload = 'auto';
const discoSound = new Audio('/disco.mp3'); // plays while the disco powerup is active
discoSound.preload = 'auto';
discoSound.loop = true;
const blasterSound = new Audio('/blaster.mp3'); // gunshot when the blaster fires
blasterSound.preload = 'auto';
const minionSound = new Audio('/minion-laugh.mp3'); // loops while the minion powerup is active
minionSound.preload = 'auto';
minionSound.loop = true;
const chaChing = new Audio('/chaching.mp3'); // coin powerup pickup + shop purchases
chaChing.preload = 'auto';
function playChaChing() { try { chaChing.currentTime = 0; void chaChing.play(); } catch { /* ignore */ } }
const yaySound = new Audio('/yay.mp3'); // daily-spin prize celebration
yaySound.preload = 'auto';
function playYay() { try { yaySound.currentTime = 0; void yaySound.play(); } catch { /* ignore */ } }
// Theme song: a player's equipped track, looped for the duration of a match. Started by a
// `themeSong` server message at kickoff and stopped when the match leaves 'playing' (below).
const themeSound = new Audio();
themeSound.preload = 'auto';
themeSound.loop = true;
function playTheme(src: string) {
  try { themeSound.src = src; themeSound.currentTime = 0; themeSound.muted = muted; void themeSound.play(); } catch { /* ignore */ }
}
function stopTheme() {
  try { themeSound.pause(); themeSound.removeAttribute('src'); } catch { /* ignore */ }
}
// Shop auditions: a one-shot preview of a song (doesn't touch the live match theme).
const previewSound = new Audio();
previewSound.preload = 'none';
function previewSong(src: string) {
  if (!src) return;
  try { previewSound.pause(); previewSound.src = src; previewSound.currentTime = 0; previewSound.muted = muted; void previewSound.play(); } catch { /* ignore */ }
}
// Apply persisted mute state immediately (before applyMute() runs at definition time).
applyMute();
let prevStatus: StateMsg['status'] | null = null; // last seen status, to fire on the rising edge into 'over'
let prevFatality = false; // whether a fatality was playing last frame, to fire music on the rising edge
let prevDisco = false; // rising-edge detection for disco sound
let prevMinion = false; // rising-edge detection for minion laugh loop
let prevProjCount = 0; // last seen projectile count, to fire the gunshot on a new shot
let prevTarget: StateMsg['target'] | undefined = undefined; // detect powerup pickup for flash
let prevHitSeq = -1; // detect any paddle contact (both sides, including same-side repeats)

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
  pingTitleTimer = setTimeout(() => { pingTitleTimer = null; document.title = ORIGINAL_TITLE; }, 5000);
}

function notifyChatTitle(from: string) {
  document.title = `💬 ${from} — ${ORIGINAL_TITLE}`;
  if (chatTitleTimer) clearTimeout(chatTitleTimer);
  chatTitleTimer = setTimeout(() => { chatTitleTimer = null; document.title = ORIGINAL_TITLE; }, 8000);
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

// --- latency probe ---------------------------------------------------------
// Round-trip time is measured by sending the server a timestamped `rtt` frame; it
// echoes the timestamp straight back and we diff it against our own clock. Purely a
// client-side health readout (surfaced behind the NET debug toggle); it never touches
// gameplay or the server's authoritative state. renderDebug() is defined with the rest
// of the debug UI below — it's hoisted, and never runs before module init completes.
const RTT_WINDOW = 20; // recent samples kept for the rolling average / max
const rttSamples: number[] = [];
let lastRtt = 0;
function recordRtt(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return;
  lastRtt = ms;
  rttSamples.push(ms);
  if (rttSamples.length > RTT_WINDOW) rttSamples.shift();
  renderDebug();
}

// Latest server tick-loop health, as reported on the rtt echo (null until the first reply).
let serverTick: TickHealth | null = null;

// Client frame-rate sampler: the render loop tallies frames into one-second buckets; a
// sustained dip below ~50 fps means this player's own machine/browser is struggling
// (distinct from a network problem). We keep a rolling window so we can show the worst
// recent second, where stutter actually lives.
const FPS_WINDOW = 30; // one-second readings kept (~30 s of history)
const fpsSamples: number[] = [];
let lastFps = 0;
let fpsFrames = 0; // frames counted in the current bucket
let fpsBucketStart = 0; // timestamp (loop's DOMHighResTimeStamp) the bucket opened
function sampleFps(t: number) {
  if (fpsBucketStart === 0) { fpsBucketStart = t; return; }
  fpsFrames++;
  const span = t - fpsBucketStart;
  if (span < 1000) return;
  lastFps = (fpsFrames * 1000) / span;
  fpsFrames = 0;
  fpsBucketStart = t;
  fpsSamples.push(lastFps);
  if (fpsSamples.length > FPS_WINDOW) fpsSamples.shift();
  renderDebug();
}

const net = connect(
  (msg) => {
    if (msg.type === 'you') {
      myRole = msg.role;
      myId = msg.id;
      if (typeof msg.tOff === 'number') dayNightOffset = msg.tOff; // per-deploy day/night phase
      lastSent = -1; // force a re-sync of our paddle target from the next state
      if (!isPlayer()) { touchActive = false; mobileCaptured = false; }
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
          : msg.fatality?.move === 'AVERY' ? averySound
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
        averySound.pause();
        averySound.currentTime = 0;
      }
      prevFatality = fatalityActive;
      // Theme song stops the instant a match leaves 'playing' (match over / back to waiting).
      if (msg.status !== 'playing' && prevStatus === 'playing') stopTheme();
      prevStatus = msg.status;
      // Disco music: plays for the duration of the powerup, stops when the point ends.
      const discoActive = !!msg.disco;
      if (discoActive && !prevDisco) {
        discoSound.currentTime = 0;
        discoSound.play().catch(() => {});
      } else if (!discoActive && prevDisco) {
        discoSound.pause();
        discoSound.currentTime = 0;
      }
      prevDisco = discoActive;
      // Minion laugh: loops while the minion powerup is active, stops when the point ends.
      const minionActive = !!msg.minion;
      if (minionActive && !prevMinion) {
        minionSound.currentTime = 0;
        minionSound.play().catch(() => {});
      } else if (!minionActive && prevMinion) {
        minionSound.pause();
        minionSound.currentTime = 0;
      }
      prevMinion = minionActive;
      // Gunshot on every new blaster projectile (heard by shooter, opponent and spectators).
      const projCount = msg.projectiles.length;
      if (projCount > prevProjCount) {
        blasterSound.currentTime = 0;
        blasterSound.play().catch(() => {});
      }
      prevProjCount = projCount;
      // Detect paddle hit and score events for sound.
      if (msg.status === 'playing' && !msg.paused) {
        if (msg.hitSeq !== prevHitSeq) playHitSound();
        if (msg.score.left > prevScore.left || msg.score.right > prevScore.right) playScoreSound();
      }
      prevHitSeq = msg.hitSeq;
      prevScore = { ...msg.score };
      // Detect powerup pickup: target was present last frame, gone this frame.
      if (prevTarget && !msg.target) {
        showPowerupFlash(prevTarget.kind, prevTarget.x, prevTarget.y);
        if (prevTarget.kind === 'coins') playChaChing(); // coin grab
      }
      prevTarget = msg.target ?? null;
      state = msg;
      syncMyPaddleFromServer();
      syncViewMode(msg.viewMode ?? 'normal');
      updateUI();
    } else if (msg.type === 'leaderboard') {
      renderLeaderboard(msg.rows, msg.selfElo, msg.selfRank);
    } else if (msg.type === 'netWorth') {
      renderNetWorth(msg.rows, msg.selfRow, msg.selfRank);
    } else if (msg.type === 'balanceSheet') {
      showBalanceSheet(msg);
    } else if (msg.type === 'eloProfile') {
      showEloProfile(msg);
    } else if (msg.type === 'chat') {
      msg.lines.forEach(addChatLine);
      // Notify via tab title for a single new message while the tab is backgrounded.
      // History replays (length > 1) are excluded to avoid spurious notifications on connect.
      if (msg.lines.length === 1 && document.hidden && msg.lines[0].from !== myName) {
        notifyChatTitle(msg.lines[0].from);
      }
    } else if (msg.type === 'reaction') {
      spawnReaction(msg.emoji);
    } else if (msg.type === 'tip') {
      celebrateTip(msg.from, msg.to, msg.amount);
    } else if (msg.type === 'bounties') {
      bounties.clear();
      for (const b of msg.list) bounties.set(b.name.toLowerCase(), b.pot);
      // Repaint the boards so 🎯 badges appear/update immediately.
      renderLeaderboard(lastLbRows);
      renderNetWorth(lastNwRows);
    } else if (msg.type === 'bountyHit') {
      celebrateTip(msg.winner, msg.target, msg.amount);
    } else if (msg.type === 'themeSong') {
      playTheme(msg.audio);
    } else if (msg.type === 'announce') {
      showAnnouncement(msg.text, { toast: msg.toast });
    } else if (msg.type === 'ping') {
      onPing(msg.from);
    } else if (msg.type === 'flyover') {
      flySummoned(msg.idx); // someone summoned the plane with the secret word — everyone flies it
    } else if (msg.type === 'rtt') {
      if (msg.tick) serverTick = msg.tick;
      recordRtt(performance.now() - msg.t);
    } else if (msg.type === 'doomLobby') {
      doomMod?.feedDoomLobby(msg);
    } else if (msg.type === 'doomRelay') {
      doomMod?.feedDoomRelay(msg.data);
    } else if (msg.type === 'doomEnd') {
      doomMod?.feedDoomEnd(msg.reason);
    } else if (msg.type === 'ntLobby') {
      nuketownMod?.feedNtLobby(msg);
    } else if (msg.type === 'ntRelay') {
      nuketownMod?.feedNtRelay(msg.data);
    } else if (msg.type === 'srLobby') {
      streetDemonsMod?.feedSrLobby(msg);
    } else if (msg.type === 'srRelay') {
      streetDemonsMod?.feedSrRelay(msg.data);
    } else if (msg.type === 'sbLobby') {
      superBrosMod?.feedSbLobby(msg);
    } else if (msg.type === 'sbRelay') {
      superBrosMod?.feedSbRelay(msg.data);
    } else if (msg.type === 'doomLeaderboard') {
      doomScores = { solo: msg.solo, coop: msg.coop };
    } else if (msg.type === 'nomState') {
      nomicMod?.feedNomState(msg);
    } else if (msg.type === 'tdState') {
      typeDieMod?.feedTdState(msg);
    } else if (msg.type === 'tdLeaderboard') {
      typeDieScores = msg.rows;
    } else if (msg.type === 'campaignLeaderboard') {
      campaignScores = msg.rows;
    } else if (msg.type === 'fishLeaderboard') {
      fishScores = msg.rows;
      fishingMod?.feedFishLeaderboard(msg.rows);
    } else if (msg.type === 'fishReward') {
      fishingMod?.feedFishReward(msg.coins, msg.item);
    } else if (msg.type === 'netizenInfo') {
      showNetizenChallenge(msg);
    } else if (msg.type === 'netizenChallengeResult') {
      const text = msg.won
        ? `🏆 Beat ${msg.netizenName} — won ${msg.delta}🪙!`
        : `💸 Lost to ${msg.netizenName} — lost ${msg.delta}🪙.`;
      showToast(text);
    } else if (msg.type === 'world') {
      worldMod?.feedWorld(msg.avatars);
    } else if (msg.type === 'prefs') {
      // Account-stored settings arriving on join: seed the local set (server wins over cookie) and apply.
      for (const [k, v] of Object.entries(msg.prefs)) { prefs[k] = v; setCookie('tsong_' + k, v); }
      applyPrefs();
    } else if (msg.type === 'land') {
      worldMod?.feedLand(msg.parcels, msg.bankBought, msg.bankCap);
    } else if (msg.type === 'worldSay') {
      worldMod?.feedSay(msg.id, msg.name, msg.text);
    } else if (msg.type === 'wallet') {
      wallet = { coins: msg.coins, owned: msg.owned, hat: msg.hat, skin: msg.skin, trail: msg.trail, title: msg.title, song: msg.song, car: msg.car, pet: msg.pet, exclusives: msg.exclusives, bets: msg.bets, nextSpinAt: msg.nextSpinAt, bonusSpins: msg.bonusSpins };
      rouletteHandle.setCoins(msg.coins);
      bjHandle.setCoins(msg.coins);
      crapsHandle.setCoins(msg.coins);
      crashHandle.setCoins(msg.coins);
      slotsHandle.setCoins(msg.coins);
      plinkoHandle.setCoins(msg.coins);
      horseHandle.setCoins(msg.coins);
      hiloHandle.setCoins(msg.coins);
      minesHandle.setCoins(msg.coins);
      if (!lootPanel.hidden) renderLoot();
      if (!marketplacePanel.hidden) renderMarketplace();
      // During a roulette spin, hold every coin-total display (toolbar tab, shop, market) at its
      // pre-result value until the wheel lands — otherwise the settled balance reveals the outcome
      // before the animation finishes. The roulette `onSettled` callback runs refreshWallet then.
      if (!rouletteHandle.isSpinning()) refreshWallet();
    } else if (msg.type === 'stocks') {
      market = { prices: msg.prices, holdings: msg.holdings, history: msg.history, nextUpdateAt: msg.nextUpdateAt };
      if (!marketPanel.hidden) renderMarket();
      updateMarketTimer();
      renderStability(msg.stability);
    } else if (msg.type === 'spinResult') {
      celebrateSpin(msg.reward, msg.segment);
    } else if (msg.type === 'rouletteResult') {
      rouletteHandle.onResult(msg);
    } else if (msg.type === 'bjState') {
      bjHandle.onState(msg);
    } else if (msg.type === 'bjResult') {
      bjHandle.onResult(msg);
    } else if (msg.type === 'crapsResult') {
      crapsHandle.onResult(msg);
    } else if (msg.type === 'slotsResult') {
      slotsHandle.onResult(msg);
    } else if (msg.type === 'plinkoResult') {
      plinkoHandle.onResult(msg);
    } else if (msg.type === 'horseCard') {
      horseHandle.onCard(msg);
    } else if (msg.type === 'horseResult') {
      horseHandle.onResult(msg);
    } else if (msg.type === 'hiloState') {
      hiloHandle.onState(msg);
    } else if (msg.type === 'hiloResult') {
      hiloHandle.onResult(msg);
    } else if (msg.type === 'minesState') {
      minesHandle.onState(msg);
    } else if (msg.type === 'minesResult') {
      minesHandle.onResult(msg);
    } else if (msg.type === 'crashState') {
      crashHandle.onState(msg);
    } else if (msg.type === 'loan') {
      loan = msg.loan;
      // Taking/repaying resets the conversation; collecting (loan→null) drops back to the intro.
      if (!loan) loanStep = 'intro';
      if (!loanPanel.hidden) renderLoan();
    } else if (msg.type === 'house') {
      houseBalance = msg.balance;
      renderHouse();
    } else if (msg.type === 'houseState') {
      houseState = msg;
      if (!housePanel.hidden) renderHouseDashboard();
    } else if (msg.type === 'lootResult') {
      onLootResult(msg);
    } else if (msg.type === 'market') {
      marketplace = msg.items;
      if (!marketplacePanel.hidden) renderMarketplace();
    } else if (msg.type === 'loanBook') {
      showLoanBook(msg);
    } else if (msg.type === 'news') {
      newsFeed = msg.items;
      if (!newsPanel.hidden) renderNews();
    } else if (msg.type === 'drunk') {
      drunkLevel = msg.level;
      // escalating booze haze on the pong canvas: blur + woozy hue/saturation that grows per level
      canvas.style.filter = drunkLevel > 0
        ? `blur(${(drunkLevel * 0.35).toFixed(2)}px) hue-rotate(${drunkLevel * 6}deg) saturate(${1 + drunkLevel * 0.12}) brightness(${1 + drunkLevel * 0.03})`
        : '';
      canvas.style.transition = 'filter 0.6s ease';
    } else if (msg.type === 'jailed') {
      worldJailed = msg.jailed;
      // Locked up → your whole world IS the jail: force the overworld open (and out of pointer-lock /
      // any pong screen). You can't play or leave until someone posts bail.
      if (msg.jailed) {
        if (document.pointerLockElement) document.exitPointerLock();
        void import('./world').then((m) => { if (!m.isWorldOpen()) worldBtn.click(); });
      }
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
    // If we're walking the world map, re-announce our presence (the server drops us on socket
    // close, so a reconnect would otherwise make our avatar invisible to everyone else).
    worldMod?.reenterWorld();
    // Take a fresh latency reading the instant we're (re)connected, rather than waiting
    // out the probe interval below.
    net.send({ type: 'rtt', t: performance.now() });
  },
);

// Repaint every coin-total display from the current wallet (toolbar tab, shop, open market/loan
// panels). Held back during a roulette spin so the result isn't revealed before the wheel lands.
function refreshWallet() {
  renderShop();
  if (!marketPanel.hidden) renderMarket(); // coin balance gates the Invest buttons
  if (!loanPanel.hidden && loan) renderLoan(); // balance gates the Pay button
}

// Roulette panel (top-left): bets are settled server-side; this just drives the wheel UI.
const rouletteHandle = initRoulette({
  send: (bets) => net.send({ type: 'roulette', bets }),
  playWin: playYay,
  // Fires when the wheel finishes; reveal the settled balance everywhere now, not mid-spin.
  onSettled: refreshWallet,
});

// Blackjack panel.
const bjHandle = initBlackjack({
  send: (type, payload) => net.send({ type, ...payload } as Parameters<typeof net.send>[0]),
  playWin: playYay,
  onSettled: refreshWallet,
});

// Craps panel.
const crapsHandle = initCraps({
  send: (pass, dontPass) => net.send({ type: 'crapsRoll', pass, dontPass }),
  playWin: playYay,
  onSettled: refreshWallet,
});

// Slots panel.
const slotsHandle = initSlots({
  send: (amount) => net.send({ type: 'slotsSpin', amount }),
  playWin: playYay,
  onSettled: refreshWallet,
});

// Crash panel — live state streamed from server every 100ms.
const crashHandle = initCrash({
  sendBet: (amount, autoCashout) => net.send({ type: 'crashBet', amount, ...(autoCashout ? { autoCashout } : {}) }),
  sendCancelBet: () => net.send({ type: 'crashCancelBet' }),
  sendCashout: () => net.send({ type: 'crashCashout' }),
  playWin: playYay,
});

const plinkoHandle = initPlinko({
  send: (amount) => net.send({ type: 'plinko', amount }),
  playWin: playYay,
  onSettled: refreshWallet,
});

const horseHandle = initHorse({
  sendReq: () => net.send({ type: 'horseReq' }),
  sendBet: (horse, amount) => net.send({ type: 'horseBet', horse, amount }),
  playWin: playYay,
  onSettled: refreshWallet,
});

const hiloHandle = initHilo({
  sendBet: (amount) => net.send({ type: 'hiloBet', amount }),
  sendGuess: (guess) => net.send({ type: 'hiloGuess', guess }),
  sendCashout: () => net.send({ type: 'hiloCashout' }),
  playWin: playYay,
  onSettled: refreshWallet,
});

const minesHandle = initMines({
  sendBet: (amount, mines) => net.send({ type: 'minesBet', amount, mines }),
  sendReveal: (cell) => net.send({ type: 'minesReveal', cell }),
  sendCashout: () => net.send({ type: 'minesCashout' }),
  playWin: playYay,
  onSettled: refreshWallet,
});

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
  if (pendingMigrate) { pendingMigrate(); pendingMigrate = null; }
  overlay.style.display = 'none';
  enableChat();
  revealAds(); // the fake banner ad only appears once you're in (never over the join screen)
  startFlyovers();
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
function sendReady() { net.send({ type: 'ready' }); }
readyBtn.addEventListener('click', sendReady);
rematchBtn.addEventListener('click', () => {
  // Rematch = both sides ready up immediately. Just send ready for yourself;
  // the server handles the two-sided handshake as normal.
  net.send({ type: 'ready' });
  rematchBtn.textContent = '✓ Waiting…';
  rematchBtn.disabled = true;
});

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

// --- quit game: vacate your paddle spot (the side reverts to "— open —") ---
quitBtn.addEventListener('click', () => net.send({ type: 'forfeit' }));

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
breakoutModeEl.addEventListener('change', () =>
  net.send({ type: 'mode', breakout: breakoutModeEl.checked }),
);
fogModeEl.addEventListener('change', () =>
  net.send({ type: 'mode', fog: fogModeEl.checked }),
);
portalModeEl.addEventListener('change', () =>
  net.send({ type: 'mode', portal: portalModeEl.checked }),
);
bumpersModeEl.addEventListener('change', () =>
  net.send({ type: 'mode', bumpers: bumpersModeEl.checked }),
);

// --- win score selector ---
for (const btn of winScoreOpts.querySelectorAll<HTMLButtonElement>('.ws-btn')) {
  btn.addEventListener('click', () => {
    const score = Number(btn.dataset.score);
    net.send({ type: 'setWinScore', score });
  });
}

// Every distinct player nickname the client currently knows about (seated players,
// watchers and the queue), minus my own — used to suggest /tip recipients.
function knownPlayerNames(): string[] {
  const names = new Set<string>();
  if (state) {
    for (const side of ['left', 'right'] as const) {
      for (const p of state.paddles[side].players) if (p.name) names.add(p.name);
    }
    for (const w of state.watchers) names.add(w);
    for (const q of state.queue) names.add(q);
    if (state.king) names.add(state.king);
  }
  names.delete(myName);
  return [...names].sort();
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
    name: 'tip',
    hint: 'Tip anyone coins — /tip <name> <amount>. Offline players get it next sign-in.',
    enabled: () => joined,
    disabledHint: 'join the game first',
    argOptions: () => knownPlayerNames(),
    argHint: (arg) => `Tip ${arg} — then add an amount (e.g. /tip ${arg} 50)`,
    run: (arg) => {
      const tokens = (arg ?? '').trim().split(/\s+/).filter(Boolean);
      if (tokens.length < 2) return false; // need a name AND an amount — keep the text visible
      const amount = Number(tokens.pop());
      const to = tokens.join(' ');
      if (!to || !Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) return false;
      net.send({ type: 'tip', to, amount });
    },
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
// Terminal-style chat history: Up/Down in the chat box cycle through messages you've sent.
const chatHistory: string[] = [];
let histIndex = -1; // -1 = editing a fresh line; otherwise an index into chatHistory
let histDraft = ''; // the in-progress line stashed when you start scrolling back

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  // Remember it for Up-arrow recall (skip consecutive duplicates), and reset the cursor.
  if (chatHistory[chatHistory.length - 1] !== text) chatHistory.push(text);
  histIndex = -1;
  histDraft = '';
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

chatInput.addEventListener('input', () => {
  histIndex = -1; // manual edits start a fresh line again
  refreshCommandMenu();
});
chatInput.addEventListener('focus', refreshCommandMenu);
chatInput.addEventListener('keydown', (e) => {
  // With the command menu closed, Up/Down recall previously sent messages (terminal-style).
  if (commandMenu.hidden) {
    if (e.key === 'ArrowUp' && chatHistory.length) {
      e.preventDefault();
      if (histIndex === -1) {
        histDraft = chatInput.value;
        histIndex = chatHistory.length - 1;
      } else if (histIndex > 0) {
        histIndex--;
      }
      chatInput.value = chatHistory[histIndex];
      chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
    } else if (e.key === 'ArrowDown' && histIndex !== -1) {
      e.preventDefault();
      if (histIndex < chatHistory.length - 1) {
        histIndex++;
        chatInput.value = chatHistory[histIndex];
      } else {
        histIndex = -1;
        chatInput.value = histDraft;
      }
      chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
    }
    return;
  }
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
  // Space or Enter triggers ready-up when the button is visible and not pointer-locked.
  if ((e.key === ' ' || e.key === 'Enter') && !pointerLocked && readyBtn.style.display !== 'none') {
    e.preventDefault();
    sendReady();
  }
});

// Close the menu when focus/clicks leave the chat form.
document.addEventListener('click', (e) => {
  if (!commandMenu.hidden && !chatForm.contains(e.target as Node)) closeCommandMenu();
});

function enableChat() {
  joined = true;
  // Repaint the boards now that we've joined so their per-player tip buttons appear.
  renderLeaderboard(lastLbRows);
  renderNetWorth(lastNwRows);
  chatInput.disabled = false;
  closingModeEl.disabled = false;
  gravityModeEl.disabled = false;
  turboModeEl.disabled = false;
  streamerModeEl.disabled = false;
  diamondModeEl.disabled = false;
  pinataModeEl.disabled = false;
  layeredModeEl.disabled = false;
  arenaModeEl.disabled = false;
  breakoutModeEl.disabled = false;
  fogModeEl.disabled = false;
  portalModeEl.disabled = false;
  bumpersModeEl.disabled = false;
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

// A tip just happened anywhere in the room: cha-ching for everyone, a shower of gold
// coins fluttering up the screen, and a banner naming who paid whom. The recipient gets
// an extra-celebratory golden banner; everyone else a small toast.
function celebrateTip(from: string, to: string, amount: number) {
  playChaChing();
  const mine = to === myName;
  // Coin shower — scale the count a little with the size of the tip (capped so it never floods).
  const coins = Math.min(28, 8 + Math.floor(Math.log2(amount + 1) * 3));
  for (let i = 0; i < coins; i++) {
    setTimeout(() => spawnCoin(), i * 70);
  }
  // The room sees the shower + cha-ching (and the /tip line in chat); the lucky
  // recipient gets a golden banner calling it out.
  if (mine) showAnnouncement(`💰 ${from} tipped you ${amount} 🪙!`, { color: '#ffcf33' });
}

// One gold coin fluttering up the screen (the tip-shower particle). Like a reaction,
// but spins as it rises for a little extra sparkle.
function spawnCoin() {
  const el = document.createElement('div');
  el.className = 'floating-reaction';
  el.textContent = '🪙';
  el.style.left = `${5 + Math.random() * 90}vw`;
  reactionLayer.append(el);

  const rise = window.innerHeight + 120;
  const drift = (Math.random() - 0.5) * 220;
  const spin = (Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 360);
  const duration = 2200 + Math.random() * 1400;

  const anim = el.animate(
    [
      { transform: 'translate(0, 0) rotate(0deg) scale(0.4)', opacity: 0 },
      { transform: `translate(${drift * 0.3}px, ${-rise * 0.15}px) rotate(${spin * 0.15}deg) scale(1)`, opacity: 1, offset: 0.12 },
      { transform: `translate(${drift}px, ${-rise}px) rotate(${spin}deg) scale(1.1)`, opacity: 0 },
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
  if (!line.command) {
    workChat.push(`${line.from}: ${line.text}`);
    if (workChat.length > 30) workChat.shift();
  }
  if (line.command && hideCmdsEl.checked) return;
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
  const isNonPlayer = !line.player;
  const classes = line.command ? 'chat-row chat-row-cmd' : 'chat-row';
  row.className = classes + (isNonPlayer ? ' chat-row-np' : '');
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
  if (isNonPlayer && hideNetizenChatEl.checked) row.style.display = 'none';
  chatLog.append(row);
  while (chatLog.childElementCount > 100) chatLog.firstElementChild!.remove();
  chatLog.scrollTop = chatLog.scrollHeight;
}

// Chat display toggles — synced as user prefs (cookie + account).
bindCheckboxPref(hideCmdsEl, 'hideCmds', (hide) => {
  for (const row of chatLog.querySelectorAll<HTMLElement>('.chat-row-cmd')) {
    row.style.display = hide ? 'none' : '';
  }
});

bindCheckboxPref(hideTimestampsEl, 'hideTimestamps', (hide) => {
  chatEl.classList.toggle('hide-timestamps', hide);
});

bindCheckboxPref(hideNetizenChatEl, 'hideNetizenChat', (hide) => {
  for (const row of chatLog.querySelectorAll<HTMLElement>('.chat-row-np')) {
    row.style.display = hide ? 'none' : '';
  }
});

// --- Boss-key target setting (lives in the Work menu; synced as a pref). ---
// Which disguise Cmd/Ctrl+X drops into.
let bossKeyTarget: 'spreadsheet' | 'terminal' =
  prefGet('bosskey', 'spreadsheet') === 'terminal' ? 'terminal' : 'spreadsheet';
function setBossKeyTarget(t: 'spreadsheet' | 'terminal', persist: boolean) {
  bossKeyTarget = t;
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="bossKeyTarget"]')) {
    r.checked = r.value === t;
  }
  if (persist) prefSet('bosskey', t);
}
setBossKeyTarget(bossKeyTarget, false); // reflect the loaded value in the radios
document.addEventListener('change', (e) => {
  const r = e.target as HTMLInputElement;
  if (r?.name === 'bossKeyTarget') setBossKeyTarget(r.value === 'terminal' ? 'terminal' : 'spreadsheet', true);
});

// Small name-pop at the court location where a power-up was just collected.
function showPowerupFlash(kind: string, cx: number, cy: number) {
  const boardEl = state?.viewMode !== 'normal' ? game3dEl : canvas;
  const r = boardEl.getBoundingClientRect();
  const scaleX = r.width / COURT.w;
  const scaleY = r.height / COURT.h;
  const el = document.createElement('div');
  el.className = 'powerup-flash';
  el.textContent = kind.toUpperCase();
  el.style.color = PU_CHIP_COLOR[kind] ?? '#fff';
  el.style.left = `${r.left + cx * scaleX}px`;
  el.style.top  = `${r.top  + cy * scaleY}px`;
  reactionLayer.append(el);
  const anim = el.animate(
    [
      { opacity: 0,   transform: 'translate(-50%, -50%) scale(0.6)' },
      { opacity: 1,   transform: 'translate(-50%, -80%) scale(1.1)', offset: 0.2 },
      { opacity: 1,   transform: 'translate(-50%, -120%) scale(1)',  offset: 0.6 },
      { opacity: 0,   transform: 'translate(-50%, -160%) scale(0.9)' },
    ],
    { duration: 900, easing: 'ease-out' },
  );
  anim.onfinish = () => el.remove();
  anim.oncancel = () => el.remove();
}

// --- DOOM minigame (lazy-loaded, self-contained). Solo runs entirely client-side; co-op
// uses the server only as a 2-slot lobby + opaque relay (doom* messages, routed below). ---
const doomBtn = document.getElementById('doomBtn') as HTMLButtonElement;
let doomMod: typeof import('./doom') | null = null;
// Latest DOOM high-round leaderboards (solo / co-op), pushed by the server.
let doomScores: { solo: Array<{ name: string; round: number }>; coop: Array<{ name: string; round: number }> } = { solo: [], coop: [] };
doomBtn.addEventListener('click', async () => {
  try {
    doomMod = await import('./doom');
    doomMod.startDoom({
      join: () => net.send({ type: 'doomJoin' }),
      leave: () => net.send({ type: 'doomLeave' }),
      relay: (data) => net.send({ type: 'doomRelay', data }),
      submitScore: (round, coop, label) => net.send({ type: 'doomScore', round, coop, name: label }),
      scores: () => doomScores,
      name: () => myName,
      awardCoin: () => net.send({ type: 'doomReward' }),
    });
  } catch (e) {
    console.error('DOOM failed to load:', e);
  }
});

// --- Nuketown team-deathmatch FPS (lazy-loaded, self-contained). Host-authoritative: the
// server is only a lobby + broadcast relay (nt* messages, routed above). Slot 0 (first joiner)
// simulates the whole match and streams snapshots; guests send input and render from them. ---
const nuketownBtn = document.getElementById('nuketownBtn') as HTMLButtonElement;
let nuketownMod: typeof import('./nuketown') | null = null;
nuketownBtn.addEventListener('click', async () => {
  try {
    nuketownMod = await import('./nuketown');
    nuketownMod.startNuketown({
      join: () => net.send({ type: 'ntJoin' }),
      leave: () => net.send({ type: 'ntLeave' }),
      start: () => net.send({ type: 'ntStart' }),
      relay: (data) => net.send({ type: 'ntRelay', data }),
      end: (team) => net.send({ type: 'ntEnd', team }),
      name: () => myName,
    });
  } catch (e) {
    console.error('Nuketown failed to load:', e);
  }
});

// --- Street Demons: Grand Prix racer (lazy-loaded, self-contained). Host-authoritative over the
// server's sr* broadcast relay (routed above): slot 0 (first joiner) runs the whole sim, fills
// empty grid slots with bots, and streams snapshots; guests send input and render from them. ---
const streetDemonsBtn = document.getElementById('streetDemonsBtn') as HTMLButtonElement;
let streetDemonsMod: typeof import('./streetdemons') | null = null;
streetDemonsBtn.addEventListener('click', async () => {
  try {
    streetDemonsMod = await import('./streetdemons');
    streetDemonsMod.startStreetDemons({
      join: () => net.send({ type: 'srJoin' }),
      leave: () => net.send({ type: 'srLeave' }),
      start: () => net.send({ type: 'srStart' }),
      relay: (data) => net.send({ type: 'srRelay', data }),
      end: (winner) => net.send({ type: 'srEnd', winner }),
      name: () => myName,
    });
  } catch (e) {
    console.error('Street Demons failed to load:', e);
  }
});

// --- Super Tsong Bros PvP platform fighter (lazy-loaded, self-contained). Host-authoritative:
// the server is only a lobby (with a per-slot fighter pick + all-locked start gate) + broadcast
// relay (sb* messages, routed above). Slot 0 (first joiner) simulates the whole match and
// streams snapshots; guests send input and render from them. ---
const sbBtn = document.getElementById('sbBtn') as HTMLButtonElement;
let superBrosMod: typeof import('./superbros') | null = null;
sbBtn.addEventListener('click', async () => {
  try {
    superBrosMod = await import('./superbros');
    superBrosMod.startSuperBros({
      join: () => net.send({ type: 'sbJoin' }),
      leave: () => net.send({ type: 'sbLeave' }),
      pick: (fighter) => net.send({ type: 'sbPick', fighter }),
      start: () => net.send({ type: 'sbStart' }),
      end: (winner) => net.send({ type: 'sbEnd', winner }),
      relay: (data) => net.send({ type: 'sbRelay', data }),
      name: () => myName,
    });
  } catch (e) {
    console.error('Super Tsong Bros failed to load:', e);
  }
});

// --- "Type or Die" co-op typing horde-defense (lazy-loaded). Server-authoritative: the
// overlay just renders tdState and sends keystroke outcomes (td* messages, routed above). ---
const typeDieBtn = document.getElementById('typeDieBtn') as HTMLButtonElement;
let typeDieMod: typeof import('./typeordie') | null = null;
let typeDieScores: import('../shared/types').TypeDieScoreRow[] = [];
typeDieBtn.addEventListener('click', async () => {
  try {
    typeDieMod = await import('./typeordie');
    typeDieMod.startTypeDie({
      join: () => net.send({ type: 'tdJoin' }),
      leave: () => net.send({ type: 'tdLeave' }),
      start: () => net.send({ type: 'tdStart' }),
      target: (id) => net.send({ type: 'tdTarget', id }),
      kill: (id) => net.send({ type: 'tdKill', id }),
      name: () => myName,
      leaderboard: () => typeDieScores,
    });
  } catch (e) {
    console.error('Type or Die failed to load:', e);
  }
});

// --- The Parliament (Nomic), reached by walking into the Parliament building in the World. A
// lazy-loaded DOM overlay; the server is authoritative (nomState in, nom* messages out). ---
let nomicMod: typeof import('./nomic') | null = null;
async function openParliament(): Promise<void> {
  try {
    nomicMod = await import('./nomic');
    nomicMod.startNomic({
      enter: () => net.send({ type: 'nomEnter' }),
      leave: () => net.send({ type: 'nomLeave' }),
      propose: (kind, text, target, effect, ruleClass) => net.send({ type: 'nomPropose', kind, text, target, effect, ruleClass }),
      vote: (vote) => net.send({ type: 'nomVote', vote }),
      resolve: () => net.send({ type: 'nomResolve' }),
    });
  } catch (e) {
    console.error('Parliament failed to load:', e);
  }
}

// --- Fake banner ad (bottom of page). Spammy clickbait for the game's own features that, when
// clicked, actually launches them. Built now (hidden); revealed once the player joins. ---
initAds({
  doom: () => doomBtn.click(),
  campaign: () => campaignBtn.click(),
  typedie: () => typeDieBtn.click(),
  shop: () => shopBtn.click(),
});
initFlyover(() => net.send({ type: 'summonPlane' })); // the occasional banner-plane flyover (and rarer crash); secret word summons one room-wide

// --- Campaign ("Davis Collects", lazy-loaded, self-contained). Runs its own 2D Pong + VN;
// the server is used only to persist arcade scores (campaignScore / campaignLeaderboard). ---
const campaignBtn = document.getElementById('campaignBtn') as HTMLButtonElement;
// Latest campaign leaderboard, pushed by the server.
let campaignScores: import('../shared/types').CampaignScoreRow[] = [];
campaignBtn.addEventListener('click', async () => {
  try {
    const mod = await import('./campaign');
    mod.startCampaign({
      submitScore: (score, stage, won) => net.send({ type: 'campaignScore', score, stage, won }),
      leaderboard: () => campaignScores,
      name: () => myName,
    });
  } catch (e) {
    console.error('Campaign failed to load:', e);
  }
});

// --- Fishing minigame ("Cast a line", lazy-loaded, self-contained). Reached from the World pond's
// pier. Solo Canvas overlay: it rolls a fish, runs the skill game, and reports tier+size to the
// server, which pays a House-funded reward and tracks the biggest catch. ---
let fishingMod: typeof import('./fishing') | null = null;
// Latest biggest-catch leaderboard, pushed by the server.
let fishScores: import('../shared/types').FishLeaderboardRow[] = [];
async function openFishing(): Promise<void> {
  try {
    fishingMod = await import('./fishing');
    fishingMod.startFishing({
      catchFish: (tier, sizeLb) => net.send({ type: 'fishCatch', tier, sizeLb }),
      leaderboard: () => fishScores,
      name: () => myName,
    });
  } catch (e) {
    console.error('Fishing failed to load:', e);
  }
}
// Arcade-menu entry: same fishing overlay you get from walking into the pond in the World.
const fishingBtn = document.getElementById('fishingBtn') as HTMLButtonElement;
fishingBtn.addEventListener('click', () => { void openFishing(); });

// --- Beta "World": a free-roam 2D overworld you walk around as a named avatar, seeing everyone
// else who's currently in the world. It's the future main UI; for now its buildings deep-link
// into existing features — the Arena (tsong itself, via the play queue), the Casino (roulette)
// and the Bank (crypto market / loans). Lazy-loaded + fully self-contained (client/world.ts);
// the server only relays avatar positions. ---
const worldBtn = document.getElementById('worldBtn') as HTMLButtonElement;
let worldMod: typeof import('./world') | null = null;
worldBtn.addEventListener('click', async () => {
  try {
    worldMod = await import('./world');
    if (worldMod.isWorldOpen()) return; // already walking around
    worldBtn.setAttribute('aria-pressed', 'true');
    worldMod.startWorld({
      enter: () => net.send({ type: 'worldEnter' }),
      leave: () => net.send({ type: 'worldLeave' }),
      move: (x, y, a, car, pet) => net.send({ type: 'worldMove', x, y, a, car, pet }),
      name: () => myName,
      color: () => myColor,
      selfId: () => myId,
      car: () => wallet.car, // the car you've equipped in the shop (null = on foot only)
      pet: () => wallet.pet, // the pet you've equipped in the shop — trails behind you (null = none)
      onExit: () => worldBtn.setAttribute('aria-pressed', 'false'),
      // Walk into the Arena → hop into the play queue (you'll be seated when a spot opens).
      enterArena: () => net.send({ type: 'queueJoin' }),
      // Casino/Bank choices open the existing feature panels by triggering their toolbar buttons.
      // Deferred to the next tick: the world tears down on this same click, and firing the button
      // synchronously let the originating click keep bubbling to the panel's "close on outside
      // click" handler — which instantly re-closed the panel (the casino bug). A 0ms gap lets the
      // current click finish first, so the panel opens cleanly.
      // Tapping a netizen avatar in the world requests its info for the challenge dialog.
      onNetizenClick: (netizenId) => { net.send({ type: 'netizenInfoReq', netizenId }); },
      openFeature: (feature) => {
        // The Pet Shop is a cosmetic venue, not a gambling/bank feature: open the Shop panel and
        // jump straight to the Pets tab (deferred like the others to dodge the outside-click race).
        if (feature === 'petshop') {
          setTimeout(() => {
            if (shopPanel.hidden) shopBtn.click(); // open the shop if it isn't already
            selectShopTab('pet', tabPets);
          }, 0);
          return;
        }
        // The DOOM portal launches DOOM the same way the toolbar's Doom button does (deferred a
        // tick like the others, so the world's teardown click finishes first).
        if (feature === 'doom') {
          setTimeout(() => doomBtn.click(), 0);
          return;
        }
        // The pond's pier opens the solo Fishing overlay (lazy-loaded, like DOOM/campaign),
        // deferred a tick so the world's teardown click finishes first.
        if (feature === 'fishing') {
          setTimeout(() => { void openFishing(); }, 0);
          return;
        }
        // Arcade cabinets launch the solo/co-op minigames via their toolbar buttons.
        if (feature === 'campaign' || feature === 'typedie' || feature === 'racing' || feature === 'superbros') {
          const btn = feature === 'campaign' ? campaignBtn
                    : feature === 'typedie' ? typeDieBtn
                    : feature === 'racing' ? streetDemonsBtn
                    : sbBtn;
          setTimeout(() => btn.click(), 0);
          return;
        }
        const id = feature === 'roulette'  ? 'rouletteBtn'
                 : feature === 'blackjack' ? 'bjBtn'
                 : feature === 'craps'     ? 'crapsBtn'
                 : feature === 'crash'     ? 'crashBtn'
                 : feature === 'slots'     ? 'slotsBtn'
                 : feature === 'plinko'    ? 'plinkoBtn'
                 : feature === 'horse'     ? 'horseBtn'
                 : feature === 'hilo'      ? 'hiloBtn'
                 : feature === 'mines'     ? 'minesBtn'
                 : feature === 'stocks'    ? 'marketBtn'
                 : 'loanBtn';
        setTimeout(() => (document.getElementById(id) as HTMLButtonElement | null)?.click(), 0);
      },
      claimQuest: (quest) => net.send({ type: 'questClaim', quest }),
      buyBeer: () => net.send({ type: 'buyBeer' }),
      drunkLevel: () => drunkLevel, // the world reads this live to wobble movement + the camera
      jail: () => net.send({ type: 'jail' }),                 // tried to drunk-drive → bust
      bail: (targetId) => net.send({ type: 'bail', targetId }), // post 500🪙 bail for a jailed avatar
      amJailed: () => worldJailed,                            // are WE locked up right now?
      dayNightOffset: () => dayNightOffset,                   // per-deploy day/night clock offset
      openParliament: () => { setTimeout(() => { void openParliament(); }, 0); }, // walk in → Nomic overlay
      // Robville land: buy from the bank, list/unlist your lots, buy listed lots off other owners.
      landReq: () => net.send({ type: 'landReq' }),
      landBuyBank: (id) => net.send({ type: 'landBuyBank', id }),
      landList: (id, ask) => net.send({ type: 'landList', id, ask }),
      landUnlist: (id) => net.send({ type: 'landUnlist', id }),
      landBuy: (id) => net.send({ type: 'landBuy', id }),
      say: (text) => net.send({ type: 'worldChat', text }),
    });
  } catch (e) {
    console.error('World failed to load:', e);
  }
});

// --- Market news panel (restored) ---
// NOTE: an earlier "Fix duplicate news panel declarations" commit deleted the ONLY copy of this
// block, leaving the `news` message handler referencing newsFeed/newsPanel/renderNews that no
// longer existed — main hasn't compiled since. Restored here so the build is green again.
const newsBtn = document.getElementById('newsBtn') as HTMLButtonElement;
const newsPanel = document.getElementById('newsPanel') as HTMLDivElement;
const newsBody = document.getElementById('newsBody') as HTMLDivElement;
let newsFeed: NewsItem[] = [];
newsBtn.addEventListener('click', () => {
  const open = newsPanel.hidden;
  newsPanel.hidden = !open;
  newsBtn.setAttribute('aria-expanded', String(open));
  if (open) { if (!newsFeed.length) net.send({ type: 'newsReq' }); renderNews(); }
});
document.addEventListener('click', (e) => {
  if (newsPanel.hidden) return;
  const t = e.target as Node;
  if (t instanceof Node && !t.isConnected) return;
  if (!newsPanel.contains(t) && !newsBtn.contains(t)) { newsPanel.hidden = true; newsBtn.setAttribute('aria-expanded', 'false'); }
});
function renderNews() {
  if (!newsFeed.length) { newsBody.innerHTML = '<div class="news-item" style="color:#5a647e">No news yet. Check back during market hours (M–F 9am–5pm ET).</div>'; return; }
  newsBody.innerHTML = newsFeed.map((item) => {
    const d = new Date(item.ts);
    const time = d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
    return `<div class="news-item"><span class="news-time">${time}</span><span class="news-headline">${escapeHtml(item.headline)}</span></div>`;
  }).join('');
}

// --- House / Fed dashboard ---
const houseBtn = document.getElementById('houseBtn') as HTMLButtonElement;
const housePanel = document.getElementById('housePanel') as HTMLDivElement;
const houseBody = document.getElementById('houseBody') as HTMLDivElement;
let houseState: HouseStateMsg | null = null;
houseBtn.addEventListener('click', () => {
  const open = housePanel.hidden;
  housePanel.hidden = !open;
  houseBtn.setAttribute('aria-expanded', String(open));
  if (open) { net.send({ type: 'houseReq' }); renderHouseDashboard(); } // always refresh on open
});
document.addEventListener('click', (e) => {
  if (housePanel.hidden) return;
  const t = e.target as Node;
  if (t instanceof Node && !t.isConnected) return;
  if (!housePanel.contains(t) && !houseBtn.contains(t)) { housePanel.hidden = true; houseBtn.setAttribute('aria-expanded', 'false'); }
});
function renderHouseDashboard() {
  const s = houseState;
  if (!s) { houseBody.innerHTML = '<div style="color:#5a647e">Loading treasury data…</div>'; return; }
  const c = (n: number) => n.toLocaleString();
  const pct = (r: number) => `${(r * 100).toFixed(r < 0.01 ? 1 : 0)}%`;
  const cap = (u: number) => (u < 0 ? '∞' : c(u));
  const policy = s.tightening
    ? '<span style="color:#ff8a6a">● TIGHTENING</span>'
    : '<span style="color:#6ad19a">● EASING / NEUTRAL</span>';
  const wealthRows = s.wealthBrackets.map((b, i) => {
    const lo = i === 0 ? 0 : s.wealthBrackets[i - 1].upTo;
    return `<tr><td>${cap(lo)} – ${cap(b.upTo)}</td><td>${pct(b.rate)}</td></tr>`;
  }).join('');
  const gainRows = s.capGainBrackets.map((b, i) => {
    const lo = i === 0 ? 0 : s.capGainBrackets[i - 1].upTo;
    return `<tr><td>${cap(lo)} – ${cap(b.upTo)}</td><td>${pct(b.rate)}</td></tr>`;
  }).join('');
  const fastRows = s.fastSell.map((b) => `<tr><td>&lt; ${b.underMin >= 60 ? `${b.underMin / 60}h` : `${b.underMin}m`}</td><td>${pct(b.rate)}</td></tr>`).join('') + '<tr><td>60m+</td><td>0%</td></tr>';
  const idleRows = s.idleTiers.map((t, i) => {
    const next = s.idleTiers[i + 1];
    return `<tr><td>${t.days}${next ? `–${next.days}` : '+'} days</td><td>${pct(t.rate)}</td></tr>`;
  }).join('');
  const fed = s.fedNews.length
    ? s.fedNews.map((n) => {
        const time = new Date(n.ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
        return `<div class="news-item"><span class="news-time">${time}</span><span class="news-headline">${escapeHtml(n.headline.replace('🪙 FED: ', ''))}</span></div>`;
      }).join('')
    : '<div style="color:#5a647e">No Fed statements yet.</div>';
  houseBody.innerHTML = `
    <div class="house-grid">
      <div class="house-card"><h4>🏦 Treasury</h4>
        <div>Balance: <b>${c(s.balance)}🪙</b></div>
        <div>Trickle Fund: <b>${c(s.trickleFund)}🪙</b></div>
        <div>Loan window: <b>${s.loanCapWaived ? '🔓 WAIVED' : '🔒 capped'}</b></div>
      </div>
      <div class="house-card"><h4>📊 Market State</h4>
        <div>Coins in circulation: <b>${c(s.totalCoins)}🪙</b></div>
        <div>Top-5 of players: <b>${s.top5Pct}%</b></div>
        <div>Top-5 of total economy: <b>${s.top5ShareOfTotal}%</b></div>
        <div>Player total: <b>${c(s.playerNetWorthTotal)}🪙</b></div>
        <div>House / Player: <b>${(s.balance / s.playerNetWorthTotal).toFixed(1)}×</b></div>
        <div>Economy total: <b>${c(s.economyTotal)}🪙</b></div>
        <div>Per-stock cap: <b>${s.concentrationCap}%</b></div>
        <div>Broker fee: <b>${s.brokerFeePct.toFixed(1)}%</b></div>
      </div>
      <div class="house-card"><h4>📈 Fed Policy</h4><div>${policy}</div>
        <div style="color:#8aa0d8;font-size:12px;margin-top:4px">Tightens when top 5 hold &gt;40% of all coins, eases when &lt;20%.</div>
      </div>
      <div class="house-card"><h4>💰 Wealth Tax (daily)</h4><table class="house-tbl">${wealthRows}</table></div>
      <div class="house-card"><h4>💹 Capital Gains</h4><table class="house-tbl">${gainRows}</table></div>
      <div class="house-card"><h4>⏱ Fast-Sell Tax</h4><table class="house-tbl">${fastRows}</table></div>
      <div class="house-card"><h4>💤 Idle Decay</h4><table class="house-tbl">${idleRows}</table></div>
      <div class="house-card house-wide"><h4>🏦 Treasury Bonds</h4>
        <div style="color:#8aa0d8;font-size:11px;margin-bottom:6px">Lock coins for a term, collect interest from the House at maturity. Early redemption forfeits interest + 5%.</div>
        <div class="house-bondbuy">
          <input id="bondAmt" type="number" min="100" step="100" placeholder="amount" />
          ${s.bondRates.map((b) => `<button class="house-act" data-act="bond" data-term="${b.termDays}">Buy ${b.termDays}d · ${(b.rate * 100).toFixed(0)}%</button>`).join('')}
        </div>
        ${s.myBonds.length ? `<table class="house-tbl">${s.myBonds.map((b) => {
          const left = b.maturesAt - Date.now();
          const when = left <= 0 ? 'matured ✓' : left > 86400000 ? `${Math.ceil(left / 86400000)}d` : `${Math.ceil(left / 3600000)}h`;
          return `<tr><td>${c(b.amount)}🪙 · ${b.termDays}d @ ${(b.rate * 100).toFixed(0)}% · ${when}</td><td><button class="house-act" data-act="bondw" data-id="${b.id}">redeem</button></td></tr>`;
        }).join('')}</table>` : '<div style="color:#5a647e;font-size:11px">No active bonds.</div>'}
      </div>
      <div class="house-card house-wide"><h4>🔨 Fed Exclusive Auction</h4>
        ${s.auction ? (() => {
          const left = s.auction.endsAt - Date.now();
          const when = left <= 0 ? 'closing…' : left > 3600000 ? `${Math.ceil(left / 3600000)}h left` : `${Math.ceil(left / 60000)}m left`;
          const min = Math.max(s.auction.startBid, s.auction.highBid + 1);
          return `<div><b>${escapeHtml(s.auction.name)}</b> · ${when}</div>
            <div>High bid: <b>${s.auction.highBid ? `${c(s.auction.highBid)}🪙 (${escapeHtml(s.auction.highName ?? '')})` : 'none yet'}</b></div>
            <div class="house-bondbuy"><input id="bidAmt" type="number" min="${min}" step="100" placeholder="min ${c(min)}" /><button class="house-act" data-act="bid">Place bid</button></div>`;
        })() : '<div style="color:#5a647e;font-size:11px">No auction running. The Fed posts one when scarce items are available.</div>'}
      </div>
      <div class="house-card house-wide"><h4>📰 Fed Activity</h4>${fed}</div>
    </div>`;
}
// Delegated controls for the House dashboard (re-rendered each update, so bind once here).
houseBody.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.house-act') as HTMLElement | null;
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'bond') {
    const amt = Math.floor(Number((document.getElementById('bondAmt') as HTMLInputElement)?.value));
    if (amt >= 100) net.send({ type: 'bondBuy', amount: amt, termDays: Number(btn.dataset.term) });
  } else if (act === 'bondw') {
    if (btn.dataset.id) net.send({ type: 'bondWithdraw', id: btn.dataset.id });
  } else if (act === 'bid') {
    const amt = Math.floor(Number((document.getElementById('bidAmt') as HTMLInputElement)?.value));
    if (amt > 0) net.send({ type: 'auctionBid', amount: amt });
  }
});

// --- Arcade & Casino nav dropdowns: group the minigame / economy buttons into menus to keep
// the toolbar tidy. The grouped buttons keep their own IDs and click handlers; these toggles
// just show/hide the popover and close it once an item is picked. ---
const arcadeBtn = document.getElementById('arcadeBtn') as HTMLButtonElement;
const arcadePanel = document.getElementById('arcadePanel') as HTMLDivElement;
const casinoBtn = document.getElementById('casinoBtn') as HTMLButtonElement;
const casinoPanel = document.getElementById('casinoPanel') as HTMLDivElement;
const economyBtn = document.getElementById('economyBtn') as HTMLButtonElement;
const economyPanel = document.getElementById('economyPanel') as HTMLDivElement;
const workMenuBtn = document.getElementById('workMenuBtn') as HTMLButtonElement;
const workMenuPanel = document.getElementById('workMenuPanel') as HTMLDivElement;
function closeNavMenu(btn: HTMLButtonElement, panel: HTMLDivElement) {
  panel.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
}
function toggleNavMenu(btn: HTMLButtonElement, panel: HTMLDivElement) {
  const open = panel.hidden;
  panel.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
}
arcadeBtn.addEventListener('click', () => toggleNavMenu(arcadeBtn, arcadePanel));
casinoBtn.addEventListener('click', () => toggleNavMenu(casinoBtn, casinoPanel));
economyBtn.addEventListener('click', () => toggleNavMenu(economyBtn, economyPanel));
workMenuBtn.addEventListener('click', () => toggleNavMenu(workMenuBtn, workMenuPanel));
// Picking an item closes its menu — the launched minigame / opened panel takes over from there.
arcadePanel.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button')) closeNavMenu(arcadeBtn, arcadePanel); });
casinoPanel.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button')) closeNavMenu(casinoBtn, casinoPanel); });
economyPanel.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button')) closeNavMenu(economyBtn, economyPanel); });
workMenuPanel.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('button')) closeNavMenu(workMenuBtn, workMenuPanel); });
document.addEventListener('click', (e) => {
  const t = e.target as Node;
  if (!arcadePanel.hidden && !arcadeBtn.contains(t) && !arcadePanel.contains(t)) closeNavMenu(arcadeBtn, arcadePanel);
  if (!casinoPanel.hidden && !casinoBtn.contains(t) && !casinoPanel.contains(t)) closeNavMenu(casinoBtn, casinoPanel);
  if (!economyPanel.hidden && !economyBtn.contains(t) && !economyPanel.contains(t)) closeNavMenu(economyBtn, economyPanel);
  if (!workMenuPanel.hidden && !workMenuBtn.contains(t) && !workMenuPanel.contains(t)) closeNavMenu(workMenuBtn, workMenuPanel);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!arcadePanel.hidden) closeNavMenu(arcadeBtn, arcadePanel);
  if (!casinoPanel.hidden) closeNavMenu(casinoBtn, casinoPanel);
  if (!economyPanel.hidden) closeNavMenu(economyBtn, economyPanel);
  if (!workMenuPanel.hidden) closeNavMenu(workMenuBtn, workMenuPanel);
});

// --- Coins, cosmetics shop & betting ---
let wallet: { coins: number; owned: string[]; hat: string | null; skin: string | null; trail: string | null; title: string | null; song: string | null; car: string | null; pet: string | null; exclusives: { id: string; serial: number; instanceId: number }[]; bets: Array<{ side: Side; amount: number; odds: number }>; nextSpinAt: number; bonusSpins: number } =
  { coins: 0, owned: [], hat: null, skin: null, trail: null, title: null, song: null, car: null, pet: null, exclusives: [], bets: [], nextSpinAt: 0, bonusSpins: 0 };
let betAmount = 100; // default wager (economy is scaled ×100); min is still 1
let shopTab: 'hat' | 'skin' | 'trail' | 'title' | 'song' | 'car' | 'pet' = 'hat';
const shopBtn = document.getElementById('shopBtn') as HTMLButtonElement;
const shopPanel = document.getElementById('shopPanel') as HTMLDivElement;
const coinCount = document.getElementById('coinCount') as HTMLSpanElement;
const shopCoins = document.getElementById('shopCoins') as HTMLSpanElement;
const shopItems = document.getElementById('shopItems') as HTMLDivElement;
const tabHats = document.getElementById('tabHats') as HTMLButtonElement;
const tabSkins = document.getElementById('tabSkins') as HTMLButtonElement;
const tabTrails = document.getElementById('tabTrails') as HTMLButtonElement;
const tabTitles = document.getElementById('tabTitles') as HTMLButtonElement;
const tabSongs = document.getElementById('tabSongs') as HTMLButtonElement;
const tabCars = document.getElementById('tabCars') as HTMLButtonElement;
const tabPets = document.getElementById('tabPets') as HTMLButtonElement;
const shopTabs = [tabHats, tabSkins, tabTrails, tabTitles, tabSongs, tabCars, tabPets];
function selectShopTab(tab: 'hat' | 'skin' | 'trail' | 'title' | 'song' | 'car' | 'pet', el: HTMLButtonElement) {
  shopTab = tab;
  for (const t of shopTabs) t.classList.toggle('active', t === el);
  renderShop();
}
tabHats.addEventListener('click', () => selectShopTab('hat', tabHats));
tabSkins.addEventListener('click', () => selectShopTab('skin', tabSkins));
tabTrails.addEventListener('click', () => selectShopTab('trail', tabTrails));
tabTitles.addEventListener('click', () => selectShopTab('title', tabTitles));
tabSongs.addEventListener('click', () => selectShopTab('song', tabSongs));
tabCars.addEventListener('click', () => selectShopTab('car', tabCars));
tabPets.addEventListener('click', () => selectShopTab('pet', tabPets));
const spinBtn = document.getElementById('spinBtn') as HTMLButtonElement;
let spinning = false; // a spin animation is currently playing
spinBtn.addEventListener('click', () => {
  const onCooldown = !!wallet.nextSpinAt && wallet.nextSpinAt > Date.now();
  if (spinning || (onCooldown && wallet.bonusSpins <= 0)) return;
  spinning = true;
  spinBtn.disabled = true;
  net.send({ type: 'dailySpin' });
});
const betSection = document.getElementById('betSection') as HTMLDivElement;
const betAmountEl = document.getElementById('betAmount') as HTMLInputElement;
const betStatus = document.getElementById('betStatus') as HTMLDivElement;
const betLeftName = document.getElementById('betLeftName') as HTMLSpanElement;
const betRightName = document.getElementById('betRightName') as HTMLSpanElement;
const betLeftOdds = document.getElementById('betLeftOdds') as HTMLElement;
const betRightOdds = document.getElementById('betRightOdds') as HTMLElement;

shopBtn.addEventListener('click', () => {
  const open = shopPanel.hidden;
  shopPanel.hidden = !open;
  shopBtn.setAttribute('aria-expanded', String(open));
  if (open) renderShop();
});
document.addEventListener('click', (e) => {
  if (shopPanel.hidden) return;
  const t = e.target as Node;
  if (!shopPanel.contains(t) && !shopBtn.contains(t)) { shopPanel.hidden = true; shopBtn.setAttribute('aria-expanded', 'false'); }
});

// Build the shop rows (buy / equip / unequip) + the betting section from the current wallet.
// Keep track of preview canvases so the animation loop can repaint them.
const shopPreviewCanvases: { canvas: HTMLCanvasElement; id: string; slot: 'hat' | 'skin' | 'trail' }[] = [];

function renderShop() {
  coinCount.textContent = String(wallet.coins);
  shopCoins.textContent = String(wallet.coins);
  updateSpinButton();
  shopItems.innerHTML = '';
  shopPreviewCanvases.length = 0;
  for (const item of COSMETICS) {
    if (item.slot !== shopTab) continue; // show only the active tab's items
    const owned = wallet.owned.includes(item.id);
    const equipped = (item.slot === 'hat' ? wallet.hat : item.slot === 'skin' ? wallet.skin : item.slot === 'trail' ? wallet.trail : item.slot === 'song' ? wallet.song : item.slot === 'car' ? wallet.car : item.slot === 'pet' ? wallet.pet : wallet.title) === item.id;
    const row = document.createElement('div');
    row.className = 'shop-row';
    // Titles are text flair and songs are audio — neither has a paddle preview. Songs get a ▶
    // button to audition the clip; cars get a colored swatch; other slots get a live preview canvas.
    if (item.slot === 'song') {
      const play = document.createElement('button');
      play.className = 'shop-preview-song';
      play.textContent = '▶';
      play.title = `Preview ${item.name}`;
      play.onclick = () => previewSong(item.audio ?? '');
      row.appendChild(play);
    } else if (item.slot === 'car') {
      const car = carById(item.id);
      const sw = document.createElement('span');
      sw.className = 'shop-preview-car';
      sw.style.cssText = `display:inline-block;width:28px;height:18px;border-radius:4px;background:${car?.body ?? '#888'};border:2px solid ${car?.accent ?? '#222'};`;
      sw.title = car ? `top speed ${car.speed}, grip ${car.grip}` : '';
      row.appendChild(sw);
    } else if (item.slot === 'pet') {
      // Pets show their emoji as the row preview (the look lives in PETS, keyed by id).
      const sw = document.createElement('span');
      sw.className = 'shop-preview-pet';
      sw.style.cssText = 'display:inline-block;width:28px;text-align:center;font-size:20px;line-height:1;';
      sw.textContent = petById(item.id)?.emoji ?? '🐾';
      row.appendChild(sw);
    } else if (item.slot !== 'title') {
      const preview = document.createElement('canvas') as HTMLCanvasElement;
      preview.width = 28; preview.height = 52;
      preview.className = 'shop-preview';
      drawCosmeticPreview(preview, item.id, item.slot);
      shopPreviewCanvases.push({ canvas: preview, id: item.id, slot: item.slot as 'hat' | 'skin' | 'trail' });
      row.appendChild(preview);
    }
    const name = document.createElement('span');
    name.className = 'shop-name';
    const priceSuffix = owned || item.locked ? '' : ` · ${item.price}🪙`;
    if (item.id === 'opstask') {
      // Show this title with its live animated rainbow font as its own shop preview.
      name.innerHTML = `<span class="rainbow-text">${item.name}</span>${priceSuffix}`;
    } else {
      name.textContent = item.name + priceSuffix;
    }
    row.appendChild(name);
    const btn = document.createElement('button');
    if (!owned && item.locked) {
      // Locked items (e.g. Davis Slayer) can't be bought — unlocked by an achievement.
      btn.textContent = '🔒 Campaign';
      btn.disabled = true;
      btn.title = 'Clear the campaign to unlock';
    } else if (!owned) {
      btn.textContent = 'Buy';
      btn.disabled = wallet.coins < item.price;
      btn.onclick = () => { net.send({ type: 'shopBuy', item: item.id }); playChaChing(); };
    } else {
      btn.textContent = equipped ? 'Unequip' : 'Equip';
      if (equipped) btn.classList.add('equipped');
      btn.onclick = () => net.send({ type: 'shopEquip', slot: item.slot, item: equipped ? null : item.id });
    }
    row.appendChild(btn);
    shopItems.appendChild(row);
  }
  syncBetSection();
}

// Lightweight: only updates the betting section (no item-list rebuild). Safe to call every
// tick — rebuilding the item DOM each frame was eating Buy clicks.
function syncBetSection() {
  // Live betting: open to spectators any time a (non-arena, non-bot) duel is in play.
  const canBet = !!state && state.status === 'playing' && !state.poly && myRole === 'observer' && !state.bot;
  betSection.hidden = !canBet;
  if (!canBet || !state) return;
  // The stake is a positive whole number no lower than the wealth-scaled minimum.
  // We deliberately DON'T cap it to the wallet here — typing more than you have surfaces the
  // "insufficient funds" hint below rather than being silently swallowed. Don't clobber the
  // field while it's being edited.
  const min = minBet(wallet.coins);
  betAmount = Math.max(min, Math.floor(betAmount) || min);
  if (document.activeElement !== betAmountEl) betAmountEl.value = String(betAmount);
  betAmountEl.max = String(Math.max(1, wallet.coins));
  betAmountEl.min = String(min);
  // Side labels + live odds on the buttons.
  const odds = state.odds; // { left, right } | null
  betLeftName.textContent = state.paddles.left.name ?? 'Left';
  betRightName.textContent = state.paddles.right.name ?? 'Right';
  betLeftOdds.textContent = odds ? `${odds.left.toFixed(2)}×` : '—';
  betRightOdds.textContent = odds ? `${odds.right.toFixed(2)}×` : '—';
  // Multiple bets are allowed in live betting — gate on affordability (and on having live odds).
  const affordable = wallet.coins >= betAmount;
  betLeftBtn.disabled = !affordable || !odds;
  betRightBtn.disabled = !affordable || !odds;
  // Status line: insufficient-funds hint takes priority, then your open wagers, then a preview.
  const payout = (amt: number, o: number) => Math.max(amt, Math.round(amt * o));
  betStatus.classList.toggle('warn', !affordable);
  if (!affordable) {
    betStatus.textContent = `💸 Insufficient funds — you have ${wallet.coins}🪙. Consider taking out a loan from Davis.`;
  } else if (wallet.bets.length) {
    const mine = wallet.bets
      .map((b) => `${b.amount}🪙 on ${b.side} @ ${b.odds.toFixed(2)}× → ${payout(b.amount, b.odds)}🪙`)
      .join('  ·  ');
    betStatus.textContent = `Your bets: ${mine}`;
  } else if (odds) {
    betStatus.textContent = `${betAmount}🪙 wins ${payout(betAmount, odds.left)}🪙 (left) / ${payout(betAmount, odds.right)}🪙 (right)`;
  } else {
    betStatus.textContent = '';
  }
}

const betLeftBtn = document.getElementById('betLeft') as HTMLButtonElement;
const betRightBtn = document.getElementById('betRight') as HTMLButtonElement;
document.getElementById('betMinus')!.addEventListener('click', () => { betAmount = Math.max(minBet(wallet.coins), betAmount - 1); syncBetSection(); });
document.getElementById('betPlus')!.addEventListener('click', () => { betAmount = Math.min(Math.max(minBet(wallet.coins), wallet.coins), betAmount + 1); syncBetSection(); });
// Free-type a specific stake. Parse to a positive integer; empty/garbage falls back to 1.
betAmountEl.addEventListener('input', () => {
  const v = parseInt(betAmountEl.value, 10);
  const min = minBet(wallet.coins);
  betAmount = Number.isFinite(v) ? Math.max(min, v) : min;
  syncBetSection();
});
// Normalize the field on blur (e.g. snap a half-typed value back to its parsed number).
betAmountEl.addEventListener('blur', () => { betAmountEl.value = String(betAmount); });
betLeftBtn.addEventListener('click', () => net.send({ type: 'bet', side: 'left', amount: betAmount }));
betRightBtn.addEventListener('click', () => net.send({ type: 'bet', side: 'right', amount: betAmount }));

// Daily-spin button: bright pink + flashing when a spin is ready; otherwise a live countdown.
function updateSpinButton() {
  if (spinning) { spinBtn.textContent = '🎰 Spinning…'; spinBtn.disabled = true; spinBtn.classList.remove('ready'); return; }
  const ms = wallet.nextSpinAt - Date.now();
  const dailyReady = !wallet.nextSpinAt || ms <= 0;
  const bonus = wallet.bonusSpins > 0;
  const ready = dailyReady || bonus;
  spinBtn.disabled = !ready;
  spinBtn.classList.toggle('ready', ready);
  if (bonus) {
    // Bonus spins (from tournament wins) take priority and ignore the daily cooldown.
    spinBtn.textContent = wallet.bonusSpins > 1 ? `🏆 BONUS SPIN! (${wallet.bonusSpins})` : '🏆 BONUS SPIN!';
  } else if (dailyReady) {
    spinBtn.textContent = '🎰 DAILY SPIN — FREE!';
  } else {
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    spinBtn.textContent = `🎰 Next spin in ${h}h ${m}m`;
  }
}
setInterval(updateSpinButton, 1000);

// The spinning reel: a horizontal strip of the wheel segments that scrolls and eases to a
// stop with the won segment under the center pointer, then reveals the prize + plays "yay".
function celebrateSpin(reward: { kind: 'coins'; amount: number } | { kind: 'item'; item: string; name: string }, segment: number) {
  const CW = 104; // card width incl. gap
  const VIS = 5;  // visible cards
  const VW = CW * VIS;
  const colors = ['#ff5c5c', '#ffd166', '#6ee7a8', '#7da2ff', '#e040fb', '#ff922b', '#4dd2ff', '#b197fc'];

  const back = document.createElement('div');
  back.style.cssText =
    'position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:18px;background:rgba(4,6,13,0.88);';
  const heading = document.createElement('div');
  heading.textContent = '🎰 DAILY SPIN';
  heading.style.cssText = 'font:900 30px ui-monospace,monospace;color:#ff5cc8;text-shadow:0 2px 0 #000;';
  const viewport = document.createElement('div');
  viewport.style.cssText =
    `position:relative;width:${VW}px;max-width:92vw;height:96px;overflow:hidden;border-radius:12px;` +
    'border:2px solid #ff5cc8;background:#0a0e1c;box-shadow:0 0 24px rgba(255,92,200,0.4);';
  const strip = document.createElement('div');
  strip.style.cssText = 'position:absolute;top:8px;left:0;display:flex;will-change:transform;';
  const LOOPS = 16;
  for (let i = 0; i < LOOPS * SPIN_SEGMENTS.length; i++) {
    const seg = SPIN_SEGMENTS[i % SPIN_SEGMENTS.length];
    const card = document.createElement('div');
    card.style.cssText =
      `flex:0 0 ${CW - 8}px;margin:0 4px;height:80px;border-radius:10px;display:flex;align-items:center;` +
      `justify-content:center;text-align:center;font:800 16px ui-monospace,monospace;color:#1a1020;` +
      `background:${colors[i % SPIN_SEGMENTS.length]};`;
    card.textContent = seg.label;
    strip.appendChild(card);
  }
  viewport.appendChild(strip);
  // center pointer
  const pointer = document.createElement('div');
  pointer.style.cssText =
    `position:absolute;top:0;bottom:0;left:${VW / 2 - 2}px;width:4px;background:#fff;` +
    'box-shadow:0 0 8px #fff;pointer-events:none;';
  viewport.appendChild(pointer);
  const prize = document.createElement('div');
  prize.style.cssText = 'font:800 20px ui-monospace,monospace;color:#ffd166;min-height:24px;text-align:center;';
  back.append(heading, viewport, prize);
  document.body.appendChild(back);

  // Land the chosen segment, many loops in, centered under the pointer.
  const landIndex = (LOOPS - 3) * SPIN_SEGMENTS.length + segment;
  const startX = -(2 * SPIN_SEGMENTS.length + segment) * CW + (VW / 2 - CW / 2);
  const endX = -(landIndex * CW) + (VW / 2 - CW / 2);
  strip.style.transform = `translateX(${startX}px)`;
  // Wait for the start frame to actually paint, then apply the transition to the end — a
  // double-rAF is reliable where a synchronous reflow can get coalesced away (no animation).
  requestAnimationFrame(() => requestAnimationFrame(() => {
    strip.style.transition = 'transform 4s cubic-bezier(0.16, 0.84, 0.12, 1)';
    strip.style.transform = `translateX(${endX}px)`;
  }));

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    spinning = false;
    updateSpinButton();
    playYay();
    prize.textContent = reward.kind === 'coins' ? `You won ${reward.amount} 🪙!` : `You won a free ${reward.name}! 🎉`;
    // brief confetti-ish flash on the viewport
    viewport.style.boxShadow = '0 0 40px rgba(255,209,102,0.8)';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Nice!';
    closeBtn.style.cssText =
      'font:800 15px ui-monospace,monospace;padding:9px 26px;border-radius:8px;cursor:pointer;' +
      'border:none;background:#ff5cc8;color:#1a1020;';
    closeBtn.addEventListener('click', () => back.remove());
    back.appendChild(closeBtn);
  };
  strip.addEventListener('transitionend', finish, { once: true });
  setTimeout(finish, 4500); // safety net if transitionend doesn't fire
}

// A transient notice. By default a big center-screen banner (e.g. a forfeit); `toast: true`
// shows a small, stacking corner toast instead (betting activity, bet results).
function showAnnouncement(text: string, opts?: { color?: string; toast?: boolean }) {
  if (opts?.toast) { showToast(text); return; }
  const el = document.createElement('div');
  el.className = 'announce-banner';
  el.textContent = text;
  if (opts?.color) el.style.color = opts.color;
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

// Small, unobtrusive toast in the bottom-right corner; multiple stack and auto-dismiss.
// Rolling "Recent bets" log in the chat column: keeps the last few bet events (placements +
// results) on screen, newest on top, instead of flashing away — so you can glance back at what
// just happened.
const betLogList = document.getElementById('betLogList') as HTMLDivElement;
const BET_LOG_MAX = 5;
function showToast(text: string) {
  betLogList.querySelector('.bet-log-empty')?.remove();
  const el = document.createElement('div');
  el.className = 'bet-log-entry';
  el.textContent = text;
  betLogList.prepend(el); // newest on top
  while (betLogList.children.length > BET_LOG_MAX) betLogList.lastElementChild?.remove();
  el.animate(
    [{ opacity: 0, transform: 'translateX(10px)' }, { opacity: 1, transform: 'translateX(0)' }],
    { duration: 240, easing: 'ease-out' },
  );
}

// --- Crypto market dropdown (top-left): invest coins into 5 joke cryptos ---
// The server owns the global price board and each player's positions; we just render the
// latest `stocks` message and fire invest/cash-out requests. The cash-out number we show is
// round(worth) — nearest whole coin — exactly what the server pays out.
type Market = {
  prices: { id: string; price: number; prev: number; flow?: number }[];
  holdings: { id: string; side: StockSide; shares: number; cost: number; worth: number; openedAt: number }[];
  history: { id: string; series: Record<StockTf, number[]> }[];
  nextUpdateAt: number;
};
let market: Market = { prices: [], holdings: [], history: [], nextUpdateAt: 0 };
const marketBtn = document.getElementById('marketBtn') as HTMLButtonElement;
const marketPanel = document.getElementById('marketPanel') as HTMLDivElement;
const marketCoins = document.getElementById('marketCoins') as HTMLSpanElement;
const marketTimer = document.getElementById('marketTimer') as HTMLDivElement;
const marketList = document.getElementById('marketList') as HTMLDivElement;
// Per-coin "amount to invest" steppers, kept across re-renders so the value doesn't reset
// when prices re-roll. Defaults to 1.
const investAmt = new Map<string, number>();
// Which timeframe the little graphs show — shared across all coins (see STOCK_HISTORY for
// each one's span/resolution).
let graphTf: StockTf = '1h';

marketBtn.addEventListener('click', () => {
  const open = marketPanel.hidden;
  marketPanel.hidden = !open;
  marketBtn.setAttribute('aria-expanded', String(open));
  if (open) renderMarket();
});
// Timeframe toggle (delegated, since the buttons live in the static panel header).
document.getElementById('marketGraphTf')?.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tf]');
  if (!btn) return;
  graphTf = btn.dataset.tf as StockTf;
  document.querySelectorAll('#marketGraphTf button').forEach((b) => b.classList.toggle('active', b === btn));
  renderMarket();
});

// Draw a tiny sparkline of `pts` into `cv`. Flat/scarce data → a faint baseline. Colored by
// net change over the window (green up, red down).
function drawSparkline(cv: HTMLCanvasElement, pts: number[]) {
  const ctx2 = cv.getContext('2d');
  if (!ctx2) return;
  const w = cv.width, h = cv.height, pad = 2;
  ctx2.clearRect(0, 0, w, h);
  if (pts.length < 2) {
    ctx2.strokeStyle = '#2a3550';
    ctx2.beginPath(); ctx2.moveTo(pad, h / 2); ctx2.lineTo(w - pad, h / 2); ctx2.stroke();
    return;
  }
  let lo = Math.min(...pts), hi = Math.max(...pts);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; } // flat line → center it
  const up = pts[pts.length - 1] >= pts[0];
  const x = (i: number) => pad + (i / (pts.length - 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad);
  ctx2.strokeStyle = up ? '#6ee7a8' : '#ff7a7a';
  ctx2.lineWidth = 1.5;
  ctx2.beginPath();
  pts.forEach((v, i) => (i ? ctx2.lineTo(x(i), y(v)) : ctx2.moveTo(x(i), y(v))));
  ctx2.stroke();
}

// The price series to plot for a coin at the current timeframe (each timeframe is its own
// server-side series, sampled at its own cadence — see STOCK_HISTORY).
function seriesFor(id: string): number[] {
  const h = market.history.find((x) => x.id === id);
  return h ? h.series[graphTf] ?? [] : [];
}
document.addEventListener('click', (e) => {
  if (marketPanel.hidden) return;
  const t = e.target as Node;
  // A click that removed its own target from the DOM (e.g. a re-render) lands here with a
  // detached node, which is "not contained" — ignore it so the panel doesn't snap shut.
  if (t instanceof Node && !t.isConnected) return;
  if (!marketPanel.contains(t) && !marketBtn.contains(t)) { marketPanel.hidden = true; marketBtn.setAttribute('aria-expanded', 'false'); }
});

// Fast-sell tax countdown. Uses FAST_SELL_BRACKETS from shared/types — the same source the
// server uses — so the countdown is always accurate without needing houseState to be loaded.
function taxBadge(openedAt: number): { text: string; cls: string } {
  if (!openedAt) return { text: '✅ tax-free', cls: 'tax-free' };
  const heldMs = Date.now() - openedAt;
  for (const b of FAST_SELL_BRACKETS) {
    if (heldMs < b.underMs) {
      const left = b.underMs - heldMs;
      const secs = Math.ceil(left / 1000);
      const clock = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : `${secs}s`;
      return { text: `🔒 ${Math.round(b.rate * 100)}% tax · drops in ${clock}`, cls: 'tax-wait' };
    }
  }
  return { text: '✅ tax-free', cls: 'tax-free' };
}

function renderMarket() {
  marketCoins.textContent = String(wallet.coins);
  marketList.innerHTML = '';
  for (const stock of STOCKS) {
    const p = market.prices.find((x) => x.id === stock.id);
    // A coin can carry both a long and a short position at once.
    const longPos = market.holdings.find((x) => x.id === stock.id && x.side === 'long');
    const shortPos = market.holdings.find((x) => x.id === stock.id && x.side === 'short');
    const price = p?.price ?? stock.base;
    // Headline % is the move over the SELECTED timeframe (first → last of the visible graph),
    // so it changes when you switch Minutes / Hour / Day — not a static per-tick number.
    const series = seriesFor(stock.id);
    const last = series.length ? series[series.length - 1] : price;
    const first = series.length >= 2 ? series[0] : last;
    const pct = first > 0 ? ((last - first) / first) * 100 : 0;

    const row = document.createElement('div');
    row.className = 'coin-row';

    const logo = document.createElement('img');
    logo.className = 'coin-logo';
    logo.src = stock.img;
    logo.alt = stock.name;
    row.appendChild(logo);

    const main = document.createElement('div');
    main.className = 'coin-main';
    const name = document.createElement('div');
    name.className = 'coin-name';
    name.textContent = stock.name;
    const supply = document.createElement('span');
    supply.className = 'coin-supply';
    supply.textContent = `${stock.supply.toLocaleString()} circ.`;
    name.appendChild(supply);
    main.appendChild(name);
    const priceLine = document.createElement('div');
    priceLine.className = 'coin-price';
    const dir = pct > 0.01 ? 'up' : pct < -0.01 ? 'down' : 'flat';
    const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '•';
    // Order-flow tint: a small ▲/▼ from the server-reported net pressure sign (buy- vs sell-heavy).
    const flow = p?.flow ?? 0;
    const flowTag = flow > 0 ? '<span class="coin-flow up" title="buy pressure">▲</span>'
      : flow < 0 ? '<span class="coin-flow down" title="sell pressure">▼</span>' : '';
    priceLine.innerHTML = `${price.toFixed(2)} 🪙<span class="coin-chg ${dir}">${arrow} ${Math.abs(pct).toFixed(1)}%</span>${flowTag}`;
    main.appendChild(priceLine);
    // One read-out line per open position. A long profits as the price rises; a short profits
    // as it falls — and goes negative (covering costs coins) once the price passes its entry.
    const posLine = (hold: typeof longPos & {}) => {
      const rawWorth = positionWorth(hold.side, hold.shares, hold.cost, price);
      const cashOut = Math.round(rawWorth);
      const plPct = hold.cost > 0 ? (rawWorth / hold.cost - 1) * 100 : 0;
      const plClass = plPct > 0.05 ? 'pl-up' : plPct < -0.05 ? 'pl-down' : '';
      const sign = plPct >= 0 ? '+' : '';
      const tag = hold.side === 'short' ? '<span class="pos-short">SHORT</span> ' : '';
      const verb = hold.side === 'short' ? 'cover' : 'cash out';
      // A negative worth means closing costs you coins instead of paying out.
      const closeTxt = cashOut >= 0 ? `${verb} ${cashOut}` : `${verb} costs ${-cashOut}`;
      const div = document.createElement('div');
      div.className = 'coin-pos';
      div.innerHTML = `${tag}${hold.cost}🪙 → <span class="${plClass}">${rawWorth.toFixed(2)}🪙 (${sign}${plPct.toFixed(0)}%)</span> · ${closeTxt}`;
      // Live fast-sell-tax countdown, refreshed every second by updateMarketTimer.
      const badge = taxBadge(hold.openedAt);
      const taxEl = document.createElement('span');
      taxEl.className = `pos-tax ${badge.cls}`;
      taxEl.dataset.opened = String(hold.openedAt);
      taxEl.textContent = ` · ${badge.text}`;
      div.appendChild(taxEl);
      return div;
    };
    if (longPos) main.appendChild(posLine(longPos));
    if (shortPos) main.appendChild(posLine(shortPos));
    const graph = document.createElement('canvas');
    graph.className = 'coin-graph';
    graph.width = 176; graph.height = 26;
    drawSparkline(graph, series);
    main.appendChild(graph);
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'coin-actions';
    const buy = document.createElement('div');
    buy.className = 'coin-buy';
    let amt = investAmt.get(stock.id) ?? 100;
    amt = Math.max(1, Math.min(amt, Math.max(1, wallet.coins)));
    investAmt.set(stock.id, amt);
    const minus = document.createElement('button');
    minus.textContent = '−';
    // Typable amount: the player can key in any number, or nudge it with −/+. Defaults to 100.
    const amtEl = document.createElement('input');
    amtEl.type = 'number';
    amtEl.min = '1';
    amtEl.step = '1';
    amtEl.className = 'coin-amt';
    amtEl.setAttribute('inputmode', 'numeric');
    amtEl.value = String(amt);
    const plus = document.createElement('button');
    plus.textContent = '+';
    buy.append(minus, amtEl, plus);
    actions.appendChild(buy);

    // Open-position buttons: Buy (long) and Short, both staking the stepper amount.
    const trade = document.createElement('div');
    trade.className = 'coin-trade';
    const invest = document.createElement('button');
    invest.className = 'coin-long';
    invest.textContent = 'Buy';
    invest.disabled = wallet.coins < amt;
    invest.onclick = () => { net.send({ type: 'stockInvest', coin: stock.id, amount: investAmt.get(stock.id) ?? 100, side: 'long' }); playChaChing(); };
    const short = document.createElement('button');
    short.className = 'coin-shortbtn';
    short.textContent = 'Short';
    short.disabled = wallet.coins < amt;
    short.onclick = () => { net.send({ type: 'stockInvest', coin: stock.id, amount: investAmt.get(stock.id) ?? 100, side: 'short' }); playChaChing(); };
    trade.append(invest, short);
    actions.appendChild(trade);

    // Step/commit the amount in place (don't re-render) — rebuilding the row would detach the very
    // button that was clicked and trip the click-outside handler, closing the whole panel.
    const setAmt = (v: number) => {
      const clamped = Math.max(1, Math.min(v, Math.max(1, wallet.coins)));
      investAmt.set(stock.id, clamped);
      amtEl.value = String(clamped);
      invest.disabled = short.disabled = wallet.coins < clamped;
    };
    // Track what they type live (so the buttons gate correctly); normalize/clamp on commit (blur/Enter).
    amtEl.addEventListener('input', () => {
      const v = Math.floor(Number(amtEl.value));
      const valid = Number.isFinite(v) && v >= 1;
      investAmt.set(stock.id, valid ? v : 1);
      invest.disabled = short.disabled = !valid || wallet.coins < v;
    });
    amtEl.addEventListener('change', () => setAmt(Math.floor(Number(amtEl.value)) || 1));
    minus.onclick = () => setAmt((investAmt.get(stock.id) ?? 100) - 1);
    plus.onclick = () => setAmt((investAmt.get(stock.id) ?? 100) + 1);

    // Close-position buttons: only shown for the side(s) actually held.
    if (longPos) {
      const cash = document.createElement('button');
      cash.className = 'coin-cash';
      cash.textContent = `Cash out ${Math.round(positionWorth('long', longPos.shares, longPos.cost, price))}🪙`;
      cash.onclick = () => { net.send({ type: 'stockCashOut', coin: stock.id, side: 'long' }); playChaChing(); };
      actions.appendChild(cash);
    }
    if (shortPos) {
      const cover = document.createElement('button');
      cover.className = 'coin-cover';
      const cv = Math.round(positionWorth('short', shortPos.shares, shortPos.cost, price));
      cover.textContent = cv >= 0 ? `Cover ${cv}🪙` : `Cover (pay ${-cv}🪙)`;
      cover.onclick = () => { net.send({ type: 'stockCashOut', coin: stock.id, side: 'short' }); playChaChing(); };
      actions.appendChild(cover);
    }

    row.appendChild(actions);
    marketList.appendChild(row);
  }
}

// Live countdown to the next price re-roll (the panel can stay open across a move), plus the
// per-position fast-sell-tax countdowns.
function updateMarketTimer() {
  if (marketPanel.hidden) return;
  // Refresh each open position's tax-window badge in place (no full re-render).
  for (const el of marketList.querySelectorAll<HTMLElement>('.pos-tax')) {
    const badge = taxBadge(Number(el.dataset.opened));
    el.textContent = ` · ${badge.text}`;
    el.className = `pos-tax ${badge.cls}`;
  }
  const ms = market.nextUpdateAt - Date.now();
  if (!market.nextUpdateAt || ms <= 0) { marketTimer.textContent = 'next move: any moment…'; return; }
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  marketTimer.textContent = `next move in ${m}:${String(s).padStart(2, '0')}`;
}
setInterval(updateMarketTimer, 1000);

// --- Market Stability bar (top of the chat column) ---
// Fills with the total unpaid (defaulted) loan debt; at 100% the whole market crashes. The
// server sends the latest pool on every `stocks` message (join, trades, re-rolls, collection).
const marketStability = document.getElementById('marketStability') as HTMLDivElement;
const msFill = document.getElementById('msFill') as HTMLDivElement;
const msPct = document.getElementById('msPct') as HTMLSpanElement;
const msInfo = document.getElementById('msInfo') as HTMLButtonElement;
const msInfoPop = document.getElementById('msInfoPop') as HTMLDivElement;
msInfo.addEventListener('click', (e) => { e.stopPropagation(); msInfoPop.hidden = !msInfoPop.hidden; });
// Click the stability bar (anywhere but the info button) to open the public loan book.
marketStability.addEventListener('click', (e) => {
  if (msInfo.contains(e.target as Node)) return; // the ⓘ button is its own thing
  net.send({ type: 'loanBookReq' });
});
function renderStability(s: { unpaid: number; threshold: number } | undefined) {
  if (!s || !(s.threshold > 0)) return;
  marketStability.hidden = false;
  const frac = Math.max(0, Math.min(1, s.unpaid / s.threshold));
  const pct = Math.round(frac * 100);
  msFill.style.width = `${frac * 100}%`;
  // Green (stable) → red (about to crash) as the bar fills.
  msFill.style.backgroundColor = `hsl(${Math.round(140 * (1 - frac))} 70% 52%)`;
  msPct.textContent = `${Math.round(s.unpaid).toLocaleString()} / ${s.threshold.toLocaleString()} 🪙 · ${pct}%`;
}

// --- Economy Overhaul: House treasury readout ---
// The server broadcasts the House balance on join + whenever it changes. The treasury funds most
// payouts; when it runs low, payouts are throttled (housePay), so we show a "payouts reduced" note.
let houseBalance = 0;
const HOUSE_LOW = 250_000; // below this, the throttle is likely biting — warn the player
const houseReadout = document.getElementById('houseReadout') as HTMLDivElement | null;
function renderHouse() {
  if (!houseReadout) return;
  const low = houseBalance < HOUSE_LOW;
  houseReadout.innerHTML = `🏦 House: <b>${Math.round(houseBalance).toLocaleString()}</b> 🪙` +
    (low ? ` <span class="house-low">payouts reduced</span>` : '');
}

// --- Loot boxes (top-left panel; reuses the spin/celebrate reveal) ---
const lootBtn = document.getElementById('lootBtn') as HTMLButtonElement | null;
const lootPanel = document.getElementById('lootPanel') as HTMLDivElement;
const lootBody = document.getElementById('lootBody') as HTMLDivElement;
const LOOT_PRICE = 2500;       // mirror of server's Lobby.LOOT_PRICE (display only)
let lootBusy = false;
let lootTimer: number | undefined; // clears a hung "Opening…" if no lootResult arrives
let lootRevealHtml = ''; // last prize reveal, kept across re-renders (wallet/house/market updates
                         // re-run renderLoot right after an open and would otherwise wipe it)
function renderLoot() {
  const canAfford = wallet.coins >= LOOT_PRICE;
  const mine = wallet.exclusives;
  const owned = mine.length
    ? `<div class="loot-owned"><b>Your exclusives:</b> ${mine.map((e) => {
        const def = EXCLUSIVES.find((x) => x.id === e.id);
        return `<span class="loot-badge">${escapeHtml(def?.name ?? e.id)} <span class="loot-serial">#${e.serial}</span></span>`;
      }).join(' ')}</div>`
    : '';
  const W = LOOT_TABLE;
  const totalW = W.cosmeticWeight + W.exclusiveWeight + W.coinBackWeight + W.nothingWeight;
  const pct = (w: number) => ((w / totalW) * 100).toFixed(1);
  lootBody.innerHTML = `
    <div class="loot-blurb">Spend ${LOOT_PRICE.toLocaleString()}🪙 to crack a box — you get one of:</div>
    <table class="loot-odds">
      <tr><td>${pct(W.cosmeticWeight)}%</td><td>🎨 Common cosmetic</td><td>hat / skin / trail</td></tr>
      <tr><td>${pct(W.exclusiveWeight)}%</td><td>✨ Scarce exclusive</td><td>hard mint cap · some 1-of-1</td></tr>
      <tr><td>${pct(W.coinBackWeight)}%</td><td>🪙 Coin back</td><td>${W.coinBackMin.toLocaleString()}–${W.coinBackMax.toLocaleString()} coins</td></tr>
      <tr><td>${pct(W.nothingWeight)}%</td><td>🫥 Nothing</td><td>the house thanks you</td></tr>
    </table>
    <button id="lootOpenBtn" type="button" ${canAfford && !lootBusy ? '' : 'disabled'}>${lootBusy ? 'Opening…' : canAfford ? `🎁 Open Box · ${LOOT_PRICE.toLocaleString()}🪙` : `Need ${LOOT_PRICE.toLocaleString()}🪙 — you have ${wallet.coins.toLocaleString()}`}</button>
    <div id="lootReveal" class="loot-reveal">${lootRevealHtml}</div>
    ${owned}
    <div class="loot-cap"><b>Mint caps:</b> ${EXCLUSIVES.map((x) => `${escapeHtml(x.name)} (${x.cap})`).join(' · ')}</div>`;
  const openBtn = document.getElementById('lootOpenBtn') as HTMLButtonElement | null;
  if (openBtn) openBtn.onclick = () => {
    if (lootBusy || wallet.coins < LOOT_PRICE) return;
    lootBusy = true; lootRevealHtml = ''; renderLoot();
    net.send({ type: 'lootBoxOpen' });
    // Safety net: never hang on "Opening…" if no result comes back (e.g. server hiccup).
    if (lootTimer !== undefined) clearTimeout(lootTimer);
    lootTimer = window.setTimeout(() => {
      if (!lootBusy) return;
      lootBusy = false;
      lootRevealHtml = '<div class="loot-pop">⚠️ No response — try again (you were not charged if it failed).</div>';
      renderLoot();
    }, 8000);
  };
}
function onLootResult(msg: LootResultMsg) {
  if (lootTimer !== undefined) { clearTimeout(lootTimer); lootTimer = undefined; }
  lootBusy = false;
  const SLOT_LABEL: Record<string, string> = { hat: '🎩 Hat', skin: '🎨 Skin', trail: '✨ Trail', title: '🏷️ Title', song: '🎵 Song' };
  if (msg.kind === 'exclusive') {
    const excl = EXCLUSIVES.find((x) => x.id === (msg.item ?? ''));
    const slotLabel = excl ? (SLOT_LABEL[excl.slot] ?? excl.slot) : '';
    lootRevealHtml = `<div class="loot-pop loot-rare"><div class="loot-slot">${slotLabel} · Exclusive</div>✨ <b>${escapeHtml(msg.name ?? '')}</b><br><span class="loot-serial">#${msg.serial} of ${msg.cap}</span><div class="loot-rarity">${escapeHtml(msg.rarity ?? '')}</div></div>`;
    playChaChing();
  } else if (msg.kind === 'cosmetic') {
    const cosm = COSMETICS.find((c) => c.id === (msg.item ?? ''));
    const slotLabel = cosm ? (SLOT_LABEL[cosm.slot] ?? cosm.slot) : '';
    lootRevealHtml = `<div class="loot-pop"><div class="loot-slot">${slotLabel}</div>🎨 <b>${escapeHtml(msg.name ?? '')}</b><div class="loot-added">Added to your wardrobe!</div></div>`;
  } else if (msg.kind === 'nothing') {
    lootRevealHtml = `<div class="loot-pop loot-nothing"><div class="loot-slot">Empty</div>🫥 <b>Better luck next time…</b><div class="loot-added">The house thanks you for your contribution.</div></div>`;
  } else {
    lootRevealHtml = `<div class="loot-pop"><div class="loot-slot">Coin Payout</div>🪙 <b>+${(msg.coins ?? 0).toLocaleString()}</b> coins</div>`;
    playChaChing();
  }
  // Persisted in lootRevealHtml so the wallet/house/market re-renders that follow an open don't
  // wipe the prize; renderLoot() paints it from there.
  renderLoot();
}
if (lootBtn) lootBtn.addEventListener('click', () => {
  const open = lootPanel.hidden;
  lootPanel.hidden = !open;
  lootBtn.setAttribute('aria-expanded', String(open));
  if (open) renderLoot();
});
document.addEventListener('click', (e) => {
  if (lootPanel.hidden) return;
  const t = e.target as Node;
  if (t instanceof Node && !t.isConnected) return;
  if (!lootPanel.contains(t) && !(lootBtn && lootBtn.contains(t))) { lootPanel.hidden = true; lootBtn?.setAttribute('aria-expanded', 'false'); }
});

// --- Player marketplace (scarce exclusives): browse floors + "My Items" ---
let marketplace: MarketItemView[] = [];
let mpTab: 'browse' | 'mine' = 'browse';
const marketplaceBtn = document.getElementById('marketplaceBtn') as HTMLButtonElement | null;
const marketplacePanel = document.getElementById('marketplacePanel') as HTMLDivElement;
const marketplaceBody = document.getElementById('marketplaceBody') as HTMLDivElement;
function renderMarketplace() {
  const tabs = `<div class="mp-tabs">
    <button type="button" class="mp-tab${mpTab === 'browse' ? ' active' : ''}" data-mptab="browse">Browse</button>
    <button type="button" class="mp-tab${mpTab === 'mine' ? ' active' : ''}" data-mptab="mine">My Items</button>
  </div>`;
  let body = '';
  if (mpTab === 'browse') {
    body = marketplace.map((it) => {
      const def = EXCLUSIVES.find((x) => x.id === it.item) as ExclusiveItem | undefined;
      const floor = it.floor !== null ? `${it.floor.toLocaleString()}🪙` : '—';
      const last = it.lastSale !== null ? `last ${it.lastSale.toLocaleString()}🪙` : 'no sales yet';
      const canBuy = it.floor !== null && wallet.coins >= it.floor;
      return `<div class="mp-row">
        <div class="mp-name">${escapeHtml(def?.name ?? it.item)} <span class="mp-rarity">${escapeHtml(def?.rarity ?? '')}</span></div>
        <div class="mp-meta">${it.minted} of ${it.cap} minted · floor ${floor} · ${last}</div>
        <button type="button" class="mp-buy" data-mpbuy="${it.item}" ${canBuy ? '' : 'disabled'}>Buy Lowest${it.floor !== null ? ` (${it.floor.toLocaleString()}🪙)` : ''}</button>
      </div>`;
    }).join('') || '<div class="mp-empty">No exclusives minted yet — try a loot box.</div>';
  } else {
    // "My Items": list-for / cancel + a quick equip.
    const myListings = marketplace.flatMap((it) => it.listings.filter((l) => l.mine).map((l) => ({ ...l, def: EXCLUSIVES.find((x) => x.id === it.item) })));
    const listingRows = myListings.map((l) =>
      `<div class="mp-row"><div class="mp-name">${escapeHtml(l.def?.name ?? l.item)} <span class="mp-serial">listed for ${l.ask.toLocaleString()}🪙</span></div>
        <button type="button" class="mp-cancel" data-mpcancel="${l.id}">Cancel</button></div>`,
    ).join('');
    const ownRows = wallet.exclusives.map((e) => {
      const def = EXCLUSIVES.find((x) => x.id === e.id) as ExclusiveItem | undefined;
      const equipped = (def && (wallet.hat === e.id || wallet.skin === e.id || wallet.trail === e.id || wallet.title === e.id));
      return `<div class="mp-row">
        <div class="mp-name">${escapeHtml(def?.name ?? e.id)} <span class="mp-serial">#${e.serial}</span></div>
        <div class="mp-own-actions">
          <button type="button" class="mp-equip" data-mpequip="${e.id}" data-mpslot="${def?.slot ?? ''}">${equipped ? 'Unequip' : 'Equip'}</button>
          <input type="number" min="1" class="mp-ask" data-mpask="${e.serial}" placeholder="price" />
          <button type="button" class="mp-list" data-mplist="${e.id}" data-mpserial="${e.serial}">List</button>
        </div>
      </div>`;
    }).join('') || '<div class="mp-empty">You own no exclusives yet.</div>';
    body = `${myListings.length ? `<div class="mp-section">Your listings</div>${listingRows}` : ''}<div class="mp-section">Your items</div>${ownRows}`;
  }
  marketplaceBody.innerHTML = tabs + body;
}
// Delegated handlers for the marketplace panel.
marketplaceBody.addEventListener('click', (e) => {
  const el = e.target as HTMLElement;
  const tab = el.closest<HTMLButtonElement>('[data-mptab]');
  if (tab) { mpTab = tab.dataset.mptab as 'browse' | 'mine'; renderMarketplace(); return; }
  const buy = el.closest<HTMLButtonElement>('[data-mpbuy]');
  if (buy) { net.send({ type: 'marketBuy', item: buy.dataset.mpbuy! }); return; }
  const cancel = el.closest<HTMLButtonElement>('[data-mpcancel]');
  if (cancel) { net.send({ type: 'marketCancel', listingId: Number(cancel.dataset.mpcancel) }); return; }
  const equip = el.closest<HTMLButtonElement>('[data-mpequip]');
  if (equip) {
    const id = equip.dataset.mpequip!;
    const slot = equip.dataset.mpslot as 'hat' | 'skin' | 'trail' | 'title';
    const equipped = wallet.hat === id || wallet.skin === id || wallet.trail === id || wallet.title === id;
    net.send({ type: 'shopEquip', slot, item: equipped ? null : id });
    return;
  }
  const list = el.closest<HTMLButtonElement>('[data-mplist]');
  if (list) {
    const serial = Number(list.dataset.mpserial);
    const itemId = list.dataset.mplist!;
    const input = marketplaceBody.querySelector<HTMLInputElement>(`input[data-mpask="${serial}"]`);
    const ask = Math.floor(Number(input?.value));
    if (!Number.isFinite(ask) || ask < 1) { showAnnouncement('Enter a price to list.', { toast: true }); return; }
    // Resolve the specific instance id from the wallet (serial is unique per item).
    const owned = wallet.exclusives.find((x) => x.id === itemId && x.serial === serial);
    if (!owned) { showAnnouncement('Could not resolve that item.', { toast: true }); return; }
    net.send({ type: 'marketList', instanceId: owned.instanceId, ask });
    return;
  }
});
if (marketplaceBtn) marketplaceBtn.addEventListener('click', () => {
  const open = marketplacePanel.hidden;
  marketplacePanel.hidden = !open;
  marketplaceBtn.setAttribute('aria-expanded', String(open));
  if (open) { net.send({ type: 'marketReq' }); renderMarketplace(); }
});
document.addEventListener('click', (e) => {
  if (marketplacePanel.hidden) return;
  const t = e.target as Node;
  if (t instanceof Node && !t.isConnected) return;
  if (!marketplacePanel.contains(t) && !(marketplaceBtn && marketplaceBtn.contains(t))) { marketplacePanel.hidden = true; marketplaceBtn?.setAttribute('aria-expanded', 'false'); }
});

// --- Loan book modal (cloned from the balance-sheet modal pattern) ---
function showLoanBook(msg: LoanBookMsg) {
  balanceName.textContent = '📒 Davis\'s Loan Book';
  if (!msg.loans.length) {
    balanceBody.innerHTML = '<div class="bs-empty">No open loans — the books are clean.</div>';
  } else {
    const now = Date.now();
    const rows = msg.loans.map((l) => {
      const ms = l.dueAt - now;
      const hrs = ms > 0 ? Math.floor(ms / 3_600_000) : 0;
      const mins = ms > 0 ? Math.floor((ms % 3_600_000) / 60_000) : 0;
      const due = ms > 0 ? `${hrs}h ${mins}m` : 'overdue';
      return `<div class="bs-row"><span class="bs-label">${escapeHtml(l.name)} <span class="bs-sub">borrowed ${l.amount.toLocaleString()}🪙 · due ${due}</span></span>` +
        `<span class="bs-val bs-debt">−${l.owed.toLocaleString()}🪙</span></div>`;
    });
    balanceBody.innerHTML = rows.join('');
  }
  balanceModal.hidden = false;
}

// --- Davis's loans (top-left): borrow coins, owe 1.5× by the daily 5pm collection ---
// The server owns the loan; we render the latest `loan` state and fire getLoan/repayLoan.
// `loanStep` is local conversation state: 'intro' (Davis offers) → 'amount' (pick how much).
// Once you hold a loan, the panel always shows the repay view regardless of step.
const loanBtn = document.getElementById('loanBtn') as HTMLButtonElement;
const loanPanel = document.getElementById('loanPanel') as HTMLDivElement;
const loanImg = document.getElementById('loanImg') as HTMLImageElement;
const loanBody = document.getElementById('loanBody') as HTMLDivElement;
let loan: { amount: number; owed: number; dueAt: number } | null = null;
let loanStep: 'intro' | 'amount' = 'intro';

// Davis Clarke mannerism shown on the intro.
const DAVIS_QUOTES = [
  "You miss 100% of the loans you don't take.",
];
let davisQuote = DAVIS_QUOTES[0];

// Davis's three faces, by stage of the conversation. (Files live in client/public.)
const DAVIS_INTRO = '/davis_at_citizens.jpg';
const DAVIS_AMOUNT = '/davis_marathon.png';
const DAVIS_OWED = '/davis_glasses.jpg';

function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'any moment now';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m`;
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function renderLoan() {
  loanBody.innerHTML = '';
  // You owe Davis — always show the repay view (his sunglasses are on; he means business).
  if (loan) {
    loanImg.src = DAVIS_OWED;
    const due = loan.dueAt - Date.now();
    loanBody.innerHTML =
      `<div class="loan-line">You borrowed <b>${loan.amount}</b>🪙. Davis wants <span class="loan-owe">${loan.owed}🪙</span> back.</div>` +
      `<div class="loan-due">Due by <b>5pm</b> · <b>${fmtCountdown(due)}</b> left. Miss it and he takes <b>everything</b> — coins, stocks, and cosmetics — and your unpaid debt destabilizes the whole market.</div>`;
    const actions = document.createElement('div');
    actions.className = 'loan-actions';
    const pay = document.createElement('button');
    pay.className = 'loan-pay';
    pay.textContent = `Pay ${loan.owed}🪙`;
    pay.disabled = wallet.coins < loan.owed;
    pay.title = pay.disabled ? "You can't cover the full repayment yet." : '';
    pay.onclick = () => { net.send({ type: 'repayLoan' }); playChaChing(); };
    const close = document.createElement('button');
    close.textContent = 'Not yet';
    close.onclick = closeLoan;
    actions.append(pay, close);
    loanBody.appendChild(actions);
    return;
  }

  // No loan: 'amount' step (pick how much) or 'intro' (Davis offers).
  if (loanStep === 'amount') {
    loanImg.src = DAVIS_AMOUNT;
    loanBody.innerHTML = `<div class="loan-line">I respect a fellow heavy hitter. How much you need? I'll want <b>1.5×</b> back by <b>5pm</b>.</div>`;
    const row = document.createElement('div');
    row.className = 'loan-amt-row';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.step = '1';
    input.value = '500';
    input.setAttribute('inputmode', 'numeric');
    row.appendChild(input);
    loanBody.appendChild(row);
    const owe = document.createElement('div');
    owe.className = 'loan-due';
    const previewOwed = (v: number) => Math.ceil(Math.max(0, Math.floor(v || 0)) * 1.5);
    const refreshOwe = () => { owe.textContent = `You'll owe Davis ${previewOwed(Number(input.value))}🪙.`; };
    refreshOwe();
    input.addEventListener('input', refreshOwe);
    loanBody.appendChild(owe);
    const warn = document.createElement('div');
    warn.className = 'loan-warn';
    warn.innerHTML = `⚠️ If you don't repay by <b>5pm</b>, Davis takes <b>EVERYTHING</b> — your coins, your stocks, and every cosmetic you own — and your unpaid debt destabilizes the market for everyone. No mercy.`;
    loanBody.appendChild(warn);
    const actions = document.createElement('div');
    actions.className = 'loan-actions';
    const borrow = document.createElement('button');
    borrow.className = 'loan-yes';
    borrow.textContent = 'Borrow';
    borrow.onclick = () => {
      const amt = Math.floor(Number(input.value));
      if (!Number.isFinite(amt) || amt < 1) return;
      net.send({ type: 'getLoan', amount: amt });
      playChaChing();
    };
    const back = document.createElement('button');
    back.textContent = 'Back';
    back.onclick = () => { loanStep = 'intro'; renderLoan(); };
    actions.append(borrow, back);
    loanBody.appendChild(actions);
    return;
  }

  // Intro: Davis at Citizens, offering a loan.
  loanImg.src = DAVIS_INTRO;
  loanBody.innerHTML =
    `<div class="loan-quote">"${davisQuote}"</div>` +
    `<div class="loan-line">I can spot you some coins — pay me back <b>1.5×</b> by <b>5pm</b>. Would you like a loan?</div>`;
  const actions = document.createElement('div');
  actions.className = 'loan-actions';
  const yes = document.createElement('button');
  yes.className = 'loan-yes';
  yes.textContent = 'Yes';
  yes.onclick = () => { loanStep = 'amount'; renderLoan(); };
  const no = document.createElement('button');
  no.textContent = 'No';
  no.onclick = closeLoan;
  actions.append(yes, no);
  loanBody.appendChild(actions);
}

function closeLoan() {
  loanPanel.hidden = true;
  loanBtn.setAttribute('aria-expanded', 'false');
}

// --- Netizen Challenge dialog ---
let ncNetizenId = '';
let ncMax = 0; // max wager (20% of net worth)

function showNetizenChallenge(msg: NetizenInfoMsg) {
  if (!joined) return;
  ncNetizenId = msg.netizenId;
  const netWorth = msg.netWorth;
  ncMax = Math.max(100, Math.floor(netWorth * 0.2));
  ncName.textContent = msg.netizenName;
  ncNetWorth.textContent = `Net worth: ${netWorth.toLocaleString()} 🪙`;
  ncWarn.hidden = !msg.challengedToday;
  ncRow.hidden = msg.challengedToday;
  ncChallengeBtn.hidden = msg.challengedToday;
  const wager = Math.min(100, ncMax);
  ncWager.value = String(wager);
  ncWager.max = String(ncMax);
  ncWager.min = '100';
  ncMaxWin.textContent = `Max win: ${ncMax.toLocaleString()} 🪙 (20% of net worth)`;
  ncChallengeBtn.disabled = ncMax < 100;
  if (!ncModal.hidden) return;
  ncModal.hidden = false;
}

function closeNetizenChallenge() {
  ncModal.hidden = true;
}

function clampNcWager() {
  let v = Math.floor(Number(ncWager.value));
  if (!Number.isFinite(v) || v < 100) v = 100;
  if (v > ncMax) v = ncMax;
  ncWager.value = String(v);
  ncChallengeBtn.disabled = v < 100 || v > ncMax;
}

ncClose.addEventListener('click', closeNetizenChallenge);
ncModal.addEventListener('click', (e) => {
  if (e.target === ncModal) closeNetizenChallenge();
});
ncWager.addEventListener('input', clampNcWager);
ncWager.addEventListener('change', clampNcWager);
ncMinus.addEventListener('click', () => {
  ncWager.value = String(Math.max(100, Math.floor(Number(ncWager.value) || 100) - 10));
  clampNcWager();
});
ncPlus.addEventListener('click', () => {
  ncWager.value = String(Math.min(ncMax, Math.floor(Number(ncWager.value) || 100) + 10));
  clampNcWager();
});
ncChallengeBtn.addEventListener('click', () => {
  const wager = Math.floor(Number(ncWager.value));
  if (wager < 100 || wager > ncMax || !ncNetizenId) return;
  net.send({ type: 'netizenChallenge', netizenId: ncNetizenId, wager });
  closeNetizenChallenge();
  worldMod?.exitWorld();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !ncModal.hidden) closeNetizenChallenge();
});

loanBtn.addEventListener('click', () => {
  const open = loanPanel.hidden;
  loanPanel.hidden = !open;
  loanBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    davisQuote = DAVIS_QUOTES[Math.floor(Math.random() * DAVIS_QUOTES.length)];
    loanStep = 'intro';
    renderLoan();
  }
});
// Live-refresh the due countdown (and re-gate the Pay button on balance) while open.
setInterval(() => { if (!loanPanel.hidden && loan) renderLoan(); }, 1000);
// Click-outside closes the panel (mirrors the market panel behavior).
document.addEventListener('click', (e) => {
  if (loanPanel.hidden) return;
  const t = e.target as Node;
  if (t instanceof Node && !t.isConnected) return;
  if (!loanPanel.contains(t) && !loanBtn.contains(t)) closeLoan();
});

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

// --- Tournament dropdown (top-left): create a bracket ---
const tourneyBtn = document.getElementById('tourneyBtn') as HTMLButtonElement;
const tourneyPanel = document.getElementById('tourneyPanel') as HTMLDivElement;
const tournamentPanel = document.getElementById('tournamentPanel') as HTMLDivElement;
const tournamentTitle = document.getElementById('tournamentTitle') as HTMLSpanElement;
const tournamentBody = document.getElementById('tournamentBody') as HTMLDivElement;
const tournamentJoinBtn = document.getElementById('tournamentJoinBtn') as HTMLButtonElement;
const tournamentCancelBtn = document.getElementById('tournamentCancelBtn') as HTMLButtonElement;
const tournamentCollapseBtn = document.getElementById('tournamentCollapseBtn') as HTMLButtonElement;
// Bracket fold state: auto-collapses out of the way once a match is actually being played,
// so it stops covering the board; the user can toggle it to peek at any time.
let bracketCollapsed = false;
let lastTourneyPhase = '';

function closeTourney() {
  tourneyPanel.hidden = true;
  tourneyBtn.setAttribute('aria-expanded', 'false');
}
tourneyBtn.addEventListener('click', () => {
  const open = tourneyPanel.hidden;
  tourneyPanel.hidden = !open;
  tourneyBtn.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (e) => {
  if (tourneyPanel.hidden) return;
  const t = e.target as Node;
  if (!tourneyPanel.contains(t) && !tourneyBtn.contains(t)) closeTourney();
});
for (const btn of tourneyPanel.querySelectorAll<HTMLButtonElement>('.tourney-size')) {
  btn.addEventListener('click', () => {
    net.send({ type: 'tournamentCreate', size: Number(btn.dataset.size) });
    closeTourney();
  });
}
tournamentJoinBtn.addEventListener('click', () => net.send({ type: 'tournamentJoin' }));
tournamentCancelBtn.addEventListener('click', () => {
  if (confirm('Cancel the current tournament?')) net.send({ type: 'tournamentCancel' });
});
tournamentCollapseBtn.addEventListener('click', () => {
  bracketCollapsed = !bracketCollapsed;
  if (state) renderTournament(state.tournament);
});

// Public bet board under the court: who bet how much on each side.
const betBoard = document.getElementById('betBoard') as HTMLDivElement;
function renderBetBoard(s: StateMsg) {
  const b = s.bets;
  const any = b.left.length || b.right.length;
  // Show only during a (non-arena) duel when there are wagers.
  betBoard.hidden = !any || !!s.poly;
  if (betBoard.hidden) return;
  const col = (side: 'left' | 'right') => {
    const list = b[side];
    const total = list.reduce((a, x) => a + x.amount, 0);
    const lines = list.length
      ? list.map((x) => `<div class="bet-line"><span>${escapeHtml(x.name)}</span><span class="amt">${x.amount}🪙</span></div>`).join('')
      : '<div class="bet-empty">no bets</div>';
    const label = side === 'left' ? (s.paddles.left.name ?? 'Left') : (s.paddles.right.name ?? 'Right');
    const odds = s.odds ? ` <span class="bet-odds">${s.odds[side].toFixed(2)}×</span>` : '';
    return `<div class="bet-col ${side}"><h4>${escapeHtml(label)}${odds}</h4>${lines}` +
      (total ? `<div class="bet-total">total ${total}🪙</div>` : '') + `</div>`;
  };
  betBoard.innerHTML = col('left') + col('right');
}

// Render the live tournament panel from server state (signup slots, bracket, or champion).
function renderTournament(t: StateMsg['tournament']) {
  document.body.classList.toggle('tournament-on', !!t);
  if (!t) {
    tournamentPanel.hidden = true;
    lastTourneyPhase = '';
    return;
  }
  tournamentPanel.hidden = false;

  // Auto-fold the bracket once a match is actually being played so it stops covering the
  // board; auto-unfold during signup, between matches, and on the champion screen. A manual
  // toggle sticks until the phase changes again.
  const live = t.status === 'active' && state?.status === 'playing';
  const phase = `${t.status}:${live ? 'live' : 'idle'}`;
  if (phase !== lastTourneyPhase) {
    lastTourneyPhase = phase;
    bracketCollapsed = live;
  }
  tournamentCollapseBtn.hidden = t.status === 'signup'; // nothing to fold during signup
  tournamentCollapseBtn.textContent = bracketCollapsed ? '▸' : '▾';
  tournamentBody.hidden = bracketCollapsed && t.status !== 'signup';
  // Only the creator sees the cancel (✕) button — keeps a random spectator from nuking it.
  tournamentCancelBtn.hidden = t.creator !== myName;

  if (t.status === 'signup') {
    const filled = t.slots.filter(Boolean).length;
    tournamentTitle.textContent = `⚽ World Cup — ${filled}/${t.size} joined`;
    const alreadyIn = t.slots.some((s) => s === myName);
    tournamentJoinBtn.hidden = !(myRole === 'observer' && !alreadyIn && filled < t.size && joined);
    tournamentBody.innerHTML =
      `<div class="t-slots">` +
      t.slots
        .map((s, i) => {
          if (!s) return `<div class="t-slot open"><span class="t-seed">#${i + 1}</span>open</div>`;
          const c = t.countries[s];
          const flag = c ? `<span class="t-flag">${c.flag}</span>` : '';
          const ctry = c ? `<span class="t-country">${escapeHtml(c.name)}</span>` : '';
          return `<div class="t-slot"><span class="t-seed">#${i + 1}</span>${flag}${escapeHtml(s)}${ctry}</div>`;
        })
        .join('') +
      `</div>`;
    return;
  }

  // active / done → render the bracket by round.
  tournamentJoinBtn.hidden = true;
  const liveMatch = t.matches.find((m) => m.live);
  const flagOf = (name: string | null) => name && t.countries[name] ? t.countries[name].flag + ' ' : '';
  tournamentTitle.textContent =
    t.status === 'done'
      ? `⚽🏆 ${flagOf(t.champion)}${t.champion ?? '—'}`
      : liveMatch && liveMatch.p1 && liveMatch.p2
        ? `⚽ ${flagOf(liveMatch.p1)}${liveMatch.p1} vs ${flagOf(liveMatch.p2)}${liveMatch.p2}`
        : '⚽ World Cup';
  const roundName = (r: number) => {
    const fromEnd = t.rounds - 1 - r; // 0 = final
    if (fromEnd === 0) return 'Final';
    if (fromEnd === 1) return 'Semifinals';
    if (fromEnd === 2) return 'Quarterfinals';
    return `Round ${r + 1}`;
  };
  const player = (name: string | null, isWinner: boolean) => {
    if (!name) return `<div class="t-player tbd">TBD</div>`;
    const c = t.countries[name];
    const flag = c ? `<span class="t-flag">${c.flag}</span>` : '';
    return `<div class="t-player${isWinner ? ' winner' : ''}">${flag}${escapeHtml(name)}${isWinner ? ' ✓' : ''}</div>`;
  };
  let html = `<div class="t-bracket">`;
  for (let r = 0; r < t.rounds; r++) {
    const ms = t.matches.filter((m) => m.round === r);
    html += `<div class="t-round"><div class="t-round-title">${roundName(r)}</div>`;
    for (const m of ms) {
      html += `<div class="t-match${m.live ? ' live' : ''}">` +
        player(m.p1, m.winner != null && m.winner === m.p1) +
        player(m.p2, m.winner != null && m.winner === m.p2) +
        `</div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;
  if (t.status === 'done' && t.champion) {
    const champC = t.countries[t.champion];
    html += `<div class="t-champion">⚽🏆 ${champC ? champC.flag + ' ' : ''}${escapeHtml(t.champion)} wins the World Cup!</div>`;
  }
  tournamentBody.innerHTML = html;
}

// --- Power-ups dropdown (top-left, next to MODES): legend of all power-ups ---
const powerupInfoBtn = document.getElementById('powerupInfoBtn') as HTMLButtonElement;
const powerupInfoPanel = document.getElementById('powerupInfoPanel') as HTMLDivElement;

// Spawning from the dropdown follows the same rule as the /powerup command:
// only a spectator can drop one, and only while a match is live.
const canSpawnPowerup = () => !isPlayer() && state?.status === 'playing';

// Each legend row doubles as a spawn button: clicking it drops that power-up,
// just like typing `/powerup <kind>`. When you can't spawn, the panel is a plain
// legend (the `.legend-only` class dims the click affordance).
function syncPowerupSpawnability() {
  powerupInfoPanel.classList.toggle('legend-only', !canSpawnPowerup());
}
for (const row of powerupInfoPanel.querySelectorAll<HTMLDivElement>('.pu-row')) {
  const kind = row.querySelector<HTMLCanvasElement>('.pu-icon')?.dataset.kind;
  if (!kind) continue;
  row.title = `Spawn the ${kind} power-up`;
  row.addEventListener('click', () => {
    if (!canSpawnPowerup()) return;
    net.send({ type: 'spawnPowerup', kind });
  });
}

function openPowerupInfo() {
  syncPowerupSpawnability();
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

// "Add block": spectators-only drop of a solid obstacle on the live duel court. Shown only
// when you could actually use it (same rule as spawning a power-up, duel mode only).
const blockControl = document.getElementById('blockControl') as HTMLDivElement;
const addBlockBtn = document.getElementById('addBlockBtn') as HTMLButtonElement;
const canAddBlock = () => !isPlayer() && state?.status === 'playing' && !inArena();
addBlockBtn.addEventListener('click', () => {
  if (canAddBlock()) net.send({ type: 'addBlock' });
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
  author: string;
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
      const tail = `${timeAgo(c.date)}${c.author ? ` · ${c.author}` : ''}`;
      if (c.url) {
        // Link the short hash to the commit on GitHub; open in a new tab.
        const link = document.createElement('a');
        link.className = 'changelog-hash';
        link.href = c.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = c.hash;
        meta.append(link, document.createTextNode(` · ${tail}`));
      } else {
        meta.textContent = `${c.hash} · ${tail}`;
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

// --- NET debug readout: live performance stats, hidden behind a corner toggle ---
// Three things together answer "are players seeing good performance?": round-trip
// latency (the network), client FPS (this player's machine), and server tick health
// (the shared simulation). Each is colored green/amber/red by how it actually feels.
const debugBtn = document.getElementById('debugBtn') as HTMLButtonElement;
const debugPanel = document.getElementById('debugPanel') as HTMLDivElement;
const dbgPing = document.getElementById('dbgPing') as HTMLSpanElement;
const dbgPingStats = document.getElementById('dbgPingStats') as HTMLSpanElement;
const dbgFps = document.getElementById('dbgFps') as HTMLSpanElement;
const dbgFpsMin = document.getElementById('dbgFpsMin') as HTMLSpanElement;
const dbgTps = document.getElementById('dbgTps') as HTMLSpanElement;
const dbgTick = document.getElementById('dbgTick') as HTMLSpanElement;

const GOOD = '#6ee7a8';
const WARN = '#ffd166';
const BAD = '#ff6b6b';
// Latency: snappy under 60 ms, noticeable under 140, laggy beyond (the rule of thumb for
// real-time control feeling responsive).
const rttColor = (ms: number) => (ms < 60 ? GOOD : ms < 140 ? WARN : BAD);
// Frame rate: smooth at/above ~55, choppy under ~40 (higher = better, so the test flips).
const fpsColor = (fps: number) => (fps >= 55 ? GOOD : fps >= 40 ? WARN : BAD);
// Tick rate: the loop targets 60; under ~58 it's slipping, under ~50 it's clearly behind.
const tpsColor = (tps: number) => (tps >= 58 ? GOOD : tps >= 50 ? WARN : BAD);

function setStat(el: HTMLSpanElement, text: string, color: string) {
  el.textContent = text;
  el.style.color = color;
}
function renderDebug() {
  if (debugPanel.hidden) return; // only paint while the panel is open

  // Network — round-trip latency.
  if (rttSamples.length === 0) {
    setStat(dbgPing, '—', '#cdd7f5');
    dbgPingStats.textContent = '—';
  } else {
    const avg = rttSamples.reduce((a, b) => a + b, 0) / rttSamples.length;
    const max = Math.max(...rttSamples);
    setStat(dbgPing, `${Math.round(lastRtt)} ms`, rttColor(lastRtt));
    dbgPingStats.textContent = `${Math.round(avg)} / ${Math.round(max)} ms`;
  }

  // Client — render frame rate (current + worst recent second).
  if (fpsSamples.length === 0) {
    setStat(dbgFps, '—', '#cdd7f5');
    setStat(dbgFpsMin, '—', '#cdd7f5');
  } else {
    const min = Math.min(...fpsSamples);
    setStat(dbgFps, String(Math.round(lastFps)), fpsColor(lastFps));
    setStat(dbgFpsMin, String(Math.round(min)), fpsColor(min));
  }

  // Server — authoritative tick-loop health (reported on the rtt echo).
  if (!serverTick) {
    setStat(dbgTps, '—', '#cdd7f5');
    dbgTick.textContent = '—';
  } else {
    setStat(dbgTps, `${serverTick.tps} tps`, tpsColor(serverTick.tps));
    dbgTick.textContent = `${serverTick.busyAvg} ms · ${serverTick.slowPct}% slow`;
    dbgTick.style.color = serverTick.slowPct < 5 ? GOOD : serverTick.slowPct < 20 ? WARN : BAD;
  }
}
function openDebug() {
  debugPanel.hidden = false;
  debugBtn.setAttribute('aria-expanded', 'true');
  renderDebug();
}
function closeDebug() {
  debugPanel.hidden = true;
  debugBtn.setAttribute('aria-expanded', 'false');
}
debugBtn.addEventListener('click', () => (debugPanel.hidden ? openDebug() : closeDebug()));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !debugPanel.hidden) closeDebug();
});
// Probe latency on a steady cadence while the socket is up. net.send() is a no-op when
// disconnected, so a dropped connection just pauses the readout until it's back.
setInterval(() => net.send({ type: 'rtt', t: performance.now() }), 2000);

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
  revealAds(); // returning players skip the join form — still show the banner ad
  startFlyovers();
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
  window.setTimeout(dismiss, reduce ? 600 : 1200);
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
const clampRoam = (x: number) => Math.max(0, Math.min(ROAM.maxInset, x));

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
  // Blaster aim: while armed, steer the shot with whichever mouse axis isn't driving the
  // paddle (movementX normally; movementY when the paddle rides the X axis — rotated / FP).
  if (myAmmo() > 0) {
    // Paddle rides the X axis on a quarter/three-quarter turn or in first-person; aim with the other axis.
    const paddleUsesX = state?.rotated === 1 || state?.rotated === 3 || state?.viewMode === 'firstperson';
    const d = paddleUsesX ? e.movementY : e.movementX;
    aimAngle = Math.max(-BLASTER.maxAngle, Math.min(BLASTER.maxAngle, aimAngle + d * 0.004));
  }
  // Convert screen-pixel movement to court units. In first-person the paddle appears
  // left/right on screen so movementX drives it (direction flips for the right side).
  // Cap movementX per event to avoid a mouse-acceleration spike clamping the paddle
  // to an edge in a single frame and making it appear frozen.
  // Rotated court: paddle slides horizontally too, same movementX logic.
  if (state?.rotated === 1) {
    target = clampPaddle(target - e.movementX * (COURT.h / r.width));
  } else if (state?.rotated === 2) {
    target = clampPaddle(target - e.movementY * (COURT.h / r.height));
  } else if (state?.rotated === 3) {
    target = clampPaddle(target + e.movementX * (COURT.h / r.width));
  } else if (state?.viewMode === 'firstperson') {
    const sign = myRole === 'right' ? -1 : 1;
    const dx = Math.max(-40, Math.min(40, e.movementX));
    target = clampPaddle(target + sign * dx * (COURT.h / r.width) * 1.5);
  } else {
    target = clampPaddle(target + e.movementY * (COURT.h / r.height));
    // Roam power-up: the otherwise-unused horizontal axis pushes the paddle into the
    // court. Moving toward center (right for left side, left for right side) extends it.
    if (myRoamHits() > 0 && myAmmo() <= 0) {
      const sign = myRole === 'right' ? -1 : 1;
      targetX = clampRoam(targetX + sign * e.movementX * (COURT.w / r.width));
    }
  }
}

// My duel side ('left'/'right'), or null when spectating / in the arena.
function myDuelSide(): 'left' | 'right' | null {
  return myRole === 'left' || myRole === 'right' ? myRole : null;
}
// How many blaster shots my paddle is currently holding.
function myAmmo(): number {
  const s = myDuelSide();
  return s && state ? state.paddles[s].ammo ?? 0 : 0;
}
// Hits left on my "roam" power-up (>0 means my paddle can push into the court).
function myRoamHits(): number {
  const s = myDuelSide();
  return s && state ? state.paddles[s].roamHits ?? 0 : 0;
}
// Fire the blaster (a mouse click while captured and armed). Server validates ammo.
function fireBlaster() {
  if (!pointerLocked || myAmmo() <= 0) return;
  net.send({ type: 'fire', angle: aimAngle });
}

canvas.addEventListener('click', onBoardClick);
canvas.addEventListener('mousemove', onBoardMouseMove);
canvas.addEventListener('mousedown', fireBlaster);
game3dEl.addEventListener('click', onBoardClick);
game3dEl.addEventListener('mousemove', onBoardMouseMove);
game3dEl.addEventListener('mousedown', fireBlaster);

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
// Fatalities are permanently ON. Trying to turn them off just gets you mocked.
const FATALITY_MOCKS = [
  "Turn off fatalities? What are you, allergic to fun?",
  "lol no. Finishers stay ON, coward.",
  "Aww, does the wittle baby not like a finishing move?",
  "Denied. Embrace the violence. 🔪",
  "Nice try. Real ones leave fatalities ON.",
  "You can't handle the FATALITY, can you?",
  "Imagine playing pong without finishers. Couldn't be you.",
];
fatalityCheck.addEventListener('change', () => {
  if (!fatalityCheck.checked) {
    fatalityCheck.checked = true; // snap it back on
    showFatalityMock(FATALITY_MOCKS[Math.floor(Math.random() * FATALITY_MOCKS.length)]);
  }
});

// A little mocking popup, shown when someone dares to un-check fatalities.
function showFatalityMock(text: string) {
  const back = document.createElement('div');
  back.style.cssText =
    'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;' +
    'background:rgba(0,0,0,0.55);';
  const card = document.createElement('div');
  card.style.cssText =
    'max-width:360px;margin:20px;padding:22px 24px;border-radius:12px;background:#1a0e12;' +
    'border:1px solid #5a2230;box-shadow:0 12px 40px rgba(0,0,0,0.6);text-align:center;' +
    'font:700 16px ui-monospace,monospace;color:#ff8a8a;';
  card.innerHTML =
    '<div style="font-size:40px;margin-bottom:8px">☠️😂</div>' +
    `<div style="line-height:1.5">${escapeHtml(text)}</div>` +
    '<button style="margin-top:18px;font:700 14px ui-monospace,monospace;padding:8px 20px;' +
    'border-radius:8px;border:1px solid #5a2230;background:#2a1218;color:#ff7a7a;cursor:pointer">Fine, leave them ON</button>';
  const close = () => back.remove();
  card.querySelector('button')!.addEventListener('click', close);
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  back.appendChild(card);
  document.body.appendChild(back);
}

// --- fatality combos reference modal ---
// Built once from FATALITIES so adding a finisher there auto-lists it here. Keys render
// as little ↑/↓ keycaps; the description explains what each finisher does.
const ARROW: Record<string, string> = { arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' };
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
let canvasRotated = 0;
function applyCanvasRotation(rotated: number) {
  if (rotated === canvasRotated) return;
  canvasRotated = rotated;
  const portrait = rotated === 1 || rotated === 3;
  canvas.width  = portrait ? COURT.h : COURT.w;
  canvas.height = portrait ? COURT.w : COURT.h;
  canvas.classList.toggle('rotated', portrait);
  game3dEl.classList.toggle('rotated', portrait);
  screenFx.classList.toggle('rotated', portrait);
  renderer3d?.resize();
}

// Earthquake power-up: jiggle the whole board element while the point is live. Independent
// of the canvas draw transforms (and pointer lock survives a CSS transform).
// Apply the screen-effect power-ups (earthquake/tilt transform the board element; the rest
// toggle overlay layers). All view-agnostic: works the same in 2D, 3D and first-person.
const screenFx = document.getElementById('screenFx') as HTMLDivElement;
const fxBlackout = screenFx.querySelector('.fx-blackout') as HTMLElement;
const fxVortex = screenFx.querySelector('.fx-vortex') as HTMLElement;
const fxGlitch = screenFx.querySelector('.fx-glitch') as HTMLElement;
const fxSmoke = screenFx.querySelector('.fx-smoke') as HTMLElement;
let boardFxOn = false;
function applyScreenFx(s: StateMsg) {
  const live = s.status === 'playing';
  // Board transform: earthquake shake + tilt perspective, combined.
  const quake = live && s.earthquake;
  const tilt = live && s.tilt;
  if (quake || tilt) {
    const dx = quake ? (Math.random() * 2 - 1) * 7 : 0;
    const dy = quake ? (Math.random() * 2 - 1) * 7 : 0;
    const t = `${tilt ? 'perspective(640px) rotateX(16deg)' : ''} translate(${dx}px, ${dy}px)`.trim();
    const active = boardEl();
    active.style.transform = t;
    (active === canvas ? game3dEl : canvas).style.transform = '';
    boardFxOn = true;
  } else if (boardFxOn) {
    canvas.style.transform = '';
    game3dEl.style.transform = '';
    boardFxOn = false;
  }
  // Overlay layers.
  fxBlackout.classList.toggle('on', live && s.blackout);
  fxVortex.classList.toggle('on', live && s.vortex);
  fxGlitch.classList.toggle('on', live && s.glitch);
  fxSmoke.classList.toggle('on', live && s.smoke);
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
  const boards = document.getElementById('boards') as HTMLDivElement;
  stage.style.display = '';
  chat.style.display = '';
  boards.style.display = '';
}
for (const btn of mobileTabs.querySelectorAll<HTMLButtonElement>('.mob-tab')) {
  btn.addEventListener('click', () => {
    if (!isMobileView()) return;
    mobileTabs.querySelector('.active')?.classList.remove('active');
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    const stage = document.getElementById('stage') as HTMLDivElement;
    const chat = document.getElementById('chat') as HTMLDivElement;
    const boards = document.getElementById('boards') as HTMLDivElement;
    if (tab === 'play') {
      stage.style.display = '';
      chat.style.display = 'none';
      boards.style.display = '';
    } else if (tab === 'chat') {
      stage.style.display = 'none';
      chat.style.display = '';
      boards.style.display = 'none';
    } else if (tab === 'leaderboard') {
      stage.style.display = 'none';
      chat.style.display = 'none';
      boards.style.display = '';
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
  const boards = document.getElementById('boards') as HTMLDivElement;
  stage.style.display = '';
  chatEl.style.display = 'none';
  boards.style.display = '';
}

// --- touch controls for paddle ---
let touchActive = false;
function onTouchStart() {
  touchActive = true;
  if (isPlayer() && !pointerLocked) {
    // First touch captures the player (like clicking the board on desktop).
    // mobileCaptured stays true between taps so the server doesn't re-pause.
    if (!mobileCaptured) mobileCaptured = true;
    net.send({ type: 'capture', on: true });
  }
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
  const relY = (touch.clientY - r.top) / r.height;
  target = clampPaddle(relY * COURT.h);
}
canvas.addEventListener('touchstart', onTouchStart, { passive: true });
canvas.addEventListener('touchmove', onTouchMove, { passive: true });
canvas.addEventListener('touchend', onTouchEnd);
canvas.addEventListener('touchcancel', onTouchEnd);
game3dEl.addEventListener('touchstart', onTouchStart, { passive: true });
game3dEl.addEventListener('touchmove', onTouchMove, { passive: true });
game3dEl.addEventListener('touchend', onTouchEnd);
game3dEl.addEventListener('touchcancel', onTouchEnd);

// Mobile ▲/▼ buttons: hold to move the paddle continuously. Uses pointer events so
// the button stays responsive even if the finger slides off the element.
for (const [btn, dir] of [[mobUpBtn, 'up'], [mobDownBtn, 'down']] as [HTMLButtonElement, 'up' | 'down'][]) {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.setPointerCapture(e.pointerId);
    if (dir === 'up') mobileUpHeld = true; else mobileDownHeld = true;
    btn.classList.add('held');
    if (isPlayer() && !mobileCaptured) {
      mobileCaptured = true;
      net.send({ type: 'capture', on: true });
    }
  });
  const release = () => {
    if (dir === 'up') mobileUpHeld = false; else mobileDownHeld = false;
    btn.classList.remove('held');
  };
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
}

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

let activeViewMode: 'normal' | '3d' | 'firstperson' = 'normal';

function syncViewMode(viewMode: 'normal' | '3d' | 'firstperson') {
  // Gate the heavy DOM work behind an actual change — this fires 60x/sec via state messages,
  // and constant radio/.hidden writes can cause micro-focus events that drop pointer lock.
  if (viewMode !== activeViewMode) {
    activeViewMode = viewMode;
    const is3d = viewMode !== 'normal';
    document.body.classList.toggle('view-3d', is3d);
    game3dEl.hidden = !is3d;
    canvas.hidden = is3d;
    viewModePanel.querySelectorAll<HTMLInputElement>('input[name="viewMode"]').forEach((r) => {
      r.checked = r.value === viewMode;
    });
    fpPickerEl.hidden = !(viewMode === 'firstperson' && myRole === 'observer');
    if (is3d && !renderer3d) void ensureRenderer3d().then(() => renderer3d?.resize());
  }
  // Lock the dropdown while a match is live so mid-rally view switches can't drop pointer lock.
  const locked = state?.status === 'playing';
  viewModeBtn.disabled = locked;
  viewModeBtn.title = locked ? 'Cannot change view during a match' : '';
}
window.addEventListener('resize', () => {
  if (state?.viewMode !== 'normal') renderer3d?.resize();
});

function canControl(): boolean {
  return pointerLocked || touchActive || mobileCaptured;
}

// --- Work mode: a full-screen spreadsheet disguise (boss key) -----------------------------
// Covers the whole app with a convincing Google-Sheets-style grid whose cells are the live game
// data (scores, market, net worth, standings, chat). Mutes audio and renames the tab while
// active so nothing gives it away. Toggle on with the 📊 Work button; Esc exits.
const workModeEl = document.getElementById('workMode') as HTMLDivElement;
const wmGridEl = document.getElementById('wmGrid') as HTMLDivElement;
const wmStatusEl = document.getElementById('wmStatus') as HTMLSpanElement;
const wmFormulaEl = document.getElementById('wmFormulaVal') as HTMLSpanElement;
const workBtn = document.getElementById('workBtn') as HTMLButtonElement;
const WM_COLS = 22; // columns A..V
const WM_ROWS = 46;
let workOn = false;
let workPrevMuted = false;
let workLastPaint = 0;

// Terminal mode: a sibling boss-key disguise styled as a shell. Shares the menu-lift
// machinery with work mode (only one can be active at a time).
const termModeEl = document.getElementById('termMode') as HTMLDivElement;
const tmTabsEl = document.getElementById('tmTabs') as HTMLDivElement;
const tmBodyEl = document.getElementById('tmBody') as HTMLDivElement;
const termBtn = document.getElementById('termBtn') as HTMLButtonElement;
let termOn = false;
let termLastPaint = 0;
const inDisguise = () => workOn || termOn;

// The top grid row mirrors the real toolbar: each cell maps to a live button and,
// when clicked, opens the genuine dropdown/modal. The cell shows the button's own
// current label (icon, coin count, mute state…) so it reads exactly like the toolbar.
const WM_MENU_IDS = [
  'muteBtn', 'arcadeBtn', 'shopBtn', 'economyBtn', 'casinoBtn', 'viewModeBtn',
  'gameModesBtn', 'tourneyBtn', 'powerupInfoBtn', 'changelogBtn', 'debugBtn',
];
// The current visible text of a toolbar button, minus the dropdown caret.
function wmBtnLabel(id: string): string {
  const t = document.getElementById(id)?.textContent ?? '';
  return t.replace(/▾/g, '').replace(/\s+/g, ' ').trim();
}
// Triggers that, when expanded, mean a toolbar dropdown/modal is currently open.
const WM_PANEL_SEL =
  '#topLeft [aria-expanded="true"], #changelog [aria-expanded="true"], #debugControl [aria-expanded="true"]';

function wmColLetter(i: number): string { // 0 -> A, 25 -> Z, 26 -> AA
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

// Build the cell contents for the current frame, keyed "row,col" (both 1-based; col 1 = A).
function buildWorkCells(): { cells: Map<string, { v: string; cls?: string; btn?: string }>; total: number } {
  const cells = new Map<string, { v: string; cls?: string; btn?: string }>();
  const put = (r: number, c: number, v: string | number, cls?: string) => cells.set(`${r},${c}`, { v: String(v), cls });
  const fmt = (n: number) => Math.round(n).toLocaleString();

  // Top row: one clickable cell per real toolbar button (opens the same dropdown/modal),
  // showing that button's own current label.
  WM_MENU_IDS.forEach((id, i) => cells.set(`1,${i + 1}`, { v: wmBtnLabel(id), cls: 'wm-menu-cell', btn: id }));

  // Positions block ← the crypto market.
  let r = 3;
  put(r, 1, 'Ticker', 'wm-hdr'); put(r, 2, 'Last', 'wm-hdr'); put(r, 3, 'Chg %', 'wm-hdr'); put(r, 4, 'Qty', 'wm-hdr'); put(r, 5, 'Mkt Value', 'wm-hdr');
  r++;
  let total = 0;
  for (const s of STOCKS) {
    const p = market.prices.find((x) => x.id === s.id);
    const price = p?.price ?? s.base;
    const ser = market.history.find((h) => h.id === s.id)?.series;
    const line = ser?.['1d']?.length ? ser['1d'] : (ser?.['1h'] ?? []);
    const chg = line.length >= 2 && line[0] > 0
      ? ((line[line.length - 1] - line[0]) / line[0]) * 100
      : (p && p.prev > 0 ? ((p.price - p.prev) / p.prev) * 100 : 0);
    const longH = market.holdings.find((h) => h.id === s.id && h.side === 'long');
    const shortH = market.holdings.find((h) => h.id === s.id && h.side === 'short');
    const qty = (longH?.shares ?? 0) + (shortH?.shares ?? 0);
    const val = (longH?.worth ?? 0) + (shortH?.worth ?? 0);
    total += val;
    put(r, 1, s.ticker);
    put(r, 2, price.toFixed(2), 'wm-num');
    put(r, 3, `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`, `wm-num ${chg >= 0 ? 'wm-pos' : 'wm-neg'}`);
    put(r, 4, qty > 0 ? qty.toFixed(2) : '', 'wm-num');
    put(r, 5, val > 0 ? fmt(val) : '', 'wm-num');
    r++;
  }

  // Accounts block ← the net-worth board.
  r += 1;
  put(r, 1, 'Account', 'wm-hdr'); put(r, 2, 'Net', 'wm-hdr'); put(r, 3, 'Cash', 'wm-hdr'); put(r, 4, 'Liabilities', 'wm-hdr');
  r++;
  for (const n of lastNwRows.slice(0, 10)) {
    put(r, 1, n.name); put(r, 2, fmt(n.net), 'wm-num'); put(r, 3, fmt(n.coins), 'wm-num'); put(r, 4, fmt(n.loan || 0), 'wm-num');
    r++;
  }

  // Personnel block ← the win/loss standings.
  r += 1;
  put(r, 1, 'Employee', 'wm-hdr'); put(r, 2, 'Closed', 'wm-hdr'); put(r, 3, 'Lost', 'wm-hdr'); put(r, 4, 'Score', 'wm-hdr');
  r++;
  for (const l of lastLbRows.slice(0, 10)) {
    put(r, 1, l.name); put(r, 2, l.wins, 'wm-num'); put(r, 3, l.losses, 'wm-num'); put(r, 4, l.elo, 'wm-num');
    r++;
  }

  // KPI block (right-hand columns) ← the live match + wallet.
  const statusText = !state ? '—' : state.status === 'over' ? 'Closed' : state.status === 'playing' ? 'In Progress' : 'Planning';
  const riskM = document.getElementById('msPct')?.textContent?.match(/[\d,]+%/g);
  const riskPct = riskM ? riskM[riskM.length - 1] : '0%';
  const kpi: [string, string | number][] = [
    ['Division A', state?.paddles.left.name ?? 'Vacant'],
    ['Division B', state?.paddles.right.name ?? 'Vacant'],
    ['A Units', state?.score.left ?? 0],
    ['B Units', state?.score.right ?? 0],
    ['Throughput', state ? Math.round(state.ballSpeed) : 0],
    ['Phase', statusText],
    ['Lead', state?.winner ?? '—'],
    ['Cash on Hand', fmt(wallet.coins)],
    ['Open Positions', market.holdings.length],
    ['Risk Index', riskPct],
  ];
  put(3, 7, 'Operations KPI', 'wm-hdr'); put(3, 8, 'Value', 'wm-hdr');
  kpi.forEach(([k, v], i) => { put(4 + i, 7, k); put(4 + i, 8, v, typeof v === 'number' ? 'wm-num' : ''); });

  // Memos block ← recent chat, split into note + owner like a comments column.
  let mr = 4 + kpi.length + 2;
  put(mr, 7, 'Recent Memos', 'wm-hdr'); put(mr, 8, 'Owner', 'wm-hdr');
  mr++;
  for (const c of workChat.slice(-12)) {
    const i = c.indexOf(': ');
    put(mr, 7, i > 0 ? c.slice(i + 2) : c); put(mr, 8, i > 0 ? c.slice(0, i) : '');
    mr++;
  }

  return { cells, total };
}

function renderWorkGrid() {
  const { cells, total } = buildWorkCells();
  let html = '<table><thead><tr><th class="wm-corner"></th>';
  for (let c = 0; c < WM_COLS; c++) html += `<th class="wm-colh">${wmColLetter(c)}</th>`;
  html += '</tr></thead><tbody>';
  for (let r = 1; r <= WM_ROWS; r++) {
    html += `<tr><th class="wm-rowh">${r}</th>`;
    for (let c = 1; c <= WM_COLS; c++) {
      const cell = cells.get(`${r},${c}`);
      if (cell) {
        const attr = cell.btn ? ` data-wm-btn="${cell.btn}"` : '';
        html += `<td class="${cell.cls ?? ''}"${attr}>${escapeHtml(cell.v)}</td>`;
      } else html += '<td></td>';
    }
    html += '</tr>';
  }
  wmGridEl.innerHTML = html + '</tbody></table>';
  const lastCoinRow = 3 + STOCKS.length;
  wmFormulaEl.textContent = `=SUMPRODUCT(B4:B${lastCoinRow},D4:D${lastCoinRow})`;
  wmStatusEl.textContent = `Sum: ${Math.round(total).toLocaleString()}   Avg: ${STOCKS.length ? Math.round(total / STOCKS.length).toLocaleString() : 0}   Count: ${STOCKS.length}`;
}

// Terminal disguise: a tab per toolbar button (same data-wm-btn delegation as the grid)
// plus a shell body whose "command output" is the live game data.
function renderTerm() {
  tmTabsEl.innerHTML = WM_MENU_IDS
    .map((id) => `<span class="tm-tab" data-wm-btn="${id}">${escapeHtml(wmBtnLabel(id))}</span>`)
    .join('');
  tmBodyEl.innerHTML = buildTermBody();
}

function buildTermBody(): string {
  const fmt = (n: number) => Math.round(n).toLocaleString();
  const padR = (s: string | number, n: number) => String(s).padEnd(n);
  const padL = (s: string | number, n: number) => String(s).padStart(n);
  const prompt = '<span class="tm-prompt">ops@prod-1</span>:<span class="tm-path">~/ops</span>$ ';
  const L: string[] = [];

  L.push(`${prompt}./status.sh --live`);
  L.push('<span class="tm-dim">resolving services ............ ok</span>');
  L.push('');

  // Market ← the crypto positions.
  L.push('<span class="tm-key">== market ====================================</span>');
  L.push('<span class="tm-dim"> TICKER     LAST     CHG%      QTY     VALUE</span>');
  for (const s of STOCKS) {
    const p = market.prices.find((x) => x.id === s.id);
    const price = p?.price ?? s.base;
    const ser = market.history.find((h) => h.id === s.id)?.series;
    const line = ser?.['1d']?.length ? ser['1d'] : (ser?.['1h'] ?? []);
    const chg = line.length >= 2 && line[0] > 0
      ? ((line[line.length - 1] - line[0]) / line[0]) * 100
      : (p && p.prev > 0 ? ((p.price - p.prev) / p.prev) * 100 : 0);
    const longH = market.holdings.find((h) => h.id === s.id && h.side === 'long');
    const shortH = market.holdings.find((h) => h.id === s.id && h.side === 'short');
    const qty = (longH?.shares ?? 0) + (shortH?.shares ?? 0);
    const val = (longH?.worth ?? 0) + (shortH?.worth ?? 0);
    const chgTxt = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
    const chgSpan = `<span class="${chg >= 0 ? 'tm-pos' : 'tm-neg'}">${padL(chgTxt, 8)}</span>`;
    L.push(` ${padR(s.ticker, 7)} ${padL(price.toFixed(2), 8)} ${chgSpan} ${padL(qty > 0 ? qty.toFixed(2) : '-', 8)} ${padL(val > 0 ? fmt(val) : '-', 9)}`);
  }
  L.push('');

  // Accounts ← the net-worth board.
  L.push('<span class="tm-key">== accounts (net worth) ======================</span>');
  L.push('<span class="tm-dim"> ACCOUNT            NET     CASH      LIAB</span>');
  for (const n of lastNwRows.slice(0, 8)) {
    L.push(escapeHtml(` ${padR(n.name, 14)} ${padL(fmt(n.net), 9)} ${padL(fmt(n.coins), 8)} ${padL(fmt(n.loan || 0), 9)}`));
  }
  L.push('');

  // Standings ← the win/loss board.
  L.push('<span class="tm-key">== standings =================================</span>');
  L.push('<span class="tm-dim"> EMPLOYEE          W     L      ELO</span>');
  for (const l of lastLbRows.slice(0, 8)) {
    L.push(escapeHtml(` ${padR(l.name, 14)} ${padL(l.wins, 5)} ${padL(l.losses, 5)} ${padL(l.elo, 8)}`));
  }
  L.push('');

  // Session ← the live match.
  const statusText = !state ? 'idle' : state.status === 'over' ? 'closed' : state.status === 'playing' ? 'running' : 'pending';
  L.push('<span class="tm-key">== session ===================================</span>');
  L.push(escapeHtml(` division.a : ${padR(state?.paddles.left.name ?? 'vacant', 14)} units ${state?.score.left ?? 0}`));
  L.push(escapeHtml(` division.b : ${padR(state?.paddles.right.name ?? 'vacant', 14)} units ${state?.score.right ?? 0}`));
  L.push(escapeHtml(` phase: ${padR(statusText, 9)} throughput: ${state ? Math.round(state.ballSpeed) : 0}`));
  L.push('');

  // Recent log ← chat.
  const tail = workChat.slice(-5);
  if (tail.length) {
    L.push('<span class="tm-key">== tail -n5 ops.log ==========================</span>');
    for (const c of tail) L.push('<span class="tm-dim">' + escapeHtml(' ' + c) + '</span>');
    L.push('');
  }

  const riskM = document.getElementById('msPct')?.textContent?.match(/[\d,]+%/g);
  const riskPct = riskM ? riskM[riskM.length - 1] : '0%';
  L.push(escapeHtml(`wallet: ${fmt(wallet.coins)} coins  |  open positions: ${market.holdings.length}  |  risk: ${riskPct}`));
  L.push('');
  L.push(`${prompt}<span class="tm-cursor"></span>`);
  return L.join('\n');
}

// Shared enter/exit plumbing for both disguises: mute the game without touching the saved
// pref, retitle the tab, and on exit close any menu opened from the disguise.
function enterDisguise(title: string) {
  workPrevMuted = muted;
  if (!muted) { muted = true; applyMute(); }
  document.title = title;
  // The boss key can fire mid-game: freeze a running DOOM run (the 'bosskey' event) and close the
  // open world, so nothing keeps simulating (and getting you killed) behind the disguise.
  worldMod?.exitWorld();
  window.dispatchEvent(new CustomEvent('bosskey', { detail: { active: true } }));
}
function exitDisguise() {
  if (muted && !workPrevMuted) { muted = false; applyMute(); }
  document.title = ORIGINAL_TITLE;
  // Close any dropdown opened from the disguise so it doesn't linger on the game view.
  document.querySelectorAll(WM_PANEL_SEL).forEach((b) => (b as HTMLElement).click());
  document.body.classList.remove('wm-menus');
  window.dispatchEvent(new CustomEvent('bosskey', { detail: { active: false } })); // resume DOOM
}

function setWorkMode(on: boolean) {
  if (on === workOn) return;
  if (on && termOn) setTermMode(false); // the two disguises are mutually exclusive
  workOn = on;
  workModeEl.hidden = !on;
  workModeEl.setAttribute('aria-hidden', String(!on));
  if (on) { enterDisguise('FY25_Operating_Model.xlsx - Google Sheets'); renderWorkGrid(); }
  else exitDisguise();
}
workBtn.addEventListener('click', () => setWorkMode(true));

function setTermMode(on: boolean) {
  if (on === termOn) return;
  if (on && workOn) setWorkMode(false);
  termOn = on;
  termModeEl.hidden = !on;
  termModeEl.setAttribute('aria-hidden', String(!on));
  if (on) { enterDisguise('prod-1 — ssh ops@prod-1 — 120×34'); renderTerm(); }
  else exitDisguise();
}
termBtn.addEventListener('click', () => setTermMode(true));

// Reflect whether a toolbar dropdown/modal is open: lift it above the disguise (and hide
// its trigger button) via the `wm-menus` body class while a disguise is active.
function wmSyncMenus() {
  document.body.classList.toggle('wm-menus', inDisguise() && !!document.querySelector(WM_PANEL_SEL));
}
// A click on a menu cell/tab opens the real dropdown/modal by dispatching a click on the
// underlying button — reusing all its existing toggle, close-others, and outside-click
// logic. stopPropagation keeps the disguise click from reaching the document close-handlers
// (which would otherwise immediately shut the panel we just opened).
function wmMenuClick(e: Event) {
  const el = (e.target as HTMLElement).closest('[data-wm-btn]') as HTMLElement | null;
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  document.getElementById(el.dataset.wmBtn!)?.click();
  wmSyncMenus();
}
wmGridEl.addEventListener('click', wmMenuClick);
tmTabsEl.addEventListener('click', wmMenuClick);
// Recompute after any other click (e.g. clicking the body closes an open dropdown).
document.addEventListener('click', () => { if (inDisguise()) wmSyncMenus(); });
// Whether focus is in a place where Cmd+X should still mean "cut" (chat box, name field…).
function isEditableTarget(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null;
  return !!n && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.isContentEditable);
}
// Boss key + Esc. Capture phase so they fire regardless of focus or which game overlay is up.
// Cmd/Ctrl+X toggles the spreadsheet disguise from ANY mode (pong, DOOM, open world…); Esc exits.
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'x' || e.key === 'X') && !isEditableTarget(document.activeElement)) {
    e.preventDefault(); e.stopImmediatePropagation();
    if (workOn || termOn) { setWorkMode(false); setTermMode(false); } // a disguise is up → drop it
    else if (bossKeyTarget === 'terminal') setTermMode(true); // open the chosen disguise
    else setWorkMode(true);
    return;
  }
  if (e.key !== 'Escape') return;
  if (workOn) { e.preventDefault(); e.stopPropagation(); setWorkMode(false); }
  else if (termOn) { e.preventDefault(); e.stopPropagation(); setTermMode(false); }
}, true);

function loop(t: number) {
  sampleFps(t);
  if (workOn && t - workLastPaint > 450) { workLastPaint = t; renderWorkGrid(); }
  if (termOn && t - termLastPaint > 450) { termLastPaint = t; renderTerm(); }
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
    if (state?.rotated === 1) {
      // 90° CW: paddle horizontal; right on screen = decreasing court-Y.
      if (keys.has('arrowright') || keys.has('d')) target -= step;
      if (keys.has('arrowleft') || keys.has('a')) target += step;
    } else if (state?.rotated === 2) {
      // 180°: court upside-down; controls inverted vertically.
      if (keys.has('arrowup') || keys.has('w')) target += step;
      if (keys.has('arrowdown') || keys.has('s')) target -= step;
    } else if (state?.rotated === 3) {
      // 270° CW: paddle horizontal; right on screen = increasing court-Y.
      if (keys.has('arrowright') || keys.has('d')) target += step;
      if (keys.has('arrowleft') || keys.has('a')) target -= step;
    } else if (state?.viewMode === 'firstperson') {
      // First-person: left/right keys match screen direction; direction flips for right side.
      const sign = myRole === 'right' ? -1 : 1;
      if (keys.has('arrowright') || keys.has('d')) target += sign * step;
      if (keys.has('arrowleft') || keys.has('a')) target -= sign * step;
    } else {
      if (keys.has('arrowup') || keys.has('w') || mobileUpHeld) target -= step;
      if (keys.has('arrowdown') || keys.has('s') || mobileDownHeld) target += step;
      // Roam power-up: ←/→ push the freed paddle into the court (toward center) and back.
      if (myRoamHits() > 0) {
        const sign = myRole === 'right' ? -1 : 1;
        if (keys.has('arrowright') || keys.has('d')) targetX = clampRoam(targetX + sign * step);
        if (keys.has('arrowleft') || keys.has('a')) targetX = clampRoam(targetX - sign * step);
      }
    }
    target = Math.max(PADDLE.h / 2, Math.min(COURT.h - PADDLE.h / 2, target));
    // Once roaming ends, relax the local inset so the next pickup starts at the wall.
    if (myRoamHits() <= 0) targetX = 0;

    // Drunk wobble: a smooth low-frequency sway added to the SENT paddle Y (your intended `target`
    // stays put, but the paddle the server sees drifts), so higher levels are harder to control.
    let sendY = target;
    if (drunkLevel > 0) {
      const amp = drunkLevel * 4; // ~4px/level per wave → up to ~36px sway at level 6
      const sway = Math.sin(t / 470) * amp + Math.sin(t / 230) * amp * 0.5;
      sendY = Math.max(PADDLE.h / 2, Math.min(COURT.h - PADDLE.h / 2, target + sway));
    }
    // Send when Y (or, while roaming, the inset X) changed meaningfully, throttled to ~30/s.
    // While drunk the sway is always moving, so keep streaming so the wobble actually reaches the server.
    const roaming = myRoamHits() > 0;
    const changed = Math.abs(target - lastSent) > 0.5 || (roaming && Math.abs(targetX - lastSentX) > 0.5) || drunkLevel > 0;
    if (changed && t - lastSendAt > 33) {
      net.send(roaming ? { type: 'paddle', y: sendY, x: targetX } : { type: 'paddle', y: sendY });
      lastSent = target;
      lastSentX = targetX;
      lastSendAt = t;
    }
  }

  // Feed the local blaster aim to the renderers (null when not holding the power-up).
  const armedSide = myAmmo() > 0 ? myDuelSide() : null;
  if (!armedSide) aimAngle = 0; // reset so the next pickup starts aiming straight across
  const aim = armedSide ? { side: armedSide, angle: aimAngle } : null;
  setBlasterAim(aim);

  if (state) {
    // In 3D view, a fatality temporarily takes over the 2D board (the cinematics are 2D
    // canvas effects that composite over the full court frame). Swap surfaces on the edge.
    const showFatality2d = state.viewMode !== 'normal' && !!state.fatality;
    if (showFatality2d !== fatality2dActive) {
      fatality2dActive = showFatality2d;
      document.body.classList.toggle('fatality-2d', showFatality2d);
      if (!showFatality2d && state.viewMode !== 'normal') renderer3d?.resize();
    }
    applyCanvasRotation(state.rotated);
    applyScreenFx(state);
    if (state.viewMode !== 'normal' && renderer3d && !state.fatality) {
      const side = state.viewMode === 'firstperson'
        ? (myRole !== 'observer' ? (myRole as 'left' | 'right') : fpSide)
        : null;
      renderer3d.render(state, side, aim);
    } else {
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
  renderTournament(state.tournament);
  renderBetBoard(state);
  // The bet panel lives under the court (not in the shop), so it must refresh every frame —
  // otherwise live odds, seat changes, and your placed bets only update on a page reload.
  syncBetSection();
  if (!shopPanel.hidden) {
    // Repaint animated skin previews every frame while the shop is open
    for (const { canvas, id, slot } of shopPreviewCanvases) drawCosmeticPreview(canvas, id, slot);
  }
  if (!powerupInfoPanel.hidden) syncPowerupSpawnability();
  blockControl.hidden = !canAddBlock();

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
  if (document.activeElement !== breakoutModeEl && breakoutModeEl.checked !== state.breakout) {
    breakoutModeEl.checked = state.breakout;
  }
  if (document.activeElement !== fogModeEl && fogModeEl.checked !== state.fog) {
    fogModeEl.checked = state.fog;
  }
  if (document.activeElement !== portalModeEl && portalModeEl.checked !== state.portal) {
    portalModeEl.checked = state.portal;
  }
  if (document.activeElement !== bumpersModeEl && bumpersModeEl.checked !== state.bumpers) {
    bumpersModeEl.checked = state.bumpers;
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

  // Count match wins toward the World "win 10 tsong games" objective (once per 'over' screen).
  // The World panel reads this counter and claims the reward when you next visit town.
  if (state.status !== 'over') pongWinCounted = false;
  else if (!pongWinCounted) {
    pongWinCounted = true;
    if (state.winner && myName && state.winner === myName) {
      try {
        const k = 'tsong.world.pongWins';
        localStorage.setItem(k, String((parseInt(localStorage.getItem(k) || '0', 10) || 0) + 1));
      } catch { /* ignore */ }
    }
  }

  if (state.status === 'waiting') statusEl.textContent = 'Waiting for players…';
  else if (state.status === 'over') {
    if (state.fatality) statusEl.textContent = '☠  F A T A L I T Y  ☠';
    else if (canFinish()) statusEl.textContent = '🔪 FINISH HIM!  ·  tap a combo (see Combos ▸)';
    else statusEl.textContent = state.winner ? `🏆 ${state.winner} wins!` : 'Game over';
  } else if (state.paused) {
    // Match is frozen until both players capture their mouse/touch. Once an opponent is
    // ready, a laggard is on the clock (captureCountdown) before being benched.
    const cd = state.captureCountdown;
    const mob = isMobileView();
    if (isPlayer() && !pointerLocked && !mobileCaptured) {
      // Player hasn't tapped/clicked yet — show capture prompt appropriate to their device.
      statusEl.textContent = mob
        ? (cd != null ? `👆 tap the board — ${cd}s or you're benched!` : '👆 tap the board to start')
        : (cd != null ? `🖱 click the board NOW — ${cd}s to capture your mouse or you're benched!` : '🖱 click the board to capture your mouse to start');
    } else if (isPlayer())
      statusEl.textContent =
        cd != null
          ? `⏳ waiting on the other player — ${cd}s before they're benched`
          : '⏸ waiting for the other players…';
    else
      statusEl.textContent =
        cd != null
          ? `⏳ waiting for players to capture — ${cd}s`
          : '⏸ paused — waiting for players to capture their mice';
  } else if (isPlayer() && !pointerLocked) {
    // Playing but mouse/pointer isn't locked. On mobile this is expected (no pointer lock),
    // so suppress the desktop capture prompt; the ▲▼ buttons provide the control hint.
    statusEl.textContent = isMobileView()
      ? ''
      : '🖱 click the board to capture · ↑/↓ or W/S to move · Esc to release';
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

  // Ready / Rematch buttons when the match is over and you hold a paddle (classic only).
  if (state.status === 'over' && isPlayer() && !state.poly) {
    const alreadyReady = state.ready[myRole as 'left' | 'right'];
    readyBtn.style.display = 'inline-block';
    readyBtn.textContent = alreadyReady ? '✓ Ready' : 'Ready?';
    rematchBtn.style.display = 'inline-block';
    if (!alreadyReady) {
      rematchBtn.textContent = '🔄 Rematch';
      rematchBtn.disabled = false;
    }
  } else {
    readyBtn.style.display = 'none';
    rematchBtn.style.display = 'none';
    rematchBtn.disabled = false;
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
  // Quit game: only while you hold a paddle. Forfeiting vacates your seat, so the
  // side reverts to "— open —" for everyone.
  quitBtn.style.display = isPlayer() ? 'inline-block' : 'none';

  // Mobile ▲/▼ buttons: visible while the player is in a live match in duel mode.
  // Hidden in arena mode (paddle direction isn't vertical), during waiting/over states,
  // and on desktop (the media query enforces that, but guard in JS too).
  mobileControlsEl.classList.toggle(
    'show',
    isMobileView() && isPlayer() && !state.poly && state.status === 'playing',
  );

  // Hidden once the pointer is captured (lock hides it natively anyway); visible while
  // unlocked so a player can see where to click to capture, and for observers.
  canvas.style.cursor = isPlayer() && pointerLocked ? 'none' : 'default';
  game3dEl.style.cursor = isPlayer() && pointerLocked ? 'none' : isPlayer() ? 'pointer' : 'default';
  watchersEl.textContent = state.watchers.length
    ? `Watching: ${state.watchers.join(', ')}`
    : '';

  // Update page title with live headcount so other tabs show match activity.
  const playerNames = [
    ...state.paddles.left.players.map((p) => p.name),
    ...state.paddles.right.players.map((p) => p.name),
  ].filter(Boolean);
  const watching = state.watchers.length;
  if (playerNames.length >= 2) {
    const vs = playerNames.slice(0, 2).join(' vs ');
    document.title = watching
      ? `${vs} · ${watching} watching — TSONG`
      : `${vs} — TSONG`;
  } else if (!pingTitleTimer && !chatTitleTimer) {
    document.title = ORIGINAL_TITLE;
  }
}

// --- active power-up HUD ---
// Colors mirror the in-game target ring palette (TARGET_STYLE in render.ts).
const PU_CHIP_COLOR: Record<string, string> = {
  slow: '#7aa2ff', ghost: '#c8beff', tiny: '#ff8c42', bigball: '#fb923c',
  freeze: '#88d8f7', blind: '#9988bb', mirror: '#ff7eb3',
  grow: '#ffd166', shrink: '#5ad1e6', smash: '#ff6b3d', blaster: '#ff4d4d',
  roam: '#4ade80',
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
    if (p.roamHits > 0)    chips.push(puChip('roam',   `${tag} roam ×${p.roamHits}`));
    if (p.freezeTimer > 0) chips.push(puChip('freeze', `${tag} frozen ${t1(p.freezeTimer)}`));
    if (p.blindTimer > 0)  chips.push(puChip('blind',  `${tag} blind ${t1(p.blindTimer)}`));
    if (p.mirrorTimer > 0) chips.push(puChip('mirror', `${tag} mirror ${t1(p.mirrorTimer)}`));
    if (p.ammo > 0)        chips.push(puChip('blaster', `${tag} 🔫 ×${p.ammo} — click to fire`));
    if (p.disabled)        chips.push(puChip('blaster', `${tag} ⚡ disabled`));
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

// Track each player's last-known ELO so we can show a delta when it changes.
const prevElo = new Map<string, number>();

function renderLeaderboard(rows: LeaderboardRow[], selfElo?: number, selfRank?: number) {
  lastLbRows = rows;
  // A message carries fresh self data; a plain re-render reuses the last known values.
  if (selfElo !== undefined || selfRank !== undefined) { lastLbSelfElo = selfElo; lastLbSelfRank = selfRank; }
  else { selfElo = lastLbSelfElo; selfRank = lastLbSelfRank; }
  if (!rows.length) {
    leaderboardEl.innerHTML = '';
    return;
  }

  // Detect ELO changes for our own name and show a delta banner.
  // Only fire when the match is freshly over — not on the initial connect load.
  if (myName && prevStatus === 'over') {
    const mine = rows.find((r) => r.name === myName);
    if (mine) {
      const prev = prevElo.get(myName);
      if (prev !== undefined && mine.elo !== prev) {
        const delta = mine.elo - prev;
        const sign = delta > 0 ? '+' : '';
        const color = delta > 0 ? '#4ade80' : '#f87171';
        showAnnouncement(`${sign}${delta} ELO`, { color });
      }
      prevElo.set(myName, mine.elo);
    }
  } else if (myName) {
    const mine = rows.find((r) => r.name === myName);
    if (mine && !prevElo.has(myName)) prevElo.set(myName, mine.elo);
  }

  const items = rows
    .map((r, i) => {
      const t = r.title ? (COSMETICS.find((c) => c.id === r.title) ?? EXCLUSIVES.find((e) => e.id === r.title)) : undefined;
      const tag = t ? `<span class="lbtitle${r.title === 'opstask' ? ' rainbow' : ''}">${escapeHtml(t.name)}</span>` : '';
      return `<li data-rank="${i}"><span class="rank">${i + 1}</span><span class="lbname">${escapeHtml(
        r.name,
      )}${tag}${bountyBadgeHtml(r.name)}</span><span class="pct">${r.elo ?? 500}</span>${rowActionsHtml(r.name)}</li>`;
    })
    .join('');
  let selfRow = '';
  if (selfElo !== undefined && selfRank !== undefined && myName && !rows.some((r) => r.name === myName)) {
    selfRow = `<li class="self-row"><span class="rank">#${selfRank}</span><span class="lbname">${escapeHtml(myName)}</span><span class="pct">${selfElo}</span></li>`;
  }
  leaderboardEl.innerHTML = `<h2>Leaderboard</h2><ol>${items}${selfRow}</ol>`;
}

// A small gold "tip" button for a player's board row — omitted for your own name (you
// can't tip yourself) and before you've joined. Clicking it opens the tip dialog.
function tipBtnHtml(name: string): string {
  if (!joined || !name || name === myName) return '';
  return `<button class="tip-btn" data-tip-name="${escapeHtml(name)}" title="Tip ${escapeHtml(name)} coins">🪙 tip</button>`;
}

// A "bounty" button for a player's board row — like the tip button, hidden for your own name
// (you can't bounty yourself). Clicking it opens the bounty dialog.
function bountyBtnHtml(name: string): string {
  if (!joined || !name || name === myName) return '';
  return `<button class="bounty-btn" data-bounty-name="${escapeHtml(name)}" title="Put a bounty on ${escapeHtml(name)} — whoever beats them next claims it">🎯</button>`;
}

// The tip + bounty buttons, grouped into one grid cell so the boards keep a fixed column count.
function rowActionsHtml(name: string): string {
  return `<span class="row-actions">${bountyBtnHtml(name)}${tipBtnHtml(name)}</span>`;
}

// A 🎯 badge showing the pot riding on a player (shown inline by their name when one exists).
function bountyBadgeHtml(name: string): string {
  const pot = bounties.get(name.toLowerCase());
  if (!pot) return '';
  return ` <span class="bounty-badge" title="${pot.toLocaleString()} coin bounty — beat them to claim it">🎯${pot.toLocaleString()}</span>`;
}

// The Net Worth board: coins + live stock holdings − debt owed to Davis. The
// richest player wears a 👑; anyone underwater (debt > assets) shows in red with
// the amount they still owe. Ranks the whole economy, not just match wins.
function renderNetWorth(rows: NetWorthRow[], selfRow?: NetWorthRow, selfRank?: number) {
  lastNwRows = rows;
  // A message carries fresh self data; a plain re-render reuses the last known values.
  if (selfRow !== undefined || selfRank !== undefined) { lastNwSelfRow = selfRow; lastNwSelfRank = selfRank; }
  else { selfRow = lastNwSelfRow; selfRank = lastNwSelfRank; }
  if (!rows.length) {
    netWorthEl.innerHTML = '';
    return;
  }
  const items = rows
    .map((r, i) => {
      const crown = i === 0 ? '👑 ' : '';
      const broke = r.net < 0 ? ' broke' : '';
      const debt = r.loan > 0 ? `<span class="debt"> 🔻${r.loan}</span>` : '';
      const t = r.title ? (COSMETICS.find((c) => c.id === r.title) ?? EXCLUSIVES.find((e) => e.id === r.title)) : undefined;
      const tag = t ? `<span class="lbtitle${r.title === 'opstask' ? ' rainbow' : ''}">${escapeHtml(t.name)}</span>` : '';
      return `<li data-rank="${i}" title="View balance sheet"><span class="rank">${i + 1}</span><span class="lbname">${crown}${escapeHtml(
        r.name,
      )}${tag}${debt}${bountyBadgeHtml(r.name)}</span><span class="worth${broke}">${r.net}🪙</span>${rowActionsHtml(r.name)}</li>`;
    })
    .join('');
  // Pin the player's own row to the bottom when they're below the visible top-N. No data-rank
  // (it's not an index into the board), so the balance-sheet click handler skips it.
  let selfLi = '';
  if (selfRow && selfRank !== undefined && !rows.some((r) => r.name === selfRow!.name)) {
    const broke = selfRow.net < 0 ? ' broke' : '';
    const debt = selfRow.loan > 0 ? `<span class="debt"> 🔻${selfRow.loan}</span>` : '';
    selfLi = `<li class="self-row"><span class="rank">#${selfRank}</span><span class="lbname">${escapeHtml(selfRow.name)}${debt}</span><span class="worth${broke}">${selfRow.net}🪙</span></li>`;
  }
  netWorthEl.innerHTML = `<h2>💰 Net Worth</h2><ol>${items}${selfLi}</ol>`;
}

// Click a Net Worth row to ask the server for that player's balance sheet (resolved by
// rank — the index into the board the server last sent). Event-delegated so it survives
// every re-render.
netWorthEl.addEventListener('click', (e) => {
  // A tip/bounty button takes priority over the row's balance-sheet view.
  const bountyBtn = (e.target as HTMLElement).closest('.bounty-btn') as HTMLElement | null;
  if (bountyBtn) { openBountyDialog(bountyBtn.dataset.bountyName ?? ''); return; }
  const tipBtn = (e.target as HTMLElement).closest('.tip-btn') as HTMLElement | null;
  if (tipBtn) { openTipDialog(tipBtn.dataset.tipName ?? ''); return; }
  const selfRow = (e.target as HTMLElement).closest('.self-row') as HTMLElement | null;
  if (selfRow) { net.send({ type: 'eloProfileReq', rank: 0, self: true }); return; }
  const li = (e.target as HTMLElement).closest('li[data-rank]') as HTMLElement | null;
  if (!li) return;
  const rank = Number(li.dataset.rank);
  if (Number.isInteger(rank)) net.send({ type: 'balanceSheetReq', rank });
});

// Click a leaderboard row to ask the server for that player's Elo profile.
leaderboardEl.addEventListener('click', (e) => {
  const bountyBtn = (e.target as HTMLElement).closest('.bounty-btn') as HTMLElement | null;
  if (bountyBtn) { openBountyDialog(bountyBtn.dataset.bountyName ?? ''); return; }
  const tipBtn = (e.target as HTMLElement).closest('.tip-btn') as HTMLElement | null;
  if (tipBtn) { openTipDialog(tipBtn.dataset.tipName ?? ''); return; }
  const selfRow = (e.target as HTMLElement).closest('.self-row') as HTMLElement | null;
  if (selfRow) { net.send({ type: 'eloProfileReq', rank: 0, self: true }); return; }
  const li = (e.target as HTMLElement).closest('li[data-rank]') as HTMLElement | null;
  if (!li) return;
  const rank = Number(li.dataset.rank);
  if (Number.isInteger(rank)) net.send({ type: 'eloProfileReq', rank });
});

// Render and open the balance-sheet modal from a server response.
function showBalanceSheet(msg: BalanceSheetMsg) {
  balanceName.textContent = `💰 ${msg.name}`;
  const rows: string[] = [];
  rows.push(
    `<div class="bs-row"><span class="bs-label">Coins on hand</span><span class="bs-val">${msg.coins}🪙</span></div>`,
  );
  rows.push(`<div class="bs-section">Stock holdings</div>`);
  if (msg.holdings.length) {
    for (const h of msg.holdings) {
      const tag = h.side === 'short' ? '<span class="pos-short">SHORT</span> ' : '';
      rows.push(
        `<div class="bs-row"><span class="bs-label">${tag}${escapeHtml(h.ticker)} ` +
          `<span class="bs-sub">${h.shares.toFixed(2)} sh @ ${Math.round(h.price)}🪙</span></span>` +
          `<span class="bs-val">${h.value}🪙</span></div>`,
      );
    }
    rows.push(
      `<div class="bs-row"><span class="bs-label">Stock subtotal</span><span class="bs-val">${msg.stockValue}🪙</span></div>`,
    );
  } else {
    rows.push(`<div class="bs-empty">No open positions.</div>`);
  }
  if (msg.loan > 0) {
    rows.push(
      `<div class="bs-row bs-debt"><span class="bs-label">Owed to Davis</span><span class="bs-val">−${msg.loan}🪙</span></div>`,
    );
  }
  rows.push(`<hr class="bs-divider" />`);
  const broke = msg.net < 0 ? ' bs-broke' : '';
  rows.push(
    `<div class="bs-row bs-total${broke}"><span class="bs-label">Net worth</span><span class="bs-val">${msg.net}🪙</span></div>`,
  );
  balanceBody.innerHTML = rows.join('');
  balanceModal.hidden = false;
}
function closeBalanceSheet() {
  balanceModal.hidden = true;
}
balanceClose.addEventListener('click', closeBalanceSheet);
balanceModal.addEventListener('click', (e) => {
  if (!balanceCard.contains(e.target as Node)) closeBalanceSheet();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !balanceModal.hidden) closeBalanceSheet();
  if (e.key === 'Escape' && !eloModal.hidden) closeEloProfile();
});

// --- Elo profile modal (opened by clicking a leaderboard row) ---

function showEloProfile(msg: EloProfileMsg) {
  eloNameEl.textContent = `🏓 ${msg.name}`;
  const total = msg.wins + msg.losses;
  const lines: string[] = [];
  lines.push(
    `<div class="bs-row"><span class="bs-label">Wins</span><span class="bs-val">${msg.wins}</span></div>`,
    `<div class="bs-row"><span class="bs-label">Losses</span><span class="bs-val">${msg.losses}</span></div>`,
    `<div class="bs-row"><span class="bs-label">Games</span><span class="bs-val">${total}</span></div>`,
    `<div class="bs-row"><span class="bs-label">Elo</span><span class="bs-val">${msg.elo}</span></div>`,
    `<div class="bs-row"><span class="bs-label">Win rate</span><span class="bs-val">${msg.winPct}%</span></div>`,
    `<div class="bs-row"><span class="bs-label">Last played</span><span class="bs-val">${fmtLastPlayed(msg.lastPlayed)}</span></div>`,
  );
  if (msg.rival) {
    const r = msg.rival;
    lines.push(`<hr class="bs-divider" />`);
    lines.push(`<div class="bs-section">Head‑to‑head vs ${escapeHtml(r.name)}</div>`);
    lines.push(
      `<div class="bs-row"><span class="bs-label">Record</span><span class="bs-val">${r.wins}–${r.losses}</span></div>`,
    );
  }
  eloBody.innerHTML = lines.join('');
  eloModal.hidden = false;
}
function closeEloProfile() {
  eloModal.hidden = true;
}
eloClose.addEventListener('click', closeEloProfile);
eloModal.addEventListener('click', (e) => {
  if (!eloCard.contains(e.target as Node)) closeEloProfile();
});

/** Format an epoch-ms timestamp as a friendly relative string (e.g. "3h ago"). */
function fmtLastPlayed(ts: number | null): string {
  if (!ts) return 'Never';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

// --- tip / bounty dialog (opened by the 🪙 tip or 🎯 bounty button on the boards) ---
// One modal serves both: `dialogMode` decides the labels and which message gets sent on submit.
let tipTarget = ''; // nickname currently being tipped / bountied
let dialogMode: 'tip' | 'bounty' = 'tip';
function openTipDialog(name: string) {
  if (!name || name === myName || !joined) return;
  dialogMode = 'tip';
  tipTarget = name;
  tipTitle.textContent = `Tip ${name}`;
  tipBalance.textContent = `You have ${wallet.coins.toLocaleString()} 🪙`;
  tipSend.textContent = 'Send tip 🪙';
  tipStatus.textContent = '';
  tipAmount.value = '';
  tipModal.hidden = false;
  tipAmount.focus();
}
function openBountyDialog(name: string) {
  if (!name || name === myName || !joined) return;
  dialogMode = 'bounty';
  tipTarget = name;
  const cur = bounties.get(name.toLowerCase());
  tipTitle.textContent = `🎯 Bounty on ${name}`;
  tipBalance.textContent = cur
    ? `Current pot: ${cur.toLocaleString()}🪙 · you have ${wallet.coins.toLocaleString()}🪙`
    : `You have ${wallet.coins.toLocaleString()} 🪙`;
  tipSend.textContent = 'Place bounty 🎯';
  tipStatus.textContent = 'Whoever beats them next claims the whole pot.';
  tipAmount.value = '';
  tipModal.hidden = false;
  tipAmount.focus();
}
function closeTipDialog() {
  tipModal.hidden = true;
  tipTarget = '';
}
function submitTip() {
  const amount = Number(tipAmount.value);
  if (!Number.isInteger(amount) || amount <= 0) {
    tipStatus.textContent = 'Enter a whole number of coins.';
    return;
  }
  if (amount > wallet.coins) {
    tipStatus.textContent = "You don't have that many coins.";
    return;
  }
  net.send(dialogMode === 'bounty' ? { type: 'placeBounty', to: tipTarget, amount } : { type: 'tip', to: tipTarget, amount });
  closeTipDialog();
}
tipPresets.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-amt]') as HTMLElement | null;
  if (!btn) return;
  tipAmount.value = btn.dataset.amt ?? '';
  tipStatus.textContent = '';
});
tipSend.addEventListener('click', submitTip);
tipAmount.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitTip(); } });
tipClose.addEventListener('click', closeTipDialog);
tipModal.addEventListener('click', (e) => {
  if (!tipCard.contains(e.target as Node)) closeTipDialog();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !tipModal.hidden) closeTipDialog();
});

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
