import type {
  ChannelAdapter,
  ChannelAttachment,
  ChannelCapabilities,
  ConversationKind,
  ChannelLoginResult,
  ChannelMedia,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelStatus,
  ChannelTarget,
  ChannelToolProgress,
  SendOptions,
  SendResult,
} from "../../protocol/channel.js";
import type { ChannelDeliveryPolicy } from "../../protocol/delivery-policy.js";
import { DEFAULT_CHANNEL_DELIVERY_POLICY } from "../../protocol/delivery-policy.js";
import { buildRouteKey } from "../../protocol/channel.js";

export interface SentMockMessage {
  target: ChannelTarget;
  text: string;
  options?: SendOptions;
  result: SendResult;
}

export interface SentMockMedia {
  target: ChannelTarget;
  media: ChannelMedia;
  options?: SendOptions;
  result: SendResult;
}

export interface SentMockTyping {
  target: ChannelTarget;
  typing: boolean;
  options?: SendOptions;
}

export interface SentMockToolProgress {
  target: ChannelTarget;
  progress: ChannelToolProgress;
  options?: SendOptions;
  result: SendResult;
}

export interface MockChannelAdapterOptions {
  id?: string;
  label?: string;
  accountId?: string;
  media?: boolean;
  typing?: boolean;
  direct?: boolean;
  group?: boolean;
  thread?: boolean;
}

export class MockChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly label: string;
  readonly sentMessages: SentMockMessage[] = [];
  readonly sentMedia: SentMockMedia[] = [];
  readonly sentTyping: SentMockTyping[] = [];
  readonly sentToolProgress: SentMockToolProgress[] = [];
  private handler?: ChannelMessageHandler;
  private state: ChannelStatus;

  constructor(private readonly options: MockChannelAdapterOptions = {}) {
    this.id = options.id ?? "mock";
    this.label = options.label ?? "Mock Channel";
    this.state = { channelId: this.id, state: "stopped" };
  }

  async start(): Promise<void> {
    this.state = { ...this.state, state: "connected" };
  }

  async stop(): Promise<void> {
    this.state = { ...this.state, state: "stopped" };
  }

  async login(): Promise<ChannelLoginResult> {
    this.state = { ...this.state, state: "connected", account: this.options.accountId ?? "mock-account" };
    return { state: "connected", message: "mock channel does not require login" };
  }

  async getStatus(): Promise<ChannelStatus> {
    return { ...this.state, channelId: this.id };
  }

  getCapabilities(): ChannelCapabilities {
    return {
      text: true,
      media: this.options.media ?? false,
      typing: this.options.typing ?? false,
      direct: this.options.direct ?? true,
      group: this.options.group ?? true,
      thread: this.options.thread ?? true,
      login: "none",
      messageUpdate: false,
      streamingHint: false,
    };
  }

  getDeliveryPolicy(): ChannelDeliveryPolicy {
    return DEFAULT_CHANNEL_DELIVERY_POLICY;
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.handler = handler;
  }

  async sendText(target: ChannelTarget, text: string, options?: SendOptions): Promise<SendResult> {
    const result: SendResult = {
      channelId: this.id,
      messageId: `mock-out-${this.sentMessages.length + 1}`,
      deliveredAt: new Date().toISOString(),
    };
    this.sentMessages.push({ target, text, options, result });
    this.state = { ...this.state, lastOutboundAt: result.deliveredAt };
    return result;
  }

  async sendMedia(target: ChannelTarget, media: ChannelMedia, options?: SendOptions): Promise<SendResult> {
    const result: SendResult = {
      channelId: this.id,
      messageId: `mock-media-${this.sentMedia.length + 1}`,
      deliveredAt: new Date().toISOString(),
    };
    this.sentMedia.push({ target, media, options, result });
    this.state = { ...this.state, lastOutboundAt: result.deliveredAt };
    return result;
  }

  async sendTyping(target: ChannelTarget, typing: boolean, options?: SendOptions): Promise<void> {
    this.sentTyping.push({ target, typing, options });
  }

  async sendToolProgress(target: ChannelTarget, progress: ChannelToolProgress, options?: SendOptions): Promise<SendResult> {
    const result: SendResult = {
      channelId: this.id,
      messageId: `mock-tool-${this.sentToolProgress.length + 1}`,
      deliveredAt: new Date().toISOString(),
    };
    this.sentToolProgress.push({ target, progress, options, result });
    this.state = { ...this.state, lastOutboundAt: result.deliveredAt };
    return result;
  }

  async emitText(text: string, options: {
    senderId?: string;
    senderDisplayName?: string;
    conversationId?: string;
    conversationKind?: ConversationKind;
    conversationDisplayName?: string;
    attachments?: ChannelAttachment[];
  } = {}): Promise<void> {
    await this.emitMessage({ text, ...options });
  }

  async emitAttachment(attachments: ChannelAttachment[], options: {
    text?: string;
    senderId?: string;
    senderDisplayName?: string;
    conversationId?: string;
    conversationKind?: ConversationKind;
    conversationDisplayName?: string;
  } = {}): Promise<void> {
    await this.emitMessage({ ...options, attachments });
  }

  async emitMessage(options: {
    text?: string;
    attachments?: ChannelAttachment[];
    senderId?: string;
    senderDisplayName?: string;
    conversationId?: string;
    conversationKind?: ConversationKind;
    conversationDisplayName?: string;
  }): Promise<void> {
    if (!this.handler) throw new Error("mock channel handler is not registered");
    const senderId = options.senderId ?? "mock-user";
    const conversationId = options.conversationId ?? senderId;
    const conversationKind = options.conversationKind ?? "direct";
    const accountId = this.options.accountId ?? "mock-account";
    const routeKey = buildRouteKey({
      channelId: this.id,
      accountId,
      conversationKind,
      conversationId,
    });
    const message: ChannelMessage = {
      id: `mock-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      routeKey,
      channelId: this.id,
      accountId,
      sender: { id: senderId, displayName: options.senderDisplayName ?? "Mock User" },
      conversation: { id: conversationId, kind: conversationKind, displayName: options.conversationDisplayName ?? (conversationKind === "group" ? "Mock Group" : "Mock Direct") },
      text: options.text,
      attachments: options.attachments,
      timestamp: new Date().toISOString(),
    };
    this.state = { ...this.state, lastInboundAt: message.timestamp };
    await this.handler(message);
  }
}
