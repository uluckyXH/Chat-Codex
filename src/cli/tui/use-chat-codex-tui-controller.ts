import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { SessionChoices } from "../actions/binding-actions.js";
import type { LauncherActions, LauncherDashboard, PairingRouteSummary } from "../actions/launcher-actions.js";
import { SESSION_SELECT_PAGE_SIZE, sessionPage as buildSessionPage } from "./session-pagination.js";
import type { Flash, Screen, SessionTarget } from "./types.js";
import { screenIs } from "./types.js";
import { maxSelectableIndex, weixinAutoCheckIntervalMs } from "./navigation.js";

export interface TuiConfirm {
  message: string;
  yes: () => void | Promise<void>;
}

export type BindingItem =
  | { kind: "route"; binding: LauncherDashboard["bindings"][number] }
  | { kind: "pending"; pending: LauncherDashboard["pendingBindings"][number] };

export interface ChatCodexTuiController {
  screen: Screen;
  setScreen: Dispatch<SetStateAction<Screen>>;
  dashboard: LauncherDashboard | undefined;
  setDashboard: Dispatch<SetStateAction<LauncherDashboard | undefined>>;
  loading: boolean;
  setLoading: Dispatch<SetStateAction<boolean>>;
  selected: number;
  setSelected: Dispatch<SetStateAction<number>>;
  sessionPageIndex: number;
  setSessionPageIndex: Dispatch<SetStateAction<number>>;
  channelCursor: number;
  setChannelCursor: Dispatch<SetStateAction<number>>;
  flash: Flash;
  setFlash: Dispatch<SetStateAction<Flash>>;
  confirm: TuiConfirm | undefined;
  setConfirm: Dispatch<SetStateAction<TuiConfirm | undefined>>;
  manualValue: string;
  setManualValue: Dispatch<SetStateAction<string>>;
  channels: LauncherDashboard["channels"];
  bindings: LauncherDashboard["bindings"];
  pendingBindings: LauncherDashboard["pendingBindings"];
  pairings: PairingRouteSummary[];
  bindingItems: BindingItem[];
  currentChannel: LauncherDashboard["channels"][number] | undefined;
  currentBinding: LauncherDashboard["bindings"][number] | undefined;
  currentPairing: PairingRouteSummary | undefined;
  refresh(message?: string): Promise<void>;
  getSessionChoices(target: SessionTarget): SessionChoices;
  getMaxSelectableIndex(): number;
  moveSessionPage(delta: number): boolean;
  openAddWeixinLogin(): Promise<void>;
  checkWeixinLoginResult(): Promise<void>;
  cancelWeixinLogin(): void;
}

export function useChatCodexTuiController(actions: LauncherActions): ChatCodexTuiController {
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const [dashboard, setDashboard] = useState<LauncherDashboard>();
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const [sessionPageIndex, setSessionPageIndex] = useState(0);
  const [channelCursor, setChannelCursor] = useState(0);
  const [flash, setFlash] = useState<Flash>({ kind: "info", message: "按 ? 查看快捷键。" });
  const [confirm, setConfirm] = useState<TuiConfirm>();
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
    setSessionPageIndex(0);
    if (screen.name === "weixinBinding") {
      const channel = channels.find((item) => item.record.id === screen.channelId)?.record;
      const selectableCount = channel ? actions.listWeixinPrimaryChoices(channel)?.selectable.length ?? 0 : 0;
      setSelected(Math.min(selectableCount, SESSION_SELECT_PAGE_SIZE));
    } else {
      setSelected(screen.name === "home" && (dashboard?.channels.length ?? 0) > 0 ? 7 : 0);
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

  const bindingItems: BindingItem[] = [
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

  const getSessionChoices = (target: SessionTarget): SessionChoices => {
    if (target.kind === "route") return actions.listSessionChoices(target.routeKey);
    const channel = channels.find((item) => item.record.id === target.channelId)?.record;
    return channel ? actions.listWeixinPrimaryChoices(channel) ?? { selectable: [], unavailable: [] } : { selectable: [], unavailable: [] };
  };

  const getMaxSelectableIndex = (): number => {
    if (screen.name === "sessionSelect") {
      const page = buildSessionPage(getSessionChoices(screen.target).selectable, sessionPageIndex);
      return Math.max(0, page.items.length - 1);
    }
    if (screen.name === "weixinBinding") {
      const channel = channels.find((item) => item.record.id === screen.channelId)?.record;
      const choices = channel ? actions.listWeixinPrimaryChoices(channel) : undefined;
      const page = buildSessionPage(choices?.selectable ?? [], sessionPageIndex);
      return Math.max(0, page.items.length + 3 - 1);
    }
    if (screen.name === "pairing") return Math.max(0, pairings.length - 1);
    if (screen.name === "pairingDetail") return currentPairing?.trusted ? 2 : 1;
    if (screen.name === "bindingDetail" && currentBinding?.trusted === false) return 1;
    return maxSelectableIndex(screen, channels, bindingItems.length);
  };

  const moveSessionPage = (delta: number): boolean => {
    if (screen.name !== "sessionSelect" && screen.name !== "weixinBinding") return false;
    const choices = screen.name === "sessionSelect"
      ? getSessionChoices(screen.target)
      : (() => {
          const channel = channels.find((item) => item.record.id === screen.channelId)?.record;
          return channel ? actions.listWeixinPrimaryChoices(channel) ?? { selectable: [], unavailable: [] } : { selectable: [], unavailable: [] };
        })();
    const currentPage = buildSessionPage(choices.selectable, sessionPageIndex);
    const nextPage = buildSessionPage(choices.selectable, currentPage.page + delta);
    const actionCount = screen.name === "weixinBinding" ? 3 : 0;
    if (nextPage.page === currentPage.page) return true;
    const selectedActionIndex = selected >= currentPage.items.length ? selected - currentPage.items.length : undefined;
    const nextMax = Math.max(0, nextPage.items.length + actionCount - 1);
    setSessionPageIndex(nextPage.page);
    if (selectedActionIndex !== undefined) {
      setSelected(Math.min(nextPage.items.length + selectedActionIndex, nextMax));
    } else {
      setSelected(Math.min(selected, Math.max(0, nextPage.items.length - 1)));
    }
    return true;
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

  const cancelWeixinLogin = (): void => {
    weixinLoginRequest.current += 1;
    const result = actions.cancelWeixinLogin();
    setFlash({ kind: "info", message: result.message });
    setLoading(false);
    setScreen({ name: "channels" });
  };

  return {
    screen,
    setScreen,
    dashboard,
    setDashboard,
    loading,
    setLoading,
    selected,
    setSelected,
    sessionPageIndex,
    setSessionPageIndex,
    channelCursor,
    setChannelCursor,
    flash,
    setFlash,
    confirm,
    setConfirm,
    manualValue,
    setManualValue,
    channels,
    bindings,
    pendingBindings,
    pairings,
    bindingItems,
    currentChannel,
    currentBinding,
    currentPairing,
    refresh,
    getSessionChoices,
    getMaxSelectableIndex,
    moveSessionPage,
    openAddWeixinLogin,
    checkWeixinLoginResult,
    cancelWeixinLogin,
  };
}
