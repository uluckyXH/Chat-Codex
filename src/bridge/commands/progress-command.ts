import type { ChannelMessage, ChannelTarget } from "../../protocol/channel.js";
import type { ChannelDeliveryPolicy } from "../../protocol/delivery-policy.js";
import type { ProgressDeliveryMode } from "../bridge-types.js";
import type { BridgeDelivery } from "../delivery.js";
import type { BridgeStatusText } from "../status-text.js";
import { parseProgressDeliveryMode } from "../formatters.js";
import { formatProgressModeChoices, isProgressModeAllowedByPolicy } from "../progress-modes.js";

export interface ProgressCommandOptions {
  delivery: BridgeDelivery;
  statusText: BridgeStatusText;
  setProgressMode(routeKey: string, mode: ProgressDeliveryMode): void;
  deliveryPolicyFor(message: ChannelMessage): ChannelDeliveryPolicy;
}

export async function handleProgressModeCommand(
  options: ProgressCommandOptions,
  message: ChannelMessage,
  target: ChannelTarget,
  rawMode: string | undefined,
): Promise<void> {
  const policy = options.deliveryPolicyFor(message);
  if (!rawMode) {
    await options.delivery.sendText(target, options.statusText.progressModeText(message.routeKey, policy));
    return;
  }
  const mode = parseProgressDeliveryMode(rawMode);
  if (!mode || !isProgressModeAllowedByPolicy(mode, policy)) {
    await options.delivery.sendText(target, progressModeErrorText(policy));
    return;
  }
  options.setProgressMode(message.routeKey, mode);
  await options.delivery.sendText(target, options.statusText.progressModeText(message.routeKey, policy));
}

function progressModeErrorText(policy: ChannelDeliveryPolicy): string {
  return `未知进度模式。可用值: ${formatProgressModeChoices(policy, ", ")}。`;
}
