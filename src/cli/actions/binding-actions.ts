import {
  discoverCodexSessions,
  displayCodexSessionTitle,
  findCodexSessionById,
  formatCodexSessionTitleForDisplay,
  truncateDisplayText,
  type CodexRunPolicy,
  type DiscoveredCodexSession,
} from "../../codex/codex-cli.js";
import type { CodexSession } from "../../codex/types.js";
import type { FileStateStore } from "../../state/file-state-store.js";
import type { RouteRecord, SessionOwnerRecord } from "../../state/persistent-state-types.js";
import { formatFullDateTime, formatShortDateTime } from "./channel-actions.js";

export interface BindingActionsOptions {
  cwd?: string;
  sessionLimit?: number;
  discoverSessions?: () => DiscoveredCodexSession[];
  findSessionById?: (sessionId: string) => DiscoveredCodexSession | undefined;
}

export interface BindingSummary {
  route: RouteRecord;
  label: string;
  trusted?: boolean;
  activeSession?: SessionDisplay;
  permission?: CodexRunPolicy;
}

export interface SessionDisplay {
  id: string;
  shortId: string;
  title?: string;
  cwd?: string;
  updatedAt?: string;
}

export interface SelectableSessionChoice extends SessionDisplay {
  current: boolean;
}

export interface UnavailableSessionChoice extends SessionDisplay {
  owner: SessionOwnerRecord;
  ownerLabel: string;
}

export interface SessionChoices {
  selectable: SelectableSessionChoice[];
  unavailable: UnavailableSessionChoice[];
}

export type BindExistingSessionResult =
  | { ok: true; binding: BindingSummary; session: SessionDisplay }
  | { ok: false; reason: "not_found"; message: string }
  | { ok: false; reason: "owner_conflict"; owner: SessionOwnerRecord; message: string };

export type BindNewSessionResult =
  | { ok: true; binding: BindingSummary; session: SessionDisplay }
  | { ok: false; reason: "owner_conflict"; message: string };

export type UnbindSessionResult =
  | { ok: true; binding: BindingSummary; sessionId: string; message: string }
  | { ok: false; reason: "not_bound"; message: string };

export class BindingActions {
  private readonly cwd: string;
  private readonly sessionLimit: number;
  private readonly discoverSessionsFn: () => DiscoveredCodexSession[];
  private readonly findSessionByIdFn: (sessionId: string) => DiscoveredCodexSession | undefined;

  constructor(
    private readonly state: FileStateStore,
    options: BindingActionsOptions = {},
  ) {
    this.cwd = options.cwd ?? process.cwd();
    this.sessionLimit = options.sessionLimit ?? 30;
    this.discoverSessionsFn = options.discoverSessions ?? (() => discoverCodexSessions({ limit: this.sessionLimit }));
    this.findSessionByIdFn = options.findSessionById ?? ((sessionId) => findCodexSessionById(sessionId));
  }

  listBindings(): BindingSummary[] {
    const sessions = this.sessionMap();
    return this.state.listRoutes()
      .map((route) => this.bindingSummary(route, sessions.get(route.activeSessionId ?? "")))
      .sort((left, right) => left.label.localeCompare(right.label, "zh-Hans-CN"));
  }

  getBinding(routeKey: string): BindingSummary | undefined {
    const route = this.state.listRoutes().find((item) => item.routeKey === routeKey);
    if (!route) return undefined;
    return this.bindingSummary(route, route.activeSessionId ? this.findSession(route.activeSessionId) : undefined);
  }

  listSessionChoices(routeKey: string): SessionChoices {
    const currentSessionId = this.state.getBinding(routeKey)?.sessionId
      ?? this.state.listRoutes().find((route) => route.routeKey === routeKey)?.activeSessionId;
    const selectableById = new Map<string, SelectableSessionChoice>();
    const unavailableById = new Map<string, UnavailableSessionChoice>();

    const addSession = (session: DiscoveredCodexSession): void => {
      const display = sessionDisplay(session);
      const owner = this.state.getSessionOwner(session.id);
      if (owner && owner.ownerRouteKey !== routeKey) {
        unavailableById.set(session.id, {
          ...display,
          owner,
          ownerLabel: this.routeLabel(owner.ownerRouteKey),
        });
        return;
      }
      selectableById.set(session.id, {
        ...display,
        current: session.id === currentSessionId,
      });
    };

    for (const session of this.discoverSessionsFn()) addSession(session);
    if (currentSessionId && !selectableById.has(currentSessionId)) {
      const current = this.findSession(currentSessionId);
      selectableById.set(currentSessionId, {
        ...(current ? sessionDisplay(current) : fallbackSessionDisplay(currentSessionId)),
        current: true,
      });
    }

    const selectable = [...selectableById.values()].sort(compareSelectableSessions);
    const unavailable = [...unavailableById.values()].sort(compareSessionDisplay);
    return { selectable, unavailable };
  }

  bindExistingSession(routeKey: string, sessionId: string): BindExistingSessionResult {
    const session = this.findSession(sessionId);
    if (!session) {
      return {
        ok: false,
        reason: "not_found",
        message: `没有找到这个 session：${sessionId}。请重新输入编号或有效 Session ID。`,
      };
    }
    const claim = this.state.claimSessionOwner(routeKey, session.id);
    if (!claim.ok) {
      return {
        ok: false,
        reason: "owner_conflict",
        owner: claim.owner,
        message: `无法绑定 Codex session：${session.id} 已绑定到 ${this.routeLabel(claim.owner.ownerRouteKey)}。`,
      };
    }
    const activated = this.state.activateOwnedSession(routeKey, codexSessionFromDiscovered(session, this.cwd));
    if (!activated.ok) {
      if (claim.newlyClaimed) this.state.rollbackSessionOwnerClaim(routeKey, session.id);
      const owner = activated.owner ?? {
        sessionId: session.id,
        ownerRouteKey: "unknown",
        claimedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return {
        ok: false,
        reason: "owner_conflict",
        owner,
        message: `无法绑定 Codex session：${session.id} 已绑定到 ${this.routeLabel(owner.ownerRouteKey)}。`,
      };
    }
    const binding = this.getBinding(routeKey);
    return {
      ok: true,
      binding: binding ?? this.bindingSummary(this.state.listRoutes().find((route) => route.routeKey === routeKey) as RouteRecord, session),
      session: sessionDisplay(session),
    };
  }

  bindNewSession(routeKey: string, session: CodexSession): BindNewSessionResult {
    try {
      this.state.bindSession(routeKey, session);
    } catch (error) {
      return {
        ok: false,
        reason: "owner_conflict",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const binding = this.getBinding(routeKey);
    return {
      ok: true,
      binding: binding ?? this.bindingSummary(this.state.listRoutes().find((route) => route.routeKey === routeKey) as RouteRecord, discoveredSessionFromCodex(session)),
      session: sessionDisplay(discoveredSessionFromCodex(session)),
    };
  }

  unbindSession(routeKey: string): UnbindSessionResult {
    const before = this.getBinding(routeKey);
    const result = this.state.unbindSession(routeKey);
    if (!result.ok) {
      return {
        ok: false,
        reason: "not_bound",
        message: "当前聊天没有绑定 session。",
      };
    }
    return {
      ok: true,
      binding: before ?? this.bindingSummary(this.state.listRoutes().find((route) => route.routeKey === routeKey) as RouteRecord),
      sessionId: result.binding.sessionId,
      message: `已解绑 ${before?.label ?? routeKey} 的 session：${result.binding.sessionId}`,
    };
  }

  getSessionPermission(sessionId: string): CodexRunPolicy | undefined {
    return this.state.getSessionRunPolicy(sessionId);
  }

  setSessionPermission(sessionId: string, policy: CodexRunPolicy): CodexRunPolicy {
    this.state.setSessionRunPolicy(sessionId, policy);
    return policy;
  }

  formatBindingDetail(binding: BindingSummary): string {
    return [
      "绑定详情",
      "",
      `聊天: ${binding.label}`,
      `当前 session: ${formatSessionDisplay(binding.activeSession)}`,
      `当前权限: ${formatRunPolicyForUser(binding.permission)}`,
      binding.activeSession ? `最近活跃: ${formatSessionActiveTime(binding.activeSession.updatedAt, "full")}` : undefined,
      binding.activeSession?.cwd ? `工作目录: ${binding.activeSession.cwd}` : undefined,
      binding.route.lastSeenAt ? `最近消息: ${binding.route.lastSeenAt}` : undefined,
      "",
      "操作:",
      "  1. 切换 session",
      "  2. 新建并绑定 session",
      binding.activeSession ? "  3. 设置当前 session 权限" : "  3. 设置当前 session 权限（请先绑定 session）",
      binding.activeSession ? "  4. 解绑当前 session" : "  4. 解绑当前 session（当前未绑定）",
      "  0. 返回",
    ].filter(Boolean).join("\n");
  }

  formatSessionChoices(routeKey: string, choices: SessionChoices): string {
    const lines = [
      "选择 Codex session",
      "",
      ...choices.selectable.map((choice, index) => {
        const marker = choice.current ? "当前" : "可用";
        return `  ${index + 1}. ${marker}  ${padDisplay(choice.title ?? choice.id, 28)} ${choice.shortId}  最近 ${formatSessionActiveTime(choice.updatedAt, "short")}`;
      }),
      "",
      "操作:",
      "  m. 手动输入 Session ID",
      "  0. 返回",
    ];
    if (choices.unavailable.length > 0) {
      lines.push("", "不可选:");
      for (const choice of choices.unavailable) {
        lines.push(`  已绑定到 ${choice.ownerLabel}  ${padDisplay(choice.title ?? choice.id, 28)} ${choice.shortId}  最近 ${formatSessionActiveTime(choice.updatedAt, "short")}`);
      }
    }
    if (choices.selectable.length === 0) {
      lines.splice(2, 0, "  暂无可选历史 session");
    }
    const binding = this.getBinding(routeKey);
    if (binding) lines.unshift(`聊天: ${binding.label}`, "");
    return lines.join("\n");
  }

  formatBindSuccess(result: Extract<BindExistingSessionResult, { ok: true }>): string {
    return [
      "已切换 session",
      "",
      `聊天: ${result.binding.label}`,
      `当前 session: ${formatSessionDisplay(result.session)}`,
      `最近活跃: ${formatSessionActiveTime(result.session.updatedAt, "full")}`,
      result.session.cwd ? `工作目录: ${result.session.cwd}` : undefined,
      "",
      "1. 返回绑定详情",
      "0. 返回首页",
    ].filter(Boolean).join("\n");
  }

  private bindingSummary(route: RouteRecord, session?: DiscoveredCodexSession): BindingSummary {
    const activeSession = route.activeSessionId
      ? sessionDisplay(session ?? fallbackDiscoveredSession(route.activeSessionId))
      : undefined;
    return {
      route,
      label: formatRouteLabel(route),
      trusted: this.state.isRouteTrusted(route.routeKey),
      activeSession,
      permission: route.activeSessionId ? this.getSessionPermission(route.activeSessionId) : undefined,
    };
  }

  private sessionMap(): Map<string, DiscoveredCodexSession> {
    return new Map(this.discoverSessionsFn().map((session) => [session.id, session]));
  }

  private findSession(sessionId: string): DiscoveredCodexSession | undefined {
    return this.discoverSessionsFn().find((session) => session.id === sessionId)
      ?? this.findSessionByIdFn(sessionId);
  }

  private routeLabel(routeKey: string): string {
    return formatOwnerRouteLabel(this.state, routeKey);
  }
}

export function formatOwnerRouteLabel(state: FileStateStore, routeKey: string): string {
  const route = state.listRoutes().find((item) => item.routeKey === routeKey);
  if (route) return formatRouteLabel(route);
  if (routeKey.startsWith("pending:")) {
    const pendingId = routeKey.slice("pending:".length);
    const pending = state.listPendingBindings().find((item) => item.id === pendingId);
    return pending?.label ? `${pending.label}（待生效）` : "待生效绑定";
  }
  return routeKey;
}

export function formatRouteLabel(route: RouteRecord): string {
  if (route.channelType === "weixin" || route.channelId.startsWith("weixin")) {
    return `微信 / ${route.accountId} / 主聊天`;
  }
  if (route.channelType === "feishu" || route.channelId.startsWith("feishu") || route.channelId.startsWith("lark")) {
    const identity = route.identity;
    const name = route.conversationKind === "direct"
      ? maskedIdentifier(identity?.openId)
        ?? maskedIdentifier(route.conversationId)
        ?? route.displayName
        ?? "未知用户"
      : route.displayName
        ?? identity?.lastSenderDisplayName
        ?? maskedIdentifier(identity?.openId)
        ?? maskedIdentifier(route.conversationId)
        ?? "未知群聊";
    return `飞书 / ${route.accountId} / ${name}`;
  }
  return `${route.channelType ?? route.channelId} / ${route.displayName ?? route.conversationId}`;
}

export function formatRunPolicyForUser(policy: CodexRunPolicy | undefined): string {
  if (!policy) return "未单独设置（使用默认权限）";
  if (policy.permissionMode === "full") return "完全权限（跳过审批和沙箱，高风险）";
  return `审批模式（${policy.sandbox ?? "workspace-write"} 沙箱）`;
}

function formatSessionDisplay(session: SessionDisplay | undefined): string {
  if (!session) return "未绑定";
  return `${session.title ?? session.id} / ${session.shortId}`;
}

export function formatSessionActiveTime(updatedAt: string | undefined, style: "short" | "full" = "short"): string {
  return style === "full" ? formatFullDateTime(updatedAt) : formatShortDateTime(updatedAt);
}

function sessionDisplay(session: DiscoveredCodexSession): SessionDisplay {
  return {
    id: session.id,
    shortId: shortSessionId(session.id),
    title: formatCodexSessionTitleForDisplay(session, 36),
    cwd: session.cwd,
    updatedAt: session.updatedAt,
  };
}

function fallbackSessionDisplay(sessionId: string): SessionDisplay {
  return {
    id: sessionId,
    shortId: shortSessionId(sessionId),
  };
}

function fallbackDiscoveredSession(sessionId: string): DiscoveredCodexSession {
  return { id: sessionId };
}

function discoveredSessionFromCodex(session: CodexSession): DiscoveredCodexSession {
  return {
    id: session.id,
    threadName: session.title,
    cwd: session.cwd,
    updatedAt: session.createdAt,
  };
}

function codexSessionFromDiscovered(session: DiscoveredCodexSession, cwd: string): CodexSession {
  return {
    id: session.id,
    cwd: session.cwd ?? cwd,
    title: displayCodexSessionTitle(session),
    createdAt: session.updatedAt ?? new Date().toISOString(),
  };
}

function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 8) return sessionId;
  return sessionId.slice(0, 8);
}

function maskedIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function padDisplay(text: string, width: number): string {
  const display = truncateDisplayText(text, width);
  const length = Array.from(display).length;
  return length >= width ? display : `${display}${" ".repeat(width - length)}`;
}

function compareSelectableSessions(left: SelectableSessionChoice, right: SelectableSessionChoice): number {
  if (left.current !== right.current) return left.current ? -1 : 1;
  return compareSessionDisplay(left, right);
}

function compareSessionDisplay(left: SessionDisplay, right: SessionDisplay): number {
  return Date.parse(right.updatedAt ?? "") - Date.parse(left.updatedAt ?? "")
    || left.id.localeCompare(right.id);
}
