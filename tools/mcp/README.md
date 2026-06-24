# tsong Economy MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude act as
your autonomous market operator in tsong. Connects via WebSocket as an authenticated player
and exposes the full economy — stocks, loans, casino, Black Market, bounties, tips, and
netizen challenges — as MCP tools.

## Quick start

### 1. Get your JWT

1. Sign in to [tsong.life](https://tsong.life) with Google
2. Open DevTools → Application → Cookies → `tsong.life` → `tsong_session`
3. Copy the cookie value

### 2. Configure

Create a `.mcp.json` in the repo root (gitignored, keeps your JWT out of git):

```json
{
  "mcpServers": {
    "tsong": {
      "command": "npx",
      "args": ["-y", "tsx", "tools/mcp/index.ts"],
      "env": {
        "TSONG_WS_URL": "wss://tsong.life/ws",
        "TSONG_NICKNAME": "YOUR_NICKNAME_HERE",
        "TSONG_EXPECT_NAME": "YOUR_NICKNAME_HERE",
        "TSONG_SESSION": "<your tsong_session JWT>",
        "TSONG_WRITES": "false"
      }
    }
  }
}
```

Or copy `.env.example` to `.env` and set the variables there.

### 3. Run

```bash
npm run mcp
```

First run reads-only to verify identity binding (see Verification below).

## Client registration

The server is a standard stdio MCP program — any MCP-capable client can launch it. Only the
registration file differs per client.

### Claude Code (`.mcp.json`)

Place in repo root:

```json
{
  "mcpServers": {
    "tsong": {
      "command": "npx",
      "args": ["-y", "tsx", "tools/mcp/index.ts"],
      "env": {
        "TSONG_NICKNAME": "YOUR_NICKNAME_HERE",
        "TSONG_EXPECT_NAME": "YOUR_NICKNAME_HERE",
        "TSONG_SESSION": "<JWT>",
        "TSONG_WRITES": "false"
      }
    }
  }
}
```

### opencode (`opencode.json`)

```json
{
  "mcp": {
    "tsong": {
      "type": "local",
      "command": ["npx", "-y", "tsx", "tools/mcp/index.ts"],
      "environment": {
        "TSONG_WS_URL": "wss://tsong.life/ws",
        "TSONG_NICKNAME": "YOUR_NICKNAME_HERE",
        "TSONG_EXPECT_NAME": "YOUR_NICKNAME_HERE",
        "TSONG_SESSION": "<JWT>",
        "TSONG_WRITES": "false"
      },
      "enabled": true
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

Same `mcpServers` shape as Claude Code's `.mcp.json` above. Place in `.cursor/mcp.json`
(project) or `~/.cursor/mcp.json` (global).

### Cline (VS Code extension)

Edit `cline_mcp_settings.json` (VS Code extension settings) with the same `mcpServers` shape.

### Zed (`settings.json`)

```json
{
  "context_servers": {
    "tsong": {
      "command": {
        "path": "npx",
        "args": ["-y", "tsx", "tools/mcp/index.ts"],
        "env": {
          "TSONG_NICKNAME": "YOUR_NICKNAME_HERE",
          "TSONG_EXPECT_NAME": "YOUR_NICKNAME_HERE",
          "TSONG_SESSION": "<JWT>"
        }
      }
    }
  }
}
```

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TSONG_WS_URL` | no | `wss://tsong.life/ws` | WebSocket endpoint |
| `TSONG_NICKNAME` | **yes** | — | Join nickname |
| `TSONG_SESSION` | **yes (OAuth)** | — | `tsong_session` JWT (Cookie header) |
| `TSONG_PID` | fallback | — | Guest credential (only if not using OAuth) |
| `TSONG_EXPECT_NAME` | **yes** | — | Account name the server must resolve to (identity guard) |
| `TSONG_WRITES` | no | `false` | Master enable for ALL mutating tools |
| `TSONG_DRY_RUN` | no | `false` | Log intent, don't send (testing) |
| `TSONG_AUTONOMY` | no | `propose` | `explicit` \| `propose` \| `auto` — Claude's default latitude |
| `TSONG_AUDIT_LOG` | no | `tools/mcp/audit.log` | Append-only action log path |

Require `TSONG_NICKNAME`, `TSONG_EXPECT_NAME`, and exactly one of `TSONG_SESSION`/`TSONG_PID`.

## Autonomy model

The MCP exposes a `get_mandate` tool and a `set_autonomy` tool to control Claude's latitude:

- **explicit** — only do exactly what's instructed
- **propose** — state the move + reasoning, wait for go-ahead (default)
- **auto** — trade/tip/gamble toward a stated goal without per-move approval

Call `whoami` first in a session to confirm the operating identity and current mandate.

## Security

- **Your JWT is full account access.** Never commit it. Never paste it into chat.
- The MCP enforces identity verification on every (re)connect: if the server-side identity
  doesn't match `TSONG_EXPECT_NAME` or the account has 0 games played, ALL tools are refused
  until you refresh the JWT.
- `TSONG_WRITES=false` by default — flip it to `true` only when you want Claude to act.
- Every mutating action is logged to the audit log with before/after coin balances.
- There is **no spend cap and no per-action confirmation** when writes are enabled.

## Verification

1. Put your real JWT + nickname in env with `TSONG_WRITES=false`
2. Run `npm run mcp` — stderr should show connected/joined and identity verified
3. Register in your MCP client; call `whoami` — confirm resolved name matches `TSONG_EXPECT_NAME`
4. Call `market_dashboard` / `get_balance` — cross-check against the browser
5. Flip `TSONG_WRITES=true` and start with one tiny trade

## Architecture

```
tools/mcp/
  index.ts    Entry: create McpServer, register tools, connect transport
  config.ts   Env loading + validation
  conn.ts     Persistent WS to tsong: connect/reconnect/join/send/awaitMsg
  state.ts    Cache type + reduce — folds ServerMsg into latest-by-type
  context.ts  Shared mutable state (identity, autonomy, tool references)
  control.ts  Meta tools: whoami, get_mandate, set_autonomy
  reads.ts    Read tools: balance, portfolio, market, leaderboard, news, etc.
  actions.ts  Stock/loan/tip/bounty/market/action tools
  casino.ts   Casino/minigame tools: spin, loot box, roulette, BJ, craps, crash, slots
  audit.ts    Append-only JSON-lines audit log
  README.md   This file
```
