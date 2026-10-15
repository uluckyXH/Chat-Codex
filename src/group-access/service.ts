import { randomUUID } from "node:crypto";
import type { ChannelMessage } from "../protocol/channel.js";
import type { MemoryStateStore } from "../state/memory-state-store.js";
import type { TrustedRouteRecord, GroupAuditEntry } from "../state/persistent-state-types.js";
import { groupAccessRecordFromTrustedRoute } from "./defaults.js";
import { groupSenderRole, isGroupSenderBlocked, canApproveGroup, canManageGroup } from "./policy.js";
import { upsertKnownGroupPrincipal } from "./principal.js";
import type { GroupAccessRecord } from "./types.js";

export interface GroupAccessServiceOptions { state: MemoryStateStore; now?: () => Date }
export type GroupMutation =
  | { action: "clear_super" }
  | { action: "admin_add" | "admin_remove" | "block" | "unblock" | "transfer"; target: string; displayName?: string; reason?: string }
  | { action: "approval"; policy: "admins_only" | "any_non_blocked" };
export type GroupActor = { kind: "local" } | { kind: "sender"; senderId: string };
export class GroupAccessService {
  private readonly state: MemoryStateStore;
  private readonly now: () => Date;
  constructor(options: GroupAccessServiceOptions) { this.state = options.state; this.now = options.now ?? (() => new Date()); }
  recordBotIdentity(routeKey: string, senderId: string): void {
    const record = this.get(routeKey);
    if (!record || record.botSenderId === senderId) return;
    this.state.upsertGroupAccess({ ...record, botSenderId: senderId, revision: (record.revision ?? 0) + 1 });
  }
  get(routeKey: string): GroupAccessRecord | undefined { return this.state.getGroupAccess(routeKey); }
  error(): string | undefined { return this.state.getGroupAccessError(); }
  ensureForTrustedRoute(route: TrustedRouteRecord): GroupAccessRecord | undefined {
    if (this.error()) throw new Error("群权限文件不可用，请在本机修复。");
    const existing = this.get(route.routeKey);
    if (existing) return existing;
    const next = groupAccessRecordFromTrustedRoute(route, this.now().toISOString());
    return next ? this.state.upsertGroupAccess(next) : undefined;
  }
  ensureForTrustedGroupMessage(message: ChannelMessage): GroupAccessRecord | undefined {
    if (message.conversation.kind !== "group") return undefined;
    const trusted = this.state.getTrustedRoute(message.routeKey);
    if (!trusted) return undefined;
    const access = this.ensureForTrustedRoute(trusted);
    return access ? this.recordKnownPrincipal(message, access) : undefined;
  }
  recordKnownPrincipal(message: ChannelMessage, record = this.get(message.routeKey)): GroupAccessRecord | undefined {
    if (!record || message.conversation.kind !== "group") return record;
    const timestamp = this.now().toISOString();
    return this.state.upsertGroupAccess({ ...record, knownPrincipals: upsertKnownGroupPrincipal(record.knownPrincipals, {
      senderId: message.sender.id, displayName: message.sender.displayName, source: "message", seenAt: timestamp,
    }), updatedAt: timestamp });
  }
  isSenderBlocked(message: ChannelMessage): boolean { return isGroupSenderBlocked(this.get(message.routeKey), message.sender.id); }
  roleForSender(routeKey: string, senderId: string) { return groupSenderRole(this.get(routeKey), senderId); }
  canApprove(message: ChannelMessage) { return canApproveGroup(this.get(message.routeKey), message.sender.id); }
  canManage(routeKey: string, senderId: string, superOnly = false) { return canManageGroup(this.get(routeKey), senderId, superOnly); }

  // Synchronous read/check/write is one decision boundary. File stores commit to disk before memory.
  mutate(routeKey: string, actor: GroupActor, change: GroupMutation, expectedRevision?: number): GroupAccessRecord {
    if (this.error()) throw new Error("群权限文件不可用，请在本机修复。");
    const record = this.get(routeKey);
    if (!record) throw new Error("群尚未配对，请先配对。");
    if (expectedRevision !== undefined && expectedRevision !== (record.revision ?? 0)) throw new Error("群权限已变化，请重新发起操作。");
    const actorId = actor.kind === "local" ? "local" : actor.senderId;
    const role = actor.kind === "local" ? "local" : groupSenderRole(record, actor.senderId);
    try {
      if (actor.kind !== "local" && !canManageGroup(record, actor.senderId).allowed) throw new Error("只有有效的群管理员可以操作。");
      if (["admin_add", "admin_remove", "approval"].includes(change.action) && role !== "local" && role !== "super_admin") throw new Error("此操作仅群超管可用。");
      if ((change.action === "transfer" || change.action === "clear_super") && role !== "local") throw new Error("超管转移请使用本机管理入口。");
      if ("target" in change) {
        if (!change.target.trim()) throw new Error("缺少目标 Open ID。");
        if (change.target === record.botSenderId) throw new Error("不能对机器人设置成员角色或黑名单。");
        const targetRole = groupSenderRole(record, change.target);
        if (role !== "local" && change.target === actorId) throw new Error("不能对自己执行此操作。");
        if (change.action !== "transfer" && record.superAdmin?.senderId === change.target) throw new Error("不能操作当前超管，请在本机转移超管。");
        if (["admin_add", "transfer"].includes(change.action) && targetRole === "blocked") throw new Error("目标已被拉黑，请先解除黑名单。");
        if ((change.action === "block" || change.action === "unblock") && role === "admin") {
          if (record.admins?.some((p) => p.senderId === change.target)) throw new Error("管理员只能管理普通成员。");
          const block = record.blockedSenders.find((p) => p.senderId === change.target);
          if (block && block.blockedByRole !== "admin") throw new Error("此黑名单由超管、本机或旧版本设置，仅超管或本机可解除。");
        }
      }
      const now = this.now().toISOString();
      const principal = "target" in change ? { senderId: change.target, displayName: change.displayName, source: actor.kind === "local" ? "tui" as const : "command" as const, createdBySenderId: actorId, createdAt: now } : undefined;
      const next = structuredClone(record);
      next.admins ??= [];
      switch (change.action) {
        case "clear_super": next.superAdmin = undefined; break;
        case "admin_add": if (!next.admins.some((p) => p.senderId === change.target)) next.admins.push(principal!); break;
        case "admin_remove": next.admins = next.admins.filter((p) => p.senderId !== change.target); break;
        case "block":
          next.admins = next.admins.filter((p) => p.senderId !== change.target);
          next.blockedSenders = next.blockedSenders.filter((p) => p.senderId !== change.target);
          next.blockedSenders.push({ ...principal!, blockedByRole: role as "local" | "super_admin" | "admin", reason: change.reason?.slice(0, 200) }); break;
        case "unblock": next.blockedSenders = next.blockedSenders.filter((p) => p.senderId !== change.target); break;
        case "transfer": next.superAdmin = principal; next.admins = next.admins.filter((p) => p.senderId !== change.target); break;
        case "approval": next.approvalPolicy = change.policy; break;
      }
      next.revision = (record.revision ?? 0) + 1;
      next.updatedAt = now;
      next.audit = [...(record.audit ?? []), { id: randomUUID(), source: actor.kind === "local" ? "local" as const : "chat" as const, actorRole: role, at: now, actor: actorId, action: change.action, target: groupMutationTarget(change), outcome: "allowed" as const, revision: next.revision }].slice(-500);
      return this.state.upsertGroupAccess(next);
    } catch (error) {
      this.audit(routeKey, { actor: actorId, action: change.action, target: groupMutationTarget(change), outcome: "denied" });
      throw error;
    }
  }
  audit(routeKey: string, event: Omit<GroupAuditEntry, "at" | "revision">): void {
    const record = this.get(routeKey);
    if (!record || this.error()) return;
    this.state.upsertGroupAccess({ ...record, audit: [...(record.audit ?? []), { ...event, id: randomUUID(), actorRole: event.actor === "local" ? "local" : groupSenderRole(record, event.actor), source: event.actor === "local" ? "local" as const : "chat" as const, at: this.now().toISOString(), revision: record.revision ?? 0 }].slice(-500) });
  }
}

export function groupMutationTarget(change: GroupMutation): string | undefined {
  return "target" in change ? change.target : change.action === "approval" ? change.policy : undefined;
}

export function describeGroupMutation(change: GroupMutation, record?: GroupAccessRecord): string {
  switch (change.action) {
    case "admin_add": return `任命 ${change.target} 为管理员，可审批、发文件和管理普通成员黑名单`;
    case "admin_remove": return `撤销 ${change.target} 的管理员身份，恢复为普通成员`;
    case "block": return `将 ${change.target} 加入黑名单${record?.admins?.some((p) => p.senderId === change.target) ? "，同时撤销管理员身份" : ""}`;
    case "unblock": return `解除 ${change.target} 的黑名单，原管理员身份不会自动恢复`;
    case "transfer": return `将超管从 ${record?.superAdmin?.senderId ?? "未设置"} 转移给 ${change.target}，原超管成为普通成员`;
    case "clear_super": return "清空超管；审批、文件发送和聊天管理将暂停，直至本机重新设置超管";
    case "approval": return change.policy === "any_non_blocked" ? "开放审批给已登记且未拉黑的群成员，文件发送权限保持管理员以上" : "仅允许超管和管理员审批";
  }
}
