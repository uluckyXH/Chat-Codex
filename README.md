# Codex Weixin Middleware

This project is a planning workspace for a lightweight middleware that connects Codex to the Weixin communication capability extracted from `@tencent-weixin/openclaw-weixin`.

This project is OpenClaw-free at runtime: it must not depend on OpenClaw CLI, OpenClaw gateway, OpenClaw host runtime, or OpenClaw channel runtime. The `openclaw-weixin` package is used as the Weixin channel reference and adaptation source.

Current status:

- Project folder created.
- Official npm package archive stored under `openclaw-weixin-npm/`.
- OpenAI Codex source reference cloned under `references/openai-codex/`.
- Documentation index is available at `docs/README.md`.
- Requirements are documented in `docs/requirements.zh-CN.md`.
- Technical design notes are documented in `docs/technical-design.zh-CN.md`.
- Git management rules are documented in `docs/git-management.zh-CN.md`.
- An English draft is also available at `docs/requirements.md`.
- Phase 1 implementation has started: generic channel protocol, mock channel, terminal channel, bridge core, command handling, approval manager, mock Codex adapter, initial `codex exec --json` adapter, CLI mock flow, and tests are present.
- Phase 2 Weixin work has started: QR login API, local account token store, text `sendmessage`, and inbound message mapping are implemented with fake-fetch tests. Real Weixin login still requires user-assisted scanning.

Useful local commands:

```bash
npm test
npm run cli:mock
npm run cli:terminal:mock
npm run cli:terminal:codex
npm run cli:weixin:status
npm run cli:weixin:login
```

Vendored reference package:

- `openclaw-weixin-npm/tencent-weixin-openclaw-weixin-2.4.3.tgz`
- `openclaw-weixin-npm/extracted/openclaw-weixin-2.4.3/`

Source references:

- `references/openai-codex/`: shallow clone of `https://github.com/openai/codex.git`
