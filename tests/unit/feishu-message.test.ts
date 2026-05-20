import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFeishuPostContent,
  feishuEventToChannelMessage,
  loadFeishuCredentialsFromEnv,
  maskFeishuSecret,
  missingFeishuCredentials,
  parseFeishuMessageContent,
  parseFeishuTextContent,
} from "../../src/channels/feishu/feishu-message.js";
import { sampleFeishuTextEvent } from "../helpers/feishu-fakes.js";

test("parseFeishuTextContent reads Feishu text JSON", () => {
  assert.equal(parseFeishuTextContent(JSON.stringify({ text: "/help" })), "/help");
  assert.equal(parseFeishuTextContent("普通文本"), "普通文本");
  assert.equal(parseFeishuTextContent(JSON.stringify({ notText: true })), undefined);
});

test("feishuEventToChannelMessage maps p2p text to ChannelMessage", () => {
  const now = Date.now();
  const result = feishuEventToChannelMessage(sampleFeishuTextEvent({
    message: {
      message_id: "om_message",
      create_time: String(now),
      chat_id: "oc_chat",
      content: JSON.stringify({ text: "ping" }),
    },
  }), {
    channelId: "feishu",
    accountId: "work",
    expectedAppId: "cli_1234567890abcdef",
    now,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.message.id, "om_message");
  assert.equal(result.message.text, "ping");
  assert.equal(result.message.channelId, "feishu");
  assert.equal(result.message.accountId, "work");
  assert.equal(result.message.routeKey, "feishu:work:direct:oc_chat");
  assert.deepEqual(result.message.sender, { id: "ou_user" });
  assert.deepEqual(result.message.conversation, {
    id: "oc_chat",
    kind: "direct",
    displayName: "飞书私聊",
  });
});

test("feishuEventToChannelMessage ignores direct sender names and preserves group sender names", () => {
  const now = Date.now();
  const direct = feishuEventToChannelMessage(sampleFeishuTextEvent({
    sender: { sender_name: "小黄" },
    message: {
      message_id: "om_named_direct",
      create_time: String(now),
      chat_id: "oc_named_direct",
      content: JSON.stringify({ text: "ping" }),
    },
  }), {
    channelId: "feishu",
    accountId: "work",
    now,
  });
  const group = feishuEventToChannelMessage(sampleFeishuTextEvent({
    sender: { sender_name: "张三" },
    message: {
      message_id: "om_named_group",
      create_time: String(now),
      chat_id: "oc_named_group",
      chat_type: "group",
      content: JSON.stringify({ text: "@_bot 群消息" }),
      mentions: [{
        key: "@_bot",
        id: { open_id: "ou_bot" },
        name: "Codex Bot",
      }],
    },
  }), {
    channelId: "feishu",
    accountId: "work",
    botOpenId: "ou_bot",
    now,
  });

  assert.equal(direct.ok, true);
  assert.equal(group.ok, true);
  if (!direct.ok || !group.ok) return;
  assert.deepEqual(direct.message.sender, { id: "ou_user" });
  assert.deepEqual(group.message.sender, { id: "ou_user", displayName: "张三" });
});

test("feishuEventToChannelMessage maps group text and normalizes mentions", () => {
  const now = Date.now();
  const result = feishuEventToChannelMessage(sampleFeishuTextEvent({
    message: {
      message_id: "om_group",
      create_time: String(now),
      chat_id: "oc_group",
      chat_type: "group",
      content: JSON.stringify({ text: "@_bot 帮我看看 @_user_2" }),
      mentions: [
        {
          key: "@_bot",
          id: { open_id: "ou_bot" },
          name: "Codex Bot",
        },
        {
          key: "@_user_2",
          id: { open_id: "ou_user_2" },
          name: "李四",
        },
      ],
    },
  }), {
    channelId: "feishu",
    accountId: "work",
    botOpenId: "ou_bot",
    expectedAppId: "cli_1234567890abcdef",
    now,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.message.id, "om_group");
  assert.equal(result.message.text, "帮我看看 @李四");
  assert.equal(result.message.routeKey, "feishu:work:group:oc_group");
  assert.deepEqual(result.message.sender, { id: "ou_user" });
  assert.deepEqual(result.message.conversation, {
    id: "oc_group",
    kind: "group",
    displayName: "飞书群聊",
  });
  const raw = result.message.raw as {
    chatCodex?: {
      feishu?: {
        group?: {
          mentionedBot?: boolean;
          mentionAll?: boolean;
          mentions?: Array<{ key: string; openId?: string; isBot?: boolean }>;
          originalText?: string;
          normalizedText?: string;
        };
      };
    };
  };
  assert.equal(raw.chatCodex?.feishu?.group?.mentionedBot, true);
  assert.equal(raw.chatCodex?.feishu?.group?.mentionAll, false);
  assert.equal(raw.chatCodex?.feishu?.group?.originalText, "@_bot 帮我看看 @_user_2");
  assert.equal(raw.chatCodex?.feishu?.group?.normalizedText, "帮我看看 @李四");
  assert.deepEqual(raw.chatCodex?.feishu?.group?.mentions?.map((mention) => ({
    key: mention.key,
    openId: mention.openId,
    isBot: mention.isBot,
  })), [
    { key: "@_bot", openId: "ou_bot", isBot: true },
    { key: "@_user_2", openId: "ou_user_2", isBot: false },
  ]);
});

test("feishuEventToChannelMessage maps group image and file attachments", () => {
  const now = Date.now();
  const imageResult = feishuEventToChannelMessage(sampleFeishuTextEvent({
    message: {
      message_id: "om_group_image",
      create_time: String(now),
      chat_id: "oc_group_media",
      chat_type: "group",
      message_type: "image",
      content: JSON.stringify({ image_key: "img_group_1" }),
    },
  }), {
    channelId: "feishu",
    accountId: "work",
    now,
  });
  const fileResult = feishuEventToChannelMessage(sampleFeishuTextEvent({
    message: {
      message_id: "om_group_file",
      create_time: String(now),
      chat_id: "oc_group_media",
      chat_type: "group",
      message_type: "file",
      content: JSON.stringify({ file_key: "file_group_1", file_name: "group-report.pdf", file_size: 18 }),
    },
  }), {
    channelId: "feishu",
    accountId: "work",
    now,
  });

  assert.equal(imageResult.ok, true);
  assert.equal(fileResult.ok, true);
  if (!imageResult.ok || !fileResult.ok) return;
  assert.equal(imageResult.message.routeKey, "feishu:work:group:oc_group_media");
  assert.equal(imageResult.message.attachments?.[0]?.type, "image");
  assert.equal(imageResult.message.attachments?.[0]?.id, "img_group_1");
  assert.equal(fileResult.message.routeKey, "feishu:work:group:oc_group_media");
  assert.equal(fileResult.message.attachments?.[0]?.type, "file");
  assert.equal(fileResult.message.attachments?.[0]?.name, "group-report.pdf");
  assert.equal(fileResult.message.attachments?.[0]?.sizeBytes, 18);
});

test("feishuEventToChannelMessage keeps different Feishu groups as separate routes", () => {
  const now = Date.now();
  const groupA = feishuEventToChannelMessage(sampleFeishuTextEvent({
    message: {
      message_id: "om_group_a",
      create_time: String(now),
      chat_id: "oc_group_a",
      chat_type: "group",
      content: JSON.stringify({ text: "@_bot A 群消息" }),
      mentions: [{
        key: "@_bot",
        id: { open_id: "ou_bot" },
        name: "Codex Bot",
      }],
    },
  }), {
    channelId: "feishu",
    accountId: "work",
    botOpenId: "ou_bot",
    now,
  });
  const groupB = feishuEventToChannelMessage(sampleFeishuTextEvent({
    message: {
      message_id: "om_group_b",
      create_time: String(now),
      chat_id: "oc_group_b",
      chat_type: "group",
      content: JSON.stringify({ text: "@_bot B 群消息" }),
      mentions: [{
        key: "@_bot",
        id: { open_id: "ou_bot" },
        name: "Codex Bot",
      }],
    },
  }), {
    channelId: "feishu",
    accountId: "work",
    botOpenId: "ou_bot",
    now,
  });

  assert.equal(groupA.ok, true);
  assert.equal(groupB.ok, true);
  if (!groupA.ok || !groupB.ok) return;
  assert.equal(groupA.message.routeKey, "feishu:work:group:oc_group_a");
  assert.equal(groupB.message.routeKey, "feishu:work:group:oc_group_b");
  assert.notEqual(groupA.message.routeKey, groupB.message.routeKey);
  assert.equal(groupA.message.conversation.id, "oc_group_a");
  assert.equal(groupB.message.conversation.id, "oc_group_b");
});

test("feishuEventToChannelMessage skips unsupported or unsafe events", () => {
  const baseOptions = {
    channelId: "feishu",
    accountId: "default",
    now: Date.now(),
  };

  assert.deepEqual(feishuEventToChannelMessage(sampleFeishuTextEvent({
    message: { chat_type: "thread" },
  }), baseOptions), { ok: false, reason: "unsupported_chat_type" });

  assert.deepEqual(feishuEventToChannelMessage(sampleFeishuTextEvent({
    message: { message_type: "audio" },
  }), baseOptions), { ok: false, reason: "unsupported_message_type" });

  assert.deepEqual(feishuEventToChannelMessage(sampleFeishuTextEvent({
    sender: { sender_type: "bot" },
  }), baseOptions), { ok: false, reason: "bot_echo" });

  assert.deepEqual(feishuEventToChannelMessage(sampleFeishuTextEvent({
    sender: { sender_id: { open_id: "ou_bot" } },
  }), { ...baseOptions, botOpenId: "ou_bot" }), { ok: false, reason: "self_echo" });
});

test("feishuEventToChannelMessage maps image and file messages to attachments", () => {
  const imageResult = feishuEventToChannelMessage(sampleFeishuTextEvent({
    message: {
      message_id: "om_image",
      message_type: "image",
      content: JSON.stringify({ image_key: "img_v3_1" }),
    },
  }), {
    channelId: "feishu",
    accountId: "default",
    now: Date.now(),
  });
  assert.equal(imageResult.ok, true);
  if (imageResult.ok) {
    assert.equal(imageResult.message.text, undefined);
    assert.equal(imageResult.message.attachments?.[0]?.type, "image");
    assert.equal(imageResult.message.attachments?.[0]?.id, "img_v3_1");
  }

  const fileResult = feishuEventToChannelMessage(sampleFeishuTextEvent({
    message: {
      message_id: "om_file",
      message_type: "file",
      content: JSON.stringify({ file_key: "file_v3_1", file_name: "report.pdf", file_size: 12 }),
    },
  }), {
    channelId: "feishu",
    accountId: "default",
    now: Date.now(),
  });
  assert.equal(fileResult.ok, true);
  if (fileResult.ok) {
    assert.equal(fileResult.message.attachments?.[0]?.type, "file");
    assert.equal(fileResult.message.attachments?.[0]?.name, "report.pdf");
    assert.equal(fileResult.message.attachments?.[0]?.sizeBytes, 12);
  }
});

test("parseFeishuMessageContent extracts post text, images, and files", () => {
  const parsed = parseFeishuMessageContent("post", JSON.stringify({
    content: [[
      { tag: "text", text: "看下这张图" },
      { tag: "img", image_key: "img_post_1" },
      { tag: "file", file_key: "file_post_1", file_name: "report.pdf", file_size: 12 },
    ]],
  }));

  assert.equal(parsed.text, "看下这张图");
  assert.equal(parsed.attachments.length, 2);
  assert.equal(parsed.attachments[0].type, "image");
  assert.equal(parsed.attachments[0].id, "img_post_1");
  assert.equal(parsed.attachments[1].type, "file");
  assert.equal(parsed.attachments[1].id, "file_post_1");
  assert.equal(parsed.attachments[1].name, "report.pdf");
});

test("feishuEventToChannelMessage skips stale replayed messages", () => {
  const result = feishuEventToChannelMessage(sampleFeishuTextEvent({
    message: { create_time: String(Date.now() - 60_000) },
  }), {
    channelId: "feishu",
    accountId: "default",
    now: Date.now(),
    staleMessageMs: 1000,
  });

  assert.deepEqual(result, { ok: false, reason: "stale_message" });
});

test("Feishu credentials come from env without exposing secret values", () => {
  const credentials = loadFeishuCredentialsFromEnv({
    FEISHU_APP_ID: "cli_1234567890abcdef",
    FEISHU_APP_SECRET: "secret-value",
  } as NodeJS.ProcessEnv);

  assert.equal(credentials.appId, "cli_1234567890abcdef");
  assert.equal(credentials.appSecret, "secret-value");
  assert.deepEqual(missingFeishuCredentials(credentials), []);
  assert.equal(maskFeishuSecret(credentials.appSecret), "已配置");
});

test("buildFeishuPostContent wraps markdown text in Feishu post content", () => {
  const content = JSON.parse(buildFeishuPostContent("**状态**\n完成")) as {
    zh_cn: {
      content: Array<Array<{ tag: string; text: string }>>;
    };
  };

  assert.deepEqual(content.zh_cn.content, [[{ tag: "md", text: "**状态**\n完成" }]]);
});
