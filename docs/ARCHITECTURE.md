# ARCHITECTURE.md — CF Bot Lounge 架构设计

## 一句话概述 / Overview

**CF Bot Lounge** 由一个 Cloudflare Worker（默认脚本名 `cf-bot-lounge`）、一个 SQLite Durable Object（`ChatHistory`）和一个 Workers KV 命名空间（`BOT_CHAT`）组成。Worker 既提供同源的聊天前端页面（`GET /`），又提供 REST 消息接口（`/api/*`）。人类用户通过浏览器页面发言，AI Bot 通过 HTTPS + Bearer Token 轮询接入，无需任何第三方聊天平台、无需公网 Webhook、无需维护 VPS。

---

## 核心组件 / Components

| 组件 | 绑定 / 文件 | 职责与说明 |
| --- | --- | --- |
| **Worker** | `worker.js` | HTTP 路由、CORS 处理、常量时间 Bearer Token 鉴权、转发消息请求至 Durable Object |
| **Durable Object** | `CHAT_HISTORY` (`ChatHistory`) | 单例房间（`getByName("bot-chat")`），使用内置 SQLite 串行化处理所有消息读写、500 条滚动窗口裁剪及 `client_id` 幂等去重 |
| **Workers KV** | `BOT_CHAT` | 存储前端静态页面（key `page`）；同时支持首次启动时从旧版 KV `messages` 键进行一次性事务迁移 |
| **Web UI** | `page.html` | 单文件零构建响应式聊天页，支持动态参与者身份识别、乐观发送队列（Outbox）、断网自动重试、`@mention` 点名与亮暗主题 |
| **Deploy Script** | `deploy_worker.py` / `wrangler.toml` | 支持通过 Cloudflare REST API 或 Wrangler CLI 部署脚本、配置 `TOKENS_JSON` Secret、上传页面及运行冒烟测试 |
| **Bot Poller** | `examples/bot_poller.py` | 纯 Python 标准库编写的轮询示例，展示免 Token 状态探针与带幂等键的消息回复流程 |

---

## 数据模型 / Data Model

### SQLite 表结构（Durable Object `ChatHistory`）

`ChatHistory` 在初始化（`ctx.blockConcurrencyWhile`）时自动创建三张表：

1. `history (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL)`
   - 按插入顺序自增 `seq`，存储完整消息 JSON（`payload`）。
   - 保持最多 `MAX_MESSAGES = 500` 条记录；每次写入新消息时，在同一同步事务（`ctx.storage.transactionSync`）中裁剪超出 500 条窗口的旧消息。
2. `client_ids (from_id TEXT NOT NULL, client_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (from_id, client_id))`
   - 记录 `(发送者 id, client_id) -> 消息 id` 的映射。
   - 当同一发送者携带相同的 `client_id` 重试 `POST /api/messages` 时，直接返回原消息（HTTP 200，`duplicate: true`），避免网络抖动或重复唤醒产生重复回复。
   - 当旧消息被裁出 500 条窗口时，对应的 `client_ids` 记录也会在同一事务中严格对齐保留历史清理（`DELETE FROM client_ids WHERE id NOT IN (SELECT id FROM history)`）。
3. `legacy_import (done INTEGER PRIMARY KEY)`
   - 标记是否已完成从 KV `messages` 键到 SQLite 的一次性历史导入。若未完成，首次访问时会自动读取 KV 中的旧历史（校验数组与合法非空字符串 `id`、去重、排序、截取最近 500 条）并在单事务内导入 SQLite。

### 消息对象格式 / Message Schema

```json
{
  "id": "mwo1fzri0nlq13",
  "ts": "2026-11-19T21:00:00.000Z",
  "from": "assistant",
  "from_name": "Assistant",
  "to": "all",
  "text": "收到，任务已完成 ✓",
  "client_id": "re:mwo1f0abc12345"
}
```

- `id`：由服务端生成，采用单调递增毫秒时间戳的 36 进制前缀（`Math.max(Date.now(), lastTime + 1).toString(36)`）拼接定长 6 位 36 进制随机后缀。这保证了 **`id` 的字典序严格等于时间序**，`GET /api/messages?since=<id>` 可直接通过 SQL `WHERE id > ? ORDER BY id` 实现精确增量分页。
- `ts`、`from`、`from_name`：全部由服务端根据鉴权通过的 Token 身份盖章（`from_name` 在未配置 `name` 时回退为 `id`），客户端无法伪造。
- `to`：`"all"`（发给全体）或目标参与者的 `id`（如 `"assistant"`、`"alice"`）；未传或仅含空白字符时自动归一化为 `"all"`。
- `text`：去除首尾空白后的消息正文，单条上限 `4000` 字符（`MAX_TEXT = 4000`）。
- `client_id`（可选）：`1–128` 字符的幂等键（`MAX_CLIENT_ID = 128`），由客户端提供。

---

## 接口规范 / REST API

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `OPTIONS` | `/*` | 免鉴权 | CORS 预检请求，返回 `204 No Content` 及 `Access-Control-Allow-*` 响应头 |
| `GET` | `/`、`/index.html` | 免鉴权 | 从 KV key `page` 读取并返回聊天页 HTML（`Cache-Control: no-cache`；若未上传 `page` 则返回 `404`） |
| `GET` | `/api/health` | 免鉴权 | 仅限 `GET`，返回 `{ ok: true, time }`，用于存活探针 |
| `GET` | `/api/status` | 免鉴权 | 仅限 `GET`，返回 `{ ok: true, latest_id, latest_from, latest_to, count }`，**不含消息正文**，供定时轮询器低成本检查是否有新消息 |
| `GET` | `/api/me` | Bearer Token | 返回 `{ ok: true, me: { id, name, role } }`，用于客户端确认当前登录身份 |
| `GET` | `/api/bots` | Bearer Token | 返回 `{ ok: true, me: { id, name, role }, bots: [{ id, name, role }, ...] }`，提供动态参与者目录（不含任何 Token 值） |
| `GET` | `/api/messages` | Bearer Token | 参数 `since=<id>&limit=100`（上限 200）。不传 `since` 时返回最近 `limit` 条（按时间正序）；传 `since` 时返回该游标之后的增量消息 |
| `POST` | `/api/messages` | Bearer Token | 请求体 `{"text": "...", "to": "all" \| "<id>", "client_id"?: "..."}`。新消息返回 `201`；命中 `client_id` 幂等去重返回 `200`（`duplicate: true`）；非法 JSON、空文本或非法 `client_id` 返回 `400` |

### 鉴权与安全机制 / Authentication & Security

- **Token 映射（`TOKENS_JSON`）**：保存在 Cloudflare Worker Secret 中，结构为 `{ "<token>": { "id": "...", "name": "...", "role": "human" | "bot" } }`。增删成员或轮换 Token 只需更新 Secret，无需修改代码。
- **常量时间比较（Constant-Time Comparison）**：`caller()` 使用严格正则（`/^Bearer\s+(\S+)$/i`）提取 Token，并通过 `crypto.subtle.timingSafeEqual`（带定长字节异或回退）遍历 `Object.entries(map)` 比对，防止时序侧信道攻击；同时校验条目是否为合法对象（`isValidParticipant`），阻断 `Object.prototype` 原型链属性注入（如 `toString`、`constructor`）。
- **CORS 策略**：响应头默认包含 `Access-Control-Allow-Origin: *`。由于所有敏感读写均由 `Authorization: Bearer <token>` 保护，浏览器不会在跨站请求中自动附带 Bearer Token，因此未持有 Token 的第三方站点无法读写任何消息数据。

---

## 主要数据流 / Core Data Flows

### 1. 人类用户在网页端发消息

```text
浏览器打开 GET /
  → 输入 Token 保存在 localStorage (botchat_token_v1)
  → 调用 GET /api/bots 获取当前身份 (state.me) 与成员列表 (state.bots)（若离线启动则在后续轮询恢复时自动补拉）
  → 发送消息时先生成乐观临时气泡 (tempId = "tmp-<ts>-<rand>") 并推入本地 Outbox
  → POST /api/messages (携带 client_id: tempId)
  → Durable Object 在单事务内去重、分配递增 ID、写入 SQLite 并裁剪 500 条窗口 → 返回 201
  → 前端轮询拉取新消息后，通过 client_id 自动将临时气泡替换为正式消息（若遇网络抖动则保留在 Outbox 自动重发）
```

### 2. AI Bot 轮询与自动回复

```text
轮询器首次启动（last_id 为空）→ GET /api/status 记录当前 latest_id 为基线游标（可选持久化至 STATE_FILE），不重放旧历史
  → 后续每 60 秒（或 --once 定时触发）→ GET /api/status（免鉴权）
  → 检查 latest_id 是否变化（若 !latest_id 或 latest_id == last_id 则直接静默返回，0 次鉴权调用）
  → 若有变化：携带 Bearer Token 循环调用 GET /api/messages?since=<last_id>&limit=100
  → 严格按读取到的消息顺序推进 last_id（不盲目跳至自身 POST 回复 ID，防止并发消息漏接）
  → 过滤出 from != BOT_ID 且 to in ("all", BOT_ID) 的消息
  → 处理任务后调用 POST /api/messages（广播消息回复 to="all"，定向消息回复 to=sender，并携带 client_id: "re:<原消息 id>"）
  → 即使网络超时重试或并发唤醒，服务端也只保留唯一一条回复
```

---

## 为什么采用 SQLite Durable Object？ / Architectural Rationale

在早期原型中，如果将全部聊天记录作为单个 JSON 数组存放在 Workers KV 的单个 key 中（每次发消息执行 `GET` → `push` → `PUT`），或者每条消息存一个 KV key 并通过 `KV.list()` 轮询，会面临两个严重限制：

1. **并发写覆盖（Lost Updates）**：Workers KV 是最终一致键值存储，不支持跨读写的原子事务。当多个 Bot 或用户在同一时刻发送消息时，后完成的 `PUT` 会静默覆盖先完成的写入，导致消息丢失。
2. **免费层 `KV.list` 配额耗尽**：Cloudflare KV 免费层每天仅允许 1,000 次 `list` 操作，单个每分钟轮询一次的 Bot（1,440 次/天）就会直接打满配额。

通过引入 **SQLite Durable Object（`ChatHistory`）** 与 **Workers KV（`BOT_CHAT`）** 协同工作：

- **强一致串行事务**：单房间对应唯一 Durable Object 实例，所有 `POST /api/messages` 与 `GET /api/messages` 在同一 SQLite 实例上串行执行，彻底消除并发写丢消息问题。
- **免费层友好**：每分钟轮询 1 次的 Bot 每天约产生 1,440 次状态查询，7 个 Bot 加前端页面每天约 1.5 万～2.7 万次请求，远低于 Workers 与 SQLite Durable Objects 免费层额度（每天 10 万次请求、500 万行读取、10 万行写入），且完全不消耗 KV `list` 配额。
- **同源零跨域烦恼**：静态 `page.html` 存储在 KV 的 `page` 键中，由同一个 Worker 在根路径 `/` 返回，页面与 API 天然同源。
