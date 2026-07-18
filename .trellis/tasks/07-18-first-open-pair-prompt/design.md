# 设计：首次打开自动短码配对

## 流程

```text
session_start → ensureHub + WS 连接 + register
  → register_ok
  → bridge 判断 needsAutoPair（见下）
  → 若 true 且本进程尚未 autoPairAttempted：
        send pair_begin
        autoPairAttempted = true
  → 既有 pair_challenge / pair_result 展示逻辑不变
```

## 探测「需要引导」

Hub 暴露只读状态（二选一，推荐 health 扩展，bridge 也可在 register_ok 后 HTTP GET）：

### 方案（采用）

`GET /health` 增加字段（不泄露完整 openId 列表）：

```ts
{
  ok: true,
  // ...existing
  feishuMode: "console" | "lark-cli",
  ownerBound: boolean,      // allowedOpenIds.length > 0
  needsPairing: boolean,   // feishuMode === "lark-cli" && !ownerBound
}
```

Bridge：`register_ok` 后 `GET {httpOrigin}/health`（复用 hub-autostart 的 URL 推导），若 `needsPairing === true` 且 `!autoPairAttempted` → `pair_begin`。

可选增强（非必须）：`register_ok` payload 附带 `needsPairing`，省一次 HTTP；MVP 用 health 即可，少改协议。

## Bridge 状态

| 变量 | 含义 |
|------|------|
| `autoPairAttempted` | 本进程是否已自动发起过；`true` 后重连不再自动 |
| 手动 `/lark-pair` | 不读该标志，始终可发 |

`pair_result.ok === true` 后可不改标志（已 true）；已绑定路径根本不会自动发起。

## Hub 数据源

- `feishuMode`：来自 `hubConfigSnapshot?.feishu.mode`，缺省 `"console"`
- `ownerBound`：`allowed.size > 0`（与运行时 isAuthorized 同源）
- 配对成功热更新 `allowed` 后，health 立即反映 `ownerBound=true`

## 安全

- health 不返回 openId 明文列表（避免 loopback 外误配时的信息放大；仍仅 loopback）
- 自动配对不绕过短码 TTL / 用后即废

## 测试

- health 字段：unit 或轻量 server 测（若现有无 server 测，可抽纯函数 `computePairingHealth(allowedSize, mode)`）
- bridge：纯函数 `shouldAutoPair({ needsPairing, autoPairAttempted })` 单测
