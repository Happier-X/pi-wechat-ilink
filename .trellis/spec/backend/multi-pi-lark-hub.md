# Multi-Pi 飞书 Hub 合约

> 本机 `pi-lark-hub` + `lark-bridge` 的可执行约定。  
> 产品包名为 **`pi-lark-hub`**；默认扩展入口 `src/index.ts` re-export lark-bridge。

---

## 1. Scope / Trigger

适用场景：

- 多个 Pi 进程同时运行，需要统一远程提醒与回传
- 审批 / 显式 need_reply / 任务结束通知
- 回复必须路由到正确 `piId`

不在本合约：

- 云端多机 hub
- 完整 interactive 卡片 JSON 工作流（当前审批出站可为文本 MVP）
- 已移除的微信 iLink 通道（历史实现，不再维护）

---

## 2. Signatures

### 进程

| 入口 | 说明 |
|------|------|
| `npm run hub` / `pi-lark-hub` | 启动 hub（`src/hub/cli.ts`） |
| `pi.extensions` → `./src/index.ts` | 默认加载 bridge（re-export） |
| `pi -e ./src/lark-bridge/index.ts` | 显式加载 bridge（等价） |

### Loopback HTTP（仅 127.0.0.1）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/health` | 健康与在线摘要；含 `feishuMode` / `ownerBound` / `needsPairing`（配对引导用） |
| GET | `/instances` | 在线实例列表 |
| GET | `/notifications` | 最近出站（调试） |
| GET | `/approvals` | 审批状态（调试） |
| POST | `/control/message` | 模拟/入站用户文本 |
| POST | `/control/approval` | 模拟审批决策 |

### WebSocket（Pi ↔ Hub）

见 `src/protocol.ts`：

| 方向 | type |
|------|------|
| Pi→Hub | `register` / `heartbeat` / `notify` / `unregister` / **`pair_begin`** |
| Hub→Pi | `register_ok` / `notify_ack` / `user_message` / `approval_result` / `error` / **`pair_challenge`** / **`pair_result`** |

配对字段：`pair_challenge` → `{ code, expiresAt, ttlMs }`；`pair_result` → `{ ok, openId?, message }`。

### 配置

路径默认：`~/.pi/lark-hub/config.json`（可用 `PI_LARK_HUB_CONFIG` 覆盖）。

合并顺序：**defaults < 文件 < 环境变量**。

---

## 3. Contracts

### 环境变量

| 变量 | 含义 |
|------|------|
| `PI_LARK_HUB_PORT` | 端口，默认 8765 |
| `PI_LARK_HUB_URL` | Bridge 连接 WS URL |
| `PI_LARK_HUB_AUTOSTART` | Bridge 是否自动拉起本机 Hub；默认开；`0`/`false`/`no`/`off` 关闭 |
| `PI_LARK_HUB_AUTORESTART` | health 能力过期时是否自动重启 loopback Hub；默认开；falsy 关闭 |
| `PI_LARK_ALLOWED_OPEN_IDS` | 逗号分隔 open_id 白名单 |
| `PI_LARK_FEISHU_MODE` | `console` \| `lark-cli` \| `native` |
| `PI_LARK_FEISHU_USER_ID` | 出站 DM 目标 `ou_xxx` |
| `PI_LARK_FEISHU_CHAT_ID` | 出站群 `oc_xxx`（与 userId 二选一） |

### Bridge 自动拉起 Hub

| 规则 | 行为 |
|------|------|
| 触发 | `session_start` / 断线重连前 `ensureHubRunning`（`src/lark-bridge/hub-autostart.ts`） |
| 探测 | `GET http://127.0.0.1:<port>/health` 且 `ok===true` → 不 spawn |
| 范围 | 仅 loopback URL；detached + `windowsHide`；子进程 stdout/stderr → `~/.pi/lark-hub/hub.log`（不污染 TUI） |
| 运行时依赖 | `tsx` 必须在 **dependencies**（`scripts/pi-lark-hub.mjs` 运行时 resolve）；不可只放 devDependencies |
| 冷却 | 每 bridge 进程约 30s 内最多一次 spawn 尝试 |
| 生命周期 | Pi/`session_shutdown` **不**杀 Hub（常驻） |
| 关闭 | `PI_LARK_HUB_AUTOSTART=0` |
| 失败诊断 | 超时/启动失败 notify 必须附 `hub.log` 路径 |
| 更新自愈 | `/health` 暴露 `pid` / `packageVersion` / `features`；缺 bridge 最低能力（当前 `pair_begin`）= stale；仅 loopback 且有合法 health.pid 时 SIGTERM 后拉起当前包，禁止扫端口盲杀 |

### 本人短码配对（必须）

| 步骤 | 行为 |
|------|------|
| 发起 | Pi 命令 `/lark-pair`，或 **lark-cli 未绑定** 时 bridge 在 `register_ok` 后自动 `pair_begin`（每进程最多一次） |
| 出码 | Hub `PairingStore`：6 位（去易混字符），TTL 5min，单活跃会话，用后即废 |
| 展示 | Hub→Pi `pair_challenge`；bridge notify 中文口令 + 本地 PNG 二维码（`~/.pi/lark-hub/pair-qr.png`，载荷=`配对 CODE`，失败降级短码） |
| 入站口令 | 文本 `配对 <码>` 或 `pair <码>`（`parsePairCommand`） |
| 鉴权顺序 | **配对口令先于白名单**；无会话/错码/过期/无 openId → 不改配置 |
| 成功 | `allowedOpenIds=[open_id]`、`feishu.userId=open_id`、**删除 chatId**；`saveHubOwnerBinding` 落盘；热更新内存 allowlist；`LarkCliFeishuTransport.setRecipient`；WS `pair_result` |
| 模拟 | `POST /control/message` 必须带 `openId` |
| env | 文件绑定可被 `PI_LARK_*` 重启覆盖；回执须提示清理 env |

### 路由规则（必须）

| 入站 | 行为 |
|------|------|
| 审批 `requestId` | 精确到创建审批的 `piId`；幂等；离线不改投 |
| `replyToMessageId` 已绑定 | `source=reply`，带 `replyToRequestId`（若绑定含 requestId） |
| `replyToMessageId` 未绑定/离线 | fail-closed，不改投 |
| 纯文本 + 单在线 | 自动默认并投递 |
| 纯文本 + 多在线无默认 | 不投递，返回列表 |
| `列表` / `使用 <id\|名>` | hub 本地处理，不转发 Pi |
| `配对` / `pair` + 码 | hub 本地配对，不转发 Pi |

### 远程文本 → Pi

- 必须 `pi.sendUserMessage(text)`，**禁止** `deliverAs: "followUp"|"steer"`
- 忙时用扩展 FIFO，在 `agent_settled` 后 drain

### 飞书 mode

| mode | 出站 | 入站 | 白名单 |
|------|------|------|--------|
| `console` | 日志 + 合成 `console-` messageId | HTTP `/control/*` | 空数组可放行（开发，`consoleAllowEmptyAllowlist`） |
| `lark-cli` | `lark-cli im +messages-send`（可 bootstrap 无收件人构造，send 前须有 recipient） | 可选 `event consume` + HTTP | **空=bootstrap**：非配对消息拒绝；有名单则仅名单 + 须 userId/chatId |
| `native` | 官方 OpenAPI `im.message.create`，返回真实 `message_id` | 官方 SDK WebSocket `im.message.receive_v1` | 空=bootstrap；未绑定时仅 `/lark-pair`，禁止首聊自助成主 |

`/lark-setup [force]` 对齐 cc-connect 的 PersonalAgent registration：二维码载荷为飞书返回的 `verification_uri_complete` URL，不是 `配对 CODE`。注册在本机轮询完成；凭证独立落盘到 `~/.pi/lark-hub/credentials.json`（可由 `PI_LARK_HUB_CREDENTIALS` 覆盖），secret 不进入 config/日志。已有凭证默认拒绝，只有 `force` 覆盖。native WS 必须达到 `connected` 才算就绪；热切换失败需恢复旧 transport/inbound/config。控制面仍为 loopback，不自建公网回调。

运行时 `isAuthorized`：**空名单 + 非 console → false**（配对分支已在 control 先处理）；**禁止** `allowed.size===0 → true` 用于 lark-cli。

---

## 4. Validation & Error Matrix

| 条件 | 结果 |
|------|------|
| host 非 loopback | 拒绝启动 |
| lark-cli 空白名单 | **允许启动**（bootstrap）；非配对入站拒绝 |
| lark-cli 有名单无 userId/chatId | 拒绝启动（`missing_recipient`） |
| lark-cli 空白名单无收件人 | 允许启动；出站 send 失败直到配对/`setRecipient` |
| 未授权 openId | `ok: false`，不投递；提示 `/lark-pair` |
| 配对无会话/错码/过期/无 openId | 回执失败原因；配置不变 |
| 配对成功 | 单主人落盘 + 热更新；可换绑覆盖 |
| 审批重复决策且已投递 Pi | `already_handled`，不二次执行 |
| 审批 terminal 但投递失败 | 可同决策重试，不改决策 |
| need_reply 超时 | bridge 本地超时；不启发式猜答案 |
| hub 进程挂了 | bridge 提示 + 重连；审批回退本机 UI；不崩 |

---

## 5. Good / Base / Bad Cases

**Good**

- 两 Pi 在线；审批 A 的 requestId 只回 A
- 回复 `console-xxx` / `om_xxx` 只进绑定 pi
- `/lark-ask` 后仅 `reply`+匹配 requestId 才 resolve
- `/lark-pair` → 飞书/control「配对 CODE」→ 仅主人 open_id 在白名单且 userId 为本人

**Base**

- console 模式单测全绿、无需飞书网络
- 默认 package 扩展加载 lark-bridge（`src/index.ts` re-export）
- lark-cli 空白名单可启动并完成配对 bootstrap

**Bad**

- 多 Pi 无默认时静默投给「第一个」
- 用 followUp 投递飞书文本
- lark-cli 空白名单时放行所有非配对消息（`allowed.size===0 → true`）
- 配对在白名单之后处理导致首次无法绑定
- 把模型带 `?` 的回复自动当 need_reply

---

## 6. Tests Required

| 断言点 | 位置 |
|--------|------|
| 默认路由单在线/歧义/使用 | `src/hub/router.test.ts` |
| 绑定回复 / 离线 fail-closed | 同上 |
| 审批幂等与 failed_delivery 重试 | 同上 |
| 配对优先白名单 / 错码不落盘 | 同上 + `src/hub/pairing.test.ts` |
| 配置合并、bootstrap、saveHubOwnerBinding | `src/hub/config.test.ts` |
| lark-cli 出站解析 / 无收件人 send 失败 | `src/hub/feishu-lark-cli.test.ts` |
| `npm run typecheck` | CI/本地必跑 |

---

## 7. Wrong vs Correct

**Wrong：** 忙时 `sendUserMessage(text, { deliverAs: "followUp" })`  
**Correct：** 扩展队列 + idle 时 `sendUserMessage(text)`

**Wrong：** 审批目标离线时改投默认 Pi  
**Correct：** `failed_delivery` / 飞书提示失败，不改投

**Wrong：** `event: need_reply` 来自正则扫 assistant 文本  
**Correct：** 仅 `/lark-ask` 或未来显式桥接 API

**Wrong：** lark-cli 空白名单 `isAuthorized` 返回 true  
**Correct：** 空名单默认 false；`handleControlMessage` 先处理配对口令再 auth

**Wrong：** 配对成功仍保留 `chatId` 出站群  
**Correct：** 强制 `userId=open_id` 并删除 `chatId`
