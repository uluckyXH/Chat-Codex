import { randomBytes } from "node:crypto";
import type { ApprovalDecision, ApprovalRequest, PendingApproval } from "./types.js";
import {
  availableApprovalDecisions,
  formatApprovalCommandForDisplay,
  formatTerminalInputForDisplay,
} from "./approval-policy.js";

export interface ApprovalManagerOptions {
  ttlMs?: number | null;
}

export class ApprovalManager {
  private readonly approvals = new Map<string, PendingApproval>();
  private sequence = 0;
  private readonly ttlMs?: number;

  constructor(options: ApprovalManagerOptions = {}) {
    this.ttlMs = typeof options.ttlMs === "number" ? options.ttlMs : undefined;
  }

  create(routeKey: string, requestedBy: string, request: ApprovalRequest, scoped = false): PendingApproval {
    const now = new Date();
    const approvalKey = scoped ? `g${randomBytes(6).toString("hex")}` : this.nextKey();
    const pending: PendingApproval = {
      ...request,
      approvalKey,
      routeKey,
      requestedBy,
      requestedAt: now.toISOString(),
      ...(this.ttlMs !== undefined ? { expiresAt: new Date(now.getTime() + this.ttlMs).toISOString() } : {}),
      status: "pending",
    };
    this.approvals.set(approvalKey, pending);
    return pending;
  }

  list(routeKey?: string): PendingApproval[] {
    this.expireOld();
    return [...this.approvals.values()].filter((approval) => {
      if (approval.status !== "pending") return false;
      return routeKey ? approval.routeKey === routeKey : true;
    });
  }

  get(approvalKey: string): PendingApproval | undefined {
    this.expireOld();
    return this.approvals.get(approvalKey);
  }

  latest(routeKey: string): PendingApproval | undefined {
    return this.list(routeKey).at(-1);
  }

  decide(approvalKey: string, routeKey: string, decision: ApprovalDecision): PendingApproval {
    this.expireOld();
    const pending = this.approvals.get(approvalKey);
    if (!pending) {
      throw new Error(`未找到审批请求: ${approvalKey}`);
    }
    if (pending.routeKey !== routeKey) {
      throw new Error(`审批请求 ${approvalKey} 不属于当前会话`);
    }
    if (pending.status !== "pending") {
      throw new Error(`审批请求 ${approvalKey} 已处理`);
    }
    if (!availableApprovalDecisions(pending).includes(decision)) {
      throw new Error("该审批不支持此处理方式。");
    }
    pending.status = "resolved";
    pending.decision = decision;
    this.approvals.set(approvalKey, pending);
    return pending;
  }

  beginResolution(key: string, routeKey: string, decision: ApprovalDecision, actor: string): PendingApproval {
    const pending = this.decide(key, routeKey, decision);
    pending.status = "resolving";
    pending.resolvedBy = actor;
    return pending;
  }

  finishResolution(key: string, outcome: "resolved" | "uncertain" | "pending"): void {
    const pending = this.approvals.get(key);
    if (!pending || pending.status === "resolved") return;
    pending.status = outcome;
    if (outcome === "resolved") pending.resolvedAt = new Date().toISOString();
    if (outcome === "pending") { pending.decision = undefined; pending.resolvedBy = undefined; }
  }

  formatForGroup(pending: PendingApproval): string {
    return [`审批编号: ${pending.approvalKey}`, ...this.formatForChannel(pending).split("\n")
      .filter((line) => !line.startsWith("/P "))
      .map((line) => line.replace(/^\/(OK|NO) /, `/$1 ${pending.approvalKey} `))].join("\n");
  }

  cancelRoute(routeKey: string, reason?: string): PendingApproval[] {
    this.expireOld();
    return this.cancelPending((pending) => pending.routeKey === routeKey, reason);
  }

  cancelTurn(routeKey: string, sessionId: string, turnId: string, reason?: string): PendingApproval[] {
    this.expireOld();
    return this.cancelPending(
      (pending) => pending.routeKey === routeKey && pending.sessionId === sessionId && pending.turnId === turnId,
      reason,
    );
  }

  private cancelPending(predicate: (pending: PendingApproval) => boolean, reason?: string): PendingApproval[] {
    const cancelled: PendingApproval[] = [];
    for (const pending of this.approvals.values()) {
      if (!predicate(pending) || pending.status !== "pending") continue;
      pending.status = "resolved";
      pending.decision = "cancel";
      pending.decisionReason = reason?.trim() || undefined;
      this.approvals.set(pending.approvalKey, pending);
      cancelled.push(pending);
    }
    return cancelled;
  }

  resolveAdapterApproval(routeKey: string, adapterApprovalId: string, reason?: string): PendingApproval | undefined {
    this.expireOld();
    for (const pending of this.approvals.values()) {
      if (pending.routeKey !== routeKey) continue;
      if (!["pending", "resolving", "uncertain"].includes(pending.status)) continue;
      if (pending.adapterApprovalId !== adapterApprovalId) continue;
      pending.status = "resolved";
      pending.decisionReason = reason?.trim() || undefined;
      this.approvals.set(pending.approvalKey, pending);
      return pending;
    }
    return undefined;
  }

  formatForChannel(pending: PendingApproval): string {
    const command = formatApprovalCommandForDisplay(pending);
    const decisions = availableApprovalDecisions(pending);
    if (pending.kind === "terminal_input") {
      const lines = [
        "Codex 请求终端输入审批",
        "类型: 终端输入（不会启动新命令）",
      ];
      if (pending.environmentId) lines.push(`执行环境: ${pending.environmentId}`);
      if (pending.reason) lines.push(`原因: ${pending.reason}`);
      if (pending.terminalId && pending.terminalInput !== undefined) {
        lines.push(`目标终端: ${pending.terminalId}`);
        lines.push(`输入: ${formatTerminalInputForDisplay(pending.terminalInput)}`);
      } else if (command) {
        lines.push("原始终端输入请求:", command);
      }
      if (pending.cwd) lines.push(`CWD: ${pending.cwd}`);
      lines.push(`Session: ${shortId(pending.sessionId)}`);
      lines.push(`Turn: ${shortId(pending.turnId)}`);
      if (pending.risk) lines.push(`风险: ${pending.risk}`);
      lines.push("", "快捷回复:");
      if (decisions.includes("approve")) lines.push("/OK 本次允许向终端输入");
      if (decisions.includes("cancel")) lines.push("/NO 取消输入并中止当前任务");
      return lines.join("\n");
    }
    const lines = [
      "Codex 请求审批",
      `类型: ${pending.kind}`,
    ];
    if (pending.environmentId) lines.push(`执行环境: ${pending.environmentId}`);
    if (pending.reason) lines.push(`原因: ${pending.reason}`);
    if (command) lines.push("将执行的命令:", command);
    if (pending.cwd) lines.push(`CWD: ${pending.cwd}`);
    lines.push(`Session: ${shortId(pending.sessionId)}`);
    lines.push(`Turn: ${shortId(pending.turnId)}`);
    if (pending.risk) lines.push(`风险: ${pending.risk}`);
    lines.push("", "快捷回复:");
    if (decisions.includes("approve")) lines.push("/OK 通过当前审批");
    if (decisions.includes("approve-session")) lines.push("/P 本会话通过，后续同类操作尽量不再询问");
    if (decisions.includes("deny")) lines.push("/NO 拒绝当前审批");
    else if (decisions.includes("cancel")) lines.push("/NO 取消当前审批");
    return lines.join("\n");
  }

  private expireOld(): void {
    if (this.ttlMs === undefined) return;
    const now = Date.now();
    for (const approval of this.approvals.values()) {
      if (approval.status === "pending" && approval.expiresAt && Date.parse(approval.expiresAt) <= now) {
        approval.status = "expired";
        this.approvals.set(approval.approvalKey, approval);
      }
    }
  }

  private nextKey(): string {
    this.sequence += 1;
    return `a${this.sequence.toString(36).padStart(3, "0")}`;
  }
}

function shortId(id: string): string {
  return id.length <= 12 ? id : id.slice(0, 12);
}
