# Codex Weixin Middleware

README versions:

- Chinese: [README.zh-CN.md](README.zh-CN.md)
- English: [README.en.md](README.en.md)

This repository contains a lightweight middleware for connecting Codex to chat channels. Weixin is the first channel adapter, implemented by adapting the communication capability extracted from `@tencent-weixin/openclaw-weixin`.

Runtime boundary: this project does not depend on OpenClaw CLI, OpenClaw gateway, OpenClaw host runtime, or OpenClaw channel runtime.

Reference source checkout instructions live in [references/README.md](references/README.md). The `openclaw-weixin-npm/` package download/extract directory is local-only and is not committed.

## Agent Development Rules

Use this section as the quick-start guidance for coding agents working in this repository. The detailed source of truth is [docs/development-and-test.zh-CN.md](docs/development-and-test.zh-CN.md) and [docs/git-management.zh-CN.md](docs/git-management.zh-CN.md).

Agent reading order:

1. [docs/README.md](docs/README.md): document index, project boundary, and recommended reading order.
2. [docs/requirements.zh-CN.md](docs/requirements.zh-CN.md): product requirements, supported commands, safety expectations, and non-goals.
3. [docs/technical-design.zh-CN.md](docs/technical-design.zh-CN.md): architecture, adapter boundaries, route key design, Codex/Weixin integration, and phased implementation plan.
4. [docs/channel-delivery-policy.zh-CN.md](docs/channel-delivery-policy.zh-CN.md): channel-specific delivery policy for task-start, progress, `/progress`, and refresh commands.
5. [docs/development-and-test.zh-CN.md](docs/development-and-test.zh-CN.md): coding rules, module-splitting rules, testing requirements, and Chinese test report format.
6. [docs/git-management.zh-CN.md](docs/git-management.zh-CN.md): repository boundaries, ignored local artifacts, and pre-commit requirements.
7. [references/README.md](references/README.md): how to fetch local reference sources such as `@tencent-weixin/openclaw-weixin`; reference downloads are local-only and must not be committed.

Core rules:

- Prefer Chinese for project docs, test reports, and development notes.
- Keep the project lightweight: Node.js + TypeScript only; do not add heavy frameworks such as NestJS or Next.js.
- Keep Codex logic, channel logic, command parsing, approvals, state storage, and logging in separate modules.
- Bridge Core must depend only on the generic channel protocol. Do not import `openclaw-weixin` raw types inside Bridge Core.
- A concrete channel adapter must implement `ChannelAdapter`, normalize raw inbound data to `ChannelMessage`, provide stable `routeKey` values, declare `ChannelCapabilities`, and expose `getStatus()`.
- Express channel-specific delivery behavior through generic capabilities, delivery policy, or adapter-owned behavior. Avoid direct `if channel === "weixin"` branches in Bridge Core; temporary exceptions need tests and a clear follow-up path back to a generic policy.
- Do not let command handling or approval handling call Weixin APIs directly.

Directory boundaries:

- `src/channels/<channel-id>/`: concrete channel adapters.
- `src/codex/`: Codex adapters and Codex protocol handling.
- `src/commands/` or `src/bridge/commands/`: command parsing and command-specific behavior.
- `src/approvals/` or `src/bridge/approvals/`: approval state and approval mapping.
- `src/state/`: state storage.
- `src/logging/`: logging, transcript formatting, and redaction.
- `reports/tests/`: Chinese test reports for every feature change or real-channel fix.

Module-splitting rules:

- Split by functional boundaries first: responsibility, protocol boundary, state ownership, lifecycle, and test boundary matter more than raw line count.
- Keep files focused on one responsibility. If a file starts mixing transport, mapping, retries, command handling, persistence, and formatting, split it along those responsibilities.
- Prefer extracting pure helpers before a file becomes hard to scan: message mapping, request builders, retry policy, formatting, persistence, and test fixtures should be separate when they grow.
- Treat roughly 300-400 lines as a review trigger, not a hard ban. Above that, check whether the file has multiple responsibilities or unclear test boundaries. Above roughly 600 lines, prefer splitting unless the file is mostly declarative types, generated-like tables, tests, or a cohesive state machine whose split would make behavior harder to follow.
- Do not split tightly coupled logic only to satisfy a number. A few coherent larger modules are better than many tiny files with hidden shared state or circular dependencies.
- Keep public interfaces small. Put shared types in focused type/protocol files instead of importing concrete adapter internals across layers.
- When adding a new capability, extend the established module for that responsibility rather than expanding a large central switch or a catch-all utility file.
- Tests should mirror the split: unit-test pure helpers and protocol mapping directly; use integration tests for Bridge/Core flow.

Testing and commit hygiene:

- Every feature or behavior fix needs self-test coverage or a clear note that real Weixin testing is pending user login.
- Every self-test needs a Chinese report under `reports/tests/`, named like `YYYY-MM-DD-feature-name.md`.
- Before committing, run:

```bash
git status --short --ignored
npm test
```

- Never commit `node_modules/`, `dist/`, `coverage/`, runtime state, logs, `.env`, token/cookie files, Weixin login state, `openclaw-weixin-npm/`, or local reference source under `references/` except `references/README.md`.

License: [MIT](LICENSE). Authors: 小黄 and Codex.
