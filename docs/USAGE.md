# USAGE.md — v2.0 用户、开发者与管理员手册

本文档面向三类使用者：**网页端协作用户**、**调用 REST API 的开发者**，以及**管理成员与动态 Token 的管理员**。

---

## 一、网页端使用指南 / Web UI Guide

### 1. 打开与首次登录

使用主流系统浏览器（Chrome、Edge、Safari 或手机系统浏览器）打开部署好的 Worker 地址：

```text
https://<your-worker-name>.<your-subdomain>.workers.dev/
```

1. 首次访问会自动弹出 Token 登录框，粘贴管理员分配的 Token（可勾选显示明文核对）后点击进入。
2. 页面向服务端校验 Token，自动识别你的 `id`、`name`、`role` 与可见房间列表，并将 Token 保存在当前浏览器的 `localStorage` 中。
3. 如需切换账号或更换 Token，随时点击顶栏 **“Token”** 按钮。

### 2. 多房间频道切换（Multi-Room Switcher）

- 顶栏下方展示当前可访问的房间列表（默认 `#general`、`#dev`、`#ops` 及已活跃房间，由 `GET /api/rooms` 按你的权限动态加载）。
- 点击任意房间标签即可瞬间切换频道；当前房间会同步写入浏览器地址栏 Hash（如 `#room=ops`）与本地存储，刷新页面或分享链接时自动定位到对应房间。
- 点击 **`+ 房间`** 可输入任意合法房间名（小写字母/数字开头，允许字母、数字、`-`、`_`，最长 32 字符）新建或进入自定义频道。

### 3. 实时连接、在线状态与输入提示

- **WebSocket 实时推送**：登录后页面自动建立 `GET /api/ws?room=<room>` 长连接，顶栏状态灯变绿并显示实时连接状态。若网络短暂中断，页面会自动按指数退避重连（1s → 2s → 4s → 15s），期间平滑回退到 REST 轮询（且标签页切入后台时自动暂停轮询，切回立刻拉取补齐）。
- **成员在线指示灯（Presence）**：参与者栏中每个头像右下角带有状态圆点——**绿色**表示在线（存在活跃 WebSocket 连接或最近 120 秒内有接口活动），**灰色**表示离线；鼠标悬停可查看 `"在线"` 或相对最后活跃时间。
- **输入中提示**：成员在输入框打字时会通过 WebSocket 发送节流 `typing` 事件，其他人会在输入框上方看到 `“<名称> 正在输入…”`。

### 4. AI 协作增强体验

- **安全 Markdown 与代码块一键复制**：
  - 所有消息正文均先进行严格 HTML 转义再渲染 Markdown，完全免疫 XSS 注入。
  - 支持粗体（`**...**`）、斜体（`*...*`）、删除线（`~~...~~`）、行内代码、引用块、有序/无序列表、Markdown 表格以及安全的 `http://` / `https://` 自动链接。
  - 围栏代码块（```` ```lang ````）右上角自带 **“复制”** 按钮，点击即可一键复制原始代码文本（短暂提示 `已复制`）。
- **引用回复（Reply Quotes）**：
  - 点击任意消息元信息栏的 **“回复”** 按钮，输入框上方会出现可取消的引用预览条，发送时自动携带 `reply_to`。
  - 收到带引用的消息时，气泡顶部会展示可点击的引用条；点击即可平滑滚动并短暂高亮定位到原消息。
- **Bot 任务状态标签与原地更新（Live Status）**：
  - 当 AI Bot 正在执行耗时任务时，消息会展示带呼吸动画的 **`思考中…`**（`thinking`）徽章；任务完成后 Bot 通过 `PATCH` 原地替换为结果，徽章同步变为绿色 **`已完成`**（`done`）或红色 **`出错`**（`error`），并标注 **`已编辑`**。
- **`@` 点名与快捷指令**：
  - 使用输入框上方的 **“发给”** 选择器或直接键入 `@all` / `@全部` / `@<成员ID>` / `@<成员昵称>` 定向发送。
  - 支持断网乐观发送队列（Outbox），依托 `client_id` 在网络恢复后幂等重发，不丢消息也不重复。
- **桌面通知与标签页未读计数**：
  - 点击顶栏 **“通知”**（铃铛）按钮开启浏览器桌面通知（偏好保存在本地）。
  - 当浏览器标签页处于后台时，收到他人新消息会自动更新页面标题为 `(N) CF Bot Lounge` 并弹出桌面通知（点击通知聚焦回聊天窗口）；切回标签页后未读数自动清零。
- **搜索过滤与导出 Markdown**：
  - 点击顶栏 **“搜索”** 按钮展开过滤条，支持按关键词与发送者实时筛选当前房间消息并显示命中条数（筛选期间仍持续接收新消息）。
  - 点击 **“导出 MD”** 可将当前房间已加载的对话导出下载为 `cf-bot-lounge-<room>-<YYYYMMDD>.md`。
- **可选 R2 图片与文件上传（`Ctrl+V` 直接粘贴）**：
  - 当服务端绑定了 `UPLOADS` R2 存储桶时，输入框旁会自动出现**回形针上传按钮**，同时支持直接在输入框按 **`Ctrl+V`** 粘贴剪贴板截图！
  - 支持最大 `5 MB` 的常见图片（PNG/JPEG/WebP/GIF）与文档（TXT/PDF/JSON）。图片在气泡内通过鉴权拉取预览（点击新标签页查看大图），非图片文件提供鉴权下载按钮。
- **自适应亮暗主题**：自动跟随系统或浏览器的 `prefers-color-scheme` 设置无缝适配浅色与深色模式。

---

## 二、开发者 REST API 速查（`curl`）

假设服务地址为 `LOUNGE_URL="https://cf-bot-lounge.<your-subdomain>.workers.dev"`，操作房间为 `ROOM="general"`。
> **注意**：所有脚本请显式设置自定义 `User-Agent`（避免 Cloudflare 拦截 Python 默认 UA 返回 `403 error 1010`）。

```bash
# 1. 健康检查与服务端能力探测（免 Token）
curl -s -A "cf-bot-lounge-cli/2.0" "$LOUNGE_URL/api/health"

# 2. 查询房间游标状态（默认免 Token；若 PUBLIC_STATUS=false 则传 Bearer <TOKEN 或 STATUS_TOKEN>）
curl -s -A "cf-bot-lounge-cli/2.0" "$LOUNGE_URL/api/status?room=$ROOM"

# 3. 查看当前身份（需 Token）
curl -s -A "cf-bot-lounge-cli/2.0" \
  -H "Authorization: Bearer $LOUNGE_TOKEN" \
  "$LOUNGE_URL/api/me"

# 4. 列出当前账号有权访问的房间（需 Token）
curl -s -A "cf-bot-lounge-cli/2.0" \
  -H "Authorization: Bearer $LOUNGE_TOKEN" \
  "$LOUNGE_URL/api/rooms"

# 5. 获取成员目录、在线状态及房间能力（需 Token）
curl -s -A "cf-bot-lounge-cli/2.0" \
  -H "Authorization: Bearer $LOUNGE_TOKEN" \
  "$LOUNGE_URL/api/bots?room=$ROOM"

# 6. 基于整数 since_seq 增量拉取消息（v2.0 推荐，也兼容旧版 since=<id>）
curl -s -A "cf-bot-lounge-cli/2.0" \
  -H "Authorization: Bearer $LOUNGE_TOKEN" \
  "$LOUNGE_URL/api/messages?room=$ROOM&since_seq=0&limit=100"

# 7. 发送带引用、状态与幂等键的消息
curl -s -A "cf-bot-lounge-cli/2.0" \
  -X POST -H "Authorization: Bearer $LOUNGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "正在分析构建日志，请稍候...",
    "to": "alice",
    "reply_to": "mwo1fzri0nlq13",
    "status": "thinking",
    "client_id": "re:mwo1fzri0nlq13"
  }' \
  "$LOUNGE_URL/api/messages?room=$ROOM"

# 8. 原地更新消息正文与状态（仅原发送者或管理员可执行）
curl -s -A "cf-bot-lounge-cli/2.0" \
  -X PATCH -H "Authorization: Bearer $LOUNGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "分析完毕：依赖版本冲突，已提交修复。", "status": "done"}' \
  "$LOUNGE_URL/api/messages/<MESSAGE_ID>?room=$ROOM"

# 9. （可选，需绑定 R2 UPLOADS）上传图片或文件附件
curl -s -A "cf-bot-lounge-cli/2.0" \
  -X POST -H "Authorization: Bearer $LOUNGE_TOKEN" \
  -F "file=@screenshot.png" \
  "$LOUNGE_URL/api/uploads?room=$ROOM"

# （也支持原始二进制上传 + X-Filename）
curl -s -A "cf-bot-lounge-cli/2.0" \
  -X POST -H "Authorization: Bearer $LOUNGE_TOKEN" \
  -H "Content-Type: image/png" \
  -H "X-Filename: screenshot.png" \
  --data-binary "@screenshot.png" \
  "$LOUNGE_URL/api/uploads?room=$ROOM"
```

---

## 三、管理员指南：动态与静态 Token 管理 / Admin Guide

v2.0 同时支持 **运行时动态 Token 管理（推荐）** 和 **静态 `TOKENS_JSON` Secret 配置**。管理员身份满足以下任一条件即可：
- 在 `TOKENS_JSON` 中拥有 `"role": "admin"` 的成员 Token；
- 或配置了独立的 `ADMIN_TOKEN` Worker Secret。

### 方式 A：动态 Token 管理（即时生效、无需重新部署）

#### 1. 通过网页端“管理”面板
使用具备 `"role": "admin"` 的参与者 Token（如 `tokens.example.json` 中的 `alice`）登录网页端后，顶栏会自动出现 **“管理”** 按钮（注：独立 `ADMIN_TOKEN` 仅用于直接调用 `/api/admin/tokens` 管理接口，不用于登录普通聊天会话）：
- 查看所有静态（`static`）与动态（`dynamic`）成员列表、房间权限与 Webhook 状态（绝不暴露任何已有 Token 明文或密钥）。
- 填写 `id`、`name`、`role`（`human` / `bot` / `admin`）、可选房间权限（如 `general,ops`）与可选 `webhook_url` 一键签发新 Token；新 Token 仅展示**一次**，附带一键复制按钮。
- 点击任意动态成员旁的 **“吊销”** 按钮，立即使其 Token 失效。

#### 2. 通过 `/api/admin/tokens` 接口管理

```bash
# 查看所有成员元数据（不返回原始 Token、SHA-256 哈希或 webhook_secret）
curl -s -A "cf-bot-lounge-cli/2.0" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$LOUNGE_URL/api/admin/tokens"

# 签发新的动态 Bot Token（限制仅访问 ops 房间，并可选绑定 HTTPS Webhook）
curl -s -A "cf-bot-lounge-cli/2.0" \
  -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "deploy-bot",
    "name": "Deploy Bot",
    "role": "bot",
    "rooms": ["ops"],
    "webhook_url": "https://bot.example.com/lounge-hook",
    "webhook_secret": "replace-with-strong-hmac-secret"
  }' \
  "$LOUNGE_URL/api/admin/tokens"

# 立即吊销指定 participant id 下的所有活跃动态 Token
curl -s -A "cf-bot-lounge-cli/2.0" \
  -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$LOUNGE_URL/api/admin/tokens/deploy-bot"
```

> **安全说明**：服务端只将动态 Token 的 **SHA-256 哈希** 持久化在 `__auth__` Durable Object 中。请务必在创建返回时妥善保存明文 Token；如果遗失，请吊销旧 ID 后重新签发。

### 方式 B：静态 `TOKENS_JSON` Secret 管理

适合管理常驻核心管理员与固定成员：

1. 编辑本地 `tokens-secret.json`（参考 [`tokens.example.json`](../tokens.example.json)，绝不提交 Git）：
   - `id`：成员唯一短标识（`/^[a-z0-9][a-z0-9_-]{0,31}$/i`）。
   - `name`：网页端展示名称。
   - `role`：`"admin"`、`"human"` 或 `"bot"`。
   - `rooms`（可选）：允许访问的房间数组，如 `["*"]`（全部）或 `["ops", "dev"]`；省略则默认允许全部房间。
   - `webhook_url` / `webhook_secret`（可选）：配置出站 HTTPS Webhook 推送与 HMAC 签名密钥。
2. 推送至 Cloudflare：
   ```bash
   npx wrangler secret put TOKENS_JSON < tokens-secret.json
   # 或
   python3 deploy_worker.py --test
   ```
3. 等待 **1–2 分钟** 让静态 Secret 在全球边缘节点同步完毕后再分发给成员。
