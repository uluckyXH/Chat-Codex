import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppServerCodexAdapter } from "../../src/codex/app-server-codex-adapter.js";
import type { CodexEvent, CodexTurnInput } from "../../src/codex/types.js";

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
let threadSequence = 1;
let ignoreInterrupt = false;
let goal = null;
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
  if (message.method === "model/list") {
    const models = [
      {
        id: "fake",
        model: "fake",
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: "Fake",
        description: "Fake default model",
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Low" },
          { reasoningEffort: "medium", description: "Medium" },
          { reasoningEffort: "high", description: "High" },
        ],
        defaultReasoningEffort: "medium",
        inputModalities: ["text"],
        supportsPersonality: false,
        additionalSpeedTiers: [],
        serviceTiers: [{ id: "default", name: "Default", description: "Default tier" }],
        isDefault: true,
      },
      {
        id: "fake-next",
        model: "fake-next",
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: "Fake Next",
        description: "Fake next model",
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Medium" },
          { reasoningEffort: "high", description: "High" },
          { reasoningEffort: "xhigh", description: "Extra high" },
        ],
        defaultReasoningEffort: "high",
        inputModalities: ["text"],
        supportsPersonality: false,
        additionalSpeedTiers: [],
        serviceTiers: [{ id: "default", name: "Default", description: "Default tier" }],
        isDefault: false,
      },
      {
        id: "fake-hidden",
        model: "fake-hidden",
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: "Fake Hidden",
        description: "Hidden fake model",
        hidden: true,
        supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
        defaultReasoningEffort: "high",
        inputModalities: ["text"],
        supportsPersonality: false,
        additionalSpeedTiers: [],
        serviceTiers: [],
        isDefault: false,
      },
    ];
    const includeHidden = message.params?.includeHidden === true;
    send({ id: message.id, result: { data: includeHidden ? models : models.filter((model) => !model.hidden), nextCursor: null } });
    return;
  }
  if (message.method === "thread/start") {
    if (message.params.sessionStartSource !== "startup") {
      send({ id: message.id, error: { code: -32602, message: "invalid sessionStartSource" } });
      return;
    }
    threadId = "thread-app-server-" + threadSequence++;
    send({ id: message.id, result: { thread: thread(message.params.cwd), cwd: message.params.cwd, model: "fake", modelProvider: "openai", serviceTier: null, instructionSources: [], approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite", writableRoots: [message.params.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: "medium" } });
    return;
  }
  if (message.method === "thread/resume") {
    threadId = message.params.threadId;
    send({ id: message.id, result: { thread: thread(process.cwd()), cwd: process.cwd(), model: "fake", modelProvider: "openai", serviceTier: null, instructionSources: [], approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite", writableRoots: [process.cwd()], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: "medium" } });
    return;
  }
  if (message.method === "thread/goal/get") {
    send({ id: message.id, result: { goal } });
    return;
  }
  if (message.method === "thread/goal/set") {
    if (!goal && !message.params.objective) {
      send({ id: message.id, error: { code: -32602, message: "no goal to update" } });
      return;
    }
    const now = Date.now() / 1000;
    goal = {
      threadId: message.params.threadId,
      objective: message.params.objective || goal.objective,
      status: message.params.status || goal.status,
      tokenBudget: message.params.tokenBudget ?? goal?.tokenBudget ?? null,
      tokensUsed: goal?.tokensUsed ?? 12,
      timeUsedSeconds: goal?.timeUsedSeconds ?? 34,
      createdAt: goal?.createdAt ?? now,
      updatedAt: now,
    };
    send({ id: message.id, result: { goal } });
    if (message.params.objective) {
      const goalTurnId = "goal-turn-" + Date.now();
      send({ method: "turn/started", params: { threadId: message.params.threadId, turnId: goalTurnId, turn: { id: goalTurnId } } });
      send({ method: "item/started", params: { threadId: message.params.threadId, turnId: goalTurnId, startedAtMs: Date.now(), item: { type: "reasoning", id: "goal-reasoning", summary: [], content: [] } } });
      send({ method: "item/reasoning/summaryTextDelta", params: { threadId: message.params.threadId, turnId: goalTurnId, itemId: "goal-reasoning", summaryIndex: 0, delta: "正在推进 Goal。" } });
      send({ method: "item/completed", params: { threadId: message.params.threadId, turnId: goalTurnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "goal-msg", text: "Goal 自动续跑完成", phase: "final_answer", memoryCitation: null } } });
      send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: goalTurnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
    }
    return;
  }
  if (message.method === "thread/goal/clear") {
    const cleared = Boolean(goal);
    goal = null;
    send({ id: message.id, result: { cleared } });
    return;
  }
  if (message.method === "thread/compact/start") {
    const compactTurnId = "compact-turn-" + Date.now();
    send({ id: message.id, result: {} });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turnId: compactTurnId, turn: { id: compactTurnId } } });
    send({ method: "item/started", params: { threadId: message.params.threadId, turnId: compactTurnId, item: { type: "contextCompaction", id: "compact-item-1" } } });
    send({ method: "item/completed", params: { threadId: message.params.threadId, turnId: compactTurnId, completedAtMs: Date.now(), item: { type: "contextCompaction", id: "compact-item-1" } } });
    send({ method: "thread/compacted", params: { threadId: message.params.threadId, turnId: compactTurnId } });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: compactTurnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
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
    if (prompt.includes("sandbox policy")) {
      const sandboxPolicy = message.params.sandboxPolicy || {};
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "sandbox network " + sandboxPolicy.networkAccess, phase: null, memoryCitation: null } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
      return;
    }
    if (prompt.includes("model params")) {
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "model " + message.params.model + " effort " + message.params.effort, phase: null, memoryCitation: null } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
      return;
    }
    if (prompt.includes("collaboration mode params")) {
      const collab = message.params.collaborationMode || {};
      const settings = collab.settings || {};
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "mode " + collab.mode + " model " + settings.model + " effort " + settings.reasoning_effort + " dev " + settings.developer_instructions, phase: null, memoryCitation: null } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
      return;
    }
    if (prompt.includes("plan item final")) {
      send({ method: "item/started", params: { threadId, turnId, startedAtMs: Date.now(), item: { type: "plan", id: "plan-final-1", text: "" } } });
      send({ method: "item/plan/delta", params: { threadId, turnId, itemId: "plan-final-1", delta: "# Plan\\n- first\\n" } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "plan", id: "plan-final-1", text: "# Plan\\n- first\\n" } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
      return;
    }
    if (prompt.includes("structured image start")) {
      const image = (message.params.input || []).find((item) => item.type === "localImage");
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "start image " + image.path, phase: null, memoryCitation: null } } });
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
    if (prompt.includes("commentary chunks")) {
      const first = "这是一段很长的 commentary 更新，用来模拟 Codex 工作进度被分片发送到微信时的第一段内容，长度足够触发提前刷新并进入进度流";
      const second = "，然后继续补上第二段。";
      send({ method: "item/started", params: { threadId, turnId, startedAtMs: Date.now(), item: { type: "agentMessage", id: "commentary-chunks-1", text: "", phase: "commentary", memoryCitation: null } } });
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "commentary-chunks-1", delta: first } });
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "commentary-chunks-1", delta: second } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "commentary-chunks-1", text: first + second, phase: "commentary", memoryCitation: null } } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "commentary chunks final", phase: "final_answer", memoryCitation: null } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
      return;
    }
    if (prompt.includes("command output spam")) {
      const output = Array.from({ length: 60 }, (_, index) => "line " + (index + 1)).join("\\n");
      send({ method: "item/started", params: { threadId, turnId, startedAtMs: Date.now(), item: { type: "commandExecution", id: "cmd-spam", command: "npm test", cwd: message.params.cwd, status: "inProgress" } } });
      for (const line of output.split("\\n")) {
        send({ method: "item/commandExecution/outputDelta", params: { threadId, turnId, itemId: "cmd-spam", delta: line + "\\n" } });
      }
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "commandExecution", id: "cmd-spam", command: "npm test", cwd: message.params.cwd, aggregatedOutput: output, exitCode: 0, durationMs: 2345, status: "completed" } } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "command output done", phase: null, memoryCitation: null } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
      return;
    }
    if (prompt.includes("command output failure")) {
      const output = Array.from({ length: 80 }, (_, index) => "fatal line " + (index + 1)).join("\\n");
      send({ method: "item/started", params: { threadId, turnId, startedAtMs: Date.now(), item: { type: "commandExecution", id: "cmd-fail", command: "npm test", cwd: message.params.cwd, status: "inProgress" } } });
      for (const line of output.split("\\n")) {
        send({ method: "item/commandExecution/outputDelta", params: { threadId, turnId, itemId: "cmd-fail", delta: "\\r" + line } });
      }
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "commandExecution", id: "cmd-fail", command: "npm test", cwd: message.params.cwd, aggregatedOutput: output, exitCode: 1, durationMs: 4567, status: "failed" } } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "command output failed", phase: null, memoryCitation: null } } });
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
    if (prompt.includes("hang until steer")) {
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
  if (message.method === "turn/steer") {
    if (message.params.expectedTurnId !== turnId) {
      send({ id: message.id, error: { code: -32602, message: "turn mismatch" } });
      return;
    }
    const text = message.params.input?.[0]?.text || "";
    const image = (message.params.input || []).find((item) => item.type === "localImage");
    send({ id: message.id, result: { turnId } });
    send({ method: "item/completed", params: { threadId: message.params.threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "steer-msg-1", text: image ? "steered image " + text + " " + image.path : "steered " + text, phase: null, memoryCitation: null } } });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
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
  const events: CodexEvent[] = [];

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
  const events: CodexEvent[] = [];

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

test("AppServerCodexAdapter sends turn steer to the active app-server turn", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events: CodexEvent[] = [];

  for await (const event of adapter.run(session.id, "hang until steer")) {
    events.push(event);
    if (event.type === "turn.started") {
      await adapter.steer(session.id, "补充输入");
    }
  }
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "turn.started"));
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "steered 补充输入"));
  assert.ok(events.some((event) => event.type === "turn.completed"));
});

test("AppServerCodexAdapter sends localImage on turn start", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const imagePath = path.join(root, "screenshot.png");
  const input: CodexTurnInput = {
    text: "structured image start",
    items: [
      { type: "text", text: "structured image start" },
      { type: "localImage", path: imagePath },
    ],
  };
  const events: CodexEvent[] = [];

  for await (const event of adapter.run(session.id, input)) {
    events.push(event);
  }
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === `start image ${imagePath}`));
  assert.ok(events.some((event) => event.type === "turn.completed"));
});

test("AppServerCodexAdapter sends localImage on turn steer", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const imagePath = path.join(root, "steer.png");
  const input: CodexTurnInput = {
    text: "补充截图",
    items: [
      { type: "text", text: "补充截图" },
      { type: "localImage", path: imagePath },
    ],
  };
  const events: CodexEvent[] = [];

  for await (const event of adapter.run(session.id, "hang until steer")) {
    events.push(event);
    if (event.type === "turn.started") {
      await adapter.steer(session.id, input);
    }
  }
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === `steered image 补充截图 ${imagePath}`));
  assert.ok(events.some((event) => event.type === "turn.completed"));
});

test("AppServerCodexAdapter rejects steer without an active turn", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });

  await assert.rejects(() => adapter.steer(session.id, "补充输入"), /no active turn to steer/);
  await adapter.stop();
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
  assert.equal(status.model?.model, "fake");
  assert.equal(status.model?.provider, "openai");
  assert.equal(status.model?.reasoningEffort, "medium");
});

test("AppServerCodexAdapter keeps network available in approval workspace sandbox", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events = [];

  for await (const event of adapter.run(session.id, "sandbox policy please")) {
    events.push(event);
  }
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "sandbox network true"));
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

test("AppServerCodexAdapter does not duplicate chunked commentary on completion", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events = [];

  for await (const event of adapter.run(session.id, "commentary chunks please")) {
    events.push(event);
  }
  await adapter.stop();

  const progressTexts = events
    .filter((event) => event.type === "assistant.progress" && event.kind === "other")
    .map((event) => event.type === "assistant.progress" ? event.text : "");
  assert.equal(progressTexts.length, 1);
  assert.ok(progressTexts[0].includes("第一段内容"));
  assert.ok(progressTexts[0].includes("第二段"));
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "commentary chunks final"));
  assert.equal(events.some((event) => event.type === "assistant.completed" && event.text.includes("第一段内容")), false);
});

test("AppServerCodexAdapter aggregates command output deltas into one bounded summary", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events: CodexEvent[] = [];

  for await (const event of adapter.run(session.id, "command output spam please")) {
    events.push(event);
  }
  await adapter.stop();

  const commandProgress = events
    .filter((event) => event.type === "assistant.progress" && event.kind === "command")
    .map((event) => event.type === "assistant.progress" ? event.text : "");
  assert.equal(commandProgress.length, 2);
  assert.equal(commandProgress[0], "正在执行命令: npm test");
  assert.match(commandProgress[1], /命令完成: npm test/);
  assert.match(commandProgress[1], /输出摘要/);
  assert.match(commandProgress[1], /line 60/);
  assert.match(commandProgress[1], /已省略/);
  assert.ok(commandProgress[1].length < 1200);
  assert.equal(events.some((event) => event.type === "assistant.progress" && event.text === "line 1\n"), false);
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "command output done"));
});

test("AppServerCodexAdapter keeps failure command tail in bounded summary", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events: CodexEvent[] = [];

  for await (const event of adapter.run(session.id, "command output failure please")) {
    events.push(event);
  }
  await adapter.stop();

  const summary = events
    .filter((event) => event.type === "assistant.progress" && event.kind === "command")
    .map((event) => event.type === "assistant.progress" ? event.text : "")
    .find((text) => text.includes("命令失败"));
  assert.ok(summary);
  assert.match(summary, /exit=1/);
  assert.match(summary, /错误摘要/);
  assert.match(summary, /fatal line 80/);
  assert.match(summary, /已省略/);
  assert.ok(summary.length < 2000);
});

test("AppServerCodexAdapter reports interactive approval support", () => {
  const adapter = new AppServerCodexAdapter();

  const status = adapter.getRunPolicyStatus();

  assert.equal(status.interactiveApprovals, true);
  assert.equal(status.effectiveApprovalPolicy, "on-request");
  assert.match(status.note ?? "", /微信/);
});

test("AppServerCodexAdapter scopes run policy per session", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const first = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "first",
  });
  const second = await adapter.resumeSession("thread-app-server-2");

  adapter.setRunPolicy({ permissionMode: "full" }, first.id);
  await adapter.stop();

  assert.equal(adapter.getRunPolicy(first.id).permissionMode, "full");
  assert.equal(adapter.getRunPolicyStatus(first.id).effectiveApprovalPolicy, "never");
  assert.equal(adapter.getRunPolicy(second.id).permissionMode, "approval");
  assert.equal(adapter.getRunPolicyStatus(second.id).effectiveApprovalPolicy, "on-request");
  assert.equal(adapter.getRunPolicy().permissionMode, "approval");
});

test("AppServerCodexAdapter lists models from app-server", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });

  const visible = await adapter.listModels();
  const all = await adapter.listModels({ includeHidden: true });
  await adapter.stop();

  assert.deepEqual(visible.map((model) => model.model), ["fake", "fake-next"]);
  assert.equal(visible[0].defaultReasoningEffort, "medium");
  assert.deepEqual(visible[1].supportedReasoningEfforts.map((option) => option.reasoningEffort), ["medium", "high", "xhigh"]);
  assert.ok(all.some((model) => model.model === "fake-hidden"));
});

test("AppServerCodexAdapter sends model policy on turn start", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  adapter.setModelPolicy({ model: "fake-next", reasoningEffort: "xhigh" }, session.id);
  const events = [];

  for await (const event of adapter.run(session.id, "model params please")) {
    events.push(event);
  }
  const status = await adapter.getStatus(session.id);
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "model fake-next effort xhigh"));
  assert.equal(status.model?.model, "fake-next");
  assert.equal(status.model?.reasoningEffort, "xhigh");
  assert.deepEqual(adapter.getModelPolicy(session.id), { model: "fake-next", reasoningEffort: "xhigh" });
});

test("AppServerCodexAdapter sends collaboration mode on turn start", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  adapter.setCollaborationMode("plan", session.id);
  const events = [];

  for await (const event of adapter.run(session.id, "collaboration mode params please")) {
    events.push(event);
  }
  await adapter.stop();

  assert.equal(adapter.getCollaborationMode(session.id), "plan");
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "mode plan model fake effort medium dev null"));
});

test("AppServerCodexAdapter emits completed plan items as final plan events in plan mode", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events = [];

  for await (const event of adapter.run(session.id, "plan item final please", { collaborationMode: "plan" })) {
    events.push(event);
  }
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "assistant.progress" && event.kind === "todo" && event.text.includes("# Plan")));
  assert.ok(events.some((event) => event.type === "assistant.plan" && event.text === "# Plan\n- first\n"));
});

test("AppServerCodexAdapter manages experimental thread goals", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });

  assert.equal(await adapter.getGoal(session.id), null);
  const active = await adapter.setGoal(session.id, "完成微信 Goal 适配并保持测试通过");
  const paused = await adapter.setGoalStatus(session.id, "paused");
  const resumed = await adapter.setGoalStatus(session.id, "active");
  const current = await adapter.getGoal(session.id);
  const cleared = await adapter.clearGoal(session.id);
  const empty = await adapter.getGoal(session.id);
  await adapter.stop();

  assert.equal(active.objective, "完成微信 Goal 适配并保持测试通过");
  assert.equal(active.status, "active");
  assert.equal(paused.status, "paused");
  assert.equal(resumed.status, "active");
  assert.equal(current?.objective, "完成微信 Goal 适配并保持测试通过");
  assert.equal(cleared, true);
  assert.equal(empty, null);
});

test("AppServerCodexAdapter starts and waits for thread compaction", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const events: CodexEvent[] = [];
  const unsubscribe = adapter.onBackgroundEvent((event) => {
    events.push(event);
  });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });

  const result = await adapter.compactSession(session.id);
  await waitForUnit(() => events.some((event) => event.type === "turn.completed"));
  const status = await adapter.getStatus(session.id);
  unsubscribe();
  await adapter.stop();

  assert.deepEqual(result, { sessionId: session.id });
  assert.equal(status.type, "idle");
  assert.ok(events.some((event) => event.type === "turn.started"));
  assert.ok(events.some((event) => event.type === "assistant.progress" && event.text.includes("正在压缩上下文")));
  assert.ok(events.some((event) => event.type === "assistant.progress" && event.text.includes("上下文压缩完成")));
  assert.ok(events.some((event) => event.type === "turn.completed"));
});

test("AppServerCodexAdapter emits goal auto-continuation as background events", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const events: CodexEvent[] = [];
  const unsubscribe = adapter.onBackgroundEvent((event) => {
    events.push(event);
  });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });

  await adapter.setGoal(session.id, "自动推进 Goal");
  await waitForUnit(() => events.some((event) => event.type === "turn.completed"));
  unsubscribe();
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "turn.started"));
  assert.ok(events.some((event) => event.type === "assistant.progress" && event.text.includes("正在分析")));
  assert.ok(events.some((event) => event.type === "assistant.progress" && event.text.includes("正在推进 Goal")));
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "Goal 自动续跑完成"));
  assert.ok(events.some((event) => event.type === "turn.completed"));
});

async function waitForUnit(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition not met before timeout");
}
