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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("WeixinAdapter delivery policy disables realtime progress", () => {
  const adapter = new WeixinAdapter({
    store: new FileWeixinAccountStore(tempStateDir()),
    pollOnStart: false,
  });
  const policy = adapter.getDeliveryPolicy();

  assert.equal(policy.progress, "send");
  assert.equal(policy.toolProgress, "send");
  assert.equal(policy.realtimeProgress, "suppress");
  assert.deepEqual(policy.allowedProgressModes, ["silent", "brief"]);
  assert.equal(policy.defaultProgressMode, "silent");
});

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

test("WeixinAdapter waitLogin returns timeout when QR status polling reaches deadline", async () => {
  const store = new FileWeixinAccountStore(tempStateDir());
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    if (url.includes("get_bot_qrcode")) {
      return jsonResponse({ qrcode: "qr-timeout", qrcode_img_content: "https://login.example/qr-timeout" });
    }
    if (url.includes("get_qrcode_status")) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
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
  const result = await adapter.waitLogin(start.sessionKey, 5);

  assert.equal(result.state, "login_required");
  assert.equal(result.message, "登录超时，请重试。");
  assert.equal((await adapter.getStatus()).lastError, "login timeout");
});

test("WeixinAdapter sends text messages with context token and run id", async () => {
  const store = new FileWeixinAccountStore(tempStateDir());
  store.saveAccount({
    accountId: "abc-im-bot",
    token: "token-1",
    baseUrl: "https://api.example",
    savedAt: new Date().toISOString(),
  });
  const calls: Array<{ url: string; headers: Headers; body?: string; signal?: AbortSignal | null }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
      signal: init?.signal,
    });
    return jsonResponse({});
  };
  const adapter = new WeixinAdapter({
    baseUrl: "https://api.example",
    store,
    pollOnStart: false,
    outboundMinIntervalMs: 0,
    outboundMaxRetries: 0,
    outboundRequestTimeoutMs: 1000,
    apiOptions: { fetch: fetchImpl },
  });

  const result = await adapter.sendText({
    channelId: "weixin",
    routeKey: "weixin:abc-im-bot:direct:user@im.wechat",
    accountId: "abc-im-bot",
    conversation: { id: "user@im.wechat", kind: "direct" },
    recipient: { id: "user@im.wechat" },
    context: { contextToken: "ctx-1" },
  }, "hello", { correlationId: "run-1" });

  const call = calls.find((item) => item.url.includes("sendmessage"));
  assert.ok(call, "sendmessage should be called");
  assert.ok(call.signal, "sendmessage should have an abort signal");
  assert.equal(call.headers.get("Authorization"), "Bearer token-1");
  const body = JSON.parse(call.body ?? "{}");
  assert.equal(body.msg.to_user_id, "user@im.wechat");
  assert.equal(body.msg.context_token, "ctx-1");
  assert.equal(body.msg.run_id, "run-1");
  assert.equal(body.msg.item_list[0].text_item.text, "hello");
  assert.equal(result.channelId, "weixin");
});

test("WeixinAdapter sends structured tool progress with context token and run id", async () => {
  const store = new FileWeixinAccountStore(tempStateDir());
  store.saveAccount({
    accountId: "abc-im-bot",
    token: "token-1",
    baseUrl: "https://api.example",
    savedAt: new Date().toISOString(),
  });
  const calls: Array<{ url: string; body?: string }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), body: typeof init?.body === "string" ? init.body : undefined });
    return jsonResponse({});
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
    context: { contextToken: "ctx-1", runId: "run-1" },
  };

  await adapter.sendToolProgress(target, { phase: "start", toolName: "command: npm test", toolCallId: "cmd-1" });
  await adapter.sendToolProgress(target, { phase: "end", toolName: "command: npm test", toolCallId: "cmd-1", status: "completed" });

  const bodies = calls
    .filter((call) => call.url.includes("sendmessage"))
    .map((call) => JSON.parse(call.body ?? "{}"));
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].msg.context_token, "ctx-1");
  assert.equal(bodies[0].msg.run_id, "run-1");
  assert.equal(bodies[0].msg.item_list[0].type, 11);
  assert.equal(bodies[0].msg.item_list[0].is_completed, false);
  assert.equal(bodies[0].msg.item_list[0].tool_call_start_item.tool_call_id, "cmd-1");
  assert.equal(bodies[1].msg.item_list[0].type, 12);
  assert.equal(bodies[1].msg.item_list[0].is_completed, true);
  assert.equal(bodies[1].msg.item_list[0].tool_call_result_item.status, "completed");
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

test("WeixinAdapter retries temporary ret=-2 sendmessage failures", async () => {
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
        return jsonResponse({ ret: -2, errcode: 0, errmsg: "temporary send failure" });
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
  }, "hello after ret -2 retry");

  assert.equal(sendAttempts, 2);
  const status = await adapter.getStatus();
  assert.equal(status.state, "connected");
  assert.equal(status.lastError, undefined);
});

test("WeixinAdapter includes target context token for direct text delivery", async () => {
  const store = new FileWeixinAccountStore(tempStateDir());
  store.saveAccount({
    accountId: "abc-im-bot",
    token: "token-1",
    baseUrl: "https://api.example",
    savedAt: new Date().toISOString(),
  });
  const bodies: unknown[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    if (url.includes("sendmessage")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      bodies.push(body);
      return jsonResponse({});
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const adapter = new WeixinAdapter({
    baseUrl: "https://api.example",
    store,
    pollOnStart: false,
    outboundMinIntervalMs: 0,
    outboundMaxRetries: 0,
    outboundRetryBaseDelayMs: 0,
    apiOptions: { fetch: fetchImpl },
  });

  await adapter.sendText({
    channelId: "weixin",
    routeKey: "weixin:abc-im-bot:direct:user@im.wechat",
    accountId: "abc-im-bot",
    conversation: { id: "user@im.wechat", kind: "direct" },
    recipient: { id: "user@im.wechat" },
    context: { contextToken: "stale-ctx" },
  }, "hello direct delivery");

  assert.equal(bodies.length, 1);
  assert.equal((bodies[0] as { msg?: { context_token?: string } }).msg?.context_token, "stale-ctx");
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
  let configCount = 0;
  let now = 1_000;
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.includes("getconfig")) {
      configCount += 1;
      return jsonResponse({ typing_ticket: `typing-ticket-${configCount}` });
    }
    if (url.includes("sendtyping")) return jsonResponse({});
    throw new Error(`unexpected fetch ${url}`);
  };
  const adapter = new WeixinAdapter({
    baseUrl: "https://api.example",
    store,
    pollOnStart: false,
    outboundMinIntervalMs: 0,
    now: () => now,
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
  await waitFor(async () => calls.filter((call) => call.url.includes("sendtyping")).length === 1);
  now += 5_000;
  await adapter.sendTyping(target, true);
  await waitFor(async () => calls.filter((call) => call.url.includes("sendtyping")).length === 2);
  now += 5_000;
  await adapter.sendTyping(target, true);
  await waitFor(async () => calls.filter((call) => call.url.includes("sendtyping")).length === 3);
  now += 20_000;
  await adapter.sendTyping(target, true);
  await waitFor(async () => calls.filter((call) => call.url.includes("sendtyping")).length === 4);
  await adapter.sendTyping(target, false);
  await waitFor(async () => calls.filter((call) => call.url.includes("sendtyping")).length === 5);

  const configBody = JSON.parse(calls.find((call) => call.url.includes("getconfig"))?.body ?? "{}");
  assert.equal(configBody.ilink_user_id, "user@im.wechat");
  assert.equal(configBody.context_token, "ctx-1");
  const typingBodies = calls
    .filter((call) => call.url.includes("sendtyping"))
    .map((call) => JSON.parse(call.body ?? "{}"));
  assert.equal(calls.filter((call) => call.url.includes("getconfig")).length, 2);
  assert.deepEqual(typingBodies.map((body) => body.status), [1, 1, 1, 1, 2]);
  assert.deepEqual(typingBodies.map((body) => body.typing_ticket), [
    "typing-ticket-1",
    "typing-ticket-1",
    "typing-ticket-1",
    "typing-ticket-2",
    "typing-ticket-2",
  ]);
});

test("WeixinAdapter sendTyping does not wait for slow getconfig", async () => {
  const store = new FileWeixinAccountStore(tempStateDir());
  store.saveAccount({
    accountId: "abc-im-bot",
    token: "token-1",
    baseUrl: "https://api.example",
    savedAt: new Date().toISOString(),
  });
  const calls: Array<{ url: string; body?: string }> = [];
  let releaseConfig: (() => void) | undefined;
  let markConfigStarted: (() => void) | undefined;
  const configStarted = new Promise<void>((resolve) => {
    markConfigStarted = resolve;
  });
  const configBlocked = new Promise<void>((resolve) => {
    releaseConfig = resolve;
  });
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.includes("getconfig")) {
      markConfigStarted?.();
      await configBlocked;
      return jsonResponse({ typing_ticket: "typing-ticket-1" });
    }
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

  const sendTypingReturned = await Promise.race([
    adapter.sendTyping(target, true).then(() => true),
    sleep(50).then(() => false),
  ]);
  assert.equal(sendTypingReturned, true, "sendTyping should return before getconfig finishes");
  await configStarted;
  assert.equal(calls.some((call) => call.url.includes("sendtyping")), false);

  releaseConfig?.();
  await waitFor(async () => calls.some((call) => call.url.includes("sendtyping")));
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
  const calls: Array<{ url: string; body?: unknown; signal?: AbortSignal | null }> = [];
  let encryptedUploadSize = 0;
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body, signal: init?.signal });
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
    mediaRequestTimeoutMs: 1000,
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
  assert.ok(uploadUrlCall.signal, "getuploadurl should have an abort signal");
  assert.ok(calls.find((call) => call.url === "https://cdn.example/upload")?.signal, "cdn upload should have an abort signal");
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
  assert.ok(sendBodies.every((body) => body.msg.context_token === "ctx-1"));
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

test("WeixinAdapter downloads inbound image and file attachments before emitting ChannelMessage", async () => {
  const store = new FileWeixinAccountStore(tempStateDir());
  store.saveAccount({
    accountId: "abc-im-bot",
    token: "token-1",
    baseUrl: "https://api.example",
    cdnBaseUrl: "https://cdn.example/c2c",
    savedAt: new Date().toISOString(),
  });
  const uploadRoot = tempStateDir();
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const fileBytes = Buffer.from("report");
  let updateCalls = 0;
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    if (url.includes("notifystart") || url.includes("notifystop")) return jsonResponse({});
    if (url.includes("getupdates")) {
      updateCalls += 1;
      if (updateCalls === 1) {
        return jsonResponse({
          msgs: [{
            message_id: 2001,
            from_user_id: "user@im.wechat",
            create_time_ms: 1_700_000_000_000,
            item_list: [{
              type: 2,
              msg_id: "img-in-1",
              image_item: {
                media: { full_url: "https://cdn.example/image.png" },
              },
            }, {
              type: 4,
              msg_id: "file-in-1",
              file_item: {
                media: { full_url: "https://cdn.example/report.pdf" },
                file_name: "report.pdf",
                len: String(fileBytes.length),
              },
            }],
          }],
        });
      }
      return jsonResponse({ ret: -14, errcode: -14, errmsg: "stop polling" });
    }
    if (url === "https://cdn.example/image.png") {
      return new Response(new Uint8Array(imageBytes), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }
    if (url === "https://cdn.example/report.pdf") {
      return new Response(new Uint8Array(fileBytes), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const adapter = new WeixinAdapter({
    baseUrl: "https://api.example",
    store,
    longPollTimeoutMs: 1,
    inboundMediaRootDir: uploadRoot,
    apiOptions: { fetch: fetchImpl },
  });
  const received: Array<Array<{ type?: string; localPath?: string; downloadState?: string }>> = [];
  adapter.onMessage(async (message) => {
    received.push((message.attachments ?? []).map((attachment) => ({
      type: attachment.type,
      localPath: attachment.localPath,
      downloadState: attachment.downloadState,
    })));
  });

  await adapter.start();
  await waitFor(async () => received.length === 1);
  await adapter.stop();

  assert.equal(received[0].length, 2);
  assert.deepEqual(received[0].map((attachment) => attachment.downloadState), ["available", "available"]);
  assert.deepEqual(received[0].map((attachment) => attachment.type), ["image", "file"]);
  assert.ok(received[0][0].localPath?.startsWith(uploadRoot));
  assert.ok(received[0][1].localPath?.startsWith(uploadRoot));
  assert.deepEqual(fs.readFileSync(received[0][0].localPath ?? ""), imageBytes);
  assert.deepEqual(fs.readFileSync(received[0][1].localPath ?? ""), fileBytes);
});

test("WeixinAdapter marks inbound image download failures", async () => {
  const store = new FileWeixinAccountStore(tempStateDir());
  store.saveAccount({
    accountId: "abc-im-bot",
    token: "token-1",
    baseUrl: "https://api.example",
    savedAt: new Date().toISOString(),
  });
  let updateCalls = 0;
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    if (url.includes("notifystart") || url.includes("notifystop")) return jsonResponse({});
    if (url.includes("getupdates")) {
      updateCalls += 1;
      if (updateCalls === 1) {
        return jsonResponse({
          msgs: [{
            message_id: 2002,
            from_user_id: "user@im.wechat",
            item_list: [{
              type: 2,
              image_item: {
                media: { full_url: "https://cdn.example/missing.png" },
              },
            }],
          }],
        });
      }
      return jsonResponse({ ret: -14, errcode: -14, errmsg: "stop polling" });
    }
    if (url === "https://cdn.example/missing.png") {
      return new Response("missing", { status: 404 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const adapter = new WeixinAdapter({
    baseUrl: "https://api.example",
    store,
    longPollTimeoutMs: 1,
    inboundMediaRootDir: tempStateDir(),
    apiOptions: { fetch: fetchImpl },
  });
  let downloadState = "";
  let error = "";
  adapter.onMessage(async (message) => {
    downloadState = message.attachments?.[0]?.downloadState ?? "";
    error = message.attachments?.[0]?.error ?? "";
  });

  await adapter.start();
  await waitFor(async () => downloadState.length > 0);
  await adapter.stop();

  assert.equal(downloadState, "failed");
  assert.match(error, /fetch binary 404/);
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
