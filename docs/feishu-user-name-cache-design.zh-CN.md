# 飞书名称展示与群聊名册设计

## 背景

飞书消息事件里稳定携带的是用户 ID，例如 `sender.sender_id.open_id`。用户名称字段不稳定，且受飞书数据权限和通讯录可见范围影响。

当前策略不再主动调用飞书 `contact.user.get` / `contact.user.batch` 去补齐私聊用户名称，也不再把私聊消息事件里的 `sender_name/name/user_name` 映射到私聊 `sender.displayName`。原因是这条链路依赖企业数据权限和事件字段稳定性，容易出现接口成功但不返回 `name` 字段、不同企业表现不一致的问题。

## 目标

1. 私聊不解析用户名称，统一按 `open_id` / `chat_id` 兜底展示。
2. 群聊必须能区分发言人，优先使用群内手工成员名册。
3. 显示名只用于日志、TUI 和 Codex 群聊前缀，不作为权限主键。
4. 权限、小黑屋、审批和审计继续按 `open_id` 判断。

## 非目标

- 不通过飞书通讯录接口主动补齐私聊名称。
- 不使用私聊事件自带的名称字段作为展示名。
- 不因为私聊缺少名称阻断消息。
- 不用显示名做权限判断。
- 不做后台全量刷新通讯录。

## 私聊策略

私聊 route 天然代表一个人，因此不要求名称，也不维护名称展示逻辑。

私聊入站消息：

- 不主动调用官方用户信息接口。
- 不读取事件里的 `sender_name/name/user_name` 作为私聊展示名。
- `sender.displayName` 保持为空。
- 日志和 TUI 使用 `open_id` / `chat_id` 兜底。
- 不要求用户发送 `/name`。

## 群聊策略

群聊 route 由多人共享同一个 Codex session。为了避免上下文里出现一堆 `open_id`，群聊使用手工成员名册。

名册路径：

```text
~/.chat-codex/state/channels/feishu/<channelId>/accounts/<accountId>/groups/<chat_id>/members.json
```

建议结构：

```json
{
  "schemaVersion": 1,
  "channelId": "feishu-main",
  "accountId": "default",
  "chatId": "oc_xxx",
  "updatedAt": "2026-05-20T00:00:00.000Z",
  "members": [
    {
      "openId": "ou_xxx",
      "displayName": "小黄",
      "source": "manual",
      "firstSeenAt": "2026-05-20T00:00:00.000Z",
      "lastSeenAt": "2026-05-20T00:00:00.000Z",
      "updatedAt": "2026-05-20T00:00:00.000Z"
    }
  ]
}
```

群聊命令：

```text
@Bot /name 小黄
@Bot /name
```

规则：

- `/name <名称>` 只设置当前发送者在当前 `chat_id` 下的展示名。
- `/name` 展示当前发送者在当前群的名称状态。
- 同一个 `open_id` 在不同群可以有不同展示名。
- 手工名称不自动写入私聊，也不自动扩散到其它群。
- 手工名称不授予任何权限。

## 群聊投递

群聊普通消息进入 Codex 前必须带发言人前缀：

```text
小黄说：这里是内容
小黄补充：这里是内容
```

名称来源优先级：

1. 飞书事件自带 sender 名称。
2. 当前群 `groups/<chat_id>/members.json` 中的手工名称。
3. `open_id` 兜底。

如果普通 @Bot 消息没有可用名称，第一版建议提示用户先设置名称，不投递给 Codex：

```text
我现在无法识别你的群内名称。请先发送：
@Bot /name 小黄
设置后再继续对话。
```

`/help` 和 `/name` 不要求已有名称。

## 测试计划

- 私聊缺名称时不调用飞书用户信息接口，消息正常进入 Bridge。
- 私聊事件自带名称时也不写入 `sender.displayName`，不调用飞书用户信息接口。
- 群聊 `/name <名称>` 写入当前 `chat_id` 的 `members.json`。
- 同一 `open_id` 在不同 `chat_id` 下可以保存不同名称。
- 群聊缺名称的普通 @Bot 消息被提示先设置名称，不进入 Codex。
- 小黑屋、超级管理员和审批权限不受显示名变化影响。
