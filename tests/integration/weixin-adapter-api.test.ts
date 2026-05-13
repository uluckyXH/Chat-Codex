import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileWeixinAccountStore } from "../../src/channels/weixin/weixin-account-store.js";
import { WeixinAdapter } from "../../src/channels/weixin/weixin-adapter.js";
import type { FetchLike } from "../../src/channels/weixin/weixin-api.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-state-"));
}

test("WeixinAdapter starts QR login, waits for confirmation, and stores account credentials", async () => {
  const store = new FileWeixinAccountStore(tempStateDir());
  const calls: Array<{ url: string; body?: string }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.includes("get_bot_qrcode")) {
      return jsonResponse({ qrcode: "qr-1", qrcode_img_content: "https://login.example/qr" });
    }
    if (url.includes("get_qrcode_status")) {
      return jsonResponse({
        status: "confirmed",
        bot_token: "token-1",
        ilink_bot_id: "abc@im.bot",
        baseurl: "https://api.example",
        ilink_user_id: "user-1",
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const adapter = new WeixinAdapter({
    baseUrl: "https://api.example",
    store,
    pollOnStart: false,
    loginPollIntervalMs: 0,
    apiOptions: { fetch: fetchImpl },
  });

  const start = await adapter.startLogin();
  const result = await adapter.waitLogin(start.sessionKey, 1000);

  assert.equal(start.qrCodeText, "https://login.example/qr");
  assert.equal(result.state, "connected");
  assert.equal(store.loadAccount("abc-im-bot")?.token, "token-1");
  assert.equal((await adapter.getStatus()).account, "abc-im-bot");
  assert.ok(calls.some((call) => call.url.includes("get_bot_qrcode")));
  assert.ok(calls.some((call) => call.url.includes("get_qrcode_status")));
});

test("WeixinAdapter sends text messages with stored token and context token", async () => {
  const store = new FileWeixinAccountStore(tempStateDir());
  store.saveAccount({
    accountId: "abc-im-bot",
    token: "token-1",
    baseUrl: "https://api.example",
    savedAt: new Date().toISOString(),
  });
  const calls: Array<{ url: string; headers: Headers; body?: string }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return jsonResponse({});
  };
  const adapter = new WeixinAdapter({
    baseUrl: "https://api.example",
    store,
    pollOnStart: false,
    apiOptions: { fetch: fetchImpl },
  });

  const result = await adapter.sendText({
    channelId: "weixin",
    routeKey: "weixin:abc-im-bot:direct:user@im.wechat",
    accountId: "abc-im-bot",
    conversation: { id: "user@im.wechat", kind: "direct" },
    recipient: { id: "user@im.wechat" },
    context: { contextToken: "ctx-1" },
  }, "hello");

  const call = calls.find((item) => item.url.includes("sendmessage"));
  assert.ok(call, "sendmessage should be called");
  assert.equal(call.headers.get("Authorization"), "Bearer token-1");
  const body = JSON.parse(call.body ?? "{}");
  assert.equal(body.msg.to_user_id, "user@im.wechat");
  assert.equal(body.msg.context_token, "ctx-1");
  assert.equal(body.msg.item_list[0].text_item.text, "hello");
  assert.equal(result.channelId, "weixin");
});

test("WeixinAdapter submits verify code when QR login requires pairing code", async () => {
  const store = new FileWeixinAccountStore(tempStateDir());
  const statusUrls: string[] = [];
  let statusCalls = 0;
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    if (url.includes("get_bot_qrcode")) {
      return jsonResponse({ qrcode: "qr-2", qrcode_img_content: "https://login.example/qr2" });
    }
    if (url.includes("get_qrcode_status")) {
      statusCalls += 1;
      statusUrls.push(url);
      if (statusCalls === 1) return jsonResponse({ status: "need_verifycode" });
      return jsonResponse({
        status: "confirmed",
        bot_token: "token-2",
        ilink_bot_id: "def@im.bot",
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const adapter = new WeixinAdapter({
    baseUrl: "https://api.example",
    store,
    pollOnStart: false,
    loginPollIntervalMs: 0,
    apiOptions: { fetch: fetchImpl },
    verifyCodeProvider: async () => "1234",
  });

  const start = await adapter.startLogin();
  const result = await adapter.waitLogin(start.sessionKey, 1000);

  assert.equal(result.state, "connected");
  assert.equal(store.loadAccount("def-im-bot")?.token, "token-2");
  assert.ok(statusUrls.some((url) => url.includes("verify_code=1234")));
});
