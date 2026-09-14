// 兼容旧模块路径；模型 reasoning 规则与通用策略由 @pico/runtime 持有。
export {
  applyReasoningRequestPatch,
  applyRequestBodyPatch,
  coordinateReasoningLevel,
  reasoningRequestPatchForLevel,
  reasoningRuleForModel,
  resolveModelReasoningCapability,
} from "@pico/runtime";
export type {
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ModelReasoningCapabilityConfig,
  ModelReasoningCapabilityInput,
  ReasoningCapabilitySource,
  ReasoningLevel,
  ReasoningLevelSelection,
  ReasoningLevelSelectionReason,
  ReasoningProtocolOptions,
  ReasoningRequestPatch,
  RequestBodyPath,
  RequestBodySetOperation,
  ResolvedModelReasoningCapability,
  ResolveModelReasoningCapabilityOptions,
} from "@pico/core";
