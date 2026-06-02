# 🏓 tsong

A multiplayer online Pong game. Two players, one ongoing match, everyone else watches
live — and any observer can claim a paddle when a spot opens up. The match runs
**server-authoritative**, so every player and spectator sees an identical game.

## Features

- Real-time two-player Pong over WebSockets
- Server owns the physics, ball, and score (no client can cheat)
- Observers watch live and can **Join** an open paddle spot
- Paddle control by **keyboard** (↑/↓ or W/S) or **mouse**
- First to 3 wins, then both spots reopen for a fresh match
- Nicknames shown on the scoreboard and watcher list

## Tech

TypeScript everywhere: Node + [`ws`](https://github.com/websockets/ws) on the server,
HTML5 Canvas + [Vite](https://vitejs.dev/) on the client, with shared message types.

## Getting started

```bash
npm install
npm run dev
```

Then open **http://localhost:5173**. Open it in **two windows** to play (each enters a
nickname → clicks **Join game**); any extra windows watch as observers.

> Tip: to test solo, use one normal window and one incognito window side by side.

## Scripts

| Script            | What it does                                              |
| ----------------- | -------------------------------------------------------- |
| `npm run dev`     | Server (port 3001) + Vite dev server (5173) with WS proxy |
| `npm run build`   | Build the client into `client/dist`                       |
| `npm start`       | Run the server, serving the built client (`PORT` from env)|
| `npm run typecheck` | Type-check the whole project                            |

## TODO

- [ ] **Deploy to a public website** so anyone can play over the internet (host the
      Node server + built client, e.g. on Render / Fly / Railway)
- [ ] Resume a match instead of abandoning it when a player disconnects mid-game
- [ ] Reconnect handling for brief network drops
- [ ] Support multiple concurrent games / rooms instead of a single shared match
- [ ] Sound effects and a bit more visual polish
- [ ] Mobile / touch controls

## Code of conduct

[Have fun!](./CODE_OF_CONDUCT.md) 🏓
