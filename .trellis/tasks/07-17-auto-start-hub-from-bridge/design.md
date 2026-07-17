# 设计：Bridge 自动拉起本机 Hub

## 1. 边界

| 在范围内 | 不在范围内 |
|----------|------------|
| lark-bridge 在 Hub 不可达时 spawn 本机 hub | 内嵌单进程 mini-hub |
| 健康探测、单例竞态、spawn 冷却、自愈 | 系统服务安装 |
| 解析扩展包根目录与 hub 入口 | 飞书配置向导 |
| README / 相关 spec 更新 | 云端 / 非 loopback |

## 2. 组件与职责

```text
lark-bridge (Pi 扩展)
  ├── connectHub()           现有 WS 连接
  ├── ensureHubRunning()     新增：探测 → 可选 spawn → 等待就绪
  ├── resolvePackageRoot()   新增：定位 pi-lark-hub 包根
  └── spawnHubDetached()     新增：detached 子进程

pi-lark-hub (独立进程，不变架构)
  └── GET /health 已有 { ok: true, ... }
```

Hub 服务端逻辑**尽量不改**；可选：若 EADDRINUSE，保证进程快速退出（已有 listen error 路径则复用）。

## 3. 主流程

### 3.1 session_start / 重连路径

```text
want connect
  → (可选) ensureHubRunning()
       → if !autostartEnabled → skip
       → if healthOk(loopback:port) → skip spawn
       → if within spawn cooldown since last attempt → skip spawn
       → try file lock (optional best-effort)
       → spawn detached hub
       → poll health until ok or timeout
  → connectHub()  (现有)
```

触发 ensure 的时机（MVP）：

1. `session_start` 首次连接前
2. WS `error`/`close` 导致将 `scheduleReconnect` 时：若 autostart 开且冷却允许，**先 ensure 再 connect**（满足崩溃自愈）

避免：每次 5s 重连都 spawn → 用 **lastSpawnAttemptAt + COOLDOWN_MS（默认 30_000）**。

### 3.2 健康探测

- URL：由 `PI_LARK_HUB_URL`（默认 `ws://127.0.0.1:8765`）推导 HTTP：`http://127.0.0.1:8765/health`
- 成功条件：HTTP 200 且 JSON `ok === true`（fetch / http.get，短超时如 800ms）
- 不可达：网络错 / 非 200 / 非 JSON → 视为需要 spawn

### 3.3 解析包根与入口

扩展模块位于包内 `src/lark-bridge/index.ts`（或 Pi 安装后的等价路径）。

```text
packageRoot = path.resolve(dirname(fileURLToPath(import.meta.url)), "../..")
// lark-bridge → src → package root
```

启动入口优先级：

1. `path.join(packageRoot, "scripts/pi-lark-hub.mjs")` 若存在 → `node scripts/pi-lark-hub.mjs`
2. 否则 `npx tsx src/hub/cli.ts` / 解析本地 `tsx/cli`（与现有 bin 一致）
3. 都失败 → notify 明确错误（缺依赖时提示在包目录 `npm install`；Pi git install 通常已跑过）

cwd = `packageRoot`，继承 `process.env`（飞书配置 env 对子进程可见）。

### 3.4 Spawn 形态（跨平台，含 Windows）

```ts
spawn(process.execPath, [entryArgs...], {
  cwd: packageRoot,
  detached: true,
  stdio: "ignore",
  env: process.env,
  windowsHide: true,
})
child.unref()
```

- **不**把 hub stdio 接到 Pi TUI（避免污染）
- 可选后续：日志落到 `~/.pi/lark-hub/hub.log`（MVP 可不做，失败靠 health 超时文案）

### 3.5 单例与竞态

| 机制 | 说明 |
|------|------|
| 端口 bind | Hub 仅能 listen 一次；失败者应退出；胜者提供 /health |
| 启动前 health | 已有 hub 则不 spawn |
| 冷却 | 每 bridge 进程 30s 内最多一次 spawn **尝试** |
| 可选 lock 文件 | `~/.pi/lark-hub/autostart.lock` 短 TTL（如 10s）减少同时 spawn；非必须，MVP 可用「health + 端口」 |

验收允许「短暂双启，一个 EADDRINUSE 退出」。

### 3.6 Autostart 开关

```text
PI_LARK_HUB_AUTOSTART
  unset / 空 / true / 1 / yes / on  → 开启（默认开）
  0 / false / no / off             → 关闭
```

### 3.7 用户可见反馈

| 事件 | notify / status |
|------|-----------------|
| 开始自动拉起 | status：正在启动 Hub…；可选 info notify 一次 |
| 拉起成功并连上 | 沿用「已注册到 pi-lark-hub」 |
| 拉起超时 | warning：自动启动超时 + 检查端口/依赖 + 如何手动 `npm run hub` + 如何关 autostart |
| 找不到入口 | warning：无法定位 hub 入口 |
| autostart 关闭且连不上 | 说明已关闭自动启动 |

**Pi 退出不 kill Hub**（已决）。

## 4. 模块拆分建议

| 文件 | 内容 |
|------|------|
| `src/lark-bridge/hub-autostart.ts` | enable 解析、health、resolve root、spawn、waitReady、cooldown |
| `src/lark-bridge/index.ts` | 调用 ensure；改 reconnect 路径 |
| 可选 `src/lark-bridge/hub-autostart.test.ts` | 纯函数：env 解析、url→http health、cooldown |

避免把 spawn 逻辑堆进已 800 行的 index。

## 5. 配置与兼容

- 不改 protocol 消息
- 不改 Hub 配置 schema
- 外部已手动 `npm run hub`：health 通过 → 无 spawn
- `PI_LARK_HUB_URL` 非本机：autostart **仅**在 host 为 127.0.0.1/localhost 时启用；远程 URL 不 spawn（安全 + 无意义）

## 6. 风险与缓解

| 风险 | 缓解 |
|------|------|
| Windows 弹窗 / 子进程挂死 | `windowsHide` + detached + unref |
| 缺 tsx | 与 bin 相同错误信息；文档写 Pi install 会 npm install |
| 双启闪烁 | health 前置 + cooldown + 端口互斥 |
| 误连非 hub 的 8765 服务 | health 校验 `ok: true`；不符则不视为就绪（spawn 可能 EADDRINUSE → 明确报错） |
| TUI 脏输出 | stdio ignore |

## 7. 回滚

- 用户：`PI_LARK_HUB_AUTOSTART=0`
- 代码：移除 ensure 调用即可恢复「只连不启」

## 8. 文档

README：

- 默认自动拉起，无需每次 `npm run hub`
- 关闭方式、常驻说明、如何结束进程（任务管理器 / 结束占用 8765 的 node）
- 仍可手动 `npm run hub` 调试

`.trellis/spec/backend/multi-pi-lark-hub.md` 或 logging/quality 补一句 autostart 合约（实现后）。
