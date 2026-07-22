# pi-lark-hub 优化与新功能路线图

> 基于 2026-07-22 代码审查与 research。本文件是决策用交付物；详细证据见 `research/`。

## 一、现状摘要

| 维度 | 现状 |
|------|------|
| 规模 | 约 6200 行 TS，`src` 下 29 个源文件 |
| 测试 | 约 94–97 个用例，覆盖路由/审批纯函数、飞书格式与注册、Hub 自动拉起；**缺** `server` 真实 HTTP/WS 端到端 |
| 定位 | 本机 loopback、多 Pi、单可信飞书主人；原生 OpenAPI + 官方 WS |
| 已做对的边界 | loopback 强制、主人白名单、回复绑定 fail-closed、审批超时拒绝/不改投、心跳用服务端时间、分批卡片部分成功不整篇降级 |

**核心用户路径**：`/lark` 扫码 → 飞书文本遥控 Pi → 危险 bash 审批 → 任务结束卡片 → 回复绑定回原 Pi。

---

## 二、P0：可靠性（建议先做）

### 1. 协议运行时校验集中化

| 项 | 内容 |
|----|------|
| **证据** | `src/protocol.ts:30` 仅检查 `type` 后强制断言；`server.ts` / `lark-bridge` 直接读字段 |
| **用户价值** | 避免畸形消息拖垮 Hub/Bridge 或错误路由 |
| **风险** | 未捕获异常、非法枚举污染状态机、超长字段内存压力 |
| **方案** | 按消息类型解码、方向校验、长度/数量上限、稳定错误码；不回显完整正文 |
| **影响** | `protocol.ts`、`server.ts`、`lark-bridge/index.ts`、规格 `multi-pi-lark-hub.md` |
| **验收** | 表驱动非法输入 + 真实 WS 畸形帧不崩溃；Bridge 不误执行审批/入队 |
| **MVP 边界** | 只加运行时校验与错误回执，不改业务语义 |
| **不做** | 不引入重型 schema 库除非必要；不放宽 loopback |

### 2. 出站 notify 幂等 + Bridge 可靠确认

| 项 | 内容 |
|----|------|
| **证据** | Hub `handleNotify` 无 requestId 状态机（`server.ts:216+`）；Bridge `send` 仅布尔、`lastNotifyAck` 单槽（`lark-bridge/index.ts:133,156-162,289-295`） |
| **用户价值** | 减少重复卡片、丢 task_end、假“已请求审批” |
| **风险** | 重试重复发卡；并发同 requestId 改写审批归属 |
| **方案** | Hub：`(piId,requestId,event)` 状态机 + 单飞；Bridge：待确认表 + ack 超时有限重试；审批 fail-closed |
| **影响** | `server.ts`、`protocol`（可选扩展 ack）、`lark-bridge`、transport 契约 |
| **验收** | 重复/并发 notify 只一次 transport；ack 丢失可恢复；不改投其他 Pi |
| **依赖** | 最好先有协议校验；与审批卡片可并行设计 requestId 语义 |
| **不做** | 无限重试；自动改投 |

### 3. 重连复用 piId + 审批结果投递确认

| 项 | 内容 |
|----|------|
| **证据** | 重连 `register` 不带旧 piId（`lark-bridge/index.ts:408-415`）；`markDelivered` 仅在 `socket.send` 后（`server.ts:154-175`） |
| **用户价值** | 断线后审批/回复仍回到同一 Pi；批准真正到达 |
| **方案** | 会话内重连复用 piId；协议增加 `approval_result_ack`；Hub `decided→dispatching→acked` |
| **验收** | 断线重连 piId 不变；send 后断线不永久 delivered；恢复后幂等重投 |
| **不做** | 跨进程强制身份（可另立）；跨 Pi 改投 |

### 4. 未决审批/绑定轻量持久化

| 项 | 内容 |
|----|------|
| **证据** | `ApprovalStore`/`MessageBindingStore` 全内存；`close` 清空审批 |
| **用户价值** | Hub 重启后危险命令仍可审、回复仍可绑 |
| **方案** | 原子文件 + schemaVersion + TTL；不落 secret；启动恢复定时器 |
| **依赖** | notify 幂等与 requestId 模型更稳后实施更安全 |
| **验收** | 重启后 pending 可查；过期即拒绝；损坏文件不阻塞启动 |
| **不做** | 跨机器共享状态；完整对话历史 |

---

## 三、P1：安全与运维

### 5. HTTP/WS 控制面 token + 限流 + 脱敏

| 项 | 内容 |
|----|------|
| **证据** | POST `/control/*` 无 token，openId 来自 JSON body（`server.ts:522+`）；`readBody` 无上限；诊断接口暴露 cwd/title/body |
| **用户价值** | 降低本机其他进程伪造审批/投递与信息泄露 |
| **方案** | 可选/推荐本机 token；真实飞书 openId 仅来自 SDK；body/帧/频率上限；诊断分级脱敏 |
| **验收** | 无 token 写接口 401/403；伪造 body.openId 不能绕过传输认证；secret 不进日志/500 |
| **不做** | 因有 token 而开放公网监听 |

### 6. `/lark status` / 状态卡片

| 项 | 内容 |
|----|------|
| **证据** | `/health` 已有摘要；用户侧仅有 `列表/使用` 文本与零散 notify |
| **用户价值** | 快速判断是否开局、默认 Pi、待审批、为何无响应 |
| **方案** | 飞书 `状态/status` 本地处理；复用 registry/approvals；脱敏 |
| **验收** | 未开局/单 Pi/多 Pi/默认离线/有待审批 文案可行动；非主人不可读 |
| **不做** | 远程重启 Pi；暴露 secret |

### 7. 结构化诊断日志与 /health 增强

| 项 | 内容 |
|----|------|
| **证据** | 单行中文日志无级别/requestId/耗时（logging 规格亦如此） |
| **方案** | 轻量事件字段；连接状态、重连次数、队列长度、最近错误（脱敏） |
| **验收** | 一次 notify 可串联接收→发送→ack/失败；无隐私全文 |

---

## 四、P1：用户体验与产品能力

### 8. 审批卡片按钮 + 幂等回调（推荐首个产品 MVP）

| 项 | 内容 |
|----|------|
| **证据** | `actions` 已发；卡片仅 markdown；`sendApprovalCard` 未实现；正文仍写模拟 HTTP |
| **用户价值** | 危险命令一键批准/拒绝，核心遥控体验 |
| **方案** | 按钮 value 含 requestId/decision；actor 用 SDK open_id；走 `handleInboundApproval`；文本命令保留 |
| **验收** | 主人点击一次 → 目标 Pi 一次结果；重复/非主人/离线/超时矩阵；text 审批不回归 |
| **不做** | 公网 webhook 必需；多用户审批；超时改同意 |

### 9. 队列查看与取消

| 项 | 内容 |
|----|------|
| **证据** | FIFO 无 ID/容量/取消（`lark-bridge` queue） |
| **方案** | queue item id；`队列`/`取消 <id>`；容量上限；已消费不可撤 |
| **依赖** | 协议可选字段；Hub 转发控制动作 |
| **验收** | 稳定 ID；取消后不 `sendUserMessage`；满载明确拒绝 |
| **不做** | 中断执行中任务；模糊文本取消 |

### 10. 通知历史与有限重试

| 项 | 内容 |
|----|------|
| **证据** | `/notifications` 弱历史；无 delivery 状态/批次 |
| **方案** | requestId 级状态记录 + TTL；显式重试；审批重试不建第二单 |
| **依赖** | notify 幂等状态机；批次结果（P1 分批恢复） |
| **验收** | 成功/失败/部分成功可查；重试不重复执行审批 |
| **不做** | 自动无限重试 |

### 11. 分批发送部分成功可恢复

| 项 | 内容 |
|----|------|
| **证据** | 多卡只返首 id；中途失败抛错（正确防整篇重复）但无批次恢复 |
| **方案** | transport 返回批次列表；从失败批次续发；多 messageId 绑定同 Pi |
| **验收** | partial 可查；续发不重发已成功批 |

### 12. 审批“已呈现”与发送失败态

| 项 | 内容 |
|----|------|
| **证据** | 先 `approvals.create` 再发卡；失败仍 pending 直至超时 |
| **方案** | `sending/presented/send_failed`；ack 后再提示“已送达” |
| **验收** | 发卡失败不显示为普通 pending；危险命令仍 fail-closed |

---

## 五、P2：工程质量

### 13. Hub HTTP/WS 端到端测试夹具

- fake transport + fake clock + 随机端口 + 真实 `ws` 客户端。
- 覆盖：注册/重连、畸形协议、重复/并发 notify、审批离线、token、关闭竞态。
- **验收**：`npm test` 自动包含；无悬挂 timer/socket。

### 14. Bridge 资源治理

- 队列/审批 Map/定时器容量与 shutdown 语义；长跑内存不涨。

### 15. 发布与检查脚本

- 去掉 `check` 的 `|| true`；测试自动发现；`prepublishOnly` 含 test + pack 烟测。

---

## 六、新功能候选总表（建议落地顺序）

| 序 | 项 | 优先级 | 依赖 | 建议独立子任务 |
|----|----|--------|------|----------------|
| 1 | 协议运行时校验 | P0 | — | `protocol-runtime-decode` |
| 2 | 审批卡片按钮回调 | P0/P1 产品 | 审批状态机已有 | `approval-card-actions` |
| 3 | notify 幂等 + Bridge ack 队列 | P0 | 1 更佳 | `notify-idempotency-ack` |
| 4 | 重连 piId + approval_result_ack | P0 | 3 | `reconnect-piid-approval-ack` |
| 5 | `/lark status` / 状态卡片 | P1 | — | `lark-status-command` |
| 6 | 控制面 token/限流/脱敏 | P1 | — | `control-plane-hardening` |
| 7 | 队列查看/取消 | P1 | 协议字段 | `queue-inspect-cancel` |
| 8 | 通知历史/重试 + 分批恢复 | P1 | 3 | `notify-history-retry` |
| 9 | 审批/绑定持久化 | P0/P1 | 3–4 | `approval-binding-persist` |
| 10 | Hub e2e + 发布检查 | P2 | 全程 | `hub-e2e-and-ci` |

---

## 七、明确区分

| 类型 | 内容 |
|------|------|
| **必须先考虑的可靠性/安全** | 1–6（协议、幂等、重连、持久化、控制面、诊断） |
| **面向用户的新功能** | 审批按钮、status、队列、通知历史 |
| **可选工程治理** | e2e 夹具、资源上限、CI/发布脚本 |

---

## 八、本任务不做

- 不在本任务修改 `src/**` 业务实现。
- 不引入公网回调为必需条件。
- 不改变“审批超时拒绝 / 离线不改投”。
- 不把路线图一次性打成巨型 PR。

---

## 九、建议你现在选的下一步

1. **产品优先**：子任务「审批卡片按钮 + 幂等回调」  
2. **工程优先**：子任务「协议运行时校验」  
3. **仅归档本路线图**：当前任务交付结束，稍后按表拆任务  

详细证据：

- `research/reliability-security-protocol-test-gaps.md`
- `research/ux-feature-opportunities.md`
