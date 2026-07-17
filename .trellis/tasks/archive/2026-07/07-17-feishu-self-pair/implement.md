# 实现清单

1. [x] `src/hub/pairing.ts` + 单测
2. [x] `protocol.ts` 消息类型 + parse 兼容
3. [x] `config.ts`：saveHubOwnerBinding + bootstrap 校验
4. [x] `control.ts`：配对优先；空白名单策略
5. [x] `server.ts`：pair_begin、热更新 allowlist、绑定回调
6. [x] `cli.ts`：装配 hubConfig / consoleAllowEmptyAllowlist
7. [x] `lark-bridge`：`/lark-pair` + 消息处理
8. [x] 测试挂 package.json；README + docs（spec 待 finish）
9. [x] typecheck + test（89 全绿）
