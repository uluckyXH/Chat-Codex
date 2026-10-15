import type { TranscriptSink } from "../logging/transcript.js";
import type { ChannelTarget } from "../protocol/channel.js";
import type { ChannelDeliveryPolicy } from "../protocol/delivery-policy.js";
import type { BridgeDelivery } from "./delivery.js";

export interface BridgeCommentaryDeliveryOptions {
  delivery: BridgeDelivery;
  transcript?: TranscriptSink;
  minIntervalMs?: number;
  now?: () => number;
  shouldDeliverCommentary(policy: ChannelDeliveryPolicy, routeKey: string): boolean;
  isRealtimeCommentary?(policy: ChannelDeliveryPolicy, routeKey: string): boolean;
}

export interface BridgeCommentaryInput {
  routeKey: string;
  target: ChannelTarget;
  policy: ChannelDeliveryPolicy;
  text: string;
  sessionId?: string;
  turnId?: string;
  itemId?: string;
}

/** A message receipt retained by the caller; timed flushes update delivered in place. */
export interface CommentaryDeliveryResult {
  text: string;
  delivered: boolean;
}

export interface CommentaryFlushResult {
  delivered: boolean;
  deliveredText?: string;
}

interface PendingCommentary {
  target: ChannelTarget;
  messages: CommentaryDeliveryResult[];
}

interface RouteCommentaryState {
  lastSentAt?: number;
  items: Map<string, CommentaryDeliveryResult>;
  pending?: PendingCommentary;
  flushTimer?: ReturnType<typeof setTimeout>;
  inFlight?: Promise<CommentaryFlushResult>;
}

const DEFAULT_MIN_INTERVAL_MS = 3000;

export class BridgeCommentaryDelivery {
  private readonly delivery: BridgeDelivery;
  private readonly transcript?: TranscriptSink;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly shouldDeliverCommentary: BridgeCommentaryDeliveryOptions["shouldDeliverCommentary"];
  private readonly isRealtimeCommentary: NonNullable<BridgeCommentaryDeliveryOptions["isRealtimeCommentary"]>;
  private readonly routes = new Map<string, RouteCommentaryState>();

  constructor(options: BridgeCommentaryDeliveryOptions) {
    this.delivery = options.delivery;
    this.transcript = options.transcript;
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
    this.now = options.now ?? (() => Date.now());
    this.shouldDeliverCommentary = options.shouldDeliverCommentary;
    this.isRealtimeCommentary = options.isRealtimeCommentary ?? (() => false);
  }

  async handleCommentary(input: BridgeCommentaryInput): Promise<CommentaryDeliveryResult> {
    const receipt: CommentaryDeliveryResult = { text: input.text, delivered: false };
    if (!input.text.trim()) return receipt;
    const state = this.stateFor(input.routeKey);
    const itemKey = input.itemId ? JSON.stringify([input.sessionId, input.turnId, input.itemId]) : undefined;
    if (itemKey) {
      const existing = state.items.get(itemKey);
      if (existing) return existing;
      state.items.set(itemKey, receipt);
    }
    if (input.policy.progress === "suppress" || !this.shouldDeliverCommentary(input.policy, input.routeKey)) {
      this.recordLocalCommentary(input.target, receipt.text);
      return receipt;
    }

    this.recordObservedCommentary(input.target, receipt.text);
    if (this.isRealtimeCommentary(input.policy, input.routeKey)) {
      receipt.delivered = await this.delivery.sendRealtimeCommentaryText(input.routeKey, input.target, receipt.text);
      return receipt;
    }

    state.pending ??= { target: input.target, messages: [] };
    state.pending.messages.push(receipt);
    const now = this.now();
    if (!state.inFlight && (state.lastSentAt === undefined || now - state.lastSentAt >= this.minIntervalMs)) {
      await this.flushRoute(input.routeKey);
    } else {
      this.scheduleFlush(input.routeKey, state);
    }
    return receipt;
  }

  async flushRoute(routeKey: string): Promise<CommentaryFlushResult> {
    const state = this.routes.get(routeKey);
    if (!state) return { delivered: false };
    // A timer may already be sending the last item. Wait for its receipt before
    // the turn decides whether a commentary-only fallback is still necessary.
    while (state.inFlight) await state.inFlight;
    if (this.routes.get(routeKey) !== state) return { delivered: false };
    const pending = state.pending;
    if (!pending) return { delivered: false };
    state.pending = undefined;
    clearFlushTimer(state);
    state.lastSentAt = this.now();
    const sending = this.sendPending(routeKey, pending);
    state.inFlight = sending;
    try {
      return await sending;
    } finally {
      state.inFlight = undefined;
    }
  }

  clearRoute(routeKey: string): void {
    const state = this.routes.get(routeKey);
    if (state) clearFlushTimer(state);
    this.routes.delete(routeKey);
  }

  clearAll(): void {
    for (const state of this.routes.values()) clearFlushTimer(state);
    this.routes.clear();
  }

  private stateFor(routeKey: string): RouteCommentaryState {
    const existing = this.routes.get(routeKey);
    if (existing) return existing;
    const next: RouteCommentaryState = { items: new Map() };
    this.routes.set(routeKey, next);
    return next;
  }

  private async sendPending(routeKey: string, pending: PendingCommentary): Promise<CommentaryFlushResult> {
    const text = pending.messages.map((message) => message.text).join("\n\n");
    const delivered = await this.delivery.sendCommentaryText(routeKey, pending.target, text);
    if (delivered) for (const message of pending.messages) message.delivered = true;
    return { delivered, ...(delivered ? { deliveredText: text } : {}) };
  }

  private scheduleFlush(routeKey: string, state: RouteCommentaryState): void {
    if (!state.pending || state.flushTimer) return;
    const delay = commentaryFlushDelay(this.now(), state.lastSentAt, this.minIntervalMs);
    const timer = setTimeout(() => {
      const current = this.routes.get(routeKey);
      if (current) current.flushTimer = undefined;
      void this.flushRoute(routeKey);
    }, delay);
    state.flushTimer = timer;
    unrefTimer(timer);
  }

  private recordObservedCommentary(target: ChannelTarget, text: string): void {
    if (this.transcript?.observedCommentary) {
      this.transcript.observedCommentary(target, text);
      return;
    }
    this.transcript?.observedProgress?.(target, text);
  }

  private recordLocalCommentary(target: ChannelTarget, text: string): void {
    if (this.transcript?.localCommentary) {
      this.transcript.localCommentary(target, text);
      return;
    }
    this.transcript?.localProgress?.(target, text);
  }
}

function commentaryFlushDelay(now: number, lastSentAt: number | undefined, minIntervalMs: number): number {
  if (lastSentAt === undefined) return 0;
  return Math.max(0, minIntervalMs - (now - lastSentAt));
}

function clearFlushTimer(state: RouteCommentaryState): void {
  if (!state.flushTimer) return;
  clearTimeout(state.flushTimer);
  state.flushTimer = undefined;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer !== "object" || timer === null || !("unref" in timer)) return;
  (timer as { unref?: () => void }).unref?.();
}
