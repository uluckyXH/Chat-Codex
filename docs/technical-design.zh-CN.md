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

本地已归档 `@tencent-weixin/openclaw-weixin@2.4.3`：

- `openclaw-weixin-npm/tencent-weixin-openclaw-weixin-2.4.3.tgz`
- `openclaw-weixin-npm/extracted/openclaw-weixin-2.4.3/`

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

本地已拉取 OpenAI Codex 官方开源仓库作为参考：

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
        +--> Command Router (/new, /status, /help, /cancel...)
        +--> Approval Manager (/approve, /deny, /cancel)
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

当前第一阶段实现状态：

- `MockChannelAdapter` 用于自动化测试。
- `TerminalChannelAdapter` 用于本地 CLI 交互和管道测试，模拟微信输入输出。
- `WeixinAdapter` 已进入第二阶段初版：二维码登录 API、登录确认轮询、账号 token 文件存储、文本 `sendmessage`、入站消息映射已经实现并通过 fake-fetch 测试。
- 真实微信扫码登录、`getupdates` 长轮询闭环和真实微信收发需要用户后续协助测试。
- `MockCodexAdapter` 用于稳定测试审批、阶段性事件和命令。
- `ExecCodexAdapter` 已具备解析 `codex exec --json` 的基础能力，真实 Codex CLI 联调作为下一步硬化项。

## 3.0 通用渠道协议

这是重点设计：中间件核心不能对死 `openclaw-weixin`。`openclaw-weixin` 是第一条渠道实现，但 Bridge Core 必须只依赖通用渠道协议。

### 3.0.1 设计原则

- Bridge Core 不 import `openclaw-weixin` 类型。
- Command Router 不 import `openclaw-weixin` 类型。
- Approval Manager 不 import `openclaw-weixin` 类型。
- 具体渠道差异只存在于 `src/channels/<channel>/`。
- 新渠道接入时，只要实现 `ChannelAdapter` 即可复用 Codex Adapter、命令、审批、状态和日志。

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
  login: "none" | "qr" | "token" | "external";
  messageUpdate: boolean;
  streamingHint: boolean;
};
```

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
- 参考 `openclaw-weixin@2.4.3` 的 HTTP JSON API，直接实现 `get_bot_qrcode`、`get_qrcode_status`、`getupdates`、`sendmessage`、`notifystart`、`notifystop` 的薄客户端。
- 登录轮询支持 `need_verifycode` 分支；CLI 会提示输入手机微信显示的配对数字后继续轮询。
- 登录 token 默认保存在项目根目录下 `state/weixin/`，该目录被 Git 忽略。
- 账号 ID 会做文件名安全归一化，例如 `abc@im.bot` 归一化为 `abc-im-bot`。
- `context_token` 会从微信入站消息带入 `ChannelTarget.context.contextToken`，发送回复时回传给 `sendmessage`。

它不负责：

- Codex session 管理。
- `/new`、`/status`、`/approve` 等命令含义。
- Codex 审批决策。
- 业务状态持久化。

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
- `/cancel`
- `/sessions`
- `/use <session>`
- `/resume`
- `/whoami`
- `/debug`
- `/approve <id>`
- `/approve-session <id>`
- `/deny <id>`

命令处理结果直接通过 Channel Adapter 回复微信，不进入 Codex。

### 3.4 Codex Adapter

Codex 接入也需要抽象，避免早期选择的方案锁死项目。

对内接口：

```ts
type CodexAdapter = {
  startSession(input: StartSessionInput): Promise<CodexSession>;
  resumeSession(sessionId: string): Promise<CodexSession>;
  run(sessionId: string, prompt: string): AsyncIterable<CodexEvent>;
  steer?(sessionId: string, prompt: string): Promise<void>;
  cancel?(sessionId: string): Promise<void>;
  getStatus(sessionId: string): Promise<CodexSessionStatus>;
  listSessions(routeKey: string): Promise<CodexSessionSummary[]>;
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
codex-wechat-bridge start
codex-wechat-bridge status
codex-wechat-bridge weixin login
codex-wechat-bridge codex test
```

其中 `weixin login` 由本项目的 Weixin Adapter 实现或包装 `openclaw-weixin` 的登录逻辑，不能调用 OpenClaw CLI。

## 4. `openclaw-weixin` 升级适配策略

`openclaw-weixin` 会继续更新，所以本项目不能把核心逻辑写死到当前包内部。

### 4.1 版本边界

当前本地包是 `2.4.3`，但设计上应保存：

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

内部使用 `ChannelCapabilities`：

```ts
type ChannelCapabilities = {
  text: boolean;
  media: boolean;
  typing: boolean;
  direct: boolean;
  group: boolean;
  contextToken: boolean;
  multiAccount: boolean;
};
```

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

适合第一阶段最小可用版本。

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
- 能监听 `thread/status/changed`、`turn/*`、`item/*` 等事件。
- 支持审批请求和更完整的客户端状态同步。
- 支持 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval` 等 server request，可映射到微信审批命令。
- 可用 `codex app-server generate-ts` 或 `generate-json-schema` 生成与当前 Codex 版本匹配的协议 schema。

缺点：

- 协议复杂度更高。
- WebSocket 模式仍标注为实验/unsupported，第一阶段应优先 stdio。
- 需要实现 JSON-RPC client、请求 ID 管理、事件订阅、重连和背压。

适合中长期做“完整微信客户端”。

如果项目目标强调“完全对接微信通讯渠道”，app-server adapter 应作为最终主线方案；CLI JSONL adapter 只作为第一阶段验证链路的过渡方案。

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
- `/new`、`/status`、`/approve`、`/deny`、`/cancel` 的本地验证。
- 中文测试报告。

原因：

- 落地成本最低。
- 先把 Codex 会话、事件、审批、状态和日志打通。
- 不被微信登录和通道细节阻塞。
- 为后续接入真实 Weixin Adapter 留出稳定内部接口。

Codex Adapter 可以先从 CLI JSONL 开始，但只用于验证普通消息和事件流。涉及审批的目标实现应尽早转向 app-server adapter。

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

### 第三阶段：完整 Codex app-server adapter

新增：

- `CodexAppServerAdapter`
- JSON-RPC stdio client。
- `thread/start`、`thread/resume`、`turn/start`、`turn/steer`、`turn/interrupt`。
- `thread/status/changed` 事件订阅。
- 审批请求转微信确认命令。
- 阶段性输出、命令审批、文件变更审批、权限审批全部映射到微信。

原因：

- 最适合实现接近完整 Codex 客户端的能力。
- `/status`、`/cancel`、运行中追加输入、审批流都会更完整。

### 第四阶段：长期运行和硬化

- 权限 allowlist。
- 日志脱敏。
- 重启恢复。
- 微信通道重连。
- Codex app-server 重连。
- pending approval 超时处理。
- 版本升级检查。
- 测试报告归档和回归测试清单。

## 6.0 开发规范和测试报告

这是重点执行规范，详细要求见 `docs/development-and-test.zh-CN.md`。

核心要求：

- 代码必须按本文档架构分层，不允许把 Codex、渠道、命令、状态混在一个模块里。
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
Status: idle
```

## 8. `/status` 设计

`/status` 由三部分合成：

- Bridge Core 状态。
- Channel Adapter 状态。
- Codex Adapter 状态。

普通用户输出：

```text
Codex: running
WeChat: connected
Session: cdx-8f2a
Last: 00:41
Task: processing
```

管理员输出：

```text
Bridge: ok
Channel: openclaw-weixin 2.4.3, connected
Codex: app-server, running
Session: cdx-8f2a
Route: wx:account:peer -> cdx-8f2a
Last inbound: 00:41
Last outbound: 00:40
Last error: none
```

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
  expiresAt: string;
  raw: unknown;
};
```

`approvalKey` 必须短、稳定、适合微信输入，例如 `a7k3`。内部仍保存原始 `requestId`、`approvalId`、`threadId`、`turnId` 和 `itemId`。

### 8.1.3 微信审批消息格式

命令执行审批示例：

```text
Codex 请求执行命令 [a7k3]
Thread: cdx-8f2a
CWD: codex-openclaw-wechat
Command:
git status
Reason: inspect workspace state

回复：
/approve a7k3
/approve-session a7k3
/deny a7k3
/cancel a7k3
```

高风险命令必须显示风险提示：

```text
风险: high
原因: 可能修改或删除文件
```

### 8.1.4 微信决策命令映射

命令执行审批：

- `/approve <id>` -> `accept`
- `/approve-session <id>` -> `acceptForSession`
- `/deny <id>` -> `decline`
- `/cancel <id>` -> `cancel`

文件变更审批：

- `/approve <id>` -> `accept`
- `/approve-session <id>` -> `acceptForSession`
- `/deny <id>` -> `decline`
- `/cancel <id>` -> `cancel`

权限审批：

- `/approve <id>` -> 只批准请求的最低权限和当前 turn scope。
- `/approve-session <id>` -> 需要管理员权限，批准 session scope。
- `/deny <id>` -> 返回最小或空权限。
- `/cancel <id>` -> 返回拒绝并尝试中断当前 turn。

网络或 exec policy 持久化放行：

- 默认不通过 `/approve-session` 自动接受持久化策略。
- 如果 Codex 提供 `proposedExecpolicyAmendment` 或 `proposedNetworkPolicyAmendments`，微信中必须明确展示“持久放行”。
- 后续可设计 `/approve-policy <id>`，仅管理员可用。

### 8.1.5 审批超时和状态

要求：

- 默认审批超时，例如 10 分钟。
- 超时后自动 `decline` 或 `cancel`，策略可配置。
- `/status` 要展示 pending approvals 数量和最近一个审批短 ID。
- 同一 routeKey 同时有多个审批时，必须逐个编号。
- 只有原微信上下文或管理员可以响应该审批。
- 审批完成后要发送结果确认。

## 8.2 阶段性回复和流式输出设计

Codex 输出不是只有最终文本。微信桥接要把 Codex 事件转换成适合微信阅读的进度消息。

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

app-server adapter 可用事件：

- `thread/status/changed`
- `turn/started`
- `turn/completed`
- `turn/diff/updated`
- `turn/plan/updated`
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `item/plan/delta`
- `item/reasoning/summaryTextDelta`
- `command/exec/outputDelta`
- `item/commandExecution/outputDelta`
- `item/fileChange/patchUpdated`
- `serverRequest/resolved`

### 8.2.2 微信发送策略

微信不适合逐 token 发送。需要节流和合并：

- agent message delta 每 2 到 5 秒或累计 300 到 800 字发送一次。
- reasoning summary 默认不发送给普通用户，只在 debug 或管理员模式发送摘要。
- command output 默认只发送开始、结束、失败和最后若干行摘要。
- 文件变更默认发送文件列表摘要，不直接发送完整 diff。
- turn 完成后发送最终结果，并标记为“完成”。
- turn 失败或中断时发送明确状态。

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
- 本地归档包：`openclaw-weixin-npm/extracted/openclaw-weixin-2.4.3/`
