# Plan 04 — Inactivity Tax (play-to-avoid)

## Context

To push people to actually play Pong (the only true coin faucet) **and to de-incentivize hoarding wealth**, levy a **daily inactivity tax** at the 5pm ET collection on any player who did **not** play a Pong match during that day's **market hours (M-F 9am–5pm ET)**. The tax is **progressive (2–7%)**, weighted onto the wealthy. A player who plays even one match during market hours pays nothing. Tax proceeds go to the **House** (coin-conserving). Weekends: no market hours → skip the tax on Sat/Sun.

**Design tenet (overrides the original "min 100 either way"):** the goal is to discourage *idle hoarding*, **not to penalize players who have little**. So the tax has a **wealth exemption floor** — players below it pay **nothing** — and the 100-coin minimum applies **only above** that floor. The burden falls on idle whales, not minnows.

Decision: **progressive 2–7%, exempt low balances, 100-coin minimum only above the exemption, to the House.**

Depends on: market-hours util from **Plan 01** (`isMarketHours`); the **`last_played`** column (shared with Plan 05 — add once).

## Data model

- **`players.last_played BIGINT NOT NULL DEFAULT 0`** — epoch ms of the player's most recent completed Pong match. Add via `ALTER TABLE players ADD COLUMN IF NOT EXISTS last_played BIGINT NOT NULL DEFAULT 0` in `initDb` (`db.ts:25-327`). (Plan 05 also needs this column — coordinate so it's added once.)
- Stamp it in `recordResult()` (`db.ts:505-551`): set `last_played = $now` for **all** winners and losers (it's a Pong duel completion). Pass `Date.now()` in. This is the signal the tax checks.

## Tax logic (server)

The 5pm collection already iterates the economy in `runDailyCollection()` (`lobby.ts:1818-1855`) → `collectDefaultedLoans()` (`db.ts`). Add a parallel **`applyInactivityTax(dayStartMs)`** in `db.ts`, called from `runDailyCollection` right after/around the loan collection.

```ts
// Tax everyone whose last_played is before today's market open (i.e. didn't play during market hours today).
// Returns total taxed (→ House). Progressive brackets on current coin balance; min 100 floor.
export async function applyInactivityTax(marketOpenMs: number): Promise<number>
```

Algorithm (single SQL pass, or fetch+update loop):
1. Compute **today's market-open timestamp** = today's 9:00am ET in epoch ms (use the same `Intl` ET approach as `nextFivePmEtMs` `lobby.ts:126`, targeting 09:00). A player "played during market hours" iff `last_played >= marketOpenMs`.
2. For each `players` row that is **above the exemption floor** (`coins >= TAX_EXEMPT_BELOW`) **and** `last_played < marketOpenMs` **and** not a netizen (`is_netizen = FALSE` — don't tax bots) **and** not currently in a Pong match (optional; the 5pm boundary makes this rare):
   - `rate` from progressive brackets on `coins` (see table).
   - `tax = max(100, floor(coins * rate))`, capped so the player **never drops below `TAX_EXEMPT_BELOW`** (i.e. `tax = min(tax, coins - TAX_EXEMPT_BELOW)`) — the tax shaves hoarded surplus, it can't push anyone into the exempt-poor zone.
   - `coins -= tax`; accumulate `tax` into the House via `houseAdjust(+tax)` (or sum and do one House credit at the end).
3. Announce a summary (e.g. `"📋 Tax day: N idle whales fed the House"`)—do NOT publicly shame individual balances. Refresh wallets for any online taxed players (mirror how `runDailyCollection` refreshes online defaulters, `lobby.ts:1818-1855`).

### Exemption + progressive bracket table (tunable)

**Exemption floor `TAX_EXEMPT_BELOW` (recommend 10,000 coins):** anyone at or below this pays **zero** inactivity tax, period. This is the "don't penalize the poor" guarantee. Tune to whatever counts as "comfortably not a hoarder."

Above the floor, use **flat-rate-by-tier** on the whole balance, steepening toward the top so hoarders feel it most:

| Balance (coins) | Rate |
|-----------------|------|
| below `TAX_EXEMPT_BELOW` (≤10,000) | **0% (exempt)** |
| 10,000 – 99,999 | 3% |
| 100,000 – 499,999 | 4% |
| 500,000 – 999,999 | 5.5% |
| 1,000,000 – 4,999,999 | 7% |
| ≥ 5,000,000 | 7% (cap, or push higher if you want sharper anti-hoarding) |

So an idle whale at 1.1M pays ~77,000; a 50k holder pays ~1,500; anyone at/below 10k pays nothing. The minnow is never touched — the tax exists to make *sitting on a giant pile* cost something, which nudges whales to either play or deploy their coins. All constants in one place (`shared/types.ts`: `TAX_EXEMPT_BELOW`, `INACTIVITY_TAX_BRACKETS`).

## Anti-edge-case / fairness

- **The poor are exempt by construction**: the `TAX_EXEMPT_BELOW` floor (≥10k) means newcomers, minnows, and anyone who just lost their stack pay nothing and can never be pushed below the floor by the tax. This is the core "don't penalize those with little" guarantee — keep it prominent.
- **Grace for brand-new players**: additionally skip `last_played === 0` on a player's first day (they couldn't have played in a window that didn't exist for them yet). The exemption already covers most newcomers, but this avoids edge confusion.
- **Don't tax netizens** (they're House-funded; taxing them just shuffles House↔House). Guard on `is_netizen = FALSE`.
- **Weekend**: don't run the tax on Sat/Sun (no market hours to have played in). The 5pm collection still runs for loans; gate only the tax with `isMarketHours`-style weekday check on the collection day.

## Conservation

Tax is a pure player→House transfer: `players.coins -= tax`, `house += tax`. Sums to zero. `npm run conservation` must still pass; add a tax case to the harness if practical.

## Verification

- `npm run dev` with a scratch DB. Seed a player with a known balance and `last_played` set to yesterday; temporarily trigger `runDailyCollection` (or force the 5pm path). Confirm: balance drops by the bracket amount (≥100), House rises by the same, and a player whose `last_played` is set to "today after 9am" is untouched.
- Confirm netizens and weekend runs are skipped.
- `npm run typecheck`.

## Files to touch

- `server/db.ts` — `last_played` migration; stamp in `recordResult` (`505`); `applyInactivityTax()`.
- `server/lobby.ts` — call `applyInactivityTax(todayMarketOpenMs)` inside `runDailyCollection` (`1818`); ET 9am helper; online-wallet refresh + announce.
- `shared/types.ts` — `INACTIVITY_TAX_BRACKETS` constants.
