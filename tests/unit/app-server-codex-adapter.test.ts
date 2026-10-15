import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const fs = require("node:fs");
const readline = require("node:readline");
fs.appendFileSync(${JSON.stringify(path.join(root, "fake-app-server-starts.log"))}, process.pid + "\\n");
const requestLog = ${JSON.stringify(path.join(root, "fake-app-server-requests.log"))};
const requestDetailLog = ${JSON.stringify(path.join(root, "fake-app-server-request-details.log"))};
const paginationUnavailable = fs.existsSync(${JSON.stringify(path.join(root, "pagination-unavailable"))});
const rl = readline.createInterface({ input: process.stdin });
let threadId = "thread-app-server-1";
let loadedThreadId = null;
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
  fs.appendFileSync(requestDetailLog, JSON.stringify({ id: message.id ?? null, method: message.method ?? null, params: message.params ?? null }) + "\\n");
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
          { reasoningEffort: "max", description: "Max" },
        ],
        defaultReasoningEffort: "high",
        inputModalities: ["text", "image"],
        supportsPersonality: true,
        additionalSpeedTiers: [],
        serviceTiers: [{ id: "default", name: "Default", description: "Default tier" }],
        defaultServiceTier: "default",
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
    loadedThreadId = threadId;
    send({ id: message.id, result: { thread: thread(message.params.cwd), cwd: message.params.cwd, model: "fake", modelProvider: "openai", serviceTier: null, instructionSources: [], approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite", writableRoots: [message.params.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: "medium" } });
    return;
  }
  if (message.method === "thread/resume") {
    if (message.params.excludeTurns !== true) {
      send({ id: message.id, error: { code: -32602, message: "excludeTurns must be true" } });
      return;
    }
    threadId = message.params.threadId;
    loadedThreadId = threadId;
    send({ id: message.id, result: { thread: thread(process.cwd()), cwd: process.cwd(), model: "fake", modelProvider: "openai", serviceTier: null, instructionSources: [], approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite", writableRoots: [process.cwd()], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, reasoningEffort: "medium" } });
    return;
  }
  if (message.method === "thread/name/set") {
    if (!message.params?.threadId || typeof message.params?.name !== "string") {
      send({ id: message.id, error: { code: -32602, message: "invalid thread name params" } });
      return;
    }
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "thread/list") {
    send({
      id: message.id,
      result: {
        data: [
          {
            ...thread("/repo/from-thread-list"),
            id: "thread-from-list-1",
            sessionId: "thread-from-list-1",
            name: "Thread List Session",
            preview: "thread list preview",
            recencyAt: 1778803200,
            updatedAt: 1778716800,
            status: { type: "idle" },
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      },
    });
    return;
  }
  if (message.method === "thread/read") {
    if (message.params.includeTurns !== false) {
      send({ id: message.id, error: { code: -32602, message: "includeTurns must be false" } });
      return;
    }
    const detail = {
      ...thread("/repo/read-detail"),
      id: message.params.threadId,
      sessionId: message.params.threadId,
      name: "Thread Read Detail",
      preview: "thread read preview",
      recencyAt: 1778803200,
      updatedAt: 1778716800,
      modelProvider: "proxy",
      cliVersion: "fake-cli-1",
      source: "appServer",
      threadSource: "chatCodex",
      path: "/tmp/thread-read.jsonl",
      gitInfo: { sha: "abcdef1234567890", branch: "main", originUrl: "https://example.invalid/repo.git" },
      forkedFromId: "fork-source-1",
      parentThreadId: null,
      ephemeral: false,
    };
    send({ id: message.id, result: { thread: detail } });
    return;
  }
  if (message.method === "thread/turns/list") {
    if (paginationUnavailable) {
      send({ id: message.id, error: { code: -32601, message: "method not found" } });
      return;
    }
    if (message.params.sortDirection !== "desc" || message.params.itemsView !== "notLoaded") {
      send({ id: message.id, error: { code: -32602, message: "invalid thread page params" } });
      return;
    }
    send({ id: message.id, result: { data: [{ id: "history-turn-1" }], nextCursor: null, backwardsCursor: null } });
    return;
  }
  if (message.method === "thread/items/list") {
    if (paginationUnavailable) {
      send({ id: message.id, error: { code: -32601, message: "method not found" } });
      return;
    }
    if (message.params.turnId !== "history-turn-1" || message.params.sortDirection !== "desc") {
      send({ id: message.id, error: { code: -32602, message: "invalid item page params" } });
      return;
    }
    send({
      id: message.id,
      result: {
        data: [
          { turnId: "history-turn-1", item: { type: "agentMessage", id: "history-final", text: "终端最新最终回复", phase: "final_answer", memoryCitation: null } },
          { turnId: "history-turn-1", item: { type: "agentMessage", id: "history-commentary", text: "终端旁白，不应投递", phase: "commentary", memoryCitation: null } },
        ],
        nextCursor: null,
        backwardsCursor: null,
      },
    });
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
    fs.appendFileSync(requestLog, "turn/start\\n");
    if (message.params.threadId !== loadedThreadId) {
      send({ id: message.id, error: { code: -32602, message: "thread must be resumed before turn/start" } });
      return;
    }
    const prompt = message.params.input?.[0]?.text || "";
    if (prompt.includes("invalid cwd")) {
      send({ id: message.id, error: { code: -32602, message: "invalid cwd: Operation not permitted (os error 1)" } });
      return;
    }
    turnId = "turn-app-server-" + Date.now();
    send({ id: message.id, result: { turn: { id: turnId, items: [], itemsView: "complete", status: "inProgress", error: null, startedAt: 1778716800, completedAt: null, durationMs: null } } });
    if (prompt.includes("malformed json")) {
      process.stdout.write('{"method":"item/completed","params":{"payload":"unterminated\\n');
      return;
    }
    if (prompt.includes("transient reconnect final")) {
      send({ method: "error", params: { threadId, turnId, error: { message: "Reconnecting... 5/5" } } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "reconnect final done", phase: null, memoryCitation: null } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
      return;
    }
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
      send({ method: "thread/settings/updated", params: { threadId, threadSettings: { cwd: message.params.cwd, model: settings.model, modelProvider: "openai", serviceTier: null, effort: settings.reasoning_effort, collaborationMode: collab } } });
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
    if (prompt.includes("commentary only")) {
      send({ method: "item/started", params: { threadId, turnId, startedAtMs: Date.now(), item: { type: "agentMessage", id: "commentary-only-1", text: "", phase: "commentary", memoryCitation: null } } });
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "commentary-only-1", delta: "只有旁白，没有最终回复。" } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "commentary-only-1", text: "只有旁白，没有最终回复。", phase: "commentary", memoryCitation: null } } });
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
      const first = "我先检查第一段内容。版本 0.162.1。";
      const second = "然后继续补上第二段。";
      send({ method: "item/started", params: { threadId, turnId, startedAtMs: Date.now(), item: { type: "agentMessage", id: "commentary-chunks-1", text: "", phase: "commentary", memoryCitation: null } } });
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "commentary-chunks-1", delta: first } });
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "commentary-chunks-1", delta: second } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "commentary-chunks-1", text: first + second + "完成时补齐的结论。", phase: "commentary", memoryCitation: null } } });
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
    if (prompt.includes("request user input supported")) {
      send({ method: "item/tool/requestUserInput", id: "input-1", params: { threadId, turnId, itemId: "input-item-1", questions: [{ id: "confirm_path", header: "确认路径", question: "是否继续？", isOther: true, isSecret: false, options: [{ label: "Yes (Recommended)", description: "继续当前方案。" }, { label: "No", description: "停止并重新考虑。" }] }] } });
      return;
    }
    if (prompt.includes("mcp elicitation unsupported")) {
      send({ method: "mcpServer/elicitation/request", id: "mcp-1", params: { threadId, turnId, serverName: "private-app", mode: "url", message: "需要授权", url: "https://example.test/auth", elicitationId: "elicitation-1", _meta: null } });
      return;
    }
    if (prompt.includes("dynamic tool unsupported")) {
      send({ method: "item/tool/call", id: "tool-1", params: { threadId, turnId, callId: "call-1", namespace: "bridge", tool: "dangerous", arguments: {} } });
      return;
    }
    if (prompt.includes("write stdin approval")) {
      send({ method: "item/commandExecution/requestApproval", id: "stdin-approval-1", params: { kind: "writeStdin", threadId, turnId, itemId: "original-command-item-1", approvalId: "opaque-stdin-callback-id", startedAtMs: Date.now(), command: "write_stdin --session-id 42 'confirm\\n'", environmentId: "remote", cwd: message.params.cwd, reason: "program waits for confirmation", availableDecisions: ["accept", "cancel"] } });
      return;
    }
    if (prompt.includes("write stdin without command")) {
      send({ method: "item/commandExecution/requestApproval", id: "stdin-no-command-1", params: { kind: "writeStdin", threadId, turnId, itemId: "original-command-item-1", approvalId: "opaque-stdin-callback-id", startedAtMs: Date.now(), cwd: message.params.cwd, reason: "missing displayable input", availableDecisions: ["accept", "cancel"] } });
      return;
    }
    if (prompt.includes("approval resolved externally")) {
      send({ method: "item/commandExecution/requestApproval", id: "approval-external", params: { threadId, turnId, itemId: "cmd-external", startedAtMs: Date.now(), command: "touch externally-approved.txt", cwd: message.params.cwd, reason: "external approval" } });
      send({ method: "serverRequest/resolved", params: { threadId, requestId: "approval-external" } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "external resolved done", phase: null, memoryCitation: null } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
      return;
    }
    if (prompt.includes("status notifications")) {
      send({ method: "thread/name/updated", params: { threadId, threadName: "Renamed Thread" } });
      send({ method: "warning", params: { threadId, message: "配置即将变化" } });
      send({ method: "model/rerouted", params: { threadId, turnId, fromModel: "fake", toModel: "fake-next", reason: "highRiskCyberActivity" } });
      send({ method: "model/verification", params: { threadId, turnId, verifications: ["trustedAccessForCyber"] } });
      send({ method: "model/safetyBuffering/updated", params: { threadId, turnId, model: "fake-next", useCases: ["security"], reasons: ["classifier"], showBufferingUi: true, fasterModel: "fake" } });
      send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "status notifications done", phase: null, memoryCitation: null } } });
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
  if (message.id === "stdin-approval-1" || message.id === "stdin-no-command-1") {
    send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "stdin decision " + message.result.decision, phase: null, memoryCitation: null } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
    return;
  }
  if (message.id === "input-1") {
    const answers = message.result?.answers?.confirm_path?.answers || [];
    send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "input answer " + answers.join("|"), phase: null, memoryCitation: null } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
    return;
  }
  if (message.id === "mcp-1") {
    send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "mcp action " + message.result.action, phase: null, memoryCitation: null } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "complete", status: "completed", error: null, startedAt: 1778716800, completedAt: 1778716801, durationMs: 1000 } } });
    return;
  }
  if (message.id === "tool-1") {
    send({ method: "item/completed", params: { threadId, turnId, completedAtMs: Date.now(), item: { type: "agentMessage", id: "msg-1", text: "tool success " + message.result.success, phase: null, memoryCitation: null } } });
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

function fakeAppServerStartCount(root: string): number {
  const filePath = path.join(root, "fake-app-server-starts.log");
  if (!fs.existsSync(filePath)) return 0;
  return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean).length;
}

function fakeRequestCount(root: string, method: string): number {
  const filePath = path.join(root, "fake-app-server-requests.log");
  if (!fs.existsSync(filePath)) return 0;
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter((line) => line === method).length;
}

function fakeRequestDetails(root: string): Array<{ id: string | number | null; method: string | null; params: Record<string, unknown> | null }> {
  const filePath = path.join(root, "fake-app-server-request-details.log");
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id: string | number | null; method: string | null; params: Record<string, unknown> | null });
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
      assert.equal(event.approval.adapterApprovalId, "rpc-1:approval-1");
      await adapter.resolveApproval(event.approval.adapterApprovalId, "approve");
    }
  }
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "turn.started"));
  assert.ok(events.some((event) => event.type === "approval.requested"));
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "decision accept"));
  assert.ok(events.some((event) => event.type === "turn.completed"));
});

test("AppServerCodexAdapter maps writeStdin /NO semantics to cancel without treating it as a new command", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events: CodexEvent[] = [];

  for await (const event of adapter.run(session.id, "write stdin approval")) {
    events.push(event);
    if (event.type === "approval.requested") {
      assert.equal(event.approval.kind, "terminal_input");
      assert.equal(event.approval.adapterApprovalId, "rpc-1:stdin-approval-1");
      assert.equal(event.approval.itemId, "original-command-item-1");
      assert.equal(event.approval.command, "write_stdin --session-id 42 'confirm\n'");
      assert.equal(event.approval.environmentId, "remote");
      assert.equal(event.approval.terminalId, "42");
      assert.equal(event.approval.terminalInput, "confirm\n");
      assert.deepEqual(event.approval.availableDecisions, ["approve", "cancel"]);
      await adapter.resolveApproval(event.approval.adapterApprovalId, "deny");
    }
  }
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "approval.requested" && event.approval.kind === "terminal_input"));
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "stdin decision cancel"));
  assert.ok(events.some((event) => event.type === "turn.completed"));
});

test("AppServerCodexAdapter cancels writeStdin when the input cannot be safely displayed", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events: CodexEvent[] = [];

  for await (const event of adapter.run(session.id, "write stdin without command")) {
    events.push(event);
  }
  await adapter.stop();

  assert.equal(events.some((event) => event.type === "approval.requested"), false);
  assert.ok(events.some((event) => event.type === "assistant.progress" && /未提供可安全展示的输入/.test(event.text)));
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "stdin decision cancel"));
});

test("AppServerCodexAdapter resolves request_user_input through bridge answers", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events: CodexEvent[] = [];

  for await (const event of adapter.run(session.id, "request user input supported")) {
    events.push(event);
    if (event.type === "input.requested") {
      assert.equal(event.request.adapterRequestId, "rpc-1:input-1");
      assert.equal(event.request.questions[0]?.id, "confirm_path");
      assert.equal(event.request.questions[0]?.options[1]?.label, "No");
      await adapter.resolveUserInput(event.request.adapterRequestId, {
        answers: {
          confirm_path: { answers: ["No", "user_note: 先别继续"] },
        },
      });
    }
  }
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "input.requested"));
  assert.ok(events.some((event) => event.type === "input.resolved" && event.adapterRequestId === "rpc-1:input-1"));
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "input answer No|user_note: 先别继续"));
  await assert.rejects(() => adapter.resolveUserInput("input-1", { answers: {} }), /未找到/);
});

test("AppServerCodexAdapter cancels MCP elicitation and dynamic tool calls without enabling tools", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const mcpEvents: CodexEvent[] = [];
  const toolEvents: CodexEvent[] = [];

  for await (const event of adapter.run(session.id, "mcp elicitation unsupported")) {
    mcpEvents.push(event);
  }
  for await (const event of adapter.run(session.id, "dynamic tool unsupported")) {
    toolEvents.push(event);
  }
  await adapter.stop();

  assert.ok(mcpEvents.some((event) => event.type === "assistant.progress" && event.text.includes("MCP elicitation")));
  assert.ok(mcpEvents.some((event) => event.type === "assistant.completed" && event.text === "mcp action cancel"));
  assert.ok(toolEvents.some((event) => event.type === "assistant.progress" && event.text.includes("动态工具")));
  assert.ok(toolEvents.some((event) => event.type === "assistant.completed" && event.text === "tool success false"));
});

test("AppServerCodexAdapter clears pending approvals when app-server resolves request elsewhere", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events: CodexEvent[] = [];

  for await (const event of adapter.run(session.id, "approval resolved externally")) {
    events.push(event);
  }
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "approval.requested" && event.approval.adapterApprovalId === "rpc-1:approval-external"));
  assert.ok(events.some((event) => event.type === "approval.resolved" && event.adapterApprovalId === "rpc-1:approval-external"));
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "external resolved done"));
  await assert.rejects(() => adapter.resolveApproval("approval-external", "approve"), /未找到/);
});

test("AppServerCodexAdapter maps status notifications into session state and notification events", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events: CodexEvent[] = [];

  for await (const event of adapter.run(session.id, "status notifications")) {
    events.push(event);
  }
  const sessions = await adapter.listSessions("route-1");
  const status = await adapter.getStatus(session.id);
  await adapter.stop();

  assert.equal(sessions[0]?.title, "Renamed Thread");
  assert.equal(status.model?.model, "fake-next");
  assert.ok(events.some((event) => event.type === "codex.notification" && event.notification.text.includes("Codex 警告")));
  assert.ok(events.some((event) => event.type === "codex.notification" && event.notification.text.includes("From: fake") && event.notification.text.includes("To: fake-next")));
  assert.ok(events.some((event) => event.type === "codex.notification" && event.notification.text.includes("trustedAccessForCyber")));
  assert.ok(events.some((event) => event.type === "codex.notification" && event.notification.text.includes("模型安全缓冲") && event.notification.text.includes("fake-next")));
});

test("AppServerCodexAdapter sets thread names through app-server", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });

  await adapter.setSessionTitle(session.id, "微信 / wx-main / 小黄");
  const sessions = await adapter.listSessions("route-1");
  await adapter.stop();

  assert.equal(sessions[0]?.title, "微信 / wx-main / 小黄");
});

test("AppServerCodexAdapter lists sessions from app-server thread list for unscoped discovery", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "route session",
  });

  const allSessions = await adapter.listSessions();
  const routeSessions = await adapter.listSessions("route-1");
  await adapter.stop();

  assert.ok(allSessions.some((item) => item.id === "thread-from-list-1" && item.title === "Thread List Session"));
  assert.ok(allSessions.some((item) => item.id === session.id && item.title === "route session"));
  assert.deepEqual(routeSessions.map((item) => item.id), [session.id]);
});

test("AppServerCodexAdapter reads session detail without loading turns", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const detail = await adapter.getSessionDetail("thread-detail-1");
  await adapter.stop();

  assert.equal(detail?.id, "thread-detail-1");
  assert.equal(detail?.sessionId, "thread-detail-1");
  assert.equal(detail?.threadId, "thread-detail-1");
  assert.equal(detail?.title, "Thread Read Detail");
  assert.equal(detail?.preview, "thread read preview");
  assert.equal(detail?.cwd, "/repo/read-detail");
  assert.equal(detail?.source, "appServer");
  assert.equal(detail?.threadSource, "chatCodex");
  assert.equal(detail?.modelProvider, "proxy");
  assert.equal(detail?.cliVersion, "fake-cli-1");
  assert.equal(detail?.path, "/tmp/thread-read.jsonl");
  assert.equal(detail?.gitInfo?.branch, "main");
  assert.equal(detail?.gitInfo?.sha, "abcdef1234567890");
  assert.equal(detail?.forkedFromId, "fork-source-1");
  assert.equal(detail?.ephemeral, false);
});

test("AppServerCodexAdapter restarts app-server when reloading a session", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.resumeSession("thread-app-server-1");
  assert.equal(fakeAppServerStartCount(root), 1);

  const reloaded = await adapter.reloadSession(session.id);
  assert.equal(reloaded.session.id, session.id);
  assert.equal(fakeAppServerStartCount(root), 2);

  const events: CodexEvent[] = [];
  for await (const event of adapter.run(session.id, "progress after reload")) {
    events.push(event);
  }
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "turn.started"));
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "progress done"));
  assert.ok(events.some((event) => event.type === "turn.completed"));
});

test("AppServerCodexAdapter fills empty Codex state previews", async (t) => {
  if (spawnSync("sqlite3", ["--version"], { stdio: "ignore" }).status !== 0) {
    t.skip("sqlite3 binary is not available");
    return;
  }
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root), codexHome: root });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const dbPath = path.join(root, "state_5.sqlite");
  const setup = spawnSync("sqlite3", [dbPath, [
    "CREATE TABLE threads (id TEXT PRIMARY KEY, preview TEXT NOT NULL, archived INTEGER NOT NULL);",
    `INSERT INTO threads VALUES ('${session.id}', '', 0);`,
  ].join(" ")], { encoding: "utf8" });
  assert.equal(setup.status, 0, setup.stderr);

  await adapter.setSessionPreview(session.id, "微信 / wx-main / 小黄");
  await adapter.stop();

  const query = spawnSync("sqlite3", ["-json", dbPath, "SELECT preview FROM threads WHERE id = 'thread-app-server-1'"], { encoding: "utf8" });
  assert.equal(query.status, 0, query.stderr);
  assert.deepEqual(JSON.parse(query.stdout), [{ preview: "微信 / wx-main / 小黄" }]);
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
  assert.ok(events.some((event) => event.type === "turn.interrupted"));
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
  assert.ok(events.some((event) => event.type === "turn.interrupted"));
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

test("AppServerCodexAdapter emits connection notification on final reconnect attempt", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events: CodexEvent[] = [];

  for await (const event of adapter.run(session.id, "transient reconnect final please")) {
    events.push(event);
  }
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "assistant.progress" && event.kind === "other" && event.text.includes("Reconnecting... 5/5")));
  const notification = events.find((event) => event.type === "codex.notification" && event.notification.kind === "connection");
  assert.equal(notification?.type, "codex.notification");
  if (notification?.type === "codex.notification") {
    assert.equal(notification.notification.method, "appServer/reconnecting");
    assert.match(notification.notification.text, /最后一次尝试：5\/5/);
    assert.match(notification.notification.dedupeKey, /appServer\/reconnecting:/);
  }
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "reconnect final done"));
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

test("AppServerCodexAdapter forwards commentary agent messages as commentary", async () => {
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

  assert.ok(events.some((event) => event.type === "assistant.commentary" && event.text.includes("我正在检查状态")));
  assert.equal(events.some((event) => event.type === "assistant.progress" && event.kind === "other" && event.text.includes("我正在检查状态")), false);
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

  const commentaryTexts = events
    .filter((event) => event.type === "assistant.commentary")
    .map((event) => event.type === "assistant.commentary" ? event.text : "");
  assert.equal(commentaryTexts.length, 1);
  assert.ok(commentaryTexts[0].includes("第一段内容"));
  assert.ok(commentaryTexts[0].includes("第二段"));
  assert.equal(commentaryTexts[0], "我先检查第一段内容。版本 0.162.1。然后继续补上第二段。完成时补齐的结论。");
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "commentary chunks final"));
  assert.equal(events.some((event) => event.type === "assistant.completed" && event.text.includes("第一段内容")), false);
});

test("AppServerCodexAdapter emits commentary-only turns without final completion", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });
  const events = [];

  for await (const event of adapter.run(session.id, "commentary only please")) {
    events.push(event);
  }
  await adapter.stop();

  assert.ok(events.some((event) => event.type === "assistant.commentary" && event.text === "只有旁白，没有最终回复。"));
  assert.equal(events.some((event) => event.type === "assistant.completed"), false);
  assert.ok(events.some((event) => event.type === "turn.completed"));
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
  const toolProgress = events.filter((event) => event.type === "tool.progress");
  assert.equal(toolProgress.length, 2);
  assert.deepEqual(toolProgress.map((event) => event.type === "tool.progress" ? event.progress.phase : undefined), ["start", "end"]);
  assert.deepEqual(toolProgress.map((event) => event.type === "tool.progress" ? event.progress.itemId : undefined), ["cmd-spam", "cmd-spam"]);
  assert.ok(toolProgress.every((event) => event.type === "tool.progress" && event.progress.toolName.includes("npm test")));
  const toolEnd = toolProgress.find((event) => event.type === "tool.progress" && event.progress.phase === "end");
  assert.equal(toolEnd?.type === "tool.progress" ? toolEnd.progress.status : undefined, "completed");
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
  const toolEnd = events.find((event) => event.type === "tool.progress" && event.progress.phase === "end");
  assert.equal(toolEnd?.type === "tool.progress" ? toolEnd.progress.itemId : undefined, "cmd-fail");
  assert.equal(toolEnd?.type === "tool.progress" ? toolEnd.progress.status : undefined, "failed");
});

test("AppServerCodexAdapter reports interactive approval support", () => {
  const adapter = new AppServerCodexAdapter();

  const status = adapter.getRunPolicyStatus();

  assert.equal(status.interactiveApprovals, true);
  assert.equal(status.effectiveApprovalPolicy, "on-request");
  assert.equal(status.effectiveApprovalsReviewer, "user");
  assert.deepEqual(status.supportedPermissionModes, ["approval", "approve-for-me", "full"]);
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

  adapter.setRunPolicy({ permissionMode: "approve-for-me", sandbox: "workspace-write" }, first.id);
  await adapter.stop();

  assert.equal(adapter.getRunPolicy(first.id).permissionMode, "approve-for-me");
  assert.equal(adapter.getRunPolicyStatus(first.id).effectiveApprovalPolicy, "on-request");
  assert.equal(adapter.getRunPolicyStatus(first.id).effectiveApprovalsReviewer, "user"); // Last server-confirmed setting, before the next turn.
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
  assert.deepEqual(visible[1].supportedReasoningEfforts.map((option) => option.reasoningEffort), ["medium", "high", "xhigh", "max"]);
  assert.deepEqual(visible[1].inputModalities, ["text", "image"]);
  assert.equal(visible[1].supportsPersonality, true);
  assert.equal(visible[1].defaultServiceTier, "default");
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
  assert.equal(status.model?.model, "fake"); // Fake server has not confirmed the requested model yet.
  assert.equal(status.model?.reasoningEffort, "medium");
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
  adapter.setModelPolicy({ model: "fake-next", reasoningEffort: "xhigh" }, session.id);
  adapter.setCollaborationMode("plan", session.id);
  const events = [];

  for await (const event of adapter.run(session.id, "collaboration mode params please")) {
    events.push(event);
  }
  const status = await adapter.getStatus(session.id);
  await adapter.stop();

  assert.equal(adapter.getCollaborationMode(session.id), "plan");
  assert.ok(events.some((event) => event.type === "assistant.completed" && event.text === "mode plan model fake-next effort xhigh dev null"));
  assert.equal(status.model?.model, "fake-next");
  assert.equal(status.model?.reasoningEffort, "xhigh");
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

test("AppServerCodexAdapter reloads a session with paged history and recovers its last final assistant reply", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });

  const reloaded = await adapter.reloadSession(session.id);
  await adapter.stop();
  const requests = fakeRequestDetails(root);

  assert.equal(reloaded.session.id, session.id);
  assert.equal(reloaded.lastAssistantMessage, "终端最新最终回复");
  assert.equal(requests.some((request) => request.method === "thread/resume" && request.params?.excludeTurns === true), true);
  assert.equal(requests.some((request) => request.method === "thread/turns/list"), true);
  assert.equal(requests.some((request) => request.method === "thread/items/list"), true);
  assert.equal(requests.some((request) => request.method === "thread/read" && request.params?.includeTurns === true), false);
});

test("AppServerCodexAdapter keeps reload working when pagination is unavailable without requesting full history", async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, "pagination-unavailable"), "1");
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "test",
  });

  const reloaded = await adapter.reloadSession(session.id);
  await adapter.stop();
  const requests = fakeRequestDetails(root);

  assert.equal(reloaded.session.id, session.id);
  assert.equal(reloaded.lastAssistantMessage, undefined);
  assert.equal(requests.some((request) => request.method === "thread/turns/list"), true);
  assert.equal(requests.some((request) => request.method === "thread/read" && request.params?.includeTurns === true), false);
});

test("AppServerCodexAdapter fails an active turn on malformed JSON and starts a fresh process for the next turn", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "transport recovery",
  });
  const failedEvents: CodexEvent[] = [];

  try {
    for await (const event of adapter.run(session.id, "malformed json")) {
      failedEvents.push(event);
    }
    const status = await adapter.getStatus(session.id);
    const diagnostic = adapter.getTransportDiagnostic();
    const recoveredEvents: CodexEvent[] = [];
    for await (const event of adapter.run(session.id, "progress after transport recovery")) {
      recoveredEvents.push(event);
    }

    assert.ok(failedEvents.some((event) => event.type === "turn.started"));
    assert.ok(failedEvents.some((event) => event.type === "turn.failed" && /Unterminated string/.test(event.error)));
    assert.equal(failedEvents.some((event) => event.type === "turn.completed"), false);
    assert.equal(status.type, "failed");
    assert.equal(diagnostic?.kind, "invalid_json");
    assert.ok((diagnostic?.stdoutLineLength ?? 0) > 0);
    assert.equal(fakeRequestCount(root, "turn/start"), 2);
    assert.equal(fakeAppServerStartCount(root), 2);
    assert.ok(recoveredEvents.some((event) => event.type === "assistant.completed" && event.text === "progress done"));
  } finally {
    await adapter.stop();
  }
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
  assert.ok(events.some((event) => event.type === "context.compaction" && event.phase === "started"));
  assert.ok(events.some((event) => event.type === "context.compaction" && event.phase === "completed"));
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

test("AppServerCodexAdapter records invalid cwd diagnostics without retrying the turn", async () => {
  const root = tempDir();
  const adapter = new AppServerCodexAdapter({ codexBin: fakeCodexBin(root) });
  const session = await adapter.startSession({
    routeKey: "route-1",
    cwd: root,
    title: "cwd diagnostic",
  });

  try {
    await assert.rejects(async () => {
      for await (const _event of adapter.run(session.id, "trigger invalid cwd")) {
        // The fake server rejects before a turn starts.
      }
    }, /invalid cwd: Operation not permitted/);

    const status = await adapter.getStatus(session.id);
    const diagnostic = adapter.getCwdDiagnostic(session.id);
    assert.equal(status.type, "failed");
    assert.equal(status.cwdDiagnostic?.source, "turn/start");
    assert.equal(status.cwdDiagnostic?.error, "invalid cwd: Operation not permitted (os error 1)");
    assert.equal(diagnostic?.requestCwd.cwd, root);
    assert.equal(diagnostic?.requestCwd.state, "ok");
    assert.equal(diagnostic?.inheritedProcessCwd.state, "ok");
    assert.equal(fakeRequestCount(root, "turn/start"), 1);
  } finally {
    await adapter.stop();
  }
});

async function waitForUnit(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition not met before timeout");
}
