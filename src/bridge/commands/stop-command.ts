import type { ApprovalManager } from "../../approvals/approval-manager.js";
import type { CodexAdapter } from "../../codex/types.js";
import type { ChannelMessage, ChannelTarget } from "../../protocol/channel.js";
import type { MemoryStateStore } from "../../state/memory-state-store.js";
import type { PendingMediaManager } from "../inbound-media.js";
import { clearedPendingMediaText } from "../inbound-media.js";
import type { BridgeDelivery } from "../delivery.js";
import type { BridgeRouteQueue } from "../route-queue.js";
import type { BridgeRouteSteering } from "../route-steering.js";

export interface StopCommandOptions {
  state: MemoryStateStore;
  codex: CodexAdapter;
  approvals: ApprovalManager;
  pendingMedia: PendingMediaManager;
  delivery: BridgeDelivery;
  routeQueue: BridgeRouteQueue;
  routeSteering: BridgeRouteSteering;
  clearPendingInput?(routeKey: string): number;
}

export async function handleStopCommand(
  options: StopCommandOptions,
  message: ChannelMessage,
  target: ChannelTarget,
): Promise<void> {
  const binding = options.state.getBinding(message.routeKey);
  const clearedMedia = options.pendingMedia.clear(message.routeKey);
  const clearedInputs = options.clearPendingInput?.(message.routeKey) ?? 0;
  if (!binding) {
    await options.delivery.sendText(target, [
      "当前没有活跃 Codex 会话。",
      clearedInputs > 0 ? `已清理 ${clearedInputs} 个等待回答的 Codex 输入请求。` : undefined,
      clearedMedia > 0 ? clearedPendingMediaText(clearedMedia) : undefined,
    ].filter(Boolean).join("\n"));
    return;
  }
  const status = await options.codex.getStatus(binding.sessionId);
  const workerRunning = options.routeQueue.hasWorker(message.routeKey);
  const clearedSteers = options.routeSteering.clearRouteState(message.routeKey);
  if (!workerRunning && status.type !== "running" && status.type !== "waiting_approval" && status.type !== "waiting_input") {
    await options.delivery.sendText(target, [
      "当前没有正在运行的 Codex 任务。",
      clearedSteers > 0 ? `已清空 ${clearedSteers} 条待投递补充消息。` : undefined,
      clearedInputs > 0 ? `已清理 ${clearedInputs} 个等待回答的 Codex 输入请求。` : undefined,
      clearedMedia > 0 ? clearedPendingMediaText(clearedMedia) : undefined,
    ].filter(Boolean).join("\n"));
    return;
  }
  if (!options.codex.cancel) {
    await options.delivery.sendText(target, "当前 Codex Adapter 不支持取消。");
    return;
  }
  const clearedQueued = options.routeQueue.clearQueued(message.routeKey);
  options.routeQueue.abortRoute(message.routeKey);
  await options.codex.cancel(binding.sessionId);
  options.approvals.cancelRoute(message.routeKey, "任务已停止");
  options.state.setSessionStatus(binding.sessionId, { type: "idle" });
  await options.delivery.sendTyping(target, false);
  await options.delivery.sendText(target, [
    "已请求停止当前 Codex 任务。",
    clearedSteers > 0 ? `已清空 ${clearedSteers} 条待投递补充消息。` : undefined,
    clearedQueued > 0 ? `已清空 ${clearedQueued} 条排队消息。` : undefined,
    clearedInputs > 0 ? `已清理 ${clearedInputs} 个等待回答的 Codex 输入请求。` : undefined,
    clearedMedia > 0 ? clearedPendingMediaText(clearedMedia) : undefined,
  ].filter(Boolean).join("\n"));
}
