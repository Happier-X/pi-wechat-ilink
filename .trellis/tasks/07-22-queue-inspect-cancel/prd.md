# 多 Pi 队列查看与取消

## 目标

为 Bridge 用户消息 FIFO 增加条目 ID、容量上限、查看与取消；飞书侧经 Hub 路由到目标 Pi，Pi 侧可用 `/lark queue`。

## 需求

1. 排队项有短 id；列表展示 id、来源、摘要、入队时间。
2. 取消：按 id 移除未消费项；清空：移除全部待执行项。
3. 已开始执行的当前任务不可取消（仅待执行队列）。
4. 队列满时拒绝新入队并提示。
5. 飞书：`队列` / `取消 <id>` / `清空队列`；走当前默认路由，不改投离线 Pi。
6. Pi：`/lark queue`、`/lark cancel <id>`、`/lark clear-queue`。

## 验收

- [ ] TaskQueue 单测
- [ ] 协议 queue_control / queue_report
- [ ] control 命令识别
- [ ] typecheck/test 通过

## 不做

- 取消正在执行的 agent run
- 跨 Pi 全局队列
