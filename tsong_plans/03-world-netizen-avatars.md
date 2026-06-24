# Plan 03 — World Netizen Avatars

## Context

The new **World** (`client/world.ts`, a top-down 2D town with walking/driving avatars) is empty unless real players are in it. This populates it with the 10 **netizen avatars** wandering around, each cycling speech-bubble dialogue about stocks, the leaderboard, and features — so the town always feels alive and reinforces the netizens' personalities established in chat (Plan 02).

Reuses: **Plan 02's** `NETIZEN_COLORS` and `NETIZEN_DIALOGUE` corpus. No hard dependency on Plan 01/02 shipping first, but sharing the corpus avoids duplicate content.

## How the World works (anchors)

- `WorldAvatar` = `{ id, name, color, x, y, a?, car? }` (`shared/types.ts:390-398`). The client holds everyone else in `others` (`world.ts:859-864`), drawn each frame in `render()` (`world.ts:573-582`) via `drawAvatar()` (`766-784`) / `drawCar()` (`786-820`). Name labels use `label(text, cx, baselineY, bg, fg)` (`world.ts:822-830`) — a rounded-rect bubble, **directly reusable for dialogue**.
- Server builds the avatar list in `worldAvatars()` (`lobby.ts:786-795`) and fans it out in `broadcastWorld()` (`799-806`) at ~15 Hz via `WorldMsg {type:'world', avatars:[]}` (`types.ts:399`). Map is 3200×2200 with known buildings (Arena/Casino/Bank, `types.ts:381-385`).
- Netizens (`NETIZEN_NAMES` `lobby.ts:662`, pid `"netizen:i"`) currently have **no position** and never enter the world.

## Approach (server-authoritative positions, client renders dialogue)

Spawn netizens server-side so all in-world players see them consistently, and drive simple wandering on the server tick. Render dialogue client-side from data the client already has (live stock prices via `StockMsg`, leaderboard via `LeaderboardMsg`) so headlines/standings are current without new protocol.

### Server

1. **Netizen world state** on `Lobby`: `private netizenPos = new Map<string,{x:number;y:number;hx:number;hy:number;until:number}>()` (position + heading vector + when to pick a new heading). Seed each at a scattered spawn near roads/plaza on boot (`seedNetizens`/`loadStockPrices`). Keep them on-foot (no cars) for simplicity (`car: null`).
2. **Wander** in `broadcastWorld()` (or a dedicated 15 Hz step): for each netizen, every `until` ms pick a new random heading; integrate `x += hx*speed*dt`, `y += hy*speed*dt`; clamp to map bounds (reuse the clamp logic in `server/world.ts:53-61`). Keep speed slow (stroll). Avoid building interiors (simple: clamp to road/plaza region or just bounce off bounds).
3. **Include netizens in the avatar list**: in `worldAvatars()` (`lobby.ts:786-795`), append a `WorldAvatar` per netizen `{ id:"netizen:i", name, color: netizenColor(pid), x, y }`. Add an optional flag so the client can tag them: extend `WorldAvatar` with `bot?: boolean` (defaults undefined for humans). **This is the only protocol change.**

### Client

In `world.ts`:
1. Avatars with `bot` render the same `drawAvatar()` but with a subtle visual tag (e.g. a tiny 🤖 or a dimmer outline) so they're distinguishable from humans — optional.
2. **Dialogue bubbles**: maintain a per-bot `{ line:string; nextAt:number }` map in the world module. Every ~4–6s pick the bot's next line from a locally-built pool and reset `nextAt`. In `render()`, for each on-screen bot draw its current line via `label(line, sx(x), sy(y) - 50, '#1b2542cc', '#ffeb3b')` (one bubble above the name label).
3. **Build the dialogue pool client-side** from `NETIZEN_DIALOGUE` (imported from `shared/types.ts`, Plan 02) plus live data the client holds:
   - Stock lines: read the latest `StockMsg` prices the client already caches; e.g. `"{ticker} pumping again 📈"` for the biggest gainer, `"who keeps dumping {ticker}"` for the biggest loser.
   - Leaderboard lines: read cached `LeaderboardMsg`/net-worth board; e.g. `"{topName} is loaded 💰"`, `"grinding elo to catch {topName}"`.
   - Feature lines: static set about features ("check the black market for exclusives", "news drops every hour", "anyone up for a tourney").
   Pick weighted-random among the three categories so bubbles vary.

(Alternative if you prefer zero client logic: have the server pick each bot's line and send it in the `WorldAvatar` as `say?: string`. Costs a little bandwidth at 15 Hz; the client-side approach avoids that. Recommend client-side.)

## Edge cases / tests

- World with no human players: netizens still wander and talk (server spawns them regardless). The player-count label (`world.ts:861`) should probably count only humans — exclude `bot` avatars from the count, or relabel ("10 netizens around").
- Performance: 10 extra avatars + bubbles is trivial; `onScreen` culling (`world.ts:573`) already skips off-camera ones.
- Don't let bots block doors/building prompts for humans (they're cosmetic; ensure `updateNearBuilding` only considers the local player, which it already does).
- Bubbles must not leak real future price moves from Plan 01 (keep world lines generic/observational, not the hidden news magnitude).

## Verification

- `npm run dev`; enter the World with no other humans. Confirm ~10 named, colored netizens stroll around with speech bubbles cycling every few seconds, mentioning the actual current top stock/leaderboard names.
- Confirm humans and bots are visually distinguishable and the "players here" count is sensible.
- `npm run typecheck` (the `bot?` field addition).

## Files to touch

- `shared/types.ts` — add `bot?: boolean` (and optional `say?: string` if going server-driven) to `WorldAvatar` (`390-398`); reuse exported `NETIZEN_DIALOGUE`.
- `server/lobby.ts` — `netizenPos` seed + wander in `broadcastWorld` (`799`), append netizens in `worldAvatars` (`786`), reuse `netizenColor` (Plan 02).
- `client/world.ts` — bot tagging in the render loop (`573-582`), per-bot dialogue state + bubble draw via `label()` (`822`), client-side pool from `NETIZEN_DIALOGUE` + cached `StockMsg`/`LeaderboardMsg`, human-only count.
