# 设计：移除微信，产品化为 pi-lark

## 范围

破坏性产品切换，**不**改变 hub/bridge 协议与路由语义；只移除微信表面并统一命名。

## 代码结构（目标）

```
src/
  index.ts              # re-export default from lark-bridge
  lark-bridge/index.ts  # 唯一 Pi 扩展实现
  protocol.ts
  hub/**                # 守护进程
scripts/pi-lark-hub.mjs
docs/lark-hub.md
```

删除：

- 原微信 `src/index.ts` 实现体
- `src/qrcode-terminal.d.ts`
- node_modules 中微信依赖（经 package.json 移除后 npm install）

## package.json

| 字段 | 目标 |
|------|------|
| name | `pi-lark` |
| description | multi-Pi 飞书远程 / hub + bridge |
| keywords | pi, lark, feishu, multi-pi, hub…（去掉 wechat/weixin/ilink 主词） |
| pi.extensions | `["./src/index.ts"]` 或 `["./src/lark-bridge/index.ts"]`；与 re-export 一致即可 |
| bin | 保持 `pi-lark-hub` → scripts |
| dependencies | 移除 `@wechatbot/wechatbot`、`qrcode-terminal`；保留 `ws` 等 hub 依赖 |
| repository | URL 写 `Happier-X/pi-lark`（文档意图）；用户自行 Rename 远端 |

## 文档

- README：安装 → `npm run hub` → `pi install` / `-e` → `/lark-status` / `/lark-ask` → 配置飞书
- 明确：GitHub 仓库若仍显示旧名，在 Settings → Rename
- CHANGELOG Unreleased：`Removed` 微信；`Changed` 包名 pi-lark

## Spec

- `quality-guidelines.md`：示例从 wechatQueue 扩到「任意远程扩展 FIFO」；删除「本包是微信扩展」总述中的唯一性
- `error-handling.md`：微信专用矩阵可删或改为「历史/不适用」；指向 multi-pi-lark-hub
- `multi-pi-lark-hub.md`：包名引用改为 pi-lark

## 风险

| 风险 | 处理 |
|------|------|
| 用户本机仍 `pi install` 旧路径/旧包名 | README 迁移说明；index re-export 减轻路径断裂 |
| repository URL 与真实 GitHub 暂不一致 | README 醒目标注 |
| lockfile 残留 | `npm install` 刷新 |

## 回滚

`git revert` 本任务提交；微信实现从历史恢复。
