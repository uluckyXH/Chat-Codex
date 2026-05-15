# Codex 微信中间件

这是一个轻量中间件项目，用来把 Codex 接入可插拔聊天渠道。第一条渠道是微信，微信通讯能力来自 `@tencent-weixin/openclaw-weixin` 包的拆解与适配。

本项目运行时不依赖 OpenClaw CLI、OpenClaw gateway、OpenClaw host runtime 或 OpenClaw channel runtime。`openclaw-weixin` 只作为微信通讯能力的源码、协议和适配参考。

## 当前状态

- 已建立 Node.js + TypeScript 项目骨架。
- 已把 `@tencent-weixin/openclaw-weixin` 与 `@larksuite/openclaw-lark` 的下载来源和本地放置规范统一写到 `references/README.md`；本地参考源码目录只作临时资料，不提交。
- 已建立通用 `ChannelAdapter` 协议，后续其他渠道可按同一协议接入。
- 已实现 Mock、Terminal、Weixin 三类通道适配器。
- 已实现 Bridge Core、命令路由、审批管理、内存状态和基础日志。
- 已实现默认 `codex app-server` 适配器：通过 stdio JSON-RPC 创建/恢复 thread，启动 turn，并把 command/file/permissions 审批请求转成微信 `/OK`、`/P`、`/NO`。
- 已保留 `codex exec --json` 适配器作为回退模式，并通过终端通道验证真实 Codex CLI 通信。
- 已实现微信二维码登录入口、账号凭证本地保存、文本发送和 `getupdates` 轮询基础能力。
- 已实现显式文件发送：普通回复和进度里的路径只当文本；需要让 Codex 本轮生成并发送文件时，使用 `/sendfile <任务内容>`。
- `weixin codex` 启动时会检查 Codex 可用性和微信登录态；已登录会跳过二维码，未登录会进入扫码登录。
- `weixin codex` 常驻终端会用彩色聊天记录样式打印微信入站消息、发回微信的 Codex 回复、按投递策略发出的阶段性进度和媒体发送记录，方便运行时观察对话流；默认非 TTY 输出会保持纯文本。
- 历史会话列表会优先读取 Codex SQLite 状态里的标题或首条用户消息，读不到再回退到 `session_index.jsonl` 和 rollout 元数据。

## 常用命令

```bash
npm test
npm run cli:mock
npm run cli:terminal:mock
npm run cli:terminal:codex
npm run cli:weixin:status
npm run cli:weixin:login
npm run cli:weixin:codex
```

真实 Codex 模式支持启动参数：

```bash
npm run cli:terminal:codex -- --session new --permission approval --cwd ./workspaces/demo
npm run cli:weixin:codex -- --session last --permission approval
```

- `--session new|last|<id>`：创建新会话、恢复最近会话或绑定指定 Codex 会话。
- `--cwd <dir>` / `--workdir <dir>`：只用于新会话；目录不存在会自动创建。
- `--codex-adapter app-server|exec` / `--adapter app-server|exec`：选择 Codex 接入方式，默认 `app-server`。`app-server` 支持微信交互审批；`exec` 是非交互回退，不会把审批请求推送到微信。
- `--permission approval|full`：选择安全沙箱模式或完全权限。默认 `approval` 使用 `workspace-write` sandbox，并在 app-server 模式下把审批请求推送到微信；该模式保留网络访问能力，避免与本机 Codex CLI 的 `workspace-write` 行为不一致。
- `--yes-dangerously-full`：非交互确认完全权限。完全权限会跳过审批和沙箱，风险很高。
- `--progress brief|detailed|silent`：设置默认进度投递模式，供非微信渠道使用。微信渠道通过 delivery policy 不投递任务开始提示和阶段性进度，避免触发微信出站数量限制。

交互启动时会先选择新会话或历史会话，再选择本次启动后的 Codex 权限模式，避免历史会话的上下文让权限选择不直观。如果选择新会话，会展示默认工作目录。用户输入新目录时，目录不存在会自动创建；如果选择历史会话，中间件会使用该 Codex 会话历史记录里的工作目录。微信侧 `/permission` 绑定到当前选中的 Codex session；尚未绑定 session 时才修改后续新会话的默认权限。

默认 `codex app-server` 模式会复用 Codex 历史 thread，并由中间件作为当前微信会话的 Codex 客户端。它支持交互审批、turn 中断、token usage 状态更新和 commentary 阶段消息转发，但不会把微信侧交互实时同步到另一个已经打开的 Codex CLI 或 Codex App 窗口；如需多端实时同屏，需要额外的观察端或事件订阅设计。`codex exec --json` 仍可通过 `--codex-adapter exec` 启用，用于回退和调试。

同一个微信上下文中的普通消息会按顺序排队处理。Codex 正在工作时再发送普通消息，中间件会先回复排队提示；命令类消息如 `/status`、`/stop`、审批命令仍会立即处理。微信渠道不再发送每条任务开始提示和阶段性进度，只发送队列提示、审批、最终回复、错误、媒体发送结果和用户主动命令回复；需要查看会话、模型、上下文 token 用量和权限细节时使用 `/status`。微信侧 `/progress` 会被拒绝，不改变投递模式；`/fff` 是微信专用静默刷新命令，不会回复，也不会转发给 Codex。

微信侧 `/model` 会从 Codex app-server 的 `model/list` 获取当前真实可用模型，不维护硬编码目录。可以发送 `/model` 查看列表，发送 `/model gpt-5.5 xhigh` 或 `/model 2 high` 切换后续任务的模型和思考程度；模型名或思考程度不在实际列表内会直接报错。

微信出站消息会串行排队并做轻量间隔，同时通过 delivery policy 砍掉任务开始提示和阶段性进度，减少连续出站消息数量。默认发送间隔为 1200ms；遇到 `sendmessage` 限流或临时失败时会做退避重试，仍失败才进入 `degraded` 状态并记录 `lastError`，不会再把这类请求误记为成功 OUT。审批消息属于关键消息：Bridge 会在创建 pending approval 后持续重试发送审批提示，直到至少送达一次，或审批已被 `/OK`、`/P`、`/NO`、`/stop` 处理。Codex 运行期间，微信通道会通过 `getconfig` 获取 `typing_ticket`，再周期调用 `sendtyping` 维持“对方正在输入中”状态，结束或 `/stop` 后会停止 typing。

普通消息和阶段性输出不会自动发送文件或图片；即使 Codex 回复里出现本地路径、Markdown 图片或 `file://`，也只作为普通文本处理。需要让 Codex 本轮生成并发送文件时，发送 `/sendfile <任务内容>`。中间件会在转给 Codex 的 prompt 里追加内部协议说明，只解析本轮最终回复末尾的 `BRIDGE_SEND_FILE: /absolute/path/to/file` 行；每轮最多发送 3 个文件，并在发给用户的最终文本里隐藏这些内部协议行。文件发送失败时只发送一条聚合结果，不再逐个文件发送 fallback 文本。

## 微信登录态

默认微信登录态保存在项目根目录的 `state/weixin/`，该目录已被 `.gitignore` 忽略，不会提交到 Git。账号索引在 `state/weixin/accounts.json`，每个账号的 token 和轮询游标保存在 `state/weixin/accounts/<accountId>.json`。

要让微信登录失效，可以停止中间件后删除整个 `state/weixin/` 目录；如果只想删除某个账号，删除对应的 `state/weixin/accounts/<accountId>.json`，必要时再从 `state/weixin/accounts.json` 里移除该账号 ID。下次运行 `npm run cli:weixin:codex` 或 `npm run cli:weixin:login` 时会重新进入扫码登录。

## 微信侧命令

- `/help`：查看命令。
- `/new`：为当前微信上下文创建新的 Codex 会话。
- `/status`：查看 Codex session、模型、上下文 token 用量、累计 token 用量、Bridge 队列、审批、权限和通道健康状态；微信渠道会显示 progress 已禁用。
- `/sessions`：查看当前微信上下文绑定过的会话。
- `/sessions all` 或 `/all-sessions`：查看全部可发现 Codex 历史会话 ID。
- `/resume <session>` / `/use <session>`：恢复并绑定指定 Codex 会话。
- `/sendfile <任务内容>`：让 Codex 本轮按内部协议声明最终要发送的文件；普通消息不会自动发文件。
- `/model [模型|编号] [effort]`：查看 app-server 实际可用模型，或切换后续任务使用的模型和思考程度。
- `/permission [approval|full confirm]`：查看或切换当前绑定 Codex session 的权限模式；没有绑定 session 时修改后续新会话默认权限。
- `/OK`：批准当前 Codex 审批。
- `/P`：按当前 Codex 会话批准审批，后续同类操作尽量不再询问。
- `/NO`：拒绝当前 Codex 审批。
- `/stop`：终止当前正在处理的 Codex 任务，不结束 Codex 会话。
- `/fff`：微信专用静默刷新命令，不回复、不入队、不转发给 Codex。

## 文档

- [docs/README.md](docs/README.md)：文档索引。
- [docs/requirements.zh-CN.md](docs/requirements.zh-CN.md)：中文需求文档。
- [docs/technical-design.zh-CN.md](docs/technical-design.zh-CN.md)：中文技术设计。
- [docs/development-and-test.zh-CN.md](docs/development-and-test.zh-CN.md)：开发与测试规范。
- [docs/git-management.zh-CN.md](docs/git-management.zh-CN.md)：Git 管理规范。
- [reports/tests/](reports/tests/)：中文测试报告。

## 协议

本项目使用 [MIT License](LICENSE)。

作者：小黄 and Codex

## 参考文件

- [references/README.md](references/README.md)：参考源码索引，包含微信插件、飞书插件和 Codex 协议参考仓库的拉取方式。
- `openclaw-weixin-npm/`：微信插件 npm 包本地临时下载和解包目录，不提交。
- `references/openclaw-lark/`：飞书官方通讯渠道插件本地 shallow clone，不提交。
- `references/openai-codex/`：Codex 官方仓库本地 shallow clone，仅在需要查协议时按 `references/README.md` 拉取，不提交。
