import type { ApprovalDecision } from "../approvals/types.js";
import type {
  CodexAdapter,
  CodexEvent,
  CodexModelListOptions,
  CodexModelOption,
  CodexModelPolicy,
  CodexRunPolicy,
  CodexRunPolicyStatus,
  CodexSession,
  CodexSessionBaseStatus,
  CodexSessionModelInfo,
  CodexSessionStatus,
  CodexSessionSummary,
  StartSessionInput,
} from "./types.js";

export class MockCodexAdapter implements CodexAdapter {
  private sequence = 0;
  private defaultRunPolicy: CodexRunPolicy = { permissionMode: "approval", sandbox: "workspace-write" };
  private readonly sessionRunPolicies = new Map<string, CodexRunPolicy>();
  private defaultModelPolicy: CodexModelPolicy = {};
  private readonly sessionModelPolicies = new Map<string, CodexModelPolicy>();
  private readonly sessions = new Map<string, { session: CodexSession; routeKey: string; status: CodexSessionStatus }>();
  readonly resolvedApprovals: Array<{ approvalKey: string; decision: ApprovalDecision }> = [];

  async startSession(input: StartSessionInput): Promise<CodexSession> {
    this.sequence += 1;
    const session: CodexSession = {
      id: `mock-codex-${this.sequence}`,
      cwd: input.cwd,
      title: input.title,
      createdAt: new Date().toISOString(),
    };
    const modelPolicy = { ...this.defaultModelPolicy };
    this.sessions.set(session.id, { session, routeKey: input.routeKey, status: this.withModelInfo({ type: "idle" }, modelPolicy) });
    this.sessionRunPolicies.set(session.id, { ...this.defaultRunPolicy });
    this.sessionModelPolicies.set(session.id, modelPolicy);
    return session;
  }

  async resumeSession(sessionId: string): Promise<CodexSession> {
    const stored = this.sessions.get(sessionId);
    if (!stored) throw new Error(`mock session not found: ${sessionId}`);
    return stored.session;
  }

  async *run(sessionId: string, prompt: string): AsyncIterable<CodexEvent> {
    const stored = this.sessions.get(sessionId);
    if (!stored) throw new Error(`mock session not found: ${sessionId}`);
    const turnId = `turn-${Date.now()}`;
    stored.status = this.withModelInfo({ type: "running", turnId }, this.modelPolicyForSession(sessionId));
    yield { type: "turn.started", sessionId, turnId };
    if (prompt.includes("审批") || prompt.includes("approval")) {
      stored.status = this.withModelInfo({ type: "waiting_approval", detail: "mock approval" }, this.modelPolicyForSession(sessionId));
      yield {
        type: "approval.requested",
        sessionId,
        turnId,
        approval: {
          kind: "command",
          sessionId,
          turnId,
          itemId: `item-${turnId}`,
          command: "echo mock-approval",
          cwd: stored.session.cwd,
          reason: "mock approval requested by prompt",
          risk: "low",
          availableDecisions: ["approve", "approve-session", "deny", "cancel"],
        },
      };
    }
    const text = `Mock Codex 回复: ${prompt}`;
    yield { type: "assistant.delta", sessionId, turnId, text };
    yield { type: "assistant.completed", sessionId, turnId, text };
    stored.status = this.withModelInfo({ type: "idle" }, this.modelPolicyForSession(sessionId));
    yield { type: "turn.completed", sessionId, turnId };
  }

  async cancel(sessionId: string): Promise<void> {
    const stored = this.sessions.get(sessionId);
    if (stored) stored.status = this.withModelInfo({ type: "idle" }, this.modelPolicyForSession(sessionId));
  }

  async getStatus(sessionId: string): Promise<CodexSessionStatus> {
    return this.sessions.get(sessionId)?.status ?? { type: "unknown", detail: "session not found" };
  }

  async listSessions(routeKey?: string): Promise<CodexSessionSummary[]> {
    return [...this.sessions.values()]
      .filter((stored) => (routeKey ? stored.routeKey === routeKey : true))
      .map((stored) => ({
        id: stored.session.id,
        routeKey: stored.routeKey,
        title: stored.session.title,
        cwd: stored.session.cwd,
        status: stored.status,
        updatedAt: new Date().toISOString(),
      }));
  }

  async resolveApproval(approvalKey: string, decision: ApprovalDecision): Promise<void> {
    this.resolvedApprovals.push({
      approvalKey,
      decision,
    });
  }

  getRunPolicy(sessionId?: string): CodexRunPolicy {
    return { ...this.runPolicyForSession(sessionId) };
  }

  setRunPolicy(policy: CodexRunPolicy, sessionId?: string): void {
    if (sessionId) {
      this.sessionRunPolicies.set(sessionId, { ...policy });
      return;
    }
    this.defaultRunPolicy = { ...policy };
  }

  getRunPolicyStatus(sessionId?: string): CodexRunPolicyStatus {
    const policy = this.runPolicyForSession(sessionId);
    return {
      policy: { ...policy },
      interactiveApprovals: true,
      effectiveApprovalPolicy: policy.permissionMode === "full" ? "never" : "on-request",
    };
  }

  async listModels(options: CodexModelListOptions = {}): Promise<CodexModelOption[]> {
    return MOCK_MODELS.filter((model) => options.includeHidden || !model.hidden);
  }

  getModelPolicy(sessionId?: string): CodexModelPolicy {
    return { ...this.modelPolicyForSession(sessionId) };
  }

  setModelPolicy(policy: CodexModelPolicy, sessionId?: string): void {
    const next = { ...policy };
    if (sessionId) {
      this.sessionModelPolicies.set(sessionId, next);
      const stored = this.sessions.get(sessionId);
      if (stored) stored.status = this.withModelInfo(stored.status, next);
      return;
    }
    this.defaultModelPolicy = next;
  }

  private runPolicyForSession(sessionId?: string): CodexRunPolicy {
    return (sessionId ? this.sessionRunPolicies.get(sessionId) : undefined) ?? this.defaultRunPolicy;
  }

  private modelPolicyForSession(sessionId?: string): CodexModelPolicy {
    return (sessionId ? this.sessionModelPolicies.get(sessionId) : undefined) ?? this.defaultModelPolicy;
  }

  private withModelInfo(status: CodexSessionBaseStatus, policy: CodexModelPolicy): CodexSessionStatus;
  private withModelInfo(status: CodexSessionStatus, policy: CodexModelPolicy): CodexSessionStatus;
  private withModelInfo(status: CodexSessionStatus | CodexSessionBaseStatus, policy: CodexModelPolicy): CodexSessionStatus {
    return {
      ...status,
      model: modelInfoForPolicy(policy),
    };
  }
}

const MOCK_MODELS: CodexModelOption[] = [
  {
    id: "gpt-test",
    model: "gpt-test",
    displayName: "GPT Test",
    description: "Mock default model",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
    ],
    defaultReasoningEffort: "medium",
    serviceTiers: [{ id: "default", name: "Default" }],
    isDefault: true,
  },
  {
    id: "gpt-next",
    model: "gpt-next",
    displayName: "GPT Next",
    description: "Mock advanced model",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "medium" },
      { reasoningEffort: "high" },
      { reasoningEffort: "xhigh" },
    ],
    defaultReasoningEffort: "high",
    serviceTiers: [{ id: "default", name: "Default" }],
  },
  {
    id: "gpt-hidden",
    model: "gpt-hidden",
    displayName: "GPT Hidden",
    description: "Hidden mock model",
    hidden: true,
    supportedReasoningEfforts: [
      { reasoningEffort: "high" },
      { reasoningEffort: "xhigh" },
    ],
    defaultReasoningEffort: "xhigh",
  },
];

function modelInfoForPolicy(policy: CodexModelPolicy): CodexSessionModelInfo {
  const model = policy.model ?? "gpt-test";
  const option = MOCK_MODELS.find((candidate) => candidate.model === model || candidate.id === model) ?? MOCK_MODELS[0];
  return {
    model,
    provider: "mock",
    serviceTier: policy.serviceTier ?? "default",
    reasoningEffort: policy.reasoningEffort ?? option.defaultReasoningEffort ?? "medium",
  };
}
