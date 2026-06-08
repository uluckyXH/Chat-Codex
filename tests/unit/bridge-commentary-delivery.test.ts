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

function commentaryFixture(options: {
  shouldDeliverCommentary: ConstructorParameters<typeof BridgeCommentaryDelivery>[0]["shouldDeliverCommentary"];
  isRealtimeCommentary?: ConstructorParameters<typeof BridgeCommentaryDelivery>[0]["isRealtimeCommentary"];
  minIntervalMs?: number;
  maxCommentaryChars?: number;
  now?: () => number;
}) {
  const sentTexts: string[] = [];
  const channels = {
    sendText: async (_target: ChannelTarget, text: string) => {
      sentTexts.push(text);
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
    maxCommentaryChars: options.maxCommentaryChars,
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
