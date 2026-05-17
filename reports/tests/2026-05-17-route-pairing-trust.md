# 测试报告：微信/飞书 route 配对信任

## 测试目标

验证真实微信/飞书聊天 route 默认需要本机配对码完成信任；未配对前不创建 Codex session、不执行命令、不消费微信 pending 主聊天绑定；配对成功后信任按 `routeKey` 持久化，已有历史 session 绑定可以继续沿用。

## 测试环境

- 日期：2026-05-17
- 分支：main
- 基线提交：57de7f5
- Node.js：v24.13.1
- 操作系统：macOS 26.3.1
- 渠道：Mock 模拟微信/飞书真实 channel id

## 执行命令

```bash
npm run build
node --test dist/tests/unit/pairing-code-manager.test.js dist/tests/unit/file-state-store.test.js dist/tests/integration/bridge-route-pairing.test.js
npm test
git diff --check
```

## 测试步骤

1. 单元测试 `PairingCodeManager` 的生成、解析、过期、错误次数和一次性消费。
2. 单元测试 `FileStateStore` 的 `trusted-routes.json` 写入、恢复、最近活跃刷新、撤销和删除渠道时清理。
3. 集成测试飞书未信任私聊被拦截，发送 `/pair <code>` 后才能进入 Codex。
4. 集成测试飞书 `oc_a` 和 `oc_b` 按 `chat_id` 分别配对，互不共享信任。
5. 集成测试微信 pending 主聊天绑定在未配对前不被消费，配对后下一条普通消息才消费并沿用预设 session。
6. 集成测试旧版本已有 route/session 绑定升级后仍需配对，配对后继续使用原 session。
7. 集成测试配对信任写入文件后，重启 Bridge 可直接恢复信任并继续对话。
8. 跑全量测试，确认现有命令、TUI、状态持久化、媒体、进度聚合和 app-server adapter 不回归。

## 实际结果

- 目标测试：22 passed，0 failed。
- 全量 `npm test`：321 passed，0 failed。
- `git diff --check`：通过。

关键行为：

- 未信任 route 的普通消息和 `/status` 只回复不含配对码的配对引导，不创建 session。
- 错误配对码回复不含正确码的失败提示，并在本机日志记录失败。
- 正确配对码会回复 `Chat-Codex 配对成功，当前聊天已信任。`
- 信任记录保存到 `trusted-routes.json`，重启后恢复。
- 飞书不同 `chat_id` 必须分别配对。
- 微信 pending 主聊天绑定不会被陌生未配对私聊抢占。

## 结论

通过。核心配对信任链路已完成自动化验证。

## 遗留问题

- 第一阶段未实现 TUI 的“已信任聊天 / 撤销信任 / 重新生成配对码”管理页。
- 真实微信/飞书通道的人工配对体验待后续用户实测。
