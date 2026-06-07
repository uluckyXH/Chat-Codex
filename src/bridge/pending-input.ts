import type {
  CodexAdapter,
  CodexUserInputQuestion,
  CodexUserInputRequest,
  CodexUserInputResponse,
} from "../codex/types.js";
import type { ChannelMessage, ChannelTarget } from "../protocol/channel.js";
import type { BridgeDelivery } from "./delivery.js";

export interface BridgePendingInputOptions {
  codex: CodexAdapter;
  delivery: BridgeDelivery;
  timeoutMs?: number;
}

export interface StartPendingInputOptions {
  routeKey: string;
  target: ChannelTarget;
  message: ChannelMessage;
  request: CodexUserInputRequest;
}

export interface HandlePendingInputMessageOptions {
  message: ChannelMessage;
  target: ChannelTarget;
  rawText: string;
  commandName?: string;
}

interface PendingInputState {
  routeKey: string;
  target: ChannelTarget;
  request: CodexUserInputRequest;
  currentQuestionIndex: number;
  answers: CodexUserInputResponse["answers"];
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
  resolving: boolean;
}

interface RecentlyResolvedInput {
  expiresAt: number;
}

interface QueuedPendingInput {
  target: ChannelTarget;
  message: ChannelMessage;
  request: CodexUserInputRequest;
}

interface AnswerCommand {
  value: number;
  note: string;
  invalidMulti: boolean;
}

interface AnswerChoice {
  displayLabel: string;
  answerLabel: string;
  description?: string;
  freeform: boolean;
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const MAX_ANSWER_OPTIONS = 9;
const OTHER_OPTION_LABEL = "None of the above";
const RECENTLY_RESOLVED_TTL_MS = 60_000;

export class BridgePendingInputManager {
  private readonly codex: CodexAdapter;
  private readonly delivery: BridgeDelivery;
  private readonly timeoutMs: number;
  private readonly pendingByRoute = new Map<string, PendingInputState>();
  private readonly queuedByRoute = new Map<string, QueuedPendingInput[]>();
  private readonly recentlyResolvedByRoute = new Map<string, RecentlyResolvedInput>();

  constructor(options: BridgePendingInputOptions) {
    this.codex = options.codex;
    this.delivery = options.delivery;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  has(routeKey: string): boolean {
    return this.pendingByRoute.has(routeKey);
  }

  async start(input: StartPendingInputOptions): Promise<void> {
    if (!this.codex.resolveUserInput) {
      await this.delivery.sendText(input.target, "当前 Codex 接入不支持这类中途选择，本次选择无法处理。");
      return;
    }
    const existing = this.pendingByRoute.get(input.routeKey);
    if (existing) {
      if (existing.request.sessionId === input.request.sessionId && existing.request.turnId === input.request.turnId) {
        const queued = this.queuedByRoute.get(input.routeKey) ?? [];
        queued.push({ target: input.target, message: input.message, request: input.request });
        this.queuedByRoute.set(input.routeKey, queued);
        return;
      }
      await this.resolveAsUnanswered(input.request);
      await this.delivery.sendText(input.target, "Codex 发起了另一个并发输入请求，Chat-Codex 已按未回答处理后来的请求。");
      return;
    }
    if (mcpApprovalCompatibilityRequest(input.request)) {
      await this.resolveAsUnanswered(input.request);
      await this.delivery.sendText(input.target, [
        "Codex 请求 MCP/app tool 授权确认。",
        "Chat-Codex 当前不支持 MCP/app tool 授权；本次请求已按未回答处理，不会授权外部工具。",
      ].join("\n"));
      return;
    }
    if (input.request.questions.some((question) => question.isSecret)) {
      await this.resolveAsUnanswered(input.request);
      await this.delivery.sendText(input.target, [
        "Codex 请求保密输入，但聊天渠道不适合传递 secret。",
        "Chat-Codex 已按未回答处理这次输入请求。请在本机 Codex 中完成需要 secret 的操作。",
      ].join("\n"));
      return;
    }
    if (input.request.questions.some((question) => answerChoices(question).length > MAX_ANSWER_OPTIONS)) {
      await this.resolveAsUnanswered(input.request);
      await this.delivery.sendText(input.target, `Codex 输入请求包含超过 ${MAX_ANSWER_OPTIONS} 个选项，Chat-Codex 当前无法安全展示；本次请求已按未回答处理。`);
      return;
    }
    const state: PendingInputState = {
      routeKey: input.routeKey,
      target: input.target,
      request: input.request,
      currentQuestionIndex: 0,
      answers: {},
      expiresAt: Date.now() + this.timeoutMs,
      resolving: false,
    };
    state.timer = setTimeout(() => {
      void this.timeoutRoute(input.routeKey, input.request.adapterRequestId);
    }, this.timeoutMs);
    state.timer.unref?.();
    this.pendingByRoute.set(input.routeKey, state);
    await this.delivery.sendText(input.target, formatQuestionPrompt(state));
  }

  async handleMessage(input: HandlePendingInputMessageOptions): Promise<boolean> {
    const command = parseAnswerCommand(input.commandName, input.rawText);
    const pending = this.pendingByRoute.get(input.message.routeKey);
    if (!pending) {
      if (command) {
        await this.delivery.sendText(input.target, this.recentlyResolved(input.message.routeKey)
          ? "这个 Codex 输入请求已处理，当前回复已失效。"
          : "当前没有等待回答的 Codex 问题。");
        return true;
      }
      return false;
    }
    if (input.commandName === "stop") return false;
    if (!command) {
      if (input.commandName) return false;
      await this.delivery.sendText(input.target, "Codex 正在等待你的选择。请按上一条提示回复 /a1、/a2，或 /a0 跳过这个问题；如需停止整个任务，请回复 /stop。");
      return true;
    }
    if (pending.resolving) {
      await this.delivery.sendText(input.target, "当前 Codex 输入请求正在提交，请稍候。");
      return true;
    }
    if (command.invalidMulti) {
      await this.delivery.sendText(input.target, "当前不支持多选。请只回复一个选项，例如 /a1，或使用 /a0 跳过这个问题。");
      return true;
    }
    await this.applyAnswer(pending, command);
    return true;
  }

  async handleResolved(routeKey: string, requestId: string): Promise<void> {
    const pending = this.pendingByRoute.get(routeKey);
    if (pending?.request.adapterRequestId === requestId) {
      this.clearPending(pending);
      await this.delivery.sendText(pending.target, "Codex 已在 app-server 侧解决该输入请求。");
      await this.startNextQueued(routeKey);
      return;
    }
    const queued = this.queuedByRoute.get(routeKey);
    if (!queued) return;
    const next = queued.filter((item) => item.request.adapterRequestId !== requestId);
    if (next.length === 0) {
      this.queuedByRoute.delete(routeKey);
    } else if (next.length !== queued.length) {
      this.queuedByRoute.set(routeKey, next);
    }
  }

  clearRoute(routeKey: string): number {
    let cleared = 0;
    const pending = this.pendingByRoute.get(routeKey);
    if (pending) {
      this.clearPending(pending);
      cleared += 1;
    }
    const queued = this.queuedByRoute.get(routeKey);
    if (queued) {
      cleared += queued.length;
      this.queuedByRoute.delete(routeKey);
    }
    this.recentlyResolvedByRoute.delete(routeKey);
    return cleared;
  }

  clearAll(): void {
    for (const pending of this.pendingByRoute.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    this.pendingByRoute.clear();
    this.queuedByRoute.clear();
    this.recentlyResolvedByRoute.clear();
  }

  private async applyAnswer(pending: PendingInputState, command: AnswerCommand): Promise<void> {
    const question = pending.request.questions[pending.currentQuestionIndex];
    if (!question) {
      await this.complete(pending);
      return;
    }
    if (command.value === 0) {
      pending.answers[question.id] = { answers: [] };
      await this.advanceOrComplete(pending);
      return;
    }
    const choices = answerChoices(question);
    if (choices.length === 0) {
      if (command.value !== 1) {
        await this.delivery.sendText(pending.target, "这个问题没有预设选项。请回复 /a1 你的回答，或 /a0 跳过这个问题。");
        return;
      }
      const note = command.note.trim();
      if (!note) {
        await this.delivery.sendText(pending.target, "这个问题需要文字说明。请回复 /a1 你的回答，或 /a0 跳过这个问题。");
        return;
      }
      pending.answers[question.id] = { answers: [`user_note: ${note}`] };
      await this.advanceOrComplete(pending);
      return;
    }
    const selected = choices[command.value - 1];
    if (!selected) {
      await this.delivery.sendText(pending.target, `没有 /a${command.value} 这个选项。请按上一条提示回复，或使用 /a0 跳过这个问题。`);
      return;
    }
    const answerList = [selected.answerLabel];
    const note = command.note.trim();
    if (note) answerList.push(`user_note: ${note}`);
    pending.answers[question.id] = { answers: answerList };
    await this.advanceOrComplete(pending);
  }

  private async advanceOrComplete(pending: PendingInputState): Promise<void> {
    if (pending.currentQuestionIndex + 1 < pending.request.questions.length) {
      pending.currentQuestionIndex += 1;
      await this.delivery.sendText(pending.target, formatQuestionPrompt(pending));
      return;
    }
    await this.complete(pending);
  }

  private async complete(pending: PendingInputState): Promise<void> {
    pending.resolving = true;
    const routeKey = pending.routeKey;
    const response = responseWithEmptyAnswers(pending.request, pending.answers);
    await this.codex.resolveUserInput?.(pending.request.adapterRequestId, response);
    this.clearPending(pending);
    this.markRecentlyResolved(routeKey);
    await this.delivery.sendText(pending.target, "已提交 Codex 输入。");
    await this.startNextQueued(routeKey);
  }

  private async timeoutRoute(routeKey: string, requestId: string): Promise<void> {
    const pending = this.pendingByRoute.get(routeKey);
    if (!pending || pending.request.adapterRequestId !== requestId) return;
    const response = responseWithEmptyAnswers(pending.request, pending.answers);
    this.clearPending(pending);
    this.markRecentlyResolved(routeKey);
    await this.codex.resolveUserInput?.(pending.request.adapterRequestId, response);
    await this.delivery.sendText(pending.target, [
      "Codex 等待选择已超时，Chat-Codex 已按“未回答”处理。",
      "不会默认选择推荐项；Codex 会自己决定下一步。",
    ].join("\n"));
    await this.startNextQueued(routeKey);
  }

  private async startNextQueued(routeKey: string): Promise<void> {
    const queued = this.queuedByRoute.get(routeKey);
    const next = queued?.shift();
    if (!queued || !next) {
      this.queuedByRoute.delete(routeKey);
      return;
    }
    if (queued.length === 0) this.queuedByRoute.delete(routeKey);
    await this.start({
      routeKey,
      target: next.target,
      message: next.message,
      request: next.request,
    });
  }

  private async resolveAsUnanswered(request: CodexUserInputRequest): Promise<void> {
    await this.codex.resolveUserInput?.(request.adapterRequestId, responseWithEmptyAnswers(request, {}));
  }

  private clearPending(pending: PendingInputState): void {
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingByRoute.delete(pending.routeKey);
  }

  private markRecentlyResolved(routeKey: string): void {
    this.recentlyResolvedByRoute.set(routeKey, { expiresAt: Date.now() + RECENTLY_RESOLVED_TTL_MS });
  }

  private recentlyResolved(routeKey: string): boolean {
    const resolved = this.recentlyResolvedByRoute.get(routeKey);
    if (!resolved) return false;
    if (resolved.expiresAt > Date.now()) return true;
    this.recentlyResolvedByRoute.delete(routeKey);
    return false;
  }
}

function parseAnswerCommand(commandName: string | undefined, rawText: string): AnswerCommand | undefined {
  const text = rawText.trim();
  const match = text.match(/^\/a(\d+)(.*)$/i);
  if (!match) {
    if (commandName && /^a\d/i.test(commandName)) return { value: -1, note: "", invalidMulti: true };
    return undefined;
  }
  const value = Number.parseInt(match[1] ?? "", 10);
  const trailing = (match[2] ?? "").trim();
  const invalidMulti = !Number.isInteger(value)
    || value < 0
    || trailing.startsWith(",")
    || trailing.startsWith("，")
    || /^\d+(?:\s|,|，|$)/.test(trailing);
  return {
    value,
    note: trailing,
    invalidMulti,
  };
}

function answerChoices(question: CodexUserInputQuestion): AnswerChoice[] {
  const choices = question.options.map((option) => ({
    displayLabel: option.label,
    answerLabel: option.label,
    ...(option.description ? { description: option.description } : {}),
    freeform: otherLikeOption(option.label),
  }));
  if (question.isOther && question.options.length > 0 && !choices.some((choice) => choice.freeform)) {
    choices.push({
      displayLabel: "其他",
      answerLabel: OTHER_OPTION_LABEL,
      description: "可以写自己的建议。",
      freeform: true,
    });
  }
  return choices;
}

function responseWithEmptyAnswers(
  request: CodexUserInputRequest,
  answers: CodexUserInputResponse["answers"],
): CodexUserInputResponse {
  return {
    answers: Object.fromEntries(
      request.questions.map((question) => [
        question.id,
        answers[question.id] ?? { answers: [] },
      ]),
    ),
  };
}

function formatQuestionPrompt(pending: PendingInputState): string {
  const question = pending.request.questions[pending.currentQuestionIndex];
  if (!question) return "Codex 需要你确认后继续，但问题内容为空。请回复 /a0 跳过，或 /stop 停止整个任务。";
  const questionCount = pending.request.questions.length;
  const choices = answerChoices(question);
  const lines = [
    "Codex 暂停了当前任务，需要你确认后继续。",
    "",
  ];
  if (pending.target.conversation.kind === "group") {
    lines.push(
      "群聊中成员先回复者生效；飞书群聊请 @机器人 回复命令。",
      "",
    );
  }
  lines.push(
    `问题 ${pending.currentQuestionIndex + 1}/${questionCount}${question.header ? `：${question.header}` : ""}`,
    question.question,
    "",
  );
  if (choices.length > 0) {
    lines.push("直接回复下面一条命令：", "");
    for (const [index, choice] of choices.entries()) {
      const command = `/a${index + 1}`;
      lines.push(choice.freeform ? `${command} ${choice.displayLabel}：你的建议` : `${command} ${choice.displayLabel}`);
      if (choice.description) lines.push(choice.description);
      lines.push("");
    }
    lines.push("需要补充原因时，在命令后追加文字，例如 /a2 你的说明。", "");
  } else {
    lines.push(
      "这个问题没有预设选项。",
      "请回复 /a1 你的回答。",
      "",
    );
  }
  lines.push(
    "/a0 跳过这个问题",
    "不会默认选择推荐项，Codex 会自己决定下一步。",
    "",
    `${formatTimeout(pending.expiresAt - Date.now())}内未回复会按 /a0 处理。`,
    "要停止整个任务，请回复 /stop。",
  );
  return lines.join("\n");
}

function formatTimeout(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} 分钟`;
}

function otherLikeOption(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return normalized === "none of the above"
    || normalized === "other"
    || normalized.includes("其他")
    || normalized.includes("其它")
    || normalized.includes("自定义")
    || normalized.includes("补充说明")
    || normalized.includes("补充建议")
    || normalized.includes("other suggestion");
}

function mcpApprovalCompatibilityRequest(request: CodexUserInputRequest): boolean {
  return request.questions.some((question) => {
    const id = question.id.toLowerCase();
    const header = (question.header ?? "").toLowerCase();
    const prompt = question.question.toLowerCase();
    const text = `${id} ${header} ${prompt}`;
    const labels = question.options.map((option) => option.label.toLowerCase());
    const approvalLabels = labels.some((label) => label === "allow" || label.includes("allow for this session") || label.includes("don't ask me again"))
      && labels.some((label) => label === "cancel");
    const appToolContext = text.includes("mcp")
      || text.includes("app tool")
      || text.includes("tool call")
      || text.includes("tool approval");
    return id.startsWith("mcp_tool_call_approval_")
      || header.includes("approve app tool call")
      || (approvalLabels && appToolContext);
  });
}
