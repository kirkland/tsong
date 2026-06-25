// Street Demons: Grand Prix — a 4-player pseudo-3D arcade racer, launched from tsong's arcade.
//
// Early-Mario-Kart / F-Zero styling: a "Mode 7"-flavoured floor-cast ground plane viewed from
// behind-and-above the car (NOT a bird's-eye view), on a neon ribbon of track floating in the
// sky. Boost strips refill your energy and slingshot you forward; scraping the guard rails slows
// you and drains energy; run out of energy and your demon RETIRES in a fireball. First demon to
// finish 3 laps wins the Grand Prix.
//
// Like Nuketown/DOOM it's deliberately isolated — its own fullscreen overlay, canvas, input
// handlers and game loop, all torn down on exit, never touching the Pong state. Netcode is
// host-authoritative over the server's dumb sr* broadcast relay: slot 0 (the first joiner) is the
// host. It simulates EVERY car — its own from local input, other humans from their relayed input,
// and fills any empty grid slots with bots — then streams `{t:'st'}` world snapshots ~20/s.
// Guests send `{t:'in'}` input ~30/s and render the host's world from their own car's POV.
//
// Rendering runs at a chunky internal resolution and is CSS-upscaled (pixelated) for the retro
// look. The floor projection and the car billboards share one camera basis so sprites sit exactly
// on the ground at every depth.

// --- internal framebuffer size (CSS-upscaled) ---
const W = 240;
const H = 148;
const HORIZON = Math.round(H * 0.4); // screen row of the horizon line (sky above, track below)

// --- camera / projection ---
// Forward projection of a ground point at forward-depth d and transverse offset s (s>0 = right):
//   screenX = W/2 + FOCAL * s / d ;  screenY = HORIZON + FOCAL * CAM_H / d
// The floor caster is the exact inverse, so billboards and ground always agree.
const FOCAL = 150;     // ~70° horizontal FOV at this width
const CAM_H = 3.4;     // camera eye height above the track, world units
const CAM_BACK = 7;    // how far behind the car the chase camera sits
const NEAR = 0.6;      // nearest renderable depth (clip behind-camera sprites)
const FAR_FOG = 150;   // depth at which the ground fully fades into the horizon haze

// --- track: a neon ellipse ribbon. on/off-track uses the cheap implicit ellipse value g (=1 on
// the centreline); angular features (boost zones, the finish line, lap progress) use phi. ---
const TA = 72;         // ellipse semi-axis X (world units)
const TB = 46;         // ellipse semi-axis Y
const BAND = 0.17;     // half-width of the track in g-space (|g-1| <= BAND is on-track)
const LAPS = 3;        // laps to win the Grand Prix
// Boost strips live on two angular spans: the far straight (around phi = ±π) and a short pad on
// the lower-left sweeper. phi is atan2(y,x).
function isBoost(phi: number): boolean {
  // far straight: within 0.55 rad of ±π
  if (Math.abs(Math.abs(phi) - Math.PI) < 0.55) return true;
  if (phi > -2.55 && phi < -1.95) return true;
  return false;
}
// Finish line sits on the +x axis (phi ≈ 0); cars start just behind it and race CCW (phi rising).
function isFinish(phi: number): boolean { return Math.abs(phi) < 0.05; }

// implicit ellipse value (≈1 on the centreline) + polar angle, for a world point
function ellipseG(x: number, y: number): number { return Math.hypot(x / TA, y / TB); }

// world point on the centreline at angle phi
function centre(phi: number): { x: number; y: number } { return { x: TA * Math.cos(phi), y: TB * Math.sin(phi) }; }
// outward unit normal of the ellipse at angle phi (gradient of g), for lane offsets + rail pushback
function normal(phi: number): { x: number; y: number } {
  let nx = Math.cos(phi) / TA, ny = Math.sin(phi) / TB;
  const m = Math.hypot(nx, ny) || 1;
  return { x: nx / m, y: ny / m };
}

const CAR_COLORS = ['#ff3b3b', '#3ba6ff', '#ffd23b', '#5dff8f']; // P1 red, P2 blue, P3 gold, P4 green
const BOT_NAMES = ['ROAD-HOG', 'NITRO-NUN', 'V8 VANDAL', 'GHOST RIDER', 'TURBO TINA', 'MAX REV', 'DIESEL'];

// --- physics tuning ---
const MAX_SPD = 58;
const BOOST_SPD = 84;
const ACCEL = 36;
const BRAKE = 52;
const REV_SPD = 16;
const FRICTION = 16;     // passive deceleration when coasting
const TURN_RATE = 2.4;   // rad/s at full grip
const BOOST_ACCEL = 78;
const BOOST_HEAL = 30;   // energy/sec regained on a boost strip
const WALL_DPS = 34;     // energy/sec drained while grinding a rail
const WALL_SLOW = 0.93;  // per-frame speed multiplier while on a rail
const HEALTH_MAX = 100;
const COUNTDOWN = 3.2;   // seconds of "3 · 2 · 1 · GO"
const ROCKET_WINDOW = 0.5; // hold throttle within this many seconds of GO for a launch boost

function escapeText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

// A racer. The host owns the canonical array; guests mirror it from snapshots (and smooth it).
interface Car {
  slot: number;
  name: string;
  color: string;
  bot: boolean;
  x: number; y: number; angle: number; speed: number;
  health: number;
  crossings: number;   // finish-line passes (1 = the start; LAPS+1 = finished)
  passedHalf: boolean; // crossed the far side since the last finish pass (anti-cheese)
  prevPhi: number;
  progress: number;    // continuous race progress for ranking (crossings*2π + phi)
  alive: boolean;
  finished: boolean;
  place: number;       // final finishing place (0 = unset)
  boosting: number;    // seconds of boost glow remaining (visual + speed bump)
  // bot-only
  skill: number;
  revHold?: number;    // host-only: seconds the gas has been held during the countdown (rocket start)
  // render smoothing (guests)
  dx?: number; dy?: number; dAngle?: number;
}
// Input a guest sends the host (and the host uses for its own car). throttle/steer are -1|0|1.
interface NetInput { throttle: number; steer: number; held: boolean; }

// Networking hook into the host websocket, provided by main.ts (mirrors NuketownNet).
export interface StreetDemonsNet {
  join(): void;
  leave(): void;
  start(): void;
  relay(data: unknown): void;
  end(winner: number): void; // (host only) winning slot so the server can pay the racer (-1 = bot)
  name(): string;            // this client's display name
}

// Lobby snapshot pushed from the server (matches shared/types SrLobbyMsg).
interface SrLobby {
  status: 'waiting' | 'playing' | 'ended';
  slot: number;
  hostSlot: number;
  players: { name: string; slot: number }[];
}

// Module-level feed hooks main.ts calls when an sr* message arrives.
let handlers: { lobby: (m: SrLobby) => void; relay: (d: unknown) => void } | null = null;
export function feedSrLobby(m: SrLobby) { handlers?.lobby(m); }
export function feedSrRelay(d: unknown) { handlers?.relay(d); }

let srOpen = false;

export function startStreetDemons(net: StreetDemonsNet): void {
  if (srOpen) return;
  srOpen = true;

  type Mode = 'menu' | 'lobby' | 'play';
  let mode: Mode = 'menu';
  let selfSlot = 0;
  let isHost = false;
  let lobbyState: SrLobby | null = null;

  // --- DOM overlay ---
  const overlay = document.createElement('div');
  overlay.id = 'streetDemonsOverlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:#05060f;display:flex;align-items:center;' +
    'justify-content:center;flex-direction:column;font-family:ui-monospace,monospace;';

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.style.cssText =
    'image-rendering:pixelated;height:90vh;max-width:100vw;aspect-ratio:' + W + '/' + H + ';background:#05060f;';
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  overlay.appendChild(canvas);

  // Reusable framebuffer for the sky + floor (sprites are drawn over it with ctx).
  const frame = ctx.createImageData(W, H);
  const buf = new Uint32Array(frame.data.buffer);

  // Precompute a sky gradient (deep space → neon horizon) + a fixed starfield, blitted each frame.
  const skyRow = new Uint32Array(HORIZON);
  for (let y = 0; y < HORIZON; y++) {
    const t = y / HORIZON; // 0 top → 1 horizon
    const r = Math.round(12 + t * t * 70);
    const g = Math.round(6 + t * 30);
    const b = Math.round(28 + t * 90);
    skyRow[y] = pack(r, g, b);
  }
  // deterministic star positions (no Math.random reliance beyond layout — fine for a client toy)
  const stars: { x: number; y: number; b: number }[] = [];
  for (let i = 0; i < 60; i++) {
    stars.push({ x: (i * 67) % W, y: (i * 41) % (HORIZON - 2), b: 140 + (i * 53) % 110 });
  }

  // --- HUD ---
  const hud = document.createElement('div');
  hud.style.cssText =
    'position:absolute;top:10px;left:14px;font:800 18px ui-monospace,monospace;color:#ffd166;' +
    'text-shadow:2px 2px 0 #000;letter-spacing:1px;pointer-events:none;line-height:1.45;';
  overlay.appendChild(hud);

  const posBadge = document.createElement('div');
  posBadge.style.cssText =
    'position:absolute;top:10px;right:16px;font:900 30px ui-monospace,monospace;color:#fff;' +
    'text-shadow:2px 2px 0 #000;pointer-events:none;text-align:right;';
  overlay.appendChild(posBadge);

  // energy (health) bar, bottom-centre
  const energyWrap = document.createElement('div');
  energyWrap.style.cssText =
    'position:absolute;bottom:5vh;left:50%;transform:translateX(-50%);width:46vh;max-width:380px;' +
    'height:16px;border:2px solid #1a2b50;border-radius:9px;background:#0a1226;overflow:hidden;' +
    'box-shadow:0 0 14px rgba(40,120,255,0.35);pointer-events:none;';
  const energyFill = document.createElement('div');
  energyFill.style.cssText = 'height:100%;width:100%;background:linear-gradient(90deg,#19d2ff,#5dff8f);transition:width 80ms linear;';
  energyWrap.appendChild(energyFill);
  overlay.appendChild(energyWrap);
  const energyLabel = document.createElement('div');
  energyLabel.style.cssText =
    'position:absolute;bottom:calc(5vh + 20px);left:50%;transform:translateX(-50%);' +
    'font:700 11px ui-monospace,monospace;color:#9fd8ff;text-shadow:1px 1px 0 #000;pointer-events:none;letter-spacing:2px;';
  energyLabel.textContent = 'ENERGY';
  overlay.appendChild(energyLabel);

  const banner = document.createElement('div');
  banner.style.cssText =
    'position:absolute;inset:0;display:none;align-items:center;justify-content:center;' +
    'font:900 64px ui-monospace,monospace;color:#ffd23b;text-shadow:5px 5px 0 #000;text-align:center;' +
    'white-space:pre;pointer-events:none;line-height:1.1;';
  overlay.appendChild(banner);

  // --- menu / lobby layer ---
  const menu = document.createElement('div');
  menu.style.cssText =
    'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:safe center;gap:18px;padding:3vh 16px;overflow-y:auto;' +
    'background:radial-gradient(circle at 50% 30%,rgba(40,20,80,0.7),rgba(5,6,15,0.96));';
  const menuTitle = document.createElement('div');
  menuTitle.innerHTML = '🏁 STREET DEMONS';
  menuTitle.style.cssText =
    'font:900 52px ui-monospace,monospace;color:#ff4d6d;text-shadow:4px 4px 0 #2a0010,0 0 24px rgba(255,77,109,0.6);';
  const menuSub = document.createElement('div');
  menuSub.textContent = 'G R A N D   P R I X';
  menuSub.style.cssText = 'font:700 20px ui-monospace,monospace;color:#ffd23b;letter-spacing:8px;text-shadow:2px 2px 0 #000;';
  const menuMsg = document.createElement('div');
  menuMsg.style.cssText = 'font:700 15px ui-monospace,monospace;color:#9fb0d8;min-height:20px;text-align:center;';
  const menuInfo = document.createElement('div');
  menuInfo.style.cssText =
    'max-width:540px;font:600 13px ui-monospace,monospace;color:#9fb0d8;line-height:1.7;text-align:center;';
  menuInfo.innerHTML =
    '<div style="color:#cdd7f5;font-weight:700;margin-bottom:4px">4-RACER PSEUDO-3D RACE · ' + LAPS + ' LAPS</div>' +
    'Join the grid, then the host drops the green light — empty slots fill with <b>demon bots</b>, ' +
    'so you can race solo against three. Ride the <span style="color:#19d2ff">boost strips</span> to ' +
    'refill energy and rocket forward; scrape the <span style="color:#ff5c5c">rails</span> and you bleed ' +
    'energy and bog down. Hit <b>zero energy</b> and your demon <span style="color:#ff5c5c">RETIRES</span>.' +
    '<div style="margin-top:10px">↑/W gas · ↓/S brake · ←→/AD steer · ESC quit</div>';

  const mkBtn = (label: string) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'font:800 20px ui-monospace,monospace;padding:14px 30px;border-radius:8px;cursor:pointer;' +
      'border:1px solid #7a1830;background:#1a0610;color:#ff7591;';
    b.onmouseenter = () => { b.style.background = '#2a0a18'; };
    b.onmouseleave = () => { b.style.background = '#1a0610'; };
    return b;
  };
  const joinBtn = mkBtn('JOIN GRID');
  const startBtn = mkBtn('START RACE');
  const leaveBtn = mkBtn('LEAVE');
  const exitBtn = mkBtn('EXIT');
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;justify-content:center;';
  btnRow.append(joinBtn, startBtn, leaveBtn, exitBtn);

  const roster = document.createElement('div');
  roster.style.cssText =
    'display:flex;gap:14px;justify-content:center;flex-wrap:wrap;min-height:44px;font:700 14px ui-monospace,monospace;text-shadow:1px 1px 0 #000;';
  menu.append(menuTitle, menuSub, menuMsg, btnRow, roster, menuInfo);
  overlay.appendChild(menu);
  document.body.appendChild(overlay);

  function renderRoster() {
    const ps = lobbyState?.players ?? [];
    const cells = Array.from({ length: 4 }, (_, i) => {
      const p = ps[i];
      const col = CAR_COLORS[i];
      const label = p ? `${escapeText(p.name)}${i === 0 ? ' 👑' : ''}` : '<span style="opacity:0.5">demon bot</span>';
      return `<div style="border:2px solid ${col};border-radius:8px;padding:8px 12px;min-width:120px;background:rgba(0,0,0,0.35)">` +
        `<div style="color:${col};font-size:11px">P${i + 1}</div>${label}</div>`;
    });
    roster.innerHTML = cells.join('');
  }

  function syncMenuButtons() {
    joinBtn.style.display = mode === 'menu' ? '' : 'none';
    exitBtn.style.display = mode === 'menu' ? '' : 'none';
    leaveBtn.style.display = mode === 'lobby' ? '' : 'none';
    const isLeader = selfSlot === 0;
    startBtn.style.display = mode === 'lobby' && isLeader ? '' : 'none';
    if (mode === 'lobby') {
      const n = lobbyState?.players.length ?? 1;
      menuMsg.textContent = isLeader
        ? `You're on pole — START when ready (${n} human${n === 1 ? '' : 's'}, ${4 - n} bot${4 - n === 1 ? '' : 's'}).`
        : `On the grid (${n}/4) — waiting for the host to drop the lights…`;
    }
  }

  // --- world state ---
  let cars: Car[] = [];
  let phase: 'countdown' | 'race' | 'done' = 'countdown';
  let countdown = COUNTDOWN;
  let raceTime = 0;
  let winner = -1;        // winning slot once the race resolves
  let finishOrder: number[] = []; // slots in the order they finished
  let endReported = false;

  // host: latest relayed input per guest slot
  const guestInputs = new Map<number, NetInput>();

  // local input
  const keys = new Set<string>();
  let netAccum = 0;
  let lastHurt = 0;       // local energy, for a red flash when it drops
  let shake = 0;          // screen-shake timer (rail hits / explosions)
  const me = (): Car | undefined => cars.find((c) => c.slot === selfSlot);

  // --- audio (engine drone tracks own speed; plus boost/crash/finish blips) ---
  let audio: AudioContext | null = null;
  let engine: { osc: OscillatorNode; gain: GainNode } | null = null;
  const ac = () => (audio ??= new AudioContext());
  function startEngine() {
    try {
      const a = ac();
      const osc = a.createOscillator(); osc.type = 'sawtooth';
      const gain = a.createGain(); gain.gain.value = 0.0;
      const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
      osc.connect(lp); lp.connect(gain); gain.connect(a.destination);
      osc.start();
      engine = { osc, gain };
    } catch { /* ignore */ }
  }
  function blip(freq: number, dur: number, type: OscillatorType, vol = 0.25) {
    try {
      const a = ac();
      const osc = a.createOscillator(); osc.type = type; osc.frequency.value = freq;
      const g = a.createGain(); g.gain.value = vol;
      g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
      osc.connect(g); g.connect(a.destination); osc.start(); osc.stop(a.currentTime + dur);
    } catch { /* ignore */ }
  }
  function crashSound() {
    try {
      const a = ac();
      const buf = a.createBuffer(1, a.sampleRate * 0.25, a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
      const src = a.createBufferSource(); src.buffer = buf;
      const g = a.createGain(); g.gain.value = 0.3;
      src.connect(g); g.connect(a.destination); src.start();
    } catch { /* ignore */ }
  }

  // ---------- host simulation ----------

  // Place a car on the grid at angle phi with a lateral lane offset (along the track normal).
  function placeOnGrid(c: Car, phi: number, lane: number) {
    const ce = centre(phi), n = normal(phi);
    // tangent (direction of increasing phi) for the heading
    const ct = centre(phi + 0.01);
    c.x = ce.x + n.x * lane;
    c.y = ce.y + n.y * lane;
    c.angle = Math.atan2(ct.y - ce.y, ct.x - ce.x);
    c.speed = 0;
    c.health = HEALTH_MAX;
    c.crossings = 1;       // they sit on the line; the first true pass completes lap 1
    c.passedHalf = false;
    c.prevPhi = phi;
    c.progress = 1 * 2 * Math.PI + phi;
    c.alive = true;
    c.finished = false;
    c.place = 0;
    c.boosting = 0;
    c.revHold = 0;
  }

  function buildGrid() {
    const humans = lobbyState?.players ?? [];
    cars = [];
    // starting slots: two rows of two, just behind the finish line (phi slightly negative)
    const gridPhi = [-0.07, -0.07, -0.13, -0.13];
    const gridLane = [4.5, -4.5, 4.5, -4.5];
    let botIdx = 0;
    for (let slot = 0; slot < 4; slot++) {
      const human = humans[slot];
      const c: Car = {
        slot,
        name: human ? human.name : BOT_NAMES[botIdx++ % BOT_NAMES.length],
        color: CAR_COLORS[slot],
        bot: !human,
        x: 0, y: 0, angle: 0, speed: 0, health: HEALTH_MAX,
        crossings: 1, passedHalf: false, prevPhi: 0, progress: 0,
        alive: true, finished: false, place: 0, boosting: 0,
        skill: 0.82 + (slot * 0.05) % 0.18, // bots: a spread of competence
      };
      placeOnGrid(c, gridPhi[slot], gridLane[slot]);
      cars.push(c);
    }
  }

  // Bot driving: aim at a look-ahead point on the centreline and chase it; ease the throttle when
  // badly misaligned (i.e. mid-corner) so they don't plough into the rails.
  function botInput(c: Car): NetInput {
    const phi = Math.atan2(c.y, c.x);
    const look = 0.18 + (c.speed / MAX_SPD) * 0.16;
    const target = centre(phi + look);
    let want = Math.atan2(target.y - c.y, target.x - c.x);
    let diff = want - c.angle;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    const steer = Math.max(-1, Math.min(1, diff * 2.4));
    // more skilled demons hold the gas deeper into corners (lift later); clumsier ones brake early
    const throttle = Math.abs(diff) > 0.42 + c.skill * 0.25 ? 0 : 1;
    return { throttle, steer, held: true };
  }

  // Advance one car by its input for dt seconds. Returns nothing; mutates c.
  function stepCar(c: Car, inp: NetInput, dt: number) {
    if (!c.alive || c.finished) { c.speed *= 0.9; return; }
    // steering scales with speed (no pivoting in place), arcade-style
    const grip = 0.35 + 0.65 * Math.min(1, c.speed / MAX_SPD);
    c.angle += inp.steer * TURN_RATE * grip * dt;
    // throttle / brake
    const cap = c.boosting > 0 ? BOOST_SPD : MAX_SPD;
    if (inp.throttle > 0) c.speed += ACCEL * dt;
    else if (inp.throttle < 0) c.speed -= BRAKE * dt;
    else c.speed -= FRICTION * dt; // coast down
    if (c.speed > cap) c.speed -= (c.speed - cap) * Math.min(1, dt * 3); // ease back to the cap
    if (c.speed < -REV_SPD) c.speed = -REV_SPD;
    if (c.boosting > 0) { c.boosting -= dt; c.speed += BOOST_ACCEL * dt; }

    // integrate
    let nx = c.x + Math.cos(c.angle) * c.speed * dt;
    let ny = c.y + Math.sin(c.angle) * c.speed * dt;

    // track interaction at the new position
    const g = ellipseG(nx, ny);
    const phi = Math.atan2(ny, nx);
    if (Math.abs(g - 1) > BAND) {
      // hit a guard rail: shove the point radially back onto the track edge (in g-space, which is
      // a uniform scale of the position), then bleed speed + energy.
      const edge = g > 1 ? 1 + BAND : 1 - BAND;
      const k = edge / g;
      nx *= k; ny *= k;
      c.speed *= WALL_SLOW;
      c.health -= WALL_DPS * dt;
      if (lastRailSfx <= 0) { crashSound(); lastRailSfx = 0.25; }
      if (c.slot === selfSlot) shake = Math.max(shake, 0.18);
    } else if (isBoost(phi)) {
      // boost strip: top up energy + light the afterburner
      c.health = Math.min(HEALTH_MAX, c.health + BOOST_HEAL * dt);
      c.boosting = Math.max(c.boosting, 0.25);
    }
    c.x = nx; c.y = ny;

    // lap / finish bookkeeping (forward crossings of phi=0, gated by reaching the far side)
    const ph = Math.atan2(c.y, c.x);
    if (Math.abs(ph) > 2.4) c.passedHalf = true;
    const crossedForward = c.prevPhi < 0 && ph >= 0 && c.prevPhi > -1 && ph < 1;
    if (crossedForward && c.passedHalf) {
      c.crossings++;
      c.passedHalf = false;
      if (c.crossings > LAPS) finishCar(c);
      else if (c.slot === selfSlot) blip(880, 0.12, 'square', 0.2);
    }
    c.prevPhi = ph;
    c.progress = c.crossings * 2 * Math.PI + ph;

    // out of energy → retire in a fireball
    if (c.health <= 0 && c.alive) retireCar(c);
  }
  let lastRailSfx = 0;

  function finishCar(c: Car) {
    if (c.finished) return;
    c.finished = true;
    finishOrder.push(c.slot);
    c.place = finishOrder.length;
    c.boosting = 0;
    if (c.place === 1) {
      winner = c.slot;
      // first across the line wins the Grand Prix — wrap it up
      resolveRace();
    }
  }

  function retireCar(c: Car) {
    c.alive = false;
    c.health = 0;
    c.speed = 0;
    crashSound();
    if (c.slot === selfSlot) shake = Math.max(shake, 0.6);
    explosions.push({ x: c.x, y: c.y, t: 0.7 });
    // last demon rolling wins by survival
    const live = cars.filter((k) => k.alive && !k.finished);
    if (live.length === 1 && !finishOrder.includes(live[0].slot) && winner < 0) {
      finishCar(live[0]);
    } else if (live.length === 0 && winner < 0) {
      resolveRace();
    }
  }

  function resolveRace() {
    if (phase === 'done') return;
    phase = 'done';
    // rank any unfinished survivors by progress, append to the finish order
    const ranked = cars
      .filter((c) => !finishOrder.includes(c.slot))
      .sort((a, b) => b.progress - a.progress);
    for (const c of ranked) { finishOrder.push(c.slot); c.place = finishOrder.length; }
    if (winner < 0 && finishOrder.length) winner = finishOrder[0];
    blip(660, 0.5, 'triangle', 0.3);
  }

  interface Explosion { x: number; y: number; t: number; }
  let explosions: Explosion[] = [];

  // ---------- update ----------
  function update(dt: number) {
    if (mode !== 'play') return;
    lastRailSfx = Math.max(0, lastRailSfx - dt);

    if (isHost) {
      hostUpdate(dt);
    } else {
      guestUpdate(dt);
    }

    // explosions tick on every client
    for (let i = explosions.length - 1; i >= 0; i--) { explosions[i].t -= dt; if (explosions[i].t <= 0) explosions.splice(i, 1); }
    if (shake > 0) shake -= dt;

    // local energy flash
    const hp = me()?.health ?? lastHurt;
    if (hp < lastHurt - 0.5) hurtFlash = 0.4;
    lastHurt = hp;
    if (hurtFlash > 0) hurtFlash -= dt;

    // engine pitch tracks our own speed
    if (engine) {
      const sp = Math.abs(me()?.speed ?? 0);
      engine.osc.frequency.value = 70 + sp * 3.2 + (me()?.boosting ? 60 : 0);
      engine.gain.gain.value = mode === 'play' && phase !== 'done' ? 0.06 + Math.min(0.12, sp / MAX_SPD * 0.12) : 0;
    }
  }
  let hurtFlash = 0;

  function readLocalInput(): NetInput {
    let throttle = 0, steer = 0;
    if (keys.has('w') || keys.has('arrowup')) throttle += 1;
    if (keys.has('s') || keys.has('arrowdown')) throttle -= 1;
    if (keys.has('a') || keys.has('arrowleft')) steer -= 1;
    if (keys.has('d') || keys.has('arrowright')) steer += 1;
    return { throttle, steer, held: throttle > 0 };
  }

  function hostUpdate(dt: number) {
    raceTime += dt;
    if (phase === 'countdown') {
      // Rocket-start (a hidden trick to discover): nail the gas only in the final ROCKET_WINDOW
      // before the lights drop and you launch off the line. Hold it the whole countdown and you
      // just roll off normally — so the secret is to feather it late, not mash it early. Track how
      // long each car has held the gas; bots commit at a slot-dependent moment so some nail it.
      for (const c of cars) {
        const held = c.slot === selfSlot ? readLocalInput().held
          : c.bot ? (countdown < 0.15 + c.slot * 0.12)
            : (guestInputs.get(c.slot)?.held ?? false);
        c.revHold = held ? (c.revHold ?? 0) + dt : 0;
      }
      countdown -= dt;
      if (countdown <= 0) {
        phase = 'race';
        blip(1040, 0.25, 'square', 0.3);
        for (const c of cars) {
          const rev = c.revHold ?? 0;
          if (rev > 0 && rev <= ROCKET_WINDOW) {
            c.boosting = 1.2; c.speed = 26; // perfect launch
            if (c.slot === selfSlot) blip(1500, 0.32, 'sawtooth', 0.32);
          }
        }
      }
    } else if (phase === 'race') {
      for (const c of cars) {
        const inp: NetInput =
          c.slot === selfSlot ? readLocalInput()
            : c.bot ? botInput(c)
              : (guestInputs.get(c.slot) ?? { throttle: 0, steer: 0, held: false });
        stepCar(c, inp, dt);
      }
    }
    if (phase === 'done' && !endReported) { endReported = true; net.end(winner); }

    // stream a world snapshot ~20/s
    netAccum += dt;
    if (netAccum >= 0.05) {
      netAccum = 0;
      net.relay({
        t: 'st', phase, countdown, raceTime, winner,
        order: finishOrder.slice(),
        cars: cars.map((c) => ({
          slot: c.slot, name: c.name, color: c.color, bot: c.bot,
          x: round2(c.x), y: round2(c.y), angle: round3(c.angle), speed: round2(c.speed),
          health: Math.round(c.health), laps: Math.min(c.crossings, LAPS + 1),
          progress: round3(c.progress), alive: c.alive, finished: c.finished, place: c.place,
          boosting: c.boosting > 0 ? 1 : 0,
        })),
        boom: explosions.map((e) => ({ x: round2(e.x), y: round2(e.y) })),
      });
    }
  }

  function guestUpdate(dt: number) {
    // send our input ~30/s; render from host snapshots (smoothed toward the latest).
    netAccum += dt;
    if (netAccum >= 0.033) {
      netAccum = 0;
      const inp = readLocalInput();
      net.relay({ t: 'in', slot: selfSlot, throttle: inp.throttle, steer: inp.steer, held: inp.held });
    }
    // smooth displayed positions toward the last snapshot targets
    const a = 1 - Math.exp(-dt * 14);
    for (const c of cars) {
      if (c.dx === undefined) continue;
      c.x += (c.dx - c.x) * a;
      c.y += (c.dy! - c.y) * a;
      let da = c.dAngle! - c.angle;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      c.angle += da * a;
    }
  }

  // ---------- rendering ----------
  // pack an RGB triple into a little-endian 0xAABBGGRR pixel, clamping each channel to 0..255 so a
  // bright accent (boost/rail) can never overflow and bleed into the neighbouring byte.
  function pack(r: number, g: number, b: number): number {
    const cr = r < 0 ? 0 : r > 255 ? 255 : r;
    const cg = g < 0 ? 0 : g > 255 ? 255 : g;
    const cb = b < 0 ? 0 : b > 255 ? 255 : b;
    return ((255 << 24) | (cb << 16) | (cg << 8) | cr) >>> 0;
  }

  function render() {
    if (mode !== 'play') { ctx.fillStyle = '#05060f'; ctx.fillRect(0, 0, W, H); return; }
    const viewer = me();
    if (!viewer) { ctx.fillStyle = '#05060f'; ctx.fillRect(0, 0, W, H); return; }

    // Camera target: normally our own car, but once we've retired/finished we spectate the leader
    // (the car furthest along) so we watch the rest of the race play out instead of a frozen wreck.
    const target = (viewer.alive && !viewer.finished)
      ? viewer
      : [...cars].sort((a, b) => b.progress - a.progress)[0] ?? viewer;

    // camera: behind and slightly above the target, looking along its heading
    const ca = target.angle;
    const dirX = Math.cos(ca), dirY = Math.sin(ca);
    const rightX = -dirY, rightY = dirX; // screen-right basis (matches the floor caster)
    const camX = target.x - dirX * CAM_BACK;
    const camY = target.y - dirY * CAM_BACK;
    const t = raceTime; // for animated boost chevrons

    // --- sky + stars ---
    for (let y = 0; y < HORIZON; y++) {
      const c = skyRow[y];
      const row = y * W;
      for (let x = 0; x < W; x++) buf[row + x] = c;
    }
    for (const s of stars) {
      // twinkle by camera heading so the sky feels like it moves a touch
      const sx = (s.x + Math.round(ca * 12)) % W;
      const px = ((sx % W) + W) % W;
      buf[s.y * W + px] = pack(s.b, s.b, Math.min(255, s.b + 40));
    }
    // a soft neon glow band on the horizon (rows HORIZON-2 .. HORIZON)
    const hz = pack(120, 40, 120);
    for (let x = 0; x < W; x++) {
      buf[HORIZON * W + x] = hz;
      buf[(HORIZON - 1) * W + x] = hz;
      if (HORIZON >= 2) buf[(HORIZON - 2) * W + x] = pack(70, 24, 80);
    }

    // --- floor cast (start one row below the horizon so depth = FOCAL·CAM_H/(y-HORIZON) is finite
    // and stays the exact inverse of the sprite projection) ---
    for (let y = HORIZON + 1; y < H; y++) {
      const p = y - HORIZON;
      const depth = (FOCAL * CAM_H) / p; // world depth of this scanline
      const fog = Math.min(1, depth / FAR_FOG);
      // leftmost/step world coords across the row
      const sLeft = (0 - W / 2) * depth / FOCAL;
      const sStep = depth / FOCAL;
      let wx = camX + dirX * depth + rightX * sLeft;
      let wy = camY + dirY * depth + rightY * sLeft;
      const dx = rightX * sStep, dy = rightY * sStep;
      const row = y * W;
      for (let x = 0; x < W; x++, wx += dx, wy += dy) {
        const g = ellipseG(wx, wy);
        let r: number, gr: number, b: number;
        if (Math.abs(g - 1) > BAND) {
          // off-track abyss: deep space, darker with depth (the ribbon floats above it)
          const dk = 1 - fog * 0.6;
          r = (10 * dk) | 0; gr = (8 * dk) | 0; b = (26 * dk) | 0;
          // faint grid of stars in the void for a sense of motion
          if (((wx * 0.6 | 0) + (wy * 0.6 | 0)) % 11 === 0) { r += 18; gr += 14; b += 30; }
        } else {
          const phi = Math.atan2(wy, wx);
          const edge = Math.abs(g - 1) / BAND; // 0 centre → 1 rail
          // base asphalt with a moving checker for speed read
          const checker = (((phi * 18) | 0) + ((g * 26) | 0)) & 1;
          let bv = checker ? 64 : 52;
          r = bv; gr = bv + 4; b = bv + 14;
          // centre lane dashes (dashed gold)
          if (edge < 0.07 && (((phi * 30) | 0) & 1)) { r = 210; gr = 180; b = 60; }
          // glowing guard rails near the edges
          if (edge > 0.82) {
            const railR = g > 1 ? 255 : 90, railG = g > 1 ? 80 : 200, railB = g > 1 ? 120 : 255;
            const k = (edge - 0.82) / 0.18;
            r = (r * (1 - k) + railR * k) | 0; gr = (gr * (1 - k) + railG * k) | 0; b = (b * (1 - k) + railB * k) | 0;
          }
          // boost strips: animated cyan chevrons pulling forward
          if (isBoost(phi)) {
            const chev = Math.sin(phi * 26 - t * 9) * 0.5 + 0.5;
            r = (r * 0.3 + 20) | 0;
            gr = (gr * 0.3 + 150 + chev * 90) | 0;
            b = (b * 0.3 + 200 + chev * 55) | 0;
          }
          // finish line: black/white checker band
          if (isFinish(phi)) {
            const fc = (((g * 22) | 0) & 1) ^ (((y) >> 1) & 1);
            const v = fc ? 240 : 20; r = v; gr = v; b = v;
          }
          // distance haze toward the horizon glow
          r = (r * (1 - fog) + 80 * fog) | 0;
          gr = (gr * (1 - fog) + 30 * fog) | 0;
          b = (b * (1 - fog) + 90 * fog) | 0;
        }
        buf[row + x] = pack(r, gr, b);
      }
    }
    ctx.putImageData(frame, 0, 0);

    // optional screen shake offset
    const shx = shake > 0 ? Math.round((Math.random() - 0.5) * 6 * shake) : 0;
    const shy = shake > 0 ? Math.round((Math.random() - 0.5) * 6 * shake) : 0;
    ctx.save();
    ctx.translate(shx, shy);

    // --- sprites: every car except ourselves, far→near; plus explosions ---
    const drawList: { depth: number; kind: 'car' | 'boom'; car?: Car; ex?: Explosion }[] = [];
    for (const c of cars) {
      if (c.slot === selfSlot) continue;
      const rel = projDepth(c.x, c.y, camX, camY, dirX, dirY);
      if (rel > NEAR) drawList.push({ depth: rel, kind: 'car', car: c });
    }
    for (const e of explosions) {
      const rel = projDepth(e.x, e.y, camX, camY, dirX, dirY);
      if (rel > NEAR) drawList.push({ depth: rel, kind: 'boom', ex: e });
    }
    drawList.sort((a, b) => b.depth - a.depth);
    for (const d of drawList) {
      if (d.kind === 'car') drawCar(d.car!, camX, camY, dirX, dirY, rightX, rightY);
      else drawBoom(d.ex!, camX, camY, dirX, dirY, rightX, rightY);
    }

    // our own car, fixed near the bottom-centre (a chunky 3/4 rear view)
    if (viewer.alive && !viewer.finished) drawSelfCar(viewer);

    ctx.restore();

    // red flash when we take damage
    if (hurtFlash > 0) {
      ctx.fillStyle = `rgba(255,40,40,${hurtFlash * 0.5})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function projDepth(ox: number, oy: number, cx: number, cy: number, dx: number, dy: number): number {
    return (ox - cx) * dx + (oy - cy) * dy;
  }

  // project a world point to screen; returns null if behind the camera
  function project(ox: number, oy: number, cx: number, cy: number, dx: number, dy: number, rx: number, ry: number) {
    const relx = ox - cx, rely = oy - cy;
    const depth = relx * dx + rely * dy;
    if (depth <= NEAR) return null;
    const side = relx * rx + rely * ry;
    return { sx: W / 2 + (FOCAL * side) / depth, sy: HORIZON + (FOCAL * CAM_H) / depth, depth };
  }

  function drawCar(c: Car, cx: number, cy: number, dx: number, dy: number, rx: number, ry: number) {
    const pr = project(c.x, c.y, cx, cy, dx, dy, rx, ry);
    if (!pr) return;
    const scale = FOCAL / pr.depth; // px per world unit
    const w = Math.max(3, scale * 3.4);
    const h = Math.max(2, scale * 2.0);
    // relative heading → fake a little 3/4 turn (which way they're pointing vs us)
    let rh = c.angle - Math.atan2(dy, dx);
    while (rh > Math.PI) rh -= 2 * Math.PI;
    while (rh < -Math.PI) rh += 2 * Math.PI;
    drawHovercar(pr.sx, pr.sy, w, h, c.color, rh, c.boosting > 0, !c.alive);
    // name tag if reasonably close
    if (pr.depth < 60 && c.alive) {
      ctx.font = '700 7px ui-monospace,monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#000'; ctx.fillText(c.name, pr.sx + 0.6, pr.sy - h - 2.4);
      ctx.fillStyle = c.color; ctx.fillText(c.name, pr.sx, pr.sy - h - 3);
    }
  }

  function drawSelfCar(c: Car) {
    const baseX = W / 2;
    const baseY = H - 8 + Math.sin(raceTime * 8) * 0.6; // gentle hover bob
    const inp = readLocalInput();
    drawHovercar(baseX + inp.steer * 2.5, baseY, 46, 24, c.color, inp.steer * 0.25, c.boosting > 0, false);
  }

  // A small F-Zero-ish hovercar billboard. rh ≈ relative heading for a faux 3/4 lean.
  function drawHovercar(sx: number, sy: number, w: number, h: number, color: string, rh: number, boost: boolean, dead: boolean) {
    const lean = Math.max(-1, Math.min(1, rh * 1.5));
    ctx.save();
    ctx.translate(sx, sy);
    // thruster glow / boost flame under the car
    if (!dead) {
      const fl = boost ? 1 : 0.4;
      const grad = ctx.createRadialGradient(0, -h * 0.1, 1, 0, -h * 0.1, w * 0.7);
      grad.addColorStop(0, boost ? 'rgba(120,220,255,0.9)' : 'rgba(120,160,255,0.5)');
      grad.addColorStop(1, 'rgba(40,80,200,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.ellipse(0, -h * 0.05, w * 0.6, h * 0.45 * fl, 0, 0, Math.PI * 2); ctx.fill();
    }
    if (dead) ctx.globalAlpha = 0.5;
    // body: a trapezoid (wider at the rear) with a cockpit canopy
    const skew = lean * w * 0.18;
    ctx.fillStyle = dead ? '#444' : color;
    ctx.beginPath();
    ctx.moveTo(-w * 0.5, -h * 0.05);
    ctx.lineTo(w * 0.5, -h * 0.05);
    ctx.lineTo(w * 0.32 + skew, -h * 0.95);
    ctx.lineTo(-w * 0.32 + skew, -h * 0.95);
    ctx.closePath(); ctx.fill();
    // side fins
    ctx.fillStyle = dead ? '#333' : shade(color, -0.35);
    ctx.fillRect(-w * 0.5, -h * 0.35, w * 0.14, h * 0.3);
    ctx.fillRect(w * 0.36, -h * 0.35, w * 0.14, h * 0.3);
    // cockpit
    ctx.fillStyle = dead ? '#222' : 'rgba(20,30,50,0.9)';
    ctx.beginPath();
    ctx.moveTo(-w * 0.2 + skew, -h * 0.5);
    ctx.lineTo(w * 0.2 + skew, -h * 0.5);
    ctx.lineTo(w * 0.12 + skew, -h * 0.9);
    ctx.lineTo(-w * 0.12 + skew, -h * 0.9);
    ctx.closePath(); ctx.fill();
    // a highlight strip
    ctx.fillStyle = dead ? '#555' : shade(color, 0.4);
    ctx.fillRect(-w * 0.5, -h * 0.12, w, Math.max(1, h * 0.08));
    ctx.restore();
  }

  function drawBoom(e: Explosion, cx: number, cy: number, dx: number, dy: number, rx: number, ry: number) {
    const pr = project(e.x, e.y, cx, cy, dx, dy, rx, ry);
    if (!pr) return;
    const k = 1 - e.t / 0.7;
    const r = (FOCAL / pr.depth) * (1 + k * 3);
    ctx.save();
    ctx.globalAlpha = Math.max(0, e.t / 0.7);
    const grad = ctx.createRadialGradient(pr.sx, pr.sy - r * 0.4, 1, pr.sx, pr.sy - r * 0.4, r);
    grad.addColorStop(0, '#fff');
    grad.addColorStop(0.4, '#ffd23b');
    grad.addColorStop(0.8, '#ff4d2d');
    grad.addColorStop(1, 'rgba(120,20,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(pr.sx, pr.sy - r * 0.4, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // ---------- HUD ----------
  function syncHud() {
    if (mode !== 'play') { menu.style.display = 'flex'; hud.textContent = ''; posBadge.textContent = ''; energyWrap.style.display = 'none'; energyLabel.style.display = 'none'; return; }
    menu.style.display = 'none';
    const c = me();
    energyWrap.style.display = ''; energyLabel.style.display = '';

    if (phase === 'countdown') {
      const n = Math.ceil(countdown);
      banner.style.display = 'flex';
      banner.style.color = n <= 1 ? '#5dff8f' : '#ffd23b';
      banner.textContent = countdown <= 0 ? 'GO!' : String(Math.min(3, n));
    } else if (phase === 'done') {
      banner.style.display = 'flex';
      const myPlace = c?.place ?? 0;
      const won = winner === selfSlot;
      banner.style.color = won ? '#ffd23b' : myPlace === 0 ? '#ff5c5c' : '#cdd7f5';
      const ord = finishOrder.map((slot, i) => {
        const car = cars.find((k) => k.slot === slot);
        const medal = ['🥇', '🥈', '🥉', '4️⃣'][i] ?? `${i + 1}.`;
        return `${medal} ${car ? car.name : '?'}`;
      }).join('\n');
      banner.style.fontSize = '24px';
      banner.textContent = (won ? '🏆 GRAND PRIX WINNER 🏆' : myPlace ? `FINISHED P${myPlace}` : '💀 RETIRED') + '\n\n' + ord + '\n\nESC to exit';
    } else {
      banner.style.display = 'none';
      banner.style.fontSize = '64px';
    }

    if (c) {
      const lap = Math.min(LAPS, Math.max(1, c.crossings ?? 1));
      // rank by progress
      const rank = [...cars].sort((a, b) => (b.finished ? 1e9 + (LAPS + 5 - b.place) : b.progress) - (a.finished ? 1e9 + (LAPS + 5 - a.place) : a.progress));
      const pos = rank.findIndex((k) => k.slot === selfSlot) + 1;
      hud.innerHTML = `LAP ${lap}/${LAPS}<br><span style="font-size:13px;color:#9fd8ff">${Math.round(Math.abs(c.speed) * 4)} KM/H</span>`;
      posBadge.innerHTML = `P${pos}<span style="font-size:14px;color:#9fb0d8">/${cars.length}</span>`;
      const hpFrac = Math.max(0, c.health) / HEALTH_MAX;
      energyFill.style.width = (hpFrac * 100) + '%';
      energyFill.style.background = hpFrac < 0.3
        ? 'linear-gradient(90deg,#ff3b3b,#ff8a3b)'
        : 'linear-gradient(90deg,#19d2ff,#5dff8f)';
    }
  }

  // ---------- mode transitions ----------
  function beginRace() {
    mode = 'play';
    isHost = selfSlot === 0;
    phase = 'countdown';
    countdown = COUNTDOWN;
    raceTime = 0;
    winner = -1;
    finishOrder = [];
    endReported = false;
    explosions = [];
    guestInputs.clear();
    netAccum = 0;
    hurtFlash = 0;
    if (isHost) {
      buildGrid();
    } else {
      // guests get a placeholder grid; the first snapshot fills in real positions
      buildGrid();
      for (const c of cars) { c.dx = c.x; c.dy = c.y; c.dAngle = c.angle; }
    }
    lastHurt = HEALTH_MAX;
    startEngine();
    menu.style.display = 'none';
    // try to grab pointer-free focus for keys
    canvas.focus?.();
  }

  joinBtn.onclick = () => { mode = 'lobby'; menuMsg.textContent = 'Joining the grid…'; net.join(); ac().resume?.(); };
  startBtn.onclick = () => { if (selfSlot === 0) net.start(); };
  leaveBtn.onclick = () => { net.leave(); lobbyState = null; mode = 'menu'; syncMenuButtons(); };
  exitBtn.onclick = () => close();

  // ---------- incoming server messages ----------
  handlers = {
    lobby: (m) => {
      lobbyState = m;
      selfSlot = m.slot;
      if (m.status === 'ended') {
        mode = 'menu'; lobbyState = null;
        menuMsg.textContent = 'The host pulled out — race cancelled.';
        return;
      }
      if (m.status === 'playing' && mode !== 'play') beginRace();
      else if (m.status === 'waiting' && mode === 'lobby') { renderRoster(); syncMenuButtons(); }
    },
    relay: (d) => {
      const msg = d as { t?: string } & Record<string, unknown>;
      if (mode !== 'play') return;
      if (isHost && msg.t === 'in') {
        const slot = Number(msg.slot);
        if (Number.isFinite(slot) && slot !== selfSlot) {
          guestInputs.set(slot, {
            throttle: Number(msg.throttle) || 0,
            steer: Number(msg.steer) || 0,
            held: !!msg.held,
          });
        }
      } else if (!isHost && msg.t === 'st') {
        const st = msg as unknown as {
          phase: 'countdown' | 'race' | 'done'; countdown: number; raceTime: number; winner: number;
          order: number[];
          cars: Array<Car & { laps: number; boosting: number }>;
          boom: { x: number; y: number }[];
        };
        phase = st.phase; countdown = st.countdown; raceTime = st.raceTime; winner = st.winner;
        finishOrder = st.order ?? [];
        // merge snapshot into our smoothed car list
        const bySlot = new Map(cars.map((c) => [c.slot, c] as [number, Car]));
        cars = st.cars.map((nc) => {
          const ex = bySlot.get(nc.slot);
          const c: Car = ex ?? {
            slot: nc.slot, name: nc.name, color: nc.color, bot: nc.bot,
            x: nc.x, y: nc.y, angle: nc.angle, speed: nc.speed, health: nc.health,
            crossings: nc.laps, passedHalf: false, prevPhi: 0, progress: nc.progress,
            alive: nc.alive, finished: nc.finished, place: nc.place, boosting: nc.boosting, skill: 1,
          };
          // immediate fields
          c.name = nc.name; c.color = nc.color; c.bot = nc.bot;
          c.speed = nc.speed; c.health = nc.health; c.crossings = nc.laps; c.progress = nc.progress;
          c.alive = nc.alive; c.finished = nc.finished; c.place = nc.place; c.boosting = nc.boosting;
          // smoothed targets
          c.dx = nc.x; c.dy = nc.y; c.dAngle = nc.angle;
          if (!ex) { c.x = nc.x; c.y = nc.y; c.angle = nc.angle; }
          return c;
        });
        explosions = (st.boom ?? []).map((b) => ({ x: b.x, y: b.y, t: 0.6 }));
      }
    },
  };

  // ---------- input ----------
  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (k === 'escape') { close(); return; }
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd', ' '].includes(k)) {
      e.preventDefault(); e.stopImmediatePropagation();
    }
    keys.add(k);
  };
  const onKeyUp = (e: KeyboardEvent) => { keys.delete(e.key.toLowerCase()); e.stopImmediatePropagation(); };
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);

  // ---------- loop + teardown ----------
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
  syncMenuButtons();

  function close() {
    if (!srOpen) return;
    srOpen = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    if (mode === 'lobby' || mode === 'play') net.leave();
    handlers = null;
    try { engine?.osc.stop(); } catch { /* ignore */ }
    audio?.close().catch(() => {});
    overlay.remove();
  }
}

// --- small helpers (module scope) ---
function round2(n: number): number { return Math.round(n * 100) / 100; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }
// lighten (>0) or darken (<0) a #rrggbb colour
function shade(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const adj = (v: number) => Math.max(0, Math.min(255, Math.round(v + amt * 255)));
  const r = adj(parseInt(m[1], 16)), g = adj(parseInt(m[2], 16)), b = adj(parseInt(m[3], 16));
  return `rgb(${r},${g},${b})`;
}
