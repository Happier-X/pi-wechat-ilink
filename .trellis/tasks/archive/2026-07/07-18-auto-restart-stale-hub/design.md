# 设计：更新后自动重启过期 Hub

## Health 合约

`GET /health` 新增：

```ts
{
  pid: number,
  packageVersion: string,
  features: string[] // 至少 "pair_begin"
}
```

版本从 package.json 读取/常量导出；版本仅诊断。stale 由能力集判定。

## Bridge ensure 流程

```text
ensureHubRunning(loopback)
  → fetch health detail
  → health 不通：既有 spawn
  → health ok + features 满足 REQUIRED_HUB_FEATURES：ready
  → health ok + 缺能力：stale
       ├─ AUTORESTART off → skipped/detail 提示
       ├─ 无合法 pid → failed/detail 手动重启
       └─ 有 pid → process.kill(pid, SIGTERM)
                    等 health 下线（短 timeout）
                    spawn 当前包 Hub
                    轮询 health ready + required features
```

## 常量/函数

| 名称 | 说明 |
|------|------|
| `HUB_FEATURES` | Hub 暴露能力（`["pair_begin"]`，未来追加） |
| `REQUIRED_HUB_FEATURES` | Bridge 最低要求（当前同上） |
| `isHubCompatible(status, required)` | 纯函数 |
| `isHubAutorestartEnabled(env)` | 默认 true，falsy 关闭 |
| `stopStaleHub(pid)` | 仅正整数、禁止 `pid===process.pid`；`process.kill(pid,"SIGTERM")` |

## 多 Bridge 竞争

- 复用 module-level 冷却/重启锁（Promise 或 boolean）；同进程避免重复。
- 多个 Pi 进程仍可能同时检测 stale：一个 kill 成功，其它 kill 得 ESRCH，应继续探测；端口已下线后只有一个 spawn 成功，另一个 health 轮询可看到 ready。spawn 冷却为每 bridge 进程，不能彻底互斥；依赖端口占用让多余进程快速失败，最终 health ready。

## 错误/安全

- 非 loopback 不进入 restart。
- 无 pid / 非法 pid：不盲扫端口，提示手动。
- SIGTERM 后未退出：不 SIGKILL（MVP），提示失败。
- `PI_LARK_HUB_AUTORESTART=0` 只禁止 stale kill；原有 AUTOSTART 行为不变。

## 测试

- health parse：pid/version/features。
- compatibility：缺 features / 缺 pair / 满足。
- env falsy。
- ensure：compatible ready；stale+pid kill→spawn→ready；stale no pid failed；off skipped；non-loopback no kill。
