# 🏓 tsong

A multiplayer online Pong game. Two players, one ongoing match, everyone else watches
live — and any observer can claim a paddle when a spot opens up. The match runs
**server-authoritative**, so every player and spectator sees an identical game.

## Features

- Real-time two-player Pong over WebSockets
- Server owns the physics, ball, and score (no client can cheat)
- Observers watch live and can **Join** an open paddle spot
- Paddle control by **keyboard** (↑/↓ or W/S), **mouse**, or **touch** (mobile)
- First to 3 wins, then both spots reopen for a fresh match
- Nicknames shown on the scoreboard and watcher list (remembered in a cookie)
- Custom paddle colors chosen from a palette
- Win–loss **leaderboard** persisted in Postgres
- **Chat** with timestamps and date separators (shown in New York time)
- **Ping** button to notify others when you're looking for players
- **Mobile-friendly** layout with tabbed Play/Chat/Leaderboard sections

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

## Contributing

Want to hack on tsong? Welcome! 🏓

1. **Ask to be added as a contributor.** [Open an issue](https://github.com/kirkland/tsong/issues/new)
   requesting collaborator access (include your GitHub username). Once a maintainer adds
   you, you can push branches and open pull requests directly.
2. **Clone with your personal GitHub account.** If your work laptop is set up with a
   different (work) GitHub account, configure an SSH host alias so Git uses your
   personal key for this repo. Add this to `~/.ssh/config`:

   ```ssh-config
   Host github.com.personal
     HostName github.com
     IdentityFile ~/.ssh/id_rsa_personal
   ```

   Then clone (and set your remote) using the alias as the host:

   ```bash
   git clone git@github.com.personal:kirkland/tsong.git
   ```

   If you already cloned with the regular host, repoint the remote:

   ```bash
   git remote set-url origin git@github.com.personal:kirkland/tsong.git
   ```

3. **Make it more fun.** See the [code of conduct](./CODE_OF_CONDUCT.md) — every change
   should leave the game more fun than it was.

## Contributors

Built by:

- [Robert Kaufman](https://github.com/robkaufmanls) (@robkaufmanls)
- [Noam Molloy](https://github.com/noammolloy) (@noammolloy)
- [Jay Srinivasan](https://github.com/jayyy-s) (@jayyy-s)
- [Matt Beauvais](https://github.com/mattb102) (@mattb102)
- [Fritz-Gerald Duverglas](https://github.com/fritztheritz) (@fritztheritz)
- [Josiel](https://github.com/japonte21) (@japonte21)
- [JSav](https://github.com/julianwsavini) (@julianwsavini)
- [Clarence Ong](https://github.com/clarencegabrielong) (@clarencegabrielong)

## Code of conduct

[Have fun!](./CODE_OF_CONDUCT.md) 🏓
