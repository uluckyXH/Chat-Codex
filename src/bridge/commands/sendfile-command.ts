import type { ChannelMessage, ChannelTarget } from "../../protocol/channel.js";
import type { BridgeDelivery } from "../delivery.js";
import type { BridgeRouteQueue } from "../route-queue.js";
import { commandBody, withGroupConversationPromptPrefix } from "../formatters.js";

export interface SendFileCommandOptions {
  delivery: BridgeDelivery;
  routeQueue: BridgeRouteQueue;
}

export async function handleSendFileCommand(
  options: SendFileCommandOptions,
  message: ChannelMessage,
  target: ChannelTarget,
  rawText: string,
): Promise<void> {
  const prompt = commandBody(rawText, "sendfile");
  if (!prompt) {
    await options.delivery.sendText(target, [
      "缺少任务内容。",
      "用法: `/sendfile <你要 Codex 做什么，并在最终结果里发文件>`",
    ].join("\n"));
    return;
  }
  await options.routeQueue.enqueuePrompt(message, target, message.groupPolicy === "feishu" ? withGroupConversationPromptPrefix(message, prompt, "say") : prompt, { sendFile: true });
}
