import test from "node:test";
import assert from "node:assert/strict";
import { replyTargetFromMessage } from "../../src/protocol/channel.js";
import { weixinMessageToChannelMessage } from "../../src/channels/weixin/weixin-adapter.js";
import { normalizeWeixinAccountId } from "../../src/channels/weixin/weixin-account-store.js";

test("weixinMessageToChannelMessage maps direct text messages to generic channel messages", () => {
  const message = weixinMessageToChannelMessage("bot-1", {
    message_id: 123,
    from_user_id: "user@im.wechat",
    create_time_ms: 1_700_000_000_000,
    context_token: "ctx-token",
    item_list: [{ type: 1, text_item: { text: "hello" } }],
  });
  const target = replyTargetFromMessage(message);

  assert.equal(message.routeKey, "weixin:bot-1:direct:user@im.wechat");
  assert.equal(message.text, "hello");
  assert.equal(message.sender.id, "user@im.wechat");
  assert.equal(target.context?.contextToken, "ctx-token");
});

test("weixinMessageToChannelMessage separates group route from sender", () => {
  const message = weixinMessageToChannelMessage("bot-1", {
    message_id: 124,
    from_user_id: "user@im.wechat",
    group_id: "group-1",
    item_list: [{ type: 1, text_item: { text: "group hello" } }],
  });

  assert.equal(message.routeKey, "weixin:bot-1:group:group-1");
  assert.equal(message.conversation.kind, "group");
  assert.equal(message.conversation.id, "group-1");
  assert.equal(message.sender.id, "user@im.wechat");
});

test("normalizeWeixinAccountId creates file-safe account ids", () => {
  assert.equal(normalizeWeixinAccountId("abc@im.bot"), "abc-im-bot");
  assert.equal(normalizeWeixinAccountId("abc@im.wechat"), "abc-im-wechat");
});
