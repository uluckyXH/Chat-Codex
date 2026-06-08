# Codex 进度本地实时可观测与渠道节流投递设计

> 2026-06-08 更新：用户可见 `/progress` 模式已按 `progress-mode-simplification-design.zh-CN.md` 收敛。微信只公开 `silent`、`brief`；飞书只公开 `realtime`、`silent`、`brief`；`detailed` 和 `tools` 保留内部能力但不再作为普通 `/progress` 选项。

## 背景

Chat-Codex 当前已经支持把 Codex 执行任务时的阶段性进度投递到微信、飞书和 TUI transcript。为了避免聊天渠道刷屏，`BridgeProgressDelivery` 对普通文本进度做了节流、合并、去重和截断：

- 同一路由进度默认最小投递间隔是 3 秒。
- 3 秒内的新进度会进入 pending，后续在 flush 时合并投递。
- pending 最多保留最后 3 条。
- 最近重复进度会去重。
- 单条渠道进度会按最大长度截断。

这个策略对微信和飞书是必要的，但带来一个可观测性问题：被节流或进入 pending 的进度不会立即出现在本地 TUI / transcript 中。用户会看到 Codex 仍在执行，但本地日志没有持续滚动，容易误判为“进度没动”或“微信 detailed 模式没有投递”。

## 当前行为

主要链路：

```text
CodexEvent assistant.progress
  -> BridgeProgressDelivery.handleProgress()
  -> 过滤 / 去重 / 节流 / pending 合并
  -> BridgeDelivery.sendProgressText()
  -> ChannelRegistry.sendText()
  -> 微信 / 飞书
  -> TranscriptSink.outboundProgress()
```

当前 `TranscriptSink.outboundProgress()` 只在渠道发送成功后记录“已投递进度”。如果进度被节流进入 pending，本地也暂时看不到这一条进度。

历史 `/progress detailed` 的语义曾是“所有普通文本进度类型都允许进入投递链路”，但它不是“每一条 Codex progress event 都逐条发送到聊天渠道”。当前用户可见模式已精简，`detailed` 不再作为普通 `/progress` 选项。

## 问题判断

这里有两类目标，不能继续绑在同一个动作上：

1. 本地可观测性
   - 面向正在操作 Chat-Codex 的本机用户。
   - 目标是确认 Codex 正在推进、看到最新阶段、便于排查。
   - 应该尽量实时、完整，但仍要去掉空文本和明显重复。

2. 聊天渠道投递
   - 面向微信、飞书里的聊天用户。
   - 目标是传递有价值的阶段变化，不刷屏、不触发渠道限流。
   - 应该继续节流、合并、截断，并保留失败冷却。

因此，“本地显示进度”和“渠道发送进度”应拆成两个独立语义。

## 目标

1. Codex 每产生一条有效普通文本进度，本地 TUI / transcript 尽快显示。
2. 微信、飞书渠道在 `brief` 下继续按现有节流、合并、去重、截断策略慢慢投递。
3. 本地 TUI / transcript 能持续看到 observed progress 在动，不依赖聊天渠道是否投递。
4. `/progress realtime` 仅在飞书等渠道策略允许时把普通文本进度逐条直接投递到聊天渠道。
5. 渠道发送失败或进入 cooldown 时，本地进度仍继续显示。
6. 不改变最终回复、审批、错误、安全通知、输入请求和文件发送逻辑。
7. 不在 Bridge Core 中写死微信或飞书分支，继续通过通用进度投递模块和 transcript 接口表达。

## 非目标

- 不把微信/飞书改成默认逐条实时投递；逐条投递只由显式 `/progress realtime` 且渠道 `realtimeProgress: "send"` 时打开。
- 不在真实微信渠道开放 `/progress realtime`。真实微信实测连续发送普通文本进度会出现 `ret=-2`、延迟堆积或等下一条用户消息后集中放出，不能作为稳定承载全量进度的能力。
- 不删除 `detailed` / `tools` 内部代码能力，但它们不再作为普通 `/progress` 公开模式。
- 不改变 Codex app-server 协议。
- 不在聊天渠道发送完整命令 stdout/stderr。
- 不新增具体渠道私有命令来控制本地日志。

## 设计方案

### 1. 本地实时进度事件

在 `BridgeProgressDelivery.handleProgress()` 收到有效 `assistant.progress` 后，先做最基础的本地可见性处理：

```text
trim 空文本
  -> policy / mode 判断
  -> 本地记录可见或被隐藏的进度
  -> 渠道投递去重 / 节流 / pending 合并
```

建议新增或复用 transcript 语义：

- `outboundProgress(target, text)`
  - 表示已经成功投递到聊天渠道的进度。
- `localProgress(target, text)`
  - 表示只在本地显示、未投递到聊天渠道的进度。

为了避免“本地进度”全部看起来像失败或未投递，后续可以考虑把本地状态再细分成：

- `observedProgress`
  - Codex 已产生，正在本地实时显示。
- `localProgress`
  - 由于渠道 policy、模式、失败或 cooldown 而明确未投递。

第一版优先少改接口，可以先复用 `localProgress()`，但文案要避免误导。建议本地实时显示标题使用：

```text
本地进度
```

而发送失败或渠道 suppress 的标题继续使用：

```text
本地进度（未投递）
```

如果现有 `ConsoleTranscriptSink.localProgress()` 无法区分这两类标题，则实现阶段应新增 transcript 方法，而不是把不同语义都塞进同一个正文。

### 2. 渠道投递仍保持节流

微信和飞书渠道仍走现有 `BridgeProgressDelivery` 策略：

- 首条进度可以立即投递。
- 3 秒窗口内后续进度进入 pending。
- pending flush 时合并最后若干条。
- 重复文本去重。
- 单条消息继续按最大长度截断。
- 发送失败后仍进入文本进度失败 cooldown。

这样能保持真实微信/飞书通道稳定，避免 detailed 模式把高频进度逐条打到聊天里。

### 3. brief / silent 模式语义

`/progress brief` 是当前聊天渠道的主要进度模式：

```text
只允许摘要类普通文本进度进入渠道投递链路，但渠道仍可节流合并。
```

`/progress silent` 表示聊天渠道静默：

```text
不发送普通文本进度和结构化工具生命周期，但本地 TUI / transcript 仍可显示 observed progress。
```

`detailed` 保留为内部/历史模式，不再通过普通 `/progress` 展示或接受。需要看完整进度时优先看本地 TUI / transcript。

### 4. realtime 模式语义

新增 `/progress realtime`，用于支持该能力的渠道排查和用户显式要求的全量进度投递。

是否允许 realtime 由通用 `ChannelDeliveryPolicy.realtimeProgress` 决定：

- 飞书：`realtimeProgress: "send"` 且 `allowedProgressModes` 包含 `realtime`。
- 默认/Terminal/Mock/微信：普通 `/progress` 不公开 realtime；微信同时将 `realtimeProgress` 设为 `"suppress"`。

这样 Bridge Core 不需要写死微信分支；微信 adapter 用 policy 表达真实平台限制。

`realtime` 的语义是：

```text
Codex 产生一条有效普通文本进度，Bridge 就立即尝试向聊天渠道发送这一条进度。
```

`realtime` 不做 Bridge 进度投递层保护：

- 不节流。
- 不进入 pending。
- 不合并多条进度。
- 不对最近重复文本去重。
- 不做普通文本进度长度截断。
- 不使用普通文本进度失败 cooldown。

如果渠道发送失败：

- 记录失败日志和本地 transcript 诊断。
- 不开启 progress cooldown。
- 不阻断下一条 realtime 进度继续发送。

底层渠道 adapter 或真实平台仍可能有不可绕过的物理限制，例如 HTTP 超时、连接错误、平台限流、单条消息长度限制、账号状态异常、adapter 自身串行队列等。`realtime` 不在 Bridge 进度投递层额外保护这些情况；如果真实平台拒收，就按失败记录并继续后续进度。对已经验证无法稳定承载的渠道，应通过 `realtimeProgress: "suppress"` 不暴露该模式。

`realtime` 不影响结构化工具进度：

- 普通文本进度逐条发送。
- 结构化 `TOOL_CALL_START/RESULT` 是否发送仍按渠道 `toolProgress` policy 和模式设计决定。

### 5. 失败和 cooldown

渠道失败不应影响本地进度实时显示：

```text
assistant.progress
  -> 本地实时显示
  -> 尝试渠道投递
  -> 渠道失败则记录失败诊断和 cooldown
  -> 后续 assistant.progress 继续本地显示
  -> cooldown 内不发渠道，但本地显示 cooldown 诊断或普通本地进度
```

当前文本进度和结构化工具进度已经拆成独立 cooldown，本设计不改变这个边界。

上述 cooldown 规则只适用于 `brief` / `detailed` 等节流投递模式。`realtime` 下普通文本进度不使用失败 cooldown；失败只记录，不抑制后续普通文本进度。

### 6. TUI 展示建议

运行期 TUI 日志建议区分两种进度：

- `progress`
  - 已发送到渠道，或渠道无关的普通进度。
- `local-progress`
  - 本地观测到、尚未或不会发送到渠道。

如果短期不新增日志类型，也可以继续用 `progress` 类型，但标题必须能看出状态：

- `微信 -- 用户 | 本地进度`
- `微信 => 用户 | 进度`
- `微信 -- 用户 | 发送失败，未投递`

重点是用户能看到 Codex 仍在推进，而不是等待 3 秒甚至等到任务结束才看到合并进度。

## 实现计划

### 阶段一：本地实时显示

1. 调整 `BridgeProgressDelivery.handleProgress()`：
   - 收到有效进度后，先按 route/mode/policy 判断本地显示语义。
   - 对允许显示的进度立即写 transcript。
   - `brief` 渠道投递仍使用现有节流和 pending 逻辑。
   - `realtime` 渠道投递绕过节流、pending、合并、去重、截断和普通文本进度失败 cooldown。
2. 调整 transcript 接口：
   - 如果 `localProgress()` 无法表达“本地实时观测”和“未投递失败诊断”的差异，则新增可选方法。
   - Console transcript 和 TUI transcript 都实现新方法。
3. 保留 `outboundProgress()`：
   - 渠道发送成功后仍记录实际已投递内容。
4. 扩展 `/progress` 模式：
   - `ProgressDeliveryMode` 增加 `realtime`。
   - `/progress` 帮助、状态和错误文案增加 `realtime`。
   - 微信渠道显示 `silent, brief`。
   - 飞书渠道显示 `realtime, silent, brief`。
   - 默认/Mock/Terminal 显示 `silent, brief`。

### 阶段二：测试覆盖

新增或调整测试：

- `BridgeProgressDelivery` 单元测试：
  - 3 秒节流内的第二、第三条进度会立即写本地 transcript。
  - flush 后仍只向渠道发送合并进度。
  - repeated progress 不重复写本地或至少按设计去重。
  - 渠道 suppress / route silent 下不发渠道，但本地行为符合设计。
  - realtime 模式下多条进度逐条调用渠道发送，不进入 pending。
  - realtime 模式下重复进度也逐条发送。
  - realtime 模式下超长进度不经过 Bridge 进度层截断。
- `BridgeDelivery` 单元测试：
  - 渠道发送失败后，本地失败诊断仍保留。
  - cooldown 内后续进度不发渠道，但本地实时进度不被吞。
  - realtime 模式下渠道发送失败不设置普通文本进度 cooldown，下一条仍继续发送。
- TUI / transcript 测试：
  - `outboundProgress()` 仍显示为“进度”。
  - 新增的本地实时进度方法显示为明确标题。
- 集成测试：
  - 微信-like brief 模式下，高频 progress 事件本地全部可见，渠道仍节流合并。
  - `/progress detailed` 和 `/progress tools` 在微信-like 渠道返回可用值错误。
  - 微信-like 渠道拒绝 `/progress realtime`，高频 progress 不会逐条发送到微信-like 渠道。
  - 飞书 realtime 模式下，高频普通文本进度逐条发送到渠道。

### 阶段三：文档和测试报告

实现完成后必须更新：

- `reports/tests/YYYY-MM-DD-progress-local-observability.md`
  - 中文测试报告。
  - 记录构建、定向测试、全量测试或无法执行的原因。
- 必要时更新：
  - `docs/progress-noise-control-design.zh-CN.md`
  - `docs/technical-design.zh-CN.md`
  - `docs/weixin-tool-progress-delivery-diagnostics-design.zh-CN.md`

## 开发规范约束

实现阶段必须遵守 `docs/development-and-test.zh-CN.md`：

- 文档、测试报告和开发记录以中文为主。
- 功能实现后必须自测。
- 自测必须在 `reports/tests/` 留中文测试报告。
- 提交前执行 `git status --short --ignored` 和 `npm test`。
- 不能提交 `node_modules/`、`dist/`、登录态、token、cookie、日志和运行态状态。
- Bridge Core 只能依赖通用渠道协议，不能直接依赖微信原始类型。
- 平台投递差异优先通过通用 capability、delivery policy、adapter 或 transcript 语义表达，不写具体渠道分支。
- 新增能力优先放进对应职责模块，不把逻辑堆进中央 switch。
- 测试结构跟随模块边界：纯进度投递逻辑写单元测试，Bridge 到 mock/weixin-like/feishu-like 流程写集成测试。

## 风险和取舍

### 本地日志可能更密

本地实时显示会让 TUI 日志滚动更频繁。缓解方式：

- 保持 RuntimeLogStore 条数上限。
- 对完全重复文本去重。
- 不把命令输出 delta 原样刷入本地进度；命令长输出仍走现有摘要策略。

### 用户可能误解“本地进度”等于“已发微信”

需要在标题上区分：

- `=>` 表示已发渠道。
- `--` 表示本地观察或未投递。
- 失败诊断正文明确写“发送失败，未投递到聊天渠道”。

### realtime 会放大真实渠道风险

`realtime` 是显式全放开模式，会明显增加真实通道风险：

- 可能触发平台限流。
- 可能导致消息乱序或延迟堆积。
- 可能因为单条消息过长而发送失败。
- 可能让聊天窗口被大量进度刷屏。
- 可能使发送失败日志增多。

这些风险是 `realtime` 模式的预期代价。实现时不在 Bridge 进度投递层增加兜底保护；用户显式开启该模式即表示接受这些风险，用于调试或确实需要全量进度投递的场景。

真实微信已经出现连续投递 `sendmessage failed: ret=-2 errcode=0` 和消息堆积现象，因此微信 adapter 不开放 realtime。微信 detailed 的价值转为：

- 本地 TUI / transcript 实时显示全部 observed progress。
- 微信聊天渠道按节流、合并、去重、截断和失败 cooldown 慢速投递有价值的普通文本进度。
- 结构化 `TOOL_CALL_START/RESULT` 代码保留，但 `/progress tools` 不再是普通用户入口。

### detailed 不再作为公开模式

真实使用中 `detailed` 既不是完整逐条投递，也会增加微信失败面，用户价值不清晰。因此公开模式砍掉 `detailed`。需要逐条投递时，只在飞书这类 `allowedProgressModes` 包含 `realtime` 的渠道使用 `/progress realtime`。

## 已决策与后续

1. 已新增 transcript `observedProgress()`，避免复用 `localProgress()` 造成“本地观察”和“发送失败未投递”语义混淆。
2. 非 realtime 模式下，本地实时进度做最近重复去重，避免等待型任务刷屏。
3. 微信不开放 `/progress realtime`；飞书保留。
4. `detailed` 和 `tools` 不再作为普通 `/progress` 公开模式，代码能力保留。
