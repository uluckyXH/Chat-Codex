# 项目文档索引

这个目录存放 Chat-Codex 的设计和执行依据。后续开发时先读本文档，再进入具体需求或技术设计。

## 文档用途

- `releases/v0.1.6.zh-CN.md`
  Chat-Codex 0.1.6 发布说明，沿用 0.1.5 的安装／升级、新增、优化、修复及相关提交格式；覆盖上次发布以来的 Codex、微信、飞书与旁白改动。发布验证与实际结果见 `reports/tests/2026-10-16-release-0.1.6.md`。

- `2026-10-15-codex-commentary-fragmentation-fix.zh-CN.md`
  Codex 旁白碎片化修复：按 item 完成发布全文，保留合并正文，按消息身份去重，前后台通过投递回执处理完整兜底。已完成 721 项全量回归；测试结果见 `reports/tests/2026-10-15-codex-commentary-fragmentation-fix.md`，故障电脑更新后仍需现场核验。

- `2026-10-15-codex-commentary-fragmentation-analysis.zh-CN.md`
  Codex 旁白被拆成大量短日志的修复前源码排查：对比官方 delta／item 完成语义，复现提前刷新、完成全文被跳过、brief 遗漏和 commentary-only 兜底残片。保留 179 项既有测试及 19 组诊断探针证据；当前实现见上述修复文档。

- `2026-10-15-feishu-reply-context-adaptation.zh-CN.md`
  飞书入站回复原文适配：私聊／群聊按直接父消息 ID 读取文本、Markdown 和附件，接入现有 Codex 引用输入；覆盖权限后加载、命令／三题问答隔离、失败降级和本地引用日志。已完成 655 项全量回归，真实租户待验收；适配前检查点 `2aa8101` 已推送。

- `2026-10-15-quote-diagnostics.zh-CN.md`
  引用消息日志改进：本条／引用消息 ID、缓存来源和失败分类、局部选择及附件恢复状态、发送回执关联。已完成本地实现及 637 项全量回归；另记录日志分组、筛选和发送时间线的后续方向。

- `2026-10-15-weixin-2.4.10-protocol-implementation.zh-CN.md`
  微信新版插件与协议对齐进度：大整数消息 ID、服务端回执、文本与局部引用、隔离 SQLite 缓存、受管媒体副本、账号服务地址及网络诊断。逐项记录测试结果；长文本与发送恢复仍单列。

- `2026-10-15-codex-cli-protocol-implementation.zh-CN.md`
  Codex CLI 0.162.1 协议中间件的分项实现、使用方式与验收结果；已完成本地验证，后续微信 2.4.10 适配另有实施文档，长文本与其他渠道 SDK 升级单列。

- `2026-10-15-openclaw-weixin-commentary-analysis.zh-CN.md`
  OpenClaw 中途摘要到微信的源码链路。区分 Codex commentary、宿主摘要缓冲、可编辑预览与微信普通 TEXT，说明不能据此承诺免限流。用户已确认取消微信摘要专项，继续新版协议适配；分析作为参考保留。

- `2026-10-15-codex-cli-compatibility-audit.zh-CN.md`
  实施前的 Codex CLI 能力审计。核实参考 main 与稳定版 0.162.1，比较默认／实验 schema，记录改造前 89 项定向测试与 8 项现状探针；已补齐项目的最新状态以实施进度为准。

- `2026-10-15-codex-cli-adaptation-plan.zh-CN.md`
  上述审计的分阶段实施计划。协议契约、核心交互和能力适配已完成本地验收；保留后续渠道升级、长文本和真实模型／双渠道验收工作包。

- `2026-10-15-channel-long-text-delivery-design.zh-CN.md`
  微信／飞书长文本与新版适配设计。明确首段一次提示、按平台字节预算自动分段、超过 8 段的最终结果改发文件、部分失败和本机原文保存；区分微信通用 prepare failed 与飞书明确超长错误，记录最新 SDK 升级的独立验证范围。当前仅设计，尚未实现。

- `2026-10-15-weixin-prepare-failed-analysis.zh-CN.md`
  微信任务约 5 分钟后 `ret=-2 errcode=0 prepare failed` 的问题记录和解决方案。记录 Codex 参考更新、微信 2.4.10／飞书 2026.7.16 源码对照、旧上下文与未分段正文的证据、6 次重试及失败结果不可补发的本地复现，以及最新上下文缓存、分段、结构化错误和可靠补发的待实施方案。

- `requirements.zh-CN.md`
  中文需求文档。说明这个项目要做什么、不做什么、支持哪些微信命令、状态、审批、安全和可靠性要求。

- `technical-design.zh-CN.md`
  中文技术设计。说明中间件架构、Node.js + TypeScript 技术选择、Codex adapter、Weixin adapter、审批流、阶段性输出、状态存储和分阶段实现路线。

- `channel-delivery-policy.zh-CN.md`
  中文渠道投递策略设计。说明 `ChannelDeliveryPolicy` 如何按渠道控制 task-start、progress、`/progress` 和 refresh 命令，避免 Bridge Core 写具体平台分支。

- `scheduled-task-channel-delivery-design.zh-CN.md`
  定时任务与精准渠道投递设计草案。区分 Codex App 原生 Scheduled tasks 与 app-server 边界，设计以动态工具触发、Chat-Codex 中间件持久化、route/session 精确绑定的多渠道定时任务；覆盖一次性/周期规则、task session 隔离、run-scoped 审批/输入路由、前台并发优先、`/timer` 编号详情、TUI 管理、重启恢复、精准投递，以及“调度核心 -> Codex 适配 -> 渠道 -> 命令/TUI”的完整开发计划。

- `weixin-plugin-2.4.6-upgrade-assessment.zh-CN.md`
  微信插件 2.4.6 升级兼容性评估。说明本项目不直接依赖 OpenClaw 微信插件，盘点 2.4.4–2.4.6 的实际差异、当前已覆盖能力、必须适配的可中断长轮询、建议采用的服务端轮询超时，以及明确不纳入本轮的 OpenClaw 宿主和微信 progress 能力。

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

- `tui-app-modularization-design.zh-CN.md`
  TUI `app.tsx` 模块化拆分计划。说明如何在保留现有页面、快捷键、微信/飞书配置、绑定、配对、权限、上下文刷新和工作目录功能的前提下，把 TUI controller、输入处理、动作编排、导航 helper 和 screen renderer 拆出。

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

- `context-compaction-and-refresh-reply-delivery-design.zh-CN.md`
  上下文压缩与刷新回复投递设计。说明自动 `contextCompaction` 如何绕过普通 progress 策略投递到对应 route，以及 `/context-refresh reload` 如何通过 metadata-only resume 和有界分页同步最后一条最终 assistant 回复。

- `runtime-event-and-cache-retention-analysis.zh-CN.md`
  运行期事件、审批与缓存保留分析。完整盘点 Codex 事件、turn 队列、审批、`request_user_input`、渠道缓存、TUI 和 state 文件的保留边界；明确 pending approval 绝不按时间过期，terminal approval 才能清理，并记录当前需要后续收敛的队列和卡片生命周期问题。

- `codex-new-version-adaptation-design.zh-CN.md`
  新版 Codex 适配设计。基于最新 `references/openai-codex` app-server schema 盘点 Chat-Codex 已实现能力、新版协议变化、短中长期适配优先级、风险和测试计划。

- `codex-2026-07-latest-adaptation-design.zh-CN.md`
  Codex 2026-07 最新模型与协议适配设计。基于官方 GPT-5.6 最新模型页和 `references/openai-codex` HEAD `5c19155c`，说明模型动态元数据、开放 reasoning effort、service tier、协议漂移稳定性和后续新功能候选。

- `codex-current-compatibility-audit-plan.zh-CN.md`
  本轮最新版 Codex 兼容性审计与实施设计。以最新官方源码为主证据，记录 Chat-Codex 当前能力、模型适配、app-server 协议差异、渠道取舍、实施优先级和验收计划；第一轮源码审计已完成，协议项 1（`writeStdin`）的中间件、微信文字链路和飞书私聊两按钮卡片已完成自动化实现，其余项待逐项讨论。

- `2026-09-05-codex-ddf04ad26789-app-server-protocol-compatibility.zh-CN.md`
  2026-09-05 基于 Codex 源码 `ddf04ad26789d040f9ef6a96736f76602e35a6cc` 的 app-server 协议专用适配清单。逐项比对当前本地 Codex 源码与 Chat-Codex 已有能力，明确新增 RPC、通知、审批、用户输入、上下文刷新和 item 字段哪些必须适配、哪些仅分类、哪些当前不开放；不讨论模型或新产品功能。

- `2026-09-06-codex-ddf04ad26789-recap-channel-delivery-adaptation-analysis.zh-CN.md`
  2026-09-06 基于 Codex 源码 `ddf04ad26789d040f9ef6a96736f76602e35a6cc` 的 Recap（`/recap`）独立适配分析。明确它是官方 TUI 的用户可见回顾、不是 app-server 推送，也不是 `/compact`；记录 Chat-Codex 如何用隔离临时 thread 生成内容并精确投递回原微信/飞书 route，以及手动优先、自动触发待确认的边界。

- `2026-09-30-codex-app-server-json-rpc-large-payload-analysis.zh-CN.md`
  Codex app-server 大型 JSON-RPC 解析失败排查与修复。记录 `Unterminated string in JSON` 的本地错误链路、Node 大行验证、完整历史读取放大点、分页历史迁移、受限诊断、同 session 恢复与不自动重放任务的实现和验证。

- `codex-writestdin-channel-adaptation-design.zh-CN.md`
  Codex `writeStdin` 终端输入审批的微信/飞书渠道适配设计与进度。记录微信文字审批链路、飞书私聊两按钮卡片、通用 `cancel` decision 扩展、完整输入展示边界、自动化结果与待补的真实渠道测试。

- `codex-reference-81da9deb0-compatibility.zh-CN.md`
  Codex 参考版本 `81da9deb0` 兼容性评估。以保持本地 Chat-Codex 正常运作为目标，记录当前 app-server 协议结论、远程执行环境与 `wait_for_environment` 的适配边界、已完成的协议分类和后续实际 CLI 升级门禁。

- `codex-invalid-cwd-operation-not-permitted.zh-CN.md`
  Codex `invalid cwd: Operation not permitted (os error 1)` 排障与适配说明。说明 app-server 子进程 cwd、历史 session cwd、macOS 隐私权限、外置盘挂载和新版 environment/runtime workspace roots 对 Chat-Codex 的影响；记录已实现的原始错误诊断，以及后续按证据推进的 cwd 适配边界。

- `codex-permission-modes-alignment-design.zh-CN.md`
  Codex 权限模式对齐设计。说明 Chat-Codex 用户可见权限只收敛为 `approval`、`approve-for-me`、`full` 三个模式，`read-only` 只作为底层诊断信息，不作为聊天命令或默认 TUI 选项。

- `codex-app-server-notification-routing-design.zh-CN.md`
  Codex app-server 通知路由设计。说明 thread archive/close/name update、guardianWarning、warning、configWarning、model reroute/verification 等通知如何在聊天渠道、状态和运行日志之间分流；安全通知要求完整推送，`item/tool/requestUserInput` 另行讨论。

- `codex-app-server-reconnect-notification-design.zh-CN.md`
  Codex app-server 重连提示独立通知设计。说明如何把 `Reconnecting... n/m` 从普通 progress 中结构化识别出来，保留本地进度可见性，并在最后一次重连尝试时通过 `codex.notification kind=connection` 主动通知微信/飞书。

- `codex-request-user-input-design.zh-CN.md`
  Codex `item/tool/requestUserInput` 聊天交互设计。说明 `/a数字` 短命令、单选加补充说明、群聊发起人回答、pending input 锁、30 分钟超时和 secret 拒绝；MCP 仍暂不适配，仅对 MCP/app tool approval 兼容路径做识别和自动取消，防止误授权。

- `session-list-pagination-design.zh-CN.md`
  Session 列表展示与分页设计。说明 `/sessions`、`/session`、`/sessions all`、`/resume` 和 `/use` 如何统一列表格式、排序、分页和编号选择交互，避免历史 session 很多时刷屏。

- `codex-app-server-thread-list-sessions-design.zh-CN.md`
  `/sessions` 对齐 Codex app-server `thread/list` / `thread/read` 的设计。说明如何在不改变现有聊天命令、分页、编号选择和 owner 规则的前提下，把官方 thread 元数据接入 `CodexAdapter.listSessions()`，并保留本地发现 fallback。

- `progress-noise-control-design.zh-CN.md`
  进度噪声控制设计。说明如何识别命令长输出、等待转圈、低信息增量，并通过 app-server adapter 摘要化和 Bridge delivery 限流，避免微信、飞书和 TUI 日志被进度刷屏。

- `progress-local-observability-design.zh-CN.md`
  Codex 进度本地实时可观测、渠道节流投递与 channel-aware `/progress realtime` 设计。说明如何把本地 TUI / transcript 的实时进度显示与微信、飞书聊天渠道的节流合并投递解耦；微信不开放 realtime，飞书保留 realtime，并要求实现阶段按开发规范补测试和中文测试报告。

- `progress-mode-simplification-design.zh-CN.md`
  进度模式精简设计。说明为什么用户可见 `/progress` 模式收敛为微信 `silent/brief`、飞书 `realtime/silent/brief`，并通过 `ChannelDeliveryPolicy.allowedProgressModes` 隐藏 `detailed/tools` 但保留内部能力。

- `codex-commentary-delivery-design.zh-CN.md`
  Codex `commentary` 旁白投递设计。说明为什么不能继续把旁白混进普通进度，如何新增独立 `assistant.commentary` 事件、让 `brief` 和 `/plan` 默认展示旁白，并在 README 中说明微信消息投递限制和 `/fff` 静默刷新作用。

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

- `app-server-codex-adapter-refactor-design.zh-CN.md`
  Codex app-server adapter 针对性重构设计。基于当前 1037 行主文件和既有 `src/codex/app-server/` 模块，盘点剩余职责，规划 policy store、compact controller、server request controller、status notification handler、session lifecycle 等分阶段拆分方案和测试要求。

- `feishu-adapter-design.zh-CN.md`
  飞书适配设计。说明第一阶段如何用飞书 WebSocket 长连接接入私聊文本消息，并默认投递普通文本进度。

- `feishu-direct-approval-card-design.zh-CN.md`
  飞书私聊审批卡片设计。说明通用审批卡片协议、`card.action.trigger` 回调、操作者与 route 校验、文本命令回退、模块边界和真实飞书补测要求。

- `feishu-plugin-2026.7.9-upgrade-assessment.zh-CN.md`
  飞书 OpenClaw 插件升级评估。对比 `2026.5.13` 与 `2026.7.9`，确认当前私聊 WebSocket、原生 Markdown、媒体和回复链路无需运行时代码适配，并记录群聊/thread、交互卡片、SDK 更新和飞书工具的后续边界。

- `feishu-user-name-cache-design.zh-CN.md`
  飞书名称展示与群聊名册设计。说明私聊不解析名称、群聊如何按 `chat_id + open_id` 维护手工成员名册，并统一运行日志、TUI 列表和群聊发言人前缀的兜底格式。

- `feishu-group-chat-design.zh-CN.md`
  飞书群聊接入、管理员与黑名单当前设计（2026-10-15 已实现，自动化验证已完成，真实租户验收待执行）。明确每群唯一超管、多名普通管理员；管理员可审批、发文件、拉黑／解禁普通成员，不能操作超管、其他管理员或自己。覆盖目标层级、封禁来源、撤权复查、群命令和 TUI、审批并发、文件授权、schema 迁移及真实群聊验收；替代早期“管理员只预留”的范围。记录用户授权自主选择实现方式、不机械受旧项目约束限制，并以显式策略接入和其他渠道回归保证兼容性。

- `feishu-group-chat-guide.zh-CN.md`
  群聊开启、配对、登记、管理员和黑名单命令、本机 TUI、迁移备份及真实群聊验收步骤。证据见 `reports/tests/2026-10-15-feishu-group-implementation.md`。

- `feishu-skills-command-design.zh-CN.md`
  `/feishu` 飞书能力引导与工具适配讨论稿。说明如何把 OpenClaw 飞书插件的 skills 同步为 Chat-Codex 可发布资源，如何通过 `/feishu <任务>` 给 Codex 注入飞书 Skill 索引，以及后续真实 `feishu_*` 工具调用如何按契约、凭证隔离和审批策略逐步适配；当前仍是待讨论状态，尚未进入实现承诺。

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
10. 拆分 TUI `app.tsx` 时读 `tui-app-modularization-design.zh-CN.md`，确认 controller、输入处理、动作编排、导航 helper 和 screen renderer 的边界。
11. 做 TUI 视觉样式重设计时读 `tui-visual-redesign.zh-CN.md`，确认配色系统、全屏布局、各页面线框图和图标规范，不修改按键逻辑。
12. 做启动/运行期相关开发时读 `runtime-single-instance-lock.zh-CN.md`，确认重复启动检测、运行锁、心跳和残留锁清理语义。
13. 做用户可见时间展示相关开发时读 `local-timezone-display-design.zh-CN.md`，确认 UTC 存储、本机时区展示和不提供手动覆盖的边界。
14. 做 `/compact` 聊天命令时读 `compact-command-design.zh-CN.md`，确认确认流程、当前 route/session 作用域、执行中通知和命令阻断规则。
15. 做隐藏的 `/new chat` 实现、Codex App 对话列表可见性、App thread 标题同步或首条 prompt 创建对话时读 `new-chat-app-conversation-design.zh-CN.md`。
16. 做 Codex app-server 新版本协议适配、thread API、server request 稳定性或最新模型适配时读 `codex-new-version-adaptation-design.zh-CN.md` 和 `codex-2026-07-latest-adaptation-design.zh-CN.md`；其中 2026-07 文档更新了 GPT-5.6、开放 reasoning effort、service tier 和最新 schema 漂移判断。
17. 做 Codex app-server notification 路由、安全通知完整推送、thread archive/close 主动提示或模型路由提示时读 `codex-app-server-notification-routing-design.zh-CN.md`。
18. 做 Codex app-server `Reconnecting... n/m` 连接恢复提示、普通进度和强通知分流时读 `codex-app-server-reconnect-notification-design.zh-CN.md`。
19. 做 Codex `item/tool/requestUserInput`、聊天侧 `/a数字` 回答、pending input 锁或群聊发起人回答规则时读 `codex-request-user-input-design.zh-CN.md`。
20. 做 `/sessions`、`/session`、`/sessions all`、`/resume` 或 `/use` 会话列表/选择交互时读 `session-list-pagination-design.zh-CN.md`；如果涉及 Codex app-server `thread/list` / `thread/read` 数据源适配，同时读 `codex-app-server-thread-list-sessions-design.zh-CN.md`。
21. 做进度投递、命令输出摘要或 TUI 运行日志刷屏治理时读 `progress-noise-control-design.zh-CN.md`。
22. 做 Codex 进度本地实时可见、渠道节流投递或 transcript 进度语义调整时读 `progress-local-observability-design.zh-CN.md`。
23. 做 Codex `commentary`、旁白投递、Plan mode 旁白可见性或 commentary-only 兜底时读 `codex-commentary-delivery-design.zh-CN.md`。
24. 做微信/飞书新聊天配对、route 信任、未授权聊天拦截或信任持久化时读 `route-pairing-trust-design.zh-CN.md`。
25. 做 Windows 下 Codex CLI 解析、Codex 子进程启动或传给 Codex 的本地路径适配时读 `windows-compatibility.zh-CN.md`。
26. 做 Bridge 核心拆分时读 `bridge-modularization-design.zh-CN.md`，确认备份旧文件、模块边界、分阶段迁移和行为不变验收标准。
27. 做 app-server adapter 或 serve 入口拆分时读 `large-core-file-modularization-design.zh-CN.md`，确认原文件改名备份、薄入口、新模块边界和逐模块测试要求。
28. 继续拆 `src/codex/app-server-codex-adapter.ts` 时读 `app-server-codex-adapter-refactor-design.zh-CN.md`，确认当前剩余职责、分阶段模块边界和 app-server targeted 测试要求。
29. 做飞书群聊、管理员、小黑屋、群审批或群文件发送时先读 `feishu-group-chat-design.zh-CN.md`；做运行日志、聊天绑定列表或群聊发言人前缀时同时读 `feishu-user-name-cache-design.zh-CN.md`，确认私聊 ID 兜底、群聊手工名册和展示格式。
30. 做飞书私聊审批卡片、`card.action.trigger` 回调、按钮权限或文本回退时读 `feishu-direct-approval-card-design.zh-CN.md`；若是 Codex `writeStdin` 终端输入审批，再读 `codex-writestdin-channel-adaptation-design.zh-CN.md`。
31. 做飞书插件版本升级、SDK 更新、卡片、thread 或群聊能力取舍时读 `feishu-plugin-2026.7.9-upgrade-assessment.zh-CN.md`，先区分独立中间件必须适配的协议变化和 OpenClaw runtime 专属能力。
32. 做 `/feishu` 飞书 skills 引导、skills 同步或后续真实飞书工具调用适配时读 `feishu-skills-command-design.zh-CN.md`。
33. 读 `cli-interaction-redesign.zh-CN.md`，了解上一轮普通 CLI 重构背景和历史设计。
34. 读 `development-and-test.zh-CN.md`，确认开发和测试报告要求。
35. 读 `git-management.zh-CN.md`，确认提交边界和忽略规则。
36. Agent 继续读 `agent-guide.zh-CN.md`，确认执行规范。
37. 需要 Codex 协议或微信插件源码细节时，先读 `../references/README.md`，按里面的说明拉取本地参考源码。
38. 排查运行期内存、事件重复、审批长期等待、审批卡片失效或缓存清理时读 `runtime-event-and-cache-retention-analysis.zh-CN.md`，先区分活跃事件、pending approval、普通 user input 和可安全清理的 terminal state。

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
