import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { BridgeCommentaryDelivery } from "../../src/bridge/commentary-delivery.js";
import { BridgeDelivery } from "../../src/bridge/delivery.js";
import { SilentLogger } from "../../src/logging/logger.js";
import type { TranscriptSink } from "../../src/logging/transcript.js";
import type { ChannelRegistry } from "../../src/channels/registry.js";
import type { ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";
import { DEFAULT_CHANNEL_DELIVERY_POLICY } from "../../src/protocol/delivery-policy.js";

class CapturingTranscript implements TranscriptSink {
  readonly observed: string[] = [];
  readonly local: string[] = [];

  inbound(_message: ChannelMessage, _text: string): void {
    // Not needed for this unit.
  }

  outbound(_target: ChannelTarget, _text: string): void {
    // BridgeDelivery owns outbound transcript coverage.
  }

  observedCommentary(_target: ChannelTarget, text: string): void {
    this.observed.push(text);
  }

  localCommentary(_target: ChannelTarget, text: string): void {
    this.local.push(text);
  }
}

test("BridgeCommentaryDelivery coalesces same-route commentary within interval", async () => {
  let now = 10_000;
  const fixture = commentaryFixture({
    now: () => now,
    minIntervalMs: 3000,
    shouldDeliverCommentary: () => true,
  });

  await fixture.commentary.handleCommentary({
    routeKey: "route",
    target: target(),
    policy: DEFAULT_CHANNEL_DELIVERY_POLICY,
    text: "第一段旁白。",
  });
  now += 100;
  await fixture.commentary.handleCommentary({
    routeKey: "route",
    target: target(),
    policy: DEFAULT_CHANNEL_DELIVERY_POLICY,
    text: "第二段旁白。",
  });

  assert.equal(fixture.sentTexts.length, 1);
  assert.deepEqual(fixture.transcript.observed, ["第一段旁白。", "第二段旁白。"]);
  const flushed = await fixture.commentary.flushRoute("route");
  assert.equal(flushed.delivered, true);
  assert.equal(fixture.sentTexts.length, 2);
  assert.match(fixture.sentTexts[1], /第二段旁白/);
});

test("BridgeCommentaryDelivery periodically flushes pending commentary while route is still running", async () => {
  const fixture = commentaryFixture({
    minIntervalMs: 5,
    shouldDeliverCommentary: () => true,
  });

  const first = await fixture.commentary.handleCommentary({
    routeKey: "route",
    target: target(),
    policy: DEFAULT_CHANNEL_DELIVERY_POLICY,
    text: "第一段旁白。",
  });
  const second = await fixture.commentary.handleCommentary({
    routeKey: "route",
    target: target(),
    policy: DEFAULT_CHANNEL_DELIVERY_POLICY,
    text: "第二段旁白。",
  });

  assert.equal(first.delivered, true);
  assert.equal(second.delivered, false);
  assert.equal(fixture.sentTexts.length, 1);
  await waitForTest(() => fixture.sentTexts.length === 2);
  assert.match(fixture.sentTexts[1] ?? "", /第二段旁白/);
  assert.deepEqual(fixture.transcript.observed, ["第一段旁白。", "第二段旁白。"]);
});

test("BridgeCommentaryDelivery records hidden commentary locally", async () => {
  const fixture = commentaryFixture({ shouldDeliverCommentary: () => false });

  const result = await fixture.commentary.handleCommentary({
    routeKey: "route",
    target: target(),
    policy: DEFAULT_CHANNEL_DELIVERY_POLICY,
    text: "silent 模式旁白。",
  });

  assert.equal(result.delivered, false);
  assert.deepEqual(fixture.sentTexts, []);
  assert.deepEqual(fixture.transcript.local, ["silent 模式旁白。"]);
});

test("BridgeCommentaryDelivery sends every commentary immediately in realtime mode", async () => {
  let now = 10_000;
  const fixture = commentaryFixture({
    now: () => now,
    minIntervalMs: 3000,
    shouldDeliverCommentary: () => true,
    isRealtimeCommentary: () => true,
  });

  await fixture.commentary.handleCommentary({
    routeKey: "route",
    target: target(),
    policy: DEFAULT_CHANNEL_DELIVERY_POLICY,
    text: "第一段旁白。",
  });
  now += 100;
  await fixture.commentary.handleCommentary({
    routeKey: "route",
    target: target(),
    policy: DEFAULT_CHANNEL_DELIVERY_POLICY,
    text: "第二段旁白。",
  });
  await fixture.commentary.flushRoute("route");

  assert.deepEqual(fixture.sentTexts, ["第一段旁白。", "第二段旁白。"]);
  assert.deepEqual(fixture.transcript.observed, ["第一段旁白。", "第二段旁白。"]);
});

test("brief retains all complete messages when more than three are pending", async (t) => {
  const f = commentaryFixture({ now: () => 10_000, minIntervalMs: 3000, shouldDeliverCommentary: () => true });
  t.after(() => f.commentary.clearAll());
  const texts = Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 条完整旁白。`);
  const receipts = [];
  for (const [i, text] of texts.entries()) receipts.push(await f.commentary.handleCommentary({
    routeKey: "route", target: target(), policy: DEFAULT_CHANNEL_DELIVERY_POLICY, text,
    sessionId: "session", turnId: "turn", itemId: `c-${i}`,
  }));
  assert.deepEqual(f.sentTexts, [texts[0]]);
  assert.deepEqual(receipts.map((receipt) => receipt.delivered), [true, false, false, false, false, false]);
  await f.commentary.flushRoute("route");
  assert.deepEqual(f.sentTexts, [texts[0], texts.slice(1).join("\n\n")]);
  assert.deepEqual(f.transcript.observed, texts);
  assert.ok(receipts.every((receipt) => receipt.delivered));
});

for (const mode of ["silent", "brief", "realtime"] as const) {
  test(`${mode} preserves long commentary and Markdown whitespace`, async (t) => {
    const f = commentaryFixture({ shouldDeliverCommentary: () => mode !== "silent", isRealtimeCommentary: () => mode === "realtime" });
    t.after(() => f.commentary.clearAll());
    const text = `    缩进代码\n${"完整正文。".repeat(300)}\n结尾不可丢。\n`;
    const receipt = await f.commentary.handleCommentary({ routeKey: "route", target: target(), policy: DEFAULT_CHANNEL_DELIVERY_POLICY, text });
    assert.equal(receipt.text, text);
    assert.deepEqual(mode === "silent" ? f.transcript.local : f.transcript.observed, [text]);
    assert.deepEqual(f.sentTexts, mode === "silent" ? [] : [text]);
  });

  test(`${mode} deduplicates item identity but preserves identical text in distinct items`, async (t) => {
    const f = commentaryFixture({ shouldDeliverCommentary: () => mode !== "silent", isRealtimeCommentary: () => mode === "realtime", now: () => 10_000 });
    t.after(() => f.commentary.clearAll());
    const input = { routeKey: "route", target: target(), policy: DEFAULT_CHANNEL_DELIVERY_POLICY, text: "确认。", sessionId: "s", turnId: "t", itemId: "a" };
    const first = await f.commentary.handleCommentary(input);
    const replay = await f.commentary.handleCommentary(input);
    assert.equal(replay, first);
    const second = await f.commentary.handleCommentary({ ...input, itemId: "b" });
    const nextTurn = await f.commentary.handleCommentary({ ...input, turnId: "other-turn" });
    const nextSession = await f.commentary.handleCommentary({ ...input, sessionId: "other-session" });
    assert.notEqual(second, first);
    await f.commentary.flushRoute("route");
    assert.deepEqual(mode === "silent" ? f.transcript.local : f.transcript.observed, Array(4).fill(input.text));
    if (mode !== "silent") assert.ok([first, second, nextTurn, nextSession].every((receipt) => receipt.delivered));
    assert.deepEqual(f.sentTexts, mode === "silent" ? [] : mode === "realtime" ? Array(4).fill(input.text) : [input.text, Array(3).fill(input.text).join("\n\n")]);
  });
}

test("commentary without item identity is not deduplicated by body text", async (t) => {
  const f = commentaryFixture({ shouldDeliverCommentary: () => true, now: () => 10_000 });
  t.after(() => f.commentary.clearAll());
  const input = { routeKey: "route", target: target(), policy: DEFAULT_CHANNEL_DELIVERY_POLICY, text: "确认。" };
  await f.commentary.handleCommentary(input);
  await f.commentary.handleCommentary(input);
  await f.commentary.flushRoute("route");
  assert.deepEqual(f.sentTexts, [input.text, input.text]);
});

test("a timed flush updates the same receipt and turn-end flush awaits its send", async (t) => {
  let releaseSend!: () => void;
  const sending = new Promise<void>((resolve) => { releaseSend = resolve; });
  const f = commentaryFixture({
    minIntervalMs: 5,
    shouldDeliverCommentary: () => true,
    onSend: async (text) => { if (text === "第二条完整旁白。") await sending; },
  });
  t.after(() => { releaseSend(); f.commentary.clearAll(); });
  const input = { routeKey: "route", target: target(), policy: DEFAULT_CHANNEL_DELIVERY_POLICY };
  await f.commentary.handleCommentary({ ...input, text: "第一条完整旁白。" });
  const last = await f.commentary.handleCommentary({ ...input, text: "第二条完整旁白。" });
  await waitForTest(() => f.sentTexts.length === 2);
  assert.equal(last.delivered, false);
  let flushed = false;
  const finishing = f.commentary.flushRoute("route").then(() => { flushed = true; });
  await Promise.resolve();
  assert.equal(flushed, false, "must not decide to resend while the timer send is still in flight");
  releaseSend();
  await finishing;
  assert.equal(last.delivered, true);
  assert.equal(f.sentTexts.length, 2);
});

test("failed sends leave the complete message receipt undelivered", async (t) => {
  const f = commentaryFixture({ shouldDeliverCommentary: () => true, onSend: async () => { throw new Error("simulated failure"); } });
  t.after(() => f.commentary.clearAll());
  const input = { routeKey: "route", target: target(), policy: DEFAULT_CHANNEL_DELIVERY_POLICY, text: "第一句。\n第二句。\n完整结尾。", itemId: "c", turnId: "t" };
  const receipt = await f.commentary.handleCommentary(input);
  assert.equal(receipt.delivered, false);
  assert.equal(receipt.text, input.text);
  assert.equal(await f.commentary.handleCommentary(input), receipt);
  assert.deepEqual(f.sentTexts, [input.text], "a duplicate completion must not retry a channel send");
});

test("clearing a route discards pending commentary and its item deduplication state", async () => {
  const f = commentaryFixture({ shouldDeliverCommentary: () => true, now: () => 10_000 });
  const input = { routeKey: "route", target: target(), policy: DEFAULT_CHANNEL_DELIVERY_POLICY, text: "第一条。", itemId: "c", turnId: "t" };
  await f.commentary.handleCommentary(input);
  await f.commentary.handleCommentary({ ...input, itemId: "pending", text: "已清理，不应发送。" });
  f.commentary.clearRoute("route");
  assert.equal((await f.commentary.flushRoute("route")).delivered, false);
  await f.commentary.handleCommentary(input);
  assert.deepEqual(f.sentTexts, [input.text, input.text]);
  f.commentary.clearAll();
});

test("a flush waiting on a send cannot revive pending commentary after route cleanup", async (t) => {
  let releaseSend!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseSend = resolve; });
  const f = commentaryFixture({ shouldDeliverCommentary: () => true, onSend: async () => blocked });
  t.after(() => { releaseSend(); f.commentary.clearAll(); });
  const input = { routeKey: "route", target: target(), policy: DEFAULT_CHANNEL_DELIVERY_POLICY };
  const first = f.commentary.handleCommentary({ ...input, text: "正在发送。" });
  const pending = await f.commentary.handleCommentary({ ...input, text: "清理后不可发送。" });
  const finishing = f.commentary.flushRoute("route");
  f.commentary.clearRoute("route");
  releaseSend();
  await first;
  await finishing;
  assert.deepEqual(f.sentTexts, ["正在发送。"]);
  assert.equal(pending.delivered, false);
});

function commentaryFixture(options: {
  shouldDeliverCommentary: ConstructorParameters<typeof BridgeCommentaryDelivery>[0]["shouldDeliverCommentary"];
  isRealtimeCommentary?: ConstructorParameters<typeof BridgeCommentaryDelivery>[0]["isRealtimeCommentary"];
  minIntervalMs?: number;
  now?: () => number;
  onSend?: (text: string) => Promise<void>;
}) {
  const sentTexts: string[] = [];
  const channels = {
    sendText: async (_target: ChannelTarget, text: string) => {
      sentTexts.push(text);
      await options.onSend?.(text);
      return { channelId: "mock", messageId: `m-${sentTexts.length}`, deliveredAt: new Date().toISOString() };
    },
    getCapabilities: () => ({
      text: true,
      media: false,
      typing: false,
      direct: true,
      group: false,
      thread: false,
      login: "none" as const,
      messageUpdate: false,
      streamingHint: false,
    }),
  } as unknown as ChannelRegistry;
  const transcript = new CapturingTranscript();
  const delivery = new BridgeDelivery({
    channels,
    approvals: new ApprovalManager(),
    logger: new SilentLogger(),
    transcript,
    approvalSendRetryDelayMs: 1,
  });
  const commentary = new BridgeCommentaryDelivery({
    delivery,
    transcript,
    minIntervalMs: options.minIntervalMs,
    now: options.now,
    shouldDeliverCommentary: options.shouldDeliverCommentary,
    isRealtimeCommentary: options.isRealtimeCommentary,
  });
  return { commentary, sentTexts, transcript };
}

function target(): ChannelTarget {
  return {
    channelId: "mock",
    routeKey: "route",
    conversation: { id: "route", kind: "direct" },
    recipient: { id: "user" },
  };
}

async function waitForTest(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("condition was not met");
}
