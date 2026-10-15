# 2026-10-15 微信 `sendmessage prepare failed` 排查与解决方案

> 后续进度：Codex CLI 协议批次已完成，微信 2.4.10 的 ID／引用／收发协议兼容亦已实施，见[微信实施文档](2026-10-15-weixin-2.4.10-protocol-implementation.zh-CN.md)。下文保留故障分析时的 2.4.6 基线；长文本、最新上下文和通用发送恢复仍待实施，尚未确认真实 `prepare failed` 已修复。

## 问题记录

- 发生时间：2026-10-15 12:01:50（用户提供的日志时间，按本次会话的 Asia/Shanghai 时区记录）。
- 场景：项目运行期间，微信私聊文本发送失败。
- 日志（账号和会话标识已脱敏）：

```text
WARN channel text send failed
channel=weixin-<account> routeKey=weixin-<account>:<account>:direct:<user>@im.wechat
conversationKind=direct
error="sendmessage failed: ret=-2 errcode=0 prepare failed"
```

这条日志表明微信 `sendmessage` 返回了业务失败；`errcode=0` 不会覆盖非零 `ret`。仅凭这一条日志，尚不能断定是上下文失效、长消息限制、账号状态或微信后端临时拒收。

用户补充：**任务运行了大约 5 分钟后出现该错误**。目前尚缺失败正文长度、最后一条入站消息时间、失败时使用的上下文及出错后 `/help` 是否可达的信息；也不能仅凭这条通用文本失败日志确定它就是最终回复。

后续用户补充怀疑正文过长，要求先设计微信／飞书的新版适配与长文本提醒。最新交互、分段预算和实施范围见[长文本投递设计](2026-10-15-channel-long-text-delivery-design.zh-CN.md)；本文保留完整故障证据与恢复路线。

## 结论与证据等级

本轮已完成参考源码更新、最新插件源码对照和离线验证。结合用户补充，**优先修复长正文未分段的问题，同时保留长任务旧上下文这一独立候选。** 处理优先级不等于已证明服务端根因，不能把 `ret=-2` 一律翻译为“正文超长”或“token 过期”。

已确认的本项目缺口：

1. 长任务保留开始时的 `ChannelTarget`。后续 `/fff` 虽更新 Bridge 的 route target，最终发送仍使用原对象里的 `contextToken`。
2. `WeixinAdapter.sendText()` 把完整正文放进单个请求，没有按长度分段。
3. 连续 `ret=-2` 时，默认先带原 token 发送 3 次，再去掉 token 发送 3 次；去 token 并不是已验证的恢复方案。
4. 普通文本投递失败被降为 warning，保护进程继续运行，但没有持久化待补发结果；失败后收到 `/fff` 不会补发。

这四点都由本地模拟确认，见[验证报告](../reports/tests/2026-10-15-weixin-prepare-failed-analysis.md)。模拟验证的是客户端行为，没有模拟证明微信的 token 有效期或长度硬上限。

本轮交付为分析和方案。运行时代码、依赖锁文件、微信登录态及渠道绑定未修改；下文修复项均为待实施。

## 已更新和核实的参考基线

查询日期：2026-10-15。版本以官方 npm Registry 的 `dist-tags` 为准；Git main、npm latest 和本项目实际采用的协议版本分别记录。

| 对象 | 原本地基线 | 本次核实／获取结果 | 本项目运行时影响 |
| --- | --- | --- | --- |
| OpenAI Codex 参考仓库 | `92bc601ad60542c92bf0bb1e7a2eb70b84ac49d2` | 已 fast-forward 到 `bb64b894fd67158be0f874872e6d7bfe717e7368`；本次 fetch 后与 `origin/main` 一致，工作区干净 | 只更新参考源码，没有升级运行中的 Codex CLI |
| 微信 npm 插件 | `2.4.6` | latest 为 `2.4.10`，已下载、解包并校验完整性；beta tag 为 `2.4.9-beta.0` | 本项目不加载 OpenClaw 插件；当前 `sourceVersion/channel_version` 仍为 `2.4.6` |
| 飞书 npm 插件 | `2026.7.9` | latest 为 `2026.7.16`，已下载、解包并校验完整性；beta 为 `2026.8.5-beta.0`，仅记录、不作为稳定版基线 | 本项目不加载 OpenClaw 飞书插件 |
| 飞书 Git 参考仓库 | `6d95621526c37fb8952953bfb9264ac185cedcdb` | 已 fast-forward 到 `dde0be3680d6fd5443cab426c8f4b3216266346a`；与本次 fetch 的 `origin/main` 一致 | 该 Git HEAD 的 `package.json` 仍写 `2026.7.9`，发布包对照采用 npm `2026.7.16` |
| 飞书运行时 SDK | `@larksuiteoapi/node-sdk@1.71.1` | 本地安装仍为 `1.71.1`；后续设计查询 npm latest 为 `1.75.0`；两个飞书插件版本均声明 SDK `^1.64.0` | 尚未升级，`1.75.0` 实现差异与打包兼容性待独立验证 |

发布时间按 npm `time` 字段换算为北京时间：微信 `2.4.10` 为 **2026-10-11 09:02:07**，飞书 `2026.7.16` 为 **2026-07-22 11:19:43**。微信 changelog 标注的版本日期是 10 月 10 日，不能与 npm 实际发布时间混用。

下载目录及 SHA-256：

```text
openclaw-weixin-npm/tencent-weixin-openclaw-weixin-2.4.10.tgz
69dd18af16a992edbe3700d244f9591ab52f5f58abfe976a9f1250bd8eacdbbb
openclaw-weixin-npm/extracted/openclaw-weixin-2.4.10/

openclaw-lark-npm/larksuite-openclaw-lark-2026.7.16.tgz
1d69f11ede0af19cef48e1f80abb98e35b7f34e8f9df7942527551c8824a61fa
openclaw-lark-npm/extracted/openclaw-lark-2026.7.16/
```

两份 tarball 的 SHA-512 与 Registry `dist.integrity` 一致。下载使用 `npm pack --ignore-scripts`，没有安装或执行上游插件。第三方文件继续被 Git 忽略，旧版本保留供对照。

## 最新上游源码说明了什么

### 微信：升级到 2.4.10 不能代替本项目的可靠性修复

对照 `2.4.6 → 2.4.10`：

- `2.4.10` changelog 的主要修复是 OpenClaw 2026.10 Plugin SDK 的入口授权、typing 回调等兼容，以及配对文件读取清理。
- `2.4.9` 修复 OpenClaw 模型运行时绑定；较新的引用消息功能增加无损消息 ID 解析、引用缓存、局部引用和媒体还原。这些需要单独评估，不是本次发送失败的直接修复。
- `src/messaging/inbound.ts` 按 `accountId + userId` 保存 context token，并持久化到账号文件。**这套缓存在本地 2.4.6 参考包里已经存在**，不是本次升级新增的续期能力。
- `src/channel.ts` 的通用出站入口读取缓存 token，并声明 `textChunkLimit: 4000`；`src/messaging/process-message.ts` 的回复闭包仍持有本轮 token，文本路径仍整段调用 `sendMessageWeixin()`。不能把通用入口的声明误认为所有回复路径都有分段保护。
- `src/api/api.ts::sendMessage()` 仍在非零 `ret` 时抛错；没有看到专门解决 `prepare failed` 的 token 刷新接口或恢复流程。
- `GetConfigResp` 只有返回码、错误文本和 `typing_ticket`，没有新的 `context_token`。取得 typing ticket、显示“正在输入”和持久化旧 token，都不能被视为续期证据。

因此，应选择性参考上游的账号隔离、token 缓存、长度控制及错误信息，保持 Chat-Codex 独立 adapter 架构。只把 `channel_version` 改成 `2.4.10` 不会自动获得这些能力，也没有证据表明改版本号即可解决故障。

### 飞书：本轮差异主要在卡片交互

对照稳定 npm 包 `2026.7.9 → 2026.7.16`：

- `src/messaging/outbound/send.js`、`src/channel/monitor.js`、`src/core/card-action-operator.js` 无变化。
- 新增卡片按钮 `inject_prompt`，把点击转换为合成入站消息；解析真实聊天类型、thread 和 `operator.open_id`，沿用访问控制。
- 卡片表单支持 `form_submit` 的 `form_name` 分发，相关问答工具和入站 gate 有配套调整。

Chat-Codex 的飞书实现直接使用 Node SDK，以 `post + md` 发送文本，先 reply 原消息，失败再按 `chat_id` create。该链路不使用微信 `context_token`，这条微信日志没有提供飞书故障证据。本轮不需要为解决微信问题照搬卡片 `inject_prompt`，也不应通过替换成整个上游插件绕过本项目的审批和路由。

### Codex：核对发送链路边界，不宣称完成全面兼容审计

更新后的官方 schema 仍包含 `item/agentMessage/delta`、`item/completed` 和 `turn/completed`，`agentMessage` 仍带 `text` 与 `phase`。本项目 `src/codex/app-server/turn-controller.ts` 将其转换为内部 assistant 事件，由 `route-queue.ts` 汇总正文后交给渠道发送。

```text
Codex app-server 通知
  → 内部 assistant / turn 事件
  → BridgeDelivery.sendText
  → WeixinAdapter.sendText / sendMessageWithRetry
  → POST ilink/bot/sendmessage
  → 非零 ret 抛错
  → Bridge 记录 channel text send failed
```

所报错文本由 `src/channels/weixin/weixin-api.ts::assertWeixinApiSuccess()` 生成，属于渠道业务响应错误，不是 JSON-RPC 解析错误。Codex 可以已经完成任务而微信未送达；本次日志本身不能证明 Codex 当时成功或失败。此次仅核对相关链路，完整新版协议兼容性另按既有审计文档推进。

## 根因候选与本地证据

### 1. 旧上下文：独立候选，客户端缺口已确认

`replyTargetFromMessage()` 把原始 `context_token` 复制到 `ChannelTarget.context.contextToken`。`Bridge.handleMessage()` 收到新消息时替换 `routeTargets` 的条目；前台任务的 `forwardPrompt()` 继续持有排队时的 target，后台任务也在建立 state 时保存 target。微信 adapter 在构造发送体时只读该 target，没有独立的最新 token 查询。

本地模拟顺序：启动任务，注入 `/fff` 和一个新 token，再结束任务。结果：`/fff` 无回包，最终文本仍携带原 token。即使用户主动产生了新上下文，当前任务也无法自动使用它。

上游 [#286](https://github.com/Tencent/openclaw-weixin/issues/286) 的报告者观察到长回合、新旧 token 与 `prepare failed` 相关；[#309](https://github.com/Tencent/openclaw-weixin/issues/309) 则报告较长闲置后失败、新入站后恢复。这些是用户复现报告，不是微信服务端协议承诺，且观察窗口差异很大。**不能把 2 分钟、5 分钟或 15 小时写死为 token TTL。** 用户本次约 5 分钟后报错与该方向相符，但还需要本次上下文年龄和新入站后的发送结果来验证。

### 2. 长正文：优先处理场景，缺少分段已确认

当前 adapter、ChannelRegistry 和 final delivery 路径没有文本分段保护。本地用 7,337 个汉字调用 `sendText()`，观察到 **1 次请求、7,337 个 UTF-16 code units、22,011 个 UTF-8 字节**。

上游 [#284](https://github.com/Tencent/openclaw-weixin/issues/284) 报告相同上下文下短文本成功、长文本出现同类错误。该报告的长度仅为样本，不是官方硬上限。本项目采用保守分段能处理已知缺口，但不能证明本次一定因长度失败；用户尚未提供这次正文长度。

### 3. 重试放大与结果丢失：已确认的恢复问题

默认 `outboundMaxRetries=2`，当前循环的实际行为：

```text
旧 token：首次 + 重试 2 次
去 token：首次 + 重试 2 次
最终失败 → warning → 当前文本发送结束
```

本地始终返回 `{ret:-2, errcode:0, errmsg:"prepare failed"}`，确实捕获到 6 次请求。单纯退避的等待时间合计 9 秒，另加网络耗时；fallback 切换时没有等待新的入站上下文。

`BridgeDelivery.sendText()` 返回 `Promise<void>`，捕获异常后仅记日志；成功时才记录 outbound transcript。前台最终正文只是本轮局部变量，后台 turn state 也不是持久化投递箱。模拟最终回复失败后再发 `/fff`，新增发送为 0。保护进程继续运行是合理的，但目前“任务已结束”和“结果已送达”没有清楚分开。

审批另有 `sendApprovalUntilDelivered()` 循环，不能把普通 final 的结论直接套为审批行为。修复重试时需同时防止审批循环反复用失效上下文发送，审批请求本身仍应保持待处理，不能因发送失败自动批准、拒绝或过期。

### 4. 还不能排除的情况

微信后端临时拒收、发送频率、账号状态和请求内容约束仍可能导致同类错误。`ret=-2` 不同于明确的登录态失效码 `-14`，不能直接要求重新扫码。若新入站后的短 `/help` 也持续失败，需要检查业务错误、HTTP 状态和轮询状态，再定位账号或服务端问题。

## 现在可以采用的处理办法

1. **先查看本机对应 Codex 会话的结果**，确认任务是否已执行完成，避免因为微信没有回包就重复执行有副作用的任务。
2. 用户可在原微信聊天发送 `/help` 检查短回复是否恢复。它带来新的入站上下文，但不保证会补发旧结果。
3. 保持 `/progress silent`，减少额外出站压力；这只降低频率风险，不会延长 token 有效期。
4. 需要在微信取回结果时，可以明确要求“只把刚才已经完成的结果简短重述，不重新执行任务”。这是一次新消息／新上下文的临时取回方式，不等同于可靠补发。
5. 长任务也可以从已有飞书入口发起；微信任务的现有结果优先从本机会话取回。不要自动把微信内容投到其他 route，也不要为排错自动迁移 session 绑定。

`/fff` 当前只提供静默入站，**不能作为旧任务已换 token、已续期或已补发的保证**。本轮没有向真实微信或飞书账号发送测试消息。

## 建议实施方案

以下为完整可靠性路线。后续[长文本投递设计](2026-10-15-channel-long-text-delivery-design.zh-CN.md)细化两端分段、一次提示与文件模式；首期保留原文和发送状态，完整 `/retry`／重启续发分阶段推进，不把本文所有 P0 项等同于一次实现承诺。

### P0-A：结构化错误与脱敏诊断

在微信 API 边界引入保留 `ret / errcode / errmsg / endpoint / httpStatus` 的错误类型，替换对字符串的宽泛正则判断。`ret=-2 + prepare failed` 分类为“发送准备被拒，原因未确定”，不要直接标成 token 过期。

每次关键消息投递记录：消息用途（final／command／approval／error）、session/turn、稳定 deliveryId、字符数、UTF-8 字节数、分段序号、队列等待时长、实际尝试次数、token 是否存在、token 来源及捕获年龄、是否出现更新 token、fallback 类型。token 来源时间未知时写 unknown，不伪造年龄。

不记录原始 `bot_token/context_token`、Authorization、消息正文或完整请求体；路由／用户标识在诊断导出时脱敏。错误响应也需要限长和脱敏。TUI 单独显示“任务完成，回复投递失败／待重试”，保留原始业务码。

### P0-B：由微信 adapter 管理最新上下文

建议新增 `src/channels/weixin/weixin-context-store.ts`，按 **渠道实例、实际账号、会话、收件人** 隔离缓存，记录 token、来源消息 ID、接收时间和版本。入站处理在调用 Bridge handler 前更新缓存，使 `/fff`、命令、图片消息都能刷新；重复／乱序入站不能把已知较新的上下文覆盖为旧值。

文本、媒体 caption、媒体本体及审批的底层发送在 **出站队列实际执行时** 解析上下文；每次重试前重新检查同一作用域的版本，不在 `sendText()` 入队之前永久固定请求体。缓存优先，合法原 target token 可作为无缓存时的兼容来源；没有可用上下文时保留结果并明确等待新入站。

只替换微信发送上下文，保留原 route、session、收件人和本轮 `run_id`，不能用另一个账号或聊天的 token。P0 可先做内存缓存；后续如需跨重启保存，使用 adapter-owned 文件、原子写入与 `0600` 权限，退出账号／换登录凭证时清理。保存到磁盘不会延长 token 寿命。

### P0-C：保守分段及部分发送进度

后续设计将纯分段工具收敛为两端共用的 `src/channels/text-delivery-plan.ts`，具体成本由 adapter 提供。微信初始采用每段最多 **4,000 UTF-16 code units 且不超过 4,000 UTF-8 字节** 的保守本地策略；首版不增加聊天配置入口。4,000 字符参考上游的 chunk 声明；字节限制是本项目提议的额外保护，**不是微信官方上限**。提示、段号和最终文件模式按[长文本投递设计](2026-10-15-channel-long-text-delivery-design.zh-CN.md)实施。

按 Unicode code point 安全切分，优先段落／换行边界，必要时处理超长单段；禁止拆坏 surrogate pair、静默截断正文。若增加段号，长度预算应包含段号。微信内顺序发送并保持现有节流，媒体 caption 同样走分段策略。

为每个分段保留稳定 client ID 和已确认位置。中途失败时停止后续段，记录已完成段；补发只处理未完成部分。不能让长文本重试反复重发已经成功的段，也不能因增加分段放开高频 progress。

### P0-D：有界恢复，默认取消去 token 重试

建议策略：

| 错误情形 | 处理 |
| --- | --- |
| `prepare failed` 且同一作用域出现了更新 token | 更新上下文后，最多进行一次针对新版本的恢复尝试；保持 delivery/chunk 标识 |
| `prepare failed` 且没有新 token | 最多一次短退避尝试；仍失败则进入待新入站状态，停止该消息的密集重试 |
| 明确 429／限流或可重试 5xx | 使用有上限的退避，尊重明确的服务端等待建议 |
| 请求超时／连接中断，服务端是否接收未知 | 标为结果不确定；保留 client ID 和诊断，不承诺“恰好一次”，不盲目换 ID 连续重发 |
| 明确凭证失效 `-14` | 显示登录需要恢复；不把 `-2` 混入此类 |

为整个逻辑投递设置统一尝试预算，切换 token 不重置为另一轮无限预算；每次发送都经过节流。默认去掉“删除 context_token 再完整重试一轮”，如需实验应单独配置并收集证据。

typing 仍只负责输入状态，不将定时 `getConfig`、typing 心跳、更多进度消息当成续期方案。

### P0-E：保存关键结果，支持精确补发

在通用 delivery 层补充明确的结果状态，例如 `sent / waiting_for_context / failed / unknown`；新增关键结果投递路径，避免所有 `sendText()` 调用一律抛错影响任务执行。

final 在首次发送前写入本地待投递记录，至少包含 route、channel/account、sessionId、turnId、deliveryId、完整正文或受控本地文件引用、分段完成位置、状态和时间；不把微信 token 存进通用 outbox。状态写入使用原子替换。记录不能在失败时仅因 turn 结束而删除。

首版建议保留待投递结果 7 天、每 route 最多 20 条，总量上限 50 MiB；到期或容量不足必须在 TUI 明确提示，不能静默覆盖。正文超大时保存受控本地文件引用。上述是待实现的默认产品策略，审批的生命周期不使用该 final TTL。

新增通用 `/retry`（**当前未实现**）：只补发当前已信任 route 中明确选定的失败结果，重新获取该 route 的微信上下文，绝不重新运行 Codex。多条候选按编号选择；session 已切换／解绑时暂停自动补发，要求明确选择原结果，不能转投新会话。超时导致的 unknown 项需要提示可能已送达，交由用户决定是否再次发送。

恢复首版以明确的 `/retry` 为主；`/fff` 保持静默，仅更新上下文、唤醒发送资格检查。后续如增加新入站后自动补发，应按 route 串行，检查绑定和信任状态，避免命令回复与旧 final 无序交错。

### P1：其他上游差异独立推进

微信无损消息 ID、引用还原、网络错误分类、token 持久化，以及飞书表单和卡片交互应单列兼容项。无需为了修复此次报错安装 OpenClaw runtime、改变飞书审批模型或整体升级 Codex 协议。参考版本更新与实际 wire metadata 更新分别验收。

## 实施与验收顺序

1. 先做 P0-A，并保留本次现状复现作为回归依据。
2. 做 P0-B／C／D，覆盖新上下文选择、短文本拒收及长正文拆分。
3. 做 P0-E，确保失败结果可见、可恢复，且不会重新执行原任务。
4. 再由用户协助进行真实微信长任务验收：约 5 分钟任务，无新入站和中途 `/fff` 两种情况，分别记录 API 接受和客户端实际可见结果。

实现时至少覆盖：

- 旧 target 遇到新 `/fff`／`/help` 后，在实际发送及重试时使用本账号、本收件人的更新上下文；未改变原 run ID。
- 跨账号、跨聊天不串 token；缺 token、重复／乱序消息、账号退出均有明确行为。
- 7,337 汉字、emoji、长代码块、超长单行拆分后完整且逐段满足字符／字节预算。
- 连续 `prepare failed` 不再产生两轮无意义重试；无新 token 时等待，不伪造续期。
- 第 N 段失败，重启／补发后只续发未完成段；unknown 不当作明确失败重复发送。
- final 发送失败时 Codex 状态仍正确，TUI 显示投递状态；`/retry` 不调用 Codex run。
- 普通／后台 final、审批等待、媒体 caption 和 `/fff` 静默语义均回归；飞书原有行为保持通过。

实现后执行 `npm run build`、`npm test`、`git diff --check` 并记录中文报告。本轮只运行既有渠道定向测试和现状诊断；**76 项定向测试通过，4 项模拟探针符合现状判断，真实服务端原因尚未实测确认**。

## 参考资料

- [本地参考源码索引](../references/README.md)：下载位置、当前实现基线与本次审阅版本。
- [微信 npm 元数据](https://registry.npmjs.org/@tencent-weixin/openclaw-weixin) 与 [2.4.10 源码包](https://registry.npmjs.org/@tencent-weixin/openclaw-weixin/-/openclaw-weixin-2.4.10.tgz)。
- [飞书 npm 元数据](https://registry.npmjs.org/@larksuite/openclaw-lark) 与 [2026.7.16 源码包](https://registry.npmjs.org/@larksuite/openclaw-lark/-/openclaw-lark-2026.7.16.tgz)。
- [Codex 参考提交](https://github.com/openai/codex/commit/bb64b894fd67158be0f874872e6d7bfe717e7368) 与 [App Server 官方说明](https://developers.openai.com/codex/app-server/)。
- [飞书参考提交](https://github.com/larksuite/openclaw-lark/commit/dde0be3680d6fd5443cab426c8f4b3216266346a)。
- [历史 ret=-2 文档](weixin-ret2-context-token.zh-CN.md)、[context_token 实验设计](weixin-context-token-adaptation-design.zh-CN.md)：历史结论须结合本文更新阅读，特别是“去 token 可直接投递”与 `/fff` 的恢复边界。
