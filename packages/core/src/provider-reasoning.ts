import type { ProviderProtocol } from "./provider-profile.js";

export type ReasoningCapabilitySource = "config" | "provider_metadata" | "model_rule" | "unknown";
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

/** Declarative, protocol-specific edits applied to a final provider request body. */
export interface ReasoningRequestPatch {
  set?: readonly RequestBodySetOperation[];
  unset?: readonly RequestBodyPath[];
}

export type ReasoningProtocolOptions = Partial<
  Readonly<Record<ProviderProtocol, ReasoningRequestPatch>>
>;

/** JSON-configurable model reasoning metadata. */
export interface ModelReasoningCapabilityConfig {
  enabled: boolean;
  defaultLevel?: ReasoningLevel;
  levels?: readonly ReasoningLevel[];
  providerOptionsByLevel?: Readonly<Record<ReasoningLevel, ReasoningProtocolOptions>>;
}

export type ModelReasoningCapabilityInput = ModelReasoningCapabilityConfig;

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
  /** Explicit route configuration has highest priority. */
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
