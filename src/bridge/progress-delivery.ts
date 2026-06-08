import type { CodexProgressKind } from "../codex/types.js";
import type { TranscriptSink } from "../logging/transcript.js";
import type { ChannelTarget } from "../protocol/channel.js";
import type { ChannelDeliveryPolicy } from "../protocol/delivery-policy.js";
import type { BridgeDelivery } from "./delivery.js";
import { truncateForChannel } from "./formatters.js";

export interface BridgeProgressDeliveryOptions {
  delivery: BridgeDelivery;
  transcript?: TranscriptSink;
  minIntervalMs?: number;
  maxProgressChars?: number;
  now?: () => number;
  shouldDeliverProgress(
    policy: ChannelDeliveryPolicy,
    routeKey: string,
    kind: CodexProgressKind | undefined,
  ): boolean;
  isRealtimeProgress?(policy: ChannelDeliveryPolicy, routeKey: string): boolean;
}

export interface BridgeProgressInput {
  routeKey: string;
  target: ChannelTarget;
  policy: ChannelDeliveryPolicy;
  text: string;
  kind?: CodexProgressKind;
}

interface PendingProgress {
  target: ChannelTarget;
  texts: string[];
}

interface RouteProgressState {
  lastSentAt?: number;
  recent: string[];
  pending?: PendingProgress;
  flushTimer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_MIN_INTERVAL_MS = 3000;
const DEFAULT_MAX_PROGRESS_CHARS = 1200;
const MAX_PENDING_TEXTS = 3;
const MAX_RECENT_TEXTS = 20;

export class BridgeProgressDelivery {
  private readonly delivery: BridgeDelivery;
  private readonly transcript?: TranscriptSink;
  private readonly minIntervalMs: number;
  private readonly maxProgressChars: number;
  private readonly now: () => number;
  private readonly shouldDeliverProgress: BridgeProgressDeliveryOptions["shouldDeliverProgress"];
  private readonly isRealtimeProgress: NonNullable<BridgeProgressDeliveryOptions["isRealtimeProgress"]>;
  private readonly routes = new Map<string, RouteProgressState>();

  constructor(options: BridgeProgressDeliveryOptions) {
    this.delivery = options.delivery;
    this.transcript = options.transcript;
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
    this.maxProgressChars = Math.max(120, options.maxProgressChars ?? DEFAULT_MAX_PROGRESS_CHARS);
    this.now = options.now ?? (() => Date.now());
    this.shouldDeliverProgress = options.shouldDeliverProgress;
    this.isRealtimeProgress = options.isRealtimeProgress ?? (() => false);
  }

  async handleProgress(input: BridgeProgressInput): Promise<void> {
    const body = input.text.trim();
    if (!body) return;
    if (input.policy.progress === "suppress") {
      this.transcript?.localProgress?.(input.target, this.formatProgress([body]));
      return;
    }
    if (!this.shouldDeliverProgress(input.policy, input.routeKey, input.kind)) {
      this.transcript?.localProgress?.(input.target, this.formatProgress([body]));
      return;
    }

    if (this.isRealtimeProgress(input.policy, input.routeKey)) {
      this.recordObservedProgress(input.target, body);
      await this.delivery.sendRealtimeProgressText(input.routeKey, input.target, body);
      return;
    }

    const state = this.stateFor(input.routeKey);
    const normalized = normalizeProgressText(body);
    if (this.hasRecent(state, normalized)) return;
    this.rememberRecent(state, normalized);
    this.recordObservedProgress(input.target, body);

    const now = this.now();
    if (!state.pending && (state.lastSentAt === undefined || now - state.lastSentAt >= this.minIntervalMs)) {
      await this.sendNow(input.routeKey, input.target, [body], now);
      return;
    }

    state.pending = mergePending(state.pending, input.target, body);
    if (await this.flushIfDue(input.routeKey, state)) return;
    this.scheduleFlush(input.routeKey, state);
  }

  async flushRoute(routeKey: string): Promise<void> {
    const state = this.routes.get(routeKey);
    const pending = state?.pending;
    if (!state || !pending) return;
    state.pending = undefined;
    clearFlushTimer(state);
    await this.sendNow(routeKey, pending.target, pending.texts, this.now());
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

  private stateFor(routeKey: string): RouteProgressState {
    const existing = this.routes.get(routeKey);
    if (existing) return existing;
    const next: RouteProgressState = { recent: [] };
    this.routes.set(routeKey, next);
    return next;
  }

  private async sendNow(routeKey: string, target: ChannelTarget, texts: string[], sentAt: number): Promise<void> {
    const state = this.stateFor(routeKey);
    state.lastSentAt = sentAt;
    await this.delivery.sendProgressText(routeKey, target, this.formatProgress(texts));
  }

  private async flushIfDue(routeKey: string, state: RouteProgressState): Promise<boolean> {
    const pending = state.pending;
    if (!pending) return false;
    const now = this.now();
    if (state.lastSentAt !== undefined && now - state.lastSentAt < this.minIntervalMs) return false;
    state.pending = undefined;
    clearFlushTimer(state);
    await this.sendNow(routeKey, pending.target, pending.texts, now);
    return true;
  }

  private scheduleFlush(routeKey: string, state: RouteProgressState): void {
    if (!state.pending || state.flushTimer) return;
    const delay = progressFlushDelay(this.now(), state.lastSentAt, this.minIntervalMs);
    const timer = setTimeout(() => {
      const current = this.routes.get(routeKey);
      if (current) current.flushTimer = undefined;
      void this.flushRoute(routeKey);
    }, delay);
    state.flushTimer = timer;
    unrefTimer(timer);
  }

  private recordObservedProgress(target: ChannelTarget, text: string): void {
    if (this.transcript?.observedProgress) {
      this.transcript.observedProgress(target, text);
      return;
    }
    this.transcript?.localProgress?.(target, text);
  }

  private formatProgress(texts: string[]): string {
    const body = texts
      .map((text) => text.trim())
      .filter(Boolean)
      .join("\n\n");
    return truncateForChannel(body, this.maxProgressChars);
  }

  private hasRecent(state: RouteProgressState, normalized: string): boolean {
    return state.recent.includes(normalized);
  }

  private rememberRecent(state: RouteProgressState, normalized: string): void {
    state.recent.push(normalized);
    if (state.recent.length > MAX_RECENT_TEXTS) state.recent.shift();
  }
}

function mergePending(pending: PendingProgress | undefined, target: ChannelTarget, text: string): PendingProgress {
  const texts = [...(pending?.texts ?? []), text].slice(-MAX_PENDING_TEXTS);
  return { target, texts };
}

function normalizeProgressText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function progressFlushDelay(now: number, lastSentAt: number | undefined, minIntervalMs: number): number {
  if (lastSentAt === undefined) return 0;
  return Math.max(0, minIntervalMs - (now - lastSentAt));
}

function clearFlushTimer(state: RouteProgressState): void {
  if (!state.flushTimer) return;
  clearTimeout(state.flushTimer);
  state.flushTimer = undefined;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer !== "object" || timer === null || !("unref" in timer)) return;
  (timer as { unref?: () => void }).unref?.();
}
