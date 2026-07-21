# 实现清单：飞书出站卡片 Markdown

## 验证命令

```bash
npm run typecheck
npm test
git diff --check
```

## 有序清单

1. [x] 新增纯函数模块（建议 `src/hub/feishu-outbound-format.ts`）  
   - `truncateForFeishu(text, max)`  
   - `buildInteractiveCardContent(title?, body)` → card JSON string  
   - `buildPlainTextContent(title?, body)` → text JSON string  
2. [x] 改造 `NativeFeishuTransport.send`：先 interactive，失败降级 text；解析 message_id  
3. [x] 扩展 `feishu-native.test.ts`（及可选 format 单测）覆盖：卡片结构、截断、降级、双失败  
4. [x] 更新 `docs/lark-hub.md` / README 一句：出站为卡片 Markdown，失败降级 text  
5. [x] 更新 `.trellis/spec/backend/multi-pi-lark-hub.md` 出站合约一行  
6. [x] `npm run typecheck` + 全量 `npm test` + `git diff --check`

## 风险文件

- `src/hub/feishu-native.ts`
- `src/hub/feishu-native.test.ts`
- 新建 `src/hub/feishu-outbound-format.ts`（及 test）

## 回滚点

- 恢复 `send` 仅 `msg_type=text` 即可

## 非范围

- 审批按钮、入站解析、拆多条消息
