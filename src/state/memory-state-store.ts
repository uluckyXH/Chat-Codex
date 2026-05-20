import type { CodexSession, CodexSessionStatus } from "../codex/types.js";
import type { CodexRunPolicy } from "../codex/codex-cli.js";
import type { ChannelMessage } from "../protocol/channel.js";
import { SessionBindings, type ActivateSessionResult, type ClaimSessionResult, type SessionBinding, type SessionOwner, type TransferSessionOwnerResult, type UnbindSessionResult } from "./session-bindings.js";
import {
  type PendingBindingRecord,
  type PendingSessionBinding,
  type GroupAccessRecord,
  type RouteRecord,
  type SessionContextSnapshotObservedBy,
  type SessionContextSnapshotRecord,
  type SessionPolicyRecord,
  type TrustedRouteRecord,
} from "./persistent-state-types.js";
import type { CodexSessionContextFingerprint } from "../codex/session-context-fingerprint.js";
import {
  cloneContextRefreshPolicy,
  normalizeContextRefreshPolicy,
  type ContextRefreshPolicy,
} from "../context-refresh/types.js";

export interface StoredSession {
  session: CodexSession;
  routeKey?: string;
  ownerRouteKey?: string;
  status: CodexSessionStatus;
  runPolicy?: CodexRunPolicy;
  updatedAt: string;
  lastError?: string;
}

export function pendingBindingOwnerRouteKey(id: string): string {
  return `pending:${id}`;
}

export class MemoryStateStore {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly sessionRunPolicies = new Map<string, CodexRunPolicy>();
  private readonly pendingBindings = new Map<string, PendingBindingRecord>();
  private readonly trustedRoutes = new Map<string, TrustedRouteRecord>();
  private readonly groupAccess = new Map<string, GroupAccessRecord>();
  private readonly routeContextRefreshPolicies = new Map<string, ContextRefreshPolicy>();
  private readonly sessionContextSnapshots = new Map<string, SessionContextSnapshotRecord>();

  constructor(
    readonly sessionBindings = new SessionBindings(),
    sessionPolicies: SessionPolicyRecord[] = [],
    pendingBindings: PendingBindingRecord[] = [],
    trustedRoutes: TrustedRouteRecord[] = [],
    sessionContextSnapshots: SessionContextSnapshotRecord[] = [],
    groupAccess: GroupAccessRecord[] = [],
  ) {
    for (const policy of sessionPolicies) {
      this.sessionRunPolicies.set(policy.sessionId, { ...policy.runPolicy });
    }
    for (const pending of pendingBindings) {
      this.pendingBindings.set(pending.id, clonePendingBinding(pending));
    }
    for (const route of trustedRoutes) {
      this.trustedRoutes.set(route.routeKey, cloneTrustedRoute(route));
    }
    for (const record of groupAccess) {
      this.groupAccess.set(record.routeKey, cloneGroupAccessRecord(record));
    }
    for (const snapshot of sessionContextSnapshots) {
      if (snapshot.sessionId) this.sessionContextSnapshots.set(snapshot.sessionId, cloneSessionContextSnapshot(snapshot));
    }
  }

  bindSession(routeKey: string, session: CodexSession): SessionBinding {
    const now = new Date().toISOString();
    const binding = this.sessionBindings.bindNewSession(routeKey, session);
    this.sessions.set(session.id, {
      session,
      routeKey,
      ownerRouteKey: routeKey,
      status: { type: "idle" },
      runPolicy: this.getSessionRunPolicy(session.id),
      updatedAt: now,
    });
    return binding;
  }

  recordRouteMessage(_message: ChannelMessage): void {
    // MemoryStateStore only keeps active in-process binding state.
  }

  getRouteRecord(_routeKey: string): RouteRecord | undefined {
    return undefined;
  }

  isRouteTrusted(routeKey: string): boolean {
    return this.trustedRoutes.has(routeKey);
  }

  getTrustedRoute(routeKey: string): TrustedRouteRecord | undefined {
    const record = this.trustedRoutes.get(routeKey);
    return record ? cloneTrustedRoute(record) : undefined;
  }

  trustRoute(record: TrustedRouteRecord): TrustedRouteRecord {
    const existing = this.trustedRoutes.get(record.routeKey);
    const now = new Date().toISOString();
    const next: TrustedRouteRecord = {
      ...record,
      createdAt: existing?.createdAt ?? record.createdAt ?? now,
      updatedAt: record.updatedAt ?? now,
    };
    this.trustedRoutes.set(next.routeKey, cloneTrustedRoute(next));
    return cloneTrustedRoute(next);
  }

  revokeRouteTrust(routeKey: string): TrustedRouteRecord | undefined {
    const existing = this.trustedRoutes.get(routeKey);
    if (!existing) return undefined;
    this.trustedRoutes.delete(routeKey);
    return cloneTrustedRoute(existing);
  }

  listTrustedRoutes(): TrustedRouteRecord[] {
    return [...this.trustedRoutes.values()]
      .map(cloneTrustedRoute)
      .sort((left, right) => left.routeKey.localeCompare(right.routeKey));
  }

  getGroupAccess(routeKey: string): GroupAccessRecord | undefined {
    const record = this.groupAccess.get(routeKey);
    return record ? cloneGroupAccessRecord(record) : undefined;
  }

  upsertGroupAccess(record: GroupAccessRecord): GroupAccessRecord {
    this.groupAccess.set(record.routeKey, cloneGroupAccessRecord(record));
    return cloneGroupAccessRecord(record);
  }

  deleteGroupAccess(routeKey: string): GroupAccessRecord | undefined {
    const existing = this.groupAccess.get(routeKey);
    if (!existing) return undefined;
    this.groupAccess.delete(routeKey);
    return cloneGroupAccessRecord(existing);
  }

  listGroupAccess(): GroupAccessRecord[] {
    return [...this.groupAccess.values()]
      .map(cloneGroupAccessRecord)
      .sort((left, right) => left.routeKey.localeCompare(right.routeKey));
  }

  claimSessionOwner(routeKey: string, sessionId: string): ClaimSessionResult {
    return this.sessionBindings.claimSessionOwner(routeKey, sessionId);
  }

  activateOwnedSession(routeKey: string, session: CodexSession): ActivateSessionResult {
    const result = this.sessionBindings.activateOwnedSession(routeKey, session);
    if (!result.ok) return result;
    const existing = this.sessions.get(session.id);
    this.sessions.set(session.id, {
      session,
      routeKey,
      ownerRouteKey: routeKey,
      status: existing?.status ?? { type: "idle" },
      runPolicy: this.getSessionRunPolicy(session.id),
      updatedAt: new Date().toISOString(),
      lastError: existing?.lastError,
    });
    return result;
  }

  unbindSession(routeKey: string): UnbindSessionResult {
    const result = this.sessionBindings.unbindActiveSession(routeKey);
    if (!result.ok) return result;
    const stored = this.sessions.get(result.binding.sessionId);
    if (stored) {
      this.sessions.set(result.binding.sessionId, {
        ...stored,
        routeKey: stored.routeKey === routeKey ? undefined : stored.routeKey,
        ownerRouteKey: stored.ownerRouteKey === routeKey ? undefined : stored.ownerRouteKey,
        status: { type: "idle" },
        updatedAt: new Date().toISOString(),
      });
    }
    return result;
  }

  rollbackSessionOwnerClaim(routeKey: string, sessionId: string): void {
    this.sessionBindings.rollbackClaim(routeKey, sessionId);
  }

  transferSessionOwner(fromRouteKey: string, toRouteKey: string, sessionId: string): TransferSessionOwnerResult {
    return this.sessionBindings.transferSessionOwner(fromRouteKey, toRouteKey, sessionId);
  }

  getBinding(routeKey: string): SessionBinding | undefined {
    return this.sessionBindings.getActive(routeKey);
  }

  getSessionOwner(sessionId: string): SessionOwner | undefined {
    return this.sessionBindings.getOwner(sessionId);
  }

  getSession(sessionId: string): StoredSession | undefined {
    return this.sessions.get(sessionId);
  }

  setSessionStatus(sessionId: string, status: CodexSessionStatus): void {
    const stored = this.sessions.get(sessionId);
    if (!stored) return;
    this.sessions.set(sessionId, {
      ...stored,
      status,
      updatedAt: new Date().toISOString(),
      lastError: status.type === "failed" ? status.error : stored.lastError,
    });
  }

  getSessionRunPolicy(sessionId: string): CodexRunPolicy | undefined {
    const policy = this.sessionRunPolicies.get(sessionId);
    return policy ? { ...policy } : undefined;
  }

  setSessionRunPolicy(sessionId: string, policy: CodexRunPolicy): void {
    const cloned = { ...policy };
    this.sessionRunPolicies.set(sessionId, cloned);
    const stored = this.sessions.get(sessionId);
    if (stored) {
      this.sessions.set(sessionId, {
        ...stored,
        runPolicy: cloned,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  listSessionRunPolicies(): SessionPolicyRecord[] {
    const now = new Date().toISOString();
    return [...this.sessionRunPolicies.entries()]
      .map(([sessionId, runPolicy]) => ({
        sessionId,
        runPolicy: { ...runPolicy },
        createdAt: now,
        updatedAt: now,
      }))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  getRouteContextRefreshPolicy(routeKey: string): ContextRefreshPolicy | undefined {
    return cloneContextRefreshPolicy(this.routeContextRefreshPolicies.get(routeKey));
  }

  setRouteContextRefreshPolicy(routeKey: string, policy: ContextRefreshPolicy): void {
    const normalized = normalizeContextRefreshPolicy(policy);
    if (!normalized) throw new Error("invalid context refresh policy");
    this.routeContextRefreshPolicies.set(routeKey, normalized);
  }

  clearRouteContextRefreshPolicy(routeKey: string): void {
    this.routeContextRefreshPolicies.delete(routeKey);
  }

  getSessionContextSnapshot(sessionId: string): SessionContextSnapshotRecord | undefined {
    const snapshot = this.sessionContextSnapshots.get(sessionId);
    return snapshot ? cloneSessionContextSnapshot(snapshot) : undefined;
  }

  setSessionContextSnapshot(input: {
    sessionId: string;
    fingerprint: CodexSessionContextFingerprint;
    observedBy: SessionContextSnapshotObservedBy;
    observedAt?: string;
  }): SessionContextSnapshotRecord {
    const now = input.observedAt ?? new Date().toISOString();
    const existing = this.sessionContextSnapshots.get(input.sessionId);
    const record: SessionContextSnapshotRecord = {
      sessionId: input.sessionId,
      fingerprint: { ...input.fingerprint, sessionId: input.sessionId },
      observedBy: input.observedBy,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.sessionContextSnapshots.set(input.sessionId, cloneSessionContextSnapshot(record));
    return cloneSessionContextSnapshot(record);
  }

  listSessionContextSnapshots(): SessionContextSnapshotRecord[] {
    return [...this.sessionContextSnapshots.values()]
      .map(cloneSessionContextSnapshot)
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  setPendingBinding(input: {
    id: string;
    channelId: string;
    accountId: string;
    conversationKind: PendingBindingRecord["conversationKind"];
    conversationId?: string;
    label?: string;
    binding: PendingSessionBinding;
  }): PendingBindingRecord {
    const now = new Date().toISOString();
    const existing = this.pendingBindings.get(input.id);
    const record: PendingBindingRecord = {
      ...input,
      binding: { ...input.binding },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (record.binding.type === "existing") {
      const claim = this.claimSessionOwner(pendingBindingOwnerRouteKey(record.id), record.binding.sessionId);
      if (!claim.ok) {
        throw new Error(`session ${record.binding.sessionId} is owned by ${claim.owner.ownerRouteKey}`);
      }
    }
    if (existing && !isSamePendingOwnerBinding(existing.binding, record.binding)) {
      this.releasePendingBindingOwner(existing);
    }
    this.pendingBindings.set(record.id, record);
    return clonePendingBinding(record);
  }

  getPendingBindingForMessage(message: ChannelMessage): PendingBindingRecord | undefined {
    return this.findPendingBindingForMessage(message, false);
  }

  consumePendingBindingForMessage(message: ChannelMessage): PendingBindingRecord | undefined {
    return this.findPendingBindingForMessage(message, true);
  }

  clearPendingBindingForMessage(message: ChannelMessage): void {
    const record = this.findPendingBindingForMessage(message, true);
    this.releasePendingBindingOwner(record);
  }

  deletePendingBinding(id: string): PendingBindingRecord | undefined {
    const record = this.pendingBindings.get(id);
    if (!record) return undefined;
    this.pendingBindings.delete(id);
    this.releasePendingBindingOwner(record);
    return clonePendingBinding(record);
  }

  listPendingBindings(): PendingBindingRecord[] {
    return [...this.pendingBindings.values()]
      .map(clonePendingBinding)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  listSessions(routeKey?: string): StoredSession[] {
    const sessions = [...this.sessions.values()];
    if (!routeKey) return sessions;
    const owned = new Set(this.sessionBindings.listRouteSessions(routeKey));
    return sessions.filter((item) => owned.has(item.session.id) || item.ownerRouteKey === routeKey || item.routeKey === routeKey);
  }

  private findPendingBindingForMessage(message: ChannelMessage, consume: boolean): PendingBindingRecord | undefined {
    for (const pending of this.pendingBindings.values()) {
      if (pending.channelId !== message.channelId) continue;
      if (pending.accountId !== (message.accountId ?? "default")) continue;
      if (pending.conversationKind !== message.conversation.kind) continue;
      if (pending.conversationId && pending.conversationId !== message.conversation.id) continue;
      const record = clonePendingBinding(pending);
      if (consume) this.pendingBindings.delete(pending.id);
      return record;
    }
    return undefined;
  }

  private releasePendingBindingOwner(record: PendingBindingRecord | undefined): void {
    if (record?.binding.type === "existing") {
      this.rollbackSessionOwnerClaim(pendingBindingOwnerRouteKey(record.id), record.binding.sessionId);
    }
  }
}

function clonePendingBinding(record: PendingBindingRecord): PendingBindingRecord {
  return {
    ...record,
    binding: { ...record.binding },
  };
}

function cloneTrustedRoute(record: TrustedRouteRecord): TrustedRouteRecord {
  return { ...record };
}

function cloneGroupAccessRecord(record: GroupAccessRecord): GroupAccessRecord {
  return {
    ...record,
    superAdmin: record.superAdmin ? { ...record.superAdmin } : undefined,
    blockedSenders: record.blockedSenders.map((sender) => ({ ...sender })),
    knownPrincipals: record.knownPrincipals?.map((principal) => ({ ...principal })),
    reservedRoles: record.reservedRoles?.map((role) => ({
      ...role,
      members: role.members.map((member) => ({ ...member })),
      capabilities: { ...role.capabilities },
    })),
  };
}

function cloneSessionContextSnapshot(record: SessionContextSnapshotRecord): SessionContextSnapshotRecord {
  return {
    ...record,
    fingerprint: { ...record.fingerprint },
  };
}

function isSamePendingOwnerBinding(left: PendingSessionBinding, right: PendingSessionBinding): boolean {
  return left.type === "existing"
    && right.type === "existing"
    && left.sessionId === right.sessionId;
}
