# 参考源码索引

本目录只提交这个 README，用来说明相关参考源码从哪里获取。实际下载的源码、npm 包、解包目录和第三方仓库都只保留在本地，不提交到本项目仓库。

## 放置规范

- 第三方 Git 源码仓库统一放在 `references/<repo-name>/`，例如 `references/openclaw-lark/`、`references/openai-codex/`。
- 只有 npm 包、没有必要直接使用 Git 仓库时，下载和解包目录放在项目根目录的 `<package>-npm/`，例如 `openclaw-weixin-npm/`。
- `references/` 下除本 README 外的内容全部被 Git 忽略。
- `openclaw-weixin-npm/` 被 Git 忽略。
- 不下载完整 OpenClaw 源码；只下载需要参考的通讯渠道插件源码或插件 npm 包。

## 微信插件源码

本项目只参考 `@tencent-weixin/openclaw-weixin` 这个 npm 包里的微信通讯能力，不需要下载完整 OpenClaw 源码，也不依赖 OpenClaw CLI、gateway、host runtime 或 channel runtime。

- 包名：`@tencent-weixin/openclaw-weixin`
- 当前适配参考版本：`2.4.3`
- 本地临时目录：`openclaw-weixin-npm/`
- 解包后源码：`openclaw-weixin-npm/extracted/openclaw-weixin-2.4.3/`

在项目根目录执行：

```bash
mkdir -p openclaw-weixin-npm
npm pack @tencent-weixin/openclaw-weixin@2.4.3 --pack-destination openclaw-weixin-npm
rm -rf openclaw-weixin-npm/extracted
mkdir -p openclaw-weixin-npm/extracted
tar -xzf openclaw-weixin-npm/tencent-weixin-openclaw-weixin-2.4.3.tgz -C openclaw-weixin-npm/extracted
mv openclaw-weixin-npm/extracted/package openclaw-weixin-npm/extracted/openclaw-weixin-2.4.3
```

可选校验：

```bash
shasum -a 256 openclaw-weixin-npm/tencent-weixin-openclaw-weixin-2.4.3.tgz
```

当前已知 SHA-256：

```text
422ee96c2fca294d6d80c193c2797d2a046cb8b512b84b0705c85865f0251bb7  tencent-weixin-openclaw-weixin-2.4.3.tgz
```

常用参考文件：

- `src/messaging/inbound.ts`：入站消息转换和 `context_token` 处理。
- `src/messaging/send.ts`：出站文本和媒体消息请求构造。
- `src/messaging/process-message.ts`：OpenClaw 消息管线参考行为。
- `src/api/api.ts`：底层微信 API 调用。
- `src/api/types.ts`：微信 API 请求和响应类型。

## 飞书插件源码

本项目如需参考飞书通讯渠道，只下载飞书 OpenClaw 通讯渠道插件源码，不下载完整 OpenClaw 源码。

- 官方配置文档：`https://www.feishu.cn/content/article/7613711414611463386`
- 源码仓库：`https://github.com/larksuite/openclaw-lark`
- npm 包名：`@larksuite/openclaw-lark`
- npm 包页面：`https://www.npmjs.com/package/@larksuite/openclaw-lark`
- 当前 npm latest：`2026.5.13`
- 当前 npm tarball：`https://registry.npmjs.org/@larksuite/openclaw-lark/-/openclaw-lark-2026.5.13.tgz`
- 本地临时源码目录：`references/openclaw-lark/`

在项目根目录执行：

```bash
git clone --depth 1 --filter=blob:none https://github.com/larksuite/openclaw-lark.git references/openclaw-lark
```

如果目录已存在，只更新这个插件仓库：

```bash
git -C references/openclaw-lark pull --ff-only
```

常用参考文件：

- `package.json`：包名、版本、peer dependency 和入口配置。
- `openclaw.plugin.json`：OpenClaw 插件声明。
- `index.ts`：插件入口。
- `src/`：飞书通讯渠道实现。
- `tests/`：官方插件测试用例。

## Codex 协议参考

Codex 不是微信插件源码；只有在需要核对 Codex app-server、exec JSONL 或审批协议时，才拉取 OpenAI Codex 官方仓库作为本地参考。

本地临时目录：`references/openai-codex/`

```bash
git clone --depth 1 --filter=blob:none https://github.com/openai/codex.git references/openai-codex
```

## 提交规则

- `references/` 下除本 README 外的内容不提交。
- `openclaw-weixin-npm/` 不提交。
- 不提交 npm tarball、解包源码、第三方源码仓库或运行态文件。
