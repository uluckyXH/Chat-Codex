import type { ApprovalDecision } from "../approvals/types.js";
import { normalizeApprovalDecision, unsupportedApprovalDecisionText } from "../approvals/approval-policy.js";
import type {
  CodexAdapter,
  CodexAdapterCapabilities,
  CodexBackgroundEventHandler,
  CodexCollaborationMode,
  CodexCompactResult,
  CodexEvent,
  CodexGoal,
  CodexGoalStatus,
  CodexGoalMutationOptions,
  CodexModelListOptions,
  CodexModelOption,
  CodexModelPolicy,
  CodexProgressKind,
  CodexRunPolicyStatus,
  CodexSession,
  CodexSessionDetail,
  CodexSessionReloadResult,
  CodexSessionStatus,
  CodexSessionSummary,
  CodexSessionListStatus,
  CodexTransportDiagnostic,
  CodexRunOptions,
  StartSessionInput,
  CodexPromptInput,
  CodexUserInputResponse,
} from "./types.js";
import { displayCodexSessionTitle, findCodexSessionById, type CodexRunPolicy } from "./codex-cli.js";
import { ensureCodexStatePreviewIfEmpty } from "./codex-state-preview.js";
import { resolveCodexCommand, type CodexCommandResolution } from "./codex-process.js";
import {
  inspectCodexCwd,
  inspectCurrentProcessCwd,
  isInvalidCwdError,
  type CodexCwdDiagnostic,
  type CodexCwdDiagnosticSource,
} from "./cwd-diagnostic.js";
import { codexInputText } from "./input.js";
import { approvalFromServerRequest, responseForApprovalDecision } from "./app-server/approval-handler.js";
import { goalFromResponse, goalFromSetResponse } from "./app-server/goal-api.js";
import { appServerUserInput } from "./app-server/input-mapper.js";
import { appServerErrorMessage, isTransientAppServerError } from "./app-server/notification-mapper.js";
import { unsupportedServerRequestResponse, userInputRequestFromServerRequest } from "./app-server/server-request-mapper.js";
import { mergeSessionSummaries, sessionDetailFromThread } from "./app-server/thread-list.js";
import { readLastAssistantMessageFromPages } from "./app-server/thread-history.js";
import { applyEffectiveSettings, effectiveSandboxName } from "./app-server/effective-settings.js";
import { readThreadListPages, isPaginationMethodUnavailable } from "./app-server/thread-list-pages.js";
import {
  cloneModelPolicy,
  modelInfoFromResponse,
  modelInfoWithPolicy,
  modelsFromListResponse,
} from "./app-server/model-policy.js";
import {
  approvalPolicyForRunPolicy,
  approvalsReviewerForRunPolicy,
  cloneRunPolicy,
  sandboxModeForRunPolicy,
  sandboxPolicyForRunPolicy,
} from "./app-server/run-policy.js";
import { AppServerRpcClient } from "./app-server/rpc-client.js";
import { AppServerSessionStore } from "./app-server/session-store.js";
import { collaborationModePayload, truncatePrompt, withContext, withModelPolicy } from "./app-server/session-status.js";
import { AppServerTurnController } from "./app-server/turn-controller.js";
import type { JsonRpcNotification, JsonRpcRequest, PendingServerApproval, PendingServerUserInput } from "./app-server/types.js";
import { AsyncEventQueue } from "./app-server/turn-store.js";
import { arrayValue, isoFromSeconds, numberValue, objectValue, objectValueOrNull, stringValue } from "./app-server/value-parsers.js";

export interface AppServerCodexAdapterOptions {
  codexBin?: string;
  codexCommand?: CodexCommandResolution;
  runPolicy?: CodexRunPolicy;
  codexHome?: string;
  requestTimeoutMs?: number;
  interruptTimeoutMs?: number;
  compactTimeoutMs?: number;
}

interface CompactWaiter {
  sessionId: string;
  turnId?: string;
  timer?: ReturnType<typeof setTimeout>;
  resolve(result: CodexCompactResult): void;
  reject(error: Error): void;
}

export class AppServerCodexAdapter implements CodexAdapter {
  private readonly codexCommand: CodexCommandResolution;
  private defaultRunPolicy: CodexRunPolicy;
  private readonly sessionRunPolicies = new Map<string, CodexRunPolicy>();
  private defaultModelPolicy: CodexModelPolicy = {};
  private readonly sessionModelPolicies = new Map<string, CodexModelPolicy>();
  private defaultCollaborationMode: CodexCollaborationMode = "default";
  private readonly sessionCollaborationModes = new Map<string, CodexCollaborationMode>();
  private readonly codexHome?: string;
  private readonly requestTimeoutMs: number;
  private readonly interruptTimeoutMs: number;
  private readonly compactTimeoutMs: number;
  private readonly rpc: AppServerRpcClient;
  private readonly sessionStore = new AppServerSessionStore();
  private readonly pendingApprovals = new Map<string, PendingServerApproval>();
  private readonly pendingUserInputs = new Map<string, PendingServerUserInput>();
  private readonly compactWaiters = new Map<string, CompactWaiter>();
  private readonly cwdDiagnostics = new Map<string, CodexCwdDiagnostic>();
  private readonly loadedSessionIds = new Set<string>();
  private readonly sessionResumePromises = new Map<string, Promise<CodexSession>>();
  private lastCwdDiagnostic?: CodexCwdDiagnostic;
  private lastTransportDiagnostic?: CodexTransportDiagnostic;
  private sessionListStatus?: CodexSessionListStatus;
  private readonly historyRevisions = new Map<string, number>();
  private readonly turns = new AppServerTurnController({
    sessions: this.sessionStore.records,
    threadToSession: this.sessionStore.threadToSession,
  });

  constructor(options: AppServerCodexAdapterOptions = {}) {
    this.codexCommand = options.codexCommand ?? resolveCodexCommand({ codexBin: options.codexBin });
    this.defaultRunPolicy = cloneRunPolicy(options.runPolicy ?? { permissionMode: "approval", sandbox: "workspace-write" });
    this.codexHome = options.codexHome;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.interruptTimeoutMs = options.interruptTimeoutMs ?? 1500;
    this.compactTimeoutMs = options.compactTimeoutMs ?? 10 * 60_000;
    this.rpc = new AppServerRpcClient({
      codexBin: this.codexCommand,
      requestTimeoutMs: this.requestTimeoutMs,
      onServerRequest: (request) => this.handleServerRequest(request),
      onNotification: (notification) => this.handleNotification(notification),
      onFatalError: (error, diagnostic) => this.handleFatalAppServerError(error, diagnostic),
    });
  }

  onBackgroundEvent(handler: CodexBackgroundEventHandler): () => void {
    return this.turns.onBackgroundEvent(handler);
  }

  getProtocolStatus() {
    return this.rpc.getProtocolStatus();
  }

  getCapabilities(): CodexAdapterCapabilities {
    return { mode: "app-server", interactiveApprovals: true, userInput: true, goals: true, steering: true, modelList: true, messagePhases: true, asyncQuestions: true };
  }

  async stop(): Promise<void> {
    this.turns.closeAll();
    this.pendingApprovals.clear();
    this.pendingUserInputs.clear();
    this.loadedSessionIds.clear();
    this.sessionResumePromises.clear();
    for (const waiter of this.compactWaiters.values()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new Error("codex app-server stopped"));
    }
    this.compactWaiters.clear();
    this.rpc.stop();
  }

  async startSession(input: StartSessionInput): Promise<CodexSession> {
    await this.ensureStarted();
    const modelPolicy = cloneModelPolicy(this.defaultModelPolicy);
    const response = await this.request<Record<string, unknown>>("thread/start", {
      model: modelPolicy.model,
      serviceTier: modelPolicy.serviceTier,
      cwd: input.cwd,
      approvalPolicy: approvalPolicyForRunPolicy(this.defaultRunPolicy),
      approvalsReviewer: approvalsReviewerForRunPolicy(this.defaultRunPolicy),
      sandbox: sandboxModeForRunPolicy(this.defaultRunPolicy),
      serviceName: "codex-chat-bridge",
      sessionStartSource: "startup",
    });
    const thread = objectValue(response.thread);
    const threadId = stringValue(thread.id) ?? `app-server-thread-${Date.now()}`;
    const cwd = stringValue(response.cwd) ?? stringValue(thread.cwd) ?? input.cwd;
    const session: CodexSession = {
      id: threadId,
      cwd,
      title: input.title ?? stringValue(thread.name) ?? stringValue(thread.preview) ?? `codex:${threadId}`,
      createdAt: isoFromSeconds(numberValue(thread.createdAt)) ?? new Date().toISOString(),
    };
    const baseModel = modelInfoFromResponse(response, thread);
    const model = modelInfoWithPolicy(baseModel, modelPolicy);
    this.sessionStore.set(session.id, {
      session,
      routeKey: input.routeKey,
      status: { type: "idle", ...(model ? { model } : {}) },
      updatedAt: new Date().toISOString(),
      ...(baseModel ? { baseModel } : {}),
    });
    this.sessionRunPolicies.set(session.id, cloneRunPolicy(this.defaultRunPolicy));
    this.sessionModelPolicies.set(session.id, modelPolicy);
    if (this.defaultCollaborationMode !== "default") {
      this.sessionCollaborationModes.set(session.id, this.defaultCollaborationMode);
    }
    this.sessionStore.mapThread(threadId, session.id);
    this.recordEffectiveSettings(session.id, response);
    this.loadedSessionIds.add(session.id);
    return session;
  }

  async resumeSession(sessionId: string): Promise<CodexSession> {
    if (this.sessionStore.has(sessionId)) {
      await this.ensureSessionLoaded(sessionId);
      const stored = this.sessionStore.get(sessionId);
      if (!stored) throw new Error(`app-server session not found locally: ${sessionId}`);
      return stored.session;
    }
    return this.loadSessionFromServer(sessionId, true);
  }

  async reloadSession(sessionId: string): Promise<CodexSessionReloadResult> {
    const routeKey = this.sessionStore.get(sessionId)?.routeKey;
    this.restartAppServerForReload();
    const session = await this.loadSessionFromServer(sessionId, true, routeKey);
    const revision = this.historyRevisions.get(sessionId);
    const lastAssistantMessage = await readLastAssistantMessageFromPages(
      (method, params) => this.request<Record<string, unknown>>(method, params),
      sessionId,
    );
    if (revision !== this.historyRevisions.get(sessionId)) throw new Error("Codex 历史在读取期间已回退，请重新加载会话。");
    return {
      session,
      reloadedAt: new Date().toISOString(),
      ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
    };
  }

  private restartAppServerForReload(): void {
    if (this.turns.hasActiveTurns()) {
      throw new Error("当前 app-server 仍有运行中的 Codex turn，不能安全重启并刷新上下文。请等待当前任务结束后重试。");
    }
    this.pendingApprovals.clear();
    this.pendingUserInputs.clear();
    for (const waiter of this.compactWaiters.values()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new Error("codex app-server restarting for session reload"));
    }
    this.compactWaiters.clear();
    this.turns.closeAll();
    this.loadedSessionIds.clear();
    this.sessionResumePromises.clear();
    this.sessionStore.clear();
    this.rpc.stop();
  }

  private async loadSessionFromServer(sessionId: string, forceResume: boolean, routeKey?: string): Promise<CodexSession> {
    await this.ensureStarted();
    const stored = this.sessionStore.get(sessionId);
    if (stored && !forceResume && this.loadedSessionIds.has(sessionId)) return stored.session;
    const discovered = findCodexSessionById(sessionId, { codexHome: this.codexHome });
    const modelPolicy = cloneModelPolicy(this.sessionModelPolicies.get(sessionId) ?? this.defaultModelPolicy);
    const runPolicy = this.runPolicyForSession(sessionId);
    const revision = this.historyRevisions.get(sessionId);
    const response = await this.request<Record<string, unknown>>("thread/resume", {
      threadId: sessionId,
      excludeTurns: true,
      model: modelPolicy.model,
      serviceTier: modelPolicy.serviceTier,
      cwd: discovered?.cwd ?? undefined,
      approvalPolicy: approvalPolicyForRunPolicy(runPolicy),
      approvalsReviewer: approvalsReviewerForRunPolicy(runPolicy),
      sandbox: sandboxModeForRunPolicy(runPolicy),
    });
    if (revision !== this.historyRevisions.get(sessionId)) throw new Error("Codex 历史在恢复期间已回退，请重新恢复会话。");
    const thread = objectValue(response.thread);
    const cwd = stringValue(response.cwd) ?? stringValue(thread.cwd) ?? discovered?.cwd ?? process.cwd();
    const session: CodexSession = {
      id: sessionId,
      cwd,
      title: stringValue(thread.name) ?? (discovered ? displayCodexSessionTitle(discovered) : undefined) ?? `codex:${sessionId}`,
      createdAt: isoFromSeconds(numberValue(thread.createdAt)) ?? discovered?.updatedAt ?? new Date().toISOString(),
    };
    const baseModel = modelInfoFromResponse(response, thread);
    const model = modelInfoWithPolicy(baseModel, modelPolicy);
    this.sessionStore.set(session.id, {
      session,
      routeKey: stored?.routeKey ?? routeKey,
      status: { type: "idle", ...(model ? { model } : {}) },
      updatedAt: new Date().toISOString(),
      ...(baseModel ? { baseModel } : {}),
    });
    if (!this.sessionRunPolicies.has(session.id)) {
      this.sessionRunPolicies.set(session.id, cloneRunPolicy(this.defaultRunPolicy));
    }
    if (!this.sessionModelPolicies.has(session.id)) {
      this.sessionModelPolicies.set(session.id, modelPolicy);
    }
    if (!this.sessionCollaborationModes.has(session.id) && this.defaultCollaborationMode !== "default") {
      this.sessionCollaborationModes.set(session.id, this.defaultCollaborationMode);
    }
    this.sessionStore.mapThread(sessionId, session.id);
    this.recordEffectiveSettings(session.id, response);
    this.loadedSessionIds.add(session.id);
    return session;
  }

  async setSessionTitle(sessionId: string, title: string): Promise<void> {
    await this.ensureSessionLoaded(sessionId);
    await this.request<Record<string, unknown>>("thread/name/set", {
      threadId: sessionId,
      name: title,
    });
    const stored = this.sessionStore.get(sessionId);
    if (stored) {
      stored.session.title = title;
      stored.updatedAt = new Date().toISOString();
    }
  }

  async setSessionPreview(sessionId: string, preview: string): Promise<void> {
    await this.ensureStarted();
    this.ensureKnownSession(sessionId);
    const result = await ensureCodexStatePreviewIfEmpty(sessionId, preview, { codexHome: this.codexHome });
    if (!result.ok) throw new Error(result.message);
  }

  async *run(sessionId: string, prompt: CodexPromptInput, options: CodexRunOptions = {}): AsyncIterable<CodexEvent> {
    await this.ensureSessionLoaded(sessionId);
    const stored = this.sessionStore.get(sessionId);
    if (!stored) throw new Error(`app-server session not found locally: ${sessionId}`);
    const runPolicy = this.runPolicyForSession(sessionId);
    const modelPolicy = this.modelPolicyForSession(sessionId);
    const collaborationMode = options.collaborationMode ?? this.sessionCollaborationModes.get(sessionId);
    const promptText = codexInputText(prompt);
    const queue = new AsyncEventQueue<CodexEvent>();
    let turnId = "";
    const registerTurn = (response: unknown): void => {
      const turn = objectValue(objectValue(response).turn);
      turnId = stringValue(turn.id) ?? `app-server-turn-${Date.now()}`;
      const startedAt = startedAtFromTurn(turn);
      this.turns.registerTurn(sessionId, turnId, queue, collaborationMode);
      stored.status = withContext(stored, { type: "running", turnId, task: truncatePrompt(promptText), startedAt });
      if (!stored.baseModel) stored.status = withModelPolicy(stored.status, modelPolicy);
      stored.currentTurnId = turnId;
      stored.updatedAt = new Date().toISOString();
    };
    await this.request<Record<string, unknown>>("turn/start", {
      threadId: sessionId,
      input: appServerUserInput(prompt),
      cwd: stored.session.cwd,
      approvalPolicy: approvalPolicyForRunPolicy(runPolicy),
      approvalsReviewer: approvalsReviewerForRunPolicy(runPolicy),
      sandboxPolicy: sandboxPolicyForRunPolicy(runPolicy, stored.session.cwd),
      model: modelPolicy.model,
      serviceTier: modelPolicy.serviceTier,
      effort: modelPolicy.reasoningEffort,
      collaborationMode: collaborationMode
        ? collaborationModePayload(collaborationMode, modelPolicy, stored)
        : undefined,
    }, {
      onResult: registerTurn,
    });
    yield { type: "turn.started", sessionId, turnId, startedAt: runningStartedAt(stored.status) };

    for await (const event of queue) {
      yield event;
    }
  }

  async steer(sessionId: string, prompt: CodexPromptInput): Promise<void> {
    let stored = this.sessionStore.get(sessionId);
    if (!stored) throw new Error(`app-server session not found locally: ${sessionId}`);
    const turnId = stored.currentTurnId;
    if (!turnId) throw new Error("no active turn to steer");
    await this.ensureSessionLoaded(sessionId);
    stored = this.sessionStore.get(sessionId);
    if (!stored?.currentTurnId) throw new Error("no active turn to steer");
    const response = await this.request<Record<string, unknown>>("turn/steer", {
      threadId: sessionId,
      input: appServerUserInput(prompt),
      expectedTurnId: turnId,
    });
    const acceptedTurnId = stringValue(response.turnId ?? response.turn_id) ?? stringValue(objectValue(response.turn).id);
    if (acceptedTurnId && acceptedTurnId !== turnId) {
      stored.currentTurnId = acceptedTurnId;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const stored = this.sessionStore.get(sessionId);
    const turnId = stored?.currentTurnId;
    if (!stored || !turnId) return;
    stored.status = withContext(stored, { type: "interrupted" });
    stored.updatedAt = new Date().toISOString();
    const pendingForTurn = [...this.pendingApprovals.entries()]
      .filter(([, pending]) => pending.sessionId === sessionId && pending.turnId === turnId);
    for (const [approvalKey, pending] of pendingForTurn) {
      try {
        await pending.resolve("cancel");
      } catch {
        // Best effort: the app-server may already be stuck or gone.
      }
      this.pendingApprovals.delete(approvalKey);
    }
    for (const [requestId, pending] of this.pendingUserInputs.entries()) {
      if (pending.sessionId === sessionId && pending.turnId === turnId) {
        this.pendingUserInputs.delete(requestId);
      }
    }
    const turn = this.turns.get(turnId);
    if (turn && !turn.closed) {
      turn.queue.push({ type: "turn.interrupted", sessionId, turnId });
      this.turns.closeTurn(turnId, "interrupted");
    }
    void this.request("turn/interrupt", { threadId: sessionId, turnId }, { timeoutMs: this.interruptTimeoutMs }).catch(() => undefined);
  }

  async getStatus(sessionId: string): Promise<CodexSessionStatus> {
    return this.sessionStore.getStatus(sessionId);
  }

  getCwdDiagnostic(sessionId?: string): CodexCwdDiagnostic | undefined {
    return sessionId ? this.cwdDiagnostics.get(sessionId) : this.lastCwdDiagnostic;
  }

  getTransportDiagnostic(): CodexTransportDiagnostic | undefined {
    return this.lastTransportDiagnostic;
  }

  async listSessions(routeKey?: string): Promise<CodexSessionSummary[]> {
    this.sessionListStatus = undefined;
    if (routeKey) {
      this.sessionListStatus = { source: "local", pages: 0, truncated: false };
      return this.sessionStore.listSessions(routeKey, this.codexHome);
    }
    const runtimeSessions = this.sessionStore.listRuntimeSessions();
    const appServerSessions = await this.listSessionsFromThreadList().catch((error) => {
      if (!isPaginationMethodUnavailable(error)) throw error;
      this.sessionListStatus = { source: "local", pages: 0, truncated: true, notice: "当前 Codex 不支持远程会话列表，显示本机可发现的会话。" };
      return undefined;
    });
    if (appServerSessions) return mergeSessionSummaries(runtimeSessions, appServerSessions);
    return this.sessionStore.listSessions(undefined, this.codexHome);
  }

  getSessionListStatus(): CodexSessionListStatus | undefined {
    return this.sessionListStatus ? { ...this.sessionListStatus } : undefined;
  }

  async getSessionDetail(sessionId: string): Promise<CodexSessionDetail | undefined> {
    if (this.sessionStore.has(sessionId)) {
      await this.ensureSessionLoaded(sessionId);
    } else {
      await this.ensureStarted();
    }
    const response = await this.request<Record<string, unknown>>("thread/read", {
      threadId: sessionId,
      includeTurns: false,
    });
    return sessionDetailFromThread(objectValue(response.thread));
  }

  private async listSessionsFromThreadList(): Promise<CodexSessionSummary[]> {
    await this.ensureStarted();
    const result = await readThreadListPages((params) => this.request<Record<string, unknown>>("thread/list", params));
    this.sessionListStatus = result.status;
    return result.sessions;
  }

  async resolveApproval(approvalKey: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingApprovals.get(approvalKey);
    if (!pending) throw new Error(`未找到 Codex app-server 审批请求: ${approvalKey}`);
    const resolvedDecision = normalizeApprovalDecision(pending.approval, decision);
    if (!resolvedDecision) throw new Error(unsupportedApprovalDecisionText(pending.approval, decision));
    this.pendingApprovals.delete(approvalKey);
    await pending.resolve(resolvedDecision);
    this.refreshInteractionStatus(pending.sessionId, pending.turnId);
  }

  async resolveUserInput(requestId: string, response: CodexUserInputResponse): Promise<void> {
    const pending = this.pendingUserInputs.get(requestId);
    if (!pending) throw new Error(`未找到 Codex app-server 用户输入请求: ${requestId}`);
    this.pendingUserInputs.delete(requestId);
    await pending.resolve(response);
    this.refreshInteractionStatus(pending.sessionId, pending.turnId);
    this.turns.pushTurnEvent(pending.turnId, {
      type: "input.resolved",
      sessionId: pending.sessionId,
      turnId: pending.turnId,
      adapterRequestId: requestId,
    });
  }

  getRunPolicy(sessionId?: string): CodexRunPolicy {
    return cloneRunPolicy(this.runPolicyForSession(sessionId));
  }

  setRunPolicy(policy: CodexRunPolicy, sessionId?: string): void {
    if (sessionId) {
      this.sessionRunPolicies.set(sessionId, cloneRunPolicy(policy));
      return;
    }
    this.defaultRunPolicy = cloneRunPolicy(policy);
  }

  getRunPolicyStatus(sessionId?: string): CodexRunPolicyStatus {
    const policy = this.runPolicyForSession(sessionId);
    const effective = sessionId ? this.sessionStore.get(sessionId)?.status.effectiveSettings : undefined;
    const approval = effective?.approvalPolicy;
    return {
      policy: cloneRunPolicy(policy),
      interactiveApprovals: approval != null ? approval !== "never" : policy.permissionMode !== "full",
      effectiveApprovalPolicy: approval != null ? (typeof approval === "string" ? approval : JSON.stringify(approval)) : approvalPolicyForRunPolicy(policy),
      effectiveApprovalsReviewer: effective?.approvalsReviewer !== undefined ? effective.approvalsReviewer : approvalsReviewerForRunPolicy(policy),
      effectiveSandbox: effectiveSandboxName(effective) ?? sandboxModeForRunPolicy(policy),
      ...(effective?.activePermissionProfile !== undefined ? { activePermissionProfile: effective.activePermissionProfile?.id ?? null } : {}),
      supportedPermissionModes: ["approval", "approve-for-me", "full"],
      note: "codex app-server 会把审批请求回调给中间件，可通过微信 /OK、/P 或 /NO 处理。" + (effective ? " 生效值来自服务端最近一次确认；本地策略修改用于后续任务。" : " 当前显示本地请求策略，尚无服务端生效值。"),
    };
  }

  async listModels(options: CodexModelListOptions = {}): Promise<CodexModelOption[]> {
    await this.ensureStarted();
    const models: CodexModelOption[] = [];
    let cursor: string | null | undefined;
    do {
      const response = await this.request<Record<string, unknown>>("model/list", {
        cursor: cursor ?? null,
        limit: 100,
        includeHidden: options.includeHidden ?? false,
      });
      models.push(...modelsFromListResponse(response));
      cursor = stringValue(response.nextCursor ?? response.next_cursor) ?? null;
    } while (cursor);
    return models;
  }

  getModelPolicy(sessionId?: string): CodexModelPolicy {
    return cloneModelPolicy(this.modelPolicyForSession(sessionId));
  }

  setModelPolicy(policy: CodexModelPolicy, sessionId?: string): void {
    const next = cloneModelPolicy(policy);
    if (sessionId) {
      this.sessionModelPolicies.set(sessionId, next);
      return;
    }
    this.defaultModelPolicy = next;
  }

  getCollaborationMode(sessionId?: string): CodexCollaborationMode {
    return (sessionId ? this.sessionCollaborationModes.get(sessionId) : undefined) ?? this.defaultCollaborationMode;
  }

  setCollaborationMode(mode: CodexCollaborationMode, sessionId?: string): void {
    if (sessionId) {
      this.sessionCollaborationModes.set(sessionId, mode);
      return;
    }
    this.defaultCollaborationMode = mode;
  }

  async getGoal(sessionId: string): Promise<CodexGoal | null> {
    await this.ensureSessionLoaded(sessionId);
    const response = await this.request<Record<string, unknown>>("thread/goal/get", {
      threadId: sessionId,
    });
    const goal = objectValueOrNull(response.goal);
    return this.cacheGoal(sessionId, goal ? goalFromResponse(goal) : null);
  }

  async setGoal(sessionId: string, objective: string, options?: CodexGoalMutationOptions): Promise<CodexGoal> {
    await this.ensureSessionLoaded(sessionId);
    const response = await this.request<Record<string, unknown>>("thread/goal/set", {
      threadId: sessionId,
      objective,
      ...(options ? { origin: options.origin } : {}),
      status: "active",
    });
    return this.cacheGoal(sessionId, goalFromSetResponse(response));
  }

  async setGoalStatus(sessionId: string, status: CodexGoalStatus, options?: CodexGoalMutationOptions): Promise<CodexGoal> {
    await this.ensureSessionLoaded(sessionId);
    const response = await this.request<Record<string, unknown>>("thread/goal/set", {
      threadId: sessionId,
      status,
      ...(options ? { origin: options.origin } : {}),
    });
    return this.cacheGoal(sessionId, goalFromSetResponse(response));
  }

  async clearGoal(sessionId: string, options?: CodexGoalMutationOptions): Promise<boolean> {
    await this.ensureSessionLoaded(sessionId);
    const response = await this.request<Record<string, unknown>>("thread/goal/clear", {
      threadId: sessionId,
      ...(options ? { origin: options.origin } : {}),
    });
    if (response.cleared) this.cacheGoal(sessionId, null);
    return Boolean(response.cleared);
  }

  private cacheGoal<T extends CodexGoal | null>(sessionId: string, goal: T): T {
    const stored = this.sessionStore.get(sessionId);
    if (stored) {
      stored.status = { ...stored.status, goal };
      stored.updatedAt = new Date().toISOString();
    }
    return goal;
  }

  private recordEffectiveSettings(sessionId: string, value: Record<string, unknown>): void {
    const stored = this.sessionStore.get(sessionId);
    if (!stored) return;
    applyEffectiveSettings(stored, value);
    const mode = objectValue(value.collaborationMode).mode;
    if (mode === "plan" || mode === "default") this.sessionCollaborationModes.set(sessionId, mode);
  }

  async compactSession(sessionId: string): Promise<CodexCompactResult> {
    await this.ensureSessionLoaded(sessionId);
    const stored = this.sessionStore.get(sessionId);
    if (!stored) throw new Error(`app-server session not found locally: ${sessionId}`);
    if (this.compactWaiters.has(sessionId)) throw new Error("当前 session 正在压缩上下文。");
    const promise = new Promise<CodexCompactResult>((resolve, reject) => {
      const waiter: CompactWaiter = {
        sessionId,
        resolve,
        reject,
      };
      if (this.compactTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.rejectCompactWaiter(sessionId, new Error("上下文压缩超时。"));
        }, this.compactTimeoutMs);
        waiter.timer.unref?.();
      }
      this.compactWaiters.set(sessionId, waiter);
    });
    stored.status = withContext(stored, { type: "running", task: "上下文压缩", startedAt: new Date().toISOString() });
    stored.updatedAt = new Date().toISOString();
    try {
      await this.request<Record<string, unknown>>("thread/compact/start", {
        threadId: sessionId,
      });
    } catch (error) {
      const requestError = error instanceof Error ? error : new Error(String(error));
      this.rejectCompactWaiter(sessionId, requestError);
      await promise.catch(() => undefined);
      throw requestError;
    }
    return await promise;
  }

  private runPolicyForSession(sessionId?: string): CodexRunPolicy {
    return (sessionId ? this.sessionRunPolicies.get(sessionId) : undefined) ?? this.defaultRunPolicy;
  }

  private modelPolicyForSession(sessionId?: string): CodexModelPolicy {
    return (sessionId ? this.sessionModelPolicies.get(sessionId) : undefined) ?? this.defaultModelPolicy;
  }

  private ensureKnownSession(sessionId: string): void {
    if (!this.sessionStore.has(sessionId)) throw new Error(`app-server session not found locally: ${sessionId}`);
  }

  private async ensureSessionLoaded(sessionId: string): Promise<void> {
    this.ensureKnownSession(sessionId);
    await this.ensureStarted();
    if (this.loadedSessionIds.has(sessionId)) return;
    const existing = this.sessionResumePromises.get(sessionId);
    if (existing) {
      await existing;
      return;
    }
    const routeKey = this.sessionStore.get(sessionId)?.routeKey;
    const resume = this.loadSessionFromServer(sessionId, true, routeKey);
    this.sessionResumePromises.set(sessionId, resume);
    try {
      await resume;
    } finally {
      if (this.sessionResumePromises.get(sessionId) === resume) {
        this.sessionResumePromises.delete(sessionId);
      }
    }
  }

  private ensureStarted(): Promise<void> {
    return this.rpc.start();
  }

  private async request<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number; onResult?: (value: unknown) => void } = {},
  ): Promise<T> {
    try {
      return await this.rpc.request(method, params, options);
    } catch (error) {
      this.recordCwdDiagnostic(method, params, error);
      throw error;
    }
  }

  private recordCwdDiagnostic(method: string, params: unknown, error: unknown): void {
    const source = cwdDiagnosticSource(method);
    if (!source || !isInvalidCwdError(error)) return;
    const request = objectValue(params);
    const sessionId = stringValue(request.threadId) ?? stringValue(request.thread_id);
    const diagnostic: CodexCwdDiagnostic = {
      source,
      error: error instanceof Error ? error.message : String(error),
      observedAt: new Date().toISOString(),
      ...(sessionId ? { sessionId } : {}),
      requestCwd: inspectCodexCwd(stringValue(request.cwd)),
      inheritedProcessCwd: inspectCurrentProcessCwd(),
    };
    this.lastCwdDiagnostic = diagnostic;
    if (sessionId) this.cwdDiagnostics.set(sessionId, diagnostic);

    const stored = sessionId ? this.sessionStore.get(sessionId) : undefined;
    if (stored) {
      stored.status = { ...withContext(stored, { type: "failed", error: diagnostic.error }), cwdDiagnostic: diagnostic };
      stored.updatedAt = diagnostic.observedAt;
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const params = objectValue(notification.params);
    if (notification.method === "thread/reverted") {
      const threadId = stringValue(params.threadId);
      if (threadId) {
        const sessionId = this.sessionStore.resolveThreadSession(threadId);
        this.historyRevisions.set(sessionId, (this.historyRevisions.get(sessionId) ?? 0) + 1);
        this.loadedSessionIds.delete(sessionId);
        this.sessionResumePromises.delete(sessionId);
        const stored = this.sessionStore.get(sessionId);
        if (stored) {
          if (stored.currentTurnId && this.turns.get(stored.currentTurnId)) {
            this.handleNotification({ method: "turn/completed", params: { threadId, turn: { id: stored.currentTurnId, status: "interrupted" } } });
          }
          const { context: _context, ...status } = stored.status;
          stored.status = status;
          stored.updatedAt = new Date().toISOString();
        }
      }
      return;
    }
    if (notification.method === "thread/goal/updated" || notification.method === "thread/goal/cleared") {
      const threadId = stringValue(params.threadId);
      const goal = objectValueOrNull(params.goal);
      if (threadId && (goal || notification.method === "thread/goal/cleared")) {
        this.cacheGoal(this.sessionStore.resolveThreadSession(threadId), goal ? goalFromResponse({ ...goal, threadId }) : null);
      }
      return;
    }
    const turnId = stringValue(params.turnId) ?? stringValue(objectValue(params.turn).id);
    const terminal = notification.method === "turn/completed" || (notification.method === "error"
      && params.willRetry !== true && !(params.willRetry === undefined && isTransientAppServerError(appServerErrorMessage(params))));
    if (terminal && turnId) {
      for (const [id, pending] of this.pendingUserInputs) {
        if (pending.turnId !== turnId) continue;
        this.pendingUserInputs.delete(id);
        this.turns.pushTurnEvent(turnId, { type: "input.resolved", sessionId: pending.sessionId, turnId, adapterRequestId: id });
      }
      for (const [id, pending] of this.pendingApprovals) {
        if (pending.turnId !== turnId) continue;
        this.pendingApprovals.delete(id);
        this.turns.pushTurnEvent(turnId, { type: "approval.resolved", sessionId: pending.sessionId, turnId, adapterApprovalId: id });
      }
    }
    this.handleServerRequestResolvedNotification(notification);
    this.handleStatusNotification(notification);
    this.handleCompactNotification(notification);
    this.turns.handleNotification(notification);
    if (turnId && this.turns.isClosed(turnId)) {
      for (const [id, pending] of this.pendingUserInputs) if (pending.turnId === turnId) this.pendingUserInputs.delete(id);
      for (const [id, pending] of this.pendingApprovals) if (pending.turnId === turnId) this.pendingApprovals.delete(id);
    }
  }

  private handleServerRequestResolvedNotification(notification: JsonRpcNotification): void {
    if (notification.method !== "serverRequest/resolved") return;
    const params = objectValue(notification.params);
    const rawId = params.requestId !== undefined && params.requestId !== null
      ? String(params.requestId)
      : stringValue(params.id);
    if (!rawId) return;
    const requestId = this.rpc.serverRequestKey(rawId);
    const pending = this.pendingApprovals.get(requestId);
    const pendingInput = this.pendingUserInputs.get(requestId);
    if (!pending && !pendingInput) return;
    const expected = pendingInput ?? pending!;
    if (stringValue(params.threadId) && this.sessionStore.resolveThreadSession(String(params.threadId)) !== expected.sessionId) return;
    if (pendingInput) {
      this.pendingUserInputs.delete(requestId);
      const sessionId = pendingInput.sessionId;
      this.refreshInteractionStatus(sessionId, pendingInput.turnId);
      this.turns.pushTurnEvent(pendingInput.turnId, {
        type: "input.resolved",
        sessionId,
        turnId: pendingInput.turnId,
        adapterRequestId: requestId,
      });
      return;
    }
    if (!pending) return;
    this.pendingApprovals.delete(requestId);
    const sessionId = pending.sessionId;
    this.refreshInteractionStatus(sessionId, pending.turnId);
    this.turns.pushTurnEvent(pending.turnId, {
      type: "approval.resolved",
      sessionId,
      turnId: pending.turnId,
      adapterApprovalId: requestId,
    });
  }

  private refreshInteractionStatus(sessionId: string, turnId: string): void {
    const stored = this.sessionStore.get(sessionId);
    if (!stored || !this.turns.get(turnId) || (stored.currentTurnId && stored.currentTurnId !== turnId)) return;
    const approval = [...this.pendingApprovals.values()].find((p) => p.sessionId === sessionId && p.turnId === turnId);
    const input = [...this.pendingUserInputs.values()].find((p) => p.sessionId === sessionId && p.turnId === turnId && p.params.isBlocking !== false);
    const startedAt = runningStartedAt(stored.status);
    stored.status = withContext(stored, approval ? { type: "waiting_approval", detail: approval.approval.reason, startedAt }
      : input ? { type: "waiting_input", detail: "Codex 等待用户输入", startedAt }
      : { type: "running", turnId, startedAt });
    stored.updatedAt = new Date().toISOString();
  }

  private handleStatusNotification(notification: JsonRpcNotification): void {
    const params = objectValue(notification.params);
    const threadId = stringValue(params.threadId);
    const sessionId = threadId ? this.sessionStore.resolveThreadSession(threadId) : undefined;
    if (notification.method === "thread/name/updated" && sessionId) {
      const stored = this.sessionStore.get(sessionId);
      const title = stringValue(params.threadName) ?? stringValue(params.name);
      if (stored && title) {
        stored.session.title = title;
        stored.updatedAt = new Date().toISOString();
      }
      return;
    }
    if (notification.method === "thread/settings/updated" && sessionId) {
      this.recordEffectiveSettings(sessionId, objectValue(params.threadSettings));
      return;
    }
    if (notification.method === "thread/status/changed" && sessionId) {
      const stored = this.sessionStore.get(sessionId);
      const status = objectValue(params.status);
      const statusType = stringValue(status.type);
      const activeFlags = Array.isArray(status.activeFlags) ? status.activeFlags.filter((item) => typeof item === "string") : [];
      if (stored) {
        if (statusType === "idle") {
          stored.status = withContext(stored, { type: "idle" });
          stored.currentTurnId = undefined;
        } else if (statusType === "active" && activeFlags.includes("waitingOnApproval")) {
          stored.status = withContext(stored, { type: "waiting_approval", detail: "Codex 等待审批", startedAt: runningStartedAt(stored.status) });
        } else if (statusType === "active" && activeFlags.includes("waitingOnUserInput")
          && !this.onlyNonblockingInputs(sessionId)) {
          stored.status = withContext(stored, { type: "waiting_input", detail: "Codex 等待用户输入", startedAt: runningStartedAt(stored.status) });
        } else if (statusType === "active") {
          stored.status = withContext(stored, {
            type: "running",
            ...(stored.currentTurnId ? { turnId: stored.currentTurnId } : {}),
            startedAt: runningStartedAt(stored.status),
          });
        } else if (statusType === "systemError") {
          stored.status = withContext(stored, { type: "unknown", detail: "thread system error" });
          stored.currentTurnId = undefined;
        } else if (statusType === "notLoaded") {
          stored.status = withContext(stored, { type: "unknown", detail: "thread not loaded" });
          stored.currentTurnId = undefined;
        }
        stored.updatedAt = new Date().toISOString();
      }
      return;
    }
    if ((notification.method === "thread/archived" || notification.method === "thread/closed" || notification.method === "thread/deleted") && sessionId) {
      const stored = this.sessionStore.get(sessionId);
      if (stored) {
        const detail = notification.method === "thread/archived"
          ? "thread archived"
          : notification.method === "thread/deleted"
            ? "thread deleted"
            : "thread closed";
        stored.status = withContext(stored, { type: "unknown", detail });
        stored.currentTurnId = undefined;
        stored.updatedAt = new Date().toISOString();
      }
      const lifecycle = notification.method === "thread/archived"
        ? "archived"
        : notification.method === "thread/deleted"
          ? "deleted"
          : "closed";
      this.emitCodexNotification({
        method: notification.method,
        sessionId,
        turnId: this.notificationTurnId(sessionId, params, notification.method),
        kind: "lifecycle",
        lifecycle,
        unbindRoute: true,
        text: notification.method === "thread/archived"
          ? "Codex thread archived."
          : notification.method === "thread/deleted"
            ? "Codex thread deleted."
            : "Codex thread closed.",
        dedupeWindowMs: 10 * 60_000,
      });
      return;
    }
    if (notification.method === "thread/unarchived" && sessionId) {
      const stored = this.sessionStore.get(sessionId);
      if (stored && stored.status.type === "unknown" && stored.status.detail === "thread archived") {
        stored.status = withContext(stored, { type: "idle" });
        stored.updatedAt = new Date().toISOString();
      }
      return;
    }
    if (notification.method === "model/rerouted" && sessionId) {
      const stored = this.sessionStore.get(sessionId);
      const fromModel = stringValue(params.fromModel);
      const toModel = stringValue(params.toModel);
      if (stored && toModel) {
        this.recordEffectiveSettings(sessionId, { model: toModel });
      }
      this.emitCodexNotification({
        method: notification.method,
        sessionId,
        turnId: stringValue(params.turnId),
        kind: "model",
        text: [
          "Codex 模型已切换。",
          `From: ${fromModel ?? "未知"}`,
          `To: ${toModel ?? "未知"}`,
          `Reason: ${stringValue(params.reason) ?? "未知"}`,
        ].join("\n"),
        dedupeWindowMs: 10 * 60_000,
      });
      return;
    }
    if (notification.method === "model/verification" && sessionId) {
      const verifications = Array.isArray(params.verifications) ? params.verifications.map(formatNotificationValue) : [];
      if (verifications.length > 0) {
        this.emitCodexNotification({
          method: notification.method,
          sessionId,
          turnId: stringValue(params.turnId),
          kind: "security",
          text: ["Codex 模型校验：", ...verifications.map((item) => `- ${item}`)].join("\n"),
          dedupeWindowMs: 10 * 60_000,
        });
      }
      return;
    }
    if (notification.method === "model/safetyBuffering/updated" && sessionId) {
      if (params.showBufferingUi !== true) return;
      const model = stringValue(params.model);
      const fasterModel = stringValue(params.fasterModel);
      const useCases = arrayValue(params.useCases)
        .map((value) => stringValue(value))
        .filter((value): value is string => Boolean(value));
      const reasons = arrayValue(params.reasons)
        .map((value) => stringValue(value))
        .filter((value): value is string => Boolean(value));
      this.emitCodexNotification({
        method: notification.method,
        sessionId,
        turnId: stringValue(params.turnId),
        kind: "model",
        text: [
          "Codex 正在等待模型安全缓冲完成，回复可能会变慢。",
          model ? `Model: ${model}` : undefined,
          useCases.length > 0 ? `Use cases: ${useCases.join(", ")}` : undefined,
          reasons.length > 0 ? `Reasons: ${reasons.join(", ")}` : undefined,
          fasterModel ? `Faster model suggestion: ${fasterModel}` : undefined,
        ].filter(Boolean).join("\n"),
        dedupeWindowMs: 5 * 60_000,
      });
      return;
    }
    const warning = notificationText(notification.method, params);
    if (warning && sessionId) {
      this.emitCodexNotification({
        method: notification.method,
        sessionId,
        turnId: this.notificationTurnId(sessionId, params, notification.method),
        kind: warning.kind,
        text: warning.text,
        dedupeWindowMs: warning.dedupeWindowMs,
      });
    }
  }

  private handleCompactNotification(notification: JsonRpcNotification): void {
    const params = objectValue(notification.params);
    const threadId = stringValue(params.threadId);
    if (!threadId) return;
    const sessionId = this.sessionStore.resolveThreadSession(threadId);
    const waiter = this.compactWaiters.get(sessionId);
    if (!waiter) return;
    const turnId = stringValue(params.turnId) ?? stringValue(objectValue(params.turn).id);
    if (notification.method === "turn/started" && turnId && !waiter.turnId) {
      waiter.turnId = turnId;
      return;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = objectValue(params.item);
      const itemType = stringValue(item.type);
      if ((itemType === "contextCompaction" || itemType === "context_compaction") && turnId) {
        waiter.turnId = turnId;
      }
      return;
    }
    if (notification.method === "thread/compacted") {
      if (turnId) waiter.turnId = turnId;
      this.resolveCompactWaiter(sessionId);
      return;
    }
    if (notification.method === "error") {
      const error = appServerErrorMessage(params);
      if (params.willRetry === true || (params.willRetry === undefined && isTransientAppServerError(error))) return;
      if (!turnId || !waiter.turnId || waiter.turnId === turnId) {
        this.rejectCompactWaiter(sessionId, new Error(error));
      }
      return;
    }
    if (notification.method === "turn/completed" && turnId && waiter.turnId === turnId) {
      const turn = objectValue(params.turn);
      const status = stringValue(turn.status);
      if (status !== "completed") {
        const error = stringValue(objectValue(turn.error).message) ?? (status === "interrupted" ? "上下文压缩已中断" : "上下文压缩失败");
        this.rejectCompactWaiter(sessionId, new Error(error));
        return;
      }
      this.resolveCompactWaiter(sessionId);
    }
  }

  private resolveCompactWaiter(sessionId: string): void {
    const waiter = this.compactWaiters.get(sessionId);
    if (!waiter) return;
    if (waiter.timer) clearTimeout(waiter.timer);
    this.compactWaiters.delete(sessionId);
    const stored = this.sessionStore.get(sessionId);
    if (stored) {
      stored.status = withContext(stored, { type: "idle" });
      stored.currentTurnId = undefined;
      stored.updatedAt = new Date().toISOString();
    }
    waiter.resolve({ sessionId });
  }

  private rejectCompactWaiter(sessionId: string, error: Error): void {
    const waiter = this.compactWaiters.get(sessionId);
    if (!waiter) return;
    if (waiter.timer) clearTimeout(waiter.timer);
    this.compactWaiters.delete(sessionId);
    const stored = this.sessionStore.get(sessionId);
    if (stored) {
      stored.status = withContext(stored, { type: "failed", error: error.message });
      stored.currentTurnId = undefined;
      stored.updatedAt = new Date().toISOString();
    }
    waiter.reject(error);
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    const params = objectValue(request.params);
    if (request.method === "currentTime/read") {
      this.writeMessage(stringValue(params.threadId)
        ? { id: request.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } }
        : { id: request.id, error: { code: -32602, message: "currentTime/read requires threadId" } });
      return;
    }
    if (request.method === "item/tool/requestUserInput") {
      this.handleUserInputServerRequest(request, params);
      return;
    }
    const approval = approvalFromServerRequest(request.method, request.id, params);
    if (!approval) {
      const fallback = unsupportedServerRequestResponse(request.method, params);
      if (fallback.notice) this.emitProgressNotice(fallback.notice);
      this.writeMessage({
        id: request.id,
        ...(fallback.result ? { result: fallback.result } : {}),
        ...(fallback.error ? { error: fallback.error } : {}),
      });
      return;
    }
    const adapterApprovalId = this.rpc.serverRequestKey(request.id);
    approval.adapterApprovalId = adapterApprovalId;
    const turnId = approval.turnId;
    const sessionId = this.sessionStore.resolveThreadSession(approval.sessionId);
    if (approval.availableDecisions?.length === 0) {
      this.writeMessage({ id: request.id, error: { code: -32602, message: "approval has no supported decisions" } });
      this.emitCodexNotification({ method: request.method, sessionId, turnId, kind: "warning", text: "Codex 审批没有可支持的选项，已拒绝处理；请在本机 Codex 检查该请求。", dedupeWindowMs: 0 });
      return;
    }
    if (approval.kind === "terminal_input" && !approval.command?.trim()) {
      this.writeMessage({
        id: request.id,
        result: responseForApprovalDecision(request.method, params, "cancel"),
      });
      this.emitProgressNotice({
        sessionId,
        turnId,
        kind: "other",
        text: "Codex 请求向终端输入内容，但未提供可安全展示的输入；Chat-Codex 已取消该请求。",
      });
      return;
    }
    this.turns.get(turnId) ?? this.turns.createBackgroundTurn(sessionId, turnId);
    const stored = this.sessionStore.get(sessionId);
    if (stored) {
      const startedAt = runningStartedAt(stored.status);
      stored.status = withContext(stored, { type: "waiting_approval", detail: approval.reason ?? approval.kind, startedAt });
      stored.updatedAt = new Date().toISOString();
    }
    const pending: PendingServerApproval = {
      method: request.method,
      requestId: request.id,
      sessionId,
      turnId,
      approval,
      params,
      resolve: async (decision) => {
        this.writeMessage({
          id: request.id,
          result: responseForApprovalDecision(request.method, params, decision),
        });
      },
    };
    this.pendingApprovals.set(adapterApprovalId, pending);
    this.turns.pushTurnEvent(turnId, { type: "approval.requested", sessionId, turnId, approval });
  }

  private onlyNonblockingInputs(sessionId: string): boolean {
    const inputs = [...this.pendingUserInputs.values()].filter((input) => input.sessionId === sessionId);
    return inputs.length > 0 && inputs.every((input) => input.params.isBlocking === false);
  }

  private handleUserInputServerRequest(request: JsonRpcRequest, params: Record<string, unknown>): void {
    const contextSessionId = stringValue(params.threadId) ?? stringValue(params.conversationId);
    const sessionId = contextSessionId ? this.sessionStore.resolveThreadSession(contextSessionId) : undefined;
    const inputRequest = sessionId ? userInputRequestFromServerRequest(request.id, params, sessionId) : undefined;
    if (!inputRequest) {
      this.writeMessage({
        id: request.id,
        error: { code: -32602, message: "invalid item/tool/requestUserInput params" },
      });
      return;
    }
    const turnId = inputRequest.turnId;
    if (this.turns.isClosed(turnId)) {
      this.writeMessage({ id: request.id, error: { code: -32602, message: "user input belongs to a closed turn" } });
      return;
    }
    const resolvedSessionId = inputRequest.sessionId;
    this.turns.get(turnId) ?? this.turns.createBackgroundTurn(resolvedSessionId, turnId);
    const stored = this.sessionStore.get(resolvedSessionId);
    if (stored && inputRequest.isBlocking !== false) {
      const startedAt = runningStartedAt(stored.status);
      stored.status = withContext(stored, { type: "waiting_input", detail: "Codex 等待用户输入", startedAt });
      stored.updatedAt = new Date().toISOString();
    }
    const adapterRequestId = this.rpc.serverRequestKey(request.id);
    inputRequest.adapterRequestId = adapterRequestId;
    const pending: PendingServerUserInput = {
      method: request.method,
      requestId: request.id,
      sessionId: resolvedSessionId,
      turnId,
      params,
      resolve: async (response) => {
        this.writeMessage({
          id: request.id,
          result: response,
        });
      },
    };
    this.pendingUserInputs.set(adapterRequestId, pending);
    this.turns.pushTurnEvent(turnId, { type: "input.requested", sessionId: resolvedSessionId, turnId, request: inputRequest });
  }

  private handleFatalAppServerError(error: Error, diagnostic: CodexTransportDiagnostic): void {
    this.lastTransportDiagnostic = diagnostic;
    this.pendingApprovals.clear();
    this.pendingUserInputs.clear();
    this.loadedSessionIds.clear();
    this.sessionResumePromises.clear();
    for (const waiter of this.compactWaiters.values()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.compactWaiters.clear();
    this.turns.failAll(error);
  }

  private writeMessage(message: unknown): void {
    this.rpc.writeMessage(message);
  }

  private emitProgressNotice(notice: { sessionId?: string; turnId?: string; text: string; kind?: CodexProgressKind }): void {
    if (!notice.sessionId && !notice.turnId) return;
    const sessionId = notice.sessionId ? this.sessionStore.resolveThreadSession(notice.sessionId) : undefined;
    const stored = sessionId ? this.sessionStore.get(sessionId) : undefined;
    const turnId = notice.turnId ?? stored?.currentTurnId;
    if (!sessionId || !turnId) return;
    this.turns.get(turnId) ?? this.turns.createBackgroundTurn(sessionId, turnId);
    this.turns.pushTurnEvent(turnId, {
      type: "assistant.progress",
      sessionId,
      turnId,
      text: notice.text,
      kind: notice.kind,
    });
  }

  private emitCodexNotification(notification: {
    method: string;
    sessionId: string;
    turnId?: string;
    kind: "security" | "warning" | "model" | "config" | "lifecycle" | "deprecation";
    text: string;
    dedupeWindowMs: number;
    lifecycle?: "archived" | "closed" | "deleted" | "unarchived";
    unbindRoute?: boolean;
  }): void {
    const stored = this.sessionStore.get(notification.sessionId);
    const turnId = notification.turnId ?? this.notificationTurnId(notification.sessionId, {}, notification.method);
    this.turns.pushTurnOrBackgroundEvent({
      type: "codex.notification",
      sessionId: notification.sessionId,
      turnId,
      notification: {
        method: notification.method,
        kind: notification.kind,
        text: notification.text,
        dedupeKey: notificationDedupeKey(notification.method, notification.sessionId, notification.text),
        dedupeWindowMs: notification.dedupeWindowMs,
        ...(notification.lifecycle ? { lifecycle: notification.lifecycle } : {}),
        ...(notification.unbindRoute ? { unbindRoute: true } : {}),
      },
    });
    if (stored) stored.updatedAt = new Date().toISOString();
  }

  private notificationTurnId(sessionId: string, params: Record<string, unknown>, method: string): string {
    const turnId = stringValue(params.turnId);
    if (turnId) return turnId;
    const stored = this.sessionStore.get(sessionId);
    if (stored?.currentTurnId) return stored.currentTurnId;
    return `notification:${sessionId}:${method}:${Date.now()}`;
  }
}

function notificationText(method: string, params: Record<string, unknown>): { text: string; kind: "security" | "warning" | "config" | "deprecation"; dedupeWindowMs: number } | undefined {
  if (method === "warning") {
    const message = stringValue(params.message);
    return message ? { text: `Codex 警告：${message}`, kind: "warning", dedupeWindowMs: 10 * 60_000 } : undefined;
  }
  if (method === "guardianWarning") {
    const message = stringValue(params.message);
    return message ? { text: `Codex 安全提示：${message}`, kind: "security", dedupeWindowMs: 10 * 60_000 } : undefined;
  }
  if (method === "deprecationNotice") {
    const summary = stringValue(params.summary);
    const details = stringValue(params.details);
    const text = summary ? [`Codex 兼容性提示：${summary}`, details].filter(Boolean).join("\n") : undefined;
    return text ? { text, kind: "deprecation", dedupeWindowMs: 30 * 60_000 } : undefined;
  }
  if (method === "configWarning") {
    const summary = stringValue(params.summary);
    const details = stringValue(params.details);
    const configPath = stringValue(params.path);
    const text = summary ? [`Codex 配置警告：${summary}`, details, configPath ? `Path: ${configPath}` : undefined].filter(Boolean).join("\n") : undefined;
    return text ? { text, kind: "config", dedupeWindowMs: 30 * 60_000 } : undefined;
  }
  if (method === "windows/worldWritableWarning") {
    const message = stringValue(params.message) ?? stringValue(params.summary);
    return message ? { text: `Codex Windows 沙箱警告：${message}`, kind: "warning", dedupeWindowMs: 30 * 60_000 } : undefined;
  }
  return undefined;
}

function notificationDedupeKey(method: string, sessionId: string, text: string): string {
  return `${method}:${sessionId}:${text}`;
}

function formatNotificationValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function startedAtFromTurn(turn: Record<string, unknown>): string {
  return isoFromSeconds(numberValue(turn.startedAt))
    ?? isoFromMilliseconds(numberValue(turn.startedAtMs))
    ?? new Date().toISOString();
}

function isoFromMilliseconds(milliseconds: number | undefined): string | undefined {
  return milliseconds ? new Date(milliseconds).toISOString() : undefined;
}

function runningStartedAt(status: CodexSessionStatus): string | undefined {
  return "startedAt" in status ? status.startedAt : undefined;
}

function cwdDiagnosticSource(method: string): CodexCwdDiagnosticSource | undefined {
  if (method === "thread/start" || method === "thread/resume" || method === "turn/start") return method;
  return undefined;
}
