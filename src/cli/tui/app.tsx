import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, useApp, useInput } from "ink";
import type { CodexRunPolicy } from "../../codex/codex-cli.js";
import type { FeishuCredentials } from "../../channels/feishu/feishu-types.js";
import { chatCodexTitle } from "../../runtime/package-info.js";
import type { BindingSummary, SessionChoices } from "../actions/binding-actions.js";
import { formatManagedChannelLabel } from "../actions/channel-actions.js";
import {
  feishuCredentialDefaults,
  type FeishuBotSetupResult,
  type LauncherDashboard,
  type PairingRouteSummary,
} from "../actions/launcher-actions.js";
import type { ChatCodexTuiProps, Flash, PermissionTarget, Screen, SessionTarget } from "./types.js";
import { screenChannelId, screenIs } from "./types.js";
import { ConfirmBar, Footer, formatSession } from "./ui-components.js";
import {
  AddFeishuView,
  AddWeixinView,
  BindingDetailView,
  BindingsView,
  ChannelDetailView,
  ChannelRenameView,
  ChannelsView,
  HelpView,
  HomeView,
  LoadingView,
  ManualSessionView,
  PairingDetailView,
  PairingView,
  PermissionView,
  SessionSelectView,
  StartConfirmView,
  StatusView,
  WeixinBindingView,
  WorkdirInputView,
  WorkdirView,
} from "./views.js";

export function ChatCodexTui({ actions, onDone }: ChatCodexTuiProps): React.JSX.Element {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const [dashboard, setDashboard] = useState<LauncherDashboard>();
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const [channelCursor, setChannelCursor] = useState(0);
  const [flash, setFlash] = useState<Flash>({ kind: "info", message: "按 ? 查看快捷键。" });
  const [confirm, setConfirm] = useState<{ message: string; yes: () => void | Promise<void> }>();
  const [manualValue, setManualValue] = useState("");
  const weixinLoginRequest = useRef(0);
  const weixinLoginCheckInFlight = useRef(false);
  const channels = dashboard?.channels ?? [];
  const bindings = dashboard?.bindings ?? [];
  const pendingBindings = dashboard?.pendingBindings ?? [];
  const pairings = dashboard?.pairing.routes ?? [];

  const refresh = async (message?: string): Promise<void> => {
    setLoading(true);
    try {
      setDashboard(await actions.getDashboard());
      if (message) setFlash({ kind: "success", message });
    } catch (error) {
      setFlash({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (screen.name === "weixinBinding") {
      const channel = channels.find((item) => item.record.id === screen.channelId)?.record;
      setSelected(channel ? actions.listWeixinPrimaryChoices(channel)?.selectable.length ?? 0 : 0);
    } else {
      setSelected(screen.name === "home" && (dashboard?.channels.length ?? 0) > 0 ? 6 : 0);
    }
    setConfirm(undefined);
    setManualValue("");
  }, [actions, channels, screen, dashboard?.channels.length]);

  useEffect(() => {
    if (screen.name === "channels" && selected < channels.length) {
      setChannelCursor(selected);
    }
  }, [channels.length, screen.name, selected]);

  useEffect(() => {
    setChannelCursor((value) => Math.min(value, Math.max(0, channels.length - 1)));
  }, [channels.length]);

  const bindingItems = [
    ...bindings.map((binding) => ({ kind: "route" as const, binding })),
    ...pendingBindings.map((pending) => ({ kind: "pending" as const, pending })),
  ];
  const currentChannel = screen.name === "channelDetail" || screen.name === "channelRename"
    ? channels.find((item) => item.record.id === screen.channelId)
    : undefined;
  const currentBinding = screen.name === "bindingDetail"
    ? actions.getBinding(screen.routeKey)
    : undefined;
  const currentPairing = screen.name === "pairingDetail"
    ? pairings.find((item) => item.route.routeKey === screen.routeKey) ?? actions.getPairingRoute(screen.routeKey)
    : undefined;
  const getMaxSelectableIndex = (): number => {
    if (screen.name === "sessionSelect") return Math.max(0, getSessionChoices(screen.target).selectable.length - 1);
    if (screen.name === "weixinBinding") {
      const channel = channels.find((item) => item.record.id === screen.channelId)?.record;
      const selectableCount = channel ? actions.listWeixinPrimaryChoices(channel)?.selectable.length ?? 0 : 0;
      return Math.max(0, selectableCount + 3 - 1);
    }
    if (screen.name === "pairing") return Math.max(0, pairings.length - 1);
    if (screen.name === "pairingDetail") return currentPairing?.trusted ? 2 : 1;
    if (screen.name === "bindingDetail" && currentBinding?.trusted === false) return 1;
    return maxSelectableIndex(screen, channels, bindingItems.length);
  };

  const quit = (): void => {
    onDone({ start: false });
    exit();
  };

  const start = (): void => {
    onDone({ start: true });
    exit();
  };

  const goHome = (): void => setScreen({ name: "home" });

  const openNeedsAttention = (): void => {
    const validation = dashboard?.canStart;
    if (!validation || validation.ok) {
      setScreen({ name: "startConfirm" });
      setFlash({ kind: "info", message: "确认无误后按 Enter 启动服务；Esc 返回修改配置。" });
      return;
    }
    if (validation.reason === "no_enabled_channels") {
      setScreen({ name: "channels" });
      setFlash({ kind: "info", message: validation.message });
      return;
    }
    if (validation.reason === "codex_unavailable") {
      setScreen({ name: "status" });
      setFlash({ kind: "error", message: validation.message });
      return;
    }
    const channel = validation.channels[0];
    setScreen({ name: "channelDetail", channelId: channel.record.id });
    setFlash({ kind: "error", message: validation.message });
  };

  const openAddWeixinLogin = async (): Promise<void> => {
    const requestId = weixinLoginRequest.current + 1;
    weixinLoginRequest.current = requestId;
    setScreen({ name: "addWeixin" });
    setLoading(true);
    try {
      const login = await actions.startWeixinLogin();
      if (weixinLoginRequest.current !== requestId) return;
      setScreen({ name: "addWeixin", login });
      setFlash({ kind: "info", message: login.started.message });
    } catch (error) {
      if (weixinLoginRequest.current === requestId) {
        setFlash({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (weixinLoginRequest.current === requestId) setLoading(false);
    }
  };

  const checkWeixinLoginResult = async (): Promise<void> => {
    if (!screenIs("addWeixin", screen) || loading || weixinLoginCheckInFlight.current) return;
    const requestId = weixinLoginRequest.current;
    weixinLoginCheckInFlight.current = true;
    setLoading(true);
    try {
      const result = await actions.checkWeixinLogin();
      if (weixinLoginRequest.current !== requestId) return;
      if (result.state === "connected") {
        await refresh(result.message);
        setScreen({ name: "weixinBinding", channelId: result.channel.id });
        return;
      }
      setFlash({ kind: result.state === "failed" ? "error" : "info", message: result.message });
    } finally {
      if (weixinLoginRequest.current === requestId) setLoading(false);
      weixinLoginCheckInFlight.current = false;
    }
  };

  useEffect(() => {
    if (screen.name !== "addWeixin" || !screen.login || loading) return undefined;
    const requestId = weixinLoginRequest.current;
    const timer = setTimeout(() => {
      if (weixinLoginRequest.current === requestId) void checkWeixinLoginResult();
    }, weixinAutoCheckIntervalMs());
    return () => clearTimeout(timer);
  }, [loading, screen]);

  const back = (): void => {
    if (confirm) {
      setConfirm(undefined);
      return;
    }
    if (screen.name === "home") {
      quit();
      return;
    }
    if (screen.name === "addWeixin") {
      weixinLoginRequest.current += 1;
      const result = actions.cancelWeixinLogin();
      setFlash({ kind: "info", message: result.message });
      setLoading(false);
      setScreen({ name: "channels" });
      return;
    }
    if (screen.name === "channelDetail" || screen.name === "channelRename" || screen.name === "addFeishu") {
      setScreen({ name: "channels" });
      return;
    }
    if (screen.name === "bindingDetail" || screen.name === "sessionSelect" || screen.name === "manualSession") {
      setScreen({ name: "bindings" });
      return;
    }
    if (screen.name === "pairingDetail") {
      setScreen({ name: "pairing" });
      return;
    }
    if (screen.name === "workdirInput") {
      setScreen({ name: "workdir" });
      return;
    }
    if (screen.name === "permission" && screen.target.kind === "session") {
      setScreen({ name: "bindingDetail", routeKey: screen.target.routeKey });
      return;
    }
    goHome();
  };

  useInput((input, key) => {
    if (screen.name === "addFeishu" || screen.name === "manualSession" || screen.name === "workdirInput" || screen.name === "channelRename") {
      if (key.escape) back();
      return;
    }
    if (confirm) {
      if (input.toLowerCase() === "y" || input === "是") void confirm.yes();
      if (input.toLowerCase() === "n" || key.escape || input === "否") setConfirm(undefined);
      return;
    }
    if (key.escape) {
      back();
      return;
    }
    if (input === "?") {
      setScreen({ name: "help" });
      return;
    }
    if (input === "r" && screen.name !== "pairing" && screen.name !== "pairingDetail") {
      void refresh("已刷新。");
      return;
    }
    if (key.upArrow) {
      setSelected((value) => Math.max(0, value - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((value) => Math.min(getMaxSelectableIndex(), value + 1));
      return;
    }
    if (input === "q") {
      back();
      return;
    }
    if (screen.name === "home") handleHomeInput(input, key.return);
    else if (screen.name === "channels") void handleChannelsInput(input, key.return);
    else if (screen.name === "channelDetail" && currentChannel) void handleChannelDetailInput(input, key.return, currentChannel.record);
    else if (screen.name === "addWeixin") void handleAddWeixinInput(key.return);
    else if (screen.name === "weixinBinding") void handleWeixinBindingInput(input, key.return);
    else if (screen.name === "bindings") void handleBindingsInput(input, key.return);
    else if (screen.name === "bindingDetail" && currentBinding) void handleBindingDetailInput(input, key.return, currentBinding);
    else if (screen.name === "pairing") void handlePairingInput(input, key.return);
    else if (screen.name === "pairingDetail" && currentPairing) void handlePairingDetailInput(input, key.return, currentPairing);
    else if (screen.name === "sessionSelect") void handleSessionSelectInput(input, key.return);
    else if (screen.name === "permission") void handlePermissionInput(input, key.return, screen.target);
    else if (screen.name === "workdir") void handleWorkdirInput(input, key.return);
    else if ((screen.name === "status" || screen.name === "help") && key.return) goHome();
    else if (screen.name === "startConfirm" && key.return) start();
  });

  const handleHomeInput = (input: string, enter: boolean): void => {
    const noChannels = channels.length === 0;
    const picked = numericPick(input, noChannels ? 4 : 7);
    const actionIndex = picked ?? selected;
    const actionRequested = enter || picked !== undefined;
    if (input === "0") {
      quit();
      return;
    }
    if (noChannels && actionIndex === 4 && enter) {
      quit();
      return;
    }
    if (input === "w" || (noChannels && actionIndex === 0 && actionRequested)) {
      void openAddWeixinLogin();
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
    if (input === "d" || (noChannels ? actionIndex === 3 : actionIndex === 4) && actionRequested) {
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
    if (input === "s" || (!noChannels && actionIndex === 5 && actionRequested)) {
      setScreen({ name: "status" });
      return;
    }
    if (enter || (!noChannels && actionIndex === 6 && picked !== undefined)) openNeedsAttention();
  };

  const handleChannelsInput = async (input: string, enter: boolean): Promise<void> => {
    const actionCount = channels.length === 0 ? 2 : channels.length + 7;
    const picked = numericPick(input, actionCount);
    const actionIndex = picked ?? selected;
    const actionRequested = enter || picked !== undefined;
    if (input === "w" || (channels.length === 0 && actionIndex === 0 && (enter || input === "1"))) {
      void openAddWeixinLogin();
      return;
    }
    if (input === "f" || (channels.length === 0 && actionIndex === 1 && (enter || input === "2"))) {
      setScreen({ name: "addFeishu", step: "appId", values: feishuCredentialDefaults() });
      return;
    }
    if (channels.length === 0) return;
    if (input === "w" || (actionIndex === channels.length && actionRequested)) {
      void openAddWeixinLogin();
      return;
    }
    if (input === "f" || (actionIndex === channels.length + 1 && actionRequested)) {
      setScreen({ name: "addFeishu", step: "appId", values: feishuCredentialDefaults() });
      return;
    }
    const targetChannel = channels[Math.min(channelCursor, channels.length - 1)];
    if (actionIndex === channels.length + 2 && actionRequested) {
      if (targetChannel) openRenameChannel(targetChannel.record.id);
      return;
    }
    if (actionIndex === channels.length + 3 && actionRequested) {
      if (!targetChannel) return;
      const updated = await actions.setChannelEnabled(targetChannel.record.id, !targetChannel.record.enabled);
      await refresh(updated?.record.enabled ? "已启用渠道，原聊天绑定保持不变。" : "已停用渠道，原聊天绑定保持不变。");
      return;
    }
    if (actionIndex === channels.length + 4 && actionRequested) {
      if (targetChannel) confirmRemoveChannel(targetChannel);
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
  };

  const handleChannelDetailInput = async (input: string, enter: boolean, record: LauncherDashboard["channels"][number]["record"]): Promise<void> => {
    const picked = numericPick(input, 5);
    const actionIndex = picked ?? selected;
    const explicitAction = enter || picked !== undefined || input === "b" || input === "c" || input === "e";
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
    if (actionIndex === 1) {
      openRenameChannel(record.id);
      return;
    }
    if (actionIndex === 2) {
      const updated = await actions.setChannelEnabled(record.id, !record.enabled);
      await refresh(updated?.record.enabled ? "已启用渠道，原聊天绑定保持不变。" : "已停用渠道，原聊天绑定保持不变。");
      return;
    }
    if (actionIndex === 3) {
      const target = channels.find((item) => item.record.id === record.id);
      if (target) confirmRemoveChannel(target);
      return;
    }
    if (actionIndex === 4) {
      setScreen({ name: "status" });
    }
  };

  const handleAddWeixinInput = async (enter: boolean): Promise<void> => {
    if (!enter || !screenIs("addWeixin", screen) || loading) return;
    if (!screen.login) {
      await openAddWeixinLogin();
      return;
    }
    await checkWeixinLoginResult();
  };

  const handleWeixinBindingInput = async (input: string, enter: boolean): Promise<void> => {
    const channel = channels.find((item) => item.record.id === screenChannelId(screen))?.record;
    if (!channel) return;
    const choices = actions.listWeixinPrimaryChoices(channel);
    if (!choices) {
      setFlash({ kind: "error", message: "这个微信渠道缺少账号标识，不能设置主聊天绑定。" });
      return;
    }
    if (input === "n") {
      await handleWeixinPrimaryResult(actions.setWeixinPrimaryNew(channel));
      return;
    }
    if (input === "m") {
      setScreen({ name: "manualSession", target: { kind: "weixinPrimary", channelId: channel.id } });
      return;
    }
    if (input === "0") {
      await handleWeixinPrimaryResult(actions.setWeixinPrimaryNone(channel));
      return;
    }
    const picked = numericPick(input, choices.selectable.length);
    if (enter && selected >= choices.selectable.length) {
      const actionIndex = selected - choices.selectable.length;
      if (actionIndex === 0) {
        await handleWeixinPrimaryResult(actions.setWeixinPrimaryNew(channel));
        return;
      }
      if (actionIndex === 1) {
        setScreen({ name: "manualSession", target: { kind: "weixinPrimary", channelId: channel.id } });
        return;
      }
      if (actionIndex === 2) {
        await handleWeixinPrimaryResult(actions.setWeixinPrimaryNone(channel));
        return;
      }
    }
    const choice = picked !== undefined ? choices.selectable[picked] : choices.selectable[selected];
    if ((enter || picked !== undefined) && choice) {
      await handleWeixinPrimaryResult(actions.setWeixinPrimaryExisting(channel, choice.id));
    }
  };

  const handleWeixinPrimaryResult = async (result: ReturnType<typeof actions.setWeixinPrimaryNew>): Promise<void> => {
    setFlash({ kind: result.ok ? "success" : "error", message: result.message });
    await refresh();
  };

  const handleBindingsInput = async (input: string, enter: boolean): Promise<void> => {
    const picked = numericPick(input, bindingItems.length);
    const item = bindingItems[picked ?? selected];
    if (!item) return;
    if (item.kind === "pending") {
      await handlePendingBindingInput(input, enter, item.pending.channelId);
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
      await createAndBind(binding.route.routeKey);
      return;
    }
    if (input === "m") {
      setScreen({ name: "manualSession", target: { kind: "route", routeKey: binding.route.routeKey } });
      return;
    }
    if (input === "u") {
      confirmUnbind(binding);
      return;
    }
    if (input === "p" && binding.activeSession) {
      setScreen({ name: "permission", target: { kind: "session", routeKey: binding.route.routeKey, session: binding.activeSession } });
      return;
    }
    if (enter || picked !== undefined) setScreen({ name: "bindingDetail", routeKey: binding.route.routeKey });
  };

  const handlePendingBindingInput = async (input: string, enter: boolean, channelId: string): Promise<void> => {
    const channel = channels.find((item) => item.record.id === channelId)?.record;
    if (!channel) {
      setFlash({ kind: "error", message: "待生效绑定对应的微信渠道不存在。" });
      return;
    }
    if (input === "n") {
      await handleWeixinPrimaryResult(actions.setWeixinPrimaryNew(channel));
      return;
    }
    if (input === "m") {
      setScreen({ name: "manualSession", target: { kind: "weixinPrimary", channelId } });
      return;
    }
    if (input === "u") {
      await handleWeixinPrimaryResult(actions.setWeixinPrimaryNone(channel));
      return;
    }
    if (enter || numericPick(input, bindingItems.length) !== undefined) {
      setScreen({ name: "weixinBinding", channelId });
    }
  };

  const handlePairingInput = async (input: string, enter: boolean): Promise<void> => {
    const picked = numericPick(input, pairings.length);
    const pairing = pairings[picked ?? selected];
    if (!pairing) return;
    if (input === "m" && !pairing.trusted) {
      confirmManualTrust(pairing);
      return;
    }
    if (input === "r" && pairing.trusted) {
      confirmRevokeTrust(pairing, false);
      return;
    }
    if (input === "u" && pairing.trusted) {
      confirmRevokeTrust(pairing, true);
      return;
    }
    if (enter || picked !== undefined) setScreen({ name: "pairingDetail", routeKey: pairing.route.routeKey });
  };

  const handlePairingDetailInput = async (input: string, enter: boolean, pairing: PairingRouteSummary): Promise<void> => {
    if (pairing.trusted) {
      const picked = numericPick(input, 3);
      const actionIndex = picked ?? selected;
      if (input === "r" || ((enter || picked !== undefined) && actionIndex === 0)) {
        confirmRevokeTrust(pairing, false);
        return;
      }
      if (input === "u" || ((enter || picked !== undefined) && actionIndex === 1)) {
        confirmRevokeTrust(pairing, true);
        return;
      }
      if ((enter || picked !== undefined) && actionIndex === 2) setScreen({ name: "pairing" });
      return;
    }
    const picked = numericPick(input, 2);
    const actionIndex = picked ?? selected;
    if (input === "m" || ((enter || picked !== undefined) && actionIndex === 0)) {
      confirmManualTrust(pairing);
      return;
    }
    if ((enter || picked !== undefined) && actionIndex === 1) setScreen({ name: "pairing" });
  };

  const handleBindingDetailInput = async (input: string, enter: boolean, binding: BindingSummary): Promise<void> => {
    if (binding.trusted === false) {
      const picked = numericPick(input, 2);
      const actionIndex = picked ?? selected;
      if (!enter && picked === undefined) return;
      if (actionIndex === 0) setScreen({ name: "pairingDetail", routeKey: binding.route.routeKey });
      else setScreen({ name: "bindings" });
      return;
    }
    const picked = numericPick(input, 4);
    if (!enter && picked === undefined) return;
    const actionIndex = picked ?? selected;
    if ((input === "1" || actionIndex === 0) && (enter || input === "1")) {
      setScreen({ name: "sessionSelect", target: { kind: "route", routeKey: binding.route.routeKey } });
      return;
    }
    if (input === "2" || actionIndex === 1) {
      await createAndBind(binding.route.routeKey);
      return;
    }
    if ((input === "3" || actionIndex === 2) && binding.activeSession) {
      setScreen({ name: "permission", target: { kind: "session", routeKey: binding.route.routeKey, session: binding.activeSession } });
      return;
    }
    if ((input === "4" || actionIndex === 3) && binding.activeSession) confirmUnbind(binding);
  };

  const handleSessionSelectInput = async (input: string, enter: boolean): Promise<void> => {
    if (!screenIs("sessionSelect", screen)) return;
    const target = screen.target;
    if (input === "m") {
      setScreen({ name: "manualSession", target });
      return;
    }
    if (input === "n") {
      if (target.kind === "weixinPrimary") {
        const channel = channels.find((item) => item.record.id === target.channelId)?.record;
        if (channel) await handleWeixinPrimaryResult(actions.setWeixinPrimaryNew(channel));
        return;
      }
      await createAndBind(target.routeKey);
      return;
    }
    const choices = getSessionChoices(target);
    const picked = numericPick(input, choices.selectable.length);
    const choice = picked !== undefined ? choices.selectable[picked] : choices.selectable[selected];
    if (!choice || (!enter && picked === undefined)) return;
    await bindSessionTarget(target, choice.id);
  };

  const handlePermissionInput = async (input: string, enter: boolean, target: PermissionTarget): Promise<void> => {
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
          await savePermission(target, policy);
        },
      });
      return;
    }
    await savePermission(target, policy);
  };

  const handleWorkdirInput = async (input: string, enter: boolean): Promise<void> => {
    const pick = numericPick(input, 2);
    const index = pick ?? selected;
    if (!enter && pick === undefined && input !== "c" && input !== "d" && input !== "m") return;
    if (input === "m" || index === 1) {
      setScreen({ name: "workdirInput" });
      return;
    }
    if (input === "c" || input === "d" || index === 0) {
      await saveWorkdir(undefined);
    }
  };

  const submitFeishuValue = async (value: string): Promise<void> => {
    if (!screenIs("addFeishu", screen)) return;
    const trimmed = value.trim();
    if (!trimmed) {
      setFlash({ kind: "error", message: "这里不能为空；按 Esc 返回。" });
      return;
    }
    const values = { ...screen.values, [screen.step]: trimmed };
    const next = nextFeishuStep(screen.step);
    if (next) {
      setScreen({ name: "addFeishu", step: next, values });
      return;
    }
    setLoading(true);
    const result: FeishuBotSetupResult = await actions.addFeishuBot({
      ...values,
      domain: values.domain || feishuCredentialDefaults().domain,
    } as FeishuCredentials);
    setLoading(false);
    setFlash({ kind: result.ok ? "success" : "error", message: result.message });
    if (result.ok) {
      await refresh();
      setScreen({ name: "channels" });
    }
  };

  const savePermission = async (target: PermissionTarget, policy: CodexRunPolicy): Promise<void> => {
    if (target.kind === "default") {
      actions.setDefaultPermission(policy);
      setFlash({ kind: "success", message: `已设置新 session 默认权限：${actions.formatRunPolicy(policy)}` });
    } else {
      actions.setSessionPermission(target.session.id, policy);
      setFlash({ kind: "success", message: `已设置当前 session 权限：${actions.formatRunPolicy(policy)}` });
    }
    await refresh();
  };

  const saveWorkdir = async (value: string | undefined, createIfMissing = false): Promise<void> => {
    const result = actions.setDefaultWorkdir(value, { createIfMissing });
    if (result.ok) {
      setConfirm(undefined);
      setFlash({ kind: "success", message: result.message });
      await refresh();
      return;
    }
    if (result.reason === "missing" && result.cwd) {
      setConfirm({
        message: `${result.message} 按 y 创建并使用，按 n 取消。`,
        yes: async () => {
          await saveWorkdir(result.cwd, true);
        },
      });
      return;
    }
    setFlash({ kind: "error", message: result.message });
  };

  const createAndBind = async (routeKey: string): Promise<void> => {
    setLoading(true);
    const result = await actions.createAndBindSession(routeKey);
    setLoading(false);
    setFlash({ kind: result.ok ? "success" : "error", message: result.ok ? `已新建并绑定 session：${formatSession(result.session)}` : result.message });
    await refresh();
  };

  const openRenameChannel = (channelId: string): void => {
    const channel = channels.find((item) => item.record.id === channelId);
    setManualValue(channel?.record.displayName ?? "");
    setScreen({ name: "channelRename", channelId });
  };

  const saveChannelName = async (channelId: string, value: string): Promise<void> => {
    const updated = await actions.renameChannel(channelId, value.trim() || undefined);
    setFlash({
      kind: updated ? "success" : "error",
      message: updated ? `已更新渠道备注：${formatManagedChannelLabel(updated)}` : "这个渠道已经不存在。",
    });
    await refresh();
    setScreen({ name: "channels" });
  };

  const confirmRemoveChannel = (channel: LauncherDashboard["channels"][number]): void => {
    setConfirm({
      message: `确认删除 ${formatManagedChannelLabel(channel)}？会移除渠道配置、聊天记录和绑定占用；不会删除 Codex session。本操作按 y 确认，按 n 取消。`,
      yes: async () => {
        const result = await actions.removeChannel(channel.record.id);
        setConfirm(undefined);
        setFlash({ kind: result.ok ? "success" : "error", message: result.message });
        setScreen({ name: "channels" });
        await refresh();
      },
    });
  };

  const confirmUnbind = (binding: BindingSummary): void => {
    setConfirm({
      message: `确认解绑 ${binding.label} 当前 session？按 y 确认，按 n 取消。`,
      yes: async () => {
        const result = actions.unbindSession(binding.route.routeKey);
        setConfirm(undefined);
        setFlash({ kind: result.ok ? "success" : "error", message: result.message });
        await refresh();
      },
    });
  };

  const confirmManualTrust = (pairing: PairingRouteSummary): void => {
    setConfirm({
      message: `确认手动信任 ${pairing.label}？该聊天之后可以使用 Chat-Codex。按 y 确认，按 n 取消。`,
      yes: async () => {
        const result = actions.trustRouteManually(pairing.route.routeKey);
        setConfirm(undefined);
        setFlash({ kind: result.ok ? "success" : "error", message: result.message });
        await refresh();
        if (result.ok) setScreen({ name: "pairingDetail", routeKey: result.route.route.routeKey });
      },
    });
  };

  const confirmRevokeTrust = (pairing: PairingRouteSummary, unbindSession: boolean): void => {
    setConfirm({
      message: unbindSession
        ? `确认撤销 ${pairing.label} 的信任并解绑当前 session？Codex session 不会删除。按 y 确认，按 n 取消。`
        : `确认撤销 ${pairing.label} 的信任？session 绑定会保留。按 y 确认，按 n 取消。`,
      yes: async () => {
        const result = actions.revokeRouteTrust(pairing.route.routeKey, { unbindSession });
        setConfirm(undefined);
        setFlash({ kind: result.ok ? "success" : "error", message: result.message });
        await refresh();
        if (result.ok) setScreen({ name: "pairingDetail", routeKey: result.route.route.routeKey });
      },
    });
  };

  const bindSessionTarget = async (target: SessionTarget, sessionId: string): Promise<void> => {
    if (target.kind === "weixinPrimary") {
      const channel = channels.find((item) => item.record.id === target.channelId)?.record;
      if (!channel) return;
      await handleWeixinPrimaryResult(actions.setWeixinPrimaryExisting(channel, sessionId));
      return;
    }
    const result = actions.bindExistingSession(target.routeKey, sessionId);
    setFlash({ kind: result.ok ? "success" : "error", message: result.ok ? `已绑定 session：${formatSession(result.session)}` : result.message });
    await refresh();
  };

  const getSessionChoices = (target: SessionTarget): SessionChoices => {
    if (target.kind === "route") return actions.listSessionChoices(target.routeKey);
    const channel = channels.find((item) => item.record.id === target.channelId)?.record;
    return channel ? actions.listWeixinPrimaryChoices(channel) ?? { selectable: [], unavailable: [] } : { selectable: [], unavailable: [] };
  };

  const body = useMemo(() => {
    if (!dashboard) return <LoadingView title={chatCodexTitle()} message="正在加载状态..." />;
    if (screen.name === "home") return <HomeView dashboard={dashboard} selected={selected} />;
    if (screen.name === "channels") return <ChannelsView channels={channels} selected={selected} channelCursor={channelCursor} />;
    if (screen.name === "channelDetail") return <ChannelDetailView channel={currentChannel} selected={selected} />;
    if (screen.name === "channelRename") return <ChannelRenameView channel={currentChannel} value={manualValue || currentChannel?.record.displayName || ""} onChange={setManualValue} onSubmit={async (value) => {
      await saveChannelName(screen.channelId, value);
    }} />;
    if (screen.name === "addWeixin") return <AddWeixinView screen={screen} loading={loading} />;
    if (screen.name === "weixinBinding") {
      const channel = channels.find((item) => item.record.id === screen.channelId)?.record;
      return <WeixinBindingView channel={channel} choices={channel ? actions.listWeixinPrimaryChoices(channel) : undefined} selected={selected} />;
    }
    if (screen.name === "addFeishu") return <AddFeishuView screen={screen} onSubmit={submitFeishuValue} />;
    if (screen.name === "bindings") return <BindingsView bindings={bindings} pendingBindings={pendingBindings} selected={selected} />;
    if (screen.name === "bindingDetail") return <BindingDetailView binding={currentBinding} selected={selected} />;
    if (screen.name === "pairing") return <PairingView pairing={dashboard.pairing} selected={selected} />;
    if (screen.name === "pairingDetail") return <PairingDetailView pairing={currentPairing} selected={selected} />;
    if (screen.name === "sessionSelect") return <SessionSelectView target={screen.target} choices={getSessionChoices(screen.target)} selected={selected} binding={screen.target.kind === "route" ? actions.getBinding(screen.target.routeKey) : undefined} />;
    if (screen.name === "manualSession") return <ManualSessionView value={manualValue} onChange={setManualValue} onSubmit={async (value) => {
      await bindSessionTarget(screen.target, value.trim());
      setScreen(screen.target.kind === "route" ? { name: "bindingDetail", routeKey: screen.target.routeKey } : { name: "weixinBinding", channelId: screen.target.channelId });
    }} />;
    if (screen.name === "permission") return <PermissionView target={screen.target} startupPolicy={actions.getStartup().policy} sessionPolicy={screen.target.kind === "session" ? actions.getSessionPermission(screen.target.session.id) : undefined} selected={selected} />;
    if (screen.name === "workdir") return <WorkdirView cwd={actions.getStartup().cwd} processCwd={actions.getCurrentProcessWorkdir()} selected={selected} />;
    if (screen.name === "workdirInput") return <WorkdirInputView value={manualValue} onChange={setManualValue} onSubmit={async (value) => {
      await saveWorkdir(value.trim());
      setScreen({ name: "workdir" });
    }} />;
    if (screen.name === "status") return <StatusView dashboard={dashboard} />;
    if (screen.name === "startConfirm") return <StartConfirmView validation={dashboard.canStart} lines={dashboard.canStart.ok ? actions.startConfirmationSummary(dashboard.canStart.channels) : [dashboard.canStart.message]} />;
    return <HelpView />;
  }, [actions, bindings, channelCursor, channels, currentBinding, currentChannel, currentPairing, dashboard, loading, manualValue, screen, selected]);
  const footerContext = screen.name === "home" && channels.length === 0
    ? "firstRun"
    : screen.name === "channels" && channels.length === 0
      ? "emptyChannels"
      : undefined;

  return (
    <Box flexDirection="column">
      {body}
      {confirm ? <ConfirmBar message={confirm.message} /> : (
        <Footer
          loading={loading}
          flash={flash}
          screen={screen.name}
          context={footerContext}
        />
      )}
    </Box>
  );
}

function maxSelectableIndex(screen: Screen, channels: LauncherDashboard["channels"], bindingItemCount: number): number {
  if (screen.name === "channels") return channels.length > 0 ? channels.length + 6 : 1;
  if (screen.name === "bindings") return Math.max(0, bindingItemCount - 1);
  if (screen.name === "home") return channels.length === 0 ? 4 : 6;
  if (screen.name === "channelDetail") return 4;
  if (screen.name === "bindingDetail") return 3;
  if (screen.name === "pairingDetail") return 2;
  if (screen.name === "permission") return 1;
  if (screen.name === "workdir") return 1;
  return 30;
}

function numericPick(input: string, length: number): number | undefined {
  if (!/^\d+$/.test(input)) return undefined;
  const value = Number.parseInt(input, 10);
  if (value < 1 || value > length) return undefined;
  return value - 1;
}

function nextFeishuStep(step: Extract<Screen, { name: "addFeishu" }>["step"]): Extract<Screen, { name: "addFeishu" }>["step"] | undefined {
  if (step === "appId") return "appSecret";
  if (step === "appSecret") return "accountId";
  return undefined;
}

function defaultForFeishuStep(step: Extract<Screen, { name: "addFeishu" }>["step"]): string {
  return "";
}

function weixinAutoCheckIntervalMs(): number {
  const raw = process.env.CHAT_CODEX_TUI_WEIXIN_LOGIN_CHECK_INTERVAL_MS;
  const value = raw ? Number.parseInt(raw, 10) : 5_000;
  return Number.isFinite(value) && value > 0 ? value : 5_000;
}
