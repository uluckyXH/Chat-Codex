# 2026-05-14 /sendfile gated media

## Scope

- Disable automatic media extraction from ordinary prompts, progress events, and final replies.
- Add `/sendfile <task>` as a per-turn authorization path for final file delivery.
- Parse only final-answer `BRIDGE_SEND_FILE: /absolute/path/to/file` lines for `/sendfile` turns.
- Strip bridge protocol lines from visible replies.
- Report media send failures as one aggregate message instead of one fallback message per file.

## Verification

```bash
npm run build
node --test dist/tests/unit/media-extractor.test.js dist/tests/integration/bridge-mock.test.js
npm test
```

## Result

- Targeted media and Bridge tests passed: 30 tests.
- Full test suite passed: 88 tests.
