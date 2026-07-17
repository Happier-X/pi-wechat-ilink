# 实现清单：remove-wechat-lark-primary

1. **替换 `src/index.ts`** 为 re-export lark-bridge；删除微信实现。
2. **删除** `src/qrcode-terminal.d.ts`。
3. **更新 `package.json`**：name `pi-lark`、description、keywords、repository/homepage/bugs、extensions、dependencies；跑 `npm install` 更新 lock。
4. **重写 README.md** 为 pi-lark 主文档（可精简，链到 `docs/lark-hub.md`）。
5. **更新 CHANGELOG.md** Removed/Changed。
6. **更新 docs/lark-hub.md** 包名与安装路径。
7. **更新 Trellis spec**（quality / error-handling / multi-pi-lark-hub / index）。
8. **全局搜索** wechat/weixin/ilink/@wechatbot（除 archive task 历史与 CHANGELOG 旧条）并清理。
9. **验证**：`npm run typecheck`、`npm test`。

## 不做

- `git remote set-url` / GitHub API rename
- npm publish
