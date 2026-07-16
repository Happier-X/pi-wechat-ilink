# Design: Fix WeChat prompts leaking into Pi editor

## Problem

Three extension paths can pollute or corrupt the Pi TUI editor / frame:

1. Busy-path WeChat text uses Pi `followUp` → abort restores it into the editor.
2. Pairing-code default uses `process.stdin` readline under raw-mode TUI.
3. QR art is written to `process.stderr`, dirtying the alternate-screen TUI.

## Approach

All fixes stay inside `src/index.ts` (plus tiny helpers if needed). Do not patch Pi core.

### 1. Extension-owned WeChat queue

**State**

```ts
type QueuedWechatTask = {
  msg: IncomingMessage;
  text: string;
  enqueuedAt: number;
};

const wechatQueue: QueuedWechatTask[] = [];
let drainingQueue = false; // re-entrancy guard
```

**Ingress (`onWechatMessage` task path)**

| Agent state | Action |
|-------------|--------|
| Idle | Set `currentWechatRequest` / `currentRunFromWechat`, then `pi.sendUserMessage(text)` (no `deliverAs`). |
| Busy | Push `{ msg, text }` onto `wechatQueue`. WeChat reply: queued notice. Do **not** call `sendUserMessage(..., { deliverAs: "followUp" })`. |

Control-plane messages (批准/拒绝/待审批/状态) stay as today and never enter the queue.

**Drain**

Hook `agent_settled` (and optionally a short idle check):

1. If `!ctx.isIdle()` or `drainingQueue` or queue empty → skip drain (still run existing reply / proactive-notice logic first as appropriate).
2. Dequeue **one** item (FIFO).
3. Mark it as the active WeChat request (`currentWechatRequest`, `currentRunFromWechat = true`).
4. `pi.sendUserMessage(item.text)` without `deliverAs`.
5. Further queue items wait for the next settle.

**Ordering with existing `agent_settled` reply logic**

Current handler replies to `currentWechatRequest` then clears flags. Drain must run **after** that reply path finishes for the current request, so:

```
agent_settled:
  if currentRunFromWechat && currentWechatRequest:
    reply answer; clear current flags
  else if proactive local-run notice:
    ...
  // then
  tryDrainWechatQueue(ctx)
```

**Abort behavior**

- Extension never places WeChat text into Pi's steering/followUp queues → abort cannot restore it into the editor.
- Items already in `wechatQueue` remain until drain.
- If user aborts mid WeChat-driven run: that turn ends without a useful answer; reply a short “已中止/未完成” if we still hold `currentWechatRequest`, then drain next queued item on settle. (Optional polish: distinguish abort vs normal empty answer — keep minimal: reuse existing empty-answer fallback or a clearer abort string if stopReason is visible; if not visible, keep generic fallback.)

**Session shutdown**

Clear `wechatQueue`. Optionally best-effort WeChat notify “会话已结束，未处理 N 条” — nice-to-have, not required for AC.

### 2. Pairing code via `ctx.ui.input`

In `bot.login({ callbacks })` add:

```ts
onVerifyCode: async (isRetry) => {
  if (!ctx.hasUI) {
    // no TUI: return "" or throw so login fails without stdin
    throw new Error("需要配对码，但当前模式无 UI");
  }
  const code = await ctx.ui.input(
    isRetry ? "配对码错误，请重新输入微信显示的配对码" : "请输入微信显示的配对码",
    "6 位配对码",
  );
  if (!code?.trim()) throw new Error("未输入配对码");
  return code.trim();
}
```

Never call SDK default stdin path when `hasUI` is true.

### 3. QR / login chrome via Pi UI

**TUI / hasUI**

- `onQrUrl(url)`:
  - Build small QR string via `qrcode-terminal.generate(url, { small: true }, cb)` (callback only; do not write stderr).
  - `ctx.ui.setWidget("wechat-ilink-qr", [ "请使用手机微信扫码", ...qrLines, "", `或打开: ${url}` ])`
  - `status("请用微信扫码确认…")`
- `onScanned` / `onExpired`: update status; on expired refresh widget text or wait for next `onQrUrl`.
- On login success / failure / `wechat-stop` / `session_shutdown`: `setWidget("wechat-ilink-qr", undefined)`.

**No UI (print/json)**

- Single-line or compact stderr URL fallback is acceptable so headless still works.
- Skip multi-line QR art if it risks log noise; URL is enough.

### 4. Non-goals / trade-offs

| Trade-off | Choice |
|-----------|--------|
| Use Pi followUp vs own queue | Own queue — only way to guarantee no editor restore without patching Pi |
| Drain one vs many per settle | One per settle — matches single `currentWechatRequest` reply model |
| Full-screen QR `custom()` overlay | Prefer `setWidget` — non-blocking, user can still type; QR is temporary chrome |
| Patch Pi core restore filter | Out of scope |

## Data flow (busy path)

```
WeChat text
  → onWechatMessage
  → agent busy?
       yes → wechatQueue.push + WeChat "已排队"
       no  → sendUserMessage(text)
  → ... agent runs ...
  → agent_settled
       → reply current WeChat answer if any
       → tryDrainWechatQueue → sendUserMessage(next)
```

## Compatibility

- Saved credentials / auto-reconnect on `session_start` unchanged.
- Dangerous-command approval unchanged.
- WeChat control commands unchanged.
- Existing idle-path `sendUserMessage` unchanged.

## Rollback

Revert `src/index.ts` to previous behavior (followUp + stderr QR). No data migration.
