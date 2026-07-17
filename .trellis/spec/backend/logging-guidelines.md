# 日志规范

> Hub 进程日志 vs Bridge（Pi TUI）用户可见反馈的实际约定。

---

## Overview

两套输出面，**不要混用**：

| 组件 | 输出方式 | 读者 |
|------|----------|------|
| Hub（`cli` / `server` / inbound） | `console.log` / `console.error`，或注入的 `log: (line: string) => void` | 运维终端 |
| Bridge（Pi 扩展） | `ctx.ui.notify` / `ctx.ui.setStatus`；无 UI 时极少数 `console.log` | 本机 Pi 用户 |

Hub 日志是 **单行前缀文本**，不是 JSON structured logger，也没有 pino/winston。

---

## Hub 日志

### 机制

- 默认：`options.log ?? ((line) => console.log(line))`（见 `src/hub/server.ts`、`feishu-inbound.ts`、`feishu-lark-cli.ts`）
- CLI 启动摘要：`console.log("[pi-lark-hub] 配置摘要:")` + `formatConfigSummary`
- 致命配置/安全错误：`console.error` 后 `process.exit(1)`

### 前缀与内容

| 模式 | 示例用途 |
|------|----------|
| `[hub] …` | WS 注册、notify、错误投递 |
| `[pi-lark-hub] …` | CLI 层安全限制、回写失败 |
| console transport | 直接打印 event / messageId / title/body（开发模拟飞书） |

记录 **什么**：

- 连接/注册/注销、notify 出站与失败原因
- 未授权 openId、路由 fail-closed（通过 control 结果 + 必要 log）
- 配置校验失败的中文错误信息

**不要**记录：

- 完整 secrets / token / cookie
- 用户隐私全文若无调试必要（审批命令原文可截断）
- 多行 banner 式装饰（保持可 grep 的单行）

### 级别

当前 **没有** debug/info/warn 枚举。约定：

| 场景 | 用法 |
|------|------|
| 正常路径 | `log(...)` / `console.log` |
| 启动失败、非法 host、配置错误 | `console.error` + 退出 |
| 飞书回写失败 | `console.error`，不退出进程 |

测试中通过注入 `log` no-op 或收集数组，避免污染测试输出。

---

## 自动拉起的 Hub 子进程日志

Bridge 以 detached 方式 spawn Hub 时：

| 项 | 约定 |
|----|------|
| 路径 | `~/.pi/lark-hub/hub.log`（`defaultHubLogPath()`） |
| 内容 | Hub `console.log` / `console.error`（配置摘要、启动失败等） |
| TUI | **禁止**把 hub 子进程 stdio 接到 Pi 终端；stdin ignore，stdout/stderr 写文件 |
| 失败提示 | Bridge `notify` 附日志路径，便于用户打开文件排查（如缺 tsx） |

手动前台 `npm run hub` 仍走终端 stdout/stderr，与上表无关。

---

## Bridge（TUI）反馈

### 机制

```ts
// src/lark-bridge/index.ts
const status = (text?: string) => {
  if (activeCtx?.hasUI) activeCtx.ui.setStatus(STATUS_KEY, text);
};
const notify = (text: string, level: "info" | "warning" | "error" = "info") => {
  if (activeCtx?.hasUI) activeCtx.ui.notify(text, level);
};
```

| API | 用途 |
|-----|------|
| `setStatus("lark-bridge", text)` | 持久状态条：连接中 / piId / 断开 |
| `notify(text, level)` | 一次性提示：入队、审批、超时、Hub 错误 |
| `console.log` | **仅** `/lark-status` 在 `!ctx.hasUI` 时的降级输出 |

### level 选用

| level | 场景 |
|-------|------|
| `info` | 已注册、入队、批准、need_reply 收到回答 |
| `warning` | Hub 断开/重试、本机回退审批、超时取消、Hub 业务错误 |
| `error` | need_reply 发送失败等明确失败 |

文案使用 **中文**，可附 `piId` / `requestId` 短截断便于排查。

---

## 禁止事项

| 禁止 | 原因 |
|------|------|
| Bridge 在 TUI 下用多行 `console.log`/`stderr` 打 banner | 污染 alternate-screen，像「进输入框」 |
| 用 `process.stdin` / readline 做提示 | 与 TUI raw mode 冲突 |
| 引入重型 logger 却不统一 Hub `log` 注入点 | 双轨日志更难测 |
| 把远程用户消息全文无节制刷屏 | 噪音 + 可能含敏感内容 |

详见 [quality-guidelines.md](./quality-guidelines.md)。

---

## 验收相关

- Hub 本地：终端能看到 `[hub]` / 配置摘要即可
- Bridge：状态条 + notify；`/lark-status` 可读
- 单元测试：不依赖真实 console 断言（可注入 `log`）
