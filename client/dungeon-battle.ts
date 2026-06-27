// The Ruins encounter battle — a self-contained Pokémon-style wild battle that runs the REAL
// tsong Pong simulation (server/game.ts, which is pure logic) client-side: you (left paddle) vs a
// dungeon mob (right paddle, an AI). Lazy fullscreen overlay, torn down on exit. World.ts triggers
// it on a tall-grass encounter and handles the result (HP, coins) via the onResult callback.
//
// Flow: flash transition → "A wild X appeared!" → first-to-3 duel on a ruins-styled court →
// win = fanfare + payout, lose = you took damage. Damage = points the mob scored × mob.power.

import { Game } from '../server/game';
import { COURT, PADDLE, ROAM, BLASTER } from '../shared/types';

export interface MobDef {
  id: string; name: string; portrait: string; power: number; color: string;
  tier: number;                            // reward/difficulty tier (1 = B1 mobs). Coins scale with TIER, not floor.
  bob: 'flutter' | 'squish' | 'float';     // how the creature animates on the court
  bot: { react: number; error: number; predict: boolean; idleCenter: boolean };
  gimmick: { name: string; desc: string }; // shown in its profile (mechanics come on deeper floors)
  flavor: string; tag: string;             // a one-line bestiary blurb shown on appearance
  lives?: number;                          // points you must score to kill it (default 3; Cursed Jsav = 4)
  paddleScale?: number;                    // permanent paddle-size multiplier (The Warden = 2.25×)
  roam?: boolean;                          // permanently has the "roam" power-up — paddle hunts off its wall (Demon Fritz)
  turbo?: boolean;                         // the ball serves fast and accelerates harder each hit (The Flayed Hound)
  mirror?: boolean;                        // permanently inverts YOUR controls (Possessed Noam)
  blaster?: boolean;                       // fires freezing blaster shots you must dodge (Deranged Josiel)
  fireRate?: number;                       // seconds between blaster shots
  dropChance?: number;                     // 0–1 chance a win drops a potion (default 0; Demon Fritz is high)
  rotate?: number;                         // permanent "rotate" power-up: the whole court is turned (1–3 quarter-turns; Clarence = 2 = 180°)
}

// Roster, grouped two-per-tier. A floor introduces 2 NEW mobs (its tier) and carries the 2 from the
// tier above (see DUNGEON_FLOORS in world.ts). Rewards key off the mob's TIER, not the floor depth.
export const DUNGEON_MOBS: MobDef[] = [
  {
    id: 'bat', name: 'Cave Bat', portrait: '🦇', power: 4, color: '#7a6cae', tier: 1, bob: 'flutter',
    bot: { react: 0.29, error: 90, predict: false, idleCenter: false },
    gimmick: { name: 'Flit', desc: 'Jittery — hard to read, easy to fool.' },
    flavor: 'Screeeee!', tag: 'A twitchy little thing that never holds still.',
  },
  {
    id: 'slime', name: 'Crypt Slime', portrait: '🟢', power: 5, color: '#5fae54', tier: 1, bob: 'squish',
    bot: { react: 0.26, error: 72, predict: false, idleCenter: true },
    gimmick: { name: 'Ooze', desc: 'Slow and sluggish — lazy on the return.' },
    flavor: '…bloop.', tag: 'It seeps along the wall, in no hurry to lose.',
  },
  // --- B2 (tier 2): the floor turns to horror. Cursed Jsav won't stay down; The Warden walls the goal. ---
  {
    id: 'jsav', name: 'Cursed Jsav', portrait: '🫠', power: 7, color: '#7a8a6a', tier: 2, bob: 'float',
    bot: { react: 0.27, error: 78, predict: false, idleCenter: true }, lives: 4,
    gimmick: { name: 'Four Lives', desc: "Won't stay down — takes FOUR to put away." },
    flavor: 'you remember me…?', tag: 'A face you knew, dredged up wrong from the dark.',
  },
  {
    id: 'warden', name: 'The Warden', portrait: '🫥', power: 8, color: '#2e3a36', tier: 2, bob: 'float',
    bot: { react: 0.28, error: 82, predict: false, idleCenter: true }, paddleScale: 2.0,
    gimmick: { name: 'Looming', desc: 'Its bulk fills the goal — a paddle twice your size.' },
    flavor: '…', tag: 'A tall, patient thing that has waited here a very long time.',
  },
  // --- B3 (tier 3): deeper, bloodier. Demon Fritz hunts off his wall (roam); second mob TBD. ---
  {
    id: 'fritz', name: 'Demon Fritz', portrait: '😈', power: 16, color: '#b23026', tier: 3, bob: 'float',
    bot: { react: 0.16, error: 42, predict: true, idleCenter: false }, roam: true, paddleScale: 1.25, dropChance: 0.6,
    gimmick: { name: 'Roam', desc: 'Hunts the ball off his wall — and hits like a truck.' },
    flavor: 'heh. you look lost.', tag: 'Something wearing a friend’s face, and grinning about it.',
  },
  {
    id: 'hound', name: 'The Flayed Hound', portrait: '🐺', power: 11, color: '#9a2b32', tier: 3, bob: 'float',
    bot: { react: 0.20, error: 56, predict: false, idleCenter: false }, turbo: true,
    gimmick: { name: 'Frenzy', desc: 'The ball serves fast and blurs faster with every hit.' },
    flavor: '*wet snarl*', tag: 'Skinned, starving, and far too quick. It has your scent.',
  },
  // --- B4 (tier 4): the deep. Possessed Noam flips your controls; Grave Wisp drifts the cold dark. ---
  {
    id: 'noam', name: 'Possessed Noam', portrait: '👁️', power: 11, color: '#5a6a5e', tier: 4, bob: 'float',
    bot: { react: 0.23, error: 54, predict: false, idleCenter: true }, mirror: true,
    gimmick: { name: 'Possession', desc: 'Black-eyed and grinning — it FLIPS your controls.' },
    flavor: 'you know me… look closer.', tag: "Your friend's face, smiling. The eyes are all wrong.",
  },
  {
    id: 'josiel', name: 'Deranged Josiel', portrait: '🔫', power: 11, color: '#7a8a5a', tier: 4, bob: 'float',
    bot: { react: 0.24, error: 60, predict: false, idleCenter: true }, blaster: true, fireRate: 1.7,
    gimmick: { name: 'Blaster', desc: 'Fires shots that FREEZE your paddle — dodge them.' },
    flavor: 'hold still. this\'ll only sting.', tag: 'Wide-eyed, bloodshot, and far too happy to see you.',
  },
  // --- deeper floors (tier 5+), not yet placed on a floor ---
  { id: 'wisp', name: 'Grave Wisp', portrait: '🔵', power: 13, color: '#4aa6c0', tier: 5, bob: 'float', bot: { react: 0.20, error: 55, predict: true, idleCenter: true }, gimmick: { name: 'Gloom', desc: 'fogs your view' }, flavor: '…', tag: 'A cold light that drifts where the dead lie.' },
  { id: 'rattler', name: 'Bone Rattler', portrait: '💀', power: 11, color: '#cdbfa0', tier: 5, bob: 'float', bot: { react: 0.22, error: 64, predict: false, idleCenter: true }, gimmick: { name: 'Rib Toss', desc: 'rattling bones' }, flavor: 'rattle… rattle…', tag: 'Clattering bones held together by spite.' },
  { id: 'gargoyle', name: 'Stone Gargoyle', portrait: '🗿', power: 13, color: '#8a8474', tier: 5, bob: 'float', bot: { react: 0.16, error: 40, predict: true, idleCenter: false }, gimmick: { name: 'Petrify', desc: 'stone wall' }, flavor: '*grinds awake*', tag: 'It was a statue a moment ago. Wasn’t it?' },
  { id: 'wraith', name: 'Cursed Wraith', portrait: '👻', power: 14, color: '#b58fd6', tier: 5, bob: 'float', bot: { react: 0.14, error: 30, predict: true, idleCenter: true }, gimmick: { name: 'Hex', desc: 'inverts you' }, flavor: 'your fate is sealed.', tag: 'It remembers every soul it has taken.' },
  // --- B5 GATEKEEPER: a mini-boss that bars the way to the boss. Sharper than Noam, 5 lives, and the
  //     whole arena is turned 180° the entire fight (his permanent "rotate"). ---
  {
    id: 'clarence', name: 'Clarence, the Gatekeeper', portrait: '🌀', power: 12, color: '#7c5ec0', tier: 5, bob: 'float',
    bot: { react: 0.15, error: 28, predict: true, idleCenter: true }, rotate: 2, lives: 5,
    gimmick: { name: 'Vertigo', desc: 'The entire arena is turned upside-down.' },
    flavor: "you won't reach the boss.", tag: 'He guards the last door. Reality tilts wrong around him.',
  },
];

// ── hand-drawn pixel creatures (per mob id). Built once into offscreen canvases, blitted in the
//    battle gutter. Mobs without a sprite fall back to their emoji portrait. ──
type SRect = [number, number, number, number, number];
const MOB_SPRITES: Record<string, { w: number; h: number; rects: SRect[] }> = {
  bat: { w: 18, h: 13, rects: [
    [1, 4, 6, 3, 0x4a4470], [11, 4, 6, 3, 0x4a4470], [2, 3, 4, 1, 0x4a4470], [12, 3, 4, 1, 0x4a4470], // wings
    [1, 7, 2, 1, 0x332e52], [4, 7, 2, 1, 0x332e52], [12, 7, 2, 1, 0x332e52], [15, 7, 2, 1, 0x332e52], // scalloped tips
    [7, 3, 4, 6, 0x231d33], [7, 1, 1, 2, 0x231d33], [10, 1, 1, 2, 0x231d33],                          // body + ears
    [7, 4, 1, 1, 0xffcf4a], [10, 4, 1, 1, 0xffcf4a], [8, 8, 1, 1, 0xf0f0f0],                           // eyes + fang
  ] },
  slime: { w: 15, h: 13, rects: [
    [5, 2, 5, 1, 0x52ad45], [4, 3, 7, 1, 0x52ad45], [3, 4, 9, 1, 0x52ad45], [2, 5, 11, 5, 0x52ad45],   // dome
    [2, 10, 11, 1, 0x357a2e], [3, 11, 9, 1, 0x357a2e], [4, 3, 2, 2, 0xb8ec98],                          // base + shine
    [5, 6, 2, 2, 0x16301a], [8, 6, 2, 2, 0x16301a], [6, 6, 1, 1, 0xffffff], [9, 6, 1, 1, 0xffffff],     // eyes + glints
    [6, 9, 3, 1, 0x244a1f],                                                                              // mouth
  ] },
};
// Generated creature art (magenta-keyed PNGs in /dungeon). Preloaded; falls back to the pixel
// sprite then the emoji until/if an image is present.
const MOB_IMG: Record<string, HTMLImageElement> = {};
// Source PNGs are large (the hound is 1207×620). Re-sampling that down every frame in drawCreature
// hitches, so we downscale ONCE into a small offscreen canvas on load and blit that cheap copy.
const MOB_SCALED: Record<string, HTMLCanvasElement> = {};
const MOB_CAP = 360; // max px on the long side of the cached copy (plenty for the gutter at any size)
function buildScaled(id: string, im: HTMLImageElement) {
  const s = Math.min(1, MOB_CAP / Math.max(im.naturalWidth, im.naturalHeight));
  const cw = Math.max(1, Math.round(im.naturalWidth * s)), ch = Math.max(1, Math.round(im.naturalHeight * s));
  const cn = document.createElement('canvas'); cn.width = cw; cn.height = ch;
  const c = cn.getContext('2d'); if (!c) return;
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; // smooth ONCE, here
  c.drawImage(im, 0, 0, cw, ch);
  MOB_SCALED[id] = cn;
}
for (const [id, src] of Object.entries({ bat: '/dungeon/mob_bat.png', slime: '/dungeon/mob_slime.png', jsav: '/dungeon/mob_jsav.png', warden: '/dungeon/mob_warden.png', fritz: '/dungeon/mob_fritz.png', hound: '/dungeon/mob_hound.png', noam: '/dungeon/mob_noam.png', josiel: '/dungeon/mob_josiel.png', clarence: '/dungeon/mob_clarence.png' })) {
  const im = new Image(); MOB_IMG[id] = im;
  im.onload = () => buildScaled(id, im);
  im.src = src;
  if (im.complete && im.naturalWidth > 0) buildScaled(id, im); // already cached
}
// the small cached canvas (preferred), else the raw image once it has loaded
function mobImage(id: string): HTMLCanvasElement | HTMLImageElement | null {
  if (MOB_SCALED[id]) return MOB_SCALED[id];
  const im = MOB_IMG[id]; return im && im.complete && im.naturalWidth > 0 ? im : null;
}
const _spriteCache: Record<string, HTMLCanvasElement> = {};
function mobSprite(id: string): HTMLCanvasElement | null {
  const def = MOB_SPRITES[id]; if (!def) return null;
  if (_spriteCache[id]) return _spriteCache[id];
  const c = document.createElement('canvas'); c.width = def.w; c.height = def.h;
  const x = c.getContext('2d')!;
  for (const [rx, ry, rw, rh, col] of def.rects) { x.fillStyle = '#' + col.toString(16).padStart(6, '0'); x.fillRect(rx, ry, rw, rh); }
  _spriteCache[id] = c; return c;
}

export interface EncounterOpts {
  mob: MobDef;
  hp: number;                 // current run HP (0–100)
  coins: [number, number];    // [min, max] coin payout on a win (set per floor by the caller)
  itemChance: number;         // 0–1 chance a win also drops a potion (B1 = 0; deeper floors > 0)
  introImage?: HTMLImageElement | null; // a snapshot of the world, animated into the transition
  potions?: { count: () => number; consume: () => boolean }; // mid-battle potion use (P): heals +10 HP
  capturable?: boolean;       // a "monster box" mob: at its last life, pause and offer a Poké Ball capture
  song?: string;              // override the cycled battle theme with a specific track (Clarence → /battle.mp3)
  onResult: (r: { result: 'win' | 'lose' | 'flee' | 'capture'; coins: number; item: string | null; hpLost: number }) => void;
}

let active = false;
export function isEncounterOpen(): boolean { return active; }

// 4 battle themes, cycled one per encounter (1→2→3→4→1…) so every fight rotates the music.
const BATTLE_THEMES = ['/encounter.mp3', '/encounter2.mp3', '/encounter3.mp3', '/encounter4.mp3'];
let battleThemeIdx = 0;
// Preload + REUSE the audio (don't `new Audio()` per encounter — that decodes the mp3 on the main
// thread at battle start, a random hitch depending on which cycled theme was already cached).
const THEME_AUDIO = BATTLE_THEMES.map((s) => { const a = new Audio(s); a.loop = true; a.volume = 0.6; a.preload = 'auto'; return a; });
const FANFARE = new Audio('/victory.mp3'); FANFARE.volume = 0.85; FANFARE.preload = 'auto';
// Specific boss tracks (e.g. Clarence → /battle.mp3), reused across fights so they don't re-decode.
const SONG_CACHE: Record<string, HTMLAudioElement> = {};
function songFor(url: string): HTMLAudioElement { return SONG_CACHE[url] ??= Object.assign(new Audio(url), { loop: true, volume: 0.6, preload: 'auto' }); }
// One shared AudioContext for the synth blips, created/resumed lazily and never closed (creating &
// closing one per battle also hitches, and browsers cap the number of contexts).
let sharedActx: AudioContext | null = null;
const sharedAc = () => {
  sharedActx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  if (sharedActx.state === 'suspended') void sharedActx.resume();
  return sharedActx;
};

export function startEncounter(opts: EncounterOpts): void {
  if (active) return;
  active = true;
  const { mob } = opts;

  // ── audio: a specific track if the caller asked (boss fights), else the cycled encounter loop ──
  const song = opts.song ? songFor(opts.song) : THEME_AUDIO[battleThemeIdx % THEME_AUDIO.length];
  song.currentTime = 0;
  if (!opts.song) battleThemeIdx++; // only the cycled themes advance the rotation
  const fanfare = FANFARE; fanfare.currentTime = 0;
  const ac = sharedAc;
  const tone = (f: number, dur: number, type: OscillatorType, vol: number, slide?: number) => {
    try {
      const a = ac(), t = a.currentTime, o = a.createOscillator(), g = a.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
      o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
    } catch { /* ignore */ }
  };

  // ── overlay + canvas ──
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#000;overflow:hidden;font-family:ui-monospace,Menlo,monospace;';
  const cv = document.createElement('canvas');
  cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;touch-action:none;';
  overlay.appendChild(cv);
  // "click to capture the mouse" hint (pointer-lock), like the main game / campaign
  const capturePrompt = document.createElement('div');
  capturePrompt.textContent = '🖱️ Click to capture the mouse';
  capturePrompt.style.cssText =
    'position:absolute;left:50%;bottom:54px;transform:translateX(-50%);z-index:2;pointer-events:none;display:none;' +
    'background:#0c1330d8;border:1px solid #4a64a0;border-radius:10px;padding:8px 16px;color:#cfe0ff;' +
    'font:700 14px ui-monospace,monospace;text-shadow:0 1px 3px #000a;';
  overlay.appendChild(capturePrompt);
  document.body.appendChild(overlay);
  const ctx = cv.getContext('2d')!;
  // Static ruins backdrop is rendered ONCE to an offscreen canvas (rebuilt on resize) and blitted
  // each frame — the per-frame brick grid + gradients were the main cause of choppiness.
  const bg = document.createElement('canvas'); const bgx = bg.getContext('2d')!;
  function buildBg() {
    const W = cv.width, H = cv.height; bg.width = W; bg.height = H;
    bgx.fillStyle = '#0a0c0e'; bgx.fillRect(0, 0, W, H);
    bgx.save(); bgx.globalAlpha = 0.5;
    const bh = 26, bw = 56;
    for (let ry = 0, r = 0; ry < H; ry += bh, r++) {
      const off = (r % 2) * (bw / 2);
      for (let rx = -bw; rx < W + bw; rx += bw) {
        bgx.fillStyle = Math.abs(Math.sin(rx * 12.9 + ry * 78.2) * 43758.5) % 1 > 0.5 ? '#15181b' : '#0f1215';
        bgx.fillRect(rx + off, ry, bw - 2, bh - 2);
      }
    }
    bgx.restore();
    for (const fx of [W * 0.08, W * 0.92]) { // baked torch glows in the upper corners
      const g = bgx.createRadialGradient(fx, H * 0.12, 0, fx, H * 0.12, 260);
      g.addColorStop(0, 'rgba(255,150,60,0.26)'); g.addColorStop(1, 'rgba(255,150,60,0)');
      bgx.fillStyle = g; bgx.fillRect(0, 0, W, H);
    }
    const vg = bgx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.6)');
    bgx.fillStyle = vg; bgx.fillRect(0, 0, W, H);
    // Put the static backdrop BEHIND the canvas as a CSS image — the browser composites it once,
    // so the per-frame canvas only clears + draws the lightweight moving stuff (no big blit/upload).
    overlay.style.backgroundImage = `url(${bg.toDataURL()})`;
    overlay.style.backgroundSize = '100% 100%';
  }
  const fit = () => {
    const cw = overlay.clientWidth, chh = overlay.clientHeight;
    const s = Math.min(1, 1500 / Math.max(1, cw)); // cap backing resolution on big screens (fill-rate)
    cv.width = Math.round(cw * s); cv.height = Math.round(chh * s);
    buildBg();
  };
  fit(); window.addEventListener('resize', fit);

  // ── the real Pong sim: you = left, mob = right, first to 3, power-ups off for a clean duel ──
  const game = new Game();
  game.winScore = 999; // the engine never declares a winner; we end it manually (see below)
  game.setExcludedPowerups([
    'grow', 'shrink', 'smash', 'slow', 'multi', 'freeze', 'curve', 'blind', 'mirror', 'shield',
    'ghost', 'tiny', 'warp', 'bigball', 'rotate', 'fritz', 'disco', 'blaster', 'minion',
    'earthquake', 'coins', 'blackout', 'vortex', 'glitch', 'smoke', 'tilt', 'roam',
  ]);
  game.addPlayer('left', 'me');
  game.addPlayer('right', mob.id);
  game.start();
  // A "big paddle" mob gets a permanent paddle-size multiplier (survives between points).
  if (mob.paddleScale) game.paddleScale.right = mob.paddleScale;
  if (mob.roam) game.roamHits.right = Infinity; // Demon Fritz roams permanently (never decrements to 0)
  if (mob.turbo) game.setTurbo(true);           // The Flayed Hound: fast serve + steeper per-hit speedup
  if (mob.mirror) game.mirrorTimer.left = Infinity; // Possessed Noam: permanently invert the player's controls
  if (mob.blaster) game.blasterAmmo.right = Infinity; // Deranged Josiel: never runs out of freezing shots
  if (mob.rotate) game.rotated = mob.rotate;        // Clarence: the whole arena is turned (re-asserted each tick below)
  let fireTimer = (mob.fireRate ?? 1.6) * 1.4;      // delay the first blaster shot a touch
  const mobLives = mob.lives ?? 3; // points you must put past it to kill it
  const POTION_HEAL = 10; let healed = 0; // HP restored by potions drunk mid-battle
  const curHP = () => Math.max(0, Math.min(100, opts.hp - game.score.right * mob.power + healed));
  let lowBeepAt = 0; // throttles the low-HP warning beep

  // player input → target Y (pointer drag / W-S). Stored in court coords.
  let inputY = COURT.h / 2;
  const keys = new Set<string>();
  const onKey = (e: KeyboardEvent, down: boolean) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'w' || k === 's' || k === 'arrowup' || k === 'arrowdown') { down ? keys.add(k) : keys.delete(k); e.preventDefault(); }
    if (down && (k === 'f')) flee();
    if (down && k === 'p') drinkPotion();
  };
  // Drink a potion mid-battle: +10 HP, capped at 100. No-op if you have none or you're already full.
  function drinkPotion() {
    if (phase !== 'fight' || !opts.potions || curHP() >= 100 || opts.potions.count() <= 0) return;
    if (!opts.potions.consume()) return;
    healed += POTION_HEAL;
    tone(523, 0.08, 'square', 0.12, 784); setTimeout(() => tone(784, 0.13, 'square', 0.12, 1046), 80); // heal chime
  }
  const kd = (e: KeyboardEvent) => onKey(e, true), ku = (e: KeyboardEvent) => onKey(e, false);
  window.addEventListener('keydown', kd, true); window.addEventListener('keyup', ku, true);
  // map a screen Y to court Y using the current court rect
  let court = { x: 0, y: 0, w: 0, h: 0 };
  const onPointer = (e: PointerEvent) => {
    if (!court.h) return;
    const yScale = cv.height / Math.max(1, overlay.clientHeight); // client px → canvas px
    if (document.pointerLockElement === cv) { // captured: relative mouse movement drives the paddle
      inputY = Math.max(0, Math.min(COURT.h, inputY + (e.movementY * yScale / court.h) * COURT.h));
    } else { // not captured: the paddle follows the absolute cursor position
      inputY = ((e.clientY * yScale - court.y) / court.h) * COURT.h;
    }
  };
  cv.addEventListener('pointermove', onPointer);
  cv.addEventListener('pointerdown', onPointer);
  // click to capture the mouse (pointer-lock) during the fight; on the result screen a click advances
  const onLockChange = () => { if (document.pointerLockElement !== cv) { /* re-prompt shown by frame() */ } };
  document.addEventListener('pointerlockchange', onLockChange);

  // ── AI: re-aim every `react` seconds toward the ball Y (+ error), optionally predicting the
  //    wall-bounced landing; drift to centre when the ball heads away if idleCenter. ──
  let aiTimer = 0, aiTarget = COURT.h / 2;
  function stepAI(dt: number) {
    aiTimer -= dt;
    const b = game.ball;
    if (aiTimer <= 0) {
      aiTimer = mob.bot.react;
      const movingToward = b.vx > 0;
      if (!movingToward && mob.bot.idleCenter) aiTarget = COURT.h / 2;
      else {
        let y = b.y;
        if (mob.bot.predict && b.vx > 0) {
          const dist = (COURT.w - PADDLE.margin) - b.x;
          const t = b.vx !== 0 ? dist / b.vx : 0;
          y = b.y + b.vy * t;
          const span = COURT.h; y = Math.abs(((y % (2 * span)) + 2 * span) % (2 * span)); if (y > span) y = 2 * span - y;
        }
        aiTarget = y + (Math.random() * 2 - 1) * mob.bot.error;
      }
    }
    // Roam (Demon Fritz): edge off the wall to pressure an incoming ball, but stay home enough that he
    // doesn't lunge past it and leave the goal open (the big paddle covers the rest).
    let inset = 0;
    if (mob.roam && b.vx > 0) {
      const prog = Math.max(0, Math.min(1, (b.x - COURT.w * 0.35) / (COURT.w * 0.6)));
      inset = prog * ROAM.maxInset * 0.5; // modest forward pressure, not a reckless lunge
    }
    game.setTarget('right', mob.id, aiTarget, inset);
    // Blaster (Deranged Josiel): periodically fire a freezing shot aimed at the player's paddle.
    if (mob.blaster && game.disabledTimer.left <= 0) { // don't pile shots on while you're already frozen
      fireTimer -= dt;
      if (fireTimer <= 0) {
        fireTimer = mob.fireRate ?? 1.6;
        const myY = game.paddleYOf('right', mob.id) ?? COURT.h / 2;
        const youY = game.paddleYOf('left', 'me') ?? COURT.h / 2;
        const dx = COURT.w - PADDLE.margin * 2;
        const aim = Math.atan2((youY - myY) + (Math.random() - 0.5) * 90, dx); // lead the player's Y, slight spread
        game.fire('right', aim);
        tone(180, 0.07, 'sawtooth', 0.1, 90); // a nasty little pew
      }
    }
  }

  // ── phases: transition → fight → result (+ the optional capture detour) ──
  type Phase = 'intro' | 'ready' | 'fight' | 'win' | 'lose' | 'capturePrompt' | 'capturing' | 'captured';
  let phase: Phase = 'intro';
  let phaseT = 0;           // seconds in the current phase
  let bannerAlpha = 1;
  let last = performance.now();
  let raf = 0;
  let resultCoins = 0, resultItem: string | null = null;
  // ── capture state (only used when opts.capturable) ──
  let captureDeclined = false;       // said "no" → finish the fight normally
  let captureScale = 1;              // the mob's draw-scale during capture (1 → 0 as it's sucked into the ball)
  const captureMob = { x: 0, y: 0 }; // where the mob sat when the ball flew
  let captureWobbleN = 0;            // wobble click-sounds already fired

  song.play().catch(() => { /* gesture already happened on the world key */ });

  function endBattle(result: 'win' | 'lose' | 'flee' | 'capture') {
    if (!active) return;
    active = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', fit);
    window.removeEventListener('keydown', kd, true); window.removeEventListener('keyup', ku, true);
    window.removeEventListener('keydown', advKey, true); // don't leak the result-advance key listener
    document.removeEventListener('pointerlockchange', onLockChange);
    if (document.pointerLockElement === cv) document.exitPointerLock();
    song.pause(); fanfare.pause(); // audio + context are reused across battles, not torn down
    overlay.remove();
    // net HP lost = starting HP minus where we ended up (potions healed some of it back). A capture
    // costs no extra HP and pays no coins (you get the pet instead).
    opts.onResult({ result, coins: result === 'capture' ? 0 : resultCoins, item: resultItem, hpLost: opts.hp - curHP() });
  }
  function flee() { if (phase === 'fight') { resultCoins = 0; endBattle('flee'); } }

  // ── capture dialogue: a small Yes/No box shown when a capturable mob hits its last life ──
  const captureBox = document.createElement('div');
  captureBox.style.cssText =
    'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:4;display:none;pointer-events:auto;' +
    'min-width:300px;background:#10131c;border:2px solid #3a508f;border-radius:14px;padding:18px 20px;text-align:center;' +
    'box-shadow:0 12px 40px rgba(0,0,0,.6);';
  overlay.appendChild(captureBox);
  function showCaptureDialog() {
    captureBox.replaceChildren();
    const h = document.createElement('div');
    h.innerHTML = `🟢 The <b>${mob.name}</b> has taken a liking to you…`;
    h.style.cssText = 'font-size:17px;color:#eaf0ff;margin-bottom:6px;';
    const s = document.createElement('div');
    s.textContent = "It doesn't want to fight anymore. It just wants to be your friend.";
    s.style.cssText = 'font-size:13px;color:#9fb3e6;margin-bottom:16px;';
    captureBox.append(h, s);
    const mk = (label: string, bg: string, on: () => void) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label;
      b.style.cssText = `display:inline-block;margin:0 6px;cursor:pointer;background:${bg};color:#fff;border:none;border-radius:10px;padding:11px 22px;font-size:15px;font-weight:700;`;
      b.onclick = (e) => { e.stopPropagation(); on(); };
      return b;
    };
    captureBox.append(
      mk('💚 Capture him', '#2e8b57', () => { hideCaptureDialog(); beginCapture(); }),
      mk('🗡️ Kill him anyways', '#7a2520', () => { hideCaptureDialog(); captureDeclined = true; phase = 'fight'; phaseT = 0; song.volume = 0.6; }),
    );
    captureBox.style.display = 'block';
  }
  function hideCaptureDialog() { captureBox.style.display = 'none'; }
  function beginCapture() {
    phase = 'capturing'; phaseT = 0; captureScale = 1; captureWobbleN = 0;
    song.pause();
    tone(140, 0.1, 'square', 0.16, 520); // the throw "whoosh→ping"
  }

  // ── render helpers ──
  function layoutCourt() {
    const W = cv.width, H = cv.height;
    // asymmetric: small left margin, big right gutter to hold the mob creature at a good size
    const topBand = 92, botBand = 64, leftM = Math.max(20, W * 0.035), rightM = Math.max(200, W * 0.18);
    const availW = W - leftM - rightM, availH = H - topBand - botBand;
    const aspect = COURT.w / COURT.h;
    let cw = availW, ch = cw / aspect;
    if (ch > availH) { ch = availH; cw = ch * aspect; }
    court = { x: leftM, y: topBand + (availH - ch) / 2, w: cw, h: ch };
  }
  const cx = (x: number) => court.x + (x / COURT.w) * court.w;
  const cy = (y: number) => court.y + (y / COURT.h) * court.h;

  function drawRuinsBackground() { ctx.clearRect(0, 0, cv.width, cv.height); } // backdrop is a CSS layer behind the canvas

  function drawCourt() {
    // Clarence's "rotate" gimmick: spin the whole court (frame, paddles, ball, projectiles) about its
    // centre. The creature in the gutter is drawn AFTER this (outside the transform) so it stays upright.
    const rot = game.rotated ? game.rotated * Math.PI / 2 : 0;
    ctx.save();
    if (rot) { const ccx = court.x + court.w / 2, ccy = court.y + court.h / 2; ctx.translate(ccx, ccy); ctx.rotate(rot); ctx.translate(-ccx, -ccy); }
    // court frame + mid line
    ctx.strokeStyle = '#3a4a52'; ctx.lineWidth = 3;
    ctx.strokeRect(court.x, court.y, court.w, court.h);
    ctx.setLineDash([8, 10]); ctx.beginPath(); ctx.moveTo(court.x + court.w / 2, court.y); ctx.lineTo(court.x + court.w / 2, court.y + court.h); ctx.stroke(); ctx.setLineDash([]);
    // paddles
    const pw = (PADDLE.w / COURT.w) * court.w;
    const drawPaddle = (side: 'left' | 'right', color: string) => {
      const y = game.paddleYOf(side, side === 'left' ? 'me' : mob.id);
      if (y == null) return;
      const half = game.halfH(side);
      // mirror the engine's roam offset so a roaming paddle is drawn off its wall (Demon Fritz)
      const x = side === 'left' ? PADDLE.margin + game.roamX.left : COURT.w - PADDLE.margin - game.roamX.right;
      ctx.fillStyle = color;
      ctx.fillRect(cx(x) - pw / 2, cy(y - half), pw, (2 * half / COURT.h) * court.h);
    };
    // your paddle goes icy-blue + jitters while frozen by a blaster shot
    const frozen = game.disabledTimer.left > 0;
    drawPaddle('left', frozen ? '#8fdcff' : '#5ad1c0'); drawPaddle('right', mob.color);
    // blaster projectiles — glowing orange-red orbs
    for (const p of game.projectiles) {
      const px = cx(p.x), py = cy(p.y), pr = Math.max(3, (BLASTER.r / COURT.w) * court.w);
      const gr = ctx.createRadialGradient(px, py, 0, px, py, pr * 2.2);
      gr.addColorStop(0, '#fff2c0'); gr.addColorStop(0.4, '#ff8a2a'); gr.addColorStop(1, 'rgba(255,60,20,0)');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(px, py, pr * 2.2, 0, 7); ctx.fill();
      ctx.fillStyle = '#fff7d8'; ctx.beginPath(); ctx.arc(px, py, pr * 0.7, 0, 7); ctx.fill();
    }
    // ball(s)
    ctx.fillStyle = '#fff';
    for (const b of [game.ball, ...game.extraBalls]) {
      ctx.beginPath(); ctx.arc(cx(b.x), cy(b.y), Math.max(3, (8 / COURT.w) * court.w), 0, 7); ctx.fill();
    }
    if (frozen) { // a little "FROZEN" tag by your paddle
      const yY = game.paddleYOf('left', 'me') ?? COURT.h / 2;
      ctx.fillStyle = '#bdeaff'; ctx.font = 'bold 13px ui-monospace'; ctx.textAlign = 'left';
      ctx.fillText('❄ FROZEN', cx(PADDLE.margin) + 8, cy(yY));
    }
    ctx.restore(); // end the rotate transform — the creature (next) stays upright
    drawCreature();
  }
  // the mob sits in the right gutter, just behind its paddle, bobbing by its personality
  function drawCreature() {
    const t = performance.now() / 1000;
    const right = court.x + court.w, gutter = cv.width - right, cxp = right + gutter * 0.5;
    const py = game.paddleYOf('right', mob.id);
    let baseY = py != null ? cy(py) : court.y + court.h / 2;
    let ox = 0, oy = 0, sx = 1, sy = 1;
    if (mob.bob === 'flutter') { ox = Math.sin(t * 17) * 4; oy = Math.sin(t * 12 + 1) * 6; }
    else if (mob.bob === 'squish') { const s = Math.sin(t * 2.6); oy = (1 - Math.abs(s)) * 5; sy = 1 + s * 0.12; sx = 1 - s * 0.08; }
    else { oy = Math.sin(t * 1.6) * 7; }
    captureMob.x = cxp; captureMob.y = baseY; // remembered so a Poké Ball knows where to fly
    if (captureScale <= 0.02) return;          // sucked into the ball — don't draw the creature
    const img = mobImage(mob.id);
    if (img) { // generated art — fit to a tall target, constrained by the gutter width
      const iw = img instanceof HTMLCanvasElement ? img.width : img.naturalWidth;
      const ih = img instanceof HTMLCanvasElement ? img.height : img.naturalHeight;
      ctx.imageSmoothingEnabled = true; // blitting the small cached copy — cheap + clean
      const scale = Math.min((court.h * 0.36) / ih, (gutter * 0.96) / iw);
      const dw = iw * scale, dh = ih * scale;
      baseY = Math.max(court.y + dh / 2, Math.min(court.y + court.h - dh / 2, baseY));
      ctx.save(); ctx.translate(cxp + ox, baseY + oy); ctx.scale(sx * captureScale, sy * captureScale);
      ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh); ctx.restore();
      return;
    }
    ctx.imageSmoothingEnabled = false;
    const size = Math.min(court.h * 0.26, gutter * 0.95);
    ctx.save(); ctx.translate(cxp + ox, baseY + oy); ctx.scale(sx, sy);
    const spr = mobSprite(mob.id);
    if (spr) { const sc = Math.min(size / spr.height, (gutter * 0.92) / spr.width); ctx.drawImage(spr, -spr.width * sc / 2, -spr.height * sc / 2, spr.width * sc, spr.height * sc); }
    else { ctx.font = `${size}px serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(mob.portrait, 0, 0); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; }
    ctx.restore();
  }

  function drawHud() {
    const W = cv.width;
    // mob enemy box (top-right band)
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const bx = W - 256, by = 14, bw = 240, bh = 82;
    ctx.fillStyle = '#0c0a12ee'; ctx.strokeStyle = '#c9a227'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 10); ctx.fill(); ctx.stroke();
    ctx.font = '30px serif'; ctx.fillText(mob.portrait, bx + 12, by + 26);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 15px ui-monospace'; ctx.fillText(mob.name, bx + 54, by + 18);
    for (let i = 0; i < mobLives; i++) { ctx.fillStyle = i < (mobLives - game.score.left) ? '#d23a3a' : '#3a2030'; ctx.beginPath(); ctx.arc(bx + 60 + i * 15, by + 38, 6, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#c9a227'; ctx.font = 'bold 11px ui-monospace'; ctx.fillText(`✦ ${mob.gimmick.name}`, bx + 12, by + 58);
    ctx.fillStyle = '#9a90b0'; ctx.font = '10px ui-monospace'; ctx.fillText(mob.gimmick.desc, bx + 12, by + 72);
    // banner top-left, fades — name then a bestiary line
    if (bannerAlpha > 0.02) {
      ctx.globalAlpha = bannerAlpha;
      ctx.fillStyle = '#fff'; ctx.font = 'bold 20px ui-monospace'; ctx.fillText(`A wild ${mob.name} appeared!`, 18, 28);
      ctx.fillStyle = '#cdb98a'; ctx.font = 'italic 13px ui-monospace'; ctx.fillText(mob.tag, 18, 50);
      ctx.globalAlpha = 1;
    }
    // the creature's "cry" — its flavor line floats beside it as it appears, fading with the banner
    if (bannerAlpha > 0.02 && mob.flavor) {
      const right = court.x + court.w, gutter = W - right, cxp = right + gutter * 0.5;
      ctx.globalAlpha = bannerAlpha;
      ctx.textAlign = 'center'; ctx.font = 'italic bold 16px ui-monospace';
      const quote = `“${mob.flavor}”`, tw = ctx.measureText(quote).width, qy = court.y + 16;
      ctx.fillStyle = '#0c0a12d0'; ctx.strokeStyle = '#5a4a6a'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(cxp - tw / 2 - 12, qy - 16, tw + 24, 27, 9); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#e6d2a8'; ctx.fillText(quote, cxp, qy);
      ctx.textAlign = 'left'; ctx.globalAlpha = 1;
    }
    // your HP (bottom band) — turns red + flashes when low (≤15%); potions shown to its right
    const hp = curHP();
    const hx = 18, hy = cv.height - 40, hw = 240;
    const frac = hp / 100, low = frac <= 0.15 && hp > 0;
    ctx.fillStyle = '#9a90b0'; ctx.font = '11px ui-monospace'; ctx.fillText('YOUR HP', hx, hy - 8);
    ctx.fillStyle = '#2a1620'; ctx.strokeStyle = low ? '#ff5a5a' : '#5a2530'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(hx, hy, hw, 14, 7); ctx.fill(); ctx.stroke();
    // bar color: green → amber → red; when low it pulses
    const pulse = low ? 0.55 + 0.45 * Math.abs(Math.sin(performance.now() / 140)) : 1;
    ctx.fillStyle = low ? `rgba(255,60,60,${pulse})` : frac <= 0.35 ? '#e8b23a' : '#46d06a';
    ctx.beginPath(); ctx.roundRect(hx + 1, hy + 1, Math.max(0, (hw - 2) * frac), 12, 6); ctx.fill();
    // potions held, to the right of the bar (drink with P, mid-battle)
    const pc = opts.potions ? opts.potions.count() : 0;
    ctx.fillStyle = pc > 0 ? '#cdb98a' : '#5a5266'; ctx.font = 'bold 13px ui-monospace'; ctx.textBaseline = 'middle';
    ctx.fillText(`🧪 ×${pc}  (P)`, hx + hw + 14, hy + 7); ctx.textBaseline = 'alphabetic';
    // flee hint
    ctx.fillStyle = '#6f6688'; ctx.font = '11px ui-monospace'; ctx.textAlign = 'right';
    ctx.fillText('F to flee', W - 18, cv.height - 16); ctx.textAlign = 'left';
  }

  // Pokémon Gen-3 style transition: flash the captured world, then split it into horizontal strips
  // that fly apart (alternating directions) revealing black, before the battle resolves in.
  const introImage = opts.introImage || null;
  function drawIntro() {
    const W = cv.width, H = cv.height, p = phaseT;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const haveImg = !!introImage && introImage.complete && introImage.naturalWidth > 0;
    if (p < 0.45) {
      if (haveImg) ctx.drawImage(introImage!, 0, 0, W, H);
      if (p > 0.1 && Math.floor((p - 0.1) / 0.09) % 2 === 0) { ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillRect(0, 0, W, H); } // strobe
    } else if (haveImg) {
      const t = Math.min(1, (p - 0.45) / 0.95), ease = t * t; // strips accelerate off-screen
      const strips = 16, srcH = introImage!.naturalHeight / strips, dH = H / strips;
      for (let i = 0; i < strips; i++) {
        const dx = (i % 2 ? 1 : -1) * ease * (W * 1.15);
        ctx.drawImage(introImage!, 0, i * srcH, introImage!.naturalWidth, srcH, dx, i * dH, W, dH + 1);
      }
    } else if (p > 0.45) { // no snapshot → just a quick bar wipe to black
      const q = Math.min(1, (p - 0.45) / 0.5), bars = 12, bh = H / bars;
      ctx.fillStyle = '#000';
      for (let i = 0; i < bars; i++) { const w = W * q; ctx.fillRect(i % 2 ? W - w : 0, i * bh, w, bh + 1); }
    }
  }

  function drawResult() {
    const W = cv.width, won = phase === 'win';
    ctx.fillStyle = '#0c1330ee'; const bw = Math.min(560, W - 40), bx = (W - bw) / 2, by = cv.height - 150;
    ctx.strokeStyle = '#e8eefc'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.roundRect(bx, by, bw, 96, 14); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#e8b84b'; ctx.beginPath(); ctx.roundRect(bx + 16, by - 13, 110, 24, 8); ctx.fill();
    ctx.fillStyle = '#1a1408'; ctx.font = 'bold 13px ui-monospace'; ctx.fillText(won ? 'VICTORY!' : 'DEFEAT…', bx + 26, by - 1);
    ctx.fillStyle = '#eef2ff'; ctx.font = '18px ui-monospace'; ctx.textBaseline = 'top';
    const lines = won
      ? [`You beat the ${mob.name}!`, `Earned ${resultCoins}🪙${resultItem ? '  +  ' + resultItem : ''}`]
      : [`The ${mob.name} finished you off…`, `Your HP ran out.`];
    lines.forEach((s, i) => ctx.fillText(s, bx + 20, by + 18 + i * 26));
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9fd1ff'; ctx.font = '15px ui-monospace'; ctx.textAlign = 'right';
    ctx.fillText('▼ click / Space', bx + bw - 16, by + 80); ctx.textAlign = 'left';
  }

  // advance result on click / space
  const isResult = () => phase === 'win' || phase === 'lose' || phase === 'captured';
  const advance = () => { if (isResult()) endBattle(phase === 'win' ? 'win' : phase === 'captured' ? 'capture' : 'lose'); };
  const onOverlayClick = () => {
    if (isResult()) { advance(); return; }                                // result screen → continue
    if (phase === 'fight' && document.pointerLockElement !== cv) cv.requestPointerLock(); // capture the mouse
  };
  overlay.addEventListener('click', onOverlayClick);
  const advKey = (e: KeyboardEvent) => { if ((e.key === ' ' || e.key === 'Enter') && isResult()) { e.preventDefault(); advance(); } };
  window.addEventListener('keydown', advKey, true);

  // ── Poké Ball capture animation (phase 'capturing'): ball flies in → mob sucks down → wobble → caught
  function drawBall(x: number, y: number, r: number, rot: number, openF = 0) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.lineWidth = Math.max(1.5, r * 0.12);
    const split = openF * r * 0.9;
    ctx.fillStyle = '#f3f3f5'; ctx.beginPath(); ctx.arc(0, split, r, 0, Math.PI); ctx.fill();        // white bottom
    ctx.fillStyle = '#e23b2e'; ctx.beginPath(); ctx.arc(0, -split, r, Math.PI, Math.PI * 2); ctx.fill(); // red top
    ctx.strokeStyle = '#15151a';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();                                 // outline
    if (openF < 0.5) { // closed: the band + button
      ctx.fillStyle = '#15151a'; ctx.fillRect(-r, -r * 0.13, r * 2, r * 0.26);
      ctx.beginPath(); ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#f3f3f5'; ctx.beginPath(); ctx.arc(0, 0, r * 0.15, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  function drawCapture() {
    const mx = captureMob.x, my = captureMob.y;
    const restX = court.x + court.w * 0.5, restY = court.y + court.h * 0.74; // where the ball lands + wobbles
    const r = Math.max(12, court.h * 0.05);
    // 0.0–0.5 throw   0.5–0.95 suck-in   0.95–2.3 wobble   2.3+ caught
    if (phaseT < 0.5) {
      captureScale = 1;
      const f = phaseT / 0.5;
      const bx = court.x + court.w * 0.12 + (mx - (court.x + court.w * 0.12)) * f;
      const by = (court.y + court.h + 40) + (my - (court.y + court.h + 40)) * f - Math.sin(f * Math.PI) * court.h * 0.4; // an arc
      drawBall(bx, by, r, f * 12);
    } else if (phaseT < 0.95) {
      const f = (phaseT - 0.5) / 0.45;
      captureScale = 1 - f;
      // a red suck-in beam from the open ball to the dwindling mob
      ctx.save(); ctx.globalAlpha = 0.55; ctx.strokeStyle = '#ff5a4a'; ctx.lineWidth = 6 * (1 - f);
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx, my - r); ctx.stroke(); ctx.restore();
      drawBall(mx, my, r, 0.8); // open at the mob
    } else {
      captureScale = 0;
      const wob = phaseT - 0.95, settled = Math.min(1, wob / 0.4);
      const bx = mx + (restX - mx) * settled, by = my + (restY - my) * settled; // drop to rest
      const wobble = wob > 0.4 ? Math.sin((wob - 0.4) * 9) * Math.max(0, 1 - (wob - 0.4) / 1.0) * 0.5 : 0;
      drawBall(bx, by, r, 0);
      // a settle "click" on each wobble swing (3 of them), then "Gotcha!"
      const swings = Math.floor((wob - 0.4) * 9 / Math.PI);
      if (wob > 0.4 && swings > captureWobbleN && captureWobbleN < 3) { captureWobbleN = swings; tone(420, 0.05, 'square', 0.12, 300); }
      ctx.save(); ctx.translate(bx, by); ctx.rotate(wobble); ctx.translate(-bx, -by); ctx.restore();
      if (phaseT >= 2.3) { // caught!
        phase = 'captured'; phaseT = 0; resultCoins = 0;
        fanfare.currentTime = 0; fanfare.play().catch(() => {});
        tone(660, 0.09, 'square', 0.12, 990); setTimeout(() => tone(990, 0.16, 'square', 0.12, 1320), 110);
      }
    }
  }
  function drawCaptureResult() { // "Gotcha!" panel, mirrors drawResult's layout
    const W = cv.width, bw = Math.min(440, W * 0.8), bh = 132, bx = (W - bw) / 2, by = cv.height * 0.62;
    ctx.fillStyle = 'rgba(8,12,20,.92)'; ctx.strokeStyle = '#4a7a3a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 14); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#7ed957'; ctx.beginPath(); ctx.roundRect(bx + 16, by - 13, 130, 24, 8); ctx.fill();
    ctx.fillStyle = '#0e1a08'; ctx.font = 'bold 13px ui-monospace'; ctx.fillText('GOTCHA!', bx + 26, by - 1);
    ctx.fillStyle = '#eef2ff'; ctx.font = '18px ui-monospace'; ctx.textBaseline = 'top';
    [`${mob.name} was caught!`, `It joins you as a pet — escape to keep it!`].forEach((s, i) => ctx.fillText(s, bx + 20, by + 18 + i * 26));
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9fd1ff'; ctx.font = '15px ui-monospace'; ctx.textAlign = 'right';
    ctx.fillText('▼ click / Space', bx + bw - 16, by + 80); ctx.textAlign = 'left';
  }

  function frame() {
    const now = performance.now(), dt = Math.min(0.033, (now - last) / 1000); last = now;
    phaseT += dt;
    layoutCourt();

    if (phase === 'fight') {
      // player input
      if (keys.has('w') || keys.has('arrowup')) inputY -= PADDLE.speed * dt;
      if (keys.has('s') || keys.has('arrowdown')) inputY += PADDLE.speed * dt;
      game.setTarget('left', 'me', inputY);
      // the engine clears mirror/blaster/rotate on every scored point — re-assert these baked-in gimmicks
      if (mob.mirror) game.mirrorTimer.left = Infinity;
      if (mob.blaster) game.blasterAmmo.right = Infinity;
      if (mob.rotate) game.rotated = mob.rotate;
      stepAI(dt);
      const beforeL = game.score.left, beforeR = game.score.right;
      game.tick(dt);
      if (game.score.left > beforeL || game.score.right > beforeR) tone(game.score.left > beforeL ? 660 : 200, 0.08, 'square', 0.1, game.score.left > beforeL ? 880 : 120);
      bannerAlpha = Math.max(0, 1 - Math.max(0, phaseT - 1.4) / 0.6);
      // mobLives points kills the mob (win). The mob never wins — it just chips your run HP each
      // point, and you fight on until that HP runs out (death). Potions (P) heal you mid-fight.
      // A capturable "monster box" mob, brought to its LAST life, pauses for the Poké Ball offer.
      if (opts.capturable && !captureDeclined && game.score.left >= 1 && game.score.left === mobLives - 1) {
        phase = 'capturePrompt'; phaseT = 0;
        if (document.pointerLockElement === cv) document.exitPointerLock();
        song.volume = 0.3;
        tone(880, 0.1, 'square', 0.1, 1180); // a little "!" sting
        showCaptureDialog();
      }
      else if (game.score.left >= mobLives) { phase = 'win'; phaseT = 0; resultCoins = opts.coins[0] + Math.floor(Math.random() * (opts.coins[1] - opts.coins[0] + 1)); resultItem = Math.random() < opts.itemChance ? '🧪 Potion' : null; fanfare.currentTime = 0; song.pause(); fanfare.play().catch(() => {}); }
      else if (curHP() <= 0) { phase = 'lose'; phaseT = 0; song.pause(); tone(160, 0.5, 'sawtooth', 0.18, 70); }
      // low-HP warning: a Pokémon-style beep every ~0.6s while you're in the red
      if (curHP() > 0 && curHP() / 100 <= 0.15 && now - lowBeepAt > 600) { lowBeepAt = now; tone(950, 0.09, 'square', 0.09, 950); }
    }

    // ── draw ──
    if (phase === 'intro') {
      drawIntro(); // captured world → flash → strips fly apart
      if (phaseT >= 1.5) { phase = 'ready'; phaseT = 0; } // then hold a beat before the serve
    } else {
      drawRuinsBackground();
      drawCourt(); drawHud();
      if (phase === 'ready' && phaseT >= 1.8) { phase = 'fight'; phaseT = 0; } // read the matchup, then serve
      if (phase === 'win' || phase === 'lose') drawResult();
      if (phase === 'capturing') drawCapture();
      if (phase === 'captured') drawCaptureResult();
    }
    // show the "click to capture" hint only while fighting un-captured
    const wantPrompt = phase === 'fight' && document.pointerLockElement !== cv ? 'block' : 'none';
    if (capturePrompt.style.display !== wantPrompt) capturePrompt.style.display = wantPrompt;

    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
}
