# 可靠性、安全性、协议边界与测试缺口审查

## 审查范围与结论

本次只读审查重点覆盖：

- `src/protocol.ts`
- `src/hub/server.ts`
- `src/hub/approvals.ts`
- `src/hub/control.ts`
- `src/hub/bindings.ts`
- `src/hub/registry.ts`
- `src/hub/feishu-native.ts`
- `src/lark-bridge/index.ts`
- 当前测试文件与 `package.json`

总体判断：项目已有较好的 loopback 限制、主人白名单、回复绑定失败关闭、审批超时拒绝和部分单元测试基础，但协议运行时边界、通知幂等/确认、重连身份连续性、审批投递确认与 HTTP 控制面仍存在必须优先处理的可靠性和安全缺口。

---

# P0：必须优先处理

## P0-1：协议解析只有类型断言，畸形输入可直接进入业务分支

### 现状证据

- `src/protocol.ts:10-25` 定义了完整的 TypeScript 协议联合类型，但这些类型只在编译期生效。
- `src/protocol.ts:30` 的 `parseProtocolMessage` 仅验证 JSON 是对象且 `type` 是字符串，随后直接断言为 `ProtocolMessage`。
- `src/hub/server.ts:352-359` 使用该解析结果进入消息分派。
- `src/hub/server.ts:361-424` 的注册和心跳分支直接调用 `trim()`、读取枚举和数组字段；例如畸形的 `piId`、`capabilities`、`status` 会越过协议边界。
- `src/hub/server.ts:426-429` 将消息直接断言为 `NotifyMessage`，再交给异步通知处理。
- `src/lark-bridge/index.ts:274-306` 对 Hub 下行消息使用同一个宽松解析器，并直接访问 `piId`、`requestId`、`text`、`decision` 等字段。
- 当前测试中没有 `parseProtocolMessage` 的畸形输入、缺字段、未知枚举、超长字段或方向错误消息测试；测试搜索也未发现协议解析测试文件。

### 风险

- `register.piId` 若不是字符串，`m.piId.trim()` 可抛出异常；WebSocket `message` 监听器没有包裹该同步异常，可能造成进程级未处理异常。
- 非法 `status`、`event`、`decision`、`source` 和 `capabilities` 可污染注册表、触发错误路由或绕过预期状态机分支。
- 缺失或超长 `title/body/text/cwd` 会造成运行时异常、日志膨胀、内存压力或向飞书发送非预期内容。
- Hub 与 Bridge 都不能区分“语法错误”“未知消息类型”“字段错误”和“消息方向错误”，故障定位困难。

### 建议

1. 为 Pi→Hub 和 Hub→Pi 分别实现运行时解码器，不再返回宽泛的 `ProtocolMessage`。
2. 按 `type` 校验必填字段、字符串非空、数字有限且有界、枚举值、数组成员和消息方向。
3. 增加明确上限，例如：协议帧、`title`、`body/text`、`cwd/displayName`、`requestId/piId`、`capabilities/actions` 数量。
4. 解码失败返回稳定错误码和脱敏提示，不回显完整正文。
5. 若引入协议字段或版本字段，同步发送端、接收端、测试和 Trellis 协议规格。

### 验收方式

- 表驱动测试覆盖每种消息的合法最小输入和以下非法输入：缺字段、错误类型、未知枚举、`NaN/Infinity` 等非法数值语义、空字符串、超长字符串、超大数组、未知类型、方向错误消息。
- 通过真实 WebSocket 发送畸形帧，Hub 不崩溃，返回可识别错误，连接关闭策略符合设计。
- Bridge 收到畸形 Hub 下行时不改变 `piId/connected`、不执行审批、不入队用户消息。

---

## P0-2：重复或并发 `notify` 没有 requestId 幂等保护，会重复发送飞书消息

### 现状证据

- `src/hub/server.ts:216-281` 每次收到 `notify` 都会调用飞书发送接口并创建绑定，没有“处理中/已发送/失败”的 requestId 状态表。
- `src/hub/server.ts:426-429` 对 `handleNotify` 使用 `void` 启动；同一连接上的多个通知可并发执行，且没有单飞锁或每 requestId 串行化。
- `src/hub/approvals.ts:108-133` 仅在已有记录为非 `pending` 时返回旧记录；重复的 pending 审批会清掉旧定时器、重新创建记录并覆盖 `piId/title/body/createdAt`。
- 即使 `ApprovalStore.create` 返回既有终态，`src/hub/server.ts:240-276` 仍继续向飞书发卡、重绑消息并发送新的 ack。
- `task_end` 通知没有任何去重存储。
- `src/hub/feishu-transport.ts:19-28` 的 transport 契约没有幂等键或批次结果语义。
- 当前没有 Hub 服务级“相同 requestId 重复 notify”“并发相同 requestId”“不同 Pi 冲突 requestId”测试。

### 风险

- Bridge 或网络层重试后，主人可能收到多张相同任务结束卡片或审批卡片。
- 两个 Pi 复用同一 requestId 时，pending 审批记录可能被后到消息改写到另一个 Pi，破坏“审批只回原 Pi”的核心边界。
- 同一审批的多张卡片可能产生冲突操作；虽然决策状态机对已投递结果有一定幂等保护，但卡片和绑定本身已经重复。
- 并发调用可能出现后完成请求覆盖 `messageId`，历史与真实首张卡片不一致。

### 建议

1. Hub 建立以 `(piId, requestId, event)` 或全局 requestId 加不可变归属为键的通知状态机：`received → sending → sent/acked | failed`。
2. 首次接收后锁定 `piId/event/payloadHash`；同键同内容重放返回原 `messageId`，同 requestId 不同归属或内容返回冲突错误。
3. 同一键发送采用单飞 Promise，避免并发调用 transport。
4. `ApprovalStore.create` 对 pending 重复应返回明确结果，不得静默重置超时或改写 Pi 归属。
5. 将飞书侧可用的幂等 UUID/请求标识纳入 transport；若 SDK 接口不支持，则至少由 Hub 本地状态阻止重复调用。

### 验收方式

- 同一连接串行发送两次相同 notify，只产生一次 transport 调用，两次得到同一 messageId。
- 并发发送 20 次相同 notify，只产生一次 transport 调用。
- 同 requestId 但不同 piId、event 或正文返回冲突，不覆盖原审批。
- Hub 重连后重放已发送通知时不生成第二张卡片；若本期不做重启持久化，需明确验收只保证单进程生命周期，并把重启恢复列为依赖任务。

---

## P0-3：Bridge 没有可靠发送队列，`notify_ack` 被记录但不参与确认、超时或重试

### 现状证据

- `src/lark-bridge/index.ts:133` 只保存单个 `lastNotifyAck`，无法跟踪多个并发 requestId。
- `src/lark-bridge/index.ts:156-162` 的 `send` 仅返回布尔值；WebSocket `send()` 被调用即视为成功，没有回调错误、待确认状态或超时。
- `src/lark-bridge/index.ts:244-271` 的 task_end 通知在线时只发送一次；断线时直接不发送。
- `src/lark-bridge/index.ts:289-295` 收到 ack 后只覆盖 `lastNotifyAck`，没有清理待发送记录、状态展示或重试逻辑。
- `src/lark-bridge/index.ts:516-524` settled 时发送 task_end 后立即清摘要；即使发送失败或随后断线，摘要也不可恢复。
- `src/lark-bridge/index.ts:567-594` 审批 notify 也只依赖 `send` 的布尔结果；“写入 WebSocket 缓冲区”被当作“Hub 已成功创建审批并发出飞书消息”。

### 风险

- Hub 断开时 task_end 静默丢失。
- socket 写入后、Hub 处理前断线会丢通知；Hub 已发送但 ack 丢失时 Bridge 又无法判断结果。
- 多个 notify 的 ack 互相覆盖，无法形成可追踪状态。
- 危险命令可能显示“已请求飞书审批”，但 Hub 实际未成功建单或发卡；最终只能依赖本机 UI/超时，用户预期与实际不一致。

### 建议

1. Bridge 增加按 requestId 管理的有限待发送表，至少包含 payload、首次/最近发送时间、尝试次数、状态和最后错误。
2. 仅收到匹配的 `notify_ack` 后进入确认终态；ack 超时后有限重试，复用同一 requestId。
3. 重连并完成 `register_ok` 后重放未确认项；由 Hub 幂等状态机消除重复飞书消息。
4. 设置容量、退避、最大尝试次数和用户可见失败提示；审批仍保持 fail-closed。
5. task_end 可按产品要求选择“短期内重放”或“明确报告未发送”，不得静默丢弃。

### 验收方式

- 模拟 socket 写入后立即断线、ack 丢失、ack 延迟、重复 ack、乱序 ack和重连，逐项验证状态机。
- 多个并发 notify 的 ack 能独立匹配，不再使用单个 `lastNotifyAck`。
- 达到重试上限时 UI 明确显示失败，队列有界且不会无限重试。
- 与 P0-2 联合测试证明重试不产生重复飞书卡片。

---

## P0-4：Bridge 重连不复用原 piId，审批和回复绑定连续性会断裂

### 现状证据

- `src/lark-bridge/index.ts:408-415` 每次 WebSocket 打开后发送的 `register` 消息都不包含已有 `piId`。
- `src/lark-bridge/index.ts:426-438` 非主动断开时把 `connected` 设为 false、清 socket，但没有清 `piId`，说明本地仍保留旧身份。
- 然而下一次注册并未把这个旧 `piId` 放回注册消息；Hub 会在 `src/hub/server.ts:365-376` 生成新 piId。
- Hub 虽支持同 piId 重连并替换旧连接，见 `src/hub/server.ts:378-390`，但 Bridge 未使用这一能力。
- 审批和消息绑定均按 piId 固定归属：`src/hub/approvals.ts:16-17`、`src/hub/bindings.ts:9-12`。

### 风险

- 断线前创建的 pending 审批仍指向旧 piId；重连后该 Pi 以新 piId 出现，审批结果会被判定目标离线，无法投递。
- 断线前飞书消息的回复绑定指向旧 piId，重连后回复失败关闭，即使实际是同一个 Pi 会话。
- 频繁重连会让用户看到 piId 变化，削弱多 Pi 管理和默认实例体验。

### 建议

1. 在同一 Pi 扩展生命周期内重连时使用上次 `register_ok` 的 piId 注册。
2. Hub 保持 connectionId 防旧连接误删新连接的机制，并补充同 piId 替换的集成测试。
3. 明确进程重启后的身份策略：若需要跨进程连续性，应使用不含 secret 的稳定实例/session 标识和冲突规则；若不需要，文档明确绑定仅在会话内有效。
4. 重连成功后触发未确认 notify 重放和 failed_delivery 审批结果恢复，但绝不改投其他 Pi。

### 验收方式

- 建立 Pi 连接、记录 piId、强制断线并重连，`register_ok.piId` 保持一致。
- 断线期间审批进入 failed_delivery，原 Pi 重连后可按设计重投；另一 Pi 不会收到结果。
- 断线前通知的 replyToMessageId 在同会话重连后仍精确路由到原 Pi。

---

## P0-5：审批结果只确认“调用了 socket.send”，没有 Pi 侧接收确认，可能被永久标记为已投递

### 现状证据

- `src/hub/server.ts:154-182` 的 `sendToPi` 只要 socket 为 OPEN 并调用 `socket.send` 就返回 true。
- `src/hub/server.ts:171-175` 随即调用 `approvalsRef.markDelivered`，将审批结果视为已成功送达。
- `src/hub/approvals.ts:190-194` 和 `249-252` 把 `deliveredToPi` 作为后续幂等终态；一旦标记，重复操作不再通知 Pi。
- 协议 `src/protocol.ts:19` 只有 `approval_result`，没有 Pi→Hub 的 `approval_result_ack`。

### 风险

- socket 处于 OPEN 但数据尚在缓冲区时连接中断，Pi 可能没收到审批结果，Hub 却永久认为已投递。
- 危险工具调用会一直等到本地五分钟超时并拒绝；用户已点击批准但执行未发生，且重试点击会被 Hub 判定已处理。
- 无法区分“已决策”“已写入 socket”“Pi 已接收”“Pi 已应用”四种状态。

### 建议

1. 协议增加 Pi 对 `approval_result` 的确认消息，至少包含 requestId 和接收/应用结果。
2. Hub 状态拆分为 `decided → dispatching → delivered/acknowledged`，ack 超时允许向原 piId 有限重发。
3. Pi 对重复 approval_result 按 requestId 幂等处理，并重复返回 ack。
4. 审批超时始终拒绝；目标离线和 ack 超时不得改投其他 Pi。

### 验收方式

- 模拟 `socket.send` 后连接立即关闭，记录不得进入最终 delivered。
- 重连后 Hub 向同一 piId 重发，Pi 只 resolve 一次并返回 ack。
- ack 丢失时 Hub 可重发；重复结果不会二次执行或改变首次决策。

---

## P0-6：审批、绑定和通知状态全在内存，Hub 重启后核心安全流程失忆

### 现状证据

- `src/hub/approvals.ts:76-77` 审批记录与定时器均为进程内 Map。
- `src/hub/bindings.ts:22` 消息绑定为进程内 Map。
- `src/hub/server.ts:120-121` 默认直接创建内存 binding store；`src/hub/server.ts:201-211` 默认创建内存 approval store。
- `src/hub/server.ts:505-511` 通知历史依赖 transport 临时 history 或当前 bindings 派生，不是完整持久记录。
- `src/hub/server.ts:685-687` 关闭时会清空审批状态。

### 风险

- Hub 重启后未决危险命令在 Pi 端仍等待，但 Hub 找不到 requestId；用户无法审批，只能等本地超时。
- 已发通知的回复绑定丢失，飞书回复无法回到原 Pi。
- 已决策但尚未被 Pi 确认的审批结果丢失，无法恢复。
- 重启后重放 notify 时 Hub 无法去重，可能产生重复卡片。

### 建议

1. 优先持久化未决审批、待确认审批结果、通知幂等记录和必要消息绑定。
2. 使用现有原子文件模式，增加 schemaVersion、原子替换、损坏文件隔离、过期清理和容量限制。
3. 不落盘 secret；正文如确需持久化，应最小化、限期并明确本机隐私边界。
4. 启动时恢复定时器，按 `createdAt + timeoutMs` 计算剩余时间；已过期项立即按 fail-closed 规则处理。

### 验收方式

- 创建 pending 审批后重启 Hub，审批仍可查询并只投递给原 piId。
- 重启时已过期审批恢复为拒绝，不会重新获得完整超时时间。
- 已发送通知重放不产生第二张卡片；绑定在 TTL 内仍可使用。
- 持久文件不包含 app secret、token 或不必要的完整敏感正文。

---

# P1：安全与运行质量

## P1-1：HTTP 控制面仅依赖 loopback，且授权身份来自调用者可伪造的 JSON 字段

### 现状证据

- `src/hub/server.ts:107-111` 限制服务只监听 `127.0.0.1` 或 `localhost`，这是已有的基础安全边界。
- `src/hub/server.ts:522-574` 的两个 POST 控制接口不要求 HTTP token、签名或来源证明。
- `/control/approval` 和 `/control/message` 直接从请求 JSON 读取 `openId`，见 `src/hub/server.ts:524-547`、`555-571`。
- `src/hub/server.ts:133-137` 的授权只比较这个调用者提供的 openId 是否在 allowed 集合中。
- `src/hub/server.ts:479-520` 的健康、实例、通知、审批诊断接口也没有额外访问控制。
- WebSocket 升级同样只检查 remoteAddress 为 loopback，见 `src/hub/server.ts:592-602`，没有进程间共享 token。

### 风险

- 同机其他进程可读取实例、cwd、通知和审批正文；若获知主人 open_id，可伪造 JSON 执行审批或向 Pi 投递任意消息。
- loopback 防止远程直接访问，但不防本机低权限恶意进程、浏览器驱动攻击或被攻陷的本地程序。
- HTTP 模拟入站与真实飞书事件共用业务入口，但缺少可信来源层，容易把“业务身份字段”误当“传输身份凭证”。

### 建议

1. 增加可选但推荐默认生成的本机控制 token，存储权限收紧；HTTP 和 WS 通过 header/subprotocol 或握手消息校验。
2. 真实飞书入站继续由 SDK 事件身份产生 openId；HTTP 调试接口不得仅凭请求体 openId 冒充真实用户。
3. 将诊断只读接口与写控制接口分级授权，可允许 `/health` 暴露最小匿名信息，其余需 token。
4. 保留 loopback 强制限制，不因 token 存在而允许公网监听。

### 验收方式

- 无 token 调用写控制接口返回 401/403，正确 token 才进入业务授权。
- 伪造 body.openId 不能绕过传输认证。
- WS 未认证客户端不能注册 Pi 或发送 notify。
- token 和主人 openId 不进入日志、健康摘要和错误回执。

---

## P1-2：HTTP/WS 缺少显式体积、连接和速率限制

### 现状证据

- `src/hub/server.ts:846-853` 的 `readBody` 会持续收集所有 chunk，直到请求结束，没有字节上限或提前销毁。
- `src/hub/server.ts:592` 创建 `WebSocketServer` 时没有配置项目级 `maxPayload`、连接数或速率策略。
- `src/hub/server.ts:608-611` 每条 WS 消息直接转字符串并解析，无帧大小检查。
- `src/lark-bridge/index.ts:225-228` 的远程消息队列无容量上限、TTL 或重复消息过滤。
- `src/hub/approvals.ts:76` 的审批记录没有容量/终态清理策略；终态记录会持续保留到 Hub 关闭。

### 风险

- 本机进程可通过大 HTTP body、大 WS 帧、高频 notify 或大量不同 requestId 消耗内存与飞书配额。
- Bridge 长时间繁忙时远程消息队列可无限增长。
- 即使只监听 loopback，资源耗尽仍会影响 Pi 主流程和本机稳定性。

### 建议

- 为 HTTP body、WS payload、并发连接、每连接消息频率、待审批数、通知队列和 Bridge 用户队列设置明确上限。
- 超限时返回稳定错误并丢弃/关闭连接，不记录完整 payload。
- 为终态审批和通知记录增加 TTL 与最大容量，采用可预测淘汰策略。

### 验收方式

- 超过限制的大请求得到 413 或 WS 1009，Hub 内存不随输入线性无限增长。
- 高频请求触发限流但不影响已有审批超时拒绝。
- Bridge 队列达到上限时明确告知用户，并按文档策略拒绝新消息或淘汰最旧消息。

---

## P1-3：飞书分批发送发生部分成功时缺少可恢复批次状态

### 现状证据

- `src/hub/feishu-native.ts:76-90` 逐批发送卡片，仅返回第一条 messageId。
- `src/hub/feishu-native.ts:91-95` 任一分批失败就抛错，避免自动降级造成整篇重复，这是已有的正确保护。
- `src/hub/server.ts:251-280` transport 抛错后只向 Pi 返回通用 error，不记录已成功批次、失败位置或部分成功状态。
- `src/hub/feishu-native.test.ts:87-103` 已测试“第二卡失败时不降级”，但没有 Hub 重试、批次恢复或用户可见部分成功状态测试。

### 风险

- 前几批已经到达飞书，但 Bridge 收不到 notify_ack；未来若加入简单整单重试，会重复已成功批次。
- 当前用户只看到发送失败，无法知道飞书端已有部分内容。
- 第一条 messageId 不能表达一个通知对应多个飞书消息，回复绑定和历史查询不完整。

### 建议

- transport 返回批次化结果：批次序号、messageIds、失败位置和 `partial` 状态。
- 通知状态机记录每个批次；重试从失败批次继续，或使用可证明幂等的批次键。
- bindings/history 支持一个 requestId 对应多个 messageId，所有批次回复均路由到同一 Pi。

### 验收方式

- 第 N 批失败后状态明确为 partial，已成功 messageId 均可查询和回复路由。
- 恢复后只补发未成功批次。
- 用户和 Bridge 能区分“完全失败”与“部分发送”。

---

## P1-4：审批建单早于飞书发送，发送失败后会留下用户从未见过的 pending 审批

### 现状证据

- `src/hub/server.ts:229-239` 对 approval 先调用 `approvals.create` 并启动超时定时器。
- `src/hub/server.ts:251-257` 随后才发送飞书卡片。
- `src/hub/server.ts:278-280` 发送失败只返回 error，没有撤销、标记“卡片发送失败”或调整审批记录。
- `src/hub/approvals.ts:308-319` 定时器最终仍会触发超时拒绝流程。

### 风险

- 主人没有收到审批卡片，但 Hub 中存在 pending；五分钟后 Hub 可能向 Pi 下发超时拒绝。
- `/approvals` 看起来像正常待审批，无法区分“已呈现给用户”和“出站失败”。
- Bridge 已提示“已请求飞书审批”的时间点也早于 Hub 确认，进一步造成误导。

### 建议

- 审批状态增加 `creating/sending/presented/send_failed`，只有卡片成功后进入用户可决策的 pending。
- 发送失败仍必须 fail-closed，但需向 Pi/本机 UI明确报告远程审批不可用；是否保留短期可重试记录应写入状态机设计。
- Bridge 等待 notify_ack 后再显示“飞书审批已送达”，发送中只显示“正在请求”。

### 验收方式

- transport 失败后 `/approvals` 显示 send_failed 而非普通 pending。
- 不会让用户误以为飞书上已有可操作卡片。
- 失败状态最终拒绝危险命令，且不会改投其他 Pi。

---

## P1-5：诊断接口和日志暴露过多业务内容，错误脱敏不统一

### 现状证据

- `src/hub/server.ts:225-227` 日志记录通知 title、piId 和 requestId。
- `src/hub/server.ts:479-492` `/health` 返回实例快照，其中包含 cwd、pid、displayName 和连接时间。
- `src/hub/server.ts:505-520` `/notifications`、`/approvals` 返回绑定、历史及审批记录；`ApprovalRecord` 在 `src/hub/approvals.ts:26-27` 包含 title/body。
- `src/hub/server.ts:464-472` HTTP 顶层错误会把异常 message 原样返回。
- `src/hub/feishu-native.ts:14-29` 和 `112-119` 对原生飞书发送错误已有 secret 脱敏，但 server 其他错误源没有统一脱敏器。

### 风险

- 本机诊断调用者可看到项目路径、危险命令、任务摘要和审批正文。
- 注入 transport、SDK 或文件错误若包含凭证值，可能经日志或 HTTP 500 原样泄露。
- 日志没有统一级别、事件名、requestId 字段结构和耗时，难以可靠关联故障。

### 建议

- 诊断接口默认最小化；敏感详情需认证并支持脱敏/摘要模式。
- 建立统一错误脱敏和结构化日志函数，字段白名单优于事后正则替换。
- 不记录 secret、token、完整危险命令或完整任务正文；requestId 可保留截断/哈希关联值。

### 验收方式

- 注入包含真实 secret 的所有主要错误路径，HTTP、日志和状态接口均不出现原值。
- 未认证 `/health` 不返回 cwd、pid 等非必要信息；敏感诊断接口受控。
- 一次 notify 可用稳定事件字段关联接收、发送、ack/失败和耗时。

---

# P2：工程治理与测试补强

## P2-1：缺少真实 Hub HTTP/WS 端到端测试，关键 server 路径几乎未被执行

### 现状证据

- 当前 `src/**/*.test.ts` 共 9 个文件；按 `it(` 静态统计约 96 个测试用例。
- `package.json:47` 手工列出测试文件，没有 `server.test.ts`、`protocol.test.ts` 或 Bridge 生命周期集成测试。
- 测试搜索未发现 `startHubServer`、真实 WebSocket 客户端、`/health`、`/control/message`、`notify_ack` 的调用。
- `src/hub/router.test.ts:436-719` 对 ApprovalStore 和 control 纯函数有较完整单测，但测试注释也明确由调用方模拟 `markDelivered`，没有验证 server 的 socket 发送与竞态。
- `src/lark-bridge/hub-autostart.test.ts` 聚焦 Hub 自动拉起，不覆盖 `src/lark-bridge/index.ts` 的注册、重连、队列、notify ack 和审批竞速。

### 风险

- 单元组件各自通过，但 HTTP→control→WS、WS→notify→transport→ack 等跨层数据流可能失效。
- 重连替换、旧连接 close、新连接 registry 映射、并发 notify 等竞态无法由纯函数测试捕获。
- server.ts 体量约 853 行，却缺少直接集成测试，是当前最大测试盲区之一。

### 建议

- 建立可注入 fake transport、fake clock、随机端口和真实 `ws` 客户端的 Hub fixture。
- 优先覆盖：注册/重连、畸形协议、重复 notify、并发 notify、ack 丢失、心跳超时、审批离线/重投、HTTP 鉴权与 body 限制、关闭竞态。
- 为 Bridge 抽取可测试连接/可靠队列状态机，避免必须完整启动 Pi TUI 才能测试。

### 验收方式

- 新增 server 集成测试文件并由默认 `npm test` 自动发现或集中入口包含。
- 使用随机端口并保证测试结束无悬挂 socket/timer。
- P0 每项至少有一个失败场景和一个恢复场景的端到端测试。

---

## P2-2：缺少重复、乱序和故障注入矩阵

### 现状证据

- `src/hub/router.test.ts:436-622` 覆盖审批重复决策、离线、超时和手工失败重试，但没有并发调用、重复 create、跨 Pi requestId 冲突和进程恢复。
- `src/hub/feishu-native.test.ts:87-103` 覆盖第二批失败，但未测试失败后恢复或 requestId 幂等。
- 未发现以下测试：重复 notify、notify_ack 丢失/乱序、WebSocket 写入后断开、重连保持 piId、Hub 重启恢复、队列容量、HTTP 超大 body、消息风暴。

### 建议

- 建立故障矩阵：失败点 × 重试次数 × 是否已产生外部副作用 × 是否收到 ack。
- 使用 deferred Promise 控制 transport 完成顺序，稳定复现并发覆盖。
- 使用 fake clock 驱动审批超时、ack 超时、退避和 TTL，减少真实等待测试。
- 对运行时解码器增加轻量属性测试或 fuzz 测试，保证任意 JSON 不导致未捕获异常。

### 验收方式

- 并发测试可重复运行且无偶发失败。
- 对每个外部副作用断言精确调用次数和幂等键。
- 任意生成的无效协议输入都只返回错误，不让 Hub/Bridge 崩溃。

---

## P2-3：测试发现和检查脚本可能吞掉失败或漏跑新增文件

### 现状证据

- `package.json:45` 的 `check` 为 `node --check src/index.ts || true`，失败被强制吞掉。
- `src/index.ts` 是 TypeScript 文件，`node --check` 也不是项目 TypeScript 正确性的主要验证方式。
- `package.json:47` 手工列出 9 个测试文件；新增测试若忘记更新脚本，不会进入默认测试。
- `package.json:50` 的 `prepublishOnly` 只执行 typecheck，不执行测试和打包/安装烟测。

### 风险

- CI 或开发者看到 check 成功，但实际语法检查已失败。
- 新增 server/protocol 测试可能存在于仓库却从未被默认命令执行。
- 发布包可能类型检查通过，但缺文件、入口、Node 版本或运行时加载失败。

### 建议

- 移除 `|| true`，将 `check` 定义为真实且失败可见的验证组合。
- 使用稳定 glob、集中测试入口或自动发现全部 `*.test.ts`。
- 发布前增加测试、包内容检查、`npm pack` 后安装/启动烟测和 Node 20 最低版本验证。

### 验收方式

- 人为加入失败测试或类型错误时默认验证命令必须非零退出。
- 新建任意 `src/**/example.test.ts` 无需修改文件列表即可被执行。
- CI 验证打包产物能加载扩展并启动 Hub 健康接口。

---

# 已有正确边界，后续改造应保留

以下现有设计值得在修复中保持：

- `src/hub/server.ts:107-111` 强制 loopback 监听。
- `src/hub/server.ts:594-602` 对 WebSocket remoteAddress 再做 loopback 检查。
- `src/hub/control.ts:166-205` 回复绑定缺失或目标离线时失败关闭，不改投默认 Pi。
- `src/hub/approvals.ts:190-246` 已投递决策幂等、首次决策保留、离线不改投其他 Pi。
- `src/hub/registry.ts:112-117` 心跳使用服务端时间，不信任客户端 ts。
- `src/lark-bridge/index.ts:542-636` 危险命令审批超时默认拒绝，无 UI 且无 Hub 时立即失败关闭。
- `src/hub/feishu-native.ts:91-95` 分批卡片部分成功时不自动降级整篇纯文本，避免明显重复副作用。

---

# 建议实施依赖顺序

1. **协议运行时解码与输入上限**：先建立可信边界和错误契约。
2. **Hub notify requestId 幂等状态机**：可靠重试的前提。
3. **Bridge 待确认队列与 notify_ack 状态机**：在 Hub 幂等后启用重放。
4. **重连复用 piId + 审批结果 ack**：修复会话连续性和决策投递确认。
5. **审批/通知/绑定轻量持久化**：把单进程语义扩展到重启恢复。
6. **HTTP/WS token、限流与诊断脱敏**：收敛本机控制面。
7. **批次发送恢复与完整历史**：解决长通知部分成功。
8. **测试发现、发布烟测和长期资源治理**：固化上述契约。
