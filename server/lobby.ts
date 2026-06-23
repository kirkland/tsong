// Tracks every connected socket, which two of them hold the paddle spots, and turns
// the Game's raw state into the broadcast message (attaching nicknames / watchers).

import type { WebSocket } from 'ws';
import { Game } from './game';
import { PolyGame } from './polygame';
import { Tournament, Participant } from './tournament';
import {
  CHAT_HISTORY,
  CHAT_MAX_LEN,
  ChatLine,
  BALL_REACTION,
  BotLevel,
  COSMETICS,
  COURT,
  ARENA,
  FATALITY_MOVES,
  LeaderboardRow,
  NetWorthRow,
  BalanceSheetHolding,
  MAX_PLAYERS,
  PaddleState,
  POWERUPS,
  PowerupKind,
  PolyPlayer,
  PolyState,
  Role,
  ServerMsg,
  Side,
  SPIN_SEGMENTS,
  COIN_SCALE,
  ROULETTE_PAYOUTS,
  ROULETTE_MAX_TOTAL,
  RouletteBet,
  RouletteBetKind,
  rouletteWins,
  StateMsg,
  STOCKS,
  STOCK_UPDATE_MS,
  STOCK_HISTORY,
  MARKET_INSTABILITY_THRESHOLD,
  StockSide,
  positionWorth,
  TEAM_MAX,
  WalletMsg,
  CampaignScoreRow,
  WC_COUNTRIES,
} from '../shared/types';
import { getLeaderboard, getNetWorthLeaderboard, recordResult, updateName, recordDoomScore, getDoomLeaderboards, DoomScoreRow,
  recordCampaignScore, getCampaignLeaderboard, awardTitle,
  getWallet, buyItem, equipItem, addCoins, spendCoins, claimSpin, grantItem, getElos, addBonusSpin, useBonusSpin, findPlayerByName, DAILY_SPIN_MS,
  getHoldings, investStock, cashOutStock, getStockPrices, saveStockPrices, getStockHistory, saveStockHistory,
  setStockCrashAt, getMarketInstability, setMarketInstability,
  getLoan, takeLoan, repayLoan, collectDefaultedLoans, realignLoansToDeadline,
  addBounty, getBountyOn, clearBounty, getBounties } from './db';
import { blendElo, perPointProb, liveOdds } from './odds';
import { READY_TIMEOUT, CAPTURE_TIMEOUT, TICK_MS, PINATA } from '../shared/types';

// A reaction is valid if it's the ball sentinel or a short string made only of
// emoji code points (pictographs, components, ZWJ, variation selectors, flags).
// This lets the full picker through while blocking arbitrary text / markup.
const EMOJI_ONLY =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Regional_Indicator}|‍|️)+$/u;
function isValidReaction(emoji: string): boolean {
  if (emoji === BALL_REACTION) return true;
  return emoji.length > 0 && emoji.length <= 16 && EMOJI_ONLY.test(emoji);
}

interface Conn {
  id: string; // per-connection id (used in `you` messages)
  pid: string; // stable per-browser identity (leaderboard key); '' until joined
  nickname: string; // '' until the client has sent `join`
  role: Role;
  color: string; // chosen paddle color
  captured: boolean; // mouse captured to the board (pointer lock); gates play start
  captureDeadline: number; // seconds left to capture before being benched (0 = not counting)
  lastChatAt: number; // ms timestamp of last chat message (light rate limiting)
  // Cached wallet/cosmetics (loaded from the DB on join). Purely cosmetic — never affects play.
  hat: string | null;
  skin: string | null;
  trail: string | null;
  title: string | null;
}

// One step of a crypto's price random walk. Pure RNG — never tied to who invested or how
// much. The market trends UP at a *calm* pace: a steady drift doubles the typical price about
// once a DAY (derived from the re-roll interval, so it holds at any cadence), which keeps the
// numbers human-readable (~1–3) between the daily resets. The noise sits in log space
// (symmetric, so it doesn't drag the typical trajectory below the drift): usually ±~5% per
// tick, with a 1-in-12 chance of a bigger swing on top. Clamped to [base/100, base×1000] and
// rounded to cents (so it can dip below the starting price for real downside, never to zero).
function rollPrice(price: number, base: number): number {
  const ticksPerDay = 86_400_000 / STOCK_UPDATE_MS;
  const drift = Math.pow(2, 1 / ticksPerDay); // typical ×2 per day — a gentle climb
  let g = (Math.random() * 2 - 1) * 0.05; // ±5% jitter (log space)
  if (Math.random() < 0.08) g += (Math.random() * 2 - 1) * 0.18; // occasional bigger swing
  const np = price * drift * Math.exp(g);
  return Math.round(Math.max(base / 100, Math.min(np, base * 1_000)) * 100) / 100;
}

// Epoch-ms of the next 5:00pm America/New_York from `nowMs`. DST-aware via Intl: we read the
// current NY wall-clock time and add however many seconds remain until 17:00 there (rolling to
// tomorrow once 5pm has passed). Pure arithmetic on the formatted parts — no timezone-Date
// construction — so it can't throw on a bad offset; worst case on a DST-transition day it's off
// by an hour, which is harmless for a daily game deadline.
function nextFivePmEtMs(nowMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(nowMs));
  const val = (t: string) => Number(parts.find((p) => p.type === t)?.value) || 0;
  const secsNow = (val('hour') % 24) * 3600 + val('minute') * 60 + val('second');
  const target = 17 * 3600; // 5:00pm
  let delta = target - secsNow;
  if (delta <= 0) delta += 24 * 3600; // already past 5pm in NY → the next one is tomorrow
  return nowMs + delta * 1000;
}

// Epoch ms when the daily spin is next available (0 = available now).
function nextSpinAt(lastSpin: number): number {
  const next = (lastSpin || 0) + DAILY_SPIN_MS;
  return next > Date.now() ? next : 0;
}

const SIDES: Side[] = ['left', 'right'];
const FATALITY_DISPLAY_MS = 4500; // how long the finishing move holds before the lobby resets
const POLY_OVER_SECS = 5; // how long the arena win screen lingers before the next round
const RESUME_GRACE = 45; // seconds a resumed match waits for seated players to reconnect
const TOURNEY_INTER_MS = 5000; // pause between tournament matches so the result can be read
const TOURNEY_DONE_MS = 12000; // how long the champion screen lingers before the tournament tears down
const MAX_TIP = 1_000_000; // sanity cap on a single /tip (balance is the real limit)
const MAX_BOUNTY = 1_000_000; // sanity cap on a single bounty contribution (balance is the real limit)

// What a seat / queue spot needs to be reclaimed by the same identity after a restart.
interface SeatInfo {
  pid: string;
  nickname: string;
  color: string;
  y: number; // paddle center Y at shutdown, restored on reattach
}

// Everything the lobby needs to put players back where they were after a restart.
// Seats, king and queue are stored by stable pid (sockets don't survive a restart);
// reconnecting clients reclaim them in join(). The rest is plain state.
export interface LobbySnapshot {
  sides: Record<Side, SeatInfo[]>;
  king: { side: Side; pid: string; nickname: string } | null;
  streakPid: string | null;
  kingStreak: number;
  fatalityWinnerPid: string | null;
  fatalityWinnerSide: Side | null;
  activeFatality: { side: Side; move: string } | null;
  fatalityAt: number;
  fatalitiesEnabled: boolean;
  queue: { pid: string; nickname: string }[];
  ready: Record<Side, boolean>;
  readyTimer: number;
  winnerName: string | null;
  overHandled: boolean;
  chatLog: ChatLine[];
}

export class Lobby {
  private conns = new Map<WebSocket, Conn>();
  // Players seated on each side, in join order. Each has their own paddle in the Game.
  private teams: Record<Side, WebSocket[]> = { left: [], right: [] };
  private winnerName: string | null = null;
  private overHandled = false; // guards the one-time spot reopening when a match ends
  private king: { side: Side; pid: string; nickname: string; ws: WebSocket } | null = null;
  private streakPid: string | null = null; // pid of the player on the current win streak
  private kingStreak = 0; // consecutive match wins by that player (the king's reign length)
  // The winner is released to observer the instant the match ends, so we can't use the
  // side slots to authorize a finishing move — we remember who won by stable pid/side.
  private fatalityWinnerPid: string | null = null;
  private fatalityWinnerSide: Side | null = null;
  private activeFatality: { side: Side; move: string } | null = null;
  private fatalityAt = 0; // ms timestamp the finishing move started (0 = none)
  private fatalitiesEnabled = true; // always on — finishers can't be disabled
  private queue: WebSocket[] = []; // ordered spectators waiting to play
  private ready: Record<Side, boolean> = { left: false, right: false };
  private readyTimer = 0; // seconds remaining for ready-up; 0 = no timer active
  private captureCountdown = 0; // soonest pending bench-the-laggard timer, in seconds (0 = none running)
  private leaderboard: LeaderboardRow[] = []; // cached standings, pushed to clients
  private netWorth: NetWorthRow[] = []; // cached net-worth board (coins + holdings − debt)
  private netWorthPids: string[] = []; // pid per net-worth row (server-only; resolves a rank → player)
  private chatLog: ChatLine[] = []; // recent chat, replayed to new connections
  private nextId = 1;

  // --- Arena (free-for-all polygon) mode ---
  // A separate subsystem that runs alongside the classic duel. When arena mode is armed
  // and a 3rd player wants in, the two duel players migrate onto the polygon and play
  // continues there; drop back below 3 and they migrate back to the classic box. The duel
  // Game/teams above are left completely untouched — `mode` decides which sim is live.
  private arena = false; // shared toggle (off = classic only, caps the room at 2 players)
  private mode: 'duel' | 'poly' = 'duel';
  private arenaSeats: WebSocket[] = []; // ordered paddle holders while mode === 'poly'
  private polyOverTimer = 0; // seconds the arena win screen lingers before the next round

  // AI opponent: a single bot that fills one duel side. It's a synthetic connection
  // (no real socket, no pid) so a match it plays never counts for the leaderboard, and
  // it's removed the moment the match ends — win or lose. Duel mode only.
  private bot: {
    ws: WebSocket;
    side: Side;
    id: string;
    level: BotLevel;
    reactTimer: number; // seconds until the bot re-aims (its reaction lag)
    aimY: number; // current target Y the bot is steering toward
  } | null = null;
  private botOverTimer = 0; // seconds the post-match screen lingers before the bot leaves

  // Streamer mode: fake chat bots spam the chat to distract players.
  private streamerMode = false;
  private viewMode: 'normal' | '3d' | 'firstperson' = 'normal';
  private streamerTick = 0; // ticks since last bot message
  private streamerNextAt = 0; // tick count to fire next bot message
  private streamerLastScore = { left: 0, right: 0 };

  // Restart resume: seats/king/queue a previous process held, keyed by stable pid,
  // waiting for those clients to reconnect and reclaim them (see restore/reattach).
  private pendingSides: Record<Side, SeatInfo[]> = { left: [], right: [] };
  private pendingKing: { side: Side; pid: string; nickname: string } | null = null;
  private pendingQueue: { pid: string; nickname: string }[] = [];
  private resumeGrace = 0; // seconds left to reclaim seats before abandoning the resume

  private poly = new PolyGame();

  // --- Tournament (single-elimination bracket) ---
  // When set, the lobby is running a bracket: it seats each match's two players into the
  // duel in turn, and king-of-hill / queue / bots are all suspended until it ends.
  private tournament: Tournament | null = null;
  private tournamentCreatorPid = ''; // only the creator may cancel the tournament
  // Spectator wagers on the current duel. Coins are escrowed when the bet is placed and paid
  // out stake × the odds locked at that moment on a correct call when the match ends. Live
  // betting allows multiple wagers per spectator, so this is a flat list (keyed loosely by pid).
  private bets: Array<{ pid: string; side: Side; amount: number; ws: WebSocket; name: string; odds: number }> = [];
  private pointProb = 0.5; // per-point P(left wins), from seated players' blended Elo; set per match
  private oddsReady = false; // has the odds model been computed for the current live duel?
  // --- Stock market: one global price board, shared by everyone. `prev` is the price at the
  // last re-roll (for %-change display). Seeded to each coin's base; hydrated from the DB on
  // startup (loadStockPrices) so it resumes across restarts. Re-rolls every STOCK_UPDATE_MS.
  private stockPrices = new Map<string, { price: number; prev: number }>(
    STOCKS.map((s) => [s.id, { price: s.base, prev: s.base }] as [string, { price: number; prev: number }]),
  );
  private nextStockUpdateAt = Date.now() + STOCK_UPDATE_MS;
  // Epoch ms of the next daily loan-collection event — the next 5:00pm America/New_York. At this
  // tick Davis collects on overdue loans and each defaulter's unpaid debt is added to the
  // instability pool; the market only crashes when that pool fills (see runDailyCollection).
  // (Re)booked to the next 5pm on each boot. 0 until scheduled.
  private nextStockCrashAt = 0;
  // Running market-instability pool (coins of defaulted loan debt accumulated since the last
  // crash). Hydrated from the DB on boot. When it reaches MARKET_INSTABILITY_THRESHOLD the
  // market crashes for everyone and this resets to 0. Surfaced to clients as the stability bar.
  private marketInstability = 0;
  // Per-coin price history for the graphs (in-memory only) — one series per timeframe, each
  // sampled at its own cadence (see STOCK_HISTORY). Seeded with the current price so a graph
  // is never empty.
  private stockHist: Record<'5m' | '1h' | '1d', Map<string, number[]>> = {
    '5m': new Map(STOCKS.map((s) => [s.id, [s.base]] as [string, number[]])),
    '1h': new Map(STOCKS.map((s) => [s.id, [s.base]] as [string, number[]])),
    '1d': new Map(STOCKS.map((s) => [s.id, [s.base]] as [string, number[]])),
  };
  private stockHistTick = 0; // re-roll counter, to decide which series to sample each tick
  private liveMatchId: number | null = null; // bracket match currently on the court
  private tourneyInterMs = 0; // ms left on the "next match" interstitial between games

  constructor(private game: Game) {}

  /** Advance whichever simulation is live this tick (called by the server loop). */
  tick(dt: number) {
    if (this.mode === 'poly') {
      this.poly.tick(dt);
    } else {
      this.steerBot(dt); // set the bot's paddle target before the sim eases paddles
      this.game.tick(dt);
    }
  }

  /** Match status for the deploy gate (/api/status): true while a real rally is running. */
  isPlaying(): boolean {
    return this.mode === 'poly' ? this.poly.status === 'playing' : this.game.status === 'playing';
  }

  add(ws: WebSocket) {
    const conn: Conn = {
      id: String(this.nextId++),
      pid: '',
      nickname: '',
      role: 'observer',
      color: '#e8eefc',
      captured: false,
      captureDeadline: 0,
      lastChatAt: 0,
      hat: null,
      skin: null,
      trail: null,
      title: null,
    };
    this.conns.set(ws, conn);
    this.tell(ws, { type: 'you', id: conn.id, role: 'observer' });
    this.tell(ws, { type: 'leaderboard', rows: this.leaderboard });
    this.tell(ws, { type: 'netWorth', rows: this.netWorth });
    this.tell(ws, { type: 'doomLeaderboard', solo: this.doomBoards.solo, coop: this.doomBoards.coop });
    this.tell(ws, { type: 'campaignLeaderboard', rows: this.campaignBoard });
    if (this.chatLog.length) this.tell(ws, { type: 'chat', lines: this.chatLog });
  }

  chat(ws: WebSocket, text: string) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return; // must have joined
    const now = Date.now();
    if (now - conn.lastChatAt < 400) return; // light anti-spam throttle
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LEN);
    if (!clean) return;
    conn.lastChatAt = now;

    const line: ChatLine = {
      from: conn.nickname,
      text: clean,
      player: conn.role !== 'observer',
      color: conn.color,
      time: now,
    };
    this.chatLog.push(line);
    if (this.chatLog.length > CHAT_HISTORY) this.chatLog.shift();

    const data = JSON.stringify({ type: 'chat', lines: [line] });
    for (const sock of this.conns.keys()) {
      if (sock.readyState === sock.OPEN) sock.send(data);
    }
  }

  reaction(ws: WebSocket, emoji: string) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return; // must have joined
    if (!isValidReaction(emoji)) return; // emoji (or the ball sentinel) only
    const now = Date.now();
    if (now - conn.lastChatAt < 250) return; // share the chat throttle (light anti-spam)
    conn.lastChatAt = now;

    const data = JSON.stringify({ type: 'reaction', emoji });
    for (const sock of this.conns.keys()) {
      if (sock.readyState === sock.OPEN) sock.send(data);
    }
  }

  // End the current win streak (a reign ended by something other than a win).
  private endStreak() {
    this.streakPid = null;
    this.kingStreak = 0;
  }

  /** Someone wants attention — broadcast to everyone else. */
  ping(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return;
    const data = JSON.stringify({ type: 'ping', from: conn.nickname });
    for (const sock of this.conns.keys()) {
      if (sock !== ws && sock.readyState === sock.OPEN) sock.send(data);
    }
  }

  /** "/ff": a player abandons their paddle mid-match and is publicly shamed for it. */
  forfeit(ws: WebSocket) {
    // Tournament: forfeiting hands the current match to your opponent and advances the bracket.
    if (this.tournament) {
      const conn = this.conns.get(ws);
      if (!conn || !this.sideOf(ws)) return; // only a seated tournament player can forfeit
      this.echoCommand(conn, '/ff');
      this.announce(`Booo, ${conn.nickname} forfeited their match`);
      this.onTournamentParticipantGone(conn.pid);
      return;
    }
    // Arena: forfeiting just vacates your edge (and shames you); the round plays on.
    if (this.mode === 'poly') {
      if (!this.arenaSeats.includes(ws)) return;
      const c = this.conns.get(ws);
      const who = c?.nickname || 'someone';
      if (c) this.echoCommand(c, '/ff');
      this.arenaUnseat(ws);
      this.announce(`Booo, ${who} quit the game`);
      return;
    }
    const side = this.sideOf(ws);
    if (!side) return; // only someone currently holding a paddle can forfeit
    const conn = this.conns.get(ws);
    const name = conn?.nickname || 'someone';
    if (conn) this.echoCommand(conn, '/ff'); // show it in chat before they leave their spot
    if (conn?.pid === this.streakPid) this.endStreak(); // bailing forfeits the reign
    // Vacate the seat, like a quiet leave; the match only drops back to waiting if
    // their whole team is now gone — teammates play on.
    this.unseat(ws);
    if (this.game.status === 'playing' && this.teams[side].length === 0) this.game.toWaiting();
    this.cleanupBotIfAlone(); // no point a bot playing on alone after its opponent bails
    // ...but loudly, so everyone knows.
    this.announce(`Booo, ${name} quit the game`);
  }

  /** Join the spectator queue. */
  queueJoin(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return;
    if (this.tournament) return; // no spectator queue while a bracket is running
    if (this.queue.includes(ws)) return;
    // Don't queue if already holding a paddle
    if (this.sideOf(ws) || this.arenaSeats.includes(ws)) return;
    this.queue.push(ws);
  }

  /** Leave the spectator queue. */
  queueLeave(ws: WebSocket) {
    const i = this.queue.indexOf(ws);
    if (i !== -1) this.queue.splice(i, 1);
  }

  /** Auto-assign queued spectators to open seats (duel sides, or arena edges). */
  private claimFromQueue() {
    if (this.tournament) return; // seats are bracket-controlled during a tournament
    if (this.mode === 'poly') {
      while (this.queue.length > 0 && this.arenaSeats.length < MAX_PLAYERS) {
        const next = this.queue.shift()!;
        const conn = this.conns.get(next);
        if (!conn || !conn.nickname) continue; // stale entry
        this.arenaClaim(next);
      }
      return;
    }
    while (this.queue.length > 0) {
      const openSide = SIDES.find((s) => this.teams[s].length === 0);
      if (!openSide) break;
      const next = this.queue.shift()!;
      const conn = this.conns.get(next);
      if (!conn || !conn.nickname) continue; // stale entry
      this.teams[openSide].push(next);
      conn.role = openSide;
      conn.captured = false;
      this.game.addPlayer(openSide, conn.id);
      this.tell(next, { type: 'you', id: conn.id, role: openSide });
    }
    // Arena armed and the box is full with players still waiting → expand to a polygon.
    if (this.arena && this.queue.length > 0 && this.teams.left.length && this.teams.right.length) {
      this.migrateDuelToPoly();
      this.claimFromQueue(); // now in poly mode — drains the rest onto the edges
    }
  }

  /** Toggle ready state for a player. */
  setReady(ws: WebSocket) {
    if (this.mode === 'poly') return; // arena restarts on its own timer, no ready-up
    const side = this.sideOf(ws);
    if (!side) return;
    if (this.game.status !== 'over') return;
    this.ready[side] = !this.ready[side];
    // Start the ready timer when the first player readies up
    if (this.ready[side] && this.readyTimer <= 0) {
      this.readyTimer = READY_TIMEOUT;
    }
  }

  /** The winner (king) declines to stay — releases their spot. */
  kingExit(ws: WebSocket) {
    if (!this.king || this.king.ws !== ws) return; // only the king can exit
    this.king = null;
    this.endStreak(); // stepping down ends the reign
    this.unseat(ws);
    if (this.game.status === 'over') this.game.toWaiting();
  }

  /** "/powerup [name]": drop a power-up target — the named kind, or random when
   *  unnamed. Spectators only — a player in the current match can't conjure
   *  power-ups for themselves. */
  spawnPowerup(ws: WebSocket, kind?: string) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return; // must have joined
    if (this.sideOf(ws) || this.arenaSeats.includes(ws)) return; // not from a current player
    // Only honor a name we know; anything else falls back to a random kind.
    const k = kind && (POWERUPS as readonly string[]).includes(kind)
      ? (kind as PowerupKind)
      : undefined;
    const placed = this.mode === 'poly' ? this.poly.forceTarget(k) : this.game.forceTarget(k);
    if (placed) this.echoCommand(conn, k ? `/powerup ${k}` : '/powerup');
  }

  /** "Add block": a spectator drops a solid obstacle at a random spot on the live duel
   *  court. Spectators only (a seated player can't junk up their own match), duel mode only. */
  addBlock(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return; // must have joined
    if (this.mode === 'poly') return; // duel-only — the polygon court has no block obstacles
    if (this.sideOf(ws) || this.arenaSeats.includes(ws)) return; // not from a current player
    if (this.game.addBlock()) this.echoCommand(conn, '/block 🧱');
  }

  /** "Add bot": drop an AI opponent into an open duel side. If the requester is an
   *  observer, seat them first so it's a real 1v1 against the bot. Duel mode only. */
  addBot(ws: WebSocket, level: BotLevel) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return;
    if (this.tournament) return; // no bots during a tournament
    if (this.mode === 'poly' || this.arena) return; // bots play the classic duel only
    if (this.game.layered) return; // keep it a clean 1v1
    if (this.bot) return; // one bot at a time
    // Seat the requester on an open side first (so the bot actually has an opponent).
    if (conn.role === 'observer') {
      const openForHuman = SIDES.find((s) => this.teams[s].length === 0);
      if (!openForHuman) return; // both sides taken by humans — no room
      this.claim(ws, openForHuman);
    }
    const botSide = SIDES.find((s) => this.teams[s].length === 0);
    if (!botSide) return; // no open side left for the bot
    this.spawnBot(botSide, level);
    // Both sides manned now — start the match if we were idle.
    if (this.teams.left.length && this.teams.right.length && this.game.status === 'waiting') {
      this.game.start();
    }
    this.refreshPause();
  }

  // --- Co-op DOOM ---
  // A tiny 2-slot lobby + opaque relay. The DOOM game itself runs on the clients
  // (slot 0 is the authority); the server only matchmakes the pair and forwards their
  // messages, so none of the Pong game state is involved.
  private doomSlots: WebSocket[] = [];

  /** Take a slot in the co-op DOOM lobby (max 2). Starts the session once both are filled. */
  doomJoin(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return;
    if (this.doomSlots.includes(ws) || this.doomSlots.length >= 2) return;
    this.doomSlots.push(ws);
    this.broadcastDoomLobby();
  }

  /** Leave the co-op DOOM lobby/game; if a session was live, tell the partner it ended. */
  doomLeave(ws: WebSocket) {
    const i = this.doomSlots.indexOf(ws);
    if (i === -1) return;
    const wasPlaying = this.doomSlots.length === 2;
    this.doomSlots.splice(i, 1);
    if (wasPlaying) {
      for (const other of this.doomSlots) {
        this.tell(other, { type: 'doomEnd', reason: 'Your co-op partner left.' });
      }
      this.doomSlots = [];
    }
    this.broadcastDoomLobby();
  }

  /** Grant the DOOM minion-boss reward (1 win-unit × COIN_SCALE = 100 coins). */
  doomReward(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    addCoins(conn.pid, conn.nickname, COIN_SCALE)
      .then(() => this.sendWallet(ws))
      .catch((e) => console.error('doom reward failed:', e));
  }

  /** Forward an opaque DOOM payload to the co-op partner. */
  doomRelay(ws: WebSocket, data: unknown) {
    if (!this.doomSlots.includes(ws)) return;
    for (const other of this.doomSlots) {
      if (other !== ws) this.tell(other, { type: 'doomRelay', data });
    }
  }

  private broadcastDoomLobby() {
    const status = this.doomSlots.length === 2 ? 'playing' : 'signup';
    this.doomSlots.forEach((ws, i) => {
      this.tell(ws, { type: 'doomLobby', status, filled: this.doomSlots.length, slot: i });
    });
  }

  // DOOM high-round leaderboards (solo + co-op), cached and pushed to clients.
  private doomBoards: { solo: DoomScoreRow[]; coop: DoomScoreRow[] } = { solo: [], coop: [] };
  private campaignBoard: CampaignScoreRow[] = [];

  /** Reload the DOOM leaderboards from the DB and push them to everyone. */
  async refreshDoomLeaderboards() {
    this.doomBoards = await getDoomLeaderboards();
    const msg = JSON.stringify({ type: 'doomLeaderboard', ...this.doomBoards });
    for (const sock of this.conns.keys()) {
      if (sock.readyState === sock.OPEN) sock.send(msg);
    }
  }

  /** Record a finished DOOM run. Solo is keyed per player; co-op is one combined team
   *  entry keyed by the team label (so a pair shares a single row). */
  doomScore(ws: WebSocket, round: number, coop: boolean, name?: string) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    if (!Number.isFinite(round) || round < 1) return;
    const r = Math.floor(round);
    let key: string, label: string;
    if (coop) {
      label = (name ?? '').trim().slice(0, 60);
      if (!label) return; // co-op needs the combined team name
      key = `team:${label.toLowerCase()}`;
    } else {
      key = conn.pid;
      label = conn.nickname;
    }
    recordDoomScore(key, label, coop, r)
      .then(() => this.refreshDoomLeaderboards())
      .catch((e) => console.error('doom score save failed:', e));
  }

  /** Reload the campaign leaderboard from the DB and push it to everyone. */
  async refreshCampaignLeaderboards() {
    this.campaignBoard = await getCampaignLeaderboard();
    const msg = JSON.stringify({ type: 'campaignLeaderboard', rows: this.campaignBoard });
    for (const sock of this.conns.keys()) {
      if (sock.readyState === sock.OPEN) sock.send(msg);
    }
  }

  /** Record a finished campaign run (arcade score = (points scored − points allowed) × 1000,
   *  so a rough loss can go negative). Keyed per player; best score is kept. A first-ever full
   *  clear of Davis grants a one-time 2500-coin bonus. */
  campaignScore(ws: WebSocket, score: number, stage: number, won: boolean) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    if (!Number.isFinite(score)) return;
    if (!Number.isFinite(stage) || stage < 1) return;
    const pid = conn.pid, nick = conn.nickname;
    recordCampaignScore(pid, nick, score, stage, won)
      .then(({ firstClear, firstPerfect }) => {
        this.refreshCampaignLeaderboards();
        if (won) {
          // Clearing the campaign unlocks the "Davis Slayer" title (own it + auto-wear it).
          awardTitle(pid, nick, 'davisslayer')
            .then((w) => { if (w) { const c = this.conns.get(ws); if (c) c.title = w.title; this.sendWallet(ws); this.refreshLeaderboard(); } })
            .catch((e) => console.error('title award failed:', e));
        }
        if (firstClear) {
          addCoins(pid, nick, CAMPAIGN_CLEAR_BONUS)
            .then(() => this.sendWallet(ws))
            .catch((e) => console.error('campaign clear bonus failed:', e));
          this.announce(`🏆 ${nick} cleared Davis Collects — +${CAMPAIGN_CLEAR_BONUS} coins & the Davis Slayer title!`);
        }
        if (firstPerfect) {
          // Flawless run (never conceded a point): one-time 10k-coin jackpot + the "Flawless"
          // title, force-equipped since it outranks Davis Slayer.
          addCoins(pid, nick, CAMPAIGN_PERFECT_BONUS)
            .then(() => this.sendWallet(ws))
            .catch((e) => console.error('campaign perfect bonus failed:', e));
          grantItem(pid, nick, 'flawless')
            .then(() => equipItem(pid, 'title', 'flawless'))
            .then((w) => { if (w) { const c = this.conns.get(ws); if (c) c.title = w.title; this.sendWallet(ws); this.refreshLeaderboard(); } })
            .catch((e) => console.error('flawless title award failed:', e));
          this.announce(`💯 ${nick} got a PERFECT Davis Collects run — +${CAMPAIGN_PERFECT_BONUS} coins & the Flawless title!`);
        }
      })
      .catch((e) => console.error('campaign score save failed:', e));
  }

  /** "Kick bot": remove the AI opponent (any joined player may do this). */
  removeBot(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return;
    this.removeBotInternal();
  }

  // --- Tournament ---

  /** Set up a fresh signup bracket of the given size (4 or 6). */
  tournamentCreate(ws: WebSocket, size: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return;
    if (this.tournament) return; // one at a time
    if (this.mode === 'poly' || this.arena) return; // duel-only feature
    if (size !== 4 && size !== 8) return;
    // Clear the court so signup starts from a clean slate.
    this.removeBotInternal();
    for (const s of SIDES) this.release(s);
    this.king = null;
    this.endStreak();
    if (this.game.status !== 'waiting') this.game.toWaiting();
    this.tournament = new Tournament(size, conn.nickname);
    this.tournamentCreatorPid = conn.pid;
    this.liveMatchId = null;
    this.tourneyInterMs = 0;
    this.announce(`🏆 ${conn.nickname} started a ${size}-player tournament — join a slot!`);
  }

  /** Take the next open signup slot. */
  tournamentJoin(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    const t = this.tournament;
    if (!t || t.status !== 'signup') return;
    if (this.sideOf(ws)) return; // can't be mid-match and in signup
    const taken = new Set(Object.values(t.view(null).countries).map((c) => c.name));
    const available = (WC_COUNTRIES as ReadonlyArray<{ name: string; flag: string }>).filter((c) => !taken.has(c.name));
    const country = available.length > 0 ? available[Math.floor(Math.random() * available.length)] : undefined;
    const p: Participant = { pid: conn.pid, name: conn.nickname, country };
    if (!t.join(p)) return;
    const flagStr = country ? ` ${country.flag} ${country.name}` : '';
    this.announce(`${conn.nickname}${flagStr} joined the tournament (${t.filledCount()}/${t.size})`);
    // Full house → build the bracket and seat the first match.
    if (t.isFull()) {
      t.start();
      this.announce('🏆 Bracket set — let the games begin!');
      this.seatTournamentMatch();
    }
  }

  /** Give up a signup slot. */
  tournamentLeave(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !this.tournament) return;
    this.tournament.leave(conn.pid);
  }

  /** Tear down the current tournament — only the player who created it may do so. */
  tournamentCancel(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !this.tournament) return;
    if (conn.pid !== this.tournamentCreatorPid) return; // only the creator can cancel
    this.endTournament(`Tournament cancelled by ${conn.nickname}.`);
  }

  private endTournament(message?: string) {
    if (!this.tournament) return;
    this.tournament = null;
    this.liveMatchId = null;
    this.tourneyInterMs = 0;
    for (const s of SIDES) this.release(s);
    if (this.game.status !== 'waiting') this.game.toWaiting();
    if (message) this.announce(message);
  }

  private wsOfPid(pid: string): WebSocket | undefined {
    if (!pid) return undefined;
    for (const [ws, c] of this.conns) {
      if (c.pid === pid) return ws;
    }
    return undefined;
  }

  /** Seat the current bracket match's two players into the duel (or resolve walkovers). */
  private seatTournamentMatch() {
    const t = this.tournament;
    if (!t) return;
    for (const s of SIDES) this.release(s);
    this.liveMatchId = null;
    this.overHandled = false;

    let m = t.currentMatch();
    // Resolve any walkovers (a participant who has disconnected) before seating a live match.
    while (m) {
      const ws1 = m.p1 ? this.wsOfPid(m.p1.pid) : undefined;
      const ws2 = m.p2 ? this.wsOfPid(m.p2.pid) : undefined;
      if (ws1 && ws2) break; // a real, playable match
      // One or both players are gone — award the walkover and look at the next match.
      if (m.p1 && !ws1 && m.p2) t.reportWinner(m.id, m.p2.pid);
      else if (m.p2 && !ws2 && m.p1) t.reportWinner(m.id, m.p1.pid);
      else if (m.p1 && !ws1) t.forfeitPid(m.p1.pid);
      else if (m.p2 && !ws2) t.forfeitPid(m.p2.pid);
      m = t.currentMatch();
    }

    if (!m) {
      // No playable match left. Either the bracket finished or everyone bailed.
      if (t.status === 'done') {
        this.announce(`🏆 ${t.champion?.name ?? 'Someone'} wins the tournament!`);
      } else {
        this.endTournament('Tournament ended — not enough players left.');
      }
      return;
    }

    const ws1 = this.wsOfPid(m.p1!.pid)!;
    const ws2 = this.wsOfPid(m.p2!.pid)!;
    this.seatFor(ws1, 'left');
    this.seatFor(ws2, 'right');
    this.liveMatchId = m.id;
    this.game.start(); // paused until both capture their mouse (refreshPause handles it)
    this.announce(`🏆 Now playing: ${m.p1!.name} vs ${m.p2!.name}`);
  }

  /** Force-seat a specific connection on a side (used by the tournament seater). */
  private seatFor(ws: WebSocket, side: Side) {
    const conn = this.conns.get(ws);
    if (!conn) return;
    conn.role = side;
    conn.captured = false;
    this.teams[side].push(ws);
    this.game.addPlayer(side, conn.id);
    this.tell(ws, { type: 'you', id: conn.id, role: side });
  }

  /** Tournament bookkeeping each tick: advance the bracket when a match ends. */
  private tournamentSync() {
    const t = this.tournament;
    if (!t || t.status === 'signup') return; // signup just waits for joins
    if (this.game.status !== 'over') return;

    if (!this.overHandled) {
      this.overHandled = true;
      const winnerSide = this.game.winnerSide;
      const loserSide: Side | null = winnerSide ? (winnerSide === 'left' ? 'right' : 'left') : null;
      const winners = winnerSide ? this.connsOn(winnerSide) : [];
      const losers = loserSide ? this.connsOn(loserSide) : [];
      this.winnerName = winners.length ? winners[0].nickname : null;
      if (this.liveMatchId !== null && winners[0]?.pid) {
        t.reportWinner(this.liveMatchId, winners[0].pid);
      }
      // Tournament games are real 1v1s — count them for the leaderboard.
      const winRefs = winners.filter((c) => c.pid).map((c) => ({ pid: c.pid, name: c.nickname }));
      const loseRefs = losers.filter((c) => c.pid).map((c) => ({ pid: c.pid, name: c.nickname }));
      if (winRefs.length && loseRefs.length) {
        recordResult(winRefs, loseRefs)
          .then(() => { this.refreshLeaderboard(); this.refreshWalletsFor(winners); })
          .catch((e) => console.error('leaderboard update failed:', e));
      }
      this.settleBets(winnerSide); // pay out spectator wagers on this match
      // Winning the championship pays 100 coins per player in the field (400 or 800),
      // plus a free bonus wheel spin (usable even while the daily spin is on cooldown).
      if (t.status === 'done' && winners[0]?.pid) {
        const champ = winners[0];
        const prize = t.size * COIN_SCALE;
        Promise.all([
          addCoins(champ.pid, champ.nickname, prize),
          addBonusSpin(champ.pid, champ.nickname),
        ])
          .then(() => this.refreshWalletsFor([champ]))
          .catch((e) => console.error('tournament prize failed:', e));
        const champCountry = t.view(null).countries[champ.nickname];
        const champFlag = champCountry ? ` ${champCountry.flag}` : '';
        this.announce(`⚽🏆 ${champ.nickname}${champFlag} wins the World Cup — ${prize} coins + a bonus spin!`);
      }
      // Hold the champion screen longer than a between-match break, then tear down.
      this.tourneyInterMs = t.status === 'done' ? TOURNEY_DONE_MS : TOURNEY_INTER_MS;
      return;
    }

    // Counting down: either to the next match, or to the end of the whole tournament.
    this.tourneyInterMs -= TICK_MS;
    if (this.tourneyInterMs <= 0) {
      if (t.status === 'done') {
        this.endTournament(`🏆 ${t.champion?.name ?? 'Someone'} is the champion!`);
      } else {
        this.seatTournamentMatch();
      }
    }
  }

  /** A participant disconnected or forfeited — advance their opponent and re-seat if needed. */
  private onTournamentParticipantGone(pid: string) {
    const t = this.tournament;
    if (!t) return;
    if (t.status === 'signup') {
      t.leave(pid);
      return;
    }
    if (t.status !== 'active') return;
    // Is this player in the match currently on the court?
    const seatedWs = this.wsOfPid(pid);
    const wasLive =
      this.liveMatchId !== null && !!seatedWs &&
      (this.teams.left.includes(seatedWs) || this.teams.right.includes(seatedWs));
    t.forfeitPid(pid);
    if (wasLive) {
      // The live match is now decided by walkover — drop it and seat the next one.
      this.winnerName = null;
      this.seatTournamentMatch();
    }
  }

  // Seat a synthetic bot connection on a side and start steering its paddle.
  private spawnBot(side: Side, level: BotLevel) {
    const ws = makeBotSocket();
    const conn: Conn = {
      id: String(this.nextId++),
      pid: '', // no leaderboard identity — a match with a bot never counts
      nickname: BOT_NAMES[level],
      role: side,
      color: BOT_COLOR,
      captured: true, // the bot is always "ready"; only the human must capture their mouse
      captureDeadline: 0,
      lastChatAt: 0,
      hat: null,
      skin: null,
      trail: null,
      title: null,
    };
    this.conns.set(ws, conn);
    this.teams[side].push(ws);
    this.game.addPlayer(side, conn.id);
    this.bot = { ws, side, id: conn.id, level, reactTimer: 0, aimY: COURT.h / 2 };
  }

  // Tear the bot out of its seat. A bot leaving never crowns a king and never leaves the
  // duel frozen on an 'over' screen — it always returns the room to a clean waiting state.
  private removeBotInternal() {
    if (!this.bot) return;
    const { ws, side, id } = this.bot;
    this.bot = null;
    this.botOverTimer = 0;
    this.teams[side] = this.teams[side].filter((s) => s !== ws);
    this.game.removePlayer(side, id);
    this.conns.delete(ws);
    this.king = null;
    if (this.game.status !== 'waiting') {
      this.overHandled = false;
      this.winnerName = null;
      this.game.toWaiting();
    }
    this.refreshPause();
    this.claimFromQueue();
  }

  // Remove the bot if no human is seated alongside it anymore (its opponent left/forfeited).
  private cleanupBotIfAlone() {
    if (!this.bot) return;
    const humanSeated = SIDES.some((s) =>
      this.teams[s].some((ws) => ws !== this.bot!.ws && this.conns.has(ws)),
    );
    if (!humanSeated) this.removeBotInternal();
  }

  // Drive the bot's paddle: re-aim on its reaction clock, then steer toward that aim.
  private steerBot(dt: number) {
    if (!this.bot) return;
    if (this.game.status !== 'playing' || this.game.paused) return;
    const cfg = BOT_CFG[this.bot.level];
    this.bot.reactTimer -= dt;
    if (this.bot.reactTimer <= 0) {
      this.bot.reactTimer = cfg.react;
      this.bot.aimY = this.botAim(this.bot.side, cfg);
    }
    this.game.setTarget(this.bot.side, this.bot.id, this.bot.aimY);
  }

  // Where the bot wants its paddle. It only chases a ball heading its way (else it idles);
  // a hard bot predicts the wall-bounced landing point, easier bots track the raw Y. A
  // random error keeps every level beatable (bigger for easier bots).
  private botAim(side: Side, cfg: BotCfg): number {
    const ball = this.game.ball;
    const approaching = side === 'left' ? ball.vx < 0 : ball.vx > 0;
    if (!approaching) return cfg.idleCenter ? COURT.h / 2 : ball.y;
    const faceX = this.game.paddleX[side];
    const aim = cfg.predict ? botPredictY(ball, faceX) : ball.y;
    return aim + (Math.random() * 2 - 1) * cfg.error;
  }

  join(ws: WebSocket, nickname: string, pid: string, color?: string) {
    const conn = this.conns.get(ws);
    if (!conn) return;
    conn.pid = pid.slice(0, 64);
    conn.nickname = nickname.slice(0, 20).trim() || 'anon';
    if (color) conn.color = color;
    // Reclaim a seat / king / queue spot this identity held before a restart, if any.
    this.reattach(ws, conn);
    // If this identity already has a leaderboard record, reflect the (possibly new)
    // display name right away — a rename shows on the board without playing again.
    updateName(conn.pid, conn.nickname)
      .then((changed) => {
        if (changed) this.refreshLeaderboard();
      })
      .catch((e) => console.error('name update failed:', e));
    // Load this player's wallet/cosmetics and push it to them.
    this.loadWallet(ws);
    // Send the stock market: global price board + this player's positions.
    this.sendStocks(ws);
    // Send their loan status (so the Get Loan panel knows whether they owe Davis).
    this.sendLoan(ws);
    // Send the active-bounties board so heads show their pot right away.
    this.sendBounties(ws);
  }

  /** Load a connection's wallet from the DB into memory and send it to that client. */
  private loadWallet(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid) return;
    getWallet(conn.pid)
      .then((w) => {
        const c = this.conns.get(ws);
        if (!c) return;
        c.hat = w.hat;
        c.skin = w.skin;
        c.trail = w.trail;
        c.title = w.title;
        this.tell(ws, { type: 'wallet', coins: w.coins, owned: w.owned, hat: w.hat, skin: w.skin, trail: w.trail, title: w.title, bets: this.betsView(ws), nextSpinAt: nextSpinAt(w.lastSpin), bonusSpins: w.bonusSpins });
      })
      .catch((e) => console.error('wallet load failed:', e));
  }

  /** Push the freshest wallet (re-read from DB) to a client; also refreshes cached cosmetics. */
  sendWallet(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid) return;
    getWallet(conn.pid)
      .then((w) => {
        const c = this.conns.get(ws);
        if (!c) return;
        c.hat = w.hat; c.skin = w.skin; c.trail = w.trail; c.title = w.title;
        this.tell(ws, { type: 'wallet', coins: w.coins, owned: w.owned, hat: w.hat, skin: w.skin, trail: w.trail, title: w.title, bets: this.betsView(ws), nextSpinAt: nextSpinAt(w.lastSpin), bonusSpins: w.bonusSpins });
      })
      .catch((e) => console.error('wallet send failed:', e));
  }

  /** Re-send wallets to a set of connections (e.g. winners who just earned a coin). */
  private refreshWalletsFor(conns: Conn[]) {
    for (const c of conns) {
      const ws = this.wsOfConn(c);
      if (ws) this.sendWallet(ws);
    }
  }
  private wsOfConn(conn: Conn): WebSocket | undefined {
    for (const [ws, c] of this.conns) if (c === conn) return ws;
    return undefined;
  }

  /** "/tip <name> <amount>": gift coins to another player — online or not. The transfer is
   *  atomic (the sender's coins are escrowed first; a failed debit gifts nothing), then the
   *  whole room gets a cha-ching + coin shower so tipping feels good and public. An offline
   *  recipient is looked up in the DB by name; the coins are waiting when they next sign in. */
  tip(ws: WebSocket, toName: string, amount: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    const amt = Math.floor(amount);
    if (!Number.isFinite(amt) || amt <= 0) { this.notify(ws, 'Tip must be a positive number of coins.'); return; }
    if (amt > MAX_TIP) { this.notify(ws, `You can tip at most ${MAX_TIP.toLocaleString()} coins at once.`); return; }
    const display = toName.trim();
    if (!display) { this.notify(ws, 'Who do you want to tip? Try /tip <name> <amount>.'); return; }

    // Resolve the recipient by nickname (case-insensitive): prefer a live connection so the
    // coins land instantly, otherwise fall back to a DB lookup so even offline players can be
    // tipped. Either way they're identified by a stable pid that isn't the tipper's own.
    const target = display.toLowerCase();
    const online = [...this.conns.values()].find(
      (c) => c.nickname && c.pid && c.pid !== conn.pid && c.nickname.toLowerCase() === target,
    );

    const resolve: Promise<{ pid: string; name: string } | null> = online
      ? Promise.resolve({ pid: online.pid, name: online.nickname })
      : findPlayerByName(display);

    resolve
      .then(async (recip) => {
        if (!recip) { this.notify(ws, `No player named "${display}" to tip.`); return; }
        if (recip.pid === conn.pid) { this.notify(ws, "You can't tip yourself."); return; }
        // Escrow the sender's coins first; bail untouched if they can't afford it (or there's no DB).
        const w = await spendCoins(conn.pid, amt);
        if (!w) { this.notify(ws, "You don't have enough coins for that tip."); this.sendWallet(ws); return; }
        await addCoins(recip.pid, recip.name, amt);
        // Refresh the tipper's wallet, plus any tab the recipient has open, and the net-worth board.
        this.sendWallet(ws);
        this.refreshWalletsFor([...this.conns.values()].filter((c) => c.pid === recip.pid));
        this.refreshNetWorth().catch((e) => console.error('net worth update failed:', e));
        // Celebrate it room-wide: a chat line + the coin-shower/cha-ching broadcast.
        this.echoCommand(conn, `/tip ${recip.name} ${amt}`);
        const data = JSON.stringify({ type: 'tip', from: conn.nickname, to: recip.name, amount: amt });
        for (const sock of this.conns.keys()) {
          if (sock.readyState === sock.OPEN) sock.send(data);
        }
      })
      .catch((e) => console.error('tip failed:', e));
  }

  // --- Bounties ---

  /** Push the active-bounties board to one client. */
  private sendBounties(ws: WebSocket) {
    getBounties()
      .then((list) => { if (this.conns.has(ws)) this.tell(ws, { type: 'bounties', list: list.map((b) => ({ name: b.name, pot: b.pot })) }); })
      .catch((e) => console.error('bounties send failed:', e));
  }

  /** Refresh the bounties board for everyone (after a placement or payout). */
  private broadcastBounties() {
    getBounties()
      .then((list) => {
        const data = JSON.stringify({ type: 'bounties', list: list.map((b) => ({ name: b.name, pot: b.pot })) });
        for (const sock of this.conns.keys()) if (sock.readyState === sock.OPEN) sock.send(data);
      })
      .catch((e) => console.error('bounties broadcast failed:', e));
  }

  /** Put coins on a player's head. The pot is escrowed from the placer immediately; whoever
   *  beats that player in a duel next collects the whole thing (see the payout in onGameOver).
   *  Mirrors /tip: target resolved by nickname (online first, then DB), can't bounty yourself. */
  placeBounty(ws: WebSocket, toName: string, amount: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    const amt = Math.floor(amount);
    if (!Number.isFinite(amt) || amt <= 0) { this.notify(ws, 'A bounty must be a positive number of coins.'); return; }
    if (amt > MAX_BOUNTY) { this.notify(ws, `A bounty can be at most ${MAX_BOUNTY.toLocaleString()} coins at once.`); return; }
    const display = toName.trim();
    if (!display) { this.notify(ws, 'Who do you want to put a bounty on?'); return; }

    const target = display.toLowerCase();
    const online = [...this.conns.values()].find(
      (c) => c.nickname && c.pid && c.pid !== conn.pid && c.nickname.toLowerCase() === target,
    );
    const resolve: Promise<{ pid: string; name: string } | null> = online
      ? Promise.resolve({ pid: online.pid, name: online.nickname })
      : findPlayerByName(display);

    resolve
      .then(async (recip) => {
        if (!recip) { this.notify(ws, `No player named "${display}" to bounty.`); return; }
        if (recip.pid === conn.pid) { this.notify(ws, "You can't put a bounty on yourself."); return; }
        // Escrow the placer's coins first; bail untouched if they can't afford it.
        const w = await spendCoins(conn.pid, amt);
        if (!w) { this.notify(ws, "You don't have enough coins for that bounty."); this.sendWallet(ws); return; }
        const pot = await addBounty(recip.pid, recip.name, amt);
        this.sendWallet(ws);
        this.refreshNetWorth().catch((e) => console.error('net worth update failed:', e));
        this.echoCommand(conn, `/bounty ${recip.name} ${amt}`);
        this.announce(`🎯 ${conn.nickname} put ${amt.toLocaleString()}🪙 on ${recip.name}'s head — pot is now ${pot.toLocaleString()}🪙! Beat them to claim it.`);
        this.broadcastBounties();
      })
      .catch((e) => console.error('bounty failed:', e));
  }

  /** Pay out any bounty on a beaten player to the duel's winner, then clear it. Called once per
   *  match from the over-handler. Only a clean 1v1 result (one winner, one loser) collects. */
  private settleBounty(winners: Conn[], losers: Conn[]) {
    if (winners.length !== 1 || losers.length !== 1) return; // bounties are a heads-up affair
    const winner = winners[0];
    const loser = losers[0];
    if (!winner.pid || !loser.pid || winner.pid === loser.pid) return;
    getBountyOn(loser.pid)
      .then(async (pot) => {
        if (pot <= 0) return;
        await clearBounty(loser.pid);
        await addCoins(winner.pid, winner.nickname, pot);
        this.refreshWalletsFor([winner]);
        this.refreshNetWorth().catch((e) => console.error('net worth update failed:', e));
        this.announce(`🎯 ${winner.nickname} collected the ${pot.toLocaleString()}🪙 bounty on ${loser.nickname}!`);
        const data = JSON.stringify({ type: 'bountyHit', winner: winner.nickname, target: loser.nickname, amount: pot });
        for (const sock of this.conns.keys()) if (sock.readyState === sock.OPEN) sock.send(data);
        this.broadcastBounties();
      })
      .catch((e) => console.error('bounty payout failed:', e));
  }

  // --- Shop (cosmetics) ---

  /** Buy a cosmetic from the shop, spending coins. Cosmetics are visual-only. */
  shopBuy(ws: WebSocket, item: string) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    const cosmetic = COSMETICS.find((c) => c.id === item);
    if (!cosmetic || cosmetic.locked) return; // locked items (e.g. Davis Slayer) can't be bought
    buyItem(conn.pid, conn.nickname, cosmetic.id, cosmetic.price)
      .then((w) => { if (w) this.sendWallet(ws); })
      .catch((e) => console.error('shop buy failed:', e));
  }

  /** Equip (item) or unequip (null) a cosmetic in its slot. */
  shopEquip(ws: WebSocket, slot: 'hat' | 'skin' | 'trail' | 'title', item: string | null) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    if (item !== null) {
      const cosmetic = COSMETICS.find((c) => c.id === item);
      if (!cosmetic || cosmetic.slot !== slot) return; // item must exist and match the slot
    }
    equipItem(conn.pid, slot, item)
      .then((w) => {
        if (!w) return;
        const c = this.conns.get(ws);
        if (c) { c.hat = w.hat; c.skin = w.skin; c.trail = w.trail; c.title = w.title; }
        this.sendWallet(ws);
        if (slot === 'title') this.refreshLeaderboard(); // title shows on the board
      })
      .catch((e) => console.error('shop equip failed:', e));
  }

  // --- Daily spin (one reward every 24h) ---

  /** Claim a spin. Bonus spins (from tournament wins) are consumed first and bypass the
   *  24h cooldown; otherwise the daily spin is atomically gated to once per 24h. Rolls a
   *  weighted wheel segment — odds decrease as value increases (1/2/3/5/10/20 coins, hat, skin). */
  dailySpin(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    const pid = conn.pid, nick = conn.nickname;
    // Spend a bonus spin if one is banked; only fall back to the daily 24h claim otherwise.
    useBonusSpin(pid)
      .then(async (usedBonus) => {
        if (!usedBonus) {
          const ok = await claimSpin(pid, nick, Date.now());
          if (!ok) { this.sendWallet(ws); return; } // not available yet (or no DB)
        }
        const owned = (await getWallet(conn.pid)).owned;
        const hasUnowned = (slot: 'hat' | 'skin') => COSMETICS.some((c) => c.slot === slot && !owned.includes(c.id));
        // Weights index-aligned to SPIN_SEGMENTS [1,2,3,5,10,20,hat,skin]; rarer as value rises.
        const weights = [36, 24, 16, 11, 6, 2, 3, 2];
        // Drop a cosmetic segment if the player already owns everything in that slot.
        if (!hasUnowned('hat')) weights[6] = 0;
        if (!hasUnowned('skin')) weights[7] = 0;
        const total = weights.reduce((a, b) => a + b, 0);
        let roll = Math.random() * total;
        let seg = 0;
        for (let i = 0; i < weights.length; i++) { roll -= weights[i]; if (roll < 0) { seg = i; break; } }
        const def = SPIN_SEGMENTS[seg];
        if (def.kind === 'coins') {
          await addCoins(conn.pid, conn.nickname, def.value);
          this.tell(ws, { type: 'spinResult', segment: seg, reward: { kind: 'coins', amount: def.value } });
        } else {
          const avail = COSMETICS.filter((c) => c.slot === def.kind && !owned.includes(c.id));
          const item = avail[Math.floor(Math.random() * avail.length)];
          await grantItem(conn.pid, conn.nickname, item.id);
          this.tell(ws, { type: 'spinResult', segment: seg, reward: { kind: 'item', item: item.id, name: item.name } });
        }
        this.sendWallet(ws);
      })
      .catch((e) => console.error('daily spin failed:', e));
  }

  // --- Roulette (casino wheel) ---

  /** Settle one spin of the roulette wheel. Validates the bets, escrows the total stake,
   *  rolls a single-zero (0–36) wheel, pays back the stake + winnings on every winning bet,
   *  and reports the landing number + payout so the client can land its wheel and celebrate. */
  roulette(ws: WebSocket, bets: RouletteBet[]) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    // Validate the slate: a sane number of well-formed bets, total within the cap.
    if (!Array.isArray(bets) || bets.length === 0 || bets.length > 60) { this.sendWallet(ws); return; }
    let total = 0;
    for (const b of bets) {
      if (!b || typeof b.amount !== 'number' || !Number.isInteger(b.amount) || b.amount <= 0) { this.sendWallet(ws); return; }
      if (!(b.kind in ROULETTE_PAYOUTS)) { this.sendWallet(ws); return; }
      if (b.kind === 'straight' &&
          (typeof b.number !== 'number' || !Number.isInteger(b.number) || b.number < 0 || b.number > 36)) {
        this.sendWallet(ws); return;
      }
      total += b.amount;
    }
    if (total <= 0 || total > ROULETTE_MAX_TOTAL) { this.sendWallet(ws); return; }
    // Escrow the whole stake up front; if it doesn't clear, the player can't afford it.
    spendCoins(conn.pid, total)
      .then(async (w) => {
        if (!w) { this.sendWallet(ws); return; } // insufficient coins (or no DB) — nothing wagered
        const win = Math.floor(Math.random() * 37); // 0–36, single zero
        let payout = 0;
        for (const b of bets) {
          if (rouletteWins(b, win)) payout += b.amount * (ROULETTE_PAYOUTS[b.kind as RouletteBetKind] + 1);
        }
        if (payout > 0) await addCoins(conn.pid, conn.nickname, payout);
        this.tell(ws, { type: 'rouletteResult', number: win, staked: total, payout });
        this.sendWallet(ws);
      })
      .catch((e) => console.error('roulette failed:', e));
  }

  // --- Stock market ---

  /** Hydrate the global price board + the next-crash schedule from the DB (call once after
   *  initDb). No-op on prices without a DB; the crash is still scheduled in memory. */
  async loadStockPrices() {
    const saved = await getStockPrices();
    const savedHist = await getStockHistory().catch(() => ({} as Record<string, { '5m': number[]; '1h': number[]; '1d': number[] }>));
    for (const s of STOCKS) {
      const row = saved[s.id];
      if (row && row.price > 0) this.stockPrices.set(s.id, { price: row.price, prev: row.prev });
      // Restore the graph history from the DB so the graphs survive restarts; if there's none (or
      // it's unusable), seed each series with the single resumed price so a graph is never empty.
      const seed = this.stockPrices.get(s.id)?.price ?? s.base;
      const h = savedHist[s.id];
      for (const tf of ['5m', '1h', '1d'] as const) {
        const arr = Array.isArray(h?.[tf]) ? h![tf].filter((n) => typeof n === 'number' && Number.isFinite(n)) : [];
        const capped = arr.slice(-STOCK_HISTORY[tf].cap);
        this.stockHist[tf].set(s.id, capped.length ? capped : [seed]);
      }
    }
    // The collection fires at the next 5pm ET — a deterministic time — so just (re)book it on
    // boot rather than resuming a stored timestamp. Then pull any open loan still booked under the
    // old rolling-24h deadline back to this 5pm, so existing loans show the correct countdown too.
    this.scheduleNextCollect();
    realignLoansToDeadline(this.nextStockCrashAt).catch((e) => console.error('loan deadline realign failed:', e));
    // Resume the instability pool so the stability bar (and crash trigger) survive restarts.
    this.marketInstability = await getMarketInstability().catch(() => 0);
  }

  /** Book the next daily loan-collection event — the next 5:00pm America/New_York — and persist it. */
  private scheduleNextCollect() {
    this.nextStockCrashAt = nextFivePmEtMs(Date.now());
    setStockCrashAt(this.nextStockCrashAt).catch((e) => console.error('collection schedule save failed:', e));
  }

  /** The stability pool as a 0–100% reading of MARKET_INSTABILITY_THRESHOLD (for announcements). */
  private stabilityPct(): number {
    return Math.min(100, Math.round((this.marketInstability / MARKET_INSTABILITY_THRESHOLD) * 100));
  }

  /** Market crash: every coin snaps back to its base price. Holdings are left untouched — they
   *  simply revalue at the new price (worth = floor(shares × base)) — so a crash wipes the gains.
   *  Pure price effect; the caller handles scheduling, the instability pool, and announcing. */
  private resetMarket() {
    for (const s of STOCKS) {
      const cur = this.stockPrices.get(s.id) ?? { price: s.base, prev: s.base };
      this.stockPrices.set(s.id, { price: s.base, prev: cur.price }); // prev = pre-crash price, so the drop shows
    }
    this.nextStockUpdateAt = Date.now() + STOCK_UPDATE_MS; // give the fresh prices a full window
    this.recordStockHistory(); // the crash itself is a history point (the cliff edge)
    saveStockPrices(this.priceBoard()).catch((e) => console.error('stock price save failed:', e));
    saveStockHistory(this.historyBoard()).catch((e) => console.error('stock history save failed:', e));
  }

  /** The daily event (replaces the old fixed daily reset): Davis collects on every overdue loan,
   *  and each defaulter's unpaid 1.5× debt is added to the market-instability pool. The market no
   *  longer resets on a timer — it crashes for EVERYONE only once the pool fills the threshold, at
   *  which point the pool resets to 0. Books the next event, then refreshes/announces and repushes. */
  private runDailyCollection() {
    this.scheduleNextCollect(); // book the next daily event immediately (so we never re-fire next tick)
    collectDefaultedLoans(Date.now())
      .then(({ pids, totalOwed }) => {
        // Refresh + notify any defaulter still online (wallet/stocks/loan all just changed).
        const hit = new Set(pids);
        for (const ws of this.conns.keys()) {
          const conn = this.conns.get(ws);
          if (!conn?.pid || !hit.has(conn.pid)) continue;
          this.sendWallet(ws);
          this.sendStocks(ws);
          this.sendLoan(ws);
          this.notify(ws, `🕶️ Davis came to collect — you didn't repay, so he took everything. Bad day to be an Excel spreadsheet.`);
        }
        // Defaulted debt destabilizes the market for everyone.
        if (totalOwed > 0) {
          this.marketInstability += totalOwed;
          setMarketInstability(this.marketInstability).catch((e) => console.error('instability save failed:', e));
          this.announce(`💸 Davis collected ${Math.round(totalOwed)}🪙 in unpaid loans — market stability is at ${this.stabilityPct()}%.`);
        }
        // Crash only when the pool fills — this is now the sole market-reset trigger.
        if (this.marketInstability >= MARKET_INSTABILITY_THRESHOLD) {
          this.resetMarket();
          this.marketInstability = 0;
          setMarketInstability(0).catch((e) => console.error('instability save failed:', e));
          this.announce('🔄 MARKET CRASH — unpaid loans hit 100% instability! Every coin is back to base 🪙. Holdings revalued, stability reset. Fresh start!');
        }
        for (const ws of this.conns.keys()) this.sendStocks(ws);
        // Wallets zeroed, holdings wiped, maybe a full crash — the net-worth board moved a lot.
        this.refreshNetWorth().catch((e) => console.error('net worth update failed:', e));
      })
      .catch((e) => console.error('daily collection failed:', e));
  }

  /** The global price board, in STOCKS order. */
  private priceBoard(): { id: string; price: number; prev: number }[] {
    return STOCKS.map((s) => {
      const p = this.stockPrices.get(s.id) ?? { price: s.base, prev: s.base };
      return { id: s.id, price: p.price, prev: p.prev };
    });
  }

  /** The per-coin graph history (all three timeframes), in STOCKS order. */
  private historyBoard(): { id: string; series: { '5m': number[]; '1h': number[]; '1d': number[] } }[] {
    return STOCKS.map((s) => ({
      id: s.id,
      series: {
        '5m': this.stockHist['5m'].get(s.id) ?? [],
        '1h': this.stockHist['1h'].get(s.id) ?? [],
        '1d': this.stockHist['1d'].get(s.id) ?? [],
      },
    }));
  }

  /** Record the current price into each graph series (call once per re-roll / reset). Each
   *  timeframe samples at its own cadence: 5m every tick, 1h every 4, 1d every 60. */
  private recordStockHistory() {
    this.stockHistTick++;
    for (const tf of ['5m', '1h', '1d'] as const) {
      if (this.stockHistTick % STOCK_HISTORY[tf].everyTicks !== 0) continue;
      const cap = STOCK_HISTORY[tf].cap;
      const map = this.stockHist[tf];
      for (const s of STOCKS) {
        const price = this.stockPrices.get(s.id)?.price ?? s.base;
        const arr = map.get(s.id) ?? [];
        arr.push(price);
        while (arr.length > cap) arr.shift();
        map.set(s.id, arr);
      }
    }
  }

  /** Send a client the price board, its own positions (revalued live), and graph history. */
  sendStocks(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid) return;
    const prices = this.priceBoard();
    const history = this.historyBoard();
    getHoldings(conn.pid)
      .then((h) => {
        if (!this.conns.has(ws)) return;
        const holdings = h.map((hd) => {
          const price = this.stockPrices.get(hd.coin)?.price ?? 0;
          return { id: hd.coin, side: hd.side, shares: hd.shares, cost: hd.cost, worth: Math.floor(positionWorth(hd.side, hd.shares, hd.cost, price)) };
        });
        this.tell(ws, {
          type: 'stocks', prices, holdings, history, nextUpdateAt: this.nextStockUpdateAt,
          stability: { unpaid: this.marketInstability, threshold: MARKET_INSTABILITY_THRESHOLD },
        });
      })
      .catch((e) => console.error('stocks send failed:', e));
  }

  /** Open a long or short position in a crypto at its current price. Coins are escrowed. */
  stockInvest(ws: WebSocket, coin: string, amount: number, side: StockSide) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    if (!STOCKS.some((s) => s.id === coin)) return; // unknown coin
    const amt = Math.floor(amount);
    if (!Number.isFinite(amt) || amt < 1) return; // positive whole coins only
    const price = this.stockPrices.get(coin)?.price;
    if (!price || !(price > 0)) return;
    investStock(conn.pid, conn.nickname, coin, amt, price, side)
      .then((w) => {
        if (!w) { this.sendStocks(ws); return; } // couldn't afford — just refresh the view
        this.sendStocks(ws);
        this.sendWallet(ws);
      })
      .catch((e) => console.error('stock invest failed:', e));
  }

  /** Close the whole long or short position in a crypto for round(current worth) coins. */
  stockCashOut(ws: WebSocket, coin: string, side: StockSide) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    if (!STOCKS.some((s) => s.id === coin)) return;
    const price = this.stockPrices.get(coin)?.price;
    if (!price || !(price > 0)) return;
    cashOutStock(conn.pid, conn.nickname, coin, price, side)
      .then((res) => {
        if (!res) { this.sendStocks(ws); return; } // held nothing on that side
        this.sendStocks(ws);
        this.sendWallet(ws);
      })
      .catch((e) => console.error('stock cash-out failed:', e));
  }

  // --- Davis's loans ---

  /** Push a client their current loan status (null = no debt). */
  private sendLoan(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid) return;
    getLoan(conn.pid)
      .then((loan) => { if (this.conns.has(ws)) this.tell(ws, { type: 'loan', loan }); })
      .catch((e) => console.error('loan send failed:', e));
  }

  /** Borrow `amount` coins from Davis, due (at 1.5×) by the next daily 5pm collection. */
  getLoanFor(ws: WebSocket, amount: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    const amt = Math.floor(amount);
    if (!Number.isFinite(amt) || amt < 1) return; // positive whole coins only
    // Deadline is the next daily 5pm collection; if one somehow isn't booked, compute it directly.
    const dueAt = this.nextStockCrashAt || nextFivePmEtMs(Date.now());
    takeLoan(conn.pid, conn.nickname, amt, dueAt)
      .then((res) => {
        if (!res) { this.sendLoan(ws); return; } // already had a loan / rejected — just refresh
        this.sendWallet(ws);
        this.sendLoan(ws);
        this.refreshNetWorth().catch((e) => console.error('net worth update failed:', e));
        this.notify(ws, `💸 Davis fronted you ${amt}🪙 — bring back ${res.loan.owed}🪙 by 5pm. Miss it and the market takes the hit. Keep grinding.`);
      })
      .catch((e) => console.error('loan failed:', e));
  }

  /** Repay Davis the full 1.5× owed and clear the loan. */
  repayLoanFor(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    repayLoan(conn.pid)
      .then((res) => {
        if (!res) { this.sendWallet(ws); this.sendLoan(ws); return; } // no loan or couldn't afford it
        this.sendWallet(ws);
        this.sendLoan(ws);
        this.refreshNetWorth().catch((e) => console.error('net worth update failed:', e));
        this.notify(ws, `🤝 Loan settled. Davis respects the hustle.`);
      })
      .catch((e) => console.error('loan repay failed:', e));
  }

  /** Re-roll every coin's price when the re-roll window elapses, persist the board, and push
   *  the fresh (revalued) market to every connected client. Also fires the daily loan-collection
   *  event when its time arrives. Cheap to call every tick. */
  private tickStocks() {
    // The daily collection takes precedence (it may crash + repush the market itself), so handle
    // it first and bail.
    if (this.nextStockCrashAt && Date.now() >= this.nextStockCrashAt) {
      this.runDailyCollection();
      return;
    }
    if (Date.now() < this.nextStockUpdateAt) return;
    this.nextStockUpdateAt = Date.now() + STOCK_UPDATE_MS;
    for (const s of STOCKS) {
      const cur = this.stockPrices.get(s.id) ?? { price: s.base, prev: s.base };
      this.stockPrices.set(s.id, { price: rollPrice(cur.price, s.base), prev: cur.price });
    }
    this.recordStockHistory();
    saveStockPrices(this.priceBoard()).catch((e) => console.error('stock price save failed:', e));
    saveStockHistory(this.historyBoard()).catch((e) => console.error('stock history save failed:', e));
    for (const ws of this.conns.keys()) this.sendStocks(ws);
    // Holdings just revalued, so the net-worth standings shifted too.
    this.refreshNetWorth().catch((e) => console.error('net worth update failed:', e));
  }

  // --- Gambling ---

  /** Public view of all current wagers, grouped by side (for the on-screen bet board). */
  private betBoard(): StateMsg['bets'] {
    const board: StateMsg['bets'] = { left: [], right: [] };
    for (const b of this.bets) board[b.side].push({ name: b.name, amount: b.amount });
    return board;
  }

  /** A spectator's own open wagers (with locked odds), for their wallet view. */
  private betsView(ws: WebSocket): WalletMsg['bets'] {
    const conn = this.conns.get(ws);
    if (!conn) return [];
    return this.bets
      .filter((b) => b.pid === conn.pid)
      .map((b) => ({ side: b.side, amount: b.amount, odds: b.odds }));
  }

  /** Recompute the per-point win probability from the seated players' blended Elo. Run once when
   *  a duel starts; until it resolves (and whenever the DB is unavailable) odds stay even. */
  private async refreshOddsModel(): Promise<void> {
    const pidsOf = (side: Side) =>
      this.connsOn(side).map((c) => c.pid).filter((p): p is string => !!p);
    const leftPids = pidsOf('left');
    const rightPids = pidsOf('right');
    const winScore = this.game.winScore;
    try {
      const elos = await getElos([...leftPids, ...rightPids]);
      const sideElo = (pids: string[]) => {
        if (pids.length === 0) return 500;
        const blended = pids.map((pid) => {
          const e = elos.get(pid);
          return e ? blendElo(e.elo, e.games) : 500; // unknown player → neutral
        });
        return blended.reduce((a, b) => a + b, 0) / blended.length;
      };
      this.pointProb = perPointProb(sideElo(leftPids), sideElo(rightPids), winScore);
    } catch (e) {
      console.error('odds model refresh failed:', e);
      this.pointProb = 0.5;
    }
  }

  /** Live fair decimal odds for the current duel score, from the cached per-point prob. */
  private currentOdds(): { left: number; right: number } {
    return liveOdds(this.pointProb, this.game.winScore, this.game.score.left, this.game.score.right);
  }

  /** Whether wagers can be placed/quoted right now: a live, human-vs-human duel. */
  private bettingOpen(): boolean {
    return this.mode === 'duel' && !this.bot && this.game.status === 'playing';
  }

  /** Place a wager on a side of the live duel (spectators only), locking in the current odds.
   *  Live betting: allowed any time the duel is live, and a spectator may place several. */
  bet(ws: WebSocket, side: Side, amount: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    if (!this.bettingOpen()) return; // live, non-bot duel only
    if (this.sideOf(ws)) return; // players can't bet on their own match
    const amt = Math.floor(amount);
    if (!Number.isFinite(amt) || amt < 1) return;
    const odds = this.currentOdds()[side]; // lock the odds shown at this instant
    const { pid, nickname: name } = conn;
    // Escrow the stake atomically — spendCoins returns null if they can't actually afford it.
    spendCoins(pid, amt)
      .then((w) => {
        if (!w) { this.sendWallet(ws); return; } // insufficient coins — refresh their view, no bet
        this.bets.push({ pid, side, amount: amt, ws, name, odds });
        this.sendWallet(ws);
        this.announce(`🎲 ${name} bet ${amt} on ${side} @ ${odds.toFixed(2)}×`, true);
      })
      .catch((e) => console.error('bet failed:', e));
  }

  /** Settle all open wagers against the winning side: correct calls pay stake × locked odds. */
  private settleBets(winnerSide: Side | null) {
    if (this.bets.length === 0) return;
    // No winning side (an abnormal end with no result) — nobody called it wrong, so return
    // every stake rather than pocketing it.
    if (!winnerSide) { void this.refundBets(); return; }
    const pending = this.bets;
    this.bets = [];
    for (const b of pending) {
      if (b.side === winnerSide) {
        const payout = Math.max(b.amount, Math.round(b.amount * b.odds)); // never pay below stake
        addCoins(this.conns.get(b.ws)?.pid ?? b.pid, b.name, payout)
          .then(() => {
            if (!this.conns.has(b.ws)) return;
            this.sendWallet(b.ws);
            this.notify(b.ws, `🎲 ${b.side} won — your ${b.amount}🪙 bet pays ${payout}🪙 (+${payout - b.amount})`);
          })
          .catch((e) => console.error('payout failed:', e));
      } else {
        // Lost — stake was escrowed at bet time; just refresh their wallet view + tell them.
        if (this.conns.has(b.ws)) {
          this.sendWallet(b.ws);
          this.notify(b.ws, `🎲 ${winnerSide} won — your ${b.amount}🪙 bet on ${b.side} lost`);
        }
      }
    }
  }

  /** Refund all open wagers (match abandoned with no result, or a graceful shutdown).
   *  Returns once every refund has been written to the DB, so a caller that needs the coins
   *  made whole before exiting can await it; fire-and-forget callers can ignore the promise. */
  private refundBets(): Promise<void> {
    if (this.bets.length === 0) return Promise.resolve();
    const pending = this.bets;
    this.bets = [];
    return Promise.all(pending.map((b) =>
      addCoins(this.conns.get(b.ws)?.pid ?? b.pid, b.name, b.amount)
        .then(() => {
          if (!this.conns.has(b.ws)) return;
          this.sendWallet(b.ws);
          this.notify(b.ws, `🎲 Bet refunded: ${b.amount}🪙`);
        })
        .catch((e) => console.error('refund failed:', e)),
    )).then(() => undefined);
  }

  /** Refund any open wagers ahead of a graceful shutdown. Bets live only in memory — they're
   *  not part of the snapshot — so without this the coins escrowed at bet time would be lost
   *  across a restart: neither paid out nor returned. The notice rides the chat log, which IS
   *  snapshotted, so reconnecting spectators see why their stake came back. */
  refundOpenBets(): Promise<void> {
    if (this.bets.length > 0) this.announce('🎲 Open bets refunded — server restarting.');
    return this.refundBets();
  }

  claim(ws: WebSocket, side?: Side) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || conn.role !== 'observer') return;
    if (this.tournament) return; // seats are bracket-controlled during a tournament
    // Remove from queue if they were in it
    this.queueLeave(ws);
    // Arena mode: a 3rd player turns the box into a polygon. If we're already on the
    // polygon, just take the next free edge; if the box is full, migrate then seat.
    if (this.mode === 'poly') {
      this.arenaClaim(ws);
      this.refreshPause();
      return;
    }
    if (this.arena && this.teams.left.length >= 1 && this.teams.right.length >= 1) {
      this.migrateDuelToPoly();
      this.arenaClaim(ws);
      this.refreshPause();
      return;
    }
    // Honor the requested side; otherwise auto-assign to the smaller team.
    const pick: Side =
      side ?? (this.teams.left.length <= this.teams.right.length ? 'left' : 'right');
    // Sides only stack in layered-teams mode; otherwise it's classic one-per-side.
    const cap = this.game.layered ? TEAM_MAX : 1;
    if (this.teams[pick].length >= cap) return; // that side is full
    this.teams[pick].push(ws);
    conn.role = pick;
    conn.captured = false;
    this.game.addPlayer(pick, conn.id);
    this.tell(ws, { type: 'you', id: conn.id, role: pick });
    // Joining mid-match just adds a paddle; otherwise start once both sides have
    // someone — except after a game, where we wait for ready-ups.
    if (this.teams.left.length && this.teams.right.length) {
      if (this.game.status === 'over') {
        this.ready = { left: false, right: false };
        this.readyTimer = 0;
      } else if (this.game.status === 'waiting') {
        this.game.start();
      }
    }
    this.refreshPause();
  }

  /** Blaster: fire a projectile from this player's paddle at the given aim angle. */
  fire(ws: WebSocket, angle: number) {
    if (this.mode === 'poly') return; // duel-only power-up
    const side = this.sideOf(ws);
    if (side) this.game.fire(side, angle);
  }

  setPaddle(ws: WebSocket, y: number, x?: number) {
    const conn = this.conns.get(ws);
    if (!conn) return;
    if (this.mode === 'poly') {
      // In arena mode the wire `y` is the paddle's 1D offset along its edge.
      if (this.arenaSeats.includes(ws)) this.poly.setTarget(conn.id, y);
      return;
    }
    const side = this.sideOf(ws);
    if (side) this.game.setTarget(side, conn.id, y, x);
  }

  // A player's mouse-capture (pointer lock) state changed. The match stays frozen until
  // both side players have their mouse captured.
  setCapture(ws: WebSocket, on: boolean) {
    const conn = this.conns.get(ws);
    if (!conn) return;
    conn.captured = on;
    this.refreshPause();
  }

  private isCaptured(side: Side): boolean {
    const team = this.teams[side];
    return team.length > 0 && team.every((ws) => this.conns.get(ws)?.captured ?? false);
  }

  private refreshPause() {
    if (this.mode === 'poly') {
      this.poly.paused = !(
        this.arenaSeats.length > 0 &&
        this.arenaSeats.every((ws) => this.conns.get(ws)?.captured ?? false)
      );
      return;
    }
    this.game.paused = !(this.isCaptured('left') && this.isCaptured('right'));
  }

  // Nobody should be held hostage by a seatmate who's gone AFK without capturing their
  // mouse. Once a live match has at least one ready (captured) player, every still-
  // un-captured player gets CAPTURE_TIMEOUT seconds to grab their mouse or be benched.
  // Works for both the duel and the arena. The soonest pending timer drives the on-screen
  // countdown; kicks are deferred until after the scan so we don't mutate seats mid-loop.
  private enforceCaptureTimeout() {
    const seated =
      this.mode === 'poly'
        ? [...this.arenaSeats]
        : [...this.teams.left, ...this.teams.right];
    const live = this.mode === 'poly' ? this.poly.status === 'playing' : this.game.status === 'playing';
    const someCaptured = seated.some((ws) => this.conns.get(ws)?.captured);
    const active = live && seated.length > 1 && someCaptured;

    let soonest = 0;
    const kick: WebSocket[] = [];
    for (const ws of seated) {
      const c = this.conns.get(ws);
      if (!c) continue;
      if (active && !c.captured) {
        if (c.captureDeadline <= 0) c.captureDeadline = CAPTURE_TIMEOUT;
        c.captureDeadline -= TICK_MS / 1000;
        if (c.captureDeadline <= 0) {
          c.captureDeadline = 0;
          kick.push(ws);
        } else if (soonest === 0 || c.captureDeadline < soonest) {
          soonest = c.captureDeadline;
        }
      } else {
        c.captureDeadline = 0; // captured, or no pressure — reset so they get a full window next time
      }
    }
    this.captureCountdown = soonest;
    for (const ws of kick) this.benchForCapture(ws);
  }

  // Pull an AFK player out of their seat for not capturing in time, with a public shaming.
  private benchForCapture(ws: WebSocket) {
    const conn = this.conns.get(ws);
    const name = conn?.nickname || 'someone';
    if (this.mode === 'poly') {
      if (!this.arenaSeats.includes(ws)) return;
      this.arenaUnseat(ws);
    } else {
      const side = this.sideOf(ws);
      if (!side) return;
      if (conn?.pid === this.streakPid) this.endStreak();
      this.unseat(ws);
      if (this.game.status === 'playing' && this.teams[side].length === 0) this.game.toWaiting();
      this.cleanupBotIfAlone(); // a bot left alone after its human got benched should leave too
    }
    this.announce(`💤 ${name} took too long to grab the ball — benched!`);
  }

  /** Change the first-to-N win score (3, 5, or 7). Any joined client may do this. */
  setWinScore(ws: WebSocket, score: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return;
    if (![3, 5, 7].includes(score)) return;
    this.game.setWinScore(score);
  }

  // Any joined client may toggle game modes.
  setMode(ws: WebSocket, opts: { closing?: boolean; gravity?: boolean; turbo?: boolean; streamer?: boolean; diamond?: boolean; pinata?: boolean; layered?: boolean; arena?: boolean; viewMode?: string; breakout?: boolean; fog?: boolean; portal?: boolean }) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return;
    if (opts.closing !== undefined) this.game.setClosing(opts.closing);
    if (opts.gravity !== undefined) this.game.setGravity(opts.gravity);
    if (opts.turbo !== undefined) this.game.setTurbo(opts.turbo);
    if (opts.streamer !== undefined) this.streamerMode = opts.streamer;
    if (opts.diamond !== undefined) this.game.setDiamond(opts.diamond);
    if (opts.pinata !== undefined) this.game.setPinata(opts.pinata);
    if (opts.layered !== undefined) this.game.setLayered(opts.layered);
    if (opts.arena !== undefined) this.setArena(opts.arena);
    if (opts.breakout !== undefined) this.game.setBreakout(opts.breakout);
    if (opts.fog !== undefined) this.game.setFog(opts.fog);
    if (opts.portal !== undefined) this.game.setPortal(opts.portal);
    // View mode is locked while a match is in progress to avoid disrupting players.
    if ((opts.viewMode === 'normal' || opts.viewMode === '3d' || opts.viewMode === 'firstperson') && this.game.status !== 'playing') {
      this.viewMode = opts.viewMode;
      this.syncPowerupPool();
    }
  }

  /** Sync which powerups are eligible based on the current view mode.
   *  rotate + roam are 2D-only (steered with the flat-court mouse axes); disco is 3D/FP-only. */
  private syncPowerupPool() {
    if (this.viewMode === 'normal') {
      this.game.setExcludedPowerups(['disco']); // disco's effect only shows in 3D
    } else {
      this.game.setExcludedPowerups(['rotate', 'roam']); // court flip / freed paddle only steer in 2D
    }
  }

  /** Arm / disarm arena mode. Turning it off while a polygon match is live folds the
   *  remaining players back down to the classic two-player box. */
  private setArena(on: boolean) {
    if (this.tournament) return; // arena is disabled during a tournament
    if (this.arena === on) return;
    this.arena = on;
    if (on) this.removeBotInternal(); // bots are a duel-only feature; clear before any migration
    if (!on && this.mode === 'poly') this.migratePolyToDuel();
  }

  // Move the two duel players onto the polygon and switch to arena play. Called when a
  // 3rd player wants in while arena mode is armed.
  private migrateDuelToPoly() {
    const duelPlayers = [...this.teams.left, ...this.teams.right];
    // Tear down the duel match cleanly (king/ready/fatalities don't apply in the arena).
    this.king = null;
    this.endStreak();
    this.ready = { left: false, right: false };
    this.readyTimer = 0;
    this.overHandled = false;
    this.fatalityWinnerPid = null;
    this.fatalityWinnerSide = null;
    this.activeFatality = null;
    this.fatalityAt = 0;
    this.teams = { left: [], right: [] };
    this.game.toWaiting();
    this.game.players = { left: [], right: [] };
    this.poly = new PolyGame();
    this.arenaSeats = [];
    for (const ws of duelPlayers) {
      const c = this.conns.get(ws);
      if (!c) continue;
      this.arenaSeats.push(ws);
      c.role = 'player';
      c.captured = false;
      this.poly.addPlayer(c.id);
      this.tell(ws, { type: 'you', id: c.id, role: 'player' });
    }
    this.mode = 'poly';
    this.polyOverTimer = 0;
  }

  // Fold the polygon back down to a classic box: the first two arena players become the
  // duel's left/right, everyone else is released to observer.
  private migratePolyToDuel() {
    const seats = [...this.arenaSeats];
    this.poly.toWaiting();
    this.poly = new PolyGame();
    this.arenaSeats = [];
    this.mode = 'duel';
    this.polyOverTimer = 0;
    const sides: Side[] = ['left', 'right'];
    seats.forEach((ws, i) => {
      const c = this.conns.get(ws);
      if (!c) return;
      if (i < 2) {
        const side = sides[i];
        this.teams[side].push(ws);
        c.role = side;
        c.captured = false;
        this.game.addPlayer(side, c.id);
        this.tell(ws, { type: 'you', id: c.id, role: side });
      } else {
        c.role = 'observer';
        c.captured = false;
        this.tell(ws, { type: 'you', id: c.id, role: 'observer' });
      }
    });
    if (this.teams.left.length && this.teams.right.length && this.game.status === 'waiting') {
      this.game.start();
    }
  }

  // Seat a player on the polygon (mode is already 'poly'). The shape grows live: an
  // in-progress round reseeds (re-centers paddles + re-serves) so the new edge appears.
  private arenaClaim(ws: WebSocket) {
    if (this.arenaSeats.length >= MAX_PLAYERS) return; // arena full
    if (this.arenaSeats.includes(ws)) return;
    const conn = this.conns.get(ws);
    if (!conn) return;
    this.arenaSeats.push(ws);
    conn.role = 'player';
    conn.captured = false;
    this.poly.addPlayer(conn.id);
    this.tell(ws, { type: 'you', id: conn.id, role: 'player' });
    if (this.poly.status === 'playing') this.poly.reseed();
    else if (this.poly.status === 'waiting' && this.arenaSeats.length >= 3) this.poly.start();
  }

  /** A player left an arena seat (leave/forfeit/disconnect). Drop below 3 → back to a box. */
  private arenaUnseat(ws: WebSocket) {
    const i = this.arenaSeats.indexOf(ws);
    if (i === -1) return;
    this.arenaSeats.splice(i, 1);
    const conn = this.conns.get(ws);
    if (conn) {
      this.poly.removePlayer(conn.id);
      conn.role = 'observer';
      conn.captured = false;
      this.tell(ws, { type: 'you', id: conn.id, role: 'observer' });
    }
    if (this.arenaSeats.length >= 3) {
      this.poly.reseed();
      this.claimFromQueue();
    } else {
      // Not enough for a polygon anymore — collapse back to the classic two-player box.
      this.migratePolyToDuel();
    }
  }

  remove(ws: WebSocket) {
    this.doomLeave(ws); // drop any co-op DOOM slot (and notify the partner)
    const leavingPid = this.conns.get(ws)?.pid ?? '';
    // Tournament participant left: advance their opponent / free their slot before the
    // generic seat teardown below (which would lose the bracket context).
    const inTournament = !!this.tournament && !!leavingPid && this.tournament.hasPid(leavingPid);
    if (inTournament) {
      this.onTournamentParticipantGone(leavingPid);
      if (this.tournament) { // still running after the forfeit
        if (this.king && this.king.ws === ws) this.king = null;
        this.queueLeave(ws);
        this.conns.delete(ws);
        this.refreshPause();
        return;
      }
    }
    if (this.mode === 'poly' && this.arenaSeats.includes(ws)) {
      this.arenaUnseat(ws);
    } else {
      const side = this.sideOf(ws);
      if (side) {
        this.unseat(ws);
        // The match only drops back to waiting if their whole team is gone.
        if (this.game.status === 'playing' && this.teams[side].length === 0) this.game.toWaiting();
      }
    }
    if (this.king && this.king.ws === ws) this.king = null;
    if (this.conns.get(ws)?.pid === this.streakPid) this.endStreak(); // streak holder left
    this.queueLeave(ws);
    this.conns.delete(ws);
    this.cleanupBotIfAlone(); // the bot's human opponent may have just left
    this.refreshPause();
  }

  /** Called every tick after the active sim ticks. Routes to the live mode's bookkeeping. */
  sync() {
    this.expireResume();
    this.tickStocks(); // re-roll crypto prices when the 5-minute window elapses
    // "coins" power-up: pay the collecting side 100 coins (1 × COIN_SCALE), once.
    if (this.game.coinGrant) {
      const side = this.game.coinGrant;
      this.game.coinGrant = null;
      for (const c of this.connsOn(side)) {
        if (!c.pid) continue;
        const w = this.wsOfConn(c);
        addCoins(c.pid, c.nickname, COIN_SCALE).then(() => { if (w) this.sendWallet(w); }).catch(() => {});
      }
    }
    // Safety: if a duel was abandoned (back to 'waiting' with no result) or we slid into
    // arena mode, refund any open wagers so escrowed coins are never lost.
    if (this.bets.length && (this.mode === 'poly' || this.game.status === 'waiting')) this.refundBets();
    // Compute the Elo odds model once when a fresh duel goes live; clear it when betting closes.
    const live = this.bettingOpen();
    if (live && !this.oddsReady) { this.oddsReady = true; void this.refreshOddsModel(); }
    else if (!live) { this.oddsReady = false; this.pointProb = 0.5; }
    if (this.tournament) this.tournamentSync();
    else if (this.mode === 'poly') this.polySync();
    else this.duelSync();
    // Bench anyone holding up a live, ready opponent by not capturing their mouse.
    // (Suspended during a tournament — benching a seated player would break the bracket.)
    if (!this.tournament) this.enforceCaptureTimeout();
    // Keep the pause flag honest every tick.
    this.refreshPause();
    if (this.streamerMode && this.mode === 'duel' && this.game.status === 'playing') {
      this.tickStreamer();
    }
  }

  /** Arena bookkeeping: record results once on game-over, then auto-start the next round. */
  private polySync() {
    if (this.poly.status === 'over') {
      if (this.polyOverTimer === 0) {
        this.recordPolyResult();
        this.polyOverTimer = POLY_OVER_SECS;
      } else {
        this.polyOverTimer -= TICK_MS / 1000;
        if (this.polyOverTimer <= 0) {
          this.polyOverTimer = 0;
          if (this.arenaSeats.length >= 3) this.poly.start();
          else this.migratePolyToDuel();
        }
      }
    } else {
      this.polyOverTimer = 0;
      if (this.poly.status === 'waiting' && this.arenaSeats.length >= 3) this.poly.start();
    }
  }

  // Record an arena round: the survivor gets a win, everyone else who was seated a loss.
  private recordPolyResult() {
    const winnerId = this.poly.winnerId;
    const refs = this.arenaSeats
      .map((ws) => this.conns.get(ws))
      .filter((c): c is Conn => !!c && !!c.pid);
    const winnerConns = refs.filter((c) => c.id === winnerId);
    const winners = winnerConns.map((c) => ({ pid: c.pid, name: c.nickname }));
    const losers = refs.filter((c) => c.id !== winnerId).map((c) => ({ pid: c.pid, name: c.nickname }));
    if (winners.length && losers.length) {
      recordResult(winners, losers)
        .then(() => { this.refreshLeaderboard(); this.refreshWalletsFor(winnerConns); })
        .catch((e) => console.error('leaderboard update failed:', e));
    }
  }

  /** Classic 1v1 bookkeeping. Reopens both spots once a match ends. */
  private duelSync() {
    // Reopen both spots exactly once, when the match first ends. Doing this every
    // tick would re-release the next player the instant they claim a spot, making it
    // impossible to start a second game.
    // A bot match is its own thing: never counts for the leaderboard, never crowns a king,
    // and the bot leaves once the result has been shown for a beat (win or lose).
    if (this.bot && this.game.status === 'over') {
      const bot = this.bot;
      if (!this.overHandled) {
        const winnerSide = this.game.winnerSide;
        const winners = winnerSide ? this.connsOn(winnerSide) : [];
        this.winnerName = winners.length ? winners.map((c) => c.nickname).join(' & ') : null;
        this.king = null; // beating a bot never crowns a king
        this.endStreak();
        // Fatalities are cosmetic (no leaderboard impact), so a human who beats a bot still
        // gets to perform one. The bot itself never performs a finisher. Arm only when the
        // winner is human (the bot has no pid).
        const humanWinner = winners.find((c) => c.pid);
        this.fatalityWinnerPid = humanWinner ? humanWinner.pid : null;
        this.fatalityWinnerSide = humanWinner ? winnerSide : null;
        this.activeFatality = null;
        // If the bot won, it taunts the human with a random finisher of its own (the bot
        // has no client to tap a combo, so the server lands it). Fatalities must be armed.
        if (!humanWinner && winnerSide === bot.side && this.fatalitiesEnabled) {
          const move = FATALITY_MOVES[Math.floor(Math.random() * FATALITY_MOVES.length)];
          this.activeFatality = { side: bot.side, move };
          this.fatalityAt = Date.now();
        }
        this.overHandled = true;
        // Give a human winner a window to land their finisher; otherwise the bot just leaves
        // (or lingers through its own finisher, handled below).
        this.botOverTimer = this.fatalityWinnerSide ? BOT_FINISH_SECS : BOT_OVER_SECS;
      } else if (this.activeFatality) {
        // A finisher is playing — hold until its animation has run, then the bot leaves.
        if (Date.now() - this.fatalityAt > FATALITY_DISPLAY_MS) this.removeBotInternal();
      } else {
        this.botOverTimer -= TICK_MS / 1000;
        if (this.botOverTimer <= 0) this.removeBotInternal(); // resets to waiting
      }
      return;
    }

    if (this.game.status === 'over') {
      if (!this.overHandled) {
        const winnerSide = this.game.winnerSide;
        const loserSide: Side | null = winnerSide
          ? winnerSide === 'left'
            ? 'right'
            : 'left'
          : null;
        const winners = winnerSide ? this.connsOn(winnerSide) : [];
        const losers = loserSide ? this.connsOn(loserSide) : [];
        this.winnerName = winners.length ? winners.map((c) => c.nickname).join(' & ') : null;
        // Fatalities are a solo flourish: armed only when one player won the match.
        this.fatalityWinnerPid = winners.length === 1 ? winners[0].pid : null;
        this.fatalityWinnerSide = winners.length === 1 ? winnerSide : null;
        this.activeFatality = null;
        // Release the losing team; winners stay seated.
        if (loserSide) this.release(loserSide);
        // King of the court is a 1v1 ritual — only a solo winner takes the throne.
        if (winners.length === 1 && winnerSide) {
          const winner = winners[0];
          this.king = {
            side: winnerSide,
            pid: winner.pid,
            nickname: winner.nickname,
            ws: this.teams[winnerSide][0],
          };
          // Win streak: extend it if the same player just defended their throne,
          // otherwise this is a fresh king with a streak of one.
          this.kingStreak = winner.pid === this.streakPid ? this.kingStreak + 1 : 1;
          this.streakPid = winner.pid;
        }
        this.overHandled = true;

        // Every seated player's record counts: each winner gets a win, each loser a loss.
        const winRefs = winners.filter((c) => c.pid).map((c) => ({ pid: c.pid, name: c.nickname }));
        const loseRefs = losers.filter((c) => c.pid).map((c) => ({ pid: c.pid, name: c.nickname }));
        if (winRefs.length && loseRefs.length) {
          recordResult(winRefs, loseRefs)
            .then(() => { this.refreshLeaderboard(); this.refreshWalletsFor(winners); })
            .catch((e) => console.error('leaderboard update failed:', e));
        }
        this.settleBets(winnerSide); // pay out spectator wagers on this match
        this.settleBounty(winners, losers); // pay any bounty on the loser to the winner
      } else if (this.activeFatality && Date.now() - this.fatalityAt > FATALITY_DISPLAY_MS) {
        // Once the finishing move has played out, return to the lobby so the frozen
        // FATALITY screen clears and a fresh match can be started.
        this.activeFatality = null;
        this.game.toWaiting();
      } else if (this.teams.left.length && this.teams.right.length) {
        // Both spots filled after game: wait for ready-up
        if (this.ready.left && this.ready.right) {
          // Both ready: start the next match
          this.ready = { left: false, right: false };
          this.readyTimer = 0;
          this.overHandled = false;
          this.fatalityWinnerPid = null;
          this.fatalityWinnerSide = null;
          this.activeFatality = null;
          this.fatalityAt = 0;
          this.game.start();
        } else if (this.readyTimer > 0) {
          this.readyTimer -= TICK_MS / 1000;
          if (this.readyTimer <= 0) {
            // Timeout: release both spots
            for (const s of SIDES) this.release(s);
            this.ready = { left: false, right: false };
            this.readyTimer = 0;
            this.endStreak(); // reign lapses if no rematch is readied in time
            this.game.toWaiting();
          }
        }
      }
    } else {
      this.overHandled = false;
      this.fatalityWinnerPid = null;
      this.fatalityWinnerSide = null;
      this.activeFatality = null;
      this.fatalityAt = 0;
      this.ready = { left: false, right: false };
      this.readyTimer = 0;
      if (this.game.status === 'playing') this.king = null;
      // Catch-all: idle in the lobby with both sides manned (e.g. the queue auto-filled
      // a seat after a forfeit, a leave, or a ready-timeout). Kick off the match —
      // otherwise it sits frozen in 'waiting' with players present.
      if (this.game.status === 'waiting' && this.teams.left.length && this.teams.right.length) {
        this.game.start();
      }
    }
  }

  /** Flip the shared fatalities toggle for the whole room. Any joined user may change it. */
  setFatalities(ws: WebSocket, _enabled: boolean) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return; // must have joined
    this.fatalitiesEnabled = true; // fatalities are permanently on — disabling is not allowed
  }

  /**
   * Perform the winner's finishing move. Cosmetic only (no leaderboard impact), so the
   * checks are light — but we still confirm the sender is the actual winner (by stable
   * pid), that the match is over, and that the move is one we know about, so a random
   * observer can't trigger or spoof a fatality.
   */
  fatality(ws: WebSocket, move: string) {
    if (!this.fatalitiesEnabled) return; // disabled room-wide
    if (this.game.status !== 'over') return;
    if (!this.fatalityWinnerSide || this.activeFatality) return; // no winner, or already done
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid || conn.pid !== this.fatalityWinnerPid) return; // not the winner
    if (!(FATALITY_MOVES as readonly string[]).includes(move)) return; // unknown move
    this.activeFatality = { side: this.fatalityWinnerSide, move };
    this.fatalityAt = Date.now();
  }

  /** Re-query the standings, cache them, and push to every connected client. */
  async refreshLeaderboard() {
    this.leaderboard = await getLeaderboard();
    const data = JSON.stringify({ type: 'leaderboard', rows: this.leaderboard });
    for (const ws of this.conns.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
    // Net worth tracks the same population, so refresh it on the same beat.
    this.refreshNetWorth().catch((e) => console.error('net worth update failed:', e));
  }

  /** Recompute the Net Worth board (coins + live holdings − debt) and push it to everyone.
   *  The pid of each row is cached locally (never sent to clients — it's the identity key) so a
   *  later balance-sheet request can resolve a board rank back to a player. */
  async refreshNetWorth() {
    const full = await getNetWorthLeaderboard();
    this.netWorthPids = full.map((r) => r.pid);
    this.netWorth = full.map(({ pid: _pid, ...row }) => row);
    const data = JSON.stringify({ type: 'netWorth', rows: this.netWorth });
    for (const ws of this.conns.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  /** Build and send the balance sheet for the player at `rank` on the current net-worth board:
   *  liquid coins, every open stock position valued at the live price, and any debt to Davis.
   *  Public info (the board already shows net/coins/debt) — no pid ever leaves the server. */
  async sendBalanceSheet(ws: WebSocket, rank: number) {
    if (!Number.isInteger(rank) || rank < 0 || rank >= this.netWorthPids.length) return;
    const pid = this.netWorthPids[rank];
    const name = this.netWorth[rank]?.name ?? '???';
    const [wallet, holdings, loan] = await Promise.all([getWallet(pid), getHoldings(pid), getLoan(pid)]);
    const rows: BalanceSheetHolding[] = [];
    let stockValue = 0;
    for (const s of STOCKS) {
      for (const h of holdings.filter((x) => x.coin === s.id && x.shares > 0)) {
        const price = this.stockPrices.get(s.id)?.price ?? s.base;
        const value = Math.round(positionWorth(h.side, h.shares, h.cost, price));
        stockValue += value;
        rows.push({ coin: s.name, ticker: s.ticker, side: h.side, shares: h.shares, price, value });
      }
    }
    const owed = loan?.owed ?? 0;
    const net = wallet.coins + stockValue - owed;
    this.tell(ws, {
      type: 'balanceSheet', rank, name,
      coins: wallet.coins, holdings: rows, stockValue, loan: owed, net,
    });
  }

  broadcast() {
    const msg = this.buildState();
    const data = JSON.stringify(msg);
    for (const ws of this.conns.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  // --- internals ---

  /** Fan a big center-screen banner out to every client (transient, not kept). */
  private announce(text: string, toast = false) {
    const data = JSON.stringify({ type: 'announce', text, toast });
    for (const sock of this.conns.keys()) {
      if (sock.readyState === sock.OPEN) sock.send(data);
    }
  }

  /** A small personal toast to a single connection (e.g. a bet result). */
  private notify(ws: WebSocket, text: string) {
    this.tell(ws, { type: 'announce', text, toast: true });
  }

  /** Echo a slash command into chat (styled apart on the client) so it's visible to all. */
  private echoCommand(conn: Conn, text: string) {
    const line: ChatLine = {
      from: conn.nickname,
      text,
      player: conn.role !== 'observer',
      color: conn.color,
      command: true,
      time: Date.now(),
    };
    this.chatLog.push(line);
    if (this.chatLog.length > CHAT_HISTORY) this.chatLog.shift();
    const data = JSON.stringify({ type: 'chat', lines: [line] });
    for (const sock of this.conns.keys()) {
      if (sock.readyState === sock.OPEN) sock.send(data);
    }
  }

  /** Inject a fake chat message from a streamer bot (bypasses rate limiting). */
  private botChat(from: string, text: string, color: string) {
    const line: ChatLine = { from, text, player: false, color, time: Date.now() };
    this.chatLog.push(line);
    if (this.chatLog.length > CHAT_HISTORY) this.chatLog.shift();
    const data = JSON.stringify({ type: 'chat', lines: [line] });
    for (const sock of this.conns.keys()) {
      if (sock.readyState === sock.OPEN) sock.send(data);
    }
  }

  private tickStreamer() {
    const score = this.game.score;
    const last = this.streamerLastScore;

    // Detect a goal — fire a burst of goal reactions.
    if (score.left !== last.left || score.right !== last.right) {
      const scorerSide = score.left > last.left ? 'left' : 'right';
      const loserSide = scorerSide === 'left' ? 'right' : 'left';
      const scorerName = this.nameOf(scorerSide) ?? scorerSide;
      const count = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) {
        const bot = STREAMER_BOTS[Math.floor(Math.random() * STREAMER_BOTS.length)];
        const msgs = Math.random() < 0.5 ? GOAL_REACTIONS_SCORER : GOAL_REACTIONS_LOSER;
        const raw = msgs[Math.floor(Math.random() * msgs.length)];
        const text = raw.replace('{scorer}', scorerName).replace('{loser}', this.nameOf(loserSide) ?? loserSide);
        this.botChat(bot.name, text, bot.color);
      }
      this.streamerLastScore = { ...score };
      // Schedule next random message a bit later so the goal burst stands out.
      this.streamerNextAt = this.streamerTick + 180 + Math.floor(Math.random() * 120);
      return;
    }

    this.streamerTick++;
    if (this.streamerTick < this.streamerNextAt) return;

    // Fire a random generic message.
    const bot = STREAMER_BOTS[Math.floor(Math.random() * STREAMER_BOTS.length)];
    const text = GENERIC_MSGS[Math.floor(Math.random() * GENERIC_MSGS.length)];
    this.botChat(bot.name, text, bot.color);

    // Schedule the next one: roughly 1–5 seconds at 60 tps.
    this.streamerNextAt = this.streamerTick + 60 + Math.floor(Math.random() * 240);
  }

  /** Vacate one player's seat: drop their paddle and return them to observer. */
  private unseat(ws: WebSocket) {
    const side = this.sideOf(ws);
    if (!side) return;
    this.teams[side] = this.teams[side].filter((s) => s !== ws);
    const conn = this.conns.get(ws);
    if (conn) {
      this.game.removePlayer(side, conn.id);
      conn.role = 'observer';
      conn.captured = false;
      this.tell(ws, { type: 'you', id: conn.id, role: 'observer' });
    }
    if (this.king && this.king.ws === ws) this.king = null;
    if (this.teams[side].length === 0) {
      this.ready[side] = false;
      // Auto-claim from queue if someone is waiting for an empty side
      this.claimFromQueue();
    }
  }

  /** Vacate every seat on a side (match end, ready timeout, abandoned resume). */
  private release(side: Side) {
    for (const ws of [...this.teams[side]]) this.unseat(ws);
    this.ready[side] = false;
    if (this.king && this.king.side === side) this.king = null;
  }

  // Convert the piñata's internal state into the wire view: absolute positions for each
  // stuck ball (surface angle rotated by the current spin), plus the one-frame burst pulse.
  private pinataView(): StateMsg['pinataPos'] {
    const p = this.game.pinataObj;
    if (!p) return null;
    return {
      x: p.x,
      y: p.y,
      spin: p.spin,
      stuck: p.stuck.map((s) => {
        const a = s.angle + p.spin;
        return { x: p.x + Math.cos(a) * PINATA.r, y: p.y + Math.sin(a) * PINATA.r };
      }),
      burst: this.game.pinataBurstFlash,
    };
  }

  private buildState(): StateMsg {
    const watchers: string[] = [];
    for (const c of this.conns.values()) {
      if (c.role === 'observer' && c.nickname) watchers.push(c.nickname);
    }
    const poly = this.mode === 'poly';
    // Gameplay fields come from whichever sim is live this tick.
    const status = poly ? this.poly.status : this.game.status;
    const ballSrc = poly ? this.poly.ball : this.game.ball;
    const extraSrc = poly ? this.poly.extraBalls : this.game.extraBalls;
    const targetSrc = poly ? this.poly.target : this.game.target;
    const paused = poly ? this.poly.paused : this.game.paused;
    const ghostBall = (poly ? this.poly.ghostTimer : this.game.ghostTimer) > 0;
    const tinyBall = (poly ? this.poly.tinyTimer : this.game.tinyTimer) > 0;
    const bigBall = (poly ? this.poly.bigBallTimer : this.game.bigBallTimer) > 0;
    const lastHit = this.game.lastHit;
    const ballColor = poly
      ? this.poly.lastHitId
        ? this.colorOfId(this.poly.lastHitId)
        : '#e8eefc'
      : lastHit
        ? this.colorOf(lastHit)
        : '#e8eefc';
    const sideState = (side: Side): PaddleState => {
      const players = this.teams[side].map((ws) => {
        const c = this.conns.get(ws)!;
        return {
          id: c.id,
          x: this.game.paddleXOf(side, c.id),
          y: this.game.paddleYOf(side, c.id) ?? COURT.h / 2,
          name: c.nickname,
          color: c.color,
          hat: c.hat,
          skin: c.skin,
          trail: c.trail,
          title: c.title,
        };
      });
      return {
        x: this.game.paddleX[side],
        // Representative fields (first player, or neutral defaults when the side is
        // open) — the fatality animations and the open-side placeholder use these.
        y: players[0]?.y ?? COURT.h / 2,
        name: players.length ? players.map((p) => p.name).join(' & ') : null,
        color: players[0]?.color ?? '#e8eefc',
        h: this.game.halfH(side) * 2,
        frozen: this.game.freezeTimer[side] > 0,
        mirrored: this.game.mirrorTimer[side] > 0,
        shielded: this.game.shielded[side],
        blinded: this.game.blindTimer[side] > 0,
        curveReady: this.game.curveHits[side] > 0,
        disabled: this.game.disabledTimer[side] > 0,
        ammo: this.game.blasterAmmo[side],
        players,
        freezeTimer: Math.max(0, this.game.freezeTimer[side]),
        blindTimer: Math.max(0, this.game.blindTimer[side]),
        mirrorTimer: Math.max(0, this.game.mirrorTimer[side]),
        growHits: this.game.growHits[side],
        shrinkHits: this.game.shrinkHits[side],
        smashHits: this.game.smashHits[side],
        roamHits: this.game.roamHits[side],
      };
    };
    return {
      type: 'state',
      ball: {
        x: ballSrc.x,
        y: ballSrc.y,
        // Take on the color of the paddle that last hit it; neutral until first touch.
        color: ballColor,
      },
      hitSeq: poly ? this.poly.hitSeq : this.game.hitSeq,
      extraBalls: extraSrc.map((b) => ({ x: b.x, y: b.y, color: ballColor })),
      ballSpeed: Math.hypot(ballSrc.vx, ballSrc.vy),
      paddles: { left: sideState('left'), right: sideState('right') },
      target: targetSrc
        ? { x: targetSrc.x, y: targetSrc.y, kind: targetSrc.kind }
        : null,
      score: poly ? { left: 0, right: 0 } : { ...this.game.score },
      status,
      paused: status === 'playing' && paused,
      captureCountdown:
        status === 'playing' && paused && this.captureCountdown > 0
          ? Math.ceil(this.captureCountdown)
          : null,
      closing: this.game.closing,
      layered: this.game.layered,
      arena: this.arena,
      poly: poly ? this.buildPolyState() : null,
      gravity: this.game.gravity,
      turbo: this.game.turbo,
      diamond: this.game.diamond,
      diamondPos: this.game.diamondBlock
        ? { x: this.game.diamondBlock.x, y: this.game.diamondBlock.y }
        : null,
      blocks: poly ? [] : this.game.blocks.map((bl) => ({ ...bl })),
      rotated: this.game.rotated,
      fritz: this.game.fritz,
      disco: this.game.disco,
      minion: this.game.minion,
      earthquake: this.game.earthquake,
      blackout: this.game.blackout, bullettime: this.game.bullettime, vortex: this.game.vortex,
      glitch: this.game.glitch, smoke: this.game.smoke, tilt: this.game.tilt,
      viewMode: this.viewMode,
      pinata: this.game.pinata,
      pinataPos: poly ? null : this.pinataView(),
      winner: status === 'over' ? (poly ? this.polyWinnerName() : this.winnerName) : null,
      fatalitiesEnabled: this.fatalitiesEnabled,
      fatality: !poly && this.game.status === 'over' ? this.activeFatality : null,
      watchers,
      king: poly ? null : this.king?.nickname ?? null,
      kingWins: poly ? 0 : this.kingStreak,
      queue: this.queue.map((ws) => this.conns.get(ws)?.nickname ?? '').filter(Boolean),
      ready: { ...this.ready },
      ghostBall,
      tinyBall,
      bigBall,
      streamerMode: this.streamerMode,
      bot: this.bot?.level ?? null,
      slowTimer: Math.max(0, this.game.slowTimer),
      ghostTimer: Math.max(0, this.game.ghostTimer),
      tinyTimer: Math.max(0, this.game.tinyTimer),
      bigBallTimer: Math.max(0, this.game.bigBallTimer),
      winScore: this.game.winScore,
      tournament: this.tournament ? this.tournament.view(this.liveMatchId) : null,
      projectiles: this.game.projectiles.map((p) => ({ x: p.x, y: p.y, vx: p.vx, vy: p.vy, color: '#39ff14' })),
      bets: this.betBoard(),
      odds: this.bettingOpen() ? this.currentOdds() : null,
      breakout: this.game.breakout,
      bricks: this.game.breakout ? [...this.game.brickAlive] : null,
      fog: this.game.fog,
      portal: this.game.portal,
    };
  }

  // Assemble the arena (polygon) view: geometry + each player's paddle, name and color.
  private buildPolyState(): PolyState {
    const verts = this.poly.verts();
    const players: PolyPlayer[] = this.poly.players.map((p, i) => {
      const info = this.poly.paddleInfo(i, verts);
      const c = this.connById(p.id);
      return {
        id: p.id,
        name: c?.nickname ?? '',
        color: c?.color ?? '#e8eefc',
        cx: info.cx,
        cy: info.cy,
        angle: info.angle,
        len: info.len,
        alive: p.alive,
        shielded: p.shielded,
        curveReady: p.curveHits > 0,
      };
    });
    return {
      n: this.poly.n,
      cx: ARENA.cx,
      cy: ARENA.cy,
      verts,
      players,
      aliveCount: this.poly.aliveCount,
      winner: this.poly.status === 'over' ? this.polyWinnerName() : null,
      stopSign: this.poly.n === MAX_PLAYERS,
    };
  }

  private connById(id: string): Conn | undefined {
    for (const c of this.conns.values()) if (c.id === id) return c;
    return undefined;
  }

  private colorOfId(id: string): string {
    return this.connById(id)?.color ?? '#e8eefc';
  }

  private polyWinnerName(): string | null {
    const id = this.poly.winnerId;
    return id ? this.connById(id)?.nickname ?? null : null;
  }

  private nameOf(side: Side): string | null {
    const names = this.connsOn(side).map((c) => c.nickname);
    return names.length ? names.join(' & ') : null;
  }

  private colorOf(side: Side): string {
    return this.connsOn(side)[0]?.color ?? '#e8eefc';
  }

  private connsOn(side: Side): Conn[] {
    return this.teams[side].flatMap((ws) => {
      const c = this.conns.get(ws);
      return c ? [c] : [];
    });
  }

  private sideOf(ws: WebSocket): Side | null {
    if (this.teams.left.includes(ws)) return 'left';
    if (this.teams.right.includes(ws)) return 'right';
    return null;
  }

  // --- restart resume ---

  /** Snapshot the lobby for persistence across a restart (paired with restore). */
  serialize(): LobbySnapshot {
    const seats = (side: Side): SeatInfo[] =>
      this.connsOn(side)
        .filter((c) => c.pid)
        .map((c) => ({
          pid: c.pid,
          nickname: c.nickname,
          color: c.color,
          y: this.game.paddleYOf(side, c.id) ?? COURT.h / 2,
        }));
    return {
      sides: { left: seats('left'), right: seats('right') },
      king: this.king
        ? { side: this.king.side, pid: this.king.pid, nickname: this.king.nickname }
        : null,
      streakPid: this.streakPid,
      kingStreak: this.kingStreak,
      fatalityWinnerPid: this.fatalityWinnerPid,
      fatalityWinnerSide: this.fatalityWinnerSide,
      activeFatality: this.activeFatality,
      fatalityAt: this.fatalityAt,
      fatalitiesEnabled: this.fatalitiesEnabled,
      queue: this.queue
        .map((ws) => this.conns.get(ws))
        .filter((c): c is Conn => !!c && !!c.pid && !!c.nickname)
        .map((c) => ({ pid: c.pid, nickname: c.nickname })),
      ready: { ...this.ready },
      readyTimer: this.readyTimer,
      winnerName: this.winnerName,
      overHandled: this.overHandled,
      chatLog: this.chatLog,
    };
  }

  /** Restore a snapshot after a restart. Seats/king/queue become pending reattachments
   *  that their clients reclaim by pid as they reconnect; the rest is set directly. */
  restore(s: LobbySnapshot) {
    const seatList = (v: unknown): SeatInfo[] => (Array.isArray(v) ? v : []);
    this.pendingSides = { left: seatList(s.sides?.left), right: seatList(s.sides?.right) };
    this.pendingKing = s.king ?? null;
    this.pendingQueue = s.queue ?? [];
    this.streakPid = s.streakPid ?? null;
    this.kingStreak = s.kingStreak ?? 0;
    this.fatalityWinnerPid = s.fatalityWinnerPid ?? null;
    this.fatalityWinnerSide = s.fatalityWinnerSide ?? null;
    this.activeFatality = s.activeFatality ?? null;
    this.fatalityAt = s.fatalityAt ?? 0;
    this.fatalitiesEnabled = true; // always on, regardless of any older snapshot
    this.ready = s.ready ?? { left: false, right: false };
    this.readyTimer = s.readyTimer ?? 0;
    this.winnerName = s.winnerName ?? null;
    this.overHandled = !!s.overHandled;
    this.chatLog = Array.isArray(s.chatLog) ? s.chatLog : [];
    this.syncPowerupPool();
    // Give seated players a window to reconnect and reclaim their seats; if they don't,
    // expireResume() abandons the resume so the room isn't wedged on a frozen match.
    if (this.pendingSides.left.length || this.pendingSides.right.length) {
      this.resumeGrace = RESUME_GRACE;
    }
  }

  /** On (re)join, reclaim any seat / king / queue spot this identity held pre-restart. */
  private reattach(ws: WebSocket, conn: Conn) {
    if (!conn.pid) return;
    for (const side of SIDES) {
      const i = this.pendingSides[side].findIndex((p) => p.pid === conn.pid);
      if (i !== -1 && this.teams[side].length < TEAM_MAX) {
        const [p] = this.pendingSides[side].splice(i, 1);
        this.teams[side].push(ws);
        conn.role = side;
        conn.captured = false; // must re-capture the mouse to unfreeze the resumed match
        if (p.color) conn.color = p.color;
        this.game.addPlayer(side, conn.id, p.y);
        this.tell(ws, { type: 'you', id: conn.id, role: side });
        // The reigning winner sits on their seat through the 'over' screen — restore it.
        if (this.pendingKing && this.pendingKing.pid === conn.pid) {
          this.king = { side, pid: conn.pid, nickname: conn.nickname, ws };
          this.pendingKing = null;
        }
        if (!this.pendingSides.left.length && !this.pendingSides.right.length) {
          this.resumeGrace = 0;
        }
        return;
      }
    }
    const qi = this.pendingQueue.findIndex((q) => q.pid === conn.pid);
    if (qi !== -1) {
      this.pendingQueue.splice(qi, 1);
      if (!this.queue.includes(ws) && !this.sideOf(ws)) this.queue.push(ws);
    }
  }

  /** Count down the resume window; when it lapses with seats still unclaimed, give up
   *  on the resume and return to the lobby so a missing player can't wedge the room. */
  private expireResume() {
    if (this.resumeGrace <= 0) return;
    this.resumeGrace -= TICK_MS / 1000;
    if (this.resumeGrace > 0) return;
    if (this.pendingSides.left.length || this.pendingSides.right.length) {
      this.pendingSides = { left: [], right: [] };
      this.pendingKing = null;
      for (const side of SIDES) this.release(side);
      this.king = null;
      this.endStreak();
      if (this.game.status !== 'waiting') this.game.toWaiting();
    }
  }

  private tell(ws: WebSocket, msg: ServerMsg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}

// --- AI opponent (bot) data ---

const CAMPAIGN_CLEAR_BONUS = 2500; // one-time coin reward for a first-ever full clear of the campaign
const CAMPAIGN_PERFECT_BONUS = 10000; // one-time jackpot for a first-ever flawless (25000) run
const BOT_OVER_SECS = 4; // how long the win/lose screen holds before the bot leaves
const BOT_FINISH_SECS = 10; // window for a human winner to land a fatality before the bot leaves

interface BotCfg {
  react: number; // seconds between re-aims — the bot's reaction lag
  error: number; // ± random court-unit error added to its aim (bigger = easier)
  predict: boolean; // true = predict the wall-bounced landing Y; false = track raw ball Y
  idleCenter: boolean; // when the ball heads away, drift to center (true) or shadow it (false)
}

// Half a paddle is 45 court units, so an `error` near/above that misses often.
const BOT_CFG: Record<BotLevel, BotCfg> = {
  easy: { react: 0.3, error: 95, predict: false, idleCenter: true },
  medium: { react: 0.14, error: 42, predict: false, idleCenter: true },
  hard: { react: 0.05, error: 10, predict: true, idleCenter: false },
};

const BOT_NAMES: Record<BotLevel, string> = {
  easy: '🤖 Bot (easy)',
  medium: '🤖 Bot (medium)',
  hard: '🤖 Bot (hard)',
};
const BOT_COLOR = '#9aa7c7';

// Predict where a ball heading toward `faceX` will be in Y when it arrives, reflecting it
// off the top/bottom walls (ignores gravity/spin — close enough, and keeps the bot fair).
function botPredictY(ball: { x: number; y: number; vx: number; vy: number }, faceX: number): number {
  if (ball.vx === 0) return ball.y;
  const t = (faceX - ball.x) / ball.vx;
  if (t <= 0) return ball.y; // already past the face / moving away
  const span = 2 * COURT.h;
  let y = ((((ball.y + ball.vy * t) % span) + span) % span);
  if (y > COURT.h) y = span - y; // fold the reflection back into [0, COURT.h]
  return y;
}

// A bot occupies a seat like any player, but has no real socket. This stand-in satisfies
// the lobby's WebSocket-keyed bookkeeping; its readyState is never OPEN, so every
// broadcast/tell loop simply skips it (the bot needs no messages).
function makeBotSocket(): WebSocket {
  return { readyState: 3, OPEN: 1, send() {}, close() {} } as unknown as WebSocket;
}

// --- Streamer mode bot data ---

const STREAMER_BOTS: { name: string; color: string }[] = [
  { name: 'xX_PongLord_Xx', color: '#a855f7' },
  { name: 'TwitchMod42', color: '#22c55e' },
  { name: 'pogchamp99', color: '#3b82f6' },
  { name: 'NaCl_Shaker', color: '#94a3b8' },
  { name: 'GamerMom2024', color: '#ec4899' },
  { name: 'StreamSniper', color: '#f97316' },
  { name: 'BackseatGamer', color: '#eab308' },
  { name: 'JustASpectator', color: '#6b7280' },
  { name: 'NoobDestroyer', color: '#ef4444' },
  { name: 'BallWatcher9000', color: '#06b6d4' },
  { name: 'RandomViewer123', color: '#84cc16' },
  { name: 'CouchExpert', color: '#f59e0b' },
  { name: 'HypeTrainConductor', color: '#e11d48' },
  { name: 'lurker_supreme', color: '#475569' },
  { name: 'PingPongPhilosopher', color: '#7c3aed' },
  { name: 'SweatyTryhard420', color: '#15803d' },
  { name: 'CasualObserver_', color: '#b45309' },
  { name: 'TacticalBurner47', color: '#0e7490' },
  { name: 'HammerTimeGaming', color: '#dc2626' },
  { name: 'SilentKiller99', color: '#1d4ed8' },
  { name: 'VibeCheckFailed', color: '#9333ea' },
  { name: 'JoystickJockey', color: '#d97706' },
  { name: 'PaddlePunisher', color: '#059669' },
  { name: 'xd_itsover', color: '#6366f1' },
  { name: 'ActuallyIronV', color: '#64748b' },
  { name: 'SpeedrunnerMike', color: '#f43f5e' },
  { name: 'DongerDave', color: '#8b5cf6' },
  { name: 'Kreygasm_Fan', color: '#06b6d4' },
  { name: 'TiltedTowers27', color: '#facc15' },
  { name: 'MoistCritical2', color: '#84cc16' },
  { name: 'DefinitelyNotABot', color: '#f472b6' },
  { name: 'TableTennisTerror', color: '#fb923c' },
  { name: 'NotMyFaultBro', color: '#a3e635' },
  { name: 'StreamArchiver', color: '#38bdf8' },
  { name: 'ResidentSleeper_', color: '#94a3b8' },
  { name: 'GlizzyGoblin420', color: '#fb7185' },
  { name: 'NeverGiveUpGuy', color: '#4ade80' },
  { name: 'OneHandedCarry', color: '#c084fc' },
  { name: 'PingIssuesAgain', color: '#fbbf24' },
  { name: 'ChairBreaker99', color: '#f87171' },
];

const GENERIC_MSGS: string[] = [
  'KEKW', 'LUL', 'OMEGALUL', 'PogChamp', 'monkaS', 'Pog',
  'clip that', 'no shot 💀', 'bro', 'chat is this real',
  'this guy is actually good wait', 'nvm he\'s bad',
  'L + ratio + skill issue', 'EZ PZ', 'gg ez',
  'LETS GOOOO', 'how is that not a goal wtf', 'the lag is real',
  'imagine losing at pong lmao', '🤣🤣🤣',
  'HyperScroll HyperScroll HyperScroll',
  'where is the ball going', 'bro missed again',
  'this is so intense', 'my heart is literally racing',
  'no way that missed', 'HOW???',
  'chat spam the ball 🏓🏓🏓',
  'left side diff', 'right side diff',
  'what a save!', 'what a miss!', 'holy moly',
  'I could do that with my eyes closed ngl',
  'someone call 911 this is criminal',
  'bro is throwing rn', 'they\'re cooked',
  'touch grass challenge failed 💀',
  'this is better than watching TV fr',
  'widepeepoHappy', 'peepoSad', 'AYAYA',
  'who taught him to play like this',
  'just quit bro', 'uninstall',
  'is this ping or just terrible',
  'wait what happened', 'chat did u see that',
  'first time viewer what is this game',
  'my grandma plays better and she\'s dead',
  'actual menace', 'certified goat', 'NAH BRO 💀',
  'the tension is INSANE rn',
  'i cant watch', 'i cant look away either',
  'this stream is my therapy fr',
  'W game, W stream, W life',
  'POV: you\'re the ball',
  'chat what are we doing',
  'i drove 45 mins to watch this',
  'my ping is better than their aim lmao',
  'the physics are unhinged and i love it',
  'someone clip the last 30 seconds NOW',
  'im going to pass away',
  'bro really said "I got this" 😭',
  'TURBO MODE WHEN',
  'bro is in the zone or the void idk',
  'this is art tbh',
  '🏓🏓🏓🏓🏓',
  'i haven\'t blinked in 3 minutes',
  'ResidentSleeper... wait no PogChamp',
  'stream needs more emotes',
  'drop the controller 💀',
  'big brain play incoming... or not',
  'certified moment',
  'is this ranked??',
  'imagine being this bad at a 2D game lmaoo',
  'chat it\'s a game about a BALL why is this stressful',
  '5Head strats',
  'they were cooked before the game started',
  'hyperchad gameplay fr fr',
  'okay that one was kinda clean tho',
  'THE DISRESPECT',
  'this game goes HARD no cap',
  'bro queued pong and chose violence',
  'I forgor how to breathe watching this',
  'stream is popping OFF rn',
  'why am I so invested in a pong match',
  'chat we need more hype emotes for this',
  'my heart cannot take this much longer',
  'okay i was rooting against them but that was clean',
  'the AUDACITY',
  'I told my friend about this stream and now we\'re both here',
  'did anyone else just scream',
  'this is the most stressed I\'ve been since my last exam',
  'bro is speedrunning my blood pressure',
  'THE MOMENTUM SHIFT',
  'new meta just dropped',
  'galaxy brain play or complete accident, we may never know',
  'the villain arc started this point',
  'this is actually cinema',
  'i need a moment',
  'okay okay okay okay OKAY',
  'NOT THE COMEBACK ARC',
  'game diff btw',
  'both of them said "no defense allowed"',
  'this rally is giving me PTSD',
  'court side seats for the collapse of the century',
  'chat I need to lie down',
  'the disrespect is criminal fr',
  'nobody tell them how good they are',
  'the SPIN on that ball 😭',
  'chat we are witnessing history',
  'how is the score even that close right now',
  'average Tuesday on this stream',
  'this would never happen in a real sport',
  'bro plays like he has 8 monitors',
  'the physics are not on their side today',
  'I\'ve seen better AI',
  'nah they actually cooked that',
  'wait are they good or are the others bad',
  'stream quality: excellent. player quality: debatable',
  'tell me you never practiced without telling me',
  'i joined 10 seconds ago what is happening',
  'absolute mayhem in the court',
  'the commentators would be LOSING IT rn',
];

const GOAL_REACTIONS_SCORER: string[] = [
  'GG EZ NO DIFF', 'YESSSS GET REKT', 'LETS GO {scorer}!!!',
  'that was a CANNON', 'clean af', 'POG {scorer}',
  'OMEGALUL they didn\'t even try', 'GOTTEM',
  '{scorer} is NOT missing', 'absolute cinema',
  'CLIPPED THAT', 'W + ratio', '🎯🎯🎯',
  '{scorer} DIFF', 'another one lol',
  '{scorer} said "too easy"',
  'POGGERS {scorer} ATE THAT',
  'built different fr',
  'no contest LMAO',
  '{scorer} is on another level rn',
  'SHEEEEESH',
  'bro is in god mode',
  'calculated 🧠',
  '{scorer} making it look effortless',
  'YOOOOO THE ANGLE ON THAT',
  'i called it chat i called it',
  'unstoppable rn holy',
  '{scorer} >>>',
  'W + no diff + {scorer} diff',
  'the ball said "let me help you win"',
  'textbook execution',
  'THAT\'S CINEMA RIGHT THERE',
  'chat moment of the year candidate',
  'not a single person on earth defending that',
  '{scorer} said "this is my court"',
  'someone put that in the highlight reel',
  'the precision 🎯',
  'ZERO chance that was intentional and i don\'t care',
  '{scorer} is NOT human',
  'bro is speed running the scoreboard',
  '{scorer} ate and left zero crumbs',
  'physics teacher would be proud',
  'angle on that was ILLEGAL',
  'i felt that in my soul',
  '{scorer} just ended the debate',
  'that ball had a GPS fr',
  'THE SPEED. THE ANGLE. THE AUDACITY.',
  'chat we need a replay button',
  'they said "skill issue" with their hands',
];

const GOAL_REACTIONS_LOSER: string[] = [
  'NGL that was a skill issue', 'terrible defense rn',
  '{loser} is lost 😂', 'how do you miss that bro',
  'L + ratio + touch grass', 'that\'s an L for {loser}',
  'bozo', 'bro fell off', 'unplayable',
  '{loser} said "i got it" 💀', 'my eyes 😭',
  'that hurt to watch', 'certified fumble',
  '{loser} is cooked, done, finished',
  'not even close actually',
  'the defense was NOT there lmao',
  'tragic end for {loser}',
  '{loser} deserves this L ngl',
  'that was a hate crime against good gameplay',
  'ZERO reaction time',
  'where was {loser}??? anywhere but there apparently',
  'bro really handed them a free point',
  '💀💀💀',
  '{loser} speedran the loss',
  'the paddle is not your friend today',
  'log off and think about what you did',
  'skill issue speedrun any%',
  '{loser} forgot they were playing',
  'chat is this a cry for help',
  'the FREEZE on {loser}\'s paddle 😭',
  'reaction time: nonexistent',
  '{loser} saw the ball and chose to ignore it',
  'that\'s a throw, a genuine throw',
  'bro really said "i\'ll get the next one"',
  'the paddle moved... the wrong way',
  '{loser} is fighting the controller AND losing',
  'average {loser} gameplay',
  'i\'ve seen better defense from a cardboard box',
  'chat pour one out for {loser}',
  'that moment when you peak and fall in the same second',
  'certified not it moment',
  'the audacity to miss THAT',
  'no thoughts, head empty, missed the ball',
  'bro the ball was RIGHT THERE',
  '{loser} said "my body is not ready"',
  'technically they moved so that counts as trying',
];
