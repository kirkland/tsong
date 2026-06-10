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
import { COURT, PADDLE, BALL, BIG_BALL_R, DIAMOND, PINATA, TARGET, PowerupKind, StateMsg } from '../shared/types';

export interface Renderer3D {
  render(s: StateMsg): void;
  resize(): void;
  dispose(): void;
}

const PADDLE_H = 22; // visual paddle height (the dimension that only exists in 3D)
const BALL_Y = 11; // height of ball centers above the floor (roughly mid-paddle)
const wx = (x: number) => x - COURT.w / 2;
const wz = (y: number) => y - COURT.h / 2;

// Per-kind power-up target color (mirrors the 2D legend so the ring reads the same).
const PU_COLOR: Record<PowerupKind, string> = {
  grow: '#ffd166', shrink: '#ff6b6b', smash: '#ff922b', slow: '#4dd2ff', multi: '#b197fc',
  freeze: '#74c0fc', curve: '#63e6be', blind: '#868e96', mirror: '#f783ac', shield: '#f5cc00',
  ghost: '#c0c8e0', tiny: '#ffa94d', warp: '#9775fa', bigball: '#ffd43b', rotate: '#69db7c',
};

// A camera-facing text label drawn from a 2D canvas texture, used for scores, names and the
// power-up kind. `widthWorld` sets its size in world units; the canvas is 2:1 so height is half.
function makeLabel(widthWorld: number) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const c2d = canvas.getContext('2d')!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }),
  );
  sprite.scale.set(widthWorld, widthWorld / 2, 1);
  sprite.renderOrder = 10; // always read on top of the geometry
  let last = '';
  function set(text: string, color: string, px = 150) {
    const key = `${text}|${color}|${px}`;
    if (key === last) return; // only repaint the texture when the content changes
    last = key;
    c2d.clearRect(0, 0, canvas.width, canvas.height);
    let f = px;
    const font = (n: number) => `bold ${n}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    c2d.font = font(f);
    while (c2d.measureText(text).width > canvas.width * 0.92 && f > 18) c2d.font = font((f -= 8));
    c2d.textAlign = 'center';
    c2d.textBaseline = 'middle';
    c2d.lineWidth = f * 0.16;
    c2d.strokeStyle = 'rgba(0,0,0,0.7)';
    c2d.strokeText(text, canvas.width / 2, canvas.height / 2);
    c2d.fillStyle = color;
    c2d.fillText(text, canvas.width / 2, canvas.height / 2);
    tex.needsUpdate = true;
  }
  return { sprite, set };
}

export function createRenderer(container: HTMLElement): Renderer3D {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#060912');

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
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(COURT.w, COURT.h),
    new THREE.MeshStandardMaterial({ color: '#0b1020', roughness: 0.95, metalness: 0.0 }),
  );
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

  // Power-up target: a glowing ring over a translucent disc, tinted to the kind, with the
  // kind name floating above it so it reads exactly like the 2D legend.
  const targetGroup = new THREE.Group();
  const targetRing = new THREE.Mesh(
    new THREE.TorusGeometry(TARGET.r, 4, 12, 32),
    new THREE.MeshStandardMaterial({ color: '#ffd166', emissive: '#7a5a10', roughness: 0.5 }),
  );
  targetRing.rotation.x = -Math.PI / 2;
  targetRing.position.y = 6;
  const targetDisc = new THREE.Mesh(
    new THREE.CircleGeometry(TARGET.r, 32),
    new THREE.MeshBasicMaterial({ color: '#ffd166', transparent: true, opacity: 0.4, side: THREE.DoubleSide }),
  );
  targetDisc.rotation.x = -Math.PI / 2;
  targetDisc.position.y = 3;
  const targetLabel = makeLabel(120);
  targetLabel.sprite.position.y = 54;
  targetGroup.add(targetRing, targetDisc, targetLabel.sprite);
  targetGroup.visible = false;
  world.add(targetGroup);

  // Diamond-hands obstacle: a faceted gem that drifts and spins.
  const diamond = new THREE.Mesh(
    new THREE.OctahedronGeometry(DIAMOND.r, 0),
    new THREE.MeshStandardMaterial({ color: '#bcd6ff', emissive: '#24467f', metalness: 0.35, roughness: 0.12, flatShading: true }),
  );
  diamond.castShadow = true;
  diamond.visible = false;
  world.add(diamond);

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

  // Floating scoreboard (one digit per side, near the back edge) and per-side name labels.
  const scoreL = makeLabel(86);
  const scoreR = makeLabel(86);
  scoreL.sprite.position.set(-80, 86, -200);
  scoreR.sprite.position.set(80, 86, -200);
  const nameL = makeLabel(230);
  const nameR = makeLabel(230);
  nameL.sprite.position.set(-232, 40, 214);
  nameR.sprite.position.set(232, 40, 214);
  world.add(scoreL.sprite, scoreR.sprite, nameL.sprite, nameR.sprite);

  const tmpColor = new THREE.Color();

  function render(s: StateMsg) {
    world.rotation.y = s.rotated ? Math.PI / 2 : 0;

    // Paddles — one box per seated player, sized to that side's current height.
    let pi = 0;
    for (const side of ['left', 'right'] as const) {
      const p = s.paddles[side];
      const list = p.players.length ? p.players : [];
      for (const pl of list) {
        const m = getPaddle(pi++);
        m.visible = true;
        m.position.set(wx(pl.x), PADDLE_H / 2, wz(pl.y));
        m.scale.z = p.h;
        m.material.color.set(pl.color);
        m.material.emissive.set(pl.color);
        m.material.emissiveIntensity = p.frozen ? 0.05 : 0.22;
        m.material.opacity = 1;
      }
    }
    for (let i = pi; i < paddlePool.length; i++) paddlePool[i].visible = false;

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

    // Power-up target — ring + disc + floating kind label, tinted to the kind.
    if (s.target) {
      targetGroup.visible = true;
      targetGroup.position.set(wx(s.target.x), 0, wz(s.target.y));
      targetRing.rotation.z += 0.03;
      const col = PU_COLOR[s.target.kind] ?? '#ffd166';
      targetRing.material.color.set(col);
      targetRing.material.emissive.set(tmpColor.set(col).multiplyScalar(0.4));
      targetDisc.material.color.set(col);
      targetLabel.set(s.target.kind, col, 84);
    } else {
      targetGroup.visible = false;
    }

    // Diamond-hands obstacle (diamond mode only).
    if (s.diamondPos) {
      diamond.visible = true;
      diamond.position.set(wx(s.diamondPos.x), DIAMOND.r * 0.9, wz(s.diamondPos.y));
      diamond.rotation.y += 0.02;
    } else {
      diamond.visible = false;
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

    // Scoreboard + names.
    scoreL.set(String(s.score.left), '#7da2ff', 150);
    scoreR.set(String(s.score.right), '#7da2ff', 150);
    nameL.set(s.paddles.left.name ?? '— open —', s.paddles.left.color ?? '#9fb0d8', 96);
    nameR.set(s.paddles.right.name ?? '— open —', s.paddles.right.color ?? '#9fb0d8', 96);

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
