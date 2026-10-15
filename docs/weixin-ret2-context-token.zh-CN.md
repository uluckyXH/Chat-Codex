# 微信 `sendmessage ret=-2` 与 `context_token` 问题说明

> 2026-10-15 更新：最新源码对照、约 5 分钟任务故障记录和验证见[本轮排查与方案](2026-10-15-weixin-prepare-failed-analysis.zh-CN.md)。此前“去掉 token 即可稳定直投”的推断缺乏依据；当前 `/fff` 也不会自动更新执行中任务的发送 target 或补发失败 final。下文历史现象不代表本次故障已确定根因。

本文档记录真实微信通道里出现的一个高频问题：Codex 长任务期间，微信 `sendmessage` 偶发或连续返回 `ret=-2 errcode=0`；但用户发送 `/help`、`/status` 等短命令时，又能正常收到回复。

结论先说清楚：这通常不是微信登录整体失效，也不是 Codex 本身不工作。更可能是长任务期间复用旧 `context_token`、连续发送进度消息、消息过长或微信侧临时拒收共同导致的发送失败。

## 大白话版本

微信这条链路里有两个容易混淆的 token：

- `bot_token`：账号登录凭证。它像“这台机器人还登录着微信吗”。
- `context_token`：某一条用户消息带来的回复上下文。它像“你这次回复是接着哪条微信消息说的”。

`/help` 能收到回复，说明 `bot_token` 基本没坏，微信账号还在线，最基础的收发通道也通。

真正容易出问题的是长任务：

1. 用户发一条问题。
2. 微信把这条消息和一个 `context_token` 一起给中间件。
3. 中间件把问题交给 Codex。
4. Codex 可能跑很久，期间会产生开始提示、阶段性进度、审批提示、最终回复、媒体消息。
5. 如果这些消息一直复用第一条用户消息带来的 `context_token`，时间久了、消息多了、或者微信后端认为这个上下文不适合继续回复时，`sendmessage` 就可能返回 `ret=-2`。
7. 用户再发 `/help` 时，这是新的微信消息，会带来新的上下文，所以 `/help` 又能正常回。

所以它的体感就是：“刚才 Codex 卡住不回，怎么我发 `/help` 又好了？”
答案是：微信账号没死，旧回复上下文可能不好用了。

## 专业版本

`context_token` 是微信 `getupdates` 对入站消息下发的上下文。官方插件源码要求发送回复时原样带回 `msg.context_token`。它与账号登录用的 `bot_token` 不同，但不能据此推断微信发送不校验它。

OpenClaw 的主动出站入口也会读取已缓存的 context token。“没有新入站”不等于“没有 token”，更不能据此承诺无 token 发送一定可用。上游用户报告中，无 token 发送同样可能得到 `prepare failed`。

当前没有发现可用的主动刷新 `context_token` API。中间件只能在收到新的微信入站消息时拿到新的 `context_token`。

真实现象说明：

- `getupdates` 仍能收到 `/help`，说明长轮询链路未整体断开。
- `/help` 回复可达，说明 `bot_token`、基础 `sendmessage`、目标用户 ID 等核心参数并未整体失效。
- 长任务进度发送出现 `ret=-2`，更像是某次带上下文的出站消息被微信后端临时拒收。

需要谨慎的是，`ret=-2` 不是一个足够明确的错误语义。它不能被简单等同于“context token 已过期”。结合当前现象，更合理的判断是：

- 旧 `context_token` 是高风险因素。
- 高频 progress 是高风险因素。
- 长文本或多段连续出站是高风险因素。
- 微信服务端临时波动或限流也可能参与其中。

应在新入站后及时更新同账号、同会话的上下文，并在真正发送时使用最新已知值；没有新上下文时不能自行续期。配合低噪声、长文本分段、有限重试及失败结果保存，而不是把 token 降级为纯观测字段。

## 当前投递策略

中间件采用直接投递模型。微信仍以低噪声投递为默认；微信 2.4.4 进度实验通过 route 级 `/progress` 模式控制用户可见的普通文本摘要进度。

结构化工具生命周期保留为内部能力：

- 接收微信消息时，仍从原始消息里提取并保留 `context_token`，方便日志观察、调试和后续回退。
- 发送文本消息时，会在 `sendmessage` 请求体里携带当前入站消息的 `context_token`。
- 发送图片和文件媒体时，同样携带当前入站消息的 `context_token`。
- 审批、final reply、错误和用户主动命令回复携带 target 中的上下文；如果带 token 投递持续触发 `ret=-2`，会进入一轮去 token fallback。默认两轮各最多 3 次请求，这一策略的可靠性尚未证实，本轮方案建议调整。
- 微信渠道通过 `ChannelDeliveryPolicy` 声明不投递 task-start，但允许 `/progress silent|brief`；默认 `silent` 不发送普通文本进度和结构化工具生命周期。真实微信连续普通文本进度投递仍可能出现 `ret=-2`，因此不开放 `/progress realtime/detailed/tools`。
- `/fff` 会静默处理，不回复、不入队、不转发给 Codex。
- typing 仍可单独使用 `context_token` 请求 `typing_ticket`；typing 失败只记录告警，不影响 `sendmessage`。

## 现有缓解策略

当前代码已经做了几类防护：

- 微信出站消息串行排队，避免并发打 `sendmessage`。
- 默认发送间隔为 `1200ms`。
- `sendmessage` 有超时和退避重试。
- `ret=-1`、`ret=-2` 被视为可重试临时错误。
- progress 发送失败后，对当前 route 进入短暂冷却，避免持续刷失败请求；当前微信允许 `silent/brief`，默认 `silent`，而非所有模式下一律禁止 progress。
- 兼容逻辑仍保留：带 `context_token` 的发送在正常重试后仍因 `ret=-2` 失败，会进入去 token 的 fallback 重试轮；这不代表 fallback 可绕过服务端校验。
- app-server commentary/progress 分片阈值已提高，但它不是最终文本的长度保护；当前微信最终正文仍未经分段。

这些策略的目标是：不要因为微信某次临时拒收就让整个 Codex turn 崩掉，也不要继续用同一个高风险上下文疯狂重试。Codex 微信桥更重视“稳定投递到用户”，而不是微信 UI 上严格挂靠某条入站消息。

## 当前微信侧规避策略

真实微信长任务如果触发连续出站限制，优先减少出站数量，而不是继续细调延迟：

- 不发送 task-start。
- 不发送 progress。
- 保留 final reply、error、approval、stop、队列提示、媒体发送结果和用户主动命令回复。
- 用户可以发送 `/fff` 产生一次微信入站；该命令不回复、不入队、不转发给 Codex。现状测试表明，它不会自动改变已运行任务持有的旧 token，也不会自动补发先前失败的结果。

## 排查 checklist

看到 `sendmessage failed: ret=-2 errcode=0` 时，先按下面顺序判断：

1. 发送 `/help`。
   如果能回，说明账号登录和基础发送大概率正常。

2. 发送 `/status`。
   查看 Channel 的 `State` 和 `Last error`，确认是否是 `sendmessage ret=-2`，而不是 `session expired`。

3. 确认当前微信 progress 模式：
   ```text
   /status
   ```
   2.4.4 实验分支默认应显示为低噪声的 `/progress silent`；先确认最终回复稳定，再手动切到 `/progress brief` 观察摘要普通文本进度。

4. 测短任务和长任务。
   短任务能回、长任务失败，更支持“旧 context token / 长时间 / 长文本 / 多段发送”方向。

5. 如果 `/help` 也不能回，再考虑 `bot_token` 失效、网络不可用、微信接口异常或账号需要重新登录。

## 不要误判

不要把这个问题直接归因成：

- “Codex 坏了”：Codex 可能已经完成，只是微信出站失败。
- “微信登录一定过期了”：`/help` 能回时，登录态通常还在。
- “重新扫码一定能解决”：重新扫码可能短期缓解，但长任务继续高频复用旧上下文时还可能再出现。
- “只要无限重试就行”：连续重试会放大发送压力，可能让微信侧更容易拒收。

## 关键代码位置

- `src/protocol/channel.ts`
  - `replyTargetFromMessage()` 从入站消息提取 `context_token`。
- `src/channels/weixin/weixin-adapter.ts`
  - 构造 `sendmessage` 请求；文本、图片和文件会携带当前 `context_token`。
  - 处理 `ret=-2` 重试和去 token fallback。
- `src/channels/weixin/weixin-api.ts`
  - `sendmessage` API 调用和错误抛出。
- `src/bridge/bridge.ts`
  - progress、final reply、approval、typing、队列和失败冷却。
- `src/codex/app-server-codex-adapter.ts`
  - app-server commentary/progress 分片和事件映射。

## 维护原则

这类问题本质上是三方系统边界问题：

```text
Codex 长任务输出 -> 中间件投递策略 -> 微信上下文发送限制
```

中间件要做的是把不可控的微信行为变成可控的投递策略：

- 能少发就少发。
- 能合并就合并。
- 发送时使用最新的同账号、同会话上下文；上下文不可用时保留结果并等待恢复。
- 关键消息优先送达。
- 失败要可观测，但不要让整个任务崩溃。
