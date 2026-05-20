# 本地文件持久化设计

## 背景

早期 `MemoryStateStore` 只在进程内保存 route/session 绑定。服务重启后，微信或飞书私聊需要重新选择 Codex session，用户容易反复配置。

当前已经把渠道配置、账号登录态元数据、route/session 绑定、session 权限和待生效绑定持久化到本地 JSON 文件。第一阶段不引入 SQLite，目标是实现简单、可排查、可迁移。

当前落地状态：

- `FileStateStore` 已实现 `routes.json`、`session-owners.json`、`session-policies.json`、`pending-bindings.json` 和 `trusted-routes.json` 的读写。
- 真实微信/飞书启动路径已接入文件状态存储。
- `ChannelConfigStore` 已实现 `config.json`、`instance.json` 和账号 `account.json` 的目录骨架写入。
- CLI 已提供渠道管理页和聊天绑定页；schema 迁移和损坏恢复仍在后续阶段。

## 设计结论

可以按“不同渠道不同目录、同一渠道下不同账号独立目录”落地，但要分清两类状态：

- 渠道自有状态：按渠道类型、渠道实例和账号目录隔离。
- Bridge 全局状态：route/session 绑定和 session owner 必须集中存，确保同一个 Codex session 不能被多个 route 或多个渠道重复绑定。

也就是说，目录可以按渠道和账号拆开，但 `session_id -> owner_route_key` 不能拆散到各渠道目录里。

## 目标

- 重启后自动恢复渠道实例配置。
- 重启后自动恢复已发现 route 和 active session。
- 重启后保留 `session_id -> owner_route_key`，继续阻止跨渠道重复绑定。
- 重启后保留已完成配对的可信 route，未信任 route 不进入 Codex。
- CLI 可以查看、切换、解绑、释放 route/session 绑定。
- 微信、飞书等渠道的登录态、token、缓存和平台细节互相隔离。
- 真实 secret 不写入 Git 跟踪文件，也不写入通用 Bridge 配置。

## 非目标

- 第一阶段不保存聊天正文。聊天历史仍依赖 Codex 自身 session。
- 第一阶段不做多进程并发写。同一时间只支持一个 Bridge 进程管理同一份状态。
- 第一阶段不把所有状态迁到 SQLite。
- 第一阶段不支持远程共享状态。

## 状态目录结构

默认根目录固定在当前系统用户目录下，不再跟随启动 `chat-codex` 时的工作目录变化：

```text
~/.chat-codex/state/
```

建议结构：

```text
~/.chat-codex/state/
  bridge/
    config.json
    routes.json
    session-owners.json
    session-policies.json
    pending-bindings.json
    trusted-routes.json
  channels/
    weixin/
      weixin-main/
        instance.json
        accounts/
          <weixin-account-id>/
            login.json
            cache.json
    feishu/
      feishu-main/
        instance.json
        accounts/
          default/
            account.json
            cache.json
            groups/
              <chat_id>/
                members.json
```

说明：

- `~/.chat-codex/state/bridge/` 是中间件全局状态，由 Bridge/CLI 管理。
- `~/.chat-codex/state/channels/<type>/` 是渠道类型目录，便于排查和迁移。
- `~/.chat-codex/state/channels/<type>/<channelId>/` 是渠道实例目录。
- `accounts/<accountId>/` 是该渠道实例下的账号目录。
- `channelId` 必须是运行时唯一实例 ID，例如 `weixin-main`、`feishu-main`、`feishu-work`。
- `accountId` 是渠道账号标识，例如微信账号归一化 ID、飞书 `default` 或工作区别名。
- 可以用 `CHAT_CODEX_STATE_DIR=/absolute/path/to/state` 覆盖状态根目录；相对路径按启动时 `process.cwd()` 解析，用于开发测试或临时迁移。
- 仓库根目录下的 `state/` 仍保留在 `.gitignore`，只用于旧版本迁移和本地开发显式覆盖，不再是 npm/global 启动的默认位置。

## Bridge 全局状态

### config.json

保存渠道实例配置和凭证来源；`config.json` 本身不保存真实 secret。真实 secret 若来自交互添加，只写入该账号目录下的 `credentials.local.json`。

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-05-16T00:00:00.000Z",
  "channels": [
    {
      "id": "weixin-main",
      "type": "weixin",
      "enabled": true,
      "stateDir": "state/channels/weixin/weixin-main",
      "defaultAccountId": "wx-default",
      "capabilityOverrides": {
        "group": false,
        "thread": false
      }
    },
    {
      "id": "feishu-main",
      "type": "feishu",
      "enabled": true,
      "stateDir": "state/channels/feishu/feishu-main",
      "defaultAccountId": "default",
      "credentialSource": "state-local"
    }
  ],
  "codexDefaults": {
    "adapter": "app-server",
    "permission": "approval",
    "progressMode": "brief",
    "maxConcurrentTurns": null
  }
}
```

字段说明：

- `channels[].id`：渠道实例 ID，进入 routeKey。
- `channels[].type`：渠道类型。
- `channels[].enabled`：启动主入口时是否默认启动。
- `channels[].stateDir`：该实例的 adapter-owned 状态目录。
- `channels[].defaultAccountId`：默认账号，不代表账号绑定 session。
- `credentialSource`：只记录来源，例如 `env`、`state-local`、`secrets/feishu.local.md`，不在 `config.json` 里记录 secret 值。

### routes.json

保存已发现聊天上下文和 active session。

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-05-16T00:00:00.000Z",
  "routes": [
    {
      "routeKey": "feishu-main:default:direct:oc_xxx",
      "channelId": "feishu-main",
      "channelType": "feishu",
      "accountId": "default",
      "conversationKind": "direct",
      "conversationId": "oc_xxx",
      "activeSessionId": "session_abc",
      "displayName": "飞书私聊",
      "identity": {
        "lastSenderId": "ou_xxx",
        "lastSenderDisplayName": "小黄",
        "openId": "ou_xxx",
        "userId": "user_xxx",
        "unionId": "on_xxx",
        "tenantKey": "tenant_xxx"
      },
      "policy": {
        "unboundRoute": "auto_new",
        "progressMode": "brief"
      },
      "lastSeenAt": "2026-05-16T00:00:00.000Z",
      "createdAt": "2026-05-16T00:00:00.000Z",
      "updatedAt": "2026-05-16T00:00:00.000Z"
    }
  ]
}
```

飞书私聊里：

- `conversationId` 使用 `message.chat_id`。
- `identity.openId/userId/unionId/tenantKey` 保存用户身份元数据。
- 不主动维护私聊展示名；旧数据里的 `identity.lastSenderDisplayName` 不再作为飞书私聊展示兜底。
- route 绑定 session 的主键仍是 `routeKey`，不是用户 ID。

微信私聊里：

- `conversationId` 使用微信私聊对端 ID。
- `identity` 保存微信 sender 元数据。

群聊和 thread 后续开放时：

- `conversationKind = "group"` 时，`conversationId` 是群 ID。
- `conversationKind = "thread"` 时，`conversationId` 是 thread ID。
- 发言人身份只放在 `identity.lastSenderId` 或 route 的最近消息元数据里，不进入 routeKey。

### session-owners.json

保存全局 session owner，强制一个 Codex session 只能属于一个 route。

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-05-16T00:00:00.000Z",
  "owners": [
    {
      "sessionId": "session_abc",
      "ownerRouteKey": "feishu-main:default:direct:oc_xxx",
      "claimedAt": "2026-05-16T00:00:00.000Z",
      "updatedAt": "2026-05-16T00:00:00.000Z"
    }
  ]
}
```

约束：

- `sessionId` 必须全局唯一。
- 如果 session 已属于其他 route，`/use`、`/resume`、CLI 切换都必须拒绝。
- 切换 active session 不自动释放旧 session owner。
- 释放 owner 必须显式操作，并检查 session 没有运行中任务、pending approval 和排队消息。

### session-policies.json

保存 session 级 Codex 运行权限。它不是渠道配置，也不是全局默认值，只对指定 session 后续 turn 生效。

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-05-16T00:00:00.000Z",
  "policies": [
    {
      "sessionId": "session_abc",
      "runPolicy": {
        "permissionMode": "approval",
        "sandbox": "workspace-write"
      },
      "createdAt": "2026-05-16T00:00:00.000Z",
      "updatedAt": "2026-05-16T00:00:00.000Z"
    }
  ]
}
```

约束：

- CLI 在“绑定详情”里设置当前 session 权限时写入这里。
- Bridge 恢复已绑定 session 时，必须把这里的 run policy 应用到 Codex adapter。
- 没有记录时使用启动时的默认权限。
- `full` 必须二次确认，不能通过普通回车误触。
- 权限只影响后续 turn，不改写正在运行的任务。

### pending-bindings.json

保存还没有真实 routeKey 的待生效绑定。当前主要用于微信账号添加后预设“主聊天绑定哪个 session”；收到第一条微信私聊后再转成真实 route 绑定。飞书不使用渠道级 pending 绑定，因为飞书机器人下会出现多个 `chat_id`。

```json
{
  "schemaVersion": 1,
  "pending": [
    {
      "id": "weixin-primary-weixin-wx-account-wx-account",
      "channelId": "weixin-wx-account",
      "accountId": "wx-account",
      "conversationKind": "direct",
      "label": "微信 / wx-account / 主聊天",
      "binding": {
        "type": "existing",
        "sessionId": "019e2e99..."
      },
      "createdAt": "2026-05-16T00:00:00.000Z"
    }
  ]
}
```

第一个符合条件的 route 到达后：

1. 生成真实 routeKey。
2. 创建新 session，或把 pending owner 转移为真实 route owner。
3. 写入 `routes.json` 和 `session-owners.json`。
4. 删除对应 pending binding。

### trusted-routes.json

保存已经通过本机配对码验证的聊天 route。信任粒度与 session 绑定一致，都是 `routeKey`；飞书同一个机器人下的不同私聊 `chat_id` 必须分别配对，微信同一账号下不同私聊联系人也必须分别配对。

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-05-17T00:00:00.000Z",
  "trustedRoutes": [
    {
      "routeKey": "feishu-main:default:direct:oc_xxx",
      "channelId": "feishu-main",
      "accountId": "default",
      "conversationKind": "direct",
      "conversationId": "oc_xxx",
      "displayName": "飞书私聊",
      "trustedAt": "2026-05-17T00:00:00.000Z",
      "trustedBySenderId": "ou_xxx",
      "trustedBySenderDisplayName": "张三",
      "trustMethod": "pairing_code",
      "lastSeenAt": "2026-05-17T00:00:00.000Z",
      "createdAt": "2026-05-17T00:00:00.000Z",
      "updatedAt": "2026-05-17T00:00:00.000Z"
    }
  ]
}
```

约束：

- 配对码本身不持久化，只保存在运行时内存里。
- 旧版本已有 `routes.json` 和 session 绑定不会自动视为可信，升级后需要完成一次配对。
- route 被删除或渠道状态被删除时，对应信任记录也要删除。
- `lastSeenAt` 随可信 route 的新消息更新，便于后续 TUI 展示最近活跃时间。

## 渠道自有状态

渠道自有状态由 adapter 管理，Bridge Core 不读取平台私有字段。

### 微信

```text
~/.chat-codex/state/channels/weixin/weixin-main/
  instance.json
  accounts/
    <weixin-account-id>/
      login.json
      cache.json
```

建议内容：

- `login.json`：微信 token、账号摘要、登录更新时间。
- `cache.json`：typing ticket 缓存、账号列表、轮询游标等。

安全要求：

- 目录必须被 Git 忽略。
- token 文件权限尽量收紧。
- CLI 状态页只显示账号摘要，不打印 token。

### 飞书

```text
~/.chat-codex/state/channels/feishu/feishu-main/
  instance.json
  accounts/
    default/
      account.json
      cache.json
      groups/
        <chat_id>/
          members.json
```

建议内容：

- `account.json`：appId 掩码、bot open_id、botName、domain、credentialSource。
- `credentials.local.json`：交互添加时保存真实 `appId`、`appSecret`、`domain`、`verificationToken`、`encryptKey` 等本机凭证；该文件位于 `~/.chat-codex/state/` 下，权限应为 `0600`。
- `cache.json`：最近 connection 状态、message 去重窗口、reaction typing 缓存等非敏感缓存。
- `groups/<chat_id>/members.json`：飞书群聊手工成员名册，按 `chat_id + open_id` 保存群内展示名，用于群聊日志和 Codex 发言人前缀。详见 [飞书名称展示与群聊名册设计](feishu-user-name-cache-design.zh-CN.md)。

安全要求：

- `FEISHU_APP_SECRET` 不写入 `config.json`、`instance.json`、`account.json`、日志、测试报告或 Git 跟踪文件。
- secret 可以来自环境变量、`secrets/feishu.local.md`，或交互输入后写入本机 `~/.chat-codex/state/channels/feishu/<channelId>/accounts/<accountId>/credentials.local.json`。
- `account.json` 中 App ID 可以掩码展示，不能写真实 App Secret。

## routeKey 规则

统一格式仍为：

```text
<channelId>:<accountId>:<conversationKind>:<conversationId>
```

注意：

- `channelId` 是实例 ID，不是渠道类型。
- `accountId` 是账号 ID，账号切换后 routeKey 自然隔离。
- 飞书私聊 `conversationId = chat_id`。
- 用户 ID 不进入私聊 routeKey，但必须作为 route 元数据保存。

## 绑定与切换流程

### 收到新 route 消息

1. Adapter 输出 `ChannelMessage`，包含 routeKey、conversation、sender。
2. Bridge 更新 `routes.json` 中该 route 的 `lastSeenAt` 和 identity。
3. 如果 route 有 `activeSessionId`，恢复该 session。
4. 如果没有 active session，按 `unboundRoute` 策略处理：
   - `auto_new`：创建新 session 并持久化绑定。
   - `ask`：提示用户 `/new` 或 `/resume`。
   - `reject`：拒绝普通 prompt，只允许管理命令。

### `/new`

1. 为当前 route 创建新 Codex session。
2. 写入 `session-owners.json`：新 session owner 是当前 route。
3. 更新 `routes.json`：当前 route 的 activeSessionId 指向新 session。

### `/use` 或 `/resume`

1. 解析目标 session。
2. 检查 `session-owners.json`：
   - 没有 owner：claim 给当前 route，再设为 active。
   - owner 是当前 route：允许设为 active。
   - owner 是其他 route：拒绝，并提示所属渠道/聊天。
3. 如果当前 route 有运行中任务、pending approval 或队列，拒绝切换。
4. 切换 active session 不释放旧 session owner。

### 显式释放 session

释放是危险操作，第一阶段建议只在 CLI 提供。

允许释放前必须检查：

- session 不在 running。
- 没有 pending approval。
- 相关 route 队列为空。
- 如果它是某 route 的 active session，需要用户确认并先清空 active。

释放后：

- 删除 `session-owners.json` 中该 session owner。
- 从 route 的 owned session 列表中移除。
- 其他 route 才能 claim 该 session。

## CLI 交互

主入口读取 `~/.chat-codex/state/bridge/config.json` 后展示：

```text
1. 管理渠道
2. 聊天绑定
3. 权限设置
4. 状态详情
5. 启动服务
0. 退出
```

### 管理渠道

功能：

- 添加渠道实例。
- 修改渠道实例 enabled 状态。
- 查看渠道实例账号状态。
- 登录/重新登录/登出渠道账号。
- 删除渠道实例。

删除渠道实例时不自动删除 route/session 绑定，只标记相关 route 为 stale，要求用户确认清理。

### 管理聊天绑定

功能：

- 按渠道、账号列出已发现 route。
- 查看 route 当前 active session。
- 为 route 创建新 session。
- 为 route 切换 active session。
- 解绑 route active session。
- 释放某个 session owner。

展示时优先用中文摘要：

```text
飞书 / default / 私聊 / 飞书私聊
当前 session: session_abc
最近用户: ou_xxx
最后活跃: 2026-05-16 10:00
```

## 写入策略

第一阶段使用 JSON 文件，写入必须原子化：

```text
file.json.tmp -> fsync -> rename(file.json.tmp, file.json)
```

建议：

- 所有 JSON 文件包含 `schemaVersion`。
- 写入前做结构校验。
- 读取失败时保留损坏文件，生成 `.corrupt.<timestamp>` 副本，再提示用户。
- 同一进程内用写队列串行化状态写入。
- 不在 Bridge Core 热路径里频繁写完整大文件，route `lastSeenAt` 可以节流写入。

## 安全与 Git 边界

- npm/global 启动默认写入 `~/.chat-codex/state/`，不写入用户当前项目目录。
- 仓库根目录 `state/` 必须继续被 `.gitignore` 忽略，用于旧版本迁移、显式 `CHAT_CODEX_STATE_DIR=./state` 和本地开发。
- `secrets/` 必须继续被 `.gitignore` 忽略。
- Bridge 配置文件只记录 secret 来源，不记录 secret。
- 测试报告和 README 只能写变量名和占位值。
- `/status` 默认不展示完整用户 ID；需要身份排查时用 `/whoami` 或 CLI 详细状态。

## 旧版本迁移

旧版本默认把状态写到启动目录下的 `./state/`。如果升级后发现账号列表为空，可以选择二者之一：

- 推荐迁移：把旧启动目录下的 `state/` 移到 `~/.chat-codex/state/`。
- 临时兼容：启动前设置 `CHAT_CODEX_STATE_DIR=/old/start/dir/state`，继续读取旧目录。

不要把真实账号凭证复制进 Git 跟踪目录。迁移前后可以用 `git status --short` 确认没有 `state/`、token、cookie 或 `credentials.local.json` 进入仓库。

## 迁移路径

### P1：文件 store 骨架

- 新增 `FileStateStore`，实现与 `MemoryStateStore` 等价接口。
- 启动时读取 `routes.json` 和 `session-owners.json`。
- 写入 `/new`、`/use`、`/resume` 造成的绑定变化。
- 保持现有 `MemoryStateStore` 测试，同时新增文件 store 测试。

### P2：渠道实例配置

- 新增 `config.json`。
- `npm run chat-codex` 从配置读取渠道实例。
- 微信和飞书快捷入口可以自动创建默认实例：
  - `weixin-main`
  - `feishu-main`

### P3：账号目录隔离

- 微信登录态迁移到 `~/.chat-codex/state/channels/weixin/<channelId>/accounts/<accountId>/`。
- 飞书账号状态写入 `~/.chat-codex/state/channels/feishu/<channelId>/accounts/<accountId>/`。
- 状态页展示渠道、账号和能力摘要。

### P4：CLI 管理页

- 增加“管理渠道”和“管理聊天绑定”。
- 支持切换 active session、解绑 route、释放 session owner。
- 对跨 route 绑定冲突给出中文可理解提示。

### P5：损坏恢复和迁移

- 支持 schemaVersion 迁移。
- 支持备份和恢复。
- 支持检查 orphan route、orphan owner、stale channel。

## 验收标准

- 重启后，飞书同一个私聊能自动恢复上次 active session。
- 重启后，微信同一个私聊能自动恢复上次 active session。
- 同一个 Codex session 已绑定飞书私聊时，微信 `/use <session>` 必须拒绝。
- 同一个 Codex session 已绑定微信私聊时，飞书 `/use <session>` 必须拒绝。
- 切换 active session 后，旧 session owner 不自动释放。
- 删除或禁用渠道实例后，不自动删除 session owner。
- secret 不出现在 `~/.chat-codex/state/bridge/*.json`、README、docs、reports、src、tests。
- `npm test` 通过，并新增文件持久化测试报告。
