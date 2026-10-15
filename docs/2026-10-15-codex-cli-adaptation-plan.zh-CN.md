# 2026-10-15 Codex CLI 与微信／飞书协同适配实施计划

状态：**Codex 协议中间件与微信 2.4.10 协议兼容已完成本地验收**。审计依据：[能力与差异清单](2026-10-15-codex-cli-compatibility-audit.zh-CN.md)。Codex 批次见[实施进度](2026-10-15-codex-cli-protocol-implementation.zh-CN.md)，当时全量 608/608 通过，真实 CLI 0.162.1 握手与只读 API 通过；微信批次见[2.4.10 进度](2026-10-15-weixin-2.4.10-protocol-implementation.zh-CN.md)，最终全量 629/629 通过。真实模型和渠道送达仍需后续验收。

**当前执行顺序（2026-10-15）：Codex 中间件批次完成后，用户授权继续微信新版插件／协议收发兼容和测试。C1 中的上游 2.4.10 协议差异按独立文档逐项实现；长文本、最新上下文／通用有界恢复、C2 飞书 SDK 和真实端到端验收仍待后续处理。微信摘要专项仍取消。**

## 先看实施后能解决什么

本计划改的是 Chat-Codex 对新版 Codex CLI 的接入：把 CLI 的消息、提问和任务状态正确转成微信／飞书里的交互。已有的“暂停任务，给你选项，回复 `/a1` 或 `/a2` 后继续”会继续保留；主要补齐的是新版交互和状态处理。

**整体目标仍是“Codex 协议 + 微信／飞书渠道 + 实际聊天交互”分别验收。** Codex 批次完成不等于渠道升级和真实聊天全链路完成。渠道设计见[渠道设计](2026-10-15-channel-long-text-delivery-design.zh-CN.md)，微信新版协议实现单列记录。

**2026-10-15 用户确认：微信按新版协议做必要适配，不再针对中途自然语言摘要做专项适配，也不以摘要机制解决连续发送限制。** 取消此前微信摘要专用低频合并、发送预算、可编辑预览移植及摘要限流对比实验的必做要求；现有 commentary／silent／brief 行为保留。后续已分别授权 Codex 协议实现与微信新版协议实现，长文本仍暂缓。

| 顺序 | 用日常操作验收 | 对应工作包 |
| --- | --- | --- |
| 先建立检查依据 | 能看出实际使用哪个 CLI 版本、哪些能力已验证；上游接口变化能被检查发现 | S0 |
| 优先修好工作中的消息与提问 | 阶段性答案及时到达；必须回答的问题等待你；可选问题出现时仍能继续工作；回复能对应原问题 | S1-A、S1-B |
| 保持既有进度行为 | 新协议下 commentary 不混入最终结果；既有用户偏好保持；微信不新增摘要专项机制 | S1-A、S1-E |
| 修好结束、重试和目标操作 | 停止显示为中断；上游重试时保留恢复状态；你用 `/goal` 修改目标时正确记录为用户操作 | S1-C、S1-D |
| 再完善会话恢复与功能展示 | 恢复后显示实际模型和权限；会话列表与历史正确；媒体失败有原因 | S2 |
| 最后走真实聊天流程 | 用实际 CLI，在微信、飞书分别验证上述操作，并与长文本分段／文件方案一起验证 | S3 |

选择题的“文字命令交互”已实现于 app-server 模式，本计划没有把它当成从零开发的功能。新版提问有“停下来等你”和“边工作边等你补充”两种行为，后一种已在本批补齐协议和 Bridge 路径，真实模型／渠道仍需后续验收。改造前的现状与示例见[审计文档的使用场景说明](2026-10-15-codex-cli-compatibility-audit.zh-CN.md#先按使用场景理解)。

## 1. 目标与首批范围

以本机已发布稳定 CLI `0.162.1` 为第一验收目标，以参考 main `bb64b894fd67158be0f874872e6d7bfe717e7368` 做前瞻分类。先修复会造成消息丢语义、状态错误、用户问题阻塞和 Goal 来源缺失的问题，再扩展能力展示。

首批结束应达到：微信、飞书上的普通任务、阶段性答案、最终答案、阻塞／非阻塞问题、中断、上游重试和用户 `/goal` 操作具有一致语义；每项都能从固定 schema、mock 测试和真实 CLI 验收记录追溯。

下列阶段保留原设计依据；实际完成范围以各批实施进度为准。S0／S1／S2 已实现；C1 的 2.4.10 协议差异实现单列，C1 剩余通用投递恢复、C2 SDK 和 S3 真实模型／渠道场景仍待后续处理；没有升级渠道 npm 依赖或声明支持全部新增 API。

## 2. 实施约束

- 保持 `Codex → 通用内部事件 → Bridge → ChannelAdapter` 分层。Codex 协议差异不进入微信／飞书条件分支。
- 采用现有三种用户权限模式；服务端受管限制优先，不自动改变用户默认模型、权限、登录方式或开放工具。
- 不自动重放 `turn/start`、steer、审批、writeStdin、Goal 修改等有副作用的操作。
- 保留 `excludeTurns: true`、有界历史分页、坏 JSON fatal recovery；不重新引入 full-history fallback。
- 模型目录、schema 分类、功能已实现、真实环境已验证分别记录，不能相互替代。
- 新代码按职责拆模块，避免继续扩张已经很大的 app-server adapter；遵循[开发规范](development-and-test.zh-CN.md)。

## 3. 工作包与依赖

| 阶段 | 工作包 | 审计项 | 主要产物 | 完成门槛 |
| --- | --- | --- | --- | --- |
| S0 | 固定协议基线与检查 | A01 | 默认／实验 inventory、使用字段 fixture、版本诊断 | 新遗漏有明确分类；已移除／误分类有记录；无参考 clone 时 CI 仍检查 |
| S1-A | 消息语义与最终结果 | A02、A07 的筛选部分 | 内部消息 phase/delivery/questions、即时投递、历史筛选 | partial/async 不冒充 final，不被 silent 吞掉，不重复或跨 route |
| S1-B | 输入生命周期 | A03 | 阻塞与非阻塞问题分流、请求定位 | 非阻塞不锁住运行；回答只作用原请求；旧 server 行为保持 |
| S1-C | 结束和恢复语义 | A04 | completed/interrupted/failed、willRetry | 重试不提前结束，中断不冒充成功，清理只针对原 turn |
| S1-D | Goal 来源 | A05 的来源部分 | user/automatic 来源契约 | 用户命令记录用户来源，自动行为不冒充用户 |
| S1-E | 消息语义与既有摘要链路回归 | A02、A14、渠道设计第 6.1 节 | commentary 与 final 隔离、已有进度偏好回归；微信摘要专项取消 | 新协议不破坏既有行为，不新增微信摘要发送策略 |
| C1 | 微信新版协议对齐 | 渠道设计、故障分析 | 对照 `2.4.10` 的协议差异清单、最新上下文、长度保护与通用有界恢复 | 每项差异有实现或明确不适用依据；文本、媒体、问题及最终结果的真实投递有记录 |
| C2 | 飞书渠道对齐 | 渠道设计 | 对照插件 `2026.7.16` 与 SDK `1.75.0`、进度展示、长文本和审批回归 | SDK 及发布包验证，私聊／群聊交互与实际投递通过 |
| S2-A | 恢复设置与权限 | A06、A12 | 有效设置快照、审批决定集收敛 | 状态如实反映 server，未知决定不扩权 |
| S2-B | 历史、列表与展示 | A05 通知、A07、A08、A11 | 缓存失效、完整列表、媒体失败展示 | 不补投旧答案、不误报成功、不隐瞒列表截断 |
| S2-C | 目录与条件能力 | A09、A10、A13 | 模型元数据、clock responder、模式能力声明 | 动态模型仍可用，条件配置有明确结果，exec 不假装功能对等 |
| S3 | 实装 CLI 与双渠道验收 | 全部 | 中文回归报告、支持范围与发布说明 | 协议、业务和实际投递分别验收后再发布 |

依赖顺序为 `S0 → S1／C1／C2 → S2 → S3`。S1 内消息、输入、阶段摘要和结束语义共享事件模型，应先约定类型，再按小工作包提交。渠道工作包可独立推进，但须与协议改动共同通过 S3；Goal 来源可独立提交，仍需经过同一 schema／测试门槛。

## 4. S0：把“兼容”变成可检查的契约

拟新增职责文件（名称可按实际拆分调整）：

- `tests/fixtures/codex-protocol/`：版本、导出模式、方法分类以及项目实际依赖字段的最小 fixture，不提交整个第三方源码或用户配置。
- `scripts/audit-codex-protocol.mjs`：接收显式 schema 目录，输出新增、移除、字段变化和未分类项；不把缺少参考目录当作自动通过。
- `src/codex/app-server/compatibility.ts`：记录实装版本、能力检查结果和不支持原因；不在每次聊天请求时扫描完整 schema。

实施细节：

1. 固定 `0.162.1` 默认／experimental 快照和当前 main 默认快照的来源、日期及摘要。
2. 对 66 个未分类的实验 client request 按能力族逐个登记，默认不开新功能；对 `currentTime/read` 单独设计响应。
3. 处理两个默认 main 漏项；`thread/rollback` 留在有版本说明的旧版记录，当前目标不再调用；`thread/list` 标为真实已处理。
4. 补字段与枚举检查，至少包括 MessagePhase、ThreadItem.agentMessage、ToolRequestUserInputParams、Turn/ErrorNotification、Goal origin、有效设置和审批决定集。
5. clientInfo.version 从项目包版本生成。区分 executable available、协议可启动、某项功能已验证三种状态，不宣称“最新版完全兼容”。

验收既要检测新增项，也要防止仅修改 classification 就绕过行为测试。旧 CLI 支持范围以实际矩阵确定；历史使用过 `0.159.0` 不构成最低支持版本承诺。

## 5. S1：先修复已有聊天语义

### S1-A · 助手消息

在通用 Codex 事件中保留 `itemId / phase / delivery / questions`，避免全部压进 finalText。建议抽出 `assistant-message-mapper.ts` 管理消息归一化和 item 去重，turn controller 只管理生命周期。

| 消息 | 计划行为 |
| --- | --- |
| commentary | 正确识别消息身份并沿用既有进度偏好；微信不新增摘要专项发送策略，范围见 S1-E |
| partial_answer | item 完整后及时投递；任务继续运行；不作为最后最终回复补投 |
| delivery=async 或带 questions | 及时投递完整消息和问题，保留普通回复／steer 语义；不制造阻塞审批或 RPC 回答 ID |
| final_answer | 只在对应 turn 正常完成的最终投递路径提交一次 |
| phase 缺失 | 保留旧模型兼容路径，不根据自然语言猜阶段 |

delta、item/completed、turn/completed 三层不能各自重复发送同一正文。新事件须贯穿前台 route queue、后台 Goal 和历史补投。新增阶段／异步消息按 item 身份去重，允许两个不同 item 使用相同正文；commentary 沿用既有发送与去重策略。

本批仅接通消息语义，不在 Codex mapper 内截断长正文。[长文本设计](2026-10-15-channel-long-text-delivery-design.zh-CN.md)中的分段、文件和投递状态留待渠道批次实施，之后再做组合验收。

### S1-B · 用户输入

内部 request 新增 isBlocking，缺失时才按旧版阻塞处理。非阻塞请求使用独立问题集合，普通消息继续可达；聊天回答必须携带能定位原问题的编号，不能将当前聊天文本偷偷消费到另一个 turn。

`agentMessage.questions` 与 `item/tool/requestUserInput` 使用不同路由：前者是新的用户消息／steer，后者回复现存 RPC。`serverRequest/resolved` 到达、进程 generation 改变、turn 失败／中断时，精确结束相关状态；迟到答复提示失效，不转给后续请求。是否允许已完成 turn 仍保留非阻塞请求，以服务器请求生命周期为准，不仅凭 turn 状态猜测。

真阻塞输入保留现有受控等待和 30 分钟策略；不把该本地计时器当成服务端授权，非阻塞请求也不以超时自动选项。

### S1-C · turn 状态与错误

为内部结束事件携带明确 outcome，或增加独立 interrupted 事件；在类型评审时选定一种，所有消费者同步迁移，不能只修改 adapter 字符串。

- completed：允许正常最终结果投递。
- interrupted：保留中断原因，展示当前已产生的内容时明确它不代表任务完成；撤销本 turn 已失效交互。
- failed：保留结构化错误与可展示原因，走原失败状态。
- willRetry=true：保留运行／恢复状态，等待上游结果；不主动重新发起任务。
- transport fatal：立即终止当前 generation，保持既有诊断与精确清理。

对缺失或未知 status 的新协议响应保留诊断，不能默认当作成功。完成事件无已登记 turn 时同样读取状态，避免异常旁路绕过判断。

### S1-D · Goal 用户来源

把来源放入通用 Goal mutation 参数，当前聊天 `/goal` 明确传 user。将来自动任务传 automatic，不在底层无条件默认 user。保持当前 route 权限与 session 所有权校验，写入 origin 不意味着获得额外授权。

测试应验证发送参数和上游语义对照；真实验收要确认明确用户目标更新进入对应 thread 的用户上下文。不要为测试修改用户已有真实 Goal，使用隔离 thread。

### S1-E · 阶段摘要与渠道协同

**范围已收缩：微信摘要专项取消，本项仅保留通用消息语义与既有链路回归。** Codex 的 commentary 继续被正确识别，不混入最终答案；partial_answer、async 和用户问题的必要适配仍由 S1-A／S1-B 完成，不因取消进度专项而取消。

当前 commentary 已进入 `assistant.commentary → BridgeCommentaryDelivery → 渠道文本`，普通微信 `/progress brief` 可投递，默认 silent 通常抑制，Plan 模式有现存例外。保留已有行为与偏好，不因本次范围调整删除功能、改变默认值或打开新模式。

微信 C1 对照新版插件协议及通用发送行为，不新增摘要专用低频合并、额度预算、草稿展示，也不再安排“摘要是否免限流”的专项实验。长文本、最新上下文、每次请求节流和有界恢复仍属于通用可靠性工作。飞书继续按 C2 原有范围适配。

[OpenClaw 实际链路](2026-10-15-openclaw-weixin-commentary-analysis.zh-CN.md)保留为分析依据；其宿主 preamble、内部 `tool` 队列和可编辑预览不构成本项目微信必做项。微信 `TOOL_CALL_START/RESULT` 与 `/progress tools` 保留既有范围。

## 6. S2：恢复、可观测性和条件能力

### 有效设置与审批

建立服务器有效设置快照，至少包含模型、provider、effort、tier、collaborationMode、cwd、审批 reviewer、permission profile 和 workspace roots；与待发送的本地用户覆盖分开。

恢复时先读服务端实际值；用户明确新设值才产生对应覆盖。受管配置拒绝时展示原始原因，不自动降级为更宽权限。旧 server 缺字段显示未知并保留已验证旧路径，不由字段缺失推断 full access。

审批继续按 server 提供的可用决定渲染。仅字段不存在时使用老版兼容集合，明确空集合或全部未知值不能回到默认允许。飞书按钮和微信文字必须使用同一决定集，writeStdin 不重新出现会话级允许。

### 历史与列表

`thread/reverted` 按 thread 使缓存失效，恢复后有界读取；不解绑、不文件回滚、不自动继续任务。`thread/list` 增加页数／总数预算、重复 cursor 防护与截断提示，只在明确协议兼容错误时尝试旧 sortKey。历史游标保持 opaque，不解析内部编码。

### 模型与媒体

模型可用性保持动态读取，新增元数据用于解释能力，不用于自动选择更贵或权限更高的模型。效能档位优先 serviceTiers；不为已弃用 personality 添加入口。

imageGeneration.failure 必须先于成功文本处理；额度重置时间缺失则不编造 ETA。工具状态为失败时，相关进度和最终说明不能写“完成”。媒体路径只接受本地受控引用，不把 result 的任意字符串当文件发送。

### 外部 clock 与 exec

`currentTime/read` 只返回本机当前 UTC Unix 整秒，按请求 thread/generation 校验，响应不经聊天、不进入用户输入等待。默认系统时钟和 external 两种配置分别测试；不自动修改用户 clock_source。

exec 只保留其声明支持的能力；用 fixture 验证当前 JSONL、退出码和中断，真实 CLI smoke 使用隔离目录。涉及模型执行或消息发送的端到端步骤在实施验收时明确记录，不在文档阶段执行。

## 7. 验收矩阵

| 层级 | 必须覆盖的场景 | 证据 |
| --- | --- | --- |
| 协议 | 稳定默认／实验、main 新字段、缺字段旧 fixture、移除方法 | inventory 与字段 fixture 检查 |
| 消息 | partial→final、多个 async、questions、重复完成、缺 phase、相同文字不同 item | mapper／turn controller 测试 |
| 既有摘要回归 | commentary 不混入 final、silent/brief 偏好、前后台现有行为 | 通用事件与既有链路回归；微信不设新增摘要机制或持续发送额度验收 |
| 交互 | 阻塞／非阻塞、多问题、迟到回答、server resolved、secret 与 MCP 边界 | Bridge 集成测试 |
| 终止 | completed、interrupted+error、failed、willRetry=true/false、坏 JSON | 状态与精确清理断言 |
| Goal | 明确用户创建／暂停／恢复／清除、自动来源、状态通知 | 请求参数、隔离 thread 记录 |
| 恢复 | Plan 模式、模型与 effort、受管权限、reverted、有限历史、超过 100 个列表项 | mock server 与分页断言 |
| 媒体／模型 | 图片额度失败、已有路径但失败、未知目录字段、service tier、无能力信息 | mapper 与展示测试 |
| 渠道 | 微信文字、飞书私聊卡片／群聊文字、长结果、失败提示、route 隔离 | mock channel 后补真实投递 |
| 运行平台 | macOS 实装稳定 CLI；Windows launcher／实际安装；exec 降级能力 | 平台 smoke 报告 |

每个工作包先执行相关定向测试；所有首批工作完成后执行 `npm run build`、全量 `npm test`、`git diff --check` 和发布包检查。新增行为必须有有效回归测试，不能只写与实现同构的字段快照。

本轮现状测试失败需要保留到 S0 修复后验证，不能 skip 或删除；真实模型和渠道验收结果与 mock 结果分开陈述。

## 8. 发布与回退

1. 将 S0、消息语义、输入、结束状态、Goal 来源等按独立职责提交，每批包含对应中文报告。
2. 先完成稳定 `0.162.1` 的隔离验证，再决定是否声明兼容其它 CLI；alpha 作为观察基线，不自动安装到用户环境。
3. 发布说明明确已适配项、条件能力和仍不开放的能力。参考 main 更新不等于发布完成。
4. 回退桥接改动时保留用户 session、route 绑定、凭证和已保存结果；不删除 Codex 历史、不重放未确定完成的任务。
5. 若某项实验能力在目标版本不可用，给出明确不可用结果；涉及权限、审批或用户输入的功能不能以静默绕过实现回退。

## 9. 本次交付与后续入口

本次完成版本核实、能力审计、源码差异对照、稳定 CLI 两种 schema 导出、89 项既有测试及 8 项现状探针，并整理本文。详细结论见[审计报告](2026-10-15-codex-cli-compatibility-audit.zh-CN.md)，实际执行记录见[验证报告](../reports/tests/2026-10-15-codex-cli-compatibility-audit.md)。

建议后续从 **S0 + S1 + C1／C2** 开始；渠道细节按配套设计实施，协议和渠道一起达到验收门槛。已有旧计划保留作历史证据，当前优先级和分阶段入口以本计划为准。
