// Postgres-backed win/loss leaderboard. Degrades gracefully: if DATABASE_URL is not
// set (e.g. local dev without a DB), every call is a no-op and the leaderboard is
// simply empty, so the rest of the app runs unchanged.

import pg from 'pg';
import { LeaderboardRow, NetWorthRow, LEADERBOARD_SIZE, CampaignScoreRow, StockSide, StockTf, positionWorth, EXCLUSIVES, isExclusive, WORLD_PARCELS } from '../shared/types';
import type { NomicSnapshot } from './nomic';

// Economy Overhaul: the House treasury is seeded ONCE with a genesis allocation. This is the
// only mint besides match wins and the one-time campaign clear/flawless bonuses — every other
// payout is funded by (debited from) the House, keeping coins conserved.
export const HOUSE_GENESIS = 5_000_000;

let pool: pg.Pool | null = null;

// Localhost and internal hostnames (a DB on the same box, or any *.internal private host)
// don't use TLS; a remote/managed Postgres over the public internet does. Enable a
// permissive SSL only for the latter.
function sslFor(url: string): pg.PoolConfig['ssl'] {
  try {
    const host = new URL(url).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.internal')) {
      return undefined;
    }
    return { rejectUnauthorized: false };
  } catch {
    return undefined;
  }
}

export async function initDb(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('DATABASE_URL not set — leaderboard disabled (no persistence).');
    return;
  }
  pool = new pg.Pool({ connectionString: url, ssl: sslFor(url) });
  // Keyed on a stable per-browser id; `name` is the current display label.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id     TEXT PRIMARY KEY,
      name   TEXT NOT NULL,
      wins   INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      elo    INTEGER NOT NULL DEFAULT 500
    )
  `);
  // Add elo column to existing tables that predate this migration.
  await pool.query(`
    ALTER TABLE players ADD COLUMN IF NOT EXISTS elo INTEGER NOT NULL DEFAULT 500
  `);
  // Reset any players still at the old default of 1000 to the new default of 500.
  await pool.query(`UPDATE players SET elo = 500 WHERE elo = 1000`);
  // Wallet + cosmetics: coins (1 per win), owned items (comma list), and equipped hat/skin.
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS owned TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS hat TEXT`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS skin TEXT`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS last_spin BIGINT NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS bonus_spins INTEGER NOT NULL DEFAULT 0`);
  // Robville: lifetime count of lots this player has bought FROM THE BANK (the anti-monopoly cap).
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS bank_parcels INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS trail TEXT`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS title TEXT`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS song TEXT`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS car TEXT`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS pet TEXT`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS boat TEXT`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS balltrail TEXT`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS goalcelebr TEXT`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS email TEXT`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS last_played BIGINT`);
  // User settings (mute, chat toggles, boss-key target…) as a JSON blob, synced across devices.
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS prefs TEXT`);
  // Head-to-head matchups: one row per unordered pair, with per-player win counts.
  // Both player1 < player2 lexicographically so the pair is always stored the same way.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS head_to_head (
      player1 TEXT NOT NULL,
      player2 TEXT NOT NULL,
      p1_wins INTEGER NOT NULL DEFAULT 0,
      p2_wins INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (player1, player2)
    )
  `);
  // Stock market: per-player positions (fractional shares + coins-escrowed cost basis), keyed
  // by player + coin id + side ('long'/'short' — a player can hold both at once); and the
  // global price board (one row per coin).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_holdings (
      pid    TEXT NOT NULL,
      coin   TEXT NOT NULL,
      side   TEXT NOT NULL DEFAULT 'long',
      shares DOUBLE PRECISION NOT NULL DEFAULT 0,
      cost   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (pid, coin, side)
    )
  `);
  // Migrate tables that predate shorting: add the `side` column and widen the primary key to
  // include it (so longs and shorts of the same coin can coexist). Idempotent — the PK swap
  // only runs while `side` isn't yet part of the key.
  await pool.query(`ALTER TABLE stock_holdings ADD COLUMN IF NOT EXISTS side TEXT NOT NULL DEFAULT 'long'`);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.key_column_usage
         WHERE table_name = 'stock_holdings'
           AND constraint_name = 'stock_holdings_pkey'
           AND column_name = 'side'
      ) THEN
        ALTER TABLE stock_holdings DROP CONSTRAINT IF EXISTS stock_holdings_pkey;
        ALTER TABLE stock_holdings ADD CONSTRAINT stock_holdings_pkey PRIMARY KEY (pid, coin, side);
      END IF;
    END $$;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_prices (
      coin  TEXT PRIMARY KEY,
      price DOUBLE PRECISION NOT NULL,
      prev  DOUBLE PRECISION NOT NULL
    )
  `);
  // Davis's loan book: at most one open loan per player (PK on pid). `amount` is the principal
  // borrowed, `owed` is the 1.5× to repay, `due_at` is the epoch-ms deadline (the next daily
  // market reset). Default on the deadline = wallet zeroed + all stock positions wiped.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS loans (
      pid    TEXT PRIMARY KEY,
      amount DOUBLE PRECISION NOT NULL,
      owed   DOUBLE PRECISION NOT NULL,
      due_at BIGINT NOT NULL
    )
  `);
  // --- Economy Overhaul schema ---
  // is_netizen flags the synthetic bot "netizen" traders so they can be seeded/identified. They
  // are real player rows (they appear on the net-worth board) but never mint and are House-funded.
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS is_netizen BOOLEAN NOT NULL DEFAULT FALSE`);
  // jailed persists the drunk-tank lockup, so logging out can't get you out — only bail can.
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS jailed BOOLEAN NOT NULL DEFAULT FALSE`);
  // Fast-sell tax window: when a long/short position was opened, so a cash-out within 60s is taxed.
  await pool.query(`ALTER TABLE stock_holdings ADD COLUMN IF NOT EXISTS opened_at BIGINT`);
  // Authoritative global mint count + cap gate, one row per exclusive (seeded below). The atomic
  // `UPDATE ... WHERE minted < cap RETURNING` on this row is the ONLY exclusive mint path.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exclusive_supply (
      item   TEXT PRIMARY KEY,
      minted INT NOT NULL DEFAULT 0
    )
  `);
  // Per-instance ownership ledger for minted exclusives. `serial` is the mint number (1..cap);
  // `origin` records how it entered the world ('lootbox'). Indexed for owner/item lookups.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exclusive_instances (
      id        BIGSERIAL PRIMARY KEY,
      item      TEXT NOT NULL,
      owner_pid TEXT NOT NULL,
      minted_at BIGINT NOT NULL,
      origin    TEXT NOT NULL DEFAULT 'lootbox',
      serial    INT NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS exclusive_instances_owner ON exclusive_instances (owner_pid)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS exclusive_instances_item ON exclusive_instances (item)`);
  // Player marketplace: one open listing per instance (UNIQUE on instance_id). The buy txn locks
  // the lowest ask of an item FOR UPDATE so two buyers can't take the same listing.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS listings (
      id          BIGSERIAL PRIMARY KEY,
      instance_id BIGINT NOT NULL,
      item        TEXT NOT NULL,
      seller_pid  TEXT NOT NULL,
      seller_name TEXT NOT NULL,
      ask         INT NOT NULL,
      created_at  BIGINT NOT NULL,
      UNIQUE (instance_id)
    )
  `);
  // (The House treasury genesis row lives in doom_meta, which is created further down; it's seeded
  // right after that CREATE so the INSERT can't reference a missing table.)
  // Seed (or top up) the supply gate so every exclusive has a counter row from boot. ON CONFLICT
  // DO NOTHING keeps existing mint counts; new exclusives added later start at 0.
  for (const x of EXCLUSIVES) {
    await pool.query(
      `INSERT INTO exclusive_supply (item, minted) VALUES ($1, 0) ON CONFLICT (item) DO NOTHING`,
      [x.id],
    );
  }

  // Bounties: a pot of coins riding on a player's head (keyed by their pid). Anyone can add to
  // it; the next player to beat the bountied player in a duel collects the whole pot and the row
  // is deleted. `target_name` is the latest display name, kept only for announcements.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bounties (
      target_pid  TEXT PRIMARY KEY,
      target_name TEXT NOT NULL,
      pot         INTEGER NOT NULL DEFAULT 0
    )
  `);
  // DOOM minigame high scores — best round reached, per player, per mode (solo / co-op).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS doom_scores (
      pid   TEXT NOT NULL,
      name  TEXT NOT NULL,
      coop  BOOLEAN NOT NULL,
      round INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (pid, coop)
    )
  `);
  // "Type or Die" co-op typing horde-defense — best wave reached, one row per player.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS typedie_scores (
      pid  TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      wave INTEGER NOT NULL DEFAULT 1
    )
  `);
  // Campaign ("Davis Collects") arcade scores — one row per player, best score kept.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS campaign_scores (
      pid   TEXT PRIMARY KEY,
      name  TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      stage INTEGER NOT NULL DEFAULT 1,
      won   BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  // Fishing minigame — biggest catch (lb) ever landed, one row per player.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fishing_scores (
      pid     TEXT PRIMARY KEY,
      name    TEXT NOT NULL,
      best_lb DOUBLE PRECISION NOT NULL DEFAULT 0
    )
  `);
  // Tsong Hero rhythm game — best score per player per song per difficulty.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gh_scores (
      pid   TEXT NOT NULL,
      song  TEXT NOT NULL,
      diff  TEXT NOT NULL,
      name  TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (pid, song, diff)
    )
  `);
  // One-time versioned wipe of gh_scores: v2 = scores earned before the overstrum
  // (anti-spam) penalty are invalid. Bump the version to wipe again after rule changes.
  await pool.query(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const ghv = await pool.query(`SELECT value FROM meta WHERE key = 'gh_scores_v'`);
  if (ghv.rows[0]?.value !== '2') {
    await pool.query(`DELETE FROM gh_scores`);
    await pool.query(
      `INSERT INTO meta (key, value) VALUES ('gh_scores_v', '2')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
  }
  // Nomic (the Parliament sub-game) — ONE perpetual communal game persisted as a single JSON
  // snapshot row (rulebook, params, scores, log). Won seasons are sealed into nomic_hall.
  await pool.query(`CREATE TABLE IF NOT EXISTS nomic_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)`);
  // Which Ruins chests each account has permanently opened (banked on a clean escape) — so the
  // "once per account, no re-farm" guarantee survives a server restart.
  await pool.query(`CREATE TABLE IF NOT EXISTS dungeon_opened (pid TEXT NOT NULL, chest TEXT NOT NULL, PRIMARY KEY (pid, chest))`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nomic_hall (
      season    INTEGER PRIMARY KEY,
      winner    TEXT NOT NULL,
      rules     TEXT NOT NULL,
      sealed_at BIGINT NOT NULL
    )
  `);
  // Co-op scores used to be recorded per-player; they're now one combined team entry keyed
  // "team:<a> and <b>". Drop any legacy per-player co-op rows so the board only shows pairs.
  await pool.query(`DELETE FROM doom_scores WHERE coop = TRUE AND pid NOT LIKE 'team:%'`);
  // One-time wipe: scores recorded before boss-battle rounds existed are no longer
  // comparable, so clear the whole board once (gated by a meta flag so it runs just once).
  await pool.query(`CREATE TABLE IF NOT EXISTS doom_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
  // Economy Overhaul: seed the House treasury exactly once with the genesis allocation (the only
  // mint besides match wins / campaign bonuses). Idempotent via ON CONFLICT DO NOTHING.
  await pool.query(
    `INSERT INTO doom_meta (k, v) VALUES ('house_balance', $1) ON CONFLICT (k) DO NOTHING`,
    [String(HOUSE_GENESIS)],
  );
  // One-time recovery: the economy first shipped with a House that some deploys left unfunded
  // (missing/zeroed row → every House-backed payout silently paid 0, and coins paid in were lost).
  // Once, lift the treasury to at least the genesis floor. GREATEST never destroys a House that
  // legitimately grew past genesis from gambling losses; gated so it runs a single time.
  const houseReseed = await pool.query(`SELECT 1 FROM doom_meta WHERE k = 'house_reseed_v1'`);
  if (houseReseed.rowCount === 0) {
    await pool.query(
      `INSERT INTO doom_meta (k, v) VALUES ('house_balance', $1)
         ON CONFLICT (k) DO UPDATE SET v = GREATEST(doom_meta.v::numeric, $1::numeric)::text`,
      [String(HOUSE_GENESIS)],
    );
    await pool.query(`INSERT INTO doom_meta (k, v) VALUES ('house_reseed_v1', now()::text)`);
  }
  const reset = await pool.query(`SELECT 1 FROM doom_meta WHERE k = 'reset_boss_v1'`);
  if (reset.rowCount === 0) {
    await pool.query(`DELETE FROM doom_scores`);
    await pool.query(`INSERT INTO doom_meta (k, v) VALUES ('reset_boss_v1', now()::text)`);
  }
  // One-time: clear everyone's daily-spin cooldown so they can all spin again. Bump the
  // version key whenever we want to grant everyone a fresh spin (e.g. for testing).
  const spinReset = await pool.query(`SELECT 1 FROM doom_meta WHERE k = 'spin_reset_v2'`);
  if (spinReset.rowCount === 0) {
    await pool.query(`UPDATE players SET last_spin = 0`);
    await pool.query(`INSERT INTO doom_meta (k, v) VALUES ('spin_reset_v2', now()::text)`);
  }
  // One-time: the market was rebased from a starting price of 100 down to 1, so the old price
  // board and positions are priced in a different regime. Clear both once so the market
  // restarts cleanly at the new base of 1. Gated so it runs just once.
  const stockRebase = await pool.query(`SELECT 1 FROM doom_meta WHERE k = 'stock_rebase_v1'`);
  if (stockRebase.rowCount === 0) {
    await pool.query(`DELETE FROM stock_prices`);
    await pool.query(`DELETE FROM stock_holdings`);
    await pool.query(`INSERT INTO doom_meta (k, v) VALUES ('stock_rebase_v1', now()::text)`);
  }
  // One-time: the price model changed to a calm daily-reset curve. Old prices ballooned under
  // the previous fast-growth model, so clear the board + positions once for a clean start at 1.
  const stockRebase2 = await pool.query(`SELECT 1 FROM doom_meta WHERE k = 'stock_rebase_v2'`);
  if (stockRebase2.rowCount === 0) {
    await pool.query(`DELETE FROM stock_prices`);
    await pool.query(`DELETE FROM stock_holdings`);
    await pool.query(`INSERT INTO doom_meta (k, v) VALUES ('stock_rebase_v2', now()::text)`);
  }
  // One-time: the whole coin economy was scaled ×100 (COIN_SCALE) so the stock market works in
  // whole coins. Multiply every existing balance by 100, and rebase the market — old prices/
  // positions were priced at base 1, but the base is now 100, so clear both for a clean start.
  const coinScale = await pool.query(`SELECT 1 FROM doom_meta WHERE k = 'coin_scale_100x_v1'`);
  if (coinScale.rowCount === 0) {
    await pool.query(`UPDATE players SET coins = coins * 100`);
    await pool.query(`DELETE FROM stock_prices`);
    await pool.query(`DELETE FROM stock_holdings`);
    await pool.query(`INSERT INTO doom_meta (k, v) VALUES ('coin_scale_100x_v1', now()::text)`);
  }
  // One-time: award the "Davis Slayer" title to everyone who has already cleared the campaign
  // (own it + auto-equip if they aren't wearing a title yet). Runs once via a meta flag.
  const slayer = await pool.query(`SELECT 1 FROM doom_meta WHERE k = 'title_slayer_v2'`);
  if (slayer.rowCount === 0) {
    await pool.query(`
      UPDATE players SET
        owned = CASE WHEN ',' || owned || ',' LIKE '%,davisslayer,%' THEN owned
                     WHEN owned = '' THEN 'davisslayer' ELSE owned || ',davisslayer' END,
        title = COALESCE(title, 'davisslayer')
      WHERE id IN (SELECT pid FROM campaign_scores WHERE won = TRUE)
    `);
    await pool.query(`INSERT INTO doom_meta (k, v) VALUES ('title_slayer_v2', now()::text)`);
  }
  // One-time: award the "Flawless" title to anyone who has already scored a perfect campaign
  // run (the max CAMPAIGN_PERFECT_SCORE). Own it + auto-equip if they aren't wearing a title.
  const flawless = await pool.query(`SELECT 1 FROM doom_meta WHERE k = 'title_flawless_v1'`);
  if (flawless.rowCount === 0) {
    await pool.query(`
      UPDATE players SET
        owned = CASE WHEN ',' || owned || ',' LIKE '%,flawless,%' THEN owned
                     WHEN owned = '' THEN 'flawless' ELSE owned || ',flawless' END,
        title = COALESCE(title, 'flawless')
      WHERE id IN (SELECT pid FROM campaign_scores WHERE score >= ${CAMPAIGN_PERFECT_SCORE})
    `);
    await pool.query(`INSERT INTO doom_meta (k, v) VALUES ('title_flawless_v1', now()::text)`);
  }
  // One-time account recovery: the owner lost the guest "matty supreme" account (cleared
  // cookies) but still signs in via Google (mbeauvais@linksquares.com). Merge the orphaned
  // "matty supreme" row into that Google account and restore the name. Re-runs until it
  // succeeds (so a wrong email/name can be fixed and redeployed); flag is set only on success.
  const mergedMatty = await pool.query(`SELECT 1 FROM doom_meta WHERE k = 'merge_matty_supreme_v1'`);
  if (mergedMatty.rowCount === 0) {
    const tgt = await pool.query<{ id: string }>(
      `SELECT id FROM players WHERE email = 'mbeauvais@linksquares.com' LIMIT 1`,
    );
    const src = await pool.query<{ id: string }>(
      `SELECT id FROM players WHERE name = 'matty supreme' ORDER BY wins DESC, coins DESC LIMIT 1`,
    );
    const targetPid = tgt.rows[0]?.id;
    const sourcePid = src.rows[0]?.id;
    if (targetPid && sourcePid && targetPid !== sourcePid) {
      await migratePlayer(sourcePid, targetPid);
      await pool.query(`UPDATE players SET name = 'matty supreme' WHERE id = $1`, [targetPid]);
      await pool.query(`INSERT INTO doom_meta (k, v) VALUES ('merge_matty_supreme_v1', now()::text)`);
      console.log(`merged matty supreme (${sourcePid}) into Google account (${targetPid})`);
    } else {
      console.warn(`matty-supreme merge skipped — target(${targetPid ?? 'none'}) / source(${sourcePid ?? 'none'}); will retry next boot`);
    }
  }
  // One-time account merge: combine every guest "boam" account into the owner's Google
  // account (nmolloy@linksquares.com) — full merge (stats, coins, cosmetics, stocks, loan,
  // DOOM + campaign scores) — then label the Google account "boam". Re-runs until the
  // Google row exists (sign in once with Google first); the flag is set only on success.
  const mergedBoam = await pool.query(`SELECT 1 FROM doom_meta WHERE k = 'merge_boam_v1'`);
  if (mergedBoam.rowCount === 0) {
    const tgt = await pool.query<{ id: string }>(
      `SELECT id FROM players WHERE email = 'nmolloy@linksquares.com' ORDER BY wins DESC, coins DESC LIMIT 1`,
    );
    const targetPid = tgt.rows[0]?.id;
    if (targetPid) {
      const srcs = await pool.query<{ id: string }>(
        `SELECT id FROM players WHERE LOWER(TRIM(name)) = 'boam' AND id <> $1`,
        [targetPid],
      );
      for (const r of srcs.rows) await mergePlayerFull(r.id, targetPid);
      await pool.query(`UPDATE players SET name = 'boam' WHERE id = $1`, [targetPid]);
      await pool.query(`INSERT INTO doom_meta (k, v) VALUES ('merge_boam_v1', now()::text)`);
      console.log(`merged ${srcs.rowCount} 'boam' account(s) into Google account (${targetPid})`);
    } else {
      console.warn(`boam merge skipped — no player with email nmolloy@linksquares.com yet; will retry next boot`);
    }
  }
  // One-time: cap everyone's coins at 10 000. Anyone over the limit gets brought back down;
  // anyone below keeps their balance. Idempotent after it runs once.
  const coinCap = await pool.query(`SELECT 1 FROM doom_meta WHERE k = 'coin_cap_10k_v1'`);
  if (coinCap.rowCount === 0) {
    await pool.query(`UPDATE players SET coins = 10000 WHERE coins > 10000`);
    await pool.query(`INSERT INTO doom_meta (k, v) VALUES ('coin_cap_10k_v1', now()::text)`);
  }
  // One-time: hand tsong-mobile's entire net worth (coins + stock positions) to lasso, then
  // zero out tsong-mobile. Not a full account merge — stats, cosmetics and scores stay put.
  // Matching is deliberately tolerant: any account whose normalized name (lowercased, all
  // non-alphanumerics stripped) CONTAINS "tsong" / "lasso", picking the one with the highest
  // live net worth (coins + stock value) so we always grab the account that actually holds the
  // balance — never an empty namesake. Re-runs until both resolve.
  const tsongToLasso = await pool.query(`SELECT 1 FROM doom_meta WHERE k = 'tsong_to_lasso_v3'`);
  if (tsongToLasso.rowCount === 0) {
    // Richest (by live net worth) account whose normalized name contains `needle`.
    const richestContaining = async (needle: string): Promise<string | undefined> => {
      const r = await pool!.query<{ id: string }>(
        `SELECT p.id,
                p.coins + COALESCE(SUM(CASE WHEN sh.side = 'short'
                                            THEN 2 * sh.cost - sh.shares * sp.price
                                            ELSE sh.shares * sp.price END), 0) AS networth
           FROM players p
           LEFT JOIN stock_holdings sh ON sh.pid = p.id AND sh.shares > 0
           LEFT JOIN stock_prices sp ON sp.coin = sh.coin
          WHERE LOWER(REGEXP_REPLACE(p.name, '[^a-zA-Z0-9]', '', 'g')) LIKE $1
          GROUP BY p.id
          ORDER BY networth DESC
          LIMIT 1`,
        [`%${needle}%`],
      );
      return r.rows[0]?.id;
    };
    const srcPid = await richestContaining('tsong');
    const dstPid = await richestContaining('lasso');
    if (!srcPid || !dstPid) {
      // Log every player name so a failed match can be diagnosed from the boot log.
      const all = await pool.query<{ name: string }>(`SELECT name FROM players ORDER BY coins DESC LIMIT 60`);
      console.warn(`tsong→lasso names seen: ${all.rows.map((r) => JSON.stringify(r.name)).join(', ')}`);
    }
    if (srcPid && dstPid && srcPid !== dstPid) {
      // Coins: add tsong-mobile's balance to lasso, then zero the source.
      await pool.query(
        `UPDATE players SET coins = coins + (SELECT coins FROM players WHERE id = $1) WHERE id = $2`,
        [srcPid, dstPid],
      );
      await pool.query(`UPDATE players SET coins = 0 WHERE id = $1`, [srcPid]);
      // Stock positions: fold tsong-mobile's holdings into lasso's (merging matching sides),
      // then delete the source's rows.
      await pool.query(
        `INSERT INTO stock_holdings (pid, coin, side, shares, cost)
           SELECT $2, coin, side, shares, cost FROM stock_holdings WHERE pid = $1
         ON CONFLICT (pid, coin, side) DO UPDATE
           SET shares = stock_holdings.shares + EXCLUDED.shares,
               cost   = stock_holdings.cost   + EXCLUDED.cost`,
        [srcPid, dstPid],
      );
      await pool.query(`DELETE FROM stock_holdings WHERE pid = $1`, [srcPid]);
      await pool.query(`INSERT INTO doom_meta (k, v) VALUES ('tsong_to_lasso_v3', now()::text)`);
      console.log(`transferred tsong-mobile (${srcPid}) net worth to lasso (${dstPid})`);
    } else {
      console.warn(`tsong→lasso transfer skipped — src(${srcPid ?? 'none'}) / dst(${dstPid ?? 'none'}); will retry next boot`);
    }
  }
  // One-time: delete the account(s) named exactly "matt" (per request) — NOT "matty supreme" or any
  // other name. Matched on the normalized exact name so it can't catch a near-namesake. Removes the
  // player row plus its dependent rows across the economy/score tables. Gated so it runs once.
  const delMatt = await pool.query(`SELECT 1 FROM doom_meta WHERE k = 'delete_matt_v1'`);
  if (delMatt.rowCount === 0) {
    const victims = await pool.query<{ id: string }>(
      `SELECT id FROM players WHERE LOWER(TRIM(name)) = 'matt'`,
    );
    for (const v of victims.rows) {
      const pid = v.id;
      await pool.query(`DELETE FROM stock_holdings     WHERE pid = $1`, [pid]);
      await pool.query(`DELETE FROM loans              WHERE pid = $1`, [pid]);
      await pool.query(`DELETE FROM exclusive_instances WHERE owner_pid = $1`, [pid]);
      await pool.query(`DELETE FROM listings           WHERE seller_pid = $1`, [pid]);
      await pool.query(`DELETE FROM bounties           WHERE target_pid = $1`, [pid]);
      await pool.query(`DELETE FROM doom_scores        WHERE pid = $1`, [pid]);
      await pool.query(`DELETE FROM typedie_scores     WHERE pid = $1`, [pid]);
      await pool.query(`DELETE FROM campaign_scores    WHERE pid = $1`, [pid]);
      await pool.query(`DELETE FROM players            WHERE id  = $1`, [pid]);
      console.log(`deleted account 'matt' (${pid})`);
    }
    await pool.query(`INSERT INTO doom_meta (k, v) VALUES ('delete_matt_v1', now()::text)`);
  }
  // One-time (per request): wipe "the equalizer"'s debts and slap a 1,000,000-coin bounty on his
  // head. Matched on the normalized exact name. Runs once, but re-runs each boot until the account
  // actually exists — the flag is set only on success, so it survives a deploy before he's signed up.
  const equalizer = await pool.query(`SELECT 1 FROM doom_meta WHERE k = 'equalizer_bounty_v1'`);
  if (equalizer.rowCount === 0) {
    const marks = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM players WHERE LOWER(TRIM(name)) = 'the equalizer'`,
    );
    if (marks.rowCount) {
      for (const m of marks.rows) {
        await pool.query(`DELETE FROM loans WHERE pid = $1`, [m.id]);              // wipe his loans/debts
        await pool.query(
          `INSERT INTO bounties (target_pid, target_name, pot) VALUES ($1, $2, 1000000)
             ON CONFLICT (target_pid) DO UPDATE SET pot = 1000000, target_name = EXCLUDED.target_name`,
          [m.id, m.name],
        );
        console.log(`the equalizer (${m.id}): loans wiped, 1,000,000 bounty placed`);
      }
      await pool.query(`INSERT INTO doom_meta (k, v) VALUES ('equalizer_bounty_v1', now()::text)`);
    } else {
      console.warn(`equalizer bounty skipped — no player named 'the equalizer' yet; will retry next boot`);
    }
  }
  // One-time account consolidation: fold all duplicate accounts into the primary
  // "lasso" account (japonte@linksquares.com). Merges every per-player table AND
  // the doom_meta JSON blobs that embed a pid — the things mergePlayerFull() misses.
  const lassoDone = await pool.query(`SELECT 1 FROM doom_meta WHERE k = 'lasso_consolidation_v1'`);
  if (lassoDone.rowCount === 0) {
    const tgt = await pool.query<{ id: string }>(
      `SELECT id FROM players WHERE email = 'japonte@linksquares.com' ORDER BY id LIMIT 1`,
    );
    const targetPid = tgt.rows[0]?.id;
    if (targetPid) {
      const srcs = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM players
         WHERE LOWER(TRIM(name)) IN ('lasso', 'lasso - mobile', 'tsong - mobile', 'josiel')
           AND id <> $1`,
        [targetPid],
      );
      for (const src of srcs.rows) {
        const pid = src.id;
        await pool.query(`UPDATE exclusive_instances SET owner_pid = $1 WHERE owner_pid = $2`, [targetPid, pid]);
        await pool.query(`UPDATE listings SET seller_pid = $1, seller_name = 'lasso' WHERE seller_pid = $2`, [targetPid, pid]);
        await pool.query(
          `WITH moved AS (
             DELETE FROM bounties WHERE target_pid = $2 RETURNING pot
           )
           INSERT INTO bounties (target_pid, target_name, pot)
           SELECT $1, 'lasso', SUM(pot) FROM moved HAVING SUM(pot) IS NOT NULL
           ON CONFLICT (target_pid) DO UPDATE
             SET pot = bounties.pot + EXCLUDED.pot, target_name = 'lasso'`,
          [targetPid, pid],
        );
        await pool.query(
          `WITH moved AS (
             DELETE FROM fishing_scores WHERE pid = $2 RETURNING best_lb
           )
           INSERT INTO fishing_scores (pid, name, best_lb)
           SELECT $1, 'lasso', best_lb FROM moved
           ON CONFLICT (pid) DO UPDATE
             SET best_lb = GREATEST(fishing_scores.best_lb, EXCLUDED.best_lb), name = 'lasso'`,
          [targetPid, pid],
        );
        await pool.query(
          `WITH moved AS (
             DELETE FROM gh_scores WHERE pid = $2 RETURNING song, diff, score
           )
           INSERT INTO gh_scores (pid, song, diff, name, score)
           SELECT $1, song, diff, 'lasso', score FROM moved
           ON CONFLICT (pid, song, diff) DO UPDATE
             SET score = GREATEST(gh_scores.score, EXCLUDED.score), name = 'lasso'`,
          [targetPid, pid],
        );
        await pool.query(
          `WITH moved AS (
             DELETE FROM dungeon_opened WHERE pid = $2 RETURNING chest
           )
           INSERT INTO dungeon_opened (pid, chest)
           SELECT $1, chest FROM moved
           ON CONFLICT (pid, chest) DO NOTHING`,
          [targetPid, pid],
        );
        await pool.query(`UPDATE land_parcels SET owner_pid = $1, owner_name = 'lasso' WHERE owner_pid = $2`, [targetPid, pid]);
        await pool.query(
          `WITH moved AS (
             DELETE FROM netizen_challenges WHERE player_pid = $2 RETURNING netizen_pid, ts
           )
           INSERT INTO netizen_challenges (player_pid, netizen_pid, ts)
           SELECT $1, netizen_pid, ts FROM moved
           ON CONFLICT (player_pid, netizen_pid) DO NOTHING`,
          [targetPid, pid],
        );
        await pool.query(
          `WITH moved AS (
             DELETE FROM head_to_head WHERE player1 = $2 OR player2 = $2
             RETURNING
               CASE WHEN player1 = $2 THEN $1 ELSE player1 END AS a,
               CASE WHEN player2 = $2 THEN $1 ELSE player2 END AS b,
               p1_wins, p2_wins
           ),
           remapped AS (
             SELECT
               LEAST(a, b)    AS np1,
               GREATEST(a, b) AS np2,
               CASE WHEN a <= b THEN p1_wins ELSE p2_wins END AS w1,
               CASE WHEN a <= b THEN p2_wins ELSE p1_wins END AS w2
             FROM moved
             WHERE a <> b
           ),
           agg AS (
             SELECT np1, np2, SUM(w1) AS w1, SUM(w2) AS w2
             FROM remapped GROUP BY np1, np2
           )
           INSERT INTO head_to_head (player1, player2, p1_wins, p2_wins)
           SELECT np1, np2, w1, w2 FROM agg
           ON CONFLICT (player1, player2) DO UPDATE
             SET p1_wins = head_to_head.p1_wins + EXCLUDED.p1_wins,
                 p2_wins = head_to_head.p2_wins + EXCLUDED.p2_wins`,
          [targetPid, pid],
        );
        // doom_meta JSON blobs that embed this pid.
        const bondsRaw = await getMeta('bonds');
        if (bondsRaw) {
          const bonds: Array<{ pid: string; name: string; [k: string]: unknown }> = JSON.parse(bondsRaw);
          let changed = false;
          for (const b of bonds) {
            if (b.pid === pid) { b.pid = targetPid; b.name = 'lasso'; changed = true; }
          }
          if (changed) await setMeta('bonds', JSON.stringify(bonds));
        }
        const auctionRaw = await getMeta('auction');
        if (auctionRaw) {
          const auction: { highPid?: string; [k: string]: unknown } = JSON.parse(auctionRaw);
          if (auction && auction.highPid === pid) {
            auction.highPid = targetPid;
            await setMeta('auction', JSON.stringify(auction));
          }
        }
        await pool.query(`DELETE FROM doom_meta WHERE k = $1`, [`mtm:${pid}`]);
        // LAST: merge players row + the tables mergePlayerFull owns, then delete source row.
        await mergePlayerFull(pid, targetPid);
        console.log(`consolidated '${src.name}' (${pid}) into lasso (${targetPid})`);
      }
      await pool.query(`UPDATE players SET name = 'lasso' WHERE id = $1`, [targetPid]);
      await pool.query(`INSERT INTO doom_meta (k, v) VALUES ('lasso_consolidation_v1', now()::text)`);
      console.log(`lasso consolidation complete: ${srcs.rowCount} account(s) merged into ${targetPid}`);
    } else {
      console.warn(`lasso consolidation skipped — no player with email japonte@linksquares.com yet; will retry next boot`);
    }
  }
  // Robville land registry: one row per lot (the fixed WORLD_PARCELS set). owner_pid NULL = the
  // lot is bank-owned (buyable); `ask` is the owner's asking price when listed for sale, else NULL.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS land_parcels (
      id         TEXT PRIMARY KEY,
      owner_pid  TEXT,
      owner_name TEXT,
      ask        INTEGER,
      house      TEXT,
      updated_at BIGINT NOT NULL DEFAULT 0
    )
  `);
  // `house` (a HOUSE_KINDS id, or NULL for an empty lot) was added after the table first shipped.
  await pool.query(`ALTER TABLE land_parcels ADD COLUMN IF NOT EXISTS house TEXT`);
  // Seed a row for every lot so the buy txn can lock it FOR UPDATE. ON CONFLICT DO NOTHING keeps
  // existing ownership; lots added to the layout later start bank-owned.
  for (const p of WORLD_PARCELS) {
    await pool.query(`INSERT INTO land_parcels (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [p.id]);
  }
  await ensureNetizenChallengesTable();
  console.log('leaderboard DB ready');
}

export interface DoomScoreRow { name: string; round: number; }

// Record a DOOM run: keep only each player's best round for that mode.
export async function recordDoomScore(pid: string, name: string, coop: boolean, round: number): Promise<void> {
  if (!pool || !pid) return;
  await pool.query(
    `INSERT INTO doom_scores (pid, name, coop, round) VALUES ($1, $2, $3, $4)
       ON CONFLICT (pid, coop) DO UPDATE
       SET round = GREATEST(doom_scores.round, EXCLUDED.round), name = EXCLUDED.name`,
    [pid, name, coop, round],
  );
}

// Top rounds for each mode.
export async function getDoomLeaderboards(): Promise<{ solo: DoomScoreRow[]; coop: DoomScoreRow[] }> {
  if (!pool) return { solo: [], coop: [] };
  const fetchMode = async (coop: boolean): Promise<DoomScoreRow[]> => {
    const { rows } = await pool!.query(
      `SELECT name, round FROM doom_scores WHERE coop = $1 ORDER BY round DESC, name ASC LIMIT 10`,
      [coop],
    );
    return rows.map((r) => ({ name: r.name, round: r.round }));
  };
  return { solo: await fetchMode(false), coop: await fetchMode(true) };
}

export interface FishingScoreRow { name: string; lb: number; }

// Record a fishing catch: keep only each player's biggest (heaviest) fish ever landed.
export async function recordFishCatch(pid: string, name: string, lb: number): Promise<void> {
  if (!pool || !pid || !Number.isFinite(lb) || lb <= 0) return;
  await pool.query(
    `INSERT INTO fishing_scores (pid, name, best_lb) VALUES ($1, $2, $3)
       ON CONFLICT (pid) DO UPDATE
       SET best_lb = GREATEST(fishing_scores.best_lb, EXCLUDED.best_lb), name = EXCLUDED.name`,
    [pid, name, lb],
  );
}

// Bump a named counter in the meta table (used for the fountain's all-time wish count).
export async function bumpCounter(key: string): Promise<number> {
  if (!pool) return 0;
  const { rows } = await pool.query(
    `INSERT INTO meta (key, value) VALUES ($1, '1')
       ON CONFLICT (key) DO UPDATE SET value = ((meta.value)::bigint + 1)::text
       RETURNING value`,
    [key],
  );
  return Number(rows[0]?.value ?? 0);
}

export interface GhScoreRow { song: string; diff: string; name: string; score: number; }

// Record a Tsong Hero run: keep only each player's best score per song per difficulty.
export async function recordGhScore(pid: string, name: string, song: string, diff: string, score: number): Promise<void> {
  if (!pool || !pid || !Number.isInteger(score) || score <= 0) return;
  await pool.query(
    `INSERT INTO gh_scores (pid, song, diff, name, score) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (pid, song, diff) DO UPDATE
       SET score = GREATEST(gh_scores.score, EXCLUDED.score), name = EXCLUDED.name`,
    [pid, song, diff, name, score],
  );
}

// Top 5 per song per difficulty across all players.
export async function getGhLeaderboard(): Promise<GhScoreRow[]> {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT song, diff, name, score FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY song, diff ORDER BY score DESC, name ASC) AS rn
       FROM gh_scores
     ) t WHERE rn <= 5 ORDER BY song, diff, score DESC`,
  );
  return rows.map((r) => ({ song: r.song, diff: r.diff, name: r.name, score: Number(r.score) }));
}

// Biggest catches across all anglers (top N by best landed weight).
export async function getFishingLeaderboard(): Promise<FishingScoreRow[]> {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT name, best_lb FROM fishing_scores ORDER BY best_lb DESC, name ASC LIMIT 10`,
  );
  return rows.map((r) => ({ name: r.name, lb: Number(r.best_lb) }));
}

export interface TypeDieScoreRow { name: string; wave: number; }

// Record a "Type or Die" run for one participant: keep only their best wave reached.
export async function recordTypeDieScore(pid: string, name: string, wave: number): Promise<void> {
  if (!pool || !pid) return;
  await pool.query(
    `INSERT INTO typedie_scores (pid, name, wave) VALUES ($1, $2, $3)
       ON CONFLICT (pid) DO UPDATE
       SET wave = GREATEST(typedie_scores.wave, EXCLUDED.wave), name = EXCLUDED.name`,
    [pid, name, wave],
  );
}

// --- Nomic (the Parliament sub-game) persistence -------------------------------------------
// The whole game is a single JSON snapshot in row 1. Save on every change, load once on boot.
export async function loadNomic(): Promise<NomicSnapshot | null> {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT data FROM nomic_state WHERE id = 1`);
  if (!rows.length) return null;
  try { return JSON.parse(rows[0].data) as NomicSnapshot; } catch { return null; }
}

export async function saveNomic(snap: NomicSnapshot): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO nomic_state (id, data) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
    [JSON.stringify(snap)],
  );
}

// Seal a won season's final rulebook into the Hall of Rulebooks (idempotent on season number).
export async function archiveNomicSeason(season: number, winner: string, rules: unknown): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO nomic_hall (season, winner, rules, sealed_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (season) DO NOTHING`,
    [season, winner, JSON.stringify(rules), Date.now()],
  );
}

// Top waves reached, best per player.
export async function getTypeDieLeaderboard(): Promise<TypeDieScoreRow[]> {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT name, wave FROM typedie_scores ORDER BY wave DESC, name ASC LIMIT 10`,
  );
  return rows.map((r) => ({ name: r.name, wave: r.wave }));
}

// Record a campaign run: keep only each player's best arcade score (and the stage/won that
// went with it). A higher score replaces the row; ties keep the existing. Returns flags for
// the caller's coin bonuses: `firstClear` (first-ever full clear) and `firstPerfect` (first-ever
// flawless run — the max score of CAMPAIGN_PERFECT_SCORE).
export const CAMPAIGN_PERFECT_SCORE = 25000; // (25 points scored − 0 allowed) × 1000
export async function recordCampaignScore(pid: string, name: string, score: number, stage: number, won: boolean): Promise<{ firstClear: boolean; firstPerfect: boolean }> {
  if (!pool || !pid) return { firstClear: false, firstPerfect: false };
  const prior = await pool.query(`SELECT won, score FROM campaign_scores WHERE pid = $1`, [pid]);
  const alreadyWon = prior.rows.length ? Boolean(prior.rows[0].won) : false;
  const priorScore = prior.rows.length ? Number(prior.rows[0].score) : Number.NEGATIVE_INFINITY;
  await pool.query(
    `INSERT INTO campaign_scores (pid, name, score, stage, won) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (pid) DO UPDATE
       SET name = EXCLUDED.name,
           score = GREATEST(campaign_scores.score, EXCLUDED.score),
           stage = CASE WHEN EXCLUDED.score > campaign_scores.score THEN EXCLUDED.stage ELSE campaign_scores.stage END,
           won   = campaign_scores.won OR EXCLUDED.won`,
    [pid, name, Math.floor(score), Math.floor(stage), won],
  );
  return {
    firstClear: won && !alreadyWon,
    firstPerfect: won && score >= CAMPAIGN_PERFECT_SCORE && priorScore < CAMPAIGN_PERFECT_SCORE,
  };
}

// Top campaign arcade scores.
export async function getCampaignLeaderboard(): Promise<CampaignScoreRow[]> {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT name, score, stage, won FROM campaign_scores ORDER BY score DESC, name ASC LIMIT 10`,
  );
  return rows.map((r) => ({ name: r.name, score: r.score, stage: r.stage, won: r.won }));
}

export interface PlayerRef {
  pid: string;
  name: string;
}

const ELO_K = 32;
const ELO_DEFAULT = 500;

function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// Record a finished match: every player on the winning team gets a win, every player
// on the losing team a loss (a 1v1 is just the one-per-side case).
// ELO is calculated using team-average ratings and applied to each player individually.
export async function recordResult(winners: PlayerRef[], losers: PlayerRef[]): Promise<void> {
  if (!pool) return;

  const allPids = [...winners, ...losers].map((p) => p.pid);

  // Upsert all players so they exist before we read ELO. Each winner also earns 100 coins
  // (1 win reward × COIN_SCALE — the whole economy is scaled ×100).
  const now = Date.now();
  for (const w of winners) {
    await pool.query(
      `INSERT INTO players (id, name, wins, coins, last_played) VALUES ($1, $2, 1, 100, $3)
         ON CONFLICT (id) DO UPDATE SET wins = players.wins + 1, coins = players.coins + 100, name = EXCLUDED.name, last_played = EXCLUDED.last_played`,
      [w.pid, w.name, now],
    );
  }
  for (const l of losers) {
    await pool.query(
      `INSERT INTO players (id, name, losses, last_played) VALUES ($1, $2, 1, $3)
         ON CONFLICT (id) DO UPDATE SET losses = players.losses + 1, name = EXCLUDED.name, last_played = EXCLUDED.last_played`,
      [l.pid, l.name, now],
    );
  }

  // Fetch current ELO for all involved players.
  const { rows } = await pool.query<{ id: string; elo: number }>(
    `SELECT id, elo FROM players WHERE id = ANY($1)`,
    [allPids],
  );
  const eloMap = new Map(rows.map((r) => [r.id, r.elo]));
  const eloOf = (pid: string) => eloMap.get(pid) ?? ELO_DEFAULT;

  // Team average ELO for the expected-score calculation.
  const avgWinner = winners.reduce((s, p) => s + eloOf(p.pid), 0) / winners.length;
  const avgLoser  = losers.reduce((s, p) => s + eloOf(p.pid), 0) / losers.length;

  const eW = expectedScore(avgWinner, avgLoser);
  const eL = expectedScore(avgLoser, avgWinner);

  // Apply ELO delta to each player (same delta regardless of team size).
  for (const w of winners) {
    const newElo = Math.max(1, Math.round(eloOf(w.pid) + ELO_K * (1 - eW)));
    await pool.query(`UPDATE players SET elo = $2 WHERE id = $1`, [w.pid, newElo]);
  }
  for (const l of losers) {
    const newElo = Math.max(1, Math.round(eloOf(l.pid) + ELO_K * (0 - eL)));
    await pool.query(`UPDATE players SET elo = $2 WHERE id = $1`, [l.pid, newElo]);
  }

  // Head-to-head: for every winner↔loser pair, increment the winning player's
  // counter in the unordered pair row (player1 < player2 lexicographically).
  for (const w of winners) {
    for (const l of losers) {
      const [p1, p2] = w.pid < l.pid ? [w.pid, l.pid] : [l.pid, w.pid];
      const wIsP1 = w.pid === p1;
      await pool.query(
        `INSERT INTO head_to_head (player1, player2, p1_wins, p2_wins)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (player1, player2) DO UPDATE SET
             p1_wins = head_to_head.p1_wins + $3,
             p2_wins = head_to_head.p2_wins + $4`,
        [p1, p2, wIsP1 ? 1 : 0, wIsP1 ? 0 : 1],
      );
    }
  }
}

/** Update an existing player's display name (for renames). Returns rows changed. */
export async function updateName(id: string, name: string): Promise<number> {
  if (!pool) return 0;
  const res = await pool.query(`UPDATE players SET name = $2 WHERE id = $1`, [id, name]);
  return res.rowCount ?? 0;
}

// --- Wallet & cosmetics ---
export const DAILY_SPIN_MS = 24 * 60 * 60 * 1000; // a spin every 24 hours
export interface Wallet {
  coins: number;
  owned: string[]; // item ids the player owns
  hat: string | null; // equipped hat item id
  skin: string | null; // equipped skin item id
  trail: string | null; // equipped paddle-trail item id
  title: string | null; // equipped name-title item id
  song: string | null; // equipped theme-song item id
  car: string | null; // equipped car item id (driven in the World map)
  boat: string | null; // equipped boat item id (used on water; alongside a car)
  pet: string | null; // equipped pet item id (trails behind you in the World map)
  balltrail: string | null; // equipped ball trail cosmetic
  goalcelebr: string | null; // equipped goal celebration cosmetic
  exclusives: { id: string; serial: number; instanceId: number }[]; // owned scarce exclusives (per-instance)
  lastSpin: number; // epoch ms of the last daily spin (0 = never)
  bonusSpins: number; // free extra wheel spins (e.g. from winning a tournament)
}
const EMPTY_WALLET: Wallet = { coins: 0, owned: [], hat: null, skin: null, trail: null, title: null, song: null, car: null, boat: null, pet: null, balltrail: null, goalcelebr: null, exclusives: [], lastSpin: 0, bonusSpins: 0 };

function rowToWallet(r: { coins: number; owned: string; hat: string | null; skin: string | null; trail?: string | null; title?: string | null; song?: string | null; car?: string | null; boat?: string | null; pet?: string | null; balltrail?: string | null; goalcelebr?: string | null; last_spin?: string | number; bonus_spins?: number }): Wallet {
  return {
    coins: r.coins,
    owned: (r.owned || '').split(',').filter(Boolean),
    hat: r.hat ?? null,
    skin: r.skin ?? null,
    trail: r.trail ?? null,
    title: r.title ?? null,
    song: r.song ?? null,
    car: r.car ?? null,
    boat: r.boat ?? null,
    pet: r.pet ?? null,
    balltrail: r.balltrail ?? null,
    goalcelebr: r.goalcelebr ?? null,
    // Exclusives come from their own table, not the players row; callers using a RETURNING row
    // (equip/spend/etc.) leave this empty — only getWallet hydrates it (see below).
    exclusives: [],
    lastSpin: Number(r.last_spin ?? 0),
    bonusSpins: Number(r.bonus_spins ?? 0),
  };
}

/** Read a player's owned exclusive instances (item id + serial + instance id), one row per owned
 *  instance. The instance id lets the client list a specific instance on the marketplace. */
export async function getExclusives(pid: string): Promise<{ id: string; serial: number; instanceId: number }[]> {
  if (!pool || !pid) return [];
  const { rows } = await pool.query<{ id: number; item: string; serial: number }>(
    `SELECT id, item, serial FROM exclusive_instances
       WHERE owner_pid = $1 ORDER BY item, serial ASC`,
    [pid],
  );
  return rows.map((r) => ({ id: r.item, serial: Number(r.serial), instanceId: Number(r.id) }));
}

/** Read Elo + games-played for a set of players (for the betting odds model). Missing players
 *  (or no DB) simply aren't in the returned map — the caller treats them as neutral. */
export async function getElos(pids: string[]): Promise<Map<string, { elo: number; games: number }>> {
  const out = new Map<string, { elo: number; games: number }>();
  if (!pool || pids.length === 0) return out;
  const { rows } = await pool.query<{ id: string; elo: number; wins: number; losses: number }>(
    `SELECT id, elo, wins, losses FROM players WHERE id = ANY($1)`,
    [pids],
  );
  for (const r of rows) out.set(r.id, { elo: r.elo, games: r.wins + r.losses });
  return out;
}

/** Read a player's wallet (coins + owned items + equipped cosmetics + spin state). */
export async function getWallet(pid: string): Promise<Wallet> {
  if (!pool || !pid) return { ...EMPTY_WALLET };
  const { rows } = await pool.query(`SELECT coins, owned, hat, skin, trail, title, song, car, boat, pet, balltrail, goalcelebr, last_spin, bonus_spins FROM players WHERE id = $1`, [pid]);
  if (!rows.length) return { ...EMPTY_WALLET };
  const w = rowToWallet(rows[0]);
  w.exclusives = await getExclusives(pid); // hydrate owned scarce exclusives (their own table)
  return w;
}

/** Find a player by display name (case-insensitive), for tipping someone who isn't online.
 *  Names aren't unique, so pick the most established match — most wins, then richest. Returns
 *  the stable pid + the canonical stored name, or null if nobody by that name exists. */
export async function findPlayerByName(name: string): Promise<{ pid: string; name: string } | null> {
  if (!pool || !name.trim()) return null;
  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM players WHERE LOWER(name) = LOWER($1)
       ORDER BY wins DESC, coins DESC LIMIT 1`,
    [name.trim()],
  );
  return rows.length ? { pid: rows[0].id, name: rows[0].name } : null;
}

/** Give a player a free bonus wheel spin (tournament reward). */
export async function addBonusSpin(pid: string, name: string): Promise<void> {
  if (!pool || !pid) return;
  await pool.query(
    `INSERT INTO players (id, name, bonus_spins) VALUES ($1, $2, 1)
       ON CONFLICT (id) DO UPDATE SET bonus_spins = players.bonus_spins + 1, name = EXCLUDED.name`,
    [pid, name],
  );
}

/** Consume one bonus spin if available (atomic). Returns true if one was spent. */
export async function useBonusSpin(pid: string): Promise<boolean> {
  if (!pool || !pid) return false;
  const res = await pool.query(`UPDATE players SET bonus_spins = bonus_spins - 1 WHERE id = $1 AND bonus_spins > 0`, [pid]);
  return (res.rowCount ?? 0) > 0;
}

/** Atomically claim the daily spin: stamps last_spin=now only if 24h have passed. Returns
 *  true if the claim succeeded (caller then rolls + applies the reward). */
export async function claimSpin(pid: string, name: string, nowMs: number): Promise<boolean> {
  if (!pool || !pid) return false;
  await pool.query(
    `INSERT INTO players (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [pid, name],
  );
  const res = await pool.query(
    `UPDATE players SET last_spin = $2 WHERE id = $1 AND $2 - last_spin >= $3`,
    [pid, nowMs, DAILY_SPIN_MS],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Grant an item for free (daily-spin prize). No-op if already owned. Returns updated wallet. */
/** All Ruins chests this account has permanently opened (banked on past escapes). */
export async function getOpenedChests(pid: string): Promise<string[]> {
  if (!pool || !pid) return [];
  const { rows } = await pool.query<{ chest: string }>(`SELECT chest FROM dungeon_opened WHERE pid = $1`, [pid]);
  return rows.map((r) => r.chest);
}
/** Permanently bank a set of opened chests for an account (called on a clean dungeon escape). */
export async function addOpenedChests(pid: string, chests: string[]): Promise<void> {
  if (!pool || !pid || chests.length === 0) return;
  const values = chests.map((_, i) => `($1, $${i + 2})`).join(',');
  await pool.query(`INSERT INTO dungeon_opened (pid, chest) VALUES ${values} ON CONFLICT DO NOTHING`, [pid, ...chests]);
}

export async function grantItem(pid: string, _name: string, item: string): Promise<Wallet | null> {
  if (!pool || !pid) return null;
  // ensure the player row exists, so the grant can't silently no-op for a not-yet-persisted player.
  // Keep the existing name if no (or empty) name is passed — granting an item must never rename a player.
  await pool.query(
    `INSERT INTO players (id, name) VALUES ($1, COALESCE(NULLIF($2, ''), $1))
       ON CONFLICT (id) DO UPDATE SET name = COALESCE(NULLIF($2, ''), players.name)`,
    [pid, _name],
  );
  const cur = await getWallet(pid);
  if (cur.owned.includes(item)) return cur;
  const owned = [...cur.owned, item].join(',');
  const { rows } = await pool.query(
    `UPDATE players SET owned = $2 WHERE id = $1 RETURNING coins, owned, hat, skin, trail, title, song, car, last_spin`,
    [pid, owned],
  );
  return rows.length ? rowToWallet(rows[0]) : null;
}

/** Award a title (achievement reward, e.g. clearing the campaign): add it to `owned` and
 *  auto-equip it only if the player isn't already wearing a title. Returns updated wallet. */
export async function awardTitle(pid: string, name: string, title: string): Promise<Wallet | null> {
  if (!pool || !pid) return null;
  await pool.query(
    `INSERT INTO players (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [pid, name],
  );
  const { rows } = await pool.query(
    `UPDATE players SET
       owned = CASE WHEN ',' || owned || ',' LIKE '%,' || $2 || ',%' THEN owned
                    WHEN owned = '' THEN $2 ELSE owned || ',' || $2 END,
       title = COALESCE(title, $2)
     WHERE id = $1
     RETURNING coins, owned, hat, skin, trail, title, song, car`,
    [pid, title],
  );
  return rows.length ? rowToWallet(rows[0]) : null;
}

/** Buy an item: deducts the price and adds it to `owned` (no-op if already owned or too poor).
 *  Returns the updated wallet (or null if the purchase didn't happen). */
export async function buyItem(pid: string, name: string, item: string, price: number): Promise<Wallet | null> {
  if (!pool || !pid) return null;
  // Ensure the row exists, then attempt the purchase atomically-ish.
  await pool.query(
    `INSERT INTO players (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
    [pid, name],
  );
  const cur = await getWallet(pid);
  if (cur.owned.includes(item) || cur.coins < price) return null;
  const owned = [...cur.owned, item].join(',');
  const { rows } = await pool.query(
    `UPDATE players SET coins = coins - $2, owned = $3 WHERE id = $1 AND coins >= $2
       RETURNING coins, owned, hat, skin, trail, title, song, car`,
    [pid, price, owned],
  );
  return rows.length ? rowToWallet(rows[0]) : null;
}

/** Equip (or unequip with item=null) a cosmetic in a slot. Only equips owned items. */
export async function equipItem(pid: string, slot: 'hat' | 'skin' | 'trail' | 'balltrail' | 'goalcelebr' | 'title' | 'song' | 'car' | 'boat' | 'pet', item: string | null): Promise<Wallet | null> {
  if (!pool || !pid) return null;
  const cur = await getWallet(pid);
  // Ownership check: a scarce exclusive isn't in the `owned` CSV — verify it via the per-instance
  // ledger instead. A regular cosmetic must be in `owned` as before.
  if (item !== null) {
    const owns = isExclusive(item)
      ? cur.exclusives.some((e) => e.id === item)
      : cur.owned.includes(item);
    if (!owns) return null; // can't equip what you don't own
  }
  const col = slot === 'hat' ? 'hat' : slot === 'skin' ? 'skin' : slot === 'trail' ? 'trail' : slot === 'balltrail' ? 'balltrail' : slot === 'goalcelebr' ? 'goalcelebr' : slot === 'song' ? 'song' : slot === 'car' ? 'car' : slot === 'boat' ? 'boat' : slot === 'pet' ? 'pet' : 'title';
  const { rows } = await pool.query(
    `UPDATE players SET ${col} = $2 WHERE id = $1 RETURNING coins, owned, hat, skin, trail, title, song, car, boat, pet, balltrail, goalcelebr`,
    [pid, item],
  );
  return rows.length ? rowToWallet(rows[0]) : null;
}

/** Spend coins (e.g. escrow a bet). Fails — returns null — if the player can't afford it,
 *  so callers must NOT proceed when null is returned. */
export async function spendCoins(pid: string, amount: number): Promise<Wallet | null> {
  if (!pool || !pid || amount <= 0) return null;
  const { rows } = await pool.query(
    `UPDATE players SET coins = coins - $2 WHERE id = $1 AND coins >= $2
       RETURNING coins, owned, hat, skin, trail, title, song, car`,
    [pid, amount],
  );
  return rows.length ? rowToWallet(rows[0]) : null;
}

/** Add (or subtract) coins for a player; used for gambling payouts/refunds. Returns new wallet. */
export async function addCoins(pid: string, name: string, delta: number): Promise<Wallet | null> {
  if (!pool || !pid) return null;
  const { rows } = await pool.query(
    `INSERT INTO players (id, name, coins) VALUES ($1, COALESCE(NULLIF($2, ''), $1), GREATEST(0, $3))
       ON CONFLICT (id) DO UPDATE SET coins = GREATEST(0, players.coins + $3), name = COALESCE(NULLIF($2, ''), players.name)
       RETURNING coins, owned, hat, skin, trail, title, song, car`,
    [pid, name, delta],
  );
  return rows.length ? rowToWallet(rows[0]) : null;
}

/** Is this player currently locked in the jail? (Persisted so a relog can't escape it.) */
export async function getJailed(pid: string): Promise<boolean> {
  if (!pool || !pid) return false;
  const { rows } = await pool.query(`SELECT jailed FROM players WHERE id = $1`, [pid]);
  return rows.length ? !!rows[0].jailed : false;
}

/** Set/clear a player's jailed flag (drunk-drive lockup / bail release). */
export async function setJailed(pid: string, jailed: boolean): Promise<void> {
  if (!pool || !pid) return;
  await pool.query(
    `INSERT INTO players (id, name, jailed) VALUES ($1, $1, $2)
       ON CONFLICT (id) DO UPDATE SET jailed = $2`,
    [pid, jailed],
  );
}

/** Every account holding a positive coin balance, richest first — the input to the daily
 *  progressive wealth-tax sweep. Liquid coins only (stocks aren't seized). */
export async function getTaxablePlayers(): Promise<Array<{ pid: string; name: string; coins: number }>> {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT id, name, coins FROM players WHERE coins > 0 ORDER BY coins DESC`,
  );
  return rows.map((r) => ({ pid: r.id, name: String(r.name), coins: Number(r.coins) }));
}

/** Full wealth assessment for the daily sweep: liquid coins, current stock-position market value
 *  (longs = shares×price; shorts = 2·cost − shares×price, valued at the DB's saved prices), total
 *  net worth, and last-activity timestamp. Feeds the wealth tax, mark-to-market capital-gains tax,
 *  and idle decay in one query. */
export async function getAssessableWealth(): Promise<Array<{ pid: string; name: string; coins: number; posValue: number; netWorth: number; lastPlayed: number }>> {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT p.id AS pid, p.name, p.coins, COALESCE(p.last_played, 0) AS last_played,
            COALESCE(h.val, 0) AS pos_value,
            p.coins + COALESCE(h.val, 0) - COALESCE(l.owed, 0) AS net
       FROM players p
       LEFT JOIN (
         SELECT sh.pid,
                SUM(CASE WHEN sh.side = 'short' THEN 2 * sh.cost - sh.shares * sp.price
                         ELSE sh.shares * sp.price END) AS val
           FROM stock_holdings sh JOIN stock_prices sp ON sp.coin = sh.coin
          WHERE sh.shares > 0 GROUP BY sh.pid
       ) h ON h.pid = p.id
       LEFT JOIN loans l ON l.pid = p.id
      WHERE p.coins <> 0 OR h.val IS NOT NULL`,
  );
  return rows.map((r) => ({
    pid: r.pid, name: String(r.name), coins: Number(r.coins) || 0,
    posValue: Math.max(0, Number(r.pos_value) || 0), netWorth: Number(r.net) || 0,
    lastPlayed: Number(r.last_played) || 0,
  }));
}

/** Stamp a player's last-activity time (any money-touching action), so idle decay only ever hits
 *  genuinely dormant accounts. Best-effort, fire-and-forget. */
export async function stampActivity(pid: string): Promise<void> {
  if (!pool || !pid) return;
  await pool.query(`UPDATE players SET last_played = $2 WHERE id = $1`, [pid, Date.now()]);
}

/** Top-5 net-worth concentration: the sum of the five richest net worths, the total across all
 *  positive net worths, and the count of positive-net players. */
export async function getNetWorthConcentration(): Promise<{ top5: number; total: number; count: number }> {
  if (!pool) return { top5: 0, total: 0, count: 0 };
  const { rows } = await pool.query<{ top5: string; total: string; count: string }>(
    `WITH nw AS (
       SELECT p.coins + COALESCE(h.val, 0) - COALESCE(l.owed, 0) AS net
         FROM players p
         LEFT JOIN (
           SELECT sh.pid, SUM(CASE WHEN sh.side='short' THEN 2*sh.cost - sh.shares*sp.price ELSE sh.shares*sp.price END) AS val
             FROM stock_holdings sh JOIN stock_prices sp ON sp.coin=sh.coin WHERE sh.shares>0 GROUP BY sh.pid
         ) h ON h.pid = p.id
         LEFT JOIN loans l ON l.pid = p.id
     )
     SELECT (SELECT COALESCE(SUM(net),0) FROM nw WHERE net > 0) AS total,
            (SELECT COALESCE(SUM(net),0) FROM (SELECT net FROM nw WHERE net > 0 ORDER BY net DESC LIMIT 5) t) AS top5,
            (SELECT COUNT(*) FROM nw WHERE net > 0) AS count`,
  );
  return { top5: Number(rows[0]?.top5 ?? 0), total: Number(rows[0]?.total ?? 0), count: Number(rows[0]?.count ?? 0) };
}

/** Players active since `sinceMs` (last_played) — the recipients of Fed stimulus checks. */
export async function getActivePlayers(sinceMs: number): Promise<Array<{ pid: string; name: string }>> {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT id, name FROM players WHERE COALESCE(last_played, 0) >= $1`, [sinceMs],
  );
  return rows.map((r) => ({ pid: r.id, name: String(r.name) }));
}

// --- Bounties ---

/** Add `amount` coins to the bounty on `targetPid` (creating it if none). Returns the new pot. */
export async function addBounty(targetPid: string, targetName: string, amount: number): Promise<number> {
  if (!pool || !targetPid || amount <= 0) return 0;
  const { rows } = await pool.query(
    `INSERT INTO bounties (target_pid, target_name, pot) VALUES ($1, $2, $3)
       ON CONFLICT (target_pid) DO UPDATE SET pot = bounties.pot + $3, target_name = EXCLUDED.target_name
       RETURNING pot`,
    [targetPid, targetName, amount],
  );
  return rows.length ? Number(rows[0].pot) : 0;
}

/** The current bounty pot on a player (0 if none). */
export async function getBountyOn(pid: string): Promise<number> {
  if (!pool || !pid) return 0;
  const { rows } = await pool.query(`SELECT pot FROM bounties WHERE target_pid = $1`, [pid]);
  return rows.length ? Number(rows[0].pot) : 0;
}

/** Delete the bounty on a player, returning the pot that was riding on them (0 if none). */
export async function clearBounty(pid: string): Promise<number> {
  if (!pool || !pid) return 0;
  const { rows } = await pool.query(`DELETE FROM bounties WHERE target_pid = $1 RETURNING pot`, [pid]);
  return rows.length ? Number(rows[0].pot) : 0;
}

/** Every active bounty, biggest pot first — for the board. */
export async function getBounties(): Promise<{ pid: string; name: string; pot: number }[]> {
  if (!pool) return [];
  const { rows } = await pool.query(`SELECT target_pid, target_name, pot FROM bounties WHERE pot > 0 ORDER BY pot DESC`);
  return rows.map((r) => ({ pid: r.target_pid, name: r.target_name, pot: Number(r.pot) }));
}

/** Merge a guest UUID account into a Google account: add stats, transfer cosmetics,
 *  then delete the old row. No-op if the pids are the same or oldPid doesn't exist. */
export async function migratePlayer(oldPid: string, newPid: string): Promise<void> {
  if (!pool || !oldPid || !newPid || oldPid === newPid) return;
  const { rows } = await pool.query<{ wins: number; losses: number; elo: number; coins: number; owned: string; hat: string | null; skin: string | null; trail: string | null; title: string | null }>(
    `SELECT wins, losses, elo, coins, owned, hat, skin, trail, title FROM players WHERE id = $1`,
    [oldPid],
  );
  if (!rows.length) return; // nothing to migrate
  const old = rows[0];
  // Merge: add wins/losses/coins; take the higher ELO; union owned items; keep the target's
  // equipped cosmetics, falling back to the old account's for any slot the target hasn't set.
  await pool.query(
    `UPDATE players SET
       wins   = wins   + $2,
       losses = losses + $3,
       elo    = GREATEST(elo, $4),
       coins  = coins  + $5,
       owned  = CASE WHEN owned = '' THEN $6 ELSE
                  CASE WHEN $6 = '' THEN owned ELSE owned || ',' || $6 END
                END,
       hat    = COALESCE(hat, $7),
       skin   = COALESCE(skin, $8),
       trail  = COALESCE(trail, $9),
       title  = COALESCE(title, $10)
     WHERE id = $1`,
    [newPid, old.wins, old.losses, old.elo, old.coins, old.owned, old.hat, old.skin, old.trail, old.title],
  );
  // Transfer stock_holdings from old → new, merging into any existing positions.
  await pool.query(
    `INSERT INTO stock_holdings (pid, coin, side, shares, cost)
       SELECT $2, coin, side, shares, cost FROM stock_holdings WHERE pid = $1
       ON CONFLICT (pid, coin, side) DO UPDATE
         SET shares = stock_holdings.shares + EXCLUDED.shares,
             cost   = stock_holdings.cost   + EXCLUDED.cost`,
    [oldPid, newPid],
  );
  await pool.query(`DELETE FROM stock_holdings WHERE pid = $1`, [oldPid]);
  // Transfer any open loan too.
  await pool.query(
    `INSERT INTO loans (pid, amount, owed, due_at)
       SELECT $2, amount, owed, due_at FROM loans WHERE pid = $1
       ON CONFLICT (pid) DO UPDATE SET amount = EXCLUDED.amount, owed = EXCLUDED.owed, due_at = EXCLUDED.due_at`,
    [oldPid, newPid],
  );
  await pool.query(`DELETE FROM loans WHERE pid = $1`, [oldPid]);
  await pool.query(`DELETE FROM players WHERE id = $1`, [oldPid]);
}

/** Full account merge for combining duplicate accounts: reassigns every per-player row
 *  (stock positions, loan, DOOM + campaign scores) from oldPid to newPid — combining on
 *  conflicts so nothing is double-counted — then folds the players row in via migratePlayer
 *  (stats/coins/cosmetics) and deletes the old row. No-op if the pids match. */
export async function mergePlayerFull(oldPid: string, newPid: string): Promise<void> {
  if (!pool || !oldPid || !newPid || oldPid === newPid) return;
  // Stock positions: pool shares + cost basis into any existing holding of the same coin+side.
  await pool.query(
    `INSERT INTO stock_holdings (pid, coin, side, shares, cost)
       SELECT $2, coin, side, shares, cost FROM stock_holdings WHERE pid = $1
       ON CONFLICT (pid, coin, side) DO UPDATE
         SET shares = stock_holdings.shares + EXCLUDED.shares,
             cost   = stock_holdings.cost   + EXCLUDED.cost`,
    [oldPid, newPid],
  );
  await pool.query(`DELETE FROM stock_holdings WHERE pid = $1`, [oldPid]);
  // Loan: only one open loan per player, so move the source's only if the target has none;
  // otherwise the target keeps its own and the source's is dropped.
  await pool.query(
    `INSERT INTO loans (pid, amount, owed, due_at)
       SELECT $2, amount, owed, due_at FROM loans WHERE pid = $1
       ON CONFLICT (pid) DO NOTHING`,
    [oldPid, newPid],
  );
  await pool.query(`DELETE FROM loans WHERE pid = $1`, [oldPid]);
  // DOOM high scores: keep the best round per mode. Co-op rows are team-keyed ("team:%"),
  // not per-player, so only the source's solo row moves.
  await pool.query(
    `INSERT INTO doom_scores (pid, name, coop, round)
       SELECT $2, name, coop, round FROM doom_scores WHERE pid = $1
       ON CONFLICT (pid, coop) DO UPDATE
         SET round = GREATEST(doom_scores.round, EXCLUDED.round), name = EXCLUDED.name`,
    [oldPid, newPid],
  );
  await pool.query(`DELETE FROM doom_scores WHERE pid = $1`, [oldPid]);
  // "Type or Die": keep the best wave reached.
  await pool.query(
    `INSERT INTO typedie_scores (pid, name, wave)
       SELECT $2, name, wave FROM typedie_scores WHERE pid = $1
       ON CONFLICT (pid) DO UPDATE
         SET wave = GREATEST(typedie_scores.wave, EXCLUDED.wave), name = EXCLUDED.name`,
    [oldPid, newPid],
  );
  await pool.query(`DELETE FROM typedie_scores WHERE pid = $1`, [oldPid]);
  // Campaign arcade: keep the best score (and the stage/won that went with it).
  await pool.query(
    `INSERT INTO campaign_scores (pid, name, score, stage, won)
       SELECT $2, name, score, stage, won FROM campaign_scores WHERE pid = $1
       ON CONFLICT (pid) DO UPDATE
         SET name  = EXCLUDED.name,
             score = GREATEST(campaign_scores.score, EXCLUDED.score),
             stage = CASE WHEN EXCLUDED.score > campaign_scores.score THEN EXCLUDED.stage ELSE campaign_scores.stage END,
             won   = campaign_scores.won OR EXCLUDED.won`,
    [oldPid, newPid],
  );
  await pool.query(`DELETE FROM campaign_scores WHERE pid = $1`, [oldPid]);
  // Finally fold the players row (wins/losses/elo/coins/owned + equipped cosmetics) in and
  // delete the old row.
  await migratePlayer(oldPid, newPid);
}

/** Create or update a player row — used by the OAuth callback to ensure the row exists. */
export async function upsertPlayer(pid: string, name: string, email?: string): Promise<void> {
  if (!pool || !pid) return;
  await pool.query(
    `INSERT INTO players (id, name, email) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name,
         email = COALESCE(EXCLUDED.email, players.email)`,
    [pid, name, email ?? null],
  );
}

// --- User settings (synced across devices for signed-in players) ---

/** Read a player's stored settings blob (key→value strings). Empty object if none/unparseable. */
export async function getPrefs(pid: string): Promise<Record<string, string>> {
  if (!pool || !pid) return {};
  const { rows } = await pool.query(`SELECT prefs FROM players WHERE id = $1`, [pid]);
  if (!rows.length || !rows[0].prefs) return {};
  try {
    const o = JSON.parse(rows[0].prefs as string);
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, string>) : {};
  } catch { return {}; }
}

/** Merge `patch` into a player's stored settings (creating the row if needed). Partial updates
 *  don't clobber keys they omit. `name` seeds a brand-new row (players.name is NOT NULL). */
export async function savePrefs(pid: string, name: string, patch: Record<string, string>): Promise<void> {
  if (!pool || !pid) return;
  const merged = { ...(await getPrefs(pid)), ...patch };
  await pool.query(
    `INSERT INTO players (id, name, prefs) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET prefs = EXCLUDED.prefs`,
    [pid, (name || 'anon').slice(0, 20), JSON.stringify(merged)],
  );
}

// --- Stock market ---
export interface Holding { coin: string; side: StockSide; shares: number; cost: number; openedAt: number; }

/** Read all of a player's open stock positions (longs and shorts). `openedAt` stamps the
 *  fast-sell-tax window so clients can show a countdown to tax-free. */
export async function getHoldings(pid: string): Promise<Holding[]> {
  if (!pool || !pid) return [];
  const { rows } = await pool.query(`SELECT coin, side, shares, cost, opened_at FROM stock_holdings WHERE pid = $1 AND shares > 0`, [pid]);
  return rows.map((r) => ({ coin: r.coin, side: (r.side === 'short' ? 'short' : 'long') as StockSide, shares: Number(r.shares), cost: Number(r.cost), openedAt: Number(r.opened_at ?? 0) }));
}

/** Open (or add to) a position in `coin` at the given price: escrows `amount` coins (fails —
 *  returns null — if the player can't afford it) and pools amount/price shares into the
 *  long or short position. Both sides escrow coins the same way; they differ only at cash-out
 *  (see cashOutStock / positionWorth). Returns the updated wallet on success. */
export async function investStock(pid: string, _name: string, coin: string, amount: number, price: number, side: StockSide = 'long', nowMs: number = Date.now()): Promise<Wallet | null> {
  if (!pool || !pid || amount <= 0 || !(price > 0)) return null;
  // Escrow the coins first; bail out untouched if the balance isn't there.
  const wallet = await spendCoins(pid, amount);
  if (!wallet) return null;
  const shares = amount / price;
  // `opened_at` stamps the fast-sell-tax window. Adding to an existing position resets it to now,
  // so topping up restarts the 60s clock for the whole (re-averaged) position — keeps the tax
  // simple and unexploitable.
  await pool.query(
    `INSERT INTO stock_holdings (pid, coin, side, shares, cost, opened_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (pid, coin, side) DO UPDATE
       SET shares = stock_holdings.shares + EXCLUDED.shares,
           cost   = stock_holdings.cost   + EXCLUDED.cost,
           opened_at = EXCLUDED.opened_at`,
    [pid, coin, side, shares, Math.floor(amount), nowMs],
  );
  return wallet;
}

/** Close the entire long or short position in `coin` at the given price and delete the holding,
 *  WITHOUT crediting the wallet. Returns the raw position numbers so the caller (lobby) can split
 *  the payout into a House-backed principal refund + a House-funded gain + the fast-sell tax, all
 *  to keep coins conserved. `cost` is the cost basis (House-held escrow), `payout` is
 *  round(positionWorth) at the close price, `openedAt` stamps the fast-sell window. Returns null
 *  when the player holds nothing on that side. */
// Close a position — all of it (fraction >= 1, the default) or just a slice (0 < fraction < 1, a
// partial cash-out). A partial close splits the cost basis proportionally and UPDATEs the row with
// the remainder (keeping its original opened_at, so the held-shares' fast-sell timer doesn't reset);
// the returned cost/payout describe ONLY the slice that was closed. Never deletes data on a partial.
export async function closePosition(pid: string, coin: string, price: number, side: StockSide = 'long', fraction = 1): Promise<{ cost: number; payout: number; openedAt: number } | null> {
  if (!pool || !pid) return null;
  const { rows } = await pool.query(`SELECT shares, cost, opened_at FROM stock_holdings WHERE pid = $1 AND coin = $2 AND side = $3`, [pid, coin, side]);
  if (!rows.length || Number(rows[0].shares) <= 0) return null;
  const shares = Number(rows[0].shares);
  const cost = Number(rows[0].cost);
  const openedAt = Number(rows[0].opened_at ?? 0);
  const f = Math.min(1, Math.max(0, fraction));
  // Slice to close. Treat ~full (or a remainder that would be dust) as a full close, to avoid
  // leaving an un-closeable sliver behind.
  const closeShares = shares * f;
  const closeCost = Math.round(cost * f);
  const remShares = shares - closeShares;
  const remCost = cost - closeCost;
  const fullClose = f >= 0.999 || remShares <= 1e-9 || remCost <= 0 || closeShares <= 0 || closeCost <= 0;
  if (fullClose) {
    const payout = Math.round(positionWorth(side, shares, cost, price));
    await pool.query(`DELETE FROM stock_holdings WHERE pid = $1 AND coin = $2 AND side = $3`, [pid, coin, side]);
    return { cost, payout, openedAt };
  }
  const payout = Math.round(positionWorth(side, closeShares, closeCost, price));
  await pool.query(`UPDATE stock_holdings SET shares = $4, cost = $5 WHERE pid = $1 AND coin = $2 AND side = $3`, [pid, coin, side, remShares, remCost]);
  return { cost: closeCost, payout, openedAt };
}

// --- Economy Overhaul: exclusives (loot boxes) + player marketplace ---

/** Atomically mint one exclusive for `pid` if the global cap isn't reached. The conditional
 *  UPDATE on exclusive_supply is the ONLY mint path; rowCount === 0 means the item is capped out
 *  (caller must DEGRADE to a coin payout — never over-mint). On success the new serial = the
 *  incremented mint count, and an instance row is inserted. Returns the serial, or null when
 *  capped out / no DB. */
export async function mintExclusive(pid: string, item: string, cap: number, nowMs: number = Date.now()): Promise<number | null> {
  if (!pool || !pid) return null;
  const gate = await pool.query<{ minted: number }>(
    `UPDATE exclusive_supply SET minted = minted + 1 WHERE item = $1 AND minted < $2 RETURNING minted`,
    [item, cap],
  );
  if (gate.rowCount === 0) return null; // capped out — caller degrades to coins
  const serial = Number(gate.rows[0].minted);
  await pool.query(
    `INSERT INTO exclusive_instances (item, owner_pid, minted_at, origin, serial) VALUES ($1, $2, $3, 'lootbox', $4)`,
    [item, pid, nowMs, serial],
  );
  return serial;
}

/** How many of each exclusive have been minted globally (item → minted count). */
export async function getExclusiveSupply(): Promise<Record<string, number>> {
  if (!pool) return {};
  const { rows } = await pool.query<{ item: string; minted: number }>(`SELECT item, minted FROM exclusive_supply`);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.item] = Number(r.minted);
  return out;
}

/** The last-sale price map (item → last marketplace sale price), stored as one JSON KV row. */
export async function getExclusiveLastSale(): Promise<Record<string, number>> {
  if (!pool) return {};
  try {
    const { rows } = await pool.query(`SELECT v FROM doom_meta WHERE k = 'exclusive_last_sale'`);
    if (!rows.length) return {};
    const parsed = JSON.parse(rows[0].v);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
async function setExclusiveLastSale(item: string, price: number): Promise<void> {
  if (!pool) return;
  const cur = await getExclusiveLastSale();
  cur[item] = price;
  await pool.query(
    `INSERT INTO doom_meta (k, v) VALUES ('exclusive_last_sale', $1)
       ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [JSON.stringify(cur)],
  );
}

/** List one owned exclusive instance for sale at `ask` coins. Verifies the seller owns the
 *  instance and it isn't already listed (UNIQUE on instance_id). Returns true on success. */
export async function listExclusive(instanceId: number, sellerPid: string, sellerName: string, ask: number, nowMs: number = Date.now()): Promise<boolean> {
  if (!pool || !sellerPid || !(ask > 0)) return false;
  // Ownership guard: the instance must exist and belong to the seller.
  const own = await pool.query(`SELECT item FROM exclusive_instances WHERE id = $1 AND owner_pid = $2`, [instanceId, sellerPid]);
  if (!own.rowCount) return false;
  const item = own.rows[0].item as string;
  try {
    await pool.query(
      `INSERT INTO listings (instance_id, item, seller_pid, seller_name, ask, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [instanceId, item, sellerPid, sellerName, Math.floor(ask), nowMs],
    );
    return true;
  } catch {
    return false; // already listed (UNIQUE violation) or other constraint
  }
}

/** Cancel one of the seller's own listings. Returns true if a row was removed. */
export async function cancelListing(listingId: number, sellerPid: string): Promise<boolean> {
  if (!pool || !sellerPid) return false;
  const res = await pool.query(`DELETE FROM listings WHERE id = $1 AND seller_pid = $2`, [listingId, sellerPid]);
  return (res.rowCount ?? 0) > 0;
}

export interface MarketListing { id: number; instanceId: number; item: string; sellerPid: string; sellerName: string; ask: number; }

/** Every open listing, ascending ask (the floor per item is the first one). */
export async function getMarketListings(): Promise<MarketListing[]> {
  if (!pool) return [];
  const { rows } = await pool.query(`SELECT id, instance_id, item, seller_pid, seller_name, ask FROM listings ORDER BY item, ask ASC`);
  return rows.map((r) => ({ id: Number(r.id), instanceId: Number(r.instance_id), item: r.item, sellerPid: r.seller_pid, sellerName: r.seller_name, ask: Number(r.ask) }));
}

/** Buy the lowest-ask listing of `item` in one transaction. Conservation: buyer −ask,
 *  seller +(ask − commission), House +commission (net zero). Auto-unequips the instance from the
 *  seller if they had it on. Returns the sale price + parties on success, or a reason on failure. */
export async function buyLowestAsk(item: string, buyerPid: string, _buyerName: string, commissionRate: number = 0.10): Promise<
  | { ok: true; ask: number; commission: number; sellerPid: string; sellerName: string; instanceId: number }
  | { ok: false; reason: 'none' | 'self' | 'afford' | 'nodb' }
> {
  if (!pool || !buyerPid) return { ok: false, reason: 'nodb' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the lowest ask so two concurrent buyers can't take the same listing.
    const sel = await client.query(
      `SELECT id, instance_id, seller_pid, seller_name, ask FROM listings WHERE item = $1 ORDER BY ask ASC LIMIT 1 FOR UPDATE`,
      [item],
    );
    if (!sel.rowCount) { await client.query('ROLLBACK'); return { ok: false, reason: 'none' }; }
    const listing = sel.rows[0];
    const sellerPid = listing.seller_pid as string;
    const sellerName = listing.seller_name as string;
    const ask = Number(listing.ask);
    const instanceId = Number(listing.instance_id);
    if (sellerPid === buyerPid) { await client.query('ROLLBACK'); return { ok: false, reason: 'self' }; }
    // Charge the buyer atomically (rowCount 0 => can't afford).
    const pay = await client.query(
      `UPDATE players SET coins = coins - $2 WHERE id = $1 AND coins >= $2`,
      [buyerPid, ask],
    );
    if (!pay.rowCount) { await client.query('ROLLBACK'); return { ok: false, reason: 'afford' }; }
    const commission = Math.ceil(ask * commissionRate);
    const sellerGets = ask - commission;
    // Credit the seller (ensure the row exists; sellers always do, but be safe).
    await client.query(
      `INSERT INTO players (id, name, coins) VALUES ($1, $2, GREATEST(0, $3))
         ON CONFLICT (id) DO UPDATE SET coins = GREATEST(0, players.coins + $3), name = EXCLUDED.name`,
      [sellerPid, sellerName, sellerGets],
    );
    // Commission flows into the House.
    await client.query(
      `UPDATE doom_meta SET v = (GREATEST(0, v::numeric + $1))::text WHERE k = 'house_balance'`,
      [commission],
    );
    // Transfer the instance, delete the listing.
    await client.query(`UPDATE exclusive_instances SET owner_pid = $1 WHERE id = $2`, [buyerPid, instanceId]);
    await client.query(`DELETE FROM listings WHERE id = $1`, [listing.id]);
    // If the seller had this exact instance equipped in any slot, clear that slot (the item id is
    // shared across all instances, so only unequip when they no longer own ANY instance of it).
    const stillOwns = await client.query(`SELECT 1 FROM exclusive_instances WHERE owner_pid = $1 AND item = $2 LIMIT 1`, [sellerPid, item]);
    if (!stillOwns.rowCount) {
      await client.query(
        `UPDATE players SET
           hat   = CASE WHEN hat   = $2 THEN NULL ELSE hat   END,
           skin  = CASE WHEN skin  = $2 THEN NULL ELSE skin  END,
           trail = CASE WHEN trail = $2 THEN NULL ELSE trail END,
           title = CASE WHEN title = $2 THEN NULL ELSE title END
         WHERE id = $1`,
        [sellerPid, item],
      );
    }
    await client.query('COMMIT');
    // Record the last sale (outside the txn; a best-effort cache).
    await setExclusiveLastSale(item, ask).catch(() => {});
    return { ok: true, ask, commission, sellerPid, sellerName, instanceId };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// --- Robville land registry -----------------------------------------------------------------
export interface LandRow { id: string; ownerPid: string | null; ownerName: string | null; ask: number | null; house: string | null; }

/** Every lot's current ownership/market state (only rows that exist; lots are seeded on boot). */
export async function getLandParcels(): Promise<LandRow[]> {
  if (!pool) return [];
  const { rows } = await pool.query(`SELECT id, owner_pid, owner_name, ask, house FROM land_parcels`);
  return rows.map((r) => ({
    id: r.id as string,
    ownerPid: (r.owner_pid as string | null) ?? null,
    ownerName: (r.owner_name as string | null) ?? null,
    ask: r.ask === null || r.ask === undefined ? null : Number(r.ask),
    house: (r.house as string | null) ?? null,
  }));
}

/** How many lots this player has bought from the bank so far (the anti-monopoly cap counter). */
export async function getBankParcels(pid: string): Promise<number> {
  if (!pool || !pid) return 0;
  const { rows } = await pool.query(`SELECT bank_parcels FROM players WHERE id = $1`, [pid]);
  return rows.length ? Number(rows[0].bank_parcels) || 0 : 0;
}

/** Buy an empty lot from the bank. Atomic: locks the lot, enforces the cap, debits the buyer,
 *  credits the full price into the House, and assigns ownership. `cap` is BANK_PARCEL_CAP. */
export async function buyParcelFromBank(
  pid: string, name: string, id: string, price: number, cap: number, nowMs: number = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: 'nodb' | 'unknown' | 'taken' | 'cap' | 'afford' }> {
  if (!pool || !pid) return { ok: false, reason: 'nodb' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the lot first (same order as the owner-sale txn, so the two can't deadlock).
    const lot = await client.query(`SELECT owner_pid FROM land_parcels WHERE id = $1 FOR UPDATE`, [id]);
    if (!lot.rowCount) { await client.query('ROLLBACK'); return { ok: false, reason: 'unknown' }; }
    if (lot.rows[0].owner_pid) { await client.query('ROLLBACK'); return { ok: false, reason: 'taken' }; }
    // Ensure the player row exists (so the cap select + debit have something to grab).
    await client.query(
      `INSERT INTO players (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [pid, name],
    );
    const pc = await client.query(`SELECT bank_parcels FROM players WHERE id = $1 FOR UPDATE`, [pid]);
    const bought = pc.rowCount ? Number(pc.rows[0].bank_parcels) || 0 : 0;
    if (bought >= cap) { await client.query('ROLLBACK'); return { ok: false, reason: 'cap' }; }
    const pay = await client.query(
      `UPDATE players SET coins = coins - $2, bank_parcels = bank_parcels + 1 WHERE id = $1 AND coins >= $2`,
      [pid, price],
    );
    if (!pay.rowCount) { await client.query('ROLLBACK'); return { ok: false, reason: 'afford' }; }
    await client.query(
      `UPDATE land_parcels SET owner_pid = $2, owner_name = $3, ask = NULL, updated_at = $4 WHERE id = $1`,
      [id, pid, name, nowMs],
    );
    // The whole purchase price flows into the House treasury (the bank is the House).
    await client.query(
      `UPDATE doom_meta SET v = (GREATEST(0, v::numeric + $1))::text WHERE k = 'house_balance'`,
      [price],
    );
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** List your lot for sale at `ask` coins (or re-price an existing listing). */
export async function listParcel(pid: string, id: string, ask: number): Promise<boolean> {
  if (!pool || !pid || !(ask > 0)) return false;
  const res = await pool.query(
    `UPDATE land_parcels SET ask = $3 WHERE id = $1 AND owner_pid = $2`,
    [id, pid, Math.floor(ask)],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Take your lot back off the market. */
export async function unlistParcel(pid: string, id: string): Promise<boolean> {
  if (!pool || !pid) return false;
  const res = await pool.query(
    `UPDATE land_parcels SET ask = NULL WHERE id = $1 AND owner_pid = $2`,
    [id, pid],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Buy a listed lot from its owner at the asking price. Atomic: locks the lot, debits the buyer,
 *  pays the seller the full ask, and transfers ownership. Player-to-player — does NOT count toward
 *  the bank cap. */
export async function buyParcelFromOwner(
  buyerPid: string, buyerName: string, id: string, nowMs: number = Date.now(),
): Promise<
  | { ok: true; ask: number; sellerPid: string; sellerName: string }
  | { ok: false; reason: 'nodb' | 'unknown' | 'unavail' | 'self' | 'afford' }
> {
  if (!pool || !buyerPid) return { ok: false, reason: 'nodb' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sel = await client.query(
      `SELECT owner_pid, owner_name, ask FROM land_parcels WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!sel.rowCount) { await client.query('ROLLBACK'); return { ok: false, reason: 'unknown' }; }
    const row = sel.rows[0];
    const sellerPid = row.owner_pid as string | null;
    const ask = row.ask === null || row.ask === undefined ? null : Number(row.ask);
    if (!sellerPid || ask === null || !(ask > 0)) { await client.query('ROLLBACK'); return { ok: false, reason: 'unavail' }; }
    if (sellerPid === buyerPid) { await client.query('ROLLBACK'); return { ok: false, reason: 'self' }; }
    const sellerName = (row.owner_name as string | null) ?? 'someone';
    // Ensure the buyer row exists, then charge them atomically (rowCount 0 => can't afford).
    await client.query(
      `INSERT INTO players (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [buyerPid, buyerName],
    );
    const pay = await client.query(
      `UPDATE players SET coins = coins - $2 WHERE id = $1 AND coins >= $2`,
      [buyerPid, ask],
    );
    if (!pay.rowCount) { await client.query('ROLLBACK'); return { ok: false, reason: 'afford' }; }
    // The seller gets the full asking price (no House cut on private land sales).
    await client.query(
      `INSERT INTO players (id, name, coins) VALUES ($1, $2, GREATEST(0, $3))
         ON CONFLICT (id) DO UPDATE SET coins = GREATEST(0, players.coins + $3), name = EXCLUDED.name`,
      [sellerPid, sellerName, ask],
    );
    await client.query(
      `UPDATE land_parcels SET owner_pid = $2, owner_name = $3, ask = NULL, updated_at = $4 WHERE id = $1`,
      [id, buyerPid, buyerName, nowMs],
    );
    await client.query('COMMIT');
    return { ok: true, ask, sellerPid, sellerName };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Build a house on a lot you own. Atomic: locks the lot, checks you still own it, debits the
 *  build cost (into the House — the construction industry), and stamps the house onto the lot.
 *  Building replaces whatever stood there. `house` is a HOUSE_KINDS id (validated by the caller). */
export async function buildHouse(
  pid: string, id: string, house: string, cost: number, nowMs: number = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: 'nodb' | 'notyours' | 'afford' }> {
  if (!pool || !pid) return { ok: false, reason: 'nodb' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lot = await client.query(`SELECT owner_pid FROM land_parcels WHERE id = $1 FOR UPDATE`, [id]);
    if (!lot.rowCount || lot.rows[0].owner_pid !== pid) { await client.query('ROLLBACK'); return { ok: false, reason: 'notyours' }; }
    const pay = await client.query(
      `UPDATE players SET coins = coins - $2 WHERE id = $1 AND coins >= $2`,
      [pid, cost],
    );
    if (!pay.rowCount) { await client.query('ROLLBACK'); return { ok: false, reason: 'afford' }; }
    await client.query(
      `UPDATE land_parcels SET house = $2, updated_at = $3 WHERE id = $1`,
      [id, house, nowMs],
    );
    // The build cost flows into the House treasury (the local builders are the House).
    await client.query(
      `UPDATE doom_meta SET v = (GREATEST(0, v::numeric + $1))::text WHERE k = 'house_balance'`,
      [cost],
    );
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Tear down the house on a lot you own (free; the lot goes back to empty). */
export async function demolishHouse(pid: string, id: string, nowMs: number = Date.now()): Promise<boolean> {
  if (!pool || !pid) return false;
  const res = await pool.query(
    `UPDATE land_parcels SET house = NULL, updated_at = $3 WHERE id = $1 AND owner_pid = $2 AND house IS NOT NULL`,
    [id, pid, nowMs],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Load the persisted global price board (empty if never saved / no DB). */
export async function getStockPrices(): Promise<Record<string, { price: number; prev: number }>> {
  if (!pool) return {};
  const { rows } = await pool.query(`SELECT coin, price, prev FROM stock_prices`);
  const out: Record<string, { price: number; prev: number }> = {};
  for (const r of rows) out[r.coin] = { price: Number(r.price), prev: Number(r.prev) };
  return out;
}

/** Persist the global price board so the market resumes where it left off after a restart. */
export async function saveStockPrices(prices: { id: string; price: number; prev: number }[]): Promise<void> {
  if (!pool) return;
  for (const p of prices) {
    await pool.query(
      `INSERT INTO stock_prices (coin, price, prev) VALUES ($1, $2, $3)
         ON CONFLICT (coin) DO UPDATE SET price = EXCLUDED.price, prev = EXCLUDED.prev`,
      [p.id, p.price, p.prev],
    );
  }
}

// The graph history is the per-coin price series (one array per STOCK_HISTORY timeframe). It
// used to live only in server memory, so every restart/deploy wiped the graphs. We persist the
// whole board as one small JSON blob in doom_meta (a single row, rewritten in place — never
// grows) so the graphs survive restarts. The series are length-capped (see STOCK_HISTORY), so
// the blob stays a few KB. Partial: blobs persisted before a timeframe was added lack its key.
type StockSeries = Partial<Record<StockTf, number[]>>;

/** Load the persisted graph history (empty if never saved / no DB / unreadable). */
export async function getStockHistory(): Promise<Record<string, StockSeries>> {
  if (!pool) return {};
  try {
    const { rows } = await pool.query(`SELECT v FROM doom_meta WHERE k = 'stock_history'`);
    if (!rows.length) return {};
    const parsed = JSON.parse(rows[0].v);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // malformed row → fall back to a fresh (re-seeded) history, never crash boot
  }
}

/** Persist the graph history as one JSON row (upsert in place). */
export async function saveStockHistory(history: { id: string; series: StockSeries }[]): Promise<void> {
  if (!pool) return;
  const board: Record<string, StockSeries> = {};
  for (const h of history) board[h.id] = h.series;
  await pool.query(
    `INSERT INTO doom_meta (k, v) VALUES ('stock_history', $1)
       ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [JSON.stringify(board)],
  );
}

/** Read the scheduled epoch-ms of the next market crash (0 if never scheduled / no DB). */
export async function getStockCrashAt(): Promise<number> {
  if (!pool) return 0;
  const { rows } = await pool.query(`SELECT v FROM doom_meta WHERE k = 'stock_next_crash'`);
  return rows.length ? Number(rows[0].v) || 0 : 0;
}

/** Persist when the next market crash is due, so the schedule survives restarts. */
export async function setStockCrashAt(ts: number): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO doom_meta (k, v) VALUES ('stock_next_crash', $1)
       ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [String(ts)],
  );
}

/** Read the persisted news feed (up to ~30 items, newest-first). Empty if no DB. */
export async function getNewsFeed(): Promise<import('../shared/types').NewsItem[]> {
  if (!pool) return [];
  try {
    const { rows } = await pool.query(`SELECT v FROM doom_meta WHERE k = 'news_feed'`);
    if (!rows.length) return [];
    const parsed = JSON.parse(rows[0].v);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
/** Persist the news feed (upsert in place). */
export async function saveNewsFeed(items: import('../shared/types').NewsItem[]): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO doom_meta (k, v) VALUES ('news_feed', $1)
       ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [JSON.stringify(items.slice(0, 30))],
  );
}

/** Read the running market-instability pool (total defaulted-loan debt since the last crash).
 *  0 if never set / no DB. Drives the "Market Stability" bar and the crash trigger. */
export async function getMarketInstability(): Promise<number> {
  if (!pool) return 0;
  const { rows } = await pool.query(`SELECT v FROM doom_meta WHERE k = 'market_instability'`);
  return rows.length ? Number(rows[0].v) || 0 : 0;
}

/** Persist the market-instability pool so it survives restarts. */
export async function setMarketInstability(n: number): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO doom_meta (k, v) VALUES ('market_instability', $1)
       ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [String(n)],
  );
}

// --- Generic doom_meta KV (for the Fed: coefficients, trickle fund, MTM, bonds, auctions) ---
/** Read an arbitrary doom_meta value (string), or null if unset / no DB. */
export async function getMeta(key: string): Promise<string | null> {
  if (!pool) return null;
  const { rows } = await pool.query(`SELECT v FROM doom_meta WHERE k = $1`, [key]);
  return rows.length ? String(rows[0].v) : null;
}
/** Read a numeric doom_meta value, falling back to `dflt` when unset / unparseable. */
export async function getMetaNum(key: string, dflt = 0): Promise<number> {
  const v = await getMeta(key);
  if (v === null) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
/** Upsert an arbitrary doom_meta value (stringified). */
export async function setMeta(key: string, val: string | number): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO doom_meta (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [key, String(val)],
  );
}
/** Total outstanding loan principal across everyone (for the House-balance loan cap). */
export async function getTotalOutstandingLoans(): Promise<number> {
  if (!pool) return 0;
  const { rows } = await pool.query(`SELECT COALESCE(SUM(amount), 0) AS s FROM loans`);
  return Number(rows[0]?.s ?? 0);
}
/** Sum of every player's liquid coins (for the House dashboard's "coins in circulation"). */
export async function getTotalCoins(): Promise<number> {
  if (!pool) return 0;
  const { rows } = await pool.query(`SELECT COALESCE(SUM(coins), 0) AS s FROM players`);
  return Number(rows[0]?.s ?? 0);
}
/** Per-stock locked supply: shares held in long positions older than `olderThanMs`, by coin. Drives
 *  the supply-scarcity price drift (cornered low-supply coins get a premium). */
export async function getLockedShares(olderThanMs: number): Promise<Record<string, number>> {
  if (!pool) return {};
  const cutoff = Date.now() - olderThanMs;
  const { rows } = await pool.query<{ coin: string; s: string }>(
    `SELECT coin, COALESCE(SUM(shares), 0) AS s FROM stock_holdings
       WHERE side = 'long' AND COALESCE(opened_at, 0) < $1 GROUP BY coin`,
    [cutoff],
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.coin] = Number(r.s) || 0;
  return out;
}
/** Total shares a player already holds (long+short) of one coin — for the concentration cap. */
export async function getPlayerShares(pid: string, coin: string): Promise<number> {
  if (!pool || !pid) return 0;
  const { rows } = await pool.query<{ s: string }>(
    `SELECT COALESCE(SUM(shares), 0) AS s FROM stock_holdings WHERE pid = $1 AND coin = $2`,
    [pid, coin],
  );
  return Number(rows[0]?.s ?? 0);
}

// The room's armed game-mode toggles (gravity, turbo, arena, view mode, …) live as one small
// JSON blob in doom_meta so the operator's chosen modes survive a server reboot/redeploy.
export type GameModes = Record<string, boolean | string>;

/** Read the persisted game-mode toggles. null if never set / no DB. */
export async function getGameModes(): Promise<GameModes | null> {
  if (!pool) return null;
  try {
    const { rows } = await pool.query(`SELECT v FROM doom_meta WHERE k = 'game_modes'`);
    if (!rows.length) return null;
    const parsed = JSON.parse(rows[0].v);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

/** Persist the room's game-mode toggles (upsert in place). */
export async function saveGameModes(modes: GameModes): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO doom_meta (k, v) VALUES ('game_modes', $1)
       ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [JSON.stringify(modes)],
  );
}

// --- House treasury (the coin-conservation backbone) ---
// The House balance lives in a single doom_meta KV row (like market_instability) so it's
// persistent and shared. Every coin that flows into a sink (roulette stakes, lost bets, loot-box
// prices, marketplace commission, fast-sell tax, seized loan-default wallets, market escrow)
// credits the House; every House-funded payout debits it. The debit is race-safe: it only
// succeeds when the House actually holds the coins, so the treasury can never go negative.

/** Read the current House balance (0 if no DB / never seeded). */
export async function getHouseBalance(): Promise<number> {
  if (!pool) return 0;
  const { rows } = await pool.query(`SELECT v FROM doom_meta WHERE k = 'house_balance'`);
  return rows.length ? Number(rows[0].v) || 0 : 0;
}

/** Adjust the House balance by `delta`. A credit (delta > 0) always applies (floored at 0). A
 *  debit (delta < 0) is CONDITIONAL — it only succeeds when the House holds at least |delta|,
 *  so it can never overdraw. Returns the new balance, or null when a debit couldn't be funded
 *  (caller must NOT proceed as if it paid out). A zero delta is a no-op read. */
export async function houseAdjust(delta: number): Promise<number | null> {
  if (!pool) return null;
  if (delta === 0) return getHouseBalance();
  if (delta > 0) {
    // Credit: UPSERT so a credit always lands even if the genesis row was never seeded (otherwise
    // coins paid INTO the House on a missing row would be silently destroyed). Clamp at 0 so a
    // corrupt negative row can't make coins vanish.
    const { rows } = await pool.query(
      `INSERT INTO doom_meta (k, v) VALUES ('house_balance', ($1::numeric)::text)
         ON CONFLICT (k) DO UPDATE SET v = (GREATEST(0, doom_meta.v::numeric + $1::numeric))::text
       RETURNING v`,
      [delta],
    );
    return rows.length ? Number(rows[0].v) : null;
  }
  // Debit: only when the balance covers it. rowCount === 0 => insufficient funds.
  const need = -delta;
  const { rows } = await pool.query(
    `UPDATE doom_meta SET v = (v::numeric - $1)::text WHERE k = 'house_balance' AND v::numeric >= $1 RETURNING v`,
    [need],
  );
  return rows.length ? Number(rows[0].v) : null;
}

// --- Davis's loans ---
export interface Loan { amount: number; owed: number; dueAt: number; }

/** Read a player's open loan, or null if they owe nothing (or no DB). */
export async function getLoan(pid: string): Promise<Loan | null> {
  if (!pool || !pid) return null;
  const { rows } = await pool.query(`SELECT amount, owed, due_at FROM loans WHERE pid = $1`, [pid]);
  if (!rows.length) return null;
  return { amount: Number(rows[0].amount), owed: Number(rows[0].owed), dueAt: Number(rows[0].due_at) };
}

/** Take out a loan: borrow `amount` coins (credited to the wallet) against owing ceil(1.5×amount)
 *  back by `dueAt`. Fails — returns null — if the player already has an open loan or the amount
 *  isn't a positive whole number. Returns the new wallet + loan on success. */
export async function takeLoan(pid: string, name: string, amount: number, dueAt: number): Promise<{ wallet: Wallet; loan: Loan } | null> {
  if (!pool || !pid) return null;
  const principal = Math.floor(amount);
  if (!Number.isFinite(principal) || principal < 1) return null;
  if (await getLoan(pid)) return null; // one loan at a time
  const owed = Math.ceil(principal * 1.5); // Davis rounds up, naturally
  // Record the debt first; the PK on pid makes a duplicate insert throw rather than double-lend.
  await pool.query(`INSERT INTO loans (pid, amount, owed, due_at) VALUES ($1, $2, $3, $4)`, [pid, principal, owed, dueAt]);
  const wallet = await addCoins(pid, name, principal);
  if (!wallet) return null;
  return { wallet, loan: { amount: principal, owed, dueAt } };
}

/** Snap any open loan whose deadline sits later than `dueAt` back to it. Used on boot when the
 *  daily collection moved to a fixed 5pm: loans booked under the old rolling-24h deadline get
 *  pulled to the next 5pm so their countdown is correct. Never extends a loan that's due sooner. */
export async function realignLoansToDeadline(dueAt: number): Promise<void> {
  if (!pool) return;
  await pool.query(`UPDATE loans SET due_at = $1 WHERE due_at > $1`, [dueAt]);
}

/** Repay a loan in full: spends the whole `owed` amount and clears the debt. Fails — returns
 *  null — if there's no loan or the player can't afford the full repayment (loan untouched). */
export async function repayLoan(pid: string): Promise<{ wallet: Wallet } | null> {
  if (!pool || !pid) return null;
  const loan = await getLoan(pid);
  if (!loan) return null;
  const wallet = await spendCoins(pid, loan.owed); // null if they can't cover it
  if (!wallet) return null;
  await pool.query(`DELETE FROM loans WHERE pid = $1`, [pid]);
  return { wallet };
}

/** Enforce the deadline on every loan due at/before `nowMs`: Davis takes EVERYTHING from those
 *  players — zero their wallets, strip every cosmetic (clear owned items + unequip hat/skin),
 *  wipe all their stock positions, and clear the debt. Returns the affected pids (so the caller
 *  can refresh anyone connected) plus `totalOwed` — the sum of every defaulter's unpaid 1.5×
 *  debt, which the caller feeds into the market-instability pool. */
export async function collectDefaultedLoans(nowMs: number): Promise<{ pids: string[]; totalOwed: number; seized: number }> {
  if (!pool) return { pids: [], totalOwed: 0, seized: 0 };
  const { rows } = await pool.query(`SELECT pid, owed FROM loans WHERE due_at <= $1`, [nowMs]);
  const pids = rows.map((r) => r.pid as string);
  if (!pids.length) return { pids: [], totalOwed: 0, seized: 0 };
  const totalOwed = rows.reduce((sum, r) => sum + (Number(r.owed) || 0), 0);
  // Economy Overhaul: the wallet coins Davis takes are REAL coins that must go somewhere to stay
  // conserved — sum them BEFORE zeroing so the caller can route them into the House. The escrowed
  // stock cost of the wiped positions is already House-held (pushed there at invest time), so
  // deleting those positions just forfeits the player's claim on that escrow to the House — no
  // coins move, and nothing is double-counted. The virtual `owed` still feeds market instability
  // exactly as before and is NEVER minted as coins.
  const seizedRes = await pool.query<{ s: string }>(`SELECT COALESCE(SUM(coins), 0) AS s FROM players WHERE id = ANY($1)`, [pids]);
  const seized = Number(seizedRes.rows[0]?.s ?? 0);
  await pool.query(`UPDATE players SET coins = 0, owned = '', hat = NULL, skin = NULL WHERE id = ANY($1)`, [pids]);
  await pool.query(`DELETE FROM stock_holdings WHERE pid = ANY($1)`, [pids]);
  await pool.query(`DELETE FROM loans WHERE pid = ANY($1)`, [pids]);
  return { pids, totalOwed, seized };
}

/** The public open-loan book: borrower name, principal, owed, and deadline — ordered by the
 *  biggest debts first. Drives the clickable stability-bar modal. Empty without a DB. */
export async function getOpenLoans(): Promise<{ name: string; amount: number; owed: number; dueAt: number }[]> {
  if (!pool) return [];
  const { rows } = await pool.query<{ name: string; amount: number; owed: number; due_at: number }>(
    `SELECT p.name, l.amount, l.owed, l.due_at
       FROM loans l JOIN players p ON p.id = l.pid
      ORDER BY l.owed DESC, p.name ASC
      LIMIT 50`,
  );
  return rows.map((r) => ({ name: r.name, amount: Number(r.amount), owed: Number(r.owed), dueAt: Number(r.due_at) }));
}

// --- Economy Overhaul: netizen bot traders ---

/** All netizen (bot trader) player ids + names. They're real player rows flagged is_netizen. */
export async function getNetizens(): Promise<{ pid: string; name: string; coins: number }[]> {
  if (!pool) return [];
  const { rows } = await pool.query<{ id: string; name: string; coins: number }>(
    `SELECT id, name, coins FROM players WHERE is_netizen = TRUE`,
  );
  return rows.map((r) => ({ pid: r.id, name: r.name, coins: Number(r.coins) }));
}

/** Seed a netizen row, funding its starting coins FROM the House (a transfer, never a mint).
 *  Returns true if it was funded+created (or already existed); false when the House couldn't
 *  cover the funding (caller seeds fewer). Idempotent on the pid: an existing netizen isn't
 *  re-funded. */
export async function seedNetizen(pid: string, name: string, startCoins: number): Promise<boolean> {
  if (!pool || !pid) return false;
  const existing = await pool.query(`SELECT 1 FROM players WHERE id = $1`, [pid]);
  if (existing.rowCount) {
    // Make sure the flag is set, but don't re-fund.
    await pool.query(`UPDATE players SET is_netizen = TRUE WHERE id = $1`, [pid]);
    return true;
  }
  // Pull the starting coins out of the House first (conditional debit). If it can't fund, abort.
  const funded = await houseAdjust(-startCoins);
  if (funded === null) return false;
  await pool.query(
    `INSERT INTO players (id, name, coins, is_netizen) VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (id) DO UPDATE SET is_netizen = TRUE`,
    [pid, name, startCoins],
  );
  return true;
}

// Players who haven't touched a match or the economy in this long drop off the leaderboards
// (Elo and net worth) — keeps the boards reflecting who's actually still around.
const LEADERBOARD_ACTIVE_MS = 14 * 24 * 60 * 60 * 1000;

export async function getLeaderboard(): Promise<LeaderboardRow[]> {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT name, wins, losses, elo, title
       FROM players
      WHERE wins + losses > 0 AND COALESCE(last_played, 0) >= $2
      ORDER BY elo DESC, name ASC
      LIMIT $1`,
    [LEADERBOARD_SIZE, Date.now() - LEADERBOARD_ACTIVE_MS],
  );
  return rows.map((r) => ({ name: r.name, wins: r.wins, losses: r.losses, elo: r.elo, title: r.title ?? null }));
}

/** Full Elo leaderboard including the stable pid (server-only — pid is never sent to clients),
 *  used by the lobby to resolve a board rank back to a player for the profile drilldown. */
export async function getEloBoard(): Promise<(LeaderboardRow & { pid: string })[]> {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT id AS pid, name, wins, losses, elo, title
       FROM players
      WHERE wins + losses > 0 AND COALESCE(last_played, 0) >= $2
      ORDER BY elo DESC, name ASC
      LIMIT $1`,
    [LEADERBOARD_SIZE, Date.now() - LEADERBOARD_ACTIVE_MS],
  );
  return rows.map((r) => ({
    pid: r.pid,
    name: r.name,
    wins: Number(r.wins),
    losses: Number(r.losses),
    elo: Number(r.elo),
    title: r.title ?? null,
  }));
}

/** This player's own Elo standing across the WHOLE field (not just the visible top-N), so
 *  the client can pin their row to the board even when they sit below the cutoff. null if
 *  they haven't played / no DB. Rank ordering mirrors getEloBoard exactly. */
export async function getSelfElo(pid: string): Promise<{ rank: number; elo: number } | null> {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT rnk, elo FROM (
       SELECT id, elo,
              ROW_NUMBER() OVER (ORDER BY elo DESC, name ASC) AS rnk
         FROM players
        WHERE wins + losses > 0 AND COALESCE(last_played, 0) >= $2
     ) sub WHERE id = $1`,
    [pid, Date.now() - LEADERBOARD_ACTIVE_MS],
  );
  return rows.length ? { rank: Number(rows[0].rnk), elo: Number(rows[0].elo) } : null;
}

/** This player's own Net Worth standing across the WHOLE field (not just the visible top-N).
 *  Mirrors getNetWorthLeaderboard's ordering/filter so the pinned self-row is consistent with
 *  the board. null if they don't qualify / no DB. */
export async function getSelfNetWorth(pid: string): Promise<(NetWorthRow & { rank: number }) | null> {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT rnk, name, title, net, coins, loan FROM (
       SELECT p.id AS pid, p.name, p.title,
              p.coins + COALESCE(h.val, 0) - COALESCE(l.owed, 0) AS net,
              p.coins,
              COALESCE(l.owed, 0) AS loan,
              ROW_NUMBER() OVER (
                ORDER BY p.coins + COALESCE(h.val, 0) - COALESCE(l.owed, 0) DESC, p.name ASC
              ) AS rnk
         FROM players p
         LEFT JOIN (
           SELECT sh.pid,
                  SUM(CASE WHEN sh.side = 'short'
                           THEN 2 * sh.cost - sh.shares * sp.price
                           ELSE sh.shares * sp.price END) AS val
             FROM stock_holdings sh
             JOIN stock_prices sp ON sp.coin = sh.coin
            WHERE sh.shares > 0
            GROUP BY sh.pid
         ) h ON h.pid = p.id
         LEFT JOIN loans l ON l.pid = p.id
        WHERE (p.wins + p.losses > 0
           OR p.coins <> 0
           OR h.val IS NOT NULL
           OR l.owed IS NOT NULL)
          AND COALESCE(p.last_played, 0) >= $2
     ) sub WHERE pid = $1`,
    [pid, Date.now() - LEADERBOARD_ACTIVE_MS],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    rank: Number(r.rnk),
    name: r.name,
    title: r.title ?? null,
    net: Math.round(Number(r.net)),
    coins: Number(r.coins),
    loan: Math.round(Number(r.loan)),
  };
}

/** A player's public profile for the Elo drilldown. Returns null when the player
 *  doesn't exist (or there's no DB). */
export interface PlayerProfile {
  name: string;
  wins: number;
  losses: number;
  elo: number;
  winPct: number;
  lastPlayed: number | null;
}
export async function getPlayerProfile(pid: string): Promise<PlayerProfile | null> {
  if (!pool || !pid) return null;
  const { rows } = await pool.query(
    `SELECT name, wins, losses, elo, last_played FROM players WHERE id = $1`,
    [pid],
  );
  if (!rows.length) return null;
  const r = rows[0];
  const total = Number(r.wins) + Number(r.losses);
  return {
    name: r.name,
    wins: Number(r.wins),
    losses: Number(r.losses),
    elo: Number(r.elo),
    winPct: total > 0 ? Math.round((Number(r.wins) / total) * 100) : 0,
    lastPlayed: r.last_played ? Number(r.last_played) : null,
  };
}

/** Head-to-head record between two players: the first argument's wins/losses
 *  against the second, or null if they've never met (or there's no DB). */
export async function getRival(pid: string, rivalPid: string): Promise<{ name: string; wins: number; losses: number } | null> {
  if (!pool || !pid || !rivalPid || pid === rivalPid) return null;
  const [p1, p2] = pid < rivalPid ? [pid, rivalPid] : [rivalPid, pid];
  const { rows } = await pool.query(
    `SELECT h.p1_wins, h.p2_wins, p.name AS rival_name
       FROM head_to_head h
       JOIN players p ON p.id = $3
       WHERE h.player1 = $1 AND h.player2 = $2`,
    [p1, p2, rivalPid],
  );
  if (!rows.length) return null;
  const r = rows[0];
  const pidIsP1 = pid === p1;
  return {
    name: r.rival_name,
    wins: pidIsP1 ? Number(r.p1_wins) : Number(r.p2_wins),
    losses: pidIsP1 ? Number(r.p2_wins) : Number(r.p1_wins),
  };
}

/** Net worth board: each player's coins + the live value of their stock holdings
 *  (shares × the latest persisted price) minus any loan they owe Davis. Ranked by
 *  net worth, top LEADERBOARD_SIZE. Includes anyone who has played, holds coins, has
 *  an open position, or owes a debt — so a leveraged whale and a bankrupt borrower
 *  both show up. Net can be negative when the debt outweighs the assets. */
export async function getNetWorthLeaderboard(): Promise<(NetWorthRow & { pid: string })[]> {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT p.id AS pid,
            p.name,
            p.title,
            p.coins + COALESCE(h.val, 0) - COALESCE(l.owed, 0) AS net,
            p.coins,
            COALESCE(l.owed, 0) AS loan
       FROM players p
       LEFT JOIN (
         SELECT sh.pid,
                SUM(CASE WHEN sh.side = 'short'
                         THEN 2 * sh.cost - sh.shares * sp.price
                         ELSE sh.shares * sp.price END) AS val
           FROM stock_holdings sh
           JOIN stock_prices sp ON sp.coin = sh.coin
          WHERE sh.shares > 0
          GROUP BY sh.pid
       ) h ON h.pid = p.id
       LEFT JOIN loans l ON l.pid = p.id
      WHERE (p.wins + p.losses > 0
         OR p.coins <> 0
         OR h.val IS NOT NULL
         OR l.owed IS NOT NULL)
        AND COALESCE(p.last_played, 0) >= $2
      ORDER BY net DESC, p.name ASC
      LIMIT $1`,
    [LEADERBOARD_SIZE, Date.now() - LEADERBOARD_ACTIVE_MS],
  );
  return rows.map((r) => ({
    pid: r.pid,
    name: r.name,
    title: r.title ?? null,
    net: Math.round(Number(r.net)),
    coins: Number(r.coins),
    loan: Math.round(Number(r.loan)),
  }));
}

// --- Netizen Challenge (Plan 10) ---

/** Ensure the netizen_challenges table exists. */
export async function ensureNetizenChallengesTable(): Promise<void> {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS netizen_challenges (
      player_pid  TEXT NOT NULL,
      netizen_pid TEXT NOT NULL,
      ts          BIGINT NOT NULL,
      PRIMARY KEY (player_pid, netizen_pid)
    )
  `);
}

/** Check if `playerPid` has challenged `netizenPid` today (since the last 5pm ET boundary). */
export async function challengedToday(playerPid: string, netizenPid: string, boundaryMs: number): Promise<boolean> {
  if (!pool) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM netizen_challenges WHERE player_pid = $1 AND netizen_pid = $2 AND ts >= $3`,
    [playerPid, netizenPid, boundaryMs],
  );
  return rows.length > 0;
}

/** Record that `playerPid` challenged `netizenPid` now. */
export async function recordChallenge(playerPid: string, netizenPid: string, nowMs: number): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO netizen_challenges (player_pid, netizen_pid, ts) VALUES ($1, $2, $3)
       ON CONFLICT (player_pid, netizen_pid) DO UPDATE SET ts = EXCLUDED.ts`,
    [playerPid, netizenPid, nowMs],
  );
}

/** Look up a netizen by pid. */
export async function getNetizenByPid(pid: string): Promise<{ pid: string; name: string; net: number } | null> {
  if (!pool) return null;
  const { rows } = await pool.query(
    `SELECT id AS pid, name, coins + COALESCE(h.val, 0) - COALESCE(l.owed, 0) AS net
       FROM players p
       LEFT JOIN (
         SELECT sh.pid,
                SUM(CASE WHEN sh.side = 'short'
                         THEN 2 * sh.cost - sh.shares * sp.price
                         ELSE sh.shares * sp.price END) AS val
           FROM stock_holdings sh
           JOIN stock_prices sp ON sp.coin = sh.coin
          WHERE sh.shares > 0
          GROUP BY sh.pid
       ) h ON h.pid = p.id
       LEFT JOIN loans l ON l.pid = p.id
       WHERE p.id = $1 AND p.is_netizen = TRUE`,
    [pid],
  );
  return rows.length ? { pid: rows[0].pid, name: rows[0].name, net: Number(rows[0].net) } : null;
}

/** Count total netizens. */
export async function getNetizenCount(): Promise<number> {
  if (!pool) return 0;
  const { rows } = await pool.query(`SELECT COUNT(*) AS c FROM players WHERE is_netizen = TRUE`);
  return Number(rows[0].c);
}

/** Rank of a netizen by net worth (1 = highest). */
export async function getNetWorthRank(pid: string): Promise<number> {
  if (!pool) return 1;
  const { rows } = await pool.query(
    `SELECT rnk FROM (
       SELECT p.id,
              ROW_NUMBER() OVER (ORDER BY p.coins - COALESCE(l.owed, 0) DESC) AS rnk
         FROM players p
         LEFT JOIN loans l ON l.pid = p.id
         WHERE p.is_netizen = TRUE
     ) sub WHERE id = $1`,
    [pid],
  );
  return rows.length ? Number(rows[0].rnk) : 1;
}
