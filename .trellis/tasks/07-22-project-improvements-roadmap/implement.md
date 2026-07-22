# 实施计划（本任务：路线图，非业务代码）

1. 完成代码与规格只读审查（已完成）。
2. 产出 `research/reliability-security-protocol-test-gaps.md` 与 `research/ux-feature-opportunities.md`（已完成）。
3. 收敛 `prd.md`，编写 `design.md`、`roadmap.md`。
4. 配置 `implement.jsonl` / `check.jsonl` 指向规格与 research。
5. 请用户审阅路线图；确认后 `task.py start`，将 `roadmap.md` 作为正式交付物做最后润色与归档。
6. **不**在本任务内改 `src/**`；用户选定下一项后另建子任务。

## 验证

- 路线图每项均有文件:行号证据或 research 引用。
- 验收标准可映射到后续子任务 PRD。
- 无业务代码 diff。

## 后续拆分建议（用户确认后）

| 顺序 | 子任务 slug 建议 | 类型 |
|------|------------------|------|
| 1a | `protocol-runtime-decode` | 可靠性 P0 |
| 1b | `approval-card-actions` | 产品 P0/P1 |
| 2 | `notify-idempotency-ack` | 可靠性 P0 |
| 3 | `lark-status-command` | UX P1 |
| 4 | `queue-inspect-cancel` | UX P1 |
| 5 | `control-plane-token` | 安全 P1 |
| 6 | `approval-binding-persist` | 可靠性 P0/P1 |
| 7 | `hub-e2e-test-fixture` | 工程 P2 |
