# 测试报告：引用恢复诊断及日志展示

日期：2026-10-15。环境：macOS，Node v24.14.0，当前 `main` 工作区；前序 Codex／微信协议改动未提交。本轮不连接真实微信或飞书。

## 目标

终端能定位本条消息和被引用的消息，区分原文来源、缓存缺失原因、局部选择回退和附件可用性。缓存未命中不能被报告为已经确认过期；日志改动不能影响 Codex 输入、命令／问答隔离或渠道发送次数。

## 分项验证

| 工作包 | 实际执行 | 结果 |
| --- | --- | --- |
| L1 | `npm run build`；引用解析、SQLite 缓存、微信 fake HTTP 及 Bridge 引用输入四组测试 | 14/14 通过，`/private/tmp/quote-diagnostics-l1-tests.log` |
| L2 | `npm run build`；引用 transcript、通用 transcript、Ink TUI、BridgeDelivery、微信 fake HTTP 及 Bridge 引用输入 | 53/53 通过，`/private/tmp/quote-diagnostics-l2-tests.log` |
| L3 | `npm test`（包含 TypeScript 构建和所有 unit／integration） | 首轮 637/637 通过；补齐空正文命中诊断后最终仍为 637/637、0 失败／跳过，约 13.31 秒；`/private/tmp/quote-diagnostics-final-tests.log` |

新增 8 项测试：引用 transcript 3 项、微信 HTTP 3 项、TUI 渲染 1 项、BridgeDelivery 回执传递 1 项。其余现有测试增加查询状态和缺失正文文案断言。

## 已覆盖行为

- 缓存命中、未命中、禁用、不可用以及未配置目录；数据库读取异常降级，正常收发继续。
- 命中空正文记录时明确报告“缓存没有可用正文”，不把它误报成局部选择校验失败。
- 跨会话未命中及过期清理后的未命中都不假定具体原因；缺少引用 ID 单独显示。
- 正确局部引用、锚点／校验失败的全文回退、原文缺失时无法恢复局部引用；旧式微信内嵌正文仍可直接使用。
- 无法下载的引用附件单独标记不可用。
- Console／TUI 显示完整的 20 位消息 ID；当前正文较长时，诊断元数据不会被 Console 正文截断移除。
- ID 中的换行与终端控制字符被转义；新增诊断不复制历史正文、选中片段、raw payload、context token、AES key 或 CDN URL。
- 真正渲染 Ink 日志视图，验证两个消息 ID、缓存未命中与当前输入可见。
- fake 微信 HTTP 发出回复后，服务端回执 ID 出现在 Bridge transcript；重启 adapter 后引用该 ID，恢复结果显示缓存命中，引用上下文仍进入 Codex。
- 普通回复、普通／实时进度与旁白传递回执；发送失败不会被记作已投递。引用诊断不进入 Codex 的 `quotedMessage` JSON。
- 旧版仅 `messageId` 的 transcript 调用保持兼容；仅在本机观察到的进度／旁白没有伪造服务端回执。

## 结论与限制

本轮实现与自动化验收通过。全量测试是在前序 629 项的基础上新增 8 项，前序协议及渠道功能共同回归。

`git diff --check` 通过；本次实施文档、测试报告及微信适配文档的本地 Markdown 链接检查无缺失。

没有验证真实手机端投递，也没有从真实日志证明用户引用的原文究竟为何缺失。缓存 ID 无法替代已经缺失的原文。媒体说明与附件分开发送时，transcript 当前显示最终附件回执；完整逐消息发送时间线和全局日志分组／筛选仍是后续范围。

代码没有 commit／push，没有重启服务或发布包。实施与后续设计见[引用消息诊断文档](../../docs/2026-10-15-quote-diagnostics.zh-CN.md)。
