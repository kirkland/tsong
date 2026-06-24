import { z } from 'zod';

export interface McpConfig {
  wsUrl: string;
  nickname: string;
  session: string | null;
  pid: string | null;
  writes: boolean;
  dryRun: boolean;
  expectName: string;
  autonomy: 'explicit' | 'propose' | 'auto';
  auditLog: string;
}

const AUTONOMY_VALUES = ['explicit', 'propose', 'auto'] as const;

const envSchema = z.object({
  TSONG_WS_URL: z.string().default('wss://tsong.life/ws'),
  TSONG_NICKNAME: z.string().min(1, 'TSONG_NICKNAME is required — set it to YOUR tsong nickname'),
  TSONG_SESSION: z.string().optional(),
  TSONG_PID: z.string().optional(),
  TSONG_WRITES: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  TSONG_DRY_RUN: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  TSONG_EXPECT_NAME: z
    .string()
    .min(1, 'TSONG_EXPECT_NAME is required — must match your tsong nickname'),
  TSONG_AUTONOMY: z
    .enum(AUTONOMY_VALUES)
    .default('propose'),
  TSONG_AUDIT_LOG: z.string().default('tools/mcp/audit.log'),
});

export function loadConfig(): McpConfig {
  const raw = envSchema.parse(process.env);

  const hasSession = !!raw.TSONG_SESSION;
  const hasPid = !!raw.TSONG_PID;
  if (!hasSession && !hasPid) {
    console.error(
      'FATAL: must set TSONG_SESSION (OAuth JWT) or TSONG_PID (guest fallback)',
    );
    process.exit(1);
  }

  if (
    raw.TSONG_NICKNAME === 'YOUR_NICKNAME_HERE' ||
    raw.TSONG_EXPECT_NAME === 'YOUR_NICKNAME_HERE'
  ) {
    console.error(
      'FATAL: replace YOUR_NICKNAME_HERE with your actual tsong nickname in TSONG_NICKNAME and TSONG_EXPECT_NAME',
    );
    process.exit(1);
  }
  if (raw.TSONG_SESSION && raw.TSONG_SESSION === 'YOUR_TSONG_SESSION_JWT_HERE') {
    console.error(
      'FATAL: replace YOUR_TSONG_SESSION_JWT_HERE with your real tsong_session JWT in TSONG_SESSION',
    );
    process.exit(1);
  }
  if (raw.TSONG_PID && raw.TSONG_PID === 'YOUR_GUEST_PID_HERE') {
    console.error(
      'FATAL: replace YOUR_GUEST_PID_HERE with your real guest pid in TSONG_PID',
    );
    process.exit(1);
  }

  return {
    wsUrl: raw.TSONG_WS_URL,
    nickname: raw.TSONG_NICKNAME,
    session: raw.TSONG_SESSION ?? null,
    pid: raw.TSONG_PID ?? null,
    writes: raw.TSONG_WRITES,
    dryRun: raw.TSONG_DRY_RUN,
    expectName: raw.TSONG_EXPECT_NAME,
    autonomy: raw.TSONG_AUTONOMY,
    auditLog: raw.TSONG_AUDIT_LOG,
  };
}
