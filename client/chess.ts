// ♞ Club Chess — 2-player PvP chess, played in the Tsong Country Club's game room.
// The server only seats the table and fans moves across (the `bg` relay, game key 'chess');
// both clients run the full rules below, so an illegal relayed move is simply ignored.
// Slot 0 hosts. Colors: host is white in game 1, then rematches swap colors each game.
// Optional winner-takes-all stake (host sets it; the SERVER escrows and settles — see lobby.ts's
// bg block). No clocks, no bots. Members do not discuss money, they merely wager it.

export interface BgNet {
  join(): void;
  leave(): void;
  start(): void;
  stake(stake: number): void;   // (host) set the winner-takes-all stake, pre-start
  result(winner: number): void; // report the finish (winner slot, -1 draw) — server settles the pot once
  relay(data: unknown): void;
  name(): string;
  muted(): boolean;
  onFinish?(): void; // (ski) a race finished — lets the World mark its objective
}

interface LobbyView { status: 'waiting' | 'playing' | 'ended'; slot: number; players: { name: string; slot: number }[]; stake: number; board?: { name: string; wins: number; losses: number }[] }

type Color = 'w' | 'b';
interface Move { f: number; t: number; p?: string } // from/to square (0=a8 … 63=h1), promotion piece ('q','r','b','n')
interface State {
  b: string[];              // 64 squares; 'P','N','B','R','Q','K' white, lowercase black, '' empty
  turn: Color;
  castle: { wk: boolean; wq: boolean; bk: boolean; bq: boolean };
  ep: number | null;        // en-passant target square (the square the capturing pawn lands on)
  half: number;             // halfmove clock (50-move rule)
  last: Move | null;
}

let open = false;
let net: BgNet | null = null;
let root: HTMLDivElement | null = null;
let lobby: LobbyView = { status: 'waiting', slot: 0, players: [], stake: 0 };
let st: State | null = null;
let mySlot = 0;
let gameN = 0;              // rematch counter — even: host is white, odd: host is black
let sel = -1;               // selected square (-1 none)
let legalTargets: Move[] = [];
let over: { text: string; sub: string } | null = null;
let drawOffered = false;    // we offered
let drawIncoming = false;   // they offered
let rematchMine = false, rematchTheirs = false;
let captured: { w: string[]; b: string[] } = { w: [], b: [] };
let moveLog: string[] = [];

const GLYPH: Record<string, string> = {
  K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙',
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
};

// --- rules ------------------------------------------------------------------------------------

function freshState(): State {
  const back = 'rnbqkbnr', BACK = 'RNBQKBNR';
  const b: string[] = new Array(64).fill('');
  for (let i = 0; i < 8; i++) { b[i] = back[i]; b[8 + i] = 'p'; b[48 + i] = 'P'; b[56 + i] = BACK[i]; }
  return { b, turn: 'w', castle: { wk: true, wq: true, bk: true, bq: true }, ep: null, half: 0, last: null };
}
const colorOf = (pc: string): Color | null => (pc === '' ? null : pc === pc.toUpperCase() ? 'w' : 'b');
const rc = (i: number) => [i >> 3, i & 7] as const;
const idx = (r: number, c: number) => r * 8 + c;
const on = (r: number, c: number) => r >= 0 && r < 8 && c >= 0 && c < 8;

const RAYS: Record<string, number[][]> = {
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  q: [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]],
};
const KNIGHT = [[2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]];
const KING = RAYS.q;

/** Is `sq` attacked by side `by` on board `b`? Scans outward from the square — cheap enough. */
function attacked(b: string[], sq: number, by: Color): boolean {
  const [r, c] = rc(sq);
  const enemy = (pc: string, kinds: string) => pc !== '' && colorOf(pc) === by && kinds.includes(pc.toLowerCase());
  for (const [dr, dc] of KNIGHT) if (on(r + dr, c + dc) && enemy(b[idx(r + dr, c + dc)], 'n')) return true;
  for (const [dr, dc] of KING) if (on(r + dr, c + dc) && enemy(b[idx(r + dr, c + dc)], 'k')) return true;
  for (const [dr, dc] of RAYS.r) {
    for (let k = 1; ; k++) {
      const rr = r + dr * k, cc = c + dc * k;
      if (!on(rr, cc)) break;
      const pc = b[idx(rr, cc)];
      if (pc === '') continue;
      if (enemy(pc, 'rq')) return true;
      break;
    }
  }
  for (const [dr, dc] of RAYS.b) {
    for (let k = 1; ; k++) {
      const rr = r + dr * k, cc = c + dc * k;
      if (!on(rr, cc)) break;
      const pc = b[idx(rr, cc)];
      if (pc === '') continue;
      if (enemy(pc, 'bq')) return true;
      break;
    }
  }
  // pawns: white pawns attack "up" the array (toward row 0), black attack downward
  const pr = by === 'w' ? r + 1 : r - 1;
  for (const cc of [c - 1, c + 1]) {
    if (on(pr, cc)) {
      const pc = b[idx(pr, cc)];
      if (pc !== '' && colorOf(pc) === by && pc.toLowerCase() === 'p') return true;
    }
  }
  return false;
}

function kingSq(b: string[], color: Color): number {
  const k = color === 'w' ? 'K' : 'k';
  for (let i = 0; i < 64; i++) if (b[i] === k) return i;
  return -1;
}

/** Pseudo-legal moves from `f` (castling included, with its through-check rules baked in). */
function pseudo(s: State, f: number): Move[] {
  const pc = s.b[f];
  if (pc === '') return [];
  const me = colorOf(pc)!;
  const [r, c] = rc(f);
  const out: Move[] = [];
  const push = (t: number) => out.push({ f, t });
  const kind = pc.toLowerCase();
  if (kind === 'p') {
    const dir = me === 'w' ? -1 : 1, home = me === 'w' ? 6 : 1, promo = me === 'w' ? 0 : 7;
    const one = idx(r + dir, c);
    if (on(r + dir, c) && s.b[one] === '') {
      if (r + dir === promo) for (const p of ['q', 'r', 'b', 'n']) out.push({ f, t: one, p });
      else push(one);
      const two = idx(r + dir * 2, c);
      if (r === home && s.b[two] === '') push(two);
    }
    for (const cc of [c - 1, c + 1]) {
      if (!on(r + dir, cc)) continue;
      const t = idx(r + dir, cc);
      const target = s.b[t];
      if ((target !== '' && colorOf(target) !== me) || s.ep === t) {
        if (r + dir === promo) for (const p of ['q', 'r', 'b', 'n']) out.push({ f, t, p });
        else push(t);
      }
    }
    return out;
  }
  if (kind === 'n' || kind === 'k') {
    for (const [dr, dc] of kind === 'n' ? KNIGHT : KING) {
      if (!on(r + dr, c + dc)) continue;
      const t = idx(r + dr, c + dc);
      if (s.b[t] === '' || colorOf(s.b[t]) !== me) push(t);
    }
    if (kind === 'k') {
      // castling: rights intact, path empty, king not in / through / into check
      const row = me === 'w' ? 7 : 0, foe: Color = me === 'w' ? 'b' : 'w';
      const kAt = idx(row, 4);
      if (f === kAt && !attacked(s.b, kAt, foe)) {
        const short = me === 'w' ? s.castle.wk : s.castle.bk;
        const long = me === 'w' ? s.castle.wq : s.castle.bq;
        if (short && s.b[idx(row, 5)] === '' && s.b[idx(row, 6)] === ''
          && !attacked(s.b, idx(row, 5), foe) && !attacked(s.b, idx(row, 6), foe)
          && s.b[idx(row, 7)].toLowerCase() === 'r') push(idx(row, 6));
        if (long && s.b[idx(row, 3)] === '' && s.b[idx(row, 2)] === '' && s.b[idx(row, 1)] === ''
          && !attacked(s.b, idx(row, 3), foe) && !attacked(s.b, idx(row, 2), foe)
          && s.b[idx(row, 0)].toLowerCase() === 'r') push(idx(row, 2));
      }
    }
    return out;
  }
  for (const [dr, dc] of RAYS[kind] ?? []) {
    for (let k = 1; ; k++) {
      const rr = r + dr * k, cc = c + dc * k;
      if (!on(rr, cc)) break;
      const t = idx(rr, cc);
      if (s.b[t] === '') { push(t); continue; }
      if (colorOf(s.b[t]) !== me) push(t);
      break;
    }
  }
  return out;
}

/** Apply a move to a copy of the state (assumes pseudo-legality). Returns the new state. */
function apply(s: State, m: Move): State {
  const b = s.b.slice();
  const pc = b[m.f], me = colorOf(pc)!, kind = pc.toLowerCase();
  const [fr] = rc(m.f), [tr, tc] = rc(m.t);
  let half = s.half + 1;
  if (kind === 'p' || b[m.t] !== '') half = 0;
  // en passant capture: the victim pawn is BESIDE the landing square
  if (kind === 'p' && m.t === s.ep && b[m.t] === '') b[idx(fr, tc)] = '';
  b[m.t] = m.p ? (me === 'w' ? m.p.toUpperCase() : m.p.toLowerCase()) : pc;
  b[m.f] = '';
  // castling: hop the rook over
  if (kind === 'k' && Math.abs(tc - (m.f & 7)) === 2) {
    const row = tr;
    if (tc === 6) { b[idx(row, 5)] = b[idx(row, 7)]; b[idx(row, 7)] = ''; }
    else { b[idx(row, 3)] = b[idx(row, 0)]; b[idx(row, 0)] = ''; }
  }
  const castle = { ...s.castle };
  if (pc === 'K') { castle.wk = castle.wq = false; }
  if (pc === 'k') { castle.bk = castle.bq = false; }
  for (const [sq, key] of [[63, 'wk'], [56, 'wq'], [7, 'bk'], [0, 'bq']] as [number, keyof State['castle']][]) {
    if (m.f === sq || m.t === sq) castle[key] = false;
  }
  const ep = kind === 'p' && Math.abs(tr - fr) === 2 ? idx((tr + fr) / 2, tc) : null;
  return { b, turn: me === 'w' ? 'b' : 'w', castle, ep, half, last: m };
}

function legal(s: State, f: number): Move[] {
  const me = colorOf(s.b[f]);
  if (me !== s.turn) return [];
  return pseudo(s, f).filter((m) => {
    const n = apply(s, m);
    return !attacked(n.b, kingSq(n.b, me), me === 'w' ? 'b' : 'w');
  });
}
function anyLegal(s: State): boolean {
  for (let i = 0; i < 64; i++) if (colorOf(s.b[i]) === s.turn && legal(s, i).length) return true;
  return false;
}
function inCheck(s: State): boolean {
  return attacked(s.b, kingSq(s.b, s.turn), s.turn === 'w' ? 'b' : 'w');
}
function insufficient(b: string[]): boolean {
  const pcs = b.filter((p) => p !== '' && p.toLowerCase() !== 'k').map((p) => p.toLowerCase());
  if (pcs.length === 0) return true;
  if (pcs.length === 1 && (pcs[0] === 'b' || pcs[0] === 'n')) return true;
  return false;
}
const sqName = (i: number) => 'abcdefgh'[i & 7] + String(8 - (i >> 3));

// --- audio ------------------------------------------------------------------------------------
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
const sndMove = () => tone(520, 0.06, 'sine', 0.05);
const sndCapture = () => { tone(300, 0.08, 'square', 0.05); tone(180, 0.1, 'sine', 0.04); };
const sndCheck = () => tone(760, 0.16, 'triangle', 0.06);
const sndEnd = () => { tone(392, 0.4, 'sine', 0.06); setTimeout(() => tone(494, 0.4, 'sine', 0.05), 130); setTimeout(() => tone(587, 0.6, 'sine', 0.05), 260); };

// --- lifecycle --------------------------------------------------------------------------------

export function isChessOpen() { return open; }

export function openChess(n: BgNet) {
  if (open) return;
  open = true;
  net = n;
  lobby = { status: 'waiting', slot: 0, players: [], stake: 0 };
  st = null; over = null; gameN = 0;
  root = document.createElement('div');
  root.id = 'chessOverlay';
  root.style.cssText =
    'position:fixed;inset:0;z-index:20000;display:flex;align-items:center;justify-content:center;' +
    'background:radial-gradient(ellipse at 50% 30%, #17301f 0%, #0a1710 70%);' +
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

function myColor(): Color { return (mySlot === 0) === (gameN % 2 === 0) ? 'w' : 'b'; }
function nameOf(slot: number): string {
  return lobby.players.find((p) => p.slot === slot)?.name ?? (slot === mySlot ? (net?.name() || 'You') : '…');
}

function startGame() {
  st = freshState();
  sel = -1; legalTargets = []; over = null;
  drawOffered = drawIncoming = false;
  rematchMine = rematchTheirs = false;
  captured = { w: [], b: [] };
  moveLog = [];
  renderGame();
}

// --- networking -------------------------------------------------------------------------------

export function feedLobby(msg: LobbyView) {
  if (!open) return;
  const was = lobby.status;
  lobby = msg;
  mySlot = msg.slot;
  if (msg.status === 'ended') {
    // The table broke up (someone left mid-game / host gone).
    if (st && !over) { over = { text: 'The table empties.', sub: 'Your opponent has left the room.' }; sndEnd(); renderGame(); }
    else shut();
    return;
  }
  if (msg.status === 'playing' && was !== 'playing') {
    if (st) gameN++; // the table restarted with the board set — a rematch (colors swap)
    else gameN = 0;
    startGame();
    return;
  }
  if (!st) renderLobby();
  else renderGame(); // refresh name plates
}

export function feedRelay(data: unknown) {
  if (!open || !st) return;
  const d = data as { k?: string; f?: number; t?: number; p?: string };
  if (!d || typeof d !== 'object') return;
  if (d.k === 'move' && typeof d.f === 'number' && typeof d.t === 'number') {
    if (over) return;
    if (st.turn === myColor()) return; // not their turn — ignore
    const mv = legal(st, d.f).find((m) => m.t === d.t && (m.p ?? undefined) === (typeof d.p === 'string' ? d.p : undefined));
    if (!mv) return;
    commitMove(mv, false);
    return;
  }
  if (d.k === 'resign' && !over) { finish(`${nameOf(1 - mySlot)} resigns.`, 'The club pretends not to notice. You win.', mySlot); return; }
  if (d.k === 'draw?') { drawIncoming = true; renderGame(); return; }
  if (d.k === 'draw+' && drawOffered) { finish('Draw agreed.', 'Honour intact on both sides.', -1); return; }
  if (d.k === 'draw-') { drawOffered = false; renderGame(); return; }
  if (d.k === 're?') {
    rematchTheirs = true;
    if (rematchMine && mySlot === 0) net?.start(); // host restarts via the server (stakes re-escrow)
    renderGame();
    return;
  }
}

function slotOfColor(color: Color): number {
  return (color === 'w') === (gameN % 2 === 0) ? 0 : 1;
}
function finish(text: string, sub: string, winnerSlot?: number) {
  over = { text, sub };
  if (winnerSlot !== undefined) net?.result(winnerSlot); // -1 = draw (refund); first report settles
  sndEnd();
  renderGame();
}

function commitMove(mv: Move, mine: boolean) {
  if (!st) return;
  const movedPc = st.b[mv.f];
  const victim = st.b[mv.t] !== '' ? st.b[mv.t] : (movedPc.toLowerCase() === 'p' && mv.t === st.ep ? (st.turn === 'w' ? 'p' : 'P') : '');
  if (victim !== '') captured[colorOf(victim)! === 'w' ? 'w' : 'b'].push(victim);
  const from = sqName(mv.f), to = sqName(mv.t);
  st = apply(st, mv);
  moveLog.push(`${GLYPH[movedPc] ?? ''}${from}–${to}${mv.p ? '=' + mv.p.toUpperCase() : ''}`);
  drawOffered = drawIncoming = false;
  if (mine) net?.relay({ k: 'move', f: mv.f, t: mv.t, p: mv.p });
  if (victim !== '') sndCapture(); else sndMove();
  // terminal checks (both clients derive the same verdict)
  if (!anyLegal(st)) {
    if (inCheck(st)) {
      const winColor: Color = st.turn === 'w' ? 'b' : 'w';
      const winSlot = slotOfColor(winColor);
      const iWon = winSlot === mySlot;
      finish(`Checkmate. ${winColor === 'w' ? 'White' : 'Black'} wins.`,
        iWon ? `Well played, ${net?.name() || 'member'}. The registry will hear of this.` : `${nameOf(winSlot)} accepts your congratulations with unbearable grace.`,
        winSlot);
    } else {
      finish('Stalemate.', 'Nobody wins. Very like the club, really.', -1);
    }
    return;
  }
  if (st.half >= 100) { finish('Draw — fifty quiet moves.', 'The position has been declared a garden feature.', -1); return; }
  if (insufficient(st.b)) { finish('Draw — insufficient material.', 'Neither of you brought enough pieces to the argument.', -1); return; }
  if (inCheck(st)) sndCheck();
  sel = -1; legalTargets = [];
  renderGame();
}

// --- UI ---------------------------------------------------------------------------------------

const BTN = 'cursor:pointer;background:#21402c;color:#e8dcc0;border:1px solid #3a6b4a;border-radius:8px;' +
  'padding:9px 16px;font-size:14px;font-family:inherit;';
const BTN_DIM = BTN + 'opacity:0.45;cursor:default;';

function renderLobby() {
  if (!root) return;
  root.replaceChildren();
  const panel = document.createElement('div');
  panel.style.cssText = 'text-align:center;background:#10241733;border:1px solid #2a4a35;border-radius:16px;padding:36px 48px;box-shadow:0 20px 60px #000a;';
  const h = document.createElement('div');
  h.innerHTML = '♞ THE GAME ROOM';
  h.style.cssText = 'font-size:30px;letter-spacing:4px;color:#e8c86a;margin-bottom:4px;';
  const sub = document.createElement('div');
  sub.textContent = 'Chess. A gentleman\'s disagreement, resolved at one move per thought.';
  sub.style.cssText = 'font-style:italic;color:#9ab8a0;font-size:13px;margin-bottom:24px;';
  panel.append(h, sub);
  const seats = document.createElement('div');
  seats.style.cssText = 'display:flex;gap:18px;justify-content:center;margin-bottom:24px;';
  for (const slot of [0, 1]) {
    const p = lobby.players.find((x) => x.slot === slot);
    const seat = document.createElement('div');
    seat.style.cssText = `width:170px;padding:16px 10px;border-radius:12px;border:1px solid ${p ? '#3a6b4a' : '#22392c'};background:${p ? '#1a3524' : '#101f16'};`;
    seat.innerHTML = p
      ? `<div style="font-size:26px">${slot === 0 ? '♔' : '♚'}</div><div style="margin-top:6px;font-size:15px">${p.name}</div><div style="font-size:11px;color:#9ab8a0">${slot === 0 ? 'the chair by the fire' : 'the chair by the window'}</div>`
      : '<div style="font-size:26px;color:#33553f">♟</div><div style="margin-top:6px;font-size:13px;color:#5a7a64">an empty chair</div><div style="font-size:11px;color:#41604c">awaiting a member</div>';
    seats.appendChild(seat);
  }
  panel.appendChild(seats);
  // the wager: host sets it, everyone sees it, the server escrows it from both at start
  const wager = document.createElement('div');
  wager.style.cssText = 'margin-bottom:18px;';
  const wLabel = document.createElement('div');
  wLabel.textContent = lobby.stake > 0 ? `Stake: ${lobby.stake.toLocaleString()}\u{1FA99} each — winner takes all` : 'A friendly game (no stake)';
  wLabel.style.cssText = `font-size:13px;color:${lobby.stake > 0 ? '#e8c86a' : '#9ab8a0'};margin-bottom:8px;`;
  wager.appendChild(wLabel);
  if (mySlot === 0) {
    const row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;gap:6px;justify-content:center;flex-wrap:wrap;';
    for (const [label, amt] of [['Friendly', 0], ['1k', 1000], ['10k', 10000], ['100k', 100000], ['1M', 1000000]] as [string, number][]) {
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
      const v = parseInt(prompt('Stake per player (coins):', String(lobby.stake || 1000)) || '', 10);
      if (Number.isFinite(v) && v >= 0) net?.stake(v);
    };
    row2.appendChild(custom);
    wager.appendChild(row2);
  } else if (lobby.stake > 0) {
    const note = document.createElement('div');
    note.textContent = 'Sitting at this table when the game begins is agreeing to the stake.';
    note.style.cssText = 'font-size:11px;font-style:italic;color:#9ab8a0;';
    wager.appendChild(note);
  }
  panel.appendChild(wager);
  const status = document.createElement('div');
  status.textContent = lobby.players.length < 2 ? 'Waiting for a second member to sit down…' : (mySlot === 0 ? 'Both chairs taken. Begin at your leisure.' : 'Both chairs taken. Your host will begin shortly.');
  status.style.cssText = 'font-size:13px;color:#b8d0be;margin-bottom:20px;';
  panel.appendChild(status);
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:12px;justify-content:center;';
  if (mySlot === 0) {
    const start = document.createElement('button');
    start.textContent = 'Begin the game';
    start.style.cssText = lobby.players.length >= 2 ? BTN : BTN_DIM;
    start.disabled = lobby.players.length < 2;
    start.onclick = () => net?.start();
    row.appendChild(start);
  }
  const leave = document.createElement('button');
  leave.textContent = 'Leave the table';
  leave.style.cssText = BTN;
  leave.onclick = () => shut();
  row.appendChild(leave);
  panel.appendChild(row);
  if (lobby.board && lobby.board.length) {
    const board = document.createElement('div');
    board.style.cssText = 'margin-top:22px;padding-top:16px;border-top:1px solid #2a4a35;';
    board.innerHTML = '<div style="font-size:11px;letter-spacing:1px;color:#9ab8a0;margin-bottom:6px;">🏆 CLUB RECORD</div>' +
      lobby.board.slice(0, 5).map((r, i) => `<div style="font-size:12px;color:#c8a878;">${i === 0 ? '🥇' : `${i + 1}.`} ${r.name} — ${r.wins}W ${r.losses}L</div>`).join('');
    panel.appendChild(board);
  }
  root.appendChild(panel);
}

function renderGame() {
  if (!root || !st) return;
  root.replaceChildren();
  const me = myColor();
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:26px;align-items:center;flex-wrap:wrap;justify-content:center;max-width:96vw;';
  // --- the board ---
  const sq = Math.max(40, Math.min(68, Math.floor((window.innerHeight - 180) / 8)));
  const boardWrap = document.createElement('div');
  boardWrap.style.cssText = 'padding:14px;border-radius:12px;background:#3a2a18;border:2px solid #5a4428;box-shadow:0 16px 48px #000b;position:relative;';
  const board = document.createElement('div');
  board.style.cssText = `display:grid;grid-template-columns:repeat(8,${sq}px);grid-template-rows:repeat(8,${sq}px);border:2px solid #2a1c0e;`;
  const flip = me === 'b';
  for (let vis = 0; vis < 64; vis++) {
    const i = flip ? 63 - vis : vis;
    const [r, c] = rc(i);
    const dark = (r + c) % 2 === 1;
    const cell = document.createElement('div');
    const isLast = st.last && (st.last.f === i || st.last.t === i);
    const isSel = sel === i;
    const bg = isSel ? '#c8a84a' : isLast ? (dark ? '#6b7a45' : '#c8cf8e') : dark ? '#4a6b4a' : '#e8dcc0';
    cell.style.cssText = `width:${sq}px;height:${sq}px;background:${bg};display:flex;align-items:center;justify-content:center;` +
      `font-size:${Math.floor(sq * 0.74)}px;cursor:pointer;position:relative;user-select:none;line-height:1;`;
    const pc = st.b[i];
    if (pc !== '') {
      const span = document.createElement('span');
      span.textContent = GLYPH[pc];
      span.style.cssText = colorOf(pc) === 'w'
        ? 'color:#f8f4ea;text-shadow:0 2px 2px #0009, 0 0 1px #000;'
        : 'color:#1a140c;text-shadow:0 1px 1px #fff3;';
      cell.appendChild(span);
    }
    const tgt = legalTargets.find((m) => m.t === i);
    if (tgt) {
      const dot = document.createElement('div');
      dot.style.cssText = st.b[i] !== ''
        ? `position:absolute;inset:2px;border:3px solid #c8a84acc;border-radius:8px;pointer-events:none;`
        : `position:absolute;width:${Math.floor(sq * 0.3)}px;height:${Math.floor(sq * 0.3)}px;border-radius:50%;background:#c8a84a99;pointer-events:none;`;
      cell.appendChild(dot);
    }
    // coordinates on the visual edges
    if (vis % 8 === 0) {
      const rank = document.createElement('div');
      rank.textContent = String(8 - r);
      rank.style.cssText = 'position:absolute;top:2px;left:3px;font-size:10px;color:#00000055;font-family:ui-monospace,monospace;pointer-events:none;';
      if (!dark) rank.style.color = '#00000040';
      cell.appendChild(rank);
    }
    if (vis >= 56) {
      const file = document.createElement('div');
      file.textContent = 'abcdefgh'[c];
      file.style.cssText = 'position:absolute;bottom:1px;right:3px;font-size:10px;color:#00000055;font-family:ui-monospace,monospace;pointer-events:none;';
      cell.appendChild(file);
    }
    cell.onclick = () => onSquare(i);
    board.appendChild(cell);
  }
  boardWrap.appendChild(board);
  // end-of-game curtain
  if (over) {
    const veil = document.createElement('div');
    veil.style.cssText = 'position:absolute;inset:0;background:#0a1710d8;display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:12px;gap:8px;text-align:center;padding:16px;';
    veil.innerHTML = `<div style="font-size:26px;color:#e8c86a;">${over.text}</div><div style="font-size:13px;color:#b8d0be;font-style:italic;">${over.sub}</div>`;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;margin-top:14px;';
    if (lobby.status !== 'ended') {
      const re = document.createElement('button');
      re.textContent = rematchTheirs ? 'Rematch (they\'re waiting…)' : rematchMine ? 'Rematch offered…' : 'Offer a rematch';
      re.style.cssText = rematchMine ? BTN_DIM : BTN;
      re.onclick = () => {
        if (rematchMine) return;
        rematchMine = true;
        net?.relay({ k: 're?' });
        if (rematchTheirs && mySlot === 0) net?.start(); // both agreed — host restarts via the server
        renderGame();
      };
      row.appendChild(re);
    }
    const lv = document.createElement('button');
    lv.textContent = 'Retire to the lounge';
    lv.style.cssText = BTN;
    lv.onclick = () => shut();
    row.appendChild(lv);
    veil.appendChild(row);
    boardWrap.appendChild(veil);
  }
  wrap.appendChild(boardWrap);
  // --- side panel ---
  const side = document.createElement('div');
  side.style.cssText = 'width:250px;display:flex;flex-direction:column;gap:12px;';
  const plate = (slot: number) => {
    const color: Color = (slot === 0) === (gameN % 2 === 0) ? 'w' : 'b';
    const toMove = st!.turn === color && !over;
    const el = document.createElement('div');
    el.style.cssText = `padding:10px 12px;border-radius:10px;border:1px solid ${toMove ? '#c8a84a' : '#2a4a35'};background:#12281a;${toMove ? 'box-shadow:0 0 12px #c8a84a44;' : ''}`;
    const caps = captured[color === 'w' ? 'b' : 'w'].map((p) => GLYPH[p]).join('');
    el.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;">` +
      `<span style="font-size:15px;">${color === 'w' ? '♔' : '♚'} ${nameOf(slot)}${slot === mySlot ? ' (you)' : ''}</span>` +
      `<span style="font-size:11px;color:#c8a84a;">${toMove ? 'to move' : ''}</span></div>` +
      `<div style="font-size:15px;min-height:20px;color:#9ab8a0;letter-spacing:1px;">${caps}</div>`;
    return el;
  };
  side.appendChild(plate(1 - mySlot));
  side.appendChild(plate(mySlot));
  // move list
  const log = document.createElement('div');
  log.style.cssText = 'height:150px;overflow-y:auto;background:#0d1f14;border:1px solid #22392c;border-radius:10px;padding:8px 10px;font-size:12px;font-family:ui-monospace,monospace;color:#b8d0be;display:grid;grid-template-columns:1fr 1fr;gap:1px 10px;align-content:start;';
  moveLog.forEach((m, i) => {
    const e = document.createElement('div');
    e.textContent = `${i % 2 === 0 ? Math.floor(i / 2) + 1 + '. ' : ''}${m}`;
    log.appendChild(e);
  });
  log.scrollTop = log.scrollHeight;
  side.appendChild(log);
  // status line
  const status = document.createElement('div');
  status.style.cssText = 'font-size:12px;font-style:italic;color:#9ab8a0;min-height:16px;text-align:center;';
  status.textContent = over ? '' : inCheck(st) ? (st.turn === me ? 'You are in check.' : 'Check.') : st.turn === me ? 'Your move.' : 'Their move. Swirl your drink.';
  if (lobby.stake > 0 && !over) status.textContent += ` (pot: ${(lobby.stake * 2).toLocaleString()}\u{1FA99})`;
  side.appendChild(status);
  // draw offer incoming
  if (drawIncoming && !over) {
    const d = document.createElement('div');
    d.style.cssText = 'background:#1a3524;border:1px solid #c8a84a;border-radius:10px;padding:10px;text-align:center;font-size:13px;';
    d.innerHTML = `${nameOf(1 - mySlot)} proposes a draw.`;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:center;margin-top:8px;';
    const yes = document.createElement('button'); yes.textContent = 'Agree'; yes.style.cssText = BTN;
    yes.onclick = () => { net?.relay({ k: 'draw+' }); finish('Draw agreed.', 'Honour intact on both sides.', -1); };
    const no = document.createElement('button'); no.textContent = 'Decline'; no.style.cssText = BTN;
    no.onclick = () => { drawIncoming = false; net?.relay({ k: 'draw-' }); renderGame(); };
    row.append(yes, no);
    d.appendChild(row);
    side.appendChild(d);
  }
  // controls
  if (!over) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;';
    const draw = document.createElement('button');
    draw.textContent = drawOffered ? 'Draw offered…' : 'Offer draw';
    draw.style.cssText = (drawOffered ? BTN_DIM : BTN) + 'flex:1;font-size:12px;';
    draw.onclick = () => { if (drawOffered) return; drawOffered = true; net?.relay({ k: 'draw?' }); renderGame(); };
    const resign = document.createElement('button');
    resign.textContent = 'Resign';
    resign.style.cssText = BTN + 'flex:1;font-size:12px;background:#402121;border-color:#6b3a3a;';
    resign.onclick = () => {
      net?.relay({ k: 'resign' });
      finish('You resign.', 'A dignified exit is also a move.', 1 - mySlot);
    };
    row.append(draw, resign);
    side.appendChild(row);
  }
  const leave = document.createElement('button');
  leave.textContent = 'Leave the table';
  leave.style.cssText = BTN + 'font-size:12px;';
  leave.onclick = () => shut();
  side.appendChild(leave);
  wrap.appendChild(side);
  root.appendChild(wrap);
}

function onSquare(i: number) {
  if (!st || over) return;
  const me = myColor();
  if (st.turn !== me) return;
  const tgt = legalTargets.find((m) => m.t === i);
  if (sel >= 0 && tgt) {
    const promos = legalTargets.filter((m) => m.t === i && m.p);
    if (promos.length > 1) { promptPromotion(promos); return; }
    commitMove(tgt, true);
    return;
  }
  if (colorOf(st.b[i]) === me) {
    sel = i;
    legalTargets = legal(st, i);
  } else {
    sel = -1; legalTargets = [];
  }
  renderGame();
}

function promptPromotion(options: Move[]) {
  if (!root) return;
  const veil = document.createElement('div');
  veil.style.cssText = 'position:fixed;inset:0;z-index:20001;background:#0a1710b0;display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div');
  box.style.cssText = 'background:#12281a;border:1px solid #c8a84a;border-radius:14px;padding:20px 24px;text-align:center;';
  box.innerHTML = '<div style="font-size:14px;color:#b8d0be;margin-bottom:12px;">The pawn arrives. It may become:</div>';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:10px;';
  const white = myColor() === 'w';
  for (const p of ['q', 'r', 'b', 'n']) {
    const m = options.find((o) => o.p === p);
    if (!m) continue;
    const b = document.createElement('button');
    b.textContent = GLYPH[white ? p.toUpperCase() : p];
    b.style.cssText = BTN + 'font-size:34px;padding:6px 14px;line-height:1;';
    b.onclick = () => { veil.remove(); commitMove(m, true); };
    row.appendChild(b);
  }
  box.appendChild(row);
  veil.appendChild(box);
  root.appendChild(veil);
}
