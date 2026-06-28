// MapTap — Rob's geography game. A name is given and you must click where it is on a bare globe (no
// borders, no labels). We draw a stylised equirectangular world map procedurally (no asset), take one
// click, and score by great-circle distance. Used as the boss-fight "checkpoint" gate: a wrong answer
// has deadly consequences (the caller docks HP + flashes the screen red).

// Equirectangular projection: lon -180..180 → 0..W, lat 90..-90 → 0..H.
const proj = (lon: number, lat: number, W: number, H: number) => ({ x: (lon + 180) / 360 * W, y: (90 - lat) / 180 * H });
const unproj = (x: number, y: number, W: number, H: number) => ({ lon: x / W * 360 - 180, lat: 90 - y / H * 180 });
function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number) {
  const R = 6371, d = Math.PI / 180;
  const dLat = (bLat - aLat) * d, dLon = (bLon - aLon) * d;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * d) * Math.cos(bLat * d) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Rough continent silhouettes as [lon,lat] polygons — recognisable enough to find a major place on.
const LAND: [number, number][][] = [
  // North America
  [[-168, 65], [-150, 70], [-125, 70], [-95, 72], [-82, 73], [-64, 60], [-56, 51], [-66, 44], [-70, 41], [-81, 25], [-97, 18], [-105, 23], [-118, 32], [-124, 40], [-130, 54], [-150, 59], [-168, 65]],
  // Greenland
  [[-45, 60], [-22, 70], [-18, 82], [-45, 83], [-58, 76], [-50, 64], [-45, 60]],
  // South America
  [[-81, 8], [-60, 11], [-50, 1], [-35, -5], [-39, -22], [-49, -33], [-66, -45], [-74, -52], [-71, -30], [-70, -18], [-78, -8], [-81, 0], [-81, 8]],
  // Africa
  [[-17, 15], [-17, 21], [-10, 32], [10, 37], [33, 31], [43, 12], [51, 12], [42, -1], [40, -15], [32, -26], [20, -35], [12, -17], [9, 4], [-8, 5], [-17, 15]],
  // Europe
  [[-10, 36], [-9, 44], [-2, 48], [3, 51], [-2, 58], [12, 58], [30, 66], [40, 66], [40, 48], [28, 41], [16, 40], [3, 43], [-10, 36]],
  // Asia
  [[40, 48], [40, 66], [70, 73], [105, 78], [140, 73], [170, 68], [180, 66], [165, 60], [140, 52], [145, 43], [122, 30], [108, 20], [95, 6], [80, 8], [70, 22], [57, 25], [45, 40], [40, 48]],
  // India wedge
  [[68, 24], [78, 8], [88, 22], [80, 26], [68, 24]],
  // Australia
  [[114, -22], [122, -18], [130, -12], [142, -11], [146, -18], [150, -37], [140, -38], [130, -32], [118, -35], [114, -22]],
  // small but pollable: UK, Japan, Madagascar, New Zealand
  [[-5, 50], [-2, 58], [-6, 56], [-6, 51], [-5, 50]],
  [[130, 31], [140, 36], [142, 41], [137, 37], [132, 33], [130, 31]],
  [[44, -16], [50, -15], [50, -25], [45, -25], [44, -16]],
  [[167, -46], [178, -37], [174, -41], [167, -46]],
];

// The pool of askable places (name, lat, lon) — all on recognisable landmasses.
export const MAPTAP_PLACES: { name: string; lat: number; lon: number }[] = [
  { name: 'Australia', lat: -25, lon: 134 }, { name: 'Japan', lat: 36, lon: 138 },
  { name: 'Egypt', lat: 27, lon: 30 }, { name: 'Brazil', lat: -10, lon: -52 },
  { name: 'Greenland', lat: 72, lon: -42 }, { name: 'India', lat: 22, lon: 79 },
  { name: 'Madagascar', lat: -20, lon: 47 }, { name: 'Iceland', lat: 65, lon: -19 },
  { name: 'Italy', lat: 43, lon: 13 }, { name: 'New Zealand', lat: -42, lon: 173 },
  { name: 'Alaska', lat: 64, lon: -150 }, { name: 'Madrid, Spain', lat: 40, lon: -4 },
];
export const randomPlace = () => MAPTAP_PLACES[Math.floor(Math.random() * MAPTAP_PLACES.length)];

const CORRECT_KM = 2200; // within this of the true spot = correct (generous; the map is stylised)

// Show the MapTap overlay. The player gets one click; we reveal the truth and report correct + distance.
export function askMapTap(opts: { prompt: string; lat: number; lon: number; onDone: (correct: boolean, km: number) => void }): void {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;z-index:100002;background:rgba(4,7,14,.96);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;font-family:ui-monospace,Menlo,monospace;cursor:crosshair;';
  const title = document.createElement('div');
  title.innerHTML = `🌍 <b>MapTap</b> — tap where it is. Guess wrong and it'll cost you.`;
  title.style.cssText = 'color:#cfe0ff;font-size:16px;';
  const place = document.createElement('div');
  place.innerHTML = `📍 Find: <b style="color:#ffd24a">${opts.prompt}</b>`;
  place.style.cssText = 'color:#eef2ff;font-size:24px;font-weight:800;';
  const cv = document.createElement('canvas');
  const result = document.createElement('div');
  result.style.cssText = 'color:#9fd1ff;font-size:15px;height:20px;';
  wrap.append(title, place, cv, result);
  document.body.appendChild(wrap);

  // size the map to the viewport, 2:1 equirectangular
  const W = Math.min(960, Math.floor(window.innerWidth * 0.86)), H = Math.floor(W / 2);
  cv.width = W; cv.height = H; cv.style.cssText = 'border:2px solid #2b3a64;border-radius:8px;image-rendering:auto;';
  const ctx = cv.getContext('2d')!;
  function drawMap() {
    ctx.fillStyle = '#16314f'; ctx.fillRect(0, 0, W, H);                 // ocean
    ctx.strokeStyle = 'rgba(120,160,200,.14)'; ctx.lineWidth = 1;        // faint graticule
    for (let lon = -150; lon <= 150; lon += 30) { const x = proj(lon, 0, W, H).x; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let lat = -60; lat <= 60; lat += 30) { const y = proj(0, lat, W, H).y; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.fillStyle = '#3f7d44'; ctx.strokeStyle = '#52a058'; ctx.lineWidth = 1.5;
    for (const poly of LAND) {
      ctx.beginPath();
      poly.forEach((p, i) => { const q = proj(p[0], p[1], W, H); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }
  drawMap();

  let answered = false;
  cv.onclick = (e) => {
    if (answered) { cleanup(); return; }
    answered = true;
    const rect = cv.getBoundingClientRect();
    const gx = (e.clientX - rect.left) / rect.width * W, gy = (e.clientY - rect.top) / rect.height * H;
    const g = unproj(gx, gy, W, H);
    const km = haversineKm(g.lat, g.lon, opts.lat, opts.lon);
    const correct = km <= CORRECT_KM;
    // draw the true pin on whichever side of the antimeridian is nearest the guess (e.g. Tonga ≈ -175°
    // appears beside New Zealand, not across the whole map). Scoring still uses the real longitude.
    let dlon = opts.lon; if (dlon - g.lon > 180) dlon -= 360; else if (dlon - g.lon < -180) dlon += 360;
    const tp = proj(dlon, opts.lat, W, H);
    // draw the line from guess → truth, both markers
    ctx.strokeStyle = correct ? '#7ed957' : '#ff5a4a'; ctx.lineWidth = 2; ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(tp.x, tp.y); ctx.stroke(); ctx.setLineDash([]);
    const pin = (x: number, y: number, col: string) => { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); };
    pin(gx, gy, '#ffd24a'); pin(tp.x, tp.y, correct ? '#7ed957' : '#ff5a4a');
    result.innerHTML = correct
      ? `<span style="color:#7ed957">✓ ${Math.round(km)} km off — close enough.</span> &nbsp;<span style="opacity:.7">(click to continue)</span>`
      : `<span style="color:#ff6a5a">✗ ${Math.round(km)} km off. That's gonna hurt.</span> &nbsp;<span style="opacity:.7">(click to continue)</span>`;
    window.setTimeout(() => { cv.onclick = () => cleanup(); }, 50); // next click anywhere closes
    pending = { correct, km };
  };
  let pending: { correct: boolean; km: number } | null = null;
  function cleanup() {
    if (!wrap.parentNode) return;
    wrap.remove();
    opts.onDone(pending?.correct ?? false, pending?.km ?? 99999);
  }
}
