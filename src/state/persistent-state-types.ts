import type { ConversationKind } from "../protocol/channel.js";
import type { CodexRunPolicy } from "../codex/codex-cli.js";
import type { CodexSessionContextFingerprint } from "../codex/session-context-fingerprint.js";
import type { ContextRefreshPolicy } from "../context-refresh/types.js";

export const LOCAL_STATE_SCHEMA_VERSION = 1;

export interface RouteIdentityRecord {
  lastSenderId?: string;
  lastSenderDisplayName?: string;
  openId?: string;
  userId?: string;
  unionId?: string;
  tenantKey?: string;
}

export interface RoutePolicyRecord {
  unboundRoute?: string;
  progressMode?: string;
  contextRefresh?: ContextRefreshPolicy;
}

export interface RouteRecord {
  routeKey: string;
  channelId: string;
  channelType?: string;
  accountId: string;
  conversationKind: ConversationKind;
  conversationId: string;
  activeSessionId?: string;
  displayName?: string;
  identity?: RouteIdentityRecord;
  policy?: RoutePolicyRecord;
  lastSeenAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoutesDocument {
  schemaVersion: number;
  updatedAt: string;
  routes: RouteRecord[];
}

export interface SessionOwnerRecord {
  sessionId: string;
  ownerRouteKey: string;
  claimedAt: string;
  updatedAt: string;
}

export interface SessionOwnersDocument {
  schemaVersion: number;
  updatedAt: string;
  owners: SessionOwnerRecord[];
}

export interface SessionPolicyRecord {
  sessionId: string;
  runPolicy: CodexRunPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface SessionPoliciesDocument {
  schemaVersion: number;
  updatedAt: string;
  policies: SessionPolicyRecord[];
}

export type SessionContextSnapshotObservedBy =
  | "bind"
  | "resume"
  | "chat-codex-turn"
  | "external-refresh";

export interface SessionContextSnapshotRecord {
  sessionId: string;
  fingerprint: CodexSessionContextFingerprint;
  observedBy: SessionContextSnapshotObservedBy;
  createdAt: string;
  updatedAt: string;
}

export interface SessionContextSnapshotsDocument {
  schemaVersion: number;
  updatedAt: string;
  snapshots: SessionContextSnapshotRecord[];
}

export type PendingSessionBinding =
  | { type: "existing"; sessionId: string }
  | { type: "new" };

export interface PendingBindingRecord {
  id: string;
  channelId: string;
  accountId: string;
  conversationKind: ConversationKind;
  conversationId?: string;
  label?: string;
  binding: PendingSessionBinding;
  createdAt: string;
  updatedAt: string;
}

export interface PendingBindingsDocument {
  schemaVersion: number;
  updatedAt: string;
  pending: PendingBindingRecord[];
}

export interface TrustedRouteRecord {
  routeKey: string;
  channelId: string;
  accountId: string;
  conversationKind: ConversationKind;
  conversationId: string;
  displayName?: string;
  trustedAt: string;
  trustedBySenderId: string;
  trustedBySenderDisplayName?: string;
  trustMethod: "pairing_code" | "manual";
  lastSeenAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TrustedRoutesDocument {
  schemaVersion: number;
  updatedAt: string;
  trustedRoutes: TrustedRouteRecord[];
}

export type GroupPrincipalSource = "pairing" | "command" | "tui";

export interface GroupPrincipal {
  senderId: string;
  displayName?: string;
  source: GroupPrincipalSource;
  createdBySenderId?: string;
  createdAt: string;
}

export interface KnownGroupPrincipal {
  senderId: string;
  displayName?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  source: "message" | "pairing" | "tui";
}

export interface GroupRoleRecord {
  roleId: string;
  label: string;
  members: GroupPrincipal[];
  capabilities: {
    canApprove?: boolean;
    canBlock?: boolean;
    canManageAdmins?: boolean;
    canViewAudit?: boolean;
  };
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type GroupNormalMessagePolicy = "mentioned_non_blocked";
export type GroupApprovalPolicy = "super_admin_only" | "any_non_blocked";
export type GroupManagementPolicy = "super_admin_only";
export type GroupBlockedUserBehavior = "silent";

export interface GroupAccessRecord {
  routeKey: string;
  channelId: string;
  accountId: string;
  conversationKind: "group";
  conversationId: string;
  superAdmin?: GroupPrincipal;
  blockedSenders: GroupPrincipal[];
  knownPrincipals?: KnownGroupPrincipal[];
  normalMessagePolicy: GroupNormalMessagePolicy;
  approvalPolicy: GroupApprovalPolicy;
  managementPolicy: GroupManagementPolicy;
  blockedUserBehavior: GroupBlockedUserBehavior;
  reservedRoles?: GroupRoleRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface GroupAccessDocument {
  schemaVersion: number;
  updatedAt: string;
  groups: GroupAccessRecord[];
}

export interface ChannelInstanceRecord {
  id: string;
  type: string;
  enabled: boolean;
  stateDir: string;
  defaultAccountId?: string;
  displayName?: string;
  credentialSource?: string;
  capabilityOverrides?: {
    group?: boolean;
    thread?: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export interface BridgeConfigDocument {
  schemaVersion: number;
  updatedAt: string;
  channels: ChannelInstanceRecord[];
  codexDefaults?: {
    adapter?: string;
    permission?: string;
    progressMode?: string;
    maxConcurrentTurns?: number | null;
    independentMode?: {
      contextRefresh?: ContextRefreshPolicy;
    };
  };
}

export interface ChannelInstanceDocument extends ChannelInstanceRecord {
  schemaVersion: number;
}

export interface ChannelAccountDocument {
  schemaVersion: number;
  channelId: string;
  channelType: string;
  accountId: string;
  credentialSource?: string;
  metadata?: Record<string, unknown>;
  updatedAt: string;
}

export interface ChannelAccountCredentialsDocument {
  schemaVersion: number;
  channelId: string;
  channelType: string;
  accountId: string;
  credentials: Record<string, string>;
  updatedAt: string;
}
