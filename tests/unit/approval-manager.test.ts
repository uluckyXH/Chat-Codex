import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";

test("ApprovalManager creates and resolves approvals", () => {
  const manager = new ApprovalManager();
  const pending = manager.create("mock:default:direct:user", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
    command: "echo ok",
  });

  assert.equal(pending.status, "pending");
  assert.equal(pending.expiresAt, undefined);
  assert.match(manager.formatForChannel(pending), /\/OK/);
  assert.match(manager.formatForChannel(pending), /\/P 本会话通过/);
  assert.match(manager.formatForChannel(pending), /\/NO 拒绝当前审批/);
  assert.doesNotMatch(manager.formatForChannel(pending), new RegExp(pending.approvalKey));
  assert.doesNotMatch(manager.formatForChannel(pending), /\/approve/);
  assert.equal(manager.latest(pending.routeKey)?.approvalKey, pending.approvalKey);

  const resolved = manager.decide(pending.approvalKey, pending.routeKey, "approve");
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.decision, "approve");
});

test("ApprovalManager only expires approvals when ttl is configured", () => {
  const manager = new ApprovalManager({ ttlMs: -1 });
  const pending = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });

  assert.equal(manager.latest("route-a"), undefined);
  assert.equal(manager.get(pending.approvalKey)?.status, "expired");
});

test("ApprovalManager latest returns the newest pending approval for a route", () => {
  const manager = new ApprovalManager({ ttlMs: 60_000 });
  const first = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });
  const second = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i2",
  });
  manager.create("route-b", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i3",
  });

  assert.notEqual(first.approvalKey, second.approvalKey);
  assert.equal(manager.latest("route-a")?.approvalKey, second.approvalKey);
});

test("ApprovalManager rejects wrong route decisions", () => {
  const manager = new ApprovalManager({ ttlMs: 60_000 });
  const pending = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });

  assert.throws(() => manager.decide(pending.approvalKey, "route-b", "deny"), /不属于当前会话/);
});

test("ApprovalManager cancels pending approvals for a route", () => {
  const manager = new ApprovalManager({ ttlMs: 60_000 });
  const first = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });
  manager.create("route-b", "user", {
    kind: "command",
    sessionId: "s2",
    turnId: "t2",
    itemId: "i2",
  });

  const cancelled = manager.cancelRoute("route-a", "任务已停止");

  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].approvalKey, first.approvalKey);
  assert.equal(cancelled[0].decision, "cancel");
  assert.equal(cancelled[0].decisionReason, "任务已停止");
  assert.equal(manager.list("route-a").length, 0);
  assert.equal(manager.list("route-b").length, 1);
});

test("ApprovalManager resolves pending approvals by adapter request id", () => {
  const manager = new ApprovalManager({ ttlMs: 60_000 });
  const pending = manager.create("route-a", "user", {
    kind: "command",
    adapterApprovalId: "server-request-1",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });
  manager.create("route-b", "user", {
    kind: "command",
    adapterApprovalId: "server-request-1",
    sessionId: "s2",
    turnId: "t2",
    itemId: "i2",
  });

  const resolved = manager.resolveAdapterApproval("route-a", "server-request-1", "already resolved by app-server");

  assert.equal(resolved?.approvalKey, pending.approvalKey);
  assert.equal(resolved?.status, "resolved");
  assert.equal(resolved?.decisionReason, "already resolved by app-server");
  assert.equal(manager.list("route-a").length, 0);
  assert.equal(manager.list("route-b").length, 1);
});
