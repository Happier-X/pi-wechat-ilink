# Changelog

## Unreleased

### Removed

- 移除微信官方 iLink 通道运行时与依赖（`@wechatbot/wechatbot`、`qrcode-terminal`）及 `/wechat*` 命令
- 删除 `src/qrcode-terminal.d.ts`；原 `src/index.ts` 微信实现不再保留

### Changed

- 包名更名为 **`pi-lark-hub`**；产品主线为守护进程 + `lark-bridge`
- 默认扩展入口 `src/index.ts` 仅 re-export `./lark-bridge`
- `repository` / `homepage` / `bugs` 文档化为 `Happier-X/pi-lark-hub`（若 GitHub 远端仍为旧名，需用户自行 Rename / 改 remote）
- README / docs / Trellis spec 对齐飞书 multi-Pi，不再以微信为必选通道

### Features (historical, still in tree)

- Feat: Phase 5 配置硬化与可选真实飞书：`~/.pi/lark-hub/config.json` + env 合并；`LarkCliFeishuTransport`（lark-cli 出站）；可选 `event consume` 入站（失败不崩溃）；console 仍为默认离线模式；lark-cli 强制白名单
- Feat: Phase 4 显式 need_reply：`/lark-ask [prompt]` 经 Hub 出站；回复绑定携带 `replyToRequestId` 关联 pending；Hub 宕机本机 `ui.input` 降级；不自动 `sendUserMessage`
- Feat: Phase 3 审批卡片与回传：`ApprovalStore` 状态机（幂等/超时/离线不改投）；`POST /control/approval`、`GET /approvals`；lark-bridge 危险 bash 拦截与本机 UI 竞速；Hub 下发 `approval_result`
- Feat: Phase 2 task_end 通知 + 回复路由：`MessageBindingStore`、`notify_ack`、`replyToMessageId` 精确投递；`agent_settled` 上报摘要；`GET /notifications` 调试出站绑定
- Feat: Phase 0–1 multi-Pi local hub (`pi-lark-hub`) + `lark-bridge` extension skeleton (register / heartbeat / 列表·使用·默认路由；HTTP 模拟飞书入站；真实飞书 OpenAPI 后续阶段)
- Docs: `docs/lark-hub.md` 启动、task_end 与 replyToMessageId curl 验收说明

### Historical notes (pre-rename, WeChat era)

- Fix: busy-path WeChat tasks use an extension-owned queue instead of Pi `followUp`, so Escape/abort no longer dumps them into the TUI editor
- Fix: pairing code uses `ctx.ui.input` in TUI mode (no stdin readline fallback)
- Fix: QR login chrome uses Pi `setWidget` / status instead of multi-line stderr in TUI mode

## 0.1.0

- Initial release
- Official WeChat iLink login via QR code
- Inject WeChat text into the current Pi session
- Reply final Pi answer to WeChat on `agent_settled`
- Proactive completion notice for local Pi tasks
- Dangerous bash remote approval from WeChat
- Commands: `/wechat`, `/weixin`, `/wechat-status`, `/wechat-stop`, `/wechat-test`
