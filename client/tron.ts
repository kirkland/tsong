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
const TICK_START_MS = 75;              // sim step at round start...
const TICK_MIN_MS = 45;                // ...ramping down to this (faster = harder)
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
  const canvas = document.createElement('canvas');
  canvas.width = TRN_COLS * CELL; canvas.height = TRN_ROWS * CELL;
  canvas.style.cssText =
    'height:min(90vh,56.25vw);aspect-ratio:16/9;background:#000;border:2px solid #0af3;box-shadow:0 0 40px #0af2;';
  const ctx = canvas.getContext('2d')!;
  overlay.appendChild(canvas);

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
        '<div style="font-size:64px;font-weight:900;letter-spacing:18px;color:#00e5ff;text-shadow:0 0 30px #00e5ff88">TRON</div>' +
        '<div style="font-size:13px;opacity:.7;margin-top:6px">1–4 riders · light cycles · last one riding wins · first to 3 rounds</div>';
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
  const SPAWNS: [number, number, number][] = [
    [14, 36, 1],                     // left edge, facing right
    [TRN_COLS - 15, 36, 3],          // right edge, facing left
    [64, 10, 2],                     // top, facing down
    [64, TRN_ROWS - 11, 0],          // bottom, facing up
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
      if (dead) { r.alive = false; heads[i] = null; continue; }
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
    ctx.fillStyle = '#020208';
    ctx.fillRect(0, 0, W, H);
    // faint grid lines — the Grid™
    ctx.strokeStyle = '#0a2a38';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= TRN_COLS; x += 8) { ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, H); }
    for (let y = 0; y <= TRN_ROWS; y += 8) { ctx.moveTo(0, y * CELL); ctx.lineTo(W, y * CELL); }
    ctx.stroke();
    // trails
    for (let y = 0; y < TRN_ROWS; y++) {
      for (let x = 0; x < TRN_COLS; x++) {
        const v = grid[idx(x, y)];
        if (!v) continue;
        ctx.fillStyle = COLORS[v - 1];
        ctx.globalAlpha = 0.55;
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
        ctx.globalAlpha = 1;
        ctx.fillRect(x * CELL + 2, y * CELL + 2, CELL - 4, CELL - 4);
      }
    }
    // heads (bright core + glow)
    for (const r of riders) {
      if (!r.alive) continue;
      ctx.shadowColor = r.color; ctx.shadowBlur = 18;
      ctx.fillStyle = '#fff';
      ctx.fillRect(r.x * CELL - 1, r.y * CELL - 1, CELL + 2, CELL + 2);
      ctx.shadowBlur = 0;
    }
    // HUD: names + win pips
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.font = '700 16px ui-monospace, monospace';
    riders.forEach((r, i) => {
      const x = 16 + i * 180;
      ctx.fillStyle = r.alive || roundOver ? r.color : '#555';
      ctx.fillText(`${r.name}${r.bot ? '·bot' : ''}`, x, 10);
      for (let w = 0; w < TRN_ROUNDS_TO_WIN; w++) {
        ctx.fillStyle = w < r.wins ? r.color : '#223';
        ctx.fillRect(x + w * 14, 32, 10, 6);
      }
    });
    // center banner / countdown
    const now = performance.now();
    if (mode === 'play' && now < roundStartAt + COUNTDOWN_MS) {
      const left = roundStartAt + COUNTDOWN_MS - now;
      const n = Math.ceil(left / (COUNTDOWN_MS / 3));
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '900 120px ui-monospace, monospace';
      ctx.fillStyle = '#00e5ff';
      ctx.shadowColor = '#00e5ff'; ctx.shadowBlur = 30;
      ctx.fillText(String(n), W / 2, H / 2);
      ctx.shadowBlur = 0;
    } else if (banner && now < bannerUntil) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '900 44px ui-monospace, monospace';
      ctx.fillStyle = matchWinner >= 0 ? COLORS[matchWinner] : '#bfe9ff';
      ctx.shadowColor = matchWinner >= 0 ? COLORS[matchWinner] : '#00e5ff'; ctx.shadowBlur = 24;
      ctx.fillText(banner, W / 2, H / 2);
      ctx.shadowBlur = 0;
    }
    if (mode === 'play') {
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.font = '12px ui-monospace, monospace';
      ctx.fillStyle = '#4a6a7a';
      ctx.fillText('arrows / WASD to steer · ESC to exit · first to 3 rounds', W / 2, H - 8);
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
