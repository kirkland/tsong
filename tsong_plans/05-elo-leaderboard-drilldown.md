# Plan 05 — Elo Leaderboard Drill-down

## Context

The Net-Worth board already supports click-a-row → balance-sheet modal. This adds the same for the **Elo leaderboard**: click a player's name → a profile card showing **win/loss record, Elo, last played**, and **head-to-head** info — who they've **beaten the most** and who they've **lost to the most**. Head-to-head isn't tracked today, so this plan adds a match-history table going forward (no backfill of past matches — clearly state that in the UI: "since head-to-head tracking began").

## Data model

Two additions:

1. **`players.last_played BIGINT`** — same column as Plan 04. Add once (coordinate). Stamp in `recordResult` (`db.ts:505`).
2. **`head_to_head` table** — aggregate counts per ordered pair (cheap to query, no need to store every match):
   ```sql
   CREATE TABLE IF NOT EXISTS head_to_head (
     winner_pid TEXT NOT NULL,
     loser_pid  TEXT NOT NULL,
     wins       INT  NOT NULL DEFAULT 0,
     PRIMARY KEY (winner_pid, loser_pid)
   );
   ```
   On each duel result, upsert `+1` for the `(winner, loser)` pair. (Only meaningful for 1v1 Pong duels — guard so team/arena matches with ambiguous pairings don't pollute it, or record every winner×loser pairing if you want team coverage. Recommend: 1v1 duels only for clean "rival" semantics.)

Update `recordResult()` (`db.ts:505-551`): when it's a clean 1v1 (one winner pid, one loser pid), `INSERT INTO head_to_head (winner_pid, loser_pid, wins) VALUES ($w,$l,1) ON CONFLICT (winner_pid,loser_pid) DO UPDATE SET wins = head_to_head.wins + 1`. Also stamp `last_played`.

### Queries (`db.ts`)

```ts
// Most-beaten: who THIS player beats most.   Most-lost-to: who beats THIS player most.
export async function getRival(pid: string): Promise<{
  beatenMost: { name: string; count: number } | null;   // SELECT loser, wins WHERE winner=pid ORDER BY wins DESC LIMIT 1, JOIN players for name
  lostToMost: { name: string; count: number } | null;    // SELECT winner, wins WHERE loser=pid ORDER BY wins DESC LIMIT 1
}>
// Profile basics:
export async function getPlayerProfile(pid: string): Promise<{ name; wins; losses; elo; lastPlayed: number } | null>
```

## Protocol (mirror the balance-sheet pattern)

The balance-sheet flow is the exact template: click handler `main.ts:4452-4458` (`li[data-rank]` → `balanceSheetReq{rank}`), server `index.ts:345` → `sendBalanceSheet` (`lobby.ts:3022`), `BalanceSheetMsg` (`types.ts:762`), client `showBalanceSheet` (`main.ts:4469`).

Add the parallel:
- **ClientMsg** `{ type:'eloProfileReq'; rank:number }` → dispatch in `index.ts` → `lobby.sendEloProfile(ws, rank)`.
- Server resolves `rank` → pid using the cached Elo-board pid array (the Elo board is built from `getLeaderboard()` `db.ts:1389`; cache the pids alongside the rows the same way net-worth caches `netWorthPids` at `lobby.ts:3022`). Fetch `getPlayerProfile` + `getRival` in parallel.
- **ServerMsg** `EloProfileMsg { type:'eloProfile'; name; wins; losses; elo; winRate; lastPlayed; beatenMost; lostToMost }`.
- Client `showEloProfile(msg)` renders a modal cloned from the balance modal markup (`#balanceModal` styling, `main.ts:4469-4503`) — call it `#eloModal`.

## Client / UI

- The Elo leaderboard rows need `data-rank` and a click target on the name, like the net-worth rows. Find where the Elo board renders (the `#leaderboard` div populated from `LeaderboardMsg`) and add a `li[data-rank]` click → `eloProfileReq`. (Net-worth uses the same `data-rank` convention — copy it.)
- Modal content: name + Elo, `W–L (winRate%)`, "Last played: <relative time>" (or "a while ago" if `lastPlayed===0`), and two rival lines:
  - `🏆 Beats most: <name> (×N)` or "No rivalries yet."
  - `💀 Loses to most: <name> (×N)` or "Undefeated so far."
  - Footnote: "Head-to-head tracked since this feature launched."
- Reuse balance modal CSS classes (`.bs-row`, `.bs-section`, `.bs-total`, the close handler) so it matches.

## Edge cases

- Player with no matches: profile still resolves (0/0), rivals null → friendly empty states.
- Names can change (the `players.name` updates on each result); always JOIN to `players` for the current display name rather than storing names in `head_to_head`.
- Self-click is fine (shows your own card).
- No DB: handlers no-op gracefully (mirror existing guards).

## Verification

- `npm run dev`; play a few 1v1 duels between two accounts so `head_to_head` accumulates. Click a name on the Elo board → modal shows correct W/L, last played, and the rival lines reflecting the matches. Click someone with no matches → graceful empties.
- `npm run typecheck`.

## Files to touch

- `server/db.ts` — `last_played` + `head_to_head` migrations; `head_to_head` upsert + `last_played` stamp in `recordResult` (`505`); `getRival`, `getPlayerProfile`.
- `server/lobby.ts` — cache Elo-board pids; `sendEloProfile` (mirror `sendBalanceSheet` `3022`).
- `shared/types.ts` — `eloProfileReq`, `EloProfileMsg`.
- `server/index.ts` — dispatch `eloProfileReq` (near `345`).
- `client/main.ts` + `client/index.html` — `#eloModal`, `showEloProfile`, Elo-row click wiring (mirror net-worth `4452`).
