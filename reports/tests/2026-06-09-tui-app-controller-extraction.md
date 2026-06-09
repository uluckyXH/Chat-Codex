# 测试报告：TUI app.tsx Controller Hook 拆分

## 测试目标

验证 `src/cli/tui/app.tsx` 第三轮模块化拆分是否保持行为稳定。本轮新增 `src/cli/tui/use-chat-codex-tui-controller.ts`，迁移 TUI 状态、派生数据、刷新生命周期、页面切换重置、渠道 cursor、session 分页和微信登录自动检查逻辑；输入分发和业务 action 编排暂时保留在 `app.tsx`。

## 测试环境

- 日期：2026-06-09
- 分支/提交：`main` / `10c4492`
- Node.js 版本：`v24.14.0`
- 操作系统：`Darwin Mac 25.5.0 arm64`
- Codex 版本：本地仓库实现
- 渠道：本地单元测试 / mock TUI 测试

## 执行命令

```bash
npm run build
node --test dist/tests/unit/tui-navigation.test.js dist/tests/unit/ink-tui.test.js
npm test
```

## 测试步骤

1. 新增 `useChatCodexTuiController(actions)`，统一管理 `screen`、`dashboard`、`loading`、`selected`、`flash`、`confirm`、手动输入值、渠道 cursor 和 session 分页状态。
2. 将首次 dashboard 刷新、screen 切换重置、渠道 cursor 同步、微信登录自动轮询从 `app.tsx` 迁移到 controller hook。
3. 将 `getSessionChoices`、`getMaxSelectableIndex`、`moveSessionPage`、`openAddWeixinLogin`、`checkWeixinLoginResult` 和 `cancelWeixinLogin` 暴露给 `app.tsx` 继续复用。
4. 保持原有输入 handler、确认框 action、渠道/绑定/权限/工作目录业务逻辑仍在 `app.tsx`，避免同轮迁移过多职责。
5. 执行构建、定向 TUI 测试和全量测试。

## 实际结果

- `npm run build` 通过。
- `node --test dist/tests/unit/tui-navigation.test.js dist/tests/unit/ink-tui.test.js` 通过，结果为 `28 passed, 0 failed`。
- `npm test` 通过，结果为 `474 passed, 0 failed`。
- 第三轮后 `src/cli/tui/app.tsx` 为 `850` 行，新增 `src/cli/tui/use-chat-codex-tui-controller.ts` 为 `261` 行。

## 结论

通过。第三轮 controller hook 拆分未发现构建或测试回归。

## 遗留问题

- `app.tsx` 仍承担输入分发和业务 action 编排，文件仍超过 600 行。
- 下一轮建议抽 `tui-actions.ts`，迁移会调用 `LauncherActions` 或构造确认框的业务动作；再下一轮抽 `input-handlers.ts`。
