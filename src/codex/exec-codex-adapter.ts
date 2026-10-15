import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  CodexAdapter,
  CodexAdapterCapabilities,
  CodexEvent,
  CodexProgressKind,
  CodexRunPolicyStatus,
  CodexSession,
  CodexSessionReloadResult,
  CodexSessionStatus,
  CodexSessionSummary,
  StartSessionInput,
  CodexPromptInput,
} from "./types.js";
import { buildCodexRootArgs, discoverCodexSessions, displayCodexSessionTitle, findCodexSessionById, type CodexRunPolicy } from "./codex-cli.js";
import { resolveCodexCommand, spawnCodex, type CodexCommandResolution } from "./codex-process.js";
import { codexInputPlainText } from "./input.js";

export interface ExecCodexAdapterOptions {
  codexBin?: string;
  codexCommand?: CodexCommandResolution;
  runPolicy?: CodexRunPolicy;
  codexHome?: string;
}

interface ExecSessionRecord {
  session: CodexSession;
  routeKey?: string;
  status: CodexSessionStatus;
  actualThreadId?: string;
  updatedAt: string;
}

interface RunningExecProcess {
  child: ChildProcess;
  cancelRequested: boolean;
}

export class ExecCodexAdapter implements CodexAdapter {
  private readonly codexCommand: CodexCommandResolution;
  private defaultRunPolicy: CodexRunPolicy;
  private readonly sessionRunPolicies = new Map<string, CodexRunPolicy>();
  private readonly codexHome?: string;
  private readonly sessions = new Map<string, ExecSessionRecord>();
  private readonly runningProcesses = new Map<string, RunningExecProcess>();
  private sessionSequence = 0;

  constructor(options: ExecCodexAdapterOptions = {}) {
    this.codexCommand = options.codexCommand ?? resolveCodexCommand({ codexBin: options.codexBin });
    this.defaultRunPolicy = cloneRunPolicy(options.runPolicy ?? { permissionMode: "approval", sandbox: "workspace-write" });
    this.codexHome = options.codexHome;
  }

  async startSession(input: StartSessionInput): Promise<CodexSession> {
    const session: CodexSession = {
      id: `exec-local-${Date.now()}-${++this.sessionSequence}`,
      cwd: input.cwd,
      title: input.title,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, {
      session,
      routeKey: input.routeKey,
      status: { type: "idle" },
      updatedAt: session.createdAt,
    });
    this.sessionRunPolicies.set(session.id, cloneRunPolicy(this.defaultRunPolicy));
    return session;
  }

  getCapabilities(): CodexAdapterCapabilities {
    return { mode: "exec", interactiveApprovals: false, userInput: false, goals: false, steering: false, modelList: false, messagePhases: false, asyncQuestions: false };
  }

  async resumeSession(sessionId: string): Promise<CodexSession> {
    return this.loadSession(sessionId, false);
  }

  async reloadSession(sessionId: string): Promise<CodexSessionReloadResult> {
    const session = await this.loadSession(sessionId, true);
    return { session, reloadedAt: new Date().toISOString() };
  }

  private async loadSession(sessionId: string, forceReload: boolean): Promise<CodexSession> {
    const stored = this.sessions.get(sessionId);
    if (stored && !forceReload) return stored.session;
    const now = new Date().toISOString();
    const discovered = findCodexSessionById(sessionId, { codexHome: this.codexHome });
    const session: CodexSession = {
      id: sessionId,
      cwd: discovered?.cwd ?? stored?.session.cwd ?? process.cwd(),
      title: discovered ? displayCodexSessionTitle(discovered) ?? stored?.session.title ?? `codex:${sessionId}` : stored?.session.title ?? `codex:${sessionId}`,
      createdAt: stored?.session.createdAt ?? discovered?.updatedAt ?? now,
    };
    this.sessions.set(session.id, {
      session,
      routeKey: stored?.routeKey,
      status: stored?.status.type === "running" || stored?.status.type === "waiting_approval" ? stored.status : { type: "idle" },
      actualThreadId: stored?.actualThreadId ?? sessionId,
      updatedAt: now,
    });
    if (!this.sessionRunPolicies.has(session.id)) {
      this.sessionRunPolicies.set(session.id, cloneRunPolicy(this.defaultRunPolicy));
    }
    return session;
  }

  async *run(sessionId: string, prompt: CodexPromptInput): AsyncIterable<CodexEvent> {
    const stored = this.sessions.get(sessionId);
    if (!stored) throw new Error(`exec session not found locally: ${sessionId}`);
    const session = stored.session;
    const promptText = codexInputPlainText(prompt);
    const turnId = `exec-turn-${Date.now()}`;
    const startedAt = new Date().toISOString();
    stored.status = { type: "running", turnId, task: truncatePrompt(promptText), startedAt };
    stored.updatedAt = new Date().toISOString();
    yield { type: "turn.started", sessionId, turnId, startedAt };

    const args = this.buildArgs(stored, promptText);
    const child = spawnCodex(this.codexCommand, args, {
      cwd: session.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.stdout || !child.stderr) {
      throw new Error("codex exec stdio is unavailable");
    }
    const running: RunningExecProcess = { child, cancelRequested: false };
    this.runningProcesses.set(sessionId, running);
    let processError: Error | undefined;
    const closePromise = new Promise<number | null>((resolve) => {
      child.on("error", (error) => { processError = error; });
      child.on("close", resolve);
    });
    let failed = false;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const lines = createInterface({ input: child.stdout });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const parsed = parseExecJsonLine(line, sessionId, turnId);
        if (parsed?.threadId) {
          stored.actualThreadId = parsed.threadId;
          stored.updatedAt = new Date().toISOString();
        }
        const event = parsed?.event;
        if (!event || failed) continue;
        if (event.type === "turn.failed") {
          failed = true;
          stored.status = { type: "failed", error: event.error };
        }
        yield event;
      }
    } catch (error) {
      if (!running.cancelRequested) throw error;
    }

    const code = await closePromise;
    this.runningProcesses.delete(sessionId);
    if (failed) return;
    if (running.cancelRequested) {
      stored.status = { type: "interrupted" };
      stored.updatedAt = new Date().toISOString();
      yield { type: "turn.interrupted", sessionId, turnId };
      return;
    }
    if (code === 0 && !processError) {
      stored.status = { type: "idle" };
      stored.updatedAt = new Date().toISOString();
      yield { type: "turn.completed", sessionId, turnId };
    } else {
      const error = processError?.message ?? (stderr || `codex exec exited with code ${code}`);
      stored.status = { type: "failed", error };
      stored.updatedAt = new Date().toISOString();
      yield { type: "turn.failed", sessionId, turnId, error };
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const running = this.runningProcesses.get(sessionId);
    const stored = this.sessions.get(sessionId);
    if (stored) {
      stored.status = { type: "interrupted" };
      stored.updatedAt = new Date().toISOString();
    }
    if (!running) return;
    running.cancelRequested = true;
    if (!running.child.kill("SIGTERM")) {
      running.child.kill("SIGKILL");
      return;
    }
    const timer = setTimeout(() => {
      if (this.runningProcesses.get(sessionId) === running) {
        running.child.kill("SIGKILL");
      }
    }, 2000);
    timer.unref?.();
  }

  async getStatus(sessionId: string): Promise<CodexSessionStatus> {
    return this.sessions.get(sessionId)?.status ?? { type: "unknown", detail: "session not found" };
  }

  async listSessions(routeKey?: string): Promise<CodexSessionSummary[]> {
    const localSessions = [...this.sessions.values()].filter((record) => (routeKey ? record.routeKey === routeKey : true)).map((record) => ({
      id: record.session.id,
      routeKey: record.routeKey,
      title: record.session.title,
      cwd: record.session.cwd,
      status: record.status,
      updatedAt: record.updatedAt,
    }));
    if (routeKey) return localSessions;

    const seen = new Set(localSessions.map((session) => session.id));
    const discoveredSessions = discoverCodexSessions({ codexHome: this.codexHome })
      .filter((session) => !seen.has(session.id))
      .map((session) => ({
        id: session.id,
        title: displayCodexSessionTitle(session),
        cwd: session.cwd,
        status: { type: "unknown" as const, detail: "history" },
        updatedAt: session.updatedAt ?? "",
      }));
    return [...localSessions, ...discoveredSessions];
  }

  getRunPolicy(sessionId?: string): CodexRunPolicy {
    return cloneRunPolicy(this.runPolicyForSession(sessionId));
  }

  setRunPolicy(policy: CodexRunPolicy, sessionId?: string): void {
    if (sessionId) {
      this.sessionRunPolicies.set(sessionId, cloneRunPolicy(policy));
      return;
    }
    this.defaultRunPolicy = cloneRunPolicy(policy);
  }

  getRunPolicyStatus(sessionId?: string): CodexRunPolicyStatus {
    const policy = this.getRunPolicy(sessionId);
    return {
      policy,
      interactiveApprovals: false,
      effectiveApprovalPolicy: "never",
      effectiveApprovalsReviewer: null,
      effectiveSandbox: policy.permissionMode === "full" ? "danger-full-access" : policy.sandbox ?? "workspace-write",
      supportedPermissionModes: ["approval", "full"],
      note: "codex exec 是非交互模式，不会把审批请求回调给微信；approval 只恢复 workspace-write sandbox。",
    };
  }

  private buildArgs(stored: ExecSessionRecord, prompt: string): string[] {
    const rootArgs = buildCodexRootArgs(this.runPolicyForSession(stored.session.id));
    if (stored.actualThreadId) {
      return [...rootArgs, "exec", "resume", "--json", "--skip-git-repo-check", "--all", stored.actualThreadId, prompt];
    }
    return [...rootArgs, "exec", "--json", "--cd", stored.session.cwd, "--skip-git-repo-check", prompt];
  }

  private runPolicyForSession(sessionId?: string): CodexRunPolicy {
    return (sessionId ? this.sessionRunPolicies.get(sessionId) : undefined) ?? this.defaultRunPolicy;
  }
}

function cloneRunPolicy(policy: CodexRunPolicy): CodexRunPolicy {
  return { ...policy };
}

export interface ParsedExecJsonLine {
  threadId?: string;
  event?: CodexEvent;
}

export function parseExecJsonLine(line: string, sessionId: string, turnId: string): ParsedExecJsonLine | undefined {
  try {
    const parsed = JSON.parse(line) as {
      type?: string;
      thread_id?: string;
      text?: string;
      summary?: string;
      summary_text?: string;
      item?: {
        type?: string;
        item_type?: string;
        text?: string;
        summary_text?: string;
        summary?: Array<{ text?: string } | string>;
        plan?: Array<{ text?: string; step?: string; status?: string } | string>;
        command?: string;
        aggregated_output?: string;
        status?: string;
        exit_code?: number;
        changes?: Array<{ path?: string; kind?: string }>;
        items?: Array<{ text?: string; completed?: boolean }>;
        server?: string;
        tool?: string;
        query?: string;
      };
      error?: { message?: string };
      message?: string;
    };
    if (parsed.type === "thread.started" && parsed.thread_id) {
      return { threadId: parsed.thread_id };
    }
    if ((parsed.type === "codex_thinking" || parsed.type === "reasoning") && (parsed.text || parsed.summary || parsed.summary_text)) {
      return {
        event: {
          type: "assistant.progress",
          sessionId,
          turnId,
          text: parsed.text ?? parsed.summary ?? parsed.summary_text ?? "",
          kind: "reasoning",
        },
      };
    }
    const itemType = parsed.item?.type ?? parsed.item?.item_type;
    if (parsed.type === "item.completed" && (itemType === "agent_message" || itemType === "assistant_message") && parsed.item?.text) {
      return { event: { type: "assistant.completed", sessionId, turnId, text: parsed.item.text } };
    }
    if ((parsed.type === "item.started" || parsed.type === "item.updated" || parsed.type === "item.completed") && parsed.item) {
      const progress = progressFromExecItem(parsed.type, parsed.item);
      if (progress) {
        return { event: { type: "assistant.progress", sessionId, turnId, text: progress.text, kind: progress.kind } };
      }
    }
    if (parsed.type === "turn.failed") {
      return { event: { type: "turn.failed", sessionId, turnId, error: parsed.error?.message ?? "codex turn failed" } };
    }
    if (parsed.type === "error") {
      return { event: { type: "turn.failed", sessionId, turnId, error: parsed.message ?? "codex exec error" } };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function progressFromExecItem(eventType: string, item: {
  type?: string;
  item_type?: string;
  text?: string;
  summary_text?: string;
  summary?: Array<{ text?: string } | string>;
  plan?: Array<{ text?: string; step?: string; status?: string } | string>;
  command?: string;
  aggregated_output?: string;
  status?: string;
  exit_code?: number;
  changes?: Array<{ path?: string; kind?: string }>;
  items?: Array<{ text?: string; completed?: boolean }>;
  server?: string;
  tool?: string;
  query?: string;
}): { text: string; kind: CodexProgressKind } | undefined {
  const itemType = item.type ?? item.item_type;
  if ((itemType === "reasoning" || itemType === "codex_thinking" || itemType === "thinking") && eventType === "item.completed") {
    const text = item.text ?? item.summary_text ?? textFromSummary(item.summary);
    return text ? { text, kind: "reasoning" } : undefined;
  }
  if (itemType === "command_execution" && eventType === "item.started" && item.command) {
    return { text: `正在执行命令: ${item.command}`, kind: "command" };
  }
  if (itemType === "command_execution" && eventType === "item.completed" && item.command) {
    const status = item.status === "failed" || item.exit_code ? "失败" : "完成";
    const output = imageOutputHint(item.aggregated_output);
    const text = output ? `命令${status}: ${item.command}\n输出:\n${output}` : `命令${status}: ${item.command}`;
    return { text, kind: "command" };
  }
  if (itemType === "file_change" && eventType === "item.completed" && item.changes?.length) {
    const paths = item.changes.map((change) => change.path).filter(Boolean).slice(0, 5).join(", ");
    return paths ? { text: `文件变更完成: ${paths}`, kind: "file_change" } : undefined;
  }
  if (itemType === "mcp_tool_call" && eventType === "item.started") {
    return { text: `正在调用工具: ${[item.server, item.tool].filter(Boolean).join("/")}`, kind: "tool" };
  }
  if (itemType === "web_search" && eventType === "item.started" && item.query) {
    return { text: `正在搜索: ${item.query}`, kind: "search" };
  }
  if ((itemType === "todo_list" || itemType === "plan_update") && item.items?.length) {
    const active = item.items.find((todo) => !todo.completed)?.text ?? item.items.at(-1)?.text;
    return active ? { text: `计划更新: ${active}`, kind: "todo" } : undefined;
  }
  if (itemType === "plan_update" && item.plan?.length) {
    const active = item.plan
      .map((entry) => typeof entry === "string" ? entry : entry.text ?? entry.step)
      .filter(Boolean)
      .at(-1);
    return active ? { text: `计划更新: ${active}`, kind: "todo" } : undefined;
  }
  if (itemType === "plan_update" && item.text) {
    return { text: `计划更新: ${item.text}`, kind: "todo" };
  }
  return undefined;
}

function textFromSummary(summary: Array<{ text?: string } | string> | undefined): string | undefined {
  const text = summary
    ?.map((entry) => typeof entry === "string" ? entry : entry.text)
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || undefined;
}

function imageOutputHint(output: string | undefined, maxLength = 600): string | undefined {
  const text = output?.trim();
  if (!text || !/\.(?:png|jpe?g|gif|webp|bmp|tiff?|svg)\b/i.test(text)) return undefined;
  if (text.length <= maxLength) return text;
  return text.slice(-maxLength);
}

function truncatePrompt(prompt: string, maxLength = 120): string {
  const normalized = prompt.trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}
