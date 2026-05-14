# OpenClaw Feishu 参考源码

本目录记录 OpenClaw 飞书 / Lark 官方渠道插件的本地参考来源。

结论：有源码。`@openclaw/feishu` 的 npm 包只发布编译后的 `dist/`、插件清单和 skills；真正的 TypeScript 源码在 OpenClaw 官方 monorepo 里：

- 插件源码：`references/openclaw/extensions/feishu/src/`
- 插件入口：`references/openclaw/extensions/feishu/`
- 渠道文档：`references/openclaw/docs/channels/feishu.md`
- 插件参考文档：`references/openclaw/docs/plugins/reference/feishu.md`

当前本地已拉取两类参考材料：

- npm 包：`openclaw-feishu-npm/openclaw-feishu-2026.5.7.tgz`
- npm 解包：`openclaw-feishu-npm/extracted/openclaw-feishu-2026.5.7/`
- 官方源码仓库：`references/openclaw/`
- 当前源码仓库提交：`1f45b37f`

包信息：

- 包名：`@openclaw/feishu`
- stable 版本：`2026.5.7`
- beta dist-tag：`2026.5.12-beta.8`
- 渠道 id：`feishu`
- alias：`lark`
- 仓库：`https://github.com/openclaw/openclaw`
- npm tarball sha256：`7349aae1e2819d5b24bd0fc5ad907e1154e64c7874f1301b24186e4913e31447`

## 重新拉取

下载 stable npm 包：

```bash
mkdir -p openclaw-feishu-npm
npm --cache /private/tmp/codex-npm-cache pack @openclaw/feishu@2026.5.7 --pack-destination openclaw-feishu-npm
```

解包：

```bash
mkdir -p openclaw-feishu-npm/extracted
tar -xzf openclaw-feishu-npm/openclaw-feishu-2026.5.7.tgz -C openclaw-feishu-npm/extracted
mv openclaw-feishu-npm/extracted/package openclaw-feishu-npm/extracted/openclaw-feishu-2026.5.7
```

拉取官方源码仓库：

```bash
git clone --depth 1 --filter=blob:none https://github.com/openclaw/openclaw.git references/openclaw
```

如果本地目录已存在，先手动移走旧目录，再重新执行上面的命令。

## 关注文件

飞书渠道的收发和运行时逻辑主要在这些文件里：

- `references/openclaw/extensions/feishu/src/channel.ts`
- `references/openclaw/extensions/feishu/src/outbound.ts`
- `references/openclaw/extensions/feishu/src/send.ts`
- `references/openclaw/extensions/feishu/src/monitor.ts`
- `references/openclaw/extensions/feishu/src/monitor.message-handler.ts`
- `references/openclaw/extensions/feishu/src/reply-dispatcher.ts`
- `references/openclaw/extensions/feishu/src/config-schema.ts`
- `references/openclaw/extensions/feishu/src/accounts.ts`

## 提交约定

`openclaw-feishu-npm/` 和 `references/openclaw/` 是本地参考目录，不提交到本项目 Git 仓库。仓库只提交本说明文件，避免把第三方大仓和 npm 解包产物混进来。
