import type { ChannelMessage, ChannelTarget } from "../../protocol/channel.js";
import type { MemoryStateStore } from "../../state/memory-state-store.js";
import { FeishuGroupMemberRegistry, sanitizeFeishuGroupDisplayName, validateFeishuGroupDisplayName, type FeishuGroupMemberRef } from "../../channels/feishu/group/group-member-registry.js";
import { groupSenderRole } from "../../group-access/policy.js";
import type { BridgeDelivery } from "../delivery.js";

export interface GroupNameCommandDeps {
  delivery: BridgeDelivery;
  registry: FeishuGroupMemberRegistry;
  state: MemoryStateStore;
}

export async function handleGroupNameCommand(
  deps: GroupNameCommandDeps,
  message: ChannelMessage,
  target: ChannelTarget,
  args: string[],
): Promise<void> {
  const ref = feishuGroupMemberRefFromMessage(message);
  if (!ref) {
    await deps.delivery.sendText(target, "当前命令只支持飞书群聊。");
    return;
  }
  const rawName = args.join(" ");
  if (!rawName.trim()) {
    await deps.delivery.sendText(target, formatFeishuGroupMemberStatus(message, deps.registry, deps.state));
    return;
  }
  const displayName = sanitizeFeishuGroupDisplayName(rawName);
  const error = validateFeishuGroupDisplayName(displayName);
  if (error) {
    await deps.delivery.sendText(target, [
      `名称设置失败：${error}`,
      "用法：@Bot /name 小黄",
    ].join("\n"));
    return;
  }
  const member = deps.registry.setDisplayName({ ...ref, displayName });
  await deps.delivery.sendText(target, [
    `已记录你在当前群的展示名：${member.displayName}`,
    "后续 @Bot 发送普通消息时，会以这个名称进入 Codex 上下文。",
  ].join("\n"));
}

export function formatFeishuGroupWhoami(
  message: ChannelMessage,
  registry: FeishuGroupMemberRegistry,
  state: MemoryStateStore,
): string {
  const ref = feishuGroupMemberRefFromMessage(message);
  if (!ref) return "当前命令只支持飞书群聊。";
  const member = registry.getMember(ref);
  const access = state.getGroupAccess(message.routeKey);
  return [
    "**飞书群员身份**",
    `- 群聊: \`${ref.chatId}\``,
    `- Open ID: \`${maskIdentifier(ref.openId)}\``,
    `- 展示名: ${member?.displayName ? `\`${member.displayName}\`` : "未登记"}`,
    `- 成员登记: ${member?.displayName ? "已完成" : "未完成"}`,
    `- 群配对: ${state.isRouteTrusted(message.routeKey) ? "已配对" : "未配对"}`,
    `- 群角色: ${formatGroupRole(groupSenderRole(access, ref.openId), state.isRouteTrusted(message.routeKey))}`,
    `- 审批策略: ${formatApprovalPolicy(access?.approvalPolicy)}`,
  ].join("\n");
}

export function formatFeishuGroupMemberStatus(
  message: ChannelMessage,
  registry: FeishuGroupMemberRegistry,
  state: MemoryStateStore,
): string {
  const ref = feishuGroupMemberRefFromMessage(message);
  if (!ref) return "当前命令只支持飞书群聊。";
  const member = registry.getMember(ref);
  const access = state.getGroupAccess(message.routeKey);
  return [
    "**飞书群成员登记**",
    `- 当前状态: ${member?.displayName ? `已登记为 \`${member.displayName}\`` : "未登记"}`,
    `- Open ID: \`${maskIdentifier(ref.openId)}\``,
    `- 群配对: ${state.isRouteTrusted(message.routeKey) ? "已配对" : "未配对"}`,
    `- 群角色: ${formatGroupRole(groupSenderRole(access, ref.openId), state.isRouteTrusted(message.routeKey))}`,
    "",
    "设置展示名：@Bot /name 小黄",
  ].join("\n");
}

export function feishuGroupMemberRefFromMessage(message: ChannelMessage): FeishuGroupMemberRef | undefined {
  if (!isFeishuGroupMessage(message)) return undefined;
  return {
    channelId: message.channelId,
    accountId: message.accountId ?? "default",
    chatId: message.conversation.id,
    openId: message.sender.id,
  };
}

export function isFeishuGroupMessage(message: ChannelMessage | undefined): boolean {
  return Boolean(message)
    && message?.conversation.kind === "group"
    && isFeishuChannelId(message.channelId);
}

export function isFeishuGroupPreTrustCommand(name: string | undefined): boolean {
  return name === "help" || name === "name" || name === "whoami";
}

export function isFeishuGroupRegistrationFreeCommand(name: string | undefined): boolean {
  return name === "help" || name === "name" || name === "whoami";
}

export function feishuGroupRegistrationRequiredText(): string {
  return [
    "我还不知道你在这个群里的展示名。请先发送：",
    "@Bot /name 小黄",
    "登记后再继续对话。",
  ].join("\n");
}

function isFeishuChannelId(channelId: string): boolean {
  return channelId === "feishu" || channelId.startsWith("feishu-") || channelId === "lark" || channelId.startsWith("lark-");
}

function maskIdentifier(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatGroupRole(role: ReturnType<typeof groupSenderRole>, trusted: boolean): string {
  if (!trusted) return "未配对";
  if (role === "super_admin") return "超级管理员";
  if (role === "blocked") return "小黑屋";
  if (role === "unconfigured") return "未初始化";
  return "普通成员";
}

function formatApprovalPolicy(policy: string | undefined): string {
  if (!policy) return "未初始化";
  if (policy === "any_non_blocked") return "开放审批";
  return "仅超级管理员";
}
