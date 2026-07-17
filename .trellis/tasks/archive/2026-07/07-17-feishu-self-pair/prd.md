# PRD：飞书仅绑定本人（短码配对）

## 背景

当前真实飞书需手写 `allowedOpenIds` + `feishu.userId`（`ou_xxx`）。用户希望「只绑自己」：本机显示一次性短码，飞书发配对口令完成绑定。

## 目标

- Pi 执行 `/lark-pair` → 本机展示 5 分钟有效、用后即废的短码。
- 飞书（或 `POST /control/message` 模拟）发送「配对 &lt;码&gt;」→ Hub 将**发送者** `open_id` 设为唯一主人：
  - `allowedOpenIds = [open_id]`
  - `feishu.userId = open_id`，**清除** `chatId`
  - 落盘配置文件
- 配对口令在白名单校验**之前**处理（解决首次无人在白名单无法发消息的问题）。
- lark-cli 允许「未绑定 bootstrap」：白名单为空时可启动，但非配对消息拒绝并提示配对。
- 错误码/过期/无会话 → 不改配置，明确回执。

## 非目标

- 二维码图片、多主人、云端配对、去掉 lark-cli。

## 已决

| 决策 | 选择 |
|------|------|
| 人数 | 只绑自己（覆盖换绑） |
| 形态 | 短码口令 |
| 发起 | 仅 `/lark-pair` |
| 有效期 | 5 分钟，用后即废 |
| 出站 | 强制本人 DM，清 chatId |
| 模拟 | 支持 `/control/message` + openId |

## 验收

1. `/lark-pair` → notify 显示码 → control/飞书配对成功 → config 仅一人且 userId 正确。
2. 错码/过期/无会话 → 配置不变。
3. 绑定后非主人消息 `ok: false` / 无权限。
4. 未绑定且白名单空：非配对消息提示先配对；配对可通过。
5. typecheck + 单测通过。

## 状态

- planning 收敛完成，待实现
