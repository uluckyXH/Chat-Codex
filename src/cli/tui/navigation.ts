import type { ContextRefreshMode } from "../../context-refresh/types.js";
import type { LauncherActions, LauncherDashboard } from "../actions/launcher-actions.js";
import type { ContextRefreshTarget, Screen } from "./types.js";

export function maxSelectableIndex(screen: Screen, channels: LauncherDashboard["channels"], bindingItemCount: number): number {
  if (screen.name === "channels") return channels.length > 0 ? channels.length + 6 : 1;
  if (screen.name === "bindings") return Math.max(0, bindingItemCount - 1);
  if (screen.name === "home") return channels.length === 0 ? 5 : 7;
  if (screen.name === "channelDetail") {
    const channel = channels.find((item) => item.record.id === screen.channelId);
    return channel?.record.type === "feishu" || channel?.record.type === "lark" ? 5 : 4;
  }
  if (screen.name === "bindingDetail") return 4;
  if (screen.name === "pairingDetail") return 2;
  if (screen.name === "permission") return 1;
  if (screen.name === "contextRefresh") return screen.target.kind === "route" ? 3 : 2;
  if (screen.name === "workdir") return 1;
  return 30;
}

export function numericPick(input: string, length: number): number | undefined {
  if (!/^\d+$/.test(input)) return undefined;
  const value = Number.parseInt(input, 10);
  if (value < 1 || value > length) return undefined;
  return value - 1;
}

export function contextRefreshModeForIndex(kind: ContextRefreshTarget["kind"], index: number): ContextRefreshMode | undefined {
  if (kind === "route") {
    if (index === 1) return "off";
    if (index === 2) return "detect";
    if (index === 3) return "reload";
    return undefined;
  }
  if (index === 0) return "off";
  if (index === 1) return "detect";
  if (index === 2) return "reload";
  return undefined;
}

export function formatCurrentContextRefresh(actions: LauncherActions, target: ContextRefreshTarget): string {
  if (target.kind === "default") {
    return actions.formatContextRefreshPolicy(actions.getContextRefreshDefaults());
  }
  return actions.formatContextRefreshEffectivePolicy(actions.getRouteContextRefreshEffectivePolicy(target.routeKey));
}

export function nextFeishuStep(step: Extract<Screen, { name: "addFeishu" }>["step"]): Extract<Screen, { name: "addFeishu" }>["step"] | undefined {
  if (step === "appId") return "appSecret";
  if (step === "appSecret") return "accountId";
  return undefined;
}

export function defaultForFeishuStep(_step: Extract<Screen, { name: "addFeishu" }>["step"]): string {
  return "";
}

export function weixinAutoCheckIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CHAT_CODEX_TUI_WEIXIN_LOGIN_CHECK_INTERVAL_MS;
  const value = raw ? Number.parseInt(raw, 10) : 5_000;
  return Number.isFinite(value) && value > 0 ? value : 5_000;
}
