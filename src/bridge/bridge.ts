import type { FeishuGroupMessageRaw } from "../channels/feishu/group/group-types.js";
import { BridgeGroupController } from "./group-controller.js";
import { groupSenderRole } from "../group-access/policy.js";
import { withCodexInputText } from "../codex/input.js";
import { textWithQuotedMessage } from "./quoted-message.js";
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
import type {
  ChannelAdapter,
  ChannelApprovalAction,
  ChannelApprovalActionResult,
  ChannelMessage,
  ChannelTarget,
} from "../protocol/channel.js";
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
import { BridgeCommentaryDelivery } from "./commentary-delivery.js";
import { fallbackProgressModeForPolicy, isProgressModeAllowedByPolicy } from "./progress-modes.js";
import { BridgeNotificationDelivery } from "./notification-delivery.js";
import { BridgePendingInputManager } from "./pending-input.js";
import { BridgeRouteQueue } from "./route-queue.js";
import { BridgeRouteSteering } from "./route-steering.js";
import { RouteTrustGate } from "./route-trust-gate.js";
import { BridgeSessionFlow } from "./session-flow.js";
import { BridgeStatusText } from "./status-text.js";
import { handleChannelApprovalAction } from "./approval-actions.js";
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
  private readonly commentaryDelivery: BridgeCommentaryDelivery;
  private readonly notificationDelivery: BridgeNotificationDelivery;
  private readonly pendingInput: BridgePendingInputManager;
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
  private readonly groupController: BridgeGroupController;
  private attachmentSequence = 0;
  private readonly cwd: string;
  private readonly defaultProgressMode: ProgressDeliveryMode;
  private readonly routeProgressModes = new Map<string, ProgressDeliveryMode>();
  private readonly routeCollaborationModes = new Map<string, CodexCollaborationMode>();
  private readonly routeCompactStates = new Map<string, CompactState>();
  private readonly routeMessages = new Map<string, ChannelMessage>();
  private readonly routeTargets = new Map<string, ChannelTarget>();
  private readonly pendingMedia = new PendingMediaManager();
  private stopBackgroundEvents?: () => void;
  private releaseGroupWriter?: () => void;
  private stopping = false;

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
      authorizeMedia: (target) => {
        if (!this.isManagedGroupTarget(target)) return true;
        const allowed = !this.stopping && !this.groupAccess.error() && this.state.isRouteTrusted(target.routeKey) && this.groupAccess.canManage(target.routeKey, target.recipient.id).allowed;
        if (allowed) target.context = { ...target.context, groupPermissionRevision: this.groupAccess.get(target.routeKey)?.revision ?? 0 };
        return allowed;
      },
      auditMedia: (target, media, outcome, messageId) => {
        if (this.isManagedGroupTarget(target)) this.groupAccess.audit(target.routeKey, { actor: target.recipient.id, action: "file_export", outcome, target: media.name, detail: `session=${target.context?.sessionId ?? "unknown"};message=${messageId ?? "none"};authorizationRevision=${target.context?.groupPermissionRevision ?? "none"}` });
      },
    });
    this.groupController = new BridgeGroupController(this.groupAccess, this.delivery, (routeKey) => {
      this.pendingMedia.removeWhere(routeKey, (a) => Boolean(a.origin && this.groupAccess.roleForSender(routeKey, a.origin.senderId) === "blocked"));
    });
    this.routeTrustGate = new RouteTrustGate({
      state: this.state,
      delivery: this.delivery,
      logger: this.logger,
      transcript: this.transcript,
      mode: options.routeTrustMode,
      pairingCodes: options.pairingCodeManager,
      onRouteTrusted: (record) => {
        if (this.channels.get(record.channelId)?.groupPolicy === "feishu") this.groupAccess.ensureForTrustedRoute(record);
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
      isRealtimeProgress: (policy, routeKey) => this.isRealtimeProgressWithPolicy(policy, routeKey),
    });
    this.commentaryDelivery = new BridgeCommentaryDelivery({
      delivery: this.delivery,
      transcript: this.transcript,
      shouldDeliverCommentary: (policy, routeKey) => this.shouldDeliverCommentaryWithPolicy(policy, routeKey),
      isRealtimeCommentary: (policy, routeKey) => this.isRealtimeCommentaryWithPolicy(policy, routeKey),
    });
    this.notificationDelivery = new BridgeNotificationDelivery({
      state: this.state,
      delivery: this.delivery,
    });
    this.pendingInput = new BridgePendingInputManager({
      codex: this.codex,
      delivery: this.delivery,
      timeoutMs: options.requestUserInputTimeoutMs,
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
      preparePrompt: (message, input, sendFile) => this.prepareGroupPrompt(message, input, sendFile),
      codex: this.codex,
      state: this.state,
      approvals: this.approvals,
      logger: this.logger,
      turnScheduler: this.turnScheduler,
      transcript: this.transcript,
      delivery: this.delivery,
      sessionFlow: this.sessionFlow,
      hasBackgroundTurnForRoute: (routeKey) => this.backgroundTurns.hasForRoute(routeKey),
      currentCollaborationMode: (routeKey) => this.routeCollaborationModes.get(routeKey),
      deliveryPolicyFor: (message) => this.deliveryPolicyFor(message),
      shouldDeliverProgressWithPolicy: (policy, routeKey, kind) => this.shouldDeliverProgressWithPolicy(policy, routeKey, kind),
      shouldDeliverCommentaryWithPolicy: (policy, routeKey) => this.shouldDeliverCommentaryWithPolicy(policy, routeKey),
      isRealtimeCommentaryWithPolicy: (policy, routeKey) => this.isRealtimeCommentaryWithPolicy(policy, routeKey),
      shouldDeliverToolProgressWithPolicy: (policy, routeKey) => this.shouldDeliverToolProgressWithPolicy(policy, routeKey),
      progressDelivery: this.progressDelivery,
      commentaryDelivery: this.commentaryDelivery,
      notificationDelivery: this.notificationDelivery,
      pendingInput: this.pendingInput,
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
      shouldDeliverCommentaryWithPolicy: (policy, routeKey) => this.shouldDeliverCommentaryWithPolicy(policy, routeKey),
      isRealtimeCommentaryWithPolicy: (policy, routeKey) => this.isRealtimeCommentaryWithPolicy(policy, routeKey),
      shouldDeliverToolProgressWithPolicy: (policy, routeKey) => this.shouldDeliverToolProgressWithPolicy(policy, routeKey),
      shouldDeliverContextCompaction: (routeKey, sessionId) => {
        const compactState = this.compactStateForRoute(routeKey);
        return compactState.type !== "running" || compactState.sessionId !== sessionId;
      },
      progressDelivery: this.progressDelivery,
      commentaryDelivery: this.commentaryDelivery,
      notificationDelivery: this.notificationDelivery,
      pendingInput: this.pendingInput,
      transportDiagnostic: () => this.codex.getTransportDiagnostic?.(),
      startRouteWorker: (routeKey) => this.routeQueue.startRouteWorker(routeKey),
      routeQueueLength: (routeKey) => this.routeQueue.queueLength(routeKey),
      hasRouteWorker: (routeKey) => this.routeQueue.hasWorker(routeKey),
    });
    this.routeSteering = new BridgeRouteSteering({
      preparePrompt: (message, input) => this.prepareGroupPrompt(message, input, false),
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
      authorizeCommand: (message, name) => {
        if (!isFeishuGroupMessage(message)) return { allowed: true };
        if (this.stopping || this.groupAccess.error() || this.groupAccess.isSenderBlocked(message)) return { allowed: false };
        if (!isFeishuGroupPreTrustCommand(name) && !this.state.isRouteTrusted(message.routeKey)) return { allowed: false, text: "群配对已失效，请重新配对。" };
        const text = this.groupController.commandDenied(message, name);
        return { allowed: !text, text };
      },
      logger: this.logger,
      delivery: this.delivery,
      deliveryPolicyFor: (message) => this.deliveryPolicyFor(message),
      isRouteExecutionBusy: (routeKey) => this.isRouteExecutionBusy(routeKey),
      handlers: {
        help: (message) => isFeishuGroupMessage(message) ? this.groupController.help(message) : this.statusTextRenderer.helpText(message),
        createNewSession: (message, target, args, rawText) => handleNewSessionCommand({
          sessionFlow: this.sessionFlow,
          routeQueue: this.routeQueue,
          routeSteering: this.routeSteering,
        }, message, target, args, rawText),
        status: (message) => this.statusTextRenderer.statusText(message),
        sessions: (message, args, commandName) => this.statusTextRenderer.sessionsText(message, args, commandName),
        sessionDetail: (message, sessionId) => this.statusTextRenderer.sessionDetailText(message, sessionId),
        sessionsCwd: (message, target) => this.sessionFlow.beginSessionCwdSelection(message, target),
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
          deliveryPolicyFor: (message) => this.deliveryPolicyFor(message),
        }, message, target, rawMode),
        contextRefresh: (message, target, rawMode) => handleContextRefreshCommand({
          state: this.state,
          delivery: this.delivery,
          statusText: this.statusTextRenderer,
        }, message, target, rawMode),
        groupReceive: (message, target, args, commandName) => isFeishuGroupMessage(message) ? this.groupController.command(message, target, args) : handleGroupReceiveCommand({
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
          clearPendingInput: (routeKey) => this.pendingInput.clearRoute(routeKey),
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
    this.stopping = false;
    if (this.channels.ids().some((id) => this.channels.get(id)?.groupPolicy === "feishu")) this.releaseGroupWriter = this.state.acquireGroupAccessWriter();
    this.stopBackgroundEvents = this.codex.onBackgroundEvent?.((event) => this.backgroundTurns.handle(event));
    this.channels.onMessage((message) => this.handleMessage(message));
    this.channels.onApprovalAction((action) => this.handleChannelApprovalAction(action));
    try { await this.channels.start(); } catch (error) { this.releaseGroupWriter?.(); this.releaseGroupWriter = undefined; throw error; }
    this.logger.info("bridge started", { channels: this.channels.ids().join(",") });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.routeSteering.clearAll();
    this.pendingMedia.clearAll();
    this.pendingInput.clearAll();
    this.progressDelivery.clearAll();
    this.commentaryDelivery.clearAll();
    this.stopBackgroundEvents?.();
    this.stopBackgroundEvents = undefined;
    try { await this.channels.stop(); await this.codex.stop?.(); }
    finally { this.releaseGroupWriter?.(); this.releaseGroupWriter = undefined; }
    this.logger.info("bridge stopped", { channels: this.channels.ids().join(",") });
  }

  async handleMessage(message: ChannelMessage): Promise<void> {
    message = { ...message, groupPolicy: message.conversation.kind === "group" ? this.channels.get(message.channelId)?.groupPolicy : undefined };
    const managedGroup = isFeishuGroupMessage(message);
    if (managedGroup) {
      if (this.stopping) return;
      if (!this.channels.getCapabilities(message.channelId).group) return;
      if (this.groupAccess.error()) { await this.delivery.sendText(replyTargetFromMessage(message), "群权限文件不可用，请在本机修复。"); return; }
      // Blacklisting precedes pre-trust commands, state updates and media downloads.
      if (this.groupAccess.isSenderBlocked(message)) return;
    }
    message = this.enrichMessageFromRouteHistory(message);
    const text = message.text?.trim() ?? "";
    const command = text ? parseCommand(text) : undefined;
    let attachments = classifyInboundAttachments(message.attachments);
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
    if (!managedGroup) this.sessionFlow.claimPendingInitialRouteBindingRoute(message);
    if (isFeishuGroupMessage(message) && this.state.isRouteTrusted(message.routeKey)) {
      try {
        this.groupAccess.ensureForTrustedGroupMessage(message);
        const botId = (message.raw as FeishuGroupMessageRaw | undefined)?.chatCodex?.feishu?.group?.mentions.find((p) => p.isBot)?.openId;
        if (botId) this.groupAccess.recordBotIdentity(message.routeKey, botId);
      }
      catch { await this.delivery.sendText(target, "群权限保存失败，请在本机检查。"); return; }
      if (this.groupAccess.isSenderBlocked(message)) return;
    }
    if (isFeishuGroupMessage(message)
      && !isFeishuGroupRegistrationFreeCommand(command?.name)
      && !this.isFeishuGroupMemberRegistered(message)) {
      await this.delivery.sendText(target, feishuGroupRegistrationRequiredText());
      return;
    }
    if (await this.pendingInput.handleMessage({
      message,
      target,
      rawText: text,
      commandName: command?.name,
    })) return;
    if (managedGroup && command?.isCommand) {
      const denied = this.groupController.commandDenied(message, command.name ?? "");
      if (denied) {
        this.groupAccess.audit(message.routeKey, { actor: message.sender.id, action: `command:${command.name}`, outcome: "denied" });
        await this.delivery.sendText(target, denied); return;
      }
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
    const channel = this.channels.get(message.channelId);
    if (message.quotedMessage && channel?.hydrateQuotedMessage) {
      const wasTrusted = this.state.isRouteTrusted(message.routeKey);
      const authorize = () => !this.stopping
        && (!wasTrusted || this.state.isRouteTrusted(message.routeKey))
        && (!managedGroup || (!this.groupAccess.error() && this.state.isRouteTrusted(message.routeKey)
          && !this.groupAccess.isSenderBlocked(message) && this.isFeishuGroupMemberRegistered(message)));
      await channel.hydrateQuotedMessage(message, authorize);
      if (!authorize()) return;
      this.transcript?.quotedMessage?.(message);
      attachments = classifyInboundAttachments(message.attachments);
    }
    if (managedGroup) {
      await this.channels.get(message.channelId)?.hydrateAttachments?.(message, () => !this.groupAccess.error() && this.state.isRouteTrusted(message.routeKey) && !this.groupAccess.isSenderBlocked(message));
      if (this.groupAccess.isSenderBlocked(message) || !this.state.isRouteTrusted(message.routeKey)) return;
      message.attachments = message.attachments?.map((attachment) => ({ ...attachment, origin: { senderId: message.sender.id, displayName: message.sender.displayName, messageId: message.id, receivedAt: message.timestamp, sequence: ++this.attachmentSequence } }));
      attachments = classifyInboundAttachments(message.attachments);
      const removed = this.pendingMedia.removeWhere(message.routeKey, (a) => Boolean(a.origin && groupSenderRole(this.groupAccess.get(message.routeKey), a.origin.senderId) === "blocked"));
      if (removed) await this.delivery.sendText(target, `已移除 ${removed} 个被拉黑成员的附件，剩余 ${this.pendingMedia.count(message.routeKey)} 个群聊共享待处理附件。`);
      if (this.sessionFlow.hasSessionCwdSelection(message.routeKey) || this.sessionFlow.hasSessionSelection(message.routeKey) || this.sessionFlow.shouldAskBeforeBindingSession(message)) {
        await this.delivery.sendText(target, "请先在本机为当前群配置会话绑定。"); return;
      }
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
    if (this.sessionFlow.hasSessionCwdSelection(message.routeKey)) {
      await this.sessionFlow.handleSessionCwdSelectionReply(message, target, text);
      return;
    }
    if (this.sessionFlow.hasSessionSelection(message.routeKey)) {
      await this.sessionFlow.handleSessionSelectionReply(message, target, text);
      return;
    }
    if (this.sessionFlow.shouldAskBeforeBindingSession(message)) {
      await this.routeQueue.enqueuePrompt(message, target, textWithQuotedMessage(message, text));
      return;
    }
    const inputAttachments = [...this.pendingMedia.consume(message.routeKey), ...attachments.usable];
    const acceptedAttachments = inputAttachments.slice(0, PENDING_MEDIA_MAX_ATTACHMENTS);
    const rejectedAttachments = inputAttachments.slice(PENDING_MEDIA_MAX_ATTACHMENTS);
    if (rejectedAttachments.length > 0) {
      await this.delivery.sendText(target, inboundMediaTurnOverflowText(rejectedAttachments.length));
    }
    const promptText = textWithQuotedMessage(message, text);
    const rawInput = acceptedAttachments.length > 0
      ? codexInputFromTextAndAttachments(promptText, acceptedAttachments)
      : promptText;
    const groupPrefixMode = message.conversation.kind === "group" && await this.isRouteExecutionBusyWithoutCompact(message.routeKey)
      ? "supplement"
      : "say";
    const input = withGroupConversationPromptPrefix(message, rawInput, groupPrefixMode);
    if (await this.routeSteering.tryEnqueue(message, target, input)) return;
    await this.routeQueue.enqueuePrompt(message, target, input);
  }

  private isManagedGroupTarget(target: ChannelTarget): boolean {
    return target.conversation.kind === "group" && this.channels.get(target.channelId)?.groupPolicy === "feishu";
  }

  private prepareGroupPrompt(message: ChannelMessage, input: CodexPromptInput, sendFile: boolean): CodexPromptInput | undefined {
    if (!isFeishuGroupMessage(message)) return input;
    if (this.stopping || this.groupAccess.error() || !this.state.isRouteTrusted(message.routeKey) || this.groupAccess.isSenderBlocked(message)) return undefined;
    if (sendFile && !this.groupAccess.canManage(message.routeKey, message.sender.id).allowed) return undefined;
    if (typeof input === "string") return input;
    const items = input.items.filter((item) => !(item.type !== "text" && item.origin && groupSenderRole(this.groupAccess.get(message.routeKey), item.origin.senderId) === "blocked"));
    const sources = items.flatMap((item) => item.type !== "text" && item.origin ? [`${item.origin.displayName ?? item.origin.senderId} 发来的${item.type === "localImage" ? "图片" : "文件"} ${item.origin.sequence}（消息 ${item.origin.messageId}）`] : []);
    return sources.length ? withCodexInputText({ ...input, items }, `${input.text}\n\n群共享附件来源：\n${sources.join("\n")}`) : { ...input, items };
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
    if (isFeishuGroupMessage(message)) {
      await this.delivery.sendText(target, await this.groupController.approve(message, args, decision, this.approvals, this.codex));
      return;
    }
    await handleApprovalCommand({
      approvals: this.approvals,
      codex: this.codex,
      delivery: this.delivery,
    }, message, target, args, decision);
  }

  private async handleChannelApprovalAction(action: ChannelApprovalAction): Promise<ChannelApprovalActionResult> {
    if (this.isManagedGroupTarget(replyTargetFromMessage(action.message))) {
      return { status: "rejected", text: "群聊请 @Bot 使用 /OK <编号> 或 /NO <编号>。" };
    }
    this.logger.info("channel approval action received", {
      channel: action.message.channelId,
      routeKey: action.message.routeKey,
      approvalKey: action.approvalKey,
      decision: action.decision,
      sender: action.message.sender.id,
    });
    return handleChannelApprovalAction({
      approvals: this.approvals,
      codex: this.codex,
    }, action);
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
      await this.delivery.sendText(target, isFeishuGroupMessage(message) ? `群聊共享待处理附件：${result.total} 个；任何已登记成员可 @Bot 补充要求，管理员可 /cancel 清空。` : pendingMediaPromptText(result.total));
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
    if (this.pendingInput.has(routeKey)) return true;
    if (this.routeQueue.hasWorker(routeKey) || this.backgroundTurns.hasForRoute(routeKey)) return true;
    if (this.routeQueue.queueLength(routeKey) > 0) return true;
    if (this.routeSteering.hasPendingWorkForRoute(routeKey)) return true;
    if (this.approvals.list(routeKey).length > 0) return true;
    const binding = this.state.getBinding(routeKey);
    if (!binding) return false;
    try {
      const status = await this.codex.getStatus(binding.sessionId);
      return status.type === "running" || status.type === "waiting_approval" || status.type === "waiting_input";
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
    const policy = this.deliveryPolicyFor(this.routeMessages.get(routeKey));
    const explicit = this.routeProgressModes.get(routeKey);
    if (explicit && isProgressModeAllowedByPolicy(explicit, policy)) return explicit;
    const policyDefault = policy.defaultProgressMode;
    if (isProgressDeliveryMode(policyDefault) && isProgressModeAllowedByPolicy(policyDefault, policy)) return policyDefault;
    if (isProgressModeAllowedByPolicy(this.defaultProgressMode, policy)) return this.defaultProgressMode;
    return fallbackProgressModeForPolicy(policy);
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
    const mode = this.progressModeFor(routeKey);
    if (mode === "silent") return false;
    if (mode === "realtime") return policy.realtimeProgress !== "suppress";
    if (mode === "tools") return false;
    return this.statusTextRenderer.shouldDeliverProgress(routeKey, kind);
  }

  private isRealtimeProgressWithPolicy(policy: ChannelDeliveryPolicy, routeKey: string): boolean {
    if (policy.progress === "suppress") return false;
    if (policy.realtimeProgress === "suppress") return false;
    return this.progressModeFor(routeKey) === "realtime";
  }

  private shouldDeliverCommentaryWithPolicy(policy: ChannelDeliveryPolicy, routeKey: string): boolean {
    if (policy.progress === "suppress") return false;
    if (this.collaborationModeForRoute(routeKey) === "plan") return true;
    const mode = this.progressModeFor(routeKey);
    if (mode === "silent") return false;
    if (mode === "realtime") return policy.realtimeProgress !== "suppress";
    if (mode === "tools") return false;
    return mode === "brief" || mode === "detailed";
  }

  private isRealtimeCommentaryWithPolicy(policy: ChannelDeliveryPolicy, routeKey: string): boolean {
    if (policy.progress === "suppress") return false;
    if (policy.realtimeProgress === "suppress") return false;
    return this.progressModeFor(routeKey) === "realtime";
  }

  private shouldDeliverToolProgressWithPolicy(policy: ChannelDeliveryPolicy, routeKey: string): boolean {
    if (policy.toolProgress !== "send") return false;
    const mode = this.progressModeFor(routeKey);
    if (mode === "silent") return false;
    return mode === "tools" || mode === "detailed" || (mode === "realtime" && policy.realtimeProgress !== "suppress");
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

function isProgressDeliveryMode(value: unknown): value is ProgressDeliveryMode {
  return value === "brief" || value === "detailed" || value === "realtime" || value === "tools" || value === "silent";
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
