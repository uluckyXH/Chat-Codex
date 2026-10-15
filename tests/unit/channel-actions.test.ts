import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelActions, feishuChannelId, formatManagedChannelList, weixinChannelId } from "../../src/cli/actions/channel-actions.js";
import { ChannelConfigStore } from "../../src/state/channel-config-store.js";
import { FileStateStore } from "../../src/state/file-state-store.js";
import { FileWeixinAccountStore, type StoredWeixinAccount } from "../../src/channels/weixin/weixin-account-store.js";
import type { ChannelMessage } from "../../src/protocol/channel.js";
import type { CodexSession } from "../../src/codex/types.js";

test("ChannelActions registers independent Weixin accounts and Feishu bots", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-channel-actions-"));
  const configStore = new ChannelConfigStore({ bridgeDir: path.join(baseDir, "state", "bridge") });
  const actions = new ChannelActions({
    configStore,
    env: {
      FEISHU_APP_ID: "cli_test_app",
      FEISHU_APP_SECRET: "test-secret",
      FEISHU_DOMAIN: "feishu",
    },
  });

  const weixinA = actions.registerWeixinAccount(weixinAccount("wx.account-a"));
  const weixinB = actions.registerWeixinAccount(weixinAccount("wx.account-b"));
  const feishuA = actions.registerFeishuBot({ appId: "cli_a", appSecret: "secret-a", accountId: "bot-a" });
  const feishuB = actions.registerFeishuBot({ appId: "cli_b", appSecret: "secret-b", accountId: "bot-b" });

  assert.equal(weixinA.id, weixinChannelId("wx-account-a"));
  assert.equal(weixinB.id, weixinChannelId("wx-account-b"));
  assert.equal(feishuA.id, feishuChannelId("bot-a"));
  assert.equal(feishuB.id, feishuChannelId("bot-b"));
  assert.equal(feishuA.capabilityOverrides?.group, false);
  assert.equal(actions.createRuntimeAdapter(feishuA).getCapabilities().group, false);
  const feishuAGroupEnabled = actions.setChannelGroupEnabled(feishuA.id, true);
  assert.equal(feishuAGroupEnabled?.capabilityOverrides?.group, true);
  assert.equal(actions.createRuntimeAdapter(feishuAGroupEnabled ?? feishuA).getCapabilities().group, true);
  const feishuAUpdated = actions.registerFeishuBot({ appId: "cli_a2", appSecret: "secret-a2", accountId: "bot-a" });
  assert.equal(feishuAUpdated.capabilityOverrides?.group, true);
  assert.deepEqual(actions.listChannelInstances().map((channel) => channel.id), [
    feishuA.id,
    feishuB.id,
    weixinA.id,
    weixinB.id,
  ]);

  actions.setChannelEnabled(feishuB.id, false);
  const runtimeAdapters = actions.createRuntimeAdapters();
  assert.deepEqual(runtimeAdapters.map((adapter) => adapter.id).sort(), [
    feishuA.id,
    weixinA.id,
    weixinB.id,
  ].sort());

  const summaries = await actions.listChannelSummaries();
  assert.equal(summaries.length, 4);
  assert.equal(summaries.find((channel) => channel.record.id === weixinA.id)?.status.state, "connected");
  assert.equal(summaries.find((channel) => channel.record.id === feishuA.id)?.status.state, "connected");
  assert.equal(summaries.find((channel) => channel.record.id === feishuB.id)?.record.enabled, false);
  const channelList = formatManagedChannelList(summaries);
  assert.match(channelList, /1\. 飞书 \/ bot-a/);
  assert.match(channelList, /5\. 添加微信账号/);
  assert.match(channelList, /6\. 添加飞书机器人/);
  assert.match(channelList, /w\. 添加微信账号/);
  assert.match(channelList, /f\. 添加飞书机器人/);

  const weixinAccountPath = path.join(baseDir, "state", "channels", "weixin", weixinA.id, "accounts", "wx-account-a.json");
  assert.equal(fs.existsSync(weixinAccountPath), true);
});

test("ChannelActions persists interactive Feishu credentials in local state", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-channel-actions-"));
  const bridgeDir = path.join(baseDir, "state", "bridge");
  const configStore = new ChannelConfigStore({ bridgeDir });
  const actions = new ChannelActions({ configStore, env: {} });

  const record = actions.registerFeishuBot({
    appId: "cli_interactive_app",
    appSecret: "interactive-secret",
    accountId: "bot-interactive",
  }, "state-local");

  const statusAdapter = actions.createStatusAdapter(record);
  await statusAdapter.start();
  assert.equal((await statusAdapter.getStatus()).state, "connected");

  const accountPath = path.join(baseDir, "state", "channels", "feishu", record.id, "accounts", "bot-interactive", "account.json");
  const persistedAccount = fs.readFileSync(accountPath, "utf8");
  assert.equal(persistedAccount.includes("interactive-secret"), false);
  assert.equal(persistedAccount.includes("cli_interactive_app"), false);
  const credentialsPath = path.join(baseDir, "state", "channels", "feishu", record.id, "accounts", "bot-interactive", "credentials.local.json");
  const persistedCredentials = fs.readFileSync(credentialsPath, "utf8");
  assert.equal(persistedCredentials.includes("interactive-secret"), true);
  assert.equal(persistedCredentials.includes("cli_interactive_app"), true);

  const restartedActions = new ChannelActions({
    configStore: new ChannelConfigStore({ bridgeDir }),
    env: {},
  });
  const restartedRecord = restartedActions.listChannelInstances()[0];
  assert.ok(restartedRecord);
  const restartedStatusAdapter = restartedActions.createStatusAdapter(restartedRecord);
  await restartedStatusAdapter.start();
  assert.equal((await restartedStatusAdapter.getStatus()).state, "connected");
});

test("ChannelActions renames and removes channels without touching other channels", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-channel-actions-"));
  const bridgeDir = path.join(baseDir, "state", "bridge");
  const configStore = new ChannelConfigStore({ bridgeDir });
  const actions = new ChannelActions({ configStore, env: {} });

  const feishu = actions.registerFeishuBot({ appId: "cli_remove", appSecret: "secret-remove", accountId: "remove-bot" });
  const weixin = actions.registerWeixinAccount(weixinAccount("wx.keep"));
  const renamed = actions.renameChannel(feishu.id, "删除测试机器人");
  const state = new FileStateStore({ rootDir: bridgeDir });
  const routeKey = `${feishu.id}:remove-bot:direct:oc_remove`;
  state.recordRouteMessage(feishuMessage(feishu.id, routeKey));
  state.bindSession(routeKey, codexSession("session_remove"));
  state.setPendingBinding({
    id: "pending-remove",
    channelId: feishu.id,
    accountId: "remove-bot",
    conversationKind: "direct",
    label: "飞书 / remove-bot / 待生效",
    binding: { type: "existing", sessionId: "session_pending_remove" },
  });

  assert.equal(renamed?.displayName, "删除测试机器人");
  actions.setChannelEnabled(feishu.id, false);
  const afterDisable = new FileStateStore({ rootDir: bridgeDir });
  assert.equal(afterDisable.getSessionOwner("session_remove")?.ownerRouteKey, routeKey);
  assert.equal(afterDisable.getSessionOwner("session_pending_remove")?.ownerRouteKey, "pending:pending-remove");

  const removed = actions.removeChannel(feishu.id);

  assert.equal(removed.ok, true);
  if (removed.ok) {
    assert.equal(removed.removedRoutes, 1);
    assert.equal(removed.releasedSessions, 2);
    assert.equal(removed.removedPendingBindings, 1);
    assert.equal(removed.removedStateDir, true);
  }
  assert.deepEqual(actions.listChannelInstances().map((channel) => channel.id), [weixin.id]);
  const reloaded = new FileStateStore({ rootDir: bridgeDir });
  assert.equal(reloaded.getSessionOwner("session_remove"), undefined);
  assert.equal(reloaded.getSessionOwner("session_pending_remove"), undefined);
  assert.equal(fs.existsSync(configStore.resolveStateDir(feishu.stateDir)), false);
  assert.equal(fs.existsSync(configStore.resolveStateDir(weixin.stateDir)), true);
});

test("ChannelActions removing Weixin clears legacy login state to prevent re-registration", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-channel-actions-"));
  const bridgeDir = path.join(baseDir, "state", "bridge");
  const legacyStore = new FileWeixinAccountStore(path.join(baseDir, "state", "weixin"));
  legacyStore.saveAccount(weixinAccount("wx.deleted"));
  const actions = new ChannelActions({
    configStore: new ChannelConfigStore({ bridgeDir }),
    legacyWeixinStore: legacyStore,
    env: {},
  });

  const registered = actions.ensureLegacyWeixinAccountRegistered({
    channelId: "weixin",
    state: "connected",
    account: "wx.deleted",
  });
  assert.ok(registered);

  const removed = actions.removeChannel(registered.id);

  assert.equal(removed.ok, true);
  assert.equal(legacyStore.loadAccount("wx.deleted"), undefined);
  assert.equal(legacyStore.loadAccount("wx-deleted"), undefined);
  assert.deepEqual(actions.listChannelInstances(), []);
  assert.equal(actions.ensureLegacyWeixinAccountRegistered({
    channelId: "weixin",
    state: "connected",
    account: "wx.deleted",
  }), undefined);
});

function weixinAccount(accountId: string): StoredWeixinAccount {
  return {
    accountId,
    token: `token-${accountId}`,
    baseUrl: "https://weixin.example.test",
    savedAt: "2026-05-16T00:00:00.000Z",
  };
}

function codexSession(id: string): CodexSession {
  return {
    id,
    cwd: "/tmp/work",
    title: `Session ${id}`,
    createdAt: "2026-05-16T00:00:00.000Z",
  };
}

function feishuMessage(channelId: string, routeKey: string): ChannelMessage {
  return {
    id: "om_remove",
    routeKey,
    channelId,
    accountId: "remove-bot",
    sender: { id: "ou_remove", displayName: "飞书用户" },
    conversation: { id: "oc_remove", kind: "direct", displayName: "飞书私聊" },
    text: "你好",
    timestamp: "2026-05-16T00:00:00.000Z",
  };
}
