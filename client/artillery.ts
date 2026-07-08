// Tsong Artillery — a Worms-style turn-based artillery battle (1–4 players, bots fill empty
// seats), launched from the Arcade menu. Like Tron it is deliberately isolated: its own
// fullscreen overlay, canvas, input handlers and loop, all torn down on exit.
//
// Netcode rides the same dumb broadcast relay (server wa* methods), but because the game is
// TURN-BASED the sim is replay-deterministic instead of streamed: the host sends a terrain
// SEED at start, every client generates the identical battlefield, and each shot travels as
// a single tiny message ({t:'shot', angle, power, ...}) that every client simulates with the
// exact same fixed-timestep code — craters, damage, knockback and deaths all match without
// streaming any of it. The host stays authoritative for turn order, the shot clock, bots,
// and broadcasts an hp/position {t:'sync'} after each shot as a drift safety-net.
//
// Controls: A/D walk · mouse aims · hold SPACE to charge, release to fire · 1-4 weapons.

import { WA_W, WA_H, WA_TURN_MS, WA_HP, WA_MAX_PLAYERS } from '../shared/types';

export interface ArtilleryNet {
  join(): void;
  leave(): void;
  start(): void;
  end(winner: number): void; // (host only) winning LOBBY slot (-1 = a bot won → no payout)
  relay(data: unknown): void;
  name(): string;
}

interface WaLobby {
  status: 'waiting' | 'playing' | 'ended';
  slot: number;
  hostSlot: number;
  players: { name: string; slot: number }[];
}

let handlers: { lobby: (m: WaLobby) => void; relay: (d: unknown) => void } | null = null;
export function feedWaLobby(m: WaLobby) { handlers?.lobby(m); }
export function feedWaRelay(d: unknown) { handlers?.relay(d); }

// --- constants ---
const COLORS = ['#00e5ff', '#ff9a00', '#ff3df0', '#89ff2a'] as const;
// The cast enlists. Kevin Jr. is a pothos with seventeen leaves and a grudge.
const BOT_NAMES = ['KEVIN JR.', 'DOUG', 'DANA'] as const;

// --- battlefield maps (host picks; the generator theme + profile per map) ---
interface WaMap { name: string; desc: string; grass: string; dirtTop: string; dirtDeep: string; }
const MAPS: WaMap[] = [
  { name: 'THE HILLS', desc: 'classic rolling countryside', grass: '#3f7a3a', dirtTop: '#3d2a14', dirtDeep: '#180e05' },
  { name: 'THE RUINS', desc: 'stepped stone + ancient pillars', grass: '#5a7a5a', dirtTop: '#4a4a55', dirtDeep: '#1a1a22' },
  { name: 'FOUNTAIN VALLEY', desc: 'one deep basin, no cover in the middle', grass: '#4a8a5a', dirtTop: '#2a3a24', dirtDeep: '#0e1408' },
  { name: 'THE ARENA', desc: 'two mesas, one fatal chasm', grass: '#7a6a3a', dirtTop: '#4a3520', dirtDeep: '#1c1208' },
];
const GRAV = 640;            // px/s² for projectiles and fighters
const WALK_SPEED = 95;       // px/s
const STEP_UP = 14;          // max ledge a fighter can walk up
const FALL_SAFE = 220;       // free-fall px before damage starts
const WATER_BASE = WA_H - 26;   // starting waterline (rises in sudden death)
const SUDDEN_DEATH_TURN = 14;   // after this many turns the water starts climbing
const WATER_RISE = 34;          // px per turn once sudden death begins
const SUBDT = 1 / 120;       // fixed physics timestep — KEEP IDENTICAL EVERYWHERE (determinism)
interface Weapon { name: string; icon: string; wind: boolean; bounce: boolean; fuseMs: number; radius: number; dmg: number; hitscan: boolean; ammo: number; }
const WEAPONS: Weapon[] = [
  { name: 'BAZOOKA', icon: '🚀', wind: true, bounce: false, fuseMs: 0, radius: 62, dmg: 48, hitscan: false, ammo: -1 },
  { name: 'GRENADE', icon: '💣', wind: false, bounce: true, fuseMs: 3000, radius: 55, dmg: 42, hitscan: false, ammo: -1 },
  { name: 'SHOTGUN', icon: '🔫', wind: false, bounce: false, fuseMs: 0, radius: 18, dmg: 28, hitscan: true, ammo: -1 },
  { name: 'DYNAMITE', icon: '🧨', wind: false, bounce: false, fuseMs: 3500, radius: 85, dmg: 75, hitscan: false, ammo: 2 },
];

// deterministic PRNG for terrain generation (both sides run it with the host's seed)
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let waOpen = false;

export function startArtillery(net: ArtilleryNet): void {
  if (waOpen) return;
  waOpen = true;

  type Mode = 'menu' | 'lobby' | 'play' | 'ended';
  let mode: Mode = 'menu';
  let selfSlot = 0;
  let isHost = false;
  let lobbyState: WaLobby | null = null;
  let botCount = 1;
  let mapChoice = 0; // host's battlefield pick (index into MAPS)

  // --- battlefield state (identical on every client) ---
  interface Fighter {
    name: string; color: string; bot: boolean; lobbySlot: number;
    x: number; y: number; vy: number; face: number; // face: 1 right, -1 left
    hp: number; alive: boolean; dyna: number;       // dynamite ammo
    fallFrom: number;                                // y where the current fall began
  }
  let fighters: Fighter[] = [];
  let solid = new Uint8Array(WA_W * WA_H);
  let terrain: HTMLCanvasElement | null = null;      // pre-rendered dirt, carved as we go
  let turnPi = -1;                                   // whose turn (fighter index)
  let turnCount = 0;                                 // total turns elapsed (drives sudden death — deterministic)
  let waterY = WATER_BASE;                           // current waterline
  let wind = 0;                                      // -1..1, bazooka drift
  let turnEndsAt = 0;                                // shot clock (local clock, display + host enforce)
  let resolving = false;                             // a shot is in flight — inputs locked
  let matchWinner = -2;                              // -2 = live, -1 = draw/bot, >=0 fighter idx
  let banner = ''; let bannerUntil = 0;
  let charge = -1;                                   // -1 idle, else 0..1 while SPACE held
  let weapon = 0;
  let aimAngle = -Math.PI / 4;                       // set from the mouse each frame
  let endReported = false;
  let botThinkAt = 0;                                // host: when the current bot fires

  // in-flight projectile (cosmetic mirror of the deterministic sim, for drawing)
  interface Shell { x: number; y: number; trail: [number, number][]; icon: string; }
  let shell: Shell | null = null;
  interface Spark { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; }
  let sparks: Spark[] = [];
  let shakeUntil = 0, shakeAmp = 0;
  interface Floaty { x: number; y: number; text: string; color: string; life: number; }
  let floaties: Floaty[] = [];                       // "-34" damage numbers drifting up
  let graves: { x: number; y: number }[] = [];       // 🪦 where fighters fell
  let quip = ''; let quipUntil = 0;                  // battlefield commentary
  const say = (text: string) => { quip = text; quipUntil = performance.now() + 3400; };
  const QUIPS = {
    bigHit: ['DEVASTATING.', 'That one\'s going in the highlight reel.', 'Someone screenshot that.', 'Zara calls that "high-impact brand engagement."', 'Finn logged that under "pleasant surprises."'],
    selfHit: ['Friendly fire! With yourself!', 'Bold strategy.', 'The enemy within.', 'Chad says self-sabotage is still reps. Bro.'],
    drown: ['Gone swimming. Permanently.', 'The water always wins.', 'Blub blub.', 'The fountain claims another.', 'Should have equipped the boat.'],
    miss: ['The dirt felt that one.', 'Warning shot. Probably.', 'The wind sends its regards.', 'Terraforming, technically.', 'Noodle says the crater is "expressive."'],
    kevin: ['Kevin Jr. felt that. Energetically.', 'Kevin Jr. has dropped a leaf in protest.', 'All seventeen leaves... still. Forever still.'],
    doug: ['Doug was a lot. Now he\'s a little bit everywhere.', 'Doug finally made his dentist appointment. In heaven.'],
    dana: ['Dana benched more than that blast. Unrelated. Probably.', 'Somewhere a squat rack falls silent.'],
    lore: [
      'The Dorito man watches from beyond the hills. He approves.',
      'Somewhere out there, Waldo is hiding from this war.',
      'Mira is spectating. She says she already knows how this ends.',
      'The fountain\'s six splash patterns predicted this conflict.',
      'Bex added this war to the document. New tab: WARS.',
      'Finn is counting the craters. Forty-seven. He\'s thrilled.',
      'Chad says explosions are just loud gains.',
      'Biscotti & Things was lost in a war like this one. Never forget the Things.',
      'Thaddeus the creak heard the first shot. Punctual as ever.',
      'This violence is rated E for ELO.',
      'The Ruins have seen worse. Barely.',
      'Somewhere in the Tavern, someone just bet coins on this.',
    ],
  };
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

  // --- tiny synth (no assets): fire thump, explosion boom, charge whine, splash ---
  let ac: AudioContext | null = null;
  const audioCtx = () => (ac ??= new (window.AudioContext || (window as any).webkitAudioContext)());
  function sfxFire() {
    try {
      const a = audioCtx(), t = a.currentTime;
      const o = a.createOscillator(), g = a.createGain();
      o.type = 'square'; o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(50, t + 0.18);
      g.gain.setValueAtTime(0.16, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      o.connect(g).connect(a.destination); o.start(t); o.stop(t + 0.22);
    } catch { /* no audio — fine */ }
  }
  function sfxBoom(big: number) {
    try {
      const a = audioCtx(), t = a.currentTime;
      const len = 0.5 + big * 0.3;
      const buf = a.createBuffer(1, a.sampleRate * len, a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
      const src = a.createBufferSource(); src.buffer = buf;
      const f = a.createBiquadFilter(); f.type = 'lowpass';
      f.frequency.setValueAtTime(900 + big * 400, t); f.frequency.exponentialRampToValueAtTime(80, t + len);
      const g = a.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
      src.connect(f).connect(g).connect(a.destination); src.start(t);
    } catch { /* no audio — fine */ }
  }
  function sfxSplash() {
    try {
      const a = audioCtx(), t = a.currentTime;
      const buf = a.createBuffer(1, a.sampleRate * 0.35, a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) * 0.5;
      const src = a.createBufferSource(); src.buffer = buf;
      const f = a.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1400;
      const g = a.createGain(); g.gain.setValueAtTime(0.3, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      src.connect(f).connect(g).connect(a.destination); src.start(t);
    } catch { /* no audio — fine */ }
  }

  const sIdx = (x: number, y: number) => (y | 0) * WA_W + (x | 0);
  const isSolid = (x: number, y: number) =>
    x >= 0 && x < WA_W && y >= 0 && y < WA_H && solid[sIdx(x, y)] === 1;

  // --- terrain generation (seeded + map profile, deterministic on every client) ---
  function genTerrain(seed: number, map: number) {
    const theme = MAPS[map] ?? MAPS[0];
    const rnd = mulberry32(seed);
    const phases = [rnd() * 9, rnd() * 9, rnd() * 9];
    const freqs = [0.0021 + rnd() * 0.001, 0.0058 + rnd() * 0.002, 0.013 + rnd() * 0.004];
    const amps = [170 + rnd() * 90, 70 + rnd() * 40, 22 + rnd() * 14];
    const base = WA_H * (0.58 + rnd() * 0.08);
    const hmap = new Float64Array(WA_W);
    for (let x = 0; x < WA_W; x++) {
      let h = base
        + Math.sin(x * freqs[0] + phases[0]) * amps[0]
        + Math.sin(x * freqs[1] + phases[1]) * amps[1]
        + Math.sin(x * freqs[2] + phases[2]) * amps[2];
      if (map === 1) {
        // THE RUINS: quantize into stone terraces
        h = Math.round(h / 85) * 85;
      } else if (map === 2) {
        // FOUNTAIN VALLEY: one deep central basin, high rims
        const g = Math.exp(-Math.pow((x - WA_W / 2) / (WA_W * 0.21), 2));
        h = WA_H * 0.42 + g * WA_H * 0.34 + Math.sin(x * freqs[2] + phases[2]) * 18;
      } else if (map === 3) {
        // THE ARENA: two flat mesas facing off across a fatal chasm
        const gap = Math.abs(x - WA_W / 2) < 150;
        h = gap ? WA_H + 80 : WA_H * 0.52 + Math.sin(x * freqs[2] + phases[2]) * 12;
        // ramp the mesa edges so the chasm walls aren't perfectly sheer
        const edge = Math.abs(x - WA_W / 2);
        if (!gap && edge < 260) h += (260 - edge) * 0.9;
      }
      hmap[x] = h;
    }
    solid = new Uint8Array(WA_W * WA_H);
    for (let x = 0; x < WA_W; x++) {
      const top = Math.max(60, Math.min(WA_H + 120, hmap[x]));
      for (let y = Math.min(WA_H - 1, top) | 0; y < WA_H; y++) {
        if (top < WA_H) solid[y * WA_W + x] = 1;
      }
    }
    // THE RUINS: ancient pillars to snipe from (and blow up)
    if (map === 1) {
      const nP = 3 + Math.floor(rnd() * 3);
      for (let p = 0; p < nP; p++) {
        const px = 160 + Math.floor(rnd() * (WA_W - 320));
        const pw = 34 + Math.floor(rnd() * 30);
        const groundY = Math.max(60, Math.min(WA_H - 60, hmap[px]));
        const top = groundY - 150 - Math.floor(rnd() * 140);
        for (let x = px; x < px + pw && x < WA_W; x++) {
          for (let y = Math.max(60, top); y < WA_H; y++) solid[y * WA_W + x] = 1;
        }
      }
    }
    // pre-render the dirt from the FINAL solid bitmap (pillars included)
    terrain = document.createElement('canvas');
    terrain.width = WA_W; terrain.height = WA_H;
    const tc = terrain.getContext('2d')!;
    const dirt = tc.createLinearGradient(0, WA_H * 0.35, 0, WA_H);
    dirt.addColorStop(0, theme.dirtTop);
    dirt.addColorStop(1, theme.dirtDeep);
    // paint each column as contiguous solid runs (grass lip on every run top)
    for (let x = 0; x < WA_W; x++) {
      let y = 0;
      while (y < WA_H) {
        while (y < WA_H && !solid[y * WA_W + x]) y++;
        if (y >= WA_H) break;
        const runTop = y;
        while (y < WA_H && solid[y * WA_W + x]) y++;
        tc.fillStyle = dirt;
        tc.fillRect(x, runTop, 1, y - runTop);
        tc.fillStyle = theme.grass;
        tc.fillRect(x, runTop, 1, Math.min(6, y - runTop));
      }
    }
    return hmap;
  }

  function surfaceY(x: number): number {
    for (let y = 0; y < WA_H; y++) if (isSolid(x, y)) return y;
    return WA_H;
  }

  function carve(cx: number, cy: number, r: number) {
    const x0 = Math.max(0, cx - r | 0), x1 = Math.min(WA_W - 1, cx + r | 0);
    const y0 = Math.max(0, cy - r | 0), y1 = Math.min(WA_H - 1, cy + r | 0);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r * r) solid[y * WA_W + x] = 0;
      }
    }
    if (terrain) {
      const tc = terrain.getContext('2d')!;
      tc.save();
      tc.globalCompositeOperation = 'destination-out';
      tc.beginPath();
      tc.arc(cx, cy, r, 0, Math.PI * 2);
      tc.fill();
      tc.restore();
      // scorched rim
      tc.save();
      tc.globalCompositeOperation = 'source-atop';
      tc.strokeStyle = '#0e0803';
      tc.lineWidth = 5;
      tc.beginPath();
      tc.arc(cx, cy, r - 2, 0, Math.PI * 2);
      tc.stroke();
      tc.restore();
    }
  }

  // --- deterministic shot resolution (every client runs this identically) -----------------
  // Returns after fully resolving: projectile flight, explosion, damage, knockback, settling.
  // Visuals (shell trail, sparks, shake) are fed as it goes via the cosmetic hooks.
  function killFighter(f: Fighter, drowned: boolean) {
    f.hp = 0;
    f.alive = false;
    if (drowned) { sfxSplash(); say(pick(QUIPS.drown)); }
    else graves.push({ x: f.x, y: f.y });
    if (f.name === 'KEVIN JR.') say(pick(QUIPS.kevin));
    else if (f.name === 'DOUG') say(pick(QUIPS.doug));
    else if (f.name === 'DANA') say(pick(QUIPS.dana));
    floaties.push({ x: f.x, y: f.y - 40, text: drowned ? '🌊' : '💀', color: '#fff', life: 0 });
  }

  function settleFighter(f: Fighter) {
    // fall until landing (used inside the deterministic resolution — fixed steps)
    let guard = 0;
    while (f.alive && guard++ < 100000) {
      if (f.y >= waterY) { killFighter(f, true); return; }
      if (isSolid(f.x, f.y + 1)) break;
      f.vy += GRAV * SUBDT;
      f.y += f.vy * SUBDT;
    }
    if (f.alive) {
      const fall = f.y - f.fallFrom;
      if (fall > FALL_SAFE) {
        const dmg = Math.round((fall - FALL_SAFE) * 0.18);
        f.hp = Math.max(0, f.hp - dmg);
        if (dmg > 2) floaties.push({ x: f.x, y: f.y - 34, text: `-${dmg}`, color: '#ffd060', life: 0 });
      }
      if (f.hp <= 0) killFighter(f, false);
      else { f.vy = 0; f.fallFrom = f.y; }
    }
  }

  function explode(cx: number, cy: number, w: Weapon) {
    carve(cx, cy, w.radius);
    let anyHit = false, bigHit = false, hitSelf = false;
    for (const f of fighters) {
      if (!f.alive) continue;
      const d = Math.hypot(f.x - cx, (f.y - 9) - cy);
      const reach = w.radius * 1.35;
      if (d < reach) {
        const dmg = Math.round(w.dmg * (1 - d / reach));
        f.hp = Math.max(0, f.hp - dmg);
        anyHit = anyHit || dmg > 4;
        bigHit = bigHit || dmg >= 40;
        if (fighters[turnPi] === f && dmg > 4) hitSelf = true;
        if (dmg > 0) floaties.push({ x: f.x, y: f.y - 34, text: `-${dmg}`, color: dmg >= 35 ? '#ff5a3a' : '#ffd060', life: 0 });
        // knockback away from the blast
        const ang = Math.atan2((f.y - 9) - cy, f.x - cx);
        const kick = 260 * (1 - d / reach);
        f.x += Math.cos(ang) * kick * 0.05;
        f.vy = Math.min(f.vy, Math.sin(ang) * kick - 120);
        f.fallFrom = Math.min(f.fallFrom, f.y);
        if (f.hp <= 0) killFighter(f, false);
      }
    }
    for (const f of fighters) if (f.alive) settleFighter(f);
    // cosmetic
    boom(cx, cy, w.radius);
    sfxBoom(w.radius / 85);
    if (hitSelf) say(pick(QUIPS.selfHit));
    else if (bigHit) say(pick(QUIPS.bigHit));
    else if (!anyHit) say(pick(QUIPS.miss));
  }

  function resolveShot(pi: number, w: number, sx: number, sy: number, ang: number, pow: number) {
    resolving = true;
    sfxFire();
    const wp = WEAPONS[w];
    const shooter = fighters[pi];
    if (shooter) { shooter.x = sx; shooter.y = sy; }
    if (wp.hitscan) {
      // instant ray to the first solid pixel or fighter within 750px
      let hx = sx, hy = sy - 12;
      for (let d = 8; d < 750; d += 2) {
        const x = sx + Math.cos(ang) * d, y = sy - 12 + Math.sin(ang) * d;
        hx = x; hy = y;
        if (isSolid(x, y)) break;
        const victim = fighters.find((f) => f.alive && f !== shooter && Math.abs(f.x - x) < 12 && Math.abs(f.y - 9 - y) < 12);
        if (victim) break;
      }
      explode(hx, hy, wp);
      finishShot();
      return;
    }
    if (w === 3) {
      // dynamite: dropped at the feet, big fuse — resolve as a delayed blast in place
      if (shooter) shooter.dyna--;
      animateFuse(sx + (shooter?.face ?? 1) * 14, sy - 4, wp, 0, 0);
      return;
    }
    // ballistic: fixed-timestep flight (deterministic)
    const speed = 380 + pow * 720;
    animateFlight(sx + Math.cos(ang) * 16, sy - 12 + Math.sin(ang) * 16, Math.cos(ang) * speed, Math.sin(ang) * speed, wp);
  }

  // Ballistic flight, animated over real frames but STEPPED deterministically: the physics
  // advance in fixed SUBDT increments regardless of frame rate, so every client computes the
  // identical impact point; frames only decide how often we repaint along the way.
  let flight: { x: number; y: number; vx: number; vy: number; wp: Weapon; fuse: number; steps: number } | null = null;
  function animateFlight(x: number, y: number, vx: number, vy: number, wp: Weapon) {
    flight = { x, y, vx, vy, wp, fuse: wp.fuseMs / 1000, steps: 0 };
    shell = { x, y, trail: [], icon: wp.icon };
  }
  function animateFuse(x: number, y: number, wp: Weapon, vx: number, vy: number) {
    flight = { x, y, vx, vy, wp, fuse: wp.fuseMs / 1000, steps: 0 };
    shell = { x, y, trail: [], icon: wp.icon };
  }
  function stepFlight(frames: number) {
    if (!flight) return;
    const fl = flight;
    // advance a bounded number of fixed steps per frame (keeps sim identical everywhere)
    for (let i = 0; i < frames && flight; i++) {
      fl.steps++;
      if (fl.steps > 12 * 120) { // 12s hard cap — lost shells fizzle
        flight = null; shell = null; finishShot(); return;
      }
      if (fl.wp.wind) fl.vx += wind * 52 * SUBDT;
      fl.vy += GRAV * SUBDT;
      fl.x += fl.vx * SUBDT;
      fl.y += fl.vy * SUBDT;
      if (fl.fuse > 0) {
        fl.fuse -= SUBDT;
        if (fl.fuse <= 0) { const { x, y, wp } = fl; flight = null; shell = null; explode(x, y, wp); finishShot(); return; }
      }
      if (fl.y > waterY + 6) { // plunk — the water keeps it
        sfxSplash();
        for (let sp = 0; sp < 10; sp++) sparks.push({ x: fl.x, y: waterY + 4, vx: (Math.random() - 0.5) * 160, vy: -120 - Math.random() * 160, life: 0, max: 0.5, color: '#7fd0ff' });
        say(pick(QUIPS.drown));
        flight = null; shell = null; finishShot(); return;
      }
      if (fl.x < -80 || fl.x > WA_W + 80 || fl.y > WA_H + 40) { flight = null; shell = null; finishShot(); return; }
      if (isSolid(fl.x, fl.y)) {
        if (fl.wp.bounce || fl.wp.fuseMs > 0) {
          // back out and reflect (grenade/dynamite bounce until the fuse blows)
          while (isSolid(fl.x, fl.y)) { fl.x -= fl.vx * SUBDT; fl.y -= fl.vy * SUBDT; }
          if (Math.abs(fl.vy) > Math.abs(fl.vx)) fl.vy = -fl.vy * 0.45; else fl.vx = -fl.vx * 0.45;
          fl.vx *= 0.75;
        } else {
          const { x, y, wp } = fl; flight = null; shell = null; explode(x, y, wp); finishShot(); return;
        }
      }
      const victim = fighters.find((f) => f.alive && f !== fighters[turnPi] && Math.abs(f.x - fl.x) < 13 && Math.abs(f.y - 9 - fl.y) < 13);
      if (victim && !fl.wp.bounce && fl.wp.fuseMs === 0) {
        const { x, y, wp } = fl; flight = null; shell = null; explode(x, y, wp); finishShot(); return;
      }
    }
    if (flight && shell) { shell.x = flight.x; shell.y = flight.y; shell.trail.push([flight.x, flight.y]); if (shell.trail.length > 40) shell.trail.shift(); }
  }

  function finishShot() {
    resolving = false;
    if (isHost) {
      // safety-net sync + advance the turn
      net.relay({ t: 'sync', hp: fighters.map((f) => f.hp), px: fighters.map((f) => Math.round(f.x)), py: fighters.map((f) => Math.round(f.y)), alive: fighters.map((f) => f.alive ? 1 : 0) });
      window.setTimeout(() => { if (waOpen && mode === 'play') hostNextTurn(); }, 1600);
    }
  }

  // --- host: turn management + bots ---
  function hostStartMatch() {
    const humans = lobbyState?.players ?? [];
    const seed = (Math.random() * 0xffffffff) >>> 0;
    fighters = humans.map((p) => ({
      name: p.name, color: COLORS[p.slot], bot: false, lobbySlot: p.slot,
      x: 0, y: 0, vy: 0, face: 1, hp: WA_HP, alive: true, dyna: WEAPONS[3].ammo, fallFrom: 0,
    }));
    for (let i = 0; i < botCount && fighters.length < WA_MAX_PLAYERS; i++) {
      fighters.push({
        name: BOT_NAMES[i], color: COLORS[fighters.length], bot: true, lobbySlot: -1,
        x: 0, y: 0, vy: 0, face: 1, hp: WA_HP, alive: true, dyna: WEAPONS[3].ammo, fallFrom: 0,
      });
    }
    genTerrain(seed, mapChoice);
    placeFighters();
    net.relay({ t: 'init', seed, map: mapChoice, fighters: fighters.map((f) => ({ name: f.name, bot: f.bot, lobbySlot: f.lobbySlot })) });
    mode = 'play';
    endReported = false;
    matchWinner = -2;
    turnCount = 0;
    waterY = WATER_BASE;
    graves = [];
    renderUi();
    banner = `⚔️ ${MAPS[mapChoice].name}`;
    bannerUntil = performance.now() + 2200;
    turnPi = -1;
    window.setTimeout(() => { if (waOpen && mode === 'play') hostNextTurn(); }, 1600);
  }

  function placeFighters() {
    // spread across the map on solid, above-water ground (same order everywhere — deterministic;
    // the outward scan matters on THE ARENA, whose center is a bottomless chasm)
    const n = fighters.length;
    fighters.forEach((f, i) => {
      let x = Math.round(WA_W * (i + 1) / (n + 1) + (i % 2 ? 60 : -60));
      for (let probe = 0; probe < WA_W / 2; probe += 12) {
        const cand = [x + probe, x - probe].find((c) => c > 20 && c < WA_W - 20 && surfaceY(c) < waterY - 30);
        if (cand !== undefined) { x = cand; break; }
      }
      f.x = x;
      f.y = surfaceY(x) - 1;
      f.fallFrom = f.y;
      f.face = f.x > WA_W / 2 ? -1 : 1;
    });
  }

  function hostNextTurn() {
    const alive = fighters.filter((f) => f.alive);
    if (alive.length <= 1) {
      const winIdx = alive.length === 1 ? fighters.indexOf(alive[0]) : -1;
      matchWinner = winIdx;
      banner = winIdx >= 0 ? `${fighters[winIdx].name} WINS THE WAR` : 'MUTUAL DESTRUCTION';
      bannerUntil = performance.now() + 5200;
      net.relay({ t: 'end', winner: winIdx });
      if (!endReported) { endReported = true; net.end(winIdx >= 0 ? fighters[winIdx].lobbySlot : -1); }
      window.setTimeout(() => { if (waOpen) backToLobby(); }, 4800);
      return;
    }
    do { turnPi = (turnPi + 1) % fighters.length; } while (!fighters[turnPi].alive);
    wind = Math.round((Math.random() * 2 - 1) * 100) / 100;
    turnEndsAt = performance.now() + WA_TURN_MS;
    net.relay({ t: 'turn', pi: turnPi, wind });
    applyTurnLocal();
    if (fighters[turnPi].bot) botThinkAt = performance.now() + 1500 + Math.random() * 900;
  }

  function applyTurnLocal() {
    turnEndsAt = performance.now() + WA_TURN_MS;
    charge = -1;
    weapon = 0;
    turnCount++;
    // sudden death: the water climbs every turn past the threshold (deterministic — every
    // client counts the same 'turn' messages, so every client computes the same waterline)
    const over = turnCount - SUDDEN_DEATH_TURN;
    const newWater = WATER_BASE - Math.max(0, over) * WATER_RISE;
    if (newWater !== waterY) {
      waterY = newWater;
      if (over === 1) { banner = '🌊 SUDDEN DEATH — THE WATER RISES'; bannerUntil = performance.now() + 2600; }
      for (const f of fighters) if (f.alive && f.y >= waterY) killFighter(f, true);
    }
    if (!(banner === '🌊 SUDDEN DEATH — THE WATER RISES' && performance.now() < bannerUntil)) {
      banner = `${fighters[turnPi].name}'S TURN`;
      bannerUntil = performance.now() + 1400;
    }
    // ambient lore from the announcer's booth
    if (Math.random() < 0.28 && performance.now() > quipUntil) say(pick(QUIPS.lore));
  }

  // Bot brain: trajectory search — simulate bazooka arcs across angle × power, pick the
  // combo landing closest to the target (plus difficulty noise), then fire the real thing.
  function botFire() {
    const me = fighters[turnPi];
    const targets = fighters.filter((f) => f.alive && f !== me);
    if (!targets.length) return;
    const target = targets.reduce((a, b) => Math.hypot(a.x - me.x, a.y - me.y) < Math.hypot(b.x - me.x, b.y - me.y) ? a : b);
    let best = { ang: -Math.PI / 4, pow: 0.6, err: 1e9 };
    for (let deg = 15; deg <= 165; deg += 4) {
      for (let pow = 0.25; pow <= 1.001; pow += 0.09) {
        const ang = -deg * Math.PI / 180; // aim upward arcs
        const speed = 380 + pow * 720;
        let x = me.x, y = me.y - 12, vx = Math.cos(ang) * speed, vy = Math.sin(ang) * speed;
        // mirror horizontally toward the target side
        if (Math.sign(Math.cos(ang)) !== Math.sign(target.x - me.x)) vx = -vx;
        let err = 1e9;
        for (let s = 0; s < 6 * 120; s++) {
          vx += wind * 52 * SUBDT;
          vy += GRAV * SUBDT;
          x += vx * SUBDT; y += vy * SUBDT;
          if (x < 0 || x > WA_W || y > WA_H) break;
          if (isSolid(x, y)) { err = Math.hypot(x - target.x, y - target.y); break; }
        }
        if (err < best.err) best = { ang: Math.atan2(Math.sin(ang), Math.sign(target.x - me.x) * Math.abs(Math.cos(ang))), pow, err };
      }
    }
    // aim error keeps bots beatable (30-80px depending on which bot)
    const noise = (30 + fighters.indexOf(me) * 18) * (Math.random() - 0.5) / 200;
    if (Math.random() < 0.4) {
      say(me.name === 'KEVIN JR.' ? 'Kevin Jr. photosynthesizes pure aggression.'
        : me.name === 'DOUG' ? 'Doug would like to say: you\'re a lot.'
        : 'Dana calls this "just another set."');
    }
    const shot = { t: 'shot', pi: turnPi, w: 0, x: Math.round(me.x), y: Math.round(me.y), ang: best.ang + noise, pow: best.pow };
    net.relay(shot);
    resolveShot(turnPi, 0, me.x, me.y, shot.ang, shot.pow);
  }

  // --- cosmetic helpers ---
  function boom(x: number, y: number, r: number) {
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * Math.PI * 2, sp = 80 + Math.random() * 420;
      sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 140, life: 0, max: 0.5 + Math.random() * 0.7, color: ['#ff9a3a', '#ffd060', '#ff5a3a', '#fff'][i % 4] });
    }
    shakeUntil = performance.now() + 380;
    shakeAmp = Math.min(22, r * 0.28);
  }

  function backToLobby() {
    mode = 'lobby';
    matchWinner = -2;
    flight = null; shell = null;
    resolving = false;
    renderUi();
  }

  // --- DOM overlay ---
  const overlay = document.createElement('div');
  overlay.id = 'waOverlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:#060a14;display:flex;align-items:center;' +
    'justify-content:center;flex-direction:column;font-family:ui-monospace,monospace;';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;height:min(90vh,50.6vw);aspect-ratio:16/9;';
  const canvas = document.createElement('canvas');
  canvas.width = WA_W; canvas.height = WA_H;
  canvas.style.cssText =
    'width:100%;height:100%;background:#000;border:2px solid #7a5a2a66;border-radius:6px;' +
    'box-shadow:0 0 60px #ffb84722, inset 0 0 120px #0008;';
  const ctx = canvas.getContext('2d')!;
  wrap.appendChild(canvas);
  overlay.appendChild(wrap);

  const ui = document.createElement('div');
  ui.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'flex-direction:column;gap:14px;color:#f0e0c8;text-align:center;';
  overlay.appendChild(ui);

  const btn = (label: string, color: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText =
      `cursor:pointer;font:inherit;font-size:16px;font-weight:800;letter-spacing:2px;padding:12px 34px;` +
      `background:#140f06;color:${color};border:2px solid ${color};border-radius:8px;text-transform:uppercase;`;
    b.onmouseenter = () => { b.style.background = '#241a0a'; };
    b.onmouseleave = () => { b.style.background = '#140f06'; };
    b.onclick = onClick;
    return b;
  };

  function renderUi() {
    ui.replaceChildren();
    ui.style.display = mode === 'play' ? 'none' : 'flex';
    if (mode === 'menu') {
      const title = document.createElement('div');
      title.innerHTML =
        '<div style="font-size:58px;font-weight:900;letter-spacing:8px;color:#ffb847;text-shadow:0 0 30px #ffb84766">🪖 TSONG ARTILLERY</div>' +
        '<div style="font-size:13px;opacity:.7;margin-top:6px;letter-spacing:2px">TURN-BASED MAYHEM · DESTRUCTIBLE EVERYTHING · LAST ONE STANDING</div>';
      ui.appendChild(title);
      ui.appendChild(btn('Enlist', '#ffb847', () => net.join()));
      ui.appendChild(btn('Exit', '#8aa', close));
    } else if (mode === 'lobby') {
      const humans = lobbyState?.players ?? [];
      const maxBots = Math.max(0, WA_MAX_PLAYERS - humans.length);
      if (botCount > maxBots) botCount = maxBots;
      const minBots = humans.length >= 2 ? 0 : 1;
      if (botCount < minBots) botCount = minBots;
      const roster = document.createElement('div');
      roster.style.cssText = 'font-size:15px;line-height:2;min-width:340px;';
      roster.innerHTML =
        '<div style="font-size:22px;font-weight:900;letter-spacing:6px;color:#ffb847;margin-bottom:8px">THE TRENCHES</div>' +
        humans.map((p) =>
          `<div style="color:${COLORS[p.slot]}">🪖 ${p.name}${p.slot === 0 ? ' <span style="opacity:.6">(host)</span>' : ''}${p.slot === selfSlot ? ' <span style="opacity:.6">(you)</span>' : ''}</div>`,
        ).join('') +
        Array.from({ length: isHost ? botCount : 0 }, (_, i) =>
          `<div style="color:${COLORS[humans.length + i]};opacity:.75">🤖 ${BOT_NAMES[i]} <span style="opacity:.6">(bot)</span></div>`,
        ).join('');
      ui.appendChild(roster);
      if (isHost) {
        const botRow = document.createElement('div');
        botRow.style.cssText = 'display:flex;gap:12px;align-items:center;font-size:15px;';
        const minus = btn('−', '#ff9a00', () => { botCount = Math.max(minBots, botCount - 1); renderUi(); });
        const plus = btn('+', '#ff9a00', () => { botCount = Math.min(maxBots, botCount + 1); renderUi(); });
        for (const b of [minus, plus]) { b.style.padding = '4px 14px'; b.style.fontSize = '18px'; }
        const label = document.createElement('span');
        label.textContent = `Bots: ${botCount}`;
        botRow.append(minus, label, plus);
        ui.appendChild(botRow);
        // battlefield picker
        const mapRow = document.createElement('div');
        mapRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center;max-width:640px;';
        MAPS.forEach((m, i) => {
          const b = btn(m.name, mapChoice === i ? '#ffb847' : '#556', () => { mapChoice = i; renderUi(); });
          b.style.fontSize = '12px'; b.style.padding = '7px 14px';
          b.title = m.desc;
          if (mapChoice === i) b.style.background = '#241a0a';
          mapRow.appendChild(b);
        });
        ui.appendChild(mapRow);
        const mapDesc = document.createElement('div');
        mapDesc.style.cssText = 'font-size:11.5px;opacity:.6;margin-top:-6px;';
        mapDesc.textContent = MAPS[mapChoice].desc;
        ui.appendChild(mapDesc);
        const canStart = humans.length + botCount >= 2;
        const start = btn('Open Fire', '#89ff2a', () => { if (canStart) net.start(); });
        if (!canStart) { start.style.opacity = '0.4'; start.style.cursor = 'default'; }
        ui.appendChild(start);
      } else {
        const wait = document.createElement('div');
        wait.style.cssText = 'font-size:13px;opacity:.7;';
        wait.textContent = 'waiting for the host to sound the horn...';
        ui.appendChild(wait);
      }
      const legend = document.createElement('div');
      legend.style.cssText =
        'font-size:12.5px;line-height:1.9;text-align:left;background:#140f06cc;border:1px solid #4a3a1a;' +
        'border-radius:10px;padding:12px 18px;';
      legend.innerHTML =
        '<div style="font-size:11px;letter-spacing:3px;color:#a08a5a;margin-bottom:4px">FIELD MANUAL</div>' +
        'A / D — walk · MOUSE — aim · HOLD SPACE — charge, release to FIRE<br>' +
        '1 🚀 Bazooka (rides the wind) · 2 💣 Grenade (bounces, 3s fuse)<br>' +
        '3 🔫 Shotgun (point blank) · 4 🧨 Dynamite (drop &amp; RUN — ×2 per war)<br>' +
        'Fall damage is real. The water is fatal. The wind is not your friend.';
      ui.appendChild(legend);
      ui.appendChild(btn('Desert', '#8aa', () => { net.leave(); mode = 'menu'; renderUi(); }));
    } else if (mode === 'ended') {
      const msg = document.createElement('div');
      msg.style.cssText = 'font-size:20px;color:#ff9a00;';
      msg.textContent = 'The host deserted — war\'s over.';
      ui.appendChild(msg);
      ui.appendChild(btn('Back', '#8aa', () => { mode = 'menu'; renderUi(); }));
    }
  }

  // --- guest message handling ---
  function guestApply(d: any) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'init') {
      fighters = (d.fighters as any[]).map((f: any, i: number) => ({
        name: String(f.name), color: COLORS[i], bot: !!f.bot, lobbySlot: f.lobbySlot ?? -1,
        x: 0, y: 0, vy: 0, face: 1, hp: WA_HP, alive: true, dyna: WEAPONS[3].ammo, fallFrom: 0,
      }));
      turnCount = 0;
      waterY = WATER_BASE;
      graves = [];
      genTerrain(d.seed >>> 0, d.map | 0);
      placeFighters();
      matchWinner = -2;
      banner = `⚔️ ${MAPS[d.map | 0]?.name ?? ''}`;
      bannerUntil = performance.now() + 2200;
      if (mode !== 'play') { mode = 'play'; renderUi(); }
    } else if (d.t === 'turn') {
      turnPi = d.pi;
      wind = d.wind;
      applyTurnLocal();
    } else if (d.t === 'pos') {
      const f = fighters[d.pi];
      if (f && d.pi !== myIdx()) { f.x = d.x; f.y = d.y; f.face = d.face; f.fallFrom = f.y; }
    } else if (d.t === 'shot') {
      if (d.pi !== myIdx()) resolveShot(d.pi, d.w, d.x, d.y, d.ang, d.pow);
      if (isHost && fighters[d.pi] && !fighters[d.pi].bot) { /* host re-simulates guests' shots via the same path */ }
    } else if (d.t === 'drown') {
      const f = fighters[d.pi];
      if (f && f.alive) killFighter(f, true);
      if (isHost && d.pi === turnPi) {
        window.setTimeout(() => { if (waOpen && mode === 'play' && !resolving) hostNextTurn(); }, 1200);
      }
    } else if (d.t === 'sync') {
      (d.hp as number[]).forEach((hp, i) => {
        const f = fighters[i];
        if (!f) return;
        f.hp = hp; f.alive = d.alive[i] === 1;
        f.x = d.px[i]; f.y = d.py[i]; f.fallFrom = f.y;
      });
    } else if (d.t === 'end') {
      matchWinner = d.winner;
      banner = d.winner >= 0 ? `${fighters[d.winner]?.name ?? '?'} WINS THE WAR` : 'MUTUAL DESTRUCTION';
      bannerUntil = performance.now() + 5200;
      window.setTimeout(() => { if (waOpen) backToLobby(); }, 4800);
    }
  }

  // --- input ---
  const myIdx = () => fighters.findIndex((f) => f.lobbySlot === selfSlot);
  const myTurn = () => mode === 'play' && !resolving && turnPi >= 0 && turnPi === myIdx() && fighters[turnPi]?.alive && matchWinner === -2;
  const keys = new Set<string>();
  let mouseX = WA_W / 2, mouseY = 0;
  let lastPosSend = 0;

  function fire() {
    if (!myTurn() || charge < 0) return;
    const me = fighters[myIdx()];
    if (weapon === 3 && me.dyna <= 0) { charge = -1; return; }
    const shot = { t: 'shot', pi: myIdx(), w: weapon, x: Math.round(me.x), y: Math.round(me.y), ang: aimAngle, pow: Math.min(1, charge) };
    charge = -1;
    net.relay(shot);
    resolveShot(shot.pi, shot.w, me.x, me.y, shot.ang, shot.pow);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (mode !== 'play') return;
    const k = e.key.toLowerCase();
    if (['a', 'd', ' '].includes(k)) { e.preventDefault(); e.stopPropagation(); }
    if (k === ' ' && myTurn() && charge < 0 && !e.repeat) charge = 0;
    if (['1', '2', '3', '4'].includes(k) && myTurn()) weapon = Number(k) - 1;
    keys.add(k);
  }
  function onKeyUp(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    if (k === ' ' && charge >= 0) fire();
    keys.delete(k);
  }
  function onMouseMove(e: MouseEvent) {
    const r = canvas.getBoundingClientRect();
    mouseX = (e.clientX - r.left) / r.width * WA_W;
    mouseY = (e.clientY - r.top) / r.height * WA_H;
  }
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  overlay.addEventListener('mousemove', onMouseMove);

  // --- per-frame update (local movement, bot trigger, shot clock) ---
  function update(dt: number, now: number) {
    if (mode !== 'play') return;
    stepFlight(Math.max(1, Math.round(dt / SUBDT)));
    if (charge >= 0) {
      charge += dt / 1.6;
      if (charge >= 1) { charge = 1; fire(); } // max charge auto-fires, Worms-style
    }
    // walking (acting player only, real-time within the turn)
    if (myTurn()) {
      const me = fighters[myIdx()];
      const ax = (keys.has('a') ? -1 : 0) + (keys.has('d') ? 1 : 0);
      if (ax !== 0 && charge < 0) {
        me.face = ax;
        const nx = me.x + ax * WALK_SPEED * dt;
        if (nx > 8 && nx < WA_W - 8) {
          // climb small ledges, refuse walls
          let ny = me.y;
          let blocked = false;
          for (let up = 0; up <= STEP_UP; up++) {
            if (!isSolid(nx, me.y - up)) { ny = me.y - up; blocked = false; break; }
            blocked = true;
          }
          if (!blocked) {
            me.x = nx; me.y = ny;
            while (!isSolid(me.x, me.y + 1) && me.y < waterY) me.y++; // hug gentle downslopes
            if (me.y >= waterY) {
              // walked into the drink — everyone needs to know, then the turn moves on
              killFighter(me, true);
              net.relay({ t: 'drown', pi: myIdx() });
              if (isHost) window.setTimeout(() => { if (waOpen && mode === 'play' && !resolving) hostNextTurn(); }, 1200);
              return;
            }
            me.fallFrom = me.y;
          }
        }
        if (now - lastPosSend > 80) {
          lastPosSend = now;
          net.relay({ t: 'pos', pi: myIdx(), x: Math.round(me.x), y: Math.round(me.y), face: me.face });
        }
      }
      aimAngle = Math.atan2(mouseY - (me.y - 12), mouseX - me.x);
    }
    // host duties: bot turns + shot clock
    if (isHost && matchWinner === -2 && !resolving && turnPi >= 0) {
      if (fighters[turnPi].bot && now >= botThinkAt) { botThinkAt = Infinity; botFire(); }
      else if (!fighters[turnPi].bot && now > turnEndsAt) { hostNextTurn(); } // shot clock expired
    }
    // sparks
    for (const s of sparks) { s.life += dt; s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 700 * dt; }
    sparks = sparks.filter((s) => s.life < s.max);
  }

  // --- rendering ---
  function render(now: number) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // dusk sky
    const sky = ctx.createLinearGradient(0, 0, 0, WA_H);
    sky.addColorStop(0, '#0a1230');
    sky.addColorStop(0.55, '#23304f');
    sky.addColorStop(1, '#4a3a52');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, WA_W, WA_H);
    // stars
    ctx.fillStyle = '#e8e0d8';
    for (let i = 0; i < 40; i++) {
      const x = (i * 379) % WA_W, y = (i * 173) % (WA_H * 0.35);
      ctx.globalAlpha = 0.2 + 0.3 * Math.abs(Math.sin(now / 1100 + i));
      ctx.fillRect(x, y, 2, 2);
    }
    ctx.globalAlpha = 1;
    // distant mountain silhouettes (two parallax bands)
    for (const [tone, amp, base, speed] of [['#141c38', 210, 0.52, 0], ['#1c2644', 150, 0.62, 0]] as const) {
      ctx.fillStyle = tone;
      ctx.beginPath();
      ctx.moveTo(0, WA_H);
      for (let x = 0; x <= WA_W; x += 32) {
        ctx.lineTo(x, WA_H * base - Math.abs(Math.sin(x * 0.004 + speed) * amp + Math.sin(x * 0.011) * amp * 0.3));
      }
      ctx.lineTo(WA_W, WA_H);
      ctx.fill();
    }
    // drifting clouds
    ctx.fillStyle = '#ffffff14';
    for (let i = 0; i < 4; i++) {
      const cx = ((now / (90 - i * 12) + i * 600) % (WA_W + 400)) - 200;
      const cy = 90 + i * 70;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 130 + i * 22, 26 + i * 5, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + 70, cy + 8, 90, 20, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (mode !== 'play') return;

    // screen shake
    if (now < shakeUntil) {
      const a = shakeAmp * (shakeUntil - now) / 380;
      ctx.setTransform(1, 0, 0, 1, (Math.random() - 0.5) * a, (Math.random() - 0.5) * a);
    }

    // terrain
    if (terrain) ctx.drawImage(terrain, 0, 0);

    // gravestones where soldiers fell
    ctx.font = '22px serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    for (const g of graves) ctx.fillText('🪦', g.x, Math.min(g.y, waterY) + 2);

    // fighters
    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i];
      if (!f.alive) continue;
      const active = i === turnPi && matchWinner === -2;
      const bob = active ? Math.sin(now / 300) * 1.5 : 0;
      const fy = f.y + bob;
      // body
      ctx.fillStyle = '#e8c8a0';
      ctx.beginPath();
      ctx.ellipse(f.x, fy - 9, 9, 11, 0, 0, Math.PI * 2);
      ctx.fill();
      // color helmet (dome + rim) — the whole uniform
      ctx.fillStyle = f.color;
      ctx.beginPath();
      ctx.arc(f.x, fy - 14, 9.5, Math.PI, 0);
      ctx.fill();
      ctx.fillRect(f.x - 11, fy - 15, 22, 3.4);
      // eyes: blink every few seconds (they're at war, they're stressed)
      const blink = Math.sin(now / 900 + i * 2.1) > 0.96;
      ctx.fillStyle = '#000';
      if (!blink) {
        ctx.fillRect(f.x + f.face * 2 - 1.4, fy - 11, 2.8, 3.2);
        ctx.fillRect(f.x + f.face * 6 - 1.4, fy - 11, 2.8, 3.2);
      } else {
        ctx.fillRect(f.x + f.face * 2 - 1.4, fy - 9.6, 2.8, 1);
        ctx.fillRect(f.x + f.face * 6 - 1.4, fy - 9.6, 2.8, 1);
      }
      // the acting fighter shoulders a bazooka tube aimed along their aim (locals see live angle)
      if (active) {
        const ang = i === myIdx() ? aimAngle : (f.face > 0 ? -0.5 : Math.PI + 0.5);
        ctx.save();
        ctx.translate(f.x, fy - 12);
        ctx.rotate(ang);
        ctx.fillStyle = '#2a2a30';
        ctx.fillRect(2, -3, 22, 6);
        ctx.fillStyle = '#4a4a55';
        ctx.fillRect(18, -4, 7, 8);
        ctx.restore();
        ctx.strokeStyle = f.color;
        ctx.globalAlpha = 0.5 + 0.3 * Math.sin(now / 200);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(f.x, fy - 9, 17, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // name + hp
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.font = '700 13px ui-monospace, monospace';
      ctx.fillStyle = f.color;
      ctx.fillText(f.name, f.x, fy - 34);
      ctx.fillStyle = '#0008';
      ctx.fillRect(f.x - 20, fy - 32, 40, 5);
      ctx.fillStyle = f.hp > 50 ? '#7fe089' : f.hp > 25 ? '#ffd060' : '#ff5a5a';
      ctx.fillRect(f.x - 20, fy - 32, 40 * f.hp / WA_HP, 5);
    }

    // aiming UI for the acting local player
    if (myTurn()) {
      const me = fighters[myIdx()];
      const wp = WEAPONS[weapon];
      if (!wp.hitscan && weapon !== 3) {
        // trajectory preview — brighter with charge, tinted red near max
        const pow = charge >= 0 ? charge : 0.55;
        const speed = 380 + pow * 720;
        let x = me.x + Math.cos(aimAngle) * 16, y = me.y - 12 + Math.sin(aimAngle) * 16;
        let vx = Math.cos(aimAngle) * speed, vy = Math.sin(aimAngle) * speed;
        for (let s = 0; s < 60; s++) {
          if (wp.wind) vx += wind * 52 * (1 / 60);
          vy += GRAV * (1 / 60);
          x += vx * (1 / 60); y += vy * (1 / 60);
          if (isSolid(x, y) || y > WA_H) break;
          if (s % 4 === 0) {
            ctx.globalAlpha = Math.max(0.15, 1 - s / 55);
            ctx.fillStyle = charge > 0.85 ? '#ff8a5a' : '#ffffff';
            ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
          }
        }
        ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = '#ffffff66';
        ctx.setLineDash([6, 8]);
        ctx.beginPath();
        ctx.moveTo(me.x, me.y - 12);
        ctx.lineTo(me.x + Math.cos(aimAngle) * 160, me.y - 12 + Math.sin(aimAngle) * 160);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // crosshair at the mouse
      ctx.strokeStyle = '#ffd060';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(mouseX, mouseY, 11, 0, Math.PI * 2);
      ctx.moveTo(mouseX - 16, mouseY); ctx.lineTo(mouseX - 6, mouseY);
      ctx.moveTo(mouseX + 6, mouseY); ctx.lineTo(mouseX + 16, mouseY);
      ctx.moveTo(mouseX, mouseY - 16); ctx.lineTo(mouseX, mouseY - 6);
      ctx.moveTo(mouseX, mouseY + 6); ctx.lineTo(mouseX, mouseY + 16);
      ctx.stroke();
      // power bar under the fighter
      if (charge >= 0) {
        ctx.fillStyle = '#000a';
        ctx.fillRect(me.x - 30, me.y + 12, 60, 10);
        ctx.fillStyle = charge > 0.85 ? '#ff5a3a' : '#ffd060';
        ctx.fillRect(me.x - 28, me.y + 14, 56 * charge, 6);
        for (let t = 1; t < 4; t++) { ctx.fillStyle = '#0008'; ctx.fillRect(me.x - 28 + 14 * t, me.y + 13, 1, 8); }
      }
    }

    // in-flight shell + fuse countdown
    if (shell) {
      ctx.strokeStyle = '#ffffff44';
      ctx.lineWidth = 2;
      ctx.beginPath();
      shell.trail.forEach(([x, y], i) => { if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.stroke();
      ctx.font = '22px serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(shell.icon, shell.x, shell.y);
      if (flight && flight.wp.fuseMs > 0) {
        const s = Math.max(0, flight.fuse);
        ctx.font = '800 17px ui-monospace, monospace';
        ctx.fillStyle = s < 1 ? '#ff5a3a' : '#ffd060';
        ctx.fillText(s.toFixed(1), shell.x, shell.y - 24);
      }
    }
    // sparks
    for (const s of sparks) {
      const t = 1 - s.life / s.max;
      ctx.globalAlpha = t;
      ctx.fillStyle = s.color;
      const sz = 2 + t * 4;
      ctx.fillRect(s.x - sz / 2, s.y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
    // damage floaties
    for (const fl of floaties) {
      fl.life += 1 / 60;
      const t = fl.life / 1.2;
      if (t >= 1) continue;
      ctx.globalAlpha = 1 - t * t;
      ctx.font = '900 22px ui-monospace, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = fl.color;
      ctx.fillText(fl.text, fl.x, fl.y - t * 46);
    }
    floaties = floaties.filter((fl) => fl.life < 1.2);
    ctx.globalAlpha = 1;

    // water on top (things sink INTO it) — reddens as sudden death squeezes the map
    const sudden = turnCount > SUDDEN_DEATH_TURN;
    ctx.fillStyle = sudden ? '#4a2038dd' : '#1a3a5add';
    ctx.beginPath();
    ctx.moveTo(0, WA_H);
    for (let x = 0; x <= WA_W; x += 24) ctx.lineTo(x, waterY + 8 + Math.sin(now / 500 + x / 90) * (sudden ? 7 : 4));
    ctx.lineTo(WA_W, WA_H);
    ctx.fill();
    ctx.strokeStyle = sudden ? '#ff5a8a66' : '#5a9ada55';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= WA_W; x += 24) {
      const y = waterY + 8 + Math.sin(now / 500 + x / 90) * (sudden ? 7 : 4);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // --- HUD ---
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // segmented wind meter
    const segs = 5;
    const segW = 22;
    const cxm = WA_W / 2;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.font = '700 12px ui-monospace, monospace';
    ctx.fillStyle = '#a08a5a';
    ctx.fillText('W I N D', cxm, 8);
    for (let s = 0; s < segs; s++) {
      const lit = wind < 0 && Math.abs(wind) * segs > s;
      ctx.fillStyle = lit ? '#7fd0ff' : '#ffffff18';
      ctx.fillRect(cxm - 30 - (s + 1) * segW, 24, segW - 3, 10);
      const litR = wind > 0 && wind * segs > s;
      ctx.fillStyle = litR ? '#7fd0ff' : '#ffffff18';
      ctx.fillRect(cxm + 30 + s * segW, 24, segW - 3, 10);
    }
    ctx.fillStyle = '#f0e0c8';
    ctx.font = '800 14px ui-monospace, monospace';
    ctx.fillText(wind > 0 ? '→' : wind < 0 ? '←' : '·', cxm, 22);
    // turn + clock
    if (turnPi >= 0 && matchWinner === -2) {
      const left = Math.max(0, Math.ceil((turnEndsAt - now) / 1000));
      ctx.fillStyle = left <= 5 ? '#ff5a5a' : '#a08a5a';
      ctx.font = '800 16px ui-monospace, monospace';
      ctx.fillText(`${fighters[turnPi]?.name ?? ''} · ${left}s`, cxm, 44);
      if (sudden) {
        ctx.fillStyle = '#ff5a8a';
        ctx.font = '700 12px ui-monospace, monospace';
        ctx.fillText('🌊 SUDDEN DEATH — THE WATER RISES', cxm, 66);
      }
    }
    // weapon chips (acting local player)
    if (myTurn()) {
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      let wx = 18;
      for (let w = 0; w < WEAPONS.length; w++) {
        const wp = WEAPONS[w];
        const ammo = w === 3 ? `×${fighters[myIdx()].dyna}` : '';
        const label = `${w + 1} ${wp.icon} ${wp.name}${ammo}`;
        ctx.font = '800 15px ui-monospace, monospace';
        const tw = ctx.measureText(label).width + 18;
        const sel = w === weapon;
        const dead = w === 3 && fighters[myIdx()].dyna <= 0;
        ctx.fillStyle = sel ? '#241a0acc' : '#00000088';
        ctx.fillRect(wx, 12, tw, 28);
        if (sel) { ctx.strokeStyle = '#ffd060'; ctx.lineWidth = 2; ctx.strokeRect(wx, 12, tw, 28); }
        ctx.fillStyle = dead ? '#665' : sel ? '#ffd060' : '#a08a5a';
        ctx.fillText(label, wx + 9, 18);
        wx += tw + 8;
      }
    }
    // battlefield commentary
    if (quip && now < quipUntil) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.font = 'italic 700 17px ui-monospace, monospace';
      ctx.fillStyle = '#ffd060cc';
      ctx.fillText(`“${quip}”`, WA_W / 2, WA_H - 14);
    }
    // banner (chromatic)
    if (banner && now < bannerUntil) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '900 54px ui-monospace, monospace';
      const col = matchWinner >= 0 ? fighters[matchWinner]?.color ?? '#ffd060' : '#ffd060';
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ff3df0';
      ctx.fillText(banner, WA_W / 2 - 3, WA_H * 0.3);
      ctx.fillStyle = '#00e5ff';
      ctx.fillText(banner, WA_W / 2 + 3, WA_H * 0.3);
      ctx.globalAlpha = 1;
      ctx.fillStyle = col;
      ctx.shadowColor = col; ctx.shadowBlur = 28;
      ctx.fillText(banner, WA_W / 2, WA_H * 0.3);
      ctx.shadowBlur = 0;
      // victory confetti
      if (matchWinner >= 0 && Math.random() < 0.4) {
        sparks.push({
          x: Math.random() * WA_W, y: -10,
          vx: (Math.random() - 0.5) * 60, vy: 120 + Math.random() * 120,
          life: 0, max: 2.2, color: [fighters[matchWinner]?.color ?? '#ffd060', '#fff', '#ffd060'][Math.floor(Math.random() * 3)],
        });
      }
    }
  }

  // --- main loop ---
  let raf = 0;
  let last = performance.now();
  function loop(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt, now);
    render(now);
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  // --- server feed handlers ---
  handlers = {
    lobby: (m) => {
      lobbyState = m;
      selfSlot = m.slot;
      isHost = m.slot === m.hostSlot;
      if (m.status === 'ended') { mode = 'ended'; renderUi(); return; }
      if (m.status === 'playing') {
        if (mode !== 'play' && isHost) hostStartMatch();
        return; // guests flip to play when {t:'init'} lands
      }
      if (mode === 'menu' || mode === 'lobby') { mode = 'lobby'; renderUi(); }
    },
    relay: (d) => {
      // the host also resolves guests' shots/positions through the same handler
      guestApply(d);
    },
  };

  function close() {
    if (!waOpen) return;
    waOpen = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    if (mode === 'lobby' || mode === 'play') net.leave();
    handlers = null;
    overlay.remove();
  }

  document.body.appendChild(overlay);
  renderUi();
}
