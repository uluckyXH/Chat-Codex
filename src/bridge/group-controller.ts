import { describeGroupMutation } from "../group-access/service.js";
import { randomBytes } from "node:crypto";
import type { ChannelMessage, ChannelTarget } from "../protocol/channel.js";
import type { FeishuGroupMessageRaw } from "../channels/feishu/group/group-types.js";
import type { GroupAccessService, GroupMutation } from "../group-access/service.js";
import type { ApprovalManager } from "../approvals/approval-manager.js";
import type { ApprovalDecision } from "../approvals/types.js";
import { normalizeApprovalDecision } from "../approvals/approval-policy.js";
import type { CodexAdapter } from "../codex/types.js";
import type { BridgeDelivery } from "./delivery.js";

const BASIC = new Set(["help", "name", "whoami", "pair", "group", "grop"]);
const APPROVAL = new Set(["ok", "yes", "no", "approve", "deny", "reject"]);
const ADMIN = new Set(["status", "stop", "cancel", "sendfile"]);
const SUPER = new Set(["model", "permission", "permissions", "perm", "policy", "plan", "code", "default", "goal", "compact", "progress", "mode", "context-refresh", "ctx-refresh", "context", "ctx"]);
interface Confirmation { routeKey: string; actor: string; revision: number; expiresAt: number; mutation: GroupMutation }
export class BridgeGroupController {
  private readonly confirmations = new Map<string, Confirmation>();
  constructor(private readonly access: GroupAccessService, private readonly delivery: BridgeDelivery, private readonly onChange?: (routeKey: string) => void) {}
  commandDenied(message: ChannelMessage, name: string): string | undefined {
    if (BASIC.has(name) || APPROVAL.has(name)) return undefined;
    if (ADMIN.has(name) || SUPER.has(name)) {
      if (this.access.canManage(message.routeKey, message.sender.id, SUPER.has(name)).allowed) return undefined;
      return SUPER.has(name) ? "此群命令仅超级管理员可用。" : "此群命令仅超管和管理员可用。";
    }
    return "此命令暂不在群聊开放，请使用本机管理入口。审批请使用 /OK <编号> 或 /NO <编号>。";
  }
  help(message: ChannelMessage): string {
    const role = this.access.roleForSender(message.routeKey, message.sender.id);
    return ["飞书群聊：每次发言、命令和附件都需要 @Bot。", "先 /pair <配对码> 配对，再 /name 名称 登记。", "/help · /name · /whoami",
      "普通消息和附件由群成员共享；只处理已登记且未拉黑成员的输入。",
      this.access.canApprove(message).allowed ? "审批：/OK <编号> · /NO <编号>；多条待办必须指定编号。" : "当前审批仅超管和管理员可处理。",
      role === "admin" || role === "super_admin" ? "管理：/group admins · /group policy · /status · /stop · /cancel（群共享待处理项）· /sendfile 要求\n/group block|unblock <Open ID 或 @成员> · /group blocked" : undefined,
      role === "super_admin" ? "超管：/group admin add|remove <成员> · /group approval restricted|open\n/model · /permission · /plan · /code · /goal · /compact · /progress · /context-refresh" : undefined,
    ].filter(Boolean).join("\n");
  }
  async command(message: ChannelMessage, target: ChannelTarget, args: string[]): Promise<void> {
    try {
      const record = this.access.get(message.routeKey);
      if (!record) throw new Error("请先完成群配对。");
      const [verb, sub, ...rest] = args;
      if (!this.access.canManage(message.routeKey, message.sender.id).allowed) throw new Error("此操作仅有效的超管和管理员可用。");
      if (verb === "admins") {
        await this.delivery.sendText(target, [`超管：${record.superAdmin?.senderId ?? "未设置，请在本机修复"}`, `管理员：${record.admins?.map((p) => p.senderId).join("、") || "无"}`].join("\n")); return;
      }
      if (verb === "policy") { await this.delivery.sendText(target, `审批：${record.approvalPolicy === "any_non_blocked" ? "开放给未拉黑成员" : "超管和管理员"}；文件发送：超管和管理员；普通管理员只能拉黑普通成员。`); return; }

      if (verb === "blocked") { await this.delivery.sendText(target, record.blockedSenders.map((p) => `${p.displayName ?? "成员"} (${p.senderId})；封禁者 ${p.createdBySenderId ?? "未知"} (${p.blockedByRole ?? "unknown"})；${this.access.roleForSender(message.routeKey, message.sender.id) === "admin" && p.blockedByRole !== "admin" ? "仅超管/本机可解禁" : "可解禁"}${p.reason ? `；原因 ${p.reason}` : ""}`).join("\n") || "当前黑名单为空。"); return; }
      if (verb === "confirm") {
        const pending = this.confirmations.get(sub ?? "");
        if (!pending || pending.routeKey !== message.routeKey || pending.actor !== message.sender.id || Date.now() > pending.expiresAt) throw new Error("确认码无效或已过期，请重新发起操作。");
        this.confirmations.delete(sub!);
        this.access.mutate(message.routeKey, { kind: "sender", senderId: message.sender.id }, pending.mutation, pending.revision);
        this.onChange?.(message.routeKey);
        await this.delivery.sendText(target, "群权限已更新。"); return;
      }
      let mutation: GroupMutation;
      if (verb === "approval" && (sub === "restricted" || sub === "open")) {
        mutation = { action: "approval", policy: sub === "open" ? "any_non_blocked" : "admins_only" };
      } else if (verb === "admin" && (sub === "add" || sub === "remove")) {
        mutation = { action: sub === "add" ? "admin_add" : "admin_remove", target: this.target(message, rest.join(" ")) };
      } else if (verb === "block" || verb === "unblock") {
        mutation = { action: verb, target: this.target(message, [sub, ...rest].filter(Boolean).join(" ")) };
      } else throw new Error("用法：/group admins|policy|blocked；admin add|remove <成员>；block|unblock <成员>；approval restricted|open。");
      // Confirmation is bound to the actor, route and permission revision; mutation rechecks target rules.
      const role = this.access.roleForSender(message.routeKey, message.sender.id);
      if (["admin_add", "admin_remove", "approval"].includes(mutation.action) && role !== "super_admin") throw new Error("此操作仅超级管理员可用。");
      for (const [key, value] of this.confirmations) if (value.expiresAt < Date.now() || (value.routeKey === message.routeKey && value.actor === message.sender.id)) this.confirmations.delete(key);
      const token = randomBytes(4).toString("hex");
      this.confirmations.set(token, { routeKey: message.routeKey, actor: message.sender.id, revision: record.revision ?? 0, expiresAt: Date.now() + 60_000, mutation });
      await this.delivery.sendText(target, `待确认：${describeGroupMutation(mutation, record)}。\n请在 60 秒内 @Bot /group confirm ${token}；权限变化后须重新发起。`);
    } catch (error) {
      try { this.access.audit(message.routeKey, { actor: message.sender.id, action: "group_command", outcome: "denied" }); } catch { /* The requested mutation remains rejected. */ }
      const text = (error as NodeJS.ErrnoException)?.code ? "群权限保存失败，请在本机检查。" : error instanceof Error ? error.message : String(error);
      await this.delivery.sendText(target, text);
    }
  }
  private target(message: ChannelMessage, text: string): string {
    const mentions = (message.raw as FeishuGroupMessageRaw | undefined)?.chatCodex?.feishu?.group?.mentions ?? [];
    const people = mentions.filter((p) => !p.isBot && !p.isMentionAll);
    if (text.startsWith("@")) {
      if (people.length !== 1 || !people[0].openId) throw new Error("请只 @ 一位成员，或直接填写其 Open ID；不能按展示名授权。");
      return people[0].openId;
    }
    if (!/^ou_[A-Za-z0-9_-]+$/.test(text)) throw new Error("请填写完整 Open ID（ou_…），或 @ 一位成员。");
    return text;
  }
  async approve(message: ChannelMessage, args: string[], requested: ApprovalDecision, approvals: ApprovalManager, codex: CodexAdapter): Promise<string> {
    const access = this.access.canApprove(message);
    if (!access.allowed) {
      this.access.audit(message.routeKey, { actor: message.sender.id, action: "approval", outcome: "denied", target: args[0] });
      return access.reason === "missing_super_admin" ? "群超管缺失或无效，请在本机修复。" : "只有超管和管理员可以处理当前群审批。";
    }
    if (requested === "approve-session") return "群聊只支持单次审批，请使用 /OK <编号>。";
    const pendingList = approvals.list(message.routeKey);
    if (!args[0] && pendingList.length > 1) return `有多个待处理审批，请指定编号：${pendingList.map((p) => p.approvalKey).join("、")}`;
    const key = args[0] ?? pendingList[0]?.approvalKey;
    if (!key) return "当前没有待处理审批。";
    const pending = approvals.get(key);
    if (!pending || pending.routeKey !== message.routeKey) return "审批编号无效或不属于当前群。";
    if (pending.status !== "pending") return "该审批正在处理、已处理或结果待核实，请勿重复操作。";
    const decision = normalizeApprovalDecision(pending, requested);
    if (!decision) return "该审批不支持此处理方式。";
    if (this.access.roleForSender(message.routeKey, pending.requestedBy) === "blocked" && decision !== "cancel" && decision !== "deny") return "任务发起人已被拉黑，只能拒绝或取消遗留审批。";
    if (!codex.resolveApproval) return "当前 Codex 不支持审批回写，请在本机处理。";
    this.access.audit(message.routeKey, { actor: message.sender.id, action: "approval_attempt", target: key, outcome: "allowed", detail: `requester=${pending.requestedBy};decision=${decision}` });
    approvals.beginResolution(key, message.routeKey, decision, message.sender.id);
    let outcome: "resolved" | "pending" | "uncertain" = "resolved";
    try { await codex.resolveApproval(pending.adapterApprovalId ?? key, decision); }
    catch (error) { outcome = (error as { definitelyNotSent?: boolean })?.definitelyNotSent === true ? "pending" : "uncertain"; }
    approvals.finishResolution(key, outcome);
    let auditFailed = false;
    try {
      this.access.audit(message.routeKey, { actor: message.sender.id, action: "approval", target: key, outcome: outcome === "resolved" ? "allowed" : outcome === "pending" ? "failed" : "uncertain", detail: `requester=${pending.requestedBy};decision=${decision}` });
    } catch { auditFailed = true; }
    const text = outcome === "resolved" ? "审批已处理。" : outcome === "pending" ? "审批尚未发出，可重新尝试。" : "审批回写结果待核实，请在本机检查，暂不重复提交。";
    return auditFailed ? `${text} 本机审计保存失败，请检查状态目录。` : text;
  }
}
