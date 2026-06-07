import type { ApprovalDecision, ApprovalRequest } from "../approvals/types.js";
import type { CodexRunPolicy, CodexRunPolicyStatus } from "./codex-cli.js";
import type { CodexPromptInput } from "./input.js";

export type { CodexRunPolicy, CodexRunPolicyStatus } from "./codex-cli.js";
export type { CodexInputItem, CodexPromptInput, CodexTurnInput } from "./input.js";

export const CODEX_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number];

export const CODEX_COLLABORATION_MODES = ["default", "plan"] as const;

export type CodexCollaborationMode = typeof CODEX_COLLABORATION_MODES[number];

export interface CodexRunOptions {
  collaborationMode?: CodexCollaborationMode;
}

export const CODEX_GOAL_STATUSES = ["active", "paused", "budgetLimited", "complete"] as const;

export type CodexGoalStatus = typeof CODEX_GOAL_STATUSES[number];

export interface CodexGoal {
  threadId: string;
  objective: string;
  status: CodexGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface CodexSession {
  id: string;
  cwd: string;
  createdAt: string;
  title?: string;
}

export interface CodexTokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexSessionContextUsage {
  total: CodexTokenUsageBreakdown;
  last: CodexTokenUsageBreakdown;
  modelContextWindow?: number | null;
}

export interface CodexSessionModelInfo {
  model?: string;
  provider?: string;
  serviceTier?: string | null;
  reasoningEffort?: string | null;
}

export interface CodexReasoningEffortOption {
  reasoningEffort: CodexReasoningEffort;
  description?: string;
}

export interface CodexModelServiceTier {
  id: string;
  name?: string;
  description?: string;
}

export interface CodexModelOption {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  hidden: boolean;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
  defaultReasoningEffort?: CodexReasoningEffort;
  serviceTiers?: CodexModelServiceTier[];
  isDefault?: boolean;
}

export interface CodexModelListOptions {
  includeHidden?: boolean;
}

export interface CodexModelPolicy {
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  serviceTier?: string | null;
}

export type CodexSessionBaseStatus =
  | { type: "idle" }
  | { type: "running"; task?: string; turnId?: string; startedAt?: string }
  | { type: "waiting_approval"; detail?: string; startedAt?: string }
  | { type: "waiting_input"; detail?: string; startedAt?: string }
  | { type: "failed"; error: string }
  | { type: "unknown"; detail?: string };

export type CodexSessionStatus = CodexSessionBaseStatus & {
  context?: CodexSessionContextUsage;
  model?: CodexSessionModelInfo;
};

export type CodexNotificationKind =
  | "security"
  | "warning"
  | "model"
  | "config"
  | "lifecycle"
  | "deprecation";

export type CodexThreadLifecycleNotification =
  | "archived"
  | "closed"
  | "unarchived";

export interface CodexNotification {
  method: string;
  kind: CodexNotificationKind;
  text: string;
  dedupeKey: string;
  dedupeWindowMs: number;
  lifecycle?: CodexThreadLifecycleNotification;
  unbindRoute?: boolean;
}

export type CodexEvent =
  | { type: "turn.started"; sessionId: string; turnId: string; startedAt?: string }
  | { type: "assistant.progress"; sessionId: string; turnId: string; text: string; kind?: CodexProgressKind }
  | { type: "codex.notification"; sessionId: string; turnId: string; notification: CodexNotification }
  | { type: "assistant.plan"; sessionId: string; turnId: string; text: string }
  | { type: "assistant.delta"; sessionId: string; turnId: string; text: string }
  | { type: "assistant.completed"; sessionId: string; turnId: string; text: string }
  | { type: "approval.requested"; sessionId: string; turnId: string; approval: ApprovalRequest }
  | { type: "approval.resolved"; sessionId: string; turnId: string; adapterApprovalId: string }
  | { type: "turn.completed"; sessionId: string; turnId: string }
  | { type: "turn.failed"; sessionId: string; turnId: string; error: string };

export type CodexBackgroundEventHandler = (event: CodexEvent) => void | Promise<void>;

export type CodexProgressKind =
  | "reasoning"
  | "todo"
  | "search"
  | "file_change"
  | "command"
  | "tool"
  | "other";

export interface StartSessionInput {
  routeKey: string;
  cwd: string;
  title?: string;
}

export interface CodexSessionSummary {
  id: string;
  routeKey?: string;
  title?: string;
  cwd?: string;
  status: CodexSessionStatus;
  updatedAt: string;
}

export interface CodexSessionReloadResult {
  session: CodexSession;
  reloadedAt: string;
}

export interface CodexCompactResult {
  sessionId: string;
  message?: string;
  beforeTokens?: number;
  afterTokens?: number;
}

export interface CodexAdapter {
  stop?(): Promise<void>;
  onBackgroundEvent?(handler: CodexBackgroundEventHandler): () => void;
  startSession(input: StartSessionInput): Promise<CodexSession>;
  setSessionTitle?(sessionId: string, title: string): Promise<void>;
  setSessionPreview?(sessionId: string, preview: string): Promise<void>;
  resumeSession(sessionId: string): Promise<CodexSession>;
  reloadSession?(sessionId: string): Promise<CodexSessionReloadResult>;
  run(sessionId: string, prompt: CodexPromptInput, options?: CodexRunOptions): AsyncIterable<CodexEvent>;
  steer?(sessionId: string, prompt: CodexPromptInput): Promise<void>;
  cancel?(sessionId: string): Promise<void>;
  getStatus(sessionId: string): Promise<CodexSessionStatus>;
  listSessions(routeKey?: string): Promise<CodexSessionSummary[]>;
  resolveApproval?(approvalKey: string, decision: ApprovalDecision): Promise<void>;
  getRunPolicy?(sessionId?: string): CodexRunPolicy;
  setRunPolicy?(policy: CodexRunPolicy, sessionId?: string): void;
  getRunPolicyStatus?(sessionId?: string): CodexRunPolicyStatus;
  listModels?(options?: CodexModelListOptions): Promise<CodexModelOption[]>;
  getModelPolicy?(sessionId?: string): CodexModelPolicy;
  setModelPolicy?(policy: CodexModelPolicy, sessionId?: string): void;
  getCollaborationMode?(sessionId?: string): CodexCollaborationMode;
  setCollaborationMode?(mode: CodexCollaborationMode, sessionId?: string): void;
  getGoal?(sessionId: string): Promise<CodexGoal | null>;
  setGoal?(sessionId: string, objective: string): Promise<CodexGoal>;
  setGoalStatus?(sessionId: string, status: CodexGoalStatus): Promise<CodexGoal>;
  clearGoal?(sessionId: string): Promise<boolean>;
  compactSession?(sessionId: string): Promise<CodexCompactResult>;
}
