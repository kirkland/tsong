// A tiny self-contained DOOM-style raycaster, launched from tsong as a toy.
//
// Solo or 2-player co-op. It is deliberately isolated: its own fullscreen overlay, canvas,
// input handlers and game loop, all torn down on exit. It never touches the Pong game state
// or shared modules. Loaded lazily the first time the player opens it.
//
// Co-op uses host authority: the server only runs a 2-slot lobby + opaque relay (see Lobby),
// the actual sim runs here. Slot 0 is the host (authoritative): it simulates both marines and
// all enemies and streams snapshots to the guest; the guest sends its input and renders from
// those snapshots. Rendering is a classic Lode-style DDA raycaster at a chunky 320×200.

const MAP = [
  '1111111111111111',
  '1..............1',
  '1..............1',
  '1...22....22...1',
  '1...22....22...1',
  '1..............1',
  '1..............1',
  '1......33......1',
  '1......33......1',
  '1..............1',
  '1..............1',
  '1...22....22...1',
  '1...22....22...1',
  '1..............1',
  '1..............1',
  '1111111111111111',
];
const MAP_W = MAP[0].length;
const MAP_H = MAP.length;
const W = 320;
const H = 200;

// The boss is drawn as the minion image (the same one used by the minion power-up).
const bossImg = new Image();
bossImg.src = '/minion.png';
// The every-3-rounds mini-boss is drawn with the fritz photo.
const fritzImg = new Image();
fritzImg.src = '/fritz.jpg';
// The every-2-rounds mini-boss is drawn with the jsav photo.
const jsavImg = new Image();
jsavImg.src = '/jsav.jpg';
const isBossRound = (round: number): boolean => round % 5 === 0;
// Grenade: thrown with space, flies forward, then explodes for big area damage.
const GRENADE_SPEED = 7;   // tiles / second
const GRENADE_FUSE = 0.85; // seconds before it detonates
const GRENADE_RADIUS = 2.6; // blast radius, tiles
const GRENADE_DMG = 6;     // damage to every enemy in the blast

function isWall(mx: number, my: number): boolean {
  if (mx < 0 || my < 0 || mx >= MAP_W || my >= MAP_H) return true;
  return MAP[my][mx] !== '.';
}

// Clear line of sight between two points (no wall crossing) — coarse step sampling.
function losClear(x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const steps = Math.ceil(dist / 0.08);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (isWall(Math.floor(x0 + dx * t), Math.floor(y0 + dy * t))) return false;
  }
  return true;
}

interface Player {
  x: number; y: number; angle: number;
  health: number; ammo: number; alive: boolean; flash: number;
  grenades: number; // thrown with space; earned from killing the jsav enemy
}
interface Enemy {
  x: number; y: number; hp: number; alive: boolean; flash: number; attackCd: number;
  boss?: boolean; maxHp?: number; // boss-round minion: big, tanky, hits hard
  fritz?: boolean; // every-3-rounds mini-boss drawn with the fritz photo (drops full health)
  jsav?: boolean; // every-2-rounds mini-boss drawn with the jsav photo (drops a grenade)
}
interface Grenade { x: number; y: number; vx: number; vy: number; fuse: number; }
interface Blast { x: number; y: number; t: number; } // explosion flash effect (t counts down)
interface GuestInput { forward: number; strafe: number; angle: number; fireSeq: number; grenadeSeq: number; }

// Networking hook into the host websocket (provided by main.ts).
export interface DoomScore { name: string; round: number; }
export interface DoomNet {
  join(): void;
  leave(): void;
  relay(data: unknown): void;
  // Record the round reached on a run's end. For co-op, `label` is the combined team name.
  submitScore(round: number, coop: boolean, label?: string): void;
  scores(): { solo: DoomScore[]; coop: DoomScore[] }; // latest high-round leaderboards
  name(): string; // this client's display name
  awardCoin(): void; // grant this player 1 coin (for killing the minion boss)
}

// The running instance feeds server messages back to itself through these module-level hooks,
// which main.ts calls when a doom* message arrives.
let handlers: {
  lobby: (m: { status: string; filled: number; slot: number | null }) => void;
  relay: (d: unknown) => void;
  end: (reason: string) => void;
} | null = null;
export function feedDoomLobby(m: { status: string; filled: number; slot: number | null }) { handlers?.lobby(m); }
export function feedDoomRelay(d: unknown) { handlers?.relay(d); }
export function feedDoomEnd(reason: string) { handlers?.end(reason); }

const LOW_AMMO = 25; // slain enemies only drop ammo while a player is below this
const AMMO_PER_PICKUP = 20; // ammo gained from walking over a drop
const PICKUP_RADIUS = 0.6; // how close you must get to grab a drop (grid units)

// Survival rounds: each round spawns more (and slightly tougher) enemies at random open
// cells, kept clear of the players' spawn corner.
function enemyCountFor(round: number): number { return 3 + (round - 1) * 2; }
function enemyHpFor(round: number): number { return 2 + Math.floor((round - 1) / 4); }
function enemySpeedFor(round: number): number { return Math.min(1.3 + (round - 1) * 0.1, 2.6); }

function randomOpenCell(players: Player[], minDist: number): { x: number; y: number } {
  let guard = 0;
  while (guard++ < 2000) {
    const mx = 1 + Math.floor(Math.random() * (MAP_W - 2));
    const my = 1 + Math.floor(Math.random() * (MAP_H - 2));
    if (isWall(mx, my)) continue;
    const x = mx + 0.5, y = my + 0.5;
    if (players.some((p) => p.alive && Math.hypot(p.x - x, p.y - y) < minDist)) continue;
    return { x, y };
  }
  return { x: MAP_W / 2, y: MAP_H / 2 };
}

function spawnEnemiesForRound(round: number, players: Player[]): Enemy[] {
  // Every 5th round is a minion BOSS battle: one big, tanky, hard-hitting minion plus a
  // handful of regular adds. Tougher than any normal wave.
  if (isBossRound(round)) {
    const out: Enemy[] = [];
    const bossPos = randomOpenCell(players, 6);
    const bossHp = 18 + round * 2; // a real bullet-sponge (e.g. ~28 at round 5, ~38 at round 10)
    out.push({ ...bossPos, hp: bossHp, maxHp: bossHp, alive: true, flash: 0, attackCd: 0, boss: true });
    const adds = 1 + Math.floor(round / 10); // just a couple imps alongside the boss
    const hp = enemyHpFor(round);
    for (let i = 0; i < adds; i++) {
      out.push({ ...randomOpenCell(players, 4), hp, alive: true, flash: 0, attackCd: 0 });
    }
    return out;
  }
  const out: Enemy[] = [];
  const n = enemyCountFor(round);
  const hp = enemyHpFor(round);
  for (let i = 0; i < n; i++) {
    out.push({ ...randomOpenCell(players, 4), hp, alive: true, flash: 0, attackCd: 0 });
  }
  // Every 3rd round: promote one enemy to a FRITZ mini-boss (drops full health on death).
  if (round % 3 === 0 && out.length) {
    out[0] = { ...out[0], hp: 10, maxHp: 10, fritz: true };
  }
  // Every 2nd round: promote a (different) enemy to a JSAV mini-boss (drops a grenade).
  if (round % 2 === 0) {
    const idx = out.findIndex((e) => !e.fritz);
    if (idx !== -1) out[idx] = { ...out[idx], hp: 10, maxHp: 10, jsav: true };
  }
  return out;
}
function freshPlayer(x: number, y: number): Player {
  return { x, y, angle: 0, health: 100, ammo: 60, alive: true, flash: 0, grenades: 0 };
}

let doomBest = 0; // best round this client has reached this session (for the menu)


function escapeText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

let doomOpen = false;

export function startDoom(net: DoomNet): void {
  if (doomOpen) return;
  doomOpen = true;

  // 'menu' → 'solo' | 'wait' (joined co-op, waiting) → 'host' | 'guest' ; 'ended' is terminal.
  type Mode = 'menu' | 'wait' | 'solo' | 'host' | 'guest' | 'ended';
  let mode: Mode = 'menu';
  let selfIdx = 0; // which player[] entry is "me" (0 host, 1 guest)

  // --- DOM ---
  const overlay = document.createElement('div');
  overlay.id = 'doomOverlay';
  // Note: no global cursor:none — the menu needs a visible pointer to click SOLO/CO-OP.
  // During play the mouse is pointer-locked (hidden by the browser) anyway.
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:#000;display:flex;align-items:center;' +
    'justify-content:center;flex-direction:column;font-family:ui-monospace,monospace;';

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.style.cssText =
    'image-rendering:pixelated;height:88vh;max-width:100vw;aspect-ratio:8/5;background:#000;';
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  overlay.appendChild(canvas);

  // Procedurally generated starry-night ceiling (built once, blitted each frame). A black
  // sky scattered with stars of varying size/brightness in mostly blue-white with a few
  // warm ones, plus a couple of soft glowing bright stars — evokes a clear night sky.
  const sky = document.createElement('canvas');
  sky.width = W; sky.height = H / 2;
  (() => {
    const sc = sky.getContext('2d')!;
    sc.fillStyle = '#04060d';
    sc.fillRect(0, 0, W, H / 2);
    const palette = ['#ffffff', '#cfe0ff', '#9fc0ff', '#bfe0ff', '#fff0d0', '#ffd0a0', '#ffb0b0'];
    for (let i = 0; i < 420; i++) {
      const x = Math.random() * W;
      const y = Math.random() * (H / 2);
      const b = 0.3 + Math.random() * 0.7;
      sc.globalAlpha = b;
      sc.fillStyle = palette[(Math.random() * (Math.random() < 0.8 ? 4 : palette.length)) | 0];
      sc.fillRect(x, y, Math.random() < 0.15 ? 2 : 1, 1);
    }
    // A handful of bright glowing stars.
    for (let i = 0; i < 6; i++) {
      const x = Math.random() * W;
      const y = Math.random() * (H / 2);
      const g = sc.createRadialGradient(x, y, 0, x, y, 3.5);
      const col = palette[(Math.random() * palette.length) | 0];
      g.addColorStop(0, col);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      sc.globalAlpha = 1;
      sc.fillStyle = g;
      sc.fillRect(x - 4, y - 4, 8, 8);
    }
    sc.globalAlpha = 1;
  })();

  const hud = document.createElement('div');
  hud.style.cssText =
    'position:absolute;left:0;right:0;bottom:calc(6vh - 6px);display:flex;gap:28px;' +
    'justify-content:center;font:700 22px ui-monospace,monospace;color:#ffd166;' +
    'text-shadow:2px 2px 0 #000;letter-spacing:1px;pointer-events:none;';
  const healthEl = document.createElement('span');
  const ammoEl = document.createElement('span');
  const killsEl = document.createElement('span');
  healthEl.style.color = '#ff5c5c';
  hud.append(healthEl, ammoEl, killsEl);
  overlay.appendChild(hud);

  const title = document.createElement('div');
  title.style.cssText =
    'position:absolute;top:14px;left:0;right:0;text-align:center;font:700 14px ui-monospace,monospace;' +
    'color:#9fb0d8;text-shadow:1px 1px 0 #000;pointer-events:none;';
  title.textContent = 'WASD move · mouse/←→ turn · click shoot · space grenade · ESC quit';
  overlay.appendChild(title);

  const banner = document.createElement('div');
  banner.style.cssText =
    'position:absolute;inset:0;display:none;align-items:center;justify-content:center;' +
    'font:900 52px ui-monospace,monospace;color:#ff2d2d;text-shadow:4px 4px 0 #000;' +
    'text-align:center;white-space:pre;pointer-events:none;';
  overlay.appendChild(banner);

  // Menu layer (solo / co-op chooser, then the waiting screen).
  const menu = document.createElement('div');
  menu.style.cssText =
    'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:22px;background:rgba(0,0,0,0.85);';
  const menuTitle = document.createElement('div');
  menuTitle.textContent = '😈 DOOM';
  menuTitle.style.cssText = 'font:900 64px ui-monospace,monospace;color:#ff2d2d;text-shadow:4px 4px 0 #300;';
  const menuMsg = document.createElement('div');
  menuMsg.style.cssText = 'font:700 18px ui-monospace,monospace;color:#9fb0d8;min-height:22px;text-align:center;';
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:18px;';
  const mkBtn = (label: string) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'font:700 20px ui-monospace,monospace;padding:14px 26px;border-radius:8px;cursor:pointer;' +
      'border:1px solid #5a2230;background:#1a0e12;color:#ff7a7a;';
    b.onmouseenter = () => { b.style.background = '#2a1218'; };
    b.onmouseleave = () => { b.style.background = '#1a0e12'; };
    return b;
  };
  const soloBtn = mkBtn('SOLO');
  const coopBtn = mkBtn('CO-OP');
  const cancelWaitBtn = mkBtn('CANCEL');
  cancelWaitBtn.style.display = 'none';
  btnRow.append(soloBtn, coopBtn, cancelWaitBtn);
  // Controls + boss/drop legend, shown on the start menu.
  const menuInfo = document.createElement('div');
  menuInfo.style.cssText =
    'max-width:520px;font:600 13px ui-monospace,monospace;color:#9fb0d8;line-height:1.7;text-align:center;';
  menuInfo.innerHTML =
    '<div style="color:#cdd7f5;font-weight:700;margin-bottom:4px">CONTROLS</div>' +
    'WASD move · A/D strafe · mouse or ←/→ turn · click to shoot · <b>SPACE</b> to throw a grenade · ESC quit' +
    '<div style="color:#cdd7f5;font-weight:700;margin:12px 0 4px">SURVIVE THE ROUNDS</div>' +
    'Each round spawns more (and tougher) enemies. Clear them all to advance. Special enemies show up on a schedule:' +
    '<div style="margin-top:8px;text-align:left;display:inline-block">' +
    '<div><span style="color:#ffd21e">😈 Minion BOSS</span> — every 5th round. Huge, tanky, hits hard (with its own health bar). <b>Kill it for a coin.</b></div>' +
    '<div><span style="color:#f59e0b">🧍 Fritz</span> — every 3rd round. A beefy mini-boss. <b>Drops a full-health pack.</b></div>' +
    '<div><span style="color:#63e6be">🧍 Jsav</span> — every 2nd round. A beefy mini-boss. <b>Drops a grenade.</b></div>' +
    '</div>' +
    '<div style="margin-top:10px;color:#8693b3">Low on ammo? Regular kills drop ammo when you need it. Co-op: you both share the round &amp; high-score.</div>';
  menu.append(menuTitle, menuMsg, btnRow, menuInfo);
  overlay.appendChild(menu);

  // High-round leaderboards (solo + co-op), filled live from net.scores(). Shown on the
  // menu and again on the game-over screen, so it sits on the overlay (above the menu).
  const boards = document.createElement('div');
  boards.style.cssText =
    'position:absolute;left:0;right:0;bottom:8vh;display:none;gap:48px;justify-content:center;' +
    'color:#cdd7f5;font:700 14px ui-monospace,monospace;pointer-events:none;text-shadow:1px 1px 0 #000;';
  overlay.appendChild(boards);

  function boardHtml(heading: string, rows: DoomScore[]): string {
    const items = rows.slice(0, 5).map((r, i) =>
      `<div style="display:flex;justify-content:space-between;gap:16px">` +
      `<span>${i + 1}. ${escapeText(r.name)}</span><span style="color:#ffd166">R${r.round}</span></div>`,
    ).join('') || '<div style="color:#6b7796">no runs yet</div>';
    return `<div><div style="color:#ff7a7a;margin-bottom:6px">${heading}</div>${items}</div>`;
  }
  function renderBoards() {
    const s = net.scores();
    boards.innerHTML = boardHtml('SOLO · TOP ROUNDS', s.solo) + boardHtml('CO-OP · TOP ROUNDS', s.coop);
  }

  document.body.appendChild(overlay);

  // --- world state ---
  let players: Player[] = [];
  let enemies: Enemy[] = [];
  let kills = 0;
  let round = 1;
  let betweenTimer = 0; // seconds of the "ROUND N" intermission remaining (0 = fighting)
  let over: 'dead' | null = null; // survival mode: you only ever lose
  let scoreSubmitted = false;
  // Pickups dropped by slain enemies: ammo crates (when low), full-health packs (fritz),
  // and grenades (jsav).
  let drops: Array<{ x: number; y: number; kind: 'ammo' | 'health' | 'grenade' }> = [];
  let grenades: Grenade[] = []; // live thrown grenades (authority simulates them)
  let blasts: Blast[] = []; // explosion flash effects (visual)
  let myGrenadeSeq = 0; // counts our grenade throws (guest tells the host via input)
  let lastGuestGrenadeSeq = 0; // host: last processed guest grenade throw

  // local input / feedback
  const keys = new Set<string>();
  let myAngle = 0;
  let muzzle = 0;
  let hurt = 0;
  let gunRecoil = 0;
  let bob = 0;
  let myFireSeq = 0; // counts our shots (guest uses this to tell the host to fire)
  let lastGuestFireSeq = 0; // host: last processed guest shot
  let guestIn: GuestInput = { forward: 0, strafe: 0, angle: 0, fireSeq: 0 };
  let partnerName = ''; // co-op: the other player's name (host learns it via relay)
  const zBuffer = new Float32Array(W);

  const me = (): Player => players[selfIdx];
  const partner = (): Player | null => (players.length > 1 ? players[1 - selfIdx] : null);

  // --- audio ---
  let audio: AudioContext | null = null;
  const ac = () => (audio ??= new AudioContext());
  const bossLaugh = new Audio('/minion-laugh.mp3'); // the boss cackles every time it's shot
  function laughSound() { try { bossLaugh.currentTime = 0; void bossLaugh.play(); } catch { /* ignore */ } }
  const bossMusic = new Audio('/disco.mp3'); // loops during boss-fight rounds
  bossMusic.loop = true;
  let bossMusicOn = false;
  // Start/stop the boss music to match whether a live boss round is in progress.
  function syncBossMusic() {
    const want = isBossRound(round) && !over && betweenTimer <= 0
      && (mode === 'solo' || mode === 'host' || mode === 'guest');
    if (want && !bossMusicOn) { bossMusicOn = true; try { bossMusic.currentTime = 0; void bossMusic.play(); } catch { /* ignore */ } }
    else if (!want && bossMusicOn) { bossMusicOn = false; bossMusic.pause(); }
  }
  function shotSound() {
    try {
      const a = ac();
      const buf = a.createBuffer(1, a.sampleRate * 0.18, a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
      const src = a.createBufferSource(); src.buffer = buf;
      const g = a.createGain(); g.gain.value = 0.35;
      src.connect(g); g.connect(a.destination); src.start();
    } catch { /* ignore */ }
  }
  function deathSound() {
    try {
      const a = ac();
      const o = a.createOscillator(); const g = a.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(220, a.currentTime);
      o.frequency.exponentialRampToValueAtTime(50, a.currentTime + 0.3);
      g.gain.setValueAtTime(0.25, a.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.32);
      o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.34);
    } catch { /* ignore */ }
  }
  function pickupSound() {
    try {
      const a = ac();
      const o = a.createOscillator(); const g = a.createGain();
      o.type = 'square';
      o.frequency.setValueAtTime(440, a.currentTime);
      o.frequency.exponentialRampToValueAtTime(880, a.currentTime + 0.1);
      g.gain.setValueAtTime(0.18, a.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.14);
      o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.16);
    } catch { /* ignore */ }
  }
  function boomSound() {
    try {
      const a = ac();
      const dur = 0.4;
      const buf = a.createBuffer(1, a.sampleRate * dur, a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 1.5);
      const src = a.createBufferSource(); src.buffer = buf;
      const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 800;
      const g = a.createGain(); g.gain.value = 0.5;
      src.connect(lp); lp.connect(g); g.connect(a.destination); src.start();
    } catch { /* ignore */ }
  }

  // --- hitscan: a shot from player p down its facing angle hits the nearest, unobstructed enemy ---
  function fireFrom(p: Player) {
    let best: Enemy | null = null;
    let bestDist = Infinity;
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      const dist = Math.hypot(dx, dy);
      let diff = Math.atan2(dy, dx) - p.angle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const tol = Math.atan2(0.5, dist) + 0.03; // closer enemies are easier to hit
      if (Math.abs(diff) > tol) continue;
      if (!losClear(p.x, p.y, e.x, e.y)) continue;
      if (dist < bestDist) { bestDist = dist; best = e; }
    }
    if (best) {
      best.hp -= 1;
      best.flash = 0.12;
      if (best.boss) laughSound(); // the boss cackles every time it's hit
      if (best.hp <= 0) killEnemy(best);
    }
  }

  // Mark an enemy dead, bump the kill count, and roll its drop.
  function killEnemy(e: Enemy) {
    e.alive = false; kills++; deathSound();
    if (e.fritz) {
      drops.push({ x: e.x, y: e.y, kind: 'health' }); // full-health pack
    } else if (e.jsav) {
      drops.push({ x: e.x, y: e.y, kind: 'grenade' }); // a grenade
    } else {
      // Regular kills drop an ammo pack only when someone's running low (and not always).
      const someoneLow = players.some((pl) => pl.alive && pl.ammo < LOW_AMMO);
      if (someoneLow && Math.random() < 0.6) drops.push({ x: e.x, y: e.y, kind: 'ammo' });
    }
  }

  // Throw a grenade (local player). Host/solo spawn it; guest tells the host via input.
  function throwGrenade() {
    if (over || me().grenades <= 0) return;
    me().grenades -= 1;
    myGrenadeSeq++;
    if (mode !== 'guest') spawnGrenade(me());
  }
  function spawnGrenade(p: Player) {
    grenades.push({ x: p.x, y: p.y, vx: Math.cos(p.angle) * GRENADE_SPEED, vy: Math.sin(p.angle) * GRENADE_SPEED, fuse: GRENADE_FUSE });
  }
  // Detonate at (x,y): flash + big area damage to every enemy in the blast (authority only).
  function explode(x: number, y: number) {
    blasts.push({ x, y, t: 0.45 });
    boomSound();
    for (const e of enemies) {
      if (!e.alive) continue;
      if (Math.hypot(e.x - x, e.y - y) <= GRENADE_RADIUS) {
        e.hp -= GRENADE_DMG; e.flash = 0.15;
        if (e.hp <= 0) killEnemy(e);
      }
    }
  }
  // Advance live grenades; detonate on a wall or when the fuse runs out (authority only).
  function moveGrenades(dt: number) {
    for (let i = grenades.length - 1; i >= 0; i--) {
      const g = grenades[i];
      g.fuse -= dt;
      const nx = g.x + g.vx * dt, ny = g.y + g.vy * dt;
      if (g.fuse <= 0 || isWall(Math.floor(nx), Math.floor(ny))) {
        explode(g.x, g.y);
        grenades.splice(i, 1);
      } else { g.x = nx; g.y = ny; }
    }
  }

  // A shot by the local player (solo/host fire immediately; guest tells the host).
  function localFire() {
    if (over || me().ammo <= 0 || !me().alive) return;
    me().ammo--;
    myFireSeq++;
    muzzle = 0.07; gunRecoil = 1;
    shotSound();
    if (mode !== 'guest') fireFrom(me()); // host/solo resolve the hit locally
  }

  function moveWithCollision(p: Player, nx: number, ny: number) {
    const pad = 0.18;
    if (!isWall(Math.floor(nx + Math.sign(nx - p.x) * pad), Math.floor(p.y))) p.x = nx;
    if (!isWall(Math.floor(p.x), Math.floor(ny + Math.sign(ny - p.y) * pad))) p.y = ny;
  }

  // Read local keys → a movement intent (forward/strafe) for the local player.
  function readIntent(dt: number): { forward: number; strafe: number } {
    let forward = 0, strafe = 0;
    if (keys.has('w') || keys.has('arrowup')) forward += 1;
    if (keys.has('s') || keys.has('arrowdown')) forward -= 1;
    if (keys.has('a')) strafe -= 1;
    if (keys.has('d')) strafe += 1;
    if (forward || strafe) bob += dt * 9;
    return { forward, strafe };
  }

  function integrate(p: Player, forward: number, strafe: number, dt: number) {
    const dirX = Math.cos(p.angle), dirY = Math.sin(p.angle);
    const sp = 3.2 * dt;
    const nx = p.x + (dirX * forward - dirY * strafe) * sp;
    const ny = p.y + (dirY * forward + dirX * strafe) * sp;
    moveWithCollision(p, nx, ny);
  }

  // Walk-over ammo pickups (authority only: solo + host). Local pickups beep.
  function collectDrops() {
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      const grabber = players.find((p) => p.alive && Math.hypot(p.x - d.x, p.y - d.y) < PICKUP_RADIUS);
      if (grabber) {
        if (d.kind === 'health') grabber.health = 100; // fritz pack = full heal
        else if (d.kind === 'grenade') grabber.grenades += 1; // jsav drop
        else grabber.ammo += AMMO_PER_PICKUP;
        drops.splice(i, 1);
        if (grabber === me()) pickupSound();
      }
    }
  }

  // Enemy AI (authority only: solo + host). Each enemy hunts the nearest alive marine.
  function stepEnemies(dt: number) {
    for (const e of enemies) {
      if (!e.alive) continue;
      if (e.flash > 0) e.flash -= dt;
      if (e.attackCd > 0) e.attackCd -= dt;
      let target: Player | null = null;
      let td = Infinity;
      for (const p of players) {
        if (!p.alive) continue;
        const d = Math.hypot(p.x - e.x, p.y - e.y);
        if (d < td) { td = d; target = p; }
      }
      if (!target) continue;
      const reach = e.boss ? 1.4 : 1.1; // the boss is bigger, so it strikes from a bit further
      if (td > reach) {
        const sp = (e.boss ? enemySpeedFor(round) * 0.9 : enemySpeedFor(round)) * dt;
        const dx = (target.x - e.x) / td, dy = (target.y - e.y) / td;
        if (!isWall(Math.floor(e.x + dx * sp), Math.floor(e.y))) e.x += dx * sp;
        if (!isWall(Math.floor(e.x), Math.floor(e.y + dy * sp))) e.y += dy * sp;
      } else if (e.attackCd <= 0) {
        target.health -= e.boss ? 22 : (e.fritz || e.jsav) ? 14 : 9; // boss hits hardest; mini-bosses a bit harder
        e.attackCd = e.boss ? 0.9 : 1.1;
        if (target === me()) hurt = 0.25;
        if (target.health <= 0) { target.health = 0; target.alive = false; }
      }
    }
  }

  // Authority round logic: clear the wave → brief intermission → spawn a bigger next wave.
  // You only ever lose (when every marine is down). Runs on solo + host.
  function stepRounds(dt: number) {
    if (over) return;
    if (players.every((p) => !p.alive)) { over = 'dead'; return; }
    if (betweenTimer > 0) {
      betweenTimer -= dt;
      if (betweenTimer <= 0) { enemies = spawnEnemiesForRound(round, players); betweenTimer = 0; }
      return;
    }
    if (enemies.every((e) => !e.alive)) {
      // Wave cleared — advance, reward survivors, and queue the next wave.
      round++;
      betweenTimer = isBossRound(round) ? 3.2 : 2.2; // longer "get ready" before a boss
      enemies = [];
      for (const p of players) {
        if (!p.alive) continue;
        p.health = Math.min(100, p.health + 20);
        p.ammo += 25;
      }
    }
  }

  // Submit the round reached once, the moment the run ends.
  function maybeSubmitScore() {
    if (over !== 'dead' || scoreSubmitted) return;
    scoreSubmitted = true;
    doomBest = Math.max(doomBest, round);
    if (mode === 'solo') {
      net.submitScore(round, false);
    } else if (mode === 'host') {
      // One combined team entry, e.g. "Julian and Matt" (sorted so order doesn't matter).
      const names = [net.name(), partnerName || 'partner'].sort((a, b) => a.localeCompare(b));
      net.submitScore(round, true, `${names[0]} and ${names[1]}`);
    }
    // The guest doesn't submit — the host records the shared team score for both.
  }

  // --- per-mode update ---
  let netAccum = 0; // host snapshot / guest input send throttle
  function update(dt: number) {
    if (mode === 'solo') {
      if (!over) {
        me().angle = myAngle;
        const { forward, strafe } = readIntent(dt);
        if (me().alive) integrate(me(), forward, strafe, dt);
        if (keys.has('arrowleft')) myAngle -= 2.6 * dt;
        if (keys.has('arrowright')) myAngle += 2.6 * dt;
        stepEnemies(dt);
        moveGrenades(dt);
        collectDrops();
        stepRounds(dt);
      }
      maybeSubmitScore();
    } else if (mode === 'host') {
      if (!over) {
        players[0].angle = myAngle;
        const { forward, strafe } = readIntent(dt);
        if (players[0].alive) integrate(players[0], forward, strafe, dt);
        if (keys.has('arrowleft')) myAngle -= 2.6 * dt;
        if (keys.has('arrowright')) myAngle += 2.6 * dt;
        // apply guest input → player[1]
        players[1].angle = guestIn.angle;
        if (players[1].alive) integrate(players[1], guestIn.forward, guestIn.strafe, dt);
        if (guestIn.fireSeq > lastGuestFireSeq) {
          lastGuestFireSeq = guestIn.fireSeq;
          if (players[1].alive && players[1].ammo > 0) { players[1].ammo--; fireFrom(players[1]); }
        }
        if (guestIn.grenadeSeq > lastGuestGrenadeSeq) {
          lastGuestGrenadeSeq = guestIn.grenadeSeq;
          if (players[1].alive && players[1].grenades > 0) { players[1].grenades--; spawnGrenade(players[1]); }
        }
        stepEnemies(dt);
        moveGrenades(dt);
        collectDrops();
        stepRounds(dt);
      }
      maybeSubmitScore();
      // stream a snapshot to the guest ~20/s
      netAccum += dt;
      if (netAccum >= 0.05) {
        netAccum = 0;
        net.relay({
          t: 'st',
          players: players.map((p) => ({ x: p.x, y: p.y, angle: p.angle, health: p.health, ammo: p.ammo, alive: p.alive, flash: p.flash, grenades: p.grenades })),
          enemies: enemies.map((e) => ({ x: e.x, y: e.y, alive: e.alive, flash: e.flash, boss: !!e.boss, fritz: !!e.fritz, jsav: !!e.jsav, hpFrac: e.maxHp ? e.hp / e.maxHp : 1 })),
          drops: drops.map((d) => ({ x: d.x, y: d.y, kind: d.kind })),
          grenades: grenades.map((g) => ({ x: g.x, y: g.y })),
          blasts: blasts.map((b) => ({ x: b.x, y: b.y, t: b.t })),
          round, between: betweenTimer > 0, over,
        });
      }
    } else if (mode === 'guest') {
      // we own only our heading; send input ~30/s, render from host snapshots
      if (keys.has('arrowleft')) myAngle -= 2.6 * dt;
      if (keys.has('arrowright')) myAngle += 2.6 * dt;
      const { forward, strafe } = readIntent(dt);
      netAccum += dt;
      if (netAccum >= 0.033) {
        netAccum = 0;
        net.relay({ t: 'in', forward, strafe, angle: myAngle, fireSeq: myFireSeq, grenadeSeq: myGrenadeSeq });
      }
      maybeSubmitScore(); // round/over arrive via the host snapshot
    }
    // Fade explosion flashes on every client.
    for (let i = blasts.length - 1; i >= 0; i--) { blasts[i].t -= dt; if (blasts[i].t <= 0) blasts.splice(i, 1); }
    if (muzzle > 0) muzzle -= dt;
    if (hurt > 0) hurt -= dt;
    if (gunRecoil > 0) gunRecoil = Math.max(0, gunRecoil - dt * 5);
  }

  // --- rendering (from the local player's POV) ---
  function render() {
    if (mode === 'menu' || mode === 'wait') { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); return; }
    const viewer = me();
    const vx = viewer.x, vy = viewer.y;
    const va = mode === 'guest' ? myAngle : viewer.angle; // guest predicts its own heading

    ctx.drawImage(sky, 0, 0); // starry-night ceiling
    ctx.fillStyle = '#3a2e26'; ctx.fillRect(0, H / 2, W, H / 2);

    const dirX = Math.cos(va), dirY = Math.sin(va);
    const fov = 0.66;
    const planeX = -dirY * fov, planeY = dirX * fov;

    for (let x = 0; x < W; x++) {
      const cameraX = (2 * x) / W - 1;
      const rayX = dirX + planeX * cameraX;
      const rayY = dirY + planeY * cameraX;
      let mapX = Math.floor(vx), mapY = Math.floor(vy);
      const deltaX = Math.abs(1 / rayX), deltaY = Math.abs(1 / rayY);
      let stepX: number, stepY: number, sideDistX: number, sideDistY: number;
      if (rayX < 0) { stepX = -1; sideDistX = (vx - mapX) * deltaX; } else { stepX = 1; sideDistX = (mapX + 1 - vx) * deltaX; }
      if (rayY < 0) { stepY = -1; sideDistY = (vy - mapY) * deltaY; } else { stepY = 1; sideDistY = (mapY + 1 - vy) * deltaY; }
      let side = 0, guard = 0, hitChar = '1';
      while (guard++ < 128) {
        if (sideDistX < sideDistY) { sideDistX += deltaX; mapX += stepX; side = 0; }
        else { sideDistY += deltaY; mapY += stepY; side = 1; }
        if (isWall(mapX, mapY)) { hitChar = (mapX < 0 || mapY < 0 || mapX >= MAP_W || mapY >= MAP_H) ? '1' : MAP[mapY][mapX]; break; }
      }
      const perp = side === 0 ? sideDistX - deltaX : sideDistY - deltaY;
      zBuffer[x] = perp;
      const lineH = Math.floor(H / Math.max(perp, 0.0001));
      const start = Math.max(0, Math.floor(H / 2 - lineH / 2));
      const end = Math.min(H - 1, Math.floor(H / 2 + lineH / 2));
      let r = 150, g = 40, b = 40;
      if (hitChar === '2') { r = 70; g = 90; b = 140; } else if (hitChar === '3') { r = 80; g = 130; b = 70; }
      let shade = side === 1 ? 0.66 : 1;
      shade *= Math.max(0.25, Math.min(1, 1.6 / (1 + perp * 0.25)));
      ctx.fillStyle = `rgb(${(r * shade) | 0},${(g * shade) | 0},${(b * shade) | 0})`;
      ctx.fillRect(x, start, 1, end - start + 1);
    }

    // Sprites: enemies, drops, thrown grenades, explosions + the partner, z-buffer occluded.
    type Spr = { x: number; y: number; kind: 'imp' | 'marine' | 'ammo' | 'health' | 'grenade' | 'boss' | 'fritz' | 'jsav' | 'blast'; flash: boolean; t?: number };
    const sprites: Spr[] = [];
    for (const e of enemies) if (e.alive) sprites.push({ x: e.x, y: e.y, kind: e.boss ? 'boss' : e.fritz ? 'fritz' : e.jsav ? 'jsav' : 'imp', flash: e.flash > 0 });
    for (const d of drops) sprites.push({ x: d.x, y: d.y, kind: d.kind, flash: false });
    for (const g of grenades) sprites.push({ x: g.x, y: g.y, kind: 'grenade', flash: false });
    for (const b of blasts) sprites.push({ x: b.x, y: b.y, kind: 'blast', flash: false, t: b.t });
    const mate = partner();
    if (mate && mate.alive) sprites.push({ x: mate.x, y: mate.y, kind: 'marine', flash: false });

    const invDet = 1 / (planeX * dirY - dirX * planeY);
    const drawList = sprites
      .map((s) => {
        const sx = s.x - vx, sy = s.y - vy;
        return { s, tX: invDet * (dirY * sx - dirX * sy), tY: invDet * (-planeY * sx + planeX * sy) };
      })
      .filter((d) => d.tY > 0.1)
      .sort((a, b) => b.tY - a.tY);
    for (const d of drawList) {
      const screenX = (W / 2) * (1 + d.tX / d.tY);
      const size = Math.abs(H / d.tY);
      const col = Math.max(0, Math.min(W - 1, Math.floor(screenX)));
      // Explosions draw over walls (they're a flash); everything else respects the z-buffer.
      if (d.s.kind !== 'blast' && d.tY >= zBuffer[col]) continue;
      if (d.s.kind === 'imp') drawImp(screenX, size, d.s.flash);
      else if (d.s.kind === 'ammo') drawAmmo(screenX, size);
      else if (d.s.kind === 'health') drawHealth(screenX, size);
      else if (d.s.kind === 'grenade') drawGrenade(screenX, size);
      else if (d.s.kind === 'blast') drawBlast(screenX, size, d.s.t ?? 0);
      else if (d.s.kind === 'boss') drawBoss(screenX, size, d.s.flash);
      else if (d.s.kind === 'fritz') drawFritz(screenX, size, d.s.flash);
      else if (d.s.kind === 'jsav') drawJsav(screenX, size, d.s.flash);
      else drawMarine(screenX, size);
    }

    drawGun();
    drawCrosshair();
    drawBossBar();
    if (hurt > 0) { ctx.fillStyle = `rgba(180,0,0,${Math.min(0.5, hurt * 1.6)})`; ctx.fillRect(0, 0, W, H); }
  }

  // The boss minion: the minion image drawn big (≈1.7× a normal sprite), flashing white on hit.
  function drawBoss(cx: number, size: number, flash: boolean) {
    const h = Math.min(size * 1.7, H * 1.95);
    const aspect = bossImg.complete && bossImg.naturalWidth ? bossImg.naturalWidth / bossImg.naturalHeight : 1.3;
    const w = h * aspect;
    const top = H / 2 - h / 2;
    const left = cx - w / 2;
    if (bossImg.complete && bossImg.naturalWidth) {
      ctx.drawImage(bossImg, left, top, w, h);
      if (flash) { ctx.save(); ctx.globalAlpha = 0.4; ctx.fillStyle = '#fff'; ctx.fillRect(left, top, w, h); ctx.restore(); }
    } else {
      drawImp(cx, size * 1.7, flash); // fallback until the image loads
    }
  }

  // The round-3 fritz mini-boss: the fritz photo drawn a bit bigger than an imp.
  function drawFritz(cx: number, size: number, flash: boolean) {
    const h = Math.min(size * 1.35, H * 1.6);
    const aspect = fritzImg.complete && fritzImg.naturalWidth ? fritzImg.naturalWidth / fritzImg.naturalHeight : 0.75;
    const w = h * aspect;
    const top = H / 2 - h / 2;
    const left = cx - w / 2;
    if (fritzImg.complete && fritzImg.naturalWidth) {
      ctx.drawImage(fritzImg, left, top, w, h);
      if (flash) { ctx.save(); ctx.globalAlpha = 0.4; ctx.fillStyle = '#fff'; ctx.fillRect(left, top, w, h); ctx.restore(); }
    } else {
      drawImp(cx, size * 1.35, flash); // fallback until the image loads
    }
  }

  // The every-2-rounds jsav mini-boss: the jsav photo drawn a bit bigger than an imp.
  function drawJsav(cx: number, size: number, flash: boolean) {
    const h = Math.min(size * 1.35, H * 1.6);
    const aspect = jsavImg.complete && jsavImg.naturalWidth ? jsavImg.naturalWidth / jsavImg.naturalHeight : 0.75;
    const w = h * aspect;
    const top = H / 2 - h / 2;
    const left = cx - w / 2;
    if (jsavImg.complete && jsavImg.naturalWidth) {
      ctx.drawImage(jsavImg, left, top, w, h);
      if (flash) { ctx.save(); ctx.globalAlpha = 0.4; ctx.fillStyle = '#fff'; ctx.fillRect(left, top, w, h); ctx.restore(); }
    } else {
      drawImp(cx, size * 1.35, flash);
    }
  }

  // A thrown grenade: a small dark sphere with a red blip, near the floor.
  function drawGrenade(cx: number, size: number) {
    const r = Math.max(2, Math.min(size, H * 1.4) * 0.08);
    const cy = H / 2 + Math.min(size, H * 1.4) * 0.2;
    ctx.fillStyle = '#2f3a22';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ff4d1c';
    ctx.fillRect(cx - 1, cy - r - 2, 2, 3);
  }

  // An explosion flash: an expanding orange/yellow burst that fades over its lifetime (t).
  function drawBlast(cx: number, size: number, t: number) {
    const life = Math.max(0, Math.min(1, t / 0.45));
    const r = Math.min(size, H * 1.6) * 0.5 * (1.2 - life * 0.6);
    const cy = H / 2;
    ctx.save();
    ctx.globalAlpha = life;
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = life * 0.7;
    ctx.fillStyle = '#ff6a1a';
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // A boss health bar across the top of the screen while the boss minion is alive.
  function drawBossBar() {
    const boss = enemies.find((e) => e.alive && e.boss);
    if (!boss) return;
    const frac = Math.max(0, Math.min(1, boss.maxHp ? boss.hp / boss.maxHp : 1));
    const bw = W * 0.6, bh = 8, bx = (W - bw) / 2, by = 16;
    ctx.fillStyle = '#000'; ctx.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
    ctx.fillStyle = '#3a0d0d'; ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = '#ffd21e'; ctx.fillRect(bx, by, bw * frac, bh);
    ctx.fillStyle = '#fff'; ctx.font = '8px ui-monospace,monospace'; ctx.textAlign = 'center';
    ctx.fillText('MINION BOSS', W / 2, by - 4);
  }

  function drawImp(cx: number, size: number, flash: boolean) {
    const h = Math.min(size, H * 1.4), w = h * 0.55;
    const top = H / 2 - h / 2, left = cx - w / 2;
    ctx.fillStyle = flash ? '#ffffff' : '#6b3a2a';
    ctx.fillRect(left + w * 0.18, top + h * 0.42, w * 0.64, h * 0.5);
    ctx.fillRect(left + w * 0.02, top + h * 0.5, w * 0.2, h * 0.34);
    ctx.fillRect(left + w * 0.78, top + h * 0.5, w * 0.2, h * 0.34);
    ctx.fillStyle = flash ? '#ffdddd' : '#4a261b';
    ctx.fillRect(left + w * 0.28, top + h * 0.12, w * 0.44, h * 0.34);
    ctx.fillRect(left + w * 0.26, top + h * 0.04, w * 0.07, h * 0.12);
    ctx.fillRect(left + w * 0.67, top + h * 0.04, w * 0.07, h * 0.12);
    ctx.fillStyle = flash ? '#ff0000' : '#ffce26';
    ctx.fillRect(left + w * 0.34, top + h * 0.22, w * 0.1, h * 0.06);
    ctx.fillRect(left + w * 0.56, top + h * 0.22, w * 0.1, h * 0.06);
  }

  // The co-op buddy: a green marine.
  function drawMarine(cx: number, size: number) {
    const h = Math.min(size, H * 1.4), w = h * 0.5;
    const top = H / 2 - h / 2, left = cx - w / 2;
    ctx.fillStyle = '#3a7d44';
    ctx.fillRect(left + w * 0.2, top + h * 0.4, w * 0.6, h * 0.52);
    ctx.fillRect(left + w * 0.04, top + h * 0.46, w * 0.2, h * 0.32);
    ctx.fillRect(left + w * 0.76, top + h * 0.46, w * 0.2, h * 0.32);
    ctx.fillStyle = '#5fae6a';
    ctx.fillRect(left + w * 0.3, top + h * 0.12, w * 0.4, h * 0.3);
    ctx.fillStyle = '#1d3b22';
    ctx.fillRect(left + w * 0.34, top + h * 0.2, w * 0.32, h * 0.08); // visor
  }

  // A small ammo box that sits on the floor (drawn near the bottom of its screen footprint).
  function drawAmmo(cx: number, size: number) {
    const boxH = Math.min(size, H * 1.4) * 0.28;
    const boxW = boxH * 1.3;
    const bottom = H / 2 + Math.min(size, H * 1.4) / 2; // floor line for this distance
    const top = bottom - boxH;
    const left = cx - boxW / 2;
    ctx.fillStyle = '#3d5a2a'; // olive crate
    ctx.fillRect(left, top, boxW, boxH);
    ctx.fillStyle = '#c8b400'; // yellow band
    ctx.fillRect(left, top + boxH * 0.4, boxW, boxH * 0.22);
    ctx.strokeStyle = '#16210f';
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, boxW, boxH);
  }

  // A health pack (medkit) on the floor: a white box with a red cross.
  function drawHealth(cx: number, size: number) {
    const boxH = Math.min(size, H * 1.4) * 0.3;
    const boxW = boxH;
    const bottom = H / 2 + Math.min(size, H * 1.4) / 2;
    const top = bottom - boxH;
    const left = cx - boxW / 2;
    ctx.fillStyle = '#f4f4f4';
    ctx.fillRect(left, top, boxW, boxH);
    ctx.fillStyle = '#e23b3b'; // red cross
    ctx.fillRect(left + boxW * 0.42, top + boxH * 0.18, boxW * 0.16, boxH * 0.64);
    ctx.fillRect(left + boxW * 0.18, top + boxH * 0.42, boxW * 0.64, boxH * 0.16);
    ctx.strokeStyle = '#999';
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, boxW, boxH);
  }

  function drawGun() {
    const bobX = Math.sin(bob) * 6;
    const bobY = Math.abs(Math.cos(bob)) * 4 + gunRecoil * 22;
    const gx = W / 2 + bobX, gy = H - 30 + bobY;
    ctx.fillStyle = '#3a3a40'; ctx.fillRect(gx - 30, gy, 60, 40);
    ctx.fillStyle = '#222228'; ctx.fillRect(gx - 8, gy - 34, 16, 36);
    ctx.fillStyle = '#52525c'; ctx.fillRect(gx - 34, gy + 14, 12, 26);
    if (muzzle > 0) {
      ctx.fillStyle = '#fff3b0'; ctx.beginPath(); ctx.arc(gx, gy - 34, 16, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ff9d2e'; ctx.beginPath(); ctx.arc(gx, gy - 34, 9, 0, Math.PI * 2); ctx.fill();
    }
  }
  function drawCrosshair() {
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(W / 2 - 5, H / 2, 10, 1);
    ctx.fillRect(W / 2, H / 2 - 5, 1, 10);
  }

  function syncHud() {
    // Leaderboards are visible on the menu and on the game-over screen.
    const showBoards = mode === 'menu' || over === 'dead';
    boards.style.display = showBoards ? 'flex' : 'none';
    if (showBoards) renderBoards();
    if (mode === 'menu' || mode === 'wait') {
      hud.style.display = 'none'; banner.style.display = 'none';
      if (mode === 'menu') menu.style.display = 'flex';
      return;
    }
    const alive = enemies.filter((e) => e.alive).length;
    hud.style.display = 'flex';
    const p = me();
    healthEl.textContent = `♥ ${Math.max(0, Math.round(p.health))}`;
    ammoEl.textContent = `▮ ${p.ammo}${p.grenades > 0 ? `   💣 ${p.grenades}` : ''}`;
    const bossTag = isBossRound(round) ? ' (BOSS BATTLE)' : '';
    killsEl.textContent = betweenTimer > 0 ? `ROUND ${round}${bossTag} ▸` : `ROUND ${round}${bossTag} · ${alive} left`;
    if (over === 'dead') {
      banner.textContent = `GAME OVER\nReached round ${round}\n${mode === 'solo' ? 'press R to retry · ' : ''}ESC to quit`;
      banner.style.color = '#ff2d2d';
      banner.style.fontSize = '40px';
      banner.style.display = 'flex';
    } else if (betweenTimer > 0) {
      banner.textContent = isBossRound(round) ? `ROUND ${round}\nBOSS BATTLE` : `ROUND ${round}`;
      banner.style.color = isBossRound(round) ? '#ffd21e' : '#ffd166';
      banner.style.fontSize = isBossRound(round) ? '44px' : '56px';
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  }

  // --- mode transitions ---
  function startSolo() {
    mode = 'solo'; selfIdx = 0;
    players = [freshPlayer(2.5, 2.5)];
    round = 1; kills = 0; over = null; myAngle = 0; scoreSubmitted = false; betweenTimer = 0;
    drops = []; grenades = []; blasts = [];
    enemies = spawnEnemiesForRound(round, players);
    menu.style.display = 'none';
  }
  function startCoop(slot: number) {
    selfIdx = slot;
    mode = slot === 0 ? 'host' : 'guest';
    players = [freshPlayer(2.5, 2.5), freshPlayer(3.5, 2.5)];
    round = 1; kills = 0; over = null; myAngle = 0; scoreSubmitted = false; betweenTimer = 0;
    drops = []; grenades = []; blasts = [];
    enemies = slot === 0 ? spawnEnemiesForRound(round, players) : [];
    lastGuestFireSeq = 0; lastGuestGrenadeSeq = 0;
    guestIn = { forward: 0, strafe: 0, angle: 0, fireSeq: 0, grenadeSeq: 0 };
    partnerName = '';
    // Tell the host our name so it can record the combined team score on game over.
    if (mode === 'guest') net.relay({ t: 'name', name: net.name() });
    menu.style.display = 'none';
  }
  function restartSolo() {
    if (mode !== 'solo') return;
    startSolo();
  }

  soloBtn.onclick = () => startSolo();
  coopBtn.onclick = () => {
    mode = 'wait';
    menuTitle.textContent = '😈 CO-OP';
    menuMsg.textContent = 'Waiting for a second player… (1/2)';
    soloBtn.style.display = 'none'; coopBtn.style.display = 'none'; cancelWaitBtn.style.display = '';
    net.join();
  };
  cancelWaitBtn.onclick = () => { net.leave(); close(); };

  // --- incoming server messages ---
  handlers = {
    lobby: (m) => {
      if (m.status === 'playing' && m.slot !== null) startCoop(m.slot);
      else if (mode === 'wait') menuMsg.textContent = `Waiting for a second player… (${m.filled}/2)`;
    },
    relay: (d) => {
      const msg = d as { t?: string } & Record<string, unknown>;
      if (mode === 'host' && msg.t === 'name') {
        partnerName = String((msg as { name: unknown }).name ?? '').slice(0, 20);
      } else if (mode === 'host' && msg.t === 'in') {
        guestIn = {
          forward: Number((msg as { forward: number }).forward) || 0,
          strafe: Number((msg as { strafe: number }).strafe) || 0,
          angle: Number((msg as { angle: number }).angle) || 0,
          fireSeq: Number((msg as { fireSeq: number }).fireSeq) || 0,
          grenadeSeq: Number((msg as { grenadeSeq: number }).grenadeSeq) || 0,
        };
      } else if (mode === 'guest' && msg.t === 'st') {
        const st = msg as unknown as {
          players: Player[]; enemies: Array<{ x: number; y: number; alive: boolean; flash: number; boss?: boolean; fritz?: boolean; jsav?: boolean; hpFrac?: number }>;
          drops?: Array<{ x: number; y: number; kind?: 'ammo' | 'health' | 'grenade' }>;
          grenades?: Array<{ x: number; y: number }>;
          blasts?: Array<{ x: number; y: number; t: number }>;
          round: number; between: boolean; over: 'dead' | null;
        };
        players = st.players.map((p) => ({ ...p }));
        // Mirror position/alive/flash + boss flag; store hpFrac as hp/maxHp so the bar reads right.
        enemies = st.enemies.map((e) => ({
          x: e.x, y: e.y, hp: e.hpFrac ?? 1, maxHp: 1, alive: e.alive, flash: e.flash, attackCd: 0, boss: e.boss, fritz: e.fritz, jsav: e.jsav,
        }));
        drops = (st.drops ?? []).map((d) => ({ x: d.x, y: d.y, kind: d.kind ?? 'ammo' }));
        grenades = (st.grenades ?? []).map((g) => ({ x: g.x, y: g.y, vx: 0, vy: 0, fuse: 0 }));
        blasts = (st.blasts ?? []).map((b) => ({ x: b.x, y: b.y, t: b.t }));
        round = st.round; betweenTimer = st.between ? 1 : 0; over = st.over;
        if (over === 'dead' && players[selfIdx] && !players[selfIdx].alive) hurt = Math.max(hurt, 0.2);
      }
    },
    end: (reason) => {
      mode = 'ended';
      banner.textContent = `${reason}\nESC to quit`;
      banner.style.color = '#ff9d2e';
      banner.style.display = 'flex';
      hud.style.display = 'none';
    },
  };

  // --- input ---
  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (k === 'escape') { close(); return; }
    if (k === 'r' && over && mode === 'solo') { restartSolo(); return; }
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd', ' '].includes(k)) {
      e.preventDefault(); e.stopImmediatePropagation();
    }
    // Shooting is mouse-click only; space throws a grenade (once per press, not on key-repeat).
    if (k === ' ' && !e.repeat) throwGrenade();
    keys.add(k);
  };
  const onKeyUp = (e: KeyboardEvent) => { keys.delete(e.key.toLowerCase()); e.stopImmediatePropagation(); };
  const onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement === canvas) myAngle += e.movementX * 0.0026;
  };
  const onMouseDown = () => {
    if (mode === 'menu' || mode === 'wait') return;
    if (document.pointerLockElement !== canvas) { canvas.requestPointerLock(); return; }
    localFire();
  };
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);

  // --- loop + teardown ---
  let raf = 0;
  let last = performance.now();
  let prevBossAlive = false; // edge-detect the minion boss dying to award a coin
  function loop(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (mode !== 'menu' && mode !== 'wait' && mode !== 'ended') update(dt);
    render();
    syncHud();
    syncBossMusic();
    // Award a coin the moment the minion boss dies (each participant gets one).
    const bossAlive = enemies.some((e) => e.boss && e.alive);
    if (prevBossAlive && !bossAlive) net.awardCoin();
    prevBossAlive = bossAlive;
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  function close() {
    if (!doomOpen) return;
    doomOpen = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('mousemove', onMouseMove);
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    if (mode === 'wait' || mode === 'host' || mode === 'guest') net.leave();
    handlers = null;
    bossMusic.pause();
    audio?.close().catch(() => {});
    overlay.remove();
  }
}
