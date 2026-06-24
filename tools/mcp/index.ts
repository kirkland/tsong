import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { Connection } from './conn.js';
import { createContext } from './context.js';
import { registerControlTools } from './control.js';
import { registerReadTools } from './reads.js';
import { registerActionTools } from './actions.js';
import { registerCasinoTools } from './casino.js';
import { writeAudit } from './audit.js';

const cfg = loadConfig();
const conn = new Connection(cfg);
const ctx = createContext(cfg, conn);

const server = new McpServer({ name: 'tsong-economy', version: '0.1.0' });

async function verifyIdentity(): Promise<void> {
  const cache = conn.getState();
  const expect = cfg.expectName;
  let name: string | null = null;
  let wins = 0;
  let losses = 0;
  let net = 0;
  let rank = 0;

  const nw = cache.netWorth;
  const lb = cache.leaderboard;

  if (nw?.selfRow?.name) {
    name = nw.selfRow.name;
    net = nw.selfRow.net;
    rank = nw.selfRank ?? 0;
  }

  if (lb?.selfRank && lb.rows[lb.selfRank - 1]) {
    const row = lb.rows[lb.selfRank - 1];
    if (!name) name = row.name;
    wins = row.wins;
    losses = row.losses;
    if (!rank) rank = lb.selfRank;
  }

  const played = wins + losses >= 1;
  const match = name === expect;

  if (match && played) {
    ctx.identity = { name, net, rank, wins, losses, verified: true };
    console.error(`identity verified: ${name} (rank ${rank}, ${wins}W/${losses}L, ${net} net worth)`);
  } else {
    const reasons: string[] = [];
    if (!name) reasons.push('could not resolve account name (server returned guest or unknown)');
    if (name && !match) reasons.push(`name mismatch: got "${name}", expected "${expect}"`);
    if (!played) reasons.push('account has 0 games played (guest or brand-new account)');
    ctx.identity = { name, net: 0, rank: 0, wins: 0, losses: 0, verified: false };
    console.error(
      `IDENTITY BLOCKED — refusing tools. ${reasons.join('; ')}. ` +
        'Refresh TSONG_SESSION (JWT likely expired) or check TSONG_EXPECT_NAME.',
    );
  }
}

async function main() {
  registerControlTools(server, ctx);
  registerReadTools(server, ctx);
  registerActionTools(server, ctx);
  registerCasinoTools(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  await conn.ready();

  await verifyIdentity();

  const startEntry = {
    ts: Date.now(), identity: { name: ctx.identity.name }, autonomy: ctx.autonomy,
    tool: '_start', params: { verified: ctx.identity.verified },
    coinsBefore: null, coinsAfter: null, delta: null,
    result: ctx.identity.verified ? 'ok' as const : 'rejected' as const,
    note: `MCP server started — identity ${ctx.identity.verified ? 'verified' : 'BLOCKED'}`,
  };
  writeAudit(cfg.auditLog, startEntry, ctx.identity);

  console.error(
    `tsong MCP ready — ${ctx.identity.verified ? '✅ ' + ctx.identity.name : '⚠️ UNVERIFIED'}` +
      ` | autonomy: ${ctx.autonomy} | writes: ${cfg.writes}`,
  );

  process.on('SIGINT', () => {
    console.error('shutting down');
    conn.shutdown();
    server.close().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    console.error('shutting down');
    conn.shutdown();
    server.close().then(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
