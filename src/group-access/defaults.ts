import type { TrustedRouteRecord } from "../state/persistent-state-types.js";
import { createGroupPrincipal } from "./principal.js";
import type { GroupAccessRecord } from "./types.js";
export function groupAccessRecordFromTrustedRoute(route: TrustedRouteRecord, timestamp: string, existing?: GroupAccessRecord): GroupAccessRecord | undefined {
  if (route.conversationKind !== "group") return undefined;
  if (existing) return existing;
  const paired = route.trustMethod === "pairing_code";
  const principal = createGroupPrincipal({ senderId: route.trustedBySenderId, displayName: route.trustedBySenderDisplayName, source: "pairing", createdAt: route.trustedAt || timestamp });
  return {
    routeKey: route.routeKey, channelId: route.channelId, accountId: route.accountId, conversationKind: "group", conversationId: route.conversationId,
    superAdmin: paired ? principal : undefined, admins: [], revision: 0, audit: [], blockedSenders: [],
    knownPrincipals: paired ? [{ senderId: principal.senderId, displayName: principal.displayName, firstSeenAt: timestamp, lastSeenAt: timestamp, source: "pairing" }] : [],
    normalMessagePolicy: "mentioned_non_blocked", approvalPolicy: "admins_only", managementPolicy: "super_admin_only", blockedUserBehavior: "silent",
    createdAt: timestamp, updatedAt: timestamp,
  };
}
