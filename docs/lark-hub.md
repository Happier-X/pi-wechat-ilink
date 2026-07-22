# 飞书原生 Hub

`pi-lark-hub` 是只监听 loopback 的本机守护进程。飞书侧只支持原生 OpenAPI + 官方 WebSocket，不提供其他运行模式。

## 开局

1. 在 Pi 执行 `/lark`。
2. Hub 调用飞书 PersonalAgent registration 的 init、begin、poll。
3. Bridge 将 `verification_uri_complete` URL 写入 `~/.pi/lark-hub/setup-qr.png`，尽力系统打开，并同时展示可复制 URL。
4. 用户用飞书扫描。
5. Hub 获取 app 凭证和用户 open_id，查询 bot open_id；只有非空且不同的用户 open_id 才可信。
6. Hub 启动候选 WebSocket，确认 connected 后写入凭证和唯一主人配置并热切换。

可信主人校验、网络、轮询或 WebSocket 任一步失败，候选运行时会停止，现有运行时与文件不被替换。

已有凭证时 `/lark` 只显示并确保原生运行时状态，不重复注册。

诊断：在 Pi 执行 `/lark status`，或在飞书对机器人发送 `状态` / `status`，可查看脱敏后的版本、绑定、凭证落盘时间、在线 Pi、待审批数与修复建议。

队列（当前默认 Pi 的 Bridge FIFO，不取消正在执行的任务）：

- 飞书：`队列` / `取消 <id>` / `清空队列`
- Pi：`/lark queue` · `/lark cancel <id>` · `/lark clear-queue`

## HTTP 控制面（本机）

- 默认仅 loopback。可选环境变量 `PI_LARK_HUB_CONTROL_TOKEN`（或配置 `control.token`）：配置后除 `GET /health` 外需 `Authorization: Bearer <token>` 或 `X-Lark-Hub-Token`。
- 请求体默认上限 64KB（`PI_LARK_HUB_BODY_MAX_BYTES`）；超限返回 413。
- 固定窗口限流默认 60 次/分钟（`PI_LARK_HUB_RATE_LIMIT` / `PI_LARK_HUB_RATE_WINDOW_MS`）；超限 429。
- `/instances`、`/notifications`、`/approvals` 响应会截断长 body 并脱敏 secret 字段名。

## 重置

执行 `/lark reset`：

- 中止进行中的 registration；
- 停止原生 WebSocket；
- 删除独立 credentials 文件；
- 清除 config 中飞书运行字段、主人白名单与收件人；
- 下一次 `/lark` 重新扫码。

## 文件与环境变量

| 项目 | 默认值 |
|---|---|
| Hub 配置 | `~/.pi/lark-hub/config.json` |
| 原生密钥 | `~/.pi/lark-hub/credentials.json` |
| 授权二维码 | `~/.pi/lark-hub/setup-qr.png` |
| Hub 地址 | `127.0.0.1:8765` |

可覆盖：`PI_LARK_HUB_CONFIG`、`PI_LARK_HUB_CREDENTIALS`、`PI_LARK_HUB_PORT`、`PI_LARK_HUB_URL`、`PI_LARK_HUB_AUTOSTART`、`PI_LARK_HUB_AUTORESTART`。

密钥文件尽量使用 `0600`；app secret 不写入 config、日志或通知。

## 出站渲染

任务结束、审批等 `notify` 统一经 `NativeFeishuTransport.send`：优先发送 `msg_type=interactive` 卡片（header 放 title，body 用多个 markdown 模块渲染表格/代码块/列表），失败自动降级 `msg_type=text`；长正文在同一卡片内分段，超过单卡消息体限制时顺序拆成多张带“第 i/N 部分”标识的卡片，纯文本降级同样分批且不静默丢失正文；绑定使用全部批次成功后的首条真实 `message_id`。

## 协议

Pi → Hub：`register`、`heartbeat`、`notify`、`unregister`、`lark_open`、`lark_reset`。

Hub → Pi：`register_ok`、`notify_ack`、`user_message`、`approval_result`、`error`、`lark_challenge`、`lark_result`。

## 安全边界

- HTTP 与 WebSocket 控制面只接受 loopback。
- 飞书事件通过官方 WebSocket 的出站连接进入本机，无公网监听。
- 飞书入站必须匹配唯一主人 open_id；未完成开局时全部拒绝。
- 不允许首个私聊用户自助成为主人。
