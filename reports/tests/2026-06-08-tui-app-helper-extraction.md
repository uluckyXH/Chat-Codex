# 测试报告：TUI app.tsx 纯 Helper 拆分

## 测试目标

验证 `src/cli/tui/app.tsx` 第一轮模块化拆分是否保持行为稳定。本轮只抽离纯 helper 到 `src/cli/tui/navigation.ts`，不迁移页面渲染、输入分发和业务动作。

## 测试环境

- 日期：2026-06-08
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

1. 从 `app.tsx` 抽出纯 helper 到 `navigation.ts`。
2. 更新 `app.tsx` 和 `views.tsx`，改为复用 `navigation.ts` 中的 helper。
3. 新增 `tests/unit/tui-navigation.test.ts` 覆盖数字快捷键、页面最大选中项、上下文刷新模式映射、飞书步骤推进和微信登录自动检查间隔解析。
4. 执行构建、定向 TUI 测试和全量测试。

## 实际结果

- `npm run build` 通过。
- `node --test dist/tests/unit/tui-navigation.test.js dist/tests/unit/ink-tui.test.js` 通过，结果为 `28 passed, 0 failed`。
- `npm test` 通过，结果为 `474 passed, 0 failed`。

## 结论

通过。第一轮纯 helper 拆分未发现构建或测试回归。

## 遗留问题

- 本轮只完成低风险纯函数迁移，`app.tsx` 仍然承担页面渲染、状态 controller、输入分发和业务 action 编排。
- 下一轮建议按设计文档继续抽 `screen-renderer.tsx`，只迁移当前 `body = useMemo(...)` 的页面渲染组合。
