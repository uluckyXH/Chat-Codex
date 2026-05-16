# 2026-05-16 微信主聊天绑定不可选 session 测试

## 变更范围

- 微信主聊天绑定页复用 session owner 检查。
- 已被其他聊天绑定的 Codex session 不再出现在数字可选列表。
- 被占用 session 会展示在“不可选（已绑定其他聊天）”区，并显示当前绑定到哪个聊天。
- 手动输入已占用 session 时，错误提示改为中文聊天标签，不再直接暴露原始 routeKey。

## 验证命令

```bash
npm run build
node --test dist/tests/unit/binding-actions.test.js
npm test
git diff --check
```

## 验证结果

- `npm run build`：通过。
- `node --test dist/tests/unit/binding-actions.test.js`：通过。
- `npm test`：通过。
- `git diff --check`：通过。
