// "Bolwoing Alley" — first-person PvP bowling for 2–4 players.
// Raycaster-style lane perspective (like doom.ts): scan-line floor casting,
// perspective-projected 3D pins, foreground arm+ball. Hold click to charge
// power, release to throw. Pure canvas overlay, self-contained rAF loop.

export interface BowlingNet {
  bowlJoin(): void;
  bowlReady(): void;
  bowlThrow(offset: number, power: number): void;
  bowlLeave(): void;
  name(): string;
  selfId(): string;
}

// ─── Perspective constants ────────────────────────────────────────────────────
const W = 900, H = 560;
const VP_X = W / 2;           // vanishing point X (lane center)
const VP_Y = 215;             // horizon line Y
const FOCAL = 320;            // perspective focal length
const CAM_H = 0.72;           // camera height above floor (world units)
const LANE_HW = 0.62;         // lane half-width (world units)
const PIN_Z0 = 10.0;          // head-pin Z distance (world units)
const PIN_VH = 0.65;          // visual pin height
const LANE_LEN = 14.0;        // visible lane depth

// 10 pin world positions (x = left/right, z = offset from head pin away from camera)
const PIN_WXZ: [number, number][] = [
  [0, 0],
  [-0.30, 0.26], [0.30, 0.26],
  [-0.60, 0.52], [0, 0.52], [0.60, 0.52],
  [-0.90, 0.78], [-0.30, 0.78], [0.30, 0.78], [0.90, 0.78],
];

// Project a world point (wx, wy, wz) to screen. Returns null if behind camera.
function proj(wx: number, wy: number, wz: number): [number, number, number] | null {
  if (wz <= 0.01) return null;
  const s = FOCAL / wz;
  return [VP_X + wx * s, VP_Y + (CAM_H - wy) * s, s];
}

// ─── State machine ────────────────────────────────────────────────────────────
type Phase = 'waiting' | 'lobby' | 'beer' | 'aiming' | 'charging' | 'rolling' | 'pinfalling' | 'scored' | 'over';
interface RemotePlayer { id: string; name: string; color: string; ready: boolean; }
interface FallingPin { idx: number; wx: number; wz: number; vy: number; rz: number; rSpeed: number; alpha: number; t: number; }
interface Particle { x: number; y: number; vx: number; vy: number; c: string; life: number; sz: number; }
interface Cel { kind: 'strike' | 'spare' | 'gutter' | 'turkey' | 'perfect' | 'strikality'; t: number; dur: number; }

let bowlingOpen = false, rafId = 0;
let net: BowlingNet, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, overlay: HTMLDivElement;
let phase: Phase = 'waiting';
let selfId = '', selfName = '';
let roomPlayers: RemotePlayer[] = [];
let currentPlayerId = '';
let pinState: boolean[] = new Array(10).fill(true);
let scores: Record<string, number[]> = {};
let frames: Record<string, number[][]> = {};
let ranked: { id: string; name: string; color: string; score: number }[] = [];
let isMyTurn = false;
let ballInFrame = 1;   // 1 or 2 — shown prominently in HUD
let pinsStandingBefore = 10; // count before this ball, for "X pins remaining" display

// Drunk level: 0 = sober, increases each beer (max 6).
// Affects aim wobble, canvas sway, and throw offset sent to server.
let drunkLevel = 0;
const DRUNK_MAX = 6;

// Pending throw result (cached until the roll animation completes)
let pendingResult: any = null;
// Pending bowlNextBall/bowlNextTurn (cached until the pin-fall animation completes)
let pendingNext: any = null;
// Timer ID for the pin-fall → next-turn transition (so we can cancel stale timers)
let pinFallTimer = 0;

// Drag-to-throw controls (slingshot / inverse):
//   • mousedown / touchstart — anchor the drag origin
//   • drag left/right        — aim  (−1 = left gutter, +1 = right)
//   • drag DOWN (toward you) — power (pulling back like a slingshot)
//   • release                — fire
const DRAG_POW_SCALE  = 180;   // px of downward drag  → power 0–1
let dragging = false;
let dragCurX = 0, dragCurY = 0;
let chargeT = 0;  // unused with drag controls but kept to avoid breakage
const CHARGE_FULL = 1.2;
let lockedAim = 0, lockedPower = 0;
// Aim wobble — accumulates while pulling for power; release timing matters
let aimWobbleT = 0;

// Ball roll animation (shown for ALL players' throws, not just own)
let rollT = 0;
const ROLL_DUR = 0.9;      // seconds for ball to reach pins
let rollBallX = VP_X, rollBallY = H - 40, rollBallR = 52;

// Falling pin list
let fallingPins: FallingPin[] = [];
// Particles
let particles: Particle[] = [];
// Celebration
let cel: Cel | null = null;
// Screen shake
let shakeT = 0, shakePow = 0;
// Rumble sound
let audioCtx: AudioContext | null = null;
// Time
let lastTs = 0;

// ─── Entry / exit ─────────────────────────────────────────────────────────────
export function openBowling(netAdapter: BowlingNet) {
  if (bowlingOpen) return;
  bowlingOpen = true;
  net = netAdapter;
  selfId = net.selfId();
  selfName = net.name();

  overlay = document.createElement('div');
  overlay.id = 'bowlOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:900;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;';

  canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.style.cssText = 'width:min(100vw,900px);height:auto;cursor:none;touch-action:none;';
  ctx = canvas.getContext('2d')!;

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:10px;margin-top:8px;';
  const readyBtn = document.createElement('button');
  readyBtn.id = 'bowlReadyBtn';
  readyBtn.textContent = '✅ Ready';
  readyBtn.style.cssText = bs('#1c5c1c');
  readyBtn.onclick = () => { net.bowlReady(); readyBtn.disabled = true; };
  const leaveBtn = document.createElement('button');
  leaveBtn.textContent = '🚪 Leave';
  leaveBtn.style.cssText = bs('#5c1c1c');
  leaveBtn.onclick = () => closeBowling();
  bar.append(readyBtn, leaveBtn);
  overlay.append(canvas, bar);
  document.body.appendChild(overlay);

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup',   onUp);
  canvas.addEventListener('touchstart', onTS, { passive: false });
  canvas.addEventListener('touchmove',  onTM, { passive: false });
  canvas.addEventListener('touchend',   onTE, { passive: false });
  document.addEventListener('keydown', onKey);

  resetLocal();
  setPhase('waiting');
  net.bowlJoin();
  lastTs = performance.now();
  rafId = requestAnimationFrame(loop);
}

function bs(bg: string) {
  return `background:${bg};color:#fff;border:none;padding:8px 20px;border-radius:6px;font:14px system-ui;cursor:pointer;`;
}
function setPhase(p: Phase) {
  phase = p;
  if (canvas) canvas.style.cursor = (p === 'beer' || p === 'lobby' || p === 'over' || p === 'waiting') ? 'default' : 'none';
}
function resetLocal() {
  pinState = new Array(10).fill(true);
  fallingPins = []; particles = []; cel = null; pendingResult = null; pendingNext = null;
  if (pinFallTimer) { clearTimeout(pinFallTimer); pinFallTimer = 0; }
  rollT = 0; chargeT = 0; aimWobbleT = 0; shakeT = 0;
  dragging = false; dragCurX = 0; dragCurY = 0;
  isMyTurn = false; ballInFrame = 1; pinsStandingBefore = 10;
  // drunkLevel intentionally NOT reset here — beer accumulates all game.
}

export function closeBowling() {
  if (!bowlingOpen) return;
  bowlingOpen = false;
  drunkLevel = 0;  // sober up when you leave the alley
  net.bowlLeave();
  cancelAnimationFrame(rafId);
  canvas.removeEventListener('pointermove', onMove);
  canvas.removeEventListener('pointerdown', onDown);
  canvas.removeEventListener('pointerup',   onUp);
  canvas.removeEventListener('touchstart', onTS);
  canvas.removeEventListener('touchmove',  onTM);
  canvas.removeEventListener('touchend',   onTE);
  document.removeEventListener('keydown', onKey);
  overlay?.remove();
}
export function isBowlingOpen() { return bowlingOpen; }

// ─── Server messages ──────────────────────────────────────────────────────────
export function onBowlMsg(msg: any) {
  if (!bowlingOpen) return;
  switch (msg.type) {
    case 'bowlState': case 'bowlStart': applyState(msg); break;
    case 'bowlThrowResult': applyResult(msg); break;
    case 'bowlNextBall': case 'bowlNextTurn': applyNext(msg); break;
    case 'bowlGameOver': applyOver(msg); break;
  }
}
function applyState(m: any) {
  roomPlayers = m.players ?? [];
  scores = m.scores ?? {}; frames = m.frames ?? {};
  if (m.phase === 'playing' || m.phase === 'over') {
    currentPlayerId = m.currentPlayerId ?? '';
    pinState = m.pinState ?? new Array(10).fill(true);
    isMyTurn = currentPlayerId === selfId;
    // Determine ball in frame from frame data
    const curFr = (frames[currentPlayerId] ?? []);
    const lastFrBalls = (curFr[curFr.length - 1] ?? []).length;
    ballInFrame = lastFrBalls >= 1 ? 2 : 1;
    pinsStandingBefore = pinState.filter(Boolean).length;
    if (m.phase === 'over') {
      setPhase('over');
    } else if (isMyTurn && ballInFrame === 1) {
      setPhase('beer');
    } else {
      setPhase(isMyTurn ? 'aiming' : 'scored');
    }
  } else { setPhase('lobby'); }
  if (m.ranked) { ranked = m.ranked; setPhase('over'); }
  syncReadyBtn();
}
function applyResult(m: any) {
  // Cache the result; apply pin-fall once the roll animation reaches the pins.
  pendingResult = m;

  if (phase !== 'rolling') {
    // Opponent's throw (or reconnect) — start a fresh roll animation.
    const throwOffset = typeof m.offset === 'number' ? m.offset : 0;
    lockedAim = throwOffset;
    rollBallX = VP_X + throwOffset * W * 0.22;
    rollBallY = H - 40;
    rollBallR = 52;
    rollT = 0;
    setPhase('rolling');
    playRollSfx();
  }
  // Own throw: fireThrow() already started the animation — just let it run.
}

function applyPendingResult() {
  const m = pendingResult;
  pendingResult = null;
  if (!m) return;

  pinState = m.pinState ?? pinState;
  scores = m.scores ?? scores; frames = m.frames ?? frames;
  const down: number[] = m.pinsDown ?? [];

  // Spawn falling pins
  for (const i of down) {
    const [wx, wz] = PIN_WXZ[i];
    fallingPins.push({ idx: i, wx, wz: PIN_Z0 + wz, vy: 1.5 + Math.random(), rz: 0, rSpeed: (Math.random() - 0.5) * 5, alpha: 1, t: 0 });
  }

  // Screen shake proportional to pins knocked
  shakeT = 0.35 + down.length * 0.04;
  shakePow = Math.min(down.length * 2 + 3, 18);
  if (down.length > 0) playPinCrash(down.length);

  // Celebration
  const pf = frames[m.playerId] ?? [];
  const lf = pf[pf.length - 1] ?? [];
  const b1 = lf[0] ?? 0, b2 = lf[1] ?? 0;
  if (b1 === 10 && lf.length === 1) {
    let cs = 1;
    for (let fi = pf.length - 2; fi >= 0; fi--) { if (pf[fi][0] === 10) cs++; else break; }
    if (cs >= 3) {
      trigCel('turkey', 3.5);
    } else {
      // 50% chance of STRIKALITY for any strike if it's our turn (or solo)
      const doStrikality = m.playerId === selfId && Math.random() < 0.5;
      trigCel(doStrikality ? 'strikality' : 'strike', doStrikality ? 4.5 : 2.8);
    }
  } else if (lf.length === 2 && b1 + b2 === 10) {
    trigCel('spare', 2.0);
  } else if (down.length === 0) {
    trigCel('gutter', 1.4);
  }
  pinsStandingBefore = pinState.filter(Boolean).length;
  setPhase('pinfalling');
  if (pinFallTimer) clearTimeout(pinFallTimer);
  pinFallTimer = window.setTimeout(() => {
    pinFallTimer = 0;
    if (!bowlingOpen) return;
    if (pendingNext) {
      const m = pendingNext; pendingNext = null;
      _applyNext(m);
    } else {
      setPhase('scored');
    }
  }, 1200);
}
function applyNext(m: any) {
  // bowlNextBall/Turn arrives immediately after bowlThrowResult from the server.
  // If we're still animating the roll or pin-fall, defer until the animation ends.
  if (phase === 'rolling' || phase === 'pinfalling') {
    pendingNext = m;
  } else {
    _applyNext(m);
  }
}
function _applyNext(m: any) {
  pinState = m.pinState ?? new Array(10).fill(true);
  scores = m.scores ?? scores; frames = m.frames ?? frames;
  currentPlayerId = m.playerId ?? m.currentPlayerId;
  isMyTurn = currentPlayerId === selfId;
  fallingPins = []; chargeT = 0; pendingResult = null;
  // bowlNextBall = still same player, 2nd ball; bowlNextTurn = new player's first ball
  ballInFrame = m.type === 'bowlNextBall' ? 2 : 1;
  pinsStandingBefore = pinState.filter(Boolean).length;
  // On new turns (ball 1), offer a beer before aiming. Ball 2 goes straight to aiming.
  if (isMyTurn && ballInFrame === 1) {
    setPhase('beer');
  } else {
    setPhase(isMyTurn ? 'aiming' : 'scored');
  }
}
function applyOver(m: any) {
  ranked = m.ranked ?? []; scores = m.scores ?? scores; frames = m.frames ?? frames;
  setPhase('over');
  const w = ranked[0];
  if (w && (scores[w.id]?.pop() ?? 0) >= 300) trigCel('perfect', 7);
}

function trigCel(kind: Cel['kind'], dur: number) {
  cel = { kind, t: 0, dur };
  if (kind === 'strikality') { playStrikeSfx(); return; } // no fireworks — visual is the effect
  if (kind !== 'gutter') spawnFW(kind === 'perfect' ? 250 : kind === 'turkey' ? 160 : kind === 'spare' ? 50 : 90);
  if (kind === 'strike' || kind === 'turkey' || kind === 'perfect') playStrikeSfx();
}
function spawnFW(n: number) {
  const COLS = ['#ff2244','#ffcc00','#44ff88','#44ccff','#ff44ff','#fff','#ff8800'];
  for (let i = 0; i < n; i++) {
    const cx = W * 0.2 + Math.random() * W * 0.6;
    const cy = 30 + Math.random() * (VP_Y + 60);
    for (let j = 0; j < 9; j++) {
      const a = (j / 9) * Math.PI * 2 + Math.random() * 0.4;
      const sp = 1.5 + Math.random() * 3;
      particles.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.5,
        c: COLS[Math.floor(Math.random() * COLS.length)], life: 0.7 + Math.random() * 0.9, sz: 2.5 + Math.random() * 3 });
    }
  }
}
function syncReadyBtn() {
  const b = document.getElementById('bowlReadyBtn') as HTMLButtonElement | null;
  if (!b) return;
  b.hidden = phase !== 'lobby';
  const me = roomPlayers.find((p) => p.id === selfId);
  b.disabled = !!me?.ready;
  b.textContent = me?.ready ? '⏳ Waiting…' : '✅ Ready';
}

// ─── Input ────────────────────────────────────────────────────────────────────
// Slingshot / drag-to-throw controls:
//   • press & drag LEFT/RIGHT  → aim (horizontal delta / DRAG_AIM_SCALE)
//   • drag DOWN (toward you)   → power (like pulling back a slingshot)
//   • release                  → throw
function canvasXY(clientX: number, clientY: number): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [(clientX - r.left) / r.width * W, (clientY - r.top) / r.height * H];
}
function startDrag(sx: number, sy: number) {
  if (!isMyTurn || (phase !== 'aiming' && phase !== 'charging')) return;
  dragging = true; aimWobbleT = 0;
  dragCurX = sx; dragCurY = sy;
  setPhase('charging');
}
function moveDrag(sx: number, sy: number) {
  if (dragging) { dragCurX = sx; dragCurY = sy; }
}
function endDrag() {
  if (!dragging) return;
  dragging = false;
  if (isMyTurn && (phase === 'charging' || phase === 'aiming')) fireThrow();
}
function onMove(e: PointerEvent) { const [sx, sy] = canvasXY(e.clientX, e.clientY); moveDrag(sx, sy); }
function onDown(e: PointerEvent) {
  const [sx, sy] = canvasXY(e.clientX, e.clientY);
  startDrag(sx, sy);
  if (dragging) canvas.setPointerCapture(e.pointerId); // track even outside canvas
}
function onUp(_e: PointerEvent) { endDrag(); }
function onTS(e: TouchEvent) { e.preventDefault(); const t = e.touches[0]; if (t) { const [sx,sy]=canvasXY(t.clientX,t.clientY); startDrag(sx,sy); } }
function onTM(e: TouchEvent) { e.preventDefault(); const t = e.touches[0]; if (t) { const [sx,sy]=canvasXY(t.clientX,t.clientY); moveDrag(sx,sy); } }
function onTE(e: TouchEvent) { e.preventDefault(); endDrag(); }
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') closeBowling(); }
function fireThrow() {
  if (!isMyTurn || phase === 'rolling') return;
  // Base aim = where pointer is (absolute). Wobble captured at release moment adds
  // a skill layer: steady low-power = accurate, full-power yeet = gamble.
  const BALL_REST_Y = H - 130;
  const wobble = getAimWobble();
  const rawAim = (dragCurX - W / 2) / (W * 0.32) + wobble; // absolute + timing wobble
  const rawPow = Math.max(0, dragCurY - BALL_REST_Y) / DRAG_POW_SCALE;
  const drunkDrift = drunkLevel > 0 ? (Math.random() - 0.5) * drunkLevel * 0.35 : 0;
  lockedAim   = Math.max(-1, Math.min(1, rawAim + drunkDrift));
  lockedPower = Math.min(1, rawPow);
  chargeT = 0; dragging = false;
  setPhase('rolling'); rollT = 0;
  rollBallX = VP_X + lockedAim * W * 0.22;
  rollBallY = H - 40; rollBallR = 52;
  playRollSfx();
  net.bowlThrow(lockedAim, lockedPower);
}

// ─── Game loop ────────────────────────────────────────────────────────────────
function loop(ts: number) {
  if (!bowlingOpen) return;
  const dt = Math.min((ts - lastTs) / 1000, 0.1);
  lastTs = ts;
  try {
    update(dt);
    render();
  } catch (err) {
    console.error('[bowling] render error:', err);
  }
  rafId = requestAnimationFrame(loop);
}
function drunkWobble(): number {
  if (drunkLevel === 0) return 0;
  const w = lastTs / 1000;
  // Two-sine wobble identical to the overworld tavern, but with stronger scaling
  // so level 6 is genuinely disorienting (≈±0.6 rad tilt vs ±0.54 in overworld).
  return (Math.sin(w * 3.1) * 0.10 + Math.sin(w * 1.3 + 1) * 0.05) * drunkLevel;
}

function getAimWobble(): number {
  if (!dragging || phase !== 'charging') return 0;
  const BALL_REST_Y = H - 130;
  const power = Math.min(1, Math.max(0, dragCurY - BALL_REST_Y) / DRAG_POW_SCALE);
  // Low power = tiny wobble (±0.04), full power = substantial (±0.22)
  const amp = 0.04 + power * 0.18;
  return Math.sin(aimWobbleT * Math.PI * 2) * amp;
}

function update(dt: number) {
  if (phase === 'charging') chargeT = Math.min(chargeT + dt, CHARGE_FULL + 0.1);
  // Aim pendulum: wobbles while charging — release timing matters
  if (phase === 'charging' && dragging) {
    const BALL_REST_Y = H - 130;
    const power = Math.min(1, Math.max(0, dragCurY - BALL_REST_Y) / DRAG_POW_SCALE);
    aimWobbleT += dt * (1.0 + power * 0.8); // faster at high power = harder to time
  }
  if (phase === 'rolling') {
    rollT += dt / ROLL_DUR;
    if (rollT >= 1) {
      rollT = 1;
      if (pendingResult) applyPendingResult();
    }
    // Ball flies from foreground to VP
    const ease = 1 - Math.pow(1 - Math.min(rollT, 1), 2);
    rollBallX = lerp(VP_X + lockedAim * W * 0.22, VP_X + lockedAim * 3, ease);
    rollBallY = lerp(H - 40, VP_Y + 12, ease);
    rollBallR  = lerp(52, 4, ease);
  }
  for (const fp of fallingPins) {
    fp.t += dt;
    fp.wz += fp.vy * dt * 0.5;
    fp.vy += 3 * dt;
    fp.rz += fp.rSpeed * dt;
    fp.alpha = Math.max(0, 1 - fp.t * 1.1);
  }
  fallingPins = fallingPins.filter((fp) => fp.alpha > 0);
  for (const p of particles) {
    p.x += p.vx * dt * 55; p.y += p.vy * dt * 55;
    p.vy += 0.06 * dt * 55; p.life -= dt;
  }
  particles = particles.filter((p) => p.life > 0);
  if (cel) { cel.t += dt; if (cel.t >= cel.dur) cel = null; }
  if (shakeT > 0) shakeT = Math.max(0, shakeT - dt);
}

// ─── Rendering ───────────────────────────────────────────────────────────────
function render() {
  ctx.save();
  // Screen shake
  if (shakeT > 0) {
    const s = shakeT * shakePow;
    ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
  }
  // Drunk camera sway (like world.ts: sine-sum wobble scaled by drunk level)
  if (drunkLevel > 0) {
    const wob = drunkWobble();
    const ca = Math.cos(wob), sa = Math.sin(wob);
    ctx.transform(ca, sa, -sa, ca, W / 2 * (1 - ca) + H / 2 * sa, W / 2 * (-sa) + H / 2 * (1 - ca));
    // Amber booze haze overlay
    ctx.fillStyle = `rgba(180,100,0,${Math.min(0.38, drunkLevel * 0.055)})`;
    ctx.fillRect(-W, -H, W * 3, H * 3);
  }
  drawScene();
  ctx.restore();
  drawParticles();
  drawHUD();
  if (cel) drawCelebration(cel);
  if (phase === 'lobby')   drawLobby();
  if (phase === 'waiting') drawWaiting();
  if (phase === 'over')    drawGameOver();
  if (phase === 'beer')    drawBeerPrompt();
}

// ─── Scene: FPS-style perspective lane ───────────────────────────────────────
function drawScene() {
  // --- Ceiling ---
  ctx.fillStyle = '#0b0812';
  ctx.fillRect(0, 0, W, VP_Y);

  // Overhead lights: rows of glowing circles converging
  for (let dz = 1.5; dz < LANE_LEN; dz += 2.5) {
    const p = proj(0, CAM_H + 2.4, dz);
    if (!p) continue;
    const [lx, ly, sc] = p;
    const lr = Math.max(3, 24 * (sc / FOCAL));
    const grd = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr * 3);
    grd.addColorStop(0, 'rgba(255,240,180,0.5)');
    grd.addColorStop(0.3, 'rgba(255,230,120,0.15)');
    grd.addColorStop(1, 'rgba(255,200,80,0)');
    ctx.beginPath(); ctx.arc(lx, ly, lr * 3, 0, Math.PI * 2);
    ctx.fillStyle = grd; ctx.fill();
    ctx.beginPath(); ctx.arc(lx, ly, lr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,245,200,0.85)'; ctx.fill();
  }

  // Neon "BOLWOING ALLEY" sign near ceiling
  ctx.save();
  ctx.font = 'bold 22px system-ui';
  ctx.textAlign = 'center';
  const grdN = ctx.createLinearGradient(W/2 - 180, 0, W/2 + 180, 0);
  grdN.addColorStop(0, '#ff44dd'); grdN.addColorStop(0.5, '#ffee44'); grdN.addColorStop(1, '#44ddff');
  ctx.fillStyle = grdN;
  ctx.shadowColor = '#ff44dd'; ctx.shadowBlur = 20;
  ctx.fillText('🎳  B O L W O I N G   A L L E Y  🎳', W / 2, 32);
  ctx.restore();

  // --- Side walls (alley boundary outside the lane) ---
  // Left wall
  const lTopP = proj(-LANE_HW, CAM_H + 2.4, LANE_LEN * 0.98);
  const lBotP = proj(-LANE_HW, 0, LANE_LEN * 0.98);
  const lBotNear = proj(-LANE_HW, 0, 0.5);
  const lTopNear = proj(-LANE_HW, CAM_H + 2.4, 0.5);
  if (lTopP && lBotP && lTopNear && lBotNear) {
    ctx.beginPath();
    ctx.moveTo(lTopNear[0], lTopNear[1]);
    ctx.lineTo(lTopP[0], lTopP[1]);
    ctx.lineTo(lBotP[0], lBotP[1]);
    ctx.lineTo(lBotNear[0], lBotNear[1]);
    ctx.closePath();
    const wg = ctx.createLinearGradient(lTopP[0], 0, lTopNear[0], 0);
    wg.addColorStop(0, '#1a0e28'); wg.addColorStop(1, '#2a1840');
    ctx.fillStyle = wg; ctx.fill();
    // Neon strip along wall
    ctx.strokeStyle = 'rgba(150,30,200,0.6)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(lTopNear[0], VP_Y + 20); ctx.lineTo(lTopP[0], VP_Y + 2); ctx.stroke();
  }
  // Right wall (mirror)
  const rTopP = proj(LANE_HW, CAM_H + 2.4, LANE_LEN * 0.98);
  const rBotP = proj(LANE_HW, 0, LANE_LEN * 0.98);
  const rBotNear = proj(LANE_HW, 0, 0.5);
  const rTopNear = proj(LANE_HW, CAM_H + 2.4, 0.5);
  if (rTopP && rBotP && rTopNear && rBotNear) {
    ctx.beginPath();
    ctx.moveTo(rTopNear[0], rTopNear[1]);
    ctx.lineTo(rTopP[0], rTopP[1]);
    ctx.lineTo(rBotP[0], rBotP[1]);
    ctx.lineTo(rBotNear[0], rBotNear[1]);
    ctx.closePath();
    const wg = ctx.createLinearGradient(rTopP[0], 0, rTopNear[0], 0);
    wg.addColorStop(0, '#1a0e28'); wg.addColorStop(1, '#2a1840');
    ctx.fillStyle = wg; ctx.fill();
    ctx.strokeStyle = 'rgba(200,80,30,0.6)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(rTopNear[0], VP_Y + 20); ctx.lineTo(rTopP[0], VP_Y + 2); ctx.stroke();
  }

  // --- Floor: scan-line perspective casting ---
  // Fill the horizon gap (scanlines beyond LANE_LEN are skipped, leaving black)
  // with the far-end floor colors so there's no black band near the vanishing point.
  ctx.fillStyle = '#120a1e';
  ctx.fillRect(0, VP_Y, W, 20);
  // For each screen row y below horizon:
  //   floor depth = CAM_H * FOCAL / (y - VP_Y)
  //   lane edges at that depth = ±LANE_HW * FOCAL / depth
  ctx.save();
  for (let y = VP_Y + 1; y < H; y++) {
    const depth = CAM_H * FOCAL / (y - VP_Y);
    if (depth > LANE_LEN + 2) continue;

    const lw = LANE_HW * FOCAL / depth;
    const gw = lw * 0.10; // gutter width on screen

    // Closeness factor (0=far, 1=near camera)
    const close = 1 - Math.min(depth / LANE_LEN, 1);
    // Wood plank stripes (horizontal bands in depth)
    const plankPhase = (depth % 1.4) / 1.4;
    const plankLine = plankPhase < 0.07 ? 0.55 : 1;
    const woodR = Math.floor((40 + close * 70) * plankLine + 25);
    const woodG = Math.floor((20 + close * 45) * plankLine + 10);
    const woodB = Math.floor((2  + close * 8)  * plankLine);
    // Left boundary
    const lLane = VP_X - lw;
    const rLane = VP_X + lw;

    // Outside alley (dark carpet)
    ctx.fillStyle = '#120a1e';
    ctx.fillRect(0, y, Math.max(0, lLane - gw), 1);
    ctx.fillRect(rLane + gw, y, W - (rLane + gw), 1);

    // Gutter (dark notch beside lane)
    ctx.fillStyle = '#0a0606';
    ctx.fillRect(lLane - gw, y, gw, 1);
    ctx.fillRect(rLane,      y, gw, 1);

    // Lane surface
    ctx.fillStyle = `rgb(${woodR},${woodG},${woodB})`;
    ctx.fillRect(lLane, y, lw * 2, 1);

    // Center reflection shimmer
    const shimmer = Math.max(0, 1 - Math.abs(close - 0.5) * 3) * 18;
    if (shimmer > 0) {
      ctx.fillStyle = `rgba(255,240,180,${shimmer / 255})`;
      ctx.fillRect(VP_X - 6, y, 12, 1);
    }
  }

  // Foul line (bright red stripe near camera)
  const flDepth = 0.35;
  const flY = VP_Y + CAM_H * FOCAL / flDepth;
  if (flY < H) {
    const flW = LANE_HW * FOCAL / flDepth;
    ctx.fillStyle = '#cc2222';
    ctx.fillRect(VP_X - flW, flY - 1, flW * 2, 3);
  }

  // Arrow targets (5 chevron markers converging)
  for (let ai = -2; ai <= 2; ai++) {
    const arZ = LANE_LEN * 0.28;
    const arX = ai * LANE_HW * 0.38;
    const pa  = proj(arX, 0.01, arZ);
    if (!pa) continue;
    const [ax, ay, sc] = pa;
    const as = Math.max(4, 10 * sc / (FOCAL / (PIN_Z0 * 0.35)));
    ctx.beginPath();
    ctx.moveTo(ax, ay - as); ctx.lineTo(ax - as * 0.5, ay); ctx.lineTo(ax + as * 0.5, ay);
    ctx.closePath();
    ctx.fillStyle = 'rgba(210,160,50,0.7)';
    ctx.fill();
  }
  ctx.restore();

  // --- Pin deck back wall ---
  const bwZ = PIN_Z0 + 1.2;
  const bwL = proj(-LANE_HW, 0, bwZ);
  const bwR = proj( LANE_HW, 0, bwZ);
  const bwLT= proj(-LANE_HW, CAM_H + 1.5, bwZ);
  const bwRT= proj( LANE_HW, CAM_H + 1.5, bwZ);
  if (bwL && bwR && bwLT && bwRT) {
    ctx.beginPath();
    ctx.moveTo(bwLT[0], bwLT[1]); ctx.lineTo(bwRT[0], bwRT[1]);
    ctx.lineTo(bwR[0],  bwR[1]);  ctx.lineTo(bwL[0],  bwL[1]);
    ctx.closePath();
    ctx.fillStyle = '#221838'; ctx.fill();
    ctx.strokeStyle = '#3a2060'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  // --- Pins ---
  drawPins();

  // --- Ball in play ---
  if (phase === 'rolling') drawRollBall();

  // --- Foreground arm + ball (when aiming/charging) ---
  if (phase === 'aiming' || phase === 'charging') drawForeground();
}

// ─── Pin rendering ────────────────────────────────────────────────────────────
function drawPins() {
  // Sort back-to-front so closer pins draw on top
  const order = [6,7,8,9, 3,4,5, 1,2, 0];
  for (const i of order) {
    const [wx, wz0] = PIN_WXZ[i];
    const wz = PIN_Z0 + wz0;

    // Check falling pin override
    const fp = fallingPins.find((f) => f.idx === i);
    if (fp) {
      drawFallingPin(fp);
      continue;
    }
    if (!pinState[i]) continue;
    drawStandingPin(wx, 0, wz, 1.0);
  }
}

function drawStandingPin(wx: number, wy: number, wz: number, alpha: number) {
  const pBottom = proj(wx, wy,          wz);
  const pTop    = proj(wx, wy + PIN_VH, wz);
  if (!pBottom || !pTop) return;
  const [bx, by] = pBottom;
  const [, ty]   = pTop;
  const h = by - ty;   // total screen height of pin

  // Real bowling-pin proportions (all fractions of h):
  //   base         0..0.08   wide flat ring
  //   chime        0.08..0.18  narrows
  //   belly        0.18..0.42  bulges out (widest)
  //   upper chime  0.42..0.68  narrows to neck
  //   neck         0.68..0.73  narrowest
  //   head         0.73..1.0   ball on top
  const B  = h * 0.22;  // base half-width
  const CH = h * 0.12;  // chime half-width
  const BL = h * 0.26;  // belly half-width (widest)
  const NK = h * 0.09;  // neck half-width
  const HD = h * 0.17;  // head half-width

  // Y positions (from by downward = up in screen coords)
  const y0  = by;                 // base bottom
  const y1  = by - h * 0.08;     // base top / chime bottom
  const y2  = by - h * 0.18;     // chime top / belly start
  const y3  = by - h * 0.42;     // belly widest
  const y4  = by - h * 0.66;     // neck
  const y5  = by - h * 0.73;     // neck top / head base
  const headCy = by - h * 0.87;  // head circle center
  const headR  = h * 0.15;       // head circle radius

  ctx.save();
  ctx.globalAlpha = alpha;

  // Drop shadow on lane
  ctx.beginPath();
  ctx.ellipse(bx, by + h * 0.03, BL * 0.85, h * 0.04, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill();

  // Build pin outline path (left side up, arc over head, right side down)
  const path = new Path2D();
  path.moveTo(bx - B, y0);
  // base ring sides
  path.lineTo(bx - B, y1);
  // chime narrows
  path.quadraticCurveTo(bx - CH * 1.1, y1 + (y2 - y1) * 0.6, bx - CH, y2);
  // belly flare
  path.quadraticCurveTo(bx - BL * 1.08, y2 + (y3 - y2) * 0.5, bx - BL, y3);
  // upper chime narrows to neck
  path.quadraticCurveTo(bx - BL * 0.9, y3 + (y4 - y3) * 0.4, bx - NK * 1.1, y4);
  path.quadraticCurveTo(bx - NK * 1.0, y4 + (y5 - y4) * 0.5, bx - NK, y5);
  // head shoulder
  path.quadraticCurveTo(bx - NK * 0.5, y5 + (headCy - y5) * 0.3, bx - HD, headCy);
  // head arc
  path.arc(bx, headCy, headR, Math.PI, 0, false);
  // head shoulder right
  path.quadraticCurveTo(bx + NK * 0.5, y5 + (headCy - y5) * 0.3, bx + NK, y5);
  // neck to belly right
  path.quadraticCurveTo(bx + NK * 1.0, y4 + (y5 - y4) * 0.5, bx + NK * 1.1, y4);
  path.quadraticCurveTo(bx + BL * 0.9, y3 + (y4 - y3) * 0.4, bx + BL, y3);
  // belly to chime right
  path.quadraticCurveTo(bx + BL * 1.08, y2 + (y3 - y2) * 0.5, bx + CH, y2);
  path.quadraticCurveTo(bx + CH * 1.1, y1 + (y2 - y1) * 0.6, bx + B, y1);
  path.lineTo(bx + B, y0);
  path.closePath();

  // White body with subtle ivory gradient (3D shading)
  const pg = ctx.createLinearGradient(bx - BL, 0, bx + BL, 0);
  pg.addColorStop(0,    '#c8c4bc');
  pg.addColorStop(0.18, '#f5f2ee');
  pg.addColorStop(0.42, '#ffffff');
  pg.addColorStop(0.68, '#eeeae4');
  pg.addColorStop(1,    '#b0aba0');
  ctx.fillStyle = pg;
  ctx.fill(path);

  // Red stripes — clipped to pin body
  ctx.save();
  ctx.clip(path);

  // Lower red stripe: just above the chime, wrapping around belly
  ctx.fillStyle = '#c8151a';
  const rS1top = by - h * 0.27, rS1bot = by - h * 0.19;
  ctx.fillRect(bx - BL * 1.1, rS1top, BL * 2.2, rS1bot - rS1top);

  // Upper red stripe: at/below neck
  const rS2top = by - h * 0.61, rS2bot = by - h * 0.55;
  ctx.fillRect(bx - BL * 0.5, rS2top, BL * 1.0, rS2bot - rS2top);

  ctx.restore();  // end stripe clip

  // Soft edge outline
  ctx.strokeStyle = '#9a9488'; ctx.lineWidth = 0.7;
  ctx.stroke(path);

  // Specular highlight on head (upper-left glint)
  const hlR = headR * 0.38;
  const hlg = ctx.createRadialGradient(bx - headR * 0.3, headCy - headR * 0.35, 0, bx - headR * 0.2, headCy - headR * 0.2, hlR * 2);
  hlg.addColorStop(0, 'rgba(255,255,255,0.75)');
  hlg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.beginPath(); ctx.arc(bx - headR * 0.28, headCy - headR * 0.32, hlR, 0, Math.PI * 2);
  ctx.fillStyle = hlg; ctx.fill();

  // Belly glint
  const blg = ctx.createRadialGradient(bx - BL * 0.2, y3 - h * 0.06, 0, bx - BL * 0.1, y3 - h * 0.04, BL * 0.5);
  blg.addColorStop(0, 'rgba(255,255,255,0.35)');
  blg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.beginPath(); ctx.arc(bx - BL * 0.18, y3 - h * 0.05, BL * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = blg; ctx.fill();

  ctx.restore();
}

function drawFallingPin(fp: FallingPin) {
  const p = proj(fp.wx, 0, fp.wz);
  if (!p) return;
  const [bx, by, sc] = p;
  const pinH = PIN_VH * sc;

  ctx.save();
  ctx.globalAlpha = fp.alpha;
  ctx.translate(bx, by);
  // Tumble: rotate around base
  ctx.rotate(fp.rz + Math.PI * 0.15 * fp.t * 6);

  // Simplified but recognizable pin silhouette (scaled to pinH)
  const BL = pinH * 0.26, NK = pinH * 0.09, HD = pinH * 0.16;
  const path = new Path2D();
  path.moveTo(-pinH * 0.22, 0);
  path.quadraticCurveTo(-BL, -pinH * 0.38, -BL, -pinH * 0.42);
  path.quadraticCurveTo(-NK, -pinH * 0.66, -NK, -pinH * 0.73);
  path.arc(0, -pinH * 0.87, HD, Math.PI, 0, false);
  path.quadraticCurveTo(NK, -pinH * 0.66, BL, -pinH * 0.42);
  path.quadraticCurveTo(BL, -pinH * 0.38, pinH * 0.22, 0);
  path.closePath();

  const pg = ctx.createLinearGradient(-BL, 0, BL, 0);
  pg.addColorStop(0, '#c0bdb5'); pg.addColorStop(0.45, '#ffffff'); pg.addColorStop(1, '#aaa8a0');
  ctx.fillStyle = pg; ctx.fill(path);

  ctx.save(); ctx.clip(path);
  ctx.fillStyle = '#c8151a';
  ctx.fillRect(-BL * 1.1, -pinH * 0.27, BL * 2.2, pinH * 0.08);
  ctx.fillRect(-BL * 0.5, -pinH * 0.61, BL * 1.0, pinH * 0.07);
  ctx.restore();

  ctx.restore();
}

// ─── Ball rendering ──────────────────────────────────────────────────────────
function drawRollBall() {
  const r = rollBallR;
  const bx = rollBallX, by = rollBallY;
  // Ball shadow (on floor)
  const sp = proj(lockedAim * LANE_HW * (1 - rollT * 0.9), 0, lerp(0.5, PIN_Z0, rollT * rollT));
  if (sp) {
    ctx.save(); ctx.globalAlpha = 0.3 * (1 - rollT * 0.8);
    ctx.beginPath(); ctx.ellipse(sp[0], sp[1], r * 0.5, r * 0.15, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#000'; ctx.fill(); ctx.restore();
  }
  // Spin phase
  const spin = rollT * 12;
  drawBallSphere(bx, by, r, spin);
}

function drawForeground() {
  const BALL_REST_Y = H - 130;
  const isDragging = phase === 'charging' && dragging;

  // Ball rest position — center-X with drunk sway, fixed Y with room to drag down
  const drunkSway = drunkLevel > 0 ? drunkWobble() * W * 0.12 : 0;
  const ballRestX = VP_X + drunkSway;
  const ballRestY = BALL_REST_Y;
  const r = 52;

  // Arrow aim = absolute pointer position + live wobble (exactly what fireThrow captures)
  const curPtrX = isDragging ? dragCurX : ballRestX;
  const aimForArrow = Math.max(-1, Math.min(1, (curPtrX - W / 2) / (W * 0.32) + getAimWobble()));

  // Power: how far below the rest line the pointer has been pulled
  const dragDY = isDragging ? Math.max(0, dragCurY - BALL_REST_Y) : 0;
  const dragPow = Math.min(1, dragDY / DRAG_POW_SCALE);

  // Ball visual follows pointer X (for aim feedback), drops down when pulling power
  const rawBY = isDragging ? ballRestY + dragDY * 0.5 : ballRestY;
  const bx = Math.max(r + 10, Math.min(W - r - 10, isDragging ? dragCurX : ballRestX));
  const by = Math.max(r + 10, Math.min(H - r - 10, rawBY));

  // Arrow from ball toward the pin deck
  const pinP = proj(aimForArrow * LANE_HW * 0.9, 0, PIN_Z0);
  if (pinP) {
    const [ax, ay] = pinP;
    const col = isDragging
      ? `rgba(255,${Math.floor(220 * (1 - dragPow))},50,0.9)`
      : 'rgba(100,200,255,0.75)';
    const arrowLen = Math.hypot(ax - bx, ay - (by - r + 8));
    const ux = (ax - bx) / arrowLen;
    const uy = (ay - (by - r + 8)) / arrowLen;
    // Shaft
    ctx.save();
    ctx.setLineDash([]);
    ctx.strokeStyle = col; ctx.lineWidth = 3;
    ctx.shadowColor = col; ctx.shadowBlur = 10;
    const startX = bx + ux * (r - 4);
    const startY = (by - r + 8) + uy * 4;
    const endX = ax - ux * 14;
    const endY = ay - uy * 14;
    ctx.beginPath(); ctx.moveTo(startX, startY); ctx.lineTo(endX, endY); ctx.stroke();
    // Arrowhead triangle
    const perp = [-uy, ux];
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(endX + perp[0] * 8, endY + perp[1] * 8);
    ctx.lineTo(endX - perp[0] * 8, endY - perp[1] * 8);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // Forearm (stays at bottom)
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(bx - r * 0.6, by + 20);
  ctx.quadraticCurveTo(bx - r * 0.4, by + r * 0.8, bx - r * 0.25, by + r * 0.3);
  ctx.lineTo(bx + r * 0.25, by + r * 0.3);
  ctx.quadraticCurveTo(bx + r * 0.4, by + r * 0.8, bx + r * 0.6, by + 20);
  ctx.lineTo(bx + 90, H + 60);
  ctx.lineTo(bx - 90, H + 60);
  ctx.closePath();
  ctx.fillStyle = '#3d2210'; ctx.fill();
  ctx.restore();

  // Rubber-band line from rest origin to pulled position (slingshot visual)
  if (isDragging) {
    const powCol = dragPow < 0.4 ? '#44ff88' : dragPow < 0.75 ? '#ffee44' : '#ff2244';
    ctx.save();
    ctx.strokeStyle = powCol; ctx.lineWidth = 3;
    ctx.shadowColor = powCol; ctx.shadowBlur = 10; ctx.globalAlpha = 0.7;
    // Rubber-band: from the fixed anchor (center-bottom) to current ball position
    ctx.beginPath(); ctx.moveTo(VP_X + drunkSway, BALL_REST_Y); ctx.lineTo(bx, by); ctx.stroke();
    ctx.restore();
    // Power arc ring
    if (dragPow > 0) {
      ctx.beginPath();
      ctx.arc(bx, by, r + 8, -Math.PI / 2, -Math.PI / 2 + dragPow * Math.PI * 2);
      ctx.strokeStyle = powCol; ctx.lineWidth = 5;
      ctx.shadowColor = powCol; ctx.shadowBlur = 14;
      ctx.stroke(); ctx.shadowBlur = 0;
    }
    ctx.font = 'bold 15px system-ui'; ctx.textAlign = 'center';
    ctx.fillStyle = powCol; ctx.shadowColor = powCol; ctx.shadowBlur = 8;
    ctx.fillText(`POWER ${Math.round(dragPow * 100)}%`, W / 2, H - 8);
    ctx.shadowBlur = 0;
  }

  // Ball
  drawBallSphere(bx, by, r, 0);

  // Hint text (aiming phase only)
  if (phase === 'aiming') {
    ctx.font = '13px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(180,220,255,0.8)';
    const hint = ballInFrame === 2
      ? `Ball 2 — ${pinsStandingBefore} pin${pinsStandingBefore !== 1 ? 's' : ''} left  ·  drag down to throw`
      : 'Drag down to throw  ·  left/right to aim  ·  more drag = more power';
    ctx.fillText(hint, W / 2, H - 8);
  }
}

function drawBallSphere(bx: number, by: number, r: number, spin: number) {
  // Ball body with radial gradient
  const g = ctx.createRadialGradient(bx - r * 0.28, by - r * 0.3, r * 0.05, bx, by, r);
  g.addColorStop(0, '#8899ff');
  g.addColorStop(0.4, '#4455cc');
  g.addColorStop(0.75, '#222288');
  g.addColorStop(1, '#0a0822');
  ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2);
  ctx.fillStyle = g; ctx.fill();

  // Finger holes (animated spin)
  const holePositions = [[0.2, -0.12], [-0.1, -0.3], [0.05, 0.22]] as const;
  for (const [hx, hy] of holePositions) {
    const a = spin;
    const rx2 = hx * Math.cos(a) - hy * Math.sin(a);
    const ry2 = hx * Math.sin(a) + hy * Math.cos(a);
    if (ry2 > -0.5 && ry2 < 0.5) { // only draw holes on "front" half
      const hr = Math.max(1, r * 0.09);
      ctx.beginPath(); ctx.arc(bx + rx2 * r, by + ry2 * r, hr, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fill();
    }
  }
  // Specular highlight
  ctx.beginPath(); ctx.arc(bx - r * 0.28, by - r * 0.3, r * 0.22, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(200,220,255,0.4)'; ctx.fill();
}

// ─── Particles ───────────────────────────────────────────────────────────────
function drawParticles() {
  for (const p of particles) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.1));
    ctx.beginPath(); ctx.arc(p.x, p.y, p.sz, 0, Math.PI * 2);
    ctx.fillStyle = p.c; ctx.shadowColor = p.c; ctx.shadowBlur = 8;
    ctx.fill(); ctx.restore();
  }
}

// ─── HUD ─────────────────────────────────────────────────────────────────────
function drawHUD() {
  if (phase === 'waiting' || phase === 'lobby' || phase === 'beer') return;

  // Turn indicator
  const cp = roomPlayers.find((p) => p.id === currentPlayerId);
  if (cp) {
    const label = cp.id === selfId ? '🎳 YOUR TURN' : `⏳ ${cp.name}'s turn`;
    const col = cp.id === selfId ? '#ffee44' : '#aabbdd';
    ctx.font = `bold 15px system-ui`;
    ctx.textAlign = 'left';
    ctx.fillStyle = col;
    ctx.shadowColor = col; ctx.shadowBlur = 10;
    ctx.fillText(label, 12, 20);
    ctx.shadowBlur = 0;
  }

  // Ball-in-frame pill (bottom center, visible when playing)
  if (phase === 'aiming' || phase === 'charging' || phase === 'rolling' || phase === 'scored' || phase === 'pinfalling') {
    const myFr = frames[currentPlayerId] ?? [];
    const curFrBalls = (myFr[myFr.length - 1] ?? []).length;
    const displayBall = curFrBalls === 0 ? ballInFrame : curFrBalls + (phase === 'aiming' || phase === 'charging' || phase === 'rolling' ? 1 : 0);
    const frameNum = myFr.length || 1;
    const pinsLeft = pinState.filter(Boolean).length;
    const isSecond = ballInFrame === 2 || curFrBalls >= 1;

    // Pill background
    const pillW = 200, pillH = 28, pillX = W / 2 - pillW / 2, pillY = H - 70;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    roundRect(ctx, pillX, pillY, pillW, pillH, 14);
    ctx.fill();

    // Ball dots
    const dot1col = '#fff', dot2col = isSecond ? '#fff' : 'rgba(255,255,255,0.25)';
    ctx.beginPath(); ctx.arc(pillX + 22, pillY + 14, 6, 0, Math.PI * 2);
    ctx.fillStyle = dot1col; ctx.fill();
    ctx.beginPath(); ctx.arc(pillX + 38, pillY + 14, 6, 0, Math.PI * 2);
    ctx.fillStyle = dot2col; ctx.fill();

    ctx.font = 'bold 12px system-ui'; ctx.textAlign = 'left';
    const ballText = isSecond
      ? `Frame ${frameNum}  ·  Ball 2  ·  ${pinsLeft} pin${pinsLeft !== 1 ? 's' : ''} left`
      : `Frame ${frameNum}  ·  Ball 1  ·  ${pinsStandingBefore} pins`;
    ctx.fillStyle = '#ddeeff';
    ctx.fillText(ballText, pillX + 52, pillY + 18);
    void displayBall; // used implicitly via ballInFrame tracking
  }

  // Score strips (right side, compact)
  const players = roomPlayers.length > 0 ? roomPlayers : [{ id: selfId, name: selfName, color: '#6688ff', ready: true }];
  const rowH = 52 / Math.max(players.length, 1);
  const cardW = 270;
  const cardX = W - cardW - 8;
  const cardY = 6;

  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  roundRect(ctx, cardX - 4, cardY, cardW + 8, players.length * rowH + 8, 6);
  ctx.fill();

  for (let pi = 0; pi < players.length; pi++) {
    const p = players[pi];
    const ry = cardY + 4 + pi * rowH;
    const myFr = frames[p.id] ?? [];
    const mySc = scores[p.id] ?? [];
    const curTotal = mySc[mySc.length - 1] ?? 0;
    const fr = myFr.length;
    const ball = (myFr[myFr.length - 1] ?? []).length;
    const isActive = p.id === currentPlayerId;

    if (isActive) {
      ctx.fillStyle = 'rgba(120,180,255,0.12)';
      ctx.fillRect(cardX - 4, ry - 2, cardW + 8, rowH);
    }
    // Color dot
    ctx.fillStyle = p.color || '#6688ff';
    ctx.fillRect(cardX, ry + 3, 6, rowH - 8);
    // Name
    ctx.font = `bold 11px system-ui`;
    ctx.textAlign = 'left';
    ctx.fillStyle = isActive ? '#88ddff' : '#ccc';
    ctx.fillText(p.name.slice(0, 9), cardX + 12, ry + rowH * 0.45);
    // Frame/score
    ctx.font = '10px system-ui';
    ctx.fillStyle = '#aaa';
    ctx.fillText(`F${fr} B${ball}`, cardX + 12, ry + rowH * 0.82);
    // Total
    ctx.font = 'bold 14px system-ui';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffdd88';
    ctx.fillText(String(curTotal), cardX + cardW - 2, ry + rowH * 0.65);
  }

  // Frame score mini-sheet (bottom left) for self only
  drawMiniScorecard();
}

function drawMiniScorecard() {
  const myFr = frames[selfId] ?? [];
  const mySc = scores[selfId] ?? [];
  if (myFr.length === 0) return;
  const cx2 = 8, cy2 = H - 70;
  const fw = 28, fh = 36;
  const totalW = 10 * fw + 6;

  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  roundRect(ctx, cx2, cy2, totalW, fh + 4, 4);
  ctx.fill();

  for (let f = 0; f < 10; f++) {
    const fx = cx2 + 3 + f * fw;
    const fr2 = myFr[f] ?? [];
    const sc = mySc[f];
    const isCur = f === myFr.length - 1 && phase !== 'over';

    ctx.fillStyle = isCur ? 'rgba(80,140,220,0.2)' : 'rgba(255,255,255,0.04)';
    ctx.fillRect(fx, cy2 + 2, fw - 2, fh);

    ctx.font = '8px system-ui'; ctx.textAlign = 'center';
    // Ball marks
    for (let b = 0; b < Math.min(fr2.length, f < 9 ? 2 : 3); b++) {
      const bx2 = fx + (b + 0.5) * (fw / (f < 9 ? 2 : 3)) - 1;
      const v = fr2[b];
      let mark = String(v);
      if (v === 10 && b === 0) mark = 'X';
      else if (v === 0) mark = '-';
      else if (b === 1 && (fr2[0] + v === 10)) mark = '/';
      const isX = mark === 'X', isS = mark === '/';
      ctx.fillStyle = isX ? '#ffee44' : isS ? '#44ff88' : '#ddd';
      if (isX) { ctx.shadowColor = '#ffcc00'; ctx.shadowBlur = 6; }
      ctx.fillText(mark, bx2, cy2 + 13);
      ctx.shadowBlur = 0;
    }
    // Cumulative score
    if (sc !== undefined) {
      ctx.font = 'bold 9px system-ui'; ctx.fillStyle = '#fff';
      ctx.fillText(String(sc), fx + fw / 2 - 1, cy2 + fh - 2);
    }
    // Frame number
    ctx.font = '6px system-ui'; ctx.fillStyle = '#555';
    ctx.fillText(String(f + 1), fx + fw / 2 - 1, cy2 + 3);
  }
}

// ─── Celebration ─────────────────────────────────────────────────────────────
function drawCelebration(c: Cel) {
  const prog = c.t / c.dur;
  if (prog > 0.9) return;

  const vis = prog < 0.1 ? prog / 0.1 : prog > 0.75 ? 1 - (prog - 0.75) / 0.15 : 1;

  if (c.kind === 'strike' || c.kind === 'turkey' || c.kind === 'perfect') {
    // Alley screen flash
    const flash = Math.max(0, 0.3 - prog * 0.35);
    ctx.fillStyle = `rgba(255,200,0,${flash})`;
    ctx.fillRect(0, 0, W, H);

    const label = c.kind === 'perfect' ? '🎳 PERFECT GAME! 🎳' : c.kind === 'turkey' ? '🦃 TURKEY!! 🦃' : '⚡ STRIKE! ⚡';
    const cols = ['#ff2244','#ffee00','#44ff88','#44aaff','#ff44ff'];
    const col = cols[Math.floor(c.t * 8) % cols.length];
    const pulse = 1 + Math.sin(c.t * 14) * 0.06;

    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(pulse, pulse);
    ctx.font = `bold ${c.kind === 'perfect' ? 62 : 72}px system-ui`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#000'; ctx.lineWidth = 5; ctx.strokeText(label, 0, 0);
    ctx.fillStyle = col;
    ctx.shadowColor = col; ctx.shadowBlur = 35; ctx.globalAlpha = vis;
    ctx.fillText(label, 0, 0);
    ctx.restore();

    // Spinning pin ring
    if (c.kind !== 'perfect') {
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 + c.t * 2.5;
        const rx2 = W / 2 + Math.cos(a) * 180;
        const ry2 = H / 2 + Math.sin(a) * 90;
        ctx.save(); ctx.globalAlpha = vis * 0.85;
        ctx.beginPath(); ctx.arc(rx2, ry2, 10, 0, Math.PI * 2);
        ctx.fillStyle = '#eee'; ctx.fill();
        ctx.fillStyle = '#cc1a1a';
        ctx.fillRect(rx2 - 10, ry2 - 2.5, 20, 4);
        ctx.restore();
      }
    }

  } else if (c.kind === 'spare') {
    ctx.fillStyle = `rgba(0,180,70,${Math.max(0, 0.15 - prog * 0.2)})`;
    ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.globalAlpha = vis;
    ctx.font = 'bold 64px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#44ff88'; ctx.shadowColor = '#00cc44'; ctx.shadowBlur = 28;
    ctx.strokeStyle = '#000'; ctx.lineWidth = 4; ctx.strokeText('/ SPARE! /', W/2, H/2);
    ctx.fillText('/ SPARE! /', W / 2, H / 2);
    ctx.restore();

  } else if (c.kind === 'strikality') {
    // JSAV-style: background creeps to black, pin #5 (head pin) stretches into
    // a giant bowling-pin face that fills the screen.
    const MORPH = 0.35;
    const g = Math.max(0, c.t - MORPH);

    ctx.fillStyle = `rgba(2,3,10,${Math.min(0.92, 0.22 + g * 0.55)})`;
    ctx.fillRect(0, 0, W, H);

    // Growing stretched pin in the center
    const BASE_W = 90, BASE_H = 70;
    const vGrow = 1 + g * 5 + g * g * 3;
    const wGrow = 1 + g * 1.2 + g * g * 2;
    const jiggle = 1 + Math.sin(c.t * 22) * 0.045 * Math.min(1, g * 2);
    const pw2 = Math.min(BASE_W * wGrow * jiggle, W * 2.2);
    const ph2 = Math.min(BASE_H * vGrow * jiggle, H * 2.4);
    const pcx = W / 2 + Math.sin(c.t * 47) * Math.min(10, g * 5);
    const pcy = H / 2 + Math.cos(c.t * 39) * Math.min(10, g * 5);

    // Draw an enormous pin silhouette
    ctx.save();
    ctx.globalAlpha = Math.min(1, c.t / MORPH);
    const BL2 = pw2 * 0.5, NK2 = pw2 * 0.18, HD2 = pw2 * 0.33;
    const path2 = new Path2D();
    path2.moveTo(pcx - BL2 * 0.85, pcy + ph2 * 0.5);
    path2.quadraticCurveTo(pcx - NK2 * 0.5, pcy + ph2 * 0.1, pcx - NK2, pcy - ph2 * 0.18);
    path2.arc(pcx, pcy - ph2 * 0.35, HD2, Math.PI, 0, false);
    path2.quadraticCurveTo(pcx + NK2 * 0.5, pcy + ph2 * 0.1, pcx + BL2 * 0.85, pcy + ph2 * 0.5);
    path2.closePath();

    const pg2 = ctx.createLinearGradient(pcx - BL2, 0, pcx + BL2, 0);
    pg2.addColorStop(0, '#b0aa98'); pg2.addColorStop(0.4, '#ffffff'); pg2.addColorStop(1, '#a09888');
    ctx.fillStyle = pg2; ctx.fill(path2);

    // Red stripe
    ctx.save(); ctx.clip(path2);
    ctx.fillStyle = '#cc1a1a';
    ctx.fillRect(pcx - BL2, pcy + ph2 * 0.02, BL2 * 2, ph2 * 0.1);
    ctx.restore();

    ctx.restore();

    // "STRIKALITY" banner
    if (c.t > MORPH) {
      const a2 = Math.min(1, (c.t - MORPH) * 3.5);
      const pulse2 = 1 + Math.sin(c.t * 9) * 0.025;
      ctx.save();
      ctx.globalAlpha = a2;
      ctx.translate(W / 2, H / 2 + 30);
      ctx.scale(pulse2, pulse2);
      ctx.font = 'bold 68px ui-monospace, system-ui';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.strokeStyle = '#000'; ctx.lineWidth = 6; ctx.strokeText('STRIKALITY', 0, 0);
      ctx.fillStyle = '#ff2b2b';
      ctx.shadowColor = '#ff2b2b'; ctx.shadowBlur = 30;
      ctx.fillText('STRIKALITY', 0, 0);
      ctx.restore();
    }

  } else if (c.kind === 'gutter') {
    ctx.save(); ctx.globalAlpha = vis;
    ctx.font = 'bold 48px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff5533'; ctx.shadowColor = '#ff2200'; ctx.shadowBlur = 20;
    ctx.fillText('😬  GUTTER BALL', W / 2, H / 2 + 40);
    ctx.restore();
  }
}

// ─── Beer prompt ─────────────────────────────────────────────────────────────
// Shown before each of MY turns (ball 1 only). Click YES → drunk++, then aim.
function drawBeerPrompt() {
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, 0, W, H);

  // Panel
  const pw = 420, ph = 210, px = (W - pw) / 2, py = (H - ph) / 2 - 20;
  ctx.fillStyle = '#1a0e08';
  roundRect(ctx, px, py, pw, ph, 14);
  ctx.fill();
  ctx.strokeStyle = '#8b5e2a'; ctx.lineWidth = 2;
  ctx.stroke();

  // Beer emoji + question
  ctx.font = 'bold 38px system-ui'; ctx.textAlign = 'center';
  ctx.fillStyle = '#f5c842';
  ctx.fillText('🍺', W / 2, py + 48);

  ctx.font = 'bold 18px system-ui'; ctx.fillStyle = '#f0e0b0';
  const q = drunkLevel === 0 ? 'Want a beer before you bowl?' : drunkLevel < 3 ? `Another one? (${drunkLevel}/6 beers deep)` : drunkLevel < 5 ? `Dude… you're at ${drunkLevel}/6. One more?` : `BRO. YOU ARE WASTED (${drunkLevel}/6). REALLY?`;
  ctx.fillText(q, W / 2, py + 90);

  // Drunk indicator
  if (drunkLevel > 0) {
    for (let i = 0; i < DRUNK_MAX; i++) {
      ctx.fillStyle = i < drunkLevel ? '#f5c842' : 'rgba(255,255,255,0.15)';
      ctx.beginPath(); ctx.arc(W / 2 - DRUNK_MAX * 14 + i * 28 + 14, py + 115, 8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Buttons
  const btnY = py + ph - 52;
  // YES button
  ctx.fillStyle = '#3a1a05';
  roundRect(ctx, W / 2 - 175, btnY, 155, 40, 8); ctx.fill();
  ctx.strokeStyle = '#f5c842'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.font = 'bold 15px system-ui'; ctx.fillStyle = '#f5c842';
  ctx.fillText(drunkLevel >= DRUNK_MAX ? '🤢 You\'re maxed out' : '🍺 Yes, gimme a beer', W / 2 - 97, btnY + 25);

  // NO button
  ctx.fillStyle = '#0e1a0e';
  roundRect(ctx, W / 2 + 20, btnY, 155, 40, 8); ctx.fill();
  ctx.strokeStyle = '#44ff88'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = '#44ff88';
  ctx.fillText('🎳 Nah, let\'s bowl', W / 2 + 97, btnY + 25);

  // Install click handler once (cleared when phase changes)
  if (!(canvas as any)._beerHandler) {
    const handler = (e: MouseEvent) => {
      if (phase !== 'beer') { canvas.removeEventListener('click', handler); (canvas as any)._beerHandler = null; return; }
      const r = canvas.getBoundingClientRect();
      const mx = (e.clientX - r.left) / r.width * W;
      const my = (e.clientY - r.top) / r.height * H;
      const yesBtn = mx >= W / 2 - 175 && mx <= W / 2 - 20 && my >= btnY && my <= btnY + 40;
      const noBtn  = mx >= W / 2 + 20  && mx <= W / 2 + 175 && my >= btnY && my <= btnY + 40;
      if (yesBtn && drunkLevel < DRUNK_MAX) {
        drunkLevel++;
        playBeerSfx();
      }
      if (yesBtn || noBtn) {
        canvas.removeEventListener('click', handler);
        (canvas as any)._beerHandler = null;
        setPhase('aiming');
      }
    };
    (canvas as any)._beerHandler = handler;
    canvas.addEventListener('click', handler);
  }
}

// ─── Lobby / waiting / over screens ──────────────────────────────────────────
function drawLobby() {
  // Warm dark overlay (lighter than before so the lane is visible)
  ctx.fillStyle = 'rgba(10,5,20,0.78)';
  ctx.fillRect(0, 0, W, H);

  // Panel card
  const pw = 460, ph = roomPlayers.length > 0 ? 80 + roomPlayers.length * 44 + 40 : 200;
  const px = (W - pw) / 2, py = H / 2 - ph / 2 - 30;
  const grd = ctx.createLinearGradient(px, py, px, py + ph);
  grd.addColorStop(0, 'rgba(30,15,5,0.96)');
  grd.addColorStop(1, 'rgba(20,8,0,0.96)');
  ctx.fillStyle = grd;
  roundRect(ctx, px, py, pw, ph, 16); ctx.fill();
  ctx.strokeStyle = '#8b5e2a'; ctx.lineWidth = 2; ctx.stroke();

  ctx.save();
  ctx.font = 'bold 34px system-ui'; ctx.textAlign = 'center';
  ctx.fillStyle = '#ffee44'; ctx.shadowColor = '#ff8800'; ctx.shadowBlur = 22;
  ctx.fillText('🎳 BOLWOING ALLEY', W / 2, py + 44);
  ctx.restore();

  ctx.font = '15px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#bb9966';
  ctx.fillText('Waiting for players… (2–4)', W / 2, py + 72);

  for (let i = 0; i < roomPlayers.length; i++) {
    const p = roomPlayers[i];
    const ry = py + 100 + i * 44;
    ctx.fillStyle = p.color || '#888';
    ctx.fillRect(W / 2 - 130, ry - 4, 10, 28);
    ctx.font = '16px system-ui'; ctx.textAlign = 'left';
    ctx.fillStyle = p.ready ? '#66ff88' : '#ddd';
    ctx.fillText(`${p.name}`, W / 2 - 112, ry + 16);
    ctx.textAlign = 'right';
    ctx.fillStyle = p.ready ? '#44ff88' : '#aa7744';
    ctx.fillText(p.ready ? '✅ Ready' : '⌛ Waiting', W / 2 + 130, ry + 16);
  }

  ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#665544';
  ctx.fillText('10 frames · standard scoring · 1st place wins 750🪙', W / 2, py + ph - 12);
}

function drawWaiting() {
  ctx.fillStyle = 'rgba(10,5,20,0.85)'; ctx.fillRect(0, 0, W, H);
  // Panel
  ctx.fillStyle = 'rgba(20,10,5,0.96)';
  roundRect(ctx, W/2 - 200, H/2 - 50, 400, 100, 14); ctx.fill();
  ctx.strokeStyle = '#8b5e2a'; ctx.lineWidth = 2; ctx.stroke();
  ctx.font = '20px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#bb9966';
  ctx.fillText('Connecting to Bolwoing Alley…', W / 2, H / 2 + 7);
}

function drawGameOver() {
  ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.font = 'bold 44px system-ui'; ctx.textAlign = 'center';
  ctx.fillStyle = '#ffee44'; ctx.shadowColor = '#ff8800'; ctx.shadowBlur = 28;
  ctx.fillText('🏆 GAME OVER', W / 2, H / 2 - 120); ctx.restore();

  const medals = ['🥇','🥈','🥉','4️⃣'];
  const prizes = [750, 300, 150, 0];
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const ry = H / 2 - 55 + i * 54;
    const isMe = r.id === selfId;
    ctx.font = isMe ? 'bold 22px system-ui' : '19px system-ui';
    ctx.textAlign = 'center';
    ctx.fillStyle = isMe ? '#ffee44' : '#ddd';
    ctx.fillText(`${medals[i]} ${r.name}  —  ${r.score} pts`, W / 2, ry);
    if (prizes[i]) {
      ctx.font = '13px system-ui'; ctx.fillStyle = i === 0 ? '#88ffaa' : '#aaddff';
      ctx.fillText(`+${prizes[i].toLocaleString()}🪙`, W / 2, ry + 20);
    }
  }
  ctx.font = '14px system-ui'; ctx.fillStyle = '#556'; ctx.fillText('ESC to leave', W / 2, H - 18);
}

// ─── Sound (Web Audio synth) ─────────────────────────────────────────────────
function getAC(): AudioContext | null {
  if (!audioCtx) {
    try { audioCtx = new AudioContext(); } catch { return null; }
  }
  return audioCtx;
}
function playRollSfx() {
  const ac = getAC(); if (!ac) return;
  try {
    const buf = ac.createBuffer(1, ac.sampleRate * 0.8, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t2 = i / ac.sampleRate;
      const env = Math.max(0, 0.3 - t2 * 0.38);
      d[i] = (Math.random() * 2 - 1) * env * (0.6 + 0.4 * Math.sin(t2 * 180));
    }
    const src = ac.createBufferSource(); src.buffer = buf;
    const g = ac.createGain(); g.gain.value = 0.3;
    src.connect(g); g.connect(ac.destination); src.start();
  } catch {}
}
function playPinCrash(count: number) {
  const ac = getAC(); if (!ac) return;
  try {
    const dur = 0.4;
    const buf = ac.createBuffer(1, ac.sampleRate * dur, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t2 = i / ac.sampleRate;
      const env = Math.pow(Math.max(0, 1 - t2 / dur), 1.5);
      d[i] = (Math.random() * 2 - 1) * env * 0.9;
    }
    const src = ac.createBufferSource(); src.buffer = buf;
    const g = ac.createGain(); g.gain.value = 0.15 + count * 0.04;
    src.connect(g); g.connect(ac.destination); src.start();
  } catch {}
}
function playBeerSfx() {
  const ac = getAC(); if (!ac) return;
  try {
    // Satisfying "glug" — a pitched thump + quick reverb decay
    const notes = [220, 196, 165];
    notes.forEach((freq, i) => {
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      const st = ac.currentTime + i * 0.08;
      g.gain.setValueAtTime(0.22, st);
      g.gain.exponentialRampToValueAtTime(0.001, st + 0.22);
      osc.connect(g); g.connect(ac.destination);
      osc.start(st); osc.stop(st + 0.25);
    });
    // Fizz noise
    const buf = ac.createBuffer(1, ac.sampleRate * 0.5, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.max(0, 0.06 - (i / ac.sampleRate) * 0.12);
    const src = ac.createBufferSource(); src.buffer = buf;
    const gf = ac.createGain(); gf.gain.value = 0.5;
    src.connect(gf); gf.connect(ac.destination); src.start(ac.currentTime + 0.05);
  } catch {}
}
function playStrikeSfx() {
  const ac = getAC(); if (!ac) return;
  try {
    const notes = [523, 659, 784, 1047]; // C5 E5 G5 C6 fanfare
    notes.forEach((freq, i) => {
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      const st = ac.currentTime + i * 0.12;
      g.gain.setValueAtTime(0, st);
      g.gain.linearRampToValueAtTime(0.18, st + 0.02);
      g.gain.linearRampToValueAtTime(0, st + 0.3);
      osc.connect(g); g.connect(ac.destination);
      osc.start(st); osc.stop(st + 0.32);
    });
  } catch {}
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r); ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r); ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
}
