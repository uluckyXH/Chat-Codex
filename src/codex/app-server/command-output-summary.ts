export interface CommandOutputBuffer {
  totalChars: number;
  totalLines: number;
  repeatedStatusLines: number;
  headLines: string[];
  tailLines: string[];
  pendingLine: string;
  lastStatusSignature?: string;
  lastStatusLine?: string;
  sawControlChars: boolean;
}

export interface CommandExecutionRecord {
  itemId: string;
  command?: string;
  cwd?: string;
  startedAtMs?: number;
  output: CommandOutputBuffer;
}

export interface CommandExecutionProgressInput {
  command?: string;
  cwd?: string;
  status?: string;
  exitCode?: number;
  durationMs?: number;
  aggregatedOutput?: string;
  output?: CommandOutputBuffer;
}

const HEAD_LINE_LIMIT = 4;
const TAIL_LINE_LIMIT = 80;
const SUCCESS_SUMMARY_LINES = 20;
const FAILURE_SUMMARY_LINES = 40;
const SUCCESS_SUMMARY_CHARS = 800;
const FAILURE_SUMMARY_CHARS = 1600;
const COMMAND_LABEL_MAX_CHARS = 180;

export function createCommandExecutionRecord(input: {
  itemId: string;
  command?: string;
  cwd?: string;
  startedAtMs?: number;
}): CommandExecutionRecord {
  return {
    itemId: input.itemId,
    command: input.command,
    cwd: input.cwd,
    startedAtMs: input.startedAtMs,
    output: createCommandOutputBuffer(),
  };
}

export function createCommandOutputBuffer(): CommandOutputBuffer {
  return {
    totalChars: 0,
    totalLines: 0,
    repeatedStatusLines: 0,
    headLines: [],
    tailLines: [],
    pendingLine: "",
    sawControlChars: false,
  };
}

export function appendCommandOutput(buffer: CommandOutputBuffer, delta: string): void {
  if (!delta) return;
  const cleaned = cleanCommandOutputDelta(delta);
  buffer.sawControlChars = buffer.sawControlChars || cleaned.sawControlChars;
  buffer.totalChars += cleaned.text.length;
  const normalized = cleaned.text.replace(/\r/g, "\n");
  const lines = `${buffer.pendingLine}${normalized}`.split("\n");
  buffer.pendingLine = lines.pop() ?? "";
  for (const line of lines) appendCommandLine(buffer, line);
}

export function finalizeCommandOutput(buffer: CommandOutputBuffer): void {
  if (!buffer.pendingLine) return;
  appendCommandLine(buffer, buffer.pendingLine);
  buffer.pendingLine = "";
}

export function commandStartProgress(command: string | undefined): string | undefined {
  if (!command) return undefined;
  return `正在执行命令: ${truncateSingleLine(command, COMMAND_LABEL_MAX_CHARS)}`;
}

export function commandExecutionProgress(input: CommandExecutionProgressInput): { text: string; kind: "command" } | undefined {
  const command = input.command?.trim();
  if (!command) return undefined;
  const failed = input.status === "failed" || (typeof input.exitCode === "number" && input.exitCode !== 0);
  const label = failed ? "命令失败" : "命令完成";
  const parts = [`${label}: ${truncateSingleLine(command, COMMAND_LABEL_MAX_CHARS)}`];
  const meta = commandMeta(input);
  if (meta) parts.push(meta);

  const output = commandOutputSummary(input, failed);
  if (output) {
    parts.push(`${failed ? "错误摘要" : "输出摘要"}:\n${output}`);
  }

  return { text: parts.join("\n"), kind: "command" };
}

export function commandOutputSummary(input: CommandExecutionProgressInput, failed = false): string | undefined {
  const buffer = input.aggregatedOutput
    ? bufferFromText(input.aggregatedOutput)
    : input.output;
  if (!buffer) return undefined;
  finalizeCommandOutput(buffer);
  const lines = selectedOutputLines(buffer, failed ? FAILURE_SUMMARY_LINES : SUCCESS_SUMMARY_LINES);
  const body = lines.join("\n").trim();
  const statusLine = buffer.repeatedStatusLines > 0 && buffer.lastStatusLine
    ? `重复状态输出 ${buffer.repeatedStatusLines} 次，最后状态: ${truncateSingleLine(buffer.lastStatusLine, 160)}`
    : undefined;
  const visible = [body || undefined, statusLine].filter(Boolean).join("\n").trim();
  const maxChars = failed ? FAILURE_SUMMARY_CHARS : SUCCESS_SUMMARY_CHARS;
  const bounded = visible ? truncateOutputBody(visible, maxChars, failed) : undefined;
  const omitted = omissionLine(buffer, bounded ?? "");
  return [bounded, omitted].filter(Boolean).join("\n").trim() || undefined;
}

export function cleanCommandOutputDelta(delta: string): { text: string; sawControlChars: boolean } {
  const withoutAnsi = delta.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "");
  const sawControlChars = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]|\x1B/.test(delta);
  return {
    text: withoutAnsi.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ""),
    sawControlChars,
  };
}

function bufferFromText(text: string): CommandOutputBuffer {
  const buffer = createCommandOutputBuffer();
  appendCommandOutput(buffer, text);
  finalizeCommandOutput(buffer);
  return buffer;
}

function appendCommandLine(buffer: CommandOutputBuffer, rawLine: string): void {
  const line = rawLine.replace(/[ \t]+$/g, "");
  if (!line.trim()) return;
  buffer.totalLines += 1;
  const statusSignature = statusLineSignature(line);
  if (statusSignature && statusSignature === buffer.lastStatusSignature) {
    buffer.repeatedStatusLines += 1;
    buffer.lastStatusLine = line.trim();
    return;
  }
  buffer.lastStatusSignature = statusSignature;
  if (statusSignature) buffer.lastStatusLine = line.trim();
  if (buffer.headLines.length < HEAD_LINE_LIMIT) buffer.headLines.push(line);
  buffer.tailLines.push(line);
  if (buffer.tailLines.length > TAIL_LINE_LIMIT) buffer.tailLines.shift();
}

function selectedOutputLines(buffer: CommandOutputBuffer, maxLines: number): string[] {
  if (buffer.totalLines <= maxLines && buffer.tailLines.length <= maxLines) {
    return [...buffer.tailLines];
  }
  const headCount = Math.min(HEAD_LINE_LIMIT, Math.max(1, Math.floor(maxLines / 4)));
  const tailCount = Math.max(1, maxLines - headCount - 1);
  const head = buffer.headLines.slice(0, headCount);
  const tail = buffer.tailLines.slice(-tailCount);
  const visibleCount = head.length + tail.length;
  const omitted = Math.max(0, buffer.totalLines - visibleCount);
  return [
    ...head,
    omitted > 0 ? `... 已省略 ${omitted} 行 ...` : undefined,
    ...tail,
  ].filter((line): line is string => Boolean(line));
}

function omissionLine(buffer: CommandOutputBuffer, visibleText: string): string | undefined {
  const visibleLines = visibleText ? visibleText.split("\n").filter((line) => line.trim()).length : 0;
  const omittedLines = Math.max(0, buffer.totalLines - visibleLines);
  const notes: string[] = [];
  if (omittedLines > 0) {
    const omittedChars = Math.max(0, buffer.totalChars - visibleText.length);
    notes.push(`已省略 ${omittedLines} 行 / ${omittedChars} 字符。`);
  }
  if (buffer.sawControlChars) {
    notes.push("已清理 ANSI/control 控制字符。");
  }
  return notes.join(" ");
}

function truncateOutputBody(text: string, maxChars: number, preferTail: boolean): string {
  if (text.length <= maxChars) return text;
  const marker = "\n... 已按字符上限截断 ...\n";
  const remaining = Math.max(0, maxChars - marker.length);
  if (preferTail) {
    return `${marker}${text.slice(-remaining)}`.trim();
  }
  const headChars = Math.floor(remaining * 0.4);
  const tailChars = remaining - headChars;
  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`.trim();
}

function commandMeta(input: CommandExecutionProgressInput): string | undefined {
  const meta: string[] = [];
  if (typeof input.exitCode === "number") meta.push(`exit=${input.exitCode}`);
  if (typeof input.durationMs === "number") meta.push(`耗时=${formatDuration(input.durationMs)}`);
  return meta.length > 0 ? `(${meta.join(", ")})` : undefined;
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "unknown";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function truncateSingleLine(text: string, maxChars: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= maxChars) return line;
  return `${line.slice(0, maxChars - 3)}...`;
}

function statusLineSignature(line: string): string | undefined {
  const trimmed = line.trim();
  if (!looksLikeStatusLine(trimmed)) return undefined;
  return trimmed
    .toLowerCase()
    .replace(/\d+(?:\.\d+)?%/g, "<pct>")
    .replace(/\d+:\d+(?::\d+)?/g, "<time>")
    .replace(/\d+(?:\.\d+)?/g, "<num>")
    .replace(/[|/\\\-⠁-⣿]+/gu, "<spin>")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeStatusLine(line: string): boolean {
  if (!line) return false;
  if (/^[|/\\\-⠁-⣿. ]+$/u.test(line)) return true;
  if (/\d+(?:\.\d+)?%/.test(line)) return true;
  if (/[▏▎▍▌▋▊▉█#=-]{5,}/u.test(line)) return true;
  return /\b(waiting|running|still|progress|loading|building|compiling|installing|fetching|downloading|processing)\b/i.test(line)
    || /(等待|运行中|处理中|加载中|构建中|编译中)/.test(line);
}
