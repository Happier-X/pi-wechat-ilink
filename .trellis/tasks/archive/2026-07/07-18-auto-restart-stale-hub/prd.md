# PRD：更新后自动重启过期 Hub

## 背景

Hub 常驻：关 Pi 不杀 Hub。Bridge/包更新后若 8765 上仍是旧进程，会出现 `未知消息类型: pair_begin` 等协议不兼容，用户只能手动杀进程。

## 目标

- Bridge 能判断本机 loopback Hub **是否过期**（相对当前包的能力/版本）。
- 过期时：**默认自动**结束旧进程并拉起当前包 Hub（复用 autostart spawn）。
- 非 loopback / `PI_LARK_HUB_AUTORESTART=0`：不杀进程；可提示。
- 有冷却，避免杀→起→杀 循环。

## 非目标

- 远程/非本机 Hub 的强制重启
- 系统服务安装、开机自启
- 无进程重启的代码热更

## 代码事实

- `ensureHubRunning`：health ok 即 ready，不校验版本
- Hub 常驻；autostart 冷却约 30s
- `/health` 已有 `feishuMode` / `ownerBound` / `needsPairing`，无 `packageVersion` / `pid` / `features`

## 已决

| 决策 | 选择 |
|------|------|
| 默认开关 | **A：默认自动重启**；`PI_LARK_HUB_AUTORESTART=0`/`false`/`no`/`off` 关闭 |
| 范围 | 仅 loopback URL |
| stale 判定 | **A：能力集为主**；health 缺 `features` 或不含 `pair_begin` 即过期；版本作为诊断字段，不强制 bump |

## 已决（续）

| 决策 | 选择 |
|------|------|
| 杀进程 | **A：只杀 health.pid**；无 pid 的历史 Hub 不自动杀，提示手动重启 |

## 验收

1. 旧 Hub（health 缺 `features` 或 `pair_begin`）在 ensure 阶段被替换为新 Hub。
2. 当前 Hub 含最低能力 `pair_begin`：不无故重启。
3. 非 loopback / 关闭 env：不杀。
4. 只 kill health 返回的 PID；PID 不存在/kill 失败时明确提示并不误杀；无 pid 旧 Hub提示手动重启。
5. typecheck + 单测。

## 状态

- planning 收敛完成，待 design/implement + start 评审
