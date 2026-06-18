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
}
interface Enemy {
  x: number; y: number; hp: number; alive: boolean; flash: number; attackCd: number;
}
interface GuestInput { forward: number; strafe: number; angle: number; fireSeq: number; }

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

// Survival rounds: each round spawns more (and slightly tougher) enemies at random open
// cells, kept clear of the players' spawn corner.
function enemyCountFor(round: number): number { return 3 + (round - 1) * 2; }
function enemyHpFor(round: number): number { return 2 + Math.floor((round - 1) / 4); }
function enemySpeedFor(round: number): number { return Math.min(1.3 + (round - 1) * 0.1, 2.6); }

function spawnEnemiesForRound(round: number, players: Player[]): Enemy[] {
  const out: Enemy[] = [];
  const n = enemyCountFor(round);
  const hp = enemyHpFor(round);
  let guard = 0;
  while (out.length < n && guard++ < 2000) {
    const mx = 1 + Math.floor(Math.random() * (MAP_W - 2));
    const my = 1 + Math.floor(Math.random() * (MAP_H - 2));
    if (isWall(mx, my)) continue;
    const x = mx + 0.5, y = my + 0.5;
    // keep new enemies a few tiles away from every living player
    if (players.some((p) => p.alive && Math.hypot(p.x - x, p.y - y) < 4)) continue;
    out.push({ x, y, hp, alive: true, flash: 0, attackCd: 0 });
  }
  return out;
}
function freshPlayer(x: number, y: number): Player {
  return { x, y, angle: 0, health: 100, ammo: 60, alive: true, flash: 0 };
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
  title.textContent = 'WASD move · mouse/←→ turn · click shoot · ESC quit';
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
  menu.append(menuTitle, menuMsg, btnRow);
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
      if (best.hp <= 0) { best.alive = false; kills++; deathSound(); }
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
      if (td > 1.1) {
        const sp = enemySpeedFor(round) * dt;
        const dx = (target.x - e.x) / td, dy = (target.y - e.y) / td;
        if (!isWall(Math.floor(e.x + dx * sp), Math.floor(e.y))) e.x += dx * sp;
        if (!isWall(Math.floor(e.x), Math.floor(e.y + dy * sp))) e.y += dy * sp;
      } else if (e.attackCd <= 0) {
        target.health -= 9; e.attackCd = 1.1;
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
      betweenTimer = 2.2;
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
        stepEnemies(dt);
        stepRounds(dt);
      }
      maybeSubmitScore();
      // stream a snapshot to the guest ~20/s
      netAccum += dt;
      if (netAccum >= 0.05) {
        netAccum = 0;
        net.relay({
          t: 'st',
          players: players.map((p) => ({ x: p.x, y: p.y, angle: p.angle, health: p.health, ammo: p.ammo, alive: p.alive, flash: p.flash })),
          enemies: enemies.map((e) => ({ x: e.x, y: e.y, alive: e.alive, flash: e.flash })),
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
        net.relay({ t: 'in', forward, strafe, angle: myAngle, fireSeq: myFireSeq });
      }
      maybeSubmitScore(); // round/over arrive via the host snapshot
    }
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

    ctx.fillStyle = '#2a2a33'; ctx.fillRect(0, 0, W, H / 2);
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

    // Sprites: enemies (imps) + the partner marine, billboarded with z-buffer occlusion.
    const sprites: Array<{ x: number; y: number; kind: 'imp' | 'marine'; flash: boolean }> = [];
    for (const e of enemies) if (e.alive) sprites.push({ x: e.x, y: e.y, kind: 'imp', flash: e.flash > 0 });
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
      if (d.tY >= zBuffer[col]) continue;
      if (d.s.kind === 'imp') drawImp(screenX, size, d.s.flash);
      else drawMarine(screenX, size);
    }

    drawGun();
    drawCrosshair();
    if (hurt > 0) { ctx.fillStyle = `rgba(180,0,0,${Math.min(0.5, hurt * 1.6)})`; ctx.fillRect(0, 0, W, H); }
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
    ammoEl.textContent = `▮ ${p.ammo}`;
    killsEl.textContent = betweenTimer > 0 ? `ROUND ${round} ▸` : `ROUND ${round} · ${alive} left`;
    if (over === 'dead') {
      banner.textContent = `GAME OVER\nReached round ${round}\n${mode === 'solo' ? 'press R to retry · ' : ''}ESC to quit`;
      banner.style.color = '#ff2d2d';
      banner.style.fontSize = '40px';
      banner.style.display = 'flex';
    } else if (betweenTimer > 0) {
      banner.textContent = `ROUND ${round}`;
      banner.style.color = '#ffd166';
      banner.style.fontSize = '56px';
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
    enemies = spawnEnemiesForRound(round, players);
    menu.style.display = 'none';
  }
  function startCoop(slot: number) {
    selfIdx = slot;
    mode = slot === 0 ? 'host' : 'guest';
    players = [freshPlayer(2.5, 2.5), freshPlayer(3.5, 2.5)];
    round = 1; kills = 0; over = null; myAngle = 0; scoreSubmitted = false; betweenTimer = 0;
    enemies = slot === 0 ? spawnEnemiesForRound(round, players) : [];
    lastGuestFireSeq = 0; guestIn = { forward: 0, strafe: 0, angle: 0, fireSeq: 0 };
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
        };
      } else if (mode === 'guest' && msg.t === 'st') {
        const st = msg as unknown as {
          players: Player[]; enemies: Array<{ x: number; y: number; alive: boolean; flash: number }>;
          round: number; between: boolean; over: 'dead' | null;
        };
        players = st.players.map((p) => ({ ...p }));
        // keep enemy hp/attackCd fields the guest doesn't use; just mirror position/alive/flash
        enemies = st.enemies.map((e) => ({ x: e.x, y: e.y, hp: 1, alive: e.alive, flash: e.flash, attackCd: 0 }));
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
    if (k === ' ') localFire();
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
  function loop(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (mode !== 'menu' && mode !== 'wait' && mode !== 'ended') update(dt);
    render();
    syncHud();
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
    audio?.close().catch(() => {});
    overlay.remove();
  }
}
