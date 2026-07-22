# Hub e2e 与发布检查

## 目标

补齐 Hub HTTP/WS 关键路径端到端测试，并让发布前检查失败可见、测试入口可维护。

## 需求

1. **e2e 夹具**：随机端口启动真实 `startHubServer` + `ws` 客户端 + `NoopFeishuTransport`（或可注入 transport）；测试结束关闭无悬挂。
2. **覆盖场景（MVP）**：
   - register → register_ok + /health 在线
   - 畸形协议帧 → error，连接不崩
   - notify 幂等（同 requestId 两次仅一次出站）
   - POST /control/message 投递 user_message（需已 register）
   - 可选 control token：无 token 401，有 token 通过（/health 仍免鉴权）
3. **发布检查**：
   - `npm run check` 去掉 `|| true`，失败退出非 0
   - `npm test` 改为目录/glob 自动发现 `src/**/*.test.ts`（或等价），避免手工列表
   - `prepublishOnly`：typecheck + test（可选 pack 烟测若成本低）

## 不做

- 真实飞书 OpenAPI/WS 长连接
- 完整 Bridge 扩展在 Pi 进程内 e2e
- 引入 Jest/Vitest 新框架（继续 node:test + tsx）
- 强制云端 CI 账号配置（可加 GitHub Actions 仅跑本地同命令）

## 验收

- [ ] 新增 e2e 测试纳入 `npm test` 且稳定通过
- [ ] `check` 语法错误时失败
- [ ] `prepublishOnly` 含 test
- [ ] typecheck/test 全绿
