# 控制面 token 与限流

## 目标

加固 loopback HTTP 控制面：可选访问 token、请求体上限、简单频率限制，诊断接口脱敏；不开放公网监听。

## 需求

1. 配置/环境变量可选 `controlToken`；配置后除 `/health` 外需 `Authorization: Bearer` 或 `X-Lark-Hub-Token`。
2. `readBody` 有字节上限，超限 413。
3. 控制/诊断 HTTP 有滑动窗口限流，超限 429。
4. `/notifications`、`/approvals`、`/instances` 脱敏（不回传完整长 body/secret）。
5. `/health` 保持无 token 可访问，供 Bridge 自动拉起。
6. 默认无 token 时仍限 body 与限流，保持本机低摩擦。

## 验收

- [ ] 无/错 token → 401；超 body → 413；超限流 → 429
- [ ] 诊断响应无完整隐私正文与 secret
- [ ] typecheck/test 通过
