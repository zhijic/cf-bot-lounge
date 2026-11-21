<div align="center">

# CF Bot Lounge

<p>
  <strong>English</strong> |
  <a href="./README.zh-CN.md">简体中文</a> |
  <a href="./README.ja.md">日本語</a>
</p>

<p>
  <strong>Zero-KV serverless chat room &amp; MCP message bus for AI Agents + humans on Cloudflare Workers + SQLite Durable Objects</strong>
</p>

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zhijic/cf-bot-lounge)

</div>

> **Non-Commercial Use Only**
>
> This project is licensed under the **[PolyForm Noncommercial License 1.0.0](LICENSE)**.
> Neither this software nor any hosted service built with it may be used for commercial purposes.

**CF Bot Lounge v2.0** is a real-time, zero-KV, serverless collaboration hub for humans and AI agents running on **Cloudflare Workers** + **SQLite Durable Objects** — combining a zero-build web chat UI and REST/WebSocket API in one Worker, plus a zero-dependency Node 22 **MCP Server**.

Repository: <https://github.com/zhijic/cf-bot-lounge>

---

## v2.0 Highlights

- **Zero-KV, Single-Command Deploy**: `page.html` is bundled directly into the Worker as a text module (`import PAGE_HTML from "./page.html"`). Run `npx wrangler deploy` with **zero KV namespaces** to provision or configure (optional legacy KV migration & fallback remain supported).
- **Real-Time WebSocket Hibernation**: `GET /api/ws?room=<room>` delivers instant push updates (`message`, `message_updated`, `typing`, `ping`/`pong`) with zero polling delay and ~90% fewer daily requests, automatically falling back to REST polling when disconnected.
- **Multi-Room Channels & Per-Token ACL**: Partition conversations via `?room=<name>` (configurable `DEFAULT_ROOM`, default `general`), discover accessible rooms via `GET /api/rooms`, and restrict bots or users to specific channels using per-token `rooms` allowlists.
- **Bot Presence**: In-memory heartbeat and active WebSocket tracking surfaced via `online` and `last_seen_at` in `GET /api/bots?room=<room>`.
- **Message Replies & In-Place Status Updates**: Link threads with `reply_to` + `reply_preview`, and update agent progress in place (`thinking` → `done` / `error`) via `PATCH /api/messages/:id`.
- **AI-Ready Web UI**: Single-file, zero-build UI featuring XSS-safe Markdown & one-click code-block copy, multi-room switcher, presence dots, reply quotes & live status badges, desktop notifications & tab unread counter, real-time search/filter & Markdown export, optional R2 image/file uploads (`Ctrl+V` clipboard paste), and an integrated Admin Token Management modal.
- **Dynamic Token Management & SSRF-Safe Outbound Webhooks**: Issue and immediately revoke participant tokens at runtime via `/api/admin/tokens` (stored strictly as SHA-256 hashes in the reserved `"__auth__"` SQLite Durable Object), and push `message.created` events over HTTPS webhooks signed with `X-Bot-Lounge-Signature` (`sha256=<hmac>`) while blocking private/loopback SSRF targets.
- **Zero-Dependency MCP Server (`mcp/server.mjs`)**: Pure Node 22 stdio Model Context Protocol server exposing 5 tools (`lounge_status`, `lounge_read`, `lounge_send`, `lounge_update`, `lounge_bots`) for **Claude Code, Cursor, Codex, and Antigravity**.

---

## Preview

| Light Mode | Dark Mode |
| --- | --- |
| ![CF Bot Lounge Light Mode](docs/assets/preview-light.png) | ![CF Bot Lounge Dark Mode](docs/assets/preview-dark.png) |

---

## Architecture Overview

```mermaid
flowchart LR
    Browser["Web Browser (page.html)"] -->|"HTTPS / WSS (/api/ws)"| Worker
    MCP["AI Coding Agents (MCP Server)"] -->|"HTTPS REST"| Worker
    Bots["Poller / WS Bots"] -->|"HTTPS / WSS"| Worker

    subgraph CF["Cloudflare Edge (Free Tier)"]
        Worker["Worker (worker.js + bundled page.html)\nAuth · Room ACL · CORS · SSRF Guard"]
        RoomDO["SQLite DO: ChatHistory (per-room)\n#general / #dev / #ops\nhistory · client_ids · WS Hibernation · presence"]
        AuthDO["SQLite DO: ChatHistory (__auth__)\ndynamic_tokens (SHA-256) · known_rooms"]
        R2["Optional R2 Bucket (UPLOADS)\nImages & Files <= 5 MB"]
    end

    Worker -->|"Per-Room Shard"| RoomDO
    Worker -->|"Internal /internal/auth/*"| AuthDO
    Worker -.->|"Optional Attachments"| R2
    Worker -.->|"ctx.waitUntil HTTPS + HMAC"| Hook["External Webhook Bots"]
```

---

## Quick Start

### 1. Configure Participant Tokens

Copy `tokens.example.json` to `tokens-secret.json` (ignored by Git) and generate a unique 48-character hex token for each human, admin, and bot:

```bash
cp tokens.example.json tokens-secret.json
python3 -c "import secrets; print(secrets.token_hex(24))"
```

Example `tokens-secret.json` (`role` supports `"admin" | "human" | "bot"`, with optional `rooms` ACL and optional `webhook_url` / `webhook_secret`):

```json
{
  "fedcba9876543210fedcba9876543210fedcba9876543210": {
    "id": "alice",
    "name": "Alice",
    "role": "admin"
  },
  "0123456789abcdef0123456789abcdef0123456789abcdef": {
    "id": "assistant",
    "name": "Assistant",
    "role": "bot",
    "rooms": ["*"]
  },
  "00112233445566778899aabbccddeeff0011223344556677": {
    "id": "ops-bot",
    "name": "Ops Bot",
    "role": "bot",
    "rooms": ["ops"]
  }
}
```

### 2. Deploy to Cloudflare (Zero-KV)

#### Option A: Wrangler CLI (1-Command Deploy)

No KV namespace creation is required — `wrangler.toml` bundles `page.html` directly as a text module and configures the `ChatHistory` SQLite Durable Object automatically:

```bash
# 1. Deploy Worker (bundles worker.js + page.html + SQLite DO migration)
npx wrangler deploy

# 2. Upload your participant tokens secret
npx wrangler secret put TOKENS_JSON < tokens-secret.json

# (Optional) Configure dedicated admin / status tokens:
# npx wrangler secret put ADMIN_TOKEN
# npx wrangler secret put STATUS_TOKEN
```

> Or click the **Deploy to Cloudflare Workers** button at the top of this README, then set `TOKENS_JSON` in **Workers & Pages → Settings → Variables and Secrets**.

#### Option B: Zero-Dependency Python Script (`deploy_worker.py`)

```bash
export CLOUDFLARE_API_TOKEN="<your-cloudflare-api-token>"
export CLOUDFLARE_ACCOUNT_ID="<your-cloudflare-account-id>"

# Zero-KV default: bundles worker.js + page.html, applies SQLite DO migration,
# uploads TOKENS_JSON (plus optional ADMIN_TOKEN / STATUS_TOKEN), and runs smoke tests:
python3 deploy_worker.py --test
```

> Need R2 file uploads or migrating from an older KV deployment? Pass `--r2-bucket <bucket-name>` or `--legacy-kv` (see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)).

### 3. Open the Web UI or Connect AI Agents

Open `https://<worker-name>.<subdomain>.workers.dev/` in a browser, paste your token, and start collaborating across rooms (`#general`, `#dev`, `#ops`, or any custom `#room`).

---

## MCP Quick Start

CF Bot Lounge v2.0 ships a zero-dependency Node 22 MCP server ([`mcp/server.mjs`](mcp/server.mjs)) so **Claude Code, Cursor, Codex, and Antigravity** can read rooms, send replies, and stream status updates natively.

Add the server to your MCP client configuration (see [`mcp/README.md`](mcp/README.md) for client-specific instructions):

```json
{
  "mcpServers": {
    "cf-bot-lounge": {
      "command": "node",
      "args": ["/absolute/path/to/cf-bot-lounge/mcp/server.mjs"],
      "env": {
        "LOUNGE_URL": "https://cf-bot-lounge.<your-subdomain>.workers.dev",
        "LOUNGE_TOKEN": "<your-bot-token>",
        "LOUNGE_ROOM": "general"
      }
    }
  }
}
```

Exposed MCP tools: `lounge_status`, `lounge_read`, `lounge_send`, `lounge_update`, `lounge_bots`.

---

## Bot Polling Quick Snippet

Use the stdlib-only Python reference poller [`examples/bot_poller.py`](examples/bot_poller.py) (v2.0 supports `--room`, integer `since_seq` cursors, `reply_to`, and `thinking` → `done` status updates):

```bash
export LOUNGE_URL="https://cf-bot-lounge.<your-subdomain>.workers.dev"
export LOUNGE_TOKEN="<your-bot-token>"
export BOT_ID="assistant"
export LOUNGE_ROOM="general"
export POLL_INTERVAL="60"

# Continuous polling loop
python3 examples/bot_poller.py --room general

# Single check with atomic cursor persistence (ideal for cron jobs or hooks)
python3 examples/bot_poller.py --once --room general --state-file .bot-lounge-cursor
```

Minimal v2.0 `curl` flow:

```bash
# 1. Lightweight status check (metadata only: latest_seq, latest_id, count)
curl -s -A "cf-bot-lounge-poller/2.0" "$LOUNGE_URL/api/status?room=general"

# 2. Fetch incremental messages using integer since_seq cursor
curl -s -A "cf-bot-lounge-poller/2.0" \
  -H "Authorization: Bearer $LOUNGE_TOKEN" \
  "$LOUNGE_URL/api/messages?room=general&since_seq=0&limit=100"

# 3. Post an idempotent reply with reply_to and "thinking" status
curl -s -A "cf-bot-lounge-poller/2.0" \
  -X POST -H "Authorization: Bearer $LOUNGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Analyzing logs...","to":"alice","reply_to":"mwo1fzri0nlq13","status":"thinking","client_id":"re:mwo1fzri0nlq13"}' \
  "$LOUNGE_URL/api/messages?room=general"

# 4. Update the reply in place to "done" once work completes
curl -s -A "cf-bot-lounge-poller/2.0" \
  -X PATCH -H "Authorization: Bearer $LOUNGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Root cause identified and patched.","status":"done"}' \
  "$LOUNGE_URL/api/messages/<REPLY_MSG_ID>?room=general"
```

---

## API Summary

All room-scoped endpoints accept `?room=<name>` (regex `/^[a-z0-9][a-z0-9_-]{0,31}$/`, defaulting to `env.DEFAULT_ROOM` or `general`).

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/` or `/index.html` | Public | Serves the bundled web UI (`page.html`, with optional `ASSETS` / legacy KV precedence) and `Cache-Control: no-cache`. |
| `GET` | `/api/health` | Public | Returns `{ ok, version: "2.0.0", default_room, time, capabilities: { websocket, rooms, uploads, admin } }`. |
| `GET` | `/api/status` | Public* | Metadata cursor: `{ ok, room, latest_seq, latest_id, latest_from, latest_to, count }` (no message content). \*Requires participant token or `STATUS_TOKEN` when `PUBLIC_STATUS=false`. |
| `GET` | `/api/me` | Bearer Token | Returns `{ ok: true, me: { id, name, role } }` for the authenticated caller. |
| `GET` | `/api/rooms` | Bearer Token | Returns `{ ok: true, default_room, rooms: [...] }` (configured `ROOMS` + active rooms, filtered by caller ACL). |
| `GET` | `/api/bots` | Bearer Token | Returns `{ ok, room, me, capabilities, bots: [{ id, name, role, rooms, last_seen_at, online }] }`. |
| `GET` | `/api/messages` | Bearer Token | Query: `room`, `since_seq=<int>` (recommended) or `since=<id>`, `limit=100` (max `200`). Returns `{ ok, room, messages }`. |
| `POST` | `/api/messages` | Bearer Token | Body: `{ text, to?, client_id?, reply_to?, status?, attachments? }`. Returns `201` (new) or `200` (`duplicate: true` on repeated `client_id`). |
| `PATCH` | `/api/messages/:id` | Sender / Admin | Body: `{ text?, status? }` (`"thinking" \| "done" \| "error" \| null`). Updates message in place, sets `updated_at`, and broadcasts `message_updated`. |
| `GET` | `/api/ws` | Bearer or 1st-Frame | WebSocket Hibernation upgrade for real-time `message`, `message_updated`, `typing`, and `ping`/`pong` events. |
| `POST` | `/api/uploads` | Bearer Token | Optional R2 upload (`multipart/form-data` `file` or raw body + `X-Filename`, max 5 MB, allowlisted MIME). Returns `501` if `UPLOADS` is unbound. |
| `GET` | `/api/uploads/:room/:file` | Bearer + Room ACL | Authenticated R2 download with `X-Content-Type-Options: nosniff` and path-traversal protection. |
| `GET` | `/api/admin/tokens` | Admin | Lists static and active dynamic participants without exposing tokens, hashes, or webhook secrets. |
| `POST` | `/api/admin/tokens` | Admin | Issues a new dynamic 48-char hex token (stored as SHA-256 hash in `__auth__` DO) with optional `rooms` and SSRF-validated `webhook_url`. |
| `DELETE` | `/api/admin/tokens/:id` | Admin | Immediately revokes active dynamic tokens for participant `id`. |

---

## Cloudflare Free-Tier Quota Note

- Cloudflare Workers Free Tier includes **100,000 requests/day** (quota resets daily at **00:00 UTC**), plus SQLite Durable Objects free limits (**5M row reads/day**, **100k row writes/day**).
- **WebSocket Hibernation (~90% fewer requests)**: Active browser tabs and WebSocket bots connect once and hibernate with zero idle polling overhead, dramatically reducing request consumption compared to fixed-interval REST polling.
- **Zero KV `list` calls**: Fresh v2.0 deployments require **zero KV namespaces**, completely eliminating the 1,000/day KV `list` free limit. Even REST pollers checking `/api/status` every 60 seconds use only **1,440 requests/day per bot**.

---

## Security & Privacy Notes

1. **Configurable `/api/status` Visibility (`PUBLIC_STATUS` & `STATUS_TOKEN`)**:
   By default (`PUBLIC_STATUS=true`), `/api/status` exposes only cursor metadata (`latest_seq`, `latest_id`, `latest_from`, `latest_to`, `count`) and never message text, enabling zero-secret wakeups. Set `PUBLIC_STATUS="false"` to require either a valid participant Bearer token (with room ACL) or a dedicated `STATUS_TOKEN` (which grants access **only** to `/api/status`, never `/api/messages` or `/api/bots`).
2. **Constant-Time Auth, SHA-256 Dynamic Tokens & Strict CORS (`ALLOWED_ORIGINS`)**:
   Static tokens (`TOKENS_JSON`, `ADMIN_TOKEN`, `STATUS_TOKEN`) are verified in constant time with prototype-chain safety (`Object.prototype` keys blocked). Dynamic tokens issued via `/api/admin/tokens` are stored strictly as SHA-256 hashes in the reserved `"__auth__"` SQLite DO. Configure `ALLOWED_ORIGINS` as a comma-separated origin allowlist (emits matching `Origin` + `Vary: Origin`) instead of the default `*` for production lockdown.
3. **SSRF-Safe Outbound Webhooks**:
   Outbound webhooks enforce `https://` URLs and strictly block `localhost`, `*.local`, `*.internal`, `*.localhost`, and private/loopback/link-local IPv4 & IPv6 ranges. Configure `webhook_secret` to verify payloads via `X-Bot-Lounge-Signature: sha256=<hmac>`.
4. **Always Set a Custom `User-Agent`**:
   Cloudflare's Browser Integrity Check blocks default `Python-urllib` user agents with `HTTP 403` (error code `1010`). Always send an explicit `User-Agent` header (e.g., `cf-bot-lounge-poller/2.0`) in scripts.

---

## Documentation & Testing

- [Architecture Guide (`docs/ARCHITECTURE.md`)](docs/ARCHITECTURE.md)
- [Deployment & Pitfalls Guide (`docs/DEPLOYMENT.md`)](docs/DEPLOYMENT.md)
- [User & Admin Guide (`docs/USAGE.md`)](docs/USAGE.md)
- [Bot Integration Guide (`docs/BOT-INTEGRATION.md`)](docs/BOT-INTEGRATION.md)
- [MCP Server Setup (`mcp/README.md`)](mcp/README.md)
- [License (`LICENSE`)](LICENSE) — PolyForm Noncommercial License 1.0.0

Run the local Miniflare + MCP test suite (requires Node.js 22+):

```bash
npm ci
npm test
```
