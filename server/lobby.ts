// Tracks every connected socket, which two of them hold the paddle spots, and turns
// the Game's raw state into the broadcast message (attaching nicknames / watchers).

import type { WebSocket } from 'ws';
import { Game } from './game';
import { PolyGame } from './polygame';
import {
  CHAT_HISTORY,
  CHAT_MAX_LEN,
  ChatLine,
  BALL_REACTION,
  BotLevel,
  COURT,
  ARENA,
  FATALITY_MOVES,
  LeaderboardRow,
  MAX_PLAYERS,
  PaddleState,
  POWERUPS,
  PowerupKind,
  PolyPlayer,
  PolyState,
  Role,
  ServerMsg,
  Side,
  StateMsg,
  TEAM_MAX,
} from '../shared/types';
import { getLeaderboard, recordResult, updateName } from './db';
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
}

const SIDES: Side[] = ['left', 'right'];
const FATALITY_DISPLAY_MS = 4500; // how long the finishing move holds before the lobby resets
const POLY_OVER_SECS = 5; // how long the arena win screen lingers before the next round
const RESUME_GRACE = 45; // seconds a resumed match waits for seated players to reconnect

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
  private fatalitiesEnabled = false; // shared room-wide toggle (off for everyone by default)
  private queue: WebSocket[] = []; // ordered spectators waiting to play
  private ready: Record<Side, boolean> = { left: false, right: false };
  private readyTimer = 0; // seconds remaining for ready-up; 0 = no timer active
  private captureCountdown = 0; // soonest pending bench-the-laggard timer, in seconds (0 = none running)
  private leaderboard: LeaderboardRow[] = []; // cached standings, pushed to clients
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
    };
    this.conns.set(ws, conn);
    this.tell(ws, { type: 'you', id: conn.id, role: 'observer' });
    this.tell(ws, { type: 'leaderboard', rows: this.leaderboard });
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

  /** "Add bot": drop an AI opponent into an open duel side. If the requester is an
   *  observer, seat them first so it's a real 1v1 against the bot. Duel mode only. */
  addBot(ws: WebSocket, level: BotLevel) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return;
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

  /** "Kick bot": remove the AI opponent (any joined player may do this). */
  removeBot(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return;
    this.removeBotInternal();
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
  }

  claim(ws: WebSocket, side?: Side) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname || conn.role !== 'observer') return;
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

  setPaddle(ws: WebSocket, y: number) {
    const conn = this.conns.get(ws);
    if (!conn) return;
    if (this.mode === 'poly') {
      // In arena mode the wire `y` is the paddle's 1D offset along its edge.
      if (this.arenaSeats.includes(ws)) this.poly.setTarget(conn.id, y);
      return;
    }
    const side = this.sideOf(ws);
    if (side) this.game.setTarget(side, conn.id, y);
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
  setMode(ws: WebSocket, opts: { closing?: boolean; gravity?: boolean; turbo?: boolean; streamer?: boolean; diamond?: boolean; pinata?: boolean; layered?: boolean; arena?: boolean; viewMode?: string }) {
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
    if (opts.viewMode === 'normal' || opts.viewMode === '3d' || opts.viewMode === 'firstperson') {
      this.viewMode = opts.viewMode;
    }
  }

  /** Arm / disarm arena mode. Turning it off while a polygon match is live folds the
   *  remaining players back down to the classic two-player box. */
  private setArena(on: boolean) {
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
    if (this.mode === 'poly') this.polySync();
    else this.duelSync();
    // Bench anyone holding up a live, ready opponent by not capturing their mouse.
    this.enforceCaptureTimeout();
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
    const winners = refs.filter((c) => c.id === winnerId).map((c) => ({ pid: c.pid, name: c.nickname }));
    const losers = refs.filter((c) => c.id !== winnerId).map((c) => ({ pid: c.pid, name: c.nickname }));
    if (winners.length && losers.length) {
      recordResult(winners, losers)
        .then(() => this.refreshLeaderboard())
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
            .then(() => this.refreshLeaderboard())
            .catch((e) => console.error('leaderboard update failed:', e));
        }
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
  setFatalities(ws: WebSocket, enabled: boolean) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return; // must have joined
    this.fatalitiesEnabled = enabled;
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
  private announce(text: string) {
    const data = JSON.stringify({ type: 'announce', text });
    for (const sock of this.conns.keys()) {
      if (sock.readyState === sock.OPEN) sock.send(data);
    }
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
        players,
        freezeTimer: Math.max(0, this.game.freezeTimer[side]),
        blindTimer: Math.max(0, this.game.blindTimer[side]),
        mirrorTimer: Math.max(0, this.game.mirrorTimer[side]),
        growHits: this.game.growHits[side],
        shrinkHits: this.game.shrinkHits[side],
        smashHits: this.game.smashHits[side],
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
      rotated: this.game.rotated,
      fritz: this.game.fritz,
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
    this.fatalitiesEnabled = !!s.fatalitiesEnabled;
    this.ready = s.ready ?? { left: false, right: false };
    this.readyTimer = s.readyTimer ?? 0;
    this.winnerName = s.winnerName ?? null;
    this.overHandled = !!s.overHandled;
    this.chatLog = Array.isArray(s.chatLog) ? s.chatLog : [];
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
];

const GOAL_REACTIONS_SCORER: string[] = [
  'GG EZ NO DIFF', 'YESSSS GET REKT', 'LETS GO {scorer}!!!',
  'that was a CANNON', 'clean af', 'POG {scorer}',
  'OMEGALUL they didn\'t even try', 'GOTTEM',
  '{scorer} is NOT missing', 'absolute cinema',
  'CLIPPED THAT', 'W + ratio', '🎯🎯🎯',
  '{scorer} DIFF', 'another one lol',
];

const GOAL_REACTIONS_LOSER: string[] = [
  'NGL that was a skill issue', 'terrible defense rn',
  '{loser} is lost 😂', 'how do you miss that bro',
  'L + ratio + touch grass', 'that\'s an L for {loser}',
  'bozo', 'bro fell off', 'unplayable',
  '{loser} said "i got it" 💀', 'my eyes 😭',
  'that hurt to watch', 'certified fumble',
];
