# Nomic — the Parliament sub-game

A standalone, self-amending **rules game** living in its own building (🏛️ **PARLIAMENT**) on the
World map, alongside the Casino and Bank. It is **not** connected to the Pong game — it's its own
thing, like the Casino or DOOM.

Nomic (Peter Suber, 1982) is *the game in which changing the rules is a move*. Players take turns
proposing rule changes; everyone votes; adopted changes amend the live rulebook — and even the
rules governing voting and scoring are themselves amendable. The whole point is self-amendment.

## The honest design: enforced skeleton + free text

Software can't execute arbitrary English rules, so Nomic runs on human judgment. We split the game:

- **The server enforces the *procedure*** — turn order, vote tallying, thresholds, point scoring,
  rule numbering, mutable/immutable status, win detection. This skeleton is **stored as data, not
  hardcoded**, so a proposal can amend the procedure itself (the soul of Nomic).
- **Humans supply and interpret the *content*** — rule bodies are free text that legislators read
  and vote on. A rule like "every body shall be written in good cheer" means whatever the players
  decide it means.
- **A Judge** resolves disputes when rules contradict or fall silent (Constitution rule 110).

A proposal therefore carries an English `text` **and** an optional structured `effect` that mutates
one enforced parameter. Pure-text proposals (no effect) are flavor / honor-system; effect-bearing
proposals also move a real knob.

## One perpetual communal game (seasons)

A single always-on game for the whole server. Reaching the winning score **seals the rulebook into
the Hall of Rulebooks** and starts a new season. A new season carries the final rulebook forward
(rules persist; scores reset) so the community rulebook genuinely evolves across seasons.

## Enforced parameters (the self-amendable skeleton)

Stored in `nomic_state`, each backed by a seed rule and mutable via a proposal `effect`:

| param              | seed | meaning                                                        |
|--------------------|------|----------------------------------------------------------------|
| `threshold`        | 201  | `'majority'` \| `'twothirds'` \| `'unanimous'` to pass         |
| `pointsPerAdoption`| 202  | points the proposer scores when their change is adopted        |
| `votesPerPlayer`   | 204  | votes each legislator may cast on a proposal                   |
| `winScore`         | 205  | points to win the season                                       |
| `turnDir`          | 206  | `1` forward / `-1` reverse rotation through the seating order  |
| `allowAbstain`     | 203  | whether Abstain is offered (abstentions never count toward the threshold) |

Transmutations (immutable ↔ mutable) **always** require unanimity regardless of `threshold`
(Constitution rule 105) — otherwise the constitution is meaningless.

## Proposal kinds

- `enact`     — add a new rule (free text + optional effect), numbered into its class.
- `amend`     — replace a mutable rule's text and/or effect.
- `repeal`    — remove a mutable rule.
- `transmute` — flip a rule's mutability (needs unanimity).

Immutable rules can't be amended/repealed until transmuted to mutable first.

## Lifecycle of a turn

1. It's the Speaker's (current turn-holder's) turn. They `propose` exactly one rule change.
2. The proposal sits on the floor. Every **other** seated legislator votes For / Against / Abstain.
3. When all eligible votes are in (or the Speaker calls it), the server resolves:
   - tally → pass/fail by the threshold in force (unanimous for transmutes);
   - if passed: apply the change to the rulebook, apply any `effect`, score the proposer
     `pointsPerAdoption`;
   - record it to the log; advance the turn in `turnDir`.
4. If the proposer reached `winScore`, they win the season → archive + reseed.

## Seed rulebook (TSONG-flavored)

Immutable Constitution (100s) — transmute-to-mutable requires unanimity:

- **101** All players must obey the rules in force.
- **102** Immutable rules (100s) outrank mutable rules (200s); on conflict the immutable wins.
- **103** A *rule change* means enacting, amending, repealing, or transmuting a rule.
- **104** Players take turns in the rotation shown on the floor; on your turn you put exactly one
  rule change to the floor.
- **105** A rule change passes by the threshold then in force; transmutations require unanimity.
- **106** A new rule takes the lowest unused number in its class.
- **107** Adopting your proposal scores you the points then in force.
- **108** First to the winning score wins the season; the rulebook is sealed into the Hall and a new
  season begins from where it left off.
- **109** Whatever is not prohibited is permitted. 🏓
- **110** If the rules contradict or fall silent, the Speaker or an appointed Judge rules; the ruling
  stands until a rule change overturns it.

Mutable Body (200s) — each backs an enforced knob:

- **201** A proposal passes by simple majority of votes cast.            *(threshold)*
- **202** Adopting a rule change scores its proposer 5 points.           *(pointsPerAdoption)*
- **203** Players vote For / Against / Abstain; abstentions don't count. *(allowAbstain)*
- **204** Each player has one vote.                                       *(votesPerPlayer)*
- **205** The winning score is 100 points.                               *(winScore)*
- **206** Turn order runs in seating order and wraps.                    *(turnDir)*
- **207** Every rule body shall be written in good cheer.                *(pure text — bait to amend)*

## Files

- `shared/types.ts`  — constants, `Nomic*` types, wire messages, the `parliament` building.
- `server/nomic.ts`  — the authoritative `NomicGame` engine (propose/vote/resolve/judge/win).
- `server/db.ts`     — `nomic_state`, `nomic_rules`, `nomic_scores`, `nomic_proposals`,
  `nomic_votes`, `nomic_log`, `nomic_hall` tables + accessors.
- `server/lobby.ts` + `server/index.ts` — wire routing + broadcast.
- `client/nomic.ts` + `client/world.ts` — the parchment parliament overlay + building entry.
</content>
</invoke>
