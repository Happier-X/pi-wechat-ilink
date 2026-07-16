# Fix WeChat prompts leaking into Pi editor

## Goal

Ensure WeChat iLink bridge prompts, status text, and remote user messages never appear as editable text in the Pi TUI input box. Users should only see intentional conversation / UI chrome, not leaked control-plane text or remote-injection leftovers.

## Background / Confirmed Facts

From code inspection of `src/index.ts` and Pi interactive mode:

1. **Abort restores queued messages into the editor**  
   When Pi is busy, WeChat text is submitted with `pi.sendUserMessage(text, { deliverAs: "followUp" })` (`src/index.ts` ~201). Pi's interactive mode `restoreQueuedMessagesToEditor` joins steering/follow-up queues into `editor.setText(...)` on Escape/abort. That is a primary “sometimes” path for WeChat task text landing in the input box.

2. **Pairing-code prompt uses process.stdin by default**  
   `@wechatbot` `promptVerifyCode` falls back to `readline` on `process.stdin` / `process.stdout` when `callbacks.onVerifyCode` is missing. This extension currently only passes `onQrUrl` / `onScanned` / `onExpired` during `bot.login()` — no `onVerifyCode`. In raw-mode TUI this can inject prompt text into the editor or corrupt the terminal.

3. **QR login writes raw stderr**  
   QR is rendered via `qrcode-terminal` + `process.stderr.write` rather than Pi UI (`setWidget` / `custom` / `notify`). This can dirty the TUI frame; less often it looks like text “in” the input area.

4. **Legitimate paths that are NOT bugs**  
   - `ctx.ui.notify` / `setStatus` (footer/toast, not editor)  
   - `ctx.ui.select` for local dangerous-command approval (replaces editor temporarily by design)  
   - Normal WeChat → `sendUserMessage` while idle (shows as a submitted user turn, not stuck in the editor)

## Decisions

| Decision | Choice | Notes |
|----------|--------|-------|
| Abort / Escape with pending WeChat messages | **A — keep extension-owned queue, never restore into editor** | After agent settles/idles, drain queue and auto-continue. Do not put WeChat busy-path messages into Pi's followUp queue. |
| MVP leak paths | **All three** | abort queue restore + pairing-code stdin + QR stderr |

## Requirements

- **R1 — No editor pollution from WeChat tasks**  
  WeChat-originated task text must never be written into the Pi TUI editor via abort, Escape, dequeue, or any extension lifecycle path.

- **R2 — Extension-owned pending queue**  
  When the agent is busy, inbound WeChat task text is enqueued in an extension-owned FIFO (not Pi `deliverAs: "followUp"`). On `agent_settled` / idle, the queue is drained by submitting the next item with `pi.sendUserMessage` only when `ctx.isIdle()` is true. Local abort must not drop the queue silently without user-visible handling: items remain queued and auto-resume after settle.

- **R3 — Pairing code via Pi UI**  
  Login must implement `QrLoginCallbacks.onVerifyCode` using `ctx.ui.input(...)` (guarded by `hasUI`). Never fall back to SDK stdin readline while a TUI session is active. Cancel / empty input should fail the login path cleanly with a notify, not hang stdin.

- **R4 — QR / login chrome via Pi UI**  
  QR URL and scan status must be shown through Pi UI (`ctx.ui.setWidget` and/or `notify` / `setStatus`), not `process.stderr.write` / raw console. Clear the QR widget on success, failure, stop, or session shutdown. When `hasUI` is false (print/json), a minimal non-TUI fallback is allowed (e.g. stderr once) without requiring widget APIs.

- **R5 — Busy-path UX on WeChat**  
  When a message is queued because Pi is busy, reply on WeChat that the instruction is queued and will run after the current task (existing “完成后继续处理” semantics, adjusted to match the new queue).

## Acceptance Criteria

- [x] **AC1** Aborting/Escaping a local run never leaves WeChat task text in the Pi editor (R1).
- [x] **AC2** A WeChat message received while busy remains in the extension queue after abort and is auto-submitted when the agent becomes idle again (R2).
- [x] **AC3** Code path no longer uses Pi `deliverAs: "followUp"` for WeChat busy-path injection (R1/R2).
- [x] **AC4** `onVerifyCode` is implemented with `ctx.ui.input`; no `readline` stdin prompt is used during TUI login (R3).
- [x] **AC5** QR login does not write multi-line QR art to stderr in TUI mode; uses widget/status/notify instead, and clears chrome after connect ends (R4).
- [x] **AC6** `npm run typecheck` passes.

## Out of Scope

- Changing Pi core `restoreQueuedMessagesToEditor` globally
- Full multi-user / multi-session WeChat isolation
- Redesigning dangerous-command approval UX
- npm publish / version bump (unless needed for local reload only)

## Related Files

- `src/index.ts` — primary change surface
- `@wechatbot/wechatbot` `QrLoginCallbacks` (`onVerifyCode`, `onQrUrl`, …)
- Pi interactive mode queue restore behavior (reference only; do not patch Pi)
