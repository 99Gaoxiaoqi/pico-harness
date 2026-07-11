import type { ProviderProtocol } from "./profile.js";

export type ReasoningCapabilitySource =
  | "config"
  | "provider_metadata"
  | "model_rule"
  | "legacy_boolean"
  | "unknown";

export type ReasoningLevel = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

/** A path into the final provider HTTP request body. Array indexes are intentionally unsupported. */
export type RequestBodyPath = readonly [string, ...string[]];

export interface RequestBodySetOperation {
  path: RequestBodyPath;
  value: JsonValue;
}

/** Declarative, protocol-specific edits applied to the final HTTP request body. */
export interface ReasoningRequestPatch {
  set?: readonly RequestBodySetOperation[];
  unset?: readonly RequestBodyPath[];
}

export type ReasoningProtocolOptions = Partial<
  Readonly<Record<ProviderProtocol, ReasoningRequestPatch>>
>;

/** JSON-configurable model reasoning metadata. A boolean remains accepted for legacy configs. */
export interface ModelReasoningCapabilityConfig {
  enabled: boolean;
  defaultLevel?: ReasoningLevel;
  levels?: readonly ReasoningLevel[];
  providerOptionsByLevel?: Readonly<Record<ReasoningLevel, ReasoningProtocolOptions>>;
}

export type ModelReasoningCapabilityInput = boolean | ModelReasoningCapabilityConfig;

export interface ResolvedModelReasoningCapability {
  /** Whether the model is known to reason. "unknown" never invents controls. */
  enabled: boolean | "unknown";
  /** Empty means reasoning is fixed/model-controlled or its controls are unknown. */
  levels: readonly ReasoningLevel[];
  defaultLevel?: ReasoningLevel;
  providerOptionsByLevel: Readonly<Record<ReasoningLevel, ReasoningProtocolOptions>>;
  source: ReasoningCapabilitySource;
}

export interface ResolveModelReasoningCapabilityOptions {
  /** Project configuration has highest priority when it is structured or explicitly false. */
  config?: ModelReasoningCapabilityInput;
  /** Optional metadata returned by a provider model catalog. */
  providerMetadata?: ModelReasoningCapabilityInput;
}

export type ReasoningLevelSelectionReason = "requested" | "default" | "fallback" | "not_adjustable";

export interface ReasoningLevelSelection {
  level?: ReasoningLevel;
  changed: boolean;
  reason: ReasoningLevelSelectionReason;
}

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

const GLM_5_2_REASONING = modelRule(["nothink", "high", "max"], "max", {
  nothink: {
    openai: patch(
      [["chat_template_kwargs", "enable_thinking"], false],
      [["reasoning_effort"], ["chat_template_kwargs", "reasoning_effort"]],
    ),
    claude: patch([["thinking", "type"], "disabled"]),
    gemini: patch([["generationConfig", "thinkingConfig", "thinkingBudget"], 0]),
  },
  high: {
    openai: patch(
      [["chat_template_kwargs", "enable_thinking"], true],
      [["chat_template_kwargs", "reasoning_effort"], "high"],
      [["reasoning_effort"]],
    ),
    claude: patch(
      [["thinking", "type"], "enabled"],
      [["thinking", "budget_tokens"], 16_000],
      [["output_config", "effort"], "high"],
    ),
    gemini: patch([["generationConfig", "thinkingConfig", "thinkingBudget"], 16_000]),
  },
  max: {
    openai: patch(
      [["chat_template_kwargs", "enable_thinking"], true],
      [["chat_template_kwargs", "reasoning_effort"], "max"],
      [["reasoning_effort"]],
    ),
    claude: patch(
      [["thinking", "type"], "enabled"],
      [["thinking", "budget_tokens"], 32_000],
      [["output_config", "effort"], "max"],
    ),
    gemini: patch([["generationConfig", "thinkingConfig", "thinkingBudget"], 32_000]),
  },
});

const DEEPSEEK_V4_REASONING = modelRule(["off", "high", "max"], "max", {
  off: {
    openai: patch([["thinking", "type"], "disabled"], [["reasoning_effort"]]),
    claude: patch([["thinking", "type"], "disabled"]),
    gemini: patch([["generationConfig", "thinkingConfig", "thinkingBudget"], 0]),
  },
  high: {
    openai: patch([["thinking", "type"], "enabled"], [["reasoning_effort"], "high"]),
    claude: patch([["thinking", "type"], "enabled"], [["thinking", "budget_tokens"], 16_000]),
    gemini: patch([["generationConfig", "thinkingConfig", "thinkingBudget"], 16_000]),
  },
  max: {
    openai: patch([["thinking", "type"], "enabled"], [["reasoning_effort"], "max"]),
    claude: patch([["thinking", "type"], "enabled"], [["thinking", "budget_tokens"], 32_000]),
    gemini: patch([["generationConfig", "thinkingConfig", "thinkingBudget"], 32_000]),
  },
});

/**
 * Resolve model reasoning controls without treating a legacy `reasoning: true` as proof that
 * low/medium/high controls exist. Structured config and provider metadata are authoritative;
 * family rules fill known catalogs, while an ordinary true value only records fixed support.
 */
export function resolveModelReasoningCapability(
  _protocol: ProviderProtocol,
  model: string,
  options: ResolveModelReasoningCapabilityOptions = {},
): ResolvedModelReasoningCapability {
  const rule = reasoningRuleForModel(model);
  const config = authoritativeCapability(options.config, "config", rule);
  if (config) return config;

  const providerMetadata = authoritativeCapability(
    options.providerMetadata,
    "provider_metadata",
    rule,
  );
  if (providerMetadata) return providerMetadata;

  if (rule) return rule;

  const legacy = legacyCapability(options.config ?? options.providerMetadata);
  if (legacy) return legacy;

  return {
    enabled: "unknown",
    levels: [],
    providerOptionsByLevel: {},
    source: "unknown",
  };
}

/** Match stable model families while accepting dotted, dashed, dated and provider-prefixed IDs. */
export function reasoningRuleForModel(model: string): ResolvedModelReasoningCapability | undefined {
  const normalized = normalizeModelFamily(model);
  if (/(?:^|[/:_-])glm[-_.]?5[-_.]?2(?:$|[-_.:/])/u.test(normalized)) {
    return GLM_5_2_REASONING;
  }
  if (/(?:^|[/:_-])deepseek[-_.]?v4(?:$|[-_.:/])/u.test(normalized)) {
    return DEEPSEEK_V4_REASONING;
  }
  return undefined;
}

/**
 * Preserve a selected level across model switches when possible. Otherwise choose the model's
 * declared default (or its first level). Fixed/unknown reasoning has no selectable level.
 */
export function coordinateReasoningLevel(
  capability: ResolvedModelReasoningCapability,
  requestedLevel?: string,
): ReasoningLevelSelection {
  if (capability.enabled !== true || capability.levels.length === 0) {
    return {
      changed: requestedLevel !== undefined,
      reason: "not_adjustable",
    };
  }

  const requested = requestedLevel?.trim().toLowerCase();
  const matched = requested
    ? capability.levels.find((level) => level.toLowerCase() === requested)
    : undefined;
  if (matched) return { level: matched, changed: false, reason: "requested" };

  const fallback = capability.defaultLevel ?? capability.levels[0];
  return {
    ...(fallback ? { level: fallback } : {}),
    changed: requestedLevel !== undefined && requestedLevel !== fallback,
    reason: requestedLevel === undefined ? "default" : "fallback",
  };
}

export function reasoningRequestPatchForLevel(
  capability: ResolvedModelReasoningCapability,
  level: string | undefined,
  protocol: ProviderProtocol,
): ReasoningRequestPatch | undefined {
  if (!level) return undefined;
  const canonicalLevel = capability.levels.find(
    (candidate) => candidate.toLowerCase() === level.trim().toLowerCase(),
  );
  return canonicalLevel ? capability.providerOptionsByLevel[canonicalLevel]?.[protocol] : undefined;
}

/** Return a patched clone; the caller's request object is never mutated. */
export function applyRequestBodyPatch<T extends object>(
  body: T,
  requestPatch: ReasoningRequestPatch | undefined,
): T {
  if (!requestPatch) return body;
  const result = cloneJsonObject(body);
  for (const path of requestPatch.unset ?? []) unsetPath(result, path);
  for (const operation of requestPatch.set ?? []) {
    setPath(result, operation.path, operation.value);
  }
  return result as T;
}

export function applyReasoningRequestPatch<T extends object>(
  body: T,
  capability: ResolvedModelReasoningCapability,
  level: string | undefined,
  protocol: ProviderProtocol,
): T {
  return applyRequestBodyPatch(body, reasoningRequestPatchForLevel(capability, level, protocol));
}

function authoritativeCapability(
  input: ModelReasoningCapabilityInput | undefined,
  source: "config" | "provider_metadata",
  fallback?: ResolvedModelReasoningCapability,
): ResolvedModelReasoningCapability | undefined {
  if (input === false) return fixedCapability(false, source);
  if (typeof input !== "object") return undefined;
  return normalizeStructuredCapability(input, source, fallback);
}

function legacyCapability(
  input: ModelReasoningCapabilityInput | undefined,
): ResolvedModelReasoningCapability | undefined {
  return input === true ? fixedCapability(true, "legacy_boolean") : undefined;
}

function fixedCapability(
  enabled: boolean,
  source: "config" | "provider_metadata" | "legacy_boolean",
): ResolvedModelReasoningCapability {
  return { enabled, levels: [], providerOptionsByLevel: {}, source };
}

function normalizeStructuredCapability(
  input: ModelReasoningCapabilityConfig,
  source: "config" | "provider_metadata",
  fallback?: ResolvedModelReasoningCapability,
): ResolvedModelReasoningCapability {
  if (!input.enabled) return fixedCapability(false, source);
  const levels = uniqueLevels(input.levels ?? []);
  const defaultLevel =
    findLevel(levels, input.defaultLevel) ?? findLevel(levels, fallback?.defaultLevel) ?? levels[0];
  const providerOptionsByLevel: Record<string, ReasoningProtocolOptions> = {};
  for (const level of levels) {
    const fallbackOptions = fallback?.providerOptionsByLevel[level];
    const options = input.providerOptionsByLevel?.[level];
    if (fallbackOptions || options) {
      providerOptionsByLevel[level] = { ...fallbackOptions, ...options };
    }
  }
  return {
    enabled: true,
    levels,
    ...(defaultLevel ? { defaultLevel } : {}),
    providerOptionsByLevel,
    source,
  };
}

function modelRule(
  levels: readonly string[],
  defaultLevel: string,
  providerOptionsByLevel: Readonly<Record<string, ReasoningProtocolOptions>>,
): ResolvedModelReasoningCapability {
  return Object.freeze({
    enabled: true,
    levels: Object.freeze([...levels]),
    defaultLevel,
    providerOptionsByLevel: Object.freeze(providerOptionsByLevel),
    source: "model_rule" as const,
  });
}

function patch(
  ...operations: readonly (readonly [RequestBodyPath, JsonValue] | readonly RequestBodyPath[])[]
): ReasoningRequestPatch {
  const set: RequestBodySetOperation[] = [];
  const unset: RequestBodyPath[] = [];
  for (const operation of operations) {
    if (isSetTuple(operation)) set.push({ path: operation[0], value: operation[1] });
    else unset.push(...operation);
  }
  return {
    ...(set.length > 0 ? { set } : {}),
    ...(unset.length > 0 ? { unset } : {}),
  };
}

function isSetTuple(
  operation: readonly [RequestBodyPath, JsonValue] | readonly RequestBodyPath[],
): operation is readonly [RequestBodyPath, JsonValue] {
  return operation.length === 2 && !Array.isArray(operation[1]);
}

function normalizeModelFamily(model: string): string {
  return model.trim().toLowerCase().replace(/\s+/gu, "");
}

function uniqueLevels(levels: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of levels) {
    const level = raw.trim();
    const normalized = level.toLowerCase();
    if (!level || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(level);
  }
  return result;
}

function findLevel(levels: readonly string[], level: string | undefined): string | undefined {
  const normalized = level?.trim().toLowerCase();
  return normalized
    ? levels.find((candidate) => candidate.toLowerCase() === normalized)
    : undefined;
}

function cloneJsonObject(body: object): Record<string, unknown> {
  return { ...(body as Record<string, unknown>) };
}

function unsetPath(target: Record<string, unknown>, path: RequestBodyPath): void {
  validatePath(path);
  let cursor: Record<string, unknown> = target;
  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment];
    if (!isPlainRecord(next)) return;
    const clone = { ...next };
    cursor[segment] = clone;
    cursor = clone;
  }
  delete cursor[path[path.length - 1]!];
}

function setPath(target: Record<string, unknown>, path: RequestBodyPath, value: JsonValue): void {
  validatePath(path);
  let cursor = target;
  for (const segment of path.slice(0, -1)) {
    const existing = cursor[segment];
    if (isPlainRecord(existing)) {
      const clone = { ...existing };
      cursor[segment] = clone;
      cursor = clone;
    } else {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
    }
  }
  cursor[path[path.length - 1]!] = value;
}

function validatePath(path: RequestBodyPath): void {
  if (path.length === 0 || path.some((segment) => !segment || UNSAFE_PATH_SEGMENTS.has(segment))) {
    throw new Error(`Unsafe reasoning request patch path: ${path.join(".")}`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
