import test from "node:test";
import assert from "node:assert/strict";
import type { CodexEvent } from "../../src/codex/types.js";
import { AppServerTurnController } from "../../src/codex/app-server/turn-controller.js";
import { AsyncEventQueue } from "../../src/codex/app-server/turn-store.js";
import { readLastAssistantMessageFromPages } from "../../src/codex/app-server/thread-history.js";

async function collect(queue: AsyncIterable<CodexEvent>): Promise<CodexEvent[]> {
  const events: CodexEvent[] = [];
  for await (const event of queue) events.push(event);
  return events;
}

function fixture() {
  const controller = new AppServerTurnController({ sessions: new Map(), threadToSession: new Map() });
  const queue = new AsyncEventQueue<CodexEvent>();
  controller.registerTurn("thread", "turn", queue);
  const notify = (method: string, params: Record<string, unknown>) => controller.handleNotification({ method, params: { threadId: "thread", turnId: "turn", ...params } });
  return { controller, queue, notify };
}

test("partial answers and async questions arrive before turn end and retain item identity", async () => {
  const { controller, queue, notify } = fixture();
  const iterator = queue[Symbol.asyncIterator]();
  notify("item/started", { item: { type: "agentMessage", id: "p1", phase: "partial_answer", text: "" } });
  notify("item/agentMessage/delta", { itemId: "p1", delta: "阶段答案" });
  const partial = { type: "agentMessage", id: "p1", phase: "partial_answer", text: "阶段答案" };
  notify("item/completed", { item: partial });
  const first = (await iterator.next()).value;
  assert.equal(first?.type, "assistant.message");
  assert.equal(controller.hasActiveTurns(), true);
  notify("item/completed", { item: partial });
  notify("item/agentMessage/delta", { itemId: "p1", delta: "重放" });
  notify("item/completed", { item: { ...partial, id: "p2" } });
  notify("item/completed", { item: { type: "agentMessage", id: "q", text: "请选择", delivery: "async", questions: [{ title: "环境？", options: ["开发", "生产"] }] } });
  notify("item/completed", { item: { type: "agentMessage", id: "f", phase: "final_answer", text: "最终答案" } });
  notify("turn/completed", { turn: { status: "completed" } });
  const events = await collect(queue);
  const messages = events.filter((e) => e.type === "assistant.message");
  assert.deepEqual(messages.map((e) => e.message.itemId), ["p2", "q"]);
  assert.deepEqual(messages[1]?.message.questions, [{ title: "环境？", options: ["开发", "生产"] }]);
  assert.ok(events.filter((e) => e.type === "assistant.completed").every((e) => e.text === "最终答案"));
  assert.equal(events.some((e) => e.type === "input.requested"), false);
});

test("late phase metadata clears provisional final text and separate final items replace snapshots", async () => {
  const { queue, notify } = fixture();
  notify("item/agentMessage/delta", { itemId: "p", delta: "阶段" });
  notify("item/completed", { item: { type: "agentMessage", id: "p", phase: "partial_answer", text: "阶段" } });
  notify("item/agentMessage/delta", { itemId: "f1", delta: "旧答案" });
  notify("item/agentMessage/delta", { itemId: "f2", delta: "新答案" });
  notify("turn/completed", { turn: { status: "completed" } });
  const events = await collect(queue);
  assert.ok(events.some((e) => e.type === "assistant.completed" && e.text === ""));
  assert.deepEqual(events.filter((e) => e.type === "assistant.delta").map((e) => e.snapshot), ["阶段", "旧答案", "新答案"]);
  const last = events.at(-2);
  assert.equal(last?.type === "assistant.completed" && last.text, "新答案");
});

test("partial-only turns do not fabricate a final, while legacy unphased answers still work", async () => {
  for (const phase of ["partial_answer", undefined]) {
    const { queue, notify } = fixture();
    notify("item/completed", { item: { type: "agentMessage", id: "p", phase, text: "内容" } });
    notify("turn/completed", { turn: { status: "completed" } });
    const events = await collect(queue);
    assert.equal(events.some((e) => e.type === "assistant.completed"), phase === undefined);
  }
});

test("history skips commentary, partial, async and question items to find a final", async () => {
  const reply = await readLastAssistantMessageFromPages(async (method) => method === "thread/turns/list"
    ? { data: [{ id: "t" }] }
    : { data: [
      { type: "agentMessage", text: "评论", phase: "commentary" },
      { type: "agentMessage", text: "阶段", phase: "partial_answer" },
      { type: "agentMessage", text: "异步", delivery: "async" },
      { type: "agentMessage", text: "问题", questions: [{ title: "选择？" }] },
      { type: "agentMessage", text: "最终", phase: "final_answer" },
    ].map((item) => ({ item })) }, "s");
  assert.equal(reply, "最终");
});

test("terminal statuses distinguish success, interruption, failure, and invalid completion", async () => {
  for (const [status, expected] of [["completed", "turn.completed"], ["interrupted", "turn.interrupted"], ["failed", "turn.failed"], ["inProgress", "turn.failed"], [undefined, "turn.failed"]]) {
    const { queue, notify } = fixture();
    notify("item/completed", { item: { type: "agentMessage", id: "f", text: "不能当成成功" } });
    notify("turn/completed", { turn: { status, error: { message: "失败原因", codexErrorInfo: "internalServerError", additionalDetails: "详情" } } });
    notify("turn/started", {});
    notify("turn/completed", { turn: { status: "completed" } });
    const events = await collect(queue);
    assert.equal(events.at(-1)?.type, expected);
    assert.equal(events.filter((e) => e.type.startsWith("turn.")).length, 1);
    const last = events.at(-1);
    if (status === "failed" && last?.type === "turn.failed") assert.equal(last.errorDetails?.additionalDetails, "详情");
  }
});

test("willRetry is authoritative and preserves the running turn until a real terminal event", async () => {
  const { controller, queue, notify } = fixture();
  const iterator = queue[Symbol.asyncIterator]();
  notify("error", { willRetry: true, error: { message: "temporary", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } } });
  const retry = (await iterator.next()).value;
  assert.equal(retry?.type, "turn.retrying");
  assert.equal(controller.hasActiveTurns(), true);
  notify("item/completed", { item: { type: "agentMessage", id: "f", text: "恢复后的最终答案" } });
  notify("turn/completed", { turn: { status: "completed" } });
  assert.equal((await collect(queue)).at(-1)?.type, "turn.completed");

  const fatal = fixture();
  fatal.notify("error", { willRetry: false, error: { message: "Reconnecting... 1/5" } });
  assert.equal((await collect(fatal.queue)).at(-1)?.type, "turn.failed");
});
