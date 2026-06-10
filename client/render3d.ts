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
import { COURT, PADDLE, BALL, BIG_BALL_R, TARGET, StateMsg } from '../shared/types';

export interface Renderer3D {
  render(s: StateMsg): void;
  resize(): void;
  dispose(): void;
}

const PADDLE_H = 22; // visual paddle height (the dimension that only exists in 3D)
const BALL_Y = 11; // height of ball centers above the floor (roughly mid-paddle)
const wx = (x: number) => x - COURT.w / 2;
const wz = (y: number) => y - COURT.h / 2;

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

  // Power-up target: a slowly spinning glowing ring on the floor.
  const target = new THREE.Mesh(
    new THREE.TorusGeometry(TARGET.r, 4, 12, 32),
    new THREE.MeshStandardMaterial({ color: '#ffd166', emissive: '#7a5a10', roughness: 0.5 }),
  );
  target.rotation.x = -Math.PI / 2;
  target.position.y = 6;
  target.visible = false;
  world.add(target);

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

    // Power-up target.
    if (s.target) {
      target.visible = true;
      target.position.set(wx(s.target.x), 6, wz(s.target.y));
      target.rotation.z += 0.03;
    } else {
      target.visible = false;
    }

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
