import { objectValue } from "./value-parsers.js";

export function supportedPermissionProfile(value: unknown): boolean {
  if (!isObject(value) || !onlyKeys(value, ["network", "fileSystem"])) return false;
  const network = value.network;
  if (network != null && (!isObject(network) || !onlyKeys(network, ["enabled"]) || (network.enabled != null && typeof network.enabled !== "boolean"))) return false;
  const files = value.fileSystem;
  if (files == null) return true;
  if (!isObject(files) || !onlyKeys(files, ["read", "write", "globScanMaxDepth", "entries"])) return false;
  for (const key of ["read", "write"]) if (files[key] != null && (!Array.isArray(files[key]) || !files[key].every(nonemptyString))) return false;
  if (files.globScanMaxDepth != null && (!Number.isSafeInteger(files.globScanMaxDepth) || Number(files.globScanMaxDepth) < 0)) return false;
  if (files.entries != null && (!Array.isArray(files.entries) || !files.entries.every((entry: unknown) => {
    if (!isObject(entry) || !onlyKeys(entry, ["access", "path"]) || !["read", "write", "deny"].includes(String(entry.access))) return false;
    const path = objectValue(entry.path);
    if (path.type === "path") return onlyKeys(path, ["type", "path"]) && nonemptyString(path.path);
    if (path.type === "glob_pattern") return onlyKeys(path, ["type", "pattern"]) && nonemptyString(path.pattern);
    if (path.type !== "special" || !onlyKeys(path, ["type", "value"])) return false;
    const special = objectValue(path.value);
    return onlyKeys(special, ["kind", "subpath"]) && ["root", "minimal", "project_roots", "tmpdir", "slash_tmp"].includes(String(special.kind))
      && (special.subpath == null || nonemptyString(special.subpath));
  }))) return false;
  return true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.entries(value).every(([key, field]) => keys.includes(key) || field == null);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
