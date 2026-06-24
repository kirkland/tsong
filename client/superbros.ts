// Super Tsong Bros — a 2–4 player PvP platform fighter (Smash-like), launched from the Arcade
// menu. Like Nuketown it is deliberately isolated: its own fullscreen overlay, canvas, input
// handlers and game loop, all torn down on exit. It never touches the Pong game state.
//
// Netcode is host-authoritative over a dumb broadcast relay (see the server Lobby's sb* methods):
// the server only runs the up-to-4 lobby (+ per-slot fighter pick + the all-locked start gate)
// and an opaque fan-out. The actual sim runs HERE. Slot 0 (the first joiner) is the host: it
// simulates EVERY fighter (its own from local input, the rest from relayed input messages),
// resolves melee/projectiles/knockback/stocks/respawns, and streams `{t:'st'}` snapshots ~30/s.
// Guests send `{t:'in'}` input ~30/s (with fireSeq-style edge counters for melee/projectile/jump)
// and render from the host's snapshots. Engine is a hand-rolled 2D Canvas platformer (no Phaser).

import {
  FIGHTERS, STAGES, Fighter, Stage,
  SB_STAGE_W, SB_STAGE_H, SB_STOCKS, SB_MAX_PLAYERS, SB_MIN_PLAYERS,
} from '../shared/types';

// --- jsav image asset (fighter sprite for jsav) ---
const jsavImg = new Image();
jsavImg.src = '/jsav.jpg';
const jsavReady = () => jsavImg.complete && jsavImg.naturalWidth > 0;

// =====================================================================================
// Tuning: convert 1–10 feel-scale stats → engine units. Stage-space is 1280×720; gravity etc.
// are all in px/s. These were hand-picked for clear variety; first PvP cut — expect to retune.
// =====================================================================================
const GRAVITY = 1900;            // px/s² downward
const RUN_BASE = 220;            // px/s at speed 1
const RUN_PER = 38;              // +px/s per speed point
const JUMP_BASE = 540;           // jump impulse at jump 1 (px/s up)
const JUMP_PER = 38;             // +impulse per jump point
const DOUBLE_JUMP_FACTOR = 0.92; // 2nd jump strength relative to first
const RECOVERY_FACTOR = 1.05;    // up-burst recovery strength relative to first jump (scaled by jump stat)
const FALL_BASE = 1400;          // terminal fall speed at fallSpeed 1
const FALL_PER = 90;             // +terminal per fallSpeed point
const FAST_FALL_MULT = 1.8;      // fast-fall multiplier on terminal velocity
const AIR_DRIFT = 0.55;          // air control vs ground (fraction of run accel)
const GROUND_ACCEL = 14;         // approach factor toward target velocity on the ground (per tick @60)
const FRICTION = 0.80;           // ground friction when no input
const WEIGHT_BASE = 0.7;         // knockback divisor base (so weight 5 ≈ 1.0)
const KB_BASE = 280;             // base knockback speed
const KB_SCALE = 9.2;            // knockback added per damage-% point
const STR_BASE = 0.55;           // attacker strength → knockback multiplier base
const STR_PER = 0.09;            // +mult per strength point
const RESPAWN_INVULN = 1.5;      // seconds of invulnerability after respawn
const RESPAWN_DELAY = 1.0;       // seconds before respawn after a ring-out
const HITSTUN_PER_KB = 0.0012;   // seconds of hitstun per knockback px/s

function fighterById(id: string | null | undefined): Fighter {
  return FIGHTERS.find((f) => f.id === id) ?? FIGHTERS[0];
}
function bodyW(f: Fighter): number { return 22 + f.size * 4.2; }
function bodyH(f: Fighter): number { return 40 + f.size * 6.0; }
function runSpeed(f: Fighter): number { return RUN_BASE + f.speed * RUN_PER; }
function jumpImpulse(f: Fighter): number { return JUMP_BASE + f.jump * JUMP_PER; }
function termVel(f: Fighter): number { return FALL_BASE + f.fallSpeed * FALL_PER; }
function weightDiv(f: Fighter): number { return WEIGHT_BASE + f.weight * 0.06; }
function strMult(f: Fighter): number { return STR_BASE + f.strength * STR_PER; }

// --- networking hook into the host websocket (provided by main.ts), mirroring NuketownNet ---
export interface SuperBrosNet {
  join(): void;
  leave(): void;
  pick(fighter: string): void;
  start(): void;
  end(winner: number): void; // (host only) report the winning slot so the server pays them
  relay(data: unknown): void;
  name(): string; // this client's display name
}

// Lobby message shape pushed from the server (matches shared/types SbLobbyMsg).
interface SbLobby {
  status: 'waiting' | 'playing' | 'ended';
  slot: number;
  hostSlot: number;
  players: { name: string; slot: number; fighter: string | null }[];
}

// The running instance feeds server messages back to itself through these module-level hooks,
// which main.ts calls when an sb* message arrives.
let handlers: {
  lobby: (m: SbLobby) => void;
  relay: (d: unknown) => void;
} | null = null;
export function feedSbLobby(m: SbLobby) { handlers?.lobby(m); }
export function feedSbRelay(d: unknown) { handlers?.relay(d); }

function escapeText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

// Per-fighter player colors (also drives select-screen swatches where useImage is false).
const SLOT_RING = ['#ffe14d', '#5cd1ff', '#ff7a7a', '#9dff7a']; // P1..P4 nameplate / ring tint

let sbOpen = false;

export function startSuperBros(net: SuperBrosNet): void {
  if (sbOpen) return;
  sbOpen = true;

  type Mode = 'menu' | 'lobby' | 'play' | 'ended';
  let mode: Mode = 'menu';
  let selfSlot = 0;
  let isHost = false;
  let lobbyState: SbLobby | null = null;
  let myPick: string | null = null;       // fighter I've locked (mirrors lobby)
  let stageIdx = 0;                        // chosen stage (host picks; sent in start snapshot)

  // --- DOM overlay (cloned from nuketown.ts, recoloured for a brawler) ---
  const overlay = document.createElement('div');
  overlay.id = 'superbrosOverlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:9999;background:#0a0a12;display:flex;align-items:center;' +
    'justify-content:center;flex-direction:column;font-family:ui-monospace,monospace;';

  const canvas = document.createElement('canvas');
  canvas.width = SB_STAGE_W; canvas.height = SB_STAGE_H;
  canvas.style.cssText =
    'image-rendering:pixelated;height:90vh;max-width:100vw;aspect-ratio:16/9;background:#000;';
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  overlay.appendChild(canvas);

  // Top banner (VICTORY / DEFEAT / respawn etc).
  const banner = document.createElement('div');
  banner.style.cssText =
    'position:absolute;inset:0;display:none;align-items:center;justify-content:center;' +
    'font:900 64px ui-monospace,monospace;color:#ffd166;text-shadow:5px 5px 0 #000;' +
    'text-align:center;white-space:pre;pointer-events:none;';
  overlay.appendChild(banner);

  const title = document.createElement('div');
  title.style.cssText =
    'position:absolute;top:8px;left:0;right:0;text-align:center;font:700 13px ui-monospace,monospace;' +
    'color:#9fb0d8;text-shadow:1px 1px 0 #000;pointer-events:none;';
  title.textContent = '←/→ move · W/Space jump (×2 + recovery) · ↓ fast-fall/drop · J/click melee · K projectile · ESC quit';
  overlay.appendChild(title);

  // --- menu / lobby / character-select layer ---
  const menu = document.createElement('div');
  menu.style.cssText =
    'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:safe center;gap:18px;padding:3vh 16px;overflow-y:auto;background:rgba(8,8,18,0.92);';
  const menuTitle = document.createElement('div');
  menuTitle.textContent = '🥊 SUPER TSONG BROS';
  menuTitle.style.cssText = 'font:900 50px ui-monospace,monospace;color:#ff7a4f;text-shadow:4px 4px 0 #311;';
  const menuMsg = document.createElement('div');
  menuMsg.style.cssText = 'font:700 16px ui-monospace,monospace;color:#9fb0d8;min-height:20px;text-align:center;';
  const menuInfo = document.createElement('div');
  menuInfo.style.cssText =
    'max-width:560px;font:600 13px ui-monospace,monospace;color:#9fb0d8;line-height:1.7;text-align:center;';
  menuInfo.innerHTML =
    '<div style="color:#cdd7f5;font-weight:700;margin-bottom:4px">FREE-FOR-ALL · 2–4 players · 3 stocks each</div>' +
    'Join, pick your fighter and lock in. Once <b>everyone</b> has locked and there are ≥2 players, the host ' +
    'starts the match. No HP — rack up <b>damage %</b> on your rivals, then launch them off the edge. ' +
    'Last fighter standing wins (and earns coins).';

  const mkBtn = (label: string) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'font:700 18px ui-monospace,monospace;padding:12px 22px;border-radius:8px;cursor:pointer;' +
      'border:1px solid #6a3a22;background:#1f130b;color:#ff9d4f;';
    b.onmouseenter = () => { b.style.background = '#2a1a0e'; };
    b.onmouseleave = () => { b.style.background = '#1f130b'; };
    return b;
  };
  const joinBtn = mkBtn('JOIN');
  const startBtn = mkBtn('START');
  const leaveBtn = mkBtn('LEAVE');
  const exitBtn = mkBtn('EXIT');
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;justify-content:center;';
  btnRow.append(joinBtn, startBtn, leaveBtn, exitBtn);

  // Character-select grid (only shown in the lobby): clickable fighter cards.
  const selectWrap = document.createElement('div');
  selectWrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;';
  const selectLabel = document.createElement('div');
  selectLabel.style.cssText = 'font:700 14px ui-monospace,monospace;color:#cdd7f5;';
  selectLabel.textContent = 'PICK YOUR FIGHTER';
  const selectGrid = document.createElement('div');
  selectGrid.style.cssText =
    'display:flex;gap:10px;flex-wrap:wrap;justify-content:center;max-width:760px;';
  // Stage picker (host only).
  const stageRow = document.createElement('div');
  stageRow.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;justify-content:center;align-items:center;';
  selectWrap.append(selectLabel, selectGrid, stageRow);

  // Roster: who's in + their pick + a ✓ when locked.
  const roster = document.createElement('div');
  roster.style.cssText =
    'display:flex;gap:24px;justify-content:center;flex-wrap:wrap;min-height:40px;font:700 14px ui-monospace,monospace;' +
    'text-shadow:1px 1px 0 #000;';

  menu.append(menuTitle, menuMsg, btnRow, roster, selectWrap, menuInfo);
  overlay.appendChild(menu);
  document.body.appendChild(overlay);

  // Build the select cards once.
  const cardEls: HTMLButtonElement[] = [];
  for (const f of FIGHTERS) {
    const card = document.createElement('button');
    card.style.cssText =
      'width:108px;display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 6px;' +
      'border-radius:8px;border:2px solid #2a2a3a;background:#13131f;cursor:pointer;color:#cdd7f5;';
    const sw = document.createElement('canvas');
    sw.width = 48; sw.height = 56;
    sw.style.cssText = 'width:48px;height:56px;image-rendering:pixelated;';
    const swc = sw.getContext('2d')!;
    swc.imageSmoothingEnabled = false;
    drawPortrait(swc, f, 48, 56);
    const nm = document.createElement('div');
    nm.style.cssText = 'font:800 12px ui-monospace,monospace;';
    nm.textContent = f.name;
    const bl = document.createElement('div');
    bl.style.cssText = 'font:600 9px ui-monospace,monospace;color:#8a93b5;line-height:1.2;min-height:22px;';
    bl.textContent = f.blurb;
    card.append(sw, nm, bl);
    card.onclick = () => {
      if (mode !== 'lobby') return;
      myPick = f.id;
      net.pick(f.id);
      syncSelectCards();
    };
    selectGrid.appendChild(card);
    cardEls.push(card);
  }
  function syncSelectCards() {
    cardEls.forEach((c, i) => {
      const sel = myPick === FIGHTERS[i].id;
      c.style.borderColor = sel ? '#ffd166' : '#2a2a3a';
      c.style.background = sel ? '#22210f' : '#13131f';
    });
  }

  // Stage picker buttons (host only chooses; others see it disabled).
  const stageBtns: HTMLButtonElement[] = [];
  {
    const lbl = document.createElement('span');
    lbl.style.cssText = 'font:700 12px ui-monospace,monospace;color:#8a93b5;';
    lbl.textContent = 'STAGE:';
    stageRow.appendChild(lbl);
    STAGES.forEach((s, i) => {
      const b = document.createElement('button');
      b.textContent = s.name;
      b.style.cssText =
        'font:700 11px ui-monospace,monospace;padding:6px 10px;border-radius:6px;cursor:pointer;' +
        'border:1px solid #334;background:#13131f;color:#9fb0d8;';
      b.onclick = () => { if (selfSlot === 0) { stageIdx = i; syncStageBtns(); } };
      stageRow.appendChild(b);
      stageBtns.push(b);
    });
  }
  function syncStageBtns() {
    stageBtns.forEach((b, i) => {
      b.style.borderColor = stageIdx === i ? '#ffd166' : '#334';
      b.style.background = stageIdx === i ? '#22210f' : '#13131f';
      b.style.display = selfSlot === 0 ? '' : (stageIdx === i ? '' : 'none');
      b.disabled = selfSlot !== 0;
    });
  }

  function renderRoster() {
    const ps = lobbyState?.players ?? [];
    roster.innerHTML = ps.map((p) => {
      const f = p.fighter ? fighterById(p.fighter) : null;
      const ring = SLOT_RING[p.slot % SLOT_RING.length];
      const pick = f
        ? `<span style="color:${f.color}">${escapeText(f.name)}</span> ✓`
        : '<span style="color:#6b7796">picking…</span>';
      return `<div style="color:${ring}">P${p.slot + 1} ${escapeText(p.name)}${p.slot === 0 ? ' 👑' : ''}<br>` +
        `<span style="font-size:12px">${pick}</span></div>`;
    }).join('') || '<div style="color:#6b7796">—</div>';
  }

  function syncMenuButtons() {
    joinBtn.style.display = mode === 'menu' ? '' : 'none';
    exitBtn.style.display = mode === 'menu' ? '' : 'none';
    leaveBtn.style.display = mode === 'lobby' ? '' : 'none';
    selectWrap.style.display = mode === 'lobby' ? 'flex' : 'none';
    const players = lobbyState?.players ?? [];
    const allLocked = players.length >= SB_MIN_PLAYERS && players.every((p) => p.fighter);
    const canStart = mode === 'lobby' && selfSlot === 0 && allLocked;
    startBtn.style.display = mode === 'lobby' && selfSlot === 0 ? '' : 'none';
    startBtn.disabled = !canStart;
    startBtn.style.opacity = canStart ? '1' : '0.5';
    startBtn.style.cursor = canStart ? 'pointer' : 'default';
    if (mode === 'lobby') {
      const n = players.length;
      if (n < SB_MIN_PLAYERS) {
        menuMsg.textContent = `Waiting for players… (${n}/${SB_MAX_PLAYERS}, need ${SB_MIN_PLAYERS})`;
      } else if (!allLocked) {
        menuMsg.textContent = 'Waiting for everyone to pick…';
      } else {
        menuMsg.textContent = selfSlot === 0
          ? `Everyone's locked in — press START! (${n}/${SB_MAX_PLAYERS})`
          : `Locked & loaded — waiting for the host to start… (${n}/${SB_MAX_PLAYERS})`;
      }
    }
  }

  // =====================================================================================
  // World / sim state
  // =====================================================================================
  interface Proj {
    slot: number; x: number; y: number; vx: number; vy: number;
    life: number; dmg: number; kbStr: number; arc: 'straight' | 'lob' | 'bounce'; bounces: number;
    kind: string; // fighter id (for art)
  }
  interface FighterState {
    slot: number; name: string; fid: string;
    x: number; y: number; vx: number; vy: number;
    facing: number;          // -1 left / +1 right
    onGround: boolean;
    jumps: number;           // jumps used since last grounded (0,1; 2 triggers recovery)
    usedRecovery: boolean;   // up-burst used this airtime
    dropTimer: number;       // brief pass-through suppression after dropping down
    dmg: number;             // damage % (0..)
    stocks: number;
    invuln: number;          // invuln seconds (respawn)
    respawnIn: number;       // >0 while waiting to respawn (eliminated stays -1)
    eliminated: boolean;
    hitstun: number;         // seconds locked out of control after a hit
    meleeCd: number;         // melee cooldown / active timer
    meleeActive: number;     // >0 while the melee hitbox is live this frame
    projCd: number;
    flash: number;
    attackSeq: number;       // edge counter for melee (per slot, host applies)
    projSeq: number;         // edge counter for projectile
    jumpSeq: number;         // edge counter for jump presses (host applies discrete jumps)
  }
  interface NetInput {
    move: number; down: boolean; fastFall: boolean; facing: number;
    attackSeq: number; projSeq: number; jumpSeq: number;
  }

  let stage: Stage = STAGES[0];
  let movePhase = 0; // drives moving platforms
  let fighters: FighterState[] = [];
  let projs: Proj[] = [];
  let over: { winner: number } | null = null;
  let endReported = false;

  // Host: per-slot tracking of relayed input + last processed edge counters.
  const guestInputs = new Map<number, NetInput>();
  const lastAttack = new Map<number, number>();
  const lastProj = new Map<number, number>();
  const lastJump = new Map<number, number>();

  // local input
  const keys = new Set<string>();
  let myFacing = 1;
  let myAttackSeq = 0, myProjSeq = 0, myJumpSeq = 0;

  const me = (): FighterState | undefined => fighters.find((p) => p.slot === selfSlot);

  // --- audio ---
  let audio: AudioContext | null = null;
  const ac = () => (audio ??= new AudioContext());
  function blip(freq: number, dur: number, type: OscillatorType = 'square', vol = 0.18) {
    try {
      const a = ac();
      const o = a.createOscillator(); const g = a.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.value = vol;
      g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
      o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + dur);
    } catch { /* ignore */ }
  }
  function hitSound() { blip(180, 0.12, 'sawtooth', 0.22); }
  function koSound() { blip(90, 0.4, 'triangle', 0.3); }

  // =====================================================================================
  // Host sim helpers
  // =====================================================================================
  function spawnFighter(p: FighterState, idx: number) {
    const sp = stage.spawns[idx % stage.spawns.length] ?? { x: SB_STAGE_W / 2, y: 200 };
    p.x = sp.x; p.y = sp.y;
    p.vx = 0; p.vy = 0;
    p.facing = sp.x < SB_STAGE_W / 2 ? 1 : -1;
    p.onGround = false; p.jumps = 0; p.usedRecovery = false; p.dropTimer = 0;
    p.invuln = RESPAWN_INVULN; p.respawnIn = 0; p.hitstun = 0;
    p.meleeCd = 0; p.meleeActive = 0; p.projCd = 0; p.flash = 0;
  }

  // The set of platforms a fighter could be standing on this frame (with moving-platform offsets).
  function platRects(): { x: number; y: number; w: number; h: number; passThrough: boolean }[] {
    return stage.platforms.map((pl) => {
      let x = pl.x;
      if (pl.moves) x += Math.sin((movePhase / pl.moves.period) * Math.PI * 2) * pl.moves.dx;
      return { x, y: pl.y, w: pl.w, h: pl.h, passThrough: pl.passThrough };
    });
  }

  // Integrate one fighter under gravity + platform collision.
  function physics(p: FighterState, inp: { move: number; down: boolean; fastFall: boolean }, dt: number) {
    const f = fighterById(p.fid);
    if (p.hitstun > 0) {
      p.hitstun -= dt;
    } else {
      // Horizontal control.
      const target = inp.move * runSpeed(f);
      if (p.onGround) {
        if (inp.move !== 0) p.vx += (target - p.vx) * Math.min(1, GROUND_ACCEL * dt);
        else p.vx *= Math.pow(FRICTION, dt * 60);
      } else {
        if (inp.move !== 0) p.vx += (target - p.vx) * Math.min(1, GROUND_ACCEL * AIR_DRIFT * dt);
      }
    }

    // Gravity + fall control.
    p.vy += GRAVITY * dt;
    let term = termVel(f);
    if (inp.fastFall && !p.onGround && p.vy > 0) { term *= FAST_FALL_MULT; p.vy += GRAVITY * dt * 0.8; }
    if (p.vy > term) p.vy = term;

    const w = bodyW(f);
    const prevBottom = p.y; // p.y is the feet (bottom-center)
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.dropTimer > 0) p.dropTimer -= dt;

    // Platform collision: only when falling, feet crossing the top edge.
    p.onGround = false;
    const rects = platRects();
    for (const r of rects) {
      const left = p.x - w / 2, right = p.x + w / 2;
      if (right < r.x || left > r.x + r.w) continue;
      const top = r.y;
      // Land if we were above the top last frame and now at/below it, moving down.
      if (p.vy >= 0 && prevBottom <= top + 2 && p.y >= top && p.y <= top + Math.max(30, p.vy * dt + 6)) {
        if (r.passThrough && (inp.down && p.dropTimer <= 0)) {
          // drop-through: start a brief suppression so we fall past it
          p.dropTimer = 0.22;
          continue;
        }
        if (r.passThrough && p.dropTimer > 0) continue;
        p.y = top;
        p.vy = 0;
        p.onGround = true;
        p.jumps = 0; p.usedRecovery = false;
      }
    }
  }

  // Discrete jump from a press: 1st jump, 2nd (double) jump, then the recovery up-burst.
  function doJump(p: FighterState) {
    if (p.hitstun > 0.05) { /* still allow recovery to break stun a little */ }
    const f = fighterById(p.fid);
    if (p.onGround || p.jumps === 0) {
      p.vy = -jumpImpulse(f);
      p.jumps = 1; p.onGround = false; p.hitstun = 0;
      blip(520, 0.08, 'square', 0.12);
    } else if (p.jumps === 1) {
      p.vy = -jumpImpulse(f) * DOUBLE_JUMP_FACTOR;
      p.jumps = 2; p.hitstun = 0;
      blip(640, 0.08, 'square', 0.12);
    } else if (!p.usedRecovery) {
      // up-burst recovery — height scales with the jump stat (Kenny's is weak → risky offstage)
      p.vy = -jumpImpulse(f) * RECOVERY_FACTOR;
      p.usedRecovery = true; p.hitstun = 0;
      blip(760, 0.12, 'triangle', 0.16);
    }
  }

  // Apply knockback to a victim from an attacker (or hazard), in a direction.
  function applyKnockback(victim: FighterState, attacker: FighterState | null, dmg: number, dirX: number, dirY: number, baseExtra = 0) {
    const vf = fighterById(victim.fid);
    const af = attacker ? fighterById(attacker.fid) : null;
    victim.dmg += dmg;
    const aStr = af ? strMult(af) : 1.0;
    const mag = (KB_BASE + baseExtra + victim.dmg * KB_SCALE) * aStr / weightDiv(vf);
    const len = Math.hypot(dirX, dirY) || 1;
    victim.vx = (dirX / len) * mag;
    victim.vy = (dirY / len) * mag - 60; // slight upward bias so hits pop up
    victim.hitstun = Math.min(0.6, mag * HITSTUN_PER_KB);
    victim.flash = 0.15;
    victim.onGround = false;
    hitSound();
  }

  // Host: resolve a melee swing by `p` (called when its attackSeq edges).
  function doMelee(p: FighterState) {
    if (p.respawnIn !== 0 || p.eliminated || p.meleeCd > 0 || p.hitstun > 0) return;
    const f = fighterById(p.fid);
    p.meleeCd = 0.18 + f.melee.startup * 0.03; // startup-derived cooldown
    p.meleeActive = 0.12;
    blip(300, 0.06, 'square', 0.1);
    const reach = 26 + f.melee.range * 14;
    const hx = p.x + p.facing * (bodyW(f) / 2 + reach / 2);
    const hy = p.y - bodyH(f) / 2;
    const hw = reach, hh = bodyH(f) * 0.9;
    for (const e of fighters) {
      if (e === p || e.eliminated || e.respawnIn !== 0 || e.invuln > 0) continue;
      const ef = fighterById(e.fid);
      const ex = e.x, ey = e.y - bodyH(ef) / 2;
      if (Math.abs(ex - hx) < hw / 2 + bodyW(ef) / 2 && Math.abs(ey - hy) < hh / 2 + bodyH(ef) / 2) {
        const dmg = f.melee.dmg * 1.8;
        applyKnockback(e, p, dmg, p.facing, -0.5);
      }
    }
  }

  // Host: spawn a projectile from `p` (called when its projSeq edges).
  function doProj(p: FighterState) {
    if (p.respawnIn !== 0 || p.eliminated || p.projCd > 0 || p.hitstun > 0) return;
    const f = fighterById(p.fid);
    p.projCd = 0.12 + f.projectile.cooldown * 0.09;
    const speed = 320 + f.projectile.speed * 60;
    const arc = f.projectile.arc;
    projs.push({
      slot: p.slot, x: p.x + p.facing * bodyW(f) * 0.6, y: p.y - bodyH(f) * 0.6,
      vx: p.facing * speed, vy: arc === 'lob' ? -260 : (arc === 'bounce' ? -120 : 0),
      life: 2.4, dmg: f.projectile.dmg * 1.6, kbStr: f.strength, arc, bounces: 0, kind: f.id,
    });
    blip(arc === 'straight' ? 880 : 420, 0.07, 'sawtooth', 0.12);
  }

  function moveProjs(dt: number) {
    const rects = platRects();
    for (let i = projs.length - 1; i >= 0; i--) {
      const pr = projs[i];
      pr.life -= dt;
      if (pr.arc !== 'straight') pr.vy += GRAVITY * 0.55 * dt;
      pr.x += pr.vx * dt; pr.y += pr.vy * dt;
      // bounce off platforms (bounce arc only)
      if (pr.arc === 'bounce') {
        for (const r of rects) {
          if (pr.x > r.x && pr.x < r.x + r.w && pr.y >= r.y && pr.y <= r.y + 14 && pr.vy > 0) {
            pr.y = r.y; pr.vy = -pr.vy * 0.7; pr.bounces++;
          }
        }
        if (pr.bounces > 4) { projs.splice(i, 1); continue; }
      }
      // off-stage despawn (with a margin)
      if (pr.life <= 0 || pr.x < -80 || pr.x > SB_STAGE_W + 80 || pr.y > SB_STAGE_H + 120) {
        projs.splice(i, 1); continue;
      }
      // hit detection vs fighters
      const owner = fighters.find((q) => q.slot === pr.slot) ?? null;
      for (const e of fighters) {
        if (e.slot === pr.slot || e.eliminated || e.respawnIn !== 0 || e.invuln > 0) continue;
        const ef = fighterById(e.fid);
        if (Math.abs(e.x - pr.x) < bodyW(ef) / 2 + 8 && Math.abs((e.y - bodyH(ef) / 2) - pr.y) < bodyH(ef) / 2 + 8) {
          applyKnockback(e, owner, pr.dmg, Math.sign(pr.vx) || e.facing, -0.35);
          projs.splice(i, 1);
          break;
        }
      }
    }
  }

  // Host: hazards (lava) — touch deals damage + a strong upward launch.
  function hazards(dt: number) {
    for (const hz of stage.hazards) {
      for (const e of fighters) {
        if (e.eliminated || e.respawnIn !== 0 || e.invuln > 0) continue;
        if (e.x > hz.x && e.x < hz.x + hz.w && e.y > hz.y && e.y < hz.y + hz.h) {
          applyKnockback(e, null, hz.dmg, 0, -1, hz.launch * 60);
          e.invuln = 0.4; // brief mercy so lava doesn't multi-hit per frame
        }
      }
    }
    void dt;
  }

  // Host: ring-out check — past any blast bound → lose a stock + respawn (or eliminate).
  function ringOuts(idxBySlot: Map<number, number>) {
    for (const e of fighters) {
      if (e.eliminated || e.respawnIn > 0) continue;
      const b = stage.blast;
      if (e.x < b.left || e.x > b.right || e.y < b.top || e.y > b.bottom) {
        e.stocks--;
        koSound();
        if (e.stocks <= 0) {
          e.eliminated = true; e.respawnIn = -1;
        } else {
          e.respawnIn = RESPAWN_DELAY;
          e.dmg = 0; e.vx = 0; e.vy = 0;
          // park off-screen until respawn
          e.x = -9999; e.y = -9999;
        }
      }
    }
    // resolve elimination → winner
    const alive = fighters.filter((e) => !e.eliminated);
    if (!over && alive.length <= 1 && fighters.length >= 2) {
      over = { winner: alive.length === 1 ? alive[0].slot : -1 };
    }
    void idxBySlot;
  }

  function readIntent(): { move: number; down: boolean; fastFall: boolean } {
    let move = 0;
    if (keys.has('arrowleft') || keys.has('a')) move -= 1;
    if (keys.has('arrowright') || keys.has('d')) move += 1;
    const down = keys.has('arrowdown') || keys.has('s');
    return { move, down, fastFall: down };
  }

  // Local action edges (host applies immediately for its own; guests bump counters for relay).
  function localJump() { const p = me(); if (over || !p || p.eliminated || p.respawnIn > 0) return; myJumpSeq++; if (isHost) doJump(p); }
  function localMelee() { const p = me(); if (over || !p || p.eliminated || p.respawnIn > 0) return; myAttackSeq++; if (isHost) doMelee(p); }
  function localProj() { const p = me(); if (over || !p || p.eliminated || p.respawnIn > 0) return; myProjSeq++; if (isHost) doProj(p); }

  // =====================================================================================
  // Update
  // =====================================================================================
  let netAccum = 0;
  function update(dt: number) {
    if (mode !== 'play') return;
    movePhase += dt;
    if (isHost) {
      if (!over) {
        // facing from local input for my fighter
        const intent = readIntent();
        if (intent.move !== 0) myFacing = intent.move > 0 ? 1 : -1;
        const idxBySlot = new Map<number, number>();
        fighters.forEach((p, i) => idxBySlot.set(p.slot, i));

        for (const p of fighters) {
          if (p.eliminated) continue;
          if (p.respawnIn > 0) {
            p.respawnIn -= dt;
            if (p.respawnIn <= 0) { p.respawnIn = 0; spawnFighter(p, idxBySlot.get(p.slot) ?? 0); }
            continue;
          }
          // timers
          if (p.meleeCd > 0) p.meleeCd -= dt;
          if (p.meleeActive > 0) p.meleeActive -= dt;
          if (p.projCd > 0) p.projCd -= dt;
          if (p.invuln > 0) p.invuln -= dt;
          if (p.flash > 0) p.flash -= dt;

          let inp: { move: number; down: boolean; fastFall: boolean };
          if (p.slot === selfSlot) {
            inp = intent; p.facing = myFacing;
          } else {
            const gi = guestInputs.get(p.slot);
            inp = gi ? { move: gi.move, down: gi.down, fastFall: gi.fastFall } : { move: 0, down: false, fastFall: false };
            if (gi) p.facing = gi.facing || p.facing;
          }
          // apply relayed action edges for guests
          if (p.slot !== selfSlot) {
            const gi = guestInputs.get(p.slot);
            if (gi) {
              if (gi.jumpSeq > (lastJump.get(p.slot) ?? 0)) { lastJump.set(p.slot, gi.jumpSeq); doJump(p); }
              if (gi.attackSeq > (lastAttack.get(p.slot) ?? 0)) { lastAttack.set(p.slot, gi.attackSeq); doMelee(p); }
              if (gi.projSeq > (lastProj.get(p.slot) ?? 0)) { lastProj.set(p.slot, gi.projSeq); doProj(p); }
            }
          }
          physics(p, inp, dt);
        }
        moveProjs(dt);
        hazards(dt);
        ringOuts(idxBySlot);
      }
      if (over && !endReported) { endReported = true; net.end(over.winner); }
      // stream snapshot ~30/s
      netAccum += dt;
      if (netAccum >= 0.033) {
        netAccum = 0;
        net.relay({
          t: 'st',
          stg: stageIdx,
          mp: movePhase,
          f: fighters.map((p) => ({
            s: p.slot, n: p.name, fid: p.fid,
            x: Math.round(p.x), y: Math.round(p.y), fc: p.facing,
            d: Math.round(p.dmg), st: p.stocks, iv: p.invuln > 0 ? 1 : 0,
            el: p.eliminated ? 1 : 0, rs: p.respawnIn, ma: p.meleeActive > 0 ? 1 : 0, fl: p.flash > 0 ? 1 : 0,
          })),
          p: projs.map((pr) => ({ x: Math.round(pr.x), y: Math.round(pr.y), k: pr.kind, a: pr.arc })),
          over,
        });
      }
    } else {
      // guest: own facing locally, send input ~30/s, render from snapshots
      const intent = readIntent();
      if (intent.move !== 0) myFacing = intent.move > 0 ? 1 : -1;
      netAccum += dt;
      if (netAccum >= 0.033) {
        netAccum = 0;
        net.relay({
          t: 'in', slot: selfSlot,
          move: intent.move, down: intent.down, fastFall: intent.fastFall, facing: myFacing,
          attackSeq: myAttackSeq, projSeq: myProjSeq, jumpSeq: myJumpSeq,
        });
      }
      // decay local cosmetic timers on the mirrored fighters
      for (const p of fighters) if (p.flash > 0) p.flash -= dt;
    }
  }

  // =====================================================================================
  // Rendering (whole stage in view; no camera)
  // =====================================================================================
  function render() {
    if (mode !== 'play') { ctx.fillStyle = '#0a0a12'; ctx.fillRect(0, 0, SB_STAGE_W, SB_STAGE_H); return; }
    drawBackdrop();
    // platforms
    const rects = platRects();
    rects.forEach((r, i) => drawPlatform(r, stage.platforms[i].passThrough, stage.id));
    // hazards (lava)
    for (const hz of stage.hazards) drawLava(hz);
    // projectiles
    for (const pr of projs) drawProj(pr);
    // fighters
    for (const p of fighters) {
      if (p.eliminated || p.respawnIn > 0) continue;
      drawFighterSprite(p);
    }
    drawHud();
  }

  function drawBackdrop() {
    const g = ctx.createLinearGradient(0, 0, 0, SB_STAGE_H);
    if (stage.id === 'plaza') { g.addColorStop(0, '#aee0ff'); g.addColorStop(1, '#7fb2e8'); }
    else if (stage.id === 'paddlepark') { g.addColorStop(0, '#0c1a26'); g.addColorStop(1, '#16313f'); }
    else { g.addColorStop(0, '#3a0a0a'); g.addColorStop(1, '#0c0303'); }
    ctx.fillStyle = g; ctx.fillRect(0, 0, SB_STAGE_W, SB_STAGE_H);
    if (stage.id === 'plaza') {
      // simple town silhouette
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      for (let i = 0; i < 5; i++) { const x = (i * 280 + (movePhase * 8) % 280) % (SB_STAGE_W + 120) - 60; ctx.beginPath(); ctx.arc(x, 110 + (i % 2) * 40, 26, 0, Math.PI * 2); ctx.arc(x + 30, 116, 22, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = 'rgba(40,60,90,0.35)';
      for (let i = 0; i < 7; i++) ctx.fillRect(60 + i * 170, 300 - (i % 3) * 50, 90, 320);
    } else if (stage.id === 'paddlepark') {
      // a faint giant pong net / starscape
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      for (let y = 30; y < SB_STAGE_H; y += 48) ctx.fillRect(SB_STAGE_W / 2 - 3, y, 6, 26);
      ctx.fillStyle = 'rgba(150,200,255,0.5)';
      for (let i = 0; i < 40; i++) { const x = (i * 137) % SB_STAGE_W; const y = (i * 91) % 300; ctx.fillRect(x, y, 2, 2); }
    } else {
      // hell glow flicker
      ctx.fillStyle = `rgba(255,80,20,${0.06 + Math.abs(Math.sin(movePhase * 3)) * 0.05})`;
      ctx.fillRect(0, SB_STAGE_H - 200, SB_STAGE_W, 200);
    }
  }

  function drawPlatform(r: { x: number; y: number; w: number; h: number }, pass: boolean, sid: string) {
    if (sid === 'paddlepark') {
      // pong-paddle styled platform
      ctx.fillStyle = '#e8f0ff'; ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = '#9fb6d8'; ctx.fillRect(r.x, r.y + r.h - 5, r.w, 5);
      ctx.fillStyle = '#0c1a26'; ctx.fillRect(r.x + 6, r.y + 3, r.w - 12, 3);
      return;
    }
    if (pass) {
      ctx.fillStyle = sid === 'hellpit' ? '#5a2a1a' : '#7a5a3a';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(r.x, r.y, r.w, 3);
    } else {
      const top = sid === 'hellpit' ? '#6a3a2a' : '#4a8a3a';
      const body = sid === 'hellpit' ? '#3a1a14' : '#5a3a22';
      ctx.fillStyle = top; ctx.fillRect(r.x, r.y, r.w, 10);
      ctx.fillStyle = body; ctx.fillRect(r.x, r.y + 10, r.w, r.h - 10);
    }
  }

  function drawLava(hz: { x: number; y: number; w: number; h: number }) {
    const g = ctx.createLinearGradient(0, hz.y, 0, hz.y + hz.h);
    g.addColorStop(0, '#ffcf3a'); g.addColorStop(0.4, '#ff6a1a'); g.addColorStop(1, '#9a1a00');
    ctx.fillStyle = g; ctx.fillRect(hz.x, hz.y, hz.w, hz.h);
    // bubbling surface
    ctx.fillStyle = '#fff0a0';
    for (let i = 0; i < 6; i++) {
      const x = hz.x + ((i * 53 + movePhase * 30) % hz.w);
      const y = hz.y + 4 + Math.sin(movePhase * 4 + i) * 3;
      ctx.fillRect(x, y, 6, 4);
    }
  }

  function drawProj(pr: Proj) {
    ctx.save();
    ctx.translate(pr.x, pr.y);
    const f = fighterById(pr.kind);
    const name = f.projectile.name;
    if (f.id === 'minion') { // banana
      ctx.fillStyle = '#ffd836'; ctx.beginPath(); ctx.arc(0, 0, 7, 0.2, Math.PI - 0.2); ctx.lineWidth = 5; ctx.strokeStyle = '#ffd836'; ctx.stroke();
    } else if (f.id === 'pikachu') { // lightning bolt
      ctx.fillStyle = '#fff36a'; ctx.fillRect(-8, -3, 16, 6); ctx.fillStyle = '#ffd000'; ctx.fillRect(-4, -6, 8, 12);
    } else if (f.id === 'rob') { // knife
      ctx.fillStyle = '#cfd6e0'; ctx.fillRect(-8, -2, 14, 4); ctx.fillStyle = '#6a4a2a'; ctx.fillRect(6, -3, 5, 6);
    } else if (f.id === 'lebron') { // basketball
      ctx.fillStyle = '#e8862e'; ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#3a1a0a'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(-9, 0); ctx.lineTo(9, 0); ctx.moveTo(0, -9); ctx.lineTo(0, 9); ctx.stroke();
    } else if (f.id === 'jsav') { // bullet
      ctx.fillStyle = '#ffe14d'; ctx.fillRect(-6, -2, 12, 4);
    } else { // kenny baseball
      ctx.fillStyle = '#f5f5f5'; ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#d04040'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(-2, 0, 5, -0.8, 0.8); ctx.stroke();
    }
    ctx.restore();
    void name;
  }

  function drawFighterSprite(p: FighterState) {
    const f = fighterById(p.fid);
    const w = bodyW(f), h = bodyH(f);
    const top = p.y - h;
    ctx.save();
    // invuln blink
    if (p.invuln > 0 && Math.floor(p.invuln * 12) % 2 === 0) ctx.globalAlpha = 0.4;
    // flip for facing: translate to center, scale x
    ctx.translate(p.x, top);
    ctx.scale(p.facing, 1);
    ctx.translate(-p.x, -top);
    drawFighterArt(f, p.x, top, w, h, p.flash > 0);
    ctx.restore();

    // melee swing arc (drawn unflipped, in facing direction)
    if (p.meleeActive > 0) {
      const reach = 26 + f.melee.range * 14;
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ffffff';
      const hx = p.x + p.facing * (w / 2);
      ctx.beginPath();
      ctx.moveTo(hx, p.y - h / 2);
      ctx.arc(hx, p.y - h / 2, reach, p.facing > 0 ? -0.9 : Math.PI - 0.9, p.facing > 0 ? 0.9 : Math.PI + 0.9);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    // nameplate + damage %
    ctx.font = '700 16px ui-monospace,monospace';
    ctx.textAlign = 'center';
    const ring = SLOT_RING[p.slot % SLOT_RING.length];
    ctx.fillStyle = '#000'; ctx.fillText(p.name, p.x + 1, top - 7);
    ctx.fillStyle = ring; ctx.fillText(p.name, p.x, top - 8);
  }

  // Pixel-baked fighter art (jsav uses the image). Drawn in stage-space at (x = center, top).
  function drawFighterArt(f: Fighter, cx: number, top: number, w: number, h: number, flash: boolean) {
    const left = cx - w / 2;
    if (flash) { ctx.fillStyle = '#ffffff'; ctx.fillRect(left, top, w, h); }
    const px = (rx: number, ry: number, rw: number, rh: number, col: string) => {
      ctx.fillStyle = flash ? lighten(col) : col;
      ctx.fillRect(left + rx * w, top + ry * h, rw * w, rh * h);
    };
    switch (f.id) {
      case 'minion': {
        px(0.15, 0.40, 0.70, 0.60, '#3158b0');     // overalls
        px(0.10, 0.05, 0.80, 0.45, '#ffd836');     // yellow body/head
        px(0.18, 0.16, 0.64, 0.14, '#bbbbbb');     // goggle strap
        px(0.30, 0.13, 0.40, 0.18, '#dddddd');     // goggle lens
        px(0.40, 0.16, 0.20, 0.12, '#222');        // pupil
        px(0.18, 0.92, 0.24, 0.08, '#222');        // feet
        px(0.58, 0.92, 0.24, 0.08, '#222');
        break;
      }
      case 'pikachu': {
        px(0.12, 0.30, 0.76, 0.62, '#f6d02f');     // body
        px(0.20, 0.08, 0.60, 0.30, '#f6d02f');     // head
        px(0.16, -0.05, 0.16, 0.22, '#f6d02f'); px(0.16, -0.05, 0.16, 0.08, '#222'); // left ear tip
        px(0.68, -0.05, 0.16, 0.22, '#f6d02f'); px(0.68, -0.05, 0.16, 0.08, '#222'); // right ear tip
        px(0.26, 0.20, 0.12, 0.10, '#e85a5a');     // cheek
        px(0.62, 0.20, 0.12, 0.10, '#e85a5a');
        px(0.34, 0.16, 0.08, 0.08, '#222'); px(0.58, 0.16, 0.08, 0.08, '#222'); // eyes
        px(0.78, 0.55, 0.22, 0.10, '#7a5a10');     // tail
        break;
      }
      case 'rob': {
        px(0.20, 0.42, 0.60, 0.42, '#e8862e');     // orange shirt
        px(0.22, 0.84, 0.24, 0.16, '#2a3a5a');     // legs
        px(0.54, 0.84, 0.24, 0.16, '#2a3a5a');
        px(0.30, 0.08, 0.40, 0.34, '#e8b890');     // head
        px(0.28, 0.04, 0.44, 0.14, '#2a1a0a');     // dark hair
        px(0.38, 0.20, 0.08, 0.06, '#222'); px(0.54, 0.20, 0.08, 0.06, '#222'); // eyes
        break;
      }
      case 'lebron': {
        px(0.22, 0.36, 0.56, 0.40, '#552583');     // purple jersey
        px(0.30, 0.40, 0.40, 0.12, '#fdb927');     // gold trim
        px(0.24, 0.76, 0.22, 0.24, '#552583');     // shorts/legs
        px(0.54, 0.76, 0.22, 0.24, '#552583');
        px(0.34, 0.04, 0.32, 0.30, '#6a4a32');     // head
        px(0.36, 0.02, 0.28, 0.10, '#1a1008');     // hair/headband
        break;
      }
      case 'jsav': {
        // drawn via the image (handled below); fall through to image-or-fallback.
        if (jsavReady()) {
          const aspect = jsavImg.naturalWidth / jsavImg.naturalHeight;
          let dw = w, dh = w / aspect;
          if (dh > h) { dh = h; dw = h * aspect; }
          ctx.drawImage(jsavImg, cx - dw / 2, top + (h - dh), dw, dh);
        } else {
          px(0.2, 0.1, 0.6, 0.8, f.color);
        }
        return;
      }
      case 'kenny': {
        // wheelchair: two wheels + frame
        px(0.10, 0.72, 0.34, 0.28, '#333');        // back wheel
        px(0.16, 0.78, 0.22, 0.16, '#777');
        px(0.62, 0.80, 0.22, 0.18, '#333');        // front small wheel
        px(0.18, 0.66, 0.60, 0.08, '#888');        // frame bar
        // seated body
        px(0.28, 0.34, 0.46, 0.36, '#2bbfae');     // teal hoodie
        px(0.36, 0.06, 0.32, 0.30, '#e8b890');     // head
        px(0.34, 0.02, 0.36, 0.12, '#171717');     // dark hood/hair
        // a bat held up
        px(0.74, 0.10, 0.10, 0.40, '#b06a2a');
        px(0.72, 0.06, 0.14, 0.10, '#8a4a18');
        break;
      }
      default: px(0.2, 0.1, 0.6, 0.8, f.color);
    }
  }

  function lighten(hex: string): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return '#ffffff';
    const n = parseInt(m[1], 16);
    const r = Math.min(255, (n >> 16) + 90), g = Math.min(255, ((n >> 8) & 255) + 90), b = Math.min(255, (n & 255) + 90);
    return `rgb(${r},${g},${b})`;
  }

  function drawHud() {
    // bottom damage-% panels, one per fighter
    const n = fighters.length;
    const panelW = 200, gap = 18;
    const totalW = n * panelW + (n - 1) * gap;
    let x = (SB_STAGE_W - totalW) / 2;
    const y = SB_STAGE_H - 96;
    for (const p of fighters) {
      const ring = SLOT_RING[p.slot % SLOT_RING.length];
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(x, y, panelW, 80);
      ctx.fillStyle = ring; ctx.fillRect(x, y, panelW, 5);
      ctx.textAlign = 'center';
      ctx.font = '700 18px ui-monospace,monospace';
      ctx.fillStyle = p.eliminated ? '#666' : '#fff';
      ctx.fillText(`P${p.slot + 1} ${p.name}`, x + panelW / 2, y + 26);
      // damage %, colored by severity
      const dmg = Math.round(p.dmg);
      const t = Math.min(1, dmg / 200);
      ctx.fillStyle = p.eliminated ? '#555' : `rgb(${200 + t * 55 | 0},${(1 - t) * 200 | 0},${(1 - t) * 60 | 0})`;
      ctx.font = '900 30px ui-monospace,monospace';
      ctx.fillText(p.eliminated ? 'OUT' : `${dmg}%`, x + panelW / 2, y + 58);
      // stocks as little icons
      ctx.font = '16px ui-monospace,monospace';
      ctx.fillStyle = ring;
      ctx.fillText('●'.repeat(Math.max(0, p.stocks)), x + panelW / 2, y + 76);
      x += panelW + gap;
    }
  }

  function syncHud() {
    if (mode === 'menu' || mode === 'lobby') {
      menu.style.display = 'flex';
      title.style.display = 'none';
      banner.style.display = 'none';
      renderRoster(); syncMenuButtons(); syncSelectCards(); syncStageBtns();
      return;
    }
    menu.style.display = 'none';
    title.style.display = over ? 'none' : 'block';
    if (over) {
      const p = me();
      let head: string, col: string;
      if (over.winner === -1) { head = 'DRAW'; col = '#ffd166'; }
      else if (p && over.winner === p.slot) { head = 'VICTORY!'; col = '#5fd16a'; }
      else {
        const wf = fighters.find((q) => q.slot === over!.winner);
        head = wf ? `${wf.name} WINS!` : 'GAME!'; col = '#ff9d4f';
      }
      banner.textContent = `${head}\nESC to exit`;
      banner.style.color = col;
      banner.style.fontSize = '60px';
      banner.style.display = 'flex';
    } else {
      const p = me();
      if (p && p.eliminated) {
        banner.textContent = 'KO\'D OUT\nspectating…';
        banner.style.color = '#ff5c5c'; banner.style.fontSize = '44px'; banner.style.display = 'flex';
      } else {
        banner.style.display = 'none';
      }
    }
  }

  // =====================================================================================
  // Mode transitions
  // =====================================================================================
  function startMatch(hostStageIdx: number) {
    mode = 'play';
    isHost = selfSlot === 0;
    over = null; endReported = false;
    projs = []; movePhase = 0; netAccum = 0;
    myAttackSeq = 0; myProjSeq = 0; myJumpSeq = 0; myFacing = 1;
    guestInputs.clear(); lastAttack.clear(); lastProj.clear(); lastJump.clear();
    stageIdx = hostStageIdx;
    stage = STAGES[stageIdx] ?? STAGES[0];
    fighters = (lobbyState?.players ?? []).map((lp, i) => {
      const fid = lp.fighter ?? FIGHTERS[0].id;
      const fs: FighterState = {
        slot: lp.slot, name: lp.name, fid,
        x: 0, y: 0, vx: 0, vy: 0, facing: 1, onGround: false, jumps: 0, usedRecovery: false, dropTimer: 0,
        dmg: 0, stocks: SB_STOCKS, invuln: RESPAWN_INVULN, respawnIn: 0, eliminated: false,
        hitstun: 0, meleeCd: 0, meleeActive: 0, projCd: 0, flash: 0,
        attackSeq: 0, projSeq: 0, jumpSeq: 0,
      };
      spawnFighter(fs, i);
      return fs;
    });
    menu.style.display = 'none';
  }

  joinBtn.onclick = () => { mode = 'lobby'; menuMsg.textContent = 'Joining…'; net.join(); };
  startBtn.onclick = () => {
    if (selfSlot !== 0) return;
    const players = lobbyState?.players ?? [];
    if (players.length < SB_MIN_PLAYERS || !players.every((p) => p.fighter)) return;
    // tell guests which stage via the first snapshot (carry it in start by relaying a 'stg' note)
    net.relay({ t: 'stg', idx: stageIdx });
    net.start();
  };
  leaveBtn.onclick = () => { net.leave(); lobbyState = null; mode = 'menu'; myPick = null; syncHud(); };
  exitBtn.onclick = () => close();

  // =====================================================================================
  // Incoming server messages
  // =====================================================================================
  let pendingStage = 0; // stage announced by host before 'playing' flips
  handlers = {
    lobby: (m) => {
      lobbyState = m;
      selfSlot = m.slot;
      // keep my local pick mirror in sync
      const mine = m.players.find((p) => p.slot === m.slot);
      if (mine) myPick = mine.fighter;
      if (m.status === 'ended') {
        mode = 'menu'; lobbyState = null; myPick = null;
        menuMsg.textContent = 'The host left — match ended.';
        return;
      }
      if (m.status === 'playing' && mode !== 'play') {
        startMatch(pendingStage);
      } else if (m.status === 'waiting') {
        if (mode === 'play') { mode = 'lobby'; } // match ended on the server, back to lobby
        renderRoster(); syncMenuButtons();
      }
    },
    relay: (d) => {
      const msg = d as { t?: string } & Record<string, unknown>;
      if (msg.t === 'stg') { pendingStage = Number(msg.idx) || 0; return; }
      if (mode !== 'play') return;
      if (isHost && msg.t === 'in') {
        const slot = Number(msg.slot);
        if (Number.isFinite(slot) && slot !== selfSlot) {
          guestInputs.set(slot, {
            move: Number(msg.move) || 0,
            down: !!msg.down,
            fastFall: !!msg.fastFall,
            facing: Number(msg.facing) || 1,
            attackSeq: Number(msg.attackSeq) || 0,
            projSeq: Number(msg.projSeq) || 0,
            jumpSeq: Number(msg.jumpSeq) || 0,
          });
        }
      } else if (!isHost && msg.t === 'st') {
        // Authoritative stage from the host (covers a 'stg' relay that raced the lobby flip).
        const sidx = Number(msg.stg) || 0;
        if (sidx !== stageIdx) { stageIdx = sidx; stage = STAGES[sidx] ?? STAGES[0]; }
        movePhase = Number(msg.mp) || movePhase;
        const sf = (msg.f as Array<Record<string, unknown>>) ?? [];
        fighters = sf.map((r) => ({
          slot: Number(r.s), name: String(r.n), fid: String(r.fid),
          x: Number(r.x), y: Number(r.y), vx: 0, vy: 0, facing: Number(r.fc) || 1,
          onGround: false, jumps: 0, usedRecovery: false, dropTimer: 0,
          dmg: Number(r.d), stocks: Number(r.st), invuln: r.iv ? 1 : 0, respawnIn: Number(r.rs) || 0,
          eliminated: !!r.el, hitstun: 0, meleeCd: 0, meleeActive: r.ma ? 0.1 : 0, projCd: 0,
          flash: r.fl ? 0.1 : 0, attackSeq: 0, projSeq: 0, jumpSeq: 0,
        }));
        const sp = (msg.p as Array<Record<string, unknown>>) ?? [];
        projs = sp.map((r) => ({
          slot: -1, x: Number(r.x), y: Number(r.y), vx: 0, vy: 0, life: 1,
          dmg: 0, kbStr: 0, arc: (r.a as Proj['arc']) || 'straight', bounces: 0, kind: String(r.k),
        }));
        over = (msg.over as { winner: number } | null) ?? null;
      }
    },
  };

  // =====================================================================================
  // Input
  // =====================================================================================
  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (k === 'escape') { close(); return; }
    if (mode !== 'play') return;
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd', ' ', 'j', 'k'].includes(k)) {
      e.preventDefault(); e.stopImmediatePropagation();
    }
    if (!e.repeat) {
      if (k === 'w' || k === ' ' || k === 'arrowup') localJump();
      else if (k === 'j') localMelee();
      else if (k === 'k') localProj();
    }
    keys.add(k);
  };
  const onKeyUp = (e: KeyboardEvent) => { keys.delete(e.key.toLowerCase()); };
  const onMouseDown = () => { if (mode === 'play') localMelee(); };
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  canvas.addEventListener('mousedown', onMouseDown);

  // =====================================================================================
  // Loop + teardown
  // =====================================================================================
  let raf = 0;
  let last = performance.now();
  function loop(now: number) {
    const dt = Math.min(0.04, (now - last) / 1000);
    last = now;
    update(dt);
    render();
    syncHud();
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  function close() {
    if (!sbOpen) return;
    sbOpen = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    canvas.removeEventListener('mousedown', onMouseDown);
    if (mode === 'lobby' || mode === 'play') net.leave();
    handlers = null;
    audio?.close().catch(() => {});
    overlay.remove();
  }
}

// Portrait for the select-screen swatch canvas (no flash, no facing). Reuses the same idiom but
// at swatch scale; jsav draws the image when ready, otherwise a colored block.
function drawPortrait(c: CanvasRenderingContext2D, f: Fighter, w: number, h: number) {
  c.fillStyle = '#0a0a12'; c.fillRect(0, 0, w, h);
  const px = (rx: number, ry: number, rw: number, rh: number, col: string) => {
    c.fillStyle = col; c.fillRect(rx * w, ry * h, rw * w, rh * h);
  };
  switch (f.id) {
    case 'minion':
      px(0.15, 0.45, 0.70, 0.55, '#3158b0'); px(0.12, 0.05, 0.76, 0.45, '#ffd836');
      px(0.32, 0.14, 0.36, 0.18, '#ddd'); px(0.42, 0.17, 0.18, 0.1, '#222'); break;
    case 'pikachu':
      px(0.14, 0.3, 0.72, 0.6, '#f6d02f'); px(0.2, 0.06, 0.6, 0.3, '#f6d02f');
      px(0.18, 0, 0.14, 0.12, '#222'); px(0.68, 0, 0.14, 0.12, '#222');
      px(0.26, 0.2, 0.12, 0.1, '#e85a5a'); px(0.62, 0.2, 0.12, 0.1, '#e85a5a'); break;
    case 'rob':
      px(0.2, 0.42, 0.6, 0.5, '#e8862e'); px(0.3, 0.08, 0.4, 0.34, '#e8b890');
      px(0.28, 0.04, 0.44, 0.14, '#2a1a0a'); break;
    case 'lebron':
      px(0.22, 0.36, 0.56, 0.55, '#552583'); px(0.3, 0.4, 0.4, 0.12, '#fdb927');
      px(0.34, 0.04, 0.32, 0.3, '#6a4a32'); break;
    case 'jsav': {
      const ready = jsavImg.complete && jsavImg.naturalWidth > 0;
      if (ready) {
        const aspect = jsavImg.naturalWidth / jsavImg.naturalHeight;
        let dw = w, dh = w / aspect; if (dh > h) { dh = h; dw = h * aspect; }
        c.drawImage(jsavImg, (w - dw) / 2, (h - dh) / 2, dw, dh);
      } else { px(0.2, 0.1, 0.6, 0.8, f.color); }
      break;
    }
    case 'kenny':
      px(0.1, 0.7, 0.34, 0.3, '#333'); px(0.62, 0.78, 0.22, 0.2, '#333');
      px(0.28, 0.34, 0.46, 0.4, '#2bbfae'); px(0.36, 0.06, 0.32, 0.3, '#e8b890');
      px(0.74, 0.1, 0.1, 0.4, '#b06a2a'); break;
    default: px(0.2, 0.1, 0.6, 0.8, f.color);
  }
}
