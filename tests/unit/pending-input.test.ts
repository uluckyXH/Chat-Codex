import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { BridgeDelivery } from "../../src/bridge/delivery.js";
import { BridgePendingInputManager } from "../../src/bridge/pending-input.js";
import { MockCodexAdapter } from "../../src/codex/mock-codex-adapter.js";
import type { CodexUserInputRequest, CodexUserInputResponse } from "../../src/codex/types.js";
import { SilentLogger } from "../../src/logging/logger.js";
import type { ChannelRegistry } from "../../src/channels/registry.js";
import type { ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";

test("BridgePendingInputManager clears only requests from the failed turn", async () => {
  const codex = new InputCapableCodexAdapter();
  const manager = new BridgePendingInputManager({
    codex,
    delivery: delivery(),
  });

  await manager.start(startInput("route-a", "session-a", "turn-a", "input-a-1"));
  await manager.start(startInput("route-a", "session-a", "turn-a", "input-a-2"));
  await manager.start(startInput("route-b", "session-b", "turn-b", "input-b-1"));

  assert.equal(manager.clearTurn("route-a", "session-a", "other-turn"), 0);
  assert.equal(manager.has("route-a"), true);
  assert.equal(manager.clearTurn("route-a", "session-a", "turn-a"), 2);
  assert.equal(manager.has("route-a"), false);
  assert.equal(manager.has("route-b"), true);

  assert.equal(manager.clearTurn("route-b", "session-b", "turn-b"), 1);
  assert.equal(manager.has("route-b"), false);
  manager.clearAll();
});

test("nonblocking requests coexist, allow regular input, never auto-answer, and route explicit selectors", async () => {
  const codex = new InputCapableCodexAdapter();
  const texts: string[] = [];
  const manager = new BridgePendingInputManager({ codex, delivery: delivery(texts), timeoutMs: 1 });
  const first = startInput("r", "s", "t", "optional-1");
  first.request.isBlocking = false;
  const second = startInput("r", "s", "t", "optional-2");
  second.request.isBlocking = false;
  await manager.start(first);
  await manager.start(first);
  await manager.start(second);
  const firstSelector = questionSelector(texts[0]);
  const secondSelector = questionSelector(texts[1]);
  assert.equal(manager.has("r"), false);
  assert.equal(await manager.handleMessage({ ...first, rawText: "继续执行" }), false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(codex.answers.length, 0);
  await manager.handleMessage({ ...first, rawText: `/a1@Q${secondSelector}` });
  assert.equal(codex.answers[0]?.id, "optional-2");
  await manager.handleResolved("r", "optional-1");
  await manager.handleMessage({ ...first, rawText: `/a1@Q${firstSelector}` });
  assert.equal(codex.answers.length, 1);
  manager.clearAll();
});

test("answering an optional request keeps a blocking request and its queue intact", async () => {
  const codex = new InputCapableCodexAdapter();
  const texts: string[] = [];
  const manager = new BridgePendingInputManager({ codex, delivery: delivery(texts) });
  const blocking = startInput("r", "s", "t", "blocking");
  await manager.start(blocking);
  await manager.start(startInput("r", "s", "t", "queued"));
  const optional = startInput("r", "s", "t", "optional");
  optional.request.isBlocking = false;
  await manager.start(optional);
  await manager.handleMessage({ ...optional, rawText: `/a1@Q${questionSelector(texts.at(-1))}` });
  assert.equal(manager.has("r"), true);
  await manager.handleMessage({ ...blocking, rawText: "/a1" });
  assert.equal(manager.has("r"), true);
  assert.deepEqual(codex.answers.map((answer) => answer.id), ["optional", "blocking"]);
  assert.equal(manager.clearTurn("r", "s", "t"), 1);
  manager.clearAll();
});

class InputCapableCodexAdapter extends MockCodexAdapter {
  answers: Array<{ id: string; response: CodexUserInputResponse }> = [];
  async resolveUserInput(id: string, response: CodexUserInputResponse): Promise<void> { this.answers.push({ id, response }); }
}

test("resolved notification during submission advances a blocking queue exactly once", async () => {
  const codex = new InputCapableCodexAdapter();
  const manager = new BridgePendingInputManager({ codex, delivery: delivery() });
  const first = startInput("r", "s", "t", "one");
  await manager.start(first);
  await manager.start(startInput("r", "s", "t", "two"));
  await manager.start(startInput("r", "s", "t", "three"));
  codex.resolveUserInput = async (id) => { await manager.handleResolved("r", id); };
  await manager.handleMessage({ ...first, rawText: "/a1" });
  assert.equal(manager.clearTurn("r", "s", "t"), 2);
  manager.clearAll();
});

function delivery(texts?: string[]): BridgeDelivery {
  const approvals = new ApprovalManager();
  return new BridgeDelivery({
    channels: {
      sendText: async (_target: ChannelTarget, text: string) => {
        texts?.push(text);
        return { channelId: "mock", messageId: "mock-message", deliveredAt: new Date().toISOString() };
      },
    } as unknown as ChannelRegistry,
    approvals,
    logger: new SilentLogger(),
    approvalSendRetryDelayMs: 1,
  });
}

function questionSelector(text: string | undefined): string {
  const selector = text?.match(/@Q([a-z0-9_-]+)/i)?.[1];
  assert.ok(selector);
  return selector;
}

test("optional question selectors cannot be reused across bridge restarts or fall through to blocking input", async () => {
  const codex = new InputCapableCodexAdapter();
  const texts: string[] = [];
  const first = new BridgePendingInputManager({ codex, delivery: delivery(texts) });
  const request = startInput("r", "s", "t", "old");
  request.request.isBlocking = false;
  await first.start(request);
  const oldSelector = questionSelector(texts.at(-1));
  first.clearAll();
  const restarted = new BridgePendingInputManager({ codex, delivery: delivery(texts) });
  const next = startInput("r", "s", "next", "new");
  next.request.isBlocking = false;
  await restarted.start(next);
  assert.notEqual(questionSelector(texts.at(-1)), oldSelector);
  await restarted.start(startInput("r", "s", "next", "blocking"));
  await restarted.handleMessage({ ...request, rawText: `/a1@Q${oldSelector}` });
  await restarted.handleMessage({ ...request, rawText: "/a1@Q?invalid" });
  assert.equal(codex.answers.length, 0);
  assert.equal(restarted.has("r"), true);
  restarted.clearAll();
});

function startInput(routeKey: string, sessionId: string, turnId: string, adapterRequestId: string) {
  const target: ChannelTarget = {
    channelId: "mock",
    routeKey,
    conversation: { id: routeKey, kind: "direct" },
    recipient: { id: "user" },
  };
  const message: ChannelMessage = {
    id: `message-${adapterRequestId}`,
    routeKey,
    channelId: "mock",
    sender: { id: "user" },
    conversation: target.conversation,
    timestamp: new Date().toISOString(),
  };
  const request: CodexUserInputRequest = {
    adapterRequestId,
    sessionId,
    turnId,
    itemId: `item-${adapterRequestId}`,
    questions: [{
      id: "choice",
      question: "Continue?",
      isOther: false,
      isSecret: false,
      options: [{ label: "Yes" }],
    }],
  };
  return { routeKey, target, message, request };
}
