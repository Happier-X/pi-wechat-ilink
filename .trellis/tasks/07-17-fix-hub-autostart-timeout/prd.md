# PRD：修复 Git 安装后的 Hub 自动启动超时

## 根因（已复现）

Pi Git 安装位置：

```text
C:/Users/zhf52/.pi/agent/git/github.com/Happier-X/pi-lark-hub
```

直接运行自动拉起入口：

```bash
node scripts/pi-lark-hub.mjs
```

实际错误：

```text
[pi-lark-hub] 未找到 tsx。请在包根目录执行 npm install...
```

该安装目录没有 `node_modules/tsx`。当前 `package.json` 把 `tsx` 放在 `devDependencies`，但 `scripts/pi-lark-hub.mjs` 在**运行时**依赖 `tsx/cli`。Pi Git 安装环境未安装开发依赖，导致 detached 子进程立即退出；Bridge 因 `stdio: "ignore"` 只能在 15 秒后报告 health 超时。

## 目标

1. GitHub `pi install` 后，不需要用户手动 `npm install`，Hub 自动拉起即可工作。
2. 将运行时必需的 `tsx` 声明为生产依赖（或提供不依赖 tsx 的运行入口）；本任务采用最小兼容修复：**把 `tsx` 移到 `dependencies`**。
3. 自动拉起失败时保留可诊断信息，避免只显示泛化超时；至少把 detached Hub stdout/stderr 写入 `~/.pi/lark-hub/hub.log`，并在超时文案中给出日志路径。
4. 不破坏本地开发、手动 `npm run hub`、loopback/常驻/cooldown 合约。

## 非目标

- 将全部 TypeScript 预编译为 dist（可做后续发布优化）
- 改变 Pi 包管理器行为
- 改成系统服务

## 验收标准

1. `package.json` 中 `tsx` 位于 `dependencies`，`package-lock.json` 同步；Git 安装执行生产依赖安装后可 `require.resolve("tsx/cli")`。
2. 在不依赖仓库根 devDependencies 的隔离安装场景，`node scripts/pi-lark-hub.mjs` 能启动 Hub 并提供 `/health`。
3. detached Hub 输出写入 `~/.pi/lark-hub/hub.log`（append）；Bridge 超时/失败文案包含该路径。
4. `npm run typecheck` 通过，`npm test` 全绿；新增测试覆盖 spawn 日志选项/依赖声明（按可测性选择）。

## 实现范围

- `package.json` / `package-lock.json`
- `src/lark-bridge/hub-autostart.ts` 及测试
- README / 必要 spec

## 状态

- planning
- 根因已通过 Pi 实际 Git 安装目录复现，无需再询问产品决策
