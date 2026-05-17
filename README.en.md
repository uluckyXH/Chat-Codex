<h1 align="center">Chat-Codex</h1>

<p align="center">
A lightweight chat middleware that connects local Codex to Weixin and Feishu.
</p>

<p align="center">
<a href="README.md">简体中文</a> ·
<a href="docs/README.md">Docs</a> ·
<a href="docs/development-and-test.zh-CN.md">Development Guide</a> ·
<a href="https://linux.do/t/topic/2190139">LINUX DO Discussion</a>
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
<strong>Contents</strong>
</p>

<p align="center">
<a href="#overview">Overview</a> ·
<a href="#capabilities">Capabilities</a> ·
<a href="#installation">Installation</a> ·
<a href="#tech-stack">Tech Stack</a> ·
<a href="#development-quick-start">Quick Start</a> ·
<a href="#development-commands">Commands</a> ·
<a href="#architecture">Architecture</a> ·
<a href="#chat-commands">Chat Commands</a> ·
<a href="#file-sending">File Sending</a> ·
<a href="#documentation">Docs</a> ·
<a href="#license">License</a>
</p>

## Overview

Chat-Codex is a lightweight middleware for connecting Weixin and Feishu private chats to a local Codex runtime. It normalizes messages from different chat platforms, binds each chat route to an independent Codex session, and sends Codex replies, approvals, progress, and files back to the correct conversation.

The core goal is to make Codex usable from chat windows while keeping routes, sessions, approvals, and files isolated across channels and users.

## Capabilities

- Unified `chat-codex` entry with a TUI for channel management, chat bindings, permissions, and startup.
- Weixin account and Feishu bot integration.
- Independent Codex session binding per chat route.
- One Codex session can only belong to one route, preventing context, approval, and file delivery mix-ups.
- Codex app-server as the default Codex integration, with `codex exec --json` as a fallback adapter.
- Chat-side commands for creating/resuming sessions, inspecting status, stopping turns, handling approvals, switching permissions, switching models, and sending files.
- Local persistence for channel instances, chat bindings, session owners, session policies, and pending bindings.
- Runtime TUI log panel for inbound messages, outbound replies, progress, media, and errors.

## Installation

```bash
# Install Chat-Codex globally
npm install -g chat-codex

# Start the TUI
chat-codex
```

Before first launch, set up the local Codex CLI. Chat-Codex talks to Codex by launching the local `codex` CLI as a child process, using either `codex app-server` or `codex exec`. Installing only the Codex desktop app does not necessarily make the `codex` command available.

Official Codex CLI setup guide: <https://developers.openai.com/codex/quickstart>

```bash
npm install -g @openai/codex
# or
brew install codex

codex
```

On first launch, follow the TUI to check Codex, manage channels, bind chats, and start the service.

### First-time Pairing

Chat-Codex enables pairing protection for real Weixin and Feishu chats by default. When a Weixin contact or Feishu private chat uses it for the first time, the chat receives a pairing prompt. Go back to the terminal/TUI running `chat-codex`, copy the pairing code, then send this in the original chat:

```text
/pair <code>
```

After pairing succeeds, that chat is stored as a trusted route and remains usable after restarts. Pairing is scoped per chat route: different Weixin contacts and different Feishu private `chat_id` values each need to be paired once.

## Tech Stack

| Area | Technology |
| --- | --- |
| Runtime | Node.js 22+ |
| Language | TypeScript / ESM |
| TUI | Ink + React |
| Codex integration | Codex app-server, `codex exec --json` fallback |
| Weixin channel | Adapted `@tencent-weixin/openclaw-weixin` communication capability |
| Feishu channel | `@larksuiteoapi/node-sdk` + WebSocket |
| State | Local JSON files |
| Tests | Node.js test runner |

## Development Quick Start

```bash
git clone git@github.com:uluckyXH/Chat-Codex.git
cd Chat-Codex
npm install
npm run build
npm test
```

Start the development TUI:

```bash
npm run chat-codex
```

The TUI guides Codex checks, channel management, chat bindings, and service startup. This README intentionally does not duplicate Weixin or Feishu setup flows; the TUI is the source of truth for interactive setup.

## Development Commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile TypeScript into `dist/` |
| `npm test` | Build and run all unit and integration tests |
| `npm run test:unit` | Run unit tests |
| `npm run test:integration` | Run integration tests |
| `npm run chat-codex` | Start the development Chat-Codex TUI |
| `npm run cli:chat-codex` | Equivalent development entry |
| `chat-codex --version` | Show the installed Chat-Codex version |
| `chat-codex version` | Show Chat-Codex and Node.js versions |
| `npm run cli:mock` | Mock channel loop |
| `npm run cli:terminal:mock` | Terminal channel + MockCodex |
| `npm run cli:terminal:codex` | Terminal channel + real Codex |
| `npm run cli:weixin:status` | Weixin helper status check |
| `npm run cli:weixin:login` | Weixin helper QR login |
| `npm run cli:feishu:status` | Feishu helper credential and bot identity check |

## Architecture

```text
Chat User
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
  |-- AppServerCodexAdapter (default)
  |-- ExecCodexAdapter (fallback)
  |
  v
Codex CLI / Codex app-server
```

Core boundaries:

- Codex integration only goes through `CodexAdapter`.
- Chat channels only go through `ChannelAdapter`.
- Bridge Core owns generic routing, queues, session binding, approvals, permissions, and Codex turn scheduling.
- Login, platform tokens, cursors, rate limits, retries, typing, and media upload belong to concrete channel adapters.
- Channel-specific delivery behavior is expressed through `ChannelCapabilities` and `ChannelDeliveryPolicy`.

Stable route key:

```text
<channelId>:<accountId>:<conversationKind>:<conversationId>
```

Normal messages for the same route are serialized. Different routes can run different Codex sessions concurrently. A Codex session can only belong to one route.

## Chat Commands

These commands are sent from Weixin or Feishu private chats. Command messages bypass the normal prompt queue and are handled immediately.

| Command | Purpose |
| --- | --- |
| `/help` | Show available commands for the current channel |
| `/new` | Create a new Codex session for the current chat route |
| `/resume [session\|number]` | Resume and bind an existing Codex session |
| `/use [session\|number]` | Switch the active session for the current route |
| `/sessions` | List sessions owned or used by the current route |
| `/sessions all` | List locally discoverable Codex sessions |
| `/status` | Show session, model, token, queue, approval, permission, and channel status |
| `/whoami` | Show current channel, route, sender, and conversation identity |
| `/debug` | Show debug state |
| `/stop` | Stop the running Codex turn for the current route |
| `/OK` | Approve the latest pending approval for the current route |
| `/P` | Persist-approve the latest pending approval |
| `/NO` | Deny the latest pending approval |
| `/permission` | Show current session permission |
| `/permission approval` | Switch back to approval mode |
| `/permission full confirm` | Switch to full permission mode |
| `/plan` / `/plan <task>` | Enter plan mode, or run a task in plan mode |
| `/code` / `/code <task>` | Enter code mode, or run a task in code mode |
| `/goal [objective]` | Show or set the experimental Goal |
| `/goal pause` / `/goal resume` / `/goal clear` | Manage experimental Goal state |
| `/model` | Show available models |
| `/model <model or number> [effort]` | Switch model and reasoning effort |
| `/model effort <effort>` | Switch reasoning effort only |
| `/model default` | Clear the current session model override |
| `/sendfile <task>` | Allow Codex to declare files for this turn |
| `/compact` | Compact the current session history; requires `/compact confirm` |
| `/progress [brief\|detailed\|silent]` | Progress delivery mode for non-Weixin channels |
| `/fff` | Weixin-only silent refresh |

## File Sending

Local paths, Markdown images, and `file://` references in ordinary replies are shown as text and are not sent automatically.

To allow Codex to generate and send files for one turn, send:

```text
/sendfile <task>
```

Bridge only parses internal protocol lines at the end of the final Codex reply:

```text
BRIDGE_SEND_FILE: /absolute/path/to/file
```

At most 3 files are sent per turn. Protocol lines are not shown to chat users.

## Documentation

- [docs/README.md](docs/README.md): documentation index and recommended reading order.
- [docs/requirements.zh-CN.md](docs/requirements.zh-CN.md): requirements and boundaries.
- [docs/technical-design.zh-CN.md](docs/technical-design.zh-CN.md): technical design and architecture.
- [docs/channel-delivery-policy.zh-CN.md](docs/channel-delivery-policy.zh-CN.md): channel delivery policy.
- [docs/multi-channel-design.zh-CN.md](docs/multi-channel-design.zh-CN.md): multi-channel route/session binding and concurrency design.
- [docs/local-state-persistence.zh-CN.md](docs/local-state-persistence.zh-CN.md): local persistence and session owner constraints.
- [docs/ink-tui-interaction-design.zh-CN.md](docs/ink-tui-interaction-design.zh-CN.md): TUI interaction design.
- [docs/development-and-test.zh-CN.md](docs/development-and-test.zh-CN.md): development and testing rules.
- [reports/tests/](reports/tests/): Chinese test reports.

## License

[MIT License](LICENSE).

Authors: 小黄 and Codex.
