// The free-roam "World" overworld — client side. A shared Pokémon-style town you walk around
// as a little avatar (name floating above), seeing everyone else in the world live. Buy a car in
// the shop and you can drive it around at ~2× walking speed, with arcade drift. Walk/drive up to
// a building and an in-world prompt lets you enter it: the Arena (the classic tsong game), the
// Casino (roulette), or the Bank (stocks / loans).
//
// Like the other arcade toys (doom.ts / nuketown.ts), it is deliberately self-contained: it
// builds its own fullscreen overlay, canvas, input handlers and animation loop, and tears them
// all down on exit. It never touches the Pong render/state. Loaded lazily on first open.
//
// Networking is client-authoritative: we own our avatar's position (+ heading + driven car when
// in a car), stream it ~15/s, and the server fans everyone's state back to whoever's in the
// world. We render ourselves straight from local input (zero latency), everyone else from the
// latest `world` broadcast (fed in via feedWorld).
//
// Built to grow: a new venue is a WORLD_BUILDINGS entry (shared/types.ts) + a branch in
// enterBuilding() and a draw function here. The map/camera/collision/labels key off shared data.

import {
  WORLD,
  WORLD_AVATAR,
  WORLD_BUILDINGS,
  WorldAvatar,
  WorldBuilding,
  WorldBuildingKind,
  CarSpec,
  carById,
} from '../shared/types';

// What the world needs from the rest of the app. main.ts supplies these (see startWorld call).
export interface WorldNet {
  enter(): void;                 // tell the server we're now in the world
  leave(): void;                 // tell the server we've left
  move(x: number, y: number, a?: number, car?: string | null): void; // stream our state
  name(): string;                // our nickname (for our own label)
  color(): string;               // our avatar color
  selfId(): string;              // our connection id (to skip our own avatar in the broadcast)
  car(): string | null;          // our equipped car id (null = none → can't drive)
  onExit(): void;                // the overlay closed (lets main.ts reset the toggle button)
  enterArena(): void;            // walk into the Arena → return to Pong + join the queue
  openFeature(feature: 'roulette' | 'stocks' | 'loans'): void; // open a Casino/Bank feature
}

// --- module-level controller so feedWorld()/isWorldOpen() can reach the live overlay ---
interface Controller {
  feed(avatars: WorldAvatar[]): void;
  reenter(): void; // re-send worldEnter after a socket reconnect (server forgot us on drop)
}
let controller: Controller | null = null;

export function isWorldOpen(): boolean {
  return controller !== null;
}

/** Push the latest avatar roster (from a `world` server message) into the live overlay. */
export function feedWorld(avatars: WorldAvatar[]): void {
  controller?.feed(avatars);
}

/** Re-assert our presence in the world after a reconnect (the server drops us on socket close). */
export function reenterWorld(): void {
  controller?.reenter();
}

const SPEED = WORLD_AVATAR.speed; // on-foot walk speed
const R = WORLD_AVATAR.r;
const SCALE = 0.8;          // pixels per world unit (camera zoom)
const TRIGGER_PAD = 34;     // how close (world units, beyond the wall) counts as "at the door"
const JOY_DEADZONE = 14;    // screen px of drag before the virtual joystick engages
const CAR_LEN = 52;         // car body length, world units (for drawing + collision feel)
const CAR_WID = 28;         // car body width, world units

// --- the town layout: roads + decorations, computed once and shared by every session ---

interface Rect { x: number; y: number; w: number; h: number }
// Road network (tan strips) connecting the plaza to each building. Tuned to the shared building
// coordinates: a horizontal "main street" spine with spurs up to the Arena and down to the
// Casino / Bank, all crossing the central plaza.
const ROADS: Rect[] = [
  { x: 560, y: 1180, w: 2080, h: 120 }, // main street (spine)
  { x: 1560, y: 630, w: 110, h: 600 },  // spur up to the Arena
  { x: 605, y: 1290, w: 110, h: 200 },  // spur down to the Casino
  { x: 2485, y: 1290, w: 110, h: 200 }, // spur down to the Bank
];
const PLAZA = { x: 1600, y: 1100, r: 240 }; // paved circle + fountain at town center

function pointInRect(px: number, py: number, r: Rect, pad = 0): boolean {
  return px >= r.x - pad && px <= r.x + r.w + pad && py >= r.y - pad && py <= r.y + r.h + pad;
}
function onRoad(px: number, py: number, pad = 0): boolean {
  return ROADS.some((r) => pointInRect(px, py, r, pad));
}
function nearPlaza(px: number, py: number, pad = 0): boolean {
  return Math.hypot(px - PLAZA.x, py - PLAZA.y) <= PLAZA.r + pad;
}
function inAnyBuilding(px: number, py: number, pad = 0): boolean {
  return WORLD_BUILDINGS.some((b) => pointInRect(px, py, b, pad));
}

// Deterministic 0..1 hash so decoration placement is stable across frames/sessions without any
// Math.random (which would make the scenery jitter every repaint).
function hash(i: number, j: number): number {
  let h = (Math.imul(i, 73856093) ^ Math.imul(j, 19349663)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return (h % 1000) / 1000;
}

type Decor = { type: 'tree' | 'bush' | 'flower'; x: number; y: number; s: number };
// Scatter trees/bushes/flowers across the grass on a jittered grid, skipping roads, the plaza and
// building footprints. Decoration is non-solid (you can walk/drift over the grass freely) — only
// buildings and the map border collide, which keeps driving fun.
const DECOR: Decor[] = (() => {
  const out: Decor[] = [];
  const cell = 150;
  for (let gx = 90; gx < WORLD.w - 60; gx += cell) {
    for (let gy = 90; gy < WORLD.h - 60; gy += cell) {
      const x = gx + (hash(gx, gy * 3) - 0.5) * 95;
      const y = gy + (hash(gx * 3, gy) - 0.5) * 95;
      if (inAnyBuilding(x, y, 90) || onRoad(x, y, 30) || nearPlaza(x, y, 30)) continue;
      const r = hash(gx, gy);
      if (r < 0.5) out.push({ type: 'tree', x, y, s: 0.82 + hash(gy, gx) * 0.55 });
      else if (r < 0.68) out.push({ type: 'bush', x, y, s: 0.9 + hash(gy * 2, gx) * 0.4 });
      else if (r < 0.8) out.push({ type: 'flower', x, y, s: 1 });
    }
  }
  return out;
})();

export function startWorld(net: WorldNet): void {
  if (controller) return; // already open

  // --- local avatar state ---
  let selfX = WORLD.spawnX;
  let selfY = WORLD.spawnY;
  let facing = -Math.PI / 2; // radians; on foot = look dir, in car = heading. Start facing "up".
  let others: WorldAvatar[] = [];

  // --- car state ---
  let driving = false;
  let vx = 0, vy = 0; // car velocity, world units / s (drives the drift physics)

  // --- input state ---
  const keys = new Set<string>();
  let joyActive = false;
  let joyOX = 0, joyOY = 0; // joystick origin (screen px)
  let joyCX = 0, joyCY = 0; // joystick current (screen px)
  let dialogOpen = false;   // movement pauses while a building dialog is up
  let nearId: string | null = null; // building the avatar is currently at the door of

  // --- network send throttle ---
  let lastSentX = NaN, lastSentY = NaN, lastSentAt = 0;

  // --- DOM ---
  const overlay = document.createElement('div');
  overlay.id = 'worldOverlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9998;background:#0b1020;overflow:hidden;' +
    'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;touch-action:none;user-select:none;';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
  const ctx = canvas.getContext('2d')!;
  overlay.appendChild(canvas);

  // Top bar: title + live player count + drive toggle + exit.
  const topbar = document.createElement('div');
  topbar.style.cssText =
    'position:absolute;top:0;left:0;right:0;display:flex;align-items:center;gap:12px;' +
    'padding:10px 14px;background:linear-gradient(#0b1020dd,#0b102000);pointer-events:none;';
  const title = document.createElement('div');
  title.innerHTML = '🌍 <b>TSONG WORLD</b> <span style="opacity:.6;font-size:12px">beta</span>';
  title.style.cssText = 'color:#e8eefc;font-size:18px;letter-spacing:.5px;';
  const count = document.createElement('div');
  count.style.cssText = 'color:#8aa0d8;font-size:13px;margin-left:auto;pointer-events:none;';
  const driveBtn = document.createElement('button');
  driveBtn.type = 'button';
  driveBtn.style.cssText =
    'pointer-events:auto;cursor:pointer;background:#243a6b;color:#cfe0ff;border:1px solid #3a558f;' +
    'border-radius:8px;padding:7px 12px;font-size:13px;font-weight:600;';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.textContent = '← Back to Pong';
  backBtn.style.cssText =
    'pointer-events:auto;cursor:pointer;background:#1b2542;color:#cdd8f5;' +
    'border:1px solid #2c3a63;border-radius:8px;padding:7px 12px;font-size:13px;';
  topbar.append(title, count, driveBtn, backBtn);
  overlay.appendChild(topbar);

  // Controls hint (bottom-left).
  const help = document.createElement('div');
  help.style.cssText =
    'position:absolute;left:14px;bottom:12px;color:#7d8cbb;font-size:12px;pointer-events:none;line-height:1.5;';
  overlay.appendChild(help);

  // Door prompt (bottom-center). A real button so tapping works on touch; Enter/E does the same.
  const prompt = document.createElement('button');
  prompt.type = 'button';
  prompt.style.cssText =
    'position:absolute;left:50%;bottom:42px;transform:translateX(-50%);display:none;cursor:pointer;' +
    'background:#e8b84b;color:#1a1408;border:none;border-radius:10px;padding:11px 18px;font-size:15px;' +
    'font-weight:700;box-shadow:0 6px 20px #0008;';
  overlay.appendChild(prompt);

  // Building dialog ("what do you want to do?") — a centered modal over the map.
  const dialog = document.createElement('div');
  dialog.style.cssText =
    'position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:#0008;';
  const dialogBox = document.createElement('div');
  dialogBox.style.cssText =
    'min-width:260px;max-width:90vw;background:#141c33;border:1px solid #2c3a63;border-radius:14px;' +
    'padding:22px;box-shadow:0 16px 50px #000a;text-align:center;';
  dialog.appendChild(dialogBox);
  overlay.appendChild(dialog);

  document.body.appendChild(overlay);

  // --- canvas sizing (DPR-aware) ---
  let cssW = 0, cssH = 0;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = overlay.clientWidth;
    cssH = overlay.clientHeight;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  // --- camera (follows the avatar, clamped to the map; centers if the map < view) ---
  let camX = 0, camY = 0;
  function updateCamera() {
    const viewW = cssW / SCALE;
    const viewH = cssH / SCALE;
    camX = viewW >= WORLD.w ? (WORLD.w - viewW) / 2 : clamp(selfX - viewW / 2, 0, WORLD.w - viewW);
    camY = viewH >= WORLD.h ? (WORLD.h - viewH) / 2 : clamp(selfY - viewH / 2, 0, WORLD.h - viewH);
  }
  const sx = (wx: number) => (wx - camX) * SCALE;
  const sy = (wy: number) => (wy - camY) * SCALE;
  const onScreen = (wx: number, wy: number, m: number) =>
    wx > camX - m && wx < camX + cssW / SCALE + m && wy > camY - m && wy < camY + cssH / SCALE + m;

  // --- collision: keep the avatar/car outside every building rectangle ---
  function resolveCollisions(x: number, y: number, rad: number): { x: number; y: number; hit: boolean } {
    let hit = false;
    for (const b of WORLD_BUILDINGS) {
      const nx = clamp(x, b.x, b.x + b.w);
      const ny = clamp(y, b.y, b.y + b.h);
      const dx = x - nx, dy = y - ny;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rad * rad) continue;
      hit = true;
      if (d2 > 0.0001) {
        const d = Math.sqrt(d2);
        x = nx + (dx / d) * rad;
        y = ny + (dy / d) * rad;
      } else {
        const left = x - b.x, right = b.x + b.w - x, top = y - b.y, bottom = b.y + b.h - y;
        const m = Math.min(left, right, top, bottom);
        if (m === left) x = b.x - rad;
        else if (m === right) x = b.x + b.w + rad;
        else if (m === top) y = b.y - rad;
        else y = b.y + b.h + rad;
      }
    }
    return {
      x: clamp(x, rad, WORLD.w - rad),
      y: clamp(y, rad, WORLD.h - rad),
      hit,
    };
  }

  function distToBuilding(b: WorldBuilding): number {
    const nx = clamp(selfX, b.x, b.x + b.w);
    const ny = clamp(selfY, b.y, b.y + b.h);
    return Math.hypot(selfX - nx, selfY - ny);
  }

  // --- driving ---
  function myCar(): CarSpec | null {
    return carById(net.car());
  }
  function toggleDrive() {
    if (!driving) {
      if (!myCar()) { flashHelp("You don't own a car — buy one in the 🪙 Shop (Cars tab)."); return; }
      driving = true;
      vx = vy = 0;
    } else {
      driving = false;
      vx = vy = 0;
    }
    syncDriveBtn();
  }
  function syncDriveBtn() {
    const car = myCar();
    if (driving) {
      driveBtn.textContent = '🚶 Get out';
    } else {
      driveBtn.textContent = car ? `🚗 Drive ${car.name}` : '🚗 Drive';
    }
    driveBtn.style.opacity = car || driving ? '1' : '0.6';
    updateHelp();
  }

  let helpFlash = '';
  let helpFlashUntil = 0;
  function flashHelp(msg: string) { helpFlash = msg; helpFlashUntil = performance.now() + 2600; updateHelp(); }
  function updateHelp() {
    const now = performance.now();
    if (helpFlash && now < helpFlashUntil) { help.innerHTML = `<span style="color:#ffd166">${helpFlash}</span>`; return; }
    help.innerHTML = driving
      ? 'W/S or ↑/↓ throttle · A/D or ←/→ steer · drag to drive · <b>F</b> get out'
      : 'WASD / arrows or drag to walk · <b>F</b> to drive · <b>Enter</b> at a building';
  }

  // --- building entry ---
  function labelFor(kind: WorldBuildingKind): string {
    switch (kind) {
      case 'arena': return '🏓 Enter the Arena (play tsong)';
      case 'casino': return '🎰 Enter the Casino';
      case 'bank': return '🏦 Enter the Bank';
    }
  }
  function enterBuilding(kind: WorldBuildingKind) {
    if (kind === 'arena') { exit(); net.enterArena(); return; }
    if (kind === 'casino') {
      openDialog('🎰 Casino', 'What are you feeling lucky for?', [
        { label: '🎡 Roulette', onPick: () => { exit(); net.openFeature('roulette'); } },
      ]);
      return;
    }
    if (kind === 'bank') {
      openDialog('🏦 Bank', 'How can we help you today?', [
        { label: '📈 Crypto Market', onPick: () => { exit(); net.openFeature('stocks'); } },
        { label: '💸 Get a Loan', onPick: () => { exit(); net.openFeature('loans'); } },
      ]);
      return;
    }
  }
  function openDialog(heading: string, sub: string, choices: { label: string; onPick: () => void }[]) {
    dialogOpen = true;
    keys.clear(); joyActive = false;
    dialogBox.replaceChildren();
    const h = document.createElement('div');
    h.textContent = heading;
    h.style.cssText = 'font-size:22px;color:#e8eefc;margin-bottom:6px;';
    const s = document.createElement('div');
    s.textContent = sub;
    s.style.cssText = 'font-size:13px;color:#8aa0d8;margin-bottom:18px;';
    dialogBox.append(h, s);
    for (const c of choices) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = c.label;
      b.style.cssText =
        'display:block;width:100%;margin:8px 0;cursor:pointer;background:#21305a;color:#e8eefc;' +
        'border:1px solid #38508f;border-radius:10px;padding:13px;font-size:15px;font-weight:600;';
      b.onmouseenter = () => { b.style.background = '#2c4079'; };
      b.onmouseleave = () => { b.style.background = '#21305a'; };
      b.onclick = c.onPick;
      dialogBox.appendChild(b);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Cancel';
    close.style.cssText =
      'display:block;width:100%;margin-top:10px;cursor:pointer;background:transparent;color:#7c8ab5;' +
      'border:none;padding:8px;font-size:13px;';
    close.onclick = closeDialog;
    dialogBox.appendChild(close);
    dialog.style.display = 'flex';
  }
  function closeDialog() {
    dialogOpen = false;
    dialog.style.display = 'none';
  }
  function triggerNear() {
    if (dialogOpen) return;
    const b = WORLD_BUILDINGS.find((x) => x.id === nearId);
    if (b) enterBuilding(b.kind);
  }
  prompt.onclick = triggerNear;
  driveBtn.onclick = toggleDrive;

  // --- input (capture phase so the main game's global shortcuts don't also fire) ---
  const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
  function onKeyDown(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    if (k === 'escape') {
      e.preventDefault(); e.stopPropagation();
      if (dialogOpen) closeDialog(); else exit();
      return;
    }
    if (dialogOpen) return;
    if (k === 'f') { e.preventDefault(); e.stopPropagation(); toggleDrive(); return; }
    if (k === 'enter' || k === 'e') {
      if (nearId) { e.preventDefault(); e.stopPropagation(); triggerNear(); }
      return;
    }
    if (MOVE_KEYS.has(k)) { keys.add(k); e.preventDefault(); e.stopPropagation(); }
  }
  function onKeyUp(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    if (MOVE_KEYS.has(k)) { keys.delete(k); e.stopPropagation(); }
  }
  function onPointerDown(e: PointerEvent) {
    if (dialogOpen || e.target !== canvas) return;
    joyActive = true;
    joyOX = joyCX = e.clientX;
    joyOY = joyCY = e.clientY;
  }
  function onPointerMove(e: PointerEvent) {
    if (!joyActive) return;
    joyCX = e.clientX; joyCY = e.clientY;
  }
  function onPointerUp() { joyActive = false; }

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  backBtn.onclick = exit;

  // --- main loop ---
  let raf = 0;
  let last = performance.now();
  function loop(now: number) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (helpFlash && now >= helpFlashUntil) { helpFlash = ''; updateHelp(); }

    if (!dialogOpen) {
      const car = driving ? myCar() : null;
      if (car) stepCar(car, dt);
      else stepFoot(dt);
    }

    updateNearBuilding();
    maybeSendMove(now);
    updateCamera();
    render(now / 1000);
    raf = requestAnimationFrame(loop);
  }

  // Walk: 8-direction movement at a constant speed.
  function stepFoot(dt: number) {
    let dx = 0, dy = 0;
    if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
    if (keys.has('d') || keys.has('arrowright')) dx += 1;
    if (keys.has('w') || keys.has('arrowup')) dy -= 1;
    if (keys.has('s') || keys.has('arrowdown')) dy += 1;
    if (dx === 0 && dy === 0 && joyActive) {
      const jx = joyCX - joyOX, jy = joyCY - joyOY;
      if (Math.hypot(jx, jy) > JOY_DEADZONE) { dx = jx; dy = jy; }
    }
    const mag = Math.hypot(dx, dy);
    if (mag === 0) return;
    dx /= mag; dy /= mag;
    facing = Math.atan2(dy, dx);
    const moved = resolveCollisions(selfX + dx * SPEED * dt, selfY + dy * SPEED * dt, R);
    selfX = moved.x; selfY = moved.y;
  }

  // Drive: arcade physics with drift. Throttle accelerates along the heading; steering rotates the
  // heading (more authority the faster you go); the velocity's sideways component is bled off by
  // the car's grip each frame — low grip = long slides (drift), high grip = it sticks.
  function stepCar(car: CarSpec, dt: number) {
    let throttle = 0, steer = 0;
    if (keys.has('w') || keys.has('arrowup')) throttle += 1;
    if (keys.has('s') || keys.has('arrowdown')) throttle -= 1;
    if (keys.has('a') || keys.has('arrowleft')) steer -= 1;
    if (keys.has('d') || keys.has('arrowright')) steer += 1;
    if (joyActive) {
      const jx = joyCX - joyOX, jy = joyCY - joyOY;
      if (Math.hypot(jx, jy) > JOY_DEADZONE) {
        throttle += clamp(-jy / 60, -1, 1); // push up = forward
        steer += clamp(jx / 60, -1, 1);     // push right = steer right
      }
    }
    throttle = clamp(throttle, -1, 1);
    steer = clamp(steer, -1, 1);

    const sp = Math.hypot(vx, vy);
    // Steering needs speed to bite; near-stationary you can barely turn.
    const authority = Math.min(1, sp / 120);
    facing += steer * car.turn * authority * dt;

    const hx = Math.cos(facing), hy = Math.sin(facing);
    // Accelerate along the heading (reverse at 60% power).
    const power = throttle >= 0 ? car.accel : car.accel * 0.6;
    vx += hx * power * throttle * dt;
    vy += hy * power * throttle * dt;

    // Split velocity into forward (along heading) + lateral (sideways) and bleed the lateral part
    // off by grip — this is what makes the car drift instead of moving like an air-hockey puck.
    let fwd = vx * hx + vy * hy;
    let lat = -vx * hy + vy * hx;
    const k = Math.pow(car.grip, dt * 60); // grip applied per ~frame, dt-correct
    lat *= k;
    fwd *= Math.pow(0.99, dt * 60);        // mild rolling drag
    fwd = clamp(fwd, -car.speed * 0.5, car.speed);
    vx = hx * fwd - hy * lat;
    vy = hy * fwd + hx * lat;

    const moved = resolveCollisions(selfX + vx * dt, selfY + vy * dt, CAR_WID * 0.5);
    if (moved.hit) { vx *= 0.3; vy *= 0.3; } // crunch into a wall → kill most momentum
    selfX = moved.x; selfY = moved.y;
  }

  function updateNearBuilding() {
    let best: string | null = null;
    let bestD = Infinity;
    for (const b of WORLD_BUILDINGS) {
      const d = distToBuilding(b);
      const reach = (driving ? CAR_LEN * 0.5 : R) + TRIGGER_PAD;
      if (d <= reach && d < bestD) { bestD = d; best = b.id; }
    }
    if (best !== nearId) {
      nearId = best;
      const b = best ? WORLD_BUILDINGS.find((x) => x.id === best) : null;
      prompt.textContent = b ? labelFor(b.kind) : '';
    }
    prompt.style.display = nearId && !dialogOpen ? 'block' : 'none';
  }

  function maybeSendMove(now: number) {
    if (now - lastSentAt < 66) return; // ~15 Hz cap
    if (Math.abs(selfX - lastSentX) < 0.5 && Math.abs(selfY - lastSentY) < 0.5) return;
    lastSentX = selfX; lastSentY = selfY; lastSentAt = now;
    net.move(selfX, selfY, driving ? facing : undefined, driving ? net.car() : null);
  }

  // --- rendering ---
  function render(t: number) {
    ctx.clearRect(0, 0, cssW, cssH);

    // Grass base + a soft checker so movement reads.
    ctx.fillStyle = '#3f8a4a';
    ctx.fillRect(0, 0, cssW, cssH);
    const tile = 80;
    const tx0 = Math.floor(camX / tile), ty0 = Math.floor(camY / tile);
    for (let i = tx0; i * tile < camX + cssW / SCALE; i++) {
      for (let j = ty0; j * tile < camY + cssH / SCALE; j++) {
        if (((i + j) & 1) === 0) {
          ctx.fillStyle = '#46974f';
          ctx.fillRect(sx(i * tile), sy(j * tile), tile * SCALE + 1, tile * SCALE + 1);
        }
      }
    }

    drawRoads();
    drawPlaza(t);

    // Decorations behind buildings/avatars (only what's on screen).
    for (const d of DECOR) {
      if (!onScreen(d.x, d.y, 80)) continue;
      if (d.type === 'tree') drawTree(d.x, d.y, d.s);
      else if (d.type === 'bush') drawBush(d.x, d.y, d.s);
      else drawFlower(d.x, d.y);
    }

    // Map border fence.
    ctx.strokeStyle = '#2c5d36';
    ctx.lineWidth = 8;
    ctx.strokeRect(sx(0), sy(0), WORLD.w * SCALE, WORLD.h * SCALE);

    for (const b of WORLD_BUILDINGS) {
      if (onScreen(b.x + b.w / 2, b.y + b.h / 2, Math.max(b.w, b.h))) drawBuilding(b, t);
    }

    // Avatars: everyone else first, then us on top.
    const selfId = net.selfId();
    for (const a of others) {
      if (a.id === selfId) continue;
      if (!onScreen(a.x, a.y, 120)) continue;
      if (a.car) drawCar(a.x, a.y, a.a ?? 0, carById(a.car), a.name, false, a.color);
      else drawAvatar(a.x, a.y, a.color, a.name, false, 0);
    }
    if (driving) drawCar(selfX, selfY, facing, myCar(), net.name() || 'you', true, net.color());
    else drawAvatar(selfX, selfY, net.color(), net.name() || 'you', true, facing);

    // Virtual joystick.
    if (joyActive) {
      ctx.strokeStyle = '#ffffff44';
      ctx.fillStyle = '#ffffff22';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(joyOX, joyOY, 34, 0, Math.PI * 2); ctx.stroke();
      const jx = joyCX - joyOX, jy = joyCY - joyOY;
      const m = Math.hypot(jx, jy) || 1;
      const cap = Math.min(m, 34);
      ctx.beginPath(); ctx.arc(joyOX + (jx / m) * cap, joyOY + (jy / m) * cap, 16, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawRoads() {
    for (const r of ROADS) {
      ctx.fillStyle = '#b8a37e';
      ctx.fillRect(sx(r.x), sy(r.y), r.w * SCALE, r.h * SCALE);
      ctx.strokeStyle = '#9c8763';
      ctx.lineWidth = 3;
      ctx.strokeRect(sx(r.x), sy(r.y), r.w * SCALE, r.h * SCALE);
      // Dashed centre line down the long axis.
      ctx.strokeStyle = '#fff6d6';
      ctx.lineWidth = 3;
      ctx.setLineDash([14, 16]);
      ctx.beginPath();
      if (r.w >= r.h) { ctx.moveTo(sx(r.x), sy(r.y + r.h / 2)); ctx.lineTo(sx(r.x + r.w), sy(r.y + r.h / 2)); }
      else { ctx.moveTo(sx(r.x + r.w / 2), sy(r.y)); ctx.lineTo(sx(r.x + r.w / 2), sy(r.y + r.h)); }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function drawPlaza(t: number) {
    const cx = sx(PLAZA.x), cy = sy(PLAZA.y), r = PLAZA.r * SCALE;
    ctx.fillStyle = '#cdbd9b';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#b3a17c'; ctx.lineWidth = 4; ctx.stroke();
    // Fountain.
    ctx.fillStyle = '#8aa6c8';
    ctx.beginPath(); ctx.arc(cx, cy, 46 * SCALE, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#cfe6ff';
    ctx.beginPath(); ctx.arc(cx, cy, 30 * SCALE, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#9fc2e8';
    const jets = 6;
    for (let i = 0; i < jets; i++) {
      const a = (i / jets) * Math.PI * 2 + t;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * 16 * SCALE, cy + Math.sin(a) * 16 * SCALE, (3 + Math.sin(t * 4 + i) * 1.5) * SCALE + 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawTree(wx: number, wy: number, s: number) {
    const x = sx(wx), y = sy(wy), sc = SCALE * s;
    ctx.fillStyle = '#00000022';
    ctx.beginPath(); ctx.ellipse(x, y + 18 * sc, 22 * sc, 8 * sc, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#6b4a2b';
    ctx.fillRect(x - 4 * sc, y, 8 * sc, 22 * sc);
    ctx.fillStyle = '#2f7d3f';
    for (const [ox, oy, rr] of [[0, -20, 22], [-14, -10, 16], [14, -10, 16], [0, -4, 18]] as const) {
      ctx.beginPath(); ctx.arc(x + ox * sc, y + oy * sc, rr * sc, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#3a9750';
    ctx.beginPath(); ctx.arc(x - 6 * sc, y - 18 * sc, 10 * sc, 0, Math.PI * 2); ctx.fill();
  }
  function drawBush(wx: number, wy: number, s: number) {
    const x = sx(wx), y = sy(wy), sc = SCALE * s;
    ctx.fillStyle = '#2f7d3f';
    for (const [ox, rr] of [[-10, 11], [0, 14], [10, 11]] as const) {
      ctx.beginPath(); ctx.arc(x + ox * sc, y, rr * sc, 0, Math.PI * 2); ctx.fill();
    }
  }
  function drawFlower(wx: number, wy: number) {
    const x = sx(wx), y = sy(wy), sc = SCALE;
    const colors = ['#ff6b6b', '#ffd166', '#cc8cff', '#7ee0ff'];
    const col = colors[Math.floor(hash(Math.round(wx), Math.round(wy)) * colors.length)];
    ctx.fillStyle = col;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ctx.beginPath(); ctx.arc(x + Math.cos(a) * 4 * sc, y + Math.sin(a) * 4 * sc, 3 * sc, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#ffe066';
    ctx.beginPath(); ctx.arc(x, y, 2.5 * sc, 0, Math.PI * 2); ctx.fill();
  }

  // --- buildings (distinct architecture per kind) ---
  function drawBuilding(b: WorldBuilding, t: number) {
    const x = sx(b.x), y = sy(b.y), w = b.w * SCALE, h = b.h * SCALE;
    const near = b.id === nearId;
    ctx.fillStyle = '#00000044';
    ctx.fillRect(x + 8, y + 12, w, h);
    if (b.kind === 'arena') drawArena(b, x, y, w, h, t);
    else if (b.kind === 'casino') drawCasino(b, x, y, w, h, t);
    else drawBank(b, x, y, w, h);
    if (near) {
      ctx.strokeStyle = '#ffe08a'; ctx.lineWidth = 5;
      ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
    }
    // Sign over the door.
    ctx.font = '800 16px system-ui,sans-serif';
    ctx.textBaseline = 'alphabetic';
    label(b.name, x + w / 2, y - 10, '#0009', '#fff');
  }

  function drawArena(_b: WorldBuilding, x: number, y: number, w: number, h: number, _t: number) {
    // Stadium: rounded bowl, green field with a centre net, two light towers.
    ctx.fillStyle = '#3a4ea8';
    roundRect(x, y, w, h, 22); ctx.fill();
    ctx.fillStyle = '#2c3c84';
    roundRect(x + 8, y + 8, w - 16, h * 0.32, 14); ctx.fill();
    // Field.
    ctx.fillStyle = '#2f8f55';
    ctx.beginPath(); ctx.ellipse(x + w / 2, y + h * 0.62, w * 0.36, h * 0.26, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#eaffea'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x + w / 2, y + h * 0.40); ctx.lineTo(x + w / 2, y + h * 0.84); ctx.stroke();
    // Light towers (post + glowing lamp head).
    for (const lx of [x + 14, x + w - 22]) {
      ctx.fillStyle = '#dfe6f5';
      ctx.fillRect(lx, y - 14, 8, 18);
      ctx.fillStyle = '#fff3bf';
      ctx.fillRect(lx - 6, y - 22, 20, 10);
    }
    // 🏓 glyph.
    ctx.font = `${Math.round(Math.min(w, h) * 0.3)}px serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🏓', x + w / 2, y + h * 0.62);
  }

  function drawCasino(_b: WorldBuilding, x: number, y: number, w: number, h: number, t: number) {
    ctx.fillStyle = '#a8323a';
    roundRect(x, y, w, h, 14); ctx.fill();
    // Dark marquee band.
    ctx.fillStyle = '#5e1820';
    ctx.fillRect(x + 6, y + 6, w - 12, h * 0.26);
    // Chasing bulbs around the marquee.
    const bulbs = Math.max(8, Math.floor(w / 26));
    for (let i = 0; i < bulbs; i++) {
      const on = (Math.floor(t * 6) + i) % 2 === 0;
      ctx.fillStyle = on ? '#ffe066' : '#7a5a14';
      const bx = x + 12 + (i / (bulbs - 1)) * (w - 24);
      ctx.beginPath(); ctx.arc(bx, y + 12, 3.5, 0, Math.PI * 2); ctx.fill();
    }
    // Neon "777".
    ctx.fillStyle = '#ffd34d';
    ctx.font = `800 ${Math.round(h * 0.16)}px system-ui,sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🎰 777', x + w / 2, y + h * 0.19);
    // Doors.
    ctx.fillStyle = '#2a0e12';
    ctx.fillRect(x + w / 2 - 22, y + h - 46, 44, 46);
    ctx.font = `${Math.round(Math.min(w, h) * 0.26)}px serif`;
    ctx.fillText('🎲', x + w * 0.28, y + h * 0.62);
    ctx.fillText('🃏', x + w * 0.72, y + h * 0.62);
  }

  function drawBank(_b: WorldBuilding, x: number, y: number, w: number, h: number) {
    // Marble neoclassical block with a pediment and columns.
    ctx.fillStyle = '#e8e6da';
    ctx.fillRect(x, y + h * 0.2, w, h * 0.8);
    // Pediment.
    ctx.fillStyle = '#2f7d4f';
    ctx.beginPath();
    ctx.moveTo(x - 6, y + h * 0.22); ctx.lineTo(x + w / 2, y - 6); ctx.lineTo(x + w + 6, y + h * 0.22);
    ctx.closePath(); ctx.fill();
    // Columns.
    ctx.fillStyle = '#cfccbe';
    const cols = 5;
    for (let i = 0; i < cols; i++) {
      const cx = x + 18 + (i / (cols - 1)) * (w - 36);
      ctx.fillRect(cx - 6, y + h * 0.28, 12, h * 0.62);
    }
    // Steps.
    ctx.fillStyle = '#bdb9a8';
    ctx.fillRect(x - 4, y + h - 12, w + 8, 12);
    // $ marker.
    ctx.fillStyle = '#1f5e3a';
    ctx.font = `800 ${Math.round(h * 0.16)}px system-ui,sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🏦 $', x + w / 2, y + h * 0.12);
  }

  // --- avatars + cars ---
  function drawAvatar(wx: number, wy: number, color: string, name: string, isSelf: boolean, face: number) {
    const x = sx(wx), y = sy(wy), r = R * SCALE;
    ctx.fillStyle = '#0005';
    ctx.beginPath(); ctx.ellipse(x, y + r * 0.7, r * 0.9, r * 0.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = isSelf ? 3 : 2;
    ctx.strokeStyle = isSelf ? '#fff' : '#0007';
    ctx.stroke();
    if (isSelf) {
      ctx.fillStyle = '#1a1a1a';
      const ex = Math.cos(face) * r * 0.4, ey = Math.sin(face) * r * 0.4;
      const px = -Math.sin(face) * r * 0.32, py = Math.cos(face) * r * 0.32;
      ctx.beginPath(); ctx.arc(x + ex + px, y + ey + py, r * 0.13, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + ex - px, y + ey - py, r * 0.13, 0, Math.PI * 2); ctx.fill();
    }
    ctx.font = '700 13px system-ui,sans-serif';
    label(name, x, y - r - 7, isSelf ? '#1b2542cc' : '#000a', isSelf ? '#ffe08a' : '#fff');
  }

  function drawCar(wx: number, wy: number, angle: number, spec: CarSpec | null, name: string, isSelf: boolean, fallback: string) {
    const x = sx(wx), y = sy(wy);
    const body = spec?.body ?? fallback;
    const accent = spec?.accent ?? '#222';
    const L = CAR_LEN * SCALE, W = CAR_WID * SCALE;
    // Shadow (unrotated, on the ground).
    ctx.fillStyle = '#0005';
    ctx.beginPath(); ctx.ellipse(x, y + 5, L * 0.55, W * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    // Wheels.
    ctx.fillStyle = '#15171c';
    for (const [wxo, wyo] of [[-L * 0.28, -W * 0.5], [L * 0.28, -W * 0.5], [-L * 0.28, W * 0.5], [L * 0.28, W * 0.5]] as const) {
      ctx.fillRect(wxo - 5, wyo - 3, 10, 6);
    }
    // Body.
    ctx.fillStyle = body;
    roundRect(-L / 2, -W / 2, L, W, 7); ctx.fill();
    ctx.strokeStyle = isSelf ? '#fff' : '#0007'; ctx.lineWidth = isSelf ? 2.5 : 1.5; ctx.stroke();
    // Roof / cabin.
    ctx.fillStyle = accent;
    roundRect(-L * 0.12, -W * 0.34, L * 0.4, W * 0.68, 4); ctx.fill();
    // Windshield.
    ctx.fillStyle = '#bfe0ff';
    roundRect(L * 0.16, -W * 0.28, L * 0.12, W * 0.56, 3); ctx.fill();
    // Headlights (front = +x).
    ctx.fillStyle = '#fff7c2';
    ctx.beginPath(); ctx.arc(L * 0.46, -W * 0.32, 3, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(L * 0.46, W * 0.32, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // Name above (unrotated).
    ctx.font = '700 13px system-ui,sans-serif';
    label(name, x, y - W * 0.5 - 12, isSelf ? '#1b2542cc' : '#000a', isSelf ? '#ffe08a' : '#fff');
  }

  function label(text: string, cx: number, baselineY: number, bg: string, fg = '#fff') {
    ctx.textAlign = 'center';
    const w = ctx.measureText(text).width;
    const padX = 6, h = 18;
    ctx.fillStyle = bg;
    roundRect(cx - w / 2 - padX, baselineY - 13, w + padX * 2, h, 5); ctx.fill();
    ctx.fillStyle = fg;
    ctx.fillText(text, cx, baselineY);
  }
  function roundRect(x: number, y: number, w: number, h: number, r: number) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  // --- teardown ---
  function exit() {
    if (!controller) return;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    canvas.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    overlay.remove();
    controller = null;
    net.leave();
    net.onExit();
  }

  controller = {
    feed(avatars) {
      others = avatars;
      const n = avatars.length;
      count.textContent = n === 1 ? '1 player here' : `${n} players here`;
    },
    reenter() { net.enter(); },
  };
  syncDriveBtn();
  net.enter();
  raf = requestAnimationFrame(loop);
}

// --- small helpers ---
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
