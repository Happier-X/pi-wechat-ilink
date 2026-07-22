# 设计（方案 A）

## NotifyStore

- 记录字段：`key, piId, requestId, event, payloadHash, status, messageId?, messageIds?, error?, titlePreview?, createdAt, updatedAt`
- API：`list({ limit })`、`getByRequestId(prefix)`、`getByMessageId`、`markPartial`（可选）、保留 `sendIdempotent`
- 失败保留 error（截断）；TTL 默认 24h + maxRecords 500
- **重试**：仅 `status===failed` 时允许再次 `sendIdempotent`（清除 failed 锁并单飞）；`sent` 仍重放 messageId

## 出站

- `FeishuSendResult` 扩展可选 `messageIds?: string[]`（首 id 仍为 `messageId`）
- 多卡成功：写入 `messageIds`；中途失败：整单 failed + error（与现行为一致），可选记录已成功 id 到 `messageIds` 作 partial 观测，**不续发**

## HTTP / 控制

- `GET /notifications`：`{ records: redact(list), bindings: redact(...) }`
- `POST /control/notify-retry` body `{ requestId, openId? }`：鉴权 + 找 failed 记录 → 触发 Hub 内部重发路径（需保留最近 payload 或要求 Pi 重报——**本设计**：Hub 在 record 中缓存脱敏级 title/body 的重发快照有隐私风险；**采用**：重试时若 record 带 `retryPayload`（内存内完整 title/body，不进 `/notifications` 响应），则 Hub 本地重发；无 payload 则 409 提示需 Pi 重发 notify）
- 为支持重试：`NotifyRecord` 增加内存字段 `retryPayload?: NotifyPayload`（list/API 永不输出 body 全文，仅 title 预览）

## 飞书

- `parseRetryCommand`：`重试|retry <id前缀>`
- control：路由到 notify-retry；结果中文 reply

## 审批

- 重试路径：`approvals.create` 对已存在 pending 保持幂等（已有逻辑）；不得 create 第二 requestId

## 不做

- 批次续发状态机
- 持久化
