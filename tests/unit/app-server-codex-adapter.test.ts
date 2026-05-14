import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppServerCodexAdapter } from "../../src/codex/app-server-codex-adapter.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "app-server-codex-test-"));
}

function fakeCodexBin(root: string): string {
  const fakeBin = path.join(root, "fake-codex-app-server.js");
  fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let threadId = "thread-app-server-1";
let turnId = "turn-app-server-1";
let ignoreInterrupt = false;
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function thread(cwd) {
  return {
    id: threadId,
    sessionId: threadId,
    forkedFromId: null,
    preview: "fake thread",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1778716800,
    updatedAt: 1778716800,
    status: "idle",
    path: null,
    cwd,
    cliVersion: "fake",
    source: "appServer",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "Fake App Server Thread",
    turns: [],
  };
}
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "${root}", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    if (message.params.sessionStartSource !== "startup") {
      send({ id: message.id, error: { code: -32602, message: "invalid sessionStartSource" } });
      return;
    }
    send({ id: message.id, result: { thread: thread(message.params.cwd), cwd: message.params.cwd, model: "fake", modelProvider: "openai", serviceTier: null, instructionSources: [], approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite", writableRoots: [message.params.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: null } });
    return;
  }
  if (message.method === "thread/resume") {
    threadId = message.params.threadId;
    send({ id: message.id, result: { thread: thread(process.cwd()), cwd: process.cwd(), model: "fake", modelProvider: "openai", serviceTier: null, instructionSources: [], approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite", writableRoots: [process.cwd()], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: null } });
    return;
  }
  if (message.method === "turn/start") {
    turnId = "turn-app-server-" + Date.now();
    send({ id: message.id, result: { turn: { id: turnId, items: [], itemsView: "complete", status: "inProgress", error: null, startedAt: 1778716800, completedAt: null, durationMs: null } } });
    const prompt = message.params.input?.[0]?.text || "";
    if (prompt.includes("transient reconnect")) {
      send({ method: "error", params: { threadId, turnId, error: { message: "Reconnecting... 1/5" } } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "reconnected done", phase: null, memoryCitation: null } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
      return;
    }
    if (prompt.includes("summary parts")) {
      send({ method: "item/started", params: { threadId, turnId, startedAtMs: Date.now(), item: { type: "reasoning", id: "reasoning-parts", summary: [], content: [] } } });
      send({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId, itemId: "reasoning-parts", summaryIndex: 0, delta: "第一段分析" } });
      send({ method: "item/reasoning/summaryPartAdded", params: { threadId, turnId, itemId: "reasoning-parts", summaryIndex: 1 } });
      send({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId, itemId: "reasoning-parts", summaryIndex: 1, delta: "第二段分析。" } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "reasoning", id: "reasoning-parts", summary: ["第一段分析。", "第二段分析。"], content: [] } } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "summary parts done", phase: null, memoryCitation: null } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
      return;
    }
    if (prompt.includes("token usage")) {
      send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: { totalTokens: 12345, inputTokens: 10000, cachedInputTokens: 4000, outputTokens: 2345, reasoningOutputTokens: 345 }, last: { totalTokens: 789, inputTokens: 600, cachedInputTokens: 200, outputTokens: 189, reasoningOutputTokens: 89 }, modelContextWindow: 200000 } } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "token usage done", phase: null, memoryCitation: null } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
      return;
    }
    if (prompt.includes("commentary message")) {
      send({ method: "item/started", params: { threadId, turnId, startedAtMs: Date.now(), item: { type: "agentMessage", id: "commentary-1", text: "", phase: "commentary", memoryCitation: null } } });
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "commentary-1", delta: "我正在检查状态。" } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "commentary-1", text: "我正在检查状态。", phase: "commentary", memoryCitation: null } } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "commentary final", phase: "final_answer", memoryCitation: null } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
      return;
    }
    if (prompt.includes("progress")) {
      send({ method: "item/started", params: { threadId, turnId, startedAtMs: Date.now(), item: { type: "reasoning", id: "reasoning-1", summary: [], content: [] } } });
      send({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId, itemId: "reasoning-1", summaryIndex: 0, delta: "我先确认当前状态。" } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "reasoning", id: "reasoning-1", summary: ["我先确认当前状态。"], content: [] } } });
      send({ method: "item/started", params: { threadId, turnId, startedAtMs: Date.now(), item: { type: "plan", id: "plan-1", text: "" } } });
      send({ method: "item/plan/delta", params: { threadId, turnId, itemId: "plan-1", delta: "检查输入并给出简短结论。" } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "plan", id: "plan-1", text: "检查输入并给出简短结论。" } } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "progress done", phase: null, memoryCitation: null } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
      return;
    }
    if (prompt.includes("hang until stop")) {
      ignoreInterrupt = true;
      return;
    }
    send({ method: "item/commandExecution/requestApproval", id: "approval-1", params: { threadId, turnId, itemId: "cmd-1", startedAtMs: Date.now(), command: "touch approved.txt", cwd: message.params.cwd, reason: "fake approval" } });
    return;
  }
  if (message.id === "approval-1") {
    send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "decision " + message.result.decision, phase: null, memoryCitation: null } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
    return;
  }
  if (message.method === "turn/interrupt") {
    if (ignoreInterrupt) return;
    send({ id: message.id, result: {} });
  }
});
`, "utf-8");
  fs.chmodSync(fakeBin, 0o755);
  return fakeBin;
}

test("AppServerCodexAdapter routes command approvals through resolveApproval", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events = [];

  for await (const event of adapter.run(session.id, "run command that needs approval")) {
    events.push(event);
    if (event.type === "approval.requested") {
      assert.equal(event.approval.kind, "command");
      assert.equal(event.approval.command, "touch approved.txt");
      assert.equal(event.approval.adapterApprovalId, "approval-1");
      await adapter.resolveApproval(event.approval.adapterApprovalId, "approve");
    }
  }
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "turn.started"));
  assert.ok(events.some((event) => event.type === "approval.requested"));
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "decision accept"));
  assert.ok(events.some((event) => event.type === "turn.completed"));
});

test("AppServerCodexAdapter cancels pending approvals when interrupting a turn", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events = [];

  for await (const event of adapter.run(session.id, "run command that needs approval")) {
    events.push(event);
    if (event.type === "approval.requested") {
      await adapter.cancel(session.id);
    }
  }
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "approval.requested"));
  assert.ok(events.some((event) => event.type === "turn.completed"));
  assert.equal(events.some((event) => event.type === "turn.failed"), false);
});

test("AppServerCodexAdapter cancel does not wait for app-server interrupt response", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root), interruptTimeoutMs: 10_000 });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events = [];

  for await (const event of adapter.run(session.id, "hang until stop")) {
    events.push(event);
    if (event.type === "turn.started") {
      await adapter.cancel(session.id);
    }
  }
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "turn.started"));
  assert.ok(events.some((event) => event.type === "turn.completed"));
  assert.equal(events.some((event) => event.type === "turn.failed"), false);
});

test("AppServerCodexAdapter emits reasoning and plan progress from app-server notifications", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events = [];

  for await (const event of adapter.run(session.id, "progress please")) {
    events.push(event);
  }
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "assistant.progress" && event.kind === "reasoning" && event.text.includes("正在分析")));
  assert.ok(events.some((event) => event.type === "assistant.progress" && event.kind === "reasoning" && event.text.includes("我先确认当前状态")));
  assert.ok(events.some((event) => event.type === "assistant.progress" && event.kind === "todo" && event.text.includes("正在规划")));
  assert.ok(events.some((event) => event.type === "assistant.progress" && event.kind === "todo" && event.text.includes("检查输入并给出简短结论")));
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "progress done"));
});

test("AppServerCodexAdapter keeps running across transient reconnect notifications", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events = [];

  for await (const event of adapter.run(session.id, "transient reconnect please")) {
    events.push(event);
  }
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "assistant.progress" && event.kind === "other" && event.text.includes("Reconnecting... 1/5")));
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "reconnected done"));
  assert.ok(events.some((event) => event.type === "turn.completed"));
  assert.equal(events.some((event) => event.type === "turn.failed"), false);
});

test("AppServerCodexAdapter flushes reasoning summary sections", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events = [];

  for await (const event of adapter.run(session.id, "summary parts please")) {
    events.push(event);
  }
  await adapter.stop();

  const reasoningProgress = events
    .filter((event) => event.type === "assistant.progress" && event.kind === "reasoning")
    .map((event) => event.type === "assistant.progress" ? event.text : "");

  assert.ok(reasoningProgress.some((text) => text.includes("第一段分析")));
  assert.ok(reasoningProgress.some((text) => text.includes("第二段分析")));
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "summary parts done"));
});

test("AppServerCodexAdapter records thread token usage updates", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });

  for await (const _event of adapter.run(session.id, "token usage please")) {
    // Drain the turn.
  }
  const status = await adapter.getStatus(session.id);
  await adapter.stop();

  assert.equal(status.type, "idle");
  assert.equal(status.context?.total.totalTokens, 12345);
  assert.equal(status.context?.last.totalTokens, 789);
  assert.equal(status.context?.modelContextWindow, 200000);
});

test("AppServerCodexAdapter forwards commentary agent messages as progress", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events = [];

  for await (const event of adapter.run(session.id, "commentary message please")) {
    events.push(event);
  }
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "assistant.progress" && event.kind === "other" && event.text.includes("我正在检查状态")));
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "commentary final"));
  assert.equal(events.some((event) => event.type === "assistant.completed" && event.text.includes("我正在检查状态")), false);
});

test("AppServerCodexAdapter reports interactive approval support", () => {
  const adapter = new AppServerCodexAdapter();

  const status = adapter.getRunPolicyStatus();

  assert.equal(status.interactiveApprovals, true);
  assert.equal(status.effectiveApprovalPolicy, "on-request");
  assert.match(status.note ?? "", /微信/);
});
