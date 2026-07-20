# PRD：统一飞书原生开局与重置

## 目标

只保留 Pi 命令 `/lark` 与 `/lark reset`，完全收敛到飞书 PersonalAgent 扫码注册和原生 OpenAPI + WebSocket 运行时。删除旧的短码配对、兼容命令、console 模式与 lark-cli 依赖。

## 需求

| ID | 需求 |
|----|------|
| R1 | `/lark` 无原生凭证时发起官方 PersonalAgent 扫码注册；已有凭证时确保 native transport/WS 已连接并提示状态 |
| R2 | 二维码载荷必须是飞书返回的 `verification_uri_complete` URL，同时落盘 PNG、尽力打开并展示 URL |
| R3 | Hub 本地轮询 registration，控制面仍只监听 loopback，不自建公网回调 |
| R4 | appId/appSecret/brand 独立写入 credentials 文件；secret 不进入 config、日志、通知 |
| R5 | registration 必须返回可信真人 `open_id`；缺失、等于 bot 或 bot 校验失败均 setup 失败，不保存、不启用 |
| R6 | 成功后写入 `feishu.mode=native`、唯一主人 `allowedOpenIds` 与 `userId`，清除 `chatId`，并热切换 native transport/WS |
| R7 | `/lark reset` 停止 native WS，删除原生凭证，清理 native 配置和主人绑定，之后 `/lark` 可重新扫码 |
| R8 | 删除 `/lark-setup`、`/lark-pair`、`/lark-status`、`/lark-ask`、短码协议/PairingStore/旧二维码/自动 pair、console、lark-cli 及相关测试文档 |
| R9 | 未绑定时 native 不接收首个用户自助绑定；setup 必须在注册阶段确认真人主人 |
| R10 | 保留多 Pi 路由、任务结束通知、审批与 native 出站/入站核心 |

## 验收标准

1. 只注册 `/lark` 和 `/lark reset`，旧命令及文档无引用。
2. 无凭证执行 `/lark` 显示官方 URL 二维码；可信真人扫码成功后凭证、native 配置、主人绑定和 WS 均就绪。
3. 缺失/不可信真人 open_id 时 setup 失败，旧运行时和文件不被破坏。
4. 有凭证执行 `/lark` 不重复注册，确保 native 连接；reset 后凭证、native mode、主人字段均清除。
5. 无 console、lark-cli、短码 PairingStore、need_reply 兼容逻辑残留。
6. `npm run typecheck`、`npm test`、`git diff --check` 通过。

## 非目标

多主人、群聊、公网回调、飞书卡片 2.0、lark-cli、console 模拟模式、显式 need_reply。
