import test from "node:test";
import assert from "node:assert/strict";
import { AppServerCodexAdapter } from "../../src/codex/app-server-codex-adapter.js";
import { AppServerSessionStore } from "../../src/codex/app-server/session-store.js";
import { AppServerTurnController } from "../../src/codex/app-server/turn-controller.js";
import { AppServerRpcClient } from "../../src/codex/app-server/rpc-client.js";
import { AsyncEventQueue } from "../../src/codex/app-server/turn-store.js";
import type { JsonRpcNotification, JsonRpcRequest } from "../../src/codex/app-server/types.js";
import type { CodexEvent } from "../../src/codex/types.js";
import { approvalFromServerRequest, responseForApprovalDecision } from "../../src/codex/app-server/approval-handler.js";
import { availableApprovalDecisions, normalizeApprovalDecision } from "../../src/approvals/approval-policy.js";
import { modelInfoFromResponse, modelsFromListResponse } from "../../src/codex/app-server/model-policy.js";

function fixture() {
  const adapter = new AppServerCodexAdapter();
  const internal = adapter as unknown as {
    sessionStore: AppServerSessionStore; turns: AppServerTurnController; rpc: AppServerRpcClient;
    handleServerRequest(request: JsonRpcRequest): void;
    handleNotification(notification: JsonRpcNotification): void;
    ensureSessionLoaded(id: string): Promise<void>;
    ensureStarted(): Promise<void>;
    loadedSessionIds: Set<string>;
    request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  const writes: unknown[] = [];
  internal.rpc.writeMessage = (message) => { writes.push(message); };
  internal.sessionStore.set("s", { session: { id: "s", cwd: "/repo", createdAt: "now" }, status: { type: "running", turnId: "t" }, currentTurnId: "t", updatedAt: "now" });
  const queue = new AsyncEventQueue<CodexEvent>();
  internal.turns.registerTurn("s", "t", queue);
  const input = (id: string, isBlocking?: boolean) => internal.handleServerRequest({ id, method: "item/tool/requestUserInput", params: { threadId: "s", turnId: "t", isBlocking, questions: [{ id: "q", question: "Choose", options: [{ label: "Yes" }] }] } });
  const resolved = (id: string, threadId = "s") => internal.handleNotification({ method: "serverRequest/resolved", params: { threadId, requestId: id } });
  return { adapter, internal, input, resolved, writes, queue };
}

test("nonblocking input preserves running state; resolving another request cannot clear a blocking one", async () => {
  const f = fixture();
  f.input("optional", false);
  assert.equal(f.internal.sessionStore.getStatus("s").type, "running");
  f.internal.handleNotification({ method: "thread/status/changed", params: { threadId: "s", status: { type: "active", activeFlags: ["waitingOnUserInput"] } } });
  assert.equal(f.internal.sessionStore.getStatus("s").type, "running");
  f.input("blocking");
  assert.equal(f.internal.sessionStore.getStatus("s").type, "waiting_input");
  f.resolved("optional", "other-thread");
  await f.adapter.resolveUserInput("rpc-0:optional", { answers: {} });
  assert.equal(f.internal.sessionStore.getStatus("s").type, "waiting_input");
  f.resolved("blocking");
  assert.equal(f.internal.sessionStore.getStatus("s").type, "running");
  await assert.rejects(f.adapter.resolveUserInput("rpc-0:blocking", { answers: {} }), /未找到/);
  await f.adapter.stop();
});

test("closed turns and restarted connections reject late answers and do not revive old status", async () => {
  const f = fixture();
  f.input("optional", false);
  f.internal.handleNotification({ method: "turn/completed", params: { threadId: "s", turn: { id: "t", status: "completed" } } });
  f.resolved("optional");
  assert.equal(f.internal.sessionStore.getStatus("s").type, "idle");
  await assert.rejects(f.adapter.resolveUserInput("rpc-0:optional", { answers: {} }), /未找到/);
  await f.adapter.stop();
  f.internal.turns.registerTurn("s", "t", new AsyncEventQueue<CodexEvent>());
  f.input("optional", false);
  await assert.rejects(f.adapter.resolveUserInput("rpc-0:optional", { answers: {} }), /未找到/);
  await f.adapter.resolveUserInput("rpc-1:optional", { answers: {} });
  assert.deepEqual(f.writes.at(-1), { id: "optional", result: { answers: {} } });
  await f.adapter.stop();
});

test("goal mutations preserve explicit user/automatic provenance and never invent user authorization", async () => {
  const f = fixture();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  f.internal.ensureSessionLoaded = async () => undefined;
  f.internal.request = async (method, params) => {
    calls.push({ method, params });
    return { goal: { threadId: "s", objective: "工作", status: params.status ?? "active" }, cleared: true };
  };
  await f.adapter.setGoal("s", "工作", { origin: "user" });
  await f.adapter.setGoalStatus("s", "paused", { origin: "user" });
  await f.adapter.setGoalStatus("s", "blocked", { origin: "automatic" });
  await f.adapter.setGoalStatus("s", "complete");
  await f.adapter.clearGoal("s", { origin: "user" });
  assert.deepEqual(calls.map((call) => call.params.origin), ["user", "user", "automatic", undefined, "user"]);
  f.internal.handleNotification({ method: "thread/goal/updated", params: { threadId: "s", turnId: "future", goal: { objective: "新目标", status: "budgetLimited", tokensUsed: 123 } } });
  assert.equal(f.internal.sessionStore.getStatus("s").goal?.status, "budgetLimited");
  assert.equal(f.internal.turns.get("future"), undefined);
  f.internal.handleNotification({ method: "thread/goal/cleared", params: { threadId: "s" } });
  assert.equal(f.internal.sessionStore.getStatus("s").goal, null);
  await f.adapter.stop();
});

test("effective server settings are separate from requested policy and preserve null and permission provenance", async () => {
  const f = fixture();
  f.adapter.setModelPolicy({ model: "requested", serviceTier: "fast", reasoningEffort: "high" }, "s");
  f.adapter.setRunPolicy({ permissionMode: "full" }, "s");
  f.internal.handleNotification({ method: "thread/settings/updated", params: { threadId: "s", threadSettings: {
    model: "actual", serviceTier: null, effort: null, collaborationMode: { mode: "plan", settings: { model: "actual" } },
    approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandboxPolicy: { type: "readOnly", networkAccess: false },
    activePermissionProfile: { id: "managed", extends: ":read-only" }, cwd: "/effective",
  } } });
  assert.deepEqual(f.internal.sessionStore.getStatus("s").model, { model: "actual", serviceTier: null, reasoningEffort: null });
  assert.equal(f.adapter.getModelPolicy("s").model, "requested");
  assert.equal(f.adapter.getCollaborationMode("s"), "plan");
  const permission = f.adapter.getRunPolicyStatus("s");
  assert.equal(permission.policy.permissionMode, "full");
  assert.equal(permission.effectiveSandbox, "read-only");
  assert.equal(permission.interactiveApprovals, true);
  assert.equal(permission.activePermissionProfile, "managed");
  f.adapter.setModelPolicy({ model: "next" }, "s");
  assert.equal(f.internal.sessionStore.getStatus("s").model?.model, "actual");
  f.internal.handleNotification({ method: "thread/settings/updated", params: { threadId: "s", threadSettings: { cwd: "/new" } } });
  assert.equal(f.internal.sessionStore.getStatus("s").model?.model, "actual");
  assert.equal(f.internal.sessionStore.getStatus("s").effectiveSettings?.activePermissionProfile?.extends, ":read-only");
  f.internal.handleNotification({ method: "model/rerouted", params: { threadId: "s", turnId: "t", toModel: "rerouted" } });
  f.internal.handleNotification({ method: "thread/settings/updated", params: { threadId: "s", threadSettings: { effort: "low" } } });
  assert.equal(f.internal.sessionStore.getStatus("s").model?.model, "rerouted");
  assert.deepEqual(modelInfoFromResponse({}, { model: "old", reasoningEffort: "low" }), { model: "old", reasoningEffort: "low" });
  await f.adapter.stop();
});

test("explicit empty and unknown approval decisions cannot become default grants", async () => {
  for (const availableDecisions of [[], ["futureDecision"], [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ["ls"] } }]]) {
    const params = { threadId: "s", turnId: "t", command: "ls", availableDecisions };
    const approval = approvalFromServerRequest("item/commandExecution/requestApproval", "a", params)!;
    assert.deepEqual(availableApprovalDecisions(approval), []);
    assert.equal(normalizeApprovalDecision(approval, "approve"), undefined);
    const f = fixture();
    f.internal.handleServerRequest({ id: "a", method: "item/commandExecution/requestApproval", params });
    assert.deepEqual(f.writes[0], { id: "a", error: { code: -32602, message: "approval has no supported decisions" } });
    await assert.rejects(f.adapter.resolveApproval("rpc-0:a", "approve"), /未找到/);
    await f.adapter.stop();
  }
  const legacy = approvalFromServerRequest("item/commandExecution/requestApproval", "a", { command: "ls" })!;
  assert.ok(availableApprovalDecisions(legacy).includes("approve"));
  const mixed = approvalFromServerRequest("item/commandExecution/requestApproval", "a", { availableDecisions: ["future", "decline"] })!;
  assert.deepEqual(availableApprovalDecisions(mixed), ["deny"]);
});

test("permission approvals display and return the requested scope; unknown structures cannot grant", () => {
  const permissions = { network: { enabled: true }, fileSystem: { entries: [{ access: "write", path: { type: "path", path: "/requested" } }] } };
  const approval = approvalFromServerRequest("item/permissions/requestApproval", "a", { permissions })!;
  assert.match(approval.reason ?? "", /\/requested/);
  assert.deepEqual(responseForApprovalDecision("item/permissions/requestApproval", { permissions }, "approve-session"), { scope: "session", permissions });
  const malformed = { network: { enabled: true, futureScope: "all" } };
  const unsupported = approvalFromServerRequest("item/permissions/requestApproval", "a", { permissions: malformed })!;
  assert.deepEqual(availableApprovalDecisions(unsupported), ["deny", "cancel"]);
  assert.throws(() => responseForApprovalDecision("item/permissions/requestApproval", { permissions: malformed }, "approve"), /unsupported/);
  assert.deepEqual(responseForApprovalDecision("item/permissions/requestApproval", { permissions: malformed }, "deny"), { scope: "turn", permissions: {} });
});

test("history reversion invalidates loaded state and old requests without deleting the session", async () => {
  const f = fixture();
  f.internal.loadedSessionIds.add("s");
  f.input("optional", false);
  f.internal.handleNotification({ method: "thread/reverted", params: { threadId: "s" } });
  assert.equal(f.internal.loadedSessionIds.has("s"), false);
  assert.equal(f.internal.sessionStore.has("s"), true);
  assert.equal(f.internal.turns.hasActiveTurns(), false);
  await assert.rejects(f.adapter.resolveUserInput("rpc-0:optional", { answers: {} }), /未找到/);
  const calls: string[] = [];
  f.internal.ensureStarted = async () => undefined;
  f.internal.request = async (method) => {
    calls.push(method);
    return { thread: { id: "s" }, cwd: "/repo", model: "effective", collaborationMode: { mode: "plan" } };
  };
  await f.adapter.resumeSession("s");
  assert.deepEqual(calls, ["thread/resume"]);
  assert.equal(f.adapter.getCollaborationMode("s"), "plan");
  await f.adapter.stop();
});

test("reversion during resume rejects the stale response instead of caching it", async () => {
  const f = fixture();
  f.internal.turns.closeAll();
  f.internal.ensureStarted = async () => undefined;
  f.internal.request = async () => {
    f.internal.handleNotification({ method: "thread/reverted", params: { threadId: "s" } });
    return { thread: { id: "s" }, model: "stale" };
  };
  await assert.rejects(f.adapter.resumeSession("s"), /历史在恢复期间已回退/);
  assert.equal(f.internal.loadedSessionIds.has("s"), false);
  await f.adapter.stop();
});

test("currentTime/read answers whole Unix seconds directly without a chat interaction", async () => {
  const f = fixture();
  const before = Math.floor(Date.now() / 1000);
  f.internal.handleServerRequest({ id: 7, method: "currentTime/read", params: { threadId: "s" } });
  const response = f.writes[0] as { id: number; result: { currentTimeAt: number } };
  assert.equal(response.id, 7);
  assert.ok(Number.isInteger(response.result.currentTimeAt));
  assert.ok(response.result.currentTimeAt >= before && response.result.currentTimeAt <= Math.floor(Date.now() / 1000));
  f.internal.handleServerRequest({ id: 8, method: "currentTime/read", params: {} });
  assert.equal((f.writes[1] as { error: { code: number } }).error.code, -32602);
  f.internal.turns.closeAll();
  const events: CodexEvent[] = [];
  for await (const event of f.queue) events.push(event);
  assert.deepEqual(events, []);
  await f.adapter.stop();
});

test("model discovery retains metadata, nulls, and future effort names without deprecated tier fallback", () => {
  const model = modelsFromListResponse({ data: [{ id: "future", model: "future", modelSpecialty: "coding", multiAgentVersion: "v3", availableAccessPrograms: { cyber: ["preview"] }, supportedReasoningEfforts: [{ reasoningEffort: "ultra" }, { reasoningEffort: "future_effort" }], serviceTiers: [], additionalSpeedTiers: ["fast"], supportsPersonality: false }] })[0]!;
  assert.equal(model.modelSpecialty, "coding");
  assert.equal(model.multiAgentVersion, "v3");
  assert.deepEqual(model.availableAccessPrograms, { cyber: ["preview"] });
  assert.deepEqual(model.serviceTiers, []);
  assert.deepEqual(model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort), ["ultra", "future_effort"]);
  const empty = modelsFromListResponse({ data: [{ id: "empty", model: "empty", modelSpecialty: null, multiAgentVersion: null, availableAccessPrograms: null }] })[0]!;
  assert.equal(empty.availableAccessPrograms, null);
});
