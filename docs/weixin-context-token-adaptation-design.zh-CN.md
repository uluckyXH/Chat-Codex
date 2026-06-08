# 微信 context_token / typing keepalive / run_id 适配设计

## 背景

Chat-Codex 已把微信参考版本更新到 `@tencent-weixin/openclaw-weixin@2.4.4`。该版本进一步明确了微信回复链路里的几个关键字段和生命周期消息：

- `context_token`：入站消息携带的上下文凭证，回复时应带回。
- `getConfig(context_token)`：获取当前上下文的 `typing_ticket`，用于发送“正在输入”；它不是 `context_token` 刷新接口。
- `run_id`：同一次回复流程的关联 ID，可用于把工具进度和最终回复归到同一轮。
- `TOOL_CALL_START / TOOL_CALL_RESULT`：结构化工具进度消息。

当前 Chat-Codex 已能从入站消息拿到 `context_token`。本实验分支阶段 1 已让普通 `sendText` / `sendMedia` 带回 `context_token`，并给微信回复流程补了同一轮可复用的 `run_id`。当前实现暂用 Codex `turnId` 派生 `run_id`；正式收敛建议改成 UUID 或短 hash，避免微信侧隐藏字符集/长度约束。后续仍需要验证这条链路是否能提升微信长期投递稳定性。

## 当前实现

### 已有能力

1. 入站消息 raw 中保留 `context_token`。
2. `replyTargetFromMessage()` 会把 raw 的 `context_token` 放入 `ChannelTarget.context.contextToken`。
3. 微信 typing 逻辑调用 `getConfig` 时已经会携带 `context_token`。
4. 普通 route turn 运行期间已有 typing keepalive 机制。
5. 微信当前默认 route 进度模式为 `silent`：普通文本进度和结构化工具生命周期都默认关闭；用户可用 `/progress brief|detailed|tools|silent` 切换当前 route。

### 缺口

1. `getUpdates` 尚未接外部 `AbortSignal`，停止服务时可能等待 long poll。
2. `getConfig` 是否能延长微信侧 `context_token` 可用时间尚无官方确认；本分支仅按 10 秒间隔主动探测。
3. 高频发送 `TOOL_CALL_START / TOOL_CALL_RESULT` 仍需实测微信侧是否聚合展示、是否触发限流。

## 对 getConfig 的理解

`getConfig(context_token)` 的确定作用是获取 `typing_ticket`：

```json
{
  "typing_ticket": "..."
}
```

它不会返回新的 `context_token`，因此不能把它当成“换新 token”接口。

但从微信实际链路看，长任务期间保持 typing 可能改善回复体验：

1. 无有效 `typing_ticket` 时，先用 `getConfig(context_token)` 取票。
2. 长任务运行期间，周期性调用 `sendtyping(typing_ticket, status=typing)`。

这不是协议保证，也不是 OpenClaw 2.4.4 的“每 5 秒 getConfig”实现。2.4.4 发布包里 `getConfig` 是按用户缓存的配置读取，成功后随机 24 小时内刷新；真正 5 秒 keepalive 的是 `sendtyping`。

因此不能把“每 5 秒刷新 `getConfig`”写成官方对齐项。Chat-Codex 实验分支可以额外做“运行期最多每 10 秒主动调用一次 `getConfig(context_token)`”的可观测实验，用来验证它是否对长任务投递稳定性有实际帮助；但这仍不能写成协议结论。

所以设计上应把 `getConfig` 定义为：

- 必须用于 typing。
- 可作为 typing 可用性和长任务投递稳定性的实验信号，但不能默认认为它会续期 `context_token`。
- 不作为获取新 context_token 的来源。

## 适配目标

第一阶段目标是让 Chat-Codex 的微信回复链路更接近 OpenClaw 2.4.4：

1. 所有直接回复当前微信消息的出站文本/媒体都带 `context_token`。
2. 普通 route turn 运行期间持续 typing，保持用户可见的“正在输入”；background/Goal turn 需要补同等 keepalive。
3. 同一 Codex turn 产生稳定的微信 `run_id`。
4. 为后续结构化工具进度打基础，并允许微信通过可控模式接收低噪声工具进度。

## 字段设计

### context_token

来源：

```ts
target.context.contextToken
```

写入：

```ts
body.msg.context_token = contextToken
```

适用范围：

- `sendText`
- `sendMedia` caption 文本
- `sendMedia` 图片/文件 item
- 后续 `sendToolProgress`
- 错误提示
- 审批提示
- `request_user_input` 提示

不适用：

- 没有入站上下文的主动消息。
- 后台 Goal 自动续跑且没有可用 target context 的消息。

降级：

- 没有 `context_token` 时仍允许发送，但记录调试信息。
- 发送失败时可尝试去掉 `context_token` fallback 一次。

### run_id

推荐使用每个微信回复流程独立生成的 UUID：

```ts
run_id = randomUUID()
```

原因：

- OpenClaw 2.4.4 发布包使用 `randomUUID()` 生成 `run_id`。
- `run_id` 是微信投递关联 ID，不需要等于 Codex `turnId`。
- UUID 避免 `chat-codex:${turnId}` 这类带冒号字符串触发微信侧隐藏格式限制。

当前实验分支如果继续使用 Codex `turnId` 派生，必须视为可回退实现：

```ts
run_id = `chat-codex:${turnId}`
```

如果需要避免 UUID 暴露或进一步缩短，也可以用稳定短 ID：

```ts
run_id = sha256(turnId).slice(0, 32)
```

同一 turn 内必须保持一致：

- 工具进度
- 最终回复
- 计划最终输出
- 媒体发送

不要求跨 turn 复用。

### typing_ticket

仍通过：

```ts
getConfig({
  ilink_user_id: toUserId,
  context_token: contextToken,
})
```

获取。

typing keepalive 沿用 Bridge 既有 5 秒 tick，不修改全局节奏，也不在 `ChannelCapabilities` 增加微信专属配置。正式语义应是“每 5 秒发送 typing”，不是“每 5 秒刷新 `getConfig`”：

```text
turn started
每 5 秒：Bridge 调用 sendTyping(true)
微信 adapter：使用当前有效 typing_ticket -> sendtyping(status=typing)，sendTyping 调用快速返回
turn completed/failed/stopped：入队 sendtyping(status=cancel)
```

`typing_ticket` 获取策略：

- 没有有效 ticket 时调用 `getConfig(context_token)`。
- 已有有效 ticket 时优先复用。
- 可保留“运行期最多每 10 秒调用一次 `getConfig(context_token)`”作为微信 adapter 内部实验开关，用于验证是否改善长任务投递，但不能作为默认结论。
- `typing=false` 只复用最近一次有效 `typing_ticket`；如果没有缓存 ticket，则跳过取消，不为了取消额外刷新 `getConfig`。

这条链路不能阻塞 Codex turn。`getConfig` 或 `sendtyping` 失败只更新微信 adapter 状态，不向上打断本轮 Codex。

## 微信 2.4.4 新工具进度

`TOOL_CALL_START / TOOL_CALL_RESULT` 是 2.4.4 新增的结构化工具进度，不是普通文本 progress。

语义：

- `TOOL_CALL_START`：某个工具调用开始。
- `TOOL_CALL_RESULT`：某个工具调用结束，携带 `completed / failed / blocked / unknown`。

它们应映射到 Codex 的结构化工具/命令 item 事件，而不是从中文进度文案里解析。

当前 Chat-Codex 对外的 `assistant.progress` 事件只有 `text/kind`，没有 `itemId/phase/status/toolName`，不能作为结构化工具进度的可靠来源。需要在 Codex app-server 适配层从 `item/started`、`item/completed` 等结构化通知额外产出内部工具生命周期事件，再由微信发送 `TOOL_CALL_START / TOOL_CALL_RESULT`。

第一版建议：

- 当前实验分支同时发送 `TOOL_CALL_START` 和 `TOOL_CALL_RESULT`，用于验证微信侧结构化生命周期展示。
- 如果实测消息量过高，后续可再引入延迟 start 或只发 result 的降噪策略。
- 不发送 reasoning summary、stdout/stderr 大段文本、普通 commentary progress。
- 发送失败不影响最终回复。

后续如果实验确认微信能稳定承受，再考虑开启 start/result 成对投递。

这部分对应 OpenClaw 2.4.4 的 `replyProgressMessages` 能力，但 Chat-Codex 不直接照搬“默认 true”。Chat-Codex 要继续使用自己的投递策略：微信可以开启结构化工具进度，但普通文本进度仍默认关闭。

## 微信进度投递模式

现状：

- Chat-Codex 已有普通文本进度模式，`/progress brief|detailed|silent` 可用。
- 微信 2.4.4 实验分支已放开 `/progress brief|detailed|tools|silent`，默认持久模式为 `silent`。

微信需要同时支持两类能力：

- 普通文本进度：复用 Chat-Codex 现有 `/progress brief|detailed|silent` 语义，用于测试微信在正确 `context_token/run_id/typing keepalive` 链路下能否稳定承载进度消息。
- 结构化工具进度：微信 2.4.4 专属能力，支持 `/progress tools`，用于测试 `TOOL_CALL_START/TOOL_CALL_RESULT` 是否能被微信端更好地聚合展示。

建议把微信进度分成三层：

1. 普通文本 progress：`brief/detailed/silent`。
2. 结构化工具 progress：`tools`。
3. Plan mode turn 级别覆盖：不改 route 配置，但 Plan turn 默认完整投递过程消息。

微信模式：

```text
/progress brief
/progress detailed
/progress tools
/progress silent
```

含义：

- `/progress brief`：投递摘要文本进度，和 Chat-Codex 现有 brief 语义一致。
- `/progress detailed`：投递完整文本进度和微信 2.4.4 结构化工具生命周期；文本进度包含命令/工具开始、完成、失败和输出摘要，不投递无限制原始 stdout/stderr。
- `/progress tools`：投递微信 2.4.4 结构化工具生命周期事件，例如 `TOOL_CALL_START/RESULT`；不携带命令/工具输出摘要。
- `/progress silent`：不投递任何进度，只保留最终回复、审批、`request_user_input`、错误和安全通知。

默认建议：

```text
微信默认 /progress silent
```

理由：

- 2.4.4 的结构化工具进度是微信专门支持的新能力。
- 工具结果比普通文本进度低噪声。
- 默认低噪声，但用户可以切 `/progress brief` 或 `/progress detailed` 做完整投递测试。

实现上可以扩展 `ChannelDeliveryPolicy`：

```ts
type ChannelToolProgressDelivery = "send" | "suppress";

interface ChannelDeliveryPolicy {
  taskStart: ChannelTaskStartDelivery;
  progress: ChannelProgressDelivery;
  toolProgress?: ChannelToolProgressDelivery;
  progressCommand: ChannelProgressCommandMode;
}
```

微信：

```ts
{
  taskStart: "suppress",
  progress: "send",
  toolProgress: "send",
  progressCommand: "enabled"
}
```

这里的 `progress: "send"` 表示微信允许普通文本进度进入 Bridge 的 `/progress` 过滤器；是否真正投递由 route 当前模式和 Plan turn 覆盖决定。
非微信渠道不需要理解微信 `TOOL_CALL_START/RESULT`，`toolProgress` 可以保持未设置或 `suppress`，现有普通文本进度行为不变。

如果要避免改通用协议，实验分支也可以先在 WeixinAdapter 内实现本地开关。但正式方案应通过 `ChannelDeliveryPolicy` 表达，不在 Bridge Core 写微信分支。

命令行为：

- `/progress tools`：设置微信只投递结构化工具进度。
- `/progress silent`：关闭普通文本进度和结构化工具进度。
- `/progress brief` / `/progress detailed`：设置微信普通文本进度投递级别，用于测试完整进度投递；其中 detailed 必须包含工具/命令输出摘要，并同时发送微信结构化工具生命周期。
- `/status` 中应展示当前微信进度模式，避免用户误以为微信普通文本进度和微信结构化工具进度是同一个开关。

模式矩阵：

| 模式 | 普通文本进度 | 结构化工具生命周期 |
| --- | --- | --- |
| `/progress tools` | 不投递 | 投递 |
| `/progress detailed` | 投递完整文本进度和输出摘要 | 投递 |
| `/progress brief` | 投递摘要文本进度 | 不投递，除非实现明确选择和 `tools` 叠加 |
| `/progress silent` | 不投递 | 不投递 |

## /plan 与进度模式

`/plan` 不应该修改 route 持久化进度配置，但 Plan turn 本身应默认完整投递过程消息。

原因：

- Plan mode 不只有最终计划；`turn/plan/updated`、`item/plan/delta`、reasoning summary、搜索、文件变更、命令/工具进度都是用户需要看到的过程信息。
- “不改配置”和“本 turn 要完整投递”可以同时成立：使用 turn 级别 effective progress mode，不写入 route progress mode。
- 用户切 `/plan` 的意图是进入协作规划，默认应该看到规划过程。

这是 Chat-Codex 的产品交互策略，不是微信 2.4.4 协议要求。微信侧能否稳定承载 detailed 文本过程仍需要实测；默认持久模式使用最低噪声的 `/progress silent`，需要实验结构化工具生命周期时再手动切到 `/progress tools`。

建议策略：

- `/plan` 不改 route 的 `/progress` 模式。
- Plan turn 的 effective progress mode 默认为 `detailed`，完整投递过程消息，包括工具/命令输出摘要。
- 如果当前微信是 `silent`，Plan mode 的最终计划仍必须发送。
- 如果当前微信是 `tools`，Plan turn 仍按 `detailed` 投递普通文本过程消息，同时可发送结构化工具进度。
- 可以在 `/plan` 切换成功提示中低频提示一次：

```text
已进入计划模式。本轮计划过程会完整投递；这不会修改当前 /progress 配置。
```

## 实施阶段

### 阶段 1：协议类型补齐

补齐微信 2.4.4 协议类型：

- `WeixinMessageItemType.TOOL_CALL_START = 11`
- `WeixinMessageItemType.TOOL_CALL_RESULT = 12`
- `WeixinMessage.run_id?: string`
- `WeixinMessageItem.create_time_ms?`
- `WeixinMessageItem.update_time_ms?`
- `WeixinMessageItem.is_completed?`
- `tool_call_start_item`
- `tool_call_result_item`

这一步不改变出站行为。

### 阶段 2：context_token 出站回传

改 `sendText` / `sendItems`：

```ts
const contextToken = stringDetail(target.context, "contextToken");
body.msg.context_token = contextToken;
```

同步更新测试：

- 旧测试“忽略 context token”改为“携带 context token”。
- 新增无 context token 时仍能发送。
- 新增 context token 发送失败 fallback 测试。

### 阶段 3：run_id 建模

在 Bridge route turn 处理层只对微信 channel 建立发送上下文：

```ts
interface ChannelTurnContext {
  routeKey: string;
  codexTurnId: string;
  runId: string;
}
```

出站投递时通过 `SendOptions` 或 `ChannelTarget.context` 下发：

```ts
sendText(target, text, { correlationId: runId })
```

需要避免把微信专属字段泄漏到通用 Bridge 逻辑里。推荐在通用 `SendOptions` 中增加可选 `correlationId`，微信 adapter 映射为 `run_id`。
如果通过 `ChannelTarget.context.runId` 传递，也必须限定在 `channelId === "weixin"` 或 `weixin-*`，避免飞书、Terminal、Mock 等非微信渠道收到微信专属上下文字段。

### 阶段 4：typing keepalive 与 10 秒 getConfig 探测实验

将微信 turn 运行期 keepalive 挂在既有 5 秒 typing tick 上，不改全局 Bridge 节奏：

1. Bridge 每 5 秒调用一次通用 `sendTyping(target, true)`。
2. 微信 adapter 的 `sendTyping(true)` 快速返回，把 `sendtyping(status=typing)` 放入微信私有队列。
3. 队列内部串行执行，避免多次 5 秒 tick 或取消请求并发打乱顺序。
4. turn 结束、失败、`/stop` 时调 `sendTyping(false)`；cancel 复用最近一次 `typing_ticket`，不再额外刷新 `getConfig`。

`getConfig(context_token)` 只负责获取 `typing_ticket`：

- 无 ticket 或 ticket 过期时必须调用。
- 启用实验开关时，微信 adapter 内部最多每 10 秒主动调用一次 `getConfig(context_token)`，记录返回状态和后续投递成功率。
- 10 秒探测由微信 adapter 的 typing 队列限流触发，不新增 Bridge 全局 tick，也不影响其它渠道。
- 默认收敛方案不应依赖这个实验探测。
- background/Goal turn 需要补同样的 5 秒 typing keepalive，否则长后台任务不会持续刷新正在输入状态。

同时增加日志：

- 是否有 `context_token`
- `context_token` 捕获时间和当前年龄
- `getConfig` 成功/失败
- typing send 成功/失败
- keepalive 失败次数
- turn 持续时间
- 最终 sendmessage 是否成功

实验目标：

- 对比“有 context_token + typing keepalive”和“无 context_token”的长任务投递成功率。
- 观察超过 1 分钟、3 分钟、5 分钟任务是否更稳定。

失败策略：

- 不因 keepalive 失败中断 Codex turn。
- 不在 Bridge 全局层做微信专属退避；如需退避，应放在 WeixinAdapter 内部实现。

### 阶段 5：结构化工具进度和 /progress tools

在前四阶段稳定后，再接：

- `TOOL_CALL_RESULT` 优先
- `TOOL_CALL_START` 可选

事件来源必须是结构化 item 生命周期：

- app-server `item/started` -> 内部 `tool_progress phase=start`
- app-server `item/completed` -> 内部 `tool_progress phase=end`
- 附带 `itemId`、工具/命令名、状态

不要从 `assistant.progress.text` 反向解析。

当前实现同时发送 `TOOL_CALL_START` 和 `TOOL_CALL_RESULT`，用于验证微信 2.4.4 结构化生命周期展示，并把微信 `/progress` 从禁用改为支持：

```text
/progress brief
/progress detailed
/progress tools
/progress silent
```

其中 `brief/detailed` 复用 Chat-Codex 现有普通文本进度语义，`tools` 发送微信 2.4.4 结构化工具进度。

文本 detailed 和结构化 tools 的边界：

- `/progress detailed` 同时走普通文本消息和微信结构化 item；文本消息包含命令/工具开始、完成、失败和输出摘要，结构化 item 表达工具生命周期。
- `/progress tools` 走微信结构化 item，只表达工具生命周期和状态，不带输出摘要。
- 两者可以在 Plan turn 中同时出现：Plan turn effective detailed 负责文本过程，当前微信 tools 能力负责结构化生命周期。

## 发送失败策略

建议顺序：

1. 带 `context_token` 和 `run_id` 发送。
2. 如果失败且错误疑似 context 失效：
   - 可调用一次 `getConfig(context_token)` 做探测，确认 typing/config 链路是否仍可用。
   - 不把 `getConfig` 视为 context_token 续期接口。
   - 再带同一 `context_token` 重试一次。
3. 如果仍失败，再去掉 `context_token` fallback 一次。
4. fallback 成功时记录 warning，便于后续判断 context 机制是否有问题。

不能无限重试，避免触发微信风控。

## 实验设计

### 实验 A：短任务

任务时长：10-30 秒。

预期：

- typing 正常出现。
- 最终回复带 `context_token`。
- 成功率应接近 100%。

### 实验 B：中长任务

任务时长：2-3 分钟。

预期：

- typing keepalive 持续。
- 每 5 秒可见一次 sendtyping keepalive 日志；如果启用 `getConfig` 探测实验，最多每 10 秒额外记录一次 getConfig 状态。
- 最终回复仍能投递。
- 记录是否发生 context fallback。

### 实验 C：高频工具任务

任务包含多次工具调用，分别测试 `/progress tools` 和 `/progress detailed`。

预期：

- `/progress tools` 只看到结构化工具生命周期，不带输出摘要。
- `/progress detailed` 能同时看到文本工具/命令开始、完成、失败、输出摘要和结构化工具生命周期。
- 最终回复稳定。

### 实验 D：结构化工具进度

开启 `/progress tools`，当前实现同时发送 `TOOL_CALL_START` 和 `TOOL_CALL_RESULT`；如实测消息量过高，再降级为延迟 start 或只发 result。

预期：

- 微信收到少量结构化工具生命周期进度，不携带输出摘要。
- 最终回复仍稳定。
- 不触发明显限制。

## 风险

- `context_token` 可能有有效期，长任务仍可能过期。
- `getConfig` 的保活效果未被协议明确保证。
- 每 10 秒探测调用 `getConfig` 不是 OpenClaw 2.4.4 默认策略，可能增加请求量，需要实验开关和日志。
- 高频发送 `TOOL_CALL_START / RESULT` 仍可能触发限制。
- 去掉 `context_token` fallback 可能导致消息不在正确上下文内显示。
- `run_id` 字段格式约束未知，需要实验确认。

## 建议结论

先适配 `context_token` 出站回传、稳定 `run_id` 和微信 5 秒 typing keepalive，再放开微信进度模式做完整实验。`getConfig` 10 秒探测只作为可观测实验，不作为默认依赖。

最小可测版本：

1. `sendText/sendMedia` 带 `context_token`。
2. 同一 turn 带稳定 `run_id`。
3. 保持 typing keepalive。
4. 日志记录 sendtyping、getConfig、sendmessage 状态。

等这条链路稳定后，放开微信 `/progress brief|detailed|silent|tools`。其中 detailed 同时负责文本工具/命令输出摘要和微信 2.4.4 结构化工具生命周期，tools 只负责结构化生命周期。
