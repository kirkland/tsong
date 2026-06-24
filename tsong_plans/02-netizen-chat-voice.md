# Plan 02 — Netizen Chat Voice

## Context

The 10 netizen bots trade real stock positions every 30s but are silent. This gives them a voice in chat: during **market hours (M-F 9am–5pm ET)** they post short messages about the trades they *actually* just made ("aped into FRITZ 🚀", "took profit on OTTO"), and when the News Engine (Plan 01) publishes a headline, they **react in chat on a stagger** so the chat feels like a live trading floor reacting to news. The reactions are timed to land in the 7–30 min window *before* the price move hits, reinforcing the "read the room and position" loop.

Depends on: **Plan 01** (`isMarketHours`, the `NewsEvent`/feed, the publish hook). Owns the **netizen colors** and the **`NETIZEN_DIALOGUE` corpus** reused by Plan 03.

## Shared modules this plan OWNS

1. **`NETIZEN_COLORS`** — `NETIZEN_NAMES` (`lobby.ts:662`) has no colors. Add a parallel `private static readonly NETIZEN_COLORS = [...]` (10 distinct hexes) or convert to `{name,color}` objects. A `netizenColor(pid)` helper maps `"netizen:i"` → color.
2. **`NETIZEN_DIALOGUE`** corpus (put in `shared/types.ts` so Plan 03's client can reuse it): templated line pools keyed by situation (`buyLong`, `sellProfit`, `sellLoss`, `newsBullish`, `newsBearish`, `idleBanter`). Each is an array of templates taking `{coin}`/`{ticker}`/`{name}`. Examples below.

## The chatter mechanism

Reuse the existing bot-chat injection (`botChat()` at `lobby.ts:3089`, which posts a `ChatLine` with `player:false`). Add a sibling that posts **as the netizen** (its own name + color):

```ts
private netizenSay(pid: string, name: string, text: string) {
  this.botChat(name, text, this.netizenColor(pid)); // botChat already broadcasts + persists to chatLog
}
```

(If `botChat` hardcodes a streamer color, generalize it to accept a color arg — it already takes `(from, text, color)` per the streamer path.)

### A) Trade chatter (hook to real trades)

In `tickNetizens()` (`lobby.ts:1695`) the netizen calls `netizenInvest()` (`1742`) or `netizenCashOut()` (`1753`). After a **successful** trade, and only if `isMarketHours(now)`, post a line with a **low probability per trade** so chat isn't spammy (e.g. `Math.random() < 0.25`). Choose the template pool by trade type:
- buy long → `buyLong` pool
- sell with gain (cash-out `gross > cost`) → `sellProfit`
- sell with loss → `sellLoss`

Pass the coin ticker into the template. Keep messages short, lowercase, meme-y to match the netizen personas (satoshi_jr, moonboy420, paperhands_pete, etc.). Example pools:
```
buyLong:    ["aped into {ticker} 🚀", "loading {ticker} here", "{ticker} looking juicy ngl", "all in {ticker} lfg"]
sellProfit: ["took profit on {ticker} 💰", "out of {ticker}, ty market", "{ticker} paid the bills today"]
sellLoss:   ["got rekt on {ticker} 💀", "paperhanded {ticker} again", "{ticker} bagholder no more"]
```
Optionally bias a netizen's vocabulary by archetype/persona (paperhands_pete leans `sellLoss`, moonboy420 leans `buyLong`) — nice-to-have, not required.

### B) News reactions (hook to Plan 01)

When Plan 01's `publishNews(item)` runs, schedule **2–4 netizen reactions** staggered across the next ~60–120s (so they trickle in, not all at once), only if `isMarketHours`. Implementation: push reaction jobs into a small in-memory queue `private newsReactions: { name:string; pid:string; text:string; at:number }[]`, drained in `tickStocks()`/`sync()` each tick when `at <= now`.
- Pick the pool by the news *direction* (Plan 01 knows it; pass `dir` to the hook): `newsBullish` if the headline is bullish for its coin, else `newsBearish`. The reactions should sound like speculation, matching the headline's vagueness — **do not reveal** the coin will move:
```
newsBullish: ["something brewing with {ticker}? 👀", "i'm not not buying {ticker} rn", "feels like {ticker} szn"]
newsBearish: ["staying away from {ticker} today", "{ticker} giving me bad vibes", "might short {ticker} ngl"]
```
- A reacting netizen *may* also place a matching trade (bias its next `tickNetizens` decision toward the news direction for that coin) so its words match its actions — optional polish that makes the floor feel real.

### C) Idle banter (optional, low rate)

Occasionally (very low probability per tick, market hours only) post an `idleBanter` line about the leaderboard or features, reusing the same corpus Plan 03 uses ("who's this lasso guy with 1M net worth", "new exclusive dropped in the black market 👀"). Keep rate low to avoid drowning real chat.

## Rate limiting / feel

- Global throttle: cap netizen chat to ~1 line per ~8–15s across all netizens (track `lastNetizenChatAt`) so it never floods. Real player chat and streamer-mode chatter already coexist; keep netizen volume below both.
- Respect the existing chat history cap (`CHAT_HISTORY`, the `chatLog` shift in `lobby.ts:375-398`).

## Protocol

None required — reuses the existing `chat` broadcast (`{type:'chat', lines:[line]}`). Netizen lines render exactly like streamer-bot lines (non-player styling) but with the netizen's name/color, so they're indistinguishable from "real" chatters — which is the point.

## Edge cases / tests

- Outside market hours: zero netizen chatter and zero news reactions (trades may still happen per existing `tickNetizens`, but silent). Verify.
- No DB / no netizens seeded: `getNetizens()` empty → no chatter, no crash.
- Spam guard: with all 10 netizens trading, confirm chat shows at most ~1 line/8-15s, not a wall.
- Conservation: chat is free; trades already conserve coins. No new economy surface.

## Verification

- `npm run dev`; temporarily widen `isMarketHours` to always-true and lower throttles. Watch chat: netizens post buy/sell lines that *match* trades visible on the net-worth board moving. Force a Plan-01 news publish → 2-4 netizen reactions trickle in over ~1-2 min, themed to the headline, before the price moves.
- Confirm netizen names show with distinct colors and `player:false` styling.

## Files to touch

- `server/lobby.ts` — `NETIZEN_COLORS`/`netizenColor`, `netizenSay`, trade-chatter hooks in `netizenInvest`/`netizenCashOut` (`1742`/`1753`), news-reaction queue drained in `tickStocks` (`2254`), publish hook from Plan 01's `publishNews`.
- `shared/types.ts` — `NETIZEN_DIALOGUE` corpus (exported for Plan 03).
- (Possibly) generalize `botChat` (`lobby.ts:3089`) to take a color arg if it doesn't already.
