# 测试报告：`/new chat` Codex App 对话会话

## 测试目标

验证聊天侧新增 `/new chat` 命令后，能在不改变 `/new` 原有语义的前提下，为当前 route 创建面向 Codex App 对话列表的新 session，同步可读 thread 标题，并在 `/new chat <任务>` 场景下把 `<任务>` 作为第一条真实 prompt 投递到现有 route queue。

补充验证裸 `/new chat` 会补齐 Codex state DB 中的 `threads.preview`，避免只创建空 thread 但不出现在 Codex App “对话”列表。

## 测试环境

- 日期：2026-05-18
- 分支：main
- Node.js：v24.13.1
- 操作系统：macOS 26.3.1
- 渠道：Mock channel
- Codex adapter：MockCodexAdapter、AppServerCodexAdapter fake app-server

## 实现范围

- `CodexAdapter` 新增可选 `setSessionTitle(sessionId, title)` 能力。
- `CodexAdapter` 新增可选 `setSessionPreview(sessionId, preview)` 能力。
- `AppServerCodexAdapter` 通过 `thread/name/set` 同步 Codex App thread name。
- `AppServerCodexAdapter` 在 `preview` 为空时补写 `<CODEX_HOME>/state_5.sqlite` 的 `threads.preview`。
- `AppServerCodexAdapter` 补写 preview 后会读取同一 thread 行确认 preview 非空；如果 thread 行暂未落库、数据库暂缺或 sqlite 短暂锁定，会短暂重试，避免把 0 行更新误报为成功。
- `MockCodexAdapter` 记录并更新 session title，支持自动化测试。
- `MockCodexAdapter` 记录 preview 写入，支持自动化测试。
- 新增 `/new chat` 和 `/new chat <任务>` 命令解析与处理。
- `/new chat` 创建的新 session 仍绑定当前 route，并继续遵守 session owner 唯一约束。
- `/new chat <任务>` 的首条任务复用现有 route queue，不在 session-flow 中直接执行 Codex turn。
- 用户实测后确认该能力仍归属于工作目录下的 Codex App 对话列表，暂不作为公开推荐命令；实现保留，但聊天 `/help`、README、README.en 隐藏 `/new chat [任务]`。

## 已执行验证

```bash
npm run build
node --test dist/tests/unit/app-conversation.test.js dist/tests/unit/bridge-command-router.test.js dist/tests/unit/bridge-session-flow.test.js dist/tests/unit/app-server-codex-adapter.test.js dist/tests/integration/bridge-mock.test.js
node --test dist/tests/unit/codex-state-preview.test.js
npm test
git diff --check
```

## 关键验证点

- `/new` 仍走原创建 session 逻辑。
- `/new chat` 走 App 对话创建逻辑。
- `/new chat <任务>` 能保留并投递原始任务文本。
- route 忙碌时 `/new chat` 会被 busy guard 拒绝。
- `BridgeSessionFlow.createNewAppChatSession()` 会创建并绑定 session。
- 支持 `setSessionTitle` 时会同步 App 对话标题。
- 支持 `setSessionPreview` 时会补齐 App 列表 preview。
- `setSessionTitle` 失败不会回滚 session 绑定。
- `setSessionPreview` 失败不会回滚 session 绑定。
- app-server adapter 调用 `thread/name/set` 后，本地 session 列表标题同步更新。
- Codex state DB preview 为空时会被写入，已有 preview 不会被覆盖。
- Codex thread 行延迟写入时，preview 同步会等待后再确认成功。
- mock bridge 中 `/new chat` 不自动执行 fake prompt。
- mock bridge 中 `/new chat 帮我总结这个项目` 会把 `帮我总结这个项目` 作为第一条真实 prompt 执行。

## 实际结果

- 定向测试：112 passed，0 failed。
- 全量 `npm test`：339 passed，0 failed。
- `npm run build` 通过。
- `git diff --check` 通过。

## 结论

通过。`/new chat` 已具备核心能力，但当前保留为隐藏实现，不在用户可见命令列表中展示。
