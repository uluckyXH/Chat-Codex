import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { FeishuAdapter } from "../../src/channels/feishu/feishu-adapter.js";
import { FakeFeishuTransportFactory } from "../helpers/feishu-fakes.js";
import { downloadFeishuInboundAttachments } from "../../src/channels/feishu/feishu-media.js";
import type { ChannelMessage } from "../../src/protocol/channel.js";

const target = { channelId: "feishu", routeKey: "feishu:work:group:room", accountId: "work", conversation: { id: "room", kind: "group" as const }, recipient: { id: "ou_admin" }, context: { sourceMessageId: "m1" } };

test("Feishu rechecks file authorization after upload and before reply/create", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "group-send-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "report.txt"); fs.writeFileSync(file, "report");
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ appId: "cli_test", appSecret: "test", transportFactory: factory });
  await adapter.start(); t.after(() => adapter.stop());
  let allowed = true;
  const upload = factory.client.im.file.create;
  factory.client.im.file.create = async (payload) => { const result = await upload(payload); allowed = false; return result; };
  await assert.rejects(() => adapter.sendMedia(target, { type: "file", path: file }, { beforeSend() { if (!allowed) throw new Error("revoked"); } }), /revoked/);
  assert.equal(factory.client.fileCreatePayloads.length, 1);
  assert.equal(factory.client.replyPayloads.length, 0);
  assert.equal(factory.client.createPayloads.length, 0);
});

test("Feishu does not fallback to create after permission is revoked during failed reply", async (t) => {
  const factory = new FakeFeishuTransportFactory();
  const adapter = new FeishuAdapter({ appId: "cli_test", appSecret: "test", transportFactory: factory });
  await adapter.start(); t.after(() => adapter.stop());
  let allowed = true;
  factory.client.im.message.reply = async () => { allowed = false; throw new Error("reply failed"); };
  await assert.rejects(() => adapter.sendText(target, "guarded", { beforeSend() { if (!allowed) throw new Error("revoked"); } }), /revoked/);
  assert.equal(factory.client.createPayloads.length, 0);
});

test("group downloads stop before saving data or requesting the next resource after revocation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "group-receive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const factory = new FakeFeishuTransportFactory();
  factory.client.resourceBuffers.set("file_in", Buffer.from("report"));
  const message: ChannelMessage = { id: "m", routeKey: target.routeKey, channelId: "feishu", accountId: "work", conversation: target.conversation, sender: target.recipient, timestamp: new Date().toISOString(), attachments: [1, 2].map((i) => ({ id: String(i), type: "file", raw: { source: "feishu", fileKey: "file_in", resourceType: "file" } })) };
  const get = factory.client.im.messageResource.get;
  let allowed = true;
  factory.client.im.messageResource.get = async (payload) => { const result = await get(payload); allowed = false; return result; };
  await downloadFeishuInboundAttachments({ client: factory.client, message, rootDir: root, authorize: () => allowed });
  assert.equal(factory.client.messageResourceGetPayloads.length, 1);
  assert.equal(message.attachments?.[0]?.downloadState, "failed");
  assert.deepEqual(fs.readdirSync(root), []);
});
