# 设计

- `src/lark-bridge/task-queue.ts`：纯函数队列
- 协议：Hub→Pi `queue_control`；Pi→Hub `queue_report`（reply 文本）
- control：识别队列命令 → deliver queue_control
- Bridge：处理 control + /lark 子命令
