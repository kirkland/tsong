// "City Tycoon" — client renderer + UI for the Monopoly-style board game.
//
// The server is fully authoritative (server/cityrise.ts). This module draws the board on a
// canvas, shows a side panel of players + an event log, and sends discrete actions
// (roll / buy / pass / bid / build / end turn / ready). It receives authoritative state
// snapshots via onState() and little toast lines via onEvent().

export interface CityRiseNet {
  send(msg: any): void;
  myPid(): string;
  myName(): string;
}

// --- Space model mirrors server/cityrise.ts (snapshots also ship the board) ---
interface Space {
  kind: string;
  name: string;
  color?: string;
  group?: string;
  price?: number;
  rent?: number[];
  houseCost?: number;
  taxAmount?: number;
}
interface CrPlayerView {
  pid: string; name: string; color: string; money: number; position: number;
  auditTurns: number; bankrupt: boolean; ready: boolean; online: boolean;
  owned: number[]; buildings: Record<number, number>; mortgaged: number[]; bot: boolean;
  jailFreeCards: number;
}
interface CrTradeView {
  id: number; fromPid: string; toPid: string;
  offerProps: number[]; offerCash: number; offerJailFree: number;
  wantProps: number[]; wantCash: number; wantJailFree: number;
}
interface CrGame {
  id: string;
  phase: 'waiting' | 'rolling' | 'buying' | 'auction' | 'building' | 'gameover';
  turnPid: string | null;
  dice: [number, number];
  doublesStreak: number;
  rolledThisTurn: boolean;
  pendingBuy: number | null;
  auction: { position: number; name: string; highBid: number; highPid: string | null; endsAt: number } | null;
  lastCard: { deck: string; text: string } | null;
  winnerPid: string | null;
  deadline: number;
  log: string[];
  board: Space[];
  players: CrPlayerView[];
  jackpot: number;
  bankHouses: number;
  bankHotels: number;
  trades: CrTradeView[];
  chat: { pid: string; name: string; color: string; text: string }[];
  spectatorCount: number;
}

let open = false;
let net: CityRiseNet;
let overlay: HTMLDivElement;
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let sidePanel: HTMLDivElement;
let actionBar: HTMLDivElement;
let toastLayer: HTMLDivElement;
let rafId = 0;
let joinRetryTimer: ReturnType<typeof setInterval> | null = null;

let game: CrGame | null = null;
let selfPid = '';

// --- animation state ---
interface Token { pid: string; drawPos: number; targetPos: number; }
const tokens = new Map<string, Token>();
interface FloatText { x: number; y: number; text: string; color: string; life: number; }
let floats: FloatText[] = [];
let diceAnim = 0;         // >0 while dice are spinning
let lastDiceKey = '';
let buildMode = false;
let confetti: { x: number; y: number; vx: number; vy: number; c: string; life: number }[] = [];
let lastTs = 0;
let activeModal: HTMLDivElement | null = null;
let myPropsBtn: HTMLButtonElement;
let tooltipEl: HTMLDivElement;
let tooltipPos = -1; // board position the tooltip is currently pinned to, -1 = hidden

// --- geometry cache ---
interface Cell { x: number; y: number; w: number; h: number; side: 'bottom' | 'right' | 'top' | 'left' | 'corner'; pos: number; }
let cells: Cell[] = [];
let boardBox = { x: 0, y: 0, size: 0, corner: 0, span: 0 };

const GROUP_ORDER = ['brown', 'cyan', 'pink', 'orange', 'red', 'yellow', 'green', 'navy'];

// ─── Sound (same lazy-AudioContext synth idiom used elsewhere in the client) ────

let ac: AudioContext | null = null;
function soundOn(): boolean {
  return !document.cookie.split('; ').includes('tsong_muted=1');
}
function tone(f0: number, f1: number, dur: number, type: OscillatorType, vol: number): void {
  if (!soundOn()) return;
  try {
    if (!ac) ac = new AudioContext();
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    const t0 = ac.currentTime;
    const o = ac.createOscillator(); const g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(ac.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  } catch { /* audio is a bonus, never a crash */ }
}
function snd(kind: 'roll' | 'cash' | 'pay' | 'bankrupt' | 'win' | 'chat'): void {
  switch (kind) {
    case 'roll': tone(180, 260, 0.12, 'square', 0.05); setTimeout(() => tone(200, 300, 0.1, 'square', 0.04), 90); break;
    case 'cash': tone(660, 880, 0.14, 'sine', 0.06); break;
    case 'pay': tone(300, 180, 0.16, 'sawtooth', 0.05); break;
    case 'bankrupt': tone(220, 80, 0.5, 'sawtooth', 0.07); break;
    case 'win': tone(523, 1046, 0.4, 'sine', 0.07); break;
    case 'chat': tone(880, 1040, 0.08, 'sine', 0.04); break;
  }
}

// ─── Entry / exit ──────────────────────────────────────────────────────────────

export function startCityTycoon(adapter: CityRiseNet): void {
  if (open) return;
  open = true;
  net = adapter;
  selfPid = net.myPid();

  overlay = document.createElement('div');
  overlay.id = 'crOverlay';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:950;background:radial-gradient(circle at 50% 30%,#161633,#0b0b16 70%);' +
    'display:flex;flex-direction:row;align-items:stretch;font-family:system-ui,-apple-system,sans-serif;color:#e8eefc;overflow:hidden;';

  // Board area (canvas)
  const boardWrap = document.createElement('div');
  boardWrap.style.cssText = 'flex:1 1 auto;position:relative;display:flex;align-items:center;justify-content:center;min-width:0;';
  canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;touch-action:none;';
  ctx = canvas.getContext('2d')!;
  boardWrap.appendChild(canvas);

  // Toast layer floats over the board
  toastLayer = document.createElement('div');
  toastLayer.style.cssText = 'position:absolute;top:14px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none;z-index:5;';
  boardWrap.appendChild(toastLayer);

  // Side panel
  sidePanel = document.createElement('div');
  sidePanel.style.cssText =
    'flex:0 0 300px;max-width:340px;background:linear-gradient(180deg,#12122a,#0d0d1c);border-left:1px solid #2a2a44;' +
    'display:flex;flex-direction:column;padding:14px;gap:10px;overflow-y:auto;';

  const title = document.createElement('div');
  title.innerHTML = '🏙️ <b>City Tycoon</b>';
  title.style.cssText = 'font-size:20px;letter-spacing:.5px;background:linear-gradient(90deg,#8b7bff,#4dd0e1);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;';
  sidePanel.appendChild(title);

  myPropsBtn = btn('crMyProps', '#2a2a5a', () => openPropertiesModal(), '🏢 My Properties');
  sidePanel.appendChild(myPropsBtn);

  const bankLine = document.createElement('div');
  bankLine.id = 'crBank';
  bankLine.style.cssText = 'font-size:11px;color:#9aa0c8;';
  sidePanel.appendChild(bankLine);

  const playerList = document.createElement('div');
  playerList.id = 'crPlayers';
  playerList.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  sidePanel.appendChild(playerList);

  const tradesBox = document.createElement('div');
  tradesBox.id = 'crTrades';
  tradesBox.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  sidePanel.appendChild(tradesBox);

  const chatBox = document.createElement('div');
  chatBox.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
  const chatTitle = document.createElement('div');
  chatTitle.textContent = '💬 Chat';
  chatTitle.style.cssText = 'font-size:11px;font-weight:600;color:#9aa0c8;';
  chatBox.appendChild(chatTitle);
  const chatList = document.createElement('div');
  chatList.id = 'crChatList';
  chatList.style.cssText = 'max-height:110px;overflow-y:auto;background:#0a0a14;border:1px solid #23233c;border-radius:8px;padding:6px 8px;font-size:12px;line-height:1.5;color:#dfe3f2;display:flex;flex-direction:column;gap:2px;';
  chatBox.appendChild(chatList);
  const chatRow = document.createElement('div');
  chatRow.style.cssText = 'display:flex;gap:6px;';
  const chatInput = document.createElement('input');
  chatInput.id = 'crChatInput';
  chatInput.type = 'text';
  chatInput.maxLength = 200;
  chatInput.placeholder = 'Say something…';
  chatInput.style.cssText = 'flex:1 1 auto;min-width:0;padding:7px 9px;border-radius:8px;border:1px solid #33335a;background:#0a0a16;color:#fff;font-size:12px;';
  const sendChat = () => {
    const text = chatInput.value.trim();
    if (!text) return;
    net.send({ type: 'crChat', text });
    chatInput.value = '';
  };
  // Stop keystrokes from bubbling to the document-level handler (Escape/R shortcuts) while typing.
  chatInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') sendChat(); });
  chatRow.appendChild(chatInput);
  chatRow.appendChild(btn('crChatSend', '#2a2a5a', sendChat, '➤'));
  chatBox.appendChild(chatRow);
  sidePanel.appendChild(chatBox);

  const logBox = document.createElement('div');
  logBox.id = 'crLog';
  logBox.style.cssText = 'flex:1 1 auto;min-height:80px;background:#0a0a14;border:1px solid #23233c;border-radius:8px;padding:8px;font-size:12px;line-height:1.5;overflow-y:auto;color:#b9c0dd;';
  sidePanel.appendChild(logBox);

  actionBar = document.createElement('div');
  actionBar.id = 'crActions';
  actionBar.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
  sidePanel.appendChild(actionBar);

  overlay.append(boardWrap, sidePanel);
  document.body.appendChild(overlay);

  tooltipEl = document.createElement('div');
  tooltipEl.style.cssText =
    'position:fixed;z-index:970;background:#14142c;border:1px solid #33335a;border-radius:8px;padding:10px 12px;' +
    'font-size:12px;line-height:1.5;color:#e8eefc;box-shadow:0 4px 16px rgba(0,0,0,.5);pointer-events:none;display:none;max-width:220px;';
  document.body.appendChild(tooltipEl);

  window.addEventListener('resize', layout);
  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('mousemove', onCanvasHover);
  canvas.addEventListener('mouseleave', hideTooltip);
  document.addEventListener('keydown', onKey);

  layout();
  net.send({ type: 'crJoin' });
  joinRetryTimer = setInterval(() => {
    if (!open || game) { clearInterval(joinRetryTimer!); joinRetryTimer = null; return; }
    net.send({ type: 'crJoin' }); // retry if no state received yet (reconnect, dropped packet)
  }, 3000);
  lastTs = performance.now();
  rafId = requestAnimationFrame(loop);
}

export function closeCityTycoon(): void {
  if (!open) return;
  open = false;
  if (joinRetryTimer) { clearInterval(joinRetryTimer); joinRetryTimer = null; }
  net.send({ type: 'crLeave' });
  cancelAnimationFrame(rafId);
  window.removeEventListener('resize', layout);
  canvas.removeEventListener('click', onCanvasClick);
  canvas.removeEventListener('mousemove', onCanvasHover);
  canvas.removeEventListener('mouseleave', hideTooltip);
  document.removeEventListener('keydown', onKey);
  overlay?.remove();
  activeModal?.remove(); activeModal = null;
  tooltipEl?.remove(); tooltipPos = -1;
  game = null; tokens.clear(); floats = []; confetti = []; buildMode = false;
}

export function isCityTycoonOpen(): boolean { return open; }

function onKey(e: KeyboardEvent) {
  if (!open) return;
  if (e.key === 'Escape') { if (activeModal) { closeModal(); return; } closeCityTycoon(); return; }
  // Easter egg: press "R" to reroll the dice cosmetically for a little jiggle of hope.
  if (e.key === 'r' && game && game.phase === 'rolling' && game.turnPid === selfPid) { net.send({ type: 'crRoll' }); }
}

// ─── Server messages ─────────────────────────────────────────────────────────

export function onState(g: CrGame): void {
  if (!open) return;
  if (joinRetryTimer) { clearInterval(joinRetryTimer); joinRetryTimer = null; }
  const prev = game;
  game = g;
  // Floating +/- coin text over a player's token when their cash changes.
  if (prev && cells.length) {
    for (const p of g.players) {
      const old = prev.players.find((q) => q.pid === p.pid);
      if (!old) continue;
      const delta = p.money - old.money;
      if (Math.abs(delta) >= 5) {
        const c = cellCenter(Math.round(tokens.get(p.pid)?.drawPos ?? p.position));
        floats.push({ x: c.x, y: c.y - boardBox.corner * 0.3, text: (delta > 0 ? '+' : '') + '$' + delta, color: delta > 0 ? '#7CFC7C' : '#ff6b6b', life: 1.4 });
      }
    }
  }
  // Seed / update tokens (animate movement).
  for (const p of g.players) {
    const t = tokens.get(p.pid);
    if (!t) tokens.set(p.pid, { pid: p.pid, drawPos: p.position, targetPos: p.position });
    else t.targetPos = p.position;
  }
  for (const pid of [...tokens.keys()]) if (!g.players.some((p) => p.pid === pid)) tokens.delete(pid);

  // Trigger dice animation when a fresh roll arrives.
  const dk = `${g.turnPid}:${g.dice[0]}:${g.dice[1]}:${g.rolledThisTurn}`;
  if (g.rolledThisTurn && dk !== lastDiceKey) { diceAnim = 0.9; snd('roll'); }
  lastDiceKey = dk;

  // A light ping for an incoming chat line from someone else (not your own, just sent).
  if (prev && g.chat.length > prev.chat.length) {
    const latest = g.chat[g.chat.length - 1];
    if (latest && latest.pid !== selfPid) snd('chat');
  }

  // Confetti + fanfare on win.
  if (g.phase === 'gameover' && g.winnerPid && (!prev || prev.phase !== 'gameover')) { burstConfetti(); snd('win'); }

  layout();
  renderPanel();
}

export function onEvent(text: string, kind: 'info' | 'warn' | 'success' | 'error'): void {
  if (!open) return;
  if (kind === 'success') snd('cash');
  else if (kind === 'error') snd('bankrupt');
  else if (kind === 'warn') snd('pay');
  const el = document.createElement('div');
  const bg = kind === 'success' ? '#1c5c2e' : kind === 'error' ? '#6c1c1c' : kind === 'warn' ? '#6c561c' : '#22224a';
  el.textContent = text;
  el.style.cssText =
    `background:${bg};color:#fff;padding:7px 14px;border-radius:20px;font-size:13px;font-weight:600;` +
    'box-shadow:0 4px 16px rgba(0,0,0,.45);max-width:70vw;text-align:center;opacity:0;transition:opacity .2s;';
  toastLayer.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '1'; });
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3200);
  while (toastLayer.children.length > 4) toastLayer.firstChild?.remove();
}

// ─── Layout / geometry ─────────────────────────────────────────────────────────

function layout(): void {
  if (!open) return;
  const wrap = canvas.parentElement as HTMLElement;
  const availW = wrap.clientWidth || (window.innerWidth - 320);
  const availH = wrap.clientHeight || window.innerHeight;
  const size = Math.max(320, Math.min(availW, availH) * 0.94);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const corner = size * 0.132;
  const span = (size - 2 * corner) / 9;
  boardBox = { x: 0, y: 0, size, corner, span };
  cells = new Array(40);
  const S = size, C = corner, L = span;
  // 0 = bottom-right corner (GO), play proceeds clockwise like the real board.
  cells[0] = { x: S - C, y: S - C, w: C, h: C, side: 'corner', pos: 0 };
  // 1..9 bottom row right→left
  for (let i = 1; i <= 9; i++) cells[i] = { x: S - C - i * L, y: S - C, w: L, h: C, side: 'bottom', pos: i };
  cells[10] = { x: 0, y: S - C, w: C, h: C, side: 'corner', pos: 10 }; // bottom-left
  // 11..19 left column bottom→top
  for (let i = 11; i <= 19; i++) { const k = i - 10; cells[i] = { x: 0, y: S - C - k * L, w: C, h: L, side: 'left', pos: i }; }
  cells[20] = { x: 0, y: 0, w: C, h: C, side: 'corner', pos: 20 }; // top-left
  // 21..29 top row left→right
  for (let i = 21; i <= 29; i++) { const k = i - 20; cells[i] = { x: C + (k - 1) * L, y: 0, w: L, h: C, side: 'top', pos: i }; }
  cells[30] = { x: S - C, y: 0, w: C, h: C, side: 'corner', pos: 30 }; // top-right
  // 31..39 right column top→bottom
  for (let i = 31; i <= 39; i++) { const k = i - 30; cells[i] = { x: S - C, y: C + (k - 1) * L, w: C, h: L, side: 'right', pos: i }; }
}

// ─── Render loop ─────────────────────────────────────────────────────────────

function loop(ts: number) {
  if (!open) return;
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;

  // Ease tokens toward their targets (walk the board).
  for (const t of tokens.values()) {
    if (t.drawPos !== t.targetPos) {
      // walk forward one space at a time
      let diff = t.targetPos - t.drawPos;
      if (diff < 0) diff += 40;
      const step = dt * 9; // spaces per second
      t.drawPos = (t.drawPos + Math.min(step, diff)) % 40;
      if (Math.abs(((t.targetPos - t.drawPos) + 40) % 40) < 0.02) t.drawPos = t.targetPos;
    }
  }
  if (diceAnim > 0) diceAnim = Math.max(0, diceAnim - dt);
  floats = floats.filter((f) => (f.life -= dt) > 0);
  for (const f of floats) f.y -= dt * 30;
  confetti = confetti.filter((c) => (c.life -= dt) > 0);
  for (const c of confetti) { c.x += c.vx * dt; c.y += c.vy * dt; c.vy += 400 * dt; }

  draw();
  rafId = requestAnimationFrame(loop);
}

function draw(): void {
  const S = boardBox.size;
  ctx.clearRect(0, 0, S, S);
  if (!game) { drawWaiting(); return; }

  // Board backing
  roundRect(2, 2, S - 4, S - 4, 14);
  ctx.fillStyle = '#0e2f24';
  ctx.fill();
  ctx.strokeStyle = '#08160f';
  ctx.lineWidth = 3;
  ctx.stroke();

  for (const cell of cells) drawCell(cell);
  drawCenter();
  drawTokens();
  drawFloats();
  drawConfetti();
}

function drawWaiting(): void {
  ctx.fillStyle = '#8b93b8';
  ctx.font = '20px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('Connecting to City Tycoon…', boardBox.size / 2, boardBox.size / 2);
}

function drawCell(cell: Cell): void {
  const g = game!;
  const sp = g.board[cell.pos];
  const { x, y, w, h } = cell;
  // base
  ctx.fillStyle = '#f4f0e4';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#2b2b2b';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);

  // colour band for properties (inner edge)
  if (sp.kind === 'property' && sp.color) {
    const band = Math.min(w, h) * 0.26;
    ctx.fillStyle = sp.color;
    if (cell.side === 'bottom') ctx.fillRect(x, y, w, band);
    else if (cell.side === 'top') ctx.fillRect(x, y + h - band, w, band);
    else if (cell.side === 'left') ctx.fillRect(x + w - band, y, band, h);
    else if (cell.side === 'right') ctx.fillRect(x, y, band, h);
    ctx.strokeStyle = '#2b2b2b';
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  }

  // owner tint
  const owner = ownerOf(cell.pos);
  if (owner) {
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = owner.color;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    ctx.strokeStyle = owner.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    if (owner.mortgaged.includes(cell.pos)) {
      ctx.strokeStyle = '#c0392b';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); ctx.stroke();
    }
  }

  // highlight buildable in build mode
  if (buildMode && game!.turnPid === selfPid && canBuild(cell.pos)) {
    ctx.strokeStyle = '#8bff9a';
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
  }

  // icon / label
  drawCellLabel(cell, sp);

  // houses / hotel
  if (owner && sp.kind === 'property') {
    const n = owner.buildings[cell.pos] ?? 0;
    if (n > 0) drawBuildings(cell, n);
  }

  // highlight current player's landing space
  const cur = g.players.find((p) => p.pid === g.turnPid);
  if (cur && Math.round((tokens.get(cur.pid)?.drawPos ?? cur.position)) === cell.pos) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,215,80,.9)';
    ctx.lineWidth = 3;
    ctx.shadowColor = '#ffd750';
    ctx.shadowBlur = 12;
    ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
    ctx.restore();
  }
}

function drawCellLabel(cell: Cell, sp: Space): void {
  const { x, y, w, h } = cell;
  const cx = x + w / 2, cy = y + h / 2;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const icon = spaceIcon(sp);
  const isCorner = cell.side === 'corner';
  const fs = Math.max(9, Math.min(w, h) * (isCorner ? 0.2 : 0.19));

  // rotate labels on the side columns so text reads along the edge
  ctx.translate(cx, cy);
  if (cell.side === 'left') ctx.rotate(Math.PI / 2);
  else if (cell.side === 'right') ctx.rotate(-Math.PI / 2);

  ctx.fillStyle = '#1a1a1a';
  if (icon) {
    ctx.font = `${Math.max(12, Math.min(w, h) * (isCorner ? 0.34 : 0.32))}px system-ui`;
    ctx.fillText(icon, 0, isCorner ? -h * 0.14 : -Math.min(w, h) * 0.02);
  }
  ctx.font = `600 ${fs}px system-ui`;
  const name = sp.name;
  const maxW = (cell.side === 'left' || cell.side === 'right') ? h - 6 : w - 4;
  wrapText(name, isCorner ? 0 : (icon ? Math.min(w, h) * 0.22 : 0), maxW, fs, isCorner);

  // price
  if (sp.price) {
    ctx.font = `700 ${fs * 0.95}px system-ui`;
    ctx.fillStyle = '#2e7d32';
    const py = (cell.side === 'left' || cell.side === 'right') ? (w / 2 - fs) : (h / 2 - fs * 0.9);
    ctx.fillText('$' + sp.price, 0, py);
  }
  ctx.restore();
}

function wrapText(text: string, yStart: number, maxW: number, fs: number, corner: boolean): void {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? cur + ' ' + word : word;
    if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = word; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  const lh = fs * 1.05;
  let yy = corner ? yStart - ((lines.length - 1) * lh) / 2 + fs * 0.2 : yStart;
  for (const ln of lines) { ctx.fillText(ln, 0, yy); yy += lh; }
}

function drawBuildings(cell: Cell, n: number): void {
  const { x, y, w, h } = cell;
  const band = Math.min(w, h) * 0.26;
  ctx.save();
  const isHotel = n >= 5;
  const count = isHotel ? 1 : n;
  const along = (cell.side === 'bottom' || cell.side === 'top') ? w : h;
  const sz = Math.min(band * 0.7, along / 5.5);
  const gap = sz * 0.35;
  const totalW = count * sz + (count - 1) * gap;
  for (let i = 0; i < count; i++) {
    let hx = 0, hy = 0;
    if (cell.side === 'bottom') { hx = x + w / 2 - totalW / 2 + i * (sz + gap); hy = y + band + 2; }
    else if (cell.side === 'top') { hx = x + w / 2 - totalW / 2 + i * (sz + gap); hy = y + h - band - sz - 2; }
    else if (cell.side === 'left') { hx = x + w - band - sz - 2; hy = y + h / 2 - totalW / 2 + i * (sz + gap); }
    else { hx = x + band + 2; hy = y + h / 2 - totalW / 2 + i * (sz + gap); }
    ctx.fillStyle = isHotel ? '#d81b1b' : '#1c7c2e';
    roundRect(hx, hy, sz, sz, 2); ctx.fill();
    ctx.strokeStyle = '#0a3315'; ctx.lineWidth = 1; ctx.stroke();
    // little roof
    ctx.fillStyle = isHotel ? '#8c1010' : '#0f5c1e';
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + sz / 2, hy - sz * 0.35); ctx.lineTo(hx + sz, hy); ctx.closePath(); ctx.fill();
  }
  if (isHotel) {
    ctx.fillStyle = '#fff'; ctx.font = `bold ${sz * 0.7}px system-ui`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    // 'H' marker handled by red colour; keep it clean
  }
  ctx.restore();
}

function drawCenter(): void {
  const g = game!;
  const S = boardBox.size, C = boardBox.corner;
  const inX = C, inY = C, inW = S - 2 * C, inH = S - 2 * C;
  const cx = inX + inW / 2, cy = inY + inH / 2;

  // Title, rotated diagonally like a classic board
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 4);
  ctx.textAlign = 'center';
  ctx.font = `bold ${inW * 0.11}px system-ui`;
  ctx.fillStyle = 'rgba(139,123,255,.16)';
  ctx.fillText('CITY TYCOON', 0, 0);
  ctx.restore();

  // Card / info panel
  const panelW = inW * 0.62, panelH = inH * 0.24;
  const px = cx - panelW / 2, py = cy - inH * 0.32;
  if (g.lastCard) {
    roundRect(px, py, panelW, panelH, 10);
    ctx.fillStyle = g.lastCard.deck === 'bulletin' ? '#2a3f6b' : '#4b2a6b';
    ctx.fill();
    ctx.strokeStyle = '#ffd750'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#ffd750'; ctx.textAlign = 'center';
    ctx.font = `bold ${panelH * 0.2}px system-ui`;
    ctx.fillText(g.lastCard.deck === 'bulletin' ? '📰 NETIZEN CHATTER' : '📈 HOUSE MEMO', cx, py + panelH * 0.24);
    ctx.fillStyle = '#fff'; ctx.font = `${panelH * 0.17}px system-ui`;
    ctx.textBaseline = 'top';
    const words = g.lastCard.text.split(' '); let line = ''; let ly = py + panelH * 0.4;
    for (const wd of words) { const t = line ? line + ' ' + wd : wd; if (ctx.measureText(t).width > panelW - 20 && line) { ctx.fillText(line, cx, ly); line = wd; ly += panelH * 0.2; } else line = t; }
    if (line) ctx.fillText(line, cx, ly);
    ctx.textBaseline = 'alphabetic';
  }

  // Dice
  const dsz = inW * 0.13;
  const gap = dsz * 0.35;
  const dy = cy + inH * 0.06;
  const spinning = diceAnim > 0;
  const d = spinning ? [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)] as [number, number] : g.dice;
  drawDie(cx - dsz - gap / 2, dy, dsz, d[0], spinning);
  drawDie(cx + gap / 2, dy, dsz, d[1], spinning);

  // Phase / turn status
  ctx.textAlign = 'center';
  ctx.fillStyle = '#e8eefc';
  ctx.font = `bold ${inW * 0.045}px system-ui`;
  ctx.fillText(statusLine(), cx, cy + inH * 0.34);

  if (g.phase === 'gameover' && g.winnerPid) {
    const w = g.players.find((p) => p.pid === g.winnerPid);
    ctx.fillStyle = '#ffd750';
    ctx.font = `bold ${inW * 0.08}px system-ui`;
    ctx.fillText('👑 ' + (w?.name ?? 'Winner') + ' wins!', cx, cy + inH * 0.42);
  }
}

function drawDie(x: number, y: number, sz: number, val: number, spin: boolean): void {
  ctx.save();
  if (spin) { ctx.translate(x + sz / 2, y + sz / 2); ctx.rotate((Math.random() - 0.5) * 0.5); ctx.translate(-sz / 2, -sz / 2); }
  else ctx.translate(x, y);
  roundRect(0, 0, sz, sz, sz * 0.18);
  const grad = ctx.createLinearGradient(0, 0, sz, sz);
  grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, '#dfe3ee');
  ctx.fillStyle = grad; ctx.fill();
  ctx.strokeStyle = '#9aa0b5'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = '#1a1a2a';
  const p = sz * 0.24, m = sz * 0.5, e = sz * 0.76;
  const pip = (px: number, py: number) => { ctx.beginPath(); ctx.arc(px, py, sz * 0.09, 0, Math.PI * 2); ctx.fill(); };
  const dots: Record<number, [number, number][]> = {
    1: [[m, m]], 2: [[p, p], [e, e]], 3: [[p, p], [m, m], [e, e]],
    4: [[p, p], [e, p], [p, e], [e, e]], 5: [[p, p], [e, p], [m, m], [p, e], [e, e]],
    6: [[p, p], [e, p], [p, m], [e, m], [p, e], [e, e]],
  };
  for (const [px, py] of dots[val] ?? dots[1]) pip(px, py);
  ctx.restore();
}

function drawTokens(): void {
  const g = game!;
  // group tokens by rounded space so they fan out
  const perCell = new Map<number, string[]>();
  for (const p of g.players) {
    if (p.bankrupt) continue;
    const t = tokens.get(p.pid);
    const pos = Math.round(t?.drawPos ?? p.position) % 40;
    (perCell.get(pos) ?? perCell.set(pos, []).get(pos)!).push(p.pid);
  }
  for (const p of g.players) {
    if (p.bankrupt) continue;
    const t = tokens.get(p.pid);
    const dp = t?.drawPos ?? p.position;
    const { x, y } = tokenXY(dp);
    // fan-out index within the cell
    const roundPos = Math.round(dp) % 40;
    const mates = perCell.get(roundPos) ?? [p.pid];
    const idx = mates.indexOf(p.pid);
    const n = mates.length;
    const r = boardBox.corner * 0.18;
    const angle = (idx / Math.max(1, n)) * Math.PI * 2;
    const ox = n > 1 ? Math.cos(angle) * r * 1.4 : 0;
    const oy = n > 1 ? Math.sin(angle) * r * 1.4 : 0;
    const isTurn = g.turnPid === p.pid;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
    ctx.beginPath(); ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
    ctx.fillStyle = p.color; ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = isTurn ? 3 : 2;
    ctx.strokeStyle = isTurn ? '#ffd750' : '#0a0a14';
    ctx.stroke();
    ctx.fillStyle = readableText(p.color);
    ctx.font = `bold ${r * 1.1}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((p.name[0] ?? '?').toUpperCase(), x + ox, y + oy + 0.5);
    if (p.auditTurns > 0) { ctx.font = `${r}px system-ui`; ctx.fillText('🔒', x + ox, y + oy - r * 1.3); }
    ctx.restore();
  }
}

function tokenXY(pos: number): { x: number; y: number } {
  // Interpolate along the walk between integer cells for smooth motion.
  const a = Math.floor(pos) % 40, b = (a + 1) % 40, f = pos - Math.floor(pos);
  const ca = cellCenter(a), cb = cellCenter(b);
  return { x: ca.x + (cb.x - ca.x) * f, y: ca.y + (cb.y - ca.y) * f };
}
function cellCenter(pos: number): { x: number; y: number } {
  const c = cells[pos];
  // put tokens toward the inner part of the cell so labels stay readable
  let cx = c.x + c.w / 2, cy = c.y + c.h / 2;
  const off = Math.min(c.w, c.h) * 0.22;
  if (c.side === 'bottom') cy += off;
  else if (c.side === 'top') cy -= off;
  else if (c.side === 'left') cx += off;
  else if (c.side === 'right') cx -= off;
  return { x: cx, y: cy };
}

function drawFloats(): void {
  for (const f of floats) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, f.life * 1.5);
    ctx.fillStyle = f.color;
    ctx.font = 'bold 20px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(f.text, f.x, f.y);
    ctx.restore();
  }
}

function drawConfetti(): void {
  for (const c of confetti) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, c.life);
    ctx.fillStyle = c.c;
    ctx.fillRect(c.x, c.y, 6, 10);
    ctx.restore();
  }
}

function burstConfetti(): void {
  const cols = ['#ff5f6d', '#ffd54f', '#4dd0e1', '#81c784', '#ba68c8'];
  for (let i = 0; i < 120; i++) {
    confetti.push({ x: boardBox.size / 2, y: boardBox.size / 2, vx: (Math.random() - 0.5) * 400, vy: -Math.random() * 400 - 60, c: cols[i % cols.length], life: 2 + Math.random() });
  }
}

// ─── Side panel + actions ───────────────────────────────────────────────────

function renderPanel(): void {
  if (!game) return;
  const g = game;

  const iAmSpectator = !g.players.some((p) => p.pid === selfPid);
  myPropsBtn.style.display = iAmSpectator ? 'none' : '';

  const bankLine = document.getElementById('crBank')!;
  const watching = g.spectatorCount > 0 ? ` · 👀 ${g.spectatorCount} watching` : '';
  bankLine.textContent = g.phase === 'waiting' ? (watching ? watching.replace(' · ', '') : '')
    : `🏠 ${g.bankHouses}/32 · 🏨 ${g.bankHotels}/12 bank supply${g.jackpot > 0 ? ` · 🥪 Free Lunch pot: $${g.jackpot}` : ''}${watching}`;

  const list = document.getElementById('crPlayers')!;
  list.innerHTML = '';
  for (const p of g.players) {
    const row = document.createElement('div');
    const isTurn = g.turnPid === p.pid;
    row.style.cssText =
      `display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;font-size:13px;` +
      `background:${isTurn ? 'rgba(255,215,80,.14)' : 'rgba(255,255,255,.03)'};` +
      `border:1px solid ${isTurn ? '#ffd750' : '#23233c'};opacity:${p.bankrupt ? 0.4 : 1};`;
    const props = p.owned.length;
    const sets = countSets(p);
    row.innerHTML =
      `<span style="width:14px;height:14px;border-radius:50%;background:${p.color};flex:0 0 auto;border:1px solid #0008"></span>` +
      `<span style="flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.pid === selfPid ? '⭐ ' : ''}${escapeHtml(p.name)}${p.bankrupt ? ' 💀' : ''}${p.auditTurns > 0 ? ' 🔒' : ''}</span>` +
      `<span style="font-weight:700;color:#8bff9a">$${p.money}</span>` +
      `<span style="color:#9aa0c8" title="properties / monopolies">🏢${props}${sets ? ' 👑' + sets : ''}</span>` +
      (p.jailFreeCards > 0 ? `<span style="color:#ffd750" title="Get Out of the Drunk Tank Free cards">🔓×${p.jailFreeCards}</span>` : '');
    if (p.bot) {
      const kick = document.createElement('button');
      kick.textContent = '✕';
      kick.title = 'Remove bot';
      kick.style.cssText = 'flex:0 0 auto;width:22px;height:22px;border-radius:6px;border:1px solid #5c1c1c;background:#3a1414;color:#ff9a9a;cursor:pointer;font-size:12px;line-height:1;';
      kick.onclick = () => net.send({ type: 'crRemoveBot', pid: p.pid });
      row.appendChild(kick);
    }
    list.appendChild(row);
  }

  renderTrades();

  const chatList = document.getElementById('crChatList')!;
  chatList.innerHTML = g.chat.length
    ? g.chat.map((c) => `<div><span style="color:${c.color};font-weight:600">${escapeHtml(c.name)}:</span> ${escapeHtml(c.text)}</div>`).join('')
    : '<div style="color:#555;">No messages yet — say hi!</div>';
  chatList.scrollTop = chatList.scrollHeight;

  const logBox = document.getElementById('crLog')!;
  logBox.innerHTML = g.log.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
  logBox.scrollTop = logBox.scrollHeight;

  renderActions();
}

function renderTrades(): void {
  const g = game!;
  const box = document.getElementById('crTrades')!;
  box.innerHTML = '';
  if (g.phase === 'waiting' || g.phase === 'gameover' || g.trades.length === 0) return;
  for (const t of g.trades) {
    const card = document.createElement('div');
    card.style.cssText = 'background:#181834;border:1px solid #33335a;border-radius:8px;padding:8px;font-size:12px;display:flex;flex-direction:column;gap:6px;';
    const give = describeTradeSide(g, t.offerProps, t.offerCash, t.offerJailFree);
    const get = describeTradeSide(g, t.wantProps, t.wantCash, t.wantJailFree);
    card.innerHTML =
      `<div><b>${escapeHtml(nameOf(t.fromPid))}</b> → <b>${escapeHtml(nameOf(t.toPid))}</b></div>` +
      `<div style="color:#b9c0dd">Gives: ${give || '(nothing)'}</div>` +
      `<div style="color:#b9c0dd">For: ${get || '(nothing)'}</div>`;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;';
    if (t.toPid === selfPid) {
      row.appendChild(btn('acc', '#1c7c2e', () => net.send({ type: 'crRespondTrade', tradeId: t.id, accept: true }), '✅ Accept'));
      row.appendChild(btn('counter', '#7c561c', () => openTradeModal({
        targetPid: t.fromPid,
        counterOf: t.id,
        // Mirror the deal from your side as the starting point — tweak and send back.
        prefill: { offerProps: t.wantProps, offerCash: t.wantCash, offerJailFree: t.wantJailFree, wantProps: t.offerProps, wantCash: t.offerCash, wantJailFree: t.offerJailFree },
      }), '🔁 Counter'));
      row.appendChild(btn('rej', '#5c1c1c', () => net.send({ type: 'crRespondTrade', tradeId: t.id, accept: false }), '❌ Reject'));
    } else if (t.fromPid === selfPid) {
      row.appendChild(btn('cancel', '#5c1c1c', () => net.send({ type: 'crCancelTrade', tradeId: t.id }), '🚫 Cancel Offer'));
    }
    if (row.children.length) card.appendChild(row);
    box.appendChild(card);
  }
}

function describeTradeSide(g: CrGame, props: number[], cash: number, jailFree: number): string {
  const parts: string[] = [];
  if (cash > 0) parts.push(`$${cash}`);
  if (jailFree > 0) parts.push(`🔓×${jailFree}`);
  for (const pos of props) parts.push(escapeHtml(g.board[pos]?.name ?? '?'));
  return parts.join(', ');
}

function renderActions(): void {
  const g = game!;
  actionBar.innerHTML = '';
  const myTurn = g.turnPid === selfPid;
  const me = g.players.find((p) => p.pid === selfPid);

  if (!me) {
    // No seat in this room — just watching.
    actionBar.appendChild(hint(`👀 You're spectating${g.spectatorCount > 1 ? ` (${g.spectatorCount} watching)` : ''}.`));
    actionBar.appendChild(btn('🚪 Leave', '#5c1c1c', () => closeCityTycoon()));
    return;
  }

  if (g.phase === 'waiting') {
    if (me && !me.ready) actionBar.appendChild(btn('✅ Ready Up', '#1c7c2e', () => net.send({ type: 'crReady' })));
    else actionBar.appendChild(hint('Waiting for players to ready up… (2–8 players)'));
    if (g.players.length < 8) actionBar.appendChild(btn('🤖 Add Bot', '#2a2a5a', () => net.send({ type: 'crAddBot' })));
    actionBar.appendChild(btn('🚪 Leave', '#5c1c1c', () => closeCityTycoon()));
    return;
  }

  if (g.phase === 'gameover') {
    actionBar.appendChild(hint('Game over — a fresh lobby opens shortly.'));
    actionBar.appendChild(btn('🚪 Leave', '#5c1c1c', () => closeCityTycoon()));
    return;
  }

  if (g.phase === 'auction' && g.auction) {
    const a = g.auction;
    const secs = Math.max(0, Math.ceil((g.deadline - Date.now()) / 1000));
    actionBar.appendChild(hint(`🔨 ${a.name} — high bid $${a.highBid}${a.highPid ? ' by ' + nameOf(a.highPid) : ''} · ${secs}s`));
    const input = document.createElement('input');
    input.type = 'number'; input.min = String(a.highBid + 1); input.placeholder = 'Your bid'; input.value = String(a.highBid + 10);
    input.style.cssText = 'padding:8px;border-radius:8px;border:1px solid #33335a;background:#0a0a16;color:#fff;font-size:14px;';
    actionBar.appendChild(input);
    const bidRow = document.createElement('div');
    bidRow.style.cssText = 'display:flex;gap:6px;';
    bidRow.appendChild(btn('quick', '#2a2a5a', () => net.send({ type: 'crAuctionBid', amount: a.highBid + 10 }), '💰 +$10'));
    bidRow.appendChild(btn('bid', '#6c4bff', () => { const v = parseInt(input.value, 10); if (v > a.highBid) net.send({ type: 'crAuctionBid', amount: v }); }, 'Bid'));
    actionBar.appendChild(bidRow);
    appendTradeAndLeave(g);
    return;
  }

  if (!myTurn) {
    actionBar.appendChild(hint(`⏳ ${nameOf(g.turnPid)}'s turn…`));
    appendTradeAndLeave(g);
    return;
  }

  // It's my turn.
  if (g.phase === 'rolling') {
    if (me && me.auditTurns > 0) {
      actionBar.appendChild(hint(`🔒 In the Drunk Tank (${me.auditTurns} turn${me.auditTurns === 1 ? '' : 's'} left unless you roll doubles).`));
      actionBar.appendChild(btn('💵 Pay Bail ($50)', '#7c561c', () => net.send({ type: 'crPayBail' })));
      if (me.jailFreeCards > 0) actionBar.appendChild(btn('🔓 Use Jail-Free Card', '#1c7c2e', () => net.send({ type: 'crUseJailFree' })));
    }
    actionBar.appendChild(btn('🎲 Roll Dice', '#6c4bff', () => net.send({ type: 'crRoll' })));
  } else if (g.phase === 'buying' && g.pendingBuy != null) {
    const sp = g.board[g.pendingBuy];
    actionBar.appendChild(hint(`${sp.name} — $${sp.price}`));
    actionBar.appendChild(btn(`🏢 Buy ($${sp.price})`, '#1c7c2e', () => net.send({ type: 'crBuy' })));
    actionBar.appendChild(btn('🔨 Auction it', '#7c561c', () => net.send({ type: 'crPass' })));
  } else if (g.phase === 'building') {
    if (canBuildAnywhere()) {
      const bm = btn(buildMode ? '🏠 Building… (click a lot)' : '🏗️ Build Houses', buildMode ? '#2e7d32' : '#2a2a5a', () => { buildMode = !buildMode; renderActions(); });
      actionBar.appendChild(bm);
      if (buildMode) actionBar.appendChild(hint('Click a highlighted property on the board to build.'));
    } else {
      buildMode = false;
    }
    const endLabel = g.doublesStreak > 0 ? '🎲 Roll Again (doubles!)' : '➡️ End Turn';
    actionBar.appendChild(btn(endLabel, '#c0562e', () => { buildMode = false; net.send({ type: 'crEndTurn' }); }));
  }
  appendTradeAndLeave(g);
}

function appendTradeAndLeave(g: CrGame): void {
  if (g.players.filter((p) => !p.bankrupt).length > 1) {
    actionBar.appendChild(btn('🤝 Propose Trade', '#2a2a5a', () => openTradeModal()));
  }
  actionBar.appendChild(btn('🚪 Leave', '#5c1c1c', () => closeCityTycoon()));
}

function closeModal(): void { activeModal?.remove(); activeModal = null; }

function openPropertiesModal(): void {
  if (!game) return;
  closeModal();
  const g = game;
  const me = g.players.find((p) => p.pid === selfPid);
  if (!me) return;

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;z-index:960;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;';
  const card = document.createElement('div');
  card.style.cssText = 'background:#14142c;border:1px solid #33335a;border-radius:12px;padding:18px;width:380px;max-width:92vw;max-height:86vh;overflow-y:auto;display:flex;flex-direction:column;gap:4px;color:#e8eefc;font-size:13px;';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:16px;font-weight:700;margin-bottom:8px;';
  title.textContent = `🏢 My Properties (${me.owned.length})`;
  card.appendChild(title);

  if (me.owned.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:#666;padding:8px 0;';
    empty.textContent = "You don't own any properties yet.";
    card.appendChild(empty);
  } else {
    const canAct = g.turnPid === selfPid && g.phase === 'building';
    for (const pos of [...me.owned].sort((a, b) => a - b)) {
      const sp = g.board[pos];
      const level = me.buildings[pos] ?? 0;
      const built = level === 5 ? '🏨' : level > 0 ? '🏠'.repeat(level) : '';
      const isMortgaged = me.mortgaged.includes(pos);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid #23233c;';
      row.innerHTML =
        `<span style="width:12px;height:12px;border-radius:3px;background:${sp.color ?? '#666'};flex:0 0 auto;"></span>` +
        `<span style="flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(sp.name)}${isMortgaged ? ' <span style="color:#ff9a9a;font-size:11px;">(mortgaged)</span>' : ''}</span>` +
        `<span style="color:#9aa0c8;flex:0 0 auto;">${built}</span>` +
        `<span style="color:#8bff9a;flex:0 0 auto;">$${sp.price ?? 0}</span>`;
      if (isMortgaged && canAct) {
        const cost = Math.ceil(((sp.price ?? 0) / 2) * 1.1);
        const unmort = document.createElement('button');
        unmort.textContent = `Unmortgage ($${cost})`;
        unmort.style.cssText = 'flex:0 0 auto;padding:5px 8px;border-radius:6px;border:none;background:#1c7c2e;color:#fff;font-size:11px;font-weight:600;cursor:pointer;';
        unmort.onclick = () => { net.send({ type: 'crUnmortgage', position: pos }); closeModal(); };
        row.appendChild(unmort);
      }
      card.appendChild(row);
    }
  }

  card.appendChild(btn('close', '#5c1c1c', () => closeModal(), 'Close'));

  modal.appendChild(card);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.body.appendChild(modal);
  activeModal = modal;
}

function buildTradeColumnHtml(label: string, p: CrPlayerView, prefillProps?: number[], prefillCash?: number, prefillJailFree?: number): string {
  const g = game!;
  const unimproved = p.owned.filter((pos) => (p.buildings[pos] ?? 0) === 0);
  const propsHtml = unimproved.length
    ? unimproved.map((pos) => `<label style="display:flex;gap:6px;align-items:center;font-size:12px;"><input type="checkbox" value="${pos}" ${prefillProps?.includes(pos) ? 'checked' : ''}> ${escapeHtml(g.board[pos]?.name ?? '?')}</label>`).join('')
    : '<div style="color:#666;font-size:12px;">(no unimproved properties)</div>';
  return (
    `<div style="font-weight:600;">${escapeHtml(label)} (${escapeHtml(p.name)})</div>` +
    `<div style="max-height:140px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;border:1px solid #23233c;border-radius:6px;padding:6px;">${propsHtml}</div>` +
    `<label style="display:flex;gap:6px;align-items:center;">Cash <input class="cr-cash" type="number" min="0" max="${p.money}" value="${prefillCash ?? 0}" style="width:80px;padding:4px;border-radius:6px;border:1px solid #33335a;background:#0a0a16;color:#fff;"></label>` +
    (p.jailFreeCards > 0
      ? `<label style="display:flex;gap:6px;align-items:center;">🔓 cards <input class="cr-jail" type="number" min="0" max="${p.jailFreeCards}" value="${prefillJailFree ?? 0}" style="width:60px;padding:4px;border-radius:6px;border:1px solid #33335a;background:#0a0a16;color:#fff;"></label>`
      : '')
  );
}

interface CounterOpts {
  targetPid: string;
  counterOf: number;
  prefill: { offerProps: number[]; offerCash: number; offerJailFree: number; wantProps: number[]; wantCash: number; wantJailFree: number };
}

function openTradeModal(opts?: CounterOpts): void {
  if (!game) return;
  closeModal();
  const g = game;
  const me = g.players.find((p) => p.pid === selfPid);
  const others = g.players.filter((p) => p.pid !== selfPid && !p.bankrupt);
  if (!me || others.length === 0) return;

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;z-index:960;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;';
  const card = document.createElement('div');
  card.style.cssText = 'background:#14142c;border:1px solid #33335a;border-radius:12px;padding:18px;width:420px;max-width:92vw;max-height:86vh;overflow-y:auto;display:flex;flex-direction:column;gap:10px;color:#e8eefc;font-size:13px;';
  card.innerHTML = `<div style="font-size:16px;font-weight:700;">${opts ? '🔁 Counter Offer' : '🤝 Propose Trade'}</div>`;

  const select = document.createElement('select');
  select.style.cssText = 'padding:8px;border-radius:8px;border:1px solid #33335a;background:#0a0a16;color:#fff;font-size:13px;';
  for (const p of others) {
    const o = document.createElement('option');
    o.value = p.pid; o.textContent = p.name;
    if (opts && p.pid === opts.targetPid) o.selected = true;
    select.appendChild(o);
  }
  card.appendChild(select);

  const body = document.createElement('div');
  body.style.cssText = 'display:flex;gap:10px;';
  const giveCol = document.createElement('div');
  giveCol.style.cssText = 'flex:1 1 0;display:flex;flex-direction:column;gap:6px;min-width:0;';
  const getCol = document.createElement('div');
  getCol.style.cssText = 'flex:1 1 0;display:flex;flex-direction:column;gap:6px;min-width:0;';
  body.append(giveCol, getCol);
  card.appendChild(body);

  const rebuild = () => {
    const target = g.players.find((p) => p.pid === select.value) ?? others[0];
    // Only pre-fill when the selected target still matches who this is a counter to.
    const p = opts && target.pid === opts.targetPid ? opts.prefill : undefined;
    giveCol.innerHTML = buildTradeColumnHtml('You give', me, p?.offerProps, p?.offerCash, p?.offerJailFree);
    getCol.innerHTML = buildTradeColumnHtml('You get', target, p?.wantProps, p?.wantCash, p?.wantJailFree);
  };
  select.onchange = rebuild;
  rebuild();

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:6px;';
  btnRow.appendChild(btn('send', '#1c7c2e', () => {
    const target = g.players.find((p) => p.pid === select.value) ?? others[0];
    const offerProps = [...giveCol.querySelectorAll('input[type=checkbox]:checked')].map((el) => Number((el as HTMLInputElement).value));
    const wantProps = [...getCol.querySelectorAll('input[type=checkbox]:checked')].map((el) => Number((el as HTMLInputElement).value));
    const offerCash = Number((giveCol.querySelector('.cr-cash') as HTMLInputElement | null)?.value || 0);
    const wantCash = Number((getCol.querySelector('.cr-cash') as HTMLInputElement | null)?.value || 0);
    const offerJailFree = Number((giveCol.querySelector('.cr-jail') as HTMLInputElement | null)?.value || 0);
    const wantJailFree = Number((getCol.querySelector('.cr-jail') as HTMLInputElement | null)?.value || 0);
    const offer = { offerProps, offerCash, offerJailFree, wantProps, wantCash, wantJailFree };
    if (opts) net.send({ type: 'crCounterTrade', tradeId: opts.counterOf, offer });
    else net.send({ type: 'crProposeTrade', toPid: target.pid, offer });
    closeModal();
  }, opts ? 'Send Counter' : 'Send Offer'));
  btnRow.appendChild(btn('cancel', '#5c1c1c', () => closeModal(), 'Cancel'));
  card.appendChild(btnRow);

  modal.appendChild(card);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.body.appendChild(modal);
  activeModal = modal;
}

function btn(id: string, bg: string, on: () => void, label?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label ?? id;
  b.style.cssText = `background:${bg};color:#fff;border:none;border-radius:10px;padding:11px 14px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.35);transition:filter .12s;`;
  b.onmouseenter = () => (b.style.filter = 'brightness(1.15)');
  b.onmouseleave = () => (b.style.filter = 'none');
  b.onclick = on;
  return b;
}
function hint(text: string): HTMLDivElement {
  const d = document.createElement('div');
  d.textContent = text;
  d.style.cssText = 'font-size:13px;color:#aab0d8;background:rgba(255,255,255,.04);padding:8px 10px;border-radius:8px;text-align:center;';
  return d;
}

function onCanvasClick(e: MouseEvent): void {
  if (!game) return;
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * (boardBox.size / rect.width);
  const my = (e.clientY - rect.top) * (boardBox.size / rect.height);
  for (const c of cells) {
    if (mx >= c.x && mx <= c.x + c.w && my >= c.y && my <= c.y + c.h) {
      if (buildMode && game.turnPid === selfPid && game.phase === 'building' && canBuild(c.pos)) {
        net.send({ type: 'crBuild', position: c.pos });
        return;
      }
      // Not building — treat the tap as pinning/unpinning that space's info tooltip. Touch
      // devices have no hover, so this is their only way to see rent/ownership details.
      if (tooltipPos === c.pos) hideTooltip(); else showTooltip(c.pos, e.clientX, e.clientY);
      return;
    }
  }
  hideTooltip();
}

function onCanvasHover(e: MouseEvent): void {
  if (!game) { hideTooltip(); return; }
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * (boardBox.size / rect.width);
  const my = (e.clientY - rect.top) * (boardBox.size / rect.height);
  for (const c of cells) {
    if (mx >= c.x && mx <= c.x + c.w && my >= c.y && my <= c.y + c.h) {
      showTooltip(c.pos, e.clientX, e.clientY);
      return;
    }
  }
  hideTooltip();
}

function showTooltip(pos: number, clientX: number, clientY: number): void {
  const g = game;
  const sp = g?.board[pos];
  if (!g || !sp) return;
  tooltipPos = pos;
  tooltipEl.innerHTML = tooltipHtml(pos, sp);
  tooltipEl.style.display = 'block';
  // Keep it roughly on-screen — flip to the other side of the cursor near the right/bottom edge.
  const vw = window.innerWidth, vh = window.innerHeight;
  const guessW = 220, guessH = 140;
  const left = clientX + guessW + 16 > vw ? clientX - guessW - 14 : clientX + 14;
  const top = clientY + guessH + 16 > vh ? clientY - guessH - 14 : clientY + 14;
  tooltipEl.style.left = Math.max(4, left) + 'px';
  tooltipEl.style.top = Math.max(4, top) + 'px';
}

function hideTooltip(): void {
  tooltipPos = -1;
  tooltipEl.style.display = 'none';
}

function tooltipHtml(pos: number, sp: Space): string {
  const owner = ownerOf(pos);
  let html = `<div style="font-weight:700;margin-bottom:4px;">${escapeHtml(sp.name)}</div>`;
  if (sp.price) html += `<div>Price: $${sp.price}</div>`;
  if (sp.kind === 'property' && sp.rent) {
    const r = sp.rent;
    html += `<div style="margin-top:4px;font-size:11px;">Rent: $${r[0]}<br>With monopoly: $${r[1]}<br>` +
      `1🏠 $${r[2]} · 2🏠 $${r[3]} · 3🏠 $${r[4]} · 4🏠 $${r[5]}<br>Hotel: $${r[6]}</div>`;
  } else if (sp.kind === 'transit') {
    html += `<div style="margin-top:4px;font-size:11px;">Rent: $25 / $50 / $100 / $200 by circuits owned</div>`;
  } else if (sp.kind === 'utility') {
    html += `<div style="margin-top:4px;font-size:11px;">Rent: 4× dice roll (10× if both utilities owned)</div>`;
  } else if (sp.kind === 'tax') {
    html += `<div style="margin-top:4px;font-size:11px;">Tax: $${sp.taxAmount}</div>`;
  }
  if (owner) {
    html += `<div style="margin-top:6px;padding-top:4px;border-top:1px solid #33335a;">Owner: <span style="color:${owner.color};font-weight:600;">${escapeHtml(owner.name)}</span>${owner.mortgaged.includes(pos) ? ' <span style="color:#ff9a9a;">(mortgaged)</span>' : ''}</div>`;
    if (sp.kind === 'property') {
      const lvl = owner.buildings[pos] ?? 0;
      if (lvl > 0) html += `<div>${lvl === 5 ? 'Hotel 🏨' : `${lvl} house${lvl === 1 ? '' : 's'} 🏠`}</div>`;
    }
  }
  return html;
}

// ─── helpers ───────────────────────────────────────────────────────────────────

function ownerOf(pos: number): CrPlayerView | null {
  if (!game) return null;
  for (const p of game.players) if (!p.bankrupt && p.owned.includes(pos)) return p;
  return null;
}
function canBuild(pos: number): boolean {
  if (!game) return false;
  const me = game.players.find((p) => p.pid === selfPid);
  const sp = game.board[pos];
  if (!me || sp.kind !== 'property' || !me.owned.includes(pos) || !sp.group) return false;
  if (me.mortgaged.includes(pos)) return false;
  const group = game.board.map((s, i) => (s.group === sp.group ? i : -1)).filter((i) => i >= 0);
  if (!group.every((q) => me.owned.includes(q))) return false;
  const cur = me.buildings[pos] ?? 0;
  if (cur >= 5) return false;
  const groupMin = Math.min(...group.map((q) => me.buildings[q] ?? 0));
  if (cur > groupMin) return false;
  if (me.money < (sp.houseCost ?? 0)) return false;
  return (cur + 1 < 5) ? game.bankHouses > 0 : game.bankHotels > 0;
}
function canBuildAnywhere(): boolean {
  if (!game) return false;
  const me = game.players.find((p) => p.pid === selfPid);
  return !!me && me.owned.some((pos) => canBuild(pos));
}
function countSets(p: CrPlayerView): number {
  if (!game) return 0;
  let n = 0;
  for (const grp of GROUP_ORDER) {
    const group = game.board.map((s, i) => (s.group === grp ? i : -1)).filter((i) => i >= 0);
    if (group.length && group.every((q) => p.owned.includes(q))) n++;
  }
  return n;
}
function nameOf(pid: string | null): string {
  if (!game || !pid) return '?';
  return game.players.find((p) => p.pid === pid)?.name ?? '?';
}
function statusLine(): string {
  const g = game!;
  switch (g.phase) {
    case 'waiting': return `Waiting… ${g.players.length} player${g.players.length === 1 ? '' : 's'}`;
    case 'rolling': return `${nameOf(g.turnPid)} to roll 🎲`;
    case 'buying': return `${nameOf(g.turnPid)} — buy or auction?`;
    case 'auction': return `🔨 Auction: ${g.auction?.name ?? ''}`;
    case 'building': return `${nameOf(g.turnPid)} — build or end turn`;
    case 'gameover': return 'Game over';
    default: return '';
  }
}
function spaceIcon(sp: Space): string {
  switch (sp.kind) {
    case 'go': return '💰';
    case 'visit_audit': return '🔍';
    case 'free_lunch': return '🥪';
    case 'bust_zone': return '🚨';
    case 'tax': return '🧾';
    case 'transit': return '🚆';
    case 'utility': return sp.name.includes('Aqua') ? '💧' : '⚡';
    case 'card_bulletin': return '📰';
    case 'card_dispatch': return '📈';
    default: return '';
  }
}
function readableText(bg: string): string {
  const c = bg.replace('#', '');
  if (c.length < 6) return '#000';
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? '#111' : '#fff';
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]!));
}
function roundRect(x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
