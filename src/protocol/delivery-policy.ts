export type ChannelTaskStartDelivery = "send" | "suppress";
export type ChannelProgressDelivery = "send" | "suppress" | "aggregate";
export type ChannelProgressCommandMode = "enabled" | "disabled";

export interface ChannelRefreshCommandPolicy {
  command: string;
  description: string;
  silent: boolean;
  replyText?: string;
}

export interface ChannelDeliveryPolicy {
  taskStart: ChannelTaskStartDelivery;
  progress: ChannelProgressDelivery;
  progressCommand: ChannelProgressCommandMode;
  progressDisabledMessage?: string;
  statusProgressLabel?: string;
  statusProgressDescription?: string;
  refreshCommands: readonly ChannelRefreshCommandPolicy[];
}

export const DEFAULT_CHANNEL_DELIVERY_POLICY: ChannelDeliveryPolicy = {
  taskStart: "send",
  progress: "send",
  progressCommand: "enabled",
  refreshCommands: [],
};

export function normalizeDeliveryCommandName(command: string): string {
  return command.trim().replace(/^\/+/, "").toLowerCase();
}

export function normalizeChannelDeliveryPolicy(policy: ChannelDeliveryPolicy | undefined): ChannelDeliveryPolicy {
  if (!policy) return DEFAULT_CHANNEL_DELIVERY_POLICY;
  return {
    ...DEFAULT_CHANNEL_DELIVERY_POLICY,
    ...policy,
    refreshCommands: policy.refreshCommands.map((command) => ({
      ...command,
      command: normalizeDeliveryCommandName(command.command),
    })),
  };
}
