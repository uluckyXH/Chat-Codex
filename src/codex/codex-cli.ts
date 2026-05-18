import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatCodexUnavailableError,
  resolveCodexCommand,
  spawnCodex,
  type CodexBinSource,
  type CodexCommandResolution,
} from "./codex-process.js";

export type CodexPermissionMode = "approval" | "full";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexRunPolicy {
  permissionMode: CodexPermissionMode;
  sandbox?: CodexSandboxMode;
}

export interface CodexRunPolicyStatus {
  policy: CodexRunPolicy;
  interactiveApprovals: boolean;
  effectiveApprovalPolicy?: "never" | "on-request";
  note?: string;
}

export interface CodexCliStatus {
  available: boolean;
  codexBin: string;
  requestedCodexBin: string;
  codexBinSource: CodexBinSource;
  platform: string;
  arch: string;
  command: CodexCommandResolution;
  version?: string;
  error?: string;
}

export interface DiscoveredCodexSession {
  id: string;
  threadName?: string;
  preview?: string;
  cwd?: string;
  updatedAt?: string;
  path?: string;
}

export interface DiscoverCodexSessionsOptions {
  codexHome?: string;
  limit?: number;
}

export const CODEX_SESSION_TITLE_DISPLAY_MAX_LENGTH = 60;

export function buildCodexRootArgs(policy: CodexRunPolicy): string[] {
  if (policy.permissionMode === "full") {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }
  return [
    "--sandbox",
    policy.sandbox ?? "workspace-write",
  ];
}

export async function checkCodexCli(codexBin?: string, timeoutMs = 5000): Promise<CodexCliStatus> {
  const command = resolveCodexCommand({ codexBin });
  return new Promise((resolve) => {
    const child = spawnCodex(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const baseStatus = {
      codexBin: command.command,
      requestedCodexBin: command.requested,
      codexBinSource: command.source,
      platform: command.platform,
      arch: command.arch,
      command,
    };
    if (!child.stdout || !child.stderr) {
      resolve({
        available: false,
        ...baseStatus,
        error: formatCodexUnavailableError(command, "codex --version stdio is unavailable"),
      });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        available: false,
        ...baseStatus,
        error: formatCodexUnavailableError(command, `codex --version timed out after ${timeoutMs}ms`),
      });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ available: false, ...baseStatus, error: formatCodexUnavailableError(command, error.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ available: true, ...baseStatus, version: stdout.trim() || stderr.trim() });
      } else {
        resolve({
          available: false,
          ...baseStatus,
          error: formatCodexUnavailableError(command, stderr.trim() || stdout.trim() || `exit ${code}`),
        });
      }
    });
  });
}

export function discoverCodexSessions(options: DiscoverCodexSessionsOptions = {}): DiscoveredCodexSession[] {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const byId = new Map<string, DiscoveredCodexSession>();
  for (const session of readSessionIndex(path.join(codexHome, "session_index.jsonl"))) {
    mergeSession(byId, session);
  }
  for (const session of readSessionFiles(path.join(codexHome, "sessions"))) {
    mergeSession(byId, session);
  }
  for (const session of readStateDbSessions(path.join(codexHome, "state_5.sqlite"))) {
    mergeSession(byId, session);
  }
  return [...byId.values()]
    .sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""))
    .slice(0, options.limit);
}

export function displayCodexSessionTitle(session: DiscoveredCodexSession): string | undefined {
  return session.threadName ?? session.preview;
}

export function formatCodexSessionTitleForDisplay(
  session: DiscoveredCodexSession,
  maxLength = CODEX_SESSION_TITLE_DISPLAY_MAX_LENGTH,
): string | undefined {
  const title = displayCodexSessionTitle(session);
  return title ? truncateDisplayText(title, maxLength) : undefined;
}

export function truncateDisplayText(text: string, maxLength = CODEX_SESSION_TITLE_DISPLAY_MAX_LENGTH): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(normalized);
  if (chars.length <= maxLength) return normalized;
  if (maxLength <= 3) return chars.slice(0, maxLength).join("");
  return `${chars.slice(0, maxLength - 3).join("")}...`;
}

export function findCodexSessionById(
  sessionId: string,
  options: Omit<DiscoverCodexSessionsOptions, "limit"> = {},
): DiscoveredCodexSession | undefined {
  return discoverCodexSessions(options).find((session) => session.id === sessionId);
}

export function parseSessionIndexLine(line: string): DiscoveredCodexSession | undefined {
  try {
    const parsed = JSON.parse(line) as { id?: string; thread_name?: string; updated_at?: string };
    if (!parsed.id) return undefined;
    return {
      id: parsed.id,
      threadName: parsed.thread_name,
      updatedAt: parsed.updated_at,
    };
  } catch {
    return undefined;
  }
}

function readSessionIndex(filePath: string): DiscoveredCodexSession[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, "utf-8")
      .split(/\r?\n/)
      .map(parseSessionIndexLine)
      .filter((session): session is DiscoveredCodexSession => Boolean(session));
  } catch {
    return [];
  }
}

function readStateDbSessions(filePath: string): DiscoveredCodexSession[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const result = spawnSync("sqlite3", [
      "-readonly",
      "-json",
      filePath,
      [
        "SELECT id, title, preview, first_user_message, cwd, rollout_path, updated_at_ms, updated_at",
        "FROM threads",
        "WHERE archived = 0",
        "ORDER BY updated_at DESC",
      ].join(" "),
    ], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0 || !result.stdout.trim()) return [];
    const rows = JSON.parse(result.stdout) as Array<{
      id?: string;
      title?: string;
      preview?: string;
      first_user_message?: string;
      cwd?: string;
      rollout_path?: string;
      updated_at_ms?: number;
      updated_at?: number;
    }>;
    return rows
      .filter((row) => typeof row.id === "string" && row.id.length > 0)
      .map((row) => {
        const title = cleanText(row.title);
        const preview = cleanText(row.preview);
        const firstUserMessage = cleanText(row.first_user_message);
        const distinctTitle = title && title !== (firstUserMessage ?? preview) ? title : undefined;
        return {
          id: row.id as string,
          threadName: distinctTitle,
          preview: firstUserMessage ?? preview ?? title,
          cwd: cleanText(row.cwd),
          path: cleanText(row.rollout_path),
          updatedAt: sqliteTimeToIso(row.updated_at_ms, row.updated_at),
        };
      });
  } catch {
    return [];
  }
}

function readSessionFiles(rootDir: string): DiscoveredCodexSession[] {
  const files = listJsonlFiles(rootDir);
  const sessions: DiscoveredCodexSession[] = [];
  for (const filePath of files) {
    const session = readSessionMeta(filePath);
    if (session) sessions.push(session);
  }
  return sessions;
}

function mergeSession(byId: Map<string, DiscoveredCodexSession>, incoming: DiscoveredCodexSession): void {
  const existing = byId.get(incoming.id);
  byId.set(incoming.id, {
    id: incoming.id,
    threadName: incoming.threadName ?? existing?.threadName,
    preview: incoming.preview ?? existing?.preview,
    cwd: incoming.cwd ?? existing?.cwd,
    updatedAt: latestIso(existing?.updatedAt, incoming.updatedAt),
    path: incoming.path ?? existing?.path,
  });
}

function latestIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) >= Date.parse(a) ? b : a;
}

function sqliteTimeToIso(updatedAtMs?: number, updatedAt?: number): string | undefined {
  const ms = typeof updatedAtMs === "number" && updatedAtMs > 0
    ? updatedAtMs
    : typeof updatedAt === "number" && updatedAt > 0
      ? updatedAt * 1000
      : undefined;
  return ms ? new Date(ms).toISOString() : undefined;
}

function cleanText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSessionMeta(filePath: string): DiscoveredCodexSession | undefined {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const firstLine = buffer.subarray(0, bytes).toString("utf-8").split(/\r?\n/, 1)[0];
      const parsed = JSON.parse(firstLine) as {
        type?: string;
        timestamp?: string;
        payload?: { id?: string; cwd?: string; timestamp?: string };
      };
      if (parsed.type !== "session_meta" || !parsed.payload?.id) return undefined;
      return {
        id: parsed.payload.id,
        cwd: parsed.payload.cwd,
        updatedAt: parsed.timestamp ?? parsed.payload.timestamp,
        path: filePath,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function listJsonlFiles(rootDir: string): string[] {
  const results: string[] = [];
  try {
    if (!fs.existsSync(rootDir)) return [];
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        results.push(...listJsonlFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(fullPath);
      }
    }
  } catch {
    return results;
  }
  return results;
}
