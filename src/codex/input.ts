import type { ChannelAttachment } from "../protocol/channel.js";
export type CodexInputItem =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string; origin?: ChannelAttachment["origin"] }
  | { type: "localFile"; path: string; name?: string; mimeType?: string; origin?: ChannelAttachment["origin"] };

export interface CodexTurnInput {
  text: string;
  items: CodexInputItem[];
}

export type CodexPromptInput = string | CodexTurnInput;

export function textCodexInput(text: string): CodexTurnInput {
  return {
    text,
    items: text ? [{ type: "text", text }] : [],
  };
}

export function normalizeCodexInput(input: CodexPromptInput): CodexTurnInput {
  if (typeof input === "string") return textCodexInput(input);
  const text = input.text ?? textFromItems(input.items);
  const items: CodexInputItem[] = input.items.length > 0
    ? input.items.map((item) => ({ ...item }))
    : text
      ? [{ type: "text", text }]
      : [];
  return { text, items };
}

export function codexInputText(input: CodexPromptInput): string {
  return normalizeCodexInput(input).text;
}

export function codexInputPlainText(input: CodexPromptInput): string {
  const normalized = normalizeCodexInput(input);
  const lines: string[] = [];
  const text = normalized.text.trim();
  if (text) lines.push(text);
  const localImages = normalized.items.filter((item) => item.type === "localImage");
  if (localImages.length > 0) {
    lines.push([
      localImages.length === 1 ? "用户上传了图片：" : `用户上传了 ${localImages.length} 张图片：`,
      ...localImages.map((item) => `- ${item.path}`),
    ].join("\n"));
  }
  const localFiles = normalized.items.filter((item) => item.type === "localFile");
  if (localFiles.length > 0) {
    lines.push([
      localFiles.length === 1 ? "用户上传了文件：" : `用户上传了 ${localFiles.length} 个文件：`,
      ...localFiles.map((item) => `- ${item.name ? `${item.name}: ` : ""}${item.path}${item.mimeType ? ` (${item.mimeType})` : ""}`),
    ].join("\n"));
  }
  return lines.join("\n\n");
}

export function withCodexInputText(input: CodexPromptInput, nextText: string): CodexTurnInput {
  const normalized = normalizeCodexInput(input);
  const items = normalized.items.map((item) => item.type === "text" ? { ...item, text: nextText } : { ...item });
  if (!items.some((item) => item.type === "text") && nextText) {
    items.unshift({ type: "text", text: nextText });
  }
  return { text: nextText, items };
}

export function textFromItems(items: CodexInputItem[]): string {
  return items
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n\n");
}

export function hasStructuredCodexInput(input: CodexPromptInput): boolean {
  return normalizeCodexInput(input).items.some((item) => item.type !== "text");
}
