import test from "node:test";
import assert from "node:assert/strict";
import { handleGroupReceiveCommand } from "../../src/bridge/commands/group-receive-command.js";
import type { BridgeDelivery } from "../../src/bridge/delivery.js";
import type { ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";
import { MemoryStateStore } from "../../src/state/memory-state-store.js";
import type { TrustedRouteRecord } from "../../src/state/persistent-state-types.js";

test("handleGroupReceiveCommand enables group receive from a trusted Feishu direct route", async () => {
  const fixture = commandFixture();
  fixture.state.trustRoute(trustedRoute(fixture.message));

  await handleGroupReceiveCommand(fixture.deps, fixture.message, fixture.target, ["on"], "group");

  assert.deepEqual(fixture.setCalls, [{ channelId: fixture.message.channelId, enabled: true }]);
  assert.match(fixture.sent.at(-1) ?? "", /已开启飞书群聊接收/);
});

test("handleGroupReceiveCommand keeps the hidden /grop alias for disabling receive", async () => {
  const fixture = commandFixture();
  fixture.state.trustRoute(trustedRoute(fixture.message));

  await handleGroupReceiveCommand(fixture.deps, fixture.message, fixture.target, ["off"], "grop");

  assert.deepEqual(fixture.setCalls, [{ channelId: fixture.message.channelId, enabled: false }]);
  assert.match(fixture.sent.at(-1) ?? "", /已关闭飞书群聊接收/);
});

test("handleGroupReceiveCommand rejects untrusted private chats and group chats", async () => {
  const untrusted = commandFixture();
  await handleGroupReceiveCommand(untrusted.deps, untrusted.message, untrusted.target, ["on"], "group");

  assert.deepEqual(untrusted.setCalls, []);
  assert.match(untrusted.sent.at(-1) ?? "", /还没有完成.*配对/);

  const group = commandFixture({
    routeKey: "feishu-default:default:group:oc_group",
    conversationKind: "group",
  });
  group.state.trustRoute(trustedRoute(group.message));
  await handleGroupReceiveCommand(group.deps, group.message, group.target, ["on"], "group");

  assert.deepEqual(group.setCalls, []);
  assert.match(group.sent.at(-1) ?? "", /只能在已配对的飞书私聊/);
});

function commandFixture(options: { routeKey?: string; conversationKind?: "direct" | "group" } = {}) {
  const sent: string[] = [];
  const setCalls: Array<{ channelId: string; enabled: boolean }> = [];
  const state = new MemoryStateStore();
  const message = feishuMessage(options);
  const target = feishuTarget(message);
  const deps = {
    state,
    delivery: {
      sendText: async (_target: ChannelTarget, text: string) => {
        sent.push(text);
      },
    } as BridgeDelivery,
    channelCapabilities: {
      setGroupEnabled: (channelId: string, enabled: boolean) => {
        setCalls.push({ channelId, enabled });
        return { ok: true as const, enabled };
      },
    },
  };
  return { deps, state, message, target, sent, setCalls };
}

function feishuMessage(options: { routeKey?: string; conversationKind?: "direct" | "group" } = {}): ChannelMessage {
  const conversationKind = options.conversationKind ?? "direct";
  const conversationId = conversationKind === "group" ? "oc_group" : "oc_direct";
  const routeKey = options.routeKey ?? `feishu-default:default:${conversationKind}:${conversationId}`;
  return {
    id: "om_group_command",
    routeKey,
    channelId: "feishu-default",
    accountId: "default",
    sender: { id: "ou_user", displayName: "张三" },
    conversation: { id: conversationId, kind: conversationKind, displayName: "飞书私聊" },
    text: "/group on",
    timestamp: "2026-05-19T00:00:00.000Z",
  };
}

function feishuTarget(message: ChannelMessage): ChannelTarget {
  return {
    channelId: message.channelId,
    routeKey: message.routeKey,
    accountId: message.accountId,
    conversation: message.conversation,
    recipient: message.sender,
  };
}

function trustedRoute(message: ChannelMessage): TrustedRouteRecord {
  return {
    routeKey: message.routeKey,
    channelId: message.channelId,
    accountId: message.accountId ?? "default",
    conversationKind: message.conversation.kind,
    conversationId: message.conversation.id,
    displayName: message.conversation.displayName,
    trustedAt: "2026-05-19T00:00:00.000Z",
    trustedBySenderId: message.sender.id,
    trustedBySenderDisplayName: message.sender.displayName,
    trustMethod: "pairing_code",
    createdAt: "2026-05-19T00:00:00.000Z",
    updatedAt: "2026-05-19T00:00:00.000Z",
  };
}
