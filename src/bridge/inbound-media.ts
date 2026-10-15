import path from "node:path";
import type { CodexInputItem, CodexTurnInput } from "../codex/types.js";
import type { ChannelAttachment } from "../protocol/channel.js";

export const PENDING_MEDIA_TTL_MS = 10 * 60 * 1000;
export const PENDING_MEDIA_MAX_ATTACHMENTS = 5;

export interface PendingRouteMedia {
  routeKey: string;
  attachments: ChannelAttachment[];
  createdAt: number;
  sourceMessageIds: string[];
}

export interface PendingMediaManagerOptions {
  now?: () => number;
  ttlMs?: number;
  maxAttachments?: number;
}

export interface AddPendingMediaResult {
  accepted: ChannelAttachment[];
  rejected: ChannelAttachment[];
  total: number;
}

export interface ClassifiedInboundAttachments {
  usable: ChannelAttachment[];
  failed: ChannelAttachment[];
  unsupported: ChannelAttachment[];
}

export class PendingMediaManager {
  private readonly pending = new Map<string, PendingRouteMedia>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxAttachments: number;

  constructor(options: PendingMediaManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? PENDING_MEDIA_TTL_MS;
    this.maxAttachments = options.maxAttachments ?? PENDING_MEDIA_MAX_ATTACHMENTS;
  }

  add(routeKey: string, attachments: ChannelAttachment[], messageId: string): AddPendingMediaResult {
    this.pruneExpired(routeKey);
    const existing = this.pending.get(routeKey);
    const current = existing?.attachments ?? [];
    const capacity = Math.max(0, this.maxAttachments - current.length);
    const accepted = attachments.slice(0, capacity);
    const rejected = attachments.slice(capacity);
    if (accepted.length > 0) {
      this.pending.set(routeKey, {
        routeKey,
        attachments: [...current, ...accepted],
        createdAt: existing?.createdAt ?? this.now(),
        sourceMessageIds: [...(existing?.sourceMessageIds ?? []), messageId],
      });
    }
    return {
      accepted,
      rejected,
      total: this.pending.get(routeKey)?.attachments.length ?? current.length,
    };
  }

  removeWhere(routeKey: string, predicate: (attachment: ChannelAttachment) => boolean): number {
    this.pruneExpired(routeKey);
    const record = this.pending.get(routeKey);
    if (!record) return 0;
    const before = record.attachments.length;
    record.attachments = record.attachments.filter((a) => !predicate(a));
    if (!record.attachments.length) this.pending.delete(routeKey);
    return before - record.attachments.length;
  }

  consume(routeKey: string): ChannelAttachment[] {
    this.pruneExpired(routeKey);
    const attachments = this.pending.get(routeKey)?.attachments ?? [];
    this.pending.delete(routeKey);
    return attachments;
  }

  cancel(routeKey: string): number {
    this.pruneExpired(routeKey);
    const count = this.count(routeKey);
    this.pending.delete(routeKey);
    return count;
  }

  count(routeKey: string): number {
    this.pruneExpired(routeKey);
    return this.pending.get(routeKey)?.attachments.length ?? 0;
  }

  clear(routeKey: string): number {
    return this.cancel(routeKey);
  }

  clearAll(): void {
    this.pending.clear();
  }

  private pruneExpired(routeKey: string): void {
    const item = this.pending.get(routeKey);
    if (!item) return;
    if (this.now() - item.createdAt > this.ttlMs) {
      this.pending.delete(routeKey);
    }
  }
}

export function classifyInboundAttachments(attachments: readonly ChannelAttachment[] | undefined): ClassifiedInboundAttachments {
  const usable: ChannelAttachment[] = [];
  const failed: ChannelAttachment[] = [];
  const unsupported: ChannelAttachment[] = [];
  for (const attachment of attachments ?? []) {
    if (attachment.downloadState === "failed") {
      failed.push(attachment);
    } else if (isUsableInboundAttachment(attachment)) {
      usable.push(attachment);
    } else if (isInboundMediaAttachment(attachment)) {
      unsupported.push(attachment);
    }
  }
  return { usable, failed, unsupported };
}

export function isUsableInboundAttachment(attachment: ChannelAttachment): boolean {
  if (!isInboundMediaAttachment(attachment)) return false;
  if (attachment.downloadState === "unsupported" || attachment.downloadState === "failed") return false;
  return typeof attachment.localPath === "string"
    && attachment.localPath.length > 0
    && path.isAbsolute(attachment.localPath);
}

export function isInboundMediaAttachment(attachment: ChannelAttachment): boolean {
  return attachment.type === "image" || attachment.type === "file";
}

export function codexInputFromTextAndAttachments(text: string, attachments: readonly ChannelAttachment[]): CodexTurnInput {
  const trimmed = text.trim();
  const items: CodexInputItem[] = [];
  if (trimmed) items.push({ type: "text", text: trimmed });
  for (const attachment of attachments) {
    if (!attachment.localPath) continue;
    if (attachment.type === "image") {
      items.push({ type: "localImage", path: attachment.localPath, ...(attachment.origin ? { origin: attachment.origin } : {}) });
    } else if (attachment.type === "file") {
      items.push({
        type: "localFile",
        path: attachment.localPath,
        name: attachment.name,
        mimeType: attachment.mimeType,
        ...(attachment.origin ? { origin: attachment.origin } : {}),
      });
    }
  }
  return {
    text: trimmed,
    items,
  };
}

export function pendingMediaPromptText(count: number): string {
  if (count <= 1) {
    return [
      "【Chat-Codex中间件提醒】",
      "已收到 1 个附件。你想让 Codex 如何处理这个附件？",
      "请直接回复你的要求，例如：解释图片、提取文字、总结文件、检查 UI 问题、根据截图定位代码问题。",
      "发送 /cancel 可取消本次附件。",
    ].join("\n");
  }
  return [
    "【Chat-Codex中间件提醒】",
    `已收到 ${count} 个附件。你想让 Codex 如何处理这些附件？`,
    "请直接回复你的要求；我会把这些附件和你的说明一起交给 Codex。",
    "发送 /cancel 可取消本次附件。",
  ].join("\n");
}

export function pendingMediaOverflowText(rejectedCount: number, total: number): string {
  return [
    "【Chat-Codex中间件提醒】",
    `待处理附件最多保留 ${PENDING_MEDIA_MAX_ATTACHMENTS} 个，已暂存 ${total} 个。`,
    `本次有 ${rejectedCount} 个未加入待处理附件，请先回复说明或发送 /cancel 后再重发。`,
  ].join("\n");
}

export function inboundMediaTurnOverflowText(rejectedCount: number): string {
  return [
    "【Chat-Codex中间件提醒】",
    `本次最多投递 ${PENDING_MEDIA_MAX_ATTACHMENTS} 个附件给 Codex。`,
    `有 ${rejectedCount} 个附件未交给 Codex，请等本轮处理完后再重发。`,
  ].join("\n");
}

export function inboundMediaSaveFailedText(): string {
  return [
    "【Chat-Codex中间件提醒】",
    "附件保存失败，暂时不能交给 Codex 处理。请稍后重发。",
  ].join("\n");
}

export function inboundMediaUnsupportedText(): string {
  return [
    "【Chat-Codex中间件提醒】",
    "已收到附件，但当前只能处理已成功保存到本地的图片或文件。请稍后重发，或换成图片/文件重新发送。",
  ].join("\n");
}

export function cancelledPendingMediaText(count: number): string {
  return `已取消 ${count} 个待处理附件。`;
}

export function clearedPendingMediaText(count: number): string {
  return `已清空 ${count} 个待处理附件。`;
}
