import type { ApprovalManager } from "../approvals/approval-manager.js";
import type { PendingApproval } from "../approvals/types.js";
import type { Logger } from "../logging/logger.js";
import type { TranscriptSink } from "../logging/transcript.js";
import type { ChannelRegistry } from "../channels/registry.js";
import type { ChannelMedia, ChannelTarget, ChannelToolProgress } from "../protocol/channel.js";
import { extractBridgeSendFileRefs } from "./media-extractor.js";
import { PROGRESS_SEND_FAILURE_COOLDOWN_MS, SEND_FILE_MAX_FILES } from "./bridge-types.js";
import { sleep } from "./formatters.js";

export interface BridgeDeliveryOptions {
  channels: ChannelRegistry;
  approvals: ApprovalManager;
  logger: Logger;
  transcript?: TranscriptSink;
  approvalSendRetryDelayMs: number;
}

export class BridgeDelivery {
  private readonly channels: ChannelRegistry;
  private readonly approvals: ApprovalManager;
  private readonly logger: Logger;
  private readonly transcript?: TranscriptSink;
  private readonly approvalSendRetryDelayMs: number;
  private readonly textProgressSendSuppressedUntil = new Map<string, number>();
  private readonly textProgressSendSuppressionReason = new Map<string, string>();
  private readonly toolProgressSendSuppressedUntil = new Map<string, number>();
  private readonly toolProgressSendSuppressionReason = new Map<string, string>();

  constructor(options: BridgeDeliveryOptions) {
    this.channels = options.channels;
    this.approvals = options.approvals;
    this.logger = options.logger;
    this.transcript = options.transcript;
    this.approvalSendRetryDelayMs = options.approvalSendRetryDelayMs;
  }

  async sendText(target: ChannelTarget, text: string): Promise<void> {
    try {
      await this.deliverText(target, text);
    } catch (error) {
      this.logger.warn("channel text send failed", {
        ...deliveryLogMeta(target),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async deliverText(target: ChannelTarget, text: string): Promise<void> {
    await this.channels.sendText(target, text);
    this.transcript?.outbound(target, text);
  }

  async sendApprovalTextUntilDelivered(routeKey: string, target: ChannelTarget, pending: PendingApproval): Promise<void> {
    const text = this.approvals.formatForChannel(pending);
    let failures = 0;
    while (this.isApprovalStillPending(routeKey, pending.approvalKey)) {
      try {
        await this.deliverText(target, text);
        return;
      } catch (error) {
        failures += 1;
        this.logger.warn("approval message send failed", {
          ...deliveryLogMeta(target),
          approvalKey: pending.approvalKey,
          failures,
          retryInMs: this.approvalSendRetryDelayMs,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!this.isApprovalStillPending(routeKey, pending.approvalKey)) return;
      await sleep(this.approvalSendRetryDelayMs);
    }
  }

  async sendProgressText(routeKey: string, target: ChannelTarget, text: string): Promise<void> {
    const suppressedUntil = this.textProgressSendSuppressedUntil.get(routeKey) ?? 0;
    if (Date.now() < suppressedUntil) {
      this.transcript?.localProgress?.(target, formatProgressDeliverySuppressedText(text, {
        reason: this.textProgressSendSuppressionReason.get(routeKey),
        cooldownMs: Math.max(0, suppressedUntil - Date.now()),
      }));
      return;
    }
    const meta = {
      ...deliveryLogMeta(target),
      routeKey,
      messageChars: text.length,
      preview: deliveryTextPreview(text),
    };
    try {
      await this.channels.sendText(target, text);
      if (this.transcript?.outboundProgress) {
        this.transcript.outboundProgress(target, text);
      } else {
        this.transcript?.outbound(target, text);
      }
      this.textProgressSendSuppressedUntil.delete(routeKey);
      this.textProgressSendSuppressionReason.delete(routeKey);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      this.textProgressSendSuppressedUntil.set(routeKey, Date.now() + PROGRESS_SEND_FAILURE_COOLDOWN_MS);
      this.textProgressSendSuppressionReason.set(routeKey, errorText);
      this.logger.warn("progress message send failed", {
        ...meta,
        error: errorText,
        cooldownMs: PROGRESS_SEND_FAILURE_COOLDOWN_MS,
      });
      this.transcript?.localProgress?.(target, formatProgressDeliveryFailureText(text, errorText));
    }
  }

  async sendToolProgress(routeKey: string, target: ChannelTarget, progress: ChannelToolProgress): Promise<void> {
    const suppressedUntil = this.toolProgressSendSuppressedUntil.get(routeKey) ?? 0;
    if (Date.now() < suppressedUntil) {
      this.transcript?.localProgress?.(target, formatToolProgressDeliverySuppressedText(progress, {
        reason: this.toolProgressSendSuppressionReason.get(routeKey),
        cooldownMs: Math.max(0, suppressedUntil - Date.now()),
      }));
      return;
    }
    const meta = {
      ...deliveryLogMeta(target),
      routeKey,
      toolName: progress.toolName,
      toolCallId: progress.toolCallId,
      phase: progress.phase,
      status: progress.status,
    };
    try {
      await this.channels.sendToolProgress(target, progress);
      this.toolProgressSendSuppressedUntil.delete(routeKey);
      this.toolProgressSendSuppressionReason.delete(routeKey);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      this.toolProgressSendSuppressedUntil.set(routeKey, Date.now() + PROGRESS_SEND_FAILURE_COOLDOWN_MS);
      this.toolProgressSendSuppressionReason.set(routeKey, errorText);
      this.logger.warn("tool progress send failed", {
        ...meta,
        error: errorText,
        cooldownMs: PROGRESS_SEND_FAILURE_COOLDOWN_MS,
      });
      this.transcript?.localProgress?.(target, formatToolProgressDeliveryFailureText(progress, errorText));
    }
  }

  async sendRequestedFiles(
    target: ChannelTarget,
    finalText: string,
    cwd: string,
  ): Promise<void> {
    const extraction = extractBridgeSendFileRefs(finalText, cwd, SEND_FILE_MAX_FILES);
    if (extraction.requestedCount === 0) return;

    const failed: string[] = [];
    for (const media of extraction.media) {
      const delivered = await this.trySendMedia(target, media);
      if (!delivered) failed.push(media.name ?? media.path ?? media.url ?? "unknown");
    }

    const notes = [
      extraction.invalidRefs.length > 0 ? `有 ${extraction.invalidRefs.length} 个文件路径无效或不存在，未发送。` : undefined,
      extraction.overflowCount > 0 ? `超过每轮 ${SEND_FILE_MAX_FILES} 个文件上限，已跳过 ${extraction.overflowCount} 个。` : undefined,
      failed.length > 0 ? `有 ${failed.length} 个文件发送失败: ${failed.join(", ")}` : undefined,
    ].filter(Boolean);
    if (notes.length > 0) {
      await this.sendText(target, ["文件发送结果", ...notes.map((note) => `- ${note}`)].join("\n"));
    }
  }

  async withTyping<T>(target: ChannelTarget, operation: () => Promise<T>): Promise<T> {
    const capabilities = this.channels.getCapabilities(target.channelId);
    if (!capabilities.typing) {
      return operation();
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await this.sendTyping(target, true);
      if (stopped) return;
      timer = setTimeout(() => {
        void tick();
      }, 5000);
      timer.unref?.();
    };
    await tick();
    try {
      return await operation();
    } finally {
      stopped = true;
      if (timer) clearTimeout(timer);
      await this.sendTyping(target, false);
    }
  }

  async sendTyping(target: ChannelTarget, typing: boolean): Promise<void> {
    const capabilities = this.channels.getCapabilities(target.channelId);
    if (!capabilities.typing) return;
    try {
      await this.channels.sendTyping(target, typing);
    } catch (error) {
      this.logger.warn("channel typing send failed", {
        ...deliveryLogMeta(target),
        typing,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private isApprovalStillPending(routeKey: string, approvalKey: string): boolean {
    const approval = this.approvals.get(approvalKey);
    return approval?.routeKey === routeKey && approval.status === "pending";
  }

  private async trySendMedia(target: ChannelTarget, media: ChannelMedia): Promise<boolean> {
    const capabilities = this.channels.getCapabilities(target.channelId);
    if (!capabilities.media) {
      this.logger.warn("channel media send skipped", {
        ...deliveryLogMeta(target),
        media: media.path ?? media.url ?? media.name,
        reason: "media unsupported",
      });
      return false;
    }
    try {
      await this.channels.sendMedia(target, media);
      this.transcript?.outboundMedia?.(target, media);
      return true;
    } catch (error) {
      this.logger.warn("channel media send failed", {
        ...deliveryLogMeta(target),
        media: media.path ?? media.url ?? media.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

function deliveryLogMeta(target: ChannelTarget): Record<string, unknown> {
  return {
    channel: target.channelId,
    routeKey: target.routeKey,
    account: target.accountId,
    conversationKind: target.conversation.kind,
    conversationId: target.conversation.id,
  };
}

function deliveryTextPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 160) return normalized;
  return `${normalized.slice(0, 157)}...`;
}

function formatProgressDeliveryFailureText(text: string, error: string): string {
  return [
    "发送失败，未投递到聊天渠道。",
    text,
    "",
    `错误: ${error}`,
  ].join("\n");
}

function formatProgressDeliverySuppressedText(text: string, input: { reason?: string; cooldownMs: number }): string {
  return [
    "发送暂缓，未投递到聊天渠道。",
    `原因: 前一次进度投递失败，当前处于 ${Math.ceil(input.cooldownMs / 1000)}s 冷却期。`,
    input.reason ? `上次错误: ${input.reason}` : undefined,
    text,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatToolProgressDeliveryFailureText(progress: ChannelToolProgress, error: string): string {
  return [
    "工具进度发送失败，未投递到聊天渠道。",
    formatToolProgressBody(progress),
    "",
    `错误: ${error}`,
  ].join("\n");
}

function formatToolProgressDeliverySuppressedText(progress: ChannelToolProgress, input: { reason?: string; cooldownMs: number }): string {
  return [
    "工具进度发送暂缓，未投递到聊天渠道。",
    `原因: 前一次进度投递失败，当前处于 ${Math.ceil(input.cooldownMs / 1000)}s 冷却期。`,
    input.reason ? `上次错误: ${input.reason}` : undefined,
    formatToolProgressBody(progress),
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatToolProgressBody(progress: ChannelToolProgress): string {
  return [
    "工具进度:",
    `工具: ${progress.toolName}`,
    `阶段: ${progress.phase === "start" ? "开始" : "结束"}`,
    progress.status ? `状态: ${progress.status}` : undefined,
    progress.toolCallId ? `调用 ID: ${progress.toolCallId}` : undefined,
  ].filter((line): line is string => line !== undefined).join("\n");
}
