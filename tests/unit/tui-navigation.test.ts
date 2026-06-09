import test from "node:test";
import assert from "node:assert/strict";
import type { LauncherActions, LauncherDashboard } from "../../src/cli/actions/launcher-actions.js";
import {
  contextRefreshModeForIndex,
  defaultForFeishuStep,
  formatCurrentContextRefresh,
  maxSelectableIndex,
  nextFeishuStep,
  numericPick,
  weixinAutoCheckIntervalMs,
} from "../../src/cli/tui/navigation.js";

test("TUI navigation numericPick maps one-based digits to zero-based indexes", () => {
  assert.equal(numericPick("1", 3), 0);
  assert.equal(numericPick("3", 3), 2);
  assert.equal(numericPick("0", 3), undefined);
  assert.equal(numericPick("4", 3), undefined);
  assert.equal(numericPick("a", 3), undefined);
});

test("TUI navigation maxSelectableIndex keeps screen-specific action counts", () => {
  const channels = [
    channel("weixin", "weixin-1"),
    channel("feishu", "feishu-1"),
  ];

  assert.equal(maxSelectableIndex({ name: "home" }, [], 0), 5);
  assert.equal(maxSelectableIndex({ name: "home" }, channels, 0), 7);
  assert.equal(maxSelectableIndex({ name: "channels" }, [], 0), 1);
  assert.equal(maxSelectableIndex({ name: "channels" }, channels, 0), 8);
  assert.equal(maxSelectableIndex({ name: "bindings" }, channels, 0), 0);
  assert.equal(maxSelectableIndex({ name: "bindings" }, channels, 4), 3);
  assert.equal(maxSelectableIndex({ name: "channelDetail", channelId: "weixin-1" }, channels, 0), 4);
  assert.equal(maxSelectableIndex({ name: "channelDetail", channelId: "feishu-1" }, channels, 0), 5);
  assert.equal(maxSelectableIndex({ name: "contextRefresh", target: { kind: "default" } }, channels, 0), 2);
  assert.equal(maxSelectableIndex({ name: "contextRefresh", target: { kind: "route", routeKey: "route" } }, channels, 0), 3);
});

test("TUI navigation maps context refresh rows to modes", () => {
  assert.equal(contextRefreshModeForIndex("default", 0), "off");
  assert.equal(contextRefreshModeForIndex("default", 1), "detect");
  assert.equal(contextRefreshModeForIndex("default", 2), "reload");
  assert.equal(contextRefreshModeForIndex("default", 3), undefined);
  assert.equal(contextRefreshModeForIndex("route", 0), undefined);
  assert.equal(contextRefreshModeForIndex("route", 1), "off");
  assert.equal(contextRefreshModeForIndex("route", 2), "detect");
  assert.equal(contextRefreshModeForIndex("route", 3), "reload");
});

test("TUI navigation formats current context refresh through launcher actions", () => {
  const actions = {
    getContextRefreshDefaults: () => ({ mode: "detect" as const }),
    formatContextRefreshPolicy: (policy: { mode: string }) => `default:${policy.mode}`,
    getRouteContextRefreshEffectivePolicy: (routeKey: string) => ({ policy: { mode: "reload" as const }, routeKey }),
    formatContextRefreshEffectivePolicy: (effective: { policy: { mode: string } }) => `route:${effective.policy.mode}`,
  } as unknown as LauncherActions;

  assert.equal(formatCurrentContextRefresh(actions, { kind: "default" }), "default:detect");
  assert.equal(formatCurrentContextRefresh(actions, { kind: "route", routeKey: "route-1" }), "route:reload");
});

test("TUI navigation keeps Feishu setup step order and defaults", () => {
  assert.equal(nextFeishuStep("appId"), "appSecret");
  assert.equal(nextFeishuStep("appSecret"), "accountId");
  assert.equal(nextFeishuStep("accountId"), undefined);
  assert.equal(defaultForFeishuStep("appId"), "");
  assert.equal(defaultForFeishuStep("appSecret"), "");
  assert.equal(defaultForFeishuStep("accountId"), "");
});

test("TUI navigation parses Weixin login auto-check interval", () => {
  assert.equal(weixinAutoCheckIntervalMs({}), 5_000);
  assert.equal(weixinAutoCheckIntervalMs({ CHAT_CODEX_TUI_WEIXIN_LOGIN_CHECK_INTERVAL_MS: "1000" }), 1_000);
  assert.equal(weixinAutoCheckIntervalMs({ CHAT_CODEX_TUI_WEIXIN_LOGIN_CHECK_INTERVAL_MS: "0" }), 5_000);
  assert.equal(weixinAutoCheckIntervalMs({ CHAT_CODEX_TUI_WEIXIN_LOGIN_CHECK_INTERVAL_MS: "bad" }), 5_000);
});

function channel(type: "weixin" | "feishu" | "lark", id: string): LauncherDashboard["channels"][number] {
  return {
    record: {
      id,
      type,
      enabled: true,
      createdAt: "2026-06-08T00:00:00.000Z",
      updatedAt: "2026-06-08T00:00:00.000Z",
    },
    status: {
      channelId: id,
      state: "connected",
    },
  } as LauncherDashboard["channels"][number];
}
