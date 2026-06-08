import type { TranscriptSink } from "../logging/transcript.js";
import type { ChannelTarget } from "../protocol/channel.js";
import type { ChannelDeliveryPolicy } from "../protocol/delivery-policy.js";
import type { BridgeDelivery } from "./delivery.js";
import { truncateForChannel } from "./formatters.js";

export interface BridgeCommentaryDeliveryOptions {
  delivery: BridgeDelivery;
  transcript?: TranscriptSink;
  minIntervalMs?: number;
  maxCommentaryChars?: number;
  now?: () => number;
  shouldDeliverCommentary(policy: ChannelDeliveryPolicy, routeKey: string): boolean;
  isRealtimeCommentary?(policy: ChannelDeliveryPolicy, routeKey: string): boolean;
}

export interface BridgeCommentaryInput {
  routeKey: string;
  target: ChannelTarget;
  policy: ChannelDeliveryPolicy;
  text: string;
}

export interface CommentaryDeliveryResult {
  text: string;
  delivered: boolean;
  deliveredText?: string;
}

export interface CommentaryFlushResult {
  delivered: boolean;
  deliveredText?: string;
}

interface PendingCommentary {
  target: ChannelTarget;
  texts: string[];
}

interface RouteCommentaryState {
  lastSentAt?: number;
  recent: string[];
  pending?: PendingCommentary;
  flushTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_MIN_INTERVAL_MS = 3000;
const DEFAULT_MAX_COMMENTARY_CHARS = 1200;
const MAX_PENDING_TEXTS = 3;
const MAX_RECENT_TEXTS = 20;

export class BridgeCommentaryDelivery {
  private readonly delivery: BridgeDelivery;
  private readonly transcript?: TranscriptSink;
  private readonly minIntervalMs: number;
  private readonly maxCommentaryChars: number;
  private readonly now: () => number;
  private readonly shouldDeliverCommentary: BridgeCommentaryDeliveryOptions["shouldDeliverCommentary"];
  private readonly isRealtimeCommentary: NonNullable<BridgeCommentaryDeliveryOptions["isRealtimeCommentary"]>;
  private readonly routes = new Map<string, RouteCommentaryState>();

  constructor(options: BridgeCommentaryDeliveryOptions) {
    this.delivery = options.delivery;
    this.transcript = options.transcript;
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
    this.maxCommentaryChars = Math.max(120, options.maxCommentaryChars ?? DEFAULT_MAX_COMMENTARY_CHARS);
    this.now = options.now ?? (() => Date.now());
    this.shouldDeliverCommentary = options.shouldDeliverCommentary;
    this.isRealtimeCommentary = options.isRealtimeCommentary ?? (() => false);
  }

  async handleCommentary(input: BridgeCommentaryInput): Promise<CommentaryDeliveryResult> {
    const body = input.text.trim();
    if (!body) return { text: body, delivered: false };
    if (input.policy.progress === "suppress") {
      this.recordLocalCommentary(input.target, this.formatCommentary([body]));
      return { text: body, delivered: false };
    }
    if (!this.shouldDeliverCommentary(input.policy, input.routeKey)) {
      this.recordLocalCommentary(input.target, this.formatCommentary([body]));
      return { text: body, delivered: false };
    }

    if (this.isRealtimeCommentary(input.policy, input.routeKey)) {
      this.recordObservedCommentary(input.target, body);
      const delivered = await this.delivery.sendRealtimeCommentaryText(input.routeKey, input.target, body);
      return { text: body, delivered, ...(delivered ? { deliveredText: body } : {}) };
    }

    const state = this.stateFor(input.routeKey);
    const normalized = normalizeCommentaryText(body);
    if (this.hasRecent(state, normalized)) return { text: body, delivered: false };
    this.rememberRecent(state, normalized);
    this.recordObservedCommentary(input.target, body);

    const now = this.now();
    if (!state.pending && (state.lastSentAt === undefined || now - state.lastSentAt >= this.minIntervalMs)) {
      const deliveredText = await this.sendNow(input.routeKey, input.target, [body], now);
      return { text: body, delivered: Boolean(deliveredText), ...(deliveredText ? { deliveredText } : {}) };
    }

    state.pending = mergePending(state.pending, input.target, body);
    const due = await this.flushIfDue(input.routeKey, state);
    if (due.delivered) return { text: body, delivered: true, ...(due.deliveredText ? { deliveredText: due.deliveredText } : {}) };
    this.scheduleFlush(input.routeKey, state);
    return { text: body, delivered: false };
  }

  async flushRoute(routeKey: string): Promise<CommentaryFlushResult> {
    const state = this.routes.get(routeKey);
    const pending = state?.pending;
    if (!state || !pending) return { delivered: false };
    state.pending = undefined;
    clearFlushTimer(state);
    const deliveredText = await this.sendNow(routeKey, pending.target, pending.texts, this.now());
    return { delivered: Boolean(deliveredText), ...(deliveredText ? { deliveredText } : {}) };
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
    const next: RouteCommentaryState = { recent: [] };
    this.routes.set(routeKey, next);
    return next;
  }

  private async sendNow(routeKey: string, target: ChannelTarget, texts: string[], sentAt: number): Promise<string | undefined> {
    const state = this.stateFor(routeKey);
    state.lastSentAt = sentAt;
    const text = this.formatCommentary(texts);
    return await this.delivery.sendCommentaryText(routeKey, target, text) ? text : undefined;
  }

  private async flushIfDue(routeKey: string, state: RouteCommentaryState): Promise<CommentaryFlushResult> {
    const pending = state.pending;
    if (!pending) return { delivered: false };
    const now = this.now();
    if (state.lastSentAt !== undefined && now - state.lastSentAt < this.minIntervalMs) return { delivered: false };
    state.pending = undefined;
    clearFlushTimer(state);
    const deliveredText = await this.sendNow(routeKey, pending.target, pending.texts, now);
    return { delivered: Boolean(deliveredText), ...(deliveredText ? { deliveredText } : {}) };
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

  private formatCommentary(texts: string[]): string {
    const body = texts
      .map((text) => text.trim())
      .filter(Boolean)
      .join("\n\n");
    return truncateForChannel(body, this.maxCommentaryChars);
  }

  private hasRecent(state: RouteCommentaryState, normalized: string): boolean {
    return state.recent.includes(normalized);
  }

  private rememberRecent(state: RouteCommentaryState, normalized: string): void {
    state.recent.push(normalized);
    if (state.recent.length > MAX_RECENT_TEXTS) state.recent.shift();
  }
}

function mergePending(pending: PendingCommentary | undefined, target: ChannelTarget, text: string): PendingCommentary {
  const texts = [...(pending?.texts ?? []), text].slice(-MAX_PENDING_TEXTS);
  return { target, texts };
}

function normalizeCommentaryText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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
