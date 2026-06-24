# Plan 01 — Market News Engine

## Context

The crypto market moves on a price engine (drift + decaying order-flow pressure) but there's no *narrative* — nothing for players to read and trade on. This adds a **News tab** that publishes a market headline **every hour on the hour during market hours (M-F 9am–5pm ET)**. Each headline is cleverly worded to *allude* to a coming move without stating it outright ("whispers that someone's quietly accumulating FRITZ"), and it **secretly pre-commits a real price-pressure injection** that lands at a **random delay of 7–30 minutes** after the headline. Attentive players who read the hint can position before the move hits; netizens react in the gap (see Plan 02). This is the foundation for the netizen voice features.

Decision locked: **real, tradeable move; random 7–30 min delay between headline and impact.**

## Shared modules this plan OWNS (others depend on these)

1. **Market-hours time utils** — add near `nextFivePmEtMs` (`server/lobby.ts:126`), same `Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',…})` approach:
   ```ts
   // M-F, 9:00–16:59 America/New_York.
   function isMarketHours(nowMs: number): boolean {
     const parts = new Intl.DateTimeFormat('en-US', {
       timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: '2-digit',
     }).formatToParts(new Date(nowMs));
     const day = parts.find(p => p.type === 'weekday')?.value;     // 'Mon'..'Sun'
     const hour = Number(parts.find(p => p.type === 'hour')?.value) || 0;
     return !['Sat','Sun'].includes(day ?? '') && hour >= 9 && hour < 17;
   }
   // Epoch ms of the next top-of-hour boundary (xx:00:00) in real time.
   function nextTopOfHourMs(nowMs: number): number {
     const parts = new Intl.DateTimeFormat('en-US', {
       timeZone: 'America/New_York', hour12: false, minute: '2-digit', second: '2-digit',
     }).formatToParts(new Date(nowMs));
     const m = Number(parts.find(p => p.type === 'minute')?.value) || 0;
     const s = Number(parts.find(p => p.type === 'second')?.value) || 0;
     return nowMs + ((3600 - (m * 60 + s)) % 3600 || 3600) * 1000;
   }
   ```
2. **`NewsEvent`** type + the live feed (see Protocol). Plan 02 reads `this.pendingNews`/the published feed to drive netizen reactions.

## Data model

- **News history** survives restarts via the `doom_meta` KV (like `stock_history`): key `news_feed` = JSON array of the last ~30 published `NewsItem`s (headline + timestamp + coin + resolved flag; do NOT persist the hidden magnitude once fired). Read on boot, write on each publish. Add `getNewsFeed()/saveNewsFeed()` in `db.ts` mirroring `getStockHistory()/saveStockHistory()` (`db.ts:899-921`).
- **Pending injections** are in-memory only (they fire within 30 min, fine to lose on restart): `private pendingNews: { coin: string; magnitude: number; fireAt: number }[] = []` on `Lobby` (next to `pressure` at `lobby.ts:268`).

## The news content engine

Add a content module (in `shared/types.ts` so client can render flavor, or a new `server/news.ts`). A news item is generated from a chosen `(coin, direction)`:

```ts
export type NewsDir = 'up' | 'down';
export interface NewsItem { id: string; ts: number; coin: string; headline: string; }
// Hidden server-side: { coin, magnitude (signed), fireAt }.
```

Headline templates — **allude, never state**. Provide ~6-8 bullish and ~6-8 bearish templates that take the coin's display name/ticker. Examples (bullish): `"Whispers in the Casino district: someone's been quietly loading up on {name}."`, `"{ticker} chatter is heating up — the smart money looks interested."`, `"A well-known whale was seen eyeing {name}."` Bearish: `"Analysts are growing wary of {name}'s recent run."`, `"Something feels off about {ticker} — insiders are getting quiet."`, `"Rumblings that {name} holders are heading for the exits."` Pick a random template of the matching direction. **Never** include numbers, timings, or the word "expected to fall/rise." The cleverness is the point.

Magnitude: pick a signed pressure bump sized to be noticeable but bounded by the existing pressure clamp `[-1,1]` and the ±0.5 flow cap in `rollPrice` (`lobby.ts:104-117`). Suggest `magnitude = (dir==='up'?+1:-1) * (0.25 + Math.random()*0.35)` (≈ ±0.25..0.6 added to that coin's pressure accumulator at fire time). Coin choice: random `STOCKS` entry, with light weighting toward coins that haven't had recent news (track last-news-tick per coin to spread it around).

## Scheduling (server)

In `tickStocks()` (`lobby.ts:2254`, runs every `STOCK_UPDATE_MS`=30s inside `sync()`):
1. **Publish check**: keep `private nextNewsAt = nextTopOfHourMs(Date.now())` (init in `loadStockPrices`/boot). When `Date.now() >= nextNewsAt`: if `isMarketHours(now)`, call `publishNews()`; always reset `nextNewsAt = nextTopOfHourMs(now)`.
2. **`publishNews()`**: choose `(coin, dir)`, build `NewsItem`, push to feed + persist, broadcast a `news` message to all clients. Compute `fireAt = now + (7 + Math.random()*23)*60_000` (7–30 min) and push `{coin, magnitude, fireAt}` to `pendingNews`. Emit an in-process hook for Plan 02 (e.g. call `this.onNewsPublished(item)` which Plan 02 fills in, or have Plan 02 read the feed).
3. **Fire check**: each tick, for any `pendingNews` with `fireAt <= now`, add its `magnitude` to `this.pressure.get(coin)` (clamp to [-1,1], same as `recordFlow` at `lobby.ts:1556`) and remove it. The existing 60/40 blend + decay in `rollPrice` then carries the move over the next few ticks — exactly the "it hits the stock" moment.

Edge: if the server restarts between publish and fire, the pending injection is lost (acceptable). The headline stays in the persisted feed marked unresolved; that's fine cosmetically.

## Protocol (`shared/types.ts`)

- **ServerMsg** add: `NewsMsg { type:'news'; items: NewsItem[] }` (sent full feed on join/open, single-item on publish — simplest: always send the recent feed array). Add to the `ServerMsg` union (~`types.ts:703-729`); handle in client dispatch (`main.ts` ~634) → `renderNews(msg.items)`.
- **ClientMsg** add: `{ type:'newsReq' }` → `lobby.sendNews(ws)` (when the user opens the News tab). Dispatch case in `server/index.ts` (~line 130-345).

## Client / UI

- The News tab lives in the **Casino** nav group (the `#casinoPanel` dropdown, `index.html:2952-2960`) as a new `#newsBtn 📰 News` opening a `#newsPanel`, OR as a tab inside the existing market panel. Recommend a standalone `#newsPanel` dropdown for clarity.
- `renderNews(items)` in `main.ts`: list newest-first, each row = time (format to ET) + headline, with a subtle ticker icon. No price hints shown — just the prose. Style to match existing panels (`.nav-menu`).
- On `newsReq`/open, server sends the feed; also auto-update the panel when a `news` push arrives (and flash the `#newsBtn` to signal fresh news, reusing the Casino flash glow already in the nav).

## Edge cases / tests

- Outside market hours / weekends: no publish, no injection. Verify by faking the clock or temporarily widening hours in `isMarketHours` for a manual test.
- Two news items for the same coin before the first fires: both injections stack in `pendingNews` and both fire — acceptable (pressure clamps).
- Conservation: news only moves *price*, never mints/destroys coins. No House interaction. `npm run conservation` unaffected.
- The move must be *tradeable*: manually publish (temporarily force `publishNews()` on boot), buy the hinted coin, confirm price ticks the hinted direction 7-30 min later and decays after.

## Verification

- `npm run typecheck` (new message handled both sides).
- `npm run dev`; temporarily shorten the delay to ~20s and force a publish to watch: headline appears in News tab → ~20s later the coin's price moves the hinted way → decays back over the next few ticks.
- Confirm the headline never contains a number or explicit direction word.

## Files to touch

- `server/lobby.ts` — `isMarketHours`, `nextTopOfHourMs`, `pendingNews`, `nextNewsAt`, `publishNews()`, `sendNews()`, fire/publish hooks in `tickStocks()` (`2254`).
- `server/db.ts` — `getNewsFeed()/saveNewsFeed()` (mirror `899-921`).
- `shared/types.ts` — `NewsItem`, `NewsDir`, `NewsMsg`, `newsReq`/`news` in the unions; headline templates (or `server/news.ts`).
- `server/index.ts` — dispatch `newsReq`.
- `client/main.ts` + `client/index.html` — `#newsPanel`, `renderNews`, dispatch `news`.
