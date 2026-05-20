import type { ChannelMessage } from "../protocol/channel.js";
import type { GroupPrincipal, GroupPrincipalSource, KnownGroupPrincipal } from "./types.js";

export const KNOWN_GROUP_PRINCIPAL_LIMIT = 50;

export interface CreateGroupPrincipalInput {
  senderId: string;
  displayName?: string;
  source: GroupPrincipalSource;
  createdBySenderId?: string;
  createdAt: string;
}

export function createGroupPrincipal(input: CreateGroupPrincipalInput): GroupPrincipal {
  return {
    senderId: input.senderId,
    displayName: normalizeDisplayName(input.displayName),
    source: input.source,
    createdBySenderId: input.createdBySenderId,
    createdAt: input.createdAt,
  };
}

export function groupPrincipalFromMessage(
  message: ChannelMessage,
  source: GroupPrincipalSource,
  createdAt: string,
): GroupPrincipal {
  return createGroupPrincipal({
    senderId: message.sender.id,
    displayName: message.sender.displayName,
    source,
    createdAt,
  });
}

export function upsertKnownGroupPrincipal(
  principals: KnownGroupPrincipal[] | undefined,
  input: {
    senderId: string;
    displayName?: string;
    source: KnownGroupPrincipal["source"];
    seenAt: string;
  },
): KnownGroupPrincipal[] {
  const existing = principals?.find((principal) => principal.senderId === input.senderId);
  const next: KnownGroupPrincipal = {
    senderId: input.senderId,
    displayName: normalizeDisplayName(input.displayName) ?? existing?.displayName,
    firstSeenAt: existing?.firstSeenAt ?? input.seenAt,
    lastSeenAt: input.seenAt,
    source: existing?.source === "pairing" || existing?.source === "tui" ? existing.source : input.source,
  };
  const merged = [
    ...(principals ?? []).filter((principal) => principal.senderId !== input.senderId),
    next,
  ].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  return merged.slice(0, KNOWN_GROUP_PRINCIPAL_LIMIT)
    .sort((left, right) => left.senderId.localeCompare(right.senderId));
}

export function normalizeDisplayName(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\s+/g, " ");
  return trimmed || undefined;
}
