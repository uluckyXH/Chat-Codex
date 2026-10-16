import type { CodexNotification, CodexProgressKind, CodexTurnError } from "../types.js";
import { commandExecutionProgress } from "./command-output-summary.js";
import { arrayValue, numberValue, objectValue, stringValue } from "./value-parsers.js";
import { isAbsolute, win32 } from "node:path";

export interface AppServerReconnectNotice {
  message: string;
  attempt: number;
  total: number;
}

export function notificationText(
  method: string,
  params: Record<string, unknown>,
): Pick<CodexNotification, "text" | "kind" | "dedupeWindowMs" | "visibility"> | undefined {
  if (method === "warning") {
    const message = stringValue(params.message);
    return message ? { text: `Codex 警告：${message}`, kind: "warning", dedupeWindowMs: 10 * 60_000 } : undefined;
  }
  if (method === "guardianWarning") {
    const message = stringValue(params.message);
    if (!message) return undefined;
    // Match the official Codex TUI's success notice prefix; other guardian warnings stay visible.
    const visibility = message.startsWith("Automatic approval review approved (") ? "local" : "channel";
    return { text: `Codex 安全提示：${message}`, kind: "security", visibility, dedupeWindowMs: 10 * 60_000 };
  }
  if (method === "deprecationNotice") {
    const summary = stringValue(params.summary);
    const details = stringValue(params.details);
    const text = summary ? [`Codex 兼容性提示：${summary}`, details].filter(Boolean).join("\n") : undefined;
    return text ? { text, kind: "deprecation", dedupeWindowMs: 30 * 60_000 } : undefined;
  }
  if (method === "configWarning") {
    const summary = stringValue(params.summary);
    const details = stringValue(params.details);
    const configPath = stringValue(params.path);
    const text = summary ? [`Codex 配置警告：${summary}`, details, configPath ? `Path: ${configPath}` : undefined].filter(Boolean).join("\n") : undefined;
    return text ? { text, kind: "config", dedupeWindowMs: 30 * 60_000 } : undefined;
  }
  if (method === "windows/worldWritableWarning") {
    const message = stringValue(params.message) ?? stringValue(params.summary);
    return message ? { text: `Codex Windows 沙箱警告：${message}`, kind: "warning", dedupeWindowMs: 30 * 60_000 } : undefined;
  }
  return undefined;
}

export function messagePhaseValue(value: unknown): "commentary" | "partial_answer" | "final_answer" | undefined {
  return value === "commentary" || value === "partial_answer" || value === "final_answer" ? value : undefined;
}

export function progressFromThreadItem(item: Record<string, unknown>): { text: string; kind: CodexProgressKind } | undefined {
  const itemType = stringValue(item.type);
  if (itemType === "commandExecution") {
    return commandExecutionProgress({
      command: stringValue(item.command),
      cwd: stringValue(item.cwd),
      status: stringValue(item.status),
      exitCode: numberValue(item.exitCode),
      durationMs: numberValue(item.durationMs),
      aggregatedOutput: stringValue(item.aggregatedOutput),
    });
  }
  if (itemType === "fileChange") {
    const changes = arrayValue(item.changes)
      .map((entry) => stringValue(objectValue(entry).path) ?? stringValue(objectValue(entry).absolutePath))
      .filter(Boolean)
      .slice(0, 5)
      .join(", ");
    return changes || itemFailed(item) ? { text: `文件变更${itemFailed(item) ? "失败" : "完成"}${changes ? `: ${changes}` : ""}`, kind: "file_change" } : undefined;
  }
  if (itemType === "mcpToolCall") {
    const tool = [stringValue(item.server), stringValue(item.tool)].filter(Boolean).join("/");
    return tool ? { text: `工具调用${itemFailed(item) ? "失败" : "完成"}: ${tool}`, kind: "tool" } : undefined;
  }
  if (itemType === "webSearch") {
    const query = stringValue(item.query);
    return query ? { text: `搜索${itemFailed(item) ? "失败" : "完成"}: ${query}`, kind: "search" } : undefined;
  }
  if (itemType === "imageView") {
    const path = localImagePath(item.path);
    return path ? { text: `图像查看完成: ${path}`, kind: "file_change" } : undefined;
  }
  if (itemType === "imageGeneration") {
    if (itemFailed(item)) {
      const failure = objectValue(item.failure);
      return { text: failure.type === "usageLimitExceeded" ? "图像生成失败：已达到用量上限。" : "图像生成失败。", kind: "file_change" };
    }
    const path = localImagePath(item.savedPath);
    return { text: path ? `媒体生成完成: ${path}` : "图像生成完成（未提供本地文件路径）。", kind: "file_change" };
  }
  return undefined;
}

export function itemFailed(item: Record<string, unknown>): boolean {
  return ["failed", "error", "declined", "cancelled", "canceled"].includes(String(item.status).toLowerCase())
    || item.failure != null || item.error != null || objectValue(item.result).isError === true;
}

function localImagePath(value: unknown): string | undefined {
  const path = stringValue(value);
  return path && !/^https?:|^data:/i.test(path) && !/[\r\n\0]/.test(path) && (isAbsolute(path) || win32.isAbsolute(path)) ? path : undefined;
}

export function textFromPlan(params: Record<string, unknown>): string | undefined {
  const plan = arrayValue(params.plan);
  const active = plan
    .map((entry) => {
      const object = objectValue(entry);
      return stringValue(object.step) ?? stringValue(object.text) ?? (typeof entry === "string" ? entry : undefined);
    })
    .filter(Boolean)
    .at(-1);
  return active;
}

export function shouldFlushProgressDraft(text: string): boolean {
  const normalized = text.trim();
  return normalized.length >= 400 || /[。！？.!?]\s*$/.test(normalized) || normalized.includes("\n");
}

export function appServerErrorMessage(params: Record<string, unknown>): string {
  return stringValue(objectValue(params.error).message)
    ?? stringValue(params.message)
    ?? "codex app-server error";
}

export function turnErrorDetails(value: unknown, message: string): CodexTurnError {
  const error = objectValue(value);
  return {
    message,
    ...(error.codexErrorInfo != null ? { codexErrorInfo: error.codexErrorInfo } : {}),
    ...(stringValue(error.additionalDetails) ? { additionalDetails: stringValue(error.additionalDetails) } : {}),
    ...(error.misalignment != null ? { misalignment: error.misalignment } : {}),
  };
}

export function parseAppServerReconnectNotice(message: string): AppServerReconnectNotice | undefined {
  const normalized = message.trim();
  const match = /^Reconnecting\.\.\.\s+(\d+)\/(\d+)\b/i.exec(normalized);
  if (!match) return undefined;
  const attempt = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(attempt) || !Number.isSafeInteger(total)) return undefined;
  if (attempt <= 0 || total <= 0 || attempt > total) return undefined;
  return { message: normalized, attempt, total };
}

export function isTransientAppServerError(message: string): boolean {
  return parseAppServerReconnectNotice(message) !== undefined;
}
