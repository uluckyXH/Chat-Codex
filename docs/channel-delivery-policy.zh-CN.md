# Channel Delivery Policy 设计

本文档定义不同聊天渠道的消息投递策略。目标是让微信、Terminal、未来 Slack/Telegram/飞书等渠道可以按平台能力调整投递行为，同时避免 Bridge Core 到处出现 `if channel === "weixin"` 这类具体平台分支。

## 设计目标

- Bridge Core 只依赖通用 Channel 协议。
- 渠道差异通过 `ChannelDeliveryPolicy` 表达，而不是泄漏具体平台原始类型。
- 进度、开始提示、刷新命令等投递差异可以按渠道配置。
- 默认策略保持完整投递，保证 Terminal 和未来普通渠道天然可用。
- 微信等受限渠道可以在 adapter 层声明“少发消息”的策略。

## 策略接口

策略类型定义在 `src/protocol/delivery-policy.ts`：

```ts
type ChannelTaskStartDelivery = "send" | "suppress";
type ChannelProgressDelivery = "send" | "suppress" | "aggregate";
type ChannelProgressCommandMode = "enabled" | "disabled";

interface ChannelRefreshCommandPolicy {
  command: string;
  description: string;
  silent: boolean;
  replyText?: string;
}

interface ChannelDeliveryPolicy {
  taskStart: ChannelTaskStartDelivery;
  progress: ChannelProgressDelivery;
  progressCommand: ChannelProgressCommandMode;
  progressDisabledMessage?: string;
  statusProgressLabel?: string;
  statusProgressDescription?: string;
  refreshCommands: readonly ChannelRefreshCommandPolicy[];
}
```

`ChannelAdapter` 可选实现：

```ts
getDeliveryPolicy?(message?: ChannelMessage): ChannelDeliveryPolicy;
```

未实现时使用默认策略：

- `taskStart: "send"`
- `progress: "send"`
- `progressCommand: "enabled"`
- `refreshCommands: []`

微信 2.4.4 结构化工具进度适配时，计划额外扩展一类工具生命周期策略，例如：

```ts
type ChannelToolProgressDelivery = "send" | "suppress";

interface ChannelDeliveryPolicy {
  toolProgress?: ChannelToolProgressDelivery;
}
```

该字段只表达结构化工具生命周期是否发送，不等同于普通文本 progress。普通文本 progress 仍由 `progress` 和 route 级 `/progress` 模式控制。

## 当前渠道策略

### 默认/Terminal/Mock

默认策略完整投递：

- 发送 task-start。
- 按 `/progress brief|detailed|silent` 投递普通文本 progress。
- `/progress` 可用。
- 无额外 refresh 命令。

Terminal 因此能继续看到 Codex plan、reasoning summary、search、file change 等 progress。

### Weixin

微信 2.4.4 实验分支中，WeixinAdapter 返回微信专属低噪声策略：

- `taskStart: "suppress"`：不发送 `Codex 正在处理这条消息。`
- `progress: "send"`：允许普通文本进度按 route 模式投递。
- `toolProgress: "send"`：允许结构化工具生命周期投递。
- `progressCommand: "enabled"`：微信中 `/progress` 可配置 `brief/detailed/tools/silent`。
- `defaultProgressMode: "silent"`：默认不发送普通文本进度和结构化工具生命周期，只保留关键交互与最终回复。
- `refreshCommands: [{ command: "fff", silent: true }]`：`/fff` 静默处理，不回复、不入队、不转发给 Codex。
- `/status` 显示 `进度投递: 静默模式`。

微信 2.4.4 实验分支的目标不是把这个低噪声策略扩大到其它渠道，而是在微信 adapter 内独立放开：

- 普通文本进度：支持 `/progress brief|detailed|silent`，用于实测微信在 `context_token/run_id/typing keepalive` 链路下的承载能力。
- 结构化工具进度：新增 `/progress tools`，只发送 `TOOL_CALL_START/TOOL_CALL_RESULT` 这类工具生命周期，不携带 stdout/stderr 摘要。
- 默认持久模式建议保持低噪声，例如 `/progress silent`；需要实验结构化工具生命周期时再手动切到 `/progress tools`。
- `/plan` 可以对当前 turn 使用临时 detailed effective mode，但不改 route 持久化 `/progress` 配置。

微信仍发送关键消息：

- final answer
- Plan mode final plan
- error / turn failed
- approval request
- approval result
- queue notice
- media send result
- user-initiated command replies

## Bridge 行为

Bridge 只读取策略，不判断具体渠道名：

- `taskStart === "send"` 时发送任务开始提示。
- `progress === "suppress"` 时不向聊天渠道投递 `assistant.progress`；如果启动入口配置了 transcript sink，可在本地终端记录为“本地进度（未投递）”。
- `progressCommand === "disabled"` 时拒绝 `/progress`。
- `refreshCommands` 命中时按策略静默处理或回复。
- `/help` 根据策略隐藏 `/progress` 并追加 refresh 命令。
- `/status` 根据策略显示 progress 状态。

`progress: "aggregate"` 是预留模式。当前没有渠道启用；后续可在 Bridge 增加 route 级 progress buffer 后再启用。

## 后续扩展建议

未来渠道可以按平台能力声明策略：

- Slack：可考虑 `progress: "aggregate"`，用 thread 或 update 合并进度。
- 飞书：可考虑卡片更新或分组摘要。
- Telegram：可考虑低频聚合，避免刷屏。
- 企业微信：按实际出站限制选择 suppress 或 aggregate。

新增渠道时优先实现 adapter 自己的 `getDeliveryPolicy()`，不要在 Bridge Core 增加平台名判断。
