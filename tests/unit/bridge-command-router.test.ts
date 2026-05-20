import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { BridgeCommandRouter, type BridgeCommandHandlers } from "../../src/bridge/command-router.js";
import { BridgeDelivery } from "../../src/bridge/delivery.js";
import { SilentLogger } from "../../src/logging/logger.js";
import type { ChannelRegistry } from "../../src/channels/registry.js";
import type { ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";
import { DEFAULT_CHANNEL_DELIVERY_POLICY, normalizeChannelDeliveryPolicy } from "../../src/protocol/delivery-policy.js";

test("BridgeCommandRouter sends unknown command help text", async () => {
  const fixture = routerFixture();
  await fixture.router.handle(message(), target(), "missing", [], "/missing");
  assert.equal(fixture.sent.at(-1), "未知命令: /missing\n发送 /help 查看可用命令。");
});

test("BridgeCommandRouter handles refresh commands before normal dispatch", async () => {
  const fixture = routerFixture({
    deliveryPolicyFor: () => normalizeChannelDeliveryPolicy({
      ...DEFAULT_CHANNEL_DELIVERY_POLICY,
      refreshCommands: [{ command: "fff", description: "刷新", silent: false, replyText: "已静默刷新。" }],
    }),
  });
  await fixture.router.handle(message(), target(), "fff", [], "/fff");
  assert.equal(fixture.sent.at(-1), "已静默刷新。");
  assert.equal(fixture.calls.model, 0);
});

test("BridgeCommandRouter rejects semantic mutations while route is busy", async () => {
  const fixture = routerFixture({ busy: true });
  await fixture.router.handle(message(), target(), "model", ["gpt-next", "xhigh"], "/model gpt-next xhigh");
  assert.match(fixture.sent.at(-1) ?? "", /当前对话的 Codex 正在执行/);
  assert.equal(fixture.calls.model, 0);
});

test("BridgeCommandRouter routes compact command", async () => {
  const fixture = routerFixture();
  await fixture.router.handle(message(), target(), "compact", [], "/compact");
  assert.equal(fixture.calls.compact, 1);
});

test("BridgeCommandRouter rejects compact while route is busy", async () => {
  const fixture = routerFixture({ busy: true });
  await fixture.router.handle(message(), target(), "compact", [], "/compact");
  assert.match(fixture.sent.at(-1) ?? "", /当前对话的 Codex 正在执行/);
  assert.equal(fixture.calls.compact, 0);
});

test("BridgeCommandRouter passes /new args and raw text to the handler", async () => {
  const fixture = routerFixture();
  await fixture.router.handle(message(), target(), "new", ["chat", "hello"], "/new chat hello");
  assert.equal(fixture.calls.createNewSession, 1);
  assert.deepEqual(fixture.newSessionCall?.args, ["chat", "hello"]);
  assert.equal(fixture.newSessionCall?.rawText, "/new chat hello");
});

test("BridgeCommandRouter rejects /new chat while route is busy", async () => {
  const fixture = routerFixture({ busy: true });
  await fixture.router.handle(message(), target(), "new", ["chat"], "/new chat");
  assert.match(fixture.sent.at(-1) ?? "", /当前对话的 Codex 正在执行/);
  assert.equal(fixture.calls.createNewSession, 0);
});

test("BridgeCommandRouter lets non-mutating progress commands dispatch", async () => {
  const fixture = routerFixture();
  await fixture.router.handle(message(), target(), "progress", ["silent"], "/progress silent");
  assert.equal(fixture.calls.progressMode, 1);
});

test("BridgeCommandRouter routes context refresh command and treats changes as busy mutations", async () => {
  const fixture = routerFixture();
  await fixture.router.handle(message(), target(), "context-refresh", ["reload"], "/context-refresh reload");
  assert.equal(fixture.calls.contextRefresh, 1);

  const busy = routerFixture({ busy: true });
  await busy.router.handle(message(), target(), "context-refresh", ["reload"], "/context-refresh reload");
  assert.equal(busy.calls.contextRefresh, 0);
  assert.match(busy.sent.at(-1) ?? "", /上下文刷新/);
});

test("BridgeCommandRouter lets context refresh status dispatch while busy", async () => {
  const fixture = routerFixture({ busy: true });
  await fixture.router.handle(message(), target(), "context-refresh", [], "/context-refresh");
  assert.equal(fixture.calls.contextRefresh, 1);
});

test("BridgeCommandRouter routes group receive command without route busy guard", async () => {
  const fixture = routerFixture({ busy: true });
  await fixture.router.handle(message(), target(), "group", ["on"], "/group on");
  assert.equal(fixture.calls.groupReceive, 1);
  assert.deepEqual(fixture.groupReceiveCall?.args, ["on"]);
  assert.equal(fixture.groupReceiveCall?.commandName, "group");
});

test("BridgeCommandRouter honors disabled progress command policy", async () => {
  const fixture = routerFixture({
    deliveryPolicyFor: () => normalizeChannelDeliveryPolicy({
      ...DEFAULT_CHANNEL_DELIVERY_POLICY,
      progressCommand: "disabled",
      progressDisabledMessage: "当前渠道禁用进度。",
      refreshCommands: [],
    }),
  });
  await fixture.router.handle(message(), target(), "progress", ["detailed"], "/progress detailed");
  assert.equal(fixture.sent.at(-1), "当前渠道禁用进度。");
  assert.equal(fixture.calls.progressMode, 0);
});

function routerFixture(options: {
  busy?: boolean;
  deliveryPolicyFor?: () => ReturnType<typeof normalizeChannelDeliveryPolicy>;
} = {}) {
  const sent: string[] = [];
  const calls = {
    createNewSession: 0,
    model: 0,
    progressMode: 0,
    contextRefresh: 0,
    groupReceive: 0,
    compact: 0,
  };
  let newSessionCall: { args: string[]; rawText: string } | undefined;
  let groupReceiveCall: { args: string[]; commandName: string } | undefined;
  const delivery = new BridgeDelivery({
    channels: {
      sendText: async (_target: ChannelTarget, text: string) => {
        sent.push(text);
        return { channelId: "mock", messageId: `m-${sent.length}`, deliveredAt: new Date().toISOString() };
      },
    } as unknown as ChannelRegistry,
    approvals: new ApprovalManager(),
    logger: new SilentLogger(),
    approvalSendRetryDelayMs: 1,
  });
  const handlers: BridgeCommandHandlers = {
    help: () => "help",
    createNewSession: async (_message, _target, args, rawText) => {
      calls.createNewSession += 1;
      newSessionCall = { args, rawText };
    },
    status: async () => "status",
    sessions: async () => "sessions",
    resumeOrUseSession: async () => undefined,
    cancel: async () => undefined,
    whoami: () => "whoami",
    debug: async () => "debug",
    collaborationMode: async () => undefined,
    goal: async () => undefined,
    progressMode: async () => {
      calls.progressMode += 1;
    },
    contextRefresh: async () => {
      calls.contextRefresh += 1;
    },
    groupReceive: async (_message, _target, args, commandName) => {
      calls.groupReceive += 1;
      groupReceiveCall = { args, commandName };
    },
    groupName: async () => undefined,
    sendFile: async () => undefined,
    model: async () => {
      calls.model += 1;
    },
    permission: async () => undefined,
    approval: async () => undefined,
    stop: async () => undefined,
    compact: async () => {
      calls.compact += 1;
    },
  };
  return {
    sent,
    calls,
    get newSessionCall() {
      return newSessionCall;
    },
    get groupReceiveCall() {
      return groupReceiveCall;
    },
    router: new BridgeCommandRouter({
      logger: new SilentLogger(),
      delivery,
      deliveryPolicyFor: options.deliveryPolicyFor ?? (() => DEFAULT_CHANNEL_DELIVERY_POLICY),
      isRouteExecutionBusy: async () => options.busy ?? false,
      handlers,
    }),
  };
}

function message(): ChannelMessage {
  return {
    id: "message-1",
    routeKey: "mock:default:direct:user",
    channelId: "mock",
    sender: { id: "user" },
    conversation: { id: "user", kind: "direct" },
    text: "",
    timestamp: new Date().toISOString(),
  };
}

function target(): ChannelTarget {
  return {
    channelId: "mock",
    routeKey: "mock:default:direct:user",
    conversation: { id: "user", kind: "direct" },
    recipient: { id: "user" },
  };
}
