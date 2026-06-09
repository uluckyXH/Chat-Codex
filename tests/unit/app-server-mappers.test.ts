import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { approvalFromServerRequest, approvalKindForMethod, responseForApprovalDecision, riskyCommand } from "../../src/codex/app-server/approval-handler.js";
import { goalFromResponse, goalFromSetResponse } from "../../src/codex/app-server/goal-api.js";
import { appServerUserInput, localFileInputText } from "../../src/codex/app-server/input-mapper.js";
import { modelInfoFromResponse, modelInfoWithPolicy, modelsFromListResponse, parseTokenUsage, withoutModelInfo } from "../../src/codex/app-server/model-policy.js";
import { appServerErrorMessage, isTransientAppServerError, messagePhaseValue, progressFromThreadItem, shouldFlushProgressDraft, textFromPlan } from "../../src/codex/app-server/notification-mapper.js";
import { APP_SERVER_PROTOCOL_CAPABILITIES, type AppServerProtocolDirection } from "../../src/codex/app-server/protocol-capabilities.js";
import { approvalPolicyForRunPolicy, approvalsReviewerForRunPolicy, cloneRunPolicy, sandboxModeForRunPolicy, sandboxPolicyForRunPolicy } from "../../src/codex/app-server/run-policy.js";
import { contextFromServerRequestParams, unsupportedServerRequestResponse, userInputRequestFromServerRequest } from "../../src/codex/app-server/server-request-mapper.js";
import { collaborationModePayload, truncatePrompt, withContext, withModelPolicy } from "../../src/codex/app-server/session-status.js";
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
  const full = { permissionMode: "full" } as const;
  assert.notEqual(cloneRunPolicy(approval), approval);
  assert.equal(approvalPolicyForRunPolicy(approval), "on-request");
  assert.equal(approvalPolicyForRunPolicy(full), "never");
  assert.equal(approvalsReviewerForRunPolicy(approval), "user");
  assert.equal(approvalsReviewerForRunPolicy(full), null);
  assert.equal(sandboxModeForRunPolicy(approval), "workspace-write");
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
  assert.equal(approvalKindForMethod("applyPatchApproval"), "file_change");
  assert.equal(approvalKindForMethod("item/permissions/requestApproval"), "permissions");
  assert.equal(approvalKindForMethod("unknown"), undefined);
  assert.deepEqual(responseForApprovalDecision("item/commandExecution/requestApproval", {}, "approve-session"), { decision: "acceptForSession" });
  assert.deepEqual(responseForApprovalDecision("execCommandApproval", {}, "deny"), { decision: "denied" });
  assert.deepEqual(responseForApprovalDecision("item/permissions/requestApproval", { permissions: { network: true, fileSystem: "write", ignored: null } }, "approve"), {
    permissions: { network: true, fileSystem: "write" },
    scope: "turn",
  });
  assert.deepEqual(approvalFromServerRequest("item/commandExecution/requestApproval", "approval-1", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    command: ["sudo", "rm", "-rf", "/tmp/x"],
    cwd: "/repo",
    reason: "needs command",
  }), {
    kind: "command",
    adapterApprovalId: "approval-1",
    sessionId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    command: "sudo rm -rf /tmp/x",
    cwd: "/repo",
    reason: "needs command",
    risk: "high",
    availableDecisions: ["approve", "approve-session", "deny", "cancel"],
    raw: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      command: ["sudo", "rm", "-rf", "/tmp/x"],
      cwd: "/repo",
      reason: "needs command",
    },
  });
  assert.equal(approvalFromServerRequest("unknown", "approval-1", {}), undefined);
  assert.equal(riskyCommand("sudo rm -rf /tmp/x"), true);
  assert.equal(riskyCommand("npm test"), false);
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
  assert.equal(goalFromSetResponse({ goal: { threadId: "thread-2" } }).threadId, "thread-2");
  assert.throws(() => goalFromSetResponse({}), /未返回 Goal/);
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
      supported_reasoning_efforts: ["low", { reasoning_effort: "medium", description: "Medium" }, "bad"],
      default_reasoning_effort: "high",
      service_tiers: [{ id: "default", name: "Default" }],
      hidden: true,
      isDefault: false,
    }],
  }), [{
    id: "fake",
    model: "fake",
    displayName: "Fake",
    hidden: true,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium", description: "Medium" }, { reasoningEffort: "high" }],
    defaultReasoningEffort: "high",
    serviceTiers: [{ id: "default", name: "Default" }],
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
  assert.equal(isTransientAppServerError("Reconnecting... 1/5"), true);
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
