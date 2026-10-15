# 参考源码索引

本目录只提交这个 README，用来说明相关参考源码从哪里获取。实际下载的源码、npm 包、解包目录和第三方仓库都只保留在本地，不提交到本项目仓库。

## 放置规范

- 第三方 Git 源码仓库统一放在 `references/<repo-name>/`，例如 `references/openclaw-lark/`、`references/openai-codex/`。
- 只有 npm 包、没有必要直接使用 Git 仓库时，下载和解包目录放在项目根目录的 `<package>-npm/`，例如 `openclaw-weixin-npm/`。
- `references/` 下除本 README 外的内容全部被 Git 忽略。
- `openclaw-weixin-npm/` 和 `openclaw-lark-npm/` 被 Git 忽略。
- 不下载完整 OpenClaw 源码；只下载需要参考的通讯渠道插件源码或插件 npm 包。

## 微信插件源码

本项目只参考 `@tencent-weixin/openclaw-weixin` 这个 npm 包里的微信通讯能力，不需要下载完整 OpenClaw 源码，也不依赖 OpenClaw CLI、gateway、host runtime 或 channel runtime。

- 包名：`@tencent-weixin/openclaw-weixin`
- 当前源码协议基线及默认上报 `channel_version`：`2.4.10`；已安装／运行中的旧程序须重新构建和重启才生效
- 最新已审阅稳定包：`2.4.10`（2026-10-15 再次查询 npm `latest`）；ID／回执／引用／收发实现与测试见[实施文档](../docs/2026-10-15-weixin-2.4.10-protocol-implementation.zh-CN.md)
- npm `beta`：`2.4.9-beta.0`（同日查询，版本低于当前 stable）
- 本地临时目录：`openclaw-weixin-npm/`
- 最新解包源码：`openclaw-weixin-npm/extracted/openclaw-weixin-2.4.10/`；保留 `2.4.6/` 供对照
- 本轮评估：[2026-10-15 微信发送失败排查与方案](../docs/2026-10-15-weixin-prepare-failed-analysis.zh-CN.md)
- 后续设计：[微信／飞书长文本投递与新版适配](../docs/2026-10-15-channel-long-text-delivery-design.zh-CN.md)，长文本／通用发送恢复仍待实施；微信新版协议工作单独验收
- 摘要链路补充：[OpenClaw 中途摘要到微信](../docs/2026-10-15-openclaw-weixin-commentary-analysis.zh-CN.md)。仅定向读取宿主 main `72cc53bfce336777f23fbe941af10ad9abe4d8ae` 的事件转换与分发文件，未下载完整仓库，也不引入宿主依赖。

在项目根目录执行：

```bash
mkdir -p openclaw-weixin-npm
npm pack @tencent-weixin/openclaw-weixin@2.4.10 --ignore-scripts --registry=https://registry.npmjs.org --pack-destination openclaw-weixin-npm
mkdir -p openclaw-weixin-npm/extracted/openclaw-weixin-2.4.10
tar -xzf openclaw-weixin-npm/tencent-weixin-openclaw-weixin-2.4.10.tgz -C openclaw-weixin-npm/extracted/openclaw-weixin-2.4.10 --strip-components=1
```

可选校验：

```bash
shasum -a 256 openclaw-weixin-npm/tencent-weixin-openclaw-weixin-2.4.10.tgz
```

当前已知 SHA-256：

```text
69dd18af16a992edbe3700d244f9591ab52f5f58abfe976a9f1250bd8eacdbbb  tencent-weixin-openclaw-weixin-2.4.10.tgz
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
- 当前已审阅 npm latest：`2026.7.16`（2026-10-15 查询）
- npm beta：`2026.8.5-beta.0`（仅记录，不作为稳定版基线）
- 当前 npm tarball：`https://registry.npmjs.org/@larksuite/openclaw-lark/-/openclaw-lark-2026.7.16.tgz`
- 本地临时源码目录：`references/openclaw-lark/`
- 2026-10-15 Git 更新：`6d95621526c37fb8952953bfb9264ac185cedcdb` → `dde0be3680d6fd5443cab426c8f4b3216266346a`，与本次 fetch 的 `origin/main` 一致
- 注意：该 Git HEAD 的 `package.json` 仍为 `2026.7.9`；发布版比较使用 npm 包，不能混用版本号
- 本地 npm 解包目录：`openclaw-lark-npm/extracted/openclaw-lark-2026.7.16/`；旧版目录保留
- 本地 tarball 文件名：`larksuite-openclaw-lark-2026.7.16.tgz`
- 当前 tarball SHA-256：`1d69f11ede0af19cef48e1f80abb98e35b7f34e8f9df7942527551c8824a61fa`
- Chat-Codex 当前仍直接使用 `@larksuiteoapi/node-sdk@1.71.1`，本次仅更新参考资料
- 2026-10-15 查询 SDK npm latest 为 `1.75.0`；仅核实元数据，尚未升级、下载审计或验证兼容性，计划见[长文本与新版适配设计](../docs/2026-10-15-channel-long-text-delivery-design.zh-CN.md)

在项目根目录执行：

```bash
git clone --depth 1 --filter=blob:none https://github.com/larksuite/openclaw-lark.git references/openclaw-lark
```

如果目录已存在，只更新这个插件仓库：

```bash
git -C references/openclaw-lark pull --ff-only
```

下载稳定发布包供对照：

```bash
mkdir -p openclaw-lark-npm
npm pack @larksuite/openclaw-lark@2026.7.16 --ignore-scripts --registry=https://registry.npmjs.org --pack-destination openclaw-lark-npm
mkdir -p openclaw-lark-npm/extracted/openclaw-lark-2026.7.16
tar -xzf openclaw-lark-npm/larksuite-openclaw-lark-2026.7.16.tgz -C openclaw-lark-npm/extracted/openclaw-lark-2026.7.16 --strip-components=1
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

已有目录先确认没有本地改动，再 fast-forward 更新：

```bash
git -C references/openai-codex status --short
git -C references/openai-codex pull --ff-only
git -C references/openai-codex log -1 --format='%H %cI %s'
```

2026-10-15 已从 `92bc601ad60542c92bf0bb1e7a2eb70b84ac49d2` 更新到 `bb64b894fd67158be0f874872e6d7bfe717e7368`（提交时间：2026-10-15 11:48:33，北京时间），与本次 fetch 的 `origin/main` 一致。此操作只更新参考仓库，不升级实际运行的 Codex CLI，也不表示完成所有新版协议适配。

同日后续重新 fetch，HEAD 与 origin/main 仍一致，参考工作区干净。本机 shell CLI 为 `0.162.1`，当次 npm latest 同为 `0.162.1`、alpha 为 `0.163.0-alpha.11`。已从本机 CLI 导出默认和 experimental TypeScript schema；本项目启用了 experimentalApi。原审计见[能力审计](../docs/2026-10-15-codex-cli-compatibility-audit.zh-CN.md)，本批中间件适配及真实 CLI 只读验证已完成，见[实施进度](../docs/2026-10-15-codex-cli-protocol-implementation.zh-CN.md)。真实模型／渠道场景单列验收。

## 提交规则

- `references/` 下除本 README 外的内容不提交。
- `openclaw-weixin-npm/` 和 `openclaw-lark-npm/` 不提交。
- 不提交 npm tarball、解包源码、第三方源码仓库或运行态文件。
