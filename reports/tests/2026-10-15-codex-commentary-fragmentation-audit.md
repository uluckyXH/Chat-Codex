# 排查验证记录：Codex 旁白碎片化

日期：2026-10-15。环境：macOS，Node v24.14.0；中间件 `7207cbc`，Codex 本地参考 `bb64b894fd67158be0f874872e6d7bfe717e7368`。现场在另一台电脑，本次仅源码审查和合成协议模拟，未接触现场进程或真实渠道。

本报告是用户最初要求的只读排查记录，当时源码、现有测试、依赖和运行配置保持不变。主要结论见[问题文档](../../docs/2026-10-15-codex-commentary-fragmentation-analysis.zh-CN.md)。后续已授权并实施修复；这里的缺陷断言只适用于 `7207cbc`，修复后应运行新增回归，见[修复进度](../../docs/2026-10-15-codex-commentary-fragmentation-fix.zh-CN.md)。

## 执行记录

```sh
npm run build
node --test dist/tests/unit/app-server-codex-adapter.test.js dist/tests/unit/codex-protocol-messages.test.js dist/tests/unit/bridge-commentary-delivery.test.js dist/tests/unit/transcript.test.js dist/tests/integration/bridge-mock.test.js dist/tests/integration/feishu-bridge.test.js
node /private/tmp/chat-codex-commentary-audit-20261015.mjs
```

构建通过；既有测试 179/179，0 失败／跳过，约 15.14 秒。诊断脚本使用编译后的真实 controller、Bridge、TUI transcript sink 与 MockChannelAdapter；所有断言通过，**这里的断言是确认当前缺陷存在，并不表示缺陷已经修复**。没有重新跑与文档变更无关的全部 655 项测试。

本机临时证据（不提交、不依赖它们作为长期文档）：

- `/private/tmp/commentary-fragmentation-audit-build.log`
- `/private/tmp/commentary-fragmentation-existing-tests.log`
- `/private/tmp/chat-codex-commentary-audit-20261015.mjs`
- `/private/tmp/chat-codex-commentary-audit-20261015.json`
- `/private/tmp/chat-codex-commentary-audit-20261015.log`

## 协议映射探针结果

以下每一行只生成一个 commentary item（final 对照除外），item ID 不随 delta 改变：

| 场景 | delta 数 | 旁白事件数 | 结果 |
| --- | --- | --- | --- |
| 同一段 88 字符一次到达 | 1 | 1 | 完整 |
| 同一段按 17 块到达 | 17 | 10 | 长度为 7、5、4、16、4、2、24、10、5、7 |
| 相同分片，仅完成时标明 commentary | 17 | 1 | 完整；构造兼容性场景，不代表现场一定存在迟到 phase |
| 只有 completed | 0 | 1 | 完整 |
| 六句话分别到达 | 6 | 6 | 一条消息变六条 |
| 同一段逐字符到达 | 88 | 10 | 与小块场景一样碎 |
| 先“预告。”，completion 新增正文 | 1 | 1 | 只输出“预告。”，完整正文未修正 |
| “确认。确认。继续。”分句到达 | 3 | 2 | 第二次“确认。”丢失 |
| 400 个甲、400 个乙、结尾 | 3 | 3 | 长度 400、400、2 |
| 相同 17 块作为 final_answer | 17 | 0 | 不走 commentary，完整 final 正常保留 |

## 完整 Bridge 探针结果

9 组场景覆盖：小块旁白的 silent／brief／realtime，单块 brief 对照，六句 brief＋正常 final，六句 silent 无 final，六句 brief 无 final，六句 Plan＋silent 无 final，以及相同小块的正常 final 对照。

关键结果：

- 小块 silent＋正常 final：本地 10 条旁白，渠道只有完整 final。
- 小块 brief＋正常 final：本地 10 条观察＋2 条旁白发送；发送首片段和最后 3 个片段，中间文本丢失。
- 小块 realtime＋正常 final：本地 10 条观察＋10 条发送；渠道逐片发送，最后的正常 final 仍完整。
- 六句 brief：发送“第一句。”与“第四句。\n\n第五句。\n\n第六句。”；第二、三句遗漏。
- 六句普通 silent、无 final：最终兜底只有“第六句。”。
- 六句 Plan＋silent：按旁白可见的既有例外投递，行为与 brief 一样，不能把所有 silent 都理解成旁白完全不发送。
- 正常 final 对照：相同 17 个分片最终只发完整 88 字符正文。

## 可独立重跑的最小复现

在仓库根目录构建后运行，不需要登录渠道或启动真实 Codex：

```sh
node --input-type=module <<'JS'
import { AppServerTurnController } from './dist/src/codex/app-server/turn-controller.js';
import { AsyncEventQueue } from './dist/src/codex/app-server/turn-store.js';
const queue = new AsyncEventQueue();
const controller = new AppServerTurnController({ sessions: new Map(), threadToSession: new Map() });
controller.registerTurn('thread', 'turn', queue);
const notify = (method, params) => controller.handleNotification({
  method, params: { threadId: 'thread', turnId: 'turn', ...params },
});
const item = { type: 'agentMessage', id: 'one-item', phase: 'commentary', text: '' };
const chunks = ['第一句。', '第二句。', '第三句。', '第四句。', '第五句。', '第六句。'];
notify('item/started', { item });
for (const delta of chunks) notify('item/agentMessage/delta', { itemId: item.id, delta });
notify('item/completed', { item: { ...item, text: chunks.join('') } });
notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
for await (const event of queue) if (event.type === 'assistant.commentary') console.log(event.itemId, event.text);
JS
```

当前结果是同一 `one-item` 打印六次，每次一句；把 `chunks` 改成一块拼接后的正文则只打印一次。这证明拆分发生在同一消息内部，不是 Codex 创建了六条独立旁白。

## 未验证项

未核实故障电脑版本、实际 delta 时序、模式设置和聊天端回执；未执行真实微信／飞书投递、限流或 Codex 模型调用。后台同源逻辑已审查，未独立模拟后台任务。模拟采用快速到达、成功发送，真实时间跨度和失败冷却会改变发送条数。

本轮只记录发现；后续修复需要以消息完整性、按 item 去重和日志收束重新定义验收，不能只用当前通过的用例判断修复成功。
