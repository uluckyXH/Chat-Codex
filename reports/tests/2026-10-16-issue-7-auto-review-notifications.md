# Issue #7 自动审批通知排查验证

日期：2026-10-16。性质：**保留修复前证据，并追加实现与测试进度**。

设计文档：[自动审批成功提示降噪](../../docs/2026-10-16-auto-review-notification-delivery-design.zh-CN.md)。

## 修复前基线与范围

- Chat-Codex：`20b5c9096ffb98902e595dfe2b411ef400675e56`，包版本 `0.1.6`。
- Codex 参考源码：`bb64b894fd67158be0f874872e6d7bfe717e7368`。
- Node.js：`v24.14.0`。
- 已通过 GitHub API 读取 Issue 正文和三条评论，并在浏览器核对原始截图。
- 运行代码、正式测试文件、微信／飞书账户配置均未修改。没有发真实渠道消息，没有启动真实模型任务。

## 构建与既有测试

```sh
npm run build
node --test dist/tests/unit/bridge-route-queue.test.js
```

构建通过；既有路由测试 **18 项通过，0 失败，0 跳过**。其中包括静默模式下继续发送通知、通知去重、人工审批解除、后台中间回复与最终回复等基线行为。

这批测试保护的是修改前行为，不能作为“成功通知已经静默”的证据。本轮只新增文档，不重复运行全量发布测试。

## 七组诊断探针

临时脚本：`/private/tmp/chat-codex-issue7-probe-20261016.mjs`。执行：

```sh
node /private/tmp/chat-codex-issue7-probe-20261016.mjs
```

方法：导入当前构建产物中的 app-server adapter、前台队列、后台投递器和 `BridgeDelivery`。诊断脚本调用编译后仍可访问的 mapper 方法，并截取其内部事件；未启动 app-server 子进程。渠道使用计数 mock，`taskStart=suppress`、普通进度关闭，避免启动提示和其他进度干扰通知数量。

成功通知输入使用已核实的固定格式，审批理由为人工构造的 `Synthetic read-only inspection N.`。最终正文使用固定标记 `ISSUE7_SYNTHETIC_FINAL`。

| 编号 | 输入或条件 | 断言与实际结果 |
| --- | --- | --- |
| 1 | 前台静默，20 条不同成功通知 + 最终正文 | 21 次发送；正文最后；普通进度 0 次 |
| 2 | 前台静默，20 条完全相同成功通知 + 正文 | 2 次发送，即 1 通知 + 1 正文 |
| 3 | 后台静默，20 条不同成功通知 + 正文 | 21 次发送；正文最后 |
| 4 | 拒绝、超时、失败、未知 guardian 提示 + 正文 | 5 次发送；四种提示均保留 |
| 5 | 条件 1，mock 只允许前 3 次发送成功 | 21 次尝试，3 次成功，18 条发送失败日志；正文未投递成功 |
| 6 | 相同 mock 条件，只发正文 | 1 次发送且成功 |
| 7 | 三种结构化自动审查通知进入 adapter | 产生 0 个 Bridge 事件，符合当前忽略策略 |

最终 **7 组均通过**。条件 5／6 是人工故障注入及其对照，**不是微信真实限流阈值，也不是现场故障的直接复现**。条件 6 仅改变模拟输入，不代表已经实现通知过滤。

探针初次执行时，mock 缺少 `getCapabilities`，触发模拟夹具错误；补齐与仓库现有 fixture 一致的能力声明后重跑通过。该错误没有归因于产品缺陷。

本机证据文件：

- `/private/tmp/chat-codex-issue7-probe-20261016.json`
- `/private/tmp/chat-codex-issue7-route-baseline-20261016.log`

临时文件不作为仓库长期依赖；复现输入、模块入口和断言已在本报告记录，实施时应转成仓库内正式测试。

## 修复前结论与未验证项

确认：成功自动审批通知绕过普通进度静默；理由变化导致现有正文去重失效；前后台都逐条发送；在模拟的有限发送机会条件下，提示能够先耗掉可用机会，最终正文失败。

确认：官方参考 TUI 已过滤成功审批的固定文本前缀；中间件尚无相应分流。当前结构化审查事件还没有接入通知路径。

未验证：Issue 作者故障现场的运行版本、原始协议事件、微信错误码和最终消息回执；方案实施后的自动化和真实渠道结果。微信私聊、飞书私聊／群聊的真实验收均待实施后执行。

## 设计阶段文档检查

新增设计、报告与文档索引；旧通知设计标注待实施的成功提示例外。`git diff --check` 通过；四份文档内 7 个相对链接均能解析到现有文件。工作区改动仅涉及这四份 Markdown 文档。

## 用户授权后的实现与定向验证

成功通知已由 mapper 标记 `visibility=local`，Bridge 在发送前分流到本机 Logger；拒绝、失败、超时、未知消息和未带展示属性的旧事件继续投递。本地通知不生成成功发送回执，也不写入最近重要通知列表。前台和后台共用实现，无渠道专用正文过滤。

新增 9 项单元测试与 12 项集成测试，并扩展已有真实 JSON-RPC 子进程 fixture：

- 覆盖 low／medium／high／critical 的已通过通知、正文引用造成的误匹配、其他方法、空值和上游伪造的 `visibility` 字段。
- 验证 100 条不同成功提示保留本地日志，不占发送预算；拒绝通知与最终回复保持可达。
- 覆盖微信私聊、飞书私聊／群聊 × silent／brief × 前台／后台的 12 组组合；brief 中旁白与推理摘要仍会发送，silent 中按原策略静默。
- 覆盖 route／session 隔离与去重、重要通知保留、Console／TUI INFO 展示、合成 notification ID 和无虚假 outbound 回执。
- 安装包脚本新增第 9 组检查，直接从隔离安装目录导入模块验证成功仅本地、拒绝与正文继续发送；实际执行通过。

```sh
npm run build
node --test dist/tests/unit/bridge-notification-delivery.test.js dist/tests/unit/app-server-codex-adapter.test.js dist/tests/unit/bridge-route-queue.test.js dist/tests/unit/bridge-delivery.test.js dist/tests/integration/auto-review-notifications.test.js
```

最终定向结果：**95 项通过，0 失败／跳过，约 13.46 秒**。首次运行 94 通过、1 失败，原因是新测试错误地写死 fake server 的 turn ID；该 fixture 实际按时间生成 turn ID。改为与真实收到的 `turn.started` 对照后通过，没有放宽通知归属断言。

本机输出：`/private/tmp/chat-codex-issue7-focused-tests-final-20261016.log`。后续全量与打包结果如下，真实渠道验收尚未执行。

## 全量回归与生产依赖审计

版本已同步为 `0.1.7`，运行 `npm test`：**742 项通过，0 失败／跳过，约 13.65 秒**，包含原有 721 项和本次新增 21 项。既有人工审批、问答、自定义回答、旁白、上下文、群权限及渠道测试均通过。

`npm audit --omit=dev --json`：生产依赖已知漏洞 **0 项**。此次未变更依赖版本；package.json 与 shrinkwrap 仅同步发布包版本号。

`npm run test:package -- --keep`：**9 组检查通过**。真实 tarball 在隔离 prefix 安装，171 个运行模块齐全，CLI 版本返回 `0.1.7`；从安装目录执行的成功／拒绝通知与最终正文回归通过。mock 验证不代表微信／飞书线上回执验收。

本机输出：`/private/tmp/chat-codex-release-0.1.7-tests.log`、`/private/tmp/chat-codex-release-0.1.7-audit.json`、`/private/tmp/chat-codex-release-0.1.7-package-test.log`。发布前记录显示所有本地门禁通过，GitHub 发布和 Issue 关闭将在完成后回写。
