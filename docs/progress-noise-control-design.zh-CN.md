# Codex 进度噪声控制设计

> 2026-06-08 更新：普通 `/progress` 用户可见模式已精简。微信只公开 `silent/brief`，飞书公开 `realtime/silent/brief`；本文中关于 `/progress detailed` 的内容保留为历史设计背景和内部能力说明，不再代表当前用户可见命令。

## 背景

Chat-Codex 会把 Codex app-server 的阶段性事件转成微信、飞书或 TUI 里的进度消息。这个机制对长任务很重要，但 Codex 在执行某些命令时会产生大量中间输出：

- 命令标准输出或标准错误持续追加。
- 等待型命令反复打印状态行、进度条、转圈动画或时间计数。
- 工具运行期间产生大量低信息增量。

如果这些增量被逐条当成普通文本进度投递，就会造成渠道刷屏、TUI 日志被挤满、飞书消息过多，以及用户难以看到真正重要的审批、最终回复和错误信息。

## 当前链路

当前主要链路如下：

```text
Codex app-server notification
  -> AppServerTurnController
  -> CodexEvent assistant.progress / assistant.commentary
  -> BridgeRouteQueue / BridgeBackgroundTurns
  -> BridgeProgressDelivery / BridgeCommentaryDelivery
  -> ChannelRegistry.sendText
  -> 微信 / 飞书 / Mock / TUI transcript
```

关键实现位置：

- `src/codex/app-server/turn-controller.ts`
  - `item/reasoning/summaryTextDelta` 和 commentary `item/agentMessage/delta` 已进入草稿缓冲；commentary flush 后产出独立 `assistant.commentary`。
  - `item/commandExecution/outputDelta` 目前会把每个 delta 直接推成 `assistant.progress`，这是命令长输出刷屏的主要风险点。
- `src/codex/app-server/notification-mapper.ts`
  - `progressFromThreadItem()` 会在 `commandExecution` 完成时读取 `aggregatedOutput` 并生成命令完成进度。
  - `shouldFlushProgressDraft()` 当前遇到换行就 flush，长等待输出或频繁换行的状态文本也可能被高频投递。
- `src/bridge/route-queue.ts` 和 `src/bridge/background-turns.ts`
  - 收到 `assistant.progress` 后按 `/progress` 模式和渠道 policy 决定是否发送。
  - 收到 `assistant.commentary` 后按独立旁白策略投递；Plan mode 默认可见，commentary-only 可兜底为最终回复。
- `src/bridge/delivery.ts`
  - 只有发送失败后的 cooldown，没有正常情况下的频率限制、合并窗口或低信息过滤。

## Codex 官方源码核对结论

本设计已按本地参考源码 `references/openai-codex/` 核对 Codex app-server 和 core 的命令输出链路。结论是：命令输出事件边界很清楚，适合强识别；转圈、等待状态和进度条没有被 Codex 单独语义化，适合弱启发式折叠。

### app-server 事件边界

Codex app-server 会把 core 的 exec 事件映射成明确的 app-server notification：

- `ExecCommandBegin`
  - 映射为 `item/started`。
  - item 类型是 `commandExecution`。
  - item 内包含 `command`、`cwd`、`processId`、`source`、`status`、`commandActions` 等字段。
- `ExecCommandOutputDelta`
  - 映射为 `item/commandExecution/outputDelta`。
  - 参数结构是 `threadId`、`turnId`、`itemId`、`delta`。
  - `delta` 是命令输出 chunk 解码后的文本，不带 stdout/stderr stream 字段。
- `ExecCommandEnd`
  - 映射为 `item/completed`。
  - item 类型仍是 `commandExecution`。
  - item 内包含 `aggregatedOutput`、`exitCode`、`durationMs`、`status`。

因此 Chat-Codex 不应该靠文本猜测“这是不是命令输出”。判断命令实时输出应优先使用 notification method：

```text
item/commandExecution/outputDelta
```

判断命令完成摘要应优先使用 item type：

```text
item/completed + item.type === "commandExecution"
```

### app-server 独立命令流

Codex app-server 还有一套独立的 `command/exec` 协议，用于客户端发起 standalone command。它的输出事件是：

```text
command/exec/outputDelta
```

这个事件的 delta 是 base64 bytes，并且有 stdout/stderr stream 标识。它和 agent turn 中的 `item/commandExecution/outputDelta` 不是同一个事件，但治理原则一致：

- 原始 delta 不直接投递聊天渠道。
- 进入缓冲、统计、摘要。
- 完成时发 bounded summary。

当前 Chat-Codex 主路径是 agent turn 内的 `item/commandExecution/outputDelta`，后续如果接入 `command/exec`，也要进入同一套噪声控制模块。

### Codex 的输出上限不是聊天限流

Codex core 已经有一些保护：

- 普通 exec 每次读取约 8192 bytes。
- 单次 exec 最多发约 10000 个 `ExecCommandOutputDelta` 事件。
- stdout/stderr/aggregated output 有默认保留上限，当前参考源码中是 1 MiB。
- unified exec 使用 head/tail buffer：保留开头和结尾，中间超限丢弃。
- 给模型看的输出会走 `formatted_truncate_text()`，超限时带 `Total output lines` 和中间截断提示。

这些保护主要解决：

- Codex 进程不能被无限输出撑爆。
- 模型上下文不能被完整 stdout/stderr 淹没。
- app-server 单个 delta 不能无限大。

但它们不等于聊天渠道限流。即使 Codex 限制了 10000 个 delta，对飞书、微信或 TUI 来说仍然会刷屏。所以 Chat-Codex 必须在 Bridge 层额外做聊天投递控制。

### 转圈和等待状态

源码核对后没有看到 Codex 把 spinner、progress bar、waiting loop 单独标成语义事件。它们通常只是命令 stdout/stderr 的一部分：

```text
item/commandExecution/outputDelta.delta
```

因此这类内容只能在 Chat-Codex 里按文本形态弱识别：

- `\r` 覆盖式状态行。
- ANSI escape sequence。
- spinner 字符或少量符号反复变化。
- 高度重复的 waiting / running / progress 文本。
- 百分比、进度条、计数器反复刷新。

弱识别只用于折叠和摘要，不能影响最终回复、审批和错误消息。

## 问题判断

这类消息可以识别，但要分层处理。

### 可强识别

这些可以通过 app-server notification method 或 item type 明确识别：

- `item/commandExecution/outputDelta`
  - 命令实时输出增量。
  - 不应该逐条投递到聊天渠道。
- `item/completed` 且 `item.type === "commandExecution"`
  - 命令完成后的聚合结果。
  - 可以生成一条摘要，必要时附带输出尾部。
- `mcpToolCall`、`webSearch`、`fileChange`
  - 工具、搜索和文件变更完成事件。
  - 通常应保留为短摘要。

### 可弱识别

这些需要启发式判断，不能完全依赖协议字段：

- 转圈、进度条、动态状态行。
- 重复等待文本，例如 “waiting...”、“still running...”、“处理中...”。
- 只包含控制字符、ANSI 颜色、回车覆盖符 `\r` 或少量符号的输出。
- 高频重复或高度相似的状态文本。

### 不建议强行识别

reasoning/commentary 是 Codex 主动给用户看的工作说明，不能简单按“长”或“频繁”删除。reasoning 仍走普通进度缓冲、去重、节流；commentary 已拆为独立旁白事件，走独立投递和兜底规则，而不是直接归类为噪声。

## 目标

1. 聊天渠道不再被命令长输出、转圈动画和等待状态刷屏。
2. `/progress detailed` 仍能看到有价值的细节，但“详细”不等于逐字流式转发。
3. `/progress brief` 继续只展示高层进度，不展示命令输出细节。
4. `/progress silent` 不投递进度，只保留开始、审批、错误和最终回复。
5. 当前主干微信 progress suppress 语义保持不变，仍不向微信发送进度；微信 2.4.4 结构化进度实验另见专项设计，不由本文打开。
6. TUI 运行日志保留最近 300 条，但每条日志应是有意义的摘要或完整最终消息，不能被无意义增量挤满。
7. 本地 transcript / TUI 可以保留必要调试信息，但不应把敏感信息或超长输出直接刷到聊天渠道。

## 非目标

- 不改变 Codex app-server 协议。
- 不影响最终回复、审批请求、文件发送和 `/stop`。
- 不把某个具体渠道写死进 Bridge Core。
- 不为每个 shell 命令定制规则。
- 不在聊天渠道里发送完整 stdout/stderr；完整原始输出如需保留，应走本地日志能力，且需要长度上限和脱敏。

## 设计原则

### 1. 对齐 Codex 官方事件边界

命令执行相关事件必须优先按 Codex app-server 的官方 method 和 item type 识别：

- 实时输出：`item/commandExecution/outputDelta`
- 命令开始：`item/started` + `commandExecution`
- 命令完成：`item/completed` + `commandExecution`

文本启发式只能作为弱识别补充，用于处理 spinner、等待状态和重复状态行，不能替代协议字段。

### 2. Codex adapter 负责识别事件来源

app-server adapter 最了解 notification method 和 item type，应在这里把“命令输出 delta”“命令完成摘要”“reasoning/commentary 草稿”等语义区分清楚。

Bridge Core 不应该通过文本内容猜测这是 npm、git、pytest 还是某个命令的输出。

### 3. 摘要策略参考 Codex 的 head/tail 和截断思路

Codex 自身对长输出采用保留上限、head/tail buffer 和 `Total output lines` 截断提示。Chat-Codex 的聊天摘要也应沿用这个方向：

- 保留开头少量上下文。
- 保留结尾关键错误。
- 中间超限明确写“已省略”。
- 失败命令比成功命令保留更多尾部。

区别是 Chat-Codex 的目标不是喂给模型，而是给聊天用户读，因此摘要长度应明显小于 Codex 内部 1 MiB 级别的保留上限。

### 4. Bridge delivery 负责投递限流

即使上游已经做了摘要，Bridge 也需要有统一保护：

- 同一路由进度最小投递间隔。
- 相同或高度相似文本去重。
- 单条进度最大长度。
- 重要事件优先级。

这样未来新渠道、新 adapter 或新增进度类型时，不会重新引入刷屏。

### 5. 详细模式也必须有边界

`/progress detailed` 的含义是“显示更多类型的进度”，不是“把 Codex 的每个 delta 都发到聊天”。详细模式可以展示：

- 命令开始。
- 命令仍在运行的低频 heartbeat。
- 命令完成摘要。
- 失败命令的错误尾部。

但不展示每一行输出 delta。

### 6. 本地日志和聊天投递分离

聊天渠道只收用户可读摘要。本地 TUI/transcript 可以显示更多细节，但也要防止 300 条日志被同一个命令输出挤满。

后续如需要完整命令输出，应设计单独的本地 debug log 文件，而不是复用聊天进度消息。

## 事件分类

建议把进度事件分成以下语义层：

```ts
type CodexProgressKind =
  | "reasoning"
  | "todo"
  | "search"
  | "file_change"
  | "command"
  | "command_output"
  | "tool"
  | "other";
```

也可以不新增 kind，而是在 `CodexEvent` 上增加更明确的元数据：

```ts
interface CodexProgressMeta {
  source?: "reasoning" | "commentary" | "command" | "tool" | "system";
  detailLevel?: "summary" | "verbose" | "raw_delta";
  itemId?: string;
  ephemeral?: boolean;
}
```

推荐优先使用最小改动：

- 保留现有 `kind`。
- 新增 `command_output` 或 `raw_command_output` 这类明确 kind。
- 后续如果元数据增长，再引入 `meta`。

## Codex Adapter 优化

### 命令 started

当收到 `item/started` 且 item type 是 `commandExecution`：

- 记录 `itemId -> command/cwd/startTime`。
- 可生成一条摘要进度：

```text
正在执行命令: npm test
```

这条进度 kind 为 `command`，在 brief 模式默认不发送，在 detailed 模式可发送。

### 命令 outputDelta

当收到 `item/commandExecution/outputDelta`：

- 不再直接推送 `assistant.progress`。
- 进入 per-turn、per-item 的命令输出缓冲。
- 以 `itemId` 作为同一条命令的聚合 key。
- 只把它作为命令输出源处理，不再混入 reasoning/commentary progress 草稿。
- 缓冲需要统计：
  - 字符数。
  - 行数。
  - 最近若干行 tail。
  - 最后一条非空输出。
  - 是否包含 ANSI/control chars。
  - 是否高度重复。

建议默认只记录摘要数据，不保留完整原始输出，避免内存增长和敏感信息风险。

可选：在 detailed 模式由 Bridge 低频投递 heartbeat。但 app-server adapter 不知道 route 的 `/progress` 模式，因此 adapter 只产生结构化摘要事件，是否发送由 Bridge 决定。

如果后续接入 `command/exec/outputDelta` 或 `process/outputDelta`，也应进入同一套缓冲模型，但需要先解码 base64，并保留 stdout/stderr stream 信息用于失败摘要。

### 命令 completed

当收到 `item/completed` 且 item type 是 `commandExecution`：

- flush 对应命令输出缓冲。
- 输出一条 bounded summary：

```text
命令完成: npm test
输出摘要:
最后 20 行...
已省略 128 行 / 20480 字符。
```

失败命令：

```text
命令失败: npm test
错误摘要:
最后 40 行...
已省略 128 行 / 20480 字符。
```

长度建议：

- 成功命令：最多 800 字符或 20 行。
- 失败命令：最多 1600 字符或 40 行。
- 超出必须显示省略说明。

### 转圈和等待输出

在命令输出缓冲阶段做低信息过滤，不直接投递：

- 去除 ANSI escape sequence。
- 把 `\r` 覆盖型状态行视为 ephemeral。
- 只包含 spinner 字符、进度条符号、百分比反复变化的输出，只更新 “最后状态”，不产生多条进度。
- 连续重复或相似度高的行合并为计数：

```text
重复等待状态 37 次，最后状态: still running...
```

## Bridge Delivery 优化

新增一个独立模块，建议路径：

```text
src/bridge/progress-delivery.ts
```

职责：

- 决定某条 progress 是否应该发送。
- 执行 route 级正常限流。
- 合并短时间内的多条进度。
- 处理重复/相似文本。
- 调用 `BridgeDelivery.sendProgressText()` 做最终发送。

建议接口：

```ts
interface ProgressDeliveryController {
  handleProgress(input: {
    routeKey: string;
    target: ChannelTarget;
    policy: ChannelDeliveryPolicy;
    mode: ProgressDeliveryMode;
    text: string;
    kind?: CodexProgressKind;
  }): Promise<void>;

  flushRoute(routeKey: string): Promise<void>;
  clearRoute(routeKey: string): void;
}
```

默认策略：

- `silent`：不发送，只可写本地 transcript。
- `brief`：
  - 发送 `reasoning`、`todo`、`search`、`file_change`、`other` 的摘要。
  - 不发送 `command`、`command_output`、`tool`。
- `detailed`：
  - 可发送所有 kind。
  - 仍使用最小间隔和摘要，不逐 delta 投递。
- `policy.progress === "suppress"`：
  - 不发送到渠道。
  - 可写本地 transcript。
- `policy.progress === "aggregate"`：
  - 未来渠道可支持聚合编辑时使用；当前先按 send + 限流处理。

建议限流参数：

```text
同 route 进度最小投递间隔: 3-5 秒
同 route pending 合并窗口: 1-2 秒
单条进度最大长度: 1200 字符
同 turn 相同 normalized 文本: 去重
```

最终回复、审批、错误不经过这个进度限流，避免关键消息被延迟。

## TUI 运行日志

TUI 当前保留最近 300 条 runtime log。优化后：

- progress delta 不应一条 delta 占一条日志。
- 命令输出只进入摘要日志。
- 如果需要显示更多命令输出，可在单条日志内折叠展示 tail，而不是不断追加新条目。
- `/progress detailed` 可以让 TUI看到更多摘要，但仍不展示每个 raw delta。

## 用户可见行为

### 默认 brief

用户看到：

```text
正在分析...
```

可能看到：

```text
文件变更完成: src/a.ts, src/b.ts
```

不会看到：

```text
> npm test
...几百行测试输出...
```

### detailed

用户可能看到：

```text
正在执行命令: npm test
```

命令结束后看到：

```text
命令完成: npm test
输出摘要:
...
已省略 120 行 / 18000 字符。
```

如果命令长时间运行，可以低频看到：

```text
命令仍在运行: npm test
已收到 320 行输出，最后状态: running test suite...
```

### silent

只看到开始、审批、错误和最终回复，不看到进度。

### 微信

微信渠道仍由 delivery policy 禁用 progress，不投递进度。被 suppress 的重要进度可以进入本地 transcript/TUI，但不发微信消息。

## 测试设计

### 单元测试

新增或扩展：

- `tests/unit/app-server-mappers.test.ts`
  - `commandExecution` 完成输出会被截断并带省略说明。
  - ANSI/control chars 会被清理。
  - 重复等待行会合并。
- `tests/unit/app-server-codex-adapter.test.ts`
  - 多个 `item/commandExecution/outputDelta` 不会生成多条 raw progress。
  - 命令完成只生成一条 bounded summary。
  - 失败命令保留错误尾部。
- `tests/unit/bridge-progress-delivery.test.ts`
  - route 级限流。
  - brief 抑制 command/command_output。
  - detailed 发送摘要但不发送 raw delta。
  - suppress policy 只写本地 transcript。

### 集成测试

扩展 `tests/integration/bridge-mock.test.ts`：

- Mock Codex 连续产生 100 条 command output progress，渠道最多收到 bounded 数量摘要。
- `/progress detailed` 不刷屏。
- `/progress silent` 完全不发进度。
- 微信-like policy 不发送进度，但本地 transcript 有摘要。
- background goal turn 也走同一套进度控制。

### 手工验证

建议真实验证：

1. 飞书私聊触发一个长输出任务，例如测试、构建或等待型命令。
2. 默认 brief 下确认飞书不刷命令输出。
3. `/progress detailed` 后确认只看到低频摘要。
4. `/progress silent` 后确认不再收到进度。
5. TUI 日志确认不会被 raw delta 挤满。

## 实施顺序

1. 新增命令输出摘要工具。
2. 改 `AppServerTurnController`：
   - `commandExecution/outputDelta` 进入缓冲。
   - `commandExecution completed` 输出 bounded summary。
3. 新增 Bridge progress delivery controller。
4. `route-queue.ts` 和 `background-turns.ts` 统一改走 controller。
5. 补单元测试和集成测试。
6. 更新测试报告。

## 风险和边界

- 如果摘要过度压缩，用户可能看不到命令失败关键原因。失败命令应保留更长尾部。
- 如果完全不保留 raw output，排障能力下降。后续可设计本地 debug log 文件，但不能默认投递到聊天。
- 不同 Codex 版本 notification 字段可能变化，因此识别规则应以 method/item type 为主，文本启发式只做兜底。
- 不能让限流延迟最终回复、审批和失败消息。

## 结论

这个问题需要处理，而且可以处理。最可靠的优化方向不是在渠道层做文本过滤，而是在 Codex app-server adapter 层识别 raw command output，在 Bridge delivery 层统一做进度限流和摘要投递。

核心行为应改为：

```text
item/commandExecution/outputDelta -> 本地缓冲统计
命令完成/失败 -> 一条有边界的摘要
聊天 progress -> 按 route 限流、去重、合并
最终回复/审批/错误 -> 不受进度限流影响
```
