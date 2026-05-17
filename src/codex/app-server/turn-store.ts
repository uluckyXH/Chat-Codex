import type { CodexCollaborationMode, CodexEvent } from "../types.js";
import type { TurnQueueRecord } from "./types.js";

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

export function createTurnQueueRecord(
  sessionId: string,
  turnId: string,
  queue: AsyncEventQueue<CodexEvent>,
  collaborationMode?: CodexCollaborationMode,
): TurnQueueRecord {
  return {
    sessionId,
    turnId,
    queue,
    ...(collaborationMode ? { collaborationMode } : {}),
    finalText: "",
    progressDrafts: new Map(),
    commandExecutions: new Map(),
    agentMessagePhases: new Map(),
    emittedProgressItemIds: new Set(),
    emittedProgress: new Set(),
    closed: false,
  };
}

export function shouldCreateBackgroundTurn(method: string): boolean {
  return method !== "thread/tokenUsage/updated";
}
