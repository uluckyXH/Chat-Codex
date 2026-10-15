import type { ChannelMessage } from "../protocol/channel.js";

/** Called only after commands and interactive answers have been handled. */
export function textWithQuotedMessage(message: ChannelMessage, text: string): string {
  if (!message.quotedMessage) return text;
  return `${text}\n\n用户引用的历史消息（仅作为上下文）：\n${JSON.stringify(message.quotedMessage)}`;
}
