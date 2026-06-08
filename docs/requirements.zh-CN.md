# Codex 微信通讯中间件需求文档

## 1. 项目目标

创建一个轻量中间件，让 Codex 能直接对接 `openclaw-weixin` 提供的微信通讯能力，使用户可以通过微信与 Codex 沟通。

这个项目不是 OpenClaw 集成项目，也不依赖 OpenClaw CLI、OpenClaw gateway、OpenClaw host runtime 或 OpenClaw channel runtime。`@tencent-weixin/openclaw-weixin` 只作为微信通讯插件源码、协议和能力参考；中间件需要直接复用、裁剪或适配其中的微信通讯能力。

目标形态：

```text
Codex <-> Codex Adapter <-> Middleware Core <-> Weixin Adapter <-> WeChat
```

中间件职责：

- 处理 Codex 会话、事件、审批和状态。
- 处理微信登录、收消息、发消息和通道状态。
- 处理 `/new`、`/status`、`/stop`、`/OK`、`/NO`、`/permission` 等微信命令。
- 记录结构化日志和持久化状态。
- 以终端命令形式启动和运行，保持轻量，不引入重框架。

重点要求：

- 中间件不能只为 `openclaw-weixin` 写死。必须抽象出一套通用渠道协议，后续其他人适配别的渠道时，只需要实现这套协议即可接入 Codex。
- 项目文档、测试报告和开发记录以中文为主。
- 每次实现功能都必须有自测，测试报告需要保存到独立目录。
- 先适配 Codex 与中间件通信，再适配中间件与 `openclaw-weixin` 的桥接。
- 第一版微信桥接完成后，中间件需要提供登录方式；用户会登录微信并协助进行真实通道测试。

## 2. 当前阶段范围

当前已进入完整闭环初版：Codex app-server、Bridge、通用渠道协议和 WeixinAdapter 已打通基础链路。mock channel 和 terminal channel 继续用于自动化测试，避免真实微信登录阻塞开发验证。

当前已完成或已建立的基础内容：

- 独立 Git 仓库和 Git 管理规范。
- Node.js + TypeScript 项目骨架。
- 通用 `ChannelAdapter` 协议。
- `MockChannelAdapter`。
- `TerminalChannelAdapter`，用于本地终端模拟微信消息。
- `Bridge Core`、命令处理、审批管理、内存状态存储、日志。
- `MockCodexAdapter`。
- `AppServerCodexAdapter` 初版，默认通过 `codex app-server --listen stdio://` 驱动真实 Codex，并把审批请求回调给微信。
- `ExecCodexAdapter` 已完成真实 Codex CLI 中间件调用验证，并保留为非交互回退模式。
- 真实 Codex 模式启动时必须检测 Codex 是否可用，并允许选择历史会话或创建新会话。
- 真实 Codex 模式启动时必须先选择新会话或历史会话，再选择权限模式：安全沙箱模式或完全权限；完全权限必须明确提示危险并要求确认。默认 app-server 接入下，安全沙箱模式必须支持把 Codex 审批请求推送到微信，并保持与本机 Codex CLI `workspace-write` 一致的网络访问能力。
- 真实 Codex 模式启动时，如果选择创建新会话，必须展示默认工作目录；用户可以输入新工作目录，目录不存在时由中间件创建。
- 真实 Codex 模式启动时，如果选择历史会话，不再询问新工作目录，必须尽量恢复该 Codex 会话历史记录中的原工作目录。
- 历史会话列表和微信 `/sessions all` 必须优先展示 Codex 已保存的标题或首条用户消息，方便用户辨认会话 ID；展示时应压缩换行并省略过长标题，避免终端和聊天窗口被长标题撑开。
- `WeixinAdapter` 第一版：已实现二维码登录 API 入口、登录确认轮询、账号 token 本地存储、文本 `sendmessage` 请求、微信入站消息到通用 `ChannelMessage` 的转换、媒体上传发送、typing 和限流重试。
- `WeixinAdapter` 真实扫码登录和真实微信收发仍需用户后续协助测试。
- 本地单元测试、集成测试和中文测试报告。

`openclaw-weixin` 微信通讯 npm 包作为本地参考源码使用，不提交到仓库。获取方式见 `references/README.md`：

- `openclaw-weixin-npm/tencent-weixin-openclaw-weixin-2.4.4.tgz`
- `openclaw-weixin-npm/extracted/openclaw-weixin-2.4.4/`

Codex 源码参考仓库只在需要核对 app-server、exec JSONL 或审批协议时按 `references/README.md` 拉取，不提交：

- `references/openai-codex/`

后续设计或实现遇到 Codex 行为不确定时，必须优先查看本地 Codex 源码和协议定义，再决定适配方式。

技术栈决策：

- 使用 Node.js + TypeScript。
- 不使用 NestJS、Next.js 等重型框架。
- 以 CLI/daemon 形式运行。
- 优先复用 `openclaw-weixin` 的 TS 代码和协议实现，避免用 Go/Python 重写微信通讯细节。

Git 管理要求：

- 当前项目目录本身是独立 Git 仓库。
- Git 忽略规则必须防止提交 `node_modules/`、`dist/`、运行态状态、日志、微信登录态、token、cookie、本地 Codex 参考仓库和解压参考目录。
- `src/state/` 是源码目录，必须被 Git 追踪；运行态状态默认写入 `~/.chat-codex/state/`，或写入 `CHAT_CODEX_STATE_DIR` 指定的运行态目录。
- 每个实现阶段提交前必须运行测试并更新 `reports/tests/` 中文测试报告。
- 详细规范见 `docs/git-management.zh-CN.md`。

## 3. 核心需求

### 3.0.0 通用渠道协议要求

本项目的中间层不应该固定绑定 `openclaw-weixin`。`openclaw-weixin` 是第一条真实渠道适配，但中间件核心必须面向通用渠道协议设计。

基本要求：

- 定义稳定的 `ChannelAdapter` 接口。
- 定义稳定的 `ChannelMessage`、`ChannelTarget`、`ChannelStatus`、`ChannelCapabilities` 等内部模型。
- Bridge Core 只能依赖通用渠道协议，不能直接依赖 `openclaw-weixin` 的原始类型。
- `WeixinAdapter` 只是通用渠道协议的一个实现。
- 后续 Telegram、企业微信、飞书、Slack、HTTP webhook 等渠道应能通过实现同一套 adapter contract 接入。
- `/new`、`/status`、`/stop`、`/OK`、`/NO`、`/permission` 等命令逻辑必须在 Bridge Core/Command Router 中实现，不写进某个具体渠道 adapter。
- 渠道 adapter 只负责登录、连接、收消息、发消息、能力声明和状态上报。
- 不同渠道的用户、群、线程等上下文必须归一化为统一 route key。

这是重点架构要求，后续实现不能绕过。

### 3.0 可演进适配要求

`openclaw-weixin` 插件后续会继续更新，项目设计必须预留适配口，不能把业务逻辑强绑定到当前 `2.4.4` 包的内部文件结构。

基本要求：

- 把微信通道能力抽象为独立适配层，不让 Codex 会话逻辑直接依赖 `openclaw-weixin` 内部模块。
- 明确区分“通道领域模型”和 `openclaw-weixin` 原始消息结构。
- 所有 `openclaw-weixin` 版本差异都集中在 adapter 内处理。
- 启动时记录并检查 `openclaw-weixin` 来源版本、adapter 版本和能力声明。
- 支持未来替换为新版 `openclaw-weixin`、legacy 版本或其他微信通道实现。
- 对 `/new`、`/status`、权限和会话绑定等核心逻辑提供稳定内部接口，不随通道包升级而重写。
- 不调用 `openclaw` CLI。
- 不启动 OpenClaw gateway。
- 不要求安装 OpenClaw host。
- 不依赖 OpenClaw plugin runtime。

相关技术设计见 `docs/technical-design.zh-CN.md`。

### 3.1 微信通讯渠道接入

项目需要通过从 `openclaw-weixin` 复用或裁剪出来的微信通讯能力接收和发送微信消息。

基本要求：

- 能接收来自微信的文本消息。
- 能把微信文本消息转发给 Codex。
- 能把 Codex 的回复发送回对应微信会话。
- 能区分不同微信用户或不同微信群上下文。
- 能维护微信会话与 Codex 会话之间的绑定关系。
- 第一阶段优先支持文本消息；文件和图片发送必须由用户通过 `/sendfile <任务内容>` 单次触发，普通 Codex 输出里的路径不自动转发。
- 后续继续预留语音、视频等媒体消息的扩展空间。

### 3.2 Codex 会话接入

项目需要能驱动或连接 Codex 会话。

基本要求：

- 能为微信用户创建新的 Codex 会话。
- 能把普通微信消息发送到当前活跃 Codex 会话。
- 能跟踪每个微信上下文对应的 Codex 会话。
- 能获取或整理 Codex 当前状态，用于 `/status` 命令。
- 默认不应把不同用户或不同群的上下文混到同一个 Codex 会话中。

当前实现约束：

- 默认真实接入走 `codex app-server`，用于创建、恢复、中断 Codex thread/turn，并支持微信交互审批。
- `codex exec --json` 只作为非交互回退模式，不承担完整审批体验。
- Codex 会话的外部创建、恢复和中断已具备初版能力；后续仍需补充 app-server 重连、事件背压和更多协议版本兼容。

### 3.3 `/new` 命令

需要适配微信中的 `/new` 命令，用于创建新的 Codex 会话。

期望行为：

- 当前微信用户或群上下文执行 `/new` 后，创建一个新的 Codex 会话。
- 新会话成为该微信上下文的活跃会话。
- 旧会话不应被误删，除非用户明确要求。
- 微信中返回简洁确认，例如当前新会话编号、工作区、状态。
- 如果当前 Codex 正在执行任务，需要明确处理策略。

建议策略：

- 默认情况下，`/new` 只切换到新会话，不强制取消旧任务。
- 如果 Codex 当前任务无法并行运行，则提示用户先 `/stop` 或等待完成。
- 后续可以支持 `/new --stop-current` 或类似参数。

### 3.4 自定义 `/status` 命令

需要新增 `/status` 命令，并融合 Codex 状态与微信通道状态。

状态内容应包含：

- Codex 当前会话状态。
- Codex 当前是否空闲、运行中、等待输入、失败或阻塞。
- 当前微信通道连接状态。
- 当前微信登录或账号状态。
- 当前微信上下文与 Codex 会话的绑定状态。
- 当前活跃会话 ID 或短名称。
- 最近一次收到微信消息的时间。
- 最近一次发送微信回复的时间。
- 最近一次 Codex 活动时间。
- 最近错误摘要。
- 如果 Codex 正在执行任务，显示当前待完成操作的简要说明。
- 显示当前是否正在处理、排队消息数量和可用的 `/stop` 操作提示。

微信展示要求：

- 输出应短而清楚，适合在微信里阅读。
- 不应泄露 token、cookie、完整本地路径、环境变量或敏感账号信息。
- 普通用户看到简化状态，管理员可以看到更详细诊断信息。

### 3.5 更多实用命令

项目后续应支持更多微信侧命令。第一批候选命令：

- `/help`：查看可用命令。
- `/new`：创建并切换到新的 Codex 会话。
- `/status`：查看 Codex 与微信通道综合状态。
- `/stop`：立刻终止当前 Codex 任务，不结束 Codex 会话。
- `/resume`：恢复或重新绑定已有 Codex 会话。
- `/sessions`：列出当前微信上下文最近的 Codex 会话。
- `/sessions all` 或 `/all-sessions`：列出全部可发现 Codex 历史会话，方便微信用户获得会话 ID 或用编号选择后执行 `/resume` 或 `/use`。
- `/use [session|编号]`：切换到指定会话；不带参数时进入会话选择模式，用户直接回复编号完成切换，回复“取消”退出。
- `/clear`：清理微信侧临时状态，不删除持久化 Codex 历史。
- `/debug`：管理员诊断命令，输出更详细的通道、状态和错误信息。
- `/config`：管理员查看当前非敏感配置。
- `/whoami`：查看当前微信上下文识别结果和权限角色。
- `/plan [任务]`：进入 Codex Plan mode；带任务时先切到计划模式再提交该任务，模式不会自动退出。
- `/code [任务]`：切回默认执行模式；带任务时先切回默认模式再提交该任务。`/default` 可作为隐藏别名。
- `/goal [目标]`：查看或设置当前 Codex thread 的实验 Goal 长期目标；若没有绑定会话，设置目标时可以先创建/绑定会话。
- `/goal pause`：暂停 Goal，保留目标但暂时不让 Codex 按它持续推进。
- `/goal resume`：恢复已暂停的 Goal。
- `/goal clear`：清除 Goal，退出当前会话的 Goal 追踪；不负责关闭 `features.goals` 实验功能。
- `/permission [approval|full confirm]`：查看或切换 Codex 权限模式。
- `/OK`：批准当前 Codex 操作。
- `/NO`：拒绝当前 Codex 操作，但让 Codex 尝试继续。
- `/fff`：微信专用静默刷新命令，不回复、不入队、不转发给 Codex。

命令设计要求：

- 命令解析应独立于普通消息。
- `/plan` 和 `/code` 只影响当前 route/session 的后续 turn；已入队普通消息必须保留入队时的 mode 快照。
- `/goal` 只管理当前 Codex thread 的 goal 状态，不自动启用或关闭 Codex 实验功能；`features.goals` 应通过 Codex 官方 `/experimental` 或 config.toml 预先启用。
- 当当前 route 正在执行 Codex turn、等待审批、存在 background goal turn，或已有排队 prompt 时，Bridge 应阻断会改变执行语义的命令，避免用户误以为设置会影响已启动 turn。阻断范围只限当前 route，不影响其他微信/飞书私聊或其他 route。
- busy route 下仍允许只读和控制命令：`/status`、`/help`、`/whoami`、`/debug`、`/sessions`、`/progress`、`/OK`、`/P`、`/NO`、`/stop`。普通文本不是命令；当当前 active turn 支持 mid-turn steer 时，应优先投递到当前 turn，否则继续按当前 route 队列策略入队。
- busy route 下应拒绝执行语义修改命令：`/permission approval|full confirm`、`/model <...>`、`/model effort <...>`、`/model default`、`/plan`、`/code`、`/new`、`/use`、`/resume`、会话编号选择、`/goal <目标>`、`/goal pause`、`/goal resume`、`/goal clear`。拒绝提示应明确“请等待完成，或先 `/stop`”。
- 普通文本 mid-turn steer 是 Bridge Core 能力，不是微信特例。微信、飞书、Terminal 和未来渠道都通过同一个 route/session 逻辑处理；渠道 adapter 不直接调用 Codex steer。
- Bridge 对连续普通文本必须保序处理。短时间连续输入可以按 route 聚合成批次后投递，投递确认也应聚合，避免对微信/飞书等渠道产生确认消息风暴。steer 不可用、active turn 已结束或当前 turn 不可 steer 时，未投递文本必须按原始顺序回退到普通 prompt 队列。
- 未知命令不应直接执行危险动作。
- 管理员命令需要权限校验。
- 后续应允许配置命令前缀，默认使用 `/`。

### 3.6 Codex 批准模式适配

项目必须适配 Codex 的批准模式。即使 Codex 没有开启全部权限，微信用户也应该能看到待批准操作，并在微信中批准或拒绝。

需要支持的审批类型：

- 命令执行审批。
- 文件变更审批。
- 权限提升审批。
- 网络访问审批。
- 后续 Codex 协议新增的审批类型。

微信审批消息必须包含：

- Codex thread ID 和 turn ID 的短标识。
- 操作类型。
- 待执行命令或待变更文件摘要。
- 工作目录或目标路径摘要。
- Codex 给出的 reason。
- 风险提示。
- 可用决策。
- 用户可回复的命令示例。

微信侧决策命令：

- `/OK`：批准当前审批一次。
- `/NO`：拒绝当前审批一次，让 Codex 尝试继续。
- `/stop`：终止当前 turn。

审批 ID 是内部兼容字段，不作为普通微信用户操作入口。无 ID 的审批命令只处理当前微信上下文最新的 pending approval。

安全要求：

- 默认只有发起该 Codex 会话的微信上下文或管理员可以处理审批。
- Bridge 不应单方面让 app-server pending approval 过期消失；审批应持续可操作，直到用户 `/OK`、`/P`、`/NO`、`/stop` 处理，或 Codex/app-server 明确取消。
- 审批消息不能泄露完整 token、cookie、密钥或敏感环境变量。
- 对破坏性命令、跨目录写入、网络放行等高风险操作，应在微信中明确标记。
- 对持久化放行策略，例如 exec policy 或 network policy amendment，必须比一次性批准展示更强提示。

### 3.7 阶段性回复和流式输出适配

Codex 模型会阶段性输出状态、计划、推理摘要、命令执行过程和最终回复。Bridge Core 需要保留通用阶段性事件能力。微信渠道默认低噪声投递，避免触发微信连续出站限制；微信 2.4.4 适配阶段按独立模式重新测试普通文本进度和结构化工具进度。

要求：

- 能把 Codex 的阶段性事件转换成通用 progress 事件，供非微信渠道投递。
- 微信通过 delivery policy 不发送 task-start，但允许 `/progress silent|brief` 控制普通文本摘要进度；默认 `silent` 不发送进度和工具生命周期，`realtime` 只保留给飞书等可承载渠道。
- 对高频 delta 输出做合并，不逐字刷屏。
- 普通用户默认只看关键阶段和最终结果。
- 管理员或 debug 模式可以看到更细的事件，例如命令开始、命令输出摘要、文件变更摘要。
- 对同一 turn 的阶段性回复要能归并到一个会话上下文。
- `codex exec --json` 模式下阶段性回复以可见事件为准，非微信渠道至少包含简短开始处理提示、reasoning summary、命令/工具/文件变更进度和最终回复；微信默认只发送最终回复、Plan mode 最终计划和旁白、错误、审批、队列提示、媒体发送结果和主动命令回复。
- 微信结构化工具生命周期保留为内部能力，不作为当前普通 `/progress` 用户入口。
- brief 模式必须尽量保留 Codex 旁白、计划和高价值摘要输出；需要兼容 Codex JSONL 中 `reasoning.text`、`reasoning.summary`、`summary_text`、`codex_thinking`、`plan_update` 等可见进度形态。app-server `agentMessage.phase=commentary` 应作为独立 `assistant.commentary` 旁白事件处理，不能继续混入普通进度。
- 如果微信通道不支持编辑已发消息，则采用节流发送和最终汇总。
- 最终回复必须明确和中间进度区分。

微信 typing 要求：

- 通道声明支持 typing 时，Codex 运行期间应让微信侧显示“对方正在输入中”。
- WeixinAdapter 使用 `getconfig` 获取 `typing_ticket`，再调用 `sendtyping`；长任务期间需要周期续发，任务结束、失败或 `/stop` 后需要停止。
- typing 发送失败不能影响 Codex 最终回复，但应记录到日志或通道状态。

非微信渠道建议展示阶段：

- Codex 正在处理这条消息。
- 正在分析或规划。
- 准备执行命令。
- 等待用户批准。
- 命令执行中。
- 文件变更已完成。
- 回复生成中。
- turn 完成、失败或被中断。

当前主干微信渠道不展示上述大多数中间阶段，只保留关键投递；用户可发送 `/fff` 触发一次静默入站刷新。2.4.4 实验中，普通 `/progress` 只公开 `silent/brief`；Plan mode 默认低频展示 Codex 旁白和最终计划，但不因此打开命令进度、工具生命周期或 realtime。

## 4. 状态模型需求

项目至少需要维护三类状态。

Codex 状态：

- 会话 ID。
- 工作区路径或工作区标识。
- 当前任务状态。
- 是否正在运行。
- 是否等待用户输入。
- 最近一次用户输入时间。
- 最近一次 Codex 回复时间。
- 最近错误。

微信通道状态：

- 通道是否已启动。
- 微信是否已登录。
- 当前账号或设备状态。
- 最近一次收到消息时间。
- 最近一次发送消息时间。
- 消息发送失败记录。
- 最近通道错误。

绑定状态：

- 微信用户或群上下文 ID。
- 对应的 Codex 会话 ID。
- 当前权限角色。
- 是否允许该微信上下文使用 Codex。
- 绑定创建时间。
- 最近活跃时间。

## 5. 消息路由需求

消息路由需要明确、可追踪、可恢复。

基本要求：

- 从微信消息中提取稳定的路由 key。
- 每个路由 key 默认绑定一个活跃 Codex 会话。
- 私聊和群聊应区分处理。
- 群聊中是否需要 @ 机器人后才响应，需要作为配置项。
- 命令消息先进入命令处理器，不直接转发给 Codex。
- 普通消息按顺序发送给同一个 Codex 会话。
- 同一微信上下文中，如果 Codex 正在处理普通消息，后续普通文本优先作为 mid-turn steer 投递到当前 turn；steer 不可用或失败时再进入队列并向用户返回排队提示。
- 命令消息不进入普通 prompt 队列，`/status`、`/stop` 和审批命令应尽量立即处理。
- 需要考虑微信重试或断线重连导致的重复消息。

## 6. `/status` 输出草案

普通用户版示例（微信 2.4.4 默认 silent 状态）：

```md
**Codex 状态**

**会话**
- 当前会话: `cdx-8f2a`
- 运行状态: 运行中（轮次 `exec-turn-123`，任务: processing your last message）
- 当前模型: `gpt-5.1-codex`（服务商 `openai`，思考程度 `medium`）
- 上下文: `164,171 / 258,400 token`（63.5%，剩余 94,229）
- 最近一轮 token: 输入 `160,000`，缓存 `120,000`，输出 `4,171`，推理输出 `1,200`
- 本会话累计 token: 总计 `34,375,973`，输入 `34,282,029`，缓存 `33,213,184`，输出 `93,944`，推理输出 `30,181`
- 工作目录: `codex-openclaw-wechat`

**运行**
- 处理状态: 正在处理
- 排队消息: `0`
- 待审批: `0`
- 进度投递: 静默模式
- 权限模式: 审批模式（沙箱 `workspace-write`）
- 可用操作: 发送 `/stop` 终止当前任务

**渠道**
- 渠道: `weixin`
- 连接状态: 已连接
```

管理员版示例（微信 2.4.4 默认 silent 状态）：

```md
**Codex 状态**

**会话**
- 当前会话: `cdx-8f2a`
- 运行状态: 运行中
- 当前模型: `gpt-5.1-codex`（服务商 `openai`，思考程度 `medium`）
- 上下文: `164,171 / 258,400 token`（63.5%，剩余 94,229）
- 最近一轮 token: 输入 `160,000`，缓存 `120,000`，输出 `4,171`，推理输出 `1,200`
- 本会话累计 token: 总计 `34,375,973`，输入 `34,282,029`，缓存 `33,213,184`，输出 `93,944`，推理输出 `30,181`
- 工作目录: `codex-openclaw-wechat`

**运行**
- 处理状态: 正在处理
- 排队消息: `0`
- 待审批: `0`
- 进度投递: 静默模式

**渠道**
- 渠道: `weixin`
- 连接状态: 已连接
- 最近错误: 无
```

## 7. 权限与安全需求

默认不应让所有微信用户都能控制本机 Codex。

基本要求：

- 支持微信用户 allowlist。
- 支持微信群 allowlist。
- 支持管理员用户配置。
- 管理员命令与普通命令分级。
- 不能在微信中输出敏感凭据。
- 不能默认暴露完整本机文件系统信息。
- 微信消息应视为不可信输入。
- `/permission` 需要能在微信侧查看和切换当前绑定 Codex session 的权限模式；`approval` 可直接切回，`full` 必须带显式确认词，例如 `/permission full confirm`。没有绑定 session 时才修改后续新会话默认权限。
- 权限模式切换只影响后续 Codex turn；当前正在运行的任务不会被热改写，需要立即生效时应先 `/stop`。

## 8. 配置需求

项目后续应支持配置：

- Weixin Adapter 配置。
- `openclaw-weixin` 复用/裁剪模块配置。
- 微信登录态存储路径。
- Codex 工作区路径。
- Codex 启动方式。
- 允许访问的微信用户。
- 允许访问的微信群。
- 管理员用户。
- 默认会话策略。
- 命令前缀。
- 日志等级。
- 状态存储路径。
- 是否允许群聊响应。
- 群聊是否要求 @ 触发。

配置文件可优先使用 YAML 或 JSON；敏感项优先走环境变量。

## 9. 可靠性需求

项目需要适合长时间运行。

基本要求：

- 记录启动、停止、登录、断线、重连等通道事件。
- 记录命令执行和会话切换。
- 记录 Codex 调用状态和错误。
- `chat-codex` 常驻终端必须以清晰的聊天记录样式打印本次运行期内的微信入站消息、发回微信的 Codex 回复和媒体发送记录，方便观察真实对话流。
- 对话内容暂不做中间件持久化保存；Codex 自身历史记录是当前主要会话记录来源。
- 进程重启后能恢复微信上下文与 Codex 会话绑定。
- `/status` 能反映最近错误。
- 发送失败时应有重试或明确错误提示。
- 日志中需要做敏感信息脱敏。

## 9.1 开发质量与测试报告要求

这是重点执行要求。

- 代码必须符合 `docs/development-and-test.zh-CN.md` 中定义的开发规范。
- 每次实现一个功能，都必须补充对应自测。
- 每次自测都必须留下中文测试报告。
- 测试报告统一存放在 `reports/tests/` 目录。
- 测试报告文件名建议使用 `YYYY-MM-DD-功能名.md`。
- 报告必须包含测试目标、测试环境、执行命令、测试步骤、结果、遗留问题。
- 如果功能因为微信未登录无法做真实通道测试，必须先完成 mock/local 测试，并在报告中明确说明等待用户登录后补测。
- 不允许只实现功能、不验证、不留报告。

## 10. 第一阶段非目标

第一阶段暂不要求：

- 完整媒体消息处理。
- 多租户部署。
- Web 管理后台。
- 任何 OpenClaw 主程序安装或管理。
- 依赖 OpenClaw CLI、gateway 或 host runtime。
- 完整重写 `openclaw-weixin` 的所有能力。
- 高级统计分析。
- 复杂权限系统。

## 11. 建议里程碑

### 里程碑 1：Codex 与中间件通信

- 创建 Node.js + TypeScript CLI 项目骨架。
- 实现 Bridge Core、Command Router、State Store 和 Logger。
- 实现通用 Channel Adapter 协议和 mock channel。
- 实现 Codex Adapter 的第一版。
- 用终端或 mock channel 模拟微信输入输出。
- 验证 `/new`、`/status`、`/stop`、`/OK`、`/NO`、`/permission` 的本地流程。
- 验证 Codex 阶段性事件和审批请求能进入中间件。
- 留下中文测试报告。

### 里程碑 2：中间件与 Weixin Adapter 通信

- 阅读 `@tencent-weixin/openclaw-weixin` 包结构。
- 找出可直接复用/裁剪的登录、账号、getUpdates、sendMessage、typing、media 模块。
- 对强依赖 `openclaw/plugin-sdk` 的部分做最小 shim 或薄适配层。
- 实现中间件自己的微信登录入口。
- 接收真实微信文本消息。
- 发送文本回复到微信。
- 在微信未登录前先完成 mock/local 测试并留报告。
- 第一版登录入口完成后，由用户登录微信并协助真实通道测试。
- 用户登录后补充真实微信通道测试报告。

### 里程碑 3：完整双向桥接

- 转发普通微信消息给 Codex。
- 把 Codex 最终回复和阶段性状态发回微信。
- 持久化微信上下文与 Codex 会话绑定。
- 支持 `/sessions`、`/use`、`/resume`。
- 支持微信审批命令处理 Codex approval request。
- 处理重启恢复。
- 每个命令和关键状态流都要有测试报告。

### 里程碑 4：安全与稳定性

- 加入 allowlist。
- 加入管理员权限。
- 加入结构化日志。
- 加入错误脱敏。
- 为命令解析和状态切换补测试。

## 12. 待确认问题

- Codex 最终通过什么方式被本项目调用？
- `/new` 是创建真正的新 Codex 会话，还是只创建微信侧逻辑会话？
- 当前 Codex 任务运行中时，是否允许并行新会话？
- 群聊中是否必须 @ 机器人？
- 是否一个微信用户默认一个 Codex 会话？
- 状态持久化应该放在项目目录、用户目录，还是可配置目录？
- 微信登录态应该复用 `openclaw-weixin` 的账号/登录模块，还是由本项目重新实现存储格式？
- 管理员如何绑定自己的微信身份？
