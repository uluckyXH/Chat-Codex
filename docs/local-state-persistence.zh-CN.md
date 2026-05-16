# 本地文件持久化设计

## 背景

当前 `MemoryStateStore` 只在进程内保存 route/session 绑定。服务重启后，微信或飞书私聊需要重新触发首个 route 绑定策略，用户容易反复选择 Codex session。

接下来需要把渠道配置、账号登录态元数据、route/session 绑定持久化到本地文件。第一阶段先用 JSON 文件，不引入 SQLite，目标是实现简单、可排查、可迁移。

## 设计结论

可以按“不同渠道不同目录、同一渠道下不同账号独立目录”落地，但要分清两类状态：

- 渠道自有状态：按渠道类型、渠道实例和账号目录隔离。
- Bridge 全局状态：route/session 绑定和 session owner 必须集中存，确保同一个 Codex session 不能被多个 route 或多个渠道重复绑定。

也就是说，目录可以按渠道和账号拆开，但 `session_id -> owner_route_key` 不能拆散到各渠道目录里。

## 目标

- 重启后自动恢复渠道实例配置。
- 重启后自动恢复已发现 route 和 active session。
- 重启后保留 `session_id -> owner_route_key`，继续阻止跨渠道重复绑定。
- CLI 可以查看、切换、解绑、释放 route/session 绑定。
- 微信、飞书等渠道的登录态、token、缓存和平台细节互相隔离。
- 真实 secret 不写入 Git 跟踪文件，也不写入通用 Bridge 配置。

## 非目标

- 第一阶段不保存聊天正文。聊天历史仍依赖 Codex 自身 session。
- 第一阶段不做多进程并发写。同一时间只支持一个 Bridge 进程管理同一份状态。
- 第一阶段不把所有状态迁到 SQLite。
- 第一阶段不支持远程共享状态。

## 状态目录结构

默认根目录：

```text
state/
```

建议结构：

```text
state/
  bridge/
    config.json
    routes.json
    session-owners.json
    pending-bindings.json
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
```

说明：

- `state/bridge/` 是中间件全局状态，由 Bridge/CLI 管理。
- `state/channels/<type>/` 是渠道类型目录，便于排查和迁移。
- `state/channels/<type>/<channelId>/` 是渠道实例目录。
- `accounts/<accountId>/` 是该渠道实例下的账号目录。
- `channelId` 必须是运行时唯一实例 ID，例如 `weixin-main`、`feishu-main`、`feishu-work`。
- `accountId` 是渠道账号标识，例如微信账号归一化 ID、飞书 `default` 或工作区别名。

## Bridge 全局状态

### config.json

保存渠道实例配置，不保存真实 secret。

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
      "credentialSource": "env"
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
- `credentialSource`：只记录来源，例如 `env`、`secrets/feishu.local.md`、`interactive`，不记录 secret 值。

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

### pending-bindings.json

保存首个 route 绑定策略，例如启动时选择“第一个私聊绑定新 session / 绑定已有 session”。

```json
{
  "schemaVersion": 1,
  "pending": [
    {
      "id": "first-feishu-direct",
      "channelId": "feishu-main",
      "accountId": "default",
      "conversationKind": "direct",
      "binding": {
        "type": "new"
      },
      "createdAt": "2026-05-16T00:00:00.000Z"
    }
  ]
}
```

第一个符合条件的 route 到达后：

1. 生成真实 routeKey。
2. 创建或 claim session owner。
3. 写入 `routes.json` 和 `session-owners.json`。
4. 删除对应 pending binding。

## 渠道自有状态

渠道自有状态由 adapter 管理，Bridge Core 不读取平台私有字段。

### 微信

```text
state/channels/weixin/weixin-main/
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
state/channels/feishu/feishu-main/
  instance.json
  accounts/
    default/
      account.json
      cache.json
```

建议内容：

- `account.json`：appId 掩码、bot open_id、botName、domain、credentialSource。
- `cache.json`：最近 connection 状态、message 去重窗口、reaction typing 缓存等非敏感缓存。

安全要求：

- `FEISHU_APP_SECRET` 不写入 `state/`。
- secret 只来自环境变量、`secrets/feishu.local.md` 或交互输入。
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

主入口读取 `state/bridge/config.json` 后展示：

```text
1. 启动服务
2. 管理渠道
3. 管理聊天绑定
4. Codex 默认设置
5. 查看状态
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

- `state/` 必须继续被 `.gitignore` 忽略。
- `secrets/` 必须继续被 `.gitignore` 忽略。
- Bridge 配置文件只记录 secret 来源，不记录 secret。
- 测试报告和 README 只能写变量名和占位值。
- `/status` 默认不展示完整用户 ID；需要身份排查时用 `/whoami` 或 CLI 详细状态。

## 迁移路径

### P1：文件 store 骨架

- 新增 `FileStateStore`，实现与 `MemoryStateStore` 等价接口。
- 启动时读取 `routes.json` 和 `session-owners.json`。
- 写入 `/new`、`/use`、`/resume` 造成的绑定变化。
- 保持现有 `MemoryStateStore` 测试，同时新增文件 store 测试。

### P2：渠道实例配置

- 新增 `config.json`。
- `npm run codex` 从配置读取渠道实例。
- 微信和飞书快捷入口可以自动创建默认实例：
  - `weixin-main`
  - `feishu-main`

### P3：账号目录隔离

- 微信登录态迁移到 `state/channels/weixin/<channelId>/accounts/<accountId>/`。
- 飞书账号状态写入 `state/channels/feishu/<channelId>/accounts/<accountId>/`。
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
- secret 不出现在 `state/bridge/*.json`、README、docs、reports、src、tests。
- `npm test` 通过，并新增文件持久化测试报告。
