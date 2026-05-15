import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelLoginResult,
  ChannelMedia,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelStatus,
  ChannelTarget,
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

export interface MockChannelAdapterOptions {
  media?: boolean;
  typing?: boolean;
}

export class MockChannelAdapter implements ChannelAdapter {
  readonly id: string = "mock";
  readonly label: string = "Mock Channel";
  readonly sentMessages: SentMockMessage[] = [];
  readonly sentMedia: SentMockMedia[] = [];
  readonly sentTyping: SentMockTyping[] = [];
  private handler?: ChannelMessageHandler;
  private state: ChannelStatus = { channelId: this.id, state: "stopped" };

  constructor(private readonly options: MockChannelAdapterOptions = {}) {}

  async start(): Promise<void> {
    this.state = { ...this.state, state: "connected" };
  }

  async stop(): Promise<void> {
    this.state = { ...this.state, state: "stopped" };
  }

  async login(): Promise<ChannelLoginResult> {
    this.state = { ...this.state, state: "connected", account: "mock-account" };
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
      direct: true,
      group: true,
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

  async emitText(text: string, options: { senderId?: string; conversationId?: string } = {}): Promise<void> {
    if (!this.handler) throw new Error("mock channel handler is not registered");
    const senderId = options.senderId ?? "mock-user";
    const conversationId = options.conversationId ?? senderId;
    const routeKey = buildRouteKey({
      channelId: this.id,
      accountId: "mock-account",
      conversationKind: "direct",
      conversationId,
    });
    const message: ChannelMessage = {
      id: `mock-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      routeKey,
      channelId: this.id,
      accountId: "mock-account",
      sender: { id: senderId, displayName: "Mock User" },
      conversation: { id: conversationId, kind: "direct", displayName: "Mock Direct" },
      text,
      timestamp: new Date().toISOString(),
    };
    this.state = { ...this.state, lastInboundAt: message.timestamp };
    await this.handler(message);
  }
}
