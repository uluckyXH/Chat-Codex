# 微信插件 2.4.6 升级兼容性评估

> 2026-10-15：本文保留 7 月升级范围的历史记录。后续已实施微信 2.4.10 的 ID、回执、引用及收发兼容，源码默认协议版本现为 2.4.10，见[新版实施进度](2026-10-15-weixin-2.4.10-protocol-implementation.zh-CN.md)。中途摘要专项仍取消，长文本／发送恢复另列；下文版本及“不纳入本轮”均为当时批次的记录。

本文档只记录 `@tencent-weixin/openclaw-weixin` 的版本盘点、Chat-Codex 适配差异和建议实施顺序。它不是实现提交，也不代表 Chat-Codex 会直接安装或运行 OpenClaw 插件。

## 结论

Chat-Codex 不依赖 `@tencent-weixin/openclaw-weixin` 的运行时代码。当前微信渠道是本项目自己的 `WeixinAdapter` 和 `WeixinApiClient`，插件只作为协议、登录和媒体行为的参考来源。因此这里的“升级”应理解为：

```text
更新参考基线 + 对齐必要的微信协议行为
```

而不是把 npm 包加入 `package.json` 后执行一次依赖升级。

截至 2026-07-24：

- 本地参考版本已更新为：`2.4.6`。
- npm `latest`：`2.4.6`，发布时间为 2026-06-22。
- 已下载但未提交 `2.4.5`、`2.4.6` tarball 作只读比较。
- `2.4.6` 与 `2.4.5` 的 `src/` 和 `dist/` 内容相同；仅版本号从 `2.4.5` 改为 `2.4.6`，并从发布包移除了 `npm-shrinkwrap.json`。

所以，`2.4.6` 本身没有新的微信协议或行为变更。真正需要对齐的是 `2.4.4` 和 `2.4.5` 已引入、且与独立 Chat-Codex adapter 有关的变化。P0 长轮询适配已完成；真实微信账号验证仍待补测。

## 实施状态

2026-07-24 已完成 P0：

- `WeixinApiClient.getUpdates()` 接收 adapter 的外部 `AbortSignal`，并和请求超时 signal 合并。
- adapter 停止时会取消正在等待的 `getupdates` 请求；外部中止不会被误当作普通超时或通道故障。
- 客户端自身 long-poll 超时会作为空轮询继续下一次请求，不把正常等待超时标记为 `degraded`。
- `WeixinAdapter` 首次使用本地 `longPollTimeoutMs`，后续在服务端给出有效 `longpolling_timeout_ms` 时采用该值。
- adapter 默认 `sourceVersion` 与 API 默认 `channelVersion` 更新为 `2.4.6`；这只是协议元数据和参考版本更新，不引入 OpenClaw npm 运行时依赖。
- 自动化验证完成：微信 adapter 定向测试 `21` 项通过；全量测试 `496` 项通过。

真实微信环境仍需补测：启动一个真实账号、在没有新消息时停止/重启，确认长轮询立即退出且不会出现双轮询。

## 版本与边界

上游插件的 `2.4.1`、`2.4.2` 中大部分变化只影响 OpenClaw 宿主：预编译插件入口、`openclaw.plugin.json`、runtime 注入和宿主最低版本。这些能力不适用于本项目，因为 Chat-Codex 不启动 OpenClaw gateway，也不加载 OpenClaw plugin runtime。

Chat-Codex 当前版本信息存在两个不同概念，不能混用：

| 概念 | 当前状态 | 说明 |
| --- | --- | --- |
| 参考源码基线 | `references/README.md` 记录 `2.4.6` | 用于人工比对，非运行时依赖。 |
| 微信上报的 `channel_version` | `WeixinAdapter` 默认 `2.4.6` | 写入 CGI `base_info` 和 `iLink-App-ClientVersion`，属于 wire metadata。 |

后续实现时应把“参考版本”和“wire version”明确区分。不能仅因 npm 最新是 `2.4.6` 就把所有运行时行为视为已完成适配，也不应继续让文档与上报版本无说明地漂移。

## 当前能力盘点

下表只讨论与插件更新相关的微信通讯能力。

| 上游能力 | Chat-Codex 当前状态 | 结论 |
| --- | --- | --- |
| `base_info.channel_version`、`bot_agent`、iLink 请求头 | 已实现 | 保持；`bot_agent` 目前是固定标识，属于可观测性优化而非兼容阻塞。 |
| `sendmessage` 的 `ret` / `errmsg` 失败检测 | 已实现，且同时检查 `ret` 和 `errcode` | 保持；本项目比 2.4.5 的最小检查更严格。 |
| 二维码 `local_token_list` | 已实现 | 保持。 |
| `binded_redirect`、`need_verifycode`、`verify_code_blocked` 登录分支 | 已实现 | 保持。 |
| `notifystart` / `notifystop` | 已实现 | 保持。 |
| `TOOL_CALL_START` / `TOOL_CALL_RESULT` 协议项 | adapter 已实现发送能力 | 不因上游 2.4.4 重新开启微信 progress；当前微信低噪声策略仍优先。 |
| 普通请求超时 | 已实现 | 保持。 |
| 外部 `AbortSignal` 立即中止长轮询 | 已实现 | adapter 停止会取消 pending `getupdates`。 |
| 服务端 `longpolling_timeout_ms` | 已实现 | 服务端给出有效正数时用于下一次轮询。 |
| fetch 网络错误分类 | 未实现 | 建议作为可观测性增强，非阻塞。 |

## 已实施：可中断的长轮询

上游 `2.4.4` 为 `getUpdates` 增加了外部 `AbortSignal`。目的不是改变微信消息语义，而是让关闭、重启或热重载通道时，可以立刻取消正在等待的 long-poll。

实施前 Chat-Codex 的问题是：

1. `WeixinAdapter.stop()` 会触发内部 `AbortController`。
2. 轮询循环会检查这个 signal。
3. 但调用 `WeixinApiClient.getUpdates()` 时没有把 signal 传到 `fetch`。
4. 如果请求已进入微信 long-poll，`stop()` 仍可能等待本次请求的超时，默认最长约 35 秒。

这不是用户消息丢失问题，但会造成退出慢、重启慢，也会增加两个进程短暂重叠消费同一账号的风险。

### 当前实现

只在微信 API / adapter 边界修改，不让 Bridge Core 感知：

1. `WeixinApiClient.getUpdates()` 现在有可选 `signal` 参数。
2. `fetchWithTimeout()` 组合“请求超时 signal”和“adapter 停止 signal”。
3. `pollLoop()` 将自己的 `signal` 传给 `getUpdates()`。
4. 外部中止时轮询正常退出；只有客户端自身请求超时时才返回空轮询继续下一次请求。
5. 其他 API 的超时、重试和错误处理语义保持不变。

验收标准：一个刻意不返回的 mock `getupdates` 请求中，调用 `adapter.stop()` 后应快速完成，不等待 long-poll 超时。

## 已实施：服务端建议的下次轮询超时

微信 `getupdates` 响应可以携带 `longpolling_timeout_ms`。上游 monitor 会在收到正数时将它用于下一次 long-poll。Chat-Codex 现在同样采用该字段；实施前仅保留类型，轮询仍固定使用本地默认值。

当前行为：

```text
第一次轮询：使用 Chat-Codex 配置的 longPollTimeoutMs
后续轮询：服务端给出有效正数时使用 longpolling_timeout_ms，否则继续用上一次值
```

这与上游行为一致，能够在微信服务端调整轮询窗口时跟随协议建议。该值只影响下一次入站轮询，不影响出站发送频率、消息数量限制或 `/fff` 语义。

## 可选适配：网络错误分类

上游 `2.4.5` 把 fetch 层错误区分为 DNS、TCP、TLS、超时和未知错误。Chat-Codex 目前会保留原始错误文本并更新 channel `lastError`，功能上已经可用，但排查网络问题时缺少稳定分类。

建议仅在本地日志和 `ChannelStatus.details` 中增加结构化分类：

- 不改微信用户可见错误文案。
- 不吞掉原始错误。
- 不改变现有重试条件。
- 不把 DNS/TLS 诊断误报为登录态或 `context_token` 问题。

这是 P1 可观测性增强，不应阻塞长轮询修复。

## 明确不纳入本轮

以下能力要么属于 OpenClaw 宿主，要么与当前微信低噪声策略冲突，不应借“插件升级”一并加入：

| 项目 | 原因 |
| --- | --- |
| 安装 `@tencent-weixin/openclaw-weixin` 为 Chat-Codex 依赖 | 会把 OpenClaw peer/runtime 边界带入独立中间件，破坏现有架构。 |
| OpenClaw plugin entry、`channelRuntime`、host 最低版本 | 仅适用于 OpenClaw 运行时。 |
| 重新打开 `replyProgressMessages` 或工具生命周期消息 | 微信已明确采用“最终回复、错误、审批、命令回复优先”的低噪声策略，不能因上游默认开启而反向开启。 |
| 外发 hook | 上游 hook 是 OpenClaw host 生命周期扩展点；Chat-Codex 若将来需要，应先定义自己的通用 channel hook 协议。 |
| 语音媒体、视频媒体、消息编辑等新产品能力 | 不是 `2.4.3 -> 2.4.6` 的必要协议修复，应独立立项、单独做媒体和渠道体验设计。 |

## 建议实施顺序

### P0：可靠性对齐（已完成）

1. 已为长轮询接入外部 `AbortSignal`。
2. 已采用 `longpolling_timeout_ms`。
3. 已增加 API / adapter 集成测试。
4. 已更新参考版本记录为 `2.4.6`，并保留参考版本与 wire version 的边界说明。

### P1：诊断质量

1. 增加 fetch 错误分类。
2. 在 terminal transcript / status details 保留分类与原始错误。
3. 评估是否将固定 `bot_agent` 改为由本项目版本生成的准确标识。

### P2：单独讨论的产品能力

语音/视频媒体、微信富消息、可编辑消息和未来消息聚合都应另起设计，不能与兼容性补丁混在同一轮。

## 测试计划

P0 实现后至少需要：

1. API 单元测试：外部 signal 能取消 pending `getupdates`，本地 timeout 仍正常触发。
2. adapter 集成测试：长轮询未返回时 `stop()` 快速完成，状态最终为 `stopped`。
3. adapter 集成测试：服务端返回 `longpolling_timeout_ms` 后，下一次请求使用该值。
4. 回归测试：登录、二维码二次校验、`binded_redirect`、文本、媒体、typing、`ret=-2` fallback、发送队列和重试全部保持通过。
5. 真实微信补测：启动、停止、重启后确认没有双轮询，长任务最终回复仍可投递。

每次实现仍须执行 `npm run build`、`npm test`、`git diff --check`，并在 `reports/tests/` 留下中文测试报告。

## 后续待确认决策

1. 是否把 P1 的网络错误分类一起做；它不改变行为，但会增加少量日志和测试。
2. 保持微信 progress 关闭；不因上游 `replyProgressMessages` 重新开放。
3. 是否在真实微信验证后，把固定 `bot_agent` 改为根据 Chat-Codex 版本生成的准确标识。

## 参考依据

- 初始比较基线：`openclaw-weixin-npm/extracted/openclaw-weixin-2.4.3/`；当前参考版本：`openclaw-weixin-npm/extracted/openclaw-weixin-2.4.6/`。
- 本次只读比较：`@tencent-weixin/openclaw-weixin@2.4.5`、`@tencent-weixin/openclaw-weixin@2.4.6` npm tarball。
- 上游变更说明：`2.4.4` 的外部中止与工具进度、`2.4.5` 的发送响应校验和网络错误分类。
- Chat-Codex 对照代码：`src/channels/weixin/weixin-adapter.ts`、`src/channels/weixin/weixin-api.ts`、`src/channels/weixin/weixin-types.ts`。
