# Codex 旁白碎片化日志与投递排查

日期：2026-10-15。本文保留 `7207cbc` 的修复前源码比对和模拟证据；最初按用户要求只排查。用户随后授权修复，现已完成实现与 721 项全量回归，最新状态见[修复进度](2026-10-15-codex-commentary-fragmentation-fix.zh-CN.md)。下文旧函数和行号均指修复前基线。

## 现场信息与结论边界

用户在另一台电脑观察到：正常旁白有时在日志里被拆成很多小段，也有些旁白正常。目前只确认本机日志现象，尚未确认微信／飞书聊天端是否碎片化。本次没有读取那台电脑的日志、运行配置或凭据。

核查基线：中间件 `7207cbcfa3ed400c4ebb231bbda0b13adc14d52c`；本地 Codex 参考源码 `bb64b894fd67158be0f874872e6d7bfe717e7368`。这是源码对照基线，不表示已核实故障电脑安装的 Codex／中间件版本。

**已确认存在中间件缺陷，能够复现用户描述：同一个 Codex commentary item 被按文本标点、换行和长度提前切成多个内部旁白事件，日志把每个事件独立追加。消息完成时的完整正文又被去重分支跳过，未重新合并。**

同一段 88 字符文本，单个 delta 到达时只有 1 条旁白；按 17 个小 delta 到达时变成 10 条，最短 2 字符。事件数量甚至取决于传输分片边界，而非 Codex 实际生成了几条旁白。这个机制可以解释现场，但尚不能替代另一台电脑的原始事件证据。

渠道也有受影响路径：模拟发送中 `realtime` 逐片发送，`brief` 可能遗漏中间片段；普通 `silent` 通常只在本地碎片化。完整最终回复有独立处理链路；但如果一轮只有旁白，最终兜底可能只剩最后一个片段。以下均区分源码／模拟证据与尚未验证的真实投递。

## Codex 上游的语义

本次直接读取参考仓库源码，未根据终端显示效果猜测协议：

| 上游环节 | 源码依据 | 含义 |
| --- | --- | --- |
| 模型输出增量 | `codex-rs/core/src/session/turn.rs:3120` | `OutputTextDelta` 归属当前 item，经流解析后发送，不代表新的一条消息 |
| app-server 转换 | `codex-rs/app-server-protocol/src/protocol/event_mapping.rs:364` | `AgentMessageContentDelta` 转换为 `item/agentMessage/delta`，保留 thread、turn、item ID 和 delta |
| 完成事件与正文 | 同文件 `:406`；`protocol/v2/item.rs:889` | `item/completed` 携带完成后的 item；agent content 拼成完整 `text`，保留 phase |
| delta 契约 | `protocol/v2/item.rs:1443` | 字段为 `threadId/turnId/itemId/delta`，没有“每个 delta 是完整句子／消息”的保证 |
| 官方 TUI 处理 | `codex-rs/tui/src/chatwidget/streaming.rs:190`、`:415`、`:578` | delta 追加到 stream controller；item 完成时用完整正文收束 |
| 官方 TUI 完成校正 | 同文件 `:86` | 比对流式文本与完成正文，将流式显示单元合并成可重排的完整消息；注释明确以 completion 为准，避免丢失 delta 导致 transcript 截短 |

可核验的固定版本源码：[app-server 事件映射](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/app-server-protocol/src/protocol/event_mapping.rs#L364)、[官方 TUI 收束逻辑](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/tui/src/chatwidget/streaming.rs#L86)。

官方 TUI 可以渐进显示多行；这与把每个片段当独立日志记录、或每个片段发成一条 IM 消息，是不同的展示语义。本项目不应把传输增量的大小当作旁白消息边界。

## 中间件里的实际链路

```text
同一个 agentMessage item（phase=commentary）
  → item/agentMessage/delta
  → appendCommentaryDelta 累积草稿
  → 标点／换行／400 字符触发 flush，删除当前草稿
  → 多个 assistant.commentary（虽然携带同一 itemId）
  → Bridge 只传 text，忽略 itemId
  → 本地逐条追加；发送按 silent／brief／realtime 处理
  → item/completed 的全文因“这个 item 已输出过”而跳过
```

### 1. 旁白沿用普通进度的提前刷新条件

[`notification-mapper.ts`](../src/codex/app-server/notification-mapper.ts) 的 `shouldFlushProgressDraft()`（81–84 行）：

```ts
const normalized = text.trim();
return normalized.length >= 400
  || /[。！？.!?]\s*$/.test(normalized)
  || normalized.includes("\n");
```

[`turn-controller.ts`](../src/codex/app-server/turn-controller.ts) 的 `appendCommentaryDelta()`（455–462 行）直接使用此条件。flush 后删除草稿、分别 trim，并发出新的 `assistant.commentary`（465–475 行）。

这不是严格的句子解析：编号 `1.`、版本号 `0.162.1`、文件名 `index.ts`、域名和 URL 问号，都可能在 delta 恰好停在 `.`／`?` 时被当成句末。每次命中就创建新片段。相反，整段文本一次到达时，只执行一次判断并一次发出，不会对其中的每个句号继续拆分。

### 2. 完成正文没有用来还原消息

`handleItemCompleted()` 先 flush 剩余草稿（309 行）；只要任何片段已经发出，`emittedProgressItemIds` 就包含该 item。后续 commentary 分支在 327 行直接返回，跳过 completion 的完整 `text`。

虽然新的 `AssistantMessages` 会保存完整 item，面向 Bridge 的旁白事件仍然只有片段。模拟中先流出“预告。”，完成正文为“预告。完成时新增的补充正文。”，Bridge 只能收到“预告。”。

另外，`pushCommentaryEvent()`（499–501 行）按 turn 内的纯文本去重。同一正文中合法重复的“确认。”可能消失；这个去重维度也不能代替 item 身份与完成状态。

### 3. 本地日志先于发送合并，且没有按 item 更新

[`commentary-delivery.ts`](../src/bridge/commentary-delivery.ts) 的 `handleCommentary()`：

- silent／渠道 suppress：每个片段直接调用 `localCommentary`（75–81 行）。没有消息级收束。
- realtime：每个片段先记 `observedCommentary` 再发送（84–87 行）。
- brief：在时间合并前先记 `observedCommentary`（90–105 行）。因此“3 秒合并发送”不会减少本地观察日志的条数。

[`runtime-log.tsx`](../src/cli/tui/runtime-log.tsx) 的 `observedCommentary/localCommentary/outboundCommentary` 每次调用都 `store.add` 新记录（98–107 行），没有按 item 修改现有条目的接口。同一片段成功发送后还会有一次出站记录，视觉上更密集。Console 也逐次写一个 block。

TUI 自动换行仅拆一个记录的 body，只有一套时间／来源标题；本次复现则产生多个记录和多套标题。真实现场可用这个差别区分“窗口窄导致换行”和“消息事件碎片化”。

### 4. brief 合并会丢掉正文片段

`BridgeCommentaryDelivery` 默认间隔 3 秒，pending 最多保留 3 个文本（47–49、202–204 行），用空行连接后截到 1200 字符（184–189 行）。这套策略按独立进度摘要设计；用于同一消息的连续正文片段时，会丢掉中间部分、插入不属于原文的空行，破坏 Markdown／路径／URL。

确定性复现：同一个 item 的“第一句。…第六句。”在 3 秒内连续到达，实际发送是“第一句。”和“第四句。\n\n第五句。\n\n第六句。”，第二、三句没有发出。不是网络或渠道拒收造成的。

### 5. commentary-only 最终兜底拿到的是最后片段

前台 [`route-queue.ts`](../src/bridge/route-queue.ts) 在 310 行直接覆盖 `lastCommentaryText=event.text`，424–425 行将它作为无 final 的兜底。后台 [`background-turns.ts`](../src/bridge/background-turns.ts) 的 135、277–278 行使用相同方式。

模拟六句旁白、普通 silent 且没有最终回复时，渠道只收到“第六句。”。前台已经完整复现；后台受相同字段和投递器影响为源码结论，本轮未独立跑后台真实任务。

## 为什么有的正常，有的异常

| 事件形态 | 当前行为 | 验证方式 |
| --- | --- | --- |
| 一条完整正文作为一个 delta | 只刷新一次，日志看起来完整 | 已复现 |
| 细小 delta 恰好停在标点／路径点号／编号处 | 同一 item 反复刷新成独立短片段 | 已复现 |
| 没有提前触发刷新，直到完成 | 完成时草稿一次输出，看起来正常 | 已有用例及模拟 |
| 没有流式 delta，仅收到 completed | completion 全文正常输出 | 已复现 |
| 开始时没有 commentary phase，完成时才得到 phase | 中间没有走旁白切片分支，完成时一次输出全文 | 合成事件已复现；不是对故障电脑事件的断言 |
| 正常 final_answer 的流式 delta | 走独立 final 累积／替换链路，完成后发送完整正文 | 使用相同 17 个 delta 对照通过 |
| partial_answer／async 用户消息 | 按完成后的 `assistant.message` 走另一分支 | 源码确认，不能与旁白混为一类 |

小 delta 的边界和文本内容共同决定触发次数，因此不需要程序随机出错，就能出现同一功能“有的正常、有的很碎”。

## 聊天端是否也会碎

下表基于真实 `AppServerTurnController → Bridge → MockChannelAdapter`、实际 TUI transcript sink 的模拟。mock 按项目的渠道策略复现，不连接飞书／微信服务器，也不等于真实平台回执。

| 模式／情形 | 本地旁白 | 模拟聊天输出 |
| --- | --- | --- |
| 普通 silent，随后有正常 final | 10 条片段记录 | 0 条过程旁白；正常 final 1 条 |
| brief，随后有正常 final | 10 条观察记录，另有 2 条成功发送记录 | 过程旁白 2 条，含碎片且丢中间正文；final 1 条 |
| realtime，随后有正常 final | 10 条观察记录，另有 10 条发送记录 | 过程旁白 10 条碎片；final 1 条 |
| 单 delta 正常对照，brief | 1 条观察＋1 条发送记录 | 完整旁白 1 条；final 1 条 |
| 六句旁白，普通 silent，无 final | 6 条本地记录 | 最终兜底仅“第六句。” |
| 六句旁白，brief 或 Plan 下 silent，无 final | 6 条观察记录＋2 条发送记录 | 首句与最后三句，未恢复完整正文 |
| 相同碎片作为 final_answer | 0 条 commentary | 正常完整正文 1 条 |

飞书默认 brief，可设置 realtime／silent。微信默认 silent，不开放 realtime，但 brief 和 Plan 下的 silent 可以投递旁白。实际条数受时间间隔、是否存在后续 final、失败冷却等影响；表中 2 条是快速到达的复现结果，不是任意任务的固定上限。

两种渠道的 `sendText` 都按 Bridge 给的一份正文组织请求，没有把这些片段重新还原成同一个 Codex item 的信息。仅看“本地旁白”不能判断已发送；成功出站使用 `=>`，并可带发送消息 ID。另一台电脑的真实发送结果仍未核实。

## 历史与测试盲区

- `e029fac`（2026-06-08）已经有旁白提前 flush、按文本去重、pending 只留 3 条的实现。`shouldFlushProgressDraft` 的 400 字符规则在更早的 `c9dc4bf` 中已存在。
- 最近 Codex 协议适配 `2aa8101` 引入 item 状态等处理，但保留上述旁白分片与 completed 跳过逻辑。飞书引用提交 `7207cbc` 没有修改这些核心函数。不能把本次发现直接归因于飞书引用适配；也尚未核实故障电脑的版本跨度。
- 现有“chunked commentary 不重复”用例的第一块只有 **69 字符**，不含换行、不以匹配标点结尾，实际上没有触发提前 flush；第二块到来后才一次输出全文。这条测试没有覆盖真正跨多次 flush 的同一 item。
- Bridge 的多数旁白测试直接输入完整 `assistant.commentary`，没有和 app-server 的小 delta 组合验证。因此已有测试全部通过也不能排除本问题。

本轮构建通过，既有相关测试 **179/179**；另执行 **10 组协议映射探针＋9 组完整 Bridge 探针**，断言确认上述正常与异常行为。探针是在临时目录运行的诊断脚本，没有修改生产实现和既有测试。命令、结果和限制见[排查验证记录](../reports/tests/2026-10-15-codex-commentary-fragmentation-audit.md)。

## 后续修复方向（本轮未实施）

优先按完整 commentary item 对齐：同一 `(sessionId, turnId, itemId)` 持续累积，以 `item/completed.text` 为正文依据，再向 Bridge 输出一次完整旁白。无需等整个 turn 完成；Codex 每次中途说明自己的消息完成时即可显示和按既有策略投递。

如果本地需要更早的流式预览，应将“预览增量／快照”与“已完成旁白”分开；TUI 更新同一个 item 的预览，完成后收束，Console 默认输出完成正文。渠道 realtime 表示每条已完成旁白及时发送，不应等同于每个网络 delta 都发消息。

同时需要处理：

1. 完成全文修正已经接收的增量；不要因为发过一个片段就跳过完成正文。
2. 前台与后台均保留最后一条**完整**旁白，保证 commentary-only 兜底完整。
3. 去重按 item 身份／完成事件处理，保留合法重复句子；跨 item 是否相同不能只靠正文判断。
4. 将发送限频、日志记录与消息完整性分开。明确 brief 下完整旁白的合并／容量策略，避免继续静默丢掉正文；不要单纯扩大 pending 数量掩盖问题。
5. 失败／中断、缺少 completed、迟到或重复通知要定义可见状态，不能把残片当成完整消息成功发送。
6. 日志携带必要的 item／turn 关联信息，区分本地观察、已投递、被抑制／失败；消息级收束优先于全局日志面板改版。

后续验收应包含：相同正文按单块／逐字／标点分块得到相同完成消息；中文标点、列表、版本、路径、URL、代码块和超过 400 字符；重复句子与多个 item；completion 修正；前后台、三种进度模式、Plan 例外、commentary-only；异常结束与已有 partial／async／final 兼容。

这不需要微信新增发送协议，也不能绕过微信限流。长文本分段／转文件仍按原独立设计推进。以上是排查阶段记录；后续实施采用完整 item 完成后发布，当前实现和测试以[修复进度](2026-10-15-codex-commentary-fragmentation-fix.zh-CN.md)为准。
