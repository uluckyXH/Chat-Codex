# 微信 2.4.4 进度投递适配设计

## 背景

`@tencent-weixin/openclaw-weixin@2.4.4` 在 `2.4.3` 基础上新增了微信侧结构化进度消息能力。Chat-Codex 已把微信通道参考版本和上报的 `channel_version` 更新到 `2.4.4`，但尚未启用新能力。

本文只讨论 2.4.4 新能力如何映射到 Chat-Codex。飞书 SDK 更新和 Codex app-server 新版通知适配不在本文范围内。

## 2.4.4 新增点

### 协议字段

`MessageItemType` 新增：

```ts
TOOL_CALL_START = 11
TOOL_CALL_RESULT = 12
```

`WeixinMessage` 新增：

```ts
run_id?: string
```

结构化进度消息使用独立 `MessageItem`：

```ts
{
  type: MessageItemType.TOOL_CALL_START,
  create_time_ms: Date.now(),
  is_completed: false,
  tool_call_start_item: {
    tool_name: string,
    tool_call_id?: string,
  },
}
```

```ts
{
  type: MessageItemType.TOOL_CALL_RESULT,
  create_time_ms: Date.now(),
  is_completed: true,
  tool_call_result_item: {
    tool_name: string,
    tool_call_id?: string,
    status: "completed" | "failed" | "blocked" | "unknown",
  },
}
```

### 发送参数

2.4.4 的普通文本、媒体和结构化进度发送都会在 `msg` 上携带：

```ts
context_token?: string
run_id?: string
```

其中：

- `context_token` 来自入站消息上下文，用于把回复关联到当前微信上下文。
- `run_id` 由当前回复流程生成，结构化进度和最终回复应共享同一个 `run_id`。

### 长轮询中断

`getUpdates` 支持外部 `AbortSignal`。停止渠道时可以立即取消长轮询，而不是等待 long-poll timeout 或下一次错误重试。

### 配置项

新增 `replyProgressMessages`，OpenClaw 插件默认 `true`。这表示插件默认会发送结构化工具进度。

Chat-Codex 不能直接照搬这个默认值。Chat-Codex 已有独立的 `ChannelDeliveryPolicy` 和微信降噪策略，微信是否投递进度必须由 Chat-Codex 自己控制。

## 现状对齐

Chat-Codex 当前微信发送参数：

- 已对齐：
  - `from_user_id: ""`
  - `to_user_id`
  - `client_id`
  - `message_type: BOT`
  - `message_state: FINISH`
  - `item_list`
  - `base_info.channel_version`
  - `base_info.bot_agent`
  - `iLink-App-ClientVersion`

- 尚未对齐 2.4.4 新增关联字段：
  - `context_token`
  - `run_id`

当前代码曾明确测试“微信发送普通文本时默认忽略 context token”。这在 2.4.3 下可以接受，但如果要启用结构化进度，最终回复和进度消息需要共享同一个 `run_id`，并尽量携带 `context_token`，否则微信端可能无法把工具进度稳定归到同一次回复流程。

## 产品策略

微信现在可以投递进度，但不应该恢复所有普通文本进度刷屏。

建议策略：

1. 微信默认仍不发送普通文本进度。
2. 微信可以发送低噪声结构化工具进度：
   - 工具开始：`TOOL_CALL_START`
   - 工具结束：`TOOL_CALL_RESULT`
3. reasoning summary、阶段性文本进度、命令 stdout 摘要仍默认不投递到微信，只保留本地 transcript。
4. 最终回复、审批、`request_user_input`、安全通知继续按普通文本投递。

理由：

- 结构化工具进度是微信 2.4.4 专门新增的低成本展示能力，比普通文本刷屏更适合微信。
- 用户能看到 Codex 没卡住、正在调用工具，但不会收到大量中间文本。
- 保持和现有“微信默认安静”的产品判断兼容。

## 适配方案

### 阶段 1：协议兼容

补齐类型，不改变运行行为：

- `WeixinMessageItemType.TOOL_CALL_START = 11`
- `WeixinMessageItemType.TOOL_CALL_RESULT = 12`
- `WeixinMessage.run_id?: string`
- `WeixinMessageItem.tool_call_start_item?`
- `WeixinMessageItem.tool_call_result_item?`

这一步只提升协议识别能力，不发送新进度。

### 阶段 2：上下文和 run_id

在 Bridge/WeixinAdapter 之间传递微信发送上下文：

- 入站消息保留 `context_token` 到 `ChannelTarget.context` 或 route message context。
- 每个 Codex turn 生成一个微信侧 `run_id`。
- 同一 turn 内：
  - 结构化工具进度使用该 `run_id`
  - 最终回复使用该 `run_id`
  - 媒体消息如属于同一回复流程，也使用该 `run_id`

需要注意：

- `run_id` 是微信投递关联 ID，不等于 Codex `turnId`。可以用 `turnId` 派生，也可以生成随机 UUID 并保存在 route-turn 发送上下文中。
- `context_token` 可能缺失。缺失时允许降级发送，但要保留调试日志。

### 阶段 3：结构化工具进度发送

新增 WeixinAdapter 私有发送能力：

```ts
sendToolProgress(target, {
  phase: "start" | "end";
  toolName: string;
  toolCallId?: string;
  status?: "completed" | "failed" | "blocked" | "unknown";
  runId: string;
})
```

映射规则：

- `assistant.progress` 中能识别为工具开始事件时，发送 `TOOL_CALL_START`。
- `assistant.progress` 中能识别为工具结束事件时，发送 `TOOL_CALL_RESULT`。
- 无法稳定识别工具边界的普通进度不发送到微信。

当前 Codex app-server 事件里已经有 command/tool item 的开始、完成、失败信息。适配时应从结构化事件源映射，不要从中文进度文案里反向解析。

### 阶段 4：Delivery Policy

扩展微信投递策略，避免把“结构化工具进度”和“普通文本进度”混为一谈。

建议新增一类策略字段：

```ts
toolProgress: "send" | "suppress"
```

微信默认：

```ts
{
  taskStart: "suppress",
  progress: "suppress",
  progressCommand: "disabled",
  toolProgress: "send",
}
```

飞书、Terminal、Mock 默认可以保持：

```ts
toolProgress: "send"
```

如果不想扩展通用协议，也可以先在 WeixinAdapter 内部处理结构化进度。但长期看，放进 `ChannelDeliveryPolicy` 更清晰。

### 阶段 5：开关设计

微信不建议复用现有 `/progress detailed` 直接打开所有文本进度。

可选命令设计：

```text
/progress tools
/progress silent
```

含义：

- `/progress tools`：微信只收结构化工具开始/结束，不收普通文本进度。
- `/progress silent`：微信连结构化工具进度也不收，只保留最终回复和关键交互。

默认值建议为 `/progress tools`，因为 2.4.4 已提供结构化工具进度，噪声可控。

如果希望继续极简默认，也可以默认 `silent`，但这会浪费 2.4.4 新能力。

## 风险和边界

- 不应把 reasoning summary 变成微信进度消息；它仍可能刷屏。
- 不应把 command stdout/stderr 大段输出投递到微信。
- 工具开始和工具结束可能乱序或丢失，发送层必须容忍失败；失败不能影响 Codex turn。
- 结构化工具进度发送失败后，应进入短暂 suppress/backoff，避免反复报错。
- 没有 `context_token` 时可以发送，但需要观察微信端是否能正确聚合显示。
- 群聊场景下仍按当前微信群聊能力边界处理；本文不扩大微信群聊支持范围。

## 测试计划

自动化测试：

- `WeixinMessageItemType` 包含 11/12。
- `weixinMessageToChannelMessage` 能保留 `run_id` 原始字段，不影响普通文本解析。
- `sendToolProgress` 构造 `TOOL_CALL_START` 和 `TOOL_CALL_RESULT` 请求体。
- 普通文本进度仍被微信 delivery policy 抑制。
- 工具结构化进度在微信策略允许时发送。
- 发送失败不影响最终回复。
- `getUpdates` 收到 abort 后退出轮询，不进入 degraded。

实际测试：

1. 启动 Chat-Codex 微信渠道。
2. 发起一个会触发工具调用的 Codex 任务。
3. 确认微信收到工具开始/结束结构化进度。
4. 确认 reasoning 和 stdout 没有刷屏。
5. 确认最终回复正常。
6. `/stop` 或服务重启时，确认微信轮询能快速退出。

## 建议结论

建议适配，但分两步走：

1. 先做协议兼容和 `abortSignal`，风险低。
2. 再做结构化工具进度，默认开启 `tools` 模式，只发送 `TOOL_CALL_START/RESULT`，不恢复普通文本进度。

这样既利用了微信 2.4.4 的新能力，也不会破坏 Chat-Codex 当前微信低噪声体验。
