import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpContext } from './context.js';
import { writeAudit } from './audit.js';

export function registerControlTools(server: McpServer, ctx: McpContext) {
  const mandateDesc = () =>
    `Current autonomy: ${ctx.autonomy}. Writes: ${ctx.cfg.writes ? 'enabled' : 'disabled'}. Dry-run: ${ctx.cfg.dryRun}.`;

  server.tool(
    'whoami',
    'Resolve the operating identity. Call first to confirm account and mandate.',
    {},
    () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(ctx.identity, null, 2),
        },
      ],
    }),
  );

  server.tool('get_mandate', mandateDesc(), {}, () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            autonomy: ctx.autonomy,
            writesEnabled: ctx.cfg.writes,
            dryRun: ctx.cfg.dryRun,
          },
          null,
          2,
        ),
      },
    ],
  }));

  const setAutonomyDesc = () =>
    `Change Claude's runtime latitude. Current: ${ctx.autonomy}. Use 'explicit' (only do exactly what's instructed), 'propose' (state reasoning, wait for go-ahead), or 'auto' (act toward goal without per-move approval).`;

  server.tool(
    'set_autonomy',
    setAutonomyDesc(),
    { mode: z.enum(['explicit', 'propose', 'auto']) },
    ({ mode }) => {
      const before = ctx.autonomy;
      ctx.autonomy = mode;
      const fromCache = ctx.conn.getState();
      writeAudit(ctx.cfg.auditLog, {
        ts: Date.now(),
        identity: { name: ctx.identity.name },
        autonomy: mode,
        tool: 'set_autonomy',
        params: { mode },
        coinsBefore: fromCache.wallet?.coins ?? null,
        coinsAfter: fromCache.wallet?.coins ?? null,
        delta: null,
        result: 'ok',
        note: `autonomy changed from ${before} to ${mode}`,
      }, ctx.identity);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              previous: before,
              current: mode,
            }),
          },
        ],
      };
    },
  );
}
