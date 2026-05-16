# 项目文档索引

这个目录存放 Codex 微信通讯中间件的设计和执行依据。后续开发时先读本文档，再进入具体需求或技术设计。

## 文档用途

- `requirements.zh-CN.md`
  中文需求文档。说明这个项目要做什么、不做什么、支持哪些微信命令、状态、审批、安全和可靠性要求。

- `technical-design.zh-CN.md`
  中文技术设计。说明中间件架构、Node.js + TypeScript 技术选择、Codex adapter、Weixin adapter、审批流、阶段性输出、状态存储和分阶段实现路线。

- `channel-delivery-policy.zh-CN.md`
  中文渠道投递策略设计。说明 `ChannelDeliveryPolicy` 如何按渠道控制 task-start、progress、`/progress` 和 refresh 命令，避免 Bridge Core 写具体平台分支。

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
  CLI 交互重设计。说明 `weixin codex` / `cli:serve` 应先管理渠道、再管理聊天绑定和 Codex 默认设置，并记录首个 route 绑定 session 的语义修复方案。

- `feishu-adapter-design.zh-CN.md`
  飞书适配设计。说明第一阶段如何用飞书 WebSocket 长连接接入私聊文本消息，并默认投递 Codex 进度。

- `requirements.md`
  早期英文需求草稿。保留作参考，不作为当前主设计依据。

- `../README.md` 和 `../README.en.md`
  项目根目录的默认简体中文 README 和英文 README，面向快速启动、命令说明、技术架构、项目结构和当前状态。

## 当前项目定位

本项目是一个独立轻量中间件：

```text
Codex <-> Middleware Core <-> Channel Adapter <-> Concrete Channel
```

第一条具体渠道是：

```text
Codex <-> Middleware Core <-> WeixinAdapter <-> openclaw-weixin extracted communication capability <-> WeChat
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
4. 读 `multi-channel-design.zh-CN.md`，确认多渠道 route/session 绑定、并发和配置交互设计。
5. 读 `local-state-persistence.zh-CN.md`，确认本地文件持久化、渠道账号目录和 session owner 约束。
6. 读 `cli-interaction-redesign.zh-CN.md`，确认 CLI 首页、子模式、返回/退出和首个 route 绑定语义。
7. 读 `development-and-test.zh-CN.md`，确认开发和测试报告要求。
8. 读 `git-management.zh-CN.md`，确认提交边界和忽略规则。
9. Agent 继续读 `agent-guide.zh-CN.md`，确认执行规范。
10. 需要 Codex 协议或微信插件源码细节时，先读 `../references/README.md`，按里面的说明拉取本地参考源码。

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
npm run codex
npm run cli:codex
npm run cli:weixin:status
npm run cli:weixin:login
npm run cli:weixin:codex
npm run cli:feishu:status
npm run cli:feishu:codex
```

`npm run codex` 是当前推荐主入口，会进入统一启动交互；`npm run cli:codex` 是同等别名。渠道专用入口继续保留，用于明确只启动微信或飞书私聊。

`weixin login` 已具备二维码登录入口，会在终端渲染二维码并保留备用链接。`weixin codex` 是真实微信通道 + Codex 的启动入口：启动时会读取本地微信凭证，已登录则直接启动，未登录则弹出二维码登录流程。默认 app-server 模式可以把 Codex command/file/permissions 审批请求推送到微信，并由 `/OK` 或 `/NO` 回写 Codex。真实扫码登录完成后要追加真实微信通道测试报告。

`feishu status` 会读取 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 等环境变量并检查机器人身份；`feishu codex` 会启动飞书私聊文本通道 + Codex。飞书 App Secret 只允许放在本机环境变量或 `secrets/`，不要写入 Git 跟踪文件。
