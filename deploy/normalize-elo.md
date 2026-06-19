# Normalizing legacy Elo baselines

Some players were seeded at a different starting Elo than the current default of
**500** — notably a cohort that **started at 100**. That makes their rating
incomparable to everyone else's and skews anything derived from Elo (the
leaderboard ordering and the betting odds). This is a **one-time data fix** run
directly against the production database; it is not wired into the app.

> The betting odds are already defensive about this — ratings are blended toward
> 500 for players with few games (see `server/odds.ts`), so odds stay sane even
> before this runs. Normalizing just makes well-played accounts accurate.

## Where to run it

The DB lives on the production VPS (`/etc/tsong.env` → `DATABASE_URL`). Open a
shell on the box (DigitalOcean droplet console, or SSH if you have an
interactive key) and use either:

```sh
sudo -u postgres psql tsong            # peer auth
# or
. /etc/tsong.env && psql "$DATABASE_URL"
```

## 1. List everyone, lowest Elo first — find the 100-starters

```sql
SELECT id, name, elo, wins, losses, wins + losses AS games
FROM players
ORDER BY elo ASC;
```

Eyeball the list. A player who "started at 100" shows up as an implausibly low
Elo given their record (e.g. a positive or even win/loss split but an Elo far
below the 500 default). Legitimate low ratings from genuinely losing a lot are
**not** what we're correcting — leave those alone.

## 2. Correct just the flagged accounts (+400 shift)

A player seeded at 100 instead of 500 is uniformly **400 points low**. Shifting
their stored Elo by +400 puts them on the same baseline as everyone else **while
preserving every rating change they earned since** — only the bad starting
offset is removed.

Target them explicitly by `id` (names aren't unique). Always preview, then
update inside a transaction:

```sql
-- Preview the exact rows you're about to change:
SELECT id, name, elo, elo + 400 AS new_elo
FROM players
WHERE id IN ('<pid-1>', '<pid-2>', '...');

-- Apply (wrap in a transaction so you can ROLLBACK if it looks wrong):
BEGIN;
UPDATE players SET elo = elo + 400
WHERE id IN ('<pid-1>', '<pid-2>', '...');
-- re-run the SELECT from step 1 to confirm, then:
COMMIT;   -- or ROLLBACK;
```

## Notes

- No app restart is needed — the next match reads the corrected Elo directly.
- The `+400` assumes a 100 baseline vs. the 500 default. If you find a different
  legacy baseline (e.g. an un-migrated 1000-era account — `db.ts` already maps
  `1000 → 500` on startup), adjust the delta per cohort accordingly.
- Run during a lull; it shares the production DB. It's tiny and instant, but the
  `BEGIN/COMMIT` keeps it safe regardless.
