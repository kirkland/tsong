// Recent commit history for the in-app CHANGELOG. Read from git at runtime (the VPS
// runs from a checkout on `main`, so this reflects what's actually deployed). Cached
// for a minute so we don't spawn git on every request.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface Commit {
  hash: string; // short hash
  subject: string; // commit message subject line
  date: string; // ISO commit date
}

const COUNT = 30; // how many recent commits to surface
const TTL_MS = 60_000; // re-read at most once a minute
const SEP = '\x1f'; // unit separator — safe inside commit subjects

let cache: Commit[] = [];
let cachedAt = 0;
let inflight: Promise<Commit[]> | null = null;

function parse(stdout: string): Commit[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, date] = line.split(SEP);
      return { hash, subject, date };
    });
}

async function readGitLog(): Promise<Commit[]> {
  // Prefer `main` (what production deploys); fall back to HEAD when developing on a branch.
  for (const ref of ['main', 'HEAD']) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['log', ref, '--no-merges', '-n', String(COUNT), `--pretty=format:%h${SEP}%s${SEP}%cI`],
        { cwd: process.cwd(), timeout: 5000 },
      );
      return parse(stdout);
    } catch {
      // try the next ref
    }
  }
  return [];
}

/** Recent commits on main, cached for a minute. Never rejects — returns [] on failure. */
export async function getChangelog(): Promise<Commit[]> {
  if (Date.now() - cachedAt < TTL_MS && cache.length) return cache;
  if (inflight) return inflight;
  inflight = readGitLog()
    .then((commits) => {
      if (commits.length) {
        cache = commits;
        cachedAt = Date.now();
      }
      return commits.length ? commits : cache;
    })
    .catch((e) => {
      console.error('changelog: git log failed:', e instanceof Error ? e.message : e);
      return cache;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
