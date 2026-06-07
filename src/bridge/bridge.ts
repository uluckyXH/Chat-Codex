import { ApprovalManager } from "../approvals/approval-manager.js";
import type { ApprovalDecision } from "../approvals/types.js";
import type { CodexRunPolicyStatus } from "../codex/codex-cli.js";
import type { CodexAdapter, CodexCollaborationMode, CodexProgressKind, CodexPromptInput } from "../codex/types.js";
import { parseCommand } from "../commands/parser.js";
import { GroupAccessService } from "../group-access/service.js";
import type { Logger } from "../logging/logger.js";
import { SilentLogger } from "../logging/logger.js";
import type { TranscriptSink } from "../logging/transcript.js";
import { ChannelRegistry, createSingleChannelRegistry } from "../channels/registry.js";
import { FeishuGroupMemberRegistry } from "../channels/feishu/group/group-member-registry.js";
import type { ChannelAdapter, ChannelMessage, ChannelTarget } from "../protocol/channel.js";
import { replyTargetFromMessage } from "../protocol/channel.js";
import type { ChannelDeliveryPolicy } from "../protocol/delivery-policy.js";
import { DEFAULT_CHANNEL_DELIVERY_POLICY, normalizeChannelDeliveryPolicy } from "../protocol/delivery-policy.js";
import { MemoryStateStore } from "../state/memory-state-store.js";
import type { SessionBindings } from "../state/session-bindings.js";
import {
  PendingMediaManager,
  PENDING_MEDIA_MAX_ATTACHMENTS,
  classifyInboundAttachments,
  codexInputFromTextAndAttachments,
  inboundMediaSaveFailedText,
  inboundMediaUnsupportedText,
  inboundMediaTurnOverflowText,
  pendingMediaOverflowText,
  pendingMediaPromptText,
} from "./inbound-media.js";
import type { TurnScheduler } from "./turn-scheduler.js";
import { UnlimitedTurnScheduler } from "./turn-scheduler.js";
import { BridgeBackgroundTurns } from "./background-turns.js";
import { BridgeCommandRouter } from "./command-router.js";
import { SessionContextRefreshManager } from "./context-refresh.js";
import { BridgeDelivery } from "./delivery.js";
import { BridgeProgressDelivery } from "./progress-delivery.js";
import { BridgeNotificationDelivery } from "./notification-delivery.js";
import { BridgeRouteQueue } from "./route-queue.js";
import { BridgeRouteSteering } from "./route-steering.js";
import { RouteTrustGate } from "./route-trust-gate.js";
import { BridgeSessionFlow } from "./session-flow.js";
import { BridgeStatusText } from "./status-text.js";
import { handleApprovalCommand } from "./commands/approval-command.js";
import { handleCancelCommand } from "./commands/cancel-command.js";
import { handleCollaborationModeCommand } from "./commands/collaboration-command.js";
import { handleCompactCommand } from "./commands/compact-command.js";
import { handleContextRefreshCommand } from "./commands/context-refresh-command.js";
import { handleGoalCommand } from "./commands/goal-command.js";
import {
  feishuGroupMemberRefFromMessage,
  feishuGroupRegistrationRequiredText,
  formatFeishuGroupWhoami,
  handleGroupNameCommand,
  isFeishuGroupMessage,
  isFeishuGroupPreTrustCommand,
  isFeishuGroupRegistrationFreeCommand,
} from "./commands/group-name-command.js";
import { handleGroupReceiveCommand } from "./commands/group-receive-command.js";
import { handleModelCommand } from "./commands/model-command.js";
import { handleNewSessionCommand } from "./commands/new-command.js";
import { handlePermissionCommand } from "./commands/permission-command.js";
import { handleProgressModeCommand } from "./commands/progress-command.js";
import { handleSendFileCommand } from "./commands/sendfile-command.js";
import { handleStopCommand } from "./commands/stop-command.js";
import type {
  BridgeOptions,
  CompactState,
  ProgressDeliveryMode,
} from "./bridge-types.js";
import {
  APPROVAL_SEND_RETRY_DELAY_MS,
  COMPACT_RUNNING_MESSAGE_REJECT_TEXT,
  COMPACT_RUNNING_REJECT_TEXT,
  STEER_BATCH_MAX_CHARS,
  STEER_BATCH_MAX_MESSAGES,
  STEER_DEBOUNCE_MS,
} from "./bridge-types.js";
import {
  inboundAttachmentTranscriptText,
  sleep,
  withGroupConversationPromptPrefix,
} from "./formatters.js";

export type { BridgeOptions, InitialRouteBinding, ProgressDeliveryMode, UnboundRoutePolicy } from "./bridge-types.js";
export { parseProgressDeliveryMode } from "./formatters.js";

export class Bridge {
  private readonly channels: ChannelRegistry;
  private readonly codex: CodexAdapter;
  private readonly state: MemoryStateStore;
  private readonly approvals: ApprovalManager;
  private readonly turnScheduler: TurnScheduler;
  private readonly logger: Logger;
  private readonly transcript?: TranscriptSink;
  private readonly delivery: BridgeDelivery;
  private readonly progressDelivery: BridgeProgressDelivery;
  private readonly notificationDelivery: BridgeNotificationDelivery;
  private readonly routeTrustGate: RouteTrustGate;
  private readonly contextRefresh: SessionContextRefreshManager;
  private readonly backgroundTurns: BridgeBackgroundTurns;
  private readonly routeQueue: BridgeRouteQueue;
  private readonly routeSteering: BridgeRouteSteering;
  private readonly sessionFlow: BridgeSessionFlow;
  private readonly statusTextRenderer: BridgeStatusText;
  private readonly commandRouter: BridgeCommandRouter;
  private readonly feishuGroupMembers: FeishuGroupMemberRegistry;
  private readonly groupAccess: GroupAccessService;
  private readonly cwd: string;
  private readonly defaultProgressMode: ProgressDeliveryMode;
  private readonly routeProgressModes = new Map<string, ProgressDeliveryMode>();
  private readonly routeCollaborationModes = new Map<string, CodexCollaborationMode>();
  private readonly routeCompactStates = new Map<string, CompactState>();
  private readonly routeMessages = new Map<string, ChannelMessage>();
  private readonly routeTargets = new Map<string, ChannelTarget>();
  private readonly pendingMedia = new PendingMediaManager();
  private stopBackgroundEvents?: () => void;

  constructor(options: BridgeOptions) {
    if (Boolean(options.channel) === Boolean(options.channels)) {
      throw new Error("Bridge requires exactly one of channel or channels");
    }
    if (options.state && options.sessionBindings && options.state.sessionBindings !== options.sessionBindings) {
      throw new Error("Bridge state and sessionBindings must share the same SessionBindings instance");
    }
    this.codex = options.codex;
    this.state = options.state ?? new MemoryStateStore(options.sessionBindings);
    this.approvals = options.approvals ?? new ApprovalManager();
    this.logger = options.logger ?? new SilentLogger();
    this.channels = options.channels ?? createSingleChannelRegistry(options.channel as ChannelAdapter, this.logger);
    this.turnScheduler = options.turnScheduler ?? new UnlimitedTurnScheduler();
    this.transcript = options.transcript;
    this.cwd = options.cwd ?? process.cwd();
    this.feishuGroupMembers = new FeishuGroupMemberRegistry({
      stateRootDir: options.feishuGroupMemberStateRootDir,
      cwd: this.cwd,
    });
    this.groupAccess = new GroupAccessService({ state: this.state });
    this.delivery = new BridgeDelivery({
      channels: this.channels,
      approvals: this.approvals,
      logger: this.logger,
      transcript: this.transcript,
      approvalSendRetryDelayMs: options.approvalSendRetryDelayMs ?? APPROVAL_SEND_RETRY_DELAY_MS,
    });
    this.routeTrustGate = new RouteTrustGate({
      state: this.state,
      delivery: this.delivery,
      logger: this.logger,
      transcript: this.transcript,
      mode: options.routeTrustMode,
      pairingCodes: options.pairingCodeManager,
      onRouteTrusted: (record) => {
        this.groupAccess.ensureForTrustedRoute(record);
      },
    });
    this.contextRefresh = new SessionContextRefreshManager({
      state: this.state,
      codex: this.codex,
      logger: this.logger,
      defaultPolicy: options.contextRefresh?.defaultPolicy,
      readFingerprint: options.contextRefresh?.readFingerprint,
    });
    this.progressDelivery = new BridgeProgressDelivery({
      delivery: this.delivery,
      transcript: this.transcript,
      shouldDeliverProgress: (policy, routeKey, kind) => this.shouldDeliverProgressWithPolicy(policy, routeKey, kind),
    });
    this.notificationDelivery = new BridgeNotificationDelivery({
      state: this.state,
      delivery: this.delivery,
    });
    this.sessionFlow = new BridgeSessionFlow({
      codex: this.codex,
      state: this.state,
      delivery: this.delivery,
      cwd: this.cwd,
      initialRouteBinding: options.initialRouteBinding
        ?? (options.initialSessionId ? { type: "existing", sessionId: options.initialSessionId } : undefined),
      unboundRoutePolicy: options.unboundRoutePolicy ?? "auto_new",
      isRouteExecutionBusy: (routeKey) => this.isRouteExecutionBusy(routeKey),
      applyStoredSessionRunPolicy: (sessionId) => this.applyStoredSessionRunPolicy(sessionId),
      collaborationModeForRoute: (routeKey, sessionId) => this.collaborationModeForRoute(routeKey, sessionId),
      hasRouteCollaborationMode: (routeKey) => this.routeCollaborationModes.has(routeKey),
      applyRouteCollaborationModeToSession: (routeKey, sessionId) => this.applyRouteCollaborationModeToSession(routeKey, sessionId),
      syncRouteCollaborationModeFromSession: (routeKey, sessionId) => this.syncRouteCollaborationModeFromSession(routeKey, sessionId),
      recordSessionContextSnapshot: (sessionId, observedBy) => this.contextRefresh.recordSnapshot(sessionId, observedBy),
    });
    this.routeQueue = new BridgeRouteQueue({
      codex: this.codex,
      state: this.state,
      approvals: this.approvals,
      turnScheduler: this.turnScheduler,
      transcript: this.transcript,
      delivery: this.delivery,
      sessionFlow: this.sessionFlow,
      hasBackgroundTurnForRoute: (routeKey) => this.backgroundTurns.hasForRoute(routeKey),
      currentCollaborationMode: (routeKey) => this.routeCollaborationModes.get(routeKey),
      deliveryPolicyFor: (message) => this.deliveryPolicyFor(message),
      shouldDeliverProgressWithPolicy: (policy, routeKey, kind) => this.shouldDeliverProgressWithPolicy(policy, routeKey, kind),
      progressDelivery: this.progressDelivery,
      notificationDelivery: this.notificationDelivery,
      contextRefresh: this.contextRefresh,
    });
    this.backgroundTurns = new BridgeBackgroundTurns({
      state: this.state,
      approvals: this.approvals,
      logger: this.logger,
      transcript: this.transcript,
      delivery: this.delivery,
      routeMessages: this.routeMessages,
      routeTargets: this.routeTargets,
      deliveryPolicyFor: (message) => this.deliveryPolicyFor(message),
      shouldDeliverProgressWithPolicy: (policy, routeKey, kind) => this.shouldDeliverProgressWithPolicy(policy, routeKey, kind),
      progressDelivery: this.progressDelivery,
      notificationDelivery: this.notificationDelivery,
      startRouteWorker: (routeKey) => this.routeQueue.startRouteWorker(routeKey),
      routeQueueLength: (routeKey) => this.routeQueue.queueLength(routeKey),
      hasRouteWorker: (routeKey) => this.routeQueue.hasWorker(routeKey),
    });
    this.routeSteering = new BridgeRouteSteering({
      codex: this.codex,
      state: this.state,
      logger: this.logger,
      delivery: this.delivery,
      debounceMs: Math.max(0, options.steerDebounceMs ?? STEER_DEBOUNCE_MS),
      batchMaxMessages: Math.max(1, Math.floor(options.steerBatchMaxMessages ?? STEER_BATCH_MAX_MESSAGES)),
      batchMaxChars: Math.max(1, Math.floor(options.steerBatchMaxChars ?? STEER_BATCH_MAX_CHARS)),
      isRouteBusy: (routeKey) => this.routeQueue.isRouteBusy(routeKey),
      enqueuePromptFallback: (items) => this.routeQueue.enqueuePromptFallback(items),
    });
    this.statusTextRenderer = new BridgeStatusText({
      channels: this.channels,
      codex: this.codex,
      state: this.state,
      approvals: this.approvals,
      routeQueueLength: (routeKey) => this.routeQueue.queueLength(routeKey),
      deliveryPolicyFor: (message) => this.deliveryPolicyFor(message),
      shouldConsumePendingInitialRouteBinding: (message) => this.sessionFlow.shouldConsumePendingInitialRouteBinding(message),
      pendingInitialRouteBinding: () => this.sessionFlow.pendingInitialBindingForStatus(),
      isRouteBusy: (routeKey) => this.routeQueue.isRouteBusy(routeKey),
      routeSteerPendingCount: (routeKey) => this.routeSteering.pendingCount(routeKey),
      pendingMediaCount: (routeKey) => this.pendingMedia.count(routeKey),
      compactStateForRoute: (routeKey) => this.compactStateForRoute(routeKey),
      collaborationModeForRoute: (routeKey, sessionId) => this.collaborationModeForRoute(routeKey, sessionId),
      progressModeFor: (routeKey) => this.progressModeFor(routeKey),
      contextRefreshFor: (routeKey) => this.contextRefresh.effectivePolicy(routeKey),
      runPolicyStatus: (sessionId) => this.runPolicyStatus(sessionId),
    });
    this.commandRouter = new BridgeCommandRouter({
      logger: this.logger,
      delivery: this.delivery,
      deliveryPolicyFor: (message) => this.deliveryPolicyFor(message),
      isRouteExecutionBusy: (routeKey) => this.isRouteExecutionBusy(routeKey),
      handlers: {
        help: (message) => this.statusTextRenderer.helpText(message),
        createNewSession: (message, target, args, rawText) => handleNewSessionCommand({
          sessionFlow: this.sessionFlow,
          routeQueue: this.routeQueue,
          routeSteering: this.routeSteering,
        }, message, target, args, rawText),
        status: (message) => this.statusTextRenderer.statusText(message),
        sessions: (message, args, commandName) => this.statusTextRenderer.sessionsText(message, args, commandName),
        resumeOrUseSession: (message, target, sessionRef) => this.sessionFlow.resumeOrUseSession(message, target, sessionRef),
        cancel: (message, target) => handleCancelCommand({
          sessionFlow: this.sessionFlow,
          pendingMedia: this.pendingMedia,
          delivery: this.delivery,
          cancelCompactConfirmation: (routeKey) => this.cancelCompactConfirmation(routeKey),
        }, message, target),
        whoami: (message) => isFeishuGroupMessage(message)
          ? formatFeishuGroupWhoami(message, this.feishuGroupMembers, this.state)
          : this.statusTextRenderer.whoamiText(message),
        debug: (message) => this.statusTextRenderer.debugText(message),
        collaborationMode: (message, target, mode, rawText, commandName) => handleCollaborationModeCommand({
          codex: this.codex,
          delivery: this.delivery,
          routeQueue: this.routeQueue,
          setRouteCollaborationMode: (routeKey, nextMode) => this.setRouteCollaborationMode(routeKey, nextMode),
        }, message, target, mode, rawText, commandName),
        goal: (message, target, rawText) => handleGoalCommand({
          codex: this.codex,
          state: this.state,
          delivery: this.delivery,
          sessionFlow: this.sessionFlow,
        }, message, target, rawText),
        progressMode: (message, target, rawMode) => handleProgressModeCommand({
          delivery: this.delivery,
          statusText: this.statusTextRenderer,
          setProgressMode: (routeKey, mode) => this.routeProgressModes.set(routeKey, mode),
        }, message, target, rawMode),
        contextRefresh: (message, target, rawMode) => handleContextRefreshCommand({
          state: this.state,
          delivery: this.delivery,
          statusText: this.statusTextRenderer,
        }, message, target, rawMode),
        groupReceive: (message, target, args, commandName) => handleGroupReceiveCommand({
          state: this.state,
          delivery: this.delivery,
          channelCapabilities: options.channelCapabilities,
        }, message, target, args, commandName),
        groupName: (message, target, args) => handleGroupNameCommand({
          state: this.state,
          delivery: this.delivery,
          registry: this.feishuGroupMembers,
        }, message, target, args),
        sendFile: (message, target, rawText) => handleSendFileCommand({
          delivery: this.delivery,
          routeQueue: this.routeQueue,
        }, message, target, rawText),
        model: (message, target, args) => handleModelCommand({
          codex: this.codex,
          state: this.state,
          delivery: this.delivery,
          routeQueue: this.routeQueue,
          statusText: this.statusTextRenderer,
        }, message, target, args),
        permission: (message, target, args) => handlePermissionCommand({
          codex: this.codex,
          state: this.state,
          delivery: this.delivery,
          routeQueue: this.routeQueue,
          statusText: this.statusTextRenderer,
          runPolicyStatus: (sessionId) => this.runPolicyStatus(sessionId),
        }, message, target, args),
        approval: (message, target, args, decision) => this.handleApprovalCommand(message, target, args, decision),
        stop: (message, target) => handleStopCommand({
          state: this.state,
          codex: this.codex,
          approvals: this.approvals,
          pendingMedia: this.pendingMedia,
          delivery: this.delivery,
          routeQueue: this.routeQueue,
          routeSteering: this.routeSteering,
        }, message, target),
        compact: (message, target, args) => handleCompactCommand({
          codex: this.codex,
          state: this.state,
          delivery: this.delivery,
          logger: this.logger,
          compactStateForRoute: (routeKey) => this.compactStateForRoute(routeKey),
          setCompactState: (routeKey, state) => this.setCompactState(routeKey, state),
          clearCompactState: (routeKey) => this.clearCompactState(routeKey),
          isRouteExecutionBusy: (routeKey) => this.isRouteExecutionBusyWithoutCompact(routeKey),
        }, message, target, args),
      },
    });
    this.defaultProgressMode = options.progressMode ?? "brief";
  }

  async start(): Promise<void> {
    this.stopBackgroundEvents = this.codex.onBackgroundEvent?.((event) => this.backgroundTurns.handle(event));
    this.channels.onMessage((message) => this.handleMessage(message));
    await this.channels.start();
    this.logger.info("bridge started", { channels: this.channels.ids().join(",") });
  }

  async stop(): Promise<void> {
    this.routeSteering.clearAll();
    this.pendingMedia.clearAll();
    this.progressDelivery.clearAll();
    this.stopBackgroundEvents?.();
    this.stopBackgroundEvents = undefined;
    await this.channels.stop();
    await this.codex.stop?.();
    this.logger.info("bridge stopped", { channels: this.channels.ids().join(",") });
  }

  async handleMessage(message: ChannelMessage): Promise<void> {
    message = this.enrichMessageFromRouteHistory(message);
    const text = message.text?.trim() ?? "";
    const command = text ? parseCommand(text) : undefined;
    const attachments = classifyInboundAttachments(message.attachments);
    const hasInboundMedia = attachments.usable.length > 0 || attachments.failed.length > 0 || attachments.unsupported.length > 0;
    if (!text && !hasInboundMedia) return;
    this.transcript?.inbound(message, text || inboundAttachmentTranscriptText(attachments.usable.length));
    const target = replyTargetFromMessage(message);
    if (command?.isCommand
      && isFeishuGroupMessage(message)
      && !this.state.isRouteTrusted(message.routeKey)
      && isFeishuGroupPreTrustCommand(command.name)) {
      await this.commandRouter.handle(message, target, command.name ?? "", command.args, text);
      return;
    }
    this.routeMessages.set(message.routeKey, message);
    this.routeTargets.set(message.routeKey, target);
    this.state.recordRouteMessage(message);
    const trust = await this.routeTrustGate.handle(message, target);
    if (trust.action === "handled") return;
    this.sessionFlow.claimPendingInitialRouteBindingRoute(message);
    if (isFeishuGroupMessage(message) && this.state.isRouteTrusted(message.routeKey)) {
      this.groupAccess.ensureForTrustedGroupMessage(message);
      if (this.groupAccess.isSenderBlocked(message)) return;
    }
    if (isFeishuGroupMessage(message)
      && !isFeishuGroupRegistrationFreeCommand(command?.name)
      && !this.isFeishuGroupMemberRegistered(message)) {
      await this.delivery.sendText(target, feishuGroupRegistrationRequiredText());
      return;
    }
    if (this.isCompactRunning(message.routeKey)) {
      if (command?.isCommand && isCommandAllowedDuringCompact(command.name ?? "")) {
        await this.commandRouter.handle(message, target, command.name ?? "", command.args, text);
        return;
      }
      await this.delivery.sendText(target, command?.isCommand ? COMPACT_RUNNING_REJECT_TEXT : COMPACT_RUNNING_MESSAGE_REJECT_TEXT);
      return;
    }
    if (command?.isCommand) {
      await this.commandRouter.handle(message, target, command.name ?? "", command.args, text);
      return;
    }
    this.clearCompactConfirmation(message.routeKey);
    if (attachments.failed.length > 0) {
      await this.delivery.sendText(target, inboundMediaSaveFailedText());
      if (attachments.usable.length === 0) return;
    }
    if (attachments.unsupported.length > 0 && attachments.usable.length === 0) {
      await this.delivery.sendText(target, inboundMediaUnsupportedText());
      return;
    }
    if (!text && attachments.usable.length > 0) {
      await this.addPendingMedia(message, target, attachments.usable);
      return;
    }
    if (this.sessionFlow.hasSessionSelection(message.routeKey)) {
      await this.sessionFlow.handleSessionSelectionReply(message, target, text);
      return;
    }
    if (this.sessionFlow.shouldAskBeforeBindingSession(message)) {
      await this.routeQueue.enqueuePrompt(message, target, text);
      return;
    }
    const inputAttachments = [...this.pendingMedia.consume(message.routeKey), ...attachments.usable];
    const acceptedAttachments = inputAttachments.slice(0, PENDING_MEDIA_MAX_ATTACHMENTS);
    const rejectedAttachments = inputAttachments.slice(PENDING_MEDIA_MAX_ATTACHMENTS);
    if (rejectedAttachments.length > 0) {
      await this.delivery.sendText(target, inboundMediaTurnOverflowText(rejectedAttachments.length));
    }
    const rawInput = acceptedAttachments.length > 0
      ? codexInputFromTextAndAttachments(text, acceptedAttachments)
      : text;
    const groupPrefixMode = message.conversation.kind === "group" && await this.isRouteExecutionBusyWithoutCompact(message.routeKey)
      ? "supplement"
      : "say";
    const input = withGroupConversationPromptPrefix(message, rawInput, groupPrefixMode);
    if (await this.routeSteering.tryEnqueue(message, target, input)) return;
    await this.routeQueue.enqueuePrompt(message, target, input);
  }

  private enrichMessageFromRouteHistory(message: ChannelMessage): ChannelMessage {
    if (isFeishuDirectMessage(message)) return withoutSenderDisplayName(message);
    if (isFeishuGroupMessage(message)) return this.withFeishuGroupMemberDisplayName(message);
    if (message.sender.displayName) return message;
    const route = this.state.getRouteRecord(message.routeKey);
    const displayName = route?.identity?.lastSenderDisplayName?.trim();
    if (!displayName) return message;
    const lastSenderId = route?.identity?.lastSenderId ?? route?.identity?.openId;
    if (lastSenderId && lastSenderId !== message.sender.id) return message;
    return {
      ...message,
      sender: {
        ...message.sender,
        displayName,
      },
    };
  }

  private withFeishuGroupMemberDisplayName(message: ChannelMessage): ChannelMessage {
    const ref = feishuGroupMemberRefFromMessage(message);
    const displayName = ref ? this.feishuGroupMembers.getMember(ref)?.displayName : undefined;
    if (!displayName) return withoutSenderDisplayName(message);
    return {
      ...message,
      sender: {
        ...message.sender,
        displayName,
      },
    };
  }

  private isFeishuGroupMemberRegistered(message: ChannelMessage): boolean {
    const ref = feishuGroupMemberRefFromMessage(message);
    return Boolean(ref && this.feishuGroupMembers.hasMember(ref));
  }

  private async handleApprovalCommand(
    message: ChannelMessage,
    target: ChannelTarget,
    args: string[],
    decision: ApprovalDecision,
  ): Promise<void> {
    if (isFeishuGroupMessage(message) && this.state.isRouteTrusted(message.routeKey)) {
      const approval = this.groupAccess.canApprove(message);
      if (!approval.allowed) {
        if (approval.reason === "blocked") return;
        await this.delivery.sendText(target, groupApprovalDeniedText(approval.reason));
        return;
      }
    }
    await handleApprovalCommand({
      approvals: this.approvals,
      codex: this.codex,
      delivery: this.delivery,
    }, message, target, args, decision);
  }

  async waitForIdle(): Promise<void> {
    while (this.routeQueue.workerCount() > 0 || this.backgroundTurns.size > 0 || this.routeSteering.hasPendingWork()) {
      if (this.routeQueue.workerCount() > 0) {
        await this.routeQueue.waitForWorkers();
      }
      if (this.backgroundTurns.size > 0 || this.routeSteering.hasPendingWork()) {
        await sleep(10);
      }
    }
  }

  private async addPendingMedia(
    message: ChannelMessage,
    target: ChannelTarget,
    attachments: ChannelMessage["attachments"],
  ): Promise<void> {
    const result = this.pendingMedia.add(message.routeKey, attachments ?? [], message.id);
    if (result.accepted.length > 0) {
      await this.delivery.sendText(target, pendingMediaPromptText(result.total));
    }
    if (result.rejected.length > 0) {
      await this.delivery.sendText(target, pendingMediaOverflowText(result.rejected.length, result.total));
    }
  }

  private async isRouteExecutionBusy(routeKey: string): Promise<boolean> {
    if (this.isCompactRunning(routeKey)) return true;
    return this.isRouteExecutionBusyWithoutCompact(routeKey);
  }

  private async isRouteExecutionBusyWithoutCompact(routeKey: string): Promise<boolean> {
    if (this.routeQueue.hasWorker(routeKey) || this.backgroundTurns.hasForRoute(routeKey)) return true;
    if (this.routeQueue.queueLength(routeKey) > 0) return true;
    if (this.routeSteering.hasPendingWorkForRoute(routeKey)) return true;
    if (this.approvals.list(routeKey).length > 0) return true;
    const binding = this.state.getBinding(routeKey);
    if (!binding) return false;
    try {
      const status = await this.codex.getStatus(binding.sessionId);
      return status.type === "running" || status.type === "waiting_approval";
    } catch {
      return false;
    }
  }

  private compactStateForRoute(routeKey: string): CompactState {
    return this.routeCompactStates.get(routeKey) ?? { type: "none" };
  }

  private setCompactState(routeKey: string, state: CompactState): void {
    if (state.type === "none") {
      this.routeCompactStates.delete(routeKey);
      return;
    }
    this.routeCompactStates.set(routeKey, state);
  }

  private clearCompactState(routeKey: string): void {
    this.routeCompactStates.delete(routeKey);
  }

  private clearCompactConfirmation(routeKey: string): void {
    if (this.compactStateForRoute(routeKey).type === "confirming") {
      this.routeCompactStates.delete(routeKey);
    }
  }

  private cancelCompactConfirmation(routeKey: string): boolean {
    if (this.compactStateForRoute(routeKey).type !== "confirming") return false;
    this.routeCompactStates.delete(routeKey);
    return true;
  }

  private isCompactRunning(routeKey: string): boolean {
    return this.compactStateForRoute(routeKey).type === "running";
  }

  private progressModeFor(routeKey: string): ProgressDeliveryMode {
    return this.routeProgressModes.get(routeKey) ?? this.defaultProgressMode;
  }

  private collaborationModeForRoute(routeKey: string, sessionId?: string): CodexCollaborationMode {
    return this.routeCollaborationModes.get(routeKey) ?? this.codex.getCollaborationMode?.(sessionId) ?? "default";
  }

  private setRouteCollaborationMode(routeKey: string, mode: CodexCollaborationMode): void {
    this.routeCollaborationModes.set(routeKey, mode);
    const binding = this.state.getBinding(routeKey);
    if (binding) this.codex.setCollaborationMode?.(mode, binding.sessionId);
  }

  private applyRouteCollaborationModeToSession(routeKey: string, sessionId: string): void {
    const mode = this.routeCollaborationModes.get(routeKey);
    if (mode) this.codex.setCollaborationMode?.(mode, sessionId);
  }

  private syncRouteCollaborationModeFromSession(routeKey: string, sessionId: string): CodexCollaborationMode {
    const mode = this.codex.getCollaborationMode?.(sessionId) ?? "default";
    if (mode === "default") {
      this.routeCollaborationModes.delete(routeKey);
    } else {
      this.routeCollaborationModes.set(routeKey, mode);
    }
    return mode;
  }

  private deliveryPolicyFor(message: ChannelMessage | undefined): ChannelDeliveryPolicy {
    return normalizeChannelDeliveryPolicy(message ? this.channels.getDeliveryPolicy(message) : DEFAULT_CHANNEL_DELIVERY_POLICY);
  }

  private shouldDeliverProgressWithPolicy(
    policy: ChannelDeliveryPolicy,
    routeKey: string,
    kind: CodexProgressKind | undefined,
  ): boolean {
    if (policy.progress === "suppress") return false;
    return this.statusTextRenderer.shouldDeliverProgress(routeKey, kind);
  }

  private runPolicyStatus(sessionId?: string): CodexRunPolicyStatus | undefined {
    if (sessionId) this.applyStoredSessionRunPolicy(sessionId);
    return this.codex.getRunPolicyStatus?.(sessionId);
  }

  private applyStoredSessionRunPolicy(sessionId: string): void {
    const policy = this.state.getSessionRunPolicy(sessionId);
    if (policy) this.codex.setRunPolicy?.(policy, sessionId);
  }
}

function isFeishuDirectMessage(message: ChannelMessage): boolean {
  return message.conversation.kind === "direct"
    && (message.channelId === "feishu"
      || message.channelId.startsWith("feishu-")
      || message.channelId === "lark"
      || message.channelId.startsWith("lark-"));
}

function withoutSenderDisplayName(message: ChannelMessage): ChannelMessage {
  if (!message.sender.displayName) return message;
  const { displayName: _displayName, ...sender } = message.sender;
  return { ...message, sender };
}

function isCommandAllowedDuringCompact(name: string): boolean {
  return name === "status" || name === "help" || name === "whoami" || name === "debug";
}

function groupApprovalDeniedText(reason: string | undefined): string {
  if (reason === "missing_super_admin") return "当前群还没有超级管理员，暂不能处理 Codex 审批。请在本机 TUI 设置超级管理员。";
  if (reason === "missing_group_access") return "当前群权限记录还没有初始化，暂不能处理 Codex 审批。请重新完成群配对。";
  return "当前群默认只允许超级管理员处理 Codex 审批。";
}
