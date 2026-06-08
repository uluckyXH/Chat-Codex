# 飞书适配设计

## 目标

第一阶段目标是把中间件接入飞书私聊，让用户可以在飞书一对一聊天里使用 Codex。

范围：

- 支持一个飞书自建应用机器人账号。
- 通过飞书长连接 WebSocket 接收事件。
- 支持私聊文本、图片和文件消息。
- 复用现有 Bridge 的 route/session 绑定、`/new`、`/resume`、`/use`、`/status`、审批和队列能力。
- 飞书默认投递普通文本进度信息，和微信默认抑制进度不同。

不在第一阶段做：

- 群聊、话题/thread、文档评论事件、会议邀请事件。
- 交互式卡片、卡片更新、流式卡片。
- 飞书文档/多维表格/日历/任务工具。
- 用户身份 OAuth 或以用户身份发消息。
- webhook 入站模式。

群聊后续设计见 `docs/feishu-group-chat-design.zh-CN.md`。群聊开启时必须同时处理 @bot 触发、route 配对、群内审批权限、小黑屋和发言人身份展示，不能只把 `group: false` 改成 `true`。

## 参考来源

本地最新 npm 发布包：

```text
openclaw-lark-npm/extracted/openclaw-lark-2026.5.13/
```

确认信息：

- npm 包：`@larksuite/openclaw-lark`
- 版本：`2026.5.13`
- SHA-256：`73e41d9927fbe45a2aff829464bd431f2d99acbe1238222ee469d84e4fb49b9d`

关键参考文件：

- `src/core/lark-client.js`
- `src/channel/monitor.js`
- `src/channel/event-handlers.js`
- `src/messaging/inbound/parse.js`
- `src/messaging/outbound/send.js`
- `src/core/config-schema.js`
- `src/core/accounts.js`

官方插件结论：

- 当前 monitor 路径默认 `connectionMode = "websocket"`。
- `webhook` 在 monitor 路径里明确标注为未实现。
- 入站使用 `@larksuiteoapi/node-sdk` 的 `WSClient`。
- 事件分发使用 `EventDispatcher`，注册 `im.message.receive_v1` 等事件。
- WebSocket 启动前会用 app credentials probe 机器人身份，拿到 bot open_id，随后用它过滤 self-echo。

因此第一阶段应直接采用飞书 WebSocket 长连接，不做 webhook。

## 现有中间件契约

飞书适配器实现同一套 `ChannelAdapter`：

```ts
interface ChannelAdapter {
  id: string;
  label: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  login?(): Promise<ChannelLoginResult>;
  getStatus(): Promise<ChannelStatus>;
  getCapabilities(): ChannelCapabilities;
  getDeliveryPolicy?(message?: ChannelMessage): ChannelDeliveryPolicy;
  onMessage(handler: ChannelMessageHandler): void;
  sendText(target: ChannelTarget, text: string, options?: SendOptions): Promise<SendResult>;
  sendMedia?(target: ChannelTarget, media: ChannelMedia, options?: SendOptions): Promise<SendResult>;
  sendTyping?(target: ChannelTarget, typing: boolean, options?: SendOptions): Promise<void>;
}
```

Bridge 不关心飞书 SDK、WebSocket、token、加解密、事件去重和消息格式。飞书私有字段只放在 `raw` 或 `target.context`。

## 依赖选择

新增运行依赖：

```json
"@larksuiteoapi/node-sdk": "^1.64.0"
```

第一阶段不直接依赖 `@larksuite/openclaw-lark`，只参考其实现。原因：

- 该包是 OpenClaw 插件，核心入口依赖 OpenClaw runtime 和 plugin-sdk。
- 本项目目标是独立中间件，不启动 OpenClaw gateway/host/runtime。
- 直接引入飞书官方 Node SDK 能保持适配器边界清晰。

## 配置

第一阶段先用环境变量和启动参数，避免先做完整持久化配置系统。

建议字段：

```text
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_ENCRYPT_KEY=xxx          # 可选
FEISHU_VERIFICATION_TOKEN=xxx   # 可选
FEISHU_DOMAIN=feishu            # feishu | lark，默认 feishu
FEISHU_ACCOUNT_ID=default       # 默认 default
```

真实本地测试密钥可以放在忽略目录：

```text
secrets/feishu.local.md
```

该文件可以写成可复制到终端的 `export FEISHU_APP_ID=...` 格式。`secrets/` 已加入 `.gitignore`，仓库文档和测试报告不得记录真实 `appSecret`。通过 `chat-codex` 交互添加飞书机器人时，凭证也可以写入本机 `~/.chat-codex/state/channels/feishu/<channelId>/accounts/<accountId>/credentials.local.json`，用于重启后自动恢复。

后续多渠道配置落地后，再迁移到：

```json
{
  "channels": [
    {
      "id": "feishu-main",
      "type": "feishu",
      "enabled": true,
      "accountId": "default",
      "appId": "...",
      "appSecretRef": "...",
      "domain": "feishu",
      "connectionMode": "websocket"
    }
  ]
}
```

安全要求：

- `appSecret` 不写入测试报告、日志、`config.json`、`instance.json` 或 `account.json`。
- `.env`、secrets 和 state 目录不提交。
- CLI 状态页只显示 appId 尾部或账号别名，不打印 secret。

## FeishuAdapter

新增目录：

```text
src/channels/feishu/
```

当前实现文件：

```text
src/channels/feishu/feishu-adapter.ts
src/channels/feishu/feishu-media.ts
src/channels/feishu/feishu-message.ts
src/channels/feishu/feishu-types.ts
src/cli/feishu.ts
```

### 能力声明

当前第一阶段：

```ts
getCapabilities() {
  return {
    text: true,
    media: true,
    receiveMedia: true,
    typing: true,
    direct: true,
    group: false,
    thread: false,
    login: "token",
    messageUpdate: false,
    streamingHint: true,
  };
}
```

说明：

- 飞书官方能力支持群聊、thread、媒体、反应和卡片，但 adapter 只声明实际已实现能力。
- `media=true` 表示已实现出站图片/文件发送；`receiveMedia=true` 表示已实现入站图片/文件接收、下载和本地保存。
- `typing` 用官方插件同款 reaction 方案实现：处理期间给入站消息添加 `Typing` 表情，完成后移除。
- `messageUpdate` 第一阶段不做；进度先以普通文本投递。
- `streamingHint` 可以为 true，表示该渠道适合接收进度/阶段性输出；实际是否发送由 `ChannelDeliveryPolicy` 和 `/progress` 控制。

### 投递策略

飞书不覆盖默认投递策略：

```ts
getDeliveryPolicy() {
  return FEISHU_DELIVERY_POLICY;
}
```

实际效果：

- `taskStart: "send"`：收到普通任务后发送“Codex 正在处理”。
- `progress: "send"`：默认投递普通文本摘要进度；Codex 旁白通过独立 `assistant.commentary` 事件在 brief/realtime 下投递。
- `realtimeProgress: "send"`：飞书中允许 `/progress realtime` 逐条投递普通文本进度。
- `allowedProgressModes: ["realtime", "silent", "brief"]`：飞书中只公开 realtime、silent 和 brief。
- `progressCommand: "enabled"`：飞书中允许 `/progress realtime|silent|brief`。
- 没有微信专用 `/fff` 刷新命令。

Bridge 当前默认进度模式是 `brief`，投递 Codex 旁白、reasoning、todo、search、file_change、other 等摘要进度。用户可在飞书里发送：

```text
/progress realtime
/progress brief
/progress silent
```

后续如果普通文本进度太吵，再实现飞书卡片聚合：

- adapter 将 `getDeliveryPolicy().progress` 改成 `aggregate`。
- Bridge 或 adapter 增加进度聚合/更新接口。
- 用飞书 interactive card 或 message update 做单卡片刷新。

第一阶段先不做聚合，保持 Bridge 无飞书分支。

## 入站 WebSocket

启动流程：

1. 读取配置，校验 `appId` 和 `appSecret`。
2. 创建 `Lark.Client`。
3. probe 机器人身份，保存 `botOpenId` 和 `botName`。
4. 创建 `EventDispatcher`，传入 `encryptKey` 和 `verificationToken`。
5. 注册 `im.message.receive_v1`。
6. 创建 `WSClient`。
7. 调用 `wsClient.start({ eventDispatcher })`。
8. `stop()` 时关闭 WSClient 并清理状态。

状态映射：

- 缺少 appId/appSecret：`login_required`
- probe 成功但 WebSocket 未启动：`starting`
- WebSocket 已启动：`connected`
- WebSocket 报错但可重试：`degraded`
- credentials 错误或启动失败：`failed`
- stop 后：`stopped`

第一阶段可以把 WebSocket 的“已调用 start”视为 connected；后续如果 SDK 暴露连接状态事件，再细化成真实连接态。

### 事件过滤

只处理：

```text
im.message.receive_v1
message.chat_type === "p2p"
message.message_type === "text" | "image" | "file" | "post"
sender.sender_type !== "bot" && sender.sender_type !== "app"
sender.open_id !== botOpenId
```

暂时跳过：

- `chat_type === "group"`
- `audio`、`video`、`sticker` 等尚未映射到通用附件的媒体类型
- 用户 reaction 事件
- card action 事件
- bot 加群/退群事件
- drive comment 事件
- vc meeting invited 事件

跳过时只记录本地日志，不回复用户，避免噪音。

### 去重和过期

WebSocket 重连可能重放事件。第一阶段需要 adapter 内维护内存去重：

```text
message_id -> seenAt
```

建议默认：

- TTL：10 分钟
- 最大条数：5000

过期消息策略：

- 如果 `message.create_time` 早于当前时间 10 分钟以上，默认丢弃。
- 后续可通过配置调整，避免进程重启后处理大量历史消息。

## 消息映射

飞书事件示例字段来自官方插件 `FeishuMessageEvent`：

```text
event.message.message_id
event.message.chat_id
event.message.chat_type
event.message.message_type
event.message.content
event.sender.sender_id.open_id
event.sender.sender_type
event.message.create_time
```

当前支持：

- `message_type === "text"`：解析 `content.text` 为普通文本。
- `message_type === "image"`：解析 `image_key` 为图片附件，并通过 `im.messageResource.get` 下载保存。
- `message_type === "file"`：解析 `file_key`、`file_name`、`file_size` 为文件附件，并通过 `im.messageResource.get` 下载保存。
- `message_type === "post"`：从富文本 content 中提取文本段和 `image_key` / `file_key` 附件。

飞书 text content 通常是 JSON 字符串：

```json
{"text":"hello"}
```

映射到 `ChannelMessage`：

```ts
{
  id: message.message_id,
  channelId: "feishu",
  accountId: accountId,
  routeKey: buildRouteKey({
    channelId: "feishu",
    accountId,
    conversationKind: "direct",
    conversationId: message.chat_id
  }),
  sender: {
    id: sender.sender_id.open_id,
    displayName: sender.sender_name ?? sender.name ?? sender.user_name ?? undefined
  },
  conversation: {
    id: message.chat_id,
    kind: "direct",
    displayName: undefined
  },
  text,
  timestamp: new Date(Number(message.create_time)).toISOString(),
  raw: event
}
```

为什么 direct route 用 `chat_id`：

- 飞书私聊本质仍有会话 ID。
- 出站发消息可以直接使用 `chat_id`。
- route 绑定应按“这个飞书私聊会话”隔离，而不是按用户 open_id 猜测。

当前不再为飞书私聊做名称补齐。运行日志、TUI 聊天绑定列表和群聊发言人前缀的展示策略见 [飞书名称展示与群聊名册设计](feishu-user-name-cache-design.zh-CN.md)。核心原则：

- 私聊不调用通讯录接口，也不读取私聊事件名称字段，日志至少展示 `私聊:<chat_id> | <open_id>`。
- 群聊展示名优先走群内手工成员名册；权限判断仍使用 `open_id`。
- 名称缺失不影响私聊消息；群聊普通任务可按 `/name` 名册策略提示用户补齐。

## 出站文本

优先用飞书 `im.message.reply` 回复原消息：

- `target.context.sourceMessageId` 存在时，调用 `client.im.message.reply`。
- content 使用 `msg_type: "post"` 或 `msg_type: "text"`。

第一阶段建议使用 `post`，复用官方插件思路，能更好展示 markdown：

```json
{
  "zh_cn": {
    "content": [[{ "tag": "md", "text": "..." }]]
  }
}
```

如果 reply 失败，回退到 `im.message.create`：

- `receive_id_type: "chat_id"`
- `receive_id: target.conversation.id`

`SendResult`：

```ts
{
  channelId: target.channelId,
  messageId: response.data.message_id,
  deliveredAt: new Date().toISOString(),
  raw: response
}
```

## 出站图片和文件

飞书 adapter 已实现 `sendMedia()`：

- 图片：读取本地文件或 URL 为 `Buffer`，调用 `client.im.image.create({ image_type: "message" })` 上传，拿到 `image_key` 后发送 `msg_type: "image"`。
- 文件：读取本地文件或 URL 为 `Buffer`，按扩展名映射 `pdf` / `doc` / `xls` / `ppt` / `mp4` / `opus`，其它类型使用 `stream`，调用 `client.im.file.create` 上传，拿到 `file_key` 后发送 `msg_type: "file"`。
- 如果 `ChannelMedia.caption` 存在，先发送一条 `post` 文本说明，再发送媒体消息。
- 发送仍优先 `reply` 原消息，失败后回退 `message.create` 到当前 `chat_id`。

## 输入状态 / 处理中表情

飞书没有像微信 `sendtyping` 这样的一级 typing 接口。官方插件的处理方式是：

1. 收到用户消息后，使用原消息 `message_id` 调用 `im.messageReaction.create`。
2. reaction 类型使用飞书内置表情 `Typing`，视觉上是敲键盘/输入中的提示。
3. Codex turn 结束、失败或被 `/stop` 停止后，使用返回的 `reaction_id` 调用 `im.messageReaction.delete` 移除。
4. 添加或删除失败只记录状态，不阻断消息处理和最终回复。

Bridge Core 已经在 Codex turn 生命周期里调用通用 `sendTyping(target, true/false)`。飞书 adapter 因此只需要把 `target.context.sourceMessageId` 映射到 reaction API：

```ts
await client.im.messageReaction.create({
  path: { message_id: sourceMessageId },
  data: {
    reaction_type: {
      emoji_type: "Typing",
    },
  },
});
```

删除时：

```ts
await client.im.messageReaction.delete({
  path: {
    message_id: sourceMessageId,
    reaction_id: reactionId,
  },
});
```

## 私聊与 session 绑定

飞书私聊 route 使用同一套 Bridge 规则：

```text
routeKey = feishu:<accountId>:direct:<chat_id>
```

用户在飞书私聊中：

- 首条普通消息按 `unboundRoutePolicy` 创建或询问 session。
- `/new` 为当前飞书私聊创建新 session。
- `/resume` 进入编号选择模式。
- `/use` 切换当前飞书私聊的 active session。
- 一个 Codex session 仍只能归属一个 route，不能同时给微信和飞书使用。

第一阶段不需要飞书专属 session 逻辑。

## CLI 入口

建议分两步实现。

### P1：飞书状态检查和统一入口

当前保留状态检查，真实启动统一走主入口：

```bash
npm run cli:feishu:status
npm run chat-codex
```

行为：

1. `feishu status` 读取 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_DOMAIN`、`FEISHU_ACCOUNT_ID` 等环境变量做一次性状态检查。
2. `chat-codex` 交互式添加飞书机器人时提示输入 App ID / App Secret，并保存到本机 `~/.chat-codex/state/channels/feishu/<channelId>/accounts/<accountId>/credentials.local.json`，重启后自动读取；该路径不在仓库内，不写入 Git。
3. 运行时加载凭证顺序为：当前进程内存、本机 `credentials.local.json`、环境变量。
4. probe 飞书机器人身份。
5. 展示中文状态摘要。
6. `chat-codex` 添加飞书机器人后，用户回到首页选择“启动服务”，再启动 WebSocket 长连接。

微信和飞书不再暴露单渠道 Codex 启动入口。

### P2：接入统一渠道向导

把 `serve` 的“管理渠道”从微信单选扩展为：

```text
1. 微信
2. 飞书
0. 返回
```

飞书管理页：

```text
Codex Chat Bridge
当前位置：首页 > 管理渠道 > 飞书

飞书
- App ID: cli_xxx123
- 机器人: Codex Bot
- 连接方式: WebSocket 长连接
- 状态: 已连接

操作
1. 检查配置
2. 启动/重连 WebSocket
3. 查看状态详情
0. 返回
```

由于飞书没有类似微信扫码的本地登录流程，CLI 里的“登录”更准确应叫“检查配置/连接”。

## 测试计划

单元测试：

- `parseFeishuTextContent` 能解析 text content。
- `feishuEventToChannelMessage` 能把 p2p text 事件映射为 `ChannelMessage`。
- `feishuEventToChannelMessage` 能把 p2p image/file 事件映射为 attachment。
- `parseFeishuMessageContent` 能从 post 富文本中提取文本和图片。
- 非 p2p 消息被跳过。
- bot/self echo 被跳过。
- `routeKey` 使用 `chat_id`。
- `getCapabilities()` 声明 direct/text/media/receiveMedia。
- `getDeliveryPolicy()` 返回默认投递策略。
- `sendText()` 优先 reply，失败后 fallback create。
- `sendMedia()` 能上传并发送图片和文件。
- 入站图片/文件资源能通过 `messageResource.get` 下载保存到本地。
- 缺少 credentials 时状态是 `login_required`。

集成测试：

- 用 fake Lark SDK/transport 注入一条私聊消息，Bridge 能创建 session 并回复。
- 飞书渠道默认发送 task-start 和 progress。
- `/progress silent` 后不再投递 progress。
- `/resume` 编号选择在飞书私聊 route 中正常工作。
- stop 时关闭 WebSocket。
- CLI help 暴露 `feishu status`，飞书启动统一通过 `chat-codex`。

真实验证：

1. 创建飞书自建应用。
2. 配置机器人能力和事件订阅。
3. 启用长连接事件。
4. 配置 `im.message.p2p_msg:readonly`、`im:message:send_as_bot` 等最小权限。
5. 设置环境变量。
6. 运行 `npm run chat-codex`，添加飞书机器人并启动服务。
7. 给机器人发私聊文本。
8. 给机器人发私聊图片和文件。
9. 确认飞书里能看到：
   - task-start
   - 普通文本进度
   - 最终回复
   - `/status`
   - `/new`
   - `/resume` 编号选择
   - 图片-only 的中间件提醒
   - 图片/文件加说明后进入 Codex

## 风险

- WebSocket 连接状态可观测性不足：SDK `start()` 不一定代表业务事件已经可达，需要真实事件验证。
- 飞书 markdown/post 格式与普通 text 的展示差异需要实测。
- 进度以多条普通消息投递可能刷屏；但第一阶段保留默认 brief，可通过 `/progress silent` 临时关闭。
- 长连接重连可能重放事件，必须做 message_id 去重。
- 飞书开放平台权限配置复杂，错误会表现为收不到事件或发不出消息，需要状态详情显示 appId、botOpenId、最近错误和缺失权限提示。

## 实施顺序

1. 添加 `@larksuiteoapi/node-sdk` 依赖。
2. 新增 `src/channels/feishu`，实现 credentials、client、WS lifecycle 和私聊文本转换。
3. 加 fake SDK 单元测试。
4. 加 `feishu status` 状态检查入口。
5. 用 Bridge 集成测试验证默认进度投递。
6. 本地真实飞书机器人验证。
7. 把飞书纳入统一 `chat-codex` 渠道管理页。

当前代码已完成 1-5。第 6 步需要真实飞书应用完成事件订阅后，由用户在飞书私聊里发送消息验证；第 7 步留到统一渠道向导迭代。

## 开发规范与验收标准

第一阶段实现必须遵守 [开发与测试规范](development-and-test.zh-CN.md)。本节是飞书适配的补充边界和验收标准。

### 代码边界

- 飞书平台代码只放在 `src/channels/feishu/`。
- Bridge Core 不允许 import 飞书 SDK、飞书事件类型或飞书工具实现。
- 飞书私有字段只放在 `ChannelMessage.raw` 或 `ChannelTarget.context`。
- 通用能力缺口先通过 `ChannelAdapter`、`ChannelCapabilities`、`ChannelDeliveryPolicy` 表达，不在 Bridge 里写 `if channelId === "feishu"`。
- 第一阶段不引入 OpenClaw runtime，不依赖 `@larksuite/openclaw-lark` 包运行，只参考其源码。
- 第一阶段只声明已实现能力：私聊、文本、默认进度投递。

### 配置与安全

- `appSecret`、`encryptKey`、`verificationToken` 不写入日志、测试报告和状态详情。
- `.env`、secrets、本地 state、token、credential 文件不提交。
- 状态输出可以显示 appId、accountId、botOpenId、botName 和最近错误，但必须隐藏 secret。
- 缺少 appId/appSecret 时状态必须是 `login_required`，不能在启动后才抛不清晰的 SDK 错误。

### 入站要求

- 只处理 `im.message.receive_v1`。
- 只处理 `chat_type === "p2p"`。
- 必须过滤 bot/self echo。
- 必须按 `message_id` 做内存去重。
- 必须丢弃明显过期的重放消息。
- text content 解析失败时不能崩溃，应记录错误并忽略该消息或回复可理解错误。

### 出站要求

- `sendText()` 优先用 `im.message.reply` 回复 `sourceMessageId`。
- reply 失败时 fallback 到 `im.message.create`，目标使用 `chat_id`。
- 飞书发送失败要更新 `lastError`，但不能让 Bridge 崩溃。
- 第一阶段进度以普通文本消息投递，不做卡片聚合。

### Bridge 能力验收

飞书私聊接入后，以下命令必须可用并复用现有 Bridge 行为：

```text
/help
/status
/new
/resume
/use
/sessions
/progress
/stop
/permission
/model
/plan
/code
```

其中：

- `/progress` 在飞书中默认启用。
- 默认 progress mode 是 `brief`。
- `/progress silent` 后不再投递进度。
- `/resume` 和 `/use` 不带参数时进入编号选择模式。
- session 归属规则和微信一致，一个 Codex session 只能绑定一个 route。

### 测试门槛

实现 PR 合入前至少通过：

```bash
npm run test:unit
npm run test:integration
npm test
git diff --check
```

新增测试报告放在：

```text
reports/tests/YYYY-MM-DD-feishu-private-chat-adapter.md
```

真实飞书验证完成后，报告必须记录：

- 使用的连接方式：WebSocket 长连接。
- 验证的事件类型：`im.message.receive_v1`。
- 私聊文本入站和文本出站结果。
- task-start、progress、final reply 是否都投递到飞书。
- `/help`、`/status`、`/new`、`/resume`、`/progress silent` 的手工验证结果。
