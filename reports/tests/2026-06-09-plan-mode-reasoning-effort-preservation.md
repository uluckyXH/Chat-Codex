# 测试报告：Plan mode 保留 session 思考等级

## 测试目标

验证 Chat-Codex 在进入或使用 Plan mode 时，不会把当前 Codex session 的模型思考等级强制改成 `medium`；`turn/start` 的 `collaborationMode.settings.reasoning_effort` 应沿用当前有效模型策略或 session 状态。

## 测试环境

- 日期：2026-06-09
- 分支/提交：`main` / `10c4492`
- Node.js 版本：`v24.14.0`
- 操作系统：Darwin Mac 25.5.0 arm64
- Codex 版本：本地 fake app-server 单元测试
- 渠道：不涉及渠道，问题位于 Codex app-server adapter 核心层

## 执行命令

```bash
npm run build
node --test dist/tests/unit/app-server-mappers.test.js dist/tests/unit/app-server-codex-adapter.test.js
rg -n "mode plan model fake effort medium|mode === \"plan\"\\s*\\?\\s*\"medium\"|reasoningEffort = mode === \"plan\"" src tests
npm test
git diff --check
```

## 测试步骤

1. 将 `collaborationModePayload()` 改为从显式 model policy、当前 status model、base model 中解析有效 `reasoningEffort`，未知时发送 `null`。
2. 更新 mapper 单测，覆盖 Plan mode 保留当前 `high`，以及未知思考等级时发送 `null`。
3. 更新 app-server adapter 单测，把 session 设置为 `fake-next/xhigh` 后进入 Plan mode，并通过 fake `thread/settings/updated` 验证状态不会降回 `medium`。
4. 执行构建、定向单测、全量测试和 diff 空白检查。

## 实际结果

- `npm run build` 通过。
- 定向测试通过：`44 passed, 0 failed`。
- `rg` 未再发现运行源码和测试中存在 Plan mode 固定 `medium` 的匹配。
- `npm test` 通过：`474 passed, 0 failed`。

## 结论

通过。Plan mode 现在只改变协作模式，不再覆盖 session 的模型思考等级。

## 遗留问题

无。真实微信或飞书通道不需要单独补测，因为本次修复不涉及渠道投递层。
