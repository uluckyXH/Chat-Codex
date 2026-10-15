export interface CodexProtocolStatus {
  mode: "app-server";
  initialized: boolean;
  serverUserAgent?: string;
  schemaBaseline: string;
  /** Handshake success is not a model or channel delivery test. */
  verification: "not_connected" | "handshake_only";
}

export function protocolStatus(serverUserAgent?: string, initialized = false): CodexProtocolStatus {
  return {
    mode: "app-server",
    initialized,
    ...(serverUserAgent ? { serverUserAgent } : {}),
    schemaBaseline: "codex-cli 0.162.1 (default + experimental)",
    verification: initialized ? "handshake_only" : "not_connected",
  };
}
