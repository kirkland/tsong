// ✈️  Banner-plane flyover. Every couple of hours (randomly), a little airplane drags a
// trailing banner across the top of the court — Bible verses, communist slogans, and assorted
// irreverence — partially blocking the view. Rarely (once every few days of flights) the engine
// stalls: the plane noses up, drops, and goes out in a dramatic explosion.
//
// Self-contained, like ads.ts: builds its own DOM + styles and overlays the board exactly the
// way #screenFx does (absolute, centered over #stage, pointer-events:none, follows the rotate
// power-up). Driven by requestAnimationFrame so it pauses with the tab. Manual triggers for
// testing are exposed on window: `flyover()` and `flyover('crash')`.

type Mode = 'auto' | 'crash' | 'nocrash';

// --- the message inventory --------------------------------------------------------------
const MESSAGES: { text: string; cls: string }[] = [
  // Scripture
  { text: '✝ For God so loved the world — John 3:16', cls: 'fo-bible' },
  { text: '✝ The LORD is my shepherd; I shall not want — Psalm 23', cls: 'fo-bible' },
  { text: '✝ Love is patient, love is kind — 1 Corinthians 13:4', cls: 'fo-bible' },
  { text: '✝ Be still, and know that I am God — Psalm 46:10', cls: 'fo-bible' },
  { text: '✝ I can do all things through Christ — Philippians 4:13', cls: 'fo-bible' },
  // Comradely
  { text: '☭ WORKERS OF THE WORLD, UNITE!', cls: 'fo-red' },
  { text: '☭ From each according to his ability, to each according to his needs', cls: 'fo-red' },
  { text: '☭ Seize the means of paddle production', cls: 'fo-red' },
  { text: '☭ The history of all hitherto existing Pong is the history of rallies', cls: 'fo-red' },
  { text: '☭ You have nothing to lose but your serve', cls: 'fo-red' },
  // Irreverent
  { text: '😜 your paddle? mid. respectfully.', cls: 'fo-fun' },
  { text: '🛩 this ad costs more than your coin balance', cls: 'fo-fun' },
  { text: '🍕 will rally for pizza', cls: 'fo-fun' },
  { text: '👀 the ball is judging your positioning', cls: 'fo-fun' },
  { text: '🎺 skill issue, allegedly', cls: 'fo-fun' },
  { text: '🛸 ask me about extending your paddle warranty', cls: 'fo-fun' },
];

// --- tuning -----------------------------------------------------------------------------
const MIN_GAP_MS = 1.5 * 60 * 60 * 1000;  // soonest the next flight can come (~1.5h)
const MAX_GAP_MS = 2.5 * 60 * 60 * 1000;  // latest (~2.5h)  → averages ~every 2 hours
const CRASH_CHANCE = 0.03;                // per flight ⇒ with ~12 flights/day, ~1 crash / 3 days
const CROSS_MS = 11000;                   // time to traverse the court in level flight

let root: HTMLDivElement | null = null;
let group: HTMLDivElement | null = null;
let planeEl: HTMLDivElement | null = null;
let bannerSpan: HTMLSpanElement | null = null;
let flying = false;
let scheduleTimer = 0;

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

// --- audio (synthesized via WebAudio — no asset files) ----------------------------------
// Honors the same mute cookie main.ts writes (tsong_muted=1).
let actx: AudioContext | null = null;
function ac(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  try {
    actx ??= new AudioContext();
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    return actx;
  } catch { return null; }
}
function soundOn(): boolean {
  return !document.cookie.split('; ').includes('tsong_muted=1');
}

interface Engine { o1: OscillatorNode; o2: OscillatorNode; lfo: OscillatorNode; out: GainNode; }
let engine: Engine | null = null;

// A looping propeller drone: two detuned saws through a lowpass, amplitude-chopped by an LFO.
function startEngine() {
  if (engine || !soundOn()) return;
  const ctx = ac(); if (!ctx) return;
  try {
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.05, t + 0.6); // fade in as it enters
    out.connect(ctx.destination);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 900;
    const trem = ctx.createGain(); trem.gain.value = 0.6;
    lp.connect(trem); trem.connect(out);

    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 90;
    const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 96;
    o1.connect(lp); o2.connect(lp);

    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 13; // prop chop
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.4;
    lfo.connect(lfoGain); lfoGain.connect(trem.gain);

    o1.start(t); o2.start(t); lfo.start(t);
    engine = { o1, o2, lfo, out };
  } catch {}
}

// Sputter the engine toward death (used when it stalls).
function sputterEngine() {
  if (!engine || !actx) return;
  const t = actx.currentTime;
  try {
    for (const o of [engine.o1, engine.o2]) {
      o.frequency.cancelScheduledValues(t);
      o.frequency.setValueAtTime(o.frequency.value, t);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.9); // pitch collapses
    }
    engine.lfo.frequency.exponentialRampToValueAtTime(5, t + 0.9); // chop slows
  } catch {}
}

function stopEngine(fade = 0.3) {
  const e = engine; engine = null;
  if (!e || !actx) return;
  const t = actx.currentTime;
  try {
    e.out.gain.cancelScheduledValues(t);
    e.out.gain.setValueAtTime(e.out.gain.value, t);
    e.out.gain.linearRampToValueAtTime(0, t + fade);
    for (const o of [e.o1, e.o2, e.lfo]) o.stop(t + fade + 0.05);
  } catch {}
}

function playCrashSound() {
  if (!soundOn()) return;
  const ctx = ac(); if (!ctx) return;
  try {
    const t = ctx.currentTime;
    // Low body "boom".
    const boom = ctx.createOscillator(); boom.type = 'sine';
    boom.frequency.setValueAtTime(150, t);
    boom.frequency.exponentialRampToValueAtTime(40, t + 0.5);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.5, t);
    bg.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    boom.connect(bg); bg.connect(ctx.destination);
    boom.start(t); boom.stop(t + 0.62);

    // Noise burst (the debris/fire), low-passed and decaying.
    const dur = 0.7;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const noise = ctx.createBufferSource(); noise.buffer = buf;
    const nf = ctx.createBiquadFilter(); nf.type = 'lowpass';
    nf.frequency.setValueAtTime(1800, t);
    nf.frequency.exponentialRampToValueAtTime(200, t + dur);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.6, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + dur);
    noise.connect(nf); nf.connect(ng); ng.connect(ctx.destination);
    noise.start(t); noise.stop(t + dur);
  } catch {}
}

/** Build the (hidden) overlay + styles. Call once at startup. */
export function initFlyover() {
  if (root) return;

  const style = document.createElement('style');
  style.textContent = `
    #flyover {
      position: absolute; top: 0; left: 50%; transform: translateX(-50%);
      width: min(94vw, 1040px); aspect-ratio: 8 / 5; border-radius: 8px; overflow: hidden;
      pointer-events: none; z-index: 7; display: none;
    }
    #flyover.rotated { width: auto; height: min(88vh, 900px); aspect-ratio: 500 / 800; }
    #flyover.on { display: block; }
    .fo-group { position: absolute; top: 0; left: 0; display: flex; align-items: center;
      transform-origin: 50% 50%; will-change: transform; }
    .fo-group.mirror { transform: scaleX(-1); }
    /* The banner: a fluttering ribbon trailing behind the plane. */
    .fo-banner { position: relative; height: 30px; display: flex; align-items: center;
      padding: 0 16px 0 22px; white-space: nowrap; color: #fff; font: 800 15px system-ui, sans-serif;
      letter-spacing: 0.3px; text-shadow: 0 1px 2px rgba(0,0,0,0.55);
      border: 2px solid rgba(255,255,255,0.55); border-left: none;
      box-shadow: 0 2px 8px rgba(0,0,0,0.35); animation: foFlutter 0.9s ease-in-out infinite;
      transform-origin: right center;
      /* swallow-tail notch on the trailing (left) edge */
      clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%, 12px 50%);
    }
    .fo-banner.mirror span { display: inline-block; transform: scaleX(-1); }
    .fo-bible { background: linear-gradient(90deg,#1a2b6b,#3356c9); }
    .fo-red   { background: linear-gradient(90deg,#7a0c0c,#d21f1f); }
    .fo-fun   { background: linear-gradient(90deg,#5a2b00,#e08a1e); }
    /* short tow rope from banner to plane */
    .fo-rope { width: 18px; height: 2px; background: rgba(255,255,255,0.6); flex: 0 0 auto; }
    .fo-plane { flex: 0 0 auto; font-size: 34px; line-height: 1; transform-origin: 50% 50%;
      filter: drop-shadow(0 2px 3px rgba(0,0,0,0.5)); }
    @keyframes foFlutter { 0%,100% { transform: skewY(-1.5deg) scaleY(1); } 50% { transform: skewY(2deg) scaleY(0.96); } }

    /* explosion bits */
    .fo-boom { position: absolute; transform: translate(-50%, -50%); pointer-events: none; }
    .fo-flash { width: 26px; height: 26px; border-radius: 50%; background: #fff;
      box-shadow: 0 0 40px 24px rgba(255,210,120,0.95), 0 0 80px 50px rgba(255,120,30,0.6);
      animation: foFlash 0.5s ease-out forwards; }
    @keyframes foFlash { 0% { transform: translate(-50%,-50%) scale(0.2); opacity: 1; }
      100% { transform: translate(-50%,-50%) scale(2.6); opacity: 0; } }
    .fo-glyph { font-size: 40px; animation: foGlyph 0.7s ease-out forwards; }
    @keyframes foGlyph { 0% { transform: translate(-50%,-50%) scale(0.4); opacity: 1; }
      100% { transform: translate(-50%,-50%) scale(1.8); opacity: 0; } }
    .fo-spark { width: 6px; height: 6px; border-radius: 50%;
      animation: foSpark 0.8s ease-out forwards; }
    @keyframes foSpark {
      0% { transform: translate(-50%,-50%) translate(0,0) scale(1); opacity: 1; }
      100% { transform: translate(-50%,-50%) translate(var(--dx), var(--dy)) scale(0.3); opacity: 0; } }
    .fo-smoke { width: 16px; height: 16px; border-radius: 50%; background: rgba(70,70,70,0.7);
      animation: foSmoke 1.4s ease-out forwards; }
    @keyframes foSmoke {
      0% { transform: translate(-50%,-50%) translate(0,0) scale(0.6); opacity: 0.7; }
      100% { transform: translate(-50%,-50%) translate(var(--dx), -60px) scale(2.4); opacity: 0; } }
  `;
  document.head.appendChild(style);

  root = document.createElement('div');
  root.id = 'flyover';
  root.setAttribute('aria-hidden', 'true');

  group = document.createElement('div');
  group.className = 'fo-group';

  const banner = document.createElement('div');
  banner.className = 'fo-banner';
  bannerSpan = document.createElement('span');
  banner.appendChild(bannerSpan);

  const rope = document.createElement('div');
  rope.className = 'fo-rope';

  planeEl = document.createElement('div');
  planeEl.className = 'fo-plane';
  planeEl.textContent = '🛩️';

  // DOM order: [banner][rope][plane] — plane on the right, leading a rightward flight.
  group.append(banner, rope, planeEl);
  root.appendChild(group);

  // Live next to the board overlays. #stage is position:relative (see index.html).
  const stage = document.getElementById('stage') ?? document.body;
  stage.appendChild(root);

  // Manual triggers for testing / mischief.
  (window as Window & { flyover?: (m?: Mode) => void }).flyover = (m: Mode = 'nocrash') => launch(m);
}

/** Begin the random flyover schedule. Safe to call more than once (idempotent). */
export function startFlyovers() {
  if (!root || scheduleTimer) return;
  scheduleNext();
}

function scheduleNext() {
  clearTimeout(scheduleTimer);
  scheduleTimer = window.setTimeout(() => {
    scheduleTimer = 0;
    launch('auto');
    scheduleNext();
  }, rnd(MIN_GAP_MS, MAX_GAP_MS));
}

// Mirror the rotate power-up: when the court is portrait, the overlay matches it.
function syncRotation() {
  const fx = document.getElementById('screenFx');
  if (root && fx) root.classList.toggle('rotated', fx.classList.contains('rotated'));
}

function launch(mode: Mode) {
  if (!root || !group || !planeEl || !bannerSpan || flying) return;
  flying = true;
  syncRotation();

  const pick = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
  bannerSpan.textContent = pick.text;
  const bannerEl = group.querySelector('.fo-banner') as HTMLDivElement;
  bannerEl.className = `fo-banner ${pick.cls}`;

  const rightward = Math.random() < 0.5;
  // Mirror flips layout (plane leads on the left) and the artwork; un-mirror the text so it reads.
  group.classList.toggle('mirror', !rightward);
  bannerEl.classList.toggle('mirror', !rightward);

  root.classList.add('on');
  startEngine();

  const W = root.clientWidth || 800;
  const H = root.clientHeight || 500;
  const gw = group.offsetWidth || 320;
  const baseY = rnd(0.1, 0.4) * H;            // altitude band over the court
  const fromX = rightward ? -gw : W;
  const toX = rightward ? W : -gw;
  const crashing = mode === 'crash' || (mode === 'auto' && Math.random() < CRASH_CHANCE);
  const crashAtX = lerp(fromX, toX, rnd(0.38, 0.6)); // where the engine quits, if it does

  // rAF state
  let prevT = 0;
  let phase: 'cruise' | 'stall' | 'fall' = 'cruise';
  let x = fromX;
  let y = baseY;
  let vy = 0;          // vertical velocity during the fall (px/s)
  let planeRot = 0;    // degrees
  let stallT = 0;

  const xVel = (toX - fromX) / (CROSS_MS / 1000); // px per second, signed

  // Place it offscreen immediately so it doesn't flash at the origin before the first frame.
  group.style.transform = `translate(${fromX}px, ${baseY}px)${rightward ? '' : ' scaleX(-1)'}`;

  function frame(t: number) {
    // Seconds since last frame, clamped so a backgrounded tab doesn't teleport the plane.
    const dt = prevT ? Math.min(0.05, (t - prevT) / 1000) : 0.016;
    prevT = t;

    if (phase === 'cruise') {
      x += xVel * dt;
      y = baseY + Math.sin(t / 600) * 6; // gentle bob
      const passedCrash = rightward ? x >= crashAtX : x <= crashAtX;
      if (crashing && passedCrash) { phase = 'stall'; stallT = 0; sputterEngine(); }
      else if (rightward ? x >= toX : x <= toX) { return finish(); }
    } else if (phase === 'stall') {
      stallT += dt;
      x += xVel * dt * Math.max(0, 1 - stallT / 0.7); // forward thrust dies out
      planeRot = -22 * Math.min(1, stallT / 0.5);      // nose pitches up
      y = baseY + Math.sin(t / 600) * 6 - 6 * Math.min(1, stallT / 0.5);
      if (stallT >= 0.7) { phase = 'fall'; vy = 20; }
    } else { // fall
      vy += 900 * dt;                 // gravity
      y += vy * dt;
      x += xVel * dt * 0.15;          // a little residual drift
      planeRot += 220 * dt;           // tumble nose-down
      bannerEl.style.opacity = '0.85';
      if (y >= H * rnd(0.62, 0.72) || y >= H - 30) { return explode(x, y); }
    }

    const mir = rightward ? '' : ' scaleX(-1)';
    group!.style.transform = `translate(${x}px, ${y}px)${mir}`;
    planeEl!.style.transform = `rotate(${rightward ? planeRot : -planeRot}deg)`;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function explode(px: number, py: number) {
    // Hide the doomed aircraft and spawn the pyrotechnics at the impact point.
    group!.style.opacity = '0';
    stopEngine(0.05);
    playCrashSound();
    spawnExplosion(px, py);
    setTimeout(() => { group!.style.opacity = ''; finish(); }, 1500);
  }
}

function finish() {
  if (!root || !group) return;
  flying = false;
  stopEngine(0.4); // gentle fade as it leaves frame (no-op if a crash already cut it)
  root.classList.remove('on');
  group.classList.remove('mirror');
  group.style.transform = '';
  group.style.opacity = '';
  const bannerEl = group.querySelector('.fo-banner') as HTMLDivElement | null;
  if (bannerEl) bannerEl.style.opacity = '';
  if (planeEl) planeEl.style.transform = '';
}

function spawnExplosion(x: number, y: number) {
  if (!root) return;
  const layer = document.createElement('div');
  layer.style.position = 'absolute';
  layer.style.left = `${x}px`;
  layer.style.top = `${y}px`;
  layer.style.pointerEvents = 'none';

  const add = (cls: string, init: (el: HTMLDivElement) => void) => {
    const el = document.createElement('div');
    el.className = `fo-boom ${cls}`;
    init(el);
    layer.appendChild(el);
  };

  add('fo-flash', () => {});
  add('fo-glyph', (el) => { el.textContent = '💥'; });
  // shrapnel sparks
  const sparkColors = ['#ffd24b', '#ff7a1e', '#fff0b0', '#ff4040'];
  for (let i = 0; i < 16; i++) {
    const ang = (i / 16) * Math.PI * 2 + Math.random() * 0.4;
    const dist = rnd(40, 90);
    add('fo-spark', (el) => {
      el.style.background = sparkColors[i % sparkColors.length];
      el.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
      el.style.setProperty('--dy', `${Math.sin(ang) * dist}px`);
    });
  }
  // rising smoke puffs
  for (let i = 0; i < 5; i++) {
    add('fo-smoke', (el) => {
      el.style.setProperty('--dx', `${rnd(-24, 24)}px`);
      el.style.animationDelay = `${i * 0.08}s`;
    });
  }

  root.appendChild(layer);
  setTimeout(() => layer.remove(), 1600);
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
