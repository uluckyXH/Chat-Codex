# 测试报告：brief 进度周期投递修复

## 测试目标

验证 `/progress brief` 下，Codex 在长任务中产生的后续摘要进度不会只停留在 pending，应该在节流间隔到期后自动 flush 到聊天渠道；同时验证独立旁白投递器具备同样的周期 flush 行为，Plan mode 不会误投递命令进度和结构化工具生命周期。

## 测试环境

- 日期：2026-06-08 23:30:34 CST
- 分支/提交：`experiment/weixin-context-token-progress` / `99a8b6c`（工作区有未提交实验改动）
- Node.js 版本：`v24.14.0`
- 操作系统：Darwin Mac 25.5.0 arm64
- Codex 版本：`codex-cli 0.137.0`
- 渠道：mock / weixin-like / feishu mock

## 执行命令

```bash
npm run build
node --test dist/tests/unit/bridge-progress-delivery.test.js dist/tests/unit/bridge-commentary-delivery.test.js dist/tests/integration/bridge-mock.test.js
npm test
node --test dist/tests/unit/app-server-core-modules.test.js
npm test
```

## 测试步骤

1. 构建 TypeScript，确认新增定时 flush 逻辑无类型错误。
2. 运行进度投递器、旁白投递器和 Bridge mock 集成定向测试。
3. 第一次执行全量测试，记录 app-server RPC 初始化偶发超时。
4. 单独重跑失败文件，确认超时不可复现。
5. 第二次执行全量测试，确认全量通过。

## 实际结果

- `npm run build` 通过。
- 定向测试通过：`118 passed, 0 failed`。
- 第一次 `npm test`：`467 passed, 1 failed`，失败用例为 `app-server rpc client starts stdio server, dispatches responses, notifications, and stop`，错误为 `codex app-server request timed out: initialize`。该问题与本次进度投递改动无直接关系，且此前测试报告中也出现过同类偶发超时。
- 单独重跑 `node --test dist/tests/unit/app-server-core-modules.test.js` 通过：`5 passed, 0 failed`。
- 第二次 `npm test` 通过：`468 passed, 0 failed`。

新增覆盖：

- `BridgeProgressDelivery periodically flushes pending progress while route is still running`
- `BridgeCommentaryDelivery periodically flushes pending commentary while route is still running`
- Plan commentary 集成用例增加结构化 `tool.progress` 事件，并断言微信类渠道不发送工具生命周期。

## 结论

通过。`brief` 后续摘要进度和旁白 pending 都会在节流间隔到期后自动 flush，不再只能等 turn 结束。第二次全量测试通过。

## 遗留问题

- 真实微信渠道仍可能因平台投递限制出现 `sendmessage failed: ret=-2 errcode=0` 或消息堆积。本次修复保证 Bridge 层会继续低频投递 pending，但不能绕过微信客户端或 SDK 的真实限流。
