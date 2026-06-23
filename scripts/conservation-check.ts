// Coin-conservation harness for the Economy Overhaul.
//
// The contract (see the overhaul spec): at all times
//   SUM(players.coins) + SUM(stock_holdings.cost) + house_balance == total_minted
// where total_minted only grows from KNOWN mints (match wins, the one-time campaign clear/flawless
// bonuses, and the genesis House allocation). EVERYTHING else — roulette, bets, the stock market,
// loot boxes, the marketplace, loan defaults — must be a House-funded payout or a pure transfer,
// so it must NOT change the tracked total.
//
// This script snapshots the tracked total, runs a battery of simulated flows directly against the
// DB layer (the same functions the lobby calls), and asserts the total is unchanged after each one
// (within a tiny rounding tolerance). It REQUIRES a DATABASE_URL — point it at a SCRATCH database,
// not production: it creates test players and trades on their behalf.
//
//   DATABASE_URL=postgres://… npm run conservation
//
// Exit code 0 = conserved, 1 = a leak/mint was detected (the offending flow is printed).

import 'dotenv/config';
import pg from 'pg';
import {
  initDb, getHouseBalance, houseAdjust,
  addCoins, spendCoins,
  investStock, closePosition,
  takeLoan, collectDefaultedLoans,
  mintExclusive, listExclusive, buyLowestAsk,
} from '../server/db';
import { STOCKS, EXCLUSIVES } from '../shared/types';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('conservation-check requires DATABASE_URL (point it at a SCRATCH database).');
  process.exit(2);
}

function sslFor(u: string): pg.PoolConfig['ssl'] {
  try {
    const host = new URL(u).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.internal')) return undefined;
    return { rejectUnauthorized: false };
  } catch { return undefined; }
}
const pool = new pg.Pool({ connectionString: url, ssl: sslFor(url) });

/** The tracked total that must only move with known mints. */
async function trackedTotal(): Promise<number> {
  const players = await pool.query<{ s: string }>(`SELECT COALESCE(SUM(coins),0) AS s FROM players`);
  const escrow = await pool.query<{ s: string }>(`SELECT COALESCE(SUM(cost),0) AS s FROM stock_holdings`);
  const house = await getHouseBalance();
  return Number(players.rows[0].s) + Number(escrow.rows[0].s) + house;
}

let failures = 0;
const TOL = 1; // ±1 coin: rounding (positionWorth, commission ceil, tax floor) can shave a coin.

/** Run `flow`, assert the tracked total moved by exactly `expectedMint` (0 for transfers). */
async function check(name: string, expectedMint: number, flow: () => Promise<void>) {
  const before = await trackedTotal();
  await flow();
  const after = await trackedTotal();
  const delta = after - before;
  const ok = Math.abs(delta - expectedMint) <= TOL;
  console.log(`${ok ? '✅' : '❌'} ${name}: Δtotal=${delta} (expected ${expectedMint})`);
  if (!ok) failures++;
}

// --- The settle helpers below mirror the lobby's housePay / settleCashOut math so the harness
//     exercises the SAME coin flows the live server runs (the lobby methods need a WebSocket). ---

async function housePay(pid: string, name: string, requested: number): Promise<number> {
  const bal = await getHouseBalance();
  if (bal <= 0) return 0;
  let pay = requested <= Math.floor(bal * 0.25) ? requested : Math.floor(bal * 0.25);
  pay = Math.min(pay, bal); pay = Math.floor(pay);
  if (pay <= 0) return 0;
  if ((await houseAdjust(-pay)) === null) return 0;
  await addCoins(pid, name, pay);
  return pay;
}
async function settleCashOut(pid: string, name: string, coin: string, price: number) {
  // Mirror of Lobby.settleCashOut: principal released from escrow directly, gain from House,
  // loss leftover → House, fast-sell tax → House.
  const pos = await closePosition(pid, coin, price, 'long');
  if (!pos) return;
  const { cost, payout, openedAt } = pos;
  if (payout >= cost) {
    if (cost > 0) await addCoins(pid, name, cost);
    const gain = payout - cost;
    if (gain > 0) await housePay(pid, name, gain);
  } else {
    const back = Math.max(0, payout);
    if (back > 0) await addCoins(pid, name, back);
    const toHouse = cost - back;
    if (toHouse > 0) await houseAdjust(toHouse);
  }
  if (payout > 0 && openedAt > 0 && Date.now() - openedAt < 60_000) {
    const tax = Math.floor(payout * 0.10);
    if (tax > 0 && (await spendCoins(pid, tax))) await houseAdjust(tax);
  }
}

async function setCoins(pid: string, name: string, coins: number) {
  await pool.query(
    `INSERT INTO players (id, name, coins) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET coins = $3, name = EXCLUDED.name`,
    [pid, name, coins],
  );
}

async function main() {
  await initDb(); // ensures schema + genesis House allocation exist

  const A = 'cc-test-a', B = 'cc-test-b';
  // Clean any prior test rows so reruns are deterministic.
  await pool.query(`DELETE FROM listings WHERE seller_pid = ANY($1)`, [[A, B]]);
  await pool.query(`DELETE FROM exclusive_instances WHERE owner_pid = ANY($1)`, [[A, B]]);
  await pool.query(`DELETE FROM stock_holdings WHERE pid = ANY($1)`, [[A, B]]);
  await pool.query(`DELETE FROM loans WHERE pid = ANY($1)`, [[A, B]]);
  await setCoins(A, 'CC Test A', 1_000_000);
  await setCoins(B, 'CC Test B', 1_000_000);

  const coin = STOCKS[0].id;
  const price = STOCKS[0].base;

  // 1) Roulette loss: stake leaves wallet → House. Net tracked total unchanged.
  await check('roulette loss (stake → House)', 0, async () => {
    const stake = 500;
    if (await spendCoins(A, stake)) await houseAdjust(stake);
  });

  // 2) Bet settle (one winner, one loser): both stakes → House, winner paid stake×odds from House.
  await check('bet settle (stakes → House, payout ← House)', 0, async () => {
    const stake = 400, odds = 1.8;
    // Both escrow at bet time.
    await spendCoins(A, stake);
    await spendCoins(B, stake);
    // Settle: both stakes credited to House, winner (A) paid.
    await houseAdjust(stake); await houseAdjust(stake);
    await housePay(A, 'CC Test A', Math.round(stake * odds));
  });

  // 3) Market: invest LEG ONLY (coins leave the wallet into the position's escrow `cost`, which the
  //    invariant counts) — net tracked total unchanged with no House move.
  await check('market invest (escrow held in cost)', 0, async () => {
    await investStock(A, 'CC Test A', coin, 1000, price, 'long');
  });
  // 3b) Market cash-out: principal released from escrow + gain from House (or loss → House).
  await check('market cash-out (principal released, gain ← House)', 0, async () => {
    await settleCashOut(A, 'CC Test A', coin, price);
  });

  // 4) Loot box: price → House, prize is a House-funded coin payout (or a mint, which adds no coins).
  await check('loot box (price → House, prize ← House)', 0, async () => {
    const lootPrice = 2500;
    if (await spendCoins(A, lootPrice)) await houseAdjust(lootPrice);
    await housePay(A, 'CC Test A', 1500); // coin prize from the House
  });

  // 5) Marketplace sale: mint an exclusive for A, list it, B buys → buyer −ask, seller +(ask−comm),
  //    House +comm. A pure redistribution: tracked total unchanged.
  await check('marketplace sale (transfer + commission → House)', 0, async () => {
    const x = EXCLUSIVES.find((e) => e.cap >= 3) ?? EXCLUSIVES[0];
    const serial = await mintExclusive(A, x.id, x.cap); // a mint adds NO coins (only an instance)
    if (serial === null) return; // capped out on a rerun — skip without failing
    const inst = await pool.query<{ id: number }>(
      `SELECT id FROM exclusive_instances WHERE owner_pid = $1 AND item = $2 ORDER BY id DESC LIMIT 1`,
      [A, x.id],
    );
    const instanceId = Number(inst.rows[0].id);
    await listExclusive(instanceId, A, 'CC Test A', 5000);
    await buyLowestAsk(x.id, B, 'CC Test B');
  });

  // 6) Loan default: borrower's wallet coins are seized → House; the loan principal was House-funded,
  //    so taking + defaulting is a closed loop. (The virtual `owed` feeds instability, not coins.)
  await check('loan default (principal ← House, seized → House)', 0, async () => {
    const principal = 3000;
    const due = Date.now() - 1000; // already overdue, so the very next collect defaults it
    const res = await takeLoan(B, 'CC Test B', principal, due);
    if (res) await houseAdjust(-principal); // lobby debits the House for the loan principal
    const { seized } = await collectDefaultedLoans(Date.now());
    if (seized > 0) await houseAdjust(seized); // seized wallet coins routed into the House
  });

  // Cleanup the scratch rows we created.
  await pool.query(`DELETE FROM listings WHERE seller_pid = ANY($1)`, [[A, B]]);
  await pool.query(`DELETE FROM exclusive_instances WHERE owner_pid = ANY($1)`, [[A, B]]);
  await pool.query(`DELETE FROM stock_holdings WHERE pid = ANY($1)`, [[A, B]]);
  await pool.query(`DELETE FROM loans WHERE pid = ANY($1)`, [[A, B]]);
  await pool.query(`DELETE FROM players WHERE id = ANY($1)`, [[A, B]]);

  await pool.end();
  if (failures) { console.error(`\n${failures} flow(s) violated coin conservation.`); process.exit(1); }
  console.log('\nAll flows conserve coins. ✅');
}

main().catch((e) => { console.error('conservation-check crashed:', e); process.exit(1); });
