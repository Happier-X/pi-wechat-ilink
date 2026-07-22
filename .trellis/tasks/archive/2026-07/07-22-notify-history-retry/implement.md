# 实施清单

1. [ ] 扩展 `NotifyStore`：list/get、TTL、retryPayload 内存、failed 可重试、messageIds
2. [ ] 单测 store 历史与重试语义
3. [ ] `FeishuSendResult.messageIds` + native 多卡写入
4. [ ] `server`：notify 写历史；`/notifications`；`POST /control/notify-retry`；失败/成功路径
5. [ ] control/router：`重试` 文本命令
6. [ ] 文档 + multi-pi-lark-hub 规格一句
7. [ ] `npm run typecheck` && `npm test`

## 回滚

- 新接口与字段向后兼容；可仅回退 server 路由保留 store 扩展
