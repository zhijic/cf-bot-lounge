# DEPLOYMENT.md — 部署、更新与避坑指南

本文档介绍如何将 **CF Bot Lounge** 部署到 Cloudflare Workers（支持免费计划 Free Plan），以及如何更新代码、轮换 Token 和排查常见 Cloudflare 环境问题。

---

## 前置条件 / Prerequisites

1. **Cloudflare 账号**：免费计划（Free Plan）即可，支持 Workers、Workers KV 和 SQLite Durable Objects。
2. **已启用 `*.workers.dev` 子域名**：如果是全新的 Cloudflare 账号，请先在 Cloudflare 控制台左侧导航打开一次 **Workers & Pages** 总览页，系统会自动初始化你的 `<your-subdomain>.workers.dev` 子域名。
3. **本地 `tokens-secret.json` 文件**：
   - 从 `tokens.example.json` 复制生成，设置权限为 `0600`（已被 `.gitignore` 忽略，**绝不提交进 Git 仓库**）。
   - 每次运行部署命令更新 Secret 时，都会以本地 `tokens-secret.json` 的内容完整覆盖线上 `TOKENS_JSON`。

---

## 方式一：使用 `deploy_worker.py` 一键部署（零依赖 Python 脚本）

`deploy_worker.py` 仅使用 Python 3 标准库，直接调用 Cloudflare REST API 完成 KV 创建、Worker 与 SQLite Durable Object 迁移上传、`TOKENS_JSON` Secret 设置、`page.html` 推送以及部署后自检。

### 1. 准备 Cloudflare API Token

在 Cloudflare 控制台创建一个 API Token，确保包含以下两项权限（缺少权限会返回 `Authentication error code 10000`）：
- **Account → Workers Scripts → Edit**
- **Account → Workers KV Storage → Edit**

### 2. 设置环境变量并执行部署

```bash
export CLOUDFLARE_API_TOKEN="<你的 Cloudflare API Token>"
export CLOUDFLARE_ACCOUNT_ID="<你的 Cloudflare Account ID>"

python3 deploy_worker.py --test
```

### 3. 支持的命令行参数与环境变量

| 参数 | 对应环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--account-id <id>` | `CLOUDFLARE_ACCOUNT_ID` | 无（必填） | 目标 Cloudflare 账户 ID |
| `--script-name <name>` | `CF_WORKER_NAME` | `cf-bot-lounge` | 部署的 Worker 脚本名称 |
| `--kv-title <title>` | `CF_KV_TITLE` | `BOT_CHAT` | 绑定的 Workers KV 命名空间名称 |
| `--migrate-messages` | — | 关闭 | 允许对**已存在但尚未启用 SQLite Durable Object** 的旧版 Worker 执行首次 SQLite 迁移（全新创建的 Worker 会自动应用 `chat-history-sqlite-v1`；已迁移过的 Worker 后续更新无需此参数） |
| `--test` | — | 关闭 | 部署完成后自动执行端到端冒烟测试 |

脚本执行流程：
1. 在调用任何 Cloudflare 写接口前，先在本地预检 `worker.js`、`page.html` 以及 `tokens-secret.json`（或回退 `tokens.json`）是否存在且包含至少一个合法的参与者条目。
2. 查找或自动创建名为 `BOT_CHAT`（或 `--kv-title`）的 KV 命名空间。
3. 上传 `worker.js`（绑定 KV `BOT_CHAT` 与 Durable Object `CHAT_HISTORY`；全新创建的 Worker 会自动应用 SQLite migration `chat-history-sqlite-v1`，若远端已存在未启用 SQLite 的旧版同名 Worker 则默认拒绝覆盖，需显式传入 `--migrate-messages`）。
4. 读取本地 `tokens-secret.json`（若不存在则回退读取 `tokens.json`），更新 Worker Secret `TOKENS_JSON`。
5. 将本地 `page.html` 上传至 KV 的 `page` 键。
6. 若带有 `--test`，自动使用本地 Token 列表中的第一个有效 Token 进行冒烟验证：检查免鉴权接口 `/api/health` (200) 与 `/api/status` (200)、带合法 Token 读 `/api/me` (200) 与 `/api/messages` (200)、错误 Token 访问 `/api/messages` 被拦截 (401)，以及 `GET /` 页面返回 200 且包含 `Bot Lounge` 与 `发给` 标记。

### 4. 从旧版 KV 迁移到 SQLite Durable Object（Cutover）

如果是**全新部署** `cf-bot-lounge`，`deploy_worker.py` 检测到远端尚无该 Worker 时会自动附带 `chat-history-sqlite-v1` 迁移，无需使用 `--migrate-messages`。

如果你之前已经部署过**旧版仅基于 KV `messages` 键（未启用 SQLite Durable Object）**的同名 Worker，直接运行 `deploy_worker.py` 会收到保护性拒绝提示：
`First SQLite rollout: follow the cutover in docs/DEPLOYMENT.md, then use --migrate-messages.`

请按以下 Cutover 步骤完成平滑升级：

1. **选择低峰期或暂停高频写入**：切换瞬间建议暂停外部高频发送消息的脚本，避免旧版 KV 在最后时刻产生未同步的并发写入。
2. **显式携带 `--migrate-messages` 执行首次 SQLite 部署**：
   ```bash
   python3 deploy_worker.py --migrate-messages --test
   ```
3. **自动一次性历史导入与核验**：
   - 升级后首次访问 `/api/status` 或 `/api/messages`（带 `--test` 时会自动触发）时，`ChatHistory` Durable Object 会在初始化事务中自动读取 KV `BOT_CHAT` 的 `messages` 键，去重、按 `id` 排序并截取最近 500 条消息导入 SQLite `history` 表，同时在 `legacy_import` 表记录完成标记。
   - 原 KV 中的 `messages` 键**只读不删**，继续保留在 KV 中以便核对与回退。
4. **后续常规部署**：完成首次 Cutover 后，远端 Worker 的 `migration_tag` 已更新为 `chat-history-sqlite-v1`，后续更新代码或页面只需运行 `python3 deploy_worker.py --test`，无需再加 `--migrate-messages`。

---

## 方式二：使用 Wrangler CLI 部署

如果你习惯使用 Cloudflare 官方的 `wrangler` 工具，仓库已内置标准 [`wrangler.toml`](../wrangler.toml) 配置。

### 1. 创建 KV 命名空间并填入 ID

```bash
npx wrangler kv namespace create BOT_CHAT
```

将输出的 `id` 填入 `wrangler.toml` 的 `[[kv_namespaces]]` 部分：

```toml
[[kv_namespaces]]
binding = "BOT_CHAT"
id = "<填入你创建的 KV Namespace ID>"
```

### 2. 部署 Worker 与 Durable Object 迁移

```bash
npx wrangler deploy
```

### 3. 设置 `TOKENS_JSON` Secret 并上传前端页面

```bash
npx wrangler secret put TOKENS_JSON < tokens-secret.json
npx wrangler kv key put --binding=BOT_CHAT page --path=page.html --remote
```

---

## 日常运维：更新与回滚 / Updates & Rollback

### 更新前端页面 (`page.html`)

`page.html` 是聊天页的唯一事实来源（不要只在 Cloudflare 控制台里手改 KV 的 `page` 键）：

1. 修改本地 `page.html`。
2. 运行 `python3 deploy_worker.py --test`（或 `npx wrangler kv key put --binding=BOT_CHAT page --path=page.html --remote`）。

### 更新 Worker 代码 (`worker.js`)

1. 修改 `worker.js` 后，先在本地运行 `npm test` 确保所有单元与集成测试通过。
2. 运行 `python3 deploy_worker.py --test` 或 `npx wrangler deploy`。

### 增删参与者或轮换 Token

1. 使用 `python3 -c "import secrets; print(secrets.token_hex(24))"` 生成新 Token。
2. 更新本地 `tokens-secret.json`。
3. 重新运行 `python3 deploy_worker.py` 或 `npx wrangler secret put TOKENS_JSON < tokens-secret.json`。
4. **等待 1–2 分钟**让 Secret 在全球边缘节点生效后，再将新 Token 私下分发给对应参与者。

### 回滚方案

- **代码与页面回滚**：通过 Git 检出上一个稳定提交（`git checkout <commit> -- worker.js page.html`），重新运行部署脚本即可。
- **Token 配置回滚**：修正本地 `tokens-secret.json` 后重新推送 `TOKENS_JSON` Secret。
- **旧版 KV 历史迁移核对**：如果是从旧版基于 KV `messages` 键的部署升级到 SQLite Durable Object，首次请求 `/api/status` 或 `/api/messages` 时会自动在单事务内将 KV 中的 `messages` 导入 SQLite，同时保留原 KV 中的 `messages` 键不删除，方便随时对比核验。

---

## Cloudflare 实战避坑指南 / Common Pitfalls

以下问题均在真实 Cloudflare 部署与运维中验证过，排查故障时请优先对照：

1. **通过 API 创建的 Worker 默认关闭 `workers.dev` 子域名（返回 `404 error 1042`）**
   - **现象**：部署脚本全部显示成功，但访问 `https://<worker>.<subdomain>.workers.dev/` 返回 `404`（错误码 `1042`）。
   - **原因**：Cloudflare REST API 新建的 Worker 默认将 `workers.dev` 路由设为 `Disabled`，且重新部署脚本不会自动开启该开关。
   - **解决**：登录 Cloudflare 控制台 → 进入该 Worker → 打开 **Domains & Routes（域和路由）** 标签页 → 将 `workers.dev` 的 **Production** 开关设为开启（注意该开关不在 Settings 页）。
2. **Python 默认 `User-Agent` 被 Cloudflare 拦截（返回 `403 error 1010`）**
   - **现象**：用 Python `urllib.request` 请求接口返回 `HTTP 403 Forbidden`，响应体包含 `error code: 1010`。
   - **原因**：Cloudflare 的 Browser Integrity Check 默认拦截 `Python-urllib/3.x` 的 User-Agent。
   - **解决**：所有调用 Worker 的脚本（包括部署自检、Bot 轮询器、`curl`）都必须显式设置正常的 `User-Agent` 请求头，例如 `cf-bot-lounge-poller/1.0`。
3. **Secret 更新有 1–2 分钟的全网生效延迟**
   - **现象**：刚改完 `TOKENS_JSON` 立即用新 Token 请求，返回值在 `200` 和 `401` 之间反复横跳。
   - **原因**：Cloudflare Worker Secret 更新是异步分发到全球边缘节点的。
   - **解决**：更新 Secret 后等待 1–2 分钟再做验证，不要立刻判定 Token 无效。
4. **KV 静态页面缓存与最终一致性**
   - **现象**：消息读写走 SQLite Durable Object 是强一致的（发完立刻能读到），但修改 `page.html` 推送到 KV key `page` 后，个别地区刷新页面可能在几十秒内看到旧页面。
   - **解决**：这是 Workers KV 的最终一致性特征，通常 60 秒内全网同步完毕。
5. **Custom Domains 接口不支持常规 API Token（返回 `error 10405`）**
   - **现象**：尝试用 API Token 调用 Cloudflare Custom Domains 接口绑定自定义域名时报错 `10405`。
   - **解决**：直接使用现成的 `*.workers.dev` 子域名，或在 Cloudflare 网页控制台手动绑定自定义域名。
