// Tracks every connected socket, which two of them hold the paddle spots, and turns
// the Game's raw state into the broadcast message (attaching nicknames / watchers).

import { WebSocket } from 'ws';
import { Game } from './game';
import { PolyGame } from './polygame';
import { TypeGame } from './typegame';
import { NomicGame } from './nomic';
import { World } from './world';
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
  BJ_MAX_BET,
  BjAction,
  BjStateMsg,
  BjResultMsg,
  CRAPS_MAX_BET,
  CrapsResultMsg,
  SLOTS_MAX_BET,
  SLOTS_SYMBOLS,
  SLOTS_WEIGHTS,
  SLOTS_PAYOUTS,
  SlotsSymbol,
  SlotsResultMsg,
  PLINKO_ROWS,
  PLINKO_PAYOUTS,
  PLINKO_MAX_BET,
  PlinkoResultMsg,
  HORSE_NAMES,
  HORSE_ODDS,
  HORSE_MAX_BET,
  HorseCardMsg,
  HorseResultMsg,
  HILO_MAX_BET,
  HILO_HOUSE_EDGE,
  HiLoStateMsg,
  HiLoResultMsg,
  MINES_GRID,
  MINES_MAX_BET,
  MINES_HOUSE_EDGE,
  MinesStateMsg,
  MinesResultMsg,
  CRASH_BETTING_MS,
  CRASH_TICK_MS,
  CRASH_ENDED_MS,
  CRASH_MAX_BET,
  CRASH_GROWTH,
  CrashStateMsg,
  StateMsg,
  STOCKS,
  STOCK_UPDATE_MS,
  STOCK_HISTORY,
  MARKET_INSTABILITY_THRESHOLD,
  StockSide,
  StockTf,
  positionWorth,
  TEAM_MAX,
  WalletMsg,
  CampaignScoreRow,
  WC_COUNTRIES,
  EXCLUSIVES,
  isExclusive,
  MarketItemView,
  MarketListingView,
  WorldAvatar,
  JAIL,
  JAIL_WALL,
  JAIL_CELL,
  BAIL_COST,
  NewsItem,
  NETIZEN_DIALOGUE,
  NEWS_TEMPLATES_BULLISH,
  NEWS_TEMPLATES_BEARISH,
  FED_TEMPLATES,
  LOOT_TABLE,
  minBet,
  FIGHTERS,
  NomProposalKind, NomEffect, NomVote,
  FAST_SELL_BRACKETS,
  WORLD,
  WORLD_BUILDINGS,
} from '../shared/types';
import { getEloBoard, getPlayerProfile, getRival, getNetWorthLeaderboard, getSelfElo, getSelfNetWorth, recordResult, updateName, recordDoomScore, getDoomLeaderboards, DoomScoreRow,
  recordTypeDieScore, getTypeDieLeaderboard, TypeDieScoreRow,
  recordCampaignScore, getCampaignLeaderboard, awardTitle,
  recordFishCatch, getFishingLeaderboard, FishingScoreRow,
  getWallet, buyItem, equipItem, addCoins, spendCoins, claimSpin, grantItem, getElos, addBonusSpin, useBonusSpin, findPlayerByName, DAILY_SPIN_MS, getAssessableWealth, stampActivity, getJailed, setJailed,
  getHoldings, investStock, closePosition, getStockPrices, saveStockPrices, getStockHistory, saveStockHistory,
  setStockCrashAt, getMarketInstability, setMarketInstability,
  getLoan, takeLoan, repayLoan, collectDefaultedLoans, realignLoansToDeadline, getOpenLoans,
  houseAdjust, getHouseBalance,
  getMeta, setMeta, getMetaNum, getTotalOutstandingLoans, getTotalCoins, getLockedShares, getPlayerShares, getNetWorthConcentration, getActivePlayers,
  mintExclusive, getExclusiveSupply, getExclusiveLastSale,
  listExclusive, cancelListing, getMarketListings, buyLowestAsk,
  getLandParcels, getBankParcels, buyParcelFromBank, listParcel, unlistParcel, buyParcelFromOwner,
  getNetizens, seedNetizen,
  addBounty, getBountyOn, clearBounty, getBounties,
  challengedToday, recordChallenge,
  getNetizenByPid, getNetizenCount, getNetWorthRank,
  getNewsFeed, saveNewsFeed,
  getPrefs, savePrefs,
  getGameModes, saveGameModes,
  loadNomic, saveNomic, archiveNomicSeason } from './db';
import { blendElo, perPointProb, liveOdds } from './odds';
import { READY_TIMEOUT, CAPTURE_TIMEOUT, TICK_MS, PINATA, SECTORS, NETIZEN_CHALLENGE_MAX_FRAC, NETIZEN_CHALLENGE_HARDEST_REACT, NETIZEN_CHALLENGE_HARDEST_ERROR, NETIZEN_CHALLENGE_EASIEST_REACT, NETIZEN_CHALLENGE_EASIEST_ERROR } from '../shared/types';
import { WORLD_PARCELS, BANK_PARCEL_CAP, PARCEL_PRICE, LandParcelView } from '../shared/types';

// A reaction is valid if it's the ball sentinel or a short string made only of
// emoji code points (pictographs, components, ZWJ, variation selectors, flags).
// This lets the full picker through while blocking arbitrary text / markup.
const EMOJI_ONLY =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Regional_Indicator}|‍|️)+$/u;
function isValidReaction(emoji: string): boolean {
  if (emoji === BALL_REACTION) return true;
  return emoji.length > 0 && emoji.length <= 16 && EMOJI_ONLY.test(emoji);
}

interface BjHand {
  playerCards: string[];
  dealerCards: string[]; // both cards held server-side; second one revealed at showdown
  bet: number;           // current wager (doubled if player doubled down)
  shoe: string[];        // remaining shoe to draw from
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
  song: string | null; // equipped theme song id (plays during this player's matches)
  // Casino games
  bjHand?: BjHand;             // active blackjack hand (undefined = not playing)
  crapsPoint: number | null;   // current craps point (null = come-out phase)
  horseCard?: { name: string; odds: number }[]; // pending race card (5 horses); undefined = no race started
  hiloHand?: { bet: number; card: number; multiplier: number }; // active Hi-Lo hand
  minesHand?: { bet: number; mines: number; grid: boolean[]; revealed: boolean[]; safeCount: number };
  // Tavern: drunkenness level (0–6) + when the current level expires. Each beer bumps the level and
  // (re)starts a 3-min timer; on expiry you sober down one level at a time.
  drunkLevel: number;
  drunkUntil: number;
  jailed: boolean; // locked in the jail cell (loaded from the DB on join; cleared only by bail)
}

// One step of a crypto's price random walk. Pure RNG — never tied to who invested or how
// much. The market trends UP at a *calm* pace: a steady drift doubles the typical price about
// once a DAY (derived from the re-roll interval, so it holds at any cadence), which keeps the
// numbers human-readable (~1–3) between the daily resets. The noise sits in log space
// (symmetric, so it doesn't drag the typical trajectory below the drift): usually ±~5% per
// tick, with a 1-in-12 chance of a bigger swing on top. Clamped to [base/100, base×1000] and
// rounded to cents (so it can dip below the starting price for real downside, never to zero).
function rollPrice(price: number, base: number, pressure = 0, lockedRatio = 0): number {
  const ticksPerDay = 86_400_000 / STOCK_UPDATE_MS;
  const drift = Math.pow(2, 1 / ticksPerDay); // typical ×2 per day — a gentle climb
  let g = (Math.random() * 2 - 1) * 0.05; // ±5% jitter (log space)
  if (Math.random() < 0.08) g += (Math.random() * 2 - 1) * 0.18; // occasional bigger swing
  // The Fed — supply scarcity: a stock with a large fraction of its supply locked up in long
  // positions older than a day gets a small upward drift premium (cornered low-supply coins like
  // FRITZ/BACON become naturally more premium + volatile). Capped so the clamp still rules.
  g += Math.min(0.5, Math.max(0, lockedRatio)) * 0.06;
  // Blend the drift/noise (60%) with order-flow pressure (40%). Buying pushes up, selling/shorting
  // down, but only as a minority influence — the long-term drift wins and the clamp keeps cornering
  // impossible.
  const driftMult = drift * Math.exp(g);
  const flowMult = 1 + Math.max(-0.5, Math.min(0.5, pressure));
  const mult = Math.pow(driftMult, 0.6) * Math.pow(flowMult, 0.4);
  const np = price * mult;
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

// Market-hours check: M–F 9:00–16:59 America/New_York.
function isMarketHours(nowMs: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: '2-digit',
  }).formatToParts(new Date(nowMs));
  const day = parts.find(p => p.type === 'weekday')?.value;
  const hour = Number(parts.find(p => p.type === 'hour')?.value) || 0;
  return !['Sat','Sun'].includes(day ?? '') && hour >= 9 && hour < 17;
}
// Epoch ms of the next top-of-hour boundary (xx:00:00) in real time.
function nextTopOfHourMs(nowMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(nowMs));
  const m = Number(parts.find(p => p.type === 'minute')?.value) || 0;
  const s = Number(parts.find(p => p.type === 'second')?.value) || 0;
  return nowMs + ((3600 - (m * 60 + s)) % 3600 || 3600) * 1000;
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
// Pong is the economy's faucet. Each recorded PvP match MINTS fresh coins: the winner already gets
// their WIN_REWARD minted by recordResult(), and we mint the SAME amount again into the House — so
// every match nets the treasury +MATCH_HOUSE_MINT (think "200 minted, 100 to the winner, 100 kept").
const MATCH_HOUSE_MINT = 100; // matches the per-win reward minted in db.recordResult()
const BEER_COST = 20;         // coins per beer at the Tavern (a sink → the House)
const DRUNK_MAX = 6;          // the bartender cuts you off at six
const DRUNK_MS = 180_000;     // each drunkenness level lasts 3 minutes

// --- Progressive daily wealth tax ---------------------------------------------------------
// The economy skews "top heavy" and the House runs dry funding payouts, so once a day we skim a
// gentle, MARGINAL tax off liquid balances and route it back into the House (a conserving transfer
// — nothing burned). Thresholds are in raw coins (exactly what a player sees in their wallet); only
// the slice of a balance inside each band is taxed at that band's rate. A big tax-free allowance
// keeps casual/poorer players untouched, and rates stay modest so it nudges rather than punishes.
const TAX_BRACKETS: { upTo: number; rate: number }[] = [
  { upTo: 5_000, rate: 0.00 },        // tax-free allowance — most players never pay a coin
  { upTo: 25_000, rate: 0.02 },       // 2% on 5k–25k
  { upTo: 100_000, rate: 0.04 },      // 4% on 25k–100k
  { upTo: 500_000, rate: 0.06 },      // 6% on 100k–500k
  { upTo: 1_000_000, rate: 0.08 },    // 8% on 500k–1M
  { upTo: Infinity, rate: 0.10 },     // 10% on everything above 1M (Fed can push this to 15%)
];
// Tax owed for a raw coin balance. Marginal across brackets.
function progressiveTax(coins: number, topRate?: number): number {
  let tax = 0, prev = 0;
  for (const b of TAX_BRACKETS) {
    const cap = b.upTo;
    if (coins <= prev) break;
    // The Fed can override the top (1M+) bracket rate when it tightens.
    const rate = (cap === Infinity && topRate !== undefined) ? topRate : b.rate;
    const band = Math.min(coins, cap) - prev;
    tax += band * rate;
    prev = cap;
  }
  return Math.floor(tax);
}

// --- The Fed: trading frictions (all route coins to the House — the primary refill engine) ---
const BROKER_FEE = 0.005;            // 0.5% on every trade (both sides); doubles after hours
const STOCK_CONCENTRATION_CAP = 0.25; // a player can hold at most 25% of any one stock's supply
// Progressive fast-sell tax on the gross payout, by how long the position was held.
function fastSellRate(heldMs: number): number {
  for (const b of FAST_SELL_BRACKETS) if (heldMs < b.underMs) return b.rate;
  return 0; // 3h+ — no fast-sell tax
}
// Realized capital-gains tax on profit only (never principal). Marginal brackets.
const CAPGAIN_BRACKETS: { upTo: number; rate: number }[] = [
  { upTo: 10_000, rate: 0.00 },
  { upTo: 100_000, rate: 0.05 },
  { upTo: 500_000, rate: 0.10 },
  { upTo: Infinity, rate: 0.15 },
];
function capitalGainsTax(gain: number): number {
  if (gain <= 0) return 0;
  let tax = 0, prev = 0;
  for (const b of CAPGAIN_BRACKETS) {
    if (gain <= prev) break;
    tax += (Math.min(gain, b.upTo) - prev) * b.rate;
    prev = b.upTo;
  }
  return Math.floor(tax);
}
// Treasury bonds: lock coins for a term, get paid principal + interest from the House at maturity.
const BOND_TERMS: { termDays: number; rate: number }[] = [
  { termDays: 7, rate: 0.05 },
  { termDays: 30, rate: 0.12 },
];
const BOND_EARLY_PENALTY = 0.05;          // forfeit interest + 5% of principal on early withdrawal
const AUCTION_DURATION_MS = 24 * 3_600_000; // exclusive auctions run 24h
interface Bond { id: string; pid: string; name: string; amount: number; termDays: number; rate: number; purchasedAt: number }
interface Auction { item: string; name: string; startBid: number; highBid: number; highPid: string; highName: string | null; endsAt: number }

// Idle decay: a small daily fee on the net worth of dormant accounts (active players never pay).
function idleFeeRate(daysIdle: number): number {
  if (daysIdle < 7) return 0;
  if (daysIdle < 14) return 0.01;
  if (daysIdle < 30) return 0.03;
  return 0.05;
}

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
  private lastDuelPlaying = false; // rising-edge detector for "a duel just kicked off" (theme songs)
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
  private eloPids: string[] = []; // pid per Elo leaderboard row (server-only; resolves a rank → player)
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
      reactOverride?: number; // challenge difficulty: override reaction time
      errorPxOverride?: number; // challenge difficulty: override aim error in px
    } | null = null;
  private botOverTimer = 0; // seconds the post-match screen lingers before the bot leaves

  // Active netizen challenge: set when a player challenges a netizen, settled when the bot match ends.
  private pendingChallenge: {
    playerPid: string;
    playerName: string;
    playerWs: WebSocket;
    netizenPid: string;
    netizenName: string;
    wager: number;
  } | null = null;

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
  // Economy Overhaul: in-memory order-flow pressure per coin (buys push +, sells/shorts push −),
  // accumulated by recordFlow and decayed each re-roll. Drives 40% of the price move. Lives only
  // in memory (decays to zero, harmless on restart) — never persisted.
  private pressure = new Map<string, number>();
  // --- Market News Engine ---
  // Pending price-pressure injections from published news headlines, waiting to fire at fireAt.
  private pendingNews: { coin: string; magnitude: number; fireAt: number }[] = [];
  // Epoch ms of the next scheduled headline publish (top of the next market hour).
  private nextNewsAt = nextTopOfHourMs(Date.now());
  // Cached news feed (newest-first items). Hydrated on boot from DB, updated on each publish.
  private newsFeed: NewsItem[] = [];
  // Cached House treasury balance, hydrated on boot and kept in sync after each adjust. Broadcast
  // to clients so the market/casino header can show it (and "payouts reduced" when low).
  private houseBalance = 0;
  private lockedShares: Record<string, number> = {}; // per-coin shares locked in long >24h positions (supply scarcity)
  // The Fed: in-memory coefficient cache (persisted in doom_meta, hydrated on boot).
  private fed = { tightening: false, wealthTaxTop: 0.10, loanCapWaived: false };
  private nextFedAt = 0; // throttle the Fed convening (5-min cadence during market hours)
  private nextBondCheckAt = 0; // throttle the 24/7 bond-maturity + auction-deadline check (10-min)
  // Netizen avatar wander state: position, target (tx/ty), pause timer, spawn delay.
  private netizenPos = new Map<string, { x: number; y: number; tx: number; ty: number; pauseUntil: number; spawnAt: number }>();
  // Staggered netizen reactions to news, drained in tickStocks.
  private newsReactions: { name: string; pid: string; text: string; at: number }[] = [];
  // Global throttle for netizen chat: don't post more than once per ~10s.
  private lastNetizenChatAt = 0;
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
  private stockHist: Record<StockTf, Map<string, number[]>> = Object.fromEntries(
    (Object.keys(STOCK_HISTORY) as StockTf[]).map((tf) => [tf, new Map(STOCKS.map((s) => [s.id, [s.base]] as [string, number[]]))]),
  ) as Record<StockTf, Map<string, number[]>>;
  private stockHistTick = 0; // re-roll counter, to decide which series to sample each tick
  private liveMatchId: number | null = null; // bracket match currently on the court
  private tourneyInterMs = 0; // ms left on the "next match" interstitial between games

  // --- Crash casino game ---
  private crashPhase: 'betting' | 'live' | 'ended' = 'betting';
  private crashPhaseStart = 0;           // Date.now() when the current phase began
  private crashAt = 0;                   // predetermined crash multiplier (secret until crash)
  private crashTicksNeeded = 0;          // live-phase ticks until crashAt is reached
  private crashTicks = 0;               // elapsed live-phase ticks
  private crashBets: Array<{ ws: WebSocket; pid: string; name: string; amount: number; autoCashout: number | null; cashedAt: number | null }> = [];

  // --- "Type or Die" (co-op typing horde-defense) ---
  // A single shared, server-authoritative arena that runs alongside everything else. Players
  // drop in via the overlay; the sim owns the monsters / base / scoring (see TypeGame). State
  // is broadcast only to participants, throttled to ~30 Hz.
  private typeGame: TypeGame;
  private tdSockets = new Map<string, WebSocket>(); // participant connection id → socket
  private tdBoard: TypeDieScoreRow[] = [];          // cached best-wave leaderboard, pushed to clients
  private tdBroadcastTick = 0;                       // throttle counter for tdState fan-out

  // --- Nomic (the Parliament sub-game) ---
  // A single perpetual, server-authoritative, DB-persisted rules game. Event-driven: it broadcasts
  // on every change (not per tick). Keyed by stable pid so scores survive sessions + restarts.
  private nomGame!: NomicGame;
  private nomSockets = new Map<string, WebSocket>(); // member pid → socket of players in the Parliament

  constructor(private game: Game) {
    this.typeGame = new TypeGame({
      // A coin-monster kill pays the player who landed it.
      award: (id, coins) => {
        const ws = this.tdSockets.get(id);
        const conn = ws && this.conns.get(ws);
        if (ws && conn && conn.pid) {
          this.housePay(conn.pid, conn.nickname, coins * COIN_SCALE)
            .then(() => this.sendWallet(ws))
            .catch((e) => console.error('type-or-die coin award failed:', e));
        }
      },
      // A run ended: bank each participant's best wave and pay out coins (capped) for showing up.
      ended: (wave, players) => {
        for (const p of players) {
          const ws = this.tdSockets.get(p.id);
          const conn = ws && this.conns.get(ws);
          if (!ws || !conn || !conn.pid) continue;
          const coins = Math.min(wave, 20); // COIN_CAP mirror — modest, presence-rewarding
          recordTypeDieScore(conn.pid, conn.nickname, wave)
            .then(() => this.refreshTypeDieLeaderboard())
            .catch((e) => console.error('type-or-die score save failed:', e));
          this.housePay(conn.pid, conn.nickname, coins * COIN_SCALE)
            .then(() => this.sendWallet(ws))
            .catch((e) => console.error('type-or-die coin payout failed:', e));
        }
      },
      announce: (text) => this.announce(text),
    });
    // The Parliament (Nomic). Persists to the DB on every change and rebroadcasts to whoever's in
    // the building. Hydrated from the DB once below (nobody's connected yet at construction).
    this.nomGame = new NomicGame({
      onChange: (snap) => {
        saveNomic(snap).catch((e) => console.error('nomic save failed:', e));
        this.broadcastNomic();
      },
      announce: (text) => this.announce(text),
      award: (pid, coins) => {
        const ws = this.nomSockets.get(pid);
        const conn = ws && this.conns.get(ws);
        if (ws && conn && conn.pid) {
          this.housePay(conn.pid, conn.nickname, coins * COIN_SCALE)
            .then(() => this.sendWallet(ws))
            .catch((e) => console.error('nomic prize failed:', e));
        }
      },
      archive: (season, winner, rules) => {
        archiveNomicSeason(season, winner, rules).catch((e) => console.error('nomic archive failed:', e));
      },
    });
    loadNomic()
      .then((snap) => { if (snap) this.nomGame.restore(snap); })
      .catch((e) => console.error('nomic load failed:', e));
    // Kick off the perpetual Crash casino game.
    this.crashPhaseStart = Date.now();
    setInterval(() => this.crashTick(), CRASH_TICK_MS);
  }

  /** Advance whichever simulation is live this tick (called by the server loop). */
  tick(dt: number) {
    if (this.mode === 'poly') {
      this.poly.tick(dt);
    } else {
      this.steerBot(dt); // set the bot's paddle target before the sim eases paddles
      this.game.tick(dt);
    }
    this.typeGame.tick(dt); // the typing minigame runs in parallel, independent of the pong sim
    this.tickDrunk();       // sober players down one level per 3-min timer
  }

  /** Sober drinkers down a level at a time as each 3-minute timer lapses. */
  private tickDrunk() {
    const now = Date.now();
    for (const [ws, conn] of this.conns) {
      if (conn.drunkLevel > 0 && now >= conn.drunkUntil) {
        conn.drunkLevel--;
        conn.drunkUntil = conn.drunkLevel > 0 ? now + DRUNK_MS : 0;
        this.tell(ws, { type: 'drunk', level: conn.drunkLevel });
        if (conn.drunkLevel === 0) this.notify(ws, '😌 You\'ve sobered up.');
      }
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
      song: null,
      crapsPoint: null,
      drunkLevel: 0,
      drunkUntil: 0,
      jailed: false,
    };
    this.conns.set(ws, conn);
    this.tell(ws, { type: 'you', id: conn.id, role: 'observer', tOff: Lobby.DAY_NIGHT_OFFSET });
    // Fresh observer: no pid yet, so just the plain boards. Once they join, sendBoardsTo
    // re-sends these personalised with the player's own pinned row.
    this.tell(ws, { type: 'leaderboard', rows: this.leaderboard });
    this.tell(ws, { type: 'netWorth', rows: this.netWorth });
    this.tell(ws, { type: 'doomLeaderboard', solo: this.doomBoards.solo, coop: this.doomBoards.coop });
    this.tell(ws, { type: 'tdLeaderboard', rows: this.tdBoard });
    this.tell(ws, { type: 'campaignLeaderboard', rows: this.campaignBoard });
    this.tell(ws, { type: 'fishLeaderboard', rows: this.fishBoard });
    if (this.chatLog.length) this.tell(ws, { type: 'chat', lines: this.chatLog });
    this.tell(ws, this.buildCrashState(ws));
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

  // Secret: a player typed the magic word — fly the banner-plane for the whole room. The
  // banner choice (idx) is picked here so everyone sees the same arrival message.
  summonPlane(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return; // must have joined
    const now = Date.now();
    if (now - conn.lastChatAt < 3000) return; // gentle throttle: no plane spam
    conn.lastChatAt = now;

    const data = JSON.stringify({ type: 'flyover', idx: Math.floor(Math.random() * 1000) });
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
    if (conn.jailed) { this.notify(ws, '🚔 No pong from the slammer. Post bail first.'); return; }
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
    if (this.conns.get(ws)?.jailed) return; // locked up → can't ready up
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

  // --- Netizen Challenge (Plan 10) ---

  /** Return info about a netizen for the challenge dialog. */
  async sendNetizenInfo(ws: WebSocket, netizenId: string) {
    const conn = this.conns.get(ws);
    const row = await getNetizenByPid(netizenId);
    if (!row) return;
    const boundaryMs = latest5pmEtBoundary();
    const today = await challengedToday(conn?.pid || '', netizenId, boundaryMs);
    const netWorth = Number(row.net);
    const maxWin = Math.round(netWorth * NETIZEN_CHALLENGE_MAX_FRAC);
    this.tell(ws, { type: 'netizenInfo', netizenId, netWorth, maxWin, challengedToday: today, netizenName: row.name });
  }

  /** Challenge a netizen to a coin-wager Pong duel. */
  async netizenChallenge(ws: WebSocket, netizenId: string, wager: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid) return;
    if (this.bot || this.pendingChallenge) return;
    if (this.tournament) return;
    if (this.mode === 'poly' || this.arena) return;
    if (this.game.layered) return;

    const row = await getNetizenByPid(netizenId);
    if (!row) return;

    const boundaryMs = latest5pmEtBoundary();
    const today = await challengedToday(conn.pid, netizenId, boundaryMs);
    if (today) return;

    const netWorth = Number(row.net);
    const maxWager = Math.round(netWorth * NETIZEN_CHALLENGE_MAX_FRAC);
    // Wealth-scaled minimum bet: can't wager below the player's floor.
    const wallet = await getWallet(conn.pid);
    const minWager = minBet(wallet.coins);
    const effectiveMin = Math.min(minWager, maxWager);
    if (wager < effectiveMin || wager > maxWager) return;
    if (wallet.coins < wager) return;

    // Escrow: deduct from human, credit to netizen so net worth is accurate during the match.
    await addCoins(conn.pid, conn.nickname || 'Player', -wager);
    await addCoins(netizenId, row.name, wager);
    await recordChallenge(conn.pid, netizenId, Date.now());

    // Determine bot difficulty from the netizen's net worth.
    const netRank = await getNetWorthRank(netizenId);
    const totalNetizens = await getNetizenCount();
    const t = totalNetizens > 1 ? 1 - (netRank - 1) / (totalNetizens - 1) : 0.5;
    const react = NETIZEN_CHALLENGE_EASIEST_REACT + t * (NETIZEN_CHALLENGE_HARDEST_REACT - NETIZEN_CHALLENGE_EASIEST_REACT);
    const errPx = Math.round(NETIZEN_CHALLENGE_EASIEST_ERROR + t * (NETIZEN_CHALLENGE_HARDEST_ERROR - NETIZEN_CHALLENGE_EASIEST_ERROR));

    if (conn.role === 'observer') {
      const open = SIDES.find((s) => this.teams[s].length === 0);
      if (!open) return;
      this.claim(ws, open);
    }
    const botSide = SIDES.find((s) => this.teams[s].length === 0);
    if (!botSide) return;

    this.pendingChallenge = {
      playerPid: conn.pid,
      playerName: conn.nickname || 'Player',
      playerWs: ws,
      netizenPid: netizenId,
      netizenName: row.name,
      wager,
    };
    this.spawnBot(botSide, 'hard', { reactOverride: react, errorPxOverride: errPx });

    if (this.teams.left.length && this.teams.right.length) {
      if (this.game.status === 'over') this.game.toWaiting();
      if (this.game.status === 'waiting') this.game.start();
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
    this.housePay(conn.pid, conn.nickname, COIN_SCALE)
      .then(() => this.sendWallet(ws))
      .catch((e) => console.error('doom reward failed:', e));
  }

  // World "weekly objective" rewards, in coins (NOT win-units — these are paid as-is, not ×COIN_SCALE).
  // Granted once per player per quest (tracked in-memory for the server's lifetime), paid from the House.
  private static QUEST_REWARDS: Record<string, number> = { 'find-waldo': 400, 'give-banana': 400, 'win-ten': 1000 };
  private claimedQuests = new Set<string>(); // `${pid}:${quest}`
  questClaim(ws: WebSocket, quest: string) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    const reward = Lobby.QUEST_REWARDS[quest];
    if (!reward) return;
    const key = `${conn.pid}:${quest}`;
    if (this.claimedQuests.has(key)) return; // already paid
    this.claimedQuests.add(key);
    this.housePay(conn.pid, conn.nickname, reward) // already in coins — do NOT ×COIN_SCALE
      .then(() => this.sendWallet(ws))
      .catch((e) => { this.claimedQuests.delete(key); console.error('quest reward failed:', e); });
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

  // --- Nuketown (team deathmatch FPS) ---
  // Mirrors the co-op DOOM subsystem, but for up to 6 players across two teams with a dumb
  // broadcast relay (not a 2-slot pairing): the match itself runs on the clients (slot 0, the
  // first joiner, is the host/authority). The server only matchmakes, assigns teams (balanced),
  // tracks the 'waiting'|'playing'|'ended' status, and fans relay payloads out to everyone else.
  // Like DOOM, none of the Pong game state is touched.
  private ntSlots: WebSocket[] = [];
  private ntTeams = new Map<WebSocket, number>(); // ws → team (0 red / 1 blue)
  private ntStatus: 'waiting' | 'playing' = 'waiting';
  private ntStartedAt = 0; // epoch ms the current match started (for the min-length reward guard)

  // --- Beta "World" (free-roam overworld) ---
  // A shared top-down town players walk around. Positions are client-authoritative; we just
  // store them (clamped) and fan everyone-in-the-world's positions back out. broadcast() calls
  // broadcastWorld() every tick, but it only sends every WORLD_BROADCAST_EVERY ticks (~15 Hz —
  // plenty smooth for walking, a fraction of the bandwidth of the 60 Hz Pong state).
  private world = new World();
  private worldBcTick = 0;
  private static readonly WORLD_BROADCAST_EVERY = 4; // 60 Hz / 4 ≈ 15 Hz position updates
  // Day/night clock offset, randomized once per server boot so each deploy starts at a random time
  // of day (sent to clients in the first `you`). 8h cycle, so any ms in [0, 8h) shifts the phase.
  private static readonly DAY_NIGHT_OFFSET = Math.floor(Math.random() * 8 * 3_600_000);
  // Economy Overhaul: netizen bot traders. Seeded once from the House; they appear on the
  // net-worth board automatically (getNetWorthLeaderboard includes everyone).
  private static readonly NETIZEN_START_COINS = 5000;
  // Netizens mill around the town-centre plaza (mirrors client/world.ts PLAZA at 1600,1100 r240).
  private static readonly PLAZA = { x: 1600, y: 1100 };
  private static readonly NETIZEN_NAMES = [
    'satoshi_jr', 'diamond_paws', 'moonboy420', 'hodl_hannah', 'paperhands_pete',
    'algo_andy', 'bagholder_bo', 'shorty_sue', 'whale_watcher', 'degen_dana',
  ];
  private static readonly NETIZEN_COLORS = [
    '#f0a030', '#30c8f0', '#e040e0', '#f06080', '#80c870',
    '#c8a0f0', '#f0d060', '#50e0b0', '#ff7a50', '#78c0f0',
  ];
  private static netizenColor(pid: string): string {
    const idx = Number(pid.split(':')[1] ?? 0);
    return Lobby.NETIZEN_COLORS[idx % Lobby.NETIZEN_COLORS.length] ?? '#888';
  }

  // Loot box: a fixed coin price (flows to the House) that rolls a weighted prize. A coin roll
  // (or a degraded capped-out exclusive) pays this much from the House.
  private static readonly LOOT_PRICE = 2500;

  private static readonly NT_CAP = 6;
  private static readonly NT_WIN_REWARD = 750; // coins each winning-team player earns per match
  private static readonly NT_MIN_MATCH_MS = 60_000; // matches shorter than this don't pay (anti-farm)

  /** Take a slot in the Nuketown lobby (max 6), assigned to the smaller team for balance. */
  ntJoin(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return;
    if (this.ntSlots.includes(ws) || this.ntSlots.length >= Lobby.NT_CAP) return;
    // Balance teams: join whichever side currently has fewer players (ties → red/0).
    let red = 0, blue = 0;
    for (const t of this.ntTeams.values()) (t === 0 ? red++ : blue++);
    this.ntSlots.push(ws);
    this.ntTeams.set(ws, red <= blue ? 0 : 1);
    this.broadcastNtLobby();
  }

  /** Leave the Nuketown lobby/match. If the HOST (slot 0) left, end the match for everyone. */
  ntLeave(ws: WebSocket) {
    const i = this.ntSlots.indexOf(ws);
    if (i === -1) return;
    const wasHost = i === 0;
    this.ntSlots.splice(i, 1);
    this.ntTeams.delete(ws);
    if (wasHost) {
      // The authority is gone — there's no one to simulate the match, so tear it down for all
      // remaining participants and reset the lobby.
      for (const other of this.ntSlots) {
        this.tell(other, { type: 'ntLobby', status: 'ended', slot: 0, hostSlot: 0, players: [] });
      }
      this.ntSlots = [];
      this.ntTeams.clear();
      this.ntStatus = 'waiting';
      return;
    }
    // A non-host left: if everyone but the host has gone the match falls back to waiting.
    if (this.ntSlots.length <= 1) this.ntStatus = 'waiting';
    this.broadcastNtLobby();
  }

  /** (Host only) flip the lobby to 'playing' and broadcast — kicks off the match for everyone. */
  ntStart(ws: WebSocket) {
    if (this.ntSlots[0] !== ws) return; // only the host (slot 0) may start
    if (this.ntSlots.length < 2) return; // need at least 2 players
    this.ntStatus = 'playing';
    this.ntStartedAt = Date.now();
    this.broadcastNtLobby();
  }

  /** (Host only) settle a finished Nuketown match: pay every player on the winning team the win
   *  reward. Guards: only the host may report, only while a match is live (status flips to
   *  'waiting' so it pays out exactly once), the winning team must be valid (a draw reports -1
   *  and pays no one), and the match must have lasted a minimum length so a host can't farm coins
   *  with instant "wins". */
  ntEnd(ws: WebSocket, winningTeam: number) {
    if (this.ntSlots[0] !== ws) return;        // only the authoritative host reports the result
    if (this.ntStatus !== 'playing') return;   // already settled, or never started — ignore
    this.ntStatus = 'waiting';                 // settle once; any further ntEnd is a no-op
    if (winningTeam !== 0 && winningTeam !== 1) return;             // draw / invalid → no payout
    if (Date.now() - this.ntStartedAt < Lobby.NT_MIN_MATCH_MS) return; // too short to be real
    for (const sock of this.ntSlots) {
      if (this.ntTeams.get(sock) !== winningTeam) continue;
      const conn = this.conns.get(sock);
      if (!conn || !conn.pid) continue;
      this.housePay(conn.pid, conn.nickname, Lobby.NT_WIN_REWARD)
        .then((paid) => {
          this.sendWallet(sock); this.refreshNetWorth().catch(() => {});
          if (paid > 0) this.notify(sock, `🏆 Your team won Nuketown — +${paid.toLocaleString()} coins!`);
        })
        .catch((e) => console.error('nuketown reward failed:', e));
    }
  }

  /** Forward an opaque Nuketown payload to every OTHER participant (dumb fan-out). */
  ntRelay(ws: WebSocket, data: unknown) {
    if (!this.ntSlots.includes(ws)) return;
    for (const other of this.ntSlots) {
      if (other !== ws) this.tell(other, { type: 'ntRelay', data });
    }
  }

  private broadcastNtLobby() {
    const players = this.ntSlots.map((sock, slot) => ({
      name: this.conns.get(sock)?.nickname ?? `P${slot}`,
      team: this.ntTeams.get(sock) ?? 0,
      slot,
    }));
    this.ntSlots.forEach((sock, slot) => {
      this.tell(sock, { type: 'ntLobby', status: this.ntStatus, slot, hostSlot: 0, players });
    });
  }

  // --- Street Demons: Grand Prix (4-player pseudo-3D racer) ---
  // Mirrors the Nuketown subsystem exactly: host-authoritative over a dumb broadcast relay. The
  // server only matchmakes (up to 4 human racers), tracks 'waiting'|'playing' status, fans relay
  // payloads out, and pays the winning racer. The host (slot 0) runs the whole sim and fills any
  // empty grid slots with bots, so a single player can still race a full 4-car field. None of the
  // Pong game state is touched.
  private srSlots: WebSocket[] = [];
  private srStatus: 'waiting' | 'playing' = 'waiting';
  private srStartedAt = 0; // epoch ms the current race started (anti-farm reward guard)

  private static readonly SR_CAP = 4;            // most human racers (rest of the grid is bots)
  private static readonly SR_WIN_REWARD = 600;   // coins the winning human racer earns
  private static readonly SR_MIN_MATCH_MS = 30_000; // races shorter than this don't pay out

  /** Take a grid slot in the Street Demons lobby (max 4 humans). */
  srJoin(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return;
    if (this.srSlots.includes(ws) || this.srSlots.length >= Lobby.SR_CAP) return;
    this.srSlots.push(ws);
    this.broadcastSrLobby();
  }

  /** Leave the Street Demons lobby/race. If the HOST (slot 0) left, end the race for everyone. */
  srLeave(ws: WebSocket) {
    const i = this.srSlots.indexOf(ws);
    if (i === -1) return;
    const wasHost = i === 0;
    this.srSlots.splice(i, 1);
    if (wasHost) {
      // The authority is gone — no one to run the sim, so tear it down for everyone remaining.
      for (const other of this.srSlots) {
        this.tell(other, { type: 'srLobby', status: 'ended', slot: 0, hostSlot: 0, players: [] });
      }
      this.srSlots = [];
      this.srStatus = 'waiting';
      return;
    }
    this.broadcastSrLobby();
  }

  /** (Host only) flip the lobby to 'playing' — kicks off the race. A lone host is fine: it fills
   *  the rest of the grid with bots client-side. */
  srStart(ws: WebSocket) {
    if (this.srSlots[0] !== ws) return; // only the host (slot 0) may start
    if (this.srSlots.length < 1) return;
    this.srStatus = 'playing';
    this.srStartedAt = Date.now();
    this.broadcastSrLobby();
  }

  /** (Host only) settle a finished race: pay the winning human racer the win reward. Guards mirror
   *  ntEnd — only the host may report, only while a race is live (status flips to 'waiting' so it
   *  pays exactly once), the winning slot must map to a seated human (a bot win reports -1 and pays
   *  no one), and the race must have lasted a minimum length so a host can't farm instant wins. */
  srEnd(ws: WebSocket, winner: number) {
    if (this.srSlots[0] !== ws) return;       // only the authoritative host reports the result
    if (this.srStatus !== 'playing') return;  // already settled, or never started — ignore
    this.srStatus = 'waiting';                // settle once; any further srEnd is a no-op
    const sock = this.srSlots[winner];
    if (!sock) return;                        // a bot won (or invalid slot) → no payout
    if (Date.now() - this.srStartedAt < Lobby.SR_MIN_MATCH_MS) return; // too short to be real
    const conn = this.conns.get(sock);
    if (!conn || !conn.pid) return;
    this.housePay(conn.pid, conn.nickname, Lobby.SR_WIN_REWARD)
      .then((paid) => {
        this.sendWallet(sock); this.refreshNetWorth().catch(() => {});
        if (paid > 0) this.notify(sock, `🏁 You won the Grand Prix — +${paid.toLocaleString()} coins!`);
      })
      .catch((e) => console.error('street demons reward failed:', e));
  }

  /** Forward an opaque Street Demons payload to every OTHER racer (dumb fan-out). */
  srRelay(ws: WebSocket, data: unknown) {
    if (!this.srSlots.includes(ws)) return;
    for (const other of this.srSlots) {
      if (other !== ws) this.tell(other, { type: 'srRelay', data });
    }
  }

  private broadcastSrLobby() {
    const players = this.srSlots.map((sock, slot) => ({
      name: this.conns.get(sock)?.nickname ?? `P${slot}`,
      slot,
    }));
    this.srSlots.forEach((sock, slot) => {
      this.tell(sock, { type: 'srLobby', status: this.srStatus, slot, hostSlot: 0, players });
    });
  }

  // --- Super Tsong Bros (PvP platform fighter) ---
  // A clone of the Nuketown subsystem: up to 4 players free-for-all, host-authoritative over a
  // dumb broadcast relay. The server only matchmakes the lobby, tracks each player's chosen
  // fighter (for the all-locked start gate), tracks 'waiting'|'playing' status, and fans relay
  // payloads out. Slot 0 (first joiner) is the host/authority and runs the whole match client-side.
  // The win reward is House-funded and paid once per match to the reported winning slot, behind
  // host-only + status + min-length guards (same anti-farm shape as Nuketown). No Pong state touched.
  private sbSlots: WebSocket[] = [];
  private sbFighters = new Map<WebSocket, string | null>(); // ws → locked fighter id (null = not picked)
  private sbStatus: 'waiting' | 'playing' = 'waiting';
  private sbStartedAt = 0; // epoch ms the current match started (min-length reward guard)
  private static readonly SB_CAP = 4;
  private static readonly SB_WIN_REWARD = 1000; // coins the winner earns per match
  private static readonly SB_MIN_MATCH_MS = 30_000; // matches shorter than this don't pay (anti-farm)

  /** Take a slot in the Super Tsong Bros lobby (max 4). Joins with no fighter picked yet. */
  sbJoin(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return;
    if (this.sbSlots.includes(ws) || this.sbSlots.length >= Lobby.SB_CAP) return;
    if (this.sbStatus === 'playing') return; // can't hop into a running match (pick before the next one)
    this.sbSlots.push(ws);
    this.sbFighters.set(ws, null);
    this.broadcastSbLobby();
  }

  /** Lock in (or change, while waiting) the fighter for this player's slot. */
  sbPick(ws: WebSocket, fighter: string) {
    if (!this.sbSlots.includes(ws)) return;
    if (this.sbStatus === 'playing') return; // locked once the match is live
    if (!FIGHTERS.some((f) => f.id === fighter)) return; // must be a real fighter id
    this.sbFighters.set(ws, fighter);
    this.broadcastSbLobby();
  }

  /** Leave the lobby/match. If the HOST (slot 0) left, end the match for everyone. */
  sbLeave(ws: WebSocket) {
    const i = this.sbSlots.indexOf(ws);
    if (i === -1) return;
    const wasHost = i === 0;
    this.sbSlots.splice(i, 1);
    this.sbFighters.delete(ws);
    if (wasHost) {
      // The authority is gone — no one can simulate the match. Tear it down for everyone left.
      for (const other of this.sbSlots) {
        this.tell(other, { type: 'sbLobby', status: 'ended', slot: 0, hostSlot: 0, players: [] });
      }
      this.sbSlots = [];
      this.sbFighters.clear();
      this.sbStatus = 'waiting';
      return;
    }
    if (this.sbSlots.length <= 1) this.sbStatus = 'waiting';
    this.broadcastSbLobby();
  }

  /** (Host only) start the match. Requires ≥2 players AND every player to have locked a fighter. */
  sbStart(ws: WebSocket) {
    if (this.sbSlots[0] !== ws) return;            // only the host (slot 0) may start
    if (this.sbSlots.length < 2) return;           // need at least 2 players
    if (!this.sbSlots.every((s) => this.sbFighters.get(s))) return; // all-locked gate
    this.sbStatus = 'playing';
    this.sbStartedAt = Date.now();
    this.broadcastSbLobby();
  }

  /** (Host only) settle a finished match: pay the reported winning slot the House-funded reward.
   *  Guards: host-only, only while live (status flips to 'waiting' so it pays exactly once), the
   *  winner slot must be valid, and the match must have lasted a minimum length (anti-farm). */
  sbEnd(ws: WebSocket, winnerSlot: number) {
    if (this.sbSlots[0] !== ws) return;          // only the authoritative host reports
    if (this.sbStatus !== 'playing') return;     // already settled / never started — ignore
    this.sbStatus = 'waiting';                   // settle once; any further sbEnd is a no-op
    const winSock = this.sbSlots[winnerSlot];
    if (winnerSlot < 0 || !winSock) { this.broadcastSbLobby(); return; } // invalid → no payout
    if (Date.now() - this.sbStartedAt < Lobby.SB_MIN_MATCH_MS) { this.broadcastSbLobby(); return; }
    const conn = this.conns.get(winSock);
    if (conn && conn.pid) {
      this.housePay(conn.pid, conn.nickname, Lobby.SB_WIN_REWARD)
        .then((paid) => {
          this.sendWallet(winSock); this.refreshNetWorth().catch(() => {});
          if (paid > 0) this.notify(winSock, `🥊 You won Super Tsong Bros — +${paid.toLocaleString()} coins!`);
        })
        .catch((e) => console.error('super tsong bros reward failed:', e));
    }
    this.broadcastSbLobby();
  }

  /** Forward an opaque Super Tsong Bros payload to every OTHER participant (dumb fan-out). */
  sbRelay(ws: WebSocket, data: unknown) {
    if (!this.sbSlots.includes(ws)) return;
    for (const other of this.sbSlots) {
      if (other !== ws) this.tell(other, { type: 'sbRelay', data });
    }
  }

  private broadcastSbLobby() {
    const players = this.sbSlots.map((sock, slot) => ({
      name: this.conns.get(sock)?.nickname ?? `P${slot}`,
      slot,
      fighter: this.sbFighters.get(sock) ?? null,
    }));
    this.sbSlots.forEach((sock, slot) => {
      this.tell(sock, { type: 'sbLobby', status: this.sbStatus, slot, hostSlot: 0, players });
    });
  }

  // --- Beta World (free-roam overworld) ---

  /** Step a player into the world map. Sends them the current roster right away so they see
   *  everyone the instant they arrive (instead of waiting for the next broadcast tick). */
  worldEnter(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return; // must have joined (need a name to show)
    // Evict any STALE avatar of this same identity still in the world (e.g. a previous tab/socket
    // that hasn't closed yet) — otherwise it lingers as a frozen "clone" of you (most obvious in jail).
    if (conn.pid) {
      for (const other of [...this.world.sockets()]) {
        if (other !== ws && this.conns.get(other)?.pid === conn.pid) this.world.leave(other);
      }
    }
    this.world.enter(ws);
    if (conn.jailed) {
      // Walked in already locked up (persisted lockup) → drop them straight into the cell.
      this.world.move(ws, JAIL_CELL.x + JAIL_CELL.w / 2, JAIL_CELL.y + JAIL_CELL.h / 2);
      this.tell(ws, { type: 'jailed', jailed: true });
    }
    this.tell(ws, { type: 'world', avatars: this.worldAvatars() });
    this.sendLand(ws); // push the Robville land book so lots show their owners/for-sale signs
  }

  /** Step a player out of the world map. */
  worldLeave(ws: WebSocket) {
    this.world.leave(ws);
  }

  /** Record a client's self-reported avatar position. Jailed players are pinned to the cell. */
  worldMove(ws: WebSocket, x: number, y: number, a?: number, car?: string | null, pet?: string | null) {
    const conn = this.conns.get(ws);
    if (conn?.jailed) {
      const cx = Math.max(JAIL_CELL.x, Math.min(JAIL_CELL.x + JAIL_CELL.w, x));
      const cy = Math.max(JAIL_CELL.y, Math.min(JAIL_CELL.y + JAIL_CELL.h, y));
      this.world.move(ws, cx, cy, a, null, pet); // no car while jailed
      return;
    }
    this.world.move(ws, x, y, a, car, pet);
  }

  /** Snapshot every in-world avatar (human + netizen). */
  private worldAvatars(): WorldAvatar[] {
    const out: WorldAvatar[] = [];
    for (const ws of this.world.sockets()) {
      const c = this.conns.get(ws);
      const p = this.world.positionOf(ws);
      if (!c || !p) continue;
      out.push({ id: c.id, name: c.nickname || 'anon', color: c.color, x: p.x, y: p.y, a: p.a, car: p.car, pet: p.pet, jailed: c.jailed });
    }
    // Append spawned netizen avatars.
    for (let i = 0; i < Lobby.NETIZEN_NAMES.length; i++) {
      const pid = `netizen:${i}`;
      const pos = this.netizenPos.get(pid);
      if (!pos || Date.now() < pos.spawnAt) continue;
      out.push({
        id: pid,
        name: Lobby.NETIZEN_NAMES[i],
        color: Lobby.netizenColor(pid),
        x: pos.x, y: pos.y,
        bot: true,
      });
    }
    return out;
  }

  /** All solid rects netizens must avoid: buildings + jail walls. */
  private static SOLID_RECTS: readonly { x: number; y: number; w: number; h: number }[] = [
    ...WORLD_BUILDINGS,
    // Jail walls (same layout as client/world.ts JAIL_WALLS).
    { x: JAIL.x, y: JAIL.y, w: JAIL.w, h: JAIL_WALL },
    { x: JAIL.x, y: JAIL.y, w: JAIL_WALL, h: JAIL.h },
    { x: JAIL.x + JAIL.w - JAIL_WALL, y: JAIL.y, w: JAIL_WALL, h: JAIL.h },
    { x: JAIL.x, y: JAIL.y + JAIL.h - JAIL_WALL, w: JAIL.w, h: JAIL_WALL },
  ];

  /** Push a point out of every solid rect it overlaps (mirrors client/resolveCollisions).
   *  Returns the adjusted position and whether a collision occurred. */
  private static resolveNetizenCollision(x: number, y: number, rad: number): { x: number; y: number; hit: boolean } {
    let hit = false;
    for (const b of Lobby.SOLID_RECTS) {
      const nx = Math.max(b.x, Math.min(b.x + b.w, x));
      const ny = Math.max(b.y, Math.min(b.y + b.h, y));
      const dx = x - nx, dy = y - ny;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rad * rad) continue;
      hit = true;
      if (d2 > 0.0001) {
        const d = Math.sqrt(d2);
        x = nx + (dx / d) * rad;
        y = ny + (dy / d) * rad;
      } else {
        const left = x - b.x, right = b.x + b.w - x, top = y - b.y, bottom = b.y + b.h - y;
        const m = Math.min(left, right, top, bottom);
        if (m === left) x = b.x - rad;
        else if (m === right) x = b.x + b.w + rad;
        else if (m === top) y = b.y - rad;
        else y = b.y + b.h + rad;
      }
    }
    x = Math.max(rad, Math.min(WORLD.w - rad, x));
    y = Math.max(rad, Math.min(WORLD.h - rad, y));
    return { x, y, hit };
  }

  /** Wander netizen avatars and fan everyone's positions out. Called every tick by broadcast();
   *  throttled to ~15 Hz. Also runs when no humans are in the world to keep netizens moving. */
  broadcastWorld() {
    const now = Date.now();
    const dt = 1 / 60;
    const speed = 64;
    const netizenR = 16;
    for (let i = 0; i < Lobby.NETIZEN_NAMES.length; i++) {
      const pid = `netizen:${i}`;
      const pos = this.netizenPos.get(pid);
      if (!pos || now < pos.spawnAt) continue;
      if (now >= pos.pauseUntil) {
        // Walk toward the current target.
        const dx = pos.tx - pos.x, dy = pos.ty - pos.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 8) {
          // Reached target — pause, then pick a new random spot.
          pos.pauseUntil = now + 800 + Math.random() * 2500;
          // Roam the whole town, not just the fountain: targets anywhere within ~1000 units of the
          // plaza so the netizens spread out around the map instead of clustering at the centre.
          const a = Math.random() * Math.PI * 2, r = 200 + Math.random() * 800;
          pos.tx = Lobby.PLAZA.x + Math.cos(a) * r;
          pos.ty = Lobby.PLAZA.y + Math.sin(a) * r;
        } else {
          const stepped = Lobby.resolveNetizenCollision(
            pos.x + (dx / dist) * speed * dt,
            pos.y + (dy / dist) * speed * dt,
            netizenR,
          );
          pos.x = stepped.x;
          pos.y = stepped.y;
          if (stepped.hit) {
            // Bumped into something — pick a new wander target so we don't keep
            // walking into the same wall and getting stuck.
            pos.pauseUntil = now + 400 + Math.random() * 800;
            const a = Math.random() * Math.PI * 2, r = 200 + Math.random() * 800;
            pos.tx = Lobby.PLAZA.x + Math.cos(a) * r;
            pos.ty = Lobby.PLAZA.y + Math.sin(a) * r;
          }
        }
      }
    }
    if (this.world.size === 0) return; // no humans to send to
    if (++this.worldBcTick % Lobby.WORLD_BROADCAST_EVERY !== 0) return;
    const data = JSON.stringify({ type: 'world', avatars: this.worldAvatars() });
    for (const ws of this.world.sockets()) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  // DOOM high-round leaderboards (solo + co-op), cached and pushed to clients.
  private doomBoards: { solo: DoomScoreRow[]; coop: DoomScoreRow[] } = { solo: [], coop: [] };
  private campaignBoard: CampaignScoreRow[] = [];
  private fishBoard: FishingScoreRow[] = [];
  // Anti-abuse: last fishing payout time per pid (ms). Claims faster than FISH_COOLDOWN_MS are
  // ignored, so a scripted client can't spam the House for coins.
  private lastFishAt = new Map<string, number>();
  private static readonly FISH_COOLDOWN_MS = 2500;
  // House-funded reward range per tier (server picks an amount within the range; client only
  // sends the tier, never a coin amount). Legendary is a flat jackpot + the Angler title.
  private static readonly FISH_REWARDS: Record<string, [number, number]> = {
    junk: [0, 10], common: [50, 120], uncommon: [160, 360], rare: [700, 1500], legendary: [3500, 3500],
  };

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
    // Reward stacks per round: round 1 pays 50, round 2 adds 100, round 3 adds 150, … so the
    // total for reaching round r is 50·(1+2+…+r) = 25·r·(r+1) (e.g. R2 → 150, R5 → 750). Every
    // run, no gating — DOOM is a grindable coin faucet on purpose that scales with how far you get.
    if (conn.pid) {
      const reward = 25 * r * (r + 1);
      // House-funded (throttled when the treasury is low). Surface the CREDITED amount, not the ask.
      this.housePay(conn.pid, conn.nickname, reward)
        .then((paid) => {
          this.sendWallet(ws); this.refreshNetWorth().catch(() => {});
          if (paid > 0) this.notify(ws, `🪙 +${paid.toLocaleString()} coins for reaching round ${r} in DOOM!`);
        })
        .catch((e) => console.error('doom reward failed:', e));
    }
  }

  // --- Fishing minigame ---

  /** Reload the biggest-catch leaderboard from the DB and push it to everyone. */
  async refreshFishLeaderboard() {
    this.fishBoard = await getFishingLeaderboard();
    const msg = JSON.stringify({ type: 'fishLeaderboard', rows: this.fishBoard });
    for (const sock of this.conns.keys()) {
      if (sock.readyState === sock.OPEN) sock.send(msg);
    }
  }

  /** A landed fish: validate the tier + size, rate-limit, pay a House-funded reward by tier, and
   *  (for legendaries) grant the one-time Angler title. The client never sends a coin amount — the
   *  server picks the payout from the tier's range, so a tampered client can't mint money. */
  fishCatch(ws: WebSocket, tier: string, sizeLb: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    const range = Lobby.FISH_REWARDS[tier];
    if (!range) return;                                   // unknown tier
    if (!Number.isFinite(sizeLb) || sizeLb <= 0) return;  // bad size
    const pid = conn.pid, nick = conn.nickname;
    // Rate-limit: at most one payout per FISH_COOLDOWN_MS per player (stops scripted spam).
    const now = Date.now();
    const last = this.lastFishAt.get(pid) ?? 0;
    if (now - last < Lobby.FISH_COOLDOWN_MS) return;
    this.lastFishAt.set(pid, now);

    // Record the catch for the biggest-catch board (keeps each player's max).
    recordFishCatch(pid, nick, sizeLb)
      .then(() => this.refreshFishLeaderboard())
      .catch((e) => console.error('fish catch save failed:', e));

    // House-funded reward: a server-picked amount within the tier's range.
    const [lo, hi] = range;
    const reward = lo + Math.floor(Math.random() * (hi - lo + 1));
    const legendary = tier === 'legendary';

    const finish = (item?: { id: string; name: string }) => {
      this.housePay(pid, nick, reward)
        .then((paid) => {
          this.sendWallet(ws); this.refreshNetWorth().catch(() => {});
          this.tell(ws, { type: 'fishReward', coins: paid, item });
        })
        .catch((e) => console.error('fish reward failed:', e));
    };

    if (legendary) {
      // Landing a legendary unlocks the "Angler" title (and "Big Catch" if not yet held).
      awardTitle(pid, nick, 'bigcatch').catch(() => {});
      awardTitle(pid, nick, 'angler')
        .then((w) => {
          if (w) { conn.title = w.title; this.refreshLeaderboard(); }
          const cos = COSMETICS.find((c) => c.id === 'angler');
          finish(cos ? { id: cos.id, name: cos.name } : undefined);
          this.announce(`🎣 ${nick} landed a LEGENDARY catch (${Math.round(sizeLb)} lb) and earned the Angler title!`);
        })
        .catch((e) => { console.error('angler title award failed:', e); finish(); });
    } else if (tier === 'rare') {
      // Landing a rare fish for the first time unlocks the "Big Catch" title.
      awardTitle(pid, nick, 'bigcatch')
        .then((w) => {
          if (w) { conn.title = w.title; this.refreshLeaderboard(); }
          const cos = COSMETICS.find((c) => c.id === 'bigcatch');
          finish(cos && w ? { id: cos.id, name: cos.name } : undefined);
        })
        .catch((e) => { console.error('bigcatch title award failed:', e); finish(); });
    } else {
      finish();
    }
  }

  // --- "Type or Die" co-op arena ---

  /** A client opens the Type or Die overlay / drops into the arena. */
  tdJoin(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return;
    this.tdSockets.set(conn.id, ws);
    this.typeGame.join(conn.id, conn.nickname, conn.color);
    this.tell(ws, { type: 'tdLeaderboard', rows: this.tdBoard });
  }

  /** A client closes the overlay / leaves the arena. */
  tdLeave(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn) return;
    this.tdSockets.delete(conn.id);
    this.typeGame.leave(conn.id);
  }

  /** Any participant kicks off the next run from the waiting room. */
  tdStart(ws: WebSocket) {
    if (!this.tdSockets.has(this.conns.get(ws)?.id ?? '')) return;
    this.typeGame.start();
  }

  /** Soft-lock the monster a client is mid-word on (so others don't fight the same word). */
  tdTarget(ws: WebSocket, id: number | null) {
    const conn = this.conns.get(ws);
    if (!conn || !this.tdSockets.has(conn.id)) return;
    this.typeGame.target(conn.id, id);
  }

  /** A client finished typing a word — claim the kill (validated server-side). */
  tdKill(ws: WebSocket, id: number) {
    const conn = this.conns.get(ws);
    if (!conn || !this.tdSockets.has(conn.id)) return;
    this.typeGame.claimKill(conn.id, id);
  }

  // --- Nomic (the Parliament) ---

  /** A player walks into the Parliament: seat them as a legislator + subscribe to the floor. */
  nomEnter(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    this.nomSockets.set(conn.pid, ws);
    this.nomGame.enter(conn.pid, conn.nickname, conn.color); // → onChange → broadcast (reaches the new socket)
  }

  /** A player leaves the Parliament (or disconnects): drop them from the rotation (score persists). */
  nomLeave(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid) return;
    if (!this.nomSockets.delete(conn.pid)) return;
    this.nomGame.leave(conn.pid);
  }

  /** The Speaker puts a rule change on the floor. */
  nomPropose(ws: WebSocket, kind: NomProposalKind, text: string, target?: number, effect?: NomEffect | null, ruleClass?: 'immutable' | 'mutable') {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid || !this.nomSockets.has(conn.pid)) return;
    const err = this.nomGame.propose(conn.pid, kind, text, target, effect, ruleClass);
    if (err) this.tell(ws, { type: 'announce', text: `🏛️ ${err}`, toast: true });
  }

  /** Cast a vote on the proposal currently on the floor. */
  nomVote(ws: WebSocket, vote: NomVote) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid || !this.nomSockets.has(conn.pid)) return;
    const err = this.nomGame.vote(conn.pid, vote);
    if (err) this.tell(ws, { type: 'announce', text: `🏛️ ${err}`, toast: true });
  }

  /** The Speaker calls the vote and resolves the floor early. */
  nomResolve(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid || !this.nomSockets.has(conn.pid)) return;
    const err = this.nomGame.resolve(conn.pid);
    if (err) this.tell(ws, { type: 'announce', text: `🏛️ ${err}`, toast: true });
  }

  /** Fan the parliament state out to everyone in the building (per-recipient `you`/`yourTurn`). */
  private broadcastNomic() {
    for (const [pid, ws] of this.nomSockets) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(this.nomGame.viewFor(pid)));
    }
  }

  /** Reload the Type or Die best-wave leaderboard from the DB and push it to everyone. */
  async refreshTypeDieLeaderboard() {
    this.tdBoard = await getTypeDieLeaderboard();
    const msg = JSON.stringify({ type: 'tdLeaderboard', rows: this.tdBoard });
    for (const sock of this.conns.keys()) {
      if (sock.readyState === sock.OPEN) sock.send(msg);
    }
  }

  /** Fan the Type or Die state out to its participants (~30 Hz; only when anyone's in it). */
  private broadcastTypeDie() {
    if (!this.typeGame.active) return;
    if (++this.tdBroadcastTick % 2 !== 0) return; // throttle 60 Hz → ~30 Hz
    const snap = this.typeGame.snapshot();
    for (const [id, ws] of this.tdSockets) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'tdState', you: id, ...snap }));
    }
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
        this.mintMatchHouse(); // pong mines coins for the treasury
      }
      this.settleBets(winnerSide); // pay out spectator wagers on this match
      // Winning the championship pays 100 coins per player in the field (400 or 800),
      // plus a free bonus wheel spin (usable even while the daily spin is on cooldown).
      if (t.status === 'done' && winners[0]?.pid) {
        const champ = winners[0];
        const prize = t.size * COIN_SCALE;
        Promise.all([
          this.housePay(champ.pid, champ.nickname, prize), // House-funded prize (throttled when low)
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
  private spawnBot(side: Side, level: BotLevel, overrides?: { reactOverride?: number; errorPxOverride?: number }) {
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
      song: null,
      crapsPoint: null,
      drunkLevel: 0,
      drunkUntil: 0,
      jailed: false,
    };
    this.conns.set(ws, conn);
    this.teams[side].push(ws);
    this.game.addPlayer(side, conn.id);
    this.bot = {
      ws, side, id: conn.id, level, reactTimer: 0, aimY: COURT.h / 2,
      reactOverride: overrides?.reactOverride,
      errorPxOverride: overrides?.errorPxOverride,
    };
  }

  // Tear the bot out of its seat. A bot leaving never crowns a king and never leaves the
  // duel frozen on an 'over' screen — it always returns the room to a clean waiting state.
  private removeBotInternal() {
    if (!this.bot) return;
    const { ws, side: botSide, id } = this.bot;
    // Settle an active netizen challenge before tearing down the bot.
    if (this.pendingChallenge) {
      const c = this.pendingChallenge;
      const winnerSide = this.game.winnerSide;
      const humanWon = winnerSide && winnerSide !== botSide;
      const delta = humanWon ? c.wager : -c.wager;
      addCoins(c.playerPid, c.playerName, delta).then(() => {
        if (this.conns.has(c.playerWs)) this.sendWallet(c.playerWs);
      }).catch(() => {});
      addCoins(c.netizenPid, c.netizenName, -delta).then(() => {
        this.refreshNetWorth().catch(() => {});
      }).catch(() => {});
      this.tell(c.playerWs, {
        type: 'netizenChallengeResult',
        won: !!humanWon,
        delta: Math.abs(delta),
        netizenName: c.netizenName,
      });
      this.refreshNetWorth().catch(() => {});
      this.pendingChallenge = null;
    }
    this.bot = null;
    this.botOverTimer = 0;
    this.teams[botSide] = this.teams[botSide].filter((s) => s !== ws);
    this.game.removePlayer(botSide, id);
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
    const react = this.bot.reactOverride ?? cfg.react;
    const errPx = this.bot.errorPxOverride ?? cfg.error;
    this.bot.reactTimer -= dt;
    if (this.bot.reactTimer <= 0) {
      this.bot.reactTimer = react;
      this.bot.aimY = this.botAim(this.bot.side, { ...cfg, error: errPx });
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
    // Send their saved settings (mute, chat toggles, boss-key target) so they sync across devices.
    this.sendPrefs(ws);
    // Send the stock market: global price board + this player's positions.
    this.sendStocks(ws);
    // Send their loan status (so the Get Loan panel knows whether they owe Davis).
    this.sendLoan(ws);
    // Send the active-bounties board so heads show their pot right away.
    this.sendBounties(ws);
    // Send the House treasury balance (drives the market/casino header readout).
    this.tell(ws, { type: 'house', balance: Math.round(this.houseBalance) });
    // Send the news feed.
    this.sendNews(ws);
    // Now that we know who they are, re-send the standings pinned with their own row even if
    // they're below the visible top-N.
    this.sendBoardsTo(ws).catch((e) => console.error('board personalise failed:', e));
  }

  /** Push this player's stored settings to them (so they sync across devices on sign-in). */
  private sendPrefs(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid) return;
    getPrefs(conn.pid)
      .then((prefs) => { if (this.conns.has(ws)) this.tell(ws, { type: 'prefs', prefs }); })
      .catch((e) => console.error('prefs send failed:', e));
  }

  /** Persist a partial settings update for this player (merged into their stored set). Sanitized:
   *  string→string only, bounded key/value length and count, so a tampered client can't bloat it. */
  setPrefs(ws: WebSocket, patch: Record<string, unknown>) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid) return;
    const clean: Record<string, string> = {};
    let n = 0;
    for (const [k, v] of Object.entries(patch)) {
      if (typeof k !== 'string' || typeof v !== 'string') continue;
      if (k.length > 40 || v.length > 200) continue;
      clean[k] = v;
      if (++n >= 30) break;
    }
    if (!Object.keys(clean).length) return;
    savePrefs(conn.pid, conn.nickname ?? 'anon', clean).catch((e) => console.error('prefs save failed:', e));
  }

  /** Load a connection's wallet from the DB into memory and send it to that client. */
  private loadWallet(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid) return;
    // Restore a persisted jail lockup so a relog can't escape the cell. Tell the client right away so
    // a jailed player lands straight in the world-jail (not the pong menu) and can't start a match.
    getJailed(conn.pid).then((j) => {
      const c = this.conns.get(ws); if (!c) return;
      c.jailed = j;
      if (j) this.tell(ws, { type: 'jailed', jailed: true });
    }).catch(() => {});
    getWallet(conn.pid)
      .then((w) => {
        const c = this.conns.get(ws);
        if (!c) return;
        c.hat = w.hat;
        c.skin = w.skin;
        c.trail = w.trail;
        c.title = w.title;
        c.song = w.song;
        this.tell(ws, { type: 'wallet', coins: w.coins, owned: w.owned, hat: w.hat, skin: w.skin, trail: w.trail, title: w.title, song: w.song, car: w.car, pet: w.pet, exclusives: w.exclusives, bets: this.betsView(ws), nextSpinAt: nextSpinAt(w.lastSpin), bonusSpins: w.bonusSpins });
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
        c.hat = w.hat; c.skin = w.skin; c.trail = w.trail; c.title = w.title; c.song = w.song;
        this.tell(ws, { type: 'wallet', coins: w.coins, owned: w.owned, hat: w.hat, skin: w.skin, trail: w.trail, title: w.title, song: w.song, car: w.car, pet: w.pet, exclusives: w.exclusives, bets: this.betsView(ws), nextSpinAt: nextSpinAt(w.lastSpin), bonusSpins: w.bonusSpins });
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
  /** Buy a beer at the Tavern: 20🪙 into the House (a sink), one level drunker, 3-min timer reset.
   *  The bartender cuts you off at 6. */
  buyBeer(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    if (conn.drunkLevel >= DRUNK_MAX) {
      this.notify(ws, '🍺 The bartender cuts you off — six is plenty. Go sleep it off.');
      return;
    }
    spendCoins(conn.pid, BEER_COST)
      .then(async (w) => {
        if (!w) { this.notify(ws, '💸 You can\'t even afford a beer (20🪙). Rough.'); this.sendWallet(ws); return; }
        await this.houseCredit(BEER_COST); // the bar's takings go to the House
        conn.drunkLevel++;
        conn.drunkUntil = Date.now() + DRUNK_MS;
        this.sendWallet(ws);
        this.tell(ws, { type: 'drunk', level: conn.drunkLevel });
        const quip = [
          '🍺 Ahh, refreshing. (1)',
          '🍺 Two beers in. The room\'s a little warmer.',
          '🍺 Threeee. You feel GREAT. (the floor is moving though)',
          '🍺 Four! Everyone here is your best friend.',
          '🍺 Fiiive *hic* — who put all these walls up??',
          '🍺 Six. The bartender is eyeing you. This is your last one.',
        ][Math.min(conn.drunkLevel, DRUNK_MAX) - 1];
        this.notify(ws, quip);
      })
      .catch((e) => console.error('buy beer failed:', e));
  }

  /** Drunk-driving bust: the client self-reports a drive attempt; we verify they're actually 2+
   *  beers deep, then lock them in the jail cell (persisted) until someone posts bail. */
  jail(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid || conn.jailed || conn.drunkLevel < 2) return;
    conn.jailed = true;
    setJailed(conn.pid, true).catch((e) => console.error('jail persist failed:', e));
    if (this.world.has(ws)) this.world.move(ws, JAIL_CELL.x + JAIL_CELL.w / 2, JAIL_CELL.y + JAIL_CELL.h / 2);
    this.tell(ws, { type: 'jailed', jailed: true });
    this.notify(ws, `🚔 BUSTED for drunk driving! You're in the drunk tank until someone posts your ${BAIL_COST}🪙 bail.`);
    this.broadcastWorld();
  }

  /** Post a jailed player's bail (500🪙 → House). `targetId` is their avatar id. You CAN'T bail
   *  yourself — someone else has to come spring you. */
  bail(ws: WebSocket, targetId: string) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid) return;
    if (conn.id === targetId) { this.notify(ws, "🚔 You can't post your own bail — someone else has to come spring you."); return; }
    let tWs: WebSocket | null = null, tConn: Conn | null = null;
    for (const [w, c] of this.conns) { if (c.id === targetId) { tWs = w; tConn = c; break; } }
    if (!tWs || !tConn || !tConn.jailed) { this.notify(ws, "They're not locked up."); return; }
    const targetWs = tWs, target = tConn;
    spendCoins(conn.pid, BAIL_COST)
      .then(async (w) => {
        if (!w) { this.notify(ws, `Bail is ${BAIL_COST}🪙 — you're short.`); this.sendWallet(ws); return; }
        await this.houseCredit(BAIL_COST); // bail money goes to the House
        target.jailed = false;
        setJailed(target.pid, false).catch((e) => console.error('bail persist failed:', e));
        this.sendWallet(ws);
        this.tell(targetWs, { type: 'jailed', jailed: false });
        const self = targetWs === ws;
        this.notify(ws, self ? '🔓 You posted your own bail. Try to stay sober out there.' : `🔓 You bailed out ${target.nickname} for ${BAIL_COST}🪙. What a pal.`);
        if (!self) this.notify(targetWs, `🔓 ${conn.nickname} posted your ${BAIL_COST}🪙 bail — you're free!`);
        this.broadcastWorld();
      })
      .catch((e) => console.error('bail failed:', e));
  }

  shopBuy(ws: WebSocket, item: string) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    const cosmetic = COSMETICS.find((c) => c.id === item);
    if (!cosmetic || cosmetic.locked) return; // locked items (e.g. Davis Slayer) can't be bought
    buyItem(conn.pid, conn.nickname, cosmetic.id, cosmetic.price)
      .then(async (w) => {
        if (!w) return;                            // already owned or couldn't afford it
        await this.houseCredit(cosmetic.price);    // purchases are a transfer — the coins go to the House
        this.sendWallet(ws);
      })
      .catch((e) => console.error('shop buy failed:', e));
  }

  /** Equip (item) or unequip (null) a cosmetic in its slot. */
  shopEquip(ws: WebSocket, slot: 'hat' | 'skin' | 'trail' | 'title' | 'song' | 'car' | 'pet', item: string | null) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    if (item !== null) {
      // The item may be a regular cosmetic OR a scarce exclusive — both reuse the equip slots.
      const cosmetic = COSMETICS.find((c) => c.id === item);
      const exclusive = EXCLUSIVES.find((x) => x.id === item);
      const def = cosmetic ?? exclusive;
      if (!def || def.slot !== slot) return; // item must exist and match the slot
    }
    equipItem(conn.pid, slot, item)
      .then((w) => {
        if (!w) return;
        const c = this.conns.get(ws);
        if (c) { c.hat = w.hat; c.skin = w.skin; c.trail = w.trail; c.title = w.title; c.song = w.song; }
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
          // House-funded; the wheel always lands on the chosen segment, but the actual credit is
          // throttled when the House is low (the wallet refresh shows the real balance).
          await this.housePay(conn.pid, conn.nickname, def.value);
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
    // Wealth-scaled minimum bet: refuse a stake below the player's floor.
    getWallet(conn.pid).then((w) => {
      if (!w || total < minBet(w.coins)) { this.sendWallet(ws); return; }
      // Escrow the whole stake up front; if it doesn't clear, the player can't afford it.
      spendCoins(conn.pid, total)
      .then(async (w) => {
        if (!w) { this.sendWallet(ws); return; } // insufficient coins (or no DB) — nothing wagered
        // The staked coins flow into the House first (a sink); winnings are paid back from it.
        await this.houseCredit(total);
        const win = Math.floor(Math.random() * 37); // 0–36, single zero
        let want = 0;
        for (const b of bets) {
          if (rouletteWins(b, win)) want += b.amount * (ROULETTE_PAYOUTS[b.kind as RouletteBetKind] + 1);
        }
        // Pay winnings from the House. Report the CREDITED amount so the client never shows a
        // payout the House couldn't fund.
        const payout = want > 0 ? await this.housePay(conn.pid, conn.nickname, want) : 0;
        this.tell(ws, { type: 'rouletteResult', number: win, staked: total, payout });
        this.sendWallet(ws);
      })
      .catch((e) => console.error('roulette failed:', e));
    })
    .catch((e) => console.error('getWallet failed:', e));
  }

  // --- Blackjack ---

  blackjackBet(ws: WebSocket, amount: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid || !conn.nickname) return;
    if (conn.bjHand) { this.sendWallet(ws); return; } // already in a hand
    if (!Number.isInteger(amount) || amount <= 0 || amount > BJ_MAX_BET) { this.sendWallet(ws); return; }
    getWallet(conn.pid).then((w) => {
      if (!w || amount < minBet(w.coins)) { this.sendWallet(ws); return; }
      spendCoins(conn.pid, amount)
        .then(async (w) => {
          if (!w) { this.sendWallet(ws); return; }
          await this.houseCredit(amount);
          const shoe = bjFreshShoe();
          const hand: BjHand = {
            playerCards: [bjDeal(shoe), bjDeal(shoe)],
            dealerCards: [bjDeal(shoe), bjDeal(shoe)],
            bet: amount,
            shoe,
          };
          conn.bjHand = hand;
          const pt = bjTotal(hand.playerCards);
          const playerBJ = hand.playerCards.length === 2 && pt === 21;
          const dealerBJ = bjTotal(hand.dealerCards) === 21;
          if (playerBJ) {
            const outcome = dealerBJ ? 'push' : 'blackjack';
            const want = dealerBJ ? amount : Math.floor(amount * 2.5);
            const payout = want > 0 ? await this.housePay(conn.pid, conn.nickname, want) : 0;
            conn.bjHand = undefined;
            const msg: BjResultMsg = { type: 'bjResult', playerCards: hand.playerCards, dealerCards: hand.dealerCards, playerTotal: pt, dealerTotal: bjTotal(hand.dealerCards), outcome, bet: amount, payout };
            this.tell(ws, msg);
            this.sendWallet(ws);
            return;
          }
          const state: BjStateMsg = { type: 'bjState', playerCards: hand.playerCards, dealerCard: hand.dealerCards[0], playerTotal: pt, canDouble: true, status: 'playing' };
          this.tell(ws, state);
          this.sendWallet(ws);
        })
        .catch((e) => console.error('blackjack bet failed:', e));
    })
    .catch((e) => console.error('getWallet failed:', e));
  }

  blackjackAction(ws: WebSocket, action: BjAction) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.bjHand || !conn.pid || !conn.nickname) return;
    const hand = conn.bjHand;
    if (action === 'double') {
      if (hand.playerCards.length !== 2) return;
      spendCoins(conn.pid, hand.bet)
        .then(async (w) => {
          if (!w) {
            // Can't afford double — treat as hit
            hand.playerCards.push(bjDeal(hand.shoe));
            await this.bjFinishOrContinue(ws, conn, hand, false);
            return;
          }
          await this.houseCredit(hand.bet);
          hand.bet *= 2;
          hand.playerCards.push(bjDeal(hand.shoe));
          await this.bjStandAndSettle(ws, conn, hand);
        })
        .catch((e) => console.error('blackjack double failed:', e));
      return;
    }
    if (action === 'hit') {
      hand.playerCards.push(bjDeal(hand.shoe));
      this.bjFinishOrContinue(ws, conn, hand, false).catch((e) => console.error('blackjack hit failed:', e));
      return;
    }
    if (action === 'stand') {
      this.bjStandAndSettle(ws, conn, hand).catch((e) => console.error('blackjack stand failed:', e));
    }
  }

  private async bjFinishOrContinue(ws: WebSocket, conn: Conn, hand: BjHand, canDouble: boolean) {
    const pt = bjTotal(hand.playerCards);
    if (pt > 21) {
      conn.bjHand = undefined;
      const msg: BjResultMsg = { type: 'bjResult', playerCards: hand.playerCards, dealerCards: hand.dealerCards, playerTotal: pt, dealerTotal: bjTotal(hand.dealerCards), outcome: 'lose', bet: hand.bet, payout: 0 };
      this.tell(ws, msg);
      this.sendWallet(ws);
      return;
    }
    const state: BjStateMsg = { type: 'bjState', playerCards: hand.playerCards, dealerCard: hand.dealerCards[0], playerTotal: pt, canDouble, status: 'playing' };
    this.tell(ws, state);
  }

  private async bjStandAndSettle(ws: WebSocket, conn: Conn, hand: BjHand) {
    while (bjTotal(hand.dealerCards) < 17) hand.dealerCards.push(bjDeal(hand.shoe));
    const pt = bjTotal(hand.playerCards);
    const dt = bjTotal(hand.dealerCards);
    let outcome: 'win' | 'push' | 'lose';
    let want: number;
    if (dt > 21 || pt > dt) { outcome = 'win'; want = hand.bet * 2; }
    else if (pt === dt) { outcome = 'push'; want = hand.bet; }
    else { outcome = 'lose'; want = 0; }
    conn.bjHand = undefined;
    const payout = want > 0 ? await this.housePay(conn.pid!, conn.nickname!, want) : 0;
    const msg: BjResultMsg = { type: 'bjResult', playerCards: hand.playerCards, dealerCards: hand.dealerCards, playerTotal: pt, dealerTotal: dt, outcome, bet: hand.bet, payout };
    this.tell(ws, msg);
    this.sendWallet(ws);
  }

  // --- Street Craps ---

  crapsRoll(ws: WebSocket, pass: number, dontPass: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid || !conn.nickname) return;
    if (!Number.isInteger(pass) || pass < 0 || pass > CRAPS_MAX_BET) { this.sendWallet(ws); return; }
    if (!Number.isInteger(dontPass) || dontPass < 0 || dontPass > CRAPS_MAX_BET) { this.sendWallet(ws); return; }
    const total = pass + dontPass;
    if (total <= 0) return;
    const prevPoint = conn.crapsPoint;
    spendCoins(conn.pid, total)
      .then(async (w) => {
        if (!w) { this.sendWallet(ws); return; }
        await this.houseCredit(total);
        const d1 = Math.ceil(Math.random() * 6);
        const d2 = Math.ceil(Math.random() * 6);
        const sum = d1 + d2;
        let outcome: 'win' | 'lose' | 'point';
        let newPoint: number | null = prevPoint;
        let push12 = false;
        let passWant = 0, dontWant = 0;
        if (prevPoint === null) {
          if (sum === 7 || sum === 11) {
            outcome = 'win'; newPoint = null;
            passWant = pass * 2;
          } else if (sum === 2 || sum === 3) {
            outcome = 'lose'; newPoint = null;
            dontWant = dontPass * 2;
          } else if (sum === 12) {
            outcome = 'lose'; newPoint = null; push12 = true;
            dontWant = dontPass; // push: return the don't-pass bet
          } else {
            outcome = 'point'; newPoint = sum;
            conn.crapsPoint = sum;
          }
        } else {
          if (sum === prevPoint) {
            outcome = 'win'; newPoint = null; conn.crapsPoint = null;
            passWant = pass * 2;
          } else if (sum === 7) {
            outcome = 'lose'; newPoint = null; conn.crapsPoint = null;
            dontWant = dontPass * 2;
          } else {
            outcome = 'point'; newPoint = prevPoint;
          }
        }
        const passPayout = passWant > 0 ? await this.housePay(conn.pid!, conn.nickname!, passWant) : 0;
        const dontPassPayout = dontWant > 0 ? await this.housePay(conn.pid!, conn.nickname!, dontWant) : 0;
        const msg: CrapsResultMsg = { type: 'crapsResult', dice: [d1, d2], total: sum, prevPoint, newPoint, outcome, push12, passPayout, dontPassPayout };
        this.tell(ws, msg);
        this.sendWallet(ws);
      })
      .catch((e) => console.error('craps roll failed:', e));
  }

  // --- Slots ---

  slotsSpin(ws: WebSocket, amount: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid || !conn.nickname) return;
    if (!Number.isInteger(amount) || amount <= 0 || amount > SLOTS_MAX_BET) { this.sendWallet(ws); return; }
    spendCoins(conn.pid, amount)
      .then(async (w) => {
        if (!w) { this.sendWallet(ws); return; }
        await this.houseCredit(amount);
        // Roll each reel: pick 3 symbols (top, center, bottom) per reel using weighted sampling.
        const totalWeight = (SLOTS_WEIGHTS as readonly number[]).reduce((a, b) => a + b, 0);
        const spinReel = (): SlotsSymbol[] =>
          [0, 1, 2].map(() => {
            let r = Math.floor(Math.random() * totalWeight);
            for (let i = 0; i < SLOTS_SYMBOLS.length; i++) {
              r -= SLOTS_WEIGHTS[i];
              if (r < 0) return SLOTS_SYMBOLS[i];
            }
            return SLOTS_SYMBOLS[SLOTS_SYMBOLS.length - 1];
          });
        const reels = [spinReel(), spinReel(), spinReel()] as [SlotsSymbol[], SlotsSymbol[], SlotsSymbol[]];
        // Evaluate center row (index 1 of each reel).
        const [a, b, c] = [reels[0][1], reels[1][1], reels[2][1]];
        const win = (a === b && b === c) ? a : null;
        const want = win ? amount * SLOTS_PAYOUTS[win] : 0;
        const payout = want > 0 ? await this.housePay(conn.pid!, conn.nickname!, want) : 0;
        const msg: SlotsResultMsg = { type: 'slotsResult', reels, win, bet: amount, payout };
        this.tell(ws, msg);
        this.sendWallet(ws);
      })
      .catch((e) => console.error('slots spin failed:', e));
  }

  // --- Plinko ---

  plinkoPlay(ws: WebSocket, amount: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid || !conn.nickname) return;
    if (!Number.isInteger(amount) || amount <= 0 || amount > PLINKO_MAX_BET) { this.sendWallet(ws); return; }
    const bet = amount;
    spendCoins(conn.pid, bet)
      .then(async (w) => {
        if (!w) { this.sendWallet(ws); return; }
        await this.houseCredit(bet);
        // Roll the path: 8 random booleans (false=left, true=right)
        const path: boolean[] = [];
        for (let i = 0; i < PLINKO_ROWS; i++) path.push(Math.random() < 0.5);
        const slot = path.filter(Boolean).length;
        const multiplier = PLINKO_PAYOUTS[slot];
        const want = Math.floor(bet * multiplier);
        const payout = want > 0 ? await this.housePay(conn.pid!, conn.nickname!, want) : 0;
        const msg: PlinkoResultMsg = { type: 'plinkoResult', path, slot, multiplier, bet, payout };
        this.tell(ws, msg);
        this.sendWallet(ws);
      })
      .catch((e) => console.error('plinko play failed:', e));
  }

  // --- Horse Racing ---

  horseReq(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid) return;
    // Shuffle HORSE_NAMES and pick 5; shuffle HORSE_ODDS; pair them up
    const names = [...HORSE_NAMES].sort(() => Math.random() - 0.5).slice(0, 5);
    const odds = [...HORSE_ODDS].sort(() => Math.random() - 0.5);
    const horses = names.map((name, i) => ({ name, odds: odds[i] }));
    conn.horseCard = horses;
    const msg: HorseCardMsg = { type: 'horseCard', horses };
    this.tell(ws, msg);
  }

  horseBet(ws: WebSocket, horse: number, amount: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid || !conn.nickname) return;
    if (!conn.horseCard) { this.sendWallet(ws); return; } // no race card
    if (!Number.isInteger(horse) || horse < 0 || horse > 4) { this.sendWallet(ws); return; }
    if (!Number.isInteger(amount) || amount <= 0 || amount > HORSE_MAX_BET) { this.sendWallet(ws); return; }
    const horses = conn.horseCard;
    conn.horseCard = undefined; // consume the card
    spendCoins(conn.pid, amount)
      .then(async (w) => {
        if (!w) { this.sendWallet(ws); return; }
        await this.houseCredit(amount);
        // Pick winner: weighted by 1/odds (horses with lower odds win more often)
        const weights = horses.map((h) => 1 / h.odds);
        const totalW = weights.reduce((a, b) => a + b, 0);
        let r = Math.random() * totalW;
        let winner = horses.length - 1;
        for (let i = 0; i < weights.length; i++) {
          r -= weights[i];
          if (r <= 0) { winner = i; break; }
        }
        const won = winner === horse;
        const want = won ? Math.floor(amount * horses[horse].odds) : 0;
        const payout = want > 0 ? await this.housePay(conn.pid!, conn.nickname!, want) : 0;
        const msg: HorseResultMsg = { type: 'horseResult', horses, winner, horse, bet: amount, payout };
        this.tell(ws, msg);
        this.sendWallet(ws);
      })
      .catch((e) => console.error('horse bet failed:', e));
  }

  // --- Hi-Lo ---

  hiloBet(ws: WebSocket, amount: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid || !conn.nickname) return;
    if (conn.hiloHand) { this.sendWallet(ws); return; } // already in a hand
    if (!Number.isInteger(amount) || amount <= 0 || amount > HILO_MAX_BET) { this.sendWallet(ws); return; }
    getWallet(conn.pid).then((w) => {
      if (!w || amount < minBet(w.coins)) { this.sendWallet(ws); return; }
      spendCoins(conn.pid, amount)
        .then(async (w2) => {
          if (!w2) { this.sendWallet(ws); return; }
          await this.houseCredit(amount);
          const card = Math.ceil(Math.random() * 13);
          conn.hiloHand = { bet: amount, card, multiplier: 1.0 };
          const state: HiLoStateMsg = { type: 'hiloState', card, multiplier: 1.0, bet: amount, pendingPayout: 0 };
          this.tell(ws, state);
          this.sendWallet(ws);
        })
        .catch((e) => console.error('hilo bet failed:', e));
    }).catch((e) => console.error('hilo getWallet failed:', e));
  }

  hiloGuess(ws: WebSocket, guess: 'hi' | 'lo') {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid || !conn.nickname) return;
    const hand = conn.hiloHand;
    if (!hand) { this.sendWallet(ws); return; }
    // Guard impossible guesses
    if (guess === 'hi' && hand.card === 13) { this.tell(ws, { type: 'announce', text: 'Already at the highest card — guess Lower!', toast: true }); return; }
    if (guess === 'lo' && hand.card === 1) { this.tell(ws, { type: 'announce', text: 'Already at the lowest card — guess Higher!', toast: true }); return; }
    // Draw next card (re-draw on tie)
    let nextCard: number;
    do { nextCard = Math.ceil(Math.random() * 13); } while (nextCard === hand.card);
    const correct = (guess === 'hi' && nextCard > hand.card) || (guess === 'lo' && nextCard < hand.card);
    if (!correct) {
      conn.hiloHand = undefined;
      const msg: HiLoResultMsg = { type: 'hiloResult', won: false, newCard: nextCard, payout: 0, net: -hand.bet };
      this.tell(ws, msg);
      // Wallet already spent — no extra update needed; re-push so client sees current balance
      this.sendWallet(ws);
      return;
    }
    // Correct — compute step multiplier
    const stepFactor = guess === 'hi'
      ? (1 - HILO_HOUSE_EDGE) * 12 / (13 - hand.card)
      : (1 - HILO_HOUSE_EDGE) * 12 / (hand.card - 1);
    hand.multiplier *= stepFactor;
    hand.card = nextCard;
    const pendingPayout = Math.floor(hand.bet * hand.multiplier);
    const state: HiLoStateMsg = { type: 'hiloState', card: nextCard, multiplier: hand.multiplier, bet: hand.bet, pendingPayout };
    this.tell(ws, state);
  }

  async hiloCashout(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid || !conn.nickname) return;
    const hand = conn.hiloHand;
    if (!hand || hand.multiplier <= 1.0) { this.sendWallet(ws); return; } // nothing to cash out
    conn.hiloHand = undefined;
    const want = Math.floor(hand.bet * hand.multiplier);
    const payout = await this.housePay(conn.pid, conn.nickname, want).catch((e) => { console.error('hilo cashout failed:', e); return 0; });
    const msg: HiLoResultMsg = { type: 'hiloResult', won: true, newCard: hand.card, payout, net: payout - hand.bet };
    this.tell(ws, msg);
    this.sendWallet(ws);
  }

  // --- Mines ---

  /** Multiplier after `safeReveals` safe tiles on a MINES_GRID board with `mines` mines.
   *  Formula: C(n,k)/C(n-m,k) × (1-houseEdge) = ∏_{i=0}^{k-1} (n-i)/(n-m-i) × (1-edge). */
  private minesMultiplier(mines: number, safeReveals: number): number {
    if (safeReveals === 0) return 1;
    const n = MINES_GRID;
    let num = 1, den = 1;
    for (let i = 0; i < safeReveals; i++) { num *= (n - i); den *= (n - mines - i); }
    return (1 - MINES_HOUSE_EDGE) * num / den;
  }

  minesBet(ws: WebSocket, amount: number, mines: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid || !conn.nickname) return;
    if (conn.minesHand) { this.sendWallet(ws); return; }
    if (!Number.isInteger(amount) || amount <= 0 || amount > MINES_MAX_BET) { this.sendWallet(ws); return; }
    if (!Number.isInteger(mines) || mines < 1 || mines > MINES_GRID - 1) { this.sendWallet(ws); return; }
    spendCoins(conn.pid, amount)
      .then(async (w) => {
        if (!w) { this.sendWallet(ws); return; }
        await this.houseCredit(amount);
        const indices = Array.from({ length: MINES_GRID }, (_, i) => i);
        for (let i = indices.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [indices[i], indices[j]] = [indices[j], indices[i]];
        }
        const grid = new Array<boolean>(MINES_GRID).fill(false);
        for (let i = 0; i < mines; i++) grid[indices[i]] = true;
        conn.minesHand = { bet: amount, mines, grid, revealed: new Array<boolean>(MINES_GRID).fill(false), safeCount: 0 };
        const state: MinesStateMsg = { type: 'minesState', revealed: conn.minesHand.revealed.slice(), safeCount: 0, multiplier: 1, bet: amount, mines, pendingPayout: 0 };
        this.tell(ws, state);
        this.sendWallet(ws);
      })
      .catch((e) => console.error('mines bet failed:', e));
  }

  minesReveal(ws: WebSocket, cell: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid || !conn.nickname) return;
    const hand = conn.minesHand;
    if (!hand) return;
    if (!Number.isInteger(cell) || cell < 0 || cell >= MINES_GRID || hand.revealed[cell]) return;
    hand.revealed[cell] = true;
    if (hand.grid[cell]) {
      conn.minesHand = undefined;
      const minePositions = hand.grid.reduce<number[]>((a, m, i) => (m ? [...a, i] : a), []);
      const result: MinesResultMsg = { type: 'minesResult', won: false, hitCell: cell, minePositions, payout: 0, net: -hand.bet };
      this.tell(ws, result);
      this.sendWallet(ws);
    } else {
      hand.safeCount++;
      const multiplier = this.minesMultiplier(hand.mines, hand.safeCount);
      const state: MinesStateMsg = { type: 'minesState', revealed: hand.revealed.slice(), safeCount: hand.safeCount, multiplier, bet: hand.bet, mines: hand.mines, pendingPayout: Math.floor(hand.bet * multiplier) };
      this.tell(ws, state);
    }
  }

  async minesCashout(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid || !conn.nickname) return;
    const hand = conn.minesHand;
    if (!hand || hand.safeCount === 0) { this.sendWallet(ws); return; }
    conn.minesHand = undefined;
    const want = Math.floor(hand.bet * this.minesMultiplier(hand.mines, hand.safeCount));
    const payout = await this.housePay(conn.pid, conn.nickname, want).catch((e) => { console.error('mines cashout failed:', e); return 0; });
    const minePositions = hand.grid.reduce<number[]>((a, m, i) => (m ? [...a, i] : a), []);
    const result: MinesResultMsg = { type: 'minesResult', won: true, hitCell: -1, minePositions, payout, net: payout - hand.bet };
    this.tell(ws, result);
    this.sendWallet(ws);
  }

  // --- Crash casino game ---

  crashBetAction(ws: WebSocket, amount: number, autoCashout?: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid || !conn.nickname) return;
    if (this.crashPhase !== 'betting') return; // betting window closed
    if (this.crashBets.some((b) => b.ws === ws)) return; // already bet this round
    if (!Number.isInteger(amount) || amount <= 0 || amount > CRASH_MAX_BET) { this.sendWallet(ws); return; }
    const auto = (typeof autoCashout === 'number' && autoCashout > 1) ? Math.round(autoCashout * 100) / 100 : null;
    spendCoins(conn.pid, amount)
      .then(async (w) => {
        if (!w) { this.sendWallet(ws); return; }
        await this.houseCredit(amount);
        this.crashBets.push({ ws, pid: conn.pid, name: conn.nickname, amount, autoCashout: auto, cashedAt: null });
        this.sendWallet(ws);
        this.crashBroadcastAll();
      })
      .catch((e) => console.error('crash bet failed:', e));
  }

  crashCancelBet(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid) return;
    if (this.crashPhase !== 'betting') return;
    const idx = this.crashBets.findIndex((b) => b.ws === ws);
    if (idx === -1) return;
    const bet = this.crashBets[idx];
    this.crashBets.splice(idx, 1);
    this.housePay(conn.pid, conn.nickname ?? '', bet.amount)
      .then(() => { if (this.conns.has(ws)) this.sendWallet(ws); })
      .catch((e) => console.error('crash cancel failed:', e));
    this.crashBroadcastAll();
  }

  crashCashout(ws: WebSocket) {
    if (this.crashPhase !== 'live') return;
    const bet = this.crashBets.find((b) => b.ws === ws);
    if (!bet || bet.cashedAt !== null) return;
    const mult = Math.round(Math.pow(CRASH_GROWTH, this.crashTicks) * 100) / 100;
    bet.cashedAt = mult;
    const conn = this.conns.get(ws);
    if (conn?.pid) {
      const payout = Math.floor(bet.amount * mult);
      this.housePay(conn.pid, conn.nickname, payout)
        .then(() => { if (this.conns.has(ws)) this.sendWallet(ws); })
        .catch((e) => console.error('crash cashout failed:', e));
    }
    this.crashBroadcastAll();
  }

  private crashTick() {
    const now = Date.now();
    if (this.crashPhase === 'betting') {
      if (now - this.crashPhaseStart >= CRASH_BETTING_MS) {
        this.crashPhase = 'live';
        this.crashPhaseStart = now;
        this.crashTicks = 0;
        this.crashAt = bjCrashPoint();
        this.crashTicksNeeded = Math.ceil(Math.log(this.crashAt) / Math.log(CRASH_GROWTH));
      }
    } else if (this.crashPhase === 'live') {
      this.crashTicks++;
      const mult = Math.round(Math.pow(CRASH_GROWTH, this.crashTicks) * 100) / 100;
      // Process auto-cashouts
      for (const b of this.crashBets) {
        if (b.cashedAt !== null) continue;
        if (b.autoCashout !== null && mult >= b.autoCashout) {
          b.cashedAt = b.autoCashout;
          const conn = this.conns.get(b.ws);
          if (conn?.pid) {
            const payout = Math.floor(b.amount * b.autoCashout);
            this.housePay(conn.pid, conn.nickname, payout)
              .then(() => { if (this.conns.has(b.ws)) this.sendWallet(b.ws); })
              .catch((e) => console.error('crash auto-cashout failed:', e));
          }
        }
      }
      // Check crash
      if (this.crashTicks >= this.crashTicksNeeded) {
        this.crashPhase = 'ended';
        this.crashPhaseStart = now;
        this.crashBroadcastAll();
        return;
      }
    } else {
      // ended
      if (now - this.crashPhaseStart >= CRASH_ENDED_MS) {
        this.crashPhase = 'betting';
        this.crashPhaseStart = now;
        this.crashBets = [];
        this.crashAt = 0;
        this.crashTicks = 0;
      }
    }
    this.crashBroadcastAll();
  }

  private buildCrashState(ws: WebSocket): CrashStateMsg {
    const mult = this.crashPhase === 'live'
      ? Math.round(Math.pow(CRASH_GROWTH, this.crashTicks) * 100) / 100
      : this.crashPhase === 'ended' ? this.crashAt : 1.00;
    const timeLeft = this.crashPhase === 'betting'
      ? Math.max(0, CRASH_BETTING_MS - (Date.now() - this.crashPhaseStart))
      : 0;
    const myBet = this.crashBets.find((b) => b.ws === ws);
    return {
      type: 'crashState',
      phase: this.crashPhase,
      multiplier: mult,
      timeLeft,
      bets: this.crashBets.map((b) => ({ name: b.name, amount: b.amount, cashedAt: b.cashedAt })),
      yourBet: myBet?.amount ?? null,
      yourCashedAt: myBet?.cashedAt ?? null,
      crashedAt: this.crashPhase === 'ended' ? this.crashAt : null,
    };
  }

  private crashBroadcastAll() {
    const now = Date.now();
    const mult = this.crashPhase === 'live'
      ? Math.round(Math.pow(CRASH_GROWTH, this.crashTicks) * 100) / 100
      : this.crashPhase === 'ended' ? this.crashAt : 1.00;
    const timeLeft = this.crashPhase === 'betting' ? Math.max(0, CRASH_BETTING_MS - (now - this.crashPhaseStart)) : 0;
    const betsView = this.crashBets.map((b) => ({ name: b.name, amount: b.amount, cashedAt: b.cashedAt }));
    for (const [ws] of this.conns) {
      if (ws.readyState !== ws.OPEN) continue;
      const myBet = this.crashBets.find((b) => b.ws === ws);
      const msg: CrashStateMsg = {
        type: 'crashState',
        phase: this.crashPhase,
        multiplier: mult,
        timeLeft,
        bets: betsView,
        yourBet: myBet?.amount ?? null,
        yourCashedAt: myBet?.cashedAt ?? null,
        crashedAt: this.crashPhase === 'ended' ? this.crashAt : null,
      };
      ws.send(JSON.stringify(msg));
    }
  }

  // --- House treasury (coin-conservation backbone) ---

  /** Pay a player from the House. Returns the amount ACTUALLY paid (0 when the House is empty).
   *  Scaling: pay the full `requested` when it's a small slice of the treasury (≤25%), otherwise
   *  throttle to floor(balance × 0.25), clamped to the balance. The House is debited first (the
   *  conditional debit guarantees it never overdraws), then the paid amount is credited to the
   *  player — so coins are merely transferred, never minted. Callers MUST surface the returned
   *  (credited) amount to the player, never `requested`. */
  private async housePay(pid: string, name: string, requested: number): Promise<number> {
    if (!pid || !(requested > 0)) return 0;
    const bal = await getHouseBalance();
    if (bal <= 0) { this.houseBalance = Math.max(0, bal); return 0; }
    const cap = Math.floor(bal * 0.25);
    let pay = requested <= cap ? requested : cap;
    pay = Math.min(pay, bal);
    pay = Math.floor(pay);
    if (pay <= 0) return 0;
    const after = await houseAdjust(-pay); // conditional debit (can't overdraw)
    if (after === null) return 0;           // someone drained it between read and debit — pay nothing
    this.houseBalance = after;
    await addCoins(pid, name, pay);
    this.broadcastHouse();
    return pay;
  }

  /** Push coins INTO the House (a sink: roulette stakes, lost bets, loot-box price, commission,
   *  fast-sell tax, seized wallets, market escrow). Updates the cache + broadcasts. */
  private async houseCredit(amount: number): Promise<void> {
    if (!(amount > 0)) return;
    const after = await houseAdjust(amount);
    if (after !== null) { this.houseBalance = after; this.broadcastHouse(); }
  }

  /** Earmark coins to the Trickle Fund (the coins stay in the House balance — this is an accounting
   *  number the Fed draws against for stimulus, so stimulus doesn't deplete the lending pool). */
  private async addTrickle(amount: number): Promise<void> {
    if (!(amount > 0)) return;
    const cur = await getMetaNum('trickle_fund', 0);
    await setMeta('trickle_fund', cur + amount);
  }

  /** Charge a broker fee on a `tradeCoins`-sized trade (player → House). 0.5%, doubled after hours. */
  private async chargeBrokerFee(pid: string, tradeCoins: number): Promise<void> {
    const rate = isMarketHours(Date.now()) ? BROKER_FEE : BROKER_FEE * 2;
    const fee = Math.floor(tradeCoins * rate);
    if (fee <= 0) return;
    const taken = await spendCoins(pid, fee);
    if (taken) await this.houseCredit(fee);
  }

  /** Mint the House's per-match cut (a NEW mint, not a transfer — pong is the faucet that funds the
   *  treasury). Called once per recorded PvP match alongside the winner's own minted reward. */
  private mintMatchHouse() {
    houseAdjust(MATCH_HOUSE_MINT)
      .then((after) => { if (after !== null) { this.houseBalance = after; this.broadcastHouse(); } })
      .catch((e) => console.error('match house mint failed:', e));
  }

  /** Broadcast the latest House balance to every client (drives the header readout). */
  private broadcastHouse() {
    const data = JSON.stringify({ type: 'house', balance: Math.round(this.houseBalance) });
    for (const ws of this.conns.keys()) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  /** Record order-flow into the price-pressure model. Buys/covers pass +coins, sells/shorts pass
   *  −coins. Normalize against the coin's "market cap" (supply × base) so a fixed coin amount
   *  matters more for a thin coin, scale by SENSITIVITY, accumulate, and clamp. */
  private recordFlow(coin: string, signedCoins: number) {
    const s = STOCKS.find((x) => x.id === coin);
    if (!s) return;
    const SENSITIVITY = 2;
    const denom = s.supply * s.base;
    if (!(denom > 0)) return;
    const delta = (signedCoins / denom) * SENSITIVITY;
    const cur = this.pressure.get(coin) ?? 0;
    this.pressure.set(coin, Math.max(-1, Math.min(1, cur + delta)));
  }

  // --- Stock market ---

  /** Hydrate the global price board + the next-crash schedule from the DB (call once after
   *  initDb). No-op on prices without a DB; the crash is still scheduled in memory. */
  async loadStockPrices() {
    const saved = await getStockPrices();
    const savedHist = await getStockHistory().catch(() => ({} as Record<string, Partial<Record<StockTf, number[]>>>));
    for (const s of STOCKS) {
      const row = saved[s.id];
      if (row && row.price > 0) this.stockPrices.set(s.id, { price: row.price, prev: row.prev });
      // Restore the graph history from the DB so the graphs survive restarts.
      const seed = this.stockPrices.get(s.id)?.price ?? s.base;
      const h = savedHist[s.id];
      const tfs = Object.keys(STOCK_HISTORY) as StockTf[];
      // Load each persisted (capped) series.
      const loaded: Record<string, number[]> = {};
      for (const tf of tfs) {
        const raw = h?.[tf];
        const arr = Array.isArray(raw) ? raw.filter((n) => typeof n === 'number' && Number.isFinite(n)) : [];
        loaded[tf] = arr.slice(-STOCK_HISTORY[tf].cap);
      }
      // Backfill any timeframe that has no real history yet (e.g. one added after the blob was
      // last saved, like 6h) from the finest persisted series that reaches back far enough — so
      // its graph shows a real curve immediately instead of a flat single point. Native samples
      // at the timeframe's own cadence then replace these over time.
      for (const tf of tfs) {
        if (loaded[tf].length >= 2) continue;
        const spanTicks = STOCK_HISTORY[tf].cap * STOCK_HISTORY[tf].everyTicks;
        const src = tfs
          .filter((o) => o !== tf && loaded[o].length >= 2 && loaded[o].length * STOCK_HISTORY[o].everyTicks >= spanTicks)
          .sort((a, b) => STOCK_HISTORY[a].everyTicks - STOCK_HISTORY[b].everyTicks)[0];
        if (src) loaded[tf] = loaded[src].slice(-Math.min(STOCK_HISTORY[tf].cap, Math.ceil(spanTicks / STOCK_HISTORY[src].everyTicks)));
      }
      // Anything still empty (truly fresh market) seeds with the single resumed price so a graph
      // is never blank.
      for (const tf of tfs) this.stockHist[tf].set(s.id, loaded[tf].length ? loaded[tf] : [seed]);
    }
    // The collection fires at the next 5pm ET — a deterministic time — so just (re)book it on
    // boot rather than resuming a stored timestamp. Then pull any open loan still booked under the
    // old rolling-24h deadline back to this 5pm, so existing loans show the correct countdown too.
    this.scheduleNextCollect();
    realignLoansToDeadline(this.nextStockCrashAt).catch((e) => console.error('loan deadline realign failed:', e));
    // Resume the instability pool so the stability bar (and crash trigger) survive restarts.
    this.marketInstability = await getMarketInstability().catch(() => 0);
    // Economy Overhaul: hydrate the House treasury and seed the netizen bot traders (funded from
    // the House). Both are best-effort — without a DB they no-op cleanly.
    this.houseBalance = await getHouseBalance().catch(() => 0);
    // One-time mint to bring total coin supply (House + wallet cash) to a clean 5M.
    const walletCash = await getTotalCoins().catch(() => 0);
    const currentSupply = this.houseBalance + walletCash;
    if (currentSupply < 5_000_000) {
      const mint = 5_000_000 - Math.floor(currentSupply);
      await houseAdjust(mint);
      this.houseBalance += mint;
      console.error(`house mint: +${mint} (supply ${Math.floor(currentSupply).toLocaleString()} → 5,000,000)`);
    }
    await this.loadFed().catch((e) => console.error('fed load failed:', e));
    await this.seedNetizens().catch((e) => console.error('netizen seed failed:', e));
    // Seed netizen world avatar positions around the centre plaza with a short staggered spawn
    this.netizenPos.clear();
    for (let i = 0; i < Lobby.NETIZEN_NAMES.length; i++) {
      const pid = `netizen:${i}`;
      // Scatter the initial positions across the town (radially, up to ~900 units) so they don't
      // all start piled on the fountain. Push them out of any solid rect so nobody spawns inside a building.
      const a0 = Math.random() * Math.PI * 2, r0 = Math.random() * 900;
      const spawn = Lobby.resolveNetizenCollision(
        Lobby.PLAZA.x + Math.cos(a0) * r0,
        Lobby.PLAZA.y + Math.sin(a0) * r0,
        16,
      );
      this.netizenPos.set(pid, {
        x: spawn.x, y: spawn.y,
        tx: spawn.x, ty: spawn.y,
        pauseUntil: Date.now() + 1000 + Math.random() * 3000, // stagger initial stroll
        spawnAt: 0, // no delay — appear right away
      });
    }
    // Market News Engine: hydrate the cached feed, schedule the next top-of-hour.
    this.newsFeed = await getNewsFeed().catch(() => []);
    this.nextNewsAt = nextTopOfHourMs(Date.now());
  }

  // --- Netizens (bot traders) ---
  // Synthetic player rows (is_netizen=true) seeded from the House that trade through the REAL
  // invest/cash-out paths each stock tick, so they exert order-flow pressure, pay House escrow,
  // and draw House payouts exactly like humans — but never mint and stop when their coins run dry.

  /** Seed up to NETIZEN_COUNT netizens, each funded from the House. Stops early if the House
   *  can't fund the next one. Idempotent — existing netizens aren't re-funded. */
  private async seedNetizens() {
    for (let i = 0; i < Lobby.NETIZEN_NAMES.length; i++) {
      const name = Lobby.NETIZEN_NAMES[i];
      const pid = `netizen:${i}`;
      const ok = await seedNetizen(pid, name, Lobby.NETIZEN_START_COINS);
      if (!ok) break; // House couldn't fund — seed fewer
    }
    // Top-up any bankrupt netizen back to starting coins from the House treasury.
    const nets = await getNetizens().catch(() => [] as { pid: string; name: string; coins: number }[]);
    if (nets.length) {
      await Promise.all(nets.map(async (n) => {
        if (n.coins < Lobby.NETIZEN_START_COINS) {
          const deficit = Lobby.NETIZEN_START_COINS - n.coins;
          const funded = await houseAdjust(-deficit);
          if (funded !== null) {
            await addCoins(n.pid, n.name, deficit);
          }
        }
      }));
    }
    // Reflect the funding cost on the cached balance + clients.
    this.houseBalance = await getHouseBalance().catch(() => this.houseBalance);
    this.broadcastHouse();
  }

  /** Each stock re-roll, act on ~1/3 of the netizens. Each picks a coin and trades a small slice
   *  of its balance via the real invest/cash-out paths (so recordFlow + escrow + housePay all
   *  apply). Three archetypes by index: momentum (follow pressure sign), mean-reversion (fade the
   *  recent move), and random-with-upward-bias. They never mint and stop when broke. */
  private tickNetizens() {
    getNetizens()
      .then(async (nets) => {
        if (!nets.length) return;
        for (const n of nets) {
          if (Math.random() > 0.34) continue; // ~1/3 act per tick
          if (n.coins < 100) {
            // Broke-ish: try to liquidate a position back to coins (a sell exerts − pressure).
            const holds = await getHoldings(n.pid).catch(() => []);
            if (holds.length) {
              const h = holds[Math.floor(Math.random() * holds.length)];
              await this.netizenCashOut(n.pid, n.name, h.coin, h.side);
            }
            continue;
          }
          const idx = Number(n.pid.split(':')[1] ?? 0);
          const archetype = idx % 4; // 0 momentum, 1 mean-reversion, 2 random-upbias, 3 Fed-watcher
          const stock = STOCKS[Math.floor(Math.random() * STOCKS.length)];
          const press = this.pressure.get(stock.id) ?? 0;
          const board = this.stockPrices.get(stock.id);
          const move = board && board.prev > 0 ? board.price / board.prev - 1 : 0;
          // Decide buy vs sell-existing by archetype.
          let buy = true;
          let sizeLo = 0.04, sizeHi = 0.12; // 4–12% of balance per trade (Fed-watchers size up on stimulus)
          if (archetype === 0) buy = press >= 0;            // momentum: follow the flow
          else if (archetype === 1) buy = move <= 0;        // mean-reversion: buy dips, sell rips
          else if (archetype === 2) buy = Math.random() < 0.62; // random with a mild upward bias
          else {
            // Fed-watcher: trades the Fed's policy, not the price. Bearish when tightening, bullish
            // when easing, and leans in harder when the cap is waived (cheap liquidity).
            buy = !this.fed.tightening;
            if (this.fed.loanCapWaived) { sizeLo = 0.08; sizeHi = 0.20; }
          }
          let tradedSide: 'buy' | 'sell' | null = null;
          if (buy) {
            const amt = Math.max(1, Math.floor(n.coins * (sizeLo + Math.random() * (sizeHi - sizeLo))));
            await this.netizenInvest(n.pid, n.name, stock.id, amt, 'long');
            tradedSide = 'buy';
          } else {
            const holds = (await getHoldings(n.pid).catch(() => [])).filter((h) => h.coin === stock.id);
            if (holds.length) { await this.netizenCashOut(n.pid, n.name, stock.id, holds[0].side); tradedSide = 'sell'; }
            else {
              const amt = Math.max(1, Math.floor(n.coins * 0.05));
              await this.netizenInvest(n.pid, n.name, stock.id, amt, 'long');
              tradedSide = 'buy';
            }
          }
          // Trade chatter: reduced frequency (was 0.25 → ≈0.06 so ~1/4 as often).
          if (tradedSide && isMarketHours(Date.now()) && Math.random() < 0.06) {
            const pool = tradedSide === 'buy' ? NETIZEN_DIALOGUE.buyLong : NETIZEN_DIALOGUE.sellProfit;
            const tmpl = pool[Math.floor(Math.random() * pool.length)];
            this.netizenSay(n.pid, n.name, tmpl.replace('{ticker}', stock.ticker));
          }
        }
        // Netizen wallets/holdings moved → the net-worth board shifted.
        this.refreshNetWorth().catch(() => {});
      })
      .catch((e) => console.error('netizen tick failed:', e));
  }

  /** A netizen opens a position through the real escrow path: spend coins, push the escrow into
   *  the House, record buy-flow. Mirrors stockInvest but headless (no socket). */
  private async netizenInvest(pid: string, name: string, coin: string, amount: number, side: StockSide) {
    const price = this.stockPrices.get(coin)?.price;
    if (!price || !(price > 0)) return;
    const w = await investStock(pid, name, coin, amount, price, side).catch(() => null);
    if (!w) return;
    // The escrow stays in the position's `cost` (counted by the invariant) — no House push.
    this.recordFlow(coin, side === 'short' ? -amount : amount);
  }

  /** A netizen closes a position through the real House-backed cash-out (principal refund +
   *  throttled gain + fast-sell tax), recording sell/cover flow. */
  private async netizenCashOut(pid: string, name: string, coin: string, side: StockSide) {
    const price = this.stockPrices.get(coin)?.price;
    if (!price || !(price > 0)) return;
    const res = await this.settleCashOut(pid, name, coin, price, side).catch(() => null);
    if (!res) return;
    this.recordFlow(coin, side === 'short' ? res.gross : -res.gross);
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

  /** Loan-default market crash: a RANDOM subset of coins each drop by a RANDOM degree, while one
   *  random coin SPIKES UP — NOT a clean snap-to-base for the whole board. The variability is
   *  deliberate anti-exploit design: a predictable total crash would let someone take a loan on
   *  one account and short the entire market on another for a risk-free wipe — but here you can't
   *  know which coins fall (or how hard), and one defies the crash and pumps, so blanket-shorting
   *  gets burned. Returns the drops + the pump (for the announcement). Holdings just revalue. */
  private crashMarket(): { drops: { ticker: string; pct: number }[]; pump: { ticker: string; pct: number } | null } {
    // Shuffle the coins (Fisher–Yates). The first becomes the pump; a random prefix of the rest crash.
    const pool = [...STOCKS];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    // One coin defies the crash and spikes a random +40%–120% (clamped to the usual ceiling), so
    // shorting the whole board is never safe.
    let pump: { ticker: string; pct: number } | null = null;
    const up = pool.shift();
    if (up) {
      const cur = this.stockPrices.get(up.id) ?? { price: up.base, prev: up.base };
      const ceil = up.base * 1_000;
      const newPrice = Math.min(ceil, Math.round(cur.price * (1.4 + Math.random() * 0.8) * 100) / 100);
      this.stockPrices.set(up.id, { price: newPrice, prev: cur.price });
      pump = { ticker: up.ticker, pct: Math.max(0, Math.round((newPrice / cur.price - 1) * 100)) };
    }
    // Crash a random-sized prefix of the remaining coins — at least one (when any remain).
    const count = pool.length ? 1 + Math.floor(Math.random() * pool.length) : 0;
    const drops: { ticker: string; pct: number }[] = [];
    for (const s of pool.slice(0, count)) {
      const cur = this.stockPrices.get(s.id) ?? { price: s.base, prev: s.base };
      const dropFrac = 0.2 + Math.random() * 0.6; // each hit coin loses a random 20%–80%
      const floor = s.base / 100;
      const newPrice = Math.max(floor, Math.round(cur.price * (1 - dropFrac) * 100) / 100);
      this.stockPrices.set(s.id, { price: newPrice, prev: cur.price }); // prev = pre-crash, so the cliff shows
      drops.push({ ticker: s.ticker, pct: Math.max(0, Math.round((1 - newPrice / cur.price) * 100)) });
    }
    this.nextStockUpdateAt = Date.now() + STOCK_UPDATE_MS; // give the fresh prices a full window
    this.recordStockHistory(); // the crash itself is a history point (the cliff edge)
    saveStockPrices(this.priceBoard()).catch((e) => console.error('stock price save failed:', e));
    saveStockHistory(this.historyBoard()).catch((e) => console.error('stock history save failed:', e));
    return { drops, pump };
  }

  /** The daily event (replaces the old fixed daily reset): Davis collects on every overdue loan,
   *  and each defaulter's unpaid 1.5× debt is added to the market-instability pool. The market no
   *  longer resets on a timer — it crashes for EVERYONE only once the pool fills the threshold, at
   *  which point the pool resets to 0. Books the next event, then refreshes/announces and repushes. */
  private runDailyCollection() {
    this.scheduleNextCollect(); // book the next daily event immediately (so we never re-fire next tick)
    this.runWealthTax();        // tax day: skim the top of the economy back into the House
    collectDefaultedLoans(Date.now())
      .then(({ pids, totalOwed, seized }) => {
        // The wallet coins Davis seized are real coins — route them INTO the House so they stay
        // conserved (the virtual `owed` still feeds instability separately, below).
        if (seized > 0) this.houseCredit(seized).catch((e) => console.error('seized → house failed:', e));
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
          const { drops, pump } = this.crashMarket();
          this.marketInstability = 0;
          setMarketInstability(0).catch((e) => console.error('instability save failed:', e));
          const tanked = drops.map((d) => `${d.ticker} −${d.pct}%`).join(', ');
          const pumpStr = pump ? ` …but ${pump.ticker} ripped +${pump.pct}%!` : '';
          this.announce(`📉 MARKET CRASH — unpaid loans hit 100% instability! ${tanked || 'nothing'} tanked.${pumpStr} Stability reset.`);
        }
        for (const ws of this.conns.keys()) this.sendStocks(ws);
        // Wallets zeroed, holdings wiped, maybe a full crash — the net-worth board moved a lot.
        this.refreshNetWorth().catch((e) => console.error('net worth update failed:', e));
      })
      .catch((e) => console.error('daily collection failed:', e));
  }

  /** Daily progressive wealth tax: skim a gentle marginal cut off the richest liquid balances and
   *  route it into the House so it can keep funding payouts. A conserving transfer — coins move from
   *  players to the treasury, none are burned or minted. Most accounts (under the allowance) pay 0. */
  private runWealthTax() {
    const now = Date.now();
    getAssessableWealth()
      .then(async (players) => {
        const byPid = new Map<string, number>(); // total taken per pid (for online receipts)
        let collected = 0;   // total → House
        let trickled = 0;    // capital-gains portion earmarked to the Trickle Fund
        let taxedCount = 0;
        for (const p of players) {
          // 1) Liquid wealth tax on coins (progressive; top bracket follows the Fed's current cap).
          const wealth = progressiveTax(p.coins, this.fed.wealthTaxTop);
          // 2) Unrealized mark-to-market capital gains: tax the rise in position value since the last
          //    assessment (catches wealth parked in stocks whether or not it's ever sold).
          const prevMtm = await getMetaNum(`mtm:${p.pid}`, p.posValue); // first time → 0 delta
          const mtm = capitalGainsTax(p.posValue - prevMtm);
          await setMeta(`mtm:${p.pid}`, Math.round(p.posValue)); // remember today's value for tomorrow
          // 3) Idle decay: a fee on net worth for dormant accounts (active players: 0).
          const idleDays = p.lastPlayed > 0 ? (now - p.lastPlayed) / 86_400_000 : 0;
          const idle = Math.floor(Math.max(0, p.netWorth) * idleFeeRate(idleDays));
          let owed = wealth + mtm + idle;
          if (owed <= 0) continue;
          owed = Math.min(owed, p.coins); // can only ever take liquid coins
          if (owed <= 0) continue;
          const after = await spendCoins(p.pid, owed);
          if (!after) continue;           // lost a race on their balance — skip, never overdraw
          collected += owed;
          trickled += Math.min(mtm, owed); // capital-gains share (clamped to what we actually took)
          taxedCount++;
          byPid.set(p.pid, owed);
        }
        if (collected <= 0) return;       // nobody assessable today
        await this.houseCredit(collected);
        if (trickled > 0) await this.addTrickle(trickled);
        // Push fresh wallets + a receipt to any assessed player who's online.
        for (const ws of this.conns.keys()) {
          const conn = this.conns.get(ws);
          const owed = conn?.pid ? byPid.get(conn.pid) : undefined;
          if (owed === undefined) continue;
          this.sendWallet(ws);
          this.notify(ws, `🧾 Tax day! The House assessed ${owed.toLocaleString()}🪙 (wealth · capital gains · idle) from your accounts.`);
        }
        this.announce(`🧾 TAX DAY — the House assessed ${collected.toLocaleString()}🪙 across ${taxedCount} account${taxedCount === 1 ? '' : 's'} (wealth, capital gains, idle decay). Spread the love.`);
        this.refreshNetWorth().catch((e) => console.error('net worth update after tax failed:', e));
      })
      .catch((e) => console.error('wealth tax failed:', e));
  }

  /** Hydrate the Fed's coefficients from doom_meta on boot (survives restarts). */
  private async loadFed(): Promise<void> {
    this.fed.tightening = (await getMetaNum('fed_tightening', 0)) > 0;
    this.fed.wealthTaxTop = await getMetaNum('fed_wealth_tax_cap', 0.10);
    this.fed.loanCapWaived = (await getMetaNum('fed_loan_cap_waived', 0)) > 0;
  }

  /** The Fed convenes: read concentration + House liquidity, tighten/ease, distribute stimulus, and
   *  announce. Coefficients are cached in memory (read on hot paths) and persisted to doom_meta. */
  private async tickFed(): Promise<void> {
    const { top5, total } = await getNetWorthConcentration();
    // Share of total economy = top 5 player net worth / (House balance + all player net worth).
    // Measures the top 5's control of ALL coins, not just the player slice.
    const economyTotal = this.houseBalance + total;
    const share = economyTotal > 0 ? top5 / economyTotal : 0;
    let announced = false;
    // Concentration → tighten (raise the top wealth bracket) / ease (back to baseline).
    if (share > 0.40 && !this.fed.tightening) {
      this.fed.tightening = true; this.fed.wealthTaxTop = 0.15;
      await setMeta('fed_tightening', 1); await setMeta('fed_wealth_tax_cap', this.fed.wealthTaxTop);
      this.publishFedNews('tighten', Math.round(this.fed.wealthTaxTop * 100)); announced = true;
    } else if (share < 0.20 && this.fed.tightening) {
      this.fed.tightening = false; this.fed.wealthTaxTop = 0.10;
      await setMeta('fed_tightening', 0); await setMeta('fed_wealth_tax_cap', this.fed.wealthTaxTop);
      this.publishFedNews('ease', Math.round(share * 100)); announced = true;
    }
    // House liquidity → waive / restore the loan cap (emergency credit window).
    if (this.houseBalance < 10_000 && !this.fed.loanCapWaived) {
      this.fed.loanCapWaived = true; await setMeta('fed_loan_cap_waived', 1);
      await setMeta('trickle_fund', 0); // release the stimulus earmark to the lending pool
      this.publishFedNews('liquidity', 0); announced = true;
    } else if (this.houseBalance >= 25_000 && this.fed.loanCapWaived) {
      this.fed.loanCapWaived = false; await setMeta('fed_loan_cap_waived', 0);
    }
    // Stimulus: when the Trickle Fund has built up (and on a cooldown), wire it to active players.
    if (await this.maybeStimulus()) announced = true;
    // Occasionally put a scarce exclusive up for auction.
    await this.maybeStartAuction();
    // Otherwise an occasional "no action" statement keeps the Fed present in the feed.
    if (!announced && Math.random() < 0.12) this.publishFedNews('hold', 0);
  }

  /** Distribute the Trickle Fund to recently-active players (House-funded; the coins were earmarked
   *  there). Throttled to ~once every 3h. Returns true if a stimulus actually went out. */
  private async maybeStimulus(): Promise<boolean> {
    const now = Date.now();
    const last = await getMetaNum('fed_last_stimulus', 0);
    if (now - last < 3 * 3_600_000) return false; // cooldown
    const fund = await getMetaNum('trickle_fund', 0);
    if (fund < 1_000) return false;
    const active = await getActivePlayers(now - 86_400_000);
    if (!active.length) return false;
    const budget = Math.min(Math.floor(fund * 0.6), Math.floor(this.houseBalance * 0.4));
    const per = Math.floor(budget / active.length);
    if (per < 10) return false; // too thin to bother
    let paid = 0;
    for (const a of active) paid += await this.housePay(a.pid, a.name, per);
    if (paid <= 0) return false;
    await setMeta('trickle_fund', Math.max(0, fund - paid));
    await setMeta('fed_last_stimulus', now);
    // Refresh online recipients' wallets.
    const got = new Set(active.map((a) => a.pid));
    for (const ws of this.conns.keys()) { const c = this.conns.get(ws); if (c?.pid && got.has(c.pid)) this.sendWallet(ws); }
    this.publishFedNews('stimulus', paid);
    this.refreshNetWorth().catch(() => {});
    return true;
  }

  /** Push a literal headline into the news feed + broadcast it. */
  private pushNews(headline: string): void {
    const item: NewsItem = { id: `fed_${Date.now()}_${Math.floor(Math.random() * 1000)}`, ts: Date.now(), coin: '', headline };
    this.newsFeed.unshift(item);
    if (this.newsFeed.length > 30) this.newsFeed.length = 30;
    saveNewsFeed(this.newsFeed).catch(() => {});
    for (const ws of this.conns.keys()) if (ws.readyState === ws.OPEN) this.sendNews(ws);
  }

  /** Pick a templated Fed statement and publish it. */
  private publishFedNews(event: string, n: number): void {
    const pool = FED_TEMPLATES[event];
    if (!pool || !pool.length) return;
    this.pushNews(pool[Math.floor(Math.random() * pool.length)].replace('{n}', n.toLocaleString()));
  }

  // --- Treasury bonds (state persisted as JSON in doom_meta) ---
  private async getBonds(): Promise<Bond[]> {
    try { return JSON.parse((await getMeta('bonds')) || '[]') as Bond[]; } catch { return []; }
  }
  private async setBonds(bonds: Bond[]): Promise<void> { await setMeta('bonds', JSON.stringify(bonds)); }

  /** Buy a Treasury bond: lock `amount` coins (escrowed into the House) for the term; principal +
   *  interest are paid back from the House at maturity. */
  buyBond(ws: WebSocket, amount: number, termDays: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    const term = BOND_TERMS.find((t) => t.termDays === termDays);
    if (!term) return;
    const amt = Math.floor(amount);
    if (!Number.isFinite(amt) || amt < 100) { this.notify(ws, 'Bonds start at 100🪙.'); return; }
    const pid = conn.pid, name = conn.nickname;
    spendCoins(pid, amt)
      .then(async (w) => {
        if (!w) { this.notify(ws, "You can't afford that bond."); this.sendWallet(ws); return; }
        await this.houseCredit(amt); // the locked coins sit in the House for the term
        const bonds = await this.getBonds();
        bonds.push({ id: `b_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, pid, name, amount: amt, termDays: term.termDays, rate: term.rate, purchasedAt: Date.now() });
        await this.setBonds(bonds);
        stampActivity(pid).catch(() => {});
        this.sendWallet(ws);
        this.sendHouseState(ws);
        this.notify(ws, `🏦 Bought a ${term.termDays}-day Treasury bond for ${amt.toLocaleString()}🪙 at ${(term.rate * 100).toFixed(0)}%.`);
      })
      .catch((e) => console.error('bond buy failed:', e));
  }

  /** Redeem a bond early: forfeit all interest and 5% of principal (penalty stays in the House). */
  withdrawBond(ws: WebSocket, id: string) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    const pid = conn.pid, name = conn.nickname;
    this.getBonds()
      .then(async (bonds) => {
        const i = bonds.findIndex((b) => b.id === id && b.pid === pid);
        if (i < 0) { this.sendHouseState(ws); return; }
        const b = bonds[i];
        const refund = Math.floor(b.amount * (1 - BOND_EARLY_PENALTY)); // 95% of principal back
        const after = await houseAdjust(-refund);
        if (after !== null) { this.houseBalance = after; await addCoins(pid, name, refund); this.broadcastHouse(); }
        bonds.splice(i, 1);
        await this.setBonds(bonds);
        this.sendWallet(ws);
        this.sendHouseState(ws);
        this.notify(ws, `🏦 Redeemed a bond early — ${refund.toLocaleString()}🪙 back (forfeited interest + 5% penalty).`);
        this.refreshNetWorth().catch(() => {});
      })
      .catch((e) => console.error('bond withdraw failed:', e));
  }

  /** Pay out any bonds that have reached maturity (principal + interest from the House). 24/7. */
  private async settleMaturedBonds(now: number): Promise<void> {
    const bonds = await this.getBonds();
    if (!bonds.length) return;
    const due = bonds.filter((b) => now >= b.purchasedAt + b.termDays * 86_400_000);
    if (!due.length) return;
    const keep = bonds.filter((b) => !due.includes(b));
    for (const b of due) {
      const interest = Math.floor(b.amount * b.rate);
      let pay = b.amount + interest;
      let after = await houseAdjust(-pay);
      if (after === null) { pay = Math.floor(this.houseBalance); after = pay > 0 ? await houseAdjust(-pay) : 0 as number | null; } // House short → pay what it has
      if (after !== null && pay > 0) {
        this.houseBalance = after; await addCoins(b.pid, b.name, pay);
        for (const ws of this.conns.keys()) { const c = this.conns.get(ws); if (c?.pid === b.pid) { this.sendWallet(ws); this.notify(ws, `🏦 Your ${b.termDays}-day bond matured: ${pay.toLocaleString()}🪙 (${b.amount.toLocaleString()} + ${interest.toLocaleString()} interest).`); } }
      }
    }
    await this.setBonds(keep);
    this.broadcastHouse();
    this.refreshNetWorth().catch(() => {});
  }

  // --- Exclusive auctions (state persisted as JSON in doom_meta) ---
  private async getAuction(): Promise<Auction | null> {
    try { const v = await getMeta('auction'); return v ? JSON.parse(v) as Auction : null; } catch { return null; }
  }
  private async setAuction(a: Auction | null): Promise<void> { await setMeta('auction', a ? JSON.stringify(a) : ''); }

  /** Occasionally start an auction for an exclusive that still has supply (called from the Fed tick). */
  private async maybeStartAuction(): Promise<void> {
    if (await this.getAuction()) return;       // one at a time
    if (Math.random() > 0.18) return;          // ~18% chance per Fed tick when idle
    const supply = await getExclusiveSupply();
    const available = EXCLUSIVES.filter((x) => (supply[x.id] ?? 0) < x.cap);
    if (!available.length) return;
    const item = available[Math.floor(Math.random() * available.length)];
    const startBid = 5_000 + Math.floor(Math.random() * 5_000);
    await this.setAuction({ item: item.id, name: item.name, startBid, highBid: 0, highPid: '', highName: null, endsAt: Date.now() + AUCTION_DURATION_MS });
    this.pushNews(`🪙 FED: A scarce ${item.name} goes to auction — opening bid ${startBid.toLocaleString()}🪙. Bids close in 24h (House → 🏦 Economy).`);
  }

  /** Place a bid on the live auction: escrow the new bid into the House, refund the prior high bidder. */
  auctionBid(ws: WebSocket, amount: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    const pid = conn.pid, name = conn.nickname;
    const amt = Math.floor(amount);
    this.getAuction()
      .then(async (a) => {
        if (!a || Date.now() >= a.endsAt) { this.notify(ws, 'No auction is running right now.'); this.sendHouseState(ws); return; }
        if (a.highPid === pid) { this.notify(ws, "You're already the high bidder."); return; }
        const min = Math.max(a.startBid, a.highBid + 1);
        if (amt < min) { this.notify(ws, `Bid must be at least ${min.toLocaleString()}🪙.`); this.sendHouseState(ws); return; }
        const w = await spendCoins(pid, amt);
        if (!w) { this.notify(ws, "You can't afford that bid."); this.sendWallet(ws); return; }
        await this.houseCredit(amt); // escrow into the House
        if (a.highPid && a.highBid > 0) { // refund the outbid leader from the House
          const after = await houseAdjust(-a.highBid);
          if (after !== null) {
            this.houseBalance = after; await addCoins(a.highPid, a.highName ?? 'bidder', a.highBid); this.broadcastHouse();
            for (const ws2 of this.conns.keys()) { const c = this.conns.get(ws2); if (c?.pid === a.highPid) { this.sendWallet(ws2); this.notify(ws2, `🔨 You were outbid on ${a.name} — your ${a.highBid.toLocaleString()}🪙 was refunded.`); } }
          }
        }
        a.highBid = amt; a.highPid = pid; a.highName = name;
        await this.setAuction(a);
        stampActivity(pid).catch(() => {});
        this.sendWallet(ws);
        this.sendHouseState(ws);
        this.notify(ws, `🔨 You're the high bidder on ${a.name} at ${amt.toLocaleString()}🪙.`);
      })
      .catch((e) => console.error('auction bid failed:', e));
  }

  /** Resolve the auction once its deadline passes: grant the item to the high bidder (their bid is
   *  already in the House as the sale proceeds), or return it to the pool if there were no bids. */
  private async checkAuctionDeadline(now: number): Promise<void> {
    const a = await this.getAuction();
    if (!a || now < a.endsAt) return;
    await this.setAuction(null);
    if (!a.highPid || a.highBid <= 0) { this.pushNews(`🪙 FED: The ${a.name} auction closed with no bids. It returns to the pool.`); return; }
    const item = EXCLUSIVES.find((x) => x.id === a.item);
    if (!item) return;
    const serial = await mintExclusive(a.highPid, item.id, item.cap, now);
    if (serial === null) { // minted out in the meantime — refund the winner
      const after = await houseAdjust(-a.highBid);
      if (after !== null) { this.houseBalance = after; await addCoins(a.highPid, a.highName ?? 'bidder', a.highBid); this.broadcastHouse(); }
      this.pushNews(`🪙 FED: The ${a.name} auction was voided (supply exhausted) — ${a.highName} was refunded.`);
      return;
    }
    this.pushNews(`🪙 FED: ${a.highName} won the auction for ${a.name} at ${a.highBid.toLocaleString()}🪙! Congratulations.`);
    for (const ws of this.conns.keys()) { const c = this.conns.get(ws); if (c?.pid === a.highPid) { this.sendWallet(ws); this.notify(ws, `🏆 You won ${a.name} (#${serial}) at auction for ${a.highBid.toLocaleString()}🪙! Equip it in the Shop.`); } }
    this.refreshNetWorth().catch(() => {});
  }

  /** The global price board, in STOCKS order. `flow` is the sign of the current order-flow
   *  pressure (+1 buy-heavy / −1 sell-heavy / 0 balanced) for the per-coin ▲/▼ tint. */
  private priceBoard(): { id: string; price: number; prev: number; flow: number }[] {
    return STOCKS.map((s) => {
      const p = this.stockPrices.get(s.id) ?? { price: s.base, prev: s.base };
      const pr = this.pressure.get(s.id) ?? 0;
      const flow = pr > 0.02 ? 1 : pr < -0.02 ? -1 : 0;
      return { id: s.id, price: p.price, prev: p.prev, flow };
    });
  }

  /** The per-coin graph history (every timeframe), in STOCKS order. */
  private historyBoard(): { id: string; series: Record<StockTf, number[]> }[] {
    const tfs = Object.keys(STOCK_HISTORY) as StockTf[];
    return STOCKS.map((s) => ({
      id: s.id,
      series: Object.fromEntries(tfs.map((tf) => [tf, this.stockHist[tf].get(s.id) ?? []])) as Record<StockTf, number[]>,
    }));
  }

  /** Record the current price into each graph series (call once per re-roll / reset). Each
   *  timeframe samples at its own cadence (see STOCK_HISTORY): 5m every tick, 1h every 4,
   *  6h every 24, 1d every 60. */
  private recordStockHistory() {
    this.stockHistTick++;
    for (const tf of Object.keys(STOCK_HISTORY) as StockTf[]) {
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
          return { id: hd.coin, side: hd.side, shares: hd.shares, cost: hd.cost, worth: Math.floor(positionWorth(hd.side, hd.shares, hd.cost, price)), openedAt: hd.openedAt };
        });
        this.tell(ws, {
          type: 'stocks', prices, holdings, history, nextUpdateAt: this.nextStockUpdateAt,
          stability: { unpaid: this.marketInstability, threshold: MARKET_INSTABILITY_THRESHOLD },
        });
      })
      .catch((e) => console.error('stocks send failed:', e));
  }

  /** Send the cached news feed to a single client. */
  sendNews(ws: WebSocket) {
    this.tell(ws, { type: 'news', items: this.newsFeed });
  }

  /** Assemble + send the House/Fed dashboard snapshot (in reply to houseReq). */
  sendHouseState(ws: WebSocket) {
    const conn0 = this.conns.get(ws);
    const myPid = conn0?.pid ?? '';
    Promise.all([getMetaNum('trickle_fund', 0), getTotalCoins(), getNetWorthConcentration(), this.getBonds(), this.getAuction()])
      .then(([trickle, totalCoins, conc, bonds, auction]) => {
        if (!this.conns.has(ws)) return;
        const myBonds = bonds.filter((b) => b.pid === myPid).map((b) => ({
          id: b.id, amount: b.amount, termDays: b.termDays, rate: b.rate,
          maturesAt: b.purchasedAt + b.termDays * 86_400_000,
        }));
        const auctionView = auction && Date.now() < auction.endsAt
          ? { item: auction.item, name: auction.name, startBid: auction.startBid, highBid: auction.highBid, highName: auction.highName, endsAt: auction.endsAt }
          : null;
        const top5Pct = conc.total > 0 ? Math.round((conc.top5 / conc.total) * 1000) / 10 : 0;
        const economyTotal = this.houseBalance + conc.total;
        const top5ShareOfTotal = economyTotal > 0 ? Math.round((conc.top5 / economyTotal) * 1000) / 10 : 0;
        const wealthBrackets = TAX_BRACKETS.map((b) => ({
          upTo: b.upTo === Infinity ? -1 : b.upTo,
          rate: b.upTo === Infinity ? this.fed.wealthTaxTop : b.rate,
        }));
        const capGainBrackets = CAPGAIN_BRACKETS.map((b) => ({ upTo: b.upTo === Infinity ? -1 : b.upTo, rate: b.rate }));
        const fastSell = FAST_SELL_BRACKETS.map((b) => ({ underMin: b.underMs / 60_000, rate: b.rate }));
        const idleTiers = [
          { days: 7, rate: 0.01 }, { days: 14, rate: 0.03 }, { days: 30, rate: 0.05 },
        ];
        const fedNews = this.newsFeed.filter((i) => i.headline.startsWith('🪙 FED')).slice(0, 10)
          .map((i) => ({ ts: i.ts, headline: i.headline }));
        this.tell(ws, {
          type: 'houseState',
          balance: Math.round(this.houseBalance),
          trickleFund: Math.round(trickle),
          totalCoins: Math.round(totalCoins),
          top5Pct,
          top5ShareOfTotal,
          playerNetWorthTotal: Math.round(conc.total),
          economyTotal: Math.round(economyTotal),
          brokerFeePct: (isMarketHours(Date.now()) ? BROKER_FEE : BROKER_FEE * 2) * 100,
          concentrationCap: STOCK_CONCENTRATION_CAP * 100,
          loanCapWaived: this.fed.loanCapWaived,
          tightening: this.fed.tightening,
          wealthBrackets, capGainBrackets, fastSell, idleTiers, fedNews,
          bondRates: BOND_TERMS,
          myBonds,
          auction: auctionView,
        });
      })
      .catch((e) => console.error('house state send failed:', e));
  }

  /** Publish a new market headline: pick a coin, build the item, push to feed + DB, broadcast to
   *  all clients, and schedule the hidden price-pressure injection 7–30 min later. */
  private publishNews() {
    const now = Date.now();
    // Pick a coin, lightly weighted toward those with older or no recent news.
    const lastNewsTs = new Map<string, number>();
    for (const item of this.newsFeed) {
      const existing = lastNewsTs.get(item.coin) ?? 0;
      if (item.ts > existing) lastNewsTs.set(item.coin, item.ts);
    }
    const scored = STOCKS.map((s) => {
      const last = lastNewsTs.get(s.id) ?? 0;
      const recency = Math.max(0, now - last); // ms since last news
      return { id: s.id, name: s.name, ticker: s.ticker, weight: 1 + recency / 3_600_000 };
    });
    const totalW = scored.reduce((a, b) => a + b.weight, 0);
    let roll = Math.random() * totalW;
    const pick = scored.find((s) => { roll -= s.weight; return roll <= 0; }) ?? scored[0];

    const sector = SECTORS.find((s) => (s.ids as readonly string[]).includes(pick.id));
    const sectorName = sector?.name ?? 'market';

    const dir = Math.random() < 0.5 ? 'bullish' : 'bearish';
    const templates = dir === 'bullish' ? NEWS_TEMPLATES_BULLISH : NEWS_TEMPLATES_BEARISH;
    const tmpl = templates[Math.floor(Math.random() * templates.length)];
    const headline = tmpl.replace('{name}', pick.name).replace('{ticker}', pick.ticker).replace('{sector}', sectorName);

    const item: NewsItem = {
      id: `news_${now}`,
      ts: now,
      coin: pick.id,
      headline,
    };
    this.newsFeed.unshift(item);
    if (this.newsFeed.length > 30) this.newsFeed.length = 30;
    saveNewsFeed(this.newsFeed).catch((e: unknown) => console.error('news feed save failed:', e));

    // Schedule hidden injections: primary coin gets full pressure, sector-mates get a fraction.
    const magnitude = (dir === 'bullish' ? 1 : -1) * (0.25 + Math.random() * 0.35);
    const delay = (25 + Math.random() * 35) * 60_000;
    this.pendingNews.push({ coin: pick.id, magnitude, fireAt: now + delay });
    if (sector) {
      for (const sid of sector.ids) {
        if (sid === pick.id) continue;
        if (Math.random() < 0.6) { // 60 % chance each sector sibling catches a piece
          const siblingMag = magnitude * (0.3 + Math.random() * 0.4); // 30–70 % of the primary
          this.pendingNews.push({ coin: sid, magnitude: siblingMag, fireAt: now + Math.floor(delay * (0.5 + Math.random() * 0.5)) });
        }
      }
    }

    // Broadcast to all connected clients.
    for (const ws of this.conns.keys()) {
      if (ws.readyState === ws.OPEN) this.sendNews(ws);
    }
  }

  /** Open a long or short position in a crypto at its current price. Coins are escrowed. */
  stockInvest(ws: WebSocket, coin: string, amount: number, side: StockSide) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    const stock = STOCKS.find((s) => s.id === coin);
    if (!stock) return; // unknown coin
    const amt = Math.floor(amount);
    if (!Number.isFinite(amt) || amt < 1) return; // positive whole coins only
    const price = this.stockPrices.get(coin)?.price;
    if (!price || !(price > 0)) return;
    const pid = conn.pid, name = conn.nickname;
    // Concentration cap: no one may corner > 25% of a stock's supply (longs only — shorting doesn't
    // accumulate supply). Checked before escrowing so we never half-commit a rejected trade.
    const newShares = amt / price;
    const capCheck = side === 'long'
      ? getPlayerShares(pid, coin).then((have) => have + newShares <= STOCK_CONCENTRATION_CAP * stock.supply)
      : Promise.resolve(true);
    capCheck.then(async (ok) => {
      if (!ok) {
        this.notify(ws, `📊 Position cap: you can hold at most 25% of ${stock.ticker}'s supply. Trade rejected.`);
        this.sendStocks(ws);
        return;
      }
      const w = await investStock(pid, name, coin, amt, price, side);
      if (!w) { this.sendStocks(ws); return; } // couldn't afford — just refresh the view
      // The escrowed coins live in the position's `cost` column (counted by the invariant), so they
      // leave circulation without being minted. The trade exerts buy/cover pressure on the price.
      this.recordFlow(coin, side === 'short' ? -amt : amt);
      await this.chargeBrokerFee(pid, amt); // broker fee on the trade → House
      stampActivity(pid).catch(() => {});   // trading counts as activity (idle-decay shield)
      this.sendStocks(ws);
      this.sendWallet(ws);
    }).catch((e) => console.error('stock invest failed:', e));
  }

  /** Cash-out used by both players and netizens. The position's `cost` (escrow) is released back
   *  to the player as principal — IN FULL, never throttled (it's the player's own escrowed coins,
   *  not a House payout). Only the GAIN (payout − cost, if positive) is a House-funded payout via
   *  housePay (throttled when the House is low). On a LOSS (payout < cost) the player gets `payout`
   *  and the unrecovered escrow (cost − payout) flows into the House. A fast-sell (held <60s) taxes
   *  10% of the payout into the House. Conservation is exact: the escrow that left circulation at
   *  invest comes back as principal + House (loss) or principal + House gain (win). Returns the
   *  gross payout (for the pressure model) + the net credited to the player. */
  private async settleCashOut(pid: string, name: string, coin: string, price: number, side: StockSide): Promise<{ gross: number; credited: number } | null> {
    const pos = await closePosition(pid, coin, price, side);
    if (!pos) return null;
    const { cost, payout, openedAt } = pos;
    let credited = 0;
    if (payout >= cost) {
      // Win/flat: return the full principal directly (it was the player's escrow), then pay the
      // gain from the House (throttled when low). The principal is NEVER throttled.
      if (cost > 0) { await addCoins(pid, name, cost); credited += cost; }
      const gain = payout - cost;
      if (gain > 0) credited += await this.housePay(pid, name, gain);
    } else {
      // Loss: the player recovers `payout`; the unrecovered escrow flows into the House so the
      // released escrow is fully accounted for (player + House = the original cost).
      const back = Math.max(0, payout);
      if (back > 0) { await addCoins(pid, name, back); credited += back; }
      const toHouse = cost - back;
      if (toHouse > 0) await this.houseCredit(toHouse);
    }
    // The Fed's exit frictions, all clawed back out of what we just credited and routed to the House:
    //   • capital-gains tax on the realized profit (gain = payout − cost), progressive
    //   • progressive fast-sell tax on the gross payout (steeper the faster you flip)
    //   • broker fee on the gross payout (0.5%, doubles after hours)
    // The capital-gains share is earmarked to the Trickle Fund (for Fed stimulus) — the coins still
    // live in the House balance; trickle_fund is just an accounting number the Fed draws against.
    const heldMs = openedAt > 0 ? Date.now() - openedAt : Number.POSITIVE_INFINITY;
    const gross = Math.max(0, payout);
    const capGain = capitalGainsTax(payout - cost);
    const fastSell = Math.floor(gross * fastSellRate(heldMs));
    const brokerRate = isMarketHours(Date.now()) ? BROKER_FEE : BROKER_FEE * 2;
    const broker = Math.floor(gross * brokerRate);
    const totalTax = capGain + fastSell + broker;
    if (totalTax > 0) {
      const taken = await spendCoins(pid, totalTax); // all-or-nothing; they were just paid, so it clears
      if (taken) {
        await this.houseCredit(totalTax);
        credited -= totalTax;
        if (capGain > 0) await this.addTrickle(capGain);
      }
    }
    return { gross, credited };
  }

  /** Close the whole long or short position in a crypto. Principal is returned in full; profit is
   *  House-throttled; a fast-sell is taxed (see settleCashOut). */
  stockCashOut(ws: WebSocket, coin: string, side: StockSide) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    if (!STOCKS.some((s) => s.id === coin)) return;
    const price = this.stockPrices.get(coin)?.price;
    if (!price || !(price > 0)) return;
    this.settleCashOut(conn.pid, conn.nickname, coin, price, side)
      .then((res) => {
        if (!res) { this.sendStocks(ws); return; } // held nothing on that side
        // A close exerts sell (long) / cover (short) pressure on the price.
        this.recordFlow(coin, side === 'short' ? res.gross : -res.gross);
        stampActivity(conn.pid!).catch(() => {}); // trading counts as activity (idle-decay shield)
        this.sendStocks(ws);
        this.sendWallet(ws);
        this.refreshNetWorth().catch(() => {});
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
    const pid = conn.pid, name = conn.nickname;
    const amt = Math.floor(amount);
    if (!Number.isFinite(amt) || amt < 1) return; // positive whole coins only
    // Deadline is the next daily 5pm collection; if one somehow isn't booked, compute it directly.
    const dueAt = this.nextStockCrashAt || nextFivePmEtMs(Date.now());
    // Loan cap: total outstanding principal + this loan can't exceed the House lending pool (unless
    // the Fed has waived the cap during an emergency). This makes credit tight when the House is
    // drained and loose when it's flush — and guarantees the House can fund the principal debit
    // below, closing the old "loans mint coins when the House is short" rough edge.
    Promise.all([getTotalOutstandingLoans(), getMetaNum('fed_loan_cap_waived', 0)])
      .then(([outstanding, waived]) => {
        if (!waived && outstanding + amt > this.houseBalance) {
          this.notify(ws, '🏦 Loan denied — the House lending pool is tapped out. Try a smaller amount, or wait for it to refill.');
          this.sendLoan(ws);
          return;
        }
        return takeLoan(pid, name, amt, dueAt).then(async (res) => {
          if (!res) { this.sendLoan(ws); return; } // already had a loan / rejected — just refresh
          // The loan principal is House-funded: Davis lends the treasury's coins (debited here, not
          // minted). With the cap above, this debit always clears.
          const after = await houseAdjust(-amt);
          if (after !== null) { this.houseBalance = after; this.broadcastHouse(); }
          this.sendWallet(ws);
          this.sendLoan(ws);
          this.refreshNetWorth().catch((e) => console.error('net worth update failed:', e));
          this.notify(ws, `💸 Davis fronted you ${amt}🪙 — bring back ${res.loan.owed}🪙 by 5pm. Miss it and the market takes the hit. Keep grinding.`);
        });
      })
      .catch((e) => console.error('loan failed:', e));
  }

  /** Repay Davis the full 1.5× owed and clear the loan. */
  repayLoanFor(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    const pid = conn.pid;
    // Read the owed amount first so the repaid coins (spent inside repayLoan) can be routed to the
    // House — repaying a House-funded loan returns the principal + interest to the treasury.
    getLoan(pid)
      .then((loan) => repayLoan(pid).then((res) => ({ loan, res })))
      .then(async ({ loan, res }) => {
        if (!res) { this.sendWallet(ws); this.sendLoan(ws); return; } // no loan or couldn't afford it
        if (loan?.owed) await this.houseCredit(loan.owed);
        this.sendWallet(ws);
        this.sendLoan(ws);
        this.refreshNetWorth().catch((e) => console.error('net worth update failed:', e));
        this.notify(ws, `🤝 Loan settled. Davis respects the hustle.`);
      })
      .catch((e) => console.error('loan repay failed:', e));
  }

  // --- Loot boxes (the ONLY exclusive mint path) ---

  /** Open a loot box: spend the fixed price (which flows into the House), then roll a weighted
   *  prize — a common cosmetic, House-funded coins, or a capped-rare exclusive. The exclusive mint
   *  is atomic + cap-gated (mintExclusive); a capped-out roll DEGRADES to a House coin payout so we
   *  never over-mint. Sends a `lootResult` for the reveal animation. */
  openLootBox(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    const pid = conn.pid, nick = conn.nickname;
    spendCoins(pid, Lobby.LOOT_PRICE)
      .then(async (w) => {
        if (!w) { this.notify(ws, `A loot box costs ${Lobby.LOOT_PRICE.toLocaleString()}🪙 — you're short.`); this.sendWallet(ws); return; }
        // Everything past the charge is wrapped: if ANY step throws (e.g. a missing economy table
        // on a half-migrated DB), we refund the price and still send a lootResult — the player is
        // never charged for nothing and the client never hangs on "Opening…".
        try {
        // The price flows into the House (it funds the coin/exclusive payouts).
        await this.houseCredit(Lobby.LOOT_PRICE);
        // Partial coin-back: pay a random fraction of the price from the House, always < 2500.
        // If the House can't fund it (returns 0), refund the full box price instead.
        const payLootCoins = async (amount: number): Promise<void> => {
          const paid = await this.housePay(pid, nick, amount);
          if (paid > 0) { this.tell(ws, { type: 'lootResult', kind: 'coins', coins: paid }); return; }
          await addCoins(pid, nick, Lobby.LOOT_PRICE);
          await houseAdjust(-Lobby.LOOT_PRICE);
          this.notify(ws, 'Loot box fizzled — your coins were refunded.');
          this.tell(ws, { type: 'lootResult', kind: 'coins', coins: Lobby.LOOT_PRICE });
        };
        // 4-bucket weighted roll: cosmetic / exclusive / partial coin-back / nothing.
        const W = LOOT_TABLE;
        const totalW = W.cosmeticWeight + W.exclusiveWeight + W.coinBackWeight + W.nothingWeight;
        let roll = Math.random() * totalW;
        roll -= W.cosmeticWeight;
        if (roll < 0) {
          // Common cosmetic: grant a random UNOWNED regular cosmetic (skip locked + already-owned).
          const owned = new Set((await getWallet(pid)).owned);
          const pool = COSMETICS.filter((c) => !c.locked && !owned.has(c.id));
          if (pool.length) {
            const item = pool[Math.floor(Math.random() * pool.length)];
            await grantItem(pid, nick, item.id);
            this.tell(ws, { type: 'lootResult', kind: 'cosmetic', item: item.id, name: item.name });
          } else {
            // Owns everything common → degrade to partial coin-back.
            await payLootCoins(W.coinBackMin + Math.floor(Math.random() * (W.coinBackMax - W.coinBackMin)));
          }
        } else {
          roll -= W.exclusiveWeight;
          if (roll < 0) {
            // Rare exclusive: pick one weighted toward higher-cap items, attempt the atomic capped
            // mint, and degrade to partial coin-back if it's sold out globally.
            const pick = this.rollExclusive();
            const serial = await mintExclusive(pid, pick.id, pick.cap);
            if (serial !== null) {
              this.tell(ws, { type: 'lootResult', kind: 'exclusive', item: pick.id, name: pick.name, serial, cap: pick.cap, rarity: pick.rarity });
              this.announce(`✨ ${nick} pulled an EXCLUSIVE: ${pick.name} (#${serial} of ${pick.cap})!`);
            } else {
              // Capped out — degrade to partial coin-back.
              await payLootCoins(W.coinBackMin + Math.floor(Math.random() * (W.coinBackMax - W.coinBackMin)));
            }
          } else {
            roll -= W.coinBackWeight;
            if (roll < 0) {
              // Partial coin-back: always less than the box price (negative EV).
              await payLootCoins(W.coinBackMin + Math.floor(Math.random() * (W.coinBackMax - W.coinBackMin)));
            } else {
              // Nothing: the price stays in the House. No refund.
              this.tell(ws, { type: 'lootResult', kind: 'nothing' });
            }
          }
        }
        this.sendWallet(ws);
        this.refreshNetWorth().catch(() => {});
        this.broadcastMarket(); // a fresh mint changes the "X of cap minted" readouts
        } catch (err) {
          // A payout step threw after we charged — refund the price, pull it back out of the
          // House, and send a result so the client clears its "Opening…" state.
          console.error('loot box payout failed — refunding:', err);
          await addCoins(pid, nick, Lobby.LOOT_PRICE).catch(() => {});
          await houseAdjust(-Lobby.LOOT_PRICE).catch(() => {});
          this.sendWallet(ws);
          // Surface the real reason to the player (we can't read prod logs from the build sandbox)
          // so a live failure is diagnosable. Short + safe — it's just the error message text.
          this.notify(ws, `Loot box errored (refunded): ${String((err as Error)?.message ?? err).slice(0, 140)}`);
          this.tell(ws, { type: 'lootResult', kind: 'coins', coins: Lobby.LOOT_PRICE });
        }
      })
      .catch((e) => console.error('loot box failed:', e));
  }

  /** Pick which exclusive a rare roll targets — weighted toward higher-cap (less scarce) items so
   *  the one-of-one grails stay genuinely rare. */
  private rollExclusive() {
    const weights = EXCLUSIVES.map((x) => x.cap); // cap-as-weight: cap:1 grails are 1/total
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    for (let i = 0; i < EXCLUSIVES.length; i++) { roll -= weights[i]; if (roll < 0) return EXCLUSIVES[i]; }
    return EXCLUSIVES[EXCLUSIVES.length - 1];
  }

  // --- Player marketplace (scarce exclusives) ---

  /** Build the public marketplace book (per-item floor + listings + supply + last sale). */
  private async buildMarket(forPid: string): Promise<MarketItemView[]> {
    const [listings, supply, lastSale] = await Promise.all([
      getMarketListings(), getExclusiveSupply(), getExclusiveLastSale(),
    ]);
    return EXCLUSIVES.map((x) => {
      const mine = listings.filter((l) => l.item === x.id);
      const views: MarketListingView[] = mine.map((l) => ({
        id: l.id, instanceId: l.instanceId, item: l.item, sellerName: l.sellerName, ask: l.ask, mine: l.sellerPid === forPid,
      }));
      const floor = views.length ? Math.min(...views.map((v) => v.ask)) : null;
      return {
        item: x.id,
        floor,
        minted: supply[x.id] ?? 0,
        cap: x.cap,
        lastSale: lastSale[x.id] ?? null,
        listings: views,
      };
    });
  }

  /** Send one client the current marketplace book. */
  sendMarket(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn) return;
    this.buildMarket(conn.pid)
      .then((items) => { if (this.conns.has(ws)) this.tell(ws, { type: 'market', items }); })
      .catch((e) => console.error('market send failed:', e));
  }

  /** Re-push the marketplace book to everyone who could be viewing it (after any change). */
  private broadcastMarket() {
    for (const ws of this.conns.keys()) if (ws.readyState === ws.OPEN) this.sendMarket(ws);
  }

  /** List an owned exclusive instance for sale. */
  marketList(ws: WebSocket, instanceId: number, ask: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    const price = Math.floor(ask);
    if (!Number.isFinite(instanceId) || !Number.isFinite(price) || price < 1 || price > 100_000_000) return;
    listExclusive(instanceId, conn.pid, conn.nickname, price)
      .then((ok) => {
        if (!ok) { this.notify(ws, "Couldn't list that item (not yours, or already listed)."); return; }
        this.sendWallet(ws);
        this.broadcastMarket();
      })
      .catch((e) => console.error('market list failed:', e));
  }

  /** Cancel one of your own listings. */
  marketCancel(ws: WebSocket, listingId: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid) return;
    if (!Number.isFinite(listingId)) return;
    cancelListing(listingId, conn.pid)
      .then((ok) => { if (ok) { this.sendWallet(ws); this.broadcastMarket(); } })
      .catch((e) => console.error('market cancel failed:', e));
  }

  /** Buy the lowest-ask instance of an exclusive item (one atomic transaction). */
  marketBuy(ws: WebSocket, item: string) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    if (!isExclusive(item)) return;
    const buyerName = conn.nickname;
    buyLowestAsk(item, conn.pid, buyerName)
      .then((res) => {
        if (!res.ok) {
          const msg = res.reason === 'self' ? "That's your own listing."
            : res.reason === 'afford' ? "You can't afford the floor."
            : res.reason === 'none' ? 'Nothing listed for that item.' : '';
          if (msg) this.notify(ws, msg);
          this.sendWallet(ws);
          this.broadcastMarket();
          return;
        }
        // Conservation: buyer −ask (handled in the txn), seller +(ask−commission), House +commission.
        // Reflect the commission on the cached House balance + clients.
        this.houseBalance += res.commission;
        this.broadcastHouse();
        const def = EXCLUSIVES.find((x) => x.id === item);
        this.notify(ws, `🛒 Bought ${def?.name ?? item} for ${res.ask.toLocaleString()}🪙.`);
        // Refresh the seller's wallet too if they're online.
        for (const [sock, c] of this.conns) if (c.pid === res.sellerPid) this.sendWallet(sock);
        this.sendWallet(ws);
        this.broadcastMarket();
        this.refreshNetWorth().catch(() => {});
      })
      .catch((e) => console.error('market buy failed:', e));
  }

  // --- Robville land (the suburban neighborhood) ---

  /** Build the per-player land book: every lot's ownership + market state, plus this player's
   *  bank-purchase count (so the client can show the anti-monopoly cap). */
  private async buildLand(forPid: string): Promise<{ parcels: LandParcelView[]; bankBought: number }> {
    const [rows, bankBought] = await Promise.all([
      getLandParcels(),
      forPid ? getBankParcels(forPid) : Promise.resolve(0),
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const parcels: LandParcelView[] = WORLD_PARCELS.map((p) => {
      const r = byId.get(p.id);
      const owned = !!r?.ownerPid;
      return {
        id: p.id,
        ownerName: owned ? (r!.ownerName ?? '???') : null,
        mine: owned && r!.ownerPid === forPid,
        ask: owned ? (r!.ask ?? null) : null,
      };
    });
    return { parcels, bankBought };
  }

  /** Send one client the current land book. */
  sendLand(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn) return;
    this.buildLand(conn.pid)
      .then(({ parcels, bankBought }) => {
        if (this.conns.has(ws)) this.tell(ws, { type: 'land', parcels, bankBought, bankCap: BANK_PARCEL_CAP });
      })
      .catch((e) => console.error('land send failed:', e));
  }

  /** Re-push the land book to everyone in the world (it's per-player, so send individually). */
  private broadcastLand() {
    for (const ws of this.world.sockets()) if (ws.readyState === ws.OPEN) this.sendLand(ws);
  }

  /** Buy an empty Robville lot from the bank for PARCEL_PRICE (subject to the bank cap). */
  landBuyBank(ws: WebSocket, id: string) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    if (typeof id !== 'string' || !WORLD_PARCELS.some((p) => p.id === id)) return;
    buyParcelFromBank(conn.pid, conn.nickname, id, PARCEL_PRICE, BANK_PARCEL_CAP)
      .then((res) => {
        if (!res.ok) {
          const msg = res.reason === 'taken' ? 'That lot was just bought by someone else.'
            : res.reason === 'cap' ? `🏦 The bank limits you to ${BANK_PARCEL_CAP} lot${BANK_PARCEL_CAP === 1 ? '' : 's'} — buy more from other owners instead.`
            : res.reason === 'afford' ? `You can't afford the ${PARCEL_PRICE.toLocaleString()}🪙 deed.`
            : '';
          if (msg) this.notify(ws, msg);
          this.sendLand(ws);
          return;
        }
        // The full price flowed into the House (handled in the txn) — reflect it on the cache + clients.
        this.houseBalance += PARCEL_PRICE;
        this.broadcastHouse();
        this.notify(ws, `🏡 Sold! You bought a Robville lot for ${PARCEL_PRICE.toLocaleString()}🪙. Welcome to the neighborhood.`);
        this.sendWallet(ws);
        this.broadcastLand();
      })
      .catch((e) => console.error('land buy (bank) failed:', e));
  }

  /** List your own lot for sale at `ask` coins. */
  landList(ws: WebSocket, id: string, ask: number) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid) return;
    const price = Math.floor(ask);
    if (typeof id !== 'string' || !Number.isFinite(price) || price < 1 || price > 100_000_000) return;
    listParcel(conn.pid, id, price)
      .then((ok) => {
        if (!ok) { this.notify(ws, "Couldn't list that lot (you don't own it)."); return; }
        this.notify(ws, `🪧 Your Robville lot is on the market for ${price.toLocaleString()}🪙.`);
        this.broadcastLand();
      })
      .catch((e) => console.error('land list failed:', e));
  }

  /** Take your lot back off the market. */
  landUnlist(ws: WebSocket, id: string) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid) return;
    if (typeof id !== 'string') return;
    unlistParcel(conn.pid, id)
      .then((ok) => { if (ok) { this.notify(ws, '🪧 Lot taken off the market.'); this.broadcastLand(); } })
      .catch((e) => console.error('land unlist failed:', e));
  }

  /** Buy a listed lot from its owner at the asking price (one atomic transaction; no bank cap). */
  landBuy(ws: WebSocket, id: string) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || !conn.pid) return;
    if (typeof id !== 'string' || !WORLD_PARCELS.some((p) => p.id === id)) return;
    buyParcelFromOwner(conn.pid, conn.nickname, id)
      .then((res) => {
        if (!res.ok) {
          const msg = res.reason === 'self' ? "You already own that lot."
            : res.reason === 'afford' ? "You can't afford that lot."
            : res.reason === 'unavail' ? 'That lot is no longer for sale.' : '';
          if (msg) this.notify(ws, msg);
          this.sendLand(ws);
          return;
        }
        // Coins moved buyer → seller inside the txn (no House cut on private sales).
        this.notify(ws, `🏡 Bought ${res.sellerName}'s Robville lot for ${res.ask.toLocaleString()}🪙.`);
        for (const [sock, c] of this.conns) {
          if (c.pid === res.sellerPid) { this.notify(sock, `💰 ${conn.nickname} bought your Robville lot for ${res.ask.toLocaleString()}🪙!`); this.sendWallet(sock); }
        }
        this.sendWallet(ws);
        this.broadcastLand();
      })
      .catch((e) => console.error('land buy (owner) failed:', e));
  }

  // --- Loan book (public, clickable from the stability bar) ---

  /** Send one client the public open-loan book. */
  sendLoanBook(ws: WebSocket) {
    getOpenLoans()
      .then((loans) => { if (this.conns.has(ws)) this.tell(ws, { type: 'loanBook', loans }); })
      .catch((e) => console.error('loan book send failed:', e));
  }

  /** Re-roll every coin's price when the re-roll window elapses, persist the board, and push
   *  the fresh (revalued) market to every connected client. Also fires the daily loan-collection
   *  event when its time arrives. Cheap to call every tick. */
  private tickStocks() {
    const now = Date.now();
    // Bond maturities + auction deadlines settle 24/7 (independent of market hours), on a 10-min check.
    if (now >= this.nextBondCheckAt) {
      this.nextBondCheckAt = now + 10 * 60_000;
      this.settleMaturedBonds(now).catch((e) => console.error('bond settle failed:', e));
      this.checkAuctionDeadline(now).catch((e) => console.error('auction resolve failed:', e));
    }
    // The Fed convenes every few minutes during market hours: reads concentration/liquidity, adjusts
    // its coefficients, distributes stimulus, and announces. Throttled + fire-and-forget.
    if (now >= this.nextFedAt && isMarketHours(now)) {
      this.nextFedAt = now + 5 * 60_000;
      this.tickFed().catch((e) => console.error('fed tick failed:', e));
    }
    // The daily collection takes precedence (it may crash + repush the market itself), so handle
    // it first and bail.
    if (this.nextStockCrashAt && now >= this.nextStockCrashAt) {
      this.runDailyCollection();
      return;
    }
    // --- Market News Engine: fire pending price injections ---
    for (let i = this.pendingNews.length - 1; i >= 0; i--) {
      const pn = this.pendingNews[i];
      if (now >= pn.fireAt) {
        const cur = this.pressure.get(pn.coin) ?? 0;
        this.pressure.set(pn.coin, Math.max(-1, Math.min(1, cur + pn.magnitude)));
        this.pendingNews.splice(i, 1);
      }
    }
    // --- Market News Engine: publish check (hourly during market hours) ---
    if (now >= this.nextNewsAt) {
      if (isMarketHours(now)) this.publishNews();
      this.nextNewsAt = nextTopOfHourMs(now);
    }
    // --- News Engine: drain staggered netizen reactions ---
    for (let i = this.newsReactions.length - 1; i >= 0; i--) {
      const r = this.newsReactions[i];
      if (now >= r.at) {
        this.netizenSay(r.pid, r.name, r.text);
        this.newsReactions.splice(i, 1);
      }
    }
    if (now < this.nextStockUpdateAt) return;
    this.nextStockUpdateAt = now + STOCK_UPDATE_MS;
    // Refresh the locked-supply snapshot (long positions >24h) for the supply-scarcity premium.
    // Fire-and-forget: at most one tick stale, which is fine for a slow drift bonus.
    getLockedShares(86_400_000).then((m) => { this.lockedShares = m; }).catch(() => {});
    for (const s of STOCKS) {
      const cur = this.stockPrices.get(s.id) ?? { price: s.base, prev: s.base };
      // Decay the order-flow pressure FIRST (p *= 0.5 per tick), then blend it into the new price.
      // Decaying first keeps a single burst of trading from compounding.
      const p = (this.pressure.get(s.id) ?? 0) * 0.5;
      this.pressure.set(s.id, p);
      const lockedRatio = s.supply > 0 ? (this.lockedShares[s.id] ?? 0) / s.supply : 0;
      this.stockPrices.set(s.id, { price: rollPrice(cur.price, s.base, p, lockedRatio), prev: cur.price });
    }
    this.recordStockHistory();
    saveStockPrices(this.priceBoard()).catch((e) => console.error('stock price save failed:', e));
    saveStockHistory(this.historyBoard()).catch((e) => console.error('stock history save failed:', e));
    // Netizen bots trade AFTER the re-roll (through the real escrow/payout paths).
    this.tickNetizens();
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
    // Wealth-scaled minimum bet: check against the player's floor.
    getWallet(pid).then((w) => {
      if (!w || amt < minBet(w.coins)) { this.sendWallet(ws); return; }
      // Escrow the stake atomically — spendCoins returns null if they can't actually afford it.
      spendCoins(pid, amt)
      .then((w) => {
        if (!w) { this.sendWallet(ws); return; } // insufficient coins — refresh their view, no bet
        this.bets.push({ pid, side, amount: amt, ws, name, odds });
        this.sendWallet(ws);
        this.announce(`🎲 ${name} bet ${amt} on ${side} @ ${odds.toFixed(2)}×`, true);
      })
      .catch((e) => console.error('bet failed:', e));
    })
    .catch((e) => console.error('getWallet failed:', e));
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
      const pid = this.conns.get(b.ws)?.pid ?? b.pid;
      // Every staked coin (escrowed at bet time) now flows INTO the House; winnings are then paid
      // back out of it. This keeps bets a closed transfer: stakes → House, payouts → House.
      this.houseCredit(b.amount).catch((e) => console.error('bet stake → house failed:', e));
      if (b.side === winnerSide) {
        const want = Math.max(b.amount, Math.round(b.amount * b.odds)); // never quote below stake
        this.housePay(pid, b.name, want)
          .then((payout) => {
            if (!this.conns.has(b.ws)) return;
            this.sendWallet(b.ws);
            this.notify(b.ws, `🎲 ${b.side} won — your ${b.amount}🪙 bet pays ${payout}🪙 (+${payout - b.amount})`);
          })
          .catch((e) => console.error('payout failed:', e));
      } else {
        // Lost — stake was escrowed at bet time and routed to the House above; just refresh.
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
    conn.captured = on && !conn.jailed; // jailed players can't capture in to play
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
  setMode(ws: WebSocket, opts: { closing?: boolean; gravity?: boolean; turbo?: boolean; streamer?: boolean; diamond?: boolean; pinata?: boolean; layered?: boolean; arena?: boolean; viewMode?: string; breakout?: boolean; fog?: boolean; portal?: boolean; bumpers?: boolean }) {
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
    if (opts.bumpers !== undefined) this.game.setBumpers(opts.bumpers);
    // View mode is locked while a match is in progress to avoid disrupting players.
    if ((opts.viewMode === 'normal' || opts.viewMode === '3d' || opts.viewMode === 'firstperson') && this.game.status !== 'playing') {
      this.viewMode = opts.viewMode;
      this.syncPowerupPool();
    }
    // Remember the room's chosen modes so they survive a reboot/redeploy.
    this.persistModes();
  }

  /** Snapshot of the room's armed mode toggles — the set persisted across reboots. */
  private currentModes(): import('./db').GameModes {
    return {
      closing: this.game.closing,
      gravity: this.game.gravity,
      turbo: this.game.turbo,
      streamer: this.streamerMode,
      diamond: this.game.diamond,
      pinata: this.game.pinata,
      layered: this.game.layered,
      arena: this.arena,
      breakout: this.game.breakout,
      fog: this.game.fog,
      portal: this.game.portal,
      bumpers: this.game.bumpers,
      viewMode: this.viewMode,
    };
  }

  /** Fire-and-forget persist of the current mode toggles. */
  private persistModes() {
    saveGameModes(this.currentModes()).catch((e: unknown) => console.error('game modes save failed:', e));
  }

  /** Re-apply mode toggles persisted from a previous run. Called once on boot after the DB
   *  is ready. Each flag flows through its normal setter so behaviour matches a live toggle. */
  async loadModes() {
    const m = await getGameModes().catch(() => null);
    if (!m) return;
    if (typeof m.closing === 'boolean') this.game.setClosing(m.closing);
    if (typeof m.gravity === 'boolean') this.game.setGravity(m.gravity);
    if (typeof m.turbo === 'boolean') this.game.setTurbo(m.turbo);
    if (typeof m.streamer === 'boolean') this.streamerMode = m.streamer;
    if (typeof m.diamond === 'boolean') this.game.setDiamond(m.diamond);
    if (typeof m.pinata === 'boolean') this.game.setPinata(m.pinata);
    if (typeof m.layered === 'boolean') this.game.setLayered(m.layered);
    if (typeof m.arena === 'boolean') this.setArena(m.arena);
    if (typeof m.breakout === 'boolean') this.game.setBreakout(m.breakout);
    if (typeof m.fog === 'boolean') this.game.setFog(m.fog);
    if (typeof m.portal === 'boolean') this.game.setPortal(m.portal);
    if (typeof m.bumpers === 'boolean') this.game.setBumpers(m.bumpers);
    if ((m.viewMode === 'normal' || m.viewMode === '3d' || m.viewMode === 'firstperson') && this.game.status !== 'playing') {
      this.viewMode = m.viewMode;
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
    this.ntLeave(ws);   // drop any Nuketown slot (ends the match if the host left)
    this.srLeave(ws);   // drop any Street Demons grid slot (ends the race if the host left)
    this.sbLeave(ws);   // drop any Super Tsong Bros slot (ends the match if the host left)
    this.tdLeave(ws);   // drop out of the Type or Die arena
    this.nomLeave(ws);  // drop out of the Parliament (Nomic) rotation
    this.world.leave(ws); // drop their avatar from the free-roam world map
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
        this.housePay(c.pid, c.nickname, COIN_SCALE).then(() => { if (w) this.sendWallet(w); }).catch(() => {});
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
    // Theme songs: when a duel kicks off, play a seated player's equipped song (random if several).
    if (this.mode !== 'poly') this.maybeStartThemeSong();
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

  /** On the tick a duel kicks off (status rises to 'playing'), pick a theme song from the seated
   *  players who have one equipped — random when more than one — and broadcast it to everyone so
   *  it loops for the match. Clients stop it on their own when the match leaves 'playing'. */
  private maybeStartThemeSong() {
    const playing = this.game.status === 'playing';
    if (playing && !this.lastDuelPlaying) {
      const songs: { owner: string; audio: string }[] = [];
      for (const ws of [...this.teams.left, ...this.teams.right]) {
        const c = this.conns.get(ws);
        if (!c || !c.song) continue;
        const item = COSMETICS.find((x) => x.id === c.song && x.slot === 'song');
        if (item?.audio) songs.push({ owner: c.nickname, audio: item.audio });
      }
      if (songs.length) {
        const pick = songs[Math.floor(Math.random() * songs.length)];
        const data = JSON.stringify({ type: 'themeSong', audio: pick.audio, owner: pick.owner });
        for (const sock of this.conns.keys()) if (sock.readyState === sock.OPEN) sock.send(data);
        this.announce(`🎵 ${pick.owner}'s theme is playing!`);
      }
    }
    this.lastDuelPlaying = playing;
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
      this.mintMatchHouse(); // pong mines coins for the treasury
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
          this.mintMatchHouse(); // pong mines coins for the treasury
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
    const board = await getEloBoard();
    this.leaderboard = board.map(({ pid: _p, ...row }) => row);
    this.eloPids = board.map((r) => r.pid);
    for (const ws of this.conns.keys()) {
      if (ws.readyState !== ws.OPEN) continue;
      const extra = await this.selfEloData(ws);
      ws.send(JSON.stringify({ type: 'leaderboard', rows: this.leaderboard, ...extra }));
    }
    // Net worth tracks the same population, so refresh it on the same beat.
    this.refreshNetWorth().catch((e) => console.error('net worth update failed:', e));
  }

  /** Produce `selfElo` / `selfRank` for a single connection so the client can always pin the
   *  player to the board. Uses the cached top-N when they're on it; otherwise looks up their
   *  true field-wide rank. `{}` for observers / players who haven't played yet. */
  private async selfEloData(ws: WebSocket): Promise<{ selfElo?: number; selfRank?: number }> {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid) return {};
    const idx = this.eloPids.indexOf(conn.pid);
    if (idx !== -1) return { selfElo: this.leaderboard[idx]?.elo, selfRank: idx + 1 };
    const self = await getSelfElo(conn.pid).catch(() => null);
    return self ? { selfElo: self.elo, selfRank: self.rank } : {};
  }

  /** Produce `selfRow` / `selfRank` for the Net Worth board when the player sits below the
   *  visible top-N. `{}` when they're already shown, are observers, or don't qualify. */
  private async selfNetWorthData(ws: WebSocket): Promise<{ selfRow?: NetWorthRow; selfRank?: number }> {
    const conn = this.conns.get(ws);
    if (!conn || !conn.pid) return {};
    if (this.netWorthPids.includes(conn.pid)) return {}; // already on the visible board
    const self = await getSelfNetWorth(conn.pid).catch(() => null);
    if (!self) return {};
    const { rank, ...row } = self;
    return { selfRow: row, selfRank: rank };
  }

  /** Send both standings boards to one client, personalised with their own pinned row when
   *  they fall outside the visible top-N. */
  private async sendBoardsTo(ws: WebSocket) {
    if (ws.readyState !== ws.OPEN) return;
    const elo = await this.selfEloData(ws);
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'leaderboard', rows: this.leaderboard, ...elo }));
    const nw = await this.selfNetWorthData(ws);
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'netWorth', rows: this.netWorth, ...nw }));
  }

  /** Recompute the Net Worth board (coins + live holdings − debt) and push it to everyone.
   *  The pid of each row is cached locally (never sent to clients — it's the identity key) so a
   *  later balance-sheet request can resolve a board rank back to a player. */
  async refreshNetWorth() {
    const full = await getNetWorthLeaderboard();
    this.netWorthPids = full.map((r) => r.pid);
    this.netWorth = full.map(({ pid: _pid, ...row }) => row);
    for (const ws of this.conns.keys()) {
      if (ws.readyState !== ws.OPEN) continue;
      const extra = await this.selfNetWorthData(ws);
      ws.send(JSON.stringify({ type: 'netWorth', rows: this.netWorth, ...extra }));
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

  /** Build and send the Elo profile for the player at `rank` on the current leaderboard,
   *  or for the requesting player when `self` is true. Sends record, ELO, win%, last played,
   *  plus head-to-head against the #1 player (if not yourself). */
  async sendEloProfile(ws: WebSocket, rank: number, self?: boolean) {
    let pid: string;
    if (self) {
      const conn = this.conns.get(ws);
      if (!conn || !conn.pid) return;
      pid = conn.pid;
    } else {
      if (!Number.isInteger(rank) || rank < 0 || rank >= this.eloPids.length) return;
      pid = this.eloPids[rank];
    }
    const profile = await getPlayerProfile(pid);
    if (!profile) return;
    let rival: { name: string; wins: number; losses: number } | null = null;
    if (rank !== 0 && this.eloPids.length > 1) {
      rival = await getRival(pid, this.eloPids[0]);
    }
    this.tell(ws, {
      type: 'eloProfile',
      rank,
      name: profile.name,
      wins: profile.wins,
      losses: profile.losses,
      elo: profile.elo,
      winPct: profile.winPct,
      lastPlayed: profile.lastPlayed,
      rival,
    });
  }

  broadcast() {
    const msg = this.buildState();
    const data = JSON.stringify(msg);
    for (const ws of this.conns.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
    this.broadcastTypeDie();
    this.broadcastWorld();
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

  /** Post a chat message as a netizen (name + its own color), respecting the global throttle. */
  private netizenSay(pid: string, name: string, text: string) {
    const now = Date.now();
    if (now - this.lastNetizenChatAt < 40_000) return; // throttle: ~1 line per 40s (was 10s)
    this.lastNetizenChatAt = now;
    this.botChat(name, text, Lobby.netizenColor(pid));
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
      blackout: this.game.blackout, vortex: this.game.vortex,
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
      bumpers: this.game.bumpers,
      bumperFlash: [...this.game.bumperFlash],
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

// --- Blackjack helpers ---

const BJ_RANKS = ['A','2','3','4','5','6','7','8','9','T','J','Q','K'];
const BJ_SUITS = ['S','H','D','C'];

function bjFreshShoe(): string[] {
  const shoe: string[] = [];
  for (let d = 0; d < 6; d++)
    for (const r of BJ_RANKS)
      for (const s of BJ_SUITS)
        shoe.push(r + s);
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

function bjDeal(shoe: string[]): string {
  if (shoe.length < 26) shoe.push(...bjFreshShoe());
  return shoe.pop()!;
}

function bjCardVal(card: string): number {
  const r = card[0];
  if (r === 'A') return 11;
  if ('TJQK'.includes(r)) return 10;
  return Number(r);
}

function bjTotal(cards: string[]): number {
  let total = 0, aces = 0;
  for (const c of cards) { const v = bjCardVal(c); total += v; if (v === 11) aces++; }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

// Crash point generator: ~3% chance of instant crash; otherwise exponential distribution
// weighted toward low multipliers (median ≈ 2×). House keeps uncashed bets.
function bjCrashPoint(): number {
  const u = Math.random();
  if (u < 0.01) return 1.00;
  // mild power transform pushes more rounds to higher multipliers
  const v = Math.pow((u - 0.01) / 0.99, 0.85);
  return Math.max(1.01, Math.round(100 * 0.97 / (1 - v * 0.94)) / 100);
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

/** Latest 5pm ET boundary in ms since epoch. */
function latest5pmEtBoundary(): number {
  const now = Date.now();
  const d = new Date(now);
  const etOffset = d.getTimezoneOffset() <= 240 ? 4 : 5; // EDT=-4, EST=-5
  const etNow = now - etOffset * 3600000;
  const etDayStart = Math.floor(etNow / 86400000) * 86400000;
  const et5pm = etDayStart + 17 * 3600000;
  // If the current time in ET is before 5pm, use yesterday's 5pm.
  return etNow < et5pm ? et5pm - 86400000 : et5pm;
}

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
