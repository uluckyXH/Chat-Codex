export type ApprovalKind = "command" | "terminal_input" | "file_change" | "permissions" | "network" | "legacy_exec" | "legacy_patch";

export type ApprovalDecision = "approve" | "approve-session" | "deny" | "cancel";

export interface ApprovalRequest {
  kind: ApprovalKind;
  adapterApprovalId?: string;
  sessionId: string;
  turnId: string;
  itemId: string;
  command?: string;
  /** Codex execution environment identifier, when app-server provides one. */
  environmentId?: string;
  cwd?: string;
  reason?: string;
  /** Target terminal for a `terminal_input` approval, normalized from Codex's request. */
  terminalId?: string;
  /** Exact input that Codex proposes to write to that existing terminal. */
  terminalInput?: string;
  risk?: "low" | "medium" | "high" | "unknown";
  availableDecisions?: ApprovalDecision[];
  raw?: unknown;
}

export interface PendingApproval extends ApprovalRequest {
  approvalKey: string;
  routeKey: string;
  requestedBy: string;
  requestedAt: string;
  expiresAt?: string;
  status: "pending" | "resolving" | "uncertain" | "resolved" | "expired";
  resolvedBy?: string;
  resolvedAt?: string;
  decision?: ApprovalDecision;
  decisionReason?: string;
}
