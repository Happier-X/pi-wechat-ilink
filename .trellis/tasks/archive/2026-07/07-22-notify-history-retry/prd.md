# 通知历史与显式重试

## 目标

出站 notify 可按 requestId / messageId 查询状态与失败原因；对 failed 记录支持有限显式重试。本轮不做失败批次自动续发。

## 已确认范围（方案 A）

1. 扩展 `NotifyStore` 历史：list/get、status、`messageIds[]`、脱敏 error、时间戳；容量 + TTL。
2. `GET /notifications` 以历史为主、bindings 为辅；经诊断脱敏。
3. 显式重试：`POST /control/notify-retry` + 飞书文本 `重试 <requestId前缀>`；仅 `failed`；审批复用原 requestId、不新建第二单。
4. 轻量分批可观测：transport 可选返回多个 messageId；记录 partial 若适用；**不做**从失败批续发。

## 不做

- 磁盘持久化
- 自动无限重试 / 批次续发
- 公网查询
- 打断 inflight `sending`

## 验收标准

- [ ] 成功/失败 notify 可在 `/notifications` 查到
- [ ] 失败含脱敏 error，无 secret / 完整超长 body
- [ ] 显式重试：failed→再发；sent 幂等；审批不双建
- [ ] typecheck/test 通过
