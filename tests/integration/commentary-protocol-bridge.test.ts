import test from "node:test";
import assert from "node:assert/strict";
import { Bridge } from "../../src/bridge/bridge.js";
import { MockChannelAdapter } from "../../src/channels/mock/mock-channel-adapter.js";
import { FeishuAdapter } from "../../src/channels/feishu/feishu-adapter.js";
import { MockCodexAdapter } from "../../src/codex/mock-codex-adapter.js";
import { AppServerTurnController } from "../../src/codex/app-server/turn-controller.js";
import { AsyncEventQueue } from "../../src/codex/app-server/turn-store.js";
import type { CodexBackgroundEventHandler, CodexEvent } from "../../src/codex/types.js";
import { RuntimeLogStore, RuntimeTuiTranscriptSink } from "../../src/cli/tui/runtime-log.js";
import { SilentLogger } from "../../src/logging/logger.js";
import { DEFAULT_CHANNEL_DELIVERY_POLICY } from "../../src/protocol/delivery-policy.js";
import type { ChannelDefaultProgressMode } from "../../src/protocol/delivery-policy.js";
import { FakeFeishuTransportFactory, sampleFeishuTextEvent } from "../helpers/feishu-fakes.js";

const fragments = ["我先检查 ", "1.", " 版本 ", "0.", "162.", "1", "，再看 `src/index", ".", "ts`。", "\n", "2.", " 然后核对接口 `https://example", ".", "invalid/a", "?", "x=1`。", "\n最后记录结论。"];
const body = fragments.join("");
const finalText = "独立的最终回复。";

interface Scenario {
  items: Array<{ id: string; chunks: readonly string[]; text: string; started?: boolean; completed?: boolean }>;
  finalText?: string;
  status?: "completed" | "failed" | "interrupted";
}

function scenario(includeFinal = true): Scenario {
  return { items: [{ id: "commentary", chunks: fragments, text: body }], ...(includeFinal ? { finalText } : {}) };
}

function feed(controller: AppServerTurnController, sessionId: string, turnId: string, script: Scenario): void {
  const notify = (method: string, params: Record<string, unknown>) => controller.handleNotification({ method, params: { threadId: sessionId, turnId, ...params } });
  for (const entry of script.items) {
    const item = { type: "agentMessage", id: entry.id, phase: "commentary", text: entry.text };
    if (entry.started !== false) notify("item/started", { item: { ...item, text: "" } });
    for (const delta of entry.chunks) notify("item/agentMessage/delta", { itemId: entry.id, delta });
    if (entry.completed !== false) {
      notify("item/completed", { item });
      notify("item/completed", { item }); // Replay must not log or send a second message.
    }
  }
  if (script.finalText) notify("item/completed", { item: { type: "agentMessage", id: "final", phase: "final_answer", text: script.finalText } });
  notify("turn/completed", { turn: { status: script.status ?? "completed", error: { message: "模拟失败" } } });
}

class ProtocolCodex extends MockCodexAdapter {
  private readonly handlers = new Set<CodexBackgroundEventHandler>();
  sessionId?: string;

  constructor(private readonly script: Scenario, private readonly background: boolean) { super(); }

  onBackgroundEvent(handler: CodexBackgroundEventHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  override async *run(sessionId: string): AsyncIterable<CodexEvent> {
    this.sessionId = sessionId;
    const turnId = "foreground-turn";
    yield { type: "turn.started", sessionId, turnId };
    if (this.background) {
      yield { type: "turn.completed", sessionId, turnId }; // Establish the route for a later auto-continued turn.
      return;
    }
    const controller = new AppServerTurnController({ sessions: new Map(), threadToSession: new Map() });
    const queue = new AsyncEventQueue<CodexEvent>();
    controller.registerTurn(sessionId, turnId, queue);
    feed(controller, sessionId, turnId, this.script);
    yield* queue;
  }

  async runBackground(): Promise<void> {
    assert.ok(this.sessionId);
    const session = await this.resumeSession(this.sessionId);
    const controller = new AppServerTurnController({
      sessions: new Map([[session.id, { session, status: { type: "idle" }, updatedAt: new Date().toISOString() }]]),
      threadToSession: new Map([[session.id, session.id]]),
    });
    let finish!: () => void;
    let fail!: (error: unknown) => void;
    const finished = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    controller.onBackgroundEvent(async (event) => {
      try {
        for (const handler of this.handlers) await handler(event);
        if (["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type)) finish();
      } catch (error) { fail(error); }
    });
    feed(controller, session.id, "background-turn", this.script);
    await finished;
  }
}

async function runMock(script: Scenario, options: {
  mode: ChannelDefaultProgressMode;
  background: boolean;
  weixin?: boolean;
  plan?: boolean;
  failSendNumber?: number;
}) {
  const codex = new ProtocolCodex(script, options.background);
  if (options.plan) codex.setCollaborationMode("plan");
  const channel = new MockChannelAdapter();
  channel.getDeliveryPolicy = () => ({
    ...DEFAULT_CHANNEL_DELIVERY_POLICY,
    taskStart: "suppress",
    defaultProgressMode: options.mode,
    realtimeProgress: options.weixin ? "suppress" : "send",
    allowedProgressModes: options.weixin ? ["silent", "brief"] : ["silent", "brief", "realtime"],
  });
  const send = channel.sendText.bind(channel);
  const attempts: string[] = [];
  channel.sendText = async (target, text, sendOptions) => {
    attempts.push(text);
    if (attempts.length === options.failSendNumber) throw new Error("模拟渠道发送失败");
    return send(target, text, sendOptions);
  };
  const logs = new RuntimeLogStore();
  const bridge = new Bridge({ channel, codex, cwd: process.cwd(), logger: new SilentLogger(), transcript: new RuntimeTuiTranscriptSink(logs) });
  await bridge.start();
  try {
    await channel.emitText("验证完整旁白");
    await bridge.waitForIdle();
    if (options.background) await codex.runBackground();
    return {
      sent: channel.sentMessages.map((message) => message.text), attempts,
      local: logs.snapshot().filter((entry) => entry.kind === "commentary" && entry.source.includes(" -- ")).map((entry) => entry.message),
      outbound: logs.snapshot().filter((entry) => entry.kind === "commentary" && entry.source.includes(" => ")),
    };
  } finally { await bridge.stop(); }
}

for (const background of [false, true]) {
  const path = background ? "background" : "foreground";
  for (const [channel, modes] of [["weixin", ["silent", "brief"]], ["feishu", ["silent", "brief", "realtime"]]] as const) {
    for (const mode of modes) for (const includeFinal of [false, true]) {
      test(`${path} ${channel}-policy ${mode}: fragmented commentary is whole ${includeFinal ? "with a final" : "without a final"}`, { timeout: 5000 }, async () => {
        const result = await runMock(scenario(includeFinal), { background, mode, weixin: channel === "weixin" });
        assert.deepEqual(result.local, [body]);
        assert.equal(result.outbound.length, mode === "silent" ? 0 : 1);
        assert.deepEqual(result.sent, includeFinal ? (mode === "silent" ? [finalText] : [body, finalText]) : [body]);
      });
    }
  }

  test(`${path} Plan mode sends a completed commentary despite silent policy`, async () => {
    const result = await runMock(scenario(false), { background, mode: "silent", weixin: true, plan: true });
    assert.deepEqual(result.local, [body]);
    assert.deepEqual(result.sent, [body]);
    assert.equal(result.outbound.length, 1);
  });

  test(`${path} brief coalesces six complete messages without losing the middle`, async () => {
    const texts = ["确认。", "确认。", "第三条。", "第四条。", "第五条。", "第六条。"];
    const result = await runMock({ items: texts.map((text, i) => ({ id: `item-${i}`, chunks: Array.from(text), text })) }, { background, mode: "brief" });
    assert.deepEqual(result.local, texts);
    assert.deepEqual(result.sent, [texts[0], texts.slice(1).join("\n\n")]);
  });

  test(`${path} completion corrections and late phase metadata drive the complete fallback`, async () => {
    const corrected = `${body}\n完成时补充的结论。`;
    const result = await runMock({ items: [{ id: "c", chunks: fragments, text: corrected, started: false }] }, { background, mode: "silent" });
    assert.deepEqual(result.local, [corrected]);
    assert.deepEqual(result.sent, [corrected]);
  });

  for (const status of ["completed", "failed", "interrupted"] as const) {
    test(`${path} ${status} never sends an unfinished commentary or uses it as a final`, async () => {
      const result = await runMock({ items: [{ id: "c", chunks: fragments, text: body, completed: false }], status }, { background, mode: "brief" });
      assert.deepEqual(result.local, []);
      assert.deepEqual(result.sent, status === "completed" ? [] : [status === "failed" ? "Codex 执行失败: 模拟失败" : "Codex 当前任务已中断。"]);
    });
  }

  test(`${path} channel failure falls back once with the full commentary`, async () => {
    const result = await runMock(scenario(false), { background, mode: "brief", failSendNumber: 1 });
    assert.deepEqual(result.local, [body, `旁白发送失败，未投递到聊天渠道。\n${body}\n\n错误: 模拟渠道发送失败`]);
    assert.deepEqual(result.sent, [body]);
    assert.deepEqual(result.attempts, [body, body]);
  });

  test(`${path} a failed identical second item is not mistaken for the first delivered item`, async () => {
    const result = await runMock({ items: ["first", "second"].map((id) => ({ id, chunks: fragments, text: body })) }, { background, mode: "realtime", failSendNumber: 2 });
    assert.deepEqual(result.local, [body, body, `旁白发送失败，未投递到聊天渠道。\n${body}\n\n错误: 模拟渠道发送失败`]);
    assert.deepEqual(result.sent, [body, body]);
    assert.deepEqual(result.attempts, [body, body, body]);
  });
}

for (const mode of ["silent", "brief", "realtime"] as const) {
  test(`real Feishu adapter with fake SDK sends one full protocol commentary in ${mode}`, async () => {
    const factory = new FakeFeishuTransportFactory();
    const channel = new FeishuAdapter({ appId: "cli_1234567890abcdef", appSecret: "test-secret", accountId: "work", transportFactory: factory });
    const logs = new RuntimeLogStore();
    const bridge = new Bridge({ channel, codex: new ProtocolCodex(scenario(false), false), cwd: process.cwd(), logger: new SilentLogger(), progressMode: mode, transcript: new RuntimeTuiTranscriptSink(logs) });
    await bridge.start();
    try {
      await factory.dispatcher.emitReceive(sampleFeishuTextEvent());
      await bridge.waitForIdle();
      const texts = factory.client.sentTexts().filter((text) => !text.startsWith("Codex 正在处理这条消息。"));
      assert.deepEqual(texts, [body]);
      assert.deepEqual(logs.snapshot().filter((entry) => entry.kind === "commentary" && entry.source.includes(" -- ")).map((entry) => entry.message), [body]);
    } finally { await bridge.stop(); }
  });
}
