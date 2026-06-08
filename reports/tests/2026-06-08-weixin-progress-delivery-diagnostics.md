# 测试报告：微信进度正文与工具进度冷却修复

## 测试目标

验证微信 detailed 进度投递调整：

- 普通文本进度发送到聊天渠道时不再额外添加 `Codex 进度:` 标题。
- TUI / transcript 仍能把普通文本进度标记为“进度”。
- 普通文本进度和结构化工具进度使用独立失败冷却，避免 `TOOL_CALL_START/RESULT` 失败后挡住 `文件变更完成` 等普通文本进度。
- 失败时本地日志和 transcript 保留完整正文与错误信息。

## 测试环境

- 日期：2026-06-08
- 分支/提交：`experiment/weixin-context-token-progress` / `09e7794`
- Node.js 版本：`v24.14.0`
- 操作系统：macOS Darwin 25.5.0 arm64
- Codex 版本：`codex-cli 0.137.0`
- 渠道：mock / weixin fake API / feishu fake transport

## 执行命令

```bash
npm run build
node --test dist/tests/unit/bridge-progress-delivery.test.js dist/tests/unit/bridge-delivery.test.js dist/tests/unit/transcript.test.js dist/tests/integration/bridge-mock.test.js dist/tests/integration/feishu-bridge.test.js
node --test dist/tests/unit/bridge-delivery.test.js dist/tests/unit/bridge-progress-delivery.test.js dist/tests/integration/bridge-mock.test.js
npm test
node --test dist/tests/unit/app-server-core-modules.test.js
npm test
```

## 测试步骤

1. 修改普通文本进度格式化逻辑，移除渠道消息正文里的 `Codex 进度:` 固定标题。
2. 新增 transcript `outboundProgress` 标记，使 TUI / console 不依赖正文前缀也能显示“进度”。
3. 将普通文本进度和结构化工具进度的失败冷却状态拆开。
4. 补充单元测试，覆盖工具进度失败后普通文本进度仍能投递。
5. 执行构建、定向测试和全量测试。
6. 更新微信工具进度诊断设计文档，明确两类进度冷却互不影响。

## 实际结果

- `npm run build` 通过。
- 定向测试通过：
  - `bridge-progress-delivery`
  - `bridge-delivery`
  - `transcript`
  - `bridge-mock`
  - `feishu-bridge`
- 新增回归用例 `BridgeDelivery keeps text progress delivery independent from tool progress failures` 通过。
- 第一次全量 `npm test` 中 `app-server rpc client starts stdio server...` 出现一次 `initialize` 超时；单独重跑该测试通过。
- 第二次全量 `npm test` 通过：`445 passed, 0 failed`。

## 结论

通过。

本轮本地自动化验证确认：普通文本进度和结构化工具进度的失败冷却已解耦，工具生命周期投递失败不会再阻断文件变更、分析中、命令摘要等普通文本进度。

## 遗留问题

- 真实微信客户端 detailed 模式下的连续投递体验仍需用户继续实测确认。
- `TOOL_CALL_START/RESULT` 是否保留在 detailed 模式仍需根据真实微信客户端展示价值决定；当前建议把它主要放在 `/progress tools` 实验路径。
