import path from "node:path";
import { readJsonFile, resolveChatCodexStateRoot, writeJsonFileAtomic } from "../../../state/state-files.js";

export interface FeishuGroupMemberRegistryOptions {
  stateRootDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface FeishuGroupMemberRecord {
  openId: string;
  displayName: string;
  source: "manual";
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
}

interface FeishuGroupMembersDocument {
  schemaVersion: 1;
  channelId: string;
  accountId: string;
  chatId: string;
  updatedAt: string;
  members: FeishuGroupMemberRecord[];
}

export class FeishuGroupMemberRegistry {
  private readonly stateRootDir: string;
  private readonly now: () => Date;

  constructor(options: FeishuGroupMemberRegistryOptions = {}) {
    this.stateRootDir = options.stateRootDir ?? resolveChatCodexStateRoot({ cwd: options.cwd, env: options.env });
    this.now = options.now ?? (() => new Date());
  }

  getMember(input: FeishuGroupMemberRef): FeishuGroupMemberRecord | undefined {
    return this.read(input).members.find((member) => member.openId === input.openId);
  }

  hasMember(input: FeishuGroupMemberRef): boolean {
    return Boolean(this.getMember(input)?.displayName.trim());
  }

  setDisplayName(input: FeishuGroupMemberRef & { displayName: string }): FeishuGroupMemberRecord {
    const document = this.read(input);
    const timestamp = this.now().toISOString();
    const existing = document.members.find((member) => member.openId === input.openId);
    const next: FeishuGroupMemberRecord = {
      openId: input.openId,
      displayName: input.displayName,
      source: "manual",
      firstSeenAt: existing?.firstSeenAt ?? timestamp,
      lastSeenAt: timestamp,
      updatedAt: timestamp,
    };
    const members = existing
      ? document.members.map((member) => (member.openId === input.openId ? next : member))
      : [...document.members, next];
    this.write(input, {
      ...document,
      updatedAt: timestamp,
      members: members.sort((left, right) => left.openId.localeCompare(right.openId)),
    });
    return next;
  }

  membersPath(input: Pick<FeishuGroupMemberRef, "channelId" | "accountId" | "chatId">): string {
    return path.join(
      this.stateRootDir,
      "channels",
      "feishu",
      sanitizePathPart(input.channelId),
      "accounts",
      sanitizePathPart(input.accountId),
      "groups",
      sanitizePathPart(input.chatId),
      "members.json",
    );
  }

  private read(input: Pick<FeishuGroupMemberRef, "channelId" | "accountId" | "chatId">): FeishuGroupMembersDocument {
    return readJsonFile<FeishuGroupMembersDocument>(this.membersPath(input), {
      schemaVersion: 1,
      channelId: input.channelId,
      accountId: input.accountId,
      chatId: input.chatId,
      updatedAt: "",
      members: [],
    });
  }

  private write(input: Pick<FeishuGroupMemberRef, "channelId" | "accountId" | "chatId">, document: FeishuGroupMembersDocument): void {
    writeJsonFileAtomic(this.membersPath(input), document);
  }
}

export interface FeishuGroupMemberRef {
  channelId: string;
  accountId: string;
  chatId: string;
  openId: string;
}

export function sanitizeFeishuGroupDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function validateFeishuGroupDisplayName(value: string): string | undefined {
  if (value.includes("\n") || value.includes("\r")) return "名称不能包含换行。";
  const name = sanitizeFeishuGroupDisplayName(value);
  if (!name) return "名称不能为空。";
  if (Array.from(name).length > 24) return "名称不能超过 24 个字符。";
  return undefined;
}

function sanitizePathPart(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[._-]+/, "").slice(0, 80);
  return sanitized || "unknown";
}
