import test from "node:test";
import assert from "node:assert/strict";
import { replyTargetFromMessage } from "../../src/protocol/channel.js";
import { weixinMessageToChannelMessage } from "../../src/channels/weixin/weixin-adapter.js";
import { normalizeWeixinAccountId } from "../../src/channels/weixin/weixin-account-store.js";

test("weixinMessageToChannelMessage maps direct text messages to generic channel messages", () => {
  const message = weixinMessageToChannelMessage("weixin", "bot-1", {
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
  const message = weixinMessageToChannelMessage("weixin", "bot-1", {
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

test("weixinMessageToChannelMessage uses adapter instance channel id", () => {
  const message = weixinMessageToChannelMessage("weixin-main", "bot-1", {
    message_id: 125,
    from_user_id: "user@im.wechat",
    item_list: [{ type: 1, text_item: { text: "hello instance" } }],
  });

  assert.equal(message.channelId, "weixin-main");
  assert.equal(message.routeKey, "weixin-main:bot-1:direct:user@im.wechat");
});

test("weixinMessageToChannelMessage maps image and file items to attachments", () => {
  const message = weixinMessageToChannelMessage("weixin", "bot-1", {
    message_id: 126,
    from_user_id: "user@im.wechat",
    item_list: [
      {
        type: 2,
        msg_id: "img-msg",
        image_item: {
          media: {
            full_url: "https://cdn.example/image",
          },
          mid_size: 123,
        },
      },
      {
        type: 4,
        msg_id: "file-msg",
        file_item: {
          media: {
            full_url: "https://cdn.example/file",
          },
          file_name: "report.pdf",
          len: "456",
        },
      },
    ],
  });

  assert.equal(message.attachments?.length, 2);
  assert.equal(message.attachments?.[0]?.type, "image");
  assert.equal(message.attachments?.[0]?.id, "img-msg");
  assert.equal(message.attachments?.[0]?.sizeBytes, 123);
  assert.equal(message.attachments?.[1]?.type, "file");
  assert.equal(message.attachments?.[1]?.name, "report.pdf");
  assert.equal(message.attachments?.[1]?.sizeBytes, 456);
});

test("normalizeWeixinAccountId creates file-safe account ids", () => {
  assert.equal(normalizeWeixinAccountId("abc@im.bot"), "abc-im-bot");
  assert.equal(normalizeWeixinAccountId("abc@im.wechat"), "abc-im-wechat");
});

test("Weixin maps quoted video and untranslated voice as files while preserving voice transcripts", () => {
  const message = weixinMessageToChannelMessage("wx", "bot", {
    from_user_id: "user", item_list: [
      { type: 1, text_item: { text: "查看引用" }, ref_msg: { message_item: { type: 5, video_item: { media: { full_url: "https://cdn.example/video", encrypt_type: 0 } } } } },
      { type: 3, voice_item: { media: { full_url: "https://cdn.example/voice" } } },
    ],
  });
  assert.equal(message.attachments?.[0].type, "file");
  assert.equal(message.attachments?.[0].mimeType, "video/mp4");
  assert.equal(message.attachments?.[0].caption, "引用附件");
  assert.equal(message.attachments?.[1].mimeType, "audio/silk");
  const transcribed = weixinMessageToChannelMessage("wx", "bot", { item_list: [{ type: 3, voice_item: { text: "语音内容", media: { full_url: "https://cdn.example/voice" } } }] });
  assert.equal(transcribed.text, "语音内容");
  assert.equal(transcribed.attachments, undefined);
});
