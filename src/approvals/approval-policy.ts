import type { ApprovalDecision, ApprovalRequest } from "./types.js";

const DEFAULT_APPROVAL_DECISIONS: ApprovalDecision[] = [
  "approve",
  "approve-session",
  "deny",
  "cancel",
];

const TERMINAL_INPUT_APPROVAL_DECISIONS: ApprovalDecision[] = ["approve", "cancel"];

type ApprovalDecisionSource = Pick<ApprovalRequest, "kind" | "availableDecisions">;

export function availableApprovalDecisions(approval: ApprovalDecisionSource): ApprovalDecision[] {
  const configured = approval.availableDecisions;
  if (configured !== undefined) return [...new Set(configured)];
  if (approval.kind === "terminal_input") return [...TERMINAL_INPUT_APPROVAL_DECISIONS];
  return [...DEFAULT_APPROVAL_DECISIONS];
}

export function normalizeApprovalDecision(
  approval: ApprovalDecisionSource,
  requested: ApprovalDecision,
): ApprovalDecision | undefined {
  const available = availableApprovalDecisions(approval);
  if (available.includes(requested)) return requested;
  if (approval.kind === "terminal_input" && requested === "deny" && available.includes("cancel")) {
    return "cancel";
  }
  return undefined;
}

export function unsupportedApprovalDecisionText(
  approval: ApprovalDecisionSource,
  requested: ApprovalDecision,
): string {
  if (approval.kind === "terminal_input" && requested === "approve-session") {
    return "这是终端输入审批，只支持 /OK 本次允许或 /NO 取消并中止当前任务；不支持 /P 本会话通过。";
  }
  if (approval.kind === "terminal_input") {
    return "这是终端输入审批，只支持当前请求允许的操作。";
  }
  return "该审批不支持此处理方式。";
}

export function formatApprovalCommandForDisplay(approval: Pick<ApprovalRequest, "kind" | "command">): string | undefined {
  const command = approval.command;
  if (!command) return undefined;
  return formatApprovalTextForDisplay(command);
}

export function formatApprovalTextForDisplay(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, (character) => {
    return `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
  }).replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

/**
 * Mirrors Codex TUI's quoted stdin presentation while keeping control
 * characters visible instead of allowing them to alter a channel message.
 */
export function formatTerminalInputForDisplay(input: string): string {
  return JSON.stringify(input);
}
