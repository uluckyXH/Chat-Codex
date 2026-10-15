import type { AppServerSessionRecord } from "./types.js";
import type { CodexEffectiveSettings } from "../types.js";
import { objectValue, stringValue } from "./value-parsers.js";

/** Consume only present fields: null clears a setting, absence keeps older-server compatibility. */
export function applyEffectiveSettings(record: AppServerSessionRecord, value: Record<string, unknown>): void {
  const settings: CodexEffectiveSettings = { ...record.status.effectiveSettings };
  const has = (key: string) => Object.prototype.hasOwnProperty.call(value, key);
  if (Array.isArray(value.runtimeWorkspaceRoots)) settings.runtimeWorkspaceRoots = value.runtimeWorkspaceRoots.filter((root): root is string => typeof root === "string");
  if (has("approvalPolicy")) settings.approvalPolicy = value.approvalPolicy;
  if (has("approvalsReviewer")) settings.approvalsReviewer = stringValue(value.approvalsReviewer) ?? null;
  if (has("sandboxPolicy") || has("sandbox")) settings.sandboxPolicy = objectValue(value.sandboxPolicy ?? value.sandbox);
  if (has("activePermissionProfile")) {
    const profile = objectValue(value.activePermissionProfile);
    settings.activePermissionProfile = stringValue(profile.id) ? { id: String(profile.id), extends: stringValue(profile.extends) ?? null } : null;
  }
  if (has("collaborationMode")) settings.collaborationMode = value.collaborationMode == null ? null : objectValue(value.collaborationMode);
  const cwd = stringValue(value.cwd);
  if (cwd) record.session.cwd = cwd;
  const model = { ...record.baseModel };
  if (stringValue(value.model)) model.model = String(value.model);
  if (stringValue(value.modelProvider)) model.provider = String(value.modelProvider);
  if (has("serviceTier")) model.serviceTier = stringValue(value.serviceTier) ?? null;
  if (has("effort") || has("reasoningEffort")) model.reasoningEffort = stringValue(has("effort") ? value.effort : value.reasoningEffort) ?? null;
  if (Object.keys(model).length) record.baseModel = model;
  record.status = { ...record.status, effectiveSettings: settings, ...(record.baseModel ? { model: { ...record.baseModel } } : {}) };
  record.updatedAt = new Date().toISOString();
}

export function effectiveSandboxName(settings: CodexEffectiveSettings | undefined): string | undefined {
  const type = stringValue(settings?.sandboxPolicy?.type);
  return type === "workspaceWrite" ? "workspace-write" : type === "readOnly" ? "read-only" : type === "dangerFullAccess" ? "danger-full-access" : type;
}
