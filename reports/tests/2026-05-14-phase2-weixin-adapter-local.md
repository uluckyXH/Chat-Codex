# 测试报告：第二阶段 Weixin Adapter 本地协议适配

## 测试目标

验证第二阶段 Weixin Adapter 的本地可测能力：

- 能按 `openclaw-weixin@2.4.3` 的协议发起二维码登录。
- 能轮询登录确认并把 `bot_token`、`ilink_bot_id` 保存到本地账号存储。
- 能处理 `need_verifycode` 登录分支，把用户输入的配对数字提交给 `get_qrcode_status`。
- 能把微信入站文本消息转换为通用 `ChannelMessage`。
- 能把 Bridge 回复目标中的 `contextToken` 带入 `sendmessage`。
- 不依赖 OpenClaw CLI、gateway、host runtime 或 plugin runtime。

## 测试环境

- 日期：2026-05-14
- Node.js 版本：v24.13.1
- npm 版本：11.8.0
- Codex CLI 版本：0.130.0
- 操作系统：macOS
- 渠道：weixin adapter fake-fetch
- 微信真实通道：未测试，等待用户后续扫码登录后补测。

## 执行命令

```bash
npm test
npm run cli:weixin:status
```

## 测试步骤

1. 使用 fake fetch 模拟 `get_bot_qrcode` 返回二维码链接。
2. 使用 fake fetch 模拟 `get_qrcode_status` 返回 `confirmed`、`bot_token` 和 `ilink_bot_id`。
3. 模拟 `need_verifycode`，确认适配器会提交配对数字后继续登录。
4. 检查账号 token 是否保存到临时状态目录。
5. 使用 fake fetch 捕获 `sendmessage` 请求，检查 Authorization、`to_user_id`、`context_token` 和文本内容。
6. 构造微信 direct/group 原始消息，检查 route key、conversation、sender 和文本提取。
7. 执行 `npm run cli:weixin:status`，确认未登录状态仍清晰显示 `login_required`。

## 实际结果

`npm test` 结果：

```text
tests 19
pass 19
fail 0
duration_ms 119.104166
```

新增覆盖用例：

- `WeixinAdapter starts QR login, waits for confirmation, and stores account credentials`
- `WeixinAdapter sends text messages with stored token and context token`
- `WeixinAdapter submits verify code when QR login requires pairing code`
- `weixinMessageToChannelMessage maps direct text messages to generic channel messages`
- `weixinMessageToChannelMessage separates group route from sender`
- `normalizeWeixinAccountId creates file-safe account ids`

`npm run cli:weixin:status` 关键输出：

```text
{
  "channelId": "weixin",
  "state": "login_required",
  "details": {
    "source": "@tencent-weixin/openclaw-weixin",
    "sourceVersion": "2.4.3",
    "phase": "adapter-ready",
    "runtime": "codex-wechat-middleware"
  }
}
```

## 结论

通过。

Weixin Adapter 的本地协议适配已具备第一版基础：二维码登录入口、登录确认保存账号、文本发送请求和入站消息映射均可测试。真实微信登录和真实收发消息还没有执行，因为需要用户扫码/确认登录。

## 遗留问题

- 需要用户运行 `weixin login` 并扫码后补测真实登录链路。
- `getupdates` 长轮询已经有实现入口，但真实收消息闭环需要登录后补测。
- 真实微信通道下的群聊、上下文 token、异常重连、登录态过期还需要继续验证。
- 媒体消息只保留协议扩展口，当前第一版只测试文本。
