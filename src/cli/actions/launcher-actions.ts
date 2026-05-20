import { FeishuAdapter } from "../../channels/feishu/feishu-adapter.js";
import {
  DEFAULT_FEISHU_DOMAIN,
  missingFeishuCredentials,
  normalizeFeishuCredentials,
} from "../../channels/feishu/feishu-message.js";
import type { FeishuCredentials } from "../../channels/feishu/feishu-types.js";
import { WeixinAdapter, type WeixinLoginStartResult } from "../../channels/weixin/weixin-adapter.js";
import { FileWeixinAccountStore } from "../../channels/weixin/weixin-account-store.js";
import { formatCodexSessionTitleForDisplay, findCodexSessionById, type CodexRunPolicy } from "../../codex/codex-cli.js";
import { AppServerCodexAdapter } from "../../codex/app-server-codex-adapter.js";
import { ExecCodexAdapter } from "../../codex/exec-codex-adapter.js";
import type { CodexAdapter } from "../../codex/types.js";
import { checkNewSessionWorkdir, resolveNewSessionWorkdir } from "../../codex/workdir.js";
import {
  contextRefreshPolicyOrDefault,
  formatContextRefreshDefaultPolicyForUser,
  formatContextRefreshEffectivePolicyForUser,
  formatContextRefreshModeForUser,
  type ContextRefreshEffectivePolicy,
  type ContextRefreshPolicy,
} from "../../context-refresh/types.js";
import type { ChannelLoginResult } from "../../protocol/channel.js";
import { FileStateStore } from "../../state/file-state-store.js";
import { pendingBindingOwnerRouteKey } from "../../state/memory-state-store.js";
import type { ChannelInstanceRecord, PendingBindingRecord, RouteRecord, TrustedRouteRecord } from "../../state/persistent-state-types.js";
import type { PreparedServeStartup, ServeChannelPlan } from "../launcher-types.js";
import { formatChannelStateForUser, formatPermissionModeForUser, type ServeRouteSummary } from "../serve-wizard.js";
import {
  BindingActions,
  formatOwnerRouteLabel,
  formatRouteLabel,
  formatRunPolicyForUser,
  type BindingSummary,
  type BindExistingSessionResult,
  type BindNewSessionResult,
  type SessionChoices,
  type SessionDisplay,
  type UnbindSessionResult,
} from "./binding-actions.js";
import { ChannelActions, feishuChannelId, type ManagedChannelSummary, type RemoveChannelResult } from "./channel-actions.js";

const WEIXIN_LOGIN_CHECK_TIMEOUT_MS = 5_000;

export interface LauncherDashboard {
  channels: ManagedChannelSummary[];
  bindings: BindingSummary[];
  pendingBindings: PendingBindingRecord[];
  pairing: PairingDashboardSummary;
  routes: ServeRouteSummary;
  contextRefreshDefault: ContextRefreshPolicy;
  startup: PreparedServeStartup;
  canStart: StartValidation;
}

export interface PairingDashboardSummary {
  trusted: number;
  pending: number;
  routes: PairingRouteSummary[];
}

export interface PairingRouteSummary {
  route: RouteRecord;
  label: string;
  trusted: boolean;
  trustedRecord?: TrustedRouteRecord;
  activeSession?: SessionDisplay;
}

export type StartValidation =
  | { ok: true; channels: ManagedChannelSummary[]; message: string }
  | { ok: false; reason: "codex_unavailable"; message: string }
  | { ok: false; reason: "no_enabled_channels"; message: string }
  | { ok: false; reason: "unavailable_channels"; channels: ManagedChannelSummary[]; message: string };

export type WeixinLoginCheckResult =
  | { state: "pending"; message: string }
  | { state: "connected"; message: string; channel: ChannelInstanceRecord }
  | { state: "cancelled"; message: string }
  | { state: "failed"; message: string };

export interface WeixinLoginSession {
  started: WeixinLoginStartResult;
  qrCode?: string;
  fallbackLink?: string;
}

export type FeishuBotSetupResult =
  | { ok: true; record: ChannelInstanceRecord; message: string }
  | { ok: false; reason: "missing_credentials" | "status_failed" | "error"; message: string };

export type WeixinPrimaryBindingResult =
  | { ok: true; message: string; pending?: PendingBindingRecord; session?: SessionDisplay }
  | { ok: false; reason: "missing_account" | "not_found" | "owner_conflict" | "error"; message: string };

export type WorkdirSetupResult =
  | { ok: true; cwd: string; created: boolean; message: string }
  | { ok: false; reason: "missing" | "not_directory" | "error"; cwd?: string; message: string };

export type PairingManageResult =
  | { ok: true; route: PairingRouteSummary; message: string }
  | { ok: false; reason: "not_found" | "not_trusted" | "error"; message: string };

export class LauncherActions {
  private weixinLogin?: {
    channel: WeixinAdapter;
    started: WeixinLoginStartResult;
  };

  constructor(
    private readonly startup: PreparedServeStartup,
    private readonly plan: ServeChannelPlan,
    private readonly channelActions: ChannelActions,
  ) {}

  getStartup(): PreparedServeStartup {
    return this.startup;
  }

  getPlan(): ServeChannelPlan {
    return this.plan;
  }

  async getDashboard(): Promise<LauncherDashboard> {
    const channels = await this.listChannels();
    const bindingActions = this.bindingActions();
    const bindings = bindingActions.listBindings();
    const state = this.stateStore();
    return {
      channels,
      bindings,
      pendingBindings: state.listPendingBindings(),
      pairing: this.pairingSummary(state, bindings),
      routes: this.routeSummary(state),
      contextRefreshDefault: this.getContextRefreshDefaults(),
      startup: this.startup,
      canStart: this.validateStart(channels),
    };
  }

  async listChannels(): Promise<ManagedChannelSummary[]> {
    return this.channelActions.listChannelSummaries();
  }

  listChannelInstances(): ChannelInstanceRecord[] {
    return this.channelActions.listChannelInstances();
  }

  async setChannelEnabled(channelId: string, enabled: boolean): Promise<ManagedChannelSummary | undefined> {
    const updated = this.channelActions.setChannelEnabled(channelId, enabled);
    if (!updated) return undefined;
    return (await this.listChannels()).find((channel) => channel.record.id === channelId);
  }

  async renameChannel(channelId: string, displayName?: string): Promise<ManagedChannelSummary | undefined> {
    const updated = this.channelActions.renameChannel(channelId, displayName);
    if (!updated) return undefined;
    return (await this.listChannels()).find((channel) => channel.record.id === channelId);
  }

  async setChannelGroupEnabled(channelId: string, enabled: boolean): Promise<ManagedChannelSummary | undefined> {
    const updated = this.channelActions.setChannelGroupEnabled(channelId, enabled);
    if (!updated) return undefined;
    return (await this.listChannels()).find((channel) => channel.record.id === channelId);
  }

  async removeChannel(channelId: string): Promise<RemoveChannelResult> {
    return this.channelActions.removeChannel(channelId);
  }

  async startWeixinLogin(): Promise<WeixinLoginSession> {
    const channel = new WeixinAdapter({
      pollOnStart: false,
    });
    await channel.start();
    const started = await channel.startLogin();
    this.weixinLogin = { channel, started };
    return {
      started,
      qrCode: started.qrCodeText ? await renderQrCode(started.qrCodeText) : undefined,
      fallbackLink: started.qrCodeText,
    };
  }

  async checkWeixinLogin(): Promise<WeixinLoginCheckResult> {
    if (!this.weixinLogin) {
      return { state: "failed", message: "还没有发起微信扫码登录。" };
    }
    try {
      const result = await this.weixinLogin.channel.waitLogin(
        this.weixinLogin.started.sessionKey,
        WEIXIN_LOGIN_CHECK_TIMEOUT_MS,
      );
      if (result.state === "connected") {
        const record = await this.registerWeixinLogin(this.weixinLogin.channel, result);
        if (!record) {
          return { state: "failed", message: "微信登录完成但没有拿到可保存的账号。" };
        }
        this.weixinLogin = undefined;
        return { state: "connected", message: "微信账号已添加。下一步请选择微信主聊天使用哪个 Codex session。", channel: record };
      }
      if (result.message.includes("超时")) {
        return { state: "pending", message: "还没有检测到扫码确认。可以继续按 Enter 检查，或按 Esc 返回。" };
      }
      if (result.state === "failed") return { state: "failed", message: result.message };
      return { state: "pending", message: result.message };
    } catch (error) {
      return { state: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  cancelWeixinLogin(): WeixinLoginCheckResult {
    this.weixinLogin = undefined;
    return { state: "cancelled", message: "已返回管理渠道，未添加微信账号。" };
  }

  async addFeishuBot(input: FeishuCredentials): Promise<FeishuBotSetupResult> {
    const accountId = input.accountId?.trim();
    if (!accountId) {
      return { ok: false, reason: "missing_credentials", message: "账号标识不能为空。它是本地名称，用来区分多个飞书机器人。" };
    }
    const credentials = normalizeFeishuCredentials({ ...input, accountId });
    const missing = missingFeishuCredentials(credentials);
    if (missing.length > 0) {
      return { ok: false, reason: "missing_credentials", message: `缺少飞书配置: ${missing.join(", ")}。请重新输入完整配置。` };
    }
    try {
      const adapter = new FeishuAdapter({
        ...credentials,
        id: feishuChannelId(accountId),
        connectOnStart: false,
        probeOnStart: true,
      });
      await adapter.start();
      const status = await adapter.getStatus();
      if (status.state !== "connected") {
        return { ok: false, reason: "status_failed", message: status.lastError ?? "飞书机器人配置检查失败。" };
      }
      const record = this.channelActions.registerFeishuBot(credentials, "interactive");
      return {
        ok: true,
        record,
        message: [
          "飞书机器人已添加。",
          "凭证已保存到本机用户状态目录，重启后会自动读取。",
          "启动服务后，让用户在飞书里私聊机器人。",
        ].join(" "),
      };
    } catch (error) {
      return { ok: false, reason: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  listBindings(): BindingSummary[] {
    return this.bindingActions().listBindings();
  }

  getBinding(routeKey: string): BindingSummary | undefined {
    return this.bindingActions().getBinding(routeKey);
  }

  listSessionChoices(routeKey: string): SessionChoices {
    return this.bindingActions().listSessionChoices(routeKey);
  }

  bindExistingSession(routeKey: string, sessionId: string): BindExistingSessionResult {
    return this.bindingActions().bindExistingSession(routeKey, sessionId);
  }

  async createAndBindSession(routeKey: string): Promise<BindNewSessionResult> {
    const binding = this.getBinding(routeKey);
    const codex = this.createRealCodexAdapter();
    try {
      const session = await codex.startSession({
        routeKey,
        cwd: this.startup.cwd,
        title: `channel:${binding?.label ?? routeKey}`,
      });
      return this.bindingActions().bindNewSession(routeKey, session);
    } finally {
      if (codex.stop) await codex.stop().catch(() => undefined);
    }
  }

  unbindSession(routeKey: string): UnbindSessionResult {
    return this.bindingActions().unbindSession(routeKey);
  }

  getPairingRoute(routeKey: string): PairingRouteSummary | undefined {
    const state = this.stateStore();
    return this.pairingSummary(state, this.bindingActions().listBindings()).routes.find((route) => route.route.routeKey === routeKey);
  }

  trustRouteManually(routeKey: string): PairingManageResult {
    try {
      const state = this.stateStore();
      const route = state.listRoutes().find((item) => item.routeKey === routeKey);
      if (!route) {
        return { ok: false, reason: "not_found", message: "没有找到这个聊天 route。请刷新后重试。" };
      }
      const now = new Date().toISOString();
      state.trustRoute({
        routeKey: route.routeKey,
        channelId: route.channelId,
        accountId: route.accountId,
        conversationKind: route.conversationKind,
        conversationId: route.conversationId,
        displayName: isFeishuDirectRoute(route)
          ? route.displayName
          : route.displayName ?? route.identity?.lastSenderDisplayName,
        trustedAt: now,
        trustedBySenderId: "local-tui",
        trustedBySenderDisplayName: "本机 TUI",
        trustMethod: "manual",
        lastSeenAt: route.lastSeenAt,
        createdAt: now,
        updatedAt: now,
      });
      const summary = this.getPairingRoute(routeKey);
      if (!summary) {
        return { ok: false, reason: "not_found", message: "已写入信任，但刷新配对列表失败。请返回后刷新。" };
      }
      return { ok: true, route: summary, message: `已手动信任：${summary.label}` };
    } catch (error) {
      return { ok: false, reason: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  revokeRouteTrust(routeKey: string, options: { unbindSession?: boolean } = {}): PairingManageResult {
    try {
      const state = this.stateStore();
      const route = state.listRoutes().find((item) => item.routeKey === routeKey);
      const removed = state.revokeRouteTrust(routeKey);
      if (!removed) {
        return { ok: false, reason: "not_trusted", message: "这个聊天 route 当前没有信任记录。" };
      }
      let releasedSessionId: string | undefined;
      if (options.unbindSession) {
        const unbound = state.unbindSession(routeKey);
        if (unbound.ok) releasedSessionId = unbound.binding.sessionId;
      }
      const summary = route
        ? this.getPairingRoute(routeKey) ?? this.pairingRouteSummary(state, route, undefined, new Map())
        : undefined;
      if (!summary) {
        return { ok: true, route: this.fallbackPairingRoute(removed), message: "已撤销信任。" };
      }
      const suffix = options.unbindSession
        ? releasedSessionId ? `，并解绑 session：${releasedSessionId}` : "，当前没有需要解绑的 session"
        : "，session 绑定保持不变";
      return { ok: true, route: summary, message: `已撤销信任：${summary.label}${suffix}。` };
    } catch (error) {
      return { ok: false, reason: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  getSessionPermission(sessionId: string): CodexRunPolicy | undefined {
    return this.bindingActions().getSessionPermission(sessionId);
  }

  setSessionPermission(sessionId: string, policy: CodexRunPolicy): CodexRunPolicy {
    return this.bindingActions().setSessionPermission(sessionId, policy);
  }

  setDefaultPermission(policy: CodexRunPolicy): CodexRunPolicy {
    this.startup.policy = policy;
    return this.startup.policy;
  }

  getContextRefreshDefaults(): ContextRefreshPolicy {
    return contextRefreshPolicyOrDefault(this.startup.contextRefresh ?? this.channelActions.configStore.getContextRefreshDefaults());
  }

  setContextRefreshDefaults(policy: ContextRefreshPolicy): ContextRefreshPolicy {
    const saved = this.channelActions.configStore.setContextRefreshDefaults(policy);
    this.startup.contextRefresh = saved;
    return saved;
  }

  getRouteContextRefreshPolicy(routeKey: string): ContextRefreshPolicy | undefined {
    return this.stateStore().getRouteContextRefreshPolicy(routeKey);
  }

  getRouteContextRefreshEffectivePolicy(routeKey: string): ContextRefreshEffectivePolicy {
    const routePolicy = this.getRouteContextRefreshPolicy(routeKey);
    if (routePolicy) return { policy: routePolicy, source: "route" };
    return { policy: this.getContextRefreshDefaults(), source: "global" };
  }

  setRouteContextRefreshPolicy(routeKey: string, policy: ContextRefreshPolicy): ContextRefreshEffectivePolicy {
    const state = this.stateStore();
    state.setRouteContextRefreshPolicy(routeKey, policy);
    const routePolicy = state.getRouteContextRefreshPolicy(routeKey) ?? policy;
    return { policy: routePolicy, source: "route" };
  }

  clearRouteContextRefreshPolicy(routeKey: string): ContextRefreshEffectivePolicy {
    const state = this.stateStore();
    state.clearRouteContextRefreshPolicy(routeKey);
    return this.getRouteContextRefreshEffectivePolicy(routeKey);
  }

  getCurrentProcessWorkdir(): string {
    return process.cwd();
  }

  setDefaultWorkdir(input?: string, options: { createIfMissing?: boolean } = {}): WorkdirSetupResult {
    const checked = checkNewSessionWorkdir(input, process.cwd());
    if (checked.ok) {
      this.startup.cwd = checked.cwd;
      return {
        ok: true,
        cwd: this.startup.cwd,
        created: false,
        message: `已设置新 session 工作目录：${this.startup.cwd}`,
      };
    }
    if (checked.reason === "not_directory") {
      return { ok: false, reason: "not_directory", cwd: checked.cwd, message: checked.message };
    }
    if (!options.createIfMissing) {
      return { ok: false, reason: "missing", cwd: checked.cwd, message: `${checked.message}。确认后会创建这个目录。` };
    }
    try {
      const resolved = resolveNewSessionWorkdir(checked.cwd, process.cwd());
      this.startup.cwd = resolved.cwd;
      return {
        ok: true,
        cwd: this.startup.cwd,
        created: resolved.created,
        message: `${resolved.created ? "已创建并设置" : "已设置"}新 session 工作目录：${this.startup.cwd}`,
      };
    } catch (error) {
      return { ok: false, reason: "error", cwd: checked.cwd, message: error instanceof Error ? error.message : String(error) };
    }
  }

  listWeixinPrimaryChoices(channel: ChannelInstanceRecord): SessionChoices | undefined {
    const accountId = channel.defaultAccountId;
    if (!accountId) return undefined;
    return this.bindingActions().listSessionChoices(this.weixinPrimaryPendingOwner(channel.id, accountId));
  }

  setWeixinPrimaryNew(channel: ChannelInstanceRecord): WeixinPrimaryBindingResult {
    const accountId = channel.defaultAccountId;
    if (!accountId) return { ok: false, reason: "missing_account", message: "这个微信渠道缺少账号标识，不能设置主聊天绑定。" };
    const pending = this.stateStore().setPendingBinding({
      id: this.weixinPrimaryPendingId(channel.id, accountId),
      channelId: channel.id,
      accountId,
      conversationKind: "direct",
      label: `微信 / ${accountId} / 主聊天`,
      binding: { type: "new" },
    });
    return { ok: true, pending, message: "已设置：收到第一条微信私聊后创建新 session。" };
  }

  setWeixinPrimaryNone(channel: ChannelInstanceRecord): WeixinPrimaryBindingResult {
    const accountId = channel.defaultAccountId;
    if (!accountId) return { ok: false, reason: "missing_account", message: "这个微信渠道缺少账号标识，不能设置主聊天绑定。" };
    this.stateStore().clearPendingBindingForMessage(this.pendingProbeMessage(channel.id, accountId));
    return { ok: true, message: "已设置：暂不绑定，首条消息自动创建。" };
  }

  setWeixinPrimaryExisting(channel: ChannelInstanceRecord, sessionId: string): WeixinPrimaryBindingResult {
    const accountId = channel.defaultAccountId;
    if (!accountId) return { ok: false, reason: "missing_account", message: "这个微信渠道缺少账号标识，不能设置主聊天绑定。" };
    const state = this.stateStore();
    const session = findCodexSessionById(sessionId);
    if (!session) {
      return { ok: false, reason: "not_found", message: "没有找到这个 session。请重新输入编号或有效 Session ID。" };
    }
    const pendingId = this.weixinPrimaryPendingId(channel.id, accountId);
    const pendingOwner = pendingBindingOwnerRouteKey(pendingId);
    const owner = state.getSessionOwner(session.id);
    if (owner && owner.ownerRouteKey !== pendingOwner) {
      return {
        ok: false,
        reason: "owner_conflict",
        message: `无法预留这个 session：${session.id} 已绑定到 ${formatOwnerRouteLabel(state, owner.ownerRouteKey)}。请先到“聊天绑定”里解绑原聊天，或选择其他 session。`,
      };
    }
    const pending = state.setPendingBinding({
      id: pendingId,
      channelId: channel.id,
      accountId,
      conversationKind: "direct",
      label: `微信 / ${accountId} / 主聊天`,
      binding: { type: "existing", sessionId: session.id },
    });
    const display: SessionDisplay = {
      id: session.id,
      shortId: session.id.length <= 8 ? session.id : session.id.slice(0, 8),
      title: formatCodexSessionTitleForDisplay(session),
      cwd: session.cwd,
      updatedAt: session.updatedAt,
    };
    return {
      ok: true,
      pending,
      session: display,
      message: `已设置微信主聊天绑定：待绑定到 ${display.title ?? display.id} / ${display.shortId}，收到第一条微信私聊后生效。`,
    };
  }

  validateStart(channels?: ManagedChannelSummary[]): StartValidation {
    if (this.startup.codexStatus && !this.startup.codexStatus.available) {
      return { ok: false, reason: "codex_unavailable", message: `Codex CLI 不可用：${this.startup.codexStatus.error ?? "unknown error"}` };
    }
    const allChannels = channels ?? [];
    const enabled = allChannels.filter((channel) => channel.record.enabled);
    if (enabled.length === 0) {
      return { ok: false, reason: "no_enabled_channels", message: "还没有启用的渠道。请先添加或启用微信账号、飞书机器人。" };
    }
    const unavailable = enabled.filter((channel) => channel.status.state !== "connected");
    if (unavailable.length > 0) {
      const first = unavailable[0];
      return {
        ok: false,
        reason: "unavailable_channels",
        channels: unavailable,
        message: `${first.record.type === "weixin" ? "微信" : "飞书"} / ${first.status.account ?? first.record.defaultAccountId ?? first.record.id} 还不能启动：${formatChannelStateForUser(first.status.state)}。`,
      };
    }
    return { ok: true, channels: enabled, message: "可以启动服务。" };
  }

  startConfirmationSummary(channels: ManagedChannelSummary[]): string[] {
    return [
      "即将启动",
      "",
      "渠道",
      ...channels.map((channel) => `- ${channel.record.type === "weixin" ? "微信" : "飞书"} / ${channel.status.account ?? channel.record.defaultAccountId ?? channel.record.id}: ${formatChannelStateForUser(channel.status.state)}`),
      "",
      "聊天绑定",
      `- 新聊天策略: ${this.plan.unboundRoutePolicy === "auto_new" ? "首条消息自动创建新 session" : "首条消息先提示选择 session"}`,
      `- 待生效绑定: ${this.stateStore().listPendingBindings().length}`,
      "",
      "权限",
      `- 新 session 默认权限: ${formatRunPolicyForUser(this.startup.policy)}`,
      "",
      "上下文刷新",
      `- 默认策略: ${formatContextRefreshDefaultPolicyForUser(this.getContextRefreshDefaults())}`,
      "",
      "运行",
      `- 新 session 工作目录: ${this.startup.cwd}`,
    ];
  }

  formatDefaultPermission(): string {
    return formatPermissionModeForUser(this.startup.policy.permissionMode);
  }

  formatRunPolicy(policy: CodexRunPolicy | undefined): string {
    return formatRunPolicyForUser(policy);
  }

  formatContextRefreshPolicy(policy: ContextRefreshPolicy | undefined): string {
    return formatContextRefreshModeForUser(contextRefreshPolicyOrDefault(policy).mode);
  }

  formatContextRefreshEffectivePolicy(effective: ContextRefreshEffectivePolicy): string {
    return formatContextRefreshEffectivePolicyForUser(effective);
  }

  formatBindingLabel(binding: BindingSummary): string {
    return formatRouteLabel(binding.route);
  }

  private async registerWeixinLogin(channel: WeixinAdapter, _result: ChannelLoginResult): Promise<ChannelInstanceRecord | undefined> {
    const status = await channel.getStatus();
    const accountId = status.account;
    if (!accountId) return undefined;
    const account = new FileWeixinAccountStore().loadAccount(accountId);
    if (!account) return undefined;
    return this.channelActions.registerWeixinAccount(account);
  }

  private routeSummary(state = this.stateStore()): ServeRouteSummary {
    const routes = state.listRoutes();
    return {
      known: routes.length,
      bound: routes.filter((route) => route.activeSessionId).length,
      pending: state.listPendingBindings().length,
      unboundPolicy: this.plan.unboundRoutePolicy,
      firstRouteBindingChoice: this.plan.firstRouteBindingChoice,
      initialSessionId: this.plan.initialSessionId,
      initialSessionTitle: this.plan.initialSessionTitle,
    };
  }

  private pairingSummary(state: FileStateStore, bindings: BindingSummary[]): PairingDashboardSummary {
    const activeSessions = new Map(bindings.map((binding) => [binding.route.routeKey, binding.activeSession]));
    const trustedRoutes = new Map(state.listTrustedRoutes().map((route) => [route.routeKey, route]));
    const routes = state.listRoutes()
      .map((route) => this.pairingRouteSummary(state, route, trustedRoutes.get(route.routeKey), activeSessions))
      .sort(comparePairingRoutes);
    return {
      trusted: routes.filter((route) => route.trusted).length,
      pending: routes.filter((route) => !route.trusted).length,
      routes,
    };
  }

  private pairingRouteSummary(
    state: FileStateStore,
    route: RouteRecord,
    trustedRecord: TrustedRouteRecord | undefined,
    activeSessions: Map<string, SessionDisplay | undefined>,
  ): PairingRouteSummary {
    const binding = state.getBinding(route.routeKey);
    const activeSession = activeSessions.get(route.routeKey) ?? (route.activeSessionId || binding
      ? {
          id: route.activeSessionId ?? binding?.sessionId ?? "",
          shortId: shortSessionId(route.activeSessionId ?? binding?.sessionId ?? ""),
        }
      : undefined);
    return {
      route,
      label: formatRouteLabel(route),
      trusted: Boolean(trustedRecord),
      trustedRecord,
      activeSession,
    };
  }

  private fallbackPairingRoute(record: TrustedRouteRecord): PairingRouteSummary {
    const route: RouteRecord = {
      routeKey: record.routeKey,
      channelId: record.channelId,
      accountId: record.accountId,
      conversationKind: record.conversationKind,
      conversationId: record.conversationId,
      displayName: record.displayName,
      lastSeenAt: record.lastSeenAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    return {
      route,
      label: formatRouteLabel(route),
      trusted: false,
    };
  }

  private bindingActions(sessionLimit?: number): BindingActions {
    return new BindingActions(this.stateStore(), { cwd: this.startup.cwd, sessionLimit });
  }

  private stateStore(): FileStateStore {
    return new FileStateStore({ rootDir: this.channelActions.configStore.bridgeDir });
  }

  private createRealCodexAdapter(): CodexAdapter {
    if (this.startup.codexStatus && !this.startup.codexStatus.available) {
      throw new Error(`Codex 不可用: ${this.startup.codexStatus.error ?? "unknown error"}`);
    }
    const runPolicy = this.startup.policy;
    if (this.startup.adapterMode === "exec") return new ExecCodexAdapter({ runPolicy, codexCommand: this.startup.codexStatus?.command });
    return new AppServerCodexAdapter({ runPolicy, codexCommand: this.startup.codexStatus?.command });
  }

  private weixinPrimaryPendingId(channelId: string, accountId: string): string {
    return `weixin-primary-${channelId}-${accountId}`;
  }

  private weixinPrimaryPendingOwner(channelId: string, accountId: string): string {
    return pendingBindingOwnerRouteKey(this.weixinPrimaryPendingId(channelId, accountId));
  }

  private pendingProbeMessage(channelId: string, accountId: string) {
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
}

function comparePairingRoutes(left: PairingRouteSummary, right: PairingRouteSummary): number {
  if (left.trusted !== right.trusted) return left.trusted ? 1 : -1;
  return timestampForPairing(right) - timestampForPairing(left)
    || left.label.localeCompare(right.label, "zh-Hans-CN")
    || left.route.routeKey.localeCompare(right.route.routeKey);
}

function isFeishuDirectRoute(route: RouteRecord): boolean {
  return route.conversationKind === "direct"
    && (route.channelType === "feishu"
      || route.channelId === "feishu"
      || route.channelId.startsWith("feishu-")
      || route.channelId === "lark"
      || route.channelId.startsWith("lark-"));
}

function timestampForPairing(route: PairingRouteSummary): number {
  const value = route.trustedRecord?.trustedAt ?? route.route.lastSeenAt ?? route.route.updatedAt;
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 8) return sessionId;
  return sessionId.slice(0, 8);
}

async function renderQrCode(text: string): Promise<string | undefined> {
  try {
    const qrTerminal = await import("qrcode-terminal");
    return await new Promise((resolve) => {
      qrTerminal.default.generate(text, { small: true }, (qrCode) => resolve(qrCode));
    });
  } catch {
    return undefined;
  }
}

export function feishuCredentialDefaults(): Pick<FeishuCredentials, "domain"> {
  return {
    domain: DEFAULT_FEISHU_DOMAIN,
  };
}
