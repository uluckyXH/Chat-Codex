# Codex Weixin Middleware

This project is a lightweight middleware that connects Codex to pluggable chat channels. Weixin is the first channel adapter, implemented by adapting the communication capability extracted from `@tencent-weixin/openclaw-weixin`.

This project is OpenClaw-free at runtime. It must not depend on OpenClaw CLI, OpenClaw gateway, OpenClaw host runtime, or OpenClaw channel runtime. The `openclaw-weixin` package is only used as the Weixin communication reference and adaptation source.

## Current Status

- Node.js + TypeScript project scaffold is in place.
- The official npm package archive is stored under `openclaw-weixin-npm/`.
- A generic `ChannelAdapter` protocol is implemented so future channels can reuse the same bridge core.
- Mock, Terminal, and Weixin channel adapters are implemented.
- Bridge Core, command routing, approval management, memory state, and baseline logging are implemented.
- The `codex exec --json` adapter is implemented and has been verified through the terminal channel with the real Codex CLI.
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
- `--permission approval|full`: choose safe sandbox mode or full permission mode. With the current `codex exec` adapter, `approval` uses the `workspace-write` sandbox but does not create interactive approvals; real Weixin approvals require a later app-server adapter.
- `--yes-dangerously-full`: non-interactive confirmation for full permission mode. Full mode bypasses approvals and sandboxing and is high risk.
- `--progress brief|detailed|silent`: set the default progress delivery mode. `brief` is the default and suppresses command/tool details; `detailed` keeps full command/tool progress; `silent` sends only start, approvals, final replies, and media.

During interactive startup, the middleware asks for the session first and then asks for the Codex permission mode for subsequent tasks. This keeps permission selection clear when resuming an older session. Choosing a new session displays the default working directory; missing directories are created automatically. If an existing session is selected, the middleware uses the working directory recorded in that Codex session history.

The current `codex exec --json` mode can reuse Codex history sessions, but it does not live-sync Weixin-side interaction into another already-open Codex CLI or Codex App window. Real-time multi-view synchronization needs a later app-server/event-subscription adapter, or a middleware-owned observer UI where the middleware is the single session entry point.

Normal messages from the same channel context are processed sequentially. If Codex is already running and another normal message arrives, the middleware replies with a queued notice; commands such as `/status`, `/stop`, and approval commands still run immediately. Each task starts with a short "processing" notice and does not repeat the Session ID; use `/status` for session and permission details. Current progress updates come from events visible in `codex exec --json`. The default `brief` progress mode sends planning/reasoning, search, and file-change summaries, but suppresses command/tool details. Use `/progress detailed` or `--progress detailed` when full debugging detail is needed. Finer same-turn steering needs a later app-server adapter.

Weixin outbound messages are serialized with a small interval to reduce dropped or hidden rapid-fire progress messages. The default send interval is 1200ms. If `sendmessage` hits rate limiting or a temporary failure, the adapter retries with backoff; only the final failure moves the channel to `degraded` and records `lastError`, instead of logging the request as a successful OUT. While Codex is running, the Weixin channel fetches a `typing_ticket` with `getconfig`, then periodically calls `sendtyping` to keep the peer-side "typing" state visible; it stops typing when the task finishes or `/stop` is used.

When Codex output contains an accessible media reference, the bridge sends the text first and then attempts a media message. Images are detected from common image suffixes. Regular files are extracted only from explicit references such as Markdown links, `MEDIA:`/`FILE:` directives, and `File:`/`Attachment:` labels, so code paths in progress summaries are not sent as attachments. Local files must exist. Weixin sends images as `image_item` and regular files as `file_item`; both use `getuploadurl` plus CDN upload. Unsupported channels or failed media sends get a text fallback with the file location.

## Weixin Login State

By default, Weixin login state is stored under `state/weixin/` in the project root. The directory is ignored by Git. The account index is `state/weixin/accounts.json`; each account token and polling cursor is stored in `state/weixin/accounts/<accountId>.json`.

To invalidate Weixin login, stop the middleware and delete the whole `state/weixin/` directory. To remove only one account, delete its `state/weixin/accounts/<accountId>.json` file and, if needed, remove that account ID from `state/weixin/accounts.json`. The next `npm run cli:weixin:codex` or `npm run cli:weixin:login` run will start QR login again.

## Channel Commands

- `/help`: show available commands.
- `/new`: create a new Codex session for the current channel context.
- `/status`: show Bridge, channel, Codex, processing, queue, session, and working directory status.
- `/sessions`: list sessions known to the current channel context.
- `/sessions all` or `/all-sessions`: list all discoverable Codex history session IDs.
- `/resume <session>` / `/use <session>`: resume and bind a Codex session.
- `/progress [brief|detailed|silent]`: show or set progress delivery mode for the current channel context.
- `/permission [approval|full confirm]`: show or switch the Codex permission mode.
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

## References

- `openclaw-weixin-npm/tencent-weixin-openclaw-weixin-2.4.3.tgz`
- `openclaw-weixin-npm/extracted/openclaw-weixin-2.4.3/`
- `references/openai-codex/`
