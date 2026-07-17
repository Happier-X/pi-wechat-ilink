# Error Handling

> Error handling for **pi-lark-hub**（守护进程 + `lark-bridge`）。

---

## Overview

Errors surface as:

1. **Hub / Feishu replies** to the inbound remote user (route failures, unauthorized openId, offline delivery)
2. **Pi UI** `notify` / `setStatus` (hub disconnect, send failures, need_reply timeout)
3. **Startup validation** that refuses unsafe hub config（non-loopback；lark-cli 有名单但无收件人；空白名单允许 bootstrap 配对）

Prefer best-effort remote feedback; never leave the TUI blocked on SDK stdin. For hub routing and Feishu modes, see [multi-pi-lark-hub.md](./multi-pi-lark-hub.md).

---

## Error Types

No custom error classes. Use `Error` with clear Chinese or bilingual messages for user-visible paths.

---

## Error Handling Patterns

| Situation | Behavior |
|-----------|----------|
| `sendUserMessage` throws (idle or drain) | Clear current remote flags; notify / hub error as appropriate. On drain, continue next queue item if still idle. |
| Hub notify / outbound Feishu fails | Bridge status / notify error; do not crash Pi; hub may mark `failed_delivery` for approval retry with same decision. |
| Hub process down | Bridge reconnect +（默认）冷却后自动再拉起本机 Hub；审批 / need_reply 可回退本机 UI；do not crash. |
| Unauthorized openId | Hub `ok: false`, no delivery；可提示 `/lark-pair`。 |
| 配对失败（无会话/错码/过期/无 openId） | 中文回执；不改配置。 |
| 配对落盘失败 | 回执失败；不静默半成功。 |
| Approval duplicate after Pi already received | `already_handled`; do not re-execute. |
| Approval terminal but Pi delivery failed | Same decision may retry; decision not flipped. |
| need_reply timeout | Bridge local timeout; **do not** heuristic-guess answers from assistant text. |
| Dangerous-command approval timeout | Treat as reject; block tool with timeout reason. |

---

## Validation & Error Matrix (hub / remote queue)

| Input / state | Result |
|---------------|--------|
| host 非 loopback | Hub 拒绝启动 |
| lark-cli 空白名单 | 允许启动（bootstrap）；非配对入站拒绝 |
| lark-cli 有名单无 userId/chatId | Hub 拒绝启动 |
| Busy / slot busy + remote text | enqueue + remote queued ack (not an error) |
| Drain submit failure | remote error surface; try next queued item |
| replyToMessageId 未绑定 / 目标离线 | fail-closed，不改投 |

---

## Common Mistakes

1. **Using Pi `followUp` / `steer` for remote tasks while busy** — abort dumps text into the editor. Use extension-owned FIFO.
2. **Assuming `isIdle()` alone means safe to start a remote run** — between drain submit and `agent_start`, or between `agent_end` and `agent_settled`, flags may still own the reply slot. Check remote-run / request / draining flags.
3. **Rerouting approval or bound reply to “default Pi” when offline** — forbidden; fail-closed.
4. **Treating model text with `?` as need_reply** — only explicit `/lark-ask` (or future bridge API).
5. **lark-cli 空白名单时 `isAuthorized` 恒 true** — 仅 console 开发可空名单放行；bootstrap 须配对优先、其它拒绝。
