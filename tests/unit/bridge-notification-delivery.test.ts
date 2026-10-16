import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { BridgeDelivery } from "../../src/bridge/delivery.js";
import { BridgeNotificationDelivery } from "../../src/bridge/notification-delivery.js";
import type { ChannelRegistry } from "../../src/channels/registry.js";
import { RuntimeLogStore, RuntimeTuiLogger } from "../../src/cli/tui/runtime-log.js";
import { notificationText } from "../../src/codex/app-server/notification-mapper.js";
import type { CodexEvent } from "../../src/codex/types.js";
import { ConsoleLogger, type Logger } from "../../src/logging/logger.js";
import type { ChannelTarget } from "../../src/protocol/channel.js";
import { MemoryStateStore } from "../../src/state/memory-state-store.js";

const success = (index = 0, risk = "low") => `Automatic approval review approved (risk: ${risk}, authorization: high): Safe action ${index}.`;
const exceptions = [
  "Automatic approval review denied (risk: high, authorization: low): Unsafe action.",
  "Automatic approval review failed: reviewer unavailable.",
  "Automatic approval review timed out while evaluating the requested approval.",
  "Automatic approval review rejected too many approval requests; interrupting the turn.",
  "Unknown guardian safety warning.",
  `Quoted previous notice: ${success()}`,
  "Automatic approval review not approved (risk: high, authorization: low): Refused.",
];

test("notification mapper makes only approved guardian notices local and retains their full reason", () => {
  for (const risk of ["low", "medium", "high", "critical"]) {
    const message = success(1, risk);
    assert.deepEqual(notificationText("guardianWarning", { message }), {
      text: `Codex 安全提示：${message}`, kind: "security", visibility: "local", dedupeWindowMs: 600_000,
    });
  }
  for (const message of exceptions) {
    const notice = notificationText("guardianWarning", { message, visibility: "local" });
    assert.equal(notice?.visibility, "channel", message);
    assert.equal(notice?.text, `Codex 安全提示：${message}`);
  }
  for (const message of [undefined, null, "", 12, { status: "approved" }]) {
    assert.equal(notificationText("guardianWarning", { message }), undefined);
  }
});

test("notification mapping never infers local visibility from another method or upstream visibility", () => {
  for (const method of ["warning", "configWarning", "deprecationNotice", "windows/worldWritableWarning"]) {
    const notice = notificationText(method, { message: success(), summary: success(), visibility: "local" });
    assert.ok(notice);
    assert.notEqual(notice.visibility, "local");
    assert.ok(notice.text.includes(success()));
  }
  assert.equal(notificationText("item/agentMessage/delta", { message: success() }), undefined);
});

const targets: ChannelTarget[] = [
  { channelId: "weixin-test", accountId: "wx-bot", routeKey: "weixin:direct:user", conversation: { kind: "direct", id: "wx-user" }, recipient: { id: "wx-user" } },
  { channelId: "feishu-test", accountId: "fs-bot", routeKey: "feishu:direct:user", conversation: { kind: "direct", id: "fs-user" }, recipient: { id: "fs-user" } },
  { channelId: "feishu-test", accountId: "fs-bot", routeKey: "feishu:group:chat", conversation: { kind: "group", id: "fs-group" }, recipient: { id: "fs-group" } },
];

for (const target of targets) {
  test(`100 successful reviews leave the send budget for the final on ${target.routeKey}`, async () => {
    const f = fixture({ quota: 2 });
    await f.router.deliver({ routeKey: target.routeKey, target, event: event(exceptions[0]) });
    for (let i = 0; i < 100; i++) {
      await f.router.deliver({ routeKey: target.routeKey, target, event: event(success(i)) });
    }
    await f.delivery.sendText(target, "final reply");
    assert.deepEqual(f.sent, [`Codex 安全提示：${exceptions[0]}`, "final reply"]);
    assert.equal(f.attempts(), 2);
    assert.deepEqual(f.transcripts, f.sent);
    assert.equal(f.store.snapshot().length, 100);
    assert.ok(f.store.snapshot().every((entry) => entry.kind === "system" && entry.source === "INFO" && entry.message.includes("仅本地记录（未投递）")));
    assert.equal(f.state.listRecentCodexNotifications("session", 5).length, 1);
    assert.ok(f.state.listRecentCodexNotifications("session")[0].text.includes("denied"));
  });
}

test("local notices dedupe within a route and session without merging unrelated conversations", async () => {
  const f = fixture();
  const target = targets[0];
  const input = { routeKey: target.routeKey, target, event: event(success()) };
  await f.router.deliver(input);
  await f.router.deliver(input);
  await f.router.deliver({ ...input, event: event(success(), "other-session") });
  await f.router.deliver({ ...input, routeKey: targets[1].routeKey, target: targets[1] });
  assert.equal(f.store.snapshot().length, 3);
  assert.equal(f.attempts(), 0);
  assert.deepEqual(f.transcripts, []);
  assert.deepEqual(f.state.listRecentCodexNotifications("session"), []);
});

test("rejections, failures, timeouts, unknown and legacy notifications retain channel delivery", async () => {
  const f = fixture();
  const target = targets[0];
  for (const message of exceptions) {
    await f.router.deliver({ routeKey: target.routeKey, target, event: event(message) });
  }
  const legacy = event("legacy security notice");
  delete legacy.notification.visibility;
  await f.router.deliver({ routeKey: target.routeKey, target, event: legacy });
  assert.deepEqual(f.sent, [...exceptions, "legacy security notice"].map((message) => `Codex 安全提示：${message}`));
  assert.equal(f.store.snapshot().length, 0);
});

test("local notification console logs have context without secrets or a false delivery receipt", async (t) => {
  const output: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { output.push(args.join(" ")); });
  const f = fixture({ logger: new ConsoleLogger() });
  const target = { ...targets[0], context: { contextToken: "private-context-token" } };
  await f.router.deliver({ routeKey: target.routeKey, target, event: event(success()) });
  assert.equal(output.length, 1);
  assert.match(output[0], /INFO Codex 通知仅本地记录（未投递）/);
  assert.match(output[0], /sessionId=session turnId=turn method=guardianWarning/);
  assert.ok(output[0].includes(success()));
  assert.ok(output[0].includes(target.routeKey));
  assert.doesNotMatch(output[0], /private-context-token/);
  assert.equal(f.attempts(), 0);
  assert.deepEqual(f.transcripts, []);
});

test("notices without an active turn log their synthetic notification ID explicitly", async () => {
  const f = fixture();
  const target = targets[0];
  const notice = event(success());
  notice.turnId = "notification:session:guardianWarning:1";
  await f.router.deliver({ routeKey: target.routeKey, target, event: notice });
  assert.match(f.store.snapshot()[0].message, /notificationId=notification:session:guardianWarning:1/);
  assert.doesNotMatch(f.store.snapshot()[0].message, /turnId=/);
  assert.equal(f.attempts(), 0);
});

function event(message: string, sessionId = "session"): Extract<CodexEvent, { type: "codex.notification" }> {
  const notice = notificationText("guardianWarning", { message });
  assert.ok(notice);
  return {
    type: "codex.notification", sessionId, turnId: "turn",
    notification: { method: "guardianWarning", ...notice, dedupeKey: `guardianWarning:${sessionId}:${message}` },
  };
}

function fixture(options: { logger?: Logger; quota?: number } = {}) {
  const state = new MemoryStateStore();
  const store = new RuntimeLogStore();
  const sent: string[] = [];
  const transcripts: string[] = [];
  let attempts = 0;
  const delivery = new BridgeDelivery({
    approvals: new ApprovalManager(), logger: options.logger ?? new RuntimeTuiLogger(store), approvalSendRetryDelayMs: 1,
    channels: { sendText: async (_target: ChannelTarget, text: string) => {
      attempts += 1;
      if (attempts > (options.quota ?? Infinity)) throw new Error("synthetic send budget exhausted");
      sent.push(text);
      return { channelId: "mock", messageId: String(attempts), deliveredAt: "now" };
    } } as unknown as ChannelRegistry,
    transcript: { inbound() {}, outbound(_target, text) { transcripts.push(text); } },
  });
  return { state, store, sent, transcripts, delivery, attempts: () => attempts, router: new BridgeNotificationDelivery({ state, delivery }) };
}
