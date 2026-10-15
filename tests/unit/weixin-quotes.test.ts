import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolveWeixinPartialQuote, resolveWeixinQuote } from "../../src/channels/weixin/weixin-quotes.js";
import { weixinMessageToChannelMessage } from "../../src/channels/weixin/weixin-adapter.js";

test("Weixin inline quotes keep current command and historical text separate", () => {
  const message = weixinMessageToChannelMessage("weixin", "bot", { message_id: "9007199254740993", from_user_id: "u", item_list: [{ type: 1, text_item: { text: "/a1" }, ref_msg: { svr_id: "9007199254740995", title: "历史消息", message_item: { type: 1, text_item: { text: "/stop" } } } }] });
  assert.equal(message.text, "/a1");
  assert.equal(message.id, "9007199254740993");
  assert.deepEqual(message.quotedMessage, { messageId: "9007199254740995", text: "历史消息 | /stop" });
});

test("Weixin ID-only quotes expose missing history and prefer inline content over cache", () => {
  const raw = { item_list: [{ ref_msg: { svr_id: "123" } }] };
  assert.match(resolveWeixinQuote(raw)?.text ?? "", /未附带原文/);
  assert.equal(resolveWeixinQuote(raw, "原始正文")?.text, "原始正文");
  assert.equal(resolveWeixinQuote({ item_list: [{ ref_msg: { svr_id: "123", title: "内嵌正文" } }] }, "旧缓存")?.text, "内嵌正文");
});

test("Weixin partial quotes verify global or relative anchor occurrences using UTF-8 MD5", () => {
  const text = "开始甲结束；开始乙🙂结束；开始丙结束";
  const quote = "开始乙🙂结束";
  const md5 = createHash("md5").update(quote).digest("hex");
  for (const endindex of [0, 1]) {
    assert.equal(resolveWeixinPartialQuote(text, { start: "开始", end: "结束", startindex: 1, endindex, quotemd5: md5.toUpperCase() }), quote);
  }
  assert.equal(resolveWeixinPartialQuote(text, { start: "开始", end: "结束", startindex: 1, endindex: 1, quotemd5: "" }), quote);
});

test("Weixin invalid partial selection falls back to full text without inventing a match", () => {
  const text = "开始甲结束";
  for (const partial of [
    { start: "开始", end: "结束", startindex: -1, endindex: 0, quotemd5: "" },
    { start: "开始", end: "结束", startindex: 0, endindex: 0, quotemd5: "invalid" },
    { start: "", end: "结束", startindex: 0, endindex: 0, quotemd5: "" },
    { start: "开始", end: "结束", startindex: Number.MAX_SAFE_INTEGER, endindex: 0, quotemd5: "" },
  ]) {
    const resolved = resolveWeixinQuote({ item_list: [{ ref_msg: { svr_id: "123", partial_text: partial } }] }, text);
    assert.equal(resolved?.text, text);
    assert.equal(resolved?.selectedText, undefined);
  }
});
