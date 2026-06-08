import type { Logger } from "../logging/logger.js";
import { SilentLogger } from "../logging/logger.js";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelMedia,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelStatus,
  ChannelTarget,
  ChannelToolProgress,
  SendOptions,
  SendResult,
} from "../protocol/channel.js";
import type { ChannelDeliveryPolicy } from "../protocol/delivery-policy.js";
import { DEFAULT_CHANNEL_DELIVERY_POLICY, normalizeChannelDeliveryPolicy } from "../protocol/delivery-policy.js";

export interface ChannelRegistryOptions {
  channels: ChannelAdapter[];
  logger?: Logger;
}

export interface ChannelLifecycleResult {
  channelId: string;
  ok: boolean;
  status?: ChannelStatus;
  error?: unknown;
}

export interface ChannelRegistryStatus {
  channels: ChannelStatus[];
  failed: ChannelLifecycleResult[];
}

export class ChannelRegistry {
  private readonly channels = new Map<string, ChannelAdapter>();
  private readonly logger: Logger;
  private handler?: ChannelMessageHandler;
  private readonly lifecycleFailures: ChannelLifecycleResult[] = [];

  constructor(options: ChannelRegistryOptions) {
    if (options.channels.length === 0) {
      throw new Error("ChannelRegistry requires at least one channel");
    }
    this.logger = options.logger ?? new SilentLogger();
    for (const channel of options.channels) {
      if (this.channels.has(channel.id)) {
        throw new Error(`duplicate channel id: ${channel.id}`);
      }
      this.channels.set(channel.id, channel);
      channel.onMessage((message) => this.handleMessage(channel, message));
    }
  }

  ids(): string[] {
    return [...this.channels.keys()];
  }

  get(channelId: string): ChannelAdapter | undefined {
    return this.channels.get(channelId);
  }

  require(channelId: string): ChannelAdapter {
    const channel = this.get(channelId);
    if (!channel) throw new Error(`channel not found: ${channelId}`);
    return channel;
  }

  has(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<ChannelLifecycleResult[]> {
    const results = await Promise.all(this.ids().map(async (channelId) => {
      const channel = this.require(channelId);
      try {
        await channel.start();
        return {
          channelId,
          ok: true,
          status: await channel.getStatus().catch(() => undefined),
        };
      } catch (error) {
        const result = { channelId, ok: false, error };
        this.lifecycleFailures.push(result);
        this.logger.error("channel start failed", {
          channel: channelId,
          error: error instanceof Error ? error.message : String(error),
        });
        return result;
      }
    }));
    return results;
  }

  async stop(): Promise<ChannelLifecycleResult[]> {
    const results = await Promise.all(this.ids().map(async (channelId) => {
      const channel = this.require(channelId);
      try {
        await channel.stop();
        return {
          channelId,
          ok: true,
          status: await channel.getStatus().catch(() => undefined),
        };
      } catch (error) {
        const result = { channelId, ok: false, error };
        this.lifecycleFailures.push(result);
        this.logger.error("channel stop failed", {
          channel: channelId,
          error: error instanceof Error ? error.message : String(error),
        });
        return result;
      }
    }));
    return results;
  }

  async getStatus(channelId: string): Promise<ChannelStatus>;
  async getStatus(): Promise<ChannelRegistryStatus>;
  async getStatus(channelId?: string): Promise<ChannelStatus | ChannelRegistryStatus> {
    if (channelId) return this.require(channelId).getStatus();
    const channels = await Promise.all(this.ids().map(async (id) => this.require(id).getStatus()));
    return {
      channels,
      failed: [...this.lifecycleFailures],
    };
  }

  getCapabilities(channelId: string): ChannelCapabilities {
    return this.require(channelId).getCapabilities();
  }

  listCapabilities(): Record<string, ChannelCapabilities> {
    const result: Record<string, ChannelCapabilities> = {};
    for (const [channelId, channel] of this.channels) {
      result[channelId] = channel.getCapabilities();
    }
    return result;
  }

  getDeliveryPolicy(message?: ChannelMessage): ChannelDeliveryPolicy {
    const channel = message ? this.get(message.channelId) : undefined;
    return normalizeChannelDeliveryPolicy(channel?.getDeliveryPolicy?.(message) ?? DEFAULT_CHANNEL_DELIVERY_POLICY);
  }

  async sendText(target: ChannelTarget, text: string, options?: SendOptions): Promise<SendResult> {
    return this.requireTargetChannel(target).sendText(target, text, options);
  }

  async sendMedia(target: ChannelTarget, media: ChannelMedia, options?: SendOptions): Promise<SendResult> {
    const channel = this.requireTargetChannel(target);
    const capabilities = channel.getCapabilities();
    if (!capabilities.media || !channel.sendMedia) {
      throw new Error(`channel does not support media: ${target.channelId}`);
    }
    return channel.sendMedia(target, media, options);
  }

  async sendTyping(target: ChannelTarget, typing: boolean, options?: SendOptions): Promise<void> {
    const channel = this.requireTargetChannel(target);
    const capabilities = channel.getCapabilities();
    if (!capabilities.typing || !channel.sendTyping) return;
    await channel.sendTyping(target, typing, options);
  }

  async sendToolProgress(target: ChannelTarget, progress: ChannelToolProgress, options?: SendOptions): Promise<SendResult | undefined> {
    const channel = this.requireTargetChannel(target);
    if (!channel.sendToolProgress) return undefined;
    return channel.sendToolProgress(target, progress, options);
  }

  private async handleMessage(channel: ChannelAdapter, message: ChannelMessage): Promise<void> {
    if (message.channelId !== channel.id) {
      this.logger.error("channel message id mismatch", {
        adapterChannel: channel.id,
        messageChannel: message.channelId,
        routeKey: message.routeKey,
      });
      return;
    }
    if (!this.supportsConversation(channel, message)) {
      this.logger.warn("channel message conversation unsupported", {
        channel: channel.id,
        conversationKind: message.conversation.kind,
        routeKey: message.routeKey,
      });
      return;
    }
    await this.handler?.(message);
  }

  private supportsConversation(channel: ChannelAdapter, message: ChannelMessage): boolean {
    const capabilities = channel.getCapabilities();
    if (message.conversation.kind === "direct") return capabilities.direct;
    if (message.conversation.kind === "group") return capabilities.group;
    return capabilities.thread;
  }

  private requireTargetChannel(target: ChannelTarget): ChannelAdapter {
    return this.require(target.channelId);
  }
}

export function createSingleChannelRegistry(channel: ChannelAdapter, logger?: Logger): ChannelRegistry {
  return new ChannelRegistry({ channels: [channel], logger });
}
