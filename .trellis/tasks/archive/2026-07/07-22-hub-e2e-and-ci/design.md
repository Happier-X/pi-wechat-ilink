# 设计

## e2e

- `src/hub/hub-e2e.test.ts`（或 `src/hub/server.e2e.test.ts`）
- helper：`withHub(options, async (hub, { wsUrl, httpOrigin }) => …)`
  - `startHubServer({ port: 0, host: 127.0.0.1, feishu: noop, allowedOpenIds: ['ou_test'], disableStatePersist: true })`
  - 客户端 `new WebSocket(\`ws://127.0.0.1:${hub.port}\`)`
  - finally `hub.close()` + socket close
- 消息收发：`onceMessage(ws, predicate, timeout)`

## 脚本

```json
"check": "tsc --noEmit && node --check scripts/pi-lark-hub.mjs",
"test": "tsx --test \"src/**/*.test.ts\"",
"prepublishOnly": "npm run typecheck && npm test"
```

Windows：tsx --test 对 glob 支持需确认；若不行用 `node --import tsx --test --test-reporter spec` 或小脚本 `scripts/run-tests.mjs` 用 fs 递归收集。

优先：`scripts/run-tests.mjs` 递归 `src/**/*.test.ts` 再 `spawn tsx --test ...files`，跨平台可靠。

## CI（可选轻量）

`.github/workflows/ci.yml`：node 20，npm ci，typecheck，test。
