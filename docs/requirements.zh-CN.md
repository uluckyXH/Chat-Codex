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
- 处理 `/new`、`/status`、`/approve`、`/deny`、`/cancel` 等微信命令。
- 记录结构化日志和持久化状态。
- 以终端命令形式启动和运行，保持轻量，不引入重框架。

重点要求：

- 中间件不能只为 `openclaw-weixin` 写死。必须抽象出一套通用渠道协议，后续其他人适配别的渠道时，只需要实现这套协议即可接入 Codex。
- 项目文档、测试报告和开发记录以中文为主。
- 每次实现功能都必须有自测，测试报告需要保存到独立目录。
- 先适配 Codex 与中间件通信，再适配中间件与 `openclaw-weixin` 的桥接。
- 第一版微信桥接完成后，中间件需要提供登录方式；用户会登录微信并协助进行真实通道测试。

## 2. 当前阶段范围

当前已进入第一阶段实现：先打通 Codex 与中间件通信，再进入真实微信桥接。第一阶段允许使用 mock channel 和 terminal channel 模拟微信输入输出，避免被微信登录阻塞。

当前已完成或已建立的基础内容：

- 独立 Git 仓库和 Git 管理规范。
- Node.js + TypeScript 项目骨架。
- 通用 `ChannelAdapter` 协议。
- `MockChannelAdapter`。
- `TerminalChannelAdapter`，用于本地终端模拟微信消息。
- `Bridge Core`、命令处理、审批管理、内存状态存储、日志。
- `MockCodexAdapter`。
- `ExecCodexAdapter` 初版，用于后续通过 `codex exec --json` 做真实 Codex CLI 验证。
- `WeixinAdapter` 第一版：已实现二维码登录 API 入口、登录确认轮询、账号 token 本地存储、文本 `sendmessage` 请求、微信入站消息到通用 `ChannelMessage` 的转换。
- `WeixinAdapter` 真实扫码登录和真实微信收发仍需用户后续协助测试。
- 本地单元测试、集成测试和中文测试报告。

已经本地保存的 `openclaw-weixin` 微信通讯 npm 包：

- `openclaw-weixin-npm/tencent-weixin-openclaw-weixin-2.4.3.tgz`
- `openclaw-weixin-npm/extracted/openclaw-weixin-2.4.3/`

已经本地保存的 Codex 源码参考仓库：

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
- `src/state/` 是源码目录，必须被 Git 追踪；运行态状态只允许写入根目录 `/state/` 或后续配置的运行态目录。
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
- `/new`、`/status`、`/approve`、`/deny`、`/cancel` 等命令逻辑必须在 Bridge Core/Command Router 中实现，不写进某个具体渠道 adapter。
- 渠道 adapter 只负责登录、连接、收消息、发消息、能力声明和状态上报。
- 不同渠道的用户、群、线程等上下文必须归一化为统一 route key。

这是重点架构要求，后续实现不能绕过。

### 3.0 可演进适配要求

`openclaw-weixin` 插件后续会继续更新，项目设计必须预留适配口，不能把业务逻辑强绑定到当前 `2.4.3` 包的内部文件结构。

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
- 第一阶段优先支持文本消息。
- 后续预留图片、语音、文件等媒体消息的扩展空间。

### 3.2 Codex 会话接入

项目需要能驱动或连接 Codex 会话。

基本要求：

- 能为微信用户创建新的 Codex 会话。
- 能把普通微信消息发送到当前活跃 Codex 会话。
- 能跟踪每个微信上下文对应的 Codex 会话。
- 能获取或整理 Codex 当前状态，用于 `/status` 命令。
- 默认不应把不同用户或不同群的上下文混到同一个 Codex 会话中。

待确认：

- Codex 第一阶段应通过 CLI JSONL、SDK，还是 app-server 接入；完整审批目标倾向 app-server。
- Codex 会话是否能被外部可靠地创建、恢复、中断和查询状态。

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
- 如果 Codex 当前任务无法并行运行，则提示用户先 `/cancel` 或等待完成。
- 后续可以支持 `/new --cancel-current` 或类似参数。

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

微信展示要求：

- 输出应短而清楚，适合在微信里阅读。
- 不应泄露 token、cookie、完整本地路径、环境变量或敏感账号信息。
- 普通用户看到简化状态，管理员可以看到更详细诊断信息。

### 3.5 更多实用命令

项目后续应支持更多微信侧命令。第一批候选命令：

- `/help`：查看可用命令。
- `/new`：创建并切换到新的 Codex 会话。
- `/status`：查看 Codex 与微信通道综合状态。
- `/cancel`：取消或中断当前 Codex 任务。
- `/resume`：恢复或重新绑定已有 Codex 会话。
- `/sessions`：列出当前微信上下文最近的 Codex 会话。
- `/use <session>`：切换到指定会话。
- `/clear`：清理微信侧临时状态，不删除持久化 Codex 历史。
- `/debug`：管理员诊断命令，输出更详细的通道、状态和错误信息。
- `/config`：管理员查看当前非敏感配置。
- `/whoami`：查看当前微信上下文识别结果和权限角色。
- `/approve <id>`：批准指定 Codex 操作。
- `/approve-session <id>`：本会话内批准同类操作。
- `/deny <id>`：拒绝指定 Codex 操作，但让 Codex 尝试继续。
- `/reject <id>`：同 `/deny <id>`。
- `/cancel <id>`：拒绝指定操作，并中断当前 Codex turn。

命令设计要求：

- 命令解析应独立于普通消息。
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

- 审批短 ID。
- Codex thread ID 和 turn ID 的短标识。
- 操作类型。
- 待执行命令或待变更文件摘要。
- 工作目录或目标路径摘要。
- Codex 给出的 reason。
- 风险提示。
- 可用决策。
- 用户可回复的命令示例。

微信侧决策命令：

- `/approve <id>`：批准一次。
- `/approve-session <id>`：本 Codex 会话内批准同类操作。
- `/deny <id>`：拒绝一次，让 Codex 尝试继续。
- `/cancel <id>`：拒绝并中断当前 turn。

安全要求：

- 默认只有发起该 Codex 会话的微信上下文或管理员可以处理审批。
- 审批请求必须有超时时间。
- 审批消息不能泄露完整 token、cookie、密钥或敏感环境变量。
- 对破坏性命令、跨目录写入、网络放行等高风险操作，应在微信中明确标记。
- 对持久化放行策略，例如 exec policy 或 network policy amendment，必须比一次性批准展示更强提示。

### 3.7 阶段性回复和流式输出适配

Codex 模型会阶段性输出状态、计划、推理摘要、命令执行过程和最终回复。微信渠道需要适配这种输出形态。

要求：

- 能把 Codex 的阶段性事件转换成微信可读的简短进度消息。
- 对高频 delta 输出做合并，不逐字刷屏。
- 普通用户默认只看关键阶段和最终结果。
- 管理员或 debug 模式可以看到更细的事件，例如命令开始、命令输出摘要、文件变更摘要。
- 对同一 turn 的阶段性回复要能归并到一个会话上下文。
- 如果微信通道不支持编辑已发消息，则采用节流发送和最终汇总。
- 最终回复必须明确和中间进度区分。

建议展示阶段：

- Codex 已开始处理。
- 正在分析或规划。
- 准备执行命令。
- 等待用户批准。
- 命令执行中。
- 文件变更已完成。
- 回复生成中。
- turn 完成、失败或被中断。

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
- 需要考虑微信重试或断线重连导致的重复消息。

## 6. `/status` 输出草案

普通用户版示例：

```text
Codex: running
Session: wx-u123 / cdx-8f2a
WeChat: connected
Last: 00:41
Task: processing your last message
```

管理员版示例：

```text
Codex: running
Session: cdx-8f2a
Workspace: codex-openclaw-wechat
WeChat: connected, logged in
Binding: group:g123 -> cdx-8f2a
Inbound: 00:41
Outbound: 00:40
Last error: none
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
- 验证 `/new`、`/status`、`/approve`、`/deny`、`/cancel` 的本地流程。
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
- 支持 `/sessions`、`/use`、`/resume`、`/cancel`。
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
