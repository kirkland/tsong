// Optional 3D view of the live match. Loaded lazily (dynamic import) only when the
// player switches into 3D mode, so the default 2D experience never pays for Three.js.
//
// It renders the SAME authoritative StateMsg the 2D canvas draws — court, both teams'
// paddles, every ball, and the power-up target — just from an angled camera with real
// lighting and shadows. Coordinates map 1:1 from court units to world units, centered
// on the origin (court x -> world x, court y -> world z, up = +y).

// Three.js is loaded from a CDN as an external module (not bundled). This whole file
// is itself only dynamically imported when the player switches to 3D, so the browser
// fetches Three.js lazily and the default 2D bundle never references it. Keeping it out
// of the Vite build also keeps the (small) production VPS from OOMing while bundling.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js';
import { COURT, PADDLE, BALL, BIG_BALL_R, BLASTER, DIAMOND, PINATA, POWERUPS, TARGET, PowerupKind, Side, StateMsg } from '../shared/types';
import { drawLegendIcon, drawDiamondIcon, blockHue } from './render';

export interface BlasterAim { side: Side; angle: number; }

export interface Renderer3D {
  render(s: StateMsg, fpSide?: 'left' | 'right' | null, aim?: BlasterAim | null): void;
  resize(): void;
  dispose(): void;
}

const PADDLE_H = 22; // visual paddle height (the dimension that only exists in 3D)
const BALL_Y = 11; // height of ball centers above the floor (roughly mid-paddle)
const PUCK_H = 12; // thickness of the power-up / diamond pucks
const PUCK_Y = 16; // height the pucks float above the floor
const wx = (x: number) => x - COURT.w / 2;
const wz = (y: number) => y - COURT.h / 2;

// Per-kind power-up color (mirrors the 2D legend), used to tint each puck's rim.
const PU_COLOR: Record<PowerupKind, string> = {
  grow: '#ffd166', shrink: '#ff6b6b', smash: '#ff922b', slow: '#4dd2ff', multi: '#b197fc',
  freeze: '#74c0fc', curve: '#63e6be', blind: '#868e96', mirror: '#f783ac', shield: '#f5cc00',
  ghost: '#c0c8e0', tiny: '#ffa94d', warp: '#9775fa', bigball: '#ffd43b', rotate: '#69db7c',
  fritz: '#f59e0b',
  disco: '#e040fb',
  blaster: '#ff4d4d',
  minion: '#ffd21e',
  earthquake: '#b07a3a',
  coins: '#ffcf33',
  blackout: '#9aa0b0', bullettime: '#5aa0ff', vortex: '#b97cff', glitch: '#00fff0', smoke: '#c8c8d2', tilt: '#ffa94d',
  roam: '#4ade80',
};

// Text painted flat onto the court floor (so it sits in the scene with real perspective —
// "more 3D" than a billboard). `widthWorld` sizes it; the canvas is 4:1 so height is a
// quarter. Lies on the floor with its top edge pointing away from the camera, so it reads
// upright from the default view.
function makeFloorText(widthWorld: number) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const c2d = canvas.getContext('2d')!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 8;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(widthWorld, widthWorld / 4),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2; // lie flat on the ice
  mesh.position.y = 0.6; // just above the floor to avoid z-fighting
  let last = '';
  function set(text: string, color: string, px = 96) {
    const key = `${text}|${color}|${px}`;
    if (key === last) return; // only repaint when the content changes
    last = key;
    c2d.clearRect(0, 0, canvas.width, canvas.height);
    let f = px;
    const font = (n: number) => `900 ${n}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    c2d.font = font(f);
    while (c2d.measureText(text).width > canvas.width * 0.94 && f > 14) c2d.font = font((f -= 6));
    c2d.textAlign = 'center';
    c2d.textBaseline = 'middle';
    c2d.lineWidth = f * 0.18;
    c2d.strokeStyle = 'rgba(0,0,0,0.85)'; // dark outline so it reads on the ice
    c2d.strokeText(text, canvas.width / 2, canvas.height / 2);
    c2d.fillStyle = color;
    c2d.fillText(text, canvas.width / 2, canvas.height / 2);
    tex.needsUpdate = true;
  }
  return { mesh, set };
}

// A round canvas texture for a puck top face: an opaque puck-dark disc with the 2D icon
// (`paint` draws it, clearing first) composited on top, so transparent areas read as puck.
function makePuckFaceTexture(paint: (c: HTMLCanvasElement) => void): THREE.CanvasTexture {
  const size = 256;
  const icon = document.createElement('canvas');
  icon.width = icon.height = size;
  paint(icon); // draws the icon on a transparent background
  const face = document.createElement('canvas');
  face.width = face.height = size;
  const c = face.getContext('2d')!;
  c.fillStyle = '#0c1222';
  c.beginPath();
  c.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  c.fill();
  c.drawImage(icon, 0, 0);
  const tex = new THREE.CanvasTexture(face);
  tex.anisotropy = 8;
  return tex;
}

// Build a hockey-puck mesh: a short cylinder lying flat, the given top face, a tinted rim,
// and a dark underside.
function makePuck(radius: number, topTex: THREE.CanvasTexture, rim: string) {
  const geo = new THREE.CylinderGeometry(radius, radius, PUCK_H, 56);
  const side = new THREE.MeshStandardMaterial({ color: rim, roughness: 0.55, metalness: 0.1 });
  const top = new THREE.MeshBasicMaterial({ map: topTex });
  const bottom = new THREE.MeshStandardMaterial({ color: '#0a0e1c', roughness: 0.8 });
  const mesh = new THREE.Mesh(geo, [side, top, bottom]); // groups: 0 side, 1 top cap, 2 bottom cap
  mesh.castShadow = true;
  return { mesh, side, top };
}

export function createRenderer(container: HTMLElement): Renderer3D {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const DEFAULT_BG = new THREE.Color('#060912');
  scene.background = DEFAULT_BG;

  // Fritz power-up texture, loaded once. While fritz is active we paint it onto the court
  // floor and use it as the scene backdrop, so in first-person you're surrounded by Fritz.
  const fritzTex = new THREE.TextureLoader().load('/fritz.jpg');
  fritzTex.colorSpace = THREE.SRGBColorSpace;

  // Minion power-up: a camera-facing billboard at each paddle (replaces the box for the point).
  const minionTex = new THREE.TextureLoader().load('/minion.png');
  minionTex.colorSpace = THREE.SRGBColorSpace;
  const minionSprites: THREE.Sprite[] = [];
  function getMinionSprite(i: number): THREE.Sprite {
    let s = minionSprites[i];
    if (!s) {
      s = new THREE.Sprite(new THREE.SpriteMaterial({ map: minionTex, transparent: true }));
      scene.add(s);
      minionSprites[i] = s;
    }
    return s;
  }

  // In first-person, the minion power-up uses Otto: a taller billboard stretched to the
  // paddle's full width and ~3× the paddle box height, so you "become" the paddle.
  const ottoTex = new THREE.TextureLoader().load('/otto.webp');
  ottoTex.colorSpace = THREE.SRGBColorSpace;
  const ottoSprites: THREE.Sprite[] = [];
  function getOttoSprite(i: number): THREE.Sprite {
    let s = ottoSprites[i];
    if (!s) {
      s = new THREE.Sprite(new THREE.SpriteMaterial({ map: ottoTex, transparent: true }));
      scene.add(s);
      ottoSprites[i] = s;
    }
    return s;
  }

  // --- Disco power-up objects (3D/FP only) ---
  // Chrome disco ball that drops from the ceiling when the powerup fires.
  const discoBallMesh = new THREE.Mesh(
    new THREE.SphereGeometry(30, 20, 16),
    new THREE.MeshStandardMaterial({ color: '#e8eaf6', metalness: 0.95, roughness: 0.04 }),
  );
  discoBallMesh.position.set(0, 600, 0);
  discoBallMesh.visible = false;
  scene.add(discoBallMesh); // in scene (not world) so rotate powerup doesn't spin it

  // Five colored point lights that orbit the ball to cast moving patches around the court.
  const DISCO_COLORS = ['#ff2266', '#2299ff', '#22ff88', '#ffcc00', '#cc44ff'];
  const discoLights = DISCO_COLORS.map((color) => {
    const l = new THREE.PointLight(color, 0, 1100, 1.6);
    scene.add(l);
    return l;
  });

  // Dance-floor canvas texture — an 8×8 checkerboard that cycles through hues each frame.
  const danceCanvas = document.createElement('canvas');
  danceCanvas.width = 512;
  danceCanvas.height = 512;
  const danceCtx = danceCanvas.getContext('2d')!;
  const danceTex = new THREE.CanvasTexture(danceCanvas);
  danceTex.colorSpace = THREE.SRGBColorSpace;

  let discoOn = false;
  let discoStartTime = 0;

  const camera = new THREE.PerspectiveCamera(48, 1.6, 1, 5000);
  camera.position.set(0, 540, 600);
  camera.lookAt(0, 0, -10);

  // `world` holds everything; rotating it 90° mirrors the 2D "rotate" power-up.
  const world = new THREE.Group();
  scene.add(world);

  // --- lighting ---
  scene.add(new THREE.HemisphereLight('#9fb6ff', '#0a0f1c', 0.7));
  const sun = new THREE.DirectionalLight('#ffffff', 1.6);
  sun.position.set(180, 620, 360);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -550;
  sc.right = 550;
  sc.top = 400;
  sc.bottom = -400;
  sc.near = 100;
  sc.far = 1400;
  world.add(sun);
  world.add(sun.target); // target defaults to origin (court center)

  // --- static court ---
  const floorMat = new THREE.MeshStandardMaterial({ color: '#0b1020', roughness: 0.95, metalness: 0.0 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(COURT.w, COURT.h), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  world.add(floor);

  // Center line — a thin emissive strip down the middle of the court.
  const centerLine = new THREE.Mesh(
    new THREE.PlaneGeometry(4, COURT.h),
    new THREE.MeshBasicMaterial({ color: '#222e4a' }),
  );
  centerLine.rotation.x = -Math.PI / 2;
  centerLine.position.y = 0.5;
  world.add(centerLine);

  // A low rim around the court, like the 2D border.
  const rimMat = new THREE.MeshStandardMaterial({ color: '#2a3550', roughness: 0.8 });
  const rimH = 10;
  const rims: [number, number, number, number][] = [
    [COURT.w + 16, 6, 0, -COURT.h / 2 - 3], // top edge (z-)
    [COURT.w + 16, 6, 0, COURT.h / 2 + 3], // bottom edge (z+)
    [6, COURT.h + 16, -COURT.w / 2 - 3, 0], // left edge (x-)
    [6, COURT.h + 16, COURT.w / 2 + 3, 0], // right edge (x+)
  ];
  for (const [sx, sz, px, pz] of rims) {
    const rim = new THREE.Mesh(new THREE.BoxGeometry(sx, rimH, sz), rimMat);
    rim.position.set(px, rimH / 2, pz);
    rim.castShadow = true;
    rim.receiveShadow = true;
    world.add(rim);
  }

  // --- pooled dynamic objects ---
  const paddleGeo = new THREE.BoxGeometry(PADDLE.w, PADDLE_H, 1); // scaled in z to the side height
  const paddlePool: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>[] = [];
  const ballGeo = new THREE.SphereGeometry(1, 28, 20); // scaled to each ball's radius
  const ballPool: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>[] = [];

  // Cosmetic hats — each id builds a distinct little 3D model from primitives, sat atop a
  // paddle. Slots are pooled and rebuilt only when the worn hat changes.
  const mat = (color: string, emissive = '#000') => new THREE.MeshStandardMaterial({ color, emissive, roughness: 0.6 });
  function buildHat(id: string): THREE.Group {
    const g = new THREE.Group();
    const W = PADDLE.w; // ~14
    switch (id) {
      case 'tophat': {
        g.add(mesh(new THREE.CylinderGeometry(W * 0.9, W * 0.9, 1.6, 18), mat('#15171c'), 0));
        g.add(mesh(new THREE.CylinderGeometry(W * 0.55, W * 0.55, 12, 18), mat('#15171c'), 6.5));
        g.add(mesh(new THREE.CylinderGeometry(W * 0.56, W * 0.56, 2.5, 18), mat('#c0392b'), 2.5));
        break;
      }
      case 'crown': {
        g.add(mesh(new THREE.CylinderGeometry(W * 0.7, W * 0.7, 6, 18), mat('#ffd23f', '#5a4500'), 3));
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          const spike = mesh(new THREE.ConeGeometry(1.6, 6, 8), mat('#ffd23f', '#5a4500'), 8);
          spike.position.x = Math.cos(a) * W * 0.7; spike.position.z = Math.sin(a) * W * 0.7;
          g.add(spike);
        }
        g.add(mesh(new THREE.SphereGeometry(2, 12, 10), mat('#ff4d6d', '#400'), 9)); // jewel
        break;
      }
      case 'party': {
        g.add(mesh(new THREE.ConeGeometry(W * 0.6, 16, 20), mat('#ff7eb3'), 8));
        g.add(mesh(new THREE.SphereGeometry(2.4, 12, 10), mat('#ffe066', '#664'), 16));
        break;
      }
      case 'halo': {
        const ring = mesh(new THREE.TorusGeometry(W * 0.7, 1.4, 10, 24), mat('#ffe066', '#aa8800'), 9);
        ring.rotation.x = Math.PI / 2;
        g.add(ring);
        break;
      }
      case 'cowboy': {
        g.add(mesh(new THREE.CylinderGeometry(W * 1.1, W * 1.1, 1.4, 22), mat('#8a5a2b'), 0.5));
        g.add(mesh(new THREE.CylinderGeometry(W * 0.5, W * 0.6, 9, 18), mat('#704821'), 5));
        break;
      }
      case 'wizard': {
        g.add(mesh(new THREE.ConeGeometry(W * 0.62, 22, 20), mat('#3b2e7e', '#150f33'), 11));
        g.add(mesh(new THREE.SphereGeometry(1.6, 10, 8), mat('#ffe066', '#664'), 22));
        break;
      }
      case 'horns': {
        for (const dir of [-1, 1]) {
          const horn = mesh(new THREE.ConeGeometry(2.4, 9, 10), mat('#c0392b', '#300'), 4);
          horn.position.x = dir * 5; horn.rotation.z = dir * -0.5;
          g.add(horn);
        }
        break;
      }
      case 'gradcap': {
        g.add(mesh(new THREE.CylinderGeometry(W * 0.5, W * 0.5, 4, 16), mat('#15171c'), 2));
        g.add(mesh(new THREE.BoxGeometry(W * 1.5, 1.5, W * 1.5), mat('#15171c'), 4.5));
        const tassel = mesh(new THREE.CylinderGeometry(0.4, 0.4, 7, 6), mat('#ffd23f', '#553'), 2);
        tassel.position.x = W * 0.7; g.add(tassel);
        break;
      }
      case 'flame': {
        g.add(mesh(new THREE.ConeGeometry(5, 16, 10), mat('#ff5a1c', '#ff3000'), 8));
        g.add(mesh(new THREE.ConeGeometry(2.6, 9, 8), mat('#ffe066', '#aa6600'), 7));
        break;
      }
      case 'helmet': {
        const dome = mesh(new THREE.SphereGeometry(W * 0.75, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat('#5a7d3a', '#1a200c'), 0);
        g.add(dome);
        break;
      }
      case 'antennae': {
        for (const dir of [-1, 1]) {
          const stalk = mesh(new THREE.CylinderGeometry(0.5, 0.5, 10, 6), mat('#2a2a33'), 5);
          stalk.position.x = dir * 4; stalk.rotation.z = dir * -0.3;
          g.add(stalk);
          const ball = mesh(new THREE.SphereGeometry(2, 12, 10), mat('#ff5c5c', '#400'), 10);
          ball.position.x = dir * 6.5; g.add(ball);
        }
        break;
      }
      case 'saturn': {
        g.add(mesh(new THREE.SphereGeometry(5.5, 16, 12), mat('#e08a3c', '#3a1e08'), 11));
        const ring = mesh(new THREE.TorusGeometry(9, 0.9, 8, 28), mat('#e9c98a', '#5a4520'), 11);
        ring.rotation.x = Math.PI / 2 - 0.5; g.add(ring);
        break;
      }
      case 'propeller': {
        g.add(mesh(new THREE.SphereGeometry(W * 0.55, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat('#e8513b', '#3a0f08'), 1));
        const prop = new THREE.Group();
        for (const r of [0, Math.PI]) {
          const blade = mesh(new THREE.BoxGeometry(14, 0.6, 3), mat('#6cc1ff', '#123'), 0);
          blade.position.x = Math.cos(r) * 7; blade.position.z = Math.sin(r) * 7;
          blade.rotation.y = r;
          prop.add(blade);
        }
        prop.position.y = 8; prop.name = 'spin'; g.add(prop);
        break;
      }
      case 'flamingcrown': {
        g.add(mesh(new THREE.CylinderGeometry(W * 0.72, W * 0.72, 6, 18), mat('#ffd23f', '#5a4500'), 3));
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          const fl = mesh(new THREE.ConeGeometry(2, 8, 8), mat('#ff5a1c', '#ff3000'), 9);
          fl.position.x = Math.cos(a) * W * 0.72; fl.position.z = Math.sin(a) * W * 0.72;
          g.add(fl);
        }
        break;
      }
      case 'diamondtiara': {
        const band = mesh(new THREE.TorusGeometry(W * 0.7, 0.7, 8, 24, Math.PI), mat('#dfe7f5', '#445'), 2);
        band.rotation.x = Math.PI / 2; g.add(band);
        for (let i = -1; i <= 1; i++) {
          const gem = mesh(new THREE.OctahedronGeometry(i === 0 ? 2.6 : 1.8), mat('#9fe0ff', '#0a2a44'), i === 0 ? 6 : 4);
          gem.position.x = i * W * 0.5; g.add(gem);
        }
        break;
      }
      default:
        g.add(mesh(new THREE.CylinderGeometry(W * 0.55, W * 0.55, 12, 16), mat('#15171c'), 6.5));
    }
    return g;
  }
  function mesh(geo: THREE.BufferGeometry, material: THREE.Material, y: number): THREE.Mesh {
    const m = new THREE.Mesh(geo, material);
    m.position.y = y;
    return m;
  }
  // Pool of hat slots; each remembers which hat id it currently shows and rebuilds on change.
  const hatPool: { group: THREE.Group; id: string }[] = [];
  function getHat(i: number, id: string): THREE.Group {
    let slot = hatPool[i];
    if (!slot) { slot = { group: new THREE.Group(), id: '' }; world.add(slot.group); hatPool[i] = slot; }
    if (slot.id !== id) {
      for (const c of [...slot.group.children]) slot.group.remove(c);
      slot.group.add(...buildHat(id).children);
      slot.id = id;
    }
    return slot.group;
  }
  // Skin renderers (extend with more skins later). `t` is a time seed for animated skins.
  const SKIN3D: Record<string, (mat: THREE.MeshStandardMaterial, t: number) => void> = {
    rainbow: (mat, t) => { const c = new THREE.Color().setHSL((t * 0.0004) % 1, 0.9, 0.55); mat.color.copy(c); mat.emissive.copy(c); },
    gold: (mat) => { mat.color.set('#ffd23f'); mat.emissive.set('#5a4500'); },
    chrome: (mat) => { mat.color.set('#e5e7eb'); mat.emissive.set('#222'); },
    galaxy: (mat, t) => { const c = new THREE.Color().setHSL(0.72, 0.7, 0.35 + 0.1 * Math.sin(t / 400)); mat.color.copy(c); mat.emissive.set('#1b1448'); },
    lava: (mat, t) => { const g = 0.4 + 0.3 * Math.sin(t / 250); mat.color.setRGB(1, g, 0.1); mat.emissive.setRGB(0.6, 0.1, 0); },
    ice: (mat) => { mat.color.set('#dff3ff'); mat.emissive.set('#3a6b8a'); },
    camo: (mat) => { mat.color.set('#6b7d3a'); mat.emissive.set('#1a200c'); },
    neon: (mat, t) => { const p = 0.4 + 0.4 * Math.sin(t / 200); mat.color.set('#0a0a12'); mat.emissive.setRGB(0.2 * p, p, 0.08 * p); },
    stripes: (mat) => { mat.color.set('#f4c20d'); mat.emissive.set('#222'); },
    glitch: (mat, t) => { const c = new THREE.Color(['#ff003c', '#00fff0', '#b16bff'][Math.floor(t / 80) % 3]); mat.color.copy(c); mat.emissive.copy(c).multiplyScalar(0.4); },
    pickle: (mat) => { mat.color.set('#7cb342'); mat.emissive.set('#2e4310'); },
  };

  function getPaddle(i: number) {
    let m = paddlePool[i];
    if (!m) {
      m = new THREE.Mesh(
        paddleGeo,
        new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 }),
      );
      m.castShadow = true;
      m.receiveShadow = true;
      world.add(m);
      paddlePool[i] = m;
    }
    return m;
  }
  function getBall(i: number) {
    let m = ballPool[i];
    if (!m) {
      m = new THREE.Mesh(
        ballGeo,
        new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.1 }),
      );
      m.castShadow = true;
      world.add(m);
      ballPool[i] = m;
    }
    return m;
  }

  // Blaster projectiles: a bright green laser bolt (a glowing cylinder oriented along its
  // travel direction) with a tapered, fading trail behind it. Pooled as little groups.
  const LASER_GREEN = '#39ff14';
  const boltGeo = new THREE.CylinderGeometry(BLASTER.r * 0.7, BLASTER.r * 0.7, 34, 8);
  const trailGeo = new THREE.CylinderGeometry(BLASTER.r * 0.15, BLASTER.r * 1.0, 90, 8);
  const UP = new THREE.Vector3(0, 1, 0);
  const projPool: THREE.Group[] = [];
  function getProjectile(i: number) {
    let g = projPool[i];
    if (!g) {
      g = new THREE.Group();
      const bolt = new THREE.Mesh(
        boltGeo,
        new THREE.MeshStandardMaterial({ color: '#ccffc0', emissive: LASER_GREEN, emissiveIntensity: 1.4 }),
      );
      const trail = new THREE.Mesh(
        trailGeo,
        new THREE.MeshBasicMaterial({ color: LASER_GREEN, transparent: true, opacity: 0.35 }),
      );
      trail.position.y = -52; // sits behind the bolt along the group's local +Y (travel dir)
      g.add(bolt, trail);
      world.add(g);
      projPool[i] = g;
    }
    return g;
  }

  // Local player's aim line — a thin tube the armed player sees pointing where they'll shoot.
  const aimLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: '#ff8888', transparent: true, opacity: 0.7 }),
  );
  aimLine.visible = false;
  world.add(aimLine);

  // Power-up target: a hockey puck with the 2D power-up icon on its top face. The kind
  // changes, so pre-render every kind's face once and swap the top map / rim color.
  const PU_TEX = Object.fromEntries(
    POWERUPS.map((k) => [k, makePuckFaceTexture((c) => drawLegendIcon(c, k))]),
  ) as Record<PowerupKind, THREE.CanvasTexture>;
  const targetPuck = makePuck(TARGET.r, PU_TEX[POWERUPS[0]], PU_COLOR[POWERUPS[0]]);
  targetPuck.mesh.position.y = PUCK_Y;
  targetPuck.mesh.visible = false;
  world.add(targetPuck.mesh);

  // Diamond-hands obstacle: a puck with the 2D diamond logo on top.
  const diamondPuck = makePuck(DIAMOND.r, makePuckFaceTexture(drawDiamondIcon), '#2a4a8a');
  diamondPuck.mesh.position.y = PUCK_Y;
  diamondPuck.mesh.visible = false;
  world.add(diamondPuck.mesh);

  // Piñata: a drifting beach ball that catches balls; the caught ones cling to its surface.
  const pinata = new THREE.Mesh(
    new THREE.SphereGeometry(PINATA.r, 28, 20),
    new THREE.MeshStandardMaterial({ color: '#ff6abf', emissive: '#5a1038', emissiveIntensity: 0.4, roughness: 0.5 }),
  );
  pinata.castShadow = true;
  pinata.visible = false;
  world.add(pinata);
  const stuckGeo = new THREE.SphereGeometry(BALL.r, 16, 12);
  const stuckPool: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>[] = [];
  function getStuck(i: number) {
    let m = stuckPool[i];
    if (!m) {
      m = new THREE.Mesh(stuckGeo, new THREE.MeshStandardMaterial({ color: '#e8eefc', roughness: 0.4 }));
      world.add(m);
      stuckPool[i] = m;
    }
    return m;
  }

  // Spectator-dropped blocks: a pool of slate boxes, scaled per block (unit geometry in x/z).
  const BLOCK_H = 22; // how tall a block stands off the floor in 3D
  const blockGeo = new THREE.BoxGeometry(1, BLOCK_H, 1);
  const blockPool: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>[] = [];
  function getBlock(i: number) {
    let m = blockPool[i];
    if (!m) {
      m = new THREE.Mesh(blockGeo, new THREE.MeshStandardMaterial({ color: '#46506e', emissive: '#10131c', emissiveIntensity: 0.3, roughness: 0.7 }));
      m.castShadow = true;
      world.add(m);
      blockPool[i] = m;
    }
    return m;
  }

  // Scores painted big on the ice either side of center; names painted smaller at each end.
  const scoreL = makeFloorText(150);
  const scoreR = makeFloorText(150);
  scoreL.mesh.position.set(-110, 0.6, -90);
  scoreR.mesh.position.set(110, 0.6, -90);
  const nameL = makeFloorText(150);
  const nameR = makeFloorText(150);
  nameL.mesh.position.set(-150, 0.6, 200);
  nameR.mesh.position.set(150, 0.6, 200);
  world.add(scoreL.mesh, scoreR.mesh, nameL.mesh, nameR.mesh);

  const tmpColor = new THREE.Color();
  const tmpVec = new THREE.Vector3();

  let fritzOn = false;
  function applyFloor() {
    // Disco beats fritz for the floor; fritz still wins for the scene backdrop.
    floorMat.map = discoOn ? danceTex : fritzOn ? fritzTex : null;
    floorMat.color.set(discoOn || fritzOn ? '#ffffff' : '#0b1020');
    floorMat.needsUpdate = true;
    scene.background = fritzOn && !discoOn ? fritzTex : DEFAULT_BG;
  }

  function render(s: StateMsg, fpSide?: 'left' | 'right' | null, aim?: BlasterAim | null) {
    world.rotation.y = s.rotated * (Math.PI / 2);

    // Fritz power-up: paint the photo across the court floor and the scene backdrop.
    if (!!s.fritz !== fritzOn) {
      fritzOn = !!s.fritz;
      applyFloor();
    }

    // Disco power-up: chrome ball drops, dance floor, orbiting coloured lights.
    if (!!s.disco !== discoOn) {
      discoOn = !!s.disco;
      if (discoOn) {
        discoBallMesh.position.set(0, 600, 0);
        discoBallMesh.visible = true;
        discoStartTime = performance.now();
      } else {
        discoBallMesh.visible = false;
        discoLights.forEach((l) => { l.intensity = 0; });
      }
      applyFloor();
    }
    if (discoOn) {
      const elapsed = (performance.now() - discoStartTime) / 1000;
      // Ease the ball down from y=600 to y=130 over 1.5 s (cubic ease-out).
      const t = Math.min(1, elapsed / 1.5);
      const eased = 1 - Math.pow(1 - t, 3);
      discoBallMesh.position.y = 600 + (130 - 600) * eased;
      // Gentle bob once it arrives.
      if (t >= 1) discoBallMesh.position.y = 130 + Math.sin(elapsed * 1.8) * 8;
      discoBallMesh.rotation.y = elapsed * 0.9;

      // Orbit lights around the ball at staggered angles and heights.
      const by = discoBallMesh.position.y;
      discoLights.forEach((l, i) => {
        const angle = elapsed * (0.7 + i * 0.12) + (i / DISCO_COLORS.length) * Math.PI * 2;
        const radius = 280 + i * 25;
        l.position.set(Math.cos(angle) * radius, by + Math.sin(elapsed * 1.1 + i) * 90, Math.sin(angle) * radius);
        l.intensity = 3.5;
      });

      // Animate the dance-floor checkerboard — shift hue per cell per frame.
      const cell = 64;
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
          const hue = ((row * 42 + col * 27 + elapsed * 90) % 360);
          const bright = 35 + ((row + col + Math.floor(elapsed * 5)) % 2) * 25;
          danceCtx.fillStyle = `hsl(${hue},100%,${bright}%)`;
          danceCtx.fillRect(col * cell, row * cell, cell, cell);
        }
      }
      danceCtx.strokeStyle = 'rgba(0,0,0,0.35)';
      danceCtx.lineWidth = 2;
      for (let i = 0; i <= 8; i++) {
        danceCtx.beginPath(); danceCtx.moveTo(i * cell, 0); danceCtx.lineTo(i * cell, 512); danceCtx.stroke();
        danceCtx.beginPath(); danceCtx.moveTo(0, i * cell); danceCtx.lineTo(512, i * cell); danceCtx.stroke();
      }
      danceTex.needsUpdate = true;
    }

    // First-person camera: position behind the watched side's paddle, looking down-court.
    if (fpSide) {
      const p = s.paddles[fpSide];
      const avgY = p.players.length
        ? p.players.reduce((sum, pl) => sum + pl.y, 0) / p.players.length
        : COURT.h / 2;
      const paddleX = fpSide === 'left' ? COURT.w * 0.04 : COURT.w * 0.96;
      const behindX = fpSide === 'left' ? wx(paddleX) - 180 : wx(paddleX) + 180;
      camera.position.set(behindX, 110, wz(avgY));
      camera.lookAt(fpSide === 'left' ? wx(COURT.w * 0.7) : wx(COURT.w * 0.3), 30, wz(avgY));
    } else {
      camera.position.set(0, 540, 600);
      camera.lookAt(0, 0, -10);
    }

    // Paddles — one box per seated player, sized to that side's current height.
    let pi = 0;
    let mi = 0; // minion-sprite index
    let oi = 0; // otto-sprite index (first-person minion)
    let hi = 0; // hat-mesh index
    const minionAspect = (minionTex.image && (minionTex.image as HTMLImageElement).naturalWidth)
      ? (minionTex.image as HTMLImageElement).naturalWidth / (minionTex.image as HTMLImageElement).naturalHeight
      : 1.31;
    for (const side of ['left', 'right'] as const) {
      const p = s.paddles[side];
      const list = p.players.length ? p.players : [];
      for (const pl of list) {
        if (s.minion) {
          if (fpSide) {
            // First-person: Otto becomes the paddle — stretched to the paddle's full width
            // and ~3× the paddle box height, standing on the floor.
            const ottoH = PADDLE_H * 3;
            const sp = getOttoSprite(oi++);
            sp.visible = true;
            sp.scale.set(p.h, ottoH, 1);
            sp.position.set(wx(pl.x), ottoH / 2, wz(pl.y));
          } else {
            // Replace the box with a camera-facing minion billboard, sized to the paddle height.
            const sp = getMinionSprite(mi++);
            sp.visible = true;
            sp.scale.set(p.h * minionAspect, p.h, 1);
            sp.position.set(wx(pl.x), p.h / 2, wz(pl.y));
          }
          continue;
        }
        const m = getPaddle(pi++);
        m.visible = true;
        m.position.set(wx(pl.x), PADDLE_H / 2, wz(pl.y));
        m.scale.z = p.h;
        // Blaster-locked paddles go gray and flicker; otherwise the cosmetic skin or color.
        const locked = p.disabled;
        const skinFn = !locked && pl.skin ? SKIN3D[pl.skin] : undefined;
        if (skinFn) {
          skinFn(m.material, Date.now());
        } else {
          m.material.color.set(locked ? '#555a66' : pl.color);
          m.material.emissive.set(locked ? '#ff3030' : pl.color);
        }
        m.material.emissiveIntensity = locked ? 0.25 + 0.2 * Math.abs(Math.sin(Date.now() / 90)) : p.frozen ? 0.05 : 0.22;
        m.material.opacity = 1;
        // Cosmetic hat sits on top of the paddle box (distinct 3D model per hat).
        if (pl.hat) {
          const hat = getHat(hi++, pl.hat);
          hat.visible = true;
          const bob = (pl.hat === 'halo' || pl.hat === 'saturn') ? 4 + Math.sin(Date.now() / 300) * 2 : 1;
          hat.position.set(wx(pl.x), PADDLE_H + bob, wz(pl.y));
          if (pl.hat === 'flame' || pl.hat === 'flamingcrown') hat.scale.setScalar(0.9 + 0.15 * Math.abs(Math.sin(Date.now() / 120)));
          else hat.scale.setScalar(1);
          if (pl.hat === 'propeller') { const sp = hat.getObjectByName('spin'); if (sp) sp.rotation.y = Date.now() / 90; }
        }
      }
    }
    for (let i = pi; i < paddlePool.length; i++) paddlePool[i].visible = false;
    for (let i = mi; i < minionSprites.length; i++) minionSprites[i].visible = false;
    for (let i = oi; i < ottoSprites.length; i++) ottoSprites[i].visible = false;
    for (let i = hi; i < hatPool.length; i++) hatPool[i].group.visible = false;

    // Balls — main ball plus any "multi" extras; radius follows tiny/bigball power-ups.
    const ballR = s.tinyBall ? 3 : s.bigBall ? BIG_BALL_R : BALL.r;
    const balls = [s.ball, ...s.extraBalls];
    balls.forEach((b, i) => {
      const m = getBall(i);
      m.visible = true;
      m.scale.setScalar(ballR);
      m.position.set(wx(b.x), Math.max(ballR, BALL_Y), wz(b.y));
      m.material.color.set(b.color);
      m.material.emissive.set(tmpColor.set(b.color).multiplyScalar(0.4));
    });
    for (let i = balls.length; i < ballPool.length; i++) ballPool[i].visible = false;

    // Blaster projectiles — bright green laser bolts oriented along their travel direction.
    s.projectiles.forEach((pr, i) => {
      const g = getProjectile(i);
      g.visible = true;
      g.position.set(wx(pr.x), BALL_Y, wz(pr.y));
      const sp = Math.hypot(pr.vx, pr.vy) || 1;
      // Court velocity (vx, vy) maps to world (x, z); align the group's +Y with travel dir.
      const dir = tmpVec.set(pr.vx / sp, 0, pr.vy / sp);
      g.quaternion.setFromUnitVectors(UP, dir);
    });
    for (let i = s.projectiles.length; i < projPool.length; i++) projPool[i].visible = false;

    // Aim line for the local armed player.
    if (aim) {
      const p = s.paddles[aim.side];
      const dir = aim.side === 'left' ? 1 : -1;
      const ox = p.x + dir * (PADDLE.w / 2 + 2);
      const len = 170;
      const ex = ox + dir * Math.cos(aim.angle) * len;
      const ey = p.y + Math.sin(aim.angle) * len;
      aimLine.visible = true;
      (aimLine.geometry as THREE.BufferGeometry).setFromPoints([
        new THREE.Vector3(wx(ox), BALL_Y, wz(p.y)),
        new THREE.Vector3(wx(ex), BALL_Y, wz(ey)),
      ]);
    } else {
      aimLine.visible = false;
    }

    // Power-up target — a puck with the kind's 2D icon on top, rim tinted to the kind.
    if (s.target) {
      targetPuck.mesh.visible = true;
      targetPuck.mesh.position.set(wx(s.target.x), PUCK_Y, wz(s.target.y));
      targetPuck.top.map = PU_TEX[s.target.kind];
      targetPuck.side.color.set(PU_COLOR[s.target.kind] ?? '#ffd166');
    } else {
      targetPuck.mesh.visible = false;
    }

    // Diamond-hands obstacle — a puck with the 2D diamond logo (diamond mode only).
    if (s.diamondPos) {
      diamondPuck.mesh.visible = true;
      diamondPuck.mesh.position.set(wx(s.diamondPos.x), PUCK_Y, wz(s.diamondPos.y));
    } else {
      diamondPuck.mesh.visible = false;
    }

    // Piñata collector + the balls clinging to it (piñata mode only).
    if (s.pinataPos) {
      pinata.visible = true;
      pinata.position.set(wx(s.pinataPos.x), PINATA.r, wz(s.pinataPos.y));
      pinata.rotation.y = s.pinataPos.spin;
      pinata.material.emissiveIntensity = s.pinataPos.burst ? 2.2 : 0.4; // flash on a burst
      s.pinataPos.stuck.forEach((st, i) => {
        const m = getStuck(i);
        m.visible = true;
        m.position.set(wx(st.x), PINATA.r, wz(st.y));
      });
      for (let i = s.pinataPos.stuck.length; i < stuckPool.length; i++) stuckPool[i].visible = false;
    } else {
      pinata.visible = false;
      for (const m of stuckPool) m.visible = false;
    }

    // Spectator-dropped blocks — slate boxes scaled to each block's footprint.
    s.blocks.forEach((bl, i) => {
      const m = getBlock(i);
      m.visible = true;
      m.position.set(wx(bl.x), BLOCK_H / 2, wz(bl.y));
      m.scale.set(bl.w, 1, bl.h);
      m.material.color.setHSL(blockHue(bl.x, bl.y) / 360, 0.68, 0.5);
    });
    for (let i = s.blocks.length; i < blockPool.length; i++) blockPool[i].visible = false;

    // Scores (big) and names (small) painted on the ice.
    scoreL.set(String(s.score.left), '#7da2ff', 116);
    scoreR.set(String(s.score.right), '#7da2ff', 116);
    nameL.set(s.paddles.left.name ?? '— open —', s.paddles.left.color ?? '#9fb0d8', 60);
    nameR.set(s.paddles.right.name ?? '— open —', s.paddles.right.color ?? '#9fb0d8', 60);

    renderer.render(scene, camera);
  }

  function resize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();

  function dispose() {
    renderer.dispose();
    renderer.domElement.remove();
  }

  return { render, resize, dispose };
}
