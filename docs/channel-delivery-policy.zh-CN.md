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
type ChannelToolProgressDelivery = "send" | "suppress";
type ChannelRealtimeProgressDelivery = "send" | "suppress";

interface ChannelRefreshCommandPolicy {
  command: string;
  description: string;
  silent: boolean;
  replyText?: string;
}

interface ChannelDeliveryPolicy {
  taskStart: ChannelTaskStartDelivery;
  progress: ChannelProgressDelivery;
  toolProgress?: ChannelToolProgressDelivery;
  realtimeProgress?: ChannelRealtimeProgressDelivery;
  allowedProgressModes?: readonly ChannelDefaultProgressMode[];
  progressCommand: ChannelProgressCommandMode;
  defaultProgressMode?: ChannelDefaultProgressMode;
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
- `toolProgress: "suppress"`
- `realtimeProgress: "suppress"`
- `allowedProgressModes: ["silent", "brief"]`
- `progressCommand: "enabled"`
- `defaultProgressMode: "brief"`
- `refreshCommands: []`

`toolProgress` 只表达结构化工具生命周期是否发送，不等同于普通文本 progress。普通文本 progress 仍由 `progress` 和 route 级 `/progress` 模式控制。

`realtimeProgress` 表达渠道是否允许 `/progress realtime` 逐条投递普通文本进度。默认渠道不公开 realtime；飞书 adapter 显式设为 `"send"`。真实微信实测连续投递会触发 `ret=-2` 或堆积，因此微信 adapter 将该字段设为 `"suppress"`。

`allowedProgressModes` 表达普通 `/progress` 命令对用户展示和接受的模式。`detailed`、`tools` 可以作为内部/历史能力继续保留，但只要不在 `allowedProgressModes` 中，就不会出现在帮助里，也不会被 `/progress` 接受。

## 当前渠道策略

### 默认/Terminal/Mock

默认策略完整投递：

- 发送 task-start。
- 按 `/progress silent|brief` 投递普通文本 progress。
- `/progress` 可用。
- 无额外 refresh 命令。

Terminal 因此能继续看到 Codex plan、reasoning summary、search、file change 等 progress。

### Weixin

微信 2.4.4 实验分支中，WeixinAdapter 返回微信专属低噪声策略：

- `taskStart: "suppress"`：不发送 `Codex 正在处理这条消息。`
- `progress: "send"`：允许普通文本进度按 route 模式投递。
- `toolProgress: "send"`：允许结构化工具生命周期投递。
- `realtimeProgress: "suppress"`：不允许微信 route 切到 realtime；真实微信连续逐条发送会出现 `ret=-2`、延迟堆积或等下一条用户消息后集中放出。
- `allowedProgressModes: ["silent", "brief"]`：微信用户可见 `/progress` 只保留静默和摘要。
- `progressCommand: "enabled"`：微信中 `/progress` 可配置 `silent/brief`。
- `defaultProgressMode: "silent"`：默认不发送普通文本进度和结构化工具生命周期，只保留关键交互与最终回复。
- `refreshCommands: [{ command: "fff", silent: true }]`：`/fff` 静默处理，不回复、不入队、不转发给 Codex。
- `/status` 显示 `进度投递: 静默模式`。

微信 2.4.4 实验分支的目标不是把这个低噪声策略扩大到其它渠道，而是在微信 adapter 内独立放开：

- 普通文本进度：支持 `/progress silent|brief`，用于低频摘要；本地 TUI / transcript 通过 observed progress 实时显示完整进度，微信渠道继续节流、合并和失败诊断。
- Codex 旁白：`agentMessage.phase=commentary` 映射为独立 `assistant.commentary`，在 `/progress brief` 和 Plan mode 下低频投递；在 commentary-only 且没有 final/plan 时作为最终回复兜底。
- 结构化工具进度：保留 `TOOL_CALL_START/TOOL_CALL_RESULT` 发送实现，但不再通过普通 `/progress tools` 暴露。
- 默认持久模式建议保持低噪声，例如 `/progress silent`。
- `/plan` 可以让当前 turn 的 Codex 旁白默认可见，但不改 route 持久化 `/progress` 配置，也不因此开启命令/工具进度。

微信仍发送关键消息：

- final answer
- Plan mode final plan
- error / turn failed
- approval request
- approval result
- queue notice
- media send result
- user-initiated command replies

### Feishu

飞书 adapter 显式开放 realtime：

- `taskStart: "send"`：收到普通任务后发送“Codex 正在处理”。
- `progress: "send"`：允许普通文本进度投递。
- `realtimeProgress: "send"`：允许 `/progress realtime` 逐条投递普通文本进度。
- `allowedProgressModes: ["realtime", "silent", "brief"]`：飞书用户可见模式只保留实时、静默和摘要。
- `defaultProgressMode: "brief"`：默认摘要进度。

飞书不公开 `detailed` 和 `tools`。需要更多本地细节时看 TUI / transcript；需要聊天逐条普通文本进度时显式切 `/progress realtime`。

## Bridge 行为

Bridge 只读取策略，不判断具体渠道名：

- `taskStart === "send"` 时发送任务开始提示。
- `progress === "suppress"` 时不向聊天渠道投递 `assistant.progress`；如果启动入口配置了 transcript sink，可在本地终端记录为“本地进度（未投递）”。
- `assistant.commentary` 由独立旁白投递器处理；`brief` 和 Plan mode 可见，`silent` 下非 plan 旁白不投递，但 commentary-only 且没有 final/plan 时会走最终回复兜底。
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
