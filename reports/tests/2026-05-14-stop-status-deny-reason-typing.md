# 2026-05-14 `/stop`、`/status`、拒绝审批和微信 typing 测试报告

## 测试目标

- 验证 `/NO` 能拒绝当前审批。
- 验证 `/status` 在 Codex 运行时可以立即返回当前处理状态、队列、turn/task 摘要和 `/stop` 提示。
- 验证 `/stop` 只终止当前正在处理的 Codex 任务，不结束 Bridge 或 Codex 会话。
- 验证 `brief` 模式能继续投递计划、自言自语类进度，并兼容更多 Codex JSONL 形态。
- 验证微信 typing 使用 `getconfig` 获取 `typing_ticket` 后调用 `sendtyping`，并在任务结束或 `/stop` 后停止。

## 覆盖范围

- `src/approvals/approval-manager.ts`
- `src/bridge/bridge.ts`
- `src/codex/exec-codex-adapter.ts`
- `src/codex/types.ts`
- `src/protocol/channel.ts`
- `src/channels/weixin/weixin-api.ts`
- `src/channels/weixin/weixin-adapter.ts`
- `src/channels/weixin/weixin-types.ts`
- `tests/unit/approval-manager.test.ts`
- `tests/unit/exec-codex-adapter.test.ts`
- `tests/integration/bridge-mock.test.ts`
- `tests/integration/weixin-adapter-api.test.ts`

## 自动化测试

命令：

```bash
npm run build
npm test
git diff --check
```

结果：

```text
tests 52
pass 52
fail 0
cancelled 0
skipped 0
todo 0
```

新增重点用例：

- `Bridge rejects latest approval with /NO`
- `Bridge sends typing state while Codex is running`
- `Bridge status reports running work and /stop cancels the current task`
- `WeixinAdapter sends typing state with getconfig typing ticket`
- `ExecCodexAdapter cancel terminates a running exec task`
- `parseExecJsonLine maps exec progress items` 扩展覆盖 `summary`、`codex_thinking`、`plan_update`

## 结果说明

- `/NO` 会拒绝当前最新审批；带 ID 的 `/deny a001` 仍作为内部兼容能力保留，但不在普通微信提示中暴露。
- `/status` 是即时命令，不进入普通消息队列；运行中会显示 `Processing: yes`、`Codex: running ...`、队列数量和 `/stop` 提示。
- `/stop` 会调用 `CodexAdapter.cancel()`；CLI exec adapter 会对当前 `codex exec` 子进程发送 `SIGTERM`，必要时升级为 `SIGKILL`。
- Bridge 在 Codex 运行期间调用通道 `sendTyping(true)`，并每 5 秒续发；结束、失败或 `/stop` 后调用 `sendTyping(false)`。
- WeixinAdapter 的 typing 链路为 `getconfig` -> `typing_ticket` -> `sendtyping`，ticket 会短期缓存，避免每次续发都重新请求配置。
