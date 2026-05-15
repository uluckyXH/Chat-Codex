# 微信 `sendmessage ret=-2` 与 `context_token` 问题说明

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

`context_token` 是微信 `getupdates` 对单条入站消息下发的上下文引用。发送回复时，客户端可以把它放入 `sendmessage` 请求体的 `msg.context_token` 字段，以便微信侧把机器人回复关联到对应会话上下文。

但它不是微信消息发送的授权凭证。真实发送更核心的条件是：

```text
bot_token + to_user_id + sendmessage
```

OpenClaw 的 cron 主动投递也支持在没有新入站消息的情况下向微信用户发消息，这说明 `context_token` 更像“回复上下文锚点”，不是“能不能发消息”的硬门槛。

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

因此正确策略不是“刷新 context token”，因为目前没有刷新接口；正确策略是把 `context_token` 从发送依赖降级为观测和兼容字段，并降低出站消息压力。

## 当前投递策略

中间件采用直接投递模型：

- 接收微信消息时，仍从原始消息里提取并保留 `context_token`，方便日志观察、调试和后续回退。
- 发送文本消息时，默认不在 `sendmessage` 请求体里携带 `context_token`。
- 发送图片和文件媒体时，同样默认不携带 `context_token`。
- 审批、final reply、错误和用户主动命令回复都按普通微信投递处理，不把旧 `context_token` 作为送达前提。
- 微信渠道通过 `ChannelDeliveryPolicy` 声明不投递 task-start 和 progress；`/progress` 会被拒绝，`/fff` 会静默处理。
- typing 仍可单独使用 `context_token` 请求 `typing_ticket`；typing 失败只记录告警，不影响 `sendmessage`。

## 现有缓解策略

当前代码已经做了几类防护：

- 微信出站消息串行排队，避免并发打 `sendmessage`。
- 默认发送间隔为 `1200ms`。
- `sendmessage` 有超时和退避重试。
- `ret=-1`、`ret=-2` 被视为可重试临时错误。
- 非微信渠道的 progress 发送失败后，会对当前 route 进入短暂冷却，避免持续刷失败请求；微信渠道不发送 progress。
- 兼容逻辑仍保留：如果未来某条带 `context_token` 的 `sendmessage` 在正常重试后仍因 `ret=-2` 失败，会再尝试一次不带 `context_token` 的发送。
- app-server commentary/progress 分片阈值已提高，非微信渠道可减少一句话被拆成多条进度消息；微信渠道当前通过 delivery policy 禁用 progress 投递。

这些策略的目标是：不要因为微信某次临时拒收就让整个 Codex turn 崩掉，也不要继续用同一个高风险上下文疯狂重试。Codex 微信桥更重视“稳定投递到用户”，而不是微信 UI 上严格挂靠某条入站消息。

## 当前微信侧规避策略

真实微信长任务如果触发连续出站限制，优先减少出站数量，而不是继续细调延迟：

- 不发送 task-start。
- 不发送 progress。
- 保留 final reply、error、approval、stop、队列提示、媒体发送结果和用户主动命令回复。
- 用户可以发送 `/fff` 主动制造一次微信入站刷新；该命令不回复、不入队、不转发给 Codex。

## 排查 checklist

看到 `sendmessage failed: ret=-2 errcode=0` 时，先按下面顺序判断：

1. 发送 `/help`。
   如果能回，说明账号登录和基础发送大概率正常。

2. 发送 `/status`。
   查看 Channel 的 `State` 和 `Last error`，确认是否是 `sendmessage ret=-2`，而不是 `session expired`。

3. 确认微信 progress 已禁用：
   ```text
   /status
   ```
   `Progress` 应显示为 `disabled`。如果发送 `/progress`，Bridge 应返回微信渠道禁用进度投递的拒绝说明。

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
  - 构造 `sendmessage` 请求；文本、图片和文件默认不携带 `context_token`。
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
- 旧上下文不可靠时就不要强依赖。
- 关键消息优先送达。
- 失败要可观测，但不要让整个任务崩溃。
