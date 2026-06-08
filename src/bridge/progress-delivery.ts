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
  private readonly routes = new Map<string, RouteProgressState>();

  constructor(options: BridgeProgressDeliveryOptions) {
    this.delivery = options.delivery;
    this.transcript = options.transcript;
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
    this.maxProgressChars = Math.max(120, options.maxProgressChars ?? DEFAULT_MAX_PROGRESS_CHARS);
    this.now = options.now ?? (() => Date.now());
    this.shouldDeliverProgress = options.shouldDeliverProgress;
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

    const state = this.stateFor(input.routeKey);
    const normalized = normalizeProgressText(body);
    if (this.hasRecent(state, normalized)) return;
    this.rememberRecent(state, normalized);

    const now = this.now();
    if (!state.pending && (state.lastSentAt === undefined || now - state.lastSentAt >= this.minIntervalMs)) {
      await this.sendNow(input.routeKey, input.target, [body], now);
      return;
    }

    state.pending = mergePending(state.pending, input.target, body);
  }

  async flushRoute(routeKey: string): Promise<void> {
    const state = this.routes.get(routeKey);
    const pending = state?.pending;
    if (!state || !pending) return;
    state.pending = undefined;
    await this.sendNow(routeKey, pending.target, pending.texts, this.now());
  }

  clearRoute(routeKey: string): void {
    this.routes.delete(routeKey);
  }

  clearAll(): void {
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
