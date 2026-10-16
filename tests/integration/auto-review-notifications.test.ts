import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { BridgeBackgroundTurns } from "../../src/bridge/background-turns.js";
import { BridgeDelivery } from "../../src/bridge/delivery.js";
import { BridgeRouteQueue } from "../../src/bridge/route-queue.js";
import { BridgeSessionFlow } from "../../src/bridge/session-flow.js";
import { UnlimitedTurnScheduler } from "../../src/bridge/turn-scheduler.js";
import type { ChannelRegistry } from "../../src/channels/registry.js";
import { MockCodexAdapter } from "../../src/codex/mock-codex-adapter.js";
import { notificationText } from "../../src/codex/app-server/notification-mapper.js";
import type { CodexEvent } from "../../src/codex/types.js";
import type { ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";
import { DEFAULT_CHANNEL_DELIVERY_POLICY } from "../../src/protocol/delivery-policy.js";
import { MemoryStateStore } from "../../src/state/memory-state-store.js";

class ReviewBurstAdapter extends MockCodexAdapter {
  constructor(private readonly count: number) { super(); }

  override async *run(sessionId: string): AsyncIterable<CodexEvent> {
    const turnId = "review-turn";
    yield { type: "turn.started", sessionId, turnId };
    yield { type: "assistant.progress", sessionId, turnId, kind: "reasoning", text: "正常推理摘要。" };
    yield { type: "assistant.commentary", sessionId, turnId, itemId: "commentary-1", text: "正常工作进展旁白。" };
    for (let index = 0; index < this.count; index++) {
      const message = `Automatic approval review approved (risk: low, authorization: high): Safe action ${index}.`;
      const notice = notificationText("guardianWarning", { message });
      assert.ok(notice);
      yield { type: "codex.notification", sessionId, turnId, notification: {
        method: "guardianWarning", ...notice, dedupeKey: `guardianWarning:${sessionId}:${message}`,
      } };
    }
    yield { type: "assistant.completed", sessionId, turnId, text: "最终回复。" };
    yield { type: "turn.completed", sessionId, turnId };
  }
}

for (const channel of ["weixin-direct", "feishu-direct", "feishu-group"] as const) {
  for (const mode of ["silent", "brief"] as const) {
    for (const background of [false, true]) {
      test(`auto-review success preserves ${channel} ${mode} ${background ? "background" : "foreground"} replies`, async () => {
        const count = mode === "silent" ? 100 : 20;
        const codex = new ReviewBurstAdapter(count);
        const state = new MemoryStateStore();
        const approvals = new ApprovalManager();
        const sends: Array<{ target: ChannelTarget; text: string }> = [];
        const local: Array<{ message: string; meta?: Record<string, unknown> }> = [];
        const failures: string[] = [];
        const logger = {
          info(message: string, meta?: Record<string, unknown>) { local.push({ message, meta }); },
          warn(message: string) { failures.push(message); }, error(message: string) { failures.push(message); }, debug() {},
        };
        const target: ChannelTarget = {
          routeKey: `${channel}:route`, channelId: channel, accountId: "bot",
          conversation: { id: "conversation", kind: channel === "feishu-group" ? "group" : "direct" }, recipient: { id: "user" },
        };
        const message: ChannelMessage = { ...target, id: "inbound-1", sender: { id: "user" }, text: "执行", timestamp: "now" };
        let attempts = 0;
        const delivery = new BridgeDelivery({
          approvals, logger, approvalSendRetryDelayMs: 1,
          channels: {
            sendText: async (destination: ChannelTarget, text: string) => {
              attempts += 1;
              // A deliberately small mock budget, not a real platform limit.
              if (attempts > (mode === "silent" ? 1 : 3)) throw new Error("synthetic send budget exhausted");
              sends.push({ target: destination, text });
              return { channelId: channel, messageId: String(attempts), deliveredAt: "now" };
            },
            getCapabilities: () => ({ text: true, media: false, typing: false, direct: true, group: true, thread: false, login: "none", messageUpdate: false, streamingHint: false }),
          } as unknown as ChannelRegistry,
        });
        const policy = { ...DEFAULT_CHANNEL_DELIVERY_POLICY, taskStart: "suppress" as const, defaultProgressMode: mode };
        const deliveryOptions = {
          state, approvals, delivery, deliveryPolicyFor: () => policy,
          shouldDeliverProgressWithPolicy: () => mode === "brief",
          shouldDeliverCommentaryWithPolicy: () => mode === "brief",
          isRealtimeCommentaryWithPolicy: () => false,
          shouldDeliverToolProgressWithPolicy: () => false,
        };
        const session = await codex.startSession({ routeKey: target.routeKey, cwd: "/repo" });
        state.bindSession(target.routeKey, session);
        if (background) {
          const turns = new BridgeBackgroundTurns({
            ...deliveryOptions, logger,
            routeMessages: new Map([[target.routeKey, message]]), routeTargets: new Map([[target.routeKey, target]]),
            startRouteWorker() {}, routeQueueLength: () => 0, hasRouteWorker: () => false,
          });
          for await (const event of codex.run(session.id)) await turns.handle(event);
          assert.equal(turns.hasForRoute(target.routeKey), false);
        } else {
          const sessionFlow = new BridgeSessionFlow({
            codex, state, delivery, cwd: "/repo", unboundRoutePolicy: "auto_new",
            isRouteExecutionBusy: async () => false, applyStoredSessionRunPolicy() {},
            collaborationModeForRoute: () => "default", hasRouteCollaborationMode: () => false,
            applyRouteCollaborationModeToSession() {}, syncRouteCollaborationModeFromSession: () => "default",
          });
          const queue = new BridgeRouteQueue({
            ...deliveryOptions, codex, sessionFlow, turnScheduler: new UnlimitedTurnScheduler(),
            hasBackgroundTurnForRoute: () => false, currentCollaborationMode: () => undefined,
          });
          await queue.enqueuePrompt(message, target, "执行");
          await queue.waitForWorkers();
        }
        assert.deepEqual(failures, []);
        assert.equal(sends.filter((send) => send.text === "最终回复。").length, 1);
        assert.ok(sends.every((send) => send.target.routeKey === target.routeKey));
        assert.ok(sends.every((send) => !send.text.includes("Automatic approval review")));
        assert.equal(sends.some((send) => send.text.includes("正常推理摘要")), mode === "brief");
        assert.equal(sends.some((send) => send.text.includes("正常工作进展旁白")), mode === "brief");
        assert.equal(local.length, count);
        assert.ok(local.every((entry) => entry.meta?.sessionId === session.id && entry.meta?.routeKey === target.routeKey));
        assert.deepEqual(state.listRecentCodexNotifications(session.id), []);
        assert.equal(attempts, mode === "silent" ? 1 : 3);
      });
    }
  }
}
