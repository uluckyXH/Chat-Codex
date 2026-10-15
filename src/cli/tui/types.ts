import type { FeishuCredentials } from "../../channels/feishu/feishu-types.js";
import type { ClipboardWriteResult } from "../../runtime/clipboard.js";
import type { ChannelInstanceRecord } from "../../state/persistent-state-types.js";
import type { SessionDisplay } from "../actions/binding-actions.js";
import type { LauncherActions } from "../actions/launcher-actions.js";

export interface ChatCodexTuiResult {
  start: boolean;
}

export interface ChatCodexTuiProps {
  actions: LauncherActions;
  onDone(result: ChatCodexTuiResult): void;
  copyToClipboard?(text: string): Promise<ClipboardWriteResult>;
}

export type Screen =
  | { name: "home" }
  | { name: "channels" }
  | { name: "channelDetail"; channelId: string }
  | { name: "channelRename"; channelId: string }
  | { name: "addWeixin"; login?: import("../actions/launcher-actions.js").WeixinLoginSession }
  | { name: "weixinBinding"; channelId: string }
  | { name: "addFeishu"; step: FeishuInputStep; values: Partial<FeishuCredentials> }
  | { name: "bindings" }
  | { name: "bindingDetail"; routeKey: string }
  | { name: "groupAccess"; routeKey: string }
  | { name: "pairing" }
  | { name: "pairingDetail"; routeKey: string }
  | { name: "sessionSelect"; target: SessionTarget }
  | { name: "manualSession"; target: SessionTarget }
  | { name: "permission"; target: PermissionTarget }
  | { name: "contextRefresh"; target: ContextRefreshTarget }
  | { name: "workdir" }
  | { name: "workdirInput" }
  | { name: "status" }
  | { name: "startConfirm" }
  | { name: "help" };

export type FeishuInputStep = "appId" | "appSecret" | "accountId";

export type SessionTarget =
  | { kind: "route"; routeKey: string }
  | { kind: "weixinPrimary"; channelId: string };

export type PermissionTarget =
  | { kind: "default" }
  | { kind: "session"; routeKey: string; session: SessionDisplay };

export type ContextRefreshTarget =
  | { kind: "default" }
  | { kind: "route"; routeKey: string };

export type Flash = { kind: "info" | "success" | "error"; message: string };

export function screenIs<Name extends Screen["name"]>(name: Name, screen: Screen): screen is Extract<Screen, { name: Name }> {
  return screen.name === name;
}

export function screenChannelId(screen: Screen): string | undefined {
  if (screen.name === "weixinBinding") return screen.channelId;
  return undefined;
}

export function channelIdFromRecord(record: ChannelInstanceRecord): string {
  return record.id;
}
