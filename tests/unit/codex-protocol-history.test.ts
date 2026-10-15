import test from "node:test";
import assert from "node:assert/strict";
import { readThreadListPages } from "../../src/codex/app-server/thread-list-pages.js";
import { progressFromThreadItem } from "../../src/codex/app-server/notification-mapper.js";
import { formatSessionListPage, paginateSessionList } from "../../src/bridge/session-list.js";

test("thread listing reads multiple bounded pages and deduplicates stable IDs", async () => {
  const calls: Record<string, unknown>[] = [];
  const result = await readThreadListPages(async (params) => {
    calls.push(params);
    return params.cursor ? { data: [{ id: "a" }, { id: "b" }], nextCursor: null } : { data: [{ id: "a" }], nextCursor: "second" };
  });
  assert.deepEqual(result.sessions.map((session) => session.id), ["a", "b"]);
  assert.equal(result.status.pages, 2);
  assert.equal(result.status.truncated, false);
  assert.ok(calls.every((call) => call.limit === 100));
});

test("thread listing stops on cursor repetition or page budget and reports partial results", async () => {
  for (const repeated of [true, false]) {
    let calls = 0;
    const result = await readThreadListPages(async () => ({ data: [{ id: `s${++calls}` }], nextCursor: repeated ? "same" : `page${calls}` }));
    assert.equal(calls, repeated ? 2 : 10);
    assert.equal(result.status.truncated, true);
    assert.match(formatSessionListPage(paginateSessionList([], "all", 1), { title: "会话", scopeLabel: "all", emptyText: "空", notice: result.status.notice }), /只加载了部分结果/);
  }
});

test("sort fallback is limited to an explicit old-server recency incompatibility", async () => {
  const sorts: unknown[] = [];
  await readThreadListPages(async (params) => {
    sorts.push(params.sortKey);
    if (params.sortKey === "recency_at") throw new Error("unknown variant recency_at");
    return { data: [] };
  });
  assert.deepEqual(sorts, ["recency_at", "updated_at"]);
  for (const error of ["unauthorized", "request timed out", "network disconnected", "invalid params: threadId"]) {
    let calls = 0;
    await assert.rejects(readThreadListPages(async () => { calls++; throw new Error(error); }), new RegExp(error));
    assert.equal(calls, 1);
  }
});

test("tool failures and image quota failures never display successful generation or raw image data", () => {
  for (const item of [
    { type: "fileChange", status: "failed", changes: [{ path: "a.ts" }] },
    { type: "mcpToolCall", server: "s", tool: "t", result: { isError: true } },
    { type: "imageGeneration", status: "completed", savedPath: "/should-not-send.png", failure: { type: "usageLimitExceeded", limitId: "x" }, result: "data:image/png;base64,abc" },
  ]) {
    const text = progressFromThreadItem(item)?.text ?? "";
    assert.match(text, /失败/);
    assert.doesNotMatch(text, /完成|should-not-send|base64/);
  }
  for (const result of ["aGVsbG8=", "data:image/png;base64,aGVsbG8=", "https://example.com/a.png", "/raw-result.png"]) {
    assert.doesNotMatch(progressFromThreadItem({ type: "imageGeneration", status: "completed", result })?.text ?? "", /aGVsbG8|base64|example.com|raw-result/);
  }
  assert.match(progressFromThreadItem({ type: "imageGeneration", status: "completed", savedPath: "C:\\images\\a.png" })?.text ?? "", /C:/);
  assert.match(progressFromThreadItem({ type: "imageView", path: "/view.png" })?.text ?? "", /查看完成/);
});
