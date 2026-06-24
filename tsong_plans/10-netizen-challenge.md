# Plan 10 — Challenge a Netizen (wager duel)

## Context

Let players walk up to a netizen in the **World**, start a conversation, and **challenge it to a Pong duel for a coin wager staked against the netizen's net worth**. The netizen plays as an AI paddle whose **difficulty scales with the wager size** — bigger wager = tougher opponent — but **capped so it's never much harder than the hardest Davis level in the campaign**. Anti-abuse rails: **one challenge per netizen per day**, and a player can win **at most 20% of that netizen's net worth** in a single challenge.

This reuses the existing AI bot opponent and ties the World, the bot difficulty system, and the coin economy together. (The 20% rule and difficulty curve are explicitly "rough" per the user — tune during implementation.)

## Anchors

- AI bot opponent: `private bot {ws, side, id, level: BotLevel('easy'|'medium'|'hard'), reactTimer, aimY}` (`lobby.ts:~203`); spawned by `addBot()` (`lobby.ts:~541`), AI steering `botPredictY()` (`lobby.ts:~2857`), fake socket `makeBotSocket()` (`lobby.ts:~2870`). Bot matches currently **never count** toward leaderboard. *(Line numbers shifted after recent merges — verify with a grep for `addBot`, `BotLevel`, `botPredictY`.)*
- Campaign "Davis" difficulty: the campaign mode ("Davis Collects") has escalating Davis opponents. **Find its hardest Davis level's AI parameters** (grep `campaign`, `davis`, difficulty/react/speed constants) — that defines the **clamp ceiling** for challenge difficulty.
- Netizens: real `players` rows, `is_netizen=TRUE`, pids `"netizen:i"`, names `lobby.ts:662`. Net worth computed in the net-worth board (`getNetWorthLeaderboard` `db.ts:1040`-ish; `coins + holdings − debt`).
- World interaction: avatars + door/building prompt pattern (`client/world.ts` prompt button `~195-213`); Plan 03 puts netizen avatars in the world.

## Interaction flow

1. In the World, when the player's avatar is near a netizen avatar, show an **"Interact"** prompt (reuse the building-door prompt UI, `world.ts:195-202`). Opening it shows a small dialog (reuse the building dialog modal `world.ts:204-213`) with the netizen's name, its net worth, today's challenge availability, and a **"Challenge to a match"** option with a **wager input**.
2. Player picks a wager `W`. Client sends `{type:'netizenChallenge', netizenId, wager:W}`.
3. Server validates (see rules), and if OK, **starts a duel** seating the human on one paddle and the netizen-bot on the other, with difficulty derived from `W`. The match runs on the normal duel engine.
4. On match end, settle coins (see settlement) and send a result. Mark the netizen challenged-today.

## Rules / validation (server)

`netizenChallenge(ws, netizenId, wager)`:
- Resolve the netizen (`is_netizen`, valid pid). Compute its **net worth** `NW`.
- **Once per day**: reject if this player already challenged **this** netizen since the last daily reset (use the 5pm ET boundary or a calendar-day in ET). Track in a table:
  ```sql
  CREATE TABLE IF NOT EXISTS netizen_challenges (
    player_pid  TEXT NOT NULL,
    netizen_pid TEXT NOT NULL,
    ts          BIGINT NOT NULL,
    PRIMARY KEY (player_pid, netizen_pid)
  );
  ```
  Upsert `ts` on a successful challenge; reject if existing `ts` is within the current day. (Keying per (player,netizen) means a player can challenge *different* netizens the same day but each only once — matches "challenge a netizen once a day". If you want a global one-per-day, key on player only.)
- **Wager cap (anti-abuse)**: `maxWin = floor(0.20 * NW)`. Require `1 <= W <= maxWin`. Also require the netizen can actually **pay** `W` from liquid coins — clamp `W <= netizen.coins` (or force-liquidate netizen positions up to need; simplest is clamp to `min(0.20*NW, netizen.coins)`). And require the **player can cover a loss**: `player.coins >= W` (escrow it). Reject otherwise with a clear message.
- Respect the **wealth-scaled minimum bet** from Plan 11 for the lower bound of `W`.

## Difficulty scaling (capped)

Map `W` (as a fraction of `maxWin`, i.e. `t = W / maxWin ∈ (0,1]`) to an AI difficulty between **easy** and the **campaign's hardest Davis** parameters — never beyond. Concretely, interpolate the bot's tuning knobs (`reactTimer` reaction lag, aim error/jitter, paddle speed used in `botPredictY`) from an easy baseline at `t→0` to the **Davis-hardest** values at `t→1`, then **clamp** so the result is at most the Davis-hardest (a small headroom under it is fine — "never much harder"). Document the exact knobs once you read the bot + campaign difficulty code. Spawn the bot via the existing `addBot()` path but with these custom, wager-derived parameters instead of a fixed `BotLevel` (extend `addBot` to accept an explicit tuning object, or add a `addChallengeBot(side, tuning)` variant).

## The match + settlement

- Seat the human + the challenge-bot in a normal duel (first to 3, the standard rule). This match is a **wagered, non-ranked** game: do **not** affect Elo/leaderboard (prevents farming) — reuse the "bot matches never count" property, but **do** settle coins.
- On result:
  - **Player wins**: transfer `W` from netizen → player. `netizen.coins -= W; player.coins += W` (peer transfer, coin-conserving; no House). If the netizen lacked liquid `W` (shouldn't, due to the clamp), liquidate its positions first.
  - **Player loses**: transfer the escrowed `W` from player → netizen. (Player's `W` was escrowed at challenge start via `spendCoins`; on loss credit it to the netizen; on win refund the escrow + pay `W` from netizen.)
  - Mark `netizen_challenges` for today regardless of outcome (the attempt is spent).
- Send `{type:'netizenChallengeResult', won, delta, netizenName}`; refresh wallet + net-worth board.

## Protocol

- **ClientMsg**: `{type:'netizenChallenge', netizenId:string, wager:number}`.
- **ServerMsg**: `NetizenChallengeResultMsg {type:'netizenChallengeResult', won:boolean, delta:number, netizenName:string}`; and an info/availability message for the dialog (`{type:'netizenInfo', netizenId, netWorth, maxWin, challengedToday:boolean}`) requested when the player opens the interact dialog (`{type:'netizenInfoReq', netizenId}`).
- Dispatch in `server/index.ts` + `client/main.ts`/`client/world.ts`.

## Edge cases

- Netizen already in another challenge / the human already seated in a live duel → reject (can't be in two matches).
- Netizen net worth tiny (≈0) → `maxWin` rounds to 0 → no challenge available; show "not worth your time" in the dialog.
- Disconnect mid-match → treat as player forfeit (netizen takes the escrow) to prevent rage-quitting out of a loss.
- Wash/abuse: 20% cap + once-per-day + difficulty scaling limit farming; still log challenge outcomes for tuning. Re-evaluate the 20%/difficulty curve after playtesting (user flagged it as rough).
- Conservation: player↔netizen transfer is zero-sum; no minting. `npm run conservation` still passes.

## Verification

- `npm run dev`; enter World, approach a netizen, open interact dialog (shows its net worth + max win + availability). Challenge with a valid wager → a duel starts vs a bot whose difficulty feels tied to the wager but never exceeds the hardest Davis. Win → you gain `W` (≤20% of its NW) and its net worth drops; lose → you lose `W`. Second challenge same day to the same netizen is blocked.
- Confirm Elo unaffected; coins conserved.
- `npm run typecheck`.

## Files to touch

- `server/db.ts` — `netizen_challenges` table; helpers to read/write today's challenge; netizen net-worth/coins lookup; (maybe) liquidate-netizen helper.
- `server/lobby.ts` — `netizenChallenge`, `netizenInfo`, challenge-bot spawn with wager-derived tuning (extend `addBot`), settlement on match end, daily-reset logic (reuse ET boundary).
- `shared/types.ts` — challenge message types; difficulty-curve + 20% constants.
- `server/index.ts` — dispatch challenge/info messages.
- `client/world.ts` + `client/main.ts` + `client/index.html` — interact prompt + challenge dialog (reuse world building-dialog UI), wager input, result toast.
