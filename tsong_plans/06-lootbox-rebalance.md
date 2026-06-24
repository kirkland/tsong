# Plan 06 — Loot Box Rebalance + New Items

## Context

The loot box is too cheap and too generous. Make it a genuine **high-risk, high-reward whale gamble**: pricier per box, cosmetic pulls rare (~1%), exclusives very rare, and a real chance of **getting nothing** (you can lose your money). Also **add a few new items** to the pool (new common cosmetics + new exclusives) so there's fresh chase content.

Decision locked: **Whale gamble — 2,500 coins/box; ~1% common cosmetic, ~0.3% capped exclusive, ~35% partial coin-back (less than paid), ~64% nothing.**

## Current state (anchors)

- Constants `lobby.ts:669-670`: `LOOT_PRICE = 2500` (already), `LOOT_COIN_REWARD = 1500`.
- Roll table `lobby.ts:2084-2089`: `weights = [55, 30, 15]` → [common cosmetic, coins, rare exclusive]. **This is the generous part to change.**
- Rare pick weighted by `cap` `lobby.ts:2139-2145`. Mint gate `mintExclusive()` `db.ts:984-997`. Refund-on-fizzle hotfix `lobby.ts:2076-2082`.
- `openLootBox` full flow `lobby.ts:1975-2034` (price → House via `houseCredit`, roll, payout via `housePay`, exclusive coin reward from House).

## New economics (replace the weights)

Keep `LOOT_PRICE = 2500`. Replace the 3-bucket `[55,30,15]` with a **4-bucket** table including **nothing**:

| Outcome | Weight | Effect |
|---|---|---|
| Common cosmetic | 1.0 | Grant a random unowned regular cosmetic (skip if all owned → fall through to partial coin-back). |
| Capped exclusive | 0.3 | `mintExclusive` weighted by cap; if capped out → partial coin-back. |
| Partial coin-back | 35.0 | `housePay` a **fraction** of the price, e.g. random in `[500, 1500]` (always < 2,500, so EV-negative). Replaces the old flat 1,500 coin reward. |
| Nothing | 63.7 | No item, no coins. The box price already went to the House. Show a "better luck next time" reveal. |

(Weights are relative; normalize by sum. So cosmetic ≈ 1%, exclusive ≈ 0.3%, coin-back ≈ 35%, nothing ≈ 63.7%.) Put these in named constants (`shared/types.ts` `LOOT_TABLE`) so they're tunable in one place. Keep the **refund-on-fizzle** safety (`lobby.ts:2076-2082`) for the case where an outcome can't be honored (e.g. coin-back when the House is empty) — but "nothing" is an intended outcome, not a fizzle, so do **not** refund on "nothing".

EV check (document it): per 2,500-coin box, expected return ≈ `0.01*cosmeticValue + 0.003*exclusiveValue + 0.35*~1000(coin-back) ≈ ~350 coins + rare cosmetic lottery`. Strongly negative-EV in raw coins, which is the point (it's a sink + a gamble for cosmetics). The House nets the difference.

## New items to add

Add **new common cosmetics** to `COSMETICS` (`shared/types.ts:171-246`) so the 1% cosmetic bucket has fresh pulls — e.g. 3-4 new hats/skins/trails (pick fun ids + names + slot + price; they're regular shop items too). And add **2-3 new exclusives** to `EXCLUSIVES` (`shared/types.ts:265-272`) for the rare bucket, with caps (e.g. one cap-1 mythic, two cap-3). Suggested (tune freely):
```
// EXCLUSIVES additions
{ id:'x-jackpot',  name:'🎰 Jackpot Crown', slot:'hat',   cap:3, rarity:'legendary' },
{ id:'x-midas',    name:'👑 Midas Touch',   slot:'skin',  cap:3, rarity:'epic' },
{ id:'x-singularity', name:'🌀 Singularity', slot:'trail', cap:1, rarity:'mythic' },
```
**CRITICAL — every new exclusive (and any new animated cosmetic) MUST get a client renderer**, or it pulls but renders as nothing — the exact bug Plan 07 fixes. For each new `x-*`:
- hat → add a renderer fn to `HAT_RENDERERS` (`client/render.ts:799-820`)
- skin → add to `SKIN_RENDERERS` (`client/render.ts:659-677`)
- trail → add to `TRAIL_TINTS` (+ `TRAIL_GLOW` if it should glow) (`client/render.ts:684-705`)
- title → ensure the title-tag label resolves its display name (see Plan 07)
- seed its `exclusive_supply` row (the `initDb` seed loop that inserts EXCLUSIVES, `db.ts`).
Do Plan 07 first (or together) so the renderer-registration pattern is already in place.

## Conservation

Unchanged discipline: box price → House (`houseCredit`, already at `lobby.ts:1983`); coin-back → House via `housePay`; "nothing" keeps the price in the House. Exclusive coin-fallback already House-funded. `npm run conservation` must pass. The only change is the *distribution* of outcomes, not the accounting.

## Client / reveal

`openLootBox` returns a `lootResult` (`types.ts`); the client reveal animation (reuses `celebrateSpin`, `main.ts:631`) must handle the **"nothing"** case gracefully — a deflating "🫥 Empty… the house thanks you" reveal, distinct from a coin or item win. Make the rarity flourish scale: nothing < coin-back < cosmetic < exclusive (serial badge "#2 of 3").

## Verification

- `npm run dev`; open many boxes (temporarily lower `LOOT_PRICE` or grant coins). Confirm: ~most opens are "nothing", ~1/3 give partial coins (always < 2,500), cosmetics are rare, exclusives very rare; House balance rises net positive over many opens.
- Pull a new exclusive and equip it → it actually renders (validates the Plan 07 dependency). Cap-1 item can't be pulled twice.
- `npm run conservation` passes. `npm run typecheck`.

## Files to touch

- `shared/types.ts` — `LOOT_TABLE` weights/constants; new `COSMETICS` + `EXCLUSIVES` entries.
- `server/lobby.ts` — replace weights/outcomes in `openLootBox` (`1975-2034`, roll at `2084`); keep refund-on-fizzle, add intended "nothing".
- `server/db.ts` — seed `exclusive_supply` for new exclusives.
- `client/render.ts` — renderers for every new exclusive/animated cosmetic (Plan 07 pattern).
- `client/main.ts` — loot reveal handles the "nothing" outcome.
