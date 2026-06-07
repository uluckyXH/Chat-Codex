import type { ApprovalManager } from "../approvals/approval-manager.js";
import type { CodexAdapter, CodexCollaborationMode, CodexPromptInput, CodexSessionStatus } from "../codex/types.js";
import type { Logger } from "../logging/logger.js";
import type { TranscriptSink } from "../logging/transcript.js";
import type { ChannelRegistry } from "../channels/registry.js";
import type { ChannelAdapter, ChannelMessage, ChannelTarget } from "../protocol/channel.js";
import type { MemoryStateStore } from "../state/memory-state-store.js";
import type { SessionBindings } from "../state/session-bindings.js";
import type { TurnScheduler } from "./turn-scheduler.js";
import type { PairingCodeManager } from "./pairing-code-manager.js";
import type { ContextRefreshPolicy } from "../context-refresh/types.js";
import type { CodexSessionContextFingerprint } from "../codex/session-context-fingerprint.js";

export interface BridgeOptions {
  channel?: ChannelAdapter;
  channels?: ChannelRegistry;
  codex: CodexAdapter;
  state?: MemoryStateStore;
  sessionBindings?: SessionBindings;
  approvals?: ApprovalManager;
  turnScheduler?: TurnScheduler;
  logger?: Logger;
  transcript?: TranscriptSink;
  cwd?: string;
  initialSessionId?: string;
  initialRouteBinding?: InitialRouteBinding;
  unboundRoutePolicy?: UnboundRoutePolicy;
  progressMode?: ProgressDeliveryMode;
  approvalSendRetryDelayMs?: number;
  requestUserInputTimeoutMs?: number;
  steerDebounceMs?: number;
  steerBatchMaxMessages?: number;
  steerBatchMaxChars?: number;
  routeTrustMode?: RouteTrustMode;
  pairingCodeManager?: PairingCodeManager;
  contextRefresh?: BridgeContextRefreshOptions;
  channelCapabilities?: BridgeChannelCapabilityController;
  feishuGroupMemberStateRootDir?: string;
}

export interface BridgeContextRefreshOptions {
  defaultPolicy?: ContextRefreshPolicy;
  readFingerprint?(sessionId: string): CodexSessionContextFingerprint | undefined | Promise<CodexSessionContextFingerprint | undefined>;
}

export type BridgeChannelCapabilitySetResult =
  | { ok: true; enabled: boolean }
  | { ok: false; message: string };

export interface BridgeChannelCapabilityController {
  setGroupEnabled(channelId: string, enabled: boolean): BridgeChannelCapabilitySetResult | Promise<BridgeChannelCapabilitySetResult>;
}

export interface QueuedPrompt {
  message: ChannelMessage;
  target: ChannelTarget;
  input: CodexPromptInput;
  collaborationMode?: CodexCollaborationMode;
  sendFile: boolean;
}

export interface QueuedSteer {
  message: ChannelMessage;
  target: ChannelTarget;
  input: CodexPromptInput;
}

export interface RouteSteerState {
  queue: QueuedSteer[];
  draining: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface BackgroundTurnState {
  routeKey: string;
  message: ChannelMessage;
  target: ChannelTarget;
  finalText: string;
  finalPlanText: string;
}

export interface SessionChoice {
  id: string;
  title?: string;
  cwd?: string;
  status: CodexSessionStatus;
  updatedAt: string;
  current: boolean;
}

export type SessionListScope = "route" | "all" | "selectable";

export interface SessionListItem {
  id: string;
  title?: string;
  cwd?: string;
  status: CodexSessionStatus;
  updatedAt: string;
  current: boolean;
  selectable: boolean;
  ownerRouteKey?: string;
  unavailableReason?: string;
  source: "state" | "codex" | "merged";
}

export interface SessionListState {
  scope: SessionListScope;
  page: number;
  pageSize: number;
  createdAt: number;
  items: SessionListItem[];
}

export interface SessionSelectionState {
  items: SessionListItem[];
  page: number;
  pageSize: number;
  createdAt: number;
  hiddenUnavailableCount?: number;
}

export type CompactState =
  | { type: "none" }
  | { type: "confirming"; sessionId: string; requestedAt: string }
  | { type: "running"; sessionId: string; startedAt: string };

export type BindSessionResult =
  | { ok: true }
  | { ok: false; reason: "owner_conflict" | "resume_failed"; message: string };

export type InitialRouteBinding =
  | { type: "existing"; sessionId: string }
  | { type: "new" };

export type ProgressDeliveryMode = "brief" | "detailed" | "silent";
export type RouteTrustMode = "disabled" | "pairing_required" | "real_channels";
export type UnboundRoutePolicy = "auto_new" | "ask";

export const PROGRESS_SEND_FAILURE_COOLDOWN_MS = 60_000;
export const APPROVAL_SEND_RETRY_DELAY_MS = 10_000;
export const SEND_FILE_MAX_FILES = 3;
export const STEER_DEBOUNCE_MS = 1000;
export const STEER_BATCH_MAX_MESSAGES = 5;
export const STEER_BATCH_MAX_CHARS = 4000;
export const ROUTE_BUSY_MUTATION_REJECT_TEXT = [
  "当前对话的 Codex 正在执行，不能修改会话、权限、模型、协作模式或 Goal。",
  "上下文刷新设置也会在当前任务结束前被拦截。",
  "请等待完成，或发送 /stop 后再修改。",
].join("\n");
export const COMPACT_RUNNING_REJECT_TEXT = "当前正在压缩上下文，请等待完成后再操作。";
export const COMPACT_RUNNING_MESSAGE_REJECT_TEXT = "当前正在压缩上下文，请等待完成后再发送消息。";
