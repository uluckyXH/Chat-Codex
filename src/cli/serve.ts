import { stdin, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { Bridge, type InitialRouteBinding, type ProgressDeliveryMode, type UnboundRoutePolicy } from "../bridge/bridge.js";
import { LimitedTurnScheduler } from "../bridge/turn-scheduler.js";
import { ChannelRegistry } from "../channels/registry.js";
import { FeishuAdapter } from "../channels/feishu/feishu-adapter.js";
import { WeixinAdapter, type WeixinLoginStartResult } from "../channels/weixin/weixin-adapter.js";
import { FileWeixinAccountStore } from "../channels/weixin/weixin-account-store.js";
import { displayWeixinQrCode } from "../channels/weixin/weixin-qr-display.js";
import { DEFAULT_FEISHU_ACCOUNT_ID, DEFAULT_FEISHU_DOMAIN, missingFeishuCredentials, normalizeFeishuCredentials } from "../channels/feishu/feishu-message.js";
import type { FeishuCredentials } from "../channels/feishu/feishu-types.js";
import { AppServerCodexAdapter } from "../codex/app-server-codex-adapter.js";
import {
  checkCodexCli,
  discoverCodexSessions,
  findCodexSessionById,
  formatCodexSessionTitleForDisplay,
  type CodexPermissionMode,
  type CodexRunPolicy,
  type DiscoveredCodexSession,
} from "../codex/codex-cli.js";
import { ExecCodexAdapter } from "../codex/exec-codex-adapter.js";
import type { CodexAdapter } from "../codex/types.js";
import { resolveNewSessionWorkdir } from "../codex/workdir.js";
import { ConsoleLogger } from "../logging/logger.js";
import { ConsoleTranscriptSink } from "../logging/transcript.js";
import type { ChannelLoginResult, ChannelStatus } from "../protocol/channel.js";
import { BindingActions, formatOwnerRouteLabel, formatRunPolicyForUser, type BindingSummary, type SessionChoices } from "./actions/binding-actions.js";
import { ChannelActions, formatManagedChannelList, type ManagedChannelSummary } from "./actions/channel-actions.js";
import { FileStateStore } from "../state/file-state-store.js";
import { pendingBindingOwnerRouteKey } from "../state/memory-state-store.js";
import type { ChannelInstanceRecord } from "../state/persistent-state-types.js";
import {
  formatAdapterModeForUser,
  formatChannelCapabilities,
  formatChannelManagementMenu,
  formatChannelStateForUser,
  formatChannelStatusDetails,
  formatCodexSettingsMenu,
  formatFirstRouteBindingMenu,
  formatFirstRoutePresetForUser,
  formatMaxConcurrentTurnsForUser,
  formatPermissionModeForUser,
  formatProgressModeForUser,
  formatRouteBindingMenu,
  formatServeHomeSummary,
  formatStartConfirmation,
  formatUnboundRoutePolicyForUser,
  formatUnboundRoutePolicyMenu,
  parseChannelManageChoice,
  parseFirstRouteSetupChoice,
  parseRouteManageChoice,
  parseServeHomeChoice,
  parseUnboundRoutePolicyChoice,
  type FirstRouteBindingChoice,
  type ServeChannelSummary,
  type ServeRouteSummary,
} from "./serve-wizard.js";

export interface ServeStartupOptions {
  session?: string;
  permission?: CodexPermissionMode;
  codexAdapter?: RealCodexAdapterMode;
  yesDangerouslyFull?: boolean;
  cwd?: string;
  progressMode?: ProgressDeliveryMode;
  maxConcurrentTurns?: number;
  noInteractive?: boolean;
}

type RealCodexAdapterMode = "app-server" | "exec";

const WEIXIN_LOGIN_CHECK_TIMEOUT_MS = 15_000;

interface PreparedServeStartup {
  policy: CodexRunPolicy;
  adapterMode: RealCodexAdapterMode;
  cwd: string;
  progressMode?: ProgressDeliveryMode;
  maxConcurrentTurns?: number;
}

interface ServeChannelPlan {
  status: ChannelStatus;
  unboundRoutePolicy: UnboundRoutePolicy;
  initialRouteBinding?: InitialRouteBinding;
  initialSessionId?: string;
  initialSessionTitle?: string;
  firstRouteBindingChoice?: FirstRouteBindingChoice;
}

export async function runServe(options: ServeStartupOptions = {}): Promise<void> {
  const interactive = Boolean(stdin.isTTY && stdout.isTTY && !options.noInteractive);
  const rl = interactive ? createInterface({ input: stdin, output: stdout }) : undefined;
  let startup: PreparedServeStartup | undefined;
  let plan: ServeChannelPlan | undefined;
  const channelActions = new ChannelActions();
  try {
    startup = await prepareCodexServeStartup(options, rl);
    const setupChannel = new WeixinAdapter({
      pollOnStart: false,
      verifyCodeProvider: rl ? questionWithReadline(rl) : undefined,
    });
    await setupChannel.start();
    const setupStatus = await setupChannel.getStatus();
    channelActions.ensureLegacyWeixinAccountRegistered(setupStatus);
    plan = createInitialChannelPlan(setupStatus, options);
    if (interactive) {
      const shouldStart = await runServeHomeLoop(rl as Interface, startup, plan, channelActions);
      if (!shouldStart) return;
    } else if (channelActions.createRuntimeAdapters().length === 0) {
      throw new Error("未发现可启动的渠道。请先在交互式终端运行 chat-codex 添加微信账号或飞书机器人。");
    }
  } finally {
    rl?.close();
  }
  if (!startup || !plan) return;
  await startServeBridge(startup, plan, channelActions);
}

async function prepareCodexServeStartup(options: ServeStartupOptions, rl?: Interface): Promise<PreparedServeStartup> {
  const status = await checkCodexCli();
  if (!status.available) {
    throw new Error(`Codex 不可用: ${status.error ?? "unknown error"}`);
  }
  console.log("");
  console.log("Codex 已就绪");
  console.log(`- CLI: ${status.version ?? status.codexBin}`);

  const adapterMode = options.codexAdapter ?? "app-server";
  const cwd = await resolveStartupWorkdir(options);
  const permissionMode = options.permission ?? "approval";
  if (permissionMode === "full") {
    await confirmFullPermission(rl, Boolean(options.yesDangerouslyFull));
  }
  const policy: CodexRunPolicy = {
    permissionMode,
    sandbox: permissionMode === "approval" ? "workspace-write" : undefined,
  };
  return {
    policy,
    adapterMode,
    cwd,
    progressMode: options.progressMode,
    maxConcurrentTurns: options.maxConcurrentTurns,
  };
}

async function resolveStartupWorkdir(options: ServeStartupOptions): Promise<string> {
  const resolved = resolveNewSessionWorkdir(options.cwd, process.cwd());
  if (resolved.created) {
    console.log(`工作目录不存在，已创建: ${resolved.cwd}`);
  }
  return resolved.cwd;
}

async function confirmFullPermission(rl: Interface | undefined, alreadyConfirmed: boolean): Promise<void> {
  const warning = "警告：完全权限会让 Codex 跳过审批和沙箱，能够直接执行命令并修改文件。只有在你完全信任当前任务时才继续。";
  console.log(warning);
  if (alreadyConfirmed) return;
  if (!rl) throw new Error("完全权限需要交互确认，或传入 --yes-dangerously-full");
  const answer = await rl.question("如确认继续，请输入 YES: ");
  if (answer.trim() !== "YES") {
    throw new Error("已取消完全权限启动");
  }
}

function createInitialChannelPlan(status: ChannelStatus, options: ServeStartupOptions): ServeChannelPlan {
  const plan: ServeChannelPlan = {
    status,
    unboundRoutePolicy: "auto_new",
  };
  if (!options.session) return plan;
  if (options.session === "new") {
    setFirstRouteNew(plan);
    return plan;
  }
  const session = options.session === "last"
    ? discoverCodexSessions({ limit: 1 })[0]
    : findCodexSessionById(options.session);
  if (!session) {
    throw new Error(`未找到 --session 指定的 Codex session: ${options.session}`);
  }
  setFirstRouteExisting(plan, session.id, session);
  return plan;
}

async function runServeHomeLoop(
  rl: Interface,
  startup: PreparedServeStartup,
  plan: ServeChannelPlan,
  channelActions: ChannelActions,
): Promise<boolean> {
  for (;;) {
    const channelSummaries = await channelActions.listChannelSummaries();
    console.log("");
    console.log(formatServeHomeSummary({
      codex: codexSummary(startup),
      channels: channelSummaries.map(toServeChannelSummary),
      routes: routeSummary(plan),
    }));
    const defaultChoice = channelSummaries.length === 0 ? "1" : "5";
    const input = await rl.question(`请选择 [${defaultChoice}]: `);
    const choice = parseServeHomeChoice(input.trim() ? input : defaultChoice);
    if (choice === "exit") return false;
    if (choice === "manage_channels") {
      await runChannelManagementLoop(rl, startup, plan, channelActions);
      continue;
    }
    if (choice === "manage_routes") {
      await runRouteBindingLoop(rl, startup, plan);
      continue;
    }
    if (choice === "codex_settings") {
      await runCodexSettingsLoop(rl, startup);
      continue;
    }
    if (choice === "status") {
      await printAllChannelStatuses(channelActions);
      continue;
    }
    if (await confirmStart(rl, startup, plan, channelActions)) return true;
  }
}

async function runChannelManagementLoop(
  rl: Interface,
  startup: PreparedServeStartup,
  plan: ServeChannelPlan,
  channelActions: ChannelActions,
): Promise<void> {
  for (;;) {
    const channels = await channelActions.listChannelSummaries();
    console.log("");
    console.log(formatManagedChannelList(channels));
    const answer = normalizeText(await rl.question("请选择渠道编号 / 操作 [0 返回]: "));
    if (!answer || answer === "0" || isBackText(answer)) return;
    const index = Number.parseInt(answer, 10);
    if (Number.isInteger(index) && index >= 1 && index <= channels.length) {
      await manageConfiguredChannel(rl, startup, channelActions, channels[index - 1]);
      continue;
    }
    if (isAddWeixinAction(answer) || index === channels.length + 1) {
      const record = await addWeixinAccount(rl, channelActions);
      if (record) await configureWeixinPrimaryBinding(rl, startup, record);
      continue;
    }
    if (isAddFeishuAction(answer) || index === channels.length + 2) {
      await addFeishuBot(rl, channelActions);
      continue;
    }
    console.log("没有这个选项，请重新选择。");
  }
}

async function addWeixinAccount(rl: Interface, channelActions: ChannelActions): Promise<ChannelInstanceRecord | undefined> {
  const channel = new WeixinAdapter({
    pollOnStart: false,
    verifyCodeProvider: questionWithReadline(rl),
  });
  console.log("");
  console.log("添加微信账号");
  console.log(formatChannelCapabilities(channel.getCapabilities()));
  try {
    const started = await channel.startLogin();
    console.log(started.message);
    if (started.qrCodeText) {
      await displayWeixinQrCode(started.qrCodeText);
    }
    const loginResult = await waitWeixinLoginFromQrMenu(rl, channel, started);
    if (!loginResult) {
      console.log("已返回管理渠道，未添加微信账号。");
      return undefined;
    }
    const status = await channel.getStatus();
    if (loginResult.state !== "connected") {
      console.log("微信登录未完成，可以稍后重新进入“管理渠道”重试。");
      return undefined;
    }
    const accountId = status.account;
    if (!accountId) {
      console.log("微信登录完成但没有拿到账号标识，暂不能添加到渠道列表。");
      return undefined;
    }
    const account = new FileWeixinAccountStore().loadAccount(accountId);
    if (!account) {
      console.log("微信登录态保存异常，暂不能添加到渠道列表。");
      return undefined;
    }
    const record = channelActions.registerWeixinAccount(account);
    console.log("");
    console.log([
      "微信账号已添加",
      `账号: ${account.accountId}`,
      `渠道实例: ${record.id}`,
      "",
      "下一步: 请选择这个微信主聊天绑定哪个 Codex session。",
    ].join("\n"));
    return record;
  } catch (error) {
    console.log(`微信登录失败: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function waitWeixinLoginFromQrMenu(
  rl: Interface,
  channel: WeixinAdapter,
  started: WeixinLoginStartResult,
): Promise<ChannelLoginResult | undefined> {
  for (;;) {
    console.log("");
    console.log([
      "微信扫码登录",
      "",
      "扫码并在手机上确认后，按回车检查登录结果。",
      "不想登录就输入 0 返回管理渠道。",
    ].join("\n"));
    const answer = normalizeText(await rl.question("请选择 [回车检查 / 0 返回]: "));
    if (answer === "0" || isBackText(answer)) return undefined;
    if (answer && answer !== "c" && answer !== "check" && answer !== "检查") {
      console.log("没有这个选项。按回车检查登录结果，或输入 0 返回。");
      continue;
    }
    const result = await channel.waitLogin(started.sessionKey, WEIXIN_LOGIN_CHECK_TIMEOUT_MS);
    console.log(result.message);
    if (result.state === "connected" || result.state === "failed") return result;
    if (!result.message.includes("超时")) return result;
    console.log("还没有检测到扫码确认。可以继续按回车检查，或输入 0 返回。");
  }
}

async function addFeishuBot(rl: Interface, channelActions: ChannelActions): Promise<void> {
  console.log("");
  console.log([
    "添加飞书机器人",
    "",
    "请手动输入这次要添加的 App ID / App Secret。",
    "Secret 只保存在当前进程内存里，不会写入 Git 或状态文件。",
    "长期运行也可以在启动前通过 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量提供。",
    "输入 0 返回上一级。",
  ].join("\n"));
  const credentials = await askFeishuCredentials(rl);
  if (!credentials) return;
  const missing = missingFeishuCredentials(credentials);
  if (missing.length > 0) {
    console.log(`缺少飞书配置: ${missing.join(", ")}。请重新输入完整配置。`);
    return;
  }
  const adapter = new FeishuAdapter({
    ...credentials,
    id: `feishu-${credentials.accountId ?? DEFAULT_FEISHU_ACCOUNT_ID}`,
    connectOnStart: false,
    probeOnStart: false,
  });
  await adapter.start();
  const status = await adapter.getStatus();
  if (status.state !== "connected") {
    console.log(status.lastError ?? "飞书机器人配置检查失败。");
    return;
  }
  const record = channelActions.registerFeishuBot(credentials, "interactive");
  console.log("");
  console.log([
    "飞书机器人已添加",
    `账号标识: ${record.defaultAccountId ?? DEFAULT_FEISHU_ACCOUNT_ID}`,
    `渠道实例: ${record.id}`,
    "凭证: 本次进程已记住；重启后请使用环境变量或重新手动添加。",
    "",
    "下一步: 启动服务后，让用户在飞书里私聊机器人。",
    "每个飞书私聊会按 chat_id 生成独立聊天绑定。",
  ].join("\n"));
}

async function askFeishuCredentials(rl: Interface): Promise<FeishuCredentials | undefined> {
  const appId = await askRequired(rl, "请输入 FEISHU_APP_ID: ");
  if (!appId) return undefined;
  const appSecret = await askRequired(rl, "请输入 FEISHU_APP_SECRET（输入会显示在终端）: ");
  if (!appSecret) return undefined;
  const domain = await askOptional(rl, `飞书域 [${DEFAULT_FEISHU_DOMAIN}]: `, DEFAULT_FEISHU_DOMAIN);
  const accountId = await askOptional(rl, `账号标识 [${DEFAULT_FEISHU_ACCOUNT_ID}]: `, DEFAULT_FEISHU_ACCOUNT_ID);
  return normalizeFeishuCredentials({ appId, appSecret, domain, accountId });
}

async function manageConfiguredChannel(
  rl: Interface,
  startup: PreparedServeStartup,
  channelActions: ChannelActions,
  channel: ManagedChannelSummary,
): Promise<void> {
  for (;;) {
    console.log("");
    console.log([
      "渠道详情",
      "",
      `类型: ${channel.record.type === "weixin" ? "微信" : "飞书"}`,
      `账号: ${channel.status.account ?? channel.record.defaultAccountId ?? "default"}`,
      `实例: ${channel.record.id}`,
      `状态: ${formatChannelStateForUser(channel.status.state)}`,
      `启用: ${channel.record.enabled ? "是" : "否"}`,
      channel.status.lastError ? `最近错误: ${channel.status.lastError}` : undefined,
      "",
      channel.record.type === "weixin" ? "1. 设置微信主聊天绑定" : "1. 查看说明",
      `2. ${channel.record.enabled ? "停用" : "启用"}这个渠道`,
      "3. 状态详情",
      "0. 返回",
    ].filter(Boolean).join("\n"));
    const choice = normalizeText(await rl.question("请选择 [0 返回]: "));
    if (!choice || choice === "0" || isBackText(choice)) return;
    if (choice === "1") {
      if (channel.record.type === "weixin") {
        await configureWeixinPrimaryBinding(rl, startup, channel.record);
      } else {
        console.log("飞书机器人不做渠道级 session 绑定；请等用户私聊机器人后，到“聊天绑定”里按具体 chat_id 绑定。");
      }
      continue;
    }
    if (choice === "2") {
      channelActions.setChannelEnabled(channel.record.id, !channel.record.enabled);
      console.log(channel.record.enabled ? "已停用渠道。" : "已启用渠道。");
      return;
    }
    if (choice === "3") {
      console.log(formatChannelStatusDetails(channel.status, channel.capabilities));
      continue;
    }
    console.log("没有这个选项，请重新选择。");
  }
}

async function configureWeixinPrimaryBinding(
  rl: Interface,
  startup: PreparedServeStartup,
  channel: ChannelInstanceRecord,
): Promise<void> {
  const accountId = channel.defaultAccountId;
  if (!accountId) {
    console.log("这个微信渠道缺少账号标识，不能设置主聊天绑定。");
    return;
  }
  const state = new FileStateStore();
  const pendingId = weixinPrimaryPendingId(channel.id, accountId);
  const pendingOwner = pendingBindingOwnerRouteKey(pendingId);
  for (;;) {
    const choices = new BindingActions(state, { cwd: startup.cwd, sessionLimit: 15 }).listSessionChoices(pendingOwner);
    console.log("");
    const lines = [
      "微信主聊天绑定",
      "",
      `账号: ${accountId}`,
      `渠道实例: ${channel.id}`,
      "",
      "请选择这个微信主聊天使用哪个 Codex session：",
      "",
      ...(choices.selectable.length > 0
        ? choices.selectable.map((session, index) => `  ${index + 1}. ${session.title ?? session.id}    ${session.shortId}`)
        : ["  暂无可选历史 session"]),
      "",
      "操作:",
      "  n. 新建 Codex session",
      "  m. 手动输入 Session ID",
      "  0. 暂不绑定，首条消息自动创建",
    ];
    if (choices.unavailable.length > 0) {
      lines.push("", "不可选（已绑定其他聊天）:");
      for (const session of choices.unavailable) {
        lines.push(`  已绑定到 ${session.ownerLabel}    ${session.title ?? session.id}    ${session.shortId}`);
      }
    }
    console.log(lines.join("\n"));
    const answer = (await rl.question("请选择 session 编号 / 操作 [0]: ")).trim();
    if (!answer || answer === "0" || isBackText(answer)) {
      state.clearPendingBindingForMessage(pendingProbeMessage(channel.id, accountId));
      console.log("已设置：暂不绑定，首条消息自动创建。");
      return;
    }
    if (isNewSessionAction(answer)) {
      state.setPendingBinding({
        id: pendingId,
        channelId: channel.id,
        accountId,
        conversationKind: "direct",
        label: `微信 / ${accountId} / 主聊天`,
        binding: { type: "new" },
      });
      console.log("已设置：收到第一条微信私聊后创建新 session。");
      return;
    }
    const sessionId = await resolveWeixinPrimarySessionId(rl, answer, choices);
    if (!sessionId) continue;
    const session = findCodexSessionById(sessionId);
    if (!session) {
      console.log("没有找到这个 session。请重新输入编号或有效 Session ID；输入 0 返回。");
      continue;
    }
    const owner = state.getSessionOwner(session.id);
    if (owner && owner.ownerRouteKey !== pendingOwner) {
      console.log(`无法预留这个 session：${session.id} 已绑定到 ${formatOwnerRouteLabel(state, owner.ownerRouteKey)}。请先到“聊天绑定”里解绑原聊天，或选择其他 session。`);
      continue;
    }
    state.setPendingBinding({
      id: pendingId,
      channelId: channel.id,
      accountId,
      conversationKind: "direct",
      label: `微信 / ${accountId} / 主聊天`,
      binding: { type: "existing", sessionId: session.id },
    });
    console.log([
      "已设置微信主聊天绑定",
      `聊天: 微信 / ${accountId} / 主聊天`,
      `待绑定 session: ${formatCodexSessionTitleForDisplay(session) ?? session.id} / ${shortSessionId(session.id)}`,
      "说明: 收到第一条微信私聊后生效。",
    ].join("\n"));
    return;
  }
}

async function resolveWeixinPrimarySessionId(
  rl: Interface,
  answer: string,
  choices: SessionChoices,
): Promise<string | undefined> {
  if (isManualSessionInputAction(answer)) {
    const manual = (await rl.question("请输入 Session ID [0 返回]: ")).trim();
    if (!manual || manual === "0" || isBackText(manual)) return undefined;
    return manual;
  }
  if (/^\d+$/.test(answer)) {
    const index = Number.parseInt(answer, 10);
    if (index >= 1 && index <= choices.selectable.length) return choices.selectable[index - 1].id;
    console.log(`没有第 ${index} 项，请重新选择。`);
    return undefined;
  }
  return answer;
}

function weixinPrimaryPendingId(channelId: string, accountId: string): string {
  return `weixin-primary-${channelId}-${accountId}`;
}

function pendingProbeMessage(channelId: string, accountId: string) {
  return {
    id: "pending-probe",
    routeKey: `${channelId}:${accountId}:direct:pending-probe`,
    channelId,
    accountId,
    sender: { id: "pending-probe" },
    conversation: { id: "pending-probe", kind: "direct" as const },
    text: "",
    timestamp: new Date().toISOString(),
  };
}

function shortSessionId(sessionId: string): string {
  return sessionId.length <= 8 ? sessionId : sessionId.slice(0, 8);
}

async function printAllChannelStatuses(channelActions: ChannelActions): Promise<void> {
  const channels = await channelActions.listChannelSummaries();
  console.log("");
  if (channels.length === 0) {
    console.log("还没有配置渠道。请先进入“管理渠道”添加微信账号或飞书机器人。");
    return;
  }
  for (const channel of channels) {
    console.log(formatChannelStatusDetails(channel.status, channel.capabilities));
    console.log("");
  }
}

async function runRouteBindingLoop(rl: Interface, startup: PreparedServeStartup, plan: ServeChannelPlan): Promise<void> {
  for (;;) {
    console.log("");
    console.log(formatRouteBindingMenu(routeSummary(plan)));
    const answer = normalizeText(await rl.question("请选择 [1]: "));
    if (!answer || answer === "1" || answer === "bindings" || answer === "绑定") {
      await managePersistedBindings(rl, startup);
      continue;
    }
    if (answer === "2" || answer === "policy" || answer === "策略") {
      await configureUnboundRoutePolicy(rl, plan);
      continue;
    }
    if (isBackText(answer)) return;
    console.log("没有这个选项，请重新选择。");
  }
}

async function managePersistedBindings(rl: Interface, startup: PreparedServeStartup): Promise<void> {
  for (;;) {
    const actions = createBindingActions(startup);
    const bindings = actions.listBindings();
    console.log("");
    if (bindings.length === 0) {
      console.log([
        "聊天绑定",
        "",
        "还没有发现任何聊天。",
        "启动服务后，微信私聊或飞书用户私聊机器人会自动记录在这里。",
        "",
        "0. 返回",
      ].join("\n"));
      const answer = normalizeText(await rl.question("请选择 [0 返回]: "));
      if (!answer || answer === "0" || isBackText(answer)) return;
      continue;
    }
    console.log(formatPersistedBindingList(bindings));
    const answer = normalizeText(await rl.question("请选择聊天编号 [0 返回]: "));
    if (!answer || answer === "0" || isBackText(answer)) return;
    const index = Number.parseInt(answer, 10);
    if (!Number.isInteger(index) || index < 1 || index > bindings.length) {
      console.log("没有这个聊天编号，请重新选择。");
      continue;
    }
    const outcome = await manageBindingDetail(rl, startup, bindings[index - 1].route.routeKey);
    if (outcome === "home") return;
  }
}

async function manageBindingDetail(rl: Interface, startup: PreparedServeStartup, routeKey: string): Promise<"list" | "home"> {
  for (;;) {
    const actions = createBindingActions(startup);
    const binding = actions.getBinding(routeKey);
    if (!binding) {
      console.log("这个聊天记录已经不存在。");
      return "list";
    }
    console.log("");
    console.log(actions.formatBindingDetail(binding));
    const answer = normalizeText(await rl.question("请选择 [0 返回]: "));
    if (!answer || answer === "0" || isBackText(answer)) return "list";
    if (answer === "1" || answer === "switch" || answer === "切换") {
      const outcome = await switchBindingSession(rl, startup, routeKey);
      if (outcome === "home") return "home";
      continue;
    }
    if (answer === "2" || answer === "new" || answer === "新建") {
      const outcome = await createAndBindNewSession(rl, startup, routeKey);
      if (outcome === "home") return "home";
      continue;
    }
    if (answer === "3" || answer === "permission" || answer === "权限") {
      if (!binding.activeSession) {
        console.log("当前聊天还没有绑定 session，不能设置 session 级权限。");
        continue;
      }
      await configureBoundSessionPermission(rl, startup, binding);
      continue;
    }
    if (answer === "4" || answer === "unbind" || answer === "解绑") {
      const outcome = await unbindBindingSession(rl, startup, routeKey);
      if (outcome === "home") return "home";
      continue;
    }
    console.log("未识别选择，请重新输入。");
  }
}

async function switchBindingSession(rl: Interface, startup: PreparedServeStartup, routeKey: string): Promise<"detail" | "home"> {
  for (;;) {
    const actions = createBindingActions(startup);
    const choices = actions.listSessionChoices(routeKey);
    console.log("");
    console.log(actions.formatSessionChoices(routeKey, choices));
    const answer = (await rl.question("请选择 session 编号，或输入 m 手动输入 ID [0 返回]: ")).trim();
    if (!answer || answer === "0" || isBackText(answer)) return "detail";
    const sessionId = await resolveSessionIdFromChoiceInput(rl, answer, choices);
    if (!sessionId) continue;
    const result = createBindingActions(startup).bindExistingSession(routeKey, sessionId);
    if (!result.ok) {
      console.log(result.message);
      continue;
    }
    console.log("");
    console.log(createBindingActions(startup).formatBindSuccess(result));
    const next = normalizeText(await rl.question("请选择 [1 返回绑定详情 / 0 返回首页]: "));
    return next === "0" ? "home" : "detail";
  }
}

async function createAndBindNewSession(rl: Interface, startup: PreparedServeStartup, routeKey: string): Promise<"detail" | "home"> {
  const binding = createBindingActions(startup).getBinding(routeKey);
  console.log("");
  console.log([
    "新建并绑定 session",
    "",
    `聊天: ${binding?.label ?? routeKey}`,
    `工作目录: ${startup.cwd}`,
    `新 session 默认权限: ${formatRunPolicyForUser(startup.policy)}`,
    "",
    "1. 创建并绑定",
    "0. 返回",
  ].join("\n"));
  const answer = normalizeText(await rl.question("请选择 [1]: "));
  if (answer === "0" || isBackText(answer)) return "detail";
  const codex = createRealCodexAdapter(startup);
  try {
    const session = await codex.startSession({
      routeKey,
      cwd: startup.cwd,
      title: `channel:${routeKey}`,
    });
    const result = createBindingActions(startup).bindNewSession(routeKey, session);
    if (!result.ok) {
      console.log(result.message);
      return "detail";
    }
    console.log("");
    console.log([
      "已新建并绑定 session",
      "",
      `聊天: ${result.binding.label}`,
      `当前 session: ${result.session.title ?? result.session.id} / ${result.session.shortId}`,
      result.session.cwd ? `工作目录: ${result.session.cwd}` : undefined,
      "",
      "1. 返回绑定详情",
      "0. 返回首页",
    ].filter(Boolean).join("\n"));
    const next = normalizeText(await rl.question("请选择 [1 返回绑定详情 / 0 返回首页]: "));
    return next === "0" ? "home" : "detail";
  } finally {
    if (codex.stop) await codex.stop().catch(() => undefined);
  }
}

async function unbindBindingSession(rl: Interface, startup: PreparedServeStartup, routeKey: string): Promise<"detail" | "home"> {
  const actions = createBindingActions(startup);
  const binding = actions.getBinding(routeKey);
  if (!binding?.activeSession) {
    console.log("当前聊天没有绑定 session。");
    return "detail";
  }
  console.log("");
  console.log([
    "解绑当前 session",
    "",
    `聊天: ${binding.label}`,
    `当前 session: ${binding.activeSession.title ?? binding.activeSession.id} / ${binding.activeSession.shortId}`,
    "",
    "解绑后，这个 session 可以被其他聊天重新绑定。",
  ].join("\n"));
  const answer = await rl.question("确认解绑请输入 YES [其他输入取消]: ");
  if (answer.trim() !== "YES") {
    console.log("已取消解绑。");
    return "detail";
  }
  const result = createBindingActions(startup).unbindSession(routeKey);
  console.log("");
  if (!result.ok) {
    console.log(result.message);
    return "detail";
  }
  console.log([
    "已解绑 session",
    "",
    `聊天: ${result.binding.label}`,
    `已解绑 session: ${result.sessionId}`,
    "",
    "1. 返回绑定详情",
    "0. 返回首页",
  ].join("\n"));
  const next = normalizeText(await rl.question("请选择 [1 返回绑定详情 / 0 返回首页]: "));
  return next === "0" ? "home" : "detail";
}

async function resolveSessionIdFromChoiceInput(
  rl: Interface,
  answer: string,
  choices: SessionChoices,
): Promise<string | undefined> {
  if (isManualSessionInputAction(answer)) {
    const manual = (await rl.question("请输入 Session ID [0 返回]: ")).trim();
    if (!manual || manual === "0" || isBackText(manual)) return undefined;
    return manual;
  }
  if (/^\d+$/.test(answer)) {
    const index = Number.parseInt(answer, 10);
    if (index >= 1 && index <= choices.selectable.length) {
      return choices.selectable[index - 1].id;
    }
    console.log(`没有第 ${index} 项，请重新选择。`);
    return undefined;
  }
  return answer;
}

async function configureBoundSessionPermission(
  rl: Interface,
  startup: PreparedServeStartup,
  binding: BindingSummary,
): Promise<void> {
  const sessionId = binding.activeSession?.id;
  if (!sessionId) return;
  const actions = createBindingActions(startup);
  const current = actions.getSessionPermission(sessionId) ?? startup.policy;
  console.log("");
  console.log([
    "当前 session 权限",
    "",
    `聊天: ${binding.label}`,
    `Session: ${binding.activeSession?.title ?? sessionId} / ${binding.activeSession?.shortId ?? sessionId}`,
    `当前: ${formatRunPolicyForUser(current)}`,
    "",
    "1. 审批模式（推荐）",
    "2. 完全权限（高风险，需要输入 YES）",
    "0. 返回",
  ].join("\n"));
  const answer = normalizeText(await rl.question("请选择 [0 返回]: "));
  if (!answer || answer === "0" || isBackText(answer)) return;
  const policy: CodexRunPolicy = answer === "2" || answer === "full"
    ? { permissionMode: "full" }
    : { permissionMode: "approval", sandbox: "workspace-write" };
  if (policy.permissionMode === "full") {
    try {
      await confirmFullPermission(rl, false);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      return;
    }
  }
  actions.setSessionPermission(sessionId, policy);
  console.log("");
  console.log([
    "已设置当前 session 权限",
    `聊天: ${binding.label}`,
    `Session: ${binding.activeSession?.title ?? sessionId} / ${binding.activeSession?.shortId ?? sessionId}`,
    `当前权限: ${formatRunPolicyForUser(policy)}`,
    "说明: 只影响这个 session 后续任务；当前正在运行的任务不会被改写。",
  ].join("\n"));
}

function createBindingActions(startup: PreparedServeStartup): BindingActions {
  return new BindingActions(new FileStateStore(), { cwd: startup.cwd });
}

function formatPersistedBindingList(bindings: BindingSummary[]): string {
  return [
    "聊天绑定",
    "",
    ...bindings.map((binding, index) => {
      const session = binding.activeSession
        ? `${binding.activeSession.title ?? binding.activeSession.id} / ${binding.activeSession.shortId}`
        : "未绑定";
      const permission = binding.permission ? `，${formatRunPolicyForUser(binding.permission)}` : "";
      return `${index + 1}. ${binding.label}    ${session}${permission}`;
    }),
    "0. 返回",
  ].join("\n");
}

async function configureUnboundRoutePolicy(rl: Interface, plan: ServeChannelPlan): Promise<void> {
  console.log("");
  console.log(formatUnboundRoutePolicyMenu(plan.unboundRoutePolicy));
  const answer = await rl.question("请选择 [0 返回]: ");
  if (!answer.trim()) return;
  const choice = parseUnboundRoutePolicyChoice(answer);
  if (choice === "back") return;
  plan.unboundRoutePolicy = choice;
  console.log(`已设置新聊天策略: ${formatUnboundRoutePolicyForUser(plan.unboundRoutePolicy)}`);
}

async function configureFirstRouteBinding(rl: Interface, plan: ServeChannelPlan): Promise<void> {
  console.log("");
  console.log(formatFirstRouteBindingMenu(routeSummary(plan)));
  const answer = await rl.question("请选择 [0 返回]: ");
  if (!answer.trim()) return;
  const choice = parseFirstRouteSetupChoice(answer);
  if (choice === "back") return;
  if (choice === "none") {
    clearFirstRouteBinding(plan);
    console.log("已取消首个微信私聊预设绑定。");
    return;
  }
  if (choice === "new_first_route") {
    setFirstRouteNew(plan);
    console.log("已设置：启动后第一个微信私聊创建新 session。");
    return;
  }
  const selected = await selectExistingSessionForFirstRoute(rl);
  if (!selected) return;
  setFirstRouteExisting(plan, selected.sessionId, selected.session);
  console.log(`已设置首个微信私聊绑定: ${formatFirstRoutePresetForUser(plan.firstRouteBindingChoice, plan.initialSessionId, plan.initialSessionTitle)}`);
}

async function selectExistingSessionForFirstRoute(rl: Interface): Promise<{ sessionId: string; session?: DiscoveredCodexSession } | undefined> {
  const sessions = discoverCodexSessions({ limit: 15 });
  for (;;) {
    console.log("");
    console.log("选择已有 Codex session");
    if (sessions.length === 0) {
      console.log("未发现历史 session。可以粘贴本机存在的 Session ID，或输入 0 返回。");
    } else {
      sessions.forEach((session, index) => {
        console.log(formatSessionChoice(index + 1, session));
      });
    }
    console.log("");
    console.log("操作:");
    console.log("  m. 手动输入 Session ID");
    console.log("  0. 返回");
    const answer = (await rl.question("请选择 session 编号，或输入 m 手动输入 ID [0 返回]: ")).trim();
    if (!answer || answer === "0" || isBackText(answer)) return undefined;
    if (isManualSessionInputAction(answer)) {
      const manual = (await rl.question("请输入 Session ID [0 返回]: ")).trim();
      if (!manual || manual === "0" || isBackText(manual)) return undefined;
      const session = sessions.find((item) => item.id === manual) ?? findCodexSessionById(manual);
      if (session) return { sessionId: session.id, session };
      console.log("没有找到这个 session。请重新输入编号或有效 Session ID；输入 0 返回。");
      continue;
    }
    if (/^\d+$/.test(answer)) {
      const index = Number.parseInt(answer, 10);
      const session = sessions[index - 1];
      if (session) return { sessionId: session.id, session };
      console.log(`没有第 ${index} 项，请重新选择。`);
      continue;
    }
    const session = sessions.find((item) => item.id === answer) ?? findCodexSessionById(answer);
    if (session) return { sessionId: session.id, session };
    console.log("没有找到这个 session。请重新输入编号或有效 Session ID；输入 0 返回。");
  }
}

async function runCodexSettingsLoop(rl: Interface, startup: PreparedServeStartup): Promise<void> {
  for (;;) {
    console.log("");
    console.log(formatCodexSettingsMenu({
      ...codexSummary(startup),
      cwd: startup.cwd,
    }));
    const answer = normalizeText(await rl.question("请选择 [0 返回]: "));
    if (!answer || answer === "0" || isBackText(answer)) return;
    if (answer === "2" || answer === "full") {
      try {
        await confirmFullPermission(rl, false);
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
        continue;
      }
      startup.policy = { permissionMode: "full" };
      console.log("已设置新 session 默认权限: 完全权限");
      continue;
    }
    startup.policy = { permissionMode: "approval", sandbox: "workspace-write" };
    console.log("已设置新 session 默认权限: 审批模式");
  }
}

async function configureAdapterMode(rl: Interface, startup: PreparedServeStartup): Promise<void> {
  console.log("");
  console.log([
    "Codex 接入方式",
    `当前: ${formatAdapterModeForUser(startup.adapterMode)}`,
    "",
    "1. Codex app-server（推荐，支持微信审批）",
    "2. Codex exec（备用模式）",
    "0. 返回",
  ].join("\n"));
  const answer = normalizeText(await rl.question("请选择 [0 返回]: "));
  if (!answer || answer === "0" || isBackText(answer)) return;
  if (answer === "1" || answer === "app-server") {
    startup.adapterMode = "app-server";
    console.log("已设置 Codex 接入方式: app-server");
    return;
  }
  if (answer === "2" || answer === "exec") {
    startup.adapterMode = "exec";
    console.log("已设置 Codex 接入方式: exec");
    return;
  }
  console.log("未识别选择，保持原设置。");
}

async function configurePermissionMode(rl: Interface, startup: PreparedServeStartup): Promise<void> {
  console.log("");
  console.log([
    "Codex 权限模式",
    `当前: ${formatPolicyForCli(startup.policy)}`,
    "",
    "1. 审批模式（workspace-write 沙箱，推荐）",
    "2. 完全权限（跳过审批和沙箱，高风险）",
    "0. 返回",
  ].join("\n"));
  const answer = normalizeText(await rl.question("请选择 [0 返回]: "));
  if (!answer || answer === "0" || isBackText(answer)) return;
  if (answer === "2" || answer === "full") {
    try {
      await confirmFullPermission(rl, false);
    } catch (error) {
      console.log(error instanceof Error ? error.message : String(error));
      return;
    }
    startup.policy = { permissionMode: "full" };
    console.log("已设置权限模式: 完全权限");
    return;
  }
  startup.policy = { permissionMode: "approval", sandbox: "workspace-write" };
  console.log("已设置权限模式: 审批模式");
}

async function configureWorkdir(rl: Interface, startup: PreparedServeStartup): Promise<void> {
  console.log("");
  console.log(`当前新 session 工作目录: ${startup.cwd}`);
  const answer = (await rl.question("请输入新目录路径 [留空保持，0 返回]: ")).trim();
  if (!answer || answer === "0" || isBackText(answer)) return;
  try {
    const resolved = resolveNewSessionWorkdir(answer, process.cwd());
    startup.cwd = resolved.cwd;
    console.log(`${resolved.created ? "已创建并设置" : "已设置"}新 session 工作目录: ${startup.cwd}`);
  } catch (error) {
    console.log(`工作目录设置失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function configureMaxConcurrentTurns(rl: Interface, startup: PreparedServeStartup): Promise<void> {
  console.log("");
  console.log(`当前并发上限: ${formatMaxConcurrentTurnsForUser(startup.maxConcurrentTurns)}`);
  const answer = (await rl.question("请输入正整数；留空表示不限制；输入 0 返回: ")).trim();
  if (answer === "0" || isBackText(answer)) return;
  if (!answer) {
    startup.maxConcurrentTurns = undefined;
    console.log("已设置并发上限: 不限制不同聊天并行");
    return;
  }
  const parsed = Number.parseInt(answer, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || !/^\d+$/.test(answer)) {
    console.log("并发上限需要正整数，或留空表示不限制。");
    return;
  }
  startup.maxConcurrentTurns = parsed;
  console.log(`已设置并发上限: ${formatMaxConcurrentTurnsForUser(startup.maxConcurrentTurns)}`);
}

async function confirmStart(
  rl: Interface,
  startup: PreparedServeStartup,
  plan: ServeChannelPlan,
  channelActions: ChannelActions,
): Promise<boolean> {
  const channels = await channelActions.listChannelSummaries();
  const enabled = channels.filter((channel) => channel.record.enabled);
  if (enabled.length === 0) {
    console.log("");
    console.log("还没有启用的渠道。请先进入“管理渠道”添加或启用微信账号、飞书机器人。");
    return false;
  }
  const unavailable = enabled.filter((channel) => channel.status.state !== "connected");
  if (unavailable.length > 0) {
    console.log("");
    console.log("以下渠道还不能启动，请先处理配置或停用：");
    for (const channel of unavailable) {
      console.log(`- ${channel.record.type === "weixin" ? "微信" : "飞书"} / ${channel.status.account ?? channel.record.defaultAccountId ?? channel.record.id}: ${formatChannelStateForUser(channel.status.state)}${channel.status.lastError ? `，${channel.status.lastError}` : ""}`);
    }
    return false;
  }
  console.log("");
  console.log(formatStartConfirmation({
    codex: {
      ...codexSummary(startup),
      cwd: startup.cwd,
    },
    channels: enabled.map(toServeChannelSummary),
    routes: routeSummary(plan),
  }));
  const answer = normalizeText(await rl.question("请选择 [1]: "));
  return !answer || answer === "1" || answer === "start" || answer === "启动";
}

function setFirstRouteExisting(plan: ServeChannelPlan, sessionId: string, session?: DiscoveredCodexSession): void {
  plan.firstRouteBindingChoice = "bind_existing_first_route";
  plan.initialRouteBinding = { type: "existing", sessionId };
  plan.initialSessionId = sessionId;
  plan.initialSessionTitle = session ? formatCodexSessionTitleForDisplay(session) : undefined;
}

function setFirstRouteNew(plan: ServeChannelPlan): void {
  plan.firstRouteBindingChoice = "new_first_route";
  plan.initialRouteBinding = { type: "new" };
  plan.initialSessionId = undefined;
  plan.initialSessionTitle = undefined;
}

function clearFirstRouteBinding(plan: ServeChannelPlan): void {
  plan.firstRouteBindingChoice = undefined;
  plan.initialRouteBinding = undefined;
  plan.initialSessionId = undefined;
  plan.initialSessionTitle = undefined;
}

function codexSummary(startup: PreparedServeStartup) {
  return {
    adapterMode: startup.adapterMode,
    permissionMode: startup.policy.permissionMode,
    progressMode: startup.progressMode,
    progressDisabled: true,
    maxConcurrentTurns: startup.maxConcurrentTurns,
  };
}

function routeSummary(plan: ServeChannelPlan): ServeRouteSummary {
  const state = new FileStateStore();
  const routes = state.listRoutes();
  return {
    known: routes.length,
    bound: routes.filter((route) => route.activeSessionId).length,
    pending: state.listPendingBindings().length,
    unboundPolicy: plan.unboundRoutePolicy,
    firstRouteBindingChoice: plan.firstRouteBindingChoice,
    initialSessionId: plan.initialSessionId,
    initialSessionTitle: plan.initialSessionTitle,
  };
}

function toServeChannelSummary(channel: ManagedChannelSummary): ServeChannelSummary {
  return {
    id: channel.record.id,
    type: channel.record.type,
    enabled: channel.record.enabled,
    status: channel.status,
    capabilities: channel.capabilities,
  };
}

function weixinChannelSummary(status: ChannelStatus): ServeChannelSummary {
  return {
    id: status.channelId,
    type: "weixin",
    enabled: true,
    status,
    capabilities: new WeixinAdapter({ pollOnStart: false }).getCapabilities(),
  };
}

async function startServeBridge(
  startup: PreparedServeStartup,
  plan: ServeChannelPlan,
  channelActions: ChannelActions,
): Promise<void> {
  const adapters = channelActions.createRuntimeAdapters();
  if (adapters.length === 0) {
    throw new Error("未发现可启动的渠道。请先运行 chat-codex，在“管理渠道”里添加并启用微信账号或飞书机器人。");
  }
  const logger = new ConsoleLogger(false);
  const codex = createRealCodexAdapter(startup);
  const bridge = new Bridge({
    channels: new ChannelRegistry({ channels: adapters, logger }),
    codex,
    state: new FileStateStore(),
    logger,
    transcript: new ConsoleTranscriptSink(),
    cwd: startup.cwd,
    initialRouteBinding: plan.initialRouteBinding,
    unboundRoutePolicy: plan.unboundRoutePolicy,
    progressMode: startup.progressMode,
    turnScheduler: startup.maxConcurrentTurns ? new LimitedTurnScheduler(startup.maxConcurrentTurns) : undefined,
  });

  await bridge.start();
  printRuntimeSummary("多渠道 Codex 中间件", startup, { progressDisabled: true });
  console.log(`- 已启动渠道: ${adapters.map((adapter) => adapter.id).join(", ")}`);
  console.log(`- 新聊天策略: ${formatUnboundRoutePolicyForUser(plan.unboundRoutePolicy)}`);
  if (plan.firstRouteBindingChoice) {
    console.log(`- 首个微信私聊: ${formatFirstRoutePresetForUser(plan.firstRouteBindingChoice, plan.initialSessionId, plan.initialSessionTitle)}`);
  }
  await waitForShutdownSignal();
  await bridge.stop();
}

async function askStdin(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

async function askRequired(rl: Interface, prompt: string): Promise<string | undefined> {
  for (;;) {
    const answer = (await rl.question(prompt)).trim();
    if (isBackText(answer)) return undefined;
    if (answer) return answer;
    console.log("这里不能为空，请重新输入；输入 0 返回上一级。");
  }
}

async function askOptional(rl: Interface, prompt: string, defaultValue: string): Promise<string> {
  const answer = (await rl.question(prompt)).trim();
  return answer || defaultValue;
}

function questionWithReadline(rl: Interface): (prompt: string) => Promise<string> {
  return async (prompt: string) => (await rl.question(prompt)).trim();
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

function printRuntimeSummary(
  title: string,
  startup: PreparedServeStartup,
  display: { progressDisabled?: boolean } = {},
): void {
  console.log("");
  console.log(`${title}已启动`);
  console.log("- 会话: 按微信聊天分别绑定；首条消息按策略处理");
  console.log(`- 工作目录: ${startup.cwd}`);
  console.log(`- 新 session 默认权限: ${formatPolicyForCli(startup.policy)}`);
  console.log("- 退出: Ctrl+C");
}

function formatSessionChoice(index: number, session: DiscoveredCodexSession): string {
  const title = formatCodexSessionTitleForDisplay(session);
  const parts = [`${index}. ${title ?? session.id}`];
  parts.push(`   Session ID: ${session.id}`);
  if (session.updatedAt) parts.push(`   最近更新: ${session.updatedAt}`);
  if (session.cwd) parts.push(`   工作目录: ${session.cwd}`);
  return parts.join("\n");
}

function formatPolicyForCli(policy: CodexRunPolicy): string {
  if (policy.permissionMode === "full") return formatPermissionModeForUser(policy.permissionMode);
  return `审批模式（${policy.sandbox ?? "workspace-write"} 沙箱，推荐）`;
}

function createRealCodexAdapter(startup: PreparedServeStartup): CodexAdapter {
  const runPolicy = startup.policy;
  if (startup.adapterMode === "exec") {
    return new ExecCodexAdapter({ runPolicy });
  }
  return new AppServerCodexAdapter({ runPolicy });
}

function normalizeText(input: string): string {
  return input.trim().toLowerCase();
}

function isAddWeixinAction(input: string): boolean {
  const normalized = normalizeText(input);
  return normalized === "w" || normalized === "wx" || normalized === "weixin" || normalized === "微信";
}

function isAddFeishuAction(input: string): boolean {
  const normalized = normalizeText(input);
  return normalized === "f" || normalized === "fs" || normalized === "feishu" || normalized === "lark" || normalized === "飞书";
}

function isNewSessionAction(input: string): boolean {
  const normalized = normalizeText(input);
  return normalized === "n" || normalized === "new" || normalized === "新建";
}

function isManualSessionInputAction(input: string): boolean {
  const normalized = normalizeText(input);
  return normalized === "m" || normalized === "manual" || normalized === "id" || normalized === "手动";
}

function isBackText(input: string): boolean {
  const normalized = normalizeText(input);
  return normalized === "0" || normalized === "back" || normalized === "返回" || normalized === "q" || normalized === "quit";
}
