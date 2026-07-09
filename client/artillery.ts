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

import { WA_W, WA_H, WA_TURN_MS, WA_HP } from '../shared/types';

export interface ArtilleryNet {
  join(): void;
  leave(): void;
  start(): void;
  end(winner: number, winner2?: number): void; // (host only) winning lobby slot(s); -1 = nobody paid
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
// 2v2 teams interleave by slot (0&2 vs 1&3) so turn order naturally alternates sides.
const TEAM_NAMES = ['🌊 TEAM TIDE', '🔥 TEAM FLAME'] as const;
const TEAM_BADGE = ['🌊', '🔥'] as const;
// in 2v2 the whole color scheme goes team-first: TIDE wears the blues, FLAME wears the fire
const TEAM_COLORS = [['#00e5ff', '#4a90ff'], ['#ff9a00', '#ff4a4a']] as const;
const teamOf = (idx: number) => idx % 2;

// --- battlefield maps (host picks; the generator theme + profile per map) ---
interface WaMap { name: string; desc: string; grass: string; dirtTop: string; dirtDeep: string; fill: 'sl-ground' | 'sl-rockfill'; grassy: boolean; tint?: string; }
const MAPS: WaMap[] = [
  { name: 'THE HILLS', desc: 'classic rolling countryside', grass: '#3f7a3a', dirtTop: '#3d2a14', dirtDeep: '#180e05', fill: 'sl-ground', grassy: true },
  { name: 'THE RUINS', desc: 'stepped stone + ancient pillars', grass: '#5a7a5a', dirtTop: '#4a4a55', dirtDeep: '#1a1a22', fill: 'sl-rockfill', grassy: false, tint: 'rgba(90, 110, 140, 0.18)' },
  { name: 'FOUNTAIN VALLEY', desc: 'one deep basin, no cover in the middle', grass: '#4a8a5a', dirtTop: '#2a3a24', dirtDeep: '#0e1408', fill: 'sl-ground', grassy: true, tint: 'rgba(20, 70, 40, 0.20)' },
  { name: 'THE ARENA', desc: 'two mesas, one fatal chasm', grass: '#7a6a3a', dirtTop: '#4a3520', dirtDeep: '#1c1208', fill: 'sl-ground', grassy: false, tint: 'rgba(190, 120, 40, 0.22)' },
  { name: 'SKY ISLANDS', desc: 'no mainland — girders or death', grass: '#4aaa6a', dirtTop: '#3a4a5c', dirtDeep: '#141c26', fill: 'sl-ground', grassy: true, tint: 'rgba(40, 60, 120, 0.20)' },
  { name: 'THE CAVERNS', desc: 'a hollowed-out underworld', grass: '#6a5a8a', dirtTop: '#3a2e4c', dirtDeep: '#120c1c', fill: 'sl-rockfill', grassy: false, tint: 'rgba(120, 70, 190, 0.16)' },
  { name: 'ROBVILLE', desc: 'towers, floors, and bad intentions', grass: '#5a6a72', dirtTop: '#3c4248', dirtDeep: '#16181c', fill: 'sl-rockfill', grassy: false, tint: 'rgba(60, 90, 110, 0.25)' },
];
const GRAV = 640;            // px/s² for projectiles and fighters
const WALK_SPEED = 95;       // px/s
const STEP_UP = 17;          // max ledge a fighter can walk up
const JUMP_VY = -350;        // W to jump (clears ~95px — craters are no longer prisons)
const RETREAT_MS = 5000;     // scramble window after firing before your turn ends
const FALL_SAFE = 220;       // free-fall px before damage starts
const WATER_BASE = WA_H - 26;   // starting waterline (rises in sudden death)
const SUDDEN_DEATH_ROUNDS = 9;  // full rounds EACH before the water starts climbing
const WATER_RISE = 26;          // px per turn once sudden death begins
const SUBDT = 1 / 120;       // fixed physics timestep — KEEP IDENTICAL EVERYWHERE (determinism)
interface Weapon {
  name: string; icon: string; wind: boolean; bounce: boolean; fuseMs: number;
  radius: number; dmg: number; hitscan: boolean; ammo: number;
  rest?: number;                    // bounce restitution (default 0.45)
  special?: 'air' | 'pong' | 'girder' | 'dirt' | 'bowl' | 'tp'; // non-standard behaviors
}
const WEAPONS: Weapon[] = [
  { name: 'BAZOOKA', icon: '🚀', wind: true, bounce: false, fuseMs: 0, radius: 62, dmg: 48, hitscan: false, ammo: -1 },
  { name: 'GRENADE', icon: '💣', wind: false, bounce: true, fuseMs: 3000, radius: 55, dmg: 42, hitscan: false, ammo: -1 },
  { name: 'SHOTGUN', icon: '🔫', wind: false, bounce: false, fuseMs: 0, radius: 18, dmg: 28, hitscan: true, ammo: -1 },
  { name: 'DYNAMITE', icon: '🧨', wind: false, bounce: false, fuseMs: 3500, radius: 85, dmg: 75, hitscan: false, ammo: 2 },
  { name: 'AIRSTRIKE', icon: '🛩️', wind: false, bounce: false, fuseMs: 0, radius: 42, dmg: 32, hitscan: false, ammo: 1, special: 'air' },
  { name: 'PONG BALL', icon: '🏓', wind: false, bounce: true, fuseMs: 5000, radius: 72, dmg: 62, hitscan: false, ammo: 1, rest: 0.72, special: 'pong' },
  { name: 'GIRDER', icon: '🧱', wind: false, bounce: false, fuseMs: 0, radius: 0, dmg: 0, hitscan: false, ammo: 1, special: 'girder' },   // BUILD: place a steel beam at the mouse
  { name: 'DIRT BALL', icon: '🪣', wind: false, bounce: false, fuseMs: 0, radius: 52, dmg: 0, hitscan: false, ammo: 1, special: 'dirt' }, // BUILD: lob a mound of fresh terrain
  { name: 'BOWLING BALL', icon: '🎳', wind: false, bounce: false, fuseMs: 0, radius: 70, dmg: 55, hitscan: false, ammo: 0, special: 'bowl' }, // crate-only: the 7-10 split
  { name: 'TELEPORT', icon: '🌀', wind: false, bounce: false, fuseMs: 0, radius: 0, dmg: 0, hitscan: false, ammo: 1, special: 'tp' },        // key 0: escape hatch — ends your turn
];
const GIRDER_RANGE = 340;  // how far from your soldier a beam can be placed
// wildcard-event ordnance (not player-selectable)
const METEOR: Weapon = { name: 'METEOR', icon: '☄️', wind: false, bounce: false, fuseMs: 0, radius: 36, dmg: 26, hitscan: false, ammo: 0 };
// supply crate contents → weapon index (or hp)
const CRATE_KINDS = ['hp', 'dyna', 'air', 'pong', 'girder', 'dirt', 'bowl', 'tp'] as const;
type CrateKind = typeof CRATE_KINDS[number];
const CRATE_WEAPON: Record<Exclude<CrateKind, 'hp'>, number> = { dyna: 3, air: 4, pong: 5, girder: 6, dirt: 7, bowl: 8, tp: 9 };
const CRATE_ICON: Record<CrateKind, string> = { hp: '❤️', dyna: '🧨', air: '🛩️', pong: '🏓', girder: '🧱', dirt: '🪣', bowl: '🎳', tp: '🌀' };

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

// seeded 2D value noise (two octaves, bilinear) — drives the cavern map
function makeNoise2(rnd: () => number) {
  const N = 64;
  const grid = Array.from({ length: N * N }, () => rnd());
  const at = (gx: number, gy: number) => grid[((gy % N + N) % N) * N + ((gx % N + N) % N)];
  const level = (x: number, y: number, scale: number) => {
    const fx = x / scale, fy = y / scale;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  return (x: number, y: number) => level(x, y, 150) * 0.65 + level(x, y, 55) * 0.35;
}

// Kenney CC0 sprites (client/public/worms/) — terrain fill tiles, crates, meteors.
// Same deal as the overworld's Tiny Town sheet; tiny PNGs, preloaded at module import.
const ASSETS: Record<string, HTMLImageElement> = {};
for (const n of ['sl-ground', 'sl-rockfill', 'sl-grasstop', 'sl-tree', 'sl-bush', 'sl-rock', 'sl-shrooms', 'sl-skulls', 'sl-crate', 'sl-house', 'sl-back', 'sl-middle', 'meteor1', 'meteor2']) {
  const img = new Image();
  img.src = `/worms/${n}.png`;
  ASSETS[n] = img;
}
const imgReady = (n: string) => ASSETS[n]?.complete && ASSETS[n].naturalWidth > 0;
// pixel art wants integer upscales with no smoothing — pre-scale once per use
function scaled(n: string, factor: number): HTMLCanvasElement | null {
  if (!imgReady(n)) return null;
  const img = ASSETS[n];
  const c = document.createElement('canvas');
  c.width = img.naturalWidth * factor;
  c.height = img.naturalHeight * factor;
  const cc = c.getContext('2d')!;
  cc.imageSmoothingEnabled = false;
  cc.drawImage(img, 0, 0, c.width, c.height);
  return c;
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
  let teamMode = false; // host toggles 2v2 (requires exactly 4 humans)
  let mapChoice = 0; // host's battlefield pick (index into MAPS)

  // --- battlefield state (identical on every client) ---
  interface Fighter {
    name: string; color: string; lobbySlot: number;
    x: number; y: number; vy: number; face: number; // face: 1 right, -1 left
    hp: number; alive: boolean; ammo: number[];     // per-weapon ammo (-1 = infinite)
    fallFrom: number;                                // y where the current fall began
  }
  let fighters: Fighter[] = [];
  let solid = new Uint8Array(WA_W * WA_H);
  let terrain: HTMLCanvasElement | null = null;      // pre-rendered dirt, carved as we go
  let backwall: HTMLCanvasElement | null = null;     // dark rock BEHIND the terrain — caves and
                                                     // craters reveal this instead of raw sky
  let turnPi = -1;                                   // whose turn (fighter index)
  let gravScale = 1;                                 // wildcard low-gravity turns scale projectile arcs
  let eventResolving = false;                        // wildcard flights in the air (don't advance the turn)
  let hasFired = false;                              // acting player already shot this turn
  let pelletsUsed = 0;                               // shotgun fires TWICE per turn (the Worms way)
  let retreatUntil = 0;                              // ...but may still RUN until this timestamp
  let turnRetreatUntil = 0;                          // host: when the current shooter's retreat window closes
  let turnShotTaken = false;                         // set on EVERY client when the acting player's shot arrives
  let advanceTimer = 0;                              // host: the one pending turn-advance timeout
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

  interface Spark { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; }
  let sparks: Spark[] = [];
  let shakeUntil = 0, shakeAmp = 0;
  interface Floaty { x: number; y: number; text: string; color: string; life: number; }
  let floaties: Floaty[] = [];                       // "-34" damage numbers drifting up
  let graves: { x: number; y: number }[] = [];       // 🪦 where fighters fell
  let quip = ''; let quipUntil = 0;                  // battlefield commentary
  const say = (text: string) => { quip = text; quipUntil = performance.now() + 3400; };
  const QUIPS = {
    bigHit: ['DEVASTATING.', 'That one\'s going in the highlight reel.', 'Someone screenshot that.', 'The House is adjusting the odds.', 'The leaderboard felt that.'],
    selfHit: ['Friendly fire! With yourself!', 'Bold strategy.', 'The enemy within.', 'The tutorial did not cover this.'],
    drown: ['Gone swimming. Permanently.', 'The water always wins.', 'Blub blub.', 'The fountain claims another.', 'Should have equipped the boat.'],
    miss: ['The dirt felt that one.', 'Warning shot. Probably.', 'The wind sends its regards.', 'Terraforming, technically.', 'The Ruins gained a new pothole.'],
    lore: [
      'The Dorito man watches from beyond the hills. He approves.',
      'Somewhere out there, Waldo is watching this war. Unfound.',
      'The fountain runs regardless. It always has.',
      'This violence is rated E for ELO.',
      'The Ruins have seen worse. Barely.',
      'Somewhere in the Tavern, someone just bet coins on this.',
      'The House takes no sides. The House takes commission.',
      'DOOM is still down there. This is nothing.',
      'The changelog will remember this.',
      'Kenny has seen this before. Kenny sees everything.',
      'The stop-sign octagon demands eight players. This will do for now.',
      'Somewhere, a paddle misses a ball. Priorities.',
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

  let mapIdxLive = 0; // which map the renderer is showing (parallax band selection)
  // --- terrain generation (seeded + map profile, deterministic on every client) ---
  function genTerrain(seed: number, map: number) {
    mapIdxLive = map;
    const theme = MAPS[map] ?? MAPS[0];
    const rnd = mulberry32(seed);
    const phases = [rnd() * 9, rnd() * 9, rnd() * 9];
    const freqs = [0.0021 + rnd() * 0.001, 0.0058 + rnd() * 0.002, 0.013 + rnd() * 0.004];
    const amps = [170 + rnd() * 90, 70 + rnd() * 40, 22 + rnd() * 14];
    const base = WA_H * (0.58 + rnd() * 0.08);
    const noise2 = makeNoise2(rnd);
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
    if (map === 4) {
      // SKY ISLANDS: nothing but floating rock over open water
      const nI = 6 + Math.floor(rnd() * 3);
      for (let isl = 0; isl < nI; isl++) {
        const ix = 130 + (WA_W - 260) * (isl + 0.5) / nI + (rnd() - 0.5) * 130;
        const iy = WA_H * 0.3 + rnd() * WA_H * 0.42;
        const rx = 95 + rnd() * 95, ry = 30 + rnd() * 30;
        for (let y = Math.max(0, iy - ry) | 0; y < Math.min(WA_H, iy + ry * 1.8); y++) {
          for (let x = Math.max(0, ix - rx) | 0; x < Math.min(WA_W, ix + rx); x++) {
            const ddx = (x - ix) / rx;
            const ddy = y < iy ? (y - iy) / ry : (y - iy) / (ry * 1.8); // teardrop bottoms
            if (ddx * ddx + ddy * ddy <= 1) solid[y * WA_W + x] = 1;
          }
        }
      }
    } else if (map === 5) {
      // THE CAVERNS: a mostly-solid underworld hollowed out by noise
      const ceiling = WA_H * 0.22;
      for (let y = ceiling | 0; y < WA_H; y++) {
        for (let x = 0; x < WA_W; x++) {
          const n = noise2(x, y);
          const depthBias = (y - ceiling) / (WA_H - ceiling) * 0.13; // more open near the top
          if (n + depthBias > 0.46) solid[y * WA_W + x] = 1;
        }
      }
      // guarantee a floor band so the whole map can't drain into the water
      for (let y = WA_H - 90; y < WA_H; y++) for (let x = 0; x < WA_W; x++) solid[y * WA_W + x] = 1;
    } else if (map === 6) {
      // ROBVILLE: flat ground + hollow towers with floors, windows and rooftop access
      const ground = WA_H * 0.78;
      for (let x = 0; x < WA_W; x++) for (let y = ground | 0; y < WA_H; y++) solid[y * WA_W + x] = 1;
      const nT = 4 + Math.floor(rnd() * 3);
      for (let t = 0; t < nT; t++) {
        const tw = 130 + Math.floor(rnd() * 90);
        const tx0 = Math.floor(60 + (WA_W - 120 - tw) * (t + 0.5) / nT + (rnd() - 0.5) * 60);
        const th = 280 + Math.floor(rnd() * 300);
        const top = ground - th;
        // shell
        for (let x = tx0; x < tx0 + tw; x++) for (let y = top | 0; y < ground; y++) solid[y * WA_W + x] = 1;
        // hollow rooms per floor (leave 12px walls and 12px slabs)
        for (let fy = top + 14; fy < ground - 24; fy += 88) {
          for (let y = fy | 0; y < Math.min(ground - 12, fy + 74); y++) {
            for (let x = tx0 + 12; x < tx0 + tw - 12; x++) solid[y * WA_W + x] = 0;
          }
          // a window/door gap on a random side of this floor
          const left = rnd() < 0.5;
          const gy0 = (fy + 18) | 0;
          for (let y = gy0; y < gy0 + 42 && y < ground - 12; y++) {
            for (let k = 0; k < 12; k++) solid[y * WA_W + (left ? tx0 + k : tx0 + tw - 1 - k)] = 0;
          }
        }
      }
    } else {
      for (let x = 0; x < WA_W; x++) {
        const top = Math.max(60, Math.min(WA_H + 120, hmap[x]));
        for (let y = Math.min(WA_H - 1, top) | 0; y < WA_H; y++) {
          if (top < WA_H) solid[y * WA_W + x] = 1;
        }
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
    // caves — hollow chambers to hide (or cower) in (heightmap maps only)
    if (map <= 2) {
      const nC = 2 + Math.floor(rnd() * 3);
      for (let c = 0; c < nC; c++) {
        const cavX = 140 + rnd() * (WA_W - 280);
        const groundY = Math.max(60, Math.min(WA_H - 60, hmap[cavX | 0]));
        const cavY = Math.min(WA_H - 110, groundY + 90 + rnd() * Math.max(30, WA_H - groundY - 260));
        const rx = 70 + rnd() * 90, ry = 30 + rnd() * 40;
        for (let y = Math.max(0, cavY - ry) | 0; y < Math.min(WA_H, cavY + ry); y++) {
          for (let x = Math.max(0, cavX - rx) | 0; x < Math.min(WA_W, cavX + rx); x++) {
            const ddx = (x - cavX) / rx, ddy = (y - cavY) / ry;
            if (ddx * ddx + ddy * ddy <= 1) solid[y * WA_W + x] = 0;
          }
        }
      }
    }
    // floating islands — high ground for the bold (girder up, or get blown off)
    if (map === 0 || map === 2) {
      const nI = 1 + Math.floor(rnd() * 2);
      for (let isl = 0; isl < nI; isl++) {
        const ix = 200 + rnd() * (WA_W - 400);
        const groundY = Math.max(60, Math.min(WA_H - 60, hmap[ix | 0]));
        const iy = Math.max(130, groundY - 230 - rnd() * 150);
        const rx = 90 + rnd() * 70, ry = 22 + rnd() * 14;
        for (let y = Math.max(0, iy - ry) | 0; y < Math.min(WA_H, iy + ry); y++) {
          for (let x = Math.max(0, ix - rx) | 0; x < Math.min(WA_W, ix + rx); x++) {
            const ddx = (x - ix) / rx, ddy = (y - iy) / ry;
            if (ddx * ddx + ddy * ddy <= 1) solid[y * WA_W + x] = 1;
          }
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
    // paint each column as contiguous solid runs (grass lip on every run top).
    // Fill is a real Kenney tile pattern when the sprite is ready (it always is by match
    // start — they're ~1KB), painted per-column so carving stays pixel-clean.
    // Sunny Land pixel fills at 2x (nearest-neighbor). The lip pattern is translated to
    // each run's top so the grass surface hugs every hill, cave roof and crater rim.
    const fillCanvas = scaled(theme.fill, 2);
    const pat = fillCanvas ? tc.createPattern(fillCanvas, 'repeat') : null;
    const lipCanvas = theme.grassy ? scaled('sl-grasstop', 2) : null;
    const lipPat = lipCanvas ? tc.createPattern(lipCanvas, 'repeat') : null;
    for (let x = 0; x < WA_W; x++) {
      let y = 0;
      while (y < WA_H) {
        while (y < WA_H && !solid[y * WA_W + x]) y++;
        if (y >= WA_H) break;
        const runTop = y;
        while (y < WA_H && solid[y * WA_W + x]) y++;
        tc.fillStyle = pat ?? dirt;
        tc.fillRect(x, runTop, 1, y - runTop);
        const lipH = Math.min(theme.grassy ? 14 : 4, y - runTop);
        if (lipPat) {
          tc.save();
          tc.translate(0, runTop); // align the grass strip's top to THIS run's surface
          tc.fillStyle = lipPat;
          tc.fillRect(x, 0, 1, lipH);
          tc.restore();
        } else {
          // non-grassy maps get a subtle lit edge instead of a colored stripe
          tc.fillStyle = 'rgba(255, 240, 200, 0.28)';
          tc.fillRect(x, runTop, 1, Math.min(3, y - runTop));
          tc.fillStyle = theme.grass;
          tc.fillRect(x, runTop + 3, 1, Math.max(0, lipH - 3));
        }
      }
    }
    // the backwall: for every column, dark rock spans the solid's vertical extent. It is
    // NEVER carved — so blowing a hole (or generating a cave) reveals dark underground
    // instead of the night sky, which is what made caves look like black stickers.
    backwall = document.createElement('canvas');
    backwall.width = WA_W; backwall.height = WA_H;
    const bwc = backwall.getContext('2d')!;
    const bwGrad = bwc.createLinearGradient(0, 0, 0, WA_H);
    bwGrad.addColorStop(0, '#171223');
    bwGrad.addColorStop(1, '#0a0812');
    bwc.fillStyle = bwGrad;
    for (let x = 0; x < WA_W; x++) {
      let top = -1, bot = -1;
      for (let y = 0; y < WA_H; y++) if (solid[y * WA_W + x]) { top = y; break; }
      if (top < 0) continue;
      for (let y = WA_H - 1; y >= top; y--) if (solid[y * WA_W + x]) { bot = y; break; }
      bwc.fillRect(x, top + 5, 1, Math.max(0, bot - top - 4));
    }
    // faint rocky noise so big caverns don't read flat
    for (let i = 0; i < 1400; i++) {
      const rx = rnd() * WA_W, ry = rnd() * WA_H;
      bwc.fillStyle = rnd() < 0.5 ? '#ffffff06' : '#00000018';
      bwc.fillRect(rx, ry, 2 + rnd() * 3, 2 + rnd() * 3);
    }

    // map mood tint over the tile pattern (source-atop keeps crater edges clean)
    if (theme.tint) {
      tc.save();
      tc.globalCompositeOperation = 'source-atop';
      tc.fillStyle = theme.tint;
      tc.fillRect(0, 0, WA_W, WA_H);
      tc.restore();
    }
    // texture pass — source-atop paints ONLY where terrain exists, so craters stay clean:
    tc.save();
    tc.globalCompositeOperation = 'source-atop';
    // sediment strata
    for (let y = 0; y < WA_H; y += 22 + Math.floor(rnd() * 18)) {
      tc.fillStyle = `rgba(0,0,0,${0.06 + rnd() * 0.08})`;
      tc.fillRect(0, y, WA_W, 3 + Math.floor(rnd() * 5));
    }
    // mineral speckle
    for (let i = 0; i < 2600; i++) {
      const sx = rnd() * WA_W, sy = rnd() * WA_H;
      tc.fillStyle = rnd() < 0.5 ? '#ffffff10' : '#00000018';
      tc.fillRect(sx, sy, 1 + rnd() * 2.4, 1 + rnd() * 2.4);
    }
    // top-light: terrain reads brighter near the sky
    const light = tc.createLinearGradient(0, 0, 0, WA_H);
    light.addColorStop(0, 'rgba(255,244,214,0.10)');
    light.addColorStop(0.45, 'rgba(255,244,214,0)');
    tc.fillStyle = light;
    tc.fillRect(0, 0, WA_W, WA_H);
    tc.restore();
    // set dressing: real Sunny Land props painted INTO the terrain canvas (blasts remove
    // them with the ground they stood on). Pixel-crisp at 2x, per-map casts.
    const surface = (x: number) => { for (let y = 0; y < WA_H; y++) if (solid[y * WA_W + x]) return y; return -1; };
    tc.imageSmoothingEnabled = false;
    const stamp = (n: string, x: number, top: number, f: number) => {
      const img = ASSETS[n];
      if (!imgReady(n)) return;
      const w = img.naturalWidth * f, h = img.naturalHeight * f;
      tc.drawImage(img, x - w / 2, top - h + 2, w, h);
    };
    let housePlaced = false;
    for (let x = 60; x < WA_W - 60; x += 30 + Math.floor(rnd() * 70)) {
      const top = surface(x);
      if (top < 70 || top > WA_H - 130) continue;
      const roll = rnd();
      if (map === 6) {
        if (roll < 0.18) { // rooftop antenna (procedural — fits the skyline)
          tc.strokeStyle = '#8a949e'; tc.lineWidth = 2;
          tc.beginPath(); tc.moveTo(x, top); tc.lineTo(x, top - 26); tc.stroke();
          tc.fillStyle = '#ff5a5a'; tc.fillRect(x - 2, top - 30, 4, 4);
        } else if (roll < 0.26) stamp('sl-crate', x, top, 2);
      } else if (map === 5) {
        if (roll < 0.26) stamp('sl-shrooms', x, top, 2);
        else if (roll < 0.34) stamp('sl-skulls', x, top, 2);
      } else if (map === 1 || map === 3) {
        if (roll < 0.14) stamp('sl-skulls', x, top, 2);
        else if (roll < 0.26) stamp('sl-rock', x, top, 2);
      } else {
        if (roll < 0.13) stamp('sl-tree', x, top, 1.6);
        else if (roll < 0.24) stamp('sl-bush', x, top, 2);
        else if (roll < 0.31) stamp('sl-rock', x, top, 2);
        else if (!housePlaced && roll < 0.335) { stamp('sl-house', x, top, 1.8); housePlaced = true; } // somebody lives here. lived.
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
    // blast through the dark backwall too, at a smaller radius: craters keep a scorched
    // dark rim, but the middle punches clean through to sky — the silhouette really shrinks
    // instead of leaving "weird black things" where the floor used to be
    if (backwall) {
      const bc = backwall.getContext('2d')!;
      bc.save();
      bc.globalCompositeOperation = 'destination-out';
      bc.beginPath();
      bc.arc(cx, cy, r * 0.68, 0, Math.PI * 2);
      bc.fill();
      bc.restore();
    }
  }

  // BUILD: pour fresh terrain (dirt ball). Fighters caught inside pop up on top of the mound.
  function addTerrain(cx: number, cy: number, r: number) {
    const x0 = Math.max(0, cx - r | 0), x1 = Math.min(WA_W - 1, cx + r | 0);
    const y0 = Math.max(0, cy - r | 0), y1 = Math.min(WA_H - 1, cy + r | 0);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r * r) solid[y * WA_W + x] = 1;
      }
    }
    if (terrain) {
      const tc = terrain.getContext('2d')!;
      tc.fillStyle = '#3d2a14';
      tc.beginPath();
      tc.arc(cx, cy, r, 0, Math.PI * 2);
      tc.fill();
      tc.fillStyle = '#3f7a3a';
      tc.beginPath();
      tc.arc(cx, cy, r, Math.PI, Math.PI * 2); // grassy crown
      tc.arc(cx, cy, r - 5, Math.PI * 2, Math.PI, true);
      tc.fill();
    }
    for (const f of fighters) { // buried? surface politely
      if (!f.alive) continue;
      let guard = 0;
      while (isSolid(f.x, f.y - 2) && guard++ < 400) f.y--;
      f.fallFrom = f.y;
    }
    boomDust(cx, cy, r);
  }

  // BUILD: place a steel girder beam (solid, paintable, blows up like anything else)
  function addGirder(cx: number, cy: number) {
    const w = 120, h = 14;
    const x0 = Math.max(0, cx - w / 2 | 0), x1 = Math.min(WA_W - 1, cx + w / 2 | 0);
    const y0 = Math.max(0, cy - h / 2 | 0), y1 = Math.min(WA_H - 1, cy + h / 2 | 0);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) solid[y * WA_W + x] = 1;
    if (terrain) {
      const tc = terrain.getContext('2d')!;
      const g = tc.createLinearGradient(0, y0, 0, y1);
      g.addColorStop(0, '#9aa4b2');
      g.addColorStop(0.5, '#6a7482');
      g.addColorStop(1, '#3a4250');
      tc.fillStyle = g;
      tc.fillRect(x0, y0, x1 - x0, y1 - y0);
      tc.fillStyle = '#2a3240';
      for (let x = x0 + 8; x < x1 - 4; x += 16) tc.fillRect(x, cy - 2 | 0, 4, 4); // rivets
    }
  }

  function boomDust(x: number, y: number, r: number) {
    for (let i = 0; i < Math.round(r * 0.6); i++) {
      const a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 180;
      sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 90, life: 0, max: 0.5 + Math.random() * 0.4, color: ['#7a5a34', '#5a4224', '#8a7a5a'][i % 3] });
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
    // crates caught in the blast cook off (one mini blast each, no further chaining)
    const cooked = crates.filter((c) => Math.hypot(c.x - cx, c.y - cy) < w.radius * 1.2);
    crates = crates.filter((c) => !cooked.includes(c));
    for (const c of cooked) {
      carve(c.x, c.y, 26);
      boom(c.x, c.y, 26);
      for (const f of fighters) {
        if (!f.alive) continue;
        const d2 = Math.hypot(f.x - c.x, (f.y - 9) - c.y);
        if (d2 < 48) {
          const dmg2 = Math.round(20 * (1 - d2 / 48));
          f.hp = Math.max(0, f.hp - dmg2);
          if (dmg2 > 0) floaties.push({ x: f.x, y: f.y - 34, text: `-${dmg2}`, color: '#ffd060', life: 0 });
          if (f.hp <= 0) killFighter(f, false);
        }
      }
      say('The supply crate has been... redistributed.');
    }
    for (const f of fighters) if (f.alive) settleFighter(f);
    // cosmetic
    boom(cx, cy, w.radius);
    sfxBoom(w.radius / 85);
    if (hitSelf) say(pick(QUIPS.selfHit));
    else if (bigHit) say(pick(QUIPS.bigHit));
    else if (!anyHit) say(pick(QUIPS.miss));
  }

  function resolveShot(pi: number, w: number, sx: number, sy: number, ang: number, pow: number, tx?: number, ty?: number, last = true) {
    resolving = true;
    // shotgun pellet 1 is NOT the final shot — the clock keeps running so an abandoned
    // second pellet can't hang the turn
    if (pi === turnPi && last) turnShotTaken = true;
    sfxFire();
    const wp = WEAPONS[w];
    const shooter = fighters[pi];
    if (shooter) { shooter.x = sx; shooter.y = sy; }
    if (shooter && wp.ammo >= 0) shooter.ammo[w] = Math.max(0, shooter.ammo[w] - 1);
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
      if (last) finishShot();
      else resolving = false; // pellet one of two — keep aiming
      return;
    }
    if (wp.special === 'girder') {
      // clamp the requested spot to build range from the soldier
      let gx = (tx ?? sx), gy = (ty ?? sy - 80);
      const gdx = gx - sx, gdy = gy - (sy - 10);
      const gdist = Math.hypot(gdx, gdy);
      if (gdist > GIRDER_RANGE) { gx = sx + gdx / gdist * GIRDER_RANGE; gy = (sy - 10) + gdy / gdist * GIRDER_RANGE; }
      addGirder(Math.max(30, Math.min(WA_W - 30, gx)), Math.max(30, Math.min(WA_H - 30, gy)));
      say('Infrastructure. In THIS economy?');
      finishShot();
      return;
    }
    if (wp.special === 'tp') {
      if (shooter) {
        let px = Math.max(20, Math.min(WA_W - 20, tx ?? sx));
        let py = Math.max(20, Math.min(WA_H - 30, ty ?? sy));
        let guard = 0;
        while (isSolid(px, py) && guard++ < 500) py--; // pop up out of solid ground
        for (let i = 0; i < 18; i++) sparks.push({ x: shooter.x, y: shooter.y - 9, vx: (Math.random() - 0.5) * 200, vy: (Math.random() - 0.5) * 200, life: 0, max: 0.4, color: '#b090ff' });
        shooter.x = px; shooter.y = py;
        shooter.fallFrom = py; // teleporting resets the fall — you appear, THEN gravity applies
        shooter.vy = 0;
        settleFighter(shooter);
        for (let i = 0; i < 18; i++) sparks.push({ x: px, y: shooter.y - 9, vx: (Math.random() - 0.5) * 200, vy: (Math.random() - 0.5) * 200, life: 0, max: 0.4, color: '#b090ff' });
        say('Teleportation: the coward\'s cardio.');
      }
      finishShot();
      return;
    }
    if (wp.special === 'air') {
      // three bomblets scream in from above the target x (relayed as tx)
      const at = Math.max(60, Math.min(WA_W - 60, tx ?? sx));
      for (let k = 0; k < 3; k++) spawnFlight(at - 80 + k * 80, -30 - k * 60, 0, 140, wp);
      say('Air support inbound. The pigeons scatter.');
      return;
    }
    if (w === 3) {
      // dynamite: dropped at the feet, big fuse — a delayed blast in place
      spawnFlight(sx + (shooter?.face ?? 1) * 14, sy - 4, 0, 0, wp);
      return;
    }
    // ballistic: fixed-timestep flight (deterministic)
    const speed = 380 + pow * 720;
    spawnFlight(sx + Math.cos(ang) * 16, sy - 12 + Math.sin(ang) * 16, Math.cos(ang) * speed, Math.sin(ang) * speed, wp);
  }

  // Ballistic flights, animated over real frames but STEPPED deterministically: physics
  // advance in fixed SUBDT increments regardless of frame rate, so every client computes the
  // identical impact points; frames only decide how often we repaint along the way. Multiple
  // shells (airstrike) fly at once — the turn advances when the LAST one resolves.
  interface Flight { x: number; y: number; vx: number; vy: number; wp: Weapon; fuse: number; steps: number; trail: [number, number][]; done: boolean; }
  let flights: Flight[] = [];
  function spawnFlight(x: number, y: number, vx: number, vy: number, wp: Weapon) {
    flights.push({ x, y, vx, vy, wp, fuse: wp.fuseMs / 1000, steps: 0, trail: [], done: false });
  }
  function stepFlight(frames: number) {
    if (!flights.length) return;
    for (const fl of flights) {
      for (let i = 0; i < frames && !fl.done; i++) {
        fl.steps++;
        if (fl.steps > 12 * 120) { fl.done = true; break; } // 12s hard cap — lost shells fizzle
        if (fl.wp.wind) fl.vx += wind * 52 * SUBDT;
        fl.vy += GRAV * gravScale * SUBDT;
        fl.x += fl.vx * SUBDT;
        fl.y += fl.vy * SUBDT;
        if (fl.fuse > 0) {
          fl.fuse -= SUBDT;
          if (fl.fuse <= 0) { fl.done = true; explode(fl.x, fl.y, fl.wp); break; }
        }
        if (fl.y > waterY + 6) { // plunk — the water keeps it
          sfxSplash();
          for (let sp = 0; sp < 10; sp++) sparks.push({ x: fl.x, y: waterY + 4, vx: (Math.random() - 0.5) * 160, vy: -120 - Math.random() * 160, life: 0, max: 0.5, color: '#7fd0ff' });
          say(pick(QUIPS.drown));
          fl.done = true; break;
        }
        if (fl.x < -80 || fl.x > WA_W + 80 || fl.y > WA_H + 40) { fl.done = true; break; }
        if (isSolid(fl.x, fl.y)) {
          if (fl.wp.bounce || fl.wp.fuseMs > 0) {
            // back out and reflect (grenade/dynamite/pong ball bounce until the fuse blows)
            while (isSolid(fl.x, fl.y)) { fl.x -= fl.vx * SUBDT; fl.y -= fl.vy * SUBDT; }
            const rest = fl.wp.rest ?? 0.45;
            if (Math.abs(fl.vy) > Math.abs(fl.vx)) fl.vy = -fl.vy * rest; else fl.vx = -fl.vx * rest;
            fl.vx *= fl.wp.special === 'pong' ? 0.94 : 0.75;
          } else if (fl.wp.special === 'dirt') {
            fl.done = true; addTerrain(fl.x, fl.y, fl.wp.radius); say('Fresh real estate. The bank is interested.'); break;
          } else {
            fl.done = true; explode(fl.x, fl.y, fl.wp); break;
          }
        }
        const prox = fl.wp.special === 'pong' ? 26 : 13;
        const victim = fighters.find((f) => f.alive && f !== fighters[turnPi] && Math.abs(f.x - fl.x) < prox && Math.abs(f.y - 9 - fl.y) < prox);
        if (victim && (fl.wp.special === 'pong' || (!fl.wp.bounce && fl.wp.fuseMs === 0))) {
          // the pong ball smells fear — it detonates on contact with any enemy
          fl.done = true;
          if (fl.wp.special === 'dirt') { addTerrain(fl.x, fl.y, fl.wp.radius); say('Buried alive. Rude, honestly.'); }
          else explode(fl.x, fl.y, fl.wp);
          break;
        }
      }
      if (!fl.done) { fl.trail.push([fl.x, fl.y]); if (fl.trail.length > 40) fl.trail.shift(); }
    }
    const before = flights.length;
    flights = flights.filter((fl) => !fl.done);
    if (before > 0 && flights.length === 0) finishShot();
  }

  function finishShot() {
    resolving = false;
    if (eventResolving) {
      // wildcard ordnance has landed — sync the damage but the current player still shoots
      eventResolving = false;
      if (isHost) net.relay({ t: 'sync', hp: fighters.map((f) => f.hp), px: fighters.map((f) => Math.round(f.x)), py: fighters.map((f) => Math.round(f.y)), alive: fighters.map((f) => f.alive ? 1 : 0) });
      return;
    }
    if (isHost) {
      // safety-net sync, then advance once the shooter's retreat window closes
      net.relay({ t: 'sync', hp: fighters.map((f) => f.hp), px: fighters.map((f) => Math.round(f.x)), py: fighters.map((f) => Math.round(f.y)), alive: fighters.map((f) => f.alive ? 1 : 0) });
      const wait = Math.max(1600, turnRetreatUntil - performance.now() + 500);
      scheduleAdvance(wait);
    }
  }

  /** Host-only: schedule the next turn exactly once; hostNextTurn clears anything stale. */
  function scheduleAdvance(delayMs: number) {
    if (!isHost || advanceTimer) return;
    advanceTimer = window.setTimeout(() => {
      advanceTimer = 0;
      if (waOpen && mode === 'play' && matchWinner === -2) hostNextTurn();
    }, delayMs);
  }

  // --- host: turn management + bots ---
  function hostStartMatch() {
    const humans = lobbyState?.players ?? [];
    const seed = (Math.random() * 0xffffffff) >>> 0;
    if (humans.length !== 4) teamMode = false; // 2v2 strictly needs four
    fighters = humans.map((p, i) => ({
      name: p.name,
      color: teamMode ? TEAM_COLORS[teamOf(i)][i >> 1] : COLORS[p.slot],
      lobbySlot: p.slot,
      x: 0, y: 0, vy: 0, face: 1, hp: WA_HP, alive: true, ammo: WEAPONS.map((w) => w.ammo), fallFrom: 0,
    }));
    genTerrain(seed, mapChoice);
    placeFighters();
    net.relay({ t: 'init', seed, map: mapChoice, teams: teamMode, fighters: fighters.map((f) => ({ name: f.name, lobbySlot: f.lobbySlot })) });
    mode = 'play';
    endReported = false;
    matchWinner = -2;
    turnCount = 0;
    waterY = WATER_BASE;
    graves = [];
    crates = [];
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
    // absorb any still-pending advance from the previous turn — one advance per turn, ever
    if (advanceTimer) { window.clearTimeout(advanceTimer); advanceTimer = 0; }
    const alive = fighters.filter((f) => f.alive);
    const aliveTeams = new Set(alive.map((f) => teamOf(fighters.indexOf(f))));
    const over = teamMode ? aliveTeams.size <= 1 : alive.length <= 1;
    if (over) {
      const winIdx = alive.length >= 1 ? fighters.indexOf(alive[0]) : -1;
      matchWinner = winIdx;
      banner = winIdx < 0 ? 'MUTUAL DESTRUCTION'
        : teamMode ? `${TEAM_NAMES[teamOf(winIdx)]} WINS THE WAR`
        : `${fighters[winIdx].name} WINS THE WAR`;
      bannerUntil = performance.now() + 5200;
      sfxBoom(1.3);
      say(winIdx >= 0 ? 'The Tavern erupts. Drinks are on the House. (They are not.)' : 'Nobody won. The craters won.');
      net.relay({ t: 'end', winner: winIdx, teams: teamMode });
      if (!endReported) {
        endReported = true;
        if (teamMode && winIdx >= 0) {
          const mates = fighters.map((f, i) => ({ f, i })).filter(({ i }) => teamOf(i) === teamOf(winIdx));
          net.end(mates[0]?.f.lobbySlot ?? -1, mates[1]?.f.lobbySlot);
        } else {
          net.end(winIdx >= 0 ? fighters[winIdx].lobbySlot : -1);
        }
      }
      window.setTimeout(() => { if (waOpen) backToLobby(); }, 4800);
      return;
    }
    if (!fighters.some((f) => f.alive)) return; // everyone's gone — the decided-war check ends it
    do { turnPi = (turnPi + 1) % fighters.length; } while (!fighters[turnPi].alive);
    wind = Math.round((Math.random() * 2 - 1) * 100) / 100;
    turnEndsAt = performance.now() + WA_TURN_MS;
    const crate = crates.length < 3 && Math.random() < 0.45
      ? { x: 80 + Math.floor(Math.random() * (WA_W - 160)), kind: CRATE_KINDS[Math.floor(Math.random() * CRATE_KINDS.length)] }
      : null;
    // wildcard events: rolled by the host with every random parameter baked into the message,
    // so every client replays the exact same chaos
    let ev: any = null;
    if (turnCount >= 3 && Math.random() < 0.15) {
      const roll = Math.floor(Math.random() * 5);
      if (roll === 0) ev = { k: 'meteor', rocks: Array.from({ length: 4 + Math.floor(Math.random() * 3) }, () => [80 + Math.floor(Math.random() * (WA_W - 160)), Math.floor((Math.random() - 0.5) * 120)]) };
      else if (roll === 1) ev = { k: 'frenzy', drops: Array.from({ length: 3 }, () => ({ x: 80 + Math.floor(Math.random() * (WA_W - 160)), kind: CRATE_KINDS[Math.floor(Math.random() * CRATE_KINDS.length)] })) };
      else if (roll === 2) ev = { k: 'gale', w: (Math.random() < 0.5 ? -1 : 1) * (1.3 + Math.random() * 0.5) };
      else if (roll === 3) ev = { k: 'lowg' };
      else ev = { k: 'bloom', x: 120 + Math.floor(Math.random() * (WA_W - 240)), r: 60 + Math.floor(Math.random() * 50) };
    }
    net.relay({ t: 'turn', pi: turnPi, wind, crate, ev });
    applyTurnLocal(crate, ev);
  }

  function applyTurnLocal(crate?: { x: number; kind: CrateKind } | null, ev?: any) {
    gravScale = 1;
    hasFired = false;
    pelletsUsed = 0;
    retreatUntil = 0;
    turnRetreatUntil = 0;
    turnShotTaken = false;
    if (ev) {
      if (ev.k === 'meteor') {
        banner = '☄️ METEOR SHOWER';
        bannerUntil = performance.now() + 2400;
        eventResolving = true;
        resolving = true; // inputs locked while the sky falls
        for (const [mx, mvx] of ev.rocks as [number, number][]) spawnFlight(mx, -40 - Math.abs(mvx), mvx, 160, METEOR);
        say('The Ruins send their regards.');
        turnEndsAt += 2600; // don't eat the player's clock with cosmic events
      } else if (ev.k === 'frenzy') {
        banner = '🎁 SUPPLY FRENZY';
        bannerUntil = performance.now() + 2200;
        for (const d of ev.drops as { x: number; kind: CrateKind }[]) {
          const cy = surfaceY(d.x) - 10;
          if (cy < waterY - 20) crates.push({ x: d.x, y: cy, kind: d.kind, born: performance.now() });
        }
        say('The House is feeling generous. Suspicious.');
      } else if (ev.k === 'gale') {
        wind = ev.w;
        banner = '💨 GALE FORCE';
        bannerUntil = performance.now() + 2200;
        say('The wind has opinions today.');
      } else if (ev.k === 'lowg') {
        gravScale = 0.45;
        banner = '🌙 LOW GRAVITY';
        bannerUntil = performance.now() + 2400;
        say('The moon is interfering. Aim accordingly.');
      } else if (ev.k === 'bloom') {
        addTerrain(ev.x, surfaceY(ev.x) - 10, ev.r);
        banner = '🌱 TERRAIN BLOOM';
        bannerUntil = performance.now() + 2200;
        say('The map grows. Nobody asked it to.');
      }
    }
    if (crate) {
      const cy = surfaceY(crate.x) - 10;
      if (cy < waterY - 20) {
        crates.push({ x: crate.x, y: cy, kind: crate.kind, born: performance.now() });
        say('Supply drop inbound. No questions about the logistics.');
      }
    }
    turnEndsAt = performance.now() + WA_TURN_MS;
    charge = -1;
    weapon = 0;
    turnCount++;
    // sudden death: the water climbs every turn past the threshold (deterministic — every
    // client counts the same 'turn' messages, so every client computes the same waterline)
    const over = turnCount - SUDDEN_DEATH_ROUNDS * Math.max(2, fighters.length);
    const newWater = WATER_BASE - Math.max(0, over) * WATER_RISE;
    if (newWater !== waterY) {
      waterY = newWater;
      if (over === 1) { banner = '🌊 SUDDEN DEATH — THE WATER RISES'; bannerUntil = performance.now() + 2600; }
      for (const f of fighters) if (f.alive && f.y >= waterY) killFighter(f, true);
    }
    if (!(performance.now() < bannerUntil)) { // event/sudden-death banners get their moment
      banner = `${fighters[turnPi].name}'S TURN`;
      bannerUntil = performance.now() + 1400;
    }
    // ambient lore from the announcer's booth
    if (Math.random() < 0.28 && performance.now() > quipUntil) say(pick(QUIPS.lore));
  }

  // --- cosmetic helpers ---
  // supply crates: spawned by the host at turn start, collected by walking over them
  interface Crate { x: number; y: number; kind: CrateKind; born: number; }
  let crates: Crate[] = [];
  function applyCrate(pi: number, i: number) {
    const c = crates[i];
    const f = fighters[pi];
    if (!c || !f) return;
    crates.splice(i, 1);
    if (c.kind === 'hp') {
      f.hp = Math.min(WA_HP, f.hp + 30);
      floaties.push({ x: f.x, y: f.y - 34, text: '+30', color: '#7fe089', life: 0 });
      say(`${f.name} found a med-kit. The war continues anyway.`);
    } else {
      const wi = CRATE_WEAPON[c.kind];
      f.ammo[wi]++;
      floaties.push({ x: f.x, y: f.y - 34, text: `+1 ${WEAPONS[wi].icon}`, color: '#ffd060', life: 0 });
      say(c.kind === 'bowl' ? `${f.name} visited the bowling alley. Everyone should worry.` : `${f.name} unboxed a ${WEAPONS[wi].name}.`);
    }
  }

  interface Flash { x: number; y: number; r: number; life: number; }
  let flashes: Flash[] = [];
  function boom(x: number, y: number, r: number) {
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * Math.PI * 2, sp = 80 + Math.random() * 420;
      sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 140, life: 0, max: 0.5 + Math.random() * 0.7, color: ['#ff9a3a', '#ffd060', '#ff5a3a', '#fff'][i % 4] });
    }
    flashes.push({ x, y, r: r * 1.7, life: 0 });
    shakeUntil = performance.now() + 380;
    shakeAmp = Math.min(22, r * 0.28);
  }

  function backToLobby() {
    mode = 'lobby';
    matchWinner = -2;
    flights = [];
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
        '<div style="font-size:54px;font-weight:900;letter-spacing:6px;color:#ffb847;text-shadow:0 0 30px #ffb84766">🪖 WORMS: TSONG EDITION</div>' +
        '<div style="font-size:13px;opacity:.7;margin-top:6px;letter-spacing:2px">TURN-BASED MAYHEM · DESTRUCTIBLE EVERYTHING · LAST ONE STANDING</div>';
      ui.appendChild(title);
      ui.appendChild(btn('Enlist', '#ffb847', () => net.join()));
      ui.appendChild(btn('Exit', '#8aa', close));
    } else if (mode === 'lobby') {
      const humans = lobbyState?.players ?? [];
      if (humans.length !== 4) teamMode = false;
      const roster = document.createElement('div');
      roster.style.cssText = 'font-size:15px;line-height:2;min-width:340px;';
      roster.innerHTML =
        '<div style="font-size:22px;font-weight:900;letter-spacing:6px;color:#ffb847;margin-bottom:8px">THE TRENCHES</div>' +
        humans.map((p, i) =>
          `<div style="color:${teamMode ? TEAM_COLORS[teamOf(i)][i >> 1] : COLORS[p.slot]}">${teamMode ? TEAM_BADGE[teamOf(i)] + ' ' : ''}🪖 ${p.name}${p.slot === 0 ? ' <span style="opacity:.6">(host)</span>' : ''}${p.slot === selfSlot ? ' <span style="opacity:.6">(you)</span>' : ''}</div>`,
        ).join('') +
        (humans.length < 2 ? '<div style="opacity:.5;font-size:12px">waiting for at least one more human — no bots in these trenches</div>' : '');
      ui.appendChild(roster);
      if (isHost) {
        const modeRow = document.createElement('div');
        modeRow.style.cssText = 'display:flex;gap:10px;align-items:center;';
        const ffaBtn = btn('FREE FOR ALL', !teamMode ? '#ffb847' : '#556', () => { teamMode = false; renderUi(); });
        const teamBtn = btn('2 v 2', teamMode ? '#ffb847' : '#556', () => { if (humans.length === 4) { teamMode = true; renderUi(); } });
        for (const b of [ffaBtn, teamBtn]) { b.style.fontSize = '13px'; b.style.padding = '8px 18px'; }
        if (humans.length !== 4) { teamBtn.style.opacity = '0.35'; teamBtn.title = 'needs exactly 4 players'; }
        modeRow.append(ffaBtn, teamBtn);
        ui.appendChild(modeRow);
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
        const canStart = humans.length >= 2 && (!teamMode || humans.length === 4);
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
        'A / D — walk · W — JUMP · MOUSE — aim · HOLD SPACE — charge, release to FIRE<br>' +
        'After firing you get 5s to RETREAT — run from your own dynamite, dive behind cover<br>' +
        '1 🚀 Bazooka (rides the wind) · 2 💣 Grenade (bounces, 3s fuse)<br>' +
        '3 🔫 Shotgun (fires TWICE per turn — aim between shots) · 4 🧨 Dynamite (drop &amp; RUN — ×2)<br>' +
        '5 🛩️ Airstrike (three from above, ×1) · 6 🏓 Pong Ball (bounces, hunts, ×1)<br>' +
        '7 🧱 Girder (BUILD a steel beam at the mouse, ×1) · 8 🪣 Dirt Ball (BUILD a mound, bury someone, ×1)<br>' +
        '9 🎳 Bowling Ball (crate-only) · 0 🌀 Teleport (click anywhere, ×1) · 📦 crates drop between turns<br>' +
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
      teamMode = !!d.teams;
      fighters = (d.fighters as any[]).map((f: any, i: number) => ({
        name: String(f.name),
        color: teamMode ? TEAM_COLORS[teamOf(i)][i >> 1] : COLORS[i],
        lobbySlot: f.lobbySlot ?? -1,
        x: 0, y: 0, vy: 0, face: 1, hp: WA_HP, alive: true, ammo: WEAPONS.map((w) => w.ammo), fallFrom: 0,
      }));
      turnCount = 0;
      waterY = WATER_BASE;
      graves = [];
      crates = [];
      genTerrain(d.seed >>> 0, d.map | 0);
      placeFighters();
      matchWinner = -2;
      banner = `⚔️ ${MAPS[d.map | 0]?.name ?? ''}`;
      bannerUntil = performance.now() + 2200;
      if (mode !== 'play') { mode = 'play'; renderUi(); }
    } else if (d.t === 'turn') {
      turnPi = d.pi;
      wind = d.wind;
      applyTurnLocal(d.crate, d.ev);
    } else if (d.t === 'pos') {
      const f = fighters[d.pi];
      if (f && d.pi !== myIdx()) {
        f.x = d.x; f.y = d.y; f.face = d.face; f.fallFrom = f.y;
        if (typeof d.hp === 'number' && d.hp < f.hp) {
          f.hp = d.hp;
          if (f.hp <= 0 && f.alive) killFighter(f, false);
        }
      }
    } else if (d.t === 'shot') {
      if (d.pi !== myIdx()) {
        if (isHost && fighters[d.pi] && (d.last ?? true)) turnRetreatUntil = performance.now() + RETREAT_MS;
        resolveShot(d.pi, d.w, d.x, d.y, d.ang, d.pow, d.tx, d.ty, d.last ?? true);
      }
    } else if (d.t === 'crate') {
      if (d.pi !== myIdx()) applyCrate(d.pi, d.i);
    } else if (d.t === 'drown') {
      const f = fighters[d.pi];
      if (f && f.alive) killFighter(f, true);
      if (isHost && d.pi === turnPi) scheduleAdvance(1200);
    } else if (d.t === 'sync') {
      (d.hp as number[]).forEach((hp, i) => {
        const f = fighters[i];
        if (!f) return;
        f.hp = hp; f.alive = d.alive[i] === 1;
        f.x = d.px[i]; f.y = d.py[i]; f.fallFrom = f.y;
      });
    } else if (d.t === 'end') {
      matchWinner = d.winner;
      banner = d.winner < 0 ? 'MUTUAL DESTRUCTION'
        : d.teams ? `${TEAM_NAMES[teamOf(d.winner)]} WINS THE WAR`
        : `${fighters[d.winner]?.name ?? '?'} WINS THE WAR`;
      bannerUntil = performance.now() + 5200;
      sfxBoom(1.3);
      say(d.winner >= 0 ? 'The Tavern erupts. Drinks are on the House. (They are not.)' : 'Nobody won. The craters won.');
      window.setTimeout(() => { if (waOpen) backToLobby(); }, 4800);
    }
  }

  // --- input ---
  const myIdx = () => fighters.findIndex((f) => f.lobbySlot === selfSlot);
  const myTurn = () => mode === 'play' && !resolving && !hasFired && turnPi >= 0 && turnPi === myIdx() && fighters[turnPi]?.alive && matchWinner === -2;
  // after firing you can't shoot again, but you CAN scramble until the retreat window closes
  const canMove = () => mode === 'play' && !eventResolving && turnPi >= 0 && turnPi === myIdx() && fighters[turnPi]?.alive && matchWinner === -2
    && (!hasFired || performance.now() < retreatUntil);
  const keys = new Set<string>();
  let mouseX = WA_W / 2, mouseY = 0;
  let lastPosSend = 0;

  function fire() {
    if (!myTurn() || charge < 0) return;
    const me = fighters[myIdx()];
    if (WEAPONS[weapon].ammo >= 0 && me.ammo[weapon] <= 0) { charge = -1; return; }
    const isShotgun = weapon === 2;
    if (isShotgun) pelletsUsed++;
    const last = !isShotgun || pelletsUsed >= 2;
    const shot = { t: 'shot', pi: myIdx(), w: weapon, x: Math.round(me.x), y: Math.round(me.y), ang: aimAngle, pow: Math.min(1, charge), tx: Math.round(mouseX), ty: Math.round(mouseY), last };
    charge = -1;
    if (last) {
      hasFired = true;
      retreatUntil = performance.now() + RETREAT_MS;
      turnRetreatUntil = retreatUntil;
    }
    if (weapon === 3) say('Run. RUN.');
    net.relay(shot);
    resolveShot(shot.pi, shot.w, me.x, me.y, shot.ang, shot.pow, shot.tx, shot.ty, last);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (mode !== 'play') return;
    const k = e.key.toLowerCase();
    if (['a', 'd', 'w', ' '].includes(k)) { e.preventDefault(); e.stopPropagation(); }
    if (k === ' ' && myTurn() && charge < 0 && !e.repeat) charge = 0;
    if (['1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(k) && myTurn() && pelletsUsed === 0) weapon = Number(k) - 1;
    if (k === '0' && myTurn() && pelletsUsed === 0) weapon = 9; // 🌀 teleport lives on the 0 key
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
    // movement (acting player only, real-time within the turn — including the post-shot retreat)
    if (canMove()) {
      const me = fighters[myIdx()];
      const ax = (keys.has('a') ? -1 : 0) + (keys.has('d') ? 1 : 0);
      const onGround = isSolid(me.x, me.y + 1);
      let moved = false;
      // W = jump (facing drift comes from held A/D)
      if (keys.has('w') && onGround && charge < 0) {
        me.vy = JUMP_VY;
        me.fallFrom = me.y;
        me.y -= 2;
        moved = true;
      }
      if (ax !== 0 && charge < 0) {
        me.face = ax;
        const speed = onGround ? WALK_SPEED : WALK_SPEED * 0.7; // air control, slightly clumsy
        const nx = me.x + ax * speed * dt;
        if (nx > 8 && nx < WA_W - 8) {
          if (onGround) {
            // climb small ledges, refuse walls
            let ny = me.y;
            let blocked = false;
            for (let up = 0; up <= STEP_UP; up++) {
              if (!isSolid(nx, me.y - up)) { ny = me.y - up; blocked = false; break; }
              blocked = true;
            }
            if (!blocked) { me.x = nx; me.y = ny; moved = true; }
          } else if (!isSolid(nx, me.y) && !isSolid(nx, me.y - 16)) {
            me.x = nx; moved = true;
          }
        }
      }
      // airborne physics: gravity, head bumps, landing (with fall damage), water
      if (!isSolid(me.x, me.y + 1)) {
        me.vy += GRAV * dt;
        if (me.vy < 0 && isSolid(me.x, me.y - 20)) me.vy = 0; // bumped the ceiling
        let ny = me.y + me.vy * dt;
        let landed = false;
        if (me.vy > 0) {
          for (let yy = me.y + 1; yy <= ny; yy++) {
            if (isSolid(me.x, yy + 1)) { ny = yy; landed = true; break; }
          }
        }
        me.y = ny;
        moved = true;
        if (me.y >= waterY) {
          killFighter(me, true);
          net.relay({ t: 'drown', pi: myIdx() });
          scheduleAdvance(1200);
          return;
        }
        if (landed) {
          me.vy = 0;
          const fall = me.y - me.fallFrom;
          if (fall > FALL_SAFE) {
            const dmg = Math.round((fall - FALL_SAFE) * 0.18);
            me.hp = Math.max(0, me.hp - dmg);
            floaties.push({ x: me.x, y: me.y - 34, text: `-${dmg}`, color: '#ffd060', life: 0 });
            if (me.hp <= 0) {
              killFighter(me, false);
              net.relay({ t: 'pos', pi: myIdx(), x: Math.round(me.x), y: Math.round(me.y), face: me.face, hp: me.hp });
              scheduleAdvance(1200);
              return;
            }
          }
          me.fallFrom = me.y;
        }
      } else {
        me.fallFrom = me.y;
      }
      if (moved) {
        // supply crate pickup — walk (or fall) into it
        const ci = crates.findIndex((c) => Math.abs(c.x - me.x) < 18 && Math.abs(c.y - me.y) < 30);
        if (ci >= 0) { net.relay({ t: 'crate', pi: myIdx(), i: ci }); applyCrate(myIdx(), ci); }
        if (now - lastPosSend > 80) {
          lastPosSend = now;
          net.relay({ t: 'pos', pi: myIdx(), x: Math.round(me.x), y: Math.round(me.y), face: me.face, hp: me.hp });
        }
      }
      aimAngle = Math.atan2(mouseY - (me.y - 12), mouseX - me.x);
    }
    // host duty: the shot clock (turnShotTaken is set for guests' shots too — the local
    // hasFired flag only knows about OUR shots, which is exactly the bug that skipped turns)
    if (isHost && matchWinner === -2 && !resolving && !eventResolving && !turnShotTaken && turnPi >= 0 && now > turnEndsAt) {
      hostNextTurn(); // clock expired — next soldier up
    }
    // host duty: end the war the MOMENT it's decided. Rising-water deaths happen at turn
    // start (after hostNextTurn's win check), so without this the match kept going — dead
    // players even got their full 30s turn clocks ("people be dying and the game still going").
    if (isHost && mode === 'play' && matchWinner === -2 && !resolving && !eventResolving) {
      const aliveNow = fighters.filter((f) => f.alive);
      const teamsNow = new Set(aliveNow.map((f) => teamOf(fighters.indexOf(f))));
      const decided = fighters.length > 0 && (teamMode ? teamsNow.size <= 1 : aliveNow.length <= 1);
      if (decided) hostNextTurn(); // runs the end-of-war path immediately
      else if (turnPi >= 0 && fighters[turnPi] && !fighters[turnPi].alive) scheduleAdvance(1000); // skip the fallen fast
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
    // a fat harvest moon behind everything
    ctx.fillStyle = '#f0e8d0';
    ctx.shadowColor = '#f0e8d0'; ctx.shadowBlur = 60;
    ctx.beginPath();
    ctx.arc(WA_W * 0.78, WA_H * 0.2, 52, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#d8ceb455';
    ctx.beginPath();
    ctx.arc(WA_W * 0.78 - 14, WA_H * 0.2 - 8, 9, 0, Math.PI * 2);
    ctx.arc(WA_W * 0.78 + 18, WA_H * 0.2 + 12, 6, 0, Math.PI * 2);
    ctx.fill();
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
    // Sunny Land parallax bands on the grassy maps (behind the backwall + terrain)
    if (mode === 'play' && MAPS[mapIdxLive]?.grassy && imgReady('sl-back')) {
      ctx.imageSmoothingEnabled = false;
      const img = ASSETS['sl-back'];
      const f = (WA_H * 0.5) / img.naturalHeight;
      const w = img.naturalWidth * f;
      ctx.globalAlpha = 0.55;
      for (let x = 0; x < WA_W; x += w) ctx.drawImage(img, x, WA_H * 0.16, w, img.naturalHeight * f);
      ctx.globalAlpha = 1;
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

    // dark rock behind everything solid, then the carvable terrain on top
    if (backwall) ctx.drawImage(backwall, 0, 0);
    if (terrain) ctx.drawImage(terrain, 0, 0);

    // gravestones where soldiers fell
    ctx.font = '22px serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    for (const g of graves) ctx.fillText('🪦', g.x, Math.min(g.y, waterY) + 2);

    // supply crates — parachute in under a light beacon, contents on the label
    for (const c of crates) {
      const age = now - c.born;
      const drop = Math.min(1, age / 1300);
      const cy = c.y - (1 - drop) * 170;
      const beaconCol = c.kind === 'hp' ? '255, 106, 138' : '255, 208, 96';
      if (drop >= 1) {
        // pulsing beacon column so crates read across the whole battlefield
        const pulse = 0.5 + 0.5 * Math.sin(now / 320);
        const bg = ctx.createLinearGradient(0, cy - 210, 0, cy);
        bg.addColorStop(0, `rgba(${beaconCol}, 0)`);
        bg.addColorStop(1, `rgba(${beaconCol}, ${0.16 + pulse * 0.12})`);
        ctx.fillStyle = bg;
        ctx.fillRect(c.x - 13, cy - 210, 26, 210);
        // bouncing pointer
        ctx.font = '17px ui-monospace, monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillStyle = `rgba(${beaconCol}, 0.95)`;
        ctx.fillText('▼', c.x, cy - 58 + Math.sin(now / 260) * 5);
        ctx.shadowColor = `rgb(${beaconCol})`; ctx.shadowBlur = 14 + 8 * pulse;
      } else {
        ctx.strokeStyle = '#e8e0d8';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(c.x, cy - 30, 18, Math.PI * 1.05, Math.PI * 1.95);
        ctx.moveTo(c.x - 16, cy - 21); ctx.lineTo(c.x - 7, cy - 6);
        ctx.moveTo(c.x + 16, cy - 21); ctx.lineTo(c.x + 7, cy - 6);
        ctx.stroke();
      }
      if (imgReady('sl-crate')) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(ASSETS['sl-crate'], c.x - 16, cy - 32, 32, 32);
      } else {
        ctx.font = '30px serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText('📦', c.x, cy + 3);
      }
      ctx.shadowBlur = 0;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      // the contents, printed right on the box — no mystery, pure greed
      ctx.font = '17px serif';
      ctx.fillText(CRATE_ICON[c.kind], c.x, cy - 26 + Math.sin(now / 260) * 3);
    }

    // fighters
    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i];
      if (!f.alive) continue;
      const active = i === turnPi && matchWinner === -2;
      const bob = active ? Math.sin(now / 300) * 1.5 : 0;
      const fy = f.y + bob;
      if (teamMode) {
        // always-on team ring — you can tell sides at a glance from across the map
        ctx.strokeStyle = TEAM_COLORS[teamOf(i)][0];
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.ellipse(f.x, fy - 9, 14, 16, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // grounding shadow
      ctx.fillStyle = '#00000055';
      ctx.beginPath();
      ctx.ellipse(f.x, f.y + 1, 11, 3.2, 0, 0, Math.PI * 2);
      ctx.fill();
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
      if (active && now < bannerUntil + 900) {
        // a stage spotlight finds whoever's up
        const lg = ctx.createLinearGradient(f.x, 0, f.x, fy);
        lg.addColorStop(0, '#fff2c810');
        lg.addColorStop(1, '#fff2c838');
        ctx.fillStyle = lg;
        ctx.beginPath();
        ctx.moveTo(f.x - 14, 0);
        ctx.lineTo(f.x + 14, 0);
        ctx.lineTo(f.x + 46, fy + 4);
        ctx.lineTo(f.x - 46, fy + 4);
        ctx.closePath();
        ctx.fill();
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
      ctx.fillText(`${teamMode ? TEAM_BADGE[teamOf(i)] + ' ' : ''}${f.name}`, f.x, fy - 34);
      ctx.fillStyle = '#0008';
      ctx.fillRect(f.x - 20, fy - 32, 40, 5);
      ctx.fillStyle = f.hp > 50 ? '#7fe089' : f.hp > 25 ? '#ffd060' : '#ff5a5a';
      ctx.fillRect(f.x - 20, fy - 32, 40 * f.hp / WA_HP, 5);
    }

    // aiming UI for the acting local player
    if (myTurn()) {
      const me = fighters[myIdx()];
      const wp = WEAPONS[weapon];
      if (wp.special === 'tp') {
        // ghost soldier at the destination
        ctx.globalAlpha = 0.5 + 0.2 * Math.sin(now / 200);
        ctx.fillStyle = '#b090ff';
        ctx.beginPath();
        ctx.ellipse(mouseX, mouseY - 9, 9, 11, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#b090ff88';
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.moveTo(me.x, me.y - 10);
        ctx.lineTo(mouseX, mouseY - 10);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (wp.special === 'girder') {
        // beam ghost at the (range-clamped) mouse
        let gx = mouseX, gy = mouseY;
        const gdx = gx - me.x, gdy = gy - (me.y - 10);
        const gdist = Math.hypot(gdx, gdy);
        if (gdist > GIRDER_RANGE) { gx = me.x + gdx / gdist * GIRDER_RANGE; gy = (me.y - 10) + gdy / gdist * GIRDER_RANGE; }
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = '#9aa4b2';
        ctx.fillRect(gx - 60, gy - 7, 120, 14);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#ffffff33';
        ctx.setLineDash([4, 8]);
        ctx.beginPath();
        ctx.arc(me.x, me.y - 10, GIRDER_RANGE, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (wp.special === 'air') {
        // target designator: dashed drop line at the mouse
        ctx.strokeStyle = '#ff5a3a99';
        ctx.setLineDash([10, 10]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(mouseX, 0);
        ctx.lineTo(mouseX, WA_H);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '26px serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('🛩️', mouseX, 40 + Math.sin(now / 300) * 6);
      } else if (!wp.hitscan && weapon !== 3) { // girder handled above; TS narrows it out here
        // trajectory preview — brighter with charge, tinted red near max
        const pow = charge >= 0 ? charge : 0.55;
        const speed = 380 + pow * 720;
        let x = me.x + Math.cos(aimAngle) * 16, y = me.y - 12 + Math.sin(aimAngle) * 16;
        let vx = Math.cos(aimAngle) * speed, vy = Math.sin(aimAngle) * speed;
        for (let s = 0; s < 60; s++) {
          if (wp.wind) vx += wind * 52 * (1 / 60);
          vy += GRAV * gravScale * (1 / 60);
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

    // in-flight shells + fuse countdowns (airstrike flies three at once)
    for (const fl of flights) {
      ctx.strokeStyle = '#ffffff44';
      ctx.lineWidth = 2;
      ctx.beginPath();
      fl.trail.forEach(([x, y], i) => { if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.stroke();
      if (fl.wp === METEOR && imgReady('meteor1')) {
        ctx.save();
        ctx.translate(fl.x, fl.y);
        ctx.rotate(fl.steps * 0.02);
        const m = fl.steps % 2 ? ASSETS.meteor1 : ASSETS.meteor1; // big rock, tumbling
        ctx.drawImage(m, -22, -18, 44, 36);
        ctx.restore();
      } else {
        ctx.font = '22px serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(fl.wp.icon, fl.x, fl.y);
      }
      if (fl.wp.fuseMs > 0) {
        const sLeft = Math.max(0, fl.fuse);
        ctx.font = '800 17px ui-monospace, monospace';
        ctx.fillStyle = sLeft < 1 ? '#ff5a3a' : '#ffd060';
        ctx.fillText(sLeft.toFixed(1), fl.x, fl.y - 24);
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

    // explosion flashes — additive expanding rings
    for (const flh of flashes) {
      flh.life += 1 / 60;
      const t = flh.life / 0.32;
      if (t >= 1) continue;
      ctx.globalCompositeOperation = 'lighter';
      const rg = ctx.createRadialGradient(flh.x, flh.y, 0, flh.x, flh.y, flh.r * (0.4 + t * 0.6));
      rg.addColorStop(0, `rgba(255, 240, 200, ${0.9 * (1 - t)})`);
      rg.addColorStop(0.5, `rgba(255, 150, 60, ${0.5 * (1 - t)})`);
      rg.addColorStop(1, 'rgba(255, 80, 20, 0)');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(flh.x, flh.y, flh.r * (0.4 + t * 0.6), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    flashes = flashes.filter((flh) => flh.life < 0.32);

    // water on top (things sink INTO it) — reddens as sudden death squeezes the map
    const sudden = turnCount > SUDDEN_DEATH_ROUNDS * Math.max(2, fighters.length);
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
    // moonlight shimmer
    ctx.fillStyle = '#ffffff22';
    for (let i = 0; i < 14; i++) {
      const sx = (WA_W * 0.7 + i * 37 + Math.sin(now / 700 + i) * 20) % WA_W;
      ctx.fillRect(sx, waterY + 14 + (i % 3) * 9, 14 + (i % 4) * 6, 2);
    }

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
        const ammo = WEAPONS[w].ammo >= 0 ? `×${fighters[myIdx()].ammo[w]}` : '';
        const label = `${w + 1} ${wp.icon} ${wp.name}${ammo}`;
        ctx.font = '800 15px ui-monospace, monospace';
        const tw = ctx.measureText(label).width + 18;
        const sel = w === weapon;
        const dead = WEAPONS[w].ammo >= 0 && fighters[myIdx()].ammo[w] <= 0;
        ctx.fillStyle = sel ? '#241a0acc' : '#00000088';
        ctx.fillRect(wx, 12, tw, 28);
        if (sel) { ctx.strokeStyle = '#ffd060'; ctx.lineWidth = 2; ctx.strokeRect(wx, 12, tw, 28); }
        ctx.fillStyle = dead ? '#665' : sel ? '#ffd060' : '#a08a5a';
        ctx.fillText(label, wx + 9, 18);
        wx += tw + 8;
      }
    }
    // team panels: rosters + HP at a glance, pinned to the top corners
    if (teamMode && fighters.length) {
      for (const t of [0, 1] as const) {
        const members = fighters.map((f, i) => ({ f, i })).filter(({ i }) => teamOf(i) === t);
        const px = t === 0 ? 16 : WA_W - 246;
        const py = 62;
        ctx.fillStyle = '#00000088';
        ctx.fillRect(px, py, 230, 26 + members.length * 24);
        ctx.fillStyle = TEAM_COLORS[t][0];
        ctx.font = '800 14px ui-monospace, monospace';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(TEAM_NAMES[t], px + 10, py + 6);
        members.forEach(({ f }, k) => {
          const my = py + 28 + k * 24;
          ctx.fillStyle = f.alive ? f.color : '#555c66';
          ctx.font = '700 12px ui-monospace, monospace';
          ctx.fillText(f.alive ? f.name.slice(0, 14) : `☠ ${f.name.slice(0, 12)}`, px + 10, my);
          ctx.fillStyle = '#00000088';
          ctx.fillRect(px + 138, my + 2, 82, 8);
          ctx.fillStyle = f.alive ? f.color : '#333940';
          ctx.fillRect(px + 138, my + 2, 82 * f.hp / WA_HP, 8);
        });
      }
    }
    // shotgun: second shell standing by
    if (turnPi === myIdx() && pelletsUsed === 1 && !hasFired && matchWinner === -2) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.font = '900 24px ui-monospace, monospace';
      ctx.fillStyle = '#ffd060';
      ctx.shadowColor = '#ffd060'; ctx.shadowBlur = 12;
      ctx.fillText('🔫 ONE SHELL LEFT', WA_W / 2, 70);
      ctx.shadowBlur = 0;
    }
    // RETREAT countdown for the shooter who's scrambling
    if (hasFired && now < retreatUntil && turnPi === myIdx() && fighters[turnPi]?.alive && matchWinner === -2) {
      const left = (retreatUntil - now) / 1000;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.font = '900 30px ui-monospace, monospace';
      ctx.fillStyle = left < 1.5 ? '#ff5a3a' : '#ffd060';
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 16;
      ctx.fillText(`RETREAT! ${left.toFixed(1)}`, WA_W / 2, 70);
      ctx.shadowBlur = 0;
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
