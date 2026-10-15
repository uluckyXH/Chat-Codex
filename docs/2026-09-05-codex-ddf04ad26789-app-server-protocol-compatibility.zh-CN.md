# Codex app-server 协议适配清单（第一轮：只看协议）

> 2026-10-15 后续审计：见[最新能力清单](2026-10-15-codex-cli-compatibility-audit.zh-CN.md)和[分阶段计划](2026-10-15-codex-cli-adaptation-plan.zh-CN.md)。writeStdin 与历史分页已完成；非阻塞输入、async 消息、历史失效和媒体失败等待办继续推进，并补充 partial_answer、Goal 来源及实验协议门禁等本轮发现。

审计日期：2026-09-05
Codex 源码基线：`references/openai-codex` @ `ddf04ad26789d040f9ef6a96736f76602e35a6cc`

> 文件名中的 `2026-09-05` 和 `ddf04ad26789` 分别是本轮审计日期与上述 Codex 源码 commit 的短 ID；
> 它们**不是** Chat-Codex 项目的提交号。

状态：已完成源码比对和适配分级；协议项 1（`writeStdin`）的中间件、官方语义等价的审批内容展示、
微信文字链路和飞书私聊两按钮审批卡均已实现，并有 mock / fake app-server / fake channel 自动化覆盖。
2026-09-30 已补完分页历史和 `excludeTurns` 恢复；真实微信、飞书帐号验证仍待补测，其它协议项的
**业务适配**尚未开始实现。

更新：2026-09-05

## 1. 本文只回答什么

本文只回答一个问题：**最新 Codex app-server 协议变化中，哪些会影响 Chat-Codex 已有能力，
因此需要适配；哪些只是 Codex 新增功能，当前 Chat-Codex 没有对应能力，不应硬做。**

### 1.1 已确认的推进顺序

本轮不是一次性把所有 Codex 新功能塞进 Chat-Codex，而是按以下顺序推进：

1. **先做协议适配**：以项目内已更新的 Codex 源码为依据，逐项讨论“它是什么、Chat-Codex 现有行为是什么、
   聊天端如何交互、是否真的需要开放”。
2. **一次只进入一个协议项**：先把交互和安全边界记录清楚，经确认后才改中间件代码和补测试；不把下一项
   偷偷混进当前实现。
3. **协议项全部完成后，再做模型适配**：最终目标是让 Chat-Codex 正确取得新版 Codex 的模型列表，并让
   新模型能被展示、选择、传给 `turn/start`、保存为 session 策略及正确显示实际思考程度。

当前 Chat-Codex 已经运行时调用 `model/list`，没有硬编码模型名。因此最后的“新模型适配”不是手工维护
一张模型名字表，而是验证和补齐新版模型返回字段、模型选择、思考程度、service tier 与状态显示的完整链路。

### 1.2 第一项进度：`writeStdin`（中间件与渠道自动化已完成）

**协议项 1：`item/commandExecution/requestApproval` 的 `kind: "writeStdin"`。**

这是第一项的原因不是它比所有事项“优先级更高”，而是它直接改变已有 `/OK`、`/P`、`/NO` 审批的含义：
以前 Chat-Codex 只把它当作“是否执行一条命令”；新版还会请求“是否向一条已经运行的终端输入内容”。
若不区分，用户可能误以为批准的是一条新命令，或中间件错误结束原本仍在运行的命令。

本文不讨论以下事项：

- 新模型名单、模型展示、模型专长或模型退役策略；这些另开“模型适配”清单。
- Scheduled tasks、multi-agent、plugins、MCP 表单、实时语音等产品功能是否立项。
- Chat-Codex 登录或 token 管理；Chat-Codex 不接管本机 Codex 的登录。

这里的“适配”也不等于“向微信/飞书增加一个功能”。有些工作只是让已有行为在新版
app-server 下继续正确工作，或在协议清单中明确标为不开放。

#### 本项当前完成边界

本轮已完成 app-server adapter、审批状态、Bridge 命令解析和共享文字审批提示。微信没有审批卡 API，
因此使用文字提示；飞书群聊也继续使用文字兜底。飞书私聊则在通用卡片决策中增加 `cancel`，并按审批类型
收敛按钮：`terminal_input` 只显示“本次允许 / 取消并中止任务”，普通审批仍保持原来的三按钮。卡片发送失败
仍自动回退到同一份文字提示，避免把“取消并中止任务”错误显示成普通“拒绝”。

因此，本项的本地自动化实现已经完成；真实帐号上的微信文字交互和飞书 `card.action.trigger` 回调仍是渠道
验收，不把 fake 测试冒充成真实验证。

本次实现和测试记录见
[`reports/tests/2026-09-05-codex-writestdin-middleware-adaptation.md`](../reports/tests/2026-09-05-codex-writestdin-middleware-adaptation.md)。
飞书卡片和微信文字链路的后续实现记录见
[`reports/tests/2026-09-05-feishu-terminal-input-approval-card.md`](../reports/tests/2026-09-05-feishu-terminal-input-approval-card.md)。

### 1.3 审批内容展示：对齐 Codex 核心语义，而不是复制按钮外观

这里的“像官方 Codex 一样展示”特指**用户在批准前能看见什么操作会发生**，不是指把终端 TUI 的按钮、
快捷键或 `/OK` 卡片逐像素搬到渠道中。

项目内 Codex 源码 `codex-rs/tui/src/bottom_pane/approval_overlay.rs` 的当前逻辑是：

- 普通命令审批展示 `Environment`、`Reason` 和完整命令；
- `writeStdin` 审批展示目标 terminal id，以及带引号、控制字符可见的 `Input`；它不把 stdin 输入伪装成一条
  新命令。

Chat-Codex 已按同一语义投递到微信文字、飞书私聊卡片、飞书/卡片失败后的文字回退，以及 `/status` 的待审批
摘要中：

| Codex 审批种类 | 渠道中实际展示的核心内容 |
| --- | --- |
| 普通 `command` | 执行环境（server 提供时）、原因、**将执行的完整命令**、CWD |
| `writeStdin` | 执行环境（server 提供时）、原因、**目标终端**、**将输入的精确文本**、CWD；明确“不启动新命令” |

`writeStdin` 的协议只有一个 canonical `command` 字符串。当前中间件只接受官方当前使用的
`write_stdin --session-id <id> <input>` 四参数表示，将其恢复为终端 id 和原始输入；输入以 JSON 风格带引号
显示，因此换行、制表符、NUL 等不会在渠道中变成不可见内容或额外聊天指令。若未来 server 发送了无法按该
格式安全恢复的字符串，渠道会显示**完整、已转义的原始终端输入请求**，不会编造“输入了什么”；只有连
可展示的 `command` 都缺失时才会 fail closed 为 `cancel`。

## 2. 证据和基线

### 2.1 比对版本

| 项目 | 版本 / 提交 |
| --- | --- |
| Chat-Codex | `main`，审计启动时 HEAD `dafa189` |
| 官方 Codex 旧参考点 | `61a44880a85d2fd0d8770908dea5733495e571c8` |
| 官方 Codex 当前参考点 | `ddf04ad26789d040f9ef6a96736f76602e35a6cc` |

主证据均来自项目内、已更新的 `references/openai-codex/`：

- `codex-rs/app-server-protocol/schema/typescript/`：生成的协议 schema；
- `codex-rs/app-server-protocol/src/protocol/` 与 `codex-rs/app-server/`：生成 schema 未覆盖的
  experimental 字段和实际发送语义；
- `codex-rs/app-server/README.md`：与实现相邻的协议说明。

Chat-Codex 对照入口主要是：

- `src/codex/app-server-codex-adapter.ts`：RPC 调用、server request 和通知路由；
- `src/codex/app-server/approval-handler.ts`：审批请求/响应映射；
- `src/codex/app-server/server-request-mapper.ts`：`request_user_input` 和不支持请求；
- `src/codex/app-server/thread-history.ts`：上下文刷新后的最后回复读取；
- `src/codex/app-server/turn-controller.ts`：turn item 和最终回复投递；
- `src/codex/app-server/protocol-capabilities.ts`：本地协议分类表；
- `tests/unit/app-server-mappers.test.ts`：生成 schema 的方法覆盖门禁。

### 2.2 本轮术语

| 结论 | 含义 |
| --- | --- |
| 必须适配 | 新版协议会使已有 Chat-Codex 行为错误、陈旧或不完整；应改代码并补测试 |
| 必须分类 | 当前不一定有用户可见动作，但协议门禁必须明确其安全处理方式 |
| 待交互决定 | 协议语义已变化，当前实现不能假装已经支持；是否把它送到聊天端需单独确认 |
| 当前不适配 | Chat-Codex 没有对应已有能力；不发送该请求，也不新增聊天功能 |

## 3. 源码比对总览

相对旧参考点，最新生成 schema 的方法数量变化如下：

| 方向 | 旧参考点 | 当前参考点 | 本轮差异 |
| --- | ---: | ---: | --- |
| ClientRequest（Chat-Codex 调用 app-server） | 93 | 102 | 新增 9 个方法 |
| ServerRequest（app-server 请求 Chat-Codex 回应） | 10 | 10 | 方法名未增加，但已有审批/输入参数变化 |
| ServerNotification（app-server 主动通知） | 72 | 83 | 新增 11 个通知 |

当前 `protocol-capabilities.ts` 已为这批新增方法补齐 schema 门禁分类：9 个 ClientRequest 和 11 个
ServerNotification 均已登记，`protocol inventory` 测试通过。新增 ClientRequest 如下：

```text
thread/section/move
thread/revert
threadSection/list
threadSection/create
threadSection/update
threadSection/delete
thread/turns/list
thread/items/list
plugin/reconcile
```

这项测试只检查“方法名是否被登记”，不能代替字段语义测试，也不表示 `thread/turns/list`、
`thread/items/list` 或 `thread/reverted` 已具备用户可见行为；它们仍按下文列出的协议项逐项实现。

## 4. 先给结论：真正触及现有能力的协议项

下表的编号只是本篇清单的序号，**不是优先级**，也不是指已有功能已经关闭或尚未开放。

| 编号 | 新版协议变化 | 触及的已有 Chat-Codex 能力 | 结论 |
| --- | --- | --- | --- |
| 1 | 命令审批增加 `kind: command \| writeStdin` | `/OK`、`/P`、`/NO` 审批 | 必须适配；普通 command 保留三种决定，当前 `writeStdin` 只允许本次通过或取消 |
| 2 | `request_user_input` 增加必填 `isBlocking` | 当前 `/a数字` pending-input 流程 | 必须解析并保留语义；非阻塞交互另行确认 |
| 3 | `thread/read(includeTurns)` 被标为历史兼容路径；新增分页 API | 已有 `/context-refresh reload` 及 `reloadSession()` | 必须适配，保留同一 context 刷新能力 |
| 4 | `agentMessage` 增加 `delivery: "async"` 和 `questions` | 当前最终回复投递和执行中消息 steer | 必须适配；执行中即时投递，普通回复走已有 steer |
| 5 | 新增 `thread/reverted` 通知 | 本地 session/status/history 缓存 | 必须分类并使本地缓存不再当作最新历史 |
| 6 | `imageGeneration` item 增加 `failure` | 当前“媒体生成完成”进度提示 | 必须适配，失败不能报成完成 |

以下看起来也与已有能力接近，但本轮不应混入“必须开发”：

| 项目 | 结论 |
| --- | --- |
| `availableDecisions` | 当前源码已支持的 experimental 字段，并非本次 old → new schema 新增；但 Chat-Codex 已在 initialize 中启用 `experimentalApi`，当前又固定假设 `/OK /P /NO`，应作为协议项 1 的补强一并处理 |
| `TurnError.misalignment` | 可以补充错误说明，但当前普通错误消息仍可工作；列为待交互决定，不是阻断升级 |
| `Thread.model` / `Thread.reasoningEffort` | 是协议字段变化，但归入下一轮“模型适配”，本文只记录其存在，不决定模型展示方案 |
| `serviceTierForTurn` / `turnTrigger` | 都是可选的 `turn/start` 字段；当前不发送仍是有效请求，不适配 |

## 5. 新增 ClientRequest：9 项逐项清单

这些是“Chat-Codex 可以调用 app-server 的新方法”。新增到 schema 不表示 Chat-Codex 必须调用。

| 方法 | 官方源码语义 | 现有 Chat-Codex 是否有对应能力 | 本轮结论 | 最小处理 |
| --- | --- | --- | --- | --- |
| `thread/section/move` | 将 thread 放入/移出 section | 没有 section、项目分组或对应聊天命令 | 当前不适配 | 在协议表登记 `not_exposed`；不发送 RPC |
| `thread/revert` | 用指定 turn 之前的历史替换持久历史；**不回滚本地文件** | 没有 `/revert` 聊天命令；现有 `/compact` 不是 revert | 当前不适配该请求 | 登记 `not_exposed`；单独处理 `thread/reverted` 通知（见第 8 节） |
| `threadSection/list` | 列出 sections | 无 | 当前不适配 | `not_exposed` |
| `threadSection/create` | 创建 section | 无 | 当前不适配 | `not_exposed` |
| `threadSection/update` | 修改 section | 无 | 当前不适配 | `not_exposed` |
| `threadSection/delete` | 删除 section | 无 | 当前不适配 | `not_exposed` |
| `thread/turns/list` | 分页读取 thread 的 turn | 有：上下文刷新后读取历史/最后回复 | 必须适配 | 作为新 server 的刷新读取路径 |
| `thread/items/list` | 分页读取指定 turn 或整个 thread 的 item | 有：上下文刷新后查最后最终回复 | 必须适配 | 与 `thread/turns/list` 配合，读取有限最新项 |
| `plugin/reconcile` | 协调 plugin 状态 | 没有 plugin 管理能力 | 当前不适配 | `not_exposed` |

### 5.1 分页历史为什么是已有功能的适配，而不是新功能

修复前，`AppServerCodexAdapter.reloadSession()` 的过程是：重新启动 app-server、`thread/resume` 同一个
thread，再由 `thread/read({ includeTurns: true })` 读取整段历史，从中找最后最终 assistant 回复。

新版源码明确把全量 `includeTurns` 标为对旧客户端保留的兼容方式，并新增：

- `thread/resume.excludeTurns: true`：恢复配置和 metadata，但不塞入全部 turn；
- `thread/turns/list`：按页取得 turn；
- `thread/items/list`：按页取得 item；
- `turnsBackwardsCursor` / `itemsBackwardsCursor`：从最新端往回读取的游标。

目标不是重新设计上下文，也不是清历史，而是保持已有 `/context-refresh reload` 在长 session 和新版
app-server 下仍然正确。2026-09-30 已实施的策略：

1. `thread/resume` 携带 `excludeTurns: true`，仅读取有界的最新 turn/item 页来找最终回复；
2. 分页方法不支持时，reload 保持成功但不补投最后回复；
3. `excludeTurns` 不支持时保留原始协议错误并要求升级 app-server，不回退
   `thread/read(includeTurns: true)`；
4. 不对每次刷新无上限拉取整个 rollout 历史。

这项改变只发生在刷新/恢复路径；同一聊天正常连续发送消息本来就在同一个 Codex thread 内，不会在
每一轮重新读取完整历史。

### 5.2 `thread/revert` 的边界

新版 `thread/revert` 只改 Codex 持久对话历史，且从 `beforeTurnId` 起排除该 turn 及之后的 turn；
它不回滚工作目录里的文件。Chat-Codex 当前没有对外暴露 history revert，因此：

- 不新增 `/revert`；
- 不把它和 `/compact` 或文件回滚混为一谈；
- 只在 app-server 通过 `thread/reverted` 告知已有 thread 被外部回退时，更新本地状态边界。

## 6. 已有 ClientRequest 的字段变化

### 6.1 `thread/resume` / `thread/read`

| 变化 | 当前实现 | 结论 |
| --- | --- | --- |
| `thread/resume.excludeTurns?: boolean` 新增 | 已传该字段 | 用于 metadata-only 恢复；旧 server 不支持时要求升级，避免完整历史风险 |
| `thread/read.includeTurns` 被标为全量 hydration 旧兼容路径 | `reloadSession()` 不再依赖它 | 已替换为有界分页；不保留 full-history fallback |
| `ThreadResumeResponse` 新增两个 backwards cursor | 当前未读取 | 分页改造时读取；否则不必处理 |

### 6.2 `turn/start`

当前 Chat-Codex 仍在发送有效的 `turn/start`：`input`、cwd、审批策略、sandbox、model、持久
`serviceTier`、effort 和 collaboration mode。最新版新增的三个字段均为可选：

| 新字段 | 实际作用 | 本轮结论 |
| --- | --- | --- |
| `turnTrigger?: string` | 调用方标记本次 turn 的内部来源；steer 时忽略 | 当前不适配；没有用户可见能力 |
| `toolOutput?: TurnToolOutput` | 以空 input 提交动态工具输出 | 当前不适配；Chat-Codex 没有动态工具 host |
| `serviceTierForTurn?: string` | 仅覆盖这一个新 turn 的 tier，不改 thread 之后的 tier | 当前不适配；现有持久 `serviceTier` 已正常透传 |

不发送这些字段不是协议错误，不能为了“跟上新版”凭空加命令或默认值。

### 6.3 `initialize.capabilities.extensions`

新版将 `openai/form` MCP 能力的新版声明位置放入可选 `extensions`；旧的
`mcpServerOpenaiFormElicitation` 仍是 legacy 字段。当前 Chat-Codex 对 MCP elicitation 统一安全取消，
没有表单交互能力，因此：

- 不声明 `extensions`；
- 不启用旧 flag；
- 当前取消行为保留。

### 6.4 `thread/list` 和 thread 元数据

新版把 `ThreadListParams.isPinned` 换成 `sectionId`，并加 `originators`；`Thread.isPinned` 也被 section
信息替代。Chat-Codex 当前的 `thread/list` 只传 `limit`、排序、`archived` 和 `useStateDbOnly`，不发送
`isPinned`，也不读取该字段，因此这次变化不造成现有调用断裂。

`Thread.model`、`Thread.reasoningEffort` 和 model/list 返回字段的审计留给下一轮模型专题；协议层只需
记录：恢复/列表 mapper 不应因为这些新增字段而失败。

## 7. ServerRequest：方法名未新增，现有交互字段发生变化

### 7.1 命令审批：`item/commandExecution/requestApproval`

这是当前 Chat-Codex 最直接需要适配的协议变化。新版新增必填字段：

```text
kind: "command" | "writeStdin"
```

#### 改造前：当前普通审批全链路

在本项实现前，Chat-Codex 的审批链路已经存在，但它把同一 RPC 方法的所有请求一律视为“新命令审批”：

| 环节 | 原有实现 | 本项暴露的问题 |
| --- | --- | --- |
| app-server 收到 server request | `AppServerCodexAdapter.handleServerRequest()` 调 `approvalFromServerRequest()` | 不读取 `params.kind`，所以 `writeStdin` 也被映射为 `command` |
| 本地审批对象 | `approval-handler.ts` 取 thread/turn/item/command/cwd/reason，固定写入 `/OK /P /NO` 对应的四种内部 decision | 未保留 server 实际允许的决定集合；stdin 也会错误出现 `/P` |
| adapter pending 表 | 以 JSON-RPC **request id** 保存 `PendingServerApproval`，向 turn 流发 `approval.requested` | 这个回传键原本就是正确的；不能改用请求内的 `approvalId` |
| Bridge Core | `BridgeBackgroundTurns` 建立 `PendingApproval`，`ApprovalManager` 绑定 route 和发起人 | 不知道“向已有终端输入”与“启动命令”不同 |
| 渠道投递 | `BridgeDelivery` 优先调支持审批卡的渠道；没有卡时调用 `ApprovalManager.formatForChannel()` 发文本 | 旧共享文案和飞书卡都固定列出 `/OK /P /NO` |
| 用户回传 | `/OK`、`/P`、`/NO` 分别进入 `approve`、`approve-session`、`deny`，再由 adapter 映射为 `accept`、`acceptForSession`、`decline` | stdin 的拒绝实际需要 `cancel`，不是“拒绝但让 turn 继续”的 `decline` |
| server 侧已解决 | `serverRequest/resolved` 按 request id 清理 pending 并恢复运行状态 | 只应清理本次 approval；不能据此把关联的 command item 直接标记结束 |

本项保留上述 route、发起人和 request-id 安全边界，只修正“本次审批是什么、可选什么、如何回传”的语义。

| 项目 | 本轮落地后的 Chat-Codex 行为 | 新版语义 | 本轮结论 |
| --- | --- | --- | --- |
| 普通命令审批 | 创建 `kind: "command"` 的本地审批，支持 `/OK /P /NO` | `kind: "command"` | 保持现有行为 |
| 已有终端的 stdin 审批 | 创建 `kind: "terminal_input"` 的本地审批 | `kind: "writeStdin"`；有独立 `approvalId`，可能属于与原命令不同的 turn | 已适配；不能从 `approvalId` 猜类型 |
| 父命令状态 | 本轮不在审批 resolver 中改 item 生命周期 | 批准/拒绝 stdin 不会启动、结束或改变父 command item 状态 | 以后续真实 item/turn 通知为准 |

普通 command 的 `/OK`、`/NO`、`/P` 不会被取消。协议适配只改变“审批是什么”的准确说明，以及
服务器实际允许哪些决定时的展示；`writeStdin` 的决定集有单独的、更严格边界，见下文。

#### `availableDecisions`：相关补强，但不是本次 schema 新增项

Chat-Codex 初始化时已经设置 `experimentalApi: true`。官方源码在此模式下可能在审批请求里给出
`availableDecisions`，其中既可能有简单决定，也可能有结构化的 exec/network policy amendment。
本轮前，Chat-Codex 固定把本地可选决定写为 `approve`、`approve-session`、`deny`、`cancel`；本轮已把
简单值 `accept`、`acceptForSession`、`decline`、`cancel` 映射回本地 decision，并让 `writeStdin` 的
缺字段兼容回退收敛为 `approve`、`cancel`。

这不是 old → new 生成 schema 的新增字段（旧参考源码已有 experimental 定义），但在新版审批适配中
必须一并说明：

1. 对普通 command，只有 server 的实际决定集中有 `acceptForSession` 时才显示 `/P`；
2. 对旧 server 的普通 command（未给 `availableDecisions`），保持旧版 `/OK /P /NO` fallback；
3. 结构化 policy amendment 不是当前聊天审批命令，不自动暴露或自动选择；
4. 显式 `writeStdin` 是例外：即使字段缺失也安全回退为 `/OK /NO`，不开放 `/P`。

#### 当前 Codex 对 `writeStdin` 的决定集：**不支持本会话允许**

当前项目内 Codex 源码在生成 `writeStdin` 审批时，显式传入的决定只有：

```text
availableDecisions: [accept, cancel]
```

它没有 `acceptForSession`，也没有普通“拒绝但继续本轮”的 `decline`。因此当前新版 Codex 的
`writeStdin` 交互必须是：

| 聊天端操作 | 回传给 Codex | 实际含义 |
| --- | --- | --- |
| `/OK` / “本次允许” | `accept` | 允许这一次向已运行终端写入 |
| `/NO` / “拒绝并中止任务” | `cancel` | 不写入，并中止当前 turn |
| `/P` / “本会话允许” | 不提供 | 当前协议没有给出此权限，必须拒绝/提示不可用 |

不能因为 Chat-Codex 普通命令已有 `/P`，就擅自向 stdin 输入授予 session 范围的持续权限。实现必须优先
读取 server 实际给出的 `availableDecisions`，而不是只根据 `kind` 猜决定；若某个过渡版本显式给出
`writeStdin` 但缺少该字段，则安全回退为仅“本次允许 / 取消”，绝不开放 `/P`。

#### `writeStdin` 的实际聊天适配

它不是“执行一条新命令”，而是 Codex 想向**已经运行中的终端**输入内容，例如程序在等 `y/N`。

这里需要区分 schema 的可选性和当前 app-server 的实际行为：schema 为兼容网络审批和旧 server，把
`command` 标为可选；但当前 app-server 对所有非网络的执行审批（包括 `writeStdin`）都会把可展示的
完整操作放进 `command`。其自身 TUI 的 stdin 审批测试使用的值正是：

```text
write_stdin --session-id 42 'confirm\\n'
```

也就是说，正常的新版 stdin 审批中，用户应当能看见将向终端写入的内容。官方 TUI 不直接把这条 protocol
字符串作为“命令”展示：它将第 3 个参数作为 terminal id、最后一个参数作为 `Input`。Chat-Codex 现在也会
在 `approvalFromServerRequest()` 中保留 `environmentId`，并从官方这条四参数 canonical 表示恢复
`terminalId` 和 `terminalInput`；不能把一个没有可展示操作的 stdin 请求做成可盲批的 `/OK`。

#### 本轮已完成的中间件改动

1. `approvalFromServerRequest()` 读取 `params.kind`；旧 server 缺字段仍按 `command` 处理。
2. `writeStdin` 映射为明确的本地类型 `terminal_input`，不再伪装成普通 `command`。
3. 待处理审批继续以 JSON-RPC **request id** 为回传键；`approvalId` 仅保留在原始参数中作关联，不能被当成
   回传键或类型判断依据。
4. `terminal_input` 的可用 decision 是 server 给出的 `accept/cancel`；过渡 server 缺该字段时也仅回退为
   `approve/cancel`。`/OK` 回传 `accept`；聊天用户发送 `/NO` 时中间件转换为 `cancel`；`/P` 会返回
   “不支持本会话通过”且 pending approval 保持未处理。
5. 普通命令审批会展示执行环境、原因、**将执行的完整命令**和工作目录；`terminal_input` 会展示执行环境、
   原因、**目标终端**、**输入**和工作目录。终端输入采用带引号的可见表示，例如 `"confirm\\n"`，不把 stdin
   伪装成一条新命令。
6. 字符串无法按四参数格式恢复时，仍显示完整、已转义的原始终端输入请求；若 `writeStdin` 连可安全展示的
   `command` 都缺少，adapter 才立即以 `cancel` 关闭请求并发出可见进度提示，不创建可盲批的 pending approval。
7. approval resolver 不改变关联 command item 的 running/completed 状态；仍只等待 app-server 后续真实
   `item/*` 和 `turn/*` 生命周期通知。

也就是说，用户不用学习新命令，但必须看得见操作。例如：

```text
Codex 请求终端输入审批
执行环境：remote
目标终端：42
输入："confirm\\n"
原因：将确认一个破坏性操作

/OK 本次允许   /NO 拒绝并中止当前任务
```

它和普通审批的区别在于聊天提示必须明确：你同意的是“向旧终端输入”，不是“再执行一个新命令”。

#### 中间件与渠道的适配边界

协议适配必须分两层完成，不能只改其中一层：

```text
Codex app-server server request
          ↓
Chat-Codex adapter / Bridge Core
  识别 kind、校验可用决定、保存 pending approval、用 requestId 回传
          ↓
各渠道 renderer
  让用户看见“终端输入”的目标终端和精确输入，并提供当前允许的操作
```

| 层 / 渠道 | 本轮实际状态 |
| --- | --- |
| 中间件核心 | **已完成**：增加 `terminal_input`，保留 `environmentId`，恢复 terminal id/input，保存可用 decision，`/OK` → `accept`、`/NO` → `cancel`、拒绝 `/P`，且不把原 command item 标为已结束 |
| 微信 | **已可用**：没有审批卡 API，自动使用共享文字提示，显示终端、输入和 `/OK`、`/NO`，不出现 `/P` |
| 飞书私聊 | **已完成**：`terminal_input` 显示目标终端、输入以及“本次允许 / 取消并中止任务”两个按钮；普通审批仍为旧三按钮；卡片失败时回退文字提示 |
| 飞书群聊 | **已可用**：审批卡本来不支持群聊，继续走共享文字兜底，沿用现有 route/发起人权限校验 |
| 未来渠道 | 无卡片能力时可复用共享文字审批；新增卡片能力时必须根据 server 的决定集动态渲染，不能假设 `/P` 恒可用 |

渠道不直接调用 Codex 或终端。无论用户是在微信文字回复还是飞书点击卡片，均由中间件先校验
route、发起人、pending approval 和允许的 decision，再用原 JSON-RPC request id 回复 app-server。

### 7.2 用户输入：`item/tool/requestUserInput`

新版增加必填 `isBlocking: boolean`，旧 `autoResolutionMs` 被标为 deprecated。

| 当前行为 | 协议风险 | 最小适配 |
| --- | --- | --- |
| 所有请求都进入 pending-input，route 状态变为等待输入，并走 `/a数字` 和 30 分钟超时 | 无法区分“必须等用户回答”的请求与“不应长期阻塞聊天”的请求 | 将 `isBlocking` 放入本地 `CodexUserInputRequest`；旧 server 缺字段时保持现有阻塞 fallback |

对于 `isBlocking: true`，保留现有 `/a数字` 流程。对于 `false`，协议层必须保留该信息；是否做专门的
聊天交互、是否立即解除 route 锁，属于后续交互决定，不能在协议改动时擅自代答或静默丢弃。

### 7.3 其他 ServerRequest

| 项目 | 新版变化 | 现有能力 | 结论 |
| --- | --- | --- | --- |
| `item/permissions/requestApproval` | `cwd` 的 schema 路径类型变化 | 当前按普通字符串读取 cwd | JSON wire 仍为字符串；无需行为改动 |
| `mcpServer/elicitation/request` | 新增 `mode: "openaiForm"`，保留 `openai/form` | 当前统一安全取消 | 不适配新表单；现有取消逻辑继续有效，测试补该 mode 即可 |
| 动态工具 `item/tool/call` | 无本次方法名变化 | 当前明确拒绝 | 不变，不假装支持动态工具 |
| 账号 token refresh | 无本次方法名变化 | 当前明确拒绝 | 不变；不引入登录/token 管理 |

## 8. Thread item 和错误对象的字段变化

### 8.1 `agentMessage.delivery` / `questions`

新版 `ThreadItem.agentMessage` 增加：

```text
delivery: "async" | null
questions: Array<{ title, options }> | null
```

源码定义 `delivery === "async"` 为：Codex 在**当前 turn 尚未结束**时，主动向用户发送的一条可见消息。
它可附带 `questions`（标题和可选项）；用户的答复是普通用户消息，并不是另一种 RPC 回调。

例如聊天端可以看到：

```text
Codex 仍在执行，想确认：
要部署到哪个环境？
1. Staging
2. Production

直接回复选项或补充说明即可。
```

当前 `turn-controller.ts` 对任何非 commentary `agentMessage` 都会写入 `turn.finalText` 并发出
`assistant.completed`。这对普通最终答复正确，但对上述 async 消息会错误地告诉 Chat-Codex“任务已结束”。

协议层最小要求是：

1. adapter 解析并区分 `delivery === "async"`，发出独立的“执行中 Agent 消息”事件；
2. 不把它写成 `finalText`，不发 `assistant.completed`，不结束 turn；
3. bridge 收到该事件后立即投递文本和可读的 `questions`，但 session 保持 `running`；
4. `questions` 不能误接到现有 blocking `/a数字` server-request 机制；
5. 用户直接发送普通消息时，Chat-Codex 现有 `routeSteering.tryEnqueue()` 会优先通过 `turn/steer`
   送给正在运行且可 steer 的 turn；这正是 async 问题所需的回复路径。只有 turn 已不能 steer 时，
   才按当前规则回退为排队的新 prompt。

因此不需要新增 `/a数字`、专用答题命令或第二套 pending-input 状态。最小适配只是把已有的
“执行中普通消息 → steer”通道和新版 async item 正确接起来；最终答复仍只在普通 `assistant.completed`
或 `turn/completed` 时投递。

### 8.2 `TurnError.misalignment`

新版 TurnError 可带：错误分类、面向用户的详细说明，以及建议作为下一轮输入的 steer 文本。当前代码只取
通用 `message`。

| 处理选择 | 结论 |
| --- | --- |
| 自动发送建议 steer | 禁止；不能替用户继续任务 |
| 保留/显示详细说明 | 可选增强；需要先确认渠道文案和确认动作 |
| 只显示现有 `message` | 仍能工作，不阻断协议升级 |

### 8.3 `imageGeneration.failure`

Chat-Codex 已经识别 `imageGeneration` item，并在 `result`、`savedPath` 或 `path` 存在时发送
“媒体生成完成”。新版 `ImageGenerationItem` 新增：

```text
failure: { type: "usageLimitExceeded", limitId, resetsAt } | null
transparentBackground?: boolean
```

而 `result` 仍是 item 的必填字符串。因此不能以“有 result”推断生成成功；否则有 `failure` 的 item
也会被现有 mapper 误报为“完成”。最小适配是优先检查 `failure`：有失败时发送失败/额度受限语义的
进度信息（或仅记录失败），不发送完成提示。`transparentBackground` 只是生成参数，当前不展示图片
生成设置，不需要传到聊天端。

### 8.4 其它 item 字段

新增 `functionCallOutput` item、MCP item 的 `readOnlyHint` 等字段没有对应的 Chat-Codex 动态工具/MCP
产品能力。当前应安全忽略，不将原始内容直接投递到聊天渠道。

## 9. 新增 ServerNotification：11 项逐项清单

| 通知 | 与现有 Chat-Codex 的关系 | 本轮分类 | 处理边界 |
| --- | --- | --- | --- |
| `autoApprovalReview/strictReviewRequired` | 接近现有审批，但它不是可回复的审批请求 | 必须分类，`ignored_safe` / 本地诊断 | 不生成审批卡，不接受 `/OK /P /NO` 作为它的响应 |
| `mcpServer/event/stream/notification` | 当前无 MCP event 流产品能力 | `not_exposed` | 不把任意 MCP 内容原样发送到聊天 |
| `modelProvider/authRecoveryStarted` | 当前不管理登录 | `ignored_safe` | 不新增登录、token 刷新或聊天提示功能 |
| `modelProvider/authRecoveryCompleted` | 当前不管理登录 | `ignored_safe` | 同上 |
| `project/changed` | 当前没有 Codex project 对应物 | `ignored_safe` | 不映射为 route 或 session 分组 |
| `thread/project/updated` | 当前没有 Codex project 对应物 | `ignored_safe` | 同上 |
| `thread/queue/changed` | 项目已有 `route-queue`，但不是 Codex native thread queue | `ignored_safe` | 不用它驱动本地消息队列 |
| `thread/realtime/item/started` | 当前没有 realtime 音频/转写桥接 | `not_exposed` | 不误发为普通文本 |
| `thread/realtime/item/transcript/delta` | 当前没有 realtime 音频/转写桥接 | `not_exposed` | 不误发为普通文本 |
| `thread/realtime/item/completed` | 当前没有 realtime 音频/转写桥接 | `not_exposed` | 不误发为普通文本 |
| `thread/reverted` | 当前保存 session/status/history 相关本地状态 | 必须适配 | 标记该 session 历史已变，清理/失效相关缓存；不解绑 route，不声称文件已经回滚 |

`thread/reverted` 的最小预期不是新增聊天命令，而是防止后续 `/status`、刷新或最后回复同步仍把被删除的
历史视为最新。它没有 turnId，因此处理时不能假设能安全结束某个正在运行的本地 turn；需补消息顺序测试。

## 10. 协议分类门禁状态

本轮在 `protocol-capabilities.ts` 中登记了全部 9 个新增 ClientRequest 和 11 个新增 notification，
使 schema inventory 能持续检查后续 Codex 源码变化。分类**不等于功能已实现**：`candidate` 明确表示
已经识别、但仍等待相应协议项实际开发；`not_exposed` 和 `ignored_safe` 也不向聊天用户开放新能力。

### 10.1 新 ClientRequest 的目标分类

| 方法 | 当前分类 | 后续实际实现后的状态 |
| --- | --- | --- |
| `thread/turns/list` | `handled` | 已用于已有刷新路径 |
| `thread/items/list` | `handled` | 已用于已有刷新路径 |
| `thread/revert` | `not_exposed` | 保持 `not_exposed` |
| `thread/section/move` | `not_exposed` | 保持 `not_exposed` |
| `threadSection/list/create/update/delete` | `not_exposed` | 保持 `not_exposed` |
| `plugin/reconcile` | `not_exposed` | 保持 `not_exposed` |

### 10.2 新 ServerNotification 的目标分类

| 方法 | 当前分类 / 后续目标 |
| --- | --- |
| `thread/reverted` | `candidate`，实现缓存失效后为 `handled` |
| `autoApprovalReview/strictReviewRequired` | `ignored_safe` |
| `modelProvider/authRecoveryStarted` / `Completed` | `ignored_safe` |
| `project/changed` / `thread/project/updated` / `thread/queue/changed` | `ignored_safe` |
| `mcpServer/event/stream/notification` | `not_exposed` |
| 三个 `thread/realtime/item/*` 通知 | `not_exposed` |

## 11. 实施顺序与测试（仅协议）

### A. 先做已有行为的兼容

1. 审批：**本轮中间件已完成**。解析 `kind` 和 server 实际决定集；旧 server 缺 `kind` 时默认普通 command
   并保留 `/OK /P /NO`；当前 `writeStdin` 固定为 `/OK` → `accept`、`/NO` → `cancel`，不提供 `/P`。
2. 输入：解析 `isBlocking`；旧 server 缺字段时保持当前行为。
3. async Agent 消息：独立投递但不结束 turn；普通用户回复复用 `turn/steer`。
4. 刷新：已使用有界分页读取最新历史；分页不支持时跳过最后回复补投，不回退全量读取。
5. 会话回退通知：失效本地历史/状态缓存，不触发 route 解绑。
6. 媒体生成：优先处理 `imageGeneration.failure`，避免失败误报完成。

### B. 方法清单门禁

**本轮已完成**：为全部 9 个新增 ClientRequest 和 11 个新增 notification 写明确分类，重新运行：

```bash
node --test --test-name-pattern='protocol inventory' dist/tests/unit/app-server-mappers.test.js
```

注意：不能只把所有新增方法标成 `ignored_safe` 来让测试通过；client request 的
`thread/turns/list`、`thread/items/list` 和 notification 的 `thread/reverted` 必须与上述实际代码改动
一同落地。

### C. 单独评审后才做

- `isBlocking: false` 的具体聊天交互；
- `TurnError.misalignment` 的详细提示与用户确认继续；
- 模型列表/模型字段的专题适配。

### D. 最小测试矩阵

| 测试 | 本轮状态 / 必须证明 |
| --- | --- |
| 新版 schema inventory | 20 个新增方法/通知均有明确分类 |
| 旧 server 审批 | **已覆盖**：缺 `kind` 时仍按普通 command，`/OK /P /NO` 不变 |
| `writeStdin` 决定集 | **已覆盖**：当前源码只能 `accept` / `cancel`；不展示/接受 `/P`，`/NO` 明确为“拒绝并中止任务” |
| 各渠道审批展示 | **已覆盖**：微信文字提示、飞书群聊文字兜底、飞书私聊终端输入两按钮卡片；普通飞书审批仍保持三按钮 |
| `writeStdin` 生命周期 | **本轮实现边界已固定**：approval resolver 不直接改 parent item；后续真实 item/turn 事件才是生命周期依据，后续可补真实 CLI 场景测试 |
| `isBlocking` | `true` 保留 `/a数字`；`false` 不被误写成已支持的阻塞流程 |
| 刷新分页 | 新 server 使用分页；旧 server 正确 fallback；只取需要的最新回复 |
| `thread/reverted` | 本地状态失效，不解绑 route、不宣称文件回滚 |
| async agent message | 执行中消息即时投递、不结束 turn；用户普通回复走 `turn/steer`；最终答复只投递一次 |
| image generation failure | 有 `failure` 时不发“媒体生成完成”；无 `failure` 时保持现有提示 |

本轮完整测试结果见测试报告；详细环境、覆盖用例和待真实渠道补测项见上方链接。

## 12. 下一轮讨论顺序

协议部分建议按下面顺序逐项确认，不混入模型或新产品能力：

1. 使用真实微信、飞书私聊完成本项的渠道验收；限制、账号、会话形态和结果追加到测试报告。
2. 协议项 2：`isBlocking` 输入的聊天行为。
3. 协议项 3：已有 `/context-refresh reload` 的分页迁移。
4. 协议项 4：async Agent 消息的投递格式和普通回复 steer 边界。
5. 协议项 5：`thread/reverted` 的缓存失效与提示方式。
6. 协议项 6：媒体生成失败的聊天提示。
7. 协议确认完成后，再独立审计新版模型列表和模型字段。
