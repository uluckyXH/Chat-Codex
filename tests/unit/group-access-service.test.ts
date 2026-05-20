import test from "node:test";
import assert from "node:assert/strict";
import { GroupAccessService } from "../../src/group-access/service.js";
import { MemoryStateStore } from "../../src/state/memory-state-store.js";
import type { ChannelMessage } from "../../src/protocol/channel.js";
import type { TrustedRouteRecord } from "../../src/state/persistent-state-types.js";

test("GroupAccessService initializes super admin from trusted group route", () => {
  const state = new MemoryStateStore();
  const service = new GroupAccessService({
    state,
    now: () => new Date("2026-05-21T00:00:00.000Z"),
  });

  const record = service.ensureForTrustedRoute(trustedGroupRoute());

  assert.equal(record?.routeKey, "feishu:default:group:oc_group");
  assert.equal(record?.superAdmin?.senderId, "ou_admin");
  assert.equal(record?.superAdmin?.source, "pairing");
  assert.equal(record?.approvalPolicy, "super_admin_only");
  assert.equal(record?.knownPrincipals?.[0]?.senderId, "ou_admin");
  assert.equal(state.getGroupAccess("feishu:default:group:oc_group")?.superAdmin?.senderId, "ou_admin");
});

test("GroupAccessService records known principals without granting roles", () => {
  const state = new MemoryStateStore();
  state.trustRoute(trustedGroupRoute());
  const service = new GroupAccessService({
    state,
    now: () => new Date("2026-05-21T00:00:00.000Z"),
  });

  service.ensureForTrustedGroupMessage(groupMessage("ou_member", "群成员"));
  const record = state.getGroupAccess("feishu:default:group:oc_group");

  assert.equal(record?.superAdmin?.senderId, "ou_admin");
  assert.equal(service.roleForSender("feishu:default:group:oc_group", "ou_member"), "member");
  assert.ok(record?.knownPrincipals?.some((principal) => principal.senderId === "ou_member"));
});

function trustedGroupRoute(): TrustedRouteRecord {
  return {
    routeKey: "feishu:default:group:oc_group",
    channelId: "feishu",
    accountId: "default",
    conversationKind: "group",
    conversationId: "oc_group",
    displayName: "研发群",
    trustedAt: "2026-05-21T00:00:00.000Z",
    trustedBySenderId: "ou_admin",
    trustedBySenderDisplayName: "管理员",
    trustMethod: "pairing_code",
    lastSeenAt: "2026-05-21T00:00:00.000Z",
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  };
}

function groupMessage(senderId: string, displayName: string): ChannelMessage {
  return {
    id: `om_${senderId}`,
    routeKey: "feishu:default:group:oc_group",
    channelId: "feishu",
    accountId: "default",
    sender: { id: senderId, displayName },
    conversation: { id: "oc_group", kind: "group", displayName: "研发群" },
    text: "hello",
    timestamp: "2026-05-21T00:01:00.000Z",
  };
}
