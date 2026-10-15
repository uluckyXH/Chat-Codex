import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexEvent } from "../../src/codex/types.js";
import { AppServerRpcClient } from "../../src/codex/app-server/rpc-client.js";
import { AppServerSessionStore } from "../../src/codex/app-server/session-store.js";
import { AppServerTurnController } from "../../src/codex/app-server/turn-controller.js";
import { AsyncEventQueue } from "../../src/codex/app-server/turn-store.js";
import { chatCodexVersion } from "../../src/runtime/package-info.js";

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

test("app-server turn controller maps web search tool progress as completed", async () => {
  const sessions = new Map();
  sessions.set("session-1", {
    session: { id: "session-1", cwd: "/repo", createdAt: "now" },
    status: { type: "idle" },
    updatedAt: "now",
  });
  const controller = new AppServerTurnController({ sessions, threadToSession: new Map([["thread-1", "session-1"]]) });
  const queue = new AsyncEventQueue<CodexEvent>();
  controller.registerTurn("session-1", "turn-1", queue);
  const iterator = queue[Symbol.asyncIterator]();

  controller.handleNotification({
    method: "item/started",
    params: { threadId: "thread-1", turnId: "turn-1", item: { type: "webSearch", id: "search-1" } },
  });
  assert.deepEqual(await iterator.next(), {
    value: {
      type: "tool.progress",
      sessionId: "session-1",
      turnId: "turn-1",
      progress: { phase: "start", itemId: "search-1", toolName: "web_search" },
    },
    done: false,
  });

  controller.handleNotification({
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item: { type: "webSearch", id: "search-1" } },
  });
  assert.deepEqual(await iterator.next(), {
    value: {
      type: "tool.progress",
      sessionId: "session-1",
      turnId: "turn-1",
      progress: { phase: "end", itemId: "search-1", toolName: "web_search", status: "completed" },
    },
    done: false,
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
    if (message.params.clientInfo.version !== ${JSON.stringify(chatCodexVersion())}) throw new Error("wrong client version");
    console.log(JSON.stringify({ id: message.id, result: { userAgent: "fake-codex/0.162.1" } }));
  } else if (message.method === "model/list") {
    console.log(JSON.stringify({ id: message.id, result: { data: [{ id: "fake" }], nextCursor: null } }));
  } else if (message.method === "large") {
    console.log(JSON.stringify({ id: message.id, result: { payload: "x".repeat(25_000_000) } }));
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
    requestTimeoutMs: 5000,
    onServerRequest: () => undefined,
    onNotification: (notification) => notifications.push(notification),
    onFatalError: () => undefined,
  });
  try {
    assert.equal(client.getProtocolStatus().verification, "not_connected");
    await client.start();
    assert.equal(client.getProtocolStatus().verification, "handshake_only");
    assert.equal(client.getProtocolStatus().serverUserAgent, "fake-codex/0.162.1");
    assert.deepEqual(await client.request("model/list"), { data: [{ id: "fake" }], nextCursor: null });
    const large = await client.request<{ payload: string }>("large");
    assert.equal(large.payload.length, 25_000_000);
    assert.deepEqual(await client.request("emit"), { emitted: true });
    assert.deepEqual(notifications, [{ method: "turn/started", params: { threadId: "thread-1", turnId: "turn-1" } }]);
    client.stop();
    assert.equal(client.getProtocolStatus().initialized, false);
    await client.start();
    assert.deepEqual(await client.request("model/list"), { data: [{ id: "fake" }], nextCursor: null });
  } finally {
    client.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("app-server rpc client discards malformed JSON transport and starts a fresh process without replaying requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chat-codex-rpc-malformed-"));
  const bin = join(dir, "fake-codex.mjs");
  const starts = join(dir, "starts.log");
  const requests = join(dir, "requests.log");
  await writeFile(bin, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(${JSON.stringify(starts)}, process.pid + "\\n");
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const message = JSON.parse(line);
  appendFileSync(${JSON.stringify(requests)}, message.method + "\\n");
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: { ok: true } }));
  } else if (message.method === "break") {
    process.stdout.write('{"id":' + JSON.stringify(message.id) + ',"result":{"payload":"unterminated\\n');
  } else if (message.method === "ok") {
    console.log(JSON.stringify({ id: message.id, result: { ok: true } }));
  }
}
`);
  await chmod(bin, 0o755);
  const fatalDiagnostics: Array<{ error: Error; stdoutLineLength?: number }> = [];
  const client = new AppServerRpcClient({
    codexBin: bin,
    requestTimeoutMs: 5000,
    onServerRequest: () => undefined,
    onNotification: () => undefined,
    onFatalError: (error, diagnostic) => {
      fatalDiagnostics.push({ error, stdoutLineLength: diagnostic.stdoutLineLength });
    },
  });
  try {
    await client.start();
    await assert.rejects(client.request("break"), /Unterminated string/);
    await waitFor(() => fatalDiagnostics.length === 1);
    assert.equal(fatalDiagnostics.length, 1);
    assert.ok((fatalDiagnostics[0]?.stdoutLineLength ?? 0) > 0);
    assert.match(client.getLastTransportDiagnostic()?.error ?? "", /Unterminated string/);

    await client.start();
    assert.deepEqual(await client.request("ok"), { ok: true });

    assert.equal((await readFile(starts, "utf8")).trim().split(/\r?\n/).length, 2);
    const requestLines = (await readFile(requests, "utf8")).trim().split(/\r?\n/);
    assert.equal(requestLines.filter((method) => method === "break").length, 1);
    assert.equal(requestLines.filter((method) => method === "ok").length, 1);
  } finally {
    client.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition not met before timeout");
}
