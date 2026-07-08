// TNT Explosion Rally — a 1v1 bomb-parry maze duel, faithfully implemented from a game
// design dictated by a six-year-old game director:
//
//   "There is an arena. The arena has a maze inside. It's 1-v-1. You throw bombs at other
//    people. The bombs explode. When the bombs explode they drop wooden blocks sometimes.
//    With the block, your opponent can throw the block at the bomb and the bomb will not
//    explode, and the bomb gets hit back towards the opponent. When you throw the bomb at
//    your opponent it explodes. When they have 5 hearts if a bomb explodes, they lose a
//    heart. If you get to 0 hearts you lose."
//
// Networking follows the Super Tsong Bros shape: the server is only a 2-slot lobby + dumb
// relay. Slot 0 (host) simulates EVERYTHING — both players, bombs, blocks, the maze, and
// the practice bot — and streams ~30Hz snapshots; the guest sends inputs and renders.
// Bombs are lobbed in an arc toward the cursor (they sail over walls); wooden blocks are
// thrown flat and hard (walls stop them). Smacking a bomb with a block defuses it and
// fires it straight back at whoever threw it — that's the rally.

import type { TntLobbyMsg } from '../shared/types';

export interface TntNetHooks {
  join: () => void;
  leave: () => void;
  start: () => void;
  end: (winner: number) => void;
  relay: (data: unknown) => void;
  name: () => string;
}

// --- arena constants ---
const COLS = 15;
const ROWS = 11;
const TILE = 52;
const W = COLS * TILE;
const H = ROWS * TILE;
const PR = 17; // player body radius (px)
const P_SPEED = 4.5 * TILE; // run speed px/s
const MAX_THROW = 6.5 * TILE; // bomb lob range
const BOMB_SPEED = 9 * TILE; // bomb flight px/s
const BLOCK_SPEED = 12 * TILE; // thrown wood px/s
const BLOCK_RANGE = 8 * TILE;
const FUSE = 2.0; // seconds a landed bomb ticks
const BOMB_CD = 1.25; // seconds between your throws
const BOOM_R = 1.75 * TILE; // explosion radius
const INVULN = 1.4; // mercy seconds after taking a hit
const HEARTS = 5;
const SD_AT = 75; // sudden death starts at this many seconds
const MAX_PICKUPS = 8;

// --- sim types (host only) ---
interface SimPlayer {
  x: number; y: number;
  hearts: number;
  carry: number; // wooden blocks held (0 or 1)
  aimX: number; aimY: number;
  invUntil: number; cdUntil: number;
  mvx: number; mvy: number; // movement intent -1..1
  kx: number; ky: number; // knockback velocity px/s
  bombSeq: number; blockSeq: number; // guest action counters already processed
}
interface SimBomb {
  id: number;
  st: 0 | 1 | 2; // 0 = flying (lobbed arc), 1 = ticking on the ground, 2 = falling from the sky
  x: number; y: number;
  sx: number; sy: number; tx: number; ty: number;
  p: number; dur: number; // flight progress 0..1 over dur seconds
  fuse: number;
  owner: number; // -1 = the sky (sudden death) — hurts everyone
  dead?: boolean;
}
interface SimShot { x: number; y: number; vx: number; vy: number; owner: number; left: number }
interface Pickup { x: number; y: number }
type Fx =
  | { k: 'boom'; x: number; y: number; r: number }
  | { k: 'parry'; x: number; y: number }
  | { k: 'bonk'; x: number; y: number }
  | { k: 'hurt'; s: number; x: number; y: number }
  | { k: 'crate'; x: number; y: number }
  | { k: 'pick'; x: number; y: number }
  | { k: 'throw'; x: number; y: number }
  | { k: 'sd' };

interface BotBrain {
  mx: number; my: number;
  rethink: number;
  strafeSign: number;
  nextBomb: number;
  parryCd: number;
  lastX: number; lastY: number; stuckCheck: number; overrideUntil: number; omx: number; omy: number;
}
interface Sim {
  grid: number[]; // 0 floor, 1 stone, 2 wooden crate
  gv: number; gridDirty: boolean; refreshIn: number;
  pl: SimPlayer[];
  bombs: SimBomb[];
  shots: SimShot[];
  pickups: Pickup[];
  t: number;
  nextId: number;
  sd: boolean; sdNext: number;
  over: number | null; // winning slot; -2 = double KO
  practice: boolean;
  bot: BotBrain | null;
  fxPend: Fx[];
  snapTimer: number;
}

// --- guest snapshot types ---
interface SnapPl { x: number; y: number; h: number; c: number; ax: number; ay: number; iv: number; cd: number }
interface SnapBomb { i: number; x: number; y: number; st: number; p: number; f: number; o: number }
interface Snap {
  t: 'snap';
  gv: number; grid?: string;
  pl: SnapPl[];
  bo: SnapBomb[];
  bl: [number, number][];
  sh: [number, number][];
  fx: Fx[];
  sd: boolean; tm: number;
  ov: number | null;
}
interface GuestIn { t: 'in'; u: boolean; d: boolean; l: boolean; r: boolean; ax: number; ay: number; nb: number; nk: number }

// --- view (what gets drawn — host builds it from the sim, guest from snapshots) ---
interface ViewPlayer { x: number; y: number; h: number; c: number; ax: number; ay: number; inv: boolean; cd: number }
interface View {
  pl: ViewPlayer[];
  bo: { x: number; y: number; st: number; p: number; f: number }[];
  bl: { x: number; y: number }[];
  sh: { x: number; y: number }[];
  sd: boolean; tm: number; ov: number | null;
}

// --- module state ---
let net: TntNetHooks | null = null;
let overlay: HTMLDivElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let raf = 0;
let running = false;
let lastFrame = 0;

type Screen = 'lobby' | 'playing';
let screen: Screen = 'lobby';
let lobby: TntLobbyMsg | null = null;
let mySlot = -1;
let overNote: string | null = null; // extra line on the game-over banner ("opponent fled")
let endReported = false;

let sim: Sim | null = null; // host only

// guest snapshot interpolation
let snapPrev: { s: Snap; at: number } | null = null;
let snapCur: { s: Snap; at: number } | null = null;
let guestGrid: number[] = [];
let guestGv = -1;

// local input
const keys = { u: false, d: false, l: false, r: false };
let aimX = W / 2, aimY = H / 2;
let gSentBomb = 0, gSentBlock = 0; // guest action counters
let inputDirty = false;
let inputTimer = 0;

// view transform (world→screen), recomputed each draw, used to invert the mouse
let vScale = 1, vOx = 0, vOy = 0;

// local juice
interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color: string; grav: number; shape: 'dot' | 'wood' | 'confetti'; rot: number; vr: number }
interface Floater { x: number; y: number; text: string; life: number; max: number; color: string; size: number }
let particles: Particle[] = [];
let floaters: Floater[] = [];
let shakeMag = 0;
let confettiTimer = 0;

// hidden nonsense: type "woof" mid-game for fetch mode, "meow" for yarn mode. Shh.
let skinBuf = '';
let bombSkin: 'tnt' | 'fetch' | 'yarn' = 'tnt';

const P_COLORS = ['#ff9d3f', '#43c8ff'];
const BOT_NAME = '🤖 TNT Bot';

// ---------------------------------------------------------------- lifecycle

export function startTnt(hooks: TntNetHooks) {
  net = hooks;
  build();
  if (!overlay) return;
  running = true;
  screen = 'lobby';
  lobby = null;
  mySlot = -1;
  sim = null;
  snapPrev = snapCur = null;
  guestGrid = [];
  guestGv = -1;
  overNote = null;
  bombSkin = 'tnt';
  particles = [];
  floaters = [];
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
  net?.leave();
  if (overlay) overlay.style.display = 'none';
  sim = null;
  snapPrev = snapCur = null;
}

function build() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9000;background:#0b0e14;display:none;cursor:crosshair;';
  canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%;height:100%;display:block;';
  overlay.appendChild(canvas);
  document.body.appendChild(overlay);
  ctx = canvas.getContext('2d');
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------------------------------------------------------------- net feeds

export function feedTntLobby(msg: TntLobbyMsg) {
  if (!running) return;
  mySlot = msg.slot;
  if (msg.status === 'ended') {
    // The host bailed — the server tore the lobby down. Hop back in as a fresh lobby.
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
    // Someone stopped playing. If OUR match is still live it means the opponent fled.
    if (mySlot === 0 && sim && sim.over === null && !sim.practice) {
      sim.over = 0;
      overNote = 'Your opponent fled the arena! 🏳️';
      snd('win');
    }
  }
}

export function feedTntRelay(data: unknown) {
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
  shakeMag = 0;
  gSentBomb = 0;
  gSentBlock = 0;
  if (mySlot === 0) {
    const practice = (lobby?.players.length ?? 1) < 2;
    sim = makeSim(practice);
  } else {
    sim = null;
    snapPrev = snapCur = null;
    guestGrid = [];
    guestGv = -1;
  }
  snd('throw');
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
  // secret skins: spell it out mid-game
  if (/^[a-z]$/i.test(e.key)) {
    skinBuf = (skinBuf + e.key.toLowerCase()).slice(-6);
    if (skinBuf.endsWith('woof')) { bombSkin = bombSkin === 'fetch' ? 'tnt' : 'fetch'; addFloater(aimX, aimY, '🐕 FETCH MODE!', '#c8f04f', 22); }
    if (skinBuf.endsWith('meow')) { bombSkin = bombSkin === 'yarn' ? 'tnt' : 'yarn'; addFloater(aimX, aimY, '🐈 YARN MODE!', '#ff9ad5', 22); }
  }
  const k = e.key.toLowerCase();
  let used = true;
  if (k === 'w' || k === 'arrowup') keys.u = true;
  else if (k === 's' || k === 'arrowdown') keys.d = true;
  else if (k === 'a' || k === 'arrowleft') keys.l = true;
  else if (k === 'd' || k === 'arrowright') keys.r = true;
  else if (k === ' ') pressBomb();
  else if (k === 'e' || k === 'shift') pressBlock();
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
  else return;
  inputDirty = true;
}

function onBlur() {
  keys.u = keys.d = keys.l = keys.r = false;
  inputDirty = true;
}

function onMouseMove(e: MouseEvent) {
  aimX = (e.clientX - vOx) / vScale;
  aimY = (e.clientY - vOy) / vScale;
  inputDirty = true;
}

function onMouseDown(e: MouseEvent) {
  if (!running) return;
  e.preventDefault();
  if (screen === 'lobby') { lobbyClick(e.clientX, e.clientY); return; }
  const over = currentOver();
  if (over !== null) {
    // game-over banner → any click returns to the lobby screen
    screen = 'lobby';
    sim = null;
    snapPrev = snapCur = null;
    return;
  }
  if (e.button === 2) pressBlock();
  else pressBomb();
}

function pressBomb() {
  if (screen !== 'playing' || currentOver() !== null) return;
  if (mySlot === 0) { if (sim) hostThrowBomb(sim, 0); }
  else { gSentBomb++; sendInput(); }
}

function pressBlock() {
  if (screen !== 'playing' || currentOver() !== null) return;
  if (mySlot === 0) { if (sim) hostThrowBlock(sim, 0); }
  else { gSentBlock++; sendInput(); }
}

function sendInput() {
  if (mySlot !== 0 && screen === 'playing' && net) {
    const msg: GuestIn = { t: 'in', u: keys.u, d: keys.d, l: keys.l, r: keys.r, ax: aimX, ay: aimY, nb: gSentBomb, nk: gSentBlock };
    net.relay(msg);
    inputDirty = false;
    inputTimer = 0;
  }
}

// ---------------------------------------------------------------- host sim

function makeSim(practice: boolean): Sim {
  const grid = makeMaze();
  const p = (): SimPlayer => ({
    x: 0, y: 0, hearts: HEARTS, carry: 0, aimX: W / 2, aimY: H / 2,
    invUntil: 0, cdUntil: 0.6, mvx: 0, mvy: 0, kx: 0, ky: 0, bombSeq: 0, blockSeq: 0,
  });
  const p0 = p(); p0.x = 1.5 * TILE; p0.y = 1.5 * TILE;
  const p1 = p(); p1.x = (COLS - 1.5) * TILE; p1.y = (ROWS - 1.5) * TILE;
  return {
    grid, gv: 0, gridDirty: true, refreshIn: 0,
    pl: [p0, p1], bombs: [], shots: [], pickups: [],
    t: 0, nextId: 1, sd: false, sdNext: 0, over: null,
    practice,
    bot: practice
      ? { mx: 0, my: 0, rethink: 0, strafeSign: 1, nextBomb: 2.2, parryCd: 0, lastX: p1.x, lastY: p1.y, stuckCheck: 0, overrideUntil: 0, omx: 0, omy: 0 }
      : null,
    fxPend: [],
    snapTimer: 0,
  };
}

/** Classic bomberman-flavored maze: stone border, stone pillars on the even lattice, then
 *  wooden crates scattered with 180° point symmetry (fair for both corners), spawn corners
 *  kept clear. Crates blow up; stone doesn't. Bombs arc OVER everything anyway — the maze
 *  is for feet and thrown blocks. */
function makeMaze(): number[] {
  const g = new Array<number>(COLS * ROWS).fill(0);
  const at = (x: number, y: number) => y * COLS + x;
  for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) {
    if (x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1) g[at(x, y)] = 1;
    else if (x % 2 === 0 && y % 2 === 0) g[at(x, y)] = 1;
  }
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x < COLS - 1; x++) {
      const mx = COLS - 1 - x, my = ROWS - 1 - y;
      // decide each mirrored pair exactly once
      if (y * COLS + x > my * COLS + mx) continue;
      if (g[at(x, y)] !== 0) continue;
      if (Math.random() < 0.42) { g[at(x, y)] = 2; g[at(mx, my)] = 2; }
    }
  }
  // keep the spawn pockets open
  for (const [cx, cy] of [[1, 1], [COLS - 2, ROWS - 2]]) {
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      if (Math.abs(dx) + Math.abs(dy) > 2) continue;
      const x = cx + dx, y = cy + dy;
      if (x > 0 && y > 0 && x < COLS - 1 && y < ROWS - 1 && g[at(x, y)] === 2) g[at(x, y)] = 0;
    }
  }
  return g;
}

function solidAt(grid: number[], px: number, py: number): boolean {
  const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
  if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) return true;
  return grid[ty * COLS + tx] !== 0;
}

function applyGuestInput(m: GuestIn) {
  if (!sim || sim.practice) return;
  const p = sim.pl[1];
  p.mvx = (m.r ? 1 : 0) - (m.l ? 1 : 0);
  p.mvy = (m.d ? 1 : 0) - (m.u ? 1 : 0);
  if (typeof m.ax === 'number' && isFinite(m.ax)) p.aimX = Math.max(0, Math.min(W, m.ax));
  if (typeof m.ay === 'number' && isFinite(m.ay)) p.aimY = Math.max(0, Math.min(H, m.ay));
  while (p.bombSeq < (m.nb | 0)) { p.bombSeq++; hostThrowBomb(sim, 1); }
  while (p.blockSeq < (m.nk | 0)) { p.blockSeq++; hostThrowBlock(sim, 1); }
}

function hostThrowBomb(s: Sim, i: number) {
  if (s.over !== null) return;
  const p = s.pl[i];
  if (s.t < p.cdUntil) return;
  p.cdUntil = s.t + BOMB_CD;
  const land = findLanding(s.grid, p.x, p.y, p.aimX, p.aimY);
  const d = Math.hypot(land.x - p.x, land.y - p.y);
  s.bombs.push({
    id: s.nextId++, st: 0, x: p.x, y: p.y, sx: p.x, sy: p.y, tx: land.x, ty: land.y,
    p: 0, dur: Math.max(0.22, d / BOMB_SPEED), fuse: FUSE, owner: i,
  });
  emitFx(s, { k: 'throw', x: p.x, y: p.y });
}

function hostThrowBlock(s: Sim, i: number) {
  if (s.over !== null) return;
  const p = s.pl[i];
  if (p.carry < 1) return;
  p.carry--;
  let dx = p.aimX - p.x, dy = p.aimY - p.y;
  const d = Math.hypot(dx, dy);
  if (d < 1) { dx = 1; dy = 0; } else { dx /= d; dy /= d; }
  s.shots.push({ x: p.x + dx * (PR + 8), y: p.y + dy * (PR + 8), vx: dx * BLOCK_SPEED, vy: dy * BLOCK_SPEED, owner: i, left: BLOCK_RANGE });
  emitFx(s, { k: 'throw', x: p.x, y: p.y });
}

/** Where does a lob aimed at (tx,ty) actually land? Range-clamped, then walked back along
 *  the throw line until it's over open floor (you can't park a bomb inside a wall). */
function findLanding(grid: number[], sx: number, sy: number, tx: number, ty: number): { x: number; y: number } {
  let dx = tx - sx, dy = ty - sy;
  const d = Math.hypot(dx, dy) || 1;
  if (d > MAX_THROW) { dx *= MAX_THROW / d; dy *= MAX_THROW / d; }
  const cx = Math.max(TILE * 1.15, Math.min(W - TILE * 1.15, sx + dx));
  const cy = Math.max(TILE * 1.15, Math.min(H - TILE * 1.15, sy + dy));
  for (let f = 1; f >= 0; f -= 0.06) {
    const x = sx + (cx - sx) * f, y = sy + (cy - sy) * f;
    if (!solidAt(grid, x, y)) return { x, y };
  }
  return { x: sx, y: sy };
}

function clampMoveX(grid: number[], x: number, y: number, dx: number): number {
  if (!dx) return x;
  const nx = x + dx;
  const dir = Math.sign(dx);
  const edge = nx + dir * PR;
  const tx = Math.floor(edge / TILE);
  for (const sy of [y - PR * 0.75, y + PR * 0.75]) {
    const ty = Math.floor(sy / TILE);
    if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS || grid[ty * COLS + tx] !== 0) {
      return (dir > 0 ? tx * TILE - PR : (tx + 1) * TILE + PR) - dir * 0.01;
    }
  }
  return nx;
}

function clampMoveY(grid: number[], x: number, y: number, dy: number): number {
  if (!dy) return y;
  const ny = y + dy;
  const dir = Math.sign(dy);
  const edge = ny + dir * PR;
  const ty = Math.floor(edge / TILE);
  for (const sx of [x - PR * 0.75, x + PR * 0.75]) {
    const tx = Math.floor(sx / TILE);
    if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS || grid[ty * COLS + tx] !== 0) {
      return (dir > 0 ? ty * TILE - PR : (ty + 1) * TILE + PR) - dir * 0.01;
    }
  }
  return ny;
}

function nearestFreeSpot(grid: number[], x: number, y: number): { x: number; y: number } {
  const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const nx = tx + dx, ny = ty + dy;
    if (nx <= 0 || ny <= 0 || nx >= COLS - 1 || ny >= ROWS - 1) continue;
    if (grid[ny * COLS + nx] !== 0) continue;
    const cx = (nx + 0.5) * TILE, cy = (ny + 0.5) * TILE;
    const d = Math.hypot(cx - x, cy - y);
    if (d < bestD) { bestD = d; best = { x: cx, y: cy }; }
  }
  return best ?? { x, y };
}

function addPickup(s: Sim, x: number, y: number) {
  if (s.pickups.length >= MAX_PICKUPS) return;
  const spot = solidAt(s.grid, x, y) ? nearestFreeSpot(s.grid, x, y) : { x, y };
  s.pickups.push(spot);
}

function emitFx(s: Sim, e: Fx) {
  s.fxPend.push(e);
  applyFx(e); // the host feels it immediately; the guest gets it in the next snapshot
}

function stepSim(s: Sim, dt: number) {
  if (s.over !== null) {
    // frozen tableau behind the banner — still report once
    if (!endReported) {
      endReported = true;
      let report = s.over;
      if (s.over === -2) report = -1; // double KO — nobody gets paid
      if (s.practice && s.over === 1) report = -1; // the bot can't collect coins (it has tried)
      net?.end(report);
    }
    return;
  }
  s.t += dt;

  // local (host) input → player 0
  const p0 = s.pl[0];
  p0.mvx = (keys.r ? 1 : 0) - (keys.l ? 1 : 0);
  p0.mvy = (keys.d ? 1 : 0) - (keys.u ? 1 : 0);
  p0.aimX = aimX; p0.aimY = aimY;

  if (s.bot) stepBot(s, dt);

  // players: move + collide + grab wood
  for (const p of s.pl) {
    let mx = p.mvx, my = p.mvy;
    const mag = Math.hypot(mx, my);
    if (mag > 1) { mx /= mag; my /= mag; }
    const dx = mx * P_SPEED * dt + p.kx * dt;
    const dy = my * P_SPEED * dt + p.ky * dt;
    p.x = clampMoveX(s.grid, p.x, p.y, dx);
    p.y = clampMoveY(s.grid, p.x, p.y, dy);
    const decay = Math.max(0, 1 - 6 * dt);
    p.kx *= decay; p.ky *= decay;
    if (p.carry < 1) {
      for (let i = s.pickups.length - 1; i >= 0; i--) {
        const b = s.pickups[i];
        if (Math.hypot(b.x - p.x, b.y - p.y) < TILE * 0.55) {
          s.pickups.splice(i, 1);
          p.carry++;
          emitFx(s, { k: 'pick', x: p.x, y: p.y });
          break;
        }
      }
    }
  }

  // bombs
  for (const b of s.bombs) {
    if (b.dead) continue;
    if (b.st === 0) {
      b.p += dt / b.dur;
      const f = Math.min(1, b.p);
      b.x = b.sx + (b.tx - b.sx) * f;
      b.y = b.sy + (b.ty - b.sy) * f;
      // "when you throw the bomb at your opponent it explodes" — direct hit, no fuse
      if (b.p > 0.3) {
        for (let j = 0; j < s.pl.length; j++) {
          if (j === b.owner) continue;
          const q = s.pl[j];
          if (Math.hypot(q.x - b.x, q.y - b.y) < PR + 15) {
            b.dead = true;
            explode(s, b.x, b.y);
            break;
          }
        }
      }
      if (!b.dead && b.p >= 1) { b.st = 1; b.x = b.tx; b.y = b.ty; b.fuse = FUSE; }
    } else if (b.st === 2) {
      b.p += dt / b.dur;
      if (b.p >= 1) { b.st = 1; b.fuse = 2.2; }
    } else {
      b.fuse -= dt;
      if (b.fuse <= 0) { b.dead = true; explode(s, b.x, b.y); }
    }
  }
  s.bombs = s.bombs.filter((b) => !b.dead);

  // thrown wooden blocks
  for (let i = s.shots.length - 1; i >= 0; i--) {
    const sh = s.shots[i];
    const step = Math.hypot(sh.vx, sh.vy) * dt;
    sh.x += sh.vx * dt;
    sh.y += sh.vy * dt;
    sh.left -= step;
    let gone = false;
    // THE mechanic: wood meets bomb → bomb defused and smacked back at its thrower
    for (const b of s.bombs) {
      if (b.dead) continue;
      if (Math.hypot(b.x - sh.x, b.y - sh.y) < TILE * 0.58) {
        const victim = b.owner >= 0 ? b.owner : 1 - sh.owner;
        const target = s.pl[victim] ?? s.pl[1 - sh.owner];
        const land = findLanding(s.grid, b.x, b.y, target.x, target.y);
        b.st = 0;
        b.sx = b.x; b.sy = b.y; b.tx = land.x; b.ty = land.y;
        const d = Math.hypot(land.x - b.x, land.y - b.y);
        b.dur = Math.max(0.2, d / (BOMB_SPEED * 1.3)); // parried bombs come back HOT
        b.p = 0;
        b.fuse = FUSE;
        b.owner = sh.owner; // it's yours now — it can hit the one who threw it
        emitFx(s, { k: 'parry', x: sh.x, y: sh.y });
        gone = true;
        break;
      }
    }
    if (!gone) {
      // bonk the other player (no damage — just rude)
      for (let j = 0; j < s.pl.length; j++) {
        if (j === sh.owner) continue;
        const q = s.pl[j];
        if (Math.hypot(q.x - sh.x, q.y - sh.y) < PR + 12) {
          const d = Math.hypot(sh.vx, sh.vy) || 1;
          q.kx += (sh.vx / d) * 320;
          q.ky += (sh.vy / d) * 320;
          emitFx(s, { k: 'bonk', x: sh.x, y: sh.y });
          addPickup(s, sh.x, sh.y);
          gone = true;
          break;
        }
      }
    }
    if (!gone && (solidAt(s.grid, sh.x, sh.y) || sh.left <= 0)) {
      addPickup(s, sh.x - sh.vx * dt, sh.y - sh.vy * dt);
      gone = true;
    }
    if (gone) s.shots.splice(i, 1);
  }

  // sudden death: the sky joins the fight
  if (!s.sd && s.t >= SD_AT) {
    s.sd = true;
    s.sdNext = s.t + 0.8;
    emitFx(s, { k: 'sd' });
  }
  if (s.sd && s.t >= s.sdNext) {
    s.sdNext = s.t + Math.max(0.7, 1.5 - (s.t - SD_AT) * 0.01);
    for (let tries = 0; tries < 20; tries++) {
      const tx = 1 + Math.floor(Math.random() * (COLS - 2));
      const ty = 1 + Math.floor(Math.random() * (ROWS - 2));
      if (s.grid[ty * COLS + tx] !== 0) continue;
      const x = (tx + 0.5) * TILE, y = (ty + 0.5) * TILE;
      s.bombs.push({ id: s.nextId++, st: 2, x, y, sx: x, sy: y, tx: x, ty: y, p: 0, dur: 1.15, fuse: 2.2, owner: -1 });
      break;
    }
  }

  // deaths → game over
  const dead0 = s.pl[0].hearts <= 0, dead1 = s.pl[1].hearts <= 0;
  if (dead0 || dead1) {
    s.over = dead0 && dead1 ? -2 : dead0 ? 1 : 0;
    snd(s.over === mySlot ? 'win' : 'lose');
    sendSnap(s, true); // make sure the guest sees the ending before the server lobby resets
  }
}

function explode(s: Sim, x0: number, y0: number) {
  const queue: [number, number][] = [[x0, y0]];
  while (queue.length) {
    const next = queue.shift();
    if (!next) break;
    const [bx, by] = next;
    emitFx(s, { k: 'boom', x: bx, y: by, r: BOOM_R });
    // hearts
    for (let i = 0; i < s.pl.length; i++) {
      const p = s.pl[i];
      if (s.t < p.invUntil) continue;
      const d = Math.hypot(p.x - bx, p.y - by);
      if (d < BOOM_R + PR * 0.6) {
        p.hearts--;
        p.invUntil = s.t + INVULN;
        const n = d || 1;
        p.kx += ((p.x - bx) / n) * 460;
        p.ky += ((p.y - by) / n) * 460;
        emitFx(s, { k: 'hurt', s: i, x: p.x, y: p.y });
      }
    }
    // crates splinter — and "when the bombs explode they drop wooden blocks sometimes"
    const t0x = Math.max(1, Math.floor((bx - BOOM_R) / TILE)), t1x = Math.min(COLS - 2, Math.floor((bx + BOOM_R) / TILE));
    const t0y = Math.max(1, Math.floor((by - BOOM_R) / TILE)), t1y = Math.min(ROWS - 2, Math.floor((by + BOOM_R) / TILE));
    for (let ty = t0y; ty <= t1y; ty++) for (let tx = t0x; tx <= t1x; tx++) {
      if (s.grid[ty * COLS + tx] !== 2) continue;
      const cx = (tx + 0.5) * TILE, cy = (ty + 0.5) * TILE;
      if (Math.hypot(cx - bx, cy - by) < BOOM_R + TILE * 0.35) {
        s.grid[ty * COLS + tx] = 0;
        s.gv++;
        s.gridDirty = true;
        emitFx(s, { k: 'crate', x: cx, y: cy });
        if (Math.random() < 0.3) addPickup(s, cx, cy);
      }
    }
    if (Math.random() < 0.45) addPickup(s, bx, by);
    // chain reactions
    for (const b of s.bombs) {
      if (b.dead) continue;
      if ((b.st === 1 || (b.st === 0 && b.p > 0.55)) && Math.hypot(b.x - bx, b.y - by) < BOOM_R * 0.9) {
        b.dead = true;
        queue.push([b.x, b.y]);
      }
    }
  }
}

// --- the practice bot: chases, lobs, flees fuses, and yes — it parries ---
function stepBot(s: Sim, dt: number) {
  const brain = s.bot;
  if (!brain) return;
  const me = s.pl[1], you = s.pl[0];
  me.aimX = you.x; me.aimY = you.y;
  brain.rethink -= dt;

  // 1) run from anything about to go boom
  let fleeX = 0, fleeY = 0, danger = false;
  for (const b of s.bombs) {
    if (b.dead) continue;
    const bx = b.st === 0 ? b.tx : b.x, by = b.st === 0 ? b.ty : b.y;
    const d = Math.hypot(me.x - bx, me.y - by);
    const dr = BOOM_R + TILE * 1.1;
    if (d < dr) { danger = true; fleeX += ((me.x - bx) / (d || 1)) * (dr - d); fleeY += ((me.y - by) / (d || 1)) * (dr - d); }
  }
  if (danger) {
    const m = Math.hypot(fleeX, fleeY) || 1;
    brain.mx = fleeX / m; brain.my = fleeY / m;
  } else if (brain.rethink <= 0) {
    brain.rethink = 0.45 + Math.random() * 0.35;
    brain.strafeSign = Math.random() < 0.35 ? -brain.strafeSign : brain.strafeSign;
    // 2) want wood? go shopping
    let goal: { x: number; y: number } | null = null;
    if (me.carry < 1) {
      let bestD = 6 * TILE;
      for (const b of s.pickups) {
        const d = Math.hypot(b.x - me.x, b.y - me.y);
        if (d < bestD) { bestD = d; goal = b; }
      }
    }
    // 3) otherwise kite the player at mid range
    if (!goal) {
      const d = Math.hypot(you.x - me.x, you.y - me.y);
      if (d > 5.5 * TILE) goal = you;
      else if (d < 2.5 * TILE) goal = { x: me.x + (me.x - you.x), y: me.y + (me.y - you.y) };
      else {
        const nx = (you.y - me.y) / (d || 1), ny = -(you.x - me.x) / (d || 1);
        goal = { x: me.x + nx * brain.strafeSign * 100, y: me.y + ny * brain.strafeSign * 100 };
      }
    }
    const gx = goal.x - me.x, gy = goal.y - me.y;
    const gm = Math.hypot(gx, gy) || 1;
    brain.mx = gx / gm + (Math.random() - 0.5) * 0.5;
    brain.my = gy / gm + (Math.random() - 0.5) * 0.5;
  }
  // unstick: if it wanted to move but didn't, pick a random direction for a bit
  brain.stuckCheck -= dt;
  if (brain.stuckCheck <= 0) {
    const moved = Math.hypot(me.x - brain.lastX, me.y - brain.lastY);
    if (moved < 3 && Math.hypot(brain.mx, brain.my) > 0.2) {
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const pick = dirs[Math.floor(Math.random() * dirs.length)];
      brain.omx = pick[0]; brain.omy = pick[1];
      brain.overrideUntil = s.t + 0.6;
    }
    brain.lastX = me.x; brain.lastY = me.y;
    brain.stuckCheck = 0.45;
  }
  if (s.t < brain.overrideUntil) { me.mvx = brain.omx; me.mvy = brain.omy; }
  else { me.mvx = brain.mx; me.mvy = brain.my; }

  // 4) lob a bomb (with a lead and a wobble — it's a bot, not a sniper)
  const distToYou = Math.hypot(you.x - me.x, you.y - me.y);
  if (s.t >= brain.nextBomb && s.t >= me.cdUntil && distToYou < 8 * TILE) {
    me.aimX = you.x + you.mvx * P_SPEED * 0.35 + (Math.random() - 0.5) * TILE * 1.6;
    me.aimY = you.y + you.mvy * P_SPEED * 0.35 + (Math.random() - 0.5) * TILE * 1.6;
    hostThrowBomb(s, 1);
    brain.nextBomb = s.t + 1.7 + Math.random() * 1.6;
  }

  // 5) the showpiece: parry incoming bombs with wood
  if (me.carry > 0 && s.t >= brain.parryCd) {
    for (const b of s.bombs) {
      if (b.dead || b.owner === 1) continue;
      const threat =
        (b.st === 0 && b.p > 0.25 && Math.hypot(b.tx - me.x, b.ty - me.y) < 3 * TILE) ||
        (b.st === 1 && Math.hypot(b.x - me.x, b.y - me.y) < 3.2 * TILE);
      if (threat && Math.random() < 0.85) {
        me.aimX = b.x; me.aimY = b.y;
        hostThrowBlock(s, 1);
        brain.parryCd = s.t + 0.9;
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- snapshots

function sendSnap(s: Sim, force = false) {
  if (!net) return;
  if (s.practice) { s.fxPend = []; return; } // nobody's listening
  s.refreshIn -= 1;
  const snap: Snap = {
    t: 'snap',
    gv: s.gv,
    pl: s.pl.map((p) => ({
      x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10,
      h: p.hearts, c: p.carry, ax: Math.round(p.aimX), ay: Math.round(p.aimY),
      iv: Math.max(0, p.invUntil - s.t), cd: Math.min(1, Math.max(0, 1 - (p.cdUntil - s.t) / BOMB_CD)),
    })),
    bo: s.bombs.map((b) => ({ i: b.id, x: Math.round(b.x), y: Math.round(b.y), st: b.st, p: b.p, f: b.fuse, o: b.owner })),
    bl: s.pickups.map((b) => [Math.round(b.x), Math.round(b.y)] as [number, number]),
    sh: s.shots.map((sh) => [Math.round(sh.x), Math.round(sh.y)] as [number, number]),
    fx: s.fxPend,
    sd: s.sd,
    tm: s.t,
    ov: s.over,
  };
  if (s.gridDirty || s.refreshIn <= 0 || force) {
    snap.grid = s.grid.join('');
    s.gridDirty = false;
    s.refreshIn = 60; // periodic refresh in case a frame got dropped
  }
  net.relay(snap);
  s.fxPend = [];
}

function applySnap(snap: Snap) {
  if (!snap || !Array.isArray(snap.pl) || snap.pl.length < 2) return;
  const now = performance.now() / 1000;
  snapPrev = snapCur;
  snapCur = { s: snap, at: now };
  if (typeof snap.grid === 'string' && snap.gv !== guestGv) {
    guestGrid = snap.grid.split('').map((c) => Number(c) || 0);
    guestGv = snap.gv;
  } else if (typeof snap.grid === 'string' && guestGrid.length === 0) {
    guestGrid = snap.grid.split('').map((c) => Number(c) || 0);
    guestGv = snap.gv;
  }
  for (const e of snap.fx) applyFx(e);
}

function currentOver(): number | null {
  if (mySlot === 0) return sim?.over ?? null;
  return snapCur?.s.ov ?? null;
}

// ---------------------------------------------------------------- juice (fx, particles, sound)

function applyFx(e: Fx) {
  switch (e.k) {
    case 'boom': {
      shakeMag = Math.max(shakeMag, 13);
      const woody = bombSkin === 'fetch';
      for (let i = 0; i < 26; i++) {
        const a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 320;
        particles.push({
          x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          life: 0.5 + Math.random() * 0.4, max: 0.9, size: 3 + Math.random() * 5,
          color: woody ? (Math.random() < 0.5 ? '#c8f04f' : '#e8ff9a') : ['#ffdf6b', '#ff9d3f', '#ff5b3f', '#fff3c4'][i % 4],
          grav: 140, shape: 'dot', rot: 0, vr: 0,
        });
      }
      snd('boom');
      break;
    }
    case 'parry': {
      shakeMag = Math.max(shakeMag, 6);
      addFloater(e.x, e.y - 20, bombSkin === 'fetch' ? 'FETCH!' : 'SMACK!', '#7dff9a', 24);
      for (let i = 0; i < 12; i++) {
        const a = Math.random() * Math.PI * 2, sp = 100 + Math.random() * 200;
        particles.push({ x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.4, max: 0.4, size: 2 + Math.random() * 3, color: '#b8ffcb', grav: 0, shape: 'dot', rot: 0, vr: 0 });
      }
      snd('parry');
      break;
    }
    case 'bonk':
      addFloater(e.x, e.y - 16, 'BONK!', '#ffd24f', 20);
      snd('bonk');
      break;
    case 'hurt':
      addFloater(e.x, e.y - PR - 8, '-💔', '#ff6b6b', 22);
      shakeMag = Math.max(shakeMag, e.s === mySlot ? 10 : 5);
      snd('hurt');
      break;
    case 'crate':
      for (let i = 0; i < 8; i++) {
        const a = Math.random() * Math.PI * 2, sp = 50 + Math.random() * 180;
        particles.push({ x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, life: 0.6, max: 0.6, size: 4 + Math.random() * 4, color: Math.random() < 0.5 ? '#9a6a33' : '#c08a4a', grav: 300, shape: 'wood', rot: Math.random() * 6, vr: (Math.random() - 0.5) * 12 });
      }
      break;
    case 'pick':
      addFloater(e.x, e.y - PR - 6, '🪵', '#e8c07a', 18);
      snd('pick');
      break;
    case 'throw':
      snd('throw');
      break;
    case 'sd':
      addFloater(W / 2, H / 2 - 40, '🌋 SUDDEN DEATH! 🌋', '#ff5b3f', 34);
      shakeMag = Math.max(shakeMag, 10);
      snd('sd');
      break;
  }
}

function addFloater(x: number, y: number, text: string, color: string, size: number) {
  floaters.push({ x, y, text, life: 1.2, max: 1.2, color, size });
}

let ac: AudioContext | null = null;
function tone(f0: number, f1: number, dur: number, type: OscillatorType, vol: number) {
  try {
    if (!ac) ac = new AudioContext();
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    const t0 = ac.currentTime;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(ac.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  } catch { /* audio is a bonus, never a crash */ }
}
function snd(kind: string) {
  switch (kind) {
    case 'boom': tone(160, 28, 0.5, 'square', 0.09); tone(90, 22, 0.6, 'sawtooth', 0.07); break;
    case 'parry': tone(680, 1560, 0.14, 'square', 0.06); break;
    case 'bonk': tone(240, 130, 0.12, 'square', 0.06); break;
    case 'hurt': tone(300, 90, 0.28, 'sawtooth', 0.07); break;
    case 'pick': tone(520, 880, 0.1, 'sine', 0.05); break;
    case 'throw': tone(420, 180, 0.12, 'triangle', 0.035); break;
    case 'sd': tone(80, 60, 0.8, 'sawtooth', 0.08); tone(120, 240, 0.5, 'square', 0.05); break;
    case 'win': tone(523, 523, 0.12, 'square', 0.06); setTimeout(() => tone(659, 659, 0.12, 'square', 0.06), 130); setTimeout(() => tone(784, 1046, 0.3, 'square', 0.07), 260); break;
    case 'lose': tone(330, 320, 0.2, 'sawtooth', 0.06); setTimeout(() => tone(250, 240, 0.2, 'sawtooth', 0.06), 220); setTimeout(() => tone(160, 80, 0.5, 'sawtooth', 0.07), 440); break;
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

  // local juice always steps
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
    f.y -= 28 * dt;
    if (f.life <= 0) floaters.splice(i, 1);
  }
  shakeMag = Math.max(0, shakeMag - 34 * dt);

  const over = currentOver();
  if (screen === 'playing' && over !== null && over === mySlot) {
    confettiTimer -= dt;
    if (confettiTimer <= 0) {
      confettiTimer = 0.06;
      particles.push({
        x: Math.random() * W, y: -10, vx: (Math.random() - 0.5) * 60, vy: 80 + Math.random() * 120,
        life: 2.4, max: 2.4, size: 4 + Math.random() * 4,
        color: ['#ff5b3f', '#ffd24f', '#7dff9a', '#43c8ff', '#ff9ad5'][Math.floor(Math.random() * 5)],
        grav: 60, shape: 'confetti', rot: Math.random() * 6, vr: (Math.random() - 0.5) * 10,
      });
    }
  }

  draw(now / 1000);
}

// ---------------------------------------------------------------- rendering

function fit(): { cw: number; ch: number } {
  const c = canvas;
  const cx = ctx;
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

function buildView(nowSec: number): View | null {
  if (mySlot === 0 && sim) {
    const s = sim;
    return {
      pl: s.pl.map((p) => ({ x: p.x, y: p.y, h: p.hearts, c: p.carry, ax: p.aimX, ay: p.aimY, inv: s.t < p.invUntil, cd: Math.min(1, Math.max(0, 1 - (p.cdUntil - s.t) / BOMB_CD)) })),
      bo: s.bombs.map((b) => ({ x: b.x, y: b.y, st: b.st, p: b.p, f: b.fuse })),
      bl: s.pickups.map((b) => ({ x: b.x, y: b.y })),
      sh: s.shots.map((sh) => ({ x: sh.x, y: sh.y })),
      sd: s.sd, tm: s.t, ov: s.over,
    };
  }
  if (!snapCur) return null;
  const cur = snapCur.s;
  const prev = snapPrev?.s ?? cur;
  const span = Math.max(1 / 60, (snapCur.at - (snapPrev?.at ?? snapCur.at - 1 / 30)));
  const a = Math.min(1.25, (nowSec - snapCur.at) / span);
  const lerp = (p: number, c: number) => p + (c - p) * a;
  const prevBombs = new Map<number, SnapBomb>();
  for (const b of prev.bo) prevBombs.set(b.i, b);
  return {
    pl: cur.pl.map((p, i) => {
      const pp = prev.pl[i] ?? p;
      return { x: lerp(pp.x, p.x), y: lerp(pp.y, p.y), h: p.h, c: p.c, ax: p.ax, ay: p.ay, inv: p.iv > 0, cd: p.cd };
    }),
    bo: cur.bo.map((b) => {
      const pb = prevBombs.get(b.i) ?? b;
      return { x: lerp(pb.x, b.x), y: lerp(pb.y, b.y), st: b.st, p: b.p, f: b.f };
    }),
    bl: cur.bl.map(([x, y]) => ({ x, y })),
    sh: cur.sh.map(([x, y], i) => {
      const ps = prev.sh[i];
      return ps ? { x: lerp(ps[0], x), y: lerp(ps[1], y) } : { x, y };
    }),
    sd: cur.sd, tm: cur.tm, ov: cur.ov,
  };
}

function activeGrid(): number[] {
  if (mySlot === 0 && sim) return sim.grid;
  return guestGrid;
}

function playerName(slot: number): string {
  if (sim?.practice && slot === 1) return BOT_NAME;
  const p = lobby?.players.find((q) => q.slot === slot);
  return p?.name ?? (slot === mySlot ? (net?.name() || 'You') : '???');
}

function draw(nowSec: number) {
  const cx = ctx;
  if (!cx) return;
  const { cw, ch } = fit();
  cx.fillStyle = '#0b0e14';
  cx.fillRect(0, 0, cw, ch);
  if (screen === 'lobby') { drawLobby(cx, cw, ch, nowSec); return; }
  drawGame(cx, cw, ch, nowSec);
}

// --- lobby screen ---
let startBtnRect: [number, number, number, number] | null = null;

function drawLobby(cx: CanvasRenderingContext2D, cw: number, ch: number, nowSec: number) {
  const midX = cw / 2;
  cx.textAlign = 'center';
  cx.textBaseline = 'middle';
  // danger-tape header stripe
  cx.save();
  cx.fillStyle = '#181206';
  cx.fillRect(0, 0, cw, 8);
  cx.fillRect(0, ch - 8, cw, 8);
  cx.restore();

  const wob = Math.sin(nowSec * 3) * 3;
  cx.font = '900 44px system-ui, sans-serif';
  cx.fillStyle = '#ffd24f';
  cx.fillText('🧨 TNT EXPLOSION RALLY 💥', midX, ch * 0.16 + wob);
  cx.font = 'italic 15px system-ui, sans-serif';
  cx.fillStyle = '#9aa4b5';
  cx.fillText('a 1v1 maze duel — concept by a six-year-old game director', midX, ch * 0.16 + 38 + wob);

  // how to play
  const lines = [
    '🏃  WASD / arrows — run the maze',
    '🧨  click (or SPACE) — lob a bomb at your enemy… it arcs right over walls',
    '💥  BOOM! explosions sometimes drop wooden blocks',
    '🪵  walk over wood to grab it',
    '🏏  right-click (or E) — throw wood at a bomb to SMACK it back at them!',
    '❤️  5 hearts each — hit zero and you lose',
  ];
  cx.font = '16px system-ui, sans-serif';
  cx.textAlign = 'left';
  const lx = midX - 260;
  let ly = ch * 0.32;
  for (const line of lines) {
    cx.fillStyle = '#d7dce6';
    cx.fillText(line, lx, ly);
    ly += 30;
  }
  cx.textAlign = 'center';

  // who's here
  const players = lobby?.players ?? [];
  cx.font = '700 18px system-ui, sans-serif';
  let py = ch * 0.32 + lines.length * 30 + 26;
  for (let i = 0; i < 2; i++) {
    const p = players.find((q) => q.slot === i);
    cx.fillStyle = p ? P_COLORS[i] : '#3a4150';
    const label = p ? `${i === 0 ? '🟠' : '🔵'} ${p.name}${p.slot === mySlot ? ' (you)' : ''}` : '· · · waiting for a challenger · · ·';
    cx.fillText(label, midX, py);
    py += 28;
  }

  // start button (host only)
  startBtnRect = null;
  if (mySlot === 0) {
    const solo = players.length < 2;
    const bw = 340, bh = 54;
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
    cx.fillText(solo ? '🤖 PRACTICE VS THE TNT BOT' : '💥 START THE DUEL!', midX, by + bh / 2);
    if (solo) {
      cx.font = '13px system-ui, sans-serif';
      cx.fillStyle = '#8a93a5';
      cx.fillText('(practice pays no coins — beat a human for the bounty)', midX, by + bh + 20);
    }
  } else if (mySlot > 0) {
    cx.font = '700 18px system-ui, sans-serif';
    cx.fillStyle = Math.sin(nowSec * 4) > 0 ? '#ffd24f' : '#b8912f';
    cx.fillText('waiting for the host to light the fuse…', midX, py + 40);
  } else {
    cx.font = '700 18px system-ui, sans-serif';
    cx.fillStyle = '#8a93a5';
    cx.fillText('joining…', midX, py + 40);
  }

  cx.font = '13px system-ui, sans-serif';
  cx.fillStyle = '#5a6375';
  cx.fillText('ESC to leave', midX, ch - 28);

  drawFloatersScreen(cx);
}

function lobbyClick(mx: number, my: number) {
  if (startBtnRect && mySlot === 0) {
    const [bx, by, bw, bh] = startBtnRect;
    if (mx >= bx && mx <= bx + bw && my >= by && my <= by + bh) net?.start();
  }
}

// --- game screen ---
function drawGame(cx: CanvasRenderingContext2D, cw: number, ch: number, nowSec: number) {
  const view = buildView(nowSec);
  const grid = activeGrid();
  const HUD_H = 64;
  const scale = Math.min(cw / (W + 24), (ch - HUD_H - 16) / (H + 24));
  vScale = scale;
  vOx = (cw - W * scale) / 2;
  vOy = HUD_H + (ch - HUD_H - H * scale) / 2;

  if (!view || grid.length !== COLS * ROWS) {
    cx.textAlign = 'center';
    cx.font = '700 20px system-ui, sans-serif';
    cx.fillStyle = '#8a93a5';
    cx.fillText('lighting fuses…', cw / 2, ch / 2);
    return;
  }

  const shX = (Math.random() - 0.5) * shakeMag;
  const shY = (Math.random() - 0.5) * shakeMag;

  cx.save();
  cx.translate(vOx + shX * scale, vOy + shY * scale);
  cx.scale(scale, scale);

  drawArena(cx, grid, view, nowSec);
  drawWorldFloaters(cx);

  cx.restore();

  drawHud(cx, cw, view, nowSec);

  // sudden death countdown / banner
  cx.textAlign = 'center';
  if (!view.sd && view.ov === null) {
    const left = SD_AT - view.tm;
    if (left <= 10 && left > 0) {
      cx.font = '900 22px system-ui, sans-serif';
      cx.fillStyle = Math.sin(nowSec * 6) > 0 ? '#ff5b3f' : '#ffd24f';
      cx.fillText(`🌋 SUDDEN DEATH IN ${Math.ceil(left)}`, cw / 2, HUD_H + 24);
    }
  } else if (view.sd && view.ov === null) {
    cx.font = '900 18px system-ui, sans-serif';
    cx.fillStyle = '#ff5b3f';
    cx.fillText('🌋 SUDDEN DEATH — THE SKY IS THROWING BOMBS 🌋', cw / 2, HUD_H + 24);
  }

  if (view.ov !== null) drawGameOver(cx, cw, ch, view.ov);
}

function drawArena(cx: CanvasRenderingContext2D, grid: number[], view: View, nowSec: number) {
  // floor
  for (let ty = 0; ty < ROWS; ty++) {
    for (let tx = 0; tx < COLS; tx++) {
      const v = grid[ty * COLS + tx];
      const x = tx * TILE, y = ty * TILE;
      if (v === 1) {
        // stone
        cx.fillStyle = '#2b3242';
        cx.fillRect(x, y, TILE, TILE);
        cx.fillStyle = '#39415466';
        cx.fillRect(x + 2, y + 2, TILE - 4, 6);
        cx.fillStyle = '#1e2430';
        cx.fillRect(x, y + TILE - 5, TILE, 5);
      } else if (v === 2) {
        // wooden crate
        cx.fillStyle = '#14181f';
        cx.fillRect(x, y, TILE, TILE);
        cx.fillStyle = '#8a5a2b';
        cx.fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
        cx.strokeStyle = '#6a4420';
        cx.lineWidth = 2;
        cx.strokeRect(x + 5, y + 5, TILE - 10, TILE - 10);
        cx.beginPath();
        cx.moveTo(x + 5, y + 5); cx.lineTo(x + TILE - 5, y + TILE - 5);
        cx.moveTo(x + TILE - 5, y + 5); cx.lineTo(x + 5, y + TILE - 5);
        cx.stroke();
      } else {
        cx.fillStyle = (tx + ty) % 2 ? '#171c26' : '#141922';
        cx.fillRect(x, y, TILE, TILE);
      }
    }
  }

  // wooden block pickups (gently bobbing so kids can spot them)
  for (const b of view.bl) {
    const bob = Math.sin(nowSec * 3 + b.x * 0.05) * 3;
    cx.save();
    cx.translate(b.x, b.y + bob);
    cx.shadowColor = '#e8c07a';
    cx.shadowBlur = 10;
    cx.fillStyle = '#b07a3a';
    cx.fillRect(-11, -11, 22, 22);
    cx.shadowBlur = 0;
    cx.strokeStyle = '#7a5224';
    cx.lineWidth = 2;
    cx.strokeRect(-11, -11, 22, 22);
    cx.beginPath();
    cx.moveTo(-11, -3); cx.lineTo(11, -3);
    cx.moveTo(-11, 5); cx.lineTo(11, 5);
    cx.stroke();
    cx.restore();
  }

  // thrown wood: spinning planks
  for (let i = 0; i < view.sh.length; i++) {
    const sh = view.sh[i];
    cx.save();
    cx.translate(sh.x, sh.y);
    cx.rotate(nowSec * 14 + i);
    cx.fillStyle = '#c08a4a';
    cx.fillRect(-12, -6, 24, 12);
    cx.strokeStyle = '#7a5224';
    cx.lineWidth = 2;
    cx.strokeRect(-12, -6, 24, 12);
    cx.restore();
  }

  // aim preview for MY throw (a dotted lob arc — helps small hands aim)
  const me = view.pl[mySlot === 0 ? 0 : 1];
  if (me && view.ov === null && me.h > 0) {
    const land = findLanding(grid, me.x, me.y, aimX, aimY);
    cx.strokeStyle = '#ffffff2e';
    cx.setLineDash([4, 8]);
    cx.lineWidth = 2;
    cx.beginPath();
    for (let f = 0; f <= 1.001; f += 1 / 14) {
      const x = me.x + (land.x - me.x) * f;
      const y = me.y + (land.y - me.y) * f - Math.sin(Math.PI * f) * TILE * 0.9;
      if (f === 0) cx.moveTo(x, y); else cx.lineTo(x, y);
    }
    cx.stroke();
    cx.setLineDash([]);
    cx.strokeStyle = '#ffffff44';
    cx.beginPath();
    cx.arc(land.x, land.y, 10 + Math.sin(nowSec * 5) * 2, 0, Math.PI * 2);
    cx.stroke();
  }

  // bombs
  for (const b of view.bo) {
    let bx = b.x, by = b.y, h = 0, shadowR = 9;
    if (b.st === 0) {
      h = Math.sin(Math.PI * Math.min(1, b.p)) * TILE * 0.9;
    } else if (b.st === 2) {
      h = (1 - Math.min(1, b.p)) * 420;
      shadowR = 6 + Math.min(1, b.p) * 8;
    }
    // shadow on the ground tells you where it lands
    cx.fillStyle = '#00000066';
    cx.beginPath();
    cx.ellipse(bx, by, shadowR, shadowR * 0.5, 0, 0, Math.PI * 2);
    cx.fill();
    drawBomb(cx, bx, by - h, b, nowSec);
  }

  // players
  for (let i = 0; i < view.pl.length; i++) {
    drawPlayer(cx, view.pl[i], i, nowSec);
  }

  // particles live in world space
  for (const p of particles) {
    if (p.shape === 'confetti') continue; // confetti is screen-space, drawn in HUD pass
    cx.save();
    cx.globalAlpha = Math.max(0, p.life / p.max);
    cx.fillStyle = p.color;
    if (p.shape === 'wood') {
      cx.translate(p.x, p.y);
      cx.rotate(p.rot);
      cx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
    } else {
      cx.beginPath();
      cx.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2);
      cx.fill();
    }
    cx.restore();
  }
}

function drawBomb(cx: CanvasRenderingContext2D, x: number, y: number, b: { st: number; f: number }, nowSec: number) {
  cx.save();
  cx.translate(x, y);
  let blink = false;
  if (b.st === 1) {
    const urgency = Math.max(0, 1 - b.f / FUSE);
    blink = Math.sin(nowSec * (8 + urgency * 26)) > 0;
    cx.scale(1 + urgency * 0.12 * (blink ? 1 : 0), 1 + urgency * 0.12 * (blink ? 1 : 0));
  }
  if (bombSkin === 'fetch') {
    // a perfectly innocent tennis ball
    cx.fillStyle = blink ? '#ffffff' : '#c8f04f';
    cx.beginPath();
    cx.arc(0, 0, 13, 0, Math.PI * 2);
    cx.fill();
    cx.strokeStyle = '#ffffff';
    cx.lineWidth = 2;
    cx.beginPath();
    cx.arc(-10, 0, 14, -0.6, 0.6);
    cx.arc(10, 0, 14, Math.PI - 0.6, Math.PI + 0.6);
    cx.stroke();
  } else if (bombSkin === 'yarn') {
    cx.fillStyle = blink ? '#ffffff' : '#ff9ad5';
    cx.beginPath();
    cx.arc(0, 0, 13, 0, Math.PI * 2);
    cx.fill();
    cx.strokeStyle = '#e06bb0';
    cx.lineWidth = 2;
    for (let i = -1; i <= 1; i++) {
      cx.beginPath();
      cx.arc(i * 5, 0, 12, 0.4, Math.PI - 0.4);
      cx.stroke();
    }
  } else {
    // a proper little dynamite bundle — it IS called TNT Explosion Rally
    cx.rotate(-0.12);
    for (const dx of [-8, 0, 8]) {
      cx.fillStyle = blink ? '#ff8f7a' : '#c0392b';
      cx.beginPath();
      cx.roundRect(dx - 4.5, -14, 9, 28, 4);
      cx.fill();
      cx.fillStyle = '#f6e7c1';
      cx.fillRect(dx - 4.5, -3, 9, 6);
    }
    // fuse + spark
    cx.strokeStyle = '#d8c9a0';
    cx.lineWidth = 2;
    cx.beginPath();
    cx.moveTo(0, -14);
    cx.quadraticCurveTo(6, -22, 12, -19);
    cx.stroke();
    if (b.st === 1) {
      cx.fillStyle = blink ? '#fff3c4' : '#ffd24f';
      cx.beginPath();
      cx.arc(12, -19, 3.5 + Math.random() * 2, 0, Math.PI * 2);
      cx.fill();
    }
  }
  cx.restore();
}

function drawPlayer(cx: CanvasRenderingContext2D, p: ViewPlayer, slot: number, nowSec: number) {
  if (p.h <= 0) {
    // a polite little ghost
    cx.save();
    cx.globalAlpha = 0.6;
    cx.font = '28px system-ui, sans-serif';
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.fillText('👻', p.x, p.y + Math.sin(nowSec * 2) * 4);
    cx.restore();
    return;
  }
  if (p.inv && Math.sin(nowSec * 24) > 0.2) return; // mercy blink
  cx.save();
  cx.translate(p.x, p.y);
  // feet
  const bob = Math.sin(nowSec * 12) * 2;
  cx.fillStyle = '#12151c';
  cx.beginPath();
  cx.ellipse(-7, PR - 2 + bob * 0.4, 6, 4, 0, 0, Math.PI * 2);
  cx.ellipse(7, PR - 2 - bob * 0.4, 6, 4, 0, 0, Math.PI * 2);
  cx.fill();
  // body
  cx.fillStyle = P_COLORS[slot] ?? '#ccc';
  cx.strokeStyle = '#00000055';
  cx.lineWidth = 3;
  cx.beginPath();
  cx.arc(0, 0, PR, 0, Math.PI * 2);
  cx.fill();
  cx.stroke();
  // eyes toward the aim
  let ex = p.ax - p.x, ey = p.ay - p.y;
  const em = Math.hypot(ex, ey) || 1;
  ex = (ex / em) * 4; ey = (ey / em) * 4;
  for (const side of [-6, 6]) {
    cx.fillStyle = '#fff';
    cx.beginPath();
    cx.arc(side + ex * 0.4, -4 + ey * 0.4, 5.5, 0, Math.PI * 2);
    cx.fill();
    cx.fillStyle = '#1a1d24';
    cx.beginPath();
    cx.arc(side + ex, -4 + ey, 2.6, 0, Math.PI * 2);
    cx.fill();
  }
  // held wood floats overhead — everyone can see who's armed
  if (p.c > 0) {
    const hov = Math.sin(nowSec * 4) * 2;
    cx.fillStyle = '#b07a3a';
    cx.strokeStyle = '#7a5224';
    cx.lineWidth = 2;
    cx.fillRect(-9, -PR - 22 + hov, 18, 12);
    cx.strokeRect(-9, -PR - 22 + hov, 18, 12);
  }
  cx.restore();
}

function drawWorldFloaters(cx: CanvasRenderingContext2D) {
  cx.textAlign = 'center';
  cx.textBaseline = 'middle';
  for (const f of floaters) {
    cx.save();
    cx.globalAlpha = Math.max(0, Math.min(1, f.life / (f.max * 0.5)));
    cx.font = `900 ${f.size}px system-ui, sans-serif`;
    cx.lineWidth = 4;
    cx.strokeStyle = '#000000aa';
    cx.strokeText(f.text, f.x, f.y);
    cx.fillStyle = f.color;
    cx.fillText(f.text, f.x, f.y);
    cx.restore();
  }
}

function drawFloatersScreen(cx: CanvasRenderingContext2D) {
  // (lobby toasts reuse world-space floaters roughly centered — good enough for a toast)
  drawWorldFloaters(cx);
}

function drawHeart(cx: CanvasRenderingContext2D, x: number, y: number, s: number, full: boolean) {
  cx.save();
  cx.translate(x, y);
  cx.scale(s / 16, s / 16);
  cx.beginPath();
  cx.moveTo(0, 5);
  cx.bezierCurveTo(-9, -4, -6, -12, 0, -6);
  cx.bezierCurveTo(6, -12, 9, -4, 0, 5);
  cx.closePath();
  cx.fillStyle = full ? '#ff4d5e' : '#2a2f3c';
  cx.fill();
  cx.strokeStyle = full ? '#ff8a94' : '#3a4150';
  cx.lineWidth = 1.5;
  cx.stroke();
  cx.restore();
}

function drawHud(cx: CanvasRenderingContext2D, cw: number, view: View, nowSec: number) {
  cx.save();
  cx.fillStyle = '#10141c';
  cx.fillRect(0, 0, cw, 56);
  cx.fillStyle = '#232a38';
  cx.fillRect(0, 56, cw, 2);

  for (let i = 0; i < 2; i++) {
    const p = view.pl[i];
    if (!p) continue;
    const rightSide = i === 1;
    const baseX = rightSide ? cw - 24 : 24;
    const dir = rightSide ? -1 : 1;
    cx.textAlign = rightSide ? 'right' : 'left';
    cx.textBaseline = 'alphabetic';
    cx.font = '900 15px system-ui, sans-serif';
    cx.fillStyle = P_COLORS[i];
    cx.fillText(playerName(i) + (i === mySlot ? ' (you)' : ''), baseX, 22);
    for (let hIdx = 0; hIdx < HEARTS; hIdx++) {
      drawHeart(cx, baseX + dir * (10 + hIdx * 22), 38, 18, hIdx < p.h);
    }
    // bomb ready dial
    const dialX = baseX + dir * (10 + HEARTS * 22 + 24);
    cx.strokeStyle = '#3a4150';
    cx.lineWidth = 3;
    cx.beginPath();
    cx.arc(dialX, 36, 9, 0, Math.PI * 2);
    cx.stroke();
    cx.strokeStyle = p.cd >= 1 ? '#ffd24f' : '#8a6a1a';
    cx.beginPath();
    cx.arc(dialX, 36, 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p.cd);
    cx.stroke();
    // holding wood?
    if (p.c > 0) {
      cx.fillStyle = '#b07a3a';
      cx.fillRect(dialX + dir * 18 - 7, 29, 14, 14);
      cx.strokeStyle = '#7a5224';
      cx.lineWidth = 2;
      cx.strokeRect(dialX + dir * 18 - 7, 29, 14, 14);
    }
  }

  // clock
  cx.textAlign = 'center';
  cx.font = '700 16px system-ui, sans-serif';
  cx.fillStyle = view.sd ? '#ff5b3f' : '#8a93a5';
  const t = Math.floor(view.tm);
  cx.fillText(`${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`, cw / 2, 34);

  // confetti (screen space)
  for (const p of particles) {
    if (p.shape !== 'confetti') continue;
    cx.save();
    cx.globalAlpha = Math.max(0, p.life / p.max);
    cx.translate((p.x / W) * cw, p.y);
    cx.rotate(p.rot);
    cx.fillStyle = p.color;
    cx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
    cx.restore();
  }
  cx.restore();
  void nowSec;
}

function drawGameOver(cx: CanvasRenderingContext2D, cw: number, ch: number, ov: number) {
  cx.save();
  cx.fillStyle = '#000000a8';
  cx.fillRect(0, 0, cw, ch);
  cx.textAlign = 'center';
  cx.textBaseline = 'middle';
  let big: string, color: string;
  if (ov === -2) { big = '💥 DOUBLE KO!! 💥'; color = '#ffd24f'; }
  else if (ov === mySlot) { big = '🏆 YOU WIN! 🏆'; color = '#7dff9a'; }
  else { big = '💀 YOU LOSE 💀'; color = '#ff6b6b'; }
  cx.font = '900 56px system-ui, sans-serif';
  cx.lineWidth = 8;
  cx.strokeStyle = '#000';
  cx.strokeText(big, cw / 2, ch * 0.42);
  cx.fillStyle = color;
  cx.fillText(big, cw / 2, ch * 0.42);
  if (overNote) {
    cx.font = '700 20px system-ui, sans-serif';
    cx.fillStyle = '#d7dce6';
    cx.fillText(overNote, cw / 2, ch * 0.42 + 54);
  }
  cx.font = '700 18px system-ui, sans-serif';
  cx.fillStyle = '#9aa4b5';
  cx.fillText('click for the lobby — rally again!', cw / 2, ch * 0.42 + (overNote ? 94 : 60));
  cx.restore();
}
