import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { handleCompactCommand } from "../../src/bridge/commands/compact-command.js";
import { handleGoalCommand } from "../../src/bridge/commands/goal-command.js";
import { BridgeDelivery } from "../../src/bridge/delivery.js";
import type { CompactState } from "../../src/bridge/bridge-types.js";
import type { BridgeSessionFlow } from "../../src/bridge/session-flow.js";
import type { CodexAdapter, CodexGoal, CodexGoalStatus } from "../../src/codex/types.js";
import { SilentLogger } from "../../src/logging/logger.js";
import type { ChannelRegistry } from "../../src/channels/registry.js";
import type { ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";
import { MemoryStateStore } from "../../src/state/memory-state-store.js";
import { MockCodexAdapter } from "../../src/codex/mock-codex-adapter.js";

test("all explicit goal commands send user origin", async () => {
  const codex = new MockCodexAdapter();
  const session = await codex.startSession({ cwd: "/repo", routeKey: message().routeKey });
  const fixture = commandFixture(codex);
  fixture.state.bindSession(message().routeKey, session);
  const origins: unknown[] = [];
  fixture.codex.setGoal = async (id, objective, options) => { origins.push(options?.origin); return codex.getGoal(id).then((goal) => goal ?? { threadId: id, objective, status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 }); };
  fixture.codex.setGoalStatus = async (id, status, options) => { origins.push(options?.origin); return { threadId: id, objective: "目标", status, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 }; };
  fixture.codex.clearGoal = async (_id, options) => { origins.push(options?.origin); return true; };
  const flow = { ...sessionFlowStub(), ensureSession: async () => session } as unknown as BridgeSessionFlow;
  for (const command of ["/goal 工作", "/goal pause", "/goal resume", "/goal clear"]) {
    await handleGoalCommand({ ...fixture, sessionFlow: flow }, message(), target(), command);
  }
  assert.deepEqual(origins, ["user", "user", "user", "user"]);
});

test("goal command clears stale bindings when Codex thread history is missing", async () => {
  const fixture = commandFixture(new StaleGoalCodexAdapter());
  fixture.state.bindSession(message().routeKey, {
    id: "missing-thread",
    cwd: "/repo",
    createdAt: "2026-06-07T00:00:00.000Z",
  });

  await handleGoalCommand({
    codex: fixture.codex,
    state: fixture.state,
    delivery: fixture.delivery,
    sessionFlow: sessionFlowStub(),
  }, message(), target(), "/goal");

  assert.equal(fixture.state.getBinding(message().routeKey), undefined);
  assert.ok(fixture.sentTexts.some((text) => text.includes("已清理失效的 Codex 会话绑定")));
  assert.equal(fixture.sentTexts.some((text) => text.includes("no rollout found")), false);
});

test("compact command clears stale bindings when Codex thread history is missing", async () => {
  const fixture = commandFixture(new StaleCompactCodexAdapter());
  fixture.state.bindSession(message().routeKey, {
    id: "missing-thread",
    cwd: "/repo",
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  let compactState: CompactState = {
    type: "confirming",
    sessionId: "missing-thread",
    requestedAt: "2026-06-07T00:00:00.000Z",
  };

  await handleCompactCommand({
    codex: fixture.codex,
    state: fixture.state,
    delivery: fixture.delivery,
    logger: new SilentLogger(),
    compactStateForRoute: () => compactState,
    setCompactState: (_routeKey, state) => {
      compactState = state;
    },
    clearCompactState: () => {
      compactState = { type: "none" };
    },
    isRouteExecutionBusy: async () => false,
  }, message(), target(), ["confirm"]);

  assert.equal(fixture.state.getBinding(message().routeKey), undefined);
  assert.deepEqual(compactState, { type: "none" });
  assert.ok(fixture.sentTexts.some((text) => text.includes("已清理失效的 Codex 会话绑定")));
  assert.equal(fixture.sentTexts.some((text) => text.includes("no rollout found")), false);
});

function commandFixture(codex: CodexAdapter): {
  codex: CodexAdapter;
  state: MemoryStateStore;
  delivery: BridgeDelivery;
  sentTexts: string[];
} {
  const sentTexts: string[] = [];
  const delivery = new BridgeDelivery({
    channels: {
      sendText: async (_target: ChannelTarget, text: string) => {
        sentTexts.push(text);
        return { channelId: "mock", messageId: `m-${sentTexts.length}`, deliveredAt: new Date().toISOString() };
      },
      sendTyping: async () => undefined,
      getCapabilities: () => ({
        text: true,
        media: false,
        typing: true,
        direct: true,
        group: false,
        thread: false,
        login: "none" as const,
        messageUpdate: false,
        streamingHint: false,
      }),
    } as unknown as ChannelRegistry,
    approvals: new ApprovalManager(),
    logger: new SilentLogger(),
    approvalSendRetryDelayMs: 1,
  });
  return {
    codex,
    state: new MemoryStateStore(),
    delivery,
    sentTexts,
  };
}

function sessionFlowStub(): BridgeSessionFlow {
  return {
    unboundRoutePromptText: (msg: ChannelMessage) => [
      "当前聊天还没有绑定 Codex 会话。",
      "请先发送 /new 创建新会话，或发送 /resume 进入会话选择。",
      `Route: ${msg.routeKey}`,
    ].join("\n"),
  } as BridgeSessionFlow;
}

class StaleGoalCodexAdapter implements CodexAdapter {
  async startSession(): Promise<never> { throw new Error("not used"); }
  async resumeSession(): Promise<never> { throw new Error("not used"); }
  async *run(): AsyncIterable<never> { throw new Error("not used"); }
  async getStatus() { return { type: "unknown" as const }; }
  async listSessions() { return []; }
  async getGoal(): Promise<CodexGoal | null> {
    throw new Error("no rollout found for thread id missing-thread");
  }
  async setGoal(): Promise<CodexGoal> { throw new Error("not used"); }
  async setGoalStatus(_sessionId: string, _status: CodexGoalStatus): Promise<CodexGoal> { throw new Error("not used"); }
  async clearGoal(): Promise<boolean> { throw new Error("not used"); }
}

class StaleCompactCodexAdapter implements CodexAdapter {
  async startSession(): Promise<never> { throw new Error("not used"); }
  async resumeSession(): Promise<never> { throw new Error("not used"); }
  async *run(): AsyncIterable<never> { throw new Error("not used"); }
  async getStatus() { return { type: "unknown" as const }; }
  async listSessions() { return []; }
  async compactSession(): Promise<never> {
    throw new Error("ThreadNotFound: missing-thread");
  }
}

function message(): ChannelMessage {
  return {
    id: "message-1",
    routeKey: "mock:default:direct:user",
    channelId: "mock",
    sender: { id: "user" },
    conversation: { id: "user", kind: "direct" },
    text: "",
    timestamp: new Date().toISOString(),
  };
}

function target(): ChannelTarget {
  return {
    channelId: "mock",
    routeKey: "mock:default:direct:user",
    conversation: { id: "user", kind: "direct" },
    recipient: { id: "user" },
  };
}
