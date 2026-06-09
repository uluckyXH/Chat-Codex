import React from "react";
import type { BindingSummary, SessionChoices } from "../actions/binding-actions.js";
import type { LauncherActions, LauncherDashboard, PairingRouteSummary } from "../actions/launcher-actions.js";
import { chatCodexTitle } from "../../runtime/package-info.js";
import type { Screen, SessionTarget } from "./types.js";
import { formatCurrentContextRefresh } from "./navigation.js";
import {
  AddFeishuView,
  AddWeixinView,
  BindingDetailView,
  BindingsView,
  ChannelDetailView,
  ChannelRenameView,
  ContextRefreshView,
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

export interface RenderTuiScreenProps {
  actions: LauncherActions;
  screen: Screen;
  dashboard: LauncherDashboard | undefined;
  channels: LauncherDashboard["channels"];
  bindings: LauncherDashboard["bindings"];
  pendingBindings: LauncherDashboard["pendingBindings"];
  currentChannel: LauncherDashboard["channels"][number] | undefined;
  currentBinding: BindingSummary | undefined;
  currentPairing: PairingRouteSummary | undefined;
  channelCursor: number;
  loading: boolean;
  manualValue: string;
  selected: number;
  sessionPageIndex: number;
  setManualValue(value: string): void;
  setScreen(screen: Screen): void;
  submitFeishuValue(value: string): Promise<void>;
  bindSessionTarget(target: SessionTarget, sessionId: string): Promise<void>;
  saveChannelName(channelId: string, value: string): Promise<void>;
  saveWorkdir(value: string | undefined, createIfMissing?: boolean): Promise<void>;
  getSessionChoices(target: SessionTarget): SessionChoices;
}

export function renderTuiScreen({
  actions,
  screen,
  dashboard,
  channels,
  bindings,
  pendingBindings,
  currentChannel,
  currentBinding,
  currentPairing,
  channelCursor,
  loading,
  manualValue,
  selected,
  sessionPageIndex,
  setManualValue,
  setScreen,
  submitFeishuValue,
  bindSessionTarget,
  saveChannelName,
  saveWorkdir,
  getSessionChoices,
}: RenderTuiScreenProps): React.JSX.Element {
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
    return <WeixinBindingView channel={channel} choices={channel ? actions.listWeixinPrimaryChoices(channel) : undefined} selected={selected} page={sessionPageIndex} />;
  }
  if (screen.name === "addFeishu") return <AddFeishuView screen={screen} onSubmit={submitFeishuValue} />;
  if (screen.name === "bindings") return <BindingsView bindings={bindings} pendingBindings={pendingBindings} selected={selected} />;
  if (screen.name === "bindingDetail") return <BindingDetailView binding={currentBinding} selected={selected} />;
  if (screen.name === "pairing") return <PairingView pairing={dashboard.pairing} selected={selected} />;
  if (screen.name === "pairingDetail") return <PairingDetailView pairing={currentPairing} selected={selected} />;
  if (screen.name === "sessionSelect") return <SessionSelectView target={screen.target} choices={getSessionChoices(screen.target)} selected={selected} page={sessionPageIndex} binding={screen.target.kind === "route" ? actions.getBinding(screen.target.routeKey) : undefined} />;
  if (screen.name === "manualSession") return <ManualSessionView value={manualValue} onChange={setManualValue} onSubmit={async (value) => {
    await bindSessionTarget(screen.target, value.trim());
    setScreen(screen.target.kind === "route" ? { name: "bindingDetail", routeKey: screen.target.routeKey } : { name: "weixinBinding", channelId: screen.target.channelId });
  }} />;
  if (screen.name === "permission") return <PermissionView target={screen.target} startupPolicy={actions.getStartup().policy} sessionPolicy={screen.target.kind === "session" ? actions.getSessionPermission(screen.target.session.id) : undefined} selected={selected} />;
  if (screen.name === "contextRefresh") return <ContextRefreshView target={screen.target} current={formatCurrentContextRefresh(actions, screen.target)} selected={selected} />;
  if (screen.name === "workdir") return <WorkdirView cwd={actions.getStartup().cwd} processCwd={actions.getCurrentProcessWorkdir()} selected={selected} />;
  if (screen.name === "workdirInput") return <WorkdirInputView value={manualValue} onChange={setManualValue} onSubmit={async (value) => {
    await saveWorkdir(value.trim());
    setScreen({ name: "workdir" });
  }} />;
  if (screen.name === "status") return <StatusView dashboard={dashboard} />;
  if (screen.name === "startConfirm") return <StartConfirmView validation={dashboard.canStart} lines={dashboard.canStart.ok ? actions.startConfirmationSummary(dashboard.canStart.channels) : [dashboard.canStart.message]} />;
  return <HelpView />;
}
