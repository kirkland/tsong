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
const CELL = 10;                       // px per grid cell (canvas 1280×720)
const COLORS = ['#00e5ff', '#ff9a00', '#ff3df0', '#89ff2a'] as const; // cyan / orange / magenta / lime
const BOT_NAMES = ['CLU', 'RINZLER', 'SARK'] as const;
const DX = [0, 1, 0, -1] as const;     // 0=up 1=right 2=down 3=left
const DY = [-1, 0, 1, 0] as const;
const TICK_START_MS = 62;              // sim step at round start (arena is big — keep it moving)...
const TICK_MIN_MS = 38;                // ...ramping down to this (faster = harder)
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
}

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

  // --- match state (host simulates; guests mirror from snapshots) ---
  let riders: Rider[] = [];
  let grid = new Uint8Array(TRN_COLS * TRN_ROWS); // 0 = free, else riderIdx+1
  let round = 0;
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
    'position:fixed;inset:0;z-index:9999;background:#020208;display:flex;align-items:center;' +
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
        '<div style="font-size:13px;opacity:.7;margin-top:6px;letter-spacing:3px">1–4 RIDERS · LIGHT CYCLES · LAST ONE RIDING WINS · FIRST TO 3</div>';
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
    riders = humans.map((p) => ({
      name: p.name, color: COLORS[p.slot], bot: false, lobbySlot: p.slot,
      x: 0, y: 0, dir: 0, pendingDir: 0, alive: true, wins: 0,
    }));
    for (let i = 0; i < botCount && riders.length < TRN_MAX_PLAYERS; i++) {
      riders.push({
        name: BOT_NAMES[i], color: COLORS[riders.length], bot: true, lobbySlot: -1,
        x: 0, y: 0, dir: 0, pendingDir: 0, alive: true, wins: 0,
      });
    }
  }

  function hostStartRound() {
    round++;
    grid.fill(0);
    roundOver = false;
    tickMs = TICK_START_MS;
    acc = 0;
    riders.forEach((r, i) => {
      // rotate spawn assignment each round so nobody owns the "good" corner
      const [x, y, d] = SPAWNS[(i + round - 1) % SPAWNS.length];
      r.x = x; r.y = y; r.dir = d; r.pendingDir = d; r.alive = true;
      grid[idx(x, y)] = i + 1;
    });
    roundStartAt = performance.now();
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
    const straight = runLen(r.dir, 24);
    const left = runLen((r.dir + 3) % 4, 24);
    const right = runLen((r.dir + 1) % 4, 24);
    // commit to a turn if the road ahead is short, or occasionally just for style
    if (straight < 6 || (Math.random() < 0.03 && straight < Math.max(left, right))) {
      if (left === right ? Math.random() < 0.5 : left > right) r.pendingDir = (r.dir + 3) % 4;
      else r.pendingDir = (r.dir + 1) % 4;
      if (Math.max(left, right) === 0) r.pendingDir = r.dir; // boxed in — ride it out
    }
  }

  function hostTick() {
    // apply queued turns (reversals are ignored — you can't ride through your own tail)
    for (let i = 0; i < riders.length; i++) {
      const r = riders[i];
      if (!r.alive) continue;
      if (r.bot) botThink(r);
      if ((r.pendingDir + 2) % 4 !== r.dir) r.dir = r.pendingDir;
    }
    // move all heads, then resolve deaths (handles head-on ties fairly)
    const heads = riders.map((r) => r.alive ? [r.x + DX[r.dir], r.y + DY[r.dir]] : null);
    for (let i = 0; i < riders.length; i++) {
      const r = riders[i]; const h = heads[i];
      if (!r.alive || !h) continue;
      const [nx, ny] = h;
      let dead = nx < 0 || nx >= TRN_COLS || ny < 0 || ny >= TRN_ROWS || grid[idx(nx, ny)] !== 0;
      if (!dead) for (let j = 0; j < riders.length; j++) { // same-cell head-on: both explode
        if (j !== i && heads[j] && heads[j]![0] === nx && heads[j]![1] === ny) dead = true;
      }
      if (dead) { r.alive = false; heads[i] = null; spawnDerez(r); continue; }
    }
    for (let i = 0; i < riders.length; i++) {
      const r = riders[i]; const h = heads[i];
      if (!r.alive || !h) continue;
      r.x = h[0]; r.y = h[1];
      grid[idx(r.x, r.y)] = i + 1;
    }
    net.relay({ t: 'st', r: riders.map((r) => [r.x, r.y, r.dir, r.alive ? 1 : 0]) });
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
      riders = (d.riders as any[]).map((r: any, i: number) => ({
        name: String(r.name), color: COLORS[i], bot: !!r.bot, lobbySlot: r.lobbySlot ?? -1,
        x: d.spawns[i][0], y: d.spawns[i][1], dir: d.spawns[i][2], pendingDir: d.spawns[i][2],
        alive: true, wins: (d.wins as number[])[i] ?? 0,
      }));
      riders.forEach((r, i) => { grid[idx(r.x, r.y)] = i + 1; });
      roundStartAt = performance.now();
      banner = `ROUND ${round}`;
      bannerUntil = roundStartAt + COUNTDOWN_MS;
      if (mode !== 'play') { mode = 'play'; renderUi(); playRandomSong(); }
    } else if (d.t === 'st') {
      (d.r as [number, number, number, number][]).forEach((h, i) => {
        const r = riders[i];
        if (!r) return;
        r.dir = h[2];
        const wasAlive = r.alive;
        r.alive = h[3] === 1;
        if (r.alive || wasAlive) { r.x = h[0]; r.y = h[1]; }
        if (r.alive) grid[idx(r.x, r.y)] = i + 1;
        else if (wasAlive) spawnDerez(r); // derez burst where the wall got them
      });
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

    // heads — elongated cycle body along the travel direction, white-hot core, big glow
    for (const r of riders) {
      if (!r.alive) continue;
      const cx = r.x * CELL + CELL / 2, cy = r.y * CELL + CELL / 2;
      const horiz = r.dir === 1 || r.dir === 3;
      const len = CELL * 2.1, thick = CELL * 1.05;
      ctx.shadowColor = r.color; ctx.shadowBlur = 26;
      ctx.fillStyle = r.color;
      ctx.fillRect(cx - (horiz ? len : thick) / 2, cy - (horiz ? thick : len) / 2, horiz ? len : thick, horiz ? thick : len);
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#fff';
      const cl = len * 0.55, ct = thick * 0.5;
      ctx.fillRect(cx - (horiz ? cl : ct) / 2, cy - (horiz ? ct : cl) / 2, horiz ? cl : ct, horiz ? ct : cl);
      ctx.shadowBlur = 0;
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
