# 测试报告：进度模式精简

## 测试目标

验证 `/progress` 用户可见模式精简：

- 微信只公开 `silent`、`brief`。
- 飞书只公开 `realtime`、`silent`、`brief`。
- `detailed`、`tools` 代码能力保留，但不再作为普通 `/progress` 可选项展示或接受。
- 飞书 `realtime` 仍能逐条投递普通文本进度。
- 微信 `brief` 仍能投递摘要普通文本进度，且不发送结构化工具生命周期。

## 测试环境

- 日期：2026-06-08
- 分支/提交：`experiment/weixin-context-token-progress` / 未提交工作区改动
- Node.js 版本：`v24.14.0`
- 操作系统：macOS Darwin 25.5.0 arm64
- Codex 版本：`codex-cli 0.137.0`
- 渠道：mock / weixin-like mock / feishu fake transport

## 执行命令

```bash
npm run build
node --test dist/tests/integration/bridge-mock.test.js dist/tests/integration/feishu-bridge.test.js dist/tests/integration/weixin-adapter-api.test.js dist/tests/unit/feishu-adapter.test.js dist/tests/unit/bridge-progress-delivery.test.js dist/tests/unit/bridge-delivery.test.js dist/tests/unit/bridge-command-router.test.js dist/tests/unit/bridge-formatters.test.js
npm test
```

## 测试步骤

1. 新增 `ChannelDeliveryPolicy.allowedProgressModes`，用于控制 `/progress` 公开可见和可设置模式。
2. 默认渠道公开 `silent/brief`，默认有效模式为 `brief`。
3. 微信策略公开 `silent/brief`，默认有效模式为 `silent`，继续 suppress realtime。
4. 飞书策略公开 `realtime/silent/brief`，默认有效模式为 `brief`，允许 realtime。
5. 更新 `/help`、`/progress` 状态文案和错误文案，只展示 policy 允许的模式。
6. 补充和调整测试，覆盖微信拒绝 `detailed/tools/realtime`、飞书拒绝 `detailed`、飞书 realtime 逐条发送、默认 mock 拒绝 `detailed`。

## 实际结果

- `npm run build` 通过。
- 定向测试通过：`180 passed, 0 failed`。
- 全量 `npm test` 通过：`455 passed, 0 failed`。

## 结论

通过。

## 遗留问题

- 真实飞书 realtime 连续投递仍需用户实测平台限流、丢显和乱序表现。
- 微信结构化工具生命周期发送代码保留；如果后续微信客户端有明确 UI 价值，再考虑通过调试入口重新开放。
