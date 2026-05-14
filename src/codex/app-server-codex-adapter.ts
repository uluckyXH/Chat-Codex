import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalKind, ApprovalRequest } from "../approvals/types.js";
import type {
  CodexAdapter,
  CodexEvent,
  CodexProgressKind,
  CodexRunPolicyStatus,
  CodexSession,
  CodexSessionBaseStatus,
  CodexSessionContextUsage,
  CodexSessionStatus,
  CodexSessionSummary,
  StartSessionInput,
} from "./types.js";
import { discoverCodexSessions, displayCodexSessionTitle, findCodexSessionById, type CodexRunPolicy, type CodexSandboxMode } from "./codex-cli.js";

export interface AppServerCodexAdapterOptions {
  codexBin?: string;
  runPolicy?: CodexRunPolicy;
  codexHome?: string;
  requestTimeoutMs?: number;
  interruptTimeoutMs?: number;
}

interface AppServerSessionRecord {
  session: CodexSession;
  routeKey?: string;
  status: CodexSessionStatus;
  updatedAt: string;
  currentTurnId?: string;
}

interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface PendingResponse {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingServerApproval {
  method: string;
  requestId: string | number;
  sessionId: string;
  turnId: string;
  params: Record<string, unknown>;
  resolve: (decision: ApprovalDecision) => Promise<void>;
}

interface TurnQueueRecord {
  sessionId: string;
  turnId: string;
  queue: AsyncEventQueue<CodexEvent>;
  finalText: string;
  progressDrafts: Map<string, ProgressDraft>;
  agentMessagePhases: Map<string, "commentary" | "final_answer">;
  emittedProgressItemIds: Set<string>;
  emittedProgress: Set<string>;
  closed: boolean;
}

interface ProgressDraft {
  kind: CodexProgressKind;
  text: string;
  prefix?: string;
}

export class AppServerCodexAdapter implements CodexAdapter {
  private readonly codexBin: string;
  private runPolicy: CodexRunPolicy;
  private readonly codexHome?: string;
  private readonly requestTimeoutMs: number;
  private readonly interruptTimeoutMs: number;
  private readonly sessions = new Map<string, AppServerSessionRecord>();
  private readonly pendingResponses = new Map<string, PendingResponse>();
  private readonly pendingApprovals = new Map<string, PendingServerApproval>();
  private readonly turnQueues = new Map<string, TurnQueueRecord>();
  private readonly earlyTurnEvents = new Map<string, CodexEvent[]>();
  private readonly closedTurnIds = new Set<string>();
  private readonly threadToSession = new Map<string, string>();
  private requestSequence = 0;
  private child?: ChildProcess;
  private stdoutLines?: ReadlineInterface;
  private stderr = "";
  private initialized?: Promise<void>;
  private stopping = false;

  constructor(options: AppServerCodexAdapterOptions = {}) {
    this.codexBin = options.codexBin ?? "codex";
    this.runPolicy = options.runPolicy ?? { permissionMode: "approval", sandbox: "workspace-write" };
    this.codexHome = options.codexHome;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.interruptTimeoutMs = options.interruptTimeoutMs ?? 1500;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const turn of this.turnQueues.values()) {
      turn.queue.close();
    }
    this.turnQueues.clear();
    this.pendingApprovals.clear();
    this.closedTurnIds.clear();
    for (const pending of this.pendingResponses.values()) {
      pending.reject(new Error("codex app-server stopped"));
    }
    this.pendingResponses.clear();
    this.stdoutLines?.close();
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
    this.child = undefined;
    this.initialized = undefined;
  }

  async startSession(input: StartSessionInput): Promise<CodexSession> {
    await this.ensureStarted();
    const response = await this.request<Record<string, unknown>>("thread/start", {
      cwd: input.cwd,
      approvalPolicy: approvalPolicyForRunPolicy(this.runPolicy),
      approvalsReviewer: approvalsReviewerForRunPolicy(this.runPolicy),
      sandbox: sandboxModeForRunPolicy(this.runPolicy),
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
    this.sessions.set(session.id, {
      session,
      routeKey: input.routeKey,
      status: { type: "idle" },
      updatedAt: new Date().toISOString(),
    });
    this.threadToSession.set(threadId, session.id);
    return session;
  }

  async resumeSession(sessionId: string): Promise<CodexSession> {
    await this.ensureStarted();
    const stored = this.sessions.get(sessionId);
    if (stored) return stored.session;
    const discovered = findCodexSessionById(sessionId, { codexHome: this.codexHome });
    const response = await this.request<Record<string, unknown>>("thread/resume", {
      threadId: sessionId,
      cwd: discovered?.cwd ?? undefined,
      approvalPolicy: approvalPolicyForRunPolicy(this.runPolicy),
      approvalsReviewer: approvalsReviewerForRunPolicy(this.runPolicy),
      sandbox: sandboxModeForRunPolicy(this.runPolicy),
    });
    const thread = objectValue(response.thread);
    const cwd = stringValue(response.cwd) ?? stringValue(thread.cwd) ?? discovered?.cwd ?? process.cwd();
    const session: CodexSession = {
      id: sessionId,
      cwd,
      title: stringValue(thread.name) ?? (discovered ? displayCodexSessionTitle(discovered) : undefined) ?? `codex:${sessionId}`,
      createdAt: isoFromSeconds(numberValue(thread.createdAt)) ?? discovered?.updatedAt ?? new Date().toISOString(),
    };
    this.sessions.set(session.id, {
      session,
      status: { type: "idle" },
      updatedAt: new Date().toISOString(),
    });
    this.threadToSession.set(sessionId, session.id);
    return session;
  }

  async *run(sessionId: string, prompt: string): AsyncIterable<CodexEvent> {
    const stored = this.sessions.get(sessionId);
    if (!stored) throw new Error(`app-server session not found locally: ${sessionId}`);
    await this.ensureStarted();
    const turnResponse = await this.request<Record<string, unknown>>("turn/start", {
      threadId: sessionId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd: stored.session.cwd,
      approvalPolicy: approvalPolicyForRunPolicy(this.runPolicy),
      approvalsReviewer: approvalsReviewerForRunPolicy(this.runPolicy),
      sandboxPolicy: sandboxPolicyForRunPolicy(this.runPolicy, stored.session.cwd),
    });
    const turn = objectValue(turnResponse.turn);
    const turnId = stringValue(turn.id) ?? `app-server-turn-${Date.now()}`;
    const queue = new AsyncEventQueue<CodexEvent>();
    this.closedTurnIds.delete(turnId);
    this.turnQueues.set(turnId, {
      sessionId,
      turnId,
      queue,
      finalText: "",
      progressDrafts: new Map(),
      agentMessagePhases: new Map(),
      emittedProgressItemIds: new Set(),
      emittedProgress: new Set(),
      closed: false,
    });
    for (const event of this.earlyTurnEvents.get(turnId) ?? []) {
      queue.push(event);
    }
    this.earlyTurnEvents.delete(turnId);
    stored.status = withContext(stored, { type: "running", turnId, task: truncatePrompt(prompt) });
    stored.currentTurnId = turnId;
    stored.updatedAt = new Date().toISOString();
    yield { type: "turn.started", sessionId, turnId };

    for await (const event of queue) {
      yield event;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const stored = this.sessions.get(sessionId);
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
    const turn = this.turnQueues.get(turnId);
    if (turn && !turn.closed) {
      turn.queue.push({ type: "turn.completed", sessionId, turnId });
      this.closeTurn(turnId, "idle");
    }
    void this.request("turn/interrupt", { threadId: sessionId, turnId }, { timeoutMs: this.interruptTimeoutMs }).catch(() => undefined);
  }

  async getStatus(sessionId: string): Promise<CodexSessionStatus> {
    return this.sessions.get(sessionId)?.status ?? { type: "unknown", detail: "session not found" };
  }

  async listSessions(routeKey?: string): Promise<CodexSessionSummary[]> {
    const localSessions = [...this.sessions.values()].filter((record) => (routeKey ? record.routeKey === routeKey : true)).map((record) => ({
      id: record.session.id,
      routeKey: record.routeKey,
      title: record.session.title,
      cwd: record.session.cwd,
      status: record.status,
      updatedAt: record.updatedAt,
    }));
    if (routeKey) return localSessions;

    const seen = new Set(localSessions.map((session) => session.id));
    const discoveredSessions = discoverCodexSessions({ codexHome: this.codexHome })
      .filter((session) => !seen.has(session.id))
      .map((session) => ({
        id: session.id,
        title: displayCodexSessionTitle(session),
        cwd: session.cwd,
        status: { type: "unknown" as const, detail: "history" },
        updatedAt: session.updatedAt ?? "",
      }));
    return [...localSessions, ...discoveredSessions];
  }

  async resolveApproval(approvalKey: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingApprovals.get(approvalKey);
    if (!pending) throw new Error(`未找到 Codex app-server 审批请求: ${approvalKey}`);
    await pending.resolve(decision);
    this.pendingApprovals.delete(approvalKey);
  }

  getRunPolicy(): CodexRunPolicy {
    return { ...this.runPolicy };
  }

  setRunPolicy(policy: CodexRunPolicy): void {
    this.runPolicy = { ...policy };
  }

  getRunPolicyStatus(): CodexRunPolicyStatus {
    return {
      policy: this.getRunPolicy(),
      interactiveApprovals: this.runPolicy.permissionMode !== "full",
      effectiveApprovalPolicy: this.runPolicy.permissionMode === "full" ? "never" : "on-request",
      note: "codex app-server 会把审批请求回调给中间件，可通过微信 /OK 或 /NO [理由] 处理。",
    };
  }

  private ensureStarted(): Promise<void> {
    this.initialized ??= this.startProcessAndInitialize();
    return this.initialized;
  }

  private async startProcessAndInitialize(): Promise<void> {
    this.stopping = false;
    this.stderr = "";
    this.child = spawn(this.codexBin, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.child.on("error", (error) => {
      if (this.stopping) {
        this.pendingResponses.clear();
        this.turnQueues.clear();
        this.closedTurnIds.clear();
        this.initialized = undefined;
        this.child = undefined;
        return;
      }
      for (const pending of this.pendingResponses.values()) pending.reject(error);
      this.pendingResponses.clear();
      for (const turn of this.turnQueues.values()) {
        turn.queue.push({ type: "turn.failed", sessionId: turn.sessionId, turnId: turn.turnId, error: error.message });
        turn.queue.close();
      }
      this.turnQueues.clear();
      this.closedTurnIds.clear();
      this.initialized = undefined;
      this.child = undefined;
    });
    this.child.on("close", (code) => {
      if (this.stopping) {
        this.pendingResponses.clear();
        this.turnQueues.clear();
        this.closedTurnIds.clear();
        this.initialized = undefined;
        this.child = undefined;
        return;
      }
      const error = new Error(this.stderr.trim() || `codex app-server exited with code ${code}`);
      for (const pending of this.pendingResponses.values()) pending.reject(error);
      this.pendingResponses.clear();
      for (const turn of this.turnQueues.values()) {
        turn.queue.push({ type: "turn.failed", sessionId: turn.sessionId, turnId: turn.turnId, error: error.message });
        turn.queue.close();
      }
      this.turnQueues.clear();
      this.closedTurnIds.clear();
      this.initialized = undefined;
      this.child = undefined;
    });
    if (!this.child.stdout || !this.child.stdin) throw new Error("failed to start codex app-server stdio");
    this.stdoutLines = createInterface({ input: this.child.stdout });
    void this.readLoop();
    await this.request("initialize", {
      clientInfo: {
        name: "codex-chat-bridge",
        title: "Codex Chat Bridge",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [
          "command/exec/outputDelta",
          "item/reasoning/textDelta",
        ],
      },
    });
    this.writeMessage({ method: "initialized" });
  }

  private async request<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    await this.ensureChildOpen();
    const id = `ccbridge-${++this.requestSequence}`;
    const message: JsonRpcRequest = { id, method, ...(params !== undefined ? { params } : {}) };
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<T>((resolve, reject) => {
      this.pendingResponses.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pendingResponses.delete(id);
          reject(new Error(`codex app-server request timed out: ${method}`));
        }, timeoutMs);
        timer.unref?.();
      }
    });
    try {
      this.writeMessage(message);
    } catch (error) {
      if (timer) clearTimeout(timer);
      this.pendingResponses.delete(id);
      throw error;
    }
    return promise;
  }

  private async ensureChildOpen(): Promise<void> {
    if (!this.child?.stdin || this.child.killed) {
      throw new Error("codex app-server is not running");
    }
  }

  private async readLoop(): Promise<void> {
    if (!this.stdoutLines) return;
    try {
      for await (const line of this.stdoutLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const message = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;
        void this.handleMessage(message);
      }
    } catch (error) {
      if (this.stopping) return;
      const message = error instanceof Error ? error.message : String(error);
      for (const pending of this.pendingResponses.values()) pending.reject(new Error(message));
      this.pendingResponses.clear();
    }
  }

  private async handleMessage(message: JsonRpcResponse | JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if ("id" in message && "method" in message) {
      await this.handleServerRequest(message);
      return;
    }
    if ("id" in message) {
      const pending = this.pendingResponses.get(String(message.id));
      if (!pending) return;
      this.pendingResponses.delete(String(message.id));
      if ("error" in message && message.error) {
        pending.reject(new Error(message.error.message ?? `JSON-RPC error ${message.error.code ?? ""}`.trim()));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if ("method" in message) {
      this.handleNotification(message);
    }
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    const params = objectValue(request.params);
    const approval = this.approvalFromServerRequest(request.method, request.id, params);
    if (!approval) {
      this.writeMessage({ id: request.id, error: { code: -32601, message: `unsupported server request: ${request.method}` } });
      return;
    }
    const adapterApprovalId = String(request.id);
    const turnId = approval.turnId;
    const sessionId = this.threadToSession.get(approval.sessionId) ?? approval.sessionId;
    const turn = this.turnQueues.get(turnId);
    const stored = this.sessions.get(sessionId);
    if (stored) {
      stored.status = withContext(stored, { type: "waiting_approval", detail: approval.reason ?? approval.kind });
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
        const current = this.sessions.get(sessionId);
        if (current) {
          current.status = withContext(current, { type: "running", turnId });
          current.updatedAt = new Date().toISOString();
        }
      },
    };
    this.pendingApprovals.set(adapterApprovalId, pending);
    this.pushTurnEvent(turnId, { type: "approval.requested", sessionId, turnId, approval });
  }

  private approvalFromServerRequest(
    method: string,
    requestId: string | number,
    params: Record<string, unknown>,
  ): ApprovalRequest | undefined {
    const kind = approvalKindForMethod(method);
    if (!kind) return undefined;
    const threadId = stringValue(params.threadId) ?? stringValue(params.conversationId) ?? "unknown-thread";
    const turnId = stringValue(params.turnId) ?? stringValue(params.callId) ?? "unknown-turn";
    const itemId = stringValue(params.itemId) ?? stringValue(params.callId) ?? String(requestId);
    const command = stringValue(params.command) ?? arrayValue(params.command).filter((part) => typeof part === "string").join(" ");
    const cwd = stringValue(params.cwd) ?? stringValue(params.grantRoot);
    const reason = stringValue(params.reason);
    return {
      kind,
      adapterApprovalId: String(requestId),
      sessionId: threadId,
      turnId,
      itemId,
      command,
      cwd,
      reason,
      risk: command && riskyCommand(command) ? "high" : undefined,
      availableDecisions: ["approve", "approve-session", "deny", "cancel"],
      raw: params,
    };
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const params = objectValue(notification.params);
    const threadId = stringValue(params.threadId);
    const turnId = stringValue(params.turnId) ?? stringValue(objectValue(params.turn).id);
    if (!turnId) return;
    const turn = this.turnQueues.get(turnId);
    const sessionId = (threadId ? this.threadToSession.get(threadId) : undefined) ?? turn?.sessionId ?? threadId;
    if (!sessionId) return;

    if (notification.method === "turn/started") {
      const stored = this.sessions.get(sessionId);
      if (stored) {
        stored.status = withContext(stored, { type: "running", turnId });
        stored.currentTurnId = turnId;
        stored.updatedAt = new Date().toISOString();
      }
      return;
    }
    if (notification.method === "thread/tokenUsage/updated") {
      const stored = this.sessions.get(sessionId);
      if (stored) {
        const context = parseTokenUsage(objectValue(params.tokenUsage));
        if (context) {
          stored.status = { ...stored.status, context };
          stored.updatedAt = new Date().toISOString();
        }
      }
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      const delta = stringValue(params.delta);
      if (!delta) return;
      const itemId = stringValue(params.itemId);
      const phase = itemId && turn ? turn.agentMessagePhases.get(itemId) : undefined;
      if (turn && itemId && phase === "commentary") {
        this.appendProgressDelta(turn, sessionId, turnId, itemId, delta, "other");
        return;
      }
      if (turn) turn.finalText += delta;
      this.pushTurnEvent(turnId, { type: "assistant.delta", sessionId, turnId, text: delta });
      return;
    }
    if (notification.method === "item/reasoning/summaryTextDelta") {
      const delta = stringValue(params.delta);
      const itemId = stringValue(params.itemId);
      if (turn && itemId && delta) this.appendProgressDelta(turn, sessionId, turnId, itemId, delta, "reasoning");
      return;
    }
    if (notification.method === "item/reasoning/summaryPartAdded") {
      const itemId = stringValue(params.itemId);
      if (turn && itemId) this.flushProgressDraft(turn, sessionId, turnId, itemId);
      return;
    }
    if (notification.method === "turn/plan/updated") {
      const text = textFromPlan(params);
      if (turn && text) this.pushProgressEvent(turn, sessionId, turnId, `计划更新: ${text}`, "todo");
      return;
    }
    if (notification.method === "item/started") {
      if (!turn) return;
      this.handleItemStarted(turn, sessionId, turnId, objectValue(params.item));
      return;
    }
    if (notification.method === "item/plan/delta") {
      const delta = stringValue(params.delta);
      const itemId = stringValue(params.itemId);
      if (turn && itemId && delta) this.appendProgressDelta(turn, sessionId, turnId, itemId, delta, "todo", "计划更新: ");
      return;
    }
    if (notification.method === "item/commandExecution/outputDelta") {
      const delta = stringValue(params.delta);
      if (delta) this.pushTurnEvent(turnId, { type: "assistant.progress", sessionId, turnId, text: delta, kind: "command" });
      return;
    }
    if (notification.method === "item/completed") {
      if (!turn) return;
      this.handleItemCompleted(turn, sessionId, turnId, objectValue(params.item));
      return;
    }
    if (notification.method === "error") {
      const error = appServerErrorMessage(params);
      if (isTransientAppServerError(error)) {
        const text = `Codex 连接恢复中: ${error}`;
        if (turn) {
          this.pushProgressEvent(turn, sessionId, turnId, text, "other");
        } else {
          this.pushTurnEvent(turnId, { type: "assistant.progress", sessionId, turnId, text, kind: "other" });
        }
        return;
      }
      this.pushTurnEvent(turnId, { type: "turn.failed", sessionId, turnId, error });
      this.closeTurn(turnId, "failed", error);
      return;
    }
    if (notification.method === "turn/completed") {
      if (!turn) {
        this.pushTurnEvent(turnId, { type: "turn.completed", sessionId, turnId });
        return;
      }
      const turnPayload = objectValue(params.turn);
      const status = stringValue(turnPayload.status);
      if (status === "failed") {
        const error = stringValue(objectValue(turnPayload.error).message) ?? "codex turn failed";
        this.pushTurnEvent(turnId, { type: "turn.failed", sessionId, turnId, error });
        this.closeTurn(turnId, "failed", error);
      } else {
        if (turn.finalText) {
          this.pushTurnEvent(turnId, { type: "assistant.completed", sessionId, turnId, text: turn.finalText });
        }
        this.pushTurnEvent(turnId, { type: "turn.completed", sessionId, turnId });
        this.closeTurn(turnId, "idle");
      }
    }
  }

  private pushTurnEvent(turnId: string, event: CodexEvent): void {
    if (this.closedTurnIds.has(turnId)) return;
    const turn = this.turnQueues.get(turnId);
    if (turn && !turn.closed) {
      turn.queue.push(event);
      return;
    }
    const early = this.earlyTurnEvents.get(turnId) ?? [];
    early.push(event);
    this.earlyTurnEvents.set(turnId, early);
  }

  private handleItemCompleted(turn: TurnQueueRecord, sessionId: string, turnId: string, item: Record<string, unknown>): void {
    const itemType = stringValue(item.type);
    const itemId = stringValue(item.id);
    if (itemId) this.flushProgressDraft(turn, sessionId, turnId, itemId);
    if (itemType === "agentMessage") {
      const text = stringValue(item.text);
      const phase = messagePhaseValue(item.phase);
      if (phase === "commentary") {
        if (text) this.pushProgressEvent(turn, sessionId, turnId, text, "other");
        return;
      }
      if (text) {
        turn.finalText = text;
        turn.queue.push({ type: "assistant.completed", sessionId, turnId, text });
      }
      return;
    }
    if (itemType === "reasoning") {
      if (itemId && turn.emittedProgressItemIds.has(itemId)) return;
      const text = [...arrayValue(item.summary), ...arrayValue(item.content)]
        .map((entry) => typeof entry === "string" ? entry : undefined)
        .filter((entry): entry is string => Boolean(entry))
        .join("\n")
        .trim();
      if (text) this.pushProgressEvent(turn, sessionId, turnId, text, "reasoning");
      return;
    }
    if (itemType === "plan") {
      if (itemId && turn.emittedProgressItemIds.has(itemId)) return;
      const text = stringValue(item.text);
      if (text) this.pushProgressEvent(turn, sessionId, turnId, `计划更新: ${text}`, "todo");
      return;
    }
    const progress = progressFromThreadItem(item);
    if (progress) {
      this.pushProgressEvent(turn, sessionId, turnId, progress.text, progress.kind);
    }
  }

  private handleItemStarted(turn: TurnQueueRecord, sessionId: string, turnId: string, item: Record<string, unknown>): void {
    const itemType = stringValue(item.type);
    if (itemType === "reasoning") {
      this.pushProgressEvent(turn, sessionId, turnId, "正在分析...", "reasoning");
    } else if (itemType === "plan") {
      this.pushProgressEvent(turn, sessionId, turnId, "正在规划...", "todo");
    } else if (itemType === "agentMessage") {
      const itemId = stringValue(item.id);
      const phase = messagePhaseValue(item.phase);
      if (itemId && phase) turn.agentMessagePhases.set(itemId, phase);
    }
  }

  private appendProgressDelta(
    turn: TurnQueueRecord,
    sessionId: string,
    turnId: string,
    itemId: string,
    delta: string,
    kind: CodexProgressKind,
    prefix?: string,
  ): void {
    const draft = turn.progressDrafts.get(itemId) ?? { kind, text: "", prefix };
    draft.text += delta;
    draft.kind = kind;
    draft.prefix = prefix;
    turn.progressDrafts.set(itemId, draft);
    if (shouldFlushProgressDraft(draft.text)) {
      this.flushProgressDraft(turn, sessionId, turnId, itemId);
    }
  }

  private flushProgressDraft(turn: TurnQueueRecord, sessionId: string, turnId: string, itemId: string): void {
    const draft = turn.progressDrafts.get(itemId);
    if (!draft) return;
    turn.progressDrafts.delete(itemId);
    const text = draft.text.trim();
    if (!text) return;
    turn.emittedProgressItemIds.add(itemId);
    this.pushProgressEvent(turn, sessionId, turnId, `${draft.prefix ?? ""}${text}`, draft.kind);
  }

  private pushProgressEvent(
    turn: TurnQueueRecord,
    sessionId: string,
    turnId: string,
    text: string,
    kind: CodexProgressKind,
  ): void {
    const normalized = text.trim();
    if (!normalized || turn.emittedProgress.has(normalized)) return;
    turn.emittedProgress.add(normalized);
    turn.queue.push({ type: "assistant.progress", sessionId, turnId, text: normalized, kind });
  }

  private closeTurn(turnId: string, status: "idle" | "failed", error?: string): void {
    const turn = this.turnQueues.get(turnId);
    if (!turn || turn.closed) return;
    turn.closed = true;
    const stored = this.sessions.get(turn.sessionId);
    if (stored) {
      stored.status = status === "failed" && error ? withContext(stored, { type: "failed", error }) : withContext(stored, { type: "idle" });
      stored.currentTurnId = undefined;
      stored.updatedAt = new Date().toISOString();
    }
    turn.queue.close();
    this.turnQueues.delete(turnId);
    this.closedTurnIds.add(turnId);
  }

  private writeMessage(message: unknown): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error("codex app-server stdin is closed");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

function approvalPolicyForRunPolicy(policy: CodexRunPolicy): "on-request" | "never" {
  return policy.permissionMode === "full" ? "never" : "on-request";
}

function approvalsReviewerForRunPolicy(policy: CodexRunPolicy): "user" | null {
  return policy.permissionMode === "full" ? null : "user";
}

function sandboxModeForRunPolicy(policy: CodexRunPolicy): CodexSandboxMode {
  return policy.permissionMode === "full" ? "danger-full-access" : policy.sandbox ?? "workspace-write";
}

function sandboxPolicyForRunPolicy(policy: CodexRunPolicy, cwd: string): Record<string, unknown> {
  if (policy.permissionMode === "full") return { type: "dangerFullAccess" };
  const sandbox = policy.sandbox ?? "workspace-write";
  if (sandbox === "read-only") return { type: "readOnly", networkAccess: false };
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function approvalKindForMethod(method: string): ApprovalKind | undefined {
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") return "command";
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") return "file_change";
  if (method === "item/permissions/requestApproval") return "permissions";
  return undefined;
}

function responseForApprovalDecision(method: string, params: Record<string, unknown>, decision: ApprovalDecision): Record<string, unknown> {
  if (method === "item/permissions/requestApproval") {
    const scope = decision === "approve-session" ? "session" : "turn";
    const permissions = decision === "approve" || decision === "approve-session" ? grantedPermissionsFromRequest(params) : {};
    return { permissions, scope };
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: legacyReviewDecision(decision) };
  }
  return { decision: appServerDecision(decision) };
}

function withContext(record: AppServerSessionRecord, status: CodexSessionBaseStatus): CodexSessionStatus {
  return record.status.context ? { ...status, context: record.status.context } : status;
}

function parseTokenUsage(value: Record<string, unknown>): CodexSessionContextUsage | undefined {
  const total = parseTokenUsageBreakdown(objectValue(value.total));
  const last = parseTokenUsageBreakdown(objectValue(value.last));
  if (!total || !last) return undefined;
  return {
    total,
    last,
    modelContextWindow: numberValue(value.modelContextWindow) ?? null,
  };
}

function parseTokenUsageBreakdown(value: Record<string, unknown>): CodexSessionContextUsage["total"] | undefined {
  const totalTokens = numberValue(value.totalTokens);
  const inputTokens = numberValue(value.inputTokens);
  const cachedInputTokens = numberValue(value.cachedInputTokens);
  const outputTokens = numberValue(value.outputTokens);
  const reasoningOutputTokens = numberValue(value.reasoningOutputTokens);
  if (
    totalTokens === undefined
    || inputTokens === undefined
    || cachedInputTokens === undefined
    || outputTokens === undefined
    || reasoningOutputTokens === undefined
  ) {
    return undefined;
  }
  return { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens };
}

function messagePhaseValue(value: unknown): "commentary" | "final_answer" | undefined {
  return value === "commentary" || value === "final_answer" ? value : undefined;
}

function appServerDecision(decision: ApprovalDecision): "accept" | "acceptForSession" | "decline" | "cancel" {
  if (decision === "approve") return "accept";
  if (decision === "approve-session") return "acceptForSession";
  if (decision === "deny") return "decline";
  return "cancel";
}

function legacyReviewDecision(decision: ApprovalDecision): "approved" | "approved_for_session" | "denied" | "abort" {
  if (decision === "approve") return "approved";
  if (decision === "approve-session") return "approved_for_session";
  if (decision === "deny") return "denied";
  return "abort";
}

function grantedPermissionsFromRequest(params: Record<string, unknown>): Record<string, unknown> {
  const requested = objectValue(params.permissions);
  const granted: Record<string, unknown> = {};
  if (requested.network !== undefined && requested.network !== null) granted.network = requested.network;
  if (requested.fileSystem !== undefined && requested.fileSystem !== null) granted.fileSystem = requested.fileSystem;
  return granted;
}

function progressFromThreadItem(item: Record<string, unknown>): { text: string; kind: CodexProgressKind } | undefined {
  const itemType = stringValue(item.type);
  if (itemType === "commandExecution") {
    const command = stringValue(item.command);
    const output = stringValue(item.aggregatedOutput);
    const status = stringValue(item.status);
    if (!command) return undefined;
    const label = status === "failed" ? "命令失败" : "命令完成";
    return { text: output ? `${label}: ${command}\n输出:\n${output.trim()}` : `${label}: ${command}`, kind: "command" };
  }
  if (itemType === "fileChange") {
    const changes = arrayValue(item.changes)
      .map((entry) => stringValue(objectValue(entry).path) ?? stringValue(objectValue(entry).absolutePath))
      .filter(Boolean)
      .slice(0, 5)
      .join(", ");
    return changes ? { text: `文件变更完成: ${changes}`, kind: "file_change" } : undefined;
  }
  if (itemType === "mcpToolCall") {
    const tool = [stringValue(item.server), stringValue(item.tool)].filter(Boolean).join("/");
    return tool ? { text: `工具调用完成: ${tool}`, kind: "tool" } : undefined;
  }
  if (itemType === "webSearch") {
    const query = stringValue(item.query);
    return query ? { text: `搜索完成: ${query}`, kind: "search" } : undefined;
  }
  if (itemType === "imageView" || itemType === "imageGeneration") {
    const path = stringValue(item.path) ?? stringValue(item.savedPath) ?? stringValue(item.result);
    return path ? { text: `媒体生成完成: ${path}`, kind: "file_change" } : undefined;
  }
  return undefined;
}

function textFromPlan(params: Record<string, unknown>): string | undefined {
  const plan = arrayValue(params.plan);
  const active = plan
    .map((entry) => {
      const object = objectValue(entry);
      return stringValue(object.step) ?? stringValue(object.text) ?? (typeof entry === "string" ? entry : undefined);
    })
    .filter(Boolean)
    .at(-1);
  return active;
}

function shouldFlushProgressDraft(text: string): boolean {
  const normalized = text.trim();
  return normalized.length >= 80 || /[。！？.!?]\s*$/.test(normalized) || normalized.includes("\n");
}

function appServerErrorMessage(params: Record<string, unknown>): string {
  return stringValue(objectValue(params.error).message)
    ?? stringValue(params.message)
    ?? "codex app-server error";
}

function isTransientAppServerError(message: string): boolean {
  return /^Reconnecting\.\.\.\s+\d+\/\d+/i.test(message.trim());
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isoFromSeconds(seconds: number | undefined): string | undefined {
  return seconds ? new Date(seconds * 1000).toISOString() : undefined;
}

function riskyCommand(command: string): boolean {
  return /\b(rm|sudo|chmod|chown|mv|dd|mkfs|diskutil)\b/.test(command);
}

function truncatePrompt(prompt: string, maxLength = 120): string {
  const normalized = prompt.trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}
