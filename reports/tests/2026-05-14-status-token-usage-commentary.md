# 2026-05-14 `/status` token usage 和 commentary 适配测试报告

## 变更目的

修复 `/status` 没有展示当前 Codex session 上下文 token 用量的问题，并把 app-server 的 commentary phase 消息适配为微信可见的阶段性进度。

## 覆盖内容

- `/status` 改为 Markdown 分区输出，包含 `Codex 状态`、`Bridge`、`Channel`。
- `/status` 展示 app-server `thread/tokenUsage/updated` 提供的：
  - total token usage
  - last turn token usage
  - model context window
  - input/cached/output/reasoning token 明细
- `/status` 不再展示微信发送者、conversation、route 等身份细节；这些信息仍由 `/whoami` 查看。
- `AppServerCodexAdapter` 记录 `thread/tokenUsage/updated` 到 session status。
- `agentMessage.phase=commentary` 转成 `assistant.progress`，不再误并入最终回复。
- `agentMessage.phase=final_answer` 或缺省 phase 继续按最终回复兼容处理。

## 执行命令

```bash
codex app-server generate-ts --out /private/tmp/codex-app-server-schema
npm run build
node --test --test-timeout=5000 dist/tests/unit/app-server-codex-adapter.test.js
node --test --test-timeout=5000 dist/tests/integration/bridge-mock.test.js
npm test
git diff --check
```

## 结果

- 本地 Codex app-server schema 生成通过，版本为 `codex-cli 0.130.0`。
- TypeScript build 通过。
- app-server adapter 针对性单测 9 个通过。
- bridge mock 针对性集成测试 14 个通过。
- 全量测试 71 个通过。
- `git diff --check` 通过。
