import type { TrustedRouteRecord } from "../state/persistent-state-types.js";
import { createGroupPrincipal, upsertKnownGroupPrincipal } from "./principal.js";
import type { GroupAccessRecord } from "./types.js";

export function groupAccessRecordFromTrustedRoute(
  route: TrustedRouteRecord,
  timestamp: string,
  existing?: GroupAccessRecord,
): GroupAccessRecord | undefined {
  if (route.conversationKind !== "group") return undefined;
  const source = route.trustMethod === "manual" ? "tui" : "pairing";
  const pairedPrincipal = createGroupPrincipal({
    senderId: route.trustedBySenderId,
    displayName: route.trustedBySenderDisplayName,
    source,
    createdAt: route.trustedAt || timestamp,
  });
  return {
    routeKey: route.routeKey,
    channelId: route.channelId,
    accountId: route.accountId,
    conversationKind: "group",
    conversationId: route.conversationId,
    superAdmin: existing?.superAdmin ?? pairedPrincipal,
    blockedSenders: existing?.blockedSenders ?? [],
    knownPrincipals: upsertKnownGroupPrincipal(existing?.knownPrincipals, {
      senderId: pairedPrincipal.senderId,
      displayName: pairedPrincipal.displayName,
      source: source === "pairing" ? "pairing" : "tui",
      seenAt: timestamp,
    }),
    normalMessagePolicy: existing?.normalMessagePolicy ?? "mentioned_non_blocked",
    approvalPolicy: existing?.approvalPolicy ?? "super_admin_only",
    managementPolicy: existing?.managementPolicy ?? "super_admin_only",
    blockedUserBehavior: existing?.blockedUserBehavior ?? "silent",
    reservedRoles: existing?.reservedRoles,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}
