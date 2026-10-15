import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import React from "react";
import { render } from "ink-testing-library";
import { LauncherActions } from "../../src/cli/actions/launcher-actions.js";
import { ChannelActions } from "../../src/cli/actions/channel-actions.js";
import { ChannelConfigStore } from "../../src/state/channel-config-store.js";
import { FileStateStore } from "../../src/state/file-state-store.js";
import { GroupAccessService } from "../../src/group-access/service.js";
import { GroupAccessView } from "../../src/cli/tui/group-access-view.js";

const wait = () => new Promise((resolve) => setTimeout(resolve, 70));
function setup(t: TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "group-tui-"));
  const root = path.join(base, "state", "bridge");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const configStore = new ChannelConfigStore({ bridgeDir: root });
  configStore.upsertChannelInstance({ id: "custom-bot", type: "feishu", accountId: "work" });
  const state = new FileStateStore({ rootDir: root });
  const routeKey = "custom-bot:work:group:room";
  const now = new Date().toISOString();
  state.recordRouteMessage({ id: "m", channelId: "custom-bot", accountId: "work", routeKey, conversation: { kind: "group", id: "room" }, sender: { id: "ou_super", displayName: "小黄" }, timestamp: now });
  state.trustRoute({ routeKey, channelId: "custom-bot", accountId: "work", conversationKind: "group", conversationId: "room", trustedBySenderId: "local-tui", trustMethod: "manual", trustedAt: now, createdAt: now, updatedAt: now });
  const actions = new LauncherActions({ adapterMode: "app-server", cwd: root, policy: { permissionMode: "approval", sandbox: "workspace-write" } }, { unboundRoutePolicy: "auto_new" }, new ChannelActions({ configStore, env: {} }));
  return { root, state, routeKey, actions };
}
const frame = (view: ReturnType<typeof render>) => (view.lastFrame() ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

test("group TUI confirms superadmin repair and supports cancel before mutation", async (t) => {
  const f = setup(t);
  assert.equal(f.actions.supportsGroupManagement(f.routeKey), true);
  let back = false;
  const view = render(<GroupAccessView actions={f.actions} routeKey={f.routeKey} onBack={() => { back = true; }} />);
  t.after(() => view.unmount()); await wait();
  assert.match(frame(view), /未设置/);
  view.stdin.write("transfer ou_new"); await wait(); view.stdin.write("\r"); await wait();
  assert.match(frame(view), /确认.*ou_new/);
  assert.equal(f.actions.getGroupManagement(f.routeKey).record, undefined);
  view.stdin.write("n"); await wait();
  assert.equal(f.actions.getGroupManagement(f.routeKey).record, undefined);
  view.stdin.write("transfer ou_new"); await wait(); view.stdin.write("\r"); await wait();
  view.stdin.write("y"); await wait();
  assert.equal(f.actions.getGroupManagement(f.routeKey).record?.superAdmin?.senderId, "ou_new");
  assert.match(frame(view), /群权限已保存/);
  view.stdin.write("\x1b"); await wait(); assert.equal(back, true);
});

test("group actions reject stale TUI revisions and are read only while runtime owns state", async (t) => {
  const f = setup(t);
  f.actions.updateGroupManagement(f.routeKey, { action: "transfer", target: "ou_super" }, 0);
  const old = f.actions.getGroupManagement(f.routeKey).record!.revision!;
  f.actions.updateGroupManagement(f.routeKey, { action: "admin_add", target: "ou_admin" }, old);
  assert.throws(() => f.actions.updateGroupManagement(f.routeKey, { action: "block", target: "ou_admin" }, old), /权限已变化/);
  const release = f.state.acquireGroupAccessWriter();
  assert.equal(f.actions.getGroupManagement(f.routeKey).readOnly, true);
  assert.equal(f.actions.revokeRouteTrust(f.routeKey).ok, false);
  assert.equal(f.actions.trustRouteManually(f.routeKey).ok, false);
  assert.equal(f.actions.getGroupManagement(f.routeKey).trusted, true);
  assert.throws(() => f.actions.updateGroupManagement(f.routeKey, { action: "clear_super" }), /只读/);
  await assert.rejects(() => f.actions.setChannelGroupEnabled("custom-bot", true), /只读/);
  const view = render(<GroupAccessView actions={f.actions} routeKey={f.routeKey} onBack={() => {}} />);
  t.after(() => view.unmount()); await wait();
  assert.match(frame(view), /只读/);
  view.stdin.write("block ou_member"); await wait(); view.stdin.write("\r"); await wait();
  assert.match(frame(view), /先停止服务/);
  assert.equal(f.actions.getGroupManagement(f.routeKey).record?.blockedSenders.length, 0);
  release();
  f.actions.updateGroupManagement(f.routeKey, { action: "block", target: "ou_member" });
  const reloaded = new FileStateStore({ rootDir: f.root });
  assert.equal(new GroupAccessService({ state: reloaded }).roleForSender(f.routeKey, "ou_member"), "blocked");
});
