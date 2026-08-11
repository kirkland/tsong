// The Temple, in three dimensions.
//
// Every room in the overworld is top-down pixel art — except this one. Step through the
// Temple's door and the world quietly becomes a first-person candlelit cathedral. Nobody
// is told; pilgrims just find it.
//
// This is presentation ONLY. The Phaser world keeps simulating underneath with its canvas
// hidden: movement (WASD / arrows / joystick) still drives selfX/selfY through the same
// inset-rect collision, the exit mat and the holy book still use the same distance checks
// and DOM prompts, the chant still loops. This file only draws what the pilgrim sees.
//
// Three.js arrives from the CDN exactly like render3d.ts (kept external so the tiny VPS
// never tries to bundle it), and the pixel-art textures are borrowed live from Phaser's
// texture manager (they're runtime-generated canvases), so the nave keeps the exact same
// texels as its 2D self — just standing upright.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js';

export interface TempleAvatar { id: string; x: number; y: number; name: string; color: string }

export interface TempleFrame {
  selfX: number;
  selfY: number;
  facing: number; // radians, screen convention (y down): atan2(dy, dx) of the last walk direction
  moving: boolean;
  time: number; // ms, for animation phases
  dt: number; // seconds since last frame
  avatars: TempleAvatar[]; // everyone else currently standing inside the nave
}

export interface TempleConfig {
  int: { x: number; y: number; w: number; h: number }; // TEMPLE_INT, world coords
  wall: number; // TEMPLE_WALL thickness
  bookX: number; // the lectern (world coords)
  bookY: number;
  /** Borrow a runtime-generated pixel-art texture from Phaser's texture manager. */
  tex(key: string): HTMLCanvasElement | HTMLImageElement | null;
}

export interface TempleRenderer {
  render(f: TempleFrame): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

const TEXEL = 2; // world units per source texel (matches world.ts)
const WALL_H = 230; // the nave's walls — lofty, for a congregation of 20-unit-tall balls
const EYE = 26; // first-person eye height (the avatar is a ball with eyes; the eyes sit high)

// A soft radial glow sprite texture (white core fading through `color` to transparent).
function glowTexture(color: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.25, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createTempleRenderer(container: HTMLElement, cfg: TempleConfig): TempleRenderer {
  const ROOM = cfg.int;
  const T = cfg.wall;
  const cx = ROOM.x + ROOM.w / 2; // world-coord center of the nave (same cx as buildTempleInterior)
  // World (x, y-down) → scene (X, Z), centered on the room; +Y is up. Same 1:1 mapping as render3d.
  const X = (x: number) => x - cx;
  const Z = (y: number) => y - (ROOM.y + ROOM.h / 2);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0a0714');
  scene.fog = new THREE.FogExp2('#0b0716', 0.0012); // incense in the air

  const camera = new THREE.PerspectiveCamera(72, 1.6, 2, 3500);

  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // --- textures (borrowed from Phaser, kept crisp) ---------------------------------------
  const ownedTextures: THREE.Texture[] = []; // everything we must dispose
  function pxTex(key: string, repeatX = 1, repeatY = 1): THREE.Texture | null {
    const src = cfg.tex(key);
    if (!src) return null;
    const t = new THREE.CanvasTexture(src as HTMLCanvasElement);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    if (repeatX !== 1 || repeatY !== 1) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeatX, repeatY);
    }
    ownedTextures.push(t);
    return t;
  }
  // Lambert so the candles actually light the stone; falls back to flat color if a texture
  // is somehow missing (offline texture manager weirdness) rather than crashing the chapel.
  function pxMat(key: string, fallback: string, repeatX = 1, repeatY = 1): THREE.MeshLambertMaterial {
    const map = pxTex(key, repeatX, repeatY);
    return new THREE.MeshLambertMaterial(map ? { map } : { color: fallback });
  }
  // Props keep their baked pixel-art shading and ignore scene lighting (like their 2D selves) —
  // Lambert here would render every south-facing standee near-black, since the candles sit
  // north of them and a plane only has the one lighting normal. A slight dim tint folds them
  // into the nave's gloom; the candle glows paint the warmth back on top.
  function propMat(key: string, fallback: string): THREE.MeshBasicMaterial {
    const map = pxTex(key);
    const m = new THREE.MeshBasicMaterial(map ? { map, color: '#cfcfd8' } : { color: fallback });
    m.transparent = true;
    m.alphaTest = 0.05;
    m.side = THREE.DoubleSide;
    return m;
  }

  // --- the nave itself -------------------------------------------------------------------
  // Floor: the same marble checker, tiled (one 16-texel tile = 32 world units).
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM.w, ROOM.h),
    pxMat('w-tmp-floor', '#d5cfbe', ROOM.w / 32, ROOM.h / 32),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // The sacred runner up the nave, and the exit mat by the door (same rects as the 2D build).
  function rug(x: number, y: number, w: number, h: number) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), pxMat('w-tmp-rug', '#4a2d7a', w / 32, h / 32));
    m.rotation.x = -Math.PI / 2;
    m.position.set(X(x + w / 2), 0.4, Z(y + h / 2));
    scene.add(m);
  }
  rug(cx - 70, ROOM.y + 96, 140, ROOM.h - 210);
  rug(cx - 80, ROOM.y + ROOM.h - T - 84, 160, 64);

  // Walls: four stone slabs, ashlar-tiled, meeting a vaulted dark above.
  const wallMat = pxMat('w-tmp-wall', '#bcb59f', 4, WALL_H / 32); // repeat set per-face below via clones
  function wall(w: number, d: number, x: number, z: number, along: number) {
    const m = wallMat.clone();
    if (m.map) { m.map = m.map.clone(); m.map.repeat.set(along / 32, WALL_H / 32); m.map.needsUpdate = true; ownedTextures.push(m.map); }
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, WALL_H, d), m);
    mesh.position.set(x, WALL_H / 2, z);
    scene.add(mesh);
  }
  wall(ROOM.w, T, 0, Z(ROOM.y + T / 2), ROOM.w); // north (behind the altar)
  wall(ROOM.w, T, 0, Z(ROOM.y + ROOM.h - T / 2), ROOM.w); // south (the door)
  wall(T, ROOM.h, X(ROOM.x + T / 2), 0, ROOM.h); // west
  wall(T, ROOM.h, X(ROOM.x + ROOM.w - T / 2), 0, ROOM.h); // east

  // The vault: a painted ceiling fresco — the Eternal Volley among the stars. A secret inside
  // the secret: you only ever see it if you think to look up in the one room that has an up.
  {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, '#191330');
    grad.addColorStop(1, '#0d0a1e');
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 170; i++) { // the heavens
      const x = Math.random() * 512, y = Math.random() * 512, r = Math.random() * 1.6 + 0.4;
      g.fillStyle = Math.random() < 0.25 ? 'rgba(232,195,77,0.8)' : 'rgba(220,225,255,0.7)';
      g.fillRect(x, y, r, r);
    }
    // the fresco: two golden paddles, and the Ball's dotted arc between them, world without end
    g.strokeStyle = 'rgba(232,195,77,0.5)';
    g.lineWidth = 3;
    g.setLineDash([6, 10]);
    g.beginPath();
    g.moveTo(96, 320);
    g.quadraticCurveTo(256, 120, 416, 320);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = 'rgba(232,195,77,0.85)';
    g.fillRect(84, 300, 14, 48); g.fillRect(414, 300, 14, 48); // the two sentinels
    const ball = g.createRadialGradient(256, 218, 2, 256, 218, 16);
    ball.addColorStop(0, '#fff6c0'); ball.addColorStop(1, 'rgba(255,224,106,0)');
    g.fillStyle = ball;
    g.fillRect(236, 198, 40, 40);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    ownedTextures.push(t);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.w, ROOM.h), new THREE.MeshBasicMaterial({ map: t }));
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = WALL_H;
    scene.add(ceil);
  }

  // Standee helper: a pixel-art prop standing upright on the floor, facing the door (+Z),
  // Paper-Mario style. `bx, by` are the sprite's 2D base point (origin 0.5, 1 — its feet).
  const billboards: THREE.Object3D[] = []; // standees that turn to face the camera each frame
  function standee(key: string, w: number, h: number, bx: number, by: number, opts: { billboard?: boolean; fallback?: string } = {}) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), propMat(key, opts.fallback ?? '#c9c2ad'));
    m.position.set(X(bx), h / 2, Z(by));
    scene.add(m);
    if (opts.billboard) billboards.push(m);
    return m;
  }

  // --- furnishing the nave (all coordinates mirror buildTempleInterior) --------------------
  const innerNorthZ = Z(ROOM.y + T) + 1.2; // just proud of the north wall's inner face

  // Three stained-glass windows, glowing from a light that is not the candles'.
  const windowGlowTex = glowTexture('#7f9fe8');
  for (const wx of [cx - 240, cx, cx + 240]) {
    const win = new THREE.Mesh(
      new THREE.PlaneGeometry(24 * TEXEL, 40 * TEXEL),
      new THREE.MeshBasicMaterial({ map: pxTex('w-tmp-window') ?? undefined, transparent: true, alphaTest: 0.05 }),
    );
    win.position.set(X(wx), 162, innerNorthZ);
    scene.add(win);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: windowGlowTex, color: '#9fb6ff', transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.set(150, 150, 1);
    glow.position.set(X(wx), 158, innerNorthZ + 4);
    scene.add(glow);
    const moon = new THREE.PointLight('#9fb6ff', 1.5, 520, 1.6); // cool daylight through the glass
    moon.position.set(X(wx), 150, innerNorthZ + 55);
    scene.add(moon);
  }

  // The Cross of the Paddle, hung above the altar.
  const cross = new THREE.Mesh(
    new THREE.PlaneGeometry(28 * TEXEL, 28 * TEXEL),
    new THREE.MeshBasicMaterial({ map: pxTex('w-tmp-icon') ?? undefined, transparent: true, alphaTest: 0.05 }),
  );
  cross.position.set(0, 116, innerNorthZ);
  scene.add(cross);

  // Altar, colonnade, pews, lectern — the same standees the 2D room places.
  standee('w-tmp-altar', 44 * TEXEL, 30 * TEXEL, cx, ROOM.y + 206);
  for (const cy0 of [ROOM.y + 250, ROOM.y + 386, ROOM.y + 522]) {
    for (const colX of [ROOM.x + 118, ROOM.x + ROOM.w - 118]) {
      // columns are crossed planes (an X), so the colonnade reads as round from every aisle
      const a = standee('w-tmp-column', 16 * TEXEL, 64 * TEXEL, colX, cy0);
      const b = standee('w-tmp-column', 16 * TEXEL, 64 * TEXEL, colX, cy0);
      b.rotation.y = Math.PI / 2;
      void a;
    }
  }
  for (let r = 0; r < 4; r++) {
    const py = ROOM.y + 336 + r * 82;
    standee('w-tmp-pew', 48 * TEXEL, 18 * TEXEL, cx - 150, py);
    standee('w-tmp-pew', 48 * TEXEL, 18 * TEXEL, cx + 150, py);
  }
  standee('w-tmp-book', 24 * TEXEL, 28 * TEXEL, cfg.bookX, cfg.bookY + 16, { billboard: true });

  // The holy Ball relic, breathing over the altar.
  const relic = new THREE.Group();
  relic.add(new THREE.Mesh(new THREE.SphereGeometry(11, 20, 14), new THREE.MeshBasicMaterial({ color: '#fff3b0' })));
  const relicGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('#ffe06a'), color: '#ffe06a', transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
  relicGlow.scale.set(90, 90, 1);
  relic.add(relicGlow);
  const relicLight = new THREE.PointLight('#ffe06a', 2.2, 620, 1.5);
  relic.add(relicLight);
  relic.position.set(0, 74, Z(ROOM.y + 186));
  scene.add(relic);

  // Altar candles: standee + glow + a warm flickering light each.
  const candleGlowTex = glowTexture('#ffc36a');
  const flickers: { light: THREE.PointLight; spr: THREE.Sprite; base: number; phase: number }[] = [];
  for (const dxc of [-150, -72, 72, 150]) {
    standee('w-tmp-candle', 8 * TEXEL, 20 * TEXEL, cx + dxc, ROOM.y + 200, { billboard: true });
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: candleGlowTex, color: '#ffd98a', transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
    spr.scale.set(34, 34, 1);
    spr.position.set(X(cx + dxc), 37, Z(ROOM.y + 196));
    scene.add(spr);
    const light = new THREE.PointLight('#ffc36a', 2.6, 360, 1.5);
    light.position.set(X(cx + dxc), 40, Z(ROOM.y + 192));
    scene.add(light);
    flickers.push({ light, spr, base: 2.6, phase: (dxc + 200) / 37 });
  }

  // The door you came in by: heavy timber on the south wall, warmly lit from your side.
  {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 96;
    const g = c.getContext('2d')!;
    g.fillStyle = '#3a2712';
    g.beginPath();
    g.moveTo(2, 96); g.lineTo(2, 30); g.quadraticCurveTo(32, -6, 62, 30); g.lineTo(62, 96);
    g.closePath();
    g.fill();
    g.strokeStyle = '#8a5e34'; g.lineWidth = 3; g.stroke();
    g.strokeStyle = '#241708'; g.lineWidth = 2;
    for (const px of [16, 32, 48]) { g.beginPath(); g.moveTo(px, 14); g.lineTo(px, 96); g.stroke(); } // planks
    g.fillStyle = '#e8c34d';
    g.fillRect(24, 58, 5, 5); g.fillRect(36, 58, 5, 5); // handles
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
    ownedTextures.push(t);
    const door = new THREE.Mesh(new THREE.PlaneGeometry(104, 156), new THREE.MeshBasicMaterial({ map: t, color: '#cfcfd8' }));
    door.rotation.y = Math.PI; // faces back into the room
    door.position.set(0, 78, Z(ROOM.y + ROOM.h - T) - 1.2);
    scene.add(door);
    const lantern = new THREE.PointLight('#ffb46a', 1.2, 280, 1.5);
    lantern.position.set(0, 70, Z(ROOM.y + ROOM.h - T) - 40);
    scene.add(lantern);
  }

  // "🚪 EXIT" painted on the floor by the door (readable while walking south, toward it).
  {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d')!;
    g.font = '900 40px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 7; g.strokeStyle = 'rgba(26,15,8,0.9)';
    g.strokeText('🚪 EXIT', 128, 32);
    g.fillStyle = '#ffe2b0';
    g.fillText('🚪 EXIT', 128, 32);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    ownedTextures.push(t);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(120, 30), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }));
    m.rotation.set(-Math.PI / 2, 0, Math.PI); // flat on the floor, top edge toward the door
    m.position.set(0, 0.7, Z(ROOM.y + ROOM.h - T - 46));
    scene.add(m);
  }

  // Base light: enough to read the stone by, cool above, earthen below. The candles do the rest.
  scene.add(new THREE.HemisphereLight('#8f86b8', '#2e2418', 0.85));
  scene.add(new THREE.AmbientLight('#3a3252', 1.0));

  // Dust motes drifting in the window-light. Incense, probably.
  const MOTES = 120;
  const motePos = new Float32Array(MOTES * 3);
  const moteSpeed = new Float32Array(MOTES);
  const moteHigh = WALL_H - 36;
  for (let i = 0; i < MOTES; i++) {
    motePos[i * 3] = (Math.random() - 0.5) * (ROOM.w - T * 2 - 60);
    motePos[i * 3 + 1] = 8 + Math.random() * (moteHigh - 8);
    motePos[i * 3 + 2] = Z(ROOM.y + T + 30 + Math.random() * (ROOM.h - T * 2 - 60));
    moteSpeed[i] = 2.5 + Math.random() * 4;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
  const motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({
    color: '#cfd8ff', size: 2.6, sizeAttenuation: true, transparent: true, opacity: 0.4,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  scene.add(motes);

  // --- fellow pilgrims: remote avatars as tinted billboards with name halos -----------------
  interface Pilgrim { group: THREE.Group; body: THREE.Mesh; label: THREE.Sprite; labelCanvas: HTMLCanvasElement; labelTex: THREE.CanvasTexture; name: string; color: string }
  const pilgrims = new Map<string, Pilgrim>();
  const avatarTex = pxTex('w-avatar');
  const shadowGeo = new THREE.CircleGeometry(11, 20);
  const shadowMat = new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.3, depthWrite: false });

  function paintLabel(p: Pilgrim) {
    const g = p.labelCanvas.getContext('2d')!;
    g.clearRect(0, 0, 256, 64);
    g.font = '700 26px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 5; g.strokeStyle = 'rgba(11,16,32,0.9)';
    g.strokeText(p.name, 128, 32);
    g.fillStyle = '#ffffff';
    g.fillText(p.name, 128, 32);
    p.labelTex.needsUpdate = true;
  }
  function makePilgrim(a: TempleAvatar): Pilgrim {
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshBasicMaterial(avatarTex ? { map: avatarTex, transparent: true, alphaTest: 0.05, side: THREE.DoubleSide } : { color: a.color });
    bodyMat.color.set(a.color); // tint multiplies, same trick as Phaser's setTint
    const body = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), bodyMat);
    body.position.y = 10;
    group.add(body);
    const shadow = new THREE.Mesh(shadowGeo, shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.5;
    group.add(shadow);
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 256; labelCanvas.height = 64;
    const labelTex = new THREE.CanvasTexture(labelCanvas);
    labelTex.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex, transparent: true, depthWrite: false }));
    label.scale.set(56, 14, 1);
    label.position.y = 36;
    group.add(label);
    const p: Pilgrim = { group, body, label, labelCanvas, labelTex, name: a.name, color: a.color };
    paintLabel(p);
    scene.add(group);
    return p;
  }

  // --- the frame -----------------------------------------------------------------------------
  let visible = false;
  let snapCam = true; // hard-set the camera yaw on the first frame after each entrance
  let camYaw = -Math.PI / 2; // facing up the nave
  let bob = 0;
  const angDelta = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

  function render(f: TempleFrame) {
    if (visible === false) return;
    const t = f.time;

    // Camera: your eyes, easing around to face the way you walk. A touch of gaze-lift so the
    // windows and the vault are always half in view — this room was built to be looked up at.
    if (snapCam) { camYaw = f.facing; snapCam = false; }
    else camYaw += angDelta(camYaw, f.facing) * Math.min(1, f.dt * 5.5);
    const bobTarget = f.moving ? Math.sin(t / 130) * 1.5 : 0;
    bob += (bobTarget - bob) * Math.min(1, f.dt * 8);
    const px = X(f.selfX), pz = Z(f.selfY);
    camera.position.set(px, EYE + bob, pz);
    camera.lookAt(px + Math.cos(camYaw) * 120, EYE + bob + 8, pz + Math.sin(camYaw) * 120);

    // candlelight breathes
    for (const fl of flickers) {
      const n = 0.72 + 0.28 * (0.55 + 0.45 * Math.sin(t / 91 + fl.phase * 7)) * (0.65 + 0.35 * Math.sin(t / 47 + fl.phase * 3));
      fl.light.intensity = fl.base * n;
      fl.spr.material.opacity = 0.25 + 0.3 * n;
    }
    // the relic breathes slower, like something asleep
    const breath = Math.sin(t / 950);
    relic.position.y = 74 + breath * 7;
    relicGlow.scale.setScalar(90 + breath * 18);
    relicLight.intensity = 2.2 + breath * 0.7;

    // motes sink and are reborn near the vault
    for (let i = 0; i < MOTES; i++) {
      motePos[i * 3 + 1] -= moteSpeed[i] * f.dt;
      motePos[i * 3] += Math.sin(t / 1300 + i) * f.dt * 2;
      if (motePos[i * 3 + 1] < 6) motePos[i * 3 + 1] = moteHigh;
    }
    moteGeo.attributes.position.needsUpdate = true;

    // fellow pilgrims
    const seen = new Set<string>();
    for (const a of f.avatars) {
      seen.add(a.id);
      let p = pilgrims.get(a.id);
      if (!p) { p = makePilgrim(a); pilgrims.set(a.id, p); }
      if (p.name !== a.name) { p.name = a.name; paintLabel(p); }
      if (p.color !== a.color) { p.color = a.color; (p.body.material as THREE.MeshLambertMaterial).color.set(a.color); }
      p.group.position.set(X(a.x), 0, Z(a.y));
      p.body.position.y = 10 + Math.sin(t / 220 + a.id.charCodeAt(0)) * 0.8; // a gentle devotional bob
      p.body.rotation.y = Math.atan2(camera.position.x - p.group.position.x, camera.position.z - p.group.position.z);
    }
    for (const [id, p] of pilgrims) {
      if (seen.has(id)) continue;
      scene.remove(p.group);
      p.labelTex.dispose();
      (p.body.material as THREE.Material).dispose();
      pilgrims.delete(id);
    }

    // standees that track the camera (candles, the book)
    for (const b of billboards) b.rotation.y = Math.atan2(camera.position.x - b.position.x, camera.position.z - b.position.z);

    renderer.render(scene, camera);
  }

  function setVisible(v: boolean) {
    if (v === visible) return;
    visible = v;
    renderer.domElement.style.display = v ? '' : 'none';
    if (v) { snapCam = true; resize(); }
  }
  setVisible(false); // hidden until the first sync

  function dispose() {
    window.removeEventListener('resize', resize);
    scene.traverse((o: THREE.Object3D) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = (mesh as { material?: THREE.Material | THREE.Material[] }).material;
      for (const m of Array.isArray(mat) ? mat : mat ? [mat] : []) m.dispose();
    });
    for (const t of ownedTextures) t.dispose();
    for (const [, p] of pilgrims) p.labelTex.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return { render, setVisible, dispose };
}
