# 目录结构

> 本仓库 `pi-lark-hub` 的后端（Hub + Bridge）代码组织。

---

## Overview

本项目是 **单包 TypeScript Node 库**，不是 monorepo，也没有独立 HTTP API 框架（如 Express 路由层）。结构按职责拆成：

| 区域 | 路径 | 职责 |
|------|------|------|
| 共享协议 | `src/protocol.ts` | Pi ↔ Hub 的 JSON 消息类型、序列化/解析 |
| Hub 守护进程 | `src/hub/*` | 本机 loopback HTTP + WebSocket、路由、审批、飞书出站/入站 |
| Bridge 扩展 | `src/lark-bridge/index.ts` | Pi 扩展：连 Hub、远程 FIFO、审批/need_reply |
| 包入口 | `src/index.ts` | 默认 `pi.extensions`：re-export lark-bridge |
| CLI bin | `scripts/pi-lark-hub.mjs` | 发布后启动 hub |
| 产品文档 | `docs/lark-hub.md` | 配置、安全、curl 验收（给人读） |
| 合约式规范 | `.trellis/spec/backend/multi-pi-lark-hub.md` | 给 AI/实现用的可执行约定 |

---

## Directory Layout

```text
pi-lark-hub/
├── package.json              # bin、pi.extensions、scripts
├── tsconfig.json             # strict + NodeNext，noEmit
├── scripts/
│   └── pi-lark-hub.mjs       # npm bin → 启动 hub
├── docs/
│   └── lark-hub.md           # 运维/验收文档
└── src/
    ├── index.ts              # 默认扩展入口（re-export bridge）
    ├── protocol.ts           # 协议类型 + parse/serialize
    ├── hub/
    │   ├── cli.ts            # Hub 进程入口（npm run hub）
    │   ├── server.ts         # HTTP + WS 服务、消息分发
    │   ├── config.ts         # defaults < 文件 < env
    │   ├── registry.ts       # 在线实例注册/心跳扫除
    │   ├── router.ts         # 纯文本/列表/使用 路由决策
    │   ├── bindings.ts       # messageId → piId 绑定
    │   ├── approvals.ts      # 审批状态机（幂等/超时）
    │   ├── control.ts        # POST /control/* 业务处理（含配对优先鉴权）
    │   ├── pairing.ts        # 短码配对会话（TTL / 用后即废）
    │   ├── feishu-transport.ts   # FeishuTransport 接口 + Console/Noop
    │   ├── feishu-lark-cli.ts    # lark-cli 出站实现（setRecipient 热更新）
    │   ├── feishu-inbound.ts     # lark-cli event consume 入站
    │   ├── *.test.ts             # 与模块同目录的 node:test
    └── lark-bridge/
        ├── index.ts          # Pi 扩展：WS / 队列 / 命令
        ├── hub-autostart.ts  # 本机 Hub 自动拉起（health + spawn）
        └── hub-autostart.test.ts
```

---

## Module Boundaries

### 允许的依赖方向

```text
cli → config / server / feishu-*
server → registry / router / bindings / approvals / control / pairing / config / protocol / feishu-transport
control → router / bindings / approvals / registry / pairing
lark-bridge → protocol（+ Pi ExtensionAPI peer）
protocol → （无业务依赖）
```

### 放置规则

| 新代码类型 | 放哪里 |
|------------|--------|
| Pi ↔ Hub 消息字段/类型 | `src/protocol.ts` |
| Hub 纯路由决策（无 IO） | `src/hub/router.ts` |
| 内存状态机（审批/绑定/注册） | `src/hub/approvals.ts` / `bindings.ts` / `registry.ts` |
| 飞书出站新实现 | 实现 `FeishuTransport`（见 `feishu-transport.ts`），在 `cli.ts` 装配 |
| 飞书入站解析 | `feishu-inbound.ts` |
| Bridge 侧队列/UI/命令 | `lark-bridge/index.ts`；Hub 自动拉起逻辑放 `hub-autostart.ts` |
| 单元测试 | 与被测模块同目录 `*.test.ts`，挂到 `package.json` `test` 脚本 |

### 不要

- 不要在 `src/index.ts` 写业务逻辑（只做 re-export）
- 不要把 Hub 状态写到磁盘/数据库（当前设计全是进程内内存）
- 不要在 bridge 里直接调 `lark-cli` 出站（出站归 Hub + FeishuTransport）
- 不要引入与「本机 loopback multi-Pi」无关的云端服务层目录

---

## Entry Points

| 入口 | 命令 / 加载方式 | 源文件 |
|------|-----------------|--------|
| Hub | `npm run hub` / `pi-lark-hub` | `src/hub/cli.ts` |
| 默认 Pi 扩展 | `pi.extensions` → `./src/index.ts` | re-export → `lark-bridge` |
| 显式 Bridge | `pi -e ./src/lark-bridge/index.ts` | `src/lark-bridge/index.ts` |

---

## 相关规范

- 路由、协议、飞书 mode：[multi-pi-lark-hub.md](./multi-pi-lark-hub.md)
- 远程文本禁止 followUp 等：[quality-guidelines.md](./quality-guidelines.md)
- 错误与 fail-closed：[error-handling.md](./error-handling.md)
