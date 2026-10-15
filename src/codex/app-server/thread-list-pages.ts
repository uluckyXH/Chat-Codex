import type { CodexSessionListStatus, CodexSessionSummary } from "../types.js";
import { sessionSummaryFromThread } from "./thread-list.js";
import { arrayValue, objectValue, stringValue } from "./value-parsers.js";

export async function readThreadListPages(request: (params: Record<string, unknown>) => Promise<Record<string, unknown>>): Promise<{ sessions: CodexSessionSummary[]; status: CodexSessionListStatus }> {
  const sessions = new Map<string, CodexSessionSummary>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let sortKey = "recency_at";
  for (let page = 1; page <= 10; page++) {
    const params = () => ({ cursor, limit: 100, sortKey, sortDirection: "desc", archived: false, useStateDbOnly: false });
    let result: Record<string, unknown>;
    try {
      result = await request(params());
    } catch (error) {
      if (page !== 1 || sortKey !== "recency_at" || !isUnsupportedRecencySort(error)) throw error;
      sortKey = "updated_at";
      result = await request(params());
    }
    for (const value of arrayValue(result.data).slice(0, 100)) {
      const session = sessionSummaryFromThread(objectValue(value));
      if (session && !sessions.has(session.id)) sessions.set(session.id, session);
    }
    const next = stringValue(result.nextCursor ?? result.next_cursor);
    const truncated = arrayValue(result.data).length > 100 || Boolean(next && (page === 10 || cursors.has(next)));
    if (!next || truncated) return { sessions: [...sessions.values()], status: { source: "app-server", pages: page, truncated,
      ...(truncated ? { notice: "会话列表只加载了部分结果（达到读取上限或服务器分页异常）；可用 /resume <会话 ID> 直接恢复。" } : {}) } };
    cursors.add(next);
    cursor = next;
  }
  throw new Error("unreachable thread pagination state");
}

export function isPaginationMethodUnavailable(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /(?:-32601|method not found|unknown method|unsupported (?:method|request))/i.test(text);
}

function isUnsupportedRecencySort(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /(?:recency_at|sortKey|sort_key)/i.test(text) && /(?:unknown variant|invalid (?:value|params)|unsupported|not supported|unrecognized)/i.test(text);
}
