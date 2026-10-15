import test from "node:test";
import assert from "node:assert/strict";
import type { CodexEvent } from "../../src/codex/types.js";
import { AppServerTurnController } from "../../src/codex/app-server/turn-controller.js";
import { AsyncEventQueue } from "../../src/codex/app-server/turn-store.js";

const fragments = ["我先检查 ", "1.", " 版本 ", "0.", "162.", "1", "，再看 `src/index", ".", "ts`。", "\n", "2.", " 然后核对接口 `https://example", ".", "invalid/a", "?", "x=1`。", "\n最后记录结论。"];
const fullText = fragments.join("");

class RecordingQueue extends AsyncEventQueue<CodexEvent> {
  readonly events: CodexEvent[] = [];
  override push(event: CodexEvent): void {
    this.events.push(event);
    super.push(event);
  }
}

function fixture() {
  const controller = new AppServerTurnController({ sessions: new Map(), threadToSession: new Map() });
  const queue = new RecordingQueue();
  controller.registerTurn("thread", "turn", queue);
  const notify = (method: string, params: Record<string, unknown>) => controller.handleNotification({ method, params: { threadId: "thread", turnId: "turn", ...params } });
  const start = (id: string, phase: string | undefined = "commentary") => notify("item/started", { item: { type: "agentMessage", id, text: "", phase } });
  const delta = (id: string, text: string) => notify("item/agentMessage/delta", { itemId: id, delta: text });
  const complete = (id: string, text: string, phase = "commentary") => notify("item/completed", { item: { type: "agentMessage", id, text, phase } });
  const commentary = () => queue.events.filter((event) => event.type === "assistant.commentary");
  return { controller, queue, notify, start, delta, complete, commentary };
}

for (const [name, chunks] of [
  ["one delta", [fullText]],
  ["punctuation, versions, paths, URLs and newlines", fragments],
  ["one character per delta", Array.from(fullText)],
  ["repeated sentences", ["确认。", "确认。", "继续。"]],
  ["400 character thresholds and long bodies", ["甲".repeat(400), "乙".repeat(400), "丙".repeat(500), "结尾"]],
  ["Markdown and whitespace", ["    缩进代码。\n", "\n```ts\n", "console.log('x');\n", "```\n"]],
] as const) {
  test(`commentary publishes one full item independently of ${name}`, async () => {
    const f = fixture();
    f.start("c");
    for (const chunk of chunks) f.delta("c", chunk);
    assert.equal(f.queue.events.length, 0, "no partial commentary may escape before item completion");
    f.complete("c", chunks.join(""));
    assert.equal(f.controller.hasActiveTurns(), true, "commentary must arrive before the task ends");
    assert.deepEqual(f.commentary(), [{ type: "assistant.commentary", sessionId: "thread", turnId: "turn", itemId: "c", text: chunks.join("") }]);
    f.notify("turn/completed", { turn: { status: "completed" } });
    assert.equal(f.queue.events.some((event) => event.type === "assistant.completed"), false);
    assert.equal(f.queue.events.at(-1)?.type, "turn.completed");
  });
}

test("commentary uses completion corrections, including replacement and an empty body", () => {
  for (const completedText of ["预告。完成时新增的补充正文。", "完全替换的正文。", ""]) {
    const f = fixture();
    f.start("c");
    f.delta("c", "预告。");
    f.complete("c", completedText);
    assert.deepEqual(f.commentary().map((event) => event.text), completedText ? [completedText] : []);
    f.controller.closeAll();
  }
});

test("commentary completion without a started event clears provisional final text", () => {
  for (const chunks of [fragments, []]) {
    const f = fixture();
    for (const chunk of chunks) f.delta("c", chunk);
    f.complete("c", fullText);
    f.notify("turn/completed", { turn: { status: "completed" } });
    assert.deepEqual(f.commentary().map((event) => event.text), [fullText]);
    assert.equal(f.controller.hasActiveTurns(), false);
    assert.equal(f.queue.events.filter((event) => event.type === "assistant.completed").at(-1)?.text ?? "", "");
  }
});

test("commentary deduplicates completed item identity and ignores replayed deltas", () => {
  const f = fixture();
  f.start("c");
  f.delta("c", "确认。");
  f.complete("c", "确认。");
  f.complete("c", "重复完成通知。");
  f.start("c");
  f.delta("c", "迟到的片段。");
  f.complete("other", "确认。");
  assert.deepEqual(f.commentary().map((event) => [event.itemId, event.text]), [["c", "确认。"], ["other", "确认。"]]);
  assert.equal(f.queue.events.length, 2);
  f.controller.closeAll();
});

test("interleaved commentary items stay separate and a final answer remains independent", () => {
  const f = fixture();
  f.start("a");
  f.start("b");
  f.delta("a", "甲。");
  f.delta("b", "乙。");
  f.delta("a", "甲后续。");
  f.complete("b", "乙。");
  f.complete("a", "甲。甲后续。");
  f.complete("final", "独立最终回复", "final_answer");
  f.notify("turn/completed", { turn: { status: "completed" } });
  assert.deepEqual(f.commentary().map((event) => [event.itemId, event.text]), [["b", "乙。"], ["a", "甲。甲后续。"]]);
  assert.ok(f.queue.events.filter((event) => event.type === "assistant.completed").every((event) => event.text === "独立最终回复"));
});

for (const status of ["completed", "interrupted", "failed"]) {
  test(`unfinished commentary is not published when a turn is ${status}`, () => {
    const f = fixture();
    f.start("c");
    for (const chunk of fragments) f.delta("c", chunk);
    f.notify("turn/completed", { turn: { status, error: { message: "失败原因" } } });
    f.complete("c", fullText);
    f.delta("c", "迟到片段。");
    assert.deepEqual(f.commentary(), []);
    assert.equal(f.queue.events.length, 1);
    assert.equal(f.queue.events[0]?.type, `turn.${status}`);
  });
}

test("transport failure does not flush an unfinished commentary as a complete message", () => {
  const f = fixture();
  f.start("c");
  f.delta("c", "尚未完成。\n后续");
  f.controller.failAll(new Error("断开连接"));
  assert.deepEqual(f.queue.events.map((event) => event.type), ["turn.failed"]);
});

test("legacy commentary without an item id is also held until completion", () => {
  const f = fixture();
  f.notify("item/started", { item: { type: "agentMessage", phase: "commentary", text: "" } });
  f.notify("item/agentMessage/delta", { delta: "旁白。\n正文。" });
  assert.equal(f.queue.events.length, 0);
  f.notify("item/completed", { item: { type: "agentMessage", phase: "commentary", text: "旁白。\n正文。" } });
  assert.deepEqual(f.commentary().map((event) => event.text), ["旁白。\n正文。"]);
  f.controller.closeAll();
});
