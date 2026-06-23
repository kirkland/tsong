// Postgres-backed win/loss leaderboard. Degrades gracefully: if DATABASE_URL is not
// set (e.g. local dev without a DB), every call is a no-op and the leaderboard is
// simply empty, so the rest of the app runs unchanged.

import pg from 'pg';
import { LeaderboardRow, NetWorthRow, LEADERBOARD_SIZE, CampaignScoreRow } from '../shared/types';

let pool: pg.Pool | null = null;

// Railway's internal connection (*.railway.internal) and localhost don't use TLS;
// the public proxy host does. Enable a permissive SSL only for the latter.
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
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS trail TEXT`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS title TEXT`);
  await pool.query(`ALTER TABLE players ADD COLUMN IF NOT EXISTS email TEXT`);
  // Stock market: per-player positions (fractional shares + coins-invested cost basis),
  // keyed by player + coin id; and the global price board (one row per coin).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stock_holdings (
      pid    TEXT NOT NULL,
      coin   TEXT NOT NULL,
      shares DOUBLE PRECISION NOT NULL DEFAULT 0,
      cost   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (pid, coin)
    )
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
  // Co-op scores used to be recorded per-player; they're now one combined team entry keyed
  // "team:<a> and <b>". Drop any legacy per-player co-op rows so the board only shows pairs.
  await pool.query(`DELETE FROM doom_scores WHERE coop = TRUE AND pid NOT LIKE 'team:%'`);
  // One-time wipe: scores recorded before boss-battle rounds existed are no longer
  // comparable, so clear the whole board once (gated by a meta flag so it runs just once).
  await pool.query(`CREATE TABLE IF NOT EXISTS doom_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
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
  // One-time: cap everyone's coins at 10 000. Anyone over the limit gets brought back down;
  // anyone below keeps their balance. Idempotent after it runs once.
  const coinCap = await pool.query(`SELECT 1 FROM doom_meta WHERE k = 'coin_cap_10k_v1'`);
  if (coinCap.rowCount === 0) {
    await pool.query(`UPDATE players SET coins = 10000 WHERE coins > 10000`);
    await pool.query(`INSERT INTO doom_meta (k, v) VALUES ('coin_cap_10k_v1', now()::text)`);
  }
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
  for (const w of winners) {
    await pool.query(
      `INSERT INTO players (id, name, wins, coins) VALUES ($1, $2, 1, 100)
         ON CONFLICT (id) DO UPDATE SET wins = players.wins + 1, coins = players.coins + 100, name = EXCLUDED.name`,
      [w.pid, w.name],
    );
  }
  for (const l of losers) {
    await pool.query(
      `INSERT INTO players (id, name, losses) VALUES ($1, $2, 1)
         ON CONFLICT (id) DO UPDATE SET losses = players.losses + 1, name = EXCLUDED.name`,
      [l.pid, l.name],
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
  lastSpin: number; // epoch ms of the last daily spin (0 = never)
  bonusSpins: number; // free extra wheel spins (e.g. from winning a tournament)
}
const EMPTY_WALLET: Wallet = { coins: 0, owned: [], hat: null, skin: null, trail: null, title: null, lastSpin: 0, bonusSpins: 0 };

function rowToWallet(r: { coins: number; owned: string; hat: string | null; skin: string | null; trail?: string | null; title?: string | null; last_spin?: string | number; bonus_spins?: number }): Wallet {
  return {
    coins: r.coins,
    owned: (r.owned || '').split(',').filter(Boolean),
    hat: r.hat ?? null,
    skin: r.skin ?? null,
    trail: r.trail ?? null,
    title: r.title ?? null,
    lastSpin: Number(r.last_spin ?? 0),
    bonusSpins: Number(r.bonus_spins ?? 0),
  };
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
  const { rows } = await pool.query(`SELECT coins, owned, hat, skin, trail, title, last_spin, bonus_spins FROM players WHERE id = $1`, [pid]);
  return rows.length ? rowToWallet(rows[0]) : { ...EMPTY_WALLET };
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
export async function grantItem(pid: string, _name: string, item: string): Promise<Wallet | null> {
  if (!pool || !pid) return null;
  const cur = await getWallet(pid);
  if (cur.owned.includes(item)) return cur;
  const owned = [...cur.owned, item].join(',');
  const { rows } = await pool.query(
    `UPDATE players SET owned = $2 WHERE id = $1 RETURNING coins, owned, hat, skin, trail, title, last_spin`,
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
     RETURNING coins, owned, hat, skin, trail, title`,
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
       RETURNING coins, owned, hat, skin, trail, title`,
    [pid, price, owned],
  );
  return rows.length ? rowToWallet(rows[0]) : null;
}

/** Equip (or unequip with item=null) a cosmetic in a slot. Only equips owned items. */
export async function equipItem(pid: string, slot: 'hat' | 'skin' | 'trail' | 'title', item: string | null): Promise<Wallet | null> {
  if (!pool || !pid) return null;
  const cur = await getWallet(pid);
  if (item !== null && !cur.owned.includes(item)) return null; // can't equip what you don't own
  const col = slot === 'hat' ? 'hat' : slot === 'skin' ? 'skin' : slot === 'trail' ? 'trail' : 'title';
  const { rows } = await pool.query(
    `UPDATE players SET ${col} = $2 WHERE id = $1 RETURNING coins, owned, hat, skin, trail, title`,
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
       RETURNING coins, owned, hat, skin, trail, title`,
    [pid, amount],
  );
  return rows.length ? rowToWallet(rows[0]) : null;
}

/** Add (or subtract) coins for a player; used for gambling payouts/refunds. Returns new wallet. */
export async function addCoins(pid: string, name: string, delta: number): Promise<Wallet | null> {
  if (!pool || !pid) return null;
  const { rows } = await pool.query(
    `INSERT INTO players (id, name, coins) VALUES ($1, $2, GREATEST(0, $3))
       ON CONFLICT (id) DO UPDATE SET coins = GREATEST(0, players.coins + $3), name = EXCLUDED.name
       RETURNING coins, owned, hat, skin, trail, title`,
    [pid, name, delta],
  );
  return rows.length ? rowToWallet(rows[0]) : null;
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
    `INSERT INTO stock_holdings (pid, coin, shares, cost)
       SELECT $2, coin, shares, cost FROM stock_holdings WHERE pid = $1
       ON CONFLICT (pid, coin) DO UPDATE
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

// --- Stock market ---
export interface Holding { shares: number; cost: number; }

/** Read all of a player's open stock positions, keyed by coin id. */
export async function getHoldings(pid: string): Promise<Record<string, Holding>> {
  if (!pool || !pid) return {};
  const { rows } = await pool.query(`SELECT coin, shares, cost FROM stock_holdings WHERE pid = $1 AND shares > 0`, [pid]);
  const out: Record<string, Holding> = {};
  for (const r of rows) out[r.coin] = { shares: Number(r.shares), cost: Number(r.cost) };
  return out;
}

/** Invest `amount` coins into `coin` at the given price: deducts the coins (fails — returns
 *  null — if the player can't afford it) and adds amount/price shares to the position,
 *  pooling with any existing holding. Returns the updated wallet on success. */
export async function investStock(pid: string, _name: string, coin: string, amount: number, price: number): Promise<Wallet | null> {
  if (!pool || !pid || amount <= 0 || !(price > 0)) return null;
  // Escrow the coins first; bail out untouched if the balance isn't there.
  const wallet = await spendCoins(pid, amount);
  if (!wallet) return null;
  const shares = amount / price;
  await pool.query(
    `INSERT INTO stock_holdings (pid, coin, shares, cost) VALUES ($1, $2, $3, $4)
       ON CONFLICT (pid, coin) DO UPDATE
       SET shares = stock_holdings.shares + EXCLUDED.shares,
           cost   = stock_holdings.cost   + EXCLUDED.cost`,
    [pid, coin, shares, Math.floor(amount)],
  );
  return wallet;
}

/** Cash out the entire position in `coin` at the given price: pays round(shares × price)
 *  coins, deletes the holding, and returns the new wallet plus the payout. Rounds to the
 *  NEAREST whole coin — worth ≥ x.5 rounds up, below rounds down (a 1-coin buy at 0.96 or
 *  0.55 cashes out for 1; at 0.40 it rounds to 0). Returns null if the player holds nothing
 *  in that coin. */
export async function cashOutStock(pid: string, name: string, coin: string, price: number): Promise<{ wallet: Wallet; payout: number } | null> {
  if (!pool || !pid) return null;
  const { rows } = await pool.query(`SELECT shares FROM stock_holdings WHERE pid = $1 AND coin = $2`, [pid, coin]);
  if (!rows.length || Number(rows[0].shares) <= 0) return null;
  const shares = Number(rows[0].shares);
  const payout = Math.round(shares * price);
  await pool.query(`DELETE FROM stock_holdings WHERE pid = $1 AND coin = $2`, [pid, coin]);
  // addCoins with a 0 delta still returns the (unchanged) wallet, so a wiped-out position
  // still resolves cleanly.
  const wallet = (await addCoins(pid, name, payout)) ?? (await getWallet(pid));
  return { wallet, payout };
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

// The graph history is the per-coin price series (5m/1h/1d). It used to live only in server
// memory, so every restart/deploy wiped the graphs. We persist the whole board as one small
// JSON blob in doom_meta (a single row, rewritten in place — never grows) so the graphs survive
// restarts. The series are already length-capped (see STOCK_HISTORY), so the blob stays a few KB.
type StockSeries = { '5m': number[]; '1h': number[]; '1d': number[] };

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
export async function collectDefaultedLoans(nowMs: number): Promise<{ pids: string[]; totalOwed: number }> {
  if (!pool) return { pids: [], totalOwed: 0 };
  const { rows } = await pool.query(`SELECT pid, owed FROM loans WHERE due_at <= $1`, [nowMs]);
  const pids = rows.map((r) => r.pid as string);
  if (!pids.length) return { pids: [], totalOwed: 0 };
  const totalOwed = rows.reduce((sum, r) => sum + (Number(r.owed) || 0), 0);
  await pool.query(`UPDATE players SET coins = 0, owned = '', hat = NULL, skin = NULL WHERE id = ANY($1)`, [pids]);
  await pool.query(`DELETE FROM stock_holdings WHERE pid = ANY($1)`, [pids]);
  await pool.query(`DELETE FROM loans WHERE pid = ANY($1)`, [pids]);
  return { pids, totalOwed };
}

export async function getLeaderboard(): Promise<LeaderboardRow[]> {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT name, wins, losses, elo, title
       FROM players
      WHERE wins + losses > 0
      ORDER BY elo DESC, name ASC
      LIMIT $1`,
    [LEADERBOARD_SIZE],
  );
  return rows.map((r) => ({ name: r.name, wins: r.wins, losses: r.losses, elo: r.elo, title: r.title ?? null }));
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
         SELECT sh.pid, SUM(sh.shares * sp.price) AS val
           FROM stock_holdings sh
           JOIN stock_prices sp ON sp.coin = sh.coin
          WHERE sh.shares > 0
          GROUP BY sh.pid
       ) h ON h.pid = p.id
       LEFT JOIN loans l ON l.pid = p.id
      WHERE p.wins + p.losses > 0
         OR p.coins <> 0
         OR h.val IS NOT NULL
         OR l.owed IS NOT NULL
      ORDER BY net DESC, p.name ASC
      LIMIT $1`,
    [LEADERBOARD_SIZE],
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
