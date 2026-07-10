// Tron — 1–4 player light-cycle battles, launched from the Arcade menu. Like Nuketown and
// Super Tsong Bros it is deliberately isolated: its own fullscreen overlay, canvas, input
// handlers and game loop, all torn down on exit. It never touches the Pong game state.
//
// Netcode is host-authoritative over a dumb broadcast relay (see the server Lobby's trn*
// methods): the server only runs the up-to-4 lobby and an opaque fan-out. The sim runs HERE.
// Slot 0 (the first joiner) is the host: it simulates EVERY cycle — its own from local input,
// guests' from relayed `{t:'in'}` direction packets, and any BOTS (host-side AI fills the
// empty seats) — and streams `{t:'st'}` head snapshots every tick. Guests rebuild the trail
// grid by appending heads (the relay is TCP-ordered, so append-only reconstruction is exact).
//
// Match structure: rounds of last-cycle-riding; first to TRN_ROUNDS_TO_WIN round wins takes
// the match. Solo start = you vs bots (server pays no reward for those — see lobby.trnEnd).
//
// Music: a random shuffle through the game's song library, with a NOW PLAYING banner on
// every track change. Pure flavour; stops on exit.

import { TRN_COLS, TRN_ROWS, TRN_ROUNDS_TO_WIN, TRN_MAX_PLAYERS } from '../shared/types';

export interface TronNet {
  join(): void;
  leave(): void;
  start(): void;
  end(winner: number): void; // (host only) winning LOBBY slot (-1 = a bot won → no payout)
  relay(data: unknown): void;
  name(): string;
  muted(): boolean; // whether the main page's mute toggle is on
}

interface TrnLobby {
  status: 'waiting' | 'playing' | 'ended';
  slot: number;
  hostSlot: number;
  players: { name: string; slot: number }[];
}

let handlers: { lobby: (m: TrnLobby) => void; relay: (d: unknown) => void } | null = null;
export function feedTrnLobby(m: TrnLobby) { handlers?.lobby(m); }
export function feedTrnRelay(d: unknown) { handlers?.relay(d); }

// --- constants ---
const CELL = 6;                        // px per grid cell (canvas 1920×1080, 320×180 grid)
const COLORS = ['#00e5ff', '#ff9a00', '#ff3df0', '#89ff2a'] as const; // cyan / orange / magenta / lime
const BOT_NAMES = ['CLU', 'RINZLER', 'SARK'] as const;
const DX = [0, 1, 0, -1] as const;     // 0=up 1=right 2=down 3=left
const DY = [-1, 0, 1, 0] as const;
const TICK_START_MS = 50;              // sim step at round start (arena is huge — keep it moving)...
const TICK_MIN_MS = 32;                // ...ramping down to this (faster = harder)
const COUNTDOWN_MS = 1800;             // 3-2-1 before the cycles launch
// Everything in /public that plays like a SONG (deliberately not the stingers/sfx).
const MUSIC = [
  'battle.mp3', 'davis-battle.mp3', 'disco.mp3', 'dungeon.mp3',
  'encounter.mp3', 'encounter2.mp3', 'encounter3.mp3', 'encounter4.mp3',
  'everlong.mp3', 'gangstas-paradise-8bit.mp3', 'heart-shaped-box-8bit.mp3',
  'inthend.mp3', 'livin-on-a-prayer-8bit.mp3', 'paranoid-android-8bit.mp3',
  'start-music.mp3',
] as const;

interface Rider {
  name: string;
  color: string;
  bot: boolean;
  lobbySlot: number; // human lobby slot, or -1 for bots
  x: number; y: number;
  dir: number;
  pendingDir: number;
  alive: boolean;
  wins: number;
  // powerup state (host-authoritative; guests only see the fx bitmask)
  boostUntil: number;   // ⚡ 2× speed
  cutter: boolean;      // ✂️ one free pass through a wall of light
  phaseUntil: number;   // 👻 ghost through everything (and lay no trail)
  jamUntil: number;     // 🐌 someone slowed YOU
  fx: number;           // rendered bitmask: 1=boost 2=cutter 4=phase 8=jam
}

// --- powerups ---
// Spawn on free cells every few seconds (host-side), ride over one to grab it.
const PU = [
  { icon: '⚡', name: 'BOOST', color: '#ffd060' },      // 0: 2× speed 2s
  { icon: '✂️', name: 'CUTTER', color: '#ffffff' },     // 1: pass through one wall
  { icon: '👻', name: 'PHASE', color: '#b090ff' },      // 2: ghost 1.5s, no trail
  { icon: '🧨', name: 'DEREZ BOMB', color: '#ff5a3a' }, // 3: clears a 9×9 hole around you
  { icon: '🐌', name: 'JAM', color: '#7fe089' },        // 4: half-speed everyone else 2s
] as const;
interface Pickup { x: number; y: number; kind: number; }
const FX_BOOST = 1, FX_CUTTER = 2, FX_PHASE = 4, FX_JAM = 8;

let tronOpen = false;

export function startTron(net: TronNet): void {
  if (tronOpen) return;
  tronOpen = true;

  type Mode = 'menu' | 'lobby' | 'play' | 'ended';
  let mode: Mode = 'menu';
  let selfSlot = 0;
  let isHost = false;
  let lobbyState: TrnLobby | null = null;
  let botCount = 3; // host preference; clamped so humans+bots ≤ 4 (and total ≥ 2)
  let powerupsOn = true; // host lobby toggle — purists may ride clean

  // --- match state (host simulates; guests mirror from snapshots) ---
  let riders: Rider[] = [];
  let grid = new Uint8Array(TRN_COLS * TRN_ROWS); // 0 = free, else riderIdx+1
  let round = 0;
  let pickups: Pickup[] = [];
  let tickNo = 0;             // host tick counter (jam skips odd ticks)
  let nextPickupAt = 0;       // host: when the next pickup materializes
  let puMsg = '';             // "BEX GRABBED PHASE" ticker under the round marker
  let puMsgUntil = 0;
  let roundStartAt = 0;       // performance.now() when 'rd' landed (drives the countdown)
  let roundOver = false;      // between rounds / after match
  let matchWinner = -1;       // rider idx once the match is decided
  let banner = '';            // big center text ('3','2','1','GO!','ROUND 2', 'WINNER ...')
  let bannerUntil = 0;
  let tickMs = TICK_START_MS;
  let acc = 0;
  let lastFrame = performance.now();
  let endReported = false;

  const idx = (x: number, y: number) => y * TRN_COLS + x;

  // --- DOM overlay ---
  const overlay = document.createElement('div');
  overlay.id = 'tronOverlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:20000;background:rgba(2,2,8,0.9);display:flex;align-items:center;' +
    'justify-content:center;flex-direction:column;font-family:ui-monospace,monospace;';
  // canvas wrapped so the CRT scanline layer can sit exactly on top of it
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;height:min(90vh,56.25vw);aspect-ratio:16/9;';
  const canvas = document.createElement('canvas');
  canvas.width = TRN_COLS * CELL; canvas.height = TRN_ROWS * CELL;
  canvas.style.cssText =
    'width:100%;height:100%;background:#000;border:2px solid #0af3;border-radius:6px;' +
    'box-shadow:0 0 60px #00e5ff22, inset 0 0 120px #000c;';
  const ctx = canvas.getContext('2d')!;
  const scan = document.createElement('div');
  scan.style.cssText =
    'position:absolute;inset:0;pointer-events:none;border-radius:6px;' +
    'background:repeating-linear-gradient(transparent 0 2px, #0003 2px 3px);' +
    'box-shadow:inset 0 0 80px #000a;';
  wrap.append(canvas, scan);
  overlay.appendChild(wrap);

  // cached vignette layer (drawn once, composited every frame)
  const vig = document.createElement('canvas');
  vig.width = canvas.width; vig.height = canvas.height;
  {
    const vctx = vig.getContext('2d')!;
    const g = vctx.createRadialGradient(vig.width / 2, vig.height / 2, vig.height * 0.35, vig.width / 2, vig.height / 2, vig.height * 0.95);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,10,20,0.55)');
    vctx.fillStyle = g;
    vctx.fillRect(0, 0, vig.width, vig.height);
  }

  // neon title glow for the menu (scoped keyframes)
  const styleEl = document.createElement('style');
  styleEl.textContent =
    '@keyframes trnGlow { 0%,100% { text-shadow: 0 0 24px #00e5ff88, 0 0 60px #00e5ff33; }' +
    ' 50% { text-shadow: 0 0 40px #00e5ffcc, 0 0 90px #00e5ff55; } }';
  overlay.appendChild(styleEl);

  // --- derez particles (death explosions) ---
  interface Spark { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; }
  let sparks: Spark[] = [];
  const spawnDerez = (r: Rider) => {
    const cx = r.x * CELL + CELL / 2, cy = r.y * CELL + CELL / 2;
    for (let i = 0; i < 42; i++) {
      const a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 260;
      sparks.push({
        x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0, max: 0.5 + Math.random() * 0.6, color: r.color,
      });
    }
  };
  const updateSparks = (dt: number) => {
    for (const s of sparks) { s.life += dt; s.x += s.vx * dt; s.y += s.vy * dt; s.vx *= 0.96; s.vy *= 0.96; }
    sparks = sparks.filter((s) => s.life < s.max);
  };

  // menu / lobby layer sits on top of the canvas
  const ui = document.createElement('div');
  ui.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'flex-direction:column;gap:14px;color:#bfe9ff;text-align:center;';
  overlay.appendChild(ui);

  // NOW PLAYING banner (top-right, slides in per track)
  const nowPlaying = document.createElement('div');
  nowPlaying.style.cssText =
    'position:absolute;top:18px;right:-420px;max-width:380px;padding:10px 16px;z-index:6;' +
    'background:#04121ae8;border:1px solid #00e5ff88;border-left:4px solid #00e5ff;border-radius:8px;' +
    'color:#bfe9ff;font-size:13px;text-align:left;transition:right .45s ease;pointer-events:none;' +
    'box-shadow:0 4px 24px #000c;';
  overlay.appendChild(nowPlaying);
  let npTimer = 0;
  const showNowPlaying = (track: string) => {
    const pretty = track.replace(/\.mp3$/, '').replace(/[-_]/g, ' ').toUpperCase();
    nowPlaying.innerHTML = `<span style="color:#00e5ff">♫ NOW PLAYING</span><br><b style="font-size:15px">${pretty}</b>`;
    nowPlaying.style.right = '18px';
    window.clearTimeout(npTimer);
    npTimer = window.setTimeout(() => { nowPlaying.style.right = '-420px'; }, 4500);
  };

  // --- music shuffle ---
  let song: HTMLAudioElement | null = null;
  let songName = '';
  const playRandomSong = () => {
    const pool = MUSIC.filter((m) => m !== songName);
    songName = pool[Math.floor(Math.random() * pool.length)];
    song?.pause();
    song = new Audio(`/${songName}`);
    song.volume = 0.4;
    song.muted = net.muted();
    song.onended = () => { if (tronOpen && mode === 'play') playRandomSong(); };
    song.play().catch(() => { /* autoplay policy — next user gesture will land */ });
    showNowPlaying(songName);
  };
  const stopMusic = () => { song?.pause(); song = null; songName = ''; };

  // --- UI builders ---
  const btn = (label: string, color: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText =
      `cursor:pointer;font:inherit;font-size:16px;font-weight:800;letter-spacing:2px;padding:12px 34px;` +
      `background:#04121a;color:${color};border:2px solid ${color};border-radius:8px;text-transform:uppercase;`;
    b.onmouseenter = () => { b.style.background = '#0a2430'; };
    b.onmouseleave = () => { b.style.background = '#04121a'; };
    b.onclick = onClick;
    return b;
  };

  function renderUi() {
    ui.replaceChildren();
    ui.style.display = mode === 'play' ? 'none' : 'flex';
    if (mode === 'menu') {
      const title = document.createElement('div');
      title.innerHTML =
        '<div style="font-size:64px;font-weight:900;letter-spacing:18px;color:#00e5ff;animation:trnGlow 2.6s ease-in-out infinite">TRON</div>' +
        '<div style="font-size:13px;opacity:.7;margin-top:6px;letter-spacing:3px">1–4 RIDERS · LIGHT CYCLES · POWERUP DROPS · FIRST TO 3</div>';
      ui.appendChild(title);
      ui.appendChild(btn('Join Grid', '#00e5ff', () => net.join()));
      ui.appendChild(btn('Exit', '#8aa', close));
    } else if (mode === 'lobby') {
      const roster = document.createElement('div');
      const humans = lobbyState?.players ?? [];
      const maxBots = Math.max(0, TRN_MAX_PLAYERS - humans.length);
      if (botCount > maxBots) botCount = maxBots;
      const minBots = humans.length >= 2 ? 0 : 1; // solo needs at least one bot to race
      if (botCount < minBots) botCount = minBots;
      roster.style.cssText = 'font-size:15px;line-height:2;min-width:340px;';
      roster.innerHTML =
        '<div style="font-size:22px;font-weight:900;letter-spacing:6px;color:#00e5ff;margin-bottom:8px">THE GRID</div>' +
        humans.map((p) =>
          `<div style="color:${COLORS[p.slot]}">■ ${p.name}${p.slot === 0 ? ' <span style="opacity:.6">(host)</span>' : ''}${p.slot === selfSlot ? ' <span style="opacity:.6">(you)</span>' : ''}</div>`,
        ).join('') +
        Array.from({ length: isHost ? botCount : 0 }, (_, i) =>
          `<div style="color:${COLORS[humans.length + i]};opacity:.75">■ ${BOT_NAMES[i]} <span style="opacity:.6">(bot)</span></div>`,
        ).join('');
      ui.appendChild(roster);
      if (isHost) {
        const botRow = document.createElement('div');
        botRow.style.cssText = 'display:flex;gap:12px;align-items:center;font-size:15px;';
        const minus = btn('−', '#ff9a00', () => { botCount = Math.max(minBots, botCount - 1); renderUi(); });
        const plus = btn('+', '#ff9a00', () => { botCount = Math.min(maxBots, botCount + 1); renderUi(); });
        for (const b of [minus, plus]) { b.style.padding = '4px 14px'; b.style.fontSize = '18px'; }
        const label = document.createElement('span');
        label.textContent = `Bots: ${botCount}`;
        botRow.append(minus, label, plus);
        ui.appendChild(botRow);
        const puToggle = btn(powerupsOn ? '⚡ Powerups: ON' : '⚡ Powerups: OFF', powerupsOn ? '#ffd060' : '#556', () => { powerupsOn = !powerupsOn; renderUi(); });
        puToggle.style.fontSize = '13px'; puToggle.style.padding = '8px 20px';
        ui.appendChild(puToggle);
        const canStart = humans.length + botCount >= 2;
        const start = btn('Start Match', '#89ff2a', () => { if (canStart) net.start(); });
        if (!canStart) { start.style.opacity = '0.4'; start.style.cursor = 'default'; }
        ui.appendChild(start);
      } else {
        const wait = document.createElement('div');
        wait.style.cssText = 'font-size:13px;opacity:.7;';
        wait.textContent = 'waiting for the host to start...';
        ui.appendChild(wait);
      }
      // powerup legend — so nobody grabs a 🧨 wondering what it does
      const legend = document.createElement('div');
      legend.style.cssText =
        'font-size:12.5px;line-height:1.9;text-align:left;background:#04121acc;border:1px solid #0d3a4a;' +
        'border-radius:10px;padding:12px 18px;margin-top:4px;';
      legend.innerHTML =
        '<div style="font-size:11px;letter-spacing:3px;color:#4a7a92;margin-bottom:4px">POWERUP DROPS — RIDE OVER TO GRAB</div>' +
        `<span style="color:${PU[0].color}">⚡ BOOST</span> — double speed for 2s (steer carefully)<br>` +
        `<span style="color:${PU[1].color}">✂️ CUTTER</span> — pass through the next wall of light (one charge)<br>` +
        `<span style="color:${PU[2].color}">👻 PHASE</span> — ghost through everything for 1.5s, lay no trail<br>` +
        `<span style="color:${PU[3].color}">🧨 DEREZ BOMB</span> — blows a 9×9 hole in every trail around you<br>` +
        `<span style="color:${PU[4].color}">🐌 JAM</span> — every OTHER rider drops to half speed for 2s`;
      ui.appendChild(legend);
      ui.appendChild(btn('Leave', '#8aa', () => { net.leave(); mode = 'menu'; renderUi(); }));
    } else if (mode === 'ended') {
      const msg = document.createElement('div');
      msg.style.cssText = 'font-size:20px;color:#ff9a00;';
      msg.textContent = 'The host disconnected — match over.';
      ui.appendChild(msg);
      ui.appendChild(btn('Back', '#8aa', () => { mode = 'menu'; renderUi(); }));
    }
  }

  // --- round / match orchestration (HOST) ---
  const MIDX = Math.floor(TRN_COLS / 2), MIDY = Math.floor(TRN_ROWS / 2);
  const SPAWNS: [number, number, number][] = [
    [16, MIDY, 1],                   // left edge, facing right
    [TRN_COLS - 17, MIDY, 3],        // right edge, facing left
    [MIDX, 14, 2],                   // top, facing down
    [MIDX, TRN_ROWS - 15, 0],        // bottom, facing up
  ];

  function hostBuildRiders() {
    const humans = lobbyState?.players ?? [];
    const fresh = (over: Partial<Rider>): Rider => ({
      name: '', color: COLORS[0], bot: false, lobbySlot: -1,
      x: 0, y: 0, dir: 0, pendingDir: 0, alive: true, wins: 0,
      boostUntil: 0, cutter: false, phaseUntil: 0, jamUntil: 0, fx: 0,
      ...over,
    });
    riders = humans.map((p) => fresh({ name: p.name, color: COLORS[p.slot], lobbySlot: p.slot }));
    for (let i = 0; i < botCount && riders.length < TRN_MAX_PLAYERS; i++) {
      riders.push(fresh({ name: BOT_NAMES[i], color: COLORS[riders.length], bot: true }));
    }
  }

  function hostStartRound() {
    round++;
    grid.fill(0);
    roundOver = false;
    tickMs = TICK_START_MS;
    acc = 0;
    tickNo = 0;
    pickups = [];
    riders.forEach((r, i) => {
      // rotate spawn assignment each round so nobody owns the "good" corner
      const [x, y, d] = SPAWNS[(i + round - 1) % SPAWNS.length];
      r.x = x; r.y = y; r.dir = d; r.pendingDir = d; r.alive = true;
      r.boostUntil = 0; r.cutter = false; r.phaseUntil = 0; r.jamUntil = 0; r.fx = 0;
      grid[idx(x, y)] = i + 1;
    });
    roundStartAt = performance.now();
    nextPickupAt = roundStartAt + COUNTDOWN_MS + 3000;
    net.relay({
      t: 'rd', round,
      riders: riders.map((r) => ({ name: r.name, bot: r.bot, lobbySlot: r.lobbySlot })),
      spawns: riders.map((r) => [r.x, r.y, r.dir]),
      wins: riders.map((r) => r.wins),
    });
    banner = `ROUND ${round}`;
    bannerUntil = roundStartAt + COUNTDOWN_MS;
  }

  // Bot brain: rank straight/left/right by open run length ahead, pick the best (with a dash
  // of chaos so they don't ride perfect lines forever).
  function botThink(r: Rider) {
    const free = (x: number, y: number) => x >= 0 && x < TRN_COLS && y >= 0 && y < TRN_ROWS && grid[idx(x, y)] === 0;
    const runLen = (d: number, cap: number) => {
      let x = r.x, y = r.y, n = 0;
      for (let i = 0; i < cap; i++) {
        x += DX[d]; y += DY[d];
        if (!free(x, y)) break;
        n++;
      }
      return n;
    };
    // a pickup sitting on a candidate ray makes that direction tastier
    const puOnRay = (d: number, cap: number) => {
      let x = r.x, y = r.y;
      for (let i = 0; i < cap; i++) {
        x += DX[d]; y += DY[d];
        if (!free(x, y)) return false;
        if (pickups.some((p) => p.x === x && p.y === y)) return true;
      }
      return false;
    };
    const score = (d: number) => runLen(d, 34) + (puOnRay(d, 26) ? 18 : 0);
    const straight = score(r.dir);
    const left = score((r.dir + 3) % 4);
    const right = score((r.dir + 1) % 4);
    // commit to a turn if the road ahead is short, a pickup beckons, or occasionally for style
    if (straight < 9 || (Math.random() < 0.03 && straight < Math.max(left, right)) || Math.max(left, right) > straight + 10) {
      if (left === right ? Math.random() < 0.5 : left > right) r.pendingDir = (r.dir + 3) % 4;
      else r.pendingDir = (r.dir + 1) % 4;
      if (Math.max(runLen((r.dir + 3) % 4, 24), runLen((r.dir + 1) % 4, 24)) === 0) r.pendingDir = r.dir; // boxed in — ride it out
    }
  }

  function hostTick() {
    tickNo++;
    const now = performance.now();
    const writes: [number, number][] = []; // [cellIdx, value] mutations this tick (guests replay these)
    const events: [number, number, number][] = []; // [0,riderIdx,kind]=grab  [1,x,y]=bomb
    const put = (ci: number, v: number) => { grid[ci] = v; writes.push([ci, v]); };

    // refresh fx bitmasks + apply queued turns (reversals ignored)
    for (let i = 0; i < riders.length; i++) {
      const r = riders[i];
      r.fx = (now < r.boostUntil ? FX_BOOST : 0) | (r.cutter ? FX_CUTTER : 0)
           | (now < r.phaseUntil ? FX_PHASE : 0) | (now < r.jamUntil ? FX_JAM : 0);
      if (!r.alive) continue;
      if (r.bot) botThink(r);
      if ((r.pendingDir + 2) % 4 !== r.dir) r.dir = r.pendingDir;
    }

    const phased = (r: Rider) => now < r.phaseUntil;
    const jammedOut = (r: Rider) => now < r.jamUntil && tickNo % 2 === 1; // jam = move on even ticks only

    const grab = (r: Rider, i: number) => {
      const pi = pickups.findIndex((p) => Math.abs(p.x - r.x) <= 3 && Math.abs(p.y - r.y) <= 3);
      if (pi === -1) return;
      const kind = pickups[pi].kind;
      pickups.splice(pi, 1);
      events.push([0, i, kind]);
      if (kind === 0) r.boostUntil = now + 2000;
      else if (kind === 1) r.cutter = true;
      else if (kind === 2) r.phaseUntil = now + 1500;
      else if (kind === 3) {
        // derez bomb: carve a 9×9 hole in every trail around the rider
        events.push([1, r.x, r.y]);
        spawnDerez({ x: r.x, y: r.y, color: '#ff5a3a' } as Rider);
        for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
          const bx = r.x + dx, by = r.y + dy;
          if (bx >= 0 && bx < TRN_COLS && by >= 0 && by < TRN_ROWS && grid[idx(bx, by)]) put(idx(bx, by), 0);
        }
        riders.forEach((o, oi) => { if (o.alive) put(idx(o.x, o.y), oi + 1); }); // heads stay solid
      } else if (kind === 4) {
        riders.forEach((o) => { if (o !== r && o.alive) o.jamUntil = now + 2000; });
      }
    };

    // one movement sub-step for rider i; returns false if they derezzed
    const step = (i: number): boolean => {
      const r = riders[i];
      const nx = r.x + DX[r.dir], ny = r.y + DY[r.dir];
      if (nx < 0 || nx >= TRN_COLS || ny < 0 || ny >= TRN_ROWS) { // arena walls cut everything
        r.alive = false; spawnDerez(r); return false;
      }
      const occupied = grid[idx(nx, ny)] !== 0;
      if (occupied && !phased(r)) {
        if (r.cutter) r.cutter = false; // ✂️ spend the charge, ride through
        else { r.alive = false; spawnDerez(r); return false; }
      }
      r.x = nx; r.y = ny;
      if (!phased(r)) put(idx(nx, ny), i + 1); // 👻 lays no trail
      grab(r, i);
      return true;
    };

    // main step: resolve all riders "simultaneously" for fair head-ons
    const heads = riders.map((r) => r.alive && !jammedOut(r) ? [r.x + DX[r.dir], r.y + DY[r.dir]] : null);
    for (let i = 0; i < riders.length; i++) {
      const r = riders[i]; const h = heads[i];
      if (!r.alive || !h) continue;
      for (let j = i + 1; j < riders.length; j++) { // same-cell head-on: both explode (unless ghosts)
        const o = riders[j];
        if (heads[j] && heads[j]![0] === h[0] && heads[j]![1] === h[1] && !phased(r) && !phased(o)) {
          r.alive = false; o.alive = false; heads[i] = null; heads[j] = null;
          spawnDerez(r); spawnDerez(o);
        }
      }
    }
    for (let i = 0; i < riders.length; i++) {
      if (riders[i].alive && heads[i]) step(i);
    }
    // ⚡ boosted riders take a second sub-step
    for (let i = 0; i < riders.length; i++) {
      const r = riders[i];
      if (r.alive && now < r.boostUntil && !jammedOut(r)) step(i);
    }

    // spawn pickups on free cells away from every head
    if (powerupsOn && now >= nextPickupAt && pickups.length < 6) {
      for (let tries = 0; tries < 30; tries++) {
        const px = 6 + Math.floor(Math.random() * (TRN_COLS - 12));
        const py = 6 + Math.floor(Math.random() * (TRN_ROWS - 12));
        if (grid[idx(px, py)]) continue;
        if (riders.some((r) => r.alive && Math.abs(r.x - px) + Math.abs(r.y - py) < 14)) continue;
        if (pickups.some((p) => p.x === px && p.y === py)) continue;
        pickups.push({ x: px, y: py, kind: Math.floor(Math.random() * PU.length) });
        break;
      }
      nextPickupAt = now + 2800 + Math.random() * 2400;
    }

    for (const [, ri, kind] of events.filter((e) => e[0] === 0)) {
      puMsg = `${riders[ri].name} GRABBED ${PU[kind].name} ${PU[kind].icon}`;
      puMsgUntil = now + 2200;
    }
    net.relay({
      t: 'st',
      r: riders.map((r) => [r.x, r.y, r.dir, r.alive ? 1 : 0, r.fx]),
      w: writes,
      p: pickups.map((p) => [p.x, p.y, p.kind]),
      ev: events,
    });
    tickMs = Math.max(TICK_MIN_MS, tickMs - 0.06); // slow, relentless speed-up

    const alive = riders.filter((r) => r.alive);
    if (alive.length <= 1) {
      roundOver = true;
      const winIdx = alive.length === 1 ? riders.indexOf(alive[0]) : -1;
      if (winIdx >= 0) riders[winIdx].wins++;
      net.relay({ t: 're', winner: winIdx, wins: riders.map((r) => r.wins) });
      if (winIdx >= 0 && riders[winIdx].wins >= TRN_ROUNDS_TO_WIN) {
        matchWinner = winIdx;
        banner = `${riders[winIdx].name} WINS THE GRID`;
        bannerUntil = performance.now() + 5000;
        net.relay({ t: 'end', winner: winIdx });
        if (!endReported) { endReported = true; net.end(riders[winIdx].lobbySlot); }
        window.setTimeout(() => { if (tronOpen) backToLobby(); }, 4200);
      } else {
        banner = winIdx >= 0 ? `${riders[winIdx].name} takes round ${round}` : 'DRAW — rerun';
        bannerUntil = performance.now() + 2000;
        window.setTimeout(() => { if (tronOpen && mode === 'play' && matchWinner < 0) hostStartRound(); }, 2200);
      }
    }
  }

  function backToLobby() {
    mode = 'lobby';
    stopMusic();
    matchWinner = -1;
    round = 0;
    endReported = false;
    renderUi();
  }

  // --- guest mirror ---
  function guestApply(d: any) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'rd') {
      round = d.round;
      grid.fill(0);
      roundOver = false;
      matchWinner = -1;
      pickups = [];
      puMsg = '';
      riders = (d.riders as any[]).map((r: any, i: number) => ({
        name: String(r.name), color: COLORS[i], bot: !!r.bot, lobbySlot: r.lobbySlot ?? -1,
        x: d.spawns[i][0], y: d.spawns[i][1], dir: d.spawns[i][2], pendingDir: d.spawns[i][2],
        alive: true, wins: (d.wins as number[])[i] ?? 0,
        boostUntil: 0, cutter: false, phaseUntil: 0, jamUntil: 0, fx: 0,
      }));
      riders.forEach((r, i) => { grid[idx(r.x, r.y)] = i + 1; });
      roundStartAt = performance.now();
      banner = `ROUND ${round}`;
      bannerUntil = roundStartAt + COUNTDOWN_MS;
      if (mode !== 'play') { mode = 'play'; renderUi(); playRandomSong(); }
    } else if (d.t === 'st') {
      // replay the host's exact grid mutations (trails, cutter carves, bomb holes)
      for (const [ci, v] of (d.w ?? []) as [number, number][]) grid[ci] = v;
      (d.r as [number, number, number, number, number][]).forEach((h, i) => {
        const r = riders[i];
        if (!r) return;
        r.dir = h[2];
        const wasAlive = r.alive;
        r.alive = h[3] === 1;
        r.fx = h[4] ?? 0;
        if (r.alive || wasAlive) { r.x = h[0]; r.y = h[1]; }
        if (!r.alive && wasAlive) spawnDerez(r); // derez burst where the wall got them
      });
      pickups = ((d.p ?? []) as [number, number, number][]).map(([x, y, kind]) => ({ x, y, kind }));
      for (const ev of ((d.ev ?? []) as [number, number, number][])) {
        if (ev[0] === 0 && riders[ev[1]]) {
          puMsg = `${riders[ev[1]].name} GRABBED ${PU[ev[2]].name} ${PU[ev[2]].icon}`;
          puMsgUntil = performance.now() + 2200;
        } else if (ev[0] === 1) {
          spawnDerez({ x: ev[1], y: ev[2], color: '#ff5a3a' } as Rider); // bomb flash
        }
      }
    } else if (d.t === 're') {
      roundOver = true;
      (d.wins as number[]).forEach((w, i) => { if (riders[i]) riders[i].wins = w; });
      banner = d.winner >= 0 ? `${riders[d.winner]?.name ?? '?'} takes round ${round}` : 'DRAW — rerun';
      bannerUntil = performance.now() + 2000;
    } else if (d.t === 'end') {
      matchWinner = d.winner;
      banner = `${riders[d.winner]?.name ?? '?'} WINS THE GRID`;
      bannerUntil = performance.now() + 5000;
      window.setTimeout(() => { if (tronOpen) backToLobby(); }, 4200);
    } else if (d.t === 'in' && isHost) {
      // guest direction packet: only steer a live HUMAN rider
      const s = d.s as number, dir = d.d as number;
      const r = riders[s];
      if (r && !r.bot && r.alive && dir >= 0 && dir <= 3) r.pendingDir = dir;
    }
  }

  // --- input ---
  const myRiderIdx = () => riders.findIndex((r) => r.lobbySlot === selfSlot);
  function steer(dir: number) {
    const i = myRiderIdx();
    if (i < 0 || !riders[i]?.alive) return;
    if (isHost) riders[i].pendingDir = dir;
    else { riders[i].pendingDir = dir; net.relay({ t: 'in', s: i, d: dir }); }
  }
  const KEYMAP: Record<string, number> = {
    ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3,
    w: 0, d: 1, s: 2, a: 3, W: 0, D: 1, S: 2, A: 3,
  };
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (mode !== 'play') return;
    const dir = KEYMAP[e.key];
    if (dir !== undefined) { e.preventDefault(); e.stopPropagation(); steer(dir); }
  }
  window.addEventListener('keydown', onKeyDown, true);

  // --- rendering ---
  function render() {
    const W = canvas.width, H = canvas.height;
    const now = performance.now();
    // deep-space backdrop with a slow breathing floor gradient
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#01040a');
    bg.addColorStop(1, '#03101c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    // the Grid™ — minor lines breathe, major lines every 32 cells run brighter
    const pulse = 0.5 + 0.25 * Math.sin(now / 1400);
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(14, 62, 84, ${pulse * 0.7})`;
    ctx.beginPath();
    for (let x = 8; x < TRN_COLS; x += 8) { ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, H); }
    for (let y = 8; y < TRN_ROWS; y += 8) { ctx.moveTo(0, y * CELL); ctx.lineTo(W, y * CELL); }
    ctx.stroke();
    ctx.strokeStyle = `rgba(0, 190, 255, ${pulse * 0.28})`;
    ctx.beginPath();
    for (let x = 32; x < TRN_COLS; x += 32) { ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, H); }
    for (let y = 32; y < TRN_ROWS; y += 32) { ctx.moveTo(0, y * CELL); ctx.lineTo(W, y * CELL); }
    ctx.stroke();

    // trails — one glow pass + one crisp pass PER COLOR (batched paths keep shadowBlur cheap)
    const byColor: number[][] = [[], [], [], []];
    for (let i = 0; i < grid.length; i++) { const v = grid[i]; if (v) byColor[v - 1].push(i); }
    for (let c = 0; c < riders.length; c++) {
      const cells = byColor[c];
      if (!cells.length) continue;
      ctx.beginPath();
      for (const ci of cells) {
        const x = (ci % TRN_COLS) * CELL, y = ((ci / TRN_COLS) | 0) * CELL;
        ctx.rect(x + 1, y + 1, CELL - 2, CELL - 2);
      }
      ctx.shadowColor = COLORS[c]; ctx.shadowBlur = 10;
      ctx.fillStyle = COLORS[c]; ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      // hot core line down the middle of the beam
      ctx.beginPath();
      for (const ci of cells) {
        const x = (ci % TRN_COLS) * CELL, y = ((ci / TRN_COLS) | 0) * CELL;
        ctx.rect(x + 3, y + 3, CELL - 6, CELL - 6);
      }
      ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.35;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // powerup pickups — pulsing glow diamonds with their icon
    for (const p of pickups) {
      const cx = p.x * CELL + CELL / 2, cy = p.y * CELL + CELL / 2;
      const pu = PU[p.kind];
      const puls = 1 + 0.18 * Math.sin(now / 220 + p.x);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI / 4);
      ctx.shadowColor = pu.color; ctx.shadowBlur = 22;
      ctx.fillStyle = '#04121a';
      ctx.strokeStyle = pu.color; ctx.lineWidth = 2.5;
      const s = 13 * puls;
      ctx.fillRect(-s, -s, s * 2, s * 2);
      ctx.strokeRect(-s, -s, s * 2, s * 2);
      ctx.restore();
      ctx.shadowBlur = 0;
      ctx.font = `${Math.round(17 * puls)}px serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(pu.icon, cx, cy + 1);
    }

    // heads — elongated cycle body along the travel direction, white-hot core, big glow
    for (const r of riders) {
      if (!r.alive) continue;
      const cx = r.x * CELL + CELL / 2, cy = r.y * CELL + CELL / 2;
      const horiz = r.dir === 1 || r.dir === 3;
      const boosted = !!(r.fx & FX_BOOST);
      const len = CELL * (boosted ? 4.4 : 3.2), thick = CELL * 1.7;
      if (r.fx & FX_PHASE) ctx.globalAlpha = 0.35 + 0.3 * Math.sin(now / 70); // 👻 flicker
      ctx.shadowColor = r.color; ctx.shadowBlur = boosted ? 38 : 26;
      ctx.fillStyle = r.color;
      ctx.fillRect(cx - (horiz ? len : thick) / 2, cy - (horiz ? thick : len) / 2, horiz ? len : thick, horiz ? thick : len);
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#fff';
      const cl = len * 0.55, ct = thick * 0.5;
      ctx.fillRect(cx - (horiz ? cl : ct) / 2, cy - (horiz ? ct : cl) / 2, horiz ? cl : ct, horiz ? ct : cl);
      ctx.shadowBlur = 0;
      if (r.fx & FX_CUTTER) { // ✂️ armed: white ring around the cycle
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.strokeRect(cx - len / 2 - 4, cy - len / 2 - 4, len + 8, len + 8);
      }
      if (r.fx & FX_JAM) { // 🐌 slimed
        ctx.font = '16px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText('🐌', cx, cy - CELL);
      }
      ctx.globalAlpha = 1;
    }

    // derez sparks
    for (const s of sparks) {
      const t = 1 - s.life / s.max;
      ctx.globalAlpha = t;
      ctx.fillStyle = Math.random() < 0.25 ? '#fff' : s.color;
      const sz = 2 + t * 3;
      ctx.fillRect(s.x - sz / 2, s.y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;

    // vignette on top of the playfield, under the HUD
    ctx.drawImage(vig, 0, 0);

    // HUD — name plates with dim backing, glowing win pips, round marker up top
    if (riders.length) {
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.font = '700 20px ui-monospace, monospace';
      riders.forEach((r, i) => {
        const x = 20 + i * 250;
        ctx.fillStyle = '#00000088';
        ctx.fillRect(x - 10, 8, 228, 52);
        ctx.fillStyle = r.alive || roundOver ? r.color : '#444a55';
        ctx.fillText(`${r.name}${r.bot ? ' ·bot' : ''}`, x, 14);
        for (let w = 0; w < TRN_ROUNDS_TO_WIN; w++) {
          if (w < r.wins) { ctx.shadowColor = r.color; ctx.shadowBlur = 10; ctx.fillStyle = r.color; }
          else { ctx.shadowBlur = 0; ctx.fillStyle = '#1a2230'; }
          ctx.fillRect(x + w * 20, 44, 15, 8);
        }
        ctx.shadowBlur = 0;
      });
      if (mode === 'play') {
        ctx.textAlign = 'center';
        ctx.font = '700 17px ui-monospace, monospace';
        ctx.fillStyle = '#4a7a92';
        ctx.fillText(`— ROUND ${round} · FIRST TO ${TRN_ROUNDS_TO_WIN} —`, W / 2, 18);
        if (puMsg && now < puMsgUntil) {
          ctx.font = '700 16px ui-monospace, monospace';
          ctx.fillStyle = '#ffd060';
          ctx.shadowColor = '#ffd060'; ctx.shadowBlur = 12;
          ctx.fillText(puMsg, W / 2, 42);
          ctx.shadowBlur = 0;
        }
      }
    }

    // center countdown — numbers slam in (scale + fade), then GO! flashes
    if (mode === 'play' && now < roundStartAt + COUNTDOWN_MS + 400) {
      const elapsed = now - roundStartAt;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (elapsed < COUNTDOWN_MS) {
        const seg = COUNTDOWN_MS / 3;
        const n = 3 - Math.floor(elapsed / seg);
        const frac = (elapsed % seg) / seg;           // 0 → 1 within this digit
        const scale = 1.6 - frac * 0.6;               // slams from big to resting size
        ctx.font = `900 ${Math.round(160 * scale)}px ui-monospace, monospace`;
        ctx.globalAlpha = 1 - frac * 0.35;
        ctx.fillStyle = '#00e5ff';
        ctx.shadowColor = '#00e5ff'; ctx.shadowBlur = 40;
        ctx.fillText(String(n), W / 2, H / 2);
      } else {
        const frac = (elapsed - COUNTDOWN_MS) / 400;
        ctx.font = '900 190px ui-monospace, monospace';
        ctx.globalAlpha = 1 - frac;
        ctx.fillStyle = '#89ff2a';
        ctx.shadowColor = '#89ff2a'; ctx.shadowBlur = 50;
        ctx.fillText('GO!', W / 2, H / 2);
      }
      ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    } else if (banner && now < bannerUntil) {
      const col = matchWinner >= 0 ? COLORS[matchWinner] : '#bfe9ff';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '900 64px ui-monospace, monospace';
      // chromatic double-print behind the main fill
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#ff3df0'; ctx.fillText(banner, W / 2 - 4, H / 2);
      ctx.fillStyle = '#00e5ff'; ctx.fillText(banner, W / 2 + 4, H / 2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = col;
      ctx.shadowColor = col; ctx.shadowBlur = 30;
      ctx.fillText(banner, W / 2, H / 2);
      ctx.shadowBlur = 0;
    }
    if (mode === 'play') {
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.font = '15px ui-monospace, monospace';
      ctx.fillStyle = '#3d5a6a';
      ctx.fillText('ARROWS / WASD TO STEER · ESC TO EXIT', W / 2, H - 10);
    }
  }

  // --- main loop ---
  let raf = 0;
  function loop(now: number) {
    const dt = Math.min(100, now - lastFrame);
    lastFrame = now;
    if (mode === 'play' && isHost && !roundOver && now >= roundStartAt + COUNTDOWN_MS) {
      acc += dt;
      while (acc >= tickMs) { acc -= tickMs; hostTick(); if (roundOver) { acc = 0; break; } }
    }
    updateSparks(dt / 1000);
    if (song) song.muted = net.muted();
    render();
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  // --- server feed handlers ---
  handlers = {
    lobby: (m) => {
      lobbyState = m;
      selfSlot = m.slot;
      isHost = m.slot === m.hostSlot;
      if (m.status === 'ended') { mode = 'ended'; stopMusic(); renderUi(); return; }
      if (m.status === 'playing') {
        if (mode !== 'play' && isHost) {
          // we are the host and the server just flipped us live: build the field and ride
          mode = 'play';
          hostBuildRiders();
          round = 0;
          endReported = false;
          renderUi();
          playRandomSong();
          hostStartRound();
        }
        // guests flip to 'play' when the first 'rd' relay lands (guestApply)
        return;
      }
      if (mode === 'menu' || mode === 'lobby') { mode = 'lobby'; renderUi(); }
    },
    relay: (d) => guestApply(d),
  };

  function close() {
    if (!tronOpen) return;
    tronOpen = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKeyDown, true);
    window.clearTimeout(npTimer);
    stopMusic();
    if (mode === 'lobby' || mode === 'play') net.leave();
    handlers = null;
    overlay.remove();
  }

  document.body.appendChild(overlay);
  renderUi();
}
