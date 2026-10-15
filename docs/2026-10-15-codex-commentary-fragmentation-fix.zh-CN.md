# Codex 旁白碎片化修复进度

日期：2026-10-15。基线：`7207cbc`。用户已授权修复、回写测试结果并推送。源码排查和修复前的证据见[问题分析](2026-10-15-codex-commentary-fragmentation-analysis.zh-CN.md)。

## 修复约定

旁白以 Codex 的 `agentMessage` item 为单位：delta 只累积，收到 `item/completed` 才发布一次完整旁白，以完成事件的正文为准。此时任务仍可继续运行，不必等 `turn/completed`。日志与渠道使用同一份完整消息；`realtime` 表示完整旁白一完成就发送。

去重使用 session／turn／item 身份，同文的不同 item 和正文内的重复句子均保留。brief 保留原来的 3 秒合并间隔，待发完整消息按顺序合并，不再只保留最后三条或在旁白层截断正文。发送成功状态跟随消息身份，供前台、后台和定时发送后的 commentary-only 兜底判断使用。

已知为 commentary、但没有收到 item 完成事件的残片不发布为完整消息；失败或中断仍使用已有终止通知。普通 reasoning／工具进度、partial／async 问答和最终回复保持各自语义。微信现有 silent／brief 策略与发送限制不变，通用长文本拆分／文件降级继续单列；渠道可能拒绝超长正文，本次不承诺绕过限制。

## 分项进度

| 项目 | 状态 | 验证 |
| --- | --- | --- |
| 协议侧按 item 完成收束、移除旁白提前切片和文本去重 | 已完成 | 构建通过；协议定向测试 21/21 通过，包含新增 15 项旁白边界用例 |
| 投递侧完整消息合并、身份去重与前后台兜底 | 已完成 | 第二阶段 78/78 通过，含 11 项新增投递回归和修正后的进程级分片用例 |
| 协议到 Bridge 的集成回归 | 已完成 | 新增 39 项集成回归＋16 项投递单测，55/55 通过 |
| 全量测试 | 已完成 | `npm test` 构建通过，721/721，0 失败／跳过 |
| 文档与交付准备 | 已完成 | 问题分析、现行设计、索引和测试报告已同步；Git 推送结果在交付回执核对 |

故障发生在另一台电脑。此修复的验收依据为官方参考源码、本项目真实事件处理链路及本地模拟测试；现场运行结果需在该电脑更新并重启后核实。

### 协议阶段验证

`npm run build` 和 `node --test dist/tests/unit/codex-commentary-messages.test.js dist/tests/unit/codex-protocol-messages.test.js` 通过。新增断言覆盖单块／逐字／标点切片、版本／路径／URL、Markdown 缩进、超过 400／1200 字符、completion 补充／替换／清空、重复通知、同文不同 item、交错 item、缺少 started、缺少 item ID、缺少 completed、失败／中断／断线。既有 partial、async 问答、final 和终止状态用例继续通过。第一次编译发现测试中空数组断言导致 TypeScript 过度收窄，改成长度断言后通过，无运行时代码回退。

### 投递阶段验证

在上述两个测试文件外增加 `bridge-commentary-delivery.test.js`、`app-server-codex-adapter.test.js`，构建与 78 项定向测试全部通过，耗时约 15.31 秒。新增投递断言覆盖：六条完整旁白合并不丢中间正文；三种模式的长正文和 Markdown 缩进；按 session／turn／item 去重、同文不同消息保留；无 ID 的旧事件保留；定时发送更新消息回执，结束时等待在途发送；失败不误标成功；清理路由取消待发并清除去重状态。

前台／后台都保存完整旁白的发送回执，不再以 `deliveredText.includes(lastText)` 猜测最后一条是否送达。原进程级测试的第一块没有触发旧分片规则，现改为每块都带句号，并要求保留只在 completion 中出现的结论。

### 集成阶段验证

`commentary-protocol-bridge.test.js` 经真实 `AppServerTurnController → Bridge → RuntimeTuiTranscriptSink` 验证前台与后台自动续跑，覆盖微信策略 silent／brief、飞书策略 silent／brief／realtime、Plan 例外、独立 final、commentary-only、六条消息合并、同文不同 item、completion 修正、未完成消息的正常／失败／中断结束、发送失败兜底。另有三项经过真实 FeishuAdapter 和 fake SDK 检查完整请求正文；不连接真实微信或飞书。

本阶段 39 项集成测试和 16 项投递单测共 55/55 通过，约 1.28 秒。补测并修正了等待在途发送期间清理 route 的边界，避免旧 flush 恢复已取消的待发消息。首次集成验证中四项失败源于断言未计入已有的“旁白发送失败”诊断日志；现同时断言完整观察记录、完整失败诊断、成功发送正文及尝试次数。测试辅助代码也改用 ES2022 支持的 Promise 写法，未变更运行目标。

### 全量验收

`npm test`：721/721 通过，0 失败、0 取消、0 跳过，测试约 15.71 秒。相对基线增加 66 项有效回归，覆盖协议、真实 Bridge 前后台链路、真实 TUI transcript sink，以及真实 FeishuAdapter 配合 fake SDK 的发送正文。构建通过，`git diff --check` 通过。完整命令、逐场景结果和调试记录见[测试报告](../reports/tests/2026-10-15-codex-commentary-fragmentation-fix.md)。

实际使用变化：一条旁白在生成完成后整体出现，任务可以继续运行。正常本地观察不再按传输碎片追加，已投递／失败诊断仍单独保留。只有完整旁白、没有最终答案的正常轮次，按该消息的真实回执决定是否补发完整兜底。TUI 实时草稿预览和全局日志面板改版未纳入本次。
