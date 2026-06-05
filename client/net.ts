// Thin WebSocket wrapper with automatic reconnect. Connects to /ws on the same origin
// (Vite proxies this to the Node server in dev; in production they're already the same
// origin). When the socket drops — a deploy, a network blip, the server restarting —
// it reconnects on its own with backoff, so the page never needs a manual refresh.
// onOpen fires on every (re)connection, which is where the client re-asserts its
// identity (re-sends `join`) so the server reattaches it to its paddle/seat.

import { ClientMsg, ServerMsg } from '../shared/types';

const MIN_BACKOFF = 500; // ms before the first reconnect attempt
const MAX_BACKOFF = 5000; // ms ceiling for the backoff

export function connect(onMsg: (msg: ServerMsg) => void, onOpen?: () => void) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws`;

  let ws: WebSocket;
  let backoff = MIN_BACKOFF;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false; // set if we ever explicitly tear down (not used today, but safe)

  function open() {
    ws = new WebSocket(url);

    ws.onopen = () => {
      backoff = MIN_BACKOFF; // a clean connection resets the backoff
      onOpen?.();
    };

    ws.onmessage = (e) => {
      try {
        onMsg(JSON.parse(e.data) as ServerMsg);
      } catch {
        /* ignore malformed frames */
      }
    };

    // close fires for both clean and error closes; error is followed by close, so we
    // schedule the reconnect here only and just swallow the error event.
    ws.onerror = () => {};
    ws.onclose = () => {
      if (closed) return;
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null) return; // already pending
    const wait = backoff + Math.random() * 250; // small jitter to avoid thundering herd
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, wait);
  }

  // Reconnect promptly when the user returns to a backgrounded tab whose socket the
  // browser quietly dropped, instead of waiting out the backoff timer.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ws.readyState === WebSocket.CLOSED) {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      backoff = MIN_BACKOFF;
      open();
    }
  });

  open();

  function send(msg: ClientMsg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  return { send };
}
