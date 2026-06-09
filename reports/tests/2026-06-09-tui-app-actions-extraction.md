# 测试报告：TUI app.tsx Action 编排拆分

## 测试目标

验证 `src/cli/tui/app.tsx` 第四轮模块化拆分是否保持行为稳定。本轮新增 `src/cli/tui/tui-actions.ts`，迁移调用 `LauncherActions` 或构造确认框的业务动作；键盘输入分发和页面级 input handler 暂时保留在 `app.tsx`。

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

1. 新增 `createTuiActions(...)`，承载启动前检查、微信主聊天结果处理、飞书添加、权限保存、工作目录保存、session 创建绑定、渠道备注、渠道删除、飞书群聊接收开关、解绑和配对信任确认。
2. `app.tsx` 改为从 `createTuiActions(...)` 解构业务动作，原输入 handler 的调用点保持不变。
3. 对照原 `app.tsx` 检查迁移后文案、状态更新、刷新调用和页面跳转顺序。
4. 执行构建、定向 TUI 测试和全量测试。

## 实际结果

- `npm run build` 通过。
- `node --test dist/tests/unit/tui-navigation.test.js dist/tests/unit/ink-tui.test.js` 通过，结果为 `28 passed, 0 failed`。
- `npm test` 通过，结果为 `474 passed, 0 failed`。
- 第四轮后 `src/cli/tui/app.tsx` 为 `669` 行，新增 `src/cli/tui/tui-actions.ts` 为 `286` 行。

## 结论

通过。第四轮 action 编排拆分未发现构建或测试回归。

## 遗留问题

- `app.tsx` 仍承担全局键盘输入分发和页面级 input handler。
- 下一轮建议抽 `input-handlers.ts`，迁移 `useInput` 分发和各页面 handler。
