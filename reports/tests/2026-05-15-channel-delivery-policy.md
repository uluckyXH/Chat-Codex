# 2026-05-15 Channel Delivery Policy 测试报告

## 背景

微信渠道需要少发消息以规避连续出站限制，但后续还会接 Slack、Telegram、飞书等平台。渠道差异不应长期散落在 Bridge Core 的具体渠道名判断里，因此新增通用 `ChannelDeliveryPolicy` 设计。

## 变更

- 新增 `src/protocol/delivery-policy.ts`，定义 task-start、progress、`/progress` 和 refresh command 的投递策略。
- `ChannelAdapter` 增加可选 `getDeliveryPolicy(message?)`。
- `WeixinAdapter` 返回微信策略：不投递 task-start/progress，禁用 `/progress`，启用静默 `/fff`。
- Bridge 改为读取 delivery policy，不再根据渠道 ID 判断是否禁用微信进度。
- Mock channel 默认返回完整投递策略，便于测试非微信渠道和未来渠道的默认行为。
- 新增设计文档 `docs/channel-delivery-policy.zh-CN.md`，并更新文档索引。

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

- `Bridge uses delivery policy instead of channel id for progress suppression`
- `Bridge suppresses task start and progress on weixin while keeping final replies`
- `Bridge rejects progress command and silently accepts /fff on weixin`
- `Bridge reports progress disabled in weixin status`
- `Bridge hides progress command and shows /fff in weixin help`
