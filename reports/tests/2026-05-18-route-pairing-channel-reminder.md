# 测试报告：配对渠道侧提醒

## 测试目标

验证未配对的微信/飞书等需要配对的渠道收到消息时，会向渠道回复不含配对码的引导提示，让用户知道需要查看运行 `chat-codex` 的终端/TUI 日志完成配对；同时确认配对码仍只出现在本机日志里，不进入渠道消息。

## 测试环境

- 日期：2026-05-18
- 分支：main
- Node.js：v24.13.1
- 操作系统：macOS 26.3.1
- 渠道：Mock 模拟真实微信/飞书 channel id

## 执行命令

```bash
npm run build
node --test dist/tests/integration/bridge-route-pairing.test.js dist/tests/unit/pairing-code-manager.test.js
npm test
git diff --check
```

## 测试步骤

1. 模拟未配对飞书私聊发送普通消息。
2. 确认渠道收到“查看终端/TUI 日志并发送 `/pair <配对码>`”的引导，且引导不包含实际配对码。
3. 模拟未配对 route 发送 `/status`，确认不会返回真实状态，只返回配对引导。
4. 模拟错误 `/pair`，确认渠道收到失败提示但不包含正确配对码。
5. 模拟正确 `/pair`，确认配对成功后普通消息进入 Codex。
6. 跑全量测试确认现有配对持久化、微信 pending binding、飞书 chat_id 隔离和其它 Bridge 功能不回归。

## 实际结果

- 目标测试：10 passed，0 failed。
- 全量 `npm test`：323 passed，0 failed。
- `git diff --check` 通过。

关键行为：

- 未配对 route 会回复不含配对码的配对引导。
- 配对码仍只通过本机 transcript/logger/TUI 日志展示。
- 错误配对码不会泄露正确配对码。
- 未配对 route 仍不会创建 session、执行命令或消费微信 pending 主聊天绑定。

## 结论

通过。配对流程已补齐渠道侧可见引导。

## 遗留问题

- 真实微信/飞书通道的用户体验待后续人工实测。
