import type { CodexBackgroundEventHandler, CodexEvent, CodexProgressKind } from "../types.js";
import {
  appServerErrorMessage,
  isTransientAppServerError,
  messagePhaseValue,
  progressFromThreadItem,
  shouldFlushProgressDraft,
  textFromPlan,
} from "./notification-mapper.js";
import { withContext } from "./session-status.js";
import { AsyncEventQueue, createTurnQueueRecord, shouldCreateBackgroundTurn } from "./turn-store.js";
import type { AppServerSessionRecord, JsonRpcNotification, TurnQueueRecord } from "./types.js";
import {
  appendCommandOutput,
  commandExecutionProgress,
  commandStartProgress,
  createCommandExecutionRecord,
} from "./command-output-summary.js";
import { arrayValue, isoFromSeconds, numberValue, objectValue, stringValue } from "./value-parsers.js";
import { parseTokenUsage } from "./model-policy.js";

export interface AppServerTurnControllerOptions {
  sessions: Map<string, AppServerSessionRecord>;
  threadToSession: Map<string, string>;
}

export class AppServerTurnController {
  private readonly sessions: Map<string, AppServerSessionRecord>;
  private readonly threadToSession: Map<string, string>;
  private readonly turnQueues = new Map<string, TurnQueueRecord>();
  private readonly earlyTurnEvents = new Map<string, CodexEvent[]>();
  private readonly closedTurnIds = new Set<string>();
  private readonly backgroundHandlers = new Set<CodexBackgroundEventHandler>();

  constructor(options: AppServerTurnControllerOptions) {
    this.sessions = options.sessions;
    this.threadToSession = options.threadToSession;
  }

  onBackgroundEvent(handler: CodexBackgroundEventHandler): () => void {
    this.backgroundHandlers.add(handler);
    return () => {
      this.backgroundHandlers.delete(handler);
    };
  }

  registerTurn(
    sessionId: string,
    turnId: string,
    queue: AsyncEventQueue<CodexEvent>,
    collaborationMode?: TurnQueueRecord["collaborationMode"],
  ): void {
    this.closedTurnIds.delete(turnId);
    this.turnQueues.set(turnId, createTurnQueueRecord(sessionId, turnId, queue, collaborationMode));
    for (const event of this.earlyTurnEvents.get(turnId) ?? []) {
      queue.push(event);
    }
    this.earlyTurnEvents.delete(turnId);
  }

  get(turnId: string): TurnQueueRecord | undefined {
    return this.turnQueues.get(turnId);
  }

  hasActiveTurns(): boolean {
    return this.turnQueues.size > 0;
  }

  pushTurnEvent(turnId: string, event: CodexEvent): void {
    if (this.closedTurnIds.has(turnId)) return;
    const turn = this.turnQueues.get(turnId);
    if (turn && !turn.closed) {
      turn.queue.push(event);
      return;
    }
    const early = this.earlyTurnEvents.get(turnId) ?? [];
    early.push(event);
    this.earlyTurnEvents.set(turnId, early);
  }

  pushTurnOrBackgroundEvent(event: CodexEvent): void {
    const turn = this.turnQueues.get(event.turnId);
    if (turn && !turn.closed) {
      turn.queue.push(event);
      return;
    }
    if (this.closedTurnIds.has(event.turnId) && event.type !== "codex.notification") return;
    void this.emitBackgroundEvent(event);
  }

  createBackgroundTurn(sessionId: string, turnId: string): TurnQueueRecord | undefined {
    if (this.closedTurnIds.has(turnId)) return undefined;
    const existing = this.turnQueues.get(turnId);
    if (existing) return existing;
    const stored = this.sessions.get(sessionId);
    if (!stored) return undefined;
    const queue = new AsyncEventQueue<CodexEvent>();
    const turn = createTurnQueueRecord(sessionId, turnId, queue);
    this.turnQueues.set(turnId, turn);
    const startedAt = new Date().toISOString();
    stored.status = withContext(stored, { type: "running", turnId, startedAt });
    stored.currentTurnId = turnId;
    stored.updatedAt = new Date().toISOString();
    void this.drainBackgroundTurn(queue);
    queue.push({ type: "turn.started", sessionId, turnId, startedAt });
    return turn;
  }

  closeTurn(turnId: string, status: "idle" | "failed", error?: string): void {
    const turn = this.turnQueues.get(turnId);
    if (!turn || turn.closed) return;
    turn.closed = true;
    const stored = this.sessions.get(turn.sessionId);
    if (stored) {
      stored.status = status === "failed" && error ? withContext(stored, { type: "failed", error }) : withContext(stored, { type: "idle" });
      stored.currentTurnId = undefined;
      stored.updatedAt = new Date().toISOString();
    }
    turn.queue.close();
    this.turnQueues.delete(turnId);
    this.closedTurnIds.add(turnId);
  }

  closeAll(): void {
    for (const turn of this.turnQueues.values()) {
      turn.queue.close();
    }
    this.turnQueues.clear();
    this.closedTurnIds.clear();
  }

  failAll(error: Error): void {
    for (const turn of this.turnQueues.values()) {
      turn.queue.push({ type: "turn.failed", sessionId: turn.sessionId, turnId: turn.turnId, error: error.message });
      turn.queue.close();
    }
    this.turnQueues.clear();
    this.closedTurnIds.clear();
  }

  handleNotification(notification: JsonRpcNotification): void {
    const params = objectValue(notification.params);
    const threadId = stringValue(params.threadId);
    const turnId = stringValue(params.turnId) ?? stringValue(objectValue(params.turn).id);
    if (!turnId) return;
    let turn = this.turnQueues.get(turnId);
    const sessionId = (threadId ? this.threadToSession.get(threadId) : undefined) ?? turn?.sessionId ?? threadId;
    if (!sessionId) return;
    if (!turn && shouldCreateBackgroundTurn(notification.method)) {
      turn = this.createBackgroundTurn(sessionId, turnId);
    }

    if (notification.method === "turn/started") {
      const stored = this.sessions.get(sessionId);
      if (stored) {
        const startedAt = startedAtFromNotification(params) ?? runningStartedAt(stored.status) ?? new Date().toISOString();
        stored.status = withContext(stored, { type: "running", turnId, startedAt });
        stored.currentTurnId = turnId;
        stored.updatedAt = new Date().toISOString();
      }
      return;
    }
    if (notification.method === "thread/tokenUsage/updated") {
      const stored = this.sessions.get(sessionId);
      if (stored) {
        const context = parseTokenUsage(objectValue(params.tokenUsage));
        if (context) {
          stored.status = { ...stored.status, context };
          stored.updatedAt = new Date().toISOString();
        }
      }
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      const delta = stringValue(params.delta);
      if (!delta) return;
      const itemId = stringValue(params.itemId);
      const phase = itemId && turn ? turn.agentMessagePhases.get(itemId) : undefined;
      if (turn && itemId && phase === "commentary") {
        this.appendCommentaryDelta(turn, itemId, delta);
        return;
      }
      if (turn) turn.finalText += delta;
      this.pushTurnEvent(turnId, { type: "assistant.delta", sessionId, turnId, text: delta });
      return;
    }
    if (notification.method === "item/reasoning/summaryTextDelta") {
      const delta = stringValue(params.delta);
      const itemId = stringValue(params.itemId);
      if (turn && itemId && delta) this.appendProgressDelta(turn, sessionId, turnId, itemId, delta, "reasoning");
      return;
    }
    if (notification.method === "item/reasoning/summaryPartAdded") {
      const itemId = stringValue(params.itemId);
      if (turn && itemId) this.flushProgressDraft(turn, sessionId, turnId, itemId);
      return;
    }
    if (notification.method === "turn/plan/updated") {
      const text = textFromPlan(params);
      if (turn && text) this.pushProgressEvent(turn, sessionId, turnId, `计划更新: ${text}`, "todo");
      return;
    }
    if (notification.method === "item/started") {
      if (!turn) return;
      this.handleItemStarted(turn, sessionId, turnId, objectValue(params.item));
      return;
    }
    if (notification.method === "item/plan/delta") {
      const delta = stringValue(params.delta);
      const itemId = stringValue(params.itemId);
      if (turn && itemId && delta) this.appendProgressDelta(turn, sessionId, turnId, itemId, delta, "todo", "计划更新: ");
      return;
    }
    if (notification.method === "item/commandExecution/outputDelta") {
      const delta = stringValue(params.delta);
      const itemId = stringValue(params.itemId);
      if (turn && itemId && delta) {
        this.appendCommandOutputDelta(turn, itemId, delta);
      }
      return;
    }
    if (notification.method === "item/completed") {
      if (!turn) return;
      this.handleItemCompleted(turn, sessionId, turnId, objectValue(params.item));
      return;
    }
    if (notification.method === "error") {
      const error = appServerErrorMessage(params);
      if (isTransientAppServerError(error)) {
        const text = `Codex 连接恢复中: ${error}`;
        if (turn) {
          this.pushProgressEvent(turn, sessionId, turnId, text, "other");
        } else {
          this.pushTurnEvent(turnId, { type: "assistant.progress", sessionId, turnId, text, kind: "other" });
        }
        return;
      }
      this.pushTurnEvent(turnId, { type: "turn.failed", sessionId, turnId, error });
      this.closeTurn(turnId, "failed", error);
      return;
    }
    if (notification.method === "turn/completed") {
      if (!turn) {
        this.pushTurnEvent(turnId, { type: "turn.completed", sessionId, turnId });
        return;
      }
      const turnPayload = objectValue(params.turn);
      const status = stringValue(turnPayload.status);
      if (status === "failed") {
        const error = stringValue(objectValue(turnPayload.error).message) ?? "codex turn failed";
        this.pushTurnEvent(turnId, { type: "turn.failed", sessionId, turnId, error });
        this.closeTurn(turnId, "failed", error);
      } else {
        if (turn.finalText) {
          this.pushTurnEvent(turnId, { type: "assistant.completed", sessionId, turnId, text: turn.finalText });
        }
        this.pushTurnEvent(turnId, { type: "turn.completed", sessionId, turnId });
        this.closeTurn(turnId, "idle");
      }
    }
  }

  private async drainBackgroundTurn(queue: AsyncEventQueue<CodexEvent>): Promise<void> {
    for await (const event of queue) {
      await this.emitBackgroundEvent(event);
    }
  }

  private async emitBackgroundEvent(event: CodexEvent): Promise<void> {
    for (const handler of [...this.backgroundHandlers]) {
      await handler(event);
    }
  }

  private handleItemCompleted(turn: TurnQueueRecord, sessionId: string, turnId: string, item: Record<string, unknown>): void {
    const toolProgress = toolProgressFromThreadItem(item, "end");
    if (toolProgress) this.pushTurnEvent(turnId, { type: "tool.progress", sessionId, turnId, progress: toolProgress });
    const itemType = stringValue(item.type);
    const itemId = stringValue(item.id);
    if (itemId) this.flushProgressDraft(turn, sessionId, turnId, itemId);
    if (itemType === "agentMessage") {
      const text = stringValue(item.text);
      const phase = messagePhaseValue(item.phase);
      if (phase === "commentary") {
        if (itemId && turn.emittedProgressItemIds.has(itemId)) return;
        if (text) this.pushCommentaryEvent(turn, sessionId, turnId, text, itemId);
        return;
      }
      if (text) {
        turn.finalText = text;
        turn.queue.push({ type: "assistant.completed", sessionId, turnId, text });
      }
      return;
    }
    if (itemType === "reasoning") {
      if (itemId && turn.emittedProgressItemIds.has(itemId)) return;
      const text = [...arrayValue(item.summary), ...arrayValue(item.content)]
        .map((entry) => typeof entry === "string" ? entry : undefined)
        .filter((entry): entry is string => Boolean(entry))
        .join("\n")
        .trim();
      if (text) this.pushProgressEvent(turn, sessionId, turnId, text, "reasoning");
      return;
    }
    if (itemType === "plan") {
      const alreadyEmittedProgress = Boolean(itemId && turn.emittedProgressItemIds.has(itemId));
      const text = stringValue(item.text);
      if (text) {
        if (!alreadyEmittedProgress) this.pushProgressEvent(turn, sessionId, turnId, `计划更新: ${text}`, "todo");
        if (turn.collaborationMode === "plan") {
          this.pushTurnEvent(turnId, { type: "assistant.plan", sessionId, turnId, text });
        }
      }
      return;
    }
    if (itemType === "commandExecution") {
      if (itemId) {
        const record = turn.commandExecutions.get(itemId);
        const progress = commandExecutionProgress({
          command: stringValue(item.command) ?? record?.command,
          cwd: stringValue(item.cwd) ?? record?.cwd,
          status: stringValue(item.status),
          exitCode: numberValue(item.exitCode),
          durationMs: numberValue(item.durationMs),
          aggregatedOutput: stringValue(item.aggregatedOutput),
          output: record?.output,
        });
        turn.commandExecutions.delete(itemId);
        if (progress) this.pushProgressEvent(turn, sessionId, turnId, progress.text, progress.kind);
      } else {
        const progress = progressFromThreadItem(item);
        if (progress) this.pushProgressEvent(turn, sessionId, turnId, progress.text, progress.kind);
      }
      return;
    }
    const progress = progressFromThreadItem(item);
    if (progress) {
      this.pushProgressEvent(turn, sessionId, turnId, progress.text, progress.kind);
    }
  }

  private handleItemStarted(turn: TurnQueueRecord, _sessionId: string, _turnId: string, item: Record<string, unknown>): void {
    const toolProgress = toolProgressFromThreadItem(item, "start");
    if (toolProgress) this.pushTurnEvent(turn.turnId, {
      type: "tool.progress",
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      progress: toolProgress,
    });
    const itemType = stringValue(item.type);
    if (itemType === "reasoning") {
      this.pushProgressEvent(turn, turn.sessionId, turn.turnId, "正在分析...", "reasoning");
    } else if (itemType === "plan") {
      this.pushProgressEvent(turn, turn.sessionId, turn.turnId, "正在规划...", "todo");
    } else if (itemType === "contextCompaction" || itemType === "context_compaction") {
      this.pushProgressEvent(turn, turn.sessionId, turn.turnId, "正在压缩上下文...", "other");
    } else if (itemType === "agentMessage") {
      const itemId = stringValue(item.id);
      const phase = messagePhaseValue(item.phase);
      if (itemId && phase) turn.agentMessagePhases.set(itemId, phase);
    } else if (itemType === "commandExecution") {
      this.handleCommandStarted(turn, item);
    }
  }

  private handleCommandStarted(turn: TurnQueueRecord, item: Record<string, unknown>): void {
    const itemId = stringValue(item.id);
    const command = stringValue(item.command);
    if (itemId) {
      turn.commandExecutions.set(itemId, createCommandExecutionRecord({
        itemId,
        command,
        cwd: stringValue(item.cwd),
        startedAtMs: numberValue(item.startedAtMs),
      }));
    }
    const progress = commandStartProgress(command);
    if (progress) this.pushProgressEvent(turn, turn.sessionId, turn.turnId, progress, "command");
  }

  private appendCommandOutputDelta(turn: TurnQueueRecord, itemId: string, delta: string): void {
    let record = turn.commandExecutions.get(itemId);
    if (!record) {
      record = createCommandExecutionRecord({ itemId });
      turn.commandExecutions.set(itemId, record);
    }
    appendCommandOutput(record.output, delta);
  }

  private appendProgressDelta(
    turn: TurnQueueRecord,
    sessionId: string,
    turnId: string,
    itemId: string,
    delta: string,
    kind: CodexProgressKind,
    prefix?: string,
  ): void {
    const draft = turn.progressDrafts.get(itemId) ?? { type: "progress" as const, kind, text: "", prefix };
    draft.text += delta;
    draft.type = "progress";
    draft.kind = kind;
    draft.prefix = prefix;
    turn.progressDrafts.set(itemId, draft);
    if (shouldFlushProgressDraft(draft.text)) {
      this.flushProgressDraft(turn, sessionId, turnId, itemId);
    }
  }

  private appendCommentaryDelta(turn: TurnQueueRecord, itemId: string, delta: string): void {
    const draft = turn.progressDrafts.get(itemId) ?? { type: "commentary" as const, text: "" };
    draft.text += delta;
    draft.type = "commentary";
    turn.progressDrafts.set(itemId, draft);
    if (shouldFlushProgressDraft(draft.text)) {
      this.flushProgressDraft(turn, turn.sessionId, turn.turnId, itemId);
    }
  }

  private flushProgressDraft(turn: TurnQueueRecord, sessionId: string, turnId: string, itemId: string): void {
    const draft = turn.progressDrafts.get(itemId);
    if (!draft) return;
    turn.progressDrafts.delete(itemId);
    const text = draft.text.trim();
    if (!text) return;
    turn.emittedProgressItemIds.add(itemId);
    if (draft.type === "commentary") {
      this.pushCommentaryEvent(turn, sessionId, turnId, text, itemId);
      return;
    }
    if (draft.kind) this.pushProgressEvent(turn, sessionId, turnId, `${draft.prefix ?? ""}${text}`, draft.kind);
  }

  private pushProgressEvent(
    turn: TurnQueueRecord,
    sessionId: string,
    turnId: string,
    text: string,
    kind: CodexProgressKind,
  ): void {
    const normalized = text.trim();
    if (!normalized || turn.emittedProgress.has(normalized)) return;
    turn.emittedProgress.add(normalized);
    turn.queue.push({ type: "assistant.progress", sessionId, turnId, text: normalized, kind });
  }

  private pushCommentaryEvent(
    turn: TurnQueueRecord,
    sessionId: string,
    turnId: string,
    text: string,
    itemId?: string,
  ): void {
    const normalized = text.trim();
    if (!normalized || turn.emittedCommentary.has(normalized)) return;
    turn.emittedCommentary.add(normalized);
    turn.queue.push({
      type: "assistant.commentary",
      sessionId,
      turnId,
      text: normalized,
      ...(itemId ? { itemId } : {}),
    });
  }
}

function startedAtFromNotification(params: Record<string, unknown>): string | undefined {
  const turn = objectValue(params.turn);
  return isoFromSeconds(numberValue(turn.startedAt))
    ?? isoFromMilliseconds(numberValue(turn.startedAtMs))
    ?? isoFromMilliseconds(numberValue(params.startedAtMs));
}

function toolProgressFromThreadItem(
  item: Record<string, unknown>,
  phase: "start" | "end",
): { phase: "start" | "end"; itemId: string; toolName: string; status?: "completed" | "failed" | "blocked" | "unknown" } | undefined {
  const itemId = stringValue(item.id);
  if (!itemId) return undefined;
  const toolName = toolNameFromThreadItem(item);
  if (!toolName) return undefined;
  return {
    phase,
    itemId,
    toolName,
    ...(phase === "end" ? { status: toolStatusFromThreadItem(item) } : {}),
  };
}

function toolNameFromThreadItem(item: Record<string, unknown>): string | undefined {
  const itemType = stringValue(item.type);
  if (itemType === "commandExecution") {
    const command = stringValue(item.command);
    return command ? `command: ${truncateToolName(command)}` : "command";
  }
  if (itemType === "mcpToolCall") {
    const tool = [stringValue(item.server), stringValue(item.tool)].filter(Boolean).join("/");
    return tool ? truncateToolName(tool) : "mcp_tool";
  }
  if (itemType === "webSearch") return "web_search";
  return undefined;
}

function toolStatusFromThreadItem(item: Record<string, unknown>): "completed" | "failed" | "blocked" | "unknown" {
  const itemType = stringValue(item.type);
  const status = stringValue(item.status)?.toLowerCase();
  const exitCode = numberValue(item.exitCode);
  if (status === "failed" || status === "error" || status === "cancelled" || status === "canceled") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "completed" || status === "complete" || status === "success" || status === "succeeded") return "completed";
  if (typeof exitCode === "number") return exitCode === 0 ? "completed" : "failed";
  if (itemType === "webSearch" || itemType === "mcpToolCall") return "completed";
  return "unknown";
}

function truncateToolName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`;
}

function isoFromMilliseconds(milliseconds: number | undefined): string | undefined {
  return milliseconds ? new Date(milliseconds).toISOString() : undefined;
}

function runningStartedAt(status: AppServerSessionRecord["status"]): string | undefined {
  return "startedAt" in status ? status.startedAt : undefined;
}
