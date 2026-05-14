import test from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../../src/bridge/bridge.js";
import { MockChannelAdapter } from "../../src/channels/mock/mock-channel-adapter.js";
import { MockCodexAdapter } from "../../src/codex/mock-codex-adapter.js";
import type { CodexAdapter, CodexEvent, CodexSession, CodexSessionContextUsage, CodexSessionStatus, CodexSessionSummary, StartSessionInput } from "../../src/codex/types.js";
import type { TranscriptSink } from "../../src/logging/transcript.js";
import type { ChannelMedia, ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

class CapturingTranscriptSink implements TranscriptSink {
  readonly inboundEvents: Array<{ message: ChannelMessage; text: string }> = [];
  readonly outboundEvents: Array<{ target: ChannelTarget; text: string }> = [];
  readonly outboundMediaEvents: Array<{ target: ChannelTarget; media: ChannelMedia }> = [];

  inbound(message: ChannelMessage, text: string): void {
    this.inboundEvents.push({ message, text });
  }

  outbound(target: ChannelTarget, text: string): void {
    this.outboundEvents.push({ target, text });
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

class ContextUsageCodexAdapter extends MockCodexAdapter {
  private readonly context: CodexSessionContextUsage = {
    total: {
      totalTokens: 12345,
      inputTokens: 10000,
      cachedInputTokens: 4000,
      outputTokens: 2345,
      reasoningOutputTokens: 345,
    },
    last: {
      totalTokens: 789,
      inputTokens: 600,
      cachedInputTokens: 200,
      outputTokens: 189,
      reasoningOutputTokens: 89,
    },
    modelContextWindow: 200000,
  };

  override async getStatus(sessionId: string): Promise<CodexSessionStatus> {
    const status = await super.getStatus(sessionId);
    return { ...status, context: this.context };
  }
}

class CancellableCodexAdapter implements CodexAdapter {
  private sequence = 0;
  private readonly sessions = new Map<string, CodexSession>();
  private status: CodexSessionStatus = { type: "idle" };
  private release?: () => void;
  cancelled = false;

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
  assert.ok(approvalMessage.text.includes("/NO [理由] 拒绝当前审批"));

  await channel.emitText("/OK 好的");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.ok(channel.sentMessages.some((message) => message.text.includes("已创建新 Codex 会话")));
  assert.ok(channel.sentMessages.some((message) => message.text.includes("当前上下文 Codex 会话")));
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

  assert.ok(channel.sentMessages.some((message) => message.text.includes("`/sessions all` 列出全部可发现 Codex 会话")));
  const help = channel.sentMessages.find((message) => message.text.startsWith("**可用命令**"))?.text ?? "";
  assert.ok(help.includes("`/OK` 批准当前审批"));
  assert.ok(help.includes("`/NO [理由]` 拒绝当前审批"));
  assert.ok(help.includes("`/permission [approval|full confirm]`"));
  assert.equal(help.includes("/approve [id]"), false);
  assert.equal(help.includes("cancel"), false);
  const allSessionsMessages = channel.sentMessages.filter((message) => message.text.startsWith("全部可发现 Codex 会话"));
  assert.equal(allSessionsMessages.length, 2);
  assert.ok(allSessionsMessages.every((message) => message.text.includes("mock-codex-1")));
  assert.ok(allSessionsMessages.every((message) => message.text.includes("mock-codex-2")));
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
  assert.match(statusMessage, /Session: `mock-codex-1`/);
  assert.match(statusMessage, /Context: `12,345 \/ 200,000 tokens` \(6\.2%, remaining 187,655\) last turn `789 tokens`/);
  assert.doesNotMatch(statusMessage, /mock:mock-account:direct:project-room/);
  assert.doesNotMatch(statusMessage, /Mock User \(alice\)/);
});

test("Bridge rejects latest approval with /NO and an optional reason", async () => {
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
  assert.equal(codex.resolvedApprovals[0].reason, "这个命令会删除文件");
  assert.ok(channel.sentMessages.some((message) => message.text.includes("理由: 这个命令会删除文件")));
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

test("Bridge forwards generated image refs as channel media and transcript media events", async () => {
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

  assert.equal(channel.sentMedia.length, 1);
  assert.equal(channel.sentMedia[0].media.path, imagePath);
  assert.equal(channel.sentMedia[0].media.mimeType, "image/png");
  assert.equal(transcript.outboundMediaEvents.length, 1);
  assert.equal(transcript.outboundMediaEvents[0].media.path, imagePath);
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
  assert.ok(channel.sentMessages.some((message) => message.text.includes("Permission: `full`")));
  assert.equal(codex.getRunPolicy().permissionMode, "approval");
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
  assert.match(statusMessage, /Processing: `yes`/);
  assert.match(statusMessage, /State: `running/);
  assert.match(statusMessage, /Action: `\/stop`/);

  await channel.emitText("/stop");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(codex.cancelled, true);
  assert.ok(channel.sentMessages.some((message) => message.text.includes("已请求停止当前 Codex 任务")));
  assert.deepEqual(channel.sentTyping.map((event) => event.typing), [true, false, false]);
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
  assert.ok(channel.sentMessages.some((message) => message.text.includes("Queue:")));
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
  assert.ok(channel.sentMessages.some((message) => message.text.includes(`Session: \`${initial.id}\``)));
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}
