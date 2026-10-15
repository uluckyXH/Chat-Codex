# Codex Commentary 旁白投递设计

2026-10-15 更新：旁白独立投递已实现；本次进一步修复同一 item 的小 delta 被切成多条日志／消息的问题，改为在 `item/completed` 时发布一次完整正文。详见[修复进度](2026-10-15-codex-commentary-fragmentation-fix.zh-CN.md)、[修复前排查](2026-10-15-codex-commentary-fragmentation-analysis.zh-CN.md)。

## 背景

Issue #4 反馈：部分 skill 在工作时输出了 `commentary`，但微信聊天里没有看到；后续再问 Codex “上一条消息是什么”时，模型能复述出来。

当前代码路径是：

1. Codex app-server 产生 `item.type=agentMessage` 且 `phase=commentary`。
2. `src/codex/app-server/turn-controller.ts` 按 item ID 累积 delta，收到完成事件后发出完整 `assistant.commentary`。
3. Bridge 独立旁白投递器记录完整本地旁白，并按 `/progress`、Plan 模式和渠道策略投递。
4. 微信默认 `/progress silent`，普通模式的旁白仅本地可见；`brief`／Plan 可以低频合并投递，仍受失败冷却和微信侧真实限制约束。没有最终回复时另有完整旁白兜底。

初始问题是“对用户有价值的旁白”被混进普通进度通道；后续碎片化问题则来自错误的消息边界。两者分别由独立事件和完成正文收束处理。

## 目标

- 将 Codex `commentary` 从普通 `assistant.progress` 中拆成独立语义。
- `brief` 默认包含旁白投递。
- `/plan` 默认开启旁白可见性，即使微信渠道默认进度模式是 `silent`，计划模式下也应低频投递用户可见旁白。
- 旁白投递不能和命令进度、reasoning 进度、工具生命周期共用节流和失败冷却状态。
- README 需要说明微信消息投递限制、`/fff` 的作用、不同渠道 `/progress` 的差异。
- 仍保持微信保守投递：不开放 `realtime`，不恢复 `detailed/tools` 作为普通用户入口。

## 非目标

- 不新增 `/commentary` 聊天命令，避免 `/progress` 刚精简后再次增加模式复杂度。
- 不把所有 progress 都恢复投递到微信。
- 不保证微信能稳定接收连续高频消息。真实微信已出现 `sendmessage failed: ret=-2 errcode=0` 和消息堆积现象，设计只能降低触发概率，不能绕过平台限制。
- 不删除现有 `detailed/tools/realtime` 内部代码路径。

## 术语

- 旁白：Codex app-server 的 `agentMessage phase=commentary`。它是 assistant 对用户说的话，可能是计划、说明、过程性结论或 skill 输出。
- 普通进度：reasoning 摘要、命令摘要、搜索、文件变更等 `assistant.progress`。
- 最终回复：`assistant.completed` 或 `assistant.plan` 组成的最终可见内容。

## 初始设计处理的问题

### 旁白和进度混在一起

引入独立旁白事件之前，`commentary` 被映射为：

```ts
{ type: "assistant.progress", kind: "other", text }
```

这曾导致：

- 微信默认 `silent` 下完全不投递。
- `brief` 下虽然允许 `other`，但仍和普通进度共用节流、合并和失败冷却。
- `commentary-only` turn 如果没有 `final_answer`，微信用户可能看不到任何内容。

### `/plan` 的最终计划可见，但旁白不稳定

官方 Plan item 当前会走 `assistant.plan`，最后拼进最终回复投递。这个路径基本可见。

如果 plan 流程或 writing-plan skill 只输出 `commentary`，没有产生 `item.type=plan` 或 `final_answer`，原实现会把它当普通进度处理。当前通过 Plan 旁白投递和 commentary-only 兜底处理。

## 方案概览

独立事件表示一条**已经完成**的旁白，不表示任意传输片段：

```ts
{ type: "assistant.commentary"; sessionId: string; turnId: string; text: string; itemId?: string }
```

Bridge 使用独立旁白投递器，和普通进度投递器并列：

```text
Codex app-server commentary
  -> assistant.commentary
  -> BridgeCommentaryDelivery
  -> channel text message / local transcript
```

普通进度仍走：

```text
reasoning / command / search / file_change
  -> assistant.progress
  -> BridgeProgressDelivery
```

## 投递规则

### 微信

- 默认仍是 `silent`。
- `/progress brief`：投递旁白，且投递普通 brief 进度。
- `/progress silent`：不投递普通进度；非 plan 旁白默认不投递。
- `/plan` 模式：默认开启旁白投递，只投递旁白和最终计划/最终回复，不因此开启命令进度、工具生命周期或 realtime。
- 不开放 `/progress realtime`。

微信旁白沿用 brief 的 3 秒合并间隔，并使用独立状态：

- 单 route 独立 `lastSentAt`。
- 独立 pending commentary。
- 按 session／turn／item 身份去重，正文相同的不同消息保留。
- 独立失败冷却。

首条完整旁白可立即投递，间隔内的后续完整旁白按顺序合并，轮次结束时 flush。pending 不再只保留最后三条，旁白层不再按 1200 字符截断。渠道仍可能拒绝过长正文，通用分段／文件降级是另一个工作项。

### 飞书

- 默认 `brief`：投递旁白和普通 brief 进度。
- `/progress realtime`：每条旁白在 item 完成后及时投递，跟随飞书 realtime 能力；不是每个 delta 各发一条。
- `/progress silent`：非 plan 旁白默认不投递。
- `/plan` 模式：默认开启旁白投递。

### Mock / Terminal

- 默认 `brief`：投递旁白。
- 用于测试覆盖旁白语义，不引入平台特例。

## `/plan` 默认旁白模式

`/plan` 不新增用户命令，也不强行修改 route 的 `/progress` 当前值。

Bridge 在判断 `assistant.commentary` 时额外读取 route 的 collaboration mode：

```text
shouldDeliverCommentary =
  progressMode is brief/detailed/realtime
  OR collaborationMode is plan
```

这样微信仍可显示：

```text
- 进度投递: silent
- 协作模式: Plan mode
```

但 Plan mode 下的旁白会作为计划协作内容低频投递。`/code` 切回默认模式后，如果 route 仍是 `silent`，非 plan 旁白不再投递。

## commentary-only 兜底

如果一轮 turn 结束时：

- 没有 `assistant.completed`
- 没有 `assistant.plan`
- 收到过 `assistant.commentary`

Bridge 应将最后一段完整旁白作为最终回复兜底发送。

这个兜底走普通最终回复投递路径，不走 progress/commentary 节流和失败冷却。原因是这类内容已经是本轮唯一用户可见输出，不能继续被“进度策略”吞掉。

为了避免重复：

- `BridgeCommentaryDelivery.handleCommentary()` 返回该消息的完整正文和可更新的投递回执。
- 前后台 turn state 保存最后一条旁白的回执；定时 flush 成功后也会更新同一份回执，结束时等待在途发送完成。
- 如果这条消息已经成功作为旁白投递过，不重复发送最终回复；不能只凭正文相同或包含关系判定送达。
- 如果旁白投递失败或被策略抑制，则最终兜底必须发送。

## `/fff` 与 README 说明

README 需要补充一段微信投递限制说明：

- 微信渠道不适合持续高频投递 Codex 过程消息。
- `ret=-2 errcode=0` 可能出现在连续投递、会话状态过期或 SDK/客户端侧暂时不可投递时。
- Chat-Codex 因此默认微信 `silent`，只公开 `silent/brief`。
- `brief` 会投递旁白和摘要进度，但仍不保证每一条过程消息都实时出现在微信。

README 需要补充 `/fff` 的作用：

- `/fff` 是微信专用静默刷新命令，不会进入 Codex prompt，也不会产生聊天回复。
- 它的主要作用是让微信侧产生一次新的入站消息，刷新当前 route 的最近消息上下文和 adapter 可用投递上下文。
- 它不是失败消息重发命令，也不能保证修复所有 `ret=-2`。
- 当微信出现消息延迟、堆积或疑似投递上下文过期时，可以发送 `/fff` 后再继续对话。

README 的聊天内命令表也应更新：

- `/progress [silent|brief|realtime]` 保留渠道差异说明。
- `/plan` 增加说明：计划模式会默认低频展示 Codex 旁白。
- `/fff` 增加“微信专用静默刷新，不进入 Codex，不回复”的明确描述。

## 实现边界

### Codex app-server 映射层

修改文件：

- `src/codex/types.ts`
- `src/codex/app-server/types.ts`
- `src/codex/app-server/turn-store.ts`
- `src/codex/app-server/turn-controller.ts`

要求：

- `phase=commentary` 不再发 `assistant.progress kind=other`。
- 新增 `assistant.commentary`。
- commentary delta 只在 `AssistantMessages` 中累积，不进入按标点／换行／400 字符刷新的 progress 草稿。
- item completed 时以权威正文发布一次完整旁白，包含 completion 中的补充或修正。
- 记录当前 turn 最后一个完整 commentary，供 Bridge 兜底。
- 同一 item 重复完成、完成后迟到 delta 不再发布；正文内的重复句子不删除。
- 已知为 commentary 但缺少 completed 的残片不当作完整消息发布。失败／中断使用终止通知，不拿残片做最终回复。

### Bridge 投递层

新增或修改文件：

- `src/bridge/commentary-delivery.ts`
- `src/bridge/route-queue.ts`
- `src/bridge/background-turns.ts`
- `src/bridge/bridge-types.ts`
- `src/bridge/bridge.ts`
- `src/bridge/delivery.ts`

要求：

- 新增 `BridgeCommentaryDelivery`。
- 与 `BridgeProgressDelivery` 独立维护节流、pending、item 去重、失败冷却。
- `route-queue` 和 `background-turns` 都必须处理 `assistant.commentary`。
- finish turn 时执行 commentary-only 兜底。
- `/plan` 下旁白可见，不开启普通 progress realtime。

### Transcript / TUI

修改文件：

- `src/logging/transcript.ts`
- `src/cli/tui/runtime-log.tsx`

要求：

- 增加 `observedCommentary`、`outboundCommentary`、`localCommentary` 或等价命名。
- TUI 日志显示为“旁白”，不要再混进“进度”。
- 微信/飞书聊天正文不强加 `Codex 旁白:` 前缀，避免干扰用户阅读；只在本地日志中标注类型。
- 每个完成 item 追加一条完整本地观察记录；成功发送和失败诊断可各有独立记录。TUI 自动换行不是新消息，不把网络片段另记成多条旁白。

### 文档

修改文件：

- `README.md`
- `docs/README.md`
- `docs/channel-delivery-policy.zh-CN.md`
- `docs/progress-mode-simplification-design.zh-CN.md`
- 必要时同步 `docs/technical-design.zh-CN.md`

README 必须说明微信投递限制、`/fff` 作用、`/plan` 默认旁白投递。

## 测试计划

实现阶段必须遵守 `docs/development-and-test.zh-CN.md`：

- 功能实现后必须自测。
- 必须在 `reports/tests/` 留中文测试报告。

现有回归范围包括（最新结果见[修复进度](2026-10-15-codex-commentary-fragmentation-fix.zh-CN.md)）：

1. app-server 单测：
   - `phase=commentary` 产出 `assistant.commentary`，不再产出 `assistant.progress kind=other`。
   - 相同正文按单块／逐字／标点／换行／400 字符分块，均在 item 完成时产生一条完整旁白。
   - completion 补充／替换／清空、同文不同 item、重复／迟到通知、失败／中断和不完整 item。
   - commentary 后有 `final_answer` 时不产生 commentary-only 兜底。
   - commentary-only 时 Bridge 可以拿到最后完整旁白。

2. Bridge 集成测试：
   - 微信默认 `silent` 下，普通 progress 不投递。
   - 微信 `/progress brief` 下，旁白投递。
   - 微信 `/plan` 默认 `silent` 下，旁白投递，但 command/tool progress 不投递。
   - 微信 commentary-only 且旁白被策略抑制时，最终兜底投递。
   - 飞书 `brief` 下旁白投递。
   - 飞书 `realtime` 下旁白按 realtime 行为投递。

3. Transcript/TUI 单测：
   - outbound commentary 标为“旁白”。
   - local commentary failure/suppression 不混进普通“进度”。

4. 文案测试：
   - `/help` 展示 `/plan` 旁白说明。
   - 微信 `/help` 展示 `/fff` 说明。
   - `/progress` 文案说明 brief 包含旁白。

建议执行命令：

```bash
npm run build
node --test dist/tests/unit/app-server-codex-adapter.test.js dist/tests/unit/transcript.test.js dist/tests/unit/bridge-progress-delivery.test.js dist/tests/integration/bridge-mock.test.js dist/tests/integration/feishu-bridge.test.js dist/tests/integration/weixin-adapter-api.test.js
npm test
git diff --check
```

## 风险与取舍

- 微信真实渠道仍可能因为连续消息失败。旁白独立投递只能避免被普通进度卡掉，不能保证平台永远接收。
- `/plan` 在微信默认 `silent` 下仍展示旁白，和“silent 不投递进度”不冲突，因为旁白已从普通进度中拆出；README 和 `/help` 必须讲清楚。
- commentary-only 依据该条消息的回执避免重复；平台实际接收但回执丢失时，仍无法保证端到端恰好发送一次。
- 完成之前不输出新的旁白日志或 IM 消息，换取稳定的消息边界。无需等整个任务结束；本次不增加 TUI 实时草稿预览。
- 如果 Codex 后续协议新增更明确的用户可见消息类型，应优先映射到更精确事件，而不是继续扩大 commentary 语义。

## 结论

采用“旁白独立事件 + 独立投递器 + brief/plan 默认可见 + commentary-only 最终兜底”的方案。

该方案能解决 Issue #4 的核心问题：有价值的 `commentary` 不再因为被归类为普通进度而在微信侧消失。同时保留微信消息投递保护，不恢复高频 realtime，也不增加新的用户命令复杂度。
