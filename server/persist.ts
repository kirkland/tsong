// Best-effort game-state persistence across restarts. On a graceful shutdown (a deploy
// sends SIGTERM) the server writes a snapshot of the game + lobby to a JSON file; the
// next process reads it on boot so an in-progress match survives the restart instead of
// being lost. Plain file storage, so it works with or without a database, and a tiny
// synchronous write in the signal handler is reliable.

import fs from 'node:fs';
import path from 'node:path';

const STATE_FILE = process.env.TSONG_STATE_FILE
  ? path.resolve(process.env.TSONG_STATE_FILE)
  : path.resolve(process.cwd(), '.tsong-state.json');

const SNAPSHOT_VERSION = 1; // bump when the snapshot shape changes (old files are ignored)
const MAX_AGE_MS = 10 * 60 * 1000; // ignore snapshots older than this — stale to resume

export interface Snapshot<G = unknown, L = unknown> {
  version: number;
  savedAt: number; // epoch ms; used to discard stale snapshots
  game: G;
  lobby: L;
}

/** Write a snapshot synchronously. Called from the shutdown signal handler. */
export function saveSnapshot(game: unknown, lobby: unknown): void {
  try {
    const snap: Snapshot = { version: SNAPSHOT_VERSION, savedAt: Date.now(), game, lobby };
    fs.writeFileSync(STATE_FILE, JSON.stringify(snap), 'utf8');
  } catch (e) {
    console.error('snapshot save failed:', e);
  }
}

/**
 * Read and consume the snapshot left by the previous process, or null if there's
 * nothing usable. The file is deleted on read (one-shot): a later unrelated restart, or
 * a crash, should start clean rather than resurrect an old match.
 */
export function loadSnapshot<G, L>(): Snapshot<G, L> | null {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    fs.unlinkSync(STATE_FILE);
    const snap = JSON.parse(raw) as Snapshot<G, L>;
    if (snap.version !== SNAPSHOT_VERSION) return null;
    if (typeof snap.savedAt !== 'number' || Date.now() - snap.savedAt > MAX_AGE_MS) {
      console.log('snapshot too old or invalid — ignoring');
      return null;
    }
    return snap;
  } catch (e) {
    console.error('snapshot load failed:', e);
    return null;
  }
}
