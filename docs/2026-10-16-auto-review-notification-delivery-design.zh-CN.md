# 自动审批成功提示降噪设计（Issue #7）

日期：2026-10-16。状态：**已随 [GitHub v0.1.7](https://github.com/uluckyXH/Chat-Codex/releases/tag/v0.1.7) 发布，Issue #7 已关闭；95 项定向、742 项全量、9 组独立安装包检查通过。npm 由用户手动发布**。

问题来源：[Issue #7：微信收到过多的 codex 安全提示](https://github.com/uluckyXH/Chat-Codex/issues/7)。先完成排查与设计，随后用户授权修复、关闭关联 Issue 并发布 GitHub 新版本；npm 由用户手动发布。以下保留设计与修复前证据，实施状态以第 7 节和测试报告为准。

核查基线：Chat-Codex `0.1.6`，提交 `20b5c9096ffb98902e595dfe2b411ef400675e56`；本地 Codex 参考源码 `bb64b894fd67158be0f874872e6d7bfe717e7368`。未核实 Issue 作者当时安装的具体版本，也未重新拉取参考仓库。

## 1. 实现行为

**默认将明确的“自动审批已通过”提示只写本机日志，停止逐条推送微信／飞书。需要用户处理的审批、自动审查拒绝／失败／超时和未知安全提示继续按现有通知路径投递。**

用户在聊天里应该看到任务进展、问题和结果，而不必每执行一个工具都收到“这次已自动通过”。这是通知展示策略调整，Codex 的审批判断、执行权限、沙箱和 `/OK`、`/NO` 等交互保持原有语义。

第一阶段直接采用这个默认值，不新增需要用户理解的配置项，也不额外发“已静默 N 条成功提示”的聊天消息。工作进展旁白、推理摘要仍由现有 `/progress` 策略决定，不纳入此次过滤。

预期效果：

```text
修改前的聊天：
  自动审批已通过：读取文件……
  自动审批已通过：修改文件……
  自动审批已通过：运行检查……
  ……
  最终回复

修改后的聊天：
  按现有设置发送工作进展或提问
  必要的审批／异常通知
  最终回复

修改后的本机日志：
  INFO Codex 通知仅本地记录（未投递）；附会话、通知来源和完整审批成功说明
```

该策略在微信私聊、飞书私聊、飞书群聊，以及前台任务、后台续跑中一致生效。群聊的现有 route 归属和审批人权限继续适用。

## 2. 已确认的现象与结论边界

### Issue 提供的证据

- 作者明确回复“是自动审批”。
- 截图中连续出现 `Codex 安全提示`，正文均以 `Automatic approval review approved (` 开头，包含不同的风险、授权等级和理由；可见 `low`，底部还可见 `medium` 风险的成功提示。
- Issue 正文直接描述的是有效信息被大量提示淹没。评论中“微信限流”是当时的推测，未附微信发送接口的失败回执。

因此，可以确认自动审批成功提示刷屏；可以用源码和模拟解释它如何挤占正常消息的投递机会。**不能据此确认现场的最终回复一定因微信限流而丢失，更不能把所有 `prepare failed` 都归因于此。** 长文本、上下文令牌和通用发送失败恢复仍见[既有问题记录](2026-10-15-weixin-prepare-failed-analysis.zh-CN.md)。

### 修复前中间件的链路

```text
Codex guardianWarning(message)
  → app-server adapter 一律映射为 kind=security
  → 添加“Codex 安全提示”前缀
  → codex.notification
  → 前台／后台调用同一个 BridgeNotificationDelivery
  → 按 route + method + session + 完整正文去重
  → await sendText
  → 渠道普通消息发送
```

对应源码：

| 位置 | 修复前行为与影响 |
| --- | --- |
| `src/codex/app-server-codex-adapter.ts` 的 `notificationText`、`notificationDedupeKey` | 所有 `guardianWarning` 都是安全通知；同一会话中理由不同就有不同的去重 key |
| `src/bridge/notification-delivery.ts` 的 `deliver` | 去重后记录最近通知，然后直接发送；没有“仅本地记录”的分类 |
| `src/bridge/route-queue.ts`、`src/bridge/background-turns.ts` | 通知不经过普通进度过滤；微信默认 `silent` 也会发送 |
| `src/channels/weixin/weixin-adapter.ts` 的 `enqueueOutbound` | 这些提示与正文共用串行发送队列；默认发送间隔为 1,200 ms，遇到可重试错误还要等待重试 |
| `src/bridge/delivery.ts` 的 `sendText` | 发送最终失败会记日志并返回；不会把正文自动留存成可再次投递的待办 |
| `src/state/memory-state-store.ts` 的 `recordCodexNotification` | 每个会话仅保留最近 5 条通知，成功提示也可能挤掉更有用的异常；`/status` 默认取最近 2 条 |

这是旧的“所有安全通知完整推送”设计带来的行为；已有测试还明确要求通知绕过进度静默。单纯改 `/progress`、放大发送间隔或延长相同正文的去重窗口，都无法消除不同审批理由产生的刷屏。

本机日志也需要显式补齐：修复前通知成功发送后进入 outbound transcript；`BridgeNotificationDelivery` 自身没有独立的本地通知记录入口。如果只跳过 `sendText`，会同时失去原先通过发送 transcript 展示的正文。此次已增加独立的本地 INFO 日志调用。

## 3. Codex 上游如何处理

### 旧式文本通知仍需兼容

`GuardianWarningNotification` 目前只有 `threadId` 和 `message`，没有结构化的 `status`、`reviewId` 或 `turnId`。不能假设读取 `params.status === "approved"` 就能解决截图里的消息。

上游 reviewer 的 `completion.rs` 构造如下文本：

```text
Automatic approval review approved (risk: ..., authorization: ...): ...
Automatic approval review denied (risk: ..., authorization: ...): ...
Automatic approval review failed: ...
Automatic approval review timed out while evaluating the requested approval.
```

`guardianWarning` 还可能承载拒绝过多导致任务中断的说明，因此不能按整个方法或 `kind=security` 一律静默。

当前参考源码的官方 TUI 已对成功提示做了过滤：收到 `GuardianWarning` 时，若 `message` 以 `Automatic approval review approved (` 开头，就不调用警告展示；其他内容继续展示。我们的成功提示降噪方向与上游一致，额外保留本机日志以便排查。

固定版本依据：[通知字段](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/app-server-protocol/src/protocol/v2/notification.rs#L41)、[reviewer 文本生成](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/ext/guardian-reviewer/src/completion.rs#L159)、[官方 TUI 成功提示过滤](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/tui/src/chatwidget/protocol.rs#L267)。

### 新式结构化审查事件属于后续增强

上游还提供：

- `item/autoApprovalReview/started`
- `item/autoApprovalReview/completed`
- `autoApprovalReview/strictReviewRequired`

前两种携带 `reviewId`、`threadId`、`turnId` 和 `review.status`。状态包括 `inProgress / approved / denied / timedOut / aborted`；review 还能带风险、授权等级和理由。`strictReviewRequired` 表示需要额外自动安全检查，本身不是需要用户点击的人工审批请求。

这些类型在上游标注为不稳定。当前项目在 `protocol-capabilities.ts` 中将上述三种事件列为 `ignored_safe`，尚未映射为 Bridge 通知。第一阶段不需要先实现它们，才能修复已经存在的 `guardianWarning` 刷屏。

后续若补齐结构化审查状态，应优先使用 `review.status`，将开始／成功作为本地状态记录；与旧式警告并存时，避免把同一次拒绝又发送一次。旧式通知没有 `reviewId`，不能只靠到达时间、相同会话或相同理由，推断它属于某个审查并删除另一条异常。该兼容方案和正式通知策略需要独立验收。

字段依据：[review 状态](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L484)、[结构化通知](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1357)。

## 4. 第一阶段的明确规则

| 输入 | 聊天渠道 | 本机与状态 |
| --- | --- | --- |
| 明确的自动审批成功 `guardianWarning` | 不发送，也不进入渠道发送队列 | INFO 记录；不挤占 `/status` 的最近重要通知 |
| 自动审批拒绝／失败／超时／拒绝过多中断 | 保持现有通知投递与去重 | 保留原有原因和最近通知 |
| 无法识别的 `guardianWarning` | 保持现有投递 | 保留正文，供后续按证据分类 |
| `approval.requested` | 继续审批消息或卡片流程 | 继续 pending approval 状态管理 |
| `input.requested`、异步问题 | 继续提问与回答流程 | 继续 pending input 管理 |
| 任务失败／中断、连接告警、会话解绑等 | 保持各自现有策略 | 保持现有状态更新 |
| 工作进展旁白、推理摘要、最终正文 | 保持各自现有策略 | 不进入审批通知分类器 |

“自动审批成功”的识别必须同时满足：

1. 来源方法是 **`guardianWarning`**。
2. 对上游原始 `message` 使用已核实的固定前缀 **`Automatic approval review approved (`**，在添加中文展示前缀之前判断。

这与官方 TUI 使用的成功前缀一致。不能用正文包含 `approved`、包含“安全”、当前权限模式是 `approve-for-me` 等宽泛条件代替。理由内部可能含有相同文字；普通回复也可能引用这段文本，它们都不应受影响。未命中的文案继续投递。

风险等级不是投递开关：截图中 low 和 medium 的已通过提示都应进入本地日志。中间件只展示已经发生的审查结果，不根据风险字符串重新批准、否决或升级权限。

## 5. 实现落点与处理顺序

通知文本映射已收拢到 `src/codex/app-server/notification-mapper.ts` 的纯函数 `notificationText`，分别表达“通知类别”和“展示位置”。渠道 `sendText` 不扫描正文，各渠道共用同一规则。

### Adapter：分类与规范化

- 在 Codex notification mapper 中识别上述成功通知。
- 内部 `CodexNotification` 已增加可选展示属性 `visibility?: "channel" | "local"`；未设置时沿用当前渠道投递，兼容已有事件与测试 fixture。
- 成功提示仍可保留 `kind=security` 表示来源，同时标记 `visibility=local`；正文不丢弃。
- 该展示属性由本地 mapper 生成，不从任意上游参数直接复制。
- 原有审批请求解析、权限策略、reasoning/commentary 处理无需修改。

### Bridge：在网络发送前分流

`BridgeNotificationDelivery` 继续由前台和后台共用。处理顺序：

```text
处理既有生命周期状态
  → 既有 route/session/message 去重
  → 若 visibility=local：记录本地通知，返回
  → 否则：更新最近重要通知，按原有逻辑发送
```

本地分支不调用 `sendText`、不产生“已发送”的 transcript 回执、不触发微信重试，也不等待渠道发送队列。不将本地成功通知加入现有最近重要通知列表，避免 `/status` 被成功提示占满。

`BridgeDelivery.logLocalNotification` 复用已有 Logger，前台、后台默认构造的通知投递器均能使用。日志方法不调用任何渠道 API，也不生成 outbound transcript。无活跃 turn 时，内部合成 ID 使用 `notificationId` 字段展示，避免被误认为真实上游 `turnId`。

### 日志与可观察性

- 成功提示使用 INFO，文案明确标注“Codex 通知仅本地记录（未投递）”，正文保留完整审批成功说明。
- 附上 `method`、`sessionId`、可用的 `turnId`、`routeKey` 和提示正文；不打印整包 RPC 参数、令牌或请求头。
- 去重后每条不同成功提示记录一次。同一提示重放沿用现有时间窗口去重；第一阶段不新增聊天侧汇总提示。
- 确保普通控制台与 TUI 两种 Logger 都能看到这条记录。直接调用现有 Logger 不需要把它伪装成旁白或 outbound transcript。
- 当前 TUI 日志是最多 300 条的内存列表，重启不保留；本方案不把它描述为永久审计存档，也不承诺已有自动落盘功能。

若后续本机也出现明显刷屏，再单独做按 turn 计数／折叠显示，或让用户主动通过 `/status` 查看成功次数。该增强应有独立的有界状态和清理规则，不作为本次修复的前置条件。

## 6. 本次复现与检查结果

完整记录见[排查验证报告](../reports/tests/2026-10-16-issue-7-auto-review-notifications.md)。这些结果证明当前行为，**不是修复后的验收结果**。

| 检查 | 实际结果 |
| --- | --- |
| TypeScript 构建 | 通过 |
| 既有 `bridge-route-queue` 测试 | 18 项通过 |
| 临时诊断探针 | 7 组通过，未连接真实 Codex 模型或微信／飞书 |
| 静默前台：20 条不同成功提示 + 正文 | 发起 21 次发送，正文第 21 条；普通进度未发送 |
| 静默后台：同样输入 | 同样发起 21 次发送，正文第 21 条 |
| 20 条完全相同成功提示 + 正文 | 去重为 1 条提示 + 1 条正文 |
| 拒绝、超时、失败、未知提示 | 四条提示均投递，随后正文 |
| 模拟渠道仅允许前 3 次成功 | 有 20 条提示时正文失败；无提示的对照组正文成功 |
| 三种结构化自动审查通知 | 当前未产生 Bridge 事件，符合现有 `ignored_safe` 分类 |

“前 3 次”只是人为设置的故障注入条件，**不是微信的额度或限流阈值**。它说明当前消息顺序会让无操作价值的通知先消耗可用发送机会；不能替代真实平台验收。

## 7. 实施顺序与验收计划

每一步完成后回写本文进度，并在测试报告中追加实际命令、数量和结果。第一阶段可以单独交付，不等待更大的队列或协议改造。

| 步骤 | 交付与验收 | 进度 |
| --- | --- | --- |
| 0. 排查和设计 | Issue／截图、参考源码、当前代码和本地模拟相互对照 | 已完成 |
| 1. 成功通知分类 | 纯函数识别 method + 固定成功前缀，内部事件携带展示位置；未识别内容保持可见 | 已完成；mapper 与 RPC 测试通过 |
| 2. 本地分流与日志 | 共用通知投递器在发送前返回；控制台／TUI 可见；重要通知列表不被成功提示挤占 | 已完成；12 组渠道／模式／前后台组合通过 |
| 3. 自动化回归 | 增加下表测试，运行相关测试和全量 `npm test`，记录结果 | 95 项定向、742 项全量、9 组独立安装包检查通过；生产依赖审计 0 项漏洞 |
| 4. 真实渠道验收 | 微信私聊、飞书私聊／群聊；检查成功提示、真实问题和最终回复 | 待执行 |
| 5. 发布与 Issue | 推送修复、发布 GitHub、用提交与版本链接关闭 Issue | 已完成；修复 `a86c754`，标签 `v0.1.7`，Issue #7 状态 completed |
| 后续增强 | 结构化审查事件、本地折叠／计数、通用发送优先级及失败恢复，分别设计验收 | 不阻塞第一阶段 |

第一阶段测试矩阵：

| 场景 | 必须断言 |
| --- | --- |
| 20／100 条不同成功提示 | mock 渠道成功提示发送调用数为 0；最终回复恰好 1 次 |
| 完全相同成功提示重放 | 本地去重生效，不增加渠道调用 |
| 成功文案出现在普通回复／别的通知／理由中 | 不误过滤；只匹配指定方法的开头 |
| 新文案、denied、failed、timed out、拒绝过多中断 | 原有通知保留；完整原因不因此次改动被截断 |
| 普通进度 silent／brief | 成功提示均本地记录；旁白与推理摘要继续遵从既有策略 |
| 前台／后台／无当前 turn 的通知 | 共用规则，无遗漏；日志不把合成 turn ID 当成上游真实 ID |
| 人工审批、三题问答与自定义回答 | 等待、回复、解除等待流程保持正常，通知过滤不代替用户决策 |
| 微信私聊、飞书私聊、飞书群聊 | 使用 mock adapter 计数，成功通知没有任何渠道发送；路由隔离不受影响 |
| 拒绝后模型继续处理、任务真正失败 | 分别保留拒绝提示和任务终态；不因成功静默而隐藏异常 |
| 本地日志与 `/status` | 成功提示有 INFO 记录且无虚假发送回执；重要通知仍保留 |
| 有限发送次数故障注入 | 去掉成功提示后正文可用同一发送预算完成；明确模拟与真实平台的差异 |

真实渠道验收使用正常任务中的自动审批机会，不通过故意向微信连续发消息来测限流阈值。记录各类通知数量、实际发送回执和最终回复是否收到；未执行前保持“待验收”。

## 8. 与已有设计的关系

- [通知路由设计](codex-app-server-notification-routing-design.zh-CN.md)已增加自动审批成功提示例外；其余安全通知和会话生命周期处理继续沿用。
- [渠道投递策略](channel-delivery-policy.zh-CN.md)继续负责进度模式；本方案是通知语义分流，不把成功审批塞回普通进度。
- [长文本设计](2026-10-15-channel-long-text-delivery-design.zh-CN.md)与发送失败恢复仍是独立工作。本次减少无用发送，并不保证微信永远不会限流，也不改变平台本身的限制。
- 不引入已经关闭的 PR #10 的 `actions` 模式或 reasoning 内容调整。

最终验收标准：成功审批在本机可查、在聊天中不刷屏；真正需要用户处理的事件和正常回复保持可达；结论由自动化发送计数与真实渠道回执分别支持。

发布结果与 npm 手动发布步骤见[0.1.7 发布报告](../reports/tests/2026-10-16-release-0.1.7.md)；Issue 关联说明见[修复评论](https://github.com/uluckyXH/Chat-Codex/issues/7#issuecomment-6209423744)。真实平台验收状态如上，未以模拟结果替代。
