import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { WeixinAdapter, type WeixinAdapterOptions } from "../../src/channels/weixin/weixin-adapter.js";
import { FileWeixinAccountStore } from "../../src/channels/weixin/weixin-account-store.js";
import type { ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";
import type { FetchLike } from "../../src/channels/weixin/weixin-api.js";
import { Bridge } from "../../src/bridge/bridge.js";
import { MockCodexAdapter } from "../../src/codex/mock-codex-adapter.js";
import type { CodexEvent, CodexUserInputResponse } from "../../src/codex/types.js";
import { RuntimeLogStore, RuntimeTuiTranscriptSink } from "../../src/cli/tui/runtime-log.js";

function makeFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-quote-protocol-"));
  const store = new FileWeixinAccountStore(path.join(root, "state"));
  store.saveAccount({ accountId: "bot", token: "fake", baseUrl: "https://example.invalid", savedAt: "now" });
  const packets: string[] = [];
  const received: ChannelMessage[] = [];
  const sends: unknown[] = [];
  const urls: string[] = [];
  const adapters: WeixinAdapter[] = [];
  let sendSequence = 0;
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("getupdates")) {
      const packet = packets.shift();
      if (packet) return new Response(packet);
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException("aborted", "AbortError"));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (url.includes("sendmessage")) {
      sends.push(JSON.parse(String(init?.body)));
      sendSequence++;
      return new Response(`{"ret":0,"message_id":${18446744073709551000n + BigInt(sendSequence)}}`);
    }
    if (url.includes("getuploadurl")) return Response.json({ upload_full_url: "https://cdn.example/upload" });
    if (url === "https://cdn.example/upload") return new Response("", { headers: { "x-encrypted-param": "fake-param" } });
    if (url === "https://cdn.example/file") return new Response("file contents", { headers: { "Content-Type": "text/plain" } });
    return Response.json(url.includes("getconfig") ? { typing_ticket: "fake-ticket" } : {});
  };
  const create = (overrides: Partial<WeixinAdapterOptions> = {}) => {
    const adapter = new WeixinAdapter({ id: "wx", accountId: "bot", store, apiOptions: { fetch }, inboundMediaRootDir: path.join(root, "uploads"), outboundMinIntervalMs: 0, outboundMaxRetries: 0, ...overrides });
    adapter.onMessage(async (message) => { received.push(message); });
    adapters.push(adapter);
    return adapter;
  };
  t.after(async () => { for (const adapter of adapters) await adapter.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const target: ChannelTarget = { channelId: "wx", accountId: "bot", routeKey: "wx:bot:direct:user", conversation: { id: "user", kind: "direct" }, recipient: { id: "user" }, context: { contextToken: "ctx" } };
  return { root, store, packets, received, sends, urls, create, target, fetch };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

test("Weixin preserves wire IDs and restores received and sent text references after restart", async (t) => {
  const f = makeFixture(t);
  f.packets.push('{"ret":0,"msgs":[{"message_id":18446744073709551615,"from_user_id":"user","item_list":[{"type":1,"text_item":{"text":"原始消息"}}]}]}');
  const first = f.create();
  await first.start();
  await waitFor(() => f.received.length === 1);
  const sent = await first.sendText(f.target, "助手回复");
  assert.equal(sent.serverMessageId, "18446744073709551001");
  assert.match(sent.messageId, /^codex-weixin-/);
  await first.stop();
  f.packets.push(`{"ret":0,"msgs":[
    {"message_id":100,"from_user_id":"user","item_list":[{"type":1,"text_item":{"text":"解释这个"},"ref_msg":{"svr_id":18446744073709551615}}]},
    {"message_id":101,"from_user_id":"user","item_list":[{"type":1,"text_item":{"text":"继续"},"ref_msg":{"svr_id":18446744073709551001}}]},
    {"message_id":102,"from_user_id":"other","item_list":[{"type":1,"text_item":{"text":"引用"},"ref_msg":{"svr_id":18446744073709551001}}]}
  ]}`);
  await f.create().start();
  await waitFor(() => f.received.length === 4);
  assert.equal(f.received[0].id, "18446744073709551615");
  assert.equal(f.received[1].text, "解释这个");
  assert.equal(f.received[1].quotedMessage?.text, "原始消息");
  assert.equal(f.received[2].quotedMessage?.text, "助手回复");
  assert.match(f.received[3].quotedMessage?.text ?? "", /缓存未命中/);
  assert.match(f.received[3].quotedMessage?.text ?? "", /无法确认是否过期/);
  assert.deepEqual(f.received[2].quoteDiagnostics, { source: "cache", cache: "hit", selection: "none", media: "none" });
  assert.deepEqual(f.received[3].quoteDiagnostics, { source: "unavailable", cache: "miss", selection: "none", media: "none" });
});

test("Weixin restores inline, incoming and outgoing quoted files into independent active uploads", async (t) => {
  const f = makeFixture(t);
  const fileItem = { type: 4, msg_id: "file-item", file_item: { file_name: "report.txt", media: { full_url: "https://cdn.example/file", encrypt_type: 0 } } };
  f.packets.push(JSON.stringify({ msgs: [{ message_id: "10", from_user_id: "user", item_list: [fileItem] }] }));
  const first = f.create();
  await first.start();
  await waitFor(() => f.received.length === 1);
  const original = f.received[0].attachments?.[0]?.localPath;
  assert.ok(original);
  const outbound = path.join(f.root, "outbound.txt");
  fs.writeFileSync(outbound, "outbound contents");
  const sent = await first.sendMedia(f.target, { type: "file", path: outbound, name: "outbound.txt", caption: "附件说明" });
  assert.equal(sent.serverMessageId, "18446744073709551002");
  await first.sendTyping(f.target, true);
  await first.stop();
  fs.rmSync(original);
  fs.rmSync(outbound);
  f.packets.push(JSON.stringify({ msgs: [
    { message_id: "11", from_user_id: "user", item_list: [{ type: 1, text_item: { text: "查看收到的附件" }, ref_msg: { svr_id: "10" } }] },
    { message_id: "12", from_user_id: "user", item_list: [{ type: 1, text_item: { text: "查看发出的附件" }, ref_msg: { svr_id: sent.serverMessageId } }] },
    { message_id: "13", from_user_id: "user", item_list: [{ type: 1, text_item: { text: "旧版引用" }, ref_msg: { message_item: fileItem } }] },
  ] }));
  await f.create().start();
  await waitFor(() => f.received.length === 4);
  for (const [index, expected] of [[1, "file contents"], [2, "outbound contents"], [3, "file contents"]] as const) {
    const attachment = f.received[index].attachments?.[0];
    assert.ok(attachment?.localPath);
    assert.equal(attachment.downloadState, "available");
    assert.equal(attachment.caption, "引用附件");
    assert.equal(fs.readFileSync(attachment.localPath, "utf8"), expected);
    assert.ok(attachment.localPath.startsWith(path.join(f.root, "uploads")));
  }
  assert.equal(f.sends.length, 2);
  const cgi = f.urls.filter((url) => url.includes("/ilink/bot/"));
  assert.ok(cgi.every((url) => url.startsWith("https://example.invalid/")), "authenticated CGI calls must use the account's returned base URL");
  for (const endpoint of ["getupdates", "sendmessage", "getuploadurl", "getconfig", "sendtyping", "notifystart", "notifystop"]) {
    assert.ok(cgi.some((url) => url.endsWith(endpoint)), `missing ${endpoint}`);
  }
});

test("Weixin cache failures never turn successful deliveries into retries", async (t) => {
  const f = makeFixture(t);
  const blocked = path.join(f.root, "unwritable-cache");
  fs.writeFileSync(blocked, "not a directory");
  const adapter = f.create({ stateDir: blocked });
  const sent = await adapter.sendText(f.target, "正常发送");
  assert.equal(sent.serverMessageId, "18446744073709551001");
  assert.equal(f.sends.length, 1);
  assert.equal((await adapter.getStatus()).state, "connected");
  assert.equal((await adapter.getStatus()).details?.quoteCache, "unavailable");
});

test("Weixin diagnoses partial recovery, missing originals and unavailable quoted media", async (t) => {
  const f = makeFixture(t);
  const body = "甲开头，中间🙂，结尾乙";
  const selected = "开头，中间🙂，结尾";
  const partial = { start: "开头", end: "结尾", startindex: 0, endindex: 0, quotemd5: createHash("md5").update(selected).digest("hex") };
  const refs = [
    { svr_id: "original", partial_text: partial },
    { svr_id: "original", partial_text: { ...partial, quotemd5: "mismatch" } },
    { svr_id: "unknown", partial_text: partial },
    { title: body, partial_text: partial },
    {},
    { message_item: { type: 4, file_item: { file_name: "missing.txt" } } },
    { svr_id: "empty", partial_text: partial },
  ];
  f.packets.push(JSON.stringify({ msgs: [
    { message_id: "original", from_user_id: "user", item_list: [{ type: 1, text_item: { text: body } }] },
    { message_id: "empty", from_user_id: "user", item_list: [] },
    ...refs.map((ref_msg, index) => ({ message_id: `reply-${index}`, from_user_id: "user", item_list: [{ type: 1, text_item: { text: "解释" }, ref_msg }] })),
  ] }));
  await f.create().start();
  await waitFor(() => f.received.length === 9);
  assert.deepEqual(f.received.slice(2).map((m) => m.quoteDiagnostics), [
    { source: "cache", cache: "hit", selection: "restored", media: "none" },
    { source: "cache", cache: "hit", selection: "fallback", media: "none" },
    { source: "unavailable", cache: "miss", selection: "unavailable", media: "none" },
    { source: "inline", cache: "not-needed", selection: "restored", media: "none" },
    { source: "unavailable", cache: "missing-id", selection: "none", media: "none" },
    { source: "inline", cache: "not-needed", selection: "none", media: "unavailable" },
    { source: "unavailable", cache: "hit", selection: "unavailable", media: "none" },
  ]);
  assert.equal(f.received[2].quotedMessage?.selectedText, selected);
  assert.equal(f.received[3].quotedMessage?.selectedText, undefined);
  assert.equal(f.received[3].quotedMessage?.text, body);
  assert.match(f.received[8].quotedMessage?.text ?? "", /缓存没有可用正文/);
});

test("Weixin reports disabled, unconfigured and broken caches without claiming expiry or blocking messages", async (t) => {
  const f = makeFixture(t);
  const blocked = path.join(f.root, "blocked");
  fs.writeFileSync(blocked, "not a directory");
  const customStore = {
    listAccountIds: () => f.store.listAccountIds(), loadAccount: (id: string) => f.store.loadAccount(id),
    saveAccount: f.store.saveAccount.bind(f.store), getDefaultAccount: () => f.store.getDefaultAccount(),
    saveGetUpdatesBuf: f.store.saveGetUpdatesBuf.bind(f.store),
  };
  const cases = [
    { options: { quoteCache: { enabled: false } }, status: "disabled", hint: /未启用/ },
    { options: { stateDir: blocked }, status: "unavailable", hint: /不可用或读取失败/ },
    { options: { store: customStore }, status: "not-configured", hint: /未配置引用缓存目录/ },
  ];
  for (const [index, scenario] of cases.entries()) {
    f.packets.push(JSON.stringify({ msgs: [{ message_id: `${index}`, from_user_id: "user", item_list: [{ type: 1, text_item: { text: "继续" }, ref_msg: { svr_id: "old" } }] }] }));
    const adapter = f.create(scenario.options);
    await adapter.start();
    await waitFor(() => f.received.length === index + 1);
    assert.equal(f.received[index].quoteDiagnostics?.cache, scenario.status);
    assert.match(f.received[index].quotedMessage?.text ?? "", scenario.hint);
    assert.doesNotMatch(f.received[index].quotedMessage?.text ?? "", /过期/);
    assert.equal((await adapter.getStatus()).state, "connected");
    await adapter.stop();
  }
});

test("Weixin HTTP replies and later references share receipt IDs in the Bridge transcript", async (t) => {
  const f = makeFixture(t);
  const logs = new RuntimeLogStore();
  const codex = new MockCodexAdapter();
  const adapter = f.create();
  const bridge = new Bridge({ channel: adapter, codex, cwd: process.cwd(), transcript: new RuntimeTuiTranscriptSink(logs) });
  t.after(() => bridge.stop());
  f.packets.push(JSON.stringify({ msgs: [{ message_id: "first", from_user_id: "user", item_list: [{ type: 1, text_item: { text: "记录方案" } }] }] }));
  await bridge.start();
  await waitFor(() => logs.snapshot().some((entry) => entry.kind === "outbound"));
  await bridge.waitForIdle();
  const receipt = logs.snapshot().find((entry) => entry.kind === "outbound")?.message.match(/服务端消息 ID: (\d+)/)?.[1];
  assert.ok(receipt);
  // Restart the HTTP poller to pick up this fixture's next queued response.
  await adapter.stop();
  f.packets.push(JSON.stringify({ msgs: [{ message_id: "second", from_user_id: "user", context_token: "private-token", item_list: [{ type: 1, text_item: { text: "解释引用" }, ref_msg: { svr_id: receipt } }] }] }));
  await adapter.start();
  await waitFor(() => logs.snapshot().some((entry) => entry.kind === "inbound" && entry.message.includes("解释引用")));
  await bridge.waitForIdle();
  const inbound = logs.snapshot().find((entry) => entry.kind === "inbound" && entry.message.includes("解释引用"))!;
  assert.ok(inbound.message.includes(`引用消息 ID: ${receipt}`));
  assert.match(inbound.message, /本地缓存命中/);
  assert.match(codex.runs.at(-1)?.prompt ?? "", /用户引用的历史消息/);
  assert.doesNotMatch(codex.runs.at(-1)?.prompt ?? "", /quoteDiagnostics/);
  assert.doesNotMatch(JSON.stringify(logs.snapshot()), /private-token/);
});

test("Weixin HTTP receive/send completes three Codex questions with custom text under silent progress", async (t) => {
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
  const f = makeFixture(t);
  const texts = () => f.sends.flatMap((body) => (body as { msg?: { item_list?: Array<{ text_item?: { text?: string } }> } }).msg?.item_list ?? []).map((item) => item.text_item?.text ?? "");
  let step = 0;
  const answers = ["发起任务", "/a1", "/a2 先保留配置", "/a1 我希望先完成协议适配"];
  const fetch: FetchLike = async (input, init) => {
    if (String(input).includes("getupdates") && step < answers.length) {
      const current = step++;
      if (current > 0) await waitFor(() => texts().some((text) => text.includes(`问题 ${current}/3`)));
      return Response.json({ msgs: [{ message_id: String(100 + current), from_user_id: "user", context_token: "ctx", item_list: [{ type: 1, text_item: { text: answers[current] }, ...(current === 3 ? { ref_msg: { message_item: { type: 1, text_item: { text: "/stop 不应进入回答" } } } } : {}) }] }] });
    }
    return f.fetch(input, init);
  };
  const channel = f.create({ apiOptions: { fetch } });
  const codex = new QuestionsCodex();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });
  t.after(async () => { codex.release?.(); await bridge.stop(); });
  await bridge.start();
  await waitFor(() => texts().includes("已收到三个答案"));
  await bridge.waitForIdle();
  assert.deepEqual(codex.response?.answers, {
    scope: { answers: ["协议"] }, verify: { answers: ["自动", "user_note: 先保留配置"] }, note: { answers: ["user_note: 我希望先完成协议适配"] },
  });
  assert.equal(texts().filter((text) => text.includes("问题 ")).length, 3);
});
