import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { BridgeDelivery } from "../../src/bridge/delivery.js";
import { BRIDGE_SEND_FILE_PREFIX } from "../../src/bridge/media-extractor.js";
import { SilentLogger, type Logger } from "../../src/logging/logger.js";
import type { ChannelRegistry } from "../../src/channels/registry.js";
import type { ChannelMedia, ChannelTarget } from "../../src/protocol/channel.js";

class CapturingLogger implements Logger {
  readonly infos: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  readonly warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  readonly debugs: Array<{ message: string; meta?: Record<string, unknown> }> = [];

  error(): void {}

  debug(message: string, meta?: Record<string, unknown>): void {
    this.debugs.push({ message, meta });
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.infos.push({ message, meta });
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.warnings.push({ message, meta });
  }
}

test("BridgeDelivery swallows normal text send failures", async () => {
  const fixture = deliveryFixture({ failText: true });
  await fixture.delivery.sendText(target(), "hello");
  assert.equal(fixture.textAttempts, 1);
  assert.deepEqual(fixture.sentTexts, []);
});

test("BridgeDelivery logs target details when channel text delivery fails", async () => {
  const logger = new CapturingLogger();
  const delivery = new BridgeDelivery({
    channels: {
      sendText: async () => {
        throw new Error("sendmessage failed: ret=-2 errcode=0");
      },
    } as unknown as ChannelRegistry,
    approvals: new ApprovalManager(),
    logger,
    approvalSendRetryDelayMs: 1,
  });

  await delivery.sendText({
    channelId: "weixin",
    routeKey: "weixin:abc:direct:user",
    accountId: "abc",
    conversation: { id: "user", kind: "direct" },
    recipient: { id: "user" },
  }, "hello");

  assert.equal(logger.warnings.length, 1);
  assert.equal(logger.warnings[0]?.message, "channel text send failed");
  assert.deepEqual(logger.warnings[0]?.meta, {
    channel: "weixin",
    routeKey: "weixin:abc:direct:user",
    account: "abc",
    conversationKind: "direct",
    conversationId: "user",
    error: "sendmessage failed: ret=-2 errcode=0",
  });
});

test("BridgeDelivery suppresses progress briefly after a progress send failure", async () => {
  const fixture = deliveryFixture({ failText: true });
  await fixture.delivery.sendProgressText("route", target(), "progress 1");
  await fixture.delivery.sendProgressText("route", target(), "progress 2");
  assert.equal(fixture.textAttempts, 1);
  assert.deepEqual(fixture.sentTexts, []);
});

test("BridgeDelivery keeps successful progress quiet and records failed progress locally", async () => {
  const successLogger = new CapturingLogger();
  const successTranscript = new CapturingTranscript();
  const successDelivery = new BridgeDelivery({
    channels: {
      sendText: async () => ({ channelId: "weixin", messageId: "ok", deliveredAt: new Date().toISOString() }),
    } as unknown as ChannelRegistry,
    approvals: new ApprovalManager(),
    logger: successLogger,
    transcript: successTranscript,
    approvalSendRetryDelayMs: 1,
  });

  const weixinTarget = {
    channelId: "weixin",
    routeKey: "weixin:abc:direct:user",
    accountId: "abc",
    conversation: { id: "user", kind: "direct" as const },
    recipient: { id: "user" },
  };
  await successDelivery.sendProgressText(weixinTarget.routeKey, weixinTarget, "正在执行命令: npm test");
  assert.equal(successLogger.infos.length, 0);
  assert.equal(successLogger.debugs.length, 0);
  assert.deepEqual(successTranscript.outboundProgressEvents.map((event) => event.text), ["正在执行命令: npm test"]);

  const failureLogger = new CapturingLogger();
  const failureTranscript = new CapturingTranscript();
  const failureDelivery = new BridgeDelivery({
    channels: {
      sendText: async () => {
        throw new Error("sendmessage failed: ret=-2 errcode=0");
      },
    } as unknown as ChannelRegistry,
    approvals: new ApprovalManager(),
    logger: failureLogger,
    transcript: failureTranscript,
    approvalSendRetryDelayMs: 1,
  });

  await failureDelivery.sendProgressText(weixinTarget.routeKey, weixinTarget, "正在执行命令: npm test");
  assert.equal(failureLogger.debugs.length, 0);
  assert.equal(failureLogger.infos.length, 0);
  assert.equal(failureLogger.warnings[0]?.message, "progress message send failed");
  assert.equal(failureLogger.warnings[0]?.meta?.error, "sendmessage failed: ret=-2 errcode=0");
  assert.equal(failureLogger.warnings[0]?.meta?.routeKey, weixinTarget.routeKey);
  assert.equal(failureTranscript.localProgressEvents.length, 1);
  assert.match(failureTranscript.localProgressEvents[0]?.text ?? "", /发送失败，未投递到聊天渠道/);
  assert.match(failureTranscript.localProgressEvents[0]?.text ?? "", /正在执行命令: npm test/);
  assert.doesNotMatch(failureTranscript.localProgressEvents[0]?.text ?? "", /Codex 进度:/);
  assert.match(failureTranscript.localProgressEvents[0]?.text ?? "", /错误: sendmessage failed: ret=-2 errcode=0/);

  await failureDelivery.sendProgressText(weixinTarget.routeKey, weixinTarget, "后续进度");
  assert.equal(failureTranscript.localProgressEvents.length, 2);
  assert.match(failureTranscript.localProgressEvents[1]?.text ?? "", /发送暂缓，未投递到聊天渠道/);
  assert.match(failureTranscript.localProgressEvents[1]?.text ?? "", /上次错误: sendmessage failed: ret=-2 errcode=0/);
  assert.match(failureTranscript.localProgressEvents[1]?.text ?? "", /后续进度/);
  assert.doesNotMatch(failureTranscript.localProgressEvents[1]?.text ?? "", /Codex 进度:/);
});

test("BridgeDelivery keeps successful tool progress diagnostics quiet", async () => {
  const logger = new CapturingLogger();
  const delivery = new BridgeDelivery({
    channels: {
      sendToolProgress: async () => ({ channelId: "weixin", messageId: "tool-ok", deliveredAt: new Date().toISOString() }),
    } as unknown as ChannelRegistry,
    approvals: new ApprovalManager(),
    logger,
    approvalSendRetryDelayMs: 1,
  });
  const weixinTarget = {
    channelId: "weixin",
    routeKey: "weixin:abc:direct:user",
    accountId: "abc",
    conversation: { id: "user", kind: "direct" as const },
    recipient: { id: "user" },
  };

  await delivery.sendToolProgress(weixinTarget.routeKey, weixinTarget, {
    phase: "end",
    toolName: "web_search",
    toolCallId: "search-1",
    status: "completed",
  });

  assert.equal(logger.infos.length, 0);
  assert.equal(logger.debugs.length, 0);
});

test("BridgeDelivery records failed tool progress details locally", async () => {
  const logger = new CapturingLogger();
  const transcript = new CapturingTranscript();
  const delivery = new BridgeDelivery({
    channels: {
      sendToolProgress: async () => {
        throw new Error("sendmessage failed: ret=-2 errcode=0");
      },
    } as unknown as ChannelRegistry,
    approvals: new ApprovalManager(),
    logger,
    transcript,
    approvalSendRetryDelayMs: 1,
  });
  const weixinTarget = {
    channelId: "weixin",
    routeKey: "weixin:abc:direct:user",
    accountId: "abc",
    conversation: { id: "user", kind: "direct" as const },
    recipient: { id: "user" },
  };

  await delivery.sendToolProgress(weixinTarget.routeKey, weixinTarget, {
    phase: "end",
    toolName: "command: npm test",
    toolCallId: "cmd-1",
    status: "completed",
  });

  assert.equal(logger.warnings[0]?.message, "tool progress send failed");
  assert.equal(logger.warnings[0]?.meta?.error, "sendmessage failed: ret=-2 errcode=0");
  assert.equal(transcript.localProgressEvents.length, 1);
  assert.match(transcript.localProgressEvents[0]?.text ?? "", /工具进度发送失败，未投递到聊天渠道/);
  assert.match(transcript.localProgressEvents[0]?.text ?? "", /工具: command: npm test/);
  assert.match(transcript.localProgressEvents[0]?.text ?? "", /阶段: 结束/);
  assert.match(transcript.localProgressEvents[0]?.text ?? "", /状态: completed/);
  assert.match(transcript.localProgressEvents[0]?.text ?? "", /调用 ID: cmd-1/);
  assert.match(transcript.localProgressEvents[0]?.text ?? "", /错误: sendmessage failed: ret=-2 errcode=0/);

  await delivery.sendToolProgress(weixinTarget.routeKey, weixinTarget, {
    phase: "start",
    toolName: "web_search",
    toolCallId: "search-1",
  });

  assert.equal(transcript.localProgressEvents.length, 2);
  assert.match(transcript.localProgressEvents[1]?.text ?? "", /工具进度发送暂缓，未投递到聊天渠道/);
  assert.match(transcript.localProgressEvents[1]?.text ?? "", /上次错误: sendmessage failed: ret=-2 errcode=0/);
  assert.match(transcript.localProgressEvents[1]?.text ?? "", /工具: web_search/);
  assert.match(transcript.localProgressEvents[1]?.text ?? "", /阶段: 开始/);
  assert.match(transcript.localProgressEvents[1]?.text ?? "", /调用 ID: search-1/);
});

test("BridgeDelivery keeps text progress delivery independent from tool progress failures", async () => {
  const logger = new CapturingLogger();
  const transcript = new CapturingTranscript();
  const sentTexts: string[] = [];
  const delivery = new BridgeDelivery({
    channels: {
      sendText: async (_target: ChannelTarget, text: string) => {
        sentTexts.push(text);
        return { channelId: "weixin", messageId: "text-ok", deliveredAt: new Date().toISOString() };
      },
      sendToolProgress: async () => {
        throw new Error("tool progress unsupported by weixin server");
      },
    } as unknown as ChannelRegistry,
    approvals: new ApprovalManager(),
    logger,
    transcript,
    approvalSendRetryDelayMs: 1,
  });
  const weixinTarget = {
    channelId: "weixin",
    routeKey: "weixin:abc:direct:user",
    accountId: "abc",
    conversation: { id: "user", kind: "direct" as const },
    recipient: { id: "user" },
  };

  await delivery.sendToolProgress(weixinTarget.routeKey, weixinTarget, {
    phase: "start",
    toolName: "command: npm test",
    toolCallId: "cmd-1",
  });
  await delivery.sendProgressText(weixinTarget.routeKey, weixinTarget, "文件变更完成: src/a.ts");

  assert.equal(logger.warnings[0]?.message, "tool progress send failed");
  assert.deepEqual(sentTexts, ["文件变更完成: src/a.ts"]);
  assert.deepEqual(transcript.outboundProgressEvents.map((event) => event.text), ["文件变更完成: src/a.ts"]);
  assert.equal(transcript.localProgressEvents.length, 1);
  assert.match(transcript.localProgressEvents[0]?.text ?? "", /工具进度发送失败/);
});

class CapturingTranscript {
  readonly outboundEvents: Array<{ target: ChannelTarget; text: string }> = [];
  readonly outboundProgressEvents: Array<{ target: ChannelTarget; text: string }> = [];
  readonly localProgressEvents: Array<{ target: ChannelTarget; text: string }> = [];

  inbound(): void {}

  outbound(target: ChannelTarget, text: string): void {
    this.outboundEvents.push({ target, text });
  }

  outboundProgress(target: ChannelTarget, text: string): void {
    this.outboundProgressEvents.push({ target, text });
  }

  localProgress(target: ChannelTarget, text: string): void {
    this.localProgressEvents.push({ target, text });
  }
}

test("BridgeDelivery sends requested files through channel media", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-delivery-test-"));
  const filePath = path.join(root, "result.txt");
  fs.writeFileSync(filePath, "ok");
  const fixture = deliveryFixture({ media: true });

  await fixture.delivery.sendRequestedFiles(target(), `${BRIDGE_SEND_FILE_PREFIX} ${filePath}`, root);

  assert.equal(fixture.sentMedia.length, 1);
  assert.equal(fixture.sentMedia[0]?.path, filePath);
});

test("BridgeDelivery toggles typing around an operation", async () => {
  const fixture = deliveryFixture({ typing: true });
  await fixture.delivery.withTyping(target(), async () => {
    fixture.events.push("operation");
  });
  assert.deepEqual(fixture.typingEvents, [true, false]);
  assert.deepEqual(fixture.events, ["operation"]);
});

function deliveryFixture(options: { failText?: boolean; media?: boolean; typing?: boolean } = {}) {
  const sentTexts: string[] = [];
  const sentMedia: ChannelMedia[] = [];
  const typingEvents: boolean[] = [];
  const events: string[] = [];
  let textAttempts = 0;
  const channels = {
    sendText: async (_target: ChannelTarget, text: string) => {
      textAttempts += 1;
      if (options.failText) throw new Error("send failed");
      sentTexts.push(text);
      return { channelId: "mock", messageId: `text-${sentTexts.length}`, deliveredAt: new Date().toISOString() };
    },
    sendMedia: async (_target: ChannelTarget, media: ChannelMedia) => {
      sentMedia.push(media);
      return { channelId: "mock", messageId: `media-${sentMedia.length}`, deliveredAt: new Date().toISOString() };
    },
    sendTyping: async (_target: ChannelTarget, typing: boolean) => {
      typingEvents.push(typing);
    },
    getCapabilities: () => ({
      text: true,
      media: options.media ?? false,
      typing: options.typing ?? false,
      direct: true,
      group: false,
      thread: false,
      login: "none" as const,
      messageUpdate: false,
      streamingHint: false,
    }),
  } as unknown as ChannelRegistry;
  const delivery = new BridgeDelivery({
    channels,
    approvals: new ApprovalManager(),
    logger: new SilentLogger(),
    approvalSendRetryDelayMs: 1,
  });
  return {
    delivery,
    sentTexts,
    sentMedia,
    typingEvents,
    events,
    get textAttempts() {
      return textAttempts;
    },
  };
}

function target(): ChannelTarget {
  return {
    channelId: "mock",
    routeKey: "route",
    conversation: { id: "user", kind: "direct" },
    recipient: { id: "user" },
  };
}
