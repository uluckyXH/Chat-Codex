# 新版 Codex 适配设计

## 背景

OpenAI Codex 的 app-server 协议和本地能力近期扩展很快。Chat-Codex 当前已经默认使用 `codex app-server --listen stdio://`，并实现了会话创建/恢复、turn 执行、steer、中断、审批、模型切换、Plan mode、Goal、上下文压缩、图片输入和上下文懒刷新等能力。

这份文档用于盘点新版 Codex 中值得 Chat-Codex 适配的能力，并给出分阶段落地顺序。目标不是把 Codex App 的全部富客户端能力搬到微信/飞书里，而是保证聊天桥接稳定、可解释，并逐步补齐对聊天场景有价值的协议能力。

本轮适配主线收敛为两类：协议稳定性和 thread/session 生命周期。权限 profile、模型 provider 能力只在影响现有聊天命令解释时考虑；飞书 skills、通用 MCP、plugin、marketplace 不作为近期版本适配内容。

本次基线：

- Chat-Codex 仓库：`main` 当前工作区。
- Codex 参考源码：`references/openai-codex`，HEAD 为 `b89ce9a`。
- 最新 app-server schema：
  - `ClientRequest` 共 86 个方法。
  - `ServerNotification` 共 66 个通知。
  - `ServerRequest` 共 10 类服务端反向请求。
- 官方手册确认 `codex app-server` 是 Codex 富客户端集成接口，支持 `thread/start`、`thread/resume`、`turn/start`、`turn/steer`、通知流和审批流。

## 当前已实现能力

### app-server 生命周期

- 懒启动 `codex app-server --listen stdio://`。
- JSON-RPC 初始化、请求/响应、通知分发、停止清理。
- request timeout、进程退出错误处理。
- 独立模式下 reload 会重启 Chat-Codex 自己启动的 app-server 子进程。

### Thread / session

- `thread/start`：新建 Codex session。
- `thread/resume`：恢复已有 session。
- `thread/name/set`：隐藏 `/new chat` 场景同步标题。
- 本地 Codex session 发现：读取 `~/.codex` 的 sqlite、session index 和 rollout。
- route/session 绑定、owner 全局唯一、持久化。
- stale rollout 兜底：当 `thread/resume` 返回 `no rollout found for thread id ...` 时清理失效绑定；`auto_new` 下自动新建，`ask` 下提示重新绑定。

### Turn 执行

- `turn/start`：普通消息投递。
- `turn/steer`：运行中普通文本/结构化图片 steer。
- `turn/interrupt`：`/stop` 中断。
- route 级队列、并发调度、busy guard。
- app-server 通知转 Bridge 事件：started/completed、agent message delta、plan、progress、token usage、命令输出摘要等。

### 用户可见命令

- `/new`、`/resume`、`/use`、`/sessions`、`/session`。
- `/permission approval|full confirm`。
- `/model`、`/model all`、`/model default`、`/model <model> [effort]`。
- `/plan`、`/code`。
- `/goal`、`/goal pause`、`/goal resume`、`/goal clear`。
- `/compact`。
- `/progress`、`/fff`、`/sendfile`、`/status`、`/stop`。

### 输入与渠道

- 文本。
- 本地图片 `localImage`。
- 普通文件以路径说明文本投递。
- 微信和飞书入站图片/文件下载到本地后再交给 Codex。
- 飞书群聊 route、手工名册、群权限和审批权限。

## 新版 Codex 关键变化

### Thread 生命周期更完整

新版 schema 已覆盖：

- `thread/list`
- `thread/loaded/list`
- `thread/read`
- `thread/fork`
- `thread/archive`
- `thread/unarchive`
- `thread/unsubscribe`
- `thread/rollback`
- `thread/metadata/update`
- `thread/shellCommand`

这说明 app-server 已经足够承担会话列表、历史读取、归档、分叉和回滚等富会话管理，不再只能依赖 Chat-Codex 自己扫描 `~/.codex`。

### Turn 参数更丰富

`turn/start` 新增或暴露了更多覆盖项：

- `summary`：reasoning summary 策略。
- `personality`：人格/行为风格。
- `outputSchema`：约束最终回复 JSON Schema。
- `serviceTier`、`effort`、`model` 已继续保留。

`thread/start` / `thread/resume` / `thread/fork` 也支持：

- `config`
- `baseInstructions`
- `developerInstructions`
- `personality`
- `ephemeral`
- `threadSource`

这些能力适合放到后续高级配置，不适合直接暴露成聊天普通命令。

### 权限模型更细

新版 `AskForApproval` 不再只是简单字符串，也支持 granular 结构：

```text
granular:
- sandbox_approval
- rules
- skill_approval
- request_permissions
- mcp_elicitations
```

同时 app-server 暴露：

- `permissionProfile/list`
- `ThreadSettings.activePermissionProfile`
- `item/permissions/requestApproval`
- guardian / auto approval review 通知

当前 Chat-Codex 的 `/permission approval|full` 仍是粗粒度策略。新版 profile/granular 语义对聊天主线的影响主要是“状态解释”和“审批请求兜底”，不需要近期做 profile 管理能力。

### ServerRequest 增多

当前 Chat-Codex 只完整处理：

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- legacy `execCommandApproval`
- legacy `applyPatchApproval`

新版还包括：

- `item/tool/requestUserInput`
- `mcpServer/elicitation/request`
- `item/tool/call`
- `account/chatgptAuthTokens/refresh`
- `attestation/generate`

如果继续直接返回 unsupported，Codex 某些新工具、MCP elicitations 或动态工具场景会失败得比较生硬。

### Skills / plugins / MCP 成为 app-server 一等能力，但当前不接入

新版 app-server 已有：

- `skills/list`
- `skills/extraRoots/set`
- `skills/config/write`
- `plugin/list`
- `plugin/install`
- `plugin/uninstall`
- `plugin/read`
- `plugin/skill/read`
- `marketplace/*`
- `mcpServerStatus/list`
- `mcpServer/oauth/login`
- `mcpServer/resource/read`
- `mcpServer/tool/call`

这些能力偏 Codex App 或插件生态。飞书 skills 原生化暂不做；plugin、marketplace、通用 MCP tool/resource 能力也不属于当前聊天桥接主线。

### 状态与警告通知更丰富

新版通知包括：

- `thread/settings/updated`
- `thread/name/updated`
- `thread/archived`
- `thread/unarchived`
- `thread/closed`
- `serverRequest/resolved`
- `model/rerouted`
- `model/verification`
- `warning`
- `guardianWarning`
- `deprecationNotice`
- `configWarning`
- `mcpServer/startupStatus/updated`
- `skills/changed`

当前 adapter 对这些通知大多忽略。对聊天用户来说，至少应把影响执行语义的通知转成状态或低频提示。

### Realtime / account / local app 能力扩展

新版还包含：

- `thread/realtime/*`
- `account/login/*`
- `account/read`
- `account/rateLimits/read`
- `account/usage/read`
- `app/list`
- `config/read` / `config/value/write`
- `fs/*`
- `command/exec`
- `review/start`

这些更偏 Codex App 或本地富客户端。Chat-Codex 可以选择性使用账号/额度只读信息和 review；不应把 `fs/*`、`command/exec` 直接开放给聊天渠道。

## 适配原则

1. 聊天桥接优先：只适配能改善微信/飞书聊天体验的能力。
2. 保持最小权限：任何能读写文件、执行命令、改 config、装 plugin 的 app-server 方法默认不开放给聊天用户。
3. 先状态透明，再功能开放：先能识别和展示新版通知/请求，再决定是否加聊天命令。
4. 不替代 Codex App：复杂富客户端能力继续留给 Codex App/CLI。
5. 兼容旧版本 Codex：新增 app-server 方法必须做 capability/unknown method 兜底。
6. 不写 Codex 内部历史文件：继续通过 app-server 或只读发现接口操作 thread。

## 稳定性适配逻辑

这里的“稳定性适配”不是开放新版 Codex 能力，而是让新版 app-server 的协议漂移不会破坏现有聊天桥接。

证据来自本地 Codex 源码和当前 Chat-Codex adapter 的差异：

1. Codex 源码中的 `app-server-protocol/schema/typescript/ServerRequest.ts` 已定义 10 类服务端反向请求：
   - 当前已处理：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、legacy `applyPatchApproval`、legacy `execCommandApproval`。
   - 已做可解释兜底：`item/tool/requestUserInput`、`mcpServer/elicitation/request`、`item/tool/call`、`account/chatgptAuthTokens/refresh`、`attestation/generate`。

2. 旧实现中 `src/codex/app-server-codex-adapter.ts` 对未识别的 ServerRequest 会直接返回 JSON-RPC `-32601 unsupported server request: <method>`。
   - 这不会误授权，也不会执行新工具。
   - 但用户侧可能只看到普通 `Codex 执行失败`，不知道是新版 Codex 请求了 Chat-Codex 不支持的交互。
   - 现实现改为 fail-closed：能安全取消的请求返回 cancel/decline，动态工具返回 `success: false`，账号 token / attestation 返回明确不可用错误，并推送可解释进度提示。

3. Codex 源码中的 `ServerNotification.ts` 和 app-server 集成测试显示，审批、request user input、MCP elicitation 等请求结束时会发 `serverRequest/resolved`。
   - 旧实现不消费这个通知。
   - 如果审批在其他客户端被处理，或 Codex 自己取消请求，Chat-Codex 可能仍保留 pending approval 状态。
   - 现实现会清理 adapter pending approval，并向 Bridge 发 `approval.resolved` 事件，聊天侧 pending `/OK` 也同步失效。

4. `no rollout found for thread id ...` 来自 Codex thread-store / app-server 源码：
   - `thread-store/src/local/read_thread.rs` 找不到 rollout 时生成该错误。
   - `app-server/src/request_processors/thread_processor.rs` 会把 `ThreadNotFound` 映射成同样文案。
   - 所以 stale binding 处理不是猜测，而是针对 Codex 源码里的错误路径做绑定清理。

因此 P0 的实际边界是：

- 对未知 ServerRequest：明确拒绝或取消，给用户可解释提示，不新增执行能力。
- 对 `serverRequest/resolved`：只清理本地 pending 状态，不改变审批结果。
- 对 warning/model/thread 状态通知：只做限流状态提示或内部状态更新，不改变 turn 输入输出。
- 对 stale thread：只在 Codex 明确返回 thread 缺失时清理 Chat-Codex 绑定，不删除 Codex 历史、不改工作区。

不会影响的现有能力：

- 不改 `thread/start`、`thread/resume`、`turn/start`、`turn/steer` 的成功路径。
- 不改 `/permission approval|full` 的权限语义。
- 不改 `/model` 的模型选择语义。
- 不开放 `fs/*`、standalone `command/exec`、MCP tool/resource、OAuth、plugin 安装、飞书 skills。
- 不绕过现有 `/OK`、`/NO` 审批流程。

## 适配优先级

### P0：协议漂移与稳定性

目标：新版 Codex 不让 Chat-Codex 静默失真或卡住。

1. 协议漂移检查
   - 增加脚本读取 `references/openai-codex/.../ClientRequest.ts`、`ServerNotification.ts`、`ServerRequest.ts`。
   - 输出 Chat-Codex 已处理/未处理方法清单。
   - 后续可接入测试，避免 Codex 更新后新增关键 server request 被忽略。

2. 未支持 ServerRequest 的可解释失败
   - `item/tool/requestUserInput`：回复用户“Codex 正在请求额外输入，但当前 Chat-Codex 未支持该交互”，并向 app-server 返回 cancel/decline，而不是泛化 unsupported。
   - `mcpServer/elicitation/request`：区分 `url` 和 `form`。第一版可展示 URL 或表单摘要并取消，第二版再支持回复采集。
   - `item/tool/call`：在没有动态工具注册机制前明确拒绝，并提示需要后续工具桥接。
   - `account/chatgptAuthTokens/refresh` / `attestation/generate`：第一版明确返回不可用，日志中保留方法名，避免用户以为普通 Codex 执行失败。

3. 通知硬化
   - 处理 `thread/closed`、`thread/archived`、`thread/unarchived`、`thread/name/updated`。
   - 处理 `serverRequest/resolved`，清理本地 pending approval，避免“审批已被别处处理但 Chat-Codex 还在等”。
   - 安全通知必须完整推送到渠道；普通 warning/config/deprecation 按通知路由设计低频投递或进入状态。
   - 把 `model/rerouted`、`model/verification` 反映到 session status 的 model info。
   - 详细策略见 `codex-app-server-notification-routing-design.zh-CN.md`。

4. stale thread 后续完善
   - 已完成：active binding resume 找不到 rollout 时清理绑定并按策略恢复。
   - 已完成：`/goal`、`/compact` 等直接拿 binding.sessionId 调 app-server 的命令复用同一 stale-thread 识别文案。

### P1：会话管理迁移到 app-server

目标：减少直接扫描 `~/.codex` 的不一致，使用新版 app-server 的 thread API。

1. `CodexAdapter` 扩展
   - `listThreads?(options)`
   - `readThread?(threadId, options)`
   - `forkSession?(sessionId, options)`
   - `archiveSession?(sessionId)`
   - `unarchiveSession?(sessionId)`
   - `rollbackSession?(sessionId, numTurns)`

2. `AppServerCodexAdapter` 实现
   - `thread/list` 替代或补充 `discoverCodexSessions()`。
   - `thread/read` 用于 `/session <id>` 详情或调试。
   - `thread/fork` 支持“从当前会话分支一个新 session”。
   - `thread/archive` / `thread/unarchive` 支持会话列表清理。
   - `thread/rollback` 只作为高级命令，并明确“不回滚文件修改”。

3. 用户命令建议
   - `/fork [prompt]`：从当前 session fork，新 route 继续绑定 fork 后的 session；可选 prompt 作为 fork 后第一条任务。
   - `/archive`：归档当前 session 并解绑 route。
   - `/sessions archived`：列归档 session。
   - `/rollback <n> confirm`：回滚 Codex thread 历史末尾 n 个 turn；必须确认，且提示不回滚工作区文件。

4. 保留 filesystem fallback
   - 旧 Codex 或 exec adapter 继续用当前本地发现逻辑。
   - app-server `thread/list` unknown method 时 fallback 到 `discoverCodexSessions()`。

### P2：弱相关候选项，暂不进入主线

这些能力能改善状态解释，但不解决当前“聊天桥接是否稳定可用”的核心问题，因此只作为后续候选项：

1. 权限 profile 只读展示
   - 可用 `permissionProfile/list` 获取当前 cwd 可用 profile。
   - `/permission` 可以展示 `ThreadSettings.activePermissionProfile`。
   - 不做任意 profile 写入；继续保留 `approval` / `full confirm` 作为聊天侧快捷语义。

2. model provider capabilities 只读展示
   - 可调 `modelProvider/capabilities/read`，在 `/model` 中解释当前 provider 是否支持某些 reasoning summary、verbosity、service tier。
   - 不把 provider capability 变成新的模型管理系统。

3. 新 turn 覆写项
   - `summary` 可以后续并入 `/model` 文案。
   - `personality`、`outputSchema` 不作为普通聊天命令开放；如需要，应放到 TUI 或特定结构化任务入口。

### P3：富客户端能力，暂不做

这些能力暂不进入近期开发：

- `thread/realtime/*`：语音/实时对话，不符合当前文本桥接主线。
- `fs/*`：聊天侧远程文件管理风险过高。
- `command/exec` standalone：容易绕过 Codex turn 审批语义。
- `config/value/write` / `config/batchWrite`：改用户 Codex 配置风险高，应限定 TUI 管理端并二次确认。
- `plugin/install` / marketplace 写操作：需要独立安全设计。
- `account/login/start` / logout：认证生命周期属于 Codex CLI/App，本项目只做状态提示。
- `skills/list` / `skills/extraRoots/set`：飞书 skills 原生化暂不做。

## 具体设计

### 协议能力登记表

新增内部表，不要求生成完整 TS 类型：

```ts
interface AppServerProtocolCapability {
  method: string;
  direction: "client_request" | "server_request" | "server_notification";
  support: "handled" | "ignored_safe" | "unsupported_visible" | "candidate";
  owner: "adapter" | "bridge" | "tui" | "future";
}
```

用途：

- 文档化每个新版方法当前状态。
- 测试里对比 reference schema 方法清单。
- 新增 Codex 方法时，让测试输出“新增但未分类”的提醒。

第一版不把 reference schema 提交到包内，只在开发测试中读取 `references/openai-codex`。发布包仍不依赖 reference repo。

### ServerRequest 交互模型

现有 approval request 走：

```text
app-server server request
  -> AppServerCodexAdapter.pendingApprovals
  -> Bridge approval message
  -> /OK /NO
  -> JSON-RPC response
```

新版 request user input / elicitation 应抽象成更通用的 pending interaction：

```ts
type PendingCodexInteraction =
  | { type: "approval"; ... }
  | { type: "user_input"; questions: Question[]; ... }
  | { type: "mcp_elicitation"; mode: "url" | "form"; ... };
```

第一阶段仍可以只实现 `unsupported_visible`，但状态结构应预留，避免后续再改审批管理器边界。

### app-server thread list 替换策略

当前 `/sessions` 依赖 `CodexAdapter.listSessions()`，app-server adapter 内部仍用本地 `~/.codex` 扫描。新版适配后：

```text
AppServerCodexAdapter.listSessions()
  -> 优先 thread/list(useStateDbOnly=false, cwd=current cwd)
  -> 合并本地 route owner 状态
  -> unknown method / old Codex fallback discoverCodexSessions()
```

注意：

- `thread/list` 可以过滤 archived、cwd、sourceKinds、searchTerm。
- Chat-Codex 的 route owner 仍以本地 state 为准。
- app-server 返回的 archived thread 不应默认出现在 `/resume` 可选列表里，除非用户显式 `/sessions archived`。

### 状态通知映射

新增 `AppServerStatusNotice` 内部事件，避免所有通知都变成聊天消息：

```ts
type AppServerStatusNotice =
  | { kind: "warning"; text: string; routeKey?: string; sessionId?: string }
  | { kind: "model"; text: string; sessionId: string }
  | { kind: "thread"; text: string; sessionId: string }
  | { kind: "config"; text: string };
```

投递规则：

- 与当前 session/route 强相关：可在本 route brief progress 中低频提示。
- 全局 config/account 警告：只进入 TUI/runtime log，必要时 `/status` 展示。
- 群聊中不直接发送敏感路径、token、账号详情。

## 实施顺序

### 第一阶段：稳定性与可观测性

1. 新增 app-server protocol method inventory 脚本。
2. 给所有新版 `ServerRequest` 添加明确 unsupported response 和用户可见/日志说明。
3. 处理 `serverRequest/resolved` 清理 pending approval。
4. 处理 thread archived/closed/name updated 等状态通知。
5. `/goal`、`/compact` 复用 stale-thread 识别和绑定清理文案。

验收：

- 新版 schema 方法清单有分类。
- 新增 server request 不会只表现为普通 `Codex 执行失败`。
- `npm test` 全量通过。

### 第二阶段：thread API 接管会话管理

1. `AppServerCodexAdapter.listSessions()` 优先走 `thread/list`。
2. 增加 archived session 列表。
3. 设计并实现 `/fork`。
4. 设计并实现 `/archive` / `/unarchive`。
5. 评估 `/rollback` 是否只放 TUI，避免聊天误操作。

验收：

- `/sessions` 与 Codex App 可见 thread 更一致。
- 旧 Codex fallback 正常。
- route owner 约束不被 app-server 列表绕过。

### 可选后续：权限和模型只读展示

这些不作为当前版本适配阶段交付，只在后续出现明确需求时单独排期：

1. `/permission` 只读展示 active profile。
2. `/model` 只读展示 provider capability。
3. user input / elicitation 从 P0 的可解释取消升级为 route pending reply flow。

验收：

- 不改变当前聊天侧权限语义。
- 不开放通用 MCP tool/resource、OAuth、plugin 安装或 skills 管理。
- 所有可选能力都能在旧 Codex 上 graceful fallback。

## 测试计划

### 单元测试

- protocol inventory：新增方法未分类时失败或输出明确报告。
- app-server server request mapper：
  - approval request 仍按旧逻辑处理。
  - user input / elicitation / dynamic tool call 走可解释 unsupported。
- notification mapper：
  - warning / configWarning / deprecationNotice。
  - model/rerouted / model/verification。
  - thread/name/updated / archived / closed。
- stale thread helper：
  - route queue。
  - `/goal`。
  - `/compact`。

### 集成测试

- mock app-server 支持 `thread/list`，验证 `/sessions` 使用 app-server 返回。
- mock app-server 不支持 `thread/list`，验证 fallback。
- serverRequest/resolved 后 `/status` 不再显示 pending approval。
- 飞书 skills 原生化暂不做，不列入本设计测试项。

### 手工验证

- 使用新版 Codex CLI 启动真实 `chat-codex`。
- 绑定已有 session、运行普通 prompt、运行 `/plan`、`/model`、`/permission`、`/compact`。
- 在 Codex App/CLI 侧归档或重命名 thread，检查 Chat-Codex 状态。
- MCP elicitation 场景确认不会卡死；默认路径应可解释取消。

## 风险

- app-server 协议仍在快速演进，不能把实验方法当稳定 API。
- 部分方法需要 `experimentalApi` capability；旧 Codex 可能 unknown method。
- 聊天渠道天然不适合复杂表单、OAuth 和文件管理，需要 TUI 承担高风险交互。
- `thread/rollback` 只回滚 Codex history，不回滚实际文件，容易让用户误解。
- permission profile 和 granular approval 可能受 managed config / workspace policy 影响，不能在 Chat-Codex 中强行覆盖。

## 非目标

- 不实现 Codex App 的完整线程浏览器。
- 不在聊天里开放任意 `fs/*` 或 `command/exec`。
- 不接管用户 Codex 登录。
- 不默认安装/卸载 Codex plugins。
- 不做飞书 skills 原生化。
- 不把实时语音能力纳入近期路线。

## 结论

近期最应该做的是 P0 和 P1：

1. 先让 Chat-Codex 对新版 app-server 的新增请求/通知有明确分类和可解释兜底。
2. 再把 session 列表和 thread 生命周期逐步迁移到 `thread/list`、`thread/read`、`thread/fork`、`thread/archive`。
3. 权限 profile、model provider capabilities 只作为弱相关候选项，不进入当前主线。
4. Realtime、config 写入、plugin 安装、standalone command、通用 fs 操作暂不做聊天能力。
