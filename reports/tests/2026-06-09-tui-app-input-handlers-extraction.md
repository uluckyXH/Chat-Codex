# 测试报告：TUI app.tsx Input Handlers 拆分

## 测试目标

验证 `src/cli/tui/app.tsx` 第五轮模块化拆分是否保持行为稳定。本轮新增 `src/cli/tui/input-handlers.ts`，迁移全局键盘输入分发和页面级 input handler；`app.tsx` 只保留入口装配、基础返回/退出/启动导航、controller、action、renderer 和 footer/confirm 渲染。

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

1. 新增 `handleTuiInput(...)`，迁移原 `useInput` 中的输入优先级：
   - 文本输入页只处理 Esc。
   - confirm 模式优先处理 `y/n/是/否/Esc`。
   - Esc、帮助、刷新、分页、方向键、`q` 保持原顺序。
   - 最后按当前 screen 分发页面级 handler。
2. 迁移首页、渠道、渠道详情、微信添加、微信主聊天绑定、聊天绑定、配对、session 选择、权限、上下文刷新和工作目录 input handler。
3. `app.tsx` 改为调用 `handleTuiInput(...)`，并继续把 renderer 需要的 action 传给 `renderTuiScreen(...)`。
4. 执行构建、定向 TUI 测试和全量测试。

## 实际结果

- `npm run build` 通过。
- `node --test dist/tests/unit/tui-navigation.test.js dist/tests/unit/ink-tui.test.js` 通过，结果为 `28 passed, 0 failed`。
- `npm test` 通过，结果为 `474 passed, 0 failed`。
- 第五轮后 `src/cli/tui/app.tsx` 为 `195` 行，新增 `src/cli/tui/input-handlers.ts` 为 `559` 行。

## 结论

通过。第五轮 input handlers 拆分未发现构建或测试回归，`app.tsx` 已降到设计目标范围内。

## 遗留问题

- `input-handlers.ts` 为 `559` 行，略高于 400 行 review 触发线。本轮为了保持行为不变，选择一次性迁移完整输入分发；后续可按页面族继续拆成 `home/channel/session/pairing` 等输入模块。
- 本轮没有做真实终端手工交互，只依赖现有 Ink TUI 自动化测试覆盖。
