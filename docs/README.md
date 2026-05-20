# 项目文档索引

这个目录存放 Chat-Codex 的设计和执行依据。后续开发时先读本文档，再进入具体需求或技术设计。

## 文档用途

- `requirements.zh-CN.md`
  中文需求文档。说明这个项目要做什么、不做什么、支持哪些微信命令、状态、审批、安全和可靠性要求。

- `technical-design.zh-CN.md`
  中文技术设计。说明中间件架构、Node.js + TypeScript 技术选择、Codex adapter、Weixin adapter、审批流、阶段性输出、状态存储和分阶段实现路线。

- `channel-delivery-policy.zh-CN.md`
  中文渠道投递策略设计。说明 `ChannelDeliveryPolicy` 如何按渠道控制 task-start、progress、`/progress` 和 refresh 命令，避免 Bridge Core 写具体平台分支。

- `inbound-media-design.zh-CN.md`
  入站图片和文件适配设计。说明微信/飞书图片如何下载保存到用户目录 `~/.chat-codex/uploads/`、图片-only 如何由 `【Chat-Codex中间件提醒】` 询问用户意图、图文消息如何投递给 Codex、执行中收到图片时如何通过结构化 steer 或 pending media 处理，以及 Codex app-server `localImage` 的结构化输入边界。

- `development-and-test.zh-CN.md`
  中文开发与测试规范。说明代码分层、质量要求、每个功能的自测要求、测试报告目录和报告格式。

- `agent-guide.zh-CN.md`
  Agent 开发指南。由旧版根 README 拆出，面向 coding agent，汇总阅读顺序、核心规则、目录边界、模块拆分、测试和提交要求。

- `git-management.zh-CN.md`
  中文 Git 管理规范。说明仓库边界、忽略规则、本地参考仓库和提交要求。

- `weixin-ret2-context-token.zh-CN.md`
  微信 `sendmessage ret=-2` 与 `context_token` 问题说明。包含大白话解释、专业排障判断、现有缓解策略和后续优化方向。

- `multi-channel-design.zh-CN.md`
  多渠道接入与会话绑定设计。说明多渠道同时对话、routeKey、session 唯一归属、ChannelRegistry、并发模型和后续实施顺序。

- `local-state-persistence.zh-CN.md`
  本地文件持久化设计。说明渠道实例、账号目录、route/session 绑定、session owner 全局唯一约束和第一阶段 JSON 文件落地路径。

- `cli-interaction-redesign.zh-CN.md`
  CLI 交互重设计历史文档。记录上一轮普通 CLI 首页、子模式、返回/退出和首个 route 绑定语义修复方案。

- `cli-core-interaction-design.zh-CN.md`
  当前 CLI/TUI 核心交互设计。说明微信当前一个账号 + 一个主聊天绑定 session，飞书一个机器人 + 多个 `chat_id` 分别绑定 session；工作目录是新 session 的一等配置；TUI 只负责展示，业务动作必须进入 actions/services。

- `ink-tui-interaction-design.zh-CN.md`
  Ink TUI 交互设计。说明 `chat-codex` TUI 的页面结构、键盘快捷键、状态栏、微信/飞书配置流程、聊天绑定流程、工作目录设置、启动衔接和实施顺序。

- `tui-core-functionality-followups.zh-CN.md`
  TUI 核心功能完善设计。说明渠道删除、渠道备注、添加时间、禁用/删除绑定语义、session 最近活跃时间和运行期日志完整展示。

- `tui-visual-redesign.zh-CN.md`
  TUI 视觉重设计方案。说明全屏布局、橙黄主色配色系统、色彩常量、图标系统、各页面线框图、信息面板分区、两栏布局规则、响应式适配和改动文件边界。不涉及按键逻辑或业务逻辑改动。

- `runtime-single-instance-lock.zh-CN.md`
  运行期单实例锁设计。说明如何避免同一个本地状态目录下重复启动多个中间件实例，导致通讯渠道重复消费和状态并发写入。

- `local-timezone-display-design.zh-CN.md`
  本机时区时间展示统一设计。说明内部时间继续用 UTC ISO 存储，用户可见时间统一按当前运行机器时区自动展示，不提供手动时区覆盖。

- `compact-command-design.zh-CN.md`
  `/compact` 上下文压缩命令设计。说明微信/飞书聊天侧如何确认并触发当前 route/session 的 Codex 上下文压缩、执行中状态和命令阻断规则。

- `new-chat-app-conversation-design.zh-CN.md`
  `/new chat` Codex App 对话会话设计。该能力当前保留为隐藏实现，不在聊天 `/help` 或 README 中公开展示；文档记录此前的技术验证、route/session 绑定语义、`thread/name/set` 标题同步和 preview 补齐方案。

- `session-context-refresh-design.zh-CN.md`
  Session 上下文外部更新检测与发送前刷新设计。说明独立模式下 Chat-Codex 如何在用户发消息前检测电脑端 Codex CLI 是否更新了同一 session，并在开关启用时重新加载后再投递消息；该方案是懒刷新，不是实时共享 app-server 模式，并要求兼容 macOS/Windows。

- `session-list-pagination-design.zh-CN.md`
  Session 列表展示与分页设计。说明 `/sessions`、`/session`、`/sessions all`、`/resume` 和 `/use` 如何统一列表格式、排序、分页和编号选择交互，避免历史 session 很多时刷屏。

- `progress-noise-control-design.zh-CN.md`
  Codex 进度噪声控制设计。说明如何识别命令长输出、等待转圈、低信息增量，并通过 app-server adapter 摘要化和 Bridge delivery 限流，避免微信、飞书和 TUI 日志被进度刷屏。

- `route-pairing-trust-design.zh-CN.md`
  渠道会话配对信任设计。说明微信/飞书新聊天 route 如何通过本机 TUI/终端配对码完成信任，未配对前不创建 session、不执行命令，只回复不含配对码的配对引导，并按 routeKey 持久化已信任聊天。

- `windows-compatibility.zh-CN.md`
  Windows Codex 接入兼容性设计。说明 Windows 下 Codex CLI 子进程解析、npm shim、`spawn codex ENOENT` 已知问题、`CHAT_CODEX_BIN` 覆盖入口，以及传给 Codex 的本地路径边界。

- `windows-codex-cli-troubleshooting.zh-CN.md`
  Windows Codex CLI 用户排障指南。说明如何检查 `codex --version`、`where.exe codex`、Chat-Codex 首页的 Codex CLI 状态，以及如何用 `CHAT_CODEX_BIN` 指定 `codex.cmd`。

- `bridge-modularization-design.zh-CN.md`
  Bridge 模块化拆分设计。说明如何在保留现有全部功能的前提下，把当前单体 `bridge.ts` 拆成 command router、session flow、route queue、steering、delivery、status 文案和格式化工具等模块，并要求拆分前保留旧文件对照备份。

- `large-core-file-modularization-design.zh-CN.md`
  大型核心文件模块化拆分设计。说明如何继续拆分 `app-server-codex-adapter.ts` 和 `serve.ts`，并沿用“原文件先改名备份、再创建同名入口逐步拆分”的迁移方式。

- `feishu-adapter-design.zh-CN.md`
  飞书适配设计。说明第一阶段如何用飞书 WebSocket 长连接接入私聊文本消息，并默认投递 Codex 进度。

- `feishu-user-name-cache-design.zh-CN.md`
  飞书名称展示与群聊名册设计。说明私聊不解析名称、群聊如何按 `chat_id + open_id` 维护手工成员名册，并统一运行日志、TUI 列表和群聊发言人前缀的兜底格式。

- `feishu-group-chat-design.zh-CN.md`
  飞书群聊接入与权限设计。说明群聊 route、@bot 触发、一次配对、超级管理员/管理员/小黑屋、审批权限、状态持久化和分阶段实施边界。

- `requirements.md`
  早期英文需求草稿。保留作参考，不作为当前主设计依据。

- `../README.md` 和 `../README.en.md`
  项目根目录的默认简体中文 README 和英文 README，面向项目介绍、能力概览、开发快速开始、技术架构和聊天命令。

## 当前项目定位

本项目是一个独立轻量中间件：

```text
Codex <-> Middleware Core <-> Channel Adapter <-> Concrete Channel
```

当前真实渠道是：

```text
Codex <-> Middleware Core <-> WeixinAdapter <-> openclaw-weixin extracted communication capability <-> WeChat
Codex <-> Middleware Core <-> FeishuAdapter <-> Feishu Open Platform <-> Feishu
```

明确不做：

- 不依赖 OpenClaw CLI。
- 不启动 OpenClaw gateway。
- 不要求 OpenClaw host。
- 不使用 OpenClaw channel runtime。
- 不把本项目做成 OpenClaw 插件。

`openclaw-weixin` 只作为微信通讯能力的源码、协议和适配来源。

重点：中间件核心不对死 `openclaw-weixin`。后续其他渠道只需要实现同一套通用 Channel Adapter 协议。

## 本地密钥文件

真实渠道测试需要的 app secret、token、cookie 等只放在本机，不提交到仓库。推荐放在：

```text
secrets/<channel>.local.md
```

例如飞书机器人测试密钥可放在：

```text
secrets/feishu.local.md
```

`secrets/` 已加入 `.gitignore`。提交前必须确认 `git status` 不包含任何真实密钥文件；仓库文档只记录变量名、路径和示例格式，不记录真实 secret。

## 推荐阅读顺序

1. 读 `requirements.zh-CN.md`，确认项目目标和边界。
2. 读 `technical-design.zh-CN.md`，确认架构和分阶段路线。
3. 读 `channel-delivery-policy.zh-CN.md`，确认不同渠道的消息投递策略边界。
4. 读 `inbound-media-design.zh-CN.md`，确认微信/飞书入站图片、pending media、Codex `localImage` 和文件处理边界。
5. 读 `multi-channel-design.zh-CN.md`，确认多渠道 route/session 绑定、并发和配置交互设计。
6. 读 `local-state-persistence.zh-CN.md`，确认本地文件持久化、渠道账号目录和 session owner 约束。
7. 读 `cli-core-interaction-design.zh-CN.md`，确认当前 CLI/TUI 首页、渠道配置、微信主聊天绑定和飞书多 chat_id 绑定边界。
8. 做 TUI 相关开发时读 `ink-tui-interaction-design.zh-CN.md`，确认 Ink 页面、快捷键、状态栏和实现顺序。
9. 做 TUI 核心功能补齐时读 `tui-core-functionality-followups.zh-CN.md`，确认渠道删除、备注、添加时间、session 活跃时间和运行日志全文展示语义。
10. 做 TUI 视觉样式重设计时读 `tui-visual-redesign.zh-CN.md`，确认配色系统、全屏布局、各页面线框图和图标规范，不修改按键逻辑。
11. 做启动/运行期相关开发时读 `runtime-single-instance-lock.zh-CN.md`，确认重复启动检测、运行锁、心跳和残留锁清理语义。
12. 做用户可见时间展示相关开发时读 `local-timezone-display-design.zh-CN.md`，确认 UTC 存储、本机时区展示和不提供手动覆盖的边界。
13. 做 `/compact` 聊天命令时读 `compact-command-design.zh-CN.md`，确认确认流程、当前 route/session 作用域、执行中通知和命令阻断规则。
14. 做隐藏的 `/new chat` 实现、Codex App 对话列表可见性、App thread 标题同步或首条 prompt 创建对话时读 `new-chat-app-conversation-design.zh-CN.md`。
15. 做 `/sessions`、`/session`、`/sessions all`、`/resume` 或 `/use` 会话列表/选择交互时读 `session-list-pagination-design.zh-CN.md`。
16. 做 Codex 进度投递、命令输出摘要或 TUI 运行日志刷屏治理时读 `progress-noise-control-design.zh-CN.md`。
17. 做微信/飞书新聊天配对、route 信任、未授权聊天拦截或信任持久化时读 `route-pairing-trust-design.zh-CN.md`。
18. 做 Windows 下 Codex CLI 解析、Codex 子进程启动或传给 Codex 的本地路径适配时读 `windows-compatibility.zh-CN.md`。
19. 做 Bridge 核心拆分时读 `bridge-modularization-design.zh-CN.md`，确认备份旧文件、模块边界、分阶段迁移和行为不变验收标准。
20. 做 app-server adapter 或 serve 入口拆分时读 `large-core-file-modularization-design.zh-CN.md`，确认原文件改名备份、薄入口、新模块边界和逐模块测试要求。
21. 做飞书运行日志、聊天绑定列表或群聊发言人前缀时读 `feishu-user-name-cache-design.zh-CN.md`，确认私聊 open_id 兜底、群聊手工名册和展示格式。
22. 读 `cli-interaction-redesign.zh-CN.md`，了解上一轮普通 CLI 重构背景和历史设计。
23. 读 `development-and-test.zh-CN.md`，确认开发和测试报告要求。
24. 读 `git-management.zh-CN.md`，确认提交边界和忽略规则。
25. Agent 继续读 `agent-guide.zh-CN.md`，确认执行规范。
26. 需要 Codex 协议或微信插件源码细节时，先读 `../references/README.md`，按里面的说明拉取本地参考源码。

## 分阶段工作顺序

1. 先实现 Codex 和中间件通信。
2. 再实现中间件和 Weixin Adapter 通信。
3. 最后打通完整微信到 Codex 的双向链路。
4. 再补日志、权限、重启恢复、版本适配和异常处理。

每一步都必须自测，并把中文测试报告放入 `../reports/tests/`。

## 当前实现入口

第一阶段本地验证入口：

```bash
npm test
npm run cli:mock
npm run cli:terminal:mock
npm run cli:terminal:codex
```

其中 `cli:terminal:mock` 是本地终端通道加 MockCodex，作用是模拟微信消息进入中间件；`cli:terminal:codex` 会先检测真实 Codex CLI，然后让用户先选择会话、再选择权限模式，默认通过 `codex app-server` 与真实 Codex 通信。需要回退到非交互 CLI JSONL 时，可传 `--codex-adapter exec`。

真实 Codex 模式在创建新会话时会展示默认工作目录，用户可输入其他目录；目录不存在时会自动创建。选择历史会话时不询问新工作目录，而是使用 Codex 历史 session 元数据里的原工作目录。

第二阶段本地验证入口：

```bash
npm run chat-codex
npm run cli:chat-codex
npm run cli:weixin:status
npm run cli:weixin:login
npm run cli:feishu:status
```

`npm run chat-codex` 是当前推荐主入口，TTY 下默认进入 Ink TUI；`npm run cli:chat-codex` 是同等别名。需要普通 prompt fallback 时可传 `-- --no-tui`。微信和飞书不再暴露单渠道 Codex 启动入口，统一入口会按本地配置启动所有已启用渠道。

`weixin login` 已具备二维码登录入口，会在终端渲染二维码并保留备用链接。真实微信通道 + Codex 统一通过 `npm run chat-codex` 启动；默认 app-server 模式可以把 Codex command/file/permissions 审批请求推送到微信，并由 `/OK` 或 `/NO` 回写 Codex。真实扫码登录完成后要追加真实微信通道测试报告。

`feishu status` 会读取 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 等环境变量并检查机器人身份；飞书私聊文本通道 + Codex 统一通过 `npm run chat-codex` 添加机器人并启动服务。交互添加的飞书 App Secret 会写入本机 `~/.chat-codex/state/channels/feishu/.../credentials.local.json`，也可以放在本机环境变量或 `secrets/`；不要写入 Git 跟踪文件。
