import test from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../../src/bridge/bridge.js";
import { ChannelRegistry } from "../../src/channels/registry.js";
import { MockChannelAdapter } from "../../src/channels/mock/mock-channel-adapter.js";
import { MockCodexAdapter } from "../../src/codex/mock-codex-adapter.js";
import { truncateDisplayText } from "../../src/codex/codex-cli.js";
import { codexInputPlainText, normalizeCodexInput } from "../../src/codex/input.js";
import type { CodexAdapter, CodexBackgroundEventHandler, CodexCollaborationMode, CodexCompactResult, CodexEvent, CodexGoal, CodexPromptInput, CodexRunOptions, CodexSession, CodexSessionContextUsage, CodexSessionStatus, CodexSessionSummary, CodexTurnInput, CodexUserInputQuestion, CodexUserInputResponse, StartSessionInput } from "../../src/codex/types.js";
import type { TranscriptSink } from "../../src/logging/transcript.js";
import type { ChannelAttachment, ChannelCapabilities, ChannelMedia, ChannelMessage, ChannelTarget, SendResult } from "../../src/protocol/channel.js";
import type { ChannelDeliveryPolicy } from "../../src/protocol/delivery-policy.js";
import { currentTimeZone, formatLocalDateTimeWithZone } from "../../src/time/display-time.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

class CapturingTranscriptSink implements TranscriptSink {
  readonly inboundEvents: Array<{ message: ChannelMessage; text: string }> = [];
  readonly outboundEvents: Array<{ target: ChannelTarget; text: string }> = [];
  readonly localProgressEvents: Array<{ target: ChannelTarget; text: string }> = [];
  readonly outboundMediaEvents: Array<{ target: ChannelTarget; media: ChannelMedia }> = [];

  inbound(message: ChannelMessage, text: string): void {
    this.inboundEvents.push({ message, text });
  }

  outbound(target: ChannelTarget, text: string): void {
    this.outboundEvents.push({ target, text });
  }

  localProgress(target: ChannelTarget, text: string): void {
    this.localProgressEvents.push({ target, text });
  }

  outboundMedia(target: ChannelTarget, media: ChannelMedia): void {
    this.outboundMediaEvents.push({ target, media });
  }
}

class ProgressCodexAdapter extends MockCodexAdapter {
  override async *run(sessionId: string, _prompt: string): AsyncIterable<CodexEvent> {
    const turnId = `progress-turn-${Date.now()}`;
    yield { type: "turn.started", sessionId, turnId };
    yield { type: "assistant.progress", sessionId, turnId, kind: "reasoning", text: "我先列一个简短计划。" };
    yield { type: "assistant.progress", sessionId, turnId, kind: "command", text: "正在执行命令: npm test" };
    yield { type: "assistant.completed", sessionId, turnId, text: "完成" };
    yield { type: "turn.completed", sessionId, turnId };
  }
}

class AutoGoalCodexAdapter extends MockCodexAdapter {
  private readonly backgroundHandlers = new Set<CodexBackgroundEventHandler>();

  onBackgroundEvent(handler: CodexBackgroundEventHandler): () => void {
    this.backgroundHandlers.add(handler);
    return () => {
      this.backgroundHandlers.delete(handler);
    };
  }

  override async setGoal(sessionId: string, objective: string): Promise<CodexGoal> {
    const goal = await super.setGoal(sessionId, objective);
    setTimeout(() => {
      void this.emitGoalTurn(sessionId);
    }, 0);
    return goal;
  }

  protected async emitGoalTurn(sessionId: string): Promise<void> {
    const turnId = `goal-turn-${Date.now()}`;
    await this.emitBackground({ type: "turn.started", sessionId, turnId });
    await this.emitBackground({ type: "assistant.progress", sessionId, turnId, kind: "reasoning", text: "正在推进 Goal。" });
    await this.emitBackground({ type: "assistant.completed", sessionId, turnId, text: "Goal 自动续跑完成" });
    await this.emitBackground({ type: "turn.completed", sessionId, turnId });
  }

  protected async emitBackground(event: CodexEvent): Promise<void> {
    for (const handler of [...this.backgroundHandlers]) {
      await handler(event);
    }
  }
}

class FixedGoalTimeCodexAdapter extends MockCodexAdapter {
  private fixedGoal: CodexGoal | null = null;

  override async setGoal(sessionId: string, objective: string): Promise<CodexGoal> {
    const goal = await super.setGoal(sessionId, objective);
    this.fixedGoal = {
      ...goal,
      createdAt: 1700000000,
      updatedAt: 1700000000,
    };
    return this.fixedGoal;
  }

  override async getGoal(sessionId: string): Promise<CodexGoal | null> {
    return this.fixedGoal ?? super.getGoal(sessionId);
  }
}

class BlockingGoalCodexAdapter extends AutoGoalCodexAdapter {
  private releaseBackgroundTurn: (() => void) | undefined;

  release(): void {
    this.releaseBackgroundTurn?.();
  }

  protected override async emitGoalTurn(sessionId: string): Promise<void> {
    const turnId = `goal-blocking-turn-${Date.now()}`;
    await this.emitBackground({ type: "turn.started", sessionId, turnId });
    await this.emitBackground({ type: "assistant.progress", sessionId, turnId, kind: "reasoning", text: "Goal 仍在执行。" });
    await new Promise<void>((resolve) => {
      this.releaseBackgroundTurn = resolve;
    });
    await this.emitBackground({ type: "assistant.completed", sessionId, turnId, text: "Goal 后台任务完成" });
    await this.emitBackground({ type: "turn.completed", sessionId, turnId });
  }
}

class ManualBackgroundCodexAdapter extends MockCodexAdapter {
  private readonly backgroundHandlers = new Set<CodexBackgroundEventHandler>();
  private releaseBackgroundTurn: (() => void) | undefined;
  backgroundStarted = false;

  onBackgroundEvent(handler: CodexBackgroundEventHandler): () => void {
    this.backgroundHandlers.add(handler);
    return () => {
      this.backgroundHandlers.delete(handler);
    };
  }

  async startBlockingBackground(sessionId: string): Promise<void> {
    const turnId = `manual-background-turn-${Date.now()}`;
    await this.emitBackground({ type: "turn.started", sessionId, turnId });
    this.backgroundStarted = true;
    await new Promise<void>((resolve) => {
      this.releaseBackgroundTurn = resolve;
    });
    await this.emitBackground({ type: "assistant.completed", sessionId, turnId, text: "后台任务完成" });
    await this.emitBackground({ type: "turn.completed", sessionId, turnId });
  }

  release(): void {
    this.releaseBackgroundTurn?.();
  }

  private async emitBackground(event: CodexEvent): Promise<void> {
    for (const handler of [...this.backgroundHandlers]) {
      await handler(event);
    }
  }
}

class FailedTurnCodexAdapter extends MockCodexAdapter {
  override async *run(sessionId: string, _prompt: string): AsyncIterable<CodexEvent> {
    const turnId = `failed-turn-${Date.now()}`;
    yield { type: "turn.started", sessionId, turnId };
    yield { type: "turn.failed", sessionId, turnId, error: "模拟失败" };
  }
}

class WeixinIdOnlyChannelAdapter extends MockChannelAdapter {
  override readonly id = "weixin";
  override readonly label = "Weixin-id-only Channel";
}

class WeixinLikeChannelAdapter extends MockChannelAdapter {
  override readonly id = "weixin";
  override readonly label = "Weixin-like Channel";

  override getCapabilities(): ChannelCapabilities {
    return {
      ...super.getCapabilities(),
      typing: true,
      media: true,
      group: false,
      thread: false,
    };
  }

  override getDeliveryPolicy(): ChannelDeliveryPolicy {
    return {
      taskStart: "suppress",
      progress: "suppress",
      progressCommand: "disabled",
      progressDisabledMessage: "微信渠道已禁用进度投递，/progress 在微信中不可用。",
      statusProgressLabel: "disabled",
      statusProgressDescription: "微信渠道不投递进度",
      refreshCommands: [
        {
          command: "fff",
          description: "微信专用静默刷新命令，不发送回复",
          silent: true,
        },
      ],
    };
  }
}

class ProgressMediaCodexAdapter extends MockCodexAdapter {
  constructor(private readonly imagePath: string) {
    super();
  }

  override async *run(sessionId: string, _prompt: string): AsyncIterable<CodexEvent> {
    const turnId = `progress-media-turn-${Date.now()}`;
    yield { type: "turn.started", sessionId, turnId };
    yield { type: "assistant.progress", sessionId, turnId, kind: "file_change", text: `文件变更完成: ${this.imagePath}` };
    yield { type: "assistant.completed", sessionId, turnId, text: "完成" };
    yield { type: "turn.completed", sessionId, turnId };
  }
}

class SendFileCodexAdapter extends MockCodexAdapter {
  readonly prompts: string[] = [];

  constructor(private readonly filePath: string) {
    super();
  }

  override async *run(sessionId: string, prompt: string): AsyncIterable<CodexEvent> {
    this.prompts.push(prompt);
    const turnId = `send-file-turn-${Date.now()}`;
    yield { type: "turn.started", sessionId, turnId };
    yield {
      type: "assistant.completed",
      sessionId,
      turnId,
      text: `文件已准备好。\nBRIDGE_SEND_FILE: ${this.filePath}`,
    };
    yield { type: "turn.completed", sessionId, turnId };
  }
}

class ManyProgressCodexAdapter extends MockCodexAdapter {
  override async *run(sessionId: string, _prompt: string): AsyncIterable<CodexEvent> {
    const turnId = `many-progress-turn-${Date.now()}`;
    yield { type: "turn.started", sessionId, turnId };
    yield { type: "assistant.progress", sessionId, turnId, kind: "reasoning", text: "第一段进度。" };
    yield { type: "assistant.progress", sessionId, turnId, kind: "reasoning", text: "第二段进度。" };
    yield { type: "assistant.progress", sessionId, turnId, kind: "reasoning", text: "第三段进度。" };
    yield { type: "assistant.completed", sessionId, turnId, text: "完成" };
    yield { type: "turn.completed", sessionId, turnId };
  }
}

class PlanFinalCodexAdapter extends MockCodexAdapter {
  override async *run(sessionId: string, _prompt: string, _options: CodexRunOptions = {}): AsyncIterable<CodexEvent> {
    const turnId = `plan-final-turn-${Date.now()}`;
    yield { type: "turn.started", sessionId, turnId };
    yield { type: "assistant.progress", sessionId, turnId, kind: "todo", text: "计划更新: 这条进度不应该在微信里发送。" };
    yield { type: "assistant.plan", sessionId, turnId, text: "# 执行计划\n- 先检查\n- 再实现" };
    yield { type: "turn.completed", sessionId, turnId };
  }
}

class RequestUserInputCodexAdapter extends MockCodexAdapter {
  readonly resolvedInputs: Array<{ requestId: string; response: CodexUserInputResponse }> = [];
  private readonly resolvers = new Map<string, (response: CodexUserInputResponse) => void>();

  constructor(private readonly questions: CodexUserInputQuestion[]) {
    super();
  }

  override async *run(sessionId: string, _prompt: string, _options: CodexRunOptions = {}): AsyncIterable<CodexEvent> {
    const turnId = `input-turn-${Date.now()}`;
    const requestId = `input-request-${this.resolvedInputs.length + 1}`;
    const responsePromise = new Promise<CodexUserInputResponse>((resolve) => {
      this.resolvers.set(requestId, resolve);
    });
    yield { type: "turn.started", sessionId, turnId };
    yield {
      type: "input.requested",
      sessionId,
      turnId,
      request: {
        adapterRequestId: requestId,
        sessionId,
        turnId,
        itemId: "input-item-1",
        questions: this.questions,
      },
    };
    const response = await responsePromise;
    const first = Object.values(response.answers)[0]?.answers.join("|") ?? "";
    yield { type: "assistant.completed", sessionId, turnId, text: `input result ${first}` };
    yield { type: "turn.completed", sessionId, turnId };
  }

  async resolveUserInput(requestId: string, response: CodexUserInputResponse): Promise<void> {
    this.resolvedInputs.push({ requestId, response });
    const resolve = this.resolvers.get(requestId);
    if (!resolve) throw new Error(`unknown input request: ${requestId}`);
    this.resolvers.delete(requestId);
    resolve(response);
  }
}

class BlockingModeCodexAdapter extends MockCodexAdapter {
  private releaseFirst?: () => void;
  readonly modeRuns: Array<CodexCollaborationMode | undefined> = [];

  override async *run(sessionId: string, prompt: string, options: CodexRunOptions = {}): AsyncIterable<CodexEvent> {
    this.modeRuns.push(options.collaborationMode);
    const turnId = `blocking-mode-turn-${this.modeRuns.length}`;
    yield { type: "turn.started", sessionId, turnId };
    if (prompt === "第一条") {
      await new Promise<void>((resolve) => {
        this.releaseFirst = resolve;
      });
    }
    yield { type: "assistant.completed", sessionId, turnId, text: `完成: ${prompt}` };
    yield { type: "turn.completed", sessionId, turnId };
  }

  release(): void {
    this.releaseFirst?.();
  }
}

class SteerableBlockingCodexAdapter extends MockCodexAdapter {
  private releaseFirst?: () => void;
  private readonly localStatuses = new Map<string, CodexSessionStatus>();
  readonly prompts: string[] = [];
  readonly promptRuns: Array<{ sessionId: string; prompt: string }> = [];
  readonly steers: Array<{ sessionId: string; prompt: string }> = [];
  readonly promptInputs: CodexTurnInput[] = [];
  readonly steerInputs: CodexTurnInput[] = [];
  failSteer = false;
  cancelled = false;

  override async *run(sessionId: string, prompt: CodexPromptInput): AsyncIterable<CodexEvent> {
    const input = normalizeCodexInput(prompt);
    const promptText = codexInputPlainText(input);
    this.promptInputs.push(input);
    this.prompts.push(promptText);
    this.promptRuns.push({ sessionId, prompt: promptText });
    const turnId = `steerable-turn-${this.prompts.length}`;
    this.localStatuses.set(sessionId, { type: "running", turnId, task: promptText });
    yield { type: "turn.started", sessionId, turnId };
    if (promptText === "第一条" || promptText.endsWith("：第一条") || promptText === "A 长任务" || promptText.endsWith("：A 长任务")) {
      await new Promise<void>((resolve) => {
        this.releaseFirst = resolve;
      });
    }
    if (this.cancelled) {
      this.localStatuses.set(sessionId, { type: "idle" });
      yield { type: "turn.completed", sessionId, turnId };
      return;
    }
    this.localStatuses.set(sessionId, { type: "idle" });
    yield { type: "assistant.completed", sessionId, turnId, text: `完成: ${promptText}` };
    yield { type: "turn.completed", sessionId, turnId };
  }

  async steer(sessionId: string, prompt: CodexPromptInput): Promise<void> {
    if (this.failSteer) throw new Error("steer rejected");
    const status = this.localStatuses.get(sessionId);
    if (!status || status.type !== "running") throw new Error("no active turn");
    const input = normalizeCodexInput(prompt);
    this.steerInputs.push(input);
    this.steers.push({ sessionId, prompt: codexInputPlainText(input) });
  }

  override async cancel(sessionId: string): Promise<void> {
    this.cancelled = true;
    this.localStatuses.set(sessionId, { type: "idle" });
    this.release();
  }

  override async getStatus(sessionId: string): Promise<CodexSessionStatus> {
    return this.localStatuses.get(sessionId) ?? await super.getStatus(sessionId);
  }

  release(): void {
    this.releaseFirst?.();
    this.releaseFirst = undefined;
  }
}

class AdapterApprovalIdCodexAdapter extends MockCodexAdapter {
  override async *run(sessionId: string, _prompt: string): AsyncIterable<CodexEvent> {
    const turnId = "adapter-approval-turn-1";
    yield { type: "turn.started", sessionId, turnId };
    yield {
      type: "approval.requested",
      sessionId,
      turnId,
      approval: {
        kind: "command",
        adapterApprovalId: "server-request-1",
        sessionId,
        turnId,
        itemId: "cmd-1",
        command: "touch app-server-approved.txt",
      },
    };
    yield { type: "turn.completed", sessionId, turnId };
  }
}

class ParallelProbeCodexAdapter extends MockCodexAdapter {
  active = 0;
  maxActive = 0;
  readonly prompts: string[] = [];

  override async *run(sessionId: string, prompt: string): AsyncIterable<CodexEvent> {
    this.prompts.push(prompt);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    const turnId = `parallel-turn-${this.prompts.length}`;
    yield { type: "turn.started", sessionId, turnId };
    await new Promise((resolve) => setTimeout(resolve, 30));
    yield { type: "assistant.completed", sessionId, turnId, text: `完成: ${prompt}` };
    this.active -= 1;
    yield { type: "turn.completed", sessionId, turnId };
  }
}

class ContextUsageCodexAdapter extends MockCodexAdapter {
  private readonly context: CodexSessionContextUsage = {
    total: {
      totalTokens: 34375973,
      inputTokens: 34282029,
      cachedInputTokens: 33213184,
      outputTokens: 93944,
      reasoningOutputTokens: 30181,
    },
    last: {
      totalTokens: 164171,
      inputTokens: 160000,
      cachedInputTokens: 120000,
      outputTokens: 4171,
      reasoningOutputTokens: 1200,
    },
    modelContextWindow: 258400,
  };

  override async getStatus(sessionId: string): Promise<CodexSessionStatus> {
    const status = await super.getStatus(sessionId);
    return { ...status, context: this.context, model: { model: "gpt-test", provider: "openai", serviceTier: "default", reasoningEffort: "high" } };
  }
}

class FailingSendChannelAdapter extends MockChannelAdapter {
  sentAttempts = 0;

  override async sendText(_target: ChannelTarget, _text: string): Promise<SendResult> {
    this.sentAttempts += 1;
    throw new Error("sendmessage failed: ret=-2 errcode=0");
  }
}

class ProgressFailingChannelAdapter extends MockChannelAdapter {
  progressAttempts = 0;

  override async sendText(target: ChannelTarget, text: string): Promise<SendResult> {
    if (text.startsWith("Codex 进度:")) {
      this.progressAttempts += 1;
      throw new Error("sendmessage failed: ret=-2 errcode=0");
    }
    return super.sendText(target, text);
  }
}

class ApprovalFlakyChannelAdapter extends MockChannelAdapter {
  approvalAttempts = 0;

  constructor(private readonly failuresBeforeSuccess: number) {
    super();
  }

  override async sendText(target: ChannelTarget, text: string): Promise<SendResult> {
    if (text.includes("Codex 请求审批")) {
      this.approvalAttempts += 1;
      if (this.approvalAttempts <= this.failuresBeforeSuccess) {
        throw new Error("sendmessage failed: ret=-2 errcode=0");
      }
    }
    return super.sendText(target, text);
  }
}

class FailingMediaChannelAdapter extends MockChannelAdapter {
  mediaAttempts = 0;

  constructor() {
    super({ media: true });
  }

  override async sendMedia(_target: ChannelTarget, _media: ChannelMedia): Promise<SendResult> {
    this.mediaAttempts += 1;
    throw new Error("cdn upload 500");
  }
}

class CancellableCodexAdapter implements CodexAdapter {
  private sequence = 0;
  private readonly sessions = new Map<string, CodexSession>();
  private status: CodexSessionStatus = { type: "idle" };
  private release?: () => void;
  cancelled = false;
  readonly prompts: string[] = [];

  async startSession(input: StartSessionInput): Promise<CodexSession> {
    this.sequence += 1;
    const session: CodexSession = {
      id: `cancel-codex-${this.sequence}`,
      cwd: input.cwd,
      title: input.title,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async resumeSession(sessionId: string): Promise<CodexSession> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`missing session ${sessionId}`);
    return session;
  }

  async *run(sessionId: string, prompt: string): AsyncIterable<CodexEvent> {
    this.prompts.push(prompt);
    const turnId = "cancel-turn-1";
    this.status = { type: "running", turnId, task: prompt };
    yield { type: "turn.started", sessionId, turnId };
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    this.status = { type: "idle" };
    yield { type: "turn.completed", sessionId, turnId };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.status = { type: "idle" };
    this.release?.();
  }

  async getStatus(): Promise<CodexSessionStatus> {
    return this.status;
  }

  async listSessions(): Promise<CodexSessionSummary[]> {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      title: session.title,
      cwd: session.cwd,
      status: this.status,
      updatedAt: new Date().toISOString(),
    }));
  }
}

class BlockingCompactCodexAdapter extends MockCodexAdapter {
  compactStarted = false;
  private releaseCompact?: () => void;

  override async compactSession(sessionId: string): Promise<CodexCompactResult> {
    this.compactStarted = true;
    this.compactedSessions.push(sessionId);
    await new Promise<void>((resolve) => {
      this.releaseCompact = resolve;
    });
    return { sessionId };
  }

  release(): void {
    this.releaseCompact?.();
  }
}

test("Bridge handles new session, prompt, status, and approval over mock channel", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/new");
  await channel.emitText("/sessions");
  await channel.emitText("/whoami");
  await channel.emitText("/debug");
  await channel.emitText("/use mock-codex-1");
  await channel.emitText("你好");
  await bridge.waitForIdle();
  await channel.emitText("/status");
  await channel.emitText("请触发审批 approval");
  await bridge.waitForIdle();

  const approvalMessage = channel.sentMessages.find((message) => message.text.includes("Codex 请求审批"));
  assert.ok(approvalMessage, "approval request should be sent to channel");
  assert.equal(/\[a[0-9a-z]+]/.test(approvalMessage.text), false, "approval id should not be exposed in normal channel prompt");
  assert.ok(approvalMessage.text.includes("/OK 通过当前审批"));
  assert.ok(approvalMessage.text.includes("/P 本会话通过"));
  assert.ok(approvalMessage.text.includes("/NO 拒绝当前审批"));

  await channel.emitText("/OK 好的");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.ok(channel.sentMessages.some((message) => message.text.includes("已创建新 Codex 会话")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("**Codex 会话**") && message.text.includes("范围: 当前聊天")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("当前通道身份")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("Capabilities")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已绑定 Codex 会话")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("Mock Codex 回复: 你好")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("**Codex 状态**")));
  const approvalHandledMessage = channel.sentMessages.find((message) => message.text.startsWith("审批已处理:"))?.text ?? "";
  assert.ok(approvalHandledMessage.includes("已通过"));
  assert.equal(/\[a[0-9a-z]+]/.test(approvalHandledMessage), false, "approval handled reply should not expose internal id");
  assert.equal(codex.resolvedApprovals.length, 1);
  assert.match(codex.resolvedApprovals[0].approvalKey, /^a[0-9a-z]+$/);
  assert.equal(codex.resolvedApprovals[0].decision, "approve");
});

test("Bridge creates Codex App chat sessions with optional first prompt", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/new chat", { conversationId: "empty" });
  await channel.emitText("/new chat 帮我总结这个项目", { conversationId: "with-prompt" });
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.sessionTitles.length, 2);
  assert.deepEqual(codex.sessionPreviews.map((item) => item.preview), ["mock / mock-account / Mock Direct", "帮我总结这个项目"]);
  assert.equal(codex.runs.length, 1);
  assert.equal(codex.runs[0].sessionId, "mock-codex-2");
  assert.equal(codex.runs[0].prompt, "帮我总结这个项目");
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已创建 Codex App 对话")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("标题: mock / mock-account / Mock Direct")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("正在把后续文本作为这个对话的第一条任务执行")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("Mock Codex 回复: 帮我总结这个项目")));
});

test("Bridge handles compact confirmation and success over mock channel", async () => {
  const channel = new MockChannelAdapter({ typing: true });
  const codex = new ContextUsageCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/new");
  await channel.emitText("/help");
  await channel.emitText("/compact");
  await channel.emitText("/status");
  await channel.emitText("/cancel");
  await channel.emitText("/compact");
  await channel.emitText("/compact confirm");
  await channel.emitText("/status");
  await bridge.stop();

  const help = channel.sentMessages.find((message) => message.text.startsWith("**可用命令**"))?.text ?? "";
  const confirmation = channel.sentMessages.find((message) => message.text.includes("即将压缩当前 Codex session"))?.text ?? "";
  const completed = channel.sentMessages.find((message) => message.text.includes("上下文压缩完成"))?.text ?? "";
  assert.equal(help.includes("```text"), false);
  assert.equal(help.includes("/new chat"), false);
  assert.ok(help.includes("- `/context-refresh [off|detect|reload|inherit]`: 设置当前聊天发送前是否检测本机 Codex session 上下文更新。"));
  assert.ok(help.includes("  - `/context-refresh`: 查看当前聊天设置。"));
  assert.ok(help.includes("  - `/context-refresh off`: 关闭发送前检测。"));
  assert.ok(help.includes("  - `/context-refresh detect`: 发现本机 session 外部更新时只提醒，本条消息继续发送。"));
  assert.ok(help.includes("  - `/context-refresh reload`: 发现本机 session 外部更新时先重新加载当前 session，再发送。"));
  assert.ok(help.includes("  - `/context-refresh inherit`: 清除当前聊天覆盖，跟随全局默认。"));
  assert.ok(help.includes("- `/compact`: 压缩当前 Codex session 的历史上下文。"));
  assert.ok(help.includes("  - `/compact confirm`: 确认并开始压缩。"));
  assert.ok(confirmation.includes("压缩前上下文: `164,171 / 258,400 token`"));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("上下文压缩: 等待确认")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已取消本次上下文压缩确认")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已开始压缩当前 Codex session 上下文")));
  assert.ok(completed.includes("压缩后上下文: `164,171 / 258,400 token`"));
  assert.deepEqual(codex.compactedSessions, ["mock-codex-1"]);
  assert.deepEqual(channel.sentTyping.map((event) => event.typing), [true, false]);
});

test("Bridge blocks current route operations while compact runs but allows other routes", async () => {
  const channel = new MockChannelAdapter();
  const codex = new BlockingCompactCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/new", { conversationId: "main" });
  await channel.emitText("/new", { conversationId: "other" });
  await channel.emitText("/compact", { conversationId: "main" });
  const compactPromise = channel.emitText("/compact confirm", { conversationId: "main" });
  await waitFor(() => codex.compactStarted);
  await waitFor(() => channel.sentMessages.some((message) => message.text.includes("已开始压缩当前 Codex session 上下文")));

  await channel.emitText("/status", { conversationId: "main" });
  await channel.emitText("/stop", { conversationId: "main" });
  await channel.emitText("压缩中普通消息", { conversationId: "main" });
  await channel.emitText("其他 route 正常执行", { conversationId: "other" });
  await waitFor(() => channel.sentMessages.some((message) => message.text.includes("Mock Codex 回复: 其他 route 正常执行")));

  codex.release();
  await compactPromise;
  await bridge.waitForIdle();
  await bridge.stop();

  const mainStatus = channel.sentMessages
    .filter((message) => message.target.conversation.id === "main" && message.text.includes("**Codex 状态**"))
    .at(-1)?.text ?? "";
  assert.ok(mainStatus.includes("上下文压缩: 进行中"));
  assert.ok(mainStatus.includes("当前不支持中途取消 /compact"));
  assert.ok(channel.sentMessages.some((message) => message.text === "当前正在压缩上下文，请等待完成后再操作。"));
  assert.ok(channel.sentMessages.some((message) => message.text === "当前正在压缩上下文，请等待完成后再发送消息。"));
  assert.equal(codex.runs.some((run) => run.prompt === "压缩中普通消息"), false);
  assert.ok(codex.runs.some((run) => run.prompt === "其他 route 正常执行"));
  assert.deepEqual(codex.compactedSessions, ["mock-codex-1"]);
});

test("Bridge can switch sessions by entering a numbered selection mode", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/new");
  await channel.emitText("/new");
  await channel.emitText("/use");
  const selection = channel.sentMessages.at(-1)?.text ?? "";
  assert.ok(selection.includes("**切换 Codex 会话**"));
  assert.ok(selection.includes("1. Session: `mock-codex-2`（当前）"));
  assert.ok(selection.includes("2. Session: `mock-codex-1`"));

  await channel.emitText("2");
  await channel.emitText("/status");
  await bridge.stop();

  assert.ok(channel.sentMessages.some((message) => message.text.includes("已绑定 Codex 会话")));
  assert.ok(channel.sentMessages.at(-1)?.text.includes("当前会话: `mock-codex-1`"));
});

test("Bridge turns an unknown session id into a recoverable selection prompt", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/new");
  await channel.emitText("/use missing-session-id");
  const selection = channel.sentMessages.at(-1)?.text ?? "";
  await channel.emitText("取消");
  await bridge.stop();

  assert.ok(selection.includes("没有找到 session `missing-session-id`"));
  assert.ok(selection.includes("**切换 Codex 会话**"));
  assert.equal(selection.includes("mock session not found"), false);
  assert.ok(channel.sentMessages.at(-1)?.text.includes("已退出切换会话"));
});

test("Bridge paginates numbered session selection by current page", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  for (let index = 0; index < 12; index += 1) {
    await codex.startSession({
      routeKey: `seed-${index}`,
      cwd: process.cwd(),
      title: `seed session ${index + 1}`,
    });
  }
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/use");
  await channel.emitText("n");
  const page2 = channel.sentMessages.at(-1)?.text ?? "";
  const selectedId = page2.match(/2\. Session: `([^`]+)`/)?.[1];
  assert.ok(selectedId);
  await channel.emitText("2");
  await channel.emitText("/status");
  await bridge.stop();

  assert.ok(page2.includes("页码: `2 / 2`"));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已绑定 Codex 会话")));
  assert.ok(channel.sentMessages.at(-1)?.text.includes(`当前会话: \`${selectedId}\``));
});

test("Bridge exposes all sessions command for channel users", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/new", { conversationId: "main" });
  await channel.emitText("/new", { conversationId: "other" });
  await channel.emitText("/help", { conversationId: "main" });
  await channel.emitText("/sessions all", { conversationId: "main" });
  await channel.emitText("/all-sessions", { conversationId: "main" });
  await bridge.stop();

  assert.ok(channel.sentMessages.some((message) => message.text.includes("- `/sessions all`: 列出本机全部可发现的 Codex 历史会话。")));
  const help = channel.sentMessages.find((message) => message.text.startsWith("**可用命令**"))?.text ?? "";
  assert.ok(help.includes("- `/sessions`: 列出当前聊天上下文拥有、绑定过或本地记录相关的 Codex 会话。"));
  assert.ok(help.includes("- `/OK`: 批准当前审批。"));
  assert.ok(help.includes("批准当前审批"));
  assert.ok(help.includes("- `/P`: 按当前会话批准审批，后续同类操作尽量不再询问。"));
  assert.ok(help.includes("按当前会话批准审批"));
  assert.ok(help.includes("- `/NO`: 拒绝当前审批。"));
  assert.ok(help.includes("拒绝当前审批"));
  assert.ok(help.includes("- `/permission [approval|full confirm]`: 查看或切换当前绑定 Codex session 的权限模式。"));
  assert.equal(help.includes("/approve [id]"), false);
  assert.ok(help.includes("`/cancel`: 取消等待中的压缩确认。"));
  const allSessionsMessages = channel.sentMessages.filter((message) => message.text.startsWith("**Codex 会话**") && message.text.includes("范围: 全部可发现"));
  assert.equal(allSessionsMessages.length, 2);
  assert.ok(allSessionsMessages.every((message) => message.text.includes("mock-codex-1")));
  assert.ok(allSessionsMessages.every((message) => message.text.includes("mock-codex-2")));
});

test("Bridge supports /session alias and paginates session list commands", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/new", { conversationId: "main" });
  for (let index = 0; index < 11; index += 1) {
    await channel.emitText("/new", { conversationId: `other-${index}` });
  }
  await channel.emitText("/session", { conversationId: "main" });
  await channel.emitText("/sessions all", { conversationId: "main" });
  await channel.emitText("/sessions all next", { conversationId: "main" });
  await channel.emitText("/session all prev", { conversationId: "main" });
  await bridge.stop();

  const routeList = channel.sentMessages.find((message) => message.text.startsWith("**Codex 会话**") && message.text.includes("范围: 当前聊天"))?.text ?? "";
  const allListPage1 = channel.sentMessages.find((message) => message.text.startsWith("**Codex 会话**") && message.text.includes("范围: 全部可发现") && message.text.includes("页码: `1 / 2`"))?.text ?? "";
  const allListPage2 = channel.sentMessages.find((message) => message.text.startsWith("**Codex 会话**") && message.text.includes("页码: `2 / 2`"))?.text ?? "";

  assert.ok(routeList.includes("Session: `mock-codex-1`（当前）"));
  assert.ok(allListPage1.includes("数量: `12`"));
  assert.ok(allListPage2.includes("数量: `12`"));
  assert.ok(channel.sentMessages.at(-1)?.text.includes("页码: `1 / 2`"));
});

test("Bridge truncates long session titles in all sessions output", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const longTitle = "这是一个很长的会话标题，会来自 Codex 保存的标题或第一条用户消息。".repeat(4);
  await codex.startSession({
    routeKey: "seed",
    cwd: process.cwd(),
    title: longTitle,
  });
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/sessions all");
  await bridge.stop();

  const sessions = channel.sentMessages.at(-1)?.text ?? "";
  assert.ok(sessions.includes(truncateDisplayText(longTitle)));
  assert.equal(sessions.includes(longTitle), false);
});

test("Bridge status includes session token context without channel identity details", async () => {
  const channel = new MockChannelAdapter();
  const codex = new ContextUsageCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/new", { senderId: "alice", conversationId: "project-room" });
  await channel.emitText("/status", { senderId: "alice", conversationId: "project-room" });
  await bridge.stop();

  const statusMessage = channel.sentMessages.at(-1)?.text ?? "";
  assert.match(statusMessage, /\*\*Codex 状态\*\*/);
  assert.match(statusMessage, /- \*\*会话\*\*\n  - 当前会话: `mock-codex-1`/);
  assert.match(statusMessage, /- \*\*运行\*\*\n  - 处理状态:/);
  assert.match(statusMessage, /- \*\*渠道\*\*\n  - 渠道: `mock`/);
  assert.match(statusMessage, /当前会话: `mock-codex-1`/);
  assert.match(statusMessage, /当前模型: `gpt-test`（服务商 `openai`，服务档 `default`，思考程度 `high`）/);
  assert.match(statusMessage, /上下文: `164,171 \/ 258,400 token`（63\.5%，剩余 94,229）/);
  assert.match(statusMessage, /最近一轮 token: 输入 `160,000`，缓存 `120,000`，输出 `4,171`，推理输出 `1,200`/);
  assert.match(statusMessage, /本会话累计 token: 总计 `34,375,973`，输入 `34,282,029`，缓存 `33,213,184`，输出 `93,944`，推理输出 `30,181`/);
  assert.doesNotMatch(statusMessage, /13303\.4%/);
  assert.doesNotMatch(statusMessage, /mock:mock-account:direct:project-room/);
  assert.doesNotMatch(statusMessage, /Mock User \(alice\)/);
});

test("Bridge model command lists actual models and is shown in help", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/help");
  await channel.emitText("/model");
  await channel.emitText("/model all");
  await bridge.stop();

  const help = channel.sentMessages.find((message) => message.text.startsWith("**可用命令**"))?.text ?? "";
  assert.ok(help.includes("- `/model [模型|编号] [effort]`: 查看可用模型，或切换当前 Codex session 后续任务的模型和思考程度。"));
  const visibleList = channel.sentMessages.find((message) => message.text.includes("**模型设置**") && !message.text.includes("gpt-hidden"))?.text ?? "";
  assert.ok(visibleList.includes("`model/list`"));
  assert.ok(visibleList.includes("`gpt-test`"));
  assert.ok(visibleList.includes("`gpt-next`"));
  assert.equal(visibleList.includes("`gpt-hidden`"), false);
  const allList = channel.sentMessages.at(-1)?.text ?? "";
  assert.ok(allList.includes("`model/list includeHidden=true`"));
  assert.ok(allList.includes("`gpt-hidden`"));
});

test("Bridge model command switches model and effort for the current session", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/new");
  await channel.emitText("/model gpt-next xhigh");
  await channel.emitText("/status");
  await channel.emitText("/model 2 high");
  await bridge.stop();

  assert.deepEqual(codex.getModelPolicy("mock-codex-1"), { model: "gpt-next", reasoningEffort: "high" });
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已设置 Codex 模型")));
  const status = channel.sentMessages.find((message) => message.text.includes("**Codex 状态**"))?.text ?? "";
  assert.ok(status.includes("模型覆盖: 模型 `gpt-next`，思考程度 `xhigh`"));
});

test("Bridge model command rejects unknown models and invalid or unsupported efforts", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/model gpt-missing xhigh");
  await channel.emitText("/model gpt-next impossible");
  await channel.emitText("/model gpt-test xhigh");
  await bridge.stop();

  assert.deepEqual(codex.getModelPolicy(), {});
  assert.ok(channel.sentMessages.some((message) => message.text.includes("未找到模型: `gpt-missing`")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("未知思考程度: `impossible`")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("模型 `gpt-test` 不支持思考程度 `xhigh`")));
});

test("Bridge switches persistent collaboration mode with /plan and /code", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/help");
  await channel.emitText("/plan");
  await channel.emitText("/status");
  await channel.emitText("继续规划");
  await bridge.waitForIdle();
  await channel.emitText("/code");
  await channel.emitText("/code 按计划实现");
  await bridge.waitForIdle();
  await channel.emitText("/default 默认别名任务");
  await bridge.waitForIdle();
  await bridge.stop();

  const help = channel.sentMessages.find((message) => message.text.startsWith("**可用命令**"))?.text ?? "";
  assert.ok(help.includes("- `/plan [任务]`: 进入计划模式，或用计划模式处理任务。"));
  assert.ok(help.includes("- `/code [任务]`: 切回默认执行模式，或用默认模式处理任务。"));
  assert.equal(help.includes("`/default`"), false);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已进入 Plan mode")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已切回默认执行模式")));
  const status = channel.sentMessages.find((message) => message.text.includes("**Codex 状态**"))?.text ?? "";
  assert.ok(status.includes("协作模式: 计划模式"));
  assert.deepEqual(codex.runs.map((run) => run.collaborationMode), ["plan", "default", "default"]);
  assert.equal(codex.runs[1].prompt, "按计划实现");
  assert.equal(codex.runs[2].prompt, "默认别名任务");
});

test("Bridge /plan with inline prompt keeps later prompts in plan mode", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/plan 先给我方案");
  await bridge.waitForIdle();
  await channel.emitText("继续细化这个方案");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.deepEqual(codex.runs.map((run) => run.collaborationMode), ["plan", "plan"]);
  assert.deepEqual(codex.runs.map((run) => run.prompt), ["先给我方案", "继续细化这个方案"]);
});

test("Bridge manages experimental goal commands for the current session", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/help");
  await channel.emitText("/goal");
  await channel.emitText("/goal 完成微信 Goal 适配并保持测试通过");
  await channel.emitText("/status");
  await channel.emitText("/goal pause");
  await channel.emitText("/goal resume");
  await channel.emitText("/goal clear");
  await channel.emitText("/goal");
  await bridge.stop();

  const help = channel.sentMessages.find((message) => message.text.startsWith("**可用命令**"))?.text ?? "";
  assert.ok(help.includes("- `/goal [目标]`: 查看或设置当前会话的实验 Goal 长期目标。"));
  assert.ok(help.includes("  - `/goal pause`: 暂停 Goal"));
  assert.ok(help.includes("暂停 Goal，保留目标"));
  assert.ok(help.includes("  - `/goal resume`: 恢复 Goal"));
  assert.ok(help.includes("恢复 Goal，继续按已暂停的目标推进"));
  assert.ok(help.includes("  - `/goal clear`: 清除 Goal"));
  assert.ok(help.includes("清除 Goal，退出当前会话的 Goal 追踪"));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("当前没有绑定 Codex 会话，也没有 Goal")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已设置 Goal")));
  const status = channel.sentMessages.find((message) => message.text.includes("**Codex 状态**"))?.text ?? "";
  assert.ok(status.includes("长期目标 (/goal): 进行中 - 完成微信 Goal 适配并保持测试通过"));
  assert.ok(status.includes("目标 token: `0`"));
  assert.ok(status.includes("目标耗时: `0s`"));
  assert.match(status, new RegExp(`目标更新时间: \`20\\d\\d-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d（${escapeRegExp(currentTimeZone())}）\``));
  assert.doesNotMatch(status, /北京时间/);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已暂停 Goal") && message.text.includes("Status: `paused`")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已恢复 Goal") && message.text.includes("Status: `active`")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已清除 Goal")));
  assert.ok(channel.sentMessages.at(-1)?.text.includes("当前没有 Goal"));
});

test("Bridge status renders Goal updated time in the local machine timezone", async () => {
  const channel = new MockChannelAdapter();
  const codex = new FixedGoalTimeCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/goal 固定时间 Goal");
  await channel.emitText("/status");
  await bridge.stop();

  const status = channel.sentMessages.find((message) => message.text.includes("**Codex 状态**"))?.text ?? "";
  assert.ok(status.includes(`目标更新时间: \`${formatLocalDateTimeWithZone(1700000000)}\``));
  assert.doesNotMatch(status, /北京时间/);
  assert.doesNotMatch(status, /目标更新时间: `[^`]*T[^`]*Z`/);
});

test("Bridge rejects collaboration mode changes while a route is busy", async () => {
  const channel = new MockChannelAdapter();
  const codex = new BlockingModeCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("第一条");
  await waitFor(() => codex.modeRuns.length === 1);
  await channel.emitText("第二条");
  await channel.emitText("/plan");
  await channel.emitText("第三条");
  codex.release();
  await bridge.waitForIdle();
  await bridge.stop();

  assert.deepEqual(codex.modeRuns, [undefined, undefined, undefined]);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("不能修改会话、权限、模型、协作模式或 Goal")));
});

test("Bridge steers ordinary text into the active route turn", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), steerDebounceMs: 1 });

  await bridge.start();
  await channel.emitText("第一条");
  await waitFor(() => codex.prompts.length === 1);
  await channel.emitText("补充信息");
  await waitFor(() => codex.steers.length === 1);

  codex.release();
  await bridge.waitForIdle();
  await bridge.stop();

  assert.deepEqual(codex.prompts, ["第一条"]);
  assert.equal(codex.steers[0]?.prompt, "补充信息");
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已投递到当前 Codex 任务")));
  assert.equal(channel.sentMessages.some((message) => message.text.includes("已加入队列")), false);
});

test("Bridge prefixes only group ordinary prompts with speaker names", async () => {
  const channel = new MockChannelAdapter({ id: "feishu", accountId: "work" });
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), feishuGroupMemberStateRootDir: tempStateRoot("bridge-group-members-") });

  await bridge.start();
  await channel.emitText("/name 小黄", {
    conversationKind: "group",
    conversationId: "oc_group",
    senderId: "ou_xh",
    senderDisplayName: "小黄",
  });
  await channel.emitText("/status", {
    conversationKind: "group",
    conversationId: "oc_group",
    senderId: "ou_xh",
    senderDisplayName: "小黄",
  });
  await channel.emitText("检查群聊上下文", {
    conversationKind: "group",
    conversationId: "oc_group",
    senderId: "ou_xh",
    senderDisplayName: "小黄",
  });
  await bridge.waitForIdle();
  await channel.emitText("私聊原文", {
    conversationId: "oc_direct",
    senderId: "ou_xh",
    senderDisplayName: "小黄",
  });
  await bridge.waitForIdle();
  await bridge.stop();

  assert.deepEqual(codex.prompts, ["小黄说：检查群聊上下文", "私聊原文"]);
});

test("Bridge prefixes group media prompts while preserving attachments", async () => {
  const channel = new MockChannelAdapter({ id: "feishu", accountId: "work" });
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), feishuGroupMemberStateRootDir: tempStateRoot("bridge-group-media-members-") });
  const imagePath = "/tmp/chat-codex-group-direct.png";

  await bridge.start();
  await channel.emitText("/name 小黄", {
    conversationKind: "group",
    conversationId: "oc_group",
    senderId: "ou_xh",
    senderDisplayName: "小黄",
  });
  await channel.emitAttachment([mockImageAttachment(imagePath)], {
    text: "检查这个 UI",
    conversationKind: "group",
    conversationId: "oc_group",
    senderId: "ou_xh",
    senderDisplayName: "小黄",
  });
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.promptInputs.length, 1);
  assert.deepEqual(codex.promptInputs[0]?.items, [
    { type: "text", text: "小黄说：检查这个 UI" },
    { type: "localImage", path: imagePath },
  ]);
});

test("Bridge prefixes group mid-turn steers as speaker supplements", async () => {
  const channel = new MockChannelAdapter({ id: "feishu", accountId: "work" });
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), steerDebounceMs: 1, feishuGroupMemberStateRootDir: tempStateRoot("bridge-group-steer-members-") });

  await bridge.start();
  await channel.emitText("/name 小黄", {
    conversationKind: "group",
    conversationId: "oc_group",
    senderId: "ou_xh",
    senderDisplayName: "小黄",
  });
  await channel.emitText("/name 小红", {
    conversationKind: "group",
    conversationId: "oc_group",
    senderId: "ou_xr",
    senderDisplayName: "小红",
  });
  await channel.emitText("第一条", {
    conversationKind: "group",
    conversationId: "oc_group",
    senderId: "ou_xh",
    senderDisplayName: "小黄",
  });
  await waitFor(() => codex.prompts.length === 1);
  await channel.emitText("补充信息", {
    conversationKind: "group",
    conversationId: "oc_group",
    senderId: "ou_xr",
    senderDisplayName: "小红",
  });
  await waitFor(() => codex.steers.length === 1);

  codex.release();
  await bridge.waitForIdle();
  await bridge.stop();

  assert.deepEqual(codex.prompts, ["小黄说：第一条"]);
  assert.equal(codex.steers[0]?.prompt, "小红补充：补充信息");
});

test("Bridge requires Feishu group member registration before ordinary prompts", async () => {
  const channel = new MockChannelAdapter({ id: "feishu", accountId: "work" });
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), feishuGroupMemberStateRootDir: tempStateRoot("bridge-group-registration-") });

  await bridge.start();
  await channel.emitText("先帮我看一下", {
    conversationKind: "group",
    conversationId: "oc_group",
    senderId: "ou_xh",
    senderDisplayName: "事件名不应直接使用",
  });
  await bridge.waitForIdle();
  assert.equal(codex.runs.length, 0);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("@Bot /name 小黄")));

  await channel.emitText("/name 小黄", {
    conversationKind: "group",
    conversationId: "oc_group",
    senderId: "ou_xh",
    senderDisplayName: "事件名不应直接使用",
  });
  await channel.emitText("/whoami", {
    conversationKind: "group",
    conversationId: "oc_group",
    senderId: "ou_xh",
  });
  await channel.emitText("继续处理", {
    conversationKind: "group",
    conversationId: "oc_group",
    senderId: "ou_xh",
  });
  await bridge.waitForIdle();
  await bridge.stop();

  assert.ok(channel.sentMessages.some((message) => message.text.includes("已记录你在当前群的展示名：小黄")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("成员登记: 已完成")));
  assert.equal(codex.runs.at(-1)?.prompt, "小黄说：继续处理");
});

test("Bridge shows Feishu group-only member commands in group help", async () => {
  const channel = new MockChannelAdapter({ id: "feishu", accountId: "work" });
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), feishuGroupMemberStateRootDir: tempStateRoot("bridge-group-help-") });

  await bridge.start();
  await channel.emitText("/help", {
    conversationKind: "group",
    conversationId: "oc_group",
    senderId: "ou_xh",
  });
  await channel.emitText("/help", {
    conversationKind: "direct",
    conversationId: "oc_direct",
    senderId: "ou_xh",
  });
  await bridge.stop();

  const groupHelp = channel.sentMessages[0]?.text ?? "";
  const directHelp = channel.sentMessages[1]?.text ?? "";
  assert.ok(groupHelp.includes("- `/name <名称>`"));
  assert.ok(groupHelp.includes("- `/name`: 查看你在当前飞书群里的展示名登记状态。"));
  assert.ok(groupHelp.includes("- `/whoami`: 查看当前飞书群员身份、登记状态和群配对状态。"));
  assert.equal(directHelp.includes("/name <名称>"), false);
  assert.equal(directHelp.includes("当前飞书群员身份"), false);
});

test("Bridge batches consecutive route steers in order", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), steerDebounceMs: 20, steerBatchMaxMessages: 5 });

  await bridge.start();
  await channel.emitText("第一条");
  await waitFor(() => codex.prompts.length === 1);
  await channel.emitText("补充 A");
  await channel.emitText("补充 B");
  await channel.emitText("补充 C");
  await waitFor(() => codex.steers.length === 1);

  codex.release();
  await bridge.waitForIdle();
  await bridge.stop();

  assert.match(codex.steers[0]?.prompt ?? "", /用户补充消息 1:\n补充 A/);
  assert.match(codex.steers[0]?.prompt ?? "", /用户补充消息 2:\n补充 B/);
  assert.match(codex.steers[0]?.prompt ?? "", /用户补充消息 3:\n补充 C/);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已投递 3 条补充消息")));
});

test("Bridge falls back to the route queue when steer is rejected", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  codex.failSteer = true;
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), steerDebounceMs: 1 });

  await bridge.start();
  await channel.emitText("第一条");
  await waitFor(() => codex.prompts.length === 1);
  await channel.emitText("补充信息");
  await waitFor(() => channel.sentMessages.some((message) => message.text.includes("已加入队列")));

  codex.release();
  await bridge.waitForIdle();
  await bridge.stop();

  assert.deepEqual(codex.prompts, ["第一条", "补充信息"]);
  assert.equal(codex.steers.length, 0);
  assert.ok(channel.sentMessages.some((message) => message.text === "完成: 补充信息"));
});

test("Bridge keeps commands out of mid-turn steer while a route is busy", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), steerDebounceMs: 1 });

  await bridge.start();
  await channel.emitText("第一条");
  await waitFor(() => codex.prompts.length === 1);
  await channel.emitText("/plan");

  codex.release();
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.steers.length, 0);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("不能修改会话、权限、模型、协作模式或 Goal")));
});

test("Bridge reports and clears pending route steer messages with /stop", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), steerDebounceMs: 1000 });

  await bridge.start();
  await channel.emitText("第一条");
  await waitFor(() => codex.prompts.length === 1);
  await channel.emitText("补充信息");
  await channel.emitText("/status");
  const statusMessage = channel.sentMessages.at(-1)?.text ?? "";
  await channel.emitText("/stop");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.match(statusMessage, /待投递补充消息: `1`/);
  assert.equal(codex.steers.length, 0);
  assert.deepEqual(codex.prompts, ["第一条"]);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已清空 1 条待投递补充消息")));
});

test("Bridge scopes mid-turn steer to the originating route", async () => {
  const channelA = new MockChannelAdapter({ id: "mock-a" });
  const channelB = new MockChannelAdapter({ id: "mock-b" });
  const registry = new ChannelRegistry({ channels: [channelA, channelB] });
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channels: registry, codex, cwd: process.cwd(), steerDebounceMs: 1 });

  await bridge.start();
  await channelA.emitText("A 长任务");
  await waitFor(() => codex.prompts.length === 1);
  await channelA.emitText("A 补充");
  await channelB.emitText("B 普通任务");
  await waitFor(() => codex.steers.length === 1);
  await waitFor(() => channelB.sentMessages.some((message) => message.text === "完成: B 普通任务"));

  codex.release();
  await bridge.waitForIdle();
  await bridge.stop();

  assert.deepEqual(codex.prompts, ["A 长任务", "B 普通任务"]);
  assert.equal(codex.steers[0]?.prompt, "A 补充");
  assert.notEqual(codex.steers[0]?.sessionId, codex.promptRuns.find((run) => run.prompt === "B 普通任务")?.sessionId);
  assert.equal(channelB.sentMessages.some((message) => message.text.includes("已投递到当前 Codex 任务")), false);
});

test("Bridge stores image-only messages as pending media without running Codex", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitAttachment([mockImageAttachment("/tmp/chat-codex-image-only.png")]);
  await channel.emitText("/status");
  await bridge.stop();

  assert.deepEqual(codex.prompts, []);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("【Chat-Codex中间件提醒】")));
  const status = channel.sentMessages.at(-1)?.text ?? "";
  assert.match(status, /待处理附件: `1`/);
});

test("Bridge combines pending image-only media with the next ordinary text", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });
  const imagePath = "/tmp/chat-codex-pending.png";

  await bridge.start();
  await channel.emitAttachment([mockImageAttachment(imagePath)]);
  await channel.emitText("解释这张图");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.promptInputs.length, 1);
  assert.deepEqual(codex.promptInputs[0]?.items, [
    { type: "text", text: "解释这张图" },
    { type: "localImage", path: imagePath },
  ]);
});

test("Bridge combines pending file-only media with the next ordinary text", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });
  const filePath = "/tmp/chat-codex-report.pdf";

  await bridge.start();
  await channel.emitAttachment([mockFileAttachment(filePath)]);
  await channel.emitText("总结这个文件");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.promptInputs.length, 1);
  assert.deepEqual(codex.promptInputs[0]?.items, [
    { type: "text", text: "总结这个文件" },
    { type: "localFile", path: filePath, name: "chat-codex-report.pdf", mimeType: "application/pdf" },
  ]);
});

test("Bridge sends same-message text and image directly to Codex", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });
  const imagePath = "/tmp/chat-codex-direct.png";

  await bridge.start();
  await channel.emitAttachment([mockImageAttachment(imagePath)], { text: "检查这个 UI" });
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.promptInputs.length, 1);
  assert.deepEqual(codex.promptInputs[0]?.items, [
    { type: "text", text: "检查这个 UI" },
    { type: "localImage", path: imagePath },
  ]);
});

test("Bridge sends same-message text and file directly to Codex", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });
  const filePath = "/tmp/chat-codex-input.txt";

  await bridge.start();
  await channel.emitAttachment([mockFileAttachment(filePath, "text/plain")], { text: "检查这个文件" });
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.promptInputs.length, 1);
  assert.deepEqual(codex.promptInputs[0]?.items, [
    { type: "text", text: "检查这个文件" },
    { type: "localFile", path: filePath, name: "chat-codex-input.txt", mimeType: "text/plain" },
  ]);
});

test("Bridge caps same-message image and file attachments at five", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });
  const attachments = [
    mockImageAttachment("/tmp/chat-codex-cap-1.png"),
    mockFileAttachment("/tmp/chat-codex-cap-2.txt", "text/plain"),
    mockImageAttachment("/tmp/chat-codex-cap-3.png"),
    mockFileAttachment("/tmp/chat-codex-cap-4.pdf"),
    mockImageAttachment("/tmp/chat-codex-cap-5.png"),
    mockFileAttachment("/tmp/chat-codex-cap-6.txt", "text/plain"),
  ];

  await bridge.start();
  await channel.emitAttachment(attachments, { text: "处理这些附件" });
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.promptInputs.length, 1);
  assert.deepEqual(codex.promptInputs[0]?.items, [
    { type: "text", text: "处理这些附件" },
    { type: "localImage", path: "/tmp/chat-codex-cap-1.png" },
    { type: "localFile", path: "/tmp/chat-codex-cap-2.txt", name: "chat-codex-cap-2.txt", mimeType: "text/plain" },
    { type: "localImage", path: "/tmp/chat-codex-cap-3.png" },
    { type: "localFile", path: "/tmp/chat-codex-cap-4.pdf", name: "chat-codex-cap-4.pdf", mimeType: "application/pdf" },
    { type: "localImage", path: "/tmp/chat-codex-cap-5.png" },
  ]);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("本次最多投递 5 个附件给 Codex")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("有 1 个附件未交给 Codex")));
});

test("Bridge keeps pending media scoped to the originating route", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });
  const imageA = "/tmp/chat-codex-route-a.png";
  const imageB = "/tmp/chat-codex-route-b.png";

  await bridge.start();
  await channel.emitAttachment([mockImageAttachment(imageA)], { senderId: "alice", conversationId: "alice" });
  await channel.emitAttachment([mockImageAttachment(imageB)], { senderId: "bob", conversationId: "bob" });
  await channel.emitText("处理 B 的图", { senderId: "bob", conversationId: "bob" });
  await bridge.waitForIdle();
  await channel.emitText("/status", { senderId: "alice", conversationId: "alice" });
  await bridge.stop();

  assert.equal(codex.promptInputs.length, 1);
  assert.deepEqual(codex.promptInputs[0]?.items, [
    { type: "text", text: "处理 B 的图" },
    { type: "localImage", path: imageB },
  ]);
  assert.match(channel.sentMessages.at(-1)?.text ?? "", /待处理附件: `1`/);
});

test("Bridge caps pending mixed image and file media at five", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitAttachment([
    mockImageAttachment("/tmp/chat-codex-pending-cap-1.png"),
    mockFileAttachment("/tmp/chat-codex-pending-cap-2.txt", "text/plain"),
    mockImageAttachment("/tmp/chat-codex-pending-cap-3.png"),
    mockFileAttachment("/tmp/chat-codex-pending-cap-4.pdf"),
    mockImageAttachment("/tmp/chat-codex-pending-cap-5.png"),
    mockFileAttachment("/tmp/chat-codex-pending-cap-6.txt", "text/plain"),
  ]);
  await channel.emitText("/status");
  await bridge.stop();

  assert.deepEqual(codex.prompts, []);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("待处理附件最多保留 5 个")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("本次有 1 个未加入待处理附件")));
  assert.match(channel.sentMessages.at(-1)?.text ?? "", /待处理附件: `5`/);
});

test("Bridge cancels pending media with /cancel", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitAttachment([mockImageAttachment("/tmp/chat-codex-cancel.png")]);
  await channel.emitText("/cancel");
  await channel.emitText("/status");
  await bridge.stop();

  assert.deepEqual(codex.prompts, []);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已取消 1 个待处理附件")));
  assert.match(channel.sentMessages.at(-1)?.text ?? "", /待处理附件: `0`/);
});

test("Bridge clears pending media with /stop", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/new");
  await channel.emitAttachment([mockImageAttachment("/tmp/chat-codex-stop.png")]);
  await channel.emitText("/stop");
  await channel.emitText("/status");
  await bridge.stop();

  assert.ok(channel.sentMessages.some((message) => message.text.includes("已清空 1 个待处理附件")));
  assert.match(channel.sentMessages.at(-1)?.text ?? "", /待处理附件: `0`/);
});

test("Bridge steers text plus image into the active route turn", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), steerDebounceMs: 1 });
  const imagePath = "/tmp/chat-codex-steer.png";

  await bridge.start();
  await channel.emitText("第一条");
  await waitFor(() => codex.prompts.length === 1);
  await channel.emitAttachment([mockImageAttachment(imagePath)], { text: "补充截图" });
  await waitFor(() => codex.steerInputs.length === 1);

  codex.release();
  await bridge.waitForIdle();
  await bridge.stop();

  assert.deepEqual(codex.steerInputs[0]?.items, [
    { type: "text", text: "补充截图" },
    { type: "localImage", path: imagePath },
  ]);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已投递到当前 Codex 任务")));
});

test("Bridge keeps image-only media pending while the route is busy", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), steerDebounceMs: 1 });
  const imagePath = "/tmp/chat-codex-busy-pending.png";

  await bridge.start();
  await channel.emitText("第一条");
  await waitFor(() => codex.prompts.length === 1);
  await channel.emitAttachment([mockImageAttachment(imagePath)]);
  await channel.emitText("/status");
  const status = channel.sentMessages.at(-1)?.text ?? "";
  await channel.emitText("这张图用于补充当前任务");
  await waitFor(() => codex.steerInputs.length === 1);

  codex.release();
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.steerInputs.length, 1);
  assert.match(status, /待处理附件: `1`/);
  assert.deepEqual(codex.steerInputs[0]?.items, [
    { type: "text", text: "这张图用于补充当前任务" },
    { type: "localImage", path: imagePath },
  ]);
});

test("Bridge steers text plus file into the active route turn", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), steerDebounceMs: 1 });
  const filePath = "/tmp/chat-codex-steer.txt";

  await bridge.start();
  await channel.emitText("第一条");
  await waitFor(() => codex.prompts.length === 1);
  await channel.emitAttachment([mockFileAttachment(filePath, "text/plain")], { text: "补充文件" });
  await waitFor(() => codex.steerInputs.length === 1);

  codex.release();
  await bridge.waitForIdle();
  await bridge.stop();

  assert.deepEqual(codex.steerInputs[0]?.items, [
    { type: "text", text: "补充文件" },
    { type: "localFile", path: filePath, name: "chat-codex-steer.txt", mimeType: "text/plain" },
  ]);
});

test("Bridge starts a new turn when pending media is described after the busy turn ends", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), steerDebounceMs: 1 });
  const imagePath = "/tmp/chat-codex-after-busy.png";

  await bridge.start();
  await channel.emitText("第一条");
  await waitFor(() => codex.prompts.length === 1);
  await channel.emitAttachment([mockImageAttachment(imagePath)]);
  codex.release();
  await bridge.waitForIdle();
  await channel.emitText("现在处理刚才那张图");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.promptInputs.length, 2);
  assert.deepEqual(codex.promptInputs[1]?.items, [
    { type: "text", text: "现在处理刚才那张图" },
    { type: "localImage", path: imagePath },
  ]);
});

test("Bridge falls back to route queue with image input when structured steer is rejected", async () => {
  const channel = new MockChannelAdapter();
  const codex = new SteerableBlockingCodexAdapter();
  codex.failSteer = true;
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), steerDebounceMs: 1 });
  const imagePath = "/tmp/chat-codex-steer-fallback.png";

  await bridge.start();
  await channel.emitText("第一条");
  await waitFor(() => codex.prompts.length === 1);
  await channel.emitAttachment([mockImageAttachment(imagePath)], { text: "补充失败后排队" });
  await waitFor(() => channel.sentMessages.some((message) => message.text.includes("已加入队列")));

  codex.release();
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.promptInputs.length, 2);
  assert.deepEqual(codex.promptInputs[1]?.items, [
    { type: "text", text: "补充失败后排队" },
    { type: "localImage", path: imagePath },
  ]);
});

test("Bridge rejects semantic mutations while the current route is busy", async () => {
  const channel = new MockChannelAdapter();
  const codex = new BlockingModeCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/new");
  await channel.emitText("/goal 保持目标");
  await channel.emitText("第一条");
  await waitFor(() => codex.modeRuns.length === 1);

  await channel.emitText("/permission full confirm");
  await channel.emitText("/model gpt-next xhigh");
  await channel.emitText("/plan");
  await channel.emitText("/goal clear");
  await channel.emitText("/status");
  await channel.emitText("/progress silent");
  await channel.emitText("/status");

  codex.release();
  await bridge.waitForIdle();
  await bridge.stop();

  const rejectMessages = channel.sentMessages.filter((message) => message.text.includes("不能修改会话、权限、模型、协作模式或 Goal"));
  assert.equal(rejectMessages.length, 4);
  assert.equal(codex.getRunPolicy("mock-codex-1").permissionMode, "approval");
  assert.deepEqual(codex.getModelPolicy("mock-codex-1"), {});
  assert.equal(codex.getCollaborationMode("mock-codex-1"), "default");
  assert.equal((await codex.getGoal("mock-codex-1"))?.objective, "保持目标");
  const statusMessages = channel.sentMessages.filter((message) => message.text.includes("**Codex 状态**"));
  assert.ok(statusMessages.some((message) => message.text.includes("处理状态: 正在处理")));
  assert.ok(statusMessages.at(-1)?.text.includes("进度投递: 静默"));
});

test("Bridge treats pending approvals as busy for semantic mutations", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/new");
  await channel.emitText("请触发审批 approval");
  await bridge.waitForIdle();
  await channel.emitText("/model gpt-next xhigh");
  await channel.emitText("/OK");
  await channel.emitText("/model gpt-next xhigh");
  await bridge.stop();

  assert.ok(channel.sentMessages.some((message) => message.text.includes("不能修改会话、权限、模型、协作模式或 Goal")));
  assert.deepEqual(codex.getModelPolicy("mock-codex-1"), { model: "gpt-next", reasoningEffort: "xhigh" });
  const setMessages = channel.sentMessages.filter((message) => message.text.includes("已设置 Codex 模型"));
  assert.equal(setMessages.length, 1);
});

test("Bridge keeps route busy mutation guard scoped to the active route", async () => {
  const channelA = new MockChannelAdapter({ id: "mock-a" });
  const channelB = new MockChannelAdapter({ id: "mock-b" });
  const registry = new ChannelRegistry({ channels: [channelA, channelB] });
  const codex = new BlockingModeCodexAdapter();
  const bridge = new Bridge({ channels: registry, codex, cwd: process.cwd() });

  await bridge.start();
  await channelA.emitText("第一条");
  await waitFor(() => codex.modeRuns.length === 1);
  await channelB.emitText("/new");
  await channelB.emitText("/permission full confirm");
  await channelA.emitText("/permission full confirm");

  codex.release();
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.getRunPolicy("mock-codex-1").permissionMode, "approval");
  assert.equal(codex.getRunPolicy("mock-codex-2").permissionMode, "full");
  assert.ok(channelA.sentMessages.some((message) => message.text.includes("不能修改会话、权限、模型、协作模式或 Goal")));
  assert.ok(channelB.sentMessages.some((message) => message.text.includes("已切换 Codex 权限模式: full")));
});

test("Bridge rejects numbered session selection while the route is busy", async () => {
  const channel = new MockChannelAdapter();
  const codex = new ManualBackgroundCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/new");
  await channel.emitText("/new");
  await channel.emitText("/use");
  const background = codex.startBlockingBackground("mock-codex-2");
  await waitFor(() => codex.backgroundStarted);
  await channel.emitText("2");

  codex.release();
  await background;
  await bridge.waitForIdle();
  await channel.emitText("/status");
  await bridge.stop();

  assert.ok(channel.sentMessages.some((message) => message.text.includes("不能修改会话、权限、模型、协作模式或 Goal")));
  assert.ok(channel.sentMessages.at(-1)?.text.includes("当前会话: `mock-codex-2`"));
});

test("Bridge does not crash when channel text delivery fails", async () => {
  const channel = new FailingSendChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await assert.doesNotReject(async () => {
    await channel.emitText("/status");
    await channel.emitText("即使微信发送失败也要完成 turn");
    await bridge.waitForIdle();
  });
  await bridge.stop();

  assert.ok(channel.sentAttempts >= 3);
});

test("Bridge rejects latest approval with /NO", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("请触发审批 approval");
  await bridge.waitForIdle();
  assert.ok(channel.sentMessages.some((message) => message.text.includes("Codex 请求审批")));

  await channel.emitText("/NO 这个命令会删除文件");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.resolvedApprovals.length, 1);
  assert.match(codex.resolvedApprovals[0].approvalKey, /^a[0-9a-z]+$/);
  assert.equal(codex.resolvedApprovals[0].decision, "deny");
  assert.equal(channel.sentMessages.some((message) => message.text.includes("理由: 这个命令会删除文件")), false);
});

test("Bridge resolves approvals with adapter approval ids when provided", async () => {
  const channel = new MockChannelAdapter();
  const codex = new AdapterApprovalIdCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("触发 app-server 审批");
  await bridge.waitForIdle();
  await channel.emitText("/OK");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.resolvedApprovals.length, 1);
  assert.equal(codex.resolvedApprovals[0].approvalKey, "server-request-1");
  assert.equal(codex.resolvedApprovals[0].decision, "approve");
});

test("Bridge approves latest approval for the current session with /P", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("请触发审批 approval");
  await bridge.waitForIdle();
  await channel.emitText("/P");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.resolvedApprovals.length, 1);
  assert.equal(codex.resolvedApprovals[0].decision, "approve-session");
  assert.ok(channel.sentMessages.some((message) => message.text.includes("审批已处理: 已按本会话通过")));
});

test("Bridge retries approval notifications until one is delivered", async () => {
  const channel = new ApprovalFlakyChannelAdapter(2);
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), approvalSendRetryDelayMs: 1 });

  await bridge.start();
  await channel.emitText("请触发审批 approval");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(channel.approvalAttempts, 3);
  const deliveredApprovals = channel.sentMessages.filter((message) => message.text.includes("Codex 请求审批"));
  assert.equal(deliveredApprovals.length, 1);
  assert.ok(deliveredApprovals[0].text.includes("/OK 通过当前审批"));
});

test("Bridge stops retrying approval notification after approval is resolved", async () => {
  const channel = new ApprovalFlakyChannelAdapter(Number.POSITIVE_INFINITY);
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), approvalSendRetryDelayMs: 20 });

  await bridge.start();
  await channel.emitText("请触发审批 approval");
  await waitForTest(() => channel.approvalAttempts > 0);
  await channel.emitText("/status");
  const statusMessage = channel.sentMessages.at(-1)?.text ?? "";
  assert.ok(statusMessage.includes("**待处理审批**"));
  assert.ok(statusMessage.includes("```text\n/OK\n```"));
  assert.ok(statusMessage.includes("```text\n/P\n```"));
  assert.ok(statusMessage.includes("```text\n/NO\n```"));
  await channel.emitText("/OK");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(channel.sentMessages.some((message) => message.text.includes("Codex 请求审批")), false);
  assert.equal(codex.resolvedApprovals.length, 1);
  assert.equal(codex.resolvedApprovals[0].decision, "approve");
});

test("Bridge answers request_user_input with /a commands", async () => {
  const channel = new MockChannelAdapter();
  const codex = new RequestUserInputCodexAdapter([choiceQuestion()]);
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("需要中途选择");
  await waitFor(() => channel.sentMessages.some((message) => message.text.includes("Codex 暂停了当前任务，需要你确认后继续")));
  await channel.emitText("这不是答案");
  await channel.emitText("/a2 先别改配置文件");
  await bridge.waitForIdle();
  await bridge.stop();

  const prompt = channel.sentMessages.find((message) => message.text.includes("Codex 暂停了当前任务，需要你确认后继续"))?.text ?? "";
  assert.ok(prompt.includes("直接回复下面一条命令"));
  assert.ok(prompt.includes("/a1 Yes (Recommended)"));
  assert.ok(prompt.includes("/a2 No"));
  assert.ok(prompt.includes("/a3 其他：你的建议"));
  assert.equal(prompt.includes("1. Yes"), false);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("/a0 跳过这个问题")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("Codex 会自己决定下一步")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("正在等待你的选择")));
  assert.deepEqual(codex.resolvedInputs[0]?.response.answers.confirm_path.answers, [
    "No",
    "user_note: 先别改配置文件",
  ]);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("input result No|user_note: 先别改配置文件")));
});

test("Bridge treats /a0 as unanswered instead of stopping the turn", async () => {
  const channel = new MockChannelAdapter();
  const codex = new RequestUserInputCodexAdapter([choiceQuestion()]);
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("需要跳过");
  await waitFor(() => channel.sentMessages.some((message) => message.text.includes("Codex 暂停了当前任务，需要你确认后继续")));
  await channel.emitText("/a0");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.deepEqual(codex.resolvedInputs[0]?.response.answers.confirm_path.answers, []);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("input result")));
});

test("Bridge answers request_user_input freeform questions with /a1 text", async () => {
  const channel = new MockChannelAdapter();
  const codex = new RequestUserInputCodexAdapter([{
    id: "custom_suggestion",
    header: "补充建议",
    question: "你希望 Codex 怎么处理？",
    isOther: false,
    isSecret: false,
    options: [],
  }]);
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("需要文字回答");
  await waitFor(() => channel.sentMessages.some((message) => message.text.includes("这个问题没有预设选项")));
  await channel.emitText("/a1 先只改测试，不动生产逻辑");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.deepEqual(codex.resolvedInputs[0]?.response.answers.custom_suggestion.answers, [
    "user_note: 先只改测试，不动生产逻辑",
  ]);
});

test("Bridge handles multi-question request_user_input sequentially", async () => {
  const channel = new MockChannelAdapter();
  const codex = new RequestUserInputCodexAdapter([
    choiceQuestion(),
    {
      id: "follow_up",
      header: "补充说明",
      question: "还需要额外限制吗？",
      isOther: false,
      isSecret: false,
      options: [
        { label: "No", description: "没有额外限制。" },
        { label: "Yes", description: "需要额外限制。" },
      ],
    },
  ]);
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("需要连续回答");
  await waitFor(() => channel.sentMessages.some((message) => message.text.includes("问题 1/2")));
  await channel.emitText("/a1");
  await waitFor(() => channel.sentMessages.some((message) => message.text.includes("问题 2/2")));
  await channel.emitText("/a2 只能小范围修改");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.deepEqual(codex.resolvedInputs[0]?.response.answers.confirm_path.answers, ["Yes (Recommended)"]);
  assert.deepEqual(codex.resolvedInputs[0]?.response.answers.follow_up.answers, [
    "Yes",
    "user_note: 只能小范围修改",
  ]);
});

test("Bridge delivers request_user_input prompts on weixin even when progress is suppressed", async () => {
  const channel = new WeixinLikeChannelAdapter();
  const codex = new RequestUserInputCodexAdapter([choiceQuestion()]);
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("微信也要提示");
  await waitFor(() => channel.sentMessages.some((message) => message.text.includes("Codex 暂停了当前任务，需要你确认后继续")));
  await channel.emitText("/a1");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.deepEqual(codex.resolvedInputs[0]?.response.answers.confirm_path.answers, ["Yes (Recommended)"]);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("/a0 跳过这个问题")));
});

test("Bridge only accepts group request_user_input answers from the task initiator", async () => {
  const channel = new MockChannelAdapter();
  const codex = new RequestUserInputCodexAdapter([choiceQuestion()]);
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("群聊需要选择", { conversationKind: "group", conversationId: "group-1", senderId: "alice" });
  await waitFor(() => channel.sentMessages.some((message) => message.text.includes("Codex 暂停了当前任务，需要你确认后继续")));
  await channel.emitText("/a1", { conversationKind: "group", conversationId: "group-1", senderId: "bob" });
  assert.equal(codex.resolvedInputs.length, 0);
  await channel.emitText("/a1", { conversationKind: "group", conversationId: "group-1", senderId: "alice" });
  await bridge.waitForIdle();
  await bridge.stop();

  assert.ok(channel.sentMessages.some((message) => message.text.includes("只接受本轮任务发起人回答")));
  assert.deepEqual(codex.resolvedInputs[0]?.response.answers.confirm_path.answers, ["Yes (Recommended)"]);
});

test("Bridge times out request_user_input as unanswered", async () => {
  const channel = new MockChannelAdapter();
  const codex = new RequestUserInputCodexAdapter([choiceQuestion()]);
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), requestUserInputTimeoutMs: 20 });

  await bridge.start();
  await channel.emitText("等待超时");
  await waitFor(() => codex.resolvedInputs.length === 1, 1000);
  await bridge.waitForIdle();
  await bridge.stop();

  assert.deepEqual(codex.resolvedInputs[0]?.response.answers.confirm_path.answers, []);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("等待选择已超时")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("Codex 会自己决定下一步")));
});

test("Bridge auto-cancels MCP approval compatibility request_user_input", async () => {
  const channel = new MockChannelAdapter();
  const codex = new RequestUserInputCodexAdapter([{
    id: "mcp_tool_call_approval_1",
    header: "Approve app tool call?",
    question: "Allow private app tool?",
    isOther: false,
    isSecret: false,
    options: [
      { label: "Allow", description: "Allow tool call." },
      { label: "Cancel", description: "Do not allow." },
    ],
  }]);
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("触发 MCP 兼容路径");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.deepEqual(codex.resolvedInputs[0]?.response.answers.mcp_tool_call_approval_1.answers, []);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("不支持 MCP/app tool 授权")));
  assert.equal(channel.sentMessages.some((message) => message.text.includes("Codex 暂停了当前任务，需要你确认后继续")), false);
});

test("Bridge does not auto-cancel ordinary allow cancel request_user_input choices", async () => {
  const channel = new MockChannelAdapter();
  const codex = new RequestUserInputCodexAdapter([{
    id: "confirm_operation",
    header: "确认操作",
    question: "是否允许继续这个普通方案？",
    isOther: false,
    isSecret: false,
    options: [
      { label: "Allow", description: "继续普通方案。" },
      { label: "Cancel", description: "跳过这个普通方案。" },
    ],
  }]);
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("普通 allow cancel");
  await waitFor(() => channel.sentMessages.some((message) => message.text.includes("Codex 暂停了当前任务，需要你确认后继续")));
  await channel.emitText("/a1");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.deepEqual(codex.resolvedInputs[0]?.response.answers.confirm_operation.answers, ["Allow"]);
  assert.equal(channel.sentMessages.some((message) => message.text.includes("不支持 MCP/app tool 授权")), false);
});

test("Bridge does not add duplicate synthetic other choice when option already asks for suggestions", async () => {
  const channel = new MockChannelAdapter();
  const codex = new RequestUserInputCodexAdapter([{
    id: "debug_choice",
    header: "测试选择",
    question: "请选择一个结果。",
    isOther: true,
    isSecret: false,
    options: [
      { label: "通过 (Recommended)", description: "确认微信里回答能正常回到 Codex。" },
      { label: "暂不通过", description: "确认补充说明能正常回传。" },
      { label: "其他建议", description: "确认自定义补充文本能正常回传。" },
    ],
  }]);
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("已有其他建议");
  await waitFor(() => channel.sentMessages.some((message) => message.text.includes("Codex 暂停了当前任务，需要你确认后继续")));
  const prompt = channel.sentMessages.find((message) => message.text.includes("Codex 暂停了当前任务，需要你确认后继续"))?.text ?? "";
  await channel.emitText("/a3 我感觉展示还可以再简化");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.ok(prompt.includes("/a3 其他建议：你的建议"));
  assert.equal(prompt.includes("/a4"), false);
  assert.deepEqual(codex.resolvedInputs[0]?.response.answers.debug_choice.answers, [
    "其他建议",
    "user_note: 我感觉展示还可以再简化",
  ]);
});

test("Bridge emits transcript events for inbound channel text and outbound replies", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const transcript = new CapturingTranscriptSink();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), transcript });

  await bridge.start();
  await channel.emitText("你好，打印到终端");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(transcript.inboundEvents.length, 1);
  assert.equal(transcript.inboundEvents[0].text, "你好，打印到终端");
  assert.ok(transcript.outboundEvents.some((event) => event.text.includes("Codex 正在处理这条消息")));
  assert.ok(transcript.outboundEvents.some((event) => event.text === "Mock Codex 回复: 你好，打印到终端"));
});

test("Bridge treats generated image refs as text for normal prompts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-media-test-"));
  const imagePath = path.join(root, "screenshot.png");
  fs.writeFileSync(imagePath, "png");
  const channel = new MockChannelAdapter({ media: true });
  const codex = new MockCodexAdapter();
  const transcript = new CapturingTranscriptSink();
  const bridge = new Bridge({ channel, codex, cwd: root, transcript });

  await bridge.start();
  await channel.emitText(`请查看截图 ${imagePath}`);
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(channel.sentMedia.length, 0);
  assert.equal(transcript.outboundMediaEvents.length, 0);
  assert.ok(channel.sentMessages.some((message) => message.text.includes(imagePath)));
});

test("Bridge does not extract media from progress events", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-progress-media-test-"));
  const imagePath = path.join(root, "progress.png");
  fs.writeFileSync(imagePath, "png");
  const channel = new MockChannelAdapter({ media: true });
  const codex = new ProgressMediaCodexAdapter(imagePath);
  const bridge = new Bridge({ channel, codex, cwd: root });

  await bridge.start();
  await channel.emitText("跑一个会列出图片路径的任务");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(channel.sentMedia.length, 0);
  assert.ok(channel.sentMessages.some((message) => message.text.includes(imagePath)));
});

test("Bridge sends final declared files for /sendfile and strips bridge protocol text", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sendfile-test-"));
  const imagePath = path.join(root, "result.png");
  fs.writeFileSync(imagePath, "png");
  const channel = new MockChannelAdapter({ media: true });
  const codex = new SendFileCodexAdapter(imagePath);
  const transcript = new CapturingTranscriptSink();
  const bridge = new Bridge({ channel, codex, cwd: root, transcript });

  await bridge.start();
  await channel.emitText("/sendfile 生成结果图并发给我");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.prompts.length, 1);
  assert.ok(codex.prompts[0].includes("生成结果图并发给我"));
  assert.ok(codex.prompts[0].includes("BRIDGE_SEND_FILE: /absolute/path/to/file"));
  assert.equal(channel.sentMedia.length, 1);
  assert.equal(channel.sentMedia[0].media.path, imagePath);
  assert.equal(channel.sentMedia[0].media.mimeType, "image/png");
  assert.equal(transcript.outboundMediaEvents.length, 1);
  assert.equal(transcript.outboundMediaEvents[0].media.path, imagePath);
  assert.ok(channel.sentMessages.some((message) => message.text === "文件已准备好。"));
  assert.equal(channel.sentMessages.some((message) => message.text.includes("BRIDGE_SEND_FILE")), false);
});

test("Bridge aggregates /sendfile media failures without per-file fallback spam", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sendfile-fail-test-"));
  const imagePath = path.join(root, "result.png");
  fs.writeFileSync(imagePath, "png");
  const channel = new FailingMediaChannelAdapter();
  const codex = new SendFileCodexAdapter(imagePath);
  const bridge = new Bridge({ channel, codex, cwd: root });

  await bridge.start();
  await channel.emitText("/sendfile 生成结果图并发给我");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(channel.mediaAttempts, 1);
  const resultMessages = channel.sentMessages.filter((message) => message.text.startsWith("文件发送结果"));
  assert.equal(resultMessages.length, 1);
  assert.ok(resultMessages[0].text.includes("有 1 个文件发送失败"));
  assert.equal(channel.sentMessages.some((message) => message.text.includes("Codex 生成了媒体文件")), false);
});

test("Bridge default progress mode suppresses command details but keeps reasoning progress", async () => {
  const channel = new MockChannelAdapter();
  const codex = new ProgressCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("跑一个带进度的任务");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.ok(channel.sentMessages.some((message) => message.text.includes("我先列一个简短计划")));
  assert.equal(channel.sentMessages.some((message) => message.text.includes("正在执行命令: npm test")), false);
});

test("Bridge progress command enables detailed progress for the current route", async () => {
  const channel = new MockChannelAdapter();
  const codex = new ProgressCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/progress detailed");
  await channel.emitText("跑一个带详细进度的任务");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.ok(channel.sentMessages.some((message) => message.text.includes("当前模式: `detailed`")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("正在执行命令: npm test")));
});

test("Bridge suppresses task start and progress on weixin while keeping final replies", async () => {
  const channel = new WeixinLikeChannelAdapter();
  const codex = new ProgressCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("跑一个带进度的任务");
  await bridge.waitForIdle();
  await bridge.stop();

  const texts = channel.sentMessages.map((message) => message.text);
  assert.equal(texts.some((text) => text.includes("Codex 正在处理这条消息")), false);
  assert.equal(texts.some((text) => text.startsWith("Codex 进度:")), false);
  assert.ok(texts.some((text) => text === "完成"));
});

test("Bridge logs suppressed weixin progress to local transcript without sending to channel", async () => {
  const channel = new WeixinLikeChannelAdapter();
  const codex = new ProgressCodexAdapter();
  const transcript = new CapturingTranscriptSink();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), transcript });

  await bridge.start();
  await channel.emitText("跑一个有进度的任务");
  await bridge.waitForIdle();
  await bridge.stop();

  const channelTexts = channel.sentMessages.map((message) => message.text);
  assert.equal(channelTexts.some((text) => text.startsWith("Codex 进度:")), false);
  assert.equal(transcript.outboundEvents.some((event) => event.text.startsWith("Codex 进度:")), false);
  assert.ok(transcript.localProgressEvents.some((event) => event.text.includes("我先列一个简短计划。")));
  assert.ok(transcript.localProgressEvents.some((event) => event.text.includes("正在执行命令: npm test")));
});

test("Bridge routes background goal turn final to weixin and logs progress locally", async () => {
  const channel = new WeixinLikeChannelAdapter();
  const codex = new AutoGoalCodexAdapter();
  const transcript = new CapturingTranscriptSink();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), transcript });

  await bridge.start();
  await channel.emitText("/goal 完成后台 Goal");
  await waitFor(() => channel.sentMessages.some((message) => message.text === "Goal 自动续跑完成"));
  await bridge.waitForIdle();
  await bridge.stop();

  const channelTexts = channel.sentMessages.map((message) => message.text);
  assert.ok(channelTexts.some((text) => text.startsWith("已设置 Goal。")));
  assert.ok(channelTexts.includes("Goal 自动续跑完成"));
  assert.equal(channelTexts.some((text) => text.startsWith("Codex 进度:")), false);
  assert.ok(transcript.localProgressEvents.some((event) => event.text.includes("正在推进 Goal。")));
  assert.ok(transcript.outboundEvents.some((event) => event.text === "Goal 自动续跑完成"));
});

test("Bridge queues route messages while background goal turn is running", async () => {
  const channel = new WeixinLikeChannelAdapter();
  const codex = new BlockingGoalCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/goal 执行较长 Goal");
  await waitFor(() => channel.sentTyping.some((event) => event.typing));
  await channel.emitText("后续普通消息");

  assert.ok(channel.sentMessages.some((message) => message.text.includes("已加入队列，前面还有 1 条消息。")));
  assert.equal(codex.runs.length, 0);

  codex.release();
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.runs.length, 1);
  assert.equal(codex.runs[0]?.prompt, "后续普通消息");
  assert.ok(channel.sentMessages.some((message) => message.text === "Goal 后台任务完成"));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("Mock Codex 回复: 后续普通消息")));
});

test("Bridge uses delivery policy instead of channel id for progress suppression", async () => {
  const channel = new WeixinIdOnlyChannelAdapter();
  const codex = new ProgressCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("跑一个带进度的任务");
  await bridge.waitForIdle();
  await bridge.stop();

  const texts = channel.sentMessages.map((message) => message.text);
  assert.ok(texts.some((text) => text.includes("Codex 正在处理这条消息")));
  assert.ok(texts.some((text) => text.includes("我先列一个简短计划")));
});

test("Bridge still sends errors on weixin when progress is disabled", async () => {
  const channel = new WeixinLikeChannelAdapter();
  const codex = new FailedTurnCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("跑一个失败任务");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(channel.sentMessages.some((message) => message.text.includes("Codex 正在处理这条消息")), false);
  assert.ok(channel.sentMessages.some((message) => message.text === "Codex 执行失败: 模拟失败"));
});

test("Bridge sends plan final output on weixin while progress is disabled", async () => {
  const channel = new WeixinLikeChannelAdapter();
  const codex = new PlanFinalCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/plan 请规划实现");
  await bridge.waitForIdle();
  await bridge.stop();

  const texts = channel.sentMessages.map((message) => message.text);
  assert.equal(texts.some((text) => text.includes("Codex 正在处理这条消息")), false);
  assert.equal(texts.some((text) => text.startsWith("Codex 进度:")), false);
  assert.ok(texts.some((text) => text.includes("# 执行计划")));
  assert.ok(texts.some((text) => text.includes("已进入 Plan mode")));
});

test("Bridge rejects progress command and silently accepts /fff on weixin", async () => {
  const channel = new WeixinLikeChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/progress detailed");
  await channel.emitText("/fff");
  await bridge.stop();

  assert.equal(channel.sentMessages.length, 1);
  assert.match(channel.sentMessages[0].text, /微信渠道已禁用进度投递/);
});

test("Bridge reports progress disabled in weixin status", async () => {
  const channel = new WeixinLikeChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/status");
  await bridge.stop();

  assert.match(channel.sentMessages[0].text, /进度投递: 已禁用/);
});

test("Bridge hides progress command and shows /fff in weixin help", async () => {
  const channel = new WeixinLikeChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/help");
  await bridge.stop();

  const help = channel.sentMessages[0].text;
  assert.equal(help.includes("`/progress [brief|detailed|silent]`"), false);
  assert.ok(help.includes("- `/context-refresh [off|detect|reload|inherit]`:"));
  assert.ok(help.includes("  - `/context-refresh reload`: 发现本机 session 外部更新时先重新加载当前 session，再发送。"));
  assert.ok(help.includes("- `/fff`:"));
});

test("Bridge suppresses progress sends briefly after a channel progress failure", async () => {
  const channel = new ProgressFailingChannelAdapter();
  const codex = new ManyProgressCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("跑一个多进度任务");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(channel.progressAttempts, 1);
  assert.ok(channel.sentMessages.some((message) => message.text === "完成"));
});

async function waitForTest(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("condition was not met");
}

test("Bridge permission command shows and changes Codex run policy", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/permission");
  await channel.emitText("/permission full");
  assert.equal(codex.getRunPolicy().permissionMode, "approval");
  await channel.emitText("/permission full confirm");
  await channel.emitText("/status");
  await channel.emitText("/permission approval");
  await bridge.stop();

  assert.ok(channel.sentMessages.some((message) => message.text.includes("当前模式: `approval sandbox=workspace-write`")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("/permission full confirm")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已切换 Codex 权限模式: full")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("权限模式: 完全权限")));
  assert.equal(codex.getRunPolicy().permissionMode, "approval");
});

test("Bridge permission command scopes changes to the current bound session", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("/new", { conversationId: "main" });
  await channel.emitText("/new", { conversationId: "other" });
  await channel.emitText("/permission full confirm", { conversationId: "main" });
  await channel.emitText("/status", { conversationId: "main" });
  await channel.emitText("/status", { conversationId: "other" });
  await bridge.stop();

  assert.equal(codex.getRunPolicy("mock-codex-1").permissionMode, "full");
  assert.equal(codex.getRunPolicy("mock-codex-2").permissionMode, "approval");
  const mainStatus = channel.sentMessages
    .filter((message) => message.target.conversation.id === "main" && message.text.includes("**Codex 状态**"))
    .at(-1)?.text ?? "";
  const otherStatus = channel.sentMessages
    .filter((message) => message.target.conversation.id === "other" && message.text.includes("**Codex 状态**"))
    .at(-1)?.text ?? "";
  assert.ok(mainStatus.includes("权限模式: 完全权限"));
  assert.ok(otherStatus.includes("权限模式: 审批模式（沙箱 `workspace-write`）"));
});

test("Bridge sends typing state while Codex is running", async () => {
  const channel = new MockChannelAdapter({ typing: true });
  const codex = new ProgressCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("跑一个需要 typing 的任务");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.deepEqual(channel.sentTyping.map((event) => event.typing), [true, false]);
});

test("Bridge status reports running work and /stop cancels the current task", async () => {
  const channel = new MockChannelAdapter({ typing: true });
  const codex = new CancellableCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("执行一个长任务");
  await waitFor(() => channel.sentMessages.some((message) => message.text.includes("Codex 正在处理这条消息")));
  await waitFor(() => channel.sentTyping.some((event) => event.typing));
  await waitFor(async () => (await codex.getStatus()).type === "running");

  await channel.emitText("/status");
  const statusMessage = channel.sentMessages.at(-1)?.text ?? "";
  assert.match(statusMessage, /处理状态: 正在处理/);
  assert.match(statusMessage, /当前任务耗时: `(?:\d+s|\d+m \d{2}s|\d+h \d{2}m \d{2}s)`/);
  assert.match(statusMessage, /运行状态: 运行中/);
  assert.match(statusMessage, /可用操作: 发送 `\/stop`/);

  await channel.emitText("/stop");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.cancelled, true);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已请求停止当前 Codex 任务")));
  assert.deepEqual(channel.sentTyping.map((event) => event.typing), [true, false, false]);
});

test("Bridge stop clears queued prompts for the current route", async () => {
  const channel = new MockChannelAdapter();
  const codex = new CancellableCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("执行一个长任务");
  await waitFor(async () => (await codex.getStatus()).type === "running");
  await channel.emitText("这条应该被清空");
  await channel.emitText("/stop");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.deepEqual(codex.prompts, ["执行一个长任务"]);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已清空 1 条排队消息")));
});

test("Bridge queues normal prompts for the same route while keeping commands responsive", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd() });

  await bridge.start();
  await channel.emitText("第一条");
  await channel.emitText("第二条");
  await channel.emitText("/status");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.ok(channel.sentMessages.some((message) => message.text.includes("已加入队列")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("排队消息:")));
  const firstIndex = channel.sentMessages.findIndex((message) => message.text === "Mock Codex 回复: 第一条");
  const secondIndex = channel.sentMessages.findIndex((message) => message.text === "Mock Codex 回复: 第二条");
  assert.ok(firstIndex >= 0);
  assert.ok(secondIndex > firstIndex);
});

test("Bridge binds first route to initial session when provided", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const initial = await codex.startSession({
    routeKey: "bootstrap",
    cwd: process.cwd(),
    title: "existing",
  });
  const bridge = new Bridge({
    channel,
    codex,
    cwd: process.cwd(),
    initialSessionId: initial.id,
  });

  await bridge.start();
  await channel.emitText("继续已有会话");
  await bridge.waitForIdle();
  await channel.emitText("/status");
  await bridge.stop();

  assert.ok(channel.sentMessages.some((message) => message.text.includes("Mock Codex 回复: 继续已有会话")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes(`当前会话: \`${initial.id}\``)));
});

test("Bridge clears pending initial session when route explicitly creates a session first", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const initial = await codex.startSession({
    routeKey: "bootstrap",
    cwd: process.cwd(),
    title: "existing",
  });
  const bridge = new Bridge({
    channel,
    codex,
    cwd: process.cwd(),
    initialSessionId: initial.id,
  });

  await bridge.start();
  await channel.emitText("/new", { conversationId: "main" });
  await channel.emitText("不要误用预设 session", { conversationId: "other" });
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.runs.at(-1)?.sessionId, "mock-codex-3");
  assert.notEqual(codex.runs.at(-1)?.sessionId, initial.id);
});

test("Bridge keeps pending initial session scoped to the first direct route", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const initial = await codex.startSession({
    routeKey: "bootstrap",
    cwd: process.cwd(),
    title: "existing",
  });
  const bridge = new Bridge({
    channel,
    codex,
    cwd: process.cwd(),
    initialRouteBinding: { type: "existing", sessionId: initial.id },
  });

  await bridge.start();
  await channel.emitText("/status", { conversationId: "main" });
  await channel.emitText("其他私聊不要误用预设", { conversationId: "other" });
  await bridge.waitForIdle();
  await channel.emitText("首个私聊继续已有会话", { conversationId: "main" });
  await bridge.waitForIdle();
  await bridge.stop();

  assert.ok(channel.sentMessages.some((message) => message.text.includes("待绑定首个私聊预设")));
  assert.deepEqual(codex.runs.map((run) => run.prompt), [
    "其他私聊不要误用预设",
    "首个私聊继续已有会话",
  ]);
  assert.equal(codex.runs[0]?.sessionId, "mock-codex-2");
  assert.equal(codex.runs[1]?.sessionId, initial.id);
});

test("Bridge initial new route binding bypasses ask policy for the first direct route only", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({
    channel,
    codex,
    cwd: process.cwd(),
    unboundRoutePolicy: "ask",
    initialRouteBinding: { type: "new" },
  });

  await bridge.start();
  await channel.emitText("第一个私聊直接创建", { conversationId: "main" });
  await bridge.waitForIdle();
  await channel.emitText("第二个私聊仍需选择", { conversationId: "other" });
  await bridge.waitForIdle();
  await bridge.stop();

  assert.deepEqual(codex.runs.map((run) => run.prompt), ["第一个私聊直接创建"]);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("请先发送 /new 创建新会话")));
});

test("Bridge asks unbound routes to choose a session when policy is ask", async () => {
  const channel = new MockChannelAdapter();
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({
    channel,
    codex,
    cwd: process.cwd(),
    unboundRoutePolicy: "ask",
  });

  await bridge.start();
  await channel.emitText("先不要自动创建");
  await bridge.waitForIdle();
  await channel.emitText("/new");
  await channel.emitText("现在可以执行");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.runs.map((run) => run.prompt).includes("先不要自动创建"), false);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("请先发送 /new 创建新会话")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("Mock Codex 回复: 现在可以执行")));
});

test("Bridge routes two mock channels through one registry without cross-channel replies", async () => {
  const channelA = new MockChannelAdapter({ id: "mock-a" });
  const channelB = new MockChannelAdapter({ id: "mock-b" });
  const registry = new ChannelRegistry({ channels: [channelA, channelB] });
  const codex = new ParallelProbeCodexAdapter();
  const bridge = new Bridge({ channels: registry, codex, cwd: process.cwd() });

  await bridge.start();
  await channelA.emitText("来自 A");
  await channelB.emitText("来自 B");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(channelA.sentMessages.some((message) => message.target.channelId !== "mock-a"), false);
  assert.equal(channelB.sentMessages.some((message) => message.target.channelId !== "mock-b"), false);
  assert.ok(channelA.sentMessages.some((message) => message.text === "完成: 来自 A"));
  assert.ok(channelB.sentMessages.some((message) => message.text === "完成: 来自 B"));
  assert.equal(codex.maxActive, 2);
});

test("Bridge rejects binding one Codex session to another route", async () => {
  const channelA = new MockChannelAdapter({ id: "mock-a" });
  const channelB = new MockChannelAdapter({ id: "mock-b" });
  const registry = new ChannelRegistry({ channels: [channelA, channelB] });
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channels: registry, codex, cwd: process.cwd() });

  await bridge.start();
  await channelA.emitText("/new");
  await channelB.emitText("/resume mock-codex-1");
  await bridge.stop();

  const conflict = channelB.sentMessages.at(-1)?.text ?? "";
  assert.ok(conflict.includes("无法绑定 Codex 会话"));
  assert.ok(conflict.includes("Owner: mock-a:mock-account:direct:mock-user"));
});

test("Bridge keeps approvals scoped to the originating channel route", async () => {
  const channelA = new MockChannelAdapter({ id: "mock-a" });
  const channelB = new MockChannelAdapter({ id: "mock-b" });
  const registry = new ChannelRegistry({ channels: [channelA, channelB] });
  const codex = new MockCodexAdapter();
  const bridge = new Bridge({ channels: registry, codex, cwd: process.cwd() });

  await bridge.start();
  await channelB.emitText("请触发审批 approval");
  await bridge.waitForIdle();
  await channelA.emitText("/OK");
  await channelB.emitText("/OK");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.ok(channelB.sentMessages.some((message) => message.text.includes("Codex 请求审批")));
  assert.ok(channelA.sentMessages.some((message) => message.text === "当前没有待处理审批。"));
  assert.equal(codex.resolvedApprovals.length, 1);
  assert.equal(codex.resolvedApprovals[0].decision, "approve");
});

function mockImageAttachment(localPath: string): ChannelAttachment {
  return {
    id: path.basename(localPath),
    type: "image",
    name: path.basename(localPath),
    mimeType: "image/png",
    localPath,
    downloadState: "available",
  };
}

function mockFileAttachment(localPath: string, mimeType = "application/pdf"): ChannelAttachment {
  return {
    id: path.basename(localPath),
    type: "file",
    name: path.basename(localPath),
    mimeType,
    localPath,
    downloadState: "available",
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tempStateRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function choiceQuestion(): CodexUserInputQuestion {
  return {
    id: "confirm_path",
    header: "确认方案",
    question: "是否继续执行这个方案？",
    isOther: true,
    isSecret: false,
    options: [
      { label: "Yes (Recommended)", description: "继续当前方案。" },
      { label: "No", description: "停止并重新考虑。" },
    ],
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}
