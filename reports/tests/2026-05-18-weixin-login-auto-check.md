# 微信登录自动检查和主聊天绑定显式操作验证报告

## 背景

微信扫码登录 TUI 原本需要用户手动按 `Enter` 检查登录结果；微信主聊天绑定页只在快捷键里提示 `n` 新建 session，不够明显。

本次调整：

- 二维码显示后，TUI 每 5 秒自动检查一次微信登录结果。
- 用户仍可按 `Enter` 立即检查。
- 登录检查单次等待从 15 秒缩短到 5 秒，避免自动检查时长时间占用 loading 状态。
- 微信主聊天绑定页新增正文“直接操作”区。
- “新建 Codex session”“手动输入 Session ID”“暂不绑定”都可通过方向键选中后按 `Enter` 执行。
- 进入微信主聊天绑定页时，默认焦点落在“新建 Codex session”上。

## 覆盖范围

- `docs/ink-tui-interaction-design.zh-CN.md`
- `src/cli/actions/launcher-actions.ts`
- `src/cli/tui/app.tsx`
- `src/cli/tui/views.tsx`
- `tests/unit/ink-tui.test.tsx`

## 验证命令

```bash
npm run build
node --test dist/tests/unit/ink-tui.test.js
```

## 验证结果

- `npm run build`：通过。
- `ink-tui.test.js`：16 passed。

## 重点断言

- 微信二维码显示后，TUI 会自动调用 `checkWeixinLogin()`。
- 微信登录页文案提示“5 秒自动检查”和“Enter 立即检查”。
- 微信主聊天绑定页显示“直接操作”区。
- “新建 Codex session”作为页面正文里的可选行展示。
- 无可选历史 session 时，直接按 `Enter` 可以执行新建 pending binding。

## 结论

微信扫码登录不再依赖用户反复按 `Enter` 刷新，主聊天绑定的新建 session 入口也已显式展示为可选择操作。
