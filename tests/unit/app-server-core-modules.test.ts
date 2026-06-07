import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexEvent } from "../../src/codex/types.js";
import { AppServerRpcClient } from "../../src/codex/app-server/rpc-client.js";
import { AppServerSessionStore } from "../../src/codex/app-server/session-store.js";
import { AppServerTurnController } from "../../src/codex/app-server/turn-controller.js";
import { AsyncEventQueue } from "../../src/codex/app-server/turn-store.js";

test("app-server session store keeps local sessions and thread mappings", () => {
  const store = new AppServerSessionStore();
  store.set("session-1", {
    session: { id: "session-1", cwd: "/repo", title: "Title", createdAt: "now" },
    routeKey: "route-1",
    status: { type: "idle" },
    updatedAt: "later",
  });
  store.mapThread("thread-1", "session-1");

  assert.equal(store.resolveThreadSession("thread-1"), "session-1");
  assert.equal(store.resolveThreadSession("unknown"), "unknown");
  assert.deepEqual(store.getStatus("missing"), { type: "unknown", detail: "session not found" });
  assert.deepEqual(store.listSessions("route-1", undefined), [{
    id: "session-1",
    routeKey: "route-1",
    title: "Title",
    cwd: "/repo",
    status: { type: "idle" },
    updatedAt: "later",
  }]);
  store.clear();
  assert.equal(store.resolveThreadSession("thread-1"), "thread-1");
  assert.deepEqual(store.listSessions("route-1", undefined), []);
});

test("app-server turn controller maps notifications to queued events and status updates", async () => {
  const sessions = new Map();
  sessions.set("session-1", {
    session: { id: "session-1", cwd: "/repo", createdAt: "now" },
    status: { type: "idle" },
    updatedAt: "now",
  });
  const threadToSession = new Map([["thread-1", "session-1"]]);
  const controller = new AppServerTurnController({ sessions, threadToSession });
  const queue = new AsyncEventQueue<CodexEvent>();
  assert.equal(controller.hasActiveTurns(), false);
  controller.registerTurn("session-1", "turn-1", queue);
  assert.equal(controller.hasActiveTurns(), true);
  const iterator = queue[Symbol.asyncIterator]();

  controller.handleNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: { totalTokens: 12, inputTokens: 5, cachedInputTokens: 1, outputTokens: 7, reasoningOutputTokens: 2 },
        last: { totalTokens: 3, inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 1 },
      },
    },
  });
  assert.equal(sessions.get("session-1")?.status.context?.total.totalTokens, 12);

  controller.handleNotification({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", delta: "hello" },
  });
  assert.deepEqual(await iterator.next(), {
    value: { type: "assistant.delta", sessionId: "session-1", turnId: "turn-1", text: "hello" },
    done: false,
  });

  controller.handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-1", turnId: "turn-1", turn: { status: "completed" } },
  });
  assert.deepEqual(await iterator.next(), {
    value: { type: "assistant.completed", sessionId: "session-1", turnId: "turn-1", text: "hello" },
    done: false,
  });
  assert.deepEqual(await iterator.next(), {
    value: { type: "turn.completed", sessionId: "session-1", turnId: "turn-1" },
    done: false,
  });
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  assert.equal(sessions.get("session-1")?.status.type, "idle");
  assert.equal(controller.hasActiveTurns(), false);
});

test("app-server turn controller emits notifications even after the turn is closed", async () => {
  const sessions = new Map();
  sessions.set("session-1", {
    session: { id: "session-1", cwd: "/repo", createdAt: "now" },
    status: { type: "idle" },
    updatedAt: "now",
  });
  const controller = new AppServerTurnController({ sessions, threadToSession: new Map() });
  const queue = new AsyncEventQueue<CodexEvent>();
  const backgroundEvent = new Promise<CodexEvent>((resolve) => {
    controller.onBackgroundEvent((event) => {
      resolve(event);
    });
  });
  controller.registerTurn("session-1", "turn-1", queue);
  controller.closeTurn("turn-1", "idle");

  controller.pushTurnOrBackgroundEvent({
    type: "codex.notification",
    sessionId: "session-1",
    turnId: "turn-1",
    notification: {
      method: "thread/archived",
      kind: "lifecycle",
      text: "archived",
      dedupeKey: "thread/archived:session-1",
      dedupeWindowMs: 10 * 60_000,
      lifecycle: "archived",
      unbindRoute: true,
    },
  });

  assert.deepEqual(await backgroundEvent, {
    type: "codex.notification",
    sessionId: "session-1",
    turnId: "turn-1",
    notification: {
      method: "thread/archived",
      kind: "lifecycle",
      text: "archived",
      dedupeKey: "thread/archived:session-1",
      dedupeWindowMs: 10 * 60_000,
      lifecycle: "archived",
      unbindRoute: true,
    },
  });
});

test("app-server rpc client starts stdio server, dispatches responses, notifications, and stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-codex-rpc-"));
  const bin = join(dir, "fake-codex.mjs");
  await writeFile(bin, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: { ok: true } }));
  } else if (message.method === "model/list") {
    console.log(JSON.stringify({ id: message.id, result: { data: [{ id: "fake" }], nextCursor: null } }));
  } else if (message.method === "emit") {
    console.log(JSON.stringify({ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-1" } }));
    console.log(JSON.stringify({ id: message.id, result: { emitted: true } }));
  }
}
`);
  await chmod(bin, 0o755);
  const notifications: unknown[] = [];
  const client = new AppServerRpcClient({
    codexBin: bin,
    requestTimeoutMs: 1000,
    onServerRequest: () => undefined,
    onNotification: (notification) => notifications.push(notification),
    onFatalError: () => undefined,
  });
  try {
    await client.start();
    assert.deepEqual(await client.request("model/list"), { data: [{ id: "fake" }], nextCursor: null });
    assert.deepEqual(await client.request("emit"), { emitted: true });
    assert.deepEqual(notifications, [{ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-1" } }]);
    client.stop();
    await client.start();
    assert.deepEqual(await client.request("model/list"), { data: [{ id: "fake" }], nextCursor: null });
  } finally {
    client.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
