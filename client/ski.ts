// ⛷️ Frostreach Downhill — 2-4 player PvP ski race, entered from the Frostreach chairlift.
// Same `bg` relay as the club board games (game key 'ski'), but real-time: slot 0 (host) is the
// authority — it simulates the whole field (gates, the yeti, everyone's physics from relayed
// inputs) and streams snapshots; guests send their steer input and render the host's snapshots.
// The course is a fixed seeded slalom; first to the bottom wins. Optional winner-takes-all stake
// (server-escrowed via the bg block). SkiFree's yeti waits at the finish for the stragglers.

import type { BgNet } from './chess';

interface LobbyView { status: 'waiting' | 'playing' | 'ended'; slot: number; players: { name: string; slot: number }[]; stake: number }

const COURSE_LEN = 6000;        // world units of vertical descent
const TRACK_W = 900;            // half-width of the piste
const SKIER_COLORS = ['#e8c84b', '#4aa0e8', '#e0506a', '#7ed06a'];

interface Racer { slot: number; x: number; y: number; vx: number; steer: number; done: boolean; time: number; crash: number }
interface Gate { y: number; x: number; w: number }

let open = false;
let net: BgNet | null = null;
let root: HTMLDivElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let lobby: LobbyView = { status: 'waiting', slot: 0, players: [], stake: 0 };
let mySlot = 0;
let racers: Racer[] = [];
let gates: Gate[] = [];
let trees: { x: number; y: number }[] = [];
let raceT = 0;
let started = false;
let countdown = 0;
let finishOrder: number[] = [];
let over: { text: string; podium: { slot: number; time: number }[] } | null = null;
let myInput = 0;              // -1..1 steer
let raf = 0;
let lastT = 0;
let yetiAt = -400;
let keyL = false, keyR = false;

function mul(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// --- audio ---
let ac: AudioContext | null = null;
function tone(f: number, d: number, t: OscillatorType, v: number) {
  if (net?.muted()) return;
  try { ac = ac || new AudioContext(); const now = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
    o.type = t; o.frequency.value = f; g.gain.setValueAtTime(v, now); g.gain.exponentialRampToValueAtTime(0.001, now + d);
    o.connect(g); g.connect(ac.destination); o.start(now); o.stop(now + d + 0.02);
  } catch { /* ignore */ }
}

export function isSkiOpen() { return open; }

export function openSki(n: BgNet) {
  if (open) return;
  open = true;
  net = n;
  lobby = { status: 'waiting', slot: 0, players: [], stake: 0 };
  over = null; started = false; racers = [];
  root = document.createElement('div');
  root.id = 'skiOverlay';
  root.style.cssText = 'position:fixed;inset:0;z-index:20000;display:flex;align-items:center;justify-content:center;' +
    'background:linear-gradient(#cfe4f2,#eef5fb);font-family:Georgia,serif;color:#20303c;overflow:hidden;';
  document.body.appendChild(root);
  net.join();
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  renderLobby();
}

function shut() {
  open = false;
  cancelAnimationFrame(raf);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('keyup', onKey);
  root?.remove(); root = null; canvas = null; ctx = null;
  const nn = net; net = null;
  nn?.leave();
}

function onKey(e: KeyboardEvent) {
  const down = e.type === 'keydown';
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { keyL = down; e.preventDefault(); }
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { keyR = down; e.preventDefault(); }
  if (e.key === 'Escape' && down) shut();
}

function nameOf(slot: number) { return lobby.players.find((p) => p.slot === slot)?.name ?? (slot === mySlot ? (net?.name() || 'You') : `P${slot}`); }
function isHost() { return mySlot === 0; }

function buildCourse() {
  const rnd = mul(0x5C1); // fixed course — all clients agree
  gates = []; trees = [];
  let gx = 0;
  for (let y = 400; y < COURSE_LEN - 200; y += 260) {
    gx = Math.max(-TRACK_W + 140, Math.min(TRACK_W - 140, gx + (rnd() - 0.5) * 460));
    gates.push({ y, x: gx, w: 90 + rnd() * 30 });
  }
  for (let i = 0; i < 260; i++) {
    const side = rnd() > 0.5 ? 1 : -1;
    trees.push({ x: side * (TRACK_W + 30 + rnd() * 520), y: rnd() * COURSE_LEN });
  }
}

function startRace() {
  buildCourse();
  racers = lobby.players.map((p) => ({ slot: p.slot, x: (p.slot - (lobby.players.length - 1) / 2) * 120, y: 0, vx: 0, steer: 0, done: false, time: 0, crash: 0 }));
  finishOrder = []; raceT = 0; countdown = 3; started = true; over = null; yetiAt = -500;
  lastT = performance.now();
  renderRace();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(loop);
}

export function feedLobby(msg: LobbyView) {
  if (!open) return;
  const was = lobby.status;
  lobby = msg; mySlot = msg.slot;
  if (msg.status === 'ended') { if (started && !over) { over = { text: 'The race was abandoned.', podium: [] }; renderRace(); } else shut(); return; }
  if (msg.status === 'playing' && was !== 'playing') { startRace(); return; }
  if (!started) renderLobby();
}

export function feedRelay(data: unknown) {
  const d = data as { k?: string; slot?: number; s?: number; snap?: unknown; cd?: number; order?: number[] };
  if (!d || typeof d !== 'object') return;
  if (d.k === 'in' && isHost() && typeof d.slot === 'number' && typeof d.s === 'number') {
    const r = racers.find((x) => x.slot === d.slot); if (r) r.steer = Math.max(-1, Math.min(1, d.s));
    return;
  }
  if (d.k === 'snap' && !isHost() && Array.isArray(d.snap)) {
    racers = d.snap as Racer[];
    if (typeof d.cd === 'number') countdown = d.cd;
    if (Array.isArray(d.order)) finishOrder = d.order;
    if (typeof (d as { yeti?: number }).yeti === 'number') yetiAt = (d as { yeti: number }).yeti;
    if (!started) { started = true; buildCourse(); }
    return;
  }
  if (d.k === 'done' && Array.isArray(d.order)) { finishOrder = d.order; showResults(); return; }
}

function loop(t: number) {
  if (!open || !started) return;
  const dt = Math.min(0.05, (t - lastT) / 1000); lastT = t;
  myInput = (keyL ? -1 : 0) + (keyR ? 1 : 0);
  if (isHost()) {
    const me = racers.find((r) => r.slot === mySlot); if (me) me.steer = myInput;
    stepHost(dt);
    net?.relay({ k: 'snap', snap: racers, cd: countdown, order: finishOrder, yeti: yetiAt });
  } else {
    net?.relay({ k: 'in', slot: mySlot, s: myInput });
  }
  renderRace();
  if (!over) raf = requestAnimationFrame(loop);
}

function stepHost(dt: number) {
  if (countdown > 0) { countdown -= dt; if (countdown <= 0) tone(660, 0.3, 'square', 0.06); else if (Math.ceil(countdown) !== Math.ceil(countdown + dt)) tone(440, 0.12, 'square', 0.05); return; }
  raceT += dt;
  for (const r of racers) {
    if (r.done) continue;
    r.time = raceT;
    if (r.crash > 0) { r.crash -= dt; continue; }
    r.vx += r.steer * 900 * dt;
    r.vx *= Math.pow(0.06, dt);           // edge grip
    r.x += r.vx * dt;
    const fwd = 420 + Math.min(260, r.y / 14); // accelerates down the fall line
    r.y += fwd * dt * (1 - Math.min(0.5, Math.abs(r.vx) / 1600)); // turning scrubs speed
    if (Math.abs(r.x) > TRACK_W) { r.x = Math.sign(r.x) * TRACK_W; r.vx *= -0.3; }
    for (const tr of trees) { // trees hurt
      if (Math.abs(tr.y - r.y) < 22 && Math.abs(tr.x - r.x) < 24) { r.crash = 1.1; r.vx = 0; if (r.slot === mySlot) tone(120, 0.3, 'sawtooth', 0.05); break; }
    }
    if (r.y >= COURSE_LEN && !r.done) {
      r.done = true; finishOrder.push(r.slot);
      if (r.slot === mySlot) tone(784, 0.5, 'sine', 0.06);
    }
  }
  // the yeti lopes down behind the field, catching anyone who dawdles (SkiFree tribute — cosmetic)
  const lead = Math.max(0, ...racers.map((r) => r.y));
  yetiAt += (Math.max(240, lead - yetiAt) ) * dt * 0.28;
  if (racers.every((r) => r.done)) { net?.relay({ k: 'done', order: finishOrder }); showResults(); }
}

function showResults() {
  const podium = finishOrder.map((slot) => ({ slot, time: racers.find((r) => r.slot === slot)?.time ?? 0 }));
  for (const r of racers) if (!finishOrder.includes(r.slot)) podium.push({ slot: r.slot, time: r.time });
  over = { text: podium[0]?.slot === mySlot ? 'You win the downhill! 🏆' : `${nameOf(podium[0]?.slot ?? 0)} takes it.`, podium };
  if (isHost() && podium.length) net?.result(podium[0].slot); // winner slot → server settles the pot
  net?.onFinish?.(); // you finished a race → the World's ski objective can complete
  cancelAnimationFrame(raf);
  renderRace();
}

// --- rendering ---
function renderLobby() {
  if (!root) return;
  root.replaceChildren();
  const panel = document.createElement('div');
  panel.style.cssText = 'text-align:center;background:#ffffffcc;border:1px solid #a8c4d8;border-radius:16px;padding:34px 46px;box-shadow:0 20px 60px #0004;';
  panel.innerHTML = '<div style="font-size:30px;letter-spacing:3px;color:#2a6a9a;margin-bottom:2px;">⛷️ FROSTREACH DOWNHILL</div>' +
    '<div style="font-style:italic;color:#5a7488;font-size:13px;margin-bottom:22px;">One hill. No brakes. ← → to carve. Don\'t dawdle — something\'s behind you.</div>';
  const seats = document.createElement('div');
  seats.style.cssText = 'display:flex;gap:12px;justify-content:center;margin-bottom:20px;flex-wrap:wrap;';
  for (let slot = 0; slot < 4; slot++) {
    const p = lobby.players.find((x) => x.slot === slot);
    const seat = document.createElement('div');
    seat.style.cssText = `width:120px;padding:14px 8px;border-radius:12px;border:1px solid ${p ? SKIER_COLORS[slot] : '#c4d4e0'};background:${p ? '#f0f6fb' : '#f8fbfd'};`;
    seat.innerHTML = p ? `<div style="font-size:22px;color:${SKIER_COLORS[slot]}">⛷️</div><div style="margin-top:5px;font-size:14px">${p.name}</div>`
      : '<div style="font-size:22px;color:#c4d4e0">·</div><div style="margin-top:5px;font-size:12px;color:#90a4b4">open</div>';
    seats.appendChild(seat);
  }
  panel.appendChild(seats);
  const wager = document.createElement('div');
  wager.style.cssText = 'margin-bottom:16px;';
  const wl = document.createElement('div');
  wl.textContent = lobby.stake > 0 ? `Stake: ${lobby.stake.toLocaleString()}🪙 each — winner takes the pot` : 'A friendly race (no stake)';
  wl.style.cssText = `font-size:13px;color:${lobby.stake > 0 ? '#c07a2a' : '#5a7488'};margin-bottom:8px;`;
  wager.appendChild(wl);
  if (isHost()) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;justify-content:center;flex-wrap:wrap;';
    for (const [label, amt] of [['Friendly', 0], ['1k', 1000], ['10k', 10000], ['100k', 100000]] as [string, number][]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = btn(lobby.stake === amt);
      b.onclick = () => net?.stake(amt);
      row.appendChild(b);
    }
    wager.appendChild(row);
  }
  panel.appendChild(wager);
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:10px;justify-content:center;';
  if (isHost()) {
    const start = document.createElement('button');
    // Solo is fine — a lone racer runs it as a time trial against the yeti. 2+ is a real race.
    start.textContent = lobby.players.length >= 2 ? 'Drop the gate' : 'Solo time trial ▶';
    start.style.cssText = btn(true);
    start.onclick = () => net?.start();
    row.appendChild(start);
  } else {
    const w = document.createElement('div'); w.textContent = 'Waiting for the starter…'; w.style.cssText = 'color:#5a7488;font-size:13px;padding:8px;';
    row.appendChild(w);
  }
  const leave = document.createElement('button'); leave.textContent = 'Leave'; leave.style.cssText = btn(false); leave.onclick = () => shut();
  row.appendChild(leave);
  panel.appendChild(row);
  root.appendChild(panel);
}
function btn(active: boolean) {
  return `cursor:pointer;background:${active ? '#2a6a9a' : '#e8f0f6'};color:${active ? '#fff' : '#2a4858'};border:1px solid #8ab0c8;border-radius:8px;padding:8px 14px;font-size:13px;font-family:inherit;`;
}

function ensureCanvas() {
  if (canvas || !root) return;
  root.replaceChildren();
  canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
  root.appendChild(canvas);
  ctx = canvas.getContext('2d');
  const hud = document.createElement('div');
  hud.id = 'skiHud';
  hud.style.cssText = 'position:absolute;top:10px;left:0;right:0;text-align:center;pointer-events:none;font-family:ui-monospace,monospace;';
  root.appendChild(hud);
  const leave = document.createElement('button');
  leave.textContent = 'Leave';
  leave.style.cssText = btn(false) + 'position:absolute;top:10px;right:12px;';
  leave.onclick = () => shut();
  root.appendChild(leave);
}

function renderRace() {
  ensureCanvas();
  if (!canvas || !ctx || !root) return;
  const W = canvas.width = root.clientWidth, H = canvas.height = root.clientHeight;
  const me = racers.find((r) => r.slot === mySlot) ?? racers[0];
  const camY = me ? me.y : 0;
  const scale = Math.min(W, H) / 1300;
  const toX = (x: number) => W / 2 + x * scale;
  const toY = (y: number) => H * 0.35 + (y - camY) * scale;
  ctx.fillStyle = '#eef5fb'; ctx.fillRect(0, 0, W, H);
  // piste
  ctx.fillStyle = '#f8fcff';
  ctx.fillRect(toX(-TRACK_W), 0, TRACK_W * 2 * scale, H);
  // subtle groomer corduroy
  ctx.strokeStyle = '#e2ecf4'; ctx.lineWidth = 1;
  for (let gy = Math.floor(camY / 40) * 40; gy < camY + 1400; gy += 40) {
    ctx.beginPath(); ctx.moveTo(toX(-TRACK_W), toY(gy)); ctx.lineTo(toX(TRACK_W), toY(gy)); ctx.stroke();
  }
  // edges
  ctx.strokeStyle = '#c0d4e2'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(toX(-TRACK_W), 0); ctx.lineTo(toX(-TRACK_W), H); ctx.moveTo(toX(TRACK_W), 0); ctx.lineTo(toX(TRACK_W), H); ctx.stroke();
  // trees
  for (const tr of trees) {
    const sy = toY(tr.y); if (sy < -30 || sy > H + 30) continue;
    const sx = toX(tr.x), s = 16 * scale;
    ctx.fillStyle = '#2a6a44'; ctx.beginPath();
    ctx.moveTo(sx, sy - s * 2.2); ctx.lineTo(sx - s, sy); ctx.lineTo(sx + s, sy); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#e8f4fa'; ctx.beginPath(); ctx.moveTo(sx, sy - s * 2.2); ctx.lineTo(sx - s * 0.4, sy - s); ctx.lineTo(sx + s * 0.4, sy - s); ctx.closePath(); ctx.fill();
  }
  // gates
  for (const g of gates) {
    const sy = toY(g.y); if (sy < -20 || sy > H + 20) continue;
    for (const side of [-1, 1]) {
      ctx.fillStyle = side < 0 ? '#d0402a' : '#2a6ad0';
      ctx.fillRect(toX(g.x + side * g.w) - 2, sy - 26 * scale, 4, 26 * scale);
      ctx.beginPath(); ctx.arc(toX(g.x + side * g.w), sy - 26 * scale, 5 * scale, 0, 7); ctx.fill();
    }
  }
  // the yeti, loping behind
  const ysy = toY(yetiAt);
  if (ysy > -40 && ysy < H + 40) {
    ctx.font = `${Math.round(40 * scale)}px serif`; ctx.textAlign = 'center';
    ctx.fillText('👹', W / 2 + Math.sin(raceT * 4) * 40, ysy);
  }
  // racers
  for (const r of racers) {
    const sx = toX(r.x), sy = toY(r.y);
    ctx.save(); ctx.translate(sx, sy);
    if (r.crash > 0) ctx.rotate(Math.sin(r.crash * 30) * 0.5); else ctx.rotate(Math.max(-0.5, Math.min(0.5, r.vx / 1400)));
    ctx.font = `${Math.round(26 * scale)}px serif`; ctx.textAlign = 'center';
    ctx.fillText(r.crash > 0 ? '💫' : '⛷️', 0, 0);
    ctx.restore();
    ctx.fillStyle = SKIER_COLORS[r.slot]; ctx.font = `${Math.round(11 * scale + 6)}px ui-monospace`; ctx.textAlign = 'center';
    ctx.fillText(nameOf(r.slot) + (r.done ? ' ✓' : ''), sx, sy - 24 * scale);
  }
  // HUD
  const hud = document.getElementById('skiHud');
  if (hud) {
    if (over) {
      hud.innerHTML = `<div style="display:inline-block;background:#ffffffdd;border-radius:14px;padding:18px 30px;box-shadow:0 12px 40px #0004;">` +
        `<div style="font-size:24px;color:#2a6a9a;margin-bottom:8px;">${over.text}</div>` +
        over.podium.map((p, i) => `<div style="font-size:14px;color:${SKIER_COLORS[p.slot]};">${['🥇', '🥈', '🥉', '4th'][i] ?? ''} ${nameOf(p.slot)} — ${p.time.toFixed(1)}s</div>`).join('') +
        (lobby.status !== 'ended' && isHost() ? `<div style="margin-top:12px;"><button id="skiAgain" style="${btn(true)}pointer-events:auto;">Race again</button></div>` : '') +
        `</div>`;
      const again = document.getElementById('skiAgain');
      if (again) again.onclick = () => net?.start();
    } else if (countdown > 0) {
      hud.innerHTML = `<div style="font-size:64px;color:#2a6a9a;text-shadow:0 2px 8px #fff;">${Math.ceil(countdown)}</div>`;
    } else {
      const place = finishOrder.includes(mySlot) ? finishOrder.indexOf(mySlot) + 1 : (racers.filter((r) => r.y > (me?.y ?? 0)).length + 1);
      const pct = Math.min(100, Math.round(((me?.y ?? 0) / COURSE_LEN) * 100));
      hud.innerHTML = `<div style="display:inline-block;background:#ffffffcc;border-radius:10px;padding:6px 16px;font-size:14px;color:#2a4858;">` +
        `${raceT.toFixed(1)}s &nbsp;·&nbsp; ${pct}% down &nbsp;·&nbsp; P${place}/${racers.length}</div>`;
    }
  }
}
