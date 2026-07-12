// MONSTER JAM: STUNT SHOWDOWN — faithfully implemented from a game design dictated by a
// six-year-old game director:
//
//   "There is a monster jam arena and there are 2 monster trucks and they have to finish
//    all the stunts and whoever does it wins, and before they start, they get time to
//    practice in another arena. Players can pick which monster truck they want. Options
//    include Grave Digger, Dragon, El Toro Loco, Megalodon, Pirate's Curse, Son-uva
//    Digger, Max-D."
//
// So: pick a truck, warm up in the Practice Yard (a whole separate arena, per the spec),
// then the SHOW — first truck to land all five stunts takes the trophy.
//
// Networking follows the TNT Explosion Rally shape: the server is only a 2-slot lobby +
// dumb relay. Slot 0 (host) simulates EVERYTHING — both trucks, ramps, junk cars, and the
// solo-practice bot — and streams ~30Hz snapshots; the guest sends inputs and renders.

import type { MjLobbyMsg } from '../shared/types';

export interface MjNetHooks {
  join: () => void;
  leave: () => void;
  start: () => void;
  end: (winner: number) => void;
  relay: (data: unknown) => void;
  name: () => string;
  muted: () => boolean; // whether the main page's mute toggle is on
}

// --- world constants ---
const W = 1440;
const H = 810;
const TOP_SPEED = 430; // px/s at stat 1.0
const ACCEL = 560;
const REV_FRAC = 0.55; // reverse gear power
const TURN = 3.0; // rad/s at stat 1.0, full authority
const GRIP = 5.0; // lateral velocity bleed /s (low = drifty, monster trucks are drifty)
const FWD_DRAG = 0.65;
const GRAV = 1250; // px/s² pulling z back down
const FLIP_RATE = 6.6; // rad/s of backflip while the stunt key is held mid-air
const TAKEOFF_MIN = 180; // slower than this and a ramp is just a speed bump

// --- the five stunts (the whole game) ---
const STUNTS = [
  { icon: '🛫', name: 'BIG AIR', how: 'hit the big ramp at full speed' },
  { icon: '🔄', name: 'BACKFLIP', how: 'launch off the half-pipe, HOLD the stunt key in the air' },
  { icon: '🌀', name: 'DONUTS ×3', how: 'spin 3 circles inside the donut zone' },
  { icon: '🚗', name: 'CAR CRUSH ×4', how: 'flatten 4 junk cars' },
  { icon: '🐎', name: 'WHEELIE', how: 'hold the stunt key at speed on flat dirt' },
] as const;
const N_STUNTS = 5;
const BIG_AIR_SECS = 0.85;
const DONUT_NEED = Math.PI * 6; // three full spins
const DONUT_MIN_SPIN = 1.5; // rad/s — lazy arcs don't count
const CRUSH_NEED = 4;
const CAR_RESPAWN = 5; // the crew rolls a "new" junker in after this many seconds
const WHEELIE_SECS = 1.5;
const WHEELIE_MIN_SPD = 240;

// --- phases ---
const PICK_SECS = 30; // dawdle past this and the game picks for you
const PRACTICE_SECS = 40;
const SHOW_COUNTDOWN = 3;
const SHOW_MAX = 240; // somebody HAS to win eventually — most stunts done takes it

// --- the roster (exactly the trucks the director listed, in his order) ---
interface TruckDef {
  name: string;
  body: string; // paint
  trim: string; // decal color
  ui: string; // HUD accent
  decal: 'flames' | 'dragon' | 'toro' | 'shark' | 'pirate' | 'spikes' | 'sheep';
  blurb: string;
  top: number; // speed stat
  turn: number; // handling stat
  air: number; // hang-time stat
  bounce: number; // landing bounciness (one very specific truck)
  secret?: boolean;
}
const TRUCKS: TruckDef[] = [
  { name: 'Grave Digger', body: '#14161c', trim: '#39ff5e', ui: '#39ff5e', decal: 'flames', blurb: 'the legend', top: 1.0, turn: 1.0, air: 1.0, bounce: 0 },
  { name: 'Dragon', body: '#c8231f', trim: '#ffb023', ui: '#ff6b4f', decal: 'dragon', blurb: 'breathes fire', top: 1.03, turn: 0.96, air: 1.0, bounce: 0 },
  { name: 'El Toro Loco', body: '#f07818', trim: '#ffd24f', ui: '#ffa03f', decal: 'toro', blurb: 'the crazy bull', top: 0.96, turn: 1.1, air: 0.97, bounce: 0 },
  { name: 'Megalodon', body: '#1e5fd6', trim: '#9fe8ff', ui: '#43c8ff', decal: 'shark', blurb: 'chomp chomp', top: 0.98, turn: 0.96, air: 1.12, bounce: 0 },
  { name: "Pirate's Curse", body: '#16403d', trim: '#7dffd4', ui: '#3fd8a8', decal: 'pirate', blurb: 'yo ho ho', top: 0.97, turn: 1.05, air: 1.03, bounce: 0 },
  { name: 'Son-uva Digger', body: '#101425', trim: '#43c8ff', ui: '#6ea8ff', decal: 'flames', blurb: 'like father…', top: 1.05, turn: 1.0, air: 0.95, bounce: 0 },
  { name: 'Max-D', body: '#8f97a6', trim: '#eef2f8', ui: '#d7dce6', decal: 'spikes', blurb: 'maximum destruction', top: 1.08, turn: 0.9, air: 1.0, bounce: 0 },
  // shh. tap the title three times.
  { name: 'Mutton Masher', body: '#f2ead8', trim: '#3a2c1c', ui: '#ffb8d5', decal: 'sheep', blurb: 'baa.', top: 0.9, turn: 1.15, air: 1.18, bounce: 0.38, secret: true },
];
const BOT_NAME = '🤖 Crushbot 9000';

// --- arena furniture (same coordinates in BOTH arenas — practice like you play) ---
const RAMP = { x: W * 0.30, y: H * 0.46, a: 0, w: 150, len: 130 }; // big dirt ramp, launches +X
const PIPE = { x: W * 0.76, y: H * 0.34, a: Math.PI, w: 130, len: 100 }; // steel half-pipe, launches -X
const DONUT = { x: W * 0.60, y: H * 0.70, r: 165 };
const CARS_Y = H * 0.15;
const CAR_XS = [0, 1, 2, 3, 4].map((i) => W * 0.38 + i * 84);
const CAR_PAINTS = ['#b04a4a', '#4a7ab0', '#b09a4a', '#5ab04a', '#8a5ab0'];
const CONE_SPOTS: [number, number][] = [
  [W * 0.18, H * 0.25], [W * 0.24, H * 0.78], [W * 0.5, H * 0.58],
  [W * 0.88, H * 0.62], [W * 0.66, H * 0.14], [W * 0.12, H * 0.5],
];
const SPAWNS: { x: number; y: number; a: number }[] = [
  { x: W * 0.12, y: H * 0.62, a: 0 },
  { x: W * 0.88, y: H * 0.66, a: Math.PI },
];

// --- sim types (host only) ---
interface SimTruck {
  x: number; y: number; a: number;
  vx: number; vy: number;
  z: number; vz: number;
  pitch: number; // backflip rotation accumulated this jump
  airT: number; // current airtime
  tumbleT: number; // wipeout timer (landed on the roof)
  wheelie: boolean; wheelieT: number;
  donutAcc: number; crushN: number;
  done: boolean[]; // one per stunt
  lastA: number;
  th: number; st: number; sk: boolean; // inputs: throttle, steer, stunt key
  pick: number; ready: boolean;
  honkSeq: number; honkTimes: number[];
  rampLatch: boolean; // don't re-launch while still over the takeoff lip
}
interface JunkCar { x: number; y: number; flatUntil: number }
type Fx =
  | { k: 'land'; x: number; y: number; big: boolean }
  | { k: 'stunt'; s: number; i: number; x: number; y: number; practice: boolean }
  | { k: 'crush'; x: number; y: number }
  | { k: 'cone'; x: number; y: number }
  | { k: 'wipe'; x: number; y: number }
  | { k: 'bonk'; x: number; y: number }
  | { k: 'phase'; ph: 'practice' | 'show' }
  | { k: 'honk'; s: number }
  | { k: 'wave' }
  | { k: 'win'; s: number };
type Phase = 'pick' | 'practice' | 'show';

interface Bot {
  order: number[]; // the setlist: which stunt it goes for, in what order
  state: 'goto' | 'exec' | 'chill';
  tx: number; ty: number;
  execT: number; chillT: number;
  releasePitch: number; // when it lets go of the flip (imperfect on purpose)
  lastDone: number;
  runDir: number; // wheelie / crush run direction (+1 / -1)
}

interface Sim {
  phase: Phase; phT: number; t: number;
  tr: [SimTruck, SimTruck];
  cars: JunkCar[];
  cones: JunkCar[]; // practice-yard only; "flat" = squashed for a bit
  over: number | null;
  solo: boolean; // one human → the other seat is Crushbot
  bot: Bot | null;
  fxPend: Fx[];
  snapTimer: number;
}

// --- wire types ---
interface SnapTruck { x: number; y: number; a: number; z: number; p: number; w: number; tb: number }
interface Snap {
  t: 'snap';
  ph: Phase; phT: number; tm: number;
  tr: SnapTruck[];
  cars: number[]; cones: number[]; // 1 = flattened right now
  done: [number, number]; // bitmasks
  prog: [number, number, number][]; // per truck: [donutAcc, wheelieT, crushN]
  picks: [number, number];
  rdy: [boolean, boolean];
  fx: Fx[];
  ov: number | null;
}
interface GuestIn { t: 'in'; th: number; st: number; sk: boolean; pk: number; rd: boolean; hk: number }

// --- view (host builds from sim, guest lerps snapshots) ---
interface ViewTruck { x: number; y: number; a: number; z: number; pitch: number; wheelie: boolean; tumble: boolean }
interface View {
  ph: Phase; phT: number; tm: number;
  tr: ViewTruck[];
  cars: boolean[]; cones: boolean[];
  done: boolean[][];
  prog: [number, number, number][];
  picks: [number, number];
  rdy: [boolean, boolean];
  ov: number | null;
}

// --- module state ---
let net: MjNetHooks | null = null;
let overlay: HTMLDivElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let raf = 0;
let running = false;
let lastFrame = 0;

type Screen = 'lobby' | 'playing';
let screen: Screen = 'lobby';
let lobby: MjLobbyMsg | null = null;
let mySlot = -1;
let overNote: string | null = null;
let endReported = false;

let sim: Sim | null = null; // host only

// guest snapshot interpolation
let snapPrev: { s: Snap; at: number } | null = null;
let snapCur: { s: Snap; at: number } | null = null;

// local input
const keys = { u: false, d: false, l: false, r: false, sk: false };
let myPick = -1; // what I chose (mirrored into the sim / relayed)
let myReady = false;
let myHonks = 0;
let inputDirty = false;
let inputTimer = 0;

// pick-screen UI state
let hoverCard = -1;
let selCard = 0; // keyboard cursor
let cardRects: [number, number, number, number][] = []; // screen-space, rebuilt each draw
let titleRect: [number, number, number, number] | null = null;
let titleTaps = 0;
let sheepUnlocked = false;
let readyBtnRect: [number, number, number, number] | null = null;
let startBtnRect: [number, number, number, number] | null = null;
let mouseX = 0, mouseY = 0;

// touch (tablets): floating drive stick + a big STUNT button
const JOY_R = 60;
let touchUI = false;
let joyTouch: number | null = null;
let joyBaseX = 0, joyBaseY = 0, joyKnobX = 0, joyKnobY = 0;
let stickX = 0, stickY = 0, stickActive = false; // -1..1 screen-space vector
let stuntTouch: number | null = null;

// juice
interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color: string; grav: number; shape: 'dot' | 'confetti' | 'flame' | 'star' | 'wool'; rot: number; vr: number }
interface Floater { x: number; y: number; text: string; life: number; max: number; color: string; size: number }
interface Skid { x: number; y: number; a: number; life: number }
let particles: Particle[] = [];
let floaters: Floater[] = [];
let skids: Skid[] = [];
let shakeMag = 0;
let confettiTimer = 0;
let cheerAmp = 0; // crowd excitement (decays)
let waveT = -10; // crowd-wave start time (triple honk!)
let anns: { text: string; color: string }[] = []; // announcer queue
let annT = 0;
let lastViewTr: { x: number; y: number; a: number }[] = []; // for client-side skid stamping
let crowdSeats: { t: number; d: number; c: string; ph: number }[] | null = null;

// ---------------------------------------------------------------- lifecycle

export function startMonsterJam(hooks: MjNetHooks) {
  net = hooks;
  build();
  if (!overlay) return;
  running = true;
  try { touchUI = window.matchMedia('(pointer: coarse)').matches; } catch { /* keyboard wording it is */ }
  screen = 'lobby';
  lobby = null;
  mySlot = -1;
  sim = null;
  snapPrev = snapCur = null;
  overNote = null;
  myPick = -1;
  myReady = false;
  myHonks = 0;
  titleTaps = 0;
  particles = [];
  floaters = [];
  skids = [];
  anns = [];
  annT = 0;
  overlay.style.display = 'block';
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
  net.join();
  lastFrame = performance.now();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(loop);
}

function exit() {
  if (!running) return;
  running = false;
  cancelAnimationFrame(raf);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', onKeyUp, true);
  window.removeEventListener('blur', onBlur);
  stopEngine();
  net?.leave();
  if (overlay) overlay.style.display = 'none';
  sim = null;
  snapPrev = snapCur = null;
}

function build() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'mjOverlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:20000;background:rgba(10,8,6,0.94);display:none;touch-action:none;';
  canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;';
  overlay.appendChild(canvas);
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.title = 'Leave Monster Jam';
  closeBtn.style.cssText =
    'position:absolute;top:10px;right:12px;width:42px;height:42px;z-index:1;' +
    'background:#1a2030cc;border:1px solid #3a4150;border-radius:10px;color:#9aa4b5;' +
    'font-size:20px;line-height:1;cursor:pointer;touch-action:manipulation;';
  closeBtn.addEventListener('click', () => exit());
  overlay.appendChild(closeBtn);
  document.body.appendChild(overlay);
  ctx = canvas.getContext('2d');
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: false });
  canvas.addEventListener('touchcancel', onTouchCancel, { passive: false });
}

// ---------------------------------------------------------------- net feeds

export function feedMjLobby(msg: MjLobbyMsg) {
  if (!running) return;
  mySlot = msg.slot;
  if (msg.status === 'ended') {
    // Host bailed — the server tore the lobby down. Hop back in fresh.
    screen = 'lobby';
    lobby = null;
    sim = null;
    snapPrev = snapCur = null;
    addFloater(W / 2, H / 2, 'Host left — new lobby!', '#ffd24f', 20);
    net?.join();
    return;
  }
  const wasPlaying = lobby?.status === 'playing';
  lobby = msg;
  if (msg.status === 'playing' && screen !== 'playing') {
    beginMatch();
  } else if (msg.status === 'waiting' && screen === 'playing' && wasPlaying) {
    if (mySlot === 0 && sim && sim.over === null && !sim.solo) {
      sim.over = 0;
      overNote = 'Your opponent drove off into the sunset! 🏳️';
      snd('fanfare');
    }
  }
}

export function feedMjRelay(data: unknown) {
  if (!running) return;
  const msg = data as { t?: string };
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'in' && mySlot === 0 && sim) {
    applyGuestInput(data as GuestIn);
  } else if (msg.t === 'snap' && mySlot !== 0) {
    applySnap(data as Snap);
  }
}

function beginMatch() {
  screen = 'playing';
  overNote = null;
  endReported = false;
  particles = [];
  floaters = [];
  skids = [];
  anns = [];
  annT = 0;
  cheerAmp = 0;
  waveT = -10;
  myPick = -1;
  myReady = false;
  myHonks = 0;
  hoverCard = -1;
  selCard = 0;
  lastViewTr = [];
  if (mySlot === 0) {
    const solo = (lobby?.players.length ?? 1) < 2;
    sim = makeSim(solo);
  } else {
    sim = null;
    snapPrev = snapCur = null;
  }
  snd('rev');
}

// ---------------------------------------------------------------- input

function onKeyDown(e: KeyboardEvent) {
  if (!running) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    exit();
    return;
  }
  const k = e.key.toLowerCase();
  let used = true;
  const vw = currentView();
  if (screen === 'playing' && vw?.ph === 'pick' && myPickPending()) {
    // keyboard truck shopping
    const n = sheepUnlocked ? TRUCKS.length : TRUCKS.length - 1;
    if (k === 'arrowleft' || k === 'a') selCard = (selCard + n - 1) % n;
    else if (k === 'arrowright' || k === 'd') selCard = (selCard + 1) % n;
    else if (k === 'arrowup' || k === 'w') selCard = (selCard + n - 4) % n;
    else if (k === 'arrowdown' || k === 's') selCard = (selCard + 4) % n;
    else if (k === 'enter' || k === ' ') doPick(selCard);
    else used = false;
    if (used) { e.preventDefault(); e.stopPropagation(); }
    return;
  }
  if (k === 'w' || k === 'arrowup') keys.u = true;
  else if (k === 's' || k === 'arrowdown') keys.d = true;
  else if (k === 'a' || k === 'arrowleft') keys.l = true;
  else if (k === 'd' || k === 'arrowright') keys.r = true;
  else if (k === ' ') keys.sk = true;
  else if (k === 'r' && vw?.ph === 'practice') pressReady();
  else if (k === 'h') pressHonk();
  else used = false;
  if (used) { e.preventDefault(); e.stopPropagation(); inputDirty = true; }
}

function onKeyUp(e: KeyboardEvent) {
  if (!running) return;
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'arrowup') keys.u = false;
  else if (k === 's' || k === 'arrowdown') keys.d = false;
  else if (k === 'a' || k === 'arrowleft') keys.l = false;
  else if (k === 'd' || k === 'arrowright') keys.r = false;
  else if (k === ' ') keys.sk = false;
  else return;
  inputDirty = true;
}

function onBlur() {
  keys.u = keys.d = keys.l = keys.r = keys.sk = false;
  stickActive = false;
  joyTouch = null;
  stuntTouch = null;
  inputDirty = true;
}

function onMouseMove(e: MouseEvent) {
  mouseX = e.clientX;
  mouseY = e.clientY;
  if (screen === 'playing' && currentView()?.ph === 'pick') {
    hoverCard = cardAt(mouseX, mouseY);
    if (hoverCard >= 0) selCard = hoverCard;
  }
}

function backToLobby() {
  screen = 'lobby';
  sim = null;
  snapPrev = snapCur = null;
}

function onMouseDown(e: MouseEvent) {
  if (!running) return;
  e.preventDefault();
  pointerDown(e.clientX, e.clientY);
}

/** Shared mouse-click / touch-tap handling for all the canvas "buttons". */
function pointerDown(x: number, y: number): boolean {
  if (screen === 'lobby') { lobbyClick(x, y); return true; }
  const vw = currentView();
  if (currentOver() !== null) { backToLobby(); return true; }
  if (vw?.ph === 'pick') {
    if (titleRect && inRect(x, y, titleRect)) {
      // the secret handshake: tap the marquee three times, gain a sheep
      titleTaps++;
      if (titleTaps === 3 && !sheepUnlocked) {
        sheepUnlocked = true;
        snd('bleat');
        addFloater(W / 2, H * 0.25, '🐑 MUTTON MASHER HAS ENTERED THE BUILDING', '#ffb8d5', 26);
        for (let i = 0; i < 24; i++) spawnWool(W / 2 + (Math.random() - 0.5) * 400, H * 0.3);
      }
      return true;
    }
    const c = cardAt(x, y);
    if (c >= 0 && myPickPending()) { doPick(c); return true; }
    return false;
  }
  if (vw?.ph === 'practice' && readyBtnRect && inRect(x, y, readyBtnRect)) { pressReady(); return true; }
  return false;
}

function inRect(x: number, y: number, r: [number, number, number, number]): boolean {
  return x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];
}

function cardAt(x: number, y: number): number {
  for (let i = 0; i < cardRects.length; i++) {
    if (inRect(x, y, cardRects[i])) return i;
  }
  return -1;
}

function myPickPending(): boolean {
  return myPick < 0;
}

function doPick(i: number) {
  const n = sheepUnlocked ? TRUCKS.length : TRUCKS.length - 1;
  if (i < 0 || i >= n) return;
  myPick = i;
  snd('rev');
  addFloater(W / 2, H * 0.85, `${TRUCKS[i].name.toUpperCase()}! GREAT CHOICE!`, TRUCKS[i].ui, 24);
  if (mySlot === 0 && sim) sim.tr[0].pick = i;
  else { inputDirty = true; sendInput(); }
}

function pressReady() {
  if (myReady) return;
  myReady = true;
  snd('ding');
  if (mySlot === 0 && sim) sim.tr[0].ready = true;
  else { inputDirty = true; sendInput(); }
}

function pressHonk() {
  myHonks++;
  if (mySlot === 0 && sim) hostHonk(sim, 0);
  else { inputDirty = true; sendInput(); }
}

// --- touch: floating drive stick (left anywhere) + STUNT button + canvas buttons ---

function onTouchStart(e: TouchEvent) {
  if (!running) return;
  e.preventDefault();
  touchUI = true;
  for (const t of Array.from(e.changedTouches)) {
    const x = t.clientX, y = t.clientY;
    if (pointerDown(x, y)) continue;
    const sb = stuntBtn();
    if (Math.hypot(x - sb.x, y - sb.y) < sb.r + 12) {
      stuntTouch = t.identifier;
      keys.sk = true;
      inputDirty = true;
      continue;
    }
    if (joyTouch === null) {
      joyTouch = t.identifier;
      joyBaseX = joyKnobX = x;
      joyBaseY = joyKnobY = y;
      stickActive = true;
      stickX = 0; stickY = 0;
      inputDirty = true;
    }
  }
}

function onTouchMove(e: TouchEvent) {
  if (!running) return;
  e.preventDefault();
  for (const t of Array.from(e.changedTouches)) {
    if (t.identifier !== joyTouch) continue;
    const dx = t.clientX - joyBaseX, dy = t.clientY - joyBaseY;
    const d = Math.hypot(dx, dy);
    if (d < 8) { stickX = 0; stickY = 0; }
    else {
      const cl = Math.min(1, d / JOY_R);
      stickX = (dx / d) * cl;
      stickY = (dy / d) * cl;
    }
    joyKnobX = joyBaseX + (d ? (dx / d) * Math.min(d, JOY_R) : 0);
    joyKnobY = joyBaseY + (d ? (dy / d) * Math.min(d, JOY_R) : 0);
    inputDirty = true;
  }
}

function onTouchEnd(e: TouchEvent) {
  if (!running) return;
  e.preventDefault();
  for (const t of Array.from(e.changedTouches)) {
    if (t.identifier === joyTouch) {
      joyTouch = null;
      stickActive = false;
      stickX = 0; stickY = 0;
      inputDirty = true;
    }
    if (t.identifier === stuntTouch) {
      stuntTouch = null;
      keys.sk = false;
      inputDirty = true;
    }
  }
}

function onTouchCancel(e: TouchEvent) {
  onTouchEnd(e);
}

function stuntBtn(): { x: number; y: number; r: number } {
  return { x: window.innerWidth - 78, y: window.innerHeight - 92, r: 46 };
}

/** Turn whatever the player is holding (keys or thumb stick) into truck controls.
 *  Stick: point where you want to go — we steer toward it and drive. */
function localControls(myTruck: { a: number } | null): { th: number; st: number; sk: boolean } {
  if (stickActive && myTruck) {
    const mag = Math.hypot(stickX, stickY);
    if (mag < 0.1) return { th: 0, st: 0, sk: keys.sk };
    const want = Math.atan2(stickY, stickX);
    let diff = angDiff(want, myTruck.a);
    let th = Math.min(1, mag * 1.25);
    // pointing backwards? reverse instead of pirouetting
    if (Math.abs(diff) > Math.PI * 0.72) { th = -th * 0.9; diff = angDiff(want + Math.PI, myTruck.a); }
    return { th, st: clamp(diff * 2.4, -1, 1), sk: keys.sk };
  }
  return {
    th: (keys.u ? 1 : 0) - (keys.d ? 1 : 0),
    st: (keys.r ? 1 : 0) - (keys.l ? 1 : 0),
    sk: keys.sk,
  };
}

function sendInput() {
  if (mySlot !== 0 && screen === 'playing' && net) {
    const me = currentView()?.tr[1] ?? null;
    const c = localControls(me);
    const msg: GuestIn = {
      t: 'in',
      th: Math.round(c.th * 100) / 100,
      st: Math.round(c.st * 100) / 100,
      sk: c.sk,
      pk: myPick,
      rd: myReady,
      hk: myHonks,
    };
    net.relay(msg);
    inputDirty = false;
    inputTimer = 0;
  }
}

// ---------------------------------------------------------------- host sim

function makeSim(solo: boolean): Sim {
  const mk = (sp: { x: number; y: number; a: number }): SimTruck => ({
    x: sp.x, y: sp.y, a: sp.a, vx: 0, vy: 0, z: 0, vz: 0,
    pitch: 0, airT: 0, tumbleT: 0, wheelie: false, wheelieT: 0,
    donutAcc: 0, crushN: 0, done: new Array(N_STUNTS).fill(false), lastA: sp.a,
    th: 0, st: 0, sk: false, pick: -1, ready: false,
    honkSeq: 0, honkTimes: [], rampLatch: false,
  });
  return {
    phase: 'pick', phT: 0, t: 0,
    tr: [mk(SPAWNS[0]), mk(SPAWNS[1])],
    cars: CAR_XS.map((x) => ({ x, y: CARS_Y, flatUntil: 0 })),
    cones: CONE_SPOTS.map(([x, y]) => ({ x, y, flatUntil: 0 })),
    over: null,
    solo,
    bot: solo
      ? {
          order: shuffle([0, 1, 2, 3, 4]),
          state: 'chill', tx: 0, ty: 0, execT: 0, chillT: 1.5,
          releasePitch: Math.PI * 2, lastDone: 0, runDir: 1,
        }
      : null,
    fxPend: [],
    snapTimer: 0,
  };
}

function shuffle(a: number[]): number[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function angDiff(target: number, from: number): number {
  let d = target - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function applyGuestInput(m: GuestIn) {
  if (!sim || sim.solo) return;
  const p = sim.tr[1];
  if (typeof m.th === 'number' && isFinite(m.th)) p.th = clamp(m.th, -1, 1);
  if (typeof m.st === 'number' && isFinite(m.st)) p.st = clamp(m.st, -1, 1);
  p.sk = !!m.sk;
  if (typeof m.pk === 'number' && m.pk >= 0 && m.pk < TRUCKS.length && p.pick < 0) p.pick = Math.floor(m.pk);
  if (m.rd) p.ready = true;
  const hk = m.hk | 0;
  while (p.honkSeq < hk) { p.honkSeq++; hostHonk(sim, 1); }
}

function hostHonk(s: Sim, slot: number) {
  const p = s.tr[slot];
  emitFx(s, { k: 'honk', s: slot });
  p.honkTimes.push(s.t);
  p.honkTimes = p.honkTimes.filter((t) => s.t - t < 2);
  if (p.honkTimes.length >= 3) {
    p.honkTimes = [];
    emitFx(s, { k: 'wave' }); // triple honk → the crowd does the wave. obviously.
  }
}

function emitFx(s: Sim, e: Fx) {
  s.fxPend.push(e);
  applyFx(e); // the host feels it immediately; the guest gets it in the next snapshot
}

/** A stunt got landed. In the SHOW it counts toward the trophy; in practice it just dings. */
function markStunt(s: Sim, slot: number, idx: number) {
  const p = s.tr[slot];
  if (p.done[idx]) return;
  p.done[idx] = true;
  emitFx(s, { k: 'stunt', s: slot, i: idx, x: p.x, y: p.y, practice: s.phase !== 'show' });
  if (s.phase === 'show' && p.done.every(Boolean) && s.over === null) {
    s.over = slot;
    emitFx(s, { k: 'win', s: slot });
    sendSnap(s, true);
  }
}

function stepSim(s: Sim, dt: number) {
  if (s.over !== null) {
    if (!endReported) {
      endReported = true;
      let report = s.over;
      if (s.solo && s.over === 1) report = -1; // Crushbot's trophy is the friends it crushed along the way
      net?.end(report);
    }
    return;
  }
  s.t += dt;
  s.phT += dt;

  // host's own controls → truck 0
  const c = localControls(s.tr[0]);
  s.tr[0].th = c.th; s.tr[0].st = c.st; s.tr[0].sk = c.sk;
  s.tr[0].pick = myPick >= 0 ? myPick : s.tr[0].pick;
  if (myReady) s.tr[0].ready = true;

  // --- phase machine ---
  if (s.phase === 'pick') {
    if (s.bot && s.phT > 1.6 && s.tr[1].pick < 0) {
      s.tr[1].pick = Math.floor(Math.random() * 7); // the bot doesn't know about the sheep
    }
    if (s.phT > PICK_SECS) {
      // shot clock: undecided players get whatever's on the lot
      for (const p of s.tr) if (p.pick < 0) p.pick = Math.floor(Math.random() * 7);
    }
    if (s.tr[0].pick >= 0 && s.tr[1].pick >= 0) {
      startPhase(s, 'practice');
    }
    return; // trucks don't move while shopping
  }
  if (s.phase === 'practice') {
    const humansReady = s.solo ? s.tr[0].ready : (s.tr[0].ready && s.tr[1].ready);
    if (s.phT >= PRACTICE_SECS || humansReady) {
      startPhase(s, 'show');
      return;
    }
  }
  if (s.phase === 'show') {
    if (s.phT < SHOW_COUNTDOWN) {
      // 3… 2… 1… engines idle at the start line
      for (const p of s.tr) { p.th = 0; p.st = 0; }
    }
    if (s.phT > SHOW_MAX) {
      // curfew. most stunts wins; ties go to raw progress; a true tie pays nobody.
      const score = (p: SimTruck) => p.done.filter(Boolean).length * 100 + p.donutAcc + p.wheelieT * 10 + p.crushN;
      const a = score(s.tr[0]), b = score(s.tr[1]);
      s.over = a === b ? -1 : a > b ? 0 : 1;
      if (s.over >= 0) emitFx(s, { k: 'win', s: s.over });
      sendSnap(s, true);
      return;
    }
  }

  if (s.bot) stepBot(s, dt); // (never in 'pick' — that early-returned above)

  // --- trucks ---
  for (let i = 0; i < 2; i++) stepTruck(s, i, dt);

  // truck-vs-truck bonk (grounded-ish only — you can FLY OVER your rival, which rules)
  const [t0, t1] = s.tr;
  if (Math.abs(t0.z - t1.z) < 40) {
    const dx = t1.x - t0.x, dy = t1.y - t0.y;
    const d = Math.hypot(dx, dy);
    if (d > 0.01 && d < 54) {
      const nx = dx / d, ny = dy / d;
      const push = (54 - d) / 2;
      t0.x -= nx * push; t0.y -= ny * push;
      t1.x += nx * push; t1.y += ny * push;
      const rel = (t0.vx - t1.vx) * nx + (t0.vy - t1.vy) * ny;
      if (rel > 0) {
        const imp = rel * 0.8;
        t0.vx -= nx * imp; t0.vy -= ny * imp;
        t1.vx += nx * imp; t1.vy += ny * imp;
        if (rel > 180) emitFx(s, { k: 'bonk', x: (t0.x + t1.x) / 2, y: (t0.y + t1.y) / 2 });
      }
    }
  }

  // junk cars pop back up
  for (const car of s.cars) {
    if (car.flatUntil > 0 && s.t >= car.flatUntil) car.flatUntil = 0;
  }
  for (const cone of s.cones) {
    if (cone.flatUntil > 0 && s.t >= cone.flatUntil) cone.flatUntil = 0;
  }
}

function startPhase(s: Sim, ph: 'practice' | 'show') {
  s.phase = ph;
  s.phT = 0;
  // fresh arena, fresh trucks, fresh stunt sheet — practice scribbles don't count
  for (let i = 0; i < 2; i++) {
    const p = s.tr[i];
    const sp = SPAWNS[i];
    p.x = sp.x; p.y = sp.y; p.a = sp.a; p.lastA = sp.a;
    p.vx = 0; p.vy = 0; p.z = 0; p.vz = 0;
    p.pitch = 0; p.airT = 0; p.tumbleT = 0;
    p.wheelie = false; p.wheelieT = 0;
    p.donutAcc = 0; p.crushN = 0;
    p.done = new Array(N_STUNTS).fill(false);
    p.rampLatch = false;
  }
  for (const car of s.cars) car.flatUntil = 0;
  for (const cone of s.cones) cone.flatUntil = 0;
  if (s.bot) {
    s.bot.state = 'chill';
    s.bot.chillT = ph === 'show' ? SHOW_COUNTDOWN + 0.8 : 1.2;
    s.bot.order = shuffle([0, 1, 2, 3, 4]);
    s.bot.lastDone = 0;
  }
  emitFx(s, { k: 'phase', ph });
}

function stepTruck(s: Sim, i: number, dt: number) {
  const p = s.tr[i];
  const def = TRUCKS[Math.max(0, p.pick)] ?? TRUCKS[0];
  const grounded = p.z <= 0.01;

  // wipeout: no control, comedy spin, sad deceleration
  if (p.tumbleT > 0) {
    p.tumbleT -= dt;
    p.a += 8.5 * dt;
    p.vx *= Math.max(0, 1 - 3.2 * dt);
    p.vy *= Math.max(0, 1 - 3.2 * dt);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    bounceWalls(s, p);
    p.lastA = p.a;
    return;
  }

  const fwdX = Math.cos(p.a), fwdY = Math.sin(p.a);
  let fwd = p.vx * fwdX + p.vy * fwdY;

  if (grounded) {
    // wheelie: hold the stunt key at speed — front wheels up, flames out back
    p.wheelie = p.sk && fwd > WHEELIE_MIN_SPD;
    if (p.wheelie) {
      p.wheelieT += dt;
      if (p.wheelieT >= WHEELIE_SECS) markStunt(s, i, 4);
    } else if (p.wheelieT < WHEELIE_SECS) {
      p.wheelieT = 0; // streak broken (once landed, the sheet keeps the ✓ via done[])
    }

    // throttle along the nose
    const power = ACCEL * (p.th >= 0 ? p.th : p.th * REV_FRAC) * (p.wheelie ? 1.12 : 1);
    p.vx += fwdX * power * dt;
    p.vy += fwdY * power * dt;

    // steering (authority grows with speed, but a monster truck can nearly pivot)
    const authority = 0.45 + 0.55 * Math.min(1, Math.abs(fwd) / 260);
    const steer = p.st * TURN * def.turn * authority * (p.wheelie ? 0.4 : 1) * (fwd < -20 ? -1 : 1);
    p.a += steer * dt;

    // grip: bleed sideways slither, keep the good kind of drift. The donut zone's scuffed
    // dirt is extra grippy so spinning trucks carve tight circles instead of drifting out
    // of the zone mid-donut (six-year-olds hold FULL throttle; the game should reward that).
    const inDonut = Math.hypot(p.x - DONUT.x, p.y - DONUT.y) < DONUT.r;
    fwd = p.vx * fwdX + p.vy * fwdY;
    const latX = p.vx - fwdX * fwd, latY = p.vy - fwdY * fwd;
    const keepLat = Math.max(0, 1 - GRIP * (inDonut ? 2.4 : 1) * dt);
    const keepFwd = Math.max(0, 1 - FWD_DRAG * dt);
    p.vx = fwdX * fwd * keepFwd + latX * keepLat;
    p.vy = fwdY * fwd * keepFwd + latY * keepLat;

    // top speed
    const sp = Math.hypot(p.vx, p.vy);
    const cap = TOP_SPEED * def.top;
    if (sp > cap) { p.vx *= cap / sp; p.vy *= cap / sp; }

    // donuts: real spinning inside the circle
    const spin = Math.abs(angDiff(p.a, p.lastA)) / Math.max(dt, 1e-4);
    if (inDonut && spin > DONUT_MIN_SPIN && sp > 50) {
      p.donutAcc += Math.abs(angDiff(p.a, p.lastA));
      if (p.donutAcc >= DONUT_NEED) markStunt(s, i, 2);
    }
  } else {
    // airborne: hold the stunt key to BACKFLIP
    p.airT += dt;
    if (p.sk) p.pitch += FLIP_RATE * def.air * dt;
    p.vz -= GRAV * dt;
    p.wheelie = false;
  }

  // ramps: cross a takeoff lip with speed → fly
  const wasGrounded = grounded;
  const px = p.x, py = p.y;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  if (wasGrounded) {
    checkTakeoff(p, px, py, RAMP, 1.35, 0, def.air);
    checkTakeoff(p, px, py, PIPE, 1.5, 200, def.air);
  }

  // vertical
  if (p.z > 0 || p.vz > 0) {
    p.z += p.vz * dt;
    if (p.z <= 0) {
      // touchdown!
      p.z = 0;
      const slamSpeed = -p.vz;
      const flips = p.pitch / (Math.PI * 2);
      const upright = Math.cos(p.pitch) > 0.35;
      if (Math.cos(p.pitch) < -0.2) {
        // landed on the lid
        p.tumbleT = 1.1;
        p.pitch = 0;
        emitFx(s, { k: 'wipe', x: p.x, y: p.y });
      } else {
        if (flips >= 0.75 && upright) markStunt(s, i, 1); // BACKFLIP!
        if (p.airT >= BIG_AIR_SECS) markStunt(s, i, 0); // BIG AIR!
        p.pitch = 0;
        if (slamSpeed > 220) {
          emitFx(s, { k: 'land', x: p.x, y: p.y, big: p.airT > 0.7 });
          // land ON a junk car → instant pancake
          crushUnder(s, p, i, true);
        }
        if (def.bounce > 0 && slamSpeed > 320) {
          p.vz = slamSpeed * def.bounce; // baa.
          p.z = 0.02;
        } else {
          p.vz = 0;
        }
      }
      if (p.z === 0) p.airT = 0;
    }
  }

  // grounded crushing (cars want ~140+ px/s of enthusiasm; cones pop at a touch)
  if (p.z < 24) crushUnder(s, p, i, false);

  bounceWalls(s, p);
  p.lastA = p.a;
}

function checkTakeoff(
  p: SimTruck, px: number, py: number,
  r: { x: number; y: number; a: number; w: number; len: number },
  mult: number, bonus: number, airStat: number,
) {
  const ca = Math.cos(-r.a), sa = Math.sin(-r.a);
  const lx0 = (px - r.x) * ca - (py - r.y) * sa;
  const ly0 = (px - r.x) * sa + (py - r.y) * ca;
  const lx1 = (p.x - r.x) * ca - (p.y - r.y) * sa;
  const lip = r.len / 2;
  if (Math.abs(ly0) > r.w / 2) { p.rampLatch = false; return; }
  if (lx0 < lip && lx1 >= lip && !p.rampLatch) {
    const fwd = p.vx * Math.cos(r.a) + p.vy * Math.sin(r.a);
    if (fwd > TAKEOFF_MIN) {
      p.vz = fwd * mult * airStat + bonus;
      p.z = 0.5;
      p.airT = 0;
      p.pitch = 0;
      p.rampLatch = true;
      snd('rev');
    }
  }
  if (lx1 > lip + 40 || lx1 < lip - 10) p.rampLatch = false;
}

function crushUnder(s: Sim, p: SimTruck, slot: number, landing: boolean) {
  const sp = Math.hypot(p.vx, p.vy);
  for (const car of s.cars) {
    if (car.flatUntil > 0) continue;
    if (Math.hypot(p.x - car.x, p.y - car.y) < 46 && (landing || sp > 140)) {
      car.flatUntil = s.t + CAR_RESPAWN;
      p.crushN++;
      emitFx(s, { k: 'crush', x: car.x, y: car.y });
      if (p.crushN >= CRUSH_NEED) markStunt(s, slot, 3);
    }
  }
  if (s.phase === 'practice') {
    for (const cone of s.cones) {
      if (cone.flatUntil > 0) continue;
      if (Math.hypot(p.x - cone.x, p.y - cone.y) < 36 && sp > 60) {
        cone.flatUntil = s.t + 6;
        emitFx(s, { k: 'cone', x: cone.x, y: cone.y });
      }
    }
  }
}

function bounceWalls(s: Sim, p: SimTruck) {
  const PAD = 44;
  let hit = 0;
  if (p.x < PAD) { p.x = PAD; if (p.vx < 0) { hit = -p.vx; p.vx = -p.vx * 0.4; } }
  if (p.x > W - PAD) { p.x = W - PAD; if (p.vx > 0) { hit = p.vx; p.vx = -p.vx * 0.4; } }
  if (p.y < PAD) { p.y = PAD; if (p.vy < 0) { hit = Math.max(hit, -p.vy); p.vy = -p.vy * 0.4; } }
  if (p.y > H - PAD) { p.y = H - PAD; if (p.vy > 0) { hit = Math.max(hit, p.vy); p.vy = -p.vy * 0.4; } }
  if (hit > 260) emitFx(s, { k: 'bonk', x: p.x, y: p.y });
}

// --- Crushbot 9000: works the stunt sheet like a checklist, because it is one ---
function stepBot(s: Sim, dt: number) {
  const bot = s.bot;
  if (!bot) return;
  const me = s.tr[1];
  if (me.tumbleT > 0) return; // it's thinking about what it did

  const doneCount = me.done.filter(Boolean).length;
  if (doneCount > bot.lastDone) {
    // it landed one! brief robot celebration (spinning counts as joy)
    bot.lastDone = doneCount;
    bot.state = 'chill';
    bot.chillT = 1.2 + Math.random() * 1.6; // the merciful pause that lets a kid stay ahead
  }

  if (bot.state === 'chill') {
    bot.chillT -= dt;
    me.th = 0; me.st = 1; me.sk = false; // happy little donut
    if (bot.chillT <= 0) {
      const next = bot.order.find((idx) => !me.done[idx]);
      if (next === undefined) { me.th = 0; me.st = 0; return; }
      aimBotAt(bot, next);
      bot.state = 'goto';
    }
    return;
  }

  const target = bot.order.find((idx) => !me.done[idx]);
  if (target === undefined) { me.th = 0; me.st = 0; me.sk = false; return; }

  if (bot.state === 'goto') {
    const diff = angDiff(Math.atan2(bot.ty - me.y, bot.tx - me.x), me.a);
    me.st = clamp(diff * 2.2, -1, 1);
    me.th = botThrottle(diff);
    me.sk = false;
    bot.execT += dt; // double duty: a stuck-at-the-wall timeout for the drive TO the mark
    // ramp runs also need to be POINTED at the ramp before charging, or the charge orbits
    const needA = target === 0 ? RAMP.a : target === 1 ? PIPE.a : null;
    const aligned = needA === null || Math.abs(angDiff(needA, me.a)) < 0.7;
    if ((Math.hypot(bot.tx - me.x, bot.ty - me.y) < 90 && aligned) || bot.execT > 8) {
      bot.state = 'exec';
      bot.execT = 0;
      bot.releasePitch = Math.PI * 2 * (0.9 + Math.random() * 0.18); // sometimes it over-rotates. robots.
      bot.runDir = me.x < W / 2 ? 1 : -1;
    }
    return;
  }

  // exec
  bot.execT += dt;
  if (bot.execT > 9) { aimBotAt(bot, target); bot.state = 'goto'; return; } // whiffed it — line up again
  switch (target) {
    case 0: { // BIG AIR: floor it through the big ramp
      driveBotThrough(me, RAMP.x + Math.cos(RAMP.a) * 400, RAMP.y + Math.sin(RAMP.a) * 400);
      me.sk = false;
      break;
    }
    case 1: { // BACKFLIP: floor it through the pipe, hold the flip, let go near upright
      driveBotThrough(me, PIPE.x + Math.cos(PIPE.a) * 420, PIPE.y + Math.sin(PIPE.a) * 420);
      me.sk = me.z > 0.01 && me.pitch < bot.releasePitch;
      break;
    }
    case 2: { // DONUTS: get dizzy
      me.th = 0.55; me.st = 1; me.sk = false;
      if (Math.hypot(me.x - DONUT.x, me.y - DONUT.y) > DONUT.r * 0.8) { aimBotAt(bot, 2); bot.state = 'goto'; }
      break;
    }
    case 3: { // CAR CRUSH: mow the row, turn around, mow it again
      const endX = bot.runDir > 0 ? CAR_XS[CAR_XS.length - 1] + 160 : CAR_XS[0] - 160;
      driveBotThrough(me, endX, CARS_Y);
      me.sk = false;
      if ((bot.runDir > 0 && me.x > endX - 30) || (bot.runDir < 0 && me.x < endX + 30)) bot.runDir *= -1;
      break;
    }
    case 4: { // WHEELIE: long straight along the bottom, nose up
      const endX = bot.runDir > 0 ? W - 120 : 120;
      driveBotThrough(me, endX, H * 0.88);
      const fwd = me.vx * Math.cos(me.a) + me.vy * Math.sin(me.a);
      me.sk = fwd > WHEELIE_MIN_SPD + 20;
      if ((bot.runDir > 0 && me.x > W - 160) || (bot.runDir < 0 && me.x < 160)) bot.runDir *= -1;
      break;
    }
  }
}

function aimBotAt(bot: Bot, stunt: number) {
  switch (stunt) {
    case 0: bot.tx = RAMP.x - Math.cos(RAMP.a) * 380; bot.ty = RAMP.y - Math.sin(RAMP.a) * 380; break;
    case 1: bot.tx = PIPE.x - Math.cos(PIPE.a) * 400; bot.ty = PIPE.y - Math.sin(PIPE.a) * 400; break;
    case 2: bot.tx = DONUT.x; bot.ty = DONUT.y; break;
    case 3: bot.tx = CAR_XS[0] - 140; bot.ty = CARS_Y; break;
    default: bot.tx = 140; bot.ty = H * 0.88; break;
  }
  // staging marks can land outside the fence (the pipe's run-up starts "behind" it) —
  // pull them back inside or the bot grinds the wall forever, dreaming of a spot it can't reach
  bot.tx = clamp(bot.tx, 80, W - 80);
  bot.ty = clamp(bot.ty, 80, H - 80);
}

function driveBotThrough(me: SimTruck, tx: number, ty: number) {
  const diff = angDiff(Math.atan2(ty - me.y, tx - me.x), me.a);
  me.st = clamp(diff * 2.4, -1, 1);
  me.th = botThrottle(diff);
}

/** Throttle by alignment. Full speed only when pointed the right way — a monster truck's
 *  turn radius at full tilt is bigger than any target, so a misaligned bot at full throttle
 *  orbits its goal forever like a confused moon. Slow down, pivot, THEN charge. */
function botThrottle(diff: number): number {
  const d = Math.abs(diff);
  return d > 1.8 ? 0.22 : d > 0.8 ? 0.5 : 1;
}

// ---------------------------------------------------------------- snapshots

function doneMask(p: SimTruck): number {
  let m = 0;
  for (let i = 0; i < N_STUNTS; i++) if (p.done[i]) m |= 1 << i;
  return m;
}

function sendSnap(s: Sim, force = false) {
  if (!net) return;
  if (s.solo && !force) { s.fxPend = []; return; } // nobody's listening
  const snap: Snap = {
    t: 'snap',
    ph: s.phase, phT: Math.round(s.phT * 100) / 100, tm: s.t,
    tr: s.tr.map((p) => ({
      x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10,
      a: Math.round(p.a * 1000) / 1000, z: Math.round(p.z),
      p: Math.round(p.pitch * 100) / 100,
      w: p.wheelie ? 1 : 0, tb: p.tumbleT > 0 ? 1 : 0,
    })),
    cars: s.cars.map((c) => (c.flatUntil > 0 ? 1 : 0)),
    cones: s.cones.map((c) => (c.flatUntil > 0 ? 1 : 0)),
    done: [doneMask(s.tr[0]), doneMask(s.tr[1])],
    prog: s.tr.map((p) => [Math.round(p.donutAcc * 100) / 100, Math.round(p.wheelieT * 100) / 100, p.crushN] as [number, number, number]),
    picks: [s.tr[0].pick, s.tr[1].pick],
    rdy: [s.tr[0].ready, s.tr[1].ready],
    fx: s.fxPend,
    ov: s.over,
  };
  if (!s.solo) net.relay(snap);
  s.fxPend = [];
}

function applySnap(snap: Snap) {
  if (!snap || !Array.isArray(snap.tr) || snap.tr.length < 2) return;
  const now = performance.now() / 1000;
  snapPrev = snapCur;
  snapCur = { s: snap, at: now };
  for (const e of snap.fx) applyFx(e);
}

function currentOver(): number | null {
  if (mySlot === 0) return sim?.over ?? null;
  return snapCur?.s.ov ?? null;
}

function unmask(m: number): boolean[] {
  return [0, 1, 2, 3, 4].map((i) => !!(m & (1 << i)));
}

function buildView(nowSec: number): View | null {
  if (mySlot === 0 && sim) {
    const s = sim;
    return {
      ph: s.phase, phT: s.phT, tm: s.t,
      tr: s.tr.map((p) => ({ x: p.x, y: p.y, a: p.a, z: p.z, pitch: p.pitch, wheelie: p.wheelie, tumble: p.tumbleT > 0 })),
      cars: s.cars.map((c) => c.flatUntil > 0),
      cones: s.cones.map((c) => c.flatUntil > 0),
      done: [s.tr[0].done.slice(), s.tr[1].done.slice()],
      prog: s.tr.map((p) => [p.donutAcc, p.wheelieT, p.crushN] as [number, number, number]),
      picks: [s.tr[0].pick, s.tr[1].pick],
      rdy: [s.tr[0].ready, s.tr[1].ready],
      ov: s.over,
    };
  }
  if (!snapCur) return null;
  const cur = snapCur.s;
  const prev = snapPrev?.s ?? cur;
  const span = Math.max(1 / 60, snapCur.at - (snapPrev?.at ?? snapCur.at - 1 / 30));
  const t = Math.min(1.25, (nowSec - snapCur.at) / span);
  const lerp = (p: number, c: number) => p + (c - p) * t;
  return {
    ph: cur.ph, phT: cur.phT, tm: cur.tm,
    tr: cur.tr.map((c2, i) => {
      const p2 = prev.tr[i] ?? c2;
      return {
        x: lerp(p2.x, c2.x), y: lerp(p2.y, c2.y),
        a: p2.a + angDiff(c2.a, p2.a) * t,
        z: lerp(p2.z, c2.z), pitch: lerp(p2.p, c2.p),
        wheelie: c2.w === 1, tumble: c2.tb === 1,
      };
    }),
    cars: cur.cars.map((c2) => c2 === 1),
    cones: (cur.cones ?? []).map((c2) => c2 === 1),
    done: [unmask(cur.done[0]), unmask(cur.done[1])],
    prog: cur.prog,
    picks: cur.picks,
    rdy: cur.rdy,
    ov: cur.ov,
  };
}

let cachedView: View | null = null;
function currentView(): View | null {
  return cachedView;
}

function playerName(slot: number): string {
  if ((sim?.solo || (mySlot !== 0 && (lobby?.players.length ?? 0) < 2)) && slot === 1) return BOT_NAME;
  const p = lobby?.players.find((q) => q.slot === slot);
  return p?.name ?? (slot === mySlot ? (net?.name() || 'You') : '???');
}

function truckLabel(view: View, slot: number): string {
  const pick = view.picks[slot];
  return pick >= 0 ? TRUCKS[pick].name : '…picking…';
}

// ---------------------------------------------------------------- juice (fx, particles, sound)

function applyFx(e: Fx) {
  switch (e.k) {
    case 'land': {
      shakeMag = Math.max(shakeMag, e.big ? 11 : 6);
      for (let i = 0; i < (e.big ? 22 : 10); i++) {
        const a = Math.random() * Math.PI * 2, sp = 40 + Math.random() * 220;
        particles.push({ x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.5, life: 0.5 + Math.random() * 0.3, max: 0.8, size: 3 + Math.random() * 5, color: ['#8a6b42', '#a3835a', '#6b4a2c'][i % 3], grav: 60, shape: 'dot', rot: 0, vr: 0 });
      }
      snd('land');
      break;
    }
    case 'stunt': {
      const st = STUNTS[e.i];
      cheerAmp = Math.min(2.5, cheerAmp + 1.1);
      shakeMag = Math.max(shakeMag, 7);
      addFloater(e.x, e.y - 46, `${st.icon} ${st.name}!`, '#ffd24f', 26);
      if (!e.practice) announce(`${playerName(e.s).toUpperCase()} LANDS ${st.name}! ${st.icon}`, e.s === mySlot ? '#7dff9a' : '#ffd24f');
      else addFloater(e.x, e.y - 20, '(practice)', '#9aa4b5', 13);
      for (let i = 0; i < 16; i++) {
        const a = Math.random() * Math.PI * 2, sp = 80 + Math.random() * 240;
        particles.push({ x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.7, max: 0.7, size: 4 + Math.random() * 4, color: ['#ffd24f', '#7dff9a', '#43c8ff', '#ff9ad5'][i % 4], grav: 80, shape: 'confetti', rot: Math.random() * 6, vr: (Math.random() - 0.5) * 10 });
      }
      snd(e.practice ? 'ding' : 'cheer');
      break;
    }
    case 'crush': {
      shakeMag = Math.max(shakeMag, 8);
      cheerAmp = Math.min(2.5, cheerAmp + 0.4);
      addFloater(e.x, e.y - 24, 'CRUNCH! 🚗', '#ff9d3f', 22);
      for (let i = 0; i < 14; i++) {
        const a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 260;
        particles.push({ x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80, life: 0.6, max: 0.6, size: 3 + Math.random() * 4, color: Math.random() < 0.5 ? '#c8ccd6' : '#5a6375', grav: 340, shape: 'dot', rot: 0, vr: 0 });
      }
      snd('crush');
      break;
    }
    case 'cone': {
      addFloater(e.x, e.y - 16, '🚧 boop', '#ff9d3f', 15);
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 160;
        particles.push({ x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, life: 0.5, max: 0.5, size: 3, color: '#ff8a2a', grav: 300, shape: 'dot', rot: 0, vr: 0 });
      }
      snd('boop');
      break;
    }
    case 'wipe': {
      shakeMag = Math.max(shakeMag, 9);
      addFloater(e.x, e.y - 30, '💫 WIPEOUT!', '#ff6b6b', 24);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        particles.push({ x: e.x, y: e.y, vx: Math.cos(a) * 90, vy: Math.sin(a) * 90, life: 1.0, max: 1.0, size: 9, color: '#ffd24f', grav: -20, shape: 'star', rot: Math.random() * 6, vr: 4 });
      }
      snd('wipe');
      break;
    }
    case 'bonk': {
      shakeMag = Math.max(shakeMag, 5);
      for (let i = 0; i < 8; i++) {
        const a = Math.random() * Math.PI * 2, sp = 100 + Math.random() * 180;
        particles.push({ x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.3, max: 0.3, size: 2.5, color: '#ffd24f', grav: 0, shape: 'dot', rot: 0, vr: 0 });
      }
      snd('bonk');
      break;
    }
    case 'phase': {
      if (e.ph === 'practice') {
        announce('🚧 PRACTICE YARD — WARM UP THOSE ENGINES!', '#ffd24f');
        announce(touchUI ? 'try every stunt! tap ✓ READY when you are' : 'try every stunt! press R when you\'re ready', '#9aa4b5');
      } else {
        announce('📣 SHOW TIME! FIRST TRUCK TO LAND ALL 5 STUNTS WINS!', '#ff6b4f');
        snd('airhorn');
      }
      break;
    }
    case 'honk': {
      snd('honk');
      break;
    }
    case 'wave': {
      waveT = performance.now() / 1000;
      cheerAmp = Math.min(2.5, cheerAmp + 1.5);
      announce('🌊 THE CROWD IS DOING THE WAVE!', '#43c8ff');
      snd('cheer');
      break;
    }
    case 'win': {
      cheerAmp = 2.5;
      snd(e.s === mySlot ? 'fanfare' : 'cheer');
      break;
    }
  }
}

function announce(text: string, color: string) {
  anns.push({ text, color });
}

function addFloater(x: number, y: number, text: string, color: string, size: number) {
  floaters.push({ x, y, text, life: 1.4, max: 1.4, color, size });
}

function spawnWool(x: number, y: number) {
  const a = Math.random() * Math.PI * 2, sp = 40 + Math.random() * 160;
  particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, life: 1.2, max: 1.2, size: 6 + Math.random() * 6, color: '#f4efe2', grav: 60, shape: 'wool', rot: 0, vr: 2 });
}

// --- audio: an actual engine you can hear rev, plus arcade one-shots ---
let ac: AudioContext | null = null;
let engineOsc: OscillatorNode | null = null;
let engineGain: GainNode | null = null;

function ensureAc(): AudioContext | null {
  try {
    if (!ac) ac = new AudioContext();
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    return ac;
  } catch { return null; }
}

function updateEngine(speed: number, wheelie: boolean, airborne: boolean) {
  const a = ensureAc();
  if (!a) return;
  if (!engineOsc) {
    try {
      engineOsc = a.createOscillator();
      engineGain = a.createGain();
      engineOsc.type = 'sawtooth';
      engineGain.gain.value = 0;
      engineOsc.connect(engineGain).connect(a.destination);
      engineOsc.start();
    } catch { engineOsc = null; engineGain = null; return; }
  }
  if (!engineGain || !engineOsc) return;
  const muted = net?.muted() ?? false;
  const rpm = 46 + speed * 0.22 + (wheelie ? 26 : 0) + (airborne ? 34 : 0);
  engineOsc.frequency.setTargetAtTime(rpm, a.currentTime, 0.06);
  engineGain.gain.setTargetAtTime(muted || screen !== 'playing' ? 0 : 0.016 + Math.min(0.014, speed / 30000), a.currentTime, 0.08);
}

function stopEngine() {
  try { engineOsc?.stop(); } catch { /* already stopped */ }
  try { engineGain?.disconnect(); } catch { /* fine */ }
  engineOsc = null;
  engineGain = null;
}

function tone(f0: number, f1: number, dur: number, type: OscillatorType, vol: number, delayMs = 0) {
  if (net?.muted()) return;
  const go = () => {
    const a = ensureAc();
    if (!a) return;
    try {
      const t0 = a.currentTime;
      const o = a.createOscillator();
      const g = a.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t0);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(a.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.02);
    } catch { /* audio is a bonus, never a crash */ }
  };
  if (delayMs > 0) setTimeout(go, delayMs);
  else go();
}

function snd(kind: string) {
  switch (kind) {
    case 'rev': tone(70, 240, 0.35, 'sawtooth', 0.06); break;
    case 'land': tone(120, 40, 0.25, 'square', 0.07); break;
    case 'crush': tone(180, 40, 0.3, 'square', 0.09); tone(90, 30, 0.35, 'sawtooth', 0.06); break;
    case 'boop': tone(520, 660, 0.08, 'sine', 0.05); break;
    case 'ding': tone(880, 1320, 0.18, 'sine', 0.06); break;
    case 'cheer': tone(392, 392, 0.1, 'square', 0.045); tone(523, 523, 0.12, 'square', 0.045, 100); tone(659, 784, 0.25, 'square', 0.05, 200); break;
    case 'wipe': tone(400, 60, 0.6, 'sawtooth', 0.07); break;
    case 'bonk': tone(220, 120, 0.12, 'square', 0.06); break;
    case 'honk': tone(311, 311, 0.28, 'square', 0.08); tone(392, 392, 0.28, 'square', 0.08); break;
    case 'airhorn': tone(466, 440, 0.65, 'sawtooth', 0.07); tone(587, 554, 0.65, 'sawtooth', 0.05); tone(699, 659, 0.65, 'sawtooth', 0.04); break;
    case 'bleat': tone(600, 500, 0.12, 'sawtooth', 0.07); tone(500, 640, 0.2, 'sawtooth', 0.07, 130); tone(640, 520, 0.25, 'sawtooth', 0.06, 340); break;
    case 'fanfare':
      tone(523, 523, 0.14, 'square', 0.06);
      tone(659, 659, 0.14, 'square', 0.06, 150);
      tone(784, 784, 0.14, 'square', 0.06, 300);
      tone(1046, 1046, 0.5, 'square', 0.07, 450);
      break;
  }
}

// ---------------------------------------------------------------- main loop

function loop(now: number) {
  if (!running) return;
  raf = requestAnimationFrame(loop);
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;

  if (screen === 'playing') {
    if (mySlot === 0 && sim) {
      stepSim(sim, dt);
      sim.snapTimer += dt;
      if (sim.snapTimer >= 1 / 30) { sim.snapTimer = 0; sendSnap(sim); }
    } else if (mySlot !== 0) {
      inputTimer += dt;
      if (inputDirty && inputTimer > 0.05) sendInput();
      else if (inputTimer > 0.2) sendInput();
    }
  }

  cachedView = screen === 'playing' ? buildView(now / 1000) : null;

  // engine audio follows MY truck
  if (cachedView && cachedView.ph !== 'pick' && mySlot >= 0) {
    const meIdx = mySlot === 0 ? 0 : 1;
    const me = cachedView.tr[meIdx];
    const prev = lastViewTr[meIdx];
    const spd = prev ? Math.hypot(me.x - prev.x, me.y - prev.y) / Math.max(dt, 1e-3) : 0;
    updateEngine(Math.min(600, spd), me.wheelie, me.z > 4);
  } else {
    updateEngine(0, false, false);
  }

  // client-side juice from watching the view: skid marks + wheelie flames
  if (cachedView && cachedView.ph !== 'pick') {
    for (let i = 0; i < cachedView.tr.length; i++) {
      const t = cachedView.tr[i];
      const prev = lastViewTr[i];
      if (prev && t.z < 3) {
        const spd = Math.hypot(t.x - prev.x, t.y - prev.y) / Math.max(dt, 1e-3);
        const turn = Math.abs(angDiff(t.a, prev.a)) / Math.max(dt, 1e-3);
        if ((spd > 110 && turn > 1.6) || t.tumble) {
          skids.push({ x: t.x, y: t.y, a: t.a, life: 6 });
          if (skids.length > 500) skids.splice(0, skids.length - 500);
        }
        if (t.wheelie && Math.random() < 0.7) {
          const bx = t.x - Math.cos(t.a) * 34, by = t.y - Math.sin(t.a) * 34;
          particles.push({ x: bx, y: by, vx: -Math.cos(t.a) * 120 + (Math.random() - 0.5) * 60, vy: -Math.sin(t.a) * 120 + (Math.random() - 0.5) * 60, life: 0.35, max: 0.35, size: 5 + Math.random() * 4, color: Math.random() < 0.5 ? '#ff9d3f' : '#ffd24f', grav: -40, shape: 'flame', rot: 0, vr: 0 });
        }
      }
      lastViewTr[i] = { x: t.x, y: t.y, a: t.a };
    }
  }

  // particles / floaters / decay
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.vy += p.grav * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
  }
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.life -= dt;
    f.y -= 26 * dt;
    if (f.life <= 0) floaters.splice(i, 1);
  }
  for (let i = skids.length - 1; i >= 0; i--) {
    skids[i].life -= dt;
    if (skids[i].life <= 0) skids.splice(i, 1);
  }
  shakeMag = Math.max(0, shakeMag - 30 * dt);
  cheerAmp = Math.max(0, cheerAmp - 0.35 * dt);
  if (anns.length > 0) {
    annT += dt;
    if (annT > 2.6) { anns.shift(); annT = 0; }
  }

  const over = currentOver();
  if (screen === 'playing' && over !== null && over === mySlot) {
    confettiTimer -= dt;
    if (confettiTimer <= 0) {
      confettiTimer = 0.05;
      particles.push({
        x: Math.random() * window.innerWidth, y: -10,
        vx: (Math.random() - 0.5) * 60, vy: 90 + Math.random() * 130,
        life: 2.6, max: 2.6, size: 4 + Math.random() * 5,
        color: ['#ff5b3f', '#ffd24f', '#7dff9a', '#43c8ff', '#ff9ad5'][Math.floor(Math.random() * 5)],
        grav: 60, shape: 'confetti', rot: Math.random() * 6, vr: (Math.random() - 0.5) * 10,
      });
    }
  }

  draw(now / 1000);
}

// ---------------------------------------------------------------- rendering

function fit(): { cw: number; ch: number } {
  const c = canvas, cx = ctx;
  if (!c || !cx) return { cw: 0, ch: 0 };
  const dpr = window.devicePixelRatio || 1;
  const cw = window.innerWidth, ch = window.innerHeight;
  if (c.width !== Math.floor(cw * dpr) || c.height !== Math.floor(ch * dpr)) {
    c.width = Math.floor(cw * dpr);
    c.height = Math.floor(ch * dpr);
  }
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { cw, ch };
}

function draw(nowSec: number) {
  const cx = ctx;
  if (!cx) return;
  const { cw, ch } = fit();
  cx.fillStyle = '#0a0806';
  cx.fillRect(0, 0, cw, ch);
  if (screen === 'lobby') { drawLobby(cx, cw, ch, nowSec); return; }
  const view = cachedView;
  if (!view) {
    cx.textAlign = 'center';
    cx.font = '700 20px system-ui, sans-serif';
    cx.fillStyle = '#8a93a5';
    cx.fillText('starting engines…', cw / 2, ch / 2);
    return;
  }
  if (view.ph === 'pick' && view.ov === null) { drawPickScreen(cx, cw, ch, view, nowSec); return; }
  drawArenaScreen(cx, cw, ch, view, nowSec);
}

// --- lobby ---
function drawLobby(cx: CanvasRenderingContext2D, cw: number, ch: number, nowSec: number) {
  const midX = cw / 2;
  cx.textAlign = 'center';
  cx.textBaseline = 'middle';
  const wob = Math.sin(nowSec * 3) * 3;
  cx.font = '900 42px system-ui, sans-serif';
  cx.fillStyle = '#ffd24f';
  cx.fillText('🚚 MONSTER JAM: STUNT SHOWDOWN 🏆', midX, ch * 0.15 + wob);
  cx.font = 'italic 15px system-ui, sans-serif';
  cx.fillStyle = '#9aa4b5';
  cx.fillText('a 1v1 stunt spectacular — concept by a six-year-old game director', midX, ch * 0.15 + 38 + wob);

  const lines = touchUI
    ? [
        '🚚  pick your monster truck — all the greats are here',
        '🚧  warm up in the Practice Yard (a whole other arena)',
        '📣  then it\'s SHOW TIME: first truck to land ALL 5 stunts wins',
        '🛫 big air   🔄 backflip   🌀 donuts   🚗 car crush   🐎 wheelie',
        '👍  hold + drag a thumb to drive — hold the STUNT button to flip & wheelie',
      ]
    : [
        '🚚  pick your monster truck — all the greats are here',
        '🚧  warm up in the Practice Yard (a whole other arena)',
        '📣  then it\'s SHOW TIME: first truck to land ALL 5 stunts wins',
        '🛫 big air   🔄 backflip   🌀 donuts   🚗 car crush   🐎 wheelie',
        '🎮  WASD / arrows to drive — hold SPACE to backflip (in air) & wheelie (on dirt)',
      ];
  cx.font = '16px system-ui, sans-serif';
  cx.textAlign = 'left';
  const lx = midX - 300;
  let ly = ch * 0.32;
  for (const line of lines) {
    cx.fillStyle = '#d7dce6';
    cx.fillText(line, lx, ly);
    ly += 30;
  }
  cx.textAlign = 'center';

  const players = lobby?.players ?? [];
  cx.font = '700 18px system-ui, sans-serif';
  let py = ly + 18;
  for (let i = 0; i < 2; i++) {
    const p = players.find((q) => q.slot === i);
    cx.fillStyle = p ? (i === 0 ? '#ff9d3f' : '#43c8ff') : '#3a4150';
    const label = p ? `${i === 0 ? '🟠' : '🔵'} ${p.name}${p.slot === mySlot ? ' (you)' : ''}` : '· · · waiting for a rival driver · · ·';
    cx.fillText(label, midX, py);
    py += 28;
  }

  startBtnRect = null;
  if (mySlot === 0) {
    const solo = players.length < 2;
    const bw = 380, bh = 54;
    const bx = midX - bw / 2, by = py + 14;
    startBtnRect = [bx, by, bw, bh];
    cx.fillStyle = solo ? '#3d3413' : '#4a1d10';
    cx.strokeStyle = solo ? '#ffd24f' : '#ff7a4f';
    cx.lineWidth = 2;
    cx.beginPath();
    cx.roundRect(bx, by, bw, bh, 12);
    cx.fill();
    cx.stroke();
    cx.font = '900 20px system-ui, sans-serif';
    cx.fillStyle = solo ? '#ffd24f' : '#ff9d77';
    cx.fillText(solo ? '🤖 SOLO SHOW vs CRUSHBOT 9000' : '📣 START THE SHOWDOWN!', midX, by + bh / 2);
    if (solo) {
      cx.font = '13px system-ui, sans-serif';
      cx.fillStyle = '#8a93a5';
      cx.fillText('(solo shows pay no coins — beat a human driver for the purse)', midX, by + bh + 20);
    }
  } else if (mySlot > 0) {
    cx.font = '700 18px system-ui, sans-serif';
    cx.fillStyle = Math.sin(nowSec * 4) > 0 ? '#ffd24f' : '#b8912f';
    cx.fillText('waiting for the host to fire the confetti cannon…', midX, py + 40);
  } else {
    cx.font = '700 18px system-ui, sans-serif';
    cx.fillStyle = '#8a93a5';
    cx.fillText('joining…', midX, py + 40);
  }

  cx.font = '13px system-ui, sans-serif';
  cx.fillStyle = '#5a6375';
  cx.fillText(touchUI ? 'tap ✕ to leave' : 'ESC (or ✕) to leave', midX, ch - 28);
  drawFloatersScreen(cx);
}

function lobbyClick(mx: number, my: number) {
  if (startBtnRect && mySlot === 0 && inRect(mx, my, startBtnRect)) net?.start();
}

// --- pick screen ---
function drawPickScreen(cx: CanvasRenderingContext2D, cw: number, ch: number, view: View, nowSec: number) {
  cx.textAlign = 'center';
  cx.textBaseline = 'middle';
  const wob = Math.sin(nowSec * 3) * 2;
  cx.font = '900 36px system-ui, sans-serif';
  cx.fillStyle = '#ffd24f';
  const title = '🚚 PICK YOUR MONSTER TRUCK 🚚';
  cx.fillText(title, cw / 2, ch * 0.09 + wob);
  const tw = cx.measureText(title).width;
  titleRect = [cw / 2 - tw / 2, ch * 0.09 - 26, tw, 52];

  const meIdx = mySlot === 0 ? 0 : 1;
  const oppIdx = 1 - meIdx;
  cx.font = '14px system-ui, sans-serif';
  cx.fillStyle = '#9aa4b5';
  cx.fillText(
    myPick >= 0
      ? (view.picks[oppIdx] >= 0 ? 'both trucks picked — to the Practice Yard!' : `waiting for ${playerName(oppIdx)} to pick…`)
      : (touchUI ? 'tap a truck!' : 'click a truck (or arrows + Enter)'),
    cw / 2, ch * 0.09 + 34 + wob,
  );

  const n = sheepUnlocked ? TRUCKS.length : TRUCKS.length - 1;
  const cols = 4;
  const rows = Math.ceil(n / cols);
  const cardW = Math.min(250, (cw - 80) / cols - 16);
  const cardH = Math.min(170, (ch * 0.72) / rows - 16);
  const gridW = cols * (cardW + 16) - 16;
  const x0 = (cw - gridW) / 2;
  const y0 = ch * 0.17;
  cardRects = [];
  for (let i = 0; i < n; i++) {
    const col = i % cols, row = Math.floor(i / cols);
    const x = x0 + col * (cardW + 16);
    const y = y0 + row * (cardH + 16);
    cardRects.push([x, y, cardW, cardH]);
    const def = TRUCKS[i];
    const mine = myPick === i;
    const theirs = view.picks[oppIdx] === i;
    const hot = selCard === i && myPick < 0;
    cx.fillStyle = mine ? '#12331a' : theirs ? '#331a12' : '#141821';
    cx.strokeStyle = mine ? '#39ff5e' : theirs ? '#ff7a4f' : hot ? def.ui : '#2a3040';
    cx.lineWidth = hot || mine || theirs ? 3 : 1.5;
    cx.beginPath();
    cx.roundRect(x, y, cardW, cardH, 12);
    cx.fill();
    cx.stroke();

    // mini truck portrait, nose up, gently bouncing if selected
    cx.save();
    cx.translate(x + cardW / 2, y + cardH * 0.42 + (hot ? Math.sin(nowSec * 6) * 3 : 0));
    cx.rotate(-Math.PI / 2);
    cx.scale(cardH / 210, cardH / 210);
    drawTruckBody(cx, def, nowSec, false);
    cx.restore();

    cx.font = `900 ${Math.min(17, cardW / 11)}px system-ui, sans-serif`;
    cx.fillStyle = def.ui;
    cx.fillText(def.name.toUpperCase(), x + cardW / 2, y + cardH - 40);
    cx.font = 'italic 12px system-ui, sans-serif';
    cx.fillStyle = '#8a93a5';
    cx.fillText(def.blurb, x + cardW / 2, y + cardH - 24);
    // stat pips
    const stats: [string, number][] = [['⚡', def.top], ['🎯', def.turn], ['🪂', def.air]];
    cx.font = '10px system-ui, sans-serif';
    for (let sIdx = 0; sIdx < 3; sIdx++) {
      const [ic, v] = stats[sIdx];
      const sx = x + 12 + sIdx * ((cardW - 24) / 3);
      cx.textAlign = 'left';
      cx.fillStyle = '#9aa4b5';
      cx.fillText(ic, sx, y + cardH - 9);
      const frac = clamp((v - 0.85) / 0.33, 0.08, 1);
      cx.fillStyle = '#2a3040';
      cx.fillRect(sx + 14, y + cardH - 13, (cardW - 24) / 3 - 22, 6);
      cx.fillStyle = def.ui;
      cx.fillRect(sx + 14, y + cardH - 13, ((cardW - 24) / 3 - 22) * frac, 6);
      cx.textAlign = 'center';
    }
    if (mine) {
      cx.font = '900 13px system-ui, sans-serif';
      cx.fillStyle = '#39ff5e';
      cx.fillText('✓ YOU', x + cardW / 2, y + 14);
    } else if (theirs) {
      cx.font = '900 13px system-ui, sans-serif';
      cx.fillStyle = '#ff7a4f';
      cx.fillText(`⛳ ${playerName(oppIdx)}`, x + cardW / 2, y + 14);
    }
  }

  cx.font = '13px system-ui, sans-serif';
  cx.fillStyle = '#5a6375';
  cx.fillText(`the show starts in ${Math.max(0, Math.ceil(PICK_SECS - view.phT))}s either way…`, cw / 2, ch - 24);
  drawFloatersScreen(cx);
  drawParticlesScreen(cx);
}

// --- arena (practice + show share everything but the dress code) ---
function drawArenaScreen(cx: CanvasRenderingContext2D, cw: number, ch: number, view: View, nowSec: number) {
  const HUD_H = 82;
  const scale = Math.min(cw / (W + 20), (ch - HUD_H - 12) / (H + 20));
  const ox = (cw - W * scale) / 2;
  const oy = HUD_H + (ch - HUD_H - H * scale) / 2;

  const practice = view.ph === 'practice';
  const shX = (Math.random() - 0.5) * shakeMag;
  const shY = (Math.random() - 0.5) * shakeMag;

  cx.save();
  cx.translate(ox + shX * scale, oy + shY * scale);
  cx.scale(scale, scale);

  drawArenaGround(cx, practice, nowSec);
  drawSkids(cx);
  drawProps(cx, view, practice, nowSec);

  // trucks, painter-sorted so the higher flyer draws on top
  const order = view.tr.map((t, i) => ({ t, i })).sort((a, b) => (a.t.y + a.t.z * 2) - (b.t.y + b.t.z * 2));
  for (const { t, i } of order) {
    const def = TRUCKS[Math.max(0, view.picks[i])] ?? TRUCKS[0];
    drawTruck(cx, t, def, nowSec, i);
  }

  drawFloatersWorld(cx);
  drawParticlesWorld(cx);
  cx.restore();

  drawHud(cx, cw, view, nowSec);

  // phase banners / countdowns
  cx.textAlign = 'center';
  if (practice) {
    const left = Math.max(0, PRACTICE_SECS - view.phT);
    cx.font = '900 20px system-ui, sans-serif';
    cx.fillStyle = '#ffd24f';
    cx.fillText(`🚧 PRACTICE YARD — SHOW IN ${Math.ceil(left)}s`, cw / 2, HUD_H + 26);
    // ready button
    const bw = 220, bh = 46;
    const bx = cw / 2 - bw / 2, by = ch - bh - 18;
    readyBtnRect = [bx, by, bw, bh];
    const meReady = view.rdy[mySlot === 0 ? 0 : 1] || myReady;
    cx.fillStyle = meReady ? '#12331a' : '#3d3413';
    cx.strokeStyle = meReady ? '#39ff5e' : '#ffd24f';
    cx.lineWidth = 2;
    cx.beginPath();
    cx.roundRect(bx, by, bw, bh, 12);
    cx.fill();
    cx.stroke();
    cx.font = '900 17px system-ui, sans-serif';
    cx.fillStyle = meReady ? '#39ff5e' : '#ffd24f';
    cx.fillText(meReady ? '✓ READY — waiting…' : (touchUI ? '✓ READY!' : '✓ READY! (R)'), cw / 2, by + bh / 2);
  } else {
    readyBtnRect = null;
    if (view.phT < SHOW_COUNTDOWN + 0.8 && view.ov === null) {
      const n = Math.ceil(SHOW_COUNTDOWN - view.phT);
      cx.font = '900 84px system-ui, sans-serif';
      cx.fillStyle = n <= 0 ? '#7dff9a' : '#ffd24f';
      cx.globalAlpha = 0.9;
      cx.fillText(n <= 0 ? 'GO!!' : String(n), cw / 2, ch * 0.4);
      cx.globalAlpha = 1;
    }
    const left = Math.max(0, SHOW_MAX - view.phT);
    if (left < 30 && view.ov === null) {
      cx.font = '900 18px system-ui, sans-serif';
      cx.fillStyle = Math.sin(nowSec * 6) > 0 ? '#ff5b3f' : '#ffd24f';
      cx.fillText(`⏱ CURFEW IN ${Math.ceil(left)}s — MOST STUNTS WINS!`, cw / 2, HUD_H + 26);
    }
  }

  // announcer line
  if (anns.length > 0) {
    const a = anns[0];
    cx.font = '900 22px system-ui, sans-serif';
    cx.save();
    cx.globalAlpha = Math.min(1, (2.6 - annT) * 2, annT * 6 + 0.3);
    cx.fillStyle = a.color;
    cx.fillText(a.text, cw / 2, HUD_H + 58);
    cx.restore();
  }

  if (touchUI && view.ov === null) drawTouchControls(cx, nowSec);
  drawParticlesScreen(cx);
  if (view.ov !== null) drawGameOver(cx, cw, ch, view.ov, view);
}

function drawArenaGround(cx: CanvasRenderingContext2D, practice: boolean, nowSec: number) {
  // dirt floor
  cx.fillStyle = practice ? '#8a6b42' : '#6b4a2c';
  cx.fillRect(0, 0, W, H);
  // groomed stripes
  cx.globalAlpha = 0.07;
  cx.fillStyle = '#000';
  for (let i = 0; i < 9; i++) if (i % 2 === 0) cx.fillRect(0, (i * H) / 9, W, H / 9);
  cx.globalAlpha = 1;

  if (practice) {
    // painted yard text + chalk grid
    cx.save();
    cx.globalAlpha = 0.18;
    cx.font = '900 90px system-ui, sans-serif';
    cx.textAlign = 'center';
    cx.fillStyle = '#fff';
    cx.fillText('PRACTICE YARD', W / 2, H * 0.52);
    cx.restore();
    // wooden fence
    cx.strokeStyle = '#4a3a22';
    cx.lineWidth = 22;
    cx.strokeRect(11, 11, W - 22, H - 22);
    cx.strokeStyle = '#5f4a2e';
    cx.lineWidth = 4;
    for (let x = 30; x < W; x += 46) { cx.beginPath(); cx.moveTo(x, 2); cx.lineTo(x, 20); cx.stroke(); cx.beginPath(); cx.moveTo(x, H - 20); cx.lineTo(x, H - 2); cx.stroke(); }
  } else {
    // center logo
    cx.save();
    cx.globalAlpha = 0.16;
    cx.font = '900 100px system-ui, sans-serif';
    cx.textAlign = 'center';
    cx.fillStyle = '#ffd24f';
    cx.fillText('MONSTER JAM', W / 2, H * 0.55);
    cx.restore();
    // stadium boards + crowd
    cx.fillStyle = '#1a1410';
    cx.fillRect(0, 0, W, 26);
    cx.fillRect(0, H - 26, W, 26);
    cx.fillRect(0, 0, 26, H);
    cx.fillRect(W - 26, 0, 26, H);
    // sponsor boards (the finest local businesses)
    cx.font = '900 15px system-ui, sans-serif';
    cx.textAlign = 'center';
    const ads = ['🏓 TSONG', 'PRIME MUTTON™', 'CRUSHBOT PARTS', '🍩 DONUT ZONE', 'TSONG ARENA'];
    for (let i = 0; i < 5; i++) {
      cx.fillStyle = ['#ffd24f', '#ff9ad5', '#43c8ff', '#7dff9a', '#ff9d3f'][i];
      cx.globalAlpha = 0.65;
      cx.fillText(ads[i], W * (0.14 + i * 0.18), H - 13);
    }
    cx.globalAlpha = 1;
    drawCrowd(cx, nowSec);
  }
}

function drawCrowd(cx: CanvasRenderingContext2D, nowSec: number) {
  if (!crowdSeats) {
    crowdSeats = [];
    const palette = ['#ffd24f', '#ff9ad5', '#43c8ff', '#7dff9a', '#ff9d3f', '#c8a2ff', '#eef2f8'];
    for (let i = 0; i < 220; i++) {
      crowdSeats.push({
        t: Math.random(), // 0..1 position along the top rail (we mirror for bottom)
        d: Math.random(), // row depth
        c: palette[Math.floor(Math.random() * palette.length)],
        ph: Math.random() * Math.PI * 2,
      });
    }
  }
  const waveAge = nowSec - waveT;
  for (const s2 of crowdSeats) {
    const onTop = s2.d < 0.5;
    const x = 40 + s2.t * (W - 80);
    const baseY = onTop ? 8 + s2.d * 20 : H - 18 + (s2.d - 0.5) * 20;
    let bounce = Math.sin(nowSec * (2.2 + s2.ph) + s2.ph) * (1.2 + cheerAmp * 3);
    if (waveAge > 0 && waveAge < 3.5) {
      const wavePos = (waveAge / 3.5) * (W + 200) - 100;
      const d = Math.abs(x - wavePos);
      if (d < 120) bounce -= (1 - d / 120) * 10;
    }
    cx.fillStyle = s2.c;
    cx.globalAlpha = 0.85;
    cx.beginPath();
    cx.arc(x, baseY + bounce, 4.5, 0, Math.PI * 2);
    cx.fill();
  }
  cx.globalAlpha = 1;
}

function drawProps(cx: CanvasRenderingContext2D, view: View, practice: boolean, nowSec: number) {
  // donut zone
  cx.save();
  cx.strokeStyle = '#eef2f8';
  cx.globalAlpha = 0.5;
  cx.setLineDash([18, 14]);
  cx.lineWidth = 5;
  cx.beginPath();
  cx.arc(DONUT.x, DONUT.y, DONUT.r, 0, Math.PI * 2);
  cx.stroke();
  cx.setLineDash([]);
  cx.globalAlpha = 0.25;
  cx.strokeStyle = '#2a1c10';
  cx.lineWidth = 26;
  cx.beginPath();
  cx.arc(DONUT.x, DONUT.y, DONUT.r * 0.55, 0, Math.PI * 2);
  cx.stroke();
  cx.globalAlpha = 0.7;
  cx.font = '900 22px system-ui, sans-serif';
  cx.textAlign = 'center';
  cx.fillStyle = '#eef2f8';
  cx.fillText('🌀 DONUT ZONE', DONUT.x, DONUT.y - DONUT.r - 14);
  cx.restore();

  drawRamp(cx, RAMP, '#7a5a34', '#ffd24f', 'BIG AIR 🛫');
  drawPipe(cx, nowSec);

  // junk cars
  for (let i = 0; i < CAR_XS.length; i++) {
    const flat = view.cars[i];
    drawJunkCar(cx, CAR_XS[i], CARS_Y, CAR_PAINTS[i], flat, i);
  }
  cx.font = '900 18px system-ui, sans-serif';
  cx.textAlign = 'center';
  cx.fillStyle = '#eef2f8';
  cx.globalAlpha = 0.6;
  cx.fillText('🚗 CRUSH ROW', W * 0.45, CARS_Y - 46);
  cx.globalAlpha = 1;

  if (practice) {
    for (let i = 0; i < CONE_SPOTS.length; i++) {
      if (view.cones[i]) continue;
      const [x, y] = CONE_SPOTS[i];
      cx.fillStyle = '#ff8a2a';
      cx.beginPath();
      cx.arc(x, y, 11, 0, Math.PI * 2);
      cx.fill();
      cx.fillStyle = '#fff';
      cx.beginPath();
      cx.arc(x, y, 5.5, 0, Math.PI * 2);
      cx.fill();
      cx.fillStyle = '#ff8a2a';
      cx.beginPath();
      cx.arc(x, y, 2.5, 0, Math.PI * 2);
      cx.fill();
    }
  }
}

function drawRamp(cx: CanvasRenderingContext2D, r: { x: number; y: number; a: number; w: number; len: number }, base: string, arrow: string, label: string) {
  cx.save();
  cx.translate(r.x, r.y);
  cx.rotate(r.a);
  // wedge body (light at the low end, dark at the lip)
  const g = cx.createLinearGradient(-r.len / 2, 0, r.len / 2, 0);
  g.addColorStop(0, base);
  g.addColorStop(1, '#3a2a16');
  cx.fillStyle = g;
  cx.beginPath();
  cx.roundRect(-r.len / 2, -r.w / 2, r.len, r.w, 8);
  cx.fill();
  cx.strokeStyle = '#241a0e';
  cx.lineWidth = 4;
  cx.stroke();
  // lip
  cx.fillStyle = '#241a0e';
  cx.fillRect(r.len / 2 - 7, -r.w / 2, 7, r.w);
  // chevrons
  cx.strokeStyle = arrow;
  cx.lineWidth = 6;
  for (let i = 0; i < 3; i++) {
    const x0 = -r.len / 2 + 22 + i * 32;
    cx.beginPath();
    cx.moveTo(x0, -r.w * 0.28);
    cx.lineTo(x0 + 16, 0);
    cx.lineTo(x0, r.w * 0.28);
    cx.stroke();
  }
  cx.restore();
  cx.font = '900 18px system-ui, sans-serif';
  cx.textAlign = 'center';
  cx.fillStyle = '#eef2f8';
  cx.globalAlpha = 0.6;
  cx.fillText(label, r.x, r.y - r.w / 2 - 16);
  cx.globalAlpha = 1;
}

function drawPipe(cx: CanvasRenderingContext2D, nowSec: number) {
  const r = PIPE;
  cx.save();
  cx.translate(r.x, r.y);
  cx.rotate(r.a);
  const g = cx.createLinearGradient(-r.len / 2, 0, r.len / 2, 0);
  g.addColorStop(0, '#3a4a6b');
  g.addColorStop(1, '#141d33');
  cx.fillStyle = g;
  cx.beginPath();
  cx.roundRect(-r.len / 2, -r.w / 2, r.len, r.w, 10);
  cx.fill();
  cx.strokeStyle = '#0e1424';
  cx.lineWidth = 4;
  cx.stroke();
  // curved slats to sell the quarter-pipe
  cx.strokeStyle = '#5a7ab6';
  cx.lineWidth = 3;
  for (let i = 0; i < 4; i++) {
    const x0 = -r.len / 2 + 14 + i * 22;
    cx.beginPath();
    cx.moveTo(x0, -r.w / 2 + 8);
    cx.quadraticCurveTo(x0 + 12, 0, x0, r.w / 2 - 8);
    cx.stroke();
  }
  cx.fillStyle = '#0e1424';
  cx.fillRect(r.len / 2 - 8, -r.w / 2, 8, r.w);
  cx.restore();
  cx.font = '900 18px system-ui, sans-serif';
  cx.textAlign = 'center';
  cx.fillStyle = Math.sin(nowSec * 4) > 0 ? '#9fe8ff' : '#eef2f8';
  cx.globalAlpha = 0.6;
  cx.fillText('FLIP PIPE 🔄', r.x, r.y - r.w / 2 - 16);
  cx.globalAlpha = 1;
}

function drawJunkCar(cx: CanvasRenderingContext2D, x: number, y: number, paint: string, flat: boolean, i: number) {
  cx.save();
  cx.translate(x, y);
  cx.rotate((i % 2 === 0 ? 1 : -1) * 0.12);
  if (flat) cx.scale(1.12, 0.42);
  // body
  cx.fillStyle = flat ? '#3a3f4a' : paint;
  cx.beginPath();
  cx.roundRect(-30, -16, 60, 32, 8);
  cx.fill();
  cx.strokeStyle = '#14161a';
  cx.lineWidth = 2.5;
  cx.stroke();
  if (!flat) {
    cx.fillStyle = '#c9e4ff';
    cx.globalAlpha = 0.8;
    cx.fillRect(-12, -11, 22, 22);
    cx.globalAlpha = 1;
    // little wheels
    cx.fillStyle = '#14161a';
    for (const [wx, wy] of [[-20, -18], [16, -18], [-20, 18], [16, 18]] as [number, number][]) {
      cx.beginPath();
      cx.arc(wx, wy, 5, 0, Math.PI * 2);
      cx.fill();
    }
  } else {
    // pancaked: crack lines
    cx.strokeStyle = '#14161a';
    cx.lineWidth = 2;
    cx.beginPath();
    cx.moveTo(-22, -6); cx.lineTo(-4, 4); cx.lineTo(10, -5); cx.lineTo(24, 3);
    cx.stroke();
  }
  cx.restore();
}

function drawSkids(cx: CanvasRenderingContext2D) {
  cx.save();
  cx.strokeStyle = '#241a10';
  cx.lineWidth = 5;
  for (const sk of skids) {
    cx.globalAlpha = Math.min(0.5, sk.life / 6 * 0.5);
    const px = Math.cos(sk.a + Math.PI / 2) * 14;
    const py = Math.sin(sk.a + Math.PI / 2) * 14;
    for (const sgn of [1, -1]) {
      cx.beginPath();
      cx.moveTo(sk.x + px * sgn - Math.cos(sk.a) * 8, sk.y + py * sgn - Math.sin(sk.a) * 8);
      cx.lineTo(sk.x + px * sgn + Math.cos(sk.a) * 8, sk.y + py * sgn + Math.sin(sk.a) * 8);
      cx.stroke();
    }
  }
  cx.restore();
}

// --- the trucks themselves ---
function drawTruck(cx: CanvasRenderingContext2D, t: ViewTruck, def: TruckDef, nowSec: number, slot: number) {
  // shadow stays on the dirt
  cx.save();
  cx.globalAlpha = 0.3 * Math.max(0.35, 1 - t.z / 700);
  cx.fillStyle = '#000';
  cx.beginPath();
  cx.ellipse(t.x, t.y + 6, 40 * Math.max(0.5, 1 - t.z / 900), 26 * Math.max(0.5, 1 - t.z / 900), 0, 0, Math.PI * 2);
  cx.fill();
  cx.restore();

  const sc = 1 + t.z / 620;
  cx.save();
  cx.translate(t.x, t.y - t.z * 0.55);
  cx.scale(sc, sc);
  cx.rotate(t.a);
  // mid-backflip: fold the sprite along its long axis; belly-up shows the chassis
  const k = Math.cos(t.pitch);
  cx.scale(Math.abs(k) < 0.06 ? (k < 0 ? -0.06 : 0.06) : k, 1);
  drawTruckBody(cx, def, nowSec, k < 0, t.wheelie);
  cx.restore();

  // dizzy stars while tumbling
  if (t.tumble) {
    cx.save();
    cx.font = '18px system-ui, sans-serif';
    cx.textAlign = 'center';
    for (let i = 0; i < 3; i++) {
      const a = nowSec * 5 + (i * Math.PI * 2) / 3;
      cx.fillText('⭐', t.x + Math.cos(a) * 34, t.y - 40 + Math.sin(a) * 10);
    }
    cx.restore();
  }

  // nameplate
  cx.save();
  cx.font = '900 13px system-ui, sans-serif';
  cx.textAlign = 'center';
  cx.fillStyle = def.ui;
  cx.globalAlpha = 0.9;
  cx.fillText(`${slot === mySlot ? '▶ ' : ''}${def.name}`, t.x, t.y - t.z * 0.55 - 52 * sc);
  cx.restore();
}

/** Truck body in local coords, nose pointing +X, ~110px long. */
function drawTruckBody(cx: CanvasRenderingContext2D, def: TruckDef, nowSec: number, belly: boolean, wheelie = false) {
  // wheels (monster-sized)
  cx.fillStyle = '#101216';
  cx.strokeStyle = '#2a3040';
  cx.lineWidth = 3;
  const wheelR = 15;
  for (const [wx, wy] of [[22, -24], [22, 24], [-22, -24], [-22, 24]] as [number, number][]) {
    const front = wx > 0;
    const r = wheelR * (wheelie && front ? 1.35 : 1); // nose-up: front wheels loom closer to camera
    cx.beginPath();
    cx.arc(wx, wy, r, 0, Math.PI * 2);
    cx.fill();
    cx.stroke();
    cx.fillStyle = '#3a4150';
    cx.beginPath();
    cx.arc(wx, wy, r * 0.4, 0, Math.PI * 2);
    cx.fill();
    cx.fillStyle = '#101216';
  }

  if (belly) {
    // upside down mid-flip: chassis, axles, and regret
    cx.fillStyle = '#23272f';
    cx.beginPath();
    cx.roundRect(-30, -17, 60, 34, 9);
    cx.fill();
    cx.strokeStyle = '#3a4150';
    cx.lineWidth = 5;
    cx.beginPath(); cx.moveTo(22, -22); cx.lineTo(22, 22); cx.stroke();
    cx.beginPath(); cx.moveTo(-22, -22); cx.lineTo(-22, 22); cx.stroke();
    cx.fillStyle = '#5a6375';
    cx.beginPath();
    cx.arc(0, 0, 6, 0, Math.PI * 2);
    cx.fill();
    return;
  }

  // body
  cx.fillStyle = def.body;
  cx.beginPath();
  cx.roundRect(-32, -18, 64, 36, 9);
  cx.fill();
  cx.strokeStyle = 'rgba(0,0,0,0.45)';
  cx.lineWidth = 2.5;
  cx.stroke();
  // windshield
  cx.fillStyle = '#b8d8f2';
  cx.globalAlpha = 0.85;
  cx.beginPath();
  cx.roundRect(10, -12, 12, 24, 3);
  cx.fill();
  cx.globalAlpha = 1;

  // paint job
  cx.save();
  switch (def.decal) {
    case 'flames': {
      cx.fillStyle = def.trim;
      for (const sgn of [1, -1]) {
        cx.beginPath();
        cx.moveTo(-30, 12 * sgn);
        cx.quadraticCurveTo(-18, 4 * sgn, -8, 12 * sgn);
        cx.quadraticCurveTo(-2, 6 * sgn, 6, 13 * sgn);
        cx.lineTo(-30, 16 * sgn);
        cx.closePath();
        cx.fill();
      }
      break;
    }
    case 'dragon': {
      cx.fillStyle = def.trim;
      cx.beginPath();
      cx.moveTo(-28, 0);
      cx.quadraticCurveTo(-8, -10, 8, -2);
      cx.quadraticCurveTo(-8, 6, -28, 0);
      cx.fill();
      // eyes up front
      cx.fillStyle = '#fff';
      cx.beginPath(); cx.arc(26, -7, 3, 0, Math.PI * 2); cx.fill();
      cx.beginPath(); cx.arc(26, 7, 3, 0, Math.PI * 2); cx.fill();
      cx.fillStyle = '#14161c';
      cx.beginPath(); cx.arc(27, -7, 1.4, 0, Math.PI * 2); cx.fill();
      cx.beginPath(); cx.arc(27, 7, 1.4, 0, Math.PI * 2); cx.fill();
      break;
    }
    case 'toro': {
      cx.strokeStyle = def.trim;
      cx.lineWidth = 5;
      for (const sgn of [1, -1]) {
        cx.beginPath();
        cx.moveTo(26, 10 * sgn);
        cx.quadraticCurveTo(40, 14 * sgn, 42, 4 * sgn);
        cx.stroke();
      }
      cx.fillStyle = '#14161c';
      cx.beginPath(); cx.arc(28, -4, 2.2, 0, Math.PI * 2); cx.fill();
      cx.beginPath(); cx.arc(28, 4, 2.2, 0, Math.PI * 2); cx.fill();
      cx.fillStyle = def.trim;
      cx.beginPath();
      cx.moveTo(-6, 0); cx.lineTo(-14, -6); cx.lineTo(-12, 0); cx.lineTo(-14, 6);
      cx.closePath();
      cx.fill();
      break;
    }
    case 'shark': {
      // dorsal fin!
      cx.fillStyle = def.trim;
      cx.beginPath();
      cx.moveTo(-14, 0);
      cx.quadraticCurveTo(-4, -3, 8, 0);
      cx.quadraticCurveTo(-4, 3, -14, 0);
      cx.fill();
      cx.fillStyle = '#0e1424';
      cx.beginPath();
      cx.moveTo(-8, -1.5); cx.lineTo(2, -8); cx.lineTo(4, -1.5);
      cx.closePath();
      cx.fill();
      // teeth
      cx.fillStyle = '#fff';
      for (let i = 0; i < 4; i++) {
        const y = -12 + i * 8;
        cx.beginPath();
        cx.moveTo(31, y); cx.lineTo(25, y + 4); cx.lineTo(31, y + 8);
        cx.closePath();
        cx.fill();
      }
      break;
    }
    case 'pirate': {
      cx.fillStyle = '#eef2f8';
      cx.beginPath(); cx.arc(-4, 0, 7, 0, Math.PI * 2); cx.fill();
      cx.fillStyle = def.body;
      cx.beginPath(); cx.arc(-6, -2, 1.8, 0, Math.PI * 2); cx.fill();
      cx.beginPath(); cx.arc(-1, -2, 1.8, 0, Math.PI * 2); cx.fill();
      cx.fillRect(-7, 2.5, 7, 2);
      cx.strokeStyle = '#eef2f8';
      cx.lineWidth = 3;
      cx.beginPath(); cx.moveTo(-13, -8); cx.lineTo(6, 8); cx.stroke();
      cx.beginPath(); cx.moveTo(6, -8); cx.lineTo(-13, 8); cx.stroke();
      cx.strokeStyle = def.trim;
      cx.lineWidth = 2;
      cx.strokeRect(-26, -14, 10, 28);
      break;
    }
    case 'spikes': {
      cx.fillStyle = '#4a5160';
      for (const sgn of [1, -1]) {
        for (let i = 0; i < 4; i++) {
          const x = -24 + i * 15;
          cx.beginPath();
          cx.moveTo(x, 17 * sgn); cx.lineTo(x + 5, 26 * sgn); cx.lineTo(x + 10, 17 * sgn);
          cx.closePath();
          cx.fill();
        }
      }
      cx.strokeStyle = def.trim;
      cx.lineWidth = 3;
      cx.beginPath();
      cx.moveTo(-28, 0); cx.lineTo(8, 0);
      cx.stroke();
      break;
    }
    case 'sheep': {
      // wool everywhere
      cx.fillStyle = '#fdfaf2';
      for (const [bx, by, br] of [[-18, -8, 8], [-8, 4, 9], [-20, 8, 7], [-4, -9, 8], [4, 6, 7], [-12, -1, 9]] as [number, number, number][]) {
        cx.beginPath();
        cx.arc(bx, by, br, 0, Math.PI * 2);
        cx.fill();
      }
      // the face
      cx.fillStyle = '#3a2c1c';
      cx.beginPath();
      cx.roundRect(18, -8, 13, 16, 6);
      cx.fill();
      cx.fillStyle = '#fff';
      cx.beginPath(); cx.arc(24, -4, 2, 0, Math.PI * 2); cx.fill();
      cx.beginPath(); cx.arc(24, 4, 2, 0, Math.PI * 2); cx.fill();
      // ears
      cx.fillStyle = '#3a2c1c';
      cx.beginPath(); cx.ellipse(16, -12, 6, 3, -0.5, 0, Math.PI * 2); cx.fill();
      cx.beginPath(); cx.ellipse(16, 12, 6, 3, 0.5, 0, Math.PI * 2); cx.fill();
      break;
    }
  }
  cx.restore();

  // headlights (nose)
  cx.fillStyle = Math.sin(nowSec * 2) > -0.7 ? '#fff6c8' : '#8a8468';
  cx.beginPath(); cx.arc(31, -10, 2.5, 0, Math.PI * 2); cx.fill();
  cx.beginPath(); cx.arc(31, 10, 2.5, 0, Math.PI * 2); cx.fill();
}

// --- HUD ---
function drawHud(cx: CanvasRenderingContext2D, cw: number, view: View, nowSec: number) {
  const HUD_H = 82;
  cx.fillStyle = 'rgba(10,8,6,0.88)';
  cx.fillRect(0, 0, cw, HUD_H);
  cx.strokeStyle = '#2a3040';
  cx.lineWidth = 1;
  cx.beginPath();
  cx.moveTo(0, HUD_H);
  cx.lineTo(cw, HUD_H);
  cx.stroke();

  cx.textBaseline = 'middle';
  const half = cw / 2;
  for (let slot = 0; slot < 2; slot++) {
    const def = TRUCKS[Math.max(0, view.picks[slot])] ?? TRUCKS[0];
    // slot 1 hugs the right edge when there's room, so the center clock/hint don't collide with it
    const x0 = slot === 0 ? 16 : Math.max(half + 60, cw - 5 * 62 - 24);
    const isMe = slot === (mySlot === 0 ? 0 : 1);
    cx.textAlign = 'left';
    cx.font = '900 16px system-ui, sans-serif';
    cx.fillStyle = def.ui;
    cx.fillText(`${isMe ? '▶ ' : ''}${truckLabel(view, slot)}`, x0, 20);
    cx.font = '12px system-ui, sans-serif';
    cx.fillStyle = '#8a93a5';
    cx.fillText(playerName(slot), x0, 38);
    // the stunt sheet
    const done = view.done[slot];
    const prog = view.prog[slot];
    for (let i = 0; i < N_STUNTS; i++) {
      const sx = x0 + i * 62;
      const sy = 62;
      const ok = done[i];
      cx.font = '18px system-ui, sans-serif';
      cx.globalAlpha = ok ? 1 : 0.4;
      cx.fillText(STUNTS[i].icon, sx, sy);
      cx.globalAlpha = 1;
      cx.font = '900 11px system-ui, sans-serif';
      if (ok) {
        cx.fillStyle = '#39ff5e';
        cx.fillText('✓', sx + 22, sy - 4);
      } else {
        // partial progress readouts for the three "meter" stunts
        cx.fillStyle = '#8a93a5';
        if (i === 2 && prog[0] > 0.3) cx.fillText(`${Math.min(2, Math.floor(prog[0] / (Math.PI * 2)))}/3`, sx + 20, sy - 4);
        else if (i === 3 && prog[2] > 0) cx.fillText(`${Math.min(CRUSH_NEED - 1, prog[2])}/${CRUSH_NEED}`, sx + 20, sy - 4);
        else if (i === 4 && prog[1] > 0.15) cx.fillText(`${Math.min(1.4, prog[1]).toFixed(1)}s`, sx + 20, sy - 4);
      }
    }
  }

  // center clock
  cx.textAlign = 'center';
  cx.font = '900 15px system-ui, sans-serif';
  cx.fillStyle = '#ffd24f';
  if (view.ph === 'show') {
    const el = Math.max(0, view.phT - SHOW_COUNTDOWN);
    const mm = Math.floor(el / 60), ss = Math.floor(el % 60);
    cx.fillText(`📣 SHOW ${mm}:${String(ss).padStart(2, '0')}`, half, 20);
  } else {
    cx.fillText('🚧 PRACTICE', half, 20);
  }
  cx.font = '11px system-ui, sans-serif';
  cx.fillStyle = Math.sin(nowSec * 3) > 0.4 ? '#5a6375' : '#3a4150';
  cx.fillText(touchUI ? 'STUNT button: flip in air, wheelie on dirt' : 'SPACE: flip in air · wheelie on dirt · H: honk', half, 40);
}

// --- touch controls ---
function drawTouchControls(cx: CanvasRenderingContext2D, nowSec: number) {
  cx.save();
  if (stickActive) {
    cx.globalAlpha = 0.28;
    cx.fillStyle = '#eef2f8';
    cx.beginPath();
    cx.arc(joyBaseX, joyBaseY, JOY_R, 0, Math.PI * 2);
    cx.fill();
    cx.globalAlpha = 0.55;
    cx.beginPath();
    cx.arc(joyKnobX, joyKnobY, 26, 0, Math.PI * 2);
    cx.fill();
  }
  const sb = stuntBtn();
  cx.globalAlpha = keys.sk ? 0.9 : 0.5;
  cx.fillStyle = keys.sk ? '#ffd24f' : '#3d3413';
  cx.strokeStyle = '#ffd24f';
  cx.lineWidth = 3;
  cx.beginPath();
  cx.arc(sb.x, sb.y, sb.r + Math.sin(nowSec * 4) * 1.5, 0, Math.PI * 2);
  cx.fill();
  cx.stroke();
  cx.globalAlpha = 1;
  cx.font = '900 15px system-ui, sans-serif';
  cx.textAlign = 'center';
  cx.fillStyle = keys.sk ? '#141821' : '#ffd24f';
  cx.fillText('STUNT', sb.x, sb.y);
  cx.restore();
}

// --- particles / floaters ---
function drawParticlesWorld(cx: CanvasRenderingContext2D) {
  drawParticleList(cx, false);
}
function drawParticlesScreen(cx: CanvasRenderingContext2D) {
  drawParticleList(cx, true);
}
function drawParticleList(cx: CanvasRenderingContext2D, screenSpace: boolean) {
  for (const p of particles) {
    // confetti rains in screen space (it comes from the sky, which is wherever the camera is)
    const isScreen = p.shape === 'confetti' && p.max > 2;
    if (isScreen !== screenSpace) continue;
    const t = p.life / p.max;
    cx.save();
    cx.globalAlpha = Math.min(1, t * 2);
    cx.translate(p.x, p.y);
    cx.rotate(p.rot);
    cx.fillStyle = p.color;
    switch (p.shape) {
      case 'dot':
        cx.beginPath(); cx.arc(0, 0, p.size * (0.5 + t * 0.5), 0, Math.PI * 2); cx.fill();
        break;
      case 'confetti':
        cx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        break;
      case 'flame': {
        cx.beginPath();
        cx.moveTo(-p.size, 0);
        cx.quadraticCurveTo(0, -p.size, p.size, 0);
        cx.quadraticCurveTo(0, p.size, -p.size, 0);
        cx.fill();
        break;
      }
      case 'star': {
        cx.font = `${Math.round(p.size * 2)}px system-ui, sans-serif`;
        cx.textAlign = 'center';
        cx.textBaseline = 'middle';
        cx.fillText('⭐', 0, 0);
        break;
      }
      case 'wool': {
        cx.beginPath();
        cx.arc(0, 0, p.size * (0.6 + t * 0.4), 0, Math.PI * 2);
        cx.fill();
        cx.globalAlpha *= 0.6;
        cx.beginPath();
        cx.arc(p.size * 0.5, -p.size * 0.3, p.size * 0.6, 0, Math.PI * 2);
        cx.fill();
        break;
      }
    }
    cx.restore();
  }
}

function drawFloatersWorld(cx: CanvasRenderingContext2D) {
  for (const f of floaters) {
    const t = f.life / f.max;
    cx.save();
    cx.globalAlpha = Math.min(1, t * 2.5);
    cx.font = `900 ${f.size}px system-ui, sans-serif`;
    cx.textAlign = 'center';
    cx.lineWidth = 4;
    cx.strokeStyle = 'rgba(0,0,0,0.55)';
    cx.strokeText(f.text, f.x, f.y);
    cx.fillStyle = f.color;
    cx.fillText(f.text, f.x, f.y);
    cx.restore();
  }
}
function drawFloatersScreen(cx: CanvasRenderingContext2D) {
  drawFloatersWorld(cx); // lobby floaters use world coords ≈ screen coords; close enough for a menu
}

// --- game over ---
function drawGameOver(cx: CanvasRenderingContext2D, cw: number, ch: number, ov: number, view: View) {
  cx.save();
  cx.fillStyle = 'rgba(8,6,4,0.72)';
  cx.fillRect(0, 0, cw, ch);
  cx.textAlign = 'center';
  cx.textBaseline = 'middle';
  const meIdx = mySlot === 0 ? 0 : 1;
  if (ov === -1) {
    cx.font = '900 44px system-ui, sans-serif';
    cx.fillStyle = '#9aa4b5';
    cx.fillText('🤝 CURFEW — DEAD HEAT!', cw / 2, ch * 0.4);
  } else {
    const def = TRUCKS[Math.max(0, view.picks[ov])] ?? TRUCKS[0];
    cx.font = '900 30px system-ui, sans-serif';
    cx.fillStyle = '#ffd24f';
    cx.fillText('🏆 STUNT CHAMPION 🏆', cw / 2, ch * 0.3);
    cx.font = '900 52px system-ui, sans-serif';
    cx.fillStyle = def.ui;
    cx.fillText(`${def.name.toUpperCase()}`, cw / 2, ch * 0.4);
    cx.font = '700 22px system-ui, sans-serif';
    cx.fillStyle = '#d7dce6';
    cx.fillText(`driven by ${playerName(ov)}`, cw / 2, ch * 0.48);
    cx.font = '900 26px system-ui, sans-serif';
    cx.fillStyle = ov === meIdx ? '#7dff9a' : '#ff9d77';
    cx.fillText(ov === meIdx ? 'ALL FIVE STUNTS — YOU DID IT!!' : 'so close — rematch?', cw / 2, ch * 0.58);
  }
  if (overNote) {
    cx.font = '16px system-ui, sans-serif';
    cx.fillStyle = '#9aa4b5';
    cx.fillText(overNote, cw / 2, ch * 0.66);
  }
  cx.font = '700 15px system-ui, sans-serif';
  cx.fillStyle = '#8a93a5';
  cx.fillText(touchUI ? 'tap for another show' : 'click for another show · ESC to leave', cw / 2, ch * 0.76);
  cx.restore();
}
