# 设计：统一 `/lark` 原生运行时

## 命令与协议

- `/lark` → `lark_open { piId }`
- `/lark reset` → `lark_reset { piId }`
- Hub → Pi：`lark_challenge { url, expiresAt, ttlMs }`、`lark_result { ok, connected, reset?, message }`

`/lark` 根据凭证状态分流：无凭证执行 registration；有凭证则探测并确保 native WS。单次只允许一个开局操作。

## 成功事务

1. registration 返回 app 凭证与 owner open_id。
2. Native transport 探测 bot open_id；owner 必须非空且与 bot 不同，bot 探测失败也视为不可信。
3. 启动候选 native WS 并等待 connected。
4. 原子写 credentials 与 native owner config。
5. 切换 transport/WS，停止旧 runtime。

任一步失败均停止候选 runtime，不改当前配置与凭证。

## 重置事务

1. 中止进行中的 registration。
2. 停止 native WS。
3. 删除 credentials 文件。
4. 原子清理 config 中 `feishu`、`allowedOpenIds`、`requireAllowlist`；内存清空主人和 transport。
5. 返回 reset 成功，下一次 `/lark` 重新扫码。

无凭证状态下 Hub 使用不可发送的占位 transport，仅维持 loopback 控制面和 Pi 注册；不存在 console 或 lark-cli 模式。

## 安全

- Hub 仅 loopback。
- secret 只进入独立 credentials 文件。
- setup 必须同时验证 owner 与 bot open_id，禁止缺失 owner 的 fallback。
- native 入站仅允许唯一 owner open_id。
