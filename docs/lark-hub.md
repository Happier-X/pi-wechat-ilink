# 多 Pi 飞书 Hub（Phase 0–5）

本机守护进程 `pi-lark-hub` + Pi 扩展 `lark-bridge`，用于多 Pi 注册、默认路由、任务结束通知、回复绑定、危险命令审批与显式 need_reply。

**默认模式：`console`（离线可测）**。真实飞书为 **opt-in**：配置 `feishu.mode=lark-cli` 后通过本机 `lark-cli` 收发。

## 架构

```text
Pi A (lark-bridge) ──┐
                     │  WebSocket 127.0.0.1
Pi B (lark-bridge) ──┼──► pi-lark-hub
                     │       ├── 注册表 / 心跳 / 默认路由
                     │       ├── messageId → piId 绑定
                     │       ├── 审批状态机（幂等 / 超时）
                     │       ├── notify → Console 或 lark-cli 出站
                     │       ├── POST /control/*（始终可用）
                     │       └── （可选）event consume 入站
用户（curl / 飞书）──┘
```

产品包 **`pi-lark-hub`**：默认 `package.json` 的 `pi.extensions` 加载 `src/index.ts`（re-export `lark-bridge`）。也可显式 `pi -e ./src/lark-bridge/index.ts`。

## 配置

合并顺序：**defaults &lt; `~/.pi/lark-hub/config.json` &lt; 环境变量**。

路径可用 `PI_LARK_HUB_CONFIG` 覆盖。

### 类型摘要

```ts
type HubConfig = {
  host: "127.0.0.1";
  port: number;
  allowedOpenIds: string[]; // console 空=开发放行；lark-cli 空=bootstrap 仅允许配对
  feishu: {
    mode: "console" | "lark-cli";
    as: "bot" | "user";
    userId?: string;  // ou_xxx，与 chatId 二选一
    chatId?: string;  // oc_xxx
  };
  requireAllowlist: boolean; // lark-cli 默认 true（空白名单仍允许启动以便 /lark-pair）
};
```

### 示例 `~/.pi/lark-hub/config.json`

```json
{
  "port": 8765,
  "allowedOpenIds": ["ou_xxxxxxxxxxxxxxxx"],
  "requireAllowlist": true,
  "feishu": {
    "mode": "lark-cli",
    "as": "bot",
    "userId": "ou_xxxxxxxxxxxxxxxx"
  }
}
```

console 开发最小配置（可不建文件，直接用默认）：

```json
{
  "feishu": { "mode": "console" }
}
```

### 环境变量

| 变量 | 含义 |
|------|------|
| `PI_LARK_HUB_PORT` | 端口 |
| `PI_LARK_ALLOWED_OPEN_IDS` | 逗号分隔 open_id 白名单 |
| `PI_LARK_FEISHU_MODE` | `console` \| `lark-cli` |
| `PI_LARK_FEISHU_USER_ID` | 出站 DM 目标 `ou_xxx` |
| `PI_LARK_FEISHU_CHAT_ID` | 出站群/会话 `oc_xxx`（与 USER_ID 互斥） |
| `PI_LARK_REQUIRE_ALLOWLIST` | `true`/`false` |
| `PI_LARK_HUB_CONFIG` | 配置文件绝对路径 |
| `PI_LARK_HUB_URL` | **Bridge** 侧连接 WS（默认 `ws://127.0.0.1:8765`） |
| `PI_LARK_HUB_AUTORESTART` | 更新后发现 loopback Hub 缺最低能力时是否自动重启；默认开，`0` 关闭 |

启动时打印**脱敏**配置摘要（openId 截断）。

### 安全规则

| 模式 | 白名单 | 收件人 |
|------|--------|--------|
| `console` | 空=全部放行（仅开发） | 无（stdout） |
| `lark-cli` | 空=bootstrap（仅「配对 &lt;码&gt;」可过）；有名单则仅名单内 | 有名单时须 `userId` 或 `chatId`；空白名单可缺省，配对后写入 |

**推荐**：`/lark-pair` 完成本人绑定，无需手写 `ou_xxx`。  
Hub **仅监听 127.0.0.1**。

### 本人短码配对

| 步骤 | 动作 |
|------|------|
| 0 | **自动引导**：`lark-cli` 且白名单空时，Pi `register_ok` 后自动 `pair_begin`（每进程一次）；`GET /health` 含 `needsPairing` |
| 1 | 或手动 Pi：`/lark-pair` → 展示 6 位码（5 分钟、用后即废）+ 本地二维码 `~/.pi/lark-hub/pair-qr.png`（载荷=`配对 CODE`，辅助展示） |
| 2 | 飞书本人给机器人发：`配对 XXXXXX`（或 `pair XXXXXX`） |
| 3 | Hub 写入 `allowedOpenIds=[open_id]`、`feishu.userId=open_id`，删除 `chatId` |
| 模拟 | `POST /control/message` body：`{ "text": "配对 XXXXXX", "openId": "ou_…" }` |

协议：`pair_begin` / `pair_challenge` / `pair_result`（见 `src/protocol.ts`）。  
环境变量若覆盖白名单/收件人，重启后可能盖住文件绑定，配对成功回执会提示。

## 启用真实飞书（lark-cli）

### 前置

1. 安装 [lark-cli](https://github.com/) 并完成应用授权（bot）：
   ```bash
   lark-cli auth login --as bot
   lark-cli auth status
   ```
2. 飞书开放平台应用具备：
   - 发消息（`im:message:send_as_bot` 等）
   - 接收消息事件 `im.message.receive_v1`（若需入站）
   - 应用对目标用户可见 / 已建立单聊
3. 写入 config（见上）后：

```bash
npm run hub
# 或
set PI_LARK_FEISHU_MODE=lark-cli
set PI_LARK_FEISHU_USER_ID=ou_xxx
set PI_LARK_ALLOWED_OPEN_IDS=ou_xxx
npm run hub
```

### 出站

Hub 调用：

```bash
lark-cli im +messages-send --as bot --user-id <id> --text <text> --json
# 或 --chat-id
```

子进程环境会带 `LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1` 与 `LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1`，超时约 30s。  
解析 JSON 中的 `message_id`（`om_xxx`）写入绑定表。

**审批**：Phase 5 为**文本 MVP**（含 requestId 前缀与「批准/拒绝」说明），**尚未**发送完整 interactive 卡片 / `card.action.trigger`。可用：

- 飞书回复：`批准 <requestId前缀>`
- 或本机：`POST /control/approval`

### 入站（可选）

`mode=lark-cli` 时后台尝试：

```bash
lark-cli event consume im.message.receive_v1 --as bot
```

- 解析 `sender_id` / `content` / 可选 `parent_id`（作为 `replyToMessageId`）
- 走与 HTTP 相同的 `handleControlMessage`（白名单、列表/使用、路由、审批文本）
- Hub 回复通过 transport 再发回飞书
- **启动失败只告警**，Hub 继续跑；仍可用 curl：

```bash
curl -X POST http://127.0.0.1:8765/control/message ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"列表\",\"openId\":\"ou_xxx\"}"
```

若 event key / 权限不对：`lark-cli event list`、`lark-cli event schema im.message.receive_v1`。

### 回退与降级

| 情况 | 行为 |
|------|------|
| 无 config / mode=console | Console 出站 + HTTP 入站 |
| lark-cli 发消息失败 | notify 失败回 Pi error；不崩溃 |
| event consume 挂掉 | 日志警告；HTTP 仍可用 |
| Hub 未启动 | Bridge 本机 UI 降级（AC9） |

## 启动 Hub

```bash
cd pi-lark-hub
npm install
npm run hub
npx tsx src/hub/cli.ts --port 8765
```

### 健康检查

```bash
curl http://127.0.0.1:8765/health
curl http://127.0.0.1:8765/instances
curl http://127.0.0.1:8765/notifications
curl http://127.0.0.1:8765/approvals
```

## 模拟飞书用户消息（console / 通用）

```bash
# 列表
curl -X POST http://127.0.0.1:8765/control/message ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"列表\"}"

# 设定默认实例
curl -X POST http://127.0.0.1:8765/control/message ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"使用 a3f2\"}"

# 投递纯文本
curl -X POST http://127.0.0.1:8765/control/message ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"检查测试为什么失败\"}"

# 回复某条通知（精确路由）
curl -X POST http://127.0.0.1:8765/control/message ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"继续修复\",\"replyToMessageId\":\"console-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx\"}"
```

白名单启用时请求需带授权 `openId`：

```bash
curl -X POST http://127.0.0.1:8765/control/message ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"列表\",\"openId\":\"ou_xxxxxxxxxxxxxxxx\"}"
```

## Phase 3：审批

危险 bash → Hub `ApprovalStore` → 出站（console 打印 curl / lark-cli 文本）→ `POST /control/approval` 或文本「批准/拒绝 &lt;前缀&gt;」。

```bash
curl http://127.0.0.1:8765/approvals
curl -X POST http://127.0.0.1:8765/control/approval ^
  -H "Content-Type: application/json" ^
  -d "{\"requestId\":\"m1n2-xxxx-yyyy\",\"decision\":\"approve\",\"openId\":\"ou_xxx\"}"
```

状态机：`pending → approved|rejected|timeout|failed_delivery`；二次回调幂等；离线不改投。

## 加载 Bridge

```bash
# 默认扩展入口（install 本包后自动加载）
pi -e ./src/index.ts
# 或显式 bridge
pi -e ./src/lark-bridge/index.ts
```

| 变量 | 默认 |
|------|------|
| `PI_LARK_HUB_URL` | `ws://127.0.0.1:8765` |

Pi 内：`/lark-status`、`/lark-ask [prompt]`、`/lark-pair`（本人短码配对）。

远程文本 **禁止** `deliverAs: "followUp"`。

## 路由规则

| 场景 | 结果 |
|------|------|
| 审批 / requestId | 精确 piId |
| 回复已绑定 messageId | 精确；未绑定/离线 fail-closed |
| 仅 1 在线 | 自动默认并投递 |
| 多在线有默认 | 投递默认 |
| 多在线无默认 | 不投递，返回列表 |
| `列表` / `使用` | Hub 本地 |
| 未授权 openId | 拒绝 |

## 目录

```text
src/protocol.ts
src/hub/config.ts              配置合并与校验
src/hub/config.test.ts
src/hub/feishu-transport.ts    Console / Noop
src/hub/feishu-lark-cli.ts     lark-cli 出站
src/hub/feishu-inbound.ts      event consume 入站
src/hub/feishu-lark-cli.test.ts
src/hub/registry.ts / router.ts / bindings.ts / approvals.ts / control.ts
src/hub/server.ts / cli.ts
src/lark-bridge/index.ts
```

## 路线图

| 阶段 | 内容 | 状态 |
|------|------|------|
| 0–1 | 骨架、注册、列表/使用 | ✅ |
| 2 | task_end + 回复绑定 | ✅ |
| 3 | 审批幂等 | ✅ |
| 4 | need_reply `/lark-ask` | ✅ |
| 5 | 配置硬化、lark-cli 出站、可选入站 | ✅ |
| 后续 | interactive 卡片 + `card.action.trigger` | 待做 |

## 验证

```bash
npm run typecheck
npm test
npm run hub
```

单元测试**不**要求安装 lark-cli（mock 子进程）。
