# 2026-05-14 审批消息持续重试测试报告

## 背景

真实微信长跑时出现 `sendmessage failed: ret=-2 errcode=0`。如果这次失败发生在 Codex 审批提示上，旧逻辑会把发送失败降级为日志，不会继续补发；Codex app-server 仍在等待审批响应，但用户手机没有看到 `/OK` / `/NO` 提示，表现为任务像卡住。

## 本轮变更

- Bridge 将审批提示从普通文本发送改为关键消息发送。
- 收到 `approval.requested` 后先创建 pending approval，再持续重试发送审批提示。
- 审批提示会一直重试，直到至少成功送达一次。
- 如果重试期间用户已经通过 `/OK`、`/NO` 或 `/stop` 处理该审批，重试会停止，避免已处理审批再次弹出。
- `/status` 在存在 pending approval 时会展示当前审批类型、命令和可复制的 `/OK`、`/NO` 兜底提示。
- README 和技术设计补充审批消息必须送达的关键消息语义。

## 测试

执行命令：

```bash
npm run build
node --test --test-timeout=5000 dist/tests/integration/bridge-mock.test.js
npm test
git diff --check
```

结果：

- TypeScript build 通过。
- Bridge 针对性集成测试 20 个通过。
- 全量测试 82 个通过。
- `git diff --check` 通过。

## 覆盖点

- 审批消息前两次发送失败、第三次发送成功时，Bridge 不放弃审批提示。
- 审批消息一直发送失败时，用户仍可用 `/OK` 处理已创建的 pending approval。
- pending approval 被处理后，审批提示重试循环停止。
