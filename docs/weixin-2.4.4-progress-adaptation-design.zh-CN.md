# 微信 2.4.4 进度投递适配设计

## 背景

`@tencent-weixin/openclaw-weixin@2.4.4` 在 `2.4.3` 基础上新增了微信侧结构化进度消息能力。Chat-Codex 已把微信通道参考版本和上报的 `channel_version` 更新到 `2.4.4`，但尚未启用新能力。

本文只讨论 2.4.4 新能力如何映射到 Chat-Codex。飞书 SDK 更新和 Codex app-server 新版通知适配不在本文范围内。

工具进度投递、本地诊断日志和微信用户可见消息的边界，见 `docs/weixin-tool-progress-delivery-diagnostics-design.zh-CN.md`。该文档说明投递诊断日志来自 Chat-Codex Bridge 投递层，不等同于微信用户消息。

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

对 Chat-Codex 来说，`replyProgressMessages` 对应的是“结构化工具进度是否发送”，不是“普通文本 progress 是否发送”。普通 commentary、reasoning summary、stdout/stderr 摘要仍然按 Chat-Codex 的微信降噪策略处理。

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

- 本实验分支阶段 1 已对齐 2.4.4 新增关联字段：
  - `context_token`
  - `run_id`

当前代码曾明确测试“微信发送普通文本时默认忽略 context token”。这在 2.4.3 下可以接受，但如果要启用结构化进度，最终回复和进度消息需要共享同一个 `run_id`，并尽量携带 `context_token`，否则微信端可能无法把工具进度稳定归到同一次回复流程。

## 产品策略

微信现在可以投递进度，适配目标不是继续屏蔽普通进度，而是在正确 `context_token/run_id/typing keepalive` 链路下完整测试微信进度投递能力。

建议策略：

1. 微信兼容 Chat-Codex 已有的普通文本进度模式：
   - `/progress brief`
   - `/progress detailed`
   - `/progress silent`
2. 微信额外支持 2.4.4 结构化工具进度：
   - 工具开始：`TOOL_CALL_START`
   - 工具结束：`TOOL_CALL_RESULT`
3. `/plan` turn 可按 Chat-Codex 产品策略使用 turn 级 detailed effective mode，但不修改 route 持久化 `/progress` 配置。
4. 最终回复、审批、`request_user_input`、安全通知继续按普通文本投递。

理由：

- `brief/detailed` 是 Chat-Codex 既有普通文本进度能力；微信需要兼容这两档，才能实测普通消息投递是否还会被限制。
- 结构化工具进度是微信 2.4.4 专门新增的能力，可以和普通文本进度并行实验。
- `/plan` 不只有最终结果，规划过程本身是用户需要看的内容；但这属于 Chat-Codex 交互策略，不是微信协议要求，微信能否稳定承载 detailed 文本过程仍需实测。

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

- `run_id` 是微信投递关联 ID，不等于 Codex `turnId`。OpenClaw 2.4.4 发布包使用 `randomUUID()`；Chat-Codex 正式方案也建议每 turn 生成 UUID，并保存在 route-turn 发送上下文中。
- 当前实验分支如果继续用 `turnId` 派生，必须视为可回退实现；如果微信侧对字符集或长度有隐藏约束，应立即切到 UUID 或短 hash。
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

- Codex app-server `item/started` 中的工具/命令 item，映射为内部 `tool_progress phase=start`，再发送 `TOOL_CALL_START`。
- Codex app-server `item/completed` 中的工具/命令 item，映射为内部 `tool_progress phase=end`，再发送 `TOOL_CALL_RESULT`。
- 内部事件需要携带 `itemId`、工具/命令名、状态；如果缺少这些字段，降级为普通文本进度或不发送结构化 item。
- 无法稳定识别工具边界的普通进度不发送到微信结构化 item。

当前 Chat-Codex 对外的 `assistant.progress` 事件只有 `text/kind`，没有 `itemId/phase/status/toolName`。适配时应先扩展内部 Codex event，或在 app-server turn controller 内单独发布工具生命周期事件；不要从中文进度文案里反向解析。

### 阶段 4：typing keepalive 边界

普通 route turn 已通过 Bridge `withTyping` 获得 5 秒 typing keepalive；background/Goal turn 当前只在开始/结束各发一次 typing，需要补齐同等 keepalive。

设计要求：

- 5 秒节奏仍由 Bridge 层现有 typing tick 决定，不新增全局渠道配置。
- 微信 adapter 负责用 `typing_ticket` 发送 `sendtyping(status=typing)`。
- `getConfig(context_token)` 只用于获取 `typing_ticket`。OpenClaw 2.4.4 发布包对 `getConfig` 做 per-user cache，并不是 5 秒强制刷新。
- 如果保留主动 `getConfig` 探测实验，建议放在微信 adapter 内部并限流为最多每 10 秒一次，不新增 Bridge 全局 tick，不影响其它渠道，也不写成协议结论。

### 阶段 5：Delivery Policy

扩展微信投递策略，避免把“结构化工具进度”和“普通文本进度”混为一谈。

建议新增一类微信可用的策略字段：

```ts
toolProgress?: "send" | "suppress"
```

微信默认：

```ts
{
  taskStart: "suppress",
  progress: "send",
  toolProgress: "send",
  progressCommand: "enabled",
}
```

这里的 `progress: "send"` 只表示微信允许普通文本进度进入现有 `/progress` 过滤器；route 当前模式决定是否真正发送。默认持久模式如果是 `tools`，普通文本进度仍不发送。

非微信渠道不需要理解微信 `TOOL_CALL_START/RESULT`。如果把 `toolProgress` 放进通用策略，非微信默认应保持 `undefined` 或 `suppress`，现有普通文本 progress 行为不变。

如果不想扩展通用协议，也可以先在 WeixinAdapter 内部处理结构化进度。但长期看，放进 `ChannelDeliveryPolicy` 更清晰。

### 阶段 6：开关设计

微信需要复用现有 `/progress brief|detailed|silent`，并新增一个微信专属 `tools` 模式。

命令设计：

```text
/progress brief
/progress detailed
/progress tools
/progress silent
```

含义：

- `/progress brief`：投递摘要文本进度，和 Chat-Codex 现有 brief 语义一致。
- `/progress detailed`：投递完整文本进度和微信 2.4.4 结构化工具生命周期；文本进度包含命令/工具开始、完成、失败和输出摘要，不投递无限制原始 stdout/stderr。
- `/progress tools`：投递微信 2.4.4 结构化工具生命周期事件；当前实现同时发送 `TOOL_CALL_START` 和 `TOOL_CALL_RESULT`，不携带命令/工具输出摘要。
- `/progress silent`：不投递进度，只保留最终回复和关键交互。

默认值建议为 `/progress tools`，因为 2.4.4 已提供结构化工具进度，噪声可控。

需要完整测试时，用户可以显式切到 `/progress brief` 或 `/progress detailed`。

边界：

- `detailed` 是完整模式：普通文本详细进度用于看工具/命令做了什么和输出摘要是什么，微信结构化 item 用于展示工具生命周期。
- `tools` 是结构化工具状态模式：用于让微信端聚合展示工具生命周期，不承载 stdout/stderr 摘要。
- `brief` 是摘要文本模式，第一版不默认叠加结构化工具生命周期，除非后续实测证明消息量可控。
- `silent` 同时关闭普通文本进度和结构化工具生命周期。
- Plan turn effective detailed 同样应同时投递文本过程和结构化生命周期。

| 模式 | 普通文本进度 | 结构化工具生命周期 |
| --- | --- | --- |
| `/progress tools` | 不投递 | 投递 |
| `/progress detailed` | 投递完整文本进度和输出摘要 | 投递 |
| `/progress brief` | 投递摘要文本进度 | 默认不投递 |
| `/progress silent` | 不投递 | 不投递 |

### 阶段 7：/plan 下的投递策略

`/plan` 只切换 Codex collaboration mode，不自动改变微信 `/progress` 持久化配置；但 Chat-Codex 可以把该 Plan turn 的 effective progress mode 临时设为 `detailed`。

这是产品交互策略，不是微信 2.4.4 协议要求。微信默认持久模式保持最低噪声，使用 `/progress silent`；需要实验结构化工具生命周期时再手动切到 `/progress tools`。

规则：

- `assistant.plan` 最终计划必须投递。
- `turn/plan/updated`、`item/plan/delta`、搜索、文件变更、命令/工具进度应按 Plan turn 的 detailed 语义投递，其中命令/工具输出摘要和结构化工具生命周期都要投递。
- reasoning summary 需要继续受限流/聚合约束，避免微信刷屏；必要时只投递低频摘要。
- 当前 route 是 `/progress tools` 时，Plan turn 仍按 effective detailed 投递文本过程消息和结构化工具进度。
- `/plan` 不写入 route progress mode；Plan turn 结束后恢复用户原来的进度配置。

可选低频提示：

```text
已进入计划模式。本轮计划过程会完整投递；这不会修改当前 /progress 配置。
```

## 风险和边界

- 不应把 reasoning summary 变成微信进度消息；它仍可能刷屏。
- 不应把 command stdout/stderr 大段输出投递到微信。
- 工具开始和工具结束可能乱序或丢失，发送层必须容忍失败；失败不能影响 Codex turn。
- 结构化工具进度发送失败后，应进入短暂 suppress/backoff，避免反复报错。
- 没有 `context_token` 时可以发送，但需要观察微信端是否能正确聚合显示。
- `getConfig` 不应被当成 `context_token` 续期接口；最多每 10 秒主动调用只能作为实验。
- `run_id` 推荐 UUID；使用 Codex `turnId` 派生时需要保留快速回退。
- 群聊场景下仍按当前微信群聊能力边界处理；本文不扩大微信群聊支持范围。

## 测试计划

自动化测试：

- `WeixinMessageItemType` 包含 11/12。
- `weixinMessageToChannelMessage` 能保留 `run_id` 原始字段，不影响普通文本解析。
- 每个微信 turn 生成 UUID `run_id`，普通文本、媒体和结构化工具进度共享该 ID。
- `sendToolProgress` 构造 `TOOL_CALL_START` 和 `TOOL_CALL_RESULT` 请求体。
- app-server `item/started` / `item/completed` 能产出内部工具生命周期事件，不依赖 `assistant.progress.text` 解析。
- background/Goal turn 能持续 5 秒 typing keepalive，并在完成、失败、`/stop` 时停止。
- 普通文本进度不再被微信 delivery policy 一刀切抑制，按 `/progress brief|detailed|silent` 和 Plan turn effective mode 投递。
- 微信 `/progress brief/detailed/silent/tools` 能正确切换。
- 微信 `/progress detailed` 能投递命令/工具开始、完成、失败和输出摘要。
- 微信 `/progress detailed` 能同时投递结构化工具生命周期。
- 微信 `/progress tools` 只投递结构化工具生命周期，不携带文本输出摘要。
- Plan turn 不修改 route progress mode，但 effective mode 为 detailed。
- Plan turn detailed 包含工具/命令输出摘要和结构化工具生命周期。
- 工具结构化进度在微信策略允许时发送。
- 发送失败不影响最终回复。
- `getUpdates` 收到 abort 后退出轮询，不进入 degraded。

实际测试：

1. 启动 Chat-Codex 微信渠道。
2. 发起一个会触发工具调用的 Codex 任务。
3. 确认微信收到工具开始/结束结构化进度。
4. 切 `/progress brief`，确认微信收到摘要文本进度。
5. 切 `/progress detailed`，确认微信收到完整文本进度、命令/工具细节、输出摘要和结构化工具生命周期。
6. 切 `/plan`，确认本轮计划过程完整投递，且结束后 route progress mode 未被改写。
7. 确认最终回复正常。
8. `/stop` 或服务重启时，确认微信轮询能快速退出。
9. 发起 background/Goal 长任务，确认 5 秒 typing keepalive 持续，结束后停止。

## 建议结论

建议适配，但分阶段走：

1. 先做协议兼容、UUID `run_id`、`context_token` 回传、`abortSignal`，风险低。
2. 补齐普通 route 与 background/Goal 的 typing keepalive；`getConfig` 只作为取票接口，主动 10 秒探测只保留为实验开关。
3. 从 app-server 结构化 item 生命周期新增内部工具进度事件，再发送 `TOOL_CALL_START/RESULT`。
4. 打开微信普通文本进度模式兼容，支持 `brief/detailed/silent/tools`；默认建议 `silent`，当前实现保留 `/progress tools` 用于发送 `TOOL_CALL_START/RESULT` 完整生命周期。

这样既能完整测试微信普通消息投递，也能验证 2.4.4 结构化工具进度是否更适合长期任务。
