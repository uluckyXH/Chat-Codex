import type { Writable } from "node:stream";
import { env, stdout } from "node:process";
import type { ChannelMedia, ChannelMessage, ChannelTarget } from "../protocol/channel.js";

export interface TranscriptSink {
  inbound(message: ChannelMessage, text: string): void;
  outbound(target: ChannelTarget, text: string): void;
  outboundMedia?(target: ChannelTarget, media: ChannelMedia): void;
}

export interface ConsoleTranscriptSinkOptions {
  output?: Writable;
  verbose?: boolean;
  maxTextLength?: number;
  color?: boolean | "auto";
  now?: () => Date;
}

type TranscriptTone = "inbound" | "reply" | "progress" | "approval" | "command" | "queue" | "error" | "stop" | "media";

export class ConsoleTranscriptSink implements TranscriptSink {
  private readonly output: Writable;
  private readonly verbose: boolean;
  private readonly maxTextLength: number;
  private readonly color: boolean;
  private readonly now: () => Date;

  constructor(optionsOrOutput: Writable | ConsoleTranscriptSinkOptions = stdout) {
    if (isWritable(optionsOrOutput)) {
      this.output = optionsOrOutput;
      this.verbose = false;
      this.maxTextLength = 3000;
      this.color = shouldColor(optionsOrOutput, "auto");
      this.now = () => new Date();
    } else {
      this.output = optionsOrOutput.output ?? stdout;
      this.verbose = optionsOrOutput.verbose ?? false;
      this.maxTextLength = optionsOrOutput.maxTextLength ?? 3000;
      this.color = shouldColor(this.output, optionsOrOutput.color ?? "auto");
      this.now = optionsOrOutput.now ?? (() => new Date());
    }
  }

  inbound(message: ChannelMessage, text: string): void {
    const tone: TranscriptTone = "inbound";
    this.writeBlock([
      this.header(channelLabel(message.channelId), "<=", displaySender(message), formatConversation(message.conversation.kind, message.conversation.id), tone),
      this.verbose ? `route: ${message.routeKey}` : undefined,
      this.verbose ? `sender: ${message.sender.id}` : undefined,
      ...this.bodyLines(text, tone),
    ]);
  }

  outbound(target: ChannelTarget, text: string): void {
    const detail = classifyOutbound(text);
    const tone = toneForOutbound(detail);
    this.writeBlock([
      this.header(channelLabel(target.channelId), "=>", formatConversation(target.conversation.kind, target.conversation.id), detail, tone),
      this.verbose ? `route: ${target.routeKey}` : undefined,
      ...this.bodyLines(text, tone),
    ]);
  }

  outboundMedia(target: ChannelTarget, media: ChannelMedia): void {
    const mediaName = media.name ?? media.path ?? media.url ?? "";
    const tone: TranscriptTone = "media";
    this.writeBlock([
      this.header(channelLabel(target.channelId), "=>", formatConversation(target.conversation.kind, target.conversation.id), `媒体 ${media.type}`, tone),
      this.verbose ? `route: ${target.routeKey}` : undefined,
      ...this.bodyLines([
        mediaName ? `文件: ${mediaName}` : undefined,
        media.path ? `路径: ${media.path}` : undefined,
        media.url ? `URL: ${media.url}` : undefined,
        media.mimeType ? `类型: ${media.mimeType}` : undefined,
        media.sizeBytes !== undefined ? `大小: ${media.sizeBytes} bytes` : undefined,
        media.caption ? `说明: ${media.caption}` : undefined,
      ].filter((line): line is string => Boolean(line)).join("\n"), tone),
    ]);
  }

  private header(channel: string, direction: "<=" | "=>", subject: string, detail: string, tone: TranscriptTone): string {
    return paint(this.color, headerColor(tone), `[${formatClock(this.now())}] ${channel} ${direction} ${subject} | ${detail}`);
  }

  private writeBlock(lines: Array<string | undefined>): void {
    this.output.write(`\n${lines.filter((line): line is string => Boolean(line)).join("\n")}\n`);
  }

  private bodyLines(text: string, tone: TranscriptTone): string[] {
    const normalized = truncateText(text.trim(), this.maxTextLength);
    if (!normalized) return [];
    const color = bodyColor(tone);
    return normalized.split(/\r?\n/).map((line) => paint(this.color, color, `  ${line}`));
  }
}

function isWritable(value: Writable | ConsoleTranscriptSinkOptions): value is Writable {
  return typeof (value as Writable).write === "function";
}

function channelLabel(channelId: string): string {
  if (channelId === "weixin") return "微信";
  if (channelId === "terminal") return "终端";
  if (channelId === "mock") return "Mock";
  return channelId;
}

function displaySender(message: ChannelMessage): string {
  return shorten(message.sender.displayName ?? message.sender.id, 32);
}

function formatConversation(kind: string, id: string): string {
  return `${kind}:${shorten(id, 32)}`;
}

function classifyOutbound(text: string): string {
  if (text.startsWith("Codex 正在处理")) return "开始";
  if (text.startsWith("Codex 进度:")) return "进度";
  if (text.startsWith("Codex 请求审批")) return "审批";
  if (text.startsWith("审批已处理")) return "审批";
  if (text.startsWith("已加入队列")) return "队列";
  if (text.startsWith("Codex 执行失败")) return "错误";
  if (text.startsWith("已请求停止")) return "停止";
  if (text.startsWith("当前") || text.startsWith("可用命令:") || text.startsWith("Bridge:")) return "命令回复";
  return "回复";
}

function toneForOutbound(detail: string): TranscriptTone {
  if (detail === "进度") return "progress";
  if (detail === "审批") return "approval";
  if (detail === "队列") return "queue";
  if (detail === "错误") return "error";
  if (detail === "停止") return "stop";
  if (detail === "命令回复") return "command";
  return "reply";
}

function shouldColor(output: Writable, setting: boolean | "auto"): boolean {
  if (setting !== "auto") return setting;
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  return Boolean((output as Writable & { isTTY?: boolean }).isTTY);
}

function headerColor(tone: TranscriptTone): string {
  switch (tone) {
    case "inbound": return "36;1";
    case "reply": return "32;1";
    case "progress": return "33;1";
    case "approval": return "35;1";
    case "command": return "34;1";
    case "queue": return "33;1";
    case "error": return "31;1";
    case "stop": return "31;1";
    case "media": return "36;1";
  }
}

function bodyColor(tone: TranscriptTone): string {
  switch (tone) {
    case "inbound": return "36";
    case "reply": return "32";
    case "progress": return "33";
    case "approval": return "35";
    case "command": return "34";
    case "queue": return "33";
    case "error": return "31";
    case "stop": return "31";
    case "media": return "36";
  }
}

function paint(enabled: boolean, color: string, value: string): string {
  return enabled ? `\x1b[${color}m${value}\x1b[0m` : value;
}

function formatClock(date: Date): string {
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function shorten(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 12))}\n...已截断`;
}
