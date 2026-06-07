import type { ApprovalDecision } from "../../approvals/types.js";
import type {
  CodexCollaborationMode,
  CodexEvent,
  CodexProgressKind,
  CodexSession,
  CodexSessionModelInfo,
  CodexSessionStatus,
  CodexUserInputResponse,
} from "../types.js";
import type { CommandExecutionRecord } from "./command-output-summary.js";

export interface AppServerSessionRecord {
  session: CodexSession;
  routeKey?: string;
  status: CodexSessionStatus;
  updatedAt: string;
  currentTurnId?: string;
  baseModel?: CodexSessionModelInfo;
}

export interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface PendingResponse {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface PendingServerApproval {
  method: string;
  requestId: string | number;
  sessionId: string;
  turnId: string;
  params: Record<string, unknown>;
  resolve: (decision: ApprovalDecision) => Promise<void>;
}

export interface PendingServerUserInput {
  method: string;
  requestId: string | number;
  sessionId: string;
  turnId: string;
  params: Record<string, unknown>;
  resolve: (response: CodexUserInputResponse) => Promise<void>;
}

export interface AppServerEventQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(): void;
}

export interface TurnQueueRecord {
  sessionId: string;
  turnId: string;
  queue: AppServerEventQueue<CodexEvent>;
  collaborationMode?: CodexCollaborationMode;
  finalText: string;
  progressDrafts: Map<string, ProgressDraft>;
  commandExecutions: Map<string, CommandExecutionRecord>;
  agentMessagePhases: Map<string, "commentary" | "final_answer">;
  emittedProgressItemIds: Set<string>;
  emittedProgress: Set<string>;
  closed: boolean;
}

export interface ProgressDraft {
  kind: CodexProgressKind;
  text: string;
  prefix?: string;
}
