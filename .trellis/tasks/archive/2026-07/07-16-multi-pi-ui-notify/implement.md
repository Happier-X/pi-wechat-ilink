# 实现计划：多 Pi 飞书通知与回复路由

## 阶段划分（建议按可验证切片交付）

### 阶段 0 — 骨架

1. 确定目录：`hub/` + `extensions/lark/`（或 packages）  
2. 定义共享协议类型与 JSON schema  
3. hub 可启动，监听 loopback，健康检查  

**验收：** `hub --help` / 启动后端口存活  

### 阶段 1 — 注册与列表

1. Pi 扩展 session_start 注册 + 心跳  
2. hub 维护在线表  
3. 飞书：`列表` / `使用` 命令  

**验收：** 两 Pi 在线，飞书列表可见两个实例  

### 阶段 2 — 任务结束通知 + 回复路由

1. `agent_settled` → hub → 飞书摘要  
2. message_id 绑定 piId  
3. 回复通知 / 默认路由 / 单在线自动默认  

**验收：** AC3、AC4、AC6、AC7  

### 阶段 3 — 审批卡片

1. 危险 bash 拦截 → 卡片  
2. card.action → approval_result → 扩展放行/阻断  
3. 幂等与超时；与本机 UI 竞速  

**验收：** AC2、AC5（离线）、AC8  

### 阶段 4 — 需回复（最小）

1. 桥接至少一种显式输入路径，或先做「扩展 API：requestUserInput」  
2. 若工期紧，可标为阶段 4 可选，但 PRD R3 需有最小实现或明确砍 scope  

**验收：** 显式 need_reply 一轮闭环  

### 阶段 5 — 硬化

1. 白名单、hub 重启恢复策略、日志  
2. 类型检查与核心单测（路由表、幂等、默认选择）  
3. README：安装飞书应用、配置、启动顺序  

## 验证命令（待骨架落地后补全）

```bash
# 示例
npm run typecheck
npm test -- workspace hub
# 手动：两终端 pi + hub + 飞书私聊
```

## 风险与回滚点

| 风险 | 缓解 |
|------|------|
| 飞书权限/事件配置踩坑 | 文档 checklist；先用 lark-cli 验证 |
| 扩展与 hub 协议漂移 | 共享类型包 + 版本字段 |
| need_reply 桥接 Pi UI 困难 | MVP 可先审批+结束，need_reply 用扩展命令触发 |
| 与 wechat 扩展同时加载冲突 | 默认同开时审批双发；文档建议只开一个远程通道 |

## 建议实现顺序

`协议 → hub 注册表 → 扩展心跳 → 飞书列表 → task_end → 路由 → 审批 → need_reply → 测试文档`

## 完成定义

PRD AC1–AC10 满足；hub 与扩展可本地安装使用；README 可独立走通。
