import path from "node:path";
import type { CodexRunPolicy } from "../codex/codex-cli.js";
import type { CodexSession } from "../codex/types.js";
import type { ChannelMessage, ConversationKind } from "../protocol/channel.js";
import { MemoryStateStore } from "./memory-state-store.js";
import type { ActivateSessionResult, ClaimSessionResult, SessionBinding, SessionBindingsSnapshot, UnbindSessionResult } from "./session-bindings.js";
import { SessionBindings } from "./session-bindings.js";
import { defaultBridgeStateDir, readJsonFile, writeJsonFileAtomic } from "./state-files.js";
import {
  LOCAL_STATE_SCHEMA_VERSION,
  type GroupAccessDocument,
  type GroupAccessRecord,
  type RouteIdentityRecord,
  type RouteRecord,
  type RoutesDocument,
  type PendingBindingRecord,
  type PendingBindingsDocument,
  type SessionContextSnapshotRecord,
  type SessionContextSnapshotsDocument,
  type SessionContextSnapshotObservedBy,
  type SessionOwnerRecord,
  type SessionOwnersDocument,
  type SessionPolicyRecord,
  type SessionPoliciesDocument,
  type TrustedRouteRecord,
  type TrustedRoutesDocument,
} from "./persistent-state-types.js";
import type { CodexSessionContextFingerprint } from "../codex/session-context-fingerprint.js";
import { cloneContextRefreshPolicy, normalizeContextRefreshPolicy, type ContextRefreshPolicy } from "../context-refresh/types.js";

export interface FileStateStoreOptions {
  rootDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RemoveChannelStateResult {
  channelId: string;
  removedRoutes: number;
  releasedSessions: number;
  removedPendingBindings: number;
}

interface LoadedFileState {
  rootDir: string;
  routes: Map<string, RouteRecord>;
  bindings: SessionBindings;
  sessionPolicies: Map<string, SessionPolicyRecord>;
  sessionContextSnapshots: Map<string, SessionContextSnapshotRecord>;
  pendingBindings: Map<string, PendingBindingRecord>;
  trustedRoutes: Map<string, TrustedRouteRecord>;
  groupAccess: Map<string, GroupAccessRecord>;
}

export class FileStateStore extends MemoryStateStore {
  readonly rootDir: string;
  private routes = new Map<string, RouteRecord>();
  private sessionPolicies = new Map<string, SessionPolicyRecord>();
  private persistedSessionContextSnapshots = new Map<string, SessionContextSnapshotRecord>();
  private persistedPendingBindings = new Map<string, PendingBindingRecord>();
  private persistedTrustedRoutes = new Map<string, TrustedRouteRecord>();
  private persistedGroupAccess = new Map<string, GroupAccessRecord>();
  private readonly routesPath: string;
  private readonly sessionOwnersPath: string;
  private readonly sessionPoliciesPath: string;
  private readonly sessionContextSnapshotsPath: string;
  private readonly pendingBindingsPath: string;
  private readonly trustedRoutesPath: string;
  private readonly groupAccessPath: string;

  constructor(options: FileStateStoreOptions = {}) {
    const loaded = loadFileState(options);
    super(
      loaded.bindings,
      [...loaded.sessionPolicies.values()],
      [...loaded.pendingBindings.values()],
      [...loaded.trustedRoutes.values()],
      [...loaded.sessionContextSnapshots.values()],
      [...loaded.groupAccess.values()],
    );
    this.rootDir = loaded.rootDir;
    this.routes = loaded.routes;
    this.sessionPolicies = loaded.sessionPolicies;
    this.persistedSessionContextSnapshots = loaded.sessionContextSnapshots;
    this.persistedPendingBindings = loaded.pendingBindings;
    this.persistedTrustedRoutes = loaded.trustedRoutes;
    this.persistedGroupAccess = loaded.groupAccess;
    this.routesPath = path.join(this.rootDir, "routes.json");
    this.sessionOwnersPath = path.join(this.rootDir, "session-owners.json");
    this.sessionPoliciesPath = path.join(this.rootDir, "session-policies.json");
    this.sessionContextSnapshotsPath = path.join(this.rootDir, "session-context-snapshots.json");
    this.pendingBindingsPath = path.join(this.rootDir, "pending-bindings.json");
    this.trustedRoutesPath = path.join(this.rootDir, "trusted-routes.json");
    this.groupAccessPath = path.join(this.rootDir, "group-access.json");
  }

  override bindSession(routeKey: string, session: CodexSession): SessionBinding {
    const binding = super.bindSession(routeKey, session);
    this.setRouteActiveSession(routeKey, session.id);
    this.persist();
    return binding;
  }

  override claimSessionOwner(routeKey: string, sessionId: string): ClaimSessionResult {
    const result = super.claimSessionOwner(routeKey, sessionId);
    if (result.ok) this.persist();
    return result;
  }

  override activateOwnedSession(routeKey: string, session: CodexSession): ActivateSessionResult {
    const result = super.activateOwnedSession(routeKey, session);
    if (result.ok) {
      this.setRouteActiveSession(routeKey, session.id);
      this.persist();
    }
    return result;
  }

  override unbindSession(routeKey: string): UnbindSessionResult {
    const result = super.unbindSession(routeKey);
    if (result.ok) {
      this.setRouteActiveSession(routeKey, undefined);
      this.persist();
    }
    return result;
  }

  override rollbackSessionOwnerClaim(routeKey: string, sessionId: string): void {
    super.rollbackSessionOwnerClaim(routeKey, sessionId);
    this.persist();
  }

  override transferSessionOwner(fromRouteKey: string, toRouteKey: string, sessionId: string): ReturnType<MemoryStateStore["transferSessionOwner"]> {
    const result = super.transferSessionOwner(fromRouteKey, toRouteKey, sessionId);
    if (result.ok) this.persist();
    return result;
  }

  override setSessionRunPolicy(sessionId: string, policy: CodexRunPolicy): void {
    super.setSessionRunPolicy(sessionId, policy);
    const now = new Date().toISOString();
    const existing = this.sessionPolicies.get(sessionId);
    this.sessionPolicies.set(sessionId, {
      sessionId,
      runPolicy: { ...policy },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.persistSessionPolicies();
  }

  override setPendingBinding(input: Parameters<MemoryStateStore["setPendingBinding"]>[0]): PendingBindingRecord {
    const record = super.setPendingBinding(input);
    this.persistedPendingBindings.set(record.id, record);
    this.persistPendingBindings();
    return record;
  }

  override consumePendingBindingForMessage(message: ChannelMessage): PendingBindingRecord | undefined {
    const record = super.consumePendingBindingForMessage(message);
    if (record) {
      this.persistedPendingBindings.delete(record.id);
      this.persistPendingBindings();
    }
    return record;
  }

  override clearPendingBindingForMessage(message: ChannelMessage): void {
    const record = super.getPendingBindingForMessage(message);
    super.clearPendingBindingForMessage(message);
    if (record) {
      this.persistedPendingBindings.delete(record.id);
      this.persistPendingBindings();
    }
  }

  override deletePendingBinding(id: string): PendingBindingRecord | undefined {
    const record = super.deletePendingBinding(id);
    if (record) {
      this.persistedPendingBindings.delete(record.id);
      this.persist();
    }
    return record;
  }

  override listPendingBindings(): PendingBindingRecord[] {
    return [...this.persistedPendingBindings.values()]
      .map((record) => ({ ...record, binding: { ...record.binding } }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  override listSessionRunPolicies(): SessionPolicyRecord[] {
    return [...this.sessionPolicies.values()]
      .map((policy) => ({
        ...policy,
        runPolicy: { ...policy.runPolicy },
      }))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  override getRouteContextRefreshPolicy(routeKey: string): ContextRefreshPolicy | undefined {
    return cloneContextRefreshPolicy(this.routes.get(routeKey)?.policy?.contextRefresh) ?? super.getRouteContextRefreshPolicy(routeKey);
  }

  override setRouteContextRefreshPolicy(routeKey: string, policy: ContextRefreshPolicy): void {
    const normalized = normalizeContextRefreshPolicy(policy);
    if (!normalized) throw new Error("invalid context refresh policy");
    super.setRouteContextRefreshPolicy(routeKey, normalized);
    const existing = this.routes.get(routeKey);
    const now = new Date().toISOString();
    const parsed = parseRouteKey(routeKey);
    this.routes.set(routeKey, {
      routeKey,
      channelId: existing?.channelId ?? parsed.channelId,
      channelType: existing?.channelType ?? inferChannelType(parsed.channelId),
      accountId: existing?.accountId ?? parsed.accountId,
      conversationKind: existing?.conversationKind ?? parsed.conversationKind,
      conversationId: existing?.conversationId ?? parsed.conversationId,
      activeSessionId: existing?.activeSessionId,
      displayName: existing?.displayName,
      identity: existing?.identity,
      policy: {
        ...existing?.policy,
        contextRefresh: normalized,
      },
      lastSeenAt: existing?.lastSeenAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.persistRoutes();
  }

  override clearRouteContextRefreshPolicy(routeKey: string): void {
    super.clearRouteContextRefreshPolicy(routeKey);
    const existing = this.routes.get(routeKey);
    if (!existing?.policy?.contextRefresh) return;
    const { contextRefresh: _contextRefresh, ...remainingPolicy } = existing.policy;
    this.routes.set(routeKey, {
      ...existing,
      policy: Object.keys(remainingPolicy).length > 0 ? remainingPolicy : undefined,
      updatedAt: new Date().toISOString(),
    });
    this.persistRoutes();
  }

  override getSessionContextSnapshot(sessionId: string): SessionContextSnapshotRecord | undefined {
    const snapshot = this.persistedSessionContextSnapshots.get(sessionId);
    return snapshot ? cloneSessionContextSnapshot(snapshot) : super.getSessionContextSnapshot(sessionId);
  }

  override setSessionContextSnapshot(input: {
    sessionId: string;
    fingerprint: CodexSessionContextFingerprint;
    observedBy: SessionContextSnapshotObservedBy;
    observedAt?: string;
  }): SessionContextSnapshotRecord {
    const record = super.setSessionContextSnapshot(input);
    this.persistedSessionContextSnapshots.set(record.sessionId, cloneSessionContextSnapshot(record));
    this.persistSessionContextSnapshots();
    return record;
  }

  override listSessionContextSnapshots(): SessionContextSnapshotRecord[] {
    return [...this.persistedSessionContextSnapshots.values()]
      .map(cloneSessionContextSnapshot)
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  override recordRouteMessage(message: ChannelMessage): void {
    const existing = this.routes.get(message.routeKey);
    const now = message.timestamp || new Date().toISOString();
    const parsed = parseRouteKey(message.routeKey);
    const record: RouteRecord = {
      routeKey: message.routeKey,
      channelId: message.channelId || existing?.channelId || parsed.channelId,
      channelType: existing?.channelType ?? inferChannelType(message.channelId),
      accountId: message.accountId ?? existing?.accountId ?? parsed.accountId,
      conversationKind: message.conversation.kind,
      conversationId: message.conversation.id,
      activeSessionId: existing?.activeSessionId,
      displayName: message.conversation.displayName ?? existing?.displayName,
      identity: mergeIdentity(existing?.identity, identityFromMessage(message)),
      policy: existing?.policy,
      lastSeenAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.routes.set(message.routeKey, record);
    this.updateTrustedRouteLastSeen(message);
    this.persistRoutes();
  }

  override trustRoute(record: TrustedRouteRecord): TrustedRouteRecord {
    const trusted = super.trustRoute(record);
    this.persistedTrustedRoutes.set(trusted.routeKey, trusted);
    this.persistTrustedRoutes();
    return trusted;
  }

  override revokeRouteTrust(routeKey: string): TrustedRouteRecord | undefined {
    const removed = super.revokeRouteTrust(routeKey);
    if (removed) {
      this.persistedTrustedRoutes.delete(routeKey);
      this.persistTrustedRoutes();
    }
    return removed;
  }

  override listTrustedRoutes(): TrustedRouteRecord[] {
    return [...this.persistedTrustedRoutes.values()]
      .map((route) => ({ ...route }))
      .sort((left, right) => left.routeKey.localeCompare(right.routeKey));
  }

  override getGroupAccess(routeKey: string): GroupAccessRecord | undefined {
    const record = this.persistedGroupAccess.get(routeKey);
    return record ? cloneGroupAccessRecord(record) : super.getGroupAccess(routeKey);
  }

  override upsertGroupAccess(record: GroupAccessRecord): GroupAccessRecord {
    const next = super.upsertGroupAccess(record);
    this.persistedGroupAccess.set(next.routeKey, cloneGroupAccessRecord(next));
    this.persistGroupAccess();
    return next;
  }

  override deleteGroupAccess(routeKey: string): GroupAccessRecord | undefined {
    const removed = super.deleteGroupAccess(routeKey);
    if (removed) {
      this.persistedGroupAccess.delete(routeKey);
      this.persistGroupAccess();
    }
    return removed;
  }

  override listGroupAccess(): GroupAccessRecord[] {
    return [...this.persistedGroupAccess.values()]
      .map(cloneGroupAccessRecord)
      .sort((left, right) => left.routeKey.localeCompare(right.routeKey));
  }

  listRoutes(): RouteRecord[] {
    return [...this.routes.values()].sort((left, right) => left.routeKey.localeCompare(right.routeKey));
  }

  override getRouteRecord(routeKey: string): RouteRecord | undefined {
    const record = this.routes.get(routeKey);
    return record ? cloneRouteRecord(record) : undefined;
  }

  removeChannelState(channelId: string): RemoveChannelStateResult {
    const routes = [...this.routes.values()].filter((route) => route.channelId === channelId);
    const pending = [...this.persistedPendingBindings.values()].filter((record) => record.channelId === channelId);
    const releasedSessions = new Set<string>();

    for (const route of routes) {
      for (const owner of this.sessionBindings.listOwners(route.routeKey)) {
        releasedSessions.add(owner.sessionId);
        this.sessionBindings.rollbackClaim(route.routeKey, owner.sessionId);
      }
      const active = this.sessionBindings.getActive(route.routeKey);
      if (active) {
        releasedSessions.add(active.sessionId);
        this.sessionBindings.unbindActiveSession(route.routeKey);
      }
      this.routes.delete(route.routeKey);
      super.revokeRouteTrust(route.routeKey);
      this.persistedTrustedRoutes.delete(route.routeKey);
      super.deleteGroupAccess(route.routeKey);
      this.persistedGroupAccess.delete(route.routeKey);
    }

    for (const record of pending) {
      const removed = super.deletePendingBinding(record.id);
      if (removed?.binding.type === "existing") releasedSessions.add(removed.binding.sessionId);
      this.persistedPendingBindings.delete(record.id);
    }

    this.persist();
    return {
      channelId,
      removedRoutes: routes.length,
      releasedSessions: releasedSessions.size,
      removedPendingBindings: pending.length,
    };
  }

  private setRouteActiveSession(routeKey: string, sessionId: string | undefined): void {
    const existing = this.routes.get(routeKey);
    const now = new Date().toISOString();
    const parsed = parseRouteKey(routeKey);
    this.routes.set(routeKey, {
      routeKey,
      channelId: existing?.channelId ?? parsed.channelId,
      channelType: existing?.channelType ?? inferChannelType(parsed.channelId),
      accountId: existing?.accountId ?? parsed.accountId,
      conversationKind: existing?.conversationKind ?? parsed.conversationKind,
      conversationId: existing?.conversationId ?? parsed.conversationId,
      activeSessionId: sessionId,
      displayName: existing?.displayName,
      identity: existing?.identity,
      policy: existing?.policy,
      lastSeenAt: existing?.lastSeenAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  private persist(): void {
    this.persistRoutes();
    this.persistSessionOwners();
    this.persistSessionPolicies();
    this.persistSessionContextSnapshots();
    this.persistPendingBindings();
    this.persistTrustedRoutes();
    this.persistGroupAccess();
  }

  private persistRoutes(): void {
    writeJsonFileAtomic(this.routesPath, {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      routes: this.listRoutes(),
    } satisfies RoutesDocument);
  }

  private persistSessionOwners(): void {
    const owners = this.sessionBindings.listOwners()
      .map((owner): SessionOwnerRecord => ({
        sessionId: owner.sessionId,
        ownerRouteKey: owner.ownerRouteKey,
        claimedAt: owner.claimedAt,
        updatedAt: owner.updatedAt,
      }))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    writeJsonFileAtomic(this.sessionOwnersPath, {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      owners,
    } satisfies SessionOwnersDocument);
  }

  private persistSessionPolicies(): void {
    writeJsonFileAtomic(this.sessionPoliciesPath, {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      policies: this.listSessionRunPolicies(),
    } satisfies SessionPoliciesDocument);
  }

  private persistSessionContextSnapshots(): void {
    writeJsonFileAtomic(this.sessionContextSnapshotsPath, {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      snapshots: this.listSessionContextSnapshots(),
    } satisfies SessionContextSnapshotsDocument);
  }

  private persistPendingBindings(): void {
    writeJsonFileAtomic(this.pendingBindingsPath, {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      pending: this.listPendingBindings(),
    } satisfies PendingBindingsDocument);
  }

  private persistTrustedRoutes(): void {
    writeJsonFileAtomic(this.trustedRoutesPath, {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      trustedRoutes: this.listTrustedRoutes(),
    } satisfies TrustedRoutesDocument);
  }

  private persistGroupAccess(): void {
    writeJsonFileAtomic(this.groupAccessPath, {
      schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      groups: this.listGroupAccess(),
    } satisfies GroupAccessDocument);
  }

  private updateTrustedRouteLastSeen(message: ChannelMessage): void {
    const existing = this.persistedTrustedRoutes.get(message.routeKey);
    if (!existing) return;
    const now = message.timestamp || new Date().toISOString();
    const next: TrustedRouteRecord = {
      ...existing,
      displayName: message.conversation.displayName ?? existing.displayName,
      lastSeenAt: now,
      updatedAt: now,
    };
    this.persistedTrustedRoutes.set(message.routeKey, next);
    super.trustRoute(next);
    this.persistTrustedRoutes();
  }
}

function loadFileState(options: FileStateStoreOptions): LoadedFileState {
  const rootDir = options.rootDir ?? defaultBridgeStateDir(options.cwd, options.env);
  const routes = loadRoutes(path.join(rootDir, "routes.json"));
  const owners = loadOwners(path.join(rootDir, "session-owners.json"));
  const sessionPolicies = loadSessionPolicies(path.join(rootDir, "session-policies.json"));
  const sessionContextSnapshots = loadSessionContextSnapshots(path.join(rootDir, "session-context-snapshots.json"));
  const pendingBindings = loadPendingBindings(path.join(rootDir, "pending-bindings.json"));
  const trustedRoutes = loadTrustedRoutes(path.join(rootDir, "trusted-routes.json"));
  const groupAccess = loadGroupAccess(path.join(rootDir, "group-access.json"));
  const active = [...routes.values()]
    .filter((route): route is RouteRecord & { activeSessionId: string } => Boolean(route.activeSessionId))
    .map((route) => ({
      routeKey: route.routeKey,
      sessionId: route.activeSessionId,
      createdAt: route.createdAt,
      updatedAt: route.updatedAt,
    }));
  const snapshot: SessionBindingsSnapshot = {
    active,
    owners: mergeOwnersWithActiveRoutes(owners, active),
  };
  return {
    rootDir,
    routes,
    bindings: new SessionBindings(snapshot),
    sessionPolicies,
    sessionContextSnapshots,
    pendingBindings,
    trustedRoutes,
    groupAccess,
  };
}

function cloneRouteRecord(record: RouteRecord): RouteRecord {
  return {
    ...record,
    identity: record.identity ? { ...record.identity } : undefined,
    policy: record.policy
      ? {
        ...record.policy,
        contextRefresh: cloneContextRefreshPolicy(record.policy.contextRefresh),
      }
      : undefined,
  };
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

function loadRoutes(filePath: string): Map<string, RouteRecord> {
  const doc = readJsonFile<RoutesDocument>(filePath, emptyRoutesDocument());
  const routes = new Map<string, RouteRecord>();
  for (const route of Array.isArray(doc.routes) ? doc.routes : []) {
    if (!route.routeKey || !route.channelId || !route.accountId || !route.conversationKind || !route.conversationId) continue;
    routes.set(route.routeKey, {
      ...route,
      policy: normalizeRoutePolicy(route.policy),
    });
  }
  return routes;
}

function loadOwners(filePath: string): SessionOwnerRecord[] {
  const doc = readJsonFile<SessionOwnersDocument>(filePath, emptyOwnersDocument());
  return (Array.isArray(doc.owners) ? doc.owners : [])
    .filter((owner) => owner.sessionId && owner.ownerRouteKey);
}

function loadSessionPolicies(filePath: string): Map<string, SessionPolicyRecord> {
  const doc = readJsonFile<SessionPoliciesDocument>(filePath, emptySessionPoliciesDocument());
  const policies = new Map<string, SessionPolicyRecord>();
  for (const policy of Array.isArray(doc.policies) ? doc.policies : []) {
    if (!policy.sessionId || !isRunPolicy(policy.runPolicy)) continue;
    policies.set(policy.sessionId, {
      sessionId: policy.sessionId,
      runPolicy: { ...policy.runPolicy },
      createdAt: policy.createdAt ?? new Date(0).toISOString(),
      updatedAt: policy.updatedAt ?? policy.createdAt ?? new Date(0).toISOString(),
    });
  }
  return policies;
}

function loadSessionContextSnapshots(filePath: string): Map<string, SessionContextSnapshotRecord> {
  const doc = readJsonFile<SessionContextSnapshotsDocument>(filePath, emptySessionContextSnapshotsDocument());
  const snapshots = new Map<string, SessionContextSnapshotRecord>();
  for (const snapshot of Array.isArray(doc.snapshots) ? doc.snapshots : []) {
    if (!snapshot.sessionId || !isContextFingerprint(snapshot.fingerprint)) continue;
    snapshots.set(snapshot.sessionId, {
      sessionId: snapshot.sessionId,
      fingerprint: { ...snapshot.fingerprint, sessionId: snapshot.sessionId },
      observedBy: isSnapshotObservedBy(snapshot.observedBy) ? snapshot.observedBy : "resume",
      createdAt: snapshot.createdAt ?? new Date(0).toISOString(),
      updatedAt: snapshot.updatedAt ?? snapshot.createdAt ?? new Date(0).toISOString(),
    });
  }
  return snapshots;
}

function loadPendingBindings(filePath: string): Map<string, PendingBindingRecord> {
  const doc = readJsonFile<PendingBindingsDocument>(filePath, emptyPendingBindingsDocument());
  const pending = new Map<string, PendingBindingRecord>();
  for (const record of Array.isArray(doc.pending) ? doc.pending : []) {
    if (!record.id || !record.channelId || !record.accountId || !isConversationKind(record.conversationKind)) continue;
    if (record.binding?.type !== "new" && !(record.binding?.type === "existing" && record.binding.sessionId)) continue;
    pending.set(record.id, {
      id: record.id,
      channelId: record.channelId,
      accountId: record.accountId,
      conversationKind: record.conversationKind,
      conversationId: record.conversationId,
      label: record.label,
      binding: { ...record.binding },
      createdAt: record.createdAt ?? new Date(0).toISOString(),
      updatedAt: record.updatedAt ?? record.createdAt ?? new Date(0).toISOString(),
    });
  }
  return pending;
}

function loadTrustedRoutes(filePath: string): Map<string, TrustedRouteRecord> {
  const doc = readJsonFile<TrustedRoutesDocument>(filePath, emptyTrustedRoutesDocument());
  const trustedRoutes = new Map<string, TrustedRouteRecord>();
  for (const record of Array.isArray(doc.trustedRoutes) ? doc.trustedRoutes : []) {
    if (!record.routeKey || !record.channelId || !record.accountId || !isConversationKind(record.conversationKind) || !record.conversationId) continue;
    if (!record.trustedAt || !record.trustedBySenderId) continue;
    trustedRoutes.set(record.routeKey, {
      routeKey: record.routeKey,
      channelId: record.channelId,
      accountId: record.accountId,
      conversationKind: record.conversationKind,
      conversationId: record.conversationId,
      displayName: record.displayName,
      trustedAt: record.trustedAt,
      trustedBySenderId: record.trustedBySenderId,
      trustedBySenderDisplayName: record.trustedBySenderDisplayName,
      trustMethod: record.trustMethod === "manual" ? "manual" : "pairing_code",
      lastSeenAt: record.lastSeenAt,
      createdAt: record.createdAt ?? record.trustedAt,
      updatedAt: record.updatedAt ?? record.trustedAt,
    });
  }
  return trustedRoutes;
}

function loadGroupAccess(filePath: string): Map<string, GroupAccessRecord> {
  const doc = readJsonFile<GroupAccessDocument>(filePath, emptyGroupAccessDocument());
  const groups = new Map<string, GroupAccessRecord>();
  for (const record of Array.isArray(doc.groups) ? doc.groups : []) {
    const normalized = normalizeGroupAccessRecord(record);
    if (normalized) groups.set(normalized.routeKey, normalized);
  }
  return groups;
}

function mergeOwnersWithActiveRoutes(
  owners: SessionOwnerRecord[],
  active: SessionBindingsSnapshot["active"],
): SessionOwnerRecord[] {
  const merged = new Map<string, SessionOwnerRecord>();
  for (const owner of owners) merged.set(owner.sessionId, owner);
  for (const binding of active) {
    if (!merged.has(binding.sessionId)) {
      merged.set(binding.sessionId, {
        sessionId: binding.sessionId,
        ownerRouteKey: binding.routeKey,
        claimedAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      });
    }
  }
  return [...merged.values()];
}

function parseRouteKey(routeKey: string): {
  channelId: string;
  accountId: string;
  conversationKind: ConversationKind;
  conversationId: string;
} {
  const [channelId = "unknown", accountId = "default", kind = "direct", ...conversationParts] = routeKey.split(":");
  const conversationId = conversationParts.join(":") || "unknown";
  return {
    channelId,
    accountId,
    conversationKind: isConversationKind(kind) ? kind : "direct",
    conversationId,
  };
}

function isConversationKind(value: string): value is ConversationKind {
  return value === "direct" || value === "group" || value === "thread";
}

function inferChannelType(channelId: string): string | undefined {
  if (channelId.startsWith("weixin")) return "weixin";
  if (channelId.startsWith("feishu") || channelId.startsWith("lark")) return "feishu";
  if (channelId.startsWith("terminal")) return "terminal";
  if (channelId.startsWith("mock")) return "mock";
  return undefined;
}

function identityFromMessage(message: ChannelMessage): RouteIdentityRecord {
  const feishu = extractFeishuIdentity(message.raw);
  return {
    lastSenderId: message.sender.id,
    lastSenderDisplayName: message.sender.displayName,
    ...feishu,
  };
}

function extractFeishuIdentity(raw: unknown): RouteIdentityRecord {
  if (!raw || typeof raw !== "object") return {};
  const event = raw as {
    tenant_key?: unknown;
    sender?: {
      tenant_key?: unknown;
      sender_id?: {
        open_id?: unknown;
        user_id?: unknown;
        union_id?: unknown;
      };
    };
  };
  return {
    openId: stringOrUndefined(event.sender?.sender_id?.open_id),
    userId: stringOrUndefined(event.sender?.sender_id?.user_id),
    unionId: stringOrUndefined(event.sender?.sender_id?.union_id),
    tenantKey: stringOrUndefined(event.sender?.tenant_key) ?? stringOrUndefined(event.tenant_key),
  };
}

function mergeIdentity(existing: RouteIdentityRecord | undefined, next: RouteIdentityRecord): RouteIdentityRecord {
  return {
    ...existing,
    ...dropUndefinedIdentity(next),
  };
}

function dropUndefinedIdentity(value: RouteIdentityRecord): RouteIdentityRecord {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as RouteIdentityRecord;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRunPolicy(value: unknown): value is CodexRunPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as { permissionMode?: unknown; sandbox?: unknown };
  if (policy.permissionMode !== "approval" && policy.permissionMode !== "full") return false;
  return policy.sandbox === undefined
    || policy.sandbox === "read-only"
    || policy.sandbox === "workspace-write"
    || policy.sandbox === "danger-full-access";
}

function normalizeRoutePolicy(value: RouteRecord["policy"]): RouteRecord["policy"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const contextRefresh = normalizeContextRefreshPolicy(value.contextRefresh);
  const next: RouteRecord["policy"] = {
    unboundRoute: typeof value.unboundRoute === "string" ? value.unboundRoute : undefined,
    progressMode: typeof value.progressMode === "string" ? value.progressMode : undefined,
    contextRefresh,
  };
  return Object.values(next).some((item) => item !== undefined) ? next : undefined;
}

function normalizeGroupAccessRecord(value: unknown): GroupAccessRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<GroupAccessRecord>;
  if (!record.routeKey || !record.channelId || !record.accountId || record.conversationKind !== "group" || !record.conversationId) return undefined;
  const now = new Date(0).toISOString();
  return {
    routeKey: record.routeKey,
    channelId: record.channelId,
    accountId: record.accountId,
    conversationKind: "group",
    conversationId: record.conversationId,
    superAdmin: normalizeGroupPrincipal(record.superAdmin),
    blockedSenders: Array.isArray(record.blockedSenders)
      ? record.blockedSenders.map(normalizeGroupPrincipal).filter((principal): principal is NonNullable<GroupAccessRecord["superAdmin"]> => Boolean(principal))
      : [],
    knownPrincipals: Array.isArray(record.knownPrincipals)
      ? record.knownPrincipals.map(normalizeKnownGroupPrincipal).filter((principal): principal is NonNullable<GroupAccessRecord["knownPrincipals"]>[number] => Boolean(principal))
      : undefined,
    normalMessagePolicy: record.normalMessagePolicy === "mentioned_non_blocked" ? record.normalMessagePolicy : "mentioned_non_blocked",
    approvalPolicy: record.approvalPolicy === "any_non_blocked" ? "any_non_blocked" : "super_admin_only",
    managementPolicy: "super_admin_only",
    blockedUserBehavior: "silent",
    reservedRoles: Array.isArray(record.reservedRoles) ? record.reservedRoles.map(normalizeGroupRole).filter((role): role is NonNullable<GroupAccessRecord["reservedRoles"]>[number] => Boolean(role)) : undefined,
    createdAt: record.createdAt ?? now,
    updatedAt: record.updatedAt ?? record.createdAt ?? now,
  };
}

function normalizeGroupPrincipal(value: unknown): GroupAccessRecord["superAdmin"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const principal = value as GroupAccessRecord["superAdmin"];
  if (!principal?.senderId) return undefined;
  return {
    senderId: principal.senderId,
    displayName: stringOrUndefined(principal.displayName),
    source: principal.source === "command" || principal.source === "tui" ? principal.source : "pairing",
    createdBySenderId: stringOrUndefined(principal.createdBySenderId),
    createdAt: principal.createdAt ?? new Date(0).toISOString(),
  };
}

function normalizeKnownGroupPrincipal(value: unknown): NonNullable<GroupAccessRecord["knownPrincipals"]>[number] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const principal = value as NonNullable<GroupAccessRecord["knownPrincipals"]>[number];
  if (!principal.senderId) return undefined;
  return {
    senderId: principal.senderId,
    displayName: stringOrUndefined(principal.displayName),
    firstSeenAt: principal.firstSeenAt ?? new Date(0).toISOString(),
    lastSeenAt: principal.lastSeenAt ?? principal.firstSeenAt ?? new Date(0).toISOString(),
    source: principal.source === "pairing" || principal.source === "tui" ? principal.source : "message",
  };
}

function normalizeGroupRole(value: unknown): NonNullable<GroupAccessRecord["reservedRoles"]>[number] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const role = value as NonNullable<GroupAccessRecord["reservedRoles"]>[number];
  if (!role.roleId || !role.label) return undefined;
  return {
    roleId: role.roleId,
    label: role.label,
    members: Array.isArray(role.members)
      ? role.members.map(normalizeGroupPrincipal).filter((principal): principal is NonNullable<GroupAccessRecord["superAdmin"]> => Boolean(principal))
      : [],
    capabilities: role.capabilities && typeof role.capabilities === "object" ? { ...role.capabilities } : {},
    enabled: role.enabled !== false,
    createdAt: role.createdAt ?? new Date(0).toISOString(),
    updatedAt: role.updatedAt ?? role.createdAt ?? new Date(0).toISOString(),
  };
}

function isContextFingerprint(value: unknown): value is CodexSessionContextFingerprint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fingerprint = value as { sessionId?: unknown; detectedAt?: unknown; source?: unknown };
  return typeof fingerprint.sessionId === "string"
    && typeof fingerprint.detectedAt === "string"
    && (fingerprint.source === "sqlite"
      || fingerprint.source === "rollout"
      || fingerprint.source === "session_index"
      || fingerprint.source === "unknown");
}

function isSnapshotObservedBy(value: unknown): value is SessionContextSnapshotObservedBy {
  return value === "bind" || value === "resume" || value === "chat-codex-turn" || value === "external-refresh";
}

function cloneSessionContextSnapshot(record: SessionContextSnapshotRecord): SessionContextSnapshotRecord {
  return {
    ...record,
    fingerprint: { ...record.fingerprint },
  };
}

function emptyRoutesDocument(): RoutesDocument {
  return {
    schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    routes: [],
  };
}

function emptyOwnersDocument(): SessionOwnersDocument {
  return {
    schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    owners: [],
  };
}

function emptySessionPoliciesDocument(): SessionPoliciesDocument {
  return {
    schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    policies: [],
  };
}

function emptySessionContextSnapshotsDocument(): SessionContextSnapshotsDocument {
  return {
    schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    snapshots: [],
  };
}

function emptyPendingBindingsDocument(): PendingBindingsDocument {
  return {
    schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    pending: [],
  };
}

function emptyTrustedRoutesDocument(): TrustedRoutesDocument {
  return {
    schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    trustedRoutes: [],
  };
}

function emptyGroupAccessDocument(): GroupAccessDocument {
  return {
    schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    groups: [],
  };
}
