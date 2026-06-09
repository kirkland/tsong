// Tracks every connected socket, which two of them hold the paddle spots, and turns
// the Game's raw state into the broadcast message (attaching nicknames / watchers).

import type { WebSocket } from 'ws';
import { Game } from './game';
import {
  CHAT_HISTORY,
  CHAT_MAX_LEN,
  ChatLine,
  BALL_REACTION,
  COURT,
  FATALITY_MOVES,
  LeaderboardRow,
  PaddleState,
  Role,
  ServerMsg,
  Side,
  StateMsg,
  TEAM_MAX,
} from '../shared/types';
import { getLeaderboard, recordResult, updateName } from './db';
import { READY_TIMEOUT, TICK_MS, PINATA } from '../shared/types';

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
  lastChatAt: number; // ms timestamp of last chat message (light rate limiting)
}

const SIDES: Side[] = ['left', 'right'];
const FATALITY_DISPLAY_MS = 4500; // how long the finishing move holds before the lobby resets
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
  private leaderboard: LeaderboardRow[] = []; // cached standings, pushed to clients
  private chatLog: ChatLine[] = []; // recent chat, replayed to new connections
  private nextId = 1;

  // Streamer mode: fake chat bots spam the chat to distract players.
  private streamerMode = false;
  private streamerTick = 0; // ticks since last bot message
  private streamerNextAt = 0; // tick count to fire next bot message
  private streamerLastScore = { left: 0, right: 0 };

  // Restart resume: seats/king/queue a previous process held, keyed by stable pid,
  // waiting for those clients to reconnect and reclaim them (see restore/reattach).
  private pendingSides: Record<Side, SeatInfo[]> = { left: [], right: [] };
  private pendingKing: { side: Side; pid: string; nickname: string } | null = null;
  private pendingQueue: { pid: string; nickname: string }[] = [];
  private resumeGrace = 0; // seconds left to reclaim seats before abandoning the resume

  constructor(private game: Game) {}

  add(ws: WebSocket) {
    const conn: Conn = {
      id: String(this.nextId++),
      pid: '',
      nickname: '',
      role: 'observer',
      color: '#e8eefc',
      captured: false,
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
      player: conn.role === 'left' || conn.role === 'right',
      color: conn.color,
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

  /** "/ff": a player abandons their paddle mid-match and is publicly shamed for it. */
  forfeit(ws: WebSocket) {
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
    // ...but loudly, so everyone knows.
    this.announce(`Booo, ${name} quit the game`);
  }

  /** Join the spectator queue. */
  queueJoin(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return;
    if (this.queue.includes(ws)) return;
    // Don't queue if already holding a paddle
    if (this.sideOf(ws)) return;
    this.queue.push(ws);
  }

  /** Leave the spectator queue. */
  queueLeave(ws: WebSocket) {
    const i = this.queue.indexOf(ws);
    if (i !== -1) this.queue.splice(i, 1);
  }

  /** Auto-assign the next queued spectator to a side left with no players. */
  private claimFromQueue() {
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
  }

  /** Toggle ready state for a player. */
  setReady(ws: WebSocket) {
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

  /** "/powerup": drop a random power-up target. Spectators only — a player in the
   *  current match can't conjure power-ups for themselves. */
  spawnPowerup(ws: WebSocket) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return; // must have joined
    if (this.sideOf(ws)) return; // not from someone currently holding a paddle
    if (this.game.forceTarget()) this.echoCommand(conn, '/powerup');
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
    // Honor the requested side; otherwise auto-assign to the smaller team.
    const pick: Side =
      side ?? (this.teams.left.length <= this.teams.right.length ? 'left' : 'right');
    if (this.teams[pick].length >= TEAM_MAX) return; // that side is full
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
    const side = this.sideOf(ws);
    const conn = this.conns.get(ws);
    if (side && conn) this.game.setTarget(side, conn.id, y);
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
    this.game.paused = !(this.isCaptured('left') && this.isCaptured('right'));
  }

  // Any joined client may toggle game modes.
  setMode(ws: WebSocket, opts: { closing?: boolean; gravity?: boolean; turbo?: boolean; streamer?: boolean; diamond?: boolean; pinata?: boolean; layered?: boolean }) {
    const conn = this.conns.get(ws);
    if (!conn || !conn.nickname) return;
    if (opts.closing !== undefined) this.game.setClosing(opts.closing);
    if (opts.gravity !== undefined) this.game.setGravity(opts.gravity);
    if (opts.turbo !== undefined) this.game.setTurbo(opts.turbo);
    if (opts.streamer !== undefined) this.streamerMode = opts.streamer;
    if (opts.diamond !== undefined) this.game.setDiamond(opts.diamond);
    if (opts.pinata !== undefined) this.game.setPinata(opts.pinata);
    if (opts.layered !== undefined) this.game.setLayered(opts.layered);
  }

  remove(ws: WebSocket) {
    const side = this.sideOf(ws);
    if (side) {
      this.unseat(ws);
      // The match only drops back to waiting if their whole team is gone.
      if (this.game.status === 'playing' && this.teams[side].length === 0) this.game.toWaiting();
    }
    if (this.king && this.king.ws === ws) this.king = null;
    if (this.conns.get(ws)?.pid === this.streakPid) this.endStreak(); // streak holder left
    this.queueLeave(ws);
    this.conns.delete(ws);
    this.refreshPause();
  }

  /** Called every tick after game.tick(). Reopens both spots once a match ends. */
  sync() {
    this.expireResume();
    // Reopen both spots exactly once, when the match first ends. Doing this every
    // tick would re-release the next player the instant they claim a spot, making it
    // impossible to start a second game.
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

        // The leaderboard tracks head-to-head records, so only true 1v1 results count.
        if (winners.length === 1 && losers.length === 1 && winners[0].pid && losers[0].pid) {
          recordResult(winners[0].pid, winners[0].nickname, losers[0].pid, losers[0].nickname)
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
    // Keep the pause flag honest every tick: a live match only advances once both
    // players have captured their mouse, no matter how the seats got filled.
    this.refreshPause();

    if (this.streamerMode && this.game.status === 'playing') this.tickStreamer();
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
      player: conn.role === 'left' || conn.role === 'right',
      color: conn.color,
      command: true,
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
    const line: ChatLine = { from, text, player: false, color };
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
    const lastHit = this.game.lastHit;
    const ballColor = lastHit ? this.colorOf(lastHit) : '#e8eefc';
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
      };
    };
    return {
      type: 'state',
      ball: {
        x: this.game.ball.x,
        y: this.game.ball.y,
        // Take on the color of the paddle that last hit it; neutral until first touch.
        color: ballColor,
      },
      extraBalls: this.game.extraBalls.map((b) => ({ x: b.x, y: b.y, color: ballColor })),
      ballSpeed: Math.hypot(this.game.ball.vx, this.game.ball.vy),
      paddles: { left: sideState('left'), right: sideState('right') },
      target: this.game.target
        ? { x: this.game.target.x, y: this.game.target.y, kind: this.game.target.kind }
        : null,
      score: { ...this.game.score },
      status: this.game.status,
      paused: this.game.status === 'playing' && this.game.paused,
      closing: this.game.closing,
      layered: this.game.layered,
      gravity: this.game.gravity,
      turbo: this.game.turbo,
      diamond: this.game.diamond,
      diamondPos: this.game.diamondBlock
        ? { x: this.game.diamondBlock.x, y: this.game.diamondBlock.y }
        : null,
      rotated: this.game.rotated,
      pinata: this.game.pinata,
      pinataPos: this.pinataView(),
      winner: this.game.status === 'over' ? this.winnerName : null,
      fatalitiesEnabled: this.fatalitiesEnabled,
      fatality: this.game.status === 'over' ? this.activeFatality : null,
      watchers,
      king: this.king?.nickname ?? null,
      kingWins: this.kingStreak,
      queue: this.queue.map((ws) => this.conns.get(ws)?.nickname ?? '').filter(Boolean),
      ready: { ...this.ready },
      ghostBall: this.game.ghostTimer > 0,
      tinyBall: this.game.tinyTimer > 0,
      bigBall: this.game.bigBallTimer > 0,
      streamerMode: this.streamerMode,
    };
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
