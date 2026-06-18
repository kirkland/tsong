// Recent commit history for the in-app CHANGELOG. Read from git at runtime (the VPS
// runs from a checkout on `main`, so this reflects what's actually deployed). Cached
// for a minute so we don't spawn git on every request.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface Commit {
  hash: string; // short hash
  subject: string; // commit message subject line
  author: string; // commit author name
  date: string; // ISO commit date
  url?: string; // GitHub link to the commit, when the origin remote is a GitHub repo
}

const COUNT = 30; // how many recent commits to surface
const TTL_MS = 60_000; // re-read at most once a minute
const SEP = '\x1f'; // unit separator — safe inside commit subjects

let cache: Commit[] = [];
let cachedAt = 0;
let inflight: Promise<Commit[]> | null = null;
let repoBase: string | null | undefined; // GitHub web base for the repo; undefined = not yet resolved

// Turn an `origin` remote URL into the repo's GitHub web base, or null if it isn't a
// GitHub remote. Handles https, scp-style (git@github.com:owner/repo.git), and custom SSH
// host aliases (e.g. github.com.personal:owner/repo.git) — the host is always rebuilt as
// github.com, so an alias still resolves correctly.
function toGithubBase(remote: string): string | null {
  if (!/github/i.test(remote)) return null;
  const s = remote.trim().replace(/\.git$/, '');
  let path: string | null = null;
  if (/^https?:\/\//.test(s)) {
    try {
      path = new URL(s).pathname.replace(/^\//, '');
    } catch {
      return null;
    }
  } else {
    // scp-like: [user@]host:owner/repo
    const m = s.match(/^(?:[^@]+@)?[^:/]+:(.+)$/);
    if (m) path = m[1];
  }
  const owner = path?.match(/([^/]+)\/([^/]+)$/);
  return owner ? `https://github.com/${owner[1]}/${owner[2]}` : null;
}

// The repo's GitHub web base, resolved from `git remote get-url origin` and memoized
// (it doesn't change while the process runs). null when there's no GitHub origin.
async function getRepoBase(): Promise<string | null> {
  if (repoBase !== undefined) return repoBase;
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: process.cwd(),
      timeout: 5000,
    });
    repoBase = toGithubBase(stdout);
  } catch {
    repoBase = null;
  }
  return repoBase;
}

function parse(stdout: string): Commit[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, author, date] = line.split(SEP);
      return { hash, subject, author, date };
    });
}

async function readGitLog(): Promise<Commit[]> {
  // Prefer `main` (what production deploys); fall back to HEAD when developing on a branch.
  const base = await getRepoBase();
  for (const ref of ['main', 'HEAD']) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['log', ref, '--no-merges', '-n', String(COUNT), `--pretty=format:%h${SEP}%s${SEP}%an${SEP}%cI`],
        { cwd: process.cwd(), timeout: 5000 },
      );
      const commits = parse(stdout);
      // GitHub resolves short hashes in commit URLs, so the abbreviated %h is fine here.
      return base ? commits.map((c) => ({ ...c, url: `${base}/commit/${c.hash}` })) : commits;
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
