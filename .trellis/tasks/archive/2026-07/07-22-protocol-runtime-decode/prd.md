# 协议运行时校验

## 目标

为 Pi ↔ Hub 的 loopback WebSocket 协议增加按消息类型的运行时解码、字段/长度上限与明确错误回执，防止畸形输入进入业务逻辑或导致进程异常。

## 背景

- 现状：`parseProtocolMessage` 仅检查 JSON 对象与 `type` 字符串后强制断言为 `ProtocolMessage`。
- Hub `server.ts` 与 Bridge 直接读取字段（如 `trim()`、枚举），缺字段或错误类型可导致未捕获异常。
- 路线图 P0-1；不改变业务语义，只加边界。

## 需求

1. Pi→Hub 与 Hub→Pi 消息分别按 `type` 解码；必填字段、枚举、有限数字、非空字符串、数组成员均校验。
2. 明确上限：帧大小、title、body/text、cwd/displayName、piId/requestId、capabilities/actions 数量等。
3. 解码失败返回稳定中文错误（可含错误码语义），不回显完整正文或 secret。
4. Hub 对非法帧：不崩溃、尽量回 `error`、不改变无关连接状态。
5. Bridge 对非法下行：不改 `piId/connected`、不执行审批、不入队用户消息。
6. 保留现有合法消息行为与类型导出；发送端继续使用 `serializeMessage`。

## 验收标准

- [ ] 表驱动测试覆盖各消息合法最小输入与非法：缺字段、类型错误、未知枚举、NaN、空串、超长、超大数组、未知 type。
- [ ] Hub/Bridge 接入解码器；畸形输入不导致未处理异常。
- [ ] `npm run typecheck`、`npm test`、`git diff --check` 通过。
- [ ] 规格 `multi-pi-lark-hub.md` 补充运行时解码与上限约定。

## 不做

- 不引入公网认证；不改审批/路由业务语义。
- 不在本任务做 notify 幂等或持久化。
