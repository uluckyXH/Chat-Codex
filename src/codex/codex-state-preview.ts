import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CodexStatePreviewResult =
  | { ok: true; applied: boolean; preview: string }
  | { ok: false; reason: "empty_preview" | "db_missing" | "thread_missing" | "sqlite_failed"; message: string };

export interface CodexStatePreviewOptions {
  codexHome?: string;
  sqliteBin?: string;
}

export interface EnsureCodexStatePreviewOptions extends CodexStatePreviewOptions {
  attempts?: number;
  retryDelayMs?: number;
}

export function setCodexStatePreviewIfEmpty(
  sessionId: string,
  preview: string,
  options: CodexStatePreviewOptions = {},
): CodexStatePreviewResult {
  const normalizedPreview = preview.replace(/\s+/g, " ").trim();
  if (!normalizedPreview) {
    return { ok: false, reason: "empty_preview", message: "preview must not be empty" };
  }
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const dbPath = path.join(codexHome, "state_5.sqlite");
  if (!fs.existsSync(dbPath)) {
    return { ok: false, reason: "db_missing", message: `Codex state db not found: ${dbPath}` };
  }

  const sql = [
    ".parameter init",
    `.parameter set :id ${sqliteStringLiteral(sessionId)}`,
    `.parameter set :preview ${sqliteStringLiteral(normalizedPreview)}`,
    [
      "UPDATE threads",
      "SET preview = :preview",
      "WHERE id = :id",
      "AND archived = 0",
      "AND trim(COALESCE(preview, '')) = '';",
    ].join(" "),
    "SELECT changes() AS changed, preview FROM threads WHERE id = :id AND archived = 0;",
  ].join("\n");
  const result = spawnSync(options.sqliteBin ?? "sqlite3", ["-batch", "-json", dbPath], {
    encoding: "utf8",
    input: sql,
    timeout: 2000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) {
    return { ok: false, reason: "sqlite_failed", message: result.error.message };
  }
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    const message = stderr || stdout || `sqlite3 exited with status ${result.status}`;
    return { ok: false, reason: "sqlite_failed", message };
  }
  try {
    const rows = JSON.parse(result.stdout.trim() || "[]") as Array<{ changed?: number; preview?: string }>;
    const row = rows[0];
    if (!row) {
      return { ok: false, reason: "thread_missing", message: `Codex thread not found in state db: ${sessionId}` };
    }
    const storedPreview = String(row.preview ?? "").trim();
    if (!storedPreview) {
      return { ok: false, reason: "sqlite_failed", message: `Codex thread preview is still empty: ${sessionId}` };
    }
    return { ok: true, applied: Number(row.changed ?? 0) > 0, preview: storedPreview };
  } catch {
    return { ok: false, reason: "sqlite_failed", message: "failed to parse sqlite3 output" };
  }
}

export async function ensureCodexStatePreviewIfEmpty(
  sessionId: string,
  preview: string,
  options: EnsureCodexStatePreviewOptions = {},
): Promise<CodexStatePreviewResult> {
  const attempts = Math.max(1, options.attempts ?? 8);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 80);
  let lastResult: CodexStatePreviewResult | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastResult = setCodexStatePreviewIfEmpty(sessionId, preview, options);
    if (lastResult.ok || !isRetryablePreviewResult(lastResult)) return lastResult;
    if (attempt < attempts - 1) await delay(retryDelayMs);
  }
  return lastResult ?? {
    ok: false,
    reason: "thread_missing",
    message: `Codex thread not found in state db: ${sessionId}`,
  };
}

function isRetryablePreviewResult(result: CodexStatePreviewResult): boolean {
  if (result.ok) return false;
  if (result.reason === "db_missing" || result.reason === "thread_missing") return true;
  return result.reason === "sqlite_failed" && /\b(locked|busy)\b/i.test(result.message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
