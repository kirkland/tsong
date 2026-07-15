// Usage analytics: a tiny in-process event tracker. Every notable player action becomes one
// event — a dot-namespaced name like 'game.doom.play', 'casino.slots', or 'visit.bar' — plus
// who did it and when. Events are buffered here and batch-flushed to the Postgres `events`
// table every few seconds (a no-op without DATABASE_URL, like all persistence). A small
// in-memory ring keeps the most recent events either way, so the Observatory still has live
// data in dev and the numbers survive nothing fancier than a page refresh.
//
// Event taxonomy (the charts group by the first two dot segments):
//   session.join         a socket identified itself (first join per connection)
//   game.<name>.<verb>   a game was played/started/settled ('game played' charts use segment 2)
//   casino.<game>        a casino bet/roll/spin
//   economy.<thing>      shop, market, land, loans, tips, wishes…
//   social.<thing>       chat, reactions
//   world.<thing>        overworld happenings
//   visit.<place>        client-reported: walked into a building/room (server-prefixed, so a
//                        tampered client can't forge server-authoritative names)

import { getUsageStatsFromDb, insertUsageEvents } from './db';
import { UsageStats } from '../shared/types';

interface UsageEvent { ts: number; pid: string; who: string; name: string }

const RING_MAX = 5000;    // most-recent events kept in memory (dev fallback + live feed)
const FLUSH_MS = 10_000;  // batch window for DB writes
const NAME_RE = /^[a-z0-9_.-]{1,64}$/i;

const ring: UsageEvent[] = [];
let buf: UsageEvent[] = [];
let flushTimer: NodeJS.Timeout | null = null;

/** Record one usage event. Cheap and synchronous — safe to call from hot paths. */
export function track(pid: string, who: string, name: string): void {
  if (!NAME_RE.test(name)) return;
  const ev: UsageEvent = { ts: Date.now(), pid, who: who.slice(0, 24), name };
  ring.push(ev);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  buf.push(ev);
  if (!flushTimer) {
    flushTimer = setTimeout(() => { void flushAnalytics(); }, FLUSH_MS);
    flushTimer.unref?.();
  }
}

/** Write the buffered batch to the DB. Called on a timer and once more on shutdown. */
export async function flushAnalytics(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!buf.length) return;
  const batch = buf;
  buf = [];
  try {
    await insertUsageEvents(batch);
  } catch (e) {
    console.error('analytics flush failed:', e);
  }
}

/** The Observatory's data: DB-backed when there is one, otherwise aggregated from the ring
 *  (marked source:'memory' so the charts can say "since last restart"). */
export async function usageStats(onlineNow: number): Promise<UsageStats> {
  const base = { generatedAt: Date.now(), onlineNow };
  try {
    const db = await getUsageStatsFromDb();
    if (db) {
      // The freshest events may still be in the buffer — splice them into the feed so the
      // ticker never lags the batch window.
      const feed = [...buf].reverse().map(({ ts, who, name }) => ({ t: ts, who, name }))
        .concat(db.feed).slice(0, 14);
      return { ...base, source: 'db', ...db, feed };
    }
  } catch (e) {
    console.error('usage stats query failed:', e);
  }
  return { ...base, source: 'memory', ...aggregateRing() };
}

// --- in-memory fallback (no DATABASE_URL): same shape, computed from the ring ---------------

function aggregateRing(): Omit<UsageStats, 'generatedAt' | 'source' | 'onlineNow'> {
  const now = Date.now();
  const H = 3600_000, D = 24 * H;
  const since = (ms: number) => ring.filter((e) => e.ts > now - ms);
  const last24 = since(D), last7d = since(7 * D);

  const countBy = (evs: UsageEvent[], key: (e: UsageEvent) => string | null): Map<string, number> => {
    const m = new Map<string, number>();
    for (const e of evs) {
      const k = key(e);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
  const seg2 = (prefix: string) => (e: UsageEvent) =>
    e.name.startsWith(prefix) ? e.name.split('.')[1] ?? null : null;

  // Hour buckets, oldest → newest, matching the DB query's date_trunc('hour') semantics.
  const hourly: UsageStats['hourly'] = [];
  for (let t = Math.floor((now - 48 * H) / H) * H + H; t <= now; t += H) {
    const evs = ring.filter((e) => e.ts >= t && e.ts < t + H);
    if (evs.length) hourly.push({ t, events: evs.length, players: new Set(evs.filter((e) => e.pid).map((e) => e.pid)).size });
  }
  const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10);
  const daily: UsageStats['daily'] = [...countBy(since(14 * D), (e) => dayKey(e.ts)).keys()].sort().map((day) => {
    const evs = ring.filter((e) => dayKey(e.ts) === day);
    return { day, players: new Set(evs.filter((e) => e.pid).map((e) => e.pid)).size, events: evs.length };
  });

  const byPid = countBy(last7d.filter((e) => e.pid), (e) => e.pid);
  let star: UsageStats['starOfWeek'] = null;
  for (const [pid, events] of byPid) {
    if (!star || events > star.events) {
      const who = last7d.find((e) => e.pid === pid)?.who ?? '';
      if (who) star = { who, events };
    }
  }

  return {
    players24h: new Set(last24.filter((e) => e.pid).map((e) => e.pid)).size,
    events24h: last24.length,
    games24h: last24.filter((e) => e.name.startsWith('game.')).length,
    hourly,
    daily,
    games7d: top(countBy(last7d, seg2('game.')), 10).map(([game, plays]) => ({ game, plays })),
    visits7d: top(countBy(last7d, seg2('visit.')), 10).map(([building, visits]) => ({ building, visits })),
    actions7d: top(countBy(last7d, (e) => e.name), 10).map(([name, count]) => ({ name, count })),
    feed: [...ring].slice(-14).reverse().map(({ ts, who, name }) => ({ t: ts, who, name })),
    starOfWeek: star,
  };
}
