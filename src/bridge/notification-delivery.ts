import type { CodexEvent, CodexThreadLifecycleNotification } from "../codex/types.js";
import type { ChannelTarget } from "../protocol/channel.js";
import type { MemoryStateStore } from "../state/memory-state-store.js";
import type { BridgeDelivery } from "./delivery.js";

export interface BridgeNotificationDeliveryOptions {
  state: MemoryStateStore;
  delivery: BridgeDelivery;
}

export interface DeliverCodexNotificationInput {
  routeKey: string;
  target: ChannelTarget;
  event: Extract<CodexEvent, { type: "codex.notification" }>;
}

export class BridgeNotificationDelivery {
  private readonly state: MemoryStateStore;
  private readonly delivery: BridgeDelivery;
  private readonly recent = new Map<string, number>();

  constructor(options: BridgeNotificationDeliveryOptions) {
    this.state = options.state;
    this.delivery = options.delivery;
  }

  async deliver(input: DeliverCodexNotificationInput): Promise<void> {
    const { routeKey, target, event } = input;
    const text = this.applyLifecycleState(routeKey, event) ?? event.notification.text;
    if (this.isDuplicate(routeKey, event)) return;
    await this.delivery.sendText(target, text);
  }

  private applyLifecycleState(
    routeKey: string,
    event: Extract<CodexEvent, { type: "codex.notification" }>,
  ): string | undefined {
    if (!event.notification.unbindRoute || !event.notification.lifecycle) return undefined;
    const active = this.state.getBinding(routeKey);
    const owner = this.state.getSessionOwner(event.sessionId);
    const routeOwnsSession = owner?.ownerRouteKey === routeKey;
    if (active?.sessionId === event.sessionId) {
      this.state.unbindSession(routeKey);
    } else if (routeOwnsSession) {
      this.state.rollbackSessionOwnerClaim(routeKey, event.sessionId);
    }
    this.state.setSessionStatus(event.sessionId, {
      type: "unknown",
      detail: lifecycleStatusDetail(event.notification.lifecycle),
    });
    return lifecycleNoticeText(event.notification.lifecycle, event.sessionId);
  }

  private isDuplicate(
    routeKey: string,
    event: Extract<CodexEvent, { type: "codex.notification" }>,
  ): boolean {
    const key = `${routeKey}:${event.notification.dedupeKey}`;
    const now = Date.now();
    const previous = this.recent.get(key);
    if (previous !== undefined && now - previous < event.notification.dedupeWindowMs) {
      return true;
    }
    this.recent.set(key, now);
    this.prune(now);
    return false;
  }

  private prune(now: number): void {
    const maxWindowMs = 30 * 60_000;
    for (const [key, timestamp] of this.recent) {
      if (now - timestamp > maxWindowMs) this.recent.delete(key);
    }
  }
}

function lifecycleStatusDetail(lifecycle: CodexThreadLifecycleNotification): string {
  switch (lifecycle) {
    case "archived": return "thread archived";
    case "closed": return "thread closed";
    case "unarchived": return "thread unarchived";
  }
}

function lifecycleNoticeText(lifecycle: CodexThreadLifecycleNotification, sessionId: string): string {
  if (lifecycle === "archived") {
    return [
      "当前 Codex 会话已在 Codex 侧归档，Chat-Codex 已解除绑定。",
      `原 Session: ${sessionId}`,
      "请发送 /new 创建新会话，或发送 /resume 切换到其他会话。",
    ].join("\n");
  }
  if (lifecycle === "closed") {
    return [
      "当前 Codex 会话已在 Codex 侧关闭，Chat-Codex 已解除绑定。",
      `原 Session: ${sessionId}`,
      "请发送 /new 创建新会话，或发送 /resume 切换到其他会话。",
    ].join("\n");
  }
  return [
    "当前 Codex 会话已在 Codex 侧恢复可用。",
    `Session: ${sessionId}`,
    "Chat-Codex 不会自动重新绑定；如需继续使用，请发送 /resume。",
  ].join("\n");
}
