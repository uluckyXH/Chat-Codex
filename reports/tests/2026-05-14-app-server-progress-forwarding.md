# 2026-05-14 app-server 阶段性进度转发修复测试报告

## 测试目标

- 验证 Codex app-server 的 reasoning summary 能转成微信可见的 `Codex 进度`。
- 验证 Codex app-server 的 plan started、plan delta、plan completed 能转成微信可见的计划进度。
- 验证默认 `brief` 模式仍保留“自言自语/计划”类进度，不发送命令细节。

## 修复点

- `AppServerCodexAdapter` 不再 opt-out `item/plan/delta`。
- 新增 `item/started` 对 reasoning/plan 的阶段提示。
- 新增 `item/plan/delta` 聚合与转发。
- 新增 `item/completed` 中 `plan` item 的转发。
- 对 summary/plan delta 做聚合和去重，避免逐 token 刷屏。

## 执行命令

```bash
npm run build
node --test --test-timeout=5000 dist/tests/unit/app-server-codex-adapter.test.js
npm test
git diff --check
```

## 结果

```text
npm run build: passed
app-server adapter targeted tests: 4 passed, 0 failed
npm test: 63 passed, 0 failed
git diff --check: passed
```

## 结论

此前真实微信只看到最终回复的原因大概率是 app-server 阶段性事件覆盖不全：代码只处理了 `summaryTextDelta` 和 `turn/plan/updated`，但真实 app-server 还会走 `item/started`、`item/plan/delta`、`item/completed` 的 `plan` item。修复后这些事件都会进入 Bridge 的 `assistant.progress`，默认 `brief` 模式会发送到微信。
