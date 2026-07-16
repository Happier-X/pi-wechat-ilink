# Research: Pi TUI editor leak paths relevant to wechat-ilink

## Pi followUp → editor restore

- Extension API: `pi.sendUserMessage(content, { deliverAs: "followUp" | "steer" })` maps to `AgentSession.prompt(..., { streamingBehavior })`.
- Interactive mode `restoreQueuedMessagesToEditor` (Escape/abort) calls `session.clearQueue()`, joins steering + followUp texts, and `editor.setText(combined)`.
- Therefore any WeChat busy-path use of `deliverAs: "followUp"` is restored into the editor on abort.

## Extension UI alternatives

- `ctx.ui.setWidget(key, lines | factory | undefined)` — chrome above/below editor; safe for QR/status.
- `ctx.ui.input(title, placeholder)` — modal input replacing editor temporarily; restores prior editor text on close (savedText pattern in interactive-mode).
- `ctx.ui.notify` / `setStatus` — toast/footer; not editor content.
- Avoid `process.stdin` / `process.stdout` readline while TUI is in raw mode.

## @wechatbot QrLoginCallbacks

```ts
onQrUrl?: (url: string) => void
onScanned?: () => void
onExpired?: () => void
onVerifyCode?: (isRetry: boolean) => string | Promise<string>
```

Missing `onVerifyCode` → SDK `createInterface({ input: process.stdin, output: process.stdout })`.

## qrcode-terminal

- `generate(input, opts, cb)`: if `cb` provided, only invokes callback with string; does not `console.log`.
- Current bug is our explicit `process.stderr.write` of that string, not the library default.

## agent_settled

- Fires when Pi will not auto-continue (no retry/compaction/follow-up left).
- Correct hook to reply on WeChat and then drain an extension-owned queue with `sendUserMessage` (no deliverAs) while idle.
