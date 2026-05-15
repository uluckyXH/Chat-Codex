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

## 当前渠道策略

### 默认/Terminal/Mock

默认策略完整投递：

- 发送 task-start。
- 按 `/progress brief|detailed|silent` 投递 progress。
- `/progress` 可用。
- 无额外 refresh 命令。

Terminal 因此能继续看到 Codex plan、reasoning summary、search、file change 等 progress。

### Weixin

WeixinAdapter 返回微信专属策略：

- `taskStart: "suppress"`：不发送 `Codex 正在处理这条消息。`
- `progress: "suppress"`：不发送 `Codex 进度:`
- `progressCommand: "disabled"`：微信中 `/progress` 返回拒绝说明，不改变模式。
- `refreshCommands: [{ command: "fff", silent: true }]`：`/fff` 静默处理，不回复、不入队、不转发给 Codex。
- `/status` 显示 `Progress: disabled (微信渠道不投递进度)`。

微信仍发送关键消息：

- final answer
- error / turn failed
- approval request
- approval result
- queue notice
- media send result
- user-initiated command replies

## Bridge 行为

Bridge 只读取策略，不判断具体渠道名：

- `taskStart === "send"` 时发送任务开始提示。
- `progress === "suppress"` 时丢弃 `assistant.progress`。
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
