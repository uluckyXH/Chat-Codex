# 2026-05-14 help 命令代码块测试报告

## 变更目的

优化微信侧 `/help` 菜单的 Markdown 展示，把每条命令放入 `text` 代码块，便于在支持 Markdown 的聊天端直接选择或复制命令。

## 覆盖内容

- `/help` 输出改为“命令代码块 + 中文说明”的结构。
- 保留 `/OK`、`/NO`、`/permission [approval|full confirm]` 等简化审批和权限命令。
- 更新 Bridge mock 集成测试，验证帮助菜单包含代码块格式的命令。

## 执行命令

```bash
npm run build
node --test --test-timeout=5000 dist/tests/integration/bridge-mock.test.js
npm test
git diff --check
```

## 结果

- TypeScript build 通过。
- Bridge mock 针对性集成测试 16 个通过。
- 全量测试 77 个通过。
- `git diff --check` 通过。
