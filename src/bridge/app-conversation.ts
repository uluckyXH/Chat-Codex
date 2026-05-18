import type { ChannelMessage, ChannelTarget } from "../protocol/channel.js";

const APP_CONVERSATION_TITLE_MAX_LENGTH = 80;

export function isNewAppChatCommand(args: string[]): boolean {
  return args[0]?.toLowerCase() === "chat";
}

export function extractNewAppChatPrompt(rawText: string): string {
  return rawText.trim().replace(/^\/new\s+chat\b/i, "").trim();
}

export function formatAppConversationTitle(message: ChannelMessage, target: ChannelTarget): string {
  const title = [
    channelLabel(message.channelId),
    firstNonEmpty(message.accountId, target.accountId, "default"),
    firstNonEmpty(
      message.conversation.displayName,
      target.conversation.displayName,
      message.sender.displayName,
      target.recipient.displayName,
      message.conversation.id,
      target.conversation.id,
      message.sender.id,
      "direct",
    ),
  ].map(cleanTitlePart).filter(Boolean).join(" / ");
  return truncateTitle(title || `${channelLabel(message.channelId)} / default / direct`);
}

function channelLabel(channelId: string): string {
  if (channelId === "weixin" || channelId.startsWith("weixin-")) return "微信";
  if (channelId === "feishu" || channelId.startsWith("feishu-") || channelId === "lark" || channelId.startsWith("lark-")) return "飞书";
  return channelId;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  return values.find((value) => value?.trim())?.trim() ?? "";
}

function cleanTitlePart(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateTitle(value: string): string {
  if (value.length <= APP_CONVERSATION_TITLE_MAX_LENGTH) return value;
  return `${value.slice(0, APP_CONVERSATION_TITLE_MAX_LENGTH - 3)}...`;
}
