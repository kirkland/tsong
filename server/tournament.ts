// Single-elimination tournament bracket. The Lobby owns one of these while a tournament
// is running; it drives which two players are seated in the duel for each match, and the
// Lobby reports the winner back here to advance the bracket.
//
// Seeding is by signup order (slot 0 is seed 1, etc.). Only 4- and 8-player brackets are
// supported — both clean powers of two, so every player plays in the first round (no byes).

import { TournamentMatchView, TournamentView } from '../shared/types';

export interface Participant {
  pid: string;
  name: string;
  country?: { name: string; flag: string };
}

interface MatchNode {
  id: number;
  round: number;
  p1: Participant | null;
  p2: Participant | null;
  winner: Participant | null;
  // Where the winner advances. null for the final.
  feeds: { match: number; slot: 1 | 2 } | null;
}

export type TournamentStatus = 'signup' | 'active' | 'done';

export class Tournament {
  status: TournamentStatus = 'signup';
  readonly size: number;
  readonly creator: string; // nickname of whoever set it up (only they may cancel it)
  // Signup slots in seed order; filled as players join.
  private slots: (Participant | null)[];
  private matches: MatchNode[] = [];
  rounds = 0;
  champion: Participant | null = null;

  constructor(size: number, creator: string) {
    this.size = size === 8 ? 8 : 4;
    this.creator = creator;
    this.slots = new Array(this.size).fill(null);
  }

  // --- signup phase ---

  /** Seats taken so far. */
  filledCount(): number {
    return this.slots.filter(Boolean).length;
  }

  isFull(): boolean {
    return this.filledCount() === this.size;
  }

  hasPid(pid: string): boolean {
    return this.slots.some((s) => s?.pid === pid) || this.matches.some(
      (m) => m.p1?.pid === pid || m.p2?.pid === pid,
    );
  }

  /** Take the next open slot. Returns true if seated. */
  join(p: Participant): boolean {
    if (this.status !== 'signup' || this.hasPid(p.pid)) return false;
    const i = this.slots.findIndex((s) => s === null);
    if (i === -1) return false;
    this.slots[i] = p;
    return true;
  }

  /** Give up a signup slot. */
  leave(pid: string): void {
    if (this.status !== 'signup') return;
    const i = this.slots.findIndex((s) => s?.pid === pid);
    if (i !== -1) this.slots[i] = null;
  }

  /** Build the bracket from the filled slots and switch to active. */
  start(): void {
    if (this.status !== 'signup' || !this.isFull()) return;
    const p = this.slots.map((s) => s!); // all filled
    this.matches = this.size === 4 ? buildBracket4(p) : buildBracket8(p);
    this.rounds = Math.max(...this.matches.map((m) => m.round)) + 1;
    this.status = 'active';
  }

  // --- active phase ---

  /** The match that should be playing now: lowest-id node with both players and no winner. */
  currentMatch(): MatchNode | null {
    if (this.status !== 'active') return null;
    return this.matches.find((m) => m.p1 && m.p2 && !m.winner) ?? null;
  }

  /** Record a winner for a match (by pid) and advance them. Returns true on success. */
  reportWinner(matchId: number, winnerPid: string): boolean {
    const m = this.matches.find((x) => x.id === matchId);
    if (!m || m.winner) return false;
    const w = m.p1?.pid === winnerPid ? m.p1 : m.p2?.pid === winnerPid ? m.p2 : null;
    if (!w) return false;
    m.winner = w;
    if (m.feeds) {
      const next = this.matches.find((x) => x.id === m.feeds!.match)!;
      if (m.feeds.slot === 1) next.p1 = w;
      else next.p2 = w;
    } else {
      // The final just resolved.
      this.champion = w;
      this.status = 'done';
    }
    return true;
  }

  /** A participant left for good — forfeit them from any unfinished match they're in. */
  forfeitPid(pid: string): void {
    if (this.status !== 'active') return;
    for (const m of this.matches) {
      if (m.winner) continue;
      const inP1 = m.p1?.pid === pid;
      const inP2 = m.p2?.pid === pid;
      if (!inP1 && !inP2) continue;
      const other = inP1 ? m.p2 : m.p1;
      // If the opponent is known, they advance; otherwise just clear this player and wait.
      if (other) this.reportWinner(m.id, other.pid);
      else if (inP1) m.p1 = null;
      else m.p2 = null;
    }
  }

  // --- wire view ---

  view(liveMatchId: number | null): TournamentView {
    const matches: TournamentMatchView[] = this.matches.map((m) => ({
      id: m.id,
      round: m.round,
      p1: m.p1?.name ?? null,
      p2: m.p2?.name ?? null,
      winner: m.winner?.name ?? null,
      live: m.id === liveMatchId,
    }));
    // Build a nickname → country lookup from all known participants.
    const countries: Record<string, { name: string; flag: string }> = {};
    const addParticipant = (p: Participant | null) => {
      if (p?.country) countries[p.name] = p.country;
    };
    for (const s of this.slots) addParticipant(s);
    for (const m of this.matches) {
      addParticipant(m.p1);
      addParticipant(m.p2);
      addParticipant(m.winner);
    }
    return {
      status: this.status,
      size: this.size,
      creator: this.creator,
      slots: this.slots.map((s) => s?.name ?? null),
      matches,
      rounds: this.rounds,
      champion: this.champion?.name ?? null,
      countries,
    };
  }
}

// 4-player: two semifinals feed the final.
//   M0: seed1 v seed2  → final slot 1
//   M1: seed3 v seed4  → final slot 2
//   M2: final
function buildBracket4(p: Participant[]): MatchNode[] {
  return [
    { id: 0, round: 0, p1: p[0], p2: p[1], winner: null, feeds: { match: 2, slot: 1 } },
    { id: 1, round: 0, p1: p[2], p2: p[3], winner: null, feeds: { match: 2, slot: 2 } },
    { id: 2, round: 1, p1: null, p2: null, winner: null, feeds: null },
  ];
}

// 8-player: standard bracket, everyone plays in the first round (no byes).
//   Quarterfinals: M0..M3   → semis M4/M5
//   Semifinals:    M4, M5   → final M6
//   Final:         M6
function buildBracket8(p: Participant[]): MatchNode[] {
  return [
    { id: 0, round: 0, p1: p[0], p2: p[1], winner: null, feeds: { match: 4, slot: 1 } },
    { id: 1, round: 0, p1: p[2], p2: p[3], winner: null, feeds: { match: 4, slot: 2 } },
    { id: 2, round: 0, p1: p[4], p2: p[5], winner: null, feeds: { match: 5, slot: 1 } },
    { id: 3, round: 0, p1: p[6], p2: p[7], winner: null, feeds: { match: 5, slot: 2 } },
    { id: 4, round: 1, p1: null, p2: null, winner: null, feeds: { match: 6, slot: 1 } },
    { id: 5, round: 1, p1: null, p2: null, winner: null, feeds: { match: 6, slot: 2 } },
    { id: 6, round: 2, p1: null, p2: null, winner: null, feeds: null },
  ];
}
