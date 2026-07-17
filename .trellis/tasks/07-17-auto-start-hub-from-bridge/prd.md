# PRD：Bridge 自动拉起本机 Hub

## 背景与问题

用户安装 `pi-lark-hub` 扩展后，若未手动执行 `npm run hub`，lark-bridge 连接 `ws://127.0.0.1:8765` 失败，弹出：

> pi-lark-hub 连接失败…请确认已启动：npm run hub

当前为**双进程**设计：Pi 扩展只重连、不拉起 Hub。懒用户不想每次再开终端。

## 目标

- **默认**在 Hub 不可达时，由 **lark-bridge 自动在本机拉起** `pi-lark-hub`（loopback），无需用户手敲启动命令。
- 多 Pi 同时启动时**只应存在一个**本机 Hub（单例）。
- 保留手动/外部已启动 Hub 的兼容：若 8765 已有健康 Hub，**不二次 spawn**。
- 可用环境变量**关闭**自动拉起（调试/高级用户）。
- **不**改为云端 Hub；**不**改为单进程内嵌迷你 Hub 重写 multi-Pi（本任务范围外）。

## 非目标

- 跨机器 / 公网 Hub
- 系统服务安装向导（Windows 服务 / launchd / systemd）——可作为后续可选增强
- 飞书配置的图形向导（仍用 config.json / env）
- 去掉独立 Hub 进程架构

## 用户故事

1. 作为懒用户，我 `pi install` GitHub 包并打开 Pi 后，应自动连上 Hub（或自动拉起后再连），不必另开终端。
2. 作为多 Pi 用户，我开第二个 Pi 时，应复用已有 Hub，不启两个冲突实例。
3. 作为开发者，我可设置 `PI_LARK_HUB_AUTOSTART=0`，继续自己 `npm run hub`。

## 功能需求

| ID | 需求 | 优先级 |
|----|------|--------|
| R1 | session 开始连接 Hub；失败且允许 autostart 时尝试 spawn Hub | P0 |
| R2 | spawn 前探测：已有可达 Hub（health 或等价）则只连接、不 spawn | P0 |
| R3 | 多 bridge 并发启动时最终仅一个有效 Hub（单例；竞态可接受短暂双启失败后复用胜者） | P0 |
| R4 | spawn 后轮询直至可连接/注册或超时，并 notify 结果 | P0 |
| R5 | 自动拉起失败时 notify 含可操作原因；文案不以「请 npm run hub」为唯一指引 | P0 |
| R6 | `PI_LARK_HUB_AUTOSTART=0`（及常见 falsy：`false`/`no`/`off`）关闭自动拉起 | P0 |
| R7 | README 写明：默认自动拉起、如何关闭、Hub 常驻与如何手动停止 | P1 |
| R8 | Pi / bridge 退出时**不**停止 Hub（常驻） | P0 |
| R9 | Hub 崩溃或被杀后，bridge 重连失败时**可再次** autostart spawn，并带冷却（避免狂启） | P0 |

## 验收标准

1. 本机无 Hub 时启动 Pi + bridge → 无需手动启动命令，最终 `/lark-status` 已连接（包依赖齐全时）。
2. 已有健康 Hub 时启动 Pi → 不造成「双 Hub 争端口导致双方皆不可用」的稳态；bridge 能连上已有 Hub。
3. 两个 Pi 几乎同时启动 → 最终可注册到同一有效 Hub（允许短暂竞态）。
4. `PI_LARK_HUB_AUTOSTART=0` 且无 Hub → **不** spawn，提示不可用 + 重连（与今日接近）。
5. Hub 进程被杀后，在 autostart 开启时，bridge 在冷却规则内能再次拉起并恢复连接。
6. `npm run typecheck` 通过；既有 hub 单测不回归。

## 约束

- Hub 仍仅 loopback（安全契约不变）。
- 分发以 GitHub `pi install` 为主；须能解析扩展包安装根目录以找到 hub 入口。
- Windows 为主要使用环境之一（spawn/detached 需可用）。

## 已决产品决策

| 决策 | 选择 |
|------|------|
| 架构 | Bridge 自动拉起独立 Hub 进程，不内嵌迷你 Hub |
| 生命周期 | **不**在 Pi 退出时关 Hub（常驻）；文档说明如何手动停止 |
| 崩溃自愈 | **再 spawn + 冷却**（推荐默认 30s 内每进程最多一次成功 spawn 尝试窗口，具体数值见 design） |
| 关闭自动拉起 | `PI_LARK_HUB_AUTOSTART=0`（及 falsy 等价） |

## 开放问题

无（实现数值与模块拆分见 `design.md` / `implement.md`）。

## 状态

- planning → 需求已收敛，待 design/implement 与用户 start 评审
