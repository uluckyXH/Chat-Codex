# Codex request_user_input 聊天交互设计

## 背景

新版 Codex app-server 可能通过 `ServerRequest` 向客户端发送 `item/tool/requestUserInput`。它表示当前 Codex turn 暂停执行，需要客户端向用户展示一个短问题表单，并把用户答案回传给 Codex 后继续。

这个能力不同于普通聊天 prompt：

- 它属于当前 turn 的中途交互，不应该创建新 turn。
- 它需要阻塞当前 route/session 的后续输入，直到用户回答、取消或超时。
- 它的答案是结构化 JSON，不是把用户原文直接继续发给 Codex。

本文只讨论 Codex 核心 `item/tool/requestUserInput` 的聊天侧交互设计。MCP 暂不适配；如果 MCP/app tool approval 通过 `request_user_input` 兼容路径出现，只做识别和取消，不开放 MCP 授权。后续是否支持 MCP 需要单独立项讨论，不能混在本能力里顺手实现。

## 协议形态

请求参数：

```ts
{
  threadId: string;
  turnId: string;
  itemId: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    isOther: boolean;
    isSecret: boolean;
    options: Array<{ label: string; description: string }> | null;
  }>;
}
```

响应参数：

```ts
{
  answers: {
    [questionId: string]: {
      answers: string[];
    };
  };
}
```

Codex 工具描述要求：

- 问题数量偏向 1 个，最多 3 个。
- 每个问题提供 2-3 个互斥选项。
- 推荐选项放第一项。
- 客户端可在 `isOther` 为 true 时提供“其他”自由补充。

实现上不能把选项数量硬编码为 3。第一版应支持 `/a1` 到 `/a9`，按实际展示选项编号解析；超出范围提示用户重新选择。

## 和 MCP 的关系

`item/tool/requestUserInput` 是一个通用的 app-server 请求通道，可能来自：

1. Codex 原生 `request_user_input` 工具。
2. 旧 MCP/app tool approval 的兼容路径。

适配 `item/tool/requestUserInput` 不等于启用所有 MCP 能力。

- 原生短问题：按本文设计进入聊天回答流程。
- MCP/app tool approval 兼容路径：识别后自动取消，并提示当前 Chat-Codex 不支持 MCP/app tool 调用。
- 真正的 `mcpServer/elicitation/request`：仍走 MCP unsupported/cancel，不进入本文流程。

当前阶段的产品边界是聚焦 Codex 核心适配，不做 MCP 审批流、MCP elicitation 表单、MCP OAuth 或 MCP 工具授权。MCP 相关请求只保证不误授权、不阻塞 Codex turn、不让用户以为 MCP 已经可用。

MCP/app tool approval 识别规则第一版：

- `question.id` 以 `mcp_tool_call_approval_` 开头。
- 或 `header` 等于/近似 `Approve app tool call?`。
- 或选项包含 `Allow`、`Allow for this session`、`Allow and don't ask me again`、`Cancel` 的典型组合。

命中后不展示 `/a1` 让用户选择 `Allow`，避免把普通问答误变成外部工具授权入口。后续如果要支持 MCP，必须另做独立设计，至少要展示 server、tool、参数摘要、授权范围、记忆范围和群聊权限规则。

## 命令格式

统一使用短命令 `/a数字`，不使用裸数字，不使用长命令 `/answer`。

示例：

```text
/a1
/a2 先别改配置文件
/a3 我不接受这个建议，可以换个方案再试试吗
/a0
/stop
```

语义：

| 输入 | 语义 |
| --- | --- |
| `/a1` | 选择第 1 项 |
| `/a1 <说明>` | 选择第 1 项，并附加用户说明 |
| `/aN <说明>` | 选择第 N 项；如果第 N 项是“其他”，说明就是用户自己的建议 |
| `/a0` | 跳过当前问题，返回空答案；Codex 会在未收到答案的情况下自主决定下一步，不等于停止任务 |
| `/stop` | 终止整个 Codex turn，并清理 pending input |

不支持多选。以下输入都应提示重新选择：

```text
/a1,2
/a1 2
/a12   # 如果没有第 12 项
```

`answers` 数组的使用方式：

- 选择普通选项：`["Yes (Recommended)"]`
- 选择普通选项并补充：`["Yes (Recommended)", "user_note: 先别改配置文件"]`
- 选择其他并补充：`["None of the above", "user_note: 我不接受这个建议，可以换个方案再试试吗"]`
- `/a0` 跳过：`[]`

`/a0` 必须在用户提示里解释清楚：它只是“未回答本问题”，不是“取消任务”。Chat-Codex 会把空答案回传给 app-server，后续由 Codex 自主判断是保守跳过、重新询问、继续默认路径，还是停止某个分支。用户想明确终止当前 Codex turn 时应使用 `/stop`。

## 展示格式

每次只展示一个问题。多问题按顺序收集，最多 3 个问题，全部收齐后一次性回传给 app-server。

用户提示里不能出现 `request_user_input`、`ServerRequest` 等内部协议名。应描述为“Codex 暂停了当前任务，需要用户确认后继续”。

展示时只保留一套编号：`/a1`、`/a2`、`/a3` 就是选项本身。不要先展示 `1. 2. 3.`，再单独展示 `/a1 /a2 /a3`，否则用户会误以为回复裸数字也可以。

如果 Codex 请求带 `isOther=true`：

- 当已有选项明显是“其他/其他建议/自定义/补充建议/None of the above”时，不再追加额外“其他”选项。
- 只有没有这类选项时，才追加一个 synthetic other，展示为 `/aN 其他：你的建议`，回传 `["None of the above", "user_note: ..."]`。

示例：

```text
Codex 暂停了当前任务，需要你确认后继续。

问题 1/2：确认方案
是否继续执行这个方案？

直接回复下面一条命令：

/a1 Yes (Recommended)
继续当前方案。

/a2 No
停止并重新考虑。

/a3 其他：你的建议
可以写自己的建议。

需要补充原因时，在命令后追加文字，例如 /a2 你的说明。

/a0 跳过这个问题
不会默认选择推荐项，Codex 会自己决定下一步。

30 分钟内未回复会按 /a0 处理。
要停止整个任务，请回复 /stop。
```

私聊和群聊都使用同一命令格式，避免私聊裸数字、群聊命令两套规则造成歧义。

## 渠道投递规则

`request_user_input` 是当前 turn 的中途交互，不是普通进度消息。展示问题、超时提示、`/a0` 风险提示和回答确认必须走聊天普通文本投递路径，不能走 `assistant.progress` 或 progress delivery。

这意味着：

- 微信渠道即使禁用了大部分进度消息，也必须收到 `request_user_input` 问题提示和超时/跳过说明。
- 飞书私聊和飞书群聊同样使用这套投递路径。
- `/progress silent`、微信 progress suppression 或命令进度降噪策略不能抑制 pending input 提示。
- pending input 期间，普通聊天消息仍被 route 锁拦截，不应因为提示不属于 progress 就绕过并创建新 turn。

## 群聊规则

群聊按协作场景处理，不再限定只有本轮任务发起人可答：

- 群内已通过现有群聊入口校验的成员都可以回答 `/a数字`。
- 飞书群聊仍必须 @机器人 才会触发机器人；没有 @bot 的消息在渠道 adapter 层会被跳过。
- 被群权限 block 的成员仍按现有群权限策略处理，不能通过 `/a数字` 绕过。
- 同一个问题只接受第一条有效答案；先回复者生效。
- 其他成员同时或稍后回复 `/a数字` 时，提示“这个 Codex 输入请求已处理，当前回复已失效”或“正在提交，请稍候”。
- `/stop` 仍走原有停止逻辑，不被 pending input 消费。
- 普通聊天内容不作为答案，不进入 Codex。

群聊提示中必须明确：

```text
飞书群聊请 @机器人 回复；群内成员先回复者生效。
```

`request_user_input` 不复用 Codex 审批的群审批策略。审批是权限风险动作，继续由 `/OK`、`/P`、`/NO` 和群 `approvalPolicy` 控制；`request_user_input` 是 Codex 中途业务选择或补充信息，群聊中按“先答生效”的协作模型处理。

## 并发和锁

`request_user_input` 必须加 pending input 锁。

### 锁粒度

第一版使用 route 级锁，同时记录 session/turn：

```ts
PendingInput {
  routeKey: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  requestId: string;
  itemId: string;
  initiatorSenderId: string;
  questions: Question[];
  currentQuestionIndex: number;
  answers: Record<string, { answers: string[] }>;
  expiresAt: string;
}
```

原因：

- 聊天交互发生在 route 上，用户看到的是某个私聊/群聊。
- 一个 route 同一时间只应该有一个等待输入的问题。
- route queue 本身已经按 route 串行处理普通 prompt；pending input 应该优先拦截该 route 的后续消息。

### 同 route 重入

如果同一 route 已有 pending input：

- 来自同一 turn 的后续 request：第一版先排队，当前问题完成后再展示。
- 来自不同 turn/session 的 request：拒绝或取消后来的 request，并写日志；正常情况下同 route 不应并发跑两个 turn。

### 不同 route 并发

不同 route 可以各自有 pending input，不互相影响。

同一个 session 被多 route 绑定理论上会被 session owner 约束避免；如果异常发生，应按 session owner 只允许 owner route 回答。

### 重复回答

用户可能连续发送：

```text
/a1
/a2
```

处理规则：

1. 第一条合法答案一旦被接受，就立即把当前问题标记为 answered。
2. 如果还有下一题，第二条 `/a2` 只在下一题已经展示后才可接受。
3. 如果当前 request 已完成并已回传 app-server，后续 `/a2` 提示“当前没有等待回答的 Codex 问题”。
4. 同一问题不允许被第二条消息覆盖，避免并发消息乱序。

实现上需要在状态更新和回传 app-server 之间做原子保护：取出 pending、验证、写入答案、推进问题或完成请求，不能在两个异步消息处理之间重复提交。

群聊里的重复回答需要额外处理：

- 第一条有效答案进入提交阶段后，pending input 立即标记为 `resolving`。
- `resolving` 期间收到的 `/a数字` 提示“当前 Codex 输入请求正在提交，请稍候”。
- 请求提交完成并清理 pending 后，短时间内同 route 的 `/a数字` 提示“这个 Codex 输入请求已处理，当前回复已失效”，避免后回复者误以为命令被当成普通未知命令。
- 失效提示只对 `/a数字` 生效，不影响后续普通 prompt 或新一轮 request_user_input。

## 超时

默认超时 30 分钟，可配置。

提示消息必须说明：

```text
请在 30 分钟内回复。超时后 Chat-Codex 会按“未回答”处理，不会默认选择推荐项。
```

超时行为：

- 当前未回答问题返回空答案。
- 已收集的问题保留答案。
- 未展示/未回答的问题返回空答案。
- 将完整 response 回传 app-server，让 Codex 收到“用户没有回答”的结果。
- 清理 pending input。
- 向聊天渠道提示 Codex 等待选择已超时，不会默认选择推荐项。

不在超时时自动 `/stop`。只有用户显式 `/stop` 才终止整个 Codex turn。

## Secret 输入

`isSecret: true` 第一版不支持。

原因：

- 微信/飞书消息会进入聊天记录和平台日志。
- Chat-Codex 本地运行日志也可能记录消息。
- 无法像 Codex TUI 一样安全 mask 输入。

处理策略：

```text
Codex 请求保密输入，但聊天渠道不适合传递 secret。
Chat-Codex 已取消这次输入请求。请在本机 Codex 中完成需要 secret 的操作。
```

随后返回空答案并清理 pending input，不让用户在聊天里发送 token/password。

## 实施计划

1. 增加 `CodexEvent`：`input.requested`、`input.resolved` 或等价事件。
2. `AppServerCodexAdapter.handleServerRequest()` 对 `item/tool/requestUserInput` 建立 pending server request，不立即 fail-closed。
3. Bridge 增加 pending input manager，负责 route 锁、超时、答案收集和格式化展示。
4. Command router 在普通命令前优先识别 `/a数字`，并交给 pending input manager。
5. 群聊权限校验接入现有 route sender/admin 规则。
6. MCP/app tool approval 兼容路径识别并自动取消；不实现 MCP 审批或授权。
7. `isSecret: true` 自动取消并提示。
8. request 完成、超时、`serverRequest/resolved` 或 `/stop` 时清理 pending input。

## 测试计划

单元测试：

- `/a1` 选择普通选项。
- `/a1 补充说明` 生成 `user_note`。
- `/a3 自定义建议` 选择其他并附加说明。
- `/a0` 返回空答案。
- `/a1,2` 和 `/a1 2` 不支持多选。
- 群聊非发起人不能回答。
- 连续 `/a1`、`/a2` 不会覆盖同一问题答案。
- 多问题顺序收集，最后一次性回传。
- 30 分钟超时返回空答案并提示不会默认选择推荐项。
- `isSecret: true` 自动取消。
- MCP/app tool approval 兼容路径自动取消，不展示 Allow，不产生 MCP 授权。

集成测试：

- mock app-server 发送 `item/tool/requestUserInput`，Bridge 投递提示并回传 JSON-RPC response。
- request 期间普通 prompt 不进入 Codex 新 turn。
- `/stop` 清理 pending input 并中断当前 turn。
- `serverRequest/resolved` 到达时清理 pending input，后续 `/a1` 不再生效。
