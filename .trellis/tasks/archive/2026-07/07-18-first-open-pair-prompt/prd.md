# PRD：首次打开未绑定 → 自动引导配对

## 背景

已实现 `/lark-pair` 短码配对，但用户**首次打开 Pi** 时不会被主动引导；容易不知道要配对，或空白名单下飞书消息被拒却无本机提示。

## 目标

- Bridge 在会话启动并连上 Hub 后，能判断「是否需要配对引导」。
- 若需要：**自动发起短码配对**（等同 `/lark-pair`：`pair_begin` → notify 展示码与口令）。
- 已绑定或 console 开发：不自动出码、不刷屏。
- 与现有 `/lark-pair`、5 分钟一次性短码、control 模拟路径兼容。

## 非目标

- 二维码 / 扫码图片链路（可二期）
- 云端配对、多主人
- 改配对 TTL / 口令格式

## 代码事实

- 配对仅由 `/lark-pair` → WS `pair_begin` 触发。
- `session_start` → `connectHubWithEnsure`；`register_ok` 仅 notify 已注册。
- `GET /health` 目前不含绑定 / mode 状态。

## 已决

| 决策 | 选择 |
|------|------|
| 引导形态 | **A：自动出短码**（不 QR） |
| 触发条件 | **B：仅 `feishu.mode=lark-cli` 且白名单为空** |
| 频率 | **A：每 Pi 进程自动最多 1 次**；断线重连不重复；手动 `/lark-pair` 不受限 |
| 已绑定 | **静默**（不弹「已绑定」类配对提示） |

## 验收

1. Hub 为 lark-cli 且 `allowedOpenIds` 为空时：Pi 连上并 `register_ok` 后**自动**出现配对码 notify（与手动 `/lark-pair` 同形态）。
2. console 模式，或 lark-cli 已有非空白名单：连接后**不**自动 `pair_begin`。
3. 同一 Pi 进程断线重连后：即使仍未绑定，**不**再次自动出码；用户可手动 `/lark-pair`。
4. 手动 `/lark-pair` 在任意时刻仍可用。
5. `npm run typecheck` + 相关单测通过。

## 状态

- planning 收敛完成，待 design/implement + start 评审
