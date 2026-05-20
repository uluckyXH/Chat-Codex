# 飞书群聊接入与权限设计

## 背景

当前 `FeishuAdapter` 已完成飞书私聊接入，群聊仍被显式关闭：

- `getCapabilities()` 中 `group: false`。
- 入站映射遇到 `message.chat_type !== "p2p"` 时返回 `unsupported_chat_type`。

本地 `references/openclaw-lark` 插件源码已经有群聊、@ 识别、群成员、发言人名称缓存和群策略相关实现，可以作为参考。Chat-Codex 自身的通用协议也已经支持 `ConversationKind = "group"`，routeKey 模型可以自然表达飞书群聊：

```text
feishu:<accountId>:group:<chat_id>
```

因此飞书群聊不是协议层问题，主要是产品策略、权限模型、状态持久化和真实链路验证问题。

## 目标

1. 飞书群聊默认只在用户 @ 机器人时触发 Codex。
2. 飞书群聊必须有渠道实例级开关，默认关闭，用户显式开启后才接收群消息。
3. 一个飞书群聊只需要配对一次，信任和 session 绑定按群 route 持久化。
4. 群聊消息进入 Codex 时保留发言人身份，优先使用显示名；自动拿不到名称时，引导群成员用 `/name` 建立群内名册。
5. 回复默认走飞书官方最推荐的原消息 reply；失败时再回退到向 `chat_id` 创建新消息。
6. 群聊内增加最小权限模型：单个超级管理员、小黑屋、可选开放审批。
7. 管理员角色只做设计预留，第一版不启用管理员权限判断。
8. 权限设计必须能先做 MVP，又给后续复杂治理留出口。
9. 群聊支持手工成员名册：当飞书数据权限拿不到名称时，允许群成员通过命令明确告知自己的展示名。

## 非目标

- 不在第一版做飞书 thread/topic 群的独立 session。
- 不做企业级 RBAC、组织架构同步或飞书群主自动识别。
- 不在第一版做多管理员管理或管理员审批分权。
- 不允许普通群成员修改 Chat-Codex 权限。
- 不把每个发言人拆成独立 route；群聊共享同一个 route/session。
- 不把飞书 contact/member API 的名称解析失败视为消息失败。
- 不要求私聊用户补充名称。私聊不解析名称，继续显示 open_id / chat_id，不阻断对话。
- 不用手工填写的显示名做权限判断、审批归属、小黑屋主键或审计主键。

## 群聊启用开关

飞书群聊必须是显式 opt-in，不应随飞书私聊接入自动开启。

原因：

- 群聊噪声和误触发风险明显高于私聊。
- 群聊涉及配对、超级管理员、小黑屋和审批策略，用户需要先理解边界。
- 很多用户只想用飞书私聊机器人，不希望 bot 加入群后自动记录 route 或回复。

### 开关层级

开关是渠道实例级能力开关，而不是单个群 route 的权限策略。

```text
飞书渠道实例 enabled=true
  direct: 默认开启
  group: 默认关闭，用户显式开启
```

开启 group 后，单个群仍然必须走：

```text
群 route 发现 -> 配对 -> 设置/确认超级管理员 -> @bot 触发 -> 小黑屋/审批策略
```

因此“开启群聊”只表示这个飞书机器人开始接受 group conversation；不表示任何群自动可信，也不表示群成员自动拥有审批或管理权限。

### 有效能力

运行时有效能力应按交集计算：

```text
effectiveCapabilities.group =
  adapterCapabilities.group === true
  && channelInstance.capabilityOverrides.group === true
```

在群聊功能实现并验证前，adapter 仍然可以声明 `group: false`。实现完成后，adapter 可声明 `group: true`，但新建和历史飞书渠道实例的 `capabilityOverrides.group` 默认仍是 `false`。

### 默认值

建议默认：

```text
新建飞书机器人: group off
既有飞书机器人升级: group off
用户显式开启后: group on
用户关闭后: 保留已有 group route/trust/group-access/session 绑定，但暂停接收群消息
```

关闭群聊不删除任何状态，只是不再处理 group 入站消息。重新开启后，已配对和已绑定的群 route 可以继续使用。

### 关闭时的行为

当 `group` 开关关闭时：

- Feishu adapter 或 ChannelRegistry 应拒绝/忽略 `chat_type=group` 消息。
- 不创建新的 group route。
- 不生成配对码。
- 不回复飞书群，避免群内刷屏。
- 本机日志记录一次节流后的提示，例如 `feishu group message skipped: group disabled`。

如果关闭前已经存在 group route，TUI 可以继续展示它们，但必须标记“群聊接收已关闭”。

### 状态字段

建议复用多渠道设计里的 capability override 概念，在渠道实例上保存：

```ts
interface ChannelInstanceRecord {
  id: string;
  type: string;
  enabled: boolean;
  capabilityOverrides?: {
    group?: boolean;
    thread?: boolean;
  };
}
```

第一版只需要 `group`。`thread` 继续预留，不开放。

### CLI/TUI 操作

命令式入口：

```bash
chat-codex channel capability set <channelId> group on
chat-codex channel capability set <channelId> group off
```

飞书私聊内命令入口：

```text
/group on
/group off
```

实现时同时兼容用户误拼：

```text
/grop on
/grop off
```

私聊命令规则：

- 只在飞书 `direct` route 中生效。
- 当前私聊 route 必须已完成配对信任；未配对私聊仍然先走 `/pair`。
- 不要求绑定 Codex session，因为这是渠道管理命令，不是 Codex 对话命令。
- 操作当前私聊所属的 `channelId/accountId`，也就是同一个飞书机器人实例的群聊接收开关。
- 命令被中间件消费，不转发给 Codex。
- `/group on` 只开启“接收群聊消息并进入群聊配对流程”，不自动信任任何群。
- `/group off` 只暂停群聊接收，不删除已有群 route、配对、超级管理员、小黑屋或 session 绑定。
- `/grop on|off` 与 `/group on|off` 完全等价，只作为隐藏兼容别名，不在 `/help` 中展示。
- 这条命令依赖私聊 route 已配对这一事实获得管理权限；不需要再额外做群权限判断。

TUI 入口：

```text
飞书渠道详情
  群聊接收: 关闭
  操作:
    开启群聊接收
```

开启时必须二次确认：

```text
开启后，飞书群聊 @机器人 会进入 Chat-Codex 配对流程。
每个群仍需单独配对；配对成功者会成为该群超级管理员。
```

关闭时必须说明：

```text
关闭后，Chat-Codex 将忽略飞书群聊消息。
已有群 route、配对、超级管理员、小黑屋和 session 绑定会保留。
```

## 现状结论

飞书入站事件可稳定拿到：

- `message.chat_id`
- `message.chat_type`
- `message.message_id`
- `sender.sender_id.open_id`
- `sender.sender_type`
- `message.mentions[]`

### open_id 语义

飞书用户身份里需要区分两类 ID：

- `chat_id`：聊天会话 ID。私聊、群聊、不同群聊都会不同。
- `sender_id.open_id`：发送者用户 ID。它表示同一个飞书应用视角下的用户，不是某个群聊里的临时 ID。

因此在同一个飞书应用、同一个账号配置下：

```text
同一用户在私聊里发消息      -> sender_id.open_id = ou_xxx
同一用户在群 A 里发消息     -> sender_id.open_id = ou_xxx
同一用户在群 B 里发消息     -> sender_id.open_id = ou_xxx

私聊 chat_id                -> oc_a
群 A chat_id                -> oc_group_a
群 B chat_id                -> oc_group_b
```

也就是说，`open_id` 不应该按“私聊一个、群聊一个、不同群不同”理解；变化的是 `chat_id`，不是用户 `open_id`。

边界：

- 不同飞书应用下，同一自然人的 `open_id` 不能假设相同。
- 不同 `channelId/accountId` 下，不要直接把 open_id 当作全局唯一用户。
- 本项目权限和小黑屋应使用组合边界：`routeKey + senderId`。其中 `senderId` 优先取 `sender_id.open_id`。
- 如果未来要做跨群、跨 route 的全局黑名单，应至少按 `channelId + accountId + senderId` 做作用域，不要只存裸 open_id。

发言人名称不是当前 adapter 直接映射的字段，但可以 best-effort 获取：

- 参考 `openclaw-lark` 的 `resolveSenderInfo()` 和 `user-name-cache.ts`。
- 当前实现不再主动调用飞书通讯录接口补齐名称。
- 群聊优先使用事件自带名称和手工成员名册。
- 缺少名称时回退到 open_id；普通群聊任务可先提示用户设置 `/name`。

具体名称展示和运行日志兜底格式见 [飞书名称展示与群聊名册设计](feishu-user-name-cache-design.zh-CN.md)。私聊不主动解析名称，也不读取私聊事件名称字段；群聊按 `chat_id` 保存 `open_id -> displayName`，用于运行日志和 Codex 发言人前缀。这个名册只服务群聊展示，不替代权限主键。

### 群聊手工成员名册

私聊不做名称标注。私聊继续按 `open_id` / `chat_id` 兜底展示，也不要求用户先执行 `/name` 才能对话。

群聊不同：一个群 route 由多人共享同一个 Codex session，发言人名称直接影响上下文可读性。因此群聊允许维护群内手工成员名册。

建议命令：

```text
@Bot /name 小黄
@Bot /name
```

语义：

- `@Bot /name 小黄`：把当前群 `chat_id` 下当前发送者的 `open_id` 标注为“小黄”。
- `@Bot /name`：查看当前发送者在本群的名称标注，以及真实主键 `open_id` 的后几位。
- 名称只在当前群生效，不自动写入私聊名称，不自动扩散到其它群。
- 如果同一个人同时在群 A 和群 B 使用机器人，两个群可以保存不同展示名。
- 后续如果要复用全局名称来源，只能作为填充建议，不能静默覆盖群名册。

群聊普通消息的处理规则：

- 如果飞书事件或群名册可以解析出名称，普通 @Bot 消息正常进入 Codex。
- 如果解析不到名称，且消息不是 `/name` 或 `/help`，第一版建议阻断这条消息，并回复原消息提示：

```text
我现在无法识别你的群内名称。请先发送：
@Bot /name 小黄
设置后再继续对话。
```

- `/help` 仍允许所有未拉黑成员触发，帮助里应展示 `/name <名称>`。
- `/name` 只允许设置当前发送者自己的名称；不能通过聊天命令给别人改名。
- 超级管理员、TUI 或后续管理命令可以新增“给成员改展示名”的能力，但权限判断仍然按 `open_id`。

### 群聊专属帮助、成员登记与 `/name` 边界

`/name` 是飞书群聊独有命令，不进入微信、终端、飞书私聊或其它渠道的普通帮助列表。它同时承担“群成员身份登记”的职责：群 route 完成信任配对后，普通群成员仍需要先通过 @Bot `/name <名称>` 登记自己的群内展示名，才能触发普通 Codex 消息投递。

术语边界：

- 群 route 配对：`@Bot /pair <code>`，让这个飞书群被 Chat-Codex 信任，并绑定/创建 session。
- 群成员登记：`@Bot /name <名称>`，让当前 `open_id` 在当前 `chat_id` 下拥有展示名。
- 这两者互不替代。群成员登记不能绕过群 route 配对；群 route 配对成功也不代表所有群成员都已登记。

帮助展示规则：

- 普通 `/help` 继续作为 Bridge 的统一命令入口。
- 当 `message.channelId` 是飞书/Lark，且 `conversation.kind="group"` 时，`/help` 增加或切换到“飞书群聊命令”段落。
- 飞书群聊帮助中必须展示：
  - `/name <名称>`：设置自己在当前群的展示名。
  - `/name`：查看自己在当前群的展示名状态。
  - `/whoami` 或后续等价命令：查看当前群员身份信息，包含 `open_id` 尾号、群内展示名、当前群 `chat_id` 和是否已完成成员登记。
  - 后续权限层完成后再展示群聊审批或管理命令。
- 飞书私聊 `/help` 不展示 `/name`。飞书私聊只展示渠道级 `/group on`、`/group off`。
- 微信 `/help` 不展示 `/name`，也不展示飞书群聊命令。

命令触发规则：

- 飞书群聊里所有 Chat-Codex 命令都必须 @Bot 才能触发，包括 `/help`、`/name`、`/pair`、`/OK`、`/NO` 和后续 `/group ...` 管理命令。
- 未 @Bot 的命令文本不进入 Bridge，不创建 route，不触发配对，不写名册，不下载附件，不回复群；Feishu adapter 入站前静默忽略。
- @Bot `/help` 不要求已有名册名称。
- @Bot `/name <名称>` 不要求已有名册名称。
- @Bot `/name` 不要求已有名册名称。
- @Bot `/whoami` 不要求已有名册名称，用于查看当前群员身份状态。
- `/name` 不授予权限，也不改变 route 信任状态。
- 普通 Codex 消息要求群 route 已配对且当前群成员已登记；未登记时回复登记提示，不投递 Codex。

实现边界：

- Feishu adapter 只负责把群消息、mentions、`chat_id`、`open_id` 映射成 `ChannelMessage` 和 metadata。
- `/help`、`/name` 都在 Bridge 层处理，不在 Feishu adapter 里直接消费命令。
- Bridge 通过 `channelId + conversation.kind` 判断是否启用飞书群聊专属帮助和 `/name`。
- 这符合当前“中间件和渠道隔离”的架构：渠道只负责收发和协议映射，命令和业务语义归 Bridge。

配对前安全命令：

当前 Bridge 的 route trust gate 在命令分发前执行。为了支持“群成员先设置名称，但不能绕过配对”，飞书群聊需要一个极小的 pre-trust allowlist：

- 允许 @Bot `/help` 在未配对群里返回飞书群聊帮助和配对说明。
- 允许 @Bot `/name <名称>` 在未配对群里写入当前群 `members.json`。
- 允许 @Bot `/name` 在未配对群里查看当前发送者的名册状态。
- 允许 @Bot `/whoami` 在未配对群里查看当前发送者的 `open_id` 和名册状态。
- 允许 @Bot `/pair <code>` 完成群 route 配对。
- 未 @Bot 的 `/help`、`/name`、`/whoami`、`/pair` 全部无效并静默忽略。
- 除上述带 @Bot 的命令外，未配对群里的任何命令或普通消息仍走配对拦截，不创建/切换 session，不投递 Codex。

这个 allowlist 只对飞书群聊生效，不影响飞书私聊、微信或其它渠道。

名称校验：

- 去掉首尾空白。
- 第一版建议限制 1 到 24 个 Unicode 字符。
- 不允许纯空白、不允许换行。
- 不建议允许看起来像系统身份的名称，例如 `Codex`、`机器人`、`管理员`；如果不做保留词，也必须在日志里同时保留 `open_id`。
- 手工名称可以修改，修改后记录 `updatedAt` 和 `source="manual"`。

## 日志与发言人展示

运行期终端日志和 Runtime TUI 必须能直接看出消息来自私聊还是群聊，以及是谁发的。

建议展示语义：

```text
飞书 <= 私聊:小黄 | 小黄
飞书 <= 群聊:研发群 | 小黄
飞书 <= 群聊:oc_group_xxx | ou_xxx
```

规则：

- `conversation.kind="direct"` 展示为“私聊”。
- `conversation.kind="group"` 展示为“群聊”。
- `conversation.displayName` 优先展示群名；私聊可直接回退 `chat_id`。
- `sender.displayName` 只用于群聊发言人展示，拿不到时回退 `sender.id/open_id`；私聊不主动维护发言人名称。
- verbose/debug 日志继续保留完整 `routeKey`、`chat_id`、`senderId` 和 `message_id`，方便排障。
- 安全日志、配对日志、审批日志和小黑屋命中日志都必须记录 `routeKey + senderId`，显示名只作为辅助展示。

私聊不需要把发言人名称注入给 Codex。私聊 route 天然代表一个人，日志里能看出身份即可。

群聊必须把发言人身份注入给 Codex。因为一个群 route 共享一个 session，不带发言人会导致上下文里多个人的消息混在一起。

推荐投递给 Codex 的群聊文本格式：

```text
小黄说：这里是内容XXXXX
```

如果 Codex 当前正在处理同一个群 route，新消息通过 steer 进入当前 turn 时，使用“补充”语义：

```text
小黄补充：这里是内容XXXXX
```

如果没有显示名：

```text
ou_xxx说：这里是内容XXXXX
```

第一版只实现这两个轻量前缀语义：

- 空闲时进入新 Codex turn：`发言人说：内容`
- 同一群 route 正在处理时通过 steer 进入当前 turn：`发言人补充：内容`

附件和文件不单独引入“发来文件并说”“补充图片并说”等新话术。附件来源可以在附件说明里标注；正文前缀仍保持“说/补充”两种，避免 prompt 规则过多。

私聊不改变现有投递语义：私聊普通文本继续按原文投递给 Codex，不增加 `小黄说：`，也不新增其它引导前缀。

这层前缀应在 Bridge 进入 Codex 前统一处理，不应写回 `ChannelMessage.text` 原始值，避免影响命令解析、审计和 route trust gate。

## 核心路由语义

飞书群聊 route：

```text
feishu:<accountId>:group:<chat_id>
```

规则：

- `chat_id` 是群聊 route 的稳定会话边界。
- `sender.open_id` 不进入 routeKey，只用于权限判断、审计、审批来源和 Codex prompt 前缀。
- 一个群聊默认绑定一个 active session。
- 群里不同成员 @bot 时，共享同一个 Codex 上下文。

旧版草案曾考虑使用方括号格式：

```text
[张三] 帮我看一下这个报错
```

最终建议使用“`发言人说：内容`”格式。这个格式更接近自然对话，也能避免 Codex 把 `[张三]` 误读成标签、引用或文件标记。

## 群聊附件与发文件控制

群聊共享 route/session 后，附件和文件也应符合群协作语义：群成员可以共同处理同一批上下文，但中间件必须限制队列大小并清楚标注来源。

### 入站附件归属

当前私聊 pending media 以 route 作为归属边界。飞书群聊第一版也继续按群 `routeKey` 共享 pending 附件池，不按 sender 强隔离。

原因：

```text
小黄: [发一张图片]
李四: @Bot 解释一下
```

这在群聊里是合理协作：小黄发图，李四可以指挥 Codex 分析。谁在群里补充、是否会打断当前任务，是群成员自己的协作规则，中间件不在第一版做过度判断。

群聊规则：

- 群聊 pending 附件按 `routeKey` 共享。
- pending 附件必须记录来源：`senderId`、`senderDisplayName`、`messageId`、`createdAt`、附件序号。
- 任意未被拉黑成员后续 @bot 说明时，可以消费当前群 route 的 pending 附件。
- pending 附件提示必须明确这是“群聊共享待处理附件”，例如“已收到群聊待处理附件 3 个，请 @Bot 说明要怎么处理；下一条说明会和这些附件一起交给 Codex。”
- 群聊 pending 附件沿用当前上限，最多保留 5 个；超过后拒绝新增并提示先说明或 `/cancel`。
- pending 附件默认 10 分钟过期。
- 小黑屋命中时，不保存该 sender 的新附件，也不消费已有附件。

### 普通群聊附件投递

群聊里带文字和附件同消息进入 Codex 时，输入文本应包含发言人前缀。第一版不区分图片、文件、普通文本的前缀话术，只按当前 route 是否正在处理选择“说”或“补充”：

```text
小黄说：检查这个 UI 问题
小黄说：总结这个日志
小黄补充：这个截图也一起看
小黄补充：这里还有一份日志
```

如果群成员先发附件、后续任意成员 @bot 补文字，则合并后的 Codex 输入应同时标注附件来源和指令发起人：

```text
群聊待处理附件：
- 小黄发来的图片 1: /path/a.png
- 李四发来的文件 2: /path/b.log

王五说：帮忙分析这些附件
```

如果 Codex 正在运行，同样可以通过现有 steer 机制投递，但文案使用“补充”：

```text
王五补充：帮忙分析这些附件
```

实现不需要在第一版做复杂选择器；超过 pending 上限时拒绝新增附件即可。

不做的优化：

- 不按 sender 隔离群聊 pending 附件。
- 不增加多人任务锁。
- 不改变私聊原文投递方式。
- 不把现有通用批量 steer 标签扩展成私聊新文案；本批次只关心群聊进入 Codex 前的发言人前缀。

### 入站文件与图片的差异

入站图片和普通文件都进入 `ChannelMessage.attachments`，但交给 Codex 的方式不同：

- 图片使用 `localImage`，通过 app-server 的结构化图片输入交给 Codex。
- 普通文件使用中间件内部 `localFile` 表示，但投递给 Codex 前必须转换成文本路径引用，因为官方 app-server 当前没有通用 file input。这与 Codex 官方 TUI/CLI 对普通文件的语义一致：普通文件不是二进制附件，最终是本地路径文本。

普通文件投递给 Codex 时等价于：

```text
用户上传了文件：
- report.pdf: /absolute/path/report.pdf

请根据用户要求读取这个文件。
```

因此“文件能投递”，但不是图片那种原生视觉输入；Codex 是否能读取文件还取决于当前 session 权限、沙箱和路径可访问性。Chat-Codex 负责先把群聊/私聊入站文件保存到 `~/.chat-codex/uploads/`，再把保存后的绝对路径写入 prompt；不把普通文件内容直接粘贴进 prompt，也不伪造官方不存在的普通文件附件类型。

### `/sendfile` 与出站文件

`/sendfile` 会让 Codex 最终把本机文件发送到聊天渠道。群聊场景下它比普通文本更敏感，第一版必须保守。

建议第一版策略：

- 私聊 `/sendfile` 保持现有行为。
- 群聊 `/sendfile` 默认只允许超级管理员使用。
- 非超级管理员在群里发送 `/sendfile` 时直接拒绝，不转发给 Codex。
- 如果未来开放给所有未拉黑成员，必须单独有 `group:send_file` 权限项，不应跟普通任务权限混在一起。
- 所有群聊出站文件都要记录审计：`routeKey`、`senderId`、显示名、sessionId、文件路径、文件名、发送结果。
- 群聊出站文件建议优先 reply 原消息，失败再 fallback 到群 `chat_id` create，和文本回复一致。

验收要求：

- A 在群里发图，B 再 @bot 发文字，B 可以消费群共享 pending 附件。
- pending 附件超过 5 个时拒绝新增并提示先说明或 `/cancel`。
- 空闲群聊消息进入 Codex 时使用 `小黄说：...`。
- 运行中群聊消息 steer 时使用 `小黄补充：...`。
- 普通文件以 `localFile` 文本路径说明交给 Codex，不当成 `localImage`。
- 群聊 `/sendfile` 非超级管理员默认被拒绝。
- 群聊出站文件审计能看出是谁触发、发到了哪个群、发送了哪个文件。

## 触发策略

默认策略必须保守：

```text
群聊消息 = 必须 @bot + 发言人未被拉黑 + 群 route 已配对
```

处理顺序：

1. 解析飞书事件，识别 `chat_type=group`。
2. mention gate 检查是否 @bot。未 @Bot 直接在 Feishu adapter 入站前静默忽略，不进入 Bridge，不下载附件，不创建 route，不触发配对。
3. 生成 `feishu:<accountId>:group:<chat_id>` routeKey。
4. 记录 route 元数据和最后发言人。
5. trust gate 检查群 route 是否已配对。
6. group access gate 检查发言人是否在小黑屋。
7. command gate 检查是否 `/help`、权限命令或审批命令。
8. 普通 @bot 文本进入当前群 route 的 Codex 队列。

未 @Bot 的任何群消息默认忽略，不回复，避免群内刷屏。`/help` 是唯一允许所有群成员触发的非敏感命令，但仍然必须 @Bot；其他具体命令只有满足对应权限的人 @Bot 发出时才执行或回复。

## 配对模型

一个群聊只配对一次。配对成功后信任整个群 route，但不代表群内所有人都拥有管理权限。

首次未配对群聊 @bot 时：

- 群里回复简短引导，不包含配对码。
- 本机 TUI/终端显示配对码、群 chat_id、发起人 open_id/名称。
- 群内任意用户发送正确 `/pair <code>` 可以完成 route 配对。

配对成功后：

- 当前群 route 写入 `trusted-routes.json`。
- 发送配对码的人自动成为该群 route 的唯一超级管理员。
- 如果 sender 名称可解析，记录 `trustedBySenderDisplayName`。
- 后续更换超级管理员只能通过本机 TUI 或超级管理员命令显式完成，不能因为其他人再次发送 `/pair` 覆盖。

这比“信任整个群等于所有人都是管理员”更安全，也不会把第一次落地做得过重。

### 配对码与 TUI 边界

配对码是运行期内存挑战，不是启动前配置项。

启动前 TUI：

- 不能监听飞书群消息。
- 不能发现从未发过消息的新群。
- 不能生成或展示新的 `/pair <code>`。
- 只能展示已经落盘的 route：已配对、待配对、已绑定 session、最近活跃时间。
- 可以对已发现 route 做“本机手动信任”，但这不是配对码流程。

运行期 TUI/终端日志：

- 服务启动后，群里第一次 @bot 或发送 `/pair` 相关消息，Bridge 才能发现 route。
- trust gate 发现未配对群 route 后，生成一次性配对码。
- 本机运行期 TUI/终端日志显示完整命令，例如 `/pair 7K4P-92`。
- 飞书群里只回复“不含配对码”的引导。
- 配对码过期或进程重启后失效，需要由运行期重新生成。

因此，TUI 可以查看“待配对 route”，但启动前不能查看“配对命令”。如果用户想通过配对码完成信任，必须先启动服务，让飞书群里 @bot 触发运行期配对流程。

### 本机手动信任

TUI 可以提供本机手动信任作为兜底能力，适合用户确认某个已发现群 route 可以被信任，但不想走群里 `/pair`。

手动信任规则：

- 只对已经出现在 `routes.json` 的 route 生效。
- `trustMethod` 写为 `manual`。
- 群 route 手动信任后必须处理超级管理员：
  - 如果 route 有 `lastSenderId`，TUI 应提示是否把最近发言人设为超级管理员。
  - 如果没有可用 senderId，允许先信任，但显示 `无超级管理员` 警告。
  - 没有超级管理员时，默认审批会阻塞；用户必须在 TUI 里设置超级管理员，或切换为开放审批。
- 手动信任必须二次确认，文案明确“这会允许该群 route 使用 Chat-Codex”。

## 权限角色

### 本机操作者

本机 TUI/配置永远是最高权限来源。它可以：

- 查看所有群 route。
- 解除群 route 信任。
- 设置、清空或转移超级管理员。
- 查看预留管理员角色配置。
- 添加/移除小黑屋用户。
- 切换审批策略：仅超级管理员审批，或开放给所有未拉黑成员审批。
- 修改群 route 绑定的 Codex session。

这是兜底能力，避免群内管理员配置错误后无法恢复。

### 超级管理员

超级管理员是群 route 内唯一启用的权限管理员。默认由完成配对的人获得。

允许：

- 拉黑用户。
- 解除拉黑。
- 查看群权限摘要。
- 审批或拒绝 Codex permission request。
- 切换审批策略。
- 后续可以转移超级管理员身份，第一版可先只在本机 TUI 做。

不建议第一版允许超级管理员在群内切换 session 或解除 route 信任。这类操作风险高，先留给本机 TUI。

### 管理员

管理员角色第一版只保留设计，不进入实际权限判断。也就是说，第一版没有“管理员可以审批、普通成员不可以”的中间态；默认只有超级管理员可以审批。

后续可以把管理员做成可配置权限包，例如：

- `canApprove`: 能否审批。
- `canBlock`: 能否拉黑/解除拉黑。
- `canManageAdmins`: 能否管理管理员。
- `canViewAudit`: 能否查看审计。

第一版暂不实现这些权限项，避免把 MVP 做成完整 RBAC。

这保留了“超级管理员、管理员、普通成员”的角色设计空间，但当前实际落地只启用超级管理员。

### 普通成员

普通成员允许：

- 在群 route 已配对后，通过 @bot 发起普通 Codex 请求。
- 发送 `/help` 查看群聊可用命令。

普通成员不允许：

- 审批高风险动作。
- 修改权限。
- 绕过 @bot 触发。
- 触发 `/status`、`/permission`、`/group` 等具体管理命令。
- 触发 `/OK`、`/NO` 等审批命令；只有该群打开开放审批策略时，普通成员才可以审批。

### 小黑屋用户

小黑屋是按群 route 生效的 blocked sender 列表。

小黑屋存储的是飞书发言人的稳定 sender ID，优先使用 `sender.sender_id.open_id`，也就是 `ou_xxx`。显示名只用于展示和辅助识别，不能作为权限主键。

被拉黑用户：

- @bot 普通消息不进入 Codex。
- 权限命令无效。
- 审批命令无效。
- 即使群聊打开开放审批策略，也不能审批。
- 默认静默忽略，不在群里公开提示“你被拉黑”。

本机日志/TUI 记录被忽略原因，方便排障。

拦截位置由中间件负责，不依赖飞书平台本身：

```text
FeishuAdapter 映射 ChannelMessage
  -> Bridge 记录 route/sender 元数据
  -> trust gate
  -> group access gate 检查 blockedSenders
  -> command router / approval command / Codex queue
```

也就是说，小黑屋不是飞书群成员管理，不会把用户从飞书群里移除；它只阻止该 sender 通过 Chat-Codex 触发任务、命令或审批。

## 第一版推荐策略

MVP 推荐启用以下策略：

```text
normalMessagePolicy = "mentioned_non_blocked"
approvalPolicy = "super_admin_only" | "any_non_blocked"
managementPolicy = "super_admin_only"
blockedUserBehavior = "silent"
```

含义：

- 普通任务：任何未拉黑成员 @bot 都可以发起。
- 默认审批：只有唯一超级管理员可以处理。
- 开放审批：超级管理员显式打开后，任何未拉黑成员都可以审批。
- 权限管理：只有超级管理员可以处理。
- 小黑屋命中：静默忽略。

开放审批只解除 approval 的人员限制，不解除 @bot 触发、小黑屋、配对信任和管理命令限制。也就是说，“谁都可以审批”只表示谁都可以对当前群 route 的 pending approval 发送 `/OK <id>` 或 `/NO <id>`，不表示谁都可以改群权限。

## 权限体系模块设计

群权限体系应作为独立领域模块设计，而不是写成飞书 adapter 的分支逻辑。原因：

- Feishu adapter 只应负责飞书协议映射、收发和平台 API。
- Bridge 只负责消息流转和命令分发，不应散落具体角色判断。
- TUI、聊天命令和后续配置文件都需要复用同一套权限判定。

### 角色模型

第一版实际启用：

```text
super_admin
member
blocked
```

设计预留：

```text
admin
custom_role
```

语义：

- `super_admin`：一个群 route 只能有一个。负责管理小黑屋、审批策略和默认审批。
- `member`：普通群成员，不需要显式保存；只要不在小黑屋，就是普通成员。
- `blocked`：小黑屋成员，按群 route 生效。
- `admin`：预留角色，第一版不参与判断。
- `custom_role`：后续 TUI 可配置的自定义角色，第一版不实现。

### 能力模型

权限判断不应直接判断“是不是管理员”，而应判断“是否拥有某个 capability”。这样后续 TUI 做角色配置时，不需要重写命令和审批逻辑。

建议 capability：

```ts
type GroupCapability =
  | "group:help"
  | "group:send_task"
  | "group:approve"
  | "group:block_user"
  | "group:unblock_user"
  | "group:set_approval_policy"
  | "group:view_policy"
  | "group:transfer_super_admin"
  | "group:manage_roles"
  | "group:view_audit";
```

第一版默认映射：

| Capability | super_admin | member | blocked |
| --- | --- | --- | --- |
| `group:help` | yes | yes | no |
| `group:send_task` | yes | yes | no |
| `group:approve` | yes | no, unless `approvalPolicy=any_non_blocked` | no |
| `group:block_user` | yes | no | no |
| `group:unblock_user` | yes | no | no |
| `group:set_approval_policy` | yes | no | no |
| `group:view_policy` | yes | no | no |
| `group:transfer_super_admin` | TUI only in phase 1 | no | no |
| `group:manage_roles` | reserved | no | no |
| `group:view_audit` | reserved | no | no |

开放审批模式只影响 `group:approve`：

```text
approvalPolicy=any_non_blocked
  => member 获得 group:approve
  => blocked 仍然没有 group:approve
  => 不授予 group:block_user / group:set_approval_policy / group:manage_roles
```

### 权限判定输入

所有群权限判断统一使用通用上下文：

```ts
interface GroupAccessContext {
  routeKey: string;
  channelId: string;
  accountId: string;
  conversationId: string;
  senderId: string;
  senderDisplayName?: string;
  command?: string;
}
```

Feishu 特有的 mentions、open_id、chat_id 应该在 adapter 或 command parser 边界转换成通用字段。`group-access` 模块不依赖飞书 SDK，也不读取飞书原始 event。

### 权限判定输出

权限模块只返回判定，不直接发消息：

```ts
type GroupAccessDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "group_not_trusted"
        | "sender_blocked"
        | "missing_super_admin"
        | "capability_denied"
        | "approval_policy_denied";
      silent?: boolean;
    };
```

Bridge 根据 `silent` 决定是否回复。小黑屋默认 `silent=true`。

## 命令草案

群聊命令需要和现有聊天命令风格保持一致。第一版可以先提供中文帮助，但命令本身保持英文，方便跨渠道一致。

本节是完整命令设计草案，不代表当前开发批次全部实现。当前开发批次只要求 `/help`、群聊 `/name <名称>`、群聊审批 `/OK <id>` / `/NO <id>` 能按权限工作；`/group ...` 管理命令放到后续“群权限管理交互”批次。

例外：飞书私聊里的 `/group on`、`/group off` 属于渠道级群聊接收开关，纳入当前开发批次。它不是群 route 权限管理命令。实现时同时接受 `/grop on`、`/grop off` 作为误拼兼容别名，但 `/help` 只展示正式命令。

飞书私聊已配对用户可用：

```text
/group on
/group off
```

隐藏兼容别名：

```text
/grop on
/grop off
```

飞书群聊普通成员可见：

```text
@Bot /help
@Bot /name 小黄
@Bot /name
@Bot /whoami
```

这些命令只在飞书群聊 `conversation.kind="group"` 下展示和执行。飞书私聊、微信和其它渠道的 `/help` 不展示 `/name`。

`/name` 说明：

- 群聊里仍然需要 @Bot 触发，例如 `@Bot /name 小黄`。
- `/name <名称>` 只设置当前发送者在当前 `chat_id` 下的展示名。
- `/name` 展示当前发送者在当前群的名称状态。
- 该命令不授予任何权限，不影响超级管理员、小黑屋和审批人判定。
- 如果用户在未配对群里先发 `/name`，可以先写入名册，但不能绕过群 route 配对；后续仍要完成配对才能使用 Codex。
- `/name` 的命令处理位于 Bridge 层；Feishu adapter 不直接处理该命令。

`/whoami` 说明：

- 群聊里仍然需要 @Bot 触发，例如 `@Bot /whoami`。
- 用于查看当前发送者在当前群的身份信息。
- 第一版输出建议包含：当前群 `chat_id`、当前发送者 `open_id` 的安全展示、群内展示名、是否已完成群成员登记、当前 route 是否已配对。
- `/whoami` 不授予权限，不写入名册，不触发 Codex 投递。

超级管理员最终可用：

```text
/OK <id>
/NO <id>
/group admins
/group block @用户
/group unblock @用户
/group blocked
/group approval restricted
/group approval open
```

说明：

- `/group approval restricted`：默认模式，只允许超级管理员审批。
- `/group approval open`：开放审批，允许任何未拉黑成员审批。
- `/OK` 和 `/NO` 沿用现有 Chat-Codex 审批命令；群聊里推荐必须带审批 id。
- `/approve <id>` 和 `/deny <id>` 可以作为兼容别名，但用户文案优先展示 `/OK <id>` 和 `/NO <id>`。

管理员角色的命令先不开放。后续如果启用管理员，可以再增加：

```text
/group admin add @用户
/group admin remove @用户
/group admin role @用户 approve|block|audit
```

实现时不要依赖显示名作为唯一身份。命令里出现 `@用户` 时，应从飞书 mentions 解析 open_id；如果用户手动输入 open_id，也允许使用。

## 审批规则

群聊审批必须记录审批人：

```text
approvalId
routeKey
requestedBySenderId
approvedBySenderId
approvedBySenderDisplayName?
approvedAt
```

校验规则：

- approval 必须属于当前群 route。
- 审批人不能在小黑屋。
- 默认 `approvalPolicy = "super_admin_only"` 时，审批人必须是当前群唯一超级管理员。
- `approvalPolicy = "any_non_blocked"` 时，任何未拉黑成员都可以审批。
- 普通成员在默认模式发送 `/OK`、`/NO` 或兼容别名时，不执行；建议第一版静默忽略，避免群里刷权限提示。

如果一个群没有超级管理员，所有 Codex approval 都必须阻塞，并提示用户去本机 TUI 配置超级管理员。

### 审批并发与锁

群聊开放审批后，可能出现多人同时发送 `/OK <id>` 或 `/NO <id>`。这里必须做细粒度锁，避免同一个 Codex approval 被多次回写。

规则：

- 每个 pending approval 必须有短 id，也就是现有 `approvalKey`。
- 群聊审批通知必须展示 id，例如 `审批 ID: A17K`。
- 群聊里优先要求 `/OK <id>`、`/NO <id>`。如果用户只发 `/OK`：
  - 当前 route 只有一个 pending approval 时，可以兼容处理。
  - 当前 route 有多个 pending approval 时，必须拒绝并提示用户带 id。
- 锁粒度以 `approvalKey` 为主：同一个 approval 同一时间只能有一个决策进入 Codex adapter。
- 状态流转必须是原子性的：`pending -> approved|denied|expired|cancelled` 只能成功一次。
- 第一个成功获得锁并完成状态流转的命令生效。
- 后到的 `/OK <id>` 或 `/NO <id>` 发现状态已不是 `pending` 时，直接拒绝，不再调用 Codex。
- 拒绝文案可以是“审批 A17K 已处理”，并可附带处理人和处理时间；如果担心刷屏，也可以对重复处理静默。

这意味着开放审批不会导致“多人一起 /OK 把同一审批炸掉”。最坏情况是多人同时尝试，只有第一个决策生效，后续命令读到已处理状态。

实现上建议：

- `ApprovalManager.decide()` 增加处理人信息和 compare-and-set 语义。
- 单进程内维护 `Map<approvalKey, Promise>` 或轻量 mutex。
- 现有运行期单实例锁必须继续保证同一个 state 目录只启动一个 Chat-Codex 服务，避免跨进程重复消费审批。
- 审批记录应保存 `decidedBySenderId`、`decidedBySenderDisplayName?`、`decidedAt`、`decision`。

## 状态持久化

现有 `trusted-routes.json` 继续记录 route 是否可信，以及由谁完成配对。

### 群聊成员名册

群聊手工名称属于飞书渠道私有状态，建议放在飞书账号目录下，不放进通用 `group-access.json`。这样权限文件只处理“谁能做什么”，飞书目录只处理“这个 open_id 在这个群里显示成什么名字”。

建议路径：

```text
~/.chat-codex/state/channels/feishu/<channelId>/accounts/<accountId>/groups/<chat_id>/members.json
```

其中 `<chat_id>` 需要经过文件名安全处理。飞书 `chat_id` 通常是 `oc_...`，直接作为目录名可读性最好；如果未来遇到不安全字符，使用同项目已有的路径清洗规则。

建议结构：

```json
{
  "schemaVersion": 1,
  "channelId": "feishu-main",
  "accountId": "default",
  "chatId": "oc_xxx",
  "updatedAt": "2026-05-20T00:00:00.000Z",
  "members": [
    {
      "openId": "ou_xxx",
      "displayName": "小黄",
      "source": "manual",
      "firstSeenAt": "2026-05-20T00:00:00.000Z",
      "lastSeenAt": "2026-05-20T00:00:00.000Z",
      "updatedAt": "2026-05-20T00:00:00.000Z"
    }
  ]
}
```

字段说明：

- `chatId`：飞书群聊 `message.chat_id`，决定这个名册只属于当前群。
- `openId`：飞书发送者 `sender.sender_id.open_id`，是名册主键。
- `displayName`：群内展示名，只用于日志、TUI、Codex 群聊前缀。
- `source`：第一版只需要 `manual`；后续可扩展 `api`、`member_api`、`tui`。
- `firstSeenAt` / `lastSeenAt`：用于 TUI 展示最近活跃成员。
- `updatedAt`：名称最近修改时间。

读取优先级：

1. 飞书事件自带 sender 名称。
2. 当前群 `groups/<chat_id>/members.json` 中的手工名称。
3. `open_id` 兜底。

写入规则：

- 群聊 `/name <名称>` 只写当前 `chat_id + open_id`。
- 群 route 已配对后，普通 Codex 消息要求当前 `chat_id + open_id` 已存在有效名册记录；否则回复登记提示，不投递 Codex。
- `/help`、`/name`、`/whoami` 不要求已登记，方便新成员完成登记和排障。
- 如果飞书 API 后续可以拿到名称，不自动覆盖 `source="manual"` 的手工名称，避免用户在群内使用约定昵称时被系统名覆盖。
- 如果手工名称为空或被清除，下一次消息重新按 API/cache/open_id 兜底。
- 名册不授予权限，不影响小黑屋，不影响审批人身份。

群权限建议独立文件，避免把普通 route 元数据写得过重：

```text
~/.chat-codex/state/bridge/group-access.json
```

建议结构：

```ts
interface GroupAccessDocument {
  schemaVersion: number;
  updatedAt: string;
  groups: GroupAccessRecord[];
}

interface GroupAccessRecord {
  routeKey: string;
  channelId: string;
  accountId: string;
  conversationKind: "group";
  conversationId: string;
  superAdmin?: GroupPrincipal;
  blockedSenders: GroupPrincipal[];
  knownPrincipals?: KnownGroupPrincipal[];
  normalMessagePolicy: "mentioned_non_blocked";
  approvalPolicy: "super_admin_only" | "any_non_blocked";
  managementPolicy: "super_admin_only";
  blockedUserBehavior: "silent";
  reservedRoles?: GroupRoleRecord[];
  createdAt: string;
  updatedAt: string;
}

interface GroupPrincipal {
  senderId: string;
  displayName?: string;
  source: "pairing" | "command" | "tui";
  createdBySenderId?: string;
  createdAt: string;
}

interface KnownGroupPrincipal {
  senderId: string;
  displayName?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  source: "message" | "pairing" | "tui";
}

interface GroupRoleRecord {
  roleId: string;
  label: string;
  members: GroupPrincipal[];
  capabilities: {
    canApprove?: boolean;
    canBlock?: boolean;
    canManageAdmins?: boolean;
    canViewAudit?: boolean;
  };
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

第一版权限判断只读取 `superAdmin`、`blockedSenders` 和 `approvalPolicy`。`knownPrincipals` 只服务 TUI 选择用户，不授予任何权限；`reservedRoles` 只是为管理员/角色权限预留，不参与权限判断。

`knownPrincipals` 建议限制数量，例如每个群保留最近 50 个 sender，按 `lastSeenAt` 淘汰，避免本地状态无限增长。

如果后续发现 route policy 已经足够承载，也可以把 `GroupAccessRecord` 收进 `RoutePolicyRecord`，但第一版独立文件更清晰，迁移风险更小。

## 代码结构设计

代码结构必须遵守项目开发规范：

- 渠道协议映射放在 `src/channels/feishu/`。
- 命令处理放在 `src/bridge/commands/`。
- 审批状态和审批锁放在 `src/approvals/`。
- 状态持久化放在 `src/state/`。
- 群权限领域逻辑单独放在 `src/group-access/`，供 Bridge、TUI 和测试复用。
- `/help` 文本继续由 Bridge 的状态/帮助渲染模块统一生成；飞书群聊只是在命中 `channelId + conversation.kind` 时追加群聊专属命令段。

### 目标目录

建议最终结构：

```text
src/channels/feishu/
  feishu-adapter.ts
  feishu-message.ts
  feishu-types.ts
  feishu-media.ts
  group/
    group-message.ts
    group-mentions.ts
    group-name-cache.ts
    group-member-registry.ts
    group-chat-info.ts
    group-types.ts

src/group-access/
  types.ts
  defaults.ts
  principal.ts
  capabilities.ts
  policy.ts
  service.ts
  formatters.ts

src/bridge/
  group-message-gate.ts
  commands/
    group-name-command.ts
    group-command.ts
    approval-command.ts
  status-text.ts

src/approvals/
  approval-manager.ts
  approval-locks.ts
  types.ts

src/state/
  persistent-state-types.ts
  file-state-store.ts
  memory-state-store.ts
```

测试建议：

```text
tests/group-access/
  group-access-policy.test.ts
  group-access-service.test.ts
  group-command.test.ts

tests/channels/feishu/
  feishu-group-message.test.ts
  feishu-mentions.test.ts

tests/bridge/
  feishu-group-flow.test.ts
  group-approval-lock.test.ts
```

### `src/channels/feishu/group/`

飞书群聊建议单独建子目录，避免继续把私聊、群聊、mentions、群名缓存和后续 thread/topic 能力都塞进 `feishu-message.ts`。

目录命名建议使用 `group/`，不使用 `group-chat/`，原因是：

- 路由语义已经叫 `conversation.kind = "group"`。
- 后续如果支持 topic/thread，可以在 `src/channels/feishu/thread/` 下继续平行扩展。
- `group/` 目录里仍然是 Feishu adapter 私有实现，不会和通用 `src/group-access/` 混淆。

这个目录只做飞书平台适配。

职责：

- `group-message.ts`
  - 把 `chat_type="group"` 的飞书事件映射成 `ChannelMessage`。
  - `conversation.kind = "group"`。
  - routeKey 使用 `feishu:<accountId>:group:<chat_id>`。
  - 把群聊 mentions 保留到 `raw` 或规范化 metadata，供命令解析使用。
- `group-mentions.ts`
  - 判断是否 @bot。
  - 从 mentions 中解析命令目标用户 open_id。
  - 剥离 bot mention，避免把 `@机器人` 原样送给 Codex。
- `group-name-cache.ts`
  - best-effort 解析 `sender.displayName` 和群名。
  - 不主动调用飞书通讯录接口。
  - 失败时回退 open_id/chat_id，不阻塞私聊；群聊普通任务按 `/name` 名册策略处理。
- `group-member-registry.ts`
  - 读写 `groups/<chat_id>/members.json`。
  - 提供 `getManualDisplayName(chatId, openId)`、`setManualDisplayName(chatId, openId, name)`、`touchMember(chatId, openId)`。
  - 只处理飞书群聊展示名，不处理权限、小黑屋或审批。
- `group-chat-info.ts`
  - 缓存群名、群类型、是否 topic/thread 群等信息。
  - 第一版只用于展示，不影响 routeKey。
- `group-types.ts`
  - Feishu 群聊内部类型，例如规范化 mention、群信息缓存结果。

禁止：

- 在 Feishu adapter 里判断谁是超级管理员。
- 在 Feishu adapter 里读写小黑屋。
- 在 Feishu adapter 里直接处理 `/group` 命令。
- 在 Feishu adapter 里直接处理 `/name` 或 `/help`。adapter 只把消息交给 Bridge。

### `src/bridge/commands/group-name-command.ts`

负责飞书群聊手工名册和身份查看命令。

职责：

- 只接受飞书/Lark 群聊消息。
- 处理 `/name <名称>`：校验名称，写入当前 `chat_id + sender.open_id` 的 `members.json`。
- 处理 `/name`：返回当前发送者在当前群的名称状态。
- 处理 `/whoami`：返回当前发送者的身份信息，包括安全展示后的 `open_id`、当前群 `chat_id`、群内展示名、登记状态和群 route 配对状态。
- 拒绝飞书私聊、微信和其它渠道调用；正常情况下这些渠道也不会在 `/help` 中看到该命令。
- 不修改 route 信任状态，不创建或切换 Codex session。
- 不参与权限判断；权限、小黑屋、审批仍按 `open_id` 和后续 `GroupAccessService` 判断。

### Bridge help 渲染

`BridgeStatusText.helpText(message)` 需要识别飞书群聊上下文：

- 非飞书群聊：保持现有帮助输出，不展示 `/name`。
- 飞书私聊：展示 `/group on`、`/group off`，不展示 `/name`。
- 飞书群聊：展示群聊专属段落，至少包含 `/name <名称>`、`/name` 和 `/whoami`。
- 群聊专属段落不要出现在微信帮助里，避免用户误以为微信支持群名册。

### `src/channels/feishu/feishu-message.ts`

`feishu-message.ts` 保持为 Feishu 入站映射入口，但不承载所有群聊细节。

建议职责：

- 判断 `message.chat_type`。
- `p2p` 继续走现有私聊映射。
- `group` 委托给 `group/group-message.ts`。
- 不支持的 chat type 返回明确 skip reason。

这样做可以让第一版改动集中，同时保留现有私聊逻辑的稳定性。

### `src/group-access/`

这是群权限领域模块，不依赖飞书 SDK。

职责：

- `types.ts`
  - `GroupAccessRecord`
  - `GroupPrincipal`
  - `GroupCapability`
  - `GroupAccessDecision`
  - `GroupApprovalPolicy`
  - `GroupRoleRecord`
- `defaults.ts`
  - 默认策略：`approvalPolicy="super_admin_only"`、`blockedUserBehavior="silent"`。
  - 配对成功后的默认 `superAdmin` 初始化。
- `principal.ts`
  - senderId 规范化。
  - `GroupPrincipal` 创建和显示名更新。
  - open_id 匹配使用精确匹配，不使用显示名作为主键。
- `capabilities.ts`
  - role/capability 矩阵。
  - `approvalPolicy=any_non_blocked` 对 `group:approve` 的覆盖规则。
- `policy.ts`
  - `canSendTask(ctx)`
  - `canUseCommand(ctx, command)`
  - `canApprove(ctx)`
  - `canManageGroup(ctx, capability)`
  - `isBlocked(routeKey, senderId)`
- `service.ts`
  - 封装读写 store 后的业务操作：
    - `ensureGroupAccessForTrustedRoute()`
    - `setSuperAdmin()`
    - `blockSender()`
    - `unblockSender()`
    - `setApprovalPolicy()`
    - `checkCapability()`
- `formatters.ts`
  - 群权限摘要。
  - 小黑屋列表。
  - 命令执行结果文案。

这个模块应以纯函数和小服务为主，便于单元测试。它不负责发送渠道消息，也不调用 Codex。

### `src/state/`

状态持久化仍归 `src/state` 管。

新增或扩展：

- `persistent-state-types.ts`
  - 增加 `GroupAccessDocument`、`GroupAccessRecord`、`GroupPrincipal`、`GroupRoleRecord`。
- `file-state-store.ts`
  - 读写 `~/.chat-codex/state/bridge/group-access.json`。
  - 提供 `getGroupAccess(routeKey)`、`upsertGroupAccess(record)`、`listGroupAccess()`。
- `memory-state-store.ts`
  - 提供同样接口，供测试使用。

`src/group-access/service.ts` 只依赖这些 store 接口，不直接操作文件路径。

### `src/bridge/group-message-gate.ts`

在 Bridge 消息流中插入群权限 gate。

位置：

```text
trust gate 之后
command router 之前或普通投递之前
```

职责：

- 对 group route 检查小黑屋。
- 对普通群消息检查是否 @bot。
- 对 `/help` 放行给所有未拉黑成员。
- 对管理命令调用 `group-access` capability 判断。
- 对普通 Codex prompt 调用 `group:send_task` 判断。
- 返回是否继续、是否静默、是否发送拒绝文案。

这层只做通用 group 判断，不写飞书 SDK 逻辑。

### `src/bridge/commands/group-command.ts`

负责 `/group ...` 命令。

群权限管理批次命令：

```text
/group block @用户
/group unblock @用户
/group blocked
/group approval restricted
/group approval open
```

预留但不启用：

```text
/group admin add @用户
/group admin remove @用户
/group admin role @用户 approve|block|audit
```

职责：

- 解析命令。
- 从 `ChannelMessage.raw` 或规范化 metadata 中读取 mentions。
- 把 `@用户` 解析成 senderId/open_id。
- 调用 `GroupAccessService`。
- 返回用户可见文案。

禁止：

- 直接改 JSON 文件。
- 直接调用飞书 API。
- 在命令里散写角色矩阵。

### `src/bridge/commands/approval-command.ts`

现有审批命令需要支持群权限。

调整方向：

- direct route 保持现有行为。
- group route 下先调用 `group-access` 检查 `group:approve`。
- group route 推荐要求 `/OK <approvalKey>`、`/NO <approvalKey>`。
- route 有多个 pending approval 且用户未带 id 时，必须拒绝并提示带 id。
- 决策成功后记录处理人。

开放审批只影响这里的 `group:approve` 判定，不影响 `/group` 命令权限。

### `src/approvals/`

审批并发锁放在审批模块，不放在群权限模块。

建议：

- `approval-locks.ts`
  - 提供 `withApprovalLock(approvalKey, fn)`。
  - 单进程内保证同一 `approvalKey` 只有一个决策流程。
- `approval-manager.ts`
  - `decide()` 增加处理人参数。
  - 状态流转使用 compare-and-set 语义。
  - 已处理 approval 再次 decide 时返回明确错误，不调用 Codex adapter。
- `types.ts`
  - `PendingApproval` 增加可选字段：
    - `decidedBySenderId`
    - `decidedBySenderDisplayName`
    - `decidedAt`

跨进程并发依赖现有 runtime single instance lock 兜底；不在这个功能里另做分布式锁。

### TUI 设计入口

TUI 后续应直接调用 `GroupAccessService`，不要重复实现权限逻辑。

当前开发批次的 TUI 范围只做飞书渠道实例的“群聊接收”开关。其它群聊 TUI 交互都不做，包括：

- 不做群聊权限管理页。
- 不做超级管理员设置/转移页面。
- 不做小黑屋列表管理页面。
- 不做审批策略开放/关闭页面。
- 不做管理员角色配置页面。
- 不做运行期配对码详情页增强。

这些能力可以先在后端模型和文档中保留，TUI 只暴露一个入口：

```text
飞书渠道详情
  群聊接收: 关闭/开启
  操作:
    开启群聊接收 / 关闭群聊接收
```

这样第一步先解决“用户是否允许这个飞书机器人接收群聊消息”的大开关，不把权限管理 UI 一次性做复杂。

TUI 必须区分两个阶段：

- 启动前配置 TUI：只能管理已经持久化的渠道、route、信任记录、群权限记录。不能监听飞书消息，不能展示新配对码。
- 运行期 TUI：Bridge 已启动，能显示实时安全日志、待配对 route 和当前内存里的配对码。

这一点要在页面文案里明确，避免用户误以为“还没启动服务，也能在 TUI 里拿到新群的配对命令”。

### TUI 信息架构

群聊权限管理不建议放在“渠道详情”作为唯一入口，因为它不是飞书机器人账号级配置，而是具体群 route 的配置。

推荐入口：

```text
聊天绑定列表
  -> 选中 飞书 / 群聊:<群名>
  -> 绑定详情
  -> 群聊权限
```

渠道详情页可以补一个聚合入口：

```text
飞书渠道详情
  -> 群聊权限管理
  -> 展示该飞书账号下所有 group route
```

也就是说：

- route 详情是主入口，适合用户看到某个群后直接管理。
- 飞书渠道详情是批量入口，适合管理多个群。

### 群聊绑定列表展示

飞书群聊在绑定列表里应和私聊区分：

```text
飞书 / default / 群聊:研发协作群     019e39c8   已配对   审批:超级管理员
飞书 / default / 群聊:测试群         未绑定     未配对
```

建议 badges：

- `未配对`
- `无超级管理员`
- `审批:超级管理员`
- `审批:开放`
- `小黑屋:N`
- `未绑定`

这里不展示完整 `chat_id`，详情页再展示完整 routeKey/chat_id。

### 群 route 状态

TUI 至少区分四种状态：

```text
未发现
待配对
已配对但无超级管理员
已配对且权限完整
```

含义：

- `未发现`：群从未给机器人发过消息，本地没有 route。启动前 TUI 不显示，用户需要启动服务后在群里 @bot。
- `待配对`：本地已有 route，但没有 trusted record。不能绑定或切换 session，不能配置群权限；可以进入配对详情或本机手动信任。
- `已配对但无超级管理员`：route 已可信，但 `group-access.json` 没有 `superAdmin`。普通 @bot 任务可按策略进入 Codex，但默认审批会阻塞；TUI 要突出提示“请设置超级管理员”。
- `已配对且权限完整`：有超级管理员，可以管理小黑屋和审批策略。

启动前 TUI 的待配对详情页必须显示：

```text
配对码只会在服务运行时生成。
请启动 Chat-Codex 后，在飞书群里 @机器人触发配对；配对命令会显示在运行期 TUI/终端日志里。
```

运行期 TUI 的待配对详情页可以额外显示当前有效配对码：

```text
配对命令: /pair 7K4P-92
有效期: 10 分钟
```

这个配对命令只显示在本机，不发送到飞书群。

### 群聊权限页

建议页面：

```text
群聊权限管理
  群: 研发协作群
  Route: feishu:default:group:oc_xxx
  Session: 019e39c8

  超级管理员
    张三 (ou_xxx)

  审批策略
    仅超级管理员审批

  小黑屋
    1. 李四 (ou_yyy)
    2. ou_zzz

  预留角色
    管理员: 暂未启用

  操作
    设置/转移超级管理员
    切换审批策略
    添加小黑屋用户
    移除小黑屋用户
    返回绑定详情
```

第一版 TUI 可以先只做查看和兜底修改：

- 设置/转移超级管理员。
- 切换审批策略。
- 添加/移除小黑屋。

管理员角色的 UI 先显示为“预留，暂未启用”。

### TUI 说明文案

群聊权限页需要把关键概念直接解释清楚，避免用户误解。

配对说明：

```text
配对表示这个飞书群 route 被本机 Chat-Codex 信任。一个群只需要配对一次。
配对码只在服务运行时显示在本机 TUI/终端，不会发送到飞书群。
通过 /pair 完成配对的发言人会成为该群的超级管理员。
```

超级管理员说明：

```text
超级管理员是该群 Chat-Codex 权限的唯一管理者。
超级管理员可以设置审批策略、管理小黑屋，并在默认模式下审批 Codex 操作。
一个群当前只启用一个超级管理员；管理员角色已预留但暂未启用。
```

审批策略说明：

```text
仅超级管理员审批：只有超级管理员可以 /OK 或 /NO Codex 审批请求，推荐使用。
开放审批：任何未在小黑屋中的群成员都可以审批 Codex 请求。
开放审批不会授予修改权限、管理小黑屋或转移超级管理员的能力。
```

小黑屋说明：

```text
小黑屋按飞书 sender open_id 生效，不按显示名生效。
被加入小黑屋的用户不能发起任务、不能审批、不能执行权限命令。
这只是 Chat-Codex 中间件拦截，不会把用户移出飞书群。
```

### 配对详情页

配对详情页不等同于群权限页。它管理 route 是否可信。

启动前配置 TUI：

```text
配对详情
  聊天: 飞书 / default / 群聊:研发协作群
  状态: 待配对
  Route: feishu:default:group:oc_xxx

  说明
    配对码只会在服务运行时生成。
    启动服务后，请在飞书群里 @机器人触发配对。
    本机运行期 TUI/终端日志会显示 /pair <code>。

  操作
    本机手动信任
    返回
```

运行期 TUI：

```text
配对详情
  聊天: 飞书 / default / 群聊:研发协作群
  状态: 待配对
  Route: feishu:default:group:oc_xxx
  配对命令: /pair 7K4P-92
  有效期: 10 分钟

  操作
    本机手动信任
    重新生成配对码
    返回
```

`重新生成配对码` 只在运行期可用，因为配对码不落盘。

### TUI 操作设计

#### 设置/转移超级管理员

优先选择来源：

1. 当前群 route 已记录的最近发言人。
2. `knownPrincipals` 最近发言人列表。
3. 当前群权限记录里的已有 principal。
4. 手动输入 open_id。

必须二次确认：

```text
确认将超级管理员转移给 张三 (ou_xxx)？
转移后，原超级管理员将失去群权限管理能力。
```

第一版支持手动 open_id 和最近发言人列表，不依赖飞书群成员 API。

选择列表必须同时显示名称和 ID：

```text
1. 张三        ou_xxx        最近发言 2026-05-19 13:20
2. 李四        ou_yyy        最近发言 2026-05-19 12:10
3. 手动输入 open_id
```

如果没有显示名，则直接显示 open_id。保存时只以 open_id/senderId 为准。

#### 切换审批策略

选项：

```text
仅超级管理员审批（推荐）
所有未拉黑成员都可审批
```

切到开放审批时必须二次确认：

```text
开放审批后，群里任何未拉黑成员都可以批准 Codex 操作。
这不会授予他们修改群权限的能力。
```

#### 添加小黑屋用户

优先选择来源：

1. `knownPrincipals` 最近发言人列表。
2. 当前超级管理员或权限记录里的已有 principal。
3. 手动输入 open_id。

添加后立即生效：

- 不能发起普通任务。
- 不能审批。
- 不能执行权限命令。

保存到 `blockedSenders` 的是 senderId/open_id：

```text
blockedSenders: [
  { senderId: "ou_yyy", displayName: "李四", source: "tui", createdAt: "..." }
]
```

如果用户后续改名，拦截仍然按 `ou_yyy` 生效。

#### 移除小黑屋用户

从当前 `blockedSenders` 列表选择，二次确认后移除。

#### 管理员预留区

第一版只展示：

```text
管理员角色已预留，当前版本未启用。
```

不要在 TUI 里放不可用的“添加管理员”主操作，避免用户误以为当前版本支持。

### TUI Actions 边界

TUI 不直接读写 `group-access.json`。需要新增 actions/service：

```ts
interface GroupAccessActions {
  listGroupRoutes(channelId?: string): GroupRouteSummary[];
  getGroupAccess(routeKey: string): GroupAccessDetail | undefined;
  setGroupSuperAdmin(routeKey: string, principal: GroupPrincipalInput): GroupAccessResult;
  setGroupApprovalPolicy(routeKey: string, policy: GroupApprovalPolicy): GroupAccessResult;
  blockGroupSender(routeKey: string, principal: GroupPrincipalInput): GroupAccessResult;
  unblockGroupSender(routeKey: string, senderId: string): GroupAccessResult;
}
```

TUI 只调用 actions，actions 再调用 `GroupAccessService` 和 state store。

### TUI 页面文件建议

当前 TUI 文件集中在 `src/cli/tui/app.tsx` 和 `views.tsx`，群聊权限会继续增加页面和输入状态。实现时建议顺手拆 TUI 子目录，避免主文件继续膨胀：

```text
src/cli/tui/
  app.tsx
  types.ts
  views.tsx
  group-access/
    group-access-view.tsx
    group-access-input.ts
    group-access-formatters.ts
```

业务动作仍然放在 actions/service：

```text
src/cli/actions/group-access-actions.ts
```

`group-access-view.tsx` 只负责展示，不能自己判断权限矩阵。

## 飞书权限与 API 注意事项

需要确认的飞书侧能力：

- 机器人能收到群消息事件。
- 机器人能读取 mentions。
- 机器人能 reply 原消息。
- 机器人能向群 `chat_id` 发消息。
- 不要求 contact user 或 chat members 权限用于显示名解析。

名称解析失败不能影响主流程：

- 有权限：展示群名、发言人名称。
- 没权限：私聊展示 `chat_id`、`open_id`；群聊优先引导用户用 `/name` 写入当前群名册。
- 缓存命中：避免每条消息都打 API。

对于群聊，不应要求用户为了显示名去配置完整企业通讯录数据权限。手工成员名册是正式方案。

## 风险

- 群聊里任何成员都能发起普通 Codex 任务，可能造成噪声。第一版用 @bot 和小黑屋控制，后续可加 allowlist 模式。
- 管理员列表如果只靠显示名会出错，必须以 open_id 为准。
- 飞书 @all 不应默认触发机器人，除非后续显式加 `respondToMentionAll`。
- 群内公开提示拉黑可能引发不必要争议，默认静默更稳。
- 如果 approval 默认允许所有人审批，会有明显安全风险；因此默认必须是 `super_admin_only`。
- 开放审批模式必须依赖 approval id 和细粒度锁，否则多人同时 `/OK` 会造成重复回写风险。

## 分阶段实现

### 当前开发批次：先核心群聊，再开关、配对、群名册、权限层

当前批次目标按顺序推进：

```text
1. 飞书群聊核心能力
2. 群聊接收开关
3. 群聊配对能力
4. 群聊手工成员名册
5. 最小权限层能力
```

TUI 当前只做渠道级“群聊接收”开关。其它群聊管理 TUI 暂不实现。

#### 1. 飞书群聊核心能力

- 在 `src/channels/feishu/group/` 增加群聊映射代码。
- 支持 `chat_type=group` 映射为 `conversation.kind="group"`。
- routeKey 使用 `feishu:<accountId>:group:<chat_id>`。
- sender 优先使用 `sender_id.open_id`。
- best-effort 填充 `sender.displayName` 和 `conversation.displayName`；失败时回退 open_id/chat_id。
- mentions 保留到 raw/metadata，用于 @bot 判断和后续命令目标解析。
- Feishu adapter 入站 handler 前必须过滤未 @Bot 的群消息；这类消息不进入 Bridge、不创建 route、不触发配对、不下载附件、不回复群。
- 群聊回复优先用原消息 reply，失败后 fallback 到 `chat_id` create。
- 私聊路径保持现有行为，不回归。
- 群聊能力代码可以先落地，但正式运行仍受后续 `capabilityOverrides.group` 开关控制。

验收：

- 能识别群 route、sender open_id、message_id、mentions。
- 能正确判断 bot mention，并剥离 bot mention 后再投递给 Codex。
- 未 @Bot 的群聊文本、@all、图片或文件消息会被静默忽略，并记录 `group_bot_not_mentioned` skip reason。
- 运行期日志能显示私聊/群聊类型；私聊用 `chat_id/open_id`，群聊优先显示群名和发言人名，拿不到名称时显示 ID。
- 群聊回复优先 reply 原消息。
- 私聊路径不回归。

#### 2. 群聊接收开关

- 给 `ChannelInstanceRecord` 增加 `capabilityOverrides`。
- 第一版只使用 `capabilityOverrides.group`。
- 新建飞书机器人默认 `group=false`。
- 旧飞书机器人升级后默认 `group=false`。
- Feishu adapter 实现群聊能力后可以声明 `group=true`。
- ChannelRegistry 或启动装配层必须计算有效能力：

```text
effective.group = adapter.group && channel.capabilityOverrides.group === true
```

- `group=false` 时，group 入站消息不进入 Bridge 普通流程。
- 关闭 group 不删除已有 route、trusted route、group-access 或 session binding。

TUI 只做飞书渠道详情页开关：

```text
群聊接收: 关闭/开启

操作:
  开启群聊接收
  关闭群聊接收
```

飞书私聊也提供渠道级命令：

```text
/group on
/group off
```

同时兼容 `/grop on`、`/grop off` 作为隐藏别名。私聊命令只在已配对的飞书 `direct` route 中生效，操作同一个飞书机器人实例的 `capabilityOverrides.group`；它不要求当前私聊绑定 Codex session，也不转发给 Codex。因为该私聊 route 已经通过配对验证，所以默认拥有渠道级群聊开关权限。

验收：

- 本地状态能保存和读取 `capabilityOverrides.group`。
- 未设置该字段时按 `false` 处理。
- TUI 能打开/关闭飞书群聊接收。
- 飞书私聊 `/group on`、`/group off` 能打开/关闭群聊接收。
- 飞书私聊 `/grop on`、`/grop off` 作为兼容别名能打开/关闭群聊接收，但不出现在 `/help`。
- adapter 支持 group 但实例开关关闭时，群消息不创建 route、不生成配对码、不回复群。
- 实例开关开启后，群消息才能进入后续 group flow。

#### 3. 群聊配对能力

- 群聊默认必须 @bot 才进入普通 Codex 任务。
- 未 @bot 的普通群消息静默忽略。
- 未配对群 route 不能创建或绑定 session，先走已有 route trust gate。
- 运行期生成配对码；启动前 TUI 不展示新配对码。
- `/pair <code>` 配对成功后：
  - 写入 `trusted-routes.json`。
  - 初始化 `group-access.json`。
  - 配对发起人写为唯一 `superAdmin`。

验收：

- 群 route 只配对一次。
- 配对成功消息不转发给 Codex。
- 配对成功者成为超级管理员。

#### 4. 群聊手工成员名册

当前批次可以在权限层前或权限层后单独实现，建议在群聊 prompt 前缀稳定后尽快补齐。

- 新增飞书群聊成员名册 store，路径为 `channels/feishu/<channelId>/accounts/<accountId>/groups/<chat_id>/members.json`。
- 新增群聊 `/name <名称>` 命令，只允许当前发送者设置自己的群内展示名。
- 新增群聊 `/whoami` 身份查看命令，用于查看当前发送者 `open_id`、群内展示名、登记状态和群 route 配对状态。
- `/name` 是飞书群聊专属命令，只在飞书群聊 `/help` 中展示；飞书私聊、微信和其它渠道不展示。
- 飞书群聊里 `/help`、`/name`、`/whoami` 都必须 @Bot 才能触发；未 @Bot 的命令文本被静默忽略。
- `/help` 需要按渠道和会话类型渲染：飞书群聊展示 `/name <名称>`、`/name` 和 `/whoami`，其它场景保持现有帮助。
- `/name`、`/whoami` 和飞书群聊专属 `/help` 在 Bridge 层实现，Feishu adapter 不直接消费命令。
- 群聊普通 @Bot 消息如果当前成员未登记，则提示用户先执行 `@Bot /name 小黄`，不把这条普通消息投递给 Codex。
- `/help` 要展示 `/name <名称>`，且不要求已有名称。
- 私聊不做 `/name` 强制流程；私聊继续 open_id 兜底。
- Codex 群聊前缀优先使用名册名称，例如 `小黄说：`、`小黄补充：`。
- 运行日志和 TUI 同时显示名称与必要 ID，排障时能定位到真实 `open_id`。

验收：

- 同一个群内，用户设置 `/name 小黄` 后，后续群聊 prompt 使用 `小黄说：`。
- 同一个用户在不同群可以设置不同名称。
- 未登记的群成员 @Bot 普通消息不会进入 Codex，会收到设置名称提示。
- 飞书群聊 `/help` 能看到 `/name <名称>`、`/name`、`/whoami`；飞书私聊和微信 `/help` 看不到这些飞书群聊专属命令。
- @Bot `/whoami` 能展示当前发送者的 `open_id` 安全展示、群内展示名、登记状态和群 route 配对状态。
- 未 @Bot 的 `/help`、`/name`、`/whoami` 不会触发回复、写名册或 route 配对。
- `/name` 不能给别人改名。
- 小黑屋、审批、超级管理员仍然按 `open_id` 判断，不受名称变化影响。

#### 5. 最小权限层能力

当前批次只要求后端默认策略可运行，不要求 TUI 可管理权限。

- 建立 `src/group-access/` 基础类型和默认策略。
- 默认 `approvalPolicy="super_admin_only"`。
- `blockedSenders` 结构先落地，但本批次可以不提供 TUI 管理。
- `knownPrincipals` 可随入站消息记录最近 sender，供后续 TUI 使用。
- 小黑屋 gate 如果列表为空，不影响主流程。
- 群聊普通任务进入 Codex 前加发言人前缀，例如 `小黄说：...`。
- 群聊运行中 steer 进入 Codex 前加补充前缀，例如 `小黄补充：...`。
- 私聊普通任务不加发言人前缀。

验收：

- 配对时能创建 group access record。
- 默认审批策略是超级管理员审批。
- `knownPrincipals` 不授予任何权限。
- 群聊同一 session 内能从 prompt 文本区分不同发言人。
- 群聊新任务和运行中补充能从 prompt 文本区分“说”和“补充”。

#### 6. 审批并发基础

- 群聊 approval 必须显示 approval id。
- 群聊里 `/OK <id>`、`/NO <id>` 优先按 id 处理。
- 同一个 `approvalKey` 只能被处理一次。
- 后续重复 `/OK <id>` 不再调用 Codex adapter。

验收：

- 两次处理同一 approval，只有第一次生效。
- 已处理 approval 有明确拒绝或静默策略。

#### 7. 测试

至少补以下测试：

- Feishu group message mapping。
- group off 时忽略 group 消息且不创建 route。
- group on 时创建 group route。
- 飞书私聊 `/group on`、`/group off` 修改 `capabilityOverrides.group`。
- 运行期 transcript 日志展示私聊/群聊类型、会话名和发言人名。
- @bot 才触发普通任务。
- 群聊普通 prompt 进入 Codex 前包含 `发言人说：` 前缀。
- 群聊运行中 steer prompt 进入 Codex 前包含 `发言人补充：` 前缀。
- 群聊 `/name <名称>` 写入当前 `chat_id` 的成员名册。
- 飞书群聊 `/help` 展示 `/name <名称>`、`/name` 和 `/whoami`。
- 飞书私聊、微信 `/help` 不展示 `/name`。
- 未 @Bot 的 `/help`、`/name`、`/whoami`、`/pair` 不进入 Bridge，不回复，不写状态。
- 群聊未完成成员登记时，普通 @Bot 消息被提示先设置名称，不进入 Codex。
- 群聊 `/whoami` 能查看当前发送者身份信息和成员登记状态。
- 同一 open_id 在不同 `chat_id` 下可以保存不同名称。
- 手工名称变化不影响小黑屋、超级管理员和审批权限判断。
- 私聊普通 prompt 不增加发言人前缀。
- 群聊 pending 附件按 `routeKey` 共享，A 的附件可以由 B 的 @bot 说明消费。
- 群聊 pending 附件达到 5 个上限后拒绝新增并提示。
- 入站普通文件以 `localFile` 文本路径说明投递给 Codex。
- 群聊 `/sendfile` 非超级管理员默认拒绝。
- group route 配对成功后写入 trusted route 和 superAdmin。
- approval id 重复处理锁。
- TUI/Actions 设置 `capabilityOverrides.group`。

#### 8. 群聊附件与出站文件控制

这一项可以作为最小权限层后的独立小批次实现，但不能遗漏。

- pending media key 继续按 `routeKey`，群聊 route 内共享 pending 附件池。
- 群聊 pending 附件记录 sender 信息和附件序号，用于投递给 Codex 时标注来源。
- 群聊附件进入 Codex 时统一加发言人前缀；运行中 steer 使用“补充”前缀。
- pending 附件文案改为“附件/图片或文件”，不要只写“图片”。
- 群聊 `/sendfile` 默认只允许超级管理员。
- 后续如要开放给普通成员，新增独立权限项 `group:send_file`。
- 出站文件审计记录触发者、群 route、session 和文件信息。

### 后续批次：群权限管理交互

后续再实现以下能力：

- TUI 群权限管理页面。
- TUI 设置/转移超级管理员。
- TUI 切换审批策略：仅超级管理员 / 所有未拉黑成员。
- TUI 添加/移除小黑屋用户。
- TUI 查看和修改群聊成员展示名。
- 聊天内 `/group block`、`/group unblock`、`/group approval open|restricted` 命令。
- 管理员角色和可配置权限包。

### 后续批次：治理增强

- 群名和成员名缓存刷新。
- allowlist 模式：只有指定成员可以发起普通任务。
- 审计日志展示：谁发起、谁审批、谁修改权限。
- 支持导出/备份群权限配置。

### 后续批次：飞书高级群能力

- thread/topic 群单独 route。
- 卡片式审批。
- 卡片聚合进度。
- 群内命令确认流。
- 可选与飞书群管理员/群主身份打通。

## 当前建议

先实现“当前开发批次”：飞书群聊核心能力 -> 群聊接收开关 -> 群聊配对 -> 群聊手工成员名册 -> 最小权限层。不要一开始做完整 RBAC，也不要一次性把群权限管理 TUI 全部做完。

最小安全模型是：

```text
飞书渠道默认不接收群聊，用户显式开启
群配对一次
群成员通过 /name 明确自己的群内展示名
普通成员 @bot 可发任务
唯一超级管理员默认负责审批
开放审批、小黑屋、超级管理员转移等管理交互后续再做
管理员角色预留，第一版不启用
本批次 TUI 只做群聊接收开关
```

这个顺序能先验证飞书群聊收发、route、配对和审批基础链路，同时避免 TUI 管理面一次性膨胀。
