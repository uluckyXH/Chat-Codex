# 多渠道接入与会话绑定设计

## 1. 目标

当前项目已经通过通用 `ChannelAdapter` 协议接入微信。多渠道阶段的目标是在不把 Bridge Core 重新写死到某个渠道的前提下，让微信、飞书、终端和后续可选渠道可以在同一个中间件进程里同时工作。

结论：

- 可以支持多渠道同时对话。
- 多渠道同时对话不等于多个渠道共享同一个 Codex session。
- Codex session 必须有唯一归属：一个 session 一旦绑定到某个 route，就不能再被另一个 route 绑定。
- 由于 routeKey 包含 `channelId`，`sessionId -> ownerRouteKey` 可以满足“一个 session 只能绑定一个渠道”的需求，并且比只绑定渠道更严格。
- 同一个渠道可以有多个会话上下文，每个上下文各自绑定不同 Codex session。
- 同一个 route 可以拥有多个历史 session，但同一时刻只有一个 active session。

这里的 route 指一个标准化聊天上下文，而不是单纯的渠道类型。例如一个微信私聊、一个微信群、一个飞书 thread、一个终端会话都是不同 route。

### 1.1 设计理念

中间件两侧边界必须清晰：

- Codex 侧只通过 `CodexAdapter` 交互，Bridge Core 面向 Codex thread/session/turn，不关心消息来自微信、飞书还是终端。
- 渠道侧只通过 `ChannelAdapter` 交互，Bridge Core 面向 `ChannelMessage`、`ChannelTarget`、`ChannelCapabilities` 和 `ChannelDeliveryPolicy`，不直接引用具体平台原始字段。
- 不同渠道的登录、收消息、发消息、群聊/thread 映射、消息编辑、typing、卡片、限流和重试都属于 adapter-owned 行为。
- Bridge Core 只做通用路由、队列、session binding、审批、权限和 Codex turn 调度。
- 新增渠道时优先扩展 adapter、capabilities 和 delivery policy，不在 Bridge Core 增加 `if channel === "xxx"`。

因此，多渠道不是让每个渠道各自直连 Codex，而是所有渠道先进中间件通用协议，再由中间件统一路由到 Codex session。

## 2. 术语

- 渠道类型：`weixin`、`lark`、`terminal` 等实现类别。
- 渠道实例：运行时启动的一个 adapter 实例，例如 `weixin-main`、`lark-work`。多账号场景下，同一渠道类型可以有多个实例。
- 账号：渠道侧的机器人账号或登录账号，例如微信登录账号、飞书 bot。
- 会话上下文：渠道里的私聊、群聊、thread 或 channel。
- routeKey：Bridge Core 用来标识会话上下文的稳定 key。
- Codex session：Codex app-server 或 CLI 侧的 thread/session。
- active binding：某个 route 当前正在使用的 Codex session。
- session owner：某个 Codex session 的唯一归属 route。

## 3. Route Key 规则

所有渠道继续使用统一 route key：

```text
<channelId>:<accountId>:<conversationKind>:<conversationId>
```

多渠道阶段需要收紧一个约束：`channelId` 必须是运行时唯一的渠道实例 ID，而不只是渠道类型。

示例：

```text
weixin-main:wx-account-1:direct:user-123
weixin-main:wx-account-1:group:group-456
lark-work:lark-bot-1:thread:thread-789
terminal-local:default:direct:terminal
```

如果一个进程只启动一个微信账号，可以继续使用当前的 `weixin` 作为 `channelId`。如果未来同进程启动多个微信账号，必须配置为 `weixin-main`、`weixin-alt` 这类不同实例 ID，避免出站路由无法判断消息应该发给哪个 adapter。

### 3.1 ConversationKind 语义

`conversationKind` 只描述渠道侧会话上下文的形态，不改变 Bridge 的核心并发规则。

- `direct`：私聊或一对一会话。`conversationId` 通常是对端用户 ID。
- `group`：群聊、频道或聊天室。`conversationId` 是群、频道或房间 ID。
- `thread`：支持 thread 的平台里的具体主题串，例如飞书 thread。`conversationId` 是 thread ID。

`direct`、`group`、`thread` 都是 route。普通 prompt 的新 turn 按 route 串行：同一个私聊、同一个群聊或同一个 thread 同时只运行一个 Codex turn。Codex app-server 支持 mid-turn steer 时，运行中收到的普通文本可以先投递到当前 active turn；不支持或失败时再回退到普通队列。

群聊和私聊的差异主要在身份和权限上，而不是并发上：群聊 route 里可能有多个 sender，但它们共享同一个 `routeKey` 和 active session；`sender.id` 用于审计、权限判断和审批来源记录，不应该默认进入 route key。否则同一个群里不同人会被拆成多个 Codex 上下文，失去群聊共享上下文的语义。

群聊消息转给 Codex 时应保留发言人身份，让 Codex 能理解“谁在说话”。优先使用渠道 adapter 提供的 `sender.displayName`，没有昵称时使用 `sender.id`。推荐在 Bridge 组装 prompt 时对群聊或 thread 消息增加轻量前缀，例如：

```text
[小秀] 请看一下这个报错
```

这个前缀只影响发给 Codex 的 prompt，不改变 routeKey、审批作用域或出站投递目标。

当前微信真实适配以私聊为主；微信消息协议里保留 `group_id` 映射到 `group` 的能力，但群聊链路需要后续真实验证。飞书等后续渠道如果天然支持群聊和 thread，应按平台能力选择 `group` 或 `thread`，不要为了并发把同一个实际聊天上下文拆成多个 route。

### 3.2 渠道能力声明

当前通用协议已经有 `ChannelAdapter.getCapabilities()`，用于声明某个 adapter 实例实际支持的能力：

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

这层能力声明就是管理不同渠道适配方案的入口：

- 只支持私聊的渠道声明 `direct: true, group: false, thread: false`。
- 同时支持私聊和群聊的渠道声明 `direct: true, group: true, thread: false`。
- 支持 thread 的渠道声明 `thread: true`，并通过 `ChannelMessage.conversation.kind = "thread"` 表达。
- 支持 typing、媒体、消息编辑或 streaming hint 的渠道各自声明对应能力，Bridge 根据能力选择是否调用 `sendTyping`、`sendMedia` 或后续编辑/聚合能力。

能力声明由 adapter 提供，CLI 交互或渠道实例管理可以在此基础上做运行时开关；有效能力应理解为“adapter 能力”和“实例开关”的交集。Bridge/ChannelRegistry 启动时应展示每个渠道实例的 capabilities，收到不支持的 conversation kind 时应拒绝或降级，而不是默默把它路由到错误上下文。

例如当前阶段可以把微信视为“已验证私聊，群聊待验证”；飞书接入时再按其真实能力声明 `group` 和 `thread`。这避免把某个平台尚未验证的能力误认为所有渠道都支持。

能力声明必须代表“当前已验证可用能力”，不是平台协议里理论可能出现的字段。Adapter 可以保留原始消息到 `group` 或 `thread` 的映射函数和单元测试，但如果真实收发链路没有验证，运行时 capability 仍应声明为 `false`，由 `ChannelRegistry` 拒绝这类入站上下文并记录日志。

### 3.3 渠道适配代码规范

新增或调整渠道时，代码必须按以下边界组织：

- `src/protocol/*` 只定义中间件通用协议，不引用任何具体平台 SDK、原始消息类型或 token 结构。
- `src/channels/<channel>/` 负责平台登录、收消息、发消息、原始消息映射、平台限流、重试、游标和平台私有缓存。
- `Bridge Core` 只能消费 `ChannelMessage`、`ChannelTarget`、`ChannelCapabilities`、`ChannelDeliveryPolicy` 和 route/session 状态。
- `ChannelRegistry` 是渠道实例边界，负责校验 `channelId`、conversation capability 和出站 `target.channelId`，不理解平台原始字段。
- `Command Router`、`ApprovalManager`、`StateStore` 和 `CodexAdapter` 不允许 import `src/channels/weixin/*`、`src/channels/lark/*` 等具体适配器内部类型。

新渠道适配必须完成这几个代码契约：

- `id` 是运行时唯一的渠道实例 ID，不是固定渠道类型名。
- `getCapabilities()` 明确声明 `direct`、`group`、`thread`、`media`、`typing` 等实际能力。
- `getDeliveryPolicy()` 表达投递差异，例如是否发送 task-start、progress、refresh 命令或聚合消息。
- `onMessage()` 输出稳定的 `ChannelMessage`，其中 `routeKey` 必须由 `buildRouteKey()` 或同等规则生成。
- 群聊和 thread 的 `routeKey` 不包含发言人；发言人身份放在 `sender`，必要时由 Bridge 拼进发给 Codex 的 prompt。
- 平台专属字段只能放在 `raw` 或 `target.context`，Bridge Core 不直接读取；如果某字段变成通用能力，应提升到协议类型或 delivery policy。
- 平台限流、发送最小间隔、失败重试、上下文 token 回退、卡片更新等都属于 adapter-owned 行为。
- 平台登录态、token、cursor、联系人/群/thread 缓存存放在 adapter 自己的 stateDir；Bridge 只持久化 route/session 绑定。

这样做的目标是让微信的一对一限制、飞书的群聊/thread 以及后续可选渠道都能接入同一个中间件协议，而不是把具体渠道差异写进 Bridge Core。

## 4. 会话绑定规则

核心规则：

```text
routeKey -> activeSessionId
sessionId -> ownerRouteKey
```

绑定行为：

- `/new`：为当前 route 创建新的 Codex session，并把它设置为当前 route 的 active session；该 session 的 owner 是当前 route。
- `/resume [session|编号]` 或 `/use [session|编号]`：只有当该 session 未被 Bridge 记录为其他 route 拥有，或已经属于当前 route 时，才允许绑定；不带参数时进入会话选择模式，用户回复编号完成切换，回复“取消”退出。
- 如果 session 已属于其他 route，必须拒绝绑定，并提示该 session 已被其他上下文占用。
- 当前 route 切换 active session 时，旧 session 仍然归当前 route 所有，只是不再 active。
- 未被 Bridge 记录过的 Codex 历史 session 可以被第一个执行 `/resume` 的 route 认领；认领后进入唯一归属规则。

这条规则比“一个渠道不能重复绑定 session”更精确：真正需要唯一的是 `routeKey`。routeKey 中已经包含渠道实例 ID，因此同一个 Codex session 不能同时绑定到微信和飞书，也不能同时绑定到同一个微信账号下的两个私聊或群聊。这样可以满足“一个 session 只能绑定一个渠道”的安全目标，同时避免同渠道多聊天上下文混用。

### 4.1 交互分层

多渠道接入要区分两类“绑定”，不要混在一个用户命令里：

1. 渠道实例接入和登录。
2. 聊天 route 与 Codex session 的绑定。

渠道实例接入是运维动作，通过 CLI 交互或命令式管理完成：

```bash
chat-codex
```

现有 `weixin login` 继续作为单独登录入口。微信/飞书不再暴露单渠道 Codex 启动入口；统一由 `chat-codex` 读取本地状态或进入 CLI 启动向导，选择渠道实例并启动。需要扫码或授权的渠道由控制台输出二维码、授权链接或提示。

聊天内用户不负责“把飞书接入系统”或“把微信账号接入系统”。用户在微信、飞书或其他渠道里发消息时，Bridge 根据入站消息自动生成 routeKey。这个 route 第一次收到普通 prompt 时可以自动创建 Codex session，也可以由用户显式发送 `/new` 创建。后续 `/resume`、`/use`、`/new` 都只改变当前 route 的 active session。

推荐用户可见交互：

```text
/whoami
Channel: weixin-main
Route: weixin-main:wx-account-1:direct:user-123
Session: cdx-abc123
```

```text
/new
已创建新 Codex 会话
Session: cdx-new123
Route: weixin-main:wx-account-1:direct:user-123
```

```text
/resume cdx-old123
已绑定 Codex 会话
Session: cdx-old123
Owner: 当前 route
```

### 4.2 `/resume` 和 `/use` 冲突检测

`/resume` 必须在调用 Codex resume 前后都遵守 session 唯一归属规则。

建议流程：

1. 解析用户输入的 `sessionId`。
2. 查询当前 route 是否有正在运行的 turn 或 pending approval；如果有，拒绝切换，提示先 `/stop` 或等待完成。
3. 查询 `sessionId -> ownerRouteKey`。
4. 如果 owner 存在且不是当前 route，拒绝绑定。
5. 如果 owner 不存在，先用原子 compare-and-set 或数据库事务把 owner 认领为当前 route。
6. 调用 `codex.resumeSession(sessionId)`。
7. 如果 resume 成功，把当前 route 的 `activeSessionId` 更新为该 session。
8. 如果 resume 失败，回滚本次认领或把 session 标记为不可用，并向当前 route 返回错误。

冲突提示示例：

```text
无法绑定 Codex 会话
Session: cdx-old123
原因: 该 session 已绑定到其他聊天上下文。
Owner: weixin-main:wx-account-1:direct:user-456

可发送 /new 创建当前上下文的新会话。
```

如果未来需要跨渠道迁移，应使用独立管理员命令，不复用普通 `/resume`：

```text
/transfer-session cdx-old123 confirm
```

迁移命令必须检查管理员身份、确认词、旧 route 是否正在运行、pending approval 是否已清空，并记录审计日志。MVP 不实现跨 route 自动迁移。

## 5. 为什么需要唯一归属

唯一归属是合理的，也是多渠道阶段的默认安全边界：

- 防止一个渠道看到另一个渠道的上下文、文件路径、审批内容和 token usage。
- 防止两个用户在同一个 Codex session 里交叉发 prompt，造成上下文污染。
- `/OK`、`/NO`、`/stop`、`/permission` 都必须有清晰作用域。
- Codex session 的工作目录和权限模式可能不同，跨渠道复用会扩大误操作风险。
- 出站文件投递必须回到发起任务的 route，不能因为 session 共享投递到另一个渠道。

如果后续确实需要把 session 从一个 route 迁移到另一个 route，应设计独立的管理员命令，例如 `/transfer-session <session> confirm`。迁移必须显式确认、记录审计日志，并从旧 route 解除 active binding。MVP 不做自动迁移。

## 6. 多渠道运行架构

目标架构：

```text
Codex Adapter
      ^
      |
Bridge Core
      |
      +--> Channel Registry
              +--> WeixinAdapter
              +--> LarkAdapter
              +--> TerminalAdapter
```

`ChannelRegistry` 负责：

- 启动和停止多个 `ChannelAdapter`。
- 校验 `channelId` 运行时唯一。
- 把所有 adapter 的 `onMessage` 汇聚到 Bridge Core。
- 根据 `ChannelTarget.channelId` 找到正确 adapter 做 `sendText`、`sendMedia` 和 `sendTyping`。
- 汇总所有渠道状态，供 `/status` 或管理命令展示。

当前 `Bridge` 只持有单个 `ChannelAdapter`，所以多渠道实现时需要二选一：

- 过渡方案：每个渠道一个 `Bridge` 实例，但共享同一个 `StateStore`、`ApprovalManager` 和 `CodexAdapter`。
- 目标方案：把 `Bridge` 改成持有 `ChannelRegistry`，由一个 Bridge Core 管理全部 route 队列和全部出站投递。

推荐目标方案。它更容易实现全局并发限制、统一 `/status`、统一 transcript、统一 session 反向唯一绑定，以及后续的管理命令。

### 6.1 渠道投递策略

多渠道不能假设所有平台都适合相同的出站消息形态。Bridge Core 应继续通过 `ChannelDeliveryPolicy` 读取渠道策略，而不是写平台名分支。

当前主干里的微信是特殊低噪声投递策略：

- 不投递 task-start。
- 不投递阶段性 progress。
- `/progress` 在微信中禁用。
- `/fff` 作为微信专用静默刷新命令。
- final answer、错误、审批、队列提示、命令回复和媒体结果仍然投递。
- Codex 运行期间可使用微信 typing 能力，但 typing 失败不影响主回复。
- WeixinAdapter 自己串行出站并做最小发送间隔，降低微信侧连续消息丢显或乱序风险。

微信 2.4.4 结构化进度实验只应扩展微信 adapter 自己的策略：普通文本进度可按 `/progress brief|detailed|silent` 测试，结构化工具生命周期可用 `/progress tools` 单独控制。这个能力不应写成 Bridge Core 的平台名分支，也不改变飞书、Terminal、Mock 的默认策略。

Terminal/Mock 使用默认完整投递策略。飞书等后续渠道应由各自 adapter 声明策略，例如卡片更新、thread reply、低频聚合或 suppress。新增渠道时优先扩展 `ChannelDeliveryPolicy`，不要在 Bridge Core 增加 `if channel === "xxx"`。

### 6.2 当前架构可行性

当前架构已经具备核心多渠道内核，后续应沿着同一边界继续治理。

已有基础：

- `ChannelAdapter` 已经抽象出通用渠道协议。
- `ChannelMessage`、`ChannelTarget`、`routeKey` 已经包含 `channelId` 和 `accountId`。
- `buildRouteKey()` 已经按 `<channelId>:<accountId>:<conversationKind>:<conversationId>` 生成稳定 route。
- Bridge 已经按 `routeKey` 做普通 prompt 串行队列。
- `ApprovalManager` 已经按 `routeKey` 管理审批。
- `ChannelDeliveryPolicy` 已经能表达不同渠道的投递差异，不需要在 Bridge Core 写平台分支。
- `ChannelRegistry` 已经可以管理多个 adapter，入站汇聚并按 `target.channelId` 做出站路由。
- `SessionBindings` 已经补上 `sessionId -> ownerRouteKey`，用于阻止跨 route 复用同一个 Codex session。
- `TurnScheduler` 已经作为可插拔全局背压层落位，默认 unlimited。
- `npm run chat-codex` / `npm run cli:chat-codex` 已经落地为推荐主启动入口。配置阶段不启动真实长轮询或飞书 WebSocket，可检查 Codex、添加微信账号、添加飞书机器人、设置微信主聊天 pending 绑定、管理已发现聊天绑定，并在首页确认后启动所有已启用渠道。

后续治理点：

- `FileStateStore` 已落地第一阶段文件持久化，真实微信/飞书启动路径会读写 `~/.chat-codex/state/bridge/routes.json`、`~/.chat-codex/state/bridge/session-owners.json`、`~/.chat-codex/state/bridge/session-policies.json` 和 `~/.chat-codex/state/bridge/pending-bindings.json`。
- 渠道实例管理和聊天绑定页已落地普通 CLI 版本；TUI 仍只作为后续展示层。
- 真实第二渠道、飞书群聊/thread、微信群聊真实链路都还没有验证。
- `RouteRuntime` 还没有从 `bridge.ts` 拆出，route 级队列、进度模式、active turn 状态后续应独立成模块。
- 当前 `src/bridge/bridge.ts`、`src/codex/app-server-codex-adapter.ts`、`src/channels/weixin/weixin-adapter.ts` 都已经超过开发规范里的拆分触发线，多渠道实现不能继续把逻辑堆进现有大文件。

结论：

- 不需要推翻现有协议和 routeKey 设计。
- 需要继续模块化 route 运行态、CLI 状态持久化和渠道实例管理。
- 全局调度器作为背压能力保留，但默认可以不限制不同 route 并行；需要保护本机或某个 Codex adapter 时，再通过 CLI 交互或启动参数设置 `maxConcurrentTurns`。

## 7. 并发模型

入站层：

- 所有渠道都可以同时收消息。
- 命令消息不进入普通 prompt 队列，应立即处理。
- 普通 prompt 的新 turn 按 routeKey 串行排队；运行中普通文本可以先进入当前 route 的 mid-turn steer buffer，steer 不可用时再回退普通队列。

执行层：

- 同一个 route 同一时间只能有一个 Codex turn 运行。
- 同一个 route 的 mid-turn steer 请求必须串行投递到当前 active turn，不能打乱普通文本顺序。
- 不同 route 可以并行运行不同 Codex session。
- 保留全局 `maxConcurrentTurns` 调度器作为可选背压，防止多个渠道同时触发长任务压垮本机或 Codex app-server。
- 默认不限制不同 route 并行，让多个渠道、多个账号、多个聊天上下文可以各自驱动自己的 Codex session。
- 如果需要限制资源占用，可以把 `maxConcurrentTurns` 设置为正整数；例如 `1` 表示普通 Codex turn 全局串行，不影响多渠道同时收消息和响应命令。

Codex app-server 侧支持这个并发模型：`turn/start` 的协议序列化作用域是 `thread_id`，不是全局互斥；同一个 thread 的请求会按 thread 串行，不同 thread 可以并行处理。当前 `AppServerCodexAdapter` 也按 `turnId -> queue`、`sessionId -> status` 维护运行态，能够把多个并发 turn 的通知分发回各自 session。

因此，多渠道并发的关键约束在 Bridge 侧：一个 Codex session 必须只有一个 owner route。补齐 `sessionId -> ownerRouteKey` 后，才能避免两个 route 同时驱动同一个 Codex session。

状态层：

- route 队列只影响当前 route。
- 全局执行池只控制普通 prompt 的 Codex turn 数量。
- `/status`、`/stop`、审批命令不应被全局普通任务队列阻塞。

## 8. 命令作用域

默认所有用户命令都只作用于当前 route：

- `/new`：当前 route。
- `/resume`、`/use`：当前 route 尝试绑定或认领 session。
- `/status`：当前 route 的 Codex、Bridge 和当前渠道状态。
- `/stop`：当前 route 的 active session 当前 turn，并清理当前 route 后续普通 prompt。
- `/permission`：当前 route active session；未绑定 session 时只影响当前 route 后续新 session 的默认策略。
- `/progress`：当前 route。
- `/sendfile`：当前 route 当前 turn 的一次性文件发送授权。
- `/OK`、`/NO`：当前 route 最新 pending approval。

多渠道阶段不建议普通用户使用 `/sessions all` 查看全部历史 session。默认 `/sessions` 只展示当前 route 拥有的 session。`/sessions all` 应改为管理员能力，或者只展示不包含敏感标题和 cwd 的脱敏列表。

## 9. 审批、停止和权限

审批必须绑定 route 和 turn：

- Pending approval 继续保存 `routeKey`。
- `/OK`、`/NO` 默认只处理当前 route 最新 pending approval。
- 来自其他渠道或其他 route 的 `/OK`、`/NO` 不允许处理该审批。
- 审批消息发送失败时，只在原 route 的 target 上重试。

停止必须绑定 route：

- `/stop` 只停止当前 route active session 的当前 turn。
- 不影响其他渠道、其他 route 和其他 session。
- 不停止整个 Bridge 进程。

权限必须绑定 session：

- `/permission approval` 和 `/permission full confirm` 修改当前 route active session 的 run policy。
- 因为 session 有唯一 owner，所以权限不会被另一个渠道意外继承。
- 没有 active session 时，默认策略应按 route 保存，而不是全局保存给所有渠道。

执行语义修改必须按 route 级阻断：

- 某个 route 正在运行、等待审批、存在 background goal turn 或已有普通 prompt 排队时，只阻断该 route 的会话切换、权限修改、模型修改、协作模式切换和 Goal 修改。
- 其他 route 不受影响，仍可操作各自拥有的 session。
- `/status`、`/help`、`/sessions`、`/whoami`、`/debug`、`/permission` 查看、`/model` 查看、`/goal` 查看、`/progress`、`/OK`、`/P`、`/NO`、`/stop` 仍应即时响应。
- 阻断原因必须面向“当前对话”，避免用户理解成整个 Bridge 或其他渠道都被锁住。

普通文本 mid-turn steer 也必须按 route 级处理：

- 运行中收到的普通文本不是命令，不应被 busy guard 拒绝。
- 如果当前 route 的 active session 支持 `CodexAdapter.steer()`，Bridge Core 可以把普通文本投递到当前 active turn；渠道 adapter 不直接调用 Codex。
- 投递成功后通过当前 route 的 ChannelTarget 发送确认。确认是通用中间层行为，微信、飞书、Terminal 和后续渠道共用同一逻辑。
- 如果用户连续发消息，Bridge 应按 route 维护独立 steer buffer，保序、串行、可短窗口聚合后投递，不能并发打乱顺序，也不能因为微信连续消息产生大量确认回复。
- steer 不可用、当前 turn 不可 steer 或投递失败时，未投递文本按原始顺序回退当前 route 普通 prompt 队列。
- route A 的 steer buffer 不能阻塞 route B；不同 route 仍保持各自队列、steer buffer、审批和 session 作用域。

## 10. 状态存储模型

当前 `MemoryStateStore` 只有 `routeKey -> sessionId` 的正向绑定。多渠道阶段需要增加反向索引。

建议模型：

```ts
type RouteBinding = {
  routeKey: string;
  activeSessionId?: string;
  channelId: string;
  accountId?: string;
  conversationKind: ConversationKind;
  conversationId: string;
  createdAt: string;
  updatedAt: string;
};

type StoredSession = {
  session: CodexSession;
  ownerRouteKey?: string;
  status: CodexSessionStatus;
  runPolicy?: CodexRunPolicy;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
};
```

绑定 API 应显式返回成功或冲突：

```ts
type BindSessionResult =
  | { ok: true; binding: RouteBinding }
  | { ok: false; reason: "owned_by_other_route"; ownerRouteKey: string };
```

持久化表建议扩展为：

- `routes(route_key, channel_id, account_id, conversation_kind, conversation_id, active_session_id, created_at, updated_at)`
- `sessions(session_id, owner_route_key, codex_backend, cwd, title, status, run_policy, created_at, updated_at, last_error)`
- `messages(message_id, route_key, channel_id, direction, text_hash, delivery_status, created_at)`
- `approvals(approval_key, route_key, session_id, turn_id, status, created_at, updated_at)`

## 11. 渠道故障隔离

多渠道不能因为单个渠道异常拖垮整体：

- 某个 adapter 登录失效，只把该渠道状态标记为 `login_required`。
- 某个 adapter 发送失败，只影响该 route 的出站投递和状态。
- Codex app-server 异常才影响所有 route 的 Codex 执行。
- `ChannelRegistry.stop()` 停止所有渠道；单渠道重启应作为后续管理能力。

`/status` 在当前 route 中展示当前渠道状态；管理员视图可以展示全部渠道：

```text
**Channels**
- weixin-main: connected account=wx-account-1
- lark-work: connected account=lark-bot-1
- lark-personal: login_required
```

## 12. 启动状态与 CLI 交互

现有日常启动入口统一为：

```bash
npm run chat-codex
npm run cli:terminal:codex
```

多渠道入口建议以 CLI 交互和本地状态为主，保持轻量，不要求用户手写配置文件：

```bash
chat-codex
```

CLI 交互需要能修改这些运行配置：

- Codex adapter、默认权限、默认 progress mode。
- `maxConcurrentTurns`：默认不限制；输入正整数才启用全局背压。
- 渠道实例列表：`id`、`type`、`enabled`、登录方式、运行态目录。
- 每个渠道实例的 capabilities 展示和可选开关，例如是否启用 group。
- 未绑定 route 的默认策略。
- 已知 route/session 绑定。

这里的“状态”不是要求用户维护配置文件，而是由 CLI 和 Bridge 自动写入的本地运行状态。配置文件可以作为后续导入/导出或无 TTY 部署能力，但不是 MVP 的必需入口。第一版优先把 CLI 交互和状态存储做好。

CLI 用户可见提示默认使用简体中文。渠道类型、能力字段和 routeKey 等技术标识可以保留英文枚举值，但菜单标题、操作说明、风险提示、错误信息和确认问题应使用中文，避免用户在配置阶段反复切换语言上下文。

配置阶段不启动真实服务。也就是说，扫码登录、选择默认权限、选择未绑定 route 策略和编辑 route/session 绑定时，不启动微信长轮询、飞书事件监听或其他常驻收消息循环。只有用户回到启动首页并选择“启动服务”后，才开始启动 enabled 且登录条件满足的渠道。

本地状态建议持久化这些内容：

- 渠道实例：`id`、`type`、`enabled`、`stateDir`、capability 开关、最后状态。
- 渠道登录态：由 adapter 自己管理，例如微信 token 保存在该实例的 `stateDir`，权限应尽量收紧。
- Codex 默认项：adapter 类型、默认权限、默认 progress mode、`maxConcurrentTurns`。
- route/session 绑定：`routeKey -> activeSessionId` 和 `sessionId -> ownerRouteKey`。
- 已知 route 展示信息：最近发消息时间、conversation 名称、sender 摘要。
- 未绑定 route 策略：`ask`、`auto_new` 或 `reject`。

聊天内 `/new`、`/resume`、`/use` 改变当前 route active session 时，必须立即写入本地状态。否则重启后会丢失用户在渠道里做出的绑定选择。

运行配置校验要求：

- `channels[].id` 必须全局唯一。
- 同一 `type` 可以出现多次，但必须有不同 `id` 和独立运行态目录。
- 登录态、token、缓存和 transcript 必须按渠道实例隔离。
- 多渠道 `serve` 不接受一个全局 `--session last|<id>` 绑定到所有渠道；session 只能通过 route 绑定。
- 启动时展示每个渠道实例的 capabilities；如果实例禁用了 group，即使 adapter 理论支持，也应按不支持处理。

### 12.1 启动首页

`npm run chat-codex` 和 `npm run cli:chat-codex` 是推荐主入口：

```bash
npm run chat-codex
npm run cli:chat-codex
npm run chat-codex -- --no-interactive
```

TTY 交互模式下，先进入启动首页，不直接开始长轮询：

```text
Codex Bridge

Codex:
- Adapter: app-server
- Permission: approval
- Progress: brief
- maxConcurrentTurns: unlimited

Channels:
1. weixin-main  type=weixin  enabled=true  state=connected  account=wx-account-1
2. terminal     type=terminal enabled=false state=stopped

Routes:
- Known: 3
- Bound: 2
- Unbound policy: ask

操作:
1. 管理渠道
2. 聊天绑定
3. 权限设置
4. 状态详情
5. 启动服务
0. 退出
请选择 [5]:
```

TTY 交互模式下，启动流程建议是：

1. 读取本地状态；不存在则进入创建向导。
2. 检查 Codex CLI 和 adapter。
3. 选择或确认 Codex adapter、默认权限、默认 progress mode、`maxConcurrentTurns`；`maxConcurrentTurns` 默认不限制，输入正整数才启用全局背压。
4. 加载渠道实例列表。
5. 如果没有任何可启动渠道，直接进入渠道添加/登录引导。
6. 对每个渠道实例检查账号登录态；未登录时引导用户登录、跳过或禁用。
7. 渠道登录成功后，立即引导用户设置该渠道发现新 route 时的 Codex session 绑定策略。
8. 展示已知 route/session 绑定；如果已有 route，允许用户编辑绑定。
9. 保存运行状态。
10. 回到首页，由用户确认后才一键启动所有 enabled 且登录条件满足的渠道。

首次启动或无可启动渠道时，不直接展示空首页后让用户猜下一步，而是进入渠道引导：

```text
未发现可启动渠道。

请选择要添加的渠道：
1. 微信
2. 飞书（未实现，稍后适配）
0. 退出
请选择 [1]:
```

已有登录态时不强制重新配置。CLI 应展示首页摘要，让用户可以直接回车启动，也可以继续添加渠道或编辑绑定：

```text
Codex Chat Bridge

Codex:
- Adapter: app-server
- Permission: approval
- maxConcurrentTurns: unlimited

Channels:
1. weixin-main  type=weixin  enabled=true  state=connected  account=小黄(wx-account-1)

Routes:
- Known: 2
- Bound: 1
- Unbound policy: auto_new

操作:
1. 管理渠道
2. 聊天绑定
3. 权限设置
4. 状态详情
5. 启动服务
0. 退出
请选择 [5]:
```

首页里的“启动服务”是正式启动点。用户选择该项后，Bridge 才开始启动渠道长轮询、事件订阅和 Codex 运行期 transcript。启动后再进入常驻服务模式，除非后续实现运行期管理命令，否则不在同一个 TTY 菜单里继续编辑配置。

无本地状态时的创建向导示例：

```text
未找到多渠道启动状态，开始创建。

Codex Adapter:
1. app-server（推荐，支持交互审批）
2. exec（回退，不支持交互审批）
请选择 [1]:

默认权限:
1. approval（workspace-write，需要时推送 /OK /NO）
2. full（危险，需要确认）
请选择 [1]:

全局并发 Codex turn 数量 [不限制]:

添加渠道:
1. weixin
2. lark（未实现，稍后适配）
3. terminal
0. 完成
请选择渠道类型:

渠道能力:
- direct: yes
- group: no
- thread: no
- typing: yes
- media: yes
```

已有本地状态时的确认示例：

```text
多渠道启动状态
- Codex: app-server, permission=approval, maxConcurrentTurns=unlimited
- Unbound route policy: ask

Channels:
1. weixin-main  type=weixin  enabled=true  stateDir=state/channels/weixin/weixin-main
2. lark-work    type=lark    enabled=true  stateDir=state/channels/lark/lark-work

操作:
1. 管理渠道
2. 聊天绑定
3. 权限设置
4. 状态详情
5. 启动服务
0. 退出
请选择 [5]:
```

非交互模式下，不能等待扫码、确认或输入验证码；本地状态或启动参数必须足够完整。若某渠道需要登录但没有有效登录态，应把该渠道标记为 `login_required` 或跳过启动，并在日志里明确提示。

### 12.1.1 渠道管理交互

渠道管理页负责“接入哪个渠道实例”，不负责把某个 Codex session 直接绑定给整个账号。

```text
渠道管理

1. weixin-main  type=weixin  enabled=true  state=connected
2. lark-work    type=lark    enabled=false state=not_configured

操作:
w. 添加微信账号
f. 添加飞书机器人
e. 编辑选中渠道
l. 登录/重新登录选中渠道
t. 启用/禁用选中渠道
d. 删除选中渠道实例
0. 返回首页
请选择:
```

添加渠道时：

```text
添加渠道
1. weixin
2. terminal
3. lark（未实现）
0. 返回
请选择渠道类型:
```

选择微信后：

```text
添加微信渠道
- Channel ID [weixin-main]:
- State dir [state/channels/weixin/weixin-main]:
- Capabilities:
  direct: yes
  group: no（待真实验证）
  thread: no
  media: yes
  typing: yes

操作:
1. 现在扫码登录
2. 先保存，稍后登录
0. 取消
请选择 [1]:
```

微信登录成功后不能直接跳过绑定引导。CLI 应先进入“首个私聊 route 绑定方式”或“未绑定 route 策略”选择，再回到渠道管理页或首页。这样用户扫码完成后就能把“这个渠道后续消息如何进入 Codex session”安排清楚，同时仍然不把整个微信账号直接绑定到某个 session。

### 12.1.2 微信渠道的一对一交互

当前微信主要按私聊使用，但架构上仍然按 route 绑定 session，而不是按微信账号绑定 session。

原因：

- 一个微信登录账号可能收到多个私聊，未来也可能收到群聊。
- 如果账号直接绑定 Codex session，多个对话会共享上下文，容易串线。
- 当前用户实际只用一个私聊时，可以通过“首个 route 绑定策略”获得近似一对一体验。

微信渠道建议交互：

1. 用户添加 `weixin-main` 渠道实例。
2. CLI 显示二维码，用户扫码登录。
3. 登录成功后展示微信账号状态。
4. 用户选择该渠道的未绑定 route 策略。
5. 用户可以选择“首个私聊 route 绑定方式”：
   - `auto_new`：首个微信私聊发来普通消息时自动创建 Codex session 并持久化绑定。
   - `ask`：首个微信私聊发来普通消息时提示 `/new` 或 `/resume` 进入会话选择。
   - `bind_existing_first_route`：启动前选择一个已有 Codex session；第一个入站微信私聊 route 认领该 session。
   - `new_first_route`：启动前创建一个 Codex session；第一个入站微信私聊 route 绑定它。

示例：

```text
微信渠道 weixin-main 已登录
- Account: wx-account-1
- 当前已知 route: 0

首个私聊 route 如何绑定 Codex session？
1. 首条消息自动创建新 session（推荐单用户私有部署）
2. 首条消息先询问 /new 或 /resume（推荐多用户/多聊天）
3. 现在选择已有 session，绑定给第一个私聊 route
4. 现在创建新 session，绑定给第一个私聊 route
请选择 [1]:
```

如果选择 3 或 4，状态里保存的不是“微信账号 -> session”，而是一个 pending first-route binding。第一个符合条件的微信私聊消息到达时，Bridge 才能拿到真实 `routeKey`，然后把该 session owner 设置为该 `routeKey`。一旦绑定完成，这个 pending binding 必须清除。

如果已经有已知 route，CLI 可以直接管理这些 route 的 session：

```text
微信 route 绑定
1. direct:Alice  route=weixin-main:wx-account-1:direct:alice  session=cdx-aaa111
2. direct:Bob    route=weixin-main:wx-account-1:direct:bob    session=none

操作:
1. 编辑 route 绑定
2. 清理失效 route
0. 返回
请选择:
```

微信的一对一体验可以做得很顺，但底层仍然坚持 route 级绑定，这是多渠道安全边界。

### 12.1.3 当前 `chat-codex` 落地范围

当前代码已经提供轻量入口：

```bash
npm run chat-codex
```

已落地能力：

- 启动前检查 Codex CLI。
- 通过 CLI 设置本次启动的新会话工作目录、权限模式和 `maxConcurrentTurns`。
- 未发现微信登录态时显示中文渠道引导，只提供微信和“飞书（未实现，稍后适配）”。
- 微信登录阶段只启动二维码登录流程，不启动长轮询。
- 微信登录后引导选择首个私聊 route 的绑定方式：`auto_new`、`ask`、`bind_existing_first_route`、`new_first_route`。
- 回到首页后，用户选择“启动服务”才创建 Bridge 并启动微信长轮询。
- Bridge 支持 `unboundRoutePolicy=ask`：未绑定 route 的普通消息不会自动进入 Codex，会提示先 `/new` 或 `/resume <session-id>`。

当前仍未落地能力：

- CLI 自有持久化状态。
- 多个微信实例或真实第二渠道。
- 完整渠道管理页、route/session 管理页和启动后热管理。
- `new_first_route` 的预创建 session；当前等价为第一个私聊 route 首条普通消息到达时创建并绑定。

### 12.2 渠道账号登录交互

账号登录态属于渠道实例，不属于 Codex session。启动时对每个渠道实例做登录态检查：

```text
检查渠道 weixin-main
- Type: weixin
- State: connected
- Account: 小黄(wx-account-1)
- Last inbound: 2026-05-15 10:20:31

操作:
1. 继续使用此账号
2. 重新登录/切换账号
3. 登出此账号
4. 本次禁用此渠道
请选择 [1]:
```

未登录时：

```text
检查渠道 weixin-main
- Type: weixin
- State: login_required

操作:
1. 现在登录
2. 本次跳过
3. 禁用并保存状态
请选择 [1]:
```

微信登录显示二维码或二维码文本；飞书可显示授权 URL 或使用 bot token。不同渠道的登录方式由 adapter 处理，但 CLI 交互框架统一。

登出和切换账号的规则：

- 登出只删除或失效该渠道实例的登录态，不删除 route/session 绑定。
- 切换账号后，因为 routeKey 包含 `accountId`，旧账号的 route 不会自动绑定到新账号。
- 如果同一个 `channelId` 登录成另一个 `accountId`，启动向导必须提示存在旧账号 route 绑定，并允许保留、禁用或清理。
- 清理 route 绑定不删除 Codex 历史 session，只解除 Bridge 的 active binding 和 owner 记录；是否释放 owner 需要二次确认。

为了支持这些交互，通用渠道协议可以增加可选账号生命周期能力：

```ts
type ChannelAccountInfo = {
  accountId: string;
  displayName?: string;
  state: "connected" | "login_required" | "expired" | "disabled";
  lastInboundAt?: string;
  lastOutboundAt?: string;
};

type ChannelAccountLifecycle = {
  listAccounts?(): Promise<ChannelAccountInfo[]>;
  logout?(accountId?: string): Promise<void>;
};
```

不是所有渠道都需要多账号管理。没有实现 `logout` 的 adapter，只能提示用户删除对应 stateDir 或使用该渠道自己的撤销方式。

### 12.3 账号、route 和 session 的关系

账号不直接绑定 Codex session。原因是一个账号下可以有多个私聊、群聊或 thread；如果账号直接绑定 session，同一账号下的所有人会共享上下文。

正确关系是：

```text
channel instance -> account login state
routeKey -> activeSessionId
sessionId -> ownerRouteKey
```

启动向导可以展示“某账号下已知 route 的 session 绑定”，但不提供“账号绑定某个 session 给所有聊天”的默认操作。

已知 route 绑定展示示例：

```text
已知 route/session 绑定
1. weixin-main / 小黄 / direct:Alice
   Route: weixin-main:wx-account-1:direct:alice
   Active session: cdx-aaa111
   Last seen: 2026-05-15 10:20:31

2. lark-work / work-bot / thread:需求评审
   Route: lark-work:lark-bot-1:thread:thread-789
   Active session: cdx-bbb222
   Last seen: 2026-05-14 22:10:05

操作:
1. 保持全部绑定
2. 编辑某个 route 绑定
3. 清理失效 route
0. 返回
请选择 [1]:
```

编辑某个 route 时：

```text
Route: weixin-main:wx-account-1:direct:alice
当前 Session: cdx-aaa111

操作:
1. 保持
2. 创建新 session 并设为 active
3. 绑定已有 session
4. 解除 active binding
请选择 [1]:
```

绑定已有 session 必须走与 `/resume` 相同的冲突检测逻辑。如果该 session 已属于其他 route，CLI 也必须拒绝，除非进入管理员迁移流程。

### 12.4 渠道持久化边界

不同渠道的持久化逻辑一定会有差异，但差异不能泄漏到 Bridge Core。推荐拆成三层：

```text
Channel adapter state
  登录态、token、cursor、平台原始缓存、平台专属 route 元数据

Bridge route state
  routeKey、channelId、accountId、conversationKind、conversationId、activeSessionId、lastSeen

Session owner state
  sessionId -> ownerRouteKey、session 状态、run policy、model/progress/collaboration mode
```

职责边界：

- adapter 负责保存和解释平台状态，例如微信 token、`getUpdatesBuf`，飞书 app token、tenant、群聊/thread 游标。
- Bridge 只保存通用 route/session 绑定，不保存平台 token，不直接理解飞书群成员或微信原始消息结构。
- CLI 可以展示 adapter 提供的摘要信息，但写入绑定时只能写通用 route/session 状态。
- 任何渠道第一次发现新会话上下文时，都必须生成稳定 `routeKey`，再由 Bridge 决定是否创建或绑定 Codex session。

建议抽象：

```ts
type ChannelPersistencePolicy = {
  routeDiscovery: "inbound_only" | "preload_supported";
  defaultUnboundPolicy: "ask" | "auto_new" | "reject";
  supportedConversationKinds: ConversationKind[];
  storesLoginState: boolean;
  storesDeliveryCursor: boolean;
  supportsRouteMetadataRefresh: boolean;
};
```

这个 policy 不一定作为第一版代码接口立即落地，但设计上要有这个边界。不同渠道 adapter 可以在 CLI 管理页展示自己的策略，让用户知道“这个渠道能预加载哪些 route、哪些 route 只能等消息来了才知道”。

渠道差异示例：

| 渠道 | route 发现方式 | adapter-owned 持久化 | Bridge-owned 持久化 |
| --- | --- | --- | --- |
| 微信 | 主要靠入站消息发现私聊；群聊待真实验证 | 登录 token、账号列表、`getUpdatesBuf`、typing ticket 缓存 | `weixin-main:account:direct:user` 的 active session 和 owner |
| 飞书私聊 | 可由事件入站发现，也可能通过 API 预加载最近会话 | bot token/app token、tenant、open_id 映射、事件 cursor | `lark-work:bot:direct:user` 的 active session 和 owner |
| 飞书群聊 | 群事件入站发现；可选 API 刷新群名和成员摘要 | chat_id、群名缓存、成员显示名缓存、事件 cursor | `lark-work:bot:group:chat` 的 active session 和 owner |
| 飞书 thread | thread 事件入站发现；可选 API 刷新 thread 标题 | thread_id、parent message、thread 标题缓存 | `lark-work:bot:thread:thread` 的 active session 和 owner |
| 终端 | 启动时固定一个本地 route | 无登录态；可保存本地 route display | `terminal:local:direct:terminal` 的 active session 和 owner |

微信当前“一对一”的体验，是产品交互上的简化，不是持久化模型上的账号绑定。它可以使用 `auto_new` 或 pending first-route binding，让第一个微信私聊 route 绑定到某个 Codex session。飞书则必须从一开始就按 `direct`、`group`、`thread` 分开展示和持久化，因为同一个飞书 bot 下天然会有多个上下文。

持久化写入时机：

- 渠道登录成功：adapter 写自己的登录态；Bridge/CLI 写渠道实例状态。
- 入站消息第一次出现：Bridge upsert route 摘要和 `lastSeen`。
- `/new` 成功：Bridge 写 route active session 和 session owner。
- `/resume`、`/use` 成功：Bridge 写 route active session；如果 session 无 owner，则写 owner。
- `/resume` 失败：如果本次刚认领 owner，必须回滚 owner。
- 渠道切换账号或登出：adapter 修改登录态；Bridge 不自动删除 route/session 绑定，只标记这些 route 可能 stale，由用户确认清理。

这样设计后，每个渠道可以保留自己的复杂状态，Bridge 仍然只维护统一的多渠道路由和 session 安全边界。

### 12.5 未绑定 route 的首次交互

多渠道模式下，新 route 第一次发消息时建议默认 `unboundPolicy=ask`，避免把陌生聊天自动接入 Codex。

`unboundPolicy` 可选：

- `ask`：首次普通消息不直接转给 Codex，而是回复绑定提示。推荐多渠道默认值。
- `auto_new`：沿用当前体验，首次普通消息自动创建新 Codex session。适合单用户私有部署。
- `reject`：未绑定 route 只允许 `/new`、`/resume`、`/whoami`、`/help`，普通 prompt 直接拒绝。

`ask` 模式下，首次普通消息回复：

```text
当前聊天上下文还未绑定 Codex 会话。

可用操作：
/new 创建新会话
/resume 进入会话选择，或 /resume [session] 绑定已有会话
/whoami 查看当前 route
```

用户发送 `/new` 后：

```text
已创建新 Codex 会话
Session: cdx-new123
Route: weixin-main:wx-account-1:direct:user-123
```

用户发送 `/resume cdx-old123` 后，Bridge 执行 session owner 冲突检测；通过才绑定。

`auto_new` 模式仍要在创建后明确提示绑定结果：

```text
已为当前聊天自动创建 Codex 会话
Session: cdx-new123
Route: lark-work:lark-bot-1:thread:thread-789
```

### 12.6 命令交互入口

除了启动向导，还需要保留命令式管理入口，便于脚本化和远程服务器运维。

建议 CLI 命令：

```bash
chat-codex
chat-codex channel list
chat-codex channel status
chat-codex channel login <channelId>
chat-codex channel logout <channelId> [--account <accountId>]
chat-codex channel enable <channelId>
chat-codex channel disable <channelId>
chat-codex channel capabilities <channelId>
chat-codex channel capability set <channelId> group on|off
chat-codex route list [--channel <channelId>]
chat-codex route bind <routeKey> <sessionId>
chat-codex route unbind <routeKey>
chat-codex route policy ask|auto_new|reject
```

聊天内命令保持面向当前 route：

```text
/whoami
/new
/resume [session|编号]
/sessions
/status
/stop
/permission
/progress
/sendfile
```

`/resume` 在微信、飞书或终端里行为完全一致：只能绑定当前 route 可拥有的 session；如果 session 已被另一个 route 拥有，必须拒绝。

## 13. 核心内核实施顺序

本节记录核心多渠道内核的实施顺序。核心内核阶段不做配置文件、启动向导和真实第二渠道；启动向导的当前 MVP 范围见 12.1.3。目标是让 Bridge Core 具备多 `ChannelAdapter` 接入能力，同时保持统一 `chat-codex` 入口和 `terminal codex` 开发入口可用。

实施原则：

- 先做可测试的内核模块，再把 Bridge 接上；不要一开始改 CLI、配置文件或真实第二渠道。
- 每一步都保持统一入口和终端开发入口可用，避免把当前微信链路和终端链路同时打断。
- 新模块先用 mock channel 和单元测试锁住行为；真实微信只验证兼容性和实例 `channelId` 不回退。
- Bridge Core 只依赖通用协议；渠道差异继续放在 adapter、capabilities 和 delivery policy。
- `maxConcurrentTurns` 先作为可插拔调度器接口落位，默认 unlimited，不改变当前并发体验。

### 13.1 实施阶段总览

建议按“内核模块 -> Bridge 接入 -> 微信兼容 -> 绑定安全 -> 并发背压 -> 集成验收”的顺序推进：

| 阶段 | 目标 | 主要文件 | 完成标志 |
| --- | --- | --- | --- |
| P0 基线确认 | 确认现有单渠道测试和文档约束 | `docs/development-and-test.zh-CN.md`、现有测试 | `npm test` 或已记录无法运行原因 |
| P1 ChannelRegistry | 多 adapter 注册、入站汇聚、出站按 channelId 路由 | `src/channels/registry.ts` | registry 单测覆盖重复 ID、缺失目标、投递策略 |
| P2 Bridge 接入 Registry | Bridge 仍兼容单 `channel`，内部改走 registry | `src/bridge/bridge.ts` | 现有 mock/terminal/weixin 测试行为不变 |
| P3 Weixin 实例 ID | 微信入站不再写死 `channelId: "weixin"` | `src/channels/weixin/weixin-adapter.ts` | 非默认 ID 单测通过，默认 ID 兼容旧 routeKey |
| P4 SessionBindings | 补 `sessionId -> ownerRouteKey`，阻止跨 route 复用 | `src/state/session-bindings.ts`、`src/state/memory-state-store.ts` | `/new`、`/resume`、`/use` owner 冲突测试通过 |
| P5 命令与审批作用域复核 | 确认命令、审批、stop、permission 都只作用当前 route | `src/bridge/bridge.ts`、`src/approvals/*` | 跨 route `/OK`、`/stop` 不能影响其他 route |
| P6 TurnScheduler | 加默认 unlimited 调度器，预留有限并发背压 | `src/bridge/turn-scheduler.ts` | unlimited 不排队，limited=1 可预测排队 |
| P7 多渠道集成测试 | 两个 mock channel 同进程并行工作 | `tests/integration/bridge-mock.test.ts` | A/B 渠道出站不串线，同 route 串行、不同 route 并行 |
| P8 RouteRuntime 拆分 | 在行为稳定后再拆 route 级运行态 | `src/bridge/route-runtime.ts` | `bridge.ts` 只保留编排逻辑，测试无行为变化 |

依赖关系：

```text
ChannelRegistry
  -> Bridge 出站/入站接入
      -> WeixinAdapter 实例 channelId
          -> SessionBindings owner 约束
              -> 命令/审批作用域复核
                  -> TurnScheduler
                      -> 多渠道集成测试
                          -> RouteRuntime 拆分
```

`RouteRuntime` 放在最后，是因为它主要是代码结构治理；在 registry、binding 和 scheduler 行为没有稳定前提前拆，容易把重构风险和业务行为风险混在一起。

### 13.2 开发边界

核心内核阶段要做：

- `ChannelRegistry`：多个 adapter 的启动、停止、入站汇聚和出站路由。
- Bridge 出站改为按 `ChannelTarget.channelId` 投递。
- WeixinAdapter 支持实例 `channelId`，不再在消息映射里写死 `"weixin"`。
- `SessionBindings`：`routeKey -> activeSessionId` 和 `sessionId -> ownerRouteKey` 双向绑定。
- `/new`、`/resume`、`/use` 统一走 session binding API。
- `TurnScheduler` 接口和 unlimited 默认实现，为后续 `maxConcurrentTurns` 背压预留。
- 必要时先抽最小 `RouteRuntime`，但不为了拆文件破坏当前 Bridge 行为。

核心内核阶段不做：

- 不做飞书真实 adapter。
- 不做配置文件和启动向导。
- 不做 `/cwd`、workspace lock 或复杂工作目录策略。
- 不做真实群聊验证，只保留协议层能力声明和测试覆盖。

### 13.3 模块接口草案

#### 13.3.1 ChannelRegistry

文件：`src/channels/registry.ts`

职责：

- 持有多个 `ChannelAdapter`。
- 校验 `channel.id` 全局唯一。
- 把所有 adapter 的 `onMessage` 汇聚到一个 Bridge handler。
- 出站时按 `target.channelId` 找回正确 adapter。
- 按 channelId 查询 capabilities、delivery policy 和 status。
- 隔离单个 adapter 的启动、投递和停止错误，避免错误被静默路由到其他渠道。

接口草案：

```ts
export interface ChannelRegistryOptions {
  channels: ChannelAdapter[];
  logger?: Logger;
}

export interface ChannelLifecycleResult {
  channelId: string;
  ok: boolean;
  status?: ChannelStatus;
  error?: unknown;
}

export interface ChannelRegistryStatus {
  channels: ChannelStatus[];
  failed: ChannelLifecycleResult[];
}

export class ChannelRegistry {
  constructor(options: ChannelRegistryOptions);

  ids(): string[];
  get(channelId: string): ChannelAdapter | undefined;
  require(channelId: string): ChannelAdapter;
  has(channelId: string): boolean;

  onMessage(handler: ChannelMessageHandler): void;
  start(): Promise<ChannelLifecycleResult[]>;
  stop(): Promise<ChannelLifecycleResult[]>;

  getStatus(channelId?: string): Promise<ChannelStatus | ChannelRegistryStatus>;
  getCapabilities(channelId: string): ChannelCapabilities;
  listCapabilities(): Record<string, ChannelCapabilities>;
  getDeliveryPolicy(message?: ChannelMessage): ChannelDeliveryPolicy;

  sendText(target: ChannelTarget, text: string, options?: SendOptions): Promise<SendResult>;
  sendMedia(target: ChannelTarget, media: ChannelMedia, options?: SendOptions): Promise<SendResult>;
  sendTyping(target: ChannelTarget, typing: boolean, options?: SendOptions): Promise<void>;
}

export function createSingleChannelRegistry(channel: ChannelAdapter, logger?: Logger): ChannelRegistry;
```

行为要求：

- 构造时遇到重复 `channel.id` 必须抛错。
- adapter 入站的 `message.channelId` 必须等于该 adapter 的 `id`；不一致时拒绝该消息并记录错误，避免错误 routeKey 污染状态。
- 出站找不到 `target.channelId` 必须抛错并记录日志，不能降级发到任意默认渠道。
- `sendMedia`、`sendTyping` 必须先检查目标 adapter capability 和方法是否存在；不支持时返回明确错误或 no-op，行为要和当前 Bridge fallback 一致。
- `getDeliveryPolicy(message)` 从 `message.channelId` 对应 adapter 读取；没有 adapter policy 时使用默认策略。
- `start()` 尽量启动全部渠道；单个渠道失败应返回失败项并保留其他已启动渠道。是否因为失败退出进程由 CLI/Bridge 启动策略决定。
- `stop()` 尽量停止全部渠道；即使某个 adapter stop 失败，也要继续停止其他 adapter。

兼容策略：

- Bridge 可以继续接受 `channel: ChannelAdapter`，内部包装成单实例 `ChannelRegistry`。
- 新增多渠道入口时再传入 `channels: ChannelRegistry` 或 `channelRegistry`。

#### 13.3.2 SessionBindings

文件：`src/state/session-bindings.ts`

职责：

- 管理 `routeKey -> activeSessionId`。
- 管理 `sessionId -> ownerRouteKey`。
- 保证一个 session 只能被一个 route 拥有。
- 支持 `/resume` 先认领 owner、resume 成功后再激活；resume 失败时可回滚本次认领。
- 为未来持久化存储保留小而稳定的接口。

接口草案：

```ts
export interface SessionBinding {
  routeKey: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionOwner {
  sessionId: string;
  ownerRouteKey: string;
  claimedAt: string;
  updatedAt: string;
}

export type ClaimSessionResult =
  | { ok: true; owner: SessionOwner; newlyClaimed: boolean }
  | { ok: false; reason: "owned_by_other_route"; owner: SessionOwner };

export type ActivateSessionResult =
  | { ok: true; binding: SessionBinding; owner: SessionOwner }
  | { ok: false; reason: "not_owned_by_route"; owner?: SessionOwner };

export class SessionBindings {
  bindNewSession(routeKey: string, session: CodexSession): SessionBinding;

  claimSessionOwner(routeKey: string, sessionId: string): ClaimSessionResult;
  activateOwnedSession(routeKey: string, session: CodexSession): ActivateSessionResult;
  rollbackClaim(routeKey: string, sessionId: string): void;

  getActive(routeKey: string): SessionBinding | undefined;
  getOwner(sessionId: string): SessionOwner | undefined;
  listRouteSessions(routeKey: string): string[];
  listOwners(routeKey?: string): SessionOwner[];
}
```

行为要求：

- `/new` 创建的新 session 直接归属当前 route。
- `/resume` 或 `/use` 绑定历史 session 时，先 `claimSessionOwner()`。
- session 无 owner 时，当前 route 可以认领。
- session owner 是当前 route 时，可以切换为 active。
- session owner 是其他 route 时必须拒绝，不能调用 `codex.resumeSession()` 后再失败。
- `claimSessionOwner()` 只处理 owner，不更新 active session；`codex.resumeSession()` 成功后才调用 `activateOwnedSession()`。
- `codex.resumeSession()` 失败时，如果本次调用刚刚认领了 owner，必须 `rollbackClaim()`；如果 owner 原本就是当前 route，不回滚历史 owner。
- 当前 `MemoryStateStore` 可以先内嵌或组合 `SessionBindings`，后续再替换为 SQLite。

`/resume` 建议伪代码：

```ts
const claim = sessionBindings.claimSessionOwner(routeKey, sessionId);
if (!claim.ok) {
  await channels.sendText(target, formatOwnerConflict(claim.owner));
  return;
}

try {
  const session = await codex.resumeSession(sessionId);
  const activated = sessionBindings.activateOwnedSession(routeKey, session);
  if (!activated.ok) {
    await channels.sendText(target, "当前 route 未持有该 session，无法绑定。");
    return;
  }
  await channels.sendText(target, formatResumeSuccess(activated.binding));
} catch (error) {
  if (claim.newlyClaimed) sessionBindings.rollbackClaim(routeKey, sessionId);
  await channels.sendText(target, formatResumeFailure(error));
}
```

#### 13.3.3 RouteRuntime

文件：`src/bridge/route-runtime.ts`

职责：

- 收敛 route 级运行态，减少 `bridge.ts` 的共享 Map。
- 保持同 route 串行队列。
- 保存 route 级 progress mode、collaboration mode、progress send cooldown 等状态。

接口草案：

```ts
export interface QueuedPrompt {
  message: ChannelMessage;
  target: ChannelTarget;
  prompt: string;
  collaborationMode?: CodexCollaborationMode;
  sendFile: boolean;
}

export interface RouteRuntime {
  routeKey: string;
  queue: QueuedPrompt[];
  worker?: Promise<void>;
  progressMode?: ProgressDeliveryMode;
  collaborationMode?: CodexCollaborationMode;
  progressSendSuppressedUntil?: number;
  activeTurn?: {
    sessionId: string;
    startedAt: string;
    abortController?: AbortController;
  };
}

export class RouteRuntimeStore {
  get(routeKey: string): RouteRuntime;
  getIfExists(routeKey: string): RouteRuntime | undefined;
  deleteIfIdle(routeKey: string): void;
  list(): RouteRuntime[];
}
```

落地策略：

- 第一轮可以先保留现有 `routeQueues`、`routeWorkers` 等 Map，等 ChannelRegistry 和 SessionBindings 稳定后再拆。
- 拆出时必须保持现有行为：命令立即处理，普通 prompt 同 route 排队，不同 route 默认并行。
- 如果接入 `LimitedTurnScheduler`，等待全局 slot 的任务也属于当前 route 的运行态；`/stop` 应能让尚未进入 Codex 的等待任务取消或跳过。

#### 13.3.4 TurnScheduler

文件：`src/bridge/turn-scheduler.ts`

职责：

- 作为全局普通 Codex turn 背压层。
- 默认 unlimited，不限制不同 route 并行。
- 后续需要时支持 `maxConcurrentTurns` 正整数限制。
- 只调度“准备进入 Codex 的普通 prompt”，不接管渠道入站、命令处理或 adapter 出站。

接口草案：

```ts
export interface ScheduledTurn {
  routeKey: string;
  sessionId?: string;
  enqueuedAt: string;
}

export interface TurnSchedulerRunOptions {
  signal?: AbortSignal;
}

export interface TurnScheduler {
  run<T>(turn: ScheduledTurn, task: () => Promise<T>, options?: TurnSchedulerRunOptions): Promise<T>;
  getStatus(): TurnSchedulerStatus;
}

export interface TurnSchedulerStatus {
  mode: "unlimited" | "limited";
  maxConcurrentTurns?: number;
  running: number;
  queued: number;
}

export class UnlimitedTurnScheduler implements TurnScheduler {
  run<T>(turn: ScheduledTurn, task: () => Promise<T>, options?: TurnSchedulerRunOptions): Promise<T>;
  getStatus(): TurnSchedulerStatus;
}

export class LimitedTurnScheduler implements TurnScheduler {
  constructor(maxConcurrentTurns: number);
  run<T>(turn: ScheduledTurn, task: () => Promise<T>, options?: TurnSchedulerRunOptions): Promise<T>;
  getStatus(): TurnSchedulerStatus;
}
```

行为要求：

- Scheduler 只包普通 prompt 的 Codex turn，不包 `/status`、`/stop`、`/OK`、`/NO`、`/help` 等命令。
- `UnlimitedTurnScheduler` 是默认实现，本轮接入后不应改变当前并发表现。
- `LimitedTurnScheduler(1)` 等价于普通 prompt 全局串行，但多渠道仍能同时收消息和处理命令。
- `LimitedTurnScheduler` 按 FIFO 获取全局 slot；释放 slot 必须放在 `finally`，避免异常导致全局死锁。
- 如果等待 slot 时 `AbortSignal` 已取消，任务不应进入 Codex，也不占用全局 running 计数。

### 13.4 Bridge 改造草案

`BridgeOptions` 目标形态：

```ts
export interface BridgeOptions {
  channel?: ChannelAdapter;
  channels?: ChannelRegistry;
  codex: CodexAdapter;
  state?: MemoryStateStore;
  sessionBindings?: SessionBindings;
  approvals?: ApprovalManager;
  turnScheduler?: TurnScheduler;
  logger?: Logger;
  transcript?: TranscriptSink;
  cwd?: string;
  initialRouteBinding?: { type: "existing"; sessionId: string } | { type: "new" };
  progressMode?: ProgressDeliveryMode;
  approvalSendRetryDelayMs?: number;
}
```

构造规则：

- `channel` 和 `channels` 至少传一个。
- 两者同时传入时应拒绝，避免入口语义混乱。
- 传 `channel` 时内部创建单渠道 registry，保证现有测试和 CLI 不需要同步大改。
- `sessionBindings` 未传入时由 `MemoryStateStore` 提供默认内存实现；不要在 Bridge 内部再维护第二套 owner Map。
- `turnScheduler` 未传入时使用 `UnlimitedTurnScheduler`。

Bridge 内部替换点：

- `this.channel.onMessage` -> `this.channels.onMessage`
- `this.channel.start/stop` -> `this.channels.start/stop`
- `this.channel.sendText/sendMedia/sendTyping` -> `this.channels.sendText/sendMedia/sendTyping`
- `this.channel.getCapabilities()` -> `this.channels.getCapabilities(target.channelId)`
- `this.channel.getDeliveryPolicy(message)` -> `this.channels.getDeliveryPolicy(message)`
- `/status` 中当前 channel 状态按 `message.channelId` 查询，多渠道管理状态后续再扩展。

Bridge 普通 prompt 数据流：

```text
ChannelAdapter.onMessage
  -> ChannelRegistry 校验 channelId
  -> Bridge.handleMessage
  -> route queue 串行
  -> SessionBindings 确认 active session/owner
  -> TurnScheduler 获取全局 slot
  -> CodexAdapter.run/resume
  -> ChannelRegistry 按 target.channelId 回投
```

Bridge 命令数据流：

```text
ChannelAdapter.onMessage
  -> ChannelRegistry 校验 channelId
  -> Bridge.handleCommand
  -> 当前 route 的 binding/approval/runtime
  -> ChannelRegistry 按 target.channelId 回投
```

命令不进入 `TurnScheduler`。审批、`/stop`、`/status` 必须能在其他 route 长任务运行时立即响应。

### 13.5 WeixinAdapter 改造草案

当前 `weixinMessageToChannelMessage()` 写死 `channelId: "weixin"`。多渠道实例化后必须改成 adapter 实例 ID。

目标：

```ts
export function weixinMessageToChannelMessage(input: {
  channelId: string;
  accountId: string;
  raw: WeixinMessage;
}): ChannelMessage
```

或等价签名：

```ts
weixinMessageToChannelMessage(channelId: string, accountId: string, raw: WeixinMessage): ChannelMessage
```

要求：

- `WeixinAdapter` 构造参数支持 `id?: string`，默认仍为 `"weixin"`，保证单渠道兼容。
- `routeKey` 使用 `this.id` 生成。
- `ChannelMessage.channelId` 使用 `this.id`。
- 所有出站仍按 `target.channelId` 由 registry 找到对应 WeixinAdapter。
- 当前微信运行能力声明为 `direct: true, group: false, thread: false`；`group` 或 `thread` 必须等真实链路验证后再打开。

### 13.6 实施迭代

建议按以下顺序落地，每一步保持测试通过并写中文测试报告：

1. P0 基线确认。
   - 记录当前 `git status --short`，区分本次工作和已有未提交改动。
   - 运行现有测试；如果微信真实链路需要用户登录，报告里标明待补测。
   - 确认本轮不改配置文件、启动向导、`/cwd` 和真实第二渠道。

2. P1 `ChannelRegistry` 单元测试先行。
   - 新增 `src/channels/registry.ts`。
   - 测重复 channelId、按 target 投递、缺失 channel 报错、capability 查询、delivery policy 查询。
   - 测 adapter 入站 `message.channelId` 与 adapter id 不一致时拒绝。
   - 测一个 adapter start 失败时错误可观测，其他 adapter 不被静默替代。
   - 不改 Bridge 行为。

3. P2 Bridge 接入 registry，保留单 channel 兼容。
   - `BridgeOptions` 支持 `channel` 或 `channels`。
   - 所有出站走 registry。
   - 现有 mock、terminal、weixin 测试必须不改或少改后通过。
   - `/status` 仍默认展示当前 route 所属渠道状态。

4. P3 WeixinAdapter 实例 ID 改造。
   - `weixinMessageToChannelMessage` 使用 adapter 实例 ID。
   - 单测覆盖非默认 channelId，例如 `weixin-main`。
   - 确认统一入口下微信默认仍产生稳定 routeKey。
   - 确认二维码登录、备链二维码打印逻辑不因实例 ID 改造回退。

5. P4 `SessionBindings` 和 `MemoryStateStore` 集成。
   - 新增 owner 反向索引。
   - `/new` 新 session 自动归属当前 route。
   - `/resume`、`/use` 认领无 owner session。
   - 已属于其他 route 的 session 拒绝绑定。
   - resume 失败时回滚本次新认领 owner，避免脏 owner 锁死 session。

6. P5 Bridge session 绑定逻辑统一。
   - `createNewSession()`、`ensureSession()`、`resumeOrUseSession()` 都通过 binding API。
   - pending approval 或 running turn 场景下，切换 session 的安全规则保持现有行为或显式拒绝。
   - `/sessions` 默认只列当前 route 拥有的 session；全量视图后续做管理员能力。

7. P6 `TurnScheduler` 接口接入。
   - 默认 `UnlimitedTurnScheduler`。
   - `forwardPrompt` 外层通过 scheduler 包裹。
   - 单测覆盖 unlimited 不排队，limited=1 会排队。
   - limited 等待期间收到 `/stop` 时，尚未进入 Codex 的任务不能再启动。

8. P7 多渠道集成测试。
   - 两个 mock channel 进入同一个 Bridge。
   - A 渠道消息只回 A，B 渠道消息只回 B。
   - 两个不同 route 默认可并行。
   - 同 route 仍串行排队。
   - A route 的 `/OK` 不能处理 B route 的 pending approval。
   - A route 的 `/stop` 不能停止 B route 正在运行的 turn。

9. P8 RouteRuntime 拆分。
   - 在前面能力稳定后，把 route queue、worker、progress/collaboration mode 等状态迁出 `bridge.ts`。
   - 拆分前后必须保持测试行为一致。
   - 如果拆分会扩大风险，可以留到下一轮，但必须在测试报告里写明原因和后续切分点。

### 13.7 验收测试矩阵

单元测试：

- `tests/unit/channel-registry.test.ts`
- `tests/unit/session-bindings.test.ts`
- `tests/unit/turn-scheduler.test.ts`
- `tests/unit/weixin-message-mapping.test.ts` 增加实例 channelId 用例。

集成测试：

- `tests/integration/bridge-mock.test.ts` 增加双 mock channel 场景。
- 覆盖两个渠道同时入站、出站回投正确渠道。
- 覆盖 `/resume` owner 冲突。
- 覆盖同 route 串行、不同 route 默认并行。
- 覆盖 delivery policy 仍按来源渠道生效。

本地验证命令：

```bash
npm run build
node --test dist/tests/unit/channel-registry.test.js
node --test dist/tests/unit/session-bindings.test.js
node --test dist/tests/unit/turn-scheduler.test.js
npm test
git diff --check
```

测试报告：

- 每个实现阶段都在 `reports/tests/` 新增中文报告。
- 报告必须说明真实微信链路是否涉及；本轮核心多渠道可以先用 mock/local 验证，真实微信多实例留作后续补测。

### 13.8 模块拆分要求

- 遵守 `docs/development-and-test.zh-CN.md` 的模块拆分规范。
- 不把 Channel Registry、session owner 检测、turn scheduler 和启动向导继续堆进 `bridge.ts`。
- `bridge.ts` 后续主要保留编排逻辑；纯状态、投递路由、binding、scheduler 应分别进入独立模块。
- 新增模块的共享类型放在对应模块或 `src/protocol/`，不要跨层导入具体 adapter 内部类型。
- 每一步都要保证现有单渠道入口兼容。

### 13.9 完成定义

本轮核心多渠道内核可以认为完成，需要同时满足：

- 一个 Bridge 进程可持有至少两个 mock channel adapter。
- 出站消息、审批提示、错误和媒体结果都按 `target.channelId` 回到原渠道。
- 同 route 普通 prompt 串行；不同 route 默认并行。
- `sessionId -> ownerRouteKey` 生效，跨 route `/resume` 被拒绝。
- `maxConcurrentTurns` 默认 unlimited；设置为 `1` 时普通 prompt 全局串行，命令和审批响应不被阻塞。
- 统一 `chat-codex` 入口和 `terminal codex` 开发入口保持可用。
- 已按规范新增/更新测试和中文测试报告。

## 14. 待确认问题

- `maxConcurrentTurns` 的默认值：默认不限制不同 route 并行；需要背压时由 CLI 交互或启动参数设置为正整数。
- `/sessions all` 的权限模型：建议默认管理员可用，普通用户只看当前 route。
- 是否需要 session 转移命令：MVP 不需要；如要做，必须有确认词和审计日志。
- 多渠道 transcript 展示格式：建议统一显示 `channelId/accountId/conversationKind/conversationId`，verbose 模式再显示 sender。
