import type { ChannelDeliveryPolicy } from "./delivery-policy.js";

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
  origin?: { senderId: string; displayName?: string; messageId: string; receivedAt: string; sequence: number };
  id: string;
  type: "image" | "voice" | "file" | "video" | "unknown";
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  caption?: string;
  localPath?: string;
  url?: string;
  downloadState?: "available" | "failed" | "unsupported";
  error?: string;
  raw?: unknown;
}

export interface ChannelMessage {
  /** Assigned by the registered adapter, never inferred from channel names. */
  groupPolicy?: "feishu";
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

export type ChannelApprovalDecision = "approve" | "approve-session" | "deny" | "cancel";

export interface ChannelApprovalRequest {
  approvalKey: string;
  routeKey: string;
  requestedBy: string;
  kind: string;
  sessionId: string;
  turnId: string;
  itemId: string;
  command?: string;
  environmentId?: string;
  cwd?: string;
  reason?: string;
  terminalId?: string;
  terminalInput?: string;
  risk?: "low" | "medium" | "high" | "unknown";
  availableDecisions: ChannelApprovalDecision[];
}

export interface ChannelApprovalAction {
  approvalKey: string;
  decision: ChannelApprovalDecision;
  message: ChannelMessage;
}

export type ChannelApprovalActionResult =
  | {
    status: "resolved";
    text: string;
    decision: ChannelApprovalDecision;
  }
  | {
    status: "rejected";
    text: string;
  };

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
  receiveMedia?: boolean;
  typing: boolean;
  direct: boolean;
  group: boolean;
  thread: boolean;
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
  sizeBytes?: number;
  caption?: string;
}

export type ChannelToolProgressPhase = "start" | "end";
export type ChannelToolProgressStatus = "completed" | "failed" | "blocked" | "unknown";

export interface ChannelToolProgress {
  phase: ChannelToolProgressPhase;
  toolName: string;
  toolCallId?: string;
  status?: ChannelToolProgressStatus;
}

export interface SendOptions {
  /** Recheck authorization immediately before sending, including reply fallbacks. */
  beforeSend?(): void;
  replyToMessageId?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

export interface SendResult {
  channelId: string;
  messageId: string;
  deliveredAt: string;
  raw?: unknown;
}

export type ChannelMessageHandler = (message: ChannelMessage) => Promise<void>;
export type ChannelApprovalActionHandler = (action: ChannelApprovalAction) => Promise<ChannelApprovalActionResult>;

export interface ChannelAdapter {
  readonly groupPolicy?: "feishu";
  hydrateAttachments?(message: ChannelMessage, authorize?: () => boolean): Promise<void>;
  id: string;
  label: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  login?(): Promise<ChannelLoginResult>;
  getStatus(): Promise<ChannelStatus>;
  getCapabilities(): ChannelCapabilities;
  getDeliveryPolicy?(message?: ChannelMessage): ChannelDeliveryPolicy;
  onMessage(handler: ChannelMessageHandler): void;
  onApprovalAction?(handler: ChannelApprovalActionHandler): void;
  sendText(target: ChannelTarget, text: string, options?: SendOptions): Promise<SendResult>;
  sendApprovalRequest?(target: ChannelTarget, approval: ChannelApprovalRequest): Promise<SendResult>;
  sendMedia?(target: ChannelTarget, media: ChannelMedia, options?: SendOptions): Promise<SendResult>;
  sendTyping?(target: ChannelTarget, typing: boolean, options?: SendOptions): Promise<void>;
  sendToolProgress?(target: ChannelTarget, progress: ChannelToolProgress, options?: SendOptions): Promise<SendResult>;
}

export function isChannelApprovalDecision(value: unknown): value is ChannelApprovalDecision {
  return value === "approve" || value === "approve-session" || value === "deny" || value === "cancel";
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
