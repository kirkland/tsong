import { appendFileSync } from 'node:fs';
import type { Identity } from './context.js';

export interface AuditEntry {
  ts: number;
  identity: { name: string | null };
  autonomy: string;
  tool: string;
  params: Record<string, unknown>;
  coinsBefore: number | null;
  coinsAfter: number | null;
  delta: number | null;
  result: 'ok' | 'rejected' | 'dry-run';
  note?: string;
}

export function writeAudit(path: string, entry: AuditEntry, _identity: Identity) {
  const line = JSON.stringify({ ...entry, ts: entry.ts ?? Date.now() }) + '\n';
  try {
    appendFileSync(path, line);
  } catch (err) {
    console.error('audit write failed:', err);
  }
  console.error('AUDIT:', line.trim());
}
