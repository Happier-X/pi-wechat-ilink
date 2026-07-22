# 实施计划

1. 在 `src/protocol.ts` 增加常量上限、DecodeError/Result、字段读取与各 type 解码器、`decodePiToHubMessage` / `decodeHubToPiMessage`。
2. 新增 `src/protocol.test.ts` 表驱动覆盖合法/非法矩阵。
3. Hub `handlePiMessage` 改用 `decodePiToHubMessage`；失败 `safeSend` error，同步路径 try/catch。
4. Bridge `handleHubMessage` 改用 `decodeHubToPiMessage`；失败忽略业务副作用。
5. `package.json` test 脚本加入 `protocol.test.ts`。
6. 更新 `.trellis/spec/backend/multi-pi-lark-hub.md` 协议节。
7. 运行 `npm run typecheck`、`npm test`、`git diff --check`。

## 风险

- 过严上限误伤合法长 body：body 上限取宽松值。
- 现有测试若构造不完整消息需同步修正。
