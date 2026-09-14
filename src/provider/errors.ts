// 兼容旧模块路径；Provider 错误分类是跨层稳定契约，由 @pico/core 持有。
export {
  CONTEXT_OVERFLOW_PATTERNS,
  ContextOverflowError,
  isAbortError,
  isContextOverflowStatus,
  isTimeoutError,
  LLMStatusError,
  ModelCapabilityError,
} from "@pico/core";
export type { ModelCapabilityErrorCode } from "@pico/core";
