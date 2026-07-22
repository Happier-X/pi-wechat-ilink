# 设计：协议运行时校验

## 边界

- 唯一解码入口：`src/protocol.ts`（或同目录拆出的纯函数，仍由 protocol 导出）。
- 调用方：`src/hub/server.ts`（Pi→Hub）、`src/lark-bridge/index.ts`（Hub→Pi）。
- 不修改飞书出站格式与审批状态机逻辑。

## 数据流

```text
WS raw string
  → parse + size limit
  → decode by direction + type
  → typed message | DecodeError
  → Hub: safeSend error / Bridge: ignore + optional notify
```

## API 形状

```ts
type DecodeError = { ok: false; code: string; message: string };
type DecodeOk<T> = { ok: true; message: T };

function decodePiToHubMessage(raw: string): DecodeOk<PiToHubMessage> | DecodeError;
function decodeHubToPiMessage(raw: string): DecodeOk<HubToPiMessage> | DecodeError;
// 保留 parseProtocolMessage 为兼容薄封装或标记 deprecated，优先新 API
```

## 上限（初值，可集中常量）

| 字段 | 上限 |
|------|------|
| 帧 UTF-8 字节 | 256 KiB |
| title | 512 字符 |
| body/text | 200_000 字符（出站另有飞书限制） |
| cwd / displayName | 2048 / 128 |
| piId / requestId | 128 |
| capabilities / actions | 16 |
| url（lark_challenge） | 4096 |

## 错误码示例

`frame_too_large`、`invalid_json`、`unknown_type`、`wrong_direction`、`missing_field`、`invalid_enum`、`too_long`、`invalid_number`

## 兼容

- 合法现网消息继续成功。
- TypeScript 类型定义保留；运行时与类型对齐。
