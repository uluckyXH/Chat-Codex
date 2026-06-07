import test from "node:test";
import assert from "node:assert/strict";
import {
  formatChannelCapabilities,
  formatChannelManagementMenu,
  formatChannelStatusDetails,
  formatCodexSettingsMenu,
  formatFirstRouteBindingMenu,
  formatFirstRoutePresetForUser,
  formatRouteBindingMenu,
  formatServeHomeSummary,
  formatStartConfirmation,
  formatUnboundRoutePolicyMenu,
  formatWorkdirSettingsMenu,
  parseChannelManageChoice,
  parseFirstRouteSetupChoice,
  parseRouteManageChoice,
  parseServeHomeChoice,
  parseUnboundRoutePolicyChoice,
} from "../../src/cli/serve-wizard.js";

const weixinCapabilities = {
  text: true,
  media: true,
  typing: true,
  direct: true,
  group: false,
  thread: false,
  login: "qr" as const,
  messageUpdate: false,
  streamingHint: true,
};

const weixinChannel = {
  id: "weixin",
  type: "weixin",
  enabled: true,
  status: {
    channelId: "weixin",
    state: "connected" as const,
    account: "wx-account-1",
  },
  capabilities: weixinCapabilities,
};

test("serve wizard formats channel-first home summary with Chinese actions", () => {
  const text = formatServeHomeSummary({
    codex: {
      adapterMode: "app-server",
      permissionMode: "approval",
      cwd: "/repo",
      progressMode: "brief",
      progressDisabled: true,
    },
    channels: [weixinChannel],
    routes: {
      known: 0,
      bound: 0,
      unboundPolicy: "auto_new",
    },
  });

  assert.ok(text.includes("Codex Chat Bridge"));
  assert.ok(text.includes("当前位置：首页"));
  assert.ok(text.includes("渠道"));
  assert.ok(text.includes("聊天绑定"));
  assert.ok(text.includes("权限"));
  assert.ok(text.includes("1. 管理渠道"));
  assert.ok(text.includes("2. 聊天绑定"));
  assert.ok(text.includes("3. 权限设置"));
  assert.ok(text.includes("4. 工作目录"));
  assert.ok(text.includes("5. 状态详情"));
  assert.ok(text.includes("6. 启动服务"));
  assert.ok(text.includes("新 session 工作目录: /repo"));
  assert.ok(text.includes("0. 退出"));
  assert.ok(text.includes("- 微信（weixin）- 已启用，已连接"));
  assert.ok(text.includes("主要能力: 文本、私聊、图片/文件、输入状态、扫码登录"));
  assert.ok(text.includes("待生效绑定: 0"));
  assert.ok(text.includes("配置好后，需要启动服务才会真正的工作！"));
  assert.doesNotMatch(text, /首个微信私聊: 不预设/);
  assert.doesNotMatch(text, /Codex 默认设置|接入方式|阶段进度|并发上限|enabled=true|state=connected|account=|unlimited|Adapter:|Permission:|Progress:|启动配置/);
});

test("serve wizard parses home and submenu choices", () => {
  assert.equal(parseServeHomeChoice(""), "start");
  assert.equal(parseServeHomeChoice("1"), "manage_channels");
  assert.equal(parseServeHomeChoice("2"), "manage_routes");
  assert.equal(parseServeHomeChoice("3"), "codex_settings");
  assert.equal(parseServeHomeChoice("权限"), "codex_settings");
  assert.equal(parseServeHomeChoice("4"), "workdir_settings");
  assert.equal(parseServeHomeChoice("d"), "workdir_settings");
  assert.equal(parseServeHomeChoice("5"), "status");
  assert.equal(parseServeHomeChoice("6"), "start");
  assert.equal(parseServeHomeChoice("0"), "exit");

  assert.equal(parseChannelManageChoice(""), "login");
  assert.equal(parseChannelManageChoice("2"), "status");
  assert.equal(parseChannelManageChoice("3"), "add");
  assert.equal(parseChannelManageChoice("0"), "back");

  assert.equal(parseRouteManageChoice(""), "policy");
  assert.equal(parseRouteManageChoice("2"), "first_route");
  assert.equal(parseRouteManageChoice("3"), "bindings");
  assert.equal(parseRouteManageChoice("0"), "back");

  assert.equal(parseUnboundRoutePolicyChoice(""), "auto_new");
  assert.equal(parseUnboundRoutePolicyChoice("2"), "ask");
  assert.equal(parseUnboundRoutePolicyChoice("0"), "back");

  assert.equal(parseFirstRouteSetupChoice(""), "none");
  assert.equal(parseFirstRouteSetupChoice("2"), "bind_existing_first_route");
  assert.equal(parseFirstRouteSetupChoice("3"), "new_first_route");
  assert.equal(parseFirstRouteSetupChoice("0"), "back");
});

test("serve wizard formats mode pages with return actions", () => {
  const routes = {
    known: 0,
    bound: 0,
    unboundPolicy: "ask" as const,
    firstRouteBindingChoice: "bind_existing_first_route" as const,
    initialSessionId: "session-123",
    initialSessionTitle: "一个很长的会话标题已经在上游格式化阶段被截断",
  };

  const channelText = formatChannelManagementMenu(weixinChannel);
  assert.ok(channelText.includes("当前位置：首页 > 管理渠道"));
  assert.ok(channelText.includes("1. 登录/重新登录微信"));
  assert.ok(channelText.includes("0. 返回"));

  const routeText = formatRouteBindingMenu(routes);
  assert.ok(routeText.includes("当前位置：首页 > 聊天绑定"));
  assert.ok(routeText.includes("新聊天策略"));
  assert.ok(routeText.includes("查看/切换聊天绑定"));
  assert.ok(routeText.includes("设置新聊天策略"));
  assert.doesNotMatch(routeText, /设置首个微信私聊绑定/);
  assert.ok(routeText.includes("0. 返回"));

  const policyText = formatUnboundRoutePolicyMenu("ask");
  assert.ok(policyText.includes("当前位置：首页 > 聊天绑定 > 新聊天策略"));
  assert.ok(policyText.includes("2. 首条消息先提示 /new 或 /resume"));
  assert.ok(policyText.includes("0. 返回"));

  const firstRouteText = formatFirstRouteBindingMenu(routes);
  assert.ok(firstRouteText.includes("当前位置：首页 > 聊天绑定 > 首个微信私聊"));
  assert.ok(firstRouteText.includes("2. 启动后第一个私聊绑定已有 session"));
  assert.ok(firstRouteText.includes("3. 启动后第一个私聊创建新 session"));
  assert.ok(firstRouteText.includes("0. 返回"));

  const settingsText = formatCodexSettingsMenu({
    adapterMode: "app-server",
    permissionMode: "approval",
    progressMode: "brief",
    progressDisabled: true,
    cwd: "/repo",
  });
  assert.ok(settingsText.includes("当前位置：首页 > 权限设置"));
  assert.ok(settingsText.includes("当前: 审批模式"));
  assert.ok(settingsText.includes("1. 审批模式"));
  assert.ok(settingsText.includes("2. 完全权限"));
  assert.ok(settingsText.includes("0. 返回"));

  const workdirText = formatWorkdirSettingsMenu("/repo");
  assert.ok(workdirText.includes("当前位置：首页 > 工作目录"));
  assert.ok(workdirText.includes("当前新 session 工作目录"));
  assert.ok(workdirText.includes("/repo"));
  assert.ok(workdirText.includes("1. 使用当前终端目录"));
  assert.ok(workdirText.includes("2. 输入目录路径"));
  assert.ok(workdirText.includes("只影响以后新建的 session"));

  const startText = formatStartConfirmation({
    codex: {
      adapterMode: "app-server",
      permissionMode: "approval",
      progressMode: "brief",
      progressDisabled: true,
      cwd: "/repo",
    },
    channel: weixinChannel,
    routes,
  });
  assert.ok(startText.includes("即将启动"));
  assert.ok(startText.includes("新 session 默认权限"));
  assert.ok(startText.includes("配置好后，需要启动服务才会真正的工作！"));
  assert.doesNotMatch(startText, /Codex 默认设置|接入方式|阶段进度|并发上限/);
  assert.ok(startText.includes("1. 启动"));
  assert.ok(startText.includes("0. 返回"));
});

test("serve wizard formats first route preset as pending instead of bound", () => {
  assert.equal(
    formatFirstRoutePresetForUser("bind_existing_first_route", "session-123", "已有会话"),
    "启动后第一个微信私聊绑定已有 session: 已有会话（session-123）",
  );
  assert.equal(
    formatFirstRoutePresetForUser("new_first_route"),
    "启动后第一个微信私聊创建新 session",
  );
  assert.equal(
    formatFirstRoutePresetForUser(undefined),
    "不预设，按新聊天策略处理",
  );
});

test("serve wizard formats capabilities and status details without raw JSON keys", () => {
  const capabilitiesText = formatChannelCapabilities(weixinCapabilities);
  assert.ok(capabilitiesText.includes("微信渠道能力"));
  assert.ok(capabilitiesText.includes("- 图片/文件: 支持"));
  assert.ok(capabilitiesText.includes("- 群聊: 暂不支持"));
  assert.ok(capabilitiesText.includes("- 登录方式: 扫码登录"));

  const statusText = formatChannelStatusDetails({
    channelId: "weixin",
    state: "connected",
    account: "wx-account-1",
    lastInboundAt: "2026-05-16T01:02:03.000Z",
    details: {
      source: "@tencent-weixin/openclaw-weixin",
      sourceVersion: "2.4.4",
      phase: "account-loaded",
      outboundMinIntervalMs: 1200,
      outboundMaxRetries: 2,
    },
  }, weixinCapabilities);

  assert.ok(statusText.includes("渠道状态详情"));
  assert.ok(statusText.includes("- 运行状态: 已连接"));
  assert.ok(statusText.includes("- 登录账号: wx-account-1"));
  assert.ok(statusText.includes("- 当前阶段: 已加载本地登录态"));
  assert.ok(statusText.includes("- 主要能力: 文本、私聊、图片/文件、输入状态、扫码登录"));
  assert.doesNotMatch(statusText, /"state"|"account"|lastInboundAt|outboundMinIntervalMs/);
});
