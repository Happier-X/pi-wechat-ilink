# notify 幂等与 Bridge 确认队列

## 目标

Hub 对相同 `requestId` 的 notify 幂等处理；Bridge 对 notify 等待 `notify_ack` 并有限重试，避免重复发卡与静默丢通知。

## 需求

1. Hub 以 `(piId, requestId, event)` 记录通知状态；同内容重放返回原 messageId；冲突拒绝。
2. 并发相同 notify 单飞，只调用一次 transport。
3. 审批 `create` 不得用另一 Pi 覆盖 pending；重复 pending 不重置超时。
4. Bridge 维护有限待确认表；ack 超时有限重试；重连后重放未确认项。
5. 审批仍 fail-closed，不改投其他 Pi。

## 验收

- [ ] 单元测试：重复/并发 notify、冲突 requestId、ApprovalStore pending 不覆盖。
- [ ] Bridge 待确认逻辑可测（纯函数/模块）。
- [ ] typecheck / test 通过。

## 不做

- 不持久化到磁盘（后续任务）。
- 不实现审批结果 ack。
