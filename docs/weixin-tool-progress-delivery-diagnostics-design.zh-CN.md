# 微信工具进度投递与诊断日志设计

## 背景

微信 2.4.4 适配后，Chat-Codex 开始支持把 Codex 的结构化工具生命周期发送到微信：

- `TOOL_CALL_START`：工具或命令开始。
- `TOOL_CALL_RESULT`：工具或命令结束。

同时，为了排查“微信是否真的收到进度投递请求”，Bridge 投递层需要保留失败诊断日志。早期实验中曾为成功路径也增加过本地诊断日志：

- `tool progress send started`
- `tool progress send succeeded`
- `tool progress send failed`
- `progress message send started`
- `progress message send succeeded`
- `progress message send failed`

成功路径的低层流水会刷屏，当前策略是不再默认记录 started/succeeded，只在失败时展示 warn 和未投递正文。本文档定义三者边界：

1. Codex 工具生命周期事件。
2. 发给微信的进度消息。
3. Chat-Codex 本地运行日志。

## 概念边界

### Codex 工具生命周期

来源是 Codex app-server 的结构化通知，例如：

- `item/started`
- `item/completed`

Chat-Codex 在 `AppServerTurnController` 中把这些通知映射为内部事件：

```ts
{
  type: "tool.progress",
  progress: {
    phase: "start" | "end",
    itemId: string,
    toolName: string,
    status?: "completed" | "failed" | "blocked" | "unknown"
  }
}
```

例如：

- `webSearch` -> `toolName=web_search`
- `commandExecution` -> `toolName=command: npm test`
- `mcpToolCall` -> `toolName=<server>/<tool>`

这一步只是内部事件转换，还没有发送到微信，也不是本地日志。

### 发给微信的进度消息

微信进度有两类。

第一类是普通文本进度：

```text
命令完成: npm test
输出摘要:
...
```

这类消息使用普通 `sendText` 投递，微信里通常会作为普通聊天文本出现；消息正文不再额外添加 `Codex 进度:` 标题，TUI/transcript 通过投递类型标记它是进度。

第二类是结构化工具进度：

```ts
TOOL_CALL_START
TOOL_CALL_RESULT
```

这类消息使用微信 2.4.4 的结构化 `MessageItem` 投递。它会进入微信接口，但不保证在微信客户端上像普通文本聊天消息一样逐条冒泡展示。微信可能把它用于 AI 回复卡片、内部状态聚合，或者当前客户端展示不明显。

因此：

- `tool progress send succeeded` 只能说明 Chat-Codex 调微信接口发送结构化工具进度成功。
- 它不能证明微信客户端一定显示了一条用户可见文本。
- 如果要用户明确看到工具/命令摘要，应依赖 `/progress detailed` 的普通文本进度，而不是只依赖 `TOOL_CALL_START/RESULT`。

### 本地运行日志

本地运行日志只用于观察 Chat-Codex 自己的运行状态。它不会自动发送到微信。

例如：

```text
tool progress send started ...
tool progress send succeeded ...
```

表示 Bridge 投递层正在调用或已经调用完渠道发送接口。这些日志来自 Chat-Codex 的 `BridgeDelivery`，不是微信 SDK 原生日志，也不是微信用户消息。当前实现不再默认输出成功路径的 started/succeeded 流水。

## 当前投递链路

结构化工具进度链路：

```text
Codex app-server
  -> item/started 或 item/completed
  -> AppServerTurnController 映射为 tool.progress
  -> BridgeRouteQueue / BackgroundTurns 判断当前 route 是否应投递工具进度
  -> BridgeDelivery.sendToolProgress()
  -> ChannelRegistry.sendToolProgress()
  -> WeixinAdapter.sendToolProgress()
  -> 微信 sendmessage(TOOL_CALL_START/TOOL_CALL_RESULT)
```

普通文本进度链路：

```text
Codex app-server 或 exec adapter
  -> assistant.progress
  -> BridgeProgressDelivery 按 /progress 模式过滤
  -> BridgeDelivery.sendProgressText()
  -> WeixinAdapter.sendText()
  -> 微信 sendmessage(TEXT)
```

本地日志链路：

```text
BridgeDelivery
  -> logger.debug / logger.warn
  -> RuntimeTuiLogger 或 ConsoleLogger
  -> 本机 TUI / stdout
```

## 投递模式语义

微信当前支持：

```text
/progress silent
/progress brief
/progress detailed
/progress tools
```

| 模式 | 普通文本进度 | 结构化工具进度 | 用户是否一定能看到工具信息 |
| --- | --- | --- | --- |
| `silent` | 不投递 | 不投递 | 只能看到最终回复、审批、错误等关键消息 |
| `brief` | 投递摘要文本 | 不投递 | 能看到摘要文本 |
| `detailed` | 投递完整可见文本进度 | 投递 `TOOL_CALL_START/RESULT` | 能看到文本进度；结构化进度是否明显展示取决于微信客户端 |
| `tools` | 不投递 | 投递 `TOOL_CALL_START/RESULT` | 不保证像普通文本一样可见 |

结论：

- 如果目标是“用户在微信里明确看到工具做了什么”，应使用 `/progress detailed`。
- 如果目标是“测试微信 2.4.4 结构化工具生命周期是否能被接收或聚合”，使用 `/progress tools`。
- 如果目标是“少打扰，只看最终结果”，使用 `/progress silent`。

## 为什么会刷屏

一次工具调用至少有两个生命周期事件：

```text
phase=start
phase=end
```

如果本地诊断日志为每个发送动作都记录：

```text
send started
send succeeded
```

那么一次工具调用会产生至少四条本地日志：

```text
tool progress send started phase=start
tool progress send succeeded phase=start
tool progress send started phase=end
tool progress send succeeded phase=end
```

命令、搜索、文件操作、测试运行等会产生多个工具 item。`npm test` 这类任务还会产生普通文本 detailed progress，因此本地 TUI 会快速堆出数百行。

这类刷屏不是微信真的向用户发了数百条普通消息，而是本地诊断日志把每次低层投递动作都展开显示了。

## 日志策略

### 日常默认

默认只展示：

- 入站消息。
- 出站普通文本和媒体 transcript。
- 本地未投递进度摘要。
- 失败和警告。
- 关键系统状态。

默认不输出成功路径的低层投递流水：

- `progress message send started`
- `progress message send succeeded`
- `tool progress send started`
- `tool progress send succeeded`

失败必须保留：

- `progress message send failed`
- `tool progress send failed`
- `channel text send failed`
- `channel media send failed`
- `channel typing send failed`

失败日志必须带足够信息：

- `channel`
- `routeKey`
- `account`
- `conversationKind`
- `conversationId`
- `toolName`
- `toolCallId`
- `phase`
- `status`
- `error`
- `cooldownMs`

如果普通文本进度发送失败，除了 warn，还要把该条进度正文记为本地未投递进度：

```text
发送失败，未投递到聊天渠道。
正在分析...

错误: sendmessage failed: ret=-2 errcode=0
```

这样 detailed 模式下即使微信投递失败，本机也能看到失败的是哪一条普通文本进度。

结构化工具进度没有天然的普通文本正文，因此失败时需要生成一段可读正文：

```text
工具进度发送失败，未投递到聊天渠道。
工具进度:
工具: command: npm test
阶段: 结束
状态: completed
调用 ID: cmd-1

错误: sendmessage failed: ret=-2 errcode=0
```

普通文本进度和结构化工具进度使用各自独立的失败冷却，避免 detailed 模式下某一类投递失败把另一类详情也挡住。普通文本进度前一次发送失败导致后续文本进度处于冷却期时，后续未投递内容也必须进入本地日志：

```text
发送暂缓，未投递到聊天渠道。
原因: 前一次进度投递失败，当前处于 60s 冷却期。
上次错误: sendmessage failed: ret=-2 errcode=0
后续进度
```

工具结构化进度冷却时同理；它只影响后续结构化工具进度，不影响普通文本进度继续投递：

```text
工具进度发送暂缓，未投递到聊天渠道。
原因: 前一次进度投递失败，当前处于 60s 冷却期。
上次错误: sendmessage failed: ret=-2 errcode=0
工具进度:
工具: web_search
阶段: 开始
调用 ID: search-1
```

### Trace 模式

如果后续确实需要逐条原始投递流水，应单独引入 trace 开关，例如：

```text
CHAT_CODEX_TRACE_DELIVERY=1
```

trace 允许刷屏，用于短时间复现问题，不作为日常 debug。

## 聚合诊断设计

长期方案是新增 `DeliveryDiagnostics`，把低层投递流水聚合成 route/turn 级摘要。

### 聚合维度

- `routeKey`
- `turnRunId` 或 `turnId`
- `channel`
- `messageKind`: `text_progress` / `tool_progress`
- `toolName`
- `toolCallId`

### 聚合计数

每个 turn 统计：

- 普通进度发送开始次数。
- 普通进度发送成功次数。
- 普通进度发送失败次数。
- 工具进度 start 数。
- 工具进度 end 数。
- 工具进度发送成功次数。
- 工具进度发送失败次数。
- 最近一条失败 error。
- 最近几个样本 toolName/toolCallId。

### 输出规则

正常情况下，turn 结束时最多输出一条摘要：

```text
微信投递摘要: text_progress ok=3 failed=0, tool_progress ok=8 failed=0, route=...
```

如果失败，立即输出完整 warn：

```text
tool progress send failed channel=weixin routeKey=... toolName=... toolCallId=... error=...
```

如果发送开始后长时间未返回，输出低频等待提示：

```text
微信进度投递等待中: 12s route=... kind=tool_progress toolName=...
```

等待提示必须低频，例如同一 route 最多每 30 秒一条。

### TUI 展示

TUI 默认展示：

- 一条摘要。
- 失败详情。
- 等待超时提示。

TUI 不默认展示：

- 每次 `send started`
- 每次 `send succeeded`

Debug 展示：

- 每个 turn 的聚合摘要。
- 最近 3 到 5 条样本。

Trace 展示：

- 全量 started/succeeded/failed 流水。

## 用户可见策略

“工具调用的信息是否会输出到微信”取决于当前 `/progress` 模式：

- `silent`：不会把工具过程发给微信，只发最终结果和关键交互。
- `tools`：会把结构化工具生命周期发给微信接口，但不保证客户端像普通文本一样显示。
- `detailed`：会发普通文本进度，所以用户应该能看到工具/命令摘要；同时也发结构化工具生命周期。
- `brief`：会发低噪声文本摘要，不发结构化工具生命周期。

因此不能把本地日志当作微信消息数量，也不能把结构化工具进度成功当作用户一定看到了文本。

## 实施计划

### 阶段 1：止血

已完成或应保持：

- 成功路径不输出 `send started/succeeded` 低层流水。
- `failed` 继续使用 `warn` 并完整展示。
- 普通文本进度投递失败时，写入本地未投递进度正文。
- 工具进度日志包含 `toolCallId`，方便判断 start/end 是否成对。
- `webSearch` completed 默认映射为 `completed`，避免无意义的 `unknown`。

### 阶段 2：聚合摘要

新增 `DeliveryDiagnostics`：

- `recordStarted()`
- `recordSucceeded()`
- `recordFailed()`
- `flushTurnSummary()`
- `recordSlowSend()`

BridgeDelivery 不直接刷成功日志，而是写入聚合器。Route turn 结束、失败、取消时 flush。

### 阶段 3：Trace 开关

新增独立 trace 开关：

```text
CHAT_CODEX_TRACE_DELIVERY=1
```

只有 trace 才显示全量投递流水。

### 阶段 4：实测校准

用微信实测三组任务：

1. `/progress tools` + 多次 web search。
2. `/progress detailed` + `npm test`。
3. `/progress silent` + 长任务最终回复。

记录：

- 微信客户端实际可见内容。
- 本地摘要日志。
- 失败或等待提示是否足够判断问题。

## 测试要求

单元测试：

- 成功路径不进入默认 TUI。
- 失败路径仍显示 warn。
- 普通文本进度发送失败时，本地 transcript 包含失败的进度正文，且不额外添加 `Codex 进度:` 标题。
- 结构化工具进度发送失败后，普通文本进度仍可继续投递；两类进度失败冷却互不影响。
- 聚合器能正确统计 start/end/succeeded/failed。
- trace enabled 时能输出全量流水。

集成测试：

- `/progress tools` 会调用 `sendToolProgress`，但默认 TUI 不刷 started/succeeded。
- `/progress detailed` 会发送普通文本 progress，TUI transcript 保留真实出站文本。
- 微信发送失败时，TUI 有完整 `warn`。

## 结论

这批刷屏日志来自 Chat-Codex Bridge 投递层，不是微信用户消息，也不是微信 SDK 原生日志。

工具调用信息可以发送到微信，但有两种形态：

- 普通文本进度：用户明确可见，主要由 `/progress brief/detailed` 控制。
- 结构化工具进度：发给微信接口，主要由 `/progress tools/detailed` 控制，但客户端是否明显展示取决于微信侧。

本地诊断日志应服务排障，不应在日常模式下逐条展开成功流水。长期应使用“失败展开、成功聚合、trace 全量”的三层策略。
