# CLI 核心交互设计

## 背景

当前底层持久化第一阶段已经具备：

- `state/bridge/routes.json` 保存聊天 route 与 active Codex session。
- `state/bridge/session-owners.json` 保存全局 `sessionId -> ownerRouteKey`，阻止同一个 session 被多个聊天复用。
- `state/bridge/config.json` 和 `state/channels/<type>/<channelId>/...` 保存渠道实例和账号目录骨架。

现在主要问题是 CLI 交互仍然混乱：

- 首页展示太多 Codex 默认项，例如接入方式、阶段进度、并发上限。
- 用户配置渠道时，不知道什么时候该选 session。
- 微信和飞书的产品模型不同，但 CLI 暂时没有清晰区分。
- 当前 `serve-wizard` 把展示、输入、业务决策和启动流程混在一起，后续改成 TUI 时容易重写。

本文档定义新的核心交互。TUI 可以直接按本文实现，但业务动作必须先抽到 actions/services，避免 UI 绑定业务逻辑。

## 已确认产品边界

### 微信当前阶段

微信当前按“一个账号 + 一个主要私聊窗口”处理。

也就是说，在当前产品体验里，用户可以认为：

```text
微信渠道 -> 微信主聊天 -> Codex session
```

虽然底层仍然必须保存为 route/session 绑定，但 CLI 可以把它包装成“给微信主聊天选择 session”。

如果启动时还没有发现真实微信私聊 routeKey：

- CLI 可以让用户先选 session。
- 内部保存为 pending 微信主聊天绑定。
- 第一条微信私聊消息到达后，使用真实 routeKey 落到 `routes.json` 和 `session-owners.json`。
- 文案必须说清楚“收到第一条微信私聊后生效”，不能伪装成已经有真实 route。

如果已经有持久化 route：

- CLI 直接展示“微信主聊天”。
- 用户可以立即切换、解绑或重新选择 session。

### 飞书当前阶段

飞书当前是“一个机器人 + 多个用户私聊窗口”。

```text
飞书机器人 -> chat_id A -> Codex session A
飞书机器人 -> chat_id B -> Codex session B
飞书机器人 -> chat_id C -> Codex session C
```

因此，飞书渠道配置完成后不应该立刻要求用户选 session。

原因：

- 用户没有在飞书里给机器人发消息前，本地不知道真实 `chat_id`。
- 一个飞书机器人会对应多个私聊窗口。
- 给整个飞书渠道绑定一个 session 会导致多个用户混到同一个 Codex thread。

飞书的 session 绑定只能发生在：

- 某个飞书私聊已经发过消息，`chat_id` 已进入 `routes.json`。
- 用户在“聊天绑定”里选择这个具体飞书聊天并绑定 session。
- 或飞书用户在自己的私聊里发送 `/new`、`/resume`、`/use`。

## 交互总原则

1. 先选渠道，再处理该渠道适合的 session 绑定方式。
2. 微信当前可以在渠道配置后引导选择 session，因为产品上只有一个主聊天。
3. 飞书渠道配置后不进入 session 选择，等待真实 chat_id 出现。
4. 首页不展示复杂的 Codex 默认设置。
5. Codex 接入方式固定为 `app-server`，普通用户不需要切换。
6. 首页只展示权限摘要，不展示阶段进度、并发上限、adapter 模式。
7. TUI 只负责展示和输入，不能直接读写 JSON、不能直接做 owner 冲突判断。

## 架构分层

```text
TUI / Prompt / 普通命令
        ↓
CLI Actions / Services
        ↓
State Store / Channel Config / Codex Session Discovery
        ↓
Bridge Runtime
```

### TUI 层

职责：

- 展示首页、渠道页、绑定页、状态页。
- 响应方向键、回车、快捷键、返回和退出。
- 调用 actions/services。
- 展示 actions 返回的结构化结果。

禁止：

- 直接写 `routes.json`、`session-owners.json`、`config.json`。
- 直接 new 微信/飞书 adapter 做业务判断。
- 直接判断 session owner 冲突。
- 把微信和飞书绑定逻辑写在 UI 组件里。

### Actions / Services 层

建议接口：

```ts
interface LauncherActions {
  getDashboard(): Promise<DashboardState>;
  listChannels(): Promise<ChannelSummary[]>;
  setupChannel(channelType: "weixin" | "feishu"): Promise<ChannelSetupResult>;
  listBindings(filter?: BindingFilter): Promise<BindingSummary[]>;
  listBindableSessions(target: BindingTarget): Promise<SessionChoice[]>;
  bindTargetToSession(target: BindingTarget, sessionId: string): Promise<BindResult>;
  createAndBindSession(target: BindingTarget): Promise<BindResult>;
  unbindTarget(target: BindingTarget): Promise<UnbindResult>;
  getDefaultPermissionSettings(): Promise<PermissionSettings>;
  updateDefaultPermissionSettings(input: PermissionSettingsInput): Promise<void>;
  getSessionPermissionSettings(sessionId: string): Promise<PermissionSettings>;
  updateSessionPermissionSettings(sessionId: string, input: PermissionSettingsInput): Promise<void>;
  startRuntime(): Promise<void>;
}
```

这些 actions 应该可单测，不依赖 TUI 渲染。

## 首页设计

首页不再展示“Codex 默认设置”大段信息。

目标：

```text
Chat Codex

渠道
  微信    已登录       主聊天已绑定
  飞书    已配置       等待用户私聊机器人

聊天绑定
  微信 / wx-account / 主聊天    你好呀 / 019e2c92
  飞书私聊      0 个已发现

权限
  审批模式（workspace-write 沙箱）

操作
  1. 管理渠道
  2. 聊天绑定
  3. 权限设置
  4. 状态详情
  5. 启动服务
  0. 退出
```

说明：

- 有对象列表的页面，数字只用于选择对象；同屏操作使用字母快捷键，避免“列表编号”和“操作编号”混在一起。
- 不展示 `Codex app-server`，因为它是固定默认接入方式。
- 不展示阶段进度。微信是否投递进度、飞书是否投递进度属于渠道策略，不是首页主信息。
- 不展示并发上限。它是高级运行参数，后续可放到高级设置或配置文件。
- “权限设置”只保留用户真正需要理解的权限风险。

## 初次启动流程

当没有配置过渠道时：

```text
欢迎使用 Chat Codex

渠道
  暂无渠道

操作
  1. 管理渠道
  2. 聊天绑定
  3. 权限设置
  4. 状态详情
  5. 启动服务
  0. 退出
```

普通 CLI 在无渠道时默认回车进入“管理渠道”，避免用户误启动空服务。

### 选择微信

```text
微信渠道

状态: 未登录

操作:
  1. 扫码登录
  0. 返回
```

二维码显示后不直接卡住等待，进入可返回的检查提示：

```text
微信扫码登录

扫码并在手机上确认后，按回车检查登录结果。
不想登录就输入 0 返回管理渠道。

请选择 [回车检查 / 0 返回]:
```

登录成功后进入微信主聊天绑定：

```text
微信主聊天绑定

请选择这个微信聊天使用哪个 Codex session：

  1. 你好呀                         019e2c92
  2. 飞书私聊适配                    019e2e99

操作:
  n. 新建 Codex session
  m. 手动输入 Session ID
  0. 暂不绑定，首条消息自动创建

不可选（已绑定其他聊天）:
  已绑定到飞书 / default / 张三    飞书私聊适配    019e2e99
```

绑定规则：

- 如果已发现微信 route，直接绑定该 route。
- 如果未发现微信 route，保存 pending 微信主聊天绑定。
- 如果 session 已被其他 route owner 占用，不出现在可选列表，单独显示在“不可选”区并标明当前绑定到哪里。
- 手动输入已被占用 session 时，给出中文冲突说明并停留在选择页。
- 输入错误不退出，不抛原始异常。

绑定后首页展示：

```text
微信 / wx-account / 主聊天    待绑定到 你好呀 / 019e2c92（收到第一条微信私聊后生效）
```

或已有 route 时：

```text
微信 / wx-account / 主聊天    你好呀 / 019e2c92
```

### 选择飞书

```text
飞书渠道

状态: 未配置

操作:
  1. 检查环境变量配置
  2. 输入/更新本机凭证
  0. 返回
```

飞书配置成功后不进入 session 选择，而是显示：

```text
飞书已配置

下一步:
  启动服务后，在飞书里私聊机器人。
  每个飞书私聊会用自己的 chat_id 生成独立聊天绑定。
```

如果已经发现过飞书聊天，则在“管理聊天绑定”里列出：

```text
飞书聊天

  1. 张三 / oc_xxx       未绑定
  2. 李四 / oc_yyy       飞书日报 / 019e2ea9
```

用户只能对具体飞书聊天绑定 session，不能对整个飞书渠道绑定 session。

飞书聊天显示名策略：

- 首次收到消息时，必须至少记录 `chat_id`、`open_id`、`user_id`、`union_id`、`tenant_key` 中能拿到的身份字段。
- 飞书消息事件本身不保证直接带用户昵称。昵称应通过飞书联系人 API 或聊天成员 API 做 best-effort 解析，并写入本地缓存。
- 有权限且解析成功时，CLI 显示昵称，例如 `飞书 / 张三`。
- 权限不足或解析失败时，CLI 不报错，显示脱敏 ID，例如 `飞书 / 用户 ou_xxx...abcd`，同时保留 `chat_id` 便于排查。
- 后续再次解析到昵称时，可以更新本地 route identity，但不能改变 routeKey；绑定仍以 `chat_id` 为准。

## 管理渠道

```text
管理渠道

已配置渠道
  1. 微信 / wx-account        已启用    已连接
  2. 飞书 / default           已启用    已连接

操作
  w. 添加微信账号
  f. 添加飞书机器人
  0. 返回
```

渠道页只管渠道自身：

- 登录或配置。
- 启用或禁用。
- 状态检查。
- 能力摘要。

渠道页不直接给飞书选择 session。

微信是当前阶段的特例：因为产品上只有一个主聊天，微信渠道页可以提供“配置微信主聊天绑定”的入口，但实现仍然走绑定 actions。

## 管理聊天绑定

```text
管理聊天绑定

  1. 微信 / wx-account / 主聊天   你好呀 / 019e2c92
  2. 飞书 / default / 张三        未绑定
  3. 飞书 / default / 李四        飞书日报 / 019e2ea9
  0. 返回
```

选择某项后：

```text
绑定详情

渠道: 微信
聊天: 微信 / wx-account / 主聊天
当前 session: 你好呀 / 019e2c92
当前权限: 审批模式（workspace-write 沙箱）
工作目录: /Users/xiaohuang/codex-wechat/codex-openclaw-wechat
最近消息: 2026-05-16 12:28

操作:
  1. 切换 session
  2. 新建并绑定 session
  3. 设置当前 session 权限
  4. 解绑
  0. 返回
```

切换 session：

```text
选择 Codex session

  1. 当前  你好呀                         019e2c92
  2. 可用  CLI 交互重构                   019e2ea9
  3. 可用  飞书适配                       019e2ca0

操作:
  m. 手动输入 Session ID
  0. 返回

不可选:
  已绑定到飞书 / default / 李四           019e2bad
```

规则：

- 默认列表只展示可绑定 session 和当前 session。
- 不可选 session 可以折叠展示，也可以在详情页展示，避免用户以为 session 丢失。
- 长标题必须省略。
- 手动输入 ID 错误时停留在选择页。
- owner 冲突必须中文说明。
- 输入序号后立即执行绑定切换，并显示成功结果，不能只静默返回上级菜单。

切换成功反馈：

```text
已切换 session

聊天: 飞书 / default / 张三
当前 session: CLI 交互重构 / 019e2ea9
工作目录: /Users/xiaohuang/codex-wechat/codex-openclaw-wechat

1. 返回绑定详情
0. 返回首页
```

## 权限设置

权限分两层：

- 默认权限：用于以后新建的 Codex session。
- 当前 session 权限：用于某个已经绑定的 session，进入“绑定详情”后单独设置。

首页只展示默认权限摘要：

```text
默认权限设置

当前: 审批模式（workspace-write 沙箱）

  1. 审批模式（推荐）
  2. 完全权限（高风险，需要确认）
  0. 返回
```

绑定详情中的 session 权限设置：

```text
当前 session 权限

聊天: 飞书 / default / 张三
Session: CLI 交互重构 / 019e2ea9
当前: 审批模式（workspace-write 沙箱）

  1. 审批模式（推荐）
  2. 完全权限（高风险，需要输入 confirm）
  0. 返回
```

规则：

- 切换当前 session 权限只影响这个 session 后续 turn，不影响其他聊天绑定的 session。
- 因为 session 有唯一 owner，单独调高权限不会被其他渠道或聊天意外继承。
- 如果当前聊天未绑定 session，只能设置“后续新 session 默认权限”，不能设置 session 级权限。
- 完全权限必须二次确认，文案要明确“跳过审批和沙箱，可以直接执行命令并修改文件”。
- 权限修改成功后必须反馈当前聊天、session 和新权限。

不在普通界面展示：

- Codex 接入方式。
- 阶段进度模式。
- 并发上限。
- adapter 细节。

这些保留为高级配置或命令行参数，不进入核心交互。

## 状态详情

状态详情用于排查，不作为首页主路径：

```text
状态详情

渠道:
  微信    connected    account=...
  飞书    connected    account=default

绑定:
  routes: 3
  owners: 3
  pending: 1

运行:
  服务未启动
```

状态详情也应该中文化，不输出原始 JSON。

## 持久化语义

### 微信主聊天 pending 绑定

如果用户在未发现微信 route 前选择已有 session：

```json
{
  "id": "weixin-primary",
  "channelId": "weixin",
  "accountId": "xxx",
  "conversationKind": "direct",
  "binding": {
    "type": "existing",
    "sessionId": "019e2c92..."
  }
}
```

要求：

- 创建 pending 前检查 session 是否已被 owner 占用。
- pending 期间该 session 应在 CLI 里显示为“已预留给微信主聊天”，避免再被其他 route 选择。
- 第一条微信私聊到达后，转换为真实 route binding，并写入 `routes.json` 和 `session-owners.json`。
- 如果转换时 session 已被其他 route 占用，必须提示冲突，并按新聊天策略处理。

### 飞书聊天绑定

飞书没有渠道级 session 绑定。

飞书只保存：

```text
routeKey = feishu:<accountId>:direct:<chat_id>
```

每个 `chat_id` 独立绑定 session。

## TUI 形态

推荐最终用 TUI 实现核心交互，但不要让 TUI 承担业务。

第一版 TUI 可以是列表型，不需要复杂布局：

```text
┌ Chat Codex ────────────────────────────────┐
│ 渠道                                        │
│   微信   已登录   主聊天已绑定              │
│   飞书   已配置   等待用户私聊机器人        │
│                                             │
│ 聊天绑定                                    │
│   微信 / wx-account / 主聊天   你好呀 / 019e2c92 │
│   飞书私聊     0 个已发现                   │
│                                             │
│ 权限: 审批模式（workspace-write 沙箱）       │
│                                             │
│ Enter 启动  c 渠道  b 绑定  p 权限  q 退出  │
└─────────────────────────────────────────────┘
```

键盘建议：

- `Enter`：执行当前主操作或进入选中项。
- `Esc` / `q`：返回或退出。
- `c`：管理渠道。
- `b`：管理聊天绑定。
- `p`：权限设置。
- `r`：刷新。

### 后续 TUI 视觉与交互规范

TUI 只在 P3 之后做，不阻塞当前普通 CLI actions/services。

视觉原则：

- 首页使用清晰分区：渠道、聊天绑定、权限、运行状态。
- 不把内部字段名直接暴露给普通用户，例如 `routeKey`、`ownerRouteKey`、`adapterMode` 默认折叠到详情里。
- 状态用短中文标签：`已连接`、`未配置`、`未绑定`、`需处理`、`运行中`。
- 列表当前项高亮，不可选项置灰或放入“不可选”折叠区。
- 底部固定提示栏显示成功、错误和下一步，不让用户翻历史输出确认是否成功。
- 所有长标题、长 ID、长 cwd 都统一省略，详情页再完整展示。
- session 列表始终支持编号输入，TUI 只是增加方向键和回车。
- 微信、飞书使用同一套绑定 actions，但 UI 文案必须保留各自产品模型差异：微信主聊天，飞书多 `chat_id`。

交互原则：

- `Enter` 进入当前项或确认。
- `Esc` / `q` 返回上一级。
- `r` 刷新状态。
- 成功切换 session、权限或渠道配置后，必须显示明确结果页或底部结果提示。
- TUI 不直接读写 JSON，不直接判断 owner 冲突，不直接调用 Codex adapter；所有动作走 actions/services。

## 实施顺序

### P1：Actions / Services

- 已抽出 channel、binding、permission 相关 actions。
- actions 返回结构化状态，普通 CLI 负责展示和输入。
- 单元测试已覆盖微信一对一、飞书一对多、session owner 冲突、pending 微信主聊天绑定。

### P2：当前 CLI 精简

- 已完成：首页去掉“Codex 默认设置”分区。
- 已完成：固定 app-server，不展示 adapter 切换。
- 已完成：只保留权限配置。
- 已完成：微信配置后引导绑定主聊天 session。
- 已完成：飞书配置后不要求选 session。
- 已完成：启动服务时从本地配置启动所有 enabled 渠道实例。

### P3：TUI 壳

- 引入 TUI 展示 dashboard。
- TUI 调用 P1 actions。
- 保留非 TTY fallback，可退回普通 prompt 或命令行错误提示。

### P4：飞书聊天绑定管理

- 已完成：从 `routes.json` 列出已发现飞书 chat_id。
- 已完成：对具体 chat_id 切换 session、新建并绑定 session、解绑 session、设置当前 session 权限。
- 已完成：不提供飞书渠道级 session 绑定。

## 验收标准

- 新项目首次进入 `chat-codex` 时先选择渠道。
- 选择微信后，登录完成即进入微信主聊天 session 选择。
- 微信 session 选择错误可恢复，不崩溃。
- 微信未发现真实 route 时，显示为 pending 主聊天绑定，不误报已绑定。
- 选择飞书后只配置渠道，不要求选择 session。
- 飞书用户私聊机器人后，CLI 能在绑定管理中看到该 chat_id。
- 飞书只能对具体 chat_id 绑定 session。
- 首页不展示 Codex 接入方式、阶段进度、并发上限。
- 首页只展示权限摘要；权限设置页只管理审批模式/完全权限。
- TUI 不直接读写 JSON，不直接做 owner 冲突判断。
