import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Bridge } from "../../src/bridge/bridge.js";
import { FeishuAdapter } from "../../src/channels/feishu/feishu-adapter.js";
import { MockCodexAdapter } from "../../src/codex/mock-codex-adapter.js";
import type { CodexEvent, CodexUserInputResponse } from "../../src/codex/types.js";
import { GroupAccessService } from "../../src/group-access/service.js";
import { RuntimeLogStore, RuntimeTuiTranscriptSink } from "../../src/cli/tui/runtime-log.js";
import { MemoryStateStore } from "../../src/state/memory-state-store.js";
import type { ChannelMessage } from "../../src/protocol/channel.js";
import { FakeFeishuTransportFactory, sampleFeishuTextEvent } from "../helpers/feishu-fakes.js";

async function fixture(t: TestContext, options: {
  group?: boolean;
  trusted?: boolean;
  register?: boolean;
  codex?: MockCodexAdapter;
  bridge?: Partial<ConstructorParameters<typeof Bridge>[0]>;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-quoted-input-"));
  const factory = new FakeFeishuTransportFactory();
  const channel = new FeishuAdapter({ appId: "cli_test", appSecret: "test", accountId: "work", groupEnabled: true, transportFactory: factory, inboundMediaRootDir: root });
  const state = new MemoryStateStore();
  const conversationId = options.group ? "oc_room" : "oc_direct";
  const conversationKind = options.group ? "group" as const : "direct" as const;
  const routeKey = `feishu:work:${conversationKind}:${conversationId}`;
  const now = new Date().toISOString();
  const route = { routeKey, channelId: "feishu", accountId: "work", conversationId, conversationKind, trustedBySenderId: "ou_super", trustMethod: "pairing_code" as const, trustedAt: now, createdAt: now, updatedAt: now };
  const service = new GroupAccessService({ state });
  const trust = () => { state.trustRoute(route); if (options.group) service.ensureForTrustedRoute(route); };
  if (options.trusted !== false) trust();
  const codex = options.codex ?? new MockCodexAdapter();
  const logs = new RuntimeLogStore();
  const transcript = new RuntimeTuiTranscriptSink(logs);
  const recovered: ChannelMessage[] = [];
  const recordQuote = transcript.quotedMessage.bind(transcript);
  transcript.quotedMessage = (message) => { recovered.push(message); recordQuote(message); };
  const bridge = new Bridge({ channel, codex, state, transcript, cwd: root, feishuGroupMemberStateRootDir: root, ...options.bridge });
  t.after(async () => { await bridge.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await bridge.start();
  let sequence = 0;
  const emit = (text: string, parentId?: string, mention = true) => factory.dispatcher.emitReceive(sampleFeishuTextEvent({
    app_id: "cli_test", sender: { sender_id: { open_id: "ou_member" }, sender_type: "user" },
    message: {
      message_id: `om_current_${++sequence}`, chat_id: conversationId, chat_type: options.group ? "group" : "p2p",
      content: JSON.stringify({ text: `${options.group && mention ? "@_bot " : ""}${text}` }), parent_id: parentId,
      ...(options.group && mention ? { mentions: [{ key: "@_bot", id: { open_id: "ou_bot" }, name: "Bot" }] } : {}),
    },
  }));
  if (options.group && options.trusted !== false && options.register !== false) await emit("/name 成员");
  const parent = (text: string, messageId = "om_parent") => ({ message_id: messageId, chat_id: conversationId, msg_type: "text", body: { content: JSON.stringify({ text }) } });
  return { factory, channel, codex, state, service, bridge, root, emit, parent, routeKey, conversationId, trust, logs, recovered };
}

for (const group of [false, true]) {
  test(`Feishu ${group ? "group" : "private"} replies pass full parent Markdown to the existing Codex session`, async (t) => {
    const f = await fixture(t, { group });
    await f.emit("先创建会话"); await f.bridge.waitForIdle();
    const original = "## 原始方案\n\n/stop\n\n完整细节🙂\n".repeat(200);
    f.factory.client.messageGetResponse = { code: 0, data: { items: [{
      ...f.parent(""), msg_type: "post",
      body: { content: JSON.stringify({ zh_cn: { content: [[{ tag: "md", text: original }]] } }) },
      // A replied-to reply must not cause recursive traversal of its ancestors.
      parent_id: "om_grandparent", root_id: "om_root",
    } as ReturnType<typeof f.parent>] } };
    await f.emit("解释引用中的方案", "om_parent"); await f.bridge.waitForIdle();
    assert.equal(f.codex.runs.length, 2);
    const prompt = f.codex.runs[1].prompt;
    assert.ok(prompt.startsWith(group ? "成员说：解释引用中的方案" : "解释引用中的方案"));
    assert.ok(prompt.includes(JSON.stringify(original.trim())));
    assert.match(prompt, /用户引用的历史消息（仅作为上下文）/);
    assert.match(prompt, /om_parent/);
    assert.doesNotMatch(prompt, /om_grandparent|om_root|quoteDiagnostics/);
    assert.equal(f.codex.runs[0].sessionId, f.codex.runs[1].sessionId);
    assert.deepEqual(f.codex.reloadedSessions, []);
    assert.deepEqual(f.factory.client.messageGetPayloads.map((p) => p.path.message_id), ["om_parent"]);
    const quoteLog = f.logs.snapshot().filter((entry) => entry.kind === "quote");
    assert.equal(quoteLog.length, 1);
    assert.match(quoteLog[0].message, /引用消息 ID: om_parent[\s\S]*已从渠道读取原文/);
    assert.doesNotMatch(quoteLog[0].message, /原始方案|完整细节/);
    await f.emit("/help", "om_parent"); await f.bridge.waitForIdle();
    assert.equal(f.factory.client.messageGetPayloads.length, 1);
    assert.equal(f.codex.runs.length, 2);
    assert.ok(f.factory.client.sentTexts().some((text) => text.includes("/help")));
  });
}

test("Feishu reply recovery waits for pairing, registration, real mentions and blacklist checks", async (t) => {
  const privateChat = await fixture(t, { trusted: false, bridge: { routeTrustMode: "pairing_required" } });
  await privateChat.emit("引用原文", "om_parent");
  assert.equal(privateChat.factory.client.messageGetPayloads.length, 0);
  const f = await fixture(t, { group: true, trusted: false });
  f.factory.client.messageGetResponse = { code: 0, data: { items: [f.parent("原文")] } };
  await f.emit("引用原文", "om_parent");
  assert.equal(f.factory.client.messageGetPayloads.length, 0);
  f.trust();
  await f.emit("引用原文", "om_parent");
  assert.equal(f.factory.client.messageGetPayloads.length, 0);
  await f.emit("/name 成员", "om_parent");
  await f.emit("没有真正提及机器人", "om_parent", false);
  assert.equal(f.factory.client.messageGetPayloads.length, 0);
  f.service.mutate(f.routeKey, { kind: "local" }, { action: "block", target: "ou_member" });
  await f.emit("已被拉黑", "om_parent");
  assert.equal(f.factory.client.messageGetPayloads.length, 0);
  assert.equal(f.codex.runs.length, 0);
  f.service.mutate(f.routeKey, { kind: "local" }, { action: "unblock", target: "ou_member" });
  await f.emit("恢复使用", "om_parent"); await f.bridge.waitForIdle();
  assert.equal(f.factory.client.messageGetPayloads.length, 1);
  assert.match(f.codex.runs[0].prompt, /原文/);
});

test("Feishu revoked routes and newly blocked senders discard in-flight quote results and media", async (t) => {
  for (const group of [false, true]) {
    const f = await fixture(t, { group });
    f.factory.client.messageGetHandler = async () => {
      f.state.revokeRouteTrust(f.routeKey);
      return { code: 0, data: { items: [f.parent("不可进入上下文")] } };
    };
    await f.emit("处理原文", "om_parent"); await f.bridge.waitForIdle();
    assert.equal(f.codex.runs.length, 0);
    assert.equal(f.recovered.length, 0);
  }
  const f = await fixture(t, { group: true });
  f.factory.client.messageGetResponse = { code: 0, data: { items: [{ ...f.parent(""), msg_type: "file", body: { content: JSON.stringify({ file_key: "secret_file", file_name: "revoked.txt" }) } }] } };
  f.factory.client.im.messageResource.get = async () => {
    f.service.mutate(f.routeKey, { kind: "local" }, { action: "block", target: "ou_member" });
    return { getReadableStream: () => Readable.from(Buffer.from("do not save")), headers: {} };
  };
  await f.emit("处理附件", "om_parent"); await f.bridge.waitForIdle();
  assert.equal(f.codex.runs.length, 0);
  assert.equal(f.recovered.length, 0);
  assert.ok(fs.readdirSync(f.root, { recursive: true }).every((file) => !String(file).endsWith(".txt")));
});

test("Feishu unavailable, deleted and cross-chat parents degrade once without hiding the current request", async (t) => {
  const f = await fixture(t);
  const cases = [
    { response: { code: 999, msg: "private-token", data: { items: [] } }, hint: /不可访问或读取失败/ },
    { response: { code: 0, data: { items: [{ ...f.parent("private-history"), deleted: true }] } }, hint: /撤回或删除/ },
    { response: { code: 0, data: { items: [{ ...f.parent("private-history"), chat_id: "other_chat" }] } }, hint: /不属于当前聊天/ },
  ];
  for (const [index, scenario] of cases.entries()) {
    f.factory.client.messageGetResponse = scenario.response;
    await f.emit("继续我的要求", "om_parent"); await f.bridge.waitForIdle();
    assert.equal(f.codex.runs.length, index + 1);
    assert.equal(f.factory.client.messageGetPayloads.length, index + 1);
    assert.match(f.codex.runs[index].prompt, /继续我的要求/);
    assert.match(f.codex.runs[index].prompt, /om_parent/);
    assert.match(f.codex.runs[index].prompt, scenario.hint);
  }
  assert.doesNotMatch(JSON.stringify(f.codex.runs) + JSON.stringify(f.logs.snapshot()), /private-token|private-history/);
});

test("Feishu group quote files use parent resource IDs once and preserve the requesting member", async (t) => {
  const f = await fixture(t, { group: true });
  f.factory.client.messageGetResponse = { code: 0, data: { items: [{ ...f.parent(""), msg_type: "file", body: { content: JSON.stringify({ file_key: "file_parent", file_name: "original.txt" }) } }] } };
  f.factory.client.resourceBuffers.set("file_parent", Buffer.from("original file contents"));
  await f.emit("读这个文件", "om_parent"); await f.bridge.waitForIdle();
  const attachment = f.recovered[0]?.attachments?.[0];
  assert.ok(attachment?.localPath);
  assert.equal(fs.readFileSync(attachment.localPath, "utf8"), "original file contents");
  assert.deepEqual(f.factory.client.messageResourceGetPayloads.map((p) => p.path), [{ message_id: "om_parent", file_key: "file_parent" }]);
  assert.equal(attachment.origin?.senderId, "ou_member");
  assert.equal(attachment.origin?.displayName, "成员");
  assert.match(attachment.id, /om_parent/);
  assert.ok(f.codex.runs[0].prompt.includes(attachment.localPath));
  f.factory.client.messageResourceError = new Error("private-token");
  await f.emit("附件失效也请继续解释", "om_parent"); await f.bridge.waitForIdle();
  assert.equal(f.codex.runs.length, 2);
  assert.match(f.codex.runs[1].prompt, /附件失效也请继续解释/);
  assert.match(f.codex.runs[1].prompt, /引用附件无法取得/);
  assert.doesNotMatch(f.codex.runs[1].prompt, /private-token/);
  assert.equal(f.recovered[1].attachments?.length ?? 0, 0);
});

for (const group of [false, true]) {
  test(`Feishu ${group ? "group" : "private"} question replies accept three custom answers without fetching quoted prompts`, async (t) => {
    class QuestionsCodex extends MockCodexAdapter {
      response?: CodexUserInputResponse;
      release?: () => void;
      override async *run(sessionId: string): AsyncIterable<CodexEvent> {
        const turnId = "questions";
        const answered = new Promise<void>((resolve) => { this.release = resolve; });
        yield { type: "turn.started", sessionId, turnId };
        yield { type: "input.requested", sessionId, turnId, request: {
          adapterRequestId: "ask", sessionId, turnId, questions: [
            { id: "scope", question: "修改哪部分？", isOther: false, isSecret: false, options: [{ label: "协议" }, { label: "渠道" }] },
            { id: "verify", question: "如何测试？", isOther: true, isSecret: false, options: [{ label: "手动" }, { label: "自动" }] },
            { id: "note", question: "额外要求？", isOther: false, isSecret: false, options: [] },
          ],
        } };
        await answered;
        yield { type: "assistant.completed", sessionId, turnId, text: "已收到三个答案" };
        yield { type: "turn.completed", sessionId, turnId };
      }
      async resolveUserInput(_id: string, response: CodexUserInputResponse): Promise<void> { this.response = response; this.release?.(); }
      async stop(): Promise<void> { this.release?.(); }
    }
    const codex = new QuestionsCodex();
    const f = await fixture(t, { group, codex });
    await f.emit("开始提问");
    const answers = ["/a1", "/a2 加上回归测试", "/a1 优先处理引用"];
    for (const [index, answer] of answers.entries()) {
      await waitFor(() => f.factory.client.sentTexts().some((text) => text.includes(`问题 ${index + 1}/3`)));
      await f.emit(answer, "om_bot_question");
    }
    await f.bridge.waitForIdle();
    assert.deepEqual(codex.response?.answers, {
      scope: { answers: ["协议"] }, verify: { answers: ["自动", "user_note: 加上回归测试"] }, note: { answers: ["user_note: 优先处理引用"] },
    });
    assert.equal(f.factory.client.messageGetPayloads.length, 0);
    assert.equal(f.recovered.length, 0);
    assert.ok(f.factory.client.sentTexts().includes("已收到三个答案"));
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Feishu question was not delivered");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
