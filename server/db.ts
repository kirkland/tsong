// Postgres-backed win/loss leaderboard. Degrades gracefully: if DATABASE_URL is not
// set (e.g. local dev without a DB), every call is a no-op and the leaderboard is
// simply empty, so the rest of the app runs unchanged.

import pg from 'pg';
import { LeaderboardRow, LEADERBOARD_MIN_GAMES, LEADERBOARD_SIZE } from '../shared/types';

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
      losses INTEGER NOT NULL DEFAULT 0
    )
  `);
  console.log('leaderboard DB ready');
}

export interface PlayerRef {
  pid: string;
  name: string;
}

// Record a finished match: every player on the winning team gets a win, every player
// on the losing team a loss (a 1v1 is just the one-per-side case).
export async function recordResult(winners: PlayerRef[], losers: PlayerRef[]): Promise<void> {
  if (!pool) return;
  // Upsert by id; refresh the stored name to the latest nickname each time.
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
}

/** Update an existing player's display name (for renames). Returns rows changed. */
export async function updateName(id: string, name: string): Promise<number> {
  if (!pool) return 0;
  const res = await pool.query(`UPDATE players SET name = $2 WHERE id = $1`, [id, name]);
  return res.rowCount ?? 0;
}

export async function getLeaderboard(): Promise<LeaderboardRow[]> {
  if (!pool) return [];
  // Players with enough games rank first, ordered by win%, then total wins.
  const { rows } = await pool.query(
    `SELECT name, wins, losses
       FROM players
      ORDER BY (wins + losses >= $1) DESC,
               (wins::float / NULLIF(wins + losses, 0)) DESC NULLS LAST,
               wins DESC,
               name ASC
      LIMIT $2`,
    [LEADERBOARD_MIN_GAMES, LEADERBOARD_SIZE],
  );
  return rows.map((r) => ({ name: r.name, wins: r.wins, losses: r.losses }));
}
