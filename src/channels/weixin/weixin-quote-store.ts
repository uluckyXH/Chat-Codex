import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ChannelAttachment } from "../../protocol/channel.js";

export interface WeixinQuoteCachePolicy {
  enabled: boolean;
  retentionMs: number;
  maxMessages: number;
  mediaRetentionMs: number;
  maxMediaBytes: number;
  maxSingleMediaBytes: number;
}

export const DEFAULT_WEIXIN_QUOTE_POLICY: WeixinQuoteCachePolicy = {
  enabled: true,
  retentionMs: 30 * 86_400_000,
  maxMessages: 10_000,
  mediaRetentionMs: 7 * 86_400_000,
  maxMediaBytes: 256 * 1024 * 1024,
  maxSingleMediaBytes: 25 * 1024 * 1024,
};

interface CachedAttachment {
  id: string;
  type: "image" | "file";
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  file?: string;
}
interface Row { conversation_id: string; message_id: string; text: string; attachments: string; created_at: number }
interface AccountCache { db: DatabaseSync; mediaDir: string }
export interface WeixinQuoteRecord { text: string; attachments: ChannelAttachment[]; mediaExpired: boolean }
export type WeixinQuoteLookup =
  | { status: "hit"; record: WeixinQuoteRecord }
  | { status: "miss" | "disabled" | "unavailable" };

/** A best-effort side store. Tokens, CDN credentials and original file paths are never persisted. */
export class WeixinQuoteStore {
  private readonly accounts = new Map<string, AccountCache | null>();
  private readonly policy: WeixinQuoteCachePolicy;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;

  constructor(private readonly options: {
    rootDir: string;
    channelId: string;
    policy?: Partial<WeixinQuoteCachePolicy>;
    now?: () => number;
    onError?: (error: unknown) => void;
  }) {
    this.policy = { ...DEFAULT_WEIXIN_QUOTE_POLICY };
    this.policy.enabled = options.policy?.enabled !== false;
    for (const key of ["retentionMs", "maxMessages", "mediaRetentionMs", "maxMediaBytes", "maxSingleMediaBytes"] as const) {
      const value = options.policy?.[key];
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) this.policy[key] = value;
    }
    this.now = options.now ?? Date.now;
  }

  async put(accountId: string, conversationId: string, messageId: string, text: string, attachments: ChannelAttachment[] = []): Promise<void> {
    await this.run(async () => {
      const cache = await this.account(accountId);
      if (!cache || !messageId || !conversationId) return;
      if (cache.db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND message_id = ?").get(conversationId, messageId)) return;
      const saved = attachments.slice(0, 5).filter((a) => a.type === "image" || a.type === "file").map((attachment): CachedAttachment => {
        const meta: CachedAttachment = { id: attachment.id, type: attachment.type as "image" | "file", name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes };
        if (!attachment.localPath || attachment.downloadState !== "available") return meta;
        try {
          const stat = fs.statSync(attachment.localPath);
          if (!stat.isFile() || stat.size > this.policy.maxSingleMediaBytes || stat.size > this.policy.maxMediaBytes) return meta;
          const file = `${randomUUID()}.bin`;
          const destination = path.join(cache.mediaDir, file);
          fs.copyFileSync(attachment.localPath, destination, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(destination, 0o600);
          // Check the copy too: the source could have changed between stat and copy.
          const size = fs.statSync(destination).size;
          if (size > this.policy.maxSingleMediaBytes || size > this.policy.maxMediaBytes) { fs.rmSync(destination); return meta; }
          return { ...meta, file, sizeBytes: size };
        } catch (error) { this.report(error); return meta; }
      });
      const body = Buffer.byteLength(text, "utf8") <= 256 * 1024 ? text : "[引用正文超过缓存上限，请重新发送]";
      cache.db.prepare("INSERT INTO messages (conversation_id, message_id, text, attachments, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(conversationId, messageId, body, JSON.stringify(saved), this.now());
      this.prune(cache);
    });
  }

  async find(accountId: string, conversationId: string, messageId: string): Promise<WeixinQuoteRecord | undefined> {
    const result = await this.lookup(accountId, conversationId, messageId);
    return result.status === "hit" ? result.record : undefined;
  }

  async lookup(accountId: string, conversationId: string, messageId: string): Promise<WeixinQuoteLookup> {
    if (!this.policy.enabled) return { status: "disabled" };
    const result = await this.run<WeixinQuoteLookup>(async () => {
      const cache = await this.account(accountId);
      if (!cache) return { status: "unavailable" };
      const row = cache.db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND message_id = ? AND created_at >= ?")
        .get(conversationId, messageId, this.now() - this.policy.retentionMs) as Row | undefined;
      // Evicted records leave no tombstone: a miss cannot prove that a message expired.
      if (!row) return { status: "miss" };
      let mediaExpired = false;
      const attachments: ChannelAttachment[] = [];
      for (const meta of readAttachments(row)) {
        const localPath = meta.file ? this.mediaPath(cache, meta.file) : undefined;
        if (!localPath || row.created_at < this.now() - this.policy.mediaRetentionMs || !isRegularFile(localPath)) { mediaExpired = true; continue; }
        attachments.push({ id: `quote-${messageId}-${meta.id}`, type: meta.type, name: meta.name, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes, localPath, caption: "引用附件", downloadState: "available" });
      }
      return { status: "hit", record: { text: row.text, attachments, mediaExpired } };
    });
    return result ?? { status: "unavailable" };
  }

  async collect(): Promise<void> {
    await this.run(async () => { for (const cache of this.accounts.values()) if (cache) this.prune(cache); });
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.queue;
    for (const cache of this.accounts.values()) if (cache) { try { cache.db.close(); } catch (error) { this.report(error); } }
    this.accounts.clear();
  }

  private async account(accountId: string): Promise<AccountCache | undefined> {
    if (!this.policy.enabled) return undefined;
    if (this.accounts.has(accountId)) return this.accounts.get(accountId) ?? undefined;
    let db: DatabaseSync | undefined;
    try {
      // Dynamic import keeps ordinary messaging available on Node builds without SQLite.
      const sqlite = await import("node:sqlite");
      const dir = path.join(weixinQuoteAccountDir(this.options.rootDir, accountId), hash(this.options.channelId));
      const mediaDir = path.join(dir, "media");
      fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
      db = new sqlite.DatabaseSync(path.join(dir, "messages.sqlite"));
      fs.chmodSync(path.join(dir, "messages.sqlite"), 0o600);
      db.exec(`PRAGMA journal_mode = DELETE;
        PRAGMA busy_timeout = 1000;
        CREATE TABLE IF NOT EXISTS messages (
          conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, text TEXT NOT NULL,
          attachments TEXT NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY (conversation_id, message_id));
        CREATE INDEX IF NOT EXISTS messages_created ON messages (created_at);`);
      const cache = { db, mediaDir };
      this.prune(cache);
      this.accounts.set(accountId, cache);
      if (!this.timer) {
        this.timer = setInterval(() => { void this.collect(); }, 60 * 60_000);
        this.timer.unref();
      }
      return cache;
    } catch (error) {
      try { db?.close(); } catch { /* Preserve the original error. */ }
      this.accounts.set(accountId, null);
      this.report(error);
      return undefined;
    }
  }

  private prune(cache: AccountCache): void {
    cache.db.prepare("DELETE FROM messages WHERE created_at < ?").run(this.now() - this.policy.retentionMs);
    cache.db.prepare("DELETE FROM messages WHERE rowid IN (SELECT rowid FROM messages ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)").run(this.policy.maxMessages);
    const rows = cache.db.prepare("SELECT conversation_id, message_id, attachments, created_at FROM messages ORDER BY created_at DESC, rowid DESC").all() as unknown as Array<Omit<Row, "text">>;
    const keep = new Set<string>();
    let bytes = 0;
    for (const row of rows) {
      const attachments = readAttachments(row);
      let changed = false;
      for (const meta of attachments) {
        if (!meta.file) continue;
        const filePath = this.mediaPath(cache, meta.file);
        const size = filePath && isRegularFile(filePath) ? fs.statSync(filePath).size : undefined;
        if (row.created_at < this.now() - this.policy.mediaRetentionMs || size === undefined || size > this.policy.maxSingleMediaBytes || bytes + size > this.policy.maxMediaBytes) {
          delete meta.file;
          changed = true;
        } else {
          keep.add(meta.file);
          bytes += size;
        }
      }
      if (changed) cache.db.prepare("UPDATE messages SET attachments = ? WHERE conversation_id = ? AND message_id = ?").run(JSON.stringify(attachments), row.conversation_id, row.message_id);
    }
    // This directory contains only our copies; never delete source uploads or sent files.
    for (const entry of fs.readdirSync(cache.mediaDir)) {
      const filePath = this.mediaPath(cache, entry);
      if (filePath && !keep.has(entry)) fs.rmSync(filePath, { force: true });
    }
  }

  private mediaPath(cache: AccountCache, file: string): string | undefined {
    return /^[0-9a-f-]{36}\.bin$/.test(file) ? path.join(cache.mediaDir, file) : undefined;
  }

  private run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    const result = this.queue.then(operation).catch((error) => { this.report(error); return undefined; });
    this.queue = result;
    return result;
  }

  private report(error: unknown): void { try { this.options.onError?.(error); } catch { /* A diagnostic must not fail delivery. */ } }
}

function readAttachments(row: Pick<Row, "attachments">): CachedAttachment[] {
  const value: unknown = JSON.parse(row.attachments);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is CachedAttachment => Boolean(item && typeof item.id === "string" && (item.type === "image" || item.type === "file") && (item.file === undefined || typeof item.file === "string")));
}

function isRegularFile(file: string): boolean { try { return fs.lstatSync(file).isFile(); } catch { return false; } }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function weixinQuoteAccountDir(rootDir: string, accountId: string): string { return path.join(rootDir, "quotes", hash(accountId)); }
