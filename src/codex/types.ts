import type { ApprovalDecision, ApprovalRequest } from "../approvals/types.js";
import type { CodexRunPolicy, CodexRunPolicyStatus } from "./codex-cli.js";
import type { CodexCwdDiagnostic } from "./cwd-diagnostic.js";
import type { CodexPromptInput } from "./input.js";
import type { CodexTransportDiagnostic } from "./transport-diagnostic.js";
import type { CodexProtocolStatus } from "./app-server/compatibility.js";

export type { CodexRunPolicy, CodexRunPolicyStatus } from "./codex-cli.js";
export type { CodexCwdDiagnostic, CodexCwdDiagnosticSource, CodexCwdInspection, CodexCwdInspectionState } from "./cwd-diagnostic.js";
export type { CodexInputItem, CodexPromptInput, CodexTurnInput } from "./input.js";
export type { CodexTransportDiagnostic, CodexTransportFailureKind, CodexTransportRequestDiagnostic } from "./transport-diagnostic.js";

export const CODEX_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type CodexReasoningEffort = string;

export const CODEX_COLLABORATION_MODES = ["default", "plan"] as const;

export type CodexCollaborationMode = typeof CODEX_COLLABORATION_MODES[number];

export interface CodexRunOptions {
  collaborationMode?: CodexCollaborationMode;
}

export const CODEX_GOAL_STATUSES = ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"] as const;

export type CodexGoalStatus = typeof CODEX_GOAL_STATUSES[number];

export interface CodexGoalMutationOptions {
  origin: "user" | "automatic";
}

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
  upgrade?: string | null;
  upgradeInfo?: unknown;
  availabilityNux?: unknown;
  modelSpecialty?: string | null;
  multiAgentVersion?: string | null;
  availableAccessPrograms?: Record<string, unknown> | null;
  hidden: boolean;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
  defaultReasoningEffort?: CodexReasoningEffort;
  inputModalities?: string[];
  supportsPersonality?: boolean;
  serviceTiers?: CodexModelServiceTier[];
  defaultServiceTier?: string | null;
  isDefault?: boolean;
}

export interface CodexModelListOptions {
  includeHidden?: boolean;
}

export interface CodexSessionListStatus {
  source: "app-server" | "local";
  pages: number;
  truncated: boolean;
  notice?: string;
}

/** Middleware capabilities; handshake alone does not verify server features. */
export interface CodexAdapterCapabilities {
  mode: "app-server" | "exec";
  interactiveApprovals: boolean;
  userInput: boolean;
  goals: boolean;
  steering: boolean;
  modelList: boolean;
  messagePhases: boolean;
  asyncQuestions: boolean;
}

export interface CodexModelPolicy {
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  serviceTier?: string | null;
}

export type CodexSessionBaseStatus =
  | { type: "idle" }
  | { type: "interrupted" }
  | { type: "running"; task?: string; turnId?: string; startedAt?: string }
  | { type: "waiting_approval"; detail?: string; startedAt?: string }
  | { type: "waiting_input"; detail?: string; startedAt?: string }
  | { type: "failed"; error: string }
  | { type: "unknown"; detail?: string };

export type CodexSessionStatus = CodexSessionBaseStatus & {
  goal?: CodexGoal | null;
  effectiveSettings?: CodexEffectiveSettings;
  context?: CodexSessionContextUsage;
  model?: CodexSessionModelInfo;
  cwdDiagnostic?: CodexCwdDiagnostic;
};

export interface CodexEffectiveSettings {
  runtimeWorkspaceRoots?: string[];
  approvalPolicy?: unknown;
  approvalsReviewer?: string | null;
  sandboxPolicy?: Record<string, unknown>;
  activePermissionProfile?: { id: string; extends: string | null } | null;
  collaborationMode?: Record<string, unknown> | null;
}

export type CodexNotificationKind =
  | "security"
  | "warning"
  | "model"
  | "config"
  | "lifecycle"
  | "deprecation"
  | "connection";

export type CodexThreadLifecycleNotification =
  | "archived"
  | "closed"
  | "deleted"
  | "unarchived";

export interface CodexNotification {
  method: string;
  kind: CodexNotificationKind;
  text: string;
  /** Adapter-assigned visibility; omitted notifications retain channel delivery. */
  visibility?: "channel" | "local";
  dedupeKey: string;
  dedupeWindowMs: number;
  lifecycle?: CodexThreadLifecycleNotification;
  unbindRoute?: boolean;
}

export interface CodexUserInputOption {
  label: string;
  description?: string;
}

export interface CodexUserInputQuestion {
  id: string;
  header?: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: CodexUserInputOption[];
}

export interface CodexUserInputRequest {
  /** Missing on older servers means blocking. */
  isBlocking?: boolean;
  adapterRequestId: string;
  sessionId: string;
  turnId: string;
  itemId?: string;
  questions: CodexUserInputQuestion[];
  raw?: unknown;
}

export interface CodexUserInputAnswer {
  answers: string[];
}

export interface CodexUserInputResponse {
  answers: Record<string, CodexUserInputAnswer>;
}

export interface CodexToolProgress {
  phase: "start" | "end";
  itemId: string;
  toolName: string;
  status?: "completed" | "failed" | "blocked" | "unknown";
}

export type CodexMessagePhase = "commentary" | "partial_answer" | "final_answer";

export interface CodexAssistantMessage {
  itemId?: string;
  text: string;
  phase?: CodexMessagePhase;
  delivery?: "async";
  questions?: Array<{ title: string; options: string[] }>;
}

export type CodexEvent =
  | { type: "turn.started"; sessionId: string; turnId: string; startedAt?: string }
  | { type: "context.compaction"; sessionId: string; turnId: string; phase: "started" | "completed" }
  | { type: "assistant.progress"; sessionId: string; turnId: string; text: string; kind?: CodexProgressKind }
  /** One completed commentary item, never an individual streaming delta. */
  | { type: "assistant.commentary"; sessionId: string; turnId: string; text: string; itemId?: string }
  | { type: "tool.progress"; sessionId: string; turnId: string; progress: CodexToolProgress }
  | { type: "codex.notification"; sessionId: string; turnId: string; notification: CodexNotification }
  | { type: "assistant.plan"; sessionId: string; turnId: string; text: string }
  | { type: "assistant.delta"; sessionId: string; turnId: string; text: string; itemId?: string; snapshot?: string }
  | { type: "assistant.completed"; sessionId: string; turnId: string; text: string }
  | { type: "assistant.message"; sessionId: string; turnId: string; message: CodexAssistantMessage }
  | { type: "approval.requested"; sessionId: string; turnId: string; approval: ApprovalRequest }
  | { type: "approval.resolved"; sessionId: string; turnId: string; adapterApprovalId: string }
  | { type: "input.requested"; sessionId: string; turnId: string; request: CodexUserInputRequest }
  | { type: "input.resolved"; sessionId: string; turnId: string; adapterRequestId: string }
  | { type: "turn.completed"; sessionId: string; turnId: string }
  | { type: "turn.interrupted"; sessionId: string; turnId: string }
  | { type: "turn.retrying"; sessionId: string; turnId: string; error: string; errorDetails?: CodexTurnError }
  | { type: "turn.failed"; sessionId: string; turnId: string; error: string; errorDetails?: CodexTurnError };

export interface CodexTurnError {
  message: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string;
  misalignment?: unknown;
}

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

export interface CodexSessionGitInfo {
  root?: string;
  branch?: string;
  sha?: string;
  originUrl?: string;
}

export interface CodexSessionDetail extends CodexSessionSummary {
  sessionId?: string;
  threadId?: string;
  preview?: string;
  createdAt?: string;
  recencyAt?: string;
  source?: string;
  threadSource?: string;
  modelProvider?: string;
  cliVersion?: string;
  path?: string;
  gitInfo?: CodexSessionGitInfo;
  forkedFromId?: string;
  parentThreadId?: string;
  ephemeral?: boolean;
}

export interface CodexSessionReloadResult {
  session: CodexSession;
  reloadedAt: string;
  /** The latest final assistant reply recovered from session history, when supported. */
  lastAssistantMessage?: string;
}

export interface CodexCompactResult {
  sessionId: string;
  message?: string;
  beforeTokens?: number;
  afterTokens?: number;
}

export interface CodexAdapter {
  getProtocolStatus?(): CodexProtocolStatus;
  getSessionListStatus?(): CodexSessionListStatus | undefined;
  getCapabilities?(): CodexAdapterCapabilities;
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
  getCwdDiagnostic?(sessionId?: string): CodexCwdDiagnostic | undefined;
  getTransportDiagnostic?(): CodexTransportDiagnostic | undefined;
  listSessions(routeKey?: string): Promise<CodexSessionSummary[]>;
  getSessionDetail?(sessionId: string): Promise<CodexSessionDetail | undefined>;
  resolveApproval?(approvalKey: string, decision: ApprovalDecision): Promise<void>;
  resolveUserInput?(requestId: string, response: CodexUserInputResponse): Promise<void>;
  getRunPolicy?(sessionId?: string): CodexRunPolicy;
  setRunPolicy?(policy: CodexRunPolicy, sessionId?: string): void;
  getRunPolicyStatus?(sessionId?: string): CodexRunPolicyStatus;
  listModels?(options?: CodexModelListOptions): Promise<CodexModelOption[]>;
  getModelPolicy?(sessionId?: string): CodexModelPolicy;
  setModelPolicy?(policy: CodexModelPolicy, sessionId?: string): void;
  getCollaborationMode?(sessionId?: string): CodexCollaborationMode;
  setCollaborationMode?(mode: CodexCollaborationMode, sessionId?: string): void;
  getGoal?(sessionId: string): Promise<CodexGoal | null>;
  setGoal?(sessionId: string, objective: string, options?: CodexGoalMutationOptions): Promise<CodexGoal>;
  setGoalStatus?(sessionId: string, status: CodexGoalStatus, options?: CodexGoalMutationOptions): Promise<CodexGoal>;
  clearGoal?(sessionId: string, options?: CodexGoalMutationOptions): Promise<boolean>;
  compactSession?(sessionId: string): Promise<CodexCompactResult>;
}
