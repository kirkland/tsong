// "Type or Die" — a server-authoritative co-op typing horde-defense minigame.
//
// One shared global arena that any number of players drop into. Waves of word-bearing monsters
// march down toward a shared base; type a monster's word to destroy it before it reaches the
// base. Base HP, wave and score are all SHARED, so more typists = more of the swarm handled =
// deeper waves — exactly the "more people online is better" pull.
//
// Authoritative here: this owns enemy spawns, positions, the base HP and scoring. Clients render
// the broadcast state and send a soft target-lock (`target`) plus a kill claim (`claimKill`)
// when they finish typing a word; both are validated here (first valid claim wins a kill).
//
// Lifecycle: idle (nobody in) → lobby (players gathered, waiting) → countdown → playing →
// gameover (stats linger) → lobby. Ticked from the lobby's 60 Hz loop; broadcast is throttled.

import type { TdEnemy, TdKind, TdPhase, TdPlayer } from '../shared/types';

// --- balance knobs --------------------------------------------------------------------------
const BASE_MAX = 100;          // shared base hit points
const COUNTDOWN = 3;           // seconds of 3-2-1 before a run begins
const GAMEOVER_SECS = 8;       // how long the gameover board lingers before returning to lobby
const BREATHER_SECS = 2.2;     // pause between cleared waves

// Per-kind tuning. `speed` is field-units/sec down the screen (1.0 = top→base in one second).
const KIND: Record<TdKind, { speed: number; dmg: number }> = {
  normal: { speed: 0.030, dmg: 8 },
  fast:   { speed: 0.072, dmg: 6 },
  boss:   { speed: 0.020, dmg: 40 },
  coin:   { speed: 0.045, dmg: 0 }, // a bonus monster: harmless if it escapes, coins if you kill it
};

// Word bank, tiered by length. Lowercase a–z only (typed case-insensitively, no spaces).
const SHORT = 'cat dog run hit ace net top spin lob pong jump fast slam dink dash bolt zap kick volt rush gel mug paw rim tap'.split(' ');
const MED = 'paddle rally serve bounce smash player rocket strike target zombie goblin danger plasma rubber bishop frozen sprint glider tunnel friend marble pickle ginger basket pocket'.split(' ');
const LONG = 'avalanche butterfly knapsack juxtapose quicksand telescope volleyball xylophone marshmallow chandelier wavelength brainstorm playground mechanism cornerstone background tournament discipline kangaroo dangerous'.split(' ');
const BOSS = 'catastrophe exterminate unstoppable supercalifrag obliteration thunderstruck checkmatewins gigantosaurus pulverizer apocalypse'.split(' ');

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

interface Enemy {
  id: number;
  x: number; y: number;
  speed: number; dmg: number;
  word: string;
  kind: TdKind;
  lockedBy: string | null; // participant id soft-locking this word (advisory; cleared on death)
  alive: boolean;
}
interface Player { id: string; name: string; color: string; kills: number; }

// Hooks back into the lobby so the pure sim can grant coins mid-run and report a finished run.
export interface TypeGameHooks {
  award: (playerId: string, coins: number) => void;            // grant a coin pickup to a player
  ended: (wave: number, players: { id: string; name: string; kills: number }[]) => void;
  announce: (text: string) => void;                            // room-wide banner (e.g. a new boss)
}

export class TypeGame {
  phase: TdPhase = 'lobby';
  private players = new Map<string, Player>(); // keyed by connection id
  private enemies: Enemy[] = [];
  private baseHp = BASE_MAX;
  private wave = 0;
  private score = 0;
  private mvp: string | null = null;

  private nextId = 1;
  private spawnQueue: TdKind[] = []; // remaining spawns for the current wave (head spawns next)
  private spawnTimer = 0;            // seconds until the next spawn pops off the queue
  private spawnInterval = 1;         // current gap between spawns
  private breather = 0;              // seconds left before the next wave builds
  private countdown = 0;             // seconds left in the pre-run 3-2-1
  private overTimer = 0;             // seconds left on the gameover board

  constructor(private hooks: TypeGameHooks) {}

  /** Is anyone in the arena (so the lobby knows whether to bother broadcasting)? */
  get active(): boolean { return this.players.size > 0; }

  /** A player opens / drops into the arena. They can jump straight into a live run. */
  join(id: string, name: string, color: string) {
    if (this.players.has(id)) return;
    this.players.set(id, { id, name, color, kills: 0 });
    // First player into an empty, settled arena → start a fresh waiting room.
    if (this.players.size === 1 && (this.phase === 'gameover')) this.toLobby();
  }

  /** A player leaves / closes the arena (or disconnects). Empties → reset to a clean lobby. */
  leave(id: string) {
    if (!this.players.delete(id)) return;
    for (const e of this.enemies) if (e.lockedBy === id) e.lockedBy = null;
    if (this.players.size === 0) {
      // Nobody left — abandon any run silently and settle back to an idle lobby.
      this.enemies = [];
      this.phase = 'lobby';
      this.wave = 0; this.score = 0; this.baseHp = BASE_MAX; this.mvp = null;
      this.spawnQueue = []; this.breather = 0; this.countdown = 0; this.overTimer = 0;
    }
  }

  /** Any waiting-room participant kicks off the run. */
  start() {
    if (this.phase !== 'lobby' || this.players.size === 0) return;
    this.phase = 'countdown';
    this.countdown = COUNTDOWN;
    this.baseHp = BASE_MAX;
    this.wave = 0;
    this.score = 0;
    this.mvp = null;
    this.enemies = [];
    this.spawnQueue = [];
    this.breather = 0;
    for (const p of this.players.values()) p.kills = 0;
  }

  /** Soft-lock the monster a player is mid-word on (advisory, so clients don't fight a word). */
  target(id: string, enemyId: number | null) {
    if (!this.players.has(id)) return;
    for (const e of this.enemies) if (e.lockedBy === id) e.lockedBy = null;
    if (enemyId === null) return;
    const e = this.enemies.find((x) => x.id === enemyId && x.alive);
    if (e && (!e.lockedBy || e.lockedBy === id)) e.lockedBy = id;
  }

  /** A player finished typing a word — claim the kill. First valid claim wins it. */
  claimKill(id: string, enemyId: number) {
    if (this.phase !== 'playing') return;
    const p = this.players.get(id);
    if (!p) return;
    const e = this.enemies.find((x) => x.id === enemyId && x.alive);
    if (!e) return; // already dead / never existed — the racer who got here first took it
    e.alive = false;
    p.kills++;
    // Score rewards longer words and special kinds.
    const bonus = e.kind === 'boss' ? 50 : e.kind === 'fast' ? 4 : 0;
    this.score += e.word.length + bonus;
    if (e.kind === 'coin') {
      const coins = 1 + Math.floor(Math.random() * 2); // 1–2 coins
      this.hooks.award(id, coins);
    }
  }

  /** Advance the sim one tick (dt seconds). Called every server tick by the lobby. */
  tick(dt: number) {
    if (this.players.size === 0) return;

    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) { this.phase = 'playing'; this.buildWave(); }
      return;
    }

    if (this.phase === 'gameover') {
      this.overTimer -= dt;
      if (this.overTimer <= 0) this.toLobby();
      return;
    }

    if (this.phase !== 'playing') return;

    // Between-wave breather, then build the next wave.
    if (this.breather > 0) {
      this.breather -= dt;
      if (this.breather <= 0) this.buildWave();
    }

    // Spawn from the queue on a timer.
    if (this.spawnQueue.length > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnEnemy(this.spawnQueue.shift()!);
        this.spawnTimer = this.spawnInterval;
      }
    }

    // March monsters toward the base; a reached monster damages the base and is removed.
    for (const e of this.enemies) {
      if (!e.alive) continue;
      e.y += e.speed * dt;
      if (e.y >= 1) {
        e.alive = false;
        if (e.dmg > 0) this.baseHp = Math.max(0, this.baseHp - e.dmg);
      }
    }
    this.enemies = this.enemies.filter((e) => e.alive);

    // Base destroyed → game over.
    if (this.baseHp <= 0) { this.endRun(); return; }

    // Wave cleared (nothing left to spawn and field is empty) → breather before the next.
    if (this.spawnQueue.length === 0 && this.enemies.length === 0 && this.breather <= 0) {
      this.breather = BREATHER_SECS;
    }
  }

  // --- internals ----------------------------------------------------------------------------

  private toLobby() {
    this.phase = 'lobby';
    this.enemies = [];
    this.wave = 0; this.score = 0; this.baseHp = BASE_MAX; this.mvp = null;
    this.spawnQueue = []; this.breather = 0; this.countdown = 0; this.overTimer = 0;
    for (const p of this.players.values()) p.kills = 0;
  }

  private endRun() {
    this.phase = 'gameover';
    this.overTimer = GAMEOVER_SECS;
    this.enemies = [];
    this.spawnQueue = [];
    // Crown the word wizard.
    let top: Player | null = null;
    for (const p of this.players.values()) if (!top || p.kills > top.kills) top = p;
    this.mvp = top && top.kills > 0 ? top.name : null;
    this.hooks.ended(this.wave, [...this.players.values()].map((p) => ({ id: p.id, name: p.name, kills: p.kills })));
  }

  private buildWave() {
    this.wave++;
    this.breather = 0;
    const w = this.wave;
    const count = 4 + Math.floor(w * 1.5);
    const q: TdKind[] = [];
    if (w % 5 === 0) {
      q.push('boss');
      this.hooks.announce(`🌊 Wave ${w} — BOSS incoming! Type fast or die.`);
    }
    for (let i = 0; i < count; i++) {
      const r = Math.random();
      if (w >= 2 && r < 0.08) q.push('coin');
      else if (w >= 3 && r < 0.30) q.push('fast');
      else q.push('normal');
    }
    this.spawnQueue = q;
    this.spawnTimer = 0.4; // first monster drops in shortly after the wave starts
    this.spawnInterval = Math.max(0.45, 1.4 - w * 0.05);
  }

  private spawnEnemy(kind: TdKind) {
    const w = this.wave;
    const base = KIND[kind];
    // Speed creeps up with the wave (capped) so late waves genuinely outpace slow typists.
    const speed = base.speed + (kind === 'boss' ? 0 : Math.min(w * 0.0035, 0.05));
    this.enemies.push({
      id: this.nextId++,
      x: 0.08 + Math.random() * 0.84,
      y: -0.02 - Math.random() * 0.06, // stagger slightly above the top edge
      speed,
      dmg: base.dmg,
      word: this.pickWord(kind, w),
      kind,
      lockedBy: null,
      alive: true,
    });
  }

  private pickWord(kind: TdKind, w: number): string {
    if (kind === 'boss') return pick(BOSS);
    if (kind === 'fast') return pick(SHORT);
    if (kind === 'coin') return pick(SHORT);
    const tier = w <= 2 ? SHORT : w <= 5 ? MED : LONG;
    return pick(tier);
  }

  /** Build the wire snapshot. `you` is filled in per-recipient by the lobby. */
  snapshot(): {
    phase: TdPhase; players: TdPlayer[]; enemies: TdEnemy[]; baseHp: number; baseMax: number;
    wave: number; score: number; countdown: number; overIn: number; mvp: string | null;
  } {
    return {
      phase: this.phase,
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, kills: p.kills })),
      enemies: this.enemies.map((e) => ({ id: e.id, x: e.x, y: e.y, word: e.word, kind: e.kind, lockedBy: e.lockedBy })),
      baseHp: this.baseHp,
      baseMax: BASE_MAX,
      wave: this.wave,
      score: this.score,
      countdown: Math.max(0, Math.ceil(this.countdown)),
      overIn: Math.max(0, Math.ceil(this.overTimer)),
      mvp: this.mvp,
    };
  }
}
