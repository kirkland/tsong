// 🐸 Grandmaw's Frog Race — a solo skill minigame in the Great Southern Damp. Ante an entry fee,
// pick your frog, then race it lily-pad to lily-pad by tapping in time with a swinging meter: nail
// the sweet zone for a big leap, mistime it for a stumble. Beat three of Grandmaw's frogs to the
// far bank and she pays out. The server owns the entry fee + prize (see lobby.frogEnter/Finish);
// this module is pure presentation + input.

export interface FrogNet {
  enter(frog: string): void;   // ante the entry fee for this frog (server charges + confirms)
  finish(won: boolean): void;  // report the result (won = your frog placed 1st)
  name(): string;
  muted(): boolean;
}

type Phase = 'pick' | 'countdown' | 'racing' | 'done';
interface Racer { id: string; name: string; color: string; dist: number; hopT: number; nextAiHop: number; mine: boolean; airUntil: number; place: number }

const TRACK = 1000; // race distance
const FROGS: { id: string; name: string; blurb: string; entry: number; prize: number; band: number; hop: number; aiSkill: number }[] = [
  { id: 'reliable', name: 'Old Reliable', blurb: 'Slow, steady, forgiving. A wide sweet spot.', entry: 200, prize: 800, band: 0.34, hop: 74, aiSkill: 0.62 },
  { id: 'hopscotch', name: 'Hopscotch Hettie', blurb: 'A balanced hopper. Fair odds.', entry: 200, prize: 1400, band: 0.24, hop: 84, aiSkill: 0.72 },
  { id: 'lightning', name: 'Greased Lightning', blurb: 'Enormous leaps, a hair-trigger meter. For the brave.', entry: 200, prize: 2600, band: 0.15, hop: 104, aiSkill: 0.82 },
];

let open = false;
let net: FrogNet | null = null;
let root: HTMLDivElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let phase: Phase = 'pick';
let myFrog = FROGS[0];
let racers: Racer[] = [];
let meterPhase = 0;   // 0..1 swinging needle
let meterDir = 1;
let lastHopAt = 0;
let countdown = 0;
let raf = 0;
let lastT = 0;
let finished: string[] = [];
let resultText = '';

// --- audio ---
let ac: AudioContext | null = null;
function tone(f: number, d: number, t: OscillatorType, v: number, slide?: number) {
  if (net?.muted()) return;
  try { ac = ac || new AudioContext(); const now = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
    o.type = t; o.frequency.setValueAtTime(f, now); if (slide) o.frequency.exponentialRampToValueAtTime(slide, now + d);
    g.gain.setValueAtTime(v, now); g.gain.exponentialRampToValueAtTime(0.001, now + d);
    o.connect(g); g.connect(ac.destination); o.start(now); o.stop(now + d + 0.02);
  } catch { /* ignore */ }
}
const ribbit = (good: boolean) => { tone(good ? 150 : 90, 0.12, 'square', 0.05, good ? 260 : 70); };

export function isFrogOpen() { return open; }

export function openFrog(n: FrogNet) {
  if (open) return;
  open = true; net = n; phase = 'pick'; resultText = '';
  root = document.createElement('div');
  root.id = 'frogOverlay';
  root.style.cssText = 'position:fixed;inset:0;z-index:20000;display:flex;align-items:center;justify-content:center;' +
    'background:radial-gradient(ellipse at 50% 30%,#1e2c1a 0%,#0e160b 75%);font-family:Georgia,serif;color:#dbe8cf;overflow:hidden;';
  document.body.appendChild(root);
  window.addEventListener('keydown', onKey);
  renderPick();
}
function shut() {
  open = false;
  cancelAnimationFrame(raf);
  window.removeEventListener('keydown', onKey);
  root?.remove(); root = null; canvas = null; ctx = null;
  net = null;
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { shut(); return; }
  if (phase === 'racing' && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); hop(); }
}

// The server confirmed the ante (or refused it) / settled the race. Drives the flow + payout text.
export function feedResult(stage: 'entered' | 'won' | 'lost' | 'broke', prize?: number) {
  if (!open) return;
  if (stage === 'broke') { resultText = `Grandmaw counts your coins and clucks. "Entry's ${FROGS[0].entry}🪙, sugar."`; renderPick(); return; }
  if (stage === 'entered') { startRace(); return; }
  if (stage === 'won') { resultText = `🏆 Your frog took it! Grandmaw pays out ${(prize ?? 0).toLocaleString()}🪙.`; tone(523, 0.4, 'sine', 0.06); phase = 'done'; renderDone(); return; }
  if (stage === 'lost') { resultText = 'The book closes. "Better frog next time, sugar."'; phase = 'done'; renderDone(); }
}

// --- flow ---
function renderPick() {
  if (!root) return;
  cancelAnimationFrame(raf);
  root.replaceChildren();
  const panel = document.createElement('div');
  panel.style.cssText = 'text-align:center;background:#16220f66;border:1px solid #3a4a24;border-radius:16px;padding:32px 40px;box-shadow:0 20px 60px #000a;max-width:92vw;';
  panel.innerHTML = '<div style="font-size:28px;letter-spacing:2px;color:#a8d86a;">🐸 GRANDMAW\'S FROG RACE</div>' +
    '<div style="font-style:italic;color:#9ab87a;font-size:13px;margin:6px 0 20px;">Ante up, pick a frog, and out-hop the field. Tap in the sweet zone to leap.</div>';
  if (resultText) {
    const r = document.createElement('div'); r.innerHTML = resultText;
    r.style.cssText = 'color:#e8d86a;font-size:14px;margin-bottom:16px;'; panel.appendChild(r);
  }
  const cards = document.createElement('div');
  cards.style.cssText = 'display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-bottom:22px;';
  for (const f of FROGS) {
    const c = document.createElement('button');
    c.style.cssText = 'width:200px;padding:16px 12px;border-radius:12px;border:1px solid #3a5a24;background:#1c2a12;color:#dbe8cf;cursor:pointer;text-align:center;font-family:inherit;transition:background .15s;';
    c.onmouseenter = () => { c.style.background = '#26381a'; };
    c.onmouseleave = () => { c.style.background = '#1c2a12'; };
    c.innerHTML = `<div style="font-size:34px;">🐸</div><div style="font-size:16px;font-weight:700;margin-top:4px;">${f.name}</div>` +
      `<div style="font-size:11px;color:#9ab87a;min-height:44px;margin:6px 0;">${f.blurb}</div>` +
      `<div style="font-size:12px;color:#a8d86a;">Entry ${f.entry}🪙 · Win <b style="color:#e8d86a;">${f.prize.toLocaleString()}🪙</b></div>`;
    c.onclick = () => { myFrog = f; resultText = ''; net?.enter(f.id); };
    cards.appendChild(c);
  }
  panel.appendChild(cards);
  const leave = document.createElement('button');
  leave.textContent = 'Leave the bog';
  leave.style.cssText = 'cursor:pointer;background:#26381a;color:#dbe8cf;border:1px solid #3a5a24;border-radius:8px;padding:9px 18px;font-size:14px;font-family:inherit;';
  leave.onclick = () => shut();
  panel.appendChild(leave);
  root.appendChild(panel);
}

function startRace() {
  const COLORS = ['#7ee06a', '#e0d24a', '#e0864a', '#6ac8e0'];
  const NAMES = [myFrog.name, 'Muddy Pete', 'Lily', 'Croaker'];
  racers = NAMES.map((nm, i) => ({ id: 'r' + i, name: i === 0 ? nm + ' (you)' : nm, color: COLORS[i], dist: 0, hopT: 0, nextAiHop: 0.5 + Math.random() * 0.4, mine: i === 0, airUntil: 0, place: 0 }));
  finished = []; phase = 'countdown'; countdown = 3; meterPhase = 0; meterDir = 1; lastHopAt = 0;
  ensureCanvas();
  lastT = performance.now();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(loop);
}

function ensureCanvas() {
  if (!root) return;
  root.replaceChildren();
  canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;cursor:pointer;';
  root.appendChild(canvas);
  ctx = canvas.getContext('2d');
  canvas.onpointerdown = () => { if (phase === 'racing') hop(); };
  const hud = document.createElement('div');
  hud.id = 'frogHud';
  hud.style.cssText = 'position:absolute;top:10px;left:0;right:0;text-align:center;pointer-events:none;font-family:ui-monospace,monospace;color:#dbe8cf;text-shadow:0 1px 3px #000;';
  root.appendChild(hud);
}

function hop() {
  const me = racers.find((r) => r.mine); if (!me || me.dist >= TRACK) return;
  const now = performance.now();
  if (now - lastHopAt < 300) return; // can't spam — one leap per landing
  lastHopAt = now;
  // meterPhase 0..1; the sweet zone is centred at 0.5 with the frog's band width
  const off = Math.abs(meterPhase - 0.5);
  const half = myFrog.band / 2;
  let quality: number;
  if (off <= half) quality = 1;                        // perfect leap
  else if (off <= half + 0.16) quality = 0.5;          // decent
  else quality = 0.12;                                  // stumble
  me.dist = Math.min(TRACK, me.dist + myFrog.hop * quality);
  me.hopT = now; me.airUntil = now + 220;
  ribbit(quality >= 0.5);
  if (quality < 0.5) { const h = document.getElementById('frogHud'); if (h) flash(h, 'splash!'); }
}
function flash(_el: HTMLElement, _t: string) { /* subtle; the meter tells the story */ }

function loop(t: number) {
  if (!open || (phase !== 'racing' && phase !== 'countdown')) return;
  const dt = Math.min(0.05, (t - lastT) / 1000); lastT = t;
  if (phase === 'countdown') {
    countdown -= dt;
    if (countdown <= 0) { phase = 'racing'; tone(660, 0.25, 'square', 0.06); }
    else if (Math.ceil(countdown) !== Math.ceil(countdown + dt)) tone(440, 0.12, 'square', 0.05);
  } else {
    // swing the meter (a triangle wave 0..1); faster for the twitchier frogs
    const spd = 1.5 + (0.25 - myFrog.band);
    meterPhase += meterDir * spd * dt;
    if (meterPhase >= 1) { meterPhase = 1; meterDir = -1; } else if (meterPhase <= 0) { meterPhase = 0; meterDir = 1; }
    // AI frogs hop on their own cadence, quality drawn around their skill
    for (const r of racers) {
      if (r.mine || r.dist >= TRACK) continue;
      r.nextAiHop -= dt;
      if (r.nextAiHop <= 0) {
        r.nextAiHop = 0.34 + Math.random() * 0.3;
        const q = Math.max(0.12, Math.min(1, myFrog.aiSkill + (Math.random() - 0.5) * 0.5));
        r.dist = Math.min(TRACK, r.dist + myFrog.hop * q);
        r.hopT = t; r.airUntil = t + 200;
      }
    }
    // finishing order
    for (const r of racers) if (r.dist >= TRACK && !finished.includes(r.id)) { finished.push(r.id); r.place = finished.length; }
    if (finished.length >= racers.length || (racers.find((r) => r.mine)?.dist ?? 0) >= TRACK) {
      // race ends when you cross (or everyone has)
      const me = racers.find((r) => r.mine)!;
      if (me.dist >= TRACK) endRace();
    }
  }
  render(t);
  raf = requestAnimationFrame(loop);
}

function endRace() {
  if (phase === 'done') return;
  phase = 'done';
  const me = racers.find((r) => r.mine)!;
  if (!finished.includes(me.id)) { finished.push(me.id); me.place = finished.length; }
  const won = me.place === 1;
  render(performance.now());
  net?.finish(won); // server settles; feedResult('won'|'lost') follows
}

function render(t: number) {
  if (!canvas || !ctx || !root) return;
  const W = canvas.width = root.clientWidth, H = canvas.height = root.clientHeight;
  const lanes = racers.length;
  const laneH = Math.min(90, (H - 120) / lanes);
  const top = (H - laneH * lanes) / 2 + 20;
  const x0 = 70, x1 = W - 90;
  // water
  ctx.fillStyle = '#16281e'; ctx.fillRect(0, 0, W, H);
  for (const [i, r] of racers.entries()) {
    const ly = top + i * laneH + laneH / 2;
    // lane water band
    ctx.fillStyle = i % 2 ? '#1c3226' : '#20382c'; ctx.fillRect(0, top + i * laneH, W, laneH);
    // lily pads along the lane
    ctx.fillStyle = '#2e5a38';
    for (let px = x0; px <= x1; px += 70) { ctx.beginPath(); ctx.ellipse(px, ly + 14, 16, 9, 0, 0, 7); ctx.fill(); }
    // finish line
    ctx.fillStyle = '#dbe8cf'; ctx.fillRect(x1, top + i * laneH + 4, 3, laneH - 8);
    // the frog
    const fx = x0 + (x1 - x0) * (r.dist / TRACK);
    const air = t < r.airUntil ? Math.sin((1 - (r.airUntil - t) / 220) * Math.PI) * -16 : 0;
    ctx.font = `${Math.round(laneH * 0.5)}px serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.save(); ctx.translate(fx, ly + air);
    if (r.mine) { ctx.shadowColor = r.color; ctx.shadowBlur = 12; }
    ctx.fillText('🐸', 0, 0); ctx.restore();
    // name
    ctx.fillStyle = r.color; ctx.font = '12px ui-monospace'; ctx.textAlign = 'left';
    ctx.fillText(r.name + (r.place ? `  ${['🥇', '🥈', '🥉', '4th'][r.place - 1]}` : ''), 6, ly - laneH / 2 + 12);
  }
  // the timing meter (bottom) — only while racing
  const hud = document.getElementById('frogHud');
  if (phase === 'countdown') {
    if (hud) hud.innerHTML = `<div style="font-size:60px;color:#a8d86a;">${Math.ceil(countdown)}</div><div style="font-size:14px;">Pick your moment…</div>`;
  } else if (phase === 'racing') {
    if (hud) hud.innerHTML = `<div style="font-size:15px;">TAP / SPACE to hop — land in the green</div>`;
    const mw = Math.min(460, W * 0.7), mx = (W - mw) / 2, my = H - 54, mh = 20;
    ctx.fillStyle = '#0c140a'; ctx.fillRect(mx - 3, my - 3, mw + 6, mh + 6);
    ctx.fillStyle = '#24361c'; ctx.fillRect(mx, my, mw, mh);
    const half = myFrog.band / 2;
    ctx.fillStyle = '#3fa03f'; ctx.fillRect(mx + mw * (0.5 - half), my, mw * myFrog.band, mh); // sweet zone
    ctx.fillStyle = '#fff'; ctx.fillRect(mx + mw * meterPhase - 2, my - 4, 4, mh + 8);          // needle
  } else if (phase === 'done') {
    const me = racers.find((r) => r.mine)!;
    if (hud) hud.innerHTML = `<div style="display:inline-block;background:#0e160bcc;border-radius:14px;padding:16px 28px;margin-top:${Math.round(H*0.3)}px;">` +
      `<div style="font-size:24px;color:${me.place === 1 ? '#a8d86a' : '#c8b060'};">${me.place === 1 ? '🏆 YOU WIN!' : `You placed ${['1st', '2nd', '3rd', '4th'][me.place - 1]}`}</div>` +
      (resultText ? `<div style="font-size:13px;color:#dbe8cf;margin-top:6px;">${resultText}</div>` : '<div style="font-size:12px;color:#9ab87a;margin-top:6px;">Grandmaw tallies the book…</div>') +
      `<div style="margin-top:12px;pointer-events:auto;"><button id="frogAgain" style="cursor:pointer;background:#2e4a1c;color:#dbe8cf;border:1px solid #3a5a24;border-radius:8px;padding:8px 16px;font-size:13px;font-family:inherit;margin-right:8px;">Race again</button>` +
      `<button id="frogLeave" style="cursor:pointer;background:#26381a;color:#dbe8cf;border:1px solid #3a5a24;border-radius:8px;padding:8px 16px;font-size:13px;font-family:inherit;">Leave</button></div></div>`;
    const again = document.getElementById('frogAgain'); if (again) again.onclick = () => renderPick();
    const lv = document.getElementById('frogLeave'); if (lv) lv.onclick = () => shut();
  }
}
function renderDone() { render(performance.now()); }
