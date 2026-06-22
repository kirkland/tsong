// Postgres-backed win/loss leaderboard. Degrades gracefully: if DATABASE_URL is not
// set (e.g. local dev without a DB), every call is a no-op and the leaderboard is
// simply empty, so the rest of the app runs unchanged.

import pg from 'pg';
import { LeaderboardRow, LEADERBOARD_SIZE } from '../shared/types';

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

  // Upsert all players so they exist before we read ELO. Each winner also earns 100 coins.
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
  lastSpin: number; // epoch ms of the last daily spin (0 = never)
  bonusSpins: number; // free extra wheel spins (e.g. from winning a tournament)
}
const EMPTY_WALLET: Wallet = { coins: 0, owned: [], hat: null, skin: null, lastSpin: 0, bonusSpins: 0 };

function rowToWallet(r: { coins: number; owned: string; hat: string | null; skin: string | null; last_spin?: string | number; bonus_spins?: number }): Wallet {
  return {
    coins: r.coins,
    owned: (r.owned || '').split(',').filter(Boolean),
    hat: r.hat ?? null,
    skin: r.skin ?? null,
    lastSpin: Number(r.last_spin ?? 0),
    bonusSpins: Number(r.bonus_spins ?? 0),
  };
}

/** Read a player's wallet (coins + owned items + equipped cosmetics + spin state). */
export async function getWallet(pid: string): Promise<Wallet> {
  if (!pool || !pid) return { ...EMPTY_WALLET };
  const { rows } = await pool.query(`SELECT coins, owned, hat, skin, last_spin, bonus_spins FROM players WHERE id = $1`, [pid]);
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
export async function grantItem(pid: string, name: string, item: string): Promise<Wallet | null> {
  if (!pool || !pid) return null;
  const cur = await getWallet(pid);
  if (cur.owned.includes(item)) return cur;
  const owned = [...cur.owned, item].join(',');
  const { rows } = await pool.query(
    `UPDATE players SET owned = $2 WHERE id = $1 RETURNING coins, owned, hat, skin, last_spin`,
    [pid, owned],
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
       RETURNING coins, owned, hat, skin`,
    [pid, price, owned],
  );
  return rows.length ? rowToWallet(rows[0]) : null;
}

/** Equip (or unequip with item=null) a cosmetic in a slot. Only equips owned items. */
export async function equipItem(pid: string, slot: 'hat' | 'skin', item: string | null): Promise<Wallet | null> {
  if (!pool || !pid) return null;
  const cur = await getWallet(pid);
  if (item !== null && !cur.owned.includes(item)) return null; // can't equip what you don't own
  const col = slot === 'hat' ? 'hat' : 'skin';
  const { rows } = await pool.query(
    `UPDATE players SET ${col} = $2 WHERE id = $1 RETURNING coins, owned, hat, skin`,
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
       RETURNING coins, owned, hat, skin`,
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
       RETURNING coins, owned, hat, skin`,
    [pid, name, delta],
  );
  return rows.length ? rowToWallet(rows[0]) : null;
}

export async function getLeaderboard(): Promise<LeaderboardRow[]> {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT name, wins, losses, elo
       FROM players
      WHERE wins + losses > 0
      ORDER BY elo DESC, name ASC
      LIMIT $1`,
    [LEADERBOARD_SIZE],
  );
  return rows.map((r) => ({ name: r.name, wins: r.wins, losses: r.losses, elo: r.elo }));
}
