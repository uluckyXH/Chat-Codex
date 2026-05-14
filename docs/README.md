# 项目文档索引

这个目录存放 Codex 微信通讯中间件的设计和执行依据。后续开发时先读本文档，再进入具体需求或技术设计。

## 文档用途

- `requirements.zh-CN.md`
  中文需求文档。说明这个项目要做什么、不做什么、支持哪些微信命令、状态、审批、安全和可靠性要求。

- `technical-design.zh-CN.md`
  中文技术设计。说明中间件架构、Node.js + TypeScript 技术选择、Codex adapter、Weixin adapter、审批流、阶段性输出、状态存储和分阶段实现路线。

- `development-and-test.zh-CN.md`
  中文开发与测试规范。说明代码分层、质量要求、每个功能的自测要求、测试报告目录和报告格式。

- `git-management.zh-CN.md`
  中文 Git 管理规范。说明仓库边界、忽略规则、本地参考仓库和提交要求。

- `weixin-ret2-context-token.zh-CN.md`
  微信 `sendmessage ret=-2` 与 `context_token` 问题说明。包含大白话解释、专业排障判断、现有缓解策略和后续优化方向。

- `requirements.md`
  早期英文需求草稿。保留作参考，不作为当前主设计依据。

- `../README.zh-CN.md` 和 `../README.en.md`
  项目根目录的中英文 README，面向快速启动、命令说明和当前状态。

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

## 推荐阅读顺序

1. 读 `requirements.zh-CN.md`，确认项目目标和边界。
2. 读 `technical-design.zh-CN.md`，确认架构和分阶段路线。
3. 读 `development-and-test.zh-CN.md`，确认开发和测试报告要求。
4. 读 `git-management.zh-CN.md`，确认提交边界和忽略规则。
5. 需要 Codex 协议或微信插件源码细节时，先读 `../references/README.md`，按里面的说明拉取本地参考源码。

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
npm run cli:weixin:status
npm run cli:weixin:login
npm run cli:weixin:codex
```

`weixin login` 已具备二维码登录入口。`weixin codex` 是真实微信通道 + Codex 的启动入口：启动时会读取本地微信凭证，已登录则直接启动，未登录则弹出二维码登录流程。默认 app-server 模式可以把 Codex command/file/permissions 审批请求推送到微信，并由 `/OK` 或 `/NO [理由]` 回写 Codex。真实扫码登录完成后要追加真实微信通道测试报告。
