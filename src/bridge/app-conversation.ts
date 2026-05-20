import type { ChannelMessage, ChannelTarget } from "../protocol/channel.js";

const APP_CONVERSATION_TITLE_MAX_LENGTH = 80;

export function isNewAppChatCommand(args: string[]): boolean {
  return args[0]?.toLowerCase() === "chat";
}

export function extractNewAppChatPrompt(rawText: string): string {
  return rawText.trim().replace(/^\/new\s+chat\b/i, "").trim();
}

export function formatAppConversationTitle(message: ChannelMessage, target: ChannelTarget): string {
  const feishuDirect = isFeishuChannelId(message.channelId) && message.conversation.kind === "direct";
  const title = [
    channelLabel(message.channelId),
    firstNonEmpty(message.accountId, target.accountId, "default"),
    feishuDirect
      ? firstNonEmpty(
        message.conversation.id,
        target.conversation.id,
        message.sender.id,
        "direct",
      )
      : firstNonEmpty(
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
  if (isFeishuChannelId(channelId)) return "飞书";
  return channelId;
}

function isFeishuChannelId(channelId: string): boolean {
  return channelId === "feishu" || channelId.startsWith("feishu-") || channelId === "lark" || channelId.startsWith("lark-");
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
