# 2026-05-14 `/status` reasoning effort 和 token 标签测试报告

## 背景

`/status` 已经显示模型和上下文 token，但缺少 app-server 返回的 `reasoningEffort`。同时 token 明细里的 `output` 容易被误读为会话累计输出；实际上最近一轮输出来自 app-server `thread/tokenUsage/updated` 的 `tokenUsage.last.outputTokens`，累计输出来自 `tokenUsage.total.outputTokens`。

## 本轮变更

- `CodexSessionModelInfo` 增加 `reasoningEffort`。
- `AppServerCodexAdapter` 从 `thread/start`、`thread/resume` 响应读取 `reasoningEffort`。
- `/status` 的 `Model` 行增加 `effort=...`；当 app-server 返回 `null` 时展示为 `effort=default`。
- `/status` token 明细拆成 `Last turn tokens` 和 `Session API usage`，分别展示最近一轮 output 和累计 output，避免混淆。
- 需求文档和技术设计里的 `/status` 示例同步更新。

## 测试

执行命令：

```bash
npm run build
node --test --test-timeout=5000 dist/tests/integration/bridge-mock.test.js dist/tests/unit/app-server-codex-adapter.test.js
npm test
git diff --check
```

结果：

- TypeScript build 通过。
- 针对性 Bridge + app-server 单测 32 个通过。
- 全量测试通过。
- `git diff --check` 通过。
