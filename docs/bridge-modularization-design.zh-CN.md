# Bridge 模块化拆分设计

## 背景

当前 `src/bridge/bridge.ts` 已经承担了过多职责：

- 渠道消息入口和生命周期管理。
- slash command 解析和分发。
- session 创建、恢复、选择、绑定和 owner 冲突处理。
- route 队列、执行中 steer、fallback 队列和 busy guard。
- Codex turn 启动、进度、最终回复、后台 Goal continuation。
- 审批投递、重试和审批命令处理。
- 文本发送、typing、媒体发送和 `/sendfile` 协议解析。
- `/status`、`/sessions`、`/whoami`、`/debug`、`/help` 等展示文案。
- model、permission、progress、plan/code、goal 等命令语义。

文件体积过大后，继续在单文件内增加功能会导致：

- 修改局部功能时难以判断副作用。
- 命令处理、投递、session 绑定、队列执行相互穿透。
- 测试失败时定位成本高。
- 后续多实例锁、更多渠道能力、更多 TUI/CLI 操作会继续推高复杂度。

因此需要把 `bridge.ts` 拆成按业务边界组织的小模块，同时保持现有功能、行为和测试全部不变。

## 目标

1. `Bridge` 保留为中枢路由和生命周期协调层。
2. 命令、session flow、route queue、steer、delivery、status/help 文案分别进入独立模块。
3. 拆分过程必须对齐现有全部功能，不改变外部行为。
4. 拆分前保留旧 `bridge.ts` 的本地对照备份，便于逐段迁移和 review。
5. 每个阶段都能独立编译、测试和提交。

## 非目标

- 不新增聊天命令。
- 不改变 route/session 独占绑定规则。
- 不改变 `/sendfile` 协议和文件发送安全限制。
- 不改变当前主干微信/飞书投递策略；微信 2.4.4 结构化进度属于后续专项适配。
- 不改变状态持久化目录。
- 不改变 TUI/CLI 交互语义。
- 不重写 Bridge 核心流程。

## 核心原则

### 行为优先

拆分是结构调整，不是功能重写。任何阶段都必须满足：

- 现有测试继续通过。
- 聊天内命令输出文案保持兼容。
- route/session 绑定、审批、文件发送、Goal、model、permission 等行为保持不变。
- 当前主干微信 progress suppress、飞书 progress/typing、媒体发送等渠道差异保持不变。

### Bridge 做路由

拆分后的 `Bridge` 应该主要负责：

- 构造依赖。
- 注册 channel message handler。
- 维护少量跨模块共享状态。
- 判断普通消息、媒体消息和 slash command。
- 把请求交给对应模块。

`Bridge` 不应继续直接承载大量命令细节、格式化细节和投递细节。

### 模块边界清晰

避免把大类替换成一个无边界的 `BridgeContext`。模块只接收自己需要的依赖。

推荐方向：

```ts
class Bridge {
  private readonly commands: BridgeCommandRouter;
  private readonly sessions: BridgeSessionFlow;
  private readonly queue: BridgeRouteQueue;
  private readonly steering: BridgeRouteSteering;
  private readonly delivery: BridgeDelivery;
}
```

如果某些模块确实需要共享状态，应先定义小接口，而不是直接暴露整个 `Bridge` 实例。

## 旧文件备份策略

拆分前先保留当前单体实现作为对照备份。

建议步骤：

1. 将当前 `src/bridge/bridge.ts` 复制或移动为：

```text
src/bridge/bridge.monolith.snapshot.ts.bak
```

2. 新建同名文件：

```text
src/bridge/bridge.ts
```

3. 在新的 `bridge.ts` 中逐段恢复和拆分实现。

选择 `.ts.bak` 后缀的原因：

- 文件仍然能作为 TypeScript 语法参考阅读。
- 不会被当前 `tsconfig.json` 的 `src/**/*.ts` 编译。
- 不会进入 `dist/`，也不会进入 npm 发布包。
- 可以在 review 时直接对照旧实现。

备份文件只用于拆分期。模块拆分稳定后，可以选择保留到一个单独清理提交中删除，或者移动到文档归档目录。

## 目标模块结构

建议最终结构：

```text
src/bridge/
  bridge.ts
  bridge-types.ts
  command-router.ts
  session-flow.ts
  route-queue.ts
  route-steering.ts
  background-turns.ts
  delivery.ts
  status-text.ts
  formatters.ts
  commands/
    collaboration-command.ts
    goal-command.ts
    model-command.ts
    permission-command.ts
    progress-command.ts
    sendfile-command.ts
```

现有文件继续保留：

```text
src/bridge/inbound-media.ts
src/bridge/inbound-media-store.ts
src/bridge/media-extractor.ts
src/bridge/turn-scheduler.ts
```

## 模块职责

### `bridge.ts`

保留：

- `BridgeOptions`
- `Bridge` 构造和依赖组装
- `start()`
- `stop()`
- `handleMessage()`
- 普通消息、媒体消息、命令消息的一级分流
- 顶层 idle 等待

不再直接承载：

- 具体 slash command 处理细节。
- 长篇 status/help 文案。
- model/goal/permission 解析。
- delivery retry 和 sendfile 解析细节。
- route queue 和 steer 的底层算法。

### `bridge-types.ts`

承载 Bridge 内部共享类型和常量：

- `QueuedPrompt`
- `QueuedSteer`
- `RouteSteerState`
- `BackgroundTurnState`
- `SessionChoice`
- `SessionSelectionState`
- `BindSessionResult`
- `InitialRouteBinding`
- `ProgressDeliveryMode`
- `UnboundRoutePolicy`
- route busy 文案和批处理默认值

注意：只放真正跨模块共享的类型。模块私有类型留在模块内。

### `command-router.ts`

负责 slash command 的分发：

- 根据 `parseCommand()` 结果调用对应 command module。
- 保留 route busy mutation guard。
- 保留 unknown command 行为。
- 保留 refresh command、平台特殊命令处理。

它不直接创建 session、不直接发送文件、不直接格式化复杂文本，只调用下游模块。

### `commands/*`

每个文件负责一类命令：

- `goal-command.ts`：`/goal`、goal 状态文案、goal 错误文案。
- `model-command.ts`：`/model`、模型列表、模型引用解析、reasoning effort 校验。
- `permission-command.ts`：`/permission`。
- `progress-command.ts`：`/progress`。
- `collaboration-command.ts`：`/plan`、`/code`。
- `sendfile-command.ts`：`/sendfile` 和 sendfile instruction 拼接。

命令模块可以返回文本、操作结果或调用注入的服务接口，但不应直接知道所有 Bridge 内部状态。

### `session-flow.ts`

负责 session 生命周期和绑定语义：

- 创建新 session。
- ensure session。
- resume/use session。
- session owner 冲突处理。
- pending initial route binding。
- session selection mode。
- session choices 展示数据。

必须保持：

- 一个 Codex session 只能绑定一个 route。
- pending 微信主聊天绑定也会占用 session。
- 选择已有 session 时使用历史 cwd。
- 新建 session 时使用当前 `startup.cwd` / Bridge `cwd`。

### `route-queue.ts`

负责普通 prompt 队列：

- `enqueuePrompt`
- `startRouteWorker`
- `drainRouteQueue`
- `forwardPrompt`
- route abort controller 绑定和释放
- `waitForIdle` 需要观察的 route worker 状态

必须保持：

- 同一 route 普通消息串行。
- 不同 route 可以并发，受 `TurnScheduler` 控制。
- `/stop` 能取消当前 route turn 并清空队列。

### `route-steering.ts`

负责执行中 steer：

- 判断是否可 steer。
- debounce。
- batch。
- steer 失败后 fallback 到 route queue。
- pending steer 统计。
- `/stop` 清理 steer 队列。

必须保持：

- steer 只作用于当前 route。
- 命令消息不进入 steer。
- 语义修改命令在 route busy 时被拒绝。
- steer rejected 时普通文本 fallback 排队。

### `background-turns.ts`

负责 Codex 后台事件：

- Goal auto-continuation 事件接收。
- background turn state 创建。
- background final/progress 投递。
- background turn 完成清理。

必须保持：

- background final 投递到原 route。
- 原 route 普通消息仍按队列处理。
- progress suppress 策略保持渠道一致。

### `delivery.ts`

负责所有出站投递能力：

- `sendText`
- `deliverText`
- progress send 和 suppress cooldown。
- approval 文本重试。
- typing on/off。
- media/file 发送。
- `/sendfile` 最终文件解析和协议行剥离。

必须保持：

- 文件发送每轮最多 3 个。
- 只发送最终回复中显式声明的文件。
- 相对路径按 session cwd 解析。
- 协议行不展示给聊天用户。
- 媒体发送失败聚合提示，不逐个刷屏。

### `status-text.ts`

负责展示文本：

- `/status`
- `/sessions`
- `/whoami`
- `/debug`
- `/help`
- progress mode status line
- run policy status line
- context usage

这类内容拆出后，`Bridge` 不再塞满长文案。

### `formatters.ts`

承载纯格式化函数：

- `truncateForChannel`
- `formatCompactPath`
- `formatRunPolicy`
- `formatGoalStatus`
- `formatGoalTimestamp`
- `formatModelPolicy`
- `formatProgressModeForStatus`
- `formatApprovalKindForUser`
- `formatPercent`
- `formatDuration`
- `formatNumber`
- `formatConversationContext`

纯函数拆分风险最低，应最先进行。

## 分阶段实施计划

### 阶段 0：建立对照备份

操作：

- 新增 `src/bridge/bridge.monolith.snapshot.ts.bak`。
- 保持原 `bridge.ts` 暂不拆或复制后重建。
- 确认 `.bak` 不参与编译。

验证：

```bash
npm run build
npm test
```

### 阶段 1：拆纯函数和类型

操作：

- 新增 `bridge-types.ts`。
- 新增 `formatters.ts`。
- 从 `bridge.ts` 移出无副作用函数。

收益：

- 低风险减少 `bridge.ts` 体积。
- 为后续命令模块复用格式化函数做准备。

验证：

```bash
npm test
```

### 阶段 2：拆展示文本

操作：

- 新增 `status-text.ts`。
- 移出 `/status`、`/sessions`、`/whoami`、`/debug`、`/help` 文本生成。

注意：

- 输出文案必须保持兼容。
- 微信/飞书渠道差异仍通过 `ChannelDeliveryPolicy` 表达。

验证重点：

- `bridge-mock` 状态、帮助、进度、权限相关测试。
- 微信 2.4.4 实验分支 help/status 测试：默认 silent，并覆盖只展示 silent/brief。

### 阶段 3：拆命令模块和 command router

操作：

- 新增 `command-router.ts`。
- 新增 `commands/*`。
- `Bridge.handleMessage()` 只负责识别 command 并交给 router。

注意：

- route busy mutation guard 不能丢。
- refresh command 和平台特殊命令不能丢。
- `/sendfile` 必须继续只对本轮生效。

验证重点：

- `/model`
- `/permission`
- `/goal`
- `/plan` / `/code`
- `/progress`
- `/sendfile`
- `/stop`
- approval commands

### 阶段 4：拆 delivery

操作：

- 新增 `delivery.ts`。
- 移出 sendText、progress、typing、approval retry、sendfile media 发送。

注意：

- delivery 依赖 `ChannelRegistry`、`TranscriptSink`、`Logger`、delivery policy。
- 不应反向依赖 session-flow 或 route-queue。

验证重点：

- 文本发送失败不 crash。
- approval retry。
- progress suppress cooldown。
- 飞书 typing。
- 微信不发送 progress。
- `/sendfile` 文件发送和协议剥离。

### 阶段 5：拆 session-flow

操作：

- 新增 `session-flow.ts`。
- 移出 session 创建、恢复、选择、绑定、pending initial route binding。

注意：

- 这是高风险阶段。
- 必须先保证命令和 delivery 已稳定。
- owner conflict 文案和占用规则必须保持。

验证重点：

- 新 session。
- resume/use。
- session selection mode。
- pending 微信主聊天绑定。
- session owner 冲突。
- 重启恢复绑定。

### 阶段 6：拆 route queue 和 steering

操作：

- 新增 `route-queue.ts`。
- 新增 `route-steering.ts`。
- 将普通队列和执行中 steer 分开。

注意：

- 这是最高风险阶段之一。
- 要避免 route queue 和 steering 互相直接操作内部 map。
- fallback 入队路径要清晰。

验证重点：

- mid-turn steer。
- steer batch。
- steer rejected fallback。
- route busy mutation guard。
- `/stop` 清理当前 route。
- route scoped queue。

### 阶段 7：拆 background-turns

操作：

- 新增 `background-turns.ts`。
- 移出 Goal background event handling。

验证重点：

- Goal background final。
- route queue 与 background turn 并存。
- progress suppress。

### 阶段 8：清理备份文件

条件：

- `bridge.ts` 已降到可维护体积。
- 新模块覆盖全部旧逻辑。
- npm test 全量通过。
- 手工检查旧备份没有未迁移逻辑。

操作：

- 删除或归档 `bridge.monolith.snapshot.ts.bak`。
- 在测试报告里记录清理时间和最终模块边界。

是否删除由当轮维护者决定。如果用户希望保留长期对照，也可以不删除，但必须确认它不进入编译和 npm 包。

## 行为不变清单

拆分过程中必须保持以下能力：

- 文本消息进入当前 route。
- 图片/文件入站 pending media。
- 图文消息结构化投递给 Codex。
- route scoped queue。
- mid-turn steer。
- route busy mutation guard。
- `/new`
- `/resume`
- `/use`
- `/sessions`
- `/sessions all`
- `/status`
- `/whoami`
- `/debug`
- `/help`
- `/stop`
- `/OK`
- `/P`
- `/NO`
- `/permission`
- `/permission approval`
- `/permission full confirm`
- `/plan`
- `/code`
- `/goal`
- `/goal pause`
- `/goal resume`
- `/goal clear`
- `/model`
- `/model <model> [effort]`
- `/model effort <effort>`
- `/model default`
- `/sendfile`
- `/progress`
- 微信 `/fff`
- 微信 2.4.4 默认 silent，并支持 `/progress silent|brief`；`realtime/detailed/tools` 不作为微信普通 `/progress` 公开模式。
- 飞书 progress modes。
- 飞书 typing reaction。
- approval retry。
- sendfile media upload failure aggregation。
- session owner 全局唯一。
- pending 微信主聊天 binding 占用 owner。
- persistent state restore。
- session run policy restore。
- Codex app-server approvals。
- Codex app-server background Goal。

## 测试策略

### 逐模块测试要求

每拆分一个模块，都必须同步完成该模块的功能验证。不能只依赖最后一次全量测试兜底。

每个模块拆分提交必须满足：

- 有该模块对应的定向测试，或在测试报告中明确说明由哪些现有测试覆盖。
- 该模块涉及的核心行为至少被一条测试路径覆盖。
- `npm run build`、相关定向测试、`npm test` 和 `git diff --check` 通过后才能提交。
- 中文测试报告必须写明本次拆了哪个模块、覆盖了哪些行为、运行了哪些命令、结果如何。

模块和测试关注点如下：

| 模块 | 必测功能 |
| --- | --- |
| `bridge-types.ts` | 类型迁移后编译通过；跨模块共享类型没有循环依赖；默认常量与原行为一致。 |
| `formatters.ts` | 路径压缩、权限文案、Goal 时间、model policy、progress mode、审批类型、百分比、耗时、数字和上下文用量格式化。 |
| `status-text.ts` | `/status`、`/sessions`、`/whoami`、`/debug`、`/help` 输出关键文本；微信 2.4.4 默认 silent、只展示 silent/brief，飞书展示 realtime/silent/brief。 |
| `command-router.ts` | slash command 分发、unknown command、route busy mutation guard、refresh command、平台特殊命令、审批命令入口。 |
| `commands/goal-command.ts` | `/goal`、`/goal pause`、`/goal resume`、`/goal clear`、goal 状态时间、错误文案和后台 Goal 状态展示。 |
| `commands/model-command.ts` | `/model` 列表、模型切换、默认模型、reasoning effort 设置和非法参数提示。 |
| `commands/permission-command.ts` | `/permission` 展示、approval/full 模式切换、session 级权限保存和恢复。 |
| `commands/progress-command.ts` | `/progress` 按 `ChannelDeliveryPolicy.allowedProgressModes` 展示和校验；微信只展示 `silent/brief`，飞书展示 `realtime/silent/brief`。 |
| `commands/collaboration-command.ts` | `/plan`、`/code` 进入对应协作模式；inline prompt 继续投递到当前 route。 |
| `commands/sendfile-command.ts` | `/sendfile` 只对本轮生效；协议 instruction 拼接正确；参数错误提示正确。 |
| `session-flow.ts` | 新 session、resume/use、session selection、owner 冲突、pending 微信主聊天绑定、重启恢复绑定、新 session 工作目录取启动 cwd。 |
| `route-queue.ts` | 同 route 串行、不同 route 并发、排队提示、worker 清理、`/stop` 取消当前 turn 并清空队列。 |
| `route-steering.ts` | 执行中 steer、debounce、batch、steer rejected fallback、route scope、busy guard、`/stop` 清理 steer 队列。 |
| `background-turns.ts` | Goal background final、background progress、与普通 route queue 并存、完成后状态清理、progress suppress。 |
| `delivery.ts` | 文本发送失败处理、progress suppress cooldown、approval retry、飞书 typing、微信 2.4.4 结构化工具进度、文件/媒体发送、`BRIDGE_SEND_FILE` 协议行剥离和失败聚合。 |
| `bridge.ts` | 构造依赖、start/stop、handleMessage 一级分流、普通消息/媒体消息/命令消息路由、waitForIdle 和整体集成行为。 |

如果某个模块拆分时发现现有测试无法覆盖迁移风险，必须先补测试，再继续拆分下一模块。

每个阶段至少执行：

```bash
npm run build
npm test
git diff --check
```

涉及特定模块时增加定向测试：

```bash
node --test dist/tests/integration/bridge-mock.test.js
node --test dist/tests/unit/session-bindings.test.js
node --test dist/tests/unit/media-extractor.test.js
node --test dist/tests/unit/approval-manager.test.js
```

拆分命令模块时重点看：

```bash
node --test dist/tests/integration/bridge-mock.test.js --test-name-pattern "model|permission|goal|progress|sendfile|status|sessions"
```

每轮功能性拆分都需要新增或更新中文测试报告，放入：

```text
reports/tests/
```

## Review 要点

每个拆分 PR/提交 review 时检查：

- 是否只是移动代码，还是夹带行为变化。
- 新模块是否只依赖必要接口。
- 是否产生循环依赖。
- `bridge.ts` 是否仍然能一眼看出主流程。
- 旧备份中的逻辑是否已经全部迁移。
- 是否误把 `.bak` 改成 `.ts` 导致被编译。
- 是否误把测试辅助或备份文件发布到 npm 包。

## 风险和应对

### 风险：拆分后隐式状态丢失

Bridge 当前有多个 route scoped map。拆分时如果模块各自维护重复 map，容易产生状态不一致。

应对：

- 初期可以保留 map 的唯一 owner。
- 通过小接口暴露必要操作。
- 不让多个模块同时写同一个状态。

### 风险：命令文案变化导致体验回退

用户已经依赖中文命令输出。

应对：

- 文案移动前先有测试保护。
- 移动后用快照式断言或关键文本断言覆盖。

### 风险：delivery 与 route queue 相互耦合

发送最终回复、发送文件、写 transcript 和 route queue 完成状态容易混在一起。

应对：

- delivery 只负责投递。
- route queue 负责 turn 生命周期。
- sendfile 解析可以在 delivery 中完成，但最终调用点由 route queue 明确触发。

### 风险：备份文件长期滞留

`.bak` 长期保留会造成维护者误读。

应对：

- 在最终阶段明确清理或归档。
- 文档和测试报告记录备份状态。

## 完成标准

拆分完成后应满足：

- `bridge.ts` 主要保留路由和生命周期逻辑，目标 200-400 行。
- 命令、session、queue、steer、delivery、status 文案各有清晰模块。
- `npm test` 全量通过。
- 旧备份文件已删除或明确归档。
- 文档索引更新。
- 新增中文测试报告记录拆分范围和验证结果。
