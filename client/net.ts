// Thin WebSocket wrapper. Connects to /ws on the same origin (Vite proxies this to
// the Node server in dev; in production they're already the same origin).

import { ClientMsg, ServerMsg } from '../shared/types';

export function connect(onMsg: (msg: ServerMsg) => void) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onmessage = (e) => {
    try {
      onMsg(JSON.parse(e.data) as ServerMsg);
    } catch {
      /* ignore malformed frames */
    }
  };

  function send(msg: ClientMsg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  return { send };
}
