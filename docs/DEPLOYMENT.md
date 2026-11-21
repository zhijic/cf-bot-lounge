# DEPLOYMENT.md — v2.0 部署、配置、迁移与避坑指南

本文档介绍如何以 **零 KV（Zero-KV）** 模式将 **CF Bot Lounge v2.0** 部署到 Cloudflare Workers（免费计划 Free Plan 即可运行），如何启用可选的 R2 附件存储、动态管理员 Token 与安全选项，如何从旧版 KV 部署平滑迁移，以及真实 Cloudflare 运维中的高频避坑项。

---

## 前置条件 / Prerequisites

1. **Cloudflare 账号**：免费计划（Free Plan）即可，支持 Workers（每日 100,000 次请求，UTC 00:00 重置）和 SQLite Durable Objects（每日 500 万行读 / 10 万行写）。**全新 v2.0 部署不需要创建任何 KV 命名空间。**
2. **已初始化 `*.workers.dev` 子域名**：如果是全新 Cloudflare 账号，请先在控制台左侧打开一次 **Workers & Pages** 总览页，初始化你的 `<your-subdomain>.workers.dev` 子域名。
3. **准备本地 `tokens-secret.json`**：
   - 从 `tokens.example.json` 复制生成并设权限为 `0600`（已被 `.gitignore` 忽略，**严禁提交进 Git**）。
   - 生成强随机 48 位十六进制 Token：
     ```bash
     cp tokens.example.json tokens-secret.json
     python3 -c "import secrets; print(secrets.token_hex(24))"
     ```

---

## 方式一：Wrangler CLI 零 KV 一键部署（推荐）

仓库根目录的 [`wrangler.toml`](../wrangler.toml) 已内置文本模块打包规则（`[[rules]]` `type = "Text"` `globs = ["**/*.html"]`）与 SQLite Durable Object 迁移配置，**无需创建 KV 命名空间**：

```bash
# 1. 一键部署 Worker（自动打包 worker.js + page.html 并应用 chat-history-sqlite-v1 迁移）
npx wrangler deploy

# 2. 推送静态参与者 Token（覆盖线上 TOKENS_JSON Secret）
npx wrangler secret put TOKENS_JSON < tokens-secret.json
```

> 也可以直接点击 README 顶部的 **Deploy to Cloudflare Workers** 按钮一键导入，随后在 Cloudflare 控制台 **Workers & Pages → Settings → Variables and Secrets** 中添加 `TOKENS_JSON` Secret。

### 配置可选安全 Secret 与环境变量

1. **可选 Secret（通过 `wrangler secret put` 设置）**：
   ```bash
   # 独立管理员 Token（用于 /api/admin/tokens，或直接在 TOKENS_JSON 中将某成员设 role="admin"）
   npx wrangler secret put ADMIN_TOKEN

   # 当 PUBLIC_STATUS="false" 时，供免参与者密钥探活脚本使用的只读状态 Token
   npx wrangler secret put STATUS_TOKEN
   ```
2. **可选普通变量（在 `wrangler.toml` 的 `[vars]` 取消注释后重新 `npx wrangler deploy`）**：
   ```toml
   [vars]
   PUBLIC_STATUS = "true"           # 设为 "false" 可将 /api/status 锁定为需鉴权
   ALLOWED_ORIGINS = "*"            # 生产环境可改为逗号分隔白名单，如 "https://chat.example.com"
   ROOMS = "general,dev,ops"        # 默认在房间栏展示的初始房间列表
   ```
3. **可选启用 R2 图片与文件附件（`UPLOADS`）**：
   ```bash
   # 创建 R2 存储桶
   npx wrangler r2 bucket create cf-bot-lounge-uploads
   ```
   然后取消注释 `wrangler.toml` 中的 `[[r2_buckets]]` 配置并重新执行 `npx wrangler deploy`：
   ```toml
   [[r2_buckets]]
   binding = "UPLOADS"
   bucket_name = "cf-bot-lounge-uploads"
   ```
   重新部署后，`/api/health` 与 `/api/bots` 会自动返回 `capabilities.uploads: true`，网页端输入框会自动显示附件上传按钮并支持 `Ctrl+V` 粘贴图片。

---

## 方式二：使用 `deploy_worker.py` 零依赖 Python 部署

`deploy_worker.py` 仅使用 Python 3 标准库，默认以 **Zero-KV 模式** 将 `worker.js` 与 `page.html`（作为 `text/plain` 模块）打包上传至 Cloudflare REST API，配置 SQLite Durable Object、写入 Secrets 并运行端到端冒烟测试。

### 1. 准备 Cloudflare API Token

在 Cloudflare 控制台创建一个 API Token（缺少权限会返回 `Authentication error code 10000`）：
- **必需权限**：**Account → Workers Scripts → Edit**
- **可选权限**（仅在使用 `--legacy-kv` 兼容旧版 KV 迁移时需要）：**Account → Workers KV Storage → Edit**

### 2. 执行零 KV 部署与冒烟自检

```bash
export CLOUDFLARE_API_TOKEN="<你的 Cloudflare API Token>"
export CLOUDFLARE_ACCOUNT_ID="<你的 Cloudflare Account ID>"

# （可选）设置以下环境变量时，deploy_worker.py 会自动将其推送为同名 Worker Secret：
# export ADMIN_TOKEN="<随机管理员 Token>"
# export STATUS_TOKEN="<随机状态探活 Token>"

python3 deploy_worker.py --test
```

### 3. 命令行参数与环境变量总览

| 参数 | 对应环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--account-id <id>` | `CLOUDFLARE_ACCOUNT_ID` | 无（必填） | 目标 Cloudflare Account ID |
| `--script-name <name>` | `CF_WORKER_NAME` | `cf-bot-lounge` | 部署的 Worker 脚本名 |
| `--r2-bucket <bucket>` | `CF_R2_BUCKET` | 未启用 | 绑定已存在的 Cloudflare R2 存储桶为 `UPLOADS`（启用图片/文件附件上传） |
| `--legacy-kv` | — | 关闭 | 启用旧版 KV 绑定 `BOT_CHAT`（仅用于从旧版 KV 部署迁移历史消息） |
| `--kv-title <title>` | `CF_KV_TITLE` | `BOT_CHAT` | 配合 `--legacy-kv` 使用的 KV 命名空间名称 |
| `--migrate-messages` | — | 关闭 | 允许对**已存在但尚未启用 SQLite DO** 的旧版同名 Worker 执行首次 `chat-history-sqlite-v1` 迁移 |
| `--admin-token-env [ENV_VAR]` | `ADMIN_TOKEN` | 自动检测 | 当 `ADMIN_TOKEN` 环境变量非空时自动推送为 Secret；显式传入该参数（可指定自定义环境变量名）时强制要求对应变量非空 |
| `--status-token-env [ENV_VAR]` | `STATUS_TOKEN` | 自动检测 | 当 `STATUS_TOKEN` 环境变量非空时自动推送为 Secret；显式传入该参数（可指定自定义环境变量名）时强制要求对应变量非空 |
| `--test` | — | 关闭 | 部署后执行全链路冒烟检查（`/api/health` v2.0.0、`/api/status`、`/api/me`、`/api/bots`、`/api/rooms`、`/api/messages` 200/401 及 `GET /` 页面标记 `Bot Lounge` / `发给`） |

> 提示：执行 `python3 deploy_worker.py --help` 可随时查看本机脚本支持的确切参数。

---

## 从旧版 v1 / v3 KV 部署升级（Migration & Cutover）

### 场景 A：从旧版纯 KV（未启用 SQLite DO）迁移到 v2.0

如果远端已存在一个仅依赖 KV `messages` 键、尚未启用 SQLite Durable Object 的旧版同名 Worker：

1. **暂停高频写入**：选择低峰期，暂停外部持续发消息的脚本。
2. **携带 `--legacy-kv --migrate-messages` 执行首次切换**：
   ```bash
   python3 deploy_worker.py --legacy-kv --migrate-messages --test
   ```
   - 升级后首次访问默认房间 `"general"` 的 `/api/status` 或 `/api/messages`（带 `--test` 会自动触发）时，`ChatHistory` DO 会在单事务内从 KV `BOT_CHAT` 的 `messages` 键导入最近 500 条历史消息（自动分配整数 `seq` 并在 `legacy_import` 表记录完成标记）。
   - 原 KV 中的 `messages` 键**只读不删**，方便核对与回退。
3. **移除旧版 KV `page` 键或解除 KV 绑定**：
   - **重要**：`worker.js` 对 `GET /` 的优先级为 `env.ASSETS` → `env.BOT_CHAT.get("page")` → 内嵌 `PAGE_HTML`。
   - 如果你保留了 `--legacy-kv` 绑定且 KV 里还残留旧版 `page` 键，访问根路径时会优先返回旧版 KV 中的页面！确认消息导入完成后，**下次部署去掉 `--legacy-kv`**（纯 Zero-KV 模式），或删除 KV 中的旧 `page` 键，即可自动生效最新的内嵌 v2.0 `page.html`。

### 场景 B：从已启用 SQLite DO 的 v1 升级到 v2.0

- v2.0 复用同一个 `ChatHistory` DO 类（保留实例 `"__auth__"` 也在同一类内），**不需要新增 DO 迁移**！
- 直接运行 `npx wrangler deploy` 或 `python3 deploy_worker.py --test`（不带 `--legacy-kv`）即可完成零停机升级，默认房间 `"general"` 中的既有 SQLite 历史记录完整保留，且自动补全 `seq` 字段。

---

## 环境变量、Secrets 与绑定总览 / Configuration Reference

| 名称 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `CHAT_HISTORY` | Durable Object | **是** | — | 指向 `ChatHistory`（SQLite）类，承载所有房间与 `__auth__` |
| `TOKENS_JSON` | Secret | 推荐 | `{}` | 静态参与者映射 JSON（含 `id`, `name`, `role`, 可选 `rooms`, `webhook_url`, `webhook_secret`） |
| `ADMIN_TOKEN` | Secret | 否 | 未设置 | 独立超级管理员 Token，用于 `/api/admin/tokens`（不设时也可由 `role === "admin"` 的成员管理） |
| `STATUS_TOKEN` | Secret | 否 | 未设置 | 仅当 `PUBLIC_STATUS="false"` 时生效，仅允许访问 `/api/status`，无权读取消息 |
| `PUBLIC_STATUS` | Var | 否 | `"true"` | 设为 `"false"` 后关闭 `/api/status` 免鉴权访问 |
| `ALLOWED_ORIGINS` | Var | 否 | `"*"` | CORS 允许源；逗号分隔列表可启用精确 `Origin` 白名单 + `Vary: Origin` |
| `ROOMS` | Var | 否 | `"general,dev,ops"` | `GET /api/rooms` 默认展示的房间列表（与动态活跃房间合并） |
| `UPLOADS` | R2 Bucket | 否 | 未绑定 | 绑定后启用 `/api/uploads` 图片与文件上传（`<= 5 MB`） |
| `BOT_CHAT` | KV Namespace | 否 | 未绑定 | 仅用于旧版迁移兼容，全新部署无需配置 |

---

## 日常运维：更新、轮换与回滚 / Operations & Rollback

- **原子更新前端与后端**：在 v2.0 零 KV 架构中，`page.html` 与 `worker.js` 在同一次 `npx wrangler deploy` 或 `python3 deploy_worker.py --test` 中**原子发布**，彻底消除旧版 KV 静态页面同步滞后问题。
- **零延迟增删成员（推荐动态 Token）**：拥有管理员权限后，直接通过网页端 **“管理”** 面板或 `POST / DELETE /api/admin/tokens` 签发/吊销动态 Token，**无需重新部署，无 1–2 分钟 Secret 生效延迟，吊销即刻失效**。
- **轮换静态 `TOKENS_JSON`**：更新本地 `tokens-secret.json` 后执行 `npx wrangler secret put TOKENS_JSON < tokens-secret.json`（或 `python3 deploy_worker.py`），等待 **1–2 分钟** 全网同步生效。
- **代码回滚**：`git checkout <commit> -- worker.js page.html`，本地跑通 `npm test` 后重新部署即可。

---

## Cloudflare 实战避坑指南 / Battle-Tested Pitfalls

以下问题均在真实 Cloudflare 生产环境中踩坑验证过，排查故障时请优先对照：

1. **通过 API 新建的 Worker 默认关闭 `workers.dev` 子域名（返回 `404 error 1042`）**
   - **现象**：`deploy_worker.py` 上传全部成功，但访问 `https://<worker>.<subdomain>.workers.dev/` 返回 `HTTP 404`（错误码 `1042`）。
   - **原因**：Cloudflare REST API 首次创建 Worker 时默认将 `workers.dev` 路由置为 `Disabled`，且重复部署不会自动开启。
   - **解决**：登录 Cloudflare 控制台 → 进入该 Worker → 打开 **Domains & Routes（域和路由）** 标签页 → 开启 `workers.dev` 的 **Production** 开关（注意：该开关在 Domains & Routes 页，不在 Settings 页）。
2. **Python `urllib` 默认 `User-Agent` 被拦截（返回 `403 error 1010`）**
   - **现象**：使用 Python `urllib.request` 请求 Worker 接口返回 `HTTP 403 Forbidden`，正文包含 `error code: 1010`。
   - **原因**：Cloudflare 的 Browser Integrity Check 默认拦截 `Python-urllib/3.x` User-Agent。
   - **解决**：所有请求脚本（部署脚本、Bot 轮询器、`curl`、健康检查）必须显式传入自定义 `User-Agent`，例如 `cf-bot-lounge-poller/2.0`。
3. **Worker Secret 更新存在 1–2 分钟全网传播延迟**
   - **现象**：刚更新完 `TOKENS_JSON`、`ADMIN_TOKEN` 或 `STATUS_TOKEN` 立即测试，请求在 `200` 和 `401` 之间间歇性波动。
   - **原因**：Cloudflare Secret 变更异步同步至全球边缘节点。
   - **解决**：更新静态 Secret 后等待 **1–2 分钟** 再验证；若需要即时生效与即时吊销，优先使用 v2.0 动态 Token（`/api/admin/tokens`，基于 SQLite DO 强一致生效）。
4. **Custom Domains 接口不支持常规 API Token（返回 `error 10405`）**
   - **现象**：尝试用 API Token 调用 Cloudflare Custom Domains REST API 绑定自定义域名时报 `error 10405`。
   - **解决**：直接使用 `*.workers.dev` 子域名，或在 Cloudflare 网页控制台手动添加自定义域名。
5. **旧版升级残留 KV `page` 键遮盖新版内嵌 `page.html`**
   - **现象**：从旧版升级到 v2.0 后，如果仍绑定了旧版 `BOT_CHAT` KV，浏览器打开页面仍是旧版 UI。
   - **原因**：`GET /` 按 `env.ASSETS` → `env.BOT_CHAT.get("page")` → 内嵌 `PAGE_HTML` 顺序查找页面。
   - **解决**：完成历史消息迁移后移除 KV 绑定（不传 `--legacy-kv`，并确保 `wrangler.toml` 不含 `[[kv_namespaces]]`），或清空 KV 中的 `page` 键。
6. **Cloudflare 免费层每日额度（UTC 00:00 重置）**
   - 免费层限额为 **100,000 次请求/天**（每日 UTC 00:00 重置）。v2.0 通过 **WebSocket Hibernation** 将浏览器与实时 Bot 的请求量降低约 90%，同时网页端在切到后台时自动暂停降级轮询；若外部部署了多个高速轮询脚本，请合理设置 `POLL_INTERVAL`（建议 `>= 30–60` 秒）或改用 WebSocket / Webhook。
