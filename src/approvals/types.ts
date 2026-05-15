export type ApprovalKind = "command" | "file_change" | "permissions" | "network" | "legacy_exec" | "legacy_patch";

export type ApprovalDecision = "approve" | "approve-session" | "deny" | "cancel";

export interface ApprovalRequest {
  kind: ApprovalKind;
  adapterApprovalId?: string;
  sessionId: string;
  turnId: string;
  itemId: string;
  command?: string;
  cwd?: string;
  reason?: string;
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
  status: "pending" | "resolved" | "expired";
  decision?: ApprovalDecision;
  decisionReason?: string;
}
