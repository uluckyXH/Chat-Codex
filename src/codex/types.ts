import type { ApprovalDecision, ApprovalRequest } from "../approvals/types.js";
import type { CodexRunPolicy, CodexRunPolicyStatus } from "./codex-cli.js";

export type { CodexRunPolicy, CodexRunPolicyStatus } from "./codex-cli.js";

export const CODEX_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number];

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
  | { type: "running"; task?: string; turnId?: string }
  | { type: "waiting_approval"; detail?: string }
  | { type: "waiting_input"; detail?: string }
  | { type: "failed"; error: string }
  | { type: "unknown"; detail?: string };

export type CodexSessionStatus = CodexSessionBaseStatus & {
  context?: CodexSessionContextUsage;
  model?: CodexSessionModelInfo;
};

export type CodexEvent =
  | { type: "turn.started"; sessionId: string; turnId: string }
  | { type: "assistant.progress"; sessionId: string; turnId: string; text: string; kind?: CodexProgressKind }
  | { type: "assistant.delta"; sessionId: string; turnId: string; text: string }
  | { type: "assistant.completed"; sessionId: string; turnId: string; text: string }
  | { type: "approval.requested"; sessionId: string; turnId: string; approval: ApprovalRequest }
  | { type: "turn.completed"; sessionId: string; turnId: string }
  | { type: "turn.failed"; sessionId: string; turnId: string; error: string };

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

export interface CodexAdapter {
  stop?(): Promise<void>;
  startSession(input: StartSessionInput): Promise<CodexSession>;
  resumeSession(sessionId: string): Promise<CodexSession>;
  run(sessionId: string, prompt: string): AsyncIterable<CodexEvent>;
  steer?(sessionId: string, prompt: string): Promise<void>;
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
}
