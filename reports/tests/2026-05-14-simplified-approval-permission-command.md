# 2026-05-14 简化审批命令与微信权限切换测试报告

## 测试目标

- 验证普通微信提示不再要求用户输入审批 ID。
- 验证审批消息只展示 `/OK` 和 `/NO` 两个主操作。
- 验证审批处理回执也不暴露内部审批 ID。
- 验证 `/OK` 后面误带文本时仍按“批准当前审批”处理。
- 验证 `/permission` 可以查看当前 Codex 权限模式。
- 验证 `/permission approval` 可以切回 `workspace-write` sandbox。
- 验证 `/permission full` 不会直接进入完全权限，必须发送 `/permission full confirm`。

## 覆盖范围

- `src/approvals/approval-manager.ts`
- `src/bridge/bridge.ts`
- `src/codex/exec-codex-adapter.ts`
- `src/codex/mock-codex-adapter.ts`
- `src/codex/types.ts`
- `src/cli.ts`
- `tests/unit/approval-manager.test.ts`
- `tests/integration/bridge-mock.test.ts`

## 自动化测试

命令：

```bash
npm run build
npm test
git diff --check
```

结果：

```text
tests 55
pass 55
fail 0
cancelled 0
skipped 0
todo 0
```

新增重点用例：

- `ApprovalManager creates and resolves approvals` 增加审批提示不暴露 ID 和 `/approve` 的断言。
- `Bridge handles new session, prompt, status, and approval over mock channel` 覆盖 `/OK 好的` 容错和审批回执不暴露 ID。
- `Bridge exposes all sessions command for channel users` 增加 `/help` 不展示 ID 命令的断言。
- `Bridge permission command shows and changes Codex run policy`

## 结果说明

- 用户主路径只需要 `/OK`、`/NO`、`/stop` 和 `/permission`。
- 审批 ID 仍作为内部兼容字段存在，便于后续 adapter 或调试使用，但普通微信消息和帮助文案不再暴露。
- `/permission full confirm` 只影响后续 turn；当前已经运行的 Codex 子进程不会被热改写。
