# `/new chat` Codex App 对话会话设计

## 背景

Chat-Codex 当前已经支持聊天内 `/new`：

```text
/new
```

它会为当前微信/飞书 route 创建一个新的 Codex session，并立即把这个 session 绑定到当前 route。这个行为满足 Chat-Codex 的核心路由模型：

```text
一个 route 独立绑定一个 Codex session
一个 Codex session 只能被一个 route 绑定
```

但用户在 Codex App 中看到的是“对话/会话”列表。经过源码确认，Codex App 的列表不是只看 thread id 是否存在，还会依赖本地 Codex 元数据：

- `~/.codex/state_5.sqlite`
- `~/.codex/sessions/**/*.jsonl`
- thread 的 `source`
- thread 的 `cwd`
- thread 的 `preview`
- thread 是否 `archived`
- App 当前是否添加了对应工作目录

其中官方 state 查询会过滤掉 `preview` 为空的 thread：

```text
threads.preview <> ''
```

因此，只调用 `thread/start` 创建出来的空 session，虽然已经存在于 Codex 本地状态里，但不会稳定显示在 Codex App 的对话列表中。等这个 session 收到第一条真实用户 prompt 后，Codex 才会写入 `preview`，App 才会把它归入“对话”列表。

实测确认：只设置 `thread/name/set` 不足以让空 session 出现在 App “对话”列表。因为 thread name 只影响标题，列表过滤仍要求 `preview` 非空。

## 目标

1. 保留 `/new` 当前语义，不破坏现有 route/session 绑定模型。
2. 新增 `/new chat`，作为“创建面向 Codex App 对话列表的新会话”的明确入口。
3. `/new chat` 创建的新 session 仍然归属当前 route，继续遵守 session owner 唯一约束。
4. 尽量让新 session 在 Codex App 中显示为可读、可识别的对话。
5. 不通过伪造用户消息或写 rollout 历史来制造 App 可见性。
6. 裸 `/new chat` 也要尽量立即进入 Codex App “对话”列表。
7. 技术实现尽量复用现有 app-server adapter、session flow、route queue 和命令路由。

## 非目标

- 不改变 `/new` 的现有行为。
- 不创建没有 route owner 的游离 Codex session。
- 不允许多个 route 共享同一个 App 对话 session。
- 不为了让空会话立刻出现在 App 列表而写入假的首条用户消息。
- 不直接写 Codex rollout JSONL。
- 不伪造 `first_user_message`。
- 不修改 Codex App 自身的列表过滤逻辑。
- 不在第一版实现 TUI 专门管理 App 对话会话。

## 用户语义

### `/new`

保持现状：

```text
/new
```

含义：

```text
创建新的 Codex session，并绑定到当前聊天 route。
```

特点：

- 不主动设置 App 对话标题。
- 不主动发送首条 prompt。
- 可能要等用户后续发送第一条普通消息后，才在 Codex App 列表中稳定出现。

### `/new chat`

新增命令：

```text
/new chat
```

含义：

```text
创建一个新的 Codex session，并按 Codex App 对话体验做初始化。
```

第一版行为：

1. 创建新的 Codex session。
2. 绑定到当前 route。
3. 设置 App 侧 thread name。
4. 如果 `preview` 为空，用标题写入本机 Codex state DB 的 `preview` 字段，便于空 session 进入 App 对话列表。
5. 回复用户当前 session id、工作目录和 App 可见性说明。
6. 不自动投递 fake prompt。

示例回复：

```text
已创建 Codex App 对话

Session: 019e...
标题: 微信 / 小黄
工作目录: /Volumes/MacSSD/Repositories/my-project

已写入 Codex preview，空对话也应能进入 Codex App 对话列表。
如果 Codex App 已添加这个工作目录，会在 App 的对话列表中显示。
```

### `/new chat <首条任务>`

新增命令：

```text
/new chat 帮我检查这个项目的测试结构
```

含义：

```text
创建新的 App 对话 session，并把后面的文本作为这个 session 的第一条真实用户 prompt 执行。
```

行为：

1. 创建新的 Codex session。
2. 绑定到当前 route。
3. 设置 App 侧 thread name。
4. 把 `帮我检查这个项目的测试结构` 作为第一条真实 prompt 放入当前 route queue。
5. 先把这条真实 prompt 写入 state DB `preview`，让 App 列表可以尽快显示。
6. Codex 执行后会自然维护 `preview` 和 rollout 历史。

这不是 fake message，因为用户明确把任务写在 `/new chat` 后面。

## Codex App 可见性规则

Chat-Codex 只能提高被 App 识别的概率，不能强行改变 App 的过滤规则。用户仍需要满足：

1. Codex App 和 Chat-Codex 使用同一个 `CODEX_HOME`。
2. Codex App 已添加或正在查看该 session 的工作目录。
3. session 没有被归档。
4. session 的 `source` 在 App 默认展示范围内。
5. session 已有非空 `preview`。裸 `/new chat` 会用标题补齐；`/new chat <prompt>` 会用用户明确输入的首条 prompt 补齐。

当前 Chat-Codex 通过 `codex app-server` 创建 session，且没有显式传 `--session-source`。Codex 官方默认 `session-source` 是 `vscode`，它属于默认交互式来源，能被 App 和普通 `codex resume` 默认列表识别。

第一版不把 source 改为 `chat-codex`，因为自定义 source 可能导致 Codex App 默认列表不显示。

## 工作目录规则

`/new chat` 使用和 `/new` 完全一致的新 session 工作目录：

```text
Chat-Codex 当前配置的“新 session 工作目录”
```

默认情况下，这个目录来自启动 `chat-codex` 时的 `process.cwd()`。

如果用户在 TUI/CLI 中修改了“新 session 工作目录”，`/new chat` 也使用修改后的目录。

恢复已有 session 时仍使用该 session 原本记录的 `cwd`，不受 `/new chat` 影响。

## 标题规则

`/new chat` 创建 session 后，应通过 Codex app-server 的官方方法设置 thread name：

```text
thread/name/set
```

标题优先使用当前 route 的用户可读信息：

```text
微信 / <微信账号备注或 accountId> / <聊天名或发送人名>
飞书 / <机器人备注或 accountId> / <私聊用户名或 chat_id>
```

如果缺少可读名，降级为：

```text
微信 / default / direct
飞书 / default / direct
```

标题只用于 Codex App 和 session 列表展示，不参与 routeKey 生成，不改变绑定关系。

## 命令解析

现有 `parseCommand()` 会把命令拆成：

```text
name = "new"
args = ["chat", ...]
raw = 原始文本
```

因此 `/new chat` 不需要新增顶层命令，只需要扩展 `new` 命令分支：

```text
/new
/new chat
/new chat <prompt>
```

解析规则：

1. `name !== "new"`：不进入本逻辑。
2. `args[0] !== "chat"`：保持原 `/new`。
3. `args[0] === "chat"`：进入 App 对话创建逻辑。
4. 首条 prompt 从原始文本中按正则提取：

```text
^/new\s+chat\b
```

去掉前缀后的剩余文本就是第一条 prompt。

## 技术方案

### 1. CodexAdapter 扩展

新增可选能力：

```ts
setSessionTitle?(sessionId: string, title: string): Promise<void>;
setSessionPreview?(sessionId: string, preview: string): Promise<void>;
```

app-server adapter 实现：

```text
method: thread/name/set
params:
  threadId: sessionId
  name: title
```

mock adapter 实现为记录 title，方便单元测试。

`setSessionPreview` 只用于 App 列表可见性，不写入 rollout，也不伪造用户消息。

app-server adapter 实现：

```text
目标文件: <CODEX_HOME>/state_5.sqlite
目标表: threads
目标字段: preview
写入条件:
  - id = sessionId
  - archived = 0
  - preview 当前为空
写入值:
  - /new chat: App 对话标题
  - /new chat <prompt>: 用户明确输入的 <prompt>
```

写入后必须再读取同一条 thread 确认 `preview` 已非空。不能把 `UPDATE changes() = 0` 一律当成功，因为真实 app-server 可能已经返回 `thread/start` 结果，但 `threads` 行尚未稳定落到 `state_5.sqlite`。如果 thread 行暂时不存在、数据库暂时不存在，或 sqlite 返回短暂 `locked/busy`，实现应短暂重试后再判断失败。

这个 sqlite 写入是一个窄口兼容层，原因是当前官方 app-server 只提供 `thread/name/set`，没有单独 `thread/preview/set`，但 App thread list 又强制过滤 `preview <> ''`。

exec adapter 第一版可不实现。因为 `codex exec` 不是面向 App 交互会话的主路径，且当前 Chat-Codex 默认真实接入是 app-server。

调用方必须把这个能力当可选能力处理：

```text
支持 setSessionTitle -> 创建后设置 App 标题
不支持 -> 仍创建 session，但回复中说明当前 adapter 不支持 App 标题同步
支持 setSessionPreview -> 空会话也尽量进入 Codex App 对话列表
不支持 -> 仍创建 session，但回复中说明空会话可能不会立刻出现在 App 对话列表
```

### 2. BridgeSessionFlow 扩展

新增方法：

```ts
createNewAppChatSession(
  message: ChannelMessage,
  target: ChannelTarget,
  options?: {
    firstPrompt?: string;
  },
): Promise<CodexSession>;
```

内部流程：

1. 调用 `codex.startSession()` 创建 session。
2. `state.bindSession(message.routeKey, session)`。
3. `applyStoredSessionRunPolicy(session.id)`。
4. `clearPendingInitialRouteBindingIfApplies(message)`。
5. `applyRouteCollaborationModeToSession(message.routeKey, session.id)`。
6. 生成 App 对话标题。
7. 如果 adapter 支持 `setSessionTitle`，调用 `setSessionTitle(session.id, title)`。
8. 如果 adapter 支持 `setSessionPreview`，调用 `setSessionPreview(session.id, firstPrompt || title)`。
9. 回复创建结果。

这个方法和 `createNewSession()` 的关键差异是：

- 会生成用户可读标题。
- 会尝试同步到 Codex App thread name。
- 会尝试补齐 Codex App 列表所需 preview。
- 会根据 `firstPrompt` 决定是否继续进入 route queue。

### 3. BridgeCommandRouter 扩展

`BridgeCommandHandlers.createNewSession` 当前只接收 `message, target`。

建议调整为：

```ts
createNewSession(
  message: ChannelMessage,
  target: ChannelTarget,
  args: string[],
  rawText: string,
): Promise<void>;
```

路由逻辑：

```ts
case "new":
  await this.handlers.createNewSession(message, target, args, rawText);
  return;
```

Bridge 中再判断：

```text
args[0] === "chat" -> createNewAppChatSession
否则 -> createNewSession
```

这样 command router 仍然只负责分发，不写具体业务细节。

### 4. 首条 prompt 投递

如果 `/new chat <prompt>` 中存在首条 prompt，不应在 `BridgeSessionFlow` 里直接执行 Codex turn。`BridgeSessionFlow` 只负责 session 绑定。

推荐由 Bridge 层完成：

1. 调用 `sessionFlow.createNewAppChatSession()`。
2. 消费 pending media。
3. 调用 `routeSteering.tryEnqueue()`；如果未命中 steer，则调用 `routeQueue.enqueuePrompt()`。

这样第一条 prompt 和普通消息走同一套：

- 队列
- 进度投递
- 审批
- 文件发送
- 错误处理
- busy guard

第一版可以只支持文本 prompt。附件和 pending media 是否合并到 `/new chat <prompt>` 的首轮任务，可以作为实现时的低风险复用项，不作为必须能力。

### 5. App 标题生成

新增一个纯函数：

```ts
formatAppConversationTitle(message: ChannelMessage, target: ChannelTarget): string;
```

建议规则：

```text
channelLabel / accountLabel / conversationLabel
```

可读名优先级：

```text
conversation.displayName
sender.displayName
recipient.displayName
conversation.id
sender.id
```

渠道名映射：

```text
weixin -> 微信
feishu -> 飞书
其他 -> 原 channelId
```

标题需要限制长度，避免 App 列表过长。建议 80 字以内，超出截断。

### 6. 状态持久化

`/new chat` 创建出来的 session 和 `/new` 一样：

- 写入 route active session。
- 写入 session owner。
- 写入 session policy。
- 写入 Codex 自己的 thread/session 元数据。

Chat-Codex 不需要额外新增一个“App chat session”状态文件。

为了让裸 `/new chat` 立即出现在 App “对话”列表，app-server adapter 会在 `preview` 为空时补写 Codex state DB 的 `threads.preview`。这属于 Codex 本地状态兼容写入，不进入 Chat-Codex 自有状态文件。

如果后续要在 TUI 中专门标记“这是通过 `/new chat` 创建的会话”，可以在 route/session 元数据中追加可选字段，但第一版不做。

### 7. 兼容和降级

如果当前 adapter 是 app-server：

```text
完整支持 /new chat
```

如果当前 adapter 是 exec：

```text
允许创建 session，但回复说明：
当前 Codex adapter 不支持同步 App 对话标题；建议使用默认 app-server 接入。
```

如果 `setSessionTitle` 调用失败：

```text
session 创建和绑定仍然成功；
回复中提示标题同步失败；
不回滚 session 创建。
```

标题同步失败不应该影响 route/session 绑定，因为 App 可见性不是 Chat-Codex 的安全边界。

如果 `setSessionPreview` 调用失败：

```text
session 创建和绑定仍然成功；
回复中提示 App 列表 preview 同步失败；
不回滚 session 创建。
```

preview 同步失败时，裸 `/new chat` 可能仍需要用户发送第一条任务后才会出现在 App 对话列表。

如果聊天侧已经回复“已写入 Codex preview”，则代表实现已经确认 state DB 中对应 `threads.preview` 非空。只创建了 thread name 但 `preview` 仍为空的旧会话不会出现在 App “对话”列表，需要重新执行 `/new chat` 或由维护工具补齐 preview。

## 并发和安全规则

`/new chat` 是 session 绑定修改命令，和 `/new` 一样必须受 busy guard 保护：

```text
当前 route 正在运行任务时，拒绝 /new chat。
```

未信任 route 不允许执行 `/new chat`。配对信任规则和 `/new` 一致：

```text
未配对 -> 只回复配对引导，不创建 session
已配对 -> 可以创建 session
```

`/new chat` 创建的 session 必须立即 claim owner，避免被其他 route 绑定。

## 用户提示文案

### 空 App 对话创建成功

```text
已创建 Codex App 对话

Session: 019e...
标题: 微信 / 小黄
工作目录: /repo

已写入 Codex preview，空对话也应能进入 Codex App 对话列表。
如果 Codex App 已添加这个工作目录，会在 App 的对话列表中显示。
```

### 带首条任务

```text
已创建 Codex App 对话

Session: 019e...
标题: 飞书 / 大龙虾 / 张三
工作目录: /repo

正在把后续文本作为这个对话的第一条任务执行。
如果 Codex App 已添加这个工作目录，会在 App 的对话列表中显示。
```

### adapter 不支持标题同步

```text
已创建 Codex session，但当前 Codex adapter 不支持同步 App 对话标题。

Session: exec-local-...
工作目录: /repo
```

## 测试计划

### 单元测试

1. `command-router`：
   - `/new` 仍走原创建逻辑。
   - `/new chat` 走 App 对话创建逻辑。
   - `/new chat hello` 能保留原始 prompt。

2. `BridgeSessionFlow`：
   - `createNewAppChatSession()` 创建并绑定 session。
   - session owner 写入正确。
  - 支持 `setSessionTitle` 时会调用标题同步。
   - 支持 `setSessionPreview` 时会补齐 App 列表 preview。
   - `setSessionTitle` 失败不回滚绑定。
   - `setSessionPreview` 失败不回滚绑定。

3. 标题生成：
   - 微信 route 能生成 `微信 / ...`。
   - 飞书 route 能生成 `飞书 / ...`。
   - 缺 displayName 时降级到 id。
   - 长标题会截断。

4. adapter：
   - app-server adapter 调用 `thread/name/set` 参数正确。
   - app-server adapter 能在 `preview` 为空时补写 Codex state DB preview。
   - mock adapter 能记录 title。
   - mock adapter 能记录 preview。

### 集成测试

1. mock channel 发送 `/new chat`：
   - 创建新 session。
   - 当前 route active session 指向新 session。
   - 回复包含 App 对话说明。

2. mock channel 发送 `/new chat 做一个测试`：
   - 创建新 session。
   - 首条 prompt 进入 route queue。
   - Codex 收到的 prompt 是 `做一个测试`。

3. busy route 下发送 `/new chat`：
   - 被拒绝。
   - 不创建新 session。

4. 未配对 route 发送 `/new chat`：
   - 只触发配对引导。
   - 不创建新 session。

### 手工验证

1. 在项目目录运行：

```bash
npm run chat-codex
```

2. 在微信或飞书发送：

```text
/new chat 帮我总结这个项目
```

3. 确认 Chat-Codex 回复 session id 和标题。
4. 打开 Codex App，添加相同工作目录。
5. 确认该对话出现在 App 对话列表中。
6. 确认标题可读，且能从 App resume。

## 实施顺序

1. 增加 `CodexAdapter.setSessionTitle?` 可选能力。
2. app-server adapter 实现 `thread/name/set`。
3. mock adapter 实现标题记录。
4. 增加 App 对话标题格式化函数及测试。
5. 扩展 `BridgeSessionFlow`，新增 `createNewAppChatSession()`。
6. 扩展 `BridgeCommandRouter` 和 Bridge handler，识别 `/new chat`。
7. 支持 `/new chat <prompt>` 首条 prompt 进入 route queue。
8. 补单元测试和集成测试。
9. 第一版曾更新 README 聊天命令说明；当前该能力保留为隐藏实现，README 和聊天 `/help` 不公开展示。
10. 追加测试报告到 `reports/tests/`。

## 设计结论

`/new chat` 已完成技术验证，但实际体验仍然归属于工作目录下的 Codex App 对话列表，和用户预期的独立“对话”能力不完全一致。因此当前保留实现和测试，但从 README 与聊天 `/help` 中隐藏，不作为公开推荐命令。

隐藏能力语义：

```text
/new
轻量创建并切换当前 route 的 Codex session。

/new chat
创建当前 route 的 Codex App 对话 session，同步可读标题，并补齐 App 列表所需 preview。

/new chat <prompt>
创建当前 route 的 Codex App 对话 session，用 <prompt> 补齐 App 列表 preview，并立即把 <prompt> 作为第一条真实任务执行。
```

这样既保留了 Chat-Codex 的 route/session 安全模型，也保留后续继续实验 Codex App 对话可见性的代码基础。
