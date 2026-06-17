// Generates client/public/cracked-glass.png — a transparent cracked-glass overlay used
// by the MONITOR_BREAK fatality. No image libraries are available, so we rasterize the
// crack pattern into an RGBA buffer by hand and encode a PNG with Node's built-in zlib.
// Deterministic (seeded PRNG) so re-running reproduces the same shatter.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const W = 1600;
const H = 1000;
const buf = new Uint8Array(W * H * 4); // RGBA, all zero (fully transparent) to start

// --- tiny seeded PRNG (mulberry32) ---
let seed = 0x9e3779b9;
function rnd() {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Blend an additive light stroke into the buffer at (x,y). Glass cracks read as bright
// white/cyan highlights with a soft falloff; we max-blend so overlapping strokes don't
// blow out into hard edges.
function light(x, y, a, r, g, b) {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
  const i = (yi * W + xi) * 4;
  const cur = buf[i + 3] / 255;
  const na = Math.max(cur, Math.min(1, a));
  if (na <= cur) return;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
  buf[i + 3] = Math.round(na * 255);
}

// A line with a soft brush: a wide darker shoulder for depth plus a bright core on top,
// so each crack reads as a lit fracture whether it sits over a dark or light pixel.
function stroke(x0, y0, x1, y1, width, alpha) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const steps = Math.ceil(len * 2);
  const nx = -dy / (len || 1), ny = dx / (len || 1); // unit normal
  const shoulder = width + 1.5;
  for (let s = 0; s <= steps; s++) {
    const t = s / (steps || 1);
    const px = x0 + dx * t, py = y0 + dy * t;
    // dark shoulder first (cool navy), widest
    for (let o = -shoulder; o <= shoulder; o += 0.5) {
      const d = Math.abs(o) / shoulder;
      light(px + nx * o, py + ny * o, alpha * (1 - d) ** 1.4 * 0.55, 18, 26, 48);
    }
    // bright core on top, narrower
    for (let o = -width; o <= width; o += 0.4) {
      const d = Math.abs(o) / width;
      const core = (1 - d) ** 1.3;
      const a = Math.min(1, alpha * core * 1.4);
      const r = 245 - d * 70;
      const g = 250 - d * 40;
      const b = 255;
      light(px + nx * o, py + ny * o, a, r, g, b);
    }
  }
}

// Jagged polyline from (x,y) heading at `ang`, splitting into branches. Returns nothing;
// draws directly. Used for the radial cracks shooting out from the impact.
function crack(x, y, ang, length, width, depth) {
  let cx = x, cy = y, ca = ang;
  const segs = 6 + Math.floor(rnd() * 5);
  const segLen = length / segs;
  for (let i = 0; i < segs; i++) {
    ca += (rnd() - 0.5) * 0.5; // wander
    const nx2 = cx + Math.cos(ca) * segLen;
    const ny2 = cy + Math.sin(ca) * segLen;
    const w = width * (1 - i / segs) + 0.4; // taper to a fine tip
    stroke(cx, cy, nx2, ny2, w, 0.95);
    // occasionally spawn a thinner branch
    if (depth > 0 && rnd() < 0.4) {
      crack(nx2, ny2, ca + (rnd() < 0.5 ? 1 : -1) * (0.5 + rnd() * 0.6),
            length * (0.35 + rnd() * 0.3), w * 0.7, depth - 1);
    }
    cx = nx2; cy = ny2;
  }
}

// --- impact point: offset from dead-center so it looks like a real hit ---
const ix = W * (0.42 + rnd() * 0.16);
const iy = H * (0.4 + rnd() * 0.18);

// Radial cracks out to the edges.
const spokes = 13;
for (let i = 0; i < spokes; i++) {
  const ang = (i / spokes) * Math.PI * 2 + rnd() * 0.3;
  const reach = Math.max(W, H) * (0.7 + rnd() * 0.5);
  crack(ix, iy, ang, reach, 3.2, 2);
}

// Concentric stress rings near the impact — jagged polygons linking the spokes.
const rings = 5;
for (let rg = 1; rg <= rings; rg++) {
  const rad = rg * (34 + rnd() * 20);
  const pts = 9 + Math.floor(rnd() * 5);
  let prev = null;
  for (let p = 0; p <= pts; p++) {
    const a = (p / pts) * Math.PI * 2;
    const jit = rad * (0.82 + rnd() * 0.36);
    const px = ix + Math.cos(a) * jit;
    const py = iy + Math.sin(a) * jit;
    if (prev) stroke(prev[0], prev[1], px, py, 1.6 * (1 - rg / (rings + 2)) + 0.5, 0.8);
    prev = [px, py];
  }
}

// Bright pulverized core at the point of impact.
for (let r = 0; r < 4000; r++) {
  const a = rnd() * Math.PI * 2;
  const d = rnd() ** 2 * 60;
  light(ix + Math.cos(a) * d, iy + Math.sin(a) * d, (1 - d / 60) * 0.9, 255, 255, 255);
}

// --- PNG encode (truecolor + alpha, 8-bit) ---
function crc32(bytes) {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, Buffer.from(data)]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // bit depth 8, color type 6 (RGBA)
// filter byte 0 per scanline
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  const ro = y * (1 + W * 4);
  raw[ro] = 0;
  buf.copy?.(raw, ro + 1, y * W * 4, (y + 1) * W * 4) ??
    raw.set(buf.subarray(y * W * 4, (y + 1) * W * 4), ro + 1);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'client', 'public', 'cracked-glass.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${W}x${H})`);
