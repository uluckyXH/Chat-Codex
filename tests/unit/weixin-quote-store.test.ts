import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WeixinQuoteStore, weixinQuoteAccountDir } from "../../src/channels/weixin/weixin-quote-store.js";
import { FileWeixinAccountStore } from "../../src/channels/weixin/weixin-account-store.js";
import type { ChannelAttachment } from "../../src/protocol/channel.js";

test("quote store survives restart and isolates channels, accounts and conversations", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-quotes-"));
  const first = new WeixinQuoteStore({ rootDir, channelId: "one" });
  const second = new WeixinQuoteStore({ rootDir, channelId: "two" });
  const reopened = new WeixinQuoteStore({ rootDir, channelId: "one" });
  t.after(async () => { await first.close(); await second.close(); await reopened.close(); fs.rmSync(rootDir, { recursive: true, force: true }); });
  await first.put("account-a", "user-a", "18446744073709551615", "第一份正文");
  await first.put("account-a", "user-b", "18446744073709551615", "另一会话");
  await first.put("account-b", "user-a", "18446744073709551615", "另一账号");
  await first.close();
  assert.equal((await reopened.find("account-a", "user-a", "18446744073709551615"))?.text, "第一份正文");
  assert.equal((await reopened.find("account-a", "user-b", "18446744073709551615"))?.text, "另一会话");
  assert.equal((await reopened.find("account-b", "user-a", "18446744073709551615"))?.text, "另一账号");
  assert.equal(await second.find("account-a", "user-a", "18446744073709551615"), undefined);
  assert.equal((await second.lookup("account-a", "user-a", "18446744073709551615")).status, "miss");
  assert.equal((await reopened.lookup("account-a", "user-a", "18446744073709551615")).status, "hit");
  // Replayed inbound IDs cannot overwrite the original history.
  await reopened.put("account-a", "user-a", "18446744073709551615", "重放正文");
  assert.equal((await reopened.find("account-a", "user-a", "18446744073709551615"))?.text, "第一份正文");
});

test("quote cache bounds message count, age and media bytes and never deletes original files", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-quote-retention-"));
  const original = path.join(rootDir, "original.txt");
  fs.writeFileSync(original, "abcd");
  let now = 1000;
  const store = new WeixinQuoteStore({ rootDir, channelId: "one", now: () => now, policy: { maxMessages: 2, retentionMs: 100, mediaRetentionMs: 50, maxMediaBytes: 6, maxSingleMediaBytes: 4 } });
  t.after(async () => { await store.close(); fs.rmSync(rootDir, { recursive: true, force: true }); });
  const attachment: ChannelAttachment = { id: "file", type: "file", name: "original.txt", localPath: original, downloadState: "available" };
  await store.put("a", "u", "1", "第一份", [attachment]);
  const copy = (await store.find("a", "u", "1"))?.attachments[0]?.localPath;
  assert.ok(copy);
  assert.notEqual(copy, original);
  assert.equal(fs.readFileSync(copy, "utf8"), "abcd");
  now++;
  await store.put("a", "u", "2", "第二份", [attachment]);
  assert.equal((await store.find("a", "u", "1"))?.mediaExpired, true);
  assert.equal(fs.existsSync(copy), false);
  assert.equal((await store.find("a", "u", "2"))?.attachments.length, 1);
  now++;
  await store.put("a", "u", "3", "第三份");
  assert.equal(await store.find("a", "u", "1"), undefined);
  now += 51;
  await store.collect();
  assert.equal((await store.find("a", "u", "2"))?.mediaExpired, true);
  now += 100;
  await store.collect();
  assert.equal(await store.find("a", "u", "3"), undefined);
  assert.equal((await store.lookup("a", "u", "3")).status, "miss", "pruned records do not prove a reason for a miss");
  assert.equal(fs.readFileSync(original, "utf8"), "abcd");
});

test("quote cache skips oversized media, handles missing copies and keeps secrets out of metadata", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-quote-media-"));
  const original = path.join(rootDir, "original.txt");
  fs.writeFileSync(original, "abcd");
  const store = new WeixinQuoteStore({ rootDir, channelId: "one", policy: { maxSingleMediaBytes: 4 } });
  t.after(async () => { await store.close(); fs.rmSync(rootDir, { recursive: true, force: true }); });
  const attachment: ChannelAttachment = { id: "f", type: "file", localPath: original, downloadState: "available", raw: { aes_key: "secret-key" }, url: "https://cdn.example/?token=secret-token" };
  await store.put("a", "u", "1", "body", [attachment]);
  const copy = (await store.find("a", "u", "1"))?.attachments[0]?.localPath;
  assert.ok(copy);
  fs.rmSync(copy);
  assert.equal((await store.find("a", "u", "1"))?.mediaExpired, true);
  fs.writeFileSync(original, "too big");
  await store.put("a", "u", "2", "body", [attachment]);
  assert.equal((await store.find("a", "u", "2"))?.attachments.length, 0);
  await store.close();
  const accountDir = weixinQuoteAccountDir(rootDir, "a");
  const database = path.join(accountDir, fs.readdirSync(accountDir)[0], "messages.sqlite");
  const contents = fs.readFileSync(database).toString("utf8");
  assert.equal(contents.includes("secret-key"), false);
  assert.equal(contents.includes("secret-token"), false);
  assert.equal(contents.includes(original), false);
});

test("disabled and unavailable quote stores do not fail ordinary delivery", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-quote-unavailable-"));
  const errors: unknown[] = [];
  const disabled = new WeixinQuoteStore({ rootDir: path.join(rootDir, "disabled"), channelId: "one", policy: { enabled: false } });
  const blocked = path.join(rootDir, "not-a-directory");
  fs.writeFileSync(blocked, "file");
  const unavailable = new WeixinQuoteStore({ rootDir: blocked, channelId: "one", onError: (error) => errors.push(error) });
  t.after(async () => { await disabled.close(); await unavailable.close(); fs.rmSync(rootDir, { recursive: true, force: true }); });
  await disabled.put("a", "u", "1", "body");
  assert.equal(await disabled.find("a", "u", "1"), undefined);
  assert.equal((await disabled.lookup("a", "u", "1")).status, "disabled");
  assert.equal(fs.existsSync(path.join(rootDir, "disabled")), false);
  await unavailable.put("a", "u", "1", "body");
  assert.equal(await unavailable.find("a", "u", "1"), undefined);
  assert.equal((await unavailable.lookup("a", "u", "1")).status, "unavailable");
  assert.equal(errors.length, 1);
});

test("removing a Weixin account removes its quote cache without touching other accounts", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-quote-remove-"));
  const accountStore = new FileWeixinAccountStore(rootDir);
  const store = new WeixinQuoteStore({ rootDir, channelId: "one" });
  t.after(async () => { await store.close(); fs.rmSync(rootDir, { recursive: true, force: true }); });
  for (const accountId of ["a", "b"]) {
    accountStore.saveAccount({ accountId, token: "fake", baseUrl: "https://example.invalid", savedAt: "now" });
    await store.put(accountId, "u", "1", accountId);
  }
  await store.close();
  assert.equal(accountStore.removeAccount("a"), true);
  assert.equal(fs.existsSync(weixinQuoteAccountDir(rootDir, "a")), false);
  assert.equal(fs.existsSync(weixinQuoteAccountDir(rootDir, "b")), true);
});
