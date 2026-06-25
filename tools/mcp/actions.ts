import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpContext } from './context.js';
import { writeAudit } from './audit.js';
import { FAST_SELL_TAX_MS } from '../../shared/types.js';

const COINS = ['kenny', 'chugs', 'davis', 'otto', 'bacon', 'fritz', 'omega'] as const;
const coinEnum = z.enum(COINS);

function requireVerified(ctx: McpContext): string | null {
  if (!ctx.identity.verified)
    return 'identity unverified: refresh TSONG_SESSION (JWT likely expired) or check TSONG_EXPECT_NAME';
  return null;
}

function requireWrites(ctx: McpContext): string | null {
  if (!ctx.cfg.writes) return 'writes disabled; set TSONG_WRITES=true to enable mutating tools';
  return null;
}

function guarded(ctx: McpContext): string | null {
  return requireVerified(ctx) ?? requireWrites(ctx);
}

async function dryRunGuard(ctx: McpContext, tool: string, params: Record<string, unknown>):
  Promise<{ content: { type: 'text'; text: string }[] } | null> {
  if (ctx.cfg.dryRun) {
    const entry = {
      ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
      tool, params, coinsBefore: null, coinsAfter: null, delta: null, result: 'dry-run' as const,
      note: 'dry-run: mutation logged, not sent',
    };
    writeAudit(ctx.cfg.auditLog, entry, ctx.identity);
    return {
      content: [{ type: 'text', text: JSON.stringify({ dryRun: true, wouldSend: params }, null, 2) }],
    };
  }
  return null;
}

export function registerActionTools(server: McpServer, ctx: McpContext) {
  server.tool(
    'buy',
    'Open a long position on a coin. Requires TSONG_WRITES=true.',
    { coin: coinEnum, amount: z.number().int().positive() },
    async ({ coin, amount }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'buy', { coin, amount });
      if (dr) return dr;

      const before = ctx.conn.getState().wallet?.coins ?? null;
      ctx.conn.send({ type: 'stockInvest', coin, amount, side: 'long' });
      let stocks, wallet;
      try {
        stocks = await ctx.conn.awaitMsg('stocks', undefined, 4000);
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'timeout waiting for stock confirmation' }) }], isError: true };
      }
      try {
        wallet = await ctx.conn.awaitMsg('wallet', undefined, 1500);
      } catch {
        wallet = ctx.conn.getState().wallet;
      }

      const after = wallet?.coins ?? null;
      const announce = ctx.conn.getState().lastAnnounce;
      const ok = after !== null && before !== null && after < before;

      writeAudit(ctx.cfg.auditLog, {
        ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
        tool: 'buy', params: { coin, amount },
        coinsBefore: before, coinsAfter: after, delta: before !== null && after !== null ? before - after : null,
        result: ok ? 'ok' : 'rejected',
        note: announce?.text,
      }, ctx.identity);

      if (!ok) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: announce?.text ?? 'no-op (insufficient coins or invalid coin)' }) }] };
      }
      const h = stocks.holdings.find((h) => h.id === coin);
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true, holdings: h ?? null, coins: wallet?.coins, spent: before! - after!, note: announce?.text,
      }, null, 2) }] };
    },
  );

  server.tool(
    'short',
    'Open a short position on a coin. Requires TSONG_WRITES=true.',
    { coin: coinEnum, amount: z.number().int().positive() },
    async ({ coin, amount }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'short', { coin, amount });
      if (dr) return dr;

      const before = ctx.conn.getState().wallet?.coins ?? null;
      ctx.conn.send({ type: 'stockInvest', coin, amount, side: 'short' });
      let stocks, wallet;
      try {
        stocks = await ctx.conn.awaitMsg('stocks', undefined, 4000);
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'timeout waiting for stock confirmation' }) }], isError: true };
      }
      try {
        wallet = await ctx.conn.awaitMsg('wallet', undefined, 1500);
      } catch {
        wallet = ctx.conn.getState().wallet;
      }

      const after = wallet?.coins ?? null;
      const announce = ctx.conn.getState().lastAnnounce;
      const ok = after !== null && before !== null && after < before;

      writeAudit(ctx.cfg.auditLog, {
        ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
        tool: 'short', params: { coin, amount },
        coinsBefore: before, coinsAfter: after, delta: before !== null && after !== null ? before - after : null,
        result: ok ? 'ok' : 'rejected',
        note: announce?.text,
      }, ctx.identity);

      if (!ok) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: announce?.text ?? 'no-op (insufficient coins or invalid coin)' }) }] };
      }
      const h = stocks.holdings.find((h) => h.id === coin && h.side === 'short');
      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true, holdings: h ?? null, coins: wallet?.coins, spent: before! - after!, note: announce?.text,
      }, null, 2) }] };
    },
  );

  server.tool(
    'sell',
    'Close a position (long cash-out or short cover). Returns payout, coins delta, fast-sell tax info.',
    { coin: coinEnum, side: z.enum(['long', 'short']).optional().default('long') },
    async ({ coin, side }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'sell', { coin, side });
      if (dr) return dr;

      const before = ctx.conn.getState().wallet?.coins ?? null;
      const beforeHolding = ctx.conn.getState().stocks?.holdings.find((h) => h.id === coin && h.side === side);
      ctx.conn.send({ type: 'stockCashOut', coin, side });
      let wallet;
      try {
        const results = await Promise.allSettled([
          ctx.conn.awaitMsg('stocks', undefined, 4000),
          ctx.conn.awaitMsg('wallet', undefined, 1500),
        ]);
        wallet = results[1].status === 'fulfilled' ? results[1].value : ctx.conn.getState().wallet;
      } catch {
        wallet = ctx.conn.getState().wallet;
      }

      const after = wallet?.coins ?? null;
      const announce = ctx.conn.getState().lastAnnounce;
      const delta = before !== null && after !== null ? after - before : null;
      const fastSellActive = beforeHolding && (Date.now() - beforeHolding.openedAt < FAST_SELL_TAX_MS);

      writeAudit(ctx.cfg.auditLog, {
        ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
        tool: 'sell', params: { coin, side },
        coinsBefore: before, coinsAfter: after, delta,
        result: delta !== null && delta > 0 ? 'ok' : 'rejected',
        note: announce?.text,
      }, ctx.identity);

      return { content: [{ type: 'text', text: JSON.stringify({
        ok: delta !== null && delta >= 0,
        payout: delta,
        coins: after,
        fastSellTaxApplied: fastSellActive,
        note: announce?.text ?? (delta !== null && delta >= 0 ? 'position closed' : 'no-op'),
      }, null, 2) }] };
    },
  );

  server.tool(
    'take_loan',
    'Borrow coins from Davis. One active loan at a time (echoes existing loan if present).',
    { amount: z.number().int().positive() },
    async ({ amount }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'take_loan', { amount });
      if (dr) return dr;

      const before = ctx.conn.getState().wallet?.coins ?? null;
      ctx.conn.send({ type: 'getLoan', amount });
      try {
        await ctx.conn.awaitMsg('loan', undefined, 4000);
        await ctx.conn.awaitMsg('wallet', undefined, 1500);
      } catch {
        /* partial state ok */
      }

      const after = ctx.conn.getState().wallet?.coins ?? null;
      const loan = ctx.conn.getState().loan;
      const delta = before !== null && after !== null ? after - before : null;

      writeAudit(ctx.cfg.auditLog, {
        ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
        tool: 'take_loan', params: { amount },
        coinsBefore: before, coinsAfter: after, delta,
        result: delta !== null && delta > 0 ? 'ok' : 'rejected',
      }, ctx.identity);

      return { content: [{ type: 'text', text: JSON.stringify({
        ok: delta !== null && delta >= 0,
        loan: loan?.loan ?? null,
        coins: after,
        delta,
      }, null, 2) }] };
    },
  );

  server.tool(
    'repay_loan',
    'Repay your outstanding loan in full.',
    {},
    async () => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'repay_loan', {});
      if (dr) return dr;

      const before = ctx.conn.getState().wallet?.coins ?? null;
      ctx.conn.send({ type: 'repayLoan' });
      try {
        await Promise.all([
          ctx.conn.awaitMsg('loan', undefined, 4000),
          ctx.conn.awaitMsg('wallet', undefined, 1500),
        ]);
      } catch {
        /* partial state ok */
      }

      const after = ctx.conn.getState().wallet?.coins ?? null;
      const loan = ctx.conn.getState().loan;
      const delta = before !== null && after !== null ? after - before : null;

      writeAudit(ctx.cfg.auditLog, {
        ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
        tool: 'repay_loan', params: {},
        coinsBefore: before, coinsAfter: after, delta,
        result: delta !== null ? 'ok' : 'rejected',
      }, ctx.identity);

      return { content: [{ type: 'text', text: JSON.stringify({
        ok: loan?.loan === null,
        loan: loan?.loan ?? null,
        coins: after,
        delta,
      }, null, 2) }] };
    },
  );

  server.tool(
    'tip',
    '⚠️ IRREVERSIBLE: send coins to another player. Max 1M coins. This permanently transfers your coins.',
    { to: z.string().min(1), amount: z.number().int().positive().max(1_000_000) },
    async ({ to, amount }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'tip', { to, amount });
      if (dr) return dr;

      const before = ctx.conn.getState().wallet?.coins ?? null;
      ctx.conn.send({ type: 'tip', to, amount });
      try {
        await ctx.conn.awaitMsg('wallet', undefined, 4000);
      } catch {
        /* partial */
      }

      const after = ctx.conn.getState().wallet?.coins ?? null;
      const delta = before !== null && after !== null ? before - after : null;
      const announce = ctx.conn.getState().lastAnnounce;
      const ok = delta !== null && delta > 0;

      writeAudit(ctx.cfg.auditLog, {
        ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
        tool: 'tip', params: { to, amount },
        coinsBefore: before, coinsAfter: after, delta,
        result: ok ? 'ok' : 'rejected',
        note: announce?.text,
      }, ctx.identity);

      if (!ok) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: announce?.text ?? 'tip failed' }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, to, amount, coins: after, delta }) }] };
    },
  );

  server.tool(
    'place_bounty',
    'Put coins on a player\'s head. The next player to beat them in a duel claims the pot.',
    { to: z.string().min(1), amount: z.number().int().positive() },
    async ({ to, amount }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'place_bounty', { to, amount });
      if (dr) return dr;

      ctx.conn.send({ type: 'placeBounty', to, amount });
      try {
        await ctx.conn.awaitMsg('wallet', undefined, 4000);
      } catch {
        /* partial */
      }
      const after = ctx.conn.getState().wallet?.coins ?? null;
      const announce = ctx.conn.getState().lastAnnounce;

      writeAudit(ctx.cfg.auditLog, {
        ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
        tool: 'place_bounty', params: { to, amount },
        coinsBefore: null, coinsAfter: after, delta: null,
        result: 'ok', note: announce?.text,
      }, ctx.identity);

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, to, amount, note: announce?.text }) }] };
    },
  );

  server.tool(
    'list_item',
    'List an exclusive item on the Black Market. instanceId from your exclusives list, ask is your sale price.',
    { instanceId: z.number().int().positive(), ask: z.number().int().positive() },
    async ({ instanceId, ask }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'list_item', { instanceId, ask });
      if (dr) return dr;

      ctx.conn.send({ type: 'marketList', instanceId, ask });
      try {
        await ctx.conn.awaitMsg('market', undefined, 4000);
      } catch {
        /* partial */
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, instanceId, ask }) }] };
    },
  );

  server.tool(
    'cancel_listing',
    'Cancel one of your Black Market listings.',
    { listingId: z.number().int().positive() },
    async ({ listingId }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'cancel_listing', { listingId });
      if (dr) return dr;

      ctx.conn.send({ type: 'marketCancel', listingId });
      try {
        await ctx.conn.awaitMsg('market', undefined, 4000);
      } catch {
        /* partial */
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, listingId }) }] };
    },
  );

  server.tool(
    'buy_item',
    'Buy the lowest-ask listing of an exclusive item from the Black Market.',
    { item: z.string().min(1) },
    async ({ item }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'buy_item', { item });
      if (dr) return dr;

      const before = ctx.conn.getState().wallet?.coins ?? null;
      ctx.conn.send({ type: 'marketBuy', item });
      try {
        await ctx.conn.awaitMsg('wallet', undefined, 4000);
      } catch {
        /* partial */
      }
      const after = ctx.conn.getState().wallet?.coins ?? null;
      const delta = before !== null && after !== null ? before - after : null;
      const announce = ctx.conn.getState().lastAnnounce;
      const ok = delta !== null && delta > 0;

      writeAudit(ctx.cfg.auditLog, {
        ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
        tool: 'buy_item', params: { item },
        coinsBefore: before, coinsAfter: after, delta,
        result: ok ? 'ok' : 'rejected',
        note: announce?.text,
      }, ctx.identity);

      if (!ok) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: announce?.text ?? 'purchase failed' }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, item, spent: delta, coins: after, note: announce?.text }) }] };
    },
  );

  server.tool(
    'challenge_netizen',
    'Challenge a netizen to a duel with a wager. Win up to 20% of their net worth. Once per day.',
    { netizenId: z.string().min(1), wager: z.number().int().positive() },
    async ({ netizenId, wager }) => {
      const g = guarded(ctx);
      if (g) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: g }) }], isError: true };
      const dr = await dryRunGuard(ctx, 'challenge_netizen', { netizenId, wager });
      if (dr) return dr;

      ctx.conn.send({ type: 'netizenChallenge', netizenId, wager });
      try {
        const result = await ctx.conn.awaitMsg('netizenChallengeResult', undefined, 8000);
        writeAudit(ctx.cfg.auditLog, {
          ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
          tool: 'challenge_netizen', params: { netizenId, wager },
          coinsBefore: null, coinsAfter: null, delta: result.delta,
          result: 'ok', note: result.won ? `won ${result.delta} against ${result.netizenName}` : `lost to ${result.netizenName}`,
        }, ctx.identity);
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true, won: result.won, delta: result.delta, netizenName: result.netizenName,
        }, null, 2) }] };
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'challenge timed out' }) }], isError: true };
      }
    },
  );
}
