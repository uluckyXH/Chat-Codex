import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { BridgeDelivery } from "../../src/bridge/delivery.js";
import { BridgeProgressDelivery } from "../../src/bridge/progress-delivery.js";
import { SilentLogger } from "../../src/logging/logger.js";
import type { TranscriptSink } from "../../src/logging/transcript.js";
import type { ChannelRegistry } from "../../src/channels/registry.js";
import type { ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";
import { DEFAULT_CHANNEL_DELIVERY_POLICY } from "../../src/protocol/delivery-policy.js";

class CapturingTranscript implements TranscriptSink {
  readonly local: string[] = [];

  inbound(_message: ChannelMessage, _text: string): void {
    // Not needed for this unit.
  }

  outbound(_target: ChannelTarget, _text: string): void {
    // BridgeDelivery owns outbound transcript coverage.
  }

  localProgress(_target: ChannelTarget, text: string): void {
    this.local.push(text);
  }
}

test("BridgeProgressDelivery suppresses command progress in brief mode", async () => {
  const fixture = progressFixture({
    shouldDeliverProgress: (_policy, _routeKey, kind) => kind !== "command",
  });

  await fixture.progress.handleProgress({
    routeKey: "route",
    target: target(),
    policy: DEFAULT_CHANNEL_DELIVERY_POLICY,
    text: "正在分析...",
    kind: "reasoning",
  });
  await fixture.progress.handleProgress({
    routeKey: "route",
    target: target(),
    policy: DEFAULT_CHANNEL_DELIVERY_POLICY,
    text: "命令完成: npm test",
    kind: "command",
  });
  await fixture.progress.flushRoute("route");

  assert.equal(fixture.sentTexts.length, 1);
  assert.match(fixture.sentTexts[0], /正在分析/);
  assert.equal(fixture.sentTexts[0]?.includes("Codex 进度:"), false);
  assert.equal(fixture.sentTexts.some((text) => text.includes("命令完成")), false);
});

test("BridgeProgressDelivery coalesces same-route progress within interval", async () => {
  let now = 10_000;
  const fixture = progressFixture({
    now: () => now,
    minIntervalMs: 3000,
    shouldDeliverProgress: () => true,
  });

  await fixture.progress.handleProgress({
    routeKey: "route",
    target: target(),
    policy: DEFAULT_CHANNEL_DELIVERY_POLICY,
    text: "第一段进度。",
    kind: "reasoning",
  });
  now += 100;
  await fixture.progress.handleProgress({
    routeKey: "route",
    target: target(),
    policy: DEFAULT_CHANNEL_DELIVERY_POLICY,
    text: "第二段进度。",
    kind: "reasoning",
  });
  await fixture.progress.handleProgress({
    routeKey: "route",
    target: target(),
    policy: DEFAULT_CHANNEL_DELIVERY_POLICY,
    text: "第三段进度。",
    kind: "todo",
  });

  assert.equal(fixture.sentTexts.length, 1);
  await fixture.progress.flushRoute("route");
  assert.equal(fixture.sentTexts.length, 2);
  assert.match(fixture.sentTexts[1], /第二段进度/);
  assert.match(fixture.sentTexts[1], /第三段进度/);
});

test("BridgeProgressDelivery deduplicates repeated progress text", async () => {
  const fixture = progressFixture({ shouldDeliverProgress: () => true, minIntervalMs: 0 });

  await fixture.progress.handleProgress({
    routeKey: "route",
    target: target(),
    policy: DEFAULT_CHANNEL_DELIVERY_POLICY,
    text: "重复进度。",
    kind: "reasoning",
  });
  await fixture.progress.handleProgress({
    routeKey: "route",
    target: target(),
    policy: DEFAULT_CHANNEL_DELIVERY_POLICY,
    text: "重复进度。",
    kind: "reasoning",
  });

  assert.equal(fixture.sentTexts.length, 1);
});

test("BridgeProgressDelivery records suppressed channel progress locally", async () => {
  const fixture = progressFixture({ shouldDeliverProgress: () => true });
  const suppressPolicy = {
    ...DEFAULT_CHANNEL_DELIVERY_POLICY,
    progress: "suppress" as const,
  };

  await fixture.progress.handleProgress({
    routeKey: "route",
    target: target(),
    policy: suppressPolicy,
    text: "微信本地进度。",
    kind: "reasoning",
  });

  assert.deepEqual(fixture.sentTexts, []);
  assert.equal(fixture.transcript.local.length, 1);
  assert.match(fixture.transcript.local[0], /微信本地进度/);
});

test("BridgeProgressDelivery records progress hidden by route mode locally", async () => {
  const fixture = progressFixture({ shouldDeliverProgress: () => false });

  await fixture.progress.handleProgress({
    routeKey: "route",
    target: target(),
    policy: DEFAULT_CHANNEL_DELIVERY_POLICY,
    text: "silent 模式本地可见。",
    kind: "reasoning",
  });

  assert.deepEqual(fixture.sentTexts, []);
  assert.equal(fixture.transcript.local.length, 1);
  assert.match(fixture.transcript.local[0], /silent 模式本地可见/);
});

function progressFixture(options: {
  shouldDeliverProgress: ConstructorParameters<typeof BridgeProgressDelivery>[0]["shouldDeliverProgress"];
  minIntervalMs?: number;
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
  const progress = new BridgeProgressDelivery({
    delivery,
    transcript,
    minIntervalMs: options.minIntervalMs,
    now: options.now,
    shouldDeliverProgress: options.shouldDeliverProgress,
  });
  return { progress, sentTexts, transcript };
}

function target(): ChannelTarget {
  return {
    channelId: "mock",
    routeKey: "route",
    conversation: { id: "route", kind: "direct" },
    recipient: { id: "user" },
  };
}
