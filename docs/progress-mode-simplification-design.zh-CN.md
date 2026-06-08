# 进度模式精简设计

## 背景

当前 `/progress` 暴露了 `brief`、`detailed`、`realtime`、`tools`、`silent` 多个模式，但这些模式混合了不同维度：

- `brief` / `detailed` 是普通文本进度的内容筛选。
- `realtime` 是投递节奏，表示逐条发送普通文本进度。
- `tools` 是微信 2.4.4 结构化 `TOOL_CALL_START/RESULT` 实验链路。

真实微信实测后，`detailed` 在聊天渠道里仍会因为节流、合并、去重、截断和失败 cooldown 只看到少量消息；`realtime` 又会触发微信 `sendmessage failed: ret=-2 errcode=0` 或消息堆积；`tools` 如果微信客户端没有特殊 UI 展示，对用户也没有明确价值。

因此 `/progress` 用户可见模式需要收敛，只保留有稳定语义和实际价值的选项。

## 目标

1. 微信用户可见 `/progress` 只保留：
   - `silent`
   - `brief`
2. 飞书用户可见 `/progress` 只保留：
   - `realtime`
   - `silent`
   - `brief`
3. `detailed` 和 `tools` 不再作为普通 `/progress` 可选项展示或接受。
4. 不删除 `detailed`、`tools`、结构化工具进度和 realtime 发送代码，保留内部能力、历史兼容和后续实验入口。
5. 本地 TUI / transcript 的 observed progress 继续实时显示 Codex 产生的有效进度，不受聊天渠道模式精简影响。
6. 历史 route 或 CLI 默认值如果残留不可见模式，运行时按渠道公开模式自动回退，不继续使用不可见模式。

## 非目标

- 不改变 Codex app-server progress 事件映射。
- 不删除微信 `sendToolProgress()` 实现。
- 不删除 `BridgeDelivery.sendRealtimeProgressText()`。
- 不把微信 realtime 重新打开。
- 不把普通文本进度改成 raw stdout/stderr 全量输出。

## 新模式矩阵

| 渠道 | 用户可见模式 | 默认模式 | 说明 |
| --- | --- | --- | --- |
| 微信 | `silent`, `brief` | `silent` | 微信不适合持续进度投递；默认静默，用户需要时只开启摘要进度。 |
| 飞书 | `realtime`, `silent`, `brief` | `brief` | 飞书保留显式 realtime，用于需要逐条普通文本进度的场景。 |
| 默认 / Mock / Terminal | `silent`, `brief` | `brief` | 默认不暴露 detailed/tools/realtime，避免普通渠道继承实验模式。 |

`brief` 的语义：

- 聊天渠道发送 Codex 旁白、计划、搜索、文件变更和其它高价值摘要进度。
- 不发送命令/工具细节。
- 渠道仍使用节流、合并、去重、截断和失败 cooldown。

`silent` 的语义：

- 聊天渠道不发送普通文本进度和结构化工具生命周期。
- 仍发送审批、错误、安全通知、输入请求、命令回复和最终回复。
- 本地 TUI / transcript 仍可显示 observed progress。
- `commentary-only` 且没有 final/plan 的 turn 会按最终回复兜底投递，避免旁白成为本轮唯一输出时被进度策略吞掉。

`realtime` 的语义：

- 仅飞书等明确允许的渠道公开。
- 普通文本进度逐条发送，不走 Bridge 层节流、pending、合并、去重、截断和普通文本进度失败 cooldown。
- 发送失败只记录诊断，不阻断下一条 realtime 进度。

## 策略表达

在 `ChannelDeliveryPolicy` 中新增公开模式字段：

```ts
allowedProgressModes?: readonly ChannelDefaultProgressMode[];
```

该字段只控制 `/progress` 用户可见和可设置的模式，不删除内部模式实现。运行时 effective mode 计算规则：

1. route 显式模式存在且在 `allowedProgressModes` 中，使用它。
2. 渠道 `defaultProgressMode` 存在且在 `allowedProgressModes` 中，使用它。
3. Bridge 启动默认模式存在且在 `allowedProgressModes` 中，使用它。
4. 否则使用该渠道第一个公开模式；如果策略异常为空，则回退 `silent`。

这样可以兼容历史状态：旧 route 中存过 `detailed`、`tools` 或微信 `realtime` 时，新版本不会继续投递这些模式，而是按渠道默认公开模式回退。

## 保留的内部能力

以下能力保留但不再通过普通 `/progress` 暴露：

- `detailed`：仍作为内部 mode 值存在，供未来调试入口或测试显式打开。
- `tools`：仍保留微信结构化工具生命周期发送实现。
- `sendRealtimeProgressText()`：仍保留给飞书 realtime 和底层单元测试。
- Plan turn 的旁白可见行为：`/plan` 不写入 route 持久 `/progress` 模式，但默认低频展示 `assistant.commentary` 旁白和最终计划；不因此开启命令进度、工具生命周期或 realtime。

## 测试要求

实现后按开发规范补中文测试报告，并至少覆盖：

- 微信 `/help` 只展示 `/progress [silent|brief]`。
- 微信 `/progress detailed`、`/progress tools`、`/progress realtime` 返回可用值错误。
- 微信 `/progress brief` 仍发送摘要普通文本进度，不发送结构化工具生命周期。
- 飞书 `/help` 展示 `/progress [realtime|silent|brief]`。
- 飞书 `/progress realtime` 仍逐条发送普通文本进度。
- 默认 Mock 渠道不再接受 `/progress detailed`。
- 历史或默认不可见 mode 会按 policy 回退。
