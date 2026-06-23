// 🎙️  The Tsong Ear — ambient idea capture.
//
// Listens to live transcript, notices when someone is proposing a feature/change for Tsong,
// turns it into a crisp spec, and (with your blessing) hands it to Claude Code to implement.
//
// Pipeline:  transcript → Gate-1 (cheap Haiku "is this a Tsong idea?") → Gate-2 (spec it)
//            → approval prompt → `claude -p` implements + commits (+ pushes) in the repo.
//
// Two ways to feed it audio:
//   1. Local whisper.cpp streaming (private, free) — set WHISPER_STREAM to its `stream` binary.
//      The script spawns it and reads its stdout.   See ./README.md for the one-time build.
//   2. Pipe ANY speech-to-text into stdin, one chunk per line:
//        ./stream -m model.bin ... | npx tsx tools/listener/listen.ts
//      (also makes --dry-run trivially testable:  echo "hey tsong make the ball bigger" | … )
//
// Flags:
//   --dry-run        detect + print ideas, never write code (safe default for first runs)
//   --no-wake        fully ambient (default requires the wake phrase below to arm capture)
//   --wake "phrase"  set the wake phrase (default: "hey tsong")
//   --yes            auto-approve implementation (full chaos mode; otherwise it asks)
//   --push           let the implement step push to the remote (default: commit only)
//
//   WHISPER_STREAM=/path/to/whisper.cpp/stream  WHISPER_MODEL=/path/to/ggml-base.en.bin \
//     npx tsx tools/listener/listen.ts --dry-run

import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---- args ----------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string, d: string) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const DRY_RUN = has('--dry-run');
const USE_WAKE = !has('--no-wake');
const WAKE = val('--wake', 'hey tsong').toLowerCase();
const AUTO_YES = has('--yes');
const ALLOW_PUSH = has('--push');

// ---- tuning --------------------------------------------------------------
const WINDOW_LINES = 12;        // rolling transcript context handed to Gate-1
const WAKE_ARM_MS = 30_000;     // after the wake phrase, capture stays armed this long
const COOLDOWN_MS = 20_000;     // min gap between Gate-1 calls (cost/noise control)
const DEDUP_KEEP = 20;          // remember this many recent ideas to avoid re-triggering

// ---- claude helper -------------------------------------------------------
// `claude -p --output-format json` returns an envelope { result: "<model text>", ... }.
// We ask the model for JSON; strip any ``` fences before parsing.
function claude(prompt: string, args: string[] = []): Promise<string> {
  return new Promise((res, rej) => {
    const p = spawn('claude', ['-p', prompt, ...args], { cwd: REPO });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', rej);
    p.on('close', (code) =>
      code === 0 ? res(out) : rej(new Error(`claude exited ${code}: ${err.trim()}`)),
    );
  });
}

function parseJsonLoose<T>(s: string): T | null {
  const cleaned = s.replace(/```(?:json)?/gi, '').trim();
  const a = cleaned.indexOf('{');
  const b = cleaned.lastIndexOf('}');
  if (a < 0 || b < 0) return null;
  try {
    return JSON.parse(cleaned.slice(a, b + 1)) as T;
  } catch {
    return null;
  }
}

async function gate1Detect(window: string): Promise<{ hit: boolean; idea: string }> {
  const envelope = await claude(
    `You are watching a live transcript of ambient conversation in a room.\n` +
      `Tsong is a multiplayer ping-pong/Pong web game.\n` +
      `Transcript (most recent last):\n"""${window}"""\n\n` +
      `Is someone proposing a CONCRETE, implementable feature or change for Tsong ` +
      `(a game mechanic, mode, visual, sound, UI, easter egg, balance tweak, etc.)?\n` +
      `Idle chit-chat, questions, or vague wishes do NOT count.\n` +
      `Reply with ONLY JSON: {"hit": boolean, "idea": "<one crisp sentence, or empty>"}`,
    ['--model', 'haiku', '--output-format', 'json'],
  );
  const env = parseJsonLoose<{ result: string }>(envelope);
  const inner = env?.result ? parseJsonLoose<{ hit: boolean; idea: string }>(env.result) : null;
  return inner ?? { hit: false, idea: '' };
}

async function gate2Spec(idea: string): Promise<string> {
  const envelope = await claude(
    `Turn this overheard Tsong feature idea into a short, implementable spec for a developer.\n` +
      `Idea: "${idea}"\n` +
      `Give 2-4 sentences: what to build and where it likely lives (client render vs. server sim vs. shared types). ` +
      `No preamble.`,
    ['--model', 'haiku', '--output-format', 'json'],
  );
  const env = parseJsonLoose<{ result: string }>(envelope);
  return (env?.result ?? idea).trim();
}

async function implement(spec: string): Promise<void> {
  const push = ALLOW_PUSH ? 'Then push.' : 'Do NOT push — leave the commit local for review.';
  console.log('🤖 Handing to Claude Code…\n');
  // Inherit stdio so the implementation run streams live to this terminal.
  await new Promise<void>((res, rej) => {
    const p = spawn(
      'claude',
      [
        '-p',
        `A feature idea for Tsong was overheard in conversation. Implement it.\n\n` +
          `Spec: ${spec}\n\n` +
          `Follow CLAUDE.md (maximize fun; keep 2-player mode unchanged). ` +
          `Make a coherent, working change and commit it with a clear message. ${push}`,
        '--permission-mode',
        'acceptEdits',
      ],
      { cwd: REPO, stdio: 'inherit' },
    );
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`implement run exited ${c}`))));
  });
}

// ---- approval prompt -----------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q: string): Promise<string> {
  return new Promise((res) => rl.question(q, res));
}

// ---- main loop -----------------------------------------------------------
const window: string[] = [];
const recentIdeas: string[] = [];
let lastGateAt = 0;
let armedUntil = USE_WAKE ? 0 : Number.MAX_SAFE_INTEGER; // no-wake => always armed
let busy = false;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();

function isDuplicate(idea: string): boolean {
  const n = norm(idea);
  return recentIdeas.some((r) => r === n || r.includes(n) || n.includes(r));
}

async function onLine(raw: string) {
  const line = raw.trim();
  if (!line) return;
  window.push(line);
  while (window.length > WINDOW_LINES) window.shift();

  const now = Date.now();

  // Wake phrase arms capture for a while. Don't return — the idea may be in the same breath
  // ("hey tsong, make the ball bigger"), so fall through and let Gate-1 see this line too.
  if (USE_WAKE && now > armedUntil && norm(line).includes(norm(WAKE))) {
    armedUntil = now + WAKE_ARM_MS;
    console.log(`👂 Armed (heard "${WAKE}") — listening for an idea…`);
  }

  if (busy || now > armedUntil) return;
  if (now - lastGateAt < COOLDOWN_MS) return;
  lastGateAt = now;

  let res;
  try {
    res = await gate1Detect(window.join(' '));
  } catch (e) {
    console.error('⚠️  Gate-1 failed:', (e as Error).message);
    return;
  }
  if (!res.hit || !res.idea) return;
  if (isDuplicate(res.idea)) return;

  recentIdeas.push(norm(res.idea));
  while (recentIdeas.length > DEDUP_KEEP) recentIdeas.shift();

  console.log(`\n💡 Detected idea: ${res.idea}`);

  if (DRY_RUN) {
    console.log('   (--dry-run: not implementing)\n');
    return;
  }

  busy = true;
  try {
    const spec = await gate2Spec(res.idea);
    console.log(`📋 Spec: ${spec}\n`);
    if (!AUTO_YES) {
      const a = (await ask('   Implement this? [y/N] ')).trim().toLowerCase();
      if (a !== 'y' && a !== 'yes') {
        console.log('   Skipped.\n');
        return;
      }
    }
    await implement(spec);
    console.log('✅ Done.\n');
  } catch (e) {
    console.error('⚠️  Implementation failed:', (e as Error).message);
  } finally {
    window.length = 0; // fresh context after acting
    busy = false;
  }
}

// ---- input source --------------------------------------------------------
function banner() {
  console.log('🎙️  The Tsong Ear is listening.');
  console.log(`    mode:   ${DRY_RUN ? 'DRY RUN (no code)' : AUTO_YES ? 'auto-implement' : 'ask-before-implement'}`);
  console.log(`    wake:   ${USE_WAKE ? `"${WAKE}"` : 'OFF (fully ambient)'}`);
  console.log(`    push:   ${ALLOW_PUSH ? 'yes' : 'commit only'}`);
  console.log('    (Ctrl-C to stop)\n');
}

function start() {
  banner();
  const streamBin = process.env.WHISPER_STREAM;
  if (streamBin) {
    const model = process.env.WHISPER_MODEL ?? 'models/ggml-base.en.bin';
    console.log(`Spawning whisper: ${streamBin} -m ${model}\n`);
    const ww = spawn(streamBin, ['-m', model, '-t', '6', '--step', '3000', '--length', '8000'], {
      cwd: dirname(streamBin),
    });
    ww.on('error', (e) => {
      console.error(`Could not start WHISPER_STREAM (${streamBin}): ${e.message}`);
      console.error('See tools/listener/README.md to build whisper.cpp, or pipe transcript via stdin.');
      process.exit(1);
    });
    const r = readline.createInterface({ input: ww.stdout });
    r.on('line', (l) => void onLine(l));
  } else {
    // Read transcript from stdin (pipe your own STT here).
    const r = readline.createInterface({ input: process.stdin, terminal: false });
    r.on('line', (l) => void onLine(l));
    r.on('close', () => process.exit(0));
  }
}

start();
