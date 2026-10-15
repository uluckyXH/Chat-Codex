# Codex 最新版兼容性审计与适配立项

> 2026-10-15 更新：新的[能力审计](2026-10-15-codex-cli-compatibility-audit.zh-CN.md)与[实施计划](2026-10-15-codex-cli-adaptation-plan.zh-CN.md)已核对实装稳定 CLI 0.162.1、最新 main 和实验 schema，并复核本文已完成／未完成项。后续优先级以新计划为准，本文保留历史立项与阶段记录。

状态：第一轮源码审计已完成；协议项 1（`writeStdin` 审批）的中间件适配、schema 分类门禁和
mock 自动化测试已完成。其余业务适配仍按本计划逐项讨论，未改变默认模型、权限或渠道运行策略。

更新：2026-09-05

> 2026-09-30 实施更新：分页历史读取、`thread/resume({ excludeTurns: true })`、app-server 损坏 JSON 的
> fatal recovery 和失败 turn 的精确审批/input 清理已经完成。本文后续关于“legacy full-history fallback”的计划性描述
> 已被 `2026-09-30-codex-app-server-json-rpc-large-payload-analysis.zh-CN.md` 取代；实际实现不回退无上限
> `thread/read(includeTurns: true)`，以避免重新触发超大 JSON-RPC 帧风险。

## 1. 背景

Chat-Codex 是把本机 Codex 接入微信和飞书的聊天中间件。Codex CLI、app-server 协议、
模型目录和产品能力会持续演进；只维持一个能启动的旧版协议适配，不能保证用户实际升级
Codex CLI 后仍能稳定使用新模型、会话、审批、工具和通知能力。

本轮工作的目的，是以最新官方 Codex 源码和官方文档为证据，重新审计 Chat-Codex 的
兼容性，并形成可以实施、测试和回溯的适配方案。重点是让 Chat-Codex 正确兼容 Codex，
不是把 Codex Desktop/Web 的所有功能无差别搬到微信或飞书。

## 2. 本轮用户确认的目标

1. 仔细盘点现有 Chat-Codex 已经具备的功能、协议边界和实际限制。
2. 以最新官方 Codex 源码为主，核查 Codex CLI、app-server、模型、会话、turn、审批、
   server request、notification、动态工具和相关运行时能力的变化。
3. 特别核查 Codex 新发布模型在 Chat-Codex 中的发现、展示、选择、reasoning effort、
   service tier、输入模态、参数透传和旧版降级行为。
4. 明确哪些官方变化需要适配，哪些已经兼容，哪些不适合聊天桥接或应暂缓开放。
5. 先产出中文审计/设计文档；经逐项评审后，按项目开发规范分批修改业务代码并补测试。

## 3. 审计基线与证据优先级

### 3.1 本地代码基线

- Chat-Codex：`main` 分支，审计启动时 HEAD 为 `dafa189`，包版本为 `0.1.5`。
- 官方 Codex 本地参考：`references/openai-codex`，官方远端
  `https://github.com/openai/codex.git`，已同步到 `main` 的
  `ddf04ad26789d040f9ef6a96736f76602e35a6cc`。
- 本次差异比较的旧参考点：`61a44880a85d2fd0d8770908dea5733495e571c8`。

`references/openai-codex/` 是本地、Git 忽略的参考源码，不应提交到 Chat-Codex 仓库。

### 3.2 证据优先级

每个后续结论必须标记来源和适用版本，优先级如下：

1. 最新官方 Codex 源码中的 app-server protocol schema、实现和测试。
2. 实际安装的 Codex CLI / app-server 在受控测试中的运行行为与 capability 返回。
3. 官方 OpenAI 文档与 changelog，例如：
   - <https://developers.openai.com/api/docs/models>
   - <https://developers.openai.com/api/docs/guides/latest-model>
   - <https://developers.openai.com/api/docs/models/gpt-5.3-codex>
4. 当前 Chat-Codex 的源码、测试和运行时记录。
5. 历史设计文档，仅作为待复核的上下文，不能替代当前证据。

其中，旧的
`codex-new-version-adaptation-design.zh-CN.md` 与
`codex-2026-07-latest-adaptation-design.zh-CN.md` 是重要历史材料；本轮会逐项复核，
不会直接沿用其中关于模型、协议或优先级的结论。

## 4. 审计范围

### 4.1 当前 Chat-Codex 能力盘点

先建立从用户可见能力到代码模块的完整清单，包括但不限于：

- 微信、飞书、终端和 mock channel 的消息、媒体、route 与 session 绑定。
- Codex adapter 的 CLI/app-server 生命周期、session/thread、turn、steer、interrupt、
  compact、Goal、模型、权限、审批、`request_user_input`、进度和旁白。
- TUI、聊天命令、状态持久化、重连、投递策略、错误诊断和安全保护。

每项能力都要写明当前入口、关键代码、已有测试、依赖的 Codex 协议和已知限制。

### 4.2 Codex 官方变化审计

以新版源码与当前基线逐项比对：

- app-server 的初始化能力、ClientRequest、ServerRequest、ServerNotification、schema
  类型和兼容策略。
- thread/session、turn、队列、历史、压缩、background/goal、协作与多 agent 相关能力。
- 模型目录、别名、弃用/升级信息、reasoning effort、service tier、输入输出模态与运行时
  capability。
- 审批、沙箱、权限、安全缓冲、账号/额度、错误和连接恢复。
- 动态工具、MCP、plugin、skill、媒体、computer/browser 等新能力的可用性与桥接边界。

### 4.3 模型适配专项

模型适配不以硬编码某个“最新模型名”为目标，而应确保：

- 优先从 Codex 的运行时模型目录发现可用模型与能力；账号、套餐和 CLI 版本不同时可安全
  降级。
- `/model`、TUI、状态输出和 `turn/start` 对未知模型名或未来新增 effort 不会因固定枚举而
  失效。
- 用户选择模型、effort 或后续 tier 时，始终按当前模型和当前 Codex capability 校验，
  不覆盖 Codex 自身默认策略。
- 模型不可用、被替代、需要升级或权限不足时，能给出可理解提示，不串改其它 route/session
  的模型策略。
- 模型所支持的文本、图片、工具或其他模态，只有在渠道输入、Codex adapter、权限和投递
  语义都完整闭环时才对用户开放。

## 5. 适配取舍原则

1. **协议稳定优先。** 新字段、通知和请求不能让正在运行的 turn 崩溃；未知 server request
   必须 fail-closed 且给出可追踪诊断。
2. **不突破安全边界。** 聊天渠道不能绕过现有 route/session owner、配对信任、审批、
   权限、actor 校验和文件发送约束。
3. **不复制富客户端。** 仅因为 Codex Desktop/Web 有某功能，不代表微信或飞书应直接公开；
   需要依据聊天交互、持久化、主动投递和安全性单独评估。
4. **运行时发现优先于硬编码。** 模型、effort、tier 与 capability 以实际 app-server 返回为
   准；静态列表只能作为展示或回退，不能成为未来模型的全局阻断器。
5. **保持旧版兼容。** 新能力必须 capability 检测、可选字段解析和明确降级，不能要求用户
   同时升级所有 Codex CLI、渠道和历史 session。
6. **渠道抽象不倒灌。** Codex 适配不能在 Bridge Core 中引入长期
   `if channel === "weixin"` / `"feishu"` 分支；渠道差异继续由 capability、delivery policy
   或 adapter-own 机制承载。

## 6. 后续文档交付物

本立项完成后，补充或更新一份正式的“最新版 Codex 兼容性审计与实施设计”，至少包括：

| 章节 | 必须回答的问题 |
| --- | --- |
| 当前能力矩阵 | Chat-Codex 已经支持什么，证据在哪，覆盖到哪个用户入口？ |
| 官方变更矩阵 | 新版源码/文档相对当前适配带来哪些实际变化？ |
| 模型适配矩阵 | 可发现模型、模型元数据、effort、tier、模态、弃用和降级如何处理？ |
| 协议适配矩阵 | 每个新增/变化的 RPC、通知和 server request 是已处理、需处理、忽略安全，还是不开放？ |
| 产品取舍 | 哪些能力适合微信/飞书，哪些只记录、不开放或需单独设计？ |
| 分期实施计划 | 依赖、代码边界、迁移风险、回滚方式与验收条件是什么？ |
| 测试计划 | 单元、集成、真实 Codex CLI、微信/飞书和兼容旧版本的验证场景是什么？ |

## 7. 建议审计顺序

1. 固定并记录 Chat-Codex、官方参考源码、实际 Codex CLI 和官方文档的版本基线。
2. 从现有 Chat-Codex adapter、桥接层、命令/TUI 和测试反向建立当前能力矩阵。
3. 从官方 app-server schema、实现和测试生成协议差异清单。
4. 独立审计模型目录和模型策略，确认新模型与现有模型选择路径的兼容性。
5. 将差异按“必须修复、推荐适配、观察/实验、明确不开放”分类，并说明理由。
6. 为每一项必须/推荐适配提出最小代码边界、测试和迁移方案。
7. 完成方案评审后，才按项目开发规范分批实施，并为每个实现阶段写入
   `reports/tests/` 中文测试报告。

## 8. 当前状态与非目标

当前已完成第一轮源代码比对，并已完成首个确认的协议实现项：

- `item/commandExecution/requestApproval { kind: "writeStdin" }` 已在中间件中区分为终端输入审批，
  按 server 决定集处理 `/OK`、`/NO`、`/P`，并完成 mock / fake app-server 测试。
- 最新 schema 新增的 9 个 ClientRequest 和 11 个 ServerNotification 已完成门禁分类；分类不代表
  后续用户可见功能已经实现。
- 除上述两项外，本文的“需适配”仍是经过源码比对后的实施建议，不代表任何一项已经开发完成。
- 尚未修改默认模型、默认 effort、service tier、权限策略或用户可见命令。
- 尚未承诺将 Scheduled tasks、plugins、skills、MCP、computer use、browser 或 multi-agent
  直接暴露给微信/飞书；每项都需经过上述审计与单独的安全/交互判断。
- 不把 API 模型目录与当前账户可从 Codex CLI 使用的模型目录视为同一事实；最终以运行时
  `model/list` 和真实 CLI 验证为准。

## 9. 实施阶段质量门槛

后续进入代码实现时，必须遵循
`docs/development-and-test.zh-CN.md`、`docs/agent-guide.zh-CN.md` 和
`docs/git-management.zh-CN.md`：保持模块分层，补足单元/集成/真实通道测试，在
`reports/tests/` 留中文测试报告，并在提交前执行：

```bash
git status --short --ignored
npm test
```

## 10. 第一轮源码审计结论

### 10.1 审计方法

本轮以 `references/openai-codex` 的新旧提交进行 schema 和实现比对，再从
Chat-Codex 当前 adapter、Bridge、命令和单元测试反查实际接入点。官方公开模型文档仅用来
核对模型公开说明；是否能在某个用户的 Chat-Codex 中选择，仍以该用户实际 Codex
app-server 返回的 `model/list` 为准。

新版参考源码相对于旧参考点新增了：

| 协议面 | 旧参考点 | 新参考点 | 结论 |
| --- | ---: | ---: | --- |
| app-server ClientRequest 方法数 | 93 | 102 | 新增 9 个，须显式分类 |
| app-server ServerRequest 方法数 | 10 | 10 | 方法名未新增，但审批和用户输入参数语义变化 |
| app-server ServerNotification 方法数 | 72 | 83 | 新增 11 个，须显式分类 |

项目现有的协议清单测试已经正确发现这些未分类变更：
`tests/unit/app-server-mappers.test.ts` 中的 protocol inventory 用例会因为上述 9 个
ClientRequest 和 11 个 notification 未登记而失败。这是本次拉取官方参考源码后暴露的
兼容性门禁，不是业务代码已经回归，也不应通过简单地把全部标成“忽略”来消除。

### 10.2 一页结论

Chat-Codex 的模型发现路径总体是面向未来的：模型名和 reasoning effort 并未被全局固定
枚举卡死，`model/list` 返回的新模型可被解析、展示和选择。因此，**新版模型不是要在代码
中逐个硬编码名称才能使用**。本轮最需要补齐的是协议语义和聊天交互，而不是模型 ID 列表。

| 优先级 | 需要适配的事项 | 不做的风险 |
| --- | --- | --- |
| 必须适配 | 新增 RPC/通知的明确分类；命令与 `writeStdin` 审批区分；按服务器允许的审批决策展示；`isBlocking` 输入语义；严格审批审查、会话回退通知；thread 模型字段回退 | 协议升级后门禁持续失败，审批提示误导用户，或会话/模型状态不准确 |
| 保留已有刷新功能 | 分页 thread 历史读取 | 当前 `/context-refresh reload` 依赖整段历史读取；长历史会慢，并会继续依赖新版源码已标为旧兼容路径的调用 |
| 可选新体验 | 异步 agent 消息和问题的即时投递；`misalignment` 错误说明；模型专长、退役信息的展示 | 不影响当前普通对话；只有明确需要这些新版体验时才实施 |
| 本轮不适配 | 单 turn service tier、`turnTrigger` | 当前没有对应用户需求；已有持久 service tier 会正常透传，新增字段不影响普通对话 |
| 不开放 | sections/projects/plugins、动态工具输出、MCP 表单、realtime 音频、原生队列、多 agent | 这些能力没有完整的聊天交互、权限和持久化闭环；不应仅因协议出现就暴露 |

定时任务不属于这一轮 Codex 协议适配实现：项目内仍只有
`scheduled-task-channel-delivery-design.zh-CN.md` 的设计草案，尚未进入业务代码开发。

## 11. Chat-Codex 当前能力矩阵

下表记录的是当前代码已经具备的能力，不把“协议中存在”误写成“渠道中已经可用”。

| 能力 | 当前实现与入口 | 已有兼容性判断 | 本轮结论 |
| --- | --- | --- | --- |
| 模型发现与选择 | `src/codex/app-server/model-policy.ts`、`src/bridge/commands/model-command.ts` | 从 `model/list` 读取可用模型、effort、tier、模态和升级信息；effort 接受合法未来字符串 | 基础路径已兼容，应补 thread 返回值和可展示元数据 |
| 新建/恢复会话 | `src/codex/app-server-codex-adapter.ts` | 使用 `thread/start`、`thread/resume`，带模型、持久 tier、cwd、审批、sandbox 等策略；恢复使用 `excludeTurns: true` | 已迁移到 metadata-only resume；不支持该字段的 app-server 需要升级，避免 full-history 风险 |
| 对话和中断 | adapter 的 `turn/start`、steer、interrupt；`src/codex/app-server/turn-controller.ts` | 可投递输入、旁白、进度、最终回复并处理运行状态 | 需要正确处理 async agent message、misalignment 和新字段 |
| 会话刷新和最后回复 | `src/codex/app-server/thread-history.ts` | 通过有界 `thread/turns/list` / `thread/items/list` 取得最后最终回复 | 已迁移；分页 API 不可用时跳过补投，不读取完整历史 |
| 审批 | `src/codex/app-server/approval-handler.ts`、`src/approvals/types.ts` | 已支持命令、文件、权限等审批并回传决策 | 新版 `writeStdin` 必须与新命令审批区分；决策集合不能再硬编码 |
| `request_user_input` | `src/bridge/pending-input.ts`、`/a数字` 命令 | 已有题目、选项、发起者校验、30 分钟超时和 secret 拒绝 | 必须理解 `isBlocking`，不能把非阻塞问题误锁成阻塞输入 |
| 服务器通知 | adapter 内 notification handler 与 Bridge delivery | 已处理状态、标题、模型 reroute/verification、安全缓冲、warning 等 | 新增 11 类须分类，少数需显式提示或状态失效 |
| 本桥接队列 | `src/bridge/route-queue.ts` | 管理渠道入站消息和 route 内串行执行 | 不能直接拿 Codex 的 `thread/queue/changed` 驱动它，两者不是同一队列 |
| Goal / 协作模式 | `/goal` 与 `default` / `plan` 模式 | 有当前 Chat-Codex 的对话控制含义 | 不等同于 Codex 新版 multi-agent，不能自动映射 |

## 12. 协议差异与适配决定

本节的“处理方式”有四种含义：

- **处理**：本轮应实现用户可见或状态正确性所需的逻辑；
- **安全忽略**：显式记录为不影响当前桥接语义的消息，可仅作诊断；
- **不开放**：协议识别但不把能力暴露给微信/飞书；
- **候选**：保留为下一轮评审项，不改变默认行为。

### 12.1 新增 ClientRequest

| 新方法 | 官方源码语义 | Chat-Codex 决定 | 适配说明 |
| --- | --- | --- | --- |
| `thread/section/move` | 在项目内移动 thread section | 不开放 | 聊天 route/session 没有 section 的一等持久化模型 |
| `threadSection/list/create/update/delete` | 管理 thread section | 不开放 | 不把 Desktop/Web 的项目整理 UI 移植为聊天命令 |
| `thread/revert` | 将持久历史回退到指定 turn 之前；会中断活动 turn，但**不回退本地文件** | 暂不提供 `/revert`；处理对应通知 | 先确保收到外部回退后本地 session/history 不陈旧，避免承诺“代码也已回滚” |
| `thread/turns/list` | 分页获取 turn，可选摘要或完整 items | 处理（保留已有刷新） | 作为恢复和刷新历史的新主路径 |
| `thread/items/list` | 分页获取指定/全部 turn 的 items | 处理（保留已有刷新） | 用于精准取最后最终 assistant 消息，不再无限读取全部历史 |
| `plugin/reconcile` | plugin 生命周期协调 | 不开放 | 当前没有插件安装、信任、授权和渠道交互闭环 |

新版源码还将 `thread/read(includeTurns: true)` 定义为兼容路径，并明确建议分页客户端使用
`thread/turns/list` 和 `thread/items/list`。当前实现先以 `thread/resume({ excludeTurns: true })` 复原配置，
再按需读受限的最新分页；分页方法不支持时保留恢复、跳过最后回复补投。不会为旧 server 回退到
`thread/read(includeTurns: true)`，因为那会重新引入无上限大帧风险。

### 12.2 ServerRequest：方法名未变，但参数语义必须修正

| 变化 | 当前问题 | 本轮处理 |
| --- | --- | --- |
| `item/commandExecution/requestApproval` 新增 `kind: "command" \| "writeStdin"` | 当前本地审批一律当作 command，无法让用户知道自己批准的是新命令还是向已有终端输入 | 在本地审批类型中保留来源 kind；文案明确区分“执行命令”和“向正在运行的终端输入”；不靠 approval ID 猜类型 |
| 命令审批的 `availableDecisions` | 当前聊天端固定展示 approve / approve-session / deny / cancel | 以 server 实际允许的简单决策为准；未允许就不展示，复杂策略修改决策先不开放 |
| `item/tool/requestUserInput` 新增 `isBlocking`，旧 `autoResolutionMs` 已过时 | 当前一律进入 30 分钟 `/a数字` pending-input 锁 | 本地类型保留该字段；`true` 继续走现有显式回答流程；`false` 先设计为不把 route 长时间锁死，并经真实 CLI 验证后决定具体交互，绝不擅自替用户选择 |
| MCP elicitation 允许 `openaiForm` | 当前 MCP elicitation 安全取消 | 维持不开放；未来若支持，只通过初始化的 `extensions` capability 声明，不复活旧 flag |

`writeStdin` 的批准与父 command 的 item 生命周期是独立的。处理它时不得错误地把父命令标记为
已完成或已取消；这是一项安全性和状态一致性要求。

### 12.3 `turn/start`、初始化和 thread/item 字段

| 变化 | 决定 | 原因 |
| --- | --- | --- |
| `turnTrigger?: string` | 本轮不适配 | 它只是 app-server 的内部来源分类；正常聊天消息不传也能工作，当前没有对应用户功能 |
| `serviceTierForTurn?: string` | 本轮不适配 | 当前已将持久 `serviceTier` 传给 `thread/start`、`thread/resume` 和 `turn/start`；新字段只用于临时覆盖单次任务，暂无用户需求 |
| `toolOutput` | 不开放 | 当前没有动态工具 host；也不能把任意 tool output 伪造成普通用户消息 |
| 初始化 `capabilities.extensions` | 暂不声明新 extension | 只有真的支持对应 MCP/表单能力后才声明，避免虚报客户端能力 |
| `Thread.model`、`Thread.reasoningEffort` | 必须适配 | 恢复/列表状态应回退读取这些实际持久化配置，不能只看旧顶层字段 |
| `Thread.modelSpecialty`、`multiAgentVersion`、`upgradeInfo.retirementAt` | 可选展示；multi-agent 不开放 | 前两者可帮助解释模型状态；多 agent 还涉及子 thread、所有权和渠道路由，不能自动启用 |

`retirementAt` 在官方 app-server 实现中是 Unix 秒时间戳。展示层应把它转换为本机时区的可读日期，
并作为提醒而非自动换模型的触发器。

### 12.4 新增 `agentMessage` 和 TurnError 语义

官方源码将部分“执行仍在继续时向用户发消息/提问”的内容放在
`agentMessage.delivery: "async"` 和 `questions` 中。当前 `turn-controller.ts` 会把普通
`agentMessage` 当作最终回答缓存，并由 `route-queue.ts` 在 turn 结束后投递；这会使 async
消息被延迟、被最终回答覆盖，或错误地结束其交互语义。

若后续决定开放这一类新版交互，应增加独立的 `assistant.async_message`（名称以实现时接口为准）事件：

1. 立即按现有渠道 delivery policy 投递，不能等待 turn 结束；
2. 显示问题和选项，但不复用阻塞的 `/a数字` server-request 协议；
3. 不因该消息将 turn 标成 completed；用户后续普通消息仍按既有 route/steer 策略处理；
4. 为“async 消息先到、最终回复后到”的顺序单独写测试。

`TurnError.misalignment` 还会带公开说明和建议的后续 steer 文本。聊天端应优先展示详细说明，
但**不得自动提交**服务器建议的 `steer.message`；是否继续必须由用户确认。

### 12.5 新增 ServerNotification

| 通知 | 决定 | 处理边界 |
| --- | --- | --- |
| `autoApprovalReview/strictReviewRequired` | 必须分类 | 作为高风险/严格审查状态提示；该通知不含可批准请求，绝不凭空生成审批卡 |
| `modelProvider/authRecoveryStarted` / `Completed` | 安全忽略/本地诊断 | 仅为协议清单明确分类；Chat-Codex 不发起、不展示也不接管 Codex 登录、token 或账号恢复 |
| `thread/reverted` | 必须分类并使缓存失效 | 说明仅历史已回退，不声称文件改动已回滚 |
| `thread/queue/changed` | 安全忽略/诊断 | 官方 thread 队列与 Chat-Codex 的 `route-queue` 不同，不改变本桥接的排队策略 |
| `project/changed` / `thread/project/updated` | 安全忽略 | 当前没有 project 组织功能，不能映射为聊天 session 分组 |
| `mcpServer/event/stream/notification` | 不开放 | 内容由 MCP 任意提供，不能未经契约、脱敏和权限判断原样发到聊天渠道 |
| `thread/realtime/item/started` / `transcript/delta` / `completed` | 不开放 | 当前没有实时音频/转写输入输出协议，不可误投递为普通文本 |

## 13. 模型兼容性结论

### 13.1 已经具备的正确基础

当前实现中的 `CodexReasoningEffort` 是字符串类型，`model-policy.ts` 对运行时返回的 effort
做合法性校验而非只接受一组陈旧枚举；`/model` 再按当前模型实际支持的 effort 校验。模型、
service tier、输入模态和升级信息也都来自 `model/list`。这正是兼容未来官方模型应采用的路径。

因此本轮不应维护“把某个新模型名写进固定数组才可用”的实现。新模型是否出现、是否可选择、
有哪些 effort/tier，取决于本机 Codex CLI 已登录账户、套餐、CLI/app-server 版本和运行时
`model/list`；Chat-Codex 不管理该登录状态。

### 13.2 需要补齐的模型行为

1. 在 session/thread 解析中以 `Thread.model`、`Thread.reasoningEffort` 作为旧顶层字段缺失时的
   fallback，确保恢复旧/新会话都显示实际配置。
2. 为 `modelSpecialty`、`upgradeInfo.retirementAt` 建立类型安全的可选解析与用户可见展示；保留
   未知字段的兼容性，不因为未来扩展失败。
3. 把模型退役/升级提示视为提醒，不自动修改 route/session 的模型，也不跨会话套用选择。
4. 对 `multiAgentVersion` 只记录可观测状态。Chat-Codex 当前的 `default` / `plan` 与 Codex
   multi-agent 不是同一概念；官方源码还限制向 parent-owned child thread 直接输入，必须先有
   子会话路由、所有权、投递和审批设计才能开放。
5. 继续让模型输入模态受渠道能力限制：即使模型声明支持某模态，只有入站适配、Codex input、
   安全审批和结果投递都已实现时才开放。

## 14. 建议实施顺序与代码边界

### 阶段 A：必须适配的协议安全与状态正确性

目标是先让新版参考协议通过明确分类，并避免错误授权、错误会话状态或误导用户。

- 在 `src/codex/app-server/protocol-capabilities.ts` 为新增 request/notification 写出明确决定，
  并更新协议清单测试；“不开放”也必须可审计。
- 在 `src/codex/app-server/server-request-mapper.ts`、
  `src/codex/app-server/approval-handler.ts` 和 `src/approvals/types.ts` 传递审批 kind、
  `availableDecisions`、`isBlocking`，保持对旧 server 缺字段的兼容。
- 在 `src/codex/app-server-codex-adapter.ts` 和 notification handler 增加严格审查、
  `thread/reverted` 的路由/缓存失效逻辑；认证恢复通知仅做安全分类/本地诊断，不增加登录能力。
- 在 `src/codex/app-server/model-policy.ts`、thread/session mapper 补 model 与 effort 的 fallback。

### 阶段 B：保留已有的上下文刷新（已完成）

- `src/codex/app-server/thread-history.ts` 已改为有界分页读取；分页不支持时跳过补投，
  不回退完整历史。

### 可选后续：新版交互与展示体验

- 在 `src/codex/app-server/turn-controller.ts`、adapter 事件类型和
  `src/bridge/route-queue.ts` 增加独立 async agent message 投递路径。
- 将 misalignment 的公开详细说明接入错误展示，确保建议 steer 仅在用户操作后发送。
- 在 `src/bridge/formatters.ts`、`/model` 输出和 TUI 状态中补模型专长、升级/退役提醒。

### 明确不纳入本轮

不实现 sections、projects、plugins、动态 `toolOutput`、MCP form elicitation、realtime
transcript、native thread queue、multi-agent、`serviceTierForTurn` 或 `turnTrigger` 的聊天入口。
这些不是“少传一个字段”的工作，均需另立设计，明确权限、用户体验、持久化、路由和真实渠道测试。

## 15. 验收和回归测试计划

每个阶段实现时都应新增对应单元测试，并在 `reports/tests/` 留中文测试报告。最低验收集如下：

| 场景 | 必须证明的结果 |
| --- | --- |
| 新旧 protocol inventory | 最新参考源码的每项 request/notification 都有处理、忽略或不开放的明确分类；旧参考仍可通过 |
| `writeStdin` 审批 | 文案和本地类型正确区分终端输入；只展示 server 给出的允许决策；不会改变父 command 生命周期 |
| blocking / non-blocking 输入 | `isBlocking: true` 保持现有 `/a数字` 语义；`false` 不会无依据锁死 route 或自动替用户答题 |
| 严格审查、回退通知 | 通知只影响对应 thread/route；严格审查不凭空生成审批；回退后不会拿旧历史当最新状态 |
| 认证恢复通知 | 仅被明确分类/本地诊断；不会新增聊天登录、token 刷新或账号管理功能 |
| 分页历史 | 使用 `excludeTurns` 和有界分页读到最后最终回复；分页 API 不可用时不补投，绝不退回完整 `thread/read` |
| async agent message | turn 未结束时消息立即投递，后续最终回复不覆盖它，也不会提前完成 turn |
| misalignment | 用户能看到详细说明；系统不会自动发送建议 steer |
| 新模型元数据 | 模拟未知新模型/effort、thread model fallback、specialty 和退役时间；不需要修改固定模型 ID 列表 |
| 全量回归 | `npm test` 通过；按实际修改范围补 app-server/真实 CLI 和微信、飞书验证 |

当前 schema inventory 已通过；后续 Codex 升级若新增方法，必须先给出明确分类或实现，不能删除测试、
宽松匹配，或把未知高风险请求当作已支持的方式绕过。

## 16. 待逐项评审的产品决定

以下不是技术上可以自行默认决定的事项，进入实现前应逐项确认：

1. `isBlocking: false` 的渠道交互：是仅提示用户正常继续对话，还是设计专门的异步答题入口；
   两者会影响 route 锁和消息排序。
2. 模型升级/退役提醒的展示密度：仅 `/model` 和 TUI 状态显示，还是在受影响会话首次运行时提示。
3. multi-agent、MCP、plugins、Scheduled tasks 等能力是否另立需求；它们不能被作为本轮协议
   兼容的附带实现。

在上述决定达成前，本审计推荐先实施阶段 A，再以阶段 B 的历史与 async 消息正确性作为第二个
独立变更集，保持每次改动可测试、可回退、可评审。

## 17. 白话说明：这几类适配到底影响什么

本节不使用 app-server 或 schema 术语，供讨论优先级时直接阅读。

### 17.1 “必须适配”“保留已有刷新”“可选新体验”不是三个产品功能

它们只是开发优先级，不代表要向用户增加三个新命令：

| 标记 | 白话含义 | 对当前日常使用的影响 |
| --- | --- | --- |
| 必须适配 | 升级 Codex 后必须先保证正确和安全的部分 | 不做可能导致审批选项不准确、状态看错或重要风险提示漏掉 |
| 保留已有刷新 | 只替换当前刷新功能内部过时的历史读取方式 | 不做会让 `/context-refresh reload` 继续依赖旧接口，长会话性能和未来兼容性不稳 |
| 可选新体验 | 官方有、但当前聊天没有明确产品需求的新版交互或展示 | 不做不影响正常聊天、模型选择、审批或任务执行 |
| 本轮不适配 | 当前没有明确产品价值的新增字段 | 不做不会影响正常聊天、模型选择、审批或任务执行 |

所以建议的顺序不是“一次把所有新版能力都做完”，而是先完成必须适配项，再保住已有刷新功能；
异步消息等新体验另行决定。原先标为 P2 的两个字段已明确从本轮实施范围移出。

### 17.2 审批：`/OK`、`/NO`、`/P` 会保留

当前项目已经实现这三个聊天命令；这里不是新增或替换命令：

| 命令 | 现在和后续都保留的含义 |
| --- | --- |
| `/OK` | 只通过当前这一条审批，例如允许这一次执行命令或修改文件 |
| `/NO` | 拒绝当前这一条审批，让 Codex 根据拒绝结果继续、改方案或停止该操作 |
| `/P` | 请求“本会话通过”：如果 Codex 允许，当前会话后续同类操作尽量不再重复询问 |

“必须适配”**不是**删掉 `/P`，而是修正它的展示条件。当前 Chat-Codex 对所有审批都固定展示
`/OK`、`/P`、`/NO`；新版 Codex 会对每一条审批明确告诉客户端“这次允许哪些处理方式”。
有些审批只允许一次性同意或拒绝，此时再展示 `/P` 会误导用户，甚至把不被 server 接受的决定
发出去。适配后的表现应当是：

```text
Codex 允许一次性或本会话通过：显示 /OK、/P、/NO
Codex 只允许一次性通过或拒绝：显示 /OK、/NO
```

新版还把两件不同的事区分开：

1. **执行新命令**，例如让 Codex 运行 `npm test`；
2. **向已经在运行的终端输入内容**，例如某个命令正在询问 `Proceed? (y/n)`，Codex 想代为输入
   `y`。

两者都仍然可以用 `/OK` 允许、`/NO` 拒绝；必须适配项只是让审批消息清楚说明是哪一种，并确保第二种
审批不会错误结束或改变第一条命令的状态。

### 17.3 登录不是 Chat-Codex 的功能

Chat-Codex 只启动并连接本机已经可用的 Codex CLI / app-server；本机 Codex 自己使用已有登录状态。
项目没有聊天登录命令、不保存 ChatGPT token，也不替用户刷新 token。现有代码对
`account/chatgptAuthTokens/refresh` 明确拒绝，而不是代替 Codex 登录。

新版源码虽然新增了 `modelProvider/authRecoveryStarted` / `Completed` 通知，但这只是 Codex 自己
内部恢复模型提供方认证时可能发出的状态消息。对 Chat-Codex 的正确处理是**明确识别后安全忽略或
仅本地诊断**，不是做登录页面、聊天提示、token 刷新或账号管理。本轮不把它作为用户功能实施。

### 17.4 同一上下文与“保留已有刷新”的会话历史

每个聊天 route 当前都绑定一个 Codex thread；你在同一个微信/飞书聊天里连续发消息，本来就是同一份
Codex 上下文，不需要每次重新读取完整历史。

项目也已经有 `/context-refresh`：当同一个 session 被本机另一个 Codex CLI 进程改过时，若当前 route
设置为 `/context-refresh reload`，下一次发送前会重启自己的 app-server、恢复**同一个** thread，再继续
发送。内置默认值是 `off`，因此只有你或全局配置显式开启 `reload` 时才会做这种外部更新刷新。

这里的“会话历史”指 Chat-Codex 从 Codex 重新读取 thread 内容的内部过程，典型发生在：

- 使用 `/resume` 恢复一个旧 Codex 会话；
- 使用上下文刷新功能，发现电脑上的 Codex CLI 改过同一个会话；
- 需要找出该会话最新一条最终回复并同步给聊天端。

现在的做法是 metadata-only resume 后只读取受限的最新 turn/item 页。会话再长也不会由 Chat-Codex
主动一次请求全部历史；新版 Codex 源码同样推荐按页读取，例如只读最新一页，再取最后一条最终回答。

因此这项适配不是要改变你在微信/飞书里看见的聊天记录，也不是要清掉历史；它是为了保证长会话恢复、
刷新和同步时仍然快速、可靠。也就是说：**这项适配已经在保留当前刷新功能的前提下完成，替换的只是
内部过时的“整段历史读取”方式；不是另做一个上下文功能。**

### 17.5 可选新体验：“异步消息”是什么

新版 Codex 有一种情况：任务还在继续执行，但它想先给用户发一条提示或问题，例如“我需要你注意
这个选择”，随后仍会继续工作并在稍后给最终答复。

当前 Chat-Codex 的实现会倾向于把这种消息先当作“最终回复”缓存，等任务结束才发送。这样可能
造成用户该立即看到的提示延迟，或者被稍后的最终回复覆盖。

若决定做，它的目标只是把它变成“执行中即时提醒”：提示立即发出，但不结束任务、不自动替用户作答，也不
替代已经存在的 `/a数字` 阻塞式问答。它和 17.3 的分页历史是同一优先级，但属于两件独立的事。

### 17.6 两个原 P2 字段：本轮明确不适配

| 名称 | 现在是否已适配 | 实际功能与本轮决定 |
| --- | --- | --- |
| `serviceTierForTurn` | 未适配，且本轮不做 | 只让**这一次**任务临时覆盖速度/服务档位，不改之后的会话设置。当前已有的持久 `serviceTier` 已正常传给 Codex；没有“这一次加速”的用户入口或需求，因此不加 |
| `turnTrigger` | 未适配，且本轮不做 | 只是告诉 Codex 这次 turn 的内部来源分类。普通聊天消息不传也完全正常，没有对应的用户可见功能 |

换句话说，这两个字段不是漏掉了一个已有功能，而是官方增加了两个我们当前不需要的可选参数；不做
不会影响现有功能，也不影响新增模型被 `model/list` 发现和使用。

### 17.7 “不应该直接开放”不等于正在关闭已有能力

这些能力当前本来就没有作为微信/飞书可用功能开放；其中一部分代码会识别到请求后安全地取消或
拒绝，防止被误当成已经支持。它们不会影响当前普通聊天、图片输入、模型选择、审批或 `/goal`。

| 能力 | 当前状态 | 为什么本轮不直接做 |
| --- | --- | --- |
| sections / projects | 没有聊天命令或 route/session 映射 | 属于 Codex Desktop/Web 的会话整理方式，不等同于聊天分组 |
| plugins | 没有安装、信任和生命周期入口 | 需要插件来源、权限、升级和失败恢复设计 |
| MCP 表单、动态工具 | MCP elicitation 会安全取消；动态工具调用会拒绝 | 需要工具契约、凭证隔离、审批和聊天表单交互，不能原样转发 |
| realtime transcript | 没有实时音频/转写的渠道桥接 | 不能把实时语音片段误发成普通文本消息 |
| Codex 原生 thread queue | 没有聊天入口 | 它和项目自己的 `route-queue` 不是同一套队列，不能混用 |
| multi-agent | 当前未开放；`/plan`、`/goal` 不是 multi-agent | 子 agent、子会话、所有权、消息投递和审批都需要独立设计 |
| Scheduled tasks | 只有设计草案，未实现 | 需要调度持久化、任务 route/session 隔离和精准渠道投递闭环 |

本轮不会关闭现有 `/OK`、`/NO`、`/P`、模型选择、普通对话、`/plan`、`/goal`、微信/飞书渠道或
图片输入等已实现能力。所谓“不开放”，仅表示不把尚无完整安全和交互设计的官方新能力冒然加进来。
