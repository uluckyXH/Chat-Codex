# Codex CLI 新版协议适配测试报告

日期：2026-10-15。状态：**本批协议实现与本地验证完成**，各项完成记录保留如下。

## 范围与基线

本轮实施 Codex 协议与通用 Bridge 消费链路。长文本、微信插件和渠道 SDK 升级暂缓。保留已有文档改动与其他工作中的飞书设计。

- CLI：`codex-cli 0.162.1`，参考 main：`bb64b894fd67158be0f874872e6d7bfe717e7368`。
- 基线命令：`npm test`。
- 基线结果：541 项，540 通过、1 失败、0 跳过。唯一失败是协议 inventory 未登记 `thread/attachmentOwner/list`；构建通过。
- 原始日志：`/private/tmp/codex-protocol-baseline-20261015.log`。

## 分项执行记录

每项完成后补充实现范围、定向测试命令、结果和限制。

### S0 / A01：协议契约与版本

- 提交稳定默认、稳定 experimental 和固定 main 三份精简方法／字段快照；新增 `scripts/audit-codex-protocol.mjs`，可检测方法增删和使用字段的变化。CI 分类测试不再依赖忽略的参考 checkout；原参考对照测试保留。
- 补齐 66 个实验／默认 client 方法分类、外部时钟暂列显式不支持、readState 列安全忽略；thread/list 改为已处理，移除当前协议已删除的 rollback。分类不代表开放新功能。
- initialize 使用真实项目包版本；adapter 暴露握手状态和服务端 userAgent，明确握手不能证明模型／渠道可用。
- 命令：`npm run build`；`node --test dist/tests/unit/codex-protocol-contract.test.js dist/tests/unit/app-server-mappers.test.js dist/tests/unit/app-server-core-modules.test.js`。
- 结果：26 项通过、0 失败、0 跳过。包含无参考仓库的三套清单、模拟协议漂移、stdio 握手版本及重启状态。首次测试发现测试断言未考虑 origin 为可选字段，已修正为兼容可选签名并复测通过。
- 日志：`/private/tmp/codex-protocol-s0-build.log`、`/private/tmp/codex-protocol-s0-tests.log`。未启动真实模型任务。

### S1-A / A02：阶段答案与异步问题

- 新增按 item ID 的消息归并，支持 partial_answer、delivery=async 与 questions；同一 item 重放不重复发，不同 item 的相同正文保留。delta 的替换快照避免拼接不同答案；完成时补齐的 phase 会清除误判的最终缓冲。
- 前台与后台均在 turn 结束前送达阶段答案和异步问题，独立于普通进度开关。异步消息不伪造 request_user_input 请求号，用户回复通过正常会话输入继续。历史回放排除 commentary、阶段答案、异步消息和问题。
- 命令：`npm run build`；`node --test dist/tests/unit/codex-protocol-messages.test.js dist/tests/unit/bridge-route-queue.test.js dist/tests/unit/app-server-core-modules.test.js dist/tests/unit/app-server-codex-adapter.test.js`。
- 结果：69 项通过、0 失败、0 跳过。覆盖阶段消息、重复通知、晚到 phase、多个最终候选、旧版无 phase、历史筛选、前后台即时送达。
- 构建过程曾遇到并行群权限工作的测试类型错误；未覆盖其修改。S1-B 时共享工作区构建已恢复通过，见 a03-build 日志。
- 日志：`/private/tmp/codex-protocol-a02-build.log`、`/private/tmp/codex-protocol-a02-tests.log`。未发送真实微信／飞书消息。

### S1-B / A03：非阻塞用户输入

- 旧请求缺少 isBlocking 时保持阻塞；false 时任务和普通输入继续，多条可选请求立即展示且各有 Q 编号，例如 `/a1@Qk7m2abc9x0p-2`。原阻塞问题继续使用 `/a1`，多问题顺序回答保持兼容。
- 可选请求不设置自动回答定时器，不采纳弃用的 autoResolutionMs。原阻塞超时策略保留。重复请求去重，明确编号避免答案投错问题；外部 resolved、turn 结束、取消和断线清理待答状态。
- RPC 请求标识加入连接代次，拒绝旧连接的迟到回复。最终复核还给聊天 Q 编号加入运行随机标识，防止 Bridge 重启后编号从 1 重用；未知／格式错误的 Q 回复不能退回当前阻塞问题。resolved 校验所属 thread；解决一个问题不会解除另一个阻塞请求。用户输入响应结构保持原协议。
- 命令：`npm run build`；`node --test dist/tests/unit/codex-protocol-interactions.test.js dist/tests/unit/pending-input.test.js dist/tests/unit/app-server-codex-adapter.test.js dist/tests/unit/app-server-mappers.test.js dist/tests/integration/bridge-mock.test.js`。
- 结果：构建通过；175 项通过、0 失败、0 跳过。包含前述 stdio 适配测试、现有聊天选择流程和新增非阻塞并发、超时不代选、跨 thread／重启／结束后的迟到输入测试。
- 日志：`/private/tmp/codex-protocol-a03-build.log`、`/private/tmp/codex-protocol-a03-tests.log`。

### S1-C / A04：结束状态与上游重试

- completed、interrupted、failed 分开映射；本地取消也返回 interrupted，聊天展示“已中断”，不把未完成正文作为成功结果。缺失／inProgress／未知结束状态按协议错误处理。
- willRetry=true 保持任务打开，后续输出仍可完成；false 即使写着 Reconnecting 也视为终止。只有旧服务未提供标志时才保留原重连文案兼容。保留 codexErrorInfo、additionalDetails、misalignment 结构化错误；压缩等待同样遵守重试／结束状态。
- 真实 app-server 结束前清理并通知未决请求，关闭后迟到通知不能复活任务；保留其他 adapter 原有审批语义。
- 命令：`npm run build`；`node --test dist/tests/unit/codex-protocol-messages.test.js dist/tests/unit/codex-protocol-interactions.test.js dist/tests/unit/bridge-route-queue.test.js dist/tests/unit/app-server-codex-adapter.test.js dist/tests/integration/bridge-mock.test.js`。
- 结果：构建通过；180 项通过、0 失败、0 跳过。首次回归发现老 mock 把待审批 turn 提前标完成，已将协议结束时的审批清理放回 app-server 生命周期内；更新两项取消测试为 interrupted 后全部通过。
- 日志：`/private/tmp/codex-protocol-a04-build.log`、`/private/tmp/codex-protocol-a04-tests.log`。

### S1-D / A05：Goal 来源与状态

- Goal mutation 增加可选来源参数，聊天明确操作传 user；自动调用可传 automatic，底层缺省不伪造用户授权。updated／cleared 更新 session 的 Goal 状态，不创建后台 turn、不自动恢复目标。
- 命令：`npm run build`；`node --test dist/tests/unit/codex-protocol-interactions.test.js dist/tests/unit/codex-version-adaptation-commands.test.js dist/tests/unit/app-server-codex-adapter.test.js dist/tests/unit/codex-protocol-contract.test.js`。
- 结果：构建通过；52 项通过、0 失败、0 跳过。覆盖四种聊天写操作、automatic／缺省来源、预算受限通知与清除。修正测试 stub 的严格类型声明后通过。
- 日志：`/private/tmp/codex-protocol-a05-build.log`、`/private/tmp/codex-protocol-a05-tests.log`。未改用户已有真实 Goal；没有把参数断言当作真实模型用户上下文验收。

### S2-A / A06、A12：有效设置与审批

- start／resume／settings 通知统一吸收服务端设置，包括 null 清空、协作模式、审批 reviewer、sandbox、权限 profile 及 runtimeWorkspaceRoots。根目录仅记录，不自动扩大权限。请求策略单独保留；更改本地模型／权限不伪装为服务器已经确认。旧响应可从 Thread model／reasoningEffort 兜底。
- 明确空／未知 availableDecisions 不再回到默认允许；旧版缺失／null 字段仍保持旧行为。只有未知选项时返回显式错误并提示；混合选项只保留认识的决定。权限审批展示实际范围，验证网络与文件路径结构，未知结构不能授权；拒绝只回空授权。
- 命令：`npm run build`；`node --test dist/tests/unit/codex-protocol-interactions.test.js dist/tests/unit/app-server-codex-adapter.test.js dist/tests/unit/app-server-mappers.test.js dist/tests/unit/approval-manager.test.js dist/tests/unit/channel-approval.test.js dist/tests/unit/feishu-approval-card.test.js`。
- 结果：构建通过；84 项通过、0 失败、0 跳过。包含受限生效权限与 full 请求分离、null／旧字段、请求未获确认的模型显示、审批空／混合／结构化未知选项和权限响应范围。更新原来把期望值当生效值的旧断言；权限样例换成当前真实 schema。
- 日志：`/private/tmp/codex-protocol-a06-a12-build.log`、`/private/tmp/codex-protocol-a06-a12-tests.log`。

### S2-B / A07、A08、A11：历史、分页与失败展示

- thread/reverted 使对应加载标记和 token 上下文失效，结束失效 turn 与请求，保留本地会话和绑定；历史读取／恢复期间发生回退会拒绝旧结果，下次正常恢复使用新历史。
- thread/list 最多 10 页、每页 100，按 ID 去重、重复游标停止，并向列表与选择页面传递部分加载提示。只有明确 recency 排序不兼容才回退 updated_at；只有方法不支持才退本机列表，认证／超时／连接错误不掩盖成兼容回退。
- MCP／文件变更／图像失败优先于完成状态；用量上限明确展示失败。图像正文 result 不当作路径，只有合法本地 savedPath 用于生成完成提示；imageView 使用查看文案。
- 命令：`npm run build`；`node --test dist/tests/unit/codex-protocol-history.test.js dist/tests/unit/codex-protocol-interactions.test.js dist/tests/unit/codex-protocol-messages.test.js dist/tests/unit/app-server-codex-adapter.test.js dist/tests/unit/app-server-mappers.test.js dist/tests/unit/session-list.test.js dist/tests/integration/bridge-mock.test.js`。
- 结果：构建通过；188 项通过、0 失败、0 跳过。覆盖跨页／重复游标／预算／鉴权与超时不重试、历史回退并发、保留绑定、失败及原始图像数据不泄露到路径提示。
- 日志：`/private/tmp/codex-protocol-a07-a08-a11-build.log`、`/private/tmp/codex-protocol-a07-a08-a11-tests.log`。

### S2-C / A09、A10、A13：模型元数据、时钟和 exec

- 保留 modelSpecialty、multiAgentVersion、availableAccessPrograms 与 null；服务档位以 serviceTiers 为准，不用弃用的速度列表补回空选项，也不再宣传 personality。动态 effort 名称保持开放；记录元数据不自动启用新的访问计划／代理行为。
- currentTime/read 直接回复整 Unix 秒，校验 threadId，不产生聊天等待或审批。
- app-server／exec 分别暴露中间件能力。官方当前 exec JSONL 的 AgentMessageItem 只有 text，不承诺 phase／async 问题；继续兼容其旧事件解析。exec 失败后即使退出码 0 也不再报成功，取消返回 interrupted，处理子进程 error。
- 命令：`npm run build`；`node --test dist/tests/unit/codex-protocol-interactions.test.js dist/tests/unit/codex-protocol-contract.test.js dist/tests/unit/exec-codex-adapter.test.js dist/tests/unit/codex-process.test.js dist/tests/unit/codex-cli.test.js dist/tests/unit/app-server-mappers.test.js`。
- 结果：构建通过；54 项通过、0 失败、0 跳过。包含时钟单位／无交互、模型 null／动态枚举、exec 错误与取消、平台命令解析。Windows 仅命令解析测试，未在 Windows 实机执行 CLI。
- 日志：`/private/tmp/codex-protocol-a09-a10-a13-build.log`、`/private/tmp/codex-protocol-a09-a10-a13-tests.log`。

### S1-E / A14 与综合验证

- `npm test` 初次全量 606/606 通过。复核补充 exec 启动错误和可选问题跨 Bridge 重启用例，并修正模型 reroute 后的有效设置保留、受管策略的审批展示、非阻塞问题的线程状态及回答／resolved 并发推进后，最终 **608/608 通过，0 失败、0 跳过**；构建通过。总数包含共享工作区既有及并行群权限测试，不等同于本批新增测试数。
- commentary／silent／brief 保持现有策略；回归包含分块与完整通知去重、纯 commentary 兜底、前台／后台 Goal、微信默认静默与 brief 行为。本批不新增微信进度频率、预算或限流对比实现。
- 三份已固定 schema 分别执行 `scripts/audit-codex-protocol.mjs --schema <对应目录> --baseline <对应 fixture>`，均为 `changes: []`。稳定默认、稳定 experimental、固定 main 的 CI 清单由仓库内 fixture 提供，不依赖参考 checkout 存在。
- 真实命令 `codex --version` 返回 **0.162.1**；`exec --help` 和 `exec resume --help` 确认当前所用 `--json`、`--cd`、`--skip-git-repo-check`、resume 的 `--all` 参数。
- 真实 app-server 首次受当前沙箱限制，stderr 为 `Operation not permitted`，initialize 前关闭 stdout。获得执行权限后对同一脚本复测成功：握手报告 `Codex Desktop/0.162.1` 和客户端包版本 `0.1.5`；通过实际 adapter 解析 **8 个模型**并保留新版元数据；读取 thread/list **1 条**，存在下一页游标。脚本仅执行 initialize／model/list／thread/list，不启动模型任务。运行时诊断仍标 `handshake_only`，不把只读结果扩大为全部功能验证。
- `npm pack --dry-run --ignore-scripts --json` 通过，新增运行时协议模块均包含在发布文件集合内。跳过会修改 bundled SDK 的 prepack，符合本轮渠道 SDK 暂缓的范围；未发布 npm 包。
- `git diff --check` 通过。

日志与产物：

- 全量：`/private/tmp/codex-protocol-full-20261015.log`、`/private/tmp/codex-protocol-full-final-20261015.log`。
- 真实 CLI：`/private/tmp/codex-protocol-live-20261015.json`；首次受限诊断：`/private/tmp/codex-protocol-live-diagnostic-20261015.json`。
- exec 参数：`/private/tmp/codex-protocol-exec-help-20261015.txt`、`/private/tmp/codex-protocol-exec-resume-help-20261015.txt`。
- 打包：`/private/tmp/codex-protocol-pack-20261015.json`。临时日志可能被系统清理，本文保留版本、命令和结果。

## 验证边界

| 场景 | 本次结果 |
| --- | --- |
| macOS arm64、Node 24.14.0、CLI 0.162.1 的握手与只读 API | 通过 |
| 默认／experimental 方法与使用字段契约 | 固定快照和漂移检查通过 |
| 协议消息、交互、状态、历史、审批的行为 | 单元／stdio fake／Bridge 集成测试通过 |
| 新版真实模型产出阶段答案、可选问题、真实 Goal 的用户上下文 | 未执行；不能由 mock 或握手代替 |
| Windows 实机 CLI | 未执行；Windows PATH／PATHEXT／npm shim 命令解析测试通过 |
| 微信／飞书端到端发送、长文本、限流、插件／SDK 更新 | 本批暂缓；原 prepare failed 未经修复验收 |

不将本批记录解释为所有历史 CLI 的兼容承诺；旧字段缺失／旧 JSONL 的兼容用例通过，但未在旧 CLI 实机重跑。
