import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStateStore } from "../../src/state/file-state-store.js";
import { ChannelConfigStore } from "../../src/state/channel-config-store.js";
import { CHAT_CODEX_STATE_DIR_ENV, defaultBridgeStateDir, resolveChatCodexStateRoot } from "../../src/state/state-files.js";
import type { ChannelMessage } from "../../src/protocol/channel.js";
import type { CodexSession } from "../../src/codex/types.js";
import type { BridgeConfigDocument, ChannelAccountCredentialsDocument, ChannelAccountDocument, ChannelInstanceDocument, GroupAccessDocument, PendingBindingsDocument, RoutesDocument, SessionOwnersDocument, SessionPoliciesDocument, TrustedRouteRecord, TrustedRoutesDocument } from "../../src/state/persistent-state-types.js";
import { pendingBindingOwnerRouteKey } from "../../src/state/memory-state-store.js";

test("default state root uses fixed user directory", () => {
  const homeDir = path.join(os.tmpdir(), "chat-codex-home");

  assert.equal(resolveChatCodexStateRoot({ env: {}, homeDir }), path.join(homeDir, ".chat-codex", "state"));
  assert.equal(defaultBridgeStateDir("/tmp/chat-codex-start", {}), path.join(os.homedir(), ".chat-codex", "state", "bridge"));
});

test("FileStateStore and ChannelConfigStore support CHAT_CODEX_STATE_DIR override", () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-codex-state-root-"));
  const cwd = path.join(os.tmpdir(), "chat-codex-start");
  const env = { [CHAT_CODEX_STATE_DIR_ENV]: stateRoot };

  const fileState = new FileStateStore({ cwd, env });
  const configStore = new ChannelConfigStore({ cwd, env });

  assert.equal(fileState.rootDir, path.join(stateRoot, "bridge"));
  assert.equal(configStore.bridgeDir, path.join(stateRoot, "bridge"));
});

test("CHAT_CODEX_STATE_DIR relative override resolves from startup cwd", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "chat-codex-start-"));
  const env = { [CHAT_CODEX_STATE_DIR_ENV]: "runtime-state" };

  assert.equal(defaultBridgeStateDir(cwd, env), path.join(cwd, "runtime-state", "bridge"));
});

test("FileStateStore persists active route binding and session owner", () => {
  const rootDir = tempStateDir();
  const store = new FileStateStore({ rootDir });
  const message = feishuMessage("feishu-main:default:direct:oc_user");
  const session = codexSession("session_one");

  store.recordRouteMessage(message);
  store.bindSession(message.routeKey, session);

  const reloaded = new FileStateStore({ rootDir });
  assert.equal(reloaded.getBinding(message.routeKey)?.sessionId, "session_one");
  assert.equal(reloaded.getSessionOwner("session_one")?.ownerRouteKey, message.routeKey);

  const routes = readJson<RoutesDocument>(path.join(rootDir, "routes.json"));
  assert.equal(routes.routes[0].routeKey, message.routeKey);
  assert.equal(routes.routes[0].conversationId, "oc_user");
  assert.equal(routes.routes[0].activeSessionId, "session_one");
  assert.equal(routes.routes[0].identity?.openId, "ou_user");
  assert.equal(routes.routes[0].identity?.lastSenderDisplayName, "飞书用户");
  assert.equal(routes.routes[0].identity?.tenantKey, "tenant_a");

  const owners = readJson<SessionOwnersDocument>(path.join(rootDir, "session-owners.json"));
  assert.deepEqual(owners.owners.map((owner) => [owner.sessionId, owner.ownerRouteKey]), [["session_one", message.routeKey]]);
});

test("FileStateStore keeps session owner global across routes after reload", () => {
  const rootDir = tempStateDir();
  const firstRoute = "feishu-main:default:direct:oc_user_a";
  const secondRoute = "weixin-main:wx:direct:wx_user_b";
  const store = new FileStateStore({ rootDir });
  store.recordRouteMessage(feishuMessage(firstRoute));
  store.bindSession(firstRoute, codexSession("session_shared"));

  const reloaded = new FileStateStore({ rootDir });
  const conflict = reloaded.claimSessionOwner(secondRoute, "session_shared");

  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.reason, "owned_by_other_route");
    assert.equal(conflict.owner.ownerRouteKey, firstRoute);
  }
});

test("FileStateStore persists session run policy", () => {
  const rootDir = tempStateDir();
  const store = new FileStateStore({ rootDir });

  store.setSessionRunPolicy("session_policy", { permissionMode: "full" });

  const reloaded = new FileStateStore({ rootDir });
  assert.equal(reloaded.getSessionRunPolicy("session_policy")?.permissionMode, "full");
  const policies = readJson<SessionPoliciesDocument>(path.join(rootDir, "session-policies.json"));
  assert.deepEqual(policies.policies.map((policy) => [policy.sessionId, policy.runPolicy.permissionMode]), [["session_policy", "full"]]);
});

test("FileStateStore persists route unbind and releases owner", () => {
  const rootDir = tempStateDir();
  const routeKey = "feishu-main:default:direct:oc_user";
  const store = new FileStateStore({ rootDir });
  store.recordRouteMessage(feishuMessage(routeKey));
  store.bindSession(routeKey, codexSession("session_unbind"));

  const result = store.unbindSession(routeKey);

  assert.equal(result.ok, true);
  const reloaded = new FileStateStore({ rootDir });
  assert.equal(reloaded.getBinding(routeKey), undefined);
  assert.equal(reloaded.getSessionOwner("session_unbind"), undefined);
  const routes = readJson<RoutesDocument>(path.join(rootDir, "routes.json"));
  assert.equal(routes.routes[0].activeSessionId, undefined);
});

test("FileStateStore persists pending bindings and reserves existing sessions", () => {
  const rootDir = tempStateDir();
  const store = new FileStateStore({ rootDir });

  store.setPendingBinding({
    id: "weixin-primary-weixin-wx-account",
    channelId: "weixin-wx-account",
    accountId: "wx-account",
    conversationKind: "direct",
    label: "微信 / wx-account / 主聊天",
    binding: { type: "existing", sessionId: "session_pending" },
  });

  const reloaded = new FileStateStore({ rootDir });
  assert.equal(reloaded.listPendingBindings()[0].binding.type, "existing");
  assert.equal(reloaded.getSessionOwner("session_pending")?.ownerRouteKey, pendingBindingOwnerRouteKey("weixin-primary-weixin-wx-account"));

  const conflict = reloaded.claimSessionOwner("feishu-main:default:direct:oc_user", "session_pending");
  assert.equal(conflict.ok, false);

  const pending = readJson<PendingBindingsDocument>(path.join(rootDir, "pending-bindings.json"));
  assert.equal(pending.pending[0].label, "微信 / wx-account / 主聊天");
});

test("FileStateStore persists trusted routes and refreshes last seen metadata", () => {
  const rootDir = tempStateDir();
  const routeKey = "feishu-main:default:direct:oc_user";
  const store = new FileStateStore({ rootDir });
  const trusted = trustedRoute(routeKey);

  store.trustRoute(trusted);
  store.recordRouteMessage({
    ...feishuMessage(routeKey),
    timestamp: "2026-05-17T01:02:03.000Z",
    conversation: { id: "oc_user", kind: "direct", displayName: "新的飞书私聊名" },
  });

  const reloaded = new FileStateStore({ rootDir });
  assert.equal(reloaded.isRouteTrusted(routeKey), true);
  assert.equal(reloaded.listTrustedRoutes()[0]?.lastSeenAt, "2026-05-17T01:02:03.000Z");
  assert.equal(reloaded.listTrustedRoutes()[0]?.displayName, "新的飞书私聊名");

  const doc = readJson<TrustedRoutesDocument>(path.join(rootDir, "trusted-routes.json"));
  assert.equal(doc.trustedRoutes[0]?.routeKey, routeKey);

  const revoked = reloaded.revokeRouteTrust(routeKey);
  assert.equal(revoked?.routeKey, routeKey);
  assert.equal(new FileStateStore({ rootDir }).isRouteTrusted(routeKey), false);
});

test("FileStateStore persists group access records", () => {
  const rootDir = tempStateDir();
  const routeKey = "feishu-main:default:group:oc_group";
  const store = new FileStateStore({ rootDir });

  store.upsertGroupAccess({
    routeKey,
    channelId: "feishu-main",
    accountId: "default",
    conversationKind: "group",
    conversationId: "oc_group",
    superAdmin: {
      senderId: "ou_admin",
      displayName: "管理员",
      source: "pairing",
      createdAt: "2026-05-21T00:00:00.000Z",
    },
    blockedSenders: [],
    knownPrincipals: [{
      senderId: "ou_admin",
      displayName: "管理员",
      firstSeenAt: "2026-05-21T00:00:00.000Z",
      lastSeenAt: "2026-05-21T00:00:00.000Z",
      source: "pairing",
    }],
    normalMessagePolicy: "mentioned_non_blocked",
    approvalPolicy: "super_admin_only",
    managementPolicy: "super_admin_only",
    blockedUserBehavior: "silent",
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  });

  const reloaded = new FileStateStore({ rootDir });
  assert.equal(reloaded.getGroupAccess(routeKey)?.superAdmin?.senderId, "ou_admin");
  assert.equal(reloaded.listGroupAccess()[0]?.approvalPolicy, "super_admin_only");

  const doc = readJson<GroupAccessDocument>(path.join(rootDir, "group-access.json"));
  assert.equal(doc.groups[0]?.routeKey, routeKey);
});

test("FileStateStore exposes cloned route records for route history enrichment", () => {
  const rootDir = tempStateDir();
  const routeKey = "feishu-main:default:direct:oc_user";
  const store = new FileStateStore({ rootDir });
  store.recordRouteMessage(feishuMessage(routeKey));

  const record = store.getRouteRecord(routeKey);

  assert.equal(record?.identity?.lastSenderDisplayName, "飞书用户");
  if (record?.identity) record.identity.lastSenderDisplayName = "被外部修改";
  assert.equal(store.getRouteRecord(routeKey)?.identity?.lastSenderDisplayName, "飞书用户");
});

test("ChannelConfigStore writes channel account metadata separately from local credentials", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-channel-config-"));
  const rootDir = path.join(baseDir, "state", "bridge");
  const store = new ChannelConfigStore({ bridgeDir: rootDir });

  store.upsertChannelInstance({
    id: "feishu-main",
    type: "feishu",
    accountId: "default",
    credentialSource: "env",
    metadata: {
      appId: "cli_xxx...abcd",
      domain: "feishu",
    },
  });
  store.upsertChannelInstance({
    id: "weixin-main",
    type: "weixin",
    accountId: "wx-account",
    credentialSource: "state",
  });

  const config = readJson<BridgeConfigDocument>(path.join(rootDir, "config.json"));
  assert.deepEqual(config.channels.map((channel) => [channel.id, channel.type, channel.defaultAccountId]), [
    ["feishu-main", "feishu", "default"],
    ["weixin-main", "weixin", "wx-account"],
  ]);

  const feishuAccountPath = path.join(baseDir, "state", "channels", "feishu", "feishu-main", "accounts", "default", "account.json");
  const weixinAccountPath = path.join(baseDir, "state", "channels", "weixin", "weixin-main", "accounts", "wx-account", "account.json");
  const feishuAccount = readJson<ChannelAccountDocument>(feishuAccountPath);
  assert.equal(feishuAccount.channelType, "feishu");
  assert.equal(feishuAccount.metadata?.appId, "cli_xxx...abcd");
  assert.equal(fs.readFileSync(feishuAccountPath, "utf-8").includes("secret"), false);
  assert.equal(fs.existsSync(weixinAccountPath), true);

  const record = config.channels.find((channel) => channel.id === "feishu-main");
  assert.ok(record);
  store.writeAccountCredentials(record, "default", {
    appId: "cli_real_app",
    appSecret: "real-secret",
    domain: "feishu",
  });
  const credentialsPath = path.join(baseDir, "state", "channels", "feishu", "feishu-main", "accounts", "default", "credentials.local.json");
  const credentials = readJson<ChannelAccountCredentialsDocument>(credentialsPath);
  assert.equal(credentials.credentials.appId, "cli_real_app");
  assert.equal(credentials.credentials.appSecret, "real-secret");
  assert.deepEqual(store.readAccountCredentials(record, "default"), {
    appId: "cli_real_app",
    appSecret: "real-secret",
    domain: "feishu",
  });
});

test("ChannelConfigStore persists channel capability overrides", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-channel-config-"));
  const rootDir = path.join(baseDir, "state", "bridge");
  const store = new ChannelConfigStore({ bridgeDir: rootDir });

  const created = store.upsertChannelInstance({
    id: "feishu-main",
    type: "feishu",
    accountId: "default",
    capabilityOverrides: { group: false },
  });
  assert.equal(created.capabilityOverrides?.group, false);

  const enabled = store.setChannelCapabilityOverride("feishu-main", "group", true);
  assert.equal(enabled?.capabilityOverrides?.group, true);
  assert.equal(store.listChannelInstances()[0]?.capabilityOverrides?.group, true);

  const config = readJson<BridgeConfigDocument>(path.join(rootDir, "config.json"));
  assert.equal(config.channels[0]?.capabilityOverrides?.group, true);
  const instance = readJson<ChannelInstanceDocument>(path.join(baseDir, "state", "channels", "feishu", "feishu-main", "instance.json"));
  assert.equal(instance.capabilityOverrides?.group, true);
});

test("ChannelConfigStore persists display name and removes channel state directory", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-channel-config-"));
  const rootDir = path.join(baseDir, "state", "bridge");
  const store = new ChannelConfigStore({ bridgeDir: rootDir });

  const created = store.upsertChannelInstance({
    id: "feishu-main",
    type: "feishu",
    accountId: "default",
    displayName: "研发助手",
  });
  const renamed = store.setChannelDisplayName("feishu-main", "大龙虾");

  assert.ok(renamed);
  assert.equal(renamed.displayName, "大龙虾");
  assert.equal(renamed.createdAt, created.createdAt);
  assert.equal(store.listChannelInstances()[0]?.displayName, "大龙虾");

  const stateDir = store.resolveStateDir(created.stateDir);
  assert.equal(fs.existsSync(stateDir), true);
  const removed = store.removeChannelInstance("feishu-main");

  assert.equal(removed.ok, true);
  assert.equal(removed.removedStateDir, true);
  assert.equal(fs.existsSync(stateDir), false);
  assert.equal(store.listChannelInstances().length, 0);
});

test("ChannelConfigStore persists independent mode context refresh default", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-channel-config-"));
  const rootDir = path.join(baseDir, "state", "bridge");
  const store = new ChannelConfigStore({ bridgeDir: rootDir });

  assert.equal(store.getContextRefreshDefaults().mode, "off");
  store.setContextRefreshDefaults({ mode: "detect" });

  const reloaded = new ChannelConfigStore({ bridgeDir: rootDir });
  assert.equal(reloaded.getContextRefreshDefaults().mode, "detect");
  const config = readJson<BridgeConfigDocument>(path.join(rootDir, "config.json"));
  assert.equal(config.codexDefaults?.independentMode?.contextRefresh?.mode, "detect");
});

test("FileStateStore removes channel routes and releases active and pending owners", () => {
  const rootDir = tempStateDir();
  const store = new FileStateStore({ rootDir });
  const feishuRoute = "feishu-main:default:direct:oc_user";
  const feishuGroupRoute = "feishu-main:default:group:oc_group";
  const weixinRoute = "weixin-main:wx:direct:wx_user";

  store.recordRouteMessage(feishuMessage(feishuRoute));
  store.recordRouteMessage({
    ...feishuMessage(feishuGroupRoute),
    conversation: { id: "oc_group", kind: "group", displayName: "飞书群聊" },
  });
  store.bindSession(feishuRoute, codexSession("session_feishu"));
  store.recordRouteMessage({
    ...feishuMessage(weixinRoute),
    id: "wx_message",
    channelId: "weixin-main",
    accountId: "wx",
    sender: { id: "wx_user", displayName: "微信用户" },
    conversation: { id: "wx_user", kind: "direct", displayName: "微信私聊" },
  });
  store.trustRoute(trustedRoute(feishuRoute));
  store.upsertGroupAccess({
    routeKey: feishuGroupRoute,
    channelId: "feishu-main",
    accountId: "default",
    conversationKind: "group",
    conversationId: "oc_group",
    superAdmin: {
      senderId: "ou_admin",
      source: "pairing",
      createdAt: "2026-05-21T00:00:00.000Z",
    },
    blockedSenders: [],
    normalMessagePolicy: "mentioned_non_blocked",
    approvalPolicy: "super_admin_only",
    managementPolicy: "super_admin_only",
    blockedUserBehavior: "silent",
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  });
  store.trustRoute(trustedRoute(weixinRoute, {
    channelId: "weixin-main",
    accountId: "wx",
    conversationId: "wx_user",
    displayName: "微信私聊",
    trustedBySenderId: "wx_user",
  }));
  store.setPendingBinding({
    id: "weixin-primary-feishu-main-default",
    channelId: "feishu-main",
    accountId: "default",
    conversationKind: "direct",
    label: "飞书 / default / 待生效",
    binding: { type: "existing", sessionId: "session_pending_feishu" },
  });
  store.setPendingBinding({
    id: "weixin-primary-weixin-main-wx",
    channelId: "weixin-main",
    accountId: "wx",
    conversationKind: "direct",
    label: "微信 / wx / 主聊天",
    binding: { type: "existing", sessionId: "session_pending_weixin" },
  });

  const removed = store.removeChannelState("feishu-main");

  assert.deepEqual(removed, {
    channelId: "feishu-main",
    removedRoutes: 2,
    releasedSessions: 2,
    removedPendingBindings: 1,
  });
  assert.equal(store.listRoutes().some((route) => route.channelId === "feishu-main"), false);
  assert.equal(store.listRoutes().some((route) => route.channelId === "weixin-main"), true);
  assert.equal(store.isRouteTrusted(feishuRoute), false);
  assert.equal(store.isRouteTrusted(weixinRoute), true);
  assert.equal(store.getGroupAccess(feishuGroupRoute), undefined);
  assert.equal(store.getSessionOwner("session_feishu"), undefined);
  assert.equal(store.getSessionOwner("session_pending_feishu"), undefined);
  assert.equal(store.getSessionOwner("session_pending_weixin")?.ownerRouteKey, pendingBindingOwnerRouteKey("weixin-primary-weixin-main-wx"));

  const reloaded = new FileStateStore({ rootDir });
  assert.equal(reloaded.listRoutes().some((route) => route.channelId === "feishu-main"), false);
  assert.equal(reloaded.getSessionOwner("session_feishu"), undefined);
  assert.equal(reloaded.getGroupAccess(feishuGroupRoute), undefined);
  assert.equal(reloaded.listPendingBindings().map((pending) => pending.id).join(","), "weixin-primary-weixin-main-wx");
  assert.deepEqual(reloaded.listTrustedRoutes().map((route) => route.routeKey), [weixinRoute]);
});

test("FileStateStore persists route context refresh policy and session snapshots", () => {
  const rootDir = tempStateDir();
  const routeKey = "feishu-main:default:direct:oc_user";
  const store = new FileStateStore({ rootDir });

  store.recordRouteMessage(feishuMessage(routeKey));
  store.setRouteContextRefreshPolicy(routeKey, { mode: "reload" });
  store.setSessionContextSnapshot({
    sessionId: "session_context",
    observedBy: "bind",
    fingerprint: {
      sessionId: "session_context",
      detectedAt: "2026-05-18T00:00:00.000Z",
      source: "rollout",
      rolloutPath: path.join(rootDir, "rollout.jsonl"),
      rolloutMtimeMs: 1000,
      rolloutSize: 12,
    },
    observedAt: "2026-05-18T00:00:01.000Z",
  });

  const reloaded = new FileStateStore({ rootDir });
  assert.equal(reloaded.getRouteContextRefreshPolicy(routeKey)?.mode, "reload");
  assert.equal(reloaded.getSessionContextSnapshot("session_context")?.observedBy, "bind");
  assert.equal(reloaded.getSessionContextSnapshot("session_context")?.fingerprint.rolloutSize, 12);

  reloaded.clearRouteContextRefreshPolicy(routeKey);
  assert.equal(new FileStateStore({ rootDir }).getRouteContextRefreshPolicy(routeKey), undefined);
});

function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-state-"));
}

function codexSession(id: string): CodexSession {
  return {
    id,
    cwd: "/tmp/work",
    title: `Session ${id}`,
    createdAt: new Date().toISOString(),
  };
}

function feishuMessage(routeKey: string): ChannelMessage {
  return {
    id: "om_message",
    routeKey,
    channelId: "feishu-main",
    accountId: "default",
    sender: { id: "ou_user", displayName: "飞书用户" },
    conversation: { id: "oc_user", kind: "direct", displayName: "飞书私聊" },
    text: "你好",
    timestamp: "2026-05-16T00:00:00.000Z",
    raw: {
      tenant_key: "tenant_a",
      sender: {
        sender_id: {
          open_id: "ou_user",
          user_id: "user_a",
          union_id: "union_a",
        },
        sender_type: "user",
        tenant_key: "tenant_a",
      },
      message: {
        message_id: "om_message",
        chat_id: "oc_user",
      },
    },
  };
}

function trustedRoute(routeKey: string, overrides: Partial<TrustedRouteRecord> = {}): TrustedRouteRecord {
  return {
    routeKey,
    channelId: "feishu-main",
    accountId: "default",
    conversationKind: "direct",
    conversationId: "oc_user",
    displayName: "飞书私聊",
    trustedAt: "2026-05-17T00:00:00.000Z",
    trustedBySenderId: "ou_user",
    trustedBySenderDisplayName: "飞书用户",
    trustMethod: "pairing_code",
    lastSeenAt: "2026-05-17T00:00:00.000Z",
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:00:00.000Z",
    ...overrides,
  };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}
