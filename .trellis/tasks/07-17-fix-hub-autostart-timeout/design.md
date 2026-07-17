# 设计：Git 安装后的 Hub 自动启动修复

## 根因修复

`tsx` 是 `scripts/pi-lark-hub.mjs` 的运行时依赖，因此从 `devDependencies` 移至 `dependencies`。Pi 文档说明 Git 包安装会运行 `npm install`；生产安装即会得到 tsx。

## 诊断日志

`spawnHubDetached` 不再用纯 `stdio: "ignore"`：

1. 创建 `~/.pi/lark-hub/`；
2. 以 append 打开 `hub.log`；
3. child stdin 为 ignore，stdout/stderr 都指向日志 fd；
4. spawn 后父进程关闭自己的 fd（子进程持有）；
5. 保持 detached + unref + windowsHide，不污染 Pi TUI。

日志路径可由 helper `defaultHubLogPath()` 返回，超时 detail 包含路径。

## 兼容与安全

- 无 secrets 新增输出；Hub 当前启动摘要包含脱敏 openId。
- 不改变 loopback 与 spawn 入口。
- 本地 `npm install` / Git install 均兼容。
- 若日志目录/文件创建失败，spawn 返回可操作错误；不降级到 TUI stderr。

## 验证

- typecheck + 全量测试。
- 临时目录执行 `npm install --omit=dev` 后验证 `tsx/cli` 可解析（或检查 package lock production graph）。
- 实际 Git 安装目录需 `pi update` 后才能获得修复；更新后手工 health 验收。
