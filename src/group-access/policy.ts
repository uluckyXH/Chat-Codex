import type { GroupAccessRecord } from "./types.js";

export type GroupSenderRole = "super_admin" | "admin" | "member" | "blocked" | "unconfigured";
export interface GroupCapabilityDecision {
  allowed: boolean;
  reason?: "blocked" | "missing_group_access" | "missing_super_admin" | "not_super_admin" | "not_admin";
}
export function groupSenderRole(record: GroupAccessRecord | undefined, senderId: string): GroupSenderRole {
  if (!record) return "unconfigured";
  if (isGroupSenderBlocked(record, senderId)) return "blocked";
  if (record.superAdmin?.senderId === senderId) return "super_admin";
  if (record.admins?.some((p) => p.senderId === senderId)) return "admin";
  return "member";
}
export function isGroupSenderBlocked(record: GroupAccessRecord | undefined, senderId: string): boolean {
  return Boolean(record?.blockedSenders.some((sender) => sender.senderId === senderId));
}
export function hasValidSuperAdmin(record: GroupAccessRecord | undefined): boolean {
  return Boolean(record?.superAdmin?.senderId && !isGroupSenderBlocked(record, record.superAdmin.senderId));
}
export function canManageGroup(record: GroupAccessRecord | undefined, senderId: string, superOnly = false): GroupCapabilityDecision {
  if (!record) return { allowed: false, reason: "missing_group_access" };
  const role = groupSenderRole(record, senderId);
  if (role === "blocked") return { allowed: false, reason: "blocked" };
  if (!hasValidSuperAdmin(record)) return { allowed: false, reason: "missing_super_admin" };
  if (role === "super_admin" || (!superOnly && role === "admin")) return { allowed: true };
  return { allowed: false, reason: superOnly ? "not_super_admin" : "not_admin" };
}
export function canApproveGroup(record: GroupAccessRecord | undefined, senderId: string): GroupCapabilityDecision {
  const decision = canManageGroup(record, senderId);
  if (decision.reason === "not_admin" && record?.approvalPolicy === "any_non_blocked") return { allowed: true };
  return decision;
}
