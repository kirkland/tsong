// HTTP + WebSocket entry point. In production it also serves the built client from
// client/dist so the page and the WebSocket share a single origin.

import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import sirv from 'sirv';
import { BOT_LEVELS, BotLevel, ClientMsg, TICK_MS, TickHealth } from '../shared/types';
import { Game, GameSnapshot } from './game';
import { Lobby, LobbySnapshot } from './lobby';
import { initDb, migratePlayer } from './db';
import { getChangelog } from './changelog';
import { loadSnapshot, saveSnapshot } from './persist';
import {
  handleAuthGoogle, handleAuthCallback, handleAuthMe, handleLogout, parseSession,
} from './auth';
import type { AuthSession } from './auth';

const PORT = Number(process.env.PORT ?? 3000);

const game = new Game();
const lobby = new Lobby(game);

// Resume across a restart/deploy: if the previous process left a fresh snapshot, restore
// the match so reconnecting players land back in it (frozen until they re-capture their
// mice) instead of losing it. No-op on a clean start or a stale/missing snapshot.
const snap = loadSnapshot<GameSnapshot, LobbySnapshot>();
if (snap) {
  try {
    game.restore(snap.game);
    lobby.restore(snap.lobby);
    console.log('resumed game state from snapshot');
  } catch (e) {
    console.error('snapshot restore failed — starting fresh:', e);
  }
}

// Bring up the leaderboard DB and prime the cache. The server starts serving
// immediately; standings populate once the DB is ready (no-op without DATABASE_URL).
initDb()
  .then(() => Promise.all([lobby.refreshLeaderboard(), lobby.refreshDoomLeaderboards(), lobby.refreshCampaignLeaderboards(), lobby.loadStockPrices(), lobby.loadModes()]))
  .catch((e) => console.error('DB init failed:', e));

// Static client (only exists after `npm run build`; harmless in dev where Vite serves it).
const serveStatic = sirv(path.resolve(process.cwd(), 'client/dist'), {
  single: true,
  dev: false,
});

const server = http.createServer((req, res) => {
  // Liveness + match state, polled by the deploy script so it can hold a restart until
  // there's a break between matches (no rally gets cut off).
  if (req.url === '/api/status') {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-cache');
    res.end(JSON.stringify({ status: game.status, playing: lobby.isPlaying() }));
    return;
  }
  // Recent commit messages for the in-app CHANGELOG dropdown.
  if (req.url === '/api/changelog') {
    getChangelog()
      .then((commits) => {
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-cache');
        res.end(JSON.stringify({ commits }));
      })
      .catch(() => {
        res.statusCode = 500;
        res.end('{"commits":[]}');
      });
    return;
  }
  if (req.url === '/auth/google') { handleAuthGoogle(req, res); return; }
  if (req.url === '/auth/me')     { handleAuthMe(req, res);     return; }
  if (req.url === '/auth/logout') { handleLogout(req, res);     return; }
  if (req.url?.startsWith('/auth/google/callback')) {
    handleAuthCallback(req, res).catch(() => {
      res.writeHead(302, { Location: '/?auth_error=1' });
      res.end();
    });
    return;
  }
  serveStatic(req, res, () => {
    res.statusCode = 404;
    res.end('Not found');
  });
});

// --- tick-health monitor ---------------------------------------------------------------
// The authoritative loop must hold 60 Hz; if a tick's work overruns its 16.7 ms budget the
// whole room feels laggy at once. We sample each tick's work time and the achieved tick rate
// so the health can be surfaced to clients (it rides along on the rtt echo) and loudly logged
// when the loop falls behind. tickHealth() is read by the connection handler below — it's a
// hoisted declaration, and the state it reads is initialized before any socket connects.
const TICK_WINDOW = 300; // per-tick work samples kept for the rolling stats (~5 s at 60 Hz)
const tickWork: number[] = []; // recent per-tick work durations, ms
let achievedTps = 60; // most recently measured ticks/second
let rateWindowStart = performance.now();
let rateWindowTicks = 0;
let lastSlowLog = 0; // throttle the "running behind" warnings

function tickHealth(): TickHealth {
  if (tickWork.length === 0) return { tps: achievedTps, busyAvg: 0, busyMax: 0, slowPct: 0 };
  const busyAvg = tickWork.reduce((a, b) => a + b, 0) / tickWork.length;
  const busyMax = Math.max(...tickWork);
  const slow = tickWork.filter((d) => d > TICK_MS).length;
  return {
    tps: Math.round(achievedTps * 10) / 10,
    busyAvg: Math.round(busyAvg * 100) / 100,
    busyMax: Math.round(busyMax * 100) / 100,
    slowPct: Math.round((slow / tickWork.length) * 1000) / 10,
  };
}

const wss = new WebSocketServer({ server, path: '/ws' });

// Authenticated sessions keyed by socket (auto-cleaned when the socket is GC'd).
const wsSessions = new WeakMap<WebSocket, AuthSession>();

wss.on('connection', (ws: WebSocket, req) => {
  const session = parseSession(req.headers.cookie as string | undefined);
  if (session) wsSessions.set(ws, session);
  lobby.add(ws);

  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed input
    }
    switch (msg?.type) {
      case 'join':
        if (typeof msg.nickname === 'string' && typeof msg.pid === 'string') {
          // Authenticated users get their stable Google pid regardless of what the client sends.
          const pid = wsSessions.get(ws)?.pid ?? msg.pid;
          lobby.join(ws, msg.nickname, pid, typeof msg.color === 'string' ? msg.color : undefined);
        }
        break;
      case 'claim':
        lobby.claim(ws, msg.side === 'left' || msg.side === 'right' ? msg.side : undefined);
        break;
      case 'paddle':
        if (typeof msg.y === 'number' && Number.isFinite(msg.y)) {
          const x = typeof msg.x === 'number' && Number.isFinite(msg.x) ? msg.x : undefined;
          lobby.setPaddle(ws, msg.y, x);
        }
        break;
      case 'chat':
        if (typeof msg.text === 'string') lobby.chat(ws, msg.text);
        break;
      case 'tip':
        if (typeof msg.to === 'string' && typeof msg.amount === 'number' && Number.isFinite(msg.amount)) {
          lobby.tip(ws, msg.to, msg.amount);
        }
        break;
      case 'placeBounty':
        if (typeof msg.to === 'string' && typeof msg.amount === 'number' && Number.isFinite(msg.amount)) {
          lobby.placeBounty(ws, msg.to, msg.amount);
        }
        break;
      case 'reaction':
        if (typeof msg.emoji === 'string') lobby.reaction(ws, msg.emoji);
        break;
      case 'mode':
        lobby.setMode(ws, {
          closing: typeof msg.closing === 'boolean' ? msg.closing : undefined,
          gravity: typeof msg.gravity === 'boolean' ? msg.gravity : undefined,
          turbo: typeof msg.turbo === 'boolean' ? msg.turbo : undefined,
          streamer: typeof msg.streamer === 'boolean' ? msg.streamer : undefined,
          diamond: typeof msg.diamond === 'boolean' ? msg.diamond : undefined,
          pinata: typeof msg.pinata === 'boolean' ? msg.pinata : undefined,
          layered: typeof msg.layered === 'boolean' ? msg.layered : undefined,
          arena: typeof msg.arena === 'boolean' ? msg.arena : undefined,
          viewMode: typeof msg.viewMode === 'string' ? msg.viewMode : undefined,
          breakout: typeof msg.breakout === 'boolean' ? msg.breakout : undefined,
          fog: typeof msg.fog === 'boolean' ? msg.fog : undefined,
          portal: typeof msg.portal === 'boolean' ? msg.portal : undefined,
        });
        break;
      case 'fatality':
        if (typeof msg.move === 'string') lobby.fatality(ws, msg.move);
        break;
      case 'setFatalities':
        if (typeof msg.enabled === 'boolean') lobby.setFatalities(ws, msg.enabled);
        break;
      case 'forfeit':
        lobby.forfeit(ws);
        break;
      case 'spawnPowerup':
        lobby.spawnPowerup(ws, typeof msg.kind === 'string' ? msg.kind : undefined);
        break;
      case 'addBlock':
        lobby.addBlock(ws);
        break;
      case 'capture':
        if (typeof msg.on === 'boolean') lobby.setCapture(ws, msg.on);
        break;
      case 'kingExit':
        lobby.kingExit(ws);
        break;
      case 'queueJoin':
        lobby.queueJoin(ws);
        break;
      case 'queueLeave':
        lobby.queueLeave(ws);
        break;
      case 'ready':
        lobby.setReady(ws);
        break;
      case 'addBot':
        if ((BOT_LEVELS as readonly string[]).includes(msg.level)) {
          lobby.addBot(ws, msg.level as BotLevel);
        }
        break;
      case 'removeBot':
        lobby.removeBot(ws);
        break;
      case 'ping':
        lobby.ping(ws);
        break;
      case 'rtt':
        // Latency probe: bounce the client's own timestamp straight back, untouched, so
        // it can measure round-trip time. Pure echo — no lobby/authoritative state involved.
        if (typeof msg.t === 'number' && Number.isFinite(msg.t) && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'rtt', t: msg.t, tick: tickHealth() }));
        }
        break;
      case 'setWinScore':
        if (typeof msg.score === 'number') lobby.setWinScore(ws, msg.score);
        break;
      case 'tournamentCreate':
        if (typeof msg.size === 'number') lobby.tournamentCreate(ws, msg.size);
        break;
      case 'tournamentJoin':
        lobby.tournamentJoin(ws);
        break;
      case 'tournamentLeave':
        lobby.tournamentLeave(ws);
        break;
      case 'tournamentCancel':
        lobby.tournamentCancel(ws);
        break;
      case 'fire':
        if (typeof msg.angle === 'number' && Number.isFinite(msg.angle)) lobby.fire(ws, msg.angle);
        break;
      case 'doomJoin':
        lobby.doomJoin(ws);
        break;
      case 'doomLeave':
        lobby.doomLeave(ws);
        break;
      case 'doomRelay':
        lobby.doomRelay(ws, msg.data);
        break;
      case 'doomScore':
        if (typeof msg.round === 'number' && typeof msg.coop === 'boolean') {
          lobby.doomScore(ws, msg.round, msg.coop, typeof msg.name === 'string' ? msg.name : undefined);
        }
        break;
      case 'shopBuy':
        if (typeof msg.item === 'string') lobby.shopBuy(ws, msg.item);
        break;
      case 'shopEquip':
        if ((msg.slot === 'hat' || msg.slot === 'skin' || msg.slot === 'trail' || msg.slot === 'title' || msg.slot === 'song' || msg.slot === 'car') && (msg.item === null || typeof msg.item === 'string')) {
          lobby.shopEquip(ws, msg.slot, msg.item);
        }
        break;
      case 'bet':
        if ((msg.side === 'left' || msg.side === 'right') && typeof msg.amount === 'number') {
          lobby.bet(ws, msg.side, msg.amount);
        }
        break;
      case 'doomReward':
        lobby.doomReward(ws);
        break;
      case 'questClaim':
        if (typeof msg.quest === 'string') lobby.questClaim(ws, msg.quest);
        break;
      case 'ntJoin':
        lobby.ntJoin(ws);
        break;
      case 'ntLeave':
        lobby.ntLeave(ws);
        break;
      case 'ntStart':
        lobby.ntStart(ws);
        break;
      case 'ntEnd':
        if (typeof msg.team === 'number') lobby.ntEnd(ws, msg.team);
        break;
      case 'ntRelay':
        if (msg.data !== undefined) lobby.ntRelay(ws, msg.data);
        break;
      case 'tdJoin':
        lobby.tdJoin(ws);
        break;
      case 'tdLeave':
        lobby.tdLeave(ws);
        break;
      case 'tdStart':
        lobby.tdStart(ws);
        break;
      case 'tdTarget':
        lobby.tdTarget(ws, typeof msg.id === 'number' && Number.isFinite(msg.id) ? msg.id : null);
        break;
      case 'tdKill':
        if (typeof msg.id === 'number' && Number.isFinite(msg.id)) lobby.tdKill(ws, msg.id);
        break;
      case 'campaignScore':
        if (typeof msg.score === 'number' && typeof msg.stage === 'number' && typeof msg.won === 'boolean') {
          lobby.campaignScore(ws, msg.score, msg.stage, msg.won);
        }
        break;
      case 'worldEnter':
        lobby.worldEnter(ws);
        break;
      case 'worldLeave':
        lobby.worldLeave(ws);
        break;
      case 'worldMove':
        if (typeof msg.x === 'number' && typeof msg.y === 'number') {
          lobby.worldMove(ws, msg.x, msg.y, typeof msg.a === 'number' ? msg.a : undefined, typeof msg.car === 'string' ? msg.car : null);
        }
        break;
      case 'dailySpin':
        lobby.dailySpin(ws);
        break;
      case 'stockInvest':
        if (typeof msg.coin === 'string' && typeof msg.amount === 'number') {
          lobby.stockInvest(ws, msg.coin, msg.amount, msg.side === 'short' ? 'short' : 'long');
        }
        break;
      case 'stockCashOut':
        if (typeof msg.coin === 'string') lobby.stockCashOut(ws, msg.coin, msg.side === 'short' ? 'short' : 'long');
        break;
      case 'getLoan':
        if (typeof msg.amount === 'number') lobby.getLoanFor(ws, msg.amount);
        break;
      case 'repayLoan':
        lobby.repayLoanFor(ws);
        break;
      case 'roulette':
        if (Array.isArray(msg.bets)) lobby.roulette(ws, msg.bets);
        break;
      case 'bjBet':
        if (typeof msg.amount === 'number') lobby.blackjackBet(ws, msg.amount);
        break;
      case 'bjAction':
        if (typeof msg.action === 'string') lobby.blackjackAction(ws, msg.action as import('../shared/types').BjAction);
        break;
      case 'crapsRoll':
        if (typeof msg.pass === 'number' && typeof msg.dontPass === 'number') lobby.crapsRoll(ws, msg.pass, msg.dontPass);
        break;
      case 'crashBet':
        if (typeof msg.amount === 'number') lobby.crashBetAction(ws, msg.amount, msg.autoCashout);
        break;
      case 'crashCancelBet':
        lobby.crashCancelBet(ws);
        break;
      case 'crashCashout':
        lobby.crashCashout(ws);
        break;
      case 'slotsSpin':
        if (typeof msg.amount === 'number') lobby.slotsSpin(ws, msg.amount);
        break;
      case 'balanceSheetReq':
        if (typeof msg.rank === 'number') lobby.sendBalanceSheet(ws, msg.rank);
        break;
      case 'eloProfileReq':
        if (typeof msg.rank === 'number') lobby.sendEloProfile(ws, msg.rank);
        break;
      case 'lootBoxOpen':
        lobby.openLootBox(ws);
        break;
      case 'marketList':
        if (typeof msg.instanceId === 'number' && typeof msg.ask === 'number') {
          lobby.marketList(ws, msg.instanceId, msg.ask);
        }
        break;
      case 'marketCancel':
        if (typeof msg.listingId === 'number') lobby.marketCancel(ws, msg.listingId);
        break;
      case 'marketBuy':
        if (typeof msg.item === 'string') lobby.marketBuy(ws, msg.item);
        break;
      case 'marketReq':
        lobby.sendMarket(ws);
        break;
      case 'loanBookReq':
        lobby.sendLoanBook(ws);
        break;
      case 'netizenInfoReq':
        if (typeof msg.netizenId === 'string') lobby.sendNetizenInfo(ws, msg.netizenId);
        break;
      case 'netizenChallenge':
        if (typeof msg.netizenId === 'string' && typeof msg.wager === 'number') lobby.netizenChallenge(ws, msg.netizenId, msg.wager);
        break;
      case 'newsReq':
        lobby.sendNews(ws);
        break;
      case 'migrate': {
        // Only honour the request if the socket is authenticated — prevents spoofing.
        const authSession = wsSessions.get(ws);
        if (authSession && typeof msg.oldPid === 'string' && msg.oldPid !== authSession.pid) {
          migratePlayer(msg.oldPid, authSession.pid)
            .then(() => lobby.sendWallet(ws))
            .catch((e) => console.error('account migration failed:', e));
        }
        break;
      }
    }
  });

  ws.on('close', () => lobby.remove(ws));
  ws.on('error', () => lobby.remove(ws));
});

// Single authoritative loop: advance physics, reconcile spots, broadcast to everyone.
const dt = TICK_MS / 1000;
const loop = setInterval(() => {
  const t0 = performance.now();
  lobby.tick(dt);
  lobby.sync();
  lobby.broadcast();
  const work = performance.now() - t0;

  // Sample this tick's work time and, once a second, the achieved tick rate. A rate that
  // sags below ~60 Hz means the loop can't keep up (work overrun and/or event-loop lag).
  tickWork.push(work);
  if (tickWork.length > TICK_WINDOW) tickWork.shift();
  rateWindowTicks++;
  const elapsed = t0 - rateWindowStart;
  if (elapsed >= 1000) {
    achievedTps = (rateWindowTicks * 1000) / elapsed;
    rateWindowStart = t0;
    rateWindowTicks = 0;
    const h = tickHealth();
    if ((h.tps < 55 || h.slowPct > 10) && t0 - lastSlowLog > 10000) {
      lastSlowLog = t0;
      console.warn(
        `[tick] running behind — ${h.tps} tps, work avg ${h.busyAvg}ms / max ${h.busyMax}ms, ` +
          `${h.slowPct}% over the ${TICK_MS.toFixed(1)}ms budget`,
      );
    }
  }
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`tsong server listening on http://localhost:${PORT} (ws at /ws)`);
});

// Graceful shutdown: a deploy (systemctl restart) or Ctrl-C sends SIGTERM/SIGINT. Snapshot
// the live match to disk before exiting so the next process can resume it. The write is
// synchronous and fast; we then stop the loop and close the server, with a short hard cap
// in case sockets linger.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — saving state and shutting down`);
  // Refund open wagers before exit: bets aren't part of the snapshot, so otherwise the coins
  // escrowed at bet time would vanish across the restart. Cap the wait so a slow/down DB can't
  // stall the deploy — the bets Map is cleared synchronously, so nothing double-settles even if
  // a refund write times out.
  await Promise.race([
    lobby.refundOpenBets().catch((e) => console.error('bet refund on shutdown failed:', e)),
    new Promise((resolve) => setTimeout(resolve, 800).unref()),
  ]);
  saveSnapshot(game.serialize(), lobby.serialize());
  clearInterval(loop);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
