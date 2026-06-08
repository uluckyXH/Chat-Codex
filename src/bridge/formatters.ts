import type { ApprovalDecision, PendingApproval } from "../approvals/types.js";
import type { CodexRunPolicy, CodexRunPolicyStatus } from "../codex/codex-cli.js";
import { truncateDisplayText } from "../codex/codex-cli.js";
import type {
  CodexCollaborationMode,
  CodexGoal,
  CodexGoalStatus,
  CodexModelOption,
  CodexModelPolicy,
  CodexPromptInput,
  CodexReasoningEffort,
  CodexSessionContextUsage,
  CodexSessionModelInfo,
  CodexSessionStatus,
  CodexTurnInput,
} from "../codex/types.js";
import { CODEX_REASONING_EFFORTS } from "../codex/types.js";
import { codexInputText, normalizeCodexInput, withCodexInputText } from "../codex/input.js";
import type { ChannelMessage } from "../protocol/channel.js";
import { formatLocalDateTimeWithZone, type DisplayTimeOptions } from "../time/display-time.js";
import { BRIDGE_SEND_FILE_PREFIX } from "./media-extractor.js";
import type { InitialRouteBinding, ProgressDeliveryMode, QueuedSteer, SessionChoice } from "./bridge-types.js";
import { SEND_FILE_MAX_FILES } from "./bridge-types.js";

export function truncateForChannel(text: string, maxLength = 600): string {
  const normalized = text.trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

export function isSteerableStatus(status: CodexSessionStatus["type"]): boolean {
  return status === "running" || status === "waiting_approval" || status === "waiting_input";
}

export function composeSteerBatchInput(batch: QueuedSteer[]): CodexTurnInput {
  if (batch.length === 1) return normalizeCodexInput(batch[0].input);
  const groupBatch = batch.every((item) => item.message.conversation.kind === "group");
  const items: CodexTurnInput["items"] = [];
  const textParts: string[] = [];
  batch.forEach((item, index) => {
    const input = normalizeCodexInput(item.input);
    const label = `用户补充消息 ${index + 1}:`;
    const text = groupBatch ? input.text : input.text ? `${label}\n${input.text}` : label;
    if (!text) return;
    textParts.push(text);
    items.push({ type: "text", text });
    for (const inputItem of input.items) {
      if (inputItem.type !== "text") items.push({ ...inputItem });
    }
  });
  return {
    text: textParts.join("\n\n"),
    items,
  };
}

export type GroupPromptPrefixMode = "say" | "supplement";

export function withGroupConversationPromptPrefix(
  message: ChannelMessage,
  input: CodexPromptInput,
  mode: GroupPromptPrefixMode,
): CodexPromptInput {
  if (message.conversation.kind !== "group") return input;
  const text = codexInputText(input).trim();
  if (!text) return input;
  const verb = mode === "supplement" ? "补充" : "说";
  const nextText = `${formatGroupSpeakerForPrompt(message)}${verb}：${text}`;
  return typeof input === "string" ? nextText : withCodexInputText(input, nextText);
}

function formatGroupSpeakerForPrompt(message: ChannelMessage): string {
  return normalizeGroupSpeakerLabel(message.sender.displayName)
    ?? normalizeGroupSpeakerLabel(message.sender.id)
    ?? "群成员";
}

function normalizeGroupSpeakerLabel(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

export function steerAcceptedText(count: number): string {
  if (count === 1) {
    return "已投递到当前 Codex 任务，会在下一次工具调用或模型继续推理时生效。";
  }
  return `已投递 ${count} 条补充消息到当前 Codex 任务，会在下一次工具调用或模型继续推理时生效。`;
}

export function inboundAttachmentTranscriptText(count: number): string {
  return count > 0 ? `[收到 ${count} 个附件]` : "[收到附件]";
}

export function ownerConflictError(sessionId: string, ownerRouteKey: string): Error {
  return new Error(`Codex session ${sessionId} is already owned by ${ownerRouteKey}`);
}

export function ownerConflictText(sessionId: string, ownerRouteKey: string): string {
  return [
    "无法绑定 Codex 会话",
    `Session: ${sessionId}`,
    "原因: 该 session 已绑定到其他聊天上下文。",
    `Owner: ${ownerRouteKey}`,
    "",
    "可发送 /new 创建当前上下文的新会话。",
  ].join("\n");
}

export function formatUnboundSessionForStatus(pending?: InitialRouteBinding): string {
  if (!pending) return "未绑定";
  if (pending.type === "existing") {
    return `待绑定首个私聊预设 \`${pending.sessionId}\`（发送普通消息后生效）`;
  }
  return "待创建首个私聊新 session（发送普通消息后生效）";
}

export function parseSessionChoiceIndex(value: string): number | undefined {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return undefined;
  const index = Number(normalized);
  return Number.isSafeInteger(index) && index > 0 ? index : undefined;
}

export function isCancelSessionSelectionText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "取消" || normalized === "退出" || normalized === "cancel" || normalized === "q" || normalized === "quit";
}

export function isRouteBusyMutationCommand(name: string, args: string[], rawText: string): boolean {
  switch (name) {
    case "new":
    case "use":
    case "resume":
    case "plan":
    case "code":
    case "default":
    case "compact":
      return true;
    case "context-refresh":
    case "ctx-refresh":
    case "context":
    case "ctx":
      return args.length > 0;
    case "permission":
    case "permissions":
    case "perm":
    case "policy":
      return args.length > 0;
    case "model":
      return isModelMutationCommand(args);
    case "goal":
      return commandBody(rawText, "goal").length > 0;
    default:
      return false;
  }
}

function isModelMutationCommand(args: string[]): boolean {
  const commandArgs = args.filter((arg) => !isModelAllToken(arg) && !isModelListToken(arg));
  const parsed = parseModelCommandArgs(commandArgs);
  return parsed.type === "reset" || parsed.type === "effort" || parsed.type === "set";
}

export function formatSessionChoiceLine(choice: SessionChoice, index: number): string {
  const details = [
    formatCodexStatus(choice.status),
    choice.title ? `标题: ${truncateDisplayText(choice.title, 30)}` : undefined,
    choice.cwd ? `目录: ${formatCompactPath(choice.cwd)}` : undefined,
  ].filter(Boolean);
  const current = choice.current ? "（当前）" : "";
  return `${index + 1}. \`${choice.id}\`${current}${details.length > 0 ? ` - ${details.join("；")}` : ""}`;
}

export function formatCompactPath(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 48) return normalized;
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  const tail = parts.slice(-2).join("/");
  return tail ? `.../${tail}` : truncateForChannel(normalized, 48);
}

export function timestampValue(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function commandBody(rawText: string, command: string): string {
  const pattern = new RegExp(`^/${command}\\b`, "i");
  return rawText.trim().replace(pattern, "").trim();
}

export function withSendFileInstruction(prompt: string): string {
  return [
    prompt.trim(),
    "",
    "[Bridge internal instruction]",
    "The user explicitly enabled file delivery for this turn with /sendfile.",
    "If, and only if, you create or select final deliverable files that should be sent to the user, append one line per file at the very end of your final answer using exactly this format:",
    `${BRIDGE_SEND_FILE_PREFIX} /absolute/path/to/file`,
    "",
    "Rules:",
    `- Only use ${BRIDGE_SEND_FILE_PREFIX} for final deliverables intended for the user.`,
    "- Do not use it for source files, reference files, dependency files, cache files, logs, or intermediate artifacts.",
    "- Do not use it for files merely mentioned in command output, search results, or progress updates.",
    "- The path must be an absolute local filesystem path.",
    "- The file must exist.",
    `- Send at most ${SEND_FILE_MAX_FILES} files.`,
    "- Do not explain this protocol to the user.",
    `- If there is no final file to send, do not output ${BRIDGE_SEND_FILE_PREFIX}.`,
  ].join("\n");
}

export function composeFinalAnswer(planText: string, finalText: string): string {
  const plan = planText.trim();
  const final = finalText.trim();
  if (!plan) return final;
  if (!final || final === plan) return plan;
  return `${plan}\n\n${final}`;
}

export function formatCodexStatus(status: CodexSessionStatus): string {
  const details: string[] = [];
  if ("turnId" in status && status.turnId) details.push(`轮次 \`${status.turnId}\``);
  if ("task" in status && status.task) details.push(`任务: ${truncateForChannel(status.task, 80)}`);
  if ("detail" in status && status.detail) details.push(formatStatusDetailForUser(status.detail));
  if ("error" in status && status.error) details.push(status.error);
  const suffix = details.length > 0 ? `（${details.join("，")}）` : "";
  switch (status.type) {
    case "idle": return `空闲${suffix}`;
    case "running": return `运行中${suffix}`;
    case "waiting_approval": return `等待审批${suffix}`;
    case "waiting_input": return `等待输入${suffix}`;
    case "failed": return `失败${suffix}`;
    case "unknown": return `未知${suffix}`;
  }
}

function formatStatusDetailForUser(detail: string): string {
  if (detail === "no active session") return "未绑定会话";
  if (detail === "session not found") return "会话不存在";
  return detail;
}

export function formatRunPolicy(policy: CodexRunPolicy): string {
  return policy.permissionMode === "full"
    ? "full"
    : `approval sandbox=${policy.sandbox ?? "workspace-write"}`;
}

export function formatRunPolicyForStatus(policy: CodexRunPolicy): string {
  return policy.permissionMode === "full"
    ? "完全权限（跳过审批和沙箱）"
    : `审批模式（沙箱 \`${policy.sandbox ?? "workspace-write"}\`）`;
}

export function formatGoalStatusLines(goal: CodexGoal | null | undefined): string[] {
  if (goal === undefined) return [];
  if (!goal) return ["- 长期目标 (/goal): 未设置"];
  const budget = goal.tokenBudget !== null && goal.tokenBudget > 0
    ? `\`${formatNumber(goal.tokensUsed)} / ${formatNumber(goal.tokenBudget)}\`（${formatPercent(goal.tokensUsed / goal.tokenBudget)}，剩余 ${formatNumber(Math.max(goal.tokenBudget - goal.tokensUsed, 0))}）`
    : `\`${formatNumber(goal.tokensUsed)}\``;
  return [
    `- 长期目标 (/goal): ${formatGoalStatusForUser(goal.status)} - ${truncateForChannel(goal.objective, 80)}`,
    `- 目标 token: ${budget}`,
    `- 目标耗时: \`${formatDuration(goal.timeUsedSeconds)}\``,
    `- 目标更新时间: \`${formatGoalTimestamp(goal.updatedAt)}\``,
  ];
}

export function formatGoalStatus(status: CodexGoalStatus): string {
  switch (status) {
    case "active": return "active";
    case "paused": return "paused";
    case "budgetLimited": return "budget-limited";
    case "complete": return "complete";
  }
}

function formatGoalStatusForUser(status: CodexGoalStatus): string {
  switch (status) {
    case "active": return "进行中";
    case "paused": return "已暂停";
    case "budgetLimited": return "已达预算";
    case "complete": return "已完成";
  }
}

export function formatApprovalSupport(status: CodexRunPolicyStatus): string {
  if (status.interactiveApprovals) {
    return status.effectiveApprovalPolicy ? `支持微信内审批（实际策略 ${status.effectiveApprovalPolicy}）` : "支持微信内审批";
  }
  return status.effectiveApprovalPolicy ? `不支持微信内审批（实际策略 ${status.effectiveApprovalPolicy}）` : "不支持微信内审批";
}

export function formatContextUsageLines(context: CodexSessionContextUsage | undefined): string[] {
  if (!context) return ["- 上下文: 暂无数据"];
  const current = context.last.totalTokens;
  const window = context.modelContextWindow;
  const contextUsage = window && window > 0
    ? `\`${formatNumber(current)} / ${formatNumber(window)} token\`（${formatPercent(current / window)}，剩余 ${formatNumber(Math.max(window - current, 0))}）`
    : `\`${formatNumber(current)} token\``;
  return [
    `- 上下文: ${contextUsage}`,
    `- 最近一轮 token: 输入 \`${formatNumber(context.last.inputTokens)}\`，缓存 \`${formatNumber(context.last.cachedInputTokens)}\`，输出 \`${formatNumber(context.last.outputTokens)}\`，推理输出 \`${formatNumber(context.last.reasoningOutputTokens)}\``,
    `- 本会话累计 token: 总计 \`${formatNumber(context.total.totalTokens)}\`，输入 \`${formatNumber(context.total.inputTokens)}\`，缓存 \`${formatNumber(context.total.cachedInputTokens)}\`，输出 \`${formatNumber(context.total.outputTokens)}\`，推理输出 \`${formatNumber(context.total.reasoningOutputTokens)}\``,
  ];
}

export function formatModelInfo(model: CodexSessionModelInfo | undefined): string {
  if (!model?.model && !model?.provider && !model?.serviceTier && model?.reasoningEffort === undefined) return "`unknown`";
  const parts = [
    model.model ? `\`${model.model}\`` : undefined,
    model.provider ? `provider=\`${model.provider}\`` : undefined,
    model.serviceTier ? `tier=\`${model.serviceTier}\`` : undefined,
    model.reasoningEffort !== undefined ? `effort=\`${model.reasoningEffort ?? "default"}\`` : undefined,
  ].filter(Boolean);
  return parts.join(" ");
}

export function formatModelInfoForStatus(model: CodexSessionModelInfo | undefined): string {
  if (!model?.model && !model?.provider && !model?.serviceTier && model?.reasoningEffort === undefined) return "未知";
  const name = model.model ? `\`${model.model}\`` : "未知模型";
  const details = [
    model.provider ? `服务商 \`${model.provider}\`` : undefined,
    model.serviceTier ? `服务档 \`${model.serviceTier}\`` : undefined,
    model.reasoningEffort !== undefined ? `思考程度 \`${model.reasoningEffort ?? "默认"}\`` : undefined,
  ].filter(Boolean);
  return details.length > 0 ? `${name}（${details.join("，")}）` : name;
}

export type ParsedModelCommand =
  | { type: "list" }
  | { type: "reset" }
  | { type: "effort"; effort: string }
  | { type: "set"; modelRef: string; effort?: string }
  | { type: "error"; message: string };

export function parseModelCommandArgs(args: string[]): ParsedModelCommand {
  if (args.length === 0) return { type: "list" };
  const [first = "", second, third, ...rest] = args;
  if (isModelResetToken(first)) {
    return args.length === 1 ? { type: "reset" } : { type: "error", message: "清除模型覆盖请使用 `/model default`。" };
  }
  if (isEffortKeyword(first)) {
    if (!second) return { type: "error", message: "缺少思考程度。用法: `/model effort high`。" };
    if (third || rest.length > 0) return { type: "error", message: "思考程度命令只接受一个值，例如 `/model effort high`。" };
    return { type: "effort", effort: second };
  }
  const tokens = first.toLowerCase() === "model" && second ? [second, third, ...rest].filter((token): token is string => Boolean(token)) : args;
  const [modelRef, maybeEffortKeyword, maybeEffort, ...extra] = tokens;
  if (!modelRef) return { type: "list" };
  if (maybeEffortKeyword && isEffortKeyword(maybeEffortKeyword)) {
    if (!maybeEffort) return { type: "error", message: "缺少思考程度。用法: `/model <模型> effort high`。" };
    if (extra.length > 0) return { type: "error", message: `未知参数: ${extra.join(" ")}` };
    return { type: "set", modelRef, effort: maybeEffort };
  }
  if (maybeEffortKeyword && extra.length > 0) return { type: "error", message: `未知参数: ${[maybeEffortKeyword, maybeEffort, ...extra].filter(Boolean).join(" ")}` };
  return { type: "set", modelRef, ...(maybeEffortKeyword ? { effort: maybeEffortKeyword } : {}) };
}

export function isModelAllToken(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "all" || normalized === "--all" || normalized === "hidden" || normalized === "--hidden";
}

export function isModelListToken(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "list" || normalized === "ls" || normalized === "show";
}

function isModelResetToken(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "default" || normalized === "reset" || normalized === "clear";
}

function isEffortKeyword(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "effort" || normalized === "thinking" || normalized === "reasoning";
}

export function parseReasoningEffort(value: string): CodexReasoningEffort | undefined {
  const normalized = value.trim().toLowerCase();
  return (CODEX_REASONING_EFFORTS as readonly string[]).includes(normalized)
    ? normalized as CodexReasoningEffort
    : undefined;
}

export function invalidReasoningEffortText(value: string): string {
  return `未知思考程度: \`${value}\`\n可用值: ${CODEX_REASONING_EFFORTS.map((effort) => `\`${effort}\``).join(", ")}。`;
}

export function modelSupportsEffort(model: CodexModelOption, effort: CodexReasoningEffort): boolean {
  const supported = supportedEfforts(model);
  return supported.length === 0 || supported.includes(effort);
}

function supportedEfforts(model: CodexModelOption): CodexReasoningEffort[] {
  const efforts = model.supportedReasoningEfforts.map((option) => option.reasoningEffort);
  if (model.defaultReasoningEffort && !efforts.includes(model.defaultReasoningEffort)) efforts.push(model.defaultReasoningEffort);
  return efforts;
}

export function unsupportedReasoningEffortText(model: CodexModelOption, effort: CodexReasoningEffort): string {
  const supported = supportedEfforts(model);
  return [
    `模型 \`${model.model}\` 不支持思考程度 \`${effort}\`。`,
    `可用值: ${supported.length > 0 ? supported.map((value) => `\`${value}\``).join(", ") : "`default`"}。`,
  ].join("\n");
}

export function resolveModelReference(
  reference: string,
  models: CodexModelOption[],
): { type: "ok"; model: CodexModelOption } | { type: "error"; message: string } {
  const index = Number(reference);
  if (Number.isInteger(index) && index >= 1 && index <= models.length) {
    return { type: "ok", model: models[index - 1] };
  }
  const normalized = normalizeModelReference(reference);
  const exact = models.filter((model) => [
    model.id,
    model.model,
    model.displayName,
  ].some((value) => normalizeModelReference(value) === normalized));
  if (exact.length > 0) return { type: "ok", model: exact[0] };
  const candidates = models.filter((model) => [
    model.id,
    model.model,
    model.displayName,
  ].some((value) => normalizeModelReference(value).includes(normalized)));
  return {
    type: "error",
    message: [
      `未找到模型: \`${reference}\``,
      candidates.length > 0 ? `相近模型: ${candidates.slice(0, 6).map(formatModelCandidate).join(", ")}` : undefined,
      "发送 `/model` 查看当前可用模型；如需隐藏模型，发送 `/model all`。",
    ].filter(Boolean).join("\n"),
  };
}

export function currentModelOption(
  models: CodexModelOption[],
  policy: CodexModelPolicy,
  currentModel: CodexSessionModelInfo | undefined,
): CodexModelOption | undefined {
  const reference = policy.model ?? currentModel?.model;
  if (reference) {
    const resolved = resolveModelReference(reference, models);
    if (resolved.type === "ok") return resolved.model;
    return undefined;
  }
  return models.find((model) => model.isDefault) ?? models[0];
}

export function formatModelOptionLine(model: CodexModelOption, index: number): string {
  const badges = [
    model.isDefault ? "default" : undefined,
    model.hidden ? "hidden" : undefined,
  ].filter(Boolean).join(", ");
  const id = model.id !== model.model ? ` id=\`${model.id}\`` : "";
  const efforts = supportedEfforts(model).map((effort) => `\`${effort}\``).join(", ") || "`default`";
  const defaultEffort = model.defaultReasoningEffort ? ` default=\`${model.defaultReasoningEffort}\`` : "";
  const suffix = badges ? ` (${badges})` : "";
  return `${index + 1}. \`${model.model}\`${id}${suffix} - ${model.displayName}; efforts: ${efforts}${defaultEffort}`;
}

function formatModelCandidate(model: CodexModelOption): string {
  return model.id === model.model ? `\`${model.model}\`` : `\`${model.model}\`/\`${model.id}\``;
}

export function formatModelPolicy(policy: CodexModelPolicy): string {
  const parts = [
    policy.model ? `model=\`${policy.model}\`` : undefined,
    policy.reasoningEffort ? `effort=\`${policy.reasoningEffort}\`` : undefined,
    policy.serviceTier ? `tier=\`${policy.serviceTier}\`` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "`none`";
}

export function formatModelPolicyForStatus(policy: CodexModelPolicy): string {
  const parts = [
    policy.model ? `模型 \`${policy.model}\`` : undefined,
    policy.reasoningEffort ? `思考程度 \`${policy.reasoningEffort}\`` : undefined,
    policy.serviceTier ? `服务档 \`${policy.serviceTier}\`` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("，") : "无";
}

export function formatCollaborationModeForStatus(mode: CodexCollaborationMode): string {
  return mode === "plan" ? "计划模式" : "默认执行模式";
}

export function formatProgressModeForStatus(mode: ProgressDeliveryMode): string {
  switch (mode) {
    case "brief": return "摘要模式";
    case "detailed": return "详细模式";
    case "tools": return "工具模式";
    case "silent": return "静默模式";
  }
}

export function formatProgressLabelForStatus(label: string): string {
  switch (label) {
    case "disabled": return "已禁用";
    case "brief": return "摘要模式";
    case "detailed": return "详细模式";
    case "tools": return "工具模式";
    case "silent": return "静默模式";
    default: return `\`${label}\``;
  }
}

export function formatChannelStateForStatus(state: string): string {
  switch (state) {
    case "stopped": return "已停止";
    case "starting": return "启动中";
    case "login_required": return "需要登录";
    case "connected": return "已连接";
    case "degraded": return "部分可用";
    case "failed": return "失败";
    default: return state;
  }
}

export function formatModelScope(sessionId?: string): string {
  return sessionId ? `当前会话 \`${sessionId}\`` : "默认策略（后续新会话）";
}

function normalizeModelReference(value: string): string {
  return value.trim().toLowerCase();
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatDuration(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const rest = wholeSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${rest}s`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

export function formatGoalTimestamp(seconds: number, options: DisplayTimeOptions = {}): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "未知";
  const formatted = formatLocalDateTimeWithZone(seconds, options);
  return formatted;
}

export function goalErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/feature|experimental|features\.goals|not enabled|disabled|unknown method/i.test(message)) {
    return [
      "Goal 实验功能不可用或未启用。",
      "请先在 Codex 中启用 features.goals，例如在 Codex CLI 使用 /experimental，或在 config.toml 的 [features] 下设置 goals = true，然后重启 bridge。",
      `原始错误: ${message}`,
    ].join("\n");
  }
  return message;
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatConversationContext(kind: string, id: string, displayName?: string): string {
  return displayName ? `${kind}:${id} (${displayName})` : `${kind}:${id}`;
}

export function formatPeerContext(id: string, displayName?: string): string {
  return displayName ? `${displayName} (${id})` : id;
}

export function isConfirmed(args: string[]): boolean {
  const normalized = args.join(" ").trim().toLowerCase();
  return normalized === "confirm" || normalized === "yes" || normalized === "确认" || normalized === "我确认";
}

export function formatApprovalDecision(decision: ApprovalDecision): string {
  if (decision === "approve") return "已通过";
  if (decision === "approve-session") return "已按本会话通过";
  if (decision === "deny") return "已拒绝";
  return "已取消";
}

export function formatPendingApprovalStatus(approval: PendingApproval | undefined): Array<string | undefined> {
  if (!approval) return [];
  return [
    "",
    "**待处理审批**",
    `- 类型: ${formatApprovalKindForUser(approval.kind)}`,
    approval.cwd ? `- 工作目录: \`${approval.cwd}\`` : undefined,
    approval.reason ? `- 原因: ${approval.reason}` : undefined,
    approval.command ? "```shell\n" + approval.command + "\n```" : undefined,
    "快捷回复：",
    "```text\n/OK\n```",
    "```text\n/P\n```",
    "```text\n/NO\n```",
  ];
}

export function formatApprovalKindForUser(kind: string): string {
  switch (kind) {
    case "command": return "命令执行";
    case "file_change": return "文件变更";
    case "permissions": return "权限变更";
    case "network": return "网络访问";
    case "legacy_exec": return "旧版命令审批";
    case "legacy_patch": return "旧版补丁审批";
    default: return kind;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function parseProgressDeliveryMode(value: string): ProgressDeliveryMode | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "brief" || normalized === "normal") return "brief";
  if (normalized === "detailed" || normalized === "verbose" || normalized === "debug") return "detailed";
  if (normalized === "tools" || normalized === "tool") return "tools";
  if (normalized === "silent" || normalized === "quiet" || normalized === "off" || normalized === "none") return "silent";
  return undefined;
}
