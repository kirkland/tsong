import { defineConfig } from 'vite';

// The client lives in ./client. In dev, proxy the WebSocket to the Node server so
// the page (5173) and the game server appear as one origin to the browser. The
// `dev` npm script pins the server to PORT=3001; we follow the same value here so
// an ambient PORT in the shell can't desync the proxy from the server.
const serverPort = process.env.PORT ?? '3001';

export default defineConfig({
  root: 'client',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Allow tunneled hostnames (ngrok etc.) so a second device can join over the internet in dev.
    allowedHosts: true,
    proxy: {
      '/ws': {
        target: `ws://localhost:${serverPort}`,
        ws: true,
      },
      '/api': {
        target: `http://localhost:${serverPort}`,
      },
      '/auth': {
        target: `http://localhost:${serverPort}`,
      },
    },
  },
});
