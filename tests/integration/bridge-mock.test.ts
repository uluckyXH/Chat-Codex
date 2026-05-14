import test from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../../src/bridge/bridge.js";
import { MockChannelAdapter } from "../../src/channels/mock/mock-channel-adapter.js";
import { MockCodexAdapter } from "../../src/codex/mock-codex-adapter.js";
import type { CodexAdapter, CodexEvent, CodexSession, CodexSessionContextUsage, CodexSessionStatus, CodexSessionSummary, StartSessionInput } from "../../src/codex/types.js";
import type { TranscriptSink } from "../../src/logging/transcript.js";
import type { ChannelMedia, ChannelMessage, ChannelTarget, SendResult } from "../../src/protocol/channel.js";
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

  assert.ok(channel.sentMessages.some((message) => message.text.includes("```text\n/sessions all\n```")));
  const help = channel.sentMessages.find((message) => message.text.startsWith("**可用命令**"))?.text ?? "";
  assert.ok(help.includes("```text\n/OK\n```"));
  assert.ok(help.includes("批准当前审批"));
  assert.ok(help.includes("```text\n/NO [理由]\n```"));
  assert.ok(help.includes("拒绝当前审批"));
  assert.ok(help.includes("```text\n/permission [approval|full confirm]\n```"));
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
  assert.match(statusMessage, /Model: `gpt-test` provider=`openai` tier=`default` effort=`high`/);
  assert.match(statusMessage, /Context: `164,171 \/ 258,400 tokens` \(63\.5%, remaining 94,229\)/);
  assert.match(statusMessage, /last turn input 160,000, cached 120,000, output 4,171, reasoning output 1,200/);
  assert.match(statusMessage, /total usage `34,375,973 tokens`/);
  assert.doesNotMatch(statusMessage, /13303\.4%/);
  assert.doesNotMatch(statusMessage, /mock:mock-account:direct:project-room/);
  assert.doesNotMatch(statusMessage, /Mock User \(alice\)/);
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
  assert.ok(statusMessage.includes("**Pending Approval**"));
  assert.ok(statusMessage.includes("```text\n/OK\n```"));
  assert.ok(statusMessage.includes("```text\n/NO [理由]\n```"));
  await channel.emitText("/OK");
  await bridge.waitForIdle();
  await bridge.stop();

  assert.equal(channel.sentMessages.some((message) => message.text.includes("Codex 请求审批")), false);
  assert.equal(codex.resolvedApprovals.length, 1);
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
  assert.ok(channel.sentMessages.some((message) => message.text.includes("Permission: `full`")));
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
  assert.ok(mainStatus.includes("Permission: `full`"));
  assert.ok(otherStatus.includes("Permission: `approval sandbox=workspace-write`"));
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
