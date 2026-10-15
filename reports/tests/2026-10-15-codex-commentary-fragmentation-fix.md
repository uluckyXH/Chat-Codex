# 测试报告：Codex 旁白按完整消息收束

日期：2026-10-15。环境：macOS、Node v24.14.0。修复基线 `7207cbc`；Codex 语义依据为本地参考 `bb64b894fd67158be0f874872e6d7bfe717e7368`。实现说明见[修复进度](../../docs/2026-10-15-codex-commentary-fragmentation-fix.zh-CN.md)，旧缺陷证据见[排查报告](2026-10-15-codex-commentary-fragmentation-audit.md)。

## 结果

构建通过；全量 **721/721 通过，0 失败、0 取消、0 跳过**，测试执行约 15.71 秒（不含构建）。较基线 655 项新增 66 项：15 项协议旁白单测、12 项投递单测、39 项协议到 Bridge 集成测试；另强化一个原有进程级用例。

`git diff --check` 通过；本次六份文档的 18 个本地 Markdown 链接均指向存在的文件。

没有连接真实模型、微信或飞书，也没有读取故障电脑的日志。本报告验证本地代码链路与模拟请求，不代表故障电脑已经更新运行，也不能证明真实渠道不再限流。

## 分阶段命令与结果

| 阶段 | 范围 | 结果 |
| --- | --- | --- |
| 协议收束 | 新增 commentary 单测＋既有 protocol messages | 21/21，约 0.05 秒 |
| 投递与进程适配 | 上述两组＋commentary delivery＋app-server adapter | 78/78，约 15.31 秒 |
| 集成与在途清理边界 | 新增 protocol bridge＋commentary delivery | 55/55，约 1.28 秒 |
| 最终全量 | 全部 unit／integration | 721/721，约 15.71 秒 |

这些阶段有重叠，不能相加作为独立测试总数。每阶段先执行 `npm run build`。可复验命令：

```sh
node --test dist/tests/unit/codex-commentary-messages.test.js dist/tests/unit/codex-protocol-messages.test.js
node --test dist/tests/unit/codex-commentary-messages.test.js dist/tests/unit/codex-protocol-messages.test.js dist/tests/unit/bridge-commentary-delivery.test.js dist/tests/unit/app-server-codex-adapter.test.js
node --test dist/tests/integration/commentary-protocol-bridge.test.js dist/tests/unit/bridge-commentary-delivery.test.js
npm test
git diff --check
```

阶段二执行时投递文件有 15 项，阶段三复查后增加了第 16 项在途清理测试，因此再次运行阶段二命令会得到 79 项。

## 核心回归证据

与排查阶段一致，使用包含中文标点、编号、版本、路径和 URL 的 88 字符正文，按 17 个 delta 输入一个 commentary item。断言经真实 controller、Bridge、TUI transcript sink 得到以下结果：

| 场景 | 修复前模拟 | 修复后断言 |
| --- | --- | --- |
| 单 item 的本地观察记录 | 10 条，最短 2 字符 | 1 条完整正文 |
| brief＋独立 final | 2 条旁白消息，首片＋最后三片；中间缺失 | 1 条完整旁白＋1 条独立 final |
| realtime＋独立 final | 10 条旁白碎片＋final | 1 条完整旁白＋1 条独立 final |
| silent＋独立 final | 本地碎片，聊天只有 final | 本地完整旁白，聊天只有 final |
| silent commentary-only | 只兜底最后碎片 | 兜底最后一条完整旁白 |
| completion 增加／替换正文 | 已输出片段后跳过完成全文 | 以完成正文为准；空完成正文不发布残片 |
| 六个快速完成的独立 item | brief 待发只留最后三条 | 首条立即发送，后五条有序合并，六条本地正文完整 |
| 相同正文、不同 item | 按文本误去重 | 各自保留；同一 item 的重放只处理一次 |

“1 条本地观察”不包含成功出站日志；发送成功仍有带回执的出站记录，发送失败仍有完整失败诊断。这些记录不是 delta 碎片。

## 覆盖范围

- `tests/unit/codex-commentary-messages.test.ts`：整块／逐字／标点分片得到相同完整消息；版本、路径、URL、Markdown、400／1200 字符边界；完成前零输出、完成后任务仍运行；completion 补充／替换／清空；交错 item、重复句子、同文不同 item、重放、迟到 delta、无 started／无 item ID；缺少 completed 时正常结束、失败、中断、断线不发布残片。
- `tests/unit/bridge-commentary-delivery.test.ts`：brief 保留全部待发正文；silent／brief／realtime 长正文和缩进；session／turn／item 身份去重；旧无 ID 事件；发送回执更新；结束时等待定时发送；失败回执；路由清理和等待中的旧 flush 不恢复待发。
- `tests/unit/app-server-codex-adapter.test.ts`：fake app-server 进程输入两块都带句号的 delta，要求最终只有一条旁白且包含 completion 独有结论。原用例第一块未触发旧提前刷新，已纠正。
- `tests/integration/commentary-protocol-bridge.test.ts`：前台与 controller 自动建立的后台 turn；微信 silent／brief 策略和飞书 silent／brief／realtime 策略；有／无 final、Plan、同文消息、六条合并、完成修正、异常结束、发送失败后完整兜底。三项测试经过真实 FeishuAdapter 和 fake SDK 检查完整发送正文。
- 全量回归继续覆盖 partial／async 问答、用户输入和审批、最终回复、reasoning／工具进度、引用恢复、渠道 API 和其他既有功能。

## 调试记录与边界

初次协议测试编译中的空数组断言造成 TypeScript 类型过度收窄，改用长度断言。初次集成辅助代码使用了 ES2022 库未声明的 `Promise.withResolvers`，改为兼容写法；项目编译目标保持不变。首次集成运行的四个断言遗漏了发送失败时本来就应产生的诊断日志，已补充完整诊断断言，未删除运行时诊断。最终所有回归通过。

本次移除的是旁白层的片段切分、正文去重及静默丢弃。brief 保持 3 秒合并间隔，微信不新增 realtime 能力。超长完整正文仍可能被平台拒绝；通用分段／文件降级和微信限流恢复不在本次实现范围。未知 phase 且缺少全部分类元数据的旧事件仍走兼容的最终文本逻辑，不能凭文本猜测为旁白。

本地原始测试输出保存在 `/private/tmp/commentary-fix-stage1-test.log`、`/private/tmp/commentary-fix-stage2-test.log`、`/private/tmp/commentary-fix-integration-test.log`、`/private/tmp/commentary-fix-full-test.log`；这些临时日志不随代码提交，长期依据为本报告和提交内的可执行回归测试。
