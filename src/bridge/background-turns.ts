import type { ApprovalManager } from "../approvals/approval-manager.js";
import { randomUUID } from "node:crypto";
import type { CodexEvent, CodexProgressKind, CodexSessionStatus } from "../codex/types.js";
import type { Logger } from "../logging/logger.js";
import type { TranscriptSink } from "../logging/transcript.js";
import type { ChannelMessage, ChannelTarget } from "../protocol/channel.js";
import type { ChannelDeliveryPolicy } from "../protocol/delivery-policy.js";
import type { MemoryStateStore } from "../state/memory-state-store.js";
import type { BackgroundTurnState } from "./bridge-types.js";
import { composeFinalAnswer } from "./formatters.js";
import type { BridgeDelivery } from "./delivery.js";
import { BridgeProgressDelivery } from "./progress-delivery.js";
import { BridgeCommentaryDelivery } from "./commentary-delivery.js";
import { BridgeNotificationDelivery } from "./notification-delivery.js";
import { BridgePendingInputManager } from "./pending-input.js";

export interface BridgeBackgroundTurnsOptions {
  state: MemoryStateStore;
  approvals: ApprovalManager;
  logger: Logger;
  transcript?: TranscriptSink;
  delivery: BridgeDelivery;
  routeMessages: Map<string, ChannelMessage>;
  routeTargets: Map<string, ChannelTarget>;
  deliveryPolicyFor(message: ChannelMessage | undefined): ChannelDeliveryPolicy;
  shouldDeliverProgressWithPolicy(
    policy: ChannelDeliveryPolicy,
    routeKey: string,
    kind: CodexProgressKind | undefined,
  ): boolean;
  shouldDeliverCommentaryWithPolicy(policy: ChannelDeliveryPolicy, routeKey: string): boolean;
  isRealtimeCommentaryWithPolicy(policy: ChannelDeliveryPolicy, routeKey: string): boolean;
  shouldDeliverToolProgressWithPolicy(policy: ChannelDeliveryPolicy, routeKey: string): boolean;
  progressDelivery?: BridgeProgressDelivery;
  commentaryDelivery?: BridgeCommentaryDelivery;
  notificationDelivery?: BridgeNotificationDelivery;
  pendingInput?: BridgePendingInputManager;
  startRouteWorker(routeKey: string): void;
  routeQueueLength(routeKey: string): number;
  hasRouteWorker(routeKey: string): boolean;
}

export class BridgeBackgroundTurns {
  private readonly state: MemoryStateStore;
  private readonly approvals: ApprovalManager;
  private readonly logger: Logger;
  private readonly transcript?: TranscriptSink;
  private readonly delivery: BridgeDelivery;
  private readonly routeMessages: Map<string, ChannelMessage>;
  private readonly routeTargets: Map<string, ChannelTarget>;
  private readonly deliveryPolicyFor: BridgeBackgroundTurnsOptions["deliveryPolicyFor"];
  private readonly progressDelivery: BridgeProgressDelivery;
  private readonly commentaryDelivery: BridgeCommentaryDelivery;
  private readonly shouldDeliverToolProgressWithPolicy: BridgeBackgroundTurnsOptions["shouldDeliverToolProgressWithPolicy"];
  private readonly notificationDelivery: BridgeNotificationDelivery;
  private readonly pendingInput?: BridgePendingInputManager;
  private readonly startRouteWorker: BridgeBackgroundTurnsOptions["startRouteWorker"];
  private readonly routeQueueLength: BridgeBackgroundTurnsOptions["routeQueueLength"];
  private readonly hasRouteWorker: BridgeBackgroundTurnsOptions["hasRouteWorker"];
  private readonly turns = new Map<string, BackgroundTurnState>();

  constructor(options: BridgeBackgroundTurnsOptions) {
    this.state = options.state;
    this.approvals = options.approvals;
    this.logger = options.logger;
    this.transcript = options.transcript;
    this.delivery = options.delivery;
    this.routeMessages = options.routeMessages;
    this.routeTargets = options.routeTargets;
    this.deliveryPolicyFor = options.deliveryPolicyFor;
    this.progressDelivery = options.progressDelivery ?? new BridgeProgressDelivery({
      delivery: this.delivery,
      transcript: this.transcript,
      shouldDeliverProgress: options.shouldDeliverProgressWithPolicy,
    });
    this.commentaryDelivery = options.commentaryDelivery ?? new BridgeCommentaryDelivery({
      delivery: this.delivery,
      transcript: this.transcript,
      shouldDeliverCommentary: options.shouldDeliverCommentaryWithPolicy,
      isRealtimeCommentary: options.isRealtimeCommentaryWithPolicy,
    });
    this.shouldDeliverToolProgressWithPolicy = options.shouldDeliverToolProgressWithPolicy;
    this.notificationDelivery = options.notificationDelivery ?? new BridgeNotificationDelivery({
      state: this.state,
      delivery: this.delivery,
    });
    this.pendingInput = options.pendingInput;
    this.startRouteWorker = options.startRouteWorker;
    this.routeQueueLength = options.routeQueueLength;
    this.hasRouteWorker = options.hasRouteWorker;
  }

  get size(): number {
    return this.turns.size;
  }

  hasForRoute(routeKey: string): boolean {
    return [...this.turns.values()].some((turn) => turn.routeKey === routeKey);
  }

  async handle(event: CodexEvent): Promise<void> {
    const existingState = this.turns.get(event.turnId);
    const state = existingState ?? this.createTurnState(event);
    if (!state) return;
    const deliveryPolicy = this.deliveryPolicyFor(state.message);
    if (event.type === "turn.started") {
      this.state.setSessionStatus(event.sessionId, {
        type: "running",
        turnId: event.turnId,
        task: "Goal 自动续跑",
        startedAt: event.startedAt ?? new Date().toISOString(),
      });
      this.startTypingKeepalive(state);
    } else if (event.type === "assistant.progress") {
      await this.progressDelivery.handleProgress({
        routeKey: state.routeKey,
        target: state.target,
        policy: deliveryPolicy,
        text: event.text,
        kind: event.kind,
      });
    } else if (event.type === "assistant.commentary") {
      state.lastCommentaryText = event.text;
      const result = await this.commentaryDelivery.handleCommentary({
        routeKey: state.routeKey,
        target: state.target,
        policy: deliveryPolicy,
        text: event.text,
      });
      if (result.deliveredText?.includes(event.text)) {
        state.lastDeliveredCommentaryText = event.text;
      }
    } else if (event.type === "tool.progress") {
      if (this.shouldDeliverToolProgressWithPolicy(deliveryPolicy, state.routeKey)) {
        await this.delivery.sendToolProgress(state.routeKey, state.target, {
          phase: event.progress.phase,
          toolName: event.progress.toolName,
          toolCallId: event.progress.itemId,
          status: event.progress.status,
        });
      }
    } else if (event.type === "codex.notification") {
      await this.notificationDelivery.deliver({
        routeKey: state.routeKey,
        target: state.target,
        event,
      });
      if (!existingState) this.turns.delete(event.turnId);
    } else if (event.type === "input.requested") {
      this.state.setSessionStatus(event.sessionId, {
        type: "waiting_input",
        detail: "Codex 等待用户输入",
        startedAt: currentStartedAt(this.state.getSession(event.sessionId)?.status),
      });
      await this.pendingInput?.start({
        routeKey: state.routeKey,
        target: state.target,
        message: state.message,
        request: event.request,
      });
    } else if (event.type === "input.resolved") {
      await this.pendingInput?.handleResolved(state.routeKey, event.adapterRequestId);
      this.state.setSessionStatus(event.sessionId, {
        type: "running",
        turnId: event.turnId,
        task: "Goal 自动续跑",
        startedAt: currentStartedAt(this.state.getSession(event.sessionId)?.status),
      });
    } else if (event.type === "assistant.plan") {
      state.finalPlanText = event.text;
    } else if (event.type === "assistant.delta") {
      state.finalText += event.text;
    } else if (event.type === "assistant.completed") {
      state.finalText = event.text;
    } else if (event.type === "approval.requested") {
      this.state.setSessionStatus(event.sessionId, {
        type: "waiting_approval",
        detail: event.approval.reason ?? event.approval.kind,
        startedAt: currentStartedAt(this.state.getSession(event.sessionId)?.status),
      });
      const pending = this.approvals.create(state.routeKey, state.message.sender.id, event.approval);
      await this.delivery.sendApprovalTextUntilDelivered(state.routeKey, state.target, pending);
    } else if (event.type === "approval.resolved") {
      this.approvals.resolveAdapterApproval(
        state.routeKey,
        event.adapterApprovalId,
        "Codex 已在 app-server 侧解决该请求。",
      );
      this.state.setSessionStatus(event.sessionId, {
        type: "running",
        turnId: event.turnId,
        task: "Goal 自动续跑",
        startedAt: currentStartedAt(this.state.getSession(event.sessionId)?.status),
      });
    } else if (event.type === "turn.completed") {
      if (!isTerminalLifecycleStatus(this.state.getSession(event.sessionId)?.status)) {
        this.state.setSessionStatus(event.sessionId, { type: "idle" });
      }
      await this.finishTurn(event.turnId, state);
    } else if (event.type === "turn.failed") {
      this.state.setSessionStatus(event.sessionId, { type: "failed", error: event.error });
      await this.progressDelivery.flushRoute(state.routeKey);
      await this.commentaryDelivery.flushRoute(state.routeKey);
      await this.delivery.sendText(state.target, `Codex 执行失败: ${event.error}`);
      await this.finishTurn(event.turnId, state, false);
    }
  }

  private createTurnState(event: CodexEvent): BackgroundTurnState | undefined {
    const owner = this.state.getSessionOwner(event.sessionId);
    const stored = this.state.getSession(event.sessionId);
    const routeKey = owner?.ownerRouteKey ?? stored?.ownerRouteKey ?? stored?.routeKey;
    const message = routeKey ? this.routeMessages.get(routeKey) : undefined;
    const target = routeKey ? this.routeTargets.get(routeKey) : undefined;
    if (!routeKey || !message || !target) {
      this.logger.warn("background codex event has no route target", {
        sessionId: event.sessionId,
        turnId: event.turnId,
        eventType: event.type,
      });
      return undefined;
    }
    const state: BackgroundTurnState = {
      routeKey,
      message,
      target: targetWithTurnRunId(target, event.turnId),
      finalText: "",
      finalPlanText: "",
      lastCommentaryText: "",
      lastDeliveredCommentaryText: "",
    };
    this.turns.set(event.turnId, state);
    return state;
  }

  private async finishTurn(turnId: string, state: BackgroundTurnState, sendFinal = true): Promise<void> {
    this.stopTypingKeepalive(state);
    await this.progressDelivery.flushRoute(state.routeKey);
    const commentaryFlush = await this.commentaryDelivery.flushRoute(state.routeKey);
    if (state.lastCommentaryText && commentaryFlush.deliveredText?.includes(state.lastCommentaryText)) {
      state.lastDeliveredCommentaryText = state.lastCommentaryText;
    }
    const composedFinalText = composeFinalAnswer(state.finalPlanText, state.finalText);
    if (sendFinal && composedFinalText) {
      await this.delivery.sendText(state.target, composedFinalText);
    } else if (sendFinal && state.lastCommentaryText && state.lastDeliveredCommentaryText !== state.lastCommentaryText) {
      await this.delivery.sendText(state.target, state.lastCommentaryText);
    }
    await this.delivery.sendTyping(state.target, false);
    this.progressDelivery.clearRoute(state.routeKey);
    this.commentaryDelivery.clearRoute(state.routeKey);
    this.turns.delete(turnId);
    if (this.routeQueueLength(state.routeKey) > 0 && !this.hasRouteWorker(state.routeKey)) {
      this.startRouteWorker(state.routeKey);
    }
  }

  private startTypingKeepalive(state: BackgroundTurnState): void {
    if (state.typingTimer) return;
    let stopped = false;
    const tick = async () => {
      await this.delivery.sendTyping(state.target, true);
      if (stopped) return;
      state.typingTimer = setTimeout(() => {
        void tick();
      }, 5000);
      state.typingTimer.unref?.();
    };
    state.stopTyping = () => {
      stopped = true;
      if (state.typingTimer) clearTimeout(state.typingTimer);
      state.typingTimer = undefined;
      state.stopTyping = undefined;
    };
    void tick();
  }

  private stopTypingKeepalive(state: BackgroundTurnState): void {
    state.stopTyping?.();
  }
}

function currentStartedAt(status: CodexSessionStatus | undefined): string | undefined {
  return status && "startedAt" in status ? status.startedAt : undefined;
}

function isTerminalLifecycleStatus(status: CodexSessionStatus | undefined): boolean {
  return status?.type === "unknown" && (status.detail === "thread archived" || status.detail === "thread closed");
}

function targetWithTurnRunId(target: ChannelTarget, turnId: string): ChannelTarget {
  if (!turnId || !isWeixinChannelId(target.channelId)) return target;
  return {
    ...target,
    context: {
      ...target.context,
      runId: randomUUID(),
    },
  };
}

function isWeixinChannelId(channelId: string): boolean {
  return channelId === "weixin" || channelId.startsWith("weixin-");
}
