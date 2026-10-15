import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bridge } from "../../src/bridge/bridge.js";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { MockChannelAdapter } from "../../src/channels/mock/mock-channel-adapter.js";
import { FeishuAdapter } from "../../src/channels/feishu/feishu-adapter.js";
import { MockCodexAdapter } from "../../src/codex/mock-codex-adapter.js";
import type { CodexEvent, CodexPromptInput } from "../../src/codex/types.js";
import { MemoryStateStore } from "../../src/state/memory-state-store.js";
import { GroupAccessService } from "../../src/group-access/service.js";
import { LimitedTurnScheduler } from "../../src/bridge/turn-scheduler.js";
import { FakeFeishuTransportFactory, sampleFeishuTextEvent } from "../helpers/feishu-fakes.js";

const group = { conversationKind: "group" as const, conversationId: "oc_room" };
const local = { kind: "local" as const };
function trusted(channelId = "custom-adapter", accountId = "work", conversationId = "oc_room") {
  const now = new Date().toISOString();
  return { routeKey: `${channelId}:${accountId}:group:${conversationId}`, channelId, accountId, conversationId, conversationKind: "group" as const, trustedBySenderId: "ou_super", trustMethod: "pairing_code" as const, trustedAt: now, createdAt: now, updatedAt: now };
}
async function fixture(t: TestContext, codex = new MockCodexAdapter(), extra: Partial<ConstructorParameters<typeof Bridge>[0]> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "group-integration-"));
  const state = new MemoryStateStore();
  const route = trusted();
  state.trustRoute(route);
  const service = new GroupAccessService({ state });
  service.ensureForTrustedRoute(route);
  service.mutate(route.routeKey, local, { action: "admin_add", target: "ou_admin" });
  const channel = new MockChannelAdapter({ id: route.channelId, accountId: route.accountId, groupPolicy: "feishu", media: true });
  const approvals = new ApprovalManager();
  const bridge = new Bridge({ channel, codex, state, approvals, feishuGroupMemberStateRootDir: root, ...extra });
  t.after(async () => { await bridge.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await bridge.start();
  const emit = (text: string, senderId = "ou_super", overrides = {}) => channel.emitText(text, { ...group, senderId, ...overrides });
  for (const [id, name] of [["ou_super", "超管"], ["ou_admin", "管理员"], ["ou_member", "成员"], ["ou_other", "其他成员"]]) await emit(`/name ${name}`, id);
  channel.sentMessages.length = 0;
  const approval = (who = "ou_member", otherRoute = route.routeKey) => approvals.create(otherRoute, who, { kind: "command", sessionId: "session", turnId: "turn", itemId: "item", availableDecisions: ["approve", "approve-session", "deny", "cancel"] }, true);
  return { state, service, channel, approvals, bridge, codex, root, emit, approval, routeKey: route.routeKey };
}

test("explicit policy works with a custom adapter id, ordinary members cannot use privileged commands", async (t) => {
  const f = await fixture(t);
  for (const cmd of ["/status", "/stop", "/cancel", "/sendfile report", "/model", "/perm", "/policy", "/plan", "/goal create x", "/context", "/new", "/sessions", "/debug", "/P", "/unknown"]) {
    const before = f.channel.sentMessages.length;
    await f.emit(cmd, "ou_member");
    assert.ok(f.channel.sentMessages.length > before, cmd);
  }
  assert.equal(f.codex.runs.length, 0);
  await f.emit("看一下", "ou_member"); await f.bridge.waitForIdle();
  assert.equal(f.codex.runs[0]?.prompt, "成员说：看一下");
  await f.emit("/model", "ou_admin");
  assert.match(f.channel.sentMessages.at(-1)!.text, /仅超级管理员/);
  await f.emit("/help", "ou_admin"); assert.match(f.channel.sentMessages.at(-1)!.text, /sendfile/);
  await f.emit("/help", "ou_member"); assert.doesNotMatch(f.channel.sentMessages.at(-1)!.text, /sendfile/);
});

test("blacklist is checked before help/name/pair, preserves name, and stays route scoped", async (t) => {
  const f = await fixture(t);
  f.service.mutate(f.routeKey, local, { action: "block", target: "ou_member" });
  const before = f.channel.sentMessages.length;
  for (const text of ["/help", "/whoami", "/name 改名", "/pair anything", "/OK", "hello"]) await f.emit(text, "ou_member");
  assert.equal(f.channel.sentMessages.length, before);
  assert.equal(f.codex.runs.length, 0);
  await f.emit("另一个群", "ou_member", { conversationId: "other" });
  assert.match(f.channel.sentMessages.at(-1)!.text, /配对/);
  f.service.mutate(f.routeKey, local, { action: "unblock", target: "ou_member" });
  await f.emit("继续", "ou_member"); await f.bridge.waitForIdle();
  assert.equal(f.codex.runs.at(-1)?.prompt, "成员说：继续");
});

test("group confirmation binds actor, route and revision; regular admins may block only members", async (t) => {
  const f = await fixture(t);
  await f.emit("/group block ou_member", "ou_admin");
  const token = f.channel.sentMessages.at(-1)!.text.match(/confirm ([a-f0-9]+)/)![1];
  await f.emit(`/group confirm ${token}`, "ou_super");
  assert.equal(f.service.roleForSender(f.routeKey, "ou_member"), "member");
  await f.emit(`/group confirm ${token}`, "ou_admin");
  assert.equal(f.service.roleForSender(f.routeKey, "ou_member"), "blocked");
  await f.emit("/group admin add ou_other");
  const stale = f.channel.sentMessages.at(-1)!.text.match(/confirm ([a-f0-9]+)/)![1];
  f.service.mutate(f.routeKey, local, { action: "approval", policy: "any_non_blocked" });
  await f.emit(`/group confirm ${stale}`);
  assert.match(f.channel.sentMessages.at(-1)!.text, /权限已变化/);
  assert.equal(f.service.roleForSender(f.routeKey, "ou_other"), "member");
  await f.emit("/group block ou_super", "ou_admin");
  const invalid = f.channel.sentMessages.at(-1)!.text.match(/confirm ([a-f0-9]+)/)![1];
  await f.emit(`/group confirm ${invalid}`, "ou_admin");
  assert.equal(f.service.roleForSender(f.routeKey, "ou_super"), "super_admin");
});

test("group approval IDs are preserved, multiple pending requires ID and cross-route IDs fail", async (t) => {
  const f = await fixture(t);
  const first = f.approval(); const second = f.approval(); const foreign = f.approval("ou_member", "elsewhere");
  assert.match(first.approvalKey, /^g/);
  assert.match(f.approvals.formatForGroup(first), new RegExp(`/OK ${first.approvalKey}`));
  assert.doesNotMatch(f.approvals.formatForGroup(first), /\/P /);
  await f.emit("/OK", "ou_admin"); assert.equal(f.codex.resolvedApprovals.length, 0);
  await f.emit(`/OK ${foreign.approvalKey}`, "ou_admin"); assert.equal(f.codex.resolvedApprovals.length, 0);
  await f.emit(`/OK ${first.approvalKey}`, "ou_member"); assert.equal(f.codex.resolvedApprovals.length, 0);
  await f.emit(`/OK ${first.approvalKey}`, "ou_admin");
  assert.equal(f.codex.resolvedApprovals[0].approvalKey, first.approvalKey);
  assert.equal(first.resolvedBy, "ou_admin"); assert.ok(first.resolvedAt);
  await f.emit(`/NO ${second.approvalKey}`, "ou_admin");
  assert.equal(f.codex.resolvedApprovals[1].decision, "deny");
  assert.equal(foreign.status, "pending");
});

test("group approvals serialize duplicate actors and distinguish known-unsent from uncertain failure", async (t) => {
  const f = await fixture(t);
  const pending = f.approval();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  f.codex.resolveApproval = async () => { calls++; entered(); await wait; };
  const resolving = f.emit(`/OK ${pending.approvalKey}`, "ou_admin");
  await started;
  assert.equal(pending.status, "resolving");
  await f.emit(`/NO ${pending.approvalKey}`, "ou_super");
  assert.equal(calls, 1); release(); await resolving;
  assert.equal(pending.status, "resolved");
  const uncertain = f.approval();
  f.codex.resolveApproval = async () => { calls++; throw new Error("connection lost"); };
  await f.emit(`/OK ${uncertain.approvalKey}`, "ou_admin");
  assert.equal(uncertain.status, "uncertain");
  await f.emit(`/OK ${uncertain.approvalKey}`, "ou_super"); assert.equal(calls, 2);
  const retryable = f.approval();
  f.codex.resolveApproval = async () => { throw Object.assign(new Error("not sent"), { definitelyNotSent: true }); };
  await f.emit(`/OK ${retryable.approvalKey}`, "ou_admin"); assert.equal(retryable.status, "pending");
  f.service.mutate(f.routeKey, local, { action: "admin_remove", target: "ou_admin" });
  await f.emit(`/OK ${retryable.approvalKey}`, "ou_admin"); assert.equal(retryable.status, "pending");
});

test("open approval does not permit member exports, blocked requesters approval, or missing-super bypass", async (t) => {
  const f = await fixture(t);
  f.service.mutate(f.routeKey, local, { action: "approval", policy: "any_non_blocked" });
  const pending = f.approval();
  await f.emit(`/OK ${pending.approvalKey}`, "ou_other"); assert.equal(pending.status, "resolved");
  await f.emit("/sendfile report", "ou_other"); assert.equal(f.codex.runs.length, 0);
  const blocked = f.approval();
  f.service.mutate(f.routeKey, local, { action: "block", target: "ou_member" });
  await f.emit(`/OK ${blocked.approvalKey}`, "ou_admin"); assert.equal(blocked.status, "pending");
  await f.emit(`/NO ${blocked.approvalKey}`, "ou_admin"); assert.equal(blocked.status, "resolved");
  const missing = f.approval("ou_other");
  f.state.upsertGroupAccess({ ...f.service.get(f.routeKey)!, superAdmin: undefined });
  await f.emit(`/OK ${missing.approvalKey}`, "ou_other"); assert.equal(missing.status, "pending");
});

test("shared media retains source, drops blocked sources and does not discard other members", async (t) => {
  const f = await fixture(t);
  await f.channel.emitAttachment([{ id: "a", type: "image", localPath: "/tmp/member-image.png" }], { ...group, senderId: "ou_member" });
  await f.channel.emitAttachment([{ id: "b", type: "file", localPath: "/tmp/other-report.txt" }], { ...group, senderId: "ou_other" });
  assert.match(f.channel.sentMessages.at(-1)!.text, /群聊共享待处理附件/);
  f.service.mutate(f.routeKey, local, { action: "block", target: "ou_member" });
  await f.emit("解释附件", "ou_admin"); await f.bridge.waitForIdle();
  assert.doesNotMatch(f.codex.runs.at(-1)!.prompt, /member-image/);
  assert.match(f.codex.runs.at(-1)!.prompt, /other-report/);
  assert.match(f.codex.runs.at(-1)!.prompt, /其他成员 发来的文件/);
});

test("scheduler rechecks queued sender after a block", async (t) => {
  const scheduler = new LimitedTurnScheduler(1);
  let release!: () => void;
  const held = scheduler.run({ routeKey: "held", enqueuedAt: new Date().toISOString() }, () => new Promise<void>((resolve) => { release = resolve; }));
  const f = await fixture(t, new MockCodexAdapter(), { turnScheduler: scheduler });
  await f.emit("blocked queued request", "ou_member");
  await f.emit("allowed queued request", "ou_other");
  f.service.mutate(f.routeKey, local, { action: "block", target: "ou_member" });
  release(); await held; await f.bridge.waitForIdle();
  assert.deepEqual(f.codex.runs.map((r) => r.prompt), ["其他成员补充：allowed queued request"]);
});

test("file output uses the initiating admin, not the latest speaker, and stops after revocation", async (t) => {
  class FileCodex extends MockCodexAdapter {
    output = "";
    beforeFinal?: () => Promise<void>;
    override async *run(sessionId: string, _input: CodexPromptInput): AsyncIterable<CodexEvent> {
      yield { type: "turn.started", sessionId, turnId: "file-turn", startedAt: new Date().toISOString() };
      await this.beforeFinal?.();
      yield { type: "assistant.completed", sessionId, turnId: "file-turn", text: this.output };
      yield { type: "turn.completed", sessionId, turnId: "file-turn" };
    }
  }
  const codex = new FileCodex(); const f = await fixture(t, codex);
  const file = path.join(f.root, "report.txt"); fs.writeFileSync(file, "report");
  codex.output = `done\nBRIDGE_SEND_FILE: ${file}`;
  codex.beforeFinal = () => f.emit("/whoami", "ou_member");
  await f.emit("/sendfile report", "ou_admin"); await f.bridge.waitForIdle();
  assert.equal(f.channel.sentMedia.length, 1);
  assert.equal(f.channel.sentMedia[0].target.recipient.id, "ou_admin");
  codex.beforeFinal = async () => { f.service.mutate(f.routeKey, local, { action: "admin_remove", target: "ou_admin" }); await f.emit("/whoami", "ou_super"); };
  await f.emit("/sendfile report", "ou_admin"); await f.bridge.waitForIdle();
  assert.equal(f.channel.sentMedia.length, 1);
  assert.match(f.channel.sentMessages.at(-1)!.text, /未发送/);
  assert.ok(f.service.get(f.routeKey)?.audit?.some((a) => a.action === "file_export" && a.outcome === "denied"));
});

test("fake Feishu transport never downloads untrusted, unregistered or blacklisted group media", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-admission-"));
  const factory = new FakeFeishuTransportFactory();
  const channel = new FeishuAdapter({ appId: "cli_test", appSecret: "test", accountId: "work", groupEnabled: true, transportFactory: factory, inboundMediaRootDir: root });
  const state = new MemoryStateStore();
  const bridge = new Bridge({ channel, state, codex: new MockCodexAdapter(), feishuGroupMemberStateRootDir: root });
  t.after(async () => { await bridge.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await bridge.start();
  let sequence = 0;
  const emit = (text?: string) => factory.dispatcher.emitReceive(sampleFeishuTextEvent({ app_id: "cli_test", sender: { sender_id: { open_id: "ou_member" }, sender_type: "user" }, message: { message_id: `m${++sequence}`, chat_id: "oc_room", chat_type: "group", message_type: text ? "text" : "file", content: JSON.stringify(text ? { text: `@_bot ${text}` } : { file_key: "file_in", file_name: "in.txt" }), mentions: [{ key: "@_bot", id: { open_id: "ou_bot" }, name: "Bot" }] } }));
  await emit(); assert.equal(factory.client.messageResourceGetPayloads.length, 0);
  const route = trusted("feishu"); state.trustRoute(route);
  const service = new GroupAccessService({ state }); service.ensureForTrustedRoute(route);
  await emit(); assert.equal(factory.client.messageResourceGetPayloads.length, 0);
  await emit("/name 成员");
  factory.client.resourceBuffers.set("file_in", Buffer.from("hello"));
  await emit(); assert.equal(factory.client.messageResourceGetPayloads.length, 1);
  service.mutate(route.routeKey, local, { action: "block", target: "ou_member" });
  await emit(); assert.equal(factory.client.messageResourceGetPayloads.length, 1);
});

test("unrelated mock group keeps its existing commands and does not acquire Feishu permissions by id prefix", async (t) => {
  const channel = new MockChannelAdapter({ id: "feishu-like-but-unmanaged", media: true });
  const codex = new MockCodexAdapter(); const state = new MemoryStateStore();
  const bridge = new Bridge({ channel, codex, state }); t.after(() => bridge.stop());
  await bridge.start();
  await channel.emitText("/sendfile report", { ...group, senderId: "anyone" }); await bridge.waitForIdle();
  assert.equal(codex.runs.length, 1);
  assert.equal(state.listGroupAccess().length, 0);
});

test("debounced steer filters blocked speakers while preserving the other speaker in a mixed batch", async (t) => {
  let release!: () => void;
  let entered!: () => void;
  let steered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const delivered = new Promise<void>((resolve) => { steered = resolve; });
  class SteerCodex extends MockCodexAdapter {
    steers: CodexPromptInput[] = [];
    override async getStatus() { return { type: "running" as const, turnId: "steer-turn" }; }
    override async *run(sessionId: string): AsyncIterable<CodexEvent> {
      yield { type: "turn.started", sessionId, turnId: "steer-turn" };
      entered(); await hold;
      yield { type: "turn.completed", sessionId, turnId: "steer-turn" };
    }
    async steer(_sessionId: string, input: CodexPromptInput) { this.steers.push(input); steered(); }
  }
  const codex = new SteerCodex();
  const f = await fixture(t, codex, { steerDebounceMs: 40 });
  t.after(() => release());
  await f.emit("initial"); await started;
  await f.emit("discard this", "ou_member");
  await f.emit("keep this", "ou_other");
  f.service.mutate(f.routeKey, local, { action: "block", target: "ou_member" });
  await Promise.race([delivered, new Promise((_, reject) => setTimeout(() => reject(new Error("steer was not delivered")), 1000))]);
  assert.doesNotMatch(JSON.stringify(codex.steers), /discard this/);
  assert.match(JSON.stringify(codex.steers), /其他成员补充：keep this/);
  release(); await f.bridge.waitForIdle();
});

test("queued shared attachments are rechecked after another member has already consumed the pool", async (t) => {
  const scheduler = new LimitedTurnScheduler(1);
  let release!: () => void;
  const held = scheduler.run({ routeKey: "held", enqueuedAt: new Date().toISOString() }, () => new Promise<void>((resolve) => { release = resolve; }));
  const f = await fixture(t, new MockCodexAdapter(), { turnScheduler: scheduler });
  await f.channel.emitAttachment([{ id: "a", type: "image", localPath: "/tmp/blocked-before-run.png" }], { ...group, senderId: "ou_member" });
  await f.channel.emitAttachment([{ id: "b", type: "file", localPath: "/tmp/allowed-before-run.txt" }], { ...group, senderId: "ou_other" });
  await f.emit("处理这些附件", "ou_admin");
  f.service.mutate(f.routeKey, local, { action: "block", target: "ou_member" });
  release(); await held; await f.bridge.waitForIdle();
  assert.doesNotMatch(f.codex.runs[0].prompt, /blocked-before-run/);
  assert.match(f.codex.runs[0].prompt, /allowed-before-run/);
});

test("group approvals cannot use old-run IDs and uncertain responses reconcile with protocol notification", async (t) => {
  const f = await fixture(t);
  const old = new ApprovalManager().create(f.routeKey, "ou_member", { kind: "command", sessionId: "s", turnId: "t", itemId: "i" }, true);
  const current = f.approval();
  await f.emit(`/OK ${old.approvalKey}`, "ou_admin");
  assert.equal(current.status, "pending"); assert.equal(f.codex.resolvedApprovals.length, 0);
  current.adapterApprovalId = "rpc-uncertain";
  f.codex.resolveApproval = async () => { throw new Error("lost response"); };
  await f.emit(`/OK ${current.approvalKey}`, "ou_admin");
  assert.equal(current.status, "uncertain");
  f.approvals.resolveAdapterApproval(f.routeKey, "rpc-uncertain");
  assert.equal(current.status, "resolved");
});

test("group management resolves real mentions by Open ID and rejects names, bot mentions and multiple targets", async (t) => {
  const f = await fixture(t);
  const mentioned = async (text: string, mentions: Array<{ key: string; openId?: string; name: string; isBot: boolean; isMentionAll: boolean }>) => f.bridge.handleMessage({
    id: `mention-${Math.random()}`, routeKey: f.routeKey, channelId: f.channel.id, accountId: "work", sender: { id: "ou_super" }, conversation: { id: group.conversationId, kind: "group" }, timestamp: new Date().toISOString(), text,
    raw: { chatCodex: { feishu: { group: { mentions, mentionedBot: true } } } },
  });
  const bot = { key: "@_bot", openId: "ou_bot", name: "Bot", isBot: true, isMentionAll: false };
  const person = { key: "@_person", openId: "ou_named", name: "同名", isBot: false, isMentionAll: false };
  await mentioned("/group admin add @同名", [bot, person]);
  const token = f.channel.sentMessages.at(-1)!.text.match(/confirm ([a-f0-9]+)/)![1];
  await f.emit(`/group confirm ${token}`);
  assert.equal(f.service.roleForSender(f.routeKey, "ou_named"), "admin");
  for (const [text, mentions] of [["/group admin add 同名", [bot]], ["/group admin add @Bot", [bot]], ["/group admin add @同名 @另一个", [bot, person, { ...person, openId: "ou_other_id" }]]] as const) {
    await mentioned(text, [...mentions]);
    assert.doesNotMatch(f.channel.sentMessages.at(-1)!.text, /待确认/);
  }
  assert.throws(() => f.service.mutate(f.routeKey, local, { action: "admin_add", target: "ou_bot" }), /机器人/);
});

test("queued sendfile is cancelled after admin revocation before Codex starts", async (t) => {
  const scheduler = new LimitedTurnScheduler(1);
  let release!: () => void;
  const held = scheduler.run({ routeKey: "held", enqueuedAt: new Date().toISOString() }, () => new Promise<void>((resolve) => { release = resolve; }));
  const f = await fixture(t, new MockCodexAdapter(), { turnScheduler: scheduler });
  await f.emit("/sendfile report", "ou_admin");
  f.service.mutate(f.routeKey, local, { action: "admin_remove", target: "ou_admin" });
  release(); await held; await f.bridge.waitForIdle();
  assert.equal(f.codex.runs.length, 0);
  assert.equal(f.channel.sentMedia.length, 0);
});

test("privileged command rechecks authority after asynchronous busy/status lookup", async (t) => {
  const f = await fixture(t);
  await f.emit("first"); await f.bridge.waitForIdle();
  const binding = f.state.getBinding(f.routeKey)!;
  const original = f.codex.getStatus.bind(f.codex);
  let changed = false;
  f.codex.getStatus = async (id) => {
    if (!changed) { changed = true; f.service.mutate(f.routeKey, local, { action: "transfer", target: "ou_other" }); }
    return original(id);
  };
  await f.emit("/permission full", "ou_super");
  assert.equal(f.codex.getRunPolicy(binding.sessionId).permissionMode, "approval");
  assert.match(f.channel.sentMessages.at(-1)!.text, /仅超级管理员/);
});
