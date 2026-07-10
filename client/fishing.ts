// "Cast a line" — a self-contained, lazy-loaded solo fishing minigame, reached from the World
// pond's pier. Like doom.ts/campaign.ts it owns its own fullscreen Canvas overlay, input handlers
// and rAF loop, all torn down on exit (ESC). It never touches the Pong game state.
//
// The CLIENT does all the gameplay: it rolls a tier (weighted), a species within that tier, and a
// size, runs the cast → bite → hook → reel skill loop, and on a successful catch reports ONLY the
// tier + size to the server (net.catchFish). The server picks the House-funded coin reward by tier
// (it never trusts a client coin amount) and tracks the biggest catch. Rarer fish fight harder.

import {
  FISH,
  FISH_TIERS,
  FISH_TIER_WEIGHTS,
  FishSpecies,
  FishTier,
  FishLeaderboardRow,
} from '../shared/types';

// Server-side reward ranges mirrored here for the guide panel only (display-only; server is authoritative).
const FISH_REWARD_DISPLAY: Record<FishTier, string> = {
  junk: '0–10', common: '50–120', uncommon: '160–360', rare: '700–1500', legendary: '3500',
};

// Networking hook into the shared websocket (provided by main.ts).
export interface FishingNet {
  // Report a landed fish: the server picks + grants the House-funded reward by tier.
  catchFish(tier: FishTier, sizeLb: number): void;
  leaderboard(): FishLeaderboardRow[]; // latest biggest-catch board
  name(): string;                      // this client's display name
  muted(): boolean;                    // whether the main page's mute toggle is on
}

// Per-tier flavour: a color for the reveal pop and how hard the reel mini-game fights.
const TIER_INFO: Record<FishTier, { color: string; label: string; fishSpeed: number; erratic: number; drainMul: number }> = {
  junk:      { color: '#9aa4b0', label: 'JUNK',      fishSpeed: 60,  erratic: 0.15, drainMul: 0.45 },
  common:    { color: '#cfe0ff', label: 'COMMON',    fishSpeed: 80,  erratic: 0.30, drainMul: 0.65 },
  uncommon:  { color: '#6bd06b', label: 'UNCOMMON',  fishSpeed: 105, erratic: 0.50, drainMul: 0.80 },
  rare:      { color: '#4aa3ff', label: 'RARE',      fishSpeed: 140, erratic: 0.75, drainMul: 1.00 },
  legendary: { color: '#ffd23f', label: 'LEGENDARY', fishSpeed: 180, erratic: 1.05, drainMul: 1.20 },
};

// Roll a tier by weight, then a species within it, then a size.
function rollCatch(): { species: FishSpecies; sizeLb: number } {
  const total = FISH_TIERS.reduce((s, t) => s + FISH_TIER_WEIGHTS[t], 0);
  let r = Math.random() * total;
  let tier: FishTier = 'common';
  for (const t of FISH_TIERS) { r -= FISH_TIER_WEIGHTS[t]; if (r <= 0) { tier = t; break; } }
  const pool = FISH.filter((f) => f.tier === tier);
  const species = pool[Math.floor(Math.random() * pool.length)];
  // Bias size toward the lower end (cube of a uniform) so monster catches feel earned.
  const t = Math.pow(Math.random(), 2.2);
  const sizeLb = Math.round((species.minLb + (species.maxLb - species.minLb) * t) * 10) / 10;
  return { species, sizeLb };
}

function escapeText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

let fishingOpen = false;

// Module-level hooks so main.ts can feed server messages back to the live overlay.
let handlers: {
  reward: (coins: number, item?: { id: string; name: string }) => void;
  board: (rows: FishLeaderboardRow[]) => void;
} | null = null;
export function feedFishReward(coins: number, item?: { id: string; name: string }) { handlers?.reward(coins, item); }
export function feedFishLeaderboard(rows: FishLeaderboardRow[]) { handlers?.board(rows); }

export function startFishing(net: FishingNet): void {
  if (fishingOpen) return;
  fishingOpen = true;

  const W = 480, H = 640; // logical canvas size (portrait — the water + a vertical reel bar)

  // 'idle' wait for cast · 'cast' bobber out, waiting for a bite · 'bite' the dip+reaction window
  // · 'reel' the catch-bar mini-game · 'reveal' the result pop. 'idle' after each reveal.
  type Phase = 'idle' | 'cast' | 'bite' | 'reel' | 'reveal';
  let phase: Phase = 'idle';

  // --- DOM overlay (mirrors doom.ts lifecycle) ---
  const overlay = document.createElement('div');
  overlay.id = 'fishingOverlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:20000;background:rgba(6,18,30,0.9);display:flex;align-items:center;' +
    'justify-content:center;flex-direction:column;font-family:ui-monospace,monospace;gap:10px;';

  const title = document.createElement('div');
  title.style.cssText =
    'position:absolute;top:14px;left:0;right:0;text-align:center;font:700 14px ui-monospace,monospace;' +
    'color:#9fc6e8;text-shadow:1px 1px 0 #000;pointer-events:none;';
  title.textContent = '🎣 click/tap to cast · click or SPACE to hook · HOLD to reel · ESC quit';
  overlay.appendChild(title);

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.style.cssText =
    'height:88vh;max-width:96vw;aspect-ratio:3/4;background:#0a2236;border-radius:12px;' +
    'box-shadow:0 0 40px rgba(40,120,180,.4);cursor:pointer;';
  const ctx = canvas.getContext('2d')!;
  overlay.appendChild(canvas);

  // Status line below the canvas (prompts / "It got away!" etc).
  const status = document.createElement('div');
  status.style.cssText = 'font:700 18px ui-monospace,monospace;color:#ffd166;text-shadow:1px 1px 0 #000;min-height:24px;text-align:center;';
  overlay.appendChild(status);

  // Biggest-catch leaderboard panel (bottom-left).
  const board = document.createElement('div');
  board.style.cssText =
    'position:absolute;left:16px;bottom:16px;min-width:200px;background:#0a1c2cdd;border:1px solid #1f4a68;' +
    'border-radius:10px;padding:10px 14px;color:#cfe0ff;font:700 13px ui-monospace,monospace;' +
    'pointer-events:none;text-shadow:1px 1px 0 #000;';
  overlay.appendChild(board);

  // Rewards guide panel (bottom-right): always shows tier chances + coin ranges.
  const guide = document.createElement('div');
  guide.style.cssText =
    'position:absolute;right:16px;bottom:16px;min-width:210px;background:#0a1c2cdd;border:1px solid #1f4a68;' +
    'border-radius:10px;padding:10px 14px;color:#cfe0ff;font:700 13px ui-monospace,monospace;' +
    'pointer-events:none;text-shadow:1px 1px 0 #000;';
  const total = FISH_TIERS.reduce((s, t) => s + FISH_TIER_WEIGHTS[t], 0);
  const guideRows = FISH_TIERS.slice().reverse().map((t) => {
    const pct = Math.round((FISH_TIER_WEIGHTS[t] / total) * 100);
    const color = TIER_INFO[t].color;
    const label = TIER_INFO[t].label;
    const reward = FISH_REWARD_DISPLAY[t];
    return `<div style="display:flex;justify-content:space-between;gap:10px;margin:2px 0">` +
      `<span style="color:${color}">${label}</span>` +
      `<span style="color:#9fc6e8">${pct}%</span>` +
      `<span style="color:#ffd166">🪙 ${reward}</span>` +
      `</div>`;
  }).join('');
  guide.innerHTML = `<div style="color:#7fd1ff;margin-bottom:6px">📊 FISH GUIDE</div>${guideRows}`;
  overlay.appendChild(guide);

  // Exit button (top-right).
  const exitBtn = document.createElement('button');
  exitBtn.textContent = '← Back';
  exitBtn.style.cssText =
    'position:absolute;top:12px;right:14px;cursor:pointer;background:#143049;color:#cfe0ff;' +
    'border:1px solid #2a5a7e;border-radius:8px;padding:7px 12px;font:600 13px ui-monospace,monospace;';
  overlay.appendChild(exitBtn);

  document.body.appendChild(overlay);

  function renderBoard() {
    const rows = net.leaderboard();
    const items = rows.slice(0, 5).map((r, i) =>
      `<div style="display:flex;justify-content:space-between;gap:14px">` +
      `<span>${i + 1}. ${escapeText(r.name)}</span><span style="color:#ffd166">${r.lb.toLocaleString()} lb</span></div>`,
    ).join('') || '<div style="color:#5d7b8b">no catches yet</div>';
    board.innerHTML = `<div style="color:#7fd1ff;margin-bottom:6px">🏆 BIGGEST CATCHES</div>${items}`;
  }
  renderBoard();

  // --- audio (tiny WebAudio one-shots, same idiom as doom.ts) ---
  let audio: AudioContext | null = null;
  const ac = () => (audio ??= new AudioContext());
  function blip(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number) {
    if (net.muted()) return;
    try {
      const a = ac(); const t = a.currentTime;
      const o = a.createOscillator(); const g = a.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
    } catch { /* ignore */ }
  }
  const castSound = () => blip(300, 0.18, 'sine', 0.18, 140);
  const biteSound = () => { blip(880, 0.07, 'square', 0.16); window.setTimeout(() => blip(660, 0.09, 'square', 0.14), 80); };
  const reelTick = () => blip(520, 0.03, 'square', 0.05, 680);
  const catchSound = () => { blip(523, 0.09, 'square', 0.16); window.setTimeout(() => blip(659, 0.09, 'square', 0.16), 90); window.setTimeout(() => blip(784, 0.16, 'square', 0.16), 180); };
  const getawaySound = () => blip(200, 0.3, 'sawtooth', 0.18, 70);

  // --- gameplay state ---
  let pending: { species: FishSpecies; sizeLb: number } | null = null; // the rolled (hidden) fish
  let waitTimer = 0;      // seconds until a bite (cast phase)
  let hookWindow = 0;     // seconds left in the reaction window (bite phase)
  // reel mini-game
  let fishY = 0.5;        // fish marker position in the bar, 0 (top) .. 1 (bottom)
  let fishVel = 0;        // fish velocity
  let zoneY = 0.5;        // catch-zone center, 0..1
  let zoneVel = 0;        // catch-zone velocity (driven by HOLD)
  let progress = 0;       // catch meter, 0..1 (fill to catch, empty to escape)
  let holding = false;    // pointer/space held → push the zone up
  // reveal
  let reveal: { species: FishSpecies; sizeLb: number; coins: number | null; item?: { id: string; name: string } } | null = null;
  let revealPop = 0;      // pop animation (counts down)
  let bobberBob = 0;      // bobber idle bob phase

  const ZONE_H = 0.22; // catch-zone height as a fraction of the bar

  function setStatus(text: string) { status.textContent = text; }

  function startCast() {
    // Castable from 'idle' OR straight off a 'reveal' (the "click to cast again" path) — but never
    // mid-cast/bite/reel.
    if (phase !== 'idle' && phase !== 'reveal') return;
    phase = 'cast';
    pending = rollCatch();
    waitTimer = 2 + Math.random() * 6; // bite in 2–8s
    reveal = null;
    castSound();
    setStatus('Waiting for a bite…');
  }

  function onBite() {
    phase = 'bite';
    hookWindow = 0.8; // reaction window
    biteSound();
    setStatus('A bite! Click / SPACE!');
  }

  function startReel() {
    if (!pending) { phase = 'idle'; return; }
    phase = 'reel';
    fishY = 0.4 + Math.random() * 0.2;
    fishVel = 0;
    zoneY = 0.5;
    zoneVel = 0;
    progress = 0.35; // start with a little buffer
    setStatus('Keep the marker in the zone!');
  }

  function missed() {
    phase = 'idle';
    pending = null;
    getawaySound();
    setStatus('It got away! Click to cast again.');
  }

  function landed() {
    if (!pending) { phase = 'idle'; return; }
    const c = pending;
    phase = 'reveal';
    reveal = { species: c.species, sizeLb: c.sizeLb, coins: null };
    revealPop = 1;
    catchSound();
    net.catchFish(c.species.tier, c.sizeLb);
    setStatus('Click to cast again.');
    pending = null;
  }

  // --- per-frame update ---
  function update(dt: number) {
    bobberBob += dt * 3;
    if (phase === 'cast') {
      waitTimer -= dt;
      if (waitTimer <= 0) onBite();
    } else if (phase === 'bite') {
      hookWindow -= dt;
      if (hookWindow <= 0) missed();
    } else if (phase === 'reel') {
      const info = TIER_INFO[pending ? pending.species.tier : 'common'];
      // Fish drifts/bounces: a wandering target with occasional erratic kicks (rarer = wilder).
      if (Math.random() < info.erratic * dt * 3) fishVel += (Math.random() * 2 - 1) * info.fishSpeed * 0.02;
      fishVel += (0.5 - fishY) * 0.4 * dt; // mild pull toward center so it stays in play
      fishVel *= 0.96;
      fishY += fishVel * dt * (info.fishSpeed / 100);
      if (fishY < 0.04) { fishY = 0.04; fishVel = Math.abs(fishVel); }
      if (fishY > 0.96) { fishY = 0.96; fishVel = -Math.abs(fishVel); }
      // Catch zone: HOLD pushes it up (negative), release lets gravity pull it down. Velocity is
      // damped and the POSITION update is dt-scaled (the missing *dt was making it rocket ~60×/s).
      zoneVel += (holding ? -5 : 4.2) * dt;
      zoneVel *= 0.88;
      zoneY += zoneVel * dt;
      if (zoneY < ZONE_H / 2) { zoneY = ZONE_H / 2; zoneVel = 0; }
      if (zoneY > 1 - ZONE_H / 2) { zoneY = 1 - ZONE_H / 2; zoneVel = 0; }
      // Fill while the fish is inside the zone, drain otherwise.
      const inZone = Math.abs(fishY - zoneY) < ZONE_H / 2;
      if (inZone) { progress += dt * 0.52; if (Math.random() < dt * 8) reelTick(); }
      else progress -= dt * 0.22 * info.drainMul;
      progress = Math.max(0, Math.min(1, progress));
      if (progress >= 1) landed();
      else if (progress <= 0) missed();
    }
    if (revealPop > 0) revealPop = Math.max(0, revealPop - dt * 2);
  }

  // --- rendering ---
  function render() {
    // Water background with a soft gradient + a faint horizon shimmer.
    const grd = ctx.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, '#0e3350');
    grd.addColorStop(1, '#06182a');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);
    // a few drifting wavelets
    ctx.strokeStyle = 'rgba(120,190,235,0.12)'; ctx.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
      const y = (i + 1) * (H / 7) + Math.sin(bobberBob + i) * 4;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    if (phase === 'cast' || phase === 'bite') drawBobber();
    if (phase === 'reel') drawReel();
    if (phase === 'reveal' && reveal) drawReveal();
    if (phase === 'idle') drawIdle();
  }

  function drawIdle() {
    ctx.fillStyle = 'rgba(159,198,232,0.85)';
    ctx.font = '700 26px ui-monospace,monospace'; ctx.textAlign = 'center';
    ctx.fillText('🎣', W / 2, H / 2 - 16);
    ctx.font = '700 18px ui-monospace,monospace';
    ctx.fillText('Click to cast a line', W / 2, H / 2 + 18);
  }

  function drawBobber() {
    const cx = W / 2;
    const cy = H * 0.42 + Math.sin(bobberBob) * 6 + (phase === 'bite' ? Math.sin(bobberBob * 9) * 10 : 0);
    // line from the top
    ctx.strokeStyle = 'rgba(230,240,255,0.5)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, cy - 12); ctx.stroke();
    // bobber: red top, white bottom
    ctx.fillStyle = '#e23b3b'; ctx.beginPath(); ctx.arc(cx, cy, 12, Math.PI, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f4f4f4'; ctx.beginPath(); ctx.arc(cx, cy, 12, 0, Math.PI); ctx.fill();
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy, 12, 0, Math.PI * 2); ctx.stroke();
    if (phase === 'bite') {
      const tierInfo = pending ? TIER_INFO[pending.species.tier] : TIER_INFO.common;
      ctx.fillStyle = tierInfo.color;
      ctx.font = '900 44px ui-monospace,monospace'; ctx.textAlign = 'center';
      ctx.fillText('!', cx, cy - 26);
      // tier label above the "!" so you know what you hooked
      ctx.font = '700 15px ui-monospace,monospace';
      ctx.fillText(tierInfo.label, cx, cy - 74);
      // ripple
      ctx.strokeStyle = tierInfo.color + '99'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, 18 + (0.8 - hookWindow) * 30, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function drawReel() {
    const info = TIER_INFO[pending ? pending.species.tier : 'common'];
    const barX = W * 0.5 - 32, barW = 64, barTop = H * 0.12, barH = H * 0.7;
    // track
    ctx.fillStyle = '#0a1a28'; ctx.fillRect(barX - 4, barTop - 4, barW + 8, barH + 8);
    ctx.fillStyle = '#123247'; ctx.fillRect(barX, barTop, barW, barH);
    // catch zone (green)
    const zTop = barTop + (zoneY - ZONE_H / 2) * barH;
    ctx.fillStyle = 'rgba(80,220,120,0.55)'; ctx.fillRect(barX, zTop, barW, ZONE_H * barH);
    ctx.strokeStyle = '#5fe08a'; ctx.lineWidth = 2; ctx.strokeRect(barX, zTop, barW, ZONE_H * barH);
    // fish marker
    const fy = barTop + fishY * barH;
    ctx.fillStyle = info.color;
    ctx.font = '28px ui-monospace,monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🐟', barX + barW / 2, fy);
    ctx.textBaseline = 'alphabetic';
    // progress meter (right side)
    const pX = barX + barW + 18, pW = 22;
    ctx.fillStyle = '#0a1a28'; ctx.fillRect(pX - 2, barTop - 2, pW + 4, barH + 4);
    ctx.fillStyle = '#102a3c'; ctx.fillRect(pX, barTop, pW, barH);
    const ph = progress * barH;
    const pg = ctx.createLinearGradient(0, barTop + barH - ph, 0, barTop + barH);
    pg.addColorStop(0, '#7fffa0'); pg.addColorStop(1, '#2ea860');
    ctx.fillStyle = pg; ctx.fillRect(pX, barTop + barH - ph, pW, ph);
    // hint
    ctx.fillStyle = '#9fc6e8'; ctx.font = '700 14px ui-monospace,monospace'; ctx.textAlign = 'center';
    ctx.fillText('HOLD to reel', W / 2, barTop + barH + 28);
  }

  function drawReveal() {
    if (!reveal) return;
    // Boat keys override: when a junk haul coughs up the keys, the catch IS the keys —
    // show "🔑 Old Boat Keys" instead of the soda can / boot / tire we actually reeled in.
    const isKeys = reveal.item?.id === 'car-boat';
    const info = TIER_INFO[reveal.species.tier];
    const pop = 1 + revealPop * 0.4;
    ctx.save();
    ctx.translate(W / 2, H * 0.4);
    ctx.scale(pop, pop);
    ctx.textAlign = 'center';
    ctx.fillStyle = isKeys ? '#ffd23f' : info.color;
    ctx.font = '900 22px ui-monospace,monospace';
    ctx.fillText(isKeys ? 'BOAT KEYS' : info.label, 0, -70);
    ctx.font = '700 26px ui-monospace,monospace';
    ctx.fillStyle = '#fff';
    ctx.fillText(isKeys ? '🔑 Old Boat Keys' : reveal.species.name, 0, -30);
    if (!isKeys) {
      ctx.font = '700 20px ui-monospace,monospace';
      ctx.fillStyle = '#cfe0ff';
      ctx.fillText(`${reveal.sizeLb.toLocaleString()} lb`, 0, 4);
    }
    ctx.font = '700 22px ui-monospace,monospace';
    ctx.fillStyle = '#ffd166';
    const coinText = reveal.coins === null ? '…' : `🪙 +${reveal.coins.toLocaleString()}`;
    ctx.fillText(coinText, 0, 44);
    if (reveal.item) {
      ctx.font = '700 16px ui-monospace,monospace';
      ctx.fillStyle = '#ffd23f';
      ctx.fillText(`Unlocked: ${reveal.item.name}!`, 0, 78);
    }
    ctx.restore();
  }

  // --- incoming server messages ---
  handlers = {
    reward: (coins, item) => {
      if (reveal) { reveal.coins = coins; if (item) reveal.item = item; revealPop = Math.max(revealPop, 0.6); }
      renderBoard();
    },
    board: () => renderBoard(),
  };

  // --- input ---
  function act() {
    try { const a = ac(); if (a.state === 'suspended') void a.resume(); } catch { /* ignore */ }
    if (phase === 'idle' || phase === 'reveal') startCast();
    else if (phase === 'bite') startReel();
  }
  const onPointerDown = () => { act(); holding = true; };
  const onPointerUp = () => { holding = false; };
  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (k === 'escape') { close(); return; }
    if (k === ' ' || k === 'enter') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat) act();
      holding = true;
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'enter') { holding = false; e.stopImmediatePropagation(); }
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  exitBtn.onclick = () => close();

  setStatus('Click to cast a line.');

  // --- loop + teardown ---
  let raf = 0;
  let last = performance.now();
  function loop(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    render();
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  function close() {
    if (!fishingOpen) return;
    fishingOpen = false;
    cancelAnimationFrame(raf);
    canvas.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    handlers = null;
    audio?.close().catch(() => {});
    overlay.remove();
  }
}
