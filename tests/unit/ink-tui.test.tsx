import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import React from "react";
import { render } from "ink-testing-library";
import { ChatCodexTui } from "../../src/cli/tui/app.js";
import { RuntimeLogStore, RuntimeLogView, RuntimeTuiTranscriptSink } from "../../src/cli/tui/runtime-log.js";
import { runRuntimeLogTui } from "../../src/cli/tui/run-runtime-log.js";
import type { LauncherActions, LauncherDashboard } from "../../src/cli/actions/launcher-actions.js";

const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function cleanFrame(view: { lastFrame(): string | undefined }): string {
  return (view.lastFrame() ?? "").replace(ANSI_PATTERN, "");
}

test("Ink TUI renders dashboard and navigates to core pages", async () => {
  const actions = mockActions(dashboardFixture());
  const view = render(<ChatCodexTui actions={actions} onDone={() => undefined} />);
  await waitForInk();

  assert.match(cleanFrame(view), new RegExp(escapeRegExp(expectedChatCodexTitle())));
  assert.match(cleanFrame(view), /启动服务/);
  assert.match(cleanFrame(view), /已准备好。按 Enter 启动 Bridge，并进入运行日志面板/);
  assert.match(cleanFrame(view), /Codex CLI/);
  assert.match(cleanFrame(view), /codex-cli 0\.130\.0/);
  assert.match(cleanFrame(view), /darwin arm64/);
  assert.match(cleanFrame(view), /渠道/);
  assert.match(cleanFrame(view), /聊天绑定/);
  assert.match(cleanFrame(view), /配对管理/);
  assert.match(cleanFrame(view), /权限/);
  assert.match(cleanFrame(view), /工作目录/);
  assert.match(cleanFrame(view), /\/repo/);

  view.stdin.write("c");
  await waitForInk();
  assert.match(cleanFrame(view), /管理渠道/);
  assert.match(cleanFrame(view), /2\. 添加微信账号/);
  assert.match(cleanFrame(view), /3\. 添加飞书机器人/);
  assert.match(cleanFrame(view), /w 微信/);
  assert.match(cleanFrame(view), /f 飞书/);

  view.stdin.write("\u001B");
  await waitForInk();
  view.stdin.write("b");
  await waitForInk();
  assert.match(cleanFrame(view), /聊天绑定/);
  assert.match(cleanFrame(view), /飞书 \/ default \/ 张三/);
  assert.match(cleanFrame(view), /微信 \/ wx-main \/ 主聊天/);
  assert.match(cleanFrame(view), /待生效/);

  view.stdin.write("\u001B");
  await waitForInk();
  view.stdin.write("t");
  await waitForInk();
  assert.match(cleanFrame(view), /配对管理/);
  assert.match(cleanFrame(view), /待配对/);
  assert.match(cleanFrame(view), /已信任/);

  view.stdin.write("\u001B");
  await waitForInk();
  view.stdin.write("p");
  await waitForInk();
  assert.match(cleanFrame(view), /默认权限设置/);
  assert.match(cleanFrame(view), /审批模式/);

  view.stdin.write("\u001B");
  await waitForInk();
  view.stdin.write("d");
  await waitForInk();
  assert.match(cleanFrame(view), /工作目录/);
  assert.match(cleanFrame(view), /当前终端目录/);

  view.unmount();
});

test("Ink TUI handles help, Feishu form back, and start confirmation", async () => {
  let result: { start: boolean } | undefined;
  const view = render(<ChatCodexTui actions={mockActions(dashboardFixture())} onDone={(next) => { result = next; }} />);
  await waitForInk();

  view.stdin.write("?");
  await waitForInk();
  assert.match(cleanFrame(view), /快捷键/);

  view.stdin.write("\r");
  await waitForInk();
  view.stdin.write("f");
  await waitForInk();
  assert.match(cleanFrame(view), /添加飞书机器人/);
  view.stdin.write("\u001B");
  await waitForInk();
  assert.match(cleanFrame(view), /管理渠道/);

  view.unmount();

  const startView = render(<ChatCodexTui actions={mockActions(dashboardFixture())} onDone={(next) => { result = next; }} />);
  await waitForInk();
  startView.stdin.write("\r");
  await waitForInk();
  assert.match(cleanFrame(startView), /启动服务/);
  assert.match(cleanFrame(startView), /确认后会启动 Bridge，并进入 Chat Codex 运行中面板/);
  assert.match(cleanFrame(startView), /新聊天策略\s+首条消息自动创建新 session/);
  startView.stdin.write("\r");
  await waitForInk();
  assert.deepEqual(result, { start: true });
  startView.unmount();
});

test("Ink TUI exposes add channel actions when channels already exist", async () => {
  const view = render(<ChatCodexTui actions={mockActions(dashboardFixture())} onDone={() => undefined} />);
  await waitForInk();

  view.stdin.write("c");
  await waitForInk();
  assert.match(cleanFrame(view), /已配置渠道/);
  assert.match(cleanFrame(view), /2\. 添加微信账号/);
  assert.match(cleanFrame(view), /3\. 添加飞书机器人/);
  assert.match(cleanFrame(view), /4\. 修改选中渠道备注/);
  assert.match(cleanFrame(view), /6\. 删除选中渠道/);

  view.stdin.write("\u001B[B");
  view.stdin.write("\u001B[B");
  await waitForInk();
  view.stdin.write("\r");
  await waitForInk();
  assert.match(cleanFrame(view), /添加飞书机器人/);

  view.unmount();
});

test("Ink TUI requires Feishu account label and submits with default domain", async () => {
  const submitted: unknown[] = [];
  const view = render(<ChatCodexTui actions={mockActions(emptyDashboardFixture(), {
    addFeishuBot: async (input) => {
      submitted.push(input);
      return {
        ok: true,
        record: {
          id: "feishu-dalongxia",
          type: "feishu",
          enabled: true,
          stateDir: "state/channels/feishu/feishu-dalongxia",
          defaultAccountId: "dalongxia",
          credentialSource: "interactive",
          createdAt: "2026-05-16T00:00:00.000Z",
          updatedAt: "2026-05-16T00:00:00.000Z",
        },
        message: "飞书机器人已添加。",
      };
    },
  })} onDone={() => undefined} />);
  await waitForInk();

  view.stdin.write("2");
  await waitForInk();
  assert.match(cleanFrame(view), /FEISHU_APP_ID/);
  view.stdin.write("cli_test");
  await waitForInk();
  view.stdin.write("\r");
  await waitForInk();
  assert.match(cleanFrame(view), /FEISHU_APP_SECRET/);
  view.stdin.write("secret");
  await waitForInk();
  view.stdin.write("\r");
  await waitForInk();
  assert.match(cleanFrame(view), /账号标识/);

  view.stdin.write("\r");
  await waitForInk();
  assert.equal(submitted.length, 0);
  assert.match(cleanFrame(view), /这里不能为空/);

  view.stdin.write("dalongxia");
  await waitForInk();
  view.stdin.write("\r");
  await waitForInk();
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0], {
    appId: "cli_test",
    appSecret: "secret",
    accountId: "dalongxia",
    domain: "feishu",
  });

  view.unmount();
});

test("Ink TUI first run guides user to add channels with Enter and number shortcuts", async () => {
  const view = render(<ChatCodexTui actions={mockActions(emptyDashboardFixture())} onDone={() => undefined} />);
  await waitForInk();

  assert.match(cleanFrame(view), /首次配置/);
  assert.match(cleanFrame(view), /1\. 添加微信账号/);
  assert.match(cleanFrame(view), /2\. 添加飞书机器人/);
  assert.match(cleanFrame(view), /4\. 工作目录/);
  assert.match(cleanFrame(view), /↑↓ 选择/);
  assert.match(cleanFrame(view), /0\/q 退出/);

  view.stdin.write("\r");
  await waitForInk();
  assert.match(cleanFrame(view), /添加微信账号/);
  assert.match(cleanFrame(view), /请使用微信扫码/);
  assert.match(cleanFrame(view), /QR-CODE/);

  view.stdin.write("\u001B");
  await waitForInk();
  view.stdin.write("2");
  await waitForInk();
  assert.match(cleanFrame(view), /添加飞书机器人/);

  view.unmount();
});

test("Ink TUI first run exit action is selectable", async () => {
  let result: { start: boolean } | undefined;
  const view = render(<ChatCodexTui actions={mockActions(emptyDashboardFixture())} onDone={(next) => { result = next; }} />);
  await waitForInk();

  view.stdin.write("\u001B[B");
  view.stdin.write("\u001B[B");
  view.stdin.write("\u001B[B");
  view.stdin.write("\u001B[B");
  await waitForInk();
  view.stdin.write("\r");
  await waitForInk();

  assert.deepEqual(result, { start: false });
  view.unmount();
});

test("Ink TUI auto-checks Weixin login after QR is shown", async () => {
  const previous = process.env.CHAT_CODEX_TUI_WEIXIN_LOGIN_CHECK_INTERVAL_MS;
  process.env.CHAT_CODEX_TUI_WEIXIN_LOGIN_CHECK_INTERVAL_MS = "20";
  let checks = 0;
  try {
    const view = render(<ChatCodexTui actions={mockActions(emptyDashboardFixture(), {
      checkWeixinLogin: async () => {
        checks += 1;
        return { state: "pending", message: "还没有检测到扫码确认。" };
      },
    })} onDone={() => undefined} />);
    await waitForInk();

    view.stdin.write("1");
    await waitForInk();
    assert.match(cleanFrame(view), /TUI 会每 5 秒自动检查登录结果/);

    await new Promise((resolve) => setTimeout(resolve, 80));
    await waitForInk();
    assert.ok(checks >= 1);

    view.unmount();
  } finally {
    if (previous === undefined) delete process.env.CHAT_CODEX_TUI_WEIXIN_LOGIN_CHECK_INTERVAL_MS;
    else process.env.CHAT_CODEX_TUI_WEIXIN_LOGIN_CHECK_INTERVAL_MS = previous;
  }
});

test("Ink TUI shows Weixin primary new-session action as an Enter-selectable row", async () => {
  const dashboard = dashboardFixture();
  dashboard.channels[0].record.id = "weixin-wx-main";
  dashboard.channels[0].record.type = "weixin";
  dashboard.channels[0].record.defaultAccountId = "wx-main";
  dashboard.channels[0].status.channelId = "weixin-wx-main";
  dashboard.channels[0].status.account = "wx-main";
  let created = false;
  const view = render(<ChatCodexTui actions={mockActions(dashboard, {
    setWeixinPrimaryNew: () => {
      created = true;
      return { ok: true, message: "已设置：收到第一条微信私聊后创建新 session。" };
    },
  })} onDone={() => undefined} />);
  await waitForInk();

  view.stdin.write("c");
  await waitForInk();
  view.stdin.write("\r");
  await waitForInk();
  view.stdin.write("\r");
  await waitForInk();

  assert.match(cleanFrame(view), /微信主聊天绑定/);
  assert.match(cleanFrame(view), /直接操作/);
  assert.match(cleanFrame(view), /新建 Codex session/);

  view.stdin.write("\r");
  await waitForInk();
  assert.equal(created, true);

  view.unmount();
});

test("Ink TUI updates new session workdir from current directory and manual input", async () => {
  const dashboard = dashboardFixture();
  const view = render(<ChatCodexTui actions={mockActions(dashboard)} onDone={() => undefined} />);
  await waitForInk();

  view.stdin.write("d");
  await waitForInk();
  assert.match(cleanFrame(view), /当前新 session\s+\/repo/);
  assert.match(cleanFrame(view), /当前终端目录\s+\/terminal\/repo/);

  view.stdin.write("\r");
  await waitForInk();
  assert.equal(dashboard.startup.cwd, "/terminal/repo");
  assert.match(cleanFrame(view), /\/terminal\/repo/);

  view.stdin.write("m");
  await waitForInk();
  assert.match(cleanFrame(view), /输入工作目录/);

  view.stdin.write("/tmp/manual-repo");
  await waitForInk();
  view.stdin.write("\r");
  await waitForInk();
  assert.equal(dashboard.startup.cwd, "/tmp/manual-repo");
  assert.match(cleanFrame(view), /\/tmp\/manual-repo/);

  view.unmount();
});

test("Ink TUI empty channel page exposes actionable add menu", async () => {
  const view = render(<ChatCodexTui actions={mockActions(emptyDashboardFixture())} onDone={() => undefined} />);
  await waitForInk();

  view.stdin.write("c");
  await waitForInk();
  assert.match(cleanFrame(view), /管理渠道/);
  assert.match(cleanFrame(view), /1\. 添加微信账号/);
  assert.match(cleanFrame(view), /2\. 添加飞书机器人/);

  view.stdin.write("\u001B[B");
  await waitForInk();
  view.stdin.write("\r");
  await waitForInk();
  assert.match(cleanFrame(view), /添加飞书机器人/);

  view.unmount();
});

test("Runtime TUI renders startup summary and transcript logs", async () => {
  const store = new RuntimeLogStore();
  const sink = new RuntimeTuiTranscriptSink(store);
  sink.inbound({
    id: "message-1",
    channelId: "feishu-default",
    routeKey: "feishu-default:default:direct:oc_abc",
    accountId: "default",
    conversation: { kind: "direct", id: "oc_abc" },
    sender: { id: "ou_abc", displayName: "张三" },
    text: "你好",
    timestamp: "2026-05-16T00:00:00.000Z",
  }, "你好");
  sink.outbound({
    channelId: "feishu-default",
    routeKey: "feishu-default:default:direct:oc_abc",
    accountId: "default",
    conversation: { kind: "direct", id: "oc_abc" },
    recipient: { id: "ou_abc", displayName: "张三" },
  }, "收到");

  const view = render(<RuntimeLogView summary={{
    title: `${expectedChatCodexTitle()} 运行中`,
    channels: ["feishu-default"],
    cwd: "/repo",
    policy: { permissionMode: "approval", sandbox: "workspace-write" },
    routePolicy: "首条消息自动创建新 session",
    codexStatus: codexStatusFixture(),
  }} store={store} />);
  await waitForInk();

  assert.match(cleanFrame(view), new RegExp(`${escapeRegExp(expectedChatCodexTitle())} 运行中`));
  assert.match(cleanFrame(view), /已启动\s+Ctrl\+C 停止/);
  assert.match(cleanFrame(view), /Chat Codex 已启动/);
  assert.match(cleanFrame(view), /codex-cli 0\.130\.0/);
  assert.match(cleanFrame(view), /feishu-default/);
  assert.match(cleanFrame(view), /收到/);
  assert.match(cleanFrame(view), /发送/);
  assert.match(cleanFrame(view), /你好/);
  assert.match(cleanFrame(view), /Ctrl\+C 停止服务/);
  assert.doesNotMatch(cleanFrame(view), /q\/Esc 停止/);

  view.unmount();
});

function expectedChatCodexTitle(): string {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    version?: string;
  };
  return `Chat-Codex v${packageJson.version ?? "0.0.0"}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("Ink TUI shows session last active time in binding views", async () => {
  const dashboard = dashboardFixture();
  dashboard.routes.bound = 1;
  dashboard.bindings[0].activeSession = {
    id: "session-active",
    shortId: "session-a",
    title: "活跃会话",
    cwd: "/repo",
    updatedAt: "2026-05-16T00:00:00.000Z",
  };
  const view = render(<ChatCodexTui actions={mockActions(dashboard)} onDone={() => undefined} />);
  await waitForInk();

  view.stdin.write("b");
  await waitForInk();
  assert.match(cleanFrame(view), /最近 05-16/);

  view.stdin.write("\r");
  await waitForInk();
  assert.match(cleanFrame(view), /最近活跃/);
  assert.match(cleanFrame(view), /活跃会话/);

  view.unmount();
});

test("Ink TUI manages route pairing trust and blocks untrusted binding actions", async () => {
  const dashboard = dashboardFixture();
  let manuallyTrusted = "";
  let revoked: { routeKey: string; unbindSession: boolean | undefined } | undefined;
  const view = render(<ChatCodexTui actions={mockActions(dashboard, {
    trustRouteManually: (routeKey) => {
      manuallyTrusted = routeKey;
      const route = dashboard.pairing.routes.find((item) => item.route.routeKey === routeKey);
      assert.ok(route);
      route.trusted = true;
      route.trustedRecord = {
        routeKey,
        channelId: route.route.channelId,
        accountId: route.route.accountId,
        conversationKind: route.route.conversationKind,
        conversationId: route.route.conversationId,
        displayName: route.route.displayName,
        trustedAt: "2026-05-18T00:00:00.000Z",
        trustedBySenderId: "local-tui",
        trustedBySenderDisplayName: "本机 TUI",
        trustMethod: "manual",
        lastSeenAt: route.route.lastSeenAt,
        createdAt: "2026-05-18T00:00:00.000Z",
        updatedAt: "2026-05-18T00:00:00.000Z",
      };
      dashboard.pairing.pending -= 1;
      dashboard.pairing.trusted += 1;
      const binding = dashboard.bindings.find((item) => item.route.routeKey === routeKey);
      if (binding) binding.trusted = true;
      return { ok: true, route, message: `已手动信任：${route.label}` };
    },
    revokeRouteTrust: (routeKey, options) => {
      revoked = { routeKey, unbindSession: options?.unbindSession };
      const route = dashboard.pairing.routes.find((item) => item.route.routeKey === routeKey);
      assert.ok(route);
      route.trusted = false;
      route.trustedRecord = undefined;
      dashboard.pairing.pending += 1;
      dashboard.pairing.trusted -= 1;
      const binding = dashboard.bindings.find((item) => item.route.routeKey === routeKey);
      if (binding) binding.trusted = false;
      return { ok: true, route, message: `已撤销信任：${route.label}` };
    },
  })} onDone={() => undefined} />);
  await waitForInk();

  view.stdin.write("b");
  await waitForInk();
  assert.match(cleanFrame(view), /待配对，暂不能绑定/);

  view.stdin.write("\u001B[B");
  await waitForInk();
  view.stdin.write("n");
  await waitForInk();
  assert.match(cleanFrame(view), /还没有完成配对/);

  view.stdin.write("\u001B");
  await waitForInk();
  view.stdin.write("t");
  await waitForInk();
  assert.match(cleanFrame(view), /配对管理/);
  assert.match(cleanFrame(view), /飞书 \/ default \/ 李四/);

  view.stdin.write("m");
  await waitForInk();
  assert.match(cleanFrame(view), /确认手动信任/);
  view.stdin.write("y");
  await waitForInk();
  assert.equal(manuallyTrusted, "feishu-default:default:direct:oc_pending");
  assert.match(cleanFrame(view), /本机手动信任/);

  view.stdin.write("r");
  await waitForInk();
  assert.match(cleanFrame(view), /确认撤销/);
  view.stdin.write("y");
  await waitForInk();
  assert.deepEqual(revoked, { routeKey: "feishu-default:default:direct:oc_pending", unbindSession: false });

  view.unmount();
});

test("Runtime TUI keeps full log messages and caps store at 300 entries", async () => {
  const store = new RuntimeLogStore();
  const longMessage = "这是一条很长的运行日志，用于确认运行期 TUI 不再把正文截断成省略号，而是完整交给终端自动换行展示。full-log-message-tail";
  store.add("system", "INFO", longMessage);
  for (let index = 0; index < 305; index += 1) {
    store.add("progress", "TEST", `log-${index}`);
  }

  assert.equal(store.snapshot().length, 300);
  assert.equal(store.snapshot()[0]?.message, "log-5");

  const displayStore = new RuntimeLogStore();
  displayStore.add("system", "INFO", longMessage);
  const view = render(<RuntimeLogView summary={{
    title: `${expectedChatCodexTitle()} 运行中`,
    channels: ["feishu-default"],
    cwd: "/repo",
    policy: { permissionMode: "approval", sandbox: "workspace-write" },
    routePolicy: "首条消息自动创建新 session",
    codexStatus: codexStatusFixture(),
  }} store={displayStore} />);
  await waitForInk();

  assert.match(cleanFrame(view), /full-log-message-tail/);
  assert.doesNotMatch(cleanFrame(view), /full-log-message-tai…/);

  view.stdin.write("c");
  await waitForInk();
  assert.equal(displayStore.snapshot().length, 0);

  view.unmount();
});

test("Runtime TUI scrolls log content by rendered lines", async () => {
  const store = new RuntimeLogStore();
  for (let index = 0; index < 24; index += 1) {
    store.add("progress", "TEST", `log-${index}`);
  }
  const view = render(<RuntimeLogView summary={{
    title: `${expectedChatCodexTitle()} 运行中`,
    channels: ["feishu-default"],
    cwd: "/repo",
    policy: { permissionMode: "approval", sandbox: "workspace-write" },
    routePolicy: "首条消息自动创建新 session",
    codexStatus: codexStatusFixture(),
  }} store={store} />);
  await waitForInk();

  assert.match(cleanFrame(view), /log-23/);
  assert.doesNotMatch(cleanFrame(view), /log-0/);

  for (let index = 0; index < 80; index += 1) view.stdin.write("k");
  await waitForInk();
  assert.match(cleanFrame(view), /log-0/);
  assert.match(cleanFrame(view), /↓ 还有/);

  for (let index = 0; index < 80; index += 1) view.stdin.write("j");
  await waitForInk();
  assert.match(cleanFrame(view), /log-23/);

  view.unmount();
});

test("Runtime TUI exits on Ctrl+C signal so Bridge can stop", async () => {
  const store = new RuntimeLogStore();
  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }) as NodeJS.WriteStream;
  stdout.columns = 100;
  stdout.rows = 30;

  const done = runRuntimeLogTui({
    title: `${expectedChatCodexTitle()} 运行中`,
    channels: ["feishu-default"],
    cwd: "/repo",
    policy: { permissionMode: "approval", sandbox: "workspace-write" },
    routePolicy: "首条消息自动创建新 session",
  }, store, { stdout, interactive: false });
  await waitForInk();

  process.emit("SIGINT");
  await done;
});

function mockActions(
  dashboard: LauncherDashboard,
  overrides: {
    addFeishuBot?: (input: { appId?: string; appSecret?: string; domain?: string; accountId?: string }) => Promise<unknown>;
    checkWeixinLogin?: () => Promise<unknown>;
    listWeixinPrimaryChoices?: () => { selectable: unknown[]; unavailable: unknown[] };
    setWeixinPrimaryNew?: (channel: unknown) => unknown;
    trustRouteManually?: (routeKey: string) => unknown;
    revokeRouteTrust?: (routeKey: string, options?: { unbindSession?: boolean }) => unknown;
  } = {},
): LauncherActions {
  return {
    getDashboard: async () => dashboard,
    getStartup: () => dashboard.startup,
    getPlan: () => ({ unboundRoutePolicy: "auto_new" }),
    getBinding: (routeKey: string) => dashboard.bindings.find((binding) => binding.route.routeKey === routeKey),
    getPairingRoute: (routeKey: string) => dashboard.pairing.routes.find((route) => route.route.routeKey === routeKey),
    trustRouteManually: overrides.trustRouteManually ?? ((routeKey: string) => {
      const route = dashboard.pairing.routes.find((item) => item.route.routeKey === routeKey);
      return route ? { ok: true, route, message: `已手动信任：${route.label}` } : { ok: false, reason: "not_found", message: "没有找到这个聊天 route。" };
    }),
    revokeRouteTrust: overrides.revokeRouteTrust ?? ((routeKey: string) => {
      const route = dashboard.pairing.routes.find((item) => item.route.routeKey === routeKey);
      return route ? { ok: true, route, message: `已撤销信任：${route.label}` } : { ok: false, reason: "not_found", message: "没有找到这个聊天 route。" };
    }),
    startWeixinLogin: async () => ({
      started: {
        state: "login_required",
        message: "微信扫码登录已发起。",
        sessionKey: "login-session",
      },
      qrCode: "QR-CODE",
      fallbackLink: "https://login.example/qr",
    }),
    checkWeixinLogin: overrides.checkWeixinLogin ?? (async () => ({ state: "pending", message: "还没有检测到扫码确认。" })),
    cancelWeixinLogin: () => ({ state: "cancelled", message: "已返回管理渠道，未添加微信账号。" }),
    addFeishuBot: overrides.addFeishuBot ?? (async () => ({ ok: true, message: "飞书机器人已添加。" })),
    listSessionChoices: () => ({ selectable: [], unavailable: [] }),
    listWeixinPrimaryChoices: overrides.listWeixinPrimaryChoices ?? (() => ({ selectable: [], unavailable: [] })),
    setWeixinPrimaryNew: overrides.setWeixinPrimaryNew ?? (() => ({ ok: true, message: "已设置：收到第一条微信私聊后创建新 session。" })),
    setWeixinPrimaryNone: () => ({ ok: true, message: "已设置：暂不绑定，首条消息自动创建。" }),
    setWeixinPrimaryExisting: () => ({ ok: true, message: "已设置微信主聊天绑定。" }),
    formatRunPolicy: () => "审批模式（workspace-write 沙箱）",
    getCurrentProcessWorkdir: () => "/terminal/repo",
    setDefaultWorkdir: (input?: string, options?: { createIfMissing?: boolean }) => {
      const cwd = input?.trim() || "/terminal/repo";
      if (cwd === "/missing/repo" && !options?.createIfMissing) {
        return { ok: false, reason: "missing", cwd, message: "工作目录不存在: /missing/repo。确认后会创建这个目录。" };
      }
      dashboard.startup.cwd = cwd;
      return { ok: true, cwd, created: Boolean(options?.createIfMissing), message: `已设置新 session 工作目录：${cwd}` };
    },
    startConfirmationSummary: () => [
      "即将启动",
      "",
      "渠道",
      "- 飞书 / default: 已连接",
      "",
      "聊天绑定",
      "- 新聊天策略: 首条消息自动创建新 session",
      "- 待生效绑定: 1",
      "",
      "权限",
      "- 新 session 默认权限: 审批模式（workspace-write 沙箱）",
      "",
      "运行",
      "- 新 session 工作目录: /repo",
    ],
  } as unknown as LauncherActions;
}

function dashboardFixture(): LauncherDashboard {
  const dashboard: LauncherDashboard = {
    channels: [{
      record: {
        id: "feishu-default",
        type: "feishu",
        enabled: true,
        stateDir: "state/channels/feishu/feishu-default",
        defaultAccountId: "default",
        credentialSource: "interactive",
        createdAt: "2026-05-16T00:00:00.000Z",
        updatedAt: "2026-05-16T00:00:00.000Z",
      },
      status: {
        channelId: "feishu-default",
        state: "connected",
        account: "default",
      },
      capabilities: {
        text: true,
        media: false,
        typing: true,
        direct: true,
        group: false,
        thread: false,
        login: "none",
        messageUpdate: false,
        streamingHint: true,
      },
    }],
    bindings: [{
      route: {
        routeKey: "feishu-default:default:direct:oc_abc",
        channelId: "feishu-default",
        channelType: "feishu",
        accountId: "default",
        conversationKind: "direct",
        conversationId: "oc_abc",
        identity: {
          lastSenderDisplayName: "张三",
        },
        createdAt: "2026-05-16T00:00:00.000Z",
        updatedAt: "2026-05-16T00:00:00.000Z",
      },
      label: "飞书 / default / 张三",
      trusted: true,
    }, {
      route: {
        routeKey: "feishu-default:default:direct:oc_pending",
        channelId: "feishu-default",
        channelType: "feishu",
        accountId: "default",
        conversationKind: "direct",
        conversationId: "oc_pending",
        identity: {
          lastSenderDisplayName: "李四",
        },
        lastSeenAt: "2026-05-17T00:00:00.000Z",
        createdAt: "2026-05-17T00:00:00.000Z",
        updatedAt: "2026-05-17T00:00:00.000Z",
      },
      label: "飞书 / default / 李四",
      trusted: false,
    }],
    pendingBindings: [{
      id: "weixin-primary-weixin-wx-main-wx-main",
      channelId: "weixin-wx-main",
      accountId: "wx-main",
      conversationKind: "direct",
      label: "微信 / wx-main / 主聊天",
      binding: { type: "existing", sessionId: "019e3024-session" },
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    }],
    routes: {
      known: 2,
      bound: 0,
      pending: 0,
      unboundPolicy: "auto_new",
    },
    startup: {
      adapterMode: "app-server",
      cwd: "/repo",
      policy: {
        permissionMode: "approval",
        sandbox: "workspace-write",
      },
      codexStatus: codexStatusFixture(),
    },
    pairing: {
      trusted: 1,
      pending: 1,
      routes: [],
    },
    canStart: {
      ok: true,
      channels: [],
      message: "可以启动服务。",
    },
  };
  dashboard.canStart = {
    ok: true,
    channels: dashboard.channels,
    message: "可以启动服务。",
  };
  dashboard.pairing.routes = dashboard.bindings.map((binding) => ({
    route: binding.route,
    label: binding.label,
    trusted: binding.trusted !== false,
    trustedRecord: binding.trusted === false ? undefined : {
      routeKey: binding.route.routeKey,
      channelId: binding.route.channelId,
      accountId: binding.route.accountId,
      conversationKind: binding.route.conversationKind,
      conversationId: binding.route.conversationId,
      displayName: binding.route.displayName,
      trustedAt: "2026-05-16T00:00:00.000Z",
      trustedBySenderId: "ou_abc",
      trustedBySenderDisplayName: "张三",
      trustMethod: "pairing_code" as const,
      lastSeenAt: binding.route.lastSeenAt,
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    },
    activeSession: binding.activeSession,
  })).sort((left, right) => Number(left.trusted) - Number(right.trusted));
  return dashboard;
}

function codexStatusFixture(): LauncherDashboard["startup"]["codexStatus"] {
  return {
    available: true,
    codexBin: "/usr/local/bin/codex",
    requestedCodexBin: "codex",
    codexBinSource: "path",
    platform: "darwin",
    arch: "arm64",
    version: "codex-cli 0.130.0",
    command: {
      command: "/usr/local/bin/codex",
      requested: "codex",
      source: "path",
      platform: "darwin",
      arch: "arm64",
      pathResolved: true,
    },
  };
}

function emptyDashboardFixture(): LauncherDashboard {
  return {
    ...dashboardFixture(),
    channels: [],
    bindings: [],
    pendingBindings: [],
    routes: {
      known: 0,
      bound: 0,
      pending: 0,
      unboundPolicy: "auto_new",
    },
    pairing: {
      trusted: 0,
      pending: 0,
      routes: [],
    },
    canStart: {
      ok: false,
      reason: "no_enabled_channels",
      message: "还没有启用的渠道。请先添加或启用微信账号、飞书机器人。",
    },
  };
}

async function waitForInk(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}
