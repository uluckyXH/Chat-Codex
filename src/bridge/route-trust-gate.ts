import type { Logger } from "../logging/logger.js";
import type { TranscriptSink } from "../logging/transcript.js";
import type { ChannelMessage, ChannelTarget } from "../protocol/channel.js";
import type { MemoryStateStore } from "../state/memory-state-store.js";
import type { TrustedRouteRecord } from "../state/persistent-state-types.js";
import type { BridgeDelivery } from "./delivery.js";
import { PairingCodeManager, parsePairingCodeInput } from "./pairing-code-manager.js";
import type { RouteTrustMode } from "./bridge-types.js";

export const ROUTE_PAIRING_REQUIRED_CHANNEL_TEXT = [
  "当前聊天还没有完成 Chat-Codex 配对。",
  "请查看运行 chat-codex 的终端/TUI 日志中的配对码，然后在当前聊天发送 /pair <配对码> 完成配对。",
].join("\n");

export interface RouteTrustGateOptions {
  state: MemoryStateStore;
  delivery: BridgeDelivery;
  logger: Logger;
  transcript?: TranscriptSink;
  mode?: RouteTrustMode;
  pairingCodes?: PairingCodeManager;
  now?: () => Date;
  onRouteTrusted?: (record: TrustedRouteRecord, message: ChannelMessage) => void | Promise<void>;
}

export type RouteTrustGateResult =
  | { action: "allow" }
  | { action: "handled"; reason: "challenge_created" | "pair_failed" }
  | { action: "handled"; reason: "paired"; trustedRoute: TrustedRouteRecord };

export class RouteTrustGate {
  private readonly state: MemoryStateStore;
  private readonly delivery: BridgeDelivery;
  private readonly logger: Logger;
  private readonly transcript?: TranscriptSink;
  private readonly mode: RouteTrustMode;
  private readonly pairingCodes: PairingCodeManager;
  private readonly now: () => Date;
  private readonly onRouteTrusted?: (record: TrustedRouteRecord, message: ChannelMessage) => void | Promise<void>;

  constructor(options: RouteTrustGateOptions) {
    this.state = options.state;
    this.delivery = options.delivery;
    this.logger = options.logger;
    this.transcript = options.transcript;
    this.mode = options.mode ?? "disabled";
    this.pairingCodes = options.pairingCodes ?? new PairingCodeManager();
    this.now = options.now ?? (() => new Date());
    this.onRouteTrusted = options.onRouteTrusted;
  }

  async handle(message: ChannelMessage, target: ChannelTarget): Promise<RouteTrustGateResult> {
    if (!this.shouldRequirePairing(message)) return { action: "allow" };
    if (this.state.isRouteTrusted(message.routeKey)) return { action: "allow" };

    const inputCode = parsePairingCodeInput(message.text);
    if (inputCode) {
      const verified = this.pairingCodes.verify(message.routeKey, inputCode);
      if (verified.ok) {
        const trusted = this.state.trustRoute(trustedRouteFromMessage(message, this.now()));
        await this.onRouteTrusted?.(trusted, message);
        this.logSecurity(target, pairedText(trusted));
        this.logger.info("route pairing completed", {
          routeKey: message.routeKey,
          channel: message.channelId,
          conversationKind: message.conversation.kind,
        });
        await this.delivery.sendText(target, "Chat-Codex 配对成功，当前聊天已信任。");
        return { action: "handled", reason: "paired", trustedRoute: trusted };
      }
      this.logSecurity(target, pairingFailedText(message, verified.reason));
      this.logger.warn("route pairing failed", {
        routeKey: message.routeKey,
        channel: message.channelId,
        reason: verified.reason,
      });
      if (verified.reason === "expired" || verified.reason === "locked" || verified.reason === "missing") {
        this.logChallenge(message, target);
      }
      await this.delivery.sendText(target, pairingFailedChannelText(verified.reason));
      return { action: "handled", reason: "pair_failed" };
    }

    this.logChallenge(message, target);
    await this.delivery.sendText(target, ROUTE_PAIRING_REQUIRED_CHANNEL_TEXT);
    return { action: "handled", reason: "challenge_created" };
  }

  private shouldRequirePairing(message: ChannelMessage): boolean {
    if (this.mode === "disabled") return false;
    if (this.mode === "pairing_required") return true;
    return isRealChannelId(message.channelId);
  }

  private logChallenge(message: ChannelMessage, target: ChannelTarget): void {
    const challenge = this.pairingCodes.getOrCreate(message.routeKey);
    const text = [
      "发现未配对聊天",
      `渠道: ${message.channelId}`,
      `聊天: ${message.conversation.displayName ?? message.sender.displayName ?? message.conversation.id}`,
      `Route: ${message.routeKey}`,
      `配对码: ${challenge.code}`,
      `有效期至: ${challenge.expiresAt}`,
      `请让该聊天发送: /pair ${challenge.code}`,
    ].join("\n");
    this.logSecurity(target, text);
    this.logger.warn("route pairing required", {
      routeKey: message.routeKey,
      channel: message.channelId,
      pairingCode: challenge.code,
      expiresAt: challenge.expiresAt,
    });
  }

  private logSecurity(target: ChannelTarget, text: string): void {
    this.transcript?.localProgress?.(target, `Chat-Codex 安全:\n${text}`);
  }
}

export function trustedRouteFromMessage(message: ChannelMessage, now: Date): TrustedRouteRecord {
  const timestamp = now.toISOString();
  const feishuDirect = isFeishuDirectMessage(message);
  return {
    routeKey: message.routeKey,
    channelId: message.channelId,
    accountId: message.accountId ?? "default",
    conversationKind: message.conversation.kind,
    conversationId: message.conversation.id,
    displayName: message.conversation.displayName ?? (feishuDirect ? undefined : message.sender.displayName),
    trustedAt: timestamp,
    trustedBySenderId: message.sender.id,
    trustedBySenderDisplayName: feishuDirect ? undefined : message.sender.displayName,
    trustMethod: "pairing_code",
    lastSeenAt: message.timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function isRealChannelId(channelId: string): boolean {
  return channelId === "weixin"
    || channelId.startsWith("weixin-")
    || channelId === "feishu"
    || channelId.startsWith("feishu-")
    || channelId === "lark"
    || channelId.startsWith("lark-");
}

function isFeishuDirectMessage(message: ChannelMessage): boolean {
  return message.conversation.kind === "direct"
    && (message.channelId === "feishu"
      || message.channelId.startsWith("feishu-")
      || message.channelId === "lark"
      || message.channelId.startsWith("lark-"));
}

function pairedText(record: TrustedRouteRecord): string {
  return [
    "配对成功",
    `Route: ${record.routeKey}`,
    `信任时间: ${record.trustedAt}`,
  ].join("\n");
}

function pairingFailedText(message: ChannelMessage, reason: string): string {
  return [
    "配对失败",
    `Route: ${message.routeKey}`,
    `原因: ${formatPairingFailureReason(reason)}`,
  ].join("\n");
}

function formatPairingFailureReason(reason: string): string {
  if (reason === "expired") return "配对码已过期";
  if (reason === "locked") return "错误次数过多，已重新生成配对码";
  if (reason === "missing") return "没有可用配对码";
  return "配对码不正确";
}

function pairingFailedChannelText(reason: string): string {
  if (reason === "missing") return ROUTE_PAIRING_REQUIRED_CHANNEL_TEXT;
  return [
    `Chat-Codex 配对失败：${formatPairingFailureReason(reason)}。`,
    "请查看运行 chat-codex 的终端/TUI 日志，确认最新配对码后重新发送 /pair <配对码>。",
  ].join("\n");
}
