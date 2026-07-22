# 设计

## Hub NotifyStore

- key = `piId|requestId|event`
- status: `sending | sent | failed`
- 同 key 同 payloadHash 且 sent → 直接 notify_ack
- 同 key 不同 hash → error
- 同 key sending → 等待同一 Promise
- 容量上限淘汰最旧终态

## ApprovalStore

- pending 同 requestId 同 piId：返回原记录，不重装定时器
- pending 不同 piId：抛冲突
- terminal：返回原记录不覆盖

## Bridge

- `pendingNotifies: Map<requestId, {payload, attempts, timer}>`
- 发送 notify 入表；ack 清除；超时重发至 maxAttempts
- register_ok 后 flush
