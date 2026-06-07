import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { BridgeDelivery } from "../../src/bridge/delivery.js";
import { BridgeSessionFlow, StaleCodexSessionBindingError } from "../../src/bridge/session-flow.js";
import type { UnboundRoutePolicy } from "../../src/bridge/bridge-types.js";
import { MockCodexAdapter } from "../../src/codex/mock-codex-adapter.js";
import { SilentLogger } from "../../src/logging/logger.js";
import type { ChannelRegistry } from "../../src/channels/registry.js";
import type { ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";
import { MemoryStateStore } from "../../src/state/memory-state-store.js";
import { SessionBindings } from "../../src/state/session-bindings.js";

test("BridgeSessionFlow creates new sessions in the startup cwd", async () => {
  const fixture = sessionFlowFixture({ cwd: "/repo" });

  const session = await fixture.flow.createNewSession(message("route-a"), target("route-a"));

  assert.equal(session.cwd, "/repo");
  assert.equal(fixture.state.getBinding("route-a")?.sessionId, session.id);
  assert.match(fixture.sentTexts.at(-1) ?? "", /已创建新 Codex 会话/);
  assert.match(fixture.sentTexts.at(-1) ?? "", /Cwd: \/repo/);
});

test("BridgeSessionFlow creates Codex App chat sessions and syncs title", async () => {
  const fixture = sessionFlowFixture({ cwd: "/repo" });

  const session = await fixture.flow.createNewAppChatSession(message("route-a"), target("route-a"));

  assert.equal(session.cwd, "/repo");
  assert.equal(session.title, "mock / default / route-a");
  assert.equal(fixture.state.getBinding("route-a")?.sessionId, session.id);
  assert.deepEqual(fixture.codex.sessionTitles, [{ sessionId: session.id, title: "mock / default / route-a" }]);
  assert.deepEqual(fixture.codex.sessionPreviews, [{ sessionId: session.id, preview: "mock / default / route-a" }]);
  const text = fixture.sentTexts.at(-1) ?? "";
  assert.match(text, /已创建 Codex App 对话/);
  assert.match(text, /标题: mock \/ default \/ route-a/);
  assert.match(text, /已写入 Codex preview/);
});

test("BridgeSessionFlow keeps app chat binding when title sync fails", async () => {
  const codex = new FailingTitleCodexAdapter();
  const fixture = sessionFlowFixture({ codex });

  const session = await fixture.flow.createNewAppChatSession(message("route-a"), target("route-a"));

  assert.equal(fixture.state.getBinding("route-a")?.sessionId, session.id);
  assert.match(fixture.sentTexts.at(-1) ?? "", /标题同步失败: title sync failed/);
});

test("BridgeSessionFlow binds an existing session by id", async () => {
  const fixture = sessionFlowFixture();
  const existing = await fixture.codex.startSession({ routeKey: "seed", cwd: "/seed", title: "seed" });

  await fixture.flow.resumeOrUseSession(message("route-a"), target("route-a"), existing.id);

  assert.equal(fixture.state.getBinding("route-a")?.sessionId, existing.id);
  assert.match(fixture.sentTexts.at(-1) ?? "", /已绑定 Codex 会话/);
  assert.match(fixture.sentTexts.at(-1) ?? "", new RegExp(existing.id));
});

test("BridgeSessionFlow reports owner conflicts without rebinding", async () => {
  const fixture = sessionFlowFixture();
  const existing = await fixture.codex.startSession({ routeKey: "seed", cwd: "/seed", title: "seed" });
  fixture.state.claimSessionOwner("route-other", existing.id);

  await fixture.flow.resumeOrUseSession(message("route-a"), target("route-a"), existing.id);

  assert.equal(fixture.state.getBinding("route-a"), undefined);
  assert.match(fixture.sentTexts.at(-1) ?? "", /无法绑定 Codex 会话/);
  assert.match(fixture.sentTexts.at(-1) ?? "", /Owner: route-other/);
});

test("BridgeSessionFlow keeps initial existing binding scoped to the first direct route", async () => {
  const codex = new MockCodexAdapter();
  const existing = await codex.startSession({ routeKey: "seed", cwd: "/seed", title: "seed" });
  const fixture = sessionFlowFixture({
    codex,
    initialRouteBinding: { type: "existing", sessionId: existing.id },
  });

  fixture.flow.claimPendingInitialRouteBindingRoute(message("route-a"));
  const otherSession = await fixture.flow.ensureSession(message("route-b"));
  const firstSession = await fixture.flow.ensureSession(message("route-a"));

  assert.notEqual(otherSession.id, existing.id);
  assert.equal(firstSession.id, existing.id);
  assert.equal(fixture.state.getBinding("route-a")?.sessionId, existing.id);
  assert.equal(fixture.state.getBinding("route-b")?.sessionId, otherSession.id);
});

test("BridgeSessionFlow clears stale active bindings and creates a replacement session", async () => {
  const staleSessionId = "01900000-0000-7000-8000-000000000000";
  const fixture = sessionFlowFixture({
    codex: new MissingRolloutCodexAdapter(staleSessionId),
    state: stateWithActiveBinding("route-a", staleSessionId),
  });

  const session = await fixture.flow.ensureSession(message("route-a"));

  assert.notEqual(session.id, staleSessionId);
  assert.equal(fixture.state.getBinding("route-a")?.sessionId, session.id);
  assert.equal(fixture.state.getSessionOwner(staleSessionId), undefined);
});

test("BridgeSessionFlow clears stale active bindings and asks when unbound policy is ask", async () => {
  const staleSessionId = "01900000-0000-7000-8000-000000000000";
  const fixture = sessionFlowFixture({
    codex: new MissingRolloutCodexAdapter(staleSessionId),
    state: stateWithActiveBinding("route-a", staleSessionId),
    unboundRoutePolicy: "ask",
  });

  await assert.rejects(
    () => fixture.flow.ensureSession(message("route-a")),
    StaleCodexSessionBindingError,
  );
  assert.equal(fixture.state.getBinding("route-a"), undefined);
  assert.equal(fixture.state.getSessionOwner(staleSessionId), undefined);
});

function sessionFlowFixture(options: {
  cwd?: string;
  codex?: MockCodexAdapter;
  state?: MemoryStateStore;
  initialRouteBinding?: { type: "existing"; sessionId: string } | { type: "new" };
  unboundRoutePolicy?: UnboundRoutePolicy;
} = {}) {
  const codex = options.codex ?? new MockCodexAdapter();
  const state = options.state ?? new MemoryStateStore();
  const sentTexts: string[] = [];
  const delivery = new BridgeDelivery({
    channels: {
      sendText: async (_target: ChannelTarget, text: string) => {
        sentTexts.push(text);
        return { channelId: "mock", messageId: `m-${sentTexts.length}`, deliveredAt: new Date().toISOString() };
      },
    } as unknown as ChannelRegistry,
    approvals: new ApprovalManager(),
    logger: new SilentLogger(),
    approvalSendRetryDelayMs: 1,
  });
  const flow = new BridgeSessionFlow({
    codex,
    state,
    delivery,
    cwd: options.cwd ?? "/workspace",
    initialRouteBinding: options.initialRouteBinding,
    unboundRoutePolicy: options.unboundRoutePolicy ?? "auto_new",
    isRouteExecutionBusy: async () => false,
    applyStoredSessionRunPolicy: () => undefined,
    collaborationModeForRoute: () => "default",
    hasRouteCollaborationMode: () => false,
    applyRouteCollaborationModeToSession: () => undefined,
    syncRouteCollaborationModeFromSession: () => "default",
  });
  return { codex, state, flow, sentTexts };
}

class FailingTitleCodexAdapter extends MockCodexAdapter {
  override async setSessionTitle(_sessionId: string, _title: string): Promise<void> {
    throw new Error("title sync failed");
  }
}

class MissingRolloutCodexAdapter extends MockCodexAdapter {
  constructor(private readonly missingSessionId: string) {
    super();
  }

  override async resumeSession(sessionId: string) {
    if (sessionId === this.missingSessionId) {
      throw new Error(`no rollout found for thread id ${sessionId}`);
    }
    return await super.resumeSession(sessionId);
  }
}

function stateWithActiveBinding(routeKey: string, sessionId: string): MemoryStateStore {
  const timestamp = "2026-06-07T00:00:00.000Z";
  return new MemoryStateStore(new SessionBindings({
    active: [{ routeKey, sessionId, createdAt: timestamp, updatedAt: timestamp }],
    owners: [{ sessionId, ownerRouteKey: routeKey, claimedAt: timestamp, updatedAt: timestamp }],
  }));
}

function message(routeKey: string): ChannelMessage {
  return {
    id: `message-${routeKey}`,
    routeKey,
    channelId: "mock",
    sender: { id: "user" },
    conversation: { id: routeKey, kind: "direct" },
    text: "",
    timestamp: new Date().toISOString(),
  };
}

function target(routeKey: string): ChannelTarget {
  return {
    channelId: "mock",
    routeKey,
    conversation: { id: routeKey, kind: "direct" },
    recipient: { id: "user" },
  };
}
