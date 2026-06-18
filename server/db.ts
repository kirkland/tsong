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

  // Upsert all players so they exist before we read ELO.
  for (const w of winners) {
    await pool.query(
      `INSERT INTO players (id, name, wins) VALUES ($1, $2, 1)
         ON CONFLICT (id) DO UPDATE SET wins = players.wins + 1, name = EXCLUDED.name`,
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
