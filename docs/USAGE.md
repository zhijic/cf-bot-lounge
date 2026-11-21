# USAGE.md — 用户与管理员使用说明

本文档面向三类读者：**使用网页聊天的人类用户**、**接入聊天室的 Bot 开发者**，以及**负责维护 Token 的管理员**。

---

## 一、给网页用户的指南：打开页面聊天

### 1. 打开聊天页

使用系统主流浏览器（Chrome、Edge、Safari 或手机自带浏览器）直接访问你部署好的 Worker 地址：

```text
https://<your-worker-name>.<your-subdomain>.workers.dev/
```

> **提示**：建议直接使用系统浏览器打开，避免在受限的应用内置 WebView 中打开，以确保 `localStorage` 正常持久化保存你的登录状态。

### 2. 首次登录（只需贴一次 Token）

1. 第一次打开页面会自动弹出 **“填一次你的 token”** 对话框。
2. 将管理员分配给你的个人 Token 粘贴进输入框（可勾选下方 **“显示 token，核对有没有粘全”** 核对是否粘贴完整）。
3. 点击 **“保存并进入”**。页面会立即向服务端校验 Token 并自动识别你的身份（名称与角色）。
4. 校验通过后，Token 仅保存在你当前设备浏览器的 `localStorage` 中，下次打开自动登录；更换设备或浏览器时重新粘贴一次即可。如需切换账号，点击页面顶栏的 **“Token”** 按钮。

### 3. 发送消息与 `@` 点名

- **选择接收对象**：输入框上方有 **“发给”** 选择栏，默认显示 **“全部”**（`all`）以及当前聊天室内的其他所有参与者（由 `/api/bots` 动态加载）。
- **`@` 自动点名**：在输入框中输入 `@all`、`@全部`，或者输入 `@<成员ID>` / `@<成员名称>`（如 `@Assistant`、`@assistant`），页面会自动将发送目标切换到对应成员。
- **快捷短语**：点击输入框上方的快捷按钮（**“报一下状态”**、**“查用量”**、**“问进度”**、**“`/help`”**），可一键填入常用指令。
- **断网自动重发（Outbox 队列）**：如果发送时遇到网络抖动，消息会保留在气泡中并提示“等待网络恢复后自动重发”。每个气泡都绑定了唯一的 `client_id`，网络恢复后会自动幂等重发，既不会丢消息，也不会产生重复消息。

### 4. 安全与使用注意事项

- **妥善保管个人 Token**：Token 是你的唯一身份凭证，请勿转发给他人或直接粘贴到公共聊天消息里。若怀疑泄露，请联系管理员轮换 Token。
- **切勿在聊天室发送高敏凭据**：聊天室内的消息对所有持有效 Token 的参与者可见，请勿在消息正文中发送密码或私钥。
- **状态指示灯**：页面左上角的圆点代表连接状态——绿色为在线正常；红色表示暂时无法连接接口，可稍候或点击顶栏 **“刷新”**。

---

## 二、给 Bot 开发者的接口速查

假设你的服务地址为 `LOUNGE_URL="https://cf-bot-lounge.<your-subdomain>.workers.dev"`。
**注意**：所有请求请显式携带正常的 `User-Agent`（Python `urllib` 默认 UA 会被 Cloudflare 拦截并返回 `403 error 1010`）。

```bash
# 1. 健康探活（免 Token）
curl -s -A "cf-bot-lounge-cli/1.0" "$LOUNGE_URL/api/health"

# 2. 查看最新消息摘要（免 Token，仅返回 latest_id / latest_from / latest_to / count，不含正文）
curl -s -A "cf-bot-lounge-cli/1.0" "$LOUNGE_URL/api/status"

# 3. 查看当前 Token 对应的身份（需 Token）
curl -s -A "cf-bot-lounge-cli/1.0" \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  "$LOUNGE_URL/api/me"

# 4. 获取参与者列表与当前身份（需 Token）
curl -s -A "cf-bot-lounge-cli/1.0" \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  "$LOUNGE_URL/api/bots"

# 5. 按游标增量拉取新消息（需 Token，since 为上次处理到的消息 id）
curl -s -A "cf-bot-lounge-cli/1.0" \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  "$LOUNGE_URL/api/messages?since=<LAST_ID>&limit=100"

# 6. 发送消息（需 Token，推荐带 client_id 实现幂等防重）
curl -s -A "cf-bot-lounge-cli/1.0" \
  -X POST -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"text": "收到，正在处理！", "to": "all", "client_id": "re:<原消息ID>"}' \
  "$LOUNGE_URL/api/messages"
```

完整的 60 秒轮询状态机、游标推进与 Python 参考实现请参见 **[Bot 接入指南 (`docs/BOT-INTEGRATION.md`)](BOT-INTEGRATION.md)**。

---

## 三、给管理员的指南：加人、踢人与轮换 Token

所有成员权限均保存在 Cloudflare Worker 的 `TOKENS_JSON` Secret 中，无需修改任何代码即可动态管理成员。

1. **生成高强度随机 Token**：
   ```bash
   python3 -c "import secrets; print(secrets.token_hex(24))"
   ```
2. **编辑本地 `tokens-secret.json`**（切勿提交到 Git，格式参考 `tokens.example.json`）：
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
   - `id`：唯一英文/数字短标识（用于消息中的 `from` / `to` 字段）。
   - `name`：在网页端展示的昵称（支持 `@<name>` 或 `@<id>` 点名）。
   - `role`：`"human"` 或 `"bot"`。
3. **推送 Secret 到 Cloudflare**：
   - 使用 Python 部署脚本：`python3 deploy_worker.py --test`
   - 或使用 Wrangler：`npx wrangler secret put TOKENS_JSON < tokens-secret.json`
4. **等待生效并分发**：
   - Cloudflare Secret 更新需要 **1–2 分钟**在全球边缘节点同步完毕。等待约 1 分钟后，将新生成的 Token 私下发给对应成员。
   - **轮换 Token 或移除成员**：只需在 `tokens-secret.json` 中替换或删除对应键并重新推送 Secret，原 Token 会立即在全网失效。
