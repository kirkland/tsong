// Street Demons: Grand Prix — a 4-player pseudo-3D arcade racer, launched from tsong's arcade.
//
// Early-Mario-Kart / F-Zero styling: a "Mode 7"-flavoured floor-cast ground plane viewed from
// behind-and-above the car (NOT a bird's-eye view), on a neon ribbon of track floating in the sky.
// Boost strips (auto-placed on each circuit's straights) refill your energy and slingshot you
// forward; scraping the guard rails slows you and drains energy; run out of energy and your demon
// RETIRES in a fireball.
//
// It's a proper GRAND PRIX: four real-circuit silhouettes raced back-to-back —
//   1. Autodromo Enzo e Dino Ferrari (Imola, Italy)   2. AVUS (Berlin, Germany)
//   3. Aintree (Liverpool, UK)                        4. Autódromo Hermanos Rodríguez (Mexico)
// Points are scored each race (10-6-3-1) and the demon with the most points after four courses is
// the champion. In the lobby you pick an F1 team and race in its livery.
//
// Handling is the SAME arcade-drift model as the drivable cars in tsong's open world (world.ts):
// throttle thrusts along the heading, steering rotates it (more authority the faster you go), and
// the velocity's sideways component is bled off by grip each frame. Grip is set low so DRIFT IS
// ALWAYS ON — every corner is a slide.
//
// Like Nuketown/DOOM it's deliberately isolated — its own fullscreen overlay, canvas, input
// handlers and game loop, all torn down on exit, never touching the Pong state. Netcode is
// host-authoritative over the server's dumb sr* broadcast relay: slot 0 (the first joiner) is the
// host. It simulates EVERY car — its own from local input, other humans from their relayed input,
// and fills any empty grid slots with bots — then streams `{t:'st'}` world snapshots ~20/s.
// Guests send `{t:'in'}` input ~30/s and render the host's world from their own car's POV.
//
// Rendering runs at a chunky internal resolution and is CSS-upscaled (pixelated) for the retro
// look. The track is an arbitrary closed centreline; a precomputed distance field lets the floor
// caster answer "how far from the ribbon is this pixel, and how far round the lap?" in O(1).

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

// --- track sampling / distance-field constants ---
const NSAMP = 360;     // centreline samples (uniform arc-length) per circuit
const TARGET = 145;    // each circuit is scaled so its longest dimension is this many world units
const HALF = 9;        // track half-width, world units (|dist to centreline| <= HALF is on-track)
const CELL = 1.4;      // distance-field cell size, world units
const MARGIN = HALF + 6; // how far past the track edge the field grid extends
const LAPS = 3;        // laps per course

// --- Grand Prix scoring ---
const GP_POINTS = [10, 6, 3, 1]; // points for finishing P1..P4
const INTERMISSION = 6.5;        // seconds of results screen between courses

// --- physics tuning (ported from world.ts's drivable cars, retuned to this world scale) ---
const MAX_SPD = 60;      // top forward speed, world units / s
const BOOST_SPD = 88;    // top speed while boosting
const ACCEL = 46;        // thrust along the heading, units / s²
const TURN = 2.9;        // steering rate, rad/s at full authority
const AUTH_SPD = 14;     // speed at which steering reaches full authority (no pivoting in place)
const GRIP = 0.93;       // lateral velocity RETAINED per frame — high = long slides (drift always on)
const FWD_DRAG = 0.992;  // mild forward rolling drag per frame
const REV_FRAC = 0.45;   // reverse top speed as a fraction of MAX_SPD
const BOOST_ACCEL = 70;  // extra thrust while the afterburner is lit
const BOOST_HEAL = 30;   // energy/sec regained on a boost strip
const WALL_DPS = 30;     // energy/sec drained while grinding a rail
const WALL_SLOW = 0.88;  // velocity multiplier applied on a rail hit
const HEALTH_MAX = 100;
const COUNTDOWN = 3.2;   // seconds of "3 · 2 · 1 · GO"
const ROCKET_WINDOW = 0.5; // hold throttle within this many seconds of GO for a launch boost

// --- F1 teams (2026 grid — including Audi and Cadillac). Pick one in the lobby; you race its
// livery colour. ---
interface Team { id: string; name: string; color: string; flag: string; }
const TEAMS: Team[] = [
  { id: 'ferrari',  name: 'Ferrari',      color: '#ff2800', flag: '🇮🇹' },
  { id: 'mclaren',  name: 'McLaren',      color: '#ff8000', flag: '🇬🇧' },
  { id: 'redbull',  name: 'Red Bull',     color: '#2748d8', flag: '🇦🇹' },
  { id: 'mercedes', name: 'Mercedes',     color: '#00d7b6', flag: '🇩🇪' },
  { id: 'aston',    name: 'Aston Martin', color: '#00a884', flag: '🇬🇧' },
  { id: 'alpine',   name: 'Alpine',       color: '#3aa0e2', flag: '🇫🇷' },
  { id: 'williams', name: 'Williams',     color: '#4aa8ff', flag: '🇬🇧' },
  { id: 'rb',       name: 'Racing Bulls', color: '#7a6cff', flag: '🇮🇹' },
  { id: 'haas',     name: 'Haas',         color: '#e6e8ea', flag: '🇺🇸' },
  { id: 'audi',     name: 'Audi',         color: '#8a1538', flag: '🇩🇪' },
  { id: 'cadillac', name: 'Cadillac',     color: '#c9a44c', flag: '🇺🇸' },
];
function teamById(id: string | null | undefined): Team | null {
  return TEAMS.find((t) => t.id === id) ?? null;
}

const BOT_NAMES = ['ROAD-HOG', 'NITRO-NUN', 'V8 VANDAL', 'GHOST RIDER', 'TURBO TINA', 'MAX REV', 'DIESEL'];
const DEFAULT_COLORS = ['#ff3b3b', '#3ba6ff', '#ffd23b', '#5dff8f']; // per-slot fallback if no team

// --- the four Grand Prix courses. `pts` is a hand-authored control polygon tracing each circuit's
// silhouette (arbitrary units, closed loop, race direction = the order given); it's smoothed with a
// centripetal Catmull-Rom spline, resampled to a uniform arc-length centreline, then scaled to fit
// TARGET. The finish line sits at the first control point. ---
interface TrackDef {
  name: string; country: string; flag: string; cheer: string; homeTeam: string | null;
  pts: [number, number][];
}
const TRACKS: TrackDef[] = [
  {
    name: 'IMOLA', country: 'Autodromo Enzo e Dino Ferrari · Italy', flag: '🇮🇹',
    cheer: 'FORZA! 🐎', homeTeam: 'ferrari',
    pts: [[18, -70], [23, -34], [21, 6], [15, 40], [3, 64], [-15, 61], [-27, 42],
          [-20, 20], [-30, -2], [-25, -30], [-32, -52], [-16, -68], [1, -72]],
  },
  {
    name: 'AVUS', country: 'AVUS · Berlin, Germany', flag: '🇩🇪',
    cheer: 'SEHR SCHNELL! ⚡', homeTeam: 'audi',
    pts: [[25, -82], [25, -40], [25, 0], [25, 40], [25, 80], [19, 90], [0, 94], [-19, 90],
          [-25, 80], [-25, 40], [-25, 0], [-25, -40], [-25, -78], [-15, -92], [0, -95], [15, -91]],
  },
  {
    name: 'AINTREE', country: 'Aintree · Liverpool, UK', flag: '🇬🇧',
    cheer: 'SMASHING! 🏇', homeTeam: 'aston',
    pts: [[-58, -34], [0, -46], [58, -38], [73, -4], [58, 32], [18, 49], [-22, 45], [-58, 34], [-72, 2]],
  },
  {
    name: 'MEXICO', country: 'Autódromo Hermanos Rodríguez · Mexico', flag: '🇲🇽',
    cheer: '¡VIVA MÉXICO! 🌵', homeTeam: null,
    pts: [[-70, -40], [-25, -49], [30, -48], [60, -42], [72, -12], [66, 20], [50, 44], [24, 50],
          [2, 46], [-10, 30], [4, 17], [-8, 7], [-22, 20], [-42, 44], [-63, 39], [-73, 8]],
  },
];

// A fully-baked circuit ready to race + render.
interface Track {
  def: TrackDef;
  N: number;
  px: Float32Array; py: Float32Array; // centreline points (uniform arc length)
  boost: Uint8Array;                  // 1 where a boost strip lies
  // distance field (nearest-centreline lookup)
  gminX: number; gminY: number; gw: number; gh: number;
  fd: Float32Array; fu: Float32Array; fs: Int8Array; // distance, lap-fraction u∈[0,1), side sign
}

// centripetal Catmull-Rom through a closed control polygon → dense polyline
function catmullClosed(pts: [number, number][], seg: number): [number, number][] {
  const n = pts.length;
  const out: [number, number][] = [];
  const tj = (ti: number, a: [number, number], b: [number, number]) =>
    ti + Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])); // alpha = 0.5 (centripetal)
  const lerp = (a: [number, number], b: [number, number], ta: number, tb: number, t: number): [number, number] => {
    if (tb === ta) return a;
    const w = (t - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  };
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const t0 = 0, t1 = tj(t0, p0, p1), t2 = tj(t1, p1, p2), t3 = tj(t2, p2, p3);
    for (let s = 0; s < seg; s++) {
      const t = t1 + (t2 - t1) * (s / seg);
      const a1 = lerp(p0, p1, t0, t1, t), a2 = lerp(p1, p2, t1, t2, t), a3 = lerp(p2, p3, t2, t3, t);
      const b1 = lerp(a1, a2, t0, t2, t), b2 = lerp(a2, a3, t1, t3, t);
      out.push(lerp(b1, b2, t1, t2, t));
    }
  }
  return out;
}

// uniform arc-length resample of a closed polyline into exactly N points
function resampleClosed(poly: [number, number][], N: number): [number, number][] {
  const m = poly.length;
  const seglen: number[] = []; let total = 0;
  for (let i = 0; i < m; i++) { const a = poly[i], b = poly[(i + 1) % m]; const d = Math.hypot(b[0] - a[0], b[1] - a[1]); seglen.push(d); total += d; }
  const step = total / N;
  const out: [number, number][] = [];
  for (let k = 0; k < N; k++) {
    const target = k * step;
    let run = 0, j = 0;
    while (j < m - 1 && run + seglen[j] < target) { run += seglen[j]; j++; }
    const t = seglen[j] ? (target - run) / seglen[j] : 0;
    const a = poly[j], b = poly[(j + 1) % m];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

// Bake a TrackDef into a ready-to-race Track: smooth, resample, scale-to-fit, auto-place boost
// strips on the two longest straights, and build the nearest-centreline distance field.
function buildTrack(def: TrackDef): Track {
  const dense = catmullClosed(def.pts, 24);
  const samp = resampleClosed(dense, NSAMP);
  // scale so the longest dimension is TARGET, centred on the origin
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const p of samp) { if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0]; if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1]; }
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  const scale = TARGET / Math.max(maxx - minx, maxy - miny);
  const px = new Float32Array(NSAMP), py = new Float32Array(NSAMP);
  for (let i = 0; i < NSAMP; i++) { px[i] = (samp[i][0] - cx) * scale; py[i] = (samp[i][1] - cy) * scale; }

  // --- boost strips: light up the two longest low-curvature runs (the straights) ---
  const hd = new Float32Array(NSAMP);
  for (let i = 0; i < NSAMP; i++) hd[i] = Math.atan2(py[(i + 1) % NSAMP] - py[i], px[(i + 1) % NSAMP] - px[i]);
  const straight: boolean[] = new Array(NSAMP);
  const WIN = 7, THR = 0.16;
  for (let i = 0; i < NSAMP; i++) {
    let s = 0;
    for (let k = -WIN; k < WIN; k++) {
      let d = hd[(i + k + 1 + NSAMP) % NSAMP] - hd[(i + k + NSAMP) % NSAMP];
      while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      s += Math.abs(d);
    }
    const u = i / NSAMP;
    straight[i] = s < THR && u >= 0.05 && u <= 0.95; // keep the start/finish straight boost-free
  }
  const boost = new Uint8Array(NSAMP);
  let start = 0; for (let i = 0; i < NSAMP; i++) if (!straight[i]) { start = i; break; }
  const runs: number[][] = []; let cur: number[] = [];
  for (let step = 0; step < NSAMP; step++) {
    const j = (start + step) % NSAMP;
    if (straight[j]) cur.push(j);
    else { if (cur.length >= 14) runs.push(cur); cur = []; }
  }
  if (cur.length >= 14) runs.push(cur);
  runs.sort((a, b) => b.length - a.length);
  for (const r of runs.slice(0, 2)) {
    const a = r.length >> 2, b = r.length - (r.length >> 2);
    for (let k = a; k < b; k++) boost[r[k]] = 1;
  }

  // --- distance field (bbox in the final scaled/centred space) ---
  let sminx = Infinity, smaxx = -Infinity, sminy = Infinity, smaxy = -Infinity;
  for (let i = 0; i < NSAMP; i++) { if (px[i] < sminx) sminx = px[i]; if (px[i] > smaxx) smaxx = px[i]; if (py[i] < sminy) sminy = py[i]; if (py[i] > smaxy) smaxy = py[i]; }
  const fx0 = sminx - MARGIN, fy0 = sminy - MARGIN;
  const gw = Math.ceil((smaxx - sminx + 2 * MARGIN) / CELL) + 2;
  const gh = Math.ceil((smaxy - sminy + 2 * MARGIN) / CELL) + 2;
  const fd = new Float32Array(gw * gh), fu = new Float32Array(gw * gh), fs = new Int8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const wy = fy0 + (gy + 0.5) * CELL;
    for (let gx = 0; gx < gw; gx++) {
      const wx = fx0 + (gx + 0.5) * CELL;
      let best = Infinity, bi = 0;
      for (let i = 0; i < NSAMP; i++) { const dx = px[i] - wx, dy = py[i] - wy; const d2 = dx * dx + dy * dy; if (d2 < best) { best = d2; bi = i; } }
      const idx = gy * gw + gx;
      fd[idx] = Math.sqrt(best);
      fu[idx] = bi / NSAMP;
      const tx = px[(bi + 1) % NSAMP] - px[bi], ty = py[(bi + 1) % NSAMP] - py[bi];
      fs[idx] = (tx * (wy - py[bi]) - ty * (wx - px[bi])) >= 0 ? 1 : -1;
    }
  }
  return { def, N: NSAMP, px, py, boost, gminX: fx0, gminY: fy0, gw, gh, fd, fu, fs };
}

// Bilinear distance + nearest lap-fraction/side at a world point (for the floor caster).
function fieldAt(t: Track, wx: number, wy: number): { d: number; u: number; side: number } {
  let cxf = (wx - t.gminX) / CELL - 0.5, cyf = (wy - t.gminY) / CELL - 0.5;
  let gx = Math.floor(cxf), gy = Math.floor(cyf);
  if (gx < 0) gx = 0; if (gy < 0) gy = 0; if (gx > t.gw - 2) gx = t.gw - 2; if (gy > t.gh - 2) gy = t.gh - 2;
  const tx = Math.min(1, Math.max(0, cxf - gx)), ty = Math.min(1, Math.max(0, cyf - gy));
  const i = gy * t.gw + gx;
  const d00 = t.fd[i], d10 = t.fd[i + 1], d01 = t.fd[i + t.gw], d11 = t.fd[i + t.gw + 1];
  const d = (d00 * (1 - tx) + d10 * tx) * (1 - ty) + (d01 * (1 - tx) + d11 * tx) * ty;
  const ni = (ty < 0.5 ? gy : gy + 1) * t.gw + (tx < 0.5 ? gx : gx + 1);
  return { d, u: t.fu[ni], side: t.fs[ni] };
}

// Exact nearest point on the centreline (for the handful of cars) — projects onto the two segments
// adjacent to the nearest vertex for a smooth foot. Returns the foot, distance, lap-fraction u,
// which side of the ribbon the car is on, and the local track tangent angle.
function nearestOnTrack(t: Track, x: number, y: number): { cx: number; cy: number; d: number; u: number; side: number; tan: number } {
  let best = Infinity, bi = 0;
  for (let i = 0; i < t.N; i++) { const dx = t.px[i] - x, dy = t.py[i] - y; const d2 = dx * dx + dy * dy; if (d2 < best) { best = d2; bi = i; } }
  let fd2 = Infinity, fx = t.px[bi], fy = t.py[bi], fu = bi, ftx = 1, fty = 0;
  for (const s of [(bi - 1 + t.N) % t.N, bi]) {
    const ax = t.px[s], ay = t.py[s], bx = t.px[(s + 1) % t.N], by = t.py[(s + 1) % t.N];
    const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey || 1;
    let tt = ((x - ax) * ex + (y - ay) * ey) / l2; tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
    const fxx = ax + ex * tt, fyy = ay + ey * tt;
    const dd = (x - fxx) * (x - fxx) + (y - fyy) * (y - fyy);
    if (dd < fd2) { fd2 = dd; fx = fxx; fy = fyy; fu = s + tt; ftx = ex; fty = ey; }
  }
  const d = Math.sqrt(fd2);
  const u = (((fu % t.N) + t.N) % t.N) / t.N;
  const cross = ftx * (y - fy) - fty * (x - fx);
  return { cx: fx, cy: fy, d, u, side: cross >= 0 ? 1 : -1, tan: Math.atan2(fty, ftx) };
}
function centreAt(t: Track, u: number): { x: number; y: number } {
  const idx = ((Math.floor(((u % 1) + 1) % 1 * t.N) % t.N) + t.N) % t.N;
  return { x: t.px[idx], y: t.py[idx] };
}
function boostAtU(t: Track, u: number): boolean {
  const idx = ((Math.floor(((u % 1) + 1) % 1 * t.N) % t.N) + t.N) % t.N;
  return t.boost[idx] === 1;
}
function isFinishU(u: number): boolean { return u < 0.012 || u > 0.988; }

function escapeText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

// A racer. The host owns the canonical array; guests mirror it from snapshots (and smooth it).
interface Car {
  slot: number;
  name: string;
  color: string;
  teamId: string | null;
  bot: boolean;
  x: number; y: number; angle: number; speed: number; // speed = forward speed (display/bot/engine)
  vx: number; vy: number;   // host-only velocity vector (drives the drift physics)
  health: number;
  crossings: number;   // finish-line passes (1 = the start; LAPS+1 = finished)
  passedHalf: boolean; // crossed the far side since the last finish pass (anti-cheese)
  prevU: number;
  progressCont: number; // continuous, unwrapped lap progress for ranking
  lapMark: number;      // floor(progressCont) at the last lap-boundary check
  progress: number;     // = progressCont, mirrored into snapshots for guest ranking
  alive: boolean;
  finished: boolean;
  place: number;       // finishing place THIS race (0 = unset)
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
  end(winner: number): void; // (host only) champion slot so the server can pay the racer (-1 = bot)
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

  // team pick, propagated peer-to-peer over the relay channel (the server lobby is team-agnostic).
  let myTeam: string | null = null;
  const slotTeams: (string | null)[] = [null, null, null, null];

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
    'white-space:pre;pointer-events:none;line-height:1.15;';
  overlay.appendChild(banner);

  // --- menu / lobby layer ---
  const menu = document.createElement('div');
  menu.style.cssText =
    'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:safe center;gap:16px;padding:3vh 16px;overflow-y:auto;' +
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
    'max-width:560px;font:600 13px ui-monospace,monospace;color:#9fb0d8;line-height:1.7;text-align:center;';
  menuInfo.innerHTML =
    '<div style="color:#cdd7f5;font-weight:700;margin-bottom:4px">FOUR-COURSE GRAND PRIX · ' + LAPS + ' LAPS EACH</div>' +
    '<span style="color:#ffd23b">Imola</span> → <span style="color:#ffd23b">AVUS</span> → ' +
    '<span style="color:#ffd23b">Aintree</span> → <span style="color:#ffd23b">México</span>. ' +
    'Score 10-6-3-1 each race; most points after four courses takes the title. Empty grid slots fill ' +
    'with <b>demon bots</b>. Ride the <span style="color:#19d2ff">boost strips</span> on the straights to ' +
    'refill energy and rocket forward; scrape the <span style="color:#ff5c5c">rails</span> and you bleed ' +
    'energy and bog down. Hit <b>zero energy</b> and your demon <span style="color:#ff5c5c">RETIRES</span>. ' +
    '<b>Drift is always on</b> — every corner is a slide.' +
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
  const startBtn = mkBtn('START GRAND PRIX');
  const leaveBtn = mkBtn('LEAVE');
  const exitBtn = mkBtn('EXIT');
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;justify-content:center;';
  btnRow.append(joinBtn, startBtn, leaveBtn, exitBtn);

  // --- team picker (shown in the lobby) ---
  const teamTitle = document.createElement('div');
  teamTitle.textContent = 'PICK YOUR TEAM';
  teamTitle.style.cssText = 'font:700 13px ui-monospace,monospace;color:#9fd8ff;letter-spacing:3px;text-shadow:1px 1px 0 #000;';
  const teamGrid = document.createElement('div');
  teamGrid.style.cssText = 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap;max-width:640px;';
  const teamBtns = new Map<string, HTMLButtonElement>();
  for (const tm of TEAMS) {
    const b = document.createElement('button');
    b.innerHTML = `${tm.flag} ${escapeText(tm.name)}`;
    b.style.cssText =
      `font:700 12px ui-monospace,monospace;padding:8px 11px;border-radius:7px;cursor:pointer;` +
      `border:2px solid ${tm.color};background:rgba(0,0,0,0.35);color:${tm.color};transition:all 90ms;`;
    b.onclick = () => pickTeam(tm.id);
    teamBtns.set(tm.id, b);
    teamGrid.appendChild(b);
  }
  const teamWrap = document.createElement('div');
  teamWrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;';
  teamWrap.append(teamTitle, teamGrid);

  const roster = document.createElement('div');
  roster.style.cssText =
    'display:flex;gap:14px;justify-content:center;flex-wrap:wrap;min-height:44px;font:700 14px ui-monospace,monospace;text-shadow:1px 1px 0 #000;';
  menu.append(menuTitle, menuSub, menuMsg, btnRow, teamWrap, roster, menuInfo);
  overlay.appendChild(menu);
  document.body.appendChild(overlay);

  function pickTeam(id: string) {
    myTeam = id;
    slotTeams[selfSlot] = id;
    for (const [tid, b] of teamBtns) {
      const on = tid === id;
      b.style.transform = on ? 'scale(1.08)' : 'scale(1)';
      b.style.background = on ? teamById(tid)!.color : 'rgba(0,0,0,0.35)';
      b.style.color = on ? '#05060f' : teamById(tid)!.color;
    }
    net.relay({ t: 'team', slot: selfSlot, team: id });
    renderRoster();
  }

  function renderRoster() {
    const ps = lobbyState?.players ?? [];
    const cells = Array.from({ length: 4 }, (_, i) => {
      const p = ps[i];
      const tm = teamById(slotTeams[i]);
      const col = tm ? tm.color : DEFAULT_COLORS[i];
      const who = p ? `${escapeText(p.name)}${i === 0 ? ' 👑' : ''}` : '<span style="opacity:0.5">demon bot</span>';
      const teamLine = tm ? `<div style="font-size:10px;color:${col}">${tm.flag} ${escapeText(tm.name)}</div>` : '';
      return `<div style="border:2px solid ${col};border-radius:8px;padding:8px 12px;min-width:120px;background:rgba(0,0,0,0.35)">` +
        `<div style="color:${col};font-size:11px">P${i + 1}</div>${who}${teamLine}</div>`;
    });
    roster.innerHTML = cells.join('');
  }

  function syncMenuButtons() {
    joinBtn.style.display = mode === 'menu' ? '' : 'none';
    exitBtn.style.display = mode === 'menu' ? '' : 'none';
    leaveBtn.style.display = mode === 'lobby' ? '' : 'none';
    teamWrap.style.display = mode === 'lobby' ? 'flex' : 'none';
    const isLeader = selfSlot === 0;
    startBtn.style.display = mode === 'lobby' && isLeader ? '' : 'none';
    if (mode === 'lobby') {
      const n = lobbyState?.players.length ?? 1;
      menuMsg.textContent = isLeader
        ? `You're on pole — START when ready (${n} human${n === 1 ? '' : 's'}, ${4 - n} bot${4 - n === 1 ? '' : 's'}).`
        : `On the grid (${n}/4) — waiting for the host to drop the lights…`;
    }
  }

  // --- world / Grand Prix state ---
  let track: Track = buildTrack(TRACKS[0]);
  let trackIdx = 0;
  let cars: Car[] = [];
  let phase: 'countdown' | 'race' | 'done' = 'countdown';
  let countdown = COUNTDOWN;
  let raceTime = 0;
  let winner = -1;        // winning slot of the CURRENT race
  let finishOrder: number[] = []; // slots in the order they finished this race
  let scored = false;     // did we already award championship points for this race?
  let inter = INTERMISSION; // seconds left on the results screen (host clock)
  let round = 0;          // current course index (0..3)
  let gpOver = false;     // whole Grand Prix concluded
  let championSlot = -1;  // overall champion slot once the GP is over
  const points = [0, 0, 0, 0]; // championship points per slot
  let endReported = false;

  function ensureTrack(idx: number) {
    if (idx !== trackIdx || !track) { trackIdx = idx; track = buildTrack(TRACKS[idx]); }
  }

  // host: latest relayed input per guest slot
  const guestInputs = new Map<number, NetInput>();

  // local input
  const keys = new Set<string>();
  let netAccum = 0;
  let lastHurt = 0;       // local energy, for a red flash when it drops
  let shake = 0;          // screen-shake timer (rail hits / explosions)
  const me = (): Car | undefined => cars.find((c) => c.slot === selfSlot);

  // --- audio (engine drone tracks own speed; plus boost/crash/finish/horn blips) ---
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
      const b = a.createBuffer(1, a.sampleRate * 0.25, a.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
      const src = a.createBufferSource(); src.buffer = b;
      const g = a.createGain(); g.gain.value = 0.3;
      src.connect(g); g.connect(a.destination); src.start();
    } catch { /* ignore */ }
  }

  // ---------- host simulation ----------

  // Place a car on the grid at lap-fraction u with a lateral lane offset (along the track normal).
  function placeOnGrid(c: Car, u: number, lane: number) {
    const idx = ((Math.floor(u * track.N) % track.N) + track.N) % track.N;
    const tx = track.px[(idx + 1) % track.N] - track.px[idx];
    const ty = track.py[(idx + 1) % track.N] - track.py[idx];
    const tl = Math.hypot(tx, ty) || 1;
    const tanx = tx / tl, tany = ty / tl;
    const perpx = -tany, perpy = tanx; // left-hand normal
    c.x = track.px[idx] + perpx * lane;
    c.y = track.py[idx] + perpy * lane;
    c.angle = Math.atan2(tany, tanx);
    c.speed = 0; c.vx = 0; c.vy = 0;
    c.health = HEALTH_MAX;
    c.crossings = 1;
    c.passedHalf = false;
    c.prevU = u;
    c.progressCont = u;
    c.lapMark = Math.floor(u);
    c.progress = u;
    c.alive = true;
    c.finished = false;
    c.place = 0;
    c.boosting = 0;
    c.revHold = 0;
  }

  function buildGrid() {
    const humans = lobbyState?.players ?? [];
    cars = [];
    // two rows of two, just behind the finish line (u just under 1.0)
    const gridU = [0.978, 0.978, 0.968, 0.968];
    const gridLane = [3.6, -3.6, 3.6, -3.6];
    let botIdx = 0;
    for (let slot = 0; slot < 4; slot++) {
      const human = humans[slot];
      const teamId = human ? (slotTeams[slot] ?? TEAMS[slot % TEAMS.length].id)
        : TEAMS[(slot * 3 + 2) % TEAMS.length].id; // bots get liveries too
      const tm = teamById(teamId);
      const c: Car = {
        slot,
        name: human ? human.name : BOT_NAMES[botIdx % BOT_NAMES.length],
        teamId,
        color: tm ? tm.color : DEFAULT_COLORS[slot],
        bot: !human,
        x: 0, y: 0, angle: 0, speed: 0, vx: 0, vy: 0, health: HEALTH_MAX,
        crossings: 1, passedHalf: false, prevU: 0, progressCont: 0, lapMark: 0, progress: 0,
        alive: true, finished: false, place: 0, boosting: 0,
        skill: 0.55 + (botIdx * 0.09), // bots: a spread of competence (used only when bot)
      };
      if (!human) botIdx++;
      placeOnGrid(c, gridU[slot], gridLane[slot]);
      cars.push(c);
    }
  }

  // Bot driving: aim at a look-ahead point on the centreline and chase it; lift the throttle when
  // badly misaligned (mid-corner) so they don't spin under drift.
  function botInput(c: Car): NetInput {
    const near = nearestOnTrack(track, c.x, c.y);
    const lookAhead = 0.028 + (Math.max(0, c.speed) / MAX_SPD) * 0.03;
    const target = centreAt(track, near.u + lookAhead);
    const want = Math.atan2(target.y - c.y, target.x - c.x);
    let diff = want - c.angle;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    const steer = Math.max(-1, Math.min(1, diff * 1.8));
    const throttle = Math.abs(diff) > 0.5 + c.skill * 0.2 ? 0 : 1; // clumsier demons brake earlier
    return { throttle, steer, held: true };
  }

  // Advance one car by its input for dt seconds — the world.ts drift model, retuned. Mutates c.
  function stepCar(c: Car, inp: NetInput, dt: number) {
    if (!c.alive || c.finished) { c.vx *= 0.9; c.vy *= 0.9; c.speed *= 0.9; return; }

    const sp = Math.hypot(c.vx, c.vy);
    // steering needs speed to bite; near-stationary you can barely turn (no pivoting in place)
    const authority = Math.min(1, sp / AUTH_SPD);
    c.angle += inp.steer * TURN * authority * dt;

    const hx = Math.cos(c.angle), hy = Math.sin(c.angle);
    // thrust along the heading (reverse at 60% power)
    if (c.boosting > 0) { c.vx += hx * BOOST_ACCEL * dt; c.vy += hy * BOOST_ACCEL * dt; c.boosting -= dt; }
    if (inp.throttle !== 0) {
      const power = inp.throttle > 0 ? ACCEL : ACCEL * 0.6;
      c.vx += hx * power * inp.throttle * dt;
      c.vy += hy * power * inp.throttle * dt;
    }

    // split velocity into forward + lateral; bleed the lateral part off by grip → drift
    let fwd = c.vx * hx + c.vy * hy;
    let lat = -c.vx * hy + c.vy * hx;
    lat *= Math.pow(GRIP, dt * 60);
    fwd *= Math.pow(FWD_DRAG, dt * 60);
    const botCap = c.bot ? MAX_SPD * (0.9 + c.skill * 0.06) : MAX_SPD; // bots slightly slower flat-out
    const cap = c.boosting > 0 ? BOOST_SPD : botCap;
    fwd = Math.max(-MAX_SPD * REV_FRAC, Math.min(cap, fwd));
    c.vx = hx * fwd - hy * lat;
    c.vy = hy * fwd + hx * lat;

    // integrate, then resolve the track boundary
    let nx = c.x + c.vx * dt, ny = c.y + c.vy * dt;
    const near = nearestOnTrack(track, nx, ny);
    if (near.d > HALF) {
      // hit a guard rail: shove back onto the ribbon edge, kill the outward velocity, bleed energy
      const dirx = (nx - near.cx) / (near.d || 1), diry = (ny - near.cy) / (near.d || 1);
      nx = near.cx + dirx * HALF; ny = near.cy + diry * HALF;
      const outward = c.vx * dirx + c.vy * diry;
      if (outward > 0) { c.vx -= dirx * outward; c.vy -= diry * outward; }
      c.vx *= WALL_SLOW; c.vy *= WALL_SLOW;
      c.health -= WALL_DPS * dt;
      if (lastRailSfx <= 0) { crashSound(); lastRailSfx = 0.25; }
      if (c.slot === selfSlot) shake = Math.max(shake, 0.18);
    } else if (boostAtU(track, near.u)) {
      c.health = Math.min(HEALTH_MAX, c.health + BOOST_HEAL * dt);
      c.boosting = Math.max(c.boosting, 0.25);
    }
    c.x = nx; c.y = ny;
    c.speed = fwd;

    // lap / finish bookkeeping via continuous unwrapped progress
    const u = near.u;
    let du = u - c.prevU;
    if (du < -0.5) du += 1; else if (du > 0.5) du -= 1;
    c.progressCont += du;
    c.prevU = u;
    c.progress = c.progressCont;
    if (u > 0.45 && u < 0.55) c.passedHalf = true;
    const lapNow = Math.floor(c.progressCont);
    if (lapNow > c.lapMark) {
      if (c.passedHalf) {
        c.crossings++;
        c.passedHalf = false;
        if (c.crossings > LAPS) finishCar(c);
        else if (c.slot === selfSlot) blip(880, 0.12, 'square', 0.2);
      }
      c.lapMark = lapNow;
    }

    if (c.health <= 0 && c.alive) retireCar(c);
  }
  let lastRailSfx = 0;

  function finishCar(c: Car) {
    if (c.finished) return;
    c.finished = true;
    finishOrder.push(c.slot);
    c.place = finishOrder.length;
    c.boosting = 0;
    if (c.place === 1) { winner = c.slot; resolveRace(); }
  }

  function retireCar(c: Car) {
    c.alive = false;
    c.health = 0;
    c.vx = 0; c.vy = 0; c.speed = 0;
    crashSound();
    if (c.slot === selfSlot) shake = Math.max(shake, 0.6);
    explosions.push({ x: c.x, y: c.y, t: 0.7 });
    const live = cars.filter((k) => k.alive && !k.finished);
    if (live.length === 1 && !finishOrder.includes(live[0].slot) && winner < 0) finishCar(live[0]);
    else if (live.length === 0 && winner < 0) resolveRace();
  }

  // Settle the current course, award championship points, and open the intermission clock.
  function resolveRace() {
    if (phase === 'done') return;
    phase = 'done';
    const ranked = cars
      .filter((c) => !finishOrder.includes(c.slot))
      .sort((a, b) => b.progressCont - a.progressCont);
    // mark everyone finished so a same-frame second crossing can't re-enter finishOrder
    for (const c of ranked) { finishOrder.push(c.slot); c.place = finishOrder.length; c.finished = true; }
    if (winner < 0 && finishOrder.length) winner = finishOrder[0];
    if (!scored) {
      scored = true;
      for (const c of cars) if (c.place >= 1 && c.place <= 4) points[c.slot] += GP_POINTS[c.place - 1];
    }
    inter = INTERMISSION;
    blip(660, 0.5, 'triangle', 0.3);
  }

  function computeChampion(): number {
    let best = -1, bestPts = -1, bestPlace = 99;
    for (const c of cars) {
      const p = points[c.slot];
      if (p > bestPts || (p === bestPts && c.place < bestPlace)) { bestPts = p; bestPlace = c.place; best = c.slot; }
    }
    return best;
  }

  interface Explosion { x: number; y: number; t: number; }
  let explosions: Explosion[] = [];

  // ---------- update ----------
  function update(dt: number) {
    if (mode !== 'play') return;
    lastRailSfx = Math.max(0, lastRailSfx - dt);

    if (isHost) hostUpdate(dt);
    else guestUpdate(dt);

    for (let i = explosions.length - 1; i >= 0; i--) { explosions[i].t -= dt; if (explosions[i].t <= 0) explosions.splice(i, 1); }
    if (shake > 0) shake -= dt;

    const hp = me()?.health ?? lastHurt;
    if (hp < lastHurt - 0.5) hurtFlash = 0.4;
    lastHurt = hp;
    if (hurtFlash > 0) hurtFlash -= dt;

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

  // Kick off course `r`: rebuild the track + grid, reset the per-race state, keep the standings.
  function startRound(r: number) {
    round = r;
    ensureTrack(r);
    phase = 'countdown';
    countdown = COUNTDOWN;
    raceTime = 0;
    winner = -1;
    finishOrder = [];
    scored = false;
    inter = INTERMISSION;
    explosions = [];
    buildGrid();
    lastHurt = HEALTH_MAX;
  }

  function hostUpdate(dt: number) {
    raceTime += dt;
    if (phase === 'countdown') {
      // Rocket-start (a trick to discover): nail the gas in the final ROCKET_WINDOW before the
      // lights drop and you launch off the line. Hold it the whole countdown and you just roll off.
      for (const c of cars) {
        const held = c.slot === selfSlot ? readLocalInput().held
          : c.bot ? (countdown < 0.15 + (1 - c.skill) * 0.4)
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
            c.boosting = 1.2;
            c.vx = Math.cos(c.angle) * 26; c.vy = Math.sin(c.angle) * 26; c.speed = 26;
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
    } else if (phase === 'done') {
      // results intermission → next course, or conclude the Grand Prix
      if (!gpOver) {
        inter -= dt;
        if (inter <= 0) {
          if (round < TRACKS.length - 1) startRound(round + 1);
          else {
            gpOver = true;
            championSlot = computeChampion();
            winner = championSlot;
          }
        }
      }
    }

    if (gpOver && !endReported) {
      endReported = true;
      const champ = cars.find((c) => c.slot === championSlot);
      net.end(champ && champ.bot ? -1 : championSlot); // a bot champion pays no one (contract: -1)
    }

    // stream a world snapshot ~20/s
    netAccum += dt;
    if (netAccum >= 0.05) {
      netAccum = 0;
      net.relay({
        t: 'st', phase, countdown, raceTime, winner, round, gpOver, inter,
        points: points.slice(),
        order: finishOrder.slice(),
        cars: cars.map((c) => ({
          slot: c.slot, name: c.name, color: c.color, team: c.teamId, bot: c.bot,
          x: round2(c.x), y: round2(c.y), angle: round3(c.angle), speed: round2(c.speed),
          health: Math.round(c.health), laps: Math.min(c.crossings, LAPS + 1),
          progress: round3(c.progressCont), alive: c.alive, finished: c.finished, place: c.place,
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

    // Camera target: our own car, or once we've retired/finished, spectate the leader.
    const target = (viewer.alive && !viewer.finished)
      ? viewer
      : [...cars].sort((a, b) => b.progress - a.progress)[0] ?? viewer;

    const ca = target.angle;
    const dirX = Math.cos(ca), dirY = Math.sin(ca);
    const rightX = -dirY, rightY = dirX;
    const camX = target.x - dirX * CAM_BACK;
    const camY = target.y - dirY * CAM_BACK;
    const t = raceTime;

    // --- sky + stars ---
    for (let y = 0; y < HORIZON; y++) {
      const c = skyRow[y];
      const row = y * W;
      for (let x = 0; x < W; x++) buf[row + x] = c;
    }
    for (const s of stars) {
      const sx = (s.x + Math.round(ca * 12)) % W;
      const px = ((sx % W) + W) % W;
      buf[s.y * W + px] = pack(s.b, s.b, Math.min(255, s.b + 40));
    }
    const hz = pack(120, 40, 120);
    for (let x = 0; x < W; x++) {
      buf[HORIZON * W + x] = hz;
      buf[(HORIZON - 1) * W + x] = hz;
      if (HORIZON >= 2) buf[(HORIZON - 2) * W + x] = pack(70, 24, 80);
    }

    // --- floor cast ---
    for (let y = HORIZON + 1; y < H; y++) {
      const p = y - HORIZON;
      const depth = (FOCAL * CAM_H) / p;
      const fog = Math.min(1, depth / FAR_FOG);
      const sLeft = (0 - W / 2) * depth / FOCAL;
      const sStep = depth / FOCAL;
      let wx = camX + dirX * depth + rightX * sLeft;
      let wy = camY + dirY * depth + rightY * sLeft;
      const ddx = rightX * sStep, ddy = rightY * sStep;
      const row = y * W;
      for (let x = 0; x < W; x++, wx += ddx, wy += ddy) {
        const f = fieldAt(track, wx, wy);
        let r: number, gr: number, b: number;
        if (f.d > HALF) {
          const dk = 1 - fog * 0.6;
          r = (10 * dk) | 0; gr = (8 * dk) | 0; b = (26 * dk) | 0;
          if (((wx * 0.6 | 0) + (wy * 0.6 | 0)) % 11 === 0) { r += 18; gr += 14; b += 30; }
        } else {
          const u = f.u;
          const edge = f.d / HALF; // 0 centre → 1 rail
          const checker = (((u * 220) | 0) + ((f.d * 3) | 0)) & 1;
          const bv = checker ? 64 : 52;
          r = bv; gr = bv + 4; b = bv + 14;
          if (edge < 0.09 && (((u * 300) | 0) & 1)) { r = 210; gr = 180; b = 60; } // centre dashes
          if (edge > 0.82) {
            const railR = f.side > 0 ? 255 : 90, railG = f.side > 0 ? 80 : 200, railB = f.side > 0 ? 120 : 255;
            const k = (edge - 0.82) / 0.18;
            r = (r * (1 - k) + railR * k) | 0; gr = (gr * (1 - k) + railG * k) | 0; b = (b * (1 - k) + railB * k) | 0;
          }
          if (boostAtU(track, u)) {
            const chev = Math.sin(u * 300 - t * 9) * 0.5 + 0.5;
            r = (r * 0.3 + 20) | 0;
            gr = (gr * 0.3 + 150 + chev * 90) | 0;
            b = (b * 0.3 + 200 + chev * 55) | 0;
          }
          if (isFinishU(u)) {
            const fc = (((f.d * 3) | 0) & 1) ^ ((y >> 1) & 1);
            const v = fc ? 240 : 20; r = v; gr = v; b = v;
          }
          r = (r * (1 - fog) + 80 * fog) | 0;
          gr = (gr * (1 - fog) + 30 * fog) | 0;
          b = (b * (1 - fog) + 90 * fog) | 0;
        }
        buf[row + x] = pack(r, gr, b);
      }
    }
    ctx.putImageData(frame, 0, 0);

    const shx = shake > 0 ? Math.round((Math.random() - 0.5) * 6 * shake) : 0;
    const shy = shake > 0 ? Math.round((Math.random() - 0.5) * 6 * shake) : 0;
    ctx.save();
    ctx.translate(shx, shy);

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

    if (viewer.alive && !viewer.finished) drawSelfCar(viewer);
    ctx.restore();

    if (hurtFlash > 0) {
      ctx.fillStyle = `rgba(255,40,40,${hurtFlash * 0.5})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function projDepth(ox: number, oy: number, cx: number, cy: number, dx: number, dy: number): number {
    return (ox - cx) * dx + (oy - cy) * dy;
  }

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
    const scale = FOCAL / pr.depth;
    // sized so a close rival never dwarfs your own car (capped), and tuned smaller than before
    const w = Math.min(40, Math.max(3, scale * 2.4));
    const h = Math.min(22, Math.max(2, scale * 1.4));
    let rh = c.angle - Math.atan2(dy, dx);
    while (rh > Math.PI) rh -= 2 * Math.PI;
    while (rh < -Math.PI) rh += 2 * Math.PI;
    drawHovercar(pr.sx, pr.sy, w, h, c.color, rh, c.boosting > 0, !c.alive);
    if (pr.depth < 60 && c.alive) {
      ctx.font = '700 7px ui-monospace,monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#000'; ctx.fillText(c.name, pr.sx + 0.6, pr.sy - h - 2.4);
      ctx.fillStyle = c.color; ctx.fillText(c.name, pr.sx, pr.sy - h - 3);
    }
  }

  function drawSelfCar(c: Car) {
    const baseX = W / 2;
    const baseY = H - 8 + Math.sin(raceTime * 8) * 0.6;
    const inp = readLocalInput();
    // drift lean tracks the sideways velocity vs the heading, so a slide visibly cocks the car
    const hx = Math.cos(c.angle), hy = Math.sin(c.angle);
    const lat = -c.vx * hy + c.vy * hx;
    const drift = Math.max(-1, Math.min(1, (lat / MAX_SPD) * 2 + inp.steer * 0.3));
    drawHovercar(baseX + drift * 3, baseY, 44, 23, c.color, drift * 0.4, c.boosting > 0, false);
  }

  function drawHovercar(sx: number, sy: number, w: number, h: number, color: string, rh: number, boost: boolean, dead: boolean) {
    const lean = Math.max(-1, Math.min(1, rh * 1.5));
    ctx.save();
    ctx.translate(sx, sy);
    if (!dead) {
      const fl = boost ? 1 : 0.4;
      const grad = ctx.createRadialGradient(0, -h * 0.1, 1, 0, -h * 0.1, w * 0.7);
      grad.addColorStop(0, boost ? 'rgba(120,220,255,0.9)' : 'rgba(120,160,255,0.5)');
      grad.addColorStop(1, 'rgba(40,80,200,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.ellipse(0, -h * 0.05, w * 0.6, h * 0.45 * fl, 0, 0, Math.PI * 2); ctx.fill();
    }
    if (dead) ctx.globalAlpha = 0.5;
    const skew = lean * w * 0.18;
    ctx.fillStyle = dead ? '#444' : color;
    ctx.beginPath();
    ctx.moveTo(-w * 0.5, -h * 0.05);
    ctx.lineTo(w * 0.5, -h * 0.05);
    ctx.lineTo(w * 0.32 + skew, -h * 0.95);
    ctx.lineTo(-w * 0.32 + skew, -h * 0.95);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = dead ? '#333' : shade(color, -0.35);
    ctx.fillRect(-w * 0.5, -h * 0.35, w * 0.14, h * 0.3);
    ctx.fillRect(w * 0.36, -h * 0.35, w * 0.14, h * 0.3);
    ctx.fillStyle = dead ? '#222' : 'rgba(20,30,50,0.9)';
    ctx.beginPath();
    ctx.moveTo(-w * 0.2 + skew, -h * 0.5);
    ctx.lineTo(w * 0.2 + skew, -h * 0.5);
    ctx.lineTo(w * 0.12 + skew, -h * 0.9);
    ctx.lineTo(-w * 0.12 + skew, -h * 0.9);
    ctx.closePath(); ctx.fill();
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
  function nameFor(slot: number): string {
    const c = cars.find((k) => k.slot === slot);
    return c ? c.name : '?';
  }

  function standingsText(): string {
    return [...points.keys()]
      .sort((a, b) => points[b] - points[a])
      .map((slot, i) => `${i + 1}. ${nameFor(slot)} — ${points[slot]}`)
      .join('\n');
  }

  function syncHud() {
    if (mode !== 'play') { menu.style.display = 'flex'; hud.textContent = ''; posBadge.textContent = ''; energyWrap.style.display = 'none'; energyLabel.style.display = 'none'; return; }
    menu.style.display = 'none';
    const c = me();
    energyWrap.style.display = ''; energyLabel.style.display = '';

    if (phase === 'countdown') {
      const n = Math.ceil(countdown);
      banner.style.display = 'flex'; banner.style.fontSize = '64px';
      banner.style.color = n <= 1 ? '#5dff8f' : '#ffd23b';
      banner.textContent = countdown <= 0 ? 'GO!' : String(Math.min(3, n));
    } else if (phase === 'done' && gpOver) {
      banner.style.display = 'flex'; banner.style.fontSize = '22px';
      const won = championSlot === selfSlot;
      banner.style.color = won ? '#ffd23b' : '#cdd7f5';
      const champ = nameFor(championSlot);
      const champCar = cars.find((k) => k.slot === championSlot);
      const tifosi = champCar?.teamId === 'ferrari' ? '\n🐎 TIFOSI GO WILD 🐎' : '';
      banner.textContent = `🏆 GRAND PRIX CHAMPION 🏆\n${escapeText(champ)}${tifosi}\n\n${standingsText()}\n\nESC to exit`;
    } else if (phase === 'done') {
      banner.style.display = 'flex'; banner.style.fontSize = '22px';
      const myPlace = c?.place ?? 0;
      banner.style.color = winner === selfSlot ? '#ffd23b' : myPlace === 0 ? '#ff5c5c' : '#cdd7f5';
      const ord = finishOrder.map((slot, i) => {
        const medal = ['🥇', '🥈', '🥉', '4️⃣'][i] ?? `${i + 1}.`;
        return `${medal} ${nameFor(slot)}`;
      }).join('\n');
      const nextLine = round < TRACKS.length - 1
        ? `NEXT: ${TRACKS[round + 1].flag} ${TRACKS[round + 1].name}  ·  ${Math.ceil(inter)}s`
        : `FINAL RESULTS  ·  ${Math.ceil(inter)}s`;
      banner.textContent = `${track.def.flag} ${track.def.name} — ${track.def.cheer}\n\n${ord}\n\n— STANDINGS —\n${standingsText()}\n\n${nextLine}`;
    } else {
      banner.style.display = 'none'; banner.style.fontSize = '64px';
    }

    if (c) {
      const lap = Math.min(LAPS, Math.max(1, c.crossings ?? 1));
      const rank = [...cars].sort((a, b) => (b.finished ? 1e9 + (LAPS + 5 - b.place) : b.progress) - (a.finished ? 1e9 + (LAPS + 5 - a.place) : a.progress));
      const pos = rank.findIndex((k) => k.slot === selfSlot) + 1;
      hud.innerHTML =
        `<span style="font-size:13px;color:#ff9ecb">RACE ${round + 1}/${TRACKS.length} · ${track.def.flag} ${track.def.name}</span><br>` +
        `LAP ${lap}/${LAPS}<br><span style="font-size:13px;color:#9fd8ff">${Math.round(Math.abs(c.speed) * 4)} KM/H</span>`;
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
    round = 0;
    gpOver = false;
    championSlot = -1;
    endReported = false;
    points[0] = points[1] = points[2] = points[3] = 0;
    guestInputs.clear();
    netAccum = 0;
    hurtFlash = 0;
    if (isHost) {
      startRound(0);
    } else {
      ensureTrack(0);
      buildGrid();
      for (const c of cars) { c.dx = c.x; c.dy = c.y; c.dAngle = c.angle; }
    }
    lastHurt = HEALTH_MAX;
    startEngine();
    menu.style.display = 'none';
    canvas.focus?.();
  }

  joinBtn.onclick = () => {
    mode = 'lobby'; menuMsg.textContent = 'Joining the grid…'; net.join(); ac().resume?.();
    if (!myTeam) myTeam = TEAMS[0].id; // default to a pick so you always have a livery
  };
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
      else if (m.status === 'waiting' && mode === 'lobby') {
        // (re)assert our team so late joiners + the host learn it, then paint the roster
        if (!myTeam) myTeam = TEAMS[selfSlot % TEAMS.length].id;
        slotTeams[selfSlot] = myTeam;
        pickTeam(myTeam);
        renderRoster();
        syncMenuButtons();
      }
    },
    relay: (d) => {
      const msg = d as { t?: string } & Record<string, unknown>;
      // team picks flow even before the race starts
      if (msg.t === 'team') {
        const s = Number(msg.slot);
        if (Number.isFinite(s) && s >= 0 && s < 4) { slotTeams[s] = String(msg.team); renderRoster(); }
        return;
      }
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
          round: number; gpOver: boolean; inter: number; points: number[]; order: number[];
          cars: Array<Car & { laps: number; boosting: number; team: string | null }>;
          boom: { x: number; y: number }[];
        };
        phase = st.phase; countdown = st.countdown; raceTime = st.raceTime; winner = st.winner;
        round = st.round; gpOver = st.gpOver; inter = st.inter;
        if (Array.isArray(st.points)) for (let i = 0; i < 4; i++) points[i] = st.points[i] ?? 0;
        if (gpOver) championSlot = st.winner;
        finishOrder = st.order ?? [];
        ensureTrack(round);
        const bySlot = new Map(cars.map((c) => [c.slot, c] as [number, Car]));
        cars = st.cars.map((nc) => {
          const ex = bySlot.get(nc.slot);
          const c: Car = ex ?? {
            slot: nc.slot, name: nc.name, color: nc.color, teamId: nc.team ?? null, bot: nc.bot,
            x: nc.x, y: nc.y, angle: nc.angle, speed: nc.speed, vx: 0, vy: 0, health: nc.health,
            crossings: nc.laps, passedHalf: false, prevU: 0, progressCont: nc.progress, lapMark: 0,
            progress: nc.progress, alive: nc.alive, finished: nc.finished, place: nc.place,
            boosting: nc.boosting, skill: 1,
          };
          c.name = nc.name; c.color = nc.color; c.teamId = nc.team ?? null; c.bot = nc.bot;
          c.speed = nc.speed; c.health = nc.health; c.crossings = nc.laps; c.progress = nc.progress;
          c.alive = nc.alive; c.finished = nc.finished; c.place = nc.place; c.boosting = nc.boosting;
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
    if (k === 'h' && mode === 'play') blip(180 + Math.random() * 40, 0.22, 'square', 0.22); // horn 📣
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
function shade(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const adj = (v: number) => Math.max(0, Math.min(255, Math.round(v + amt * 255)));
  const r = adj(parseInt(m[1], 16)), g = adj(parseInt(m[2], 16)), b = adj(parseInt(m[3], 16));
  return `rgb(${r},${g},${b})`;
}
