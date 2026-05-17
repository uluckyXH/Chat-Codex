import type { ApprovalManager } from "../approvals/approval-manager.js";
import type { CodexAdapter, CodexCollaborationMode, CodexProgressKind, CodexPromptInput } from "../codex/types.js";
import { codexInputPlainText, codexInputText, withCodexInputText } from "../codex/input.js";
import type { TranscriptSink } from "../logging/transcript.js";
import type { ChannelMessage, ChannelTarget } from "../protocol/channel.js";
import type { ChannelDeliveryPolicy } from "../protocol/delivery-policy.js";
import type { MemoryStateStore } from "../state/memory-state-store.js";
import type { QueuedPrompt, QueuedSteer } from "./bridge-types.js";
import { stripBridgeSendFileRefs } from "./media-extractor.js";
import type { TurnScheduler } from "./turn-scheduler.js";
import { TurnSchedulerAbortError } from "./turn-scheduler.js";
import type { BridgeDelivery } from "./delivery.js";
import { BridgeProgressDelivery } from "./progress-delivery.js";
import type { BridgeSessionFlow } from "./session-flow.js";
import {
  composeFinalAnswer,
  truncateForChannel,
  withSendFileInstruction,
} from "./formatters.js";

export interface BridgeRouteQueueOptions {
  codex: CodexAdapter;
  state: MemoryStateStore;
  approvals: ApprovalManager;
  turnScheduler: TurnScheduler;
  transcript?: TranscriptSink;
  delivery: BridgeDelivery;
  sessionFlow: BridgeSessionFlow;
  hasBackgroundTurnForRoute(routeKey: string): boolean;
  currentCollaborationMode(routeKey: string): CodexCollaborationMode | undefined;
  deliveryPolicyFor(message: ChannelMessage | undefined): ChannelDeliveryPolicy;
  shouldDeliverProgressWithPolicy(
    policy: ChannelDeliveryPolicy,
    routeKey: string,
    kind: CodexProgressKind | undefined,
  ): boolean;
  progressDelivery?: BridgeProgressDelivery;
}

export class BridgeRouteQueue {
  private readonly codex: CodexAdapter;
  private readonly state: MemoryStateStore;
  private readonly approvals: ApprovalManager;
  private readonly turnScheduler: TurnScheduler;
  private readonly transcript?: TranscriptSink;
  private readonly delivery: BridgeDelivery;
  private readonly sessionFlow: BridgeSessionFlow;
  private readonly hasBackgroundTurnForRoute: BridgeRouteQueueOptions["hasBackgroundTurnForRoute"];
  private readonly currentCollaborationMode: BridgeRouteQueueOptions["currentCollaborationMode"];
  private readonly deliveryPolicyFor: BridgeRouteQueueOptions["deliveryPolicyFor"];
  private readonly progressDelivery: BridgeProgressDelivery;
  private readonly queues = new Map<string, QueuedPrompt[]>();
  private readonly workers = new Map<string, Promise<void>>();
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(options: BridgeRouteQueueOptions) {
    this.codex = options.codex;
    this.state = options.state;
    this.approvals = options.approvals;
    this.turnScheduler = options.turnScheduler;
    this.transcript = options.transcript;
    this.delivery = options.delivery;
    this.sessionFlow = options.sessionFlow;
    this.hasBackgroundTurnForRoute = options.hasBackgroundTurnForRoute;
    this.currentCollaborationMode = options.currentCollaborationMode;
    this.deliveryPolicyFor = options.deliveryPolicyFor;
    this.progressDelivery = options.progressDelivery ?? new BridgeProgressDelivery({
      delivery: this.delivery,
      transcript: this.transcript,
      shouldDeliverProgress: options.shouldDeliverProgressWithPolicy,
    });
  }

  async enqueuePrompt(
    message: ChannelMessage,
    target: ChannelTarget,
    prompt: CodexPromptInput,
    options?: { collaborationMode?: CodexCollaborationMode; sendFile?: boolean },
  ): Promise<void> {
    if (this.sessionFlow.shouldAskBeforeBindingSession(message)) {
      await this.delivery.sendText(target, this.sessionFlow.unboundRoutePromptText(message));
      return;
    }
    const queue = this.queues.get(message.routeKey) ?? [];
    const pendingAhead = queue.length + (this.isRouteBusy(message.routeKey) ? 1 : 0);
    queue.push({
      message,
      target,
      input: prompt,
      collaborationMode: options?.collaborationMode ?? this.currentCollaborationMode(message.routeKey),
      sendFile: options?.sendFile ?? false,
    });
    this.queues.set(message.routeKey, queue);
    if (pendingAhead > 0) {
      await this.delivery.sendText(target, `已加入队列，前面还有 ${pendingAhead} 条消息。`);
    }
    if (!this.workers.has(message.routeKey) && !this.hasBackgroundTurnForRoute(message.routeKey)) {
      this.startRouteWorker(message.routeKey);
    }
  }

  async enqueuePromptFallback(items: QueuedSteer[]): Promise<void> {
    for (const item of items) {
      await this.enqueuePrompt(item.message, item.target, item.input);
    }
  }

  startRouteWorker(routeKey: string): void {
    const worker = this.drainRouteQueue(routeKey).finally(() => {
      this.workers.delete(routeKey);
      if ((this.queues.get(routeKey)?.length ?? 0) > 0) {
        this.startRouteWorker(routeKey);
      } else {
        this.queues.delete(routeKey);
      }
    });
    this.workers.set(routeKey, worker);
  }

  isRouteBusy(routeKey: string): boolean {
    return this.workers.has(routeKey) || this.hasBackgroundTurnForRoute(routeKey);
  }

  hasWorker(routeKey: string): boolean {
    return this.workers.has(routeKey);
  }

  workerCount(): number {
    return this.workers.size;
  }

  queueLength(routeKey: string): number {
    return this.queues.get(routeKey)?.length ?? 0;
  }

  clearQueued(routeKey: string): number {
    const queued = this.queues.get(routeKey);
    const cleared = queued?.length ?? 0;
    if (queued) queued.length = 0;
    return cleared;
  }

  abortRoute(routeKey: string): void {
    this.abortControllers.get(routeKey)?.abort();
  }

  async waitForWorkers(): Promise<void> {
    if (this.workers.size > 0) {
      await Promise.all([...this.workers.values()]);
    }
  }

  private async drainRouteQueue(routeKey: string): Promise<void> {
    for (;;) {
      const queue = this.queues.get(routeKey);
      const task = queue?.shift();
      if (!task) return;
      try {
        await this.forwardPrompt(task.message, task.target, task.input, queue?.length ?? 0, task.sendFile, task.collaborationMode);
      } catch (error) {
        if (error instanceof TurnSchedulerAbortError) continue;
        await this.delivery.sendText(task.target, `Codex 执行失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async forwardPrompt(
    message: ChannelMessage,
    target: ChannelTarget,
    prompt: CodexPromptInput,
    remainingQueued: number,
    sendFile: boolean,
    collaborationMode: CodexCollaborationMode | undefined,
  ): Promise<void> {
    const session = await this.sessionFlow.ensureSession(message);
    const promptText = codexInputText(prompt);
    const abortController = new AbortController();
    this.abortControllers.set(message.routeKey, abortController);
    try {
      await this.turnScheduler.run({
        routeKey: message.routeKey,
        sessionId: session.id,
        enqueuedAt: new Date().toISOString(),
      }, async () => {
        const deliveryPolicy = this.deliveryPolicyFor(message);
        if (deliveryPolicy.taskStart === "send") {
          await this.delivery.sendText(target, [
            "Codex 正在处理这条消息。",
            "可发送 /status 查看状态，/stop 终止。",
            sendFile ? "本轮已启用 /sendfile，只会发送最终回复中明确声明的文件。" : undefined,
            remainingQueued > 0 ? `Queue: 后面还有 ${remainingQueued} 条` : undefined,
          ].filter(Boolean).join("\n"));
        }
        await this.delivery.withTyping(target, async () => {
          let finalText = "";
          let finalPlanText = "";
          let currentTurnStartedAt: string | undefined;
          const codexPrompt = sendFile
            ? typeof prompt === "string"
              ? withSendFileInstruction(prompt)
              : withCodexInputText(prompt, withSendFileInstruction(promptText))
            : prompt;
          for await (const event of this.codex.run(session.id, codexPrompt, collaborationMode ? { collaborationMode } : undefined)) {
            if (event.type === "turn.started") {
              currentTurnStartedAt = event.startedAt ?? new Date().toISOString();
              this.state.setSessionStatus(session.id, {
                type: "running",
                turnId: event.turnId,
                task: truncateForChannel(promptText || codexInputPlainText(prompt), 120),
                startedAt: currentTurnStartedAt,
              });
            } else if (event.type === "assistant.progress") {
              await this.progressDelivery.handleProgress({
                routeKey: message.routeKey,
                target,
                policy: deliveryPolicy,
                text: event.text,
                kind: event.kind,
              });
            } else if (event.type === "assistant.plan") {
              finalPlanText = event.text;
            } else if (event.type === "assistant.delta") {
              finalText += event.text;
            } else if (event.type === "assistant.completed") {
              finalText = event.text;
            } else if (event.type === "approval.requested") {
              this.state.setSessionStatus(session.id, {
                type: "waiting_approval",
                detail: event.approval.reason ?? event.approval.kind,
                startedAt: currentTurnStartedAt,
              });
              const pending = this.approvals.create(message.routeKey, message.sender.id, event.approval);
              await this.delivery.sendApprovalTextUntilDelivered(message.routeKey, target, pending);
            } else if (event.type === "turn.completed") {
              this.state.setSessionStatus(session.id, { type: "idle" });
            } else if (event.type === "turn.failed") {
              this.state.setSessionStatus(session.id, { type: "failed", error: event.error });
              await this.progressDelivery.flushRoute(message.routeKey);
              await this.delivery.sendText(target, `Codex 执行失败: ${event.error}`);
            }
          }
          await this.progressDelivery.flushRoute(message.routeKey);
          const composedFinalText = composeFinalAnswer(finalPlanText, finalText);
          if (composedFinalText) {
            const visibleText = sendFile ? stripBridgeSendFileRefs(composedFinalText) : composedFinalText;
            if (visibleText) await this.delivery.sendText(target, visibleText);
            if (sendFile) {
              await this.delivery.sendRequestedFiles(target, composedFinalText, session.cwd);
            }
          }
        });
      }, { signal: abortController.signal });
    } finally {
      await this.progressDelivery.flushRoute(message.routeKey);
      this.progressDelivery.clearRoute(message.routeKey);
      if (this.abortControllers.get(message.routeKey) === abortController) {
        this.abortControllers.delete(message.routeKey);
      }
    }
  }
}
