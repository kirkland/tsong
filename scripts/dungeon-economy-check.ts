// Dungeon-economy hammer harness for The Ruins.
//
// The Ruins run-purse must obey the same coin-conservation contract as the rest of the economy:
// every coin a player walks out with is DEBITED FROM THE HOUSE — nothing is minted. Specifically:
//
//   1. Conservation     — house_balance + SUM(player coins) is invariant across every dungeon flow.
//                         (escape payout is a pure House→player transfer; chests/wins only move the
//                          in-memory purse, which is not "real" coins until escape.)
//   2. No minting        — encounter wins pay within DUNGEON_FLOOR_COINS[floor]; chests pay exactly
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

import { DUNGEON_CHEST_CONTENTS, DUNGEON_FLOOR_COINS } from '../shared/types';

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
const dungeonOpenedChests = new Set<string>(); // `${pid}:${chest}`  (persists across runs, per account)
const dungeonPurse = new Map<string, number>();

function dungeonSync(pid: string) {
  dungeonPurse.set(pid, 0); // entering the Ruins starts a fresh, empty run purse
}
/** Returns the coins this open ADDED to the purse (0 if unknown / already opened / potion-only). */
function dungeonChest(pid: string, chest: string): number {
  const contents = DUNGEON_CHEST_CONTENTS[chest];
  if (!contents) return 0;
  const key = `${pid}:${chest}`;
  if (dungeonOpenedChests.has(key)) return 0;    // already opened by this account → no re-farm
  dungeonOpenedChests.add(key);
  const c = contents.coins ?? 0;
  if (c > 0) dungeonPurse.set(pid, (dungeonPurse.get(pid) ?? 0) + c);
  return c;
}
/** Returns the coins the server picked for this win (0 for an unknown floor). */
function dungeonWin(pid: string, floor: string): number {
  const range = DUNGEON_FLOOR_COINS[floor];
  if (!range) return 0;
  const c = range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1)); // server picks the amount
  dungeonPurse.set(pid, (dungeonPurse.get(pid) ?? 0) + c);
  return c;
}
/** Returns the coins actually paid out (0 on forfeit / empty purse / drained House). */
function dungeonExit(pid: string, escaped: boolean): number {
  const purse = dungeonPurse.get(pid) ?? 0;
  dungeonPurse.delete(pid);
  if (escaped && purse > 0) return housePay(pid, purse);
  return 0;
}

// ----------------------------------------------------------------------------
// Assertions.
// ----------------------------------------------------------------------------
let failures = 0;
function fail(msg: string) { console.log(`❌ ${msg}`); failures++; }
function ok(msg: string) { console.log(`✅ ${msg}`); }

const [WIN_MIN, WIN_MAX] = DUNGEON_FLOOR_COINS.B1;
const CHEST_COINS = DUNGEON_CHEST_CONTENTS['B1:17,2'].coins!; // 200
const CHEST_KEYS = Object.keys(DUNGEON_CHEST_CONTENTS);
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

    // Random sequence of encounters + chest opens.
    const actions = 1 + rint(8);
    for (let a = 0; a < actions; a++) {
      if (Math.random() < 0.5) {
        const c = dungeonWin(pid, 'B1');
        winSamples++;
        if (c < WIN_MIN || c > WIN_MAX) winOutOfRange++;
        expectedPurse += c;
        totalWins += c;
      } else {
        const chest = pick(CHEST_KEYS);
        const everOpened = dungeonOpenedChests.has(`${pid}:${chest}`);
        const added = dungeonChest(pid, chest);
        const contentCoins = DUNGEON_CHEST_CONTENTS[chest].coins ?? 0;
        if (everOpened && added !== 0) chestDoublePays++;            // re-farm: must be 0
        if (!everOpened && added !== contentCoins) chestDoublePays++; // first open: exact coins
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
  console.log(`  encounter wins sampled : ${winSamples}  (range ${WIN_MIN}-${WIN_MAX})`);
  console.log(`  total win coins        : ${totalWins}`);
  console.log(`  total chest coins      : ${totalChestPays}  (chest=${CHEST_COINS})`);
  console.log(`  total paid out (escape): ${totalPaidOut}`);
  console.log(`  total forfeited (death): ${totalForfeited}`);
  console.log(`  House: ${GENESIS} → ${house}  (Δ=${house - GENESIS}, should equal -paidOut=${-totalPaidOut})\n`);

  if (winOutOfRange === 0) ok(`no minting: all ${winSamples} encounter wins within [${WIN_MIN}, ${WIN_MAX}]`);
  else fail(`${winOutOfRange} encounter wins OUTSIDE [${WIN_MIN}, ${WIN_MAX}] — coins minted out of range`);

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

console.log('The Ruins — dungeon economy hammer\n==================================');
hammer();
houseCapEdge();
console.log(failures === 0 ? '\n🏓 all dungeon-economy invariants held.' : `\n💥 ${failures} invariant violation(s).`);
process.exit(failures === 0 ? 0 : 1);
