// "Bolwoing Alley" — a PvP bowling minigame (2–4 players), self-contained
// canvas overlay. Like fishing.ts / doom.ts it owns its rAF loop and tears
// everything down on exit. Walk into the Bolwoing Alley building in the world
// to start.
//
// Controls: AIM phase → drag slider left/right to pick your line.
//           POWER phase → the power bar oscillates; click to lock in power.
//           Ball rolls, pins crash, strikes get a flashy alley-screen animation.

export interface BowlingNet {
  bowlJoin(): void;
  bowlReady(): void;
  bowlThrow(offset: number, power: number): void;
  bowlLeave(): void;
  name(): string;
  selfId(): string;
}

// PIN LAYOUT (0-indexed internally, 0 = headpin)
//   Row 4 (back):  7  8  9  10  (indices 6,7,8,9)
//   Row 3:         4  5  6       (3,4,5)
//   Row 2:         2  3          (1,2)
//   Row 1 (front): 1             (0)
const PIN_XY: [number, number][] = [
  [0, 0],
  [-0.5, 1], [0.5, 1],
  [-1, 2], [0, 2], [1, 2],
  [-1.5, 3], [-0.5, 3], [0.5, 3], [1.5, 3],
];
// Pin numbers (1-based) for display
const PIN_NUM = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// ─── State machine ────────────────────────────────────────────────────────────
type Phase = 'waiting' | 'lobby' | 'aiming' | 'powering' | 'rolling' | 'pinfalling' | 'scored' | 'over';

interface RemotePlayer { id: string; name: string; color: string; ready: boolean; }

let bowlingOpen = false;
let rafId = 0;
let net: BowlingNet;
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let overlay: HTMLDivElement;

// Game state (populated by server messages)
let phase: Phase = 'waiting';
let selfId = '';
let selfName = '';
let roomPlayers: RemotePlayer[] = [];
let currentPlayerId = '';
let pinState: boolean[] = new Array(10).fill(true);     // true = standing
let localPins: boolean[] = new Array(10).fill(true);    // for animation
let scores: Record<string, number[]> = {};
let frames: Record<string, number[][]> = {};
let ranked: { id: string; name: string; color: string; score: number }[] = [];
let isMyTurn = false;

// Aim / power state
let aimOffset = 0;          // -1..1, dragged by mouse/touch
let powerLevel = 0;         // 0..1, oscillating
let powerDir = 1;
let powerLocked = false;
let lockedPower = 0;
let isDraggingAim = false;
let aimDragStartX = 0;
let aimDragStartOffset = 0;

// Ball animation
let ballX = 0, ballY = 0;
let ballAnim = 0;           // 0..1 through roll animation
const ROLL_DURATION = 0.9;  // seconds

// Pin fall animation
interface FallingPin { idx: number; x: number; y: number; vx: number; vy: number; rot: number; rotV: number; alpha: number; }
let fallingPins: FallingPin[] = [];

// Strike / spare celebration
interface StrikeAnim {
  kind: 'strike' | 'spare' | 'gutter' | 'turkey' | 'perfect';
  t: number;     // elapsed seconds
  duration: number;
}
let celebration: StrikeAnim | null = null;

// Firework particles for strike animation
interface Particle { x: number; y: number; vx: number; vy: number; color: string; life: number; size: number; }
let particles: Particle[] = [];

// Timing
let lastTs = 0;

// ─── Canvas metrics ───────────────────────────────────────────────────────────
const CW = 900, CH = 600;      // logical canvas size
const LANE_X = CW / 2;         // center of the lane
const LANE_W = 200;            // lane width in canvas px
const LANE_TOP = 80;           // top of lane (pin deck)
const LANE_BOT = CH - 80;      // bottom of lane (approach)
const LANE_H = LANE_BOT - LANE_TOP;

// Convert pin-coord (0-based, headpin at y=0 = near player) to canvas coords.
// Pin rows run 0..3 top to bottom on the canvas (back row = top, head = lower).
const PIN_SCALE = 36;          // pixels per pin unit
function pinToCanvas(px: number, py: number): [number, number] {
  // py=0 = headpin (near player = lower on screen), py=3 = back row (upper)
  const cy = LANE_TOP + 50 + (3 - py) * PIN_SCALE;
  const cx = LANE_X + px * PIN_SCALE;
  return [cx, cy];
}

// Score card area
const CARD_X = 20, CARD_W = CW - 40;

// ─── Entry point ─────────────────────────────────────────────────────────────
export function openBowling(netAdapter: BowlingNet) {
  if (bowlingOpen) return;
  bowlingOpen = true;
  net = netAdapter;
  selfId = net.selfId();
  selfName = net.name();

  // Build overlay
  overlay = document.createElement('div');
  overlay.id = 'bowlOverlay';
  overlay.style.cssText = [
    'position:fixed;inset:0;z-index:900;background:#060a1a;',
    'display:flex;flex-direction:column;align-items:center;justify-content:center;',
  ].join('');

  canvas = document.createElement('canvas');
  canvas.width = CW;
  canvas.height = CH;
  canvas.style.cssText = 'width:min(100vw,900px);height:auto;cursor:crosshair;touch-action:none;';
  ctx = canvas.getContext('2d')!;

  // Controls bar below canvas
  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:12px;margin-top:10px;align-items:center;';
  const readyBtn = document.createElement('button');
  readyBtn.id = 'bowlReadyBtn';
  readyBtn.textContent = '✅ Ready Up';
  readyBtn.style.cssText = btnStyle('#2a6e2a');
  readyBtn.onclick = () => { net.bowlReady(); readyBtn.disabled = true; };
  const leaveBtn = document.createElement('button');
  leaveBtn.textContent = '🚪 Leave';
  leaveBtn.style.cssText = btnStyle('#6e2a2a');
  leaveBtn.onclick = () => closeBowling();
  controls.append(readyBtn, leaveBtn);

  overlay.append(canvas, controls);
  document.body.appendChild(overlay);

  // Input handlers
  canvas.addEventListener('mousedown',  onPointerDown);
  canvas.addEventListener('mousemove',  onPointerMove);
  canvas.addEventListener('mouseup',    onPointerUp);
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove',  onTouchMove,  { passive: false });
  canvas.addEventListener('touchend',   onTouchEnd,   { passive: false });
  document.addEventListener('keydown', onKey);

  // Join the room
  resetLocalState();
  phase = 'waiting';
  net.bowlJoin();

  lastTs = performance.now();
  rafId = requestAnimationFrame(loop);
}

function btnStyle(bg: string): string {
  return `background:${bg};color:#fff;border:none;padding:8px 18px;border-radius:6px;` +
         `font-size:14px;cursor:pointer;font-family:system-ui,sans-serif;`;
}

function resetLocalState() {
  pinState = new Array(10).fill(true);
  localPins = new Array(10).fill(true);
  fallingPins = [];
  celebration = null;
  particles = [];
  ballAnim = 0;
  aimOffset = 0;
  powerLevel = 0;
  powerDir = 1;
  powerLocked = false;
  lockedPower = 0;
  isMyTurn = false;
}

export function closeBowling() {
  if (!bowlingOpen) return;
  bowlingOpen = false;
  net.bowlLeave();
  cancelAnimationFrame(rafId);
  canvas.removeEventListener('mousedown',  onPointerDown);
  canvas.removeEventListener('mousemove',  onPointerMove);
  canvas.removeEventListener('mouseup',    onPointerUp);
  canvas.removeEventListener('touchstart', onTouchStart);
  canvas.removeEventListener('touchmove',  onTouchMove);
  canvas.removeEventListener('touchend',   onTouchEnd);
  document.removeEventListener('keydown', onKey);
  overlay?.remove();
}

export function isBowlingOpen(): boolean { return bowlingOpen; }

// ─── Server message handler ───────────────────────────────────────────────────
export function onBowlMsg(msg: any) {
  if (!bowlingOpen) return;
  switch (msg.type) {
    case 'bowlState': applyState(msg); break;
    case 'bowlStart': applyState(msg); break;
    case 'bowlThrowResult': applyThrowResult(msg); break;
    case 'bowlNextBall':   applyNextBall(msg); break;
    case 'bowlNextTurn':   applyNextTurn(msg); break;
    case 'bowlGameOver':   applyGameOver(msg); break;
  }
}

function applyState(msg: any) {
  roomPlayers = msg.players ?? [];
  if (msg.phase === 'playing' || msg.phase === 'over') {
    scores = msg.scores ?? {};
    frames = msg.frames ?? {};
    currentPlayerId = msg.currentPlayerId ?? '';
    pinState = msg.pinState ?? new Array(10).fill(true);
    localPins = [...pinState];
    isMyTurn = currentPlayerId === selfId;
    phase = msg.phase === 'over' ? 'over' : (isMyTurn ? 'aiming' : 'rolling');
  } else {
    phase = 'lobby';
  }
  if (msg.ranked) { ranked = msg.ranked; phase = 'over'; }
  updateReadyBtn();
}

function applyThrowResult(msg: any) {
  pinState = msg.pinState ?? pinState;
  scores = msg.scores ?? scores;
  frames = msg.frames ?? frames;
  const pinsDown: number[] = msg.pinsDown ?? [];

  // Start pin fall animation
  for (const i of pinsDown) {
    const [cx, cy] = pinToCanvas(...PIN_XY[i]);
    fallingPins.push({
      idx: i, x: cx, y: cy,
      vx: (Math.random() - 0.5) * 5,
      vy: -(2 + Math.random() * 3),
      rot: 0, rotV: (Math.random() - 0.5) * 0.4,
      alpha: 1,
    });
  }

  // Check for strike / spare / gutter in this turn's frame
  const myFrames = frames[msg.playerId] ?? [];
  const lastFrame = myFrames[myFrames.length - 1] ?? [];
  const ball1 = lastFrame[0] ?? 0;
  const ball2 = lastFrame[1] ?? 0;

  if (ball1 === 10 && lastFrame.length === 1) {
    // Check turkey (3 in a row)
    let consecutiveStrikes = 1;
    for (let fi = myFrames.length - 2; fi >= 0; fi--) {
      if (myFrames[fi][0] === 10) consecutiveStrikes++;
      else break;
    }
    if (consecutiveStrikes >= 3) {
      triggerCelebration('turkey', 3.5);
    } else {
      triggerCelebration('strike', 2.8);
    }
  } else if (lastFrame.length === 2 && ball1 + ball2 === 10) {
    triggerCelebration('spare', 2.0);
  } else if (pinsDown.length === 0) {
    triggerCelebration('gutter', 1.5);
  }

  phase = 'pinfalling';
  setTimeout(() => { phase = 'scored'; }, 1000);
}

function applyNextBall(msg: any) {
  pinState = msg.pinState ?? pinState;
  localPins = [...pinState];
  scores = msg.scores ?? scores;
  frames = msg.frames ?? frames;
  currentPlayerId = msg.playerId;
  isMyTurn = currentPlayerId === selfId;
  fallingPins = [];
  celebration = null;
  phase = isMyTurn ? 'aiming' : 'rolling';
  aimOffset = 0;
  powerLocked = false;
}

function applyNextTurn(msg: any) {
  pinState = msg.pinState ?? new Array(10).fill(true);
  localPins = [...pinState];
  scores = msg.scores ?? scores;
  frames = msg.frames ?? frames;
  currentPlayerId = msg.playerId;
  isMyTurn = currentPlayerId === selfId;
  fallingPins = [];
  celebration = null;
  phase = isMyTurn ? 'aiming' : 'rolling';
  aimOffset = 0;
  powerLocked = false;
}

function applyGameOver(msg: any) {
  ranked = msg.ranked ?? [];
  scores = msg.scores ?? scores;
  frames = msg.frames ?? frames;
  phase = 'over';
  // Perfect game?
  const winner = ranked[0];
  if (winner && (scores[winner.id]?.pop() ?? 0) >= 300) {
    triggerCelebration('perfect', 6);
  }
}

function triggerCelebration(kind: StrikeAnim['kind'], duration: number) {
  celebration = { kind, t: 0, duration };
  particles = [];
  if (kind === 'strike' || kind === 'turkey' || kind === 'perfect') {
    spawnFireworks(kind === 'perfect' ? 200 : kind === 'turkey' ? 130 : 80);
  }
}

function spawnFireworks(count: number) {
  const COLORS = ['#ff2244','#ffcc00','#44ff88','#44aaff','#ff44ff','#ffffff','#ff6600'];
  for (let i = 0; i < count; i++) {
    const cx = LANE_X + (Math.random() - 0.5) * 400;
    const cy = LANE_TOP + Math.random() * (LANE_BOT - LANE_TOP) * 0.6;
    for (let j = 0; j < 8; j++) {
      const angle = (j / 8) * Math.PI * 2 + Math.random() * 0.5;
      const speed = 1.5 + Math.random() * 3;
      particles.push({
        x: cx, y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 2,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        life: 0.6 + Math.random() * 0.8,
        size: 2 + Math.random() * 3,
      });
    }
  }
}

function updateReadyBtn() {
  const btn = document.getElementById('bowlReadyBtn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.hidden = phase !== 'lobby';
  const me = roomPlayers.find((p) => p.id === selfId);
  btn.disabled = !!me?.ready;
  btn.textContent = me?.ready ? '✅ Waiting…' : '✅ Ready Up';
}

// ─── Input ────────────────────────────────────────────────────────────────────
function canvasX(e: { clientX: number }): number {
  const rect = canvas.getBoundingClientRect();
  return (e.clientX - rect.left) / rect.width * CW;
}

function onPointerDown(e: MouseEvent) {
  if (phase === 'aiming' && isMyTurn) {
    isDraggingAim = true;
    aimDragStartX = canvasX(e);
    aimDragStartOffset = aimOffset;
    return;
  }
  if (phase === 'powering' && isMyTurn && !powerLocked) {
    lockPower();
    return;
  }
}
function onPointerMove(e: MouseEvent) {
  if (isDraggingAim && phase === 'aiming') {
    const dx = canvasX(e) - aimDragStartX;
    aimOffset = Math.max(-1, Math.min(1, aimDragStartOffset + dx / (LANE_W * 0.42)));
  }
}
function onPointerUp(e: MouseEvent) {
  if (isDraggingAim && phase === 'aiming') {
    isDraggingAim = false;
    // Tap without drag → confirm aim
    if (Math.abs(canvasX(e) - aimDragStartX) < 6) {
      phase = 'powering';
      powerLevel = 0; powerDir = 1;
    }
  }
}

function onTouchStart(e: TouchEvent) {
  e.preventDefault();
  const t = e.touches[0]; if (!t) return;
  onPointerDown({ clientX: t.clientX } as MouseEvent);
}
function onTouchMove(e: TouchEvent) {
  e.preventDefault();
  const t = e.touches[0]; if (!t) return;
  onPointerMove({ clientX: t.clientX } as MouseEvent);
}
function onTouchEnd(e: TouchEvent) {
  e.preventDefault();
  const t = e.changedTouches[0]; if (!t) return;
  onPointerUp({ clientX: t.clientX } as MouseEvent);
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { closeBowling(); return; }
  if (e.key === ' ' || e.key === 'Enter') {
    if (phase === 'aiming' && isMyTurn) { phase = 'powering'; powerLevel = 0; powerDir = 1; }
    else if (phase === 'powering' && isMyTurn && !powerLocked) lockPower();
  }
}

function lockPower() {
  powerLocked = true;
  lockedPower = powerLevel;
  phase = 'rolling';
  ballAnim = 0;
  ballX = LANE_X + aimOffset * LANE_W * 0.42;
  ballY = LANE_BOT - 20;
  net.bowlThrow(aimOffset, lockedPower);
}

// ─── Main loop ────────────────────────────────────────────────────────────────
function loop(ts: number) {
  if (!bowlingOpen) return;
  const dt = Math.min((ts - lastTs) / 1000, 0.1);
  lastTs = ts;
  update(dt);
  render();
  rafId = requestAnimationFrame(loop);
}

function update(dt: number) {
  // Power bar oscillation
  if (phase === 'powering' && !powerLocked) {
    powerLevel += powerDir * dt * 1.4;
    if (powerLevel >= 1) { powerLevel = 1; powerDir = -1; }
    if (powerLevel <= 0) { powerLevel = 0; powerDir = 1; }
  }

  // Ball roll animation
  if (phase === 'rolling') {
    ballAnim = Math.min(1, ballAnim + dt / ROLL_DURATION);
    const [tx, ty] = [LANE_X + aimOffset * LANE_W * 0.05, LANE_TOP + 60];
    ballX = LANE_X + aimOffset * LANE_W * 0.42 + (tx - (LANE_X + aimOffset * LANE_W * 0.42)) * ballAnim;
    ballY = (LANE_BOT - 20) + (ty - (LANE_BOT - 20)) * ballAnim;
  }

  // Falling pin physics
  for (const fp of fallingPins) {
    fp.x  += fp.vx * dt * 60;
    fp.y  += fp.vy * dt * 60;
    fp.vy += 0.18 * dt * 60; // gravity
    fp.rot += fp.rotV * dt * 60;
    fp.alpha -= dt * 0.9;
  }
  fallingPins = fallingPins.filter((fp) => fp.alpha > 0);

  // Celebration timer
  if (celebration) {
    celebration.t += dt;
    if (celebration.t >= celebration.duration) celebration = null;
  }

  // Particles
  for (const p of particles) {
    p.x += p.vx * dt * 60;
    p.y += p.vy * dt * 60;
    p.vy += 0.06 * dt * 60;
    p.life -= dt;
  }
  particles = particles.filter((p) => p.life > 0);
}

// ─── Rendering ───────────────────────────────────────────────────────────────
function render() {
  ctx.clearRect(0, 0, CW, CH);

  drawBackground();
  drawLane();
  drawPins();
  if (phase === 'rolling' || phase === 'pinfalling') drawBall();
  if (phase === 'aiming' && isMyTurn) drawAimGuide();
  if (phase === 'powering' && isMyTurn) drawPowerBar();
  drawFallingPins();
  drawParticles();
  drawScoreCard();
  drawCelebration();
  if (phase === 'lobby') drawLobby();
  if (phase === 'over')  drawGameOver();
  if (phase === 'waiting') drawWaiting();
  if (!isMyTurn && phase !== 'lobby' && phase !== 'over' && phase !== 'waiting') drawWatchHUD();
}

// --- Background: dark alley aesthetic ---
function drawBackground() {
  // Dark carpet floor
  ctx.fillStyle = '#0a0814';
  ctx.fillRect(0, 0, CW, CH);

  // Side alley panels (wood paneling look)
  for (let side = 0; side < 2; side++) {
    const lx = side === 0 ? 0 : LANE_X + LANE_W / 2 + 10;
    const lw = side === 0 ? LANE_X - LANE_W / 2 - 10 : CW - (LANE_X + LANE_W / 2 + 10);
    ctx.fillStyle = '#1a1030';
    ctx.fillRect(lx, 0, lw, CH);
    // Neon strip at lane edge
    ctx.fillStyle = side === 0 ? 'rgba(120,60,220,0.15)' : 'rgba(220,100,30,0.15)';
    ctx.fillRect(side === 0 ? lx + lw - 4 : lx, 0, 4, CH);
  }

  // Ceiling lights above lane
  for (let i = 0; i < 6; i++) {
    const lx = LANE_X;
    const ly = 30 + i * (CH / 5.5);
    const grd = ctx.createRadialGradient(lx, ly, 2, lx, ly, 60);
    grd.addColorStop(0, 'rgba(255,240,200,0.22)');
    grd.addColorStop(1, 'rgba(255,240,200,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(lx - 60, ly - 60, 120, 120);
  }

  // "BOLWOING ALLEY" neon sign at top
  ctx.save();
  ctx.font = 'bold 26px system-ui';
  ctx.textAlign = 'center';
  const grdText = ctx.createLinearGradient(CW / 2 - 200, 0, CW / 2 + 200, 0);
  grdText.addColorStop(0, '#ff44cc');
  grdText.addColorStop(0.5, '#ffee44');
  grdText.addColorStop(1, '#44ddff');
  ctx.fillStyle = grdText;
  ctx.shadowColor = '#ff44cc';
  ctx.shadowBlur = 18;
  ctx.fillText('🎳 BOLWOING ALLEY 🎳', CW / 2, 26);
  ctx.restore();
}

// --- Lane: polished hardwood ---
function drawLane() {
  // Gutter gutters
  const gg = 20;
  ctx.fillStyle = '#3a2800';
  ctx.fillRect(LANE_X - LANE_W / 2 - gg, LANE_TOP - 10, gg, LANE_H + 20);
  ctx.fillRect(LANE_X + LANE_W / 2,      LANE_TOP - 10, gg, LANE_H + 20);

  // Lane surface — vertical wood planks
  for (let plank = 0; plank < 6; plank++) {
    const px = LANE_X - LANE_W / 2 + plank * (LANE_W / 6);
    const shade = 0x5a + plank * 0x06;
    const col = `rgb(${shade + 40},${shade + 20},${Math.floor(shade * 0.4)})`;
    ctx.fillStyle = col;
    ctx.fillRect(px, LANE_TOP - 10, LANE_W / 6, LANE_H + 20);
  }
  // Grain lines
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 0.8;
  for (let g = 0; g < 7; g++) {
    const gx = LANE_X - LANE_W / 2 + g * (LANE_W / 6);
    ctx.beginPath(); ctx.moveTo(gx, LANE_TOP - 10); ctx.lineTo(gx, LANE_BOT + 10); ctx.stroke();
  }

  // Shiny reflection strip down the middle
  const refl = ctx.createLinearGradient(LANE_X - 10, 0, LANE_X + 10, 0);
  refl.addColorStop(0, 'rgba(255,255,220,0)');
  refl.addColorStop(0.5, 'rgba(255,255,220,0.18)');
  refl.addColorStop(1, 'rgba(255,255,220,0)');
  ctx.fillStyle = refl;
  ctx.fillRect(LANE_X - 10, LANE_TOP - 10, 20, LANE_H + 20);

  // Foul line
  ctx.fillStyle = '#cc2222';
  ctx.fillRect(LANE_X - LANE_W / 2, LANE_BOT - 34, LANE_W, 3);

  // Approach dots (7 dots evenly spaced)
  for (let d = 0; d < 7; d++) {
    const dx = LANE_X - LANE_W / 2 + 20 + d * ((LANE_W - 40) / 6);
    ctx.beginPath();
    ctx.arc(dx, LANE_BOT - 24, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#cc2222';
    ctx.fill();
  }

  // Arrow targeting markers (5 arrows toward center)
  const arrowY = LANE_TOP + 120;
  const arrowPositions = [-LANE_W * 0.38, -LANE_W * 0.19, 0, LANE_W * 0.19, LANE_W * 0.38];
  for (const ax of arrowPositions) {
    const x = LANE_X + ax;
    ctx.beginPath();
    ctx.moveTo(x, arrowY - 10);
    ctx.lineTo(x - 6, arrowY);
    ctx.lineTo(x + 6, arrowY);
    ctx.closePath();
    ctx.fillStyle = 'rgba(220,180,80,0.7)';
    ctx.fill();
  }

  // Pin deck (lighter section at top)
  ctx.fillStyle = 'rgba(255,255,200,0.06)';
  ctx.fillRect(LANE_X - LANE_W / 2, LANE_TOP - 10, LANE_W, 80);
}

// --- Pins ---
function drawPins() {
  for (let i = 0; i < 10; i++) {
    if (!localPins[i] && phase !== 'aiming' && phase !== 'powering' && phase !== 'rolling') {
      // Show knocked pins as shadows
      const [cx, cy] = pinToCanvas(...PIN_XY[i]);
      ctx.save();
      ctx.globalAlpha = 0.2;
      ctx.beginPath();
      ctx.arc(cx, cy, 10, 0, Math.PI * 2);
      ctx.fillStyle = '#888';
      ctx.fill();
      ctx.restore();
      continue;
    }
    // Standing pins
    const [cx, cy] = pinToCanvas(...PIN_XY[i]);
    const isStanding = localPins[i];

    // Pin shadow
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.ellipse(cx + 2, cy + 8, 8, 4, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();

    if (!isStanding) continue;

    // Pin body (white cylinder silhouette)
    const pinGrd = ctx.createRadialGradient(cx - 3, cy - 4, 1, cx, cy, 12);
    pinGrd.addColorStop(0, '#ffffff');
    pinGrd.addColorStop(0.4, '#e8e8e0');
    pinGrd.addColorStop(1, '#c0b8a0');
    ctx.beginPath();
    ctx.arc(cx, cy, 11, 0, Math.PI * 2);
    ctx.fillStyle = pinGrd;
    ctx.fill();

    // Red stripe (classic bowling pin)
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, 11, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#cc2222';
    ctx.fillRect(cx - 12, cy - 4, 24, 4);
    ctx.restore();

    // Highlight
    ctx.beginPath();
    ctx.arc(cx - 3, cy - 4, 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fill();

    // Pin number (small)
    ctx.font = 'bold 7px system-ui';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#333';
    ctx.fillText(String(PIN_NUM[i]), cx, cy + 3);
  }
}

// --- Ball ---
function drawBall() {
  const bx = ballX, by = ballY;
  const ballR = 16;

  // Shadow
  ctx.save();
  ctx.globalAlpha = 0.4;
  ctx.beginPath();
  ctx.ellipse(bx + 2, by + 6, ballR, ballR * 0.4, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.restore();

  // Ball body
  const ballGrd = ctx.createRadialGradient(bx - 4, by - 6, 2, bx, by, ballR);
  ballGrd.addColorStop(0, '#6688ff');
  ballGrd.addColorStop(0.5, '#3344cc');
  ballGrd.addColorStop(1, '#111233');
  ctx.beginPath();
  ctx.arc(bx, by, ballR, 0, Math.PI * 2);
  ctx.fillStyle = ballGrd;
  ctx.fill();

  // Finger holes (2 visible)
  ctx.beginPath();
  ctx.arc(bx - 4, by - 2, 3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(bx + 4, by - 4, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fill();

  // Shine
  ctx.beginPath();
  ctx.arc(bx - 5, by - 7, 5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(200,220,255,0.45)';
  ctx.fill();
}

// --- Aim guide ---
function drawAimGuide() {
  const startX = LANE_X + aimOffset * LANE_W * 0.42;
  const endX   = LANE_X + aimOffset * LANE_W * 0.05;

  // Aim line
  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = 'rgba(100,200,255,0.7)';
  ctx.lineWidth = 2;
  ctx.shadowColor = '#44aaff';
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.moveTo(startX, LANE_BOT - 20);
  ctx.lineTo(endX, LANE_TOP + 60);
  ctx.stroke();
  ctx.restore();

  // Ball preview at approach
  drawBallAt(startX, LANE_BOT - 20, 14, 0.6);

  // Aim indicator slider
  drawAimSlider(aimOffset);

  // Instruction
  ctx.font = '14px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(160,220,255,0.9)';
  ctx.fillText('← Drag to aim · Click/Space to lock →', CW / 2, CH - 10);
}

function drawBallAt(x: number, y: number, r: number, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const g = ctx.createRadialGradient(x - 2, y - 3, 1, x, y, r);
  g.addColorStop(0, '#88aaff');
  g.addColorStop(1, '#2233aa');
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
}

function drawAimSlider(offset: number) {
  const sliderY = LANE_BOT + 20;
  const sliderL = LANE_X - LANE_W / 2;
  const sliderREnd = LANE_X + LANE_W / 2;

  // Track
  ctx.fillStyle = 'rgba(100,100,140,0.5)';
  ctx.fillRect(sliderL, sliderY - 4, sliderREnd - sliderL, 8);
  // Fill
  const fillX = LANE_X + offset * LANE_W / 2;
  ctx.fillStyle = '#44aaff';
  ctx.fillRect(Math.min(LANE_X, fillX), sliderY - 3, Math.abs(fillX - LANE_X), 6);
  // Thumb
  ctx.beginPath();
  ctx.arc(fillX, sliderY, 11, 0, Math.PI * 2);
  ctx.fillStyle = '#aaddff';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.stroke();
}

// --- Power bar ---
function drawPowerBar() {
  const barX = LANE_X - LANE_W / 2 - 60;
  const barW = 24;
  const barH = LANE_H - 60;
  const barY = LANE_TOP + 30;

  // Label
  ctx.font = 'bold 11px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ddd';
  ctx.fillText('POWER', barX + barW / 2, barY - 8);

  // Background
  ctx.fillStyle = '#1a1a3a';
  ctx.fillRect(barX, barY, barW, barH);

  // Power fill with gradient
  const fillH = barH * powerLevel;
  const g = ctx.createLinearGradient(0, barY + barH - fillH, 0, barY + barH);
  g.addColorStop(0, powerLevel > 0.8 ? '#ff2222' : powerLevel > 0.5 ? '#ffaa00' : '#22cc44');
  g.addColorStop(1, powerLevel > 0.8 ? '#ff6666' : powerLevel > 0.5 ? '#ffdd44' : '#66ffaa');
  ctx.fillStyle = g;
  ctx.fillRect(barX, barY + barH - fillH, barW, fillH);

  // Notches
  for (let n = 0; n <= 10; n++) {
    const ny = barY + barH - (n / 10) * barH;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(barX, ny - 0.5, barW, 1);
    if (n % 5 === 0) {
      ctx.font = '9px system-ui';
      ctx.textAlign = 'right';
      ctx.fillStyle = '#888';
      ctx.fillText(String(n * 10) + '%', barX - 3, ny + 3);
    }
  }

  // Border
  ctx.strokeStyle = '#4444aa';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(barX, barY, barW, barH);

  // "Sweet spot" glow at 80–90%
  if (powerLevel > 0.75 && powerLevel < 0.95) {
    ctx.save();
    ctx.shadowColor = '#ffee44';
    ctx.shadowBlur = 16;
    ctx.strokeStyle = '#ffee44';
    ctx.strokeRect(barX, barY, barW, barH);
    ctx.restore();
  }

  // Instruction
  ctx.font = '14px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,220,100,0.9)';
  ctx.fillText('Click / Space to throw!', CW / 2, CH - 10);

  // Also draw ball at approach
  drawBallAt(LANE_X + aimOffset * LANE_W * 0.42, LANE_BOT - 20, 15, 1);
}

// --- Falling pins animation ---
function drawFallingPins() {
  for (const fp of fallingPins) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, fp.alpha);
    ctx.translate(fp.x, fp.y);
    ctx.rotate(fp.rot);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 11);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, '#c0b8a0');
    ctx.beginPath();
    ctx.arc(0, 0, 11, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.fillStyle = '#cc2222';
    ctx.fillRect(-12, -4, 24, 4);
    ctx.restore();
  }
}

// --- Particles ---
function drawParticles() {
  for (const p of particles) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, p.life * 1.2);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.restore();
  }
}

// --- Score card ---
function drawScoreCard() {
  if (phase === 'waiting' || phase === 'lobby') return;
  const players = roomPlayers.length > 0 ? roomPlayers : [{ id: selfId, name: selfName, color: '#6688ff', ready: true }];
  const rowH = 42;
  const totalH = players.length * rowH + 4;
  const cardY = 4;

  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  roundRect(ctx, CARD_X, cardY, CARD_W, totalH, 6);
  ctx.fill();

  const frameW = (CARD_W - 120) / 11; // 10 frames + 1 total column

  // Header frames
  ctx.font = '9px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#aaa';
  for (let f = 0; f < 10; f++) {
    ctx.fillText(String(f + 1), CARD_X + 110 + (f + 0.5) * frameW, cardY + 14);
  }
  ctx.fillText('TOT', CARD_X + 110 + 10.5 * frameW, cardY + 14);

  for (let pi = 0; pi < players.length; pi++) {
    const p = players[pi];
    const rowY = cardY + pi * rowH + 18;
    const myFrames = frames[p.id] ?? [];
    const myScores = scores[p.id] ?? [];
    const isActive = p.id === currentPlayerId;

    // Active player highlight
    if (isActive && phase !== 'over') {
      ctx.fillStyle = 'rgba(100,180,255,0.12)';
      ctx.fillRect(CARD_X + 2, rowY - 2, CARD_W - 4, rowH - 2);
    }

    // Color swatch
    ctx.fillStyle = p.color || '#6688ff';
    ctx.fillRect(CARD_X + 6, rowY + 2, 12, rowH - 10);

    // Name
    ctx.font = `bold 12px system-ui`;
    ctx.textAlign = 'left';
    ctx.fillStyle = isActive ? '#88ddff' : '#ddd';
    ctx.fillText(p.name.slice(0, 10), CARD_X + 24, rowY + 16);

    // Frame cells
    for (let f = 0; f < 10; f++) {
      const fx = CARD_X + 110 + f * frameW;
      const fr = myFrames[f] ?? [];
      const cumScore = myScores[f];
      const isCurrentFrame = f === myFrames.length - 1 && phase !== 'over';

      // Cell background
      ctx.fillStyle = isCurrentFrame ? 'rgba(80,140,220,0.15)' : 'rgba(255,255,255,0.04)';
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 0.5;
      ctx.fillRect(fx + 1, rowY - 1, frameW - 2, rowH - 4);
      ctx.strokeRect(fx + 1, rowY - 1, frameW - 2, rowH - 4);

      // Ball marks (top row of each frame cell)
      ctx.font = '10px system-ui';
      ctx.textAlign = 'center';
      const bh = rowH * 0.4;
      for (let b = 0; b < Math.min(fr.length, f < 9 ? 2 : 3); b++) {
        const bx = fx + (b + 0.5) * (frameW / (f < 9 ? 2 : 3));
        const by2 = rowY + 2;
        const val = fr[b];
        let mark = String(val);
        if (val === 10 && b === 0) mark = '✕';
        else if (val === 0) mark = '-';
        else if (b === 1 && (fr[0] + val === 10)) mark = '/';
        const isStrike = mark === '✕';
        const isSpare = mark === '/';
        ctx.fillStyle = isStrike ? '#ffee44' : isSpare ? '#44ff88' : '#ddd';
        if (isStrike || isSpare) {
          ctx.save();
          ctx.shadowColor = isStrike ? '#ffcc00' : '#22ff66';
          ctx.shadowBlur = 6;
        }
        ctx.fillText(mark, bx, by2 + bh * 0.6);
        if (isStrike || isSpare) ctx.restore();
      }

      // Cumulative score
      if (cumScore !== undefined) {
        ctx.font = 'bold 11px system-ui';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.fillText(String(cumScore), fx + frameW / 2, rowY + rowH - 8);
      }
    }

    // Total column
    const tx = CARD_X + 110 + 10 * frameW;
    ctx.font = 'bold 13px system-ui';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffdd88';
    ctx.fillText(String(myScores[myScores.length - 1] ?? 0), tx + frameW / 2, rowY + 18);
  }
}

// --- Celebration overlay ---
function drawCelebration() {
  if (!celebration) return;
  const t = celebration.t;
  const dur = celebration.duration;
  const progress = t / dur;

  // Flash timing: visible in first half, fade out in second half
  if (progress > 0.85) return;
  const alpha = progress < 0.1 ? progress / 0.1 : progress > 0.7 ? 1 - (progress - 0.7) / 0.15 : 1;

  ctx.save();
  ctx.globalAlpha = alpha;

  if (celebration.kind === 'strike' || celebration.kind === 'turkey' || celebration.kind === 'perfect') {
    // Full alley-screen flash effect
    const flashAlpha = Math.max(0, 0.25 - progress * 0.3);
    ctx.fillStyle = `rgba(255,220,0,${flashAlpha})`;
    ctx.fillRect(0, 0, CW, CH);

    // Big text cycling colors
    const colors = ['#ff2244', '#ffee00', '#44ff88', '#44aaff', '#ff44ff'];
    const col = colors[Math.floor(t * 8) % colors.length];

    const label = celebration.kind === 'perfect' ? '🎳 PERFECT GAME! 🎳'
                : celebration.kind === 'turkey'  ? '🦃 TURKEY!! 🦃'
                : '⚡ STRIKE! ⚡';

    ctx.save();
    const scale = 1 + Math.sin(t * 12) * 0.05;
    ctx.translate(CW / 2, CH / 2);
    ctx.scale(scale, scale);
    ctx.font = 'bold 72px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = col;
    ctx.shadowBlur = 30;
    ctx.fillStyle = col;
    ctx.fillText(label, 0, 0);
    // Outline
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 4;
    ctx.strokeText(label, 0, 0);
    ctx.restore();

    // Disco spin ring (bowling pin silhouettes orbiting)
    if (celebration.kind !== 'perfect') {
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2 + t * 3;
        const rx = CW / 2 + Math.cos(angle) * 160;
        const ry = CH / 2 + Math.sin(angle) * 90;
        ctx.beginPath();
        ctx.arc(rx, ry, 12, 0, Math.PI * 2);
        ctx.fillStyle = colors[i % colors.length];
        ctx.shadowColor = colors[i % colors.length];
        ctx.shadowBlur = 12;
        ctx.fill();
        ctx.fillStyle = '#cc0000';
        ctx.fillRect(rx - 12, ry - 3, 24, 4);
      }
    }

  } else if (celebration.kind === 'spare') {
    // Green flash
    ctx.fillStyle = `rgba(0,200,80,${Math.max(0, 0.15 - progress * 0.2)})`;
    ctx.fillRect(0, 0, CW, CH);

    ctx.font = 'bold 60px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#44ff88';
    ctx.shadowColor = '#00cc44';
    ctx.shadowBlur = 24;
    ctx.fillText('/ SPARE! /', CW / 2, CH / 2);
    ctx.strokeStyle = '#003322';
    ctx.lineWidth = 3;
    ctx.strokeText('/ SPARE! /', CW / 2, CH / 2);

  } else if (celebration.kind === 'gutter') {
    ctx.font = 'bold 44px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(200,100,80,0.9)';
    ctx.fillText('😬 GUTTER BALL', CW / 2, CH / 2);
  }

  ctx.restore();
}

// --- Lobby screen ---
function drawLobby() {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, CW, CH);

  ctx.font = 'bold 34px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffee44';
  ctx.shadowColor = '#ff8800';
  ctx.shadowBlur = 18;
  ctx.fillText('🎳 BOLWOING ALLEY', CW / 2, CH / 2 - 100);
  ctx.restore();

  ctx.font = '16px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#bbb';
  ctx.fillText('Waiting for players…', CW / 2, CH / 2 - 55);

  // Player list
  for (let i = 0; i < roomPlayers.length; i++) {
    const p = roomPlayers[i];
    const py = CH / 2 - 20 + i * 36;
    ctx.fillStyle = p.color || '#aaa';
    ctx.fillRect(CW / 2 - 120, py, 12, 24);
    ctx.font = '15px system-ui';
    ctx.textAlign = 'left';
    ctx.fillStyle = p.ready ? '#66ff88' : '#ddd';
    ctx.fillText(`${p.name}  ${p.ready ? '✅ Ready' : '⌛ Not ready'}`, CW / 2 - 100, py + 17);
  }

  ctx.font = '13px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#778';
  ctx.fillText('2–4 players · 10 frames · Strike wins 750🪙', CW / 2, CH - 30);
}

// --- Waiting screen ---
function drawWaiting() {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(0, 0, CW, CH);
  ctx.font = '18px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#aaa';
  ctx.fillText('Connecting to Bolwoing Alley…', CW / 2, CH / 2);
  ctx.restore();
}

// --- Watch HUD (when it's not our turn) ---
function drawWatchHUD() {
  const watching = roomPlayers.find((p) => p.id === currentPlayerId);
  if (!watching) return;
  ctx.font = '15px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(160,200,255,0.85)';
  ctx.fillText(`🎳 ${watching.name}'s turn…`, CW / 2, CH - 10);
}

// --- Game over ---
function drawGameOver() {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(0, 0, CW, CH);

  ctx.font = 'bold 40px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffee44';
  ctx.shadowColor = '#ff8800';
  ctx.shadowBlur = 24;
  ctx.fillText('🏆 GAME OVER', CW / 2, CH / 2 - 120);
  ctx.restore();

  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const ry = CH / 2 - 60 + i * 56;
    const medals = ['🥇', '🥈', '🥉', '4️⃣'];
    const isMe = r.id === selfId;

    ctx.font = isMe ? 'bold 20px system-ui' : '18px system-ui';
    ctx.textAlign = 'center';
    ctx.fillStyle = isMe ? '#ffdd44' : '#ddd';
    ctx.fillText(`${medals[i]} ${r.name}  —  ${r.score} pts`, CW / 2, ry);

    if (i === 0 && COIN_PRIZES[0]) {
      ctx.font = '14px system-ui';
      ctx.fillStyle = '#88ffaa';
      ctx.fillText(`+${COIN_PRIZES[0].toLocaleString()}🪙`, CW / 2, ry + 22);
    } else if (i === 1 && COIN_PRIZES[1]) {
      ctx.font = '13px system-ui';
      ctx.fillStyle = '#aaddff';
      ctx.fillText(`+${COIN_PRIZES[1].toLocaleString()}🪙`, CW / 2, ry + 20);
    }
  }

  ctx.font = '14px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#778';
  ctx.fillText('Press ESC to leave', CW / 2, CH - 20);
}

// ─── Utility ─────────────────────────────────────────────────────────────────
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// Coin prizes exposed for display
const COIN_PRIZES = [750, 300, 150, 0];
