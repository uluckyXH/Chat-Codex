import type { CodexPermissionMode } from "../codex/codex-cli.js";
import type { ProgressDeliveryMode } from "../bridge/bridge.js";
import type { ChannelCapabilities, ChannelLoginMode, ChannelState, ChannelStatus } from "../protocol/channel.js";

export type ServeHomeChoice =
  | "manage_channels"
  | "manage_routes"
  | "codex_settings"
  | "workdir_settings"
  | "status"
  | "start"
  | "exit";

export type ChannelManageChoice = "login" | "status" | "add" | "back";
export type RouteManageChoice = "policy" | "first_route" | "bindings" | "back";
export type CodexSettingsChoice = "adapter" | "permission" | "workdir" | "concurrency" | "back";
export type UnboundRoutePolicyChoice = UnboundRoutePolicy | "back";
export type FirstRouteSetupChoice = "none" | "bind_existing_first_route" | "new_first_route" | "back";

export type FirstRouteBindingChoice =
  | "bind_existing_first_route"
  | "new_first_route";

export type UnboundRoutePolicy = "auto_new" | "ask";

export interface ServeCodexSummary {
  adapterMode: "app-server" | "exec";
  permissionMode: CodexPermissionMode;
  cwd: string;
  progressMode?: ProgressDeliveryMode;
  progressDisabled?: boolean;
  maxConcurrentTurns?: number;
}

export interface ServeChannelSummary {
  id: string;
  type: string;
  enabled: boolean;
  status: ChannelStatus;
  capabilities?: ChannelCapabilities;
}

export interface ServeRouteSummary {
  known: number;
  bound: number;
  pending?: number;
  unboundPolicy: UnboundRoutePolicy;
  firstRouteBindingChoice?: FirstRouteBindingChoice;
  initialSessionId?: string;
  initialSessionTitle?: string;
}

export interface ServeHomeSummary {
  codex: ServeCodexSummary;
  channels: ServeChannelSummary[];
  routes: ServeRouteSummary;
}

export function parseServeHomeChoice(input: string | undefined): ServeHomeChoice {
  const normalized = normalizeChoice(input);
  if (!normalized || normalized === "6" || normalized === "start" || normalized === "s" || normalized === "启动") return "start";
  if (normalized === "1" || normalized === "channel" || normalized === "channels" || normalized === "渠道") return "manage_channels";
  if (normalized === "2" || normalized === "route" || normalized === "routes" || normalized === "绑定") return "manage_routes";
  if (normalized === "3" || normalized === "permission" || normalized === "permissions" || normalized === "权限" || normalized === "设置") return "codex_settings";
  if (normalized === "4" || normalized === "workdir" || normalized === "cwd" || normalized === "目录" || normalized === "d") return "workdir_settings";
  if (normalized === "5" || normalized === "status" || normalized === "状态") return "status";
  if (normalized === "0" || normalized === "q" || normalized === "quit" || normalized === "exit") return "exit";
  return "start";
}

export function parseChannelManageChoice(input: string | undefined): ChannelManageChoice {
  const normalized = normalizeChoice(input);
  if (!normalized || normalized === "1" || normalized === "login" || normalized === "登录" || normalized === "relogin" || normalized === "重新登录") return "login";
  if (normalized === "2" || normalized === "status" || normalized === "状态") return "status";
  if (normalized === "3" || normalized === "add" || normalized === "添加") return "add";
  if (normalized === "0" || normalized === "back" || normalized === "返回" || normalized === "q" || normalized === "quit") return "back";
  return "login";
}

export function parseRouteManageChoice(input: string | undefined): RouteManageChoice {
  const normalized = normalizeChoice(input);
  if (!normalized || normalized === "1" || normalized === "policy" || normalized === "策略") return "policy";
  if (normalized === "2" || normalized === "first" || normalized === "first_route" || normalized === "首个") return "first_route";
  if (normalized === "3" || normalized === "bindings" || normalized === "绑定") return "bindings";
  if (normalized === "0" || normalized === "back" || normalized === "返回" || normalized === "q" || normalized === "quit") return "back";
  return "policy";
}

export function parseCodexSettingsChoice(input: string | undefined): CodexSettingsChoice {
  const normalized = normalizeChoice(input);
  if (!normalized || normalized === "1" || normalized === "adapter" || normalized === "接入") return "adapter";
  if (normalized === "2" || normalized === "permission" || normalized === "权限") return "permission";
  if (normalized === "3" || normalized === "workdir" || normalized === "cwd" || normalized === "目录") return "workdir";
  if (normalized === "4" || normalized === "concurrency" || normalized === "并发") return "concurrency";
  if (normalized === "0" || normalized === "back" || normalized === "返回" || normalized === "q" || normalized === "quit") return "back";
  return "adapter";
}

export function parseUnboundRoutePolicyChoice(input: string | undefined): UnboundRoutePolicyChoice {
  const normalized = normalizeChoice(input);
  if (!normalized || normalized === "1" || normalized === "auto" || normalized === "auto_new" || normalized === "自动") return "auto_new";
  if (normalized === "2" || normalized === "ask" || normalized === "询问") return "ask";
  if (normalized === "0" || normalized === "back" || normalized === "返回" || normalized === "q" || normalized === "quit") return "back";
  return "auto_new";
}

export function parseFirstRouteSetupChoice(input: string | undefined): FirstRouteSetupChoice {
  const normalized = normalizeChoice(input);
  if (!normalized || normalized === "1" || normalized === "none" || normalized === "不预设") return "none";
  if (normalized === "2" || normalized === "existing" || normalized === "bind_existing_first_route" || normalized === "已有") return "bind_existing_first_route";
  if (normalized === "3" || normalized === "new" || normalized === "new_first_route" || normalized === "新建") return "new_first_route";
  if (normalized === "0" || normalized === "back" || normalized === "返回" || normalized === "q" || normalized === "quit") return "back";
  return "none";
}

export function formatServeHomeSummary(summary: ServeHomeSummary): string {
  const lines = [
    "Codex Chat Bridge",
    "当前位置：首页",
    "",
    "渠道",
  ];
  if (summary.channels.length === 0) {
    lines.push("- 暂无渠道");
  } else {
    summary.channels.forEach((channel, index) => {
      lines.push(...formatChannelSummary(channel, index));
    });
  }
  lines.push(
    "",
    "聊天绑定",
    `- 已记录聊天: ${summary.routes.known}`,
    `- 已绑定 session: ${summary.routes.bound}`,
    `- 待生效绑定: ${summary.routes.pending ?? 0}`,
    `- 新聊天策略: ${formatUnboundRoutePolicyForUser(summary.routes.unboundPolicy)}`,
    ...(summary.routes.firstRouteBindingChoice
      ? [`- 启动预设: ${formatFirstRoutePresetForUser(summary.routes.firstRouteBindingChoice, summary.routes.initialSessionId, summary.routes.initialSessionTitle)}`]
      : []),
    "",
    "权限",
    `- 新 session 默认权限: ${formatPermissionModeForUser(summary.codex.permissionMode)}`,
    "",
    "工作目录",
    `- 新 session 工作目录: ${summary.codex.cwd}`,
    "",
    "提示",
    "- 配置好后，需要启动服务才会真正的工作！",
    "",
    "操作",
    "1. 管理渠道",
    "2. 聊天绑定",
    "3. 权限设置",
    "4. 工作目录",
    "5. 状态详情",
    "6. 启动服务",
    "0. 退出",
  );
  return lines.join("\n");
}

export function formatChannelManagementMenu(channel: ServeChannelSummary): string {
  return [
    "Codex Chat Bridge",
    "当前位置：首页 > 管理渠道",
    "",
    "渠道",
    `- 微信: ${formatChannelStateForUser(channel.status.state)}${channel.status.account ? `（${channel.status.account}）` : ""}`,
    "",
    "操作",
    "1. 登录/重新登录微信",
    "2. 查看微信状态",
    "3. 添加渠道（飞书等后续适配）",
    "0. 返回",
  ].join("\n");
}

export function formatRouteBindingMenu(routes: ServeRouteSummary): string {
  return [
    "Codex Chat Bridge",
    "当前位置：首页 > 聊天绑定",
    "",
    "聊天记录",
    `- 已发现: ${routes.known}`,
    `- 已绑定 session: ${routes.bound}`,
    `- 待生效绑定: ${routes.pending ?? 0}`,
    "",
    "新聊天策略",
    `- 当前: ${formatUnboundRoutePolicyForUser(routes.unboundPolicy)}`,
    "",
    "操作",
    "1. 查看/切换聊天绑定",
    "2. 设置新聊天策略",
    "0. 返回",
  ].join("\n");
}

export function formatUnboundRoutePolicyMenu(current: UnboundRoutePolicy): string {
  return [
    "Codex Chat Bridge",
    "当前位置：首页 > 聊天绑定 > 新聊天策略",
    "",
    `当前: ${formatUnboundRoutePolicyForUser(current)}`,
    "",
    "1. 首条消息自动创建新 session（推荐单用户私有部署）",
    "2. 首条消息先提示 /new 或 /resume（推荐多用户或多聊天）",
    "0. 返回",
  ].join("\n");
}

export function formatFirstRouteBindingMenu(routes: ServeRouteSummary): string {
  return [
    "Codex Chat Bridge",
    "当前位置：首页 > 聊天绑定 > 首个微信私聊",
    "",
    `当前: ${formatFirstRoutePresetForUser(routes.firstRouteBindingChoice, routes.initialSessionId, routes.initialSessionTitle)}`,
    "",
    "1. 不预设，按新聊天策略处理",
    "2. 启动后第一个私聊绑定已有 session",
    "3. 启动后第一个私聊创建新 session",
    "0. 返回",
  ].join("\n");
}

export function formatCodexSettingsMenu(input: ServeCodexSummary & { cwd: string }): string {
  return [
    "Codex Chat Bridge",
    "当前位置：首页 > 权限设置",
    "",
    `当前: ${formatPermissionModeForUser(input.permissionMode)}`,
    "",
    "1. 审批模式（workspace-write 沙箱，推荐）",
    "2. 完全权限（跳过审批和沙箱，高风险）",
    "0. 返回",
  ].join("\n");
}

export function formatWorkdirSettingsMenu(cwd: string): string {
  return [
    "Codex Chat Bridge",
    "当前位置：首页 > 工作目录",
    "",
    "当前新 session 工作目录",
    cwd,
    "",
    "说明",
    "- 只影响以后新建的 session；已有 session 继续使用自己的工作目录。",
    "",
    "操作",
    "1. 使用当前终端目录",
    "2. 输入目录路径",
    "0. 返回",
  ].join("\n");
}

export function formatStartConfirmation(input: {
  codex: ServeCodexSummary & { cwd: string };
  channel?: ServeChannelSummary;
  channels?: ServeChannelSummary[];
  routes: ServeRouteSummary;
}): string {
  const channels = input.channels ?? (input.channel ? [input.channel] : []);
  return [
    "即将启动",
    "",
    "渠道",
    ...(channels.length > 0
      ? channels.map((channel) => `- ${formatChannelTypeForUser(channel.type)} / ${channel.status.account ?? channel.id}: ${formatChannelStateForUser(channel.status.state)}${channel.enabled ? "" : "，已停用"}`)
      : ["- 暂无启用渠道"]),
    "",
    "聊天绑定",
    `- 新聊天策略: ${formatUnboundRoutePolicyForUser(input.routes.unboundPolicy)}`,
    `- 待生效绑定: ${input.routes.pending ?? 0}`,
    ...(input.routes.firstRouteBindingChoice
      ? [`- 启动预设: ${formatFirstRoutePresetForUser(input.routes.firstRouteBindingChoice, input.routes.initialSessionId, input.routes.initialSessionTitle)}`]
      : []),
    "",
    "权限",
    `- 新 session 默认权限: ${formatPermissionModeForUser(input.codex.permissionMode)}`,
    "",
    "运行",
    `- 新 session 工作目录: ${input.codex.cwd}`,
    "",
    "提示",
    "- 配置好后，需要启动服务才会真正的工作！",
    "",
    "1. 启动",
    "0. 返回",
  ].join("\n");
}

function formatChannelTypeForUser(type: string): string {
  if (type === "weixin") return "微信";
  if (type === "feishu" || type === "lark") return "飞书";
  return type;
}

export function formatChannelCapabilities(capabilities: ChannelCapabilities): string {
  return [
    "微信渠道能力",
    `- 文本消息: ${formatCapability(capabilities.text)}`,
    `- 图片/文件: ${formatCapability(capabilities.media)}`,
    `- 输入状态: ${formatCapability(capabilities.typing)}`,
    `- 私聊: ${formatCapability(capabilities.direct)}`,
    `- 群聊: ${formatCapability(capabilities.group)}`,
    `- Thread: ${formatCapability(capabilities.thread)}`,
    `- 登录方式: ${formatLoginMode(capabilities.login)}`,
    `- 消息编辑: ${formatCapability(capabilities.messageUpdate)}`,
    `- 流式提示: ${formatCapability(capabilities.streamingHint)}`,
  ].join("\n");
}

export function formatChannelStatusDetails(status: ChannelStatus, capabilities?: ChannelCapabilities): string {
  const lines = [
    "渠道状态详情",
    `- 渠道 ID: ${status.channelId}`,
    `- 运行状态: ${formatChannelStateForUser(status.state)}`,
    `- 登录账号: ${status.account ?? "未登录"}`,
  ];
  if (status.lastInboundAt) lines.push(`- 最近收到消息: ${status.lastInboundAt}`);
  if (status.lastOutboundAt) lines.push(`- 最近发送消息: ${status.lastOutboundAt}`);
  if (status.lastError) lines.push(`- 最近错误: ${status.lastError}`);
  const details = status.details ?? {};
  const phase = stringDetail(details, "phase");
  const source = stringDetail(details, "source");
  const sourceVersion = stringDetail(details, "sourceVersion");
  if (phase) lines.push(`- 当前阶段: ${formatChannelPhase(status.channelId, phase)}`);
  if (source) lines.push(`- 底层组件: ${sourceVersion ? `${source} ${sourceVersion}` : source}`);
  const accountId = stringDetail(details, "accountId");
  const appId = stringDetail(details, "appId");
  const domain = stringDetail(details, "domain");
  const connectionMode = stringDetail(details, "connectionMode");
  const connectionState = stringDetail(details, "connectionState");
  const botOpenId = stringDetail(details, "botOpenId");
  const botName = stringDetail(details, "botName");
  const reconnectAttempts = numberDetail(details, "reconnectAttempts");
  if (accountId) lines.push(`- 渠道账号标识: ${accountId}`);
  if (appId) lines.push(`- App ID: ${appId}`);
  if (domain) lines.push(`- 飞书域: ${formatFeishuDomain(domain)}`);
  if (connectionMode) lines.push(`- 连接方式: ${formatConnectionMode(connectionMode)}`);
  if (connectionState) lines.push(`- 长连接状态: ${formatConnectionState(connectionState)}`);
  if (reconnectAttempts !== undefined) lines.push(`- 重连次数: ${reconnectAttempts}`);
  if (botOpenId || botName) lines.push(`- 机器人: ${botName ? `${botName}${botOpenId ? `（${botOpenId}）` : ""}` : botOpenId}`);
  const outboundMinIntervalMs = numberDetail(details, "outboundMinIntervalMs");
  const outboundMaxRetries = numberDetail(details, "outboundMaxRetries");
  if (outboundMinIntervalMs !== undefined) lines.push(`- 发送限速: 两条消息至少间隔 ${outboundMinIntervalMs}ms`);
  if (outboundMaxRetries !== undefined) lines.push(`- 发送重试: 最多 ${outboundMaxRetries} 次`);
  if (capabilities) lines.push(`- 主要能力: ${formatCapabilitySummary(capabilities)}`);
  return lines.join("\n");
}

export function formatAdapterModeForUser(adapterMode: ServeCodexSummary["adapterMode"]): string {
  if (adapterMode === "app-server") return "Codex app-server（推荐，支持在微信里处理审批）";
  return "Codex exec（备用模式，不支持微信交互审批）";
}

export function formatPermissionModeForUser(permissionMode: CodexPermissionMode): string {
  if (permissionMode === "full") return "完全权限（跳过审批和沙箱，风险高）";
  return "审批模式（workspace-write 沙箱，推荐）";
}

export function formatProgressModeForUser(progressMode: ProgressDeliveryMode | undefined, disabled = false): string {
  if (disabled) return "微信渠道不投递阶段进度（本地终端仍记录）";
  if (progressMode === "detailed") return "详细";
  if (progressMode === "tools") return "结构化工具";
  if (progressMode === "silent") return "静默";
  return "简洁";
}

export function formatMaxConcurrentTurnsForUser(maxConcurrentTurns: number | undefined): string {
  return maxConcurrentTurns ? `${maxConcurrentTurns} 个任务` : "不限制不同聊天并行";
}

export function formatUnboundRoutePolicyForUser(policy: UnboundRoutePolicy): string {
  return policy === "auto_new" ? "首条消息自动创建新 session" : "先提示发送 /new 或 /resume";
}

export function formatFirstRoutePresetForUser(
  choice: FirstRouteBindingChoice | undefined,
  sessionId?: string,
  sessionTitle?: string,
): string {
  if (choice === "bind_existing_first_route") {
    const label = sessionTitle ? `${sessionTitle}（${sessionId ?? "未选择 ID"}）` : (sessionId ?? "未选择 session");
    return `启动后第一个微信私聊绑定已有 session: ${label}`;
  }
  if (choice === "new_first_route") {
    return "启动后第一个微信私聊创建新 session";
  }
  return "不预设，按新聊天策略处理";
}

export function formatChannelStateForUser(state: ChannelState): string {
  switch (state) {
    case "stopped":
      return "已停止";
    case "starting":
      return "启动中";
    case "login_required":
      return "需要登录";
    case "connected":
      return "已连接";
    case "degraded":
      return "部分异常";
    case "failed":
      return "启动失败";
  }
}

function normalizeChoice(input: string | undefined): string {
  return (input ?? "").trim().toLowerCase();
}

function formatCapability(value: boolean): string {
  return value ? "支持" : "暂不支持";
}

function formatChannelSummary(channel: ServeChannelSummary, _index: number): string[] {
  const enabled = channel.enabled ? "已启用" : "已停用";
  const lines = [
    `- ${formatChannelType(channel.type)}（${channel.id}）- ${enabled}，${formatChannelStateForUser(channel.status.state)}`,
    `   登录账号: ${channel.status.account ?? "未登录"}`,
  ];
  if (channel.status.lastError) lines.push(`   最近错误: ${channel.status.lastError}`);
  if (channel.capabilities) lines.push(`   主要能力: ${formatCapabilitySummary(channel.capabilities)}`);
  return lines;
}

function formatChannelType(type: string): string {
  if (type === "weixin") return "微信";
  if (type === "lark" || type === "feishu") return "飞书";
  if (type === "terminal") return "终端";
  if (type === "mock") return "Mock";
  return type;
}

function formatCapabilitySummary(capabilities: ChannelCapabilities): string {
  const parts: string[] = [];
  if (capabilities.text) parts.push("文本");
  if (capabilities.direct) parts.push("私聊");
  if (capabilities.group) parts.push("群聊");
  if (capabilities.thread) parts.push("Thread");
  if (capabilities.media) parts.push("图片/文件");
  if (capabilities.typing) parts.push("输入状态");
  if (capabilities.login !== "none") parts.push(formatLoginMode(capabilities.login));
  return parts.length > 0 ? parts.join("、") : "未声明";
}

function formatLoginMode(login: ChannelLoginMode): string {
  switch (login) {
    case "none":
      return "无需登录";
    case "qr":
      return "扫码登录";
    case "token":
      return "Token 登录";
    case "external":
      return "外部授权";
  }
}

function formatWeixinPhase(phase: string): string {
  switch (phase) {
    case "adapter-ready":
      return "适配器已准备";
    case "missing-account":
      return "未发现本地登录态";
    case "account-loaded":
      return "已加载本地登录态";
    case "qr-issued":
      return "二维码已发出";
    case "login-confirmed":
      return "扫码登录已完成";
    case "already-connected":
      return "账号已经连接";
    case "sendmessage-context-fallback":
      return "发送消息回退到无 context token";
    case "sendmessage-retry":
      return "发送消息重试中";
    default:
      return phase;
  }
}

function formatChannelPhase(channelId: string, phase: string): string {
  if (channelId === "feishu") return formatFeishuPhase(phase);
  return formatWeixinPhase(phase);
}

function formatFeishuPhase(phase: string): string {
  switch (phase) {
    case "adapter-ready":
      return "适配器已准备";
    case "missing-credentials":
      return "缺少 App ID 或 App Secret";
    case "starting":
      return "正在启动";
    case "probe-ok":
      return "机器人配置检查通过";
    case "probe-failed":
      return "机器人配置检查失败";
    case "configuration-checked":
      return "配置检查通过";
    case "websocket-started":
      return "长连接已启动";
    case "websocket-connected":
      return "长连接已连接";
    case "websocket-reconnecting":
      return "长连接重连中";
    case "websocket-reconnected":
      return "长连接已恢复";
    case "websocket-error":
      return "长连接异常";
    case "message-received":
      return "已收到私聊消息";
    case "message-sent":
      return "已发送消息";
    case "event-skipped":
      return "事件已忽略";
    case "duplicate-skipped":
      return "重复消息已忽略";
    case "reply-failed":
      return "回复原消息失败，准备回退发送";
    case "create-failed":
      return "发送消息失败";
    case "handler-failed":
      return "消息处理失败";
    case "stopped":
      return "已停止";
    default:
      return phase;
  }
}

function formatFeishuDomain(domain: string): string {
  if (domain === "feishu") return "飞书";
  if (domain === "lark") return "Lark";
  return domain;
}

function formatConnectionMode(mode: string): string {
  if (mode === "websocket") return "WebSocket 长连接";
  return mode;
}

function formatConnectionState(state: string): string {
  switch (state) {
    case "idle":
      return "空闲";
    case "connecting":
      return "连接中";
    case "connected":
      return "已连接";
    case "reconnecting":
      return "重连中";
    case "failed":
      return "失败";
    default:
      return state;
  }
}

function stringDetail(details: Record<string, unknown>, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberDetail(details: Record<string, unknown>, key: string): number | undefined {
  const value = details[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
