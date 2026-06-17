// A tiny self-contained DOOM-style raycaster, launched from tsong as a toy.
//
// It is deliberately isolated: its own fullscreen overlay, its own canvas, its own input
// handlers and game loop, all torn down on exit. It never touches the Pong game state, the
// websocket, or any shared module, so it cannot break the rest of the app. Loaded lazily
// (dynamic import) the first time the player opens it.
//
// Rendering is a classic Lode-style DDA raycaster at a chunky 320×200 internal resolution
// (scaled up, pixelated, for that authentic crunchy look). Walls are flat-shaded by side and
// distance; enemies are billboarded procedural sprites with a z-buffer for occlusion.

// 16×16 grid. Non-'.' cells are walls; the digit picks a wall tint. Border is solid.
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

const W = 320; // internal render width (columns)
const H = 200; // internal render height

function isWall(mx: number, my: number): boolean {
  if (mx < 0 || my < 0 || mx >= MAP_W || my >= MAP_H) return true;
  return MAP[my][mx] !== '.';
}

interface Enemy {
  x: number;
  y: number;
  hp: number;
  alive: boolean;
  flash: number; // seconds of hit-flash remaining
  attackCd: number; // seconds until it can hit the player again
}

let doomOpen = false;

export function startDoom(): void {
  if (doomOpen) return;
  doomOpen = true;

  // --- DOM: overlay, pixelated canvas, HUD ---
  const overlay = document.createElement('div');
  overlay.id = 'doomOverlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:#000;display:flex;align-items:center;' +
    'justify-content:center;flex-direction:column;cursor:none;';

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.style.cssText =
    'image-rendering:pixelated;height:88vh;max-width:100vw;aspect-ratio:8/5;background:#000;';
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  overlay.appendChild(canvas);

  // HUD (crisp DOM text over the pixelated canvas).
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
  title.textContent = 'DOOM · WASD move · mouse/←→ turn · click shoot · ESC quit';
  title.style.cssText =
    'position:absolute;top:14px;left:0;right:0;text-align:center;font:700 14px ui-monospace,monospace;' +
    'color:#9fb0d8;text-shadow:1px 1px 0 #000;pointer-events:none;';
  overlay.appendChild(title);

  const banner = document.createElement('div');
  banner.style.cssText =
    'position:absolute;inset:0;display:none;align-items:center;justify-content:center;' +
    'font:900 64px ui-monospace,monospace;color:#ff2d2d;text-shadow:4px 4px 0 #000;' +
    'text-align:center;pointer-events:none;';
  overlay.appendChild(banner);

  document.body.appendChild(overlay);

  // --- game state ---
  let posX = 2.5;
  let posY = 2.5;
  let dirAngle = 0; // radians; 0 faces +X
  const fov = 0.66; // camera-plane half-width (~66° FOV)

  const enemies: Enemy[] = [
    { x: 8.5, y: 2.5 }, { x: 13.5, y: 5.5 }, { x: 2.5, y: 8.5 },
    { x: 13.5, y: 9.5 }, { x: 8.5, y: 13.5 }, { x: 2.5, y: 13.5 },
  ].map((p) => ({ x: p.x, y: p.y, hp: 2, alive: true, flash: 0, attackCd: 0 }));
  const totalEnemies = enemies.length;

  let health = 100;
  let ammo = 80;
  let kills = 0;
  let muzzle = 0; // seconds of muzzle flash remaining
  let hurt = 0; // seconds of red damage-flash remaining
  let gunRecoil = 0; // 0..1 kick used to drop the gun sprite
  let bob = 0; // weapon bob phase
  let over: 'win' | 'dead' | null = null;

  const keys = new Set<string>();
  const zBuffer = new Float32Array(W);

  // --- input ---
  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (k === 'escape') { close(); return; }
    if (over && k === 'r') { restart(); return; }
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd', ' '].includes(k)) {
      e.preventDefault();
      e.stopImmediatePropagation(); // keep tsong's global key handlers out of it
    }
    if (k === ' ') fire();
    keys.add(k);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    keys.delete(e.key.toLowerCase());
    e.stopImmediatePropagation();
  };
  const onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement === canvas) dirAngle += e.movementX * 0.0026;
  };
  const onMouseDown = () => {
    if (document.pointerLockElement !== canvas) { canvas.requestPointerLock(); return; }
    fire();
  };
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);

  // --- shooting (hitscan down the crosshair) ---
  function fire() {
    if (over || ammo <= 0) return;
    ammo--;
    muzzle = 0.07;
    gunRecoil = 1;
    shotSound();
    // Pick the nearest alive enemy under the crosshair that isn't behind a wall.
    const dirX = Math.cos(dirAngle);
    const dirY = Math.sin(dirAngle);
    const planeX = -dirY * fov;
    const planeY = dirX * fov;
    const invDet = 1 / (planeX * dirY - dirX * planeY);
    let best: Enemy | null = null;
    let bestDepth = Infinity;
    for (const e of enemies) {
      if (!e.alive) continue;
      const sx = e.x - posX;
      const sy = e.y - posY;
      const tX = invDet * (dirY * sx - dirX * sy);
      const tY = invDet * (-planeY * sx + planeX * sy); // depth
      if (tY <= 0.1) continue;
      const screenX = (W / 2) * (1 + tX / tY);
      const halfW = Math.abs(H / tY) * 0.5;
      if (Math.abs(screenX - W / 2) > halfW * 0.7) continue; // not under the crosshair
      const col = Math.max(0, Math.min(W - 1, Math.floor(screenX)));
      if (tY >= zBuffer[col]) continue; // behind a wall
      if (tY < bestDepth) { bestDepth = tY; best = e; }
    }
    if (best) {
      best.hp -= 1;
      best.flash = 0.12;
      if (best.hp <= 0) { best.alive = false; kills++; deathSound(); }
    }
  }

  // --- synth sounds (no assets) ---
  let audio: AudioContext | null = null;
  function ac(): AudioContext {
    if (!audio) audio = new AudioContext();
    return audio;
  }
  function shotSound() {
    try {
      const a = ac();
      const dur = 0.18;
      const buf = a.createBuffer(1, a.sampleRate * dur, a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
      const src = a.createBufferSource();
      src.buffer = buf;
      const g = a.createGain();
      g.gain.value = 0.35;
      src.connect(g); g.connect(a.destination);
      src.start();
    } catch { /* ignore */ }
  }
  function deathSound() {
    try {
      const a = ac();
      const o = a.createOscillator();
      const g = a.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(220, a.currentTime);
      o.frequency.exponentialRampToValueAtTime(50, a.currentTime + 0.3);
      g.gain.setValueAtTime(0.25, a.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.32);
      o.connect(g); g.connect(a.destination);
      o.start(); o.stop(a.currentTime + 0.34);
    } catch { /* ignore */ }
  }

  // --- movement + enemy AI ---
  function tryMove(nx: number, ny: number) {
    const pad = 0.18;
    if (!isWall(Math.floor(nx + Math.sign(nx - posX) * pad), Math.floor(posY))) posX = nx;
    if (!isWall(Math.floor(posX), Math.floor(ny + Math.sign(ny - posY) * pad))) posY = ny;
  }

  function update(dt: number) {
    if (over) return;
    const dirX = Math.cos(dirAngle);
    const dirY = Math.sin(dirAngle);
    const moveSpeed = 3.2 * dt;
    const turnSpeed = 2.6 * dt;
    let nx = posX;
    let ny = posY;
    let moving = false;
    if (keys.has('w') || keys.has('arrowup')) { nx += dirX * moveSpeed; ny += dirY * moveSpeed; moving = true; }
    if (keys.has('s') || keys.has('arrowdown')) { nx -= dirX * moveSpeed; ny -= dirY * moveSpeed; moving = true; }
    if (keys.has('a')) { nx += dirY * moveSpeed; ny -= dirX * moveSpeed; moving = true; } // strafe left
    if (keys.has('d')) { nx -= dirY * moveSpeed; ny += dirX * moveSpeed; moving = true; } // strafe right
    if (nx !== posX || ny !== posY) tryMove(nx, ny);
    if (keys.has('arrowleft')) dirAngle -= turnSpeed;
    if (keys.has('arrowright')) dirAngle += turnSpeed;
    if (moving) bob += dt * 9;

    if (muzzle > 0) muzzle -= dt;
    if (hurt > 0) hurt -= dt;
    if (gunRecoil > 0) gunRecoil = Math.max(0, gunRecoil - dt * 5);

    for (const e of enemies) {
      if (!e.alive) continue;
      if (e.flash > 0) e.flash -= dt;
      if (e.attackCd > 0) e.attackCd -= dt;
      const dx = posX - e.x;
      const dy = posY - e.y;
      const dist = Math.hypot(dx, dy) || 1;
      if (dist > 1.1) {
        const sp = 1.3 * dt;
        const ex = e.x + (dx / dist) * sp;
        const ey = e.y + (dy / dist) * sp;
        if (!isWall(Math.floor(ex), Math.floor(e.y))) e.x = ex;
        if (!isWall(Math.floor(e.x), Math.floor(ey))) e.y = ey;
      } else if (e.attackCd <= 0) {
        health -= 9;
        hurt = 0.25;
        e.attackCd = 1.1;
        if (health <= 0) { health = 0; over = 'dead'; }
      }
    }
    if (kills >= totalEnemies && !over) over = 'win';
  }

  // --- rendering ---
  function render() {
    // Ceiling + floor.
    ctx.fillStyle = '#2a2a33';
    ctx.fillRect(0, 0, W, H / 2);
    ctx.fillStyle = '#3a2e26';
    ctx.fillRect(0, H / 2, W, H / 2);

    const dirX = Math.cos(dirAngle);
    const dirY = Math.sin(dirAngle);
    const planeX = -dirY * fov;
    const planeY = dirX * fov;

    // Walls (DDA per column).
    for (let x = 0; x < W; x++) {
      const cameraX = (2 * x) / W - 1;
      const rayX = dirX + planeX * cameraX;
      const rayY = dirY + planeY * cameraX;
      let mapX = Math.floor(posX);
      let mapY = Math.floor(posY);
      const deltaX = Math.abs(1 / rayX);
      const deltaY = Math.abs(1 / rayY);
      let stepX: number, stepY: number, sideDistX: number, sideDistY: number;
      if (rayX < 0) { stepX = -1; sideDistX = (posX - mapX) * deltaX; }
      else { stepX = 1; sideDistX = (mapX + 1 - posX) * deltaX; }
      if (rayY < 0) { stepY = -1; sideDistY = (posY - mapY) * deltaY; }
      else { stepY = 1; sideDistY = (mapY + 1 - posY) * deltaY; }
      let side = 0;
      let guard = 0;
      let hitChar = '1';
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
      // Base wall color by cell type, darker on Y-sides, faded with distance.
      let r = 150, g = 40, b = 40;
      if (hitChar === '2') { r = 70; g = 90; b = 140; }
      else if (hitChar === '3') { r = 80; g = 130; b = 70; }
      let shade = side === 1 ? 0.66 : 1;
      shade *= Math.max(0.25, Math.min(1, 1.6 / (1 + perp * 0.25)));
      ctx.fillStyle = `rgb(${(r * shade) | 0},${(g * shade) | 0},${(b * shade) | 0})`;
      ctx.fillRect(x, start, 1, end - start + 1);
    }

    // Enemies (billboarded), sorted far→near, occluded by the z-buffer.
    const invDet = 1 / (planeX * dirY - dirX * planeY);
    const drawList = enemies
      .filter((e) => e.alive)
      .map((e) => {
        const sx = e.x - posX;
        const sy = e.y - posY;
        return {
          e,
          tX: invDet * (dirY * sx - dirX * sy),
          tY: invDet * (-planeY * sx + planeX * sy),
        };
      })
      .filter((s) => s.tY > 0.1)
      .sort((a, b) => b.tY - a.tY);
    for (const s of drawList) {
      const screenX = (W / 2) * (1 + s.tX / s.tY);
      const size = Math.abs(H / s.tY);
      const col = Math.max(0, Math.min(W - 1, Math.floor(screenX)));
      if (s.tY >= zBuffer[col]) continue; // hidden behind a wall
      drawImp(screenX, size, s.e.flash > 0);
    }

    drawGun();
    drawCrosshair();
    if (hurt > 0) {
      ctx.fillStyle = `rgba(180,0,0,${Math.min(0.5, hurt * 1.6)})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  // A chunky procedural imp: dark body, glowing eyes, little horns.
  function drawImp(cx: number, size: number, flash: boolean) {
    const h = Math.min(size, H * 1.4);
    const w = h * 0.55;
    const top = H / 2 - h / 2;
    const left = cx - w / 2;
    const body = flash ? '#ffffff' : '#6b3a2a';
    const head = flash ? '#ffdddd' : '#4a261b';
    ctx.fillStyle = body;
    ctx.fillRect(left + w * 0.18, top + h * 0.42, w * 0.64, h * 0.5); // torso
    ctx.fillRect(left + w * 0.02, top + h * 0.5, w * 0.2, h * 0.34); // left arm
    ctx.fillRect(left + w * 0.78, top + h * 0.5, w * 0.2, h * 0.34); // right arm
    ctx.fillStyle = head;
    ctx.fillRect(left + w * 0.28, top + h * 0.12, w * 0.44, h * 0.34); // head
    // horns
    ctx.fillRect(left + w * 0.26, top + h * 0.04, w * 0.07, h * 0.12);
    ctx.fillRect(left + w * 0.67, top + h * 0.04, w * 0.07, h * 0.12);
    // eyes
    ctx.fillStyle = flash ? '#ff0000' : '#ffce26';
    ctx.fillRect(left + w * 0.34, top + h * 0.22, w * 0.1, h * 0.06);
    ctx.fillRect(left + w * 0.56, top + h * 0.22, w * 0.1, h * 0.06);
  }

  // Bottom-center shotgun with bob + recoil drop and a muzzle flash.
  function drawGun() {
    const bobX = Math.sin(bob) * 6;
    const bobY = Math.abs(Math.cos(bob)) * 4 + gunRecoil * 22;
    const gx = W / 2 + bobX;
    const gy = H - 30 + bobY;
    ctx.fillStyle = '#3a3a40';
    ctx.fillRect(gx - 30, gy, 60, 40); // receiver
    ctx.fillStyle = '#222228';
    ctx.fillRect(gx - 8, gy - 34, 16, 36); // barrel
    ctx.fillStyle = '#52525c';
    ctx.fillRect(gx - 34, gy + 14, 12, 26); // grip
    if (muzzle > 0) {
      ctx.fillStyle = '#fff3b0';
      ctx.beginPath();
      ctx.arc(gx, gy - 34, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ff9d2e';
      ctx.beginPath();
      ctx.arc(gx, gy - 34, 9, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawCrosshair() {
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(W / 2 - 5, H / 2, 10, 1);
    ctx.fillRect(W / 2, H / 2 - 5, 1, 10);
  }

  function syncHud() {
    healthEl.textContent = `♥ ${health}`;
    ammoEl.textContent = `▮ ${ammo}`;
    killsEl.textContent = `☠ ${kills}/${totalEnemies}`;
    if (over === 'win') { banner.textContent = '🏆 LEVEL CLEAR\npress R'; banner.style.display = 'flex'; banner.style.color = '#ffd166'; banner.style.whiteSpace = 'pre'; }
    else if (over === 'dead') { banner.textContent = 'YOU DIED\npress R'; banner.style.display = 'flex'; banner.style.color = '#ff2d2d'; banner.style.whiteSpace = 'pre'; }
    else banner.style.display = 'none';
  }

  function restart() {
    posX = 2.5; posY = 2.5; dirAngle = 0;
    health = 100; ammo = 80; kills = 0; over = null;
    for (let i = 0; i < enemies.length; i++) {
      const start = [
        { x: 8.5, y: 2.5 }, { x: 13.5, y: 5.5 }, { x: 2.5, y: 8.5 },
        { x: 13.5, y: 9.5 }, { x: 8.5, y: 13.5 }, { x: 2.5, y: 13.5 },
      ][i];
      enemies[i] = { x: start.x, y: start.y, hp: 2, alive: true, flash: 0, attackCd: 0 };
    }
  }

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
    if (!doomOpen) return;
    doomOpen = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('mousemove', onMouseMove);
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    audio?.close().catch(() => {});
    overlay.remove();
  }
}
