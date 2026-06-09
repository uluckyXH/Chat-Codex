# 测试报告：TUI app.tsx Screen Renderer 拆分

## 测试目标

验证 `src/cli/tui/app.tsx` 第二轮模块化拆分是否保持行为稳定。本轮只把页面渲染组合迁移到 `src/cli/tui/screen-renderer.tsx`，不迁移输入分发、状态 controller 和业务 action。

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

1. 新增 `src/cli/tui/screen-renderer.tsx`，承载原 `app.tsx` 中 `body` 渲染分支。
2. `app.tsx` 移除页面 View imports，改为调用 `renderTuiScreen(...)`。
3. 保持原有 screen 到 View 的映射、传参、submit 回调和手动输入提交逻辑不变。
4. 执行构建、定向 TUI 测试和全量测试。

## 实际结果

- `npm run build` 通过。
- `node --test dist/tests/unit/tui-navigation.test.js dist/tests/unit/ink-tui.test.js` 通过，结果为 `28 passed, 0 failed`。
- `npm test` 通过，结果为 `474 passed, 0 failed`。
- 第二轮后 `src/cli/tui/app.tsx` 为 `983` 行，新增 `src/cli/tui/screen-renderer.tsx` 为 `110` 行。

## 结论

通过。第二轮 screen renderer 拆分未发现构建或测试回归。

## 遗留问题

- `app.tsx` 仍承担状态管理、生命周期副作用、输入分发和业务 action 编排，文件仍接近 1000 行。
- 下一轮建议继续抽 `use-chat-codex-tui-controller.ts`，迁移 state/ref、派生状态和生命周期 effect。
