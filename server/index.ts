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
          lobby.join(ws, msg.nickname, msg.pid);
        }
        break;
      case 'claim':
        lobby.claim(ws);
        break;
      case 'paddle':
        if (typeof msg.y === 'number' && Number.isFinite(msg.y)) lobby.setPaddle(ws, msg.y);
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
