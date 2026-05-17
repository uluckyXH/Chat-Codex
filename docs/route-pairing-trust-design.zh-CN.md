# 渠道会话配对信任设计

## 背景

Chat-Codex 接入微信、飞书后，通讯渠道本身可能会收到任意联系人或聊天上下文发来的消息。如果这些消息一进来就能创建 Codex session、执行命令、触发审批或读取项目上下文，就存在明显风险：

- 未授权联系人可以驱动本机 Codex。
- 未授权飞书私聊可以让机器人创建新 session。
- 微信账号接入后，非预期联系人也可能触发当前项目里的任务。
- session 绑定和权限策略虽然能隔离上下文，但不能证明“这个聊天 route 是可信的”。

因此需要在“渠道接入成功”和“允许该聊天 route 使用 Codex”之间增加一层本机配对验证。

## 目标

1. 渠道实例可以正常启动，但新发现的聊天 route 默认不可信。
2. 未信任 route 不能创建 Codex session、不能进入会话绑定、不能执行聊天命令、不能触发审批。
3. 未信任 route 的普通消息只回复不含配对码的配对引导，避免用户不知道下一步，同时不在渠道里暴露配对码。
4. 本机 TUI/终端日志打印配对码，用户必须看到本机配对码后，从对应聊天 route 发回，才能完成配对。
5. 配对成功后持久化信任记录，重启后该 route 仍可信。
6. 信任粒度必须对齐现有 `routeKey` 和多渠道模型，避免微信、飞书、不同账号、不同私聊串用。

## 非目标

- 不替代微信登录、飞书 App Secret 校验。
- 不把配对码发到微信或飞书。
- 不让未配对聊天通过 `/help`、`/status` 等命令探测系统。
- 不在第一阶段实现群聊成员级权限模型。
- 不把配对码保存到 Git、state 明文长期文件或 Codex 上下文。

## 身份边界

Chat-Codex 已经用 `routeKey` 表示一个可绑定 Codex session 的聊天上下文：

```text
<channelId>:<accountId>:<conversationKind>:<conversationId>
```

配对信任也应按 `routeKey` 做，而不是只按用户 ID 或渠道实例做。

### 微信私聊

当前微信私聊 route：

```text
weixin:<accountId>:direct:<from_user_id>
```

- `conversationId` 是微信入站消息里的对端用户 ID。
- 一个微信账号下，不同联系人是不同 route。
- 配对成功只信任当前联系人对应的 direct route。
- 换微信账号后，因为 `accountId` 不同，需要重新配对。
- 微信一对一场景下，这个识别方式是稳定且足够细的：同一个微信账号里的 A 联系人和 B 联系人会生成不同 direct route，不会共享信任。

### 飞书私聊

飞书私聊 route 使用飞书事件里的 `message.chat_id`：

```text
feishu:<accountId>:direct:<chat_id>
```

这里的 `chat_id` 就是飞书私聊上下文 ID。飞书 sender 的 `open_id` 用于审计和展示，但 direct route 的稳定会话边界用 `chat_id`，原因是：

- 出站发消息也以 `chat_id` 为目标。
- 同一个机器人会收到多个私聊，每个私聊有独立 `chat_id`。
- 每个 `chat_id` 应独立配对、独立绑定 Codex session。
- 一个飞书机器人可能被多个用户私聊使用，因此绝不能只按机器人实例信任。
- 用户 A 私聊机器人得到 `oc_a`，用户 B 私聊同一个机器人得到 `oc_b`；A 完成配对后，B 仍然未信任。
- `sender.open_id` 不作为 route 信任主键，只保存为“是谁完成了配对”的审计字段。

### 群聊和 thread

群聊和 thread 后续也应按 route 配对：

```text
<channelId>:<accountId>:group:<group_id>
<channelId>:<accountId>:thread:<thread_id>
```

第一阶段可以先只支持 direct route 配对。群聊开启前需要单独确认：

- 是信任整个群，还是只信任群里的某些 sender。
- 配对码由谁发送才有效。
- 群内配对成功提示是否会暴露给所有人。

## 用户可见流程

### 首次收到未信任消息

1. 用户在本机启动 `npm run chat-codex`。
2. 微信或飞书渠道已连接。
3. 某个聊天 route 第一次发消息。
4. Bridge 记录该 route 的基础元数据，但不进入 Codex。
5. Bridge 在本机 TUI/终端日志打印配对信息：

```text
发现未配对聊天
渠道: 飞书 / 大龙虾
聊天: 张三（direct）
Route: feishu:default:direct:oc_xxx
配对码: 7K4P-92
有效期: 10 分钟
请让该聊天发送：/pair 7K4P-92
```

6. 对微信/飞书聊天本身回复简短引导，但不包含配对码：

```text
当前聊天还没有完成 Chat-Codex 配对。
请查看运行 chat-codex 的终端/TUI 日志中的配对码，然后在当前聊天发送 /pair <配对码> 完成配对。
```

### 用户发送配对码

推荐格式：

```text
/pair 7K4P-92
```

可选兼容格式：

```text
7K4P-92
```

验证通过后：

- 持久化信任当前 `routeKey`。
- 本机日志记录配对成功。
- 可以给该聊天回复一次：

```text
Chat-Codex 配对成功，当前聊天已信任。
```

这条成功回复可以发送，因为此时 route 已可信。

### 配对失败

未配对 route 发错配对码时：

- 回复配对失败和查看终端/TUI 日志的提示，但不包含正确配对码。
- 本机日志记录失败次数。
- 达到上限后废弃旧码并生成新码。

建议默认：

```text
配对码有效期: 10 分钟
最大尝试次数: 5 次
配对码长度: 6-8 位，使用不易混淆的 Base32/大写字母数字
```

## Bridge 处理顺序

当前 Bridge 收到消息后的核心顺序需要增加 trust gate。

建议顺序：

```text
ChannelMessage
  -> transcript inbound（可脱敏记录）
  -> route metadata record（只记录发现，不绑定 session）
  -> RouteTrustGate
      - 已信任：继续正常流程
      - 未信任 + 配对码正确：写入 trusted-routes，回复成功，停止本轮
      - 未信任 + 普通消息：本机日志打印配对码，渠道回复不含配对码的配对引导，停止本轮
      - 未信任 + 错误配对码：本机日志记录失败，渠道回复失败提示和查看终端/TUI 日志的引导，停止本轮
  -> pending 微信主聊天绑定消费
  -> command router
  -> pending media / session selection / route queue
  -> Codex
```

关键点：

- trust gate 必须早于 session 创建、session 绑定、聊天命令和 Codex prompt。
- 未信任 route 不消费微信 pending 主聊天绑定。
- 配对成功这条 `/pair` 消息不应转发给 Codex。
- 配对成功后，本轮 `/pair` 只完成信任写入和成功提示，不执行为普通消息，也不直接触发 Codex。
- 后续第一条普通消息才会继续进入原流程，并在那时消费对应 route 的 pending 微信主聊天绑定。

## 持久化设计

新增本地状态文件：

```text
~/.chat-codex/state/bridge/trusted-routes.json
```

示例：

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-05-17T15:30:00.000Z",
  "trustedRoutes": [
    {
      "routeKey": "feishu:default:direct:oc_xxx",
      "channelId": "feishu",
      "accountId": "default",
      "conversationKind": "direct",
      "conversationId": "oc_xxx",
      "displayName": "张三",
      "trustedAt": "2026-05-17T15:30:00.000Z",
      "trustedBySenderId": "ou_xxx",
      "trustMethod": "pairing_code",
      "lastSeenAt": "2026-05-17T15:30:00.000Z",
      "createdAt": "2026-05-17T15:30:00.000Z",
      "updatedAt": "2026-05-17T15:30:00.000Z"
    }
  ]
}
```

持久化内容：

- 已信任 route。
- route 的渠道身份字段。
- 配对完成时间。
- 完成配对的 sender ID，用于审计。
- 最近一次看到该 route 的时间。

不持久化：

- 配对码。
- 未过期 pending challenge。
- 任何飞书 App Secret、微信 token。
- 用户输入的错误配对码。

原因：配对码是一次性短期挑战，重启后应重新生成，避免落盘后被读取或复用。

## 升级兼容和迁移策略

引入配对信任后，旧版本已经存在的 route/session 绑定不能自动视为可信。原因是旧版本没有证明“这个聊天 route 的用户能看到本机终端配对码”。

默认迁移策略：

- 已有 `routes.json`、`session-owners.json`、`pending-bindings.json` 保持不变，不自动删除。
- 新版本首次启动后，如果某个历史 route 没有出现在 `trusted-routes.json`，则视为未信任。
- 未信任历史 route 发来的普通消息仍被 trust gate 拦截，不会继续使用原有 session。
- 用户需要对这个 route 完成一次配对。
- 配对成功后，原有 route/session 绑定可以继续使用，不需要重新绑定 session。

这意味着从旧版本升级到新版本后，真实微信/飞书聊天需要各自配对一次。这个成本是刻意保留的安全边界。

可选迁移能力：

- 后续可以在 TUI 里显示“历史绑定但未配对”的列表。
- 管理员可以在本机 TUI 中手动信任某个历史 route，但第一阶段不做。
- 不提供自动批量信任历史 route 的默认行为。

## 配对生命周期

配对码是一次性的，route 信任是持久的。

- 配对码只用于本次 challenge。
- 配对码验证成功后立即失效。
- 配对码过期、失败次数过多或服务重启后，需要生成新码。
- route 信任写入 `trusted-routes.json` 后长期有效，直到用户撤销信任。
- route 信任可以被管理，但管理操作必须发生在本机 TUI/终端侧，不能由未信任聊天远程触发。

后续管理能力：

- 查看已信任 route。
- 查看待配对 route。
- 撤销某个 route 的信任。
- 撤销信任时保留还是解绑 session 需要二次确认。
- 重新生成某个待配对 route 的配对码。

## 运行时配对状态

新增运行时模块：

```text
src/bridge/route-trust-gate.ts
src/bridge/pairing-code-manager.ts
src/state/memory-state-store.ts
src/state/file-state-store.ts
```

职责：

- `RouteTrustGate`
  - 判断 route 是否可信。
  - 拦截未信任 route。
  - 识别 `/pair <code>`。
  - 调用配对码管理器和状态存储。
- `PairingCodeManager`
  - 生成随机码。
  - 管理 TTL、尝试次数、过期和轮换。
  - 只保存在内存。
- `MemoryStateStore` / `FileStateStore`
  - `isRouteTrusted(routeKey)`
  - `trustRoute(record)`
  - `revokeRouteTrust(routeKey)`
  - `listTrustedRoutes()`
  - `FileStateStore` 负责读写 `trusted-routes.json`。

## TUI/日志展示

第一阶段只要求 TUI/runtime 日志能清楚显示配对码和配对状态，不要求实现完整 TUI 管理页。原因是 TUI 样式和交互还会继续重构，核心安全链路应先独立落地。

TUI 运行日志应增加安全类日志：

```text
[安全] 发现未配对聊天：飞书 / 大龙虾 / 张三
[安全] 配对码：7K4P-92，有效期 10 分钟
[安全] 配对成功：feishu:default:direct:oc_xxx
```

首页可增加简洁状态：

```text
信任: 3 个已配对，1 个待配对
```

聊天绑定页：

- 未信任 route 可以显示为“待配对”。
- 未信任 route 不允许绑定 session。
- 已信任 route 才进入原有“选择已有 session / 新建 session / 解绑”流程。

## 配置策略

建议第一阶段默认策略：

- 微信、飞书真实渠道：默认要求配对。
- Mock、Terminal 开发渠道：默认跳过配对，避免开发和测试变复杂。

Bridge option 使用：

```ts
type RouteTrustMode = "disabled" | "pairing_required" | "real_channels";
```

其中 `real_channels` 只对微信、飞书和 Lark 真实渠道要求配对，Mock/Terminal 继续跳过配对。

后续 TUI 可以增加设置：

```text
安全设置
- 新聊天需要配对: 开启
- 查看已信任聊天
- 撤销聊天信任
- 查看历史绑定但未配对的聊天
- 重新生成配对码
```

这些管理入口是第二阶段能力。第一阶段只实现核心配对：

- 未信任 route 被拦截。
- 本机日志打印配对码。
- `/pair <code>` 完成配对。
- 配对结果持久化。

## 和现有功能的关系

### Session 绑定

配对信任只说明“这个聊天 route 允许使用 Chat-Codex”，不等于已经绑定 Codex session。

顺序应是：

```text
route 配对可信 -> session 绑定/创建 -> Codex 对话
```

一个 Codex session 仍只能绑定一个 route。

### 微信主聊天 pending binding

微信添加账号后，如果配置了主聊天 pending binding：

- 第一个未信任微信私聊不能直接消费 pending binding。
- 该私聊完成配对后，才可以消费 pending binding。
- 这样可以避免陌生联系人先发消息抢占微信主聊天绑定。

### 飞书多 chat_id

飞书机器人下每个私聊 `chat_id` 都是独立 route：

```text
feishu:default:direct:oc_a
feishu:default:direct:oc_b
```

每个 `chat_id` 都必须分别配对。配对 `oc_a` 不会信任 `oc_b`。

### `/status`、`/help`、`/new`

未信任 route：

- 不返回真实 `/status`。
- 不返回真实 `/help`。
- 不执行 `/new`。
- 不执行 `/progress`。
- 这些命令只会得到配对引导提示。
- 只识别 `/pair <code>` 或纯配对码。

已信任 route：保持现有命令行为。

### 入站媒体

未信任 route 发送图片或文件时：

- 不下载或不进入 Codex。
- 可以只记录 route 发现和配对码。
- 不写入 pending media。

如果 adapter 已经在发出 `ChannelMessage` 前完成下载，第一阶段可以接受已下载文件存在本地；后续可优化为 trust gate 前置到 adapter 下载前，减少未信任媒体落盘。

## 安全细节

- 配对码使用 `crypto.randomBytes` 或 `crypto.randomInt` 生成，不能用 `Math.random()`。
- 配对码只在本机 TUI/终端显示，不发渠道。
- 配对码验证应常量时间比较，避免理论上的 timing leak。
- 配对码过期后必须重新生成。
- 达到失败次数上限后必须轮换或短暂锁定。
- 日志中可以显示 routeKey，但不要显示渠道密钥。
- 配对成功记录可以持久化 routeKey，因为 routeKey 已经在 routes 状态中存在，不属于 secret。

## 测试设计

### 单元测试

- `PairingCodeManager`：
  - 生成码格式正确。
  - TTL 到期后失败。
  - 错误尝试计数。
  - 达到上限后轮换。
- `RouteTrustStore`：
  - trust/revoke/list 持久化。
  - 重启后恢复。
- `RouteTrustGate`：
  - 未信任普通消息被拦截。
  - 未信任普通消息向渠道回复不含配对码的配对引导。
  - 正确 `/pair` 写入 trust。
  - 错误 `/pair` 回复不含正确码的失败提示、不放行。

### 集成测试

- 未信任飞书私聊不会创建 Codex session。
- 未信任微信私聊不会消费 pending 主聊天绑定。
- 飞书 `oc_a` 配对后，`oc_b` 仍未信任。
- 配对成功后重启 Bridge，原 route 可直接对话。
- 从旧版本升级后，已有 route/session 绑定默认未信任，需要配对一次；配对成功后继续使用原 session。
- 已信任 route 的 `/status`、`/new`、普通 prompt 行为保持不变。
- Mock/Terminal 默认不受配对影响。

## 实施顺序

1. 新增设计文档和 docs 索引。
2. 新增 trust 持久化类型和 store。
3. 新增 `PairingCodeManager` 单元测试。
4. 新增 `RouteTrustGate`，先接入 Bridge 普通文本路径。
5. 接入 pending 微信主聊天绑定消费顺序。
6. 接入 TUI/runtime 安全日志。
7. 补飞书 `chat_id` 隔离和微信 pending binding 集成测试。
8. 补旧版本历史 route 默认未信任、配对后沿用原 session 的迁移测试。
9. 第二阶段再增加 TUI 的“已信任聊天 / 撤销信任 / 重新生成配对码”管理页面。

## 待确认

- 配对成功后是否给聊天回复成功提示。推荐回复，因为此时 route 已可信。
- 是否允许纯配对码，还是只允许 `/pair <code>`。推荐两者都支持，TUI 文案主推 `/pair`。
- 群聊配对策略暂不在第一阶段实现，需要单独设计。
- 是否给真实渠道提供关闭配对的开发开关。推荐保留 Bridge option，但 TUI 默认不暴露给普通用户。
- 撤销信任时是否自动解绑 session。推荐默认不自动解绑，但 TUI 必须提示风险并提供“同时解绑”选项。
