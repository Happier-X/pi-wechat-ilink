# 设计：飞书出站卡片 Markdown

## 1. 架构

```text
Bridge notify(title, body)
  → Hub server.feishu.send({ title, body, ... })
    → NativeFeishuTransport
         1) buildInteractiveCard(title, body)
         2) im.message.create msg_type=interactive
         3) 失败 → create msg_type=text 纯文本
         4) 返回 message_id
```

- 不改 Pi↔Hub 协议字段。
- 不改 `/lark` 开局。
- `NoopFeishuTransport` 测试桩无需发真实卡片，可继续记录 title/body。

## 2. 卡片 JSON 合约

对齐 cc-connect 的轻量 interactive（非强制 schema 2.0 按钮）：

```json
{
  "config": { "wide_screen_mode": true },
  "header": {
    "title": { "tag": "plain_text", "content": "<title 或 默认 通知>" },
    "template": "blue"
  },
  "elements": [
    {
      "tag": "markdown",
      "content": "<截断后的 body Markdown>"
    }
  ]
}
```

规则：

| 字段 | 规则 |
|------|------|
| title 空 | header 用「通知」或仅 elements，无 header 亦可 |
| body 空 | markdown 放一个空格或「（无正文）」 |
| template | task_end 可用 green；approval 可用 orange；默认 blue（可由 event 映射，MVP 可先固定 blue） |

## 3. 截断

| 常量 | 建议初值 | 说明 |
|------|----------|------|
| `CARD_MARKDOWN_MAX` | 3500 字符 | markdown content 安全上限（留余量给 header） |
| `TEXT_FALLBACK_MAX` | 3500 字符 | 降级 text 同样截断 |

- 按 Unicode 码点或 JS string length 截断均可，但必须稳定可测。
- 截断后缀固定：`\n…（已截断）`
- 不在本任务拆多条消息。

## 4. 发送与降级

```text
try:
  create(interactive card) → message_id
catch cardError:
  log 不含 secret 的摘要
  try:
    create(text title\\nbody) → message_id
  catch textError:
    throw 汇总错误（脱敏）
```

- 绑定层只看到最终成功的 `message_id`。
- 错误信息禁止回显 appSecret。

## 5. 测试

| 用例 | 断言 |
|------|------|
| 普通正文 | create 收到 `msg_type=interactive`，elements[0].tag=markdown |
| 含表格/代码块字符串 | content 原样进入 markdown（不做二次语法改写） |
| 超长 body | content 长度 ≤ 上限且含截断提示 |
| 卡片失败 | 第二次 create 为 text，返回 text 的 message_id |
| 双失败 | throw，消息含中文原因 |
| 未绑定主人 | 与现网一致，直接拒绝 |

## 6. 风险

| 风险 | 缓解 |
|------|------|
| 飞书 markdown 子集不完全支持 GFM 表格 | 仍优于纯 text；不在本任务做表格转置 |
| 卡片长度/模块限制 | 保守截断 + text 降级 |
| 审批期望按钮 | 明确非目标，继续文本「批准/拒绝」 |
