import type { CodexProgressKind } from "../types.js";
import { arrayValue, objectValue, stringValue } from "./value-parsers.js";

export interface ServerRequestContext {
  sessionId?: string;
  turnId?: string;
  itemId?: string;
}

export interface UnsupportedServerRequestNotice extends ServerRequestContext {
  text: string;
  kind?: CodexProgressKind;
}

export interface UnsupportedServerRequestResponse {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  notice?: UnsupportedServerRequestNotice;
}

const UNSUPPORTED_CODE = -32000;

export function contextFromServerRequestParams(params: Record<string, unknown>): ServerRequestContext {
  return {
    sessionId: stringValue(params.threadId) ?? stringValue(params.conversationId),
    turnId: stringValue(params.turnId) ?? stringValue(params.callId),
    itemId: stringValue(params.itemId) ?? stringValue(params.callId),
  };
}

export function unsupportedServerRequestResponse(
  method: string,
  params: Record<string, unknown>,
): UnsupportedServerRequestResponse {
  const context = contextFromServerRequestParams(params);
  if (method === "item/tool/requestUserInput") {
    return {
      error: unsupportedError("Codex 请求了额外用户输入，但 Chat-Codex 当前尚未支持该交互。"),
      notice: {
        ...context,
        text: requestUserInputNotice(params),
        kind: "tool",
      },
    };
  }
  if (method === "mcpServer/elicitation/request") {
    return {
      result: { action: "cancel", content: null, _meta: null },
      notice: {
        ...context,
        text: mcpElicitationNotice(params),
        kind: "tool",
      },
    };
  }
  if (method === "item/tool/call") {
    const text = dynamicToolNotice(params);
    return {
      result: {
        success: false,
        contentItems: [{ type: "inputText", text }],
      },
      notice: {
        ...context,
        text,
        kind: "tool",
      },
    };
  }
  if (method === "account/chatgptAuthTokens/refresh") {
    return {
      error: unsupportedError("Chat-Codex 不接管 Codex ChatGPT token 刷新。请在 Codex CLI/App 中完成登录或刷新。"),
      notice: {
        ...context,
        text: "Codex 请求刷新 ChatGPT 登录 token，但 Chat-Codex 不管理账号认证；本次请求已拒绝。",
        kind: "other",
      },
    };
  }
  if (method === "attestation/generate") {
    return {
      error: unsupportedError("Chat-Codex 未提供 app-server attestation token。"),
      notice: {
        ...context,
        text: "Codex 请求生成 attestation token，但 Chat-Codex 当前未提供该客户端能力；本次请求已拒绝。",
        kind: "other",
      },
    };
  }
  return {
    error: { code: -32601, message: `unsupported server request: ${method}` },
    notice: context.sessionId || context.turnId
      ? {
          ...context,
          text: `Codex 发起了 Chat-Codex 未分类的 app-server 请求：${method}。本次请求已拒绝。`,
          kind: "other",
        }
      : undefined,
  };
}

function unsupportedError(message: string): { code: number; message: string } {
  return { code: UNSUPPORTED_CODE, message };
}

function requestUserInputNotice(params: Record<string, unknown>): string {
  const questions = arrayValue(params.questions)
    .map((entry) => objectValue(entry))
    .map((question) => stringValue(question.header) ?? stringValue(question.question))
    .filter((value): value is string => Boolean(value));
  const suffix = questions.length > 0 ? `问题：${questions.slice(0, 3).join("；")}` : undefined;
  return [
    "Codex 请求额外用户输入，但当前 Chat-Codex 尚未支持该交互；本次请求已拒绝。",
    suffix,
  ].filter(Boolean).join("\n");
}

function mcpElicitationNotice(params: Record<string, unknown>): string {
  const serverName = stringValue(params.serverName);
  const mode = stringValue(params.mode);
  const message = stringValue(params.message);
  return [
    `Codex 请求 MCP elicitation${serverName ? `（${serverName}）` : ""}${mode ? `：${mode}` : ""}。`,
    message ? `摘要：${message}` : undefined,
    "Chat-Codex 当前不处理 MCP 交互，本次请求已取消。",
  ].filter(Boolean).join("\n");
}

function dynamicToolNotice(params: Record<string, unknown>): string {
  const namespace = stringValue(params.namespace);
  const tool = stringValue(params.tool);
  const toolName = [namespace, tool].filter(Boolean).join(".");
  return `Codex 请求调用动态工具${toolName ? ` ${toolName}` : ""}，但 Chat-Codex 当前没有开放动态工具桥接；本次调用已拒绝。`;
}
