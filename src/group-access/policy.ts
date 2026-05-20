import type { GroupAccessRecord } from "./types.js";

export type GroupSenderRole = "super_admin" | "member" | "blocked" | "unconfigured";

export interface GroupCapabilityDecision {
  allowed: boolean;
  reason?: "blocked" | "missing_group_access" | "missing_super_admin" | "not_super_admin";
}

export function groupSenderRole(record: GroupAccessRecord | undefined, senderId: string): GroupSenderRole {
  if (!record) return "unconfigured";
  if (isGroupSenderBlocked(record, senderId)) return "blocked";
  if (record.superAdmin?.senderId === senderId) return "super_admin";
  return "member";
}

export function isGroupSenderBlocked(record: GroupAccessRecord | undefined, senderId: string): boolean {
  return Boolean(record?.blockedSenders.some((sender) => sender.senderId === senderId));
}

export function canApproveGroup(record: GroupAccessRecord | undefined, senderId: string): GroupCapabilityDecision {
  if (!record) return { allowed: false, reason: "missing_group_access" };
  if (isGroupSenderBlocked(record, senderId)) return { allowed: false, reason: "blocked" };
  if (record.approvalPolicy === "any_non_blocked") return { allowed: true };
  if (!record.superAdmin) return { allowed: false, reason: "missing_super_admin" };
  if (record.superAdmin.senderId !== senderId) return { allowed: false, reason: "not_super_admin" };
  return { allowed: true };
}
