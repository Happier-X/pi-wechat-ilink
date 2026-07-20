# 实现清单：统一 `/lark`

## 清单

1. [x] 协议收敛为 lark_open/reset/challenge/result，删除 pair、setup 旧协议和 need_reply event。
2. [x] 配置仅保留 native 所需字段，新增 reset 原子清理。
3. [x] 删除 PairingStore、console/lark-cli transport 与 inbound。
4. [x] Server 实现可信 owner 的事务式 setup、已有凭证连接确保、reset。
5. [x] CLI 仅启动 native 或未配置占位状态。
6. [x] Bridge 只注册 `/lark`，参数仅允许 `reset`；删除 need_reply 和自动 pair。
7. [x] 二维码工具只保留官方 setup URL PNG。
8. [x] 更新 README、docs、spec、测试与 package 脚本。
9. [x] 运行 `npm run typecheck`、`npm test`、`git diff --check`。

## 删除文件

- `src/hub/pairing.ts` 及测试
- `src/hub/feishu-lark-cli.ts` 及测试
- `src/hub/feishu-inbound.ts`（其通用解析迁入 native 模块）
- 旧 pair QR 测试与兼容接口
