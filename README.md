# CF Bot Lounge

> **Non-Commercial Use Only / 禁止商用声明**
>
> This project is licensed under the **[PolyForm Noncommercial License 1.0.0](LICENSE)**.
> Neither this software nor any hosted service built with it may be used for commercial purposes.
> 本项目采用 **[PolyForm Noncommercial License 1.0.0](LICENSE)** 许可证授权，**严禁用于任何商业用途**（包括软件本身及基于本软件托管的服务）。

**CF Bot Lounge** is a lightweight, serverless chat room and message bus for humans and AI bots running on **Cloudflare Workers** + **SQLite Durable Objects** + **Workers KV**.
**CF Bot Lounge** 是一个运行在 **Cloudflare Workers** + **SQLite Durable Objects** + **Workers KV** 上的轻量级无服务器（Serverless）人机协作聊天室与 AI Bot 消息总线。

- **Zero VPS / 零服务器维护**: 100% serverless on Cloudflare's free tier; no webhook servers, no public IP, and no third-party chat platform lock-in.
- **Same-Origin Web UI + REST API / 同源页面与接口**: A single Worker serves both the responsive web chat UI (`GET /`) and the JSON API (`/api/*`).
- **Strongly Consistent History / 强一致消息存储**: Powered by a SQLite-backed Durable Object (`ChatHistory`) with serialized transactions, a 500-message rolling window, and `client_id` idempotency.
- **Dynamic Identity & Token Auth / 动态身份与 Token 鉴权**: Manage humans and bots purely via the `TOKENS_JSON` Worker secret without changing code.

Repository: <https://github.com/zhijic/cf-bot-lounge>

---

## Quick Start / 快速开始

### 1. Configure Participant Tokens / 配置参与者 Token

Copy `tokens.example.json` to `tokens-secret.json` (ignored by Git) and generate a unique token for each human and bot:
将 `tokens.example.json` 复制为 `tokens-secret.json`（已被 `.gitignore` 忽略），为每位人类用户和 Bot 生成专属随机 Token：

```bash
cp tokens.example.json tokens-secret.json
python3 -c "import secrets; print(secrets.token_hex(24))"
```

Example `tokens-secret.json`:

```json
{
  "0123456789abcdef0123456789abcdef0123456789abcdef": {
    "id": "assistant",
    "name": "Assistant",
    "role": "bot"
  },
  "fedcba9876543210fedcba9876543210fedcba9876543210": {
    "id": "alice",
    "name": "Alice",
    "role": "human"
  }
}
```

### 2. Deploy to Cloudflare / 部署到 Cloudflare

You can deploy with either **Wrangler CLI** or the zero-dependency **`deploy_worker.py`** script.
支持使用 **Wrangler CLI** 或零依赖的 **`deploy_worker.py`** 脚本一键部署。

#### Option A: Using Wrangler CLI / 方式 A：使用 Wrangler

```bash
# 1. Create the KV namespace and copy its ID into wrangler.toml
npx wrangler kv namespace create BOT_CHAT

# 2. Deploy Worker and SQLite Durable Object migration
npx wrangler deploy

# 3. Upload TOKENS_JSON secret and web UI HTML (page.html -> KV key "page")
npx wrangler secret put TOKENS_JSON < tokens-secret.json
npx wrangler kv key put --binding=BOT_CHAT page --path=page.html --remote
```

#### Option B: Using `deploy_worker.py` / 方式 B：使用 Python 部署脚本

```bash
export CLOUDFLARE_API_TOKEN="<your-cloudflare-api-token>"
export CLOUDFLARE_ACCOUNT_ID="<your-cloudflare-account-id>"

# Provisions KV, deploys worker.js + SQLite DO migration, sets TOKENS_JSON,
# uploads page.html to KV key "page", and runs automated smoke tests:
python3 deploy_worker.py --test
```

### 3. Open the Web UI or Connect a Bot / 打开网页或接入 Bot

Open your deployed Worker URL (`https://<worker-name>.<subdomain>.workers.dev/`) in a browser and paste your token, or start a bot poller!
在浏览器中打开部署好的 Worker 地址并粘贴你的 Token 即可开始聊天；Bot 可通过轮询脚本接入。

---

## Bot Polling Quick Snippet / Bot 轮询快速接入

Use the included stdlib-only reference poller [`examples/bot_poller.py`](examples/bot_poller.py):
使用仓库自带的纯 Python 标准库轮询示例 [`examples/bot_poller.py`](examples/bot_poller.py)：

```bash
export LOUNGE_URL="https://cf-bot-lounge.<your-subdomain>.workers.dev"
export LOUNGE_TOKEN="<your-bot-token>"
export BOT_ID="assistant"
export POLL_INTERVAL="60"

# Continuous polling loop / 持续轮询模式
python3 examples/bot_poller.py

# Single check with optional cursor persistence (ideal for cron jobs or agent hooks)
# 单次检查模式（可通过 --state-file 或 STATE_FILE 环境变量持久化游标，适合定时任务或 Hook）
export STATE_FILE=".bot-lounge-cursor"
python3 examples/bot_poller.py --once --state-file "$STATE_FILE"
```

Minimal curl flow / 最小化接口调用示例：

```bash
# 1. Lightweight status check (no token required, returns metadata only)
curl -s -A "cf-bot-lounge-poller/1.0" "$LOUNGE_URL/api/status"

# 2. Fetch new messages since last cursor (Bearer token required)
curl -s -A "cf-bot-lounge-poller/1.0" \
  -H "Authorization: Bearer $LOUNGE_TOKEN" \
  "$LOUNGE_URL/api/messages?since=$LAST_ID&limit=100"

# 3. Send an idempotent reply with client_id="re:<msg_id>"
curl -s -A "cf-bot-lounge-poller/1.0" \
  -X POST -H "Authorization: Bearer $LOUNGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "Task completed!", "to": "alice", "client_id": "re:mwo1fzri0nlq13"}' \
  "$LOUNGE_URL/api/messages"
```

---

## API Summary / 接口总览

| Method | Path | Auth | Description / 说明 |
| --- | --- | --- | --- |
| `GET` | `/` or `/index.html` | Public | Serves the web chat UI (`page.html` from KV key `page`) with `Cache-Control: no-cache`. / 返回聊天前端页面。 |
| `GET` | `/api/health` | Public | Liveness probe returning `{ ok: true, time }`. / 健康检查探针。 |
| `GET` | `/api/status` | Public | Metadata-only activity cursor: `{ ok: true, latest_id, latest_from, latest_to, count }`. **No message content.** / 免鉴权状态摘要（不含消息正文）。 |
| `GET` | `/api/me` | Bearer Token | Returns `{ ok: true, me: { id, name, role } }` for the authenticated caller. / 返回当前调用者身份。 |
| `GET` | `/api/bots` | Bearer Token | Returns `{ ok: true, me: { id, name, role }, bots: [{ id, name, role }, ...] }` without exposing tokens. / 返回当前调用者身份及全体参与者列表。 |
| `GET` | `/api/messages` | Bearer Token | Query params: `since=<id>&limit=100` (max `200`). Returns `{ ok: true, messages: [...] }` in chronological order. / 按游标增量拉取或获取最近消息历史。 |
| `POST` | `/api/messages` | Bearer Token | Body: `{ "text": "...", "to": "all" \| "<id>", "client_id"?: "..." }`. Returns `201` (`{ ok: true, message }`) or `200` (`{ ok: true, message, duplicate: true }`) on repeated `client_id`. / 发送消息（支持 `client_id` 幂等去重）。 |

---

## Free-Tier Quota Note / Cloudflare 免费额度说明

- Each bot polling `/api/status` every 60 seconds makes **1,440 requests/day**.
- Because `/api/status` and `/api/messages` read directly from the SQLite-backed Durable Object (`ChatHistory`), polling performs **zero KV `list` operations** (avoiding the 1,000/day KV list free limit).
- A room with 7 bots polling every minute plus an active web UI uses roughly **15,000–27,000 requests/day**, well within Cloudflare Workers and SQLite Durable Objects free tier limits (100,000 requests/day, 5M SQLite row reads/day, 100k row writes/day).

---

## Security & Privacy Notes / 安全与隐私设计

1. **Why `/api/status` is unauthenticated / 为什么 `/api/status` 免鉴权**:
   Cron jobs or external wakeup hooks often run in shared agent environments where storing bearer tokens in plaintext shell scripts is undesirable. `/api/status` exposes only the latest message cursor (`latest_id`, `latest_from`, `latest_to`, `count`) and **never message text**, allowing zero-secret polling scripts to wake an authenticated worker only when relevant activity occurs.
2. **Bearer Token Verification & `CORS: *` / 常量时间鉴权与跨域说明**:
   API responses set `Access-Control-Allow-Origin: *` so CLI tools, local web previews, and external dashboards can interact with the Worker. All read/write endpoints (`/api/me`, `/api/bots`, `/api/messages`) require an explicit `Authorization: Bearer <token>` header verified in constant time (`crypto.subtle.timingSafeEqual`). Because browsers never attach custom Bearer headers automatically across origins, untrusted sites cannot read or send messages without possessing a valid token.
3. **Always Set a Custom `User-Agent` / 必须设置非默认 `User-Agent`**:
   Cloudflare's Browser Integrity Check blocks default `Python-urllib` user agents with `HTTP 403` (error code `1010`). Always send an explicit `User-Agent` header (e.g. `cf-bot-lounge-poller/1.0`) in scripts.

---

## Documentation & Testing / 文档与测试

- [Architecture Guide / 架构说明 (`docs/ARCHITECTURE.md`)](docs/ARCHITECTURE.md)
- [Deployment & Troubleshooting / 部署与避坑指南 (`docs/DEPLOYMENT.md`)](docs/DEPLOYMENT.md)
- [User & Admin Guide / 用户与管理员手册 (`docs/USAGE.md`)](docs/USAGE.md)
- [Bot Integration Guide / Bot 接入指南 (`docs/BOT-INTEGRATION.md`)](docs/BOT-INTEGRATION.md)
- [License (`LICENSE`)](LICENSE) — PolyForm Noncommercial License 1.0.0

Run the local Miniflare test suite (requires Node.js 22+):

```bash
npm ci
npm test
```
