import type { ChannelDeliveryPolicy } from "../protocol/delivery-policy.js";
import type { ProgressDeliveryMode } from "./bridge-types.js";

const DEFAULT_ALLOWED_PROGRESS_MODES: readonly ProgressDeliveryMode[] = ["silent", "brief"];

export function isProgressModeAllowedByPolicy(
  mode: ProgressDeliveryMode,
  policy: ChannelDeliveryPolicy,
): boolean {
  if (!configuredProgressModes(policy).includes(mode)) return false;
  if (mode === "silent") return true;
  if (mode === "tools") return policy.toolProgress === "send";
  if (mode === "realtime") return policy.progress !== "suppress" && policy.realtimeProgress !== "suppress";
  if (mode === "detailed") return policy.progress !== "suppress";
  if (mode === "brief") return policy.progress !== "suppress";
  return policy.progress !== "suppress";
}

export function progressModesForPolicy(policy: ChannelDeliveryPolicy): ProgressDeliveryMode[] {
  const modes = configuredProgressModes(policy).filter((mode) => isProgressModeAllowedByPolicy(mode, policy));
  return modes.length > 0 ? modes : ["silent"];
}

export function formatProgressModeChoices(policy: ChannelDeliveryPolicy, separator: string): string {
  return progressModesForPolicy(policy).join(separator);
}

export function fallbackProgressModeForPolicy(policy: ChannelDeliveryPolicy): ProgressDeliveryMode {
  const [first] = progressModesForPolicy(policy);
  return first ?? "silent";
}

function configuredProgressModes(policy: ChannelDeliveryPolicy): ProgressDeliveryMode[] {
  const source = policy.allowedProgressModes ?? DEFAULT_ALLOWED_PROGRESS_MODES;
  return source.filter(isKnownProgressMode);
}

function isKnownProgressMode(value: string): value is ProgressDeliveryMode {
  return value === "brief" || value === "detailed" || value === "realtime" || value === "tools" || value === "silent";
}
