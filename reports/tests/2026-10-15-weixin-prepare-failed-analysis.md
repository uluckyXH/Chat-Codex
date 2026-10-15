# 2026-10-15 微信 prepare failed 现状验证报告

## 测试目标

为[问题分析与方案](../../docs/2026-10-15-weixin-prepare-failed-analysis.zh-CN.md)验证当前客户端行为，区分已有逻辑、恢复缺口和未验证的服务端假设。本轮未修改运行时代码，没有向真实微信或飞书账号发送消息。

## 环境

- 日期：2026-10-15，Asia/Shanghai。
- 平台：macOS，Node.js `v24.14.0`。
- 项目：`main`，基线提交 `a85e0b7`，包版本 `0.1.5`。
- Codex 参考：`bb64b894fd67158be0f874872e6d7bfe717e7368`；未使用真实 Codex 模型进行本轮测试。
- 最新参考包：微信 `2.4.10`、飞书 `2026.7.16`。
- 渠道：注入 fake fetch / mock SDK，模拟账号、消息、token 均为虚构值。

## 构建与既有测试

```bash
npm run build
node --test dist/tests/integration/weixin-adapter-api.test.js dist/tests/integration/weixin-adapter-shell.test.js dist/tests/unit/weixin-message-mapping.test.js dist/tests/unit/feishu-adapter.test.js dist/tests/unit/feishu-message.test.js dist/tests/integration/feishu-bridge.test.js
```

结果：TypeScript 构建通过；**76 tests / 76 pass / 0 fail / 0 skipped**。

覆盖微信请求体、响应失败、退避、长轮询、消息映射、媒体和 typing，以及飞书 adapter、消息映射和 Bridge 接入。既有测试通过不代表此次恢复缺口已修复。

## 四项离线现状探针

探针直接导入本次构建的 `dist/src/`，使用内存 account store、注入的 fake fetch 和 `MockCodexAdapter`。通过 Promise 控制任务结束时机，不实际等待 5 分钟，不使用真实登录数据。脚本保留在本机临时目录 `/private/tmp/chat-codex-weixin-prepare-probe.mjs`，不进入发布包或项目源码。

### A. 长文本未经分段

向实际 `WeixinAdapter.sendText()` 传入 `"中".repeat(7337)`，fake fetch 返回成功，记录请求次数和正文长度。

```json
{"probe":"long-text-not-chunked","requests":1,"chars":7337,"bytes":22011}
```

确认 7,337 个汉字被放入一次 `sendmessage`。这证明缺少客户端分段，不证明该长度一定被真实微信拒绝。

### B. prepare failed 重试次数

所有 `sendmessage` 均模拟 HTTP 200，响应 `{ "ret": -2, "errcode": 0, "errmsg": "prepare failed" }`。重试次数配置为当前默认值 2，只将等待间隔设为 0 加快诊断。断言最终拒绝并保留原错误。

```json
{"probe":"prepare-failed-retries","requests":6,"hasContext":[true,true,true,false,false,false]}
```

确认先带 token 尝试 3 次，再不带 token 尝试 3 次。当前文档中的“fallback 一次”实际是一轮 fallback，而非仅一次 HTTP 请求。

### C. /fff 不更新正在执行任务的发送上下文

1. 用原 token 入站启动任务。
2. mock Codex 发出 `turn.started`，等待受控 Promise。
3. 同 route 注入 `/fff`，携带新 token。
4. 断言该命令没有出站文本。
5. 释放 Promise，mock Codex 输出最终文本并结束。
6. 检查真正发送的 final 请求体。

```json
{"probe":"fresh-inbound-during-turn","refreshCommandReplied":false,"finalUsesOriginalContext":true}
```

确认最终回复仍使用原 token；没有模拟或断言微信服务端的 token TTL。

### D. 最终回复失败后无自动补发

让 mock Codex 正常完成，只对最终文本模拟 `prepare failed`，收集 Bridge warning。随后同 route 注入带新 token 的 `/fff` 并等待 idle。

```json
{"probe":"failed-final-recovery","warningCount":1,"resendAfterFff":0,"bridgeStillRunning":true}
```

确认 Bridge 继续工作，但失败结果不会因为 `/fff` 自动补发。该探针为加速运行将 adapter 重试数设为 0，失败恢复结论不依赖默认重试次数。

## 参考来源校验

- Codex 与飞书参考 Git 更新均为 fast-forward，更新后工作区干净，`HEAD...origin/main` 为 `0 0`。
- 微信和飞书 tarball 的 SHA-512 与 npm Registry `dist.integrity` 一致；SHA-256 记录于分析文档及 `references/README.md`。
- 对照飞书 `2026.7.9 → 2026.7.16` 的 outbound/send、monitor 和 card-action-operator 文件，无差异；新增变化主要在卡片合成入站和表单分发。
- 第三方仓库、tarball、解包目录和 `dist/` 保持被 Git 忽略。
- `git diff --check` 通过；本轮涉及文档的 8 个相对链接均可解析到现有文件。

## 结论与限制

构建、76 项既有定向测试和 4 项现状探针均通过。源码中已确认旧 target、未分段、重试放大和缺少失败补发的问题；**本轮是诊断，缺口尚未修复**。

用户确认本次约运行 5 分钟后失败，但未提供正文长度或新入站后的短回复结果。没有真实微信服务端实验，不能认定固定 token 有效期，也不能证明此单次故障唯一由上下文引发。本轮未运行全量 `npm test`；实施修复后再运行全量回归并补真实长任务测试。
