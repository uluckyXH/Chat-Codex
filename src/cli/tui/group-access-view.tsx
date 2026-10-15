import { groupSenderRole } from "../../group-access/policy.js";
import { formatLocalDateTime } from "../../time/display-time.js";
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import type { LauncherActions } from "../actions/launcher-actions.js";
import { describeGroupMutation, type GroupMutation } from "../../group-access/service.js";
import { Frame, KeyValue, Muted } from "./ui-components.js";

export function GroupAccessView({ actions, routeKey, onBack }: { actions: LauncherActions; routeKey: string; onBack(): void }): React.JSX.Element {
  const [view, setView] = useState(() => actions.getGroupManagement(routeKey));
  const [notice, setNotice] = useState("");
  const [inputKey, setInputKey] = useState(0);
  const [pending, setPending] = useState<{ mutation: GroupMutation; revision: number }>();
  useInput((input, key) => {
    if (key.escape) { if (pending) setPending(undefined); else onBack(); return; }
    if (!pending) return;
    if (input.toLowerCase() === "n") { setPending(undefined); return; }
    if (input.toLowerCase() !== "y") return;
    try {
      actions.updateGroupManagement(routeKey, pending.mutation, pending.revision);
      setNotice("群权限已保存。解除黑名单不会恢复旧管理员身份。");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    setPending(undefined); setView(actions.getGroupManagement(routeKey)); setInputKey((n) => n + 1);
  });
  const submit = (value: string) => {
    setInputKey((n) => n + 1);
    if (value.trim() === "refresh") { setView(actions.getGroupManagement(routeKey)); return; }
    if (value.trim() === "audit") {
      setNotice(view.record?.audit?.slice(-10).map((e) => `${formatLocalDateTime(e.at)} ${e.actor} ${e.action} ${e.target ?? ""} ${e.outcome}`).join("\n") || "暂无审计记录。"); return;
    }
    if (value.trim() === "members") {
      setNotice(view.record?.knownPrincipals?.map((p) => `${p.displayName ?? "未登记"} (${p.senderId}) ${groupSenderRole(view.record, p.senderId)}`).join("\n") || "尚未发现群成员；可以手动输入 Open ID。"); return;
    }
    if (view.readOnly || view.error) { setNotice(view.error ?? "服务运行期间只读，请先停止服务。"); return; }
    const [action, target, extra] = value.trim().split(/\s+/);
    let mutation: GroupMutation;
    if (action === "clear_super" && !target) mutation = { action };
    else if (action === "approval" && (target === "open" || target === "restricted") && !extra) mutation = { action, policy: target === "open" ? "any_non_blocked" : "admins_only" };
    else if (["transfer", "admin_add", "admin_remove", "block", "unblock"].includes(action) && /^ou_[A-Za-z0-9_-]+$/.test(target ?? "") && !extra) mutation = { action: action as "transfer", target };
    else { setNotice("请输入下方操作和完整 Open ID；不能用展示名授权。"); return; }
    setPending({ mutation, revision: view.record?.revision ?? 0 });
  };
  const record = view.record;
  const principalLabel = (id: string, name?: string) => `${name ?? record?.knownPrincipals?.find((p) => p.senderId === id)?.displayName ?? "未登记"} (${id})`;
  return <Frame title="群权限管理" subtitle="Esc 返回；输入 refresh 刷新，members 看成员，audit 看最近审计">
    <KeyValue label="Route" value={routeKey} />
    <KeyValue label="状态" value={view.error ? "权限文件异常" : view.readOnly ? "只读：服务正在运行" : view.trusted ? "可管理" : "请先配对"} />
    <KeyValue label="超级管理员" value={record?.superAdmin ? principalLabel(record.superAdmin.senderId, record.superAdmin.displayName) : "未设置，使用 transfer 修复"} />
    <KeyValue label={`管理员 (${record?.admins?.length ?? 0})`} value={record?.admins?.map((p) => principalLabel(p.senderId, p.displayName)).join("、") || "无"} />
    <KeyValue label={`黑名单 (${record?.blockedSenders.length ?? 0})`} value={record?.blockedSenders.map((p) => `${principalLabel(p.senderId, p.displayName)}；封禁者 ${p.createdBySenderId ?? "未知"} (${p.blockedByRole ?? "unknown"})${p.reason ? `；${p.reason}` : ""}`).join("、") || "无"} />
    <KeyValue label="审批" value={record?.approvalPolicy === "any_non_blocked" ? "开放审批" : "超管和管理员"} />
    <Muted text="transfer / admin_add / admin_remove / block / unblock <Open ID>；approval restricted|open；clear_super 清空超管" />
    <Muted text="transfer 设置或转移唯一超管，原超管降为普通成员。管理员可审批、发文件和管理普通成员黑名单。" />
    {notice ? <Text>{notice}</Text> : null}
    {pending ? <Box flexDirection="column"><Text color="yellow">确认 {describeGroupMutation(pending.mutation, record)}？版本 {pending.revision}；y 保存 / n 取消</Text></Box>
      : <TextInput key={inputKey} placeholder="输入操作" onSubmit={submit} />}
  </Frame>;
}
