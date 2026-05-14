# Codex Weixin Middleware

This project is a lightweight middleware that connects Codex to pluggable chat channels. Weixin is the first channel adapter, implemented by adapting the communication capability extracted from `@tencent-weixin/openclaw-weixin`.

This project is OpenClaw-free at runtime. It must not depend on OpenClaw CLI, OpenClaw gateway, OpenClaw host runtime, or OpenClaw channel runtime. The `openclaw-weixin` package is only used as the Weixin communication reference and adaptation source.

## Current Status

- Node.js + TypeScript project scaffold is in place.
- The `@tencent-weixin/openclaw-weixin` source reference download/extract instructions live in `references/README.md`; local `openclaw-weixin-npm/` contents are temporary reference files and are not committed.
- A generic `ChannelAdapter` protocol is implemented so future channels can reuse the same bridge core.
- Mock, Terminal, and Weixin channel adapters are implemented.
- Bridge Core, command routing, approval management, memory state, and baseline logging are implemented.
- The default `codex app-server` adapter is implemented. It uses stdio JSON-RPC to create/resume threads, start turns, and route command/file/permissions approval requests to Weixin `/OK` and `/NO [reason]`.
- The `codex exec --json` adapter is still available as a fallback mode and has been verified through the terminal channel with the real Codex CLI.
- Weixin QR login, local account token persistence, text send, and basic `getupdates` polling support are implemented.
- Codex image forwarding is implemented. The bridge detects local image paths, `file://` paths, Markdown images, and remote image URLs in progress/final output; Weixin uploads and sends images, while channels without media support fall back to a text reference.
- The `weixin codex` startup entry checks Codex availability and Weixin login state. It skips QR login when credentials are valid and starts QR login when credentials are missing.
- The `weixin codex` daemon terminal prints inbound Weixin messages, outbound Codex replies, progress updates, and media sends in a colored chat-style transcript so the running conversation can be observed locally. Non-TTY output stays plain text by default.
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
npm run cli:weixin:codex -- --session last --permission approval --progress brief
```

- `--session new|last|<id>`: create a new session, resume the latest session, or bind a specific Codex session.
- `--cwd <dir>` / `--workdir <dir>`: used only for new sessions. Missing directories are created automatically.
- `--codex-adapter app-server|exec` / `--adapter app-server|exec`: choose the Codex adapter. The default `app-server` mode supports Weixin interactive approvals; `exec` is a non-interactive fallback and does not push approval requests to Weixin.
- `--permission approval|full`: choose safe sandbox mode or full permission mode. The default `approval` mode uses the `workspace-write` sandbox and, with app-server, routes approval requests to Weixin; it keeps network access available so behavior matches the local Codex CLI `workspace-write` mode.
- `--yes-dangerously-full`: non-interactive confirmation for full permission mode. Full mode bypasses approvals and sandboxing and is high risk.
- `--progress brief|detailed|silent`: set the default progress delivery mode. `brief` is the default and suppresses command/tool details; `detailed` keeps full command/tool progress; `silent` sends only start, approvals, final replies, and media.

During interactive startup, the middleware asks for the session first and then asks for the Codex permission mode for subsequent tasks. This keeps permission selection clear when resuming an older session. Choosing a new session displays the default working directory; missing directories are created automatically. If an existing session is selected, the middleware uses the working directory recorded in that Codex session history. Weixin-side `/permission` is scoped to the currently bound Codex session; only when no session is bound does it change the default permission mode for future new sessions.

The default `codex app-server` mode can reuse Codex history threads and acts as the Codex client for the current Weixin conversation. It supports interactive approvals, turn interruption, token usage status updates, and commentary-phase message forwarding, but it does not live-sync Weixin-side interaction into another already-open Codex CLI or Codex App window. Real-time multi-view synchronization still needs an observer UI or an event-subscription design. `codex exec --json` remains available with `--codex-adapter exec` for fallback and debugging.

Normal messages from the same channel context are processed sequentially. If Codex is already running and another normal message arrives, the middleware replies with a queued notice; commands such as `/status`, `/stop`, and approval commands still run immediately. Each task starts with a short "processing" notice and does not repeat the Session ID; use `/status` for session, model, context token usage, and permission details. The default `brief` progress mode sends planning/reasoning, search, and file-change summaries, but suppresses command/tool details. Use `/progress detailed` or `--progress detailed` when full debugging detail is needed.

Weixin outbound messages are serialized with a small interval to reduce dropped or hidden rapid-fire progress messages. The default send interval is 1200ms. If `sendmessage` hits rate limiting or a temporary failure, the adapter retries with backoff; only the final failure moves the channel to `degraded` and records `lastError`, instead of logging the request as a successful OUT. While Codex is running, the Weixin channel fetches a `typing_ticket` with `getconfig`, then periodically calls `sendtyping` to keep the peer-side "typing" state visible; it stops typing when the task finishes or `/stop` is used.

When Codex output contains an accessible media reference, the bridge sends the text first and then attempts a media message. Images are detected from common image suffixes. Regular files are extracted only from local Markdown file links that exist, or from explicit references such as `MEDIA:`/`FILE:` directives and `File:`/`Attachment:` labels, so ordinary web links and code paths are not sent as attachments. Remote regular files must use an explicit label and a recognizable file suffix. Local files must exist. Weixin sends images as `image_item` and regular files as `file_item`; both use `getuploadurl` plus CDN upload. Unsupported channels or failed media sends get a text fallback with the file location.

## Weixin Login State

By default, Weixin login state is stored under `state/weixin/` in the project root. The directory is ignored by Git. The account index is `state/weixin/accounts.json`; each account token and polling cursor is stored in `state/weixin/accounts/<accountId>.json`.

To invalidate Weixin login, stop the middleware and delete the whole `state/weixin/` directory. To remove only one account, delete its `state/weixin/accounts/<accountId>.json` file and, if needed, remove that account ID from `state/weixin/accounts.json`. The next `npm run cli:weixin:codex` or `npm run cli:weixin:login` run will start QR login again.

## Channel Commands

- `/help`: show available commands.
- `/new`: create a new Codex session for the current channel context.
- `/status`: show the Codex session, model, context token usage, cumulative token usage, bridge queue, approvals, permission mode, progress mode, and channel health.
- `/sessions`: list sessions known to the current channel context.
- `/sessions all` or `/all-sessions`: list all discoverable Codex history session IDs.
- `/resume <session>` / `/use <session>`: resume and bind a Codex session.
- `/progress [brief|detailed|silent]`: show or set progress delivery mode for the current channel context.
- `/permission [approval|full confirm]`: show or switch the permission mode for the currently bound Codex session; without a bound session it changes the default for future new sessions.
- `/OK`: approve the current Codex approval.
- `/NO [reason]`: deny the current Codex approval and record the reason.
- `/stop`: stop the currently running Codex task without ending the Codex session.

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

- [references/README.md](references/README.md): reference source index for the Weixin plugin npm package and optional Codex protocol source checkout.
- `openclaw-weixin-npm/`: local package download/extract directory, not committed.
- `references/openai-codex/`: optional local shallow clone of the official Codex repository, recreated from `references/README.md` and not committed.
