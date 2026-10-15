# OpenClaw 如何把中途摘要发到微信

日期：2026-10-15。状态：**源码分析保留；用户已取消微信摘要专项适配，仅记录文档**。

后续独立微信协议批次已对齐 2.4.10 的 ID／引用／收发兼容，见[实施进度](2026-10-15-weixin-2.4.10-protocol-implementation.zh-CN.md)。本文的版本表与“只改文档”描述记录分析阶段；摘要专项取消的决定继续有效。

**最新范围决定：微信针对新版协议做必要适配，不再为中途摘要或突破连续发送限制新增专项机制。** 以下源码事实作为参考保留，原摘要专项建议不再作为实施要求；现有摘要行为保留，具体范围见第 5 节。

这里的摘要指助手工作时说的“已检查配置，接下来验证发送逻辑”。它是面向用户的中途说明，不是工具调用日志，也不是最终答案。

## 1. 结论

OpenClaw 先识别中途说明、保留消息身份和完成边界，再根据渠道选择展示方式。有些渠道更新同一条进度草稿；腾讯微信插件 `2.4.10` 没有接入这条可编辑草稿路径。宿主允许独立摘要时，微信仍把它作为普通文本，通过 `sendmessage` 发送。

因此，值得移植的是**正确分类、合并同一条摘要的更新、避免重复、保证最终回复顺序**。没有源码证据表明这种摘要在微信享有独立额度，或能让 Agent 无限连续发送。减少重复请求可能改善表现，是否避免本次拒收仍需实测。

## 2. 核查对象与边界

| 对象 | 本次依据 | 边界 |
| --- | --- | --- |
| OpenClaw 宿主及其 Codex 扩展 | 查询时 main：`72cc53bfce336777f23fbe941af10ad9abe4d8ae`，提交时间 2026-10-15 06:16:24 UTC | 固定源码快照，不代表已安装或验证该宿主发布版 |
| 腾讯微信插件 | npm 稳定参考包 `@tencent-weixin/openclaw-weixin@2.4.10` | 本地审阅源码；其开发依赖为 OpenClaw `2026.8.1`，不能把最新宿主行为倒推成所有旧宿主行为 |
| Chat-Codex | 当前独立 Weixin adapter，参考与上报基线 `2.4.6` | 项目已有微信接入，不加载 OpenClaw 宿主或原插件运行时 |

本轮只读取官方文档、选定宿主文件和已下载的插件参考包，没有克隆完整 OpenClaw 仓库，没有启动上游宿主，也没有发送真实微信消息。插件获取与校验信息见[参考索引](../references/README.md)。

## 3. 从 Codex 到微信，实际经过哪些步骤

### 第一步：把 Codex 的中途说明识别成独立消息

OpenClaw 自己的 Codex app-server 扩展记录每个 item 的 phase。文本增量本身不携带 phase，因此使用先前记录的 item 身份判断：`commentary` 进入进度事件，`async` 另行处理，最终答案有独立路径。

摘要转换为 `kind=preamble` 的 item 事件，保留 `itemId`、累计正文 `progressText` 和 `phase=update/end`。同一文本的重复 update 可以去重，但最后的 end 不能仅因正文相同被丢掉：渠道需要这个边界判断摘要是否写完。这里传递的是 Codex 已写出的说明，没有再调用模型把工具日志概括一遍。[Codex 事件转换源码](https://github.com/openclaw/openclaw/blob/72cc53bfce336777f23fbe941af10ad9abe4d8ae/extensions/codex/src/app-server/event-projector-assistant.ts#L574-L607)

### 第二步：确定由谁展示这条摘要

宿主为本轮确定摘要的展示归属，避免同一条内容既进入草稿又另发一条。独立摘要受 verbose 进度可见性与发送策略控制；并非插件收到所有进度事件就必定发出摘要。[展示归属源码](https://github.com/openclaw/openclaw/blob/72cc53bfce336777f23fbe941af10ad9abe4d8ae/src/auto-reply/reply/dispatch-from-config.prepare-execution.ts#L265-L330)

| 展示方式 | 实际行为 | 对微信的适用性 |
| --- | --- | --- |
| 可编辑进度草稿 | 支持的渠道把后续说明更新到同一条预览消息；最终收尾方式因渠道不同而异 | 腾讯微信 `2.4.10` 未接入这套预览回调，不能直接套用 |
| 独立摘要文本 | 开启对应进度显示且策略允许时，每条摘要作为独立消息排队发送 | 可以落到微信现有文本发送路径，仍需控制消息数量 |

例如 Slack 的紧凑摘要模式可以等待第一条摘要完成后发一条临时消息，后续摘要编辑它，最终答案确认送达后再删除预览。这依赖该渠道的编辑能力；编辑请求本身也不是免频控凭证。[官方流式与摘要说明](https://docs.openclaw.ai/concepts/streaming#slack)

### 第三步：独立摘要先缓冲，再按顺序发送

当前宿主的独立摘要分发逻辑包括：

- 同一 item 的多次快照覆盖待发正文，保留最新版本；也处理待发文本相同的情况。
- 已处理的 item ID 不因后续重复事件再次排入独立摘要。
- 下一条不同摘要、工具结果处理或最终回复等边界触发待发摘要送出。工具开始前的额外刷新取决于相应回调是否存在，不能假定微信一定具有该回调。
- 最终回复前处理已缓冲摘要；最终投递开始后抑制迟到的普通文本进度。
- 独立摘要正文加上 `💬`，经宿主 dispatcher 串行投递。

它不是“每隔固定秒数重新总结”，也不是“所有不同摘要只保留最后一条”。不同摘要仍可能各产生一次发送。[摘要缓冲源码](https://github.com/openclaw/openclaw/blob/72cc53bfce336777f23fbe941af10ad9abe4d8ae/src/auto-reply/reply/dispatch-from-config.choose-route.ts#L134-L194)

另一个细节是宿主将独立摘要排入内部 `tool` 队列。这个名称仅用于宿主调度，**不表示微信的 `TOOL_CALL_START/RESULT` 消息类型**。宿主的 humanDelay 只对首块之后的 `block` 回复生效，不能把它当成独立摘要的统一限速器。[dispatcher 源码](https://github.com/openclaw/openclaw/blob/72cc53bfce336777f23fbe941af10ad9abe4d8ae/src/auto-reply/reply/reply-dispatcher.ts#L554-L565)

### 第四步：微信插件把正文发成普通 TEXT

`2.4.10` 的正常入站回复调用 `dispatchReplyFromConfig`，明确设置 `disableBlockStreaming: true`。虽然 `channel.ts` 声明支持 block streaming，并提供 `minChars=200 / idleMs=3000` 默认值，也不能据此认定正常回复正在使用该分块合并流程。

插件的 `deliver(payload)` 读取 `payload.text`，转换 Markdown 展示格式，调用 `sendMessageWeixin()`。请求核心字段是：

| 字段 | 实际值／用途 |
| --- | --- |
| `item_list[].type` | `TEXT`，正文放在 `text_item.text` |
| `message_type` | `BOT` |
| `message_state` | `FINISH`，表示这一条完整消息，不是整个 Codex 任务结束 |
| `run_id` | 关联同一轮消息；没有“同一 run 的多条只算一次额度”的公开保证 |
| `client_id` | 每条发送生成独立标识 |
| `context_token` | 本次入站提供的会话上下文；这条回复回调捕获该值，没有主动续期步骤 |

插件另有 typing 输入状态和 `replyProgressMessages` 工具事件发送器。后者只处理 `kind=tool` 的 start/end，忽略 `kind=preamble`，因此开启它不能直接代替自然语言摘要适配。

本地依据：`2.4.10/src/messaging/process-message.ts` 第 291、348、450、516 行附近，`send.ts` 第 58 行附近，`reply-progress-sender.ts` 的 `handleToolItemEvent()`，以及 `channel.ts` 的 capabilities/streaming。完整包目录及哈希见[参考索引](../references/README.md#微信插件源码)。

```text
Codex commentary（同一 item 的 update / end）
  → OpenClaw preamble（保留身份与完成边界）
  → 进度展示策略
      ├─ 支持的渠道：更新可编辑草稿
      └─ 独立摘要：缓冲、去重、排序
          → dispatcher → 微信插件 deliver(payload.text)
          → sendmessage：普通 TEXT + run_id + context_token
```

## 4. 对“发多了会被限制”的判断

源码支持的改善点是：同一摘要的多次增量不必每次都发，重复事件不再生成多条消息，最终结果后不补发旧进度。可编辑渠道还可以减少新增聊天消息，但腾讯微信插件没有展示出这条能力。

源码没有证明：摘要免限流、`run_id` 合并服务端计数、typing 续期上下文，或 `disableBlockStreaming` 能解除限制。串行队列也不等于有发送间隔，更不等于额度保证。不同摘要连续产生时，微信仍可能收到很多 `sendmessage` 请求。

`prepare failed` 目前仍不能唯一归因为长正文或限流。该错误应继续记录请求次数（含重试）、长度、间隔、上下文年龄和业务返回码，与手机端实际可见结果一起分析。

## 5. 用户确认后的实施范围

1. **继续微信新版协议适配**：以已审阅的 `2.4.10` 为当前参考，逐项核对协议字段、消息收发和兼容差异，记录适用与不适用依据；参考更新不等于已经实现。
2. **取消微信摘要专项**：不新增摘要专用低频合并、发送额度预算或可编辑预览移植，也不再把摘要能否改善限流的对比实验列为必做项。
3. **保留现有功能**：已有 commentary、silent/brief 与工具进度入口范围保持；本次决定不表示删除已有摘要链路或改变用户偏好。
4. **保留必要适配**：Codex 消息身份、阶段性答案、提问和最终结果的语义适配，以及微信长文本、最新上下文和通用有界恢复继续列入原计划；飞书原有适配范围保持。
5. **当前只改文档**：不实施代码、依赖、配置或真实渠道测试。微信新版协议实际验收在后续实施阶段进行，不承诺摘要免限流或无限发送。

实施依据已同步到[计划 S1-E／C1](2026-10-15-codex-cli-adaptation-plan.zh-CN.md#s1-e--阶段摘要与渠道协同)和[渠道设计第 6.1 节](2026-10-15-channel-long-text-delivery-design.zh-CN.md#61-阶段摘要的协议与渠道适配)，以本节最新范围决定为准。
