# `/feishu` 飞书能力引导与工具适配设计

> 状态：待讨论。本文档记录当前设计方向和问题边界，尚未进入实现承诺；后续 `/feishu` 命令、skills 同步和真实飞书工具适配仍需继续评审。

## 背景

当前 Chat-Codex 已经实现飞书渠道消息收发、私聊/群聊 route、配对、审批、媒体收发和进度投递策略。飞书 OpenClaw 插件源码已作为本地参考源码放在：

```text
references/openclaw-lark/
```

该插件不只是飞书消息渠道，还包含一套面向 Agent 的 `skills/` 文档和一批 `feishu_*` 工具实现：

```text
references/openclaw-lark/skills/
references/openclaw-lark/src/tools/
references/openclaw-lark/openclaw.plugin.json
```

其中 `skills/` 用于告诉 Agent 什么时候使用飞书能力、如何选择工具、参数有哪些坑和最佳实践；`src/tools/` 是真正调用飞书开放平台 API 的工具代码。

Chat-Codex 当前不是 OpenClaw runtime，不启动 OpenClaw gateway/host，也不会自动执行 `openclaw-lark` 里的 `api.registerTool()`。因此 `/feishu` 命令第一阶段不能假装 Codex 已经能直接调用 `feishu_*` 工具。

本设计把 `/feishu` 分成两个层次：

1. 第一阶段：飞书 skills 引导，把可用 Skill 索引和文件路径注入给 Codex，让 Codex 按任务需要自行阅读对应 `SKILL.md`。
2. 后续阶段：飞书工具适配，把部分 `feishu_*` 能力通过 Chat-Codex 自己的工具层暴露给 Codex。

## 目标

1. 增加聊天命令 `/feishu <任务>`，表示本轮任务需要使用飞书能力上下文。
2. `/feishu` 不是给用户浏览 skills 的命令，而是给 Codex 注入飞书能力说明。
3. Codex 收到注入内容后，应知道在哪里读取飞书 Skill 文档，并按任务需求自行选择相关 Skill。
4. 第一阶段只做 skills 引导，不做真实飞书工具调用。
5. skills 来源要可更新，避免以后 OpenClaw 飞书插件升级后 Chat-Codex 难以同步。
6. 后续真实工具适配要有清晰边界，不能把 OpenClaw runtime 整体塞进 Bridge Core。

## 非目标

- 不在第一阶段把 `@larksuite/openclaw-lark` 作为运行依赖。
- 不在第一阶段复制或执行 `openclaw-lark/src/tools/` 的工具代码。
- 不让 Codex 通过 shell 自己读取 app secret 或手写 HTTP 请求调用飞书 API。
- 不把飞书工具调用写进 Bridge Core。
- 不要求用户手工安装 OpenClaw 或 OpenClaw 飞书插件。
- 不把 `references/openclaw-lark/` 打进 npm 包。

## 关键结论

`/feishu` 第一阶段只能让 Codex “知道如何使用飞书相关 Skill 文档”，不能让 Codex 自动拥有 `feishu_fetch_doc`、`feishu_update_doc`、`feishu_calendar_event` 等真实工具。

原因：

- `openclaw-lark` 的工具注册依赖 OpenClaw 的 `OpenClawPluginApi`。
- Chat-Codex 当前没有 OpenClaw runtime。
- Codex app-server 不会因为 prompt 里出现一个路径就自动注册外部工具。
- 真实飞书 API 调用需要凭证、权限、审计、错误处理和审批策略，不能只靠 prompt 完成。

因此第一阶段 `/feishu` 的正确边界是：

```text
用户 -> /feishu <任务>
Chat-Codex -> 注入飞书 Skill 索引和路径
Codex -> 按任务需要读取对应 SKILL.md，再完成规划、写作、分析或生成内容
```

后续真实工具调用的边界是：

```text
Codex -> Chat-Codex Feishu Tool Adapter -> @larksuiteoapi/node-sdk -> 飞书开放平台
```

## Skills 来源与打包

`references/openclaw-lark/` 是本地参考源码，按 Git 规范不提交、不发布。npm 包中不能依赖这个目录存在。

第一阶段应新增一个被 Git 跟踪、会随 npm 包发布的 skills 资源目录，例如：

```text
resources/feishu-skills/openclaw-lark/
  manifest.json
  skills/
    feishu-channel-rules/SKILL.md
    feishu-create-doc/SKILL.md
    feishu-fetch-doc/SKILL.md
    feishu-update-doc/SKILL.md
    feishu-im-read/SKILL.md
    feishu-calendar/SKILL.md
    feishu-task/SKILL.md
    feishu-bitable/SKILL.md
    feishu-troubleshoot/SKILL.md
```

`manifest.json` 记录来源：

```json
{
  "source": "https://github.com/larksuite/openclaw-lark",
  "sourceCommit": "6d95621",
  "sourcePackage": "@larksuite/openclaw-lark",
  "syncedAt": "2026-05-20T00:00:00.000Z",
  "skills": [
    {
      "name": "feishu-create-doc",
      "path": "skills/feishu-create-doc/SKILL.md",
      "alwaysActive": false,
      "description": "创建飞书云文档..."
    }
  ]
}
```

### 同步脚本

新增同步脚本：

```text
scripts/sync-feishu-skills.mjs
```

职责：

- 从 `references/openclaw-lark/skills/` 复制 `SKILL.md` 和必要的 `references/` 子目录。
- 解析每个 `SKILL.md` frontmatter。
- 生成 `resources/feishu-skills/openclaw-lark/manifest.json`。
- 记录 `references/openclaw-lark` 当前 commit。
- 校验 skill name 唯一。
- 校验 `feishu-channel-rules` 的 `alwaysActive: true` 是否保留。

命令建议：

```bash
git -C references/openclaw-lark pull --ff-only
node scripts/sync-feishu-skills.mjs
npm test
```

后续可以加 npm script：

```json
{
  "scripts": {
    "sync:feishu-skills": "node scripts/sync-feishu-skills.mjs",
    "check:feishu-skills": "node scripts/check-feishu-skills.mjs"
  }
}
```

## `/feishu` 命令语义

### MVP 命令

第一版只做一个核心命令：

```text
/feishu <任务>
```

语义：

- 当前消息作为普通 Codex 任务入队。
- Chat-Codex 在投递给 Codex 前追加飞书 skills 引导上下文。
- 不改变当前 route 的长期模式。
- 不要求用户理解 skills 列表。
- 不向用户刷出完整 skills 内容。

示例：

```text
/feishu 帮我把这段内容整理成飞书文档格式
/feishu 根据这份表结构设计一个飞书多维表格
/feishu 帮我分析这个飞书群聊历史应该怎么总结
```

### 可选后续命令

如果后续确实需要长期模式，再增加：

```text
/feishu on
/feishu off
/feishu status
```

建议不要第一版就做长期模式，原因：

- 长期模式需要持久化 route 状态。
- 用户可能只是一轮任务需要飞书上下文。
- 长期注入会增加 token 消耗。
- 飞书工具层还没接入时，长期模式容易让用户误以为所有飞书 API 都能直接调用。

## 注入内容

`/feishu <任务>` 生成的 Codex 输入应包含两部分：

1. 用户原始任务。
2. Chat-Codex 注入的飞书 skills 引导。

注入内容示例：

```text
【Chat-Codex 飞书能力引导】

这是一个飞书相关任务。你可以按任务需要选择并阅读以下 Skill 文档。
不要一次性读取全部 Skill；先根据用户任务判断最相关的 1-3 个。

Skills 根目录：
/path/to/chat-codex/resources/feishu-skills/openclaw-lark/skills

可用 Skill：
- feishu-channel-rules: Lark/Feishu channel output rules. Always active in Lark conversations.
- feishu-create-doc: 创建飞书云文档...
- feishu-fetch-doc: 获取飞书云文档内容...
- feishu-update-doc: 更新飞书云文档...
- feishu-im-read: 飞书 IM 消息读取工具使用指南...
- feishu-calendar: 飞书日历与日程管理工具集...
- feishu-task: 飞书任务管理工具...
- feishu-bitable: 飞书多维表格...
- feishu-troubleshoot: 飞书插件问题排查工具...

当前 Chat-Codex 仅提供飞书消息渠道和 Skill 文档引导。
除非系统明确提供了飞书工具，否则不要声称已经调用 feishu_* 工具或已经修改飞书数据。
如果任务需要真实调用飞书 API，而当前没有可用工具，请说明需要后续工具适配或请求用户提供可操作数据。
```

### 注入原则

- 只注入 Skill 索引和路径，不注入完整 Skill 正文。
- `feishu-channel-rules` 是 alwaysActive 类型，应在飞书任务引导中始终列出。
- 不注入 appId、appSecret、token、群 ID、用户 ID 等敏感配置。
- 不把本机 `~/.chat-codex/state/` 路径暴露给 Codex，除非是普通文件路径且无 secret。
- 如果 skills 资源缺失，应回复用户“飞书 Skill 资源不可用”，不要投递半成品引导。

## Codex Skill 系统关系

Codex 自身有 Skill 发现和渲染机制，但它依赖配置中的 skill root、插件 skill root 或约定目录。Chat-Codex 第一阶段不直接修改用户的 `~/.codex/skills`，也不假设 app-server 当前支持每轮动态注册任意 skill root。

因此第一阶段采用 prompt path injection：

```text
Chat-Codex 显式告诉 Codex：Skill 文档在某个路径，请按任务需要读取。
```

这不是 Codex 原生 Skill 注册，但实现简单、可控、不污染用户 Codex 配置。

后续如果确认 Codex app-server 支持每轮传入额外 skill roots，或支持通过配置为某个 session 增加 skill root，可以升级为：

```text
Chat-Codex -> Codex app-server per-turn skill roots -> Codex 原生 Skill 发现
```

升级前必须先核对 Codex 官方源码和协议，不靠猜测实现。

## 未来工具适配

### 为什么不能直接复用 OpenClaw 工具代码

`openclaw-lark/src/tools/` 的工具实现依赖：

- `OpenClawPluginApi`
- `api.registerTool()`
- OpenClaw config/runtime/logger/session context
- OpenClaw 的账号、OAuth、scope、卡片和运行时存储约定

Chat-Codex 没有这些运行时对象。直接复制工具代码会导致大量适配胶水和隐式依赖，后续上游更新时也很难维护。

### 推荐方向

后续真实工具调用应新增独立模块：

```text
src/feishu-tools/
  tool-catalog.ts
  credential-resolver.ts
  feishu-tool-adapter.ts
  tools/
    doc.ts
    im.ts
    calendar.ts
    task.ts
    bitable.ts
```

边界：

- `tool-catalog.ts` 定义 Chat-Codex 暴露给 Codex 的工具名、schema、权限说明。
- `credential-resolver.ts` 从当前 route/channel/account 解析飞书凭证，不把 secret 交给 Codex。
- `feishu-tool-adapter.ts` 负责调用 `@larksuiteoapi/node-sdk` 或少量 raw Open API。
- `tools/*` 按业务域拆分，避免单个文件过大。
- Bridge 只调通用工具执行接口，不 import 飞书 SDK。

### 暴露给 Codex 的方式

需要单独验证 Codex 当前支持的工具接入方式。候选方案：

1. MCP Server 方案
   - Chat-Codex 启动一个本地 MCP server，暴露 `feishu_*` 工具。
   - Codex 通过 MCP 调用工具。
   - 优点是 schema、权限和工具边界清晰。
   - 缺点是需要确认 app-server/CLI 对动态 MCP 配置的支持方式。

2. App-server Tool Bridge 方案
   - 如果 Codex app-server 支持自定义工具注册或扩展 tool call，则直接接入。
   - 优点是体验最好。
   - 缺点是需要更深入适配 Codex 协议，风险较高。

3. Structured Action Block 方案
   - Codex 输出特定格式，例如 `CHAT_CODEX_FEISHU_ACTION`。
   - Chat-Codex 解析后执行飞书 API，再把结果投递回下一轮。
   - 优点是实现快。
   - 缺点是不是真正的工具循环，错误恢复、参数校验和审批体验较差。

优先级建议：

```text
先验证 MCP Server -> 再考虑 app-server 扩展 -> 最后才考虑结构化 action block
```

## 工具代码更新后的快速适配

OpenClaw 飞书插件未来会继续更新。Chat-Codex 要避免每次上游工具实现变化都大规模改代码。

### 第一阶段：只同步 skills

第一阶段只依赖 `skills/`，不依赖 `src/tools/`。因此上游工具代码更新时，Chat-Codex 主要跟进 Skill 文档变化：

```bash
git -C references/openclaw-lark pull --ff-only
npm run sync:feishu-skills
npm run check:feishu-skills
npm test
```

检查点：

- Skill name 是否新增、删除或重命名。
- `SKILL.md` frontmatter 是否还能解析。
- `references/` 子目录是否被正确复制。
- Skill 文档里引用的工具名是否仍在 `openclaw.plugin.json` 的 contracts.tools 中。
- 注入 prompt 是否仍控制在合理 token 范围内。

### 第二阶段：同步工具契约，不同步工具实现

真实工具适配开始后，也不要直接全量同步 `src/tools/` 实现。建议先同步工具契约：

```text
openclaw.plugin.json contracts.tools
SKILL.md 中出现的 feishu_* 工具名
src/core/tool-scopes.ts 的权限映射
```

生成：

```text
resources/feishu-tools/openclaw-lark-tool-contracts.json
```

用途：

- 发现上游新增/删除/改名的工具。
- 发现 Skill 文档提到但 contracts 没声明的工具。
- 发现 Chat-Codex 已实现工具和上游工具名发生偏移。
- 生成测试快照，提示需要人工评估。

### 第三阶段：按领域适配工具

不要一次性适配全部 `feishu_*` 工具。按用户价值和安全边界分阶段：

1. 只读工具
   - `feishu_fetch_doc`
   - `feishu_im_user_get_messages`
   - `feishu_im_user_search_messages`
   - `feishu_drive_file.get_meta`

2. 低风险写工具
   - `feishu_create_doc`
   - `feishu_update_doc` 的 append 模式

3. 高风险写工具
   - 删除文件
   - 移动文件
   - 批量改多维表格
   - 修改任务/日历邀请

高风险工具必须有 Chat-Codex 自己的审批策略，不能只依赖 Codex 原本的 shell/file approval。

### 更新流程

后续进入工具适配阶段后，上游更新流程建议固定为：

```bash
git -C references/openclaw-lark pull --ff-only
npm run sync:feishu-skills
npm run sync:feishu-tool-contracts
npm run check:feishu-tool-contracts
npm test
```

`check:feishu-tool-contracts` 应输出：

```text
新增工具：
- feishu_xxx

删除工具：
- feishu_yyy

Chat-Codex 已实现但上游未声明：
- feishu_old

Skill 引用但 contracts 未声明：
- feishu_doc_media
```

这样工具代码更新时，适配压力会集中在少量差异列表，而不是人工翻完整插件源码。

## 权限与安全

`/feishu` skills 引导阶段：

- 不执行飞书 API。
- 不需要额外审批。
- 不读取飞书 secret。
- 可以在微信、飞书、Terminal 等任意渠道使用，但推荐在飞书 route 中使用。

未来工具执行阶段：

- 工具执行必须绑定当前 route 的 channel/account。
- 多个飞书机器人账号必须隔离凭证。
- Codex 不应看到 appSecret 或 access token。
- 写操作默认需要审批。
- 群聊中工具审批必须结合群权限设计，普通成员不能随意触发高风险写操作。
- 所有工具调用日志必须脱敏。

## `/help` 与 `/status`

第一阶段 `/help` 增加：

```text
/feishu <任务>
- 使用飞书 Skills 引导 Codex 处理本轮任务；Codex 会按任务需要自行阅读相关 Skill 文档。
```

`/status` 可选展示：

```text
- 飞书 Skills: available（9 个）
- 飞书 Tools: not enabled
```

如果后续加入 `/feishu on/off`，`/status` 再展示当前 route 的飞书引导模式：

```text
- 飞书能力模式: enabled
```

## 测试要求

第一阶段测试：

- 解析 skills manifest。
- 解析 `SKILL.md` frontmatter。
- skills 目录缺失时 `/feishu` 给出明确错误。
- `/feishu <任务>` 投递给 Codex 的内容包含用户任务、Skill 根目录和 Skill 索引。
- 注入内容不包含 appSecret、token、state 目录凭证文件路径。
- `/help` 展示 `/feishu <任务>`。
- Terminal/Mock/飞书/微信 route 下命令行为一致，不把 `/feishu` 写成飞书渠道硬分支。

同步脚本测试：

- source commit 记录正确。
- skill name 唯一。
- `alwaysActive` 能被识别。
- `references/` 子目录能被复制。
- manifest 快照稳定。

未来工具适配测试：

- 工具契约快照测试。
- 每个工具 schema 单测。
- 使用 fake Feishu client 做成功/失败/权限不足测试。
- 写操作审批测试。
- 多账号凭证隔离测试。
- route A 的飞书工具调用不能使用 route B 的账号。

## 实施顺序

1. 新增 skills 同步脚本和 `resources/feishu-skills/openclaw-lark/`。
2. 新增 manifest 解析模块。
3. 新增 `/feishu <任务>` 命令解析和 Codex 输入注入。
4. 更新 `/help`。
5. 可选更新 `/status` 展示 skills 可用性。
6. 补齐测试。
7. 后续单独设计 Feishu Tool Adapter，不和第一阶段混做。

## 设计取舍

第一阶段选择 “prompt path injection” 而不是 “原生 Codex skill root 注册”，因为它实现快、风险低、不修改用户 Codex 配置，也不依赖尚未确认的 app-server 动态 skill root 能力。

第一阶段不适配真实工具，是为了避免用户误以为 `/feishu` 已经能改飞书文档、查日历或操作多维表格。真实工具需要独立权限模型、凭证隔离和审批策略，应该单独做。

后续工具适配不应追求一次性复刻 OpenClaw 飞书插件，而应从 Chat-Codex 用户最需要的飞书能力开始，按只读到写入、低风险到高风险逐步增加。
