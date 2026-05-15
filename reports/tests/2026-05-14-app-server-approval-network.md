# 2026-05-14 app-server approval 网络访问测试报告

## 变更目的

修复中间件 `codex app-server` 路径与本机 Codex CLI 行为不一致的问题：`approval` 模式下 app-server turn 的 `workspaceWrite` sandbox 被显式设置为 `networkAccess=false`，导致微信侧继续任务时 `git push` 等外网命令被提前拦截，且不会转成微信 `/OK` 审批。

## 覆盖内容

- `AppServerCodexAdapter` 的 `approval + workspace-write` turn sandbox 改为 `networkAccess=true`。
- 保留 `approvalPolicy=on-request` 和 `approvalsReviewer=user`，命令/文件/权限审批仍由微信 `/OK`、`/NO` 处理。
- 新增 app-server 单测验证 `turn/start` 传入的 `sandboxPolicy.networkAccess` 为 `true`。
- README 和技术/需求文档补充：app-server approval 模式保留网络访问能力，以对齐本机 Codex CLI 的 `workspace-write` 行为。

## 执行命令

```bash
npm run build
node --test --test-timeout=5000 dist/tests/unit/app-server-codex-adapter.test.js
npm test
git diff --check
```

## 结果

- TypeScript build 通过。
- app-server adapter 针对性单测 12 个通过。
- 全量测试 78 个通过。
- `git diff --check` 通过。
