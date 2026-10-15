import type { CodexAssistantMessage } from "../types.js";
import { messagePhaseValue } from "./notification-mapper.js";
import { arrayValue, objectValue, stringValue } from "./value-parsers.js";

export function isIntermediateMessage(message: CodexAssistantMessage): boolean {
  return message.phase === "partial_answer" || message.delivery === "async" || Boolean(message.questions?.length);
}

export function isFinalAssistantItem(item: Record<string, unknown>): boolean {
  return item.type === "agentMessage"
    && (item.phase == null || item.phase === "final_answer")
    && item.delivery !== "async"
    && arrayValue(item.questions).length === 0;
}

/** Per-turn item identities, independent from presentation and channel policy. */
export class AssistantMessages {
  private readonly items = new Map<string, CodexAssistantMessage>();
  private readonly completed = new Set<string>();

  record(item: Record<string, unknown>): CodexAssistantMessage {
    const itemId = stringValue(item.id);
    const key = itemId ?? "__legacy__";
    const previous = this.items.get(key);
    if (this.completed.has(key) && previous) return previous;
    const phase = messagePhaseValue(item.phase) ?? previous?.phase;
    const delivery = item.delivery === "async" ? "async" : previous?.delivery;
    const questions = Array.isArray(item.questions) ? item.questions.map((value) => {
      const question = objectValue(value);
      return { title: stringValue(question.title) ?? "", options: arrayValue(question.options).filter((value): value is string => typeof value === "string") };
    }).filter((question) => question.title) : previous?.questions;
    const message: CodexAssistantMessage = {
      ...(itemId ? { itemId } : {}),
      text: typeof item.text === "string" ? item.text : previous?.text ?? "",
      ...(phase ? { phase } : {}),
      ...(delivery ? { delivery } : {}),
      ...(questions ? { questions } : {}),
    };
    this.items.set(key, message);
    return message;
  }

  append(itemId: string | undefined, delta: string): CodexAssistantMessage | undefined {
    if (itemId && this.completed.has(itemId)) return undefined;
    const previous = this.items.get(itemId ?? "__legacy__");
    return this.record({ id: itemId, text: (previous?.text ?? "") + delta });
  }

  complete(item: Record<string, unknown>): CodexAssistantMessage | undefined {
    const id = stringValue(item.id);
    if (id && this.completed.has(id)) return undefined;
    const message = this.record(item);
    if (id) this.completed.add(id);
    return message;
  }

  finalText(): string {
    let text = "";
    for (const message of this.items.values()) {
      if (message.phase !== "commentary" && !isIntermediateMessage(message)) text = message.text;
    }
    return text;
  }
}
