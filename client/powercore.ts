// TSONG REACTOR — the glowy power cylinder with a handle at the top that you push
// into a slot and then turn the handle to lock into place. The future is finally here.
//
// Self-contained ceremony overlay (same lazy-loaded pattern as the minigames): the
// caller opens it, the player physically inserts and twists the core, and only then
// does onLocked() fire. All audio is synthesized Web Audio (no assets), gated live
// through a master gain so the M mute toggle works mid-ceremony.

export interface PowerCoreOpts {
  muted: () => boolean;
  onLocked: () => void;
  onCancel?: () => void;
}

// Logical scene size; the canvas is scaled to fit the viewport.
const W = 480;
const H = 640;
const CX = W / 2;
const CYL_W = 92;
const CYL_H = 150;
const REST_BOTTOM = 300; // cylinder bottom edge while hovering
const TRAVEL = 168; // how far it slides down to seat
const SLOT_Y = 468; // top edge of the reactor port panel
const LOCK_DEG = 90; // clockwise twist required
const CROSS_MIN = -18; // how far the wrong way it'll go before grinding
// Weight model: the core never tracks the pointer 1:1 — it chases it (lag), tops out
// at a terminal drag speed (clamp), and the last inch before the seat fights back
// until the latch grabs it and yanks it home.
const LAG_K = 6; // how hard the core chases the pointer (lower = heavier)
const MAX_V = 0.75; // terminal insertion speed, depth-units/s
const RAMP_START = 0.86; // where seating resistance begins
const RAMP_DRAG = 0.4; // speed multiplier inside the resistance zone
const SNAP_AT = 0.945; // past this the latch pulls it the rest of the way
const TWIST_LAG = 7; // handle chase rate
const TWIST_MAX_V = 140; // terminal twist speed, deg/s
const LOCK_SNAP = 82; // degrees at which the lock mechanism grabs the handle

let active = false;

// ---------- audio ----------
let actx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

function audio(): { ac: AudioContext; out: GainNode } {
  if (!actx) {
    actx = new AudioContext();
    masterGain = actx.createGain();
    masterGain.connect(actx.destination);
  }
  if (actx.state === 'suspended') void actx.resume();
  return { ac: actx, out: masterGain! };
}

function noise(ac: AudioContext): AudioBuffer {
  if (!noiseBuf) {
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

// Short synthesized one-shot: oscillator sweep with an exponential-ish decay.
function sweep(
  type: OscillatorType, f0: number, f1: number, dur: number, gain: number, delay = 0,
): void {
  const { ac, out } = audio();
  const t = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// Filtered noise burst (hiss, scrape hits, booms).
function noiseBurst(
  kind: BiquadFilterType, freq: number, dur: number, gain: number, delay = 0,
): void {
  const { ac, out } = audio();
  const t = ac.currentTime + delay;
  const src = ac.createBufferSource();
  src.buffer = noise(ac);
  const filt = ac.createBiquadFilter();
  filt.type = kind;
  filt.frequency.value = freq;
  const g = ac.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filt).connect(g).connect(out);
  src.start(t);
  src.stop(t + dur + 0.02);
}

function thunk(): void {
  sweep('sine', 120, 38, 0.18, 0.6);
  noiseBurst('lowpass', 300, 0.12, 0.35);
}

function ratchetClick(): void {
  sweep('square', 1500, 900, 0.025, 0.12);
  noiseBurst('highpass', 3000, 0.02, 0.08);
}

function lockClunk(): void {
  thunk();
  sweep('triangle', 950, 380, 0.12, 0.3, 0.04); // the latch snapping home
}

function powerUpWhine(): void {
  sweep('sawtooth', 70, 560, 0.9, 0.14);
  sweep('sine', 400, 1400, 0.9, 0.08);
  noiseBurst('lowpass', 220, 0.5, 0.4, 0.85); // the reactor breathing in
  sweep('sine', 1600, 1602, 0.6, 0.05, 0.9); // steady-state shimmer
}

function strainCreak(): void {
  // The sound of shoving against something that does not want to move.
  sweep('sawtooth', 95, 68, 0.16, 0.09);
  noiseBurst('bandpass', 420, 0.14, 0.1);
}

function grind(): void {
  sweep('sawtooth', 70, 55, 0.22, 0.3);
  noiseBurst('bandpass', 240, 0.22, 0.35);
}

function popOut(): void {
  sweep('sine', 220, 480, 0.12, 0.3);
  noiseBurst('highpass', 1800, 0.3, 0.25);
}

function powerDown(): void {
  sweep('sawtooth', 320, 55, 0.5, 0.12);
}

// Exported for the caller: pulling the core back out (turbo switched off).
export function powerCoreEject(muted: boolean): void {
  if (muted) return;
  try {
    const { out } = audio();
    out.gain.value = 1;
    noiseBurst('highpass', 1500, 0.35, 0.3); // steam hiss
    sweep('sine', 500, 120, 0.4, 0.2, 0.05);
    thunk();
  } catch { /* no audio, no problem */ }
}

// ---------- the ceremony ----------
export function openPowerCore(opts: PowerCoreOpts): void {
  if (active) return;
  active = true;

  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:rgba(2,6,12,0.88);' +
    'display:flex;align-items:center;justify-content:center;transition:opacity 0.35s;';
  const canvas = document.createElement('canvas');
  overlay.appendChild(canvas);
  document.body.appendChild(overlay);
  const ctx = canvas.getContext('2d')!;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  function resize(): void {
    const s = Math.min(window.innerWidth / W, window.innerHeight / H, 1.2);
    canvas.style.width = `${W * s}px`;
    canvas.style.height = `${H * s}px`;
    canvas.width = Math.round(W * s * dpr);
    canvas.height = Math.round(H * s * dpr);
    ctx.setTransform((canvas.width / W), 0, 0, (canvas.height / H), 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  let phase: 'insert' | 'twist' | 'locked' | 'closing' = 'insert';
  let depth = 0; // 0 hovering → 1 fully seated (actual position)
  let pushTarget = 0; // where the player is trying to shove it (may overshoot past 1)
  let angle = 0; // handle rotation in degrees, +clockwise (actual)
  let targetAngle = 0; // where the player's hand is dragging the handle
  let strainT = 0; // throttle for the straining-creak sound
  let grabbed = false;
  let twisting = false;
  let grabDY = 0;
  let lastPX = 0;
  let lastClickDeg = 0;
  let shake = 0;
  let lockT = 0;
  let closeT = -1; // >=0 while fading out
  let crossThreads = 0;
  let crossFlash = 0;
  let flame = false; // 'elon' typed during the ceremony. it is not a flamethrower.
  let eggBuf = '';
  let bobT = 0;
  let scrapeGain: GainNode | null = null;
  let scrapeSrc: AudioBufferSourceNode | null = null;
  let humNodes: Array<OscillatorNode | AudioBufferSourceNode> = [];
  let whine: OscillatorNode | null = null;
  let whineGain: GainNode | null = null;
  const held = new Set<string>();
  const particles: Array<{
    x: number; y: number; vx: number; vy: number; life: number; max: number; c: string; r: number;
  }> = [];

  function startAmbience(): void {
    try {
      const { ac, out } = audio();
      const mk = (type: OscillatorType, f: number, g: number): void => {
        const o = ac.createOscillator();
        const og = ac.createGain();
        o.type = type;
        o.frequency.value = f;
        og.gain.value = g;
        o.connect(og).connect(out);
        o.start();
        humNodes.push(o);
      };
      mk('triangle', 50, 0.05);
      mk('sine', 100, 0.025);
      mk('sine', 101.5, 0.02); // detune beat — the room is alive
      whine = ac.createOscillator();
      whineGain = ac.createGain();
      whine.type = 'sine';
      whine.frequency.value = 300;
      whineGain.gain.value = 0.012;
      whine.connect(whineGain).connect(out);
      whine.start();
      // Looping scrape bed, silent until the core is actually sliding.
      scrapeSrc = ac.createBufferSource();
      scrapeSrc.buffer = noise(ac);
      scrapeSrc.loop = true;
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 700;
      scrapeGain = ac.createGain();
      scrapeGain.gain.value = 0;
      scrapeSrc.connect(bp).connect(scrapeGain).connect(out);
      scrapeSrc.start();
      humNodes.push(scrapeSrc);
    } catch { /* audio unavailable */ }
  }

  function stopAmbience(): void {
    for (const n of humNodes) { try { n.stop(); } catch { /* already stopped */ } }
    humNodes = [];
    try { whine?.stop(); } catch { /* already stopped */ }
    whine = null;
    scrapeSrc = null;
    scrapeGain = null;
  }

  function spawnSparks(x: number, y: number, n: number, colors: string[]): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 220;
      particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60,
        life: 0, max: 0.4 + Math.random() * 0.7,
        c: colors[Math.floor(Math.random() * colors.length)],
        r: 1.5 + Math.random() * 2.5,
      });
    }
  }

  function coreColors(): { glow: string; mid: string; hot: string } {
    return flame
      ? { glow: '#ff7b1c', mid: '#ffb347', hot: '#fff3d0' }
      : { glow: '#31e6ff', mid: '#7df9ff', hot: '#eaffff' };
  }

  function cylBottom(): number {
    const bob = Math.sin(bobT * 2.2) * 5 * (1 - depth) * (grabbed ? 0 : 1);
    return REST_BOTTOM + depth * TRAVEL + bob;
  }

  function seat(): void {
    depth = 1;
    phase = 'twist';
    targetAngle = 0;
    lastClickDeg = 0;
    shake = 9;
    thunk();
    spawnSparks(CX, SLOT_Y, 10, ['#9fb6c9', '#e0ecf5']);
  }

  function lock(): void {
    angle = LOCK_DEG;
    phase = 'locked';
    lockT = 0;
    shake = 12;
    lockClunk();
    powerUpWhine();
    const c = coreColors();
    spawnSparks(CX, SLOT_Y - 40, 40, [c.glow, c.mid, c.hot]);
  }

  function crossThread(): void {
    crossThreads++;
    crossFlash = 1;
    shake = 7;
    grind();
    spawnSparks(CX + CYL_W / 2, SLOT_Y - 10, 8, ['#ffb347', '#ff5c33']);
    if (crossThreads >= 3) {
      // Third strike: the reactor spits the core back out. Threads are sacred.
      popOut();
      phase = 'insert';
      angle = 0;
      targetAngle = 0;
      depth = 0.9; // launched back out; loop's spring-back handles the rest
      pushTarget = 0;
      grabbed = false;
      twisting = false;
      crossThreads = 0;
      spawnSparks(CX, SLOT_Y - 20, 22, ['#ffb347', '#ff5c33', '#fff3d0']);
    }
  }

  function finish(cancelled: boolean): void {
    if (closeT >= 0) return;
    closeT = 0;
    overlay.style.opacity = '0';
    if (cancelled) powerDown();
    window.setTimeout(() => {
      cleanup();
      if (cancelled) opts.onCancel?.();
      else opts.onLocked();
    }, 380);
  }

  // ---------- input ----------
  function toLogical(e: PointerEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  }

  function onPointerDown(e: PointerEvent): void {
    const p = toLogical(e);
    const bottom = cylBottom();
    const top = bottom - CYL_H - 52; // include the handle
    const withinX = Math.abs(p.x - CX) < CYL_W / 2 + 34;
    if (phase === 'insert' && withinX && p.y > top - 16 && p.y < bottom + 10) {
      grabbed = true;
      grabDY = p.y - bottom;
      canvas.setPointerCapture(e.pointerId);
    } else if (phase === 'twist' && withinX && p.y > top - 20 && p.y < SLOT_Y) {
      twisting = true;
      lastPX = p.x;
      canvas.setPointerCapture(e.pointerId);
    }
  }

  function onPointerMove(e: PointerEvent): void {
    const p = toLogical(e);
    if (grabbed && phase === 'insert') {
      // The pointer only sets where you're *trying* to put it; the core itself
      // chases that point in the step loop, with lag and a terminal speed.
      pushTarget = Math.min(1.15, Math.max(0, (p.y - grabDY - REST_BOTTOM) / TRAVEL));
    } else if (twisting && phase === 'twist') {
      const d = (p.x - lastPX) * 0.55;
      lastPX = p.x;
      applyTwist(d);
    }
  }

  function onPointerUp(): void {
    grabbed = false;
    twisting = false;
    if (scrapeGain) scrapeGain.gain.value = 0;
  }

  function applyTwist(d: number): void {
    if (phase !== 'twist') return;
    // Player input moves the hand; the handle itself catches up in the step loop.
    targetAngle = Math.min(LOCK_DEG + 20, Math.max(CROSS_MIN, targetAngle + d));
    if (targetAngle <= CROSS_MIN && d < 0 && crossFlash <= 0) crossThread();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'm' || e.key === 'M') return; // mute passes through to the game
    e.stopPropagation();
    if (e.key === 'Escape') {
      if (phase !== 'locked') finish(true);
      return;
    }
    if (e.key.startsWith('Arrow')) e.preventDefault();
    held.add(e.key.toLowerCase());
    if (e.key.length === 1) {
      eggBuf = (eggBuf + e.key.toLowerCase()).slice(-4);
      if (eggBuf === 'elon' && !flame) {
        flame = true;
        sweep('sawtooth', 90, 240, 0.35, 0.2); // ignition. still not a flamethrower.
        noiseBurst('lowpass', 500, 0.4, 0.3);
        spawnSparks(CX, cylBottom() - CYL_H / 2, 24, ['#ff7b1c', '#ffb347', '#fff3d0']);
      }
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (e.key === 'm' || e.key === 'M') return;
    e.stopPropagation();
    held.delete(e.key.toLowerCase());
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  // Capture on window so the game's document-level key handlers never see these.
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);

  startAmbience();

  let raf = 0;
  let lastT = performance.now();

  function cleanup(): void {
    cancelAnimationFrame(raf);
    stopAmbience();
    window.removeEventListener('resize', resize);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    overlay.remove();
    active = false;
  }

  function step(t: number): void {
    const dt = Math.min(0.05, (t - lastT) / 1000);
    lastT = t;
    bobT += dt;
    if (shake > 0) shake = Math.max(0, shake - dt * 30);
    if (crossFlash > 0) crossFlash = Math.max(0, crossFlash - dt * 1.4);

    // Live mute gate so M works mid-ceremony.
    if (masterGain) masterGain.gain.value = opts.muted() ? 0 : 1;
    if (scrapeGain) scrapeGain.gain.value *= 0.8; // scrape dies out when the core stops moving

    // --- weight simulation ---
    if (phase === 'insert') {
      const pushingKey = held.has('arrowdown') || held.has('s');
      if (pushingKey) pushTarget = Math.min(1.15, Math.max(pushTarget, depth) + dt * 0.9);
      strainT += dt;
      if (grabbed || pushingKey) {
        // Chase the hand: lag toward pushTarget, clamped to a terminal speed.
        const err = pushTarget - depth;
        let step = Math.max(-MAX_V, Math.min(MAX_V, err * LAG_K)) * dt;
        if (depth > RAMP_START && step > 0) {
          step *= RAMP_DRAG; // the last inch fights back
          if (err > 0.08 && strainT > 0.24) { strainCreak(); strainT = 0; }
        }
        depth = Math.max(0, depth + step);
        if (scrapeGain && Math.abs(step) > 0.0004) {
          scrapeGain.gain.value = Math.min(0.3, Math.abs(step / dt) * 0.35);
        }
        if (depth >= SNAP_AT) { grabbed = false; seat(); } // the latch grabs it
      } else if (depth > 0) {
        depth = Math.max(0, depth - dt * 2.2); // springs back if you let go
        pushTarget = 0;
      }
    } else if (phase === 'twist') {
      if (held.has('arrowright') || held.has('d')) applyTwist(dt * 120);
      // The handle is stiff: it chases your hand, never keeps up with a yank.
      const err = targetAngle - angle;
      const prev = angle;
      angle += Math.max(-TWIST_MAX_V, Math.min(TWIST_MAX_V, err * TWIST_LAG)) * dt;
      angle = Math.max(CROSS_MIN, angle);
      if (angle < lastClickDeg) lastClickDeg = angle; // backing off re-arms the ratchet
      if (angle > prev && Math.floor(angle / 15) > Math.floor(lastClickDeg / 15)) {
        ratchetClick();
        lastClickDeg = angle;
      }
      if (angle >= LOCK_SNAP) lock(); // close enough — the mechanism yanks it home
    }

    if (whine && whineGain) {
      const c = phase === 'locked' ? 1 : depth;
      whine.frequency.value = 300 + c * 480 + (angle / LOCK_DEG) * 160;
      whineGain.gain.value = 0.012 + c * 0.02;
    }

    if (phase === 'locked') {
      lockT += dt;
      const cc = coreColors();
      if (Math.random() < 0.5) {
        particles.push({
          x: CX + (Math.random() - 0.5) * 60, y: SLOT_Y - 10,
          vx: (Math.random() - 0.5) * 20, vy: -60 - Math.random() * 80,
          life: 0, max: 0.8 + Math.random() * 0.6, c: cc.mid, r: 1 + Math.random() * 2,
        });
      }
      if (lockT > 1.7) finish(false);
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      if (p.life > p.max) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 260 * dt;
    }

    drawScene();
    raf = requestAnimationFrame(step);
  }

  // ---------- drawing ----------
  function drawScene(): void {
    const c = coreColors();
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);

    // Backdrop: vignette + faint machine grid.
    const bg = ctx.createRadialGradient(CX, H * 0.55, 60, CX, H * 0.55, 420);
    bg.addColorStop(0, '#0d1826');
    bg.addColorStop(1, '#04070c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(80,130,170,0.07)';
    ctx.lineWidth = 1;
    for (let x = 20; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 20; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    // Title plate.
    ctx.textAlign = 'center';
    ctx.fillStyle = '#c8dcec';
    ctx.font = 'bold 22px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText('⚡ TSONG REACTOR ⚡', CX, 52);
    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(160,190,215,0.75)';
    const hint =
      phase === 'insert' ? 'GRAB THE CORE · PUSH IT INTO THE SLOT'
      : phase === 'twist' ? 'TWIST THE HANDLE CLOCKWISE TO LOCK  ⟳'
      : phase === 'locked' ? '' : '';
    if (hint) ctx.fillText(hint, CX, 78);

    drawCables(c);
    drawSocketBack(c);
    drawCylinder(c);
    drawSocketFront(c);
    drawParticles();

    // Twist progress arc around the port.
    if (phase === 'twist' || phase === 'locked') {
      const frac = Math.max(0, angle) / LOCK_DEG;
      ctx.beginPath();
      ctx.arc(CX, SLOT_Y + 6, 78, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
      ctx.strokeStyle = c.glow;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.9;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Cross-thread warning stamp.
    if (crossFlash > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, crossFlash * 1.4);
      ctx.translate(CX, 330);
      ctx.rotate(-0.08);
      ctx.fillStyle = '#ff5c33';
      ctx.font = 'bold 26px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText('CROSS-THREADED!', 0, 0);
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText('(righty-tighty)', 0, 22);
      ctx.restore();
    }

    // Lock celebration.
    if (phase === 'locked') {
      const r = lockT * 700;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.max(0, 0.5 - lockT * 0.45);
      ctx.beginPath();
      ctx.arc(CX, SLOT_Y - 30, r, 0, Math.PI * 2);
      ctx.strokeStyle = c.hot;
      ctx.lineWidth = 10;
      ctx.stroke();
      ctx.restore();
      if (lockT > 0.25) {
        ctx.fillStyle = c.hot;
        ctx.font = 'bold 24px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.shadowColor = c.glow;
        ctx.shadowBlur = 18;
        ctx.fillText(flame ? '🔥 REACTOR ONLINE 🔥' : '⚡ REACTOR ONLINE ⚡', CX, 150);
        ctx.shadowBlur = 0;
        ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = 'rgba(200,230,245,0.85)';
        ctx.fillText('TURBO ENGAGED', CX, 174);
      }
    }

    // Footer hint.
    ctx.fillStyle = 'rgba(140,170,195,0.5)';
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    if (phase !== 'locked') ctx.fillText('esc to walk away  ·  or hold ↓ then →', CX, H - 24);
    ctx.restore();
  }

  function drawCables(c: { glow: string }): void {
    const lit = phase === 'locked' ? 0.85 : 0.15 + depth * 0.2;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(CX + dir * 70, SLOT_Y + 60);
      ctx.bezierCurveTo(CX + dir * 150, SLOT_Y + 70, CX + dir * 180, H - 40, CX + dir * 240, H - 10);
      ctx.strokeStyle = '#1b2836';
      ctx.lineWidth = 10;
      ctx.stroke();
      ctx.strokeStyle = c.glow;
      ctx.globalAlpha = lit;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function drawSocketBack(c: { glow: string }): void {
    // The dark mouth of the slot, glowing brighter as the core descends.
    ctx.fillStyle = '#010204';
    ctx.beginPath();
    ctx.ellipse(CX, SLOT_Y, CYL_W / 2 + 10, 14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.12 + depth * 0.3 + (phase === 'locked' ? 0.4 : 0);
    const g = ctx.createRadialGradient(CX, SLOT_Y, 4, CX, SLOT_Y, 70);
    g.addColorStop(0, c.glow);
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(CX, SLOT_Y, 70, 22, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawCylinder(c: { glow: string; mid: string; hot: string }): void {
    const bottom = cylBottom();
    const top = bottom - CYL_H;
    const x0 = CX - CYL_W / 2;

    ctx.save();
    // Everything below the slot mouth is inside the machine.
    ctx.beginPath();
    ctx.rect(0, 0, W, SLOT_Y + 4);
    ctx.clip();

    // Body: brushed metal with rounded shoulders.
    const body = ctx.createLinearGradient(x0, 0, x0 + CYL_W, 0);
    body.addColorStop(0, '#3a4a5c');
    body.addColorStop(0.15, '#8fa5ba');
    body.addColorStop(0.5, '#5c7186');
    body.addColorStop(0.85, '#8fa5ba');
    body.addColorStop(1, '#33414f');
    ctx.fillStyle = body;
    roundRect(x0, top, CYL_W, CYL_H, 14);
    ctx.fill();

    // The glowy part: plasma window with drifting energy bands.
    const wx = x0 + 14;
    const ww = CYL_W - 28;
    const wy = top + 26;
    const wh = CYL_H - 52;
    ctx.save();
    roundRect(wx, wy, ww, wh, 8);
    ctx.clip();
    const pg = ctx.createLinearGradient(0, wy, 0, wy + wh);
    pg.addColorStop(0, c.mid);
    pg.addColorStop(0.5, c.glow);
    pg.addColorStop(1, c.mid);
    ctx.fillStyle = pg;
    ctx.fillRect(wx, wy, ww, wh);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 4; i++) {
      const yy = wy + ((bobT * 30 + i * (wh / 4)) % wh);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = c.hot;
      ctx.fillRect(wx, yy, ww, 3);
    }
    ctx.restore();
    ctx.save();
    ctx.shadowColor = c.glow;
    ctx.shadowBlur = 24 + Math.sin(bobT * 3) * 6 + (phase === 'locked' ? 20 : 0);
    ctx.strokeStyle = c.mid;
    ctx.lineWidth = 2;
    roundRect(wx, wy, ww, wh, 8);
    ctx.stroke();
    ctx.restore();

    // Label — regulation matters.
    ctx.save();
    ctx.translate(x0 + CYL_W - 7, top + CYL_H / 2);
    ctx.rotate(Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(10,16,22,0.85)';
    ctx.font = 'bold 8px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(flame ? 'NOT-A-FLAMETHROWER™' : 'TSONG⚡CELL · MK-1', 0, 0);
    ctx.restore();

    // Rivets.
    ctx.fillStyle = '#26313d';
    for (const yy of [top + 12, bottom - 12]) {
      for (const xx of [x0 + 10, x0 + CYL_W - 10]) {
        ctx.beginPath();
        ctx.arc(xx, yy, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    drawHandle(top, c);
    ctx.restore();
  }

  function drawHandle(cylTop: number, c: { glow: string }): void {
    // Stirrup handle: two posts and a crossbar that visibly rotates when twisted.
    const rad = (angle * Math.PI) / 180;
    const squish = Math.abs(Math.cos(rad)); // crossbar foreshortens as it turns
    const hw = (CYL_W / 2 - 8) * squish + 6;
    const hy = cylTop - 34;
    ctx.strokeStyle = '#a9bccd';
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(CX - hw, cylTop - 2);
    ctx.lineTo(CX - hw, hy + 8);
    ctx.quadraticCurveTo(CX - hw, hy, CX - hw + 8 * squish + 2, hy);
    ctx.lineTo(CX + hw - 8 * squish - 2, hy);
    ctx.quadraticCurveTo(CX + hw, hy, CX + hw, hy + 8);
    ctx.lineTo(CX + hw, cylTop - 2);
    ctx.stroke();
    ctx.strokeStyle = '#5c7186';
    ctx.lineWidth = 4;
    ctx.stroke();
    // Grip wrap glows once locked.
    if (phase === 'locked') {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = c.glow;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.moveTo(CX - hw + 6, hy);
      ctx.lineTo(CX + hw - 6, hy);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawSocketFront(c: { glow: string }): void {
    // The reactor port panel the core sinks into.
    const py = SLOT_Y;
    ctx.fillStyle = '#111c28';
    roundRect(CX - 130, py, 260, 92, 10);
    ctx.fill();
    ctx.strokeStyle = '#2b3c4e';
    ctx.lineWidth = 2;
    roundRect(CX - 130, py, 260, 92, 10);
    ctx.stroke();
    // Caution chevrons.
    ctx.save();
    roundRect(CX - 130, py + 74, 260, 12, 4);
    ctx.clip();
    for (let x = -140; x < 140; x += 24) {
      ctx.fillStyle = (Math.floor(x / 24) % 2 === 0) ? '#c9a227' : '#1a2430';
      ctx.save();
      ctx.translate(CX + x, py + 74);
      ctx.transform(1, 0, 0.6, 1, 0, 0);
      ctx.fillRect(0, 0, 12, 12);
      ctx.restore();
    }
    ctx.restore();
    // Port rim.
    ctx.strokeStyle = '#3f5468';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.ellipse(CX, py, CYL_W / 2 + 8, 13, 0, 0, Math.PI * 2);
    ctx.stroke();
    // Status LEDs: light up as the core seats, all-green pulse when locked.
    const stages = [0.33, 0.66, 0.999];
    for (let i = 0; i < 3; i++) {
      const on = phase === 'locked' || depth >= stages[i];
      const pulse = phase === 'locked' ? 0.6 + Math.sin(bobT * 8 + i) * 0.4 : 1;
      ctx.beginPath();
      ctx.arc(CX - 100 + i * 22, py + 30, 5, 0, Math.PI * 2);
      ctx.fillStyle = on ? (phase === 'locked' ? '#54ff7a' : c.glow) : '#22303e';
      ctx.globalAlpha = on ? pulse : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = 'rgba(160,190,215,0.6)';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('REACTOR PORT 1', CX - 108, py + 54);
    ctx.textAlign = 'right';
    ctx.fillText(phase === 'locked' ? 'LOCKED' : `${Math.round(depth * 100)}%`, CX + 108, py + 54);
    ctx.textAlign = 'center';
  }

  function drawParticles(): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, 1 - p.life / p.max);
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function roundRect(x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  raf = requestAnimationFrame(step);
}
