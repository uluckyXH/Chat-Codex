export interface WeixinNetworkFailure {
  type: "dns" | "tcp" | "tls" | "timeout" | "unknown";
  code?: string;
}

export function classifyWeixinFetchError(error: unknown): WeixinNetworkFailure {
  const values: string[] = [];
  let code: string | undefined;
  let current = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current !== "object") { values.push(String(current)); break; }
    const entry = current as { message?: unknown; name?: unknown; code?: unknown; cause?: unknown };
    for (const value of [entry.name, entry.message, entry.code]) if (typeof value === "string") values.push(value);
    if (typeof entry.code === "string" && /^[A-Z0-9_]+$/.test(entry.code)) code = entry.code;
    current = entry.cause;
  }
  const text = values.join(" ");
  const type = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text) ? "dns"
    : /TLS|SSL|CERT|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(text) ? "tls"
    : /AbortError|TimeoutError|UND_ERR_(HEADERS|BODY)_TIMEOUT/i.test(text) ? "timeout"
    : /ECONN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_(SOCKET|CONNECT_TIMEOUT)/i.test(text) ? "tcp"
    : "unknown";
  return { type, ...(code ? { code } : {}) };
}

export class WeixinNetworkError extends Error {
  readonly failure: WeixinNetworkFailure;
  constructor(cause: unknown) {
    const failure = classifyWeixinFetchError(cause);
    // Keep credentials/URLs from fetch causes out of user-visible status text.
    super(`fetch failed: ${failure.type}${failure.code ? ` (${failure.code})` : ""}`, { cause });
    this.name = "WeixinNetworkError";
    this.failure = failure;
  }
}
