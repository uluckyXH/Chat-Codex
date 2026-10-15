import type { CodexAssistantMessage } from "../codex/types.js";

/** Async questions are ordinary user replies/steers, not RPC input requests. */
export function formatAssistantMessage(message: CodexAssistantMessage): string {
  const questions = (message.questions ?? []).map((question) => [
    question.title,
    ...question.options.map((option, index) => `${index + 1}. ${option}`),
  ].join("\n"));
  return [message.text, ...questions, questions.length ? "请直接回复选项内容或补充说明；任务会继续执行。" : undefined].filter(Boolean).join("\n\n");
}
