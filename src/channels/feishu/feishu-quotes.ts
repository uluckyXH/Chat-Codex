import type { ChannelMessage, ChannelQuoteDiagnostics } from "../../protocol/channel.js";
import { parseFeishuMessageContent } from "./feishu-message.js";
import { downloadFeishuInboundAttachments, type FeishuInboundAttachmentRaw } from "./feishu-media.js";
import type { FeishuSdkClient } from "./feishu-types.js";

type FetchState = NonNullable<ChannelQuoteDiagnostics["fetch"]>;
const FAILURE_TEXT: Record<Exclude<FetchState, "pending" | "success">, string> = {
  missing: "接口未返回这条消息，原文无法取得",
  deleted: "原消息已撤回或删除",
  failed: "原消息不可访问或读取失败，可能需要检查机器人读取消息的权限",
  timeout: "读取原消息超时",
  "chat-mismatch": "返回的原消息不属于当前聊天，已忽略",
  unsupported: "暂不支持读取此类消息的引用内容",
  empty: "原消息没有可读取的正文或附件",
};

/** Fetch exactly one parent; never walk its reply chain or load the chat history. */
export async function hydrateFeishuQuote(options: {
  client: FeishuSdkClient;
  message: ChannelMessage;
  authorize: () => boolean;
  rootDir?: string;
  timeoutMs?: number;
}): Promise<void> {
  const { client, message, authorize } = options;
  const messageId = message.quotedMessage?.messageId;
  if (!messageId || message.quoteDiagnostics?.fetch !== "pending" || !authorize()) return;
  const setFailure = (fetch: keyof typeof FAILURE_TEXT, fetchCode?: number) => {
    if (!authorize()) return;
    message.quotedMessage = { messageId, text: `[引用原文无法取得：${FAILURE_TEXT[fetch]}；请重新发送原文]` };
    message.quoteDiagnostics = {
      source: "unavailable", cache: "not-needed", fetch, selection: "none", media: "none",
      ...(Number.isSafeInteger(fetchCode) ? { fetchCode } : {}),
    };
  };
  let response;
  try {
    const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs! > 0 ? options.timeoutMs! : 10_000;
    response = await boundedLookup(client.im.message.get({ path: { message_id: messageId }, params: { user_id_type: "open_id" } }), timeoutMs);
  } catch (error) {
    setFailure(error instanceof QuoteLookupTimeout ? "timeout" : "failed");
    return;
  }
  if (!authorize()) return;
  if (!response || (response.code !== undefined && response.code !== 0)) { setFailure("failed", response?.code); return; }
  const items = response.data?.items;
  const parent = Array.isArray(items) ? items.find((item) => item?.message_id === messageId) : undefined;
  if (!parent) { setFailure("missing"); return; }
  if (parent.chat_id !== message.conversation.id) { setFailure("chat-mismatch"); return; }
  if (parent.deleted) { setFailure("deleted"); return; }
  if (!["text", "post", "image", "file"].includes(parent.msg_type ?? "")) { setFailure("unsupported"); return; }
  if (typeof parent.body?.content !== "string") { setFailure("empty"); return; }
  const parsed = parseFeishuMessageContent(parent.msg_type!, parent.body.content);
  let text = parsed.text ?? "";
  for (const mention of Array.isArray(parent.mentions) ? parent.mentions : []) {
    if (typeof mention?.key === "string" && mention.key && typeof mention.name === "string") text = text.split(mention.key).join(`@${mention.name}`);
  }
  const labels = parsed.attachments.map((attachment) => attachment.type === "image" ? "[图片]" : `[文件：${attachment.name ?? "未命名文件"}]`);
  text = [text, ...labels].filter(Boolean).join("\n");
  if (!text) { setFailure("empty"); return; }
  const quoted: ChannelMessage = {
    ...message,
    attachments: parsed.attachments.map((attachment) => ({
      ...attachment, id: `quote-${messageId}-${attachment.id}`, caption: "引用附件",
      raw: { ...(attachment.raw as FeishuInboundAttachmentRaw), messageId },
    })),
  };
  await downloadFeishuInboundAttachments({ client, message: quoted, rootDir: options.rootDir, authorize });
  if (!authorize()) return;
  const available = quoted.attachments?.filter((attachment) => attachment.downloadState === "available") ?? [];
  const unavailable = available.length < parsed.attachments.length;
  if (unavailable) text += "\n[引用附件无法取得，请重新发送附件]";
  message.quotedMessage = { messageId, text };
  message.quoteDiagnostics = {
    source: "remote", cache: "not-needed", fetch: "success", selection: "none",
    media: unavailable ? "unavailable" : available.length ? "available" : "none",
  };
  if (available.length) (message.attachments ??= []).push(...available);
}

class QuoteLookupTimeout extends Error {}

async function boundedLookup<T>(request: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new QuoteLookupTimeout()), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
