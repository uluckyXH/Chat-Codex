# 测试报告：进度本地实时可观测与 realtime 模式

## 测试目标

验证本次进度投递调整：

- 非 realtime 模式下，Codex 产生的普通文本进度会立即写入本地 TUI / transcript，聊天渠道仍保留节流、合并、去重、截断和失败 cooldown。
- `/progress realtime` 下，普通文本进度在支持该能力的渠道逐条投递到聊天渠道，不走 Bridge 层节流、pending、合并、去重、截断和普通文本进度失败 cooldown。
- 微信-like 渠道按真实微信实测结论禁用 realtime，飞书渠道保留 realtime。
- 微信 `getConfig` typing ticket probe 间隔调整为 30 秒，Bridge typing tick 仍保持 5 秒；`getConfig` 不作为 `sendmessage ret=-2` 的修复手段。
- TUI / console transcript 能区分“本地进度”和“未投递失败诊断”。

## 测试环境

- 日期：2026-06-08
- 分支/提交：`experiment/weixin-context-token-progress` / 基线 `99a8b6c`，本轮为未提交工作区改动
- Node.js 版本：`v24.14.0`
- 操作系统：macOS Darwin 25.5.0 arm64
- Codex 版本：`codex-cli 0.137.0`
- 渠道：mock / weixin-like mock / feishu fake transport

## 执行命令

```bash
npm run build
node --test dist/tests/unit/bridge-progress-delivery.test.js dist/tests/unit/bridge-delivery.test.js dist/tests/unit/bridge-formatters.test.js dist/tests/unit/transcript.test.js dist/tests/unit/ink-tui.test.js dist/tests/integration/bridge-mock.test.js dist/tests/integration/feishu-bridge.test.js
node --test dist/tests/integration/weixin-adapter-api.test.js dist/tests/integration/bridge-mock.test.js dist/tests/integration/feishu-bridge.test.js dist/tests/unit/bridge-progress-delivery.test.js dist/tests/unit/bridge-delivery.test.js dist/tests/unit/bridge-formatters.test.js dist/tests/unit/transcript.test.js dist/tests/unit/ink-tui.test.js dist/tests/unit/bridge-command-router.test.js dist/tests/unit/channel-registry.test.js dist/tests/unit/feishu-adapter.test.js
npm test
```

## 测试步骤

1. 新增 transcript `observedProgress()`，用于显示 Codex 已产生但不代表已经投递到聊天渠道的本地实时进度。
2. 调整 `BridgeProgressDelivery`，在非 realtime 模式下先记录本地 observed progress，再继续使用原有节流和 pending 合并投递。
3. 新增 `BridgeDelivery.sendRealtimeProgressText()`，用于 realtime 普通文本进度逐条发送，失败不设置普通文本进度 cooldown。
4. 扩展 `/progress realtime` 的类型、解析、状态、帮助和 CLI 文案。
5. 根据真实微信 `ret=-2` 连续投递实测结论，新增 `ChannelDeliveryPolicy.realtimeProgress`，微信设为 `"suppress"`，飞书和默认渠道保留 `"send"`。
6. 补充单元测试和集成测试，覆盖微信-like detailed 本地实时可见、微信-like 拒绝 `/progress realtime`、飞书 realtime 逐条投递和 realtime 失败不 cooldown。
7. 将微信 `getConfig` typing ticket probe 间隔调整为 30 秒，并保留 5 秒 typing tick。
8. 执行构建、定向测试和全量测试。

## 实际结果

- `npm run build` 通过。
- 第一次定向测试中，`Runtime TUI renders startup summary and transcript logs` 因新增一条 observed progress 后视图默认展示最新日志，旧断言 `群消息` 被滚到上方而失败。
- 调整该测试为直接断言 store 数据保留全部日志，并在当前视图中断言 `本地进度` 和 `正在分析。`。
- 重新执行定向测试通过：`158 passed, 0 failed`。
- 按真实微信策略补充 `realtimeProgress` 后，执行 `npm run build` 通过。
- 执行扩展定向测试通过：`211 passed, 0 failed`。
- 全量 `npm test` 通过：`454 passed, 0 failed`。

## 结论

通过。

本轮自动化确认：非 realtime 模式下，本地日志能实时看到进度在推进，聊天渠道仍保持节流合并；飞书支持 realtime 的渠道中，普通文本进度会逐条发送，发送失败不会触发普通文本进度 cooldown；微信-like 渠道会拒绝 `/progress realtime`，帮助和错误文案只展示 `silent, brief`。

## 遗留问题

- 真实微信已观察到 realtime 连续投递 `ret=-2` 和消息堆积，因此当前不开放 realtime；后续如微信平台能力变化，再通过 `ChannelDeliveryPolicy.realtimeProgress` 放开。
- 真实飞书通道的 realtime 连续投递表现仍需用户实测确认，尤其是平台限流、丢显、乱序和单条超长消息失败。
- 微信 detailed 是否继续默认发送结构化 `TOOL_CALL_START/RESULT` 仍可后续按真实客户端展示价值再决定。
