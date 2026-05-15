# 2026-05-14 `/status` 模型和上下文 token 展示测试报告

## 变更目的

修复 `/status` 把 app-server `tokenUsage.total` 累计用量误当作当前上下文窗口的问题，并补充当前 Codex 模型信息展示。

## 覆盖内容

- `AppServerCodexAdapter` 从 `thread/start`、`thread/resume` response 保存 model、provider、service tier。
- `/status` 增加 `Model` 行。
- `/status` 的 `Context` 改用 `tokenUsage.last` 近似当前窗口占用，避免把累计 token 显示成超过上下文窗口的百分比。
- `tokenUsage.total` 仍保留展示，但改为 `Session API usage` 累计用量。
- Bridge mock 集成测试覆盖超大累计 token 不再显示为 13000% 这类误导性窗口占用。

## 执行命令

```bash
npm run build
node --test --test-timeout=5000 dist/tests/integration/bridge-mock.test.js dist/tests/unit/app-server-codex-adapter.test.js
npm test
git diff --check
```

## 结果

- TypeScript build 通过。
- Bridge mock + app-server adapter 针对性测试 28 个通过。
- 全量测试 78 个通过。
- `git diff --check` 通过。
