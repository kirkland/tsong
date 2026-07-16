// 🪵 Nine Men's Morris — 2-player PvP mill game, played at the Tavern and the Country Club.
// Same `bg` relay shape as Club Chess (game key 'morris'): the server seats the table, escrows
// the optional winner-takes-all stake, and fans moves across; both clients run the rules below.
// Slot 0 hosts and plays first (gold). Rematches swap who goes first.

import type { BgNet } from './chess';

interface LobbyView { status: 'waiting' | 'playing' | 'ended'; slot: number; players: { name: string; slot: number }[]; stake: number; board?: { name: string; wins: number; losses: number }[] }

// The 24 points, as (x,y) on a 6×6 grid (0..6), classic three-square layout.
const PTS: [number, number][] = [
  [0, 0], [3, 0], [6, 0],       // 0  1  2   outer top
  [1, 1], [3, 1], [5, 1],       // 3  4  5   middle top
  [2, 2], [3, 2], [4, 2],       // 6  7  8   inner top
  [0, 3], [1, 3], [2, 3],       // 9 10 11   left column
  [4, 3], [5, 3], [6, 3],       // 12 13 14  right column
  [2, 4], [3, 4], [4, 4],       // 15 16 17  inner bottom
  [1, 5], [3, 5], [5, 5],       // 18 19 20  middle bottom
  [0, 6], [3, 6], [6, 6],       // 21 22 23  outer bottom
];
const MILLS: [number, number, number][] = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], [9, 10, 11], [12, 13, 14], [15, 16, 17], [18, 19, 20], [21, 22, 23],
  [0, 9, 21], [3, 10, 18], [6, 11, 15], [1, 4, 7], [16, 19, 22], [8, 12, 17], [5, 13, 20], [2, 14, 23],
];
const ADJ: number[][] = (() => {
  const a: number[][] = Array.from({ length: 24 }, () => []);
  for (const [x, y, z] of MILLS.slice(0, 8)) { a[x].push(y); a[y].push(x, z); a[z].push(y); }
  for (const [x, y, z] of MILLS.slice(8)) { a[x].push(y); a[y].push(x, z); a[z].push(y); }
  return a;
})();

type Cell = 0 | 1 | 2; // 0 empty, 1 gold (slot A), 2 walnut (slot B)
interface MState {
  b: Cell[];
  turn: 1 | 2;
  inHand: [number, number];   // stones left to place (index 0 → player 1, 1 → player 2)
  onBoard: [number, number];
  removing: boolean;          // current player just formed a mill and must take a stone
  placedAll: [boolean, boolean];
}

let open = false;
let net: BgNet | null = null;
let root: HTMLDivElement | null = null;
let lobby: LobbyView = { status: 'waiting', slot: 0, players: [], stake: 0 };
let st: MState | null = null;
let mySlot = 0;
let gameN = 0;
let sel = -1;
let over: { text: string; sub: string } | null = null;
let rematchMine = false, rematchTheirs = false;
let flash = '';

function fresh(): MState {
  return { b: new Array(24).fill(0) as Cell[], turn: 1, inHand: [9, 9], onBoard: [0, 0], removing: false, placedAll: [false, false] };
}
// Which player number (1|2) this slot plays as — first-move honours swap each rematch.
function pnOf(slot: number): 1 | 2 { return ((slot === 0) === (gameN % 2 === 0)) ? 1 : 2; }
function myPn(): 1 | 2 { return pnOf(mySlot); }

function millsAt(b: Cell[], p: number, who: Cell): number {
  let n = 0;
  for (const m of MILLS) if (m.includes(p) && m.every((q) => b[q] === who)) n++;
  return n;
}
function allInMills(b: Cell[], who: Cell): boolean {
  for (let i = 0; i < 24; i++) if (b[i] === who && millsAt(b, i, who) === 0) return false;
  return true;
}
function flying(s: MState, pn: 1 | 2): boolean { return s.placedAll[pn - 1] && s.onBoard[pn - 1] === 3; }
function canMove(s: MState, pn: 1 | 2): boolean {
  if (s.inHand[pn - 1] > 0) return s.b.some((c) => c === 0);
  if (flying(s, pn)) return s.b.some((c) => c === 0);
  for (let i = 0; i < 24; i++) if (s.b[i] === pn && ADJ[i].some((j) => s.b[j] === 0)) return true;
  return false;
}

// --- audio (tiny, tavern-flavoured) ---
let ac: AudioContext | null = null;
function tone(freq: number, dur: number, type: OscillatorType, vol: number) {
  if (net?.muted()) return;
  try {
    ac = ac || new AudioContext();
    const t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + dur + 0.02);
  } catch { /* ignore */ }
}
const sndPlace = () => tone(240, 0.07, 'square', 0.05);
const sndMill = () => { tone(392, 0.12, 'triangle', 0.06); setTimeout(() => tone(523, 0.16, 'triangle', 0.06), 90); };
const sndTake = () => tone(150, 0.14, 'sawtooth', 0.05);
const sndEnd = () => { tone(392, 0.4, 'sine', 0.06); setTimeout(() => tone(494, 0.4, 'sine', 0.05), 130); setTimeout(() => tone(587, 0.6, 'sine', 0.05), 260); };

// --- lifecycle ---
export function isMorrisOpen() { return open; }
export function openMorris(n: BgNet) {
  if (open) return;
  open = true;
  net = n;
  lobby = { status: 'waiting', slot: 0, players: [], stake: 0 };
  st = null; over = null; gameN = 0;
  root = document.createElement('div');
  root.id = 'morrisOverlay';
  root.style.cssText =
    'position:fixed;inset:0;z-index:20000;display:flex;align-items:center;justify-content:center;' +
    'background:radial-gradient(ellipse at 50% 30%, #2a1c10 0%, #140d06 70%);' +
    'font-family:Georgia,"Times New Roman",serif;color:#e8dcc0;';
  document.body.appendChild(root);
  net.join();
  renderLobby();
}
function shut() {
  open = false;
  root?.remove(); root = null;
  const n = net; net = null;
  n?.leave();
}
function nameOf(slot: number): string {
  return lobby.players.find((p) => p.slot === slot)?.name ?? (slot === mySlot ? (net?.name() || 'You') : '…');
}
function startGame() {
  st = fresh();
  sel = -1; over = null; flash = '';
  rematchMine = rematchTheirs = false;
  renderGame();
}

export function feedLobby(msg: LobbyView) {
  if (!open) return;
  const was = lobby.status;
  lobby = msg;
  mySlot = msg.slot;
  if (msg.status === 'ended') {
    if (st && !over) { over = { text: 'The table empties.', sub: 'Your opponent has wandered off.' }; sndEnd(); renderGame(); }
    else shut();
    return;
  }
  if (msg.status === 'playing' && was !== 'playing') {
    if (st) gameN++; else gameN = 0;
    startGame();
    return;
  }
  if (!st) renderLobby(); else renderGame();
}

export function feedRelay(data: unknown) {
  if (!open || !st || over) return;
  const d = data as { k?: string; p?: number; f?: number; t?: number };
  if (!d || typeof d !== 'object') return;
  const theirs = pnOf(1 - mySlot);
  if (d.k === 'place' && typeof d.p === 'number') { if (st.turn === theirs && !st.removing) doPlace(d.p, false); return; }
  if (d.k === 'move' && typeof d.f === 'number' && typeof d.t === 'number') { if (st.turn === theirs && !st.removing) doMove(d.f, d.t, false); return; }
  if (d.k === 'take' && typeof d.p === 'number') { if (st.turn === theirs && st.removing) doTake(d.p, false); return; }
  if (d.k === 'resign') { finish(`${nameOf(1 - mySlot)} concedes.`, 'The board is yours.', mySlot); return; }
  if (d.k === 're?') {
    rematchTheirs = true;
    if (rematchMine && mySlot === 0) net?.start();
    renderGame();
    return;
  }
}

function finish(text: string, sub: string, winnerSlot?: number) {
  over = { text, sub };
  if (winnerSlot !== undefined) net?.result(winnerSlot);
  sndEnd();
  renderGame();
}

function afterAction(mine: boolean) {
  if (!st) return;
  // loss checks run for the player NOW to move
  const pn = st.turn;
  const lost = (st.placedAll[pn - 1] && st.onBoard[pn - 1] < 3) || !canMove(st, pn);
  if (lost) {
    const winPn = pn === 1 ? 2 : 1;
    const winSlot = pnOf(0) === winPn ? 0 : 1;
    const iWon = winSlot === mySlot;
    finish(`${nameOf(winSlot)} wins.`, iWon ? 'Your mills ground exceedingly fine.' : 'Ground down, mill by mill.', winSlot);
    return;
  }
  sel = -1;
  renderGame();
  void mine;
}

function doPlace(p: number, mine: boolean) {
  if (!st || st.b[p] !== 0) return;
  const pn = st.turn;
  if (st.inHand[pn - 1] <= 0) return;
  st.b[p] = pn;
  st.inHand[pn - 1]--; st.onBoard[pn - 1]++;
  if (st.inHand[pn - 1] === 0) st.placedAll[pn - 1] = true;
  if (mine) net?.relay({ k: 'place', p });
  if (millsAt(st.b, p, pn) > 0) {
    st.removing = true; sndMill();
    flash = pn === myPn() ? 'A mill! Take one of their stones.' : `${nameOf(1 - mySlot)} formed a mill…`;
    renderGame();
    return;
  }
  sndPlace();
  st.turn = pn === 1 ? 2 : 1;
  flash = '';
  afterAction(mine);
}

function doMove(f: number, t: number, mine: boolean) {
  if (!st) return;
  const pn = st.turn;
  if (st.inHand[pn - 1] > 0) return;
  if (st.b[f] !== pn || st.b[t] !== 0) return;
  if (!flying(st, pn) && !ADJ[f].includes(t)) return;
  st.b[f] = 0; st.b[t] = pn;
  if (mine) net?.relay({ k: 'move', f, t });
  if (millsAt(st.b, t, pn) > 0) {
    st.removing = true; sndMill();
    flash = pn === myPn() ? 'A mill! Take one of their stones.' : `${nameOf(1 - mySlot)} formed a mill…`;
    renderGame();
    return;
  }
  sndPlace();
  st.turn = pn === 1 ? 2 : 1;
  flash = '';
  afterAction(mine);
}

function doTake(p: number, mine: boolean) {
  if (!st || !st.removing) return;
  const pn = st.turn, foe = (pn === 1 ? 2 : 1) as Cell;
  if (st.b[p] !== foe) return;
  if (millsAt(st.b, p, foe) > 0 && !allInMills(st.b, foe)) return; // milled stones are safe unless all are
  st.b[p] = 0;
  st.onBoard[foe - 1]--;
  st.removing = false;
  if (mine) net?.relay({ k: 'take', p });
  sndTake();
  st.turn = foe as 1 | 2;
  flash = '';
  afterAction(mine);
}

// --- UI ---
const BTN = 'cursor:pointer;background:#3a2814;color:#e8dcc0;border:1px solid #6a4a2a;border-radius:8px;' +
  'padding:9px 16px;font-size:14px;font-family:inherit;';
const BTN_DIM = BTN + 'opacity:0.45;cursor:default;';

function renderLobby() {
  if (!root) return;
  root.replaceChildren();
  const panel = document.createElement('div');
  panel.style.cssText = 'text-align:center;background:#1c120833;border:1px solid #4a3218;border-radius:16px;padding:36px 48px;box-shadow:0 20px 60px #000a;';
  panel.innerHTML =
    '<div style="font-size:30px;letter-spacing:4px;color:#e8c86a;margin-bottom:4px;">⊞ NINE MEN\'S MORRIS</div>' +
    '<div style="font-style:italic;color:#b8a888;font-size:13px;margin-bottom:24px;">Three in a row makes a mill. A mill takes a stone. Old as boards, older than rules.</div>';
  const seats = document.createElement('div');
  seats.style.cssText = 'display:flex;gap:18px;justify-content:center;margin-bottom:22px;';
  for (const slot of [0, 1]) {
    const p = lobby.players.find((x) => x.slot === slot);
    const seat = document.createElement('div');
    seat.style.cssText = `width:170px;padding:16px 10px;border-radius:12px;border:1px solid ${p ? '#6a4a2a' : '#3a2814'};background:${p ? '#2a1c10' : '#180f08'};`;
    seat.innerHTML = p
      ? `<div style="font-size:24px">${slot === 0 ? '🟡' : '🟤'}</div><div style="margin-top:6px;font-size:15px">${p.name}</div>`
      : '<div style="font-size:24px;color:#4a3218">·</div><div style="margin-top:6px;font-size:13px;color:#7a6248">an empty stool</div>';
    seats.appendChild(seat);
  }
  panel.appendChild(seats);
  const wager = document.createElement('div');
  wager.style.cssText = 'margin-bottom:18px;';
  const wLabel = document.createElement('div');
  wLabel.textContent = lobby.stake > 0 ? `Stake: ${lobby.stake.toLocaleString()}\u{1FA99} each — winner takes all` : 'A friendly game (no stake)';
  wLabel.style.cssText = `font-size:13px;color:${lobby.stake > 0 ? '#e8c86a' : '#b8a888'};margin-bottom:8px;`;
  wager.appendChild(wLabel);
  if (mySlot === 0) {
    const row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;gap:6px;justify-content:center;flex-wrap:wrap;';
    for (const [label, amt] of [['Friendly', 0], ['100', 100], ['1k', 1000], ['10k', 10000], ['100k', 100000]] as [string, number][]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = BTN + `padding:5px 10px;font-size:12px;${lobby.stake === amt ? 'border-color:#c8a84a;color:#e8c86a;' : ''}`;
      b.onclick = () => net?.stake(amt);
      row2.appendChild(b);
    }
    const custom = document.createElement('button');
    custom.textContent = 'Custom…';
    custom.style.cssText = BTN + 'padding:5px 10px;font-size:12px;';
    custom.onclick = () => {
      const v = parseInt(prompt('Stake per player (coins):', String(lobby.stake || 100)) || '', 10);
      if (Number.isFinite(v) && v >= 0) net?.stake(v);
    };
    row2.appendChild(custom);
    wager.appendChild(row2);
  } else if (lobby.stake > 0) {
    const note = document.createElement('div');
    note.textContent = 'Staying on this stool when the game begins is agreeing to the stake.';
    note.style.cssText = 'font-size:11px;font-style:italic;color:#b8a888;';
    wager.appendChild(note);
  }
  panel.appendChild(wager);
  const status = document.createElement('div');
  status.textContent = lobby.players.length < 2 ? 'Waiting for a challenger…' : (mySlot === 0 ? 'Table\'s full. Rack \'em.' : 'Table\'s full. The host racks the stones.');
  status.style.cssText = 'font-size:13px;color:#d0c0a8;margin-bottom:20px;';
  panel.appendChild(status);
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:12px;justify-content:center;';
  if (mySlot === 0) {
    const start = document.createElement('button');
    start.textContent = 'Start';
    start.style.cssText = lobby.players.length >= 2 ? BTN : BTN_DIM;
    start.disabled = lobby.players.length < 2;
    start.onclick = () => net?.start();
    row.appendChild(start);
  }
  const leave = document.createElement('button');
  leave.textContent = 'Leave';
  leave.style.cssText = BTN;
  leave.onclick = () => shut();
  row.appendChild(leave);
  panel.appendChild(row);
  if (lobby.board && lobby.board.length) {
    const board = document.createElement('div');
    board.style.cssText = 'margin-top:22px;padding-top:16px;border-top:1px solid #4a3218;';
    board.innerHTML = '<div style="font-size:11px;letter-spacing:1px;color:#9ab8a0;margin-bottom:6px;">🏆 MILL RECORD</div>' +
      lobby.board.slice(0, 5).map((r, i) => `<div style="font-size:12px;color:#c8a878;">${i === 0 ? '🥇' : `${i + 1}.`} ${r.name} — ${r.wins}W ${r.losses}L</div>`).join('');
    panel.appendChild(board);
  }
  root.appendChild(panel);
}

function phaseText(): string {
  if (!st) return '';
  const pn = myPn();
  if (over) return '';
  if (st.removing) return st.turn === pn ? 'Take one of their stones.' : 'They\'re choosing a stone to take…';
  if (st.turn !== pn) return 'Their turn.';
  if (st.inHand[pn - 1] > 0) return `Place a stone (${st.inHand[pn - 1]} left).`;
  if (flying(st, pn)) return 'Three stones left — you may FLY anywhere.';
  return 'Slide a stone to an adjacent point.';
}

function renderGame() {
  if (!root || !st) return;
  root.replaceChildren();
  const pn = myPn();
  const size = Math.max(320, Math.min(520, window.innerHeight - 220));
  const pad = 34, step = (size - pad * 2) / 6;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:26px;align-items:center;flex-wrap:wrap;justify-content:center;max-width:96vw;';
  const boardWrap = document.createElement('div');
  boardWrap.style.cssText = 'padding:12px;border-radius:12px;background:#3a2814;border:2px solid #5a4428;box-shadow:0 16px 48px #000b;position:relative;';
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  cv.style.cssText = 'display:block;background:#8a6238;border-radius:8px;cursor:pointer;';
  const ctx = cv.getContext('2d')!;
  // wood grain
  ctx.strokeStyle = '#79542e'; ctx.lineWidth = 2;
  for (let y = 8; y < size; y += 14) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.bezierCurveTo(size / 3, y + 4, size * 2 / 3, y - 4, size, y + 2); ctx.stroke();
  }
  const P = (i: number) => [pad + PTS[i][0] * step, pad + PTS[i][1] * step] as const;
  // lines
  ctx.strokeStyle = '#2a1c10'; ctx.lineWidth = 4; ctx.lineCap = 'round';
  const LINES: [number, number][] = [
    [0, 2], [2, 23], [23, 21], [21, 0],
    [3, 5], [5, 20], [20, 18], [18, 3],
    [6, 8], [8, 17], [17, 15], [15, 6],
    [1, 7], [22, 16], [9, 11], [12, 14],
  ];
  for (const [a, b] of LINES) {
    const [ax, ay] = P(a), [bx, by] = P(b);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  // points + stones
  for (let i = 0; i < 24; i++) {
    const [x, y] = P(i);
    ctx.fillStyle = '#2a1c10';
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
    const who = st.b[i];
    if (who !== 0) {
      const grad = ctx.createRadialGradient(x - 4, y - 5, 2, x, y, 15);
      if (who === 1) { grad.addColorStop(0, '#ffe9a0'); grad.addColorStop(1, '#c8962a'); }
      else { grad.addColorStop(0, '#8a6a4a'); grad.addColorStop(1, '#3a2416'); }
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#1a1006'; ctx.lineWidth = 2; ctx.stroke();
      if (sel === i) { ctx.strokeStyle = '#ffe14d'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.stroke(); }
    }
    // hints
    if (!over && st.turn === pn) {
      if (st.removing) {
        const foe = (pn === 1 ? 2 : 1) as Cell;
        if (who === foe && (millsAt(st.b, i, foe) === 0 || allInMills(st.b, foe))) {
          ctx.strokeStyle = '#ff6a5a'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.stroke();
        }
      } else if (st.inHand[pn - 1] > 0) {
        if (who === 0) { ctx.fillStyle = '#ffe14d44'; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill(); }
      } else if (sel >= 0 && who === 0 && (flying(st, pn) || ADJ[sel].includes(i))) {
        ctx.fillStyle = '#ffe14d66'; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  cv.onclick = (ev) => {
    if (!st || over || st.turn !== pn) return;
    const rect = cv.getBoundingClientRect();
    const mx = (ev.clientX - rect.left) * (size / rect.width), my = (ev.clientY - rect.top) * (size / rect.height);
    let best = -1, bd = 24;
    for (let i = 0; i < 24; i++) {
      const [x, y] = P(i);
      const d = Math.hypot(mx - x, my - y);
      if (d < bd) { bd = d; best = i; }
    }
    if (best === -1) return;
    if (st.removing) { doTake(best, true); return; }
    if (st.inHand[pn - 1] > 0) { doPlace(best, true); return; }
    if (st.b[best] === pn) { sel = best; renderGame(); return; }
    if (sel >= 0 && st.b[best] === 0) { doMove(sel, best, true); return; }
  };
  boardWrap.appendChild(cv);
  if (over) {
    const veil = document.createElement('div');
    veil.style.cssText = 'position:absolute;inset:0;background:#140d06d8;display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:12px;gap:8px;text-align:center;padding:16px;';
    veil.innerHTML = `<div style="font-size:26px;color:#e8c86a;">${over.text}</div><div style="font-size:13px;color:#d0c0a8;font-style:italic;">${over.sub}</div>`;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;margin-top:14px;';
    if (lobby.status !== 'ended') {
      const re = document.createElement('button');
      re.textContent = rematchTheirs ? 'Rematch (they\'re waiting…)' : rematchMine ? 'Rematch offered…' : 'Rematch';
      re.style.cssText = rematchMine ? BTN_DIM : BTN;
      re.onclick = () => {
        if (rematchMine) return;
        rematchMine = true;
        net?.relay({ k: 're?' });
        if (rematchTheirs && mySlot === 0) net?.start();
        renderGame();
      };
      row.appendChild(re);
    }
    const lv = document.createElement('button');
    lv.textContent = 'Leave';
    lv.style.cssText = BTN;
    lv.onclick = () => shut();
    row.appendChild(lv);
    veil.appendChild(row);
    boardWrap.appendChild(veil);
  }
  wrap.appendChild(boardWrap);
  // side panel
  const side = document.createElement('div');
  side.style.cssText = 'width:230px;display:flex;flex-direction:column;gap:12px;';
  const plate = (slot: number) => {
    const who = pnOf(slot);
    const toMove = st!.turn === who && !over;
    const el = document.createElement('div');
    el.style.cssText = `padding:10px 12px;border-radius:10px;border:1px solid ${toMove ? '#c8a84a' : '#4a3218'};background:#241708;${toMove ? 'box-shadow:0 0 12px #c8a84a44;' : ''}`;
    el.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;">` +
      `<span style="font-size:15px;">${who === 1 ? '🟡' : '🟤'} ${nameOf(slot)}${slot === mySlot ? ' (you)' : ''}</span>` +
      `<span style="font-size:11px;color:#c8a84a;">${toMove ? 'to move' : ''}</span></div>` +
      `<div style="font-size:11px;color:#b8a888;">in hand: ${st!.inHand[who - 1]} · on board: ${st!.onBoard[who - 1]}</div>`;
    return el;
  };
  side.appendChild(plate(1 - mySlot));
  side.appendChild(plate(mySlot));
  const status = document.createElement('div');
  status.style.cssText = 'font-size:12px;font-style:italic;color:#d0c0a8;min-height:32px;text-align:center;';
  status.textContent = flash || phaseText();
  if (lobby.stake > 0 && !over) status.textContent += ` (pot: ${(lobby.stake * 2).toLocaleString()}\u{1FA99})`;
  side.appendChild(status);
  if (!over) {
    const resign = document.createElement('button');
    resign.textContent = 'Concede';
    resign.style.cssText = BTN + 'font-size:12px;background:#402121;border-color:#6b3a3a;';
    resign.onclick = () => {
      net?.relay({ k: 'resign' });
      finish('You concede.', 'The stones remember nothing. The regulars remember everything.', 1 - mySlot);
    };
    side.appendChild(resign);
  }
  const leave = document.createElement('button');
  leave.textContent = 'Leave the table';
  leave.style.cssText = BTN + 'font-size:12px;';
  leave.onclick = () => shut();
  side.appendChild(leave);
  wrap.appendChild(side);
  root.appendChild(wrap);
}
