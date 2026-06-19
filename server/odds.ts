// Fair betting odds for a first-to-N Pong duel, derived from the two sides' Elo and the live
// score. "Fair" means no house margin: decimal odds are simply 1 / P(win), so a stake breaks
// even in expectation. Ratings are blended toward neutral for players with few games, so the
// odds stay sane on unreliable or un-normalized Elo (see blendElo) — a player parked at the
// default rating, or one with a bad legacy baseline, won't produce confident-but-bogus odds.

const NEUTRAL_ELO = 500; // the default rating; also the "we don't really know yet" anchor
const PROVISIONAL_GAMES = 8; // phantom games at NEUTRAL_ELO mixed into a player's rating

/** Pull a rating toward neutral when the player hasn't logged many games yet: a weighted blend
 *  of their stored Elo with PROVISIONAL_GAMES phantom games at NEUTRAL_ELO. The stored value
 *  dominates once real games far exceed PROVISIONAL_GAMES; at 0 games it's pure neutral. */
export function blendElo(elo: number, games: number): number {
  const g = Math.max(0, games);
  return (elo * g + NEUTRAL_ELO * PROVISIONAL_GAMES) / (g + PROVISIONAL_GAMES);
}

/** Prior P(left wins the match) from Elo — the standard logistic on the 400-point scale. */
export function eloWinProb(eloLeft: number, eloRight: number): number {
  return 1 / (1 + Math.pow(10, (eloRight - eloLeft) / 400));
}

/** P(left reaches the target first) when left needs `a` more points and right needs `b`, with
 *  each point won by left with probability p. Closed-form "race to a vs b" (negative binomial):
 *  sum_{j=0}^{b-1} C(a-1+j, j) · p^a · (1-p)^j. */
export function raceWinProb(p: number, a: number, b: number): number {
  if (a <= 0) return 1; // left already reached the target
  if (b <= 0) return 0; // right already reached the target
  const q = 1 - p;
  const pa = Math.pow(p, a);
  let prob = 0;
  let coeff = 1; // C(a-1, 0)
  let qj = 1; // (1-p)^j
  for (let j = 0; j < b; j++) {
    prob += coeff * pa * qj;
    coeff = (coeff * (a + j)) / (j + 1); // C(a-1+j, j) → C(a+j, j+1)
    qj *= q;
  }
  return prob;
}

/** Per-point win probability for `left` such that the match win prob at 0–0 equals the Elo
 *  prior. raceWinProb is monotonically increasing in p, so binary-search it. */
export function perPointProb(eloLeft: number, eloRight: number, winScore: number): number {
  const target = eloWinProb(eloLeft, eloRight);
  if (winScore <= 1) return target; // a single point IS the match
  let lo = 1e-4;
  let hi = 1 - 1e-4;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (raceWinProb(mid, winScore, winScore) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Live fair decimal odds for each side, given the per-point prob and the current score.
 *  Win probability is clamped to ~[2%, 98%] so a near-decided match still quotes finite, sane
 *  multipliers (capping payouts at ~50× rather than racing off to infinity on a 0–4 comeback). */
export function liveOdds(
  pointProb: number,
  winScore: number,
  scoreLeft: number,
  scoreRight: number,
): { left: number; right: number } {
  const pLeft = raceWinProb(pointProb, winScore - scoreLeft, winScore - scoreRight);
  const pl = Math.min(0.98, Math.max(0.02, pLeft));
  const round2 = (x: number) => Math.round(x * 100) / 100;
  return { left: round2(1 / pl), right: round2(1 / (1 - pl)) };
}
