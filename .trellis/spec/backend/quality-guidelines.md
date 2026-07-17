# Quality Guidelines

> Code quality standards for this Pi extension project (`pi-lark-hub`).

---

## Overview

This package is a **Pi coding-agent extension** for multi-Pi Feishu remote control (`pi-lark-hub` + `lark-bridge`). Quality rules focus on not corrupting the Pi TUI, not leaking remote control into the local editor, and keeping typecheck green.

---

## Forbidden Patterns

| Pattern | Why |
|---------|-----|
| `pi.sendUserMessage(text, { deliverAs: "followUp" })` (or `"steer"`) for **remote** tasks (Feishu / hub / any remote extension) | Pi interactive mode restores steering/follow-up queues into the **TUI editor** on Escape/abort (`restoreQueuedMessagesToEditor`). Remote text must not enter those queues. |
| `process.stdin` / Node `readline` prompts while Pi TUI is active | TUI uses raw mode; stdin prompts inject prompt text into the editor or corrupt the frame. Use `ctx.ui.input` / `select` / `confirm` when `ctx.hasUI`. |
| Multi-line `process.stderr.write` / `console.log` for banners in TUI mode | Alternate-screen TUI gets dirty; text can appear to “sit in” the input area. Use `ctx.ui.setWidget` / `notify` / `setStatus`. |
| Overwriting the remote reply slot while a remote run is already owned | Races between `agent_end`→`agent_settled` and new inbound messages lose or cross replies. Treat slot-busy as busy and enqueue. |
| Multi-Pi remote text without a hub route id | Must go through `pi-lark-hub` registration + default/reply/approval routing; never assume “the only Pi”. |
| lark-cli 空白名单时对**非配对**消息放行（`allowed.size===0 → true`） | 安全漏洞；空名单仅 bootstrap：配对口令可过，其它拒绝。console 开发空名单放行仍可。 |
| 配对鉴权放在白名单之后 | 首次无人在名单无法绑定 |

---

## Required Patterns

| Pattern | Rule |
|---------|------|
| Busy-path remote tasks | Extension-owned FIFO (e.g. lark-bridge queue); drain **one** item on `agent_settled` **after** clearing current remote flags; submit with `pi.sendUserMessage(text)` **without** `deliverAs`. |
| Multi-Pi Feishu path | Use `pi-lark-hub` + `lark-bridge`; see [multi-pi-lark-hub.md](./multi-pi-lark-hub.md). |
| Default package extension | `src/index.ts` re-exports lark-bridge; package `pi.extensions` loads the bridge by default. |
| Slot occupancy | Ingress treats “current remote run / current remote request / draining / !isIdle()” as busy → enqueue. |
| Typecheck | `npm run typecheck` must pass before claiming done. |

---

## Testing Requirements

- Minimum: `npm run typecheck`.
- Hub unit tests: `npm test`（`router` / `config` / `pairing` / `feishu-lark-cli` / `hub-autostart`）。
- Prefer manual TUI smoke for queue/abort/approval/need_reply until more automated tests exist.
- Future unit tests should cover: enqueue when slot busy; drain order; no `deliverAs` on remote paths.

---

## Code Review Checklist

- [ ] No remote path uses Pi followUp/steer queues
- [ ] No raw stdin/readline under TUI
- [ ] No multi-line stderr UI chrome under TUI
- [ ] Queue cleared on stop/shutdown
- [ ] `agent_settled` reply-then-drain ordering preserved
- [ ] Typecheck clean
