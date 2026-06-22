// Google OAuth flow + JWT session management.
// Requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, JWT_SECRET, and BASE_URL env vars.
// All handlers are no-ops (501) when those vars are absent so the server boots cleanly without them.

import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { upsertPlayer } from './db';

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     ?? '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';
const JWT_SECRET    = process.env.JWT_SECRET           ?? '';

export const OAUTH_ENABLED = !!(CLIENT_ID && CLIENT_SECRET && JWT_SECRET);

function redirectUri(): string {
  const base = process.env.BASE_URL ?? 'http://localhost:3001';
  return `${base}/auth/google/callback`;
}

export interface AuthSession {
  pid:   string;
  name:  string;
  email: string;
}

export function handleAuthGoogle(_req: IncomingMessage, res: ServerResponse): void {
  if (!OAUTH_ENABLED) { res.writeHead(501); res.end('OAuth not configured'); return; }
  const url = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, redirectUri()).generateAuthUrl({
    access_type: 'offline',
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account',
  });
  res.writeHead(302, { Location: url });
  res.end();
}

export async function handleAuthCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!OAUTH_ENABLED) { res.writeHead(501); res.end('OAuth not configured'); return; }
  const u    = new URL(req.url!, 'http://x');
  const code = u.searchParams.get('code');
  if (!code) { res.writeHead(302, { Location: '/?auth_error=1' }); res.end(); return; }
  try {
    const c      = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, redirectUri());
    const { tokens } = await c.getToken(code);
    const ticket = await c.verifyIdToken({ idToken: tokens.id_token!, audience: CLIENT_ID });
    const p      = ticket.getPayload()!;
    const pid    = `g:${p.sub}`;
    const name   = (p.name ?? p.email ?? 'anon').slice(0, 20);
    const email  = p.email ?? '';
    await upsertPlayer(pid, name, email);
    const token  = jwt.sign({ pid, name, email }, JWT_SECRET, { expiresIn: '30d' });
    res.writeHead(302, {
      'Set-Cookie': `tsong_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 60 * 60}`,
      Location: '/',
    });
    res.end();
  } catch (e) {
    console.error('OAuth callback failed:', e);
    res.writeHead(302, { Location: '/?auth_error=1' });
    res.end();
  }
}

export function handleAuthMe(req: IncomingMessage, res: ServerResponse): void {
  const session = parseSession(req.headers.cookie);
  res.setHeader('content-type', 'application/json');
  if (!session) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'not logged in', oauthEnabled: OAUTH_ENABLED }));
    return;
  }
  res.end(JSON.stringify({ ...session, oauthEnabled: OAUTH_ENABLED }));
}

export function handleLogout(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(302, {
    'Set-Cookie': 'tsong_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
    Location: '/',
  });
  res.end();
}

export function parseSession(cookieHeader: string | undefined): AuthSession | null {
  if (!JWT_SECRET || !cookieHeader) return null;
  const m = cookieHeader.match(/(?:^|;\s*)tsong_session=([^;]+)/);
  if (!m) return null;
  try {
    return jwt.verify(m[1], JWT_SECRET) as AuthSession;
  } catch {
    return null;
  }
}
