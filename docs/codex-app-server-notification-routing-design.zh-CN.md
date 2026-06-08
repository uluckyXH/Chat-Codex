# Codex app-server 通知路由设计

## 背景

新版 Codex app-server 会通过 `ServerNotification` 主动通知客户端 thread 生命周期、执行过程、模型路由、配置警告和安全提示。Chat-Codex 作为微信/飞书聊天桥接，需要把这些通知分成三类处理：

1. 必须推送给用户的通知。
2. 只更新本地状态的通知。
3. 暂不支持但不能导致用户困惑的通知。

本文只讨论 app-server notification 路由，不讨论 `item/tool/requestUserInput` 的交互适配。`requestUserInput` 后续需要单独设计 pending input 流程。

## 目标

- 安全相关通知完整推送到对应聊天渠道。
- thread 归档/关闭要让用户明确知道当前绑定不可继续使用，并给出 `/new`、`/resume` 路径。
- 普通状态变化尽量不打扰用户，只更新本地 session 状态。
- 模型实际切换、配置异常等会影响用户理解执行结果的信息，要低频但明确地提示。
- 不把通知处理变成新能力入口；通知只解释状态，不执行额外动作。

## 非目标

- 不实现 `item/tool/requestUserInput` 聊天表单。
- 不支持 MCP elicitation、OAuth、token refresh、attestation。
- 不开放 app-server `fs/*`、standalone `command/exec`、plugin/marketplace 操作。
- 不做 Codex App 的完整 thread 管理 UI。

## `updated` 通知触发机制

`thread/*/updated` 不由 Chat-Codex 定时轮询触发，也不通过扫描 Codex 本地历史触发。它们的触发方是当前 Chat-Codex 启动并连接的 `codex app-server`：

```text
Codex app-server 内部 thread 状态变化
  -> 主动发送 ServerNotification: thread/name/updated 等
  -> AppServerRpcClient 收到 notification
  -> AppServerCodexAdapter.handleNotification()
  -> 按 threadId 映射到本地 sessionId
  -> patch Chat-Codex 内存状态
```

因此 `updated` 适配只覆盖当前 app-server 进程能观察到的运行期变化：

- `thread/name/updated`：Codex 侧标题变化。
- `thread/tokenUsage/updated`：Codex 执行过程中或结束后 token 用量变化。
- `thread/settings/updated`：Codex 侧 thread 设置变化，例如 cwd、model、serviceTier、approvalPolicy、sandboxPolicy。
- `thread/goal/updated` / `thread/goal/cleared`：Codex Goal 创建、更新或清除。
- `thread/status/changed`：Codex thread 在 idle、active、waiting、systemError 等状态之间变化。

这些通知不触发 `reloadSession()`，不触发 `/new`，不解除绑定，也不作为新的聊天交互入口。Chat-Codex 只把它们作为 app-server 运行期 metadata/status sync，用来更新 `/status`、`/sessions`、TUI 或后续低频状态展示。

另一个电脑端 Codex CLI 进程写入同一个 session 文件时，不会通过当前 app-server 发出这些 `updated` notification。这个场景继续由现有“发送前上下文刷新”负责：

```text
用户下一次在 Chat-Codex 发消息
  -> beforeRun 读取 Codex 本地 session 指纹
  -> 发现 state_5.sqlite / rollout JSONL 比上次快照更新
  -> 按当前 /context-refresh 策略提醒或 reloadSession()
  -> 再决定是否发送本条消息
```

不做定时刷新。原因是定时扫描会增加本地 I/O、带来运行中双进程同时写 session 的竞态，也不能可靠解决语义冲突。若后续需要增强可见性，可以在 `/status` 时做一次轻量 opportunistic detect：只提示“本机 Codex 历史有外部更新”，不在 `/status` 中自动 reload。

## 通知分类

### 必须完整推送

这些通知涉及安全、策略或实际执行模型，不能只写日志，也不应被普通 progress 限流吞掉。

| 通知 | 推送策略 | 内容要求 |
| --- | --- | --- |
| `guardianWarning` | 推送到当前 route/channel | 完整保留 Codex 给出的 `message` |
| `model/verification` | 推送到当前 route/channel | 完整列出 `verifications` |
| `model/rerouted` | 推送到当前 turn 所属 route/channel | 完整展示 `fromModel`、`toModel`、`reason` |
| 安全类 `warning` | 推送到当前 route/channel | 完整保留 `message` |

完整推送的含义：

- 不摘要、不改写关键字段、不截断安全原因。
- 如果渠道有单条消息长度限制，可以按原文分段发送，但不能丢字段。
- 即使该渠道当前禁用了普通 progress，也必须发送安全通知。
- 推送失败时写入运行日志和 transcript，后续 `/status` 应能暴露最近安全通知摘要。

第一版无法可靠判断 `warning` 是否安全类时，采取保守策略：所有 `warning` 都推送，但做去重，避免同一条消息刷屏。

### 需要主动提示

这些通知会影响当前绑定是否还能继续使用。

| 通知 | 处理策略 |
| --- | --- |
| `thread/archived` | 如果当前 route 绑定该 session，推送提示并解绑 |
| `thread/closed` | 如果当前 route 绑定该 session，推送提示并解绑 |
| `thread/unarchived` | 不自动重新绑定；若当前 route 仍有状态记录，可在 `/status` 展示已恢复可用 |

归档提示文案：

```text
当前 Codex 会话已在 Codex 侧归档，Chat-Codex 已解除绑定。
原 Session: <sessionId>
请发送 /new 创建新会话，或发送 /resume 切换到其他会话。
```

关闭提示文案：

```text
当前 Codex 会话已在 Codex 侧关闭，Chat-Codex 已解除绑定。
原 Session: <sessionId>
请发送 /new 创建新会话，或发送 /resume 切换到其他会话。
```

解绑要求：

- 释放 active binding。
- 释放 session owner，避免其他 route 无法选择该 session。
- 不删除 Codex 本地历史，不修改工作区。
- 如果该 route 当前有运行中的 turn，保留失败/中断状态并提示用户重新选择会话。

### 只更新状态

这些通知不需要主动打扰用户。

| 通知 | 处理策略 |
| --- | --- |
| `thread/name/updated` | 更新本地 session title；影响 `/sessions`、`/status` 展示 |
| `thread/settings/updated` | 同步 cwd/model/serviceTier/effort 等只读状态；permission/sandbox 只作为 Codex 侧已生效状态展示，不反向修改 Chat-Codex 全局权限策略 |
| `thread/tokenUsage/updated` | 更新上下文 token 状态 |
| `thread/goal/updated` / `thread/goal/cleared` | 当前 Goal 流已有自己的可见反馈；通知先作为状态同步 |
| `thread/status/changed` | 同步 idle/active/systemError/waiting 状态；waitingOnUserInput 在 `requestUserInput` 单独设计前只做状态，不开启聊天问答 |

### 低频提示或状态展示

| 通知 | 处理策略 |
| --- | --- |
| `configWarning` | 推送一次完整 summary/details；后续相同内容去重 |
| `deprecationNotice` | 默认进日志和 `/status`；如果影响当前 turn，可推送一次 |
| `mcpServer/startupStatus/updated` | 默认进日志；不主动引导用户做 MCP 操作 |
| `account/updated` / `account/rateLimits/updated` | 默认进日志和 `/status`，不在群聊暴露账号细节 |

`configWarning` 可能包含本地路径。允许展示触发配置文件路径，但不要展示 token、cookie、access token 等密钥值。如果 Codex 原文包含明显 secret 形态，发送前需要脱敏。

## 路由规则

1. 有 `threadId` 的通知：
   - 通过 session/thread 映射找到当前 route owner。
   - 如果 route 有可投递 target，发到该 route。
   - 如果没有可投递 target，进入 runtime log 和 `/status` 最近通知。

2. 有 `turnId` 的通知：
   - 优先跟随当前 turn 的 route。
   - 如果该 turn 是 background turn，例如 Goal 自动续跑，走 background turn 投递路径。

3. 没有 `threadId` 的全局通知：
   - 默认只进 runtime log。
   - 安全类全局通知可发送到 TUI/终端运行日志，不主动群发到所有聊天 route。

4. 群聊：
   - 安全通知可发到触发任务的群 route。
   - 不 @ 全员。
   - 不允许群成员通过通知触发任何额外权限变化。

## 去重与限流

安全通知不能被普通 progress 策略抑制，但仍需要防重复：

- key: `method + threadId + turnId + message/reason/verifications`
- 同一 key 在 10 分钟内只推送一次。
- 不同安全通知必须分别推送。
- 长消息按渠道长度限制分段，不做摘要。

普通 warning/config/deprecation 可以更严格限流：

- 同一 key 在 30 分钟内只推送一次。
- 重复内容只进 runtime log。

## `/status` 展示

`/status` 应展示最近通知摘要：

- 最近安全通知：完整 message 的首行 + 时间。
- 最近 thread lifecycle：archived/closed/unarchived。
- 最近模型切换：from/to/reason。
- 最近 config warning：summary + 时间。

`/status` 不是安全通知的替代；安全通知仍要主动推送。

## `requestUserInput` 待讨论边界

`item/tool/requestUserInput` 暂不纳入本文实现范围。已知 schema 包含：

- `threadId`
- `turnId`
- `itemId`
- `questions[]`
  - `id`
  - `header`
  - `question`
  - `isOther`
  - `isSecret`
  - `options`

后续讨论重点：

- 私聊是否支持下一条回复作为答案。
- 群聊由谁有资格回答。
- `isSecret: true` 是否一律拒绝。
- 超时、取消、抢答和普通 prompt 冲突怎么处理。

在单独设计前，当前策略继续保持 fail-closed：给出可解释提示并拒绝/取消，不让 Codex turn 卡死。

## 实施计划

### 第一阶段：通知推送策略

1. 增加 notification router/mapper。
2. 安全通知完整推送，绕过普通 progress suppression。
3. archive/close 当前绑定时主动提示并解绑。
4. thread rename 只更新本地 title。
5. model reroute/verification 完整推送。
6. configWarning 完整推送一次并去重。

验收：

- 安全通知在微信/飞书默认 progress 策略下仍会发出。
- archive/close 后当前 route 不再绑定原 session。
- 用户收到 `/new`、`/resume` 下一步提示。
- 不新增任何 MCP、OAuth、plugin、dynamic tool 能力。

### 第二阶段：状态沉淀

1. 保存最近通知到内存状态。
2. `/status` 展示最近安全通知、模型切换、config warning。
3. TUI 运行日志展示完整通知。

验收：

- 推送失败时仍能在本地状态查到最近通知。
- `/status` 不泄露 token/secret。

## 测试计划

### 单元测试

- `guardianWarning` 完整推送，不被 progress policy 禁用。
- `model/rerouted` 完整展示 from/to/reason。
- `model/verification` 完整展示 verification 列表。
- `thread/archived` 当前绑定解绑并提示 `/new`、`/resume`。
- `thread/closed` 当前绑定解绑并提示 `/new`、`/resume`。
- `thread/name/updated` 只更新 title，不发送聊天消息。
- `configWarning` 同内容去重。

### 集成测试

- mock app-server 发安全通知，Bridge 投递到当前 route。
- mock app-server 发 archive/close，后续普通消息触发 unbound route policy。
- 微信 `silent/brief` 等进度模式下，安全通知仍完整发送。
- 飞书群聊中，安全通知发送到当前群 route，不触发权限变更。

### 手工验证

- 使用真实 `codex app-server` 跑普通 prompt，确认正常回复不受影响。
- 通过 mock/调试 app-server 注入 `guardianWarning`、`thread/archived`、`model/rerouted`。
- 检查 `/status` 和 TUI 日志里的最近通知。
