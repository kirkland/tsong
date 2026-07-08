// "City Tycoon" — a server-authoritative, Monopoly-inspired board game for 2–8 players.
//
// Players walk into the arcade cabinet and queue into a room. Once 2+ players ready up,
// the game begins. Each turn: the active player rolls two dice, their token walks around a
// 40-space city, and the space they land on resolves (buy property, pay rent, draw a card,
// pay tax, land in the drunk tank…). Own every property in a colour group to charge premium rent and
// build houses. Bankrupt your rivals; last tycoon standing wins tsong coins.
//
// The server owns ALL game state and logic. Clients send only discrete actions
// (crRoll / crBuy / crPass / crAuctionBid / crBuild / crEndTurn / crReady) and receive
// authoritative state snapshots plus little event toasts. Nothing here knows about sockets —
// the Lobby wires that up through the hooks below.

// --- Hooks the Lobby provides (sockets, coin payouts, toasts) ---
export interface CityRiseHooks {
  /** Pay the winner tsong coins (already in game-coin units, not ×COIN_SCALE). */
  award(pid: string, name: string, coins: number): Promise<number> | void;
  /** Send an arbitrary JSON message to every listed player id. */
  broadcast(pids: string[], msg: object): void;
  /** Personal toast to a single player id. */
  notify(pid: string, text: string): void;
}

// --- Board model ---

export type SpaceKind =
  | 'go' | 'visit_audit' | 'free_lunch' | 'bust_zone'
  | 'property' | 'transit' | 'utility'
  | 'tax' | 'card_bulletin' | 'card_dispatch';

export interface Space {
  kind: SpaceKind;
  name: string;
  color?: string;   // property group colour (for rendering + monopoly checks)
  group?: string;   // group key
  price?: number;   // purchase price (property/transit/utility)
  rent?: number[];  // [base, monopoly, 1h, 2h, 3h, 4h, hotel]
  houseCost?: number;
  taxAmount?: number;
}

// The 40-space city, clockwise from bottom-left corner. Names lean on tsong's own world —
// Robville, the Casino floor, the Fed, the Ruins, Parliament, the Street Demons circuits —
// instead of generic Monopoly streets.
export const BOARD: Space[] = [
  { kind: 'go', name: 'Payday' },                                                                                                              // 0
  { kind: 'property', name: 'Robville Cul-de-Sac', color: '#8B4513', group: 'brown', price: 60, rent: [2, 4, 10, 30, 90, 160, 250], houseCost: 50 },     // 1
  { kind: 'card_bulletin', name: 'Netizen Chatter' },                                                                                          // 2
  { kind: 'property', name: 'Robville Land Office', color: '#8B4513', group: 'brown', price: 80, rent: [4, 8, 20, 60, 180, 320, 450], houseCost: 50 },   // 3
  { kind: 'tax', name: 'The House Cut', taxAmount: 150 },                                                                                      // 4
  { kind: 'transit', name: 'IMOLA Circuit', price: 200 },                                                                                      // 5
  { kind: 'property', name: "Wobbly Pete's Bar", color: '#5fe0e0', group: 'cyan', price: 100, rent: [6, 12, 30, 90, 270, 400, 550], houseCost: 50 }, // 6
  { kind: 'card_dispatch', name: 'House Memo' },                                                                                                // 7
  { kind: 'property', name: "Sloshed Sal's Tavern", color: '#5fe0e0', group: 'cyan', price: 100, rent: [6, 12, 30, 90, 270, 400, 550], houseCost: 50 }, // 8
  { kind: 'property', name: 'The Tavern', color: '#5fe0e0', group: 'cyan', price: 120, rent: [8, 16, 40, 100, 300, 450, 600], houseCost: 50 }, // 9
  { kind: 'visit_audit', name: 'Drunk Tank' },                                                                                                 // 10
  { kind: 'property', name: "Drift's Arcade", color: '#ff5fa8', group: 'pink', price: 140, rent: [10, 20, 50, 150, 450, 625, 750], houseCost: 100 }, // 11
  { kind: 'utility', name: 'Server Room', price: 150 },                                                                                        // 12
  { kind: 'property', name: "Kevin's Banana Stand", color: '#ff5fa8', group: 'pink', price: 140, rent: [10, 20, 50, 150, 450, 625, 750], houseCost: 100 }, // 13
  { kind: 'card_bulletin', name: 'Netizen Chatter' },                                                                                          // 14
  { kind: 'transit', name: 'AVUS Circuit', price: 200 },                                                                                       // 15
  { kind: 'property', name: "Lucky Lou's Corner", color: '#ff5fa8', group: 'pink', price: 160, rent: [12, 24, 60, 180, 500, 700, 900], houseCost: 100 }, // 16
  { kind: 'card_dispatch', name: 'House Memo' },                                                                                                // 17
  { kind: 'property', name: 'Pet Shop', color: '#ff9d3d', group: 'orange', price: 180, rent: [14, 28, 70, 200, 550, 750, 950], houseCost: 100 }, // 18
  { kind: 'property', name: 'Fishing Pond', color: '#ff9d3d', group: 'orange', price: 180, rent: [14, 28, 70, 200, 550, 750, 950], houseCost: 100 }, // 19
  { kind: 'free_lunch', name: 'Free Lunch' },                                                                                                  // 20
  { kind: 'property', name: "McDonald's", color: '#ff9d3d', group: 'orange', price: 200, rent: [16, 32, 80, 220, 600, 800, 1000], houseCost: 100 }, // 21
  { kind: 'card_bulletin', name: 'Netizen Chatter' },                                                                                          // 22
  { kind: 'utility', name: 'Water Cooler', price: 150 },                                                                                       // 23
  { kind: 'property', name: 'Blackjack Table', color: '#ef3d3d', group: 'red', price: 220, rent: [18, 36, 90, 250, 700, 875, 1050], houseCost: 150 }, // 24
  { kind: 'transit', name: 'AINTREE Circuit', price: 200 },                                                                                    // 25
  { kind: 'property', name: 'Roulette Wheel', color: '#ef3d3d', group: 'red', price: 220, rent: [18, 36, 90, 250, 700, 875, 1050], houseCost: 150 }, // 26
  { kind: 'card_dispatch', name: 'House Memo' },                                                                                                // 27
  { kind: 'property', name: 'The Casino', color: '#ef3d3d', group: 'red', price: 240, rent: [20, 40, 100, 300, 750, 925, 1100], houseCost: 150 }, // 28
  { kind: 'tax', name: 'Loot Box Tax', taxAmount: 100 },                                                                                       // 29
  { kind: 'bust_zone', name: 'Busted!' },                                                                                                      // 30
  { kind: 'property', name: "Banker Edna's Vault", color: '#f7d94c', group: 'yellow', price: 260, rent: [22, 44, 110, 330, 800, 975, 1150], houseCost: 150 }, // 31
  { kind: 'card_bulletin', name: 'Netizen Chatter' },                                                                                          // 32
  { kind: 'property', name: 'The Fed', color: '#f7d94c', group: 'yellow', price: 260, rent: [22, 44, 110, 330, 800, 975, 1150], houseCost: 150 }, // 33
  { kind: 'transit', name: 'MEXICO Circuit', price: 200 },                                                                                     // 34
  { kind: 'property', name: 'The Loan Book', color: '#f7d94c', group: 'yellow', price: 280, rent: [24, 48, 120, 360, 850, 1025, 1200], houseCost: 150 }, // 35
  { kind: 'property', name: 'The Ruins', color: '#3ddc84', group: 'green', price: 300, rent: [26, 52, 130, 390, 900, 1100, 1275], houseCost: 200 }, // 36
  { kind: 'property', name: "Clarence's Gate", color: '#3ddc84', group: 'green', price: 300, rent: [26, 52, 130, 390, 900, 1100, 1275], houseCost: 200 }, // 37
  { kind: 'property', name: 'Parliament', color: '#2b3a8c', group: 'navy', price: 350, rent: [35, 70, 175, 500, 1100, 1300, 1500], houseCost: 200 }, // 38
  { kind: 'property', name: 'The Arena', color: '#2b3a8c', group: 'navy', price: 400, rent: [50, 100, 200, 600, 1400, 1700, 2000], houseCost: 200 }, // 39
];

// Group → its member positions (built once from the board).
const GROUPS: Record<string, number[]> = (() => {
  const g: Record<string, number[]> = {};
  BOARD.forEach((s, i) => { if (s.kind === 'property' && s.group) (g[s.group] ??= []).push(i); });
  return g;
})();
const TRANSITS = BOARD.map((s, i) => (s.kind === 'transit' ? i : -1)).filter((i) => i >= 0);
const UTILITIES = BOARD.map((s, i) => (s.kind === 'utility' ? i : -1)).filter((i) => i >= 0);
const TRANSIT_RENT = [25, 50, 100, 200]; // by count owned (1..4)

// --- Cards ---

type CardEffect =
  | { t: 'collect'; n: number }
  | { t: 'pay'; n: number }
  | { t: 'collectEach'; n: number }
  | { t: 'payEach'; n: number }
  | { t: 'move'; dest: number }
  | { t: 'moveBack'; n: number }
  | { t: 'moveForward'; n: number }
  | { t: 'goAudit' }
  | { t: 'payPerProperty'; n: number }
  | { t: 'collectPerProperty'; n: number }
  | { t: 'collectPerSet'; n: number }
  | { t: 'payPercent'; f: number }
  | { t: 'nearestTransit' }
  | { t: 'nearestUtility' }
  | { t: 'collectIfProperty'; n: number };

interface Card { text: string; e: CardEffect; }

const BULLETIN: Card[] = [
  { text: 'City rebate — collect $50', e: { t: 'collect', n: 50 } },
  { text: 'You won a local award — collect $100', e: { t: 'collect', n: 100 } },
  { text: 'Birthday gift — collect $10 from each player', e: { t: 'collectEach', n: 10 } },
  { text: 'Insurance payout — collect $100', e: { t: 'collect', n: 100 } },
  { text: 'Tax refund — collect $50', e: { t: 'collect', n: 50 } },
  { text: 'Inheritance — collect $200', e: { t: 'collect', n: 200 } },
  { text: 'Lottery scratch card win — collect $25', e: { t: 'collect', n: 25 } },
  { text: 'Community service — pay $50', e: { t: 'pay', n: 50 } },
  { text: 'Street repair bill — pay $40', e: { t: 'pay', n: 40 } },
  { text: 'Library fine — pay $15', e: { t: 'pay', n: 15 } },
  { text: 'Parking ticket — pay $30', e: { t: 'pay', n: 30 } },
  { text: 'Health inspection fee — pay $50', e: { t: 'pay', n: 50 } },
  { text: 'Go to Payday — advance to GO, collect $200', e: { t: 'move', dest: 0 } },
  { text: "Advance to Banker Edna's Vault", e: { t: 'move', dest: 31 } },
  { text: 'Advance to Parliament', e: { t: 'move', dest: 38 } },
  { text: 'Go to the Drunk Tank — do not pass Payday', e: { t: 'goAudit' } },
  { text: 'Move back 3 spaces', e: { t: 'moveBack', n: 3 } },
  { text: 'Bank error in your favor — collect $200', e: { t: 'collect', n: 200 } },
  { text: 'Sale of stock — collect $150', e: { t: 'collect', n: 150 } },
  { text: 'Water bill — pay $40', e: { t: 'pay', n: 40 } },
  { text: 'Emergency fund — collect $100', e: { t: 'collect', n: 100 } },
  { text: 'Street festival sponsor — pay $150', e: { t: 'pay', n: 150 } },
  { text: 'Medical bill — pay $100', e: { t: 'pay', n: 100 } },
  { text: 'Investment pays off — collect $75', e: { t: 'collect', n: 75 } },
  { text: 'Grant awarded — collect $200', e: { t: 'collect', n: 200 } },
  { text: 'Consultant fee — collect $50', e: { t: 'collect', n: 50 } },
  { text: 'Pay tuition — pay $100', e: { t: 'pay', n: 100 } },
  { text: 'Speeding fine — pay $20', e: { t: 'pay', n: 20 } },
  { text: 'Property tax — pay $50 per property owned', e: { t: 'payPerProperty', n: 50 } },
  { text: 'Advance to nearest transit (pay double if owned)', e: { t: 'nearestTransit' } },
];

const DISPATCH: Card[] = [
  { text: 'Market boom — collect $150', e: { t: 'collect', n: 150 } },
  { text: 'Flash sale — collect $50', e: { t: 'collect', n: 50 } },
  { text: 'Stock dividend — collect $100 per set you own', e: { t: 'collectPerSet', n: 100 } },
  { text: 'Tech IPO — collect $200', e: { t: 'collect', n: 200 } },
  { text: 'Recession hits — pay $100', e: { t: 'pay', n: 100 } },
  { text: 'Market crash — pay $50 to each player', e: { t: 'payEach', n: 50 } },
  { text: 'Property value surge — collect $50 per property', e: { t: 'collectPerProperty', n: 50 } },
  { text: 'Supply chain disruption — pay $80', e: { t: 'pay', n: 80 } },
  { text: "Advance to Wobbly Pete's Bar", e: { t: 'move', dest: 6 } },
  { text: "Advance to McDonald's", e: { t: 'move', dest: 21 } },
  { text: 'Go to the Drunk Tank — do not pass Payday', e: { t: 'goAudit' } },
  { text: 'Move forward 2 spaces', e: { t: 'moveForward', n: 2 } },
  { text: 'Energy price spike — pay $75', e: { t: 'pay', n: 75 } },
  { text: 'Crypto windfall — collect $200', e: { t: 'collect', n: 200 } },
  { text: 'Influencer deal — collect $100', e: { t: 'collect', n: 100 } },
  { text: 'App launch success — collect $150', e: { t: 'collect', n: 150 } },
  { text: 'Server costs — pay $50', e: { t: 'pay', n: 50 } },
  { text: 'Patent lawsuit — pay $200', e: { t: 'pay', n: 200 } },
  { text: 'Sponsorship deal — collect $75', e: { t: 'collect', n: 75 } },
  { text: 'Carbon tax — pay $30 per property', e: { t: 'payPerProperty', n: 30 } },
  { text: 'Infrastructure grant — collect $100', e: { t: 'collect', n: 100 } },
  { text: 'Banking fee — pay $25', e: { t: 'pay', n: 25 } },
  { text: 'Insurance premium — pay $50', e: { t: 'pay', n: 50 } },
  { text: 'Business expansion — collect $100', e: { t: 'collect', n: 100 } },
  { text: 'Pay workers — pay $40 per property owned', e: { t: 'payPerProperty', n: 40 } },
  { text: 'Quarterly bonus — collect $100', e: { t: 'collect', n: 100 } },
  { text: 'Tax audit — pay 10% of cash', e: { t: 'payPercent', f: 0.10 } },
  { text: 'Advance to Free Lunch', e: { t: 'move', dest: 20 } },
  { text: 'Nearest utility — pay 10× dice if owned', e: { t: 'nearestUtility' } },
  { text: 'Building subsidy — collect $200 if you own property', e: { t: 'collectIfProperty', n: 200 } },
];

// --- Player / auction / room ---

const START_MONEY = 1500;
const PASS_GO = 200;
const MAX_PLAYERS = 8;
const AUDIT_TURNS = 3;
const AUDIT_BAIL = 50;
const TOKEN_COLORS = ['#ff5f6d', '#4dd0e1', '#ffd54f', '#81c784', '#ba68c8', '#ff8a65', '#7986cb', '#f06292'];

// Phase timeouts (ms). Timing is driven by tick(now) rather than setTimeout.
const T_START_GRACE = 20_000;
const T_ROLL = 40_000;
const T_BUY = 22_000;
const T_BUILD = 30_000;
const T_AUCTION = 20_000;
const T_AUCTION_EXTEND = 8_000; // each bid pushes the deadline out to at least this much

export interface CrPlayer {
  pid: string;
  name: string;
  color: string;
  money: number;
  position: number;
  auditTurns: number;   // >0 = stuck in audit
  bankrupt: boolean;
  ready: boolean;
  owned: number[];             // board positions owned
  buildings: Record<number, number>; // position → 0..5 (5 = hotel)
  mortgaged: Set<number>;      // positions with no rent (raised cash)
  goRounds: number;            // times passed Payday (easter-egg counter)
  online: boolean;
  bot: boolean;                 // AI-controlled seat — never touches the coin economy
  botNextActAt: number;         // ms timestamp the bot's next decision fires (0 = not scheduled)
}

// A bot never wins real coins — the win payout is skipped entirely for a bot winner.
const BOT_NAMES = [
  '🤖 Baron Byte', '🤖 Mogul McRobot', '🤖 Rex Realtor', '🤖 Tilly Tycoon',
  '🤖 Duke Deedbot', '🤖 Cash Register', '🤖 Sir Sellsalot', '🤖 Landlordotron',
];

interface CrAuction {
  position: number;
  highBid: number;
  highPid: string | null;
  endsAt: number;
}

type Phase = 'waiting' | 'rolling' | 'buying' | 'auction' | 'building' | 'gameover';

interface CrRoom {
  id: string;
  phase: Phase;
  players: CrPlayer[];
  turnIdx: number;
  dice: [number, number];
  doublesStreak: number;
  rolledThisTurn: boolean;
  pendingBuy: number | null; // position awaiting buy/pass decision
  auction: CrAuction | null;
  lastCard: { deck: 'bulletin' | 'dispatch'; text: string } | null;
  bulletin: number[]; // shuffled index deck
  dispatch: number[];
  bIdx: number;
  dIdx: number;
  log: string[];
  winnerPid: string | null;
  deadline: number; // when the current phase auto-resolves (0 = none)
  startGraceAt: number; // when a not-yet-full lobby auto-starts (0 = none)
}

export class CityRiseManager {
  private rooms = new Map<string, CrRoom>();
  private playerRoom = new Map<string, string>(); // pid → room id
  private nextId = 1;
  private botSeq = 0;

  constructor(private hooks: CityRiseHooks) {}

  // --- lifecycle ---

  join(pid: string, name: string, color?: string): void {
    if (this.playerRoom.has(pid)) { const r = this.roomOf(pid); if (r) this.pushState(r); return; }
    let room = [...this.rooms.values()].find((r) => r.phase === 'waiting' && r.players.length < MAX_PLAYERS);
    if (!room) room = this.createRoom();
    const idx = room.players.length;
    let color2 = color && /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : TOKEN_COLORS[idx % TOKEN_COLORS.length];
    // Give each token a distinct colour even if players share a paddle colour.
    if (room.players.some((p) => p.color.toLowerCase() === color2.toLowerCase())) color2 = TOKEN_COLORS[idx % TOKEN_COLORS.length];
    const player: CrPlayer = {
      pid, name, color: color2,
      money: START_MONEY, position: 0, auditTurns: 0, bankrupt: false, ready: false,
      owned: [], buildings: {}, mortgaged: new Set(), goRounds: 0, online: true,
      bot: false, botNextActAt: 0,
    };
    room.players.push(player);
    this.playerRoom.set(pid, room.id);
    this.emit(room, `${name} entered City Tycoon.`, 'info');
    this.pushState(room);
  }

  leave(pid: string): void {
    const room = this.roomOf(pid);
    if (!room) return;
    this.playerRoom.delete(pid);

    if (room.phase === 'waiting') {
      room.players = room.players.filter((p) => p.pid !== pid);
      if (room.players.length === 0 || room.players.every((p) => p.bot)) { this.teardownRoom(room); return; }
      this.pushState(room);
      return;
    }

    // Mid-game: mark bankrupt (their properties return to the bank) and move on.
    const wasTheirTurn = room.players[room.turnIdx]?.pid === pid;
    const p = room.players.find((x) => x.pid === pid);
    if (p && !p.bankrupt) {
      this.emit(room, `${p.name} left the city. Their holdings return to the bank.`, 'warn');
      this.bankruptPlayer(room, p, null);
    } else if (p) {
      p.online = false;
    }
    if (!this.rooms.has(room.id)) return;
    // No point bots playing on alone once every human has bailed.
    if (room.players.every((x) => x.bot || !this.playerRoom.has(x.pid))) { this.teardownRoom(room); return; }
    if (room.phase !== 'gameover') {
      if (wasTheirTurn) this.nextTurn(room);
      else this.pushState(room);
    }
  }

  private teardownRoom(room: CrRoom): void {
    for (const p of room.players) this.playerRoom.delete(p.pid);
    this.rooms.delete(room.id);
  }

  ready(pid: string): void {
    const room = this.roomOf(pid);
    if (!room || room.phase !== 'waiting') return;
    const p = room.players.find((x) => x.pid === pid);
    if (!p) return;
    p.ready = true;
    this.emit(room, `${p.name} is ready. 🏙️`, 'info');
    this.maybeStart(room);
  }

  /** Start the game if everyone's ready, or arm the start-grace timer once someone is. Shared
   *  by a human readying up and a bot (which readies the instant it's seated). */
  private maybeStart(room: CrRoom): void {
    const readyCount = room.players.filter((x) => x.ready).length;
    if (room.players.length >= 2 && room.players.every((x) => x.ready)) {
      this.startGame(room);
      return;
    }
    if (room.players.length >= 2 && readyCount >= 1 && room.startGraceAt === 0) {
      room.startGraceAt = Date.now() + T_START_GRACE;
    }
    this.pushState(room);
  }

  /** "Add bot": seat an AI tycoon in an open slot. Waiting room only, ready immediately —
   *  the human(s) just need to ready up themselves to kick things off. */
  addBot(pid: string): void {
    const room = this.roomOf(pid);
    if (!room || room.phase !== 'waiting') return;
    if (room.players.length >= MAX_PLAYERS) return;
    const idx = room.players.length;
    const botPid = `bot-${room.id}-${++this.botSeq}`;
    let color = TOKEN_COLORS[idx % TOKEN_COLORS.length];
    if (room.players.some((p) => p.color.toLowerCase() === color.toLowerCase())) {
      color = TOKEN_COLORS[(idx + 1) % TOKEN_COLORS.length];
    }
    const takenNames = new Set(room.players.map((p) => p.name));
    const name = BOT_NAMES.find((n) => !takenNames.has(n)) ?? BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
    const bot: CrPlayer = {
      pid: botPid, name, color,
      money: START_MONEY, position: 0, auditTurns: 0, bankrupt: false, ready: true,
      owned: [], buildings: {}, mortgaged: new Set(), goRounds: 0, online: true,
      bot: true, botNextActAt: 0,
    };
    room.players.push(bot);
    this.playerRoom.set(botPid, room.id);
    this.emit(room, `${name} joined the city.`, 'info');
    this.maybeStart(room);
  }

  /** "Remove bot": kick a bot out of the room (any joined player may do this, any time). */
  removeBot(pid: string, botPid: string): void {
    const room = this.roomOf(pid);
    if (!room) return;
    const bot = room.players.find((x) => x.pid === botPid);
    if (!bot || !bot.bot) return;
    this.leave(botPid);
  }

  // --- actions ---

  roll(pid: string): void {
    const room = this.roomOf(pid);
    if (!room || room.phase !== 'rolling') return;
    const p = room.players[room.turnIdx];
    if (!p || p.pid !== pid || p.bankrupt) return;
    if (room.rolledThisTurn && room.doublesStreak === 0) return; // already rolled, no doubles bonus pending

    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    room.dice = [d1, d2];
    room.rolledThisTurn = true;
    const isDouble = d1 === d2;
    const total = d1 + d2;

    // In the drunk tank: only doubles (or the third strike / bail) frees you.
    if (p.auditTurns > 0) {
      if (isDouble) {
        p.auditTurns = 0;
        this.emit(room, `${p.name} rolled doubles and walked free from the drunk tank! 🔓`, 'success');
        room.doublesStreak = 0; // no bonus turn out of the drunk tank
        this.advanceToken(room, p, total);
      } else {
        p.auditTurns--;
        if (p.auditTurns <= 0) {
          this.emit(room, `${p.name} posted bail for $${AUDIT_BAIL} and moves on.`, 'info');
          this.pay(room, p, AUDIT_BAIL, null);
          if (p.bankrupt) { this.afterResolve(room); return; }
          this.advanceToken(room, p, total);
        } else {
          this.emit(room, `${p.name} is still sleeping it off in the drunk tank (${p.auditTurns} turn${p.auditTurns === 1 ? '' : 's'} left).`, 'warn');
          this.pushState(room);
          this.nextTurn(room); // drunk-tank turn burns your move
        }
      }
      return;
    }

    // Three doubles in a row = reckless driving → straight to the drunk tank.
    if (isDouble) {
      room.doublesStreak++;
      if (room.doublesStreak >= 3) {
        this.emit(room, `${p.name} rolled three doubles — Busted! Hauled off to the Drunk Tank for reckless driving. 🚔`, 'error');
        this.sendToAudit(room, p);
        this.pushState(room);
        this.nextTurn(room);
        return;
      }
      // Easter egg: boxcars pays a little bonus.
      if (d1 === 6) { p.money += 66; this.emit(room, `${p.name} rolled BOXCARS 🎲🎲 — a lucky $66 falls out of the sky!`, 'success'); }
      else if (d1 === 1) this.emit(room, `${p.name} rolled snake eyes 🐍 — spooky, but rolls again.`, 'info');
    } else {
      room.doublesStreak = 0;
    }
    this.advanceToken(room, p, total);
  }

  buy(pid: string): void {
    const room = this.roomOf(pid);
    if (!room || room.phase !== 'buying') return;
    const p = room.players[room.turnIdx];
    if (!p || p.pid !== pid || room.pendingBuy == null) return;
    const pos = room.pendingBuy;
    const space = BOARD[pos];
    const price = space.price ?? 0;
    if (p.money < price) { this.hooks.notify(pid, `You can't afford ${space.name} ($${price}).`); return; }
    p.money -= price;
    p.owned.push(pos);
    room.pendingBuy = null;
    this.emit(room, `${p.name} bought ${space.name} for $${price}. 🏢`, 'success');
    this.checkMonopolyFlair(room, p, space);
    this.toBuilding(room);
  }

  pass(pid: string): void {
    const room = this.roomOf(pid);
    if (!room || room.phase !== 'buying') return;
    const p = room.players[room.turnIdx];
    if (!p || p.pid !== pid || room.pendingBuy == null) return;
    // Start an auction for the declined property.
    this.startAuction(room, room.pendingBuy);
  }

  auctionBid(pid: string, amount: number): void {
    const room = this.roomOf(pid);
    if (!room || room.phase !== 'auction' || !room.auction) return;
    const p = room.players.find((x) => x.pid === pid);
    if (!p || p.bankrupt) return;
    amount = Math.floor(amount);
    if (!Number.isFinite(amount) || amount <= room.auction.highBid) return;
    if (amount > p.money) { this.hooks.notify(pid, `You only have $${p.money}.`); return; }
    room.auction.highBid = amount;
    room.auction.highPid = pid;
    room.auction.endsAt = Math.max(room.auction.endsAt, Date.now() + T_AUCTION_EXTEND);
    room.deadline = room.auction.endsAt;
    this.emit(room, `${p.name} bids $${amount} for ${BOARD[room.auction.position].name}.`, 'info');
    this.pushState(room);
  }

  build(pid: string, position: number): void {
    const room = this.roomOf(pid);
    if (!room || room.phase !== 'building') return;
    const p = room.players[room.turnIdx];
    if (!p || p.pid !== pid) return;
    const space = BOARD[position];
    if (space?.kind !== 'property' || !p.owned.includes(position)) { this.hooks.notify(pid, 'You can only build on your own property.'); return; }
    if (!this.hasMonopoly(p, space.group!)) { this.hooks.notify(pid, `You need every ${space.group} property to build.`); return; }
    if (p.mortgaged.has(position)) { this.hooks.notify(pid, 'Cannot build on a mortgaged lot.'); return; }
    const cur = p.buildings[position] ?? 0;
    if (cur >= 5) { this.hooks.notify(pid, `${space.name} already has a hotel. 🏨`); return; }
    // Even-build rule: don't outbuild the rest of the group.
    const groupMin = Math.min(...GROUPS[space.group!].map((q) => p.buildings[q] ?? 0));
    if (cur > groupMin) { this.hooks.notify(pid, 'Build evenly across the group first.'); return; }
    const cost = space.houseCost ?? 0;
    if (p.money < cost) { this.hooks.notify(pid, `Not enough cash ($${cost}) to build.`); return; }
    p.money -= cost;
    p.buildings[position] = cur + 1;
    const what = cur + 1 === 5 ? 'a hotel 🏨' : `house #${cur + 1} 🏠`;
    this.emit(room, `${p.name} built ${what} on ${space.name}.`, 'success');
    room.deadline = Date.now() + T_BUILD; // building resets the idle clock
    this.pushState(room);
  }

  endTurn(pid: string): void {
    const room = this.roomOf(pid);
    if (!room) return;
    if (room.phase !== 'building') return;
    const p = room.players[room.turnIdx];
    if (!p || p.pid !== pid) return;
    // A rolled double earns another roll (unless you just came out of audit — streak was reset).
    if (room.doublesStreak > 0 && !p.bankrupt && p.auditTurns === 0) {
      room.phase = 'rolling';
      room.rolledThisTurn = false;
      room.deadline = Date.now() + T_ROLL;
      this.emit(room, `${p.name} rolled doubles — roll again! 🎲`, 'info');
      this.pushState(room);
      return;
    }
    this.nextTurn(room);
  }

  // --- movement + landing resolution ---

  private advanceToken(room: CrRoom, p: CrPlayer, steps: number): void {
    let to = p.position + steps;
    if (to >= 40) { to -= 40; this.passGo(room, p); }
    p.position = to;
    this.pushState(room); // client animates from→to using dice + position
    this.resolveLanding(room, p);
  }

  private passGo(room: CrRoom, p: CrPlayer): void {
    p.money += PASS_GO;
    p.goRounds++;
    // Easter egg: every 7th lap the city throws you a bonus.
    if (p.goRounds % 7 === 0) { p.money += 77; this.emit(room, `${p.name} completed lap #${p.goRounds} — the mayor slips them a lucky $77! 🎉`, 'success'); }
    else this.emit(room, `${p.name} passed Payday and collected $${PASS_GO}. 💰`, 'success');
  }

  private resolveLanding(room: CrRoom, p: CrPlayer): void {
    const pos = p.position;
    const space = BOARD[pos];
    switch (space.kind) {
      case 'go':
      case 'visit_audit':
        this.toBuilding(room);
        break;
      case 'free_lunch':
        // Usually nothing… but sometimes there really is a free lunch.
        if (Math.random() < 0.25) { p.money += 50; this.emit(room, `${p.name} found $50 tucked under the free lunch tray! 🥪`, 'success'); }
        else this.emit(room, `${p.name} enjoys a Free Lunch. 🥪`, 'info');
        this.toBuilding(room);
        break;
      case 'bust_zone':
        this.emit(room, `${p.name} got Busted! — straight to the Drunk Tank! 🚨`, 'error');
        this.sendToAudit(room, p);
        this.pushState(room);
        this.nextTurn(room);
        break;
      case 'tax': {
        let amt = space.taxAmount ?? 0;
        if (space.name === 'The House Cut') amt = Math.min(150, Math.floor(this.netWorth(p) * 0.10));
        this.emit(room, `${p.name} pays ${space.name}: $${amt}. 🧾`, 'warn');
        this.pay(room, p, amt, null);
        this.afterResolve(room);
        break;
      }
      case 'card_bulletin':
        this.drawCard(room, p, 'bulletin');
        break;
      case 'card_dispatch':
        this.drawCard(room, p, 'dispatch');
        break;
      case 'property':
      case 'transit':
      case 'utility': {
        const owner = this.ownerOf(room, pos);
        if (!owner) {
          if (p.money >= (space.price ?? 0)) {
            room.pendingBuy = pos;
            room.phase = 'buying';
            room.deadline = Date.now() + T_BUY;
            this.emit(room, `${p.name} landed on ${space.name} ($${space.price}). Buy or auction?`, 'info');
            this.pushState(room);
          } else {
            // Can't afford it → straight to auction.
            this.emit(room, `${p.name} can't afford ${space.name} — up for auction!`, 'info');
            this.startAuction(room, pos);
          }
        } else if (owner.pid === p.pid) {
          this.toBuilding(room);
        } else if (owner.mortgaged.has(pos)) {
          this.emit(room, `${space.name} is mortgaged — no rent due.`, 'info');
          this.toBuilding(room);
        } else {
          const rent = this.computeRent(room, pos, room.dice[0] + room.dice[1]);
          this.emit(room, `${p.name} pays $${rent} rent to ${owner.name} for ${space.name}. 💸`, 'warn');
          this.pay(room, p, rent, owner);
          this.afterResolve(room);
        }
        break;
      }
    }
  }

  private afterResolve(room: CrRoom): void {
    if (room.phase === 'gameover') return;
    const p = room.players[room.turnIdx];
    if (p && p.bankrupt) { this.pushState(room); this.nextTurn(room); return; }
    this.toBuilding(room);
  }

  private toBuilding(room: CrRoom): void {
    if (room.phase === 'gameover') return;
    room.phase = 'building';
    room.pendingBuy = null;
    room.deadline = Date.now() + T_BUILD;
    this.pushState(room);
  }

  // --- cards ---

  private drawCard(room: CrRoom, p: CrPlayer, deck: 'bulletin' | 'dispatch'): void {
    const cards = deck === 'bulletin' ? BULLETIN : DISPATCH;
    const order = deck === 'bulletin' ? room.bulletin : room.dispatch;
    if (deck === 'bulletin') { if (room.bIdx >= order.length) { room.bIdx = 0; shuffle(order); } }
    else { if (room.dIdx >= order.length) { room.dIdx = 0; shuffle(order); } }
    const idx = deck === 'bulletin' ? room.bIdx++ : room.dIdx++;
    const card = cards[order[idx % order.length]];
    room.lastCard = { deck, text: card.text };
    this.emit(room, `${p.name} drew: ${card.text}`, 'info');
    this.applyCard(room, p, card.e);
  }

  private applyCard(room: CrRoom, p: CrPlayer, e: CardEffect): void {
    const others = () => room.players.filter((x) => x !== p && !x.bankrupt);
    switch (e.t) {
      case 'collect': p.money += e.n; this.afterResolve(room); break;
      case 'pay': this.pay(room, p, e.n, null); this.afterResolve(room); break;
      case 'collectEach': {
        for (const o of others()) { const take = Math.min(o.money, e.n); this.pay(room, o, take, p); }
        this.afterResolve(room); break;
      }
      case 'payEach': {
        for (const o of others()) { if (p.bankrupt) break; this.pay(room, p, e.n, o); }
        this.afterResolve(room); break;
      }
      case 'move': {
        if (e.dest < p.position) this.passGo(room, p);
        p.position = e.dest;
        this.pushState(room);
        this.resolveLanding(room, p);
        break;
      }
      case 'moveForward': this.advanceToken(room, p, e.n); break;
      case 'moveBack': {
        p.position = (p.position - e.n + 40) % 40;
        this.pushState(room);
        this.resolveLanding(room, p);
        break;
      }
      case 'goAudit': this.sendToAudit(room, p); this.pushState(room); this.nextTurn(room); break;
      case 'payPerProperty': this.pay(room, p, e.n * p.owned.length, null); this.afterResolve(room); break;
      case 'collectPerProperty': p.money += e.n * p.owned.length; this.afterResolve(room); break;
      case 'collectPerSet': p.money += e.n * this.setsOwned(p); this.afterResolve(room); break;
      case 'payPercent': this.pay(room, p, Math.floor(p.money * e.f), null); this.afterResolve(room); break;
      case 'collectIfProperty': if (p.owned.length > 0) p.money += e.n; this.afterResolve(room); break;
      case 'nearestTransit': {
        let d = 1; while (!TRANSITS.includes((p.position + d) % 40)) d++;
        if (p.position + d >= 40) this.passGo(room, p);
        p.position = (p.position + d) % 40;
        this.pushState(room);
        const owner = this.ownerOf(room, p.position);
        if (owner && owner.pid !== p.pid && !owner.mortgaged.has(p.position)) {
          const rent = this.computeRent(room, p.position, room.dice[0] + room.dice[1]) * 2;
          this.emit(room, `${p.name} pays DOUBLE transit rent $${rent} to ${owner.name}. 🚆`, 'warn');
          this.pay(room, p, rent, owner); this.afterResolve(room);
        } else { this.resolveLanding(room, p); }
        break;
      }
      case 'nearestUtility': {
        let d = 1; while (!UTILITIES.includes((p.position + d) % 40)) d++;
        if (p.position + d >= 40) this.passGo(room, p);
        p.position = (p.position + d) % 40;
        this.pushState(room);
        const owner = this.ownerOf(room, p.position);
        if (owner && owner.pid !== p.pid && !owner.mortgaged.has(p.position)) {
          const rent = (room.dice[0] + room.dice[1]) * 10;
          this.emit(room, `${p.name} pays $${rent} (10× dice) to ${owner.name} for ${BOARD[p.position].name}. ⚡`, 'warn');
          this.pay(room, p, rent, owner); this.afterResolve(room);
        } else { this.resolveLanding(room, p); }
        break;
      }
    }
  }

  // --- economy ---

  private pay(room: CrRoom, from: CrPlayer, amount: number, to: CrPlayer | null): void {
    if (amount <= 0) return;
    if (from.money < amount) {
      // Try to raise cash by liquidating buildings + mortgaging lots at half value.
      this.liquidate(from, amount);
    }
    if (from.money < amount) {
      // Still short → bankrupt. Give whatever's left to the creditor.
      const remainder = Math.max(0, from.money);
      if (to) to.money += remainder;
      from.money = 0;
      this.emit(room, `${from.name} is BANKRUPT! 💀`, 'error');
      this.bankruptPlayer(room, from, to);
      return;
    }
    from.money -= amount;
    if (to) to.money += amount;
  }

  private liquidate(p: CrPlayer, need: number): void {
    // Sell houses (half cost) then mortgage lots (half price) until the need is met.
    for (const pos of p.owned) {
      while ((p.buildings[pos] ?? 0) > 0 && p.money < need) {
        p.buildings[pos]--;
        p.money += Math.floor((BOARD[pos].houseCost ?? 0) / 2);
      }
    }
    for (const pos of p.owned) {
      if (p.money >= need) break;
      if (!p.mortgaged.has(pos)) { p.mortgaged.add(pos); p.money += Math.floor((BOARD[pos].price ?? 0) / 2); }
    }
  }

  private bankruptPlayer(room: CrRoom, p: CrPlayer, creditor: CrPlayer | null): void {
    p.bankrupt = true;
    // Properties revert to the bank (auction fodder). Buildings vanish.
    p.owned = [];
    p.buildings = {};
    p.mortgaged = new Set();
    void creditor;
    const alive = room.players.filter((x) => !x.bankrupt);
    if (alive.length <= 1) this.endGame(room, alive[0] ?? null);
  }

  // --- audit / jail ---

  private sendToAudit(room: CrRoom, p: CrPlayer): void {
    p.position = 10;
    p.auditTurns = AUDIT_TURNS;
    room.doublesStreak = 0;
  }

  // --- turns ---

  private startGame(room: CrRoom): void {
    room.phase = 'rolling';
    room.turnIdx = 0;
    room.rolledThisTurn = false;
    room.doublesStreak = 0;
    room.startGraceAt = 0;
    room.deadline = Date.now() + T_ROLL;
    shuffle(room.bulletin); shuffle(room.dispatch);
    room.bIdx = 0; room.dIdx = 0;
    this.emit(room, `🏙️ City Tycoon begins! ${room.players[0].name} rolls first.`, 'success');
    this.pushState(room);
  }

  private nextTurn(room: CrRoom): void {
    if (room.phase === 'gameover') return;
    room.doublesStreak = 0;
    room.rolledThisTurn = false;
    room.pendingBuy = null;
    room.auction = null;
    room.lastCard = null;
    const alive = room.players.filter((x) => !x.bankrupt);
    if (alive.length <= 1) { this.endGame(room, alive[0] ?? null); return; }
    const n = room.players.length;
    let idx = room.turnIdx;
    for (let guard = 0; guard < n; guard++) {
      idx = (idx + 1) % n;
      if (!room.players[idx]?.bankrupt) break;
    }
    room.turnIdx = idx;
    const p = room.players[idx];
    room.phase = 'rolling';
    room.deadline = Date.now() + T_ROLL;
    this.emit(room, `It's ${p.name}'s turn. 🎲`, 'info');
    this.pushState(room);
  }

  private endGame(room: CrRoom, winner: CrPlayer | null): void {
    if (room.phase === 'gameover') return;
    room.phase = 'gameover';
    room.winnerPid = winner?.pid ?? null;
    room.deadline = 0;
    if (winner) {
      const prize = 400 + room.players.length * 50;
      this.emit(room, `👑 ${winner.name} is the last tycoon standing and wins ${prize} 🪙!`, 'success');
      // Bots never touch the real coin economy — a bot winner gets bragging rights only.
      if (!winner.bot) {
        try { void this.hooks.award(winner.pid, winner.name, prize); } catch (e) { console.error('cityrise award failed:', e); }
      }
    } else {
      this.emit(room, 'The city went bust. No winner!', 'warn');
    }
    this.pushState(room);
    // Reset the room to a fresh lobby after a short celebration.
    setTimeout(() => {
      if (!this.rooms.has(room.id)) return;
      for (const p of room.players) {
        p.money = START_MONEY; p.position = 0; p.auditTurns = 0; p.bankrupt = false;
        p.owned = []; p.buildings = {}; p.mortgaged = new Set(); p.ready = false; p.goRounds = 0;
      }
      room.phase = 'waiting';
      room.winnerPid = null; room.turnIdx = 0; room.startGraceAt = 0; room.deadline = 0;
      room.log = []; room.lastCard = null;
      if (room.players.length === 0) this.rooms.delete(room.id);
      else this.pushState(room);
    }, 15_000);
  }

  // --- auctions ---

  private startAuction(room: CrRoom, position: number): void {
    room.pendingBuy = null;
    room.phase = 'auction';
    room.auction = { position, highBid: 0, highPid: null, endsAt: Date.now() + T_AUCTION };
    room.deadline = room.auction.endsAt;
    this.emit(room, `🔨 Auction for ${BOARD[position].name}! Highest bid wins.`, 'info');
    this.pushState(room);
  }

  private resolveAuction(room: CrRoom): void {
    const a = room.auction;
    if (!a) { this.toBuilding(room); return; }
    if (a.highPid) {
      const w = room.players.find((x) => x.pid === a.highPid);
      if (w && w.money >= a.highBid) {
        w.money -= a.highBid;
        w.owned.push(a.position);
        this.emit(room, `${w.name} won ${BOARD[a.position].name} at auction for $${a.highBid}! 🔨`, 'success');
        this.checkMonopolyFlair(room, w, BOARD[a.position]);
      }
    } else {
      this.emit(room, `No bids — ${BOARD[a.position].name} stays with the bank.`, 'info');
    }
    room.auction = null;
    this.toBuilding(room);
  }

  // --- helpers ---

  private ownerOf(room: CrRoom, pos: number): CrPlayer | null {
    for (const p of room.players) if (!p.bankrupt && p.owned.includes(pos)) return p;
    return null;
  }

  private hasMonopoly(p: CrPlayer, group: string): boolean {
    return GROUPS[group].every((q) => p.owned.includes(q));
  }

  private setsOwned(p: CrPlayer): number {
    let n = 0;
    for (const g of Object.keys(GROUPS)) if (this.hasMonopoly(p, g)) n++;
    return n;
  }

  private computeRent(room: CrRoom, pos: number, diceTotal: number): number {
    const space = BOARD[pos];
    const owner = this.ownerOf(room, pos);
    if (!owner) return 0;
    if (space.kind === 'transit') {
      const count = owner.owned.filter((q) => BOARD[q].kind === 'transit').length;
      return TRANSIT_RENT[Math.max(0, Math.min(3, count - 1))];
    }
    if (space.kind === 'utility') {
      const count = owner.owned.filter((q) => BOARD[q].kind === 'utility').length;
      return diceTotal * (count >= 2 ? 10 : 4);
    }
    // property
    const houses = owner.buildings[pos] ?? 0;
    const rent = space.rent!;
    if (houses > 0) return rent[houses + 1];
    return this.hasMonopoly(owner, space.group!) ? rent[1] : rent[0];
  }

  private netWorth(p: CrPlayer): number {
    let w = p.money;
    for (const pos of p.owned) {
      w += BOARD[pos].price ?? 0;
      w += (p.buildings[pos] ?? 0) * (BOARD[pos].houseCost ?? 0);
    }
    return w;
  }

  private checkMonopolyFlair(room: CrRoom, p: CrPlayer, space: Space): void {
    if (space.kind === 'property' && space.group && this.hasMonopoly(p, space.group)) {
      this.emit(room, `${p.name} now owns the entire ${space.group} group — build away! 🏘️`, 'success');
    }
  }

  // --- timing (driven from the Lobby tick) ---

  tick(now: number): void {
    for (const room of this.rooms.values()) {
      if (room.phase === 'waiting') {
        if (room.startGraceAt > 0 && now >= room.startGraceAt) {
          if (room.players.filter((p) => p.ready).length >= 1 && room.players.length >= 2) this.startGame(room);
          else room.startGraceAt = 0;
        }
        continue;
      }
      if (room.deadline > 0 && now >= room.deadline) {
        this.autoResolve(room);
      }
      this.stepBots(room, now);
    }
  }

  // --- bots ---

  /** Drive every bot seated in this room: each gets a short "thinking" pause before acting,
   *  so a room full of bots doesn't resolve a whole game in a single tick. */
  private stepBots(room: CrRoom, now: number): void {
    if (room.phase === 'gameover') return;
    for (const bot of room.players) {
      if (!bot.bot || bot.bankrupt) continue;
      const act = this.botDecision(room, bot);
      if (!act) { bot.botNextActAt = 0; continue; }
      if (bot.botNextActAt === 0) { bot.botNextActAt = now + 500 + Math.random() * 900; continue; }
      if (now < bot.botNextActAt) continue;
      bot.botNextActAt = 0;
      act();
    }
  }

  /** What a bot should do right now, or null if it has nothing pending this tick. */
  private botDecision(room: CrRoom, bot: CrPlayer): (() => void) | null {
    const turnPid = room.players[room.turnIdx]?.pid;
    if (room.phase === 'rolling' && turnPid === bot.pid) {
      return () => this.roll(bot.pid);
    }
    if (room.phase === 'buying' && turnPid === bot.pid && room.pendingBuy != null) {
      const price = BOARD[room.pendingBuy].price ?? 0;
      // Buys eagerly while flush; gets stingy once cash runs low.
      return () => { if (bot.money - price >= 100) this.buy(bot.pid); else this.pass(bot.pid); };
    }
    if (room.phase === 'building' && turnPid === bot.pid) {
      return () => this.botBuild(bot);
    }
    if (room.phase === 'auction' && room.auction && room.auction.highPid !== bot.pid) {
      const a = room.auction;
      const price = BOARD[a.position].price ?? 0;
      const maxBid = Math.floor(price * 1.1); // won't chase a lot past 110% of sticker
      const nextBid = a.highBid + Math.max(10, Math.round(price * 0.08));
      if (nextBid > maxBid || nextBid > bot.money - 50) return null; // priced out — sit this one out
      return () => this.auctionBid(bot.pid, nextBid);
    }
    return null;
  }

  /** Builds one house/hotel on the cheapest eligible monopoly (keeping a cash buffer), or
   *  ends the turn once there's nothing left worth building. */
  private botBuild(bot: CrPlayer): void {
    for (const group of Object.keys(GROUPS)) {
      if (!this.hasMonopoly(bot, group)) continue;
      const positions = GROUPS[group];
      const groupMin = Math.min(...positions.map((q) => bot.buildings[q] ?? 0));
      if (groupMin >= 5) continue;
      const pos = positions.find((q) => (bot.buildings[q] ?? 0) === groupMin && !bot.mortgaged.has(q));
      if (pos == null) continue;
      const cost = BOARD[pos].houseCost ?? 0;
      if (bot.money - cost >= 200) { this.build(bot.pid, pos); return; }
    }
    this.endTurn(bot.pid);
  }

  private autoResolve(room: CrRoom): void {
    const p = room.players[room.turnIdx];
    switch (room.phase) {
      case 'rolling':
        if (p) { this.emit(room, `${p.name} took too long — auto-rolling. ⏱️`, 'warn'); this.roll(p.pid); }
        break;
      case 'buying':
        this.emit(room, `${p?.name ?? 'Player'} timed out — property goes to auction.`, 'warn');
        if (room.pendingBuy != null) this.startAuction(room, room.pendingBuy);
        else this.toBuilding(room);
        break;
      case 'auction':
        this.resolveAuction(room);
        break;
      case 'building':
        if (p) this.endTurn(p.pid);
        else this.nextTurn(room);
        break;
    }
  }

  // --- state snapshot ---

  private roomOf(pid: string): CrRoom | undefined {
    const rid = this.playerRoom.get(pid);
    return rid ? this.rooms.get(rid) : undefined;
  }

  private createRoom(): CrRoom {
    const id = `cr-${this.nextId++}`;
    const room: CrRoom = {
      id, phase: 'waiting', players: [], turnIdx: 0, dice: [1, 1], doublesStreak: 0,
      rolledThisTurn: false, pendingBuy: null, auction: null, lastCard: null,
      bulletin: BULLETIN.map((_, i) => i), dispatch: DISPATCH.map((_, i) => i),
      bIdx: 0, dIdx: 0, log: [], winnerPid: null, deadline: 0, startGraceAt: 0,
    };
    this.rooms.set(id, room);
    return room;
  }

  private emit(room: CrRoom, text: string, kind: 'info' | 'warn' | 'success' | 'error'): void {
    room.log.push(text);
    if (room.log.length > 40) room.log.shift();
    const pids = room.players.map((p) => p.pid);
    this.hooks.broadcast(pids, { type: 'crEvent', text, kind });
  }

  private pushState(room: CrRoom): void {
    const pids = room.players.map((p) => p.pid);
    this.hooks.broadcast(pids, { type: 'crState', game: this.snapshot(room) });
  }

  private snapshot(room: CrRoom): object {
    return {
      id: room.id,
      phase: room.phase,
      turnPid: room.players[room.turnIdx]?.pid ?? null,
      dice: room.dice,
      doublesStreak: room.doublesStreak,
      rolledThisTurn: room.rolledThisTurn,
      pendingBuy: room.pendingBuy,
      auction: room.auction
        ? { position: room.auction.position, name: BOARD[room.auction.position].name, highBid: room.auction.highBid, highPid: room.auction.highPid, endsAt: room.auction.endsAt }
        : null,
      lastCard: room.lastCard,
      winnerPid: room.winnerPid,
      deadline: room.deadline,
      log: room.log.slice(-8),
      board: BOARD,
      players: room.players.map((p) => ({
        pid: p.pid, name: p.name, color: p.color, money: p.money, position: p.position,
        auditTurns: p.auditTurns, bankrupt: p.bankrupt, ready: p.ready, online: p.online,
        owned: p.owned, buildings: p.buildings, mortgaged: [...p.mortgaged], bot: p.bot,
      })),
    };
  }

  /** For a reconnecting player — returns their room snapshot or null. */
  getState(pid: string): object | null {
    const room = this.roomOf(pid);
    return room ? this.snapshot(room) : null;
  }
}

// Fisher–Yates shuffle in place.
function shuffle<T>(a: T[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}
