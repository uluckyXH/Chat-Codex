import type { GroupAccessDocument, GroupAccessRecord, GroupPrincipal } from "../state/persistent-state-types.js";
import { buildRouteKey } from "../protocol/channel.js";

export const GROUP_ACCESS_SCHEMA_VERSION = 2;
function fail(): never { throw new Error("群权限数据校验失败；已暂停群权限写入，请恢复备份或在本机修复 group-access.json。"); }
function principal(value: unknown): value is GroupPrincipal {
  if (!value || typeof value !== "object") return false;
  const p = value as GroupPrincipal;
  return typeof p.senderId === "string" && Boolean(p.senderId.trim()) && typeof p.createdAt === "string" && ["command", "pairing", "tui"].includes(p.source);
}
export function normalizeGroupAccessDocument(value: unknown): GroupAccessDocument {
  const doc = value as GroupAccessDocument;
  if (!doc || ![1, 2].includes(doc.schemaVersion) || !Array.isArray(doc.groups)) fail();
  const seen = new Set<string>();
  const groups = doc.groups.map((raw): GroupAccessRecord => {
    const r = structuredClone(raw);
    if (!r || typeof r.routeKey !== "string" || !r.channelId || !r.accountId || !r.conversationId || r.conversationKind !== "group") fail();
    if (r.routeKey !== buildRouteKey(r) || seen.has(r.routeKey)) fail();
    seen.add(r.routeKey);
    if (r.botSenderId !== undefined && (typeof r.botSenderId !== "string" || !r.botSenderId.trim())) fail();
    if (r.superAdmin !== undefined && !principal(r.superAdmin)) fail();
    if (!Array.isArray(r.blockedSenders) || !r.blockedSenders.every(principal)) fail();
    if (doc.schemaVersion === 1) {
      // Reserved legacy roles were never active and must never become grants.
      r.admins = [];
      r.revision = 0;
      r.audit = [];
      r.blockedSenders = r.blockedSenders.map((p) => ({ ...p, blockedByRole: "unknown" }));
      if (r.approvalPolicy === "super_admin_only") r.approvalPolicy = "admins_only";
    }
    r.admins ??= [];
    r.revision ??= 0;
    r.audit ??= [];
    if (!Array.isArray(r.admins) || !r.admins.every(principal) || !Number.isSafeInteger(r.revision) || r.revision < 0) fail();
    if (!["admins_only", "any_non_blocked"].includes(r.approvalPolicy) || r.normalMessagePolicy !== "mentioned_non_blocked" || r.managementPolicy !== "super_admin_only" || r.blockedUserBehavior !== "silent") fail();
    for (const list of [r.admins, r.blockedSenders]) if (new Set(list.map((p) => p.senderId)).size !== list.length) fail();
    if (r.admins.some((p) => p.senderId === r.superAdmin?.senderId || r.blockedSenders.some((b) => b.senderId === p.senderId))) fail();
    if (r.blockedSenders.some((p) => p.blockedByRole !== undefined && !["local", "super_admin", "admin", "unknown"].includes(p.blockedByRole))) fail();
    if (!Array.isArray(r.audit) || r.audit.some((e) => !e || typeof e.at !== "string" || typeof e.actor !== "string" || typeof e.action !== "string" || !["allowed", "denied", "failed", "uncertain"].includes(e.outcome))) fail();
    if (r.knownPrincipals !== undefined && (!Array.isArray(r.knownPrincipals) || r.knownPrincipals.some((p) => !p || typeof p.senderId !== "string"))) fail();
    r.audit = r.audit.slice(-500);
    return r;
  });
  return { schemaVersion: GROUP_ACCESS_SCHEMA_VERSION, updatedAt: doc.updatedAt, groups };
}
