# 设计

- `http-guard.ts`：`readBodyLimited`、`TokenBucketRateLimiter`、`authorizeHttp`、`redactDiagnosticPayload`
- `HubConfig.control` + env `PI_LARK_HUB_CONTROL_TOKEN` 等
- `server.handleHttp` 统一 guard 后再分路由
- 不做：因 token 而监听非 loopback
