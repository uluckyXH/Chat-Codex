import type {
  CodexCollaborationMode,
  CodexModelPolicy,
  CodexSessionBaseStatus,
  CodexSessionStatus,
} from "../types.js";
import { modelInfoWithPolicy } from "./model-policy.js";
import type { AppServerSessionRecord } from "./types.js";

export function withContext(record: AppServerSessionRecord, status: CodexSessionBaseStatus): CodexSessionStatus {
  return {
    ...status,
    ...(record.status.context ? { context: record.status.context } : {}),
    ...(record.status.model ? { model: record.status.model } : {}),
  };
}

export function withModelPolicy(status: CodexSessionStatus, policy: CodexModelPolicy): CodexSessionStatus {
  const model = modelInfoWithPolicy(status.model, policy);
  return {
    ...status,
    ...(model ? { model } : {}),
  };
}

export function collaborationModePayload(
  mode: CodexCollaborationMode,
  policy: CodexModelPolicy,
  stored: AppServerSessionRecord,
): Record<string, unknown> {
  const model = policy.model ?? stored.status.model?.model ?? stored.baseModel?.model;
  if (!model) {
    throw new Error("无法切换 Codex 协作模式：缺少当前模型信息。");
  }
  const reasoningEffort = policy.reasoningEffort
    ?? stored.status.model?.reasoningEffort
    ?? stored.baseModel?.reasoningEffort
    ?? null;
  return {
    mode,
    settings: {
      model,
      reasoning_effort: reasoningEffort,
      developer_instructions: null,
    },
  };
}

export function truncatePrompt(prompt: string, maxLength = 120): string {
  const normalized = prompt.trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}
