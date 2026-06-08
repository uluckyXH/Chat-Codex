<h1 align="center">Chat-Codex</h1>

<p align="center">
把本机 Codex 接入微信和飞书的轻量聊天中间件。
</p>

<p align="center">
<a href="README.en.md">English</a> ·
<a href="docs/README.md">文档索引</a> ·
<a href="docs/development-and-test.zh-CN.md">开发规范</a> ·
<a href="https://linux.do/t/topic/2190139">LINUX DO 讨论</a>
</p>

<p align="center">
<img src="https://img.shields.io/badge/Node.js-22+-339933?logo=nodedotjs&logoColor=white" alt="Node.js">
<img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
<img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111827" alt="React">
<img src="https://img.shields.io/badge/TUI-Ink-0ea5e9" alt="Ink TUI">
<img src="https://img.shields.io/badge/Runtime-Codex-111827" alt="Codex">
<img src="https://img.shields.io/badge/Channel-Weixin-07C160?logo=wechat&logoColor=white" alt="Weixin">
<img src="https://img.shields.io/badge/Channel-Feishu-2563EB" alt="Feishu">
<img src="https://img.shields.io/badge/License-MIT-green" alt="License">
</p>

<p align="center">
<strong>目录</strong>
</p>

<p align="center">
<a href="#项目介绍">项目介绍</a> ·
<a href="#能力概览">能力概览</a> ·
<a href="#安装使用">安装使用</a> ·
<a href="#运行数据与环境变量">运行数据与环境变量</a> ·
<a href="#技术栈">技术栈</a> ·
<a href="#开发快速开始">开发快速开始</a> ·
<a href="#开发命令">开发命令</a> ·
<a href="#技术架构">技术架构</a> ·
<a href="#聊天内命令">聊天内命令</a> ·
<a href="#文件发送">文件发送</a> ·
<a href="#文档">文档</a> ·
<a href="#许可证">许可证</a>
</p>

## 项目介绍

Chat-Codex 是一个轻量的聊天渠道中间件，用来把微信和飞书里的私聊消息接入本机 Codex。它负责把不同聊天平台的消息转换为统一协议，按聊天 route 绑定独立 Codex session，并把 Codex 的回复、审批、进度和文件发送回对应聊天。

项目核心目标是让 Codex 可以自然地在聊天窗口里工作，同时避免多渠道、多聊天、多 session 之间的上下文串线。

<p align="center">
  <img src="docs/chat-codex-tui-screenshot.png" alt="Chat-Codex TUI 运行截图" width="900">
</p>

## 能力概览

- 统一 `chat-codex` 入口，使用 TUI 管理渠道、聊天绑定、权限和启动流程。
- 支持微信账号和飞书机器人接入，私聊文本/图片/文件收发。
- 支持每个聊天 route 独立绑定一个 Codex session。
- 支持一个 Codex session 只归属一个 route，避免审批、文件和上下文串线。
- 支持 Codex app-server 作为默认接入方式，并保留 `codex exec --json` 回退适配。
- 支持聊天内创建/恢复 session、查看状态、停止任务、处理审批、切换权限、切换模型和发送文件。
- 支持本地持久化渠道实例、聊天绑定、session owner、session 权限和待生效绑定。
- 支持运行期 TUI 日志面板，展示入站、出站、进度、媒体和错误日志。

## 安装使用

```bash
# 全局安装 Chat-Codex
npm install -g chat-codex

# 启动 TUI
chat-codex
```

首次启动前，需要先准备本机 Codex CLI。Chat-Codex 通过本机 `codex` CLI 启动 `codex app-server` 或 `codex exec` 子进程来接入 Codex；只安装 Codex 桌面 App 不等于已满足这个前置要求。

Codex CLI 官方安装指引：<https://developers.openai.com/codex/quickstart>

方式一：npm，适合已安装 Node.js 的 macOS、Linux 和 Windows 用户。

```bash
npm install -g @openai/codex
codex
```

方式二：Homebrew，适合已安装 Homebrew 的 macOS 或 Linux 用户。

```bash
brew install codex
codex
```

安装后确认命令可用：

```bash
codex --version
codex
```

Windows 用户如果 PowerShell 里 `codex --version` 正常，但 Chat-Codex 首页显示 Codex CLI 不可用或报 `spawn codex ENOENT`，请参考 [Windows Codex CLI 排障指南](docs/windows-codex-cli-troubleshooting.zh-CN.md)。

首次启动后按 TUI 引导完成 Codex 检查、渠道管理、聊天绑定和启动服务。

### 首次配对

Chat-Codex 对真实微信/飞书聊天默认启用配对保护。第一次从某个微信联系人或飞书私聊使用时，聊天里会收到配对提示；请回到运行 `chat-codex` 的终端/TUI 查看配对码，然后在原聊天里发送：

```text
/pair <配对码>
```

配对成功后，该聊天会被记为可信 route，后续重启后仍可继续使用。配对按聊天 route 独立生效：不同微信联系人、不同飞书私聊 `chat_id` 都需要分别配对一次。

## 运行数据与环境变量

默认情况下，开发版和 npm 全局安装版都会把运行数据写到当前系统用户目录下，不随启动目录变化。

| 项目 | 默认值 | 说明 |
| --- | --- | --- |
| 状态根目录 | `~/.chat-codex/state/` | 保存 Bridge 配置、route/session 绑定、渠道账号状态和本机凭证。 |
| 上传目录 | `~/.chat-codex/uploads/` | 保存微信/飞书收到的图片和文件，再以本地路径投递给 Codex。 |
| `CHAT_CODEX_BIN` | 未设置 | 覆盖 Codex CLI 可执行文件路径；主要用于 Windows Codex CLI 路径排障。 |
| `CHAT_CODEX_STATE_DIR` | 未设置 | 覆盖状态根目录；相对路径按启动 `chat-codex` 时的工作目录解析。 |
| `CHAT_CODEX_UPLOAD_DIR` | 未设置 | 覆盖上传目录；相对路径按启动 `chat-codex` 时的工作目录解析。 |

旧版本曾默认写入启动目录下的 `state/` 和 `.chat-codex-uploads/`。升级后如果需要读取旧数据，可以把旧 `state/` 移到 `~/.chat-codex/state/`，或临时设置 `CHAT_CODEX_STATE_DIR=/old/start/dir/state`。

## 技术栈

| 模块 | 技术 |
| --- | --- |
| Runtime | Node.js 22+ |
| 语言 | TypeScript / ESM |
| TUI | Ink + React |
| Codex 接入 | Codex app-server，`codex exec --json` fallback |
| 微信渠道 | `@tencent-weixin/openclaw-weixin` 通讯能力适配 |
| 飞书渠道 | `@larksuiteoapi/node-sdk` + WebSocket |
| 状态 | 本地 JSON 文件 |
| 测试 | Node.js test runner |

## 开发快速开始

```bash
git clone git@github.com:uluckyXH/Chat-Codex.git
cd Chat-Codex
npm install
npm run build
npm test
```

启动开发版 TUI：

```bash
npm run chat-codex
```

TUI 会引导完成 Codex 检查、渠道管理、聊天绑定和启动服务。README 不再维护微信和飞书的手工配置流程，相关操作以 TUI 为准。

## 开发命令

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 编译 TypeScript 到 `dist/` |
| `npm test` | 构建并运行全部单元测试和集成测试 |
| `npm run test:unit` | 运行单元测试 |
| `npm run test:integration` | 运行集成测试 |
| `npm run chat-codex` | 启动开发版 Chat-Codex TUI |
| `npm run cli:chat-codex` | `chat-codex` 的等价开发入口 |
| `chat-codex --version` | 查看已安装 Chat-Codex 版本 |
| `chat-codex version` | 查看 Chat-Codex 和 Node.js 版本 |
| `npm run cli:mock` | Mock 通道闭环验证 |
| `npm run cli:terminal:mock` | 终端通道 + MockCodex |
| `npm run cli:terminal:codex` | 终端通道 + 真实 Codex |
| `npm run cli:weixin:status` | 微信辅助状态检查 |
| `npm run cli:weixin:login` | 微信辅助扫码登录 |
| `npm run cli:feishu:status` | 飞书辅助凭证和机器人身份检查 |

## 技术架构

```text
聊天用户
  |
  v
WeixinAdapter / FeishuAdapter
  |
  | ChannelMessage / ChannelTarget
  v
ChannelRegistry
  |
  v
Bridge Core
  |-- Command Router
  |-- Route Queue
  |-- ApprovalManager
  |-- SessionBindings
  |-- TurnScheduler
  |
  v
CodexAdapter
  |-- AppServerCodexAdapter（默认）
  |-- ExecCodexAdapter（回退）
  |
  v
Codex CLI / Codex app-server
```

核心边界：

- Codex 侧只通过 `CodexAdapter` 交互。
- 渠道侧只通过 `ChannelAdapter` 交互。
- Bridge Core 只负责通用路由、队列、session 绑定、审批、权限和 Codex turn 调度。
- 登录、平台 token、游标、限流、重试、typing、媒体上传等都属于具体渠道 adapter。
- 不同渠道的投递差异通过 `ChannelCapabilities` 和 `ChannelDeliveryPolicy` 表达。

统一 route key：

```text
<channelId>:<accountId>:<conversationKind>:<conversationId>
```

同一个 route 的普通消息串行处理；不同 route 可以并行运行不同 Codex session。一个 Codex session 只能属于一个 route。

## 聊天内命令

这些命令从微信或飞书私聊里发送。命令消息不会进入普通 prompt 队列，会立即处理。

### 进度、旁白与微信投递限制

微信渠道不适合持续高频投递 Codex 过程消息。真实使用中，连续投递可能出现 `sendmessage failed: ret=-2 errcode=0`、消息延迟或消息堆积；Chat-Codex 因此默认微信为 `silent`，只公开 `silent/brief`，不开放 `realtime`。飞书支持 `realtime/silent/brief`。

`brief` 会投递 Codex 旁白、计划、搜索和文件变更摘要，但仍不是“每条过程消息都实时到微信”。`/plan` 会默认低频展示 Codex 旁白，方便看到计划协作内容；命令进度和工具细节仍不会因此在微信里刷屏。

`/fff` 是微信专用静默刷新命令：它不会进入 Codex prompt，也不会产生聊天回复。它的作用是让微信侧产生一次新的入站消息，刷新当前 route 的最近消息上下文和 adapter 可用投递上下文；它不是失败消息重发命令，也不能保证修复所有 `ret=-2`。

| 命令 | 用途 |
| --- | --- |
| `/help` | 查看当前渠道可用命令 |
| `/new` | 为当前聊天 route 创建新的 Codex session |
| `/resume [session\|编号]` | 恢复并绑定已有 Codex session |
| `/use [session\|编号]` | 切换当前 route 的 active session |
| `/sessions` | 查看当前 route 拥有或绑定过的 session |
| `/sessions all` | 查看本机可发现的 Codex 历史 session |
| `/status` | 查看 session、模型、token、队列、审批、权限和渠道状态 |
| `/whoami` | 查看当前 channel、route、sender 和 conversation 信息 |
| `/debug` | 查看调试状态 |
| `/stop` | 停止当前 route 正在运行的 Codex turn |
| `/OK` | 批准当前 route 最新 pending approval |
| `/P` | 持久批准当前 route 最新 pending approval |
| `/NO` | 拒绝当前 route 最新 pending approval |
| `/permission` | 查看当前 session 权限 |
| `/permission approval` | 切回审批模式 |
| `/permission full confirm` | 切到完全权限 |
| `/plan` / `/plan <任务>` | 进入计划模式，或以计划模式处理任务；计划模式默认低频展示 Codex 旁白 |
| `/code` / `/code <任务>` | 切回执行模式，或以执行模式处理任务 |
| `/goal [目标]` | 查看或设置实验 Goal |
| `/goal pause` / `/goal resume` / `/goal clear` | 管理实验 Goal 状态 |
| `/model` | 查看可用模型 |
| `/model <模型或编号> [effort]` | 切换模型和 reasoning effort |
| `/model effort <effort>` | 只切换 reasoning effort |
| `/model default` | 清除当前 session 的模型覆盖 |
| `/sendfile <任务>` | 允许 Codex 本轮声明并发送文件 |
| `/compact` | 压缩当前 session 的历史上下文，需 `/compact confirm` 确认 |
| `/progress [silent\|brief\|realtime]` | 当前聊天的进度投递模式；微信只支持 `silent/brief`，飞书支持 `realtime/silent/brief` |
| `/fff` | 微信专用静默刷新，不进入 Codex，不发送回复 |

## 文件发送

普通回复里的本地路径、Markdown 图片和 `file://` 不会自动发送文件，只会当文本展示。

需要让 Codex 本轮生成并发送文件时，发送：

```text
/sendfile <任务内容>
```

Bridge 只解析 Codex 最终回复末尾的内部协议行：

```text
BRIDGE_SEND_FILE: /absolute/path/to/file
```

每轮最多发送 3 个文件。协议行不会展示给聊天用户。微信和飞书当前都支持图片/文件发送。

## 文档

- [docs/README.md](docs/README.md)：文档索引和推荐阅读顺序。
- [docs/requirements.zh-CN.md](docs/requirements.zh-CN.md)：需求、边界和命令要求。
- [docs/technical-design.zh-CN.md](docs/technical-design.zh-CN.md)：技术设计和架构说明。
- [docs/channel-delivery-policy.zh-CN.md](docs/channel-delivery-policy.zh-CN.md)：渠道投递策略。
- [docs/inbound-media-design.zh-CN.md](docs/inbound-media-design.zh-CN.md)：入站图片和文件、pending media、结构化 Codex 输入。
- [docs/multi-channel-design.zh-CN.md](docs/multi-channel-design.zh-CN.md)：多渠道 route/session 绑定和并发设计。
- [docs/local-state-persistence.zh-CN.md](docs/local-state-persistence.zh-CN.md)：本地文件持久化和 session owner 约束。
- [docs/ink-tui-interaction-design.zh-CN.md](docs/ink-tui-interaction-design.zh-CN.md)：TUI 交互设计。
- [docs/development-and-test.zh-CN.md](docs/development-and-test.zh-CN.md)：开发与测试规范。
- [reports/tests/](reports/tests/)：中文测试报告。

## 许可证

本项目使用 [MIT License](LICENSE)。

作者：小黄 and Codex
