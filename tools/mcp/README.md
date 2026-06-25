# tsong Economy MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude act as
your autonomous market operator in the [tsong](https://tsong.life) crypto-economy game.
Connects via WebSocket as an authenticated player and exposes the full economy — stocks,
loans, casino, Black Market, bounties, tips, and netizen challenges — as MCP tools.

## Prerequisites

- Node.js ≥ 18
- A tsong account (either **Google OAuth** or a **guest PID** with at least 1 game played)
- `npm install` in the repo root (installs `@modelcontextprotocol/sdk`, `ws`, `tsx`)

## Quick start

### 1. Get your credentials

Choose one:

**OAuth (Google sign-in):**
1. Sign in at [tsong.life](https://tsong.life) with Google
2. DevTools → Application → Cookies → `tsong.life` → copy the `tsong_session` value

**Guest PID (browser-generated UUID):**
1. Open tsong.life in any browser
2. DevTools → Application → Cookies → `tsong.life` → copy the `tsong_pid` value
3. Your nickname is whatever you chose when you first played

### 2. Configure

Copy `.env.example` to `.env` in the repo root and fill in:

```bash
TSONG_NICKNAME=your_ingame_nickname
TSONG_EXPECT_NAME=your_ingame_nickname
TSONG_SESSION=<your tsong_session cookie value>   # OAuth path
# — OR —
TSONG_PID=<your tsong_pid cookie value>            # guest path (only one of the two)
TSONG_WRITES=false                                  # start read-only
```

Or if you're using Claude Code, create `.mcp.json` in the repo root (gitignored):

```json
{
  "mcpServers": {
    "tsong": {
      "command": "npx",
      "args": ["-y", "tsx", "tools/mcp/index.ts"],
      "env": {
        "TSONG_NICKNAME": "your_nickname",
        "TSONG_EXPECT_NAME": "your_nickname",
        "TSONG_SESSION": "<your tsong_session JWT>",
        "TSONG_WRITES": "false"
      }
    }
  }
}
```

### 3. Run

```bash
npm run mcp
```

You should see stderr output like:
```
identity verified: your_nickname (rank 12, 10W/5L, 50000 net worth)
tsong MCP ready — ✅ your_nickname
```

If you see `IDENTITY BLOCKED`, check:
- **"name mismatch"** → `TSONG_EXPECT_NAME` doesn't match your in-game name
- **"0 games played"** → play at least one match on tsong.life first
- **"could not resolve account name"** → your `TSONG_SESSION` or `TSONG_PID` is wrong/expired

### 4. Test (read-only)

Register in your MCP client (see below), then call:
- `whoami` — confirms identity and account
- `market_dashboard` — one-call overview of prices + holdings + net worth
- `get_balance` — your liquid coins and cosmetics

Cross-check values against the live site.

### 5. Enable trading

Flip `TSONG_WRITES=true` in your config. **There is no spend cap.** Start small.

## Client registration

The server is a standard stdio MCP program — any MCP-capable client can launch it.
Only the registration config differs per client. All examples below assume the repo root
as the working directory.

### Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "tsong": {
      "command": "npx",
      "args": ["-y", "tsx", "tools/mcp/index.ts"],
      "env": {
        "TSONG_NICKNAME": "YOUR_NICKNAME_HERE",
        "TSONG_EXPECT_NAME": "YOUR_NICKNAME_HERE",
        "TSONG_SESSION": "<JWT or PID>",
        "TSONG_WRITES": "false"
      }
    }
  }
}
```

### opencode (`opencode.json`)

In your global `~/.config/opencode/opencode.jsonc` or a project-level `opencode.json`:

```json
{
  "mcp": {
    "tsong": {
      "type": "local",
      "command": ["npx", "-y", "tsx", "tools/mcp/index.ts"],
      "environment": {
        "TSONG_NICKNAME": "YOUR_NICKNAME_HERE",
        "TSONG_EXPECT_NAME": "YOUR_NICKNAME_HERE",
        "TSONG_SESSION": "<JWT or PID>",
        "TSONG_WRITES": "false"
      },
      "enabled": true
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

Same `mcpServers` shape as Claude Code. Place in `.cursor/mcp.json` (project) or
`~/.cursor/mcp.json` (global).

### Cline (VS Code)

Edit `cline_mcp_settings.json` (VS Code extension settings) — same `mcpServers` shape.

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
          "TSONG_SESSION": "<JWT or PID>"
        }
      }
    }
  }
}
```

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TSONG_WS_URL` | no | `wss://tsong.life/ws` | WebSocket endpoint (override for local dev) |
| `TSONG_NICKNAME` | **yes** | — | Your in-game nickname (join name) |
| `TSONG_SESSION` | OAuth | — | `tsong_session` JWT from DevTools Cookies |
| `TSONG_PID` | guest | — | `tsong_pid` UUID from DevTools Cookies (fallback) |
| `TSONG_EXPECT_NAME` | **yes** | — | Must match your account's resolved name (identity guard) |
| `TSONG_WRITES` | no | `false` | Master enable for ALL mutating tools |
| `TSONG_DRY_RUN` | no | `false` | Log intent without sending (testing) |
| `TSONG_AUTONOMY` | no | `propose` | `explicit` \| `propose` \| `auto` (Claude's latitude) |
| `TSONG_AUDIT_LOG` | no | `tools/mcp/audit.log` | Append-only action log path |

You must set `TSONG_NICKNAME`, `TSONG_EXPECT_NAME`, and **exactly one** of
`TSONG_SESSION`/`TSONG_PID`.

## Tool catalog

### Meta (always available)

| Tool | Description |
|---|---|
| `whoami` | Resolved identity: name, rank, net worth, wins/losses, verification status |
| `get_mandate` | Current autonomy mode + writes/dry-run state |
| `set_autonomy {mode}` | Change Claude's latitude at runtime |

### Reads (require verified identity)

| Tool | Description |
|---|---|
| `get_balance` | Liquid coins, owned cosmetics, exclusives, daily-spin status |
| `get_portfolio` | Open stock positions: shares, cost basis, live worth, fast-sell status |
| `get_market` | Global price board, your holdings, market stability |
| `get_net_worth` | Net worth leaderboard, your position, gap to first |
| `get_leaderboard` | Elo leaderboard |
| `get_news` | Market news headlines (with optional server refresh) |
| `get_house` | House treasury balance + payout-throttle warning |
| `get_loan` | Your active loan (or null) |
| `get_loan_book` | All open loans (fresh fetch) |
| `get_market_listings` | Black Market exclusive listings |
| `get_player_sheet {rank}` | Balance sheet drill-down by net-worth rank |
| `get_netizen_info {netizenId}` | Netizen stats |
| `market_dashboard` | **One-call read**: prices, flow, holdings, net worth, house, stability, news, constraints |

### Actions (require `TSONG_WRITES=true`)

| Tool | Description |
|---|---|
| `buy {coin, amount}` | Open a long position |
| `short {coin, amount}` | Open a short position |
| `sell {coin, side?}` | Close a position (long cash-out / short cover) |
| `take_loan {amount}` | Borrow from Davis |
| `repay_loan` | Repay your loan in full |
| `tip {to, amount}` | ⚠️ Irreversible coin transfer (max 1M) |
| `place_bounty {to, amount}` | Put coins on a player's head |
| `list_item {instanceId, ask}` | List an exclusive on the Black Market |
| `cancel_listing {listingId}` | Cancel your listing |
| `buy_item {item}` | Buy the lowest-ask exclusive |
| `challenge_netizen {netizenId, wager}` | Duel a netizen (win up to 20% of their net worth) |

### Casino (require `TSONG_WRITES=true`)

| Tool | Description |
|---|---|
| `daily_spin` | Once-per-24h reward spin |
| `loot_box` | Open a loot box (2500 coins, usually nothing) |
| `roulette {bets}` | European roulette (max 50k stake) |
| `blackjack_bet {amount}` | Start a blackjack hand (max 50k) |
| `blackjack_action {action}` | Hit / stand / double down |
| `craps_roll {pass, dontPass}` | Street craps |
| `crash_bet {amount, autoCashout?}` | Bet on crash round |
| `crash_cashout` | Cash out of live crash round |
| `crash_cancel` | Cancel pending crash bet |
| `slots_spin {amount}` | 3-reel slot machine (max 50k) |

## Autonomy model

The MCP exposes `get_mandate` and `set_autonomy` tools to control Claude's latitude:

- **explicit** — only do exactly what's instructed
- **propose** — state the move + reasoning, wait for go-ahead **(default)**
- **auto** — trade/tip/gamble toward a stated goal without per-move approval

Call `whoami` at the start of every session to confirm the operating identity
and current mandate. The audit log records the active autonomy mode for every action.

## Security

- **Your JWT is full account access.** Never commit it. Never paste it into chat.
- The MCP **enforces identity verification** on every (re)connect: if the server-side
  identity doesn't match `TSONG_EXPECT_NAME` or the account has 0 games played,
  ALL tools are refused until you refresh the credential.
- `TSONG_WRITES=false` by default — flip it to `true` only when you want Claude to act.
- Every mutating action is logged to the audit log with before/after coin balances.
- **There is no spend cap and no per-action confirmation** when writes are enabled.
- The fast-sell tax (10%) applies to any position closed within 5 minutes of opening.

## Verification checklist

1. `npm install` (first time)
2. Set credentials in `.env` with `TSONG_WRITES=false`
3. `npm run mcp` — confirm identity verified in stderr
4. Register in your MCP client, call `whoami` — name matches `TSONG_EXPECT_NAME`, `verified: true`
5. Call `market_dashboard` / `get_balance` — cross-check coins + holdings against the browser
6. **Identity guard test:** use a garbage `TSONG_SESSION` — confirm `whoami` returns `verified: false`
7. Set `TSONG_WRITES=true`, do one tiny `buy`/`sell` — confirm audit log entry
8. Check `tools/mcp/audit.log` for before/after balances

## Architecture

```
tools/mcp/
  index.ts    Entry: create McpServer, register tools, connect stdio transport
  config.ts   Env loading + validation (zod, placeholder guards)
  conn.ts     Persistent WebSocket: connect/reconnect/join/send/awaitMsg
  state.ts    Cache + reduce — folds ServerMsg into latest-by-type
  context.ts  Shared mutable state (identity, autonomy, tool references)
  control.ts  Meta tools: whoami, get_mandate, set_autonomy
  reads.ts    13 read tools: balance, portfolio, market, leaderboard, news, etc.
  actions.ts  11 action tools: buy, sell, short, loans, tips, bounties, market, netizens
  casino.ts   10 casino tools: spin, loot box, roulette, BJ, craps, crash, slots
  audit.ts    Append-only JSON-lines audit log
  README.md   This file
```

Every file imports shared types from `../../shared/types.js` and uses the same
message contracts as the browser client — no API needed.
