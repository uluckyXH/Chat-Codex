import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import type { ChannelMessage, ChannelQuoteDiagnostics, ChannelTarget, SendResult } from "../../src/protocol/channel.js";
import { ConsoleTranscriptSink } from "../../src/logging/transcript.js";
import { RuntimeLogStore, RuntimeTuiTranscriptSink } from "../../src/cli/tui/runtime-log.js";

const message: ChannelMessage = {
  id: "18446744073709551614", channelId: "weixin", accountId: "bot", routeKey: "weixin:bot:direct:user",
  sender: { id: "user" }, conversation: { id: "user", kind: "direct" }, timestamp: "2026-10-15T00:00:00Z",
  text: "解释这个", quotedMessage: { messageId: "18446744073709551615", text: "private-history", selectedText: "private-selection" },
  raw: { context_token: "private-token", aes_key: "private-key", full_url: "https://example.invalid/private-url" },
};
const target: ChannelTarget = { ...message, recipient: message.sender };

function sinks() {
  let output = "";
  const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  const consoleSink = new ConsoleTranscriptSink({ output: stream, color: false, maxTextLength: 40 });
  const store = new RuntimeLogStore();
  return { consoleSink, tuiSink: new RuntimeTuiTranscriptSink(store), store, output: () => output };
}

test("quote transcripts show IDs and truthful recovery states without copying historical content or credentials", () => {
  const cases: Array<[ChannelQuoteDiagnostics, RegExp]> = [
    [{ source: "cache", cache: "hit", selection: "restored", media: "available" }, /本地缓存命中[\s\S]*已还原选中片段[\s\S]*引用附件: 已恢复/],
    [{ source: "inline", cache: "not-needed", selection: "fallback", media: "unavailable" }, /微信已附带原文[\s\S]*回退全文[\s\S]*部分或全部不可用/],
    [{ source: "unavailable", cache: "miss", selection: "unavailable", media: "none" }, /未记录或已清理，无法确认过期[\s\S]*原文不可用/],
    [{ source: "unavailable", cache: "disabled", selection: "none", media: "none" }, /引用缓存未启用/],
    [{ source: "unavailable", cache: "unavailable", selection: "none", media: "none" }, /引用缓存不可用或读取失败/],
    [{ source: "unavailable", cache: "not-configured", selection: "none", media: "none" }, /未配置引用缓存目录/],
    [{ source: "unavailable", cache: "missing-id", selection: "none", media: "none" }, /微信未提供可用引用 ID/],
  ];
  for (const [quoteDiagnostics, expected] of cases) {
    const f = sinks();
    for (const sink of [f.consoleSink, f.tuiSink]) sink.inbound({ ...message, quoteDiagnostics }, message.text!);
    for (const output of [f.output(), f.store.snapshot()[0].message]) {
      assert.match(output, /消息 ID: 18446744073709551614/);
      assert.match(output, /引用消息 ID: 18446744073709551615/);
      assert.match(output, /解释这个/);
      assert.match(output, expected);
      assert.doesNotMatch(output, /private-/);
    }
  }
});

test("quote metadata stays visible for long messages and escapes control characters in IDs", () => {
  const f = sinks();
  const unsafeId = "123\nFORGED\u001b[31m";
  const quoted = { ...message, id: unsafeId, quotedMessage: { ...message.quotedMessage!, messageId: undefined } };
  for (const sink of [f.consoleSink, f.tuiSink]) sink.inbound(quoted, "长正文".repeat(100));
  for (const output of [f.output(), f.store.snapshot()[0].message]) {
    assert.match(output, /123\\u000aFORGED\\u001b\[31m/);
    assert.match(output, /引用消息 ID: 未提供/);
    assert.match(output, /未提供恢复诊断/);
    assert.doesNotMatch(output, /\nFORGED|\u001b/);
  }
  assert.match(f.output(), /已截断/);
});

test("Feishu delayed quote logs distinguish remote recovery failures without exposing quoted bodies", () => {
  const cases: Array<[NonNullable<ChannelQuoteDiagnostics["fetch"]>, RegExp]> = [
    ["success", /已从渠道读取原文/],
    ["missing", /接口未返回原消息/],
    ["deleted", /原消息已撤回或删除/],
    ["failed", /读取失败[\s\S]*读取错误码: 999/],
    ["timeout", /读取原消息超时/],
    ["chat-mismatch", /原消息不属于当前聊天/],
    ["unsupported", /暂不支持读取/],
    ["empty", /没有可读取的正文或附件/],
  ];
  for (const [fetch, expected] of cases) {
    const f = sinks();
    const resolved: ChannelMessage = {
      ...message, channelId: "feishu", id: "om_reply",
      quotedMessage: { messageId: "om_parent", text: "private-history" },
      quoteDiagnostics: { source: fetch === "success" ? "remote" : "unavailable", cache: "not-needed", fetch, selection: "none", media: "none", ...(fetch === "failed" ? { fetchCode: 999 } : {}) },
    };
    f.consoleSink.quotedMessage(resolved);
    f.tuiSink.quotedMessage(resolved);
    assert.equal(f.store.snapshot()[0].kind, "quote");
    for (const output of [f.output(), f.store.snapshot()[0].message]) {
      assert.match(output, /消息 ID: om_reply/);
      assert.match(output, /引用消息 ID: om_parent/);
      assert.match(output, expected);
      assert.doesNotMatch(output, /private-|解释这个/);
    }
  }
});

test("Feishu receive log marks quote lookup as pending instead of claiming a cache miss", () => {
  const f = sinks();
  const pending: ChannelMessage = { ...message, channelId: "feishu", quoteDiagnostics: { source: "unavailable", cache: "not-needed", fetch: "pending", selection: "none", media: "none" } };
  f.consoleSink.inbound(pending, "本次要求");
  f.tuiSink.inbound(pending, "本次要求");
  for (const output of [f.output(), f.store.snapshot()[0].message]) {
    assert.match(output, /等待读取原消息/);
    assert.match(output, /命令或问答回复无需读取/);
    assert.doesNotMatch(output, /过期|未命中|private-/);
  }
});

test("all delivered transcript kinds expose server receipts while local observations have no fabricated receipts", () => {
  const f = sinks();
  const receipt: SendResult = { channelId: "weixin", messageId: "client-1", serverMessageId: "18446744073709551615", deliveredAt: "now", raw: { context_token: "private-token" } };
  for (const sink of [f.consoleSink, f.tuiSink]) {
    sink.outbound(target, "回复", receipt);
    sink.outboundProgress(target, "进度", receipt);
    sink.outboundCommentary(target, "旁白", receipt);
    sink.outboundMedia(target, { type: "file", name: "report.md" }, receipt);
    sink.localCommentary(target, "未投递的旁白");
    sink.outbound(target, "旧版渠道回执", { messageId: "only-client-id" });
  }
  assert.equal(f.output().match(/服务端消息 ID: 18446744073709551615/g)?.length, 4);
  for (const entry of f.store.snapshot().slice(0, 4)) {
    assert.match(entry.message, /服务端消息 ID: 18446744073709551615/);
    assert.match(entry.message, /客户端消息 ID: client-1/);
  }
  assert.doesNotMatch(f.store.snapshot()[4].message, /消息 ID/);
  assert.match(f.store.snapshot()[5].message, /发送消息 ID: only-client-id/);
  assert.doesNotMatch(f.output() + JSON.stringify(f.store.snapshot()), /private-token/);
});
