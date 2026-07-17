# 移除微信通道，以飞书 Multi-Pi 为主产品

## 目标

删除微信 iLink 通道；产品主线为 **`pi-lark-hub`**（本机守护进程 + `lark-bridge` 飞书 multi-Pi 远程控制）。包名、默认扩展、文档与 spec 与之对齐。

## 背景

微信 iLink 难以稳定支持多 Pi 并行会话，也缺少交互卡片等能力。用户明确不再保留微信功能。仓库内已有 hub/bridge 阶段 0–5 实现。

## 已确定决策

| 决策 | 选择 |
|------|------|
| 微信通道 | **完全移除**运行时与依赖 |
| 产品主线 | 飞书 multi-Pi：hub + lark-bridge |
| 包名 | **`pi-lark-hub`** |
| GitHub | **package/docs 按 `pi-lark` 书写**；GitHub 网页 Rename 与 `git remote` 由用户手动完成 |
| 默认扩展入口 | `pi.extensions` → lark-bridge；`src/index.ts` **仅 re-export** bridge（轻兼容旧 install 路径） |
| CHANGELOG | 保留历史；Unreleased/`Removed` 明确写移除微信 iLink |

## 需求

- **R1** 删除微信运行时实现；`src/index.ts` 改为 re-export `./lark-bridge/index.js`（或等价）。
- **R2** 删除 `src/qrcode-terminal.d.ts` 及微信专用依赖（`@wechatbot/wechatbot`、`qrcode-terminal`）。
- **R3** `package.json`：`name`=`pi-lark-hub`；keywords/description 去 wechat/weixin/ilink 主叙事；`pi.extensions` 默认 lark-bridge（及/或 index re-export）。
- **R4** repository/homepage/bugs URL 文档化为 `.../pi-lark-hub`（并 README 注明若远端仍为旧仓名需自行 Rename）。
- **R5** 重写 README 为 hub + bridge 主路径；删除 `/wechat*` 用法。
- **R6** CHANGELOG 增加移除说明，不抹掉既往提交历史叙述。
- **R7** Trellis spec：远程通道通用化；去掉「本包是微信扩展」的过时表述；保留 multi-pi-lark-hub。
- **R8** `npm run typecheck`、`npm test` 通过；`npm run hub` 仍可用。

## 验收标准

- [ ] **AC1** 依赖树与源码中无 `@wechatbot` / 微信 iLink 运行路径。
- [ ] **AC2** `package.json` name 为 `pi-lark-hub`；默认扩展可加载 bridge。
- [ ] **AC3** README 以 hub + bridge + 飞书配置为主，无微信安装主路径。
- [ ] **AC4** typecheck + test 通过。
- [ ] **AC5** spec 与质量文档不再把微信当作必选通道。

## 暂不纳入

- 代用户在 GitHub 上执行 Rename / 改 remote
- npm 正式 publish
- 飞书 interactive 卡片增强（既有后续项）
- 删除 git 历史中的旧提交

## 相关文件（预期）

- 删/改：`src/index.ts`、`src/qrcode-terminal.d.ts`、`package.json`、`package-lock.json`、`README.md`、`CHANGELOG.md`
- 改：`.trellis/spec/backend/*.md`、`docs/lark-hub.md`（包名引用）
- 保留：`src/hub/**`、`src/lark-bridge/**`、`src/protocol.ts`、`scripts/pi-lark-hub.mjs`
