import type { CodexAdapter, CodexPromptInput } from "../codex/types.js";
import { codexInputPlainText } from "../codex/input.js";
import type { Logger } from "../logging/logger.js";
import type { ChannelMessage, ChannelTarget } from "../protocol/channel.js";
import type { MemoryStateStore } from "../state/memory-state-store.js";
import type { QueuedSteer, RouteSteerState } from "./bridge-types.js";
import {
  composeSteerBatchInput,
  isSteerableStatus,
  steerAcceptedText,
} from "./formatters.js";
import type { BridgeDelivery } from "./delivery.js";

export interface BridgeRouteSteeringOptions {
  preparePrompt?(message: ChannelMessage, input: CodexPromptInput): CodexPromptInput | undefined;
  codex: CodexAdapter;
  state: MemoryStateStore;
  logger: Logger;
  delivery: BridgeDelivery;
  debounceMs: number;
  batchMaxMessages: number;
  batchMaxChars: number;
  isRouteBusy(routeKey: string): boolean;
  enqueuePromptFallback(items: QueuedSteer[]): Promise<void>;
}

export class BridgeRouteSteering {
  private readonly preparePrompt?: BridgeRouteSteeringOptions["preparePrompt"];
  private readonly codex: CodexAdapter;
  private readonly state: MemoryStateStore;
  private readonly logger: Logger;
  private readonly delivery: BridgeDelivery;
  private readonly debounceMs: number;
  private readonly batchMaxMessages: number;
  private readonly batchMaxChars: number;
  private readonly isRouteBusy: BridgeRouteSteeringOptions["isRouteBusy"];
  private readonly enqueuePromptFallback: BridgeRouteSteeringOptions["enqueuePromptFallback"];
  private readonly states = new Map<string, RouteSteerState>();

  constructor(options: BridgeRouteSteeringOptions) {
    this.codex = options.codex;
    this.preparePrompt = options.preparePrompt;
    this.state = options.state;
    this.logger = options.logger;
    this.delivery = options.delivery;
    this.debounceMs = options.debounceMs;
    this.batchMaxMessages = options.batchMaxMessages;
    this.batchMaxChars = options.batchMaxChars;
    this.isRouteBusy = options.isRouteBusy;
    this.enqueuePromptFallback = options.enqueuePromptFallback;
  }

  async tryEnqueue(
    message: ChannelMessage,
    target: ChannelTarget,
    prompt: CodexPromptInput,
  ): Promise<boolean> {
    if (!(await this.canAttempt(message.routeKey))) return false;
    const state = this.states.get(message.routeKey) ?? { queue: [], draining: false };
    state.queue.push({ message, target, input: prompt });
    this.states.set(message.routeKey, state);
    this.scheduleDrain(message.routeKey, state);
    return true;
  }

  pendingCount(routeKey: string): number {
    return this.states.get(routeKey)?.queue.length ?? 0;
  }

  hasPendingWork(): boolean {
    return [...this.states.keys()].some((routeKey) => this.hasPendingWorkForRoute(routeKey));
  }

  hasPendingWorkForRoute(routeKey: string): boolean {
    const state = this.states.get(routeKey);
    return Boolean(state && (state.draining || state.timer || state.queue.length > 0));
  }

  clearRouteState(routeKey: string): number {
    const state = this.states.get(routeKey);
    if (!state) return 0;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    const cleared = state.queue.length;
    state.queue.length = 0;
    if (!state.draining) this.states.delete(routeKey);
    return cleared;
  }

  clearAll(): void {
    for (const routeKey of [...this.states.keys()]) {
      this.clearRouteState(routeKey);
    }
  }

  private async canAttempt(routeKey: string): Promise<boolean> {
    if (!this.codex.steer) return false;
    if (!this.isRouteBusy(routeKey)) return false;
    const binding = this.state.getBinding(routeKey);
    if (!binding) return false;
    try {
      const status = await this.codex.getStatus(binding.sessionId);
      return isSteerableStatus(status.type);
    } catch (error) {
      this.logger.warn("failed to read route status before steer", {
        routeKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private scheduleDrain(routeKey: string, state: RouteSteerState): void {
    if (state.draining) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.drainQueue(routeKey);
    }, this.debounceMs);
    state.timer.unref?.();
  }

  private async drainQueue(routeKey: string): Promise<void> {
    const state = this.states.get(routeKey);
    if (!state || state.draining) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    state.draining = true;
    try {
      while (state.queue.length > 0) {
        const batch = this.takeBatch(state.queue);
        try {
          await this.sendBatch(routeKey, batch);
        } catch (error) {
          this.logger.warn("route steer failed; falling back to prompt queue", {
            routeKey,
            count: batch.length + state.queue.length,
            error: error instanceof Error ? error.message : String(error),
          });
          const fallbackItems = [...batch, ...state.queue.splice(0)];
          await this.enqueuePromptFallback(fallbackItems);
          break;
        }
      }
    } finally {
      state.draining = false;
      if (state.queue.length > 0) {
        this.scheduleDrain(routeKey, state);
      } else if (!state.timer) {
        this.states.delete(routeKey);
      }
    }
  }

  private takeBatch(queue: QueuedSteer[]): QueuedSteer[] {
    const batch: QueuedSteer[] = [];
    let chars = 0;
    while (queue.length > 0 && batch.length < this.batchMaxMessages) {
      const item = queue[0];
      if (!item) break;
      const nextChars = codexInputPlainText(item.input).length;
      if (batch.length > 0 && chars + nextChars > this.batchMaxChars) break;
      queue.shift();
      batch.push(item);
      chars += nextChars;
    }
    return batch;
  }

  private async sendBatch(routeKey: string, batch: QueuedSteer[]): Promise<void> {
    if (batch.length === 0) return;
    if (!(await this.canAttempt(routeKey))) {
      throw new Error("route no longer has an active steerable Codex turn");
    }
    const binding = this.state.getBinding(routeKey);
    const steer = this.codex.steer?.bind(this.codex);
    if (!binding || !steer) {
      throw new Error("Codex adapter does not support steer for this route");
    }
    batch = batch.flatMap((item) => {
      const input = this.preparePrompt ? this.preparePrompt(item.message, item.input) : item.input;
      return input === undefined ? [] : [{ ...item, input }];
    });
    if (!batch.length) return;
    await steer(binding.sessionId, composeSteerBatchInput(batch));
    await this.delivery.sendText(batch[batch.length - 1].target, steerAcceptedText(batch.length));
  }
}
