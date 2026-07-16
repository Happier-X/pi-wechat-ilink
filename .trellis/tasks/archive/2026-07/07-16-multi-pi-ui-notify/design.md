# 设计：多 Pi 飞书通知与回复路由

## 问题

多个 Pi 同时运行时，需要：

1. 把「审批 / 显式需回复 / 任务结束」推到手机飞书  
2. 把用户的批准、拒绝、回复、新指令**精确**送回对应 Pi  

微信 iLink 多实例抢游标的模式不可复用；采用**本地 hub + 飞书机器人**。

## 组件划分

```
┌─────────────┐   ┌─────────────┐
│  Pi A + 扩展 │   │  Pi B + 扩展 │  ...
└──────┬──────┘   └──────┬──────┘
       │  本地 IPC/WebSocket（注册/心跳/事件/指令）
       ▼                 ▼
┌──────────────────────────────────┐
│  pi-lark-hub（本机守护进程）        │
│  - 实例注册表 + 心跳               │
│  - 默认 Pi / 消息绑定表            │
│  - 审批状态机（幂等/超时）          │
│  - 飞书出站（消息/卡片）            │
│  - 飞书入站（消息事件/卡片回调）     │
└──────────────────┬───────────────┘
                   │ 飞书 OpenAPI / 事件
                   ▼
              用户手机飞书
```

| 组件 | 职责 |
|------|------|
| **Pi 扩展**（如 `pi-lark-bridge`） | 向 hub 注册；上报审批/需回复/结束；接收 hub 下发的用户文本与审批结果；hub 不可用时本机 UI 降级 |
| **pi-lark-hub** | 唯一飞书连接与路由真源；不运行 LLM |
| **飞书应用** | 机器人发消息/卡片；订阅消息与 card.action |

## 仓库与交付形态（建议）

本任务落在当前 monorepo 意向时，建议拆为：

| 产物 | 说明 |
|------|------|
| `packages/pi-lark-hub` 或顶层 `hub/` | 可执行守护进程 |
| `packages/pi-lark-bridge` 或 `extensions/lark/` | Pi 扩展 |
| 共享 `protocol` 类型 | 注册/事件/指令 JSON schema |

若保持单仓仅扩展、hub 另仓，需在 implement 阶段二选一；**推荐同仓双包**，便于协议同步。

> 注意：当前仓库名是 wechat-ilink，MVP 可新建子目录而不改动微信扩展行为。

## 协议草案（Pi ↔ Hub）

传输：本机 `127.0.0.1` WebSocket 或 HTTP+SSE；仅 loopback。

### 注册

```ts
// Pi → Hub
{
  type: "register",
  piId: string,          // 建议: 短可读 id，如 "a3f2" 或 slug(cwd)+短随机
  displayName: string,   // 目录名 / package name
  cwd: string,
  pid: number,
  capabilities: ["approval", "prompt", "settled"]
}

// Hub → Pi
{ type: "register_ok", piId: string }
```

### 心跳

```ts
{ type: "heartbeat", piId: string, status: "idle" | "busy", ts: number }
// 超时（如 30s 无心跳）→ 标记 offline，清默认若命中
```

### 出站事件（Pi → Hub → 飞书）

```ts
{
  type: "notify",
  piId: string,
  event: "approval" | "need_reply" | "task_end",
  requestId: string,     // 全局唯一，不可短可猜
  title: string,
  body: string,
  // approval 专用
  actions?: ["approve", "reject"],
  timeoutMs?: number
}
```

### 入站指令（飞书 → Hub → Pi）

```ts
{
  type: "user_message",
  piId: string,
  text: string,
  source: "reply" | "default" | "command",
  replyToRequestId?: string
}

{
  type: "approval_result",
  piId: string,
  requestId: string,
  decision: "approve" | "reject",
  actorOpenId: string
}
```

## 飞书侧

- **身份**：bot；仅白名单 `open_id` 可操作。  
- **出站**：私聊用户；审批用交互卡片，value 内嵌 `requestId`、`piId`、签名或 HMAC。  
- **入站**：`im.message.receive_v1`（或 CLI event consume）+ `card.action.trigger`。  
- **消息绑定**：发送成功后记录 `message_id → piId`（及可选 requestId），用于「回复某条」。  
- **控制命令**：`列表`、`使用 ...` 由 hub 本地处理，不转发 Pi。

## 默认路由状态机（Hub）

```
在线集合 S
默认 D ∈ S ∪ {null}

入站纯文本:
  if |S|==1 → D=that; deliver
  else if D∈S → deliver D
  else → 回复列表，不投递

实例 offline:
  S -= id; if D==id → D=null

使用 name:
  matches = resolve(name)
  if |matches|==1 → D=matches[0]
  else → 返回候选
```

## 审批状态机

```
pending → (approve|reject|timeout) → terminal
重复回调 terminal → 幂等返回已处理，不二次通知 Pi
Pi 离线时回调 → 飞书提示失败，状态保持或标 failed_delivery
```

## 扩展在 Pi 内的挂钩

| 事件 | 行为 |
|------|------|
| `session_start` | 连接 hub、register、heartbeat |
| `tool_call` 危险 bash | 创建 requestId，notify approval；等待 hub `approval_result` 或本机 UI 竞速（与现微信扩展类似） |
| 显式 UI 输入桥接 | need_reply 通知（MVP 可先只做审批+结束，need_reply 做最小桥） |
| `agent_settled` | task_end 摘要 notify |
| 收到 `user_message` | `pi.sendUserMessage(text)`，**禁止** deliverAs followUp（沿用 editor-leak 规范） |
| hub 断开 | 状态提示；审批回退本机 `ctx.ui.select` |

## 安全

- Hub 只监听 `127.0.0.1`  
- 飞书用户白名单配置文件（如 `~/.pi/lark-hub/config.json`）  
- requestId 使用足够熵（UUID）  
- 卡片 action 校验 token/签名  

## 权衡

| 项 | 选择 | 原因 |
|----|------|------|
| Hub 独立进程 | 是 | 不绑 Pi 生命周期 |
| 单聊而非群 | 是 | MVP 个人遥控简单 |
| 不启发式需回复 | 是 | 降噪 |
| 同仓双包 | 建议 | 协议一体演进 |
| 复用 lark-cli | 实现期评估 | 开发快 vs 长期依赖 |

## 回滚

停 hub、卸扩展即可；不影响微信扩展与 Pi 本体。
