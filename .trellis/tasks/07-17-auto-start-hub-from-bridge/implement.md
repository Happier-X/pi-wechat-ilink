# 实现清单：Bridge 自动拉起本机 Hub

## 前置

- [x] PRD 收敛（常驻、再 spawn+冷却、GitHub 安装）
- [x] design.md

## 实现顺序

### 1. `src/lark-bridge/hub-autostart.ts`

- [x] `isAutostartEnabled(env): boolean` — 默认 true；`0/false/no/off` 为 false
- [x] `hubUrlToHttpOrigin(wsUrl): string | null` — 仅 127.0.0.1/localhost
- [x] `probeHubHealth(httpOrigin, timeoutMs): Promise<boolean>` — GET `/health`，`ok===true`
- [x] `resolvePackageRoot(fromUrl = import.meta.url): string`
- [x] `resolveHubSpawnSpec(packageRoot): { cmd, args, cwd } | { error: string }`
- [x] `spawnHubDetached(spec): { ok: true } | { ok: false, error: string }`
- [x] `ensureHubRunning(options): Promise<{ status: 'ready'|'skipped'|'spawned-ready'|'failed', detail?: string }>`
  - 内置 lastAttempt 冷却（默认 30s，options 可注入便于测）
  - 顺序：enabled → local only → health → cooldown → spawn → poll health（默认总等待 ~15s，间隔 300–500ms）

### 2. 接入 `src/lark-bridge/index.ts`

- [x] `session_start`：`await ensureHubRunning` 后 `connectHub`
- [x] `scheduleReconnect` / 断线重连路径：ensure（受冷却约束）后再 connect
- [x] 改写连接失败 notify：区分 autostart 失败 vs 关闭 autostart vs 仍在重试
- [x] 不在 `session_shutdown` kill hub

### 3. 测试

- [x] 纯函数单测：env、url 解析、cooldown 跳过（可 `tsx --test`，并挂到 package.json `test` 若合适）
- [x] 不强制 e2e 真 spawn（CI 可无）；本地手测清单见下
- [x] `npm run typecheck`
- [x] 既有 `npm test` 全绿

### 4. 文档与 spec

- [x] README：自动拉起 / 关闭 / 常驻 / 手动停
- [x] 更新 `.trellis/spec/backend/multi-pi-lark-hub.md`（或 logging）短节：autostart 合约
- [x] directory-structure / error-handling 同步

### 5. 手工验收

- [ ] 杀光 hub → 只开 Pi → 自动连上 `/lark-status`（需本机 Pi 手测）
- [ ] 已有 hub → 再开 Pi → 无异常双挂
- [ ] `PI_LARK_HUB_AUTOSTART=0` → 不 spawn
- [ ] 杀 hub 进程 → 等待冷却后恢复连接

## 验证命令

```bash
npm run typecheck
npm test
```

## 回滚点

- 单 commit 可逆；或 env 关闭 autostart 运行时回滚

## 非目标（实现时勿做）

- session_shutdown 杀 hub
- 系统服务
- 内嵌 hub
