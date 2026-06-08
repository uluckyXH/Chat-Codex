# Codex 微信通讯中间件技术设计

## 1. 设计目标

本项目要实现一个轻量中间件，让 Codex 能直接对接 `openclaw-weixin` 的微信通讯能力：微信消息进入中间件后路由到 Codex，Codex 的输出再回到同一个微信上下文；同时支持 `/new`、`/status`、审批命令以及后续更多实用命令。

本文档是后续实现的目标基线。实现时如果发现 Codex 或 `openclaw-weixin` 的实际行为与本文档不同，应先查看本地参考源码和官方协议，再更新本文档，然后调整实现。

明确边界：

- 本项目运行时不依赖 OpenClaw CLI。
- 本项目运行时不启动 OpenClaw gateway。
- 本项目运行时不要求 OpenClaw host。
- 本项目运行时不使用 OpenClaw channel runtime。
- `openclaw-weixin` 是微信通讯插件源码、协议和能力参考，不是本项目的宿主环境。

设计重点：

- 中间件作为专门通信层，负责 Codex 和微信通讯插件能力之间的桥接。
- Bridge Core 面向通用渠道协议，不绑定具体微信实现。
- 微信通道和 Codex 接入解耦。
- 命令层和普通对话层解耦。
- `openclaw-weixin` 后续升级时，只改通道 adapter，不重写 Codex 侧和命令侧。
- Codex 接入方案可从简单 CLI 逐步升级到 SDK 或 app-server。
- 以 Node.js + TypeScript 实现，保持 CLI/daemon 形态，不使用重型 Web 框架。
- 每个功能必须自测并留下中文测试报告。

## 2. 已知依据

微信通道参考 `@tencent-weixin/openclaw-weixin@2.4.4` npm 包。该包通过 `references/README.md` 中的命令按需下载和解包，不提交到仓库：

- `openclaw-weixin-npm/tencent-weixin-openclaw-weixin-2.4.4.tgz`
- `openclaw-weixin-npm/extracted/openclaw-weixin-2.4.4/`

从本地包可见：

- 插件 ID 是 `openclaw-weixin`。
- peer dependency 要求 `openclaw >=2026.3.22`，这只说明该包原始宿主环境，不代表本项目运行时依赖 OpenClaw。
- 插件原本通过 `api.registerChannel({ plugin: weixinPlugin })` 注册 channel，但本项目不使用 OpenClaw host 加载它。
- 通道能力包含 direct chat、media、block streaming。
- 当前内置斜杠命令只有 `/echo` 和 `/toggle-debug`。
- 微信后端协议是 HTTP JSON API，核心接口包括 `getupdates`、`sendmessage`、`getuploadurl`、`getconfig`、`sendtyping`。
- 微信消息结构里有 `from_user_id`、`to_user_id`、`session_id`、`group_id`、`context_token`、`item_list` 等字段。

Codex 侧调研结论：

- 本机 Codex CLI 提供 `codex exec --json`，可以非交互运行并输出 JSONL 事件流。
- 本机 Codex CLI 提供 `codex exec resume` 和 `codex resume`，可以恢复历史 session。
- 本机 Codex CLI 提供 `codex mcp-server`，可作为 MCP server 暴露给外部客户端。
- 本机 Codex CLI 提供 `codex app-server`，可通过 stdio 或 WebSocket 暴露 app-server 协议。
- 本机 Codex CLI 提供 `codex remote-control`，但它是实验能力，不作为第一阶段默认方案。
- OpenAI 官方 Codex SDK 支持在应用内控制本地 Codex agent，更适合中长期集成。

OpenAI Codex 官方开源仓库只作为协议参考，按需通过 `references/README.md` 拉取，不提交：

- 路径：`references/openai-codex/`
- 远端：`https://github.com/openai/codex.git`
- 当前参考 commit：`83decfa3009cc575403bf935415eccb0a552d8f2`
- 最新提交时间：2026-05-13 16:43:25 +0000

后续实现遇到 Codex 接入细节不确定时，应优先查看该源码中的协议、事件和测试，而不是猜测行为。

重点参考文件：

- `references/openai-codex/codex-rs/exec/src/exec_events.rs`
- `references/openai-codex/codex-rs/exec/src/lib.rs`
- `references/openai-codex/codex-rs/app-server-protocol/src/protocol/common.rs`
- `references/openai-codex/codex-rs/app-server-protocol/src/protocol/v2/item.rs`
- `references/openai-codex/codex-rs/app-server-protocol/src/protocol/v2/shared.rs`
- `references/openai-codex/codex-rs/app-server-protocol/schema/typescript/ClientRequest.ts`
- `references/openai-codex/codex-rs/app-server-protocol/schema/typescript/ServerRequest.ts`
- `references/openai-codex/codex-rs/app-server-protocol/schema/typescript/ServerNotification.ts`
- `references/openai-codex/codex-rs/app-server-test-client/src/lib.rs`

## 3. 总体架构

建议拆成四层：

```text
Codex app-server / SDK / CLI
        |
        v
Codex Adapter
        |
        v
Bridge Core
        |
        +--> Command Router (/new, /status, /help, /stop...)
        +--> Approval Manager (/OK, /NO)
        +--> State Store / Logs
        |
        v
Channel Adapter
        |
        v
Terminal / Weixin / future channels
```

推荐先做左半边，再做右半边：

- 阶段 A：Codex <-> 中间件。先用终端或模拟微信通道验证 Codex 会话、事件、审批和日志。
- 阶段 B：中间件 <-> 微信。再接入 `openclaw-weixin` 通讯能力，完成登录、收消息和发消息。
- 阶段 C：完整闭环。把 Codex 状态、微信状态、审批、命令和持久化恢复打通。

当前实现状态：

- `MockChannelAdapter` 用于自动化测试。
- `TerminalChannelAdapter` 用于本地 CLI 交互和管道测试，模拟微信输入输出。
- `WeixinAdapter` 已进入第二阶段初版：二维码登录 API、登录确认轮询、账号 token 文件存储、文本 `sendmessage`、入站消息映射已经实现并通过 fake-fetch 测试。
- 真实微信启动入口统一为 `chat-codex`：先检查 Codex，再在“管理渠道”里添加或检查本地微信凭证；已登录时跳过二维码，未登录时发起二维码登录，用户回到首页选择“启动服务”后启动长轮询。
- 真实微信扫码登录、`getupdates` 长轮询闭环和真实微信收发需要用户后续协助测试。
- `MockCodexAdapter` 用于稳定测试审批、阶段性事件和命令。
- `AppServerCodexAdapter` 已具备 stdio JSON-RPC 接入能力，默认用于真实 Codex：支持 `initialize`、`thread/start`、`thread/resume`、`turn/start`、`turn/interrupt`，并把 app-server server request 审批转成微信审批。
- `ExecCodexAdapter` 已具备解析 `codex exec --json` 的基础能力，并已通过中间件终端通道完成真实 Codex CLI 联调；它保留为非交互回退模式。
- 中间件启动真实 Codex 模式时会先检测 `codex --version`，不可用则停止启动。
- 真实 Codex 模式支持启动时选择历史 Codex 会话或创建新会话。
- 选择新会话时会展示默认工作目录，支持通过交互输入或 `--cwd` / `--workdir` 指定工作目录；目录不存在时自动创建。
- 选择历史会话时不创建新工作目录，而是从 `$CODEX_HOME/state_5.sqlite`、`$CODEX_HOME/session_index.jsonl` 和 `$CODEX_HOME/sessions/**/*.jsonl` 读取标题、首条用户消息、session 元数据和原 `cwd`，再交给当前 Codex adapter 恢复。
- Bridge 已按 routeKey 建立普通 prompt 串行队列；同一微信上下文中 Codex 正在运行时，新普通文本后续应优先通过 mid-turn steer 投递到当前 turn，steer 不可用时回退排队，命令消息仍立即处理。
- 真实 Codex 模式支持启动时先选择会话、再选择权限模式：默认 app-server adapter 的 `approval` 使用 `workspace-write` sandbox、`approvalPolicy=on-request` 和 `approvalsReviewer=user`，可把审批推送到微信，并保留网络访问能力以对齐本机 Codex CLI 的 `workspace-write` 行为；`full` 使用完全权限并要求危险确认。`codex exec` adapter 只作为非交互回退。

## 3.0 通用渠道协议

这是重点设计：中间件核心不能对死 `openclaw-weixin`。`openclaw-weixin` 是第一条渠道实现，但 Bridge Core 必须只依赖通用渠道协议。

### 3.0.1 设计原则

- Bridge Core 不 import `openclaw-weixin` 类型。
- Command Router 不 import `openclaw-weixin` 类型。
- Approval Manager 不 import `openclaw-weixin` 类型。
- 具体渠道协议差异只存在于 `src/channels/<channel>/`。
- 具体渠道的投递差异应优先表达为通用 `ChannelCapabilities`、delivery policy、route policy 或 adapter-owned 行为，而不是在 Bridge Core 中散落渠道名判断。
- 渠道支持私聊、群聊、typing、媒体或消息编辑等能力时，必须由 adapter 通过 capabilities 声明；Bridge Core 只按能力使用通用接口。
- 如果短期必须在 Bridge Core 做渠道特例，需要有测试覆盖，并在文档或测试报告里说明后续如何收敛成通用策略。
- 新渠道接入时，只要实现 `ChannelAdapter` 即可复用 Codex Adapter、命令、审批、状态和日志。

渠道投递策略详见 `docs/channel-delivery-policy.zh-CN.md`。当前实现通过 `ChannelAdapter.getDeliveryPolicy()` 控制 task-start、progress、`/progress` 和 refresh 命令。

### 3.0.2 Adapter Contract 草案

```ts
type ChannelAdapter = {
  id: string;
  label: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  login?(): Promise<ChannelLoginResult>;
  getStatus(): Promise<ChannelStatus>;
  getCapabilities(): ChannelCapabilities;
  onMessage(handler: (message: ChannelMessage) => Promise<void>): void;
  sendText(target: ChannelTarget, text: string, options?: SendOptions): Promise<SendResult>;
  sendMedia?(target: ChannelTarget, media: ChannelMedia, options?: SendOptions): Promise<SendResult>;
  sendTyping?(target: ChannelTarget, typing: boolean, options?: SendOptions): Promise<void>;
};
```

```ts
type ChannelMessage = {
  id: string;
  routeKey: string;
  channelId: string;
  accountId?: string;
  sender: ChannelPeer;
  conversation: ChannelConversation;
  text?: string;
  attachments?: ChannelAttachment[];
  timestamp: string;
  raw?: unknown;
};
```

```ts
type ChannelStatus = {
  channelId: string;
  state: "stopped" | "starting" | "login_required" | "connected" | "degraded" | "failed";
  account?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastError?: string;
  details?: Record<string, unknown>;
};
```

```ts
type ChannelCapabilities = {
  text: boolean;
  media: boolean;
  typing: boolean;
  direct: boolean;
  group: boolean;
  thread: boolean;
  login: "none" | "qr" | "token" | "external";
  messageUpdate: boolean;
  streamingHint: boolean;
};
```

```ts
type ChannelMedia = {
  type: "image" | "voice" | "file" | "video";
  path?: string;
  url?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  caption?: string;
};
```

媒体策略：

- Bridge 只依赖 `ChannelMedia`，不直接引用微信协议字段。
- Codex 输出中的图片引用会由 Bridge 自动抽取成 `ChannelMedia`，当前覆盖 Markdown 图片、本地绝对路径、`./`/`../`/带目录的相对路径、`file://` 和 HTTP(S) 图片 URL。
- 普通文件只从显式引用中抽取，例如 Markdown 链接、`MEDIA:`/`FILE:` 指令、`文件:`/`附件:`/`File:`/`Attachment:` 标签，避免把阶段性进度里的代码路径误发成附件。
- 通道声明 `capabilities.media=true` 且实现 `sendMedia` 时，Bridge 会调用媒体发送；否则退回文本说明，避免图片或文件路径静默丢失。
- 同一轮输出中的媒体按 `path/url` 去重，避免阶段性输出和最终回复重复发送同一张截图或同一个附件。

### 3.0.3 Route Key 规范

所有渠道都必须生成稳定 route key：

```text
<channelId>:<accountId>:<conversationKind>:<conversationId>
```

示例：

```text
weixin:wx-account-1:direct:user-123
weixin:wx-account-1:group:group-456
telegram:bot-1:direct:user-789
```

Bridge Core 使用 route key 绑定 Codex session，不关心具体渠道原始 ID 格式。

### 3.0.4 WeixinAdapter 的定位

`WeixinAdapter` 是通用渠道协议的第一个实现：

```text
WeixinAdapter implements ChannelAdapter
```

它负责：

- 复用/裁剪 `openclaw-weixin` 登录能力。
- 复用/裁剪 `getUpdates`。
- 复用/裁剪 `sendMessage`。
- 把微信原始消息转换成 `ChannelMessage`。
- 把 `ChannelTarget` 转换成微信发送参数。
- 上报微信登录态、连接态和错误。

当前实现说明：

- 不 import `openclaw/plugin-sdk`，避免重新引入 OpenClaw runtime。
- 参考 `openclaw-weixin@2.4.4` 的 HTTP JSON API，直接实现 `get_bot_qrcode`、`get_qrcode_status`、`getupdates`、`sendmessage`、`notifystart`、`notifystop` 的薄客户端。
- 图片和普通文件发送参考 `openclaw-weixin@2.4.4` 的媒体链路：`getuploadurl` 申请上传参数，本地文件用 AES-128-ECB 加密后上传 CDN，再通过 `sendmessage` 发送 `image_item` 或 `file_item`。远程媒体 URL 会先下载到本地临时文件再走同一链路。
- 登录轮询支持 `need_verifycode` 分支；CLI 会提示输入手机微信显示的配对数字后继续轮询。
- 登录 token 默认保存在用户状态目录 `~/.chat-codex/state/channels/weixin/...`，不写入项目目录或 Git 跟踪文件。
- 账号 ID 会做文件名安全归一化，例如 `abc@im.bot` 归一化为 `abc-im-bot`。
- `context_token` 会从微信入站消息带入 `ChannelTarget.context.contextToken`；文本、图片和文件发送会带回该字段，使回复尽量关联到当前微信上下文。如果带 token 的发送最终遇到 `ret=-2`，会去掉 `context_token` fallback 一次。
- typing 使用 `getconfig` 获取 `typing_ticket`，再调用 `sendtyping`。Bridge 在 Codex 运行期间每 5 秒调用一次 typing start；微信 adapter 在自己的异步队列里复用当前有效 ticket，必要时才调用 `getconfig(context_token)` 取票，然后发送 typing，不阻塞 Codex 正常回复。`getconfig` 不视为 `context_token` 续期接口；任务完成或 `/stop` 后发送 typing stop，stop 只复用最近一次有效 ticket。
- 当前没有定时刷新 token 的协议；登录后复用服务端返回的 `bot_token`。如果 `getupdates` 返回 session 失效码 `-14`，通道状态切换为 `login_required`，停止当前轮询，等待用户重新扫码登录。旧 token 会保留，用于下一次二维码登录时作为 `local_token_list` 传给服务端识别已绑定账号。
- `weixin status` 会读取本地账号凭证但不启动长轮询；有凭证时显示 `connected`，无凭证时显示 `login_required`。

它不负责：

- Codex session 管理。
- `/new`、`/status`、`/OK`、`/NO`、`/stop` 等命令含义。
- Codex 审批决策。
- 业务状态持久化。

### 3.0.5 多渠道同时接入

多渠道设计详见 `docs/multi-channel-design.zh-CN.md`。核心结论：

- 多个 `ChannelAdapter` 可以在同一个中间件进程里同时运行。
- 多渠道的出站投递需要通过 `ChannelRegistry` 按 `ChannelTarget.channelId` 找回正确 adapter。
- `channelId` 在多渠道运行时必须是渠道实例 ID，并且全局唯一。
- 普通 prompt 继续按 `routeKey` 串行；不同 route 可以并行运行不同 Codex session；全局 `maxConcurrentTurns` 作为可选背压保留，默认不限制。
- Codex session 必须有唯一归属：`sessionId -> ownerRouteKey`。一个 session 一旦绑定到某个 route，不能再被另一个 route 绑定，除非后续实现显式管理员转移。
- `/OK`、`/NO`、`/stop`、`/permission`、`/progress`、`/sendfile` 默认都只作用于当前 route。
- 核心多渠道内核的实施顺序和模块接口草案以 `docs/multi-channel-design.zh-CN.md` 第 13 章为准；本轮不做配置文件、启动向导、真实第二渠道或 `/cwd`。

### 3.1 Channel Adapter

负责和从 `openclaw-weixin` 复用、裁剪或适配出的微信通讯模块打交道。

禁止事项：

- 不调用 `openclaw channels login`。
- 不调用 `openclaw gateway`。
- 不通过 OpenClaw plugin runtime 注册 channel。
- 不要求用户安装 OpenClaw。

允许方式：

- 复用 `openclaw-weixin` 的底层 API、登录、账号、monitor、send、media 模块。
- 对强依赖 `openclaw/plugin-sdk` 的部分做最小 shim 或重写薄适配层。
- 直接实现该插件 README 中公开的微信 HTTP JSON API。
- 把插件代码作为参考源，抽出中间件需要的微信通讯能力。

对内只暴露稳定接口：

- `start()`
- `stop()`
- `login()`
- `getStatus()`
- `onMessage(handler)`
- `sendText(target, text)`
- `sendMedia(target, media)`
- `sendTyping(target, typing)`
- `getCapabilities()`

对内统一消息模型：

```ts
type ChannelMessage = {
  messageId: string;
  routeKey: string;
  channel: "openclaw-weixin";
  accountId?: string;
  peerId: string;
  groupId?: string;
  contextToken?: string;
  text?: string;
  raw: unknown;
  receivedAt: string;
};
```

这样后续 `openclaw-weixin` 升级导致字段变化时，只需要在 adapter 内转换，不影响命令和 Codex 逻辑。

### 3.2 Bridge Core

负责全局编排：

- 根据 `routeKey` 找到当前 Codex session。
- 判断消息是命令还是普通 prompt。
- 做权限校验。
- 做消息排队和并发控制。
- 维护状态和持久化。
- 汇总 `/status` 需要的信息。

### 3.3 Command Router

命令层必须独立于 Codex prompt。

第一阶段命令：

- `/help`
- `/new`
- `/status`
- `/sessions`
- `/sessions all`
- `/all-sessions`
- `/use [session|编号]`
- `/resume [session|编号]`
- `/whoami`
- `/debug`
- `/plan [任务]`
- `/code [任务]`
- `/goal [目标]`
- `/goal pause`
- `/goal resume`
- `/goal clear`
- `/permission [approval|full confirm]`
- `/OK`
- `/NO`
- `/stop`

命令处理结果直接通过 Channel Adapter 回复微信，不进入 Codex。

`/plan` 和 `/code` 是当前 route/session 级的协作模式切换命令。`/plan` 进入 Codex Plan mode，后续普通消息只做计划；`/code` 切回默认执行模式。两者带任务内容时会先切换模式，再把任务按该模式加入普通 prompt 队列。模式不会在 turn 完成后自动退出；已入队普通消息保留入队时的 mode 快照，避免后续切换改写旧任务语义。

`/goal` 是当前 Codex thread 级的实验目标管理命令，不是 collaboration mode，也不进入普通 prompt。`/goal <目标>` 调用 app-server `thread/goal/set` 设置长期目标；`/goal` 调用 `thread/goal/get` 查看；`/goal pause` 和 `/goal resume` 通过 `thread/goal/set` 更新状态；`/goal clear` 调用 `thread/goal/clear` 清除目标。`clear` 表示退出当前 thread 的 Goal 追踪，但不关闭 `features.goals` 实验功能；该实验开关必须通过 Codex 官方 `/experimental` 或 config.toml 管理。

#### 3.3.1 Route Busy 期间的命令阻断

Codex turn 启动时，app-server adapter 会把权限策略、模型策略和 collaboration mode 作为 `turn/start` 参数发送给 Codex。turn 启动后再修改 `/permission`、`/model` 或 `/plan` 不会改写当前 turn，只会影响后续 turn。为了避免用户误判，也避免排队任务和 background goal turn 被中途改变语义，Bridge 需要在当前 route busy 时阻断执行语义修改命令。

busy 判定必须是 route 级，不是全局级。当前 route 满足以下任一条件时视为 busy：

- `routeWorkers.has(routeKey)`。
- 当前 route 有 background goal turn。
- 当前 route 的 active session 状态为 `running` 或 `waiting_approval`。
- 当前 route 存在 pending approval。
- 当前 route 已有普通 prompt 排队。

busy route 下允许的命令：

- 只读命令：`/help`、`/status`、`/sessions`、`/whoami`、`/debug`、`/permission`、`/model`、`/goal`。
- 运行控制命令：`/stop`、`/OK`、`/P`、`/NO`。
- 投递视图命令：`/progress brief|detailed|silent`，因为它只影响当前 route 的进度投递模式，不改变 Codex 执行语义。
- 普通文本不是命令；当当前 active turn 支持 mid-turn steer 时，优先投递到当前 turn。steer 不可用、失败或当前 turn 不可 steer 时，继续按当前 route 队列策略处理；入队时必须快照本轮 `sendFile` 和 collaboration mode。

busy route 下必须拒绝的命令：

- 会话绑定修改：`/new`、`/use`、`/resume`、会话编号选择。
- 权限修改：`/permission approval`、`/permission full confirm`。
- 模型修改：`/model <模型或编号> [effort]`、`/model effort <effort>`、`/model default`。
- 协作模式修改：`/plan`、`/code`、`/default`；带任务版本也拒绝，因为它会先修改 route 后续模式。
- Goal 修改：`/goal <目标>`、`/goal pause`、`/goal resume`、`/goal clear`。

拒绝提示应使用当前 route 语义，例如：

```text
当前对话的 Codex 正在执行，不能修改会话、权限、模型、协作模式或 Goal。
请等待完成，或发送 /stop 后再修改。
```

其他 route 不受影响。一个微信私聊或飞书私聊 busy 时，另一个 route 仍可修改自己的 session、权限、模型和 Goal。

#### 3.3.2 Busy Route 普通文本 mid-turn steer

Codex CLI/TUI 在 turn 运行中允许用户继续提交普通文本，这类输入不会开启新 turn，而是通过 app-server `turn/steer` 注入当前 active regular turn。Codex 会在下一次工具调用、工具结果或模型继续推理边界读取这些补充输入。Bridge 应保留这个体验，但必须保持 route/session 作用域清晰。

适用范围：

- 仅普通文本适用。slash command、会话选择编号、`/sendfile` 任务和其它会改变执行语义的输入不走 steer。
- 仅当前 `routeKey` 已绑定 active session，且 `CodexAdapter.steer(sessionId, text)` 可用时适用。
- 仅 active regular turn 适用。review、compact、无 active turn、turn id 竞态或 adapter 不支持 steer 时，必须回退到普通 route queue。
- steer 不接受权限、模型、sandbox、collaboration mode、Goal 等执行上下文覆盖，因此这些命令仍由 busy guard 阻断。

Bridge Core 负责统一行为，渠道 adapter 不直接调用 Codex steer：

1. `handleMessage()` 收到非命令普通文本。
2. 如果当前 route 不 busy，按现有 `enqueuePrompt()` 启动新 turn。
3. 如果当前 route busy，先尝试进入 route 级 steer buffer。
4. steer buffer 按 route 保序 drain；每次只允许一个 `steer()` 请求在途。
5. 投递成功后通过当前 ChannelTarget 发送确认，默认文案：

```text
已投递到当前 Codex 任务，会在下一次工具调用或模型继续推理时生效。
```

6. 投递失败、adapter 不支持或 active turn 已结束时，未投递文本按原始顺序转入普通 prompt 队列，并使用现有排队提示。

连续消息策略：

- 不能把用户连续发送的每条消息都立即并发调用 `turn/steer`。Bridge 必须对每个 route 维护独立 `steerQueue` 和 drain 状态，确保同一 route 内保序、串行投递。
- 可以设置短 debounce 窗口，例如 800-1500ms，把用户连续发送的多条普通文本合并成一个 steer payload。合并格式应保留消息边界，例如：

```text
用户补充消息 1:
...

用户补充消息 2:
...
```

- 需要设置批次上限，例如最多合并 5 条或 4000 字符；超过上限时继续拆成后续批次，仍按顺序慢慢投递。
- 确认消息应按批次聚合。单条成功回复“已投递到当前 Codex 任务...”；多条合并成功回复“已投递 3 条补充消息到当前 Codex 任务...”。这样微信、飞书等渠道不会因为连续输入产生大量确认消息。
- 如果 steer buffer 中还有等待投递的消息，`/status` 应展示“待投递补充消息”数量；已回退到普通 route queue 的消息仍展示在“排队消息”。
- `/stop` 应取消当前 route 未投递的 steer buffer，并按现有逻辑取消 active turn、清理普通 prompt 队列。已成功 steer 的文本已经进入 Codex 当前 turn，不能单独撤回。

失败与回退：

- `no active turn to steer`：说明 active turn 已结束或本地状态滞后，当前批次和后续 steer buffer 回退普通队列。
- `expected active turn id ... but found ...`：如果 adapter 能拿到新 active turn id，可重试一次；仍失败则回退普通队列。
- `ActiveTurnNotSteerable`：review/compact 等非 regular turn 不支持 steer，回退普通队列。
- 其它临时 app-server 错误：当前批次回退普通队列，并记录 warning；不能丢消息。

测试要求：

- app-server adapter 能把 `CodexAdapter.steer(sessionId, text)` 映射到 `turn/steer`，并携带当前 active turn id。
- Bridge 在 route busy 时普通文本优先 steer，成功后不进入普通 prompt 队列，并向当前渠道发送投递确认。
- 连续普通文本按 route 保序，短时间多条可合并成批次，确认消息按批次聚合。
- steer 失败时回退普通 route queue，顺序不能乱。
- route A busy 且收到普通文本 steer，不影响 route B 的普通 turn、命令、权限和模型操作。
- busy guard 仍阻断语义修改命令，确保 `/plan`、`/model`、`/permission`、`/goal clear` 不会误走 steer。

### 3.4 Codex Adapter

Codex 接入也需要抽象，避免早期选择的方案锁死项目。

对内接口：

```ts
type CodexAdapter = {
  stop?(): Promise<void>;
  startSession(input: StartSessionInput): Promise<CodexSession>;
  resumeSession(sessionId: string): Promise<CodexSession>;
  run(sessionId: string, prompt: string): AsyncIterable<CodexEvent>;
  steer?(sessionId: string, prompt: string): Promise<void>;
  cancel?(sessionId: string): Promise<void>;
  getStatus(sessionId: string): Promise<CodexSessionStatus>;
  listSessions(routeKey?: string): Promise<CodexSessionSummary[]>;
  resolveApproval?(approvalKey: string, decision: ApprovalDecision): Promise<void>;
  getRunPolicy?(): CodexRunPolicy;
  setRunPolicy?(policy: CodexRunPolicy): void;
  getRunPolicyStatus?(): CodexRunPolicyStatus;
};
```

Codex 状态统一为：

```ts
type CodexSessionStatus =
  | { type: "idle" }
  | { type: "running"; task?: string; turnId?: string }
  | { type: "waiting_approval"; detail?: string }
  | { type: "waiting_input"; detail?: string }
  | { type: "failed"; error: string }
  | { type: "unknown"; detail?: string };
```

### 3.5 运行形态和技术栈

项目使用 Node.js + TypeScript。

选择原因：

- `openclaw-weixin` 本身是 TypeScript/npm 包，复用和裁剪成本最低。
- Codex app-server 是 JSON-RPC/事件流，中间件主要是 I/O 和状态编排，Node 足够轻。
- TypeScript 便于复用协议类型和约束 adapter 接口。
- Go 或 Python 需要重新实现大量微信通道细节，尤其登录态、长轮询、context token、CDN 媒体和 typing，风险更高。

轻量约束：

- 不使用 NestJS、Next.js 等重框架。
- 不提供默认 Web 管理后台。
- 以终端 CLI 启动常驻进程。
- 日志输出到 stdout/stderr，同时可选写入本地文件。
- 状态存储优先 SQLite 或 JSON snapshot。

CLI 形态草案：

```bash
chat-codex start
chat-codex status
chat-codex weixin login
chat-codex test
```

其中 `weixin login` 由本项目的 Weixin Adapter 实现或包装 `openclaw-weixin` 的登录逻辑，不能调用 OpenClaw CLI。

## 4. `openclaw-weixin` 升级适配策略

`openclaw-weixin` 会继续更新，所以本项目不能把核心逻辑写死到当前包内部。

### 4.1 版本边界

当前本地包是 `2.4.4`，但设计上应保存：

- `installedVersion`
- `resolvedDistTag`
- `adapterVersion`
- `channelId`
- `capabilities`
- `sourcePackageSha256`

启动时记录这些信息，`/status` 管理员版也可以展示简化版本信息。

### 4.2 能力探测

不要只依赖版本号判断能力，应优先通过能力声明或运行时探测判断：

- 是否支持 direct chat。
- 是否支持 group chat。
- 是否支持 media。
- 是否支持 typing。
- 是否支持 block streaming。
- 是否支持 context token。
- 是否支持 accountId。

内部使用 `ChannelCapabilities`。当前代码里的基础能力包括：

```ts
type ChannelCapabilities = {
  text: boolean;
  media: boolean;
  typing: boolean;
  direct: boolean;
  group: boolean;
  thread: boolean;
  login: "none" | "qr" | "token" | "external";
  messageUpdate: boolean;
  streamingHint: boolean;
};
```

能力声明用于管理不同渠道适配方案：只支持私聊的渠道声明 `group=false, thread=false`；支持群聊或 thread 的渠道由 adapter 把平台原始消息映射到 `ChannelConversation.kind`。Bridge/ChannelRegistry 启动时应展示 capabilities，并在收到不支持的会话形态时拒绝或降级。capability 代表已验证运行能力，不代表平台协议里理论可能出现的字段。

### 4.3 Adapter 版本目录

未来可以按版本维护 adapter：

```text
src/channel/openclaw-weixin/
  index.ts
  adapter.ts
  versions/
    v2.ts
    legacy-v1.ts
  types.ts
```

`index.ts` 根据实际版本选择具体 adapter。第一阶段可以只实现 v2 adapter，但接口要保留 legacy 分支。

### 4.4 不直接修改 vendored 包

`openclaw-weixin-npm/` 下的包只作为归档和分析参考。

正式实现时应通过以下方式之一使用：

- 把 npm 包作为源码和协议参考。
- 从 npm 包中抽取底层微信 API、登录、发送、接收、媒体模块。
- 对 `openclaw/plugin-sdk` 依赖写最小 shim。
- 必要时复制少量稳定代码到 `src/weixin/vendor/` 并标注来源版本。
- 直接实现公开的微信 HTTP JSON API。

禁止方式：

- 不 patch 解压后的包作为长期方案。
- 不通过 OpenClaw CLI 安装或启用插件。
- 不调用 OpenClaw gateway。
- 不要求 OpenClaw host runtime。

不建议直接 patch 解压后的包；否则后续升级成本会很高。更好的方式是把需要的微信通讯能力收敛到 `src/weixin/` adapter，并为来源版本做记录。

## 4.5 未来其他渠道适配

后续适配其他渠道时，不允许复制 Bridge Core。

新渠道只需要新增：

```text
src/channels/<channel-id>/
  adapter.ts
  types.ts
  login.ts
  README.md
```

必须复用：

- Bridge Core。
- Command Router。
- Approval Manager。
- Codex Adapter。
- State Store。
- Logger。
- 测试报告规范。

这保证中间件是通用通讯层，而不是单独为微信写死的集成脚本。

## 5. Codex 接入技术方案

### 5.1 方案 A：`codex exec --json`

用 `codex exec --json` 为每次用户输入启动一次 Codex 非交互 run，并解析 JSONL 事件流。

优点：

- 最容易落地。
- 官方明确用于脚本和自动化。
- JSONL 里包含 `thread.started`、`turn.started`、`turn.completed`、`turn.failed`、`item.*`、`error` 等事件。
- 可用 `codex exec resume <session>` 延续已有 session。

缺点：

- 每次消息启动进程，长对话和高并发成本较高。
- 对实时 steering、审批、中断和状态查询支持有限。
- `/status` 只能依赖桥接层自己维护的运行状态，加上 JSONL 事件推断。
- 从源码看，exec 模式遇到 command execution、file change、permissions 等 server request approval 时会拒绝处理；因此它不适合实现“微信中批准/拒绝 Codex 操作”的完整体验。

适合作为非交互回退、诊断和最小链路验证方案。

当前实现状态：

- 已实现 `ExecCodexAdapter`。
- 已实现 `codex --version` 可用性检测。
- 已实现从 `$CODEX_HOME/state_5.sqlite`、`$CODEX_HOME/session_index.jsonl` 和 `$CODEX_HOME/sessions/**/*.jsonl` 发现历史会话，并优先展示 Codex 保存的标题或首条用户消息。
- 已实现 `terminal codex` 启动时先选会话、再选权限模式，并在启动摘要里显示本次会话、工作目录、权限和进度模式。
- 已用中间件真实调用 `codex exec --json` 并收到回复。
- `chat-codex` 启动入口已启用运行期 transcript：Bridge 收到微信消息、向微信发送回复、发送媒体，以及遇到被微信策略抑制的普通文本进度时，都会以彩色聊天记录样式同步打印到启动中间件的终端；被抑制的进度标记为“本地进度（未投递）”，默认非 TTY 输出保持纯文本，方便重定向日志。
- 已把 `codex exec --json` 中可见的 reasoning summary、命令、工具、文件变更等事件转换为通用 progress 事件；是否投递到具体渠道由 `ChannelDeliveryPolicy` 决定。

限制：

- `codex exec` 是非交互 CLI，能够设置审批/沙箱参数，但它不是完整 Codex 客户端协议。
- `codex exec --json` 能写入 Codex 历史会话，但不会把微信侧 turn 实时推送到另一个已经打开的 Codex CLI 或 Codex App 窗口；当前只能做到历史会话复用和后续恢复，不保证多端实时同屏。
- 要把 Codex 的 command/file/permissions approval request 完整转成微信 `/OK`、`/NO` 体验，必须使用 app-server adapter。
- 如果后续要实现“电脑端 Codex UI 与微信端同一会话实时可见”，应在 app-server 基础上增加观察端或事件订阅设计。

### 5.2 方案 B：`@openai/codex-sdk`

用官方 TypeScript SDK 在 Node 服务内控制 Codex thread。

优点：

- 比非交互 CLI 更适合嵌入应用。
- 可以 `startThread()`、`thread.run()`、重复 `run()` 延续同一 thread。
- 可以通过 thread ID 恢复历史 thread。
- 项目本身大概率会用 TypeScript，和 `openclaw-weixin` 技术栈更一致。

缺点：

- 需要引入新的 npm 依赖和版本管理。
- 需要确认 SDK 当前暴露的事件、状态、取消、审批能力是否满足微信客户端。

适合第一版稳定后升级为默认方案。

### 5.3 方案 C：`codex app-server`

启动 `codex app-server`，通过 JSON-RPC 2.0 与 Codex 通讯。

优点：

- 是深度集成方案。
- 支持 `thread/start`、`thread/resume`、`thread/fork`、`thread/read`、`thread/list`。
- 支持 `turn/start`、`turn/steer`、`turn/interrupt`。
- 支持 `turn/start.collaborationMode`，可用 true Plan mode 而不是通过 prompt 伪装规划模式。
- 能监听 `thread/status/changed`、`turn/*`、`item/*` 等事件。
- 支持审批请求和更完整的客户端状态同步。
- 支持 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval` 等 server request，可映射到微信审批命令。
- 可用 `codex app-server generate-ts` 或 `generate-json-schema` 生成与当前 Codex 版本匹配的协议 schema。

缺点：

- 协议复杂度更高。
- WebSocket 模式仍标注为实验/unsupported，第一阶段应优先 stdio。
- 需要实现 JSON-RPC client、请求 ID 管理、事件订阅、重连和背压。

适合做“完整微信客户端”，并已作为当前默认真实 Codex 接入方案。

当前实现状态：

- 已实现 `AppServerCodexAdapter` 初版，默认由 `chat-codex` 和 `terminal codex` 使用。
- 已实现 `codex app-server --listen stdio://` 子进程管理、JSON-RPC request/response、通知分发和停止清理。
- 已实现 `thread/start`、`thread/resume`、`turn/start`、`turn/interrupt`。
- 已实现 `/plan`、`/code` 到 `turn/start.collaborationMode` 的桥接；Plan mode completed plan item 会转成最终可投递结果，避免微信 progress suppressed 时看不到计划主体。
- 已实现实验 Goal API 桥接：`thread/goal/set`、`thread/goal/get`、`thread/goal/clear`，供微信侧 `/goal` 命令管理当前 thread 的长期目标。
- 已实现 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`，并兼容旧 `execCommandApproval`、`applyPatchApproval`。
- 已把 app-server 原始 request id 保存为内部 `adapterApprovalId`，微信用户只需要回复 `/OK` 或 `/NO`。

CLI JSONL adapter 继续保留为回退方案，不再作为完整审批主线。

### 5.4 方案 D：`codex mcp-server`

把 Codex 作为 MCP server 启动，让桥接服务作为 MCP client 调用 Codex。

优点：

- 协议边界清晰。
- 可作为工具生态的一部分。

缺点：

- 对“像 Codex 客户端一样管理会话、状态、审批、中断”的直接能力可能不如 app-server。
- 更适合把 Codex 暴露为工具，而不是做完整对话客户端。

不建议作为第一优先方案。

### 5.5 方案 E：`remote-control`

`codex remote-control` 是实验入口，可用于 headless app-server remote control。

优点：

- 方向上接近远程控制 Codex。

缺点：

- 实验能力，公开设计稳定性不足。
- 不适合作为第一阶段基础。

只作为后续评估项。

## 6. 推荐路线

### 第一阶段：Codex <-> 中间件

先实现：

- TypeScript CLI 项目骨架。
- Bridge Core。
- State Store。
- Logger。
- Command Router。
- 通用 Channel Adapter 协议。
- Mock Channel Adapter。
- Terminal Channel Adapter。
- Codex Adapter。
- 本地终端或 mock channel，用来模拟微信输入输出。
- `/new`、`/status`、`/OK`、`/NO`、`/stop`、`/permission` 的本地验证。
- 中文测试报告。

原因：

- 落地成本最低。
- 先把 Codex 会话、事件、审批、状态和日志打通。
- 不被微信登录和通道细节阻塞。
- 为后续接入真实 Weixin Adapter 留出稳定内部接口。

Codex Adapter 已从 CLI JSONL 验证链路升级为默认 app-server 接入；CLI JSONL 只保留为回退。

### 第二阶段：中间件 <-> Weixin Adapter

在接口不变的情况下新增：

- `WeixinAdapter`。
- 直接复用/裁剪 `openclaw-weixin` 的登录能力。
- 直接复用/裁剪 `getUpdates` 长轮询。
- 直接复用/裁剪 `sendMessage`。
- 保存微信账号状态和登录态。
- 把微信消息转换成 `ChannelMessage`。
- 把中间件输出发送回微信。
- 微信未登录时，提供明确登录入口和状态提示。

原因：

- 验证中间件和真实微信通道之间的通信。
- 仍然不引入 OpenClaw CLI 或 OpenClaw host。
- 第一版完成后由用户扫码/确认登录，并协助真实微信链路测试。

### 第三阶段：完整 Codex app-server adapter（初版已实现）

新增：

- `AppServerCodexAdapter`
- JSON-RPC stdio client。
- `thread/start`、`thread/resume`、`turn/start`、`turn/steer`、`turn/interrupt`。
- `thread/status/changed` 事件订阅。
- 审批请求转微信确认命令。
- 阶段性输出、命令审批、文件变更审批、权限审批全部映射到微信。

原因：

- 最适合实现接近完整 Codex 客户端的能力。
- `/status`、`/stop`、运行中追加输入、审批流都会更完整。

当前初版已覆盖 stdio JSON-RPC、thread start/resume、turn start/interrupt 和审批请求闭环；`turn/steer` 应作为下一步补齐普通文本 mid-turn 投递能力，更完整的 status changed 订阅、重连和背压属于后续硬化项。

### 第四阶段：长期运行和硬化

- 权限 allowlist。
- 日志脱敏。
- 重启恢复。
- 微信通道重连。
- Codex app-server 重连。
- Codex/app-server 主动取消或用户 `/stop` 后的 pending approval 清理。
- 版本升级检查。
- 测试报告归档和回归测试清单。

## 6.0 开发规范和测试报告

这是重点执行规范，详细要求见 `docs/development-and-test.zh-CN.md`。

核心要求：

- 代码必须按本文档架构分层，不允许把 Codex、渠道、命令、状态混在一个模块里。
- 模块拆分按职责边界、状态所有权、协议边界和测试边界判断，行数只作为 review 触发信号，不作为硬性拆分指标。
- 对超过 300-400 行的文件要检查是否职责过多；超过 600 行的业务文件应优先拆分，但类型声明、测试样例、声明式数据或内聚状态机可以保留，并记录理由和后续切分点。
- 以中文文档和中文测试报告为主。
- 每次功能实现都要自测。
- 每次自测都要在 `reports/tests/` 下留下报告。
- 如果某项真实微信测试需要用户登录才能完成，应先做 mock/local 测试并在报告中标明“待用户登录后补测”。
- 用户完成微信登录并协助测试后，需要补充真实通道测试报告。

## 6.1 Codex 源码参考工作流

本项目实现时必须把 `references/openai-codex/` 当成适配依据。

规则：

- 遇到 Codex 协议字段不确定，先查 `app-server-protocol`。
- 遇到 `codex exec --json` 事件不确定，先查 `exec/src/exec_events.rs`。
- 遇到审批行为不确定，先查 `app-server-protocol/src/protocol/v2/item.rs` 和 `app-server-test-client/src/lib.rs`。
- 遇到审批策略不确定，先查 `app-server-protocol/src/protocol/v2/shared.rs`。
- 遇到阶段性通知不确定，先查 `ServerNotification.ts` 和对应 v2 notification 类型。
- 参考源码只作为设计和实现依据，不直接修改。
- 升级 Codex 参考仓库时，需要记录 commit、日期和影响点。

## 7. `/new` 设计

内部流程：

1. Command Router 识别 `/new`。
2. Bridge Core 校验当前微信上下文权限。
3. 查询当前 routeKey 的 active Codex session。
4. 如果旧 session 正在运行：
   - CLI 阶段：默认不取消旧进程，提示“旧任务仍在运行”或排队处理。
   - app-server 阶段：可支持 `turn/interrupt` 后再新建。
5. Codex Adapter 创建新 session。
6. State Store 保存 routeKey -> sessionId。
7. 微信返回新 session 状态。

建议返回：

```text
已创建新 Codex 会话
Session: cdx-xxxx
Cwd: /path/to/project
Status: idle
```

## 8. `/status` 设计

`/status` 使用 Markdown 文本返回，主要由三部分合成：

- Bridge Core 状态。
- Channel Adapter 状态。
- Codex Adapter 状态，包括模型信息、reasoning effort，以及 app-server `thread/tokenUsage/updated` 提供的 token 用量。`tokenUsage.total` 是累计 API 用量，不能当作当前上下文窗口占用；`/status` 用 `tokenUsage.last` 近似当前窗口，并把累计量单独展示为“本会话累计 token”。“最近一轮 token”的输出是最近一次 token usage 更新里的输出 token，累计输出看“本会话累计 token”的输出。

普通用户输出（微信 2.4.4 默认 silent 状态）：

```md
**Codex 状态**

**会话**
- 当前会话: `cdx-8f2a`
- 运行状态: 运行中（轮次 `exec-turn-123`，任务: 修复测试）
- 当前模型: `gpt-5.1-codex`（服务商 `openai`，思考程度 `medium`）
- 上下文: `164,171 / 258,400 token`（63.5%，剩余 94,229）
- 最近一轮 token: 输入 `160,000`，缓存 `120,000`，输出 `4,171`，推理输出 `1,200`
- 本会话累计 token: 总计 `34,375,973`，输入 `34,282,029`，缓存 `33,213,184`，输出 `93,944`，推理输出 `30,181`
- 工作目录: `/path/to/project`

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

管理员输出（微信 2.4.4 默认 silent 状态）：

```md
**Codex 状态**

**会话**
- 当前会话: `cdx-8f2a`
- 运行状态: 运行中
- 当前模型: `gpt-5.1-codex`（服务商 `openai`，思考程度 `medium`）
- 上下文: `164,171 / 258,400 token`（63.5%，剩余 94,229）
- 最近一轮 token: 输入 `160,000`，缓存 `120,000`，输出 `4,171`，推理输出 `1,200`
- 本会话累计 token: 总计 `34,375,973`，输入 `34,282,029`，缓存 `33,213,184`，输出 `93,944`，推理输出 `30,181`
- 工作目录: `/path/to/project`

**运行**
- 处理状态: 正在处理
- 排队消息: `0`
- 待审批: `0`
- 进度投递: 静默模式
- 权限模式: 审批模式（沙箱 `workspace-write`）

**渠道**
- 渠道: `openclaw-weixin`
- 连接状态: 已连接
- 最近错误: 无
```

`/status` 是命令消息，不进入普通 prompt 队列；Codex 正在执行时也应立即回复。“处理状态”来自 Bridge route worker，“运行状态”来自 Codex Adapter 状态，二者结合用于判断是否可用 `/stop`。微信账号、发送者、conversation 等身份信息不放入 `/status`，需要时用 `/whoami` 查看。

## 8.0.1 `/stop` 设计

`/stop` 只终止当前微信上下文绑定的 Codex 正在处理任务，不退出 Bridge，也不删除 Codex 会话绑定。

- 对 CLI exec adapter：记录当前子进程，收到 `/stop` 后向该进程发送 `SIGTERM`，2 秒后仍未退出则 `SIGKILL`。
- 对 app-server adapter：映射到 `turn/interrupt`。
- `/stop` 不清空后续已排队普通消息，队列仍按顺序继续处理。

## 8.0.2 微信权限模式切换

`/permission` 用于在微信侧查看和切换后续 Codex turn 的运行权限：

- `/permission`：显示当前绑定 Codex session 的权限模式；没有绑定 session 时显示默认权限。
- `/permission approval`：把当前绑定 Codex session 切回 `workspace-write` sandbox。默认 app-server adapter 会在该 session 后续 turn 使用 `approvalPolicy=on-request` 和 `approvalsReviewer=user`，审批请求会推送到微信；exec 回退模式仍是非交互审批。
- `/permission full confirm`：把当前绑定 Codex session 切到完全权限，使用 `--dangerously-bypass-approvals-and-sandbox`。必须带确认词，避免误触。没有绑定 session 时修改后续新会话的默认权限。

权限模式切换只影响后续 turn，不热改写当前正在运行的 Codex turn；需要立即应用时先 `/stop`。

## 8.1 Codex 批准流设计

微信必须成为 Codex 审批请求的交互入口。

### 8.1.1 适配基础

app-server 协议中，审批以 server request 形式发给客户端。桥接服务要接收这些请求，生成待审批记录，发送微信消息，并等待微信命令返回决策。

需要处理的请求：

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- 兼容旧协议的 `execCommandApproval`
- 兼容旧协议的 `applyPatchApproval`

`codex exec --json` 不作为完整审批实现方案，因为源码中 exec 模式会拒绝 command execution、file change、permissions 等 approval request。

### 8.1.2 审批记录模型

```ts
type PendingApproval = {
  approvalKey: string;
  requestId: string;
  type: "command" | "file_change" | "permissions" | "network" | "legacy_exec" | "legacy_patch";
  threadId: string;
  turnId: string;
  itemId: string;
  routeKey: string;
  requestedBy: string;
  command?: string;
  cwd?: string;
  reason?: string;
  risk?: "low" | "medium" | "high" | "unknown";
  availableDecisions: string[];
  expiresAt?: string;
  raw: unknown;
};
```

`approvalKey` 必须短、稳定，便于日志、调试和 adapter 内部定位；它不作为普通微信用户的操作入口。内部仍保存原始 `requestId`、`approvalId`、`threadId`、`turnId` 和 `itemId`。

### 8.1.3 微信审批消息格式

命令执行审批示例：

```text
Codex 请求执行命令
Thread: cdx-8f2a
CWD: codex-openclaw-wechat
Command:
git status
Reason: inspect workspace state

快捷回复：
/OK
/NO
```

高风险命令必须显示风险提示：

```text
风险: high
原因: 可能修改或删除文件
```

### 8.1.4 微信决策命令映射

命令执行审批：

- `/OK` -> `accept`
- `/NO` -> `decline`
- `/stop` -> 终止当前 turn

文件变更审批：

- `/OK` -> `accept`
- `/NO` -> `decline`
- `/stop` -> 终止当前 turn

权限审批：

- `/OK` -> 只批准请求的最低权限和当前 turn scope。
- `/NO` -> 返回最小或空权限。
- `/stop` -> 返回拒绝并尝试中断当前 turn。

审批 ID 是内部兼容字段，不作为普通微信用户操作入口；`/OK`、`/NO` 只作用于当前 `routeKey` 最新的 pending approval。app-server adapter 会用原始 request id 回写 JSON-RPC response；exec 回退模式没有完整审批协议。

审批通知是关键消息，不按普通进度消息处理。Bridge 收到 `approval.requested` 后必须先创建 pending approval，再把审批提示投递到当前 `routeKey`；如果通道发送失败，例如微信 `sendmessage ret=-2`，Bridge 会按固定间隔持续重试，直到审批提示至少送达一次。若用户在重试期间已经通过 `/OK`、`/NO` 或 `/stop` 处理了该 pending approval，重试循环立即停止，避免已处理审批再次弹出。

网络或 exec policy 持久化放行：

- 默认不通过普通 `/OK` 自动接受持久化策略。
- 如果 Codex 提供 `proposedExecpolicyAmendment` 或 `proposedNetworkPolicyAmendments`，微信中必须明确展示“持久放行”。
- 后续可设计 `/approve-policy <id>`，仅管理员可用。

### 8.1.5 审批生命周期和状态

要求：

- Bridge 默认不设置本地审批 TTL，不会因为用户长时间未操作就让 `/OK`、`/P`、`/NO` 失效。
- app-server pending request 的生命周期由用户决策、`/stop`、Codex/app-server 主动取消或进程结束驱动。
- 如果未来启用本地 TTL，过期时必须同步向 Codex adapter 回写 `cancel` 或 `decline`，不能只从 Bridge pending 列表里移除。
- `/status` 要展示 pending approvals 数量。
- 同一 routeKey 同时有多个审批时，`/OK`、`/NO` 默认处理最新一条；普通用户不需要输入 ID。
- 只有原微信上下文或管理员可以响应该审批。
- 审批完成后要发送结果确认。

## 8.2 阶段性回复和流式输出设计

Codex 输出不是只有最终文本。Bridge 会把 Codex 事件转换成通用 progress 事件；是否投递到具体聊天渠道由 `ChannelDeliveryPolicy` 决定。

### 8.2.1 事件来源

CLI JSONL adapter 可用事件：

- `thread.started`
- `turn.started`
- `item.started`
- `item.updated`
- `item.completed`
- `turn.completed`
- `turn.failed`
- `error`

当前 CLI JSONL adapter 的阶段性输出（当前主干里非微信渠道会按投递模式发送；微信渠道会在 Bridge 层丢弃 task-start 和 progress）：

- `turn.started`：非微信渠道由 Bridge 发送简短“Codex 正在处理这条消息”提示，不在每次任务开始时重复刷 Session ID；微信渠道不发送这条提示。
- `item.completed` + `reasoning`：发送普通文本进度，内容为 Codex 提供的 reasoning summary；兼容 `summary`、`summary_text`、顶层 `codex_thinking` 等不同 JSONL 形态。
- `item.updated` + `plan_update`：发送计划更新，归类为 brief 模式可见的自言自语/计划进度。
- `item.started/completed` + `command_execution`：发送命令开始或完成摘要；命令输出中的图片或文件路径只作为进度文本，不触发媒体发送。
- `item.completed` + `file_change`：发送文件变更摘要。
- `mcp_tool_call`、`web_search`、`todo_list`：发送工具、搜索或计划摘要。

Bridge 会把进度事件标记为 `reasoning`、`todo`、`search`、`file_change`、`command`、`tool` 等类别，并按投递模式过滤：

- `brief`：默认模式，只投递计划/自言自语、搜索和文件变更摘要，不投递命令/工具细节。
- `detailed`：调试模式，投递全部可见进度，包括命令开始/完成和工具调用。
- `tools`：只投递结构化工具生命周期，不投递普通文本进度；仅在渠道策略 `toolProgress: "send"` 时有实际输出。
- `silent`：安静模式，不投递进度文本，也不投递结构化工具生命周期；仍会发送审批、错误、安全通知、命令回复、`request_user_input` 和最终回复。文件发送只由 `/sendfile` 单次授权触发，不归 progress 模式控制。

非微信渠道可通过 `/progress [brief|detailed|silent]` 为当前 route 调整普通文本进度模式；微信 2.4.4 实验分支支持 `/progress [brief|detailed|tools|silent]`，默认持久模式为 `silent`。CLI 可通过 `--progress brief|detailed|tools|silent` 设置默认模式，其中 `tools` 仅在支持结构化工具生命周期的渠道有效。微信专用 `/fff` 是静默刷新命令，不回复、不入队、不转发给 Codex。

app-server adapter 可用事件：

- `thread/status/changed`
- `thread/tokenUsage/updated`
- `turn/started`
- `turn/completed`
- `turn/diff/updated`
- `turn/plan/updated`
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `item/plan/delta`
- `item/reasoning/summaryTextDelta`
- `item/reasoning/summaryPartAdded`
- `command/exec/outputDelta`
- `item/commandExecution/outputDelta`
- `item/fileChange/patchUpdated`
- `serverRequest/resolved`

其中 `thread/tokenUsage/updated` 会更新当前 session 的上下文 token 用量，供 `/status` 展示。`agentMessage.phase=commentary` 的消息视为阶段性 commentary 更新，转成 `assistant.progress`；`phase=final_answer` 或缺省 phase 按兼容路径进入最终回复。Plan mode 下 completed `item.type=plan` 除继续生成 `todo` progress 外，还会转成 `assistant.plan`，由 Bridge 作为最终可投递内容处理。`item/reasoning/textDelta` 默认通过 `optOutNotificationMethods` 关闭，避免把 raw reasoning 推送到聊天通道。

### 8.2.2 微信发送策略

微信不适合逐 token 或高频连续发送。微信 2.4.4 实验分支的策略是保留关键消息，同时按 route 进度模式控制普通文本 progress 和结构化工具生命周期：

- task-start 不发送到微信。
- 默认持久模式为 `silent`：不发送普通文本进度，也不发送 `TOOL_CALL_START/TOOL_CALL_RESULT`。
- `/progress brief` 发送摘要普通文本进度，不发送结构化工具生命周期。
- `/progress detailed` 发送完整可见文本进度，并发送结构化工具生命周期。
- `/progress silent` 不发送普通文本进度，也不发送结构化工具生命周期。
- `/plan` turn 可以临时使用 detailed effective mode，发送计划过程和结构化工具生命周期，但不改 route 持久化配置；如果 route 为 `silent`，仍保持静默。
- Plan mode 的最终 `assistant.plan` 会作为关键最终内容发送，不受 progress 模式影响。
- final answer、turn failed/error、审批提示、审批处理结果、队列提示、媒体发送结果和用户主动命令回复仍发送。
- `/fff` 在微信中静默处理，作为用户主动入站触发，不产生回复。
- 非微信渠道仍按自身 delivery policy 投递 progress，默认不理解微信 `TOOL_CALL_START/RESULT`。
- 普通消息、阶段性输出和最终回复里的路径默认只当文本，不自动发送媒体。用户发送 `/sendfile <任务内容>` 时，Bridge 会给该 turn 追加内部协议提示，只在最终回复中解析 `BRIDGE_SEND_FILE: /absolute/path/to/file`，每轮最多发送 3 个文件，并从用户可见最终文本中移除协议行。若媒体上传失败，只发送一条聚合失败摘要，不逐个文件刷 fallback 文本。
- Codex 运行期间启用微信 typing：`getconfig` 获取 ticket，`sendtyping` 周期续发；turn 完成、失败或 `/stop` 后停止 typing。
- `WeixinAdapter` 出站发送采用单队列串行和最小发送间隔，降低连续消息在微信侧丢显或乱序的概率。
- `sendmessage`、`getuploadurl` 的 HTTP 200 不直接视为成功；若 JSON 里 `ret/errcode` 非 0，会抛错并更新通道 `lastError`，避免终端 transcript 把失败请求打印成成功 OUT。
- 终端 transcript 默认使用一行方向摘要加缩进消息体，例如 `微信 <= Alice | direct:...` 和 `微信 => direct:... | 进度`；TTY 下用颜色区分用户入站、Codex 回复、进度、审批、错误和媒体，完整 route/sender 只在 verbose 模式下展示。
- WeixinAdapter 对 `sendmessage` 串行排队，默认最小发送间隔为 1200ms；遇到 45009 等限流错误、429/5xx 或临时网络错误时按退避重试，最终失败才更新通道 `state=degraded` 和 `lastError`。
- 文本、图片和文件发送采用直接投递模型，会携带当前入站消息的 `context_token`；如果带 token 的发送因 `ret=-2` 最终失败，保留去掉 token 再试一次的 fallback。

### 8.2.3 用户可见模式

普通模式：

- 开始处理。
- 等待批准。
- 关键命令摘要。
- 最终回复。
- 错误或中断。

详细模式：

- `/debug on` 后展示更多 Codex event。
- 显示 item started/completed。
- 显示 command output 摘要。
- 显示 token usage 或耗时。

### 8.2.4 与 `openclaw-weixin` 通讯能力的关系

当前 `openclaw-weixin` 包声明 `blockStreaming` 能力，并有 block streaming 合并默认值。桥接层也应做自己的 coalescing，避免上游或下游任一侧升级后造成微信刷屏。

如果后续 `openclaw-weixin` 支持消息编辑或更细粒度 streaming，再在 Channel Adapter 中增加能力，不改变 Codex Adapter。

## 9. 状态持久化

建议使用文件型 SQLite 或 JSONL + JSON snapshot。第一阶段可用 SQLite，避免后续查询 session 列表困难。

核心表：

- `bindings(route_key, session_id, channel, account_id, peer_id, created_at, updated_at)`
- `sessions(session_id, codex_backend, cwd, status, created_at, updated_at, last_error)`
- `messages(message_id, route_key, direction, text_hash, created_at, delivery_status)`
- `events(id, kind, payload_json, created_at)`

## 10. 风险和约束

- 微信侧不是天然可信入口，必须默认 allowlist。
- Codex 能读写本地工作区，权限策略必须显式配置。
- CLI adapter 的中断和实时状态能力有限。
- app-server WebSocket 不应暴露到公网；如需远程连接，应使用 localhost、SSH 转发、VPN 或 mesh 网络。
- `openclaw-weixin` 当前包声明 direct chat，群聊能力需要后续实际验证。
- 不能依赖 `openclaw-weixin` 内部文件路径作为长期 API。

## 11. 参考资料

- OpenAI Codex Non-interactive mode: https://developers.openai.com/codex/noninteractive
- OpenAI Codex SDK: https://developers.openai.com/codex/sdk
- OpenAI Codex App Server: https://developers.openai.com/codex/app-server
- OpenAI Codex MCP: https://developers.openai.com/codex/mcp
- OpenAI Codex Remote connections: https://developers.openai.com/codex/remote-connections
- 本地参考源码获取说明：`references/README.md`
