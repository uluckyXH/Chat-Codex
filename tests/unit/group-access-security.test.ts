import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GroupAccessService } from "../../src/group-access/service.js";
import { canApproveGroup, canManageGroup } from "../../src/group-access/policy.js";
import { MemoryStateStore } from "../../src/state/memory-state-store.js";
import { FileStateStore } from "../../src/state/file-state-store.js";
import { groupWriterBusy } from "../../src/group-access/writer-lock.js";
import type { TrustedRouteRecord } from "../../src/state/persistent-state-types.js";

const routeKey = "custom:account:group:chat";
const superActor = { kind: "sender" as const, senderId: "ou_super" };
const local = { kind: "local" as const };
const admin = { kind: "sender" as const, senderId: "ou_admin" };
const now = new Date().toISOString();
function route(): TrustedRouteRecord { return { routeKey, channelId: "custom", accountId: "account", conversationKind: "group", conversationId: "chat", trustedBySenderId: "ou_super", trustMethod: "pairing_code", trustedAt: now, createdAt: now, updatedAt: now }; }
function setup(state = new MemoryStateStore()) {
  state.trustRoute(route());
  const service = new GroupAccessService({ state });
  service.ensureForTrustedRoute(route());
  service.mutate(routeKey, superActor, { action: "admin_add", target: "ou_admin" });
  return { state, service };
}
function temp(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "group-security-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("group roles enforce the member/admin/superadmin matrix and block precedence", () => {
  const { service } = setup();
  for (const [id, approve, manage, superOnly] of [["ou_super", true, true, true], ["ou_admin", true, true, false], ["ou_member", false, false, false]] as const) {
    const r = service.get(routeKey);
    assert.equal(canApproveGroup(r, id).allowed, approve);
    assert.equal(canManageGroup(r, id).allowed, manage);
    assert.equal(canManageGroup(r, id, true).allowed, superOnly);
  }
  service.mutate(routeKey, superActor, { action: "approval", policy: "any_non_blocked" });
  assert.equal(canApproveGroup(service.get(routeKey), "ou_member").allowed, true);
  assert.equal(canManageGroup(service.get(routeKey), "ou_member").allowed, false);
  service.mutate(routeKey, admin, { action: "block", target: "ou_member" });
  assert.equal(canApproveGroup(service.get(routeKey), "ou_member").allowed, false);
});

test("ordinary admins cannot target self, peers or superadmin or change policy", () => {
  const { service } = setup();
  service.mutate(routeKey, local, { action: "admin_add", target: "ou_peer" });
  for (const target of ["ou_admin", "ou_peer", "ou_super"]) {
    for (const action of ["block", "unblock"] as const) assert.throws(() => service.mutate(routeKey, admin, { action, target }));
  }
  for (const action of ["admin_add", "admin_remove", "transfer"] as const) assert.throws(() => service.mutate(routeKey, admin, { action, target: "ou_member" }));
  assert.throws(() => service.mutate(routeKey, admin, { action: "approval", policy: "any_non_blocked" }));
  assert.equal(service.roleForSender(routeKey, "ou_peer"), "admin");
  assert.ok(service.get(routeKey)?.audit?.some((a) => a.outcome === "denied"));
});

test("block provenance prevents weaker unblocks and revoked admin roles never reappear", () => {
  const { service, state } = setup();
  service.mutate(routeKey, superActor, { action: "block", target: "ou_member" });
  assert.throws(() => service.mutate(routeKey, admin, { action: "unblock", target: "ou_member" }));
  const r = service.get(routeKey)!;
  r.blockedSenders[0].blockedByRole = undefined;
  state.upsertGroupAccess(r);
  assert.throws(() => service.mutate(routeKey, admin, { action: "unblock", target: "ou_member" }));
  service.mutate(routeKey, local, { action: "unblock", target: "ou_member" });
  service.mutate(routeKey, admin, { action: "block", target: "ou_member" });
  service.mutate(routeKey, superActor, { action: "admin_add", target: "ou_peer" });
  service.mutate(routeKey, { kind: "sender", senderId: "ou_peer" }, { action: "unblock", target: "ou_member" });
  service.mutate(routeKey, superActor, { action: "block", target: "ou_admin" });
  assert.equal(service.roleForSender(routeKey, "ou_admin"), "blocked");
  service.mutate(routeKey, local, { action: "unblock", target: "ou_admin" });
  assert.equal(service.roleForSender(routeKey, "ou_admin"), "member");
});

test("superadmin repair/transfer is explicit and open approval cannot bypass missing superadmin", () => {
  const { service, state } = setup();
  service.mutate(routeKey, local, { action: "transfer", target: "ou_admin" });
  assert.equal(service.roleForSender(routeKey, "ou_super"), "member");
  assert.equal(service.get(routeKey)?.admins?.length, 0);
  const r = service.get(routeKey)!;
  state.upsertGroupAccess({ ...r, superAdmin: undefined, approvalPolicy: "any_non_blocked" });
  service.ensureForTrustedRoute(route());
  assert.equal(service.get(routeKey)?.superAdmin, undefined);
  assert.equal(canApproveGroup(service.get(routeKey), "ou_member").reason, "missing_super_admin");
  const manual = { ...route(), routeKey: "custom:account:group:manual", conversationId: "manual", trustMethod: "manual" as const, trustedBySenderId: "local-tui" };
  assert.equal(service.ensureForTrustedRoute(manual)?.superAdmin, undefined);
});

test("permission revision rejects stale confirmations, discovery does not invalidate them, clones are independent", () => {
  const { service, state } = setup();
  const revision = service.get(routeKey)?.revision;
  const r = state.getGroupAccess(routeKey)!;
  r.admins!.length = 0;
  assert.equal(service.roleForSender(routeKey, "ou_admin"), "admin");
  service.recordKnownPrincipal({ id: "m", routeKey, channelId: "custom", accountId: "account", sender: { id: "ou_visitor" }, conversation: { id: "chat", kind: "group" }, timestamp: now });
  service.mutate(routeKey, superActor, { action: "admin_add", target: "ou_peer" }, revision);
  assert.throws(() => service.mutate(routeKey, superActor, { action: "block", target: "ou_member" }, revision), /权限已变化/);
});

test("schema v1 migrates with private backup, inert reserved roles and unknown block provenance", (t) => {
  const root = temp(t);
  const { service } = setup();
  const original = service.get(routeKey)!;
  const legacy = { ...original, admins: undefined, revision: undefined, audit: undefined, approvalPolicy: "super_admin_only", blockedSenders: [{ senderId: "ou_blocked", source: "command", createdAt: now }], reservedRoles: [{ roleId: "admin", label: "unused", members: [original.admins![0]], capabilities: { canApprove: true }, enabled: true, createdAt: now, updatedAt: now }] };
  const file = path.join(root, "group-access.json");
  const bytes = JSON.stringify({ schemaVersion: 1, updatedAt: now, groups: [legacy] });
  fs.writeFileSync(file, bytes);
  const store = new FileStateStore({ rootDir: root });
  assert.equal(store.getGroupAccessError(), undefined);
  const migrated = store.getGroupAccess(routeKey)!;
  assert.equal(migrated.approvalPolicy, "admins_only");
  assert.deepEqual(migrated.admins, []);
  assert.equal(migrated.blockedSenders[0].blockedByRole, "unknown");
  store.upsertGroupAccess(migrated);
  assert.equal(fs.readFileSync(`${file}.v1.bak`, "utf8"), bytes);
  assert.equal(fs.statSync(`${file}.v1.bak`).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion, 2);
  assert.deepEqual(new FileStateStore({ rootDir: root }).getGroupAccess(routeKey)?.reservedRoles, migrated.reservedRoles);
});

test("invalid group state fails closed while unrelated route state remains writable", (t) => {
  const root = temp(t);
  const file = path.join(root, "group-access.json");
  fs.writeFileSync(file, "{broken");
  const store = new FileStateStore({ rootDir: root });
  assert.ok(store.getGroupAccessError());
  assert.throws(() => new GroupAccessService({ state: store }).ensureForTrustedRoute(route()));
  store.trustRoute({ ...route(), routeKey: "weixin:work:direct:user", channelId: "weixin", accountId: "work", conversationKind: "direct", conversationId: "user" });
  assert.equal(new FileStateStore({ rootDir: root }).isRouteTrusted("weixin:work:direct:user"), true);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});

test("failed persistence retains prior roles and restart state", (t) => {
  const root = temp(t);
  const store = new FileStateStore({ rootDir: root });
  const { service } = setup(store);
  const previous = service.get(routeKey);
  fs.mkdirSync(path.join(root, "group-access.json.tmp"));
  assert.throws(() => service.mutate(routeKey, superActor, { action: "admin_add", target: "ou_new" }));
  assert.deepEqual(service.get(routeKey), previous);
  assert.equal(new FileStateStore({ rootDir: root }).getGroupAccess(routeKey)?.admins?.length, 1);
});

test("runtime writer excludes other windows and releases explicitly", (t) => {
  const root = temp(t);
  const first = new FileStateStore({ rootDir: root });
  const { service } = setup(first);
  const release = first.acquireGroupAccessWriter();
  assert.equal(groupWriterBusy(root), true);
  const second = new FileStateStore({ rootDir: root });
  assert.throws(() => second.acquireGroupAccessWriter(), /只读/);
  assert.throws(() => second.upsertGroupAccess(service.get(routeKey)!), /只读/);
  service.mutate(routeKey, superActor, { action: "admin_remove", target: "ou_admin" });
  release();
  const done = second.acquireGroupAccessWriter();
  assert.equal(second.getGroupAccess(routeKey)?.admins?.length, 0);
  done();
  assert.equal(groupWriterBusy(root), false);
});

test("local clear-super pauses privileged operations and the known bot cannot be granted a role", () => {
  const { service } = setup();
  service.recordBotIdentity(routeKey, "ou_bot");
  assert.throws(() => service.mutate(routeKey, superActor, { action: "admin_add", target: "ou_bot" }), /机器人/);
  assert.throws(() => service.mutate(routeKey, local, { action: "transfer", target: "ou_bot" }), /机器人/);
  assert.throws(() => service.mutate(routeKey, superActor, { action: "clear_super" }));
  service.mutate(routeKey, local, { action: "clear_super" });
  service.ensureForTrustedRoute(route());
  assert.equal(service.get(routeKey)?.superAdmin, undefined);
  assert.equal(service.canManage(routeKey, "ou_admin").reason, "missing_super_admin");
  service.mutate(routeKey, local, { action: "transfer", target: "ou_member" });
  assert.equal(service.roleForSender(routeKey, "ou_member"), "super_admin");
});

test("empty files, unknown schemas and mismatched scopes never initialize new grants", (t) => {
  const root = temp(t);
  const { service } = setup();
  const record = service.get(routeKey)!;
  for (const data of ["", JSON.stringify({ schemaVersion: 3, groups: [] }), JSON.stringify({ schemaVersion: 2, groups: [{ ...record, accountId: "different-account" }] }), JSON.stringify({ schemaVersion: 2, groups: [{ ...record, approvalPolicy: "everyone" }] })]) {
    fs.writeFileSync(path.join(root, "group-access.json"), data);
    const store = new FileStateStore({ rootDir: root });
    assert.ok(store.getGroupAccessError());
    assert.throws(() => new GroupAccessService({ state: store }).ensureForTrustedRoute(route()));
  }
});
