import type { ChannelMessage, ChannelTarget } from "../../protocol/channel.js";
import {
  extractNewAppChatPrompt,
  isNewAppChatCommand,
} from "../app-conversation.js";
import type { BridgeRouteQueue } from "../route-queue.js";
import type { BridgeRouteSteering } from "../route-steering.js";
import type { BridgeSessionFlow } from "../session-flow.js";

export interface NewSessionCommandOptions {
  sessionFlow: BridgeSessionFlow;
  routeQueue: BridgeRouteQueue;
  routeSteering: BridgeRouteSteering;
}

export async function handleNewSessionCommand(
  options: NewSessionCommandOptions,
  message: ChannelMessage,
  target: ChannelTarget,
  args: string[],
  rawText: string,
): Promise<void> {
  if (!isNewAppChatCommand(args)) {
    await options.sessionFlow.createNewSession(message, target);
    return;
  }

  const firstPrompt = extractNewAppChatPrompt(rawText);
  await options.sessionFlow.createNewAppChatSession(message, target, {
    firstPrompt: firstPrompt || undefined,
  });
  if (!firstPrompt) return;

  if (await options.routeSteering.tryEnqueue(message, target, firstPrompt)) return;
  await options.routeQueue.enqueuePrompt(message, target, firstPrompt);
}
