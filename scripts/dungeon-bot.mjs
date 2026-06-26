// End-to-end Ruins bot: connects to a RUNNING dev server over WebSocket and plays the dungeon like
// a real client (sync → loot → fight → key → vault → escape), then runs anti-cheat probes. Verifies
// the server's responses; for full DB persistence checks, see the queries printed at the end.
//
//   1) npm run dev         (in another terminal — needs DATABASE_URL set for persistence)
//   2) npm run dungeon-bot
//
// It creates throwaway `bot:*` player rows; clean them with:
//   DELETE FROM dungeon_opened WHERE pid LIKE 'bot:%'; DELETE FROM players WHERE id LIKE 'bot:%';
import WebSocket from 'ws';

const URL = process.env.WS_URL || 'ws://localhost:3001/ws';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, msg) => { console.log(`${c ? '✅' : '❌'} ${msg}`); if (!c) FAILED++; };
let FAILED = 0;

// Play a scripted run on a fresh connection/pid; collect what the server told us.
function play(pid, steps) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const got = { chests: [], car: null, purse: 0, spin: null, wallet: null };
    ws.on('message', (raw) => { let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'wallet') got.wallet = m;
      if (m.type === 'dungeonChestOpened') { got.chests.push(m); if (m.car) got.car = m.car; }
      if (m.type === 'dungeonSpin') got.spin = m.reward;
      if (m.type === 'dungeonPurse' && m.coins > got.purse) got.purse = m.coins;
    });
    ws.on('open', async () => {
      ws.send(JSON.stringify({ type: 'join', nickname: 'DungeonBot', pid, color: '#f55' }));
      await wait(550);
      for (const s of steps) { ws.send(JSON.stringify(s)); await wait(250); }
      await wait(800); ws.close(); resolve(got);
    });
    ws.on('error', (e) => { console.error('WS error:', e.message); resolve(got); });
    setTimeout(() => { try { ws.close(); } catch {} resolve(got); }, 12000);
  });
}

(async () => {
  console.log('The Ruins — end-to-end bot\n==========================');

  // 1) Full happy-path run: loot B1, fight, spin B2, key, vault, escape with it all.
  const pid = 'bot:e2e-' + Date.now();
  const r = await play(pid, [
    { type: 'dungeonSync' },
    { type: 'dungeonChest', chest: 'B1:18,2' }, { type: 'dungeonChest', chest: 'B1:9,9' },
    { type: 'dungeonWin', floor: 'B1', tier: 1 }, { type: 'dungeonWin', floor: 'B1', tier: 1 }, { type: 'dungeonWin', floor: 'B1', tier: 1 },
    { type: 'dungeonChest', chest: 'B2:26,3' },   // spin chest
    { type: 'dungeonTakeKey' },
    { type: 'dungeonChest', chest: 'B2:34,24' },  // the vault (needs key)
    { type: 'dungeonExit', escaped: true },
  ]);
  ok(r.chests.some((c) => c.chest === 'B1:18,2' && c.coins === 200), 'B1 coin chest paid 200 to the purse');
  ok(r.chests.some((c) => c.chest === 'B1:9,9' && c.potion), 'B1 potion chest gave a potion');
  ok(!!r.spin, `B2 spin chest spun the wheel (${r.spin ? JSON.stringify(r.spin) : 'none'})`);
  ok(r.car === '🛻 Monster Truck', `vault gave the Monster Truck (with key). car=${r.car}`);
  ok((r.wallet?.owned || []).includes('car-monster'), 'truck is in the wallet (granted on escape)');
  ok((r.wallet?.coins ?? 0) === r.purse && r.purse > 0, `escaped with the full purse (${r.purse}🪙)`);

  // 2) Anti-cheat probes.
  const a = await play('bot:nokey-' + Date.now(), [{ type: 'dungeonSync' }, { type: 'dungeonChest', chest: 'B2:34,24' }, { type: 'dungeonExit', escaped: true }]);
  ok(!a.car, 'vault WITHOUT the key → rejected (no truck)');

  const rp = 'bot:refarm-' + Date.now();
  await play(rp, [{ type: 'dungeonSync' }, { type: 'dungeonChest', chest: 'B1:18,2' }, { type: 'dungeonExit', escaped: true }]);
  const b = await play(rp, [{ type: 'dungeonSync' }, { type: 'dungeonChest', chest: 'B1:18,2' }, { type: 'dungeonExit', escaped: true }]);
  ok(!b.chests.some((c) => c.chest === 'B1:18,2'), 're-open an already-banked chest → rejected (no re-farm)');

  const c = await play('bot:badtier-' + Date.now(), [{ type: 'dungeonSync' }, { type: 'dungeonWin', floor: 'B1', tier: 3 }, { type: 'dungeonExit', escaped: true }]);
  ok((c.wallet?.coins ?? 0) === 0, 'illegal tier for the floor → no payout');

  const d = await play('bot:death-' + Date.now(), [{ type: 'dungeonSync' }, { type: 'dungeonChest', chest: 'B1:18,2' }, { type: 'dungeonWin', floor: 'B1', tier: 1 }, { type: 'dungeonExit', escaped: false }]);
  ok((d.wallet?.coins ?? 0) === 0, 'death/bail forfeits the purse → 0 coins banked');

  console.log(FAILED === 0 ? '\n🏓 all dungeon e2e checks passed.' : `\n💥 ${FAILED} check(s) failed.`);
  console.log(`\nDB spot-checks for the happy-path run (${pid}):`);
  console.log(`  psql -d tsong -c "SELECT coins, owned FROM players WHERE id='${pid}'"`);
  console.log(`  psql -d tsong -c "SELECT chest FROM dungeon_opened WHERE pid='${pid}'"`);
  process.exit(FAILED === 0 ? 0 : 1);
})();
