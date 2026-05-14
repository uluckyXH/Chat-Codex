# Codex OpenClaw WeChat Bridge Requirements

## 1. Project Goal

Build a project that lets Codex connect to the OpenClaw Weixin communication channel so users can communicate with Codex from WeChat in a way similar to OpenClaw.

The bridge should support interactive WeChat conversations, Codex session control, and useful command handling inside WeChat.

## 2. Current Scope

This document captures requirements only. Implementation should not start until the requirements and architecture are reviewed.

The OpenClaw Weixin npm package is used only as a local reference source. Recreate it from the instructions in `references/README.md`; do not commit the downloaded package or extracted source:

- `openclaw-weixin-npm/tencent-weixin-openclaw-weixin-2.4.3.tgz`
- `openclaw-weixin-npm/extracted/openclaw-weixin-2.4.3/`

## 3. Core Requirements

### 3.1 WeChat Channel Integration

The project should integrate with the OpenClaw Weixin channel package and use it as the WeChat communication layer where possible.

Required behavior:

- Receive WeChat messages through the OpenClaw Weixin channel.
- Forward user messages to Codex.
- Return Codex responses back to the same WeChat conversation.
- Preserve enough conversation context to make WeChat feel like a usable Codex client.
- Handle text messages first.
- Leave room for later support of images, voice, files, and other media if the channel supports them.

### 3.2 Codex Session Integration

The bridge should control or communicate with Codex sessions.

Required behavior:

- Create a new Codex conversation/session from WeChat.
- Route WeChat messages to the active Codex session.
- Track session identity per WeChat user or chat context.
- Expose useful session state back to WeChat.
- Avoid mixing unrelated users or conversations into the same Codex context unless explicitly configured.

### 3.3 `/new` Command

The WeChat command `/new` should be supported and adapted for Codex.

Expected behavior:

- Start a new Codex session for the current WeChat user or chat context.
- Clear or detach the previous active Codex conversation for that context.
- Return a clear WeChat confirmation message with the new session status.
- If a Codex task is currently running, define whether `/new` should cancel, detach, or refuse until completion.

Open question:

- Should `/new` create a completely fresh Codex workspace session, a new chat thread in the same workspace, or a logical WeChat-only session mapped to Codex state?

### 3.4 `/status` Command

Add a custom `/status` command that combines current Codex status and WeChat channel status.

The status response should include:

- Current Codex session state.
- Whether Codex is idle, running, waiting for input, blocked, or failed.
- Current WeChat channel connection state.
- Current WeChat user/chat binding state.
- Active session identifier or short display name.
- Last activity time.
- Last error summary if any.
- Pending operation summary if Codex is still processing.

The command should be concise enough to read comfortably in WeChat.

### 3.5 Additional Useful Commands

The project should be designed to support more practical commands over time. Initial candidates:

- `/help`: list available commands and short descriptions.
- `/new`: start a new Codex session.
- `/status`: show combined Codex and channel status.
- `/stop`: cancel or interrupt the active Codex task if supported.
- `/resume`: resume or reattach to the active Codex session.
- `/sessions`: list recent sessions for the current WeChat context.
- `/use <session>`: switch to a known session.
- `/clear`: clear WeChat-side transient state without deleting durable Codex history.
- `/debug`: show diagnostic information for administrators.

Command behavior should be permission-aware. Administrator-only commands should not be available to ordinary users unless explicitly configured.

## 4. State Model Requirements

The bridge needs to model at least two kinds of state.

Codex state:

- Session id.
- Workspace path.
- Active task status.
- Last user message time.
- Last assistant response time.
- Last error.
- Whether Codex is waiting for more user input.

WeChat channel state:

- Channel connection status.
- Login/account status.
- Bound WeChat user or chat id.
- Message delivery status.
- Last inbound message time.
- Last outbound message time.
- Last channel error.

Combined status:

- Current binding between WeChat context and Codex session.
- Whether the bridge can currently accept messages.
- Whether outgoing responses can currently be delivered.
- Any mismatch between Codex status and channel status.

## 5. Message Routing Requirements

Message routing should be explicit and predictable.

Required behavior:

- Determine a routing key from the WeChat message context.
- Map each routing key to one active Codex session.
- Treat commands separately from normal user prompts.
- Avoid sending command text to Codex unless the command is unknown or explicitly escaped.
- Preserve ordering for messages from the same WeChat context.
- Avoid duplicate delivery when the channel retries or reconnects.

## 6. Reliability Requirements

The bridge should be practical for long-running use.

Required behavior:

- Log inbound messages, outbound replies, command execution, session changes, and errors.
- Redact sensitive tokens, cookies, account identifiers, and message content where appropriate.
- Recover gracefully after process restart.
- Persist enough state to restore WeChat-to-Codex session mappings.
- Report channel or Codex failures through `/status`.
- Provide readable error messages in WeChat without exposing secrets.

## 7. Security And Permissions

The bridge should not expose Codex control to every WeChat sender by default.

Required behavior:

- Support an allowlist of WeChat users or groups.
- Support administrator users.
- Restrict diagnostic and control commands where needed.
- Avoid exposing local filesystem paths, environment variables, or credentials unless explicitly enabled.
- Treat WeChat messages as untrusted input.

## 8. Configuration Requirements

The project should eventually support configuration for:

- OpenClaw Weixin channel settings.
- Codex workspace path.
- Allowed users or groups.
- Administrator users.
- Default session behavior.
- Command prefix.
- Logging level.
- State storage path.

Configuration should be file-based at minimum and environment-variable-friendly for secrets.

## 9. Non-Goals For The First Implementation

The first implementation does not need to support:

- Full media handling.
- Multi-tenant deployment.
- Web dashboard.
- Advanced analytics.
- Automatic installation of OpenClaw itself.
- Replacing OpenClaw internals.

## 10. Proposed Milestones

### Milestone 1: Architecture Review

- Inspect the downloaded OpenClaw Weixin package.
- Identify its public APIs and plugin entrypoints.
- Decide how Codex should be invoked or controlled.
- Confirm the session and state model.

### Milestone 2: Minimal Text Bridge

- Receive WeChat text messages.
- Forward normal prompts to Codex.
- Send Codex responses back to WeChat.
- Support `/help`, `/new`, and `/status`.

### Milestone 3: Session Management

- Persist WeChat-to-Codex mappings.
- Add `/sessions`, `/use`, and `/resume` where supported.
- Improve restart recovery.

### Milestone 4: Hardening

- Add permission checks.
- Add structured logs.
- Add error handling and redaction.
- Add tests for command parsing and state transitions.

## 11. Open Questions

- What is the preferred way to drive Codex: CLI process, local API, plugin runtime, or another integration surface?
- Should each WeChat user get an isolated Codex session by default?
- Should group chats be supported, and if so, should mentions be required before Codex responds?
- What should happen if Codex is already running a task and the user sends another normal message?
- Should `/new` cancel the current run, create a parallel session, or only switch future messages?
- Which Codex status fields are actually available from the selected integration method?
- Which OpenClaw Weixin channel states are available from the package API?
- Where should persistent state live by default?
- How should secrets and WeChat login state be managed?
