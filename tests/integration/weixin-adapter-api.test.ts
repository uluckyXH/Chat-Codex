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

function bodyAsBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  throw new Error(`unsupported body type: ${typeof body}`);
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
    outboundMinIntervalMs: 0,
    outboundMaxRetries: 0,
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

test("WeixinAdapter treats sendmessage errcode as delivery failure", async () => {
  const store = new FileWeixinAccountStore(tempStateDir());
  store.saveAccount({
    accountId: "abc-im-bot",
    token: "token-1",
    baseUrl: "https://api.example",
    savedAt: new Date().toISOString(),
  });
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    if (url.includes("sendmessage")) {
      return jsonResponse({ ret: 0, errcode: 45009, errmsg: "rate limited" });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const adapter = new WeixinAdapter({
    baseUrl: "https://api.example",
    store,
    pollOnStart: false,
    outboundMinIntervalMs: 0,
    outboundMaxRetries: 0,
    apiOptions: { fetch: fetchImpl },
  });

  await assert.rejects(() => adapter.sendText({
    channelId: "weixin",
    routeKey: "weixin:abc-im-bot:direct:user@im.wechat",
    accountId: "abc-im-bot",
    conversation: { id: "user@im.wechat", kind: "direct" },
    recipient: { id: "user@im.wechat" },
  }, "hello"), /sendmessage failed/);
  const status = await adapter.getStatus();
  assert.equal(status.state, "degraded");
  assert.match(status.lastError ?? "", /45009/);
});

test("WeixinAdapter retries rate-limited sendmessage and succeeds", async () => {
  const store = new FileWeixinAccountStore(tempStateDir());
  store.saveAccount({
    accountId: "abc-im-bot",
    token: "token-1",
    baseUrl: "https://api.example",
    savedAt: new Date().toISOString(),
  });
  let sendAttempts = 0;
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    if (url.includes("sendmessage")) {
      sendAttempts += 1;
      if (sendAttempts === 1) {
        return jsonResponse({ ret: 0, errcode: 45009, errmsg: "rate limited" });
      }
      return jsonResponse({});
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const adapter = new WeixinAdapter({
    baseUrl: "https://api.example",
    store,
    pollOnStart: false,
    outboundMinIntervalMs: 0,
    outboundMaxRetries: 1,
    outboundRetryBaseDelayMs: 0,
    apiOptions: { fetch: fetchImpl },
  });

  await adapter.sendText({
    channelId: "weixin",
    routeKey: "weixin:abc-im-bot:direct:user@im.wechat",
    accountId: "abc-im-bot",
    conversation: { id: "user@im.wechat", kind: "direct" },
    recipient: { id: "user@im.wechat" },
  }, "hello after retry");

  assert.equal(sendAttempts, 2);
  const status = await adapter.getStatus();
  assert.equal(status.state, "connected");
  assert.equal(status.lastError, undefined);
});

test("WeixinAdapter sends typing state with getconfig typing ticket", async () => {
  const store = new FileWeixinAccountStore(tempStateDir());
  store.saveAccount({
    accountId: "abc-im-bot",
    token: "token-1",
    baseUrl: "https://api.example",
    savedAt: new Date().toISOString(),
  });
  const calls: Array<{ url: string; body?: string }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.includes("getconfig")) return jsonResponse({ typing_ticket: "typing-ticket-1" });
    if (url.includes("sendtyping")) return jsonResponse({});
    throw new Error(`unexpected fetch ${url}`);
  };
  const adapter = new WeixinAdapter({
    baseUrl: "https://api.example",
    store,
    pollOnStart: false,
    outboundMinIntervalMs: 0,
    apiOptions: { fetch: fetchImpl },
  });
  const target = {
    channelId: "weixin",
    routeKey: "weixin:abc-im-bot:direct:user@im.wechat",
    accountId: "abc-im-bot",
    conversation: { id: "user@im.wechat", kind: "direct" as const },
    recipient: { id: "user@im.wechat" },
    context: { contextToken: "ctx-1" },
  };

  await adapter.sendTyping(target, true);
  await adapter.sendTyping(target, false);

  const configBody = JSON.parse(calls.find((call) => call.url.includes("getconfig"))?.body ?? "{}");
  assert.equal(configBody.ilink_user_id, "user@im.wechat");
  assert.equal(configBody.context_token, "ctx-1");
  const typingBodies = calls
    .filter((call) => call.url.includes("sendtyping"))
    .map((call) => JSON.parse(call.body ?? "{}"));
  assert.equal(calls.filter((call) => call.url.includes("getconfig")).length, 1);
  assert.deepEqual(typingBodies.map((body) => body.status), [1, 2]);
  assert.ok(typingBodies.every((body) => body.typing_ticket === "typing-ticket-1"));
});

test("WeixinAdapter uploads and sends image media with caption", async () => {
  const store = new FileWeixinAccountStore(tempStateDir());
  store.saveAccount({
    accountId: "abc-im-bot",
    token: "token-1",
    baseUrl: "https://api.example",
    cdnBaseUrl: "https://cdn.example/c2c",
    savedAt: new Date().toISOString(),
  });
  const imagePath = path.join(tempStateDir(), "shot.png");
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
  const calls: Array<{ url: string; body?: unknown }> = [];
  let encryptedUploadSize = 0;
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body });
    if (url.includes("getuploadurl")) {
      return jsonResponse({ upload_full_url: "https://cdn.example/upload" });
    }
    if (url === "https://cdn.example/upload") {
      encryptedUploadSize = bodyAsBuffer(init?.body).length;
      return new Response("", {
        status: 200,
        headers: { "x-encrypted-param": "download-param-1" },
      });
    }
    if (url.includes("sendmessage")) {
      return jsonResponse({});
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const adapter = new WeixinAdapter({
    baseUrl: "https://api.example",
    store,
    pollOnStart: false,
    outboundMinIntervalMs: 0,
    apiOptions: { fetch: fetchImpl },
  });

  const result = await adapter.sendMedia({
    channelId: "weixin",
    routeKey: "weixin:abc-im-bot:direct:user@im.wechat",
    accountId: "abc-im-bot",
    conversation: { id: "user@im.wechat", kind: "direct" },
    recipient: { id: "user@im.wechat" },
    context: { contextToken: "ctx-1" },
  }, {
    type: "image",
    path: imagePath,
    name: "shot.png",
    mimeType: "image/png",
    caption: "截图",
  });

  const uploadUrlCall = calls.find((call) => call.url.includes("getuploadurl"));
  assert.ok(uploadUrlCall, "getuploadurl should be called");
  const uploadBody = JSON.parse(String(uploadUrlCall.body));
  assert.equal(uploadBody.media_type, 1);
  assert.equal(uploadBody.to_user_id, "user@im.wechat");
  assert.equal(uploadBody.rawsize, 5);
  assert.equal(uploadBody.filesize, 16);
  assert.equal(uploadBody.no_need_thumb, true);
  assert.match(uploadBody.rawfilemd5, /^[a-f0-9]{32}$/);
  assert.match(uploadBody.aeskey, /^[a-f0-9]{32}$/);
  assert.equal(encryptedUploadSize, 16);

  const sendBodies = calls
    .filter((call) => call.url.includes("sendmessage"))
    .map((call) => JSON.parse(String(call.body)));
  assert.equal(sendBodies.length, 2);
  assert.equal(sendBodies[0].msg.item_list[0].text_item.text, "截图");
  const imageItem = sendBodies[1].msg.item_list[0];
  assert.equal(imageItem.type, 2);
  assert.equal(imageItem.image_item.media.encrypt_query_param, "download-param-1");
  assert.equal(imageItem.image_item.media.encrypt_type, 1);
  assert.equal(imageItem.image_item.mid_size, 16);
  assert.ok(imageItem.image_item.media.aes_key);
  assert.equal(result.channelId, "weixin");
});

test("WeixinAdapter uploads and sends file attachments", async () => {
  const store = new FileWeixinAccountStore(tempStateDir());
  store.saveAccount({
    accountId: "abc-im-bot",
    token: "token-1",
    baseUrl: "https://api.example",
    cdnBaseUrl: "https://cdn.example/c2c",
    savedAt: new Date().toISOString(),
  });
  const filePath = path.join(tempStateDir(), "report.pdf");
  fs.writeFileSync(filePath, Buffer.from("report"));
  const calls: Array<{ url: string; body?: unknown }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body });
    if (url.includes("getuploadurl")) return jsonResponse({ upload_full_url: "https://cdn.example/file-upload" });
    if (url === "https://cdn.example/file-upload") {
      return new Response("", {
        status: 200,
        headers: { "x-encrypted-param": "download-file-param" },
      });
    }
    if (url.includes("sendmessage")) return jsonResponse({});
    throw new Error(`unexpected fetch ${url}`);
  };
  const adapter = new WeixinAdapter({
    baseUrl: "https://api.example",
    store,
    pollOnStart: false,
    outboundMinIntervalMs: 0,
    apiOptions: { fetch: fetchImpl },
  });

  await adapter.sendMedia({
    channelId: "weixin",
    routeKey: "weixin:abc-im-bot:direct:user@im.wechat",
    accountId: "abc-im-bot",
    conversation: { id: "user@im.wechat", kind: "direct" },
    recipient: { id: "user@im.wechat" },
  }, {
    type: "file",
    path: filePath,
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 6,
  });

  const uploadBody = JSON.parse(String(calls.find((call) => call.url.includes("getuploadurl"))?.body));
  assert.equal(uploadBody.media_type, 3);
  assert.equal(uploadBody.rawsize, 6);
  const sendBody = JSON.parse(String(calls.find((call) => call.url.includes("sendmessage"))?.body));
  const fileItem = sendBody.msg.item_list[0];
  assert.equal(fileItem.type, 4);
  assert.equal(fileItem.file_item.file_name, "report.pdf");
  assert.equal(fileItem.file_item.len, "6");
  assert.equal(fileItem.file_item.media.encrypt_query_param, "download-file-param");
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

test("WeixinAdapter marks channel login_required when getupdates reports expired session", async () => {
  const store = new FileWeixinAccountStore(tempStateDir());
  store.saveAccount({
    accountId: "abc-im-bot",
    token: "token-expired",
    baseUrl: "https://api.example",
    savedAt: new Date().toISOString(),
  });
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    if (url.includes("notifystart")) return jsonResponse({});
    if (url.includes("getupdates")) {
      return jsonResponse({ ret: -14, errcode: -14, errmsg: "session expired" });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const adapter = new WeixinAdapter({
    baseUrl: "https://api.example",
    store,
    longPollTimeoutMs: 1,
    apiOptions: { fetch: fetchImpl },
  });

  await adapter.start();
  await waitFor(async () => (await adapter.getStatus()).state === "login_required");

  const status = await adapter.getStatus();
  assert.equal(status.state, "login_required");
  assert.equal(status.account, "abc-im-bot");
  assert.match(status.lastError ?? "", /session expired/);
});

test("WeixinAdapter can report connected from stored account without starting polling", async () => {
  const store = new FileWeixinAccountStore(tempStateDir());
  store.saveAccount({
    accountId: "abc-im-bot",
    token: "token-1",
    baseUrl: "https://api.example",
    savedAt: new Date().toISOString(),
  });
  const adapter = new WeixinAdapter({
    baseUrl: "https://api.example",
    store,
    pollOnStart: false,
  });

  await adapter.start();

  const status = await adapter.getStatus();
  assert.equal(status.state, "connected");
  assert.equal(status.account, "abc-im-bot");
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}
