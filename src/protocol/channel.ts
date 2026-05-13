export type ChannelLoginMode = "none" | "qr" | "token" | "external";

export type ChannelState =
  | "stopped"
  | "starting"
  | "login_required"
  | "connected"
  | "degraded"
  | "failed";

export type ConversationKind = "direct" | "group" | "thread";

export interface ChannelPeer {
  id: string;
  displayName?: string;
}

export interface ChannelConversation {
  id: string;
  kind: ConversationKind;
  displayName?: string;
}

export interface ChannelTarget {
  channelId: string;
  routeKey: string;
  accountId?: string;
  conversation: ChannelConversation;
  recipient: ChannelPeer;
  context?: Record<string, unknown>;
}

export interface ChannelAttachment {
  id: string;
  type: "image" | "voice" | "file" | "video" | "unknown";
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  raw?: unknown;
}

export interface ChannelMessage {
  id: string;
  routeKey: string;
  channelId: string;
  accountId?: string;
  sender: ChannelPeer;
  conversation: ChannelConversation;
  text?: string;
  attachments?: ChannelAttachment[];
  timestamp: string;
  raw?: unknown;
}

export interface ChannelStatus {
  channelId: string;
  state: ChannelState;
  account?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastError?: string;
  details?: Record<string, unknown>;
}

export interface ChannelCapabilities {
  text: boolean;
  media: boolean;
  typing: boolean;
  direct: boolean;
  group: boolean;
  login: ChannelLoginMode;
  messageUpdate: boolean;
  streamingHint: boolean;
}

export interface ChannelLoginResult {
  state: ChannelState;
  message: string;
  qrCodeText?: string;
  details?: Record<string, unknown>;
}

export interface ChannelMedia {
  type: "image" | "voice" | "file" | "video";
  path?: string;
  url?: string;
  name?: string;
  mimeType?: string;
}

export interface SendOptions {
  replyToMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface SendResult {
  channelId: string;
  messageId: string;
  deliveredAt: string;
  raw?: unknown;
}

export type ChannelMessageHandler = (message: ChannelMessage) => Promise<void>;

export interface ChannelAdapter {
  id: string;
  label: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  login?(): Promise<ChannelLoginResult>;
  getStatus(): Promise<ChannelStatus>;
  getCapabilities(): ChannelCapabilities;
  onMessage(handler: ChannelMessageHandler): void;
  sendText(target: ChannelTarget, text: string, options?: SendOptions): Promise<SendResult>;
  sendMedia?(target: ChannelTarget, media: ChannelMedia, options?: SendOptions): Promise<SendResult>;
}

export function buildRouteKey(input: {
  channelId: string;
  accountId?: string;
  conversationKind: ConversationKind;
  conversationId: string;
}): string {
  const account = input.accountId?.trim() || "default";
  return `${input.channelId}:${account}:${input.conversationKind}:${input.conversationId}`;
}

export function replyTargetFromMessage(message: ChannelMessage): ChannelTarget {
  const raw = message.raw && typeof message.raw === "object" ? message.raw as Record<string, unknown> : undefined;
  const contextToken = typeof raw?.context_token === "string" ? raw.context_token : undefined;
  return {
    channelId: message.channelId,
    routeKey: message.routeKey,
    accountId: message.accountId,
    conversation: message.conversation,
    recipient: message.sender,
    context: {
      sourceMessageId: message.id,
      ...(contextToken ? { contextToken } : {}),
    },
  };
}
