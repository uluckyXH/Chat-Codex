import type { ApprovalDecision } from "../approvals/types.js";
import type { Logger } from "../logging/logger.js";
import type { ChannelMessage, ChannelTarget } from "../protocol/channel.js";
import type { ChannelDeliveryPolicy, ChannelRefreshCommandPolicy } from "../protocol/delivery-policy.js";
import { normalizeDeliveryCommandName } from "../protocol/delivery-policy.js";
import type { CodexCollaborationMode } from "../codex/types.js";
import { ROUTE_BUSY_MUTATION_REJECT_TEXT } from "./bridge-types.js";
import { isRouteBusyMutationCommand } from "./formatters.js";
import type { BridgeDelivery } from "./delivery.js";

export interface BridgeCommandHandlers {
  help(message: ChannelMessage): string;
  createNewSession(message: ChannelMessage, target: ChannelTarget, args: string[], rawText: string): Promise<unknown>;
  status(message: ChannelMessage): Promise<string>;
  sessions(message: ChannelMessage, args: string[], commandName: string): Promise<string>;
  resumeOrUseSession(message: ChannelMessage, target: ChannelTarget, sessionRef: string | undefined): Promise<void>;
  cancel(message: ChannelMessage, target: ChannelTarget): Promise<void>;
  whoami(message: ChannelMessage): string;
  debug(message: ChannelMessage): Promise<string>;
  collaborationMode(
    message: ChannelMessage,
    target: ChannelTarget,
    mode: CodexCollaborationMode,
    rawText: string,
    commandName: string,
  ): Promise<void>;
  goal(message: ChannelMessage, target: ChannelTarget, rawText: string): Promise<void>;
  progressMode(message: ChannelMessage, target: ChannelTarget, rawMode: string | undefined): Promise<void>;
  contextRefresh(message: ChannelMessage, target: ChannelTarget, rawMode: string | undefined): Promise<void>;
  groupReceive(message: ChannelMessage, target: ChannelTarget, args: string[], commandName: string): Promise<void>;
  groupName(message: ChannelMessage, target: ChannelTarget, args: string[]): Promise<void>;
  sendFile(message: ChannelMessage, target: ChannelTarget, rawText: string): Promise<void>;
  model(message: ChannelMessage, target: ChannelTarget, args: string[]): Promise<void>;
  permission(message: ChannelMessage, target: ChannelTarget, args: string[]): Promise<void>;
  approval(message: ChannelMessage, target: ChannelTarget, args: string[], decision: ApprovalDecision): Promise<void>;
  stop(message: ChannelMessage, target: ChannelTarget): Promise<void>;
  compact(message: ChannelMessage, target: ChannelTarget, args: string[]): Promise<void>;
}

export interface BridgeCommandRouterOptions {
  logger: Logger;
  delivery: BridgeDelivery;
  deliveryPolicyFor(message: ChannelMessage | undefined): ChannelDeliveryPolicy;
  isRouteExecutionBusy(routeKey: string): Promise<boolean>;
  handlers: BridgeCommandHandlers;
}

export class BridgeCommandRouter {
  private readonly logger: Logger;
  private readonly delivery: BridgeDelivery;
  private readonly deliveryPolicyFor: BridgeCommandRouterOptions["deliveryPolicyFor"];
  private readonly isRouteExecutionBusy: BridgeCommandRouterOptions["isRouteExecutionBusy"];
  private readonly handlers: BridgeCommandHandlers;

  constructor(options: BridgeCommandRouterOptions) {
    this.logger = options.logger;
    this.delivery = options.delivery;
    this.deliveryPolicyFor = options.deliveryPolicyFor;
    this.isRouteExecutionBusy = options.isRouteExecutionBusy;
    this.handlers = options.handlers;
  }

  async handle(
    message: ChannelMessage,
    target: ChannelTarget,
    name: string,
    args: string[],
    rawText: string,
  ): Promise<void> {
    const deliveryPolicy = this.deliveryPolicyFor(message);
    const refreshCommand = refreshCommandFor(deliveryPolicy, name);
    if (refreshCommand) {
      this.logger.info("channel refresh command received", {
        channel: message.channelId,
        command: refreshCommand.command,
        routeKey: message.routeKey,
      });
      if (!refreshCommand.silent) {
        await this.delivery.sendText(target, refreshCommand.replyText ?? "已刷新。");
      }
      return;
    }
    if (isRouteBusyMutationCommand(name, args, rawText) && await this.isRouteExecutionBusy(message.routeKey)) {
      await this.delivery.sendText(target, ROUTE_BUSY_MUTATION_REJECT_TEXT);
      return;
    }
    switch (name) {
      case "help":
        await this.delivery.sendText(target, this.handlers.help(message));
        return;
      case "new":
        await this.handlers.createNewSession(message, target, args, rawText);
        return;
      case "status":
        await this.delivery.sendText(target, await this.handlers.status(message));
        return;
      case "session":
      case "sessions":
        await this.delivery.sendText(target, await this.handlers.sessions(message, args, name));
        return;
      case "all-sessions":
        await this.delivery.sendText(target, await this.handlers.sessions(message, args, name));
        return;
      case "use":
      case "resume":
        await this.handlers.resumeOrUseSession(message, target, args[0]);
        return;
      case "cancel":
        await this.handlers.cancel(message, target);
        return;
      case "whoami":
        await this.delivery.sendText(target, this.handlers.whoami(message));
        return;
      case "debug":
        await this.delivery.sendText(target, await this.handlers.debug(message));
        return;
      case "plan":
        await this.handlers.collaborationMode(message, target, "plan", rawText, name);
        return;
      case "code":
      case "default":
        await this.handlers.collaborationMode(message, target, "default", rawText, name);
        return;
      case "goal":
        await this.handlers.goal(message, target, rawText);
        return;
      case "progress":
      case "mode":
        if (deliveryPolicy.progressCommand === "disabled") {
          await this.delivery.sendText(target, deliveryPolicy.progressDisabledMessage ?? "当前渠道已禁用进度投递，/progress 不可用。");
          return;
        }
        await this.handlers.progressMode(message, target, args[0]);
        return;
      case "context-refresh":
      case "ctx-refresh":
      case "context":
      case "ctx":
        await this.handlers.contextRefresh(message, target, args[0]);
        return;
      case "group":
      case "grop":
        await this.handlers.groupReceive(message, target, args, name);
        return;
      case "name":
        await this.handlers.groupName(message, target, args);
        return;
      case "sendfile":
        await this.handlers.sendFile(message, target, rawText);
        return;
      case "model":
        await this.handlers.model(message, target, args);
        return;
      case "permission":
      case "permissions":
      case "perm":
      case "policy":
        await this.handlers.permission(message, target, args);
        return;
      case "ok":
      case "yes":
        await this.handlers.approval(message, target, [], "approve");
        return;
      case "p":
      case "yes-session":
      case "ok-session":
      case "approve-session":
        await this.handlers.approval(message, target, args, "approve-session");
        return;
      case "no":
        await this.handlers.approval(message, target, [], "deny");
        return;
      case "approve":
        await this.handlers.approval(message, target, args, "approve");
        return;
      case "deny":
      case "reject":
        await this.handlers.approval(message, target, args, "deny");
        return;
      case "stop":
        await this.handlers.stop(message, target);
        return;
      case "compact":
        await this.handlers.compact(message, target, args);
        return;
      default:
        await this.delivery.sendText(target, `未知命令: /${name}\n发送 /help 查看可用命令。`);
    }
  }
}

function refreshCommandFor(
  policy: ChannelDeliveryPolicy,
  commandName: string,
): ChannelRefreshCommandPolicy | undefined {
  const normalized = normalizeDeliveryCommandName(commandName);
  return policy.refreshCommands.find((command) => normalizeDeliveryCommandName(command.command) === normalized);
}
