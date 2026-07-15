// 🎱 Club Billiards — played at the game table in the Tsong Country Club's game room, alongside
// chess and Nine Men's Morris. Two ways to play: solo "practice vs. the House" (a simple local AI,
// never touches the server) or 2-player PvP over the same `bg` relay shape as chess/morris/ski
// (game key 'billiards').
//
// Pool physics are chaotic (many-body collisions), so unlike chess's "both clients derive the same
// verdict from the same move" model, only ONE client ever runs the physics for a given shot — same
// authority split as ski.ts (host simulates, guest just plays back what it's sent). Concretely: the
// HOST (slot 0) is the sole physics authority. When it's the guest's turn, the guest sends its aim
// over the relay as a request; the host simulates it and relays back the full result (a recorded,
// subsampled ball-position path plus the final resting state), which BOTH clients then animate and
// resolve identically (see resolveShot — a pure function of the shared facts, same spirit as chess
// deriving checkmate locally). In solo mode there's no relay at all: the single client is always
// the physics authority for both the human's shots and the bot's.
//
// Rules: classic 8-ball. Fifteen object balls (1–7 solid, 9–15 stripe) plus the black 8. The table
// is "open" until the first legal, non-break shot pots a ball — whichever group that ball belongs
// to is assigned to its shooter, the other group to the opponent. Pot a ball from your own group
// and you keep shooting; miss, foul, or pot the opponent's ball and the turn passes. Once your
// group is completely cleared, potting the 8 legally wins; potting it early, or scratching while
// potting it, is an instant loss.

import type { BgNet } from './chess';

export interface Ball { id: number; x: number; y: number; vx: number; vy: number; potted: boolean }
type Group = 'solid' | 'stripe' | 'eight' | 'cue';
type Assign = 'open' | 'solid' | 'stripe';
interface LobbyView { status: 'waiting' | 'playing' | 'ended'; slot: number; players: { name: string; slot: number }[]; stake: number }
interface ShotResult {
  path: Record<number, { x: number; y: number }[]>;
  final: Ball[];
  potted: number[]; // ids newly potted this shot (0 = the cue ball, i.e. a scratch)
  cueScratched: boolean;
  firstContact: number | null; // id of the first ball the cue ball touches this shot, or null if it touches nothing
}

// --- table geometry (table-space units; scaled to the canvas at render time) ---
const TW = 1000, TH = 500;          // playable felt, rail to rail — sized for a full 15-ball rack
const BALL_R = 13;
const HEAD = { x: TW * 0.22, y: TH / 2 };  // cue ball's start / re-spot point
const FOOT = { x: TW * 0.78, y: TH / 2 };  // rack apex
const POCKETS: { x: number; y: number; r: number }[] = [
  { x: 0, y: 0, r: 32 }, { x: TW / 2, y: 0, r: 28 }, { x: TW, y: 0, r: 32 },
  { x: 0, y: TH, r: 32 }, { x: TW / 2, y: TH, r: 28 }, { x: TW, y: TH, r: 32 },
];
// Standard pool coloring: 1–7 solids, 9–15 the same seven hues striped, 8 black.
const BALL_HUE: Record<number, string> = {
  1: '#e0c62a', 2: '#3a6fd8', 3: '#c0392b', 4: '#8a3ad8', 5: '#e08a2a', 6: '#3a9a4a', 7: '#7a2e22', 8: '#161616',
};
function hueOf(id: number): string { return BALL_HUE[id === 8 ? 8 : id <= 7 ? id : id - 8] ?? '#fff'; }
function groupOf(id: number): Group {
  if (id === 0) return 'cue';
  if (id === 8) return 'eight';
  return id <= 7 ? 'solid' : 'stripe';
}

// Standard triangle rack, apex toward the cue ball: row 0 (1 ball, nearest the break) … row 4 (5
// balls, the base). The 8 sits dead center (row 2); the back corners split solid/stripe.
const RACK_ROWS: number[][] = [
  [1],
  [9, 2],
  [10, 8, 3],
  [11, 4, 12, 5],
  [13, 7, 14, 15, 6],
];

// --- physics --- tuned toward "arcade-forgiving": generous pocket mouths, rails that don't stay
// lively for long, so a miss dies down near a pocket instead of caroming around the whole table.
const FRICTION = 420;      // units/s² deceleration — tuned so a full-power shot can cross the whole table, corner to corner, with a rail bounce to spare
const RESTITUTION = 0.72;  // rail bounce energy retention
const STOP_EPS = 6;        // units/s below which a ball is treated as at rest
const SIM_DT = 1 / 240;
const MAX_STEPS = 240 * 8; // 8s hard ceiling per shot
const SNAP_EVERY = 6;      // record a path point roughly every 40Hz
const MIN_SPEED = 170, MAX_SPEED = 1250;
const MAX_DRAG = 145;      // table units of pointer pull-back for full power

function freshBalls(): Ball[] {
  const balls: Ball[] = [{ id: 0, x: HEAD.x, y: HEAD.y, vx: 0, vy: 0, potted: false }];
  const rowDX = BALL_R * 2 * Math.cos(Math.PI / 6); // hex-packed row-to-row spacing
  const rowDY = BALL_R * 2;
  for (let r = 0; r < RACK_ROWS.length; r++) {
    const row = RACK_ROWS[r];
    const x = FOOT.x + r * rowDX;
    for (let c = 0; c < row.length; c++) {
      const y = FOOT.y + (c - (row.length - 1) / 2) * rowDY;
      balls.push({ id: row[c], x, y, vx: 0, vy: 0, potted: false });
    }
  }
  return balls;
}

function cloneBalls(bs: Ball[]): Ball[] { return bs.map((b) => ({ ...b })); }

/** Runs a full shot to rest, purely, on a copy of `startBalls`. Deterministic given (angle, power). */
function simulateShot(startBalls: Ball[], angle: number, power01: number): ShotResult {
  const balls = cloneBalls(startBalls);
  const cue = balls.find((b) => b.id === 0);
  const speed = MIN_SPEED + Math.max(0, Math.min(1, power01)) * (MAX_SPEED - MIN_SPEED);
  if (cue) { cue.vx = Math.cos(angle) * speed; cue.vy = Math.sin(angle) * speed; }
  const wasPotted = new Set(startBalls.filter((b) => b.potted).map((b) => b.id));
  const path: Record<number, { x: number; y: number }[]> = {};
  for (const b of balls) path[b.id] = [{ x: b.x, y: b.y }];
  let firstContact: number | null = null;
  let step = 0;
  for (; step < MAX_STEPS; step++) {
    let moving = false;
    for (const b of balls) {
      if (b.potted) continue;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > STOP_EPS) {
        moving = true;
        b.x += b.vx * SIM_DT; b.y += b.vy * SIM_DT;
        const nsp = Math.max(0, sp - FRICTION * SIM_DT);
        const k = nsp / sp; b.vx *= k; b.vy *= k;
      } else { b.vx = 0; b.vy = 0; }
    }
    for (const b of balls) { // pocket capture
      if (b.potted) continue;
      for (const p of POCKETS) {
        if (Math.hypot(b.x - p.x, b.y - p.y) < p.r) { b.potted = true; b.vx = 0; b.vy = 0; break; }
      }
    }
    for (const b of balls) { // rail bounce
      if (b.potted) continue;
      if (b.x < BALL_R) { b.x = BALL_R; b.vx = -b.vx * RESTITUTION; }
      else if (b.x > TW - BALL_R) { b.x = TW - BALL_R; b.vx = -b.vx * RESTITUTION; }
      if (b.y < BALL_R) { b.y = BALL_R; b.vy = -b.vy * RESTITUTION; }
      else if (b.y > TH - BALL_R) { b.y = TH - BALL_R; b.vy = -b.vy * RESTITUTION; }
    }
    for (let i = 0; i < balls.length; i++) { // ball-ball collisions (equal mass, elastic)
      const a = balls[i]; if (a.potted) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const c = balls[j]; if (c.potted) continue;
        const dx = c.x - a.x, dy = c.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0 && dist < BALL_R * 2) {
          if (firstContact === null) {
            if (a.id === 0) firstContact = c.id;
            else if (c.id === 0) firstContact = a.id;
          }
          const nx = dx / dist, ny = dy / dist;
          const overlap = BALL_R * 2 - dist;
          a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
          c.x += nx * overlap / 2; c.y += ny * overlap / 2;
          const rel = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
          if (rel < 0) { a.vx += nx * rel; a.vy += ny * rel; c.vx -= nx * rel; c.vy -= ny * rel; }
        }
      }
    }
    if (step % SNAP_EVERY === 0) for (const b of balls) path[b.id].push({ x: b.x, y: b.y });
    if (!moving) break;
  }
  for (const b of balls) path[b.id].push({ x: b.x, y: b.y });
  for (const b of balls) { // drop paths for balls that never actually moved — keeps the relay payload small
    const p = path[b.id];
    if (!p.some((pt) => Math.hypot(pt.x - p[0].x, pt.y - p[0].y) > 1)) delete path[b.id];
  }
  const potted = balls.filter((b) => b.potted && !wasPotted.has(b.id)).map((b) => b.id);
  return { path, final: balls, potted, cueScratched: potted.includes(0), firstContact };
}

/** Places the cue ball at the head spot (or the nearest clear space around it) — used at rack
 *  start and after every scratch. A ring search rather than a single line: with up to 15 balls
 *  still on the table, a straight line out from the head spot can plausibly stay blocked. */
function respotCue(balls: Ball[]): void {
  const cue = balls.find((b) => b.id === 0);
  if (!cue) return;
  const clampX = (v: number) => Math.max(BALL_R, Math.min(TW - BALL_R, v));
  const clampY = (v: number) => Math.max(BALL_R, Math.min(TH - BALL_R, v));
  const clash = (x: number, y: number) => balls.some((b) => b.id !== 0 && !b.potted && Math.hypot(b.x - x, b.y - y) < BALL_R * 2.1);
  const place = (x: number, y: number) => { cue.x = x; cue.y = y; cue.vx = 0; cue.vy = 0; cue.potted = false; };
  if (!clash(HEAD.x, HEAD.y)) { place(HEAD.x, HEAD.y); return; }
  const step = BALL_R * 2.2;
  for (let ring = 1; ring <= 6; ring++) {
    for (let a = 0; a < 8; a++) {
      const ang = (Math.PI / 4) * a;
      const x = clampX(HEAD.x + Math.cos(ang) * step * ring), y = clampY(HEAD.y + Math.sin(ang) * step * ring);
      if (!clash(x, y)) { place(x, y); return; }
    }
  }
  place(HEAD.x, HEAD.y); // give up (essentially impossible with 16 balls on a table this size) — just place it
}

// --- bot AI: a simple "ghost ball" aimer with imperfect execution ---
function chooseBotShot(balls: Ball[], myGroup: Assign): { angle: number; power: number } {
  const cue = balls.find((b) => b.id === 0);
  let targets: Ball[];
  if (myGroup === 'open') targets = balls.filter((b) => !b.potted && b.id !== 0 && b.id !== 8);
  else {
    const mine = balls.filter((b) => !b.potted && groupOf(b.id) === myGroup);
    targets = mine.length ? mine : balls.filter((b) => !b.potted && b.id === 8);
  }
  let best: { angle: number; power: number; score: number } | null = null;
  if (cue) {
    for (const t of targets) {
      for (const p of POCKETS) {
        const tp = Math.hypot(p.x - t.x, p.y - t.y);
        if (tp < 1) continue;
        const ux = (p.x - t.x) / tp, uy = (p.y - t.y) / tp;
        const ghost = { x: t.x - ux * BALL_R * 2, y: t.y - uy * BALL_R * 2 };
        const cg = Math.hypot(ghost.x - cue.x, ghost.y - cue.y);
        if (cg < 1) continue;
        const cx = (ghost.x - cue.x) / cg, cy = (ghost.y - cue.y) / cg;
        const cut = cx * ux + cy * uy; // 1 = straight in, <0 = geometrically impossible
        if (cut < 0.28) continue;
        const score = cut * 2 - (cg + tp) / 600;
        if (!best || score > best.score) {
          best = { angle: Math.atan2(ghost.y - cue.y, ghost.x - cue.x), power: Math.max(0.32, Math.min(0.95, (cg + tp) / 700)), score };
        }
      }
    }
  }
  const skillJitter = (Math.random() - 0.5) * 0.09; // the House is good, not perfect
  if (best) return { angle: best.angle + skillJitter, power: Math.max(0.15, Math.min(1, best.power + (Math.random() - 0.5) * 0.12)) };
  return { angle: Math.random() * Math.PI * 2, power: 0.5 }; // nothing on: a safe-ish poke
}

// --- audio ---
let ac: AudioContext | null = null;
function tone(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number) {
  if (net?.muted()) return;
  try {
    ac = ac || new AudioContext();
    const t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + dur + 0.02);
  } catch { /* ignore */ }
}
const sndClick = () => tone(180, 0.05, 'square', 0.06);
const sndPot = () => { tone(660, 0.08, 'sine', 0.06, 990); tone(880, 0.1, 'sine', 0.04, 1320); };
const sndScratch = () => tone(140, 0.3, 'sawtooth', 0.05, 70);
const sndEnd = () => { tone(392, 0.35, 'sine', 0.06); setTimeout(() => tone(494, 0.35, 'sine', 0.05), 130); setTimeout(() => tone(587, 0.55, 'sine', 0.05), 260); };

// --- module state ---
let open = false;
let net: BgNet | null = null;
let root: HTMLDivElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let screen: 'mode' | 'lobby' | 'game' = 'mode';
let vsBot = false;
let joined = false;   // whether we've actually taken a `bg` seat (PvP only)
let lobby: LobbyView = { status: 'waiting', slot: 0, players: [], stake: 0 };
let mySlot = 0;
let gameN = 0;         // rematch counter — who breaks alternates
let balls: Ball[] = [];
let playerGroup: [Assign, Assign] = ['open', 'open'];
let shotCount = 0;     // shots taken this rack — 0 means the next shot is the break
let turnSlot = 0;
let busy = false;      // a shot is animating / awaiting a relayed result — input locked
let over: { text: string; sub: string } | null = null;
let rematchMine = false, rematchTheirs = false;
let raf = 0;
let animPaths: Record<number, { x: number; y: number }[]> | null = null;
let animT = 0;
let animDoneCb: (() => void) | null = null;
let aiming = false;
let aimAngle = 0, aimPower = 0;
let ballInHand = false;  // true from a foul until the receiving player finalizes a cue-ball placement
let placingCue = false;  // true while a pointer is actively dragging the cue ball into place
let viewScale = 1, viewOffX = 0, viewOffY = 0;
let lastPointer = { x: 0, y: 0 };
let botShotTimer = 0;

export function isBilliardsOpen() { return open; }

export function openBilliards(n: BgNet) {
  if (open) return;
  open = true;
  net = n;
  joined = false; vsBot = false;
  screen = 'mode';
  lobby = { status: 'waiting', slot: 0, players: [], stake: 0 };
  over = null; gameN = 0; balls = []; playerGroup = ['open', 'open']; busy = false;
  rematchMine = false; rematchTheirs = false; ballInHand = false; placingCue = false;
  root = document.createElement('div');
  root.id = 'billiardsOverlay';
  root.style.cssText =
    'position:fixed;inset:0;z-index:20000;display:flex;align-items:center;justify-content:center;' +
    'background:radial-gradient(ellipse at 50% 30%, #1c1712 0%, #0a0806 70%);' +
    'font-family:Georgia,"Times New Roman",serif;color:#e8dcc0;';
  document.body.appendChild(root);
  renderModeSelect();
}

function shut() {
  open = false;
  cancelAnimationFrame(raf);
  if (botShotTimer) { window.clearTimeout(botShotTimer); botShotTimer = 0; }
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  root?.remove(); root = null; canvas = null; ctx = null;
  const n = net; net = null;
  if (joined) n?.leave();
}

function isHost() { return mySlot === 0; }
function nameOf(slot: number): string {
  if (vsBot) return slot === 0 ? (net?.name() || 'You') : 'The House';
  return lobby.players.find((p) => p.slot === slot)?.name ?? (slot === mySlot ? (net?.name() || 'You') : '…');
}
function remainingOf(g: Assign): number {
  if (g === 'open') return 7;
  return balls.filter((b) => !b.potted && groupOf(b.id) === g).length;
}

// --- lifecycle ---

function startRack() {
  balls = freshBalls();
  playerGroup = ['open', 'open'];
  shotCount = 0;
  over = null; busy = false; aiming = false; ballInHand = false; placingCue = false;
  rematchMine = false; rematchTheirs = false;
  turnSlot = gameN % 2 === 0 ? 0 : 1; // breaker alternates on a rematch
  renderGame();
  maybeBotTurn();
}

function startBotGame() {
  vsBot = true; mySlot = 0; joined = false;
  gameN = 0;
  screen = 'game';
  startRack();
}

export function feedLobby(msg: LobbyView) {
  if (!open || vsBot) return;
  const was = lobby.status;
  lobby = msg;
  mySlot = msg.slot;
  if (msg.status === 'ended') {
    if (screen === 'game' && !over) { over = { text: 'The table empties.', sub: 'Your opponent has left the room.' }; sndEnd(); renderGame(); }
    else shut();
    return;
  }
  if (msg.status === 'playing' && was !== 'playing') {
    if (screen === 'game') gameN++; // a rematch — colors/break alternate
    screen = 'game';
    startRack();
    return;
  }
  if (screen === 'lobby') renderLobby();
  else if (screen === 'game') renderGame();
}

export function feedRelay(data: unknown) {
  if (!open || vsBot) return;
  const d = data as { k?: string; angle?: number; power?: number; potted?: number[]; cueScratched?: boolean; path?: unknown; final?: Ball[]; firstContact?: number | null; x?: number; y?: number; re?: boolean };
  if (!d || typeof d !== 'object') return;
  if (d.k === 'aim' && isHost() && typeof d.angle === 'number' && typeof d.power === 'number') {
    // A guest's turn — only the host actually runs physics.
    if (over || busy || turnSlot !== 1) return;
    runShotAsAuthority(d.angle, d.power);
    return;
  }
  if (d.k === 'result' && !isHost() && d.final && d.potted) {
    applyResult({ path: (d.path as Record<number, { x: number; y: number }[]>) ?? {}, final: d.final, potted: d.potted, cueScratched: !!d.cueScratched, firstContact: d.firstContact ?? null });
    return;
  }
  if (d.k === 'place' && typeof d.x === 'number' && typeof d.y === 'number') {
    // The opponent finalized a ball-in-hand placement — mirror the cue ball locally.
    const cue = balls.find((b) => b.id === 0);
    if (cue) { cue.x = d.x; cue.y = d.y; cue.potted = false; }
    ballInHand = false;
    renderGame();
    return;
  }
  if (d.k === 're?') {
    rematchTheirs = true;
    if (rematchMine && mySlot === 0) net?.start();
    renderGame();
    return;
  }
}

// --- shot orchestration ---

/** My input, from the UI. In PvP, only the host runs physics locally — a guest's turn asks the host. */
function attemptShot(angle: number, power: number) {
  if (busy || over) return;
  if (turnSlot !== mySlot && !vsBot) return;
  busy = true;
  sndClick();
  if (vsBot || isHost()) { runShotAsAuthority(angle, power); return; }
  net?.relay({ k: 'aim', angle, power });
}

/** Runs on whichever client is authoritative for this shot (host in PvP, sole client in bot mode). */
function runShotAsAuthority(angle: number, power: number) {
  const result = simulateShot(balls, angle, power);
  if (!vsBot) net?.relay({ k: 'result', potted: result.potted, cueScratched: result.cueScratched, final: result.final, path: result.path, firstContact: result.firstContact });
  applyResult(result);
}

/** Plays back the shot (both the client that computed it and the one that received it), then
 *  resolves scoring/turn order from the shared facts — the same "derive the same verdict locally"
 *  pattern chess uses for check/checkmate, just fed by a relayed physics outcome instead of a move. */
function applyResult(result: ShotResult) {
  busy = true;
  const shooter = turnSlot;
  const wasBreak = shotCount === 0;
  const groupWasClear = playerGroup[shooter] !== 'open' && remainingOf(playerGroup[shooter]) === 0;
  shotCount++;
  playPath(result.path, () => {
    balls = result.final;
    if (result.cueScratched) sndScratch();
    else if (result.potted.length) sndPot();
    resolveShot(shooter, result.potted, result.cueScratched, wasBreak, result.firstContact, groupWasClear);
  });
}

function resolveShot(shooter: number, potted: number[], cueScratched: boolean, wasBreak: boolean, firstContact: number | null, groupWasClear: boolean) {
  const potNonEight = potted.filter((id) => id !== 0 && id !== 8);
  const potEight = potted.includes(8);
  const preGroup = playerGroup[shooter]; // group status entering this shot — needed below, before assignment can change it

  // Group assignment: the first legal, non-break shot that pots a ball decides it — whichever
  // group that ball belongs to goes to its shooter, the other group to the opponent.
  if (preGroup === 'open' && !wasBreak && potNonEight.length > 0) {
    const g = groupOf(potNonEight[0]) as 'solid' | 'stripe';
    playerGroup[shooter] = g;
    playerGroup[1 - shooter] = g === 'solid' ? 'stripe' : 'solid';
  }

  if (potEight) {
    const legal = playerGroup[shooter] !== 'open' && remainingOf(playerGroup[shooter]) === 0 && !cueScratched;
    finish(legal ? shooter : 1 - shooter,
      legal ? `${nameOf(shooter)} pots the 8-ball. Game.` : `${nameOf(shooter)} pots the 8-ball ${cueScratched ? 'on a scratch' : 'early'}.`,
      legal ? 'The house nods, once.' : 'House rules: that\'s a loss, member or not.');
    return;
  }

  // Fouls: potting the cue ball, the cue ball touching nothing at all, or (once groups are
  // assigned) the cue ball's first contact being the opponent's group instead of your own.
  const noContactFoul = !wasBreak && firstContact === null;
  const wrongGroupFoul = !wasBreak && preGroup !== 'open' && firstContact !== null
    && groupOf(firstContact) !== preGroup
    && !(groupOf(firstContact) === 'eight' && groupWasClear);
  const foul = cueScratched || noContactFoul || wrongGroupFoul;

  const ownGroupPotted = playerGroup[shooter] !== 'open' && potNonEight.some((id) => groupOf(id) === playerGroup[shooter]);
  if (foul) {
    turnSlot = 1 - shooter;
    if (cueScratched) respotCue(balls); // cue ball needs *some* on-table spot before it can be dragged into place
    ballInHand = true;
  }
  else if (wasBreak) { turnSlot = potNonEight.length > 0 ? shooter : 1 - shooter; }
  else if (ownGroupPotted) { turnSlot = shooter; } // keep shooting
  else { turnSlot = 1 - shooter; }

  busy = false;
  renderGame();
  maybeBotTurn();
}

function finish(winnerSlot: number, text: string, sub: string) {
  over = { text, sub };
  busy = false;
  sndEnd();
  if (!vsBot) net?.result(winnerSlot);
  renderGame();
}

function maybeBotTurn() {
  if (!vsBot || over || turnSlot !== 1) return;
  if (ballInHand) { respotCue(balls); ballInHand = false; renderGame(); } // the House just places it back and plays on
  botShotTimer = window.setTimeout(() => {
    botShotTimer = 0;
    if (!open || over || turnSlot !== 1) return;
    const shot = chooseBotShot(balls, playerGroup[1]);
    attemptShot(shot.angle, shot.power);
  }, 900 + Math.random() * 700);
}

// --- shot animation playback ---

function playPath(path: Record<number, { x: number; y: number }[]>, onDone: () => void) {
  cancelAnimationFrame(raf);
  const ids = Object.keys(path).map(Number);
  if (!ids.length) { onDone(); return; }
  const frames = Math.max(...ids.map((id) => path[id].length));
  if (frames <= 1) { onDone(); return; }
  animPaths = path; animT = 0; animDoneCb = onDone;
  const fps = 40, total = (frames - 1) / fps;
  const start = performance.now();
  const step = () => {
    if (!animPaths) return;
    animT = Math.min(1, (performance.now() - start) / 1000 / total);
    // live ball positions for rendering: interpolate along the recorded path
    for (const idStr of Object.keys(animPaths)) {
      const id = Number(idStr);
      const b = balls.find((x) => x.id === id);
      const p = animPaths[id];
      if (!b || !p.length) continue;
      const f = animT * (p.length - 1);
      const i0 = Math.floor(f), i1 = Math.min(p.length - 1, i0 + 1), t = f - i0;
      b.x = p[i0].x + (p[i1].x - p[i0].x) * t;
      b.y = p[i0].y + (p[i1].y - p[i0].y) * t;
    }
    renderGame();
    if (animT < 1) { raf = requestAnimationFrame(step); return; }
    animPaths = null;
    const cb = animDoneCb; animDoneCb = null;
    cb?.();
  };
  raf = requestAnimationFrame(step);
}

// --- input ---

function tableFromClient(clientX: number, clientY: number): { x: number; y: number } {
  return { x: (clientX - viewOffX) / viewScale, y: (clientY - viewOffY) / viewScale };
}

/** Ball-in-hand placement is only legal on the felt, clear of every other ball, and clear of the
 *  pocket mouths — same spirit as respotCue's clash test, but for an arbitrary drag target. */
function validCuePlacement(x: number, y: number): boolean {
  if (x < BALL_R || x > TW - BALL_R || y < BALL_R || y > TH - BALL_R) return false;
  for (const b of balls) { if (b.id !== 0 && !b.potted && Math.hypot(b.x - x, b.y - y) < BALL_R * 2) return false; }
  for (const p of POCKETS) { if (Math.hypot(p.x - x, p.y - y) < p.r + BALL_R * 0.5) return false; }
  return true;
}

function onPointerDown(e: PointerEvent) {
  if (busy || over || screen !== 'game') return;
  if (turnSlot !== mySlot) return;
  const cue = balls.find((b) => b.id === 0);
  if (!cue) return;
  const p = tableFromClient(e.clientX, e.clientY);
  if (ballInHand) {
    placingCue = true;
    if (validCuePlacement(p.x, p.y)) { cue.x = p.x; cue.y = p.y; }
    lastPointer = p;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    renderGame();
    return;
  }
  if (Math.hypot(p.x - cue.x, p.y - cue.y) > BALL_R * 6) return; // click near the cue ball to address it
  aiming = true;
  lastPointer = p;
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  renderGame();
}
function onPointerMove(e: PointerEvent) {
  if (placingCue) {
    lastPointer = tableFromClient(e.clientX, e.clientY);
    const cue = balls.find((b) => b.id === 0);
    if (cue && validCuePlacement(lastPointer.x, lastPointer.y)) { cue.x = lastPointer.x; cue.y = lastPointer.y; }
    renderGame();
    return;
  }
  if (!aiming) return;
  lastPointer = tableFromClient(e.clientX, e.clientY);
  const cue = balls.find((b) => b.id === 0);
  if (cue) {
    const dx = lastPointer.x - cue.x, dy = lastPointer.y - cue.y;
    const len = Math.min(MAX_DRAG, Math.hypot(dx, dy));
    aimPower = len / MAX_DRAG;
    aimAngle = Math.atan2(-dy, -dx); // pull back, shoot forward
  }
  renderGame();
}
function onPointerUp() {
  if (placingCue) {
    placingCue = false;
    ballInHand = false;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    const cue = balls.find((b) => b.id === 0);
    if (cue && !vsBot) net?.relay({ k: 'place', x: cue.x, y: cue.y });
    renderGame();
    return;
  }
  if (!aiming) return;
  aiming = false;
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  if (aimPower > 0.06) attemptShot(aimAngle, aimPower);
  else renderGame();
}

// --- rendering: mode select ---

const BTN = 'cursor:pointer;background:#1c2b21;color:#e8dcc0;border:1px solid #3a6b4a;border-radius:8px;' +
  'padding:9px 16px;font-size:14px;font-family:inherit;';
const BTN_DIM = BTN + 'opacity:0.45;cursor:default;';

function renderModeSelect() {
  if (!root) return;
  root.replaceChildren();
  const panel = document.createElement('div');
  panel.style.cssText = 'text-align:center;background:#1c130d33;border:1px solid #4a3320;border-radius:16px;padding:36px 48px;box-shadow:0 20px 60px #000a;max-width:420px;';
  panel.innerHTML = '<div style="font-size:30px;letter-spacing:3px;color:#e8c86a;margin-bottom:4px;">🎱 THE 19TH HOLE TABLE</div>' +
    '<div style="font-style:italic;color:#c8a878;font-size:13px;margin-bottom:26px;">Fifteen balls, one black 8, and a felt older than most members.</div>';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-direction:column;gap:12px;';
  const bot = document.createElement('button');
  bot.textContent = '🤖 Practice vs. the House';
  bot.style.cssText = BTN + 'padding:12px 16px;';
  bot.onclick = () => startBotGame();
  const pvp = document.createElement('button');
  pvp.textContent = '🎱 Challenge a Member (2-player PvP)';
  pvp.style.cssText = BTN + 'padding:12px 16px;';
  pvp.onclick = () => { screen = 'lobby'; joined = true; net?.join(); renderLobby(); };
  const leave = document.createElement('button');
  leave.textContent = 'Never mind';
  leave.style.cssText = BTN + 'opacity:0.7;';
  leave.onclick = () => shut();
  row.append(bot, pvp, leave);
  panel.appendChild(row);
  root.appendChild(panel);
}

function renderLobby() {
  if (!root) return;
  root.replaceChildren();
  const panel = document.createElement('div');
  panel.style.cssText = 'text-align:center;background:#1c130d33;border:1px solid #4a3320;border-radius:16px;padding:36px 48px;box-shadow:0 20px 60px #000a;';
  panel.innerHTML = '<div style="font-size:28px;letter-spacing:3px;color:#e8c86a;margin-bottom:4px;">🎱 THE TABLE</div>' +
    '<div style="font-style:italic;color:#c8a878;font-size:13px;margin-bottom:24px;">Clear your group, then the 8-ball.</div>';
  const seats = document.createElement('div');
  seats.style.cssText = 'display:flex;gap:18px;justify-content:center;margin-bottom:24px;';
  for (const slot of [0, 1]) {
    const p = lobby.players.find((x) => x.slot === slot);
    const seat = document.createElement('div');
    seat.style.cssText = `width:170px;padding:16px 10px;border-radius:12px;border:1px solid ${p ? '#3a6b4a' : '#3a2c1c'};background:${p ? '#1a2e1c' : '#160f0a'};`;
    seat.innerHTML = p
      ? `<div style="font-size:26px">🎱</div><div style="margin-top:6px;font-size:15px">${p.name}</div><div style="font-size:11px;color:#9ab8a0">${slot === 0 ? 'breaks first' : 'shoots second'}</div>`
      : '<div style="font-size:26px;color:#4a3826">·</div><div style="margin-top:6px;font-size:13px;color:#6a5238">an open cue</div>';
    seats.appendChild(seat);
  }
  panel.appendChild(seats);
  const wager = document.createElement('div');
  wager.style.cssText = 'margin-bottom:18px;';
  const wl = document.createElement('div');
  wl.textContent = lobby.stake > 0 ? `Stake: ${lobby.stake.toLocaleString()}\u{1FA99} each — winner takes all` : 'A friendly game (no stake)';
  wl.style.cssText = `font-size:13px;color:${lobby.stake > 0 ? '#e8c86a' : '#9ab8a0'};margin-bottom:8px;`;
  wager.appendChild(wl);
  if (mySlot === 0) {
    const row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;gap:6px;justify-content:center;flex-wrap:wrap;';
    for (const [label, amt] of [['Friendly', 0], ['1k', 1000], ['10k', 10000], ['100k', 100000], ['1M', 1000000]] as [string, number][]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = BTN + `padding:5px 10px;font-size:12px;${lobby.stake === amt ? 'border-color:#c8a84a;color:#e8c86a;' : ''}`;
      b.onclick = () => net?.stake(amt);
      row2.appendChild(b);
    }
    wager.appendChild(row2);
  } else if (lobby.stake > 0) {
    const note = document.createElement('div');
    note.textContent = 'Sitting at this table when the game begins is agreeing to the stake.';
    note.style.cssText = 'font-size:11px;font-style:italic;color:#9ab8a0;';
    wager.appendChild(note);
  }
  panel.appendChild(wager);
  const status = document.createElement('div');
  status.textContent = lobby.players.length < 2 ? 'Waiting for a second member to pick up a cue…' : (mySlot === 0 ? 'Both cues taken. Break whenever.' : 'Both cues taken. Your host will break shortly.');
  status.style.cssText = 'font-size:13px;color:#b8d0be;margin-bottom:20px;';
  panel.appendChild(status);
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:12px;justify-content:center;';
  if (mySlot === 0) {
    const start = document.createElement('button');
    start.textContent = 'Break';
    start.style.cssText = lobby.players.length >= 2 ? BTN : BTN_DIM;
    start.disabled = lobby.players.length < 2;
    start.onclick = () => net?.start();
    row.appendChild(start);
  }
  const leave = document.createElement('button');
  leave.textContent = 'Leave the table';
  leave.style.cssText = BTN;
  leave.onclick = () => shut();
  row.appendChild(leave);
  panel.appendChild(row);
  root.appendChild(panel);
}

// --- rendering: the table itself ---

function ensureCanvas() {
  if (canvas || !root) return;
  root.replaceChildren();
  canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;cursor:crosshair;touch-action:none;';
  canvas.addEventListener('pointerdown', onPointerDown);
  root.appendChild(canvas);
  ctx = canvas.getContext('2d');
  const hud = document.createElement('div');
  hud.id = 'billiardsHud';
  hud.style.cssText = 'position:absolute;top:10px;left:0;right:0;text-align:center;pointer-events:none;';
  root.appendChild(hud);
  const leave = document.createElement('button');
  leave.textContent = 'Leave the table';
  leave.style.cssText = BTN + 'position:absolute;top:12px;right:12px;font-size:12px;';
  leave.onclick = () => shut();
  root.appendChild(leave);
}

function ballDot(c: CanvasRenderingContext2D, sx: number, sy: number, r: number, id: number) {
  const stripe = id >= 9 && id <= 15;
  const hue = hueOf(id);
  c.save();
  c.beginPath(); c.arc(sx, sy, r, 0, Math.PI * 2); c.clip();
  c.fillStyle = stripe ? '#f8f4ea' : (id === 0 ? '#f8f4ea' : hue);
  c.fillRect(sx - r, sy - r, r * 2, r * 2);
  if (stripe) { c.fillStyle = hue; c.fillRect(sx - r, sy - r * 0.46, r * 2, r * 0.92); }
  c.restore();
  c.beginPath(); c.arc(sx, sy, r, 0, Math.PI * 2);
  c.strokeStyle = id === 8 ? '#c8a84a' : '#00000055'; c.lineWidth = id === 8 ? Math.max(1, r * 0.14) : 1; c.stroke();
  c.beginPath(); c.arc(sx - r * 0.32, sy - r * 0.32, r * 0.28, 0, Math.PI * 2);
  c.fillStyle = '#ffffff55'; c.fill();
  if (id >= 1 && id <= 15) {
    const label = String(id), small = label.length > 1;
    c.fillStyle = '#ffffffe0'; c.beginPath(); c.arc(sx, sy, r * 0.44, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#101010'; c.font = `bold ${Math.round(r * (small ? 0.46 : 0.58))}px ui-monospace,monospace`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(label, sx, sy + 0.5);
  }
}

function renderGame() {
  ensureCanvas();
  if (!canvas || !ctx || !root) return;
  const W = canvas.width = root.clientWidth, H = canvas.height = root.clientHeight;
  const pad = 60;
  viewScale = Math.min((W - pad * 2) / TW, (H - pad * 2 - 70) / TH);
  viewOffX = (W - TW * viewScale) / 2;
  viewOffY = (H - TH * viewScale) / 2 + 30;
  const toX = (x: number) => viewOffX + x * viewScale, toY = (y: number) => viewOffY + y * viewScale;
  const c = ctx;
  c.fillStyle = '#0a0806'; c.fillRect(0, 0, W, H);
  // rail
  const railW = 24 * viewScale;
  c.fillStyle = '#3a2410';
  c.fillRect(toX(0) - railW, toY(0) - railW, TW * viewScale + railW * 2, TH * viewScale + railW * 2);
  c.strokeStyle = '#5a3820'; c.lineWidth = 2; c.strokeRect(toX(0) - railW, toY(0) - railW, TW * viewScale + railW * 2, TH * viewScale + railW * 2);
  // felt
  c.fillStyle = '#1f6b3a';
  c.fillRect(toX(0), toY(0), TW * viewScale, TH * viewScale);
  c.fillStyle = '#ffffff08';
  for (let i = 0; i < 5; i++) c.fillRect(toX(0), toY(0) + (TH * viewScale * i) / 5, TW * viewScale, (TH * viewScale) / 10);
  // pockets
  for (const p of POCKETS) { c.beginPath(); c.arc(toX(p.x), toY(p.y), p.r * viewScale, 0, Math.PI * 2); c.fillStyle = '#0a0806'; c.fill(); }
  // ball-in-hand: a dashed halo around the cue ball while it's mine to place
  if (ballInHand && turnSlot === mySlot) {
    const cue = balls.find((b) => b.id === 0);
    if (cue) {
      c.setLineDash([5, 5]);
      c.strokeStyle = placingCue && !validCuePlacement(cue.x, cue.y) ? '#e05a4a' : '#e8c86a';
      c.lineWidth = 2;
      c.beginPath(); c.arc(toX(cue.x), toY(cue.y), BALL_R * viewScale * 1.8, 0, Math.PI * 2); c.stroke();
      c.setLineDash([]);
    }
  }
  // aim line + stick, while charging
  if (aiming) {
    const cue = balls.find((b) => b.id === 0);
    if (cue) {
      const sx = toX(cue.x), sy = toY(cue.y);
      const dx = Math.cos(aimAngle), dy = Math.sin(aimAngle);
      c.setLineDash([6, 6]); c.strokeStyle = `#ffe9a0${Math.round(80 + aimPower * 150).toString(16).padStart(2, '0')}`;
      c.lineWidth = 2; c.beginPath(); c.moveTo(sx, sy); c.lineTo(sx + dx * 300 * viewScale, sy + dy * 300 * viewScale); c.stroke();
      c.setLineDash([]);
      const pull = 16 + aimPower * 60;
      c.strokeStyle = '#c8a878'; c.lineWidth = 4 * viewScale;
      c.beginPath(); c.moveTo(sx - dx * pull * viewScale, sy - dy * pull * viewScale); c.lineTo(sx - dx * (pull + 140) * viewScale, sy - dy * (pull + 140) * viewScale); c.stroke();
    }
  }
  // balls
  for (const b of balls) {
    if (b.potted) continue;
    ballDot(c, toX(b.x), toY(b.y), BALL_R * viewScale, b.id);
  }
  // potted tray, top-left — two rows of up to 8, every object ball sunk so far
  const tray = balls.filter((b) => b.potted && b.id !== 0);
  tray.forEach((b, i) => ballDot(c, toX(24 + (i % 8) * 30), toY(-46 + Math.floor(i / 8) * 26), BALL_R * viewScale * 0.6, b.id));
  // end-of-game veil
  if (over) {
    c.fillStyle = '#0a0806cc'; c.fillRect(0, 0, W, H);
    c.textAlign = 'center';
    c.fillStyle = '#e8c86a'; c.font = '26px Georgia, serif'; c.fillText(over.text, W / 2, H / 2 - 20);
    c.fillStyle = '#b8d0be'; c.font = 'italic 14px Georgia, serif'; c.fillText(over.sub, W / 2, H / 2 + 8);
  }
  renderHud();
}

function renderHud() {
  const hud = document.getElementById('billiardsHud');
  if (!hud) return;
  const plate = (slot: number) => {
    const toMove = turnSlot === slot && !over && !busy;
    const g = playerGroup[slot];
    const groupLabel = g === 'open' ? 'open table' : g === 'solid' ? '● solids' : '◐ stripes';
    const remain = g === 'open' ? '' : ` · ${remainingOf(g)} left`;
    return `<div style="display:inline-block;margin:0 10px;padding:6px 14px;border-radius:10px;border:1px solid ${toMove ? '#c8a84a' : '#3a2c1c'};background:#160f0acc;${toMove ? 'box-shadow:0 0 10px #c8a84a44;' : ''}">` +
      `<span style="font-size:14px;color:#e8dcc0;">${nameOf(slot)}${slot === mySlot ? ' (you)' : ''}</span>` +
      `<span style="margin-left:8px;font-size:12px;color:#e8c86a;">${groupLabel}${remain}</span></div>`;
  };
  let extra = '';
  if (!over) {
    extra = busy ? '<div style="margin-top:6px;font-size:12px;color:#9ab8a0;font-style:italic;">the balls are still rolling…</div>'
      : turnSlot === mySlot
        ? (ballInHand
          ? '<div style="margin-top:6px;font-size:12px;color:#e8c86a;">Foul — ball in hand. Drag the cue ball anywhere on the felt, then address it to shoot.</div>'
          : '<div style="margin-top:6px;font-size:12px;color:#e8c86a;">Your shot — drag back from the cue ball, release to strike.</div>')
      : (ballInHand
          ? '<div style="margin-top:6px;font-size:12px;color:#9ab8a0;font-style:italic;">Foul — they have ball in hand.</div>'
          : '<div style="margin-top:6px;font-size:12px;color:#9ab8a0;font-style:italic;">Their shot.</div>');
  }
  let overRow = '';
  if (over) {
    const rematchLabel = vsBot ? 'Rack \'em again' : (rematchTheirs ? 'Rematch (they\'re waiting…)' : rematchMine ? 'Rematch offered…' : 'Offer a rematch');
    overRow = `<div style="margin-top:10px;pointer-events:auto;"><button id="bilAgain" style="${rematchMine && !vsBot ? BTN_DIM : BTN}">${rematchLabel}</button></div>`;
  }
  hud.innerHTML = `<div>${plate(0)}${plate(1)}</div>${extra}${overRow}`;
  const again = document.getElementById('bilAgain');
  if (again) {
    again.onclick = () => {
      if (vsBot) { gameN++; startRack(); return; }
      if (rematchMine || !net) return;
      rematchMine = true;
      net.relay({ k: 're?' });
      if (rematchTheirs && mySlot === 0) net.start();
      renderGame();
    };
  }
}
