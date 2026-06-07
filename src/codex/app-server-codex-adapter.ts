import type { ApprovalDecision } from "../approvals/types.js";
import type {
  CodexAdapter,
  CodexBackgroundEventHandler,
  CodexCollaborationMode,
  CodexCompactResult,
  CodexEvent,
  CodexGoal,
  CodexGoalStatus,
  CodexModelListOptions,
  CodexModelOption,
  CodexModelPolicy,
  CodexProgressKind,
  CodexRunPolicyStatus,
  CodexSession,
  CodexSessionReloadResult,
  CodexSessionStatus,
  CodexSessionSummary,
  CodexRunOptions,
  StartSessionInput,
  CodexPromptInput,
} from "./types.js";
import { displayCodexSessionTitle, findCodexSessionById, type CodexRunPolicy } from "./codex-cli.js";
import { ensureCodexStatePreviewIfEmpty } from "./codex-state-preview.js";
import { resolveCodexCommand, type CodexCommandResolution } from "./codex-process.js";
import { codexInputText } from "./input.js";
import { approvalFromServerRequest, responseForApprovalDecision } from "./app-server/approval-handler.js";
import { goalFromResponse, goalFromSetResponse } from "./app-server/goal-api.js";
import { appServerUserInput } from "./app-server/input-mapper.js";
import { appServerErrorMessage, isTransientAppServerError } from "./app-server/notification-mapper.js";
import { unsupportedServerRequestResponse } from "./app-server/server-request-mapper.js";
import {
  cloneModelPolicy,
  modelInfoFromResponse,
  modelInfoWithPolicy,
  modelsFromListResponse,
  withoutModelInfo,
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
import type { JsonRpcNotification, JsonRpcRequest, PendingServerApproval } from "./app-server/types.js";
import { AsyncEventQueue } from "./app-server/turn-store.js";
import { isoFromSeconds, numberValue, objectValue, objectValueOrNull, stringValue } from "./app-server/value-parsers.js";

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
  private readonly compactWaiters = new Map<string, CompactWaiter>();
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
      onFatalError: (error) => this.handleFatalAppServerError(error),
    });
  }

  onBackgroundEvent(handler: CodexBackgroundEventHandler): () => void {
    return this.turns.onBackgroundEvent(handler);
  }

  async stop(): Promise<void> {
    this.turns.closeAll();
    this.pendingApprovals.clear();
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
    return session;
  }

  async resumeSession(sessionId: string): Promise<CodexSession> {
    await this.ensureStarted();
    return this.loadSessionFromServer(sessionId, false);
  }

  async reloadSession(sessionId: string): Promise<CodexSessionReloadResult> {
    const routeKey = this.sessionStore.get(sessionId)?.routeKey;
    this.restartAppServerForReload();
    const session = await this.loadSessionFromServer(sessionId, true, routeKey);
    return { session, reloadedAt: new Date().toISOString() };
  }

  private restartAppServerForReload(): void {
    if (this.turns.hasActiveTurns()) {
      throw new Error("当前 app-server 仍有运行中的 Codex turn，不能安全重启并刷新上下文。请等待当前任务结束后重试。");
    }
    this.pendingApprovals.clear();
    for (const waiter of this.compactWaiters.values()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new Error("codex app-server restarting for session reload"));
    }
    this.compactWaiters.clear();
    this.turns.closeAll();
    this.sessionStore.clear();
    this.rpc.stop();
  }

  private async loadSessionFromServer(sessionId: string, forceReload: boolean, routeKey?: string): Promise<CodexSession> {
    const stored = this.sessionStore.get(sessionId);
    if (stored && !forceReload) return stored.session;
    await this.ensureStarted();
    const discovered = findCodexSessionById(sessionId, { codexHome: this.codexHome });
    const modelPolicy = cloneModelPolicy(this.sessionModelPolicies.get(sessionId) ?? this.defaultModelPolicy);
    const runPolicy = this.runPolicyForSession(sessionId);
    const response = await this.request<Record<string, unknown>>("thread/resume", {
      threadId: sessionId,
      model: modelPolicy.model,
      serviceTier: modelPolicy.serviceTier,
      cwd: discovered?.cwd ?? undefined,
      approvalPolicy: approvalPolicyForRunPolicy(runPolicy),
      approvalsReviewer: approvalsReviewerForRunPolicy(runPolicy),
      sandbox: sandboxModeForRunPolicy(runPolicy),
    });
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
    return session;
  }

  async setSessionTitle(sessionId: string, title: string): Promise<void> {
    await this.ensureStarted();
    this.ensureKnownSession(sessionId);
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
    const stored = this.sessionStore.get(sessionId);
    if (!stored) throw new Error(`app-server session not found locally: ${sessionId}`);
    await this.ensureStarted();
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
      stored.status = withModelPolicy(stored.status, modelPolicy);
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
    const stored = this.sessionStore.get(sessionId);
    if (!stored) throw new Error(`app-server session not found locally: ${sessionId}`);
    await this.ensureStarted();
    const turnId = stored.currentTurnId;
    if (!turnId) throw new Error("no active turn to steer");
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
    stored.status = withContext(stored, { type: "idle" });
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
    const turn = this.turns.get(turnId);
    if (turn && !turn.closed) {
      turn.queue.push({ type: "turn.completed", sessionId, turnId });
      this.turns.closeTurn(turnId, "idle");
    }
    void this.request("turn/interrupt", { threadId: sessionId, turnId }, { timeoutMs: this.interruptTimeoutMs }).catch(() => undefined);
  }

  async getStatus(sessionId: string): Promise<CodexSessionStatus> {
    return this.sessionStore.getStatus(sessionId);
  }

  async listSessions(routeKey?: string): Promise<CodexSessionSummary[]> {
    return this.sessionStore.listSessions(routeKey, this.codexHome);
  }

  async resolveApproval(approvalKey: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingApprovals.get(approvalKey);
    if (!pending) throw new Error(`未找到 Codex app-server 审批请求: ${approvalKey}`);
    await pending.resolve(decision);
    this.pendingApprovals.delete(approvalKey);
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
    return {
      policy: cloneRunPolicy(policy),
      interactiveApprovals: policy.permissionMode !== "full",
      effectiveApprovalPolicy: policy.permissionMode === "full" ? "never" : "on-request",
      note: "codex app-server 会把审批请求回调给中间件，可通过微信 /OK、/P 或 /NO 处理。",
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
      const stored = this.sessionStore.get(sessionId);
      if (stored) {
        const model = modelInfoWithPolicy(stored.baseModel, next);
        stored.status = model ? { ...stored.status, model } : withoutModelInfo(stored.status);
        stored.updatedAt = new Date().toISOString();
      }
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
    await this.ensureStarted();
    this.ensureKnownSession(sessionId);
    const response = await this.request<Record<string, unknown>>("thread/goal/get", {
      threadId: sessionId,
    });
    const goal = objectValueOrNull(response.goal);
    return goal ? goalFromResponse(goal) : null;
  }

  async setGoal(sessionId: string, objective: string): Promise<CodexGoal> {
    await this.ensureStarted();
    this.ensureKnownSession(sessionId);
    const response = await this.request<Record<string, unknown>>("thread/goal/set", {
      threadId: sessionId,
      objective,
      status: "active",
    });
    return goalFromSetResponse(response);
  }

  async setGoalStatus(sessionId: string, status: CodexGoalStatus): Promise<CodexGoal> {
    await this.ensureStarted();
    this.ensureKnownSession(sessionId);
    const response = await this.request<Record<string, unknown>>("thread/goal/set", {
      threadId: sessionId,
      status,
    });
    return goalFromSetResponse(response);
  }

  async clearGoal(sessionId: string): Promise<boolean> {
    await this.ensureStarted();
    this.ensureKnownSession(sessionId);
    const response = await this.request<Record<string, unknown>>("thread/goal/clear", {
      threadId: sessionId,
    });
    return Boolean(response.cleared);
  }

  async compactSession(sessionId: string): Promise<CodexCompactResult> {
    await this.ensureStarted();
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

  private ensureStarted(): Promise<void> {
    return this.rpc.start();
  }

  private async request<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number; onResult?: (value: unknown) => void } = {},
  ): Promise<T> {
    return this.rpc.request(method, params, options);
  }

  private handleNotification(notification: JsonRpcNotification): void {
    this.handleServerRequestResolvedNotification(notification);
    this.handleStatusNotification(notification);
    this.handleCompactNotification(notification);
    this.turns.handleNotification(notification);
  }

  private handleServerRequestResolvedNotification(notification: JsonRpcNotification): void {
    if (notification.method !== "serverRequest/resolved") return;
    const params = objectValue(notification.params);
    const requestId = params.requestId !== undefined && params.requestId !== null
      ? String(params.requestId)
      : stringValue(params.id);
    if (!requestId) return;
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return;
    this.pendingApprovals.delete(requestId);
    const sessionId = this.sessionStore.resolveThreadSession(stringValue(params.threadId) ?? pending.sessionId);
    const stored = this.sessionStore.get(sessionId);
    if (stored) {
      stored.status = withContext(stored, { type: "running", turnId: pending.turnId, startedAt: runningStartedAt(stored.status) });
      stored.updatedAt = new Date().toISOString();
    }
    this.turns.pushTurnEvent(pending.turnId, {
      type: "approval.resolved",
      sessionId,
      turnId: pending.turnId,
      adapterApprovalId: requestId,
    });
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
      const stored = this.sessionStore.get(sessionId);
      const settings = objectValue(params.threadSettings);
      if (stored) {
        const cwd = stringValue(settings.cwd);
        if (cwd) stored.session.cwd = cwd;
        const model = stringValue(settings.model);
        const provider = stringValue(settings.modelProvider);
        const serviceTier = Object.prototype.hasOwnProperty.call(settings, "serviceTier")
          ? stringValue(settings.serviceTier) ?? null
          : undefined;
        const reasoningEffort = Object.prototype.hasOwnProperty.call(settings, "effort")
          ? stringValue(settings.effort) ?? null
          : undefined;
        const baseModel = model || provider || serviceTier !== undefined || reasoningEffort !== undefined
          ? {
              ...(model ? { model } : {}),
              ...(provider ? { provider } : {}),
              ...(serviceTier !== undefined ? { serviceTier } : {}),
              ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
            }
          : undefined;
        if (baseModel) {
          stored.baseModel = baseModel;
          const modelWithPolicy = modelInfoWithPolicy(baseModel, this.modelPolicyForSession(sessionId));
          stored.status = modelWithPolicy ? { ...stored.status, model: modelWithPolicy } : withoutModelInfo(stored.status);
        }
        stored.updatedAt = new Date().toISOString();
      }
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
        } else if (statusType === "active" && activeFlags.includes("waitingOnUserInput")) {
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
    if ((notification.method === "thread/archived" || notification.method === "thread/closed") && sessionId) {
      const stored = this.sessionStore.get(sessionId);
      if (stored) {
        const detail = notification.method === "thread/archived" ? "thread archived" : "thread closed";
        stored.status = withContext(stored, { type: "unknown", detail });
        stored.currentTurnId = undefined;
        stored.updatedAt = new Date().toISOString();
      }
      this.emitCodexNotification({
        method: notification.method,
        sessionId,
        turnId: this.notificationTurnId(sessionId, params, notification.method),
        kind: "lifecycle",
        lifecycle: notification.method === "thread/archived" ? "archived" : "closed",
        unbindRoute: true,
        text: notification.method === "thread/archived" ? "Codex thread archived." : "Codex thread closed.",
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
        stored.status = {
          ...stored.status,
          model: { ...(stored.status.model ?? {}), model: toModel },
        };
        stored.updatedAt = new Date().toISOString();
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
      if (isTransientAppServerError(error)) return;
      if (!turnId || !waiter.turnId || waiter.turnId === turnId) {
        this.rejectCompactWaiter(sessionId, new Error(error));
      }
      return;
    }
    if (notification.method === "turn/completed" && turnId && waiter.turnId === turnId) {
      const turn = objectValue(params.turn);
      const status = stringValue(turn.status);
      if (status === "failed") {
        const error = stringValue(objectValue(turn.error).message) ?? "上下文压缩失败";
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
    const adapterApprovalId = String(request.id);
    const turnId = approval.turnId;
    const sessionId = this.sessionStore.resolveThreadSession(approval.sessionId);
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
      params,
      resolve: async (decision) => {
        this.writeMessage({
          id: request.id,
          result: responseForApprovalDecision(request.method, params, decision),
        });
        const current = this.sessionStore.get(sessionId);
        if (current) {
          current.status = withContext(current, { type: "running", turnId, startedAt: runningStartedAt(current.status) });
          current.updatedAt = new Date().toISOString();
        }
      },
    };
    this.pendingApprovals.set(adapterApprovalId, pending);
    this.turns.pushTurnEvent(turnId, { type: "approval.requested", sessionId, turnId, approval });
  }

  private handleFatalAppServerError(error: Error): void {
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
    lifecycle?: "archived" | "closed" | "unarchived";
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
