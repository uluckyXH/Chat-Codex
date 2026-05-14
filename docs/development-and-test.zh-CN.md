# 开发与测试规范

本文档是项目实现阶段的执行规范。所有功能开发都必须遵守。

## 1. 重点原则

- 文档、测试报告和开发记录以中文为主。
- 每次实现功能都必须有自测。
- 每次自测都必须留下测试报告。
- 测试报告统一存放在 `reports/tests/`。
- 每个阶段都要做好 Git 管理，提交前确认忽略规则、暂存内容和测试报告。
- 先实现 Codex 与中间件通信，再实现中间件与 Weixin Adapter 通信。
- 微信未登录前，先完成 mock/local 测试；第一版登录入口完成后，由用户登录微信并协助真实通道测试。

## 2. 代码规范

项目使用 Node.js + TypeScript，保持轻量。

要求：

- 不使用 NestJS、Next.js 等重型框架。
- 不把 Codex 逻辑、渠道逻辑、命令逻辑和状态存储混在一个文件里。
- Bridge Core 只能依赖通用渠道协议，不能直接依赖 `openclaw-weixin` 原始类型。
- WeixinAdapter 必须实现通用 Channel Adapter 协议。
- 具体渠道适配代码放在 `src/channels/<channel-id>/`。
- Codex 适配代码放在 `src/codex/`。
- 命令处理放在 `src/commands/` 或 `src/bridge/commands/`。
- 审批处理放在 `src/approvals/` 或 `src/bridge/approvals/`。
- 状态存储放在 `src/state/`。
- 日志处理放在 `src/logging/`。

## 3. 通用渠道协议要求

中间件核心必须面向通用渠道协议。

要求：

- 新渠道只实现 `ChannelAdapter`。
- 新渠道必须把原始消息转换为统一 `ChannelMessage`。
- 新渠道必须提供稳定 `routeKey`。
- 新渠道必须声明 `ChannelCapabilities`。
- 新渠道必须提供 `getStatus()`。
- 如果渠道需要登录，必须提供 `login()` 或明确返回 `login_required` 状态。

禁止：

- 在 Bridge Core 中写 `if channel === "weixin"` 这类业务分支。
- 在 Command Router 中直接使用微信原始字段。
- 在 Approval Manager 中直接调用微信发送 API。

## 4. 测试要求

每个功能至少需要对应一种测试：

- 单元测试：命令解析、状态转换、route key、审批映射、协议转换。
- 集成测试：Codex Adapter 与 mock channel、Bridge Core 与 State Store。
- 本地手工测试：CLI 启动、日志输出、状态查看。
- 真实通道测试：微信登录后收发消息、命令、审批、异常恢复。

微信未登录时：

- 必须先用 mock channel 完成等价流程测试。
- 测试报告中标明“真实微信测试待用户登录后补测”。

微信登录后：

- 用户协助扫码/确认登录。
- 开发者执行真实通道测试。
- 追加或新建真实通道测试报告。

## 5. 测试报告规范

测试报告目录：

```text
reports/tests/
```

文件命名建议：

```text
YYYY-MM-DD-功能名.md
```

报告模板：

````markdown
# 测试报告：功能名

## 测试目标

说明本次验证什么。

## 测试环境

- 日期：
- 分支/提交：
- Node.js 版本：
- 操作系统：
- Codex 版本：
- 渠道：mock / weixin

## 执行命令

```bash
列出执行过的命令
```

## 测试步骤

1. 步骤一
2. 步骤二
3. 步骤三

## 实际结果

记录输出、状态变化、日志位置、截图或关键文本。

## 结论

通过 / 未通过 / 部分通过。

## 遗留问题

列出待修复或待补测事项。
````

## 6. 必须留下报告的场景

- 新增 Codex Adapter 功能。
- 新增 Channel Adapter 功能。
- 新增或修改微信命令。
- 新增或修改审批流。
- 新增或修改状态持久化。
- 新增或修改日志脱敏。
- 修复线上或真实通道问题。
- 完成用户协助的微信登录测试。

## 6.1 Git 提交前检查

每次提交前执行：

```bash
git status --short --ignored
npm test
```

检查重点：

- 不能暂存 `node_modules/`、`dist/`、登录态、token、cookie、日志和运行态状态。
- 不能提交 `references/` 下除 `README.md` 外的本地参考源码。
- 不能提交 `openclaw-weixin-npm/`。
- 新功能必须有测试或明确说明为什么只能等用户登录微信后补测。
- 新功能必须更新或新增 `reports/tests/` 下的中文测试报告。

## 7. 第一阶段验收标准

第一阶段只关注 Codex 与中间件通信。

必须完成：

- TypeScript CLI 能启动。
- mock channel 能输入普通消息。
- 中间件能把消息送到 Codex Adapter。
- Codex Adapter 能返回阶段性事件或最终结果。
- `/new`、`/status` 至少能在 mock channel 中工作。
- 审批请求能进入 Approval Manager，并能通过 mock 命令批准或拒绝。
- 有中文测试报告。

## 8. 第二阶段验收标准

第二阶段关注中间件与 Weixin Adapter 通信。

必须完成：

- WeixinAdapter 实现通用 Channel Adapter 协议。
- 提供微信登录入口。
- 未登录时 `/status` 或 CLI 状态能显示 `login_required`。
- 用户登录后能接收微信文本消息。
- 能发送文本回复到微信。
- 有 mock/local 测试报告。
- 用户协助登录后，有真实微信通道测试报告。
