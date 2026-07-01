// Nomic — the authoritative engine for the Parliament sub-game. A standalone, self-amending RULES
// game (Peter Suber, 1982): players take turns proposing rule changes, everyone votes, adopted
// changes amend the live rulebook — and the rules governing voting/scoring are themselves amendable.
//
// This owns the PROCEDURE (turn order, vote tallying, thresholds, scoring, rule numbering, mutable/
// immutable status, win detection). Rule *bodies* are free text humans read + interpret; a proposal
// carries an English `text` plus an optional structured `effect` that moves one enforced parameter —
// that's what makes self-amendment real. One perpetual communal game; winning a season seals the
// rulebook into the Hall and reseeds (rules carry forward, scores reset). See docs/nomic.md.
//
// Event-driven (not ticked): every propose/vote/leave that changes state calls hooks.onChange, which
// the lobby uses to persist to the DB and rebroadcast to everyone in the building.

import {
  NOM_DEFAULT_PARAMS, NOM_LIMITS, NOM_SEED_RULES,
  type NomEffect, type NomLogEntry, type NomParams, type NomProposal, type NomProposalKind,
  type NomRule, type NomScore, type NomStateMsg, type NomVote,
} from '../shared/types';

// What persists across restarts (members, turn, and the open floor proposal are ephemeral).
export interface NomicSnapshot {
  season: number;
  params: NomParams;
  rules: NomRule[];
  scores: NomScore[];
  log: NomLogEntry[];
  nextProposalId: number;
  nextLogId: number;
}

export interface NomicHooks {
  onChange: (snap: NomicSnapshot) => void;                       // persist + rebroadcast
  announce: (text: string) => void;                             // room-wide banner
  award: (memberId: string, coins: number) => void;            // pay a coin prize (whole coins)
  archive: (season: number, winner: string, rules: NomRule[]) => void; // seal a won season into the Hall
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));
const LOG_KEEP = 40; // recent log lines retained / broadcast

export class NomicGame {
  private season = 1;
  private params: NomParams = { ...NOM_DEFAULT_PARAMS };
  private rules: NomRule[] = NOM_SEED_RULES.map((r) => ({ ...r }));
  private scores = new Map<string, NomScore>(); // by member id — every player who's ever played this season
  private log: NomLogEntry[] = [];
  private nextProposalId = 1;
  private nextLogId = 1;

  // Ephemeral (not persisted): the legislator roster, who's online, whose turn, what's on the floor.
  private members: string[] = [];              // all legislators in turn order (stays when they go offline)
  private activeMembers = new Set<string>();   // subset currently connected — quorum for auto-resolve
  private turnId: string | null = null;        // the Speaker (current turn-holder)
  private floor: NomProposal | null = null;    // the proposal on the floor
  private winnerName: string | null = null;    // set briefly after a season win, cleared on next propose

  constructor(private hooks: NomicHooks, snap?: NomicSnapshot | null) {
    if (snap) this.load(snap);
  }

  private load(s: NomicSnapshot) {
    this.season = s.season;
    this.params = { ...NOM_DEFAULT_PARAMS, ...s.params };
    this.rules = (s.rules?.length ? s.rules : NOM_SEED_RULES).map((r) => ({ ...r }));
    this.scores = new Map(s.scores.map((sc) => [sc.id, { ...sc }]));
    this.log = (s.log ?? []).slice(-LOG_KEEP);
    this.nextProposalId = Math.max(1, s.nextProposalId ?? 1);
    this.nextLogId = Math.max(1, s.nextLogId ?? 1);
  }

  private snapshot(): NomicSnapshot {
    return {
      season: this.season,
      params: { ...this.params },
      rules: this.rules.map((r) => ({ ...r })),
      scores: [...this.scores.values()].map((s) => ({ ...s })),
      log: this.log.slice(-LOG_KEEP),
      nextProposalId: this.nextProposalId,
      nextLogId: this.nextLogId,
    };
  }

  /** Hydrate from a persisted snapshot post-construction (DB load is async). No-op once anyone's seated. */
  restore(snap: NomicSnapshot) {
    if (this.members.length > 0) return; // players already arrived — don't clobber a live game
    this.load(snap);
    this.changed(); // push the restored rulebook to anyone already watching
  }

  /** Persist + rebroadcast after any state change. */
  private changed() { this.hooks.onChange(this.snapshot()); }

  private addLog(text: string) {
    this.log.push({ id: this.nextLogId++, text, time: Date.now() });
    if (this.log.length > LOG_KEEP) this.log = this.log.slice(-LOG_KEEP);
  }

  /** Is anyone seated (so the lobby knows whether to keep broadcasting)? */
  get active(): boolean { return this.members.length > 0; }

  // --- membership -----------------------------------------------------------------------------

  /** A player walks into the Parliament: seat them and mark online. Brand-new players start at 0 pts. */
  enter(id: string, name: string, color: string) {
    const existing = this.scores.get(id);
    if (existing) { existing.name = name; existing.color = color; }
    else this.scores.set(id, { id, name, color, points: 0 });
    if (!this.members.includes(id)) this.members.push(id);
    this.activeMembers.add(id);
    if (this.turnId === null) this.turnId = id;
    this.changed();
    // Re-check auto-resolve: a returning player may have been the missing vote.
    this.maybeAutoResolve();
  }

  /** A player closes the Parliament or disconnects. They stay in the rotation (async play) —
   *  only their online status changes. Score, turn position, and any votes they've cast persist. */
  leave(id: string) {
    if (!this.activeMembers.delete(id)) return;
    this.changed();
    // Re-check auto-resolve: their departure may complete the online quorum.
    this.maybeAutoResolve();
  }

  private advanceTurn() {
    if (this.members.length === 0) { this.turnId = null; return; }
    const i = this.turnId ? this.members.indexOf(this.turnId) : -1;
    const dir = this.params.turnDir === -1 ? -1 : 1;
    const n = this.members.length;
    const next = ((i < 0 ? 0 : i + dir) % n + n) % n;
    this.turnId = this.members[next];
  }

  // --- the turn: propose → vote → resolve -----------------------------------------------------

  /** The Speaker puts exactly one rule change on the floor. Returns an error string, or null on success. */
  propose(id: string, kind: NomProposalKind, text: string, target?: number, effect?: NomEffect | null, ruleClass?: 'immutable' | 'mutable'): string | null {
    if (this.turnId !== id) return 'It is not your turn to propose.';
    if (this.floor) return 'A proposal is already on the floor.';
    const body = (text ?? '').trim();
    const eff = effect ? this.clampEffect(effect) : null;

    if (kind === 'enact') {
      if (!body) return 'A new rule needs a body.';
    } else {
      const rule = this.rules.find((r) => r.num === target);
      if (!rule) return `There is no rule ${target}.`;
      if (kind === 'amend' || kind === 'repeal') {
        if (!rule.mutable) return `Rule ${target} is immutable — transmute it to mutable first.`;
      }
      if (kind === 'amend' && !body && !eff) return 'An amendment must change the text or an effect.';
    }

    this.winnerName = null; // a new turn clears the just-finished-season banner
    const proposer = this.scores.get(id)!;
    this.floor = {
      id: this.nextProposalId++,
      kind, proposer: id, proposerName: proposer.name,
      text: body, target: target ?? null, effect: eff,
      ruleClass: kind === 'enact' ? (ruleClass === 'immutable' ? 'immutable' : 'mutable') : undefined,
      // The proposer backs their own proposal (classic Nomic — you vote on your own).
      votes: [{ id, name: proposer.name, vote: 'for' }],
      status: 'open',
    };
    this.changed();
    this.maybeAutoResolve();
    return null;
  }

  /** A seated legislator casts (or changes) their vote on the floor proposal. */
  vote(id: string, vote: NomVote): string | null {
    if (!this.floor || this.floor.status !== 'open') return 'There is nothing on the floor to vote on.';
    if (!this.members.includes(id)) return 'Only seated legislators may vote.';
    if (vote === 'abstain' && !this.params.allowAbstain) return 'Abstaining is not allowed under the rules in force.';
    const sc = this.scores.get(id);
    if (!sc) return 'You are not seated.';
    const existing = this.floor.votes.find((v) => v.id === id);
    if (existing) existing.vote = vote;
    else this.floor.votes.push({ id, name: sc.name, vote });
    this.changed();
    this.maybeAutoResolve();
    return null;
  }

  /** Auto-resolve once every currently-online legislator has voted.
   *  Offline members are excluded from the quorum — they can't block async play. */
  private maybeAutoResolve() {
    if (!this.floor || this.floor.status !== 'open') return;
    const voted = new Set(this.floor.votes.map((v) => v.id));
    const onlineAndSeated = this.members.filter((m) => this.activeMembers.has(m));
    if (onlineAndSeated.length > 0 && onlineAndSeated.every((m) => voted.has(m))) this.resolveFloor();
  }

  /** The Speaker (or any member if the Speaker is offline) calls the vote and resolves early. */
  resolve(id: string): string | null {
    if (!this.floor) return 'Nothing is on the floor.';
    const speakerOnline = this.turnId && this.activeMembers.has(this.turnId);
    if (id !== this.floor.proposer && id !== this.turnId && speakerOnline) {
      return 'Only the Speaker may call the vote.';
    }
    this.resolveFloor();
    return null;
  }

  private passes(p: NomProposal): boolean {
    const fors = p.votes.filter((v) => v.vote === 'for').length;
    const againsts = p.votes.filter((v) => v.vote === 'against').length;
    const cast = fors + againsts; // abstentions never count toward the threshold
    if (fors === 0) return false;
    // Transmutations always require unanimity (Constitution rule 105), whatever the threshold.
    if (p.kind === 'transmute' || this.params.threshold === 'unanimous') return againsts === 0;
    if (this.params.threshold === 'twothirds') return fors * 3 >= cast * 2;
    return fors * 2 > cast; // simple majority of votes cast
  }

  private resolveFloor() {
    const p = this.floor;
    if (!p || p.status !== 'open') return;
    const fors = p.votes.filter((v) => v.vote === 'for').length;
    const againsts = p.votes.filter((v) => v.vote === 'against').length;
    const adopted = this.passes(p);
    p.status = adopted ? 'passed' : 'failed';

    if (adopted) {
      this.applyChange(p);
      const proposer = this.scores.get(p.proposer);
      if (proposer) proposer.points += this.params.pointsPerAdoption;
      this.addLog(`${p.proposerName}'s ${this.describe(p)} ADOPTED ${fors}–${againsts} (+${this.params.pointsPerAdoption})`);
      this.floor = null;
      // Win check before advancing the turn, so the winner's reseed flows cleanly.
      if (proposer && proposer.points >= this.params.winScore) { this.winSeason(proposer); this.changed(); return; }
    } else {
      this.addLog(`${p.proposerName}'s ${this.describe(p)} FAILED ${fors}–${againsts}`);
      this.floor = null;
    }
    this.advanceTurn();
    this.changed();
  }

  private describe(p: NomProposal): string {
    if (p.kind === 'enact') return `new ${p.ruleClass === 'immutable' ? 'immutable ' : ''}rule`;
    if (p.kind === 'amend') return `amendment to rule ${p.target}`;
    if (p.kind === 'repeal') return `repeal of rule ${p.target}`;
    return `transmutation of rule ${p.target}`;
  }

  /** Apply an adopted rule change to the live rulebook + enforced params. */
  private applyChange(p: NomProposal) {
    switch (p.kind) {
      case 'enact': {
        const immutable = p.ruleClass === 'immutable';
        const num = this.lowestUnused(immutable);
        this.rules.push({ num, text: p.text, mutable: !immutable, effect: p.effect ?? null });
        if (p.effect) this.applyEffect(p.effect);
        this.rules.sort((a, b) => a.num - b.num);
        break;
      }
      case 'amend': {
        const r = this.rules.find((x) => x.num === p.target);
        if (r) {
          if (p.text) r.text = p.text;
          if (p.effect) { r.effect = p.effect; this.applyEffect(p.effect); }
        }
        break;
      }
      case 'repeal':
        this.rules = this.rules.filter((x) => x.num !== p.target);
        break;
      case 'transmute': {
        const r = this.rules.find((x) => x.num === p.target);
        if (r) r.mutable = !r.mutable;
        break;
      }
    }
  }

  /** Lowest unused number in a class: immutable 101–199, mutable 201+. */
  private lowestUnused(immutable: boolean): number {
    const used = new Set(this.rules.map((r) => r.num));
    let n = immutable ? 101 : 201;
    const ceil = immutable ? 199 : Number.MAX_SAFE_INTEGER;
    while (used.has(n) && n <= ceil) n++;
    return n;
  }

  private clampEffect(e: NomEffect): NomEffect {
    switch (e.param) {
      case 'pointsPerAdoption': return { param: e.param, value: clamp(e.value, NOM_LIMITS.minPoints, NOM_LIMITS.maxPoints) };
      case 'votesPerPlayer': return { param: e.param, value: clamp(e.value, NOM_LIMITS.minVotes, NOM_LIMITS.maxVotes) };
      case 'winScore': return { param: e.param, value: clamp(e.value, NOM_LIMITS.minWin, NOM_LIMITS.maxWin) };
      case 'turnDir': return { param: e.param, value: e.value === -1 ? -1 : 1 };
      case 'threshold': return { param: e.param, value: e.value };
      case 'allowAbstain': return { param: e.param, value: !!e.value };
    }
  }

  private applyEffect(e: NomEffect) {
    switch (e.param) {
      case 'threshold': this.params.threshold = e.value; break;
      case 'pointsPerAdoption': this.params.pointsPerAdoption = e.value; break;
      case 'votesPerPlayer': this.params.votesPerPlayer = e.value; break;
      case 'winScore': this.params.winScore = e.value; break;
      case 'turnDir': this.params.turnDir = e.value; break;
      case 'allowAbstain': this.params.allowAbstain = e.value; break;
    }
  }

  private winSeason(winner: NomScore) {
    this.hooks.archive(this.season, winner.name, this.rules.map((r) => ({ ...r })));
    this.hooks.announce(`🏛️ ${winner.name} wins Nomic season ${this.season}! A new season convenes.`);
    this.hooks.award(winner.id, 100); // a tidy victory purse
    this.addLog(`🏆 ${winner.name} won season ${this.season} with ${winner.points} points. Season ${this.season + 1} begins.`);
    this.winnerName = winner.name;
    this.season++;
    for (const s of this.scores.values()) s.points = 0; // scores reset; the rulebook carries forward
    this.advanceTurn(); // the gavel passes on to the next legislator
  }

  // --- the wire view (per-recipient, since `you`/`yourTurn` differ) ----------------------------

  viewFor(id: string): NomStateMsg {
    const seated = this.members.includes(id);
    return {
      type: 'nomState',
      you: seated ? id : '',
      yourTurn: seated && this.turnId === id,
      season: this.season,
      params: { ...this.params },
      rules: this.rules.map((r) => ({ ...r })),
      scores: [...this.scores.values()].map((s) => ({ ...s })).sort((a, b) => b.points - a.points),
      members: [...this.members],
      online: [...this.activeMembers],
      turn: this.turnId,
      proposal: this.floor ? { ...this.floor, votes: this.floor.votes.map((v) => ({ ...v })) } : null,
      log: this.log.slice(-LOG_KEEP),
      winner: this.winnerName,
    };
  }
}
