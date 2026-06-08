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
- Nicknames shown on the scoreboard and watcher list (remembered in a cookie)
- Custom paddle colors chosen from a palette
- Win–loss **leaderboard** persisted in Postgres

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

## Leaderboard / database

The win–loss leaderboard is stored in Postgres via the `DATABASE_URL` env var. The
`players` table is created automatically on startup.

- **No `DATABASE_URL`** (default for local dev): the leaderboard is simply disabled
  and empty — everything else works normally.
- **With a DB:** set `DATABASE_URL`, e.g. run a local Postgres and
  `DATABASE_URL=postgres://user:pass@localhost:5432/tsong npm run dev`.
- **On Railway:** add a **PostgreSQL** database to the project, then reference it from
  the app service with a variable `DATABASE_URL = ${{Postgres.DATABASE_URL}}`. The app
  uses the internal connection (no SSL); the public proxy host enables SSL automatically.

## Contributors

Built by:

- [Robert Kaufman](https://github.com/robkaufmanls) (@robkaufmanls)
- [Noam Molloy](https://github.com/noammolloy) (@noammolloy)
- [Jay Srinivasan](https://github.com/jayyy-s) (@jayyy-s)
- [Matt Beauvais](https://github.com/mattb102) (@mattb102)
- [Fritz-Gerald Duverglas](https://github.com/fritztheritz) (@fritztheritz)
- [Josiel](https://github.com/japonte21) (@japonte21)

## Code of conduct

[Have fun!](./CODE_OF_CONDUCT.md) 🏓
