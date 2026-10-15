import fs from "node:fs";
import path from "node:path";
import { weixinQuoteAccountDir } from "./weixin-quote-store.js";

export interface StoredWeixinAccount {
  accountId: string;
  token: string;
  baseUrl: string;
  cdnBaseUrl?: string;
  userId?: string;
  savedAt: string;
  getUpdatesBuf?: string;
}

export interface WeixinAccountStore {
  listAccountIds(): string[];
  loadAccount(accountId: string): StoredWeixinAccount | undefined;
  saveAccount(account: StoredWeixinAccount): void;
  getDefaultAccount(): StoredWeixinAccount | undefined;
  saveGetUpdatesBuf(accountId: string, getUpdatesBuf: string): void;
}

export class FileWeixinAccountStore implements WeixinAccountStore {
  private readonly rootDir: string;

  constructor(rootDir = path.join(process.cwd(), "state", "weixin")) {
    this.rootDir = rootDir;
  }

  getStateDir(): string { return this.rootDir; }

  listAccountIds(): string[] {
    const indexPath = this.indexPath();
    try {
      if (!fs.existsSync(indexPath)) return [];
      const parsed = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }

  loadAccount(accountId: string): StoredWeixinAccount | undefined {
    try {
      const filePath = this.accountPath(accountId);
      if (!fs.existsSync(filePath)) return undefined;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as StoredWeixinAccount;
      if (!parsed.accountId || !parsed.token || !parsed.baseUrl) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  saveAccount(account: StoredWeixinAccount): void {
    fs.mkdirSync(this.accountsDir(), { recursive: true });
    fs.writeFileSync(this.accountPath(account.accountId), JSON.stringify(account, null, 2), "utf-8");
    try {
      fs.chmodSync(this.accountPath(account.accountId), 0o600);
    } catch {
      // best effort on platforms that support chmod
    }
    this.addToIndex(account.accountId);
  }

  removeAccount(accountId: string): boolean {
    const normalizedAccountId = normalizeWeixinAccountId(accountId);
    const ids = this.listAccountIds();
    const removedIds = ids.filter((id) => id === accountId || normalizeWeixinAccountId(id) === normalizedAccountId);
    if (removedIds.length === 0) return false;
    for (const id of removedIds) {
      fs.rmSync(this.accountPath(id), { force: true });
      fs.rmSync(weixinQuoteAccountDir(this.rootDir, id), { recursive: true, force: true });
    }
    const remainingIds = ids.filter((id) => !removedIds.includes(id));
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.writeFileSync(this.indexPath(), JSON.stringify(remainingIds, null, 2), "utf-8");
    return true;
  }

  getDefaultAccount(): StoredWeixinAccount | undefined {
    const ids = this.listAccountIds();
    for (let i = ids.length - 1; i >= 0; i -= 1) {
      const account = this.loadAccount(ids[i]);
      if (account) return account;
    }
    return undefined;
  }

  saveGetUpdatesBuf(accountId: string, getUpdatesBuf: string): void {
    const account = this.loadAccount(accountId);
    if (!account) return;
    this.saveAccount({ ...account, getUpdatesBuf });
  }

  private addToIndex(accountId: string): void {
    fs.mkdirSync(this.rootDir, { recursive: true });
    const ids = this.listAccountIds();
    if (ids.includes(accountId)) return;
    fs.writeFileSync(this.indexPath(), JSON.stringify([...ids, accountId], null, 2), "utf-8");
  }

  private indexPath(): string {
    return path.join(this.rootDir, "accounts.json");
  }

  private accountsDir(): string {
    return path.join(this.rootDir, "accounts");
  }

  private accountPath(accountId: string): string {
    return path.join(this.accountsDir(), `${accountId}.json`);
  }
}

export function normalizeWeixinAccountId(accountId: string): string {
  return accountId.trim().replace(/[@.]/g, "-").replace(/[^A-Za-z0-9_-]/g, "-");
}
