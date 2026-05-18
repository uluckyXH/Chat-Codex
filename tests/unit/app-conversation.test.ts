import test from "node:test";
import assert from "node:assert/strict";
import {
  extractNewAppChatPrompt,
  formatAppConversationTitle,
  isNewAppChatCommand,
} from "../../src/bridge/app-conversation.js";
import type { ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";

test("app conversation helpers parse /new chat commands", () => {
  assert.equal(isNewAppChatCommand(["chat"]), true);
  assert.equal(isNewAppChatCommand(["CHAT", "hello"]), true);
  assert.equal(isNewAppChatCommand([]), false);
  assert.equal(isNewAppChatCommand(["session"]), false);
  assert.equal(extractNewAppChatPrompt("/new chat"), "");
  assert.equal(extractNewAppChatPrompt("/new chat 帮我检查测试"), "帮我检查测试");
  assert.equal(extractNewAppChatPrompt("  /NEW   chat   hello world  "), "hello world");
});

test("app conversation helpers format readable channel titles", () => {
  assert.equal(formatAppConversationTitle(message({
    channelId: "weixin",
    accountId: "wx-main",
    senderDisplayName: "小黄",
    conversationDisplayName: "主聊天",
  }), target({
    channelId: "weixin",
    accountId: "wx-main",
  })), "微信 / wx-main / 主聊天");

  assert.equal(formatAppConversationTitle(message({
    channelId: "feishu",
    accountId: "bot-a",
    senderDisplayName: "张三",
    conversationId: "oc_123",
  }), target({
    channelId: "feishu",
    accountId: "bot-a",
  })), "飞书 / bot-a / 张三");

  const longTitle = formatAppConversationTitle(message({
    channelId: "mock",
    accountId: "account",
    conversationDisplayName: "很长的标题".repeat(30),
  }), target({
    channelId: "mock",
    accountId: "account",
  }));
  assert.equal(longTitle.length, 80);
  assert.ok(longTitle.endsWith("..."));
});

function message(options: {
  channelId: string;
  accountId?: string;
  senderDisplayName?: string;
  conversationId?: string;
  conversationDisplayName?: string;
}): ChannelMessage {
  return {
    id: "m1",
    routeKey: `${options.channelId}:${options.accountId ?? "default"}:direct:${options.conversationId ?? "direct-id"}`,
    channelId: options.channelId,
    accountId: options.accountId,
    sender: { id: "sender-id", displayName: options.senderDisplayName },
    conversation: {
      id: options.conversationId ?? "direct-id",
      kind: "direct",
      displayName: options.conversationDisplayName,
    },
    text: "",
    timestamp: new Date().toISOString(),
  };
}

function target(options: {
  channelId: string;
  accountId?: string;
}): ChannelTarget {
  return {
    channelId: options.channelId,
    accountId: options.accountId,
    routeKey: `${options.channelId}:${options.accountId ?? "default"}:direct:direct-id`,
    conversation: { id: "direct-id", kind: "direct" },
    recipient: { id: "sender-id" },
  };
}
