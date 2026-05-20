import type { ChannelMessage } from "../protocol/channel.js";
import type { MemoryStateStore } from "../state/memory-state-store.js";
import type { TrustedRouteRecord } from "../state/persistent-state-types.js";
import { groupAccessRecordFromTrustedRoute } from "./defaults.js";
import { groupSenderRole, isGroupSenderBlocked, canApproveGroup, type GroupCapabilityDecision, type GroupSenderRole } from "./policy.js";
import { upsertKnownGroupPrincipal } from "./principal.js";
import type { GroupAccessRecord } from "./types.js";

export interface GroupAccessServiceOptions {
  state: MemoryStateStore;
  now?: () => Date;
}

export class GroupAccessService {
  private readonly state: MemoryStateStore;
  private readonly now: () => Date;

  constructor(options: GroupAccessServiceOptions) {
    this.state = options.state;
    this.now = options.now ?? (() => new Date());
  }

  ensureForTrustedRoute(route: TrustedRouteRecord): GroupAccessRecord | undefined {
    const timestamp = this.now().toISOString();
    const existing = this.state.getGroupAccess(route.routeKey);
    const next = groupAccessRecordFromTrustedRoute(route, timestamp, existing);
    return next ? this.state.upsertGroupAccess(next) : undefined;
  }

  ensureForTrustedGroupMessage(message: ChannelMessage): GroupAccessRecord | undefined {
    if (message.conversation.kind !== "group") return undefined;
    const trusted = this.state.getTrustedRoute(message.routeKey);
    if (!trusted) return undefined;
    const access = this.ensureForTrustedRoute(trusted);
    return access ? this.recordKnownPrincipal(message, access) : undefined;
  }

  recordKnownPrincipal(message: ChannelMessage, record = this.state.getGroupAccess(message.routeKey)): GroupAccessRecord | undefined {
    if (!record || message.conversation.kind !== "group") return record;
    const timestamp = message.timestamp || this.now().toISOString();
    return this.state.upsertGroupAccess({
      ...record,
      knownPrincipals: upsertKnownGroupPrincipal(record.knownPrincipals, {
        senderId: message.sender.id,
        displayName: message.sender.displayName,
        source: "message",
        seenAt: timestamp,
      }),
      updatedAt: timestamp,
    });
  }

  isSenderBlocked(message: ChannelMessage): boolean {
    return isGroupSenderBlocked(this.state.getGroupAccess(message.routeKey), message.sender.id);
  }

  roleForSender(routeKey: string, senderId: string): GroupSenderRole {
    return groupSenderRole(this.state.getGroupAccess(routeKey), senderId);
  }

  canApprove(message: ChannelMessage): GroupCapabilityDecision {
    return canApproveGroup(this.state.getGroupAccess(message.routeKey), message.sender.id);
  }
}
