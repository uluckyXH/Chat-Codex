# 2026-05-14 Codex app-server 微信审批测试报告

## 测试目标

- 验证默认真实 Codex adapter 改为 `codex app-server`。
- 验证 app-server 的 command/file/permissions 审批请求能进入 Bridge 审批流。
- 验证微信主路径只需要 `/OK` 或 `/NO`，不要求用户输入审批 ID。
- 验证 Bridge 会用 app-server 原始 request id 回写审批结果。
- 验证 app-server adapter 声明交互审批能力：`interactive effective=on-request`。
- 验证 `/stop` 在等待审批时会向 app-server 回写 `cancel` 并清理 Bridge pending approval。

## 覆盖文件

- `src/codex/app-server-codex-adapter.ts`
- `src/approvals/approval-manager.ts`
- `src/codex/types.ts`
- `src/approvals/types.ts`
- `src/bridge/bridge.ts`
- `src/cli.ts`
- `tests/unit/app-server-codex-adapter.test.ts`
- `tests/integration/bridge-mock.test.ts`

## 执行命令

```bash
npm run build
npm test
env CODEX_HOME=/private/tmp/codex-chat-bridge-appserver-smoke node --input-type=module -e 'import { AppServerCodexAdapter } from "./dist/src/codex/app-server-codex-adapter.js"; const adapter = new AppServerCodexAdapter(); const session = await adapter.startSession({ routeKey: "smoke", cwd: process.cwd(), title: "smoke" }); console.log(JSON.stringify({ id: session.id, cwd: session.cwd, status: await adapter.getStatus(session.id), policy: adapter.getRunPolicyStatus() })); await adapter.stop();'
```

## 结果

```text
npm run build: passed
npm test: 62 passed, 0 failed
real app-server smoke: thread/start passed, status idle, approval interactive effective=on-request
```

## 关键结论

- `weixin codex` 和 `terminal codex` 默认使用 app-server adapter；`--codex-adapter exec` 仅作为非交互回退。
- app-server 审批请求会保存原始 `adapterApprovalId`，Bridge 仍只向微信展示 `/OK` 和 `/NO`。
- `/OK` 会映射到 app-server `accept`，`/NO` 会映射到 `decline`。
- `/stop` 遇到等待审批的 turn 时，会先用 `cancel` 解除 app-server server request，再中断 turn，避免旧审批残留。
- 真实 app-server smoke 发现并修正了 `sessionStartSource` 枚举值，当前使用协议允许的 `startup`。
