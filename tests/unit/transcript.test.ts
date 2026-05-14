import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { ConsoleTranscriptSink } from "../../src/logging/transcript.js";

class MemoryWritable extends Writable {
  readonly chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

test("ConsoleTranscriptSink prints concise chat-style inbound and outbound records", () => {
  const output = new MemoryWritable();
  const sink = new ConsoleTranscriptSink({
    output,
    color: false,
    now: () => new Date(2026, 4, 14, 8, 9, 10),
  });

  sink.inbound({
    id: "m1",
    routeKey: "weixin:acct:direct:chat-1",
    channelId: "weixin",
    accountId: "acct",
    sender: { id: "sender-1", displayName: "Alice" },
    conversation: { id: "chat-1", kind: "direct" },
    text: "你好\n继续",
    timestamp: "2026-05-14T00:09:10.000Z",
  }, "你好\n继续");

  sink.outbound({
    channelId: "weixin",
    routeKey: "weixin:acct:direct:chat-1",
    accountId: "acct",
    conversation: { id: "chat-1", kind: "direct" },
    recipient: { id: "sender-1" },
  }, "Codex 正在处理这条消息。\n可发送 /status 查看状态，/stop 终止。");

  const text = output.text();
  assert.match(text, /\[08:09:10] 微信 <= Alice \| direct:chat-1/);
  assert.match(text, /  你好\n  继续/);
  assert.match(text, /\[08:09:10] 微信 => direct:chat-1 \| 开始/);
  assert.match(text, /  Codex 正在处理这条消息。/);
  assert.doesNotMatch(text, /Route:/);
  assert.doesNotMatch(text, /weixin:acct:direct:chat-1/);
});

test("ConsoleTranscriptSink can color terminal transcript records", () => {
  const output = new MemoryWritable();
  const sink = new ConsoleTranscriptSink({
    output,
    color: true,
    now: () => new Date(2026, 4, 14, 8, 9, 10),
  });

  sink.outbound({
    channelId: "weixin",
    routeKey: "weixin:acct:direct:chat-1",
    accountId: "acct",
    conversation: { id: "chat-1", kind: "direct" },
    recipient: { id: "sender-1" },
  }, "Codex 进度:\n我先检查状态。");

  const text = output.text();
  assert.match(text, /\x1b\[33;1m\[08:09:10] 微信 => direct:chat-1 \| 进度\x1b\[0m/);
  assert.match(text, /\x1b\[33m  我先检查状态。\x1b\[0m/);
});
