import type { ChildProcess } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";
import WebSocket from "ws";
import { resolveCodexCommand, spawnCodex, type CodexCommandResolution } from "../codex-process.js";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, PendingResponse } from "./types.js";

export interface AppServerRpcClientOptions {
  codexBin: string | CodexCommandResolution;
  requestTimeoutMs: number;
  onServerRequest: (request: JsonRpcRequest) => Promise<void> | void;
  onNotification: (notification: JsonRpcNotification) => void;
  onFatalError: (error: Error) => void;
  appServerEndpoint?: string;
}

export class AppServerRpcClient {
  private readonly codexCommand: CodexCommandResolution;
  private readonly requestTimeoutMs: number;
  private readonly onServerRequest: (request: JsonRpcRequest) => Promise<void> | void;
  private readonly onNotification: (notification: JsonRpcNotification) => void;
  private readonly onFatalError: (error: Error) => void;
  private readonly appServerEndpoint?: string;
  private readonly pendingResponses = new Map<string, PendingResponse>();
  private requestSequence = 0;
  private child?: ChildProcess;
  private webSocket?: WebSocket;
  private stdoutLines?: ReadlineInterface;
  private stderr = "";
  private initialized?: Promise<void>;
  private stopping = false;
  private processGeneration = 0;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(options: AppServerRpcClientOptions) {
    this.codexCommand = typeof options.codexBin === "string" ? resolveCodexCommand({ codexBin: options.codexBin }) : options.codexBin;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.onServerRequest = options.onServerRequest;
    this.onNotification = options.onNotification;
    this.onFatalError = options.onFatalError;
    this.appServerEndpoint = options.appServerEndpoint ?? sharedAppServerEndpointFromEnvironment();
  }

  start(): Promise<void> {
    this.initialized ??= this.startProcessAndInitialize()
      .then(() => {
        this.reconnectAttempt = 0;
      })
      .catch((error) => {
        this.initialized = undefined;
        this.webSocket = undefined;
        this.scheduleSharedReconnect();
        throw error;
      });
    return this.initialized;
  }

  stop(): void {
    this.stopping = true;
    this.processGeneration += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    for (const pending of this.pendingResponses.values()) {
      pending.reject(new Error("codex app-server stopped"));
    }
    this.pendingResponses.clear();
    this.stdoutLines?.close();
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
    if (this.webSocket) {
      try {
        this.webSocket.terminate();
      } catch {
        // Best effort while shutting down.
      }
    }
    this.child = undefined;
    this.webSocket = undefined;
    this.initialized = undefined;
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
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pendingResponses.delete(id);
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
      throw error;
    }
    return promise;
  }

  writeMessage(message: unknown): void {
    if (this.webSocket?.readyState === WebSocket.OPEN) {
      this.webSocket.send(JSON.stringify(message));
      return;
    }
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error("codex app-server stdin is closed");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async startProcessAndInitialize(): Promise<void> {
    this.stopping = false;
    const generation = ++this.processGeneration;
    this.stderr = "";
    if (this.appServerEndpoint) {
      await this.connectToSharedAppServer(this.appServerEndpoint, generation);
    } else {
      this.child = spawnCodex(this.codexCommand, ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child.stderr?.setEncoding("utf8");
      this.child.stderr?.on("data", (chunk: string) => {
        this.stderr += chunk;
      });
      this.child.on("error", (error) => this.handleProcessEnd(error, generation));
      this.child.on("close", (code) => {
        this.handleProcessEnd(new Error(this.stderr.trim() || `codex app-server exited with code ${code}`), generation);
      });
      if (!this.child.stdout || !this.child.stdin) throw new Error("failed to start codex app-server stdio");
      this.stdoutLines = createInterface({ input: this.child.stdout });
      void this.readLoop();
    }
    await this.request("initialize", {
      clientInfo: {
        name: "codex-chat-bridge",
        title: "Codex Chat Bridge",
        version: "0.1.0",
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
  }

  private async connectToSharedAppServer(endpoint: string, generation: number): Promise<void> {
    const socketPath = unixSocketPath(endpoint);
    await new Promise<void>((resolve, reject) => {
      let opened = false;
      let ended = false;
      const webSocket = new WebSocket("ws://localhost/rpc", {
        perMessageDeflate: false,
        createConnection: () => net.createConnection({ path: socketPath }),
      });
      this.webSocket = webSocket;
      const endOnce = (error: Error) => {
        if (ended) return;
        ended = true;
        if (!opened) {
          reject(error);
          return;
        }
        this.handleProcessEnd(error, generation);
      };
      webSocket.once("open", () => {
        opened = true;
        resolve();
      });
      webSocket.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString()) as JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;
          void this.handleMessage(message);
        } catch (error) {
          endOnce(error instanceof Error ? error : new Error(String(error)));
          try {
            webSocket.terminate();
          } catch {
            // Best effort after malformed transport data.
          }
        }
      });
      webSocket.on("error", (error) => endOnce(error));
      webSocket.on("close", (code, reason) => {
        const detail = reason.toString().trim();
        endOnce(new Error(`shared codex app-server closed (${code})${detail ? `: ${detail}` : ""}`));
      });
    });
  }

  private handleProcessEnd(error: Error, generation: number): void {
    if (generation !== this.processGeneration) return;
    if (this.stopping) {
      this.pendingResponses.clear();
      this.initialized = undefined;
      this.child = undefined;
      return;
    }
    for (const pending of this.pendingResponses.values()) pending.reject(error);
    this.pendingResponses.clear();
    this.initialized = undefined;
    this.child = undefined;
    this.webSocket = undefined;
    this.onFatalError(error);
    this.scheduleSharedReconnect();
  }

  private async ensureChildOpen(): Promise<void> {
    if (this.webSocket?.readyState === WebSocket.OPEN) return;
    if (!this.child?.stdin || this.child.killed) {
      throw new Error("codex app-server is not running");
    }
  }

  private scheduleSharedReconnect(): void {
    if (!this.appServerEndpoint || this.stopping || this.reconnectTimer) return;
    const delayMs = Math.min(1000 * (2 ** this.reconnectAttempt), 30_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.start().catch(() => undefined);
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private async readLoop(): Promise<void> {
    if (!this.stdoutLines) return;
    try {
      for await (const line of this.stdoutLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const message = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcRequest | JsonRpcNotification;
        void this.handleMessage(message);
      }
    } catch (error) {
      if (this.stopping) return;
      const message = error instanceof Error ? error.message : String(error);
      for (const pending of this.pendingResponses.values()) pending.reject(new Error(message));
      this.pendingResponses.clear();
    }
  }

  private async handleMessage(message: JsonRpcResponse | JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if ("id" in message && "method" in message) {
      await this.onServerRequest(message);
      return;
    }
    if ("id" in message) {
      const pending = this.pendingResponses.get(String(message.id));
      if (!pending) return;
      this.pendingResponses.delete(String(message.id));
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
}

function sharedAppServerEndpointFromEnvironment(): string | undefined {
  const explicit = process.env.CHAT_CODEX_APP_SERVER_ENDPOINT?.trim();
  if (explicit) return explicit;
  if (process.env.CHAT_CODEX_APP_SERVER_DAEMON !== "1") return undefined;
  const configuredSocket = process.env.CHAT_CODEX_APP_SERVER_SOCKET?.trim();
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const socketPath = configuredSocket || path.join(codexHome, "app-server-control", "app-server-control.sock");
  return `unix://${socketPath}`;
}

function unixSocketPath(endpoint: string): string {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "unix:" || parsed.host) {
    throw new Error(`unsupported codex app-server endpoint: ${endpoint}`);
  }
  const socketPath = decodeURIComponent(parsed.pathname);
  if (!path.isAbsolute(socketPath)) {
    throw new Error(`codex app-server Unix socket must be absolute: ${endpoint}`);
  }
  return socketPath;
}
