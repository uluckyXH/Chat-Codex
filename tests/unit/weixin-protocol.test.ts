import test from "node:test";
import assert from "node:assert/strict";
import { parseWeixinApiJson, weixinMessageId } from "../../src/channels/weixin/weixin-json.js";
import { WeixinApiClient } from "../../src/channels/weixin/weixin-api.js";
import { classifyWeixinFetchError, WeixinNetworkError } from "../../src/channels/weixin/weixin-network-error.js";
import { chatCodexVersion } from "../../src/runtime/package-info.js";

test("Weixin JSON preserves uint64 IDs in nested responses without changing text or unrelated numbers", () => {
  const text = 'literal "message_id": 18446744073709551615 and \\ path';
  const parsed = parseWeixinApiJson<Record<string, unknown>>(`{
    "message_id": 18446744073709551615, "msg_id": 9007199254740993,
    "nested": {"svr_id":18446744073709551614}, "text":${JSON.stringify(text)},
    "seq":12, "ratio":1.25, "list":[{"message_id":1}], "stringId":{"message_id":"123"},
    "escaped":{"message_\\u0069d":9007199254740995}
  }`);
  assert.equal(parsed.message_id, "18446744073709551615");
  assert.equal(parsed.msg_id, "9007199254740993");
  assert.deepEqual(parsed.nested, { svr_id: "18446744073709551614" });
  assert.equal(parsed.text, text);
  assert.equal(parsed.seq, 12);
  assert.equal(parsed.ratio, 1.25);
  assert.deepEqual(parsed.list, [{ message_id: "1" }]);
  assert.deepEqual(parsed.stringId, { message_id: "123" });
  assert.deepEqual(parsed.escaped, { message_id: "9007199254740995" });
});

test("Weixin JSON rejects malformed JSON and non-integer IDs rather than making them valid", () => {
  for (const source of ['{"message_id":01}', '{"message_id":-1}', '{"message_id":1.5}', '{"message_id":1e20}', '{"message_id":123', '{"text":"bad\\q"}']) {
    assert.throws(() => parseWeixinApiJson(source), SyntaxError);
  }
  assert.deepEqual(parseWeixinApiJson('{"message_id":null,"msg_id":"","svr_id":0}'), { message_id: null, msg_id: "", svr_id: "0" });
  assert.equal(weixinMessageId(9007199254740992), undefined);
  assert.equal(weixinMessageId(123), "123");
});

test("Weixin API reads large incoming IDs and returns exact server message IDs on successful sends", async () => {
  const api = new WeixinApiClient({ fetch: async (input) => new Response(String(input).includes("getupdates")
    ? '{"ret":0,"msgs":[{"message_id":18446744073709551615,"item_list":[{"msg_id":9007199254740993,"ref_msg":{"svr_id":9007199254740995}}]}]}'
    : '{"ret":0,"message_id":18446744073709551614}') });
  const updates = await api.getUpdates({ token: "fake" });
  assert.equal(updates.msgs?.[0].message_id, "18446744073709551615");
  assert.equal(updates.msgs?.[0].item_list?.[0].ref_msg?.svr_id, "9007199254740995");
  assert.equal((await api.sendMessage({ token: "fake", body: {} })).message_id, "18446744073709551614");
});

test("Weixin API never treats an error with a server ID as a successful send", async () => {
  for (const body of ['{"ret":-2,"message_id":18446744073709551615,"errmsg":"prepare failed"}', '{"ret":0,"errcode":45009,"message_id":123}']) {
    const api = new WeixinApiClient({ fetch: async () => new Response(body) });
    await assert.rejects(api.sendMessage({ token: "fake", body: {} }), /sendmessage failed/);
  }
});

test("Weixin network errors retain causes and classify failures without exposing URLs or tokens", async () => {
  for (const [code, expected] of [["ENOTFOUND", "dns"], ["EAI_AGAIN", "dns"], ["ECONNREFUSED", "tcp"], ["UND_ERR_SOCKET", "tcp"], ["CERT_HAS_EXPIRED", "tls"], ["UND_ERR_HEADERS_TIMEOUT", "timeout"], ["UNKNOWN", "unknown"]] as const) {
    const cause = new TypeError("fetch failed https://example.invalid/?token=private", { cause: Object.assign(new Error("connection failed"), { code }) });
    assert.equal(classifyWeixinFetchError(cause).type, expected);
    const api = new WeixinApiClient({ fetch: async () => { throw cause; } });
    await assert.rejects(api.sendMessage({ token: "fake", body: {} }), (error) => {
      assert.ok(error instanceof WeixinNetworkError);
      assert.equal(error.failure.type, expected);
      assert.equal(error.cause, cause);
      assert.equal(error.message.includes("private"), false);
      return true;
    });
  }
});

test("Weixin external cancellation remains AbortError and new metadata identifies the real bridge version", async () => {
  const aborted = new DOMException("aborted", "AbortError");
  const controller = new AbortController();
  controller.abort();
  const abortedApi = new WeixinApiClient({ fetch: async () => { throw aborted; } });
  await assert.rejects(abortedApi.getUpdates({ token: "fake", signal: controller.signal }), (error) => error === aborted);
  let body: Record<string, { channel_version: string; bot_agent: string }> | undefined;
  let headers: Headers | undefined;
  const api = new WeixinApiClient({ fetch: async (_input, init) => { body = JSON.parse(String(init?.body)); headers = new Headers(init?.headers); return Response.json({}); } });
  await api.sendMessage({ token: "fake", body: {} });
  assert.equal(body?.base_info.channel_version, "2.4.10");
  assert.equal(body?.base_info.bot_agent, `Chat-Codex/${chatCodexVersion()}`);
  assert.equal(headers?.get("iLink-App-ClientVersion"), "132106");
});
