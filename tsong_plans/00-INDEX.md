# tsong — Feature Plans Index

Eleven features from the "make the economy better" batch, categorized into self-contained plan files. Each plan is written to be executed independently by an implementer (or a less-capable LLM) with no extra context. Read this index first for shared modules and dependency order.

## The eleven features

| # | Plan file | One-liner |
|---|-----------|-----------|
| 1 | `01-market-news-engine.md` | Hourly market-hours news tab; each headline secretly pre-commits a real price move that lands 7-30 min later. |
| 2 | `02-netizen-chat-voice.md` | Netizens post in chat about their real trades during market hours + react to news on a timer. |
| 3 | `03-world-netizen-avatars.md` | Netizen avatars wander the World cycling dialogue about stocks/leaderboards/features. |
| 4 | `04-inactivity-tax.md` | Progressive 2-7% (min 100) tax at the 5pm collection for players who didn't play Pong during market hours. |
| 5 | `05-elo-leaderboard-drilldown.md` | Click an Elo-board name → W/L, head-to-head (most beaten / most lost-to), last played. |
| 6 | `06-lootbox-rebalance.md` | Whale-gamble loot box: 2,500/box, ~1% cosmetic, ~0.3% exclusive, can pull nothing — **plus a few new common cosmetics + new exclusives**. |
| 7 | `07-exclusive-tags-fix.md` | Bug fix: exclusive hats/skins/titles render nothing because they lack renderer entries (same class as the `x-eclipse` trail bug). |
| 8 | `08-mobile-core-fixes.md` | Fix the empty mobile Leaderboard tab, the ad covering content, nav cramping, and casino/shop panel usability. |
| 9 | `09-blackjack-casino.md` | New Blackjack game in the Casino, modeled on Roulette. |
| 10 | `10-netizen-challenge.md` | Walk up to a netizen in the World and challenge it to a wager duel; AI difficulty scales to the wager (capped at hardest Davis), once/day, win ≤20% of its net worth. |
| 11 | `11-wealth-scaled-min-bets.md` | Minimum bet scales up with wealth across Roulette, Blackjack, PvP bets, and netizen challenges. |

## Shared modules (build once, reuse)

These are referenced by multiple plans. Whoever implements the **first** plan that needs one builds it; later plans import it.

- **Market-hours time utils** (`server/lobby.ts`, near `nextFivePmEtMs` at `lobby.ts:126`): `isMarketHours(nowMs)` (M-F 9am–5pm America/New_York) and `nextTopOfHourMs(nowMs)`. **Owner: Plan 01.** Used by 01, 02, 04.
- **`NewsEvent`** interface + the live news feed (`shared/types.ts`): a published headline plus its hidden `(coin, direction, magnitude, fireAt)`. **Owner: Plan 01.** Consumed by 02 (reactions) and optionally 03 (avatar chatter).
- **Netizen identity**: `NETIZEN_NAMES` exists (`lobby.ts:662`) but has **no colors**. Add a parallel `NETIZEN_COLORS` array (or a `{name,color}` list). **Owner: Plan 02.** Reused by 03.
- **`NETIZEN_DIALOGUE` corpus** (`shared/types.ts`): persona lines + templated lines about stocks/leaderboards/features. **Owner: Plan 02.** Reused by 03.
- **`players.last_played BIGINT`** column + stamping it in `recordResult` (`db.ts:505`). **Owners: Plans 04 and 05 both need it.** Add the column + the `recordResult` stamp **once**; whichever plan ships first does it, the other references it.
- **`minBet(wealth)`** helper + `MIN_BET_TIERS` (`shared/types.ts`). **Owner: Plan 11.** Used by 09 (blackjack), 10 (netizen challenge), and the existing roulette/PvP-bet handlers.
- **`netizen_challenges`** table + ET daily-reset check. **Owner: Plan 10.**

## Global design tenet (applies to every wealth feature)

**The economy should de-incentivize HOARDING of wealth, not penalize players who have little.** Any cost that scales with wealth (the inactivity tax in Plan 04, the minimum bets in Plan 11, the loot-box sink) must fall hardest on the rich and **exempt or barely touch low-balance players**. When in doubt: exempt the bottom, steepen the top. Positive nudges (rewards for playing) over punishing the poor.

## Dependency / suggested build order

```
07 exclusive-tags-fix      ← pure bug fix, no deps, ship first (cheap win)
08 mobile-core-fixes       ← independent UI fixes, ship anytime
11 wealth-scaled-min-bets  ← builds minBet() helper; light, independent (do before 09/10 so they import it)
06 lootbox-rebalance       ← constant/odds tuning + new items; pairs with 07 (new exclusives need renderers)
09 blackjack-casino        ← mirrors roulette; imports minBet() from 11
01 market-news-engine      ← builds market-hours utils + NewsEvent (foundation for 02)
02 netizen-chat-voice      ← needs 01 (NewsEvent) + builds netizen colors/dialogue corpus
03 world-netizen-avatars   ← reuses 02's colors + dialogue corpus; hosts 10's interaction
10 netizen-challenge       ← needs netizen avatars in world (03) + minBet (11) + bot/Davis difficulty
04 inactivity-tax          ← needs market-hours util (01) + last_played column
05 elo-leaderboard-drilldown ← needs last_played column + new head-to-head table
```

Recommended sequence: **07 → 08 → 11 → 06 → 09 → 01 → 02 → 03 → 10 → 04 → 05**. The first batch are independent quick wins; the rest form small dependency chains (news→netizen→world→challenge, and last_played→tax/leaderboard).

## Global conventions every plan must honor

- **Coin conservation** (from the economy overhaul): every coin a player gains from a House-funded source must be debited from the House via `housePay`, and every coin taken from a player must be credited to the House via `houseCredit`/`houseAdjust(+)`. New sinks (tax, loot, blackjack) credit the House; new payouts (blackjack wins) draw from it. Run `npm run conservation` (script `scripts/conservation-check.ts`) against a scratch DB after any economy change.
- **Protocol additions** go in the `ClientMsg`/`ServerMsg` unions in `shared/types.ts`; the server dispatch switch is `server/index.ts` (~line 130-345), the client dispatch is `client/main.ts` (~line 630-660). `tsc --noEmit` (`npm run typecheck`) enforces that both sides handle every new message — run it after each change.
- **DB migrations** use the idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS` pattern in `initDb` (`server/db.ts:25-327`); reuse the `doom_meta` KV table (`k TEXT PK, v TEXT`) for scalars/JSON.
- **Run locally**: `npm run dev` → `http://localhost:5173` (server 3001 + Vite 5173). A `DATABASE_URL` is required for economy behavior.
- **Read-only repo note**: local `main` tracks origin; pull before implementing. Do not commit/push unless explicitly told.
