// The free-roam "World" overworld — client side. A shared top-down town you walk around as a
// little avatar with your name floating above; everyone else in the world walks around too.
// Walk up to a building and an in-world prompt lets you enter it: the Arena (the classic tsong
// game), the Casino (roulette), or the Bank (stocks / loans).
//
// Like the other arcade toys (doom.ts / nuketown.ts), it is deliberately self-contained: it
// builds its own fullscreen overlay, canvas, input handlers and animation loop, and tears them
// all down on exit. It never touches the Pong render/state. Loaded lazily the first time the
// player opens the world.
//
// Networking is dead simple and client-authoritative: we own our avatar's position, stream it
// to the server (~15/s, only when it changes), and the server fans everyone's positions back to
// whoever's in the world. We render our own avatar straight from local input (zero latency) and
// everyone else from the latest `world` broadcast (fed in via feedWorld).
//
// Built to grow: a new venue is a WORLD_BUILDINGS entry (shared/types.ts) plus a branch in
// enterBuilding() below. The map, camera, collision and labels all key off that shared table,
// so cars/houses/etc. later need no new plumbing.

import {
  WORLD,
  WORLD_AVATAR,
  WORLD_BUILDINGS,
  WorldAvatar,
  WorldBuildingKind,
} from '../shared/types';

// What the world needs from the rest of the app. main.ts supplies these (see startWorld call).
export interface WorldNet {
  enter(): void;                 // tell the server we're now in the world
  leave(): void;                 // tell the server we've left
  move(x: number, y: number): void; // stream our avatar position (world units)
  name(): string;                // our nickname (for our own label)
  color(): string;               // our avatar color
  selfId(): string;              // our connection id (to skip our own avatar in the broadcast)
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

const SPEED = WORLD_AVATAR.speed;
const R = WORLD_AVATAR.r;
const SCALE = 0.8;            // pixels per world unit (camera zoom)
const TRIGGER_PAD = 30;       // how close (world units, beyond the wall) counts as "at the door"
const JOY_DEADZONE = 14;      // screen px of drag before the virtual joystick engages

export function startWorld(net: WorldNet): void {
  if (controller) return; // already open

  // --- local avatar state ---
  let selfX = WORLD.spawnX;
  let selfY = WORLD.spawnY;
  let facing = -Math.PI / 2; // radians; start facing "up" toward the arena
  let others: WorldAvatar[] = [];

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

  // Top bar: title + live player count + exit.
  const topbar = document.createElement('div');
  topbar.style.cssText =
    'position:absolute;top:0;left:0;right:0;display:flex;align-items:center;gap:12px;' +
    'padding:10px 14px;background:linear-gradient(#0b1020dd,#0b102000);pointer-events:none;';
  const title = document.createElement('div');
  title.innerHTML = '🌍 <b>TSONG WORLD</b> <span style="opacity:.6;font-size:12px">beta</span>';
  title.style.cssText = 'color:#e8eefc;font-size:18px;letter-spacing:.5px;';
  const count = document.createElement('div');
  count.style.cssText = 'color:#8aa0d8;font-size:13px;margin-left:auto;pointer-events:none;';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.textContent = '← Back to Pong';
  backBtn.style.cssText =
    'pointer-events:auto;cursor:pointer;background:#1b2542;color:#cdd8f5;' +
    'border:1px solid #2c3a63;border-radius:8px;padding:7px 12px;font-size:13px;';
  topbar.append(title, count, backBtn);
  overlay.appendChild(topbar);

  // Controls hint (bottom-left).
  const help = document.createElement('div');
  help.textContent = 'WASD / arrows or drag to walk';
  help.style.cssText =
    'position:absolute;left:14px;bottom:12px;color:#6b7aa8;font-size:12px;pointer-events:none;';
  overlay.appendChild(help);

  // Door prompt (bottom-center) — shown when standing at a building. It's a real button so a tap
  // works on touch; on desktop, Enter/E does the same thing.
  const prompt = document.createElement('button');
  prompt.type = 'button';
  prompt.style.cssText =
    'position:absolute;left:50%;bottom:40px;transform:translateX(-50%);display:none;cursor:pointer;' +
    'background:#e8b84b;color:#1a1408;border:none;border-radius:10px;padding:11px 18px;font-size:15px;' +
    'font-weight:700;box-shadow:0 6px 20px #0008;';
  overlay.appendChild(prompt);

  // Building dialog ("what do you want to do?") — a centered modal over the map.
  const dialog = document.createElement('div');
  dialog.style.cssText =
    'position:absolute;inset:0;display:none;align-items:center;justify-content:center;' +
    'background:#0008;backdrop-filter:blur(2px);';
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

  // --- camera (follows the avatar, clamped to the map; centers if the map is smaller than view) ---
  let camX = 0, camY = 0;
  function updateCamera() {
    const viewW = cssW / SCALE;
    const viewH = cssH / SCALE;
    camX = viewW >= WORLD.w ? (WORLD.w - viewW) / 2 : clamp(selfX - viewW / 2, 0, WORLD.w - viewW);
    camY = viewH >= WORLD.h ? (WORLD.h - viewH) / 2 : clamp(selfY - viewH / 2, 0, WORLD.h - viewH);
  }
  const sx = (wx: number) => (wx - camX) * SCALE;
  const sy = (wy: number) => (wy - camY) * SCALE;

  // --- collision: keep a circle of radius R outside every building rectangle ---
  function resolveCollisions(x: number, y: number): { x: number; y: number } {
    for (const b of WORLD_BUILDINGS) {
      const nx = clamp(x, b.x, b.x + b.w);
      const ny = clamp(y, b.y, b.y + b.h);
      const dx = x - nx, dy = y - ny;
      const d2 = dx * dx + dy * dy;
      if (d2 >= R * R) continue;
      if (d2 > 0.0001) {
        const d = Math.sqrt(d2);
        x = nx + (dx / d) * R;
        y = ny + (dy / d) * R;
      } else {
        // Center is inside the rect (shouldn't normally happen) — eject out the nearest edge.
        const left = x - b.x, right = b.x + b.w - x, top = y - b.y, bottom = b.y + b.h - y;
        const m = Math.min(left, right, top, bottom);
        if (m === left) x = b.x - R;
        else if (m === right) x = b.x + b.w + R;
        else if (m === top) y = b.y - R;
        else y = b.y + b.h + R;
      }
    }
    return {
      x: clamp(x, R, WORLD.w - R),
      y: clamp(y, R, WORLD.h - R),
    };
  }

  // Distance from the avatar center to a building rectangle (0 if touching/inside).
  function distToBuilding(b: typeof WORLD_BUILDINGS[number]): number {
    const nx = clamp(selfX, b.x, b.x + b.w);
    const ny = clamp(selfY, b.y, b.y + b.h);
    return Math.hypot(selfX - nx, selfY - ny);
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
    if (kind === 'arena') {
      // Straight into a game: close the world, switch to Pong, join the queue.
      exit();
      net.enterArena();
      return;
    }
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

  // --- input handlers (capture phase so the main game's global shortcuts don't also fire) ---
  const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
  function onKeyDown(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    if (k === 'escape') {
      e.preventDefault(); e.stopPropagation();
      if (dialogOpen) closeDialog(); else exit();
      return;
    }
    if (dialogOpen) return;
    if (k === 'enter' || k === 'e') {
      if (nearId) { e.preventDefault(); e.stopPropagation(); triggerNear(); }
      return;
    }
    if (MOVE_KEYS.has(k)) {
      keys.add(k);
      e.preventDefault(); e.stopPropagation();
    }
  }
  function onKeyUp(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    if (MOVE_KEYS.has(k)) { keys.delete(k); e.stopPropagation(); }
  }
  function onPointerDown(e: PointerEvent) {
    if (dialogOpen) return;
    // Ignore presses that land on a UI control (buttons live above the canvas).
    if (e.target !== canvas) return;
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

    if (!dialogOpen) {
      // Resolve movement direction from keyboard, else the virtual joystick.
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
      if (mag > 0) {
        dx /= mag; dy /= mag;
        facing = Math.atan2(dy, dx);
        const moved = resolveCollisions(selfX + dx * SPEED * dt, selfY + dy * SPEED * dt);
        selfX = moved.x; selfY = moved.y;
      }
    }

    // Update which building (if any) we're at the door of, and the prompt.
    updateNearBuilding();
    // Stream our position to the server, throttled and only when it moved.
    maybeSendMove(now);

    updateCamera();
    render();
    raf = requestAnimationFrame(loop);
  }

  function updateNearBuilding() {
    let best: string | null = null;
    let bestD = Infinity;
    for (const b of WORLD_BUILDINGS) {
      const d = distToBuilding(b);
      if (d <= R + TRIGGER_PAD && d < bestD) { bestD = d; best = b.id; }
    }
    if (best !== nearId) {
      nearId = best;
      if (best) {
        const b = WORLD_BUILDINGS.find((x) => x.id === best)!;
        prompt.textContent = labelFor(b.kind);
        prompt.style.display = dialogOpen ? 'none' : 'block';
      } else {
        prompt.style.display = 'none';
      }
    }
    if (nearId && !dialogOpen && prompt.style.display === 'none') prompt.style.display = 'block';
  }

  function maybeSendMove(now: number) {
    if (now - lastSentAt < 66) return; // ~15 Hz cap
    if (Math.abs(selfX - lastSentX) < 0.5 && Math.abs(selfY - lastSentY) < 0.5) return;
    lastSentX = selfX; lastSentY = selfY; lastSentAt = now;
    net.move(selfX, selfY);
  }

  // --- rendering ---
  function render() {
    ctx.clearRect(0, 0, cssW, cssH);

    // Ground.
    ctx.fillStyle = '#1b3a2a';
    ctx.fillRect(0, 0, cssW, cssH);

    // Grid "paths" (every 100 world units), only across the visible range.
    ctx.strokeStyle = '#214733';
    ctx.lineWidth = 1;
    const step = 100;
    const startX = Math.floor(camX / step) * step;
    const endX = camX + cssW / SCALE;
    for (let wx = startX; wx <= endX; wx += step) {
      ctx.beginPath(); ctx.moveTo(sx(wx), 0); ctx.lineTo(sx(wx), cssH); ctx.stroke();
    }
    const startY = Math.floor(camY / step) * step;
    const endY = camY + cssH / SCALE;
    for (let wy = startY; wy <= endY; wy += step) {
      ctx.beginPath(); ctx.moveTo(0, sy(wy)); ctx.lineTo(cssW, sy(wy)); ctx.stroke();
    }

    // Map border wall.
    ctx.strokeStyle = '#3a5c45';
    ctx.lineWidth = 4;
    ctx.strokeRect(sx(0), sy(0), WORLD.w * SCALE, WORLD.h * SCALE);

    // Central plaza disc (just decoration around spawn).
    ctx.fillStyle = '#234a36';
    ctx.beginPath();
    ctx.arc(sx(WORLD.spawnX), sy(WORLD.spawnY), 120 * SCALE, 0, Math.PI * 2);
    ctx.fill();

    // Buildings.
    for (const b of WORLD_BUILDINGS) {
      const x = sx(b.x), y = sy(b.y), w = b.w * SCALE, h = b.h * SCALE;
      const near = b.id === nearId;
      // Drop shadow.
      ctx.fillStyle = '#0006';
      ctx.fillRect(x + 6, y + 8, w, h);
      // Wall.
      ctx.fillStyle = b.color;
      ctx.fillRect(x, y, w, h);
      // Roof band.
      ctx.fillStyle = shade(b.color, -0.25);
      ctx.fillRect(x, y, w, Math.max(10, h * 0.22));
      // Highlight when you're at the door.
      ctx.strokeStyle = near ? '#ffe08a' : '#0007';
      ctx.lineWidth = near ? 4 : 2;
      ctx.strokeRect(x, y, w, h);
      // Glyph.
      ctx.font = `${Math.round(Math.min(w, h) * 0.42)}px serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(b.emoji, x + w / 2, y + h * 0.6);
      // Sign over the door.
      ctx.font = '700 14px system-ui,sans-serif';
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'alphabetic';
      label(b.name, x + w / 2, y - 8, '#000a');
    }

    // Avatars: everyone else (from the broadcast) then ourselves on top.
    const selfId = net.selfId();
    for (const a of others) {
      if (a.id === selfId) continue;
      drawAvatar(a.x, a.y, a.color, a.name, false, 0);
    }
    drawAvatar(selfX, selfY, net.color(), net.name() || 'you', true, facing);

    // Virtual joystick visualization.
    if (joyActive) {
      ctx.strokeStyle = '#ffffff44';
      ctx.fillStyle = '#ffffff22';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(joyOX, joyOY, 34, 0, Math.PI * 2); ctx.stroke();
      const jx = joyCX - joyOX, jy = joyCY - joyOY;
      const m = Math.hypot(jx, jy) || 1;
      const cap = Math.min(m, 34);
      ctx.beginPath();
      ctx.arc(joyOX + (jx / m) * cap, joyOY + (jy / m) * cap, 16, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawAvatar(wx: number, wy: number, color: string, name: string, isSelf: boolean, face: number) {
    const x = sx(wx), y = sy(wy), r = R * SCALE;
    // Shadow.
    ctx.fillStyle = '#0005';
    ctx.beginPath(); ctx.ellipse(x, y + r * 0.7, r * 0.9, r * 0.4, 0, 0, Math.PI * 2); ctx.fill();
    // Body.
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = isSelf ? 3 : 2;
    ctx.strokeStyle = isSelf ? '#fff' : '#0007';
    ctx.stroke();
    // Facing eyes (self only — it's the one whose direction we track).
    if (isSelf) {
      ctx.fillStyle = '#1a1a1a';
      const ex = Math.cos(face) * r * 0.4, ey = Math.sin(face) * r * 0.4;
      const px = -Math.sin(face) * r * 0.32, py = Math.cos(face) * r * 0.32;
      ctx.beginPath(); ctx.arc(x + ex + px, y + ey + py, r * 0.13, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x + ex - px, y + ey - py, r * 0.13, 0, Math.PI * 2); ctx.fill();
    }
    // Name label.
    ctx.font = '700 13px system-ui,sans-serif';
    label(name, x, y - r - 7, isSelf ? '#1b2542cc' : '#000a', isSelf ? '#ffe08a' : '#fff');
  }

  // Draw centered text with a rounded background pill for readability.
  function label(text: string, cx: number, baselineY: number, bg: string, fg = '#fff') {
    ctx.textAlign = 'center';
    const w = ctx.measureText(text).width;
    const padX = 6, h = 18;
    const bx = cx - w / 2 - padX, by = baselineY - 13;
    ctx.fillStyle = bg;
    roundRect(bx, by, w + padX * 2, h, 5);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.fillText(text, cx, baselineY);
  }

  function roundRect(x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
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

  // Register the live controller and kick everything off.
  controller = {
    feed(avatars) {
      others = avatars;
      const n = avatars.length;
      count.textContent = n === 1 ? '1 player here' : `${n} players here`;
    },
    reenter() { net.enter(); },
  };
  net.enter();
  raf = requestAnimationFrame(loop);
}

// --- small helpers ---
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Lighten (>0) or darken (<0) a #rrggbb hex color by a fraction.
function shade(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = amt < 0 ? 1 + amt : 1 - amt;
  const t = amt < 0 ? 0 : 255;
  r = Math.round(r * f + t * (1 - f));
  g = Math.round(g * f + t * (1 - f));
  b = Math.round(b * f + t * (1 - f));
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
