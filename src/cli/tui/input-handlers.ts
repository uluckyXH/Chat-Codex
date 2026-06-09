import type { Dispatch, SetStateAction } from "react";
import type { CodexRunPolicy } from "../../codex/codex-cli.js";
import type { ContextRefreshPolicy } from "../../context-refresh/types.js";
import type { ClipboardWriteResult } from "../../runtime/clipboard.js";
import type { BindingSummary, SessionChoices } from "../actions/binding-actions.js";
import {
  feishuCredentialDefaults,
  type LauncherActions,
  type LauncherDashboard,
  type PairingRouteSummary,
} from "../actions/launcher-actions.js";
import { sessionPage as buildSessionPage } from "./session-pagination.js";
import type { ContextRefreshTarget, Flash, PermissionTarget, Screen, SessionTarget } from "./types.js";
import { screenChannelId, screenIs } from "./types.js";
import { contextRefreshModeForIndex, numericPick } from "./navigation.js";
import type { TuiActionHandlers } from "./tui-actions.js";
import type { BindingItem, TuiConfirm } from "./use-chat-codex-tui-controller.js";

export interface TuiInputKey {
  escape?: boolean;
  return?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
}

export interface TuiInputContext {
  actions: LauncherActions;
  screen: Screen;
  setScreen: Dispatch<SetStateAction<Screen>>;
  loading: boolean;
  selected: number;
  setSelected: Dispatch<SetStateAction<number>>;
  sessionPageIndex: number;
  channelCursor: number;
  confirm: TuiConfirm | undefined;
  setConfirm: Dispatch<SetStateAction<TuiConfirm | undefined>>;
  channels: LauncherDashboard["channels"];
  pairings: PairingRouteSummary[];
  bindingItems: BindingItem[];
  currentChannel: LauncherDashboard["channels"][number] | undefined;
  currentBinding: BindingSummary | undefined;
  currentPairing: PairingRouteSummary | undefined;
  setFlash: Dispatch<SetStateAction<Flash>>;
  refresh(message?: string): Promise<void>;
  getSessionChoices(target: SessionTarget): SessionChoices;
  getMaxSelectableIndex(): number;
  moveSessionPage(delta: number): boolean;
  openAddWeixinLogin(): Promise<void>;
  checkWeixinLoginResult(): Promise<void>;
  copyToClipboard(text: string): Promise<ClipboardWriteResult>;
  back(): void;
  goHome(): void;
  quit(): void;
  start(): void;
  tuiActions: TuiActionHandlers;
}

export function handleTuiInput(context: TuiInputContext, input: string, key: TuiInputKey): void {
  const { screen, confirm } = context;
  if (screen.name === "addFeishu" || screen.name === "manualSession" || screen.name === "workdirInput" || screen.name === "channelRename") {
    if (key.escape) context.back();
    return;
  }
  if (confirm) {
    if (input.toLowerCase() === "y" || input === "是") void confirm.yes();
    if (input.toLowerCase() === "n" || key.escape || input === "否") context.setConfirm(undefined);
    return;
  }
  if (key.escape) {
    context.back();
    return;
  }
  if (input === "?") {
    context.setScreen({ name: "help" });
    return;
  }
  if (input === "r" && screen.name !== "pairing" && screen.name !== "pairingDetail") {
    void context.refresh("已刷新。");
    return;
  }
  if ((key.leftArrow || key.pageUp) && context.moveSessionPage(-1)) {
    return;
  }
  if ((key.rightArrow || key.pageDown) && context.moveSessionPage(1)) {
    return;
  }
  if (key.upArrow) {
    context.setSelected((value) => Math.max(0, value - 1));
    return;
  }
  if (key.downArrow) {
    context.setSelected((value) => Math.min(context.getMaxSelectableIndex(), value + 1));
    return;
  }
  if (input === "q") {
    context.back();
    return;
  }
  if (screen.name === "home") handleHomeInput(context, input, Boolean(key.return));
  else if (screen.name === "channels") void handleChannelsInput(context, input, Boolean(key.return));
  else if (screen.name === "channelDetail" && context.currentChannel) void handleChannelDetailInput(context, input, Boolean(key.return), context.currentChannel.record);
  else if (screen.name === "addWeixin") void handleAddWeixinInput(context, input, Boolean(key.return));
  else if (screen.name === "weixinBinding") void handleWeixinBindingInput(context, input, Boolean(key.return));
  else if (screen.name === "bindings") void handleBindingsInput(context, input, Boolean(key.return));
  else if (screen.name === "bindingDetail" && context.currentBinding) void handleBindingDetailInput(context, input, Boolean(key.return), context.currentBinding);
  else if (screen.name === "pairing") void handlePairingInput(context, input, Boolean(key.return));
  else if (screen.name === "pairingDetail" && context.currentPairing) void handlePairingDetailInput(context, input, Boolean(key.return), context.currentPairing);
  else if (screen.name === "sessionSelect") void handleSessionSelectInput(context, input, Boolean(key.return));
  else if (screen.name === "permission") void handlePermissionInput(context, input, Boolean(key.return), screen.target);
  else if (screen.name === "contextRefresh") void handleContextRefreshInput(context, input, Boolean(key.return), screen.target);
  else if (screen.name === "workdir") void handleWorkdirInput(context, input, Boolean(key.return));
  else if ((screen.name === "status" || screen.name === "help") && key.return) context.goHome();
  else if (screen.name === "startConfirm" && key.return) context.start();
}

function handleHomeInput(context: TuiInputContext, input: string, enter: boolean): void {
  const { channels, selected, setScreen, quit, tuiActions } = context;
  const noChannels = channels.length === 0;
  const picked = numericPick(input, noChannels ? 5 : 8);
  const actionIndex = picked ?? selected;
  const actionRequested = enter || picked !== undefined;
  if (input === "0") {
    quit();
    return;
  }
  if (noChannels && actionIndex === 5 && enter) {
    quit();
    return;
  }
  if (input === "w" || (noChannels && actionIndex === 0 && actionRequested)) {
    void context.openAddWeixinLogin();
    return;
  }
  if (input === "f" || (noChannels && actionIndex === 1 && actionRequested)) {
    setScreen({ name: "addFeishu", step: "appId", values: feishuCredentialDefaults() });
    return;
  }
  if (input === "t" || (!noChannels && actionIndex === 2 && actionRequested)) {
    setScreen({ name: "pairing" });
    return;
  }
  if (input === "p" || (noChannels ? actionIndex === 2 : actionIndex === 3) && actionRequested) {
    setScreen({ name: "permission", target: { kind: "default" } });
    return;
  }
  if (input === "x" || (noChannels ? actionIndex === 3 : actionIndex === 4) && actionRequested) {
    setScreen({ name: "contextRefresh", target: { kind: "default" } });
    return;
  }
  if (input === "d" || (noChannels ? actionIndex === 4 : actionIndex === 5) && actionRequested) {
    setScreen({ name: "workdir" });
    return;
  }
  if (input === "c" || (!noChannels && actionIndex === 0 && actionRequested)) {
    setScreen({ name: "channels" });
    return;
  }
  if (input === "b" || (!noChannels && actionIndex === 1 && actionRequested)) {
    setScreen({ name: "bindings" });
    return;
  }
  if (input === "s" || (!noChannels && actionIndex === 6 && actionRequested)) {
    setScreen({ name: "status" });
    return;
  }
  if (enter || (!noChannels && actionIndex === 7 && picked !== undefined)) tuiActions.openNeedsAttention();
}

async function handleChannelsInput(context: TuiInputContext, input: string, enter: boolean): Promise<void> {
  const { actions, channels, channelCursor, selected, setScreen, refresh, goHome, tuiActions } = context;
  const actionCount = channels.length === 0 ? 2 : channels.length + 7;
  const picked = numericPick(input, actionCount);
  const actionIndex = picked ?? selected;
  const actionRequested = enter || picked !== undefined;
  if (input === "w" || (channels.length === 0 && actionIndex === 0 && (enter || input === "1"))) {
    void context.openAddWeixinLogin();
    return;
  }
  if (input === "f" || (channels.length === 0 && actionIndex === 1 && (enter || input === "2"))) {
    setScreen({ name: "addFeishu", step: "appId", values: feishuCredentialDefaults() });
    return;
  }
  if (channels.length === 0) return;
  if (input === "w" || (actionIndex === channels.length && actionRequested)) {
    void context.openAddWeixinLogin();
    return;
  }
  if (input === "f" || (actionIndex === channels.length + 1 && actionRequested)) {
    setScreen({ name: "addFeishu", step: "appId", values: feishuCredentialDefaults() });
    return;
  }
  const targetChannel = channels[Math.min(channelCursor, channels.length - 1)];
  if (actionIndex === channels.length + 2 && actionRequested) {
    if (targetChannel) tuiActions.openRenameChannel(targetChannel.record.id);
    return;
  }
  if (actionIndex === channels.length + 3 && actionRequested) {
    if (!targetChannel) return;
    const updated = await actions.setChannelEnabled(targetChannel.record.id, !targetChannel.record.enabled);
    await refresh(updated?.record.enabled ? "已启用渠道，原聊天绑定保持不变。" : "已停用渠道，原聊天绑定保持不变。");
    return;
  }
  if (actionIndex === channels.length + 4 && actionRequested) {
    if (targetChannel) tuiActions.confirmRemoveChannel(targetChannel);
    return;
  }
  if (actionIndex === channels.length + 5 && actionRequested) {
    if (targetChannel) setScreen({ name: "channelDetail", channelId: targetChannel.record.id });
    return;
  }
  if (actionIndex === channels.length + 6 && actionRequested) {
    goHome();
    return;
  }
  const channel = actionIndex < channels.length ? channels[actionIndex] : undefined;
  if (input === "e") {
    const toggleTarget = channel ?? targetChannel;
    if (!toggleTarget) return;
    const updated = await actions.setChannelEnabled(toggleTarget.record.id, !toggleTarget.record.enabled);
    await refresh(updated?.record.enabled ? "已启用渠道，原聊天绑定保持不变。" : "已停用渠道，原聊天绑定保持不变。");
    return;
  }
  if (!channel) return;
  if (enter || picked !== undefined) setScreen({ name: "channelDetail", channelId: channel.record.id });
}

async function handleChannelDetailInput(context: TuiInputContext, input: string, enter: boolean, record: LauncherDashboard["channels"][number]["record"]): Promise<void> {
  const { actions, channels, selected, setScreen, refresh, tuiActions } = context;
  const isFeishu = record.type === "feishu" || record.type === "lark";
  const picked = numericPick(input, isFeishu ? 6 : 5);
  const actionIndex = picked ?? selected;
  const explicitAction = enter || picked !== undefined || input === "b" || input === "c" || input === "e" || input === "g";
  if (!explicitAction) return;
  if (input === "e") {
    const updated = await actions.setChannelEnabled(record.id, !record.enabled);
    await refresh(updated?.record.enabled ? "已启用渠道，原聊天绑定保持不变。" : "已停用渠道，原聊天绑定保持不变。");
    return;
  }
  if (record.type === "weixin" && (input === "b" || actionIndex === 0) && (enter || picked !== undefined || input === "b")) {
    setScreen({ name: "weixinBinding", channelId: record.id });
    return;
  }
  if ((record.type === "feishu" || record.type === "lark") && (input === "c" || actionIndex === 0) && (enter || picked !== undefined || input === "c")) {
    setScreen({ name: "addFeishu", step: "appId", values: feishuCredentialDefaults() });
    return;
  }
  if (isFeishu && (input === "g" || actionIndex === 1)) {
    const channel = channels.find((item) => item.record.id === record.id);
    if (channel) tuiActions.confirmToggleGroupReceive(channel);
    return;
  }
  const shiftedActionIndex = isFeishu ? actionIndex - 1 : actionIndex;
  if (shiftedActionIndex === 1) {
    tuiActions.openRenameChannel(record.id);
    return;
  }
  if (shiftedActionIndex === 2) {
    const updated = await actions.setChannelEnabled(record.id, !record.enabled);
    await refresh(updated?.record.enabled ? "已启用渠道，原聊天绑定保持不变。" : "已停用渠道，原聊天绑定保持不变。");
    return;
  }
  if (shiftedActionIndex === 3) {
    const target = channels.find((item) => item.record.id === record.id);
    if (target) tuiActions.confirmRemoveChannel(target);
    return;
  }
  if (shiftedActionIndex === 4) {
    setScreen({ name: "status" });
  }
}

async function handleAddWeixinInput(context: TuiInputContext, input: string, enter: boolean): Promise<void> {
  const { screen, loading, copyToClipboard, setFlash } = context;
  if (!screenIs("addWeixin", screen) || loading) return;
  if (input.toLowerCase() === "c" && screen.login?.fallbackLink) {
    const result = await copyToClipboard(screen.login.fallbackLink);
    setFlash({
      kind: result.ok ? "success" : "error",
      message: result.ok ? "已复制微信登录备用链接。" : `复制失败：${result.message}`,
    });
    return;
  }
  if (!enter) return;
  if (!screen.login) {
    await context.openAddWeixinLogin();
    return;
  }
  await context.checkWeixinLoginResult();
}

async function handleWeixinBindingInput(context: TuiInputContext, input: string, enter: boolean): Promise<void> {
  const { actions, screen, channels, selected, sessionPageIndex, setScreen, setFlash, tuiActions } = context;
  const channel = channels.find((item) => item.record.id === screenChannelId(screen))?.record;
  if (!channel) return;
  const choices = actions.listWeixinPrimaryChoices(channel);
  if (!choices) {
    setFlash({ kind: "error", message: "这个微信渠道缺少账号标识，不能设置主聊天绑定。" });
    return;
  }
  if (input === "n") {
    await tuiActions.handleWeixinPrimaryResult(actions.setWeixinPrimaryNew(channel));
    return;
  }
  if (input === "m") {
    setScreen({ name: "manualSession", target: { kind: "weixinPrimary", channelId: channel.id } });
    return;
  }
  if (input === "0") {
    await tuiActions.handleWeixinPrimaryResult(actions.setWeixinPrimaryNone(channel));
    return;
  }
  const page = buildSessionPage(choices.selectable, sessionPageIndex);
  const picked = numericPick(input, page.items.length);
  if (enter && selected >= page.items.length) {
    const actionIndex = selected - page.items.length;
    if (actionIndex === 0) {
      await tuiActions.handleWeixinPrimaryResult(actions.setWeixinPrimaryNew(channel));
      return;
    }
    if (actionIndex === 1) {
      setScreen({ name: "manualSession", target: { kind: "weixinPrimary", channelId: channel.id } });
      return;
    }
    if (actionIndex === 2) {
      await tuiActions.handleWeixinPrimaryResult(actions.setWeixinPrimaryNone(channel));
      return;
    }
  }
  const choice = picked !== undefined ? page.items[picked] : page.items[selected];
  if ((enter || picked !== undefined) && choice) {
    await tuiActions.handleWeixinPrimaryResult(actions.setWeixinPrimaryExisting(channel, choice.id));
  }
}

async function handleBindingsInput(context: TuiInputContext, input: string, enter: boolean): Promise<void> {
  const { bindingItems, selected, setScreen, setFlash, tuiActions } = context;
  const picked = numericPick(input, bindingItems.length);
  const item = bindingItems[picked ?? selected];
  if (!item) return;
  if (item.kind === "pending") {
    await handlePendingBindingInput(context, input, enter, item.pending.channelId);
    return;
  }
  const binding = item.binding;
  if (binding.trusted === false) {
    if (enter || picked !== undefined) {
      setScreen({ name: "pairingDetail", routeKey: binding.route.routeKey });
    } else if (input === "n" || input === "m" || input === "u" || input === "p") {
      setFlash({ kind: "error", message: "这个聊天还没有完成配对，暂不能绑定或修改 session。请先到“配对管理”完成信任。" });
    }
    return;
  }
  if (input === "n") {
    await tuiActions.createAndBind(binding.route.routeKey);
    return;
  }
  if (input === "m") {
    setScreen({ name: "manualSession", target: { kind: "route", routeKey: binding.route.routeKey } });
    return;
  }
  if (input === "u") {
    tuiActions.confirmUnbind(binding);
    return;
  }
  if (input === "p" && binding.activeSession) {
    setScreen({ name: "permission", target: { kind: "session", routeKey: binding.route.routeKey, session: binding.activeSession } });
    return;
  }
  if (enter || picked !== undefined) setScreen({ name: "bindingDetail", routeKey: binding.route.routeKey });
}

async function handlePendingBindingInput(context: TuiInputContext, input: string, enter: boolean, channelId: string): Promise<void> {
  const { actions, channels, bindingItems, setScreen, setFlash, tuiActions } = context;
  const channel = channels.find((item) => item.record.id === channelId)?.record;
  if (!channel) {
    setFlash({ kind: "error", message: "待生效绑定对应的微信渠道不存在。" });
    return;
  }
  if (input === "n") {
    await tuiActions.handleWeixinPrimaryResult(actions.setWeixinPrimaryNew(channel));
    return;
  }
  if (input === "m") {
    setScreen({ name: "manualSession", target: { kind: "weixinPrimary", channelId } });
    return;
  }
  if (input === "u") {
    await tuiActions.handleWeixinPrimaryResult(actions.setWeixinPrimaryNone(channel));
    return;
  }
  if (enter || numericPick(input, bindingItems.length) !== undefined) {
    setScreen({ name: "weixinBinding", channelId });
  }
}

async function handlePairingInput(context: TuiInputContext, input: string, enter: boolean): Promise<void> {
  const { pairings, selected, setScreen, tuiActions } = context;
  const picked = numericPick(input, pairings.length);
  const pairing = pairings[picked ?? selected];
  if (!pairing) return;
  if (input === "m" && !pairing.trusted) {
    tuiActions.confirmManualTrust(pairing);
    return;
  }
  if (input === "r" && pairing.trusted) {
    tuiActions.confirmRevokeTrust(pairing, false);
    return;
  }
  if (input === "u" && pairing.trusted) {
    tuiActions.confirmRevokeTrust(pairing, true);
    return;
  }
  if (enter || picked !== undefined) setScreen({ name: "pairingDetail", routeKey: pairing.route.routeKey });
}

async function handlePairingDetailInput(context: TuiInputContext, input: string, enter: boolean, pairing: PairingRouteSummary): Promise<void> {
  const { selected, setScreen, tuiActions } = context;
  if (pairing.trusted) {
    const picked = numericPick(input, 3);
    const actionIndex = picked ?? selected;
    if (input === "r" || ((enter || picked !== undefined) && actionIndex === 0)) {
      tuiActions.confirmRevokeTrust(pairing, false);
      return;
    }
    if (input === "u" || ((enter || picked !== undefined) && actionIndex === 1)) {
      tuiActions.confirmRevokeTrust(pairing, true);
      return;
    }
    if ((enter || picked !== undefined) && actionIndex === 2) setScreen({ name: "pairing" });
    return;
  }
  const picked = numericPick(input, 2);
  const actionIndex = picked ?? selected;
  if (input === "m" || ((enter || picked !== undefined) && actionIndex === 0)) {
    tuiActions.confirmManualTrust(pairing);
    return;
  }
  if ((enter || picked !== undefined) && actionIndex === 1) setScreen({ name: "pairing" });
}

async function handleBindingDetailInput(context: TuiInputContext, input: string, enter: boolean, binding: BindingSummary): Promise<void> {
  const { selected, setScreen, tuiActions } = context;
  if (binding.trusted === false) {
    const picked = numericPick(input, 2);
    const actionIndex = picked ?? selected;
    if (!enter && picked === undefined) return;
    if (actionIndex === 0) setScreen({ name: "pairingDetail", routeKey: binding.route.routeKey });
    else setScreen({ name: "bindings" });
    return;
  }
  const picked = numericPick(input, 5);
  if (!enter && picked === undefined) return;
  const actionIndex = picked ?? selected;
  if ((input === "1" || actionIndex === 0) && (enter || input === "1")) {
    setScreen({ name: "sessionSelect", target: { kind: "route", routeKey: binding.route.routeKey } });
    return;
  }
  if (input === "2" || actionIndex === 1) {
    await tuiActions.createAndBind(binding.route.routeKey);
    return;
  }
  if ((input === "3" || actionIndex === 2) && binding.activeSession) {
    setScreen({ name: "permission", target: { kind: "session", routeKey: binding.route.routeKey, session: binding.activeSession } });
    return;
  }
  if (input === "4" || actionIndex === 3) {
    setScreen({ name: "contextRefresh", target: { kind: "route", routeKey: binding.route.routeKey } });
    return;
  }
  if ((input === "5" || actionIndex === 4) && binding.activeSession) tuiActions.confirmUnbind(binding);
}

async function handleSessionSelectInput(context: TuiInputContext, input: string, enter: boolean): Promise<void> {
  const { actions, screen, channels, selected, sessionPageIndex, setScreen, getSessionChoices, tuiActions } = context;
  if (!screenIs("sessionSelect", screen)) return;
  const target = screen.target;
  if (input === "m") {
    setScreen({ name: "manualSession", target });
    return;
  }
  if (input === "n") {
    if (target.kind === "weixinPrimary") {
      const channel = channels.find((item) => item.record.id === target.channelId)?.record;
      if (channel) await tuiActions.handleWeixinPrimaryResult(actions.setWeixinPrimaryNew(channel));
      return;
    }
    await tuiActions.createAndBind(target.routeKey);
    return;
  }
  const choices = getSessionChoices(target);
  const page = buildSessionPage(choices.selectable, sessionPageIndex);
  const picked = numericPick(input, page.items.length);
  const choice = picked !== undefined ? page.items[picked] : page.items[selected];
  if (!choice || (!enter && picked === undefined)) return;
  await tuiActions.bindSessionTarget(target, choice.id);
}

async function handlePermissionInput(context: TuiInputContext, input: string, enter: boolean, target: PermissionTarget): Promise<void> {
  const { selected, setConfirm, tuiActions } = context;
  const pick = numericPick(input, 2);
  const index = pick ?? selected;
  if (!enter && pick === undefined) return;
  const policy: CodexRunPolicy = index === 1
    ? { permissionMode: "full" }
    : { permissionMode: "approval", sandbox: "workspace-write" };
  if (policy.permissionMode === "full") {
    setConfirm({
      message: "完全权限会跳过审批和沙箱，可以直接执行命令并修改文件。按 y 确认，按 n 取消。",
      yes: async () => {
        setConfirm(undefined);
        await tuiActions.savePermission(target, policy);
      },
    });
    return;
  }
  await tuiActions.savePermission(target, policy);
}

async function handleContextRefreshInput(context: TuiInputContext, input: string, enter: boolean, target: ContextRefreshTarget): Promise<void> {
  const { actions, selected, setFlash, refresh } = context;
  const pick = numericPick(input, target.kind === "route" ? 4 : 3);
  const index = pick ?? selected;
  if (!enter && pick === undefined) return;
  if (target.kind === "route" && index === 0) {
    const effective = actions.clearRouteContextRefreshPolicy(target.routeKey);
    setFlash({ kind: "success", message: `已设置当前聊天上下文刷新：${actions.formatContextRefreshEffectivePolicy(effective)}` });
    await refresh();
    return;
  }
  const mode = contextRefreshModeForIndex(target.kind, index);
  if (!mode) return;
  const policy: ContextRefreshPolicy = { mode };
  if (target.kind === "default") {
    actions.setContextRefreshDefaults(policy);
    setFlash({ kind: "success", message: `已设置默认上下文刷新：${actions.formatContextRefreshPolicy(policy)}；没有单独规则的聊天会继承这个全局默认。` });
  } else {
    const effective = actions.setRouteContextRefreshPolicy(target.routeKey, policy);
    setFlash({ kind: "success", message: `已设置当前聊天上下文刷新：${actions.formatContextRefreshEffectivePolicy(effective)}` });
  }
  await refresh();
}

async function handleWorkdirInput(context: TuiInputContext, input: string, enter: boolean): Promise<void> {
  const { selected, setScreen, tuiActions } = context;
  const pick = numericPick(input, 2);
  const index = pick ?? selected;
  if (!enter && pick === undefined && input !== "c" && input !== "d" && input !== "m") return;
  if (input === "m" || index === 1) {
    setScreen({ name: "workdirInput" });
    return;
  }
  if (input === "c" || input === "d" || index === 0) {
    await tuiActions.saveWorkdir(undefined);
  }
}
