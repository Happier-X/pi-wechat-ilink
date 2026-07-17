# pi-lark-hub

本机 **multi-Pi 飞书远程控制**：`pi-lark-hub` 守护进程 + `lark-bridge` Pi 扩展。

用飞书（或 console 模拟）对多个同时运行的 Pi 会话：

- 注册 / 默认路由 / 列表·使用
- 任务结束通知与按消息绑定回复
- 危险 bash 远程审批
- 显式 need_reply（`/lark-ask`）

> **仓库名**：文档与 `package.json` 已按 **`pi-lark-hub`** 书写。若 GitHub 远端仍显示旧名（如 `pi-wechat-ilink` / `pi-lark`），请在 GitHub Settings → Rename，并自行更新 `git remote`。本仓库**不会**代你改 remote。

## 架构

```text
Pi A (lark-bridge) ──┐
                     │  WebSocket 127.0.0.1
Pi B (lark-bridge) ──┼──► pi-lark-hub
                     │       ├── 注册 / 心跳 / 默认路由
                     │       ├── messageId → piId 绑定
                     │       ├── 审批状态机（幂等 / 超时）
                     │       ├── notify → Console 或 lark-cli 出站
                     │       └── POST /control/*（始终可用）
用户（curl / 飞书）──┘
```

详细配置、安全规则与 curl 验收见 [docs/lark-hub.md](./docs/lark-hub.md)。

## 安装

### 本地开发

```bash
pi install C:/code/pi-lark-hub
# 或相对路径
pi install .
```

或写入 `~/.pi/agent/settings.json`：

```json
{
  "packages": [
    "C:/code/pi-lark-hub"
  ]
}
```

### npm（发布后）

```bash
pi install npm:pi-lark-hub
```

### 快速加载（不 install）

```bash
# 默认扩展入口 = lark-bridge（src/index.ts re-export）
pi -e .
# 或显式
pi -e ./src/lark-bridge/index.ts
```

然后重启 Pi 或 `/reload`。

## 快速开始

### 1. 启动 Hub

```bash
npm install
npm run hub
# 或全局 bin：pi-lark-hub
```

Hub **仅监听 `127.0.0.1`**（默认端口 `8765`）。

### 2. 加载 Bridge

安装本包后，默认 `pi.extensions` 会加载 lark-bridge。也可：

```bash
pi -e ./src/index.ts
```

Pi 内命令：

```text
/lark-status          Hub 连接与 piId
/lark-ask [prompt]    显式请求飞书/远程回复（need_reply）
```

### 3. console 模式验收（无需飞书）

```bash
curl http://127.0.0.1:8765/health
curl http://127.0.0.1:8765/instances
curl -X POST http://127.0.0.1:8765/control/message ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"列表\"}"
```

更多：`/notifications`、`/approvals`、`POST /control/approval`，以及 `replyToMessageId` 精确回复，见 [docs/lark-hub.md](./docs/lark-hub.md)。

### 4. 真实飞书（opt-in）

需本机已安装并授权的 `lark-cli`，且配置白名单与收件人：

```bash
# 环境变量示例（Windows cmd）
set PI_LARK_FEISHU_MODE=lark-cli
set PI_LARK_FEISHU_USER_ID=ou_xxx
set PI_LARK_ALLOWED_OPEN_IDS=ou_xxx
npm run hub
```

或写 `~/.pi/lark-hub/config.json`（字段见 docs）。`lark-cli` 模式**强制**非空 allowlist，且必须 `userId` 或 `chatId`。

## 路由规则摘要

| 场景 | 结果 |
|------|------|
| 审批 `requestId` | 精确到创建审批的 `piId`；离线不改投 |
| `replyToMessageId` 已绑定 | 精确投递；未绑定/离线 fail-closed |
| 纯文本 + 单在线 | 自动默认并投递 |
| 纯文本 + 多在线无默认 | 不投递，返回列表；可用「使用 &lt;id&gt;」 |
| `列表` / `使用` | Hub 本地处理 |

远程文本必须 `pi.sendUserMessage(text)`，**禁止** `deliverAs: "followUp"|"steer"`。忙时走扩展 FIFO，在 `agent_settled` 后 drain。

## 开发

```bash
git clone https://github.com/Happier-X/pi-lark-hub.git
cd pi-lark-hub
npm install
npm run typecheck
npm test
npm run hub
```

若 clone 的仍是旧仓名目录，以本地路径为准；GitHub Rename 后请同步 remote。

## 目录

```text
src/index.ts              # re-export lark-bridge
src/lark-bridge/index.ts  # 唯一 Pi 扩展实现
src/protocol.ts           # Hub ↔ Pi WebSocket 协议
src/hub/**                # pi-lark-hub 守护进程
scripts/pi-lark-hub.mjs
docs/lark-hub.md
```

## 安全

- Hub 仅 loopback；勿对公网暴露
- `lark-cli` 必须白名单；console 空白名单仅限本地开发
- 审批超时默认拒绝；离线审批不改投其他 Pi
- 能给 bot 发消息的人即可注入当前 Pi 会话任务——控制飞书可见范围

## License

MIT
