import type {
  CodexModelOption,
  CodexModelPolicy,
  CodexModelServiceTier,
  CodexReasoningEffort,
  CodexReasoningEffortOption,
  CodexSessionContextUsage,
  CodexSessionModelInfo,
  CodexSessionStatus,
} from "../types.js";
import { arrayValue, numberValue, objectValue, stringValue } from "./value-parsers.js";

export function cloneModelPolicy(policy: CodexModelPolicy): CodexModelPolicy {
  return { ...policy };
}

export function withoutModelInfo(status: CodexSessionStatus): CodexSessionStatus {
  const { model: _model, ...rest } = status;
  return rest;
}

export function modelInfoWithPolicy(
  model: CodexSessionModelInfo | undefined,
  policy: CodexModelPolicy,
): CodexSessionModelInfo | undefined {
  if (!model && !policy.model && policy.serviceTier === undefined && !policy.reasoningEffort) return undefined;
  return {
    ...(model ?? {}),
    ...(policy.model ? { model: policy.model } : {}),
    ...(policy.serviceTier !== undefined ? { serviceTier: policy.serviceTier } : {}),
    ...(policy.reasoningEffort ? { reasoningEffort: policy.reasoningEffort } : {}),
  };
}

export function modelInfoFromResponse(
  response: Record<string, unknown>,
  thread: Record<string, unknown>,
): CodexSessionModelInfo | undefined {
  const model = stringValue(response.model) ?? stringValue(thread.model);
  const provider = stringValue(response.modelProvider) ?? stringValue(thread.modelProvider);
  const serviceTier = hasValue(response, "serviceTier") ? stringValue(response.serviceTier) ?? null
    : hasValue(thread, "serviceTier") ? stringValue(thread.serviceTier) ?? null : undefined;
  const reasoningEffort = Object.prototype.hasOwnProperty.call(response, "reasoningEffort")
    ? stringValue(response.reasoningEffort) ?? null
    : hasValue(thread, "reasoningEffort") ? stringValue(thread.reasoningEffort) ?? null : undefined;
  if (!model && !provider && serviceTier === undefined && reasoningEffort === undefined) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}

export function modelsFromListResponse(response: Record<string, unknown>): CodexModelOption[] {
  return arrayValue(response.data)
    .map(modelOptionFromValue)
    .filter((model): model is CodexModelOption => Boolean(model));
}

function modelOptionFromValue(value: unknown): CodexModelOption | undefined {
  const object = objectValue(value);
  const id = stringValue(object.id);
  const model = stringValue(object.model);
  if (!id || !model) return undefined;
  const supportedReasoningEfforts = arrayValue(object.supportedReasoningEfforts ?? object.supported_reasoning_efforts)
    .map(reasoningEffortOptionFromValue)
    .filter((option): option is CodexReasoningEffortOption => Boolean(option));
  const defaultReasoningEffort = reasoningEffortValue(object.defaultReasoningEffort ?? object.default_reasoning_effort);
  if (defaultReasoningEffort && !supportedReasoningEfforts.some((option) => option.reasoningEffort === defaultReasoningEffort)) {
    supportedReasoningEfforts.push({ reasoningEffort: defaultReasoningEffort });
  }
  const serviceTiers = arrayValue(object.serviceTiers ?? object.service_tiers)
    .map(modelServiceTierFromValue)
    .filter((tier): tier is CodexModelServiceTier => Boolean(tier));
  const defaultServiceTier = hasValue(object, "defaultServiceTier") || hasValue(object, "default_service_tier")
    ? stringValue(object.defaultServiceTier ?? object.default_service_tier) ?? null
    : undefined;
  const inputModalities = arrayValue(object.inputModalities ?? object.input_modalities)
    .map((item) => stringValue(item))
    .filter((item): item is string => Boolean(item));
  const supportsPersonality = typeof object.supportsPersonality === "boolean"
    ? object.supportsPersonality
    : typeof object.supports_personality === "boolean"
      ? object.supports_personality
      : undefined;
  const upgrade = hasValue(object, "upgrade")
    ? stringValue(object.upgrade) ?? null
    : undefined;
  const upgradeInfo = hasValue(object, "upgradeInfo")
    ? object.upgradeInfo
    : hasValue(object, "upgrade_info")
      ? object.upgrade_info
      : undefined;
  const availabilityNux = hasValue(object, "availabilityNux")
    ? object.availabilityNux
    : hasValue(object, "availability_nux")
      ? object.availability_nux
      : undefined;
  return {
    id,
    model,
    displayName: stringValue(object.displayName ?? object.display_name) ?? model,
    ...(stringValue(object.description) ? { description: stringValue(object.description) } : {}),
    ...(upgrade !== undefined ? { upgrade } : {}),
    ...(upgradeInfo !== undefined ? { upgradeInfo } : {}),
    ...(availabilityNux !== undefined ? { availabilityNux } : {}),
    ...(hasValue(object, "modelSpecialty") ? { modelSpecialty: stringValue(object.modelSpecialty) ?? null } : {}),
    ...(hasValue(object, "multiAgentVersion") ? { multiAgentVersion: stringValue(object.multiAgentVersion) ?? null } : {}),
    ...(hasValue(object, "availableAccessPrograms") ? { availableAccessPrograms: object.availableAccessPrograms == null ? null : objectValue(object.availableAccessPrograms) } : {}),
    hidden: object.hidden === true,
    supportedReasoningEfforts,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(inputModalities.length > 0 ? { inputModalities } : {}),
    ...(supportsPersonality !== undefined ? { supportsPersonality } : {}),
    ...(hasValue(object, "serviceTiers") || hasValue(object, "service_tiers") ? { serviceTiers } : {}),
    ...(defaultServiceTier !== undefined ? { defaultServiceTier } : {}),
    ...(typeof object.isDefault === "boolean" ? { isDefault: object.isDefault } : {}),
  };
}

function reasoningEffortOptionFromValue(value: unknown): CodexReasoningEffortOption | undefined {
  if (typeof value === "string") {
    const effort = reasoningEffortValue(value);
    return effort ? { reasoningEffort: effort } : undefined;
  }
  const object = objectValue(value);
  const reasoningEffort = reasoningEffortValue(object.reasoningEffort ?? object.reasoning_effort);
  if (!reasoningEffort) return undefined;
  return {
    reasoningEffort,
    ...(stringValue(object.description) ? { description: stringValue(object.description) } : {}),
  };
}

function modelServiceTierFromValue(value: unknown): CodexModelServiceTier | undefined {
  const object = objectValue(value);
  const id = stringValue(object.id);
  if (!id) return undefined;
  return {
    id,
    ...(stringValue(object.name) ? { name: stringValue(object.name) } : {}),
    ...(stringValue(object.description) ? { description: stringValue(object.description) } : {}),
  };
}

function reasoningEffortValue(value: unknown): CodexReasoningEffort | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isReasoningEffortValue(normalized) ? normalized : undefined;
}

function isReasoningEffortValue(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}

function hasValue(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function parseTokenUsage(value: Record<string, unknown>): CodexSessionContextUsage | undefined {
  const total = parseTokenUsageBreakdown(objectValue(value.total));
  const last = parseTokenUsageBreakdown(objectValue(value.last));
  if (!total || !last) return undefined;
  return {
    total,
    last,
    modelContextWindow: numberValue(value.modelContextWindow) ?? null,
  };
}

function parseTokenUsageBreakdown(value: Record<string, unknown>): CodexSessionContextUsage["total"] | undefined {
  const totalTokens = numberValue(value.totalTokens);
  const inputTokens = numberValue(value.inputTokens);
  const cachedInputTokens = numberValue(value.cachedInputTokens);
  const outputTokens = numberValue(value.outputTokens);
  const reasoningOutputTokens = numberValue(value.reasoningOutputTokens);
  if (
    totalTokens === undefined
    || inputTokens === undefined
    || cachedInputTokens === undefined
    || outputTokens === undefined
    || reasoningOutputTokens === undefined
  ) {
    return undefined;
  }
  return { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens };
}
