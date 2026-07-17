# 实现计划

1. 依赖修复
   - [x] `tsx` 从 devDependencies 移至 dependencies
   - [x] 更新 package-lock
2. 诊断日志
   - [x] `defaultHubLogPath` / 创建目录 / append fd
   - [x] detached child stdout/stderr → `~/.pi/lark-hub/hub.log`
   - [x] 失败/超时文案附日志路径
3. 测试与文档
   - [x] 更新 hub-autostart 单测
   - [x] README 说明日志位置
   - [x] spec logging/autostart 合约更新
4. 验证
   - [x] `npm run typecheck`
   - [x] `npm test`（81/81）
   - [x] `npm install --omit=dev` 隔离验证 tsx 可用
