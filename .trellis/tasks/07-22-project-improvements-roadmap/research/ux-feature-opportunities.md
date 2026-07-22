# 用户体验与新功能机会研究

## 1. 当前用户路径与事实基线

### 飞书开局

- Pi 侧只注册 `/lark` 和 `/lark reset`，见 `src/lark-bridge/index.ts:643-653`；参数不是 `reset` 时直接返回用法提示。
- `/lark` 通过 Hub 消息 `lark_open` 发起开局，二维码通过 `lark_challenge` 回到 Pi，扩展会生成二维码图片并打开本地路径，见 `src/lark-bridge/index.ts:313-316`。
- Hub 成功开局后通过 `lark_result` 返回状态，且原生飞书传输必须绑定唯一主人；当前能力模型没有把“连接状态/诊断”作为用户命令暴露出来。

### 多 Pi 路由

- Hub 是路由单一事实源。纯文本路由规则是：0 个在线提示；1 个在线自动设默认；多个在线且默认在线则投递默认；多在线无默认或默认离线则不投递并要求选择，见 `src/hub/router.ts:2-6, routePlainText`。
- 已有 `列表/list/ls/在线` 和 `使用/use/switch <query>` 解析，见 `src/hub/router.ts:126-136`；用户列表行只有名称、piId、idle/busy、默认标记和 cwd，见 `formatInstanceLine`。
- 回复飞书消息时优先使用 `messageId -> piId/requestId` 绑定，目标离线或绑定失效均 fail-closed，不改投默认，见 `src/hub/control.ts:175-224`。这是可靠性约束，后续 UX 不能用“自动改投”换取表面易用。

### 审批

- Pi 发现危险 bash 后生成 requestId，发送 `notify`，带 `actions: ["approve", "reject"]` 和超时，见 `src/lark-bridge/index.ts:553-588`；目前正文中仍显示模拟 HTTP 调用示例，按钮动作没有真正渲染。
- Hub 收到审批通知先创建 `ApprovalStore` 记录，再调用可选的 `sendApprovalCard`，否则走普通 `send`，成功后写 message binding 并回 `notify_ack`，见 `src/hub/server.ts:216-279`。
- `feishu-native.ts` 当前只构造 interactive 卡片的 header/markdown elements，未使用 `actions`；卡片失败再降级 text，见 `src/hub/feishu-native.ts:74-116` 和 `src/hub/feishu-outbound-format.ts:92-136`。
- 审批状态机已有 pending、approved、rejected、timeout、failed_delivery，以及 `deliveredToPi` 幂等保护；离线审批不会改投其他实例，见 `src/hub/approvals.ts:7-29, 177-258`。这使“按钮回调”和“失败重试”可以在现有状态机上增量实现。

### Bridge 队列与通知

- Bridge 使用进程内 FIFO `queue: QueuedTask[]`；Pi 忙时消息入队，空闲后 `tryDrainQueue` 取出一条并调用 `pi.sendUserMessage`，见 `src/lark-bridge/index.ts:128-225`。
- 当前没有队列容量、查看、取消、持久化或飞书侧队列命令；任务结束通知有 `requestId`，但 `notify_ack` 只写入 `lastNotifyAck`，没有超时/失败处理，见 `src/lark-bridge/index.ts:133, 244-290`。
- Hub 的 `/health` 已提供 online、defaultPiId、bindingCount、pendingApprovals 等基础摘要；`/instances`、`/notifications`、`/approvals` 可读数据，但均是诊断 HTTP 接口而非飞书用户体验，见 `src/hub/server.ts:477-526`。

## 2. MVP 机会排序

### P0-MVP：审批卡片按钮与幂等回调

**用户价值**：危险命令是最需要远程遥控的路径。按钮把“复制 requestId + 文本命令/HTTP”缩减为飞书卡片一键批准/拒绝，降低误操作和延迟；仍保留文本审批作为兼容路径。

**代码依据**：`NotifyMessage.actions` 已有审批动作类型（`src/protocol.ts:12`）；Pi 已发送 actions（`src/lark-bridge/index.ts:578-588`）；Hub 已有 `sendApprovalCard` 分支和 `ApprovalStore.decide/markDelivered`（`src/hub/server.ts:251-268`, `src/hub/approvals.ts:181-258`）；缺口是卡片 action 渲染、回调解析和 action 到现有 `handleInboundApproval` 的接线。

**MVP 边界**：

1. 仅支持 `approval` 事件的两个按钮：批准、拒绝。
2. 按钮 value 至少包含 requestId、decision，并带版本/动作标识；服务端必须从回调上下文得到 actor open_id，重新走已有可信主人鉴权。
3. 回调重复提交走现有 deliveredToPi 幂等语义；requestId 不存在、已处理、Pi 离线都返回可读结果。
4. 成功/失败反馈优先更新或回复原卡片；文本命令 `批准/拒绝 <requestId前缀>` 不删除。
5. 卡片发送失败仍允许现有 text 降级，但不得因降级重复执行审批。

**依赖**：飞书原生卡片 action 回调所需的 WebSocket 事件/回调字段确认；`FeishuTransport.sendApprovalCard` 接口实现；入站解析需能区分普通文本与 action；现有 `ApprovalStore`、`MessageBindingStore` 和唯一主人鉴权。

**风险**：回调 payload 结构不完整会造成误判；不能信任按钮内的 open_id，必须信任 SDK 事件中的 sender；重复回调可能导致重复执行；卡片多批次发送只能绑定明确的首条或可回调消息 ID；任何异常必须 fail-closed。

**验收标准**：按钮卡片含两个可点击 action；可信主人点击后在线目标 Pi 只收到一次对应结果；非主人、未知 requestId、重复点击、超时和离线目标均有明确结果且不改投其他 Pi；text 审批测试继续通过；新增 fake 回调/端到端测试覆盖上述矩阵。

**明确不做**：不支持任意飞书用户审批、不增加公网 webhook 为必需条件、不支持批量审批/自动批准规则、不改变超时默认拒绝、不改投其他 Pi。

### P1-MVP：`/lark status` 诊断与多 Pi 状态卡片

**用户价值**：当前用户只能从扩展通知或发送“列表”了解有限状态；首次开局失败、Hub 断线、主人未绑定时，缺少一条可操作的总览。状态命令可减少“是否已连接、当前 Pi 是谁、为何没有响应”的排查成本。

**代码依据**：Hub `/health` 已有版本、端口、默认 Pi、在线实例、绑定数、待审批数、主人绑定状态（`src/hub/server.ts:477-503`）；`列表/使用` 已有纯文本控制分支（`src/hub/control.ts:115-149`）；Bridge 已维护 `connected`、`piId`、Hub 断线通知和自动重连状态（`src/lark-bridge/index.ts:120-126, 350-451`）。现状缺少用户可调用的 status 命令及稳定状态文案。

**MVP 边界**：

1. 飞书文本命令 `状态/status` 在 Hub 本地处理，不投递 Pi。
2. 返回飞书连接（已绑定/未绑定/连接异常）、在线 Pi 数量、默认 Pi、每个 Pi 的 idle/busy、最近心跳年龄、队列数（若能安全提供）、待审批数和建议动作。
3. `列表` 改成信息密度适中的状态卡片或结构化文本；保留 `使用 <piId|项目名>`。
4. 只展示脱敏 cwd/项目名，不展示 app_secret、凭证内容或完整危险命令。
5. 先复用 `/health` 的状态来源，避免 Bridge 和 Hub 各自维护第二套路由真相。

**依赖**：控制命令解析扩展；状态汇总函数；如采用卡片，需要复用 interactive 卡片格式；若直接从飞书入站处理，需确保鉴权后才返回诊断。

**风险**：状态是瞬时快照，不能承诺任务完成；cwd 可能含敏感路径；最近心跳展示必须避免误导（服务端时间/心跳超时规则以 registry 为准）；状态卡片过长时需要分段。

**验收标准**：单 Pi、多 Pi 无默认、默认离线、Hub 未开局、待审批存在和无在线实例时均输出清晰可行动结果；状态命令不进入 Pi FIFO；非可信主人不能读取实例/审批摘要；保留旧 `列表`、`使用` 行为并通过路由测试。

**明确不做**：不做远程 Hub 管理、不改变 loopback 监听、不暴露 secret、不提供公网监控面、不在 MVP 自动重启 Pi 或自动切换默认 Pi。

### P1-MVP：队列查看与取消（按 Pi、按 request/message 维度）

**用户价值**：忙碌 Pi 上的远程指令会静默排队，用户只能看到扩展本地提示；长队列可能造成过时指令执行。查看和取消能让远程控制具备基本可控性。

**代码依据**：队列是 `const queue` 的进程内数组，入队只增加 `text/source/enqueuedAt`，无 ID；消费在 `tryDrainQueue` 中直接 `shift`，见 `src/lark-bridge/index.ts:128-225`。Hub 下发 `UserMessage` 只有文本、来源和可选 replyToRequestId，见 `src/protocol.ts:20`，因此取消目前无法准确指向一条队列项。

**MVP 边界**：

1. 先增加服务端生成的 queue item ID 或 requestId，再支持 `队列` 查看和 `取消 <id>`；不要用文本匹配取消。
2. 查看默认 Pi 或指定 `piId` 的排队项，展示序号、短摘要、入队时间、来源；完整正文不回显到飞书。
3. 取消只允许取消尚未开始消费的项；已进入 `pi.sendUserMessage` 的项不可撤回。
4. Pi 断线时队列默认清空或明确标记失败，必须选择一种并写测试；MVP 不做跨重启恢复。
5. 队列有容量上限，超限时拒绝新消息并说明原因。

**依赖**：协议新增可选 queue/request 字段；Bridge 队列项状态与 ID 管理；Hub 需能按 piId 转发控制消息，或将控制动作作为 Hub 本地操作；与可靠通知 requestId 语义区分清楚。

**风险**：并发取消与消费竞态；用户误取消正在执行的命令；队列文本可能包含隐私；多 Pi 指定不清会造成错操作。取消必须 fail-closed，不能跨 Pi 取消。

**验收标准**：两条排队消息有稳定唯一 ID；列表可见且脱敏；取消唯一项后不调用 `pi.sendUserMessage`；并发“取消/开始消费”结果可预测；满载、断线、空队列、未知 ID、多 Pi 场景有测试。

**明确不做**：不做执行中断、不做跨 Hub 队列、不做队列持久化、不做按关键词模糊取消、不自动重新排序。

### P1-MVP：通知状态查询与失败重试入口

**用户价值**：任务结束通知或审批卡片发送失败时，用户当前无法知道是否真正送达；Hub 只给 Pi `notify_ack`，Bridge 只保存一个 `lastNotifyAck`。有限历史与显式重试可以降低“以为发出但没收到”的风险。

**代码依据**：`notify_ack` 只更新 `lastNotifyAck`（`src/lark-bridge/index.ts:286-292`）；Hub 在飞书发送成功后绑定并回 ack，失败仅发 `error`（`src/hub/server.ts:216-279`）；`/notifications` 返回绑定和 transport history，但没有统一 delivery 状态、错误、批次关联，见 `src/hub/server.ts:505-512`。

**MVP 边界**：

1. 每个 notify 记录 requestId、piId、event、发送状态、messageId、createdAt、错误摘要、批次信息，设置容量/TTL。
2. 提供状态查询（优先飞书 `通知 <requestId前缀>`，或先扩展 `/notifications`）和有限次显式重试。
3. 重试只针对同一个 requestId/目标 Pi 的出站通知；审批重试必须复用审批状态机，绝不创建第二个审批。
4. 发送“部分批次”时记录已成功的 messageId，避免重新发送完整正文导致重复；默认不自动无限重试。

**依赖**：统一 delivery record；`NotifyAckMessage` 扩展状态/批次字段或 Hub 本地状态；Feishu transport 错误分类；审批状态机幂等处理。

**风险**：飞书 API 超时后实际已送达，盲目重试会重复消息；重试 task_end 可产生噪音；历史正文可能泄露隐私或无限增长。应优先展示状态和错误摘要，正文脱敏/限长。

**验收标准**：成功、失败、卡片降级、长消息多批次、连接断开、重复 requestId、显式重试均产生可查询且一致的状态；审批重试最多让目标 Pi 执行一次；容量和 TTL 生效；secret 与完整敏感正文不入历史。

**明确不做**：不做自动无限重试、不保证跨进程重启后恢复（除非另立持久化子任务）、不做消息撤回、不把失败通知改投其他 Pi。

### P2-MVP：未决审批和消息绑定的轻量恢复

**用户价值**：Hub 重启会丢失 `ApprovalStore`、`MessageBindingStore`；正在等待危险命令时，用户可能看到旧卡片但无法完成审批，任务也会卡到 Pi 本地超时。轻量恢复能提升连续性，但应排在按钮与诊断之后。

**代码依据**：`ApprovalStore.records/timers` 与 `MessageBindingStore.bindings` 都是内存 Map（`src/hub/approvals.ts:76`, `src/hub/bindings.ts:22`）；Hub 关闭时明确 `approvals.clear()`，见 `src/hub/server.ts:676-679`；而 Pi 审批本地仍在等待，session shutdown 才清理并超时拒绝，见 `src/lark-bridge/index.ts:476-493`。

**MVP 边界**：只持久化未决审批、必要的 message binding 元数据和 schema/version；启动时恢复未过期记录并重建定时器；恢复失败/版本不兼容时安全清空并记录可操作诊断；不持久化 secret、完整命令正文或可直接执行的决策。

**依赖**：原子文件工具、版本化 schema、TTL/过期策略、Pi 重连后的 requestId 对账机制；最好先完成通知状态模型。

**风险**：重启期间 Pi 可能已超时或本地决策，恢复后重复发送；持久化危险命令正文扩大隐私风险；文件损坏导致 Hub 无法启动。默认应恢复为 pending 但要求目标 Pi 身份精确匹配，并在不确定时 fail-closed。

**验收标准**：重启后未过期审批可查询；过期审批自动拒绝且最多向原 Pi 投递一次；绑定仍能精确路由；损坏/旧版本文件不阻塞 Hub；恢复测试覆盖崩溃写入、重复 requestId、Pi 离线和 TTL。

**明确不做**：不做跨机器共享状态、不做凭证持久化改造、不做完整对话历史、不做恢复后自动改投、不绕过 Pi 本地审批生命周期。

## 3. 推荐实施顺序与依赖图

1. **审批卡片按钮**：现有协议字段、状态机、卡片发送抽象已具备，直接解决核心遥控场景。
2. **状态命令/状态卡片**：复用现有 health、registry、bindings、approvals，风险较低，可作为按钮 MVP 的运维配套。
3. **队列查看/取消**：先补 queue item ID 和容量，再开放命令；避免在没有稳定标识时做文本模糊取消。
4. **通知状态/重试**：需要先定义 requestId、批次和“API 超时但可能送达”的语义；建议与审批按钮一起设计但可独立交付。
5. **轻量持久化恢复**：依赖稳定的通知/审批状态模型和重连对账，最后实施。

推荐的最小首个子任务是“审批卡片按钮回调与幂等验收”，不要把状态、队列和持久化打包成一个大改动。

## 4. 全局产品约束

- 继续仅监听 loopback，不把公网回调作为必需依赖。
- 唯一可信飞书主人鉴权必须覆盖普通文本、状态查询、审批按钮和队列操作。
- 审批默认超时拒绝；目标 Pi 离线时不改投其他 Pi。
- Hub 保持路由单一事实源；回复绑定优先级不可被“状态优化”破坏。
- 所有展示默认限长、脱敏；secret、token 和完整敏感正文不得进入日志、状态摘要、协议回执或长期历史。
- 每个功能独立验收，先做纯函数/状态机测试，再补真实 HTTP/WS/飞书事件夹具；不要只依赖手工 curl。
