// HTTP + WebSocket entry point. In production it also serves the built client from
// client/dist so the page and the WebSocket share a single origin.

import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import sirv from 'sirv';
import { ClientMsg, TICK_MS } from '../shared/types';
import { Game } from './game';
import { Lobby } from './lobby';
import { initDb } from './db';
import { getChangelog } from './changelog';

const PORT = Number(process.env.PORT ?? 3000);

const game = new Game();
const lobby = new Lobby(game);

// Bring up the leaderboard DB and prime the cache. The server starts serving
// immediately; standings populate once the DB is ready (no-op without DATABASE_URL).
initDb()
  .then(() => lobby.refreshLeaderboard())
  .catch((e) => console.error('DB init failed:', e));

// Static client (only exists after `npm run build`; harmless in dev where Vite serves it).
const serveStatic = sirv(path.resolve(process.cwd(), 'client/dist'), {
  single: true,
  dev: false,
});

const server = http.createServer((req, res) => {
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
  serveStatic(req, res, () => {
    res.statusCode = 404;
    res.end('Not found');
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws: WebSocket) => {
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
          lobby.join(ws, msg.nickname, msg.pid, typeof msg.color === 'string' ? msg.color : undefined);
        }
        break;
      case 'claim':
        lobby.claim(ws);
        break;
      case 'paddle':
        if (typeof msg.y === 'number' && Number.isFinite(msg.y)) lobby.setPaddle(ws, msg.y);
        break;
      case 'chat':
        if (typeof msg.text === 'string') lobby.chat(ws, msg.text);
        break;
      case 'reaction':
        if (typeof msg.emoji === 'string') lobby.reaction(ws, msg.emoji);
        break;
      case 'mode':
        if (typeof msg.closing === 'boolean') lobby.setMode(ws, msg.closing);
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
        lobby.spawnPowerup(ws);
        break;
      case 'capture':
        if (typeof msg.on === 'boolean') lobby.setCapture(ws, msg.on);
        break;
    }
  });

  ws.on('close', () => lobby.remove(ws));
  ws.on('error', () => lobby.remove(ws));
});

// Single authoritative loop: advance physics, reconcile spots, broadcast to everyone.
const dt = TICK_MS / 1000;
setInterval(() => {
  game.tick(dt);
  lobby.sync();
  lobby.broadcast();
}, TICK_MS);

server.listen(PORT, () => {
  console.log(`tsong server listening on http://localhost:${PORT} (ws at /ws)`);
});
