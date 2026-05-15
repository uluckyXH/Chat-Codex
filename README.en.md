# Codex Weixin Middleware

This project is a lightweight middleware that connects Codex to pluggable chat channels. Weixin is the first channel adapter, implemented by adapting the communication capability extracted from `@tencent-weixin/openclaw-weixin`.

This project is OpenClaw-free at runtime. It must not depend on OpenClaw CLI, OpenClaw gateway, OpenClaw host runtime, or OpenClaw channel runtime. The `openclaw-weixin` package is only used as the Weixin communication reference and adaptation source.

## Current Status

- Node.js + TypeScript project scaffold is in place.
- The `@tencent-weixin/openclaw-weixin` and `@larksuite/openclaw-lark` source locations and local placement rules are documented in `references/README.md`; local reference source directories are temporary and are not committed.
- A generic `ChannelAdapter` protocol is implemented so future channels can reuse the same bridge core.
- Mock, Terminal, and Weixin channel adapters are implemented.
- Bridge Core, command routing, approval management, memory state, and baseline logging are implemented.
- The default `codex app-server` adapter is implemented. It uses stdio JSON-RPC to create/resume threads, start turns, and route command/file/permissions approval requests to Weixin `/OK`, `/P`, and `/NO`.
- The `codex exec --json` adapter is still available as a fallback mode and has been verified through the terminal channel with the real Codex CLI.
- Weixin QR login, local account token persistence, text send, and basic `getupdates` polling support are implemented.
- Explicit file delivery is implemented. Paths in ordinary replies and progress are treated as text; use `/sendfile <task>` when Codex should generate and send final files for that turn.
- The `weixin codex` startup entry checks Codex availability and Weixin login state. It skips QR login when credentials are valid and starts QR login when credentials are missing.
- The `weixin codex` daemon terminal prints inbound Weixin messages, outbound Codex replies, policy-delivered progress updates, and media sends in a colored chat-style transcript so the running conversation can be observed locally. Non-TTY output stays plain text by default.
- History session lists prefer Codex SQLite titles or first user messages, then fall back to `session_index.jsonl` and rollout metadata.

## Commands

```bash
npm test
npm run cli:mock
npm run cli:terminal:mock
npm run cli:terminal:codex
npm run cli:weixin:status
npm run cli:weixin:login
npm run cli:weixin:codex
```

Real Codex mode supports startup options:

```bash
npm run cli:terminal:codex -- --session new --permission approval --cwd ./workspaces/demo
npm run cli:weixin:codex -- --session last --permission approval
```

- `--session new|last|<id>`: create a new session, resume the latest session, or bind a specific Codex session.
- `--cwd <dir>` / `--workdir <dir>`: used only for new sessions. Missing directories are created automatically.
- `--codex-adapter app-server|exec` / `--adapter app-server|exec`: choose the Codex adapter. The default `app-server` mode supports Weixin interactive approvals; `exec` is a non-interactive fallback and does not push approval requests to Weixin.
- `--permission approval|full`: choose safe sandbox mode or full permission mode. The default `approval` mode uses the `workspace-write` sandbox and, with app-server, routes approval requests to Weixin; it keeps network access available so behavior matches the local Codex CLI `workspace-write` mode.
- `--yes-dangerously-full`: non-interactive confirmation for full permission mode. Full mode bypasses approvals and sandboxing and is high risk.
- `--progress brief|detailed|silent`: set the default progress delivery mode for non-Weixin channels. The Weixin delivery policy suppresses task-start notices and progress messages to reduce outbound message count.

During interactive startup, the middleware asks for the session first and then asks for the Codex permission mode for subsequent tasks. This keeps permission selection clear when resuming an older session. Choosing a new session displays the default working directory; missing directories are created automatically. If an existing session is selected, the middleware uses the working directory recorded in that Codex session history. Weixin-side `/permission` is scoped to the currently bound Codex session; only when no session is bound does it change the default permission mode for future new sessions.

The default `codex app-server` mode can reuse Codex history threads and acts as the Codex client for the current Weixin conversation. It supports interactive approvals, turn interruption, token usage status updates, and commentary-phase message forwarding, but it does not live-sync Weixin-side interaction into another already-open Codex CLI or Codex App window. Real-time multi-view synchronization still needs an observer UI or an event-subscription design. `codex exec --json` remains available with `--codex-adapter exec` for fallback and debugging.

Normal messages from the same Weixin context are processed sequentially. If Codex is already running and another normal message arrives, the middleware replies with a queued notice; commands such as `/status`, `/stop`, and approval commands still run immediately. The Weixin channel no longer sends per-task start notices or progress messages. It still sends queued notices, approvals, final replies, errors, media send results, and user-initiated command replies. Weixin-side `/progress` is rejected and does not change delivery mode; `/fff` is a Weixin-only silent refresh command that is not forwarded to Codex.

The Weixin-side `/model` command reads the actual model list from Codex app-server `model/list`; it does not keep a hardcoded catalog. Use `/model` to list models, then `/model gpt-5.5 xhigh` or `/model 2 high` to switch the model and reasoning effort for subsequent turns. Unknown models and unsupported efforts are rejected.

Weixin outbound messages are serialized with a small interval, and Bridge suppresses task-start notices and progress messages for Weixin to reduce outbound volume. The default send interval is 1200ms. If `sendmessage` hits rate limiting or a temporary failure, the adapter retries with backoff; only the final failure moves the channel to `degraded` and records `lastError`, instead of logging the request as a successful OUT. While Codex is running, the Weixin channel fetches a `typing_ticket` with `getconfig`, then periodically calls `sendtyping` to keep the peer-side "typing" state visible; it stops typing when the task finishes or `/stop` is used.

Ordinary messages and intermediate model output never auto-send files or images. Local paths, Markdown images, and `file://` references are left as plain text unless the user starts the turn with `/sendfile <task>`. For that turn, the bridge adds an internal instruction to Codex and only parses final-answer lines using `BRIDGE_SEND_FILE: /absolute/path/to/file`. Up to 3 files are sent per turn, and the protocol lines are hidden from the visible reply. Media failures are reported in one aggregate result instead of one fallback message per file.

## Weixin Login State

By default, Weixin login state is stored under `state/weixin/` in the project root. The directory is ignored by Git. The account index is `state/weixin/accounts.json`; each account token and polling cursor is stored in `state/weixin/accounts/<accountId>.json`.

To invalidate Weixin login, stop the middleware and delete the whole `state/weixin/` directory. To remove only one account, delete its `state/weixin/accounts/<accountId>.json` file and, if needed, remove that account ID from `state/weixin/accounts.json`. The next `npm run cli:weixin:codex` or `npm run cli:weixin:login` run will start QR login again.

## Channel Commands

- `/help`: show available commands.
- `/new`: create a new Codex session for the current channel context.
- `/status`: show the Codex session, model, context token usage, cumulative token usage, bridge queue, approvals, permission mode, and channel health; Weixin status reports progress as disabled.
- `/sessions`: list sessions known to the current channel context.
- `/sessions all` or `/all-sessions`: list all discoverable Codex history session IDs.
- `/resume <session>` / `/use <session>`: resume and bind a Codex session.
- `/sendfile <task>`: let Codex declare final files for this turn through the internal bridge protocol; ordinary messages do not auto-send files.
- `/model [model|number] [effort]`: list app-server models or switch the model and reasoning effort for subsequent turns.
- `/permission [approval|full confirm]`: show or switch the permission mode for the currently bound Codex session; without a bound session it changes the default for future new sessions.
- `/OK`: approve the current Codex approval.
- `/P`: approve the current Codex approval for the current Codex session, so similar operations should stop asking when supported by Codex.
- `/NO`: deny the current Codex approval.
- `/stop`: stop the currently running Codex task without ending the Codex session.
- `/fff`: Weixin-only silent refresh command; no reply, no queue entry, and no forwarding to Codex.

## Documentation

- [docs/README.md](docs/README.md): documentation index.
- [docs/requirements.zh-CN.md](docs/requirements.zh-CN.md): Chinese requirements.
- [docs/technical-design.zh-CN.md](docs/technical-design.zh-CN.md): Chinese technical design.
- [docs/development-and-test.zh-CN.md](docs/development-and-test.zh-CN.md): development and testing rules.
- [docs/git-management.zh-CN.md](docs/git-management.zh-CN.md): Git management rules.
- [reports/tests/](reports/tests/): Chinese test reports.

## License

This project is licensed under the [MIT License](LICENSE).

Authors: 小黄 and Codex

## References

- [references/README.md](references/README.md): reference source index for the Weixin plugin, Lark/Feishu plugin, and optional Codex protocol source checkout.
- `openclaw-weixin-npm/`: local Weixin plugin package download/extract directory, not committed.
- `references/openclaw-lark/`: local shallow clone of the official Lark/Feishu channel plugin repository, not committed.
- `references/openai-codex/`: optional local shallow clone of the official Codex repository, recreated from `references/README.md` and not committed.
