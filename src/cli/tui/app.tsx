import React from "react";
import { Box, useApp, useInput } from "ink";
import { writeClipboardText as writeClipboardTextDefault } from "../../runtime/clipboard.js";
import type { ChatCodexTuiProps } from "./types.js";
import { ConfirmBar, Footer } from "./ui-components.js";
import { renderTuiScreen } from "./screen-renderer.js";
import { useChatCodexTuiController } from "./use-chat-codex-tui-controller.js";
import { createTuiActions } from "./tui-actions.js";
import { handleTuiInput } from "./input-handlers.js";

export function ChatCodexTui({ actions, onDone, copyToClipboard = writeClipboardTextDefault }: ChatCodexTuiProps): React.JSX.Element {
  const { exit } = useApp();
  const {
    screen,
    setScreen,
    dashboard,
    setDashboard,
    loading,
    setLoading,
    selected,
    setSelected,
    sessionPageIndex,
    channelCursor,
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
  } = useChatCodexTuiController(actions);

  const quit = (): void => {
    onDone({ start: false });
    exit();
  };

  const start = (): void => {
    onDone({ start: true });
    exit();
  };

  const goHome = (): void => setScreen({ name: "home" });

  const tuiActions = createTuiActions({
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
  });
  const {
    submitFeishuValue,
    saveWorkdir,
    saveChannelName,
    bindSessionTarget,
  } = tuiActions;

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
      cancelWeixinLogin();
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
    if (screen.name === "contextRefresh" && screen.target.kind === "route") {
      setScreen({ name: "bindingDetail", routeKey: screen.target.routeKey });
      return;
    }
    if (screen.name === "permission" && screen.target.kind === "session") {
      setScreen({ name: "bindingDetail", routeKey: screen.target.routeKey });
      return;
    }
    goHome();
  };

  useInput((input, key) => {
    handleTuiInput({
      actions,
      screen,
      setScreen,
      loading,
      selected,
      setSelected,
      sessionPageIndex,
      channelCursor,
      confirm,
      setConfirm,
      channels,
      pairings,
      bindingItems,
      currentChannel,
      currentBinding,
      currentPairing,
      setFlash,
      refresh,
      getSessionChoices,
      getMaxSelectableIndex,
      moveSessionPage,
      openAddWeixinLogin,
      checkWeixinLoginResult,
      copyToClipboard,
      back,
      goHome,
      quit,
      start,
      tuiActions,
    }, input, key);
  });

  const body = renderTuiScreen({
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
  });
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
