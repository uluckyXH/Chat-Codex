import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bridge } from "../../src/bridge/bridge.js";
import { MockChannelAdapter } from "../../src/channels/mock/mock-channel-adapter.js";
import { MockCodexAdapter } from "../../src/codex/mock-codex-adapter.js";
import { SilentLogger } from "../../src/logging/logger.js";
import type { TranscriptSink } from "../../src/logging/transcript.js";
import type { ChannelMessage } from "../../src/protocol/channel.js";
import { FileStateStore } from "../../src/state/file-state-store.js";

test("Bridge restores route session binding from FileStateStore after restart", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-persist-"));
  const codex = new MockCodexAdapter();
  const firstChannel = new MockChannelAdapter({ id: "feishu-main", accountId: "default" });
  const firstBridge = new Bridge({
    channel: firstChannel,
    codex,
    state: new FileStateStore({ rootDir }),
    logger: new SilentLogger(),
    cwd: "/tmp/work",
  });

  await firstBridge.start();
  await firstChannel.emitText("第一次任务", { senderId: "ou_user", conversationId: "oc_user" });
  await firstBridge.waitForIdle();
  await firstBridge.stop();

  assert.equal(codex.runs.length, 1);
  const sessionId = codex.runs[0].sessionId;

  const secondChannel = new MockChannelAdapter({ id: "feishu-main", accountId: "default" });
  const secondBridge = new Bridge({
    channel: secondChannel,
    codex,
    state: new FileStateStore({ rootDir }),
    logger: new SilentLogger(),
    cwd: "/tmp/work",
  });

  await secondBridge.start();
  await secondChannel.emitText("第二次任务", { senderId: "ou_user", conversationId: "oc_user" });
  await secondBridge.waitForIdle();
  await secondBridge.stop();

  assert.equal(codex.runs.length, 2);
  assert.equal(codex.runs[1].sessionId, sessionId);
  assert.equal(fs.existsSync(path.join(rootDir, "routes.json")), true);
  assert.equal(fs.existsSync(path.join(rootDir, "session-owners.json")), true);
});

test("Bridge applies persisted session run policy when restoring a binding", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-policy-"));
  const routeKey = "feishu-main:default:direct:oc_user";
  const codex = new MockCodexAdapter();
  const session = await codex.startSession({
    routeKey,
    cwd: "/tmp/work",
    title: "persisted policy",
  });
  const state = new FileStateStore({ rootDir });
  state.recordRouteMessage({
    id: "om_message",
    routeKey,
    channelId: "feishu-main",
    accountId: "default",
    sender: { id: "ou_user", displayName: "飞书用户" },
    conversation: { id: "oc_user", kind: "direct", displayName: "飞书私聊" },
    text: "你好",
    timestamp: "2026-05-16T00:00:00.000Z",
  });
  state.bindSession(routeKey, session);
  state.setSessionRunPolicy(session.id, { permissionMode: "full" });

  const channel = new MockChannelAdapter({ id: "feishu-main", accountId: "default" });
  const bridge = new Bridge({
    channel,
    codex,
    state: new FileStateStore({ rootDir }),
    logger: new SilentLogger(),
    cwd: "/tmp/work",
  });

  await bridge.start();
  await channel.emitText("使用持久化权限", { senderId: "ou_user", conversationId: "oc_user" });
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.getRunPolicy(session.id).permissionMode, "full");
  assert.equal(codex.runs.at(-1)?.sessionId, session.id);
});

test("Bridge strips Feishu direct sender display names before runtime display", async () => {
  const codex = new MockCodexAdapter();
  const channel = new MockChannelAdapter({ id: "feishu-main", accountId: "default" });
  let inboundSenderDisplayName: string | undefined = "not-called";
  const transcript: TranscriptSink = {
    inbound: (message) => {
      inboundSenderDisplayName = message.sender.displayName;
    },
    outbound: () => undefined,
  };
  const bridge = new Bridge({
    channel,
    codex,
    state: new FileStateStore({ rootDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-feishu-name-")) }),
    logger: new SilentLogger(),
    transcript,
    cwd: "/tmp/work",
  });
  const message: ChannelMessage = {
    id: "om_named_direct",
    routeKey: "feishu-main:default:direct:oc_user",
    channelId: "feishu-main",
    accountId: "default",
    sender: { id: "ou_user", displayName: "张三" },
    conversation: { id: "oc_user", kind: "direct", displayName: "飞书私聊" },
    text: "你好",
    timestamp: "2026-05-20T00:00:00.000Z",
  };

  await bridge.handleMessage(message);
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(inboundSenderDisplayName, undefined);
  assert.equal(codex.runs[0]?.prompt, "你好");
});

test("Bridge consumes persisted Weixin pending binding on first private chat", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-pending-"));
  const channelId = "weixin-wx-account";
  const accountId = "wx-account";
  const codex = new MockCodexAdapter();
  const session = await codex.startSession({
    routeKey: "manual",
    cwd: "/tmp/work",
    title: "pending weixin session",
  });
  const state = new FileStateStore({ rootDir });
  state.setPendingBinding({
    id: "weixin-primary-weixin-wx-account-wx-account",
    channelId,
    accountId,
    conversationKind: "direct",
    label: "微信 / wx-account / 主聊天",
    binding: { type: "existing", sessionId: session.id },
  });

  const channel = new MockChannelAdapter({ id: channelId, accountId });
  const bridge = new Bridge({
    channel,
    codex,
    state: new FileStateStore({ rootDir }),
    logger: new SilentLogger(),
    cwd: "/tmp/work",
  });

  await bridge.start();
  await channel.emitText("使用预设 session", { senderId: "wx-user", conversationId: "wx-user" });
  await bridge.waitForIdle();
  await bridge.stop();

  const routeKey = `${channelId}:${accountId}:direct:wx-user`;
  const reloaded = new FileStateStore({ rootDir });
  assert.equal(codex.runs.at(-1)?.sessionId, session.id);
  assert.equal(reloaded.getBinding(routeKey)?.sessionId, session.id);
  assert.equal(reloaded.getSessionOwner(session.id)?.ownerRouteKey, routeKey);
  assert.equal(reloaded.listPendingBindings().length, 0);
});
