# Plan 11 — Wealth-Scaled Minimum Bets

## Context

Right now a whale with millions can bet 1 coin in the casino, which makes gambling meaningless for the rich and lets them grind risk-free. Scale the **minimum bet up with the player's wealth**: the more coins you have, the higher the floor you must wager. Applies across the casino — **Roulette**, **Blackjack** (Plan 09), the **PvP spectator bet**, and the **netizen challenge** (Plan 10) — via one shared helper.

**Design tenet:** this is an **anti-hoarding** lever, not a tax on the poor. The bottom tier keeps a min bet of **1** so low-wealth players are completely unaffected — the floor only rises for the wealthy, making real stakes mandatory only for those sitting on real piles.

This is a small, cross-cutting rule. Implement the helper once; wire it into each betting surface.

## The helper

Add `minBet(wealth: number): number` in `shared/types.ts` (so client and server share it). `wealth` = the player's liquid coins (simplest, consistent everywhere) — or net worth if you prefer it to track holdings too; **recommend liquid coins** since bets are paid from coins. Tiered floor (tunable constants `MIN_BET_TIERS`):

| Wealth (coins) | Min bet |
|----------------|---------|
| < 1,000 | 1 |
| 1,000 – 9,999 | 10 |
| 10,000 – 99,999 | 100 |
| 100,000 – 499,999 | 1,000 |
| 500,000 – 999,999 | 5,000 |
| ≥ 1,000,000 | 10,000 |

(A 1.1M-coin whale must wager ≥10,000; a 5k casual ≥10; a newcomer ≥1.) Keep it well below balances so it constrains the floor, not the ability to play. Tune freely.

```ts
export const MIN_BET_TIERS: readonly [number, number][] = [
  [1_000_000, 10_000], [500_000, 5_000], [100_000, 1_000],
  [10_000, 100], [1_000, 10], [0, 1],
]; // [thresholdCoins, minBet], checked high→low
export function minBet(wealth: number): number {
  for (const [t, m] of MIN_BET_TIERS) if (wealth >= t) return m;
  return 1;
}
```

## Wiring (server-authoritative; client mirrors for UX)

Enforce on the **server** in each handler (never trust the client). Look up the player's coins (`getWallet`/the cached balance) before validating the stake:

- **Roulette** `roulette()` (`lobby.ts:1533-1567`): after computing `total`, reject if `total < minBet(coins)` (with a clear message). (Roulette already caps the max via `ROULETTE_MAX_TOTAL`; this adds the floor.)
- **Blackjack** `blackjackDeal()` (Plan 09): reject `bet < minBet(coins)`.
- **PvP spectator bet** `bet()` (`lobby.ts:~1674`): reject stakes below `minBet(coins)`.
- **Netizen challenge** `netizenChallenge()` (Plan 10): lower-bound the wager at `minBet(coins)` (and still cap at 20% of netizen net worth).

On the **client**, show the current minimum in each betting UI (roulette stake area, blackjack bet input, bet panel, challenge dialog) and disable/clamp the input below it, so the rejection is rare and the floor is visible. Import `minBet` from `shared/types.ts` and feed it the player's current coin balance (the client already tracks the wallet).

## Edge cases

- A player whose balance is **below** their tier's min bet (e.g. they had 1.2M, bet big, now have 8k): use their **current** coins for the tier lookup each time, so the floor drops as they spend — they're never locked out of playing with what they have. (Because tiers are by current wealth, a near-broke ex-whale falls into a lower tier automatically.)
- Min bet must never exceed the player's balance — if `minBet(coins) > coins` (only possible at tier edges with rounding), clamp the effective floor to `coins` so they can still make one final bet.
- Keep all four surfaces consistent by routing through the single `minBet` helper — no per-game copies.

## Verification

- `npm run dev`; with a test account, set coins to each tier and confirm: the casino rejects/where the UI clamps sub-floor bets, the displayed minimum matches the tier, and spending down into a lower tier lowers the floor. Confirm a sub-floor bet is rejected server-side even if the client is bypassed.
- `npm run typecheck`.

## Files to touch

- `shared/types.ts` — `MIN_BET_TIERS`, `minBet()`.
- `server/lobby.ts` — enforce in `roulette` (`1533`), `blackjackDeal` (Plan 09), `bet` (`1674`), `netizenChallenge` (Plan 10).
- `client/*` — show + clamp the minimum in roulette, blackjack, the bet panel, and the challenge dialog.
