# 参考源码

本目录用于存放本地参考源码。

- `feishu/`：`@openclaw/feishu` 官方飞书 / Lark 渠道插件源码参考说明。实际 npm tarball 和解包内容放在项目根目录的 `openclaw-feishu-npm/`，官方 OpenClaw monorepo shallow clone 放在 `references/openclaw/`，这些目录不提交。
- `openai-codex/`：OpenAI Codex 官方开源仓库的本地 shallow clone，用于查协议和实现细节。
- `openclaw-weixin/`：`@tencent-weixin/openclaw-weixin` 源码参考说明。实际 npm tarball 和解包源码放在项目根目录的 `openclaw-weixin-npm/`，该目录不提交。
- `openclaw/`：OpenClaw 官方 monorepo 的本地 shallow clone，用于查看 Feishu 等官方插件源码，不提交。

`openai-codex/` 和 `openclaw/` 不提交到本项目 Git 仓库。需要重新拉取 Codex 参考源码时执行：

```bash
git clone --depth 1 --filter=blob:none https://github.com/openai/codex.git references/openai-codex
```

`openclaw-feishu-npm/` 和 `openclaw-weixin-npm/` 也不提交到本项目 Git 仓库。需要重新下载和解包时见：

- [feishu/README.md](feishu/README.md)
- [openclaw-weixin/README.md](openclaw-weixin/README.md)
