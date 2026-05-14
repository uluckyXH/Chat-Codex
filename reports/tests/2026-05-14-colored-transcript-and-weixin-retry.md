# 2026-05-14 终端彩色 transcript 与微信发送重试测试报告

## 测试目标

- 验证终端 transcript 可以用 ANSI 颜色区分微信入站、Codex 回复、进度、审批、错误和媒体。
- 验证默认情况下非 TTY 或测试输出仍保持纯文本，不污染重定向日志。
- 验证微信 `sendmessage` 遇到限流错误时会按退避策略重试。
- 验证限流重试成功后通道恢复 `connected`，最终失败时仍进入 `degraded` 并记录 `lastError`。

## 覆盖范围

- `src/logging/transcript.ts`
- `src/channels/weixin/weixin-adapter.ts`
- `tests/unit/transcript.test.ts`
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
tests 57
pass 57
fail 0
cancelled 0
skipped 0
todo 0
```

## 结果说明

- `ConsoleTranscriptSink` 新增 `color` 选项，默认 `auto`：TTY 启用颜色，重定向或测试输出默认保持纯文本；也可以显式传 `color: true/false`。
- 微信出站文本和媒体底层仍串行排队，默认最小发送间隔调整为 1200ms。
- `sendmessage` 对 45009、429/5xx、超时和常见临时网络错误做退避重试；默认最多重试 2 次。
- 重试期间通道会临时记录 `sendmessage-retry` 状态，成功后清空 `lastError`；最终失败时保持 `degraded`，便于 `/status` 或终端日志排查。
