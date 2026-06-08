import test from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../../src/bridge/bridge.js";
import { FeishuAdapter } from "../../src/channels/feishu/feishu-adapter.js";
import { MockCodexAdapter } from "../../src/codex/mock-codex-adapter.js";
import type { CodexEvent } from "../../src/codex/types.js";
import { SilentLogger } from "../../src/logging/logger.js";
import { MemoryStateStore } from "../../src/state/memory-state-store.js";
import { FakeFeishuTransportFactory, sampleFeishuTextEvent } from "../helpers/feishu-fakes.js";

class FeishuProgressCodexAdapter extends MockCodexAdapter {
  override async *run(sessionId: string, prompt: string): AsyncIterable<CodexEvent> {
    const turnId = `feishu-turn-${prompt}`;
    yield { type: "turn.started", sessionId, turnId };
    yield { type: "assistant.progress", sessionId, turnId, kind: "reasoning", text: "正在分析飞书私聊消息。" };
    yield { type: "assistant.completed", sessionId, turnId, text: `完成: ${prompt}` };
    yield { type: "turn.completed", sessionId, turnId };
  }
}

class FeishuManyProgressCodexAdapter extends MockCodexAdapter {
  override async *run(sessionId: string, prompt: string): AsyncIterable<CodexEvent> {
    const turnId = `feishu-many-progress-turn-${prompt}`;
    yield { type: "turn.started", sessionId, turnId };
    yield { type: "assistant.progress", sessionId, turnId, kind: "reasoning", text: "飞书第一段进度。" };
    yield { type: "assistant.progress", sessionId, turnId, kind: "reasoning", text: "飞书第二段进度。" };
    yield { type: "assistant.progress", sessionId, turnId, kind: "reasoning", text: "飞书第三段进度。" };
    yield { type: "assistant.completed", sessionId, turnId, text: `完成: ${prompt}` };
    yield { type: "turn.completed", sessionId, turnId };
  }
}

class FeishuCommentaryCodexAdapter extends MockCodexAdapter {
  override async *run(sessionId: string, prompt: string): AsyncIterable<CodexEvent> {
    const turnId = `feishu-commentary-turn-${prompt}`;
    yield { type: "turn.started", sessionId, turnId };
    yield { type: "assistant.commentary", sessionId, turnId, text: "飞书旁白: 正在确认方案。" };
    yield { type: "assistant.completed", sessionId, turnId, text: `完成: ${prompt}` };
    yield { type: "turn.completed", sessionId, turnId };
  }
}

class FeishuManyCommentaryCodexAdapter extends MockCodexAdapter {
  override async *run(sessionId: string, prompt: string): AsyncIterable<CodexEvent> {
    const turnId = `feishu-many-commentary-turn-${prompt}`;
    yield { type: "turn.started", sessionId, turnId };
    yield { type: "assistant.commentary", sessionId, turnId, text: "飞书第一段旁白。" };
    yield { type: "assistant.commentary", sessionId, turnId, text: "飞书第二段旁白。" };
    yield { type: "assistant.commentary", sessionId, turnId, text: "飞书第三段旁白。" };
    yield { type: "assistant.completed", sessionId, turnId, text: `完成: ${prompt}` };
    yield { type: "turn.completed", sessionId, turnId };
  }
}

const credentials = {
  appId: "cli_1234567890abcdef",
  appSecret: "test-secret",
  accountId: "work",
};

test("Feishu private chat uses Bridge commands and default progress delivery", async () => {
  const factory = new FakeFeishuTransportFactory();
  const channel = new FeishuAdapter({ ...credentials, transportFactory: factory });
  const bridge = new Bridge({
    channel,
    codex: new FeishuProgressCodexAdapter(),
    logger: new SilentLogger(),
    cwd: process.cwd(),
  });

  await bridge.start();
  await factory.dispatcher.emitReceive(feishuInbound("/help", "om_help"));
  await factory.dispatcher.emitReceive(feishuInbound("请处理这个任务", "om_prompt"));
  await bridge.waitForIdle();
  await factory.dispatcher.emitReceive(feishuInbound("/status", "om_status"));
  await bridge.stop();

  const texts = factory.client.sentTexts();
  assert.ok(texts.some((text) => text.includes("**可用命令**") && text.includes("/status")));
  assert.ok(texts.some((text) => text.includes("`/progress [realtime|silent|brief]`")));
  assert.equal(texts.some((text) => text.includes("`detailed`")), false);
  assert.equal(texts.some((text) => text.includes("`tools`")), false);
  assert.ok(texts.some((text) => text.includes("/group on|off")));
  assert.equal(texts.some((text) => text.includes("/grop")), false);
  assert.ok(texts.some((text) => text.includes("Codex 正在处理这条消息。")));
  assert.ok(texts.some((text) => text.includes("正在分析飞书私聊消息。")));
  assert.equal(texts.some((text) => text.includes("Codex 进度:")), false);
  assert.ok(texts.some((text) => text.includes("完成: 请处理这个任务")));
  assert.ok(texts.some((text) => text.includes("**Codex 状态**") && text.includes("- 渠道: `feishu`")));
  assert.deepEqual(factory.client.reactionCreatePayloads.map((payload) => payload.path.message_id), ["om_prompt"]);
  assert.equal(factory.client.reactionCreatePayloads[0].data.reaction_type.emoji_type, "Typing");
  assert.deepEqual(factory.client.reactionDeletePayloads.map((payload) => payload.path), [{
    message_id: "om_prompt",
    reaction_id: "react_typing_1",
  }]);
});

test("Feishu private chat rejects detailed progress mode", async () => {
  const factory = new FakeFeishuTransportFactory();
  const channel = new FeishuAdapter({ ...credentials, transportFactory: factory });
  const bridge = new Bridge({
    channel,
    codex: new FeishuProgressCodexAdapter(),
    logger: new SilentLogger(),
    cwd: process.cwd(),
  });

  await bridge.start();
  await factory.dispatcher.emitReceive(feishuInbound("/progress detailed", "om_progress_detailed"));
  await bridge.stop();

  const texts = factory.client.sentTexts();
  assert.ok(texts.some((text) => text.includes("可用值: realtime, silent, brief")));
  assert.equal(texts.some((text) => text.includes("当前模式: `detailed`")), false);
});

test("Feishu private chat honors /progress silent through the shared Bridge", async () => {
  const factory = new FakeFeishuTransportFactory();
  const channel = new FeishuAdapter({ ...credentials, transportFactory: factory });
  const bridge = new Bridge({
    channel,
    codex: new FeishuProgressCodexAdapter(),
    logger: new SilentLogger(),
    cwd: process.cwd(),
  });

  await bridge.start();
  await factory.dispatcher.emitReceive(feishuInbound("/progress silent", "om_progress"));
  const beforePrompt = factory.client.sentTexts().length;
  await factory.dispatcher.emitReceive(feishuInbound("静默任务", "om_silent_prompt"));
  await bridge.waitForIdle();
  await bridge.stop();

  const textsAfterPrompt = factory.client.sentTexts().slice(beforePrompt);
  assert.ok(textsAfterPrompt.some((text) => text.includes("Codex 正在处理这条消息。")));
  assert.ok(textsAfterPrompt.some((text) => text.includes("完成: 静默任务")));
  assert.equal(textsAfterPrompt.some((text) => text.includes("Codex 进度:")), false);
});

test("Feishu private chat sends commentary in default brief mode", async () => {
  const factory = new FakeFeishuTransportFactory();
  const channel = new FeishuAdapter({ ...credentials, transportFactory: factory });
  const bridge = new Bridge({
    channel,
    codex: new FeishuCommentaryCodexAdapter(),
    logger: new SilentLogger(),
    cwd: process.cwd(),
  });

  await bridge.start();
  await factory.dispatcher.emitReceive(feishuInbound("旁白任务", "om_commentary_prompt"));
  await bridge.waitForIdle();
  await bridge.stop();

  const texts = factory.client.sentTexts();
  assert.ok(texts.some((text) => text.includes("飞书旁白: 正在确认方案。")));
  assert.ok(texts.some((text) => text.includes("完成: 旁白任务")));
});

test("Feishu private chat sends every text progress in realtime mode", async () => {
  const factory = new FakeFeishuTransportFactory();
  const channel = new FeishuAdapter({ ...credentials, transportFactory: factory });
  const bridge = new Bridge({
    channel,
    codex: new FeishuManyProgressCodexAdapter(),
    logger: new SilentLogger(),
    cwd: process.cwd(),
  });

  await bridge.start();
  await factory.dispatcher.emitReceive(feishuInbound("/progress realtime", "om_progress_realtime"));
  await factory.dispatcher.emitReceive(feishuInbound("实时任务", "om_realtime_prompt"));
  await bridge.waitForIdle();
  await bridge.stop();

  const texts = factory.client.sentTexts();
  const progressTexts = texts.filter((text) => text.includes("飞书") && text.includes("段进度。"));
  assert.ok(texts.some((text) => text.includes("当前模式: `realtime`")));
  assert.deepEqual(progressTexts, ["飞书第一段进度。", "飞书第二段进度。", "飞书第三段进度。"]);
});

test("Feishu private chat sends every commentary in realtime mode", async () => {
  const factory = new FakeFeishuTransportFactory();
  const channel = new FeishuAdapter({ ...credentials, transportFactory: factory });
  const bridge = new Bridge({
    channel,
    codex: new FeishuManyCommentaryCodexAdapter(),
    logger: new SilentLogger(),
    cwd: process.cwd(),
  });

  await bridge.start();
  await factory.dispatcher.emitReceive(feishuInbound("/progress realtime", "om_commentary_realtime"));
  await factory.dispatcher.emitReceive(feishuInbound("实时旁白任务", "om_commentary_realtime_prompt"));
  await bridge.waitForIdle();
  await bridge.stop();

  const texts = factory.client.sentTexts();
  const commentaryTexts = texts.filter((text) => text.includes("飞书") && text.includes("段旁白。"));
  assert.ok(texts.some((text) => text.includes("当前模式: `realtime`")));
  assert.deepEqual(commentaryTexts, ["飞书第一段旁白。", "飞书第二段旁白。", "飞书第三段旁白。"]);
});

test("Feishu trusted private chat can toggle group receive at runtime", async () => {
  const factory = new FakeFeishuTransportFactory();
  const channel = new FeishuAdapter({ ...credentials, transportFactory: factory });
  const state = new MemoryStateStore();
  state.trustRoute({
    routeKey: "feishu:work:direct:oc_private",
    channelId: "feishu",
    accountId: "work",
    conversationKind: "direct",
    conversationId: "oc_private",
    trustedAt: "2026-05-19T00:00:00.000Z",
    trustedBySenderId: "ou_user",
    trustMethod: "pairing_code",
    createdAt: "2026-05-19T00:00:00.000Z",
    updatedAt: "2026-05-19T00:00:00.000Z",
  });
  const bridge = new Bridge({
    channel,
    codex: new FeishuProgressCodexAdapter(),
    state,
    logger: new SilentLogger(),
    cwd: process.cwd(),
    channelCapabilities: {
      setGroupEnabled: (channelId, enabled) => {
        assert.equal(channelId, "feishu");
        channel.setGroupEnabled(enabled);
        return { ok: true, enabled };
      },
    },
  });

  await bridge.start();
  await factory.dispatcher.emitReceive(feishuInbound("/group on", "om_group_on"));
  assert.equal(channel.getCapabilities().group, true);
  await factory.dispatcher.emitReceive(feishuInbound("/grop off", "om_grop_off"));
  assert.equal(channel.getCapabilities().group, false);
  await bridge.stop();

  const texts = factory.client.sentTexts();
  assert.ok(texts.some((text) => text.includes("已开启飞书群聊接收")));
  assert.ok(texts.some((text) => text.includes("已关闭飞书群聊接收")));
});

function feishuInbound(text: string, messageId: string) {
  return sampleFeishuTextEvent({
    app_id: credentials.appId,
    message: {
      message_id: messageId,
      chat_id: "oc_private",
      content: JSON.stringify({ text }),
    },
  });
}
