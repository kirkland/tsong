// Dungeon-economy hammer harness for The Ruins.
//
// The Ruins run-purse must obey the same coin-conservation contract as the rest of the economy:
// every coin a player walks out with is DEBITED FROM THE HOUSE — nothing is minted. Specifically:
//
//   1. Conservation     — house_balance + SUM(player coins) is invariant across every dungeon flow.
//                         (escape payout is a pure House→player transfer; chests/wins only move the
//                          in-memory purse, which is not "real" coins until escape.)
//   2. No minting        — encounter wins pay within DUNGEON_TIER_COINS[tier] (and only for tiers
//                          legal on the floor, per DUNGEON_FLOOR_TIERS); chests pay exactly
//                          DUNGEON_CHEST_CONTENTS[chest].coins. The client never sends an amount.
//   3. Chest once/account— a chest pays its coins the FIRST time an account opens it, then never
//                          again (no re-farming across runs, no double-pay within a run).
//   4. Escape pays / die forfeits — exit(escaped) pays the purse from the House; exit(!escaped)
//                          forfeits it. Either way the purse is cleared to 0.
//   5. housePay caps     — never overdraws the House; pays min(requested, 25% of balance, balance).
//
// This DOES NOT need a database (the live dungeon paths run entirely in-memory until escape, and the
// dev box has no DATABASE_URL). It mirrors the lobby's dungeon methods + housePay against an
// in-memory ledger, importing the REAL constants from shared/types so the reward tables are the
// single source of truth. If the lobby's reward ranges change, this test tracks them automatically.
//
//   npm run dungeon-check
//
// Exit code 0 = all invariants held, 1 = a violation was detected (the offending flow is printed).

import { DUNGEON_CHEST_CONTENTS, DUNGEON_TIER_COINS, DUNGEON_FLOOR_TIERS } from '../shared/types';

// ----------------------------------------------------------------------------
// In-memory ledger (stands in for the db: House balance + per-player coins).
// ----------------------------------------------------------------------------
let house = 0;
const coins = new Map<string, number>();
const coinsOf = (pid: string) => coins.get(pid) ?? 0;
function trackedTotal(): number {
  let sum = house;
  for (const v of coins.values()) sum += v;
  return sum;
}

// Faithful mirror of Lobby.housePay (server/lobby.ts): conditional, capped, can't overdraw.
function housePay(pid: string, requested: number): number {
  if (!pid || !(requested > 0)) return 0;
  const bal = house;
  if (bal <= 0) return 0;
  const cap = Math.floor(bal * 0.25);
  let pay = requested <= cap ? requested : cap;
  pay = Math.min(pay, bal);
  pay = Math.floor(pay);
  if (pay <= 0) return 0;
  house -= pay;                                  // houseAdjust(-pay)
  coins.set(pid, coinsOf(pid) + pay);            // addCoins(pid, pay)
  return pay;
}

// ----------------------------------------------------------------------------
// Faithful mirror of the Lobby dungeon methods (server/lobby.ts ~1005-1058).
// ----------------------------------------------------------------------------
const dungeonOpenedChests = new Set<string>();        // `${pid}:${chest}` — COMMITTED (banked on escape)
const dungeonRunChests = new Map<string, Set<string>>(); // pid → chests opened THIS run (provisional)
const dungeonPurse = new Map<string, number>();

function dungeonSync(pid: string) {
  dungeonPurse.set(pid, 0);        // entering the Ruins starts a fresh, empty run purse…
  dungeonRunChests.delete(pid);    // …and a fresh provisional-chest slate
}
/** Returns the coins this open ADDED to the purse (0 if unknown / already opened / potion-only). */
function dungeonChest(pid: string, chest: string): number {
  const contents = DUNGEON_CHEST_CONTENTS[chest];
  if (!contents) return 0;
  if (dungeonOpenedChests.has(`${pid}:${chest}`)) return 0; // already banked → no re-farm
  let run = dungeonRunChests.get(pid);
  if (!run) { run = new Set(); dungeonRunChests.set(pid, run); }
  if (run.has(chest)) return 0;    // already opened this run → no double-pay
  run.add(chest);
  const c = contents.coins ?? 0;
  if (c > 0) dungeonPurse.set(pid, (dungeonPurse.get(pid) ?? 0) + c);
  return c;
}
/** Returns the coins the server picked for this win — by MOB TIER, validated against the floor.
 *  0 if the floor is unknown or the tier can't legally appear there (a tampered claim). */
function dungeonWin(pid: string, floor: string, tier: number): number {
  const allowed = DUNGEON_FLOOR_TIERS[floor];
  if (!allowed || !allowed.includes(tier)) return 0;   // reject — the client tried a tier it couldn't fight
  const range = DUNGEON_TIER_COINS[tier];
  if (!range) return 0;
  const c = range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1)); // server picks the amount
  dungeonPurse.set(pid, (dungeonPurse.get(pid) ?? 0) + c);
  return c;
}
/** Returns the coins actually paid out (0 on forfeit / empty purse / drained House). On escape the
 *  run's chests are COMMITTED; on death/bail they roll back (re-lootable next run). */
function dungeonExit(pid: string, escaped: boolean): number {
  const purse = dungeonPurse.get(pid) ?? 0;
  const run = dungeonRunChests.get(pid);
  dungeonPurse.delete(pid);
  dungeonRunChests.delete(pid);
  if (escaped) {
    if (run) for (const chest of run) dungeonOpenedChests.add(`${pid}:${chest}`); // bank them
    if (purse > 0) return housePay(pid, purse);
  }
  return 0; // death/bail: run chests discarded above (never committed) → re-lootable
}

// ----------------------------------------------------------------------------
// Assertions.
// ----------------------------------------------------------------------------
let failures = 0;
function fail(msg: string) { console.log(`❌ ${msg}`); failures++; }
function ok(msg: string) { console.log(`✅ ${msg}`); }

const CHEST_COINS = DUNGEON_CHEST_CONTENTS['B1:18,2'].coins!; // 200
const CHEST_KEYS = Object.keys(DUNGEON_CHEST_CONTENTS);
const FLOORS = Object.keys(DUNGEON_FLOOR_TIERS);
const ALL_TIERS = Object.keys(DUNGEON_TIER_COINS).map(Number);
const rint = (n: number) => Math.floor(Math.random() * n);
const pick = <T,>(a: T[]) => a[rint(a.length)];

// ============================================================================
// Hammer: many accounts, many runs each, randomized flows. After everything we
// assert the GLOBAL total is exactly what it started as (pure transfers only),
// plus a battery of per-flow invariants checked inline.
// ============================================================================
function hammer() {
  const GENESIS = 5_000_000;
  house = GENESIS;
  coins.clear();
  dungeonOpenedChests.clear();
  dungeonPurse.clear();

  const PLAYERS = Array.from({ length: 40 }, (_, i) => `p${i}`);
  for (const p of PLAYERS) coins.set(p, 0);

  const RUNS = 50_000;
  let winSamples = 0, winOutOfRange = 0;
  let illegalTierPaid = 0;          // a tier illegal for the floor that still paid out (must be 0)
  let chestDoublePays = 0;          // a chest that paid coins a 2nd time for the same account
  let purseMismatch = 0;            // exit payout != min(purse, cap) accounting
  let forfeitLeak = 0;              // death/bail credited the player anything
  let overdraw = 0;                 // House ever went negative
  let purseNotCleared = 0;          // purse not 0 after exit
  let totalWins = 0, totalChestPays = 0, totalPaidOut = 0, totalForfeited = 0;

  for (let r = 0; r < RUNS; r++) {
    const pid = pick(PLAYERS);
    const totalBefore = trackedTotal();
    const coinsBefore = coinsOf(pid);

    dungeonSync(pid);
    if ((dungeonPurse.get(pid) ?? -1) !== 0) fail('purse not reset to 0 on sync');

    // expectedPurse = what the in-memory purse SHOULD hold given what we added.
    let expectedPurse = 0;
    const openedThisRun = new Set<string>(); // mirror: chests already opened during THIS run iteration

    // Random sequence of encounters + chest opens.
    const actions = 1 + rint(8);
    for (let a = 0; a < actions; a++) {
      if (Math.random() < 0.5) {
        const floor = pick(FLOORS);
        const tier = pick(ALL_TIERS);                 // sometimes a tier this floor can't actually spawn
        const legal = DUNGEON_FLOOR_TIERS[floor].includes(tier);
        const c = dungeonWin(pid, floor, tier);
        winSamples++;
        if (legal) {
          const [lo, hi] = DUNGEON_TIER_COINS[tier];
          if (c < lo || c > hi) winOutOfRange++;       // legal win must land in the tier's range
        } else if (c !== 0) {
          illegalTierPaid++;                            // illegal tier must pay nothing
        }
        expectedPurse += c;
        totalWins += c;
      } else {
        const chest = pick(CHEST_KEYS);
        const committed = dungeonOpenedChests.has(`${pid}:${chest}`); // banked on a past escape
        const contentCoins = DUNGEON_CHEST_CONTENTS[chest].coins ?? 0;
        // Expected: banked or already-opened-this-run → 0; otherwise the chest's exact coins, once.
        const expectAdded = (committed || openedThisRun.has(chest)) ? 0 : contentCoins;
        const added = dungeonChest(pid, chest);
        openedThisRun.add(chest);
        if (added !== expectAdded) chestDoublePays++;
        expectedPurse += added;
        totalChestPays += added;
      }
    }

    if ((dungeonPurse.get(pid) ?? 0) !== expectedPurse) purseMismatch++;

    // Exit: escape pays, death/bail forfeits.
    const escaped = Math.random() < 0.6;
    const purseAtExit = dungeonPurse.get(pid) ?? 0;
    const paid = dungeonExit(pid, escaped);

    if (house < 0) overdraw++;
    if ((dungeonPurse.get(pid) ?? 0) !== 0) purseNotCleared++;

    if (escaped) {
      // With an ample House (cap = 25% of a multi-million balance >> any single purse), the player
      // should be paid the FULL purse, and conservation must hold exactly for this transfer.
      const cap = Math.floor((house + paid) * 0.25); // balance just before the debit
      const expectPay = Math.min(purseAtExit, cap);
      if (paid !== expectPay) purseMismatch++;
      if (coinsOf(pid) !== coinsBefore + paid) purseMismatch++;
      totalPaidOut += paid;
    } else {
      if (coinsOf(pid) !== coinsBefore) forfeitLeak++; // forfeit must not credit anything
      totalForfeited += purseAtExit;
    }

    // Per-run conservation: total moved by exactly +paid into the player and -paid out of the House.
    if (trackedTotal() !== totalBefore) fail(`conservation broken on run ${r} (Δ=${trackedTotal() - totalBefore})`);
  }

  // ---- Report ----
  console.log(`\nhammered ${RUNS} runs across ${PLAYERS.length} accounts:`);
  console.log(`  encounter wins sampled : ${winSamples}  (tiers ${ALL_TIERS.join('/')}, ranges ${ALL_TIERS.map((t) => DUNGEON_TIER_COINS[t].join('-')).join(' ')})`);
  console.log(`  total win coins        : ${totalWins}`);
  console.log(`  total chest coins      : ${totalChestPays}  (B1 coin-chest=${CHEST_COINS})`);
  console.log(`  total paid out (escape): ${totalPaidOut}`);
  console.log(`  total forfeited (death): ${totalForfeited}`);
  console.log(`  House: ${GENESIS} → ${house}  (Δ=${house - GENESIS}, should equal -paidOut=${-totalPaidOut})\n`);

  if (winOutOfRange === 0) ok(`no minting: every legal win landed in its tier's coin range`);
  else fail(`${winOutOfRange} legal wins OUTSIDE their tier range — coins minted out of range`);

  if (illegalTierPaid === 0) ok('a tier illegal for the floor pays nothing (anti-tamper)');
  else fail(`${illegalTierPaid} illegal-tier claims got paid`);

  if (chestDoublePays === 0) ok('chests pay exactly once per account (no re-farm, exact coins on first open)');
  else fail(`${chestDoublePays} chest pay violations (re-farm or wrong amount)`);

  if (purseMismatch === 0) ok('purse accounting exact (wins+chests in, full purse out on escape)');
  else fail(`${purseMismatch} purse accounting mismatches`);

  if (forfeitLeak === 0) ok('death / bail forfeits the purse (player credited nothing)');
  else fail(`${forfeitLeak} forfeits leaked coins to the player`);

  if (overdraw === 0) ok('House never overdrawn');
  else fail(`${overdraw} House overdraws`);

  if (purseNotCleared === 0) ok('purse cleared to 0 after every exit');
  else fail(`${purseNotCleared} purses not cleared after exit`);

  // Global conservation: House lost exactly what players gained.
  if (trackedTotal() === GENESIS) ok(`global conservation: total unchanged (${GENESIS})`);
  else fail(`global conservation broken: ${trackedTotal()} != ${GENESIS}`);
  if (house - GENESIS === -totalPaidOut) ok('House debit equals total paid to players');
  else fail(`House Δ (${house - GENESIS}) != -paidOut (${-totalPaidOut})`);
}

// ============================================================================
// Edge: a nearly-empty House must CAP payouts and never overdraw — and whatever
// it does pay must still be a conserved transfer (no partial mint/burn).
// ============================================================================
function houseCapEdge() {
  console.log('\n--- nearly-empty House (cap / no-overdraw) ---');
  let capViolations = 0, conservationViolations = 0, overdrawViolations = 0;
  for (let i = 0; i < 10_000; i++) {
    house = rint(1000);              // tiny, sometimes 0
    coins.clear();
    const pid = 'q';
    coins.set(pid, 0);
    dungeonSync(pid);
    // Stuff the purse with several big wins/chests.
    const want = 200 + rint(1000);
    dungeonPurse.set(pid, want);
    const totalBefore = trackedTotal();
    const cap = Math.floor(house * 0.25);
    const expect = Math.min(want, cap, house);
    const expectFloored = Math.max(0, Math.floor(expect));
    const paid = dungeonExit(pid, true);
    if (paid !== expectFloored) capViolations++;
    if (paid > house + paid) overdrawViolations++; // paid more than was available
    if (house < 0) overdrawViolations++;
    if (trackedTotal() !== totalBefore) conservationViolations++;
  }
  if (capViolations === 0) ok('payout always capped at min(purse, 25% house, balance)');
  else fail(`${capViolations} cap violations`);
  if (overdrawViolations === 0) ok('House never overdrawn even when nearly empty');
  else fail(`${overdrawViolations} overdraws`);
  if (conservationViolations === 0) ok('capped payout is still a conserved transfer');
  else fail(`${conservationViolations} conservation violations under cap`);
}

// ============================================================================
// Edge: a chest opened then FORFEITED (death/bail) must be re-lootable on the next run; a chest
// opened then ESCAPED-with must be permanently banked (never pays again). This is the exact thing
// we don't want to get wrong: "open a chest, get the loot, then die — is it lost forever?" → no.
// ============================================================================
function chestRollbackEdge() {
  console.log('\n--- chest rollback (die = re-lootable, escape = banked) ---');
  house = 10_000_000; coins.clear();
  dungeonOpenedChests.clear(); dungeonRunChests.clear(); dungeonPurse.clear();
  const CHEST = 'B1:18,2', VALUE = DUNGEON_CHEST_CONTENTS[CHEST].coins!;
  let dieReloot = 0, escapeBanked = 0, banked = 0;

  // 50 die-then-retry cycles: each run opens the chest (gets VALUE into purse) then dies → next run
  // the chest must be openable AGAIN (provisional, never committed).
  const pid = 'rb';
  coins.set(pid, 0);
  for (let i = 0; i < 50; i++) {
    dungeonSync(pid);
    const added = dungeonChest(pid, CHEST);
    if (added !== VALUE) dieReloot++;      // every run it should re-pay into the purse
    dungeonExit(pid, false);               // died → forfeit + rollback
  }
  if (dieReloot === 0) ok(`a chest opened then died-on is re-lootable every run (×50, ${VALUE}🪙 each)`);
  else fail(`${dieReloot} runs failed to re-loot a forfeited chest`);

  // Now open + ESCAPE: it banks. A subsequent run must NOT re-pay it.
  dungeonSync(pid);
  const first = dungeonChest(pid, CHEST);
  dungeonExit(pid, true);                   // escaped → commit + pay
  if (first === VALUE) banked++;
  dungeonSync(pid);
  const again = dungeonChest(pid, CHEST);   // same account, new run
  if (again !== 0) escapeBanked++;
  dungeonExit(pid, true);
  if (banked === 1 && escapeBanked === 0) ok('a chest opened then escaped-with is permanently banked (no re-farm)');
  else fail('escaped chest was not banked correctly');
}

console.log('The Ruins — dungeon economy hammer\n==================================');
hammer();
houseCapEdge();
chestRollbackEdge();
console.log(failures === 0 ? '\n🏓 all dungeon-economy invariants held.' : `\n💥 ${failures} invariant violation(s).`);
process.exit(failures === 0 ? 0 : 1);
