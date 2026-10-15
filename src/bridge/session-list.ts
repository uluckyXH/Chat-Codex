import { truncateDisplayText } from "../codex/codex-cli.js";
import type { CodexAdapter, CodexSessionStatus, CodexSessionSummary } from "../codex/types.js";
import type { MemoryStateStore, StoredSession } from "../state/memory-state-store.js";
import { formatLocalDateTimeWithZone } from "../time/display-time.js";
import type { SessionListItem, SessionListScope } from "./bridge-types.js";
import { formatCodexStatus, formatCompactPath, timestampValue } from "./formatters.js";

export const SESSION_LIST_PAGE_SIZE = 10;
export const SESSION_LIST_STATE_TTL_MS = 10 * 60_000;

export interface BuildSessionListOptions {
  state: MemoryStateStore;
  codex: CodexAdapter;
  routeKey: string;
  scope: SessionListScope;
}

export interface SessionListPage {
  scope: SessionListScope;
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  items: SessionListItem[];
  clamped: boolean;
}

export interface FormatSessionListOptions {
  notice?: string;
  title: string;
  scopeLabel: string;
  emptyText: string;
  selectionMode?: boolean;
  pageCommand?: string;
  hiddenUnavailableCount?: number;
  intro?: string;
}

interface MutableSessionListItem extends SessionListItem {
  status: CodexSessionStatus;
}

export async function buildSessionList(options: BuildSessionListOptions): Promise<SessionListItem[]> {
  const routeScoped = options.scope === "route";
  const currentSessionId = options.state.getBinding(options.routeKey)?.sessionId;
  const items = new Map<string, MutableSessionListItem>();

  const addItem = (
    input: Omit<SessionListItem, "current" | "selectable" | "ownerRouteKey" | "unavailableReason" | "source">,
    source: "state" | "codex",
  ): void => {
    const owner = options.state.getSessionOwner(input.id);
    const selectable = !owner || owner.ownerRouteKey === options.routeKey;
    const existing = items.get(input.id);
    const sourceValue = existing && existing.source !== source ? "merged" : source;
    const updatedAt = newerTimestamp(input.updatedAt, existing?.updatedAt);
    items.set(input.id, {
      id: input.id,
      title: existing?.title ?? input.title,
      cwd: existing?.cwd ?? input.cwd,
      status: existing?.status ?? input.status ?? { type: "unknown" },
      updatedAt,
      current: input.id === currentSessionId,
      selectable,
      ...(owner ? { ownerRouteKey: owner.ownerRouteKey } : {}),
      ...(selectable ? {} : { unavailableReason: "已绑定到其它聊天上下文" }),
      source: sourceValue,
    });
  };

  for (const stored of options.state.listSessions(routeScoped ? options.routeKey : undefined)) {
    addItem(storedSessionListInput(stored), "state");
  }
  for (const session of await options.codex.listSessions(routeScoped ? options.routeKey : undefined)) {
    addItem(codexSessionListInput(session), "codex");
  }

  return [...items.values()].sort(compareSessionListItems);
}

export function paginateSessionList(
  items: SessionListItem[],
  scope: SessionListScope,
  requestedPage: number,
  pageSize = SESSION_LIST_PAGE_SIZE,
): SessionListPage {
  const normalizedPageSize = Math.max(1, Math.floor(pageSize));
  const totalItems = items.length;
  const totalPages = totalItems > 0 ? Math.ceil(totalItems / normalizedPageSize) : 1;
  const normalizedRequestedPage = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1;
  const page = Math.min(Math.max(normalizedRequestedPage, 1), totalPages);
  const start = (page - 1) * normalizedPageSize;
  return {
    scope,
    page,
    pageSize: normalizedPageSize,
    totalItems,
    totalPages,
    items: items.slice(start, start + normalizedPageSize),
    clamped: page !== normalizedRequestedPage,
  };
}

export function formatSessionListPage(page: SessionListPage, options: FormatSessionListOptions): string {
  const lines = [
    `**${options.title}**`,
    options.intro,
    options.notice,
    "",
    `- 范围: ${options.scopeLabel}`,
    `- 页码: \`${page.page} / ${page.totalPages}\``,
    `- 数量: \`${page.totalItems}\``,
    page.clamped ? "- 提示: 页码超出范围，已显示最近可用页。" : undefined,
    options.hiddenUnavailableCount && options.hiddenUnavailableCount > 0
      ? `- 不可选会话: 已隐藏 \`${options.hiddenUnavailableCount}\` 个已绑定到其它聊天上下文的 session`
      : undefined,
    "",
  ].filter((line): line is string => line !== undefined);

  if (page.totalItems === 0) {
    lines.push(options.emptyText);
  } else {
    page.items.forEach((item, index) => {
      lines.push(...formatSessionListItem(item, index + 1));
    });
  }

  lines.push("");
  if (options.selectionMode) {
    lines.push("直接回复编号完成切换；回复 `n` 下一页，`p` 上一页；回复“取消”退出。");
  } else if (options.pageCommand) {
    lines.push(`发送 \`${options.pageCommand} next\` / \`${options.pageCommand} prev\` 翻页；发送 \`/use\` 进入切换选择。`);
  }
  return lines.join("\n").trimEnd();
}

export function pageNumberFromText(value: string): number | undefined {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return undefined;
  const page = Number(normalized);
  return Number.isSafeInteger(page) && page > 0 ? page : undefined;
}

export function sessionPageAction(value: string): "next" | "prev" | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "n" || normalized === "next" || normalized === "下一页") return "next";
  if (normalized === "p" || normalized === "prev" || normalized === "previous" || normalized === "上一页") return "prev";
  return undefined;
}

export function sessionListStateExpired(createdAt: number, now = Date.now()): boolean {
  return now - createdAt > SESSION_LIST_STATE_TTL_MS;
}

function formatSessionListItem(item: SessionListItem, index: number): string[] {
  const markers = [
    item.current ? "当前" : undefined,
    item.selectable ? undefined : "不可选",
  ].filter(Boolean);
  const suffix = markers.length > 0 ? `（${markers.join("，")}）` : "";
  return [
    `${index}. Session: \`${item.id}\`${suffix}`,
    `   - 最近活跃: \`${formatSessionUpdatedAt(item.updatedAt)}\``,
    `   - 标题: ${formatSessionTitle(item.title)}`,
    `   - 状态: ${formatCodexStatus(item.status)}`,
    item.cwd ? `   - 工作目录: \`${formatCompactPath(item.cwd)}\`` : undefined,
    item.unavailableReason ? `   - 不可选原因: ${item.unavailableReason}` : undefined,
  ].filter((line): line is string => line !== undefined);
}

function formatSessionUpdatedAt(updatedAt: string): string {
  return updatedAt ? formatLocalDateTimeWithZone(updatedAt) : "未知";
}

function formatSessionTitle(title: string | undefined): string {
  return title ? truncateDisplayText(title, 60) : "无标题";
}

function storedSessionListInput(stored: StoredSession): Omit<SessionListItem, "current" | "selectable" | "ownerRouteKey" | "unavailableReason" | "source"> {
  return {
    id: stored.session.id,
    title: stored.session.title,
    cwd: stored.session.cwd,
    status: stored.status,
    updatedAt: stored.updatedAt,
  };
}

function codexSessionListInput(session: CodexSessionSummary): Omit<SessionListItem, "current" | "selectable" | "ownerRouteKey" | "unavailableReason" | "source"> {
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    status: session.status,
    updatedAt: session.updatedAt,
  };
}

function newerTimestamp(left: string, right: string | undefined): string {
  if (!right) return left;
  if (!left) return right;
  return timestampValue(left) >= timestampValue(right) ? left : right;
}

function compareSessionListItems(left: SessionListItem, right: SessionListItem): number {
  if (left.current !== right.current) return left.current ? -1 : 1;
  if (left.selectable !== right.selectable) return left.selectable ? -1 : 1;
  return timestampValue(right.updatedAt) - timestampValue(left.updatedAt)
    || left.id.localeCompare(right.id);
}
