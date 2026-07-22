# Multi-Pi 飞书原生 Hub 合约

## 范围

本机 `pi-lark-hub` 协调多个 Pi，会话可接收唯一飞书主人的文本、任务结束通知回复和危险命令审批。Hub 只监听 loopback，飞书事件由官方 WebSocket 出站连接接收。

## 命令

Pi 只注册：

- `/lark`：无凭证时执行 PersonalAgent 官方扫码；有凭证时确认原生连接。
- `/lark reset`：停止原生运行时并删除凭证、飞书配置、主人绑定。

禁止恢复其他飞书命令或兼容运行模式。

## 协议

Pi → Hub：`register`、`heartbeat`、`notify`、`unregister`、`lark_open`、`lark_reset`、`approval_result_ack`。

Hub → Pi：`register_ok`、`notify_ack`、`user_message`、`approval_result`、`error`、`lark_challenge`、`lark_result`。

- 同一 Pi 扩展生命周期内重连应在 `register` 携带上次 `piId`。
- Hub 发送 `approval_result` 后，仅在收到对应 `approval_result_ack` 时 `markDelivered`；未 ack 前允许向原 piId 重投，禁止改投。

Hub features 必须包含 `lark_open` 与 `lark_reset`。

### 运行时解码

- 入站必须使用 `decodePiToHubMessage` / `decodeHubToPiMessage`（或等价严格解码），不得仅凭 `type` 字符串强制断言。
- 校验必填字段、枚举、有限数字、方向与字段长度上限（见 `PROTOCOL_LIMITS`）。
- 解码失败：Hub 回 `error` 且不崩溃；Bridge 忽略业务副作用，不改变连接身份。
- 错误文案使用中文稳定描述，不回显完整正文或 secret。

## 开局事务

1. registration init/begin/poll，二维码载荷为 `verification_uri_complete` HTTPS URL。
2. 必须获得非空 owner open_id，并成功查询 bot open_id，二者必须不同。
3. 候选 `NativeFeishuWsInbound` 必须达到 connected。
4. 原子写 `credentials.json` 与 `mode=native`、唯一主人 `allowedOpenIds/userId`。
5. 切换 transport/inbound，再停止旧 runtime。

失败必须停止候选 runtime，不替换旧运行时或文件。secret 不进入 config、日志、协议回执。

## 重置事务

中止 registration、停止 WS、删除 credentials、清除 config 的 `feishu`、`allowedOpenIds`、`requireAllowlist`，并将内存 transport 置为不可发送状态。

## 出站

- 全部 `notify` 出站优先 `msg_type=interactive` 卡片 Markdown（header=title，elements 为按组件限制分段的 markdown）；失败降级 `msg_type=text`。
- 长正文在同一张卡片内分段；若超过飞书消息体限制，则顺序发送多张带“第 i/N 部分”标题的卡片。纯文本降级同样分批，正文不得静默截断。
- 绑定使用全部批次成功后第一条消息的真实 `message_id`（卡片成功用首条卡片 id，降级 text 用首条 text id）。
- 相同 `piId+requestId+event` 的 notify 必须幂等：内容一致则重放返回原 `messageId` 且不重复调用飞书；内容冲突则拒绝。Bridge 对 notify 等待 `notify_ack`，超时有限重试，重连后重放未确认项。

## 路由

- 飞书入站 open_id 必须等于唯一主人；空名单全部拒绝。
- 回复已绑定 message_id 时精确投递，目标离线或绑定缺失时 fail-closed。
- 单 Pi 自动默认；多 Pi 无默认提示选择；`列表`、`使用 <id|名称>` 由 Hub 处理。
- 远程文本必须调用 `pi.sendUserMessage(text)`；忙时使用扩展 FIFO。
- 审批按 requestId 精确投递并保持幂等，禁止离线改投。
- 审批卡片可含批准/拒绝按钮；回调 `card.action.trigger` 经长连接接收，operator open_id 必须过主人鉴权；文本「批准/拒绝」命令保留。
- 诊断：飞书文本「状态/status」与 Pi `/lark status` 输出脱敏 Hub 摘要；禁止 secret 与完整 openId。
- HTTP 控制面可配置 control token（`/health` 除外）、body 上限与限流；诊断接口脱敏。不得因 token 而监听非 loopback。
- Bridge 用户消息 FIFO 有容量与条目 id；飞书 `队列/取消/清空队列` 经 `queue_control` 投递到路由选定的 Pi，结果经 `queue_report` 回传；不可取消已开始执行的 run。

## 文件

- 配置：`~/.pi/lark-hub/config.json`，可由 `PI_LARK_HUB_CONFIG` 覆盖。
- 密钥：`~/.pi/lark-hub/credentials.json`，可由 `PI_LARK_HUB_CREDENTIALS` 覆盖，尽量使用 `0600`。
- 二维码：`~/.pi/lark-hub/setup-qr.png`。

## 验证

`npm run typecheck`、`npm test`、`git diff --check` 必须通过。
