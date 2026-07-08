// Tsong Hero — a Guitar-Hero-style rhythm game over the game's real 8-bit song covers,
// launched from the Arcade menu. Fully solo and client-side (no lobby, no relay): its own
// fullscreen overlay, canvas, input handlers and loop, all torn down on exit.
//
// The note charts in gh-charts.ts are NOT hand-authored — they were extracted from the
// actual mp3 waveforms offline (spectral-flux onset detection, autocorrelation tempo,
// 16th-note grid snapping, frequency-band lane assignment), so the notes land on the
// music. Timing during play is slaved to the <audio> element's clock, which keeps the
// highway and the song in lockstep even if frames hitch.
//
// Lanes are hit with W A S D (left→right: A W S D — bass rides the left lanes).

import { GH_CHARTS, type GhChart } from './gh-charts';

export interface GhNet {
  submit(song: string, diff: string, score: number): void; // report a finished run to the server
  leaderboard(): { song: string; diff: string; name: string; score: number }[]; // live public board
  name(): string;
}

const LANE_KEYS = ['a', 'w', 's', 'd'] as const;         // lane 0..3, left→right
const LANE_COLORS = ['#00e5ff', '#ff9a00', '#ff3df0', '#89ff2a'] as const;
const APPROACH_MS = 1500;   // note travel time from horizon to receptor
const WIN_GOOD = 110;       // ± ms
const WIN_PERFECT = 45;     // ± ms
const LEAD_IN_MS = 2600;    // silence before the song starts (first notes fall in)
type Diff = 'easy' | 'normal' | 'hard';

let ghOpen = false;

export function startGuitarHero(net: GhNet): void {
  if (ghOpen) return;
  ghOpen = true;

  type Mode = 'select' | 'play' | 'results';
  let mode: Mode = 'select';
  let diff: Diff = 'normal';
  let chart: GhChart | null = null;

  // --- per-run state ---
  interface Note { t: number; lane: number; hit: boolean; missed: boolean; }
  let notes: Note[] = [];
  let nextIdx = 0;            // first note that can still be judged (all before are resolved)
  let audio: HTMLAudioElement | null = null;
  let startedAt = 0;          // perf.now() when the run began (lead-in reference)
  let score = 0, combo = 0, maxCombo = 0;
  let perfects = 0, goods = 0, misses = 0;
  let judgement = '';         // floating PERFECT/GOOD/MISS text
  let judgementColor = '#fff';
  let judgementAt = 0;
  const laneFlash = [0, 0, 0, 0];   // receptor flash timestamps
  const laneDown = [false, false, false, false];
  let hitBurst: (lane: number, color: string, big: boolean) => void = () => {}; // set by the renderer

  const bestKey = () => `tsong.gh.${chart?.file}.${diff}`;
  const getBest = (c: GhChart, d: Diff) => {
    try { return parseInt(localStorage.getItem(`tsong.gh.${c.file}.${d}`) || '0', 10) || 0; } catch { return 0; }
  };

  // --- DOM overlay ---
  const overlay = document.createElement('div');
  overlay.id = 'ghOverlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:#05030c;display:flex;align-items:center;' +
    'justify-content:center;flex-direction:column;font-family:ui-monospace,monospace;';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;height:min(94vh,150vw);aspect-ratio:2/3;';
  const canvas = document.createElement('canvas');
  canvas.width = 900; canvas.height = 1350;
  canvas.style.cssText =
    'width:100%;height:100%;background:#000;border:2px solid #a04aff44;border-radius:8px;' +
    'box-shadow:0 0 60px #a04aff22, inset 0 0 120px #000c;';
  const ctx = canvas.getContext('2d')!;
  const scan = document.createElement('div');
  scan.style.cssText =
    'position:absolute;inset:0;pointer-events:none;border-radius:8px;' +
    'background:repeating-linear-gradient(transparent 0 2px, #0003 2px 3px);';
  wrap.append(canvas, scan);
  overlay.appendChild(wrap);

  const ui = document.createElement('div');
  ui.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'flex-direction:column;gap:12px;color:#e8d8ff;text-align:center;overflow-y:auto;';
  overlay.appendChild(ui);

  const styleEl = document.createElement('style');
  styleEl.textContent =
    '@keyframes ghGlow { 0%,100% { text-shadow: 0 0 24px #a04aff88; } 50% { text-shadow: 0 0 48px #a04affcc; } }';
  overlay.appendChild(styleEl);

  const btn = (label: string, color: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText =
      `cursor:pointer;font:inherit;font-size:15px;font-weight:800;letter-spacing:1.5px;padding:10px 26px;` +
      `background:#0d0618;color:${color};border:2px solid ${color};border-radius:8px;`;
    b.onmouseenter = () => { b.style.background = '#1a0c2e'; };
    b.onmouseleave = () => { b.style.background = '#0d0618'; };
    b.onclick = onClick;
    return b;
  };

  let boardTimer = 0; // refreshes the results leaderboard while the server broadcast lands
  function renderUi() {
    window.clearInterval(boardTimer);
    ui.replaceChildren();
    ui.style.display = mode === 'play' ? 'none' : 'flex';
    if (mode === 'select') {
      const title = document.createElement('div');
      title.innerHTML =
        '<div style="font-size:52px;font-weight:900;letter-spacing:10px;color:#c890ff;animation:ghGlow 2.4s ease-in-out infinite">🎸 TSONG HERO</div>' +
        '<div style="font-size:12px;opacity:.7;margin-top:4px;letter-spacing:2px">CHARTS EXTRACTED FROM THE ACTUAL SONGS · HIT THE NOTES WITH W A S D</div>';
      ui.appendChild(title);
      // difficulty picker
      const diffRow = document.createElement('div');
      diffRow.style.cssText = 'display:flex;gap:10px;';
      (['easy', 'normal', 'hard'] as Diff[]).forEach((d) => {
        const c = d === 'easy' ? '#7fe089' : d === 'normal' ? '#ffd060' : '#ff5a5a';
        const b = btn(d.toUpperCase(), diff === d ? c : '#556', () => { diff = d; renderUi(); });
        if (diff === d) b.style.background = '#1a0c2e';
        diffRow.appendChild(b);
      });
      ui.appendChild(diffRow);
      // song list
      const list = document.createElement('div');
      list.style.cssText = 'display:flex;flex-direction:column;gap:8px;min-width:520px;';
      for (const c of GH_CHARTS) {
        const n = c[diff].length;
        const best = getBest(c, diff);
        const row = document.createElement('button');
        row.type = 'button';
        row.style.cssText =
          'cursor:pointer;font:inherit;text-align:left;display:flex;justify-content:space-between;' +
          'align-items:center;gap:16px;padding:12px 18px;background:#0d0618;color:#e8d8ff;' +
          'border:1px solid #3a2260;border-radius:10px;';
        row.onmouseenter = () => { row.style.borderColor = '#a04aff'; row.style.background = '#160a28'; };
        row.onmouseleave = () => { row.style.borderColor = '#3a2260'; row.style.background = '#0d0618'; };
        const mins = Math.floor(c.durationMs / 60000), secs = Math.round((c.durationMs % 60000) / 1000);
        const world = net.leaderboard().filter((r) => r.song === c.file && r.diff === diff)[0];
        row.innerHTML =
          `<span style="font-size:16px;font-weight:800">${c.title}</span>` +
          `<span style="font-size:11.5px;opacity:.65;text-align:right">${Math.round(c.bpm)} BPM · ${mins}:${String(secs).padStart(2, '0')} · ${n} notes` +
          `${best ? ` · <span style="color:#ffd060">best ${best.toLocaleString()}</span>` : ''}` +
          `${world ? `<br>🌐 <span style="color:#c890ff">${world.name}</span> holds it — <span style="color:#ffd060">${world.score.toLocaleString()}</span>` : ''}</span>`;
        row.onclick = () => startSong(c);
        list.appendChild(row);
      }
      ui.appendChild(list);
      ui.appendChild(btn('Exit', '#8aa', close));
    } else if (mode === 'results' && chart) {
      const total = perfects + goods + misses;
      const acc = total ? (perfects + goods) / total : 0;
      const fc = misses === 0 && total > 0;
      const grade = fc && acc > 0.98 ? 'S' : acc >= 0.93 ? 'A' : acc >= 0.8 ? 'B' : acc >= 0.6 ? 'C' : 'D';
      const gradeColor = grade === 'S' ? '#ffd060' : grade === 'A' ? '#7fe089' : grade === 'B' ? '#00e5ff' : '#c890ff';
      let bestNote = '';
      const prev = getBest(chart, diff);
      if (score > prev) {
        try { localStorage.setItem(bestKey(), String(score)); } catch { /* ignore */ }
        bestNote = '<div style="color:#ffd060;font-size:14px;margin-top:4px">★ NEW BEST</div>';
      }
      const panel = document.createElement('div');
      panel.style.cssText = 'text-align:center;line-height:1.9;';
      panel.innerHTML =
        `<div style="font-size:20px;letter-spacing:4px;opacity:.8">${chart.title} · ${diff.toUpperCase()}</div>` +
        `<div style="font-size:110px;font-weight:900;color:${gradeColor};text-shadow:0 0 50px ${gradeColor}88">${grade}${fc ? '<span style="font-size:26px;vertical-align:middle"> FULL COMBO</span>' : ''}</div>` +
        `<div style="font-size:30px;font-weight:800">${score.toLocaleString()}</div>${bestNote}` +
        `<div style="font-size:14px;margin-top:8px;opacity:.85">` +
        `<span style="color:#ffd060">PERFECT ${perfects}</span> · <span style="color:#00e5ff">GOOD ${goods}</span> · ` +
        `<span style="color:#ff5a5a">MISS ${misses}</span> · MAX COMBO ${maxCombo} · ${(acc * 100).toFixed(1)}%</div>`;
      ui.appendChild(panel);
      // public top-5 for this song × difficulty (refreshes as the server broadcast lands)
      const board = document.createElement('div');
      board.style.cssText =
        'min-width:380px;background:#0d0618cc;border:1px solid #3a2260;border-radius:10px;' +
        'padding:10px 16px;font-size:13px;line-height:1.9;text-align:left;';
      const renderBoard = () => {
        const rows = net.leaderboard().filter((r) => r.song === chart!.file && r.diff === diff);
        board.innerHTML =
          '<div style="font-size:11px;letter-spacing:3px;color:#8a7aa8;margin-bottom:2px">🌐 WORLD TOP 5</div>' +
          (rows.length
            ? rows.map((r, i) => {
                const me = r.name === net.name();
                return `<div style="display:flex;justify-content:space-between;gap:18px;${me ? 'color:#ffd060;font-weight:800' : ''}">` +
                  `<span>#${i + 1} ${r.name}${me ? ' ◄ you' : ''}</span><span>${r.score.toLocaleString()}</span></div>`;
              }).join('')
            : '<div style="opacity:.6">no scores yet — yours is incoming...</div>');
      };
      renderBoard();
      boardTimer = window.setInterval(renderBoard, 800);
      ui.appendChild(board);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:12px;';
      row.appendChild(btn('Retry', '#7fe089', () => startSong(chart!)));
      row.appendChild(btn('Song Select', '#c890ff', () => { mode = 'select'; renderUi(); }));
      ui.appendChild(row);
    }
  }

  function startSong(c: GhChart) {
    chart = c;
    notes = c[diff].map(([t, lane]) => ({ t: t + LEAD_IN_MS, lane, hit: false, missed: false }));
    nextIdx = 0;
    score = 0; combo = 0; maxCombo = 0; perfects = 0; goods = 0; misses = 0;
    judgement = '';
    audio?.pause();
    audio = new Audio(`/${c.file}`);
    audio.volume = 0.65;
    startedAt = performance.now();
    window.setTimeout(() => { if (ghOpen && mode === 'play') audio?.play().catch(() => {}); }, LEAD_IN_MS);
    mode = 'play';
    renderUi();
  }

  // Song clock: slave to the audio element once it's rolling; wall clock covers the lead-in.
  const songTime = () =>
    audio && !audio.paused && audio.currentTime > 0
      ? audio.currentTime * 1000 + LEAD_IN_MS
      : performance.now() - startedAt;

  function endSong() {
    audio?.pause();
    if (chart && score > 0) net.submit(chart.file, diff, score); // public leaderboard entry
    mode = 'results';
    renderUi();
  }

  // --- input ---
  function judge(lane: number) {
    const now = songTime();
    laneFlash[lane] = performance.now();
    // earliest unresolved note in this lane within the window
    let best = -1, bestAbs = WIN_GOOD + 1;
    for (let i = nextIdx; i < notes.length; i++) {
      const n = notes[i];
      if (n.t > now + WIN_GOOD) break;
      if (n.lane !== lane || n.hit || n.missed) continue;
      const d = Math.abs(n.t - now);
      if (d < bestAbs) { best = i; bestAbs = d; }
    }
    if (best === -1) return; // stray strum — receptor flashes, no penalty
    const n = notes[best];
    n.hit = true;
    combo++;
    maxCombo = Math.max(maxCombo, combo);
    const mult = 1 + Math.min(3, Math.floor(combo / 10));
    if (bestAbs <= WIN_PERFECT) { perfects++; score += 100 * mult; judgement = 'PERFECT'; judgementColor = '#ffd060'; }
    else { goods++; score += 50 * mult; judgement = 'GOOD'; judgementColor = '#00e5ff'; }
    judgementAt = performance.now();
    hitBurst(lane, LANE_COLORS[lane], bestAbs <= WIN_PERFECT);
  }
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (mode === 'play') { audio?.pause(); mode = 'select'; renderUi(); }
      else close();
      return;
    }
    if (mode !== 'play' || e.repeat) return;
    const lane = LANE_KEYS.indexOf(e.key.toLowerCase() as typeof LANE_KEYS[number]);
    if (lane !== -1) { e.preventDefault(); e.stopPropagation(); laneDown[lane] = true; judge(lane); }
  }
  function onKeyUp(e: KeyboardEvent) {
    const lane = LANE_KEYS.indexOf(e.key.toLowerCase() as typeof LANE_KEYS[number]);
    if (lane !== -1) laneDown[lane] = false;
  }
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);

  // --- rendering: pseudo-3D highway rushing out of a glowing horizon ---
  const W = 900, H = 1350;
  const LANE_W = 150;
  const HORIZON = 170;                 // vanishing region
  const REC_Y = H - 190;               // receptor line
  const TOP_SCALE = 0.30;              // highway width at the horizon vs the bottom
  // perspective helpers: f=0 at horizon → 1 at receptor line
  const persp = (y: number) => Math.max(0, Math.min(1.15, (y - HORIZON) / (REC_Y - HORIZON)));
  const widthAt = (y: number) => TOP_SCALE + (1 - TOP_SCALE) * persp(y);
  const laneCx = (lane: number, y: number) => W / 2 + (lane - 1.5) * LANE_W * widthAt(y);
  const edgeX = (edge: number, y: number) => W / 2 + (edge - 2) * LANE_W * widthAt(y);
  // time → screen y: accelerates toward the player for the 3D rush
  const noteY = (dt: number) => HORIZON + (REC_Y - HORIZON) * Math.pow(1 - dt / APPROACH_MS, 1.55);

  // hit-burst particles
  interface Spark { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; }
  let sparks: Spark[] = [];
  const burst = (lane: number, color: string, big: boolean) => {
    const cx = laneCx(lane, REC_Y);
    for (let i = 0; i < (big ? 22 : 12); i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
      const sp = 180 + Math.random() * (big ? 480 : 300);
      sparks.push({ x: cx, y: REC_Y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: 0.4 + Math.random() * 0.35, color: Math.random() < 0.3 ? '#fff' : color });
    }
  };
  hitBurst = burst; // judge() fires bursts through this hook

  // idle starfield behind the menus + above the horizon in play
  const stars = Array.from({ length: 90 }, () => ({
    x: Math.random() * W, y: Math.random() * H, s: 0.5 + Math.random() * 1.8, tw: Math.random() * Math.PI * 2,
  }));

  let lastT = performance.now();
  function render() {
    const now = performance.now();
    const dts = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    const st = songTime();

    // deep-space backdrop
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#050310');
    bg.addColorStop(0.6, '#0a0518');
    bg.addColorStop(1, '#140a26');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    for (const s of stars) {
      const a = 0.25 + 0.35 * Math.abs(Math.sin(now / 900 + s.tw));
      ctx.globalAlpha = a;
      ctx.fillStyle = '#cdbaff';
      ctx.fillRect(s.x, s.y * (mode === 'play' ? HORIZON / H : 1), s.s, s.s);
    }
    ctx.globalAlpha = 1;
    if (mode !== 'play' || !chart) return;

    // beat-pulsing horizon glow
    const beatMs = 60000 / chart.bpm;
    const beatFrac = (((st - LEAD_IN_MS) % beatMs) + beatMs) % beatMs / beatMs;
    const pulse = Math.max(0, 1 - beatFrac * 3);
    const hg = ctx.createRadialGradient(W / 2, HORIZON, 10, W / 2, HORIZON, 480);
    hg.addColorStop(0, `rgba(170, 90, 255, ${0.5 + pulse * 0.35})`);
    hg.addColorStop(1, 'rgba(170, 90, 255, 0)');
    ctx.fillStyle = hg;
    ctx.fillRect(0, 0, W, HORIZON + 500);

    // highway body (trapezoid) with combo heat
    const mult = 1 + Math.min(3, Math.floor(combo / 10));
    ctx.beginPath();
    ctx.moveTo(edgeX(0, HORIZON), HORIZON);
    ctx.lineTo(edgeX(4, HORIZON), HORIZON);
    ctx.lineTo(edgeX(4, H), H);
    ctx.lineTo(edgeX(0, H), H);
    ctx.closePath();
    const hwg = ctx.createLinearGradient(0, HORIZON, 0, H);
    hwg.addColorStop(0, 'rgba(20, 8, 40, 0.9)');
    hwg.addColorStop(1, `rgba(${30 + mult * 8}, 12, ${58 + mult * 6}, 0.95)`);
    ctx.fillStyle = hwg;
    ctx.fill();

    // lane dividers converging on the horizon + beat ticks racing at you
    for (let l = 0; l <= 4; l++) {
      ctx.strokeStyle = l === 0 || l === 4 ? '#5a3a9a' : '#2e1a55';
      ctx.lineWidth = l === 0 || l === 4 ? 3 : 1.5;
      ctx.beginPath();
      ctx.moveTo(edgeX(l, HORIZON), HORIZON);
      ctx.lineTo(edgeX(l, H), H);
      ctx.stroke();
    }
    for (let k = 0; k < 6; k++) { // horizontal beat bars sliding down the highway
      const bt = (Math.floor((st - LEAD_IN_MS) / beatMs) + k) * beatMs + LEAD_IN_MS;
      const dt = bt - st;
      if (dt < 0 || dt > APPROACH_MS) continue;
      const y = noteY(dt);
      ctx.strokeStyle = `rgba(120, 80, 200, ${0.28 * widthAt(y)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(edgeX(0, y), y);
      ctx.lineTo(edgeX(4, y), y);
      ctx.stroke();
    }

    // receptors
    for (let l = 0; l < 4; l++) {
      const cx = laneCx(l, REC_Y);
      const flash = Math.max(0, 1 - (now - laneFlash[l]) / 180);
      const col = LANE_COLORS[l];
      ctx.strokeStyle = col;
      ctx.lineWidth = laneDown[l] ? 6 : 3;
      ctx.shadowColor = col; ctx.shadowBlur = 14 + flash * 30;
      ctx.beginPath();
      ctx.arc(cx, REC_Y, 46, 0, Math.PI * 2);
      ctx.stroke();
      if (flash > 0) {
        ctx.globalAlpha = flash * 0.6;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(cx, REC_Y, 46 + flash * 14, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.shadowBlur = 0;
      ctx.fillStyle = laneDown[l] ? '#fff' : '#8a7aa8';
      ctx.font = '800 27px ui-monospace, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(LANE_KEYS[l].toUpperCase(), cx, REC_Y + 1);
    }

    // notes — resolve misses, draw approaching gems (far first so near ones overlap)
    while (nextIdx < notes.length && (notes[nextIdx].hit || notes[nextIdx].missed)) nextIdx++;
    const drawable: Note[] = [];
    for (let i = nextIdx; i < notes.length; i++) {
      const n = notes[i];
      if (n.hit || n.missed) continue;
      const dt = n.t - st;
      if (dt < -WIN_GOOD) {
        n.missed = true; misses++; combo = 0;
        judgement = 'MISS'; judgementColor = '#ff5a5a'; judgementAt = now;
        continue;
      }
      if (dt > APPROACH_MS) break;
      drawable.push(n);
    }
    for (let i = drawable.length - 1; i >= 0; i--) {
      const n = drawable[i];
      const dt = n.t - st;
      const y = noteY(Math.max(0, dt));
      const wf = widthAt(y);
      const cx = laneCx(n.lane, y);
      const col = LANE_COLORS[n.lane];
      const nw = 112 * wf, nh = 32 * wf;
      ctx.shadowColor = col; ctx.shadowBlur = 10 + 16 * wf;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.roundRect(cx - nw / 2, y - nh / 2, nw, nh, nh / 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; // bottom bevel — gives the gem some body
      ctx.beginPath();
      ctx.roundRect(cx - nw / 2, y + nh * 0.12, nw, nh * 0.38, nh / 3);
      ctx.fill();
      ctx.fillStyle = '#ffffffcc';
      ctx.beginPath();
      ctx.roundRect(cx - nw * 0.33, y - nh * 0.28, nw * 0.66, nh * 0.34, nh / 4);
      ctx.fill();
    }

    // hit bursts
    for (const s of sparks) {
      s.life += dts; s.x += s.vx * dts; s.y += s.vy * dts; s.vy += 900 * dts;
      const t = 1 - s.life / s.max;
      if (t <= 0) continue;
      ctx.globalAlpha = t;
      ctx.fillStyle = s.color;
      const sz = 2.5 + t * 4;
      ctx.fillRect(s.x - sz / 2, s.y - sz / 2, sz, sz);
    }
    sparks = sparks.filter((s) => s.life < s.max);
    ctx.globalAlpha = 1;

    // judgement text — pops in big, settles, drifts up
    if (judgement && now - judgementAt < 500) {
      const t = (now - judgementAt) / 500;
      const pop = t < 0.15 ? 1.5 - t * 3.3 : 1;
      ctx.globalAlpha = 1 - t * t;
      ctx.font = `900 ${Math.round(56 * pop)}px ui-monospace, monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const jy = REC_Y - 280 - t * 50;
      ctx.fillStyle = '#ff3df055';
      ctx.fillText(judgement, W / 2 - 3, jy);
      ctx.fillStyle = '#00e5ff55';
      ctx.fillText(judgement, W / 2 + 3, jy);
      ctx.fillStyle = judgementColor;
      ctx.shadowColor = judgementColor; ctx.shadowBlur = 26;
      ctx.fillText(judgement, W / 2, jy);
      ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }
    // combo — scales with a heartbeat on every 10th
    if (combo >= 5) {
      const comboPop = 1 + 0.25 * Math.max(0, 1 - ((combo % 10) === 0 ? (now - judgementAt) / 200 : 1));
      ctx.fillStyle = mult === 4 ? '#ffd060' : '#fff';
      ctx.shadowColor = mult === 4 ? '#ffd060' : '#a04aff'; ctx.shadowBlur = mult === 4 ? 24 : 10;
      ctx.font = `900 ${Math.round(46 * comboPop)}px ui-monospace, monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(`${combo}`, W / 2, REC_Y - 370);
      ctx.shadowBlur = 0;
      ctx.font = '700 15px ui-monospace, monospace';
      ctx.fillStyle = '#8a7aa8';
      ctx.fillText('COMBO', W / 2, REC_Y - 335);
    }
    // side heat bars at full multiplier
    if (mult === 4) {
      const heat = 0.25 + 0.15 * Math.sin(now / 120);
      for (const sx of [0, W - 10]) {
        const g = ctx.createLinearGradient(sx, 0, sx + 10, 0);
        g.addColorStop(sx === 0 ? 0 : 1, `rgba(255, 208, 96, ${heat})`);
        g.addColorStop(sx === 0 ? 1 : 0, 'rgba(255, 208, 96, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(sx, 0, 10, H);
      }
    }
    // score + multiplier + progress
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.font = '800 32px ui-monospace, monospace';
    ctx.fillStyle = '#e8d8ff';
    ctx.fillText(score.toLocaleString(), W - 18, 16);
    ctx.font = '800 19px ui-monospace, monospace';
    ctx.fillStyle = mult === 4 ? '#ffd060' : '#8a7aa8';
    ctx.fillText(`x${mult}`, W - 18, 54);
    ctx.textAlign = 'left';
    ctx.font = '700 15px ui-monospace, monospace';
    ctx.fillStyle = '#8a7aa8';
    ctx.fillText(`${chart.title} · ${diff.toUpperCase()}`, 18, 18);
    const prog = Math.min(1, Math.max(0, (st - LEAD_IN_MS) / chart.durationMs));
    ctx.fillStyle = '#1a1030';
    ctx.fillRect(0, 0, W, 5);
    ctx.fillStyle = '#a04aff';
    ctx.shadowColor = '#a04aff'; ctx.shadowBlur = 8;
    ctx.fillRect(0, 0, W * prog, 5);
    ctx.shadowBlur = 0;

    if (st > chart.durationMs + LEAD_IN_MS + 600) endSong();
  }

  let raf = 0;
  function loop() {
    render();
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  function close() {
    if (!ghOpen) return;
    ghOpen = false;
    cancelAnimationFrame(raf);
    window.clearInterval(boardTimer);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    audio?.pause();
    audio = null;
    overlay.remove();
  }

  document.body.appendChild(overlay);
  renderUi();
}
