import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpContext } from './context.js';
import { writeAudit } from './audit.js';

function requireVerified(ctx: McpContext): string | null {
  if (!ctx.identity.verified)
    return 'identity unverified: refresh TSONG_SESSION (JWT likely expired) or check TSONG_EXPECT_NAME';
  return null;
}

function requireWrites(ctx: McpContext): string | null {
  if (!ctx.cfg.writes) return 'writes disabled; set TSONG_WRITES=true to enable casino tools';
  return null;
}

function guarded(ctx: McpContext): string | null {
  return requireVerified(ctx) ?? requireWrites(ctx);
}

async function dryRunGuard(ctx: McpContext, tool: string, params: Record<string, unknown>):
  Promise<{ content: { type: 'text'; text: string }[] } | null> {
  if (ctx.cfg.dryRun) {
    writeAudit(ctx.cfg.auditLog, {
      ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
      tool, params, coinsBefore: null, coinsAfter: null, delta: null, result: 'dry-run',
      note: 'dry-run: mutation logged, not sent',
    }, ctx.identity);
    return { content: [{ type: 'text', text: JSON.stringify({ dryRun: true, wouldSend: params }, null, 2) }] };
  }
  return null;
}

const rouletteBetKindEnum = z.enum(['straight', 'red', 'black', 'odd', 'even', 'low', 'high', 'dozen1', 'dozen2', 'dozen3']);

export function registerCasinoTools(server: McpServer, ctx: McpContext) {
  server.tool(
    'daily_spin',
    'Claim your once-per-24h reward spin.',
    {},
    async () => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'daily_spin', {});
      if (dr) return dr;

      ctx.conn.send({ type: 'dailySpin' });
      try {
        const result = await ctx.conn.awaitMsg('spinResult', undefined, 6000);
        try {
          await ctx.conn.awaitMsg('wallet', undefined, 1500);
        } catch { /* ok */ }
        writeAudit(ctx.cfg.auditLog, {
          ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
          tool: 'daily_spin', params: {},
          coinsBefore: null, coinsAfter: null, delta: null,
          result: 'ok', note: `won ${result.reward.kind === 'coins' ? result.reward.amount + ' coins' : result.reward.name}`,
        }, ctx.identity);
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true, segment: result.segment, reward: result.reward,
        }, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'spin timed out (may be on cooldown)' }) }], isError: true };
      }
    },
  );

  server.tool(
    'loot_box',
    'Open a loot box (2500 coins). Usually returns nothing; small chance of coin-back, cosmetic, or scarce exclusive.',
    {},
    async () => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'loot_box', {});
      if (dr) return dr;

      const before = ctx.conn.getState().wallet?.coins ?? null;
      ctx.conn.send({ type: 'lootBoxOpen' });
      try {
        const result = await ctx.conn.awaitMsg('lootResult', undefined, 6000);
        try {
          await ctx.conn.awaitMsg('wallet', undefined, 1500);
        } catch { /* ok */ }
        const after = ctx.conn.getState().wallet?.coins ?? null;
        writeAudit(ctx.cfg.auditLog, {
          ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
          tool: 'loot_box', params: {},
          coinsBefore: before, coinsAfter: after, delta: before !== null && after !== null ? after - before : null,
          result: 'ok', note: `kind: ${result.kind}${result.name ? ', ' + result.name : ''}`,
        }, ctx.identity);
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true, kind: result.kind, coins: result.coins, item: result.item, name: result.name,
          serial: result.serial, cap: result.cap, rarity: result.rarity,
        }, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'loot box timed out' }) }], isError: true };
      }
    },
  );

  server.tool(
    'roulette',
    'Spin the European roulette wheel with one or more bets (max 50k total stake).',
    { bets: z.array(z.object({
      kind: rouletteBetKindEnum,
      amount: z.number().int().positive(),
      number: z.number().int().min(0).max(36).optional(),
    })).min(1) },
    async ({ bets }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'roulette', { bets });
      if (dr) return dr;

      const before = ctx.conn.getState().wallet?.coins ?? null;
      ctx.conn.send({ type: 'roulette', bets } as any);
      try {
        const result = await ctx.conn.awaitMsg('rouletteResult', undefined, 8000);
        try {
          await ctx.conn.awaitMsg('wallet', undefined, 1500);
        } catch { /* ok */ }
        const after = ctx.conn.getState().wallet?.coins ?? null;
        const delta = before !== null && after !== null ? after - before : null;
        writeAudit(ctx.cfg.auditLog, {
          ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
          tool: 'roulette', params: { betCount: bets.length },
          coinsBefore: before, coinsAfter: after, delta,
          result: delta !== null && delta > 0 ? 'ok' : (delta !== null && delta < 0 ? 'ok' : 'rejected'),
          note: `number: ${result.number}, staked: ${result.staked}, payout: ${result.payout}`,
        }, ctx.identity);
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true, number: result.number, staked: result.staked, payout: result.payout, coins: after,
        }, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'roulette timed out' }) }], isError: true };
      }
    },
  );

  server.tool(
    'blackjack_bet',
    'Start a blackjack hand with a wager (max 50k).',
    { amount: z.number().int().positive().max(50000) },
    async ({ amount }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'blackjack_bet', { amount });
      if (dr) return dr;

      ctx.conn.send({ type: 'bjBet', amount });
      try {
        const state = await ctx.conn.awaitMsg('bjState', undefined, 6000);
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true, playerCards: state.playerCards, dealerCard: state.dealerCard,
          playerTotal: state.playerTotal, canDouble: state.canDouble,
        }, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'blackjack bet timed out' }) }], isError: true };
      }
    },
  );

  server.tool(
    'blackjack_action',
    'Hit, stand, or double down on your active blackjack hand.',
    { action: z.enum(['hit', 'stand', 'double']) },
    async ({ action }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'blackjack_action', { action });
      if (dr) return dr;

      ctx.conn.send({ type: 'bjAction', action });
      try {
        const result = await Promise.race([
          ctx.conn.awaitMsg('bjResult', undefined, 6000).then((r) => ({ type: 'result' as const, msg: r })),
          ctx.conn.awaitMsg('bjState', undefined, 6000).then((r) => ({ type: 'state' as const, msg: r })),
        ]);
        if (result.type === 'result') {
          const r = result.msg;
          writeAudit(ctx.cfg.auditLog, {
            ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
            tool: 'blackjack_action', params: { action },
            coinsBefore: null, coinsAfter: null, delta: r.payout > 0 ? r.payout : null,
            result: 'ok', note: `${r.outcome}: payout ${r.payout}`,
          }, ctx.identity);
          return { content: [{ type: 'text', text: JSON.stringify({
            ok: true, phase: 'resolved', outcome: r.outcome, payout: r.payout,
            playerCards: r.playerCards, dealerCards: r.dealerCards,
            playerTotal: r.playerTotal, dealerTotal: r.dealerTotal,
          }, null, 2) }] };
        }
        const s = result.msg;
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true, phase: 'playing', playerCards: s.playerCards, dealerCard: s.dealerCard,
          playerTotal: s.playerTotal, canDouble: s.canDouble,
        }, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'blackjack action timed out' }) }], isError: true };
      }
    },
  );

  server.tool(
    'craps_roll',
    'Roll the dice in Street Craps with pass/don\'t-pass bets.',
    { pass: z.number().int().min(0).default(0), dontPass: z.number().int().min(0).default(0) },
    async ({ pass, dontPass }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'craps_roll', { pass, dontPass });
      if (dr) return dr;

      ctx.conn.send({ type: 'crapsRoll', pass, dontPass });
      try {
        const result = await ctx.conn.awaitMsg('crapsResult', undefined, 8000);
        try {
          await ctx.conn.awaitMsg('wallet', undefined, 1500);
        } catch { /* ok */ }
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true, dice: result.dice, total: result.total,
          prevPoint: result.prevPoint, newPoint: result.newPoint,
          outcome: result.outcome, push12: result.push12,
          passPayout: result.passPayout, dontPassPayout: result.dontPassPayout,
        }, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'craps timed out' }) }], isError: true };
      }
    },
  );

  server.tool(
    'crash_bet',
    'Place a bet on the next crash round. Optional auto-cashout multiplier.',
    { amount: z.number().int().positive().max(50000), autoCashout: z.number().positive().optional() },
    async ({ amount, autoCashout }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'crash_bet', { amount, autoCashout });
      if (dr) return dr;

      ctx.conn.send({ type: 'crashBet', amount, autoCashout });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, amount, autoCashout: autoCashout ?? null, note: 'bet placed; use market_dashboard or get_balance to check result after the round ends' }) }] };
    },
  );

  server.tool(
    'crash_cashout',
    'Cash out of the current live crash round at the current multiplier.',
    {},
    async () => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'crash_cashout', {});
      if (dr) return dr;

      ctx.conn.send({ type: 'crashCashout' });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, note: 'cashout attempt sent; check crashState or get_balance for result' }) }] };
    },
  );

  server.tool(
    'crash_cancel',
    'Cancel your crash bet while the betting window is still open.',
    {},
    async () => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'crash_cancel', {});
      if (dr) return dr;

      ctx.conn.send({ type: 'crashCancelBet' });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, note: 'cancel attempt sent' }) }] };
    },
  );

  server.tool(
    'slots_spin',
    'Spin the 3-reel slot machine (max 50k bet).',
    { amount: z.number().int().positive().max(50000) },
    async ({ amount }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'slots_spin', { amount });
      if (dr) return dr;

      const before = ctx.conn.getState().wallet?.coins ?? null;
      ctx.conn.send({ type: 'slotsSpin', amount });
      try {
        const result = await ctx.conn.awaitMsg('slotsResult', undefined, 8000);
        try {
          await ctx.conn.awaitMsg('wallet', undefined, 1500);
        } catch { /* ok */ }
        const after = ctx.conn.getState().wallet?.coins ?? null;
        const delta = before !== null && after !== null ? after - before : null;
        writeAudit(ctx.cfg.auditLog, {
          ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
          tool: 'slots_spin', params: { amount },
          coinsBefore: before, coinsAfter: after, delta,
          result: 'ok', note: result.win ? `won with ${result.win}, payout ${result.payout}` : `no win, payout ${result.payout}`,
        }, ctx.identity);
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true, reels: result.reels, win: result.win, bet: result.bet, payout: result.payout, coins: after,
        }, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'slots timed out' }) }], isError: true };
      }
    },
  );

  server.tool(
    'plinko',
    'Drop a ball through 8 rows of pegs (max 50k bet). Ball lands in one of 9 slots with multipliers ranging from 0.2× to 26×.',
    { amount: z.number().int().positive().max(50000) },
    async ({ amount }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'plinko', { amount });
      if (dr) return dr;

      const before = ctx.conn.getState().wallet?.coins ?? null;
      ctx.conn.send({ type: 'plinko', amount });
      try {
        const result = await ctx.conn.awaitMsg('plinkoResult', undefined, 8000);
        try {
          await ctx.conn.awaitMsg('wallet', undefined, 1500);
        } catch { /* ok */ }
        const after = ctx.conn.getState().wallet?.coins ?? null;
        const delta = before !== null && after !== null ? after - before : null;
        writeAudit(ctx.cfg.auditLog, {
          ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
          tool: 'plinko', params: { amount },
          coinsBefore: before, coinsAfter: after, delta,
          result: 'ok', note: `slot ${result.slot}, ${result.multiplier}x, payout ${result.payout}`,
        }, ctx.identity);
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true,
          path: result.path.map((r: boolean) => r ? 'R' : 'L').join(''),
          slot: result.slot,
          multiplier: result.multiplier,
          bet: result.bet,
          payout: result.payout,
          coins: after,
        }, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'plinko timed out' }) }], isError: true };
      }
    },
  );

  server.tool(
    'horse_req',
    'Request a horse racing card: get 5 horses with shuffled names and odds. Must call horse_bet next to place your wager.',
    {},
    async () => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };

      ctx.conn.send({ type: 'horseReq' });
      try {
        const card = await ctx.conn.awaitMsg('horseCard', undefined, 6000);
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true,
          horses: card.horses.map((h: { name: string; odds: number }, i: number) => ({ index: i, name: h.name, odds: h.odds })),
          note: 'call horse_bet with the index (0–4) of your chosen horse and your wager amount',
        }, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'horse req timed out' }) }], isError: true };
      }
    },
  );

  server.tool(
    'horse_bet',
    'Bet on one of the 5 horses from your active race card (call horse_req first). horse is the 0-indexed position; max 50k.',
    { horse: z.number().int().min(0).max(4), amount: z.number().int().positive().max(50000) },
    async ({ horse, amount }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'horse_bet', { horse, amount });
      if (dr) return dr;

      const before = ctx.conn.getState().wallet?.coins ?? null;
      ctx.conn.send({ type: 'horseBet', horse, amount });
      try {
        const result = await ctx.conn.awaitMsg('horseResult', undefined, 8000);
        try {
          await ctx.conn.awaitMsg('wallet', undefined, 1500);
        } catch { /* ok */ }
        const after = ctx.conn.getState().wallet?.coins ?? null;
        const delta = before !== null && after !== null ? after - before : null;
        writeAudit(ctx.cfg.auditLog, {
          ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
          tool: 'horse_bet', params: { horse, amount },
          coinsBefore: before, coinsAfter: after, delta,
          result: 'ok',
          note: `picked #${horse} (${result.horses[horse]?.name}), winner #${result.winner} (${result.horses[result.winner]?.name}), payout ${result.payout}`,
        }, ctx.identity);
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true,
          horses: result.horses.map((h: { name: string; odds: number }, i: number) => ({ index: i, name: h.name, odds: h.odds })),
          winner: result.winner,
          winnerName: result.horses[result.winner]?.name,
          yourHorse: result.horse,
          won: result.winner === result.horse,
          bet: result.bet,
          payout: result.payout,
          coins: after,
        }, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'horse bet timed out' }) }], isError: true };
      }
    },
  );

  server.tool(
    'hilo_bet',
    'Start a Hi-Lo hand. You get a card (1–13), then call hilo_guess to go higher or lower. Cash out any time with hilo_cashout. Max 50k.',
    { amount: z.number().int().positive().max(50000) },
    async ({ amount }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'hilo_bet', { amount });
      if (dr) return dr;

      ctx.conn.send({ type: 'hiloBet', amount });
      try {
        const state = await ctx.conn.awaitMsg('hiloState', undefined, 6000);
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true, card: state.card, multiplier: state.multiplier, bet: state.bet, pendingPayout: state.pendingPayout,
          note: 'call hilo_guess with "hi" or "lo"; call hilo_cashout to lock in winnings',
        }, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'hilo bet timed out (already in a hand?)' }) }], isError: true };
      }
    },
  );

  server.tool(
    'hilo_guess',
    'Guess whether the next card is higher ("hi") or lower ("lo"). Correct = multiplier grows; wrong = lose your bet.',
    { guess: z.enum(['hi', 'lo']) },
    async ({ guess }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'hilo_guess', { guess });
      if (dr) return dr;

      ctx.conn.send({ type: 'hiloGuess', guess });
      try {
        const msg = await Promise.race([
          ctx.conn.awaitMsg('hiloResult', undefined, 6000).then((r) => ({ phase: 'result' as const, msg: r })),
          ctx.conn.awaitMsg('hiloState', undefined, 6000).then((r) => ({ phase: 'state' as const, msg: r })),
        ]);
        if (msg.phase === 'result') {
          const r = msg.msg;
          writeAudit(ctx.cfg.auditLog, {
            ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
            tool: 'hilo_guess', params: { guess },
            coinsBefore: null, coinsAfter: null, delta: r.net,
            result: 'ok', note: `wrong guess, lost bet; newCard ${r.newCard}, net ${r.net}`,
          }, ctx.identity);
          return { content: [{ type: 'text', text: JSON.stringify({
            ok: true, phase: 'lost', won: false, newCard: r.newCard, payout: r.payout, net: r.net,
          }, null, 2) }] };
        }
        const s = msg.msg;
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true, phase: 'playing', card: s.card, multiplier: s.multiplier, bet: s.bet, pendingPayout: s.pendingPayout,
        }, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'hilo guess timed out' }) }], isError: true };
      }
    },
  );

  server.tool(
    'hilo_cashout',
    'Cash out your active Hi-Lo hand at the current multiplier. Must have at least one correct guess first.',
    {},
    async () => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'hilo_cashout', {});
      if (dr) return dr;

      const before = ctx.conn.getState().wallet?.coins ?? null;
      ctx.conn.send({ type: 'hiloCashout' });
      try {
        const result = await ctx.conn.awaitMsg('hiloResult', undefined, 6000);
        try {
          await ctx.conn.awaitMsg('wallet', undefined, 1500);
        } catch { /* ok */ }
        const after = ctx.conn.getState().wallet?.coins ?? null;
        writeAudit(ctx.cfg.auditLog, {
          ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
          tool: 'hilo_cashout', params: {},
          coinsBefore: before, coinsAfter: after, delta: result.net,
          result: 'ok', note: `cashed out, payout ${result.payout}, net ${result.net}`,
        }, ctx.identity);
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true, won: result.won, payout: result.payout, net: result.net, coins: after,
        }, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'hilo cashout timed out' }) }], isError: true };
      }
    },
  );

  server.tool(
    'mines_bet',
    'Start a Mines hand on the 5×5 grid. Pick how many mines (1–24) are hidden; more mines = higher multiplier per safe reveal. Max 50k bet.',
    { amount: z.number().int().positive().max(50000), mines: z.number().int().min(1).max(24) },
    async ({ amount, mines }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'mines_bet', { amount, mines });
      if (dr) return dr;

      ctx.conn.send({ type: 'minesBet', amount, mines });
      try {
        const state = await ctx.conn.awaitMsg('minesState', undefined, 6000);
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true, mines, bet: amount,
          multiplier: state.multiplier, safeCount: state.safeCount,
          note: 'call mines_reveal with a cell index (0–24) to flip a tile; call mines_cashout to collect after at least one safe reveal',
        }, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'mines bet timed out (already in a hand?)' }) }], isError: true };
      }
    },
  );

  server.tool(
    'mines_reveal',
    'Flip a tile on your active Mines grid. cell is 0-indexed left-to-right, top-to-bottom (0=top-left, 24=bottom-right). Safe = multiplier grows; mine = lose.',
    { cell: z.number().int().min(0).max(24) },
    async ({ cell }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'mines_reveal', { cell });
      if (dr) return dr;

      ctx.conn.send({ type: 'minesReveal', cell });
      try {
        const msg = await Promise.race([
          ctx.conn.awaitMsg('minesResult', undefined, 6000).then((r) => ({ phase: 'result' as const, msg: r })),
          ctx.conn.awaitMsg('minesState',  undefined, 6000).then((r) => ({ phase: 'state'  as const, msg: r })),
        ]);
        if (msg.phase === 'result') {
          const r = msg.msg;
          writeAudit(ctx.cfg.auditLog, {
            ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
            tool: 'mines_reveal', params: { cell },
            coinsBefore: null, coinsAfter: null, delta: r.net,
            result: 'ok', note: r.won ? `cashed out, net ${r.net}` : `hit mine at cell ${r.hitCell}, lost`,
          }, ctx.identity);
          return { content: [{ type: 'text', text: JSON.stringify({
            ok: true, phase: r.won ? 'cashed_out' : 'exploded',
            won: r.won, hitCell: r.hitCell, minePositions: r.minePositions, payout: r.payout, net: r.net,
          }, null, 2) }] };
        }
        const s = msg.msg;
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true, phase: 'safe',
          safeCount: s.safeCount, multiplier: s.multiplier, pendingPayout: s.pendingPayout,
        }, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'mines reveal timed out' }) }], isError: true };
      }
    },
  );

  server.tool(
    'mines_cashout',
    'Cash out your active Mines hand. Must have revealed at least one safe tile first.',
    {},
    async () => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'mines_cashout', {});
      if (dr) return dr;

      const before = ctx.conn.getState().wallet?.coins ?? null;
      ctx.conn.send({ type: 'minesCashout' });
      try {
        const result = await ctx.conn.awaitMsg('minesResult', undefined, 6000);
        try { await ctx.conn.awaitMsg('wallet', undefined, 1500); } catch { /* ok */ }
        const after = ctx.conn.getState().wallet?.coins ?? null;
        writeAudit(ctx.cfg.auditLog, {
          ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
          tool: 'mines_cashout', params: {},
          coinsBefore: before, coinsAfter: after, delta: result.net,
          result: 'ok', note: `cashed out, payout ${result.payout}, net ${result.net}`,
        }, ctx.identity);
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true, payout: result.payout, net: result.net,
          minePositions: result.minePositions, coins: after,
        }, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'mines cashout timed out' }) }], isError: true };
      }
    },
  );
}
