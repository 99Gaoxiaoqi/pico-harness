import type {
  JsonValue,
  ModelReasoningCapabilityConfig,
  ModelReasoningCapabilityInput,
  ProviderProtocol,
  ReasoningProtocolOptions,
  ReasoningRequestPatch,
  RequestBodyPath,
  RequestBodySetOperation,
  ResolvedModelReasoningCapability,
  ResolveModelReasoningCapabilityOptions,
} from "@pico/core";

const GLM_5_2_REASONING = modelRule(["nothink", "high", "max"], "max", {
  nothink: {
    openai: patch(
      [["chat_template_kwargs", "enable_thinking"], false],
      [["reasoning_effort"], ["chat_template_kwargs", "reasoning_effort"]],
    ),
    claude: patch([["thinking", "type"], "disabled"]),
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
  },
});

const DEEPSEEK_V4_REASONING = modelRule(["off", "high", "max"], "max", {
  off: {
    responses: patch([["reasoning", "effort"], "none"]),
    openai: patch([["thinking", "type"], "disabled"], [["reasoning_effort"]]),
    claude: patch([["thinking", "type"], "disabled"]),
  },
  high: {
    responses: patch([["reasoning", "effort"], "high"]),
    openai: patch([["thinking", "type"], "enabled"], [["reasoning_effort"], "high"]),
    claude: patch([["thinking", "type"], "enabled"], [["thinking", "budget_tokens"], 16_000]),
  },
  max: {
    responses: patch([["reasoning", "effort"], "max"]),
    openai: patch([["thinking", "type"], "enabled"], [["reasoning_effort"], "max"]),
    claude: patch([["thinking", "type"], "enabled"], [["thinking", "budget_tokens"], 32_000]),
  },
});

/** Structured config and provider metadata are authoritative; family rules fill known catalogs. */
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

  return { enabled: "unknown", levels: [], providerOptionsByLevel: {}, source: "unknown" };
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

function authoritativeCapability(
  input: ModelReasoningCapabilityInput | undefined,
  source: "config" | "provider_metadata",
  fallback?: ResolvedModelReasoningCapability,
): ResolvedModelReasoningCapability | undefined {
  return input ? normalizeStructuredCapability(input, source, fallback) : undefined;
}

function fixedCapability(
  enabled: boolean,
  source: "config" | "provider_metadata",
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
