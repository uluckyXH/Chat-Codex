import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bridge } from "../../src/bridge/bridge.js";
import { PairingCodeManager } from "../../src/bridge/pairing-code-manager.js";
import { MockChannelAdapter } from "../../src/channels/mock/mock-channel-adapter.js";
import { MockCodexAdapter } from "../../src/codex/mock-codex-adapter.js";
import type { TranscriptSink } from "../../src/logging/transcript.js";
import type { ChannelMedia, ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";
import { FileStateStore } from "../../src/state/file-state-store.js";
import { MemoryStateStore } from "../../src/state/memory-state-store.js";

class CapturingTranscriptSink implements TranscriptSink {
  readonly inboundEvents: Array<{ message: ChannelMessage; text: string }> = [];
  readonly outboundEvents: Array<{ target: ChannelTarget; text: string }> = [];
  readonly localProgressEvents: Array<{ target: ChannelTarget; text: string }> = [];
  readonly outboundMediaEvents: Array<{ target: ChannelTarget; media: ChannelMedia }> = [];

  inbound(message: ChannelMessage, text: string): void {
    this.inboundEvents.push({ message, text });
  }

  outbound(target: ChannelTarget, text: string): void {
    this.outboundEvents.push({ target, text });
  }

  localProgress(target: ChannelTarget, text: string): void {
    this.localProgressEvents.push({ target, text });
  }

  outboundMedia(target: ChannelTarget, media: ChannelMedia): void {
    this.outboundMediaEvents.push({ target, media });
  }
}

test("Bridge blocks an untrusted Feishu direct chat until it sends the pairing code", async () => {
  const channel = new MockChannelAdapter({ id: "feishu", accountId: "default" });
  const codex = new MockCodexAdapter();
  const state = new MemoryStateStore();
  const transcript = new CapturingTranscriptSink();
  const bridge = new Bridge({
    channel,
    codex,
    state,
    transcript,
    routeTrustMode: "real_channels",
    pairingCodeManager: new PairingCodeManager({ codeGenerator: () => "ABC-123" }),
  });

  await bridge.start();
  await channel.emitText("你好", { senderId: "ou_a", conversationId: "oc_a" });
  await bridge.waitForIdle();

  assert.equal(codex.runs.length, 0);
  assert.equal(channel.sentMessages.length, 1);
  assert.match(channel.sentMessages[0].text, /还没有完成 Chat-Codex 配对/);
  assert.doesNotMatch(channel.sentMessages[0].text, /ABC-123/);
  assert.equal(state.isRouteTrusted("feishu:default:direct:oc_a"), false);
  assert.ok(transcript.localProgressEvents.some((event) => event.text.includes("配对码: ABC-123")));

  await channel.emitText("/status", { senderId: "ou_a", conversationId: "oc_a" });
  await bridge.waitForIdle();
  assert.equal(channel.sentMessages.length, 2);
  assert.match(channel.sentMessages[1].text, /终端\/TUI 日志/);

  await channel.emitText("/pair BAD-001", { senderId: "ou_a", conversationId: "oc_a" });
  assert.equal(channel.sentMessages.length, 3);
  assert.match(channel.sentMessages[2].text, /配对失败/);
  assert.doesNotMatch(channel.sentMessages[2].text, /ABC-123/);
  assert.equal(state.isRouteTrusted("feishu:default:direct:oc_a"), false);

  await channel.emitText("/pair abc123", { senderId: "ou_a", conversationId: "oc_a" });
  assert.equal(state.isRouteTrusted("feishu:default:direct:oc_a"), true);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("配对成功")));

  await channel.emitText("现在执行", { senderId: "ou_a", conversationId: "oc_a" });
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.runs.length, 1);
  assert.equal(codex.runs[0].prompt, "现在执行");
  assert.ok(channel.sentMessages.some((message) => message.text.includes("Mock Codex 回复: 现在执行")));
});

test("Bridge keeps Feishu pairing trust isolated by chat_id", async () => {
  const channel = new MockChannelAdapter({ id: "feishu", accountId: "default" });
  const codex = new MockCodexAdapter();
  const state = new MemoryStateStore();
  const bridge = new Bridge({
    channel,
    codex,
    state,
    routeTrustMode: "real_channels",
    pairingCodeManager: new PairingCodeManager({ codeGenerator: () => "FES-123" }),
  });

  await bridge.start();
  await channel.emitText("先触发 A", { senderId: "ou_a", conversationId: "oc_a" });
  await channel.emitText("/pair FES-123", { senderId: "ou_a", conversationId: "oc_a" });
  await channel.emitText("A 可以执行", { senderId: "ou_a", conversationId: "oc_a" });
  await bridge.waitForIdle();

  await channel.emitText("B 还不能执行", { senderId: "ou_b", conversationId: "oc_b" });
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(state.isRouteTrusted("feishu:default:direct:oc_a"), true);
  assert.equal(state.isRouteTrusted("feishu:default:direct:oc_b"), false);
  assert.deepEqual(codex.runs.map((run) => run.prompt), ["A 可以执行"]);
  assert.equal(channel.sentMessages.some((message) => message.text.includes("B 还不能执行")), false);
  assert.ok(channel.sentMessages.some((message) => message.target.conversation.id === "oc_b" && message.text.includes("还没有完成 Chat-Codex 配对")));
});

test("Bridge does not consume Weixin pending primary binding before route pairing", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-pairing-pending-"));
  const channelId = "weixin-main";
  const accountId = "wx";
  const routeKey = `${channelId}:${accountId}:direct:wx_user`;
  const codex = new MockCodexAdapter();
  const session = await codex.startSession({
    routeKey: "manual",
    cwd: "/tmp/work",
    title: "pending weixin session",
  });
  const state = new FileStateStore({ rootDir });
  state.setPendingBinding({
    id: "weixin-primary-weixin-main-wx",
    channelId,
    accountId,
    conversationKind: "direct",
    label: "微信 / wx / 主聊天",
    binding: { type: "existing", sessionId: session.id },
  });

  const channel = new MockChannelAdapter({ id: channelId, accountId });
  const bridge = new Bridge({
    channel,
    codex,
    state,
    routeTrustMode: "real_channels",
    pairingCodeManager: new PairingCodeManager({ codeGenerator: () => "WXA-234" }),
    cwd: "/tmp/work",
  });

  await bridge.start();
  await channel.emitText("未配对消息", { senderId: "wx_user", conversationId: "wx_user" });
  await bridge.waitForIdle();

  assert.equal(codex.runs.length, 0);
  assert.equal(state.isRouteTrusted(routeKey), false);
  assert.equal(state.listPendingBindings().length, 1);
  assert.equal(state.getSessionOwner(session.id)?.ownerRouteKey, "pending:weixin-primary-weixin-main-wx");
  assert.ok(channel.sentMessages.some((message) => message.text.includes("还没有完成 Chat-Codex 配对")));

  await channel.emitText("/pair WXA-234", { senderId: "wx_user", conversationId: "wx_user" });
  assert.equal(state.isRouteTrusted(routeKey), true);
  assert.equal(state.listPendingBindings().length, 1);

  await channel.emitText("现在使用预设 session", { senderId: "wx_user", conversationId: "wx_user" });
  await bridge.waitForIdle();
  await bridge.stop();

  const reloaded = new FileStateStore({ rootDir });
  assert.equal(codex.runs.at(-1)?.sessionId, session.id);
  assert.equal(reloaded.getBinding(routeKey)?.sessionId, session.id);
  assert.equal(reloaded.getSessionOwner(session.id)?.ownerRouteKey, routeKey);
  assert.equal(reloaded.listPendingBindings().length, 0);
});

test("Bridge requires pairing for historical route bindings and keeps the existing session after pairing", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-pairing-upgrade-"));
  const routeKey = "feishu:default:direct:oc_old";
  const codex = new MockCodexAdapter();
  const session = await codex.startSession({
    routeKey,
    cwd: "/tmp/work",
    title: "historical session",
  });
  const seedState = new FileStateStore({ rootDir });
  seedState.recordRouteMessage({
    id: "om_old",
    routeKey,
    channelId: "feishu",
    accountId: "default",
    sender: { id: "ou_old", displayName: "旧飞书用户" },
    conversation: { id: "oc_old", kind: "direct", displayName: "旧飞书私聊" },
    text: "旧消息",
    timestamp: "2026-05-16T00:00:00.000Z",
  });
  seedState.bindSession(routeKey, session);

  const channel = new MockChannelAdapter({ id: "feishu", accountId: "default" });
  const runtimeState = new FileStateStore({ rootDir });
  const bridge = new Bridge({
    channel,
    codex,
    state: runtimeState,
    routeTrustMode: "real_channels",
    pairingCodeManager: new PairingCodeManager({ codeGenerator: () => "OLD-456" }),
    cwd: "/tmp/work",
  });

  await bridge.start();
  await channel.emitText("未配对历史绑定不能执行", { senderId: "ou_old", conversationId: "oc_old" });
  await bridge.waitForIdle();
  assert.equal(codex.runs.length, 0);
  assert.equal(runtimeState.getBinding(routeKey)?.sessionId, session.id);
  assert.equal(runtimeState.isRouteTrusted(routeKey), false);

  await channel.emitText("/pair OLD-456", { senderId: "ou_old", conversationId: "oc_old" });
  await channel.emitText("继续已有会话", { senderId: "ou_old", conversationId: "oc_old" });
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.runs.length, 1);
  assert.equal(codex.runs[0].sessionId, session.id);
  assert.equal(codex.runs[0].prompt, "继续已有会话");
  assert.equal(new FileStateStore({ rootDir }).isRouteTrusted(routeKey), true);
});

test("Bridge restores trusted routes from FileStateStore after restart", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-pairing-restart-"));
  const codex = new MockCodexAdapter();
  const firstChannel = new MockChannelAdapter({ id: "feishu", accountId: "default" });
  const firstBridge = new Bridge({
    channel: firstChannel,
    codex,
    state: new FileStateStore({ rootDir }),
    routeTrustMode: "real_channels",
    pairingCodeManager: new PairingCodeManager({ codeGenerator: () => "RST-789" }),
    cwd: "/tmp/work",
  });

  await firstBridge.start();
  await firstChannel.emitText("触发配对", { senderId: "ou_restart", conversationId: "oc_restart" });
  await firstChannel.emitText("/pair RST-789", { senderId: "ou_restart", conversationId: "oc_restart" });
  await firstBridge.stop();
  assert.equal(codex.runs.length, 0);

  const secondChannel = new MockChannelAdapter({ id: "feishu", accountId: "default" });
  const secondBridge = new Bridge({
    channel: secondChannel,
    codex,
    state: new FileStateStore({ rootDir }),
    routeTrustMode: "real_channels",
    cwd: "/tmp/work",
  });

  await secondBridge.start();
  await secondChannel.emitText("重启后执行", { senderId: "ou_restart", conversationId: "oc_restart" });
  await secondBridge.waitForIdle();
  await secondBridge.stop();

  assert.equal(codex.runs.length, 1);
  assert.equal(codex.runs[0].prompt, "重启后执行");
});
