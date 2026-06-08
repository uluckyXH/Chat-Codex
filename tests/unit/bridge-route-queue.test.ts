import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { BridgeDelivery } from "../../src/bridge/delivery.js";
import { SessionContextRefreshManager } from "../../src/bridge/context-refresh.js";
import { BridgeRouteQueue } from "../../src/bridge/route-queue.js";
import { BridgeSessionFlow } from "../../src/bridge/session-flow.js";
import { UnlimitedTurnScheduler } from "../../src/bridge/turn-scheduler.js";
import type { UnboundRoutePolicy } from "../../src/bridge/bridge-types.js";
import { MockCodexAdapter } from "../../src/codex/mock-codex-adapter.js";
import type { CodexEvent, CodexPromptInput } from "../../src/codex/types.js";
import type { CodexSessionContextFingerprint } from "../../src/codex/session-context-fingerprint.js";
import { codexInputPlainText } from "../../src/codex/input.js";
import { SilentLogger } from "../../src/logging/logger.js";
import type { ChannelRegistry } from "../../src/channels/registry.js";
import type { ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";
import { DEFAULT_CHANNEL_DELIVERY_POLICY, type ChannelDeliveryPolicy } from "../../src/protocol/delivery-policy.js";
import { MemoryStateStore } from "../../src/state/memory-state-store.js";
import { SessionBindings } from "../../src/state/session-bindings.js";

test("BridgeRouteQueue forwards prompts and sends final replies", async () => {
  const fixture = routeQueueFixture();

  await fixture.queue.enqueuePrompt(message("route-a", "你好"), target("route-a"), "你好");
  await fixture.queue.waitForWorkers();

  assert.equal(fixture.codex.runs[0]?.prompt, "你好");
  assert.ok(fixture.sentTexts.some((text) => text.includes("Codex 正在处理这条消息。")));
  assert.ok(fixture.sentTexts.some((text) => text.includes("Mock Codex 回复: 你好")));
});

test("BridgeRouteQueue clears chat approvals when app-server resolves request", async () => {
  const fixture = routeQueueFixture({ codex: new ResolvedApprovalCodexAdapter() });

  await fixture.queue.enqueuePrompt(message("route-a", "需要审批"), target("route-a"), "需要审批");
  await fixture.queue.waitForWorkers();

  assert.equal(fixture.approvals.list("route-a").length, 0);
  assert.ok(fixture.sentTexts.some((text) => text.includes("Codex 请求审批")));
  assert.ok(fixture.sentTexts.some((text) => text.includes("done after external approval")));
});

test("BridgeRouteQueue delivers Codex notifications even when progress is suppressed", async () => {
  const fixture = routeQueueFixture({
    codex: new NotificationCodexAdapter({
      text: "Codex 安全提示：完整安全原因必须推送",
      kind: "security",
      method: "guardianWarning",
    }),
    shouldDeliverProgress: false,
  });

  await fixture.queue.enqueuePrompt(message("route-a", "安全通知"), target("route-a"), "安全通知");
  await fixture.queue.waitForWorkers();

  assert.ok(fixture.sentTexts.some((text) => text.includes("完整安全原因必须推送")));
  assert.equal(fixture.sentTexts.some((text) => text.includes("普通进度不应发送")), false);
});

test("BridgeRouteQueue unbinds current route when Codex archives the thread", async () => {
  const codex = new LifecycleNotificationCodexAdapter("archived");
  const session = await codex.startSession({ routeKey: "route-a", cwd: "/repo" });
  const state = new MemoryStateStore();
  state.bindSession("route-a", session);
  const fixture = routeQueueFixture({ codex, state });

  await fixture.queue.enqueuePrompt(message("route-a", "触发生命周期通知"), target("route-a"), "触发生命周期通知");
  await fixture.queue.waitForWorkers();

  assert.equal(fixture.state.getBinding("route-a"), undefined);
  assert.equal(fixture.state.getSessionOwner(session.id), undefined);
  assert.equal(fixture.state.getSession(session.id)?.status.type, "unknown");
  assert.ok(fixture.sentTexts.some((text) => text.includes("已在 Codex 侧归档") && text.includes("/new") && text.includes("/resume")));
});

test("BridgeRouteQueue deduplicates repeated Codex notifications", async () => {
  const fixture = routeQueueFixture({ codex: new DuplicateNotificationCodexAdapter() });

  await fixture.queue.enqueuePrompt(message("route-a", "重复通知"), target("route-a"), "重复通知");
  await fixture.queue.waitForWorkers();

  assert.equal(fixture.sentTexts.filter((text) => text.includes("Codex 配置警告：重复配置")).length, 1);
});

test("BridgeRouteQueue serializes same-route prompts and can clear queued work", async () => {
  const codex = new BlockingCodexAdapter();
  const fixture = routeQueueFixture({ codex });

  await fixture.queue.enqueuePrompt(message("route-a", "第一条"), target("route-a"), "第一条");
  await waitFor(() => codex.started);
  await fixture.queue.enqueuePrompt(message("route-a", "第二条"), target("route-a"), "第二条");

  assert.equal(fixture.queue.queueLength("route-a"), 1);
  assert.ok(fixture.sentTexts.some((text) => text.includes("已加入队列，前面还有 1 条消息。")));
  assert.equal(fixture.queue.clearQueued("route-a"), 1);

  codex.release();
  await fixture.queue.waitForWorkers();

  assert.deepEqual(codex.promptRuns, ["第一条"]);
});

test("BridgeRouteQueue reloads externally updated context before running prompt", async () => {
  const fixture = routeQueueFixture({ contextRefreshMode: "reload" });
  const session = await fixture.codex.startSession({ routeKey: "route-a", cwd: "/repo" });
  fixture.state.bindSession("route-a", session);
  fixture.state.setSessionContextSnapshot({ sessionId: session.id, observedBy: "bind", fingerprint: fp(session.id, 10, 100) });
  fixture.setFingerprint(fp(session.id, 20, 120));

  await fixture.queue.enqueuePrompt(message("route-a", "继续"), target("route-a"), "继续");
  await fixture.queue.waitForWorkers();

  assert.deepEqual(fixture.codex.reloadedSessions, [session.id]);
  assert.equal(fixture.codex.runs[0]?.prompt, "继续");
  assert.ok(fixture.sentTexts.some((text) => text.includes("已在发送前重新加载")));
});

test("BridgeRouteQueue keeps persisted snapshot for refresh check when auto-resuming", async () => {
  const codex = new MockCodexAdapter();
  const session = await codex.startSession({ routeKey: "route-a", cwd: "/repo" });
  const timestamp = "2026-05-18T00:00:00.000Z";
  const state = new MemoryStateStore(new SessionBindings({
    active: [{ routeKey: "route-a", sessionId: session.id, createdAt: timestamp, updatedAt: timestamp }],
    owners: [{ sessionId: session.id, ownerRouteKey: "route-a", claimedAt: timestamp, updatedAt: timestamp }],
  }));
  state.setSessionContextSnapshot({ sessionId: session.id, observedBy: "chat-codex-turn", fingerprint: fp(session.id, 10, 100) });
  const fixture = routeQueueFixture({ codex, state, contextRefreshMode: "reload" });
  fixture.setFingerprint(fp(session.id, 20, 120));

  await fixture.queue.enqueuePrompt(message("route-a", "继续"), target("route-a"), "继续");
  await fixture.queue.waitForWorkers();

  assert.deepEqual(fixture.codex.reloadedSessions, [session.id]);
  assert.equal(fixture.codex.runs[0]?.prompt, "继续");
  assert.ok(fixture.sentTexts.some((text) => text.includes("已在发送前重新加载")));
});

test("BridgeRouteQueue replaces stale active bindings without raw Codex failures", async () => {
  const staleSessionId = "01900000-0000-7000-8000-000000000000";
  const fixture = routeQueueFixture({
    codex: new MissingRolloutCodexAdapter(staleSessionId),
    state: stateWithActiveBinding("route-a", staleSessionId),
  });

  await fixture.queue.enqueuePrompt(message("route-a", "继续"), target("route-a"), "继续");
  await fixture.queue.waitForWorkers();

  assert.equal(fixture.codex.runs[0]?.prompt, "继续");
  assert.notEqual(fixture.codex.runs[0]?.sessionId, staleSessionId);
  assert.equal(fixture.state.getBinding("route-a")?.sessionId, fixture.codex.runs[0]?.sessionId);
  assert.ok(fixture.sentTexts.some((text) => text.includes("已清理失效的 Codex 会话绑定")));
  assert.equal(fixture.sentTexts.some((text) => text.includes("Codex 执行失败: no rollout found")), false);
});

test("BridgeRouteQueue asks after clearing stale active bindings when policy is ask", async () => {
  const staleSessionId = "01900000-0000-7000-8000-000000000000";
  const fixture = routeQueueFixture({
    codex: new MissingRolloutCodexAdapter(staleSessionId),
    state: stateWithActiveBinding("route-a", staleSessionId),
    unboundRoutePolicy: "ask",
  });

  await fixture.queue.enqueuePrompt(message("route-a", "继续"), target("route-a"), "继续");
  await fixture.queue.waitForWorkers();

  assert.equal(fixture.codex.runs.length, 0);
  assert.equal(fixture.state.getBinding("route-a"), undefined);
  assert.ok(fixture.sentTexts.some((text) => text.includes("请先发送 /new 创建新会话")));
  assert.equal(fixture.sentTexts.some((text) => text.includes("Codex 执行失败: no rollout found")), false);
});

test("BridgeRouteQueue stops prompt when external update reload fails", async () => {
  const fixture = routeQueueFixture({ contextRefreshMode: "reload" });
  fixture.state.bindSession("route-a", {
    id: "missing-session",
    cwd: "/repo",
    createdAt: "2026-05-18T00:00:00.000Z",
  });
  fixture.state.setSessionContextSnapshot({ sessionId: "missing-session", observedBy: "bind", fingerprint: fp("missing-session", 10, 100) });
  fixture.setFingerprint(fp("missing-session", 20, 120));

  await fixture.queue.enqueuePrompt(message("route-a", "继续"), target("route-a"), "继续");
  await fixture.queue.waitForWorkers();

  assert.equal(fixture.codex.runs.length, 0);
  assert.ok(fixture.sentTexts.some((text) => text.includes("本条消息没有发送")));
});

function routeQueueFixture(options: {
  codex?: MockCodexAdapter;
  state?: MemoryStateStore;
  contextRefreshMode?: "off" | "detect" | "reload";
  unboundRoutePolicy?: UnboundRoutePolicy;
  deliveryPolicy?: ChannelDeliveryPolicy;
  shouldDeliverProgress?: boolean;
} = {}) {
  const codex = options.codex ?? new MockCodexAdapter();
  const state = options.state ?? new MemoryStateStore();
  const approvals = new ApprovalManager();
  const sentTexts: string[] = [];
  const delivery = new BridgeDelivery({
    channels: {
      sendText: async (_target: ChannelTarget, text: string) => {
        sentTexts.push(text);
        return { channelId: "mock", messageId: `m-${sentTexts.length}`, deliveredAt: new Date().toISOString() };
      },
      getCapabilities: () => ({
        text: true,
        media: false,
        typing: false,
        direct: true,
        group: false,
        thread: false,
        login: "none" as const,
        messageUpdate: false,
        streamingHint: false,
      }),
    } as unknown as ChannelRegistry,
    approvals,
    logger: new SilentLogger(),
    approvalSendRetryDelayMs: 1,
  });
  const sessionFlow = new BridgeSessionFlow({
    codex,
    state,
    delivery,
    cwd: "/repo",
    unboundRoutePolicy: options.unboundRoutePolicy ?? "auto_new",
    isRouteExecutionBusy: async () => false,
    applyStoredSessionRunPolicy: () => undefined,
    collaborationModeForRoute: () => "default",
    hasRouteCollaborationMode: () => false,
    applyRouteCollaborationModeToSession: () => undefined,
    syncRouteCollaborationModeFromSession: () => "default",
  });
  let currentFingerprint: CodexSessionContextFingerprint | undefined;
  const contextRefresh = options.contextRefreshMode
    ? new SessionContextRefreshManager({
        state,
        codex,
        defaultPolicy: { mode: options.contextRefreshMode },
        readFingerprint: () => currentFingerprint,
      })
    : undefined;
  const queue = new BridgeRouteQueue({
    codex,
    state,
    approvals,
    turnScheduler: new UnlimitedTurnScheduler(),
    delivery,
    sessionFlow,
    hasBackgroundTurnForRoute: () => false,
    currentCollaborationMode: () => undefined,
    deliveryPolicyFor: () => options.deliveryPolicy ?? DEFAULT_CHANNEL_DELIVERY_POLICY,
    shouldDeliverProgressWithPolicy: () => options.shouldDeliverProgress ?? true,
    shouldDeliverToolProgressWithPolicy: () => false,
    contextRefresh,
  });
  return {
    codex,
    state,
    approvals,
    queue,
    sentTexts,
    setFingerprint: (fingerprint: CodexSessionContextFingerprint | undefined) => {
      currentFingerprint = fingerprint;
    },
  };
}

class NotificationCodexAdapter extends MockCodexAdapter {
  constructor(private readonly notification: Pick<Extract<CodexEvent, { type: "codex.notification" }>["notification"], "method" | "kind" | "text">) {
    super();
  }

  override async *run(sessionId: string, _prompt: CodexPromptInput): AsyncIterable<CodexEvent> {
    const turnId = "notification-turn";
    yield { type: "turn.started", sessionId, turnId };
    yield { type: "assistant.progress", sessionId, turnId, text: "普通进度不应发送", kind: "other" };
    yield {
      type: "codex.notification",
      sessionId,
      turnId,
      notification: {
        method: this.notification.method,
        kind: this.notification.kind,
        text: this.notification.text,
        dedupeKey: `${this.notification.method}:${this.notification.text}`,
        dedupeWindowMs: 10 * 60_000,
      },
    };
    yield { type: "assistant.completed", sessionId, turnId, text: "done" };
    yield { type: "turn.completed", sessionId, turnId };
  }
}

class LifecycleNotificationCodexAdapter extends MockCodexAdapter {
  constructor(private readonly lifecycle: "archived" | "closed") {
    super();
  }

  override async *run(sessionId: string, _prompt: CodexPromptInput): AsyncIterable<CodexEvent> {
    const turnId = "lifecycle-turn";
    yield { type: "turn.started", sessionId, turnId };
    yield {
      type: "codex.notification",
      sessionId,
      turnId,
      notification: {
        method: this.lifecycle === "archived" ? "thread/archived" : "thread/closed",
        kind: "lifecycle",
        text: `thread ${this.lifecycle}`,
        dedupeKey: `thread/${this.lifecycle}:${sessionId}`,
        dedupeWindowMs: 10 * 60_000,
        lifecycle: this.lifecycle,
        unbindRoute: true,
      },
    };
    yield { type: "turn.completed", sessionId, turnId };
  }
}

class DuplicateNotificationCodexAdapter extends MockCodexAdapter {
  override async *run(sessionId: string, _prompt: CodexPromptInput): AsyncIterable<CodexEvent> {
    const turnId = "duplicate-notification-turn";
    const notification: Extract<CodexEvent, { type: "codex.notification" }> = {
      type: "codex.notification",
      sessionId,
      turnId,
      notification: {
        method: "configWarning",
        kind: "config",
        text: "Codex 配置警告：重复配置",
        dedupeKey: `configWarning:${sessionId}:重复配置`,
        dedupeWindowMs: 30 * 60_000,
      },
    };
    yield { type: "turn.started", sessionId, turnId };
    yield notification;
    yield notification;
    yield { type: "assistant.completed", sessionId, turnId, text: "done" };
    yield { type: "turn.completed", sessionId, turnId };
  }
}

class ResolvedApprovalCodexAdapter extends MockCodexAdapter {
  override async *run(sessionId: string, _prompt: CodexPromptInput): AsyncIterable<CodexEvent> {
    const turnId = "resolved-approval-turn";
    yield { type: "turn.started", sessionId, turnId };
    yield {
      type: "approval.requested",
      sessionId,
      turnId,
      approval: {
        kind: "command",
        adapterApprovalId: "approval-resolved",
        sessionId,
        turnId,
        itemId: "cmd-1",
        command: "touch done.txt",
      },
    };
    yield { type: "approval.resolved", sessionId, turnId, adapterApprovalId: "approval-resolved" };
    yield { type: "assistant.completed", sessionId, turnId, text: "done after external approval" };
    yield { type: "turn.completed", sessionId, turnId };
  }
}

class BlockingCodexAdapter extends MockCodexAdapter {
  readonly promptRuns: string[] = [];
  started = false;
  private releaseCurrent: (() => void) | undefined;

  override async *run(sessionId: string, prompt: CodexPromptInput): AsyncIterable<CodexEvent> {
    const promptText = codexInputPlainText(prompt);
    this.promptRuns.push(promptText);
    const turnId = `blocking-${this.promptRuns.length}`;
    this.started = true;
    yield { type: "turn.started", sessionId, turnId };
    await new Promise<void>((resolve) => {
      this.releaseCurrent = resolve;
    });
    yield { type: "assistant.completed", sessionId, turnId, text: `完成: ${promptText}` };
    yield { type: "turn.completed", sessionId, turnId };
  }

  release(): void {
    this.releaseCurrent?.();
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

function message(routeKey: string, text: string): ChannelMessage {
  return {
    id: `message-${routeKey}-${text}`,
    routeKey,
    channelId: "mock",
    sender: { id: "user" },
    conversation: { id: routeKey, kind: "direct" },
    text,
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

function fp(sessionId: string, updatedAtMs: number, rolloutSize: number): CodexSessionContextFingerprint {
  return {
    sessionId,
    detectedAt: "2026-05-18T00:00:00.000Z",
    source: "rollout",
    updatedAtMs,
    rolloutSize,
    rolloutMtimeMs: updatedAtMs,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}
