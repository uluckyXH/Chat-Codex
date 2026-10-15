import { createHash } from "node:crypto";
import type { ChannelMessage, ChannelQuoteDiagnostics } from "../../protocol/channel.js";
import { WeixinMessageItemType, type WeixinMessage, type WeixinMessageItem, type WeixinPartialText, type WeixinRefMessage } from "./weixin-types.js";
import { weixinMessageId } from "./weixin-json.js";

export function weixinItemText(item: WeixinMessageItem): string {
  switch (item.type) {
    case WeixinMessageItemType.TEXT: return item.text_item?.text ?? "";
    case WeixinMessageItemType.VOICE: return item.voice_item?.text || "[语音]";
    case WeixinMessageItemType.IMAGE: return "[图片]";
    case WeixinMessageItemType.VIDEO: return "[视频]";
    case WeixinMessageItemType.FILE: return item.file_item?.file_name ? `[文件：${item.file_item.file_name}]` : "[文件]";
    default: return "";
  }
}

export function weixinReference(raw: WeixinMessage) {
  return raw.item_list?.find((item) => item.ref_msg)?.ref_msg;
}

export function weixinInlineQuoteText(ref: WeixinRefMessage): string {
  return [ref.title?.trim(), ref.message_item ? weixinItemText(ref.message_item) : undefined].filter(Boolean).join(" | ");
}

export function resolveWeixinQuote(raw: WeixinMessage, cachedText?: string): ChannelMessage["quotedMessage"] {
  const ref = weixinReference(raw);
  if (!ref) return undefined;
  const messageId = weixinMessageId(ref.svr_id) ?? weixinMessageId(ref.message_item?.msg_id);
  const inline = weixinInlineQuoteText(ref);
  const text = inline || cachedText || "[引用消息未附带原文，尚未取得缓存内容，请重新发送原文]";
  const selectedText = ref.partial_text ? resolveWeixinPartialQuote(inline || cachedText || "", ref.partial_text) : undefined;
  return { messageId, text, ...(selectedText ? { selectedText } : {}) };
}

export function weixinQuoteDiagnostics(
  raw: WeixinMessage,
  quote: NonNullable<ChannelMessage["quotedMessage"]>,
  cache: ChannelQuoteDiagnostics["cache"],
  media: ChannelQuoteDiagnostics["media"],
  cachedText?: string,
): ChannelQuoteDiagnostics {
  const ref = weixinReference(raw)!;
  const source = weixinInlineQuoteText(ref) ? "inline" : cache === "hit" && cachedText ? "cache" : "unavailable";
  return {
    source, cache, media,
    selection: !ref.partial_text ? "none" : source === "unavailable" ? "unavailable" : quote.selectedText ? "restored" : "fallback",
  };
}

export function unavailableWeixinQuoteText(cache: ChannelQuoteDiagnostics["cache"]): string {
  const reason = {
    miss: "本地缓存未命中，可能未记录或已清理，无法确认是否过期",
    disabled: "引用缓存未启用",
    unavailable: "引用缓存不可用或读取失败",
    "not-configured": "未配置引用缓存目录",
    "missing-id": "微信未提供可用的引用消息 ID，也未附带原文",
    "not-needed": "微信未附带原文",
    hit: "缓存没有可用正文",
  }[cache];
  return `[引用消息原文无法还原：${reason}；请重新发送原文]`;
}

/** Indexes count occurrences of the start/end anchors, not character offsets. */
export function resolveWeixinPartialQuote(text: string, partial: WeixinPartialText): string | undefined {
  if (!text || !partial || typeof partial.start !== "string" || typeof partial.end !== "string") return undefined;
  const start = nthIndex(text, partial.start, partial.startindex);
  if (start < 0) return undefined;
  const ends = [nthIndex(text, partial.end, partial.endindex), nthIndex(text, partial.end, partial.endindex, start + partial.start.length)];
  for (const end of ends) {
    if (end < start) continue;
    const result = text.slice(start, end + partial.end.length);
    if (!partial.quotemd5 || (typeof partial.quotemd5 === "string" && createHash("md5").update(result, "utf8").digest("hex") === partial.quotemd5.toLowerCase())) return result;
  }
  // Preserve the full quoted message when a substring cannot be verified.
  return undefined;
}

function nthIndex(text: string, anchor: string, occurrence: number, from = 0): number {
  if (!anchor || !Number.isSafeInteger(occurrence) || occurrence < 0) return -1;
  for (let index = 0; index <= occurrence; index++) {
    const position = text.indexOf(anchor, from);
    if (position < 0 || index === occurrence) return position;
    from = position + anchor.length;
  }
  return -1;
}
