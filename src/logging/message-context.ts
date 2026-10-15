import type { ChannelMessage, ChannelQuoteDiagnostics, SendResult } from "../protocol/channel.js";

export type TranscriptReceipt = Pick<SendResult, "messageId" | "serverMessageId">;

/** Keep metadata separate from chat bodies and never serialize raw channel payloads. */
export function inboundContextLines(message: ChannelMessage): string[] {
  const lines = [`消息 ID: ${logId(message.id)}`];
  if (!message.quotedMessage) return lines;
  lines.push(`引用消息 ID: ${logId(message.quotedMessage.messageId)}`);
  const diagnostic = message.quoteDiagnostics;
  if (!diagnostic) {
    lines.push("引用正文: 未提供恢复诊断");
    return lines;
  }
  lines.push(`引用正文: ${quoteSourceLabel(diagnostic)}`);
  if (diagnostic.fetchCode !== undefined) lines.push(`读取错误码: ${diagnostic.fetchCode}`);
  if (diagnostic.selection !== "none") {
    lines.push(`局部引用: ${{
      restored: "已还原选中片段",
      fallback: "选择锚点或校验不匹配，已回退全文",
      unavailable: "原文不可用，无法还原选中片段",
    }[diagnostic.selection]}`);
  }
  if (diagnostic.media !== "none") {
    lines.push(`引用附件: ${diagnostic.media === "available" ? "已恢复" : "部分或全部不可用，请重新发送附件"}`);
  }
  return lines;
}

export function receiptContextLines(receipt?: TranscriptReceipt): string[] {
  if (!receipt) return [];
  if (!receipt.serverMessageId) return [`发送消息 ID: ${logId(receipt.messageId)}`];
  return [
    `服务端消息 ID: ${logId(receipt.serverMessageId)}`,
    ...(receipt.messageId !== receipt.serverMessageId ? [`客户端消息 ID: ${logId(receipt.messageId)}`] : []),
  ];
}

function quoteSourceLabel(diagnostic: ChannelQuoteDiagnostics): string {
  if (diagnostic.source === "inline") return "微信已附带原文";
  if (diagnostic.source === "cache") return "本地缓存命中";
  if (diagnostic.fetch) return {
    pending: "等待读取原消息（命令或问答回复无需读取）",
    success: "已从渠道读取原文",
    missing: "接口未返回原消息",
    deleted: "原消息已撤回或删除",
    failed: "原消息不可访问或读取失败，请检查机器人消息读取权限及网络",
    timeout: "读取原消息超时",
    "chat-mismatch": "原消息不属于当前聊天，已忽略",
    unsupported: "暂不支持读取该消息类型的引用内容",
    empty: "原消息没有可读取的正文或附件",
  }[diagnostic.fetch];
  return {
    miss: "本地缓存未命中（未记录或已清理，无法确认过期）",
    disabled: "引用缓存未启用",
    unavailable: "引用缓存不可用或读取失败",
    "not-configured": "未配置引用缓存目录",
    "missing-id": "微信未提供可用引用 ID，也未附带原文",
    "not-needed": "原文不可用",
    hit: "缓存没有可用正文",
  }[diagnostic.cache];
}

function logId(value?: string): string {
  if (!value) return "未提供";
  const escaped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return escaped.length > 256 ? `${escaped.slice(0, 253)}...` : escaped;
}
