import { arrayValue, objectValue, stringValue } from "./value-parsers.js";
import { isFinalAssistantItem } from "./assistant-messages.js";

const TURN_PAGE_LIMIT = 4;
const MAX_TURN_PAGES = 2;
const ITEM_PAGE_LIMIT = 16;
const MAX_ITEM_PAGES_PER_TURN = 2;

type ThreadHistoryMethod = "thread/turns/list" | "thread/items/list";

export type ThreadHistoryRequest = (
  method: ThreadHistoryMethod,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/**
 * Returns one recent user-visible assistant reply without hydrating an entire
 * thread. Every list call has an explicit page and item budget.
 */
export async function readLastAssistantMessageFromPages(
  request: ThreadHistoryRequest,
  sessionId: string,
): Promise<string | undefined> {
  try {
    let turnCursor: string | null = null;
    const seenTurnCursors = new Set<string>();
    const seenTurnIds = new Set<string>();
    for (let page = 0; page < MAX_TURN_PAGES; page += 1) {
      const response = await request("thread/turns/list", {
        threadId: sessionId,
        cursor: turnCursor,
        limit: TURN_PAGE_LIMIT,
        sortDirection: "desc",
        itemsView: "notLoaded",
      });
      for (const value of arrayValue(response.data)) {
        const turnId = stringValue(objectValue(value).id);
        if (!turnId || seenTurnIds.has(turnId)) continue;
        seenTurnIds.add(turnId);
        const message = await readLastAssistantMessageFromTurnItems(request, sessionId, turnId);
        if (message) return message;
      }
      const nextCursor = stringValue(response.nextCursor ?? response.next_cursor);
      if (!nextCursor || seenTurnCursors.has(nextCursor)) return undefined;
      seenTurnCursors.add(nextCursor);
      turnCursor = nextCursor;
    }
    return undefined;
  } catch (error) {
    if (isPaginationUnavailable(error)) return undefined;
    throw error;
  }
}

async function readLastAssistantMessageFromTurnItems(
  request: ThreadHistoryRequest,
  sessionId: string,
  turnId: string,
): Promise<string | undefined> {
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  for (let page = 0; page < MAX_ITEM_PAGES_PER_TURN; page += 1) {
    const response = await request("thread/items/list", {
      threadId: sessionId,
      turnId,
      cursor,
      limit: ITEM_PAGE_LIMIT,
      sortDirection: "desc",
    });
    const message = lastAssistantMessageFromEntries(arrayValue(response.data));
    if (message) return message;
    const nextCursor = stringValue(response.nextCursor ?? response.next_cursor);
    if (!nextCursor || seenCursors.has(nextCursor)) return undefined;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return undefined;
}

function lastAssistantMessageFromEntries(entries: unknown[]): string | undefined {
  for (const entry of entries) {
    const item = objectValue(objectValue(entry).item);
    if (!isFinalAssistantItem(item)) continue;
    const text = stringValue(item.text)?.trim();
    if (text) return text;
  }
  return undefined;
}

function isPaginationUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:-32601|method not found|unknown method|unsupported (?:method|request)|not supported)/i.test(message);
}
