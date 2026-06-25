import type { McpConfig } from './config.js';
import type { Connection } from './conn.js';

export interface Identity {
  name: string | null;
  net: number;
  rank: number;
  wins: number;
  losses: number;
  verified: boolean;
}

export interface McpContext {
  cfg: McpConfig;
  conn: Connection;
  identity: Identity;
  autonomy: 'explicit' | 'propose' | 'auto';
  registeredTools: Map<string, { update: (u: { description?: string }) => void }>;
}

export function createContext(cfg: McpConfig, conn: Connection): McpContext {
  return {
    cfg,
    conn,
    identity: { name: null, net: 0, rank: 0, wins: 0, losses: 0, verified: false },
    autonomy: cfg.autonomy,
    registeredTools: new Map(),
  };
}
