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

test("ConsoleTranscriptSink shows Feishu conversation type and sender in inbound logs", () => {
  const output = new MemoryWritable();
  const sink = new ConsoleTranscriptSink({
    output,
    color: false,
    now: () => new Date(2026, 4, 14, 8, 9, 10),
  });

  sink.inbound({
    id: "m1",
    routeKey: "feishu-default:default:direct:oc_direct",
    channelId: "feishu-default",
    accountId: "default",
    sender: { id: "ou_sender", displayName: "小黄" },
    conversation: { id: "oc_direct", kind: "direct", displayName: "飞书私聊" },
    text: "私聊消息",
    timestamp: "2026-05-14T00:09:10.000Z",
  }, "私聊消息");

  sink.inbound({
    id: "m2",
    routeKey: "feishu-default:default:group:oc_group",
    channelId: "feishu-default",
    accountId: "default",
    sender: { id: "ou_group_sender", displayName: "张三" },
    conversation: { id: "oc_group", kind: "group", displayName: "研发群" },
    text: "群聊消息",
    timestamp: "2026-05-14T00:09:10.000Z",
  }, "群聊消息");

  sink.inbound({
    id: "m3",
    routeKey: "feishu-default:default:group:oc_group_unknown",
    channelId: "feishu-default",
    accountId: "default",
    sender: { id: "ou_unknown" },
    conversation: { id: "oc_group_unknown", kind: "group", displayName: "飞书群聊" },
    text: "群聊消息",
    timestamp: "2026-05-14T00:09:10.000Z",
  }, "群聊消息");

  sink.inbound({
    id: "m4",
    routeKey: "feishu-default:default:direct:oc_unknown",
    channelId: "feishu-default",
    accountId: "default",
    sender: { id: "ou_direct_unknown" },
    conversation: { id: "oc_unknown", kind: "direct", displayName: "飞书私聊" },
    text: "私聊消息",
    timestamp: "2026-05-14T00:09:10.000Z",
  }, "私聊消息");

  const text = output.text();
  assert.match(text, /\[08:09:10] 飞书 <= 私聊:小黄 \| 小黄/);
  assert.match(text, /\[08:09:10] 飞书 <= 群聊:研发群 \| 张三/);
  assert.match(text, /\[08:09:10] 飞书 <= 群聊:oc_group_unknown \| ou_unknown/);
  assert.match(text, /\[08:09:10] 飞书 <= 私聊:oc_unknown \| ou_direct_unknown/);
});

test("ConsoleTranscriptSink can color terminal transcript records", () => {
  const output = new MemoryWritable();
  const sink = new ConsoleTranscriptSink({
    output,
    color: true,
    now: () => new Date(2026, 4, 14, 8, 9, 10),
  });

  sink.outboundProgress({
    channelId: "weixin",
    routeKey: "weixin:acct:direct:chat-1",
    accountId: "acct",
    conversation: { id: "chat-1", kind: "direct" },
    recipient: { id: "sender-1" },
  }, "我先检查状态。");

  const text = output.text();
  assert.match(text, /\x1b\[33;1m\[08:09:10] 微信 => direct:chat-1 \| 进度\x1b\[0m/);
  assert.match(text, /\x1b\[33m  我先检查状态。\x1b\[0m/);
  assert.doesNotMatch(text, /Codex 进度:/);
});

test("ConsoleTranscriptSink prints local progress as not delivered", () => {
  const output = new MemoryWritable();
  const sink = new ConsoleTranscriptSink({
    output,
    color: false,
    now: () => new Date(2026, 4, 14, 8, 9, 10),
  });

  sink.localProgress({
    channelId: "weixin",
    routeKey: "weixin:acct:direct:chat-1",
    accountId: "acct",
    conversation: { id: "chat-1", kind: "direct" },
    recipient: { id: "sender-1" },
  }, "我先检查状态。");

  const text = output.text();
  assert.match(text, /\[08:09:10] 微信 -- direct:chat-1 \| 本地进度（未投递）/);
  assert.match(text, /  我先检查状态。/);
  assert.doesNotMatch(text, /Codex 进度:/);
});

test("ConsoleTranscriptSink prints commentary separately from progress", () => {
  const output = new MemoryWritable();
  const sink = new ConsoleTranscriptSink({
    output,
    color: false,
    now: () => new Date(2026, 4, 14, 8, 9, 10),
  });

  const target = {
    channelId: "weixin",
    routeKey: "weixin:acct:direct:chat-1",
    accountId: "acct",
    conversation: { id: "chat-1", kind: "direct" as const },
    recipient: { id: "sender-1" },
  };
  sink.observedCommentary(target, "我先说明方案。");
  sink.outboundCommentary(target, "我先说明方案。");
  sink.localCommentary(target, "旁白发送失败。");

  const text = output.text();
  assert.match(text, /\[08:09:10] 微信 -- direct:chat-1 \| 本地旁白/);
  assert.match(text, /\[08:09:10] 微信 => direct:chat-1 \| 旁白/);
  assert.match(text, /\[08:09:10] 微信 -- direct:chat-1 \| 本地旁白（未投递）/);
  assert.doesNotMatch(text, /\| 进度/);
});

test("ConsoleTranscriptSink prints observed local progress separately from delivery failures", () => {
  const output = new MemoryWritable();
  const sink = new ConsoleTranscriptSink({
    output,
    color: false,
    now: () => new Date(2026, 4, 14, 8, 9, 10),
  });

  sink.observedProgress({
    channelId: "weixin",
    routeKey: "weixin:acct:direct:chat-1",
    accountId: "acct",
    conversation: { id: "chat-1", kind: "direct" },
    recipient: { id: "sender-1" },
  }, "正在分析。");

  const text = output.text();
  assert.match(text, /\[08:09:10] 微信 -- direct:chat-1 \| 本地进度/);
  assert.doesNotMatch(text, /本地进度（未投递）/);
  assert.match(text, /  正在分析。/);
});
