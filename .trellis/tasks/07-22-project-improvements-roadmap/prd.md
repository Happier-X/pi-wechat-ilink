# 审查项目优化与新功能机会

## 目标

系统审查 `pi-lark-hub` 的代码质量、可靠性、用户体验和产品能力，形成有代码依据、按优先级排序的优化与新功能路线图，供后续拆分为可独立验收的实施任务。

## 背景

- 审查范围：`src/protocol.ts`、`src/hub/*`、`src/lark-bridge/*`、测试/文档/脚本与 `.trellis/spec`。
- 项目约 6200 行 TypeScript，约 94+ 测试用例；标准命令 `npm run typecheck`、`npm test`。
- 产品约束：本机 loopback、多 Pi、单可信飞书主人；不强制公网回调；审批超时拒绝；目标 Pi 离线不改投。

## 交付物

1. `research/reliability-security-protocol-test-gaps.md` — 可靠性/安全/协议/测试缺口。
2. `research/ux-feature-opportunities.md` — UX 与新功能 MVP。
3. `roadmap.md` — P0/P1/P2 决策路线图、依赖与子任务建议。
4. `design.md` / `implement.md` — 本任务分析方法与完成步骤。

## 需求

1. 每项改进含：问题证据（路径/行号或 research 引用）、用户价值、风险、建议方案、影响模块、验收方式。
2. 明确区分：必须先做的可靠性/安全、面向用户的新功能、可选工程治理。
3. 候选功能给出 MVP 边界、依赖与不做事项。
4. 本任务不修改业务代码；实施另建子任务。

## 验收标准

- [x] 产出按 P0/P1/P2 排序的改进清单（见 `roadmap.md` + research）。
- [x] 区分可靠性/安全、UX 新功能、工程治理。
- [x] 候选功能含 MVP、依赖、不做事项。
- [x] 不直接实施具体功能代码。
- [x] 与当前代码与项目约束一致（loopback、fail-closed、secret 脱敏）。

## 已确认产品决策

- 本任务默认只输出审查与路线图。
- 若进入实施：优先二选一独立 MVP——「协议运行时校验」或「审批卡片按钮回调」。
