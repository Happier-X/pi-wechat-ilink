# Implement: Fix WeChat prompts leaking into Pi editor

## Checklist

1. **Add extension queue state** in `src/index.ts`
   - `wechatQueue`, `drainingQueue`, types
   - helpers: `enqueueWechatTask`, `tryDrainWechatQueue`, `clearWechatQueue`, `clearQrChrome`

2. **Change busy-path ingress**
   - Remove `pi.sendUserMessage(text, { deliverAs: "followUp" })`
   - Enqueue + WeChat queued ack instead

3. **Drain on `agent_settled`**
   - After current WeChat reply / proactive notice branch
   - Only when idle; one message per settle
   - Set `currentWechatRequest` / `currentRunFromWechat` before submit

4. **Login callbacks**
   - `onVerifyCode` → `ctx.ui.input` when `hasUI`
   - `onQrUrl` → generate QR string to widget (no stderr in TUI)
   - `onScanned` / `onExpired` status updates
   - Clear widget on success, failure, stop, shutdown

5. **Shutdown / stop cleanup**
   - Clear queue + QR widget on `session_shutdown` and `/wechat-stop`

6. **Validate**
   - `npm run typecheck`
   - Manual smoke (see below)

7. **Docs (light)**
   - README note: busy messages queue inside extension; abort does not dump them into the editor
   - Optional CHANGELOG entry

## Validation commands

```bash
npm run typecheck
```

Manual (TUI):

1. `/wechat` — QR appears in widget/status, not as garbage in the input box.
2. If pairing code required — Pi input dialog, not raw terminal prompt.
3. Start a long local task; send WeChat text — get “已排队”; editor stays empty.
4. Escape/abort local task — editor still empty; queued WeChat task starts after settle.
5. Idle WeChat message — still runs immediately and replies as before.

## Risky points

| Risk | Mitigation |
|------|------------|
| Double-reply if drain races with `currentRunFromWechat` | Drain only after clearing current WeChat request flags; `drainingQueue` guard |
| `sendUserMessage` throws on drain | Catch, WeChat error reply, continue or stop drain |
| `setWidget` with huge QR | Use `small: true` QR; truncate URL line if needed |
| `hasUI` false during session_start connect | Keep non-UI URL fallback; skip input-based verify (fail closed) |

## Rollback

`git checkout -- src/index.ts README.md CHANGELOG.md` (as applicable).

## Done when

All PRD acceptance criteria AC1–AC6 satisfied.
