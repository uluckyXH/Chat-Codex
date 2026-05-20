import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BindingActions, formatOwnerRouteLabel } from "../../src/cli/actions/binding-actions.js";
import type { DiscoveredCodexSession } from "../../src/codex/codex-cli.js";
import type { ChannelMessage } from "../../src/protocol/channel.js";
import { FileStateStore } from "../../src/state/file-state-store.js";
import type { CodexSession } from "../../src/codex/types.js";

test("BindingActions lists selectable sessions and excludes sessions owned by another route", () => {
  const rootDir = tempStateDir();
  const state = new FileStateStore({ rootDir });
  const firstRoute = "feishu-main:default:direct:oc_first";
  const secondRoute = "feishu-main:default:direct:oc_second";
  state.recordRouteMessage(feishuMessage(firstRoute, "张三", "ou_first", "oc_first"));
  state.recordRouteMessage(feishuMessage(secondRoute, "李四", "ou_second", "oc_second"));
  state.bindSession(secondRoute, codexSession("session-owned"));

  const actions = new BindingActions(state, {
    cwd: "/repo",
    discoverSessions: () => [
      discoveredSession("session-free", "可用会话"),
      discoveredSession("session-owned", "已占用会话"),
    ],
    findSessionById: (id) => id === "session-free" ? discoveredSession("session-free", "可用会话") : undefined,
  });

  const choices = actions.listSessionChoices(firstRoute);

  assert.deepEqual(choices.selectable.map((choice) => choice.id), ["session-free"]);
  assert.deepEqual(choices.unavailable.map((choice) => choice.id), ["session-owned"]);
  assert.equal(choices.unavailable[0].ownerLabel, "飞书 / default / ou_second");
  assert.equal(formatOwnerRouteLabel(state, secondRoute), "飞书 / default / ou_second");
  const text = actions.formatSessionChoices(firstRoute, choices);
  assert.match(text, /1\. 可用/);
  assert.match(text, /最近 05-16/);
  assert.match(text, /m\. 手动输入 Session ID/);
  assert.doesNotMatch(text, /2\. 手动输入 Session ID/);
});

test("BindingActions binds by valid session id and returns recoverable error for invalid id", () => {
  const rootDir = tempStateDir();
  const state = new FileStateStore({ rootDir });
  const routeKey = "feishu-main:default:direct:oc_first";
  state.recordRouteMessage(feishuMessage(routeKey, "张三", "ou_first", "oc_first"));
  const sessions = [discoveredSession("session-free", "可用会话")];
  const actions = new BindingActions(state, {
    cwd: "/repo",
    discoverSessions: () => sessions,
    findSessionById: (id) => sessions.find((session) => session.id === id),
  });

  const missing = actions.bindExistingSession(routeKey, "missing-session");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, "not_found");
  assert.equal(state.getBinding(routeKey), undefined);

  const bound = actions.bindExistingSession(routeKey, "session-free");
  assert.equal(bound.ok, true);
  assert.equal(state.getBinding(routeKey)?.sessionId, "session-free");
  assert.equal(actions.getBinding(routeKey)?.activeSession?.title, "可用会话");
});

test("BindingActions creates new bindings and unbinds active sessions", () => {
  const rootDir = tempStateDir();
  const state = new FileStateStore({ rootDir });
  const routeKey = "feishu-main:default:direct:oc_first";
  state.recordRouteMessage(feishuMessage(routeKey, "张三", "ou_first", "oc_first"));
  const actions = new BindingActions(state, { cwd: "/repo" });

  const bound = actions.bindNewSession(routeKey, codexSession("session-new"));

  assert.equal(bound.ok, true);
  assert.equal(state.getBinding(routeKey)?.sessionId, "session-new");
  assert.equal(state.getSessionOwner("session-new")?.ownerRouteKey, routeKey);
  assert.equal(actions.getBinding(routeKey)?.label, "飞书 / default / ou_first");

  const unbound = actions.unbindSession(routeKey);

  assert.equal(unbound.ok, true);
  assert.equal(state.getBinding(routeKey), undefined);
  assert.equal(state.getSessionOwner("session-new"), undefined);
  assert.equal(actions.getBinding(routeKey)?.activeSession, undefined);
});

test("BindingActions labels sessions reserved by pending Weixin binding", () => {
  const rootDir = tempStateDir();
  const state = new FileStateStore({ rootDir });
  const routeKey = "feishu-main:default:direct:oc_first";
  state.recordRouteMessage(feishuMessage(routeKey, "张三", "ou_first", "oc_first"));
  state.setPendingBinding({
    id: "weixin-primary-weixin-wx-account",
    channelId: "weixin-wx-account",
    accountId: "wx-account",
    conversationKind: "direct",
    label: "微信 / wx-account / 主聊天",
    binding: { type: "existing", sessionId: "session-reserved" },
  });
  const actions = new BindingActions(state, {
    discoverSessions: () => [discoveredSession("session-reserved", "预留会话")],
    findSessionById: (id) => id === "session-reserved" ? discoveredSession("session-reserved", "预留会话") : undefined,
  });

  const choices = actions.listSessionChoices(routeKey);

  assert.equal(choices.selectable.length, 0);
  assert.equal(choices.unavailable[0].ownerLabel, "微信 / wx-account / 主聊天（待生效）");
});

test("BindingActions persists session-level permission settings", () => {
  const rootDir = tempStateDir();
  const state = new FileStateStore({ rootDir });
  const actions = new BindingActions(state);

  actions.setSessionPermission("session-policy", { permissionMode: "full" });

  const reloaded = new FileStateStore({ rootDir });
  assert.equal(reloaded.getSessionRunPolicy("session-policy")?.permissionMode, "full");
});

function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-binding-actions-"));
}

function discoveredSession(id: string, title: string): DiscoveredCodexSession {
  return {
    id,
    threadName: title,
    cwd: "/repo",
    updatedAt: "2026-05-16T00:00:00.000Z",
  };
}

function codexSession(id: string): CodexSession {
  return {
    id,
    cwd: "/repo",
    title: `Session ${id}`,
    createdAt: "2026-05-16T00:00:00.000Z",
  };
}

function feishuMessage(routeKey: string, name: string, openId: string, chatId: string): ChannelMessage {
  return {
    id: `om_${chatId}`,
    routeKey,
    channelId: "feishu-main",
    accountId: "default",
    sender: { id: openId, displayName: name },
    conversation: { id: chatId, kind: "direct", displayName: "飞书私聊" },
    text: "你好",
    timestamp: "2026-05-16T00:00:00.000Z",
    raw: {
      tenant_key: "tenant_a",
      sender: {
        sender_id: {
          open_id: openId,
        },
        sender_type: "user",
        tenant_key: "tenant_a",
      },
      message: {
        message_id: `om_${chatId}`,
        chat_id: chatId,
      },
    },
  };
}
