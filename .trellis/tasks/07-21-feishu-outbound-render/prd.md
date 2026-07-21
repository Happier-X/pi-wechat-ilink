# PRD：飞书出站消息美化渲染

## 目标

把发给飞书的任务结果/通知从纯文本 `msg_type=text`，改为飞书 interactive 卡片 Markdown 渲染，让表格、代码块、标题、列表更易读；发送失败时安全降级为纯文本，不丢通知。

## 背景与已确认事实

- 当前 `NativeFeishuTransport.send` 固定：

  ```ts
  msg_type: "text"
  content: JSON.stringify({ text: title + "\n" + body })
  ```

- 任务结束摘要来自 assistant 文本，常含 Markdown 表格、代码块、列表。
- 飞书 `text` 消息不渲染 Markdown，表格与围栏代码块观感差。
- 出站统一经 Hub：`notify` → `feishu.send(...)`（任务结束、审批等共用）。
- 需要保留真实 `message_id` 绑定；失败不能静默丢消息。
- cc-connect 使用 `interactive` + `elements: [{ tag: "markdown", content }]`。
- bridge 任务摘要约 800 字截断；出站层仍需统一安全长度。

## 需求

| ID | 需求 |
|----|------|
| R1 | **全部出站**（任务结束、审批、其他 notify）统一走富渲染 |
| R2 | 优先 `msg_type=interactive`：header 放 title，body 用 markdown 模块渲染正文 |
| R3 | 至少明显改善表格、代码块、标题、列表在飞书中的可读性 |
| R4 | 继续返回真实 `message_id`，回复路由绑定不回归 |
| R5 | 卡片发送失败时降级 `msg_type=text`；仍返回成功发送的 `message_id` |
| R6 | **单条截断**：超长内容在出站层截断并追加 `…（已截断）`，不拆多条 |
| R7 | 不扩大公网暴露面，不改变 `/lark` 开局与入站协议 |
| R8 | 不实现审批按钮交互 UI（仍可文本批准/拒绝） |

## 已决策

| 键 | 决策 |
|----|------|
| 覆盖范围 | A：全部出站统一富渲染 |
| 渲染载体 | C：优先 interactive 卡片 markdown，失败降级 text |
| 超长内容 | A：单条截断 + 末尾提示，不拆多条 |

## 验收标准

1. 含 Markdown 表格/代码块的任务结束或审批通知，在飞书中以卡片 Markdown 展示，可读性明显优于当前纯文本。
2. `feishu.send` 仍返回可绑定 `message_id`；回复该消息仍路由到正确 Pi。
3. 卡片 API/格式失败时自动降级 text；两条都失败才向上报错，不崩溃 Hub。
4. 超长正文只发一条消息，末尾含截断提示。
5. 不新增 `/lark-*` 命令，不改扫码开局流程。
6. `npm run typecheck` 与相关单测通过。

## 非目标

- 完整交互卡片 2.0 / 审批按钮 UI
- 入站 Markdown 解析改造
- 多主人 / 群聊专门排版
- 流式分片、附件、图片上传

## 技术备注（实现边界）

- 改动中心：`NativeFeishuTransport.send` + 可选 `buildOutboundCard` 纯函数
- 协议 `notify` 字段可不变；title/body 仍由 bridge 组装
- 绑定使用最终成功发送的 `message_id`（卡片成功用卡片 id；降级 text 用 text id）
