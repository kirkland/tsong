// 🏒 Frostreach Hockey — 2v2 arcade hockey, played on the same slippery ice as the rest of the
// Frostreach: whatever speed you're carrying, you keep about half of it a second from now, with
// nothing pushing back (the exact `Math.pow(0.5, dt)` decay the pond's skating/loose-puck physics
// already use). Same `bg` relay shape as ski (game key 'hockey', up to 4 seats), and real-time the
// same way: slot 0 hosts and is the sole physics authority, simulating every skater + the puck and
// streaming snapshots; guests just send their stick input and render what the host sends back.
//
// There's no puck-possession state machine. Skating into the puck shoves it — in your direction,
// blended with your own momentum — exactly like the cosmetic puck already loose on the pond.
// Checking an opponent is the same collision, just skater-on-skater. Space is a short dash: it's
// both your shot power and your check. First team to 3 wins.
//
// There's also a fully local "Practice vs. Bots" mode — no relay at all, the lone client is the
// sole authority for both your skater and all three bots — so a 2v2 game is always one click away.
// Bots fall out of the same host-authority loop PvP guests do: a seat with no human behind it just
// asks a tiny heuristic for its input instead of a relay packet.

import type { BgNet } from './chess';

interface LobbyView { status: 'waiting' | 'playing' | 'ended'; slot: number; players: { name: string; slot: number }[]; stake: number }

// --- rink geometry (rink-space units; scaled to the canvas at render time) ---
const RW = 860, RH = 440;           // playable ice, board to board
const R_SK = 20, R_PK = 9;
const GOAL_W = 150;                 // goal-mouth width, centered on each short board
const TEAM_COLOR = ['#e0503a', '#3a8ee0']; // 0 = Red (slots 0/2), 1 = Blue (slots 1/3)
const TEAM_NAME = ['Red', 'Blue'];
const BOT_NAMES = ['Coach Chilly', 'Blizzard Bill', 'Ice Golem'];
const GOAL_QUIPS = [
  'the boards remember nothing.', 'the crowd (nobody) goes wild.',
  'somewhere, a Zamboni weeps with pride.', 'that one\'s going in a highlight reel nobody watches.',
  '🦭 a seal on the boards applauds, out of season and out of context.',
];

// --- physics --- tuned "arcade-forgiving": snappy accel, the same slippery decay as the pond.
const ACCEL = 1700, MAX_V = 430;
const DASH_KICK = 430, DASH_MS = 650;
const GOALS_TO_WIN = 3;
const GOAL_PAUSE_MS = 1400;

function teamOf(slot: number) { return slot % 2; }
function teamSlotsOf(slots: number[], team: number): number[] { return slots.filter((s) => teamOf(s) === team).sort((a, b) => a - b); }

interface Skater { slot: number; x: number; y: number; vx: number; vy: number; dashCd: number; faceX: number; faceY: number }
interface Puck { x: number; y: number; vx: number; vy: number }

function freshSkaters(slots: number[]): Skater[] {
  return slots.map((slot) => {
    const team = teamOf(slot);
    const laneIdx = teamSlotsOf(slots, team).indexOf(slot);
    return {
      slot, x: team === 0 ? RW * 0.28 : RW * 0.72, y: RH * (laneIdx === 0 ? 0.35 : 0.65),
      vx: 0, vy: 0, dashCd: 0, faceX: team === 0 ? 1 : -1, faceY: 0,
    };
  });
}
function freshPuck(): Puck { return { x: RW / 2, y: RH / 2, vx: 0, vy: 0 }; }

// --- audio ---
let ac: AudioContext | null = null;
function tone(f: number, d: number, t: OscillatorType, v: number, slideTo?: number) {
  if (net?.muted()) return;
  try {
    ac = ac || new AudioContext();
    const now = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
    o.type = t; o.frequency.setValueAtTime(f, now);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, now + d);
    g.gain.setValueAtTime(v, now); g.gain.exponentialRampToValueAtTime(0.001, now + d);
    o.connect(g); g.connect(ac.destination); o.start(now); o.stop(now + d + 0.02);
  } catch { /* ignore */ }
}
const sndTap = () => tone(220, 0.05, 'square', 0.05);
const sndDash = () => tone(340, 0.08, 'sawtooth', 0.05, 180);
const sndGoal = () => { tone(392, 0.4, 'sawtooth', 0.07); window.setTimeout(() => tone(392, 0.7, 'sawtooth', 0.06), 480); };
const sndEnd = () => { tone(392, 0.3, 'sine', 0.06); setTimeout(() => tone(494, 0.3, 'sine', 0.05), 130); setTimeout(() => tone(659, 0.5, 'sine', 0.05), 260); };

// --- module state ---
let open = false;
let net: BgNet | null = null;
let root: HTMLDivElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let screen: 'mode' | 'lobby' | 'game' = 'mode';
let vsBot = false;
let joined = false;
let lobby: LobbyView = { status: 'waiting', slot: 0, players: [], stake: 0 };
let mySlot = 0;
let activeSlots: number[] = [0, 1, 2, 3];
let skaters: Skater[] = [];
let puck: Puck = freshPuck();
let score = [0, 0]; // [red, blue]
let over: { text: string; sub: string; team?: number } | null = null;
let goalPauseUntil = 0;
let goalQuip = '';
let hugePuckUntil = 0; // 🥚 a small secret: press H mid-game for a few seconds of chaos
let raf = 0;
let lastT = 0;

// input
let keyUp = false, keyDown = false, keyLeft = false, keyRight = false, keySpace = false, spacePrev = false;
let dashSeq = 0;
const remoteInput = new Map<number, { ix: number; iy: number; dashSeq: number }>();
const remoteDashSeen = new Map<number, number>();

function isHost() { return mySlot === 0; }
function isBotSlot(slot: number) { return vsBot && slot !== mySlot; }
function puckRadius(): number { return Date.now() < hugePuckUntil ? R_PK * 3.2 : R_PK; }

export function isHockeyOpen() { return open; }

export function openHockey(n: BgNet) {
  if (open) return;
  open = true;
  net = n;
  joined = false; vsBot = false;
  screen = 'mode';
  lobby = { status: 'waiting', slot: 0, players: [], stake: 0 };
  over = null; hugePuckUntil = 0;
  root = document.createElement('div');
  root.id = 'hockeyOverlay';
  root.style.cssText = 'position:fixed;inset:0;z-index:20000;display:flex;align-items:center;justify-content:center;' +
    'background:linear-gradient(#0d2438,#1a3a52);font-family:Georgia,serif;color:#dceaf5;overflow:hidden;';
  document.body.appendChild(root);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  renderModeSelect();
}

function shut() {
  open = false;
  cancelAnimationFrame(raf);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('keyup', onKey);
  root?.remove(); root = null; canvas = null; ctx = null;
  const n = net; net = null;
  if (joined) n?.leave();
}

function onKey(e: KeyboardEvent) {
  const down = e.type === 'keydown';
  if (e.key === 'Escape' && down) { shut(); return; }
  if (screen !== 'game') return;
  if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') { keyUp = down; e.preventDefault(); }
  if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') { keyDown = down; e.preventDefault(); }
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { keyLeft = down; e.preventDefault(); }
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { keyRight = down; e.preventDefault(); }
  if (e.key === ' ') { keySpace = down; e.preventDefault(); }
  if ((e.key === 'h' || e.key === 'H') && down) hugePuckUntil = Date.now() + 5000; // shh
}

function nameOf(slot: number): string {
  if (vsBot) {
    if (slot === mySlot) return net?.name() || 'You';
    const botIdx = activeSlots.filter((s) => s !== mySlot).indexOf(slot);
    return BOT_NAMES[botIdx % BOT_NAMES.length];
  }
  return lobby.players.find((p) => p.slot === slot)?.name ?? (slot === mySlot ? (net?.name() || 'You') : `P${slot}`);
}

// --- physics: skaters ---

function applyInputToSkater(sk: Skater, ix: number, iy: number, dash: boolean, dt: number) {
  const len = Math.hypot(ix, iy);
  if (len > 0.01) { sk.faceX = ix / len; sk.faceY = iy / len; }
  sk.dashCd = Math.max(0, sk.dashCd - dt * 1000);
  if (dash && sk.dashCd <= 0) {
    sk.vx += sk.faceX * DASH_KICK; sk.vy += sk.faceY * DASH_KICK;
    sk.dashCd = DASH_MS;
  }
  if (len > 0.01) { sk.vx += (ix / len) * ACCEL * dt; sk.vy += (iy / len) * ACCEL * dt; }
  const keep = Math.pow(0.5, dt); // same ice friction as the rest of the Frostreach
  sk.vx *= keep; sk.vy *= keep;
  const sp = Math.hypot(sk.vx, sk.vy);
  if (sp > MAX_V) { sk.vx = (sk.vx / sp) * MAX_V; sk.vy = (sk.vy / sp) * MAX_V; }
  sk.x += sk.vx * dt; sk.y += sk.vy * dt;
  sk.x = Math.max(R_SK, Math.min(RW - R_SK, sk.x));
  sk.y = Math.max(R_SK, Math.min(RH - R_SK, sk.y));
}

function collideSkaters(a: Skater, b: Skater) {
  const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy);
  const minD = R_SK * 2;
  if (dist > 0 && dist < minD) {
    const nx = dx / dist, ny = dy / dist, overlap = minD - dist;
    a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
    b.x += nx * overlap / 2; b.y += ny * overlap / 2;
    const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (rel < 0) { a.vx += nx * rel; a.vy += ny * rel; b.vx -= nx * rel; b.vy -= ny * rel; }
  }
}

function pushPuck(sk: Skater, p: Puck) {
  const dx = p.x - sk.x, dy = p.y - sk.y, dist = Math.hypot(dx, dy);
  const minD = R_SK + puckRadius();
  if (dist > 0 && dist < minD) {
    const nx = dx / dist, ny = dy / dist, overlap = minD - dist;
    p.x += nx * overlap; p.y += ny * overlap;
    const skSpeed = Math.hypot(sk.vx, sk.vy);
    const kick = 120 + skSpeed * 1.1; // same "kick it by skating through it" feel as the pond's loose puck
    p.vx = nx * kick + sk.vx * 0.4; p.vy = ny * kick + sk.vy * 0.4;
  }
}

function stepPuck(dt: number) {
  const pr = puckRadius();
  puck.x += puck.vx * dt; puck.y += puck.vy * dt;
  const keep = Math.pow(0.5, dt);
  puck.vx *= keep; puck.vy *= keep;
  if (puck.y < pr) { puck.y = pr; puck.vy = -puck.vy * 0.8; }
  else if (puck.y > RH - pr) { puck.y = RH - pr; puck.vy = -puck.vy * 0.8; }
  const inMouth = Math.abs(puck.y - RH / 2) < GOAL_W / 2;
  if (puck.x < pr) {
    if (inMouth) { if (puck.x < -pr) scoreGoal(1); } // crossed fully behind Red's own line — Blue scores
    else { puck.x = pr; puck.vx = -puck.vx * 0.8; }
  } else if (puck.x > RW - pr) {
    if (inMouth) { if (puck.x > RW + pr) scoreGoal(0); } // crossed fully behind Blue's own line — Red scores
    else { puck.x = RW - pr; puck.vx = -puck.vx * 0.8; }
  }
}

function scoreGoal(team: number) {
  if (over || Date.now() < goalPauseUntil) return;
  score[team]++;
  sndGoal();
  if (score[team] >= GOALS_TO_WIN) { finish(team); return; }
  goalQuip = GOAL_QUIPS[Math.floor(Math.random() * GOAL_QUIPS.length)];
  puck = freshPuck();
  skaters = freshSkaters(activeSlots);
  goalPauseUntil = Date.now() + GOAL_PAUSE_MS;
}

function finish(team: number) {
  over = { text: `${TEAM_NAME[team]} wins, ${score[team]}–${score[1 - team]}! \u{1F3C6}`, sub: vsBot ? 'Rack up another.' : 'Good game.', team };
  sndEnd();
  if (!vsBot) {
    const winSlot = activeSlots.find((s) => teamOf(s) === team) ?? 0;
    net?.result(winSlot);
  }
}

// --- bot AI: chase if closest, support if a teammate's on it, fall back otherwise ---
function botInputFor(slot: number): { ix: number; iy: number; dash: boolean } {
  const me = skaters.find((s) => s.slot === slot);
  if (!me) return { ix: 0, iy: 0, dash: false };
  const team = teamOf(slot);
  const oppGoalX = team === 0 ? RW : 0;
  const ownGoalX = team === 0 ? 0 : RW;
  const goalY = RH / 2;
  const myDist = Math.hypot(puck.x - me.x, puck.y - me.y);
  let closestOwn = Infinity;
  for (const s of skaters) { if (teamOf(s.slot) !== team) continue; closestOwn = Math.min(closestOwn, Math.hypot(puck.x - s.x, puck.y - s.y)); }
  const amClosest = myDist <= closestOwn + 0.5;
  let teammateIsClosest = false;
  if (!amClosest) {
    for (const s of skaters) {
      if (s === me || teamOf(s.slot) !== team) continue;
      if (Math.hypot(puck.x - s.x, puck.y - s.y) <= closestOwn + 0.5) teammateIsClosest = true;
    }
  }
  let tx: number, ty: number;
  if (amClosest) {
    tx = puck.x + Math.sign(oppGoalX - puck.x) * 22;
    ty = puck.y;
  } else if (teammateIsClosest) {
    const lane = teamSlotsOf(activeSlots, team).indexOf(slot);
    tx = (oppGoalX + puck.x) / 2;
    ty = goalY + (lane === 0 ? -60 : 60);
  } else {
    const t = 0.45;
    tx = ownGoalX + (puck.x - ownGoalX) * t;
    ty = puck.y * t + goalY * (1 - t);
  }
  tx = Math.max(R_SK, Math.min(RW - R_SK, tx));
  ty = Math.max(R_SK, Math.min(RH - R_SK, ty));
  const dx = tx - me.x, dy = ty - me.y, d = Math.hypot(dx, dy);
  const ix = d > 4 ? dx / d : 0, iy = d > 4 ? dy / d : 0;
  const dash = amClosest && myDist < 90 && me.dashCd <= 0 && Math.random() < 0.06;
  return { ix, iy, dash };
}

// --- orchestration ---

function stepHost(dt: number, myDashEdge: boolean) {
  if (over) return;
  if (Date.now() < goalPauseUntil) return;
  for (const sk of skaters) {
    let ix = 0, iy = 0, dash = false;
    if (sk.slot === mySlot) {
      ix = (keyRight ? 1 : 0) - (keyLeft ? 1 : 0); iy = (keyDown ? 1 : 0) - (keyUp ? 1 : 0);
      dash = myDashEdge;
    } else if (isBotSlot(sk.slot)) {
      const b = botInputFor(sk.slot);
      ix = b.ix; iy = b.iy; dash = b.dash;
    } else {
      const r = remoteInput.get(sk.slot);
      ix = r?.ix ?? 0; iy = r?.iy ?? 0;
      const seen = remoteDashSeen.get(sk.slot) ?? 0;
      if (r && r.dashSeq !== seen) { dash = true; remoteDashSeen.set(sk.slot, r.dashSeq); }
    }
    applyInputToSkater(sk, ix, iy, dash, dt);
  }
  for (let i = 0; i < skaters.length; i++) for (let j = i + 1; j < skaters.length; j++) collideSkaters(skaters[i], skaters[j]);
  for (const sk of skaters) pushPuck(sk, puck);
  stepPuck(dt);
}

let wasTouching = false;
function maybeTouchSound() {
  const me = skaters.find((s) => s.slot === mySlot);
  if (!me) return;
  const touching = Math.hypot(puck.x - me.x, puck.y - me.y) < R_SK + puckRadius() + 3;
  if (touching && !wasTouching) sndTap();
  wasTouching = touching;
}

function loop(t: number) {
  if (!open || screen !== 'game') return;
  const dt = Math.min(0.05, (t - lastT) / 1000); lastT = t;
  const dashEdge = keySpace && !spacePrev;
  if (dashEdge) { dashSeq++; sndDash(); }
  spacePrev = keySpace;
  if (isHost()) {
    stepHost(dt, dashEdge);
    if (!vsBot) net?.relay({ k: 'snap', skaters, puck, score, over, pauseUntil: goalPauseUntil });
  } else {
    const ix = (keyRight ? 1 : 0) - (keyLeft ? 1 : 0), iy = (keyDown ? 1 : 0) - (keyUp ? 1 : 0);
    net?.relay({ k: 'in', slot: mySlot, ix, iy, dashSeq });
  }
  maybeTouchSound();
  renderGame();
  raf = requestAnimationFrame(loop);
}

function resetInputState() {
  keyUp = keyDown = keyLeft = keyRight = keySpace = spacePrev = false;
  dashSeq = 0; wasTouching = false;
  remoteInput.clear(); remoteDashSeen.clear();
}

function startBotGame() {
  vsBot = true; mySlot = 0; joined = false;
  activeSlots = [0, 1, 2, 3];
  skaters = freshSkaters(activeSlots);
  puck = freshPuck();
  score = [0, 0]; over = null; goalPauseUntil = 0; hugePuckUntil = 0;
  resetInputState();
  screen = 'game';
  lastT = performance.now();
  renderGame();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(loop);
}

function startMatch() {
  activeSlots = lobby.players.map((p) => p.slot).sort((a, b) => a - b);
  skaters = freshSkaters(activeSlots);
  puck = freshPuck();
  score = [0, 0]; over = null; goalPauseUntil = 0; hugePuckUntil = 0;
  resetInputState();
  screen = 'game';
  lastT = performance.now();
  renderGame();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(loop);
}

export function feedLobby(msg: LobbyView) {
  if (!open || vsBot) return;
  const was = lobby.status;
  lobby = msg;
  mySlot = msg.slot;
  if (msg.status === 'ended') {
    if (screen === 'game' && !over) { over = { text: 'The rink empties.', sub: 'A player left mid-match.' }; sndEnd(); renderGame(); }
    else shut();
    return;
  }
  if (msg.status === 'playing' && was !== 'playing') { startMatch(); return; }
  if (screen === 'lobby') renderLobby();
  else if (screen === 'game') renderGame();
}

export function feedRelay(data: unknown) {
  if (!open || vsBot) return;
  const d = data as {
    k?: string; slot?: number; ix?: number; iy?: number; dashSeq?: number;
    skaters?: Skater[]; puck?: Puck; score?: number[]; over?: { text: string; sub: string; team?: number } | null; pauseUntil?: number;
  };
  if (!d || typeof d !== 'object') return;
  if (d.k === 'in' && isHost() && typeof d.slot === 'number') {
    remoteInput.set(d.slot, { ix: d.ix ?? 0, iy: d.iy ?? 0, dashSeq: d.dashSeq ?? 0 });
    return;
  }
  if (d.k === 'snap' && !isHost() && d.skaters && d.puck) {
    skaters = d.skaters; puck = d.puck;
    if (d.score) { if (d.score[0] > score[0] || d.score[1] > score[1]) sndGoal(); score = d.score; }
    if (typeof d.pauseUntil === 'number') goalPauseUntil = d.pauseUntil;
    if (d.over !== undefined) { if (d.over && !over) sndEnd(); over = d.over; }
    if (screen !== 'game') screen = 'game';
    renderGame();
    return;
  }
}

// --- rendering: mode select / lobby ---

const BTN = 'cursor:pointer;background:#153a54;color:#dceaf5;border:1px solid #3a7ea8;border-radius:8px;padding:9px 16px;font-size:14px;font-family:inherit;';
const BTN_DIM = BTN + 'opacity:0.45;cursor:default;';

function renderModeSelect() {
  if (!root) return;
  root.replaceChildren();
  const panel = document.createElement('div');
  panel.style.cssText = 'text-align:center;background:#0f2942cc;border:1px solid #3a6a8a;border-radius:16px;padding:36px 48px;box-shadow:0 20px 60px #000a;max-width:440px;';
  panel.innerHTML = '<div style="font-size:30px;letter-spacing:3px;color:#9fd8ff;margin-bottom:4px;">🏒 THE FROSTREACH RINK</div>' +
    '<div style="font-style:italic;color:#a8c8dc;font-size:13px;margin-bottom:26px;">2v2. Arrows/WASD to skate, Space to dash — check, shove, and slam it home. First to 3.</div>';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-direction:column;gap:12px;';
  const bot = document.createElement('button');
  bot.textContent = '🤖 Practice (2v2 vs. Bots)';
  bot.style.cssText = BTN + 'padding:12px 16px;';
  bot.onclick = () => startBotGame();
  const pvp = document.createElement('button');
  pvp.textContent = '🥅 Challenge others (2v2 PvP)';
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
  panel.style.cssText = 'text-align:center;background:#0f2942cc;border:1px solid #3a6a8a;border-radius:16px;padding:34px 46px;box-shadow:0 20px 60px #000a;';
  panel.innerHTML = '<div style="font-size:28px;letter-spacing:3px;color:#9fd8ff;margin-bottom:4px;">🏒 THE FROSTREACH RINK</div>' +
    '<div style="font-style:italic;color:#a8c8dc;font-size:13px;margin-bottom:22px;">Seats alternate Red / Blue as skaters sit down. A friendly game — no stake.</div>';
  const seats = document.createElement('div');
  seats.style.cssText = 'display:flex;gap:12px;justify-content:center;margin-bottom:22px;flex-wrap:wrap;';
  for (let slot = 0; slot < 4; slot++) {
    const p = lobby.players.find((x) => x.slot === slot);
    const team = teamOf(slot);
    const seat = document.createElement('div');
    seat.style.cssText = `width:120px;padding:14px 8px;border-radius:12px;border:1px solid ${p ? TEAM_COLOR[team] : '#2a4a5e'};background:${p ? '#123047' : '#0d2436'};`;
    seat.innerHTML = p
      ? `<div style="font-size:22px;color:${TEAM_COLOR[team]}">🏒</div><div style="margin-top:5px;font-size:14px">${p.name}</div><div style="font-size:11px;color:${TEAM_COLOR[team]}">${TEAM_NAME[team]}</div>`
      : '<div style="font-size:22px;color:#2a4a5e">·</div><div style="margin-top:5px;font-size:12px;color:#5a7e94">open</div>';
    seats.appendChild(seat);
  }
  panel.appendChild(seats);
  const status = document.createElement('div');
  status.textContent = lobby.players.length < 2 ? 'Waiting for at least one more skater…' : (mySlot === 0 ? 'Ready whenever you are.' : 'Waiting for the host to drop the puck…');
  status.style.cssText = 'font-size:13px;color:#a8c8dc;margin-bottom:20px;';
  panel.appendChild(status);
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:12px;justify-content:center;';
  if (mySlot === 0) {
    const start = document.createElement('button');
    start.textContent = 'Drop the puck';
    start.style.cssText = lobby.players.length >= 2 ? BTN : BTN_DIM;
    start.disabled = lobby.players.length < 2;
    start.onclick = () => net?.start();
    row.appendChild(start);
  }
  const leave = document.createElement('button');
  leave.textContent = 'Leave the rink';
  leave.style.cssText = BTN;
  leave.onclick = () => shut();
  row.appendChild(leave);
  panel.appendChild(row);
  root.appendChild(panel);
}

// --- rendering: the rink itself ---

function ensureCanvas() {
  if (canvas || !root) return;
  root.replaceChildren();
  canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
  root.appendChild(canvas);
  ctx = canvas.getContext('2d');
  const hud = document.createElement('div');
  hud.id = 'hockeyHud';
  hud.style.cssText = 'position:absolute;top:10px;left:0;right:0;text-align:center;pointer-events:none;font-family:ui-monospace,monospace;';
  root.appendChild(hud);
  const leave = document.createElement('button');
  leave.textContent = 'Leave the rink';
  leave.style.cssText = BTN + 'position:absolute;top:12px;right:12px;font-size:12px;pointer-events:auto;';
  leave.onclick = () => shut();
  root.appendChild(leave);
}

function renderGame() {
  ensureCanvas();
  if (!canvas || !ctx || !root) return;
  const W = canvas.width = root.clientWidth, H = canvas.height = root.clientHeight;
  const pad = 60;
  const scale = Math.min((W - pad * 2) / RW, (H - pad * 2 - 60) / RH);
  const offX = (W - RW * scale) / 2, offY = (H - RH * scale) / 2 + 26;
  const toX = (x: number) => offX + x * scale, toY = (y: number) => offY + y * scale;
  const c = ctx;
  c.fillStyle = '#0a1f30'; c.fillRect(0, 0, W, H);
  // boards
  const bw = 14 * scale;
  c.fillStyle = '#183a52';
  c.fillRect(toX(0) - bw, toY(0) - bw, RW * scale + bw * 2, RH * scale + bw * 2);
  // ice
  c.fillStyle = '#dff2fb';
  c.fillRect(toX(0), toY(0), RW * scale, RH * scale);
  c.fillStyle = '#ffffff40';
  for (let i = 0; i < 4; i++) c.fillRect(toX(0), toY(0) + (RH * scale * i) / 8, RW * scale, (RH * scale) / 16);
  // center line + circle
  c.strokeStyle = '#d0405a'; c.lineWidth = 3;
  c.beginPath(); c.moveTo(toX(RW / 2), toY(0)); c.lineTo(toX(RW / 2), toY(RH)); c.stroke();
  c.strokeStyle = '#3a6ad0';
  c.beginPath(); c.arc(toX(RW / 2), toY(RH / 2), 55 * scale, 0, Math.PI * 2); c.stroke();
  // goal lines + nets
  for (const team of [0, 1]) {
    const gx = team === 0 ? 0 : RW;
    const dir = team === 0 ? -1 : 1;
    const netDepth = 22 * scale;
    c.fillStyle = '#0a1f30cc';
    c.fillRect(toX(gx) + (dir < 0 ? -netDepth : 0), toY(RH / 2 - GOAL_W / 2), netDepth, GOAL_W * scale);
    c.strokeStyle = TEAM_COLOR[team]; c.lineWidth = 2;
    c.strokeRect(toX(gx) + (dir < 0 ? -netDepth : 0), toY(RH / 2 - GOAL_W / 2), netDepth, GOAL_W * scale);
    c.lineWidth = 3;
    c.beginPath(); c.moveTo(toX(gx), toY(RH / 2 - GOAL_W / 2)); c.lineTo(toX(gx), toY(RH / 2 + GOAL_W / 2)); c.stroke();
  }
  // puck
  c.beginPath(); c.arc(toX(puck.x), toY(puck.y), puckRadius() * scale, 0, Math.PI * 2);
  c.fillStyle = '#141414'; c.fill(); c.strokeStyle = '#ffffff88'; c.lineWidth = 1.5; c.stroke();
  // skaters
  for (const sk of skaters) {
    const team = teamOf(sk.slot);
    const sx = toX(sk.x), sy = toY(sk.y);
    c.beginPath(); c.arc(sx, sy, R_SK * scale, 0, Math.PI * 2);
    c.fillStyle = TEAM_COLOR[team]; c.fill();
    c.strokeStyle = sk.slot === mySlot ? '#ffe066' : '#00000055'; c.lineWidth = sk.slot === mySlot ? 3 : 1.5; c.stroke();
    c.fillStyle = '#fff'; c.font = `bold ${Math.round(13 * scale + 6)}px ui-monospace,monospace`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(String(sk.slot), sx, sy + 1);
    c.fillStyle = TEAM_COLOR[team]; c.font = `${Math.round(11 * scale + 6)}px ui-monospace,monospace`;
    c.fillText(nameOf(sk.slot), sx, sy - R_SK * scale - 8);
  }
  // goal-pause flash / end-of-game veil
  if (over) {
    c.fillStyle = '#0a1f30cc'; c.fillRect(0, 0, W, H);
    c.textAlign = 'center';
    c.fillStyle = over.team !== undefined ? TEAM_COLOR[over.team] : '#dceaf5';
    c.font = '26px Georgia, serif'; c.fillText(over.text, W / 2, H / 2 - 20);
    c.fillStyle = '#a8c8dc'; c.font = 'italic 14px Georgia, serif'; c.fillText(over.sub, W / 2, H / 2 + 8);
  } else if (Date.now() < goalPauseUntil) {
    c.fillStyle = '#dceaf5'; c.textAlign = 'center'; c.font = 'bold 30px Georgia, serif';
    c.fillText('🚨 GOAL! 🚨', W / 2, H / 2 - 12);
    c.fillStyle = '#a8c8dc'; c.font = 'italic 13px Georgia, serif';
    c.fillText(goalQuip, W / 2, H / 2 + 16);
  }
  renderHud();
}

function renderHud() {
  const hud = document.getElementById('hockeyHud');
  if (!hud) return;
  const scoreLine = '<div style="display:inline-block;padding:6px 18px;border-radius:10px;background:#0f2942cc;border:1px solid #3a6a8a;font-size:20px;">' +
    `<span style="color:${TEAM_COLOR[0]}">${TEAM_NAME[0]} ${score[0]}</span>` +
    '<span style="color:#a8c8dc;margin:0 8px;">–</span>' +
    `<span style="color:${TEAM_COLOR[1]}">${score[1]} ${TEAM_NAME[1]}</span></div>`;
  let overRow = '';
  if (over) {
    if (vsBot) overRow = `<div style="margin-top:10px;pointer-events:auto;"><button id="hkAgain" style="${BTN}">Rematch</button></div>`;
    else if (mySlot === 0) overRow = `<div style="margin-top:10px;pointer-events:auto;"><button id="hkAgain" style="${BTN}">Drop the puck again</button></div>`;
    else overRow = '<div style="margin-top:10px;font-size:12px;color:#a8c8dc;font-style:italic;">Waiting for the host…</div>';
  }
  hud.innerHTML = `${scoreLine}${overRow}`;
  const again = document.getElementById('hkAgain');
  if (again) again.onclick = () => { if (vsBot) startBotGame(); else net?.start(); };
}
