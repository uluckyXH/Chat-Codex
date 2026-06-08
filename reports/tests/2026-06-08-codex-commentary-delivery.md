# 测试报告：Codex Commentary 旁白投递

## 测试目标

验证 Codex app-server `phase=commentary` 从普通进度中拆出为独立 `assistant.commentary` 后：

1. app-server adapter 不再把 commentary 映射成 `assistant.progress kind=other`。
2. 微信 `/progress brief` 会投递旁白。
3. 微信默认 `silent` 下 commentary-only turn 会兜底为最终回复。
4. 微信 `/plan` 默认 `silent` 下仍低频投递旁白，但不投递命令/工具进度。
5. 飞书 `brief` 和 `realtime` 下旁白按预期投递。
6. 本地 transcript / TUI 将旁白标记为“旁白”，不混入普通“进度”。

## 测试环境

- 日期：2026-06-08
- 分支：`experiment/weixin-context-token-progress`
- Node.js 版本：`v24.14.0`
- 操作系统：macOS Darwin 25.5.0 arm64
- Codex 版本：`codex-cli 0.137.0`
- 渠道：mock / weixin-like mock / feishu fake transport

## 执行命令

```bash
npm run build
node --test dist/tests/unit/app-server-codex-adapter.test.js dist/tests/unit/bridge-commentary-delivery.test.js dist/tests/unit/transcript.test.js dist/tests/unit/bridge-route-queue.test.js dist/tests/integration/bridge-mock.test.js dist/tests/integration/feishu-bridge.test.js
npm run build
node --test dist/tests/unit/ink-tui.test.js dist/tests/unit/app-server-codex-adapter.test.js dist/tests/unit/bridge-commentary-delivery.test.js dist/tests/unit/transcript.test.js dist/tests/unit/bridge-route-queue.test.js dist/tests/integration/bridge-mock.test.js dist/tests/integration/feishu-bridge.test.js
npm test
```

## 测试步骤

1. 编译 TypeScript，确认新增 `assistant.commentary` 类型、BridgeCommentaryDelivery、Bridge 路由处理和测试代码均可通过类型检查。
2. 运行 app-server adapter 单测，确认 `phase=commentary` 输出 `assistant.commentary`，chunked commentary 不重复，commentary-only turn 不伪造成 app-server final。
3. 运行 Bridge commentary delivery 单测，确认旁白独立低频合并、silent 本地记录、realtime 逐条投递。
4. 运行 Bridge mock 集成测试，覆盖微信 brief 旁白投递、微信 silent commentary-only 最终兜底、微信 `/plan` silent 下旁白投递且命令进度不投递。
5. 运行飞书 fake transport 集成测试，覆盖飞书 brief 旁白投递和 realtime 旁白逐条投递。
6. 运行 transcript / Ink TUI 测试，确认本地日志展示“旁白”。
7. 运行全量 `npm test`。

## 实际结果

- `npm run build`：通过。
- 定向测试第一次发现 `/plan` help 文案旧断言失败，更新测试预期后通过。
- 定向测试第二次发现 Runtime TUI 测试中新增旁白日志挤掉旧“本地进度”标题，拆成独立旁白渲染测试后通过。
- 定向测试最终通过：`188 passed, 0 failed`。
- 全量测试通过：`466 passed, 0 failed`。

## 结论

通过。

本次改动已完成 mock / fake transport 自动化验证。真实微信连续投递仍受微信渠道限制影响，旁白独立投递只能避免被普通进度策略误伤，不能保证微信平台永远接收连续消息。

## 遗留问题

- 真实微信需要用户后续实测：
  1. `/progress brief` 下普通任务是否能看到旁白。
  2. `/plan <任务>` 在微信默认 `silent` 下是否能看到计划旁白。
  3. commentary-only skill 输出是否能作为最终回复兜底出现。
- `/fff` 仍只是微信静默刷新入口，不是失败消息重发机制。
