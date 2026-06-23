// Nuketown — a tiny PvP team-deathmatch FPS, launched from tsong as an arcade toy.
//
// Up to 3v3 (six players, two teams) on a small symmetric arena. Like the DOOM minigame it is
// deliberately isolated: its own fullscreen overlay, canvas, input handlers and game loop, all
// torn down on exit. It never touches the Pong game state or shared modules. Loaded lazily the
// first time the player opens it.
//
// Netcode is host-authoritative over a dumb broadcast relay (see server Lobby's nt* methods):
// the server only runs the up-to-6 lobby + opaque fan-out, the actual sim runs here. Slot 0
// (the first joiner) is the host: it simulates EVERY player (its own from local input, the rest
// from their relayed input messages), resolves hitscan/grenades/respawns/scores, and streams
// `{t:'st',...}` snapshots ~20/s. Guests send `{t:'in',...}` input ~30/s and render from the
// host's snapshots. Rendering is a classic Lode-style DDA raycaster at a chunky 320×200, copied
// from doom.ts so DOOM stays untouched.

// A Black-Ops-"Nuketown"-style arena, 180°-rotationally symmetric so neither team has an edge.
// Two facing houses (one per team) with a doorway + windows onto the central yard, a BUS parked
// across the middle that blocks the center lane (forcing left/right flanks), and planter/lane
// cover to fight over in the yards. Tile legend:
//   '.' floor   '1' outer concrete wall   '2' house walls   '3' the bus   '4' cover (planters)
const MAP = [
  '1111111111111111', // 0
  '1..2222222222..1', // 1  RED house — back wall
  '1..2........2..1', // 2  RED house — interior (team 0 spawn)
  '1..2222..2222..1', // 3  RED house — front wall + central doorway
  '1..............1', // 4  yard
  '1...4......4...1', // 5  planters (cover)
  '1.4..........4.1', // 6  side-lane cover
  '1...33333333...1', // 7  the BUS — blocks the center lane (top half)
  '1...33333333...1', // 8  the BUS (bottom half)
  '1.4..........4.1', // 9  side-lane cover
  '1...4......4...1', // 10 planters (cover)
  '1..............1', // 11 yard
  '1..2222..2222..1', // 12 BLUE house — front wall + central doorway
  '1..2........2..1', // 13 BLUE house — interior (team 1 spawn)
  '1..2222222222..1', // 14 BLUE house — back wall
  '1111111111111111', // 15
];
const MAP_W = MAP[0].length;
const MAP_H = MAP.length;
const W = 320;
const H = 200;

// Team spawn points (inside each house, facing the doorway), used for initial placement and
// respawns. Index = team. The doorway in front of each spawn opens toward the central bus.
const SPAWNS = [
  { x: 7.5, y: 2.5 },     // team 0 (red), top house
  { x: 7.5, y: 13.5 },    // team 1 (blue), bottom house
];
const TEAM_COLORS = ['#ff5c5c', '#5c9dff']; // red, blue (HUD + sprite tint)
const TEAM_NAMES = ['RED', 'BLUE'];

// Match rules — first team to TARGET_KILLS, or whoever leads when the timer expires.
const TARGET_KILLS = 30;
const MATCH_SECONDS = 5 * 60;
const RESPAWN_SECONDS = 3;
const HIT_DAMAGE = 34;        // 3 shots to kill a 100-hp player
const MAX_HEALTH = 100;
const START_GRENADES = 2;     // grenades granted each (re)spawn
const AMMO_REGEN_PER_SEC = 6; // generous, arcade-feel ammo regen
const MAX_AMMO = 60;

// Grenade physics (cloned from doom.ts, tuned the same).
const GRENADE_SPEED = 5.5;   // tiles / second
const GRENADE_FUSE = 0.9;    // seconds before detonation (a bit longer than doom for PvP lobs)
const GRENADE_RADIUS = 3;    // blast radius, tiles
const GRENADE_DAMAGE = 75;   // big chunk to enemies caught in the blast

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

// A combatant. The host owns the canonical array; guests mirror it from snapshots. `name`/`team`
// are fixed from the lobby; everything else is simulated.
interface Player {
  slot: number;
  name: string;
  team: number;
  x: number; y: number; angle: number;
  health: number; ammo: number; grenades: number;
  alive: boolean; respawnIn: number; flash: number;
}
interface Grenade { x: number; y: number; vx: number; vy: number; fuse: number; team: number; owner: number; }
interface Blast { x: number; y: number; t: number; }
// Input a guest sends to the host each tick (and the host uses for its own player too).
interface NetInput { forward: number; strafe: number; angle: number; fireSeq: number; grenadeSeq: number; }

// Networking hook into the host websocket (provided by main.ts), mirroring DoomNet.
export interface NuketownNet {
  join(): void;
  leave(): void;
  start(): void;
  relay(data: unknown): void;
  name(): string; // this client's display name
}

// Lobby message shape pushed from the server (matches shared/types NtLobbyMsg).
interface NtLobby {
  status: 'waiting' | 'playing' | 'ended';
  slot: number;
  hostSlot: number;
  players: { name: string; team: number; slot: number }[];
}

// The running instance feeds server messages back to itself through these module-level hooks,
// which main.ts calls when an nt* message arrives.
let handlers: {
  lobby: (m: NtLobby) => void;
  relay: (d: unknown) => void;
} | null = null;
export function feedNtLobby(m: NtLobby) { handlers?.lobby(m); }
export function feedNtRelay(d: unknown) { handlers?.relay(d); }

function escapeText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

let ntOpen = false;

export function startNuketown(net: NuketownNet): void {
  if (ntOpen) return;
  ntOpen = true;

  // 'menu' (chooser) → 'lobby' (joined, waiting) → 'play' (host or guest) ; 'ended' terminal.
  type Mode = 'menu' | 'lobby' | 'play' | 'ended';
  let mode: Mode = 'menu';
  let selfSlot = 0;       // my slot in the lobby (0 = host/authority)
  let isHost = false;     // selfSlot === 0 once playing
  let lobbyState: NtLobby | null = null; // latest lobby snapshot (for the waiting screen + roster)

  // --- DOM (cloned from doom.ts, recoloured for Nuketown) ---
  const overlay = document.createElement('div');
  overlay.id = 'nuketownOverlay';
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

  // Procedurally generated bright daytime sky (built once, blitted each frame) — Nuketown is a
  // sunny test-site map, so a warm blue gradient reads as "outdoors" vs DOOM's night sky.
  const sky = document.createElement('canvas');
  sky.width = W; sky.height = H / 2;
  (() => {
    const sc = sky.getContext('2d')!;
    const grad = sc.createLinearGradient(0, 0, 0, H / 2);
    grad.addColorStop(0, '#4a86c8');
    grad.addColorStop(1, '#bcd6ec');
    sc.fillStyle = grad;
    sc.fillRect(0, 0, W, H / 2);
    // A few soft clouds.
    sc.fillStyle = 'rgba(255,255,255,0.5)';
    for (let i = 0; i < 5; i++) {
      const x = Math.random() * W, y = Math.random() * (H / 2) * 0.8;
      const r = 6 + Math.random() * 10;
      sc.beginPath(); sc.arc(x, y, r, 0, Math.PI * 2); sc.arc(x + r, y + 2, r * 0.8, 0, Math.PI * 2); sc.fill();
    }
  })();

  const hud = document.createElement('div');
  hud.style.cssText =
    'position:absolute;left:0;right:0;bottom:calc(6vh - 6px);display:flex;gap:28px;' +
    'justify-content:center;font:700 22px ui-monospace,monospace;color:#ffd166;' +
    'text-shadow:2px 2px 0 #000;letter-spacing:1px;pointer-events:none;';
  const healthEl = document.createElement('span');
  const ammoEl = document.createElement('span');
  healthEl.style.color = '#ff5c5c';
  hud.append(healthEl, ammoEl);
  overlay.appendChild(hud);

  // Team scoreboard across the top: "RED  4  —  2  BLUE" + a match countdown.
  const scoreBar = document.createElement('div');
  scoreBar.style.cssText =
    'position:absolute;top:10px;left:0;right:0;text-align:center;font:800 20px ui-monospace,monospace;' +
    'text-shadow:2px 2px 0 #000;pointer-events:none;letter-spacing:1px;';
  overlay.appendChild(scoreBar);

  const title = document.createElement('div');
  title.style.cssText =
    'position:absolute;top:40px;left:0;right:0;text-align:center;font:700 12px ui-monospace,monospace;' +
    'color:#9fb0d8;text-shadow:1px 1px 0 #000;pointer-events:none;';
  title.textContent = 'WASD move · mouse/←→ turn · click shoot · space grenade · ESC quit';
  overlay.appendChild(title);

  // A small kill feed (top-right), each line auto-expires.
  const killFeed = document.createElement('div');
  killFeed.style.cssText =
    'position:absolute;top:64px;right:14px;display:flex;flex-direction:column;gap:3px;align-items:flex-end;' +
    'font:700 12px ui-monospace,monospace;text-shadow:1px 1px 0 #000;pointer-events:none;';
  overlay.appendChild(killFeed);
  let feedLines: { html: string; t: number }[] = [];
  function pushFeed(html: string) { feedLines.push({ html, t: 4 }); if (feedLines.length > 5) feedLines.shift(); }

  const banner = document.createElement('div');
  banner.style.cssText =
    'position:absolute;inset:0;display:none;align-items:center;justify-content:center;' +
    'font:900 52px ui-monospace,monospace;color:#ff2d2d;text-shadow:4px 4px 0 #000;' +
    'text-align:center;white-space:pre;pointer-events:none;';
  overlay.appendChild(banner);

  // Menu / lobby layer.
  const menu = document.createElement('div');
  menu.style.cssText =
    'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:safe center;gap:20px;padding:3vh 16px;overflow-y:auto;background:rgba(0,0,0,0.88);';
  const menuTitle = document.createElement('div');
  menuTitle.textContent = '💣 NUKETOWN';
  menuTitle.style.cssText = 'font:900 56px ui-monospace,monospace;color:#ff9d4f;text-shadow:4px 4px 0 #311;';
  const menuMsg = document.createElement('div');
  menuMsg.style.cssText = 'font:700 16px ui-monospace,monospace;color:#9fb0d8;min-height:20px;text-align:center;';
  const menuInfo = document.createElement('div');
  menuInfo.style.cssText =
    'max-width:520px;font:600 13px ui-monospace,monospace;color:#9fb0d8;line-height:1.7;text-align:center;';
  menuInfo.innerHTML =
    '<div style="color:#cdd7f5;font-weight:700;margin-bottom:4px">TEAM DEATHMATCH · up to 3v3</div>' +
    'Join the lobby, then the host starts the match. Two teams — <span style="color:#ff5c5c">RED</span> vs ' +
    '<span style="color:#5c9dff">BLUE</span> — race to <b>' + TARGET_KILLS + ' kills</b> (or lead when the 5-minute clock runs out).' +
    '<div style="margin-top:10px">WASD move · mouse / ←→ turn · click to shoot · <b>SPACE</b> grenade · respawn 3s after a death.</div>';

  const mkBtn = (label: string) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'font:700 20px ui-monospace,monospace;padding:14px 26px;border-radius:8px;cursor:pointer;' +
      'border:1px solid #6a3a22;background:#1f130b;color:#ff9d4f;';
    b.onmouseenter = () => { b.style.background = '#2a1a0e'; };
    b.onmouseleave = () => { b.style.background = '#1f130b'; };
    return b;
  };
  const joinBtn = mkBtn('JOIN');
  const startBtn = mkBtn('START');
  const leaveBtn = mkBtn('LEAVE');
  const exitBtn = mkBtn('EXIT');
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:16px;flex-wrap:wrap;justify-content:center;';
  btnRow.append(joinBtn, startBtn, leaveBtn, exitBtn);

  // Roster: players grouped by team, refreshed from the lobby snapshot.
  const roster = document.createElement('div');
  roster.style.cssText =
    'display:flex;gap:48px;justify-content:center;min-height:90px;font:700 14px ui-monospace,monospace;' +
    'text-shadow:1px 1px 0 #000;';
  menu.append(menuTitle, menuMsg, btnRow, roster, menuInfo);
  overlay.appendChild(menu);

  document.body.appendChild(overlay);

  function renderRoster() {
    const cols = [0, 1].map((team) => {
      const ps = (lobbyState?.players ?? []).filter((p) => p.team === team);
      const items = ps.map((p) =>
        `<div>${escapeText(p.name)}${p.slot === 0 ? ' 👑' : ''}</div>`).join('') ||
        '<div style="color:#6b7796">—</div>';
      return `<div><div style="color:${TEAM_COLORS[team]};margin-bottom:6px">${TEAM_NAMES[team]}</div>${items}</div>`;
    });
    roster.innerHTML = cols.join('');
  }

  // Refresh the menu/lobby controls to match the current lobby state.
  function syncMenuButtons() {
    const inLobby = mode === 'lobby';
    joinBtn.style.display = mode === 'menu' ? '' : 'none';
    exitBtn.style.display = mode === 'menu' ? '' : 'none';
    leaveBtn.style.display = inLobby ? '' : 'none';
    // Only the host (slot 0) may start, and only with ≥2 players present.
    const canStart = inLobby && selfSlot === 0 && (lobbyState?.players.length ?? 0) >= 2;
    startBtn.style.display = inLobby && selfSlot === 0 ? '' : 'none';
    startBtn.disabled = !canStart;
    startBtn.style.opacity = canStart ? '1' : '0.5';
    startBtn.style.cursor = canStart ? 'pointer' : 'default';
    if (mode === 'lobby') {
      const n = lobbyState?.players.length ?? 1;
      menuMsg.textContent = selfSlot === 0
        ? (n >= 2 ? `You are the host — press START when ready (${n}/6).` : `Waiting for players… (${n}/6)`)
        : `In lobby (${n}/6) — waiting for the host to start…`;
    }
  }

  // --- world state ---
  let players: Player[] = [];
  let grenades: Grenade[] = [];
  let blasts: Blast[] = [];
  let scores: [number, number] = [0, 0];
  let matchTime = MATCH_SECONDS; // seconds remaining (host counts down, guests mirror)
  let over: { winner: number } | null = null; // winner team (or -1 for a draw)

  // Host: per-slot tracking of the last processed input edge counters + latest input.
  const guestInputs = new Map<number, NetInput>();
  const lastFireSeq = new Map<number, number>();
  const lastGrenadeSeq = new Map<number, number>();

  // local input / feedback
  const keys = new Set<string>();
  let myAngle = 0;
  let muzzle = 0;
  let hurt = 0;
  let prevHealth = MAX_HEALTH;
  let gunRecoil = 0;
  let bob = 0;
  let myFireSeq = 0;     // counts our shots (guest tells the host via input)
  let myGrenadeSeq = 0;  // counts our grenade throws
  const zBuffer = new Float32Array(W);

  const me = (): Player | undefined => players.find((p) => p.slot === selfSlot);

  // --- audio (cloned from doom.ts) ---
  let audio: AudioContext | null = null;
  const ac = () => (audio ??= new AudioContext());
  function shotSound() {
    try {
      const a = ac();
      const buf = a.createBuffer(1, a.sampleRate * 0.18, a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
      const src = a.createBufferSource(); src.buffer = buf;
      const g = a.createGain(); g.gain.value = 0.3;
      src.connect(g); g.connect(a.destination); src.start();
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

  // --- host sim helpers ---
  function spawnPlayer(p: Player) {
    const s = SPAWNS[p.team] ?? SPAWNS[0];
    // Jitter the spawn a touch so teammates don't stack exactly.
    p.x = s.x + (Math.random() - 0.5) * 0.8;
    p.y = s.y + (Math.random() - 0.5) * 0.8;
    p.angle = p.team === 0 ? 0.78 : 0.78 + Math.PI; // face roughly toward the centre
    p.health = MAX_HEALTH;
    p.ammo = MAX_AMMO;
    p.grenades = START_GRENADES;
    p.alive = true;
    p.respawnIn = 0;
    p.flash = 0;
  }

  // Host: register a kill — bump the killer's team score, queue the victim's respawn, feed it.
  function registerKill(victim: Player, killerTeam: number) {
    if (!victim.alive) return;
    victim.alive = false;
    victim.respawnIn = RESPAWN_SECONDS;
    victim.health = 0;
    if (killerTeam >= 0 && killerTeam !== victim.team) {
      scores[killerTeam]++;
      if (scores[killerTeam] >= TARGET_KILLS && !over) over = { winner: killerTeam };
    }
  }

  // Host hitscan: a shot from p hits the nearest unobstructed ENEMY-team player it's aimed at.
  function fireFrom(p: Player) {
    let best: Player | null = null;
    let bestDist = Infinity;
    for (const e of players) {
      if (!e.alive || e.team === p.team || e === p) continue;
      const dx = e.x - p.x, dy = e.y - p.y;
      const dist = Math.hypot(dx, dy);
      let diff = Math.atan2(dy, dx) - p.angle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const tol = Math.atan2(0.5, dist) + 0.03; // closer targets are easier to hit
      if (Math.abs(diff) > tol) continue;
      if (!losClear(p.x, p.y, e.x, e.y)) continue;
      if (dist < bestDist) { bestDist = dist; best = e; }
    }
    if (best) {
      best.health -= HIT_DAMAGE;
      best.flash = 0.12;
      if (best.health <= 0) {
        registerKill(best, p.team);
        emitKill(p, best, 'gun');
      }
    }
  }

  function spawnGrenade(p: Player) {
    grenades.push({
      x: p.x, y: p.y,
      vx: Math.cos(p.angle) * GRENADE_SPEED, vy: Math.sin(p.angle) * GRENADE_SPEED,
      fuse: GRENADE_FUSE, team: p.team, owner: p.slot,
    });
  }

  // Host: detonate at (x,y) — flash + radius damage to enemy-team players (authority only).
  function explode(g: Grenade) {
    blasts.push({ x: g.x, y: g.y, t: 0.45 });
    boomSound();
    const thrower = players.find((p) => p.slot === g.owner);
    for (const e of players) {
      if (!e.alive || e.team === g.team) continue;
      const d = Math.hypot(e.x - g.x, e.y - g.y);
      if (d <= GRENADE_RADIUS && losClear(g.x, g.y, e.x, e.y)) {
        const falloff = 1 - d / GRENADE_RADIUS; // closer = more damage
        e.health -= GRENADE_DAMAGE * Math.max(0.4, falloff);
        e.flash = 0.15;
        if (e.health <= 0) {
          registerKill(e, g.team);
          if (thrower) emitKill(thrower, e, 'nade');
        }
      }
    }
  }

  // Host: advance live grenades; detonate on a wall or when the fuse runs out.
  function moveGrenades(dt: number) {
    for (let i = grenades.length - 1; i >= 0; i--) {
      const g = grenades[i];
      g.fuse -= dt;
      const nx = g.x + g.vx * dt, ny = g.y + g.vy * dt;
      if (g.fuse <= 0 || isWall(Math.floor(nx), Math.floor(ny))) {
        explode(g);
        grenades.splice(i, 1);
      } else { g.x = nx; g.y = ny; }
    }
  }

  // Host: emit a kill-feed entry to everyone (and show it locally).
  function emitKill(killer: Player, victim: Player, weapon: 'gun' | 'nade') {
    const line = killFeedHtml(killer, victim, weapon);
    pushFeed(line);
    net.relay({ t: 'kill', killer: killer.name, kt: killer.team, victim: victim.name, vt: victim.team, weapon });
  }
  function killFeedHtml(killerName: { name: string; team: number } | Player, victim: { name: string; team: number }, weapon: 'gun' | 'nade') {
    const icon = weapon === 'nade' ? '💣' : '🔫';
    return `<div><span style="color:${TEAM_COLORS[killerName.team]}">${escapeText(killerName.name)}</span>` +
      ` ${icon} <span style="color:${TEAM_COLORS[victim.team]}">${escapeText(victim.name)}</span></div>`;
  }

  function moveWithCollision(p: Player, nx: number, ny: number) {
    const pad = 0.18;
    if (!isWall(Math.floor(nx + Math.sign(nx - p.x) * pad), Math.floor(p.y))) p.x = nx;
    if (!isWall(Math.floor(p.x), Math.floor(ny + Math.sign(ny - p.y) * pad))) p.y = ny;
  }
  function integrate(p: Player, forward: number, strafe: number, dt: number) {
    const dirX = Math.cos(p.angle), dirY = Math.sin(p.angle);
    const sp = 3.2 * dt;
    const nx = p.x + (dirX * forward - dirY * strafe) * sp;
    const ny = p.y + (dirY * forward + dirX * strafe) * sp;
    moveWithCollision(p, nx, ny);
  }

  // Read local keys → a movement intent for the local player.
  function readIntent(dt: number): { forward: number; strafe: number } {
    let forward = 0, strafe = 0;
    if (keys.has('w') || keys.has('arrowup')) forward += 1;
    if (keys.has('s') || keys.has('arrowdown')) forward -= 1;
    if (keys.has('a')) strafe -= 1;
    if (keys.has('d')) strafe += 1;
    if (forward || strafe) bob += dt * 9;
    return { forward, strafe };
  }

  // A shot by the local player (host fires immediately; guest tells the host via input).
  function localFire() {
    const p = me();
    if (over || !p || !p.alive || p.ammo <= 0) return;
    p.ammo--;
    myFireSeq++;
    muzzle = 0.07; gunRecoil = 1;
    shotSound();
    if (isHost) fireFrom(p);
  }
  function throwGrenade() {
    const p = me();
    if (over || !p || !p.alive || p.grenades <= 0) return;
    p.grenades--;
    myGrenadeSeq++;
    if (isHost) spawnGrenade(p);
  }

  // --- update ---
  let netAccum = 0;
  function update(dt: number) {
    if (mode !== 'play') return;
    if (isHost) {
      if (!over) {
        // My player (slot 0) from local input.
        const self = me();
        if (self) {
          self.angle = myAngle;
          const { forward, strafe } = readIntent(dt);
          if (self.alive) integrate(self, forward, strafe, dt);
        }
        if (keys.has('arrowleft')) myAngle -= 2.6 * dt;
        if (keys.has('arrowright')) myAngle += 2.6 * dt;
        // Every other player from their last relayed input.
        for (const p of players) {
          if (p.slot === selfSlot) continue;
          const inp = guestInputs.get(p.slot);
          if (inp) {
            p.angle = inp.angle;
            if (p.alive) integrate(p, inp.forward, inp.strafe, dt);
            const lf = lastFireSeq.get(p.slot) ?? 0;
            if (inp.fireSeq > lf) {
              lastFireSeq.set(p.slot, inp.fireSeq);
              if (p.alive && p.ammo > 0) { p.ammo--; fireFrom(p); }
            }
            const lg = lastGrenadeSeq.get(p.slot) ?? 0;
            if (inp.grenadeSeq > lg) {
              lastGrenadeSeq.set(p.slot, inp.grenadeSeq);
              if (p.alive && p.grenades > 0) { p.grenades--; spawnGrenade(p); }
            }
          }
        }
        moveGrenades(dt);
        // Ammo regen, hit-flash decay, and respawns.
        for (const p of players) {
          if (p.flash > 0) p.flash -= dt;
          if (p.alive) {
            p.ammo = Math.min(MAX_AMMO, p.ammo + AMMO_REGEN_PER_SEC * dt);
          } else {
            p.respawnIn -= dt;
            if (p.respawnIn <= 0) spawnPlayer(p);
          }
        }
        // Match clock + timeout win condition.
        matchTime -= dt;
        if (matchTime <= 0 && !over) {
          matchTime = 0;
          over = { winner: scores[0] === scores[1] ? -1 : (scores[0] > scores[1] ? 0 : 1) };
        }
      }
      // Stream a snapshot to everyone ~20/s.
      netAccum += dt;
      if (netAccum >= 0.05) {
        netAccum = 0;
        net.relay({
          t: 'st',
          players: players.map((p) => ({
            slot: p.slot, name: p.name, team: p.team,
            x: p.x, y: p.y, angle: p.angle, health: Math.round(p.health),
            ammo: Math.round(p.ammo), grenades: p.grenades, alive: p.alive,
            respawnIn: p.respawnIn, flash: p.flash,
          })),
          grenades: grenades.map((g) => ({ x: g.x, y: g.y })),
          blasts: blasts.map((b) => ({ x: b.x, y: b.y, t: b.t })),
          scores, matchTime, over,
        });
      }
    } else {
      // Guest: own only my heading; send input ~30/s, render from host snapshots.
      if (keys.has('arrowleft')) myAngle -= 2.6 * dt;
      if (keys.has('arrowright')) myAngle += 2.6 * dt;
      const { forward, strafe } = readIntent(dt);
      netAccum += dt;
      if (netAccum >= 0.033) {
        netAccum = 0;
        net.relay({ t: 'in', slot: selfSlot, forward, strafe, angle: myAngle, fireSeq: myFireSeq, grenadeSeq: myGrenadeSeq });
      }
    }

    // Flash red whenever my own health drops (covers guests, whose health arrives via snapshot).
    const myHp = me()?.health ?? prevHealth;
    if (myHp < prevHealth) hurt = Math.max(hurt, 0.5);
    prevHealth = myHp;
    // Fade explosion flashes on every client.
    for (let i = blasts.length - 1; i >= 0; i--) { blasts[i].t -= dt; if (blasts[i].t <= 0) blasts.splice(i, 1); }
    // Expire kill-feed lines.
    for (let i = feedLines.length - 1; i >= 0; i--) { feedLines[i].t -= dt; if (feedLines[i].t <= 0) feedLines.splice(i, 1); }
    if (muzzle > 0) muzzle -= dt;
    if (hurt > 0) hurt -= dt;
    if (gunRecoil > 0) gunRecoil = Math.max(0, gunRecoil - dt * 5);
  }

  // --- rendering (from the local player's POV) ---
  function render() {
    if (mode === 'menu' || mode === 'lobby' || mode === 'ended') { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); return; }
    const viewer = me();
    if (!viewer) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); return; }
    const vx = viewer.x, vy = viewer.y;
    const va = isHost ? viewer.angle : myAngle; // guest predicts its own heading

    ctx.drawImage(sky, 0, 0);
    ctx.fillStyle = '#7a6a52'; ctx.fillRect(0, H / 2, W, H / 2); // sandy floor

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
      // Nuketown surfaces: tan concrete ('1'), blue-grey house walls ('2'), school-bus yellow
      // ('3'), green planter cover ('4'), light barriers ('#').
      let r = 150, g = 130, b = 95;
      if (hitChar === '2') { r = 90; g = 100; b = 130; }
      else if (hitChar === '3') { r = 210; g = 170; b = 40; }
      else if (hitChar === '4') { r = 70; g = 120; b = 70; }
      else if (hitChar === '#') { r = 120; g = 120; b = 120; }
      let shade = side === 1 ? 0.66 : 1;
      shade *= Math.max(0.25, Math.min(1, 1.6 / (1 + perp * 0.25)));
      ctx.fillStyle = `rgb(${(r * shade) | 0},${(g * shade) | 0},${(b * shade) | 0})`;
      ctx.fillRect(x, start, 1, end - start + 1);
    }

    // Sprites: enemy + teammate players, grenades, explosions — z-buffer occluded.
    type Spr = { x: number; y: number; kind: 'player' | 'grenade' | 'blast'; team?: number; name?: string; flash?: boolean; t?: number };
    const sprites: Spr[] = [];
    for (const p of players) {
      if (!p.alive || p.slot === selfSlot) continue; // don't draw yourself
      sprites.push({ x: p.x, y: p.y, kind: 'player', team: p.team, name: p.name, flash: p.flash > 0 });
    }
    for (const g of grenades) sprites.push({ x: g.x, y: g.y, kind: 'grenade' });
    for (const b of blasts) sprites.push({ x: b.x, y: b.y, kind: 'blast', t: b.t });

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
      if (d.s.kind !== 'blast' && d.tY >= zBuffer[col]) continue; // blasts draw over walls
      if (d.s.kind === 'player') drawSoldier(screenX, size, d.s.team ?? 0, d.s.name ?? '', d.s.flash ?? false);
      else if (d.s.kind === 'grenade') drawGrenade(screenX, size);
      else if (d.s.kind === 'blast') drawBlast(screenX, size, d.s.t ?? 0);
    }

    drawGun();
    drawCrosshair();
    if (hurt > 0) {
      const a = Math.min(0.65, hurt * 1.6);
      ctx.fillStyle = `rgba(200,0,0,${a * 0.55})`;
      ctx.fillRect(0, 0, W, H);
      const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, W * 0.6);
      vg.addColorStop(0, 'rgba(200,0,0,0)');
      vg.addColorStop(1, `rgba(170,0,0,${a})`);
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);
    }
  }

  // An enemy/teammate soldier: a team-tinted figure with a name label above.
  function drawSoldier(cx: number, size: number, team: number, name: string, flash: boolean) {
    const h = Math.min(size, H * 1.4), w = h * 0.5;
    const top = H / 2 - h / 2, left = cx - w / 2;
    const body = flash ? '#ffffff' : (team === 0 ? '#b53030' : '#3060b5');
    const head = flash ? '#ffdddd' : (team === 0 ? '#d05050' : '#5080d0');
    ctx.fillStyle = body;
    ctx.fillRect(left + w * 0.2, top + h * 0.4, w * 0.6, h * 0.52);
    ctx.fillRect(left + w * 0.04, top + h * 0.46, w * 0.2, h * 0.32);
    ctx.fillRect(left + w * 0.76, top + h * 0.46, w * 0.2, h * 0.32);
    ctx.fillStyle = head;
    ctx.fillRect(left + w * 0.3, top + h * 0.12, w * 0.4, h * 0.3);
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(left + w * 0.34, top + h * 0.2, w * 0.32, h * 0.08); // visor
    // Name label (only when reasonably close / large enough to read).
    if (h > 40 && name) {
      ctx.font = '8px ui-monospace,monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#000';
      ctx.fillText(name, cx + 1, top - 3);
      ctx.fillStyle = TEAM_COLORS[team];
      ctx.fillText(name, cx, top - 4);
    }
  }

  function drawGrenade(cx: number, size: number) {
    const r = Math.max(2, Math.min(size, H * 1.4) * 0.08);
    const cy = H / 2 + Math.min(size, H * 1.4) * 0.2;
    ctx.fillStyle = '#2f3a22';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ff4d1c';
    ctx.fillRect(cx - 1, cy - r - 2, 2, 3);
  }
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

  function fmtClock(s: number): string {
    const m = Math.floor(Math.max(0, s) / 60);
    const sec = Math.floor(Math.max(0, s) % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  function syncHud() {
    if (mode === 'menu' || mode === 'lobby') {
      menu.style.display = 'flex';
      hud.style.display = 'none'; banner.style.display = 'none'; scoreBar.style.display = 'none';
      killFeed.style.display = 'none'; title.style.display = 'none';
      renderRoster();
      syncMenuButtons();
      return;
    }
    menu.style.display = 'none';
    const p = me();
    // Scoreboard + clock.
    scoreBar.style.display = 'block';
    scoreBar.innerHTML =
      `<span style="color:${TEAM_COLORS[0]}">${TEAM_NAMES[0]} ${scores[0]}</span>` +
      `<span style="color:#cdd7f5"> — ${fmtClock(matchTime)} — </span>` +
      `<span style="color:${TEAM_COLORS[1]}">${scores[1]} ${TEAM_NAMES[1]}</span>`;
    // Kill feed.
    killFeed.style.display = 'flex';
    killFeed.innerHTML = feedLines.map((l) => l.html).join('');
    title.style.display = over ? 'none' : 'block';

    if (over) {
      hud.style.display = 'none';
      const myTeam = p?.team ?? 0;
      let head: string, col: string;
      if (over.winner === -1) { head = 'DRAW'; col = '#ffd166'; }
      else if (over.winner === myTeam) { head = 'VICTORY'; col = '#5fd16a'; }
      else { head = 'DEFEAT'; col = '#ff2d2d'; }
      banner.textContent = `${head}\n${TEAM_NAMES[0]} ${scores[0]} — ${scores[1]} ${TEAM_NAMES[1]}\nESC to exit`;
      banner.style.color = col;
      banner.style.fontSize = '44px';
      banner.style.display = 'flex';
      return;
    }

    hud.style.display = 'flex';
    if (p && !p.alive) {
      hud.style.display = 'none';
      banner.textContent = `RESPAWNING…\n${Math.ceil(p.respawnIn)}`;
      banner.style.color = '#ff9d2e';
      banner.style.fontSize = '40px';
      banner.style.display = 'flex';
    } else if (p) {
      banner.style.display = 'none';
      healthEl.textContent = `♥ ${Math.max(0, Math.round(p.health))}`;
      ammoEl.textContent = `▮ ${Math.round(p.ammo)}${p.grenades > 0 ? `   💣 ${p.grenades}` : ''}`;
    }
  }

  // --- mode transitions ---
  function startMatch() {
    mode = 'play';
    isHost = selfSlot === 0;
    over = null;
    scores = [0, 0];
    matchTime = MATCH_SECONDS;
    grenades = []; blasts = []; feedLines = [];
    guestInputs.clear(); lastFireSeq.clear(); lastGrenadeSeq.clear();
    myAngle = 0; myFireSeq = 0; myGrenadeSeq = 0; prevHealth = MAX_HEALTH;
    netAccum = 0;
    // Build the player array from the lobby roster. The host owns canonical positions; guests
    // get a placeholder array immediately so they can render even before the first snapshot.
    players = (lobbyState?.players ?? []).map((lp) => {
      const pl: Player = {
        slot: lp.slot, name: lp.name, team: lp.team,
        x: 0, y: 0, angle: 0, health: MAX_HEALTH, ammo: MAX_AMMO, grenades: START_GRENADES,
        alive: true, respawnIn: 0, flash: 0,
      };
      spawnPlayer(pl);
      return pl;
    });
    if (selfSlot !== 0) myAngle = me()?.angle ?? 0; // guest seeds its heading from spawn
    menu.style.display = 'none';
  }

  joinBtn.onclick = () => {
    mode = 'lobby';
    menuMsg.textContent = 'Joining…';
    net.join();
  };
  startBtn.onclick = () => { if (selfSlot === 0) net.start(); };
  leaveBtn.onclick = () => { net.leave(); lobbyState = null; mode = 'menu'; syncHud(); };
  exitBtn.onclick = () => close();

  // --- incoming server messages ---
  handlers = {
    lobby: (m) => {
      lobbyState = m;
      selfSlot = m.slot;
      if (m.status === 'ended') {
        // Host bailed — bounce everyone back to the menu with a notice.
        mode = 'menu';
        lobbyState = null;
        menuMsg.textContent = 'The host left — match ended.';
        return;
      }
      if (m.status === 'playing' && mode !== 'play') {
        startMatch();
      } else if (m.status === 'waiting' && mode === 'lobby') {
        renderRoster();
        syncMenuButtons();
      }
    },
    relay: (d) => {
      const msg = d as { t?: string } & Record<string, unknown>;
      if (mode !== 'play') return;
      if (isHost && msg.t === 'in') {
        // A guest's input — stash it for this slot; the host loop applies it next tick.
        const slot = Number(msg.slot);
        if (Number.isFinite(slot) && slot !== selfSlot) {
          guestInputs.set(slot, {
            forward: Number(msg.forward) || 0,
            strafe: Number(msg.strafe) || 0,
            angle: Number(msg.angle) || 0,
            fireSeq: Number(msg.fireSeq) || 0,
            grenadeSeq: Number(msg.grenadeSeq) || 0,
          });
        }
      } else if (!isHost && msg.t === 'st') {
        // Host snapshot — mirror the whole world. Keep my own angle local (prediction).
        const st = msg as unknown as {
          players: Player[];
          grenades?: { x: number; y: number }[];
          blasts?: { x: number; y: number; t: number }[];
          scores: [number, number]; matchTime: number; over: { winner: number } | null;
        };
        players = st.players.map((p) => ({ ...p }));
        grenades = (st.grenades ?? []).map((g) => ({ x: g.x, y: g.y, vx: 0, vy: 0, fuse: 0, team: 0, owner: -1 }));
        blasts = (st.blasts ?? []).map((b) => ({ x: b.x, y: b.y, t: b.t }));
        scores = st.scores;
        matchTime = st.matchTime;
        over = st.over;
      } else if (!isHost && msg.t === 'kill') {
        // Host kill-feed entry (guests don't compute kills, just display them).
        pushFeed(killFeedHtml(
          { name: String(msg.killer ?? ''), team: Number(msg.kt) || 0 },
          { name: String(msg.victim ?? ''), team: Number(msg.vt) || 0 },
          msg.weapon === 'nade' ? 'nade' : 'gun',
        ));
      }
    },
  };

  // --- input ---
  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (k === 'escape') { close(); return; }
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
    if (mode !== 'play') return;
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
  function loop(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    render();
    syncHud();
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  function close() {
    if (!ntOpen) return;
    ntOpen = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('mousemove', onMouseMove);
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    if (mode === 'lobby' || mode === 'play') net.leave();
    handlers = null;
    audio?.close().catch(() => {});
    overlay.remove();
  }
}
