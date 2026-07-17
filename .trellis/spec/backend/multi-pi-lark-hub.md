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
| GET | `/health` | 健康与在线摘要 |
| GET | `/instances` | 在线实例列表 |
| GET | `/notifications` | 最近出站（调试） |
| GET | `/approvals` | 审批状态（调试） |
| POST | `/control/message` | 模拟/入站用户文本 |
| POST | `/control/approval` | 模拟审批决策 |

### WebSocket（Pi ↔ Hub）

见 `src/protocol.ts`：`register` / `heartbeat` / `notify` / `unregister` ↔ `register_ok` / `notify_ack` / `user_message` / `approval_result` / `error`。

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
| `PI_LARK_ALLOWED_OPEN_IDS` | 逗号分隔 open_id 白名单 |
| `PI_LARK_FEISHU_MODE` | `console` \| `lark-cli` |
| `PI_LARK_FEISHU_USER_ID` | 出站 DM 目标 `ou_xxx` |
| `PI_LARK_FEISHU_CHAT_ID` | 出站群 `oc_xxx`（与 userId 二选一） |

### Bridge 自动拉起 Hub

| 规则 | 行为 |
|------|------|
| 触发 | `session_start` / 断线重连前 `ensureHubRunning`（`src/lark-bridge/hub-autostart.ts`） |
| 探测 | `GET http://127.0.0.1:<port>/health` 且 `ok===true` → 不 spawn |
| 范围 | 仅 loopback URL；stdio `ignore` + detached，不污染 TUI |
| 冷却 | 每 bridge 进程约 30s 内最多一次 spawn 尝试 |
| 生命周期 | Pi/`session_shutdown` **不**杀 Hub（常驻） |
| 关闭 | `PI_LARK_HUB_AUTOSTART=0` |

### 路由规则（必须）

| 入站 | 行为 |
|------|------|
| 审批 `requestId` | 精确到创建审批的 `piId`；幂等；离线不改投 |
| `replyToMessageId` 已绑定 | `source=reply`，带 `replyToRequestId`（若绑定含 requestId） |
| `replyToMessageId` 未绑定/离线 | fail-closed，不改投 |
| 纯文本 + 单在线 | 自动默认并投递 |
| 纯文本 + 多在线无默认 | 不投递，返回列表 |
| `列表` / `使用 <id\|名>` | hub 本地处理，不转发 Pi |

### 远程文本 → Pi

- 必须 `pi.sendUserMessage(text)`，**禁止** `deliverAs: "followUp"|"steer"`
- 忙时用扩展 FIFO，在 `agent_settled` 后 drain

### 飞书 mode

| mode | 出站 | 入站 | 白名单 |
|------|------|------|--------|
| `console` | 日志 + 合成 `console-` messageId | HTTP `/control/*` | 空数组可放行（开发） |
| `lark-cli` | `lark-cli im +messages-send` | 可选 `event consume` + HTTP | **必须非空 allowlist**；必须配置 userId 或 chatId |

---

## 4. Validation & Error Matrix

| 条件 | 结果 |
|------|------|
| host 非 loopback | 拒绝启动 |
| lark-cli 无 allowlist | 拒绝启动 |
| lark-cli 无 userId/chatId | 拒绝启动 |
| 未授权 openId | `ok: false`，不投递 |
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

**Base**

- console 模式单测全绿、无需飞书网络
- 默认 package 扩展加载 lark-bridge（`src/index.ts` re-export）

**Bad**

- 多 Pi 无默认时静默投给「第一个」
- 用 followUp 投递飞书文本
- lark-cli 模式空白名单启动
- 把模型带 `?` 的回复自动当 need_reply

---

## 6. Tests Required

| 断言点 | 位置 |
|--------|------|
| 默认路由单在线/歧义/使用 | `src/hub/router.test.ts` |
| 绑定回复 / 离线 fail-closed | 同上 |
| 审批幂等与 failed_delivery 重试 | 同上 |
| 配置合并与 lark-cli 校验 | `src/hub/config.test.ts` |
| lark-cli 出站解析（mock spawn） | `src/hub/feishu-lark-cli.test.ts` |
| `npm run typecheck` | CI/本地必跑 |

---

## 7. Wrong vs Correct

**Wrong：** 忙时 `sendUserMessage(text, { deliverAs: "followUp" })`  
**Correct：** 扩展队列 + idle 时 `sendUserMessage(text)`

**Wrong：** 审批目标离线时改投默认 Pi  
**Correct：** `failed_delivery` / 飞书提示失败，不改投

**Wrong：** `event: need_reply` 来自正则扫 assistant 文本  
**Correct：** 仅 `/lark-ask` 或未来显式桥接 API
