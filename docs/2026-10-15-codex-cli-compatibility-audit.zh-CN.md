# 2026-10-15 Codex CLI 最新兼容性与能力审计

状态：**初始源码审计保留；Codex 协议中间件适配已完成本地验收**。最新实现、使用方式及分项结果见[实施进度](2026-10-15-codex-cli-protocol-implementation.zh-CN.md)和[实施测试报告](../reports/tests/2026-10-15-codex-cli-protocol-adaptation.md)。下文“当前／现状／待补”描述的是实施前的审计基线，不代表实现仍缺失。

配套执行依据：[分阶段适配计划](2026-10-15-codex-cli-adaptation-plan.zh-CN.md)。验证结果见[本轮报告](../reports/tests/2026-10-15-codex-cli-compatibility-audit.md)。

**2026-10-15 最新范围：先完成 Codex CLI 协议中间件，长文本与微信／飞书渠道升级暂缓。** A01–A13 的本批适配及 A14 既有行为回归已实施；微信中途摘要专项仍取消。真实模型／渠道验收和暂缓工作没有计入已完成项。

## 先按使用场景理解

你使用项目时，消息经过这条链路：**微信／飞书 ⇄ Chat-Codex ⇄ 本机 Codex CLI**。这份文档里的“适配”主要是修改中间的 Chat-Codex，让它能正确理解新版 CLI 发来的问题、回答和任务状态，并在微信／飞书里呈现出来。

| 你实际遇到的场景 | 目前怎样 | 本次准备补什么 |
| --- | --- | --- |
| 发任务，让 Codex 执行并回复结果 | 主流程已有 | 保持现有功能，并验证新版 CLI 下的行为 |
| 工作中必须问你一个问题，等你选完再继续 | app-server 模式已有；微信、飞书用 `/a1`、`/a2` 等文字命令回答 | 保留已有交互，补齐新版请求的状态与生命周期处理（A03） |
| 工作中问你一个可选问题，同时继续做其他工作 | 适配不完整；部分问题被当成必须等待，另一类异步问题可能延迟显示或丢失选项 | 区分“必须等你”与“可以继续”，及时显示问题并把回答交回正确位置（A02、A03） |
| 工作做到一半，先给你一部分有用的答案 | 新版消息类型可能混入最终回复缓冲 | 及时显示阶段性答案，保留最后完整结果（A02） |
| 你停止任务，或者 Codex 遇到错误正在重试 | 部分状态可能显示为完成，或者过早结束 | 准确区分完成、中断、失败和恢复中（A04） |
| 恢复旧会话，查看模型／权限，使用 `/goal` | 功能已有；部分新字段与状态同步不完整 | 显示实际生效设置，记录用户明确修改目标的来源（A05、A06 等） |
| 最终回复太长，微信／飞书发送失败 | 长文本保护仍处于设计阶段 | 按渠道预算分段，预计超过 8 段时改发完整 Markdown 文件；详见[长文本设计](2026-10-15-channel-long-text-delivery-design.zh-CN.md) |

“给选项让你回复”已经有一个可用版本。例如 Codex 发来“这次修改范围选哪种？”，聊天里会显示 `/a1 只改文档`、`/a2 同时改代码`；你回复 `/a2` 或 `/a2 先不要提交`，项目就会把选择和补充说明返回给原问题。`/a0` 表示跳过，`/stop` 表示停止任务。这里使用文字命令，不提供与 Codex 桌面端相同的原生选项控件。当前只支持单选；普通文字不会自动当成选项答案。

因此，“用户输入适配”是在已有选择题功能上补上**提问时能否继续工作、问题何时显示、回答应该交给哪一个请求**这些新版行为。这里讲的是信息／偏好问答；命令执行与权限审批是另一条已有交互流程。

微信／飞书插件版本与长文本发送限制属于链路的渠道端，和本篇的 CLI 协议适配分别记录，最后一起验收。下面的字段名与接口清单用于指导开发；理解使用影响时，可以先看本节，再看计划中的场景验收表。

## 1. 结论

Codex 官方参考源码已经同步到本次 fetch 的 `origin/main`。本机 shell 中的 CLI 也是当前 npm 稳定版，但 **CLI 新、参考源码新，不代表 Chat-Codex 的协议语义已适配完整**。

最需要优先处理的是：

1. 协议检查没有覆盖实际启用的实验 API，并且默认清单已有遗漏。
2. `partial_answer`、异步助手消息和结构化问题被当作普通最终回复处理，可能延迟投递、覆盖内容或丢失问题信息。
3. `request_user_input.isBlocking` 没有进入内部模型，非阻塞问题仍进入等待输入流程。
4. `interrupted` 被归为普通完成；`willRetry` 被忽略，恢复中的 turn 可能提前关闭。
5. 用户通过 `/goal` 明确修改目标时，没有向新协议传递用户来源，未记录对应的用户授权上下文。

第二批处理恢复后的真实设置、历史失效、模型能力展示、媒体失败信息、外部时钟和会话列表完整性。原生队列、插件管理、远程控制、语音、原生多 agent 控制等属于可选新功能，不应因为上游提供 API 就全部开放。

本项目并非完全没有近期适配：9 月已实现 `writeStdin` 审批；9 月 30 日已实现 metadata-only resume、有界历史分页和 JSON transport fatal recovery。这些继续作为回归基线。

## 2. 核实的版本与证据边界

| 对象 | 本次核实结果 | 含义 |
| --- | --- | --- |
| Chat-Codex | `main @ a85e0b7`，包版本 `0.1.5` | 审计开始时保留了前序渠道问题的未提交文档，未改业务源码 |
| Codex 参考仓库 | `bb64b894fd67158be0f874872e6d7bfe717e7368` | 提交时间 2026-10-15 11:48:33，北京时间；重新 fetch 成功，`HEAD...origin/main = 0 0`，参考工作区干净 |
| 前次完整协议审计点 | `ddf04ad26789d040f9ef6a96736f76602e35a6cc` | 2026-09-05 审计文档使用的 Codex 提交，作为累计协议差异比较起点 |
| 前次 transport 修复参考点 | `92bc601ad60542c92bf0bb1e7a2eb70b84ac49d2` | 9 月 30 日已完成部分实现，不能把此前所有计划项仍标为未做 |
| 本机 shell CLI | `codex-cli 0.162.1` | 实际执行 `codex --version`；未升级或替换安装 |
| npm `@openai/codex` | latest `0.162.1`；alpha `0.163.0-alpha.11` | 2026-10-15 官方 Registry 查询；alpha 未安装，也未作为生产支持承诺 |
| 本轮环境 | macOS，Node.js `v24.14.0` | 构建、mock 测试及 schema 导出环境 |

不同安装路径、`CHAT_CODEX_BIN` 或桌面 App 内置二进制可能不同；上述 CLI 版本只代表本轮命令实际调用的程序。参考 main 也不能被称为已发布稳定 CLI 的精确源码版本。

证据以当前项目代码、固定提交的上游实现，以及本机稳定 CLI 实际生成的 schema 为主。官方 [App Server 文档](https://learn.chatgpt.com/docs/app-server)和 [CLI 命令文档](https://learn.chatgpt.com/docs/developer-commands?surface=cli)用于核对接入边界；旧设计仅用来核实哪些工作已经完成。

## 3. 协议清单：必须区分默认与实验导出

本项目在 `src/codex/app-server/rpc-client.ts` 中设置 `experimentalApi: true`，现有测试却只读取本地被 Git 忽略的参考仓库默认生成文件。实际执行了：

```bash
codex app-server generate-ts --out /private/tmp/chat-codex-cli-01621-stable-schema-20261015
codex app-server generate-ts --experimental --out /private/tmp/chat-codex-cli-01621-schema-20261015
```

这两个命令只导出类型，不发起模型任务。

| schema 来源 | ClientRequest | ServerRequest | ServerNotification | 当前分类表遗漏 |
| --- | ---: | ---: | ---: | --- |
| 9 月 5 日参考默认生成文件 | 102 | 10 | 83 | 历史比较点，不代表今天的测试结果 |
| 最新 main 默认生成文件 | 108 | 10 | 87 | 1 个 client request、1 个 notification |
| 实装 `0.162.1` 默认导出 | 108 | 10 | 86 | 1 个 client request |
| 实装 `0.162.1 --experimental` 导出 | 173 | 11 | 86 | 66 个 client request、1 个 server request |

默认 main 相对 9 月 5 日增加 7 个请求、移除 1 个请求，增加 4 个通知：

- 请求新增：`account/gatewayOAuth/read|login|cancel`、`thread/attachment/add|list|remove`、`thread/attachmentOwner/list`。
- 请求移除：`thread/rollback`，现分类表仍把它写成 candidate。
- 通知新增：`account/gatewayOAuth/changed`、`thread/attachment/updated`、`thread/prediction/updated`、`thread/readState/changed`。
- 当前遗漏是 `thread/attachmentOwner/list` 和 `thread/readState/changed`；后者只在本次 main 默认快照中出现，实装稳定版未导出。
- `thread/list` 已有实际实现和测试，分类表仍是 candidate，需要修正记录。

实验版多出的 65 个 client request **不等于 65 个最近新增的必做功能**：现有检查一直没有覆盖这一层。它们主要属于 native queue、thread/turn settings、project/search、background terminals、Realtime、remote control、plugin search、environment/process、账号验证与内部测试方法。先逐个分类，多数保持不开放；不要为消除测试失败机械写成 handled。

额外 server request 是 `currentTime/read`。本项目当前会回 `-32601`；外部时钟配置启用时有实际影响，见 A10。

现有测试还存在两处限制：只检查“上游方法是否登记”，不检查已移除方法和字段语义；参考目录不存在时会 skip。因此本轮 **89 项测试中的 1 项失败**只是最先暴露的清单缺口，88 项通过不能证明所有新版语义已兼容。

## 4. 当前能力盘点

| 能力 | 当前入口／实现 | 本轮判定 |
| --- | --- | --- |
| CLI 查找、Windows shim、启动诊断 | `codex-process.ts`、`codex-cli.ts` | 已有实现及回归；仍缺版本／功能兼容诊断 |
| stdio initialize、进程重启、RPC fatal | `app-server/rpc-client.ts` | 已实现；不自动重放有副作用 RPC 的边界应保留 |
| 创建、恢复、命名、读取 session | `app-server-codex-adapter.ts` | 已实现；恢复后的有效设置同步仍不完整 |
| 会话发现与列表 | `thread/list`、本地索引／SQLite／rollout fallback | 已实现；远端只读首 100 条，需完善有界分页 |
| run、steer、interrupt、plan | adapter、`turn-controller.ts`、`route-queue.ts` | 主链路已有；新增消息与终止语义需适配 |
| commentary、progress、后台 Goal 续跑 | `turn-controller.ts`、Bridge 对应 delivery | 已实现；async 消息不能复用会被 silent 抑制的 progress |
| 结构化工具进度 | `tool.progress`、`sendToolProgress`、微信 type 11/12 | 部分工具已有底层能力；微信公开模式不启用，本轮保持既有范围 |
| 普通／文件／权限／writeStdin 审批 | `approval-handler.ts`、共享审批、飞书卡片 | 已实现；新字段、未知决定集和有效权限还需补强 |
| 阻塞用户输入与 `/a数字` | `server-request-mapper.ts`、`pending-input.ts` | 已实现；缺少 `isBlocking` 语义 |
| `/compact`、刷新上下文、有界历史读取 | `thread-history.ts`、compact waiter | 9 月 30 日已适配分页；partial 筛选与历史失效待补 |
| `/models`、模型、effort、service tier、`/fast` | `model-policy.ts`、模型命令和格式化 | 已动态读取，模型与 effort 无需逐个硬编码；仍有元数据和有效设置缺口 |
| 文本、`localImage`、普通文件输入 | `input-mapper.ts` | 已实现；普通文件转路径说明；新增 fileId/audio 不自动获得支持 |
| Goal 创建／状态／清除 | `goal-api.ts`、`goal-command.ts` | 已实现；新来源语义需要适配 |
| MCP elicitation／动态工具／认证请求 | `server-request-mapper.ts` | 当前显式拒绝或取消；这是明确边界，不等于模型侧全部 MCP 工具不可用 |
| exec JSONL 备用模式 | `exec-codex-adapter.ts` | 已实现基础运行与取消，非交互审批模式；不能宣称与 app-server 能力对等 |

## 5. 需要适配的能力清单

P0 表示会影响已有交互的正确性或审计可信度；P1 表示需随后完善的状态一致性、能力展示及条件兼容。标注“既有缺口”的项目不是声称上游最近才新增。

### A01 · 协议契约和版本检查（P0）

**证据：** 第 3 节的三套当前 schema、`protocol-capabilities.ts`、`app-server-mappers.test.ts:243`。初始化还把本项目版本写死为 `0.1.0`，与包版本 `0.1.5` 不符。

**适配：** 稳定 CLI 默认／实验协议与 main 跟踪基线分开；提交小型方法清单及实际使用字段的 fixture，使 CI 不依赖忽略目录。登记新增、移除及重新分类项目，核查 ServerRequest 必须有响应；方法分类与行为验收分开。报告实际二进制版本、模式和已验证能力，使用真实包版本做 clientInfo，不只显示“codex 可执行”。

不以一个硬编码最低版本替代能力验证；目前没有本轮证据可承诺整个历史 CLI 版本范围都支持。

### A02 · 阶段性回答、异步消息、结构化问题（P0）

**上游：** `MessagePhase` 新增 `partial_answer`；`ThreadItem.agentMessage` 带 `delivery: "async"` 和 `questions`。这些字段在本机稳定版实验导出中均存在；async/questions 是 9 月待办延续，partial 是本轮累计 diff 新增。

**当前：** `messagePhaseValue()` 只认识 commentary/final。`handleItemCompleted()` 把其余消息写入 `finalText`，发 `assistant.completed`；Bridge 只替换缓冲，直到 turn 结束再投递，后面的 final 会覆盖前面的异步消息。questions 未传入内部事件。历史读取只排除 commentary，也会把 partial 当成“最后最终回复”。

**影响：** 执行中的询问可能不能及时抵达微信／飞书；中间答案可能覆盖、被覆盖或在上下文刷新时被误当成最终结果。并非收到 partial 就立即结束 turn，但内容身份已经丢失。

**适配：** 内部事件保留 itemId、phase、delivery、questions。partial/async 在完整 item 到达时按消息投递一次，保留任务运行状态；final 按 turn 完成策略投递。去重使用 thread/turn/item 身份，不以相同文本去重。异步问题通过普通用户回复／`turn/steer` 回答，不伪造不存在的 ServerRequest ID，也不占用阻塞 `/a数字` 槽位。旧模型缺 phase 保留原兼容行为；历史补投排除明确的 partial、commentary 和 async 询问。

### A03 · 非阻塞 `request_user_input`（P0）

**上游：** `ToolRequestUserInputParams.isBlocking`，`autoResolutionMs` 已标为旧字段。

**当前：** raw 保留 false，但 `CodexUserInputRequest` 没有该字段；adapter 和 Bridge 一律进入 waiting_input，`BridgePendingInputManager` 使用每 route 一个 pending、`/a数字` 和 30 分钟本地超时。

**适配：** 区分阻塞与可选问题。非阻塞请求保留 RPC request 身份和回答入口，但不锁住普通消息／steer，不把运行状态强改为等待输入；支持多请求时以明确问题编号定位。以 `serverRequest/resolved`、连接 generation、turn 生命周期管理迟到回答。旧 server 缺字段时保留阻塞 fallback；不默认选择第一个选项，也不把未回答解释为同意。保密输入和 MCP 授权的现有边界继续保留。

### A04 · turn 终止、重试和结构化错误（P0）

**上游：** `Turn.error` 现在可用于 interrupted，`ErrorNotification.willRetry` 明确表示上游是否还会重试。后者是本轮发现的既有处理缺口，并非本轮新增字段。

**当前：** `turn/completed` 仅单独处理 failed，其余状态统一发 turn.completed；非特定 `Reconnecting...` 文本的 error 一律关闭 turn，未读取 willRetry。模拟已确认 interrupted 的 error 丢失，以及 willRetry=true 被提前失败关闭。

**适配：** 内部区分 completed/interrupted/failed，保留终止原因、`codexErrorInfo` 和必要的 misalignment 摘要；只在真实终止时清理对应 turn 的审批/input。willRetry=true 作为恢复状态，不重放 turn；缺字段时保留有界兼容判断。文本解析错误仍属于 fatal transport，不能因为本项放松。状态修复需要同时覆盖前台、后台 Goal、compact waiter 和 exec 取消语义。

### A05 · Goal 的用户来源和状态（P0 来源／P1 展示）

**上游：** `ThreadGoalSetParams`、`ThreadGoalClearParams` 新增 `origin: "user" | "automatic"`。`thread_goal_processor.rs` 仅在 origin=user 时记录用户修改目标的上下文；缺省来源仍可更新记录，**不能说它必然报参数错误**。

**当前：** `setGoal()`、`setGoalStatus()`、`clearGoal()` 均不传 origin；这些函数当前由 `/goal` 用户命令调用。goal updated/cleared 通知被列为 ignored_safe。

**适配：** 将明确用户命令的来源传为 user；将来自动流程必须显式用 automatic，不能全局伪装成用户。同步目标状态／预算变化时只更新原 session，不因此新建目标、改变预算或替用户恢复；后台续跑仍由 Codex 原生 Goal 驱动。

### A06 · 恢复后的模型、Plan 和权限（P1）

**上游：** resume 新增有效 `collaborationMode`；实验响应包括 `activePermissionProfile`、`runtimeWorkspaceRoots`。`thread/settings/updated` 包含模型、effort、审批 reviewer 和权限等完整设置。

**当前：** resume 不吸收协作模式；设置通知只更新 cwd 与部分模型信息。请求配置与服务端有效配置混在同一展示模型，本地覆盖可能掩盖 server 返回。`modelInfoFromResponse()` 不使用 Thread 上的 model/reasoningEffort 兜底。

**适配：** 明确“本地期望设置”和“服务端有效设置”，恢复并显示真实 Plan/default、模型与权限来源。服务端约束不能被 UI 中的“full”或“approve-for-me”标签替代；保持三种用户权限模式，不自动扩大 writable roots，不将安全回退包装为升级成功。变更优先级在计划中固定为：受管限制优先，明确当前用户选择其次，服务端恢复值作为没有新覆盖时的状态来源。

### A07 · 历史变化和分页一致性（P1，partial 筛选随 A02）

有界 `thread/turns/list`、`thread/items/list` 和 `excludeTurns: true` 已实现；新 cursor 支持 item anchor 是增量能力，现有字符串 cursor 仍有效，不必重写已正确的分页。

`thread/reverted` 仍是 candidate，未使本地缓存失效。需按 session 标记历史／最后回复／预览失效，重新获取有限元数据；核对本地未决审批/input 的归属，避免再发送旧答案。保持 route owner，不把“会话历史回退”说成文件回滚，也不因此自动重跑 turn。main 新的 readState 通知只涉及展示，暂不映射为微信／飞书已读。

### A08 · 图片生成及工具失败显示（P1）

`ImageGenerationItem.failure` 在 9 月已列待办，当前仍未处理。`progressFromThreadItem()` 有路径就生成“媒体生成完成”，没有路径就忽略，不展示额度失败原因；工具状态另有 failed 映射，但不能替代用户能理解的失败信息。

需先判 failure/status，再决定完成、失败或可下载结果；`usageLimitExceeded` 的恢复时间有值时再显示。imageView 与 imageGeneration 语义分开。MCP、fileChange 等既有“完成”文本也要与实际状态保持一致，不把大型 base64 result 当成文件路径或全部转发。

### A09 · 模型目录与运行时能力（P1）

已支持动态 `model/list`、开放 effort 字符串、serviceTiers、inputModalities、升级信息，因此无需为每个新模型新增硬编码分支。

可补 `modelSpecialty`、`multiAgentVersion`、`availableAccessPrograms` 元数据及 provider capabilities。`additionalSpeedTiers` 已弃用，应继续优先 serviceTiers；`supportsPersonality` 已弃用且恒 false，不应新建人格选择器。模型目录不是账号准入保证；缺能力字段显示未知，不能推断已获权限或自动切换模型。新增 fileId/audio 输入先列候选，现有 localImage 与普通文件路径方式继续回归。

### A10 · 外部时钟请求（P1，按配置触发）

稳定 CLI 实验 schema 的 `currentTime/read` 返回 `{ currentTimeAt: number }`，单位是整 Unix 秒。本项目当前按未知请求返回 `-32601`。

上游 `core/src/current_time.rs` 表明默认仍用系统时钟；配置 `features.current_time_reminder.clock_source = "external"` 时才选外部 provider。不能说所有新版任务必然因此失败。

建议在 adapter 内提供受控 UTC 时间响应，校验 thread 归属和 RPC generation，不进入聊天交互。此项不等于实现定时任务、客户端 sleep 调度或新的渠道命令。

### A11 · 会话列表完整性（P1，既有缺口）

当前 `listSessionsFromThreadList()` 只取 100 条、不读 nextCursor，且任意错误都会重试旧 sortKey。需有界翻页、游标去重和明确“结果截断”状态；仅协议不兼容时切旧排序，不能用同一次鉴权／网络错误继续重复请求。与聊天列表原有编号、分页及本地 fallback 保持一致，不因支持原生搜索就绕过 route/session owner。

### A12 · 审批协议边界补强（P1）

writeStdin 及其只允许本次接受／取消的语义已经实现。普通命令也已读取 availableDecisions，但只映射四种字符串；若明确提供的数组全是未知决定，目前会回到默认允许集合。

实施时区分“老 server 没字段”与“server 明确给出空／未知集合”，后者不能扩张权限。扩展权限的展示与响应须对齐请求中的实际范围；保留原请求供诊断，未知结构可明确拒绝而不能猜测授权。autoApprovalReview 通知不等于待用户回复的审批请求，不新增虚构 `/OK` 操作。

### A13 · exec 与平台兼容声明（P1）

exec 模式仍需验证当前 `codex exec --json`／resume 参数和 JSONL 事件，但它不承诺交互审批、Goal、steer、动态模型菜单等 app-server 专属能力。新功能通过 adapter capability 控制，不能把不支持的路径静默切换到更宽权限执行。

本轮只跑既有 mock/解析测试，不启动真实模型任务。Windows launcher 虽已有测试，真实 Windows CLI 安装及包装器仍列平台验收项。

### A14 · 阶段摘要的渠道投递（既有行为回归，微信专项取消）

用户所指“进度”是 Codex 工作中偶尔给出的自然语言摘要，例如“已找到问题，接下来检查修复”，通常对应 commentary；不是工具开始／结束，也不是最终回复。

当前 `handleItemCompleted()` 能识别 commentary 并输出 `assistant.commentary`；前台及后台交由 `BridgeCommentaryDelivery` 发送文本。普通微信 brief 模式允许投递，silent 通常不投递；Plan 模式存在单独允许 commentary 的分支。默认合并间隔 3 秒，待发最多保留 3 条文本，再截到 1200 字符；有文本去重和失败冷却，但不代表已经解决长任务连续拒收。

用户最新决定取消微信摘要专项：不新增摘要专用频率、额度、合并或草稿机制，不以摘要规避发送限制作为本轮目标。既有 commentary 和用户进度偏好保留，只在通用协议修改时做必要回归。

A02 中的新 partial/async 仍可能混入 final 缓冲，消息身份、实际阶段答案和用户问题的适配继续保留；阶段回复不结束任务，最终回复独立处理。微信新版协议、最新上下文、长度保护、通用节流与有界恢复按渠道计划推进；飞书原有适配范围不变。

微信工具 type 11/12 的现状检查及 6 项既有测试仅为另一条链路的背景证据。原 tools 入口扩展与微信摘要专项均不纳入本轮必做项。

## 6. 只登记或后续立项的能力

| 上游能力 | 本次决策 | 理由／边界 |
| --- | --- | --- |
| `thread/attachmentOwner/list`、attachment 操作 | 默认 not_exposed | 工作树／PR 等 thread 附件元数据不等于本项目微信上传的文件 |
| main `thread/readState/changed` | ignored_safe／本地诊断 | 不把 Codex 读状态冒充渠道已读 |
| gateway OAuth、账号验证、认证 token | 当前不接管 | CLI 登录与桥接消息能力分开；新增 API 先明确响应或不可用提示 |
| 原生 thread queue、prediction、project/search、section | 独立候选 | 不用另一套队列直接覆盖现有 route 队列和所有权 |
| background terminal／process/exec 控制 | 独立候选 | 当前已有 writeStdin 审批不等于开放任意远端终端控制 |
| 动态工具、MCP UI／event、插件管理、disabledPluginIds | 保持边界，另行设计 | 不扩大外部授权；schema 明示 disabledPluginIds 目前不等于实际过滤能力，不能拿它作隔离保证 |
| 语音／Realtime、remote control、环境迁移 | 不纳入本轮 | 需要新的渠道交互、身份与生命周期设计 |
| 子 agent 的模型、effort、parent/root turn | 元数据候选 | 普通用户发起 turn 无需伪造父 turn；仅将来实际委派才传正确来源 |
| `/recap` | 后续独立能力 | 现有文档是 TUI 功能设计，当前源码仍需按最新临时任务隔离机制复核，不能把旧文档当成已经实现的 RPC |
| 已移除 `thread/rollback` | 从当前目标清单移除／历史版本单列 | 当前没有调用它，不构成现有命令的即时破坏；不顺带新增 revert 命令 |
| `mock/experimentalMethod` 等内部测试接口 | 不开放 | 导出类型不代表面向用户的产品能力 |

## 7. 验证结果与置信边界

- `npm run build` 通过。
- 89 项现有定向测试：**88 通过、1 失败、0 跳过**。失败为 schema inventory 漏登记 `thread/attachmentOwner/list`；独立清单对照同时确认 main 的 readState 漏项。
- 8 项临时离线探针确认现状：partial 未识别、async/questions 丢语义、isBlocking 未归一化、interrupted 当 completed、willRetry=true 被关闭、image failure 展示不完整、历史选择 partial、外部 clock 返回未知方法。
- Goal origin 与恢复设置等结论来自调用链和上游处理器对照，未向真实账号写入目标或修改权限。
- 未运行全量 `npm test`，未进行真实模型 turn、微信／飞书投递、SDK 升级或 CLI 安装变更。模拟结果不等于真实端到端验证。

这些差异能说明需要适配哪些能力，但没有证据将它们直接归因为之前那条微信 `prepare failed`。渠道长文本工作见[独立设计](2026-10-15-channel-long-text-delivery-design.zh-CN.md)，与本计划在统一消息投递层衔接。

## 8. 主要代码证据

本项目：`src/codex/app-server/{rpc-client,protocol-capabilities,turn-controller,notification-mapper,server-request-mapper,thread-history,model-policy,approval-handler}.ts`，`src/codex/app-server-codex-adapter.ts`，`src/bridge/{route-queue,background-turns,pending-input}.ts`，`src/bridge/commands/goal-command.ts`。

官方固定参考：`references/openai-codex/codex-rs/app-server-protocol/schema/typescript/`；`app-server/src/request_processors/thread_goal_processor.rs`、`thread_goal_user_context.rs`；`core/src/current_time.rs`；`tui/src/chatwidget/streaming.rs`。以上相对路径均位于该参考仓库的 `codex-rs/` 下。

源码版本与校验方法见[参考索引](../references/README.md)，本机二进制导出的类型优先用于判断已发布稳定版实际协议面。
