# 测试报告：飞书入站回复原文适配

日期：2026-10-15。环境：macOS，Node v24.14.0，`main`，基线 `2aa8101c39584cd4a748aa2902a965c5717355e0`（适配前已推送到 `origin/main`）。使用 fake 飞书官方 SDK 接口、MockCodexAdapter 和真实本地临时文件；不使用真实机器人凭据，不向实际私聊／群聊发送消息。

对应[实施文档](../../docs/2026-10-15-feishu-reply-context-adaptation.zh-CN.md)。

## 分项验证

| 工作包 | 实际执行 | 结果 |
| --- | --- | --- |
| F1 | `npm run build`；`feishu-quotes`、`feishu-message`、`feishu-adapter` 单元测试 | 47/47，0 失败／跳过；新增 8 项引用测试 |
| F2 | `npm run build`；`feishu-quoted-input`、`feishu-bridge`、`feishu-group-security` 集成测试及 `quote-transcript` 单元测试 | 39/39，0 失败／跳过；新增 8 项集成及 2 项日志测试 |
| F3 | `npm test`（TypeScript 构建和所有 unit／integration） | 655/655，0 失败／取消／跳过，测试执行约 13.41 秒 |

全量在检查点的 637 项基础上增加 18 项。阶段日志分别保留在本机 `/private/tmp/feishu-reply-context-f1-tests.log`、`/private/tmp/feishu-reply-context-f2-tests.log`、`/private/tmp/feishu-reply-context-full-tests.log`，不提交日志文件。

实际命令：

```sh
npm run build && node --test dist/tests/unit/feishu-quotes.test.js dist/tests/unit/feishu-message.test.js dist/tests/unit/feishu-adapter.test.js
npm run build && node --test dist/tests/integration/feishu-quoted-input.test.js dist/tests/integration/feishu-bridge.test.js dist/tests/integration/feishu-group-security.test.js dist/tests/unit/quote-transcript.test.js
npm test
```

## 已验证行为

- 私聊和群聊均从当前消息的 `parent_id` 建立引用；仅有 `root_id` 和自引用 ID 不触发读取。
- 只选择 API 返回中 ID 精确匹配的父消息，同时核对 `chat_id`；不会取第一条无关消息、跨聊天正文或继续追溯祖先。
- 完整长文本、机器人发送的 Markdown、普通富文本标题／段落／链接、语言包装和提及名称可恢复。私聊和群聊都把正文传给原 Codex session，不调用 `reloadSession`，原文中的 `/stop` 不执行。
- 图片／文件资源下载用父消息 ID；临时文件内容正确。随后群附件加载不会重复下载已经恢复的文件，来源仍是本次请求成员。
- 引用附件失败时保留附件名及不可用说明，不把失败附件混入当前可用附件，不阻断当前文字要求。
- API 失败、空返回、错误 ID、异聊天、撤回、未支持类型和空正文都有明确分类；保留引用 ID，不回显接口错误正文、测试凭据或无关历史正文。
- 元数据读取超时仅降级一次，迟到成功结果不会覆盖超时状态；应用不新增重试。该时限不等于取消 SDK 底层请求，也不覆盖既有附件下载时长。
- 未配对私聊、未配对／未登记／未 @Bot／被拉黑群成员不读取引用；登记命令和 `/help` 不读取引用。
- 私聊、群聊在读取期间撤销 route 信任后不向 Codex 投递；群内下载过程中拉黑请求者时，附件不写入磁盘且不进入 Codex。
- 私聊、群聊的三题问答依次接受选项、选项加备注和自由文本；即使答案引用了机器人题目，也不读取父消息或把题目当答案。
- Console／TUI 新增本地引用恢复记录，只含本条 ID、父消息 ID、恢复状态和数字错误码。初始入站记录显示等待；不额外复制引用正文、raw payload 或凭据。原有引用、回执和 TUI 测试共同回归。

## 结论与边界

实现和自动化验收通过。共享 Bridge、Codex 协议、微信收发与引用、飞书命令／审批／群权限均包含在全量回归中。

`git diff --check` 通过；9 份本批变更 Markdown 文档的本地链接检查无缺失。提交边界仅含源码、测试、设计和测试报告，排除参考源码、`dist/`、`node_modules/`、登录态和运行状态。

本批未升级飞书 SDK 或发布 npm 包，也没有重启当前服务。源码中的能力需要重新构建并重启后使用。引用正文仍增加正常上下文占用；不新增裁剪、摘要或去重。

真实租户仍需验证：私聊及已配对群中回复用户／机器人文本、Markdown、图片、文件；确认应用读取消息和资源的权限、撤回后的真实 API 形态、网络超时与客户端实际 `parent_id`。卡片、合并转发、音视频引用明确降级，不宣称支持。
