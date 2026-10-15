import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { approvalFromServerRequest, approvalKindForMethod, responseForApprovalDecision, riskyCommand } from "../../src/codex/app-server/approval-handler.js";
import { goalFromResponse, goalFromSetResponse } from "../../src/codex/app-server/goal-api.js";
import { appServerUserInput, localFileInputText } from "../../src/codex/app-server/input-mapper.js";
import { modelInfoFromResponse, modelInfoWithPolicy, modelsFromListResponse, parseTokenUsage, withoutModelInfo } from "../../src/codex/app-server/model-policy.js";
import { appServerErrorMessage, isTransientAppServerError, messagePhaseValue, parseAppServerReconnectNotice, progressFromThreadItem, shouldFlushProgressDraft, textFromPlan } from "../../src/codex/app-server/notification-mapper.js";
import { APP_SERVER_PROTOCOL_CAPABILITIES, type AppServerProtocolDirection } from "../../src/codex/app-server/protocol-capabilities.js";
import { approvalPolicyForRunPolicy, approvalsReviewerForRunPolicy, cloneRunPolicy, sandboxModeForRunPolicy, sandboxPolicyForRunPolicy } from "../../src/codex/app-server/run-policy.js";
import { contextFromServerRequestParams, unsupportedServerRequestResponse, userInputRequestFromServerRequest } from "../../src/codex/app-server/server-request-mapper.js";
import { collaborationModePayload, truncatePrompt, withContext, withModelPolicy } from "../../src/codex/app-server/session-status.js";
import { readLastAssistantMessageFromPages } from "../../src/codex/app-server/thread-history.js";
import { sessionSummaryFromThread } from "../../src/codex/app-server/thread-list.js";
import { AsyncEventQueue, createTurnQueueRecord, shouldCreateBackgroundTurn } from "../../src/codex/app-server/turn-store.js";
import { arrayValue, isoFromSeconds, numberValue, objectValue, objectValueOrNull, stringValue } from "../../src/codex/app-server/value-parsers.js";

test("app-server value parsers keep narrow coercion semantics", () => {
  assert.deepEqual(objectValue({ ok: true }), { ok: true });
  assert.deepEqual(objectValue(["x"]), {});
  assert.equal(objectValueOrNull(null), null);
  assert.deepEqual(arrayValue(["x"]), ["x"]);
  assert.deepEqual(arrayValue("x"), []);
  assert.equal(stringValue("hello"), "hello");
  assert.equal(stringValue(""), undefined);
  assert.equal(numberValue(12), 12);
  assert.equal(numberValue("12"), undefined);
  assert.equal(isoFromSeconds(1778716800), "2026-05-14T00:00:00.000Z");
});

test("app-server run policy maps permissions to app-server payloads", () => {
  const approval = { permissionMode: "approval", sandbox: "workspace-write" } as const;
  const approveForMe = { permissionMode: "approve-for-me", sandbox: "workspace-write" } as const;
  const full = { permissionMode: "full" } as const;
  assert.notEqual(cloneRunPolicy(approval), approval);
  assert.equal(approvalPolicyForRunPolicy(approval), "on-request");
  assert.equal(approvalPolicyForRunPolicy(approveForMe), "on-request");
  assert.equal(approvalPolicyForRunPolicy(full), "never");
  assert.equal(approvalsReviewerForRunPolicy(approval), "user");
  assert.equal(approvalsReviewerForRunPolicy(approveForMe), "auto_review");
  assert.equal(approvalsReviewerForRunPolicy(full), null);
  assert.equal(sandboxModeForRunPolicy(approval), "workspace-write");
  assert.equal(sandboxModeForRunPolicy(approveForMe), "workspace-write");
  assert.equal(sandboxModeForRunPolicy(full), "danger-full-access");
  assert.deepEqual(sandboxPolicyForRunPolicy({ permissionMode: "approval", sandbox: "read-only" }, "/repo"), { type: "readOnly", networkAccess: false });
  assert.deepEqual(sandboxPolicyForRunPolicy(full, "/repo"), { type: "dangerFullAccess" });
  assert.deepEqual(sandboxPolicyForRunPolicy(approval, "/repo"), {
    type: "workspaceWrite",
    writableRoots: ["/repo"],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });
});

test("app-server approval mapper preserves request and decision compatibility", () => {
  assert.equal(approvalKindForMethod("item/commandExecution/requestApproval"), "command");
  assert.equal(approvalKindForMethod("item/commandExecution/requestApproval", { kind: "writeStdin" }), "terminal_input");
  assert.equal(approvalKindForMethod("applyPatchApproval"), "file_change");
  assert.equal(approvalKindForMethod("item/permissions/requestApproval"), "permissions");
  assert.equal(approvalKindForMethod("unknown"), undefined);
  assert.deepEqual(responseForApprovalDecision("item/commandExecution/requestApproval", {}, "approve-session"), { decision: "acceptForSession" });
  assert.deepEqual(responseForApprovalDecision("execCommandApproval", {}, "deny"), { decision: "denied" });
  assert.deepEqual(responseForApprovalDecision("item/permissions/requestApproval", { permissions: { network: { enabled: true }, fileSystem: { write: ["/repo"] }, ignored: null } }, "approve"), {
    permissions: { network: { enabled: true }, fileSystem: { write: ["/repo"] } },
    scope: "turn",
  });
  assert.deepEqual(approvalFromServerRequest("item/commandExecution/requestApproval", "approval-1", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    command: ["sudo", "rm", "-rf", "/tmp/x"],
    environmentId: "remote",
    cwd: "/repo",
    reason: "needs command",
  }), {
    kind: "command",
    adapterApprovalId: "approval-1",
    sessionId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    command: "sudo rm -rf /tmp/x",
    environmentId: "remote",
    cwd: "/repo",
    reason: "needs command",
    risk: "high",
    availableDecisions: ["approve", "approve-session", "deny", "cancel"],
    raw: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      command: ["sudo", "rm", "-rf", "/tmp/x"],
      environmentId: "remote",
      cwd: "/repo",
      reason: "needs command",
    },
  });
  assert.equal(approvalFromServerRequest("unknown", "approval-1", {}), undefined);
  assert.equal(riskyCommand("sudo rm -rf /tmp/x"), true);
  assert.equal(riskyCommand("npm test"), false);
});

test("app-server writeStdin approvals use the terminal-input kind and only allowed decisions", () => {
  const approval = approvalFromServerRequest("item/commandExecution/requestApproval", "stdin-request-1", {
    kind: "writeStdin",
    threadId: "thread-1",
    turnId: "turn-2",
    itemId: "command-item-1",
    approvalId: "opaque-stdin-callback-id",
    command: "write_stdin --session-id 42 'confirm\\n'",
    environmentId: "remote",
    cwd: "/repo",
    reason: "程序正在等待确认",
    availableDecisions: ["accept", "cancel"],
  });

  assert.deepEqual(approval, {
    kind: "terminal_input",
    adapterApprovalId: "stdin-request-1",
    sessionId: "thread-1",
    turnId: "turn-2",
    itemId: "command-item-1",
    command: "write_stdin --session-id 42 'confirm\\n'",
    environmentId: "remote",
    cwd: "/repo",
    reason: "程序正在等待确认",
    terminalId: "42",
    terminalInput: "confirm\\n",
    risk: undefined,
    availableDecisions: ["approve", "cancel"],
    raw: {
      kind: "writeStdin",
      threadId: "thread-1",
      turnId: "turn-2",
      itemId: "command-item-1",
      approvalId: "opaque-stdin-callback-id",
      command: "write_stdin --session-id 42 'confirm\\n'",
      environmentId: "remote",
      cwd: "/repo",
      reason: "程序正在等待确认",
      availableDecisions: ["accept", "cancel"],
    },
  });
  assert.deepEqual(responseForApprovalDecision("item/commandExecution/requestApproval", {}, "cancel"), { decision: "cancel" });
});

test("app-server writeStdin approval safely falls back to accept and cancel for transition servers", () => {
  const approval = approvalFromServerRequest("item/commandExecution/requestApproval", "stdin-request-2", {
    kind: "writeStdin",
    threadId: "thread-1",
    turnId: "turn-2",
    itemId: "command-item-1",
    command: "write_stdin --session-id 42 'y\\n'",
  });

  assert.deepEqual(approval?.availableDecisions, ["approve", "cancel"]);
});

test("app-server command approvals retain all fields needed by a channel card", () => {
  const approval = approvalFromServerRequest("item/commandExecution/requestApproval", "approval-2", {
    threadId: "019f66c4-d7ac-7251-8953-05a8b3fa629d",
    turnId: "019f66c5-20d0-7437-bb9d-cccf142a4525",
    itemId: "item-2",
    startedAtMs: 1_778_716_800_000,
    command: "id",
    environmentId: "remote",
    cwd: "/Volumes/MacSSD/Repositories/codex-chat-bridge",
    reason: "验证审批流程",
  });

  assert.deepEqual(approval, {
    kind: "command",
    adapterApprovalId: "approval-2",
    sessionId: "019f66c4-d7ac-7251-8953-05a8b3fa629d",
    turnId: "019f66c5-20d0-7437-bb9d-cccf142a4525",
    itemId: "item-2",
    command: "id",
    environmentId: "remote",
    cwd: "/Volumes/MacSSD/Repositories/codex-chat-bridge",
    reason: "验证审批流程",
    risk: undefined,
    availableDecisions: ["approve", "approve-session", "deny", "cancel"],
    raw: {
      threadId: "019f66c4-d7ac-7251-8953-05a8b3fa629d",
      turnId: "019f66c5-20d0-7437-bb9d-cccf142a4525",
      itemId: "item-2",
      startedAtMs: 1_778_716_800_000,
      command: "id",
      environmentId: "remote",
      cwd: "/Volumes/MacSSD/Repositories/codex-chat-bridge",
      reason: "验证审批流程",
    },
  });
});

test("app-server unsupported server request mapper fails closed with visible notices", () => {
  assert.deepEqual(contextFromServerRequestParams({
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
  }), {
    sessionId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
  });

  const input = userInputRequestFromServerRequest("input-1", {
    threadId: "thread-1",
    turnId: "turn-1",
    questions: [{ id: "q1", header: "确认路径", question: "是否继续？" }],
  }, "thread-1");
  assert.equal(input?.adapterRequestId, "input-1");
  assert.equal(input?.questions[0]?.id, "q1");
  assert.equal(input?.questions[0]?.question, "是否继续？");

  const elicitation = unsupportedServerRequestResponse("mcpServer/elicitation/request", {
    threadId: "thread-1",
    turnId: "turn-1",
    serverName: "private-app",
    mode: "url",
    message: "需要授权",
  });
  assert.deepEqual(elicitation.result, { action: "cancel", content: null, _meta: null });
  assert.match(elicitation.notice?.text ?? "", /MCP elicitation/);

  const toolCall = unsupportedServerRequestResponse("item/tool/call", {
    threadId: "thread-1",
    turnId: "turn-1",
    namespace: "bridge",
    tool: "dangerous",
  });
  assert.deepEqual(toolCall.result, {
    success: false,
    contentItems: [{ type: "inputText", text: "Codex 请求调用动态工具 bridge.dangerous，但 Chat-Codex 当前没有开放动态工具桥接；本次调用已拒绝。" }],
  });

  const auth = unsupportedServerRequestResponse("account/chatgptAuthTokens/refresh", {});
  assert.equal(auth.error?.code, -32000);
  assert.match(auth.error?.message ?? "", /不接管/);
});

test("app-server protocol inventory classifies local Codex reference schema methods", { skip: !hasReferenceSchema() }, () => {
  const schemaDir = path.join(process.cwd(), "references/openai-codex/codex-rs/app-server-protocol/schema/typescript");
  const expected = {
    client_request: methodsFromGeneratedSchema(path.join(schemaDir, "ClientRequest.ts")),
    server_request: methodsFromGeneratedSchema(path.join(schemaDir, "ServerRequest.ts")),
    server_notification: methodsFromGeneratedSchema(path.join(schemaDir, "ServerNotification.ts")),
  } satisfies Record<AppServerProtocolDirection, string[]>;
  const known = new Set(APP_SERVER_PROTOCOL_CAPABILITIES.map((capability) => `${capability.direction}:${capability.method}`));

  for (const [direction, methods] of Object.entries(expected) as Array<[AppServerProtocolDirection, string[]]>) {
    const missing = methods.filter((method) => !known.has(`${direction}:${method}`));
    assert.deepEqual(missing, [], `${direction} methods must be classified`);
  }
});

test("app-server goal mapper accepts camel and snake case responses", () => {
  assert.deepEqual(goalFromResponse({
    thread_id: "thread-1",
    objective: "ship it",
    status: "paused",
    token_budget: 100,
    tokens_used: 12,
    time_used_seconds: 34,
    created_at: 1,
    updated_at: 2,
  }), {
    threadId: "thread-1",
    objective: "ship it",
    status: "paused",
    tokenBudget: 100,
    tokensUsed: 12,
    timeUsedSeconds: 34,
    createdAt: 1,
    updatedAt: 2,
  });
  assert.equal(goalFromResponse({ status: "bad" }).status, "active");
  assert.equal(goalFromResponse({ status: "blocked" }).status, "blocked");
  assert.equal(goalFromResponse({ status: "usageLimited" }).status, "usageLimited");
  assert.equal(goalFromSetResponse({ goal: { threadId: "thread-2" } }).threadId, "thread-2");
  assert.throws(() => goalFromSetResponse({}), /未返回 Goal/);
});

test("app-server thread list mapper converts thread metadata to session summaries", () => {
  assert.deepEqual(sessionSummaryFromThread({
    id: "thread-1",
    name: "修复 /sessions",
    preview: "fallback preview",
    cwd: "/repo/chat-codex",
    recencyAt: 1800000000,
    updatedAt: 1700000000,
    createdAt: 1600000000,
    status: { type: "active", activeFlags: ["goal"] },
  }), {
    id: "thread-1",
    title: "修复 /sessions",
    cwd: "/repo/chat-codex",
    status: { type: "running", task: "goal" },
    updatedAt: "2027-01-15T08:00:00.000Z",
  });
  assert.equal(sessionSummaryFromThread({ preview: "missing id" }), undefined);
  assert.deepEqual(sessionSummaryFromThread({
    id: "thread-2",
    preview: "只有 preview",
    updatedAt: 1700000000,
    status: { type: "notLoaded" },
  })?.status, { type: "unknown", detail: "not loaded" });
});

test("app-server thread history mapper reads the newest final assistant reply through bounded pages", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const message = await readLastAssistantMessageFromPages(async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/turns/list") {
      return { data: [{ id: "turn-new" }], nextCursor: null };
    }
    if (params.cursor === null) {
      return {
        data: [
          { turnId: "turn-new", item: { type: "agentMessage", text: "最后旁白", phase: "commentary" } },
          { turnId: "turn-new", item: { type: "plan", text: "继续检查" } },
        ],
        nextCursor: "older-items",
      };
    }
    return {
      data: [{ turnId: "turn-new", item: { type: "agentMessage", text: "  最新回复  ", phase: "final_answer" } }],
      nextCursor: null,
    };
  }, "thread-1");

  assert.equal(message, "最新回复");
  assert.deepEqual(calls, [
    {
      method: "thread/turns/list",
      params: { threadId: "thread-1", cursor: null, limit: 4, sortDirection: "desc", itemsView: "notLoaded" },
    },
    {
      method: "thread/items/list",
      params: { threadId: "thread-1", turnId: "turn-new", cursor: null, limit: 16, sortDirection: "desc" },
    },
    {
      method: "thread/items/list",
      params: { threadId: "thread-1", turnId: "turn-new", cursor: "older-items", limit: 16, sortDirection: "desc" },
    },
  ]);
  assert.equal(await readLastAssistantMessageFromPages(async () => {
    throw new Error("JSON-RPC error -32601");
  }, "thread-1"), undefined);
  await assert.rejects(
    readLastAssistantMessageFromPages(async () => {
      throw new Error("Unterminated string in JSON at position 24");
    }, "thread-1"),
    /Unterminated string/,
  );
});

test("app-server input mapper preserves text, local images, and file instructions", () => {
  assert.deepEqual(appServerUserInput("hello"), [{ type: "text", text: "hello", text_elements: [] }]);
  assert.deepEqual(appServerUserInput({
    text: "describe",
    items: [
      { type: "text", text: "describe" },
      { type: "localImage", path: "/tmp/a.png" },
      { type: "localFile", path: "/tmp/a.txt", name: "a.txt", mimeType: "text/plain" },
    ],
  }), [
    { type: "text", text: "describe", text_elements: [] },
    { type: "localImage", path: "/tmp/a.png" },
    { type: "text", text: localFileInputText({ path: "/tmp/a.txt", name: "a.txt", mimeType: "text/plain" }), text_elements: [] },
  ]);
});

test("app-server model and token mappers preserve response parsing", () => {
  assert.deepEqual(modelInfoFromResponse({ model: "gpt", modelProvider: "openai", serviceTier: null, reasoningEffort: "high" }, {}), {
    model: "gpt",
    provider: "openai",
    reasoningEffort: "high",
    serviceTier: null,
  });
  assert.deepEqual(modelInfoWithPolicy({ model: "base", provider: "openai" }, { model: "next", reasoningEffort: "medium", serviceTier: "default" }), {
    model: "next",
    provider: "openai",
    reasoningEffort: "medium",
    serviceTier: "default",
  });
  assert.deepEqual(withoutModelInfo({ type: "idle", model: { model: "gpt" } }), { type: "idle" });
  assert.deepEqual(modelsFromListResponse({
    data: [{
      id: "fake",
      model: "fake",
      display_name: "Fake",
      supported_reasoning_efforts: ["low", { reasoning_effort: "medium", description: "Medium" }, "max", "bad value!"],
      default_reasoning_effort: "ultra",
      input_modalities: ["text", "image"],
      supports_personality: true,
      service_tiers: [{ id: "default", name: "Default" }],
      default_service_tier: "default",
      upgrade: "newer",
      upgrade_info: { model: "newer" },
      availability_nux: { message: "available" },
      hidden: true,
      isDefault: false,
    }],
  }), [{
    id: "fake",
    model: "fake",
    displayName: "Fake",
    upgrade: "newer",
    upgradeInfo: { model: "newer" },
    availabilityNux: { message: "available" },
    hidden: true,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium", description: "Medium" }, { reasoningEffort: "max" }, { reasoningEffort: "ultra" }],
    defaultReasoningEffort: "ultra",
    inputModalities: ["text", "image"],
    supportsPersonality: true,
    serviceTiers: [{ id: "default", name: "Default" }],
    defaultServiceTier: "default",
    isDefault: false,
  }]);
  assert.deepEqual(parseTokenUsage({
    total: { totalTokens: 10, inputTokens: 4, cachedInputTokens: 1, outputTokens: 6, reasoningOutputTokens: 2 },
    last: { totalTokens: 3, inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 1 },
    modelContextWindow: 100,
  }), {
    total: { totalTokens: 10, inputTokens: 4, cachedInputTokens: 1, outputTokens: 6, reasoningOutputTokens: 2 },
    last: { totalTokens: 3, inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 1 },
    modelContextWindow: 100,
  });
});

test("app-server notification helpers map progress and errors", () => {
  assert.equal(messagePhaseValue("commentary"), "commentary");
  assert.equal(messagePhaseValue("other"), undefined);
  assert.deepEqual(progressFromThreadItem({ type: "commandExecution", command: "npm test", aggregatedOutput: "ok\n", status: "completed" }), {
    text: "命令完成: npm test\n输出摘要:\nok",
    kind: "command",
  });
  const longCommandProgress = progressFromThreadItem({
    type: "commandExecution",
    command: "npm test",
    aggregatedOutput: Array.from({ length: 50 }, (_, index) => `\u001b[31mline ${index + 1}\u001b[39m`).join("\n"),
    status: "completed",
    durationMs: 1234,
  });
  assert.equal(longCommandProgress?.kind, "command");
  assert.match(longCommandProgress?.text ?? "", /命令完成: npm test/);
  assert.match(longCommandProgress?.text ?? "", /耗时=1\.2s/);
  assert.match(longCommandProgress?.text ?? "", /line 50/);
  assert.match(longCommandProgress?.text ?? "", /已省略/);
  assert.match(longCommandProgress?.text ?? "", /已清理 ANSI\/control 控制字符/);
  assert.deepEqual(progressFromThreadItem({ type: "fileChange", changes: [{ path: "a.ts" }] }), {
    text: "文件变更完成: a.ts",
    kind: "file_change",
  });
  assert.equal(textFromPlan({ plan: [{ step: "one" }, { text: "two" }] }), "two");
  assert.equal(shouldFlushProgressDraft("一句话。"), true);
  assert.equal(shouldFlushProgressDraft("short"), false);
  assert.equal(appServerErrorMessage({ error: { message: "bad" } }), "bad");
  assert.deepEqual(parseAppServerReconnectNotice("Reconnecting... 1/5"), {
    message: "Reconnecting... 1/5",
    attempt: 1,
    total: 5,
  });
  assert.deepEqual(parseAppServerReconnectNotice(" Reconnecting... 5/5 "), {
    message: "Reconnecting... 5/5",
    attempt: 5,
    total: 5,
  });
  assert.equal(parseAppServerReconnectNotice("Reconnecting... 6/5"), undefined);
  assert.equal(parseAppServerReconnectNotice("Disconnected"), undefined);
  assert.equal(isTransientAppServerError("Reconnecting... 1/5"), true);
  assert.equal(isTransientAppServerError("Reconnecting... 0/5"), false);
});

test("app-server turn store preserves queue and background rules", async () => {
  const queue = new AsyncEventQueue<{ value: number }>();
  queue.push({ value: 1 });
  const iterator = queue[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: { value: 1 }, done: false });
  queue.close();
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  const record = createTurnQueueRecord("session-1", "turn-1", new AsyncEventQueue(), "plan");
  assert.equal(record.sessionId, "session-1");
  assert.equal(record.turnId, "turn-1");
  assert.equal(record.collaborationMode, "plan");
  assert.equal(record.commandExecutions.size, 0);
  assert.equal(record.closed, false);
  assert.equal(shouldCreateBackgroundTurn("thread/tokenUsage/updated"), false);
  assert.equal(shouldCreateBackgroundTurn("turn/started"), true);
});

test("app-server session status helpers preserve status context and collaboration payload", () => {
  const record = {
    session: { id: "session-1", cwd: "/repo", createdAt: "now" },
    status: {
      type: "idle" as const,
      context: {
        total: { totalTokens: 10, inputTokens: 4, cachedInputTokens: 1, outputTokens: 6, reasoningOutputTokens: 2 },
        last: { totalTokens: 3, inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 1 },
      },
      model: { model: "fake", reasoningEffort: "high" },
    },
    updatedAt: "now",
    baseModel: { model: "base", reasoningEffort: "low" },
  };
  assert.deepEqual(withContext(record, { type: "running", turnId: "turn-1" }), {
    type: "running",
    turnId: "turn-1",
    context: record.status.context,
    model: record.status.model,
  });
  assert.deepEqual(withModelPolicy({ type: "idle", model: { model: "base" } }, { model: "next", reasoningEffort: "medium" }), {
    type: "idle",
    model: { model: "next", reasoningEffort: "medium" },
  });
  assert.deepEqual(collaborationModePayload("plan", {}, record), {
    mode: "plan",
    settings: {
      model: "fake",
      reasoning_effort: "high",
      developer_instructions: null,
    },
  });
  assert.deepEqual(collaborationModePayload("plan", {}, {
    session: { id: "session-1", cwd: "/repo", createdAt: "now" },
    status: { type: "idle" as const, model: { model: "fake" } },
    updatedAt: "now",
  }), {
    mode: "plan",
    settings: {
      model: "fake",
      reasoning_effort: null,
      developer_instructions: null,
    },
  });
  assert.equal(truncatePrompt("x".repeat(130)).length, 120);
});

function hasReferenceSchema(): boolean {
  return existsSync(path.join(process.cwd(), "references/openai-codex/codex-rs/app-server-protocol/schema/typescript/ServerRequest.ts"));
}

function methodsFromGeneratedSchema(filePath: string): string[] {
  const text = readFileSync(filePath, "utf8");
  return [...text.matchAll(/"method": "([^"]+)"/g)].map((match) => match[1] ?? "");
}
