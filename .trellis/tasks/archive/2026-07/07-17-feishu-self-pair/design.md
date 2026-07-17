# 设计：飞书本人短码配对

## 流程

```text
Pi /lark-pair
  → WS pair_begin
  → Hub 生成 6 位码（排除易混字符），TTL 5min，单活跃会话
  → WS pair_challenge { code, expiresAt }
  → Bridge notify 展示码与口令模板

飞书 / POST /control/message { text: "配对 XXXXXX", openId }
  → handleControlMessage **先于白名单** 识别配对口令
  → 校验码 → 写配置 → 更新内存 allowlist/feishu → 废码
  → 回执 +（可选）WS pair_result 通知发起 Pi
```

## 协议（protocol.ts）

| 方向 | type | 字段 |
|------|------|------|
| Pi→Hub | `pair_begin` | `piId` |
| Hub→Pi | `pair_challenge` | `code`, `expiresAt`, `ttlMs` |
| Hub→Pi | `pair_result` | `ok`, `openId?`, `message` |

## 模块

| 文件 | 职责 |
|------|------|
| `src/hub/pairing.ts` | 生成/校验码、会话状态 |
| `src/hub/config.ts` | `saveHubOwnerBinding` 读改写 JSON；bootstrap 校验放宽 |
| `src/hub/control.ts` | 配对口令优先于 auth |
| `src/hub/server.ts` | pair_begin 处理；绑定后热更新 allowed set / feishu transport 收件人 |
| `src/protocol.ts` | 新消息类型 |
| `src/lark-bridge/index.ts` | `/lark-pair` + 处理 challenge/result |

## 配置落盘

路径：`config.configPath` 或 `defaultConfigPath()`。  
合并写入：保留其它字段；设 `allowedOpenIds`、`feishu.userId`、删 `feishu.chatId`；建议 `feishu.mode` 保持，`requireAllowlist: true`。

环境变量覆盖的字段：落盘后**下次启动**仍可能被 env 盖住——文档注明配对写入文件；若设了 `PI_LARK_ALLOWED_OPEN_IDS` 需自行清理。MVP 在绑定成功回执中提示。

## 安全

- 码：6 位，字符集去掉 0OIl1 等；内存存储；不写日志全文可截断。
- 无 openId 的配对请求失败。
- 白名单为空：仅配对命令放行；其它拒绝。
- 有白名单：配对仍可用（换绑），成功后覆盖为单主人。

## Bootstrap（lark-cli）

`assertValidHubConfig`：

- 允许 `allowedOpenIds` 为空（bootstrap）。
- 允许缺 userId/chatId 当白名单为空；非空白名单时仍要求收件人。

运行时：`isAuthorized` 在白名单为空时，**仅**对已识别的配对文本返回 true；或在 control 层先处理配对再 auth（推荐后者，auth 对空名单：非配对一律 false / 提示配对）。

当前 `allowed.size===0 → true` 会放行所有人——**必须改**：空名单时默认 **false**，配对分支先于 auth。

## 口令格式

正则：`/^(配对|pair)\s+([A-Za-z0-9]{4,8})$/i`  
展示统一大写码。
