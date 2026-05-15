# 2026-05-15 微信渠道禁用进度投递测试报告

## 背景

真实微信侧长任务连续投递多条 start/progress 后，容易遇到出站消息被限流或丢显。当前策略改为只在微信渠道砍掉非关键投递：不发送 task-start，不发送 `assistant.progress`，保留最终回复、错误、审批、队列提示、媒体发送结果和用户主动命令回复。

## 变更

- 微信消息不再收到 `Codex 正在处理这条消息。` task-start 提示。
- 微信消息不再收到 `Codex 进度:`。
- 微信 `/progress` 返回拒绝说明，不修改投递模式。
- 微信 `/status` 显示 `Progress: disabled`。
- 微信 `/help` 隐藏 `/progress`，显示 `/fff`。
- `/fff` 只在微信渠道生效，静默处理，不回复、不入队、不转发给 Codex。
- 非微信渠道保留原有 progress 模式和 `/progress` 行为。

## 验证

已执行：

```bash
npm run build
node --test dist/tests/integration/bridge-mock.test.js
npm test
git diff --check
```

结果：

- `npm run build` 通过。
- `bridge-mock` 集成测试通过。
- `npm test` 全量通过。
- `git diff --check` 通过。

新增/覆盖的关键用例：

- `Bridge suppresses task start and progress on weixin while keeping final replies`
- `Bridge still sends errors on weixin when progress is disabled`
- `Bridge rejects progress command and silently accepts /fff on weixin`
- `Bridge reports progress disabled in weixin status`
- `Bridge hides progress command and shows /fff in weixin help`
