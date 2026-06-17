// Authoritative "Arena" simulation: a free-for-all on a regular polygon. Each seated
// player owns one edge of an N-gon (3–8 sides). A ball caroms around the inside; when it
// slips past a living player's edge, that player is knocked out and their edge turns into
// a solid wall. Last player standing wins. Knows nothing about networking or nicknames —
// the Lobby drives it and attaches names/colors when it builds the broadcast.
//
// The classic 1v1 rectangular court lives in game.ts and is untouched; this file only
// ever runs for 3+ players with arena mode armed.

import {
  BALL,
  ARENA,
  POLY_PADDLE_LEN,
  PADDLE,
  MAX_BOUNCE,
  SERVE_DELAY,
  PADDLE_BOOST,
  SMASH_BONUS,
  SLOW_SCALE,
  SLOW_TIME,
  MULTI_MAX,
  POWERUP_HITS,
  GHOST_TIME,
  TINY_TIME,
  BIG_BALL_TIME,
  BIG_BALL_R,
  CURVE_SPIN,
  POLY_POWERUPS,
  TARGET,
  PowerupKind,
  Status,
} from '../shared/types';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number; // rad/s; positive = counter-clockwise; decays each tick
}

// One player's paddle on its edge. `pos` is the signed offset along the edge from its
// midpoint (court units); per-player power-up charges live here too.
interface PolyEnt {
  id: string;
  pos: number;
  targetPos: number;
  alive: boolean;
  growHits: number;
  smashHits: number;
  curveHits: number;
  shielded: boolean;
}

// Precomputed geometry for one edge of the polygon.
interface Edge {
  mx: number; // midpoint
  my: number;
  dx: number; // unit direction along the edge (from vertex i toward i+1)
  dy: number;
  nx: number; // inward unit normal (points toward the polygon center)
  ny: number;
  half: number; // half the edge length, court units
}

function dist2ToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

export class PolyGame {
  players: PolyEnt[] = []; // one per edge, in join order; edge i spans vert i → i+1
  ball: Ball = { x: ARENA.cx, y: ARENA.cy, vx: 0, vy: 0, spin: 0 };
  extraBalls: Ball[] = [];
  status: Status = 'waiting';
  paused = false; // frozen until every seated player has captured their mouse
  lastHitId: string | null = null; // id of the player whose paddle last touched a ball
  winnerId: string | null = null; // last player standing, when status === 'over'

  // Power-up target on the board; bouncing a ball over it grants its kind to the last hitter.
  target: { x: number; y: number; kind: PowerupKind } | null = null;
  slowTimer = 0;
  ghostTimer = 0;
  tinyTimer = 0;
  bigBallTimer = 0;

  private serveTimer = 0;
  private targetTimer = 0;

  get n(): number {
    return this.players.length;
  }

  get aliveCount(): number {
    return this.players.reduce((c, p) => c + (p.alive ? 1 : 0), 0);
  }

  hasPlayer(id: string): boolean {
    return this.players.some((p) => p.id === id);
  }

  /** Seat a player on the next free edge. Order = join order (fixes which edge is theirs). */
  addPlayer(id: string) {
    if (this.hasPlayer(id)) return;
    this.players.push({
      id,
      pos: 0,
      targetPos: 0,
      alive: true,
      growHits: 0,
      smashHits: 0,
      curveHits: 0,
      shielded: false,
    });
  }

  removePlayer(id: string) {
    this.players = this.players.filter((p) => p.id !== id);
  }

  // --- geometry (recomputed from the current player count) ---

  private vertAngle(i: number): number {
    return -Math.PI / 2 + (Math.PI * 2 * i) / this.n;
  }

  /** The n polygon vertices, in edge order. */
  verts(): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < this.n; i++) {
      const a = this.vertAngle(i);
      out.push({ x: ARENA.cx + Math.cos(a) * ARENA.radius, y: ARENA.cy + Math.sin(a) * ARENA.radius });
    }
    return out;
  }

  private edge(i: number, verts = this.verts()): Edge {
    const a = verts[i];
    const b = verts[(i + 1) % this.n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey) || 1;
    const dx = ex / len;
    const dy = ey / len;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    // Inward normal: the perpendicular pointing toward the polygon center.
    let nx = -dy;
    let ny = dx;
    if ((ARENA.cx - mx) * nx + (ARENA.cy - my) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { mx, my, dx, dy, nx, ny, half: len / 2 };
  }

  /** Farthest a paddle center may sit from its edge midpoint before it overhangs a corner. */
  private maxPos(half: number, ent: PolyEnt): number {
    return Math.max(0, half - this.paddleLen(ent) / 2);
  }

  private paddleLen(ent: PolyEnt): number {
    return POLY_PADDLE_LEN * (ent.growHits > 0 ? PADDLE_BOOST : 1);
  }

  ballR(): number {
    return this.bigBallTimer > 0 ? BIG_BALL_R : BALL.r;
  }

  /** A player's paddle center + edge orientation, for drawing and for the lobby's view. */
  paddleInfo(i: number, verts = this.verts()): { cx: number; cy: number; angle: number; len: number } {
    const e = this.edge(i, verts);
    const ent = this.players[i];
    const pos = clamp(ent.pos, -this.maxPos(e.half, ent), this.maxPos(e.half, ent));
    return {
      cx: e.mx + e.dx * pos,
      cy: e.my + e.dy * pos,
      angle: Math.atan2(e.dy, e.dx),
      len: this.paddleLen(ent),
    };
  }

  // --- lifecycle ---

  /** Begin a fresh round: everyone alive, paddles centered, powers cleared, ball served. */
  start() {
    for (const p of this.players) {
      p.pos = 0;
      p.targetPos = 0;
      p.alive = true;
      p.growHits = 0;
      p.smashHits = 0;
      p.curveHits = 0;
      p.shielded = false;
    }
    this.clearGlobals();
    this.winnerId = null;
    this.target = null;
    this.targetTimer = this.nextTargetDelay();
    this.status = 'playing';
    this.serve();
  }

  /** Player set changed mid-round (someone joined or left): keep eliminations, but
   *  re-center paddles against the new geometry and re-serve so the ball isn't trapped. */
  reseed() {
    const verts = this.verts();
    for (let i = 0; i < this.n; i++) {
      const e = this.edge(i, verts);
      const m = this.maxPos(e.half, this.players[i]);
      this.players[i].pos = clamp(this.players[i].pos, -m, m);
      this.players[i].targetPos = this.players[i].pos;
    }
    if (this.status === 'playing') this.serve();
  }

  toWaiting() {
    this.status = 'waiting';
    this.ball = { x: ARENA.cx, y: ARENA.cy, vx: 0, vy: 0, spin: 0 };
    this.extraBalls = [];
    this.lastHitId = null;
    this.target = null;
    this.winnerId = null;
    this.clearGlobals();
  }

  private clearGlobals() {
    this.slowTimer = 0;
    this.ghostTimer = 0;
    this.tinyTimer = 0;
    this.bigBallTimer = 0;
    this.extraBalls = [];
  }

  setTarget(id: string, pos: number) {
    const i = this.players.findIndex((p) => p.id === id);
    if (i === -1) return;
    const e = this.edge(i);
    const m = this.maxPos(e.half, this.players[i]);
    this.players[i].targetPos = clamp(pos, -m, m);
  }

  private serve() {
    this.serveTimer = SERVE_DELAY;
    this.ball = { x: ARENA.cx, y: ARENA.cy, vx: 0, vy: 0, spin: 0 };
    this.extraBalls = [];
    this.lastHitId = null;
    this.slowTimer = 0;
    this.ghostTimer = 0;
    this.tinyTimer = 0;
    this.bigBallTimer = 0;
    for (const p of this.players) p.curveHits = 0;
    // Shields persist between points, like the duel game.
  }

  private launch() {
    const angle = Math.random() * Math.PI * 2; // any direction — it's a free-for-all
    this.ball.vx = Math.cos(angle) * BALL.speed;
    this.ball.vy = Math.sin(angle) * BALL.speed;
  }

  // --- simulation ---

  tick(dt: number) {
    // Ease every paddle toward its target along its edge.
    const maxStep = PADDLE.speed * dt;
    const verts = this.verts();
    for (let i = 0; i < this.n; i++) {
      const p = this.players[i];
      const e = this.edge(i, verts);
      const m = this.maxPos(e.half, p);
      const tgt = clamp(p.targetPos, -m, m);
      p.pos += clamp(tgt - p.pos, -maxStep, maxStep);
    }

    if (this.status !== 'playing') return;
    if (this.paused) return;

    if (this.serveTimer > 0) {
      this.serveTimer -= dt;
      if (this.serveTimer <= 0) this.launch();
      return;
    }

    if (this.slowTimer > 0) this.slowTimer -= dt;
    if (this.ghostTimer > 0) this.ghostTimer -= dt;
    if (this.tinyTimer > 0) this.tinyTimer -= dt;
    if (this.bigBallTimer > 0) this.bigBallTimer -= dt;
    const scale = this.slowTimer > 0 ? SLOW_SCALE : 1;

    const prevExtras = this.extraBalls.length;
    const survivors: Ball[] = [];
    for (const b of [this.ball, ...this.extraBalls]) {
      if (this.stepBall(b, dt, scale)) survivors.push(b);
    }
    this.updateTargetTimer(dt);

    const spawned = this.extraBalls.slice(prevExtras);
    const live = [...survivors, ...spawned];

    // Round ends the instant one player is left (or none).
    if (this.aliveCount <= 1) {
      this.status = 'over';
      this.winnerId = this.players.find((p) => p.alive)?.id ?? null;
      this.extraBalls = [];
      return;
    }

    if (live.length > 0) {
      this.ball = live[0];
      this.extraBalls = live.slice(1);
    } else {
      // Court emptied (a knockout consumed the last ball): serve a fresh one.
      this.serve();
    }
  }

  // Step one ball; returns true if it's still in play, false if it slipped past an edge
  // (a knockout — the ball is consumed). Handles paddle bounces, wall bounces (eliminated
  // edges), shields, the power-up target, and curve spin.
  private stepBall(b: Ball, dt: number, scale: number): boolean {
    if (b.spin !== 0) {
      const speed = Math.hypot(b.vx, b.vy);
      const angle = Math.atan2(b.vy, b.vx) + b.spin * dt;
      b.vx = speed * Math.cos(angle);
      b.vy = speed * Math.sin(angle);
      b.spin *= Math.exp(-2 * dt);
      if (Math.abs(b.spin) < 0.01) b.spin = 0;
    }

    const prevX = b.x;
    const prevY = b.y;
    b.x += b.vx * dt * scale;
    b.y += b.vy * dt * scale;
    const r = this.ballR();

    this.checkTargetHit(prevX, prevY, b);

    // Find the edge the ball is most past (smallest inward distance).
    const verts = this.verts();
    let hitI = -1;
    let hitE: Edge | null = null;
    let minDist = Infinity;
    for (let i = 0; i < this.n; i++) {
      const e = this.edge(i, verts);
      const dist = (b.x - e.mx) * e.nx + (b.y - e.my) * e.ny; // >0 inside
      if (dist < minDist) {
        minDist = dist;
        hitI = i;
        hitE = e;
      }
    }
    if (!hitE || minDist > r) return true; // comfortably inside

    const vn = b.vx * hitE.nx + b.vy * hitE.ny;
    if (vn >= 0) return true; // already heading back inside — don't yank it

    const ent = this.players[hitI];
    const s = (b.x - hitE.mx) * hitE.dx + (b.y - hitE.my) * hitE.dy; // offset along edge
    const push = r - minDist; // distance to shove the ball back to the surface

    if (ent.alive) {
      const half = this.paddleLen(ent) / 2;
      if (Math.abs(s - ent.pos) <= half + r) {
        // Paddle hit: reflect off the edge normal with English from the contact offset.
        this.lastHitId = ent.id;
        const rel = clamp((s - ent.pos) / half, -1, 1);
        let speed = Math.hypot(b.vx, b.vy) * BALL.speedup;
        if (ent.smashHits > 0) speed *= SMASH_BONUS;
        const outAngle = Math.atan2(hitE.ny, hitE.nx) + rel * MAX_BOUNCE;
        b.vx = Math.cos(outAngle) * speed;
        b.vy = Math.sin(outAngle) * speed;
        b.x += hitE.nx * push;
        b.y += hitE.ny * push;
        if (ent.growHits > 0) ent.growHits -= 1;
        if (ent.smashHits > 0) ent.smashHits -= 1;
        if (ent.curveHits > 0) {
          b.spin = CURVE_SPIN * (rel >= 0 ? 1 : -1);
          ent.curveHits -= 1;
        }
        return true;
      }
      // Missed — but a shield absorbs the knockout and bats the ball back.
      if (ent.shielded) {
        ent.shielded = false;
        b.vx -= 2 * vn * hitE.nx;
        b.vy -= 2 * vn * hitE.ny;
        b.spin = 0;
        b.x += hitE.nx * push;
        b.y += hitE.ny * push;
        return true;
      }
      ent.alive = false; // knocked out — their edge becomes a wall
      return false;
    }

    // Eliminated player's edge: a solid wall. Specular reflection, no speed-up.
    b.vx -= 2 * vn * hitE.nx;
    b.vy -= 2 * vn * hitE.ny;
    b.spin = 0;
    b.x += hitE.nx * push;
    b.y += hitE.ny * push;
    return true;
  }

  private nextTargetDelay(): number {
    return TARGET.minDelay + Math.random() * (TARGET.maxDelay - TARGET.minDelay);
  }

  /** "/powerup [name]" support: force a target onto the board now. A named kind is
   *  honored only if it's one the arena supports; otherwise a random arena kind drops. */
  forceTarget(kind?: PowerupKind): boolean {
    if (this.status !== 'playing') return false;
    this.placeTarget(kind);
    return true;
  }

  private placeTarget(kind?: PowerupKind) {
    // Drop it somewhere comfortably inside the polygon (within the inradius).
    const inradius = ARENA.radius * Math.cos(Math.PI / this.n);
    const a = Math.random() * Math.PI * 2;
    const rr = Math.random() * inradius * 0.55;
    const pick =
      kind && (POLY_POWERUPS as readonly string[]).includes(kind)
        ? kind
        : POLY_POWERUPS[Math.floor(Math.random() * POLY_POWERUPS.length)];
    this.target = {
      x: ARENA.cx + Math.cos(a) * rr,
      y: ARENA.cy + Math.sin(a) * rr,
      kind: pick,
    };
    this.targetTimer = TARGET.life;
  }

  private updateTargetTimer(dt: number) {
    this.targetTimer -= dt;
    if (!this.target) {
      if (this.targetTimer <= 0) this.placeTarget();
    } else if (this.targetTimer <= 0) {
      this.target = null;
      this.targetTimer = this.nextTargetDelay();
    }
  }

  private checkTargetHit(prevX: number, prevY: number, b: Ball) {
    if (!this.target || !this.lastHitId) return;
    const d = dist2ToSegment(this.target.x, this.target.y, prevX, prevY, b.x, b.y);
    if (d > TARGET.r + this.ballR()) return;
    this.grant(this.target.kind, this.lastHitId);
    this.target = null;
    this.targetTimer = this.nextTargetDelay();
  }

  private grant(kind: PowerupKind, id: string) {
    const alive = this.players.filter((p) => p.alive);
    // If the last-hitter already disconnected, fall back to a random alive player.
    const ent = this.players.find((p) => p.id === id)
      ?? alive[Math.floor(Math.random() * alive.length)];
    switch (kind) {
      case 'grow':
        if (ent) ent.growHits = POWERUP_HITS;
        break;
      case 'smash':
        if (ent) ent.smashHits = POWERUP_HITS;
        break;
      case 'curve':
        if (ent) ent.curveHits = 1;
        break;
      case 'shield':
        if (ent) ent.shielded = true;
        break;
      case 'slow':
        this.slowTimer = SLOW_TIME;
        break;
      case 'multi':
        this.spawnExtraBall();
        this.spawnExtraBall();
        break;
      case 'ghost':
        this.ghostTimer = GHOST_TIME;
        break;
      case 'tiny':
        this.tinyTimer = TINY_TIME;
        break;
      case 'bigball':
        this.bigBallTimer = BIG_BALL_TIME;
        break;
      case 'warp': {
        const inradius = ARENA.radius * Math.cos(Math.PI / this.n);
        const a = Math.random() * Math.PI * 2;
        const rr = Math.random() * inradius * 0.5;
        this.ball.x = ARENA.cx + Math.cos(a) * rr;
        this.ball.y = ARENA.cy + Math.sin(a) * rr;
        this.ball.spin = 0;
        break;
      }
    }
  }

  private spawnExtraBall() {
    if (this.extraBalls.length >= MULTI_MAX) return;
    const src = this.ball;
    const current = Math.hypot(src.vx, src.vy);
    const speed = BALL.speed + Math.random() * Math.max(0, current - BALL.speed);
    const angle = Math.random() * Math.PI * 2;
    this.extraBalls.push({
      x: src.x,
      y: src.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      spin: 0,
    });
  }
}
