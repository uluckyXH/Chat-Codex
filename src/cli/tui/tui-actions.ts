import type { Dispatch, SetStateAction } from "react";
import type { CodexRunPolicy } from "../../codex/codex-cli.js";
import type { FeishuCredentials } from "../../channels/feishu/feishu-types.js";
import type { BindingSummary } from "../actions/binding-actions.js";
import { formatManagedChannelLabel, isChannelGroupReceiveEnabled } from "../actions/channel-actions.js";
import {
  feishuCredentialDefaults,
  type FeishuBotSetupResult,
  type LauncherActions,
  type LauncherDashboard,
  type PairingRouteSummary,
} from "../actions/launcher-actions.js";
import type { PermissionTarget, Screen, SessionTarget } from "./types.js";
import { screenIs } from "./types.js";
import { formatSession } from "./ui-components.js";
import { nextFeishuStep } from "./navigation.js";
import type { TuiConfirm } from "./use-chat-codex-tui-controller.js";

export interface TuiActionsContext {
  actions: LauncherActions;
  screen: Screen;
  dashboard: LauncherDashboard | undefined;
  channels: LauncherDashboard["channels"];
  setScreen: Dispatch<SetStateAction<Screen>>;
  setDashboard: Dispatch<SetStateAction<LauncherDashboard | undefined>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setFlash: Dispatch<SetStateAction<{ kind: "info" | "success" | "error"; message: string }>>;
  setConfirm: Dispatch<SetStateAction<TuiConfirm | undefined>>;
  setManualValue: Dispatch<SetStateAction<string>>;
  refresh(message?: string): Promise<void>;
}

export interface TuiActionHandlers {
  openNeedsAttention(): void;
  handleWeixinPrimaryResult(result: ReturnType<LauncherActions["setWeixinPrimaryNew"]>): Promise<void>;
  submitFeishuValue(value: string): Promise<void>;
  savePermission(target: PermissionTarget, policy: CodexRunPolicy): Promise<void>;
  saveWorkdir(value: string | undefined, createIfMissing?: boolean): Promise<void>;
  createAndBind(routeKey: string): Promise<void>;
  openRenameChannel(channelId: string): void;
  saveChannelName(channelId: string, value: string): Promise<void>;
  confirmToggleGroupReceive(channel: LauncherDashboard["channels"][number]): void;
  confirmRemoveChannel(channel: LauncherDashboard["channels"][number]): void;
  confirmUnbind(binding: BindingSummary): void;
  confirmManualTrust(pairing: PairingRouteSummary): void;
  confirmRevokeTrust(pairing: PairingRouteSummary, unbindSession: boolean): void;
  bindSessionTarget(target: SessionTarget, sessionId: string): Promise<void>;
}

export function createTuiActions({
  actions,
  screen,
  dashboard,
  channels,
  setScreen,
  setDashboard,
  setLoading,
  setFlash,
  setConfirm,
  setManualValue,
  refresh,
}: TuiActionsContext): TuiActionHandlers {
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

  const handleWeixinPrimaryResult = async (result: ReturnType<LauncherActions["setWeixinPrimaryNew"]>): Promise<void> => {
    setFlash({ kind: result.ok ? "success" : "error", message: result.message });
    await refresh();
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

  const confirmToggleGroupReceive = (channel: LauncherDashboard["channels"][number]): void => {
    const next = !isChannelGroupReceiveEnabled(channel.record);
    setConfirm({
      message: next
        ? [
            `确认开启 ${formatManagedChannelLabel(channel)} 的群聊接收？`,
            "开启后，飞书群聊 @机器人 会进入 Chat-Codex 配对流程；每个群仍需单独配对。",
            "按 y 确认，按 n 取消。",
          ].join(" ")
        : [
            `确认关闭 ${formatManagedChannelLabel(channel)} 的群聊接收？`,
            "关闭后，Chat-Codex 将忽略飞书群聊消息；已有群 route、配对、权限和 session 绑定会保留。",
            "按 y 确认，按 n 取消。",
          ].join(" "),
      yes: async () => {
        const updated = await actions.setChannelGroupEnabled(channel.record.id, next);
        if (updated) {
          setDashboard((current) => current
            ? {
                ...current,
                channels: current.channels.map((item) => item.record.id === updated.record.id ? updated : item),
              }
            : current);
        }
        setConfirm(undefined);
        setFlash({
          kind: updated ? "success" : "error",
          message: updated ? `已${next ? "开启" : "关闭"}飞书群聊接收。` : "这个渠道已经不存在。",
        });
        await refresh();
      },
    });
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

  return {
    openNeedsAttention,
    handleWeixinPrimaryResult,
    submitFeishuValue,
    savePermission,
    saveWorkdir,
    createAndBind,
    openRenameChannel,
    saveChannelName,
    confirmToggleGroupReceive,
    confirmRemoveChannel,
    confirmUnbind,
    confirmManualTrust,
    confirmRevokeTrust,
    bindSessionTarget,
  };
}
