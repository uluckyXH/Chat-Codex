import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hydrateFeishuQuote } from "../../src/channels/feishu/feishu-quotes.js";
import { buildFeishuPostContent, feishuEventToChannelMessage, parseFeishuMessageContent } from "../../src/channels/feishu/feishu-message.js";
import { downloadFeishuInboundAttachments } from "../../src/channels/feishu/feishu-media.js";
import type { FeishuApiResponse, FeishuRetrievedMessage } from "../../src/channels/feishu/feishu-types.js";
import { FakeFeishuClient, sampleFeishuTextEvent } from "../helpers/feishu-fakes.js";

function message(parentId: string | undefined = "om_parent", group = false) {
  const mapped = feishuEventToChannelMessage(sampleFeishuTextEvent({ message: {
    parent_id: parentId, root_id: "om_root", chat_type: group ? "group" : "p2p",
    content: JSON.stringify({ text: "继续这个方案" }),
  } }), { channelId: "feishu", accountId: "work", now: Date.now() });
  assert.ok(mapped.ok);
  return mapped.message;
}

function parent(overrides: Partial<FeishuRetrievedMessage> = {}): FeishuRetrievedMessage {
  return { message_id: "om_parent", chat_id: "oc_direct", msg_type: "text", body: { content: JSON.stringify({ text: "原始方案" }) }, ...overrides };
}

test("Feishu maps only the direct parent as pending context in both private and group messages", () => {
  for (const group of [false, true]) {
    const mapped = message("om_parent", group);
    assert.equal(mapped.quotedMessage?.messageId, "om_parent");
    assert.equal(mapped.quoteDiagnostics?.fetch, "pending");
    assert.equal(mapped.text, "继续这个方案");
    assert.equal(message("", group).quotedMessage, undefined, "root_id alone is not a direct quote");
    assert.equal(message("om_in_1", group).quotedMessage, undefined, "self references are ignored");
  }
});

test("Feishu reads exactly the requested parent, preserves its full text and does not re-fetch a resolved quote", async () => {
  const client = new FakeFeishuClient();
  const original = "一段完整的设计🙂\n".repeat(2000);
  client.messageGetResponse = { code: 0, data: { items: [parent({ message_id: "unrelated" }), parent({ body: { content: JSON.stringify({ text: original }) } })] } };
  const input = message();
  await hydrateFeishuQuote({ client, message: input, authorize: () => true });
  await hydrateFeishuQuote({ client, message: input, authorize: () => true });
  assert.deepEqual(client.messageGetPayloads, [{ path: { message_id: "om_parent" }, params: { user_id_type: "open_id" } }]);
  assert.deepEqual(input.quotedMessage, { messageId: "om_parent", text: original });
  assert.equal(input.quoteDiagnostics?.source, "remote");
  assert.equal(input.quoteDiagnostics?.fetch, "success");
});

test("Feishu quote parsing preserves bot Markdown, post titles, paragraphs, links and mentions", async () => {
  const markdown = "**方案**\n\n```ts\nconst x = 1;\n```";
  assert.equal(parseFeishuMessageContent("post", buildFeishuPostContent(markdown)).text, markdown);
  const content = { title: "设计", content: [[{ tag: "text", text: "第一行" }], [{ tag: "md", text: "**第二行**" }], [{ tag: "a", text: "文档", href: "https://example.invalid/doc" }]] };
  for (const body of [content, { en_us: content }]) {
    assert.equal(parseFeishuMessageContent("post", JSON.stringify(body)).text, "设计\n第一行\n**第二行**\n文档 (https://example.invalid/doc)");
  }
  const client = new FakeFeishuClient();
  client.messageGetResponse = { code: 0, data: { items: [parent({ body: { content: '{"text":"@_user_1 的方案"}' }, mentions: [{ key: "@_user_1", name: "张三" }] })] } };
  const input = message();
  await hydrateFeishuQuote({ client, message: input, authorize: () => true });
  assert.equal(input.quotedMessage?.text, "@张三 的方案");
});

test("Feishu quote failures keep the reference ID and never copy remote error text or unrelated content", async () => {
  const cases: Array<[FeishuApiResponse<{ items?: FeishuRetrievedMessage[] }>, string]> = [
    [{ code: 99991672, msg: "private-token" }, "failed"],
    [{ code: 0, data: { items: [] } }, "missing"],
    [{ code: 0, data: { items: [parent({ message_id: "different" })] } }, "missing"],
    [{ code: 0, data: { items: [parent({ chat_id: "oc_other" })] } }, "chat-mismatch"],
    [{ code: 0, data: { items: [parent({ deleted: true })] } }, "deleted"],
    [{ code: 0, data: { items: [parent({ msg_type: "interactive" })] } }, "unsupported"],
    [{ code: 0, data: { items: [parent({ body: { content: "{}" } })] } }, "empty"],
  ];
  for (const [response, status] of cases) {
    const client = new FakeFeishuClient();
    client.messageGetResponse = response;
    const input = message();
    await hydrateFeishuQuote({ client, message: input, authorize: () => true });
    assert.equal(input.quotedMessage?.messageId, "om_parent");
    assert.equal(input.quoteDiagnostics?.fetch, status);
    assert.match(input.quotedMessage?.text ?? "", /请重新发送原文/);
    assert.doesNotMatch(JSON.stringify(input.quotedMessage), /原始方案|private-token/);
  }
  const client = new FakeFeishuClient();
  client.messageGetHandler = async () => { throw new Error("private-token"); };
  const input = message();
  await hydrateFeishuQuote({ client, message: input, authorize: () => true });
  assert.equal(input.quoteDiagnostics?.fetch, "failed");
  assert.doesNotMatch(input.quotedMessage?.text ?? "", /private-token/);
});

test("Feishu quoted media downloads use the parent ID and are not downloaded again during group hydration", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-quoted-media-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const client = new FakeFeishuClient();
  client.messageGetResponse = { code: 0, data: { items: [parent({ msg_type: "post", body: { content: JSON.stringify({ content: [[
    { tag: "text", text: "看这两个附件" }, { tag: "img", image_key: "img_quote" }, { tag: "file", file_key: "file_quote", file_name: "report.txt" },
  ]] }) } })] } };
  client.resourceBuffers.set("file_quote", Buffer.from("file contents"));
  const input = message();
  await hydrateFeishuQuote({ client, message: input, authorize: () => true, rootDir });
  await downloadFeishuInboundAttachments({ client, message: input, rootDir });
  assert.equal(input.attachments?.length, 2);
  assert.equal(client.messageResourceGetPayloads.length, 2);
  assert.ok(client.messageResourceGetPayloads.every((payload) => payload.path.message_id === "om_parent"));
  assert.equal(fs.readFileSync(input.attachments![1].localPath!, "utf8"), "file contents");
  assert.equal(input.quoteDiagnostics?.media, "available");
});

test("unavailable quoted media remains context without poisoning the current message's attachments", async () => {
  const client = new FakeFeishuClient();
  client.messageResourceError = new Error("private-token");
  client.messageGetResponse = { code: 0, data: { items: [parent({ msg_type: "file", body: { content: '{"file_key":"file_quote","file_name":"report.txt"}' } })] } };
  const input = message();
  await hydrateFeishuQuote({ client, message: input, authorize: () => true });
  assert.equal(input.attachments, undefined);
  assert.equal(input.quoteDiagnostics?.media, "unavailable");
  assert.match(input.quotedMessage?.text ?? "", /report.txt[\s\S]*引用附件无法取得/);
  assert.doesNotMatch(input.quotedMessage?.text ?? "", /private-token/);
});

test("Feishu quote authorization is checked before the request and again before consuming the result", async () => {
  const client = new FakeFeishuClient();
  let allowed = false;
  const input = message();
  await hydrateFeishuQuote({ client, message: input, authorize: () => allowed });
  assert.equal(client.messageGetPayloads.length, 0);
  allowed = true;
  client.messageGetHandler = async () => { allowed = false; return { code: 0, data: { items: [parent()] } }; };
  await hydrateFeishuQuote({ client, message: input, authorize: () => allowed });
  assert.equal(client.messageGetPayloads.length, 1);
  assert.equal(input.quoteDiagnostics?.fetch, "pending");
  assert.doesNotMatch(input.quotedMessage?.text ?? "", /原始方案/);
});

test("a timed-out parent lookup degrades once and ignores a late result", async () => {
  const client = new FakeFeishuClient();
  let release!: (result: FeishuApiResponse<{ items?: FeishuRetrievedMessage[] }>) => void;
  client.messageGetHandler = () => new Promise((resolve) => { release = resolve; });
  const input = message();
  await hydrateFeishuQuote({ client, message: input, authorize: () => true, timeoutMs: 5 });
  assert.equal(input.quoteDiagnostics?.fetch, "timeout");
  release({ code: 0, data: { items: [parent()] } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(input.quoteDiagnostics?.fetch, "timeout");
  assert.doesNotMatch(input.quotedMessage?.text ?? "", /原始方案/);
});
