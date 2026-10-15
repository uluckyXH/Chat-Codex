# 2026-10-15 Codex CLI 兼容性现状验证报告

## 目标与边界

为[能力审计](../../docs/2026-10-15-codex-cli-compatibility-audit.zh-CN.md)与[适配计划](../../docs/2026-10-15-codex-cli-adaptation-plan.zh-CN.md)核实当前实现。没有修改运行时代码、CLI 安装、模型配置、登录态或真实 Goal，没有发送微信／飞书消息。

## 环境与参考更新

- Chat-Codex：`main @ a85e0b7`，版本 `0.1.5`，保留前序文档改动。
- macOS；Node.js `v24.14.0`；本机 shell `codex-cli 0.162.1`。
- `npm view @openai/codex dist-tags --json` 核实 latest `0.162.1`、alpha `0.163.0-alpha.11`。
- `git -C references/openai-codex fetch --prune origin` 成功；HEAD 与 origin/main 均为 `bb64b894fd67158be0f874872e6d7bfe717e7368`，ahead/behind `0 0`，参考工作区干净。
- schema 累计差异比较点：`ddf04ad26789d040f9ef6a96736f76602e35a6cc`。

CLI 输出过无法创建 PATH alias 的沙箱 warning，但 `--version`、`generate-ts --help` 和两次 schema 导出均 exit 0；这不作为 app-server 模型运行验证。

## 执行的构建与测试

```bash
npm run build
node --test dist/tests/unit/app-server-mappers.test.js dist/tests/unit/app-server-core-modules.test.js dist/tests/unit/app-server-codex-adapter.test.js dist/tests/unit/codex-cli.test.js dist/tests/unit/codex-process.test.js dist/tests/unit/exec-codex-adapter.test.js dist/tests/unit/codex-version-adaptation-commands.test.js
```

结果：构建成功；**89 tests / 88 pass / 1 fail / 0 skipped**，测试命令 exit 1。

唯一失败：`app-server protocol inventory classifies local Codex reference schema methods`。实际缺少 `thread/attachmentOwner/list`，预期空数组。测试在首个方向失败后不继续断言；独立 inventory 另外确认了 main 的 `thread/readState/changed` 漏项。

本轮仅记录失败，未通过修改分类表、删测试或 skip 伪装修复。

日志：

```text
/private/tmp/chat-codex-20261015-codex-build.log
/private/tmp/chat-codex-20261015-codex-audit-tests.log
```

## CLI schema 导出与独立清单

```bash
codex app-server generate-ts --out /private/tmp/chat-codex-cli-01621-stable-schema-20261015
codex app-server generate-ts --experimental --out /private/tmp/chat-codex-cli-01621-schema-20261015
```

| 来源 | ClientRequest | ServerRequest | ServerNotification | 当前未分类数（按同序） |
| --- | ---: | ---: | ---: | --- |
| main 默认生成文件 | 108 | 10 | 87 | 1 / 0 / 1 |
| 稳定 CLI 默认导出 | 108 | 10 | 86 | 1 / 0 / 0 |
| 稳定 CLI experimental 导出 | 173 | 11 | 86 | 66 / 1 / 0 |

通过读取三份 union 的 method literal，与 `APP_SERVER_PROTOCOL_CAPABILITIES` 按 direction/method 对照获得。方法数量不是功能数量，新增分类不等于功能实现。main 相对 9 月 5 日默认快照新增 7 个 client request、删除 `thread/rollback`、新增 4 个 notification。

额外核实：`partial_answer`、Goal origin、`isBlocking`、ThreadItem 的 async/questions、Model 字段、Turn 结构均存在于本机稳定 CLI 实验导出，不能全部归为尚未发布的 main 能力。`thread/readState/changed` 则未出现在稳定 CLI 导出。

清单临时输出：

```text
/private/tmp/chat-codex-20261015-protocol-inventory.json
/private/tmp/chat-codex-20261015-all-protocol-inventory.json
```

## 八项离线现状探针

脚本 `/private/tmp/chat-codex-20261015-codex-gap-probes.mjs` 导入本次构建的真实 mapper、turn controller 和 history helper，使用虚构 thread/turn/request ID 与内存队列，不启动真实模型。

```bash
node /private/tmp/chat-codex-20261015-codex-gap-probes.mjs
```

| 探针 | 注入内容 | 观察到的当前行为 |
| --- | --- | --- |
| partial phase | `partial_answer` | parser 返回 undefined |
| async question | agentMessage 带 partial、async、questions | 输出普通 assistant.completed，questions 丢失，turn 本身仍运行 |
| 非阻塞输入 | `isBlocking: false` | raw 保留 false，内部 request 没有该字段 |
| 中断 | turn status=interrupted 且有 error | 仅输出 turn.completed，未保留 error |
| 上游重试 | error 且 willRetry=true，非 Reconnecting 文案 | 输出 turn.failed 并关闭 turn |
| 图片失败 | usageLimitExceeded；另测试同时存在 savedPath | 无路径不生成失败说明；有路径仍产生“媒体生成完成” |
| 历史末条 | paged item 为 partial/async | 仍被作为最后最终助手消息返回 |
| 外部时钟 | currentTime/read | 未知方法响应 -32601 |

八项现状断言均符合观察；这证明当前分支处理存在缺口，**不是八项修复测试通过**。图片“失败同时存在路径”用于边界验证，不声称真实服务端必定这样返回。Goal 来源与恢复设置另由源代码对照确认，未做真实状态修改。

输出保存在 `/private/tmp/chat-codex-20261015-codex-gap-probes.json`。临时脚本与 schema 不纳入发布包。

## 补充：工具进度现状验证

范围说明：用户随后明确所需进度是 Codex 中途自然语言摘要。以下记录保留为工具生命周期链路的现状证据，不作为阶段摘要功能的验收结果。

用户明确协议与渠道共同适配后，对照微信 `2.4.6`、`2.4.10` 工具 sender，以及 Codex mapper、Bridge 模式过滤和微信 adapter。使用本轮已有构建产物运行以下 6 项既有测试；期间业务源码未改动：

```bash
node --test --test-reporter=spec --test-name-pattern='structured tool progress|delivery policy|web search tool progress|failed tool progress|successful tool progress|independent from tool progress failures' dist/tests/integration/weixin-adapter-api.test.js dist/tests/unit/app-server-core-modules.test.js dist/tests/unit/bridge-delivery.test.js
```

结果：**6 项通过、0 失败、0 跳过**，退出码 0。覆盖当前微信模式策略、type 11/12 请求及 context/run/tool ID、Codex 网页搜索开始／结束映射、成功路径日志、失败诊断与冷却，以及工具失败和文本进度的既有隔离。

源码确认当前普通微信模式 silent/brief 均不会发送结构化工具进度，Codex 结构化映射仅覆盖命令／MCP／网页搜索。测试证明底层能力存在，不证明 tools 用户入口、最新 item 完整覆盖、统一投递预算已经实现；未执行真实微信／飞书发送。

## 文档检查与限制

- 新审计、计划及索引的相对链接、章节锚点和代码围栏检查通过；`git diff --check` 通过。
- 本轮未运行全量 `npm test`；未执行真实模型 turn、Windows 实装验收、真实审批或渠道投递。
- schema 导出与 mock 测试不能证明某个账号可使用某个模型，也不能证明微信发送失败与 Codex 语义缺口有关。
- 结论：**审计完成，兼容性验收尚未通过；已形成可实施计划，运行时待改。**
