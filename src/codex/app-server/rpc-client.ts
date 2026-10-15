import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { chatCodexVersion } from "../../runtime/package-info.js";
import { protocolStatus, type CodexProtocolStatus } from "./compatibility.js";
import type { Interface as ReadlineInterface } from "node:readline";
import { resolveCodexCommand, spawnCodex, type CodexCommandResolution } from "../codex-process.js";
import type {
  CodexTransportDiagnostic,
  CodexTransportFailureKind,
  CodexTransportRequestDiagnostic,
} from "../transport-diagnostic.js";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, PendingResponse } from "./types.js";

export interface AppServerRpcClientOptions {
  codexBin: string | CodexCommandResolution;
  requestTimeoutMs: number;
  onServerRequest: (request: JsonRpcRequest) => Promise<void> | void;
  onNotification: (notification: JsonRpcNotification) => void;
  onFatalError: (error: Error, diagnostic: CodexTransportDiagnostic) => void;
}

const MAX_STDERR_TAIL_CHARS = 8_192;
const MAX_RECENT_REQUESTS = 8;

export class AppServerRpcClient {
  private readonly codexCommand: CodexCommandResolution;
  private readonly requestTimeoutMs: number;
  private readonly onServerRequest: (request: JsonRpcRequest) => Promise<void> | void;
  private readonly onNotification: (notification: JsonRpcNotification) => void;
  private readonly onFatalError: (error: Error, diagnostic: CodexTransportDiagnostic) => void;
  private readonly pendingResponses = new Map<string, PendingResponse>();
  private readonly pendingRequestMethods = new Map<string, string>();
  private readonly recentRequests: CodexTransportRequestDiagnostic[] = [];
  private readonly stderrTails = new Map<number, string>();
  private requestSequence = 0;
  private child?: ChildProcess;
  private stdoutLines?: ReadlineInterface;
  private initialized?: Promise<void>;
  private stopping = false;
  private processGeneration = 0;
  private fatalGeneration?: number;
  private lastTransportDiagnostic?: CodexTransportDiagnostic;
  private handshakeComplete = false;
  private serverUserAgent?: string;

  constructor(options: AppServerRpcClientOptions) {
    this.codexCommand = typeof options.codexBin === "string" ? resolveCodexCommand({ codexBin: options.codexBin }) : options.codexBin;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.onServerRequest = options.onServerRequest;
    this.onNotification = options.onNotification;
    this.onFatalError = options.onFatalError;
  }

  start(): Promise<void> {
    this.initialized ??= this.startProcessAndInitialize();
    return this.initialized;
  }

  getLastTransportDiagnostic(): CodexTransportDiagnostic | undefined {
    return this.lastTransportDiagnostic;
  }

  getProtocolStatus(): CodexProtocolStatus {
    return protocolStatus(this.serverUserAgent, this.handshakeComplete && Boolean(this.child));
  }

  serverRequestKey(id: string | number): string {
    return `rpc-${this.processGeneration}:${id}`;
  }

  stop(): void {
    this.handshakeComplete = false;
    this.stopping = true;
    this.processGeneration += 1;
    this.fatalGeneration = undefined;
    this.rejectPendingResponses(new Error("codex app-server stopped"));
    const stdoutLines = this.stdoutLines;
    const child = this.child;
    this.stdoutLines = undefined;
    this.child = undefined;
    this.initialized = undefined;
    this.stderrTails.clear();
    try {
      stdoutLines?.close();
    } catch {
      // The reader may already be closed while the child exits.
    }
    if (child && !child.killed) child.kill("SIGTERM");
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number; onResult?: (value: unknown) => void } = {},
  ): Promise<T> {
    await this.ensureChildOpen();
    const id = `ccbridge-${++this.requestSequence}`;
    const message: JsonRpcRequest = { id, method, ...(params !== undefined ? { params } : {}) };
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<T>((resolve, reject) => {
      this.pendingResponses.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          try {
            options.onResult?.(value);
            resolve(value as T);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
      this.pendingRequestMethods.set(id, method);
      this.rememberRequest({ id, method });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pendingResponses.delete(id);
          this.pendingRequestMethods.delete(id);
          reject(new Error(`codex app-server request timed out: ${method}`));
        }, timeoutMs);
        timer.unref?.();
      }
    });
    try {
      this.writeMessage(message);
    } catch (error) {
      if (timer) clearTimeout(timer);
      this.pendingResponses.delete(id);
      this.pendingRequestMethods.delete(id);
      throw error;
    }
    return promise;
  }

  writeMessage(message: unknown): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error("codex app-server stdin is closed");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async startProcessAndInitialize(): Promise<void> {
    this.handshakeComplete = false;
    this.serverUserAgent = undefined;
    this.stopping = false;
    const generation = ++this.processGeneration;
    this.fatalGeneration = undefined;
    this.recentRequests.length = 0;
    this.stderrTails.clear();
    this.stderrTails.set(generation, "");
    const child = spawnCodex(this.codexCommand, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.appendStderrTail(generation, chunk);
    });
    child.on("error", (error) => this.failTransport(error, generation, { kind: "process_error" }));
    child.on("close", (code, signal) => {
      this.handleProcessExit(generation, code, signal);
    });
    const stdout = child.stdout;
    const stdin = child.stdin;
    if (!stdout || !stdin) {
      const error = new Error("failed to start codex app-server stdio");
      this.failTransport(error, generation, { kind: "process_error" });
      throw error;
    }
    stdin.on("error", (error) => this.failTransport(error, generation, { kind: "process_error" }));
    const stdoutLines = createInterface({ input: stdout });
    this.stdoutLines = stdoutLines;
    void this.readLoop(generation, stdoutLines);
    const response = await this.request<{ userAgent?: string }>("initialize", {
      clientInfo: {
        name: "codex-chat-bridge",
        title: "Codex Chat Bridge",
        version: chatCodexVersion(),
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [
          "command/exec/outputDelta",
          "item/reasoning/textDelta",
        ],
      },
    });
    this.writeMessage({ method: "initialized" });
    this.serverUserAgent = typeof response.userAgent === "string" ? response.userAgent : undefined;
    this.handshakeComplete = true;
  }

  private handleProcessExit(generation: number, code: number | null, signal: NodeJS.Signals | null): void {
    const stderr = this.stderrTail(generation).trim();
    const error = new Error(stderr || formatProcessExitError(code, signal));
    this.failTransport(error, generation, {
      kind: "process_exit",
      exitCode: code,
      signal,
    });
  }

  private async ensureChildOpen(): Promise<void> {
    if (!this.child?.stdin || this.child.killed) {
      throw new Error("codex app-server is not running");
    }
  }

  private async readLoop(generation: number, stdoutLines: ReadlineInterface): Promise<void> {
    try {
      for await (const line of stdoutLines) {
        if (!this.isCurrentGeneration(generation)) return;
        const trimmed = line.trim();
        if (!trimmed) continue;
        let message: JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;
        try {
          message = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;
        } catch (error) {
          this.failTransport(error instanceof Error ? error : new Error(String(error)), generation, {
            kind: "invalid_json",
            stdoutLineLength: trimmed.length,
          });
          return;
        }
        void this.handleMessage(message, generation);
      }
      if (!this.stopping) {
        this.failTransport(new Error("codex app-server stdout closed"), generation, { kind: "stdout_closed" });
      }
    } catch (error) {
      if (this.stopping || generation !== this.processGeneration) return;
      this.failTransport(error instanceof Error ? error : new Error(String(error)), generation, { kind: "stdout_closed" });
    }
  }

  private async handleMessage(
    message: JsonRpcResponse | JsonRpcRequest | JsonRpcNotification,
    generation: number,
  ): Promise<void> {
    if (!this.isCurrentGeneration(generation)) return;
    if ("id" in message && "method" in message) {
      await this.onServerRequest(message);
      return;
    }
    if ("id" in message) {
      const pending = this.pendingResponses.get(String(message.id));
      if (!pending) return;
      this.pendingResponses.delete(String(message.id));
      this.pendingRequestMethods.delete(String(message.id));
      if ("error" in message && message.error) {
        pending.reject(new Error(message.error.message ?? `JSON-RPC error ${message.error.code ?? ""}`.trim()));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if ("method" in message) {
      this.onNotification(message);
    }
  }

  private failTransport(
    error: Error,
    generation: number,
    details: {
      kind: CodexTransportFailureKind;
      stdoutLineLength?: number;
      exitCode?: number | null;
      signal?: string | null;
    },
  ): void {
    if (!this.isCurrentGeneration(generation)) return;
    this.fatalGeneration = generation;
    const child = this.child;
    const stdoutLines = this.stdoutLines;
    const diagnostic = this.transportDiagnostic(error, generation, details, child);
    this.lastTransportDiagnostic = diagnostic;
    this.child = undefined;
    this.stdoutLines = undefined;
    this.initialized = undefined;
    this.rejectPendingResponses(error);
    this.stderrTails.delete(generation);
    try {
      stdoutLines?.close();
    } catch {
      // The reader may already be closed while the child exits.
    }
    this.onFatalError(error, diagnostic);
    if (child && !child.killed) child.kill("SIGTERM");
  }

  private rejectPendingResponses(error: Error): void {
    for (const pending of this.pendingResponses.values()) pending.reject(error);
    this.pendingResponses.clear();
    this.pendingRequestMethods.clear();
  }

  private rememberRequest(request: CodexTransportRequestDiagnostic): void {
    this.recentRequests.push(request);
    if (this.recentRequests.length > MAX_RECENT_REQUESTS) this.recentRequests.splice(0, this.recentRequests.length - MAX_RECENT_REQUESTS);
  }

  private appendStderrTail(generation: number, chunk: string): void {
    if (!this.isCurrentGeneration(generation)) return;
    const current = this.stderrTails.get(generation) ?? "";
    this.stderrTails.set(generation, appendTail(current, chunk, MAX_STDERR_TAIL_CHARS));
  }

  private stderrTail(generation: number): string {
    return this.stderrTails.get(generation) ?? "";
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.processGeneration && !this.stopping && this.fatalGeneration !== generation;
  }

  private transportDiagnostic(
    error: Error,
    generation: number,
    details: {
      kind: CodexTransportFailureKind;
      stdoutLineLength?: number;
      exitCode?: number | null;
      signal?: string | null;
    },
    child: ChildProcess | undefined,
  ): CodexTransportDiagnostic {
    const stderrTail = this.stderrTail(generation).trim();
    return {
      source: "app-server",
      kind: details.kind,
      error: error.message,
      observedAt: new Date().toISOString(),
      ...(child?.pid ? { processId: child.pid } : {}),
      ...(details.stdoutLineLength !== undefined ? { stdoutLineLength: details.stdoutLineLength } : {}),
      ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
      ...(details.signal !== undefined ? { signal: details.signal } : {}),
      pendingRequests: [...this.pendingRequestMethods.entries()].map(([id, method]) => ({ id, method })),
      recentRequests: [...this.recentRequests],
      ...(stderrTail ? { stderrTail } : {}),
    };
  }
}

function appendTail(current: string, chunk: string, maxChars: number): string {
  const next = current + chunk;
  return next.length > maxChars ? next.slice(-maxChars) : next;
}

function formatProcessExitError(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `codex app-server exited from signal ${signal}`;
  return `codex app-server exited with code ${code ?? "unknown"}`;
}
