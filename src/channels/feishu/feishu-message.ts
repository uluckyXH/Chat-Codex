import { buildRouteKey, type ChannelAttachment, type ChannelMessage } from "../../protocol/channel.js";
import type { FeishuInboundAttachmentRaw } from "./feishu-media.js";
import type {
  FeishuCredentials,
  FeishuMessageMappingOptions,
  FeishuMessageMappingResult,
  FeishuMessageReceiveEvent,
} from "./feishu-types.js";
import { feishuGroupEventToChannelMessage } from "./group/group-message.js";

export const FEISHU_CHANNEL_ID = "feishu";
export const DEFAULT_FEISHU_ACCOUNT_ID = "default";
export const DEFAULT_FEISHU_DOMAIN = "feishu";
export const DEFAULT_FEISHU_STALE_MESSAGE_MS = 10 * 60 * 1000;

export function loadFeishuCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): FeishuCredentials {
  return {
    appId: firstNonEmpty(env.FEISHU_APP_ID, env.LARK_APP_ID),
    appSecret: firstNonEmpty(env.FEISHU_APP_SECRET, env.LARK_APP_SECRET),
    domain: firstNonEmpty(env.FEISHU_DOMAIN, env.LARK_DOMAIN) ?? DEFAULT_FEISHU_DOMAIN,
    accountId: firstNonEmpty(env.FEISHU_ACCOUNT_ID, env.LARK_ACCOUNT_ID) ?? DEFAULT_FEISHU_ACCOUNT_ID,
    verificationToken: firstNonEmpty(env.FEISHU_VERIFICATION_TOKEN, env.LARK_VERIFICATION_TOKEN),
    encryptKey: firstNonEmpty(env.FEISHU_ENCRYPT_KEY, env.LARK_ENCRYPT_KEY),
  };
}

export function missingFeishuCredentials(credentials: FeishuCredentials): string[] {
  const missing: string[] = [];
  if (!credentials.appId?.trim()) missing.push("FEISHU_APP_ID");
  if (!credentials.appSecret?.trim()) missing.push("FEISHU_APP_SECRET");
  return missing;
}

export function normalizeFeishuCredentials(credentials: FeishuCredentials): FeishuCredentials {
  return {
    appId: normalizeOptional(credentials.appId),
    appSecret: normalizeOptional(credentials.appSecret),
    domain: normalizeOptional(credentials.domain) ?? DEFAULT_FEISHU_DOMAIN,
    accountId: normalizeOptional(credentials.accountId) ?? DEFAULT_FEISHU_ACCOUNT_ID,
    verificationToken: normalizeOptional(credentials.verificationToken),
    encryptKey: normalizeOptional(credentials.encryptKey),
  };
}

export function maskFeishuSecret(value: string | undefined): string {
  if (!value) return "未配置";
  return "已配置";
}

export function maskFeishuAppId(appId: string | undefined): string {
  if (!appId) return "未配置";
  if (appId.length <= 8) return `${appId.slice(0, 2)}***`;
  return `${appId.slice(0, 7)}...${appId.slice(-4)}`;
}

export function parseFeishuTextContent(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const text = (parsed as Record<string, unknown>).text;
    return typeof text === "string" && text.trim() ? text : undefined;
  } catch {
    return trimmed;
  }
}

export interface ParsedFeishuMessageContent {
  text?: string;
  attachments: ChannelAttachment[];
}

export function parseFeishuMessageContent(messageType: string, content: string): ParsedFeishuMessageContent {
  if (messageType === "text") {
    return {
      text: parseFeishuTextContent(content),
      attachments: [],
    };
  }
  const parsed = parseFeishuContentJson(content);
  if (messageType === "image") {
    const imageKey = stringField(parsed, "image_key");
    return {
      attachments: imageKey ? [feishuAttachment({
        id: imageKey,
        type: "image",
        fileKey: imageKey,
        resourceType: "image",
        rawContent: parsed,
      })] : [],
    };
  }
  if (messageType === "file") {
    const fileKey = stringField(parsed, "file_key");
    return {
      attachments: fileKey ? [feishuAttachment({
        id: fileKey,
        type: "file",
        fileKey,
        resourceType: "file",
        name: firstStringField(parsed, "file_name", "name"),
        sizeBytes: numberField(parsed, "file_size") ?? numberField(parsed, "size"),
        rawContent: parsed,
      })] : [],
    };
  }
  if (messageType === "post") {
    return parseFeishuPostContent(parsed);
  }
  return { attachments: [] };
}

export function feishuEventToChannelMessage(
  event: FeishuMessageReceiveEvent,
  options: FeishuMessageMappingOptions,
): FeishuMessageMappingResult {
  if (options.expectedAppId && event.app_id && event.app_id !== options.expectedAppId) {
    return { ok: false, reason: "app_id_mismatch" };
  }
  const message = event.message;
  if (!message?.message_id || !message.chat_id) {
    return { ok: false, reason: "missing_message_fields" };
  }
  if (message.chat_type !== "p2p" && message.chat_type !== "group") {
    return { ok: false, reason: "unsupported_chat_type" };
  }
  if (!isSupportedFeishuMessageType(message.message_type)) {
    return { ok: false, reason: "unsupported_message_type" };
  }
  const senderType = event.sender?.sender_type;
  if (senderType === "bot" || senderType === "app") {
    return { ok: false, reason: "bot_echo" };
  }
  const senderId = event.sender?.sender_id?.open_id
    ?? event.sender?.sender_id?.user_id
    ?? event.sender?.sender_id?.union_id;
  if (!senderId) return { ok: false, reason: "missing_sender_id" };
  const senderDisplayName = message.chat_type === "group"
    ? firstNonEmpty(event.sender.sender_name, event.sender.name, event.sender.user_name)
    : undefined;
  if (options.botOpenId && senderId === options.botOpenId) {
    return { ok: false, reason: "self_echo" };
  }
  if (isStaleFeishuMessage(message.create_time, options.now, options.staleMessageMs)) {
    return { ok: false, reason: "stale_message" };
  }
  const parsedContent = parseFeishuMessageContent(message.message_type, message.content);
  if (!parsedContent.text && parsedContent.attachments.length === 0) {
    return { ok: false, reason: "empty_message" };
  }
  if (message.chat_type === "group") {
    return feishuGroupEventToChannelMessage(event, options, {
      senderId,
      senderDisplayName,
      text: parsedContent.text,
      attachments: parsedContent.attachments,
      timestamp: formatFeishuTimestamp(message.create_time, options.now),
    });
  }
  const routeKey = buildRouteKey({
    channelId: options.channelId,
    accountId: options.accountId,
    conversationKind: "direct",
    conversationId: message.chat_id,
  });
  const timestamp = formatFeishuTimestamp(message.create_time, options.now);
  const channelMessage: ChannelMessage = {
    id: message.message_id,
    routeKey,
    channelId: options.channelId,
    accountId: options.accountId,
    sender: {
      id: senderId,
    },
    conversation: {
      id: message.chat_id,
      kind: "direct",
      displayName: "飞书私聊",
    },
    text: parsedContent.text,
    attachments: parsedContent.attachments.length > 0 ? parsedContent.attachments : undefined,
    timestamp,
    raw: event,
  };
  return { ok: true, message: channelMessage };
}

function isSupportedFeishuMessageType(messageType: string): boolean {
  return messageType === "text" || messageType === "image" || messageType === "file" || messageType === "post";
}

function parseFeishuContentJson(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function parseFeishuPostContent(parsed: unknown): ParsedFeishuMessageContent {
  const attachments: ChannelAttachment[] = [];
  const textParts: string[] = [];
  const content = objectField(parsed, "content");
  if (Array.isArray(content)) {
    for (const line of content) {
      if (!Array.isArray(line)) continue;
      for (const item of line) {
        const tag = stringField(item, "tag");
        const text = firstStringField(item, "text", "name");
        if (text && (tag === "text" || tag === "a" || tag === "at")) {
          textParts.push(text);
        }
        const imageKey = stringField(item, "image_key");
        if (imageKey) {
          attachments.push(feishuAttachment({
            id: imageKey,
            type: "image",
            fileKey: imageKey,
            resourceType: "image",
            rawContent: item,
          }));
        }
        const fileKey = stringField(item, "file_key");
        if (fileKey) {
          attachments.push(feishuAttachment({
            id: fileKey,
            type: "file",
            fileKey,
            resourceType: "file",
            name: firstStringField(item, "file_name", "name"),
            sizeBytes: numberField(item, "file_size") ?? numberField(item, "size"),
            rawContent: item,
          }));
        }
      }
    }
  }
  const text = textParts.join("").trim() || undefined;
  return { text, attachments };
}

function feishuAttachment(params: {
  id: string;
  type: "image" | "file";
  fileKey: string;
  resourceType: "image" | "file";
  name?: string;
  sizeBytes?: number;
  rawContent: unknown;
}): ChannelAttachment {
  return {
    id: params.id,
    type: params.type,
    name: params.name,
    sizeBytes: params.sizeBytes,
    raw: {
      source: "feishu",
      fileKey: params.fileKey,
      resourceType: params.resourceType,
      content: params.rawContent,
    } satisfies FeishuInboundAttachmentRaw & { content: unknown },
  };
}

function objectField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function stringField(value: unknown, key: string): string | undefined {
  const field = objectField(value, key);
  return typeof field === "string" && field.trim() ? field : undefined;
}

function firstStringField(value: unknown, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const field = stringField(value, key);
    if (field) return field;
  }
  return undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  const field = objectField(value, key);
  if (typeof field === "number" && Number.isFinite(field) && field >= 0) return field;
  if (typeof field === "string" && field.trim()) {
    const parsed = Number.parseInt(field, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

export function buildFeishuPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: "md", text }]],
    },
  });
}

export function buildFeishuMessageUuid(prefix = "codex-feishu"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function formatFeishuApiError(response: { code?: number; msg?: string } | undefined, fallback: string): string {
  if (!response) return fallback;
  if (response.code === undefined || response.code === 0) return fallback;
  return response.msg ? `${response.msg} (code ${response.code})` : `code ${response.code}`;
}

export function feishuStatusDetails(input: {
  phase: string;
  sourceVersion: string;
  credentials: FeishuCredentials;
  botOpenId?: string;
  botName?: string;
  groupEnabled?: boolean;
  connectionState?: string;
  reconnectAttempts?: number;
  dedupSize?: number;
}): Record<string, unknown> {
  return {
    phase: input.phase,
    source: "@larksuiteoapi/node-sdk",
    sourceVersion: input.sourceVersion,
    accountId: input.credentials.accountId ?? DEFAULT_FEISHU_ACCOUNT_ID,
    appId: maskFeishuAppId(input.credentials.appId),
    appSecret: maskFeishuSecret(input.credentials.appSecret),
    domain: input.credentials.domain ?? DEFAULT_FEISHU_DOMAIN,
    connectionMode: "websocket",
    botOpenId: input.botOpenId,
    botName: input.botName,
    groupEnabled: input.groupEnabled ?? false,
    connectionState: input.connectionState,
    reconnectAttempts: input.reconnectAttempts,
    dedupSize: input.dedupSize,
  };
}

export function isStaleFeishuMessage(
  createTime: string | undefined,
  now = Date.now(),
  staleMessageMs = DEFAULT_FEISHU_STALE_MESSAGE_MS,
): boolean {
  const timestamp = parseFeishuTimestamp(createTime);
  if (timestamp === undefined) return false;
  return now - timestamp > staleMessageMs;
}

export function parseFeishuTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function formatFeishuTimestamp(value: string | undefined, now = Date.now()): string {
  const timestamp = parseFeishuTimestamp(value) ?? now;
  return new Date(timestamp).toISOString();
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = normalizeOptional(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function normalizeOptional(value: string | undefined): string | undefined {
  let trimmed = value?.trim();
  if (trimmed && trimmed.length >= 2) {
    const quote = trimmed[0];
    if ((quote === `"` || quote === "'") && trimmed.endsWith(quote)) {
      trimmed = trimmed.slice(1, -1).trim();
    }
  }
  return trimmed ? trimmed : undefined;
}
