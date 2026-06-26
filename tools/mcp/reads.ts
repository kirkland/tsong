import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpContext } from './context.js';
import { FAST_SELL_TAX_MS, FAST_SELL_TAX_RATE } from '../../shared/types.js';

function requireVerified(ctx: McpContext): string | null {
  if (!ctx.identity.verified) {
    return 'identity unverified: refresh TSONG_SESSION (JWT likely expired) or check TSONG_EXPECT_NAME';
  }
  return null;
}

export function registerReadTools(server: McpServer, ctx: McpContext) {
  server.tool(
    'get_balance',
    'Your liquid coins, owned cosmetics, exclusives, equipped items, daily-spin status.',
    {},
    () => {
      const err = requireVerified(ctx);
      if (err) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: err }) }], isError: true };
      const w = ctx.conn.getState().wallet;
      if (!w) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'wallet not loaded' }) }] };
      return { content: [{ type: 'text', text: JSON.stringify({
        coins: w.coins,
        owned: w.owned,
        exclusives: w.exclusives,
        hat: w.hat, skin: w.skin, trail: w.trail, title: w.title,
        nextSpinAt: w.nextSpinAt, bonusSpins: w.bonusSpins,
      }, null, 2) }] };
    },
  );

  server.tool(
    'get_portfolio',
    'Your open stock positions: shares, cost basis, live worth, fast-sell tax window.',
    {},
    () => {
      const err = requireVerified(ctx);
      if (err) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: err }) }], isError: true };
      const s = ctx.conn.getState().stocks;
      if (!s) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'stocks not loaded' }) }] };
      const now = Date.now();
      return { content: [{ type: 'text', text: JSON.stringify({
        holdings: s.holdings.map((h) => ({
          id: h.id, side: h.side, shares: h.shares, cost: h.cost, worth: h.worth,
          openedAt: h.openedAt,
          fastSellActive: now - h.openedAt < FAST_SELL_TAX_MS,
        })),
      }, null, 2) }] };
    },
  );

  server.tool(
    'get_market',
    'Global price board: prices per coin, your holdings, stability.',
    {},
    () => {
      const err = requireVerified(ctx);
      if (err) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: err }) }], isError: true };
      const s = ctx.conn.getState().stocks;
      if (!s) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'stocks not loaded' }) }] };
      return { content: [{ type: 'text', text: JSON.stringify({
        prices: s.prices,
        holdings: s.holdings,
        stability: s.stability,
        nextUpdateAt: s.nextUpdateAt,
      }, null, 2) }] };
    },
  );

  server.tool(
    'get_net_worth',
    'Net worth board: rows, your position, gap to first place.',
    {},
    () => {
      const err = requireVerified(ctx);
      if (err) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: err }) }], isError: true };
      const nw = ctx.conn.getState().netWorth;
      if (!nw) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'netWorth not loaded' }) }] };
      return { content: [{ type: 'text', text: JSON.stringify({
        rows: nw.rows,
        self: nw.selfRow ? { net: nw.selfRow.net, coins: nw.selfRow.coins, loan: nw.selfRow.loan, rank: nw.selfRank } : null,
        gapToFirst: nw.selfRow && nw.rows.length > 0 ? nw.rows[0].net - nw.selfRow.net : null,
      }, null, 2) }] };
    },
  );

  server.tool(
    'get_leaderboard',
    'Elo leaderboard: ranked rows, your elo and rank.',
    {},
    () => {
      const err = requireVerified(ctx);
      if (err) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: err }) }], isError: true };
      const lb = ctx.conn.getState().leaderboard;
      if (!lb) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'leaderboard not loaded' }) }] };
      return { content: [{ type: 'text', text: JSON.stringify({
        rows: lb.rows,
        selfElo: lb.selfElo,
        selfRank: lb.selfRank,
      }, null, 2) }] };
    },
  );

  server.tool(
    'get_news',
    'Latest market news headlines. Set refresh=true to fetch fresh from server.',
    { refresh: z.boolean().optional().default(false) },
    async ({ refresh }) => {
      const err = requireVerified(ctx);
      if (err) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: err }) }], isError: true };
      if (refresh) {
        ctx.conn.send({ type: 'newsReq' });
        await ctx.conn.awaitMsg('news');
      }
      const news = ctx.conn.getState().news;
      if (!news) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'no news' }) }] };
      return { content: [{ type: 'text', text: JSON.stringify({ items: news.items }, null, 2) }] };
    },
  );

  server.tool(
    'get_house',
    'Full House/Fed dashboard: treasury balance, economy totals, concentration, Fed policy, tax brackets, bonds, auctions, FED news.',
    {},
    async () => {
      const err = requireVerified(ctx);
      if (err) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: err }) }], isError: true };
      ctx.conn.send({ type: 'houseReq' });
      const s = await ctx.conn.awaitMsg('houseState');
      return { content: [{ type: 'text', text: JSON.stringify({
        balance: s.balance,
        low: s.balance < 10000,
        trickleFund: s.trickleFund,
        totalCoins: s.totalCoins,
        top5Pct: s.top5Pct,
        top5ShareOfTotal: s.top5ShareOfTotal,
        playerNetWorthTotal: s.playerNetWorthTotal,
        economyTotal: s.economyTotal,
        loanCapWaived: s.loanCapWaived,
        tightening: s.tightening,
        brokerFeePct: s.brokerFeePct,
        concentrationCap: s.concentrationCap,
        wealthBrackets: s.wealthBrackets,
        capGainBrackets: s.capGainBrackets,
        fastSell: s.fastSell,
        idleTiers: s.idleTiers,
        fedNews: s.fedNews,
        bondRates: s.bondRates,
        myBonds: s.myBonds,
        auction: s.auction,
      }, null, 2) }] };
    },
  );

  server.tool(
    'get_loan',
    'Your active loan, or null.',
    {},
    () => {
      const err = requireVerified(ctx);
      if (err) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: err }) }], isError: true };
      const l = ctx.conn.getState().loan;
      if (!l) return { content: [{ type: 'text', text: JSON.stringify({ loan: null }) }] };
      return { content: [{ type: 'text', text: JSON.stringify({ loan: l.loan }, null, 2) }] };
    },
  );

  server.tool(
    'get_loan_book',
    'All open loans — who owes Davis what, due when. Fetches fresh from server.',
    {},
    async () => {
      const err = requireVerified(ctx);
      if (err) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: err }) }], isError: true };
      ctx.conn.send({ type: 'loanBookReq' });
      await ctx.conn.awaitMsg('loanBook');
      const lb = ctx.conn.getState().loanBook;
      return { content: [{ type: 'text', text: JSON.stringify(lb?.loans ?? [], null, 2) }] };
    },
  );

  server.tool(
    'get_market_listings',
    'Black Market — exclusive-item listings, floors, supply. Fetches fresh.',
    {},
    async () => {
      const err = requireVerified(ctx);
      if (err) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: err }) }], isError: true };
      ctx.conn.send({ type: 'marketReq' });
      await ctx.conn.awaitMsg('market');
      const m = ctx.conn.getState().market;
      return { content: [{ type: 'text', text: JSON.stringify(m?.items ?? [], null, 2) }] };
    },
  );

  server.tool(
    'get_player_sheet',
    'Drill into a player\'s balance sheet by their net-worth rank.',
    { rank: z.number().int().min(1) },
    async ({ rank }) => {
      const err = requireVerified(ctx);
      if (err) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: err }) }], isError: true };
      ctx.conn.send({ type: 'balanceSheetReq', rank });
      const sheet = await ctx.conn.awaitMsg('balanceSheet', (m) => m.rank === rank);
      return { content: [{ type: 'text', text: JSON.stringify({
        name: sheet.name, coins: sheet.coins, holdings: sheet.holdings,
        stockValue: sheet.stockValue, loan: sheet.loan, net: sheet.net,
      }, null, 2) }] };
    },
  );

  server.tool(
    'get_netizen_info',
    'Look up a netizen\'s stats: net worth, max win, challenge status.',
    { netizenId: z.string() },
    async ({ netizenId }) => {
      const err = requireVerified(ctx);
      if (err) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: err }) }], isError: true };
      ctx.conn.send({ type: 'netizenInfoReq', netizenId });
      const info = await ctx.conn.awaitMsg('netizenInfo', (m) => m.netizenId === netizenId);
      return { content: [{ type: 'text', text: JSON.stringify({
        netizenName: info.netizenName,
        netWorth: info.netWorth,
        maxWin: info.maxWin,
        challengedToday: info.challengedToday,
      }, null, 2) }] };
    },
  );

  server.tool(
    'market_dashboard',
    'High-value one-call read: prices, flow, your holdings+worth, liquid coins, net worth+rank+gap, house balance, stability, top 5 news, constraints.',
    {},
    () => {
      const err = requireVerified(ctx);
      if (err) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: err }) }], isError: true };
      const s = ctx.conn.getState();
      const w = s.wallet;
      const st = s.stocks;
      const nw = s.netWorth;
      const h = s.house;
      const news = s.news;
      return { content: [{ type: 'text', text: JSON.stringify({
        prices: st?.prices ?? [],
        holdings: (st?.holdings ?? []).map((h) => ({
          id: h.id, side: h.side, shares: h.shares, worth: h.worth,
          fastSellActive: Date.now() - h.openedAt < FAST_SELL_TAX_MS,
        })),
        coins: w?.coins ?? 0,
        netWorth: nw?.selfRow ? { net: nw.selfRow.net, rank: nw.selfRank, gapToFirst: nw.rows.length > 0 ? nw.rows[0].net - nw.selfRow.net : null } : null,
        house: h ? { balance: h.balance, low: h.balance < 10000, note: 'call get_house for full dashboard' } : null,
        stability: st?.stability ?? null,
        news: (news?.items ?? []).slice(0, 5),
        nextUpdateAt: st?.nextUpdateAt ?? null,
        constraints: {
          fastSellTaxMs: FAST_SELL_TAX_MS,
          fastSellTaxRate: FAST_SELL_TAX_RATE,
        },
      }, null, 2) }] };
    },
  );
}
