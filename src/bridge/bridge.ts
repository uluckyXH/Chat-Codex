import type { ApprovalDecision } from "../approvals/types.js";
import { ApprovalManager } from "../approvals/approval-manager.js";
import type { CodexRunPolicy, CodexRunPolicyStatus } from "../codex/codex-cli.js";
import type { CodexAdapter, CodexProgressKind, CodexSession, CodexSessionContextUsage, CodexSessionStatus } from "../codex/types.js";
import { parseCommand } from "../commands/parser.js";
import type { Logger } from "../logging/logger.js";
import { SilentLogger } from "../logging/logger.js";
import type { TranscriptSink } from "../logging/transcript.js";
import type { ChannelAdapter, ChannelMedia, ChannelMessage, ChannelTarget } from "../protocol/channel.js";
import { replyTargetFromMessage } from "../protocol/channel.js";
import { MemoryStateStore } from "../state/memory-state-store.js";
import { extractMediaRefs } from "./media-extractor.js";

export interface BridgeOptions {
  channel: ChannelAdapter;
  codex: CodexAdapter;
  state?: MemoryStateStore;
  approvals?: ApprovalManager;
  logger?: Logger;
  transcript?: TranscriptSink;
  cwd?: string;
  initialSessionId?: string;
  progressMode?: ProgressDeliveryMode;
}

interface QueuedPrompt {
  message: ChannelMessage;
  target: ChannelTarget;
  prompt: string;
}

export type ProgressDeliveryMode = "brief" | "detailed" | "silent";

export class Bridge {
  private readonly channel: ChannelAdapter;
  private readonly codex: CodexAdapter;
  private readonly state: MemoryStateStore;
  private readonly approvals: ApprovalManager;
  private readonly logger: Logger;
  private readonly transcript?: TranscriptSink;
  private readonly cwd: string;
  private readonly defaultProgressMode: ProgressDeliveryMode;
  private readonly routeProgressModes = new Map<string, ProgressDeliveryMode>();
  private readonly routeQueues = new Map<string, QueuedPrompt[]>();
  private readonly routeWorkers = new Map<string, Promise<void>>();
  private initialSessionId?: string;

  constructor(options: BridgeOptions) {
    this.channel = options.channel;
    this.codex = options.codex;
    this.state = options.state ?? new MemoryStateStore();
    this.approvals = options.approvals ?? new ApprovalManager();
    this.logger = options.logger ?? new SilentLogger();
    this.transcript = options.transcript;
    this.cwd = options.cwd ?? process.cwd();
    this.initialSessionId = options.initialSessionId;
    this.defaultProgressMode = options.progressMode ?? "brief";
  }

  async start(): Promise<void> {
    this.channel.onMessage((message) => this.handleMessage(message));
    await this.channel.start();
    this.logger.info("bridge started", { channel: this.channel.id });
  }

  async stop(): Promise<void> {
    await this.channel.stop();
    await this.codex.stop?.();
    this.logger.info("bridge stopped", { channel: this.channel.id });
  }

  async handleMessage(message: ChannelMessage): Promise<void> {
    const text = message.text?.trim();
    if (!text) return;
    this.transcript?.inbound(message, text);
    const target = replyTargetFromMessage(message);
    const command = parseCommand(text);
    if (command.isCommand) {
      await this.handleCommand(message, target, command.name ?? "", command.args);
      return;
    }
    await this.enqueuePrompt(message, target, text);
  }

  async waitForIdle(): Promise<void> {
    while (this.routeWorkers.size > 0) {
      await Promise.all([...this.routeWorkers.values()]);
    }
  }

  private async handleCommand(
    message: ChannelMessage,
    target: ChannelTarget,
    name: string,
    args: string[],
  ): Promise<void> {
    switch (name) {
      case "help":
        await this.sendText(target, this.helpText());
        return;
      case "new":
        await this.createNewSession(message, target);
        return;
      case "status":
        await this.sendText(target, await this.statusText(message));
        return;
      case "sessions":
        await this.sendText(target, await this.sessionsText(args[0]?.toLowerCase() === "all" ? undefined : message.routeKey));
        return;
      case "all-sessions":
        await this.sendText(target, await this.sessionsText(undefined));
        return;
      case "use":
      case "resume":
        await this.resumeOrUseSession(message, target, args[0]);
        return;
      case "whoami":
        await this.sendText(target, this.whoamiText(message));
        return;
      case "debug":
        await this.sendText(target, await this.debugText(message));
        return;
      case "progress":
      case "mode":
        await this.handleProgressModeCommand(message, target, args[0]);
        return;
      case "permission":
      case "permissions":
      case "perm":
      case "policy":
        await this.handlePermissionCommand(message, target, args);
        return;
      case "ok":
      case "yes":
        await this.resolveApproval(message, target, [], "approve");
        return;
      case "no":
        await this.resolveApproval(message, target, args, "deny");
        return;
      case "approve":
        await this.resolveApproval(message, target, args, "approve");
        return;
      case "approve-session":
        await this.resolveApproval(message, target, args, "approve-session");
        return;
      case "deny":
      case "reject":
        await this.resolveApproval(message, target, args, "deny");
        return;
      case "stop":
        await this.stopCurrentTask(message, target);
        return;
      default:
        await this.sendText(target, `未知命令: /${name}\n发送 /help 查看可用命令。`);
    }
  }

  private async createNewSession(message: ChannelMessage, target: ChannelTarget): Promise<CodexSession> {
    const session = await this.codex.startSession({
      routeKey: message.routeKey,
      cwd: this.cwd,
      title: `channel:${message.routeKey}`,
    });
    this.state.bindSession(message.routeKey, session);
    await this.sendText(target, `已创建新 Codex 会话\nSession: ${session.id}\nCwd: ${session.cwd}\nStatus: idle`);
    return session;
  }

  private async ensureSession(message: ChannelMessage): Promise<CodexSession> {
    const binding = this.state.getBinding(message.routeKey);
    if (binding) {
      const stored = this.state.getSession(binding.sessionId);
      if (stored) return stored.session;
      return this.codex.resumeSession(binding.sessionId);
    }
    if (this.initialSessionId) {
      const sessionId = this.initialSessionId;
      this.initialSessionId = undefined;
      const session = await this.codex.resumeSession(sessionId);
      this.state.bindSession(message.routeKey, session);
      return session;
    }
    const session = await this.codex.startSession({
      routeKey: message.routeKey,
      cwd: this.cwd,
      title: `channel:${message.routeKey}`,
    });
    this.state.bindSession(message.routeKey, session);
    return session;
  }

  private async enqueuePrompt(message: ChannelMessage, target: ChannelTarget, prompt: string): Promise<void> {
    const queue = this.routeQueues.get(message.routeKey) ?? [];
    const pendingAhead = queue.length + (this.routeWorkers.has(message.routeKey) ? 1 : 0);
    queue.push({ message, target, prompt });
    this.routeQueues.set(message.routeKey, queue);
    if (pendingAhead > 0) {
      await this.sendText(target, `已加入队列，前面还有 ${pendingAhead} 条消息。`);
    }
    if (!this.routeWorkers.has(message.routeKey)) {
      this.startRouteWorker(message.routeKey);
    }
  }

  private startRouteWorker(routeKey: string): void {
    const worker = this.drainRouteQueue(routeKey).finally(() => {
      this.routeWorkers.delete(routeKey);
      if ((this.routeQueues.get(routeKey)?.length ?? 0) > 0) {
        this.startRouteWorker(routeKey);
      } else {
        this.routeQueues.delete(routeKey);
      }
    });
    this.routeWorkers.set(routeKey, worker);
  }

  private async drainRouteQueue(routeKey: string): Promise<void> {
    for (;;) {
      const queue = this.routeQueues.get(routeKey);
      const task = queue?.shift();
      if (!task) return;
      try {
        await this.forwardPrompt(task.message, task.target, task.prompt, queue?.length ?? 0);
      } catch (error) {
        await this.sendText(task.target, `Codex 执行失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async forwardPrompt(message: ChannelMessage, target: ChannelTarget, prompt: string, remainingQueued: number): Promise<void> {
    const session = await this.ensureSession(message);
    await this.sendText(target, [
      "Codex 正在处理这条消息。",
      "可发送 /status 查看状态，/stop 终止。",
      remainingQueued > 0 ? `Queue: 后面还有 ${remainingQueued} 条` : undefined,
    ].filter(Boolean).join("\n"));
    await this.withTyping(target, async () => {
      let finalText = "";
      const sentMediaKeys = new Set<string>();
      for await (const event of this.codex.run(session.id, prompt)) {
        if (event.type === "turn.started") {
          this.state.setSessionStatus(session.id, {
            type: "running",
            turnId: event.turnId,
            task: truncateForChannel(prompt, 120),
          });
        } else if (event.type === "assistant.progress") {
          if (this.shouldDeliverProgress(message.routeKey, event.kind)) {
            await this.sendProgressText(target, `Codex 进度:\n${truncateForChannel(event.text)}`);
          }
          await this.sendExtractedMedia(target, event.text, session.cwd, sentMediaKeys);
        } else if (event.type === "assistant.delta") {
          finalText += event.text;
        } else if (event.type === "assistant.completed") {
          finalText = event.text;
        } else if (event.type === "approval.requested") {
          this.state.setSessionStatus(session.id, {
            type: "waiting_approval",
            detail: event.approval.reason ?? event.approval.kind,
          });
          const pending = this.approvals.create(message.routeKey, message.sender.id, event.approval);
          await this.sendText(target, this.approvals.formatForChannel(pending));
        } else if (event.type === "turn.completed") {
          this.state.setSessionStatus(session.id, { type: "idle" });
        } else if (event.type === "turn.failed") {
          this.state.setSessionStatus(session.id, { type: "failed", error: event.error });
          await this.sendText(target, `Codex 执行失败: ${event.error}`);
        }
      }
      if (finalText) {
        await this.sendText(target, finalText);
        await this.sendExtractedMedia(target, finalText, session.cwd, sentMediaKeys);
      }
    });
  }

  private async resumeOrUseSession(
    message: ChannelMessage,
    target: ChannelTarget,
    sessionId: string | undefined,
  ): Promise<void> {
    if (!sessionId) {
      await this.sendText(target, "缺少 Session ID，例如 /resume cdx-123");
      return;
    }
    try {
      const session = await this.codex.resumeSession(sessionId);
      this.state.bindSession(message.routeKey, session);
      await this.sendText(target, `已绑定 Codex 会话\nSession: ${session.id}\nCwd: ${session.cwd}\nStatus: idle`);
    } catch (error) {
      await this.sendText(target, error instanceof Error ? error.message : String(error));
    }
  }

  private async resolveApproval(
    message: ChannelMessage,
    target: ChannelTarget,
    args: string[],
    decision: ApprovalDecision,
  ): Promise<void> {
    const parsed = this.parseApprovalArgs(message.routeKey, args, decision);
    const key = parsed.approvalKey ?? this.approvals.latest(message.routeKey)?.approvalKey;
    if (!key) {
      await this.sendText(target, "当前没有待处理审批。");
      return;
    }
    try {
      const pending = this.approvals.decide(key, message.routeKey, decision, parsed.reason);
      await this.codex.resolveApproval?.(pending.adapterApprovalId ?? pending.approvalKey, decision, parsed.reason);
      await this.sendText(target, [
        `审批已处理: ${formatApprovalDecision(decision)}`,
        parsed.reason ? `理由: ${parsed.reason}` : undefined,
      ].filter(Boolean).join("\n"));
    } catch (error) {
      await this.sendText(target, error instanceof Error ? error.message : String(error));
    }
  }

  private parseApprovalArgs(routeKey: string, args: string[], decision: ApprovalDecision): {
    approvalKey?: string;
    reason?: string;
  } {
    if (args.length === 0) return {};
    const [first = "", ...rest] = args;
    const knownApproval = this.approvals.get(first);
    if (knownApproval?.routeKey === routeKey) {
      return {
        approvalKey: first,
        reason: decision === "deny" ? rest.join(" ").trim() || undefined : undefined,
      };
    }
    if (decision === "deny") {
      return { reason: args.join(" ").trim() || undefined };
    }
    return { approvalKey: first };
  }

  private async stopCurrentTask(message: ChannelMessage, target: ChannelTarget): Promise<void> {
    const binding = this.state.getBinding(message.routeKey);
    if (!binding) {
      await this.sendText(target, "当前没有活跃 Codex 会话。");
      return;
    }
    const status = await this.codex.getStatus(binding.sessionId);
    const workerRunning = this.routeWorkers.has(message.routeKey);
    if (!workerRunning && status.type !== "running" && status.type !== "waiting_approval") {
      await this.sendText(target, "当前没有正在运行的 Codex 任务。");
      return;
    }
    if (!this.codex.cancel) {
      await this.sendText(target, "当前 Codex Adapter 不支持取消。");
      return;
    }
    await this.codex.cancel(binding.sessionId);
    this.approvals.cancelRoute(message.routeKey, "任务已停止");
    this.state.setSessionStatus(binding.sessionId, { type: "idle" });
    await this.sendTyping(target, false);
    await this.sendText(target, "已请求停止当前 Codex 任务。");
  }

  private async handleProgressModeCommand(
    message: ChannelMessage,
    target: ChannelTarget,
    rawMode: string | undefined,
  ): Promise<void> {
    if (!rawMode) {
      await this.sendText(target, this.progressModeText(message.routeKey));
      return;
    }
    const mode = parseProgressDeliveryMode(rawMode);
    if (!mode) {
      await this.sendText(target, "未知进度模式。可用值: brief, detailed, silent。");
      return;
    }
    this.routeProgressModes.set(message.routeKey, mode);
    await this.sendText(target, this.progressModeText(message.routeKey));
  }

  private async handlePermissionCommand(
    message: ChannelMessage,
    target: ChannelTarget,
    args: string[],
  ): Promise<void> {
    if (!this.codex.getRunPolicy || !this.codex.setRunPolicy) {
      await this.sendText(target, "当前 Codex Adapter 不支持运行时切换权限模式。");
      return;
    }
    const rawMode = args[0]?.toLowerCase();
    if (!rawMode) {
      await this.sendText(target, this.permissionText());
      return;
    }
    if (rawMode === "approval" || rawMode === "approve" || rawMode === "safe" || rawMode === "审批") {
      this.codex.setRunPolicy({ permissionMode: "approval", sandbox: "workspace-write" });
      const policyStatus = this.runPolicyStatus();
      await this.sendText(target, [
        "已切换 Codex 权限模式: approval",
        "后续任务将使用 workspace-write sandbox。",
        policyStatus && !policyStatus.interactiveApprovals
          ? "注意：当前 Codex Adapter 不支持交互审批；真实生效的 approval_policy 仍是 never。"
          : "后续审批请求会交给当前 Adapter 处理。",
        policyStatus?.note ? `说明: ${policyStatus.note}` : undefined,
        this.routeWorkers.has(message.routeKey) ? "当前正在运行的任务不会被改写；需要立即生效请先 /stop。" : undefined,
      ].filter(Boolean).join("\n"));
      return;
    }
    if (rawMode === "full" || rawMode === "danger" || rawMode === "完全权限") {
      if (!isConfirmed(args.slice(1))) {
        await this.sendText(target, [
          "完全权限会跳过审批和沙箱，Codex 可以直接执行命令并修改文件，风险很高。",
          "确认切换请发送:",
          "/permission full confirm",
        ].join("\n"));
        return;
      }
      this.codex.setRunPolicy({ permissionMode: "full" });
      await this.sendText(target, [
        "已切换 Codex 权限模式: full",
        "后续任务将跳过审批和沙箱。建议完成高权限任务后发送 /permission approval 切回安全沙箱模式。",
        this.routeWorkers.has(message.routeKey) ? "当前正在运行的任务不会被改写；需要立即生效请先 /stop。" : undefined,
      ].filter(Boolean).join("\n"));
      return;
    }
    await this.sendText(target, "未知权限模式。可用命令: /permission、/permission approval、/permission full confirm。");
  }

  private async sendText(target: ChannelTarget, text: string): Promise<void> {
    await this.channel.sendText(target, text);
    this.transcript?.outbound(target, text);
  }

  private async sendProgressText(target: ChannelTarget, text: string): Promise<void> {
    try {
      await this.sendText(target, text);
    } catch (error) {
      this.logger.warn("progress message send failed", {
        channel: this.channel.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async sendExtractedMedia(
    target: ChannelTarget,
    text: string,
    cwd: string,
    sentMediaKeys: Set<string>,
  ): Promise<void> {
    const mediaItems = extractMediaRefs(text, cwd);
    for (const media of mediaItems) {
      const key = mediaKey(media);
      if (!key || sentMediaKeys.has(key)) continue;
      sentMediaKeys.add(key);
      await this.sendMedia(target, media);
    }
  }

  private async sendMedia(target: ChannelTarget, media: ChannelMedia): Promise<void> {
    const capabilities = this.channel.getCapabilities();
    if (capabilities.media && this.channel.sendMedia) {
      try {
        await this.channel.sendMedia(target, media);
        this.transcript?.outboundMedia?.(target, media);
        return;
      } catch (error) {
        this.logger.warn("channel media send failed, falling back to text", {
          channel: this.channel.id,
          media: media.path ?? media.url ?? media.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.sendText(target, fallbackMediaText(media, capabilities.media));
  }

  private async withTyping<T>(target: ChannelTarget, operation: () => Promise<T>): Promise<T> {
    const capabilities = this.channel.getCapabilities();
    if (!capabilities.typing || !this.channel.sendTyping) {
      return operation();
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await this.sendTyping(target, true);
      if (stopped) return;
      timer = setTimeout(() => {
        void tick();
      }, 5000);
      timer.unref?.();
    };
    await tick();
    try {
      return await operation();
    } finally {
      stopped = true;
      if (timer) clearTimeout(timer);
      await this.sendTyping(target, false);
    }
  }

  private async sendTyping(target: ChannelTarget, typing: boolean): Promise<void> {
    const capabilities = this.channel.getCapabilities();
    if (!capabilities.typing || !this.channel.sendTyping) return;
    try {
      await this.channel.sendTyping(target, typing);
    } catch (error) {
      this.logger.warn("channel typing send failed", {
        channel: this.channel.id,
        typing,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async statusText(message: ChannelMessage): Promise<string> {
    const routeKey = message.routeKey;
    const channelStatus = await this.channel.getStatus();
    const binding = this.state.getBinding(routeKey);
    const localSession = binding ? this.state.getSession(binding.sessionId) : undefined;
    const adapterStatus: CodexSessionStatus = binding
      ? await this.codex.getStatus(binding.sessionId)
      : { type: "unknown", detail: "no active session" };
    const sessionStatus: CodexSessionStatus = adapterStatus.type === "unknown" && localSession
      ? localSession.status
      : adapterStatus;
    const approvals = this.approvals.list(routeKey);
    const workerRunning = this.routeWorkers.has(routeKey);
    const policyStatus = this.runPolicyStatus();
    const policy = policyStatus?.policy ?? this.codex.getRunPolicy?.();
    return [
      "**Codex 状态**",
      `- Session: \`${binding?.sessionId ?? "none"}\``,
      `- State: \`${formatCodexStatus(sessionStatus)}\``,
      `- Context: ${formatContextUsage(sessionStatus.context)}`,
      binding ? `- Cwd: \`${localSession?.session.cwd ?? "unknown"}\`` : undefined,
      "",
      "**Bridge**",
      `- Processing: \`${workerRunning ? "yes" : "no"}\``,
      `- Queue: \`${this.routeQueues.get(routeKey)?.length ?? 0}\``,
      `- Pending approvals: \`${approvals.length}\``,
      `- Progress: \`${this.progressModeFor(routeKey)}\``,
      policy ? `- Permission: \`${formatRunPolicy(policy)}\`` : undefined,
      policyStatus && !policyStatus.interactiveApprovals ? `- Approval: \`${formatApprovalSupport(policyStatus)}\`` : undefined,
      workerRunning && binding ? "- Action: `/stop` 终止当前任务" : undefined,
      "",
      "**Channel**",
      `- Adapter: \`${channelStatus.channelId}\``,
      `- State: \`${channelStatus.state}\``,
      channelStatus.lastError ? `- Last error: ${channelStatus.lastError}` : undefined,
    ].filter(Boolean).join("\n");
  }

  private async sessionsText(routeKey?: string): Promise<string> {
    const localSessions = this.state.listSessions(routeKey);
    const codexSessions = await this.codex.listSessions(routeKey);
    const seen = new Set<string>();
    const lines = [routeKey ? "当前上下文 Codex 会话:" : "全部可发现 Codex 会话:"];
    for (const stored of localSessions) {
      seen.add(stored.session.id);
      lines.push(this.formatSessionLine(stored.session.id, stored.status.type, stored.updatedAt, stored.session.cwd, stored.session.title));
    }
    for (const session of codexSessions) {
      if (seen.has(session.id)) continue;
      lines.push(this.formatSessionLine(session.id, session.status.type, session.updatedAt, session.cwd, session.title));
    }
    if (lines.length === 1) {
      lines.push("无。发送 /new 创建新会话，或 /resume <session> 绑定已有会话。");
    }
    return lines.join("\n");
  }

  private formatSessionLine(id: string, status: string, updatedAt: string, cwd?: string, title?: string): string {
    const parts = [`- ${id}`, status];
    if (updatedAt) parts.push(updatedAt);
    if (title) parts.push(title);
    if (cwd) parts.push(`cwd=${cwd}`);
    return parts.join(" ");
  }

  private whoamiText(message: ChannelMessage): string {
    return [
      "**当前通道身份**",
      `- Route: \`${message.routeKey}\``,
      `- Channel: \`${message.channelId}\``,
      `- Account: \`${message.accountId ?? "default"}\``,
      `- Conversation: \`${formatConversationContext(message.conversation.kind, message.conversation.id, message.conversation.displayName)}\``,
      `- Sender: \`${formatPeerContext(message.sender.id, message.sender.displayName)}\``,
    ].join("\n");
  }

  private async debugText(message: ChannelMessage): Promise<string> {
    const status = await this.statusText(message);
    const capabilities = this.channel.getCapabilities();
    const sessions = this.state.listSessions(message.routeKey);
    return [
      status,
      "",
      "Capabilities:",
      JSON.stringify(capabilities, null, 2),
      "",
      `Local sessions: ${sessions.length}`,
    ].join("\n");
  }

  private helpText(): string {
    return [
      "**可用命令**",
      "- `/help` 查看命令",
      "- `/new` 创建新 Codex 会话",
      "- `/status` 查看状态、队列、审批和上下文 token 用量",
      "- `/sessions` 列出当前上下文会话",
      "- `/sessions all` 列出全部可发现 Codex 会话",
      "- `/resume <session>` 恢复并绑定已有会话",
      "- `/use <session>` 切换到已有会话",
      "- `/whoami` 查看当前通道身份",
      "- `/debug` 查看调试状态",
      "- `/progress [brief|detailed|silent]` 查看或设置当前上下文进度投递模式",
      "- `/permission [approval|full confirm]` 查看或切换 Codex 权限模式",
      "- `/OK` 批准当前审批",
      "- `/NO [理由]` 拒绝当前审批",
      "- `/stop` 终止当前正在处理的 Codex 任务",
    ].join("\n");
  }

  private progressModeFor(routeKey: string): ProgressDeliveryMode {
    return this.routeProgressModes.get(routeKey) ?? this.defaultProgressMode;
  }

  private shouldDeliverProgress(routeKey: string, kind: CodexProgressKind | undefined): boolean {
    const mode = this.progressModeFor(routeKey);
    if (mode === "silent") return false;
    if (mode === "detailed") return true;
    return kind === "reasoning" || kind === "todo" || kind === "search" || kind === "file_change" || kind === "other";
  }

  private progressModeText(routeKey: string): string {
    const mode = this.progressModeFor(routeKey);
    return [
      "**进度投递**",
      `- 当前模式: \`${mode}\``,
      "- `brief`: 只发送计划、自言自语、搜索和文件变更摘要，不发送命令/工具细节。",
      "- `detailed`: 发送所有可见进度，包括命令和工具调用细节。",
      "- `silent`: 不发送进度文本，只发送开始、审批、最终回复和媒体。",
    ].join("\n");
  }

  private permissionText(): string {
    const policyStatus = this.runPolicyStatus();
    const policy = policyStatus?.policy ?? this.codex.getRunPolicy?.();
    return [
      "**权限模式**",
      `- 当前模式: \`${policy ? formatRunPolicy(policy) : "unknown"}\``,
      policyStatus ? `- 审批支持: \`${formatApprovalSupport(policyStatus)}\`` : undefined,
      "- `approval`: 使用 `workspace-write` sandbox；是否能在微信里弹审批取决于 Codex adapter。",
      "- `full`: 完全权限，跳过审批和沙箱，风险很高。",
      "- 切回安全沙箱模式: `/permission approval`",
      "- 切到完全权限: `/permission full confirm`",
      policyStatus?.note ? `- 说明: ${policyStatus.note}` : undefined,
    ].filter(Boolean).join("\n");
  }

  private runPolicyStatus(): CodexRunPolicyStatus | undefined {
    return this.codex.getRunPolicyStatus?.();
  }
}

function truncateForChannel(text: string, maxLength = 600): string {
  const normalized = text.trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function mediaKey(media: ChannelMedia): string | undefined {
  return media.path ?? media.url;
}

function formatCodexStatus(status: CodexSessionStatus): string {
  const parts: string[] = [status.type];
  if ("turnId" in status && status.turnId) parts.push(`turn=${status.turnId}`);
  if ("task" in status && status.task) parts.push(`task=${truncateForChannel(status.task, 80)}`);
  if ("detail" in status && status.detail) parts.push(status.detail);
  if ("error" in status && status.error) parts.push(status.error);
  return parts.join(" ");
}

function formatRunPolicy(policy: CodexRunPolicy): string {
  return policy.permissionMode === "full"
    ? "full"
    : `approval sandbox=${policy.sandbox ?? "workspace-write"}`;
}

function formatApprovalSupport(status: CodexRunPolicyStatus): string {
  if (status.interactiveApprovals) {
    return status.effectiveApprovalPolicy ? `interactive effective=${status.effectiveApprovalPolicy}` : "interactive";
  }
  return status.effectiveApprovalPolicy ? `not interactive effective=${status.effectiveApprovalPolicy}` : "not interactive";
}

function formatContextUsage(context: CodexSessionContextUsage | undefined): string {
  if (!context) return "`unavailable`";
  const total = context.total.totalTokens;
  const window = context.modelContextWindow;
  const usage = window && window > 0
    ? `\`${formatNumber(total)} / ${formatNumber(window)} tokens\` (${formatPercent(total / window)}, remaining ${formatNumber(Math.max(window - total, 0))})`
    : `\`${formatNumber(total)} tokens\``;
  return [
    usage,
    `last turn \`${formatNumber(context.last.totalTokens)} tokens\``,
    `(input ${formatNumber(context.total.inputTokens)}, cached ${formatNumber(context.total.cachedInputTokens)}, output ${formatNumber(context.total.outputTokens)}, reasoning ${formatNumber(context.total.reasoningOutputTokens)})`,
  ].join(" ");
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatConversationContext(kind: string, id: string, displayName?: string): string {
  return displayName ? `${kind}:${id} (${displayName})` : `${kind}:${id}`;
}

function formatPeerContext(id: string, displayName?: string): string {
  return displayName ? `${displayName} (${id})` : id;
}

function isConfirmed(args: string[]): boolean {
  const normalized = args.join(" ").trim().toLowerCase();
  return normalized === "confirm" || normalized === "yes" || normalized === "确认" || normalized === "我确认";
}

function formatApprovalDecision(decision: ApprovalDecision): string {
  if (decision === "approve") return "已通过";
  if (decision === "approve-session") return "已按本会话通过";
  if (decision === "deny") return "已拒绝";
  return "已取消";
}

function fallbackMediaText(media: ChannelMedia, mediaCapability: boolean): string {
  const location = media.path ?? media.url ?? media.name ?? "unknown";
  const reason = mediaCapability ? "通道媒体发送失败，已退回文本引用。" : "当前通道不支持媒体发送，已退回文本引用。";
  return [
    "Codex 生成了媒体文件",
    `Type: ${media.type}`,
    media.name ? `Name: ${media.name}` : undefined,
    media.mimeType ? `Mime: ${media.mimeType}` : undefined,
    media.sizeBytes !== undefined ? `Size: ${media.sizeBytes} bytes` : undefined,
    media.caption ? `Caption: ${media.caption}` : undefined,
    `Location: ${location}`,
    reason,
  ].filter(Boolean).join("\n");
}

export function parseProgressDeliveryMode(value: string): ProgressDeliveryMode | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "brief" || normalized === "normal") return "brief";
  if (normalized === "detailed" || normalized === "verbose" || normalized === "debug") return "detailed";
  if (normalized === "silent" || normalized === "quiet" || normalized === "off" || normalized === "none") return "silent";
  return undefined;
}
