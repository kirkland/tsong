import WebSocket from 'ws';
import type { ClientMsg, ServerMsg } from '../../shared/types.js';
import type { McpConfig } from './config.js';
import { type Cache, freshCache, reduce } from './state.js';

const MIN_BACKOFF = 500;
const MAX_BACKOFF = 5000;

interface Waiter<T extends ServerMsg['type'] = ServerMsg['type']> {
  type: T;
  predicate?: (msg: Extract<ServerMsg, { type: T }>) => boolean;
  resolve: (msg: Extract<ServerMsg, { type: T }>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Connection {
  private ws: WebSocket | null = null;
  private cfg: McpConfig;
  private cache: Cache = freshCache();
  private backoff = MIN_BACKOFF;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readyResolve: (() => void) | null = null;
  private readyTimeout: ReturnType<typeof setTimeout> | null = null;
  private _ready: Promise<void>;
  private waiters: Waiter[] = [];
  private _shutdown = false;

  constructor(cfg: McpConfig) {
    this.cfg = cfg;
    this._ready = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
    this.connect();
  }

  getState(): Readonly<Cache> {
    return this.cache;
  }

  ready(): Promise<void> {
    return this._ready;
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  awaitMsg<T extends ServerMsg['type']>(
    type: T,
    predicate?: (msg: Extract<ServerMsg, { type: T }>) => boolean,
    timeoutMs = 4000,
  ): Promise<Extract<ServerMsg, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`awaitMsg(${type}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ type, predicate: predicate as Waiter['predicate'], resolve: resolve as (msg: ServerMsg) => void, reject, timer });
    });
  }

  shutdown() {
    this._shutdown = true;
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('connection shutting down'));
    }
    this.waiters = [];
    this.ws?.close();
    this.ws = null;
  }

  private connect() {
    if (this._shutdown || this.closed) return;

    const headers: Record<string, string> = {};
    if (this.cfg.session) {
      headers['Cookie'] = 'tsong_session=' + this.cfg.session;
    }

    try {
      this.ws = new WebSocket(this.cfg.wsUrl, { headers });
    } catch (err) {
      console.error('WebSocket construction failed:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.backoff = MIN_BACKOFF;
      this.send({
        type: 'join',
        nickname: this.cfg.nickname,
        pid: this.cfg.session ? 'oauth' : (this.cfg.pid ?? 'guest'),
      });
      this.setReadyTimeout();
    };

    this.ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data as string) as ServerMsg;
      } catch {
        return;
      }

      this.cache = reduce(this.cache, msg);

      this.resolveWaiters(msg);

      if (
        this.readyResolve &&
        this.cache.wallet &&
        this.cache.stocks &&
        this.cache.leaderboard &&
        this.cache.netWorth
      ) {
        const r = this.readyResolve;
        this.readyResolve = null;
        if (this.readyTimeout) {
          clearTimeout(this.readyTimeout);
          this.readyTimeout = null;
        }
        r();
      }
    };

    this.ws.onerror = () => {};

    this.ws.onclose = () => {
      if (this.closed || this._shutdown) return;
      this.scheduleReconnect();
    };
  }

  private setReadyTimeout() {
    if (this.readyTimeout) clearTimeout(this.readyTimeout);
    this.readyTimeout = setTimeout(() => {
      if (this.readyResolve) {
        const r = this.readyResolve;
        this.readyResolve = null;
        r();
        console.error('ready() resolved after 8s timeout (partial state)');
      }
    }, 8000);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return;
    if (this._shutdown) return;
    const wait = this.backoff + Math.random() * 250;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
  }

  private resolveWaiters(msg: ServerMsg) {
    const remaining: Waiter[] = [];
    for (const w of this.waiters) {
      if (w.type === msg.type) {
        if (!w.predicate || w.predicate(msg as any)) {
          clearTimeout(w.timer);
          w.resolve(msg as any);
          continue;
        }
      }
      remaining.push(w);
    }
    this.waiters = remaining;
  }
}
