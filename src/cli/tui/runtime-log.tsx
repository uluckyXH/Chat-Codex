import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import type { ChannelMedia, ChannelMessage, ChannelTarget } from "../../protocol/channel.js";
import {
  transcriptChannelLabel,
  transcriptInboundDetail,
  transcriptInboundSubject,
  transcriptTargetConversation,
  type TranscriptSink,
} from "../../logging/transcript.js";
import type { Logger } from "../../logging/logger.js";
import type { CodexCliStatus, CodexRunPolicy } from "../../codex/codex-cli.js";
import { formatCodexCommandSource, formatCodexPlatform } from "../../codex/codex-process.js";
import { formatLocalClock } from "../../time/display-time.js";
import { Frame, KeyValue, Muted, Section, THEME } from "./ui-components.js";

export type RuntimeLogKind = "system" | "inbound" | "outbound" | "progress" | "media" | "warn" | "error";

export interface RuntimeLogEntry {
  id: number;
  time: Date;
  kind: RuntimeLogKind;
  source: string;
  message: string;
}

interface RuntimeLogLine {
  key: string;
  text: string;
  color?: string;
  wrap?: "wrap";
}

export interface RuntimeLogSummary {
  title: string;
  channels: string[];
  cwd: string;
  policy: CodexRunPolicy;
  routePolicy: string;
  codexStatus?: CodexCliStatus;
}

export class RuntimeLogStore {
  private readonly listeners = new Set<() => void>();
  private readonly entries: RuntimeLogEntry[] = [];
  private nextId = 1;

  add(kind: RuntimeLogKind, source: string, message: string): void {
    this.entries.push({
      id: this.nextId,
      time: new Date(),
      kind,
      source,
      message,
    });
    this.nextId += 1;
    if (this.entries.length > 300) this.entries.splice(0, this.entries.length - 300);
    for (const listener of this.listeners) listener();
  }

  clear(): void {
    this.entries.splice(0, this.entries.length);
    for (const listener of this.listeners) listener();
  }

  snapshot(): RuntimeLogEntry[] {
    return [...this.entries];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export class RuntimeTuiTranscriptSink implements TranscriptSink {
  constructor(private readonly store: RuntimeLogStore) {}

  inbound(message: ChannelMessage, text: string): void {
    this.store.add("inbound", `${transcriptChannelLabel(message.channelId)} <= ${transcriptInboundSubject(message)} | ${transcriptInboundDetail(message)}`, text);
  }

  outbound(target: ChannelTarget, text: string): void {
    this.store.add("outbound", `${transcriptChannelLabel(target.channelId)} => ${transcriptTargetConversation(target)}`, text);
  }

  outboundProgress(target: ChannelTarget, text: string): void {
    this.store.add("progress", `${transcriptChannelLabel(target.channelId)} => ${transcriptTargetConversation(target)}`, text);
  }

  localProgress(target: ChannelTarget, text: string): void {
    this.store.add("progress", `${transcriptChannelLabel(target.channelId)} -- ${transcriptTargetConversation(target)}`, text);
  }

  outboundMedia(target: ChannelTarget, media: ChannelMedia): void {
    const mediaName = media.name ?? media.path ?? media.url ?? "未命名媒体";
    this.store.add("media", `${transcriptChannelLabel(target.channelId)} => ${transcriptTargetConversation(target)}`, `${media.type}: ${mediaName}`);
  }
}

export class RuntimeTuiLogger implements Logger {
  constructor(private readonly store: RuntimeLogStore) {}

  info(message: string, meta?: Record<string, unknown>): void {
    this.store.add("system", "INFO", formatLogMessage(message, meta));
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.store.add("warn", "WARN", formatLogMessage(message, meta));
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.store.add("error", "ERROR", formatLogMessage(message, meta));
  }

  debug(): void {}
}

export function RuntimeLogView({ summary, store, interactive = true }: { summary: RuntimeLogSummary; store: RuntimeLogStore; interactive?: boolean }): React.JSX.Element {
  const [logs, setLogs] = useState<RuntimeLogEntry[]>(store.snapshot());
  const [scrollOffset, setScrollOffset] = useState(0);
  useEffect(() => store.subscribe(() => setLogs(store.snapshot())), [store]);
  // fixed: Frame(4) + "运行状态" section(3) + status line(1) + "服务" section(3) + 6 KeyValues(6) + "日志" section(3) + footer(2) = 22
  const { columns, rows } = useWindowSize();
  const visibleRows = Math.max(5, rows - 22);
  const logLineWidth = Math.max(24, columns - 10);
  const renderedLogLines = useMemo(() => logs.flatMap((entry) => runtimeLogLines(entry, logLineWidth)), [logs, logLineWidth]);
  useInput((input, key) => {
    const maxScroll = Math.max(0, renderedLogLines.length - visibleRows);
    const pageKey = key as typeof key & { pageUp?: boolean; pageDown?: boolean; home?: boolean; end?: boolean };
    if (key.upArrow || input === "k") {
      setScrollOffset((value) => Math.min(maxScroll, value + 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setScrollOffset((value) => Math.max(0, value - 1));
      return;
    }
    if (pageKey.pageUp) {
      setScrollOffset((value) => Math.min(maxScroll, value + visibleRows));
      return;
    }
    if (pageKey.pageDown) {
      setScrollOffset((value) => Math.max(0, value - visibleRows));
      return;
    }
    if (pageKey.home) {
      setScrollOffset(maxScroll);
      return;
    }
    if (pageKey.end) {
      setScrollOffset(0);
      return;
    }
    if (input === "c") {
      store.clear();
      setScrollOffset(0);
    }
  }, { isActive: interactive });
  useEffect(() => {
    setScrollOffset((value) => Math.min(value, Math.max(0, renderedLogLines.length - visibleRows)));
  }, [renderedLogLines.length, visibleRows]);
  const visibleLogLines = useMemo(() => {
    const end = Math.max(0, renderedLogLines.length - scrollOffset);
    return renderedLogLines.slice(Math.max(0, end - visibleRows), end);
  }, [renderedLogLines, scrollOffset, visibleRows]);
  const hiddenAbove = Math.max(0, renderedLogLines.length - visibleRows - scrollOffset);
  const hiddenBelow = Math.max(0, scrollOffset);
  return (
    <Box flexDirection="column">
      <Frame title={summary.title} subtitle="已启动  Ctrl+C 停止" borderColor={THEME.success}>
        <Section title="运行状态">
          <Text color={THEME.success} bold>▶ Chat Codex 已启动，正在等待微信 / 飞书消息。</Text>
        </Section>
        <Section title="服务">
          <KeyValue label="渠道" value={summary.channels.length ? summary.channels.join(", ") : "无"} />
          <KeyValue label="平台" value={formatCodexPlatform(summary.codexStatus)} />
          <KeyValue label="Codex CLI" value={formatRuntimeCodexStatus(summary.codexStatus)} />
          <KeyValue label="新聊天策略" value={summary.routePolicy} />
          <KeyValue label="默认权限" value={formatPolicy(summary.policy)} />
          <KeyValue label="工作目录" value={summary.cwd} />
        </Section>
        <Section title="日志">
          {hiddenAbove > 0 ? <Text color={THEME.muted}>  ↑ 还有 {hiddenAbove} 行</Text> : null}
          {visibleLogLines.length ? visibleLogLines.map((line) => (
            <Text key={line.key} color={line.color} wrap={line.wrap}>{line.text}</Text>
          )) : <Muted text="暂无消息。启动后在微信或飞书里发消息，日志会显示在这里。" />}
          {hiddenBelow > 0 ? <Text color={THEME.muted}>  ↓ 还有 {hiddenBelow} 行</Text> : null}
        </Section>
      </Frame>
      <Box marginTop={1} flexDirection="column">
        <Text color={THEME.muted}>等待微信 / 飞书消息。收到消息、回复、进度和媒体发送都会在这里追加。</Text>
        <Text color={THEME.muted}>↑↓/j/k 滚动  PgUp/PgDn 翻页  Home 最早  End 最新  c 清屏  Ctrl+C 停止服务</Text>
      </Box>
    </Box>
  );
}

function formatRuntimeCodexStatus(status?: CodexCliStatus): string {
  if (!status) return "尚未检测";
  const state = status.available ? "已找到" : "不可用";
  const version = status.available ? status.version ?? "版本未知" : status.error ?? "unknown error";
  return `${state}，${version}，${status.codexBin}，${formatCodexCommandSource(status.codexBinSource)}`;
}

function runtimeLogLines(entry: RuntimeLogEntry, width: number): RuntimeLogLine[] {
  const color = runtimeLogColor(entry.kind);
  const rawLines = (entry.message.trim() || "空消息").split(/\r?\n/);
  const bodyLines = rawLines.flatMap((line) => wrapRuntimeLogText(`  ${line}`, width));
  return [
    { key: `${entry.id}:header`, text: `${formatLocalClock(entry.time)}  ${kindLabel(entry.kind)}  ${entry.source}`, color },
    ...bodyLines.map((line, index) => ({ key: `${entry.id}:body:${index}`, text: line, wrap: "wrap" as const })),
    { key: `${entry.id}:spacer`, text: "" },
  ];
}

function runtimeLogColor(kind: RuntimeLogKind): string {
  if (kind === "error") return THEME.danger;
  if (kind === "inbound") return THEME.inbound;
  if (kind === "outbound") return THEME.outbound;
  if (kind === "progress") return THEME.progressLog;
  if (kind === "media") return THEME.media;
  if (kind === "warn") return THEME.warning;
  return THEME.muted;
}

function kindLabel(kind: RuntimeLogKind): string {
  if (kind === "system") return "系统";
  if (kind === "inbound") return "收到";
  if (kind === "outbound") return "发送";
  if (kind === "progress") return "进度";
  if (kind === "media") return "媒体";
  if (kind === "warn") return "警告";
  return "错误";
}

function formatPolicy(policy: CodexRunPolicy): string {
  if (policy.permissionMode === "full") return "完全权限";
  return `审批模式（${policy.sandbox ?? "workspace-write"} 沙箱）`;
}

function formatLogMessage(message: string, meta?: Record<string, unknown>): string {
  if (!meta) return message;
  return `${message} ${Object.entries(redact(meta)).map(([key, value]) => `${key}=${formatMetaValue(value)}`).join(" ")}`;
}

function redact(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = /token|cookie|secret|password|authorization/i.test(key) ? "[redacted]" : item;
  }
  return result;
}

function formatMetaValue(value: unknown): string {
  if (typeof value === "string") return value.includes(" ") ? JSON.stringify(value) : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return JSON.stringify(value);
}

function wrapRuntimeLogText(value: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  const maxWidth = Math.max(8, width);
  for (const char of Array.from(value)) {
    const nextWidth = runtimeCharWidth(char);
    if (current && currentWidth + nextWidth > maxWidth) {
      lines.push(current);
      current = "";
      currentWidth = 0;
    }
    current += char;
    currentWidth += nextWidth;
  }
  lines.push(current);
  return lines;
}

function runtimeCharWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (isCombining(code)) return 0;
  return isFullwidth(code) ? 2 : 1;
}

function isCombining(code: number): boolean {
  return (code >= 0x0300 && code <= 0x036f)
    || (code >= 0x1ab0 && code <= 0x1aff)
    || (code >= 0x1dc0 && code <= 0x1dff)
    || (code >= 0x20d0 && code <= 0x20ff)
    || (code >= 0xfe00 && code <= 0xfe0f);
}

function isFullwidth(code: number): boolean {
  return code >= 0x1100 && (
    code <= 0x115f
    || code === 0x2329
    || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f64f)
    || (code >= 0x1f900 && code <= 0x1f9ff)
  );
}
