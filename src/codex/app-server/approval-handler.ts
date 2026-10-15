import type { ApprovalDecision, ApprovalKind, ApprovalRequest } from "../../approvals/types.js";
import { terminalInputApprovalDetailsFromCommand } from "./terminal-input-approval.js";
import { arrayValue, objectValue, stringValue } from "./value-parsers.js";
import { supportedPermissionProfile } from "./permission-profile.js";

export function approvalKindForMethod(method: string, params: Record<string, unknown> = {}): ApprovalKind | undefined {
  if (method === "item/commandExecution/requestApproval") {
    return stringValue(params.kind) === "writeStdin" ? "terminal_input" : "command";
  }
  if (method === "execCommandApproval") return "command";
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") return "file_change";
  if (method === "item/permissions/requestApproval") return "permissions";
  return undefined;
}

export function responseForApprovalDecision(method: string, params: Record<string, unknown>, decision: ApprovalDecision): Record<string, unknown> {
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

export function riskyCommand(command: string): boolean {
  return /\b(rm|sudo|chmod|chown|mv|dd|mkfs|diskutil)\b/.test(command);
}

export function approvalFromServerRequest(
  method: string,
  requestId: string | number,
  params: Record<string, unknown>,
): ApprovalRequest | undefined {
  const kind = approvalKindForMethod(method, params);
  if (!kind) return undefined;
  const threadId = stringValue(params.threadId) ?? stringValue(params.conversationId) ?? "unknown-thread";
  const turnId = stringValue(params.turnId) ?? stringValue(params.callId) ?? "unknown-turn";
  const itemId = stringValue(params.itemId) ?? stringValue(params.callId) ?? String(requestId);
  const command = commandFromParams(params);
  const terminalInput = kind === "terminal_input"
    ? terminalInputApprovalDetailsFromCommand(params.command)
    : undefined;
  const environmentId = stringValue(params.environmentId);
  const cwd = stringValue(params.cwd) ?? stringValue(params.grantRoot);
  const permissionSupported = kind !== "permissions" || supportedPermissionProfile(params.permissions);
  const reason = kind === "permissions" ? [stringValue(params.reason), permissionSupported ? "请求权限范围：" : "无法识别的权限结构，仅允许拒绝：", JSON.stringify(params.permissions)].filter(Boolean).join("\n") : stringValue(params.reason);
  return {
    kind,
    adapterApprovalId: String(requestId),
    sessionId: threadId,
    turnId,
    itemId,
    command,
    ...(environmentId ? { environmentId } : {}),
    cwd,
    reason,
    ...(terminalInput ? {
      terminalId: terminalInput.terminalId,
      terminalInput: terminalInput.input,
    } : {}),
    risk: command && riskyCommand(command) ? "high" : undefined,
    availableDecisions: permissionSupported ? availableDecisionsFromParams(params, kind) : ["deny", "cancel"],
    raw: params,
  };
}

function commandFromParams(params: Record<string, unknown>): string | undefined {
  const command = stringValue(params.command) ?? arrayValue(params.command)
    .filter((part): part is string => typeof part === "string")
    .join(" ");
  return command.trim() ? command : undefined;
}

function availableDecisionsFromParams(
  params: Record<string, unknown>,
  kind: ApprovalKind,
): ApprovalDecision[] {
  const fromServer = arrayValue(params.availableDecisions)
    .map(approvalDecisionFromServer)
    .filter((decision): decision is ApprovalDecision => Boolean(decision));
  if (params.availableDecisions != null) return [...new Set(fromServer)];
  return kind === "terminal_input"
    ? ["approve", "cancel"]
    : ["approve", "approve-session", "deny", "cancel"];
}

function approvalDecisionFromServer(value: unknown): ApprovalDecision | undefined {
  if (value === "accept") return "approve";
  if (value === "acceptForSession") return "approve-session";
  if (value === "decline") return "deny";
  if (value === "cancel") return "cancel";
  return undefined;
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
  if (!supportedPermissionProfile(params.permissions)) throw new Error("unsupported permission profile");
  const requested = objectValue(params.permissions);
  const granted: Record<string, unknown> = {};
  if (requested.network !== undefined && requested.network !== null) granted.network = requested.network;
  if (requested.fileSystem !== undefined && requested.fileSystem !== null) granted.fileSystem = requested.fileSystem;
  return granted;
}
