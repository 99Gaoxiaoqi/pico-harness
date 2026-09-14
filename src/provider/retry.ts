import {
  generateWithRetry as generateWithRuntimeRetry,
  type RetryOptions as RuntimeRetryOptions,
} from "@pico/runtime/provider-retry";
import type { LLMProvider, Message, ToolDefinition } from "@pico/core";
import { logger } from "../observability/logger.js";

export {
  backoffDelays,
  classifyProviderError,
  defaultIsRetryableError,
  DEFAULT_MAX_RETRY_ATTEMPTS,
  registerProviderRequestIdentity,
  sleepForRetry,
} from "@pico/runtime/provider-retry";
export type {
  ProviderErrorClassification,
  ProviderFailureStatus,
  ProviderRequestIdentity,
  RateLimitFailure,
  RetryInfo,
  RetryLogger,
} from "@pico/runtime/provider-retry";

export type RetryOptions = Omit<RuntimeRetryOptions, "logger">;

/** @deprecated 重试内核已迁入 @pico/runtime；旧入口继续绑定 Pico 日志。 */
export function generateWithRetry(
  provider: LLMProvider,
  messages: Message[],
  tools: ToolDefinition[],
  options?: RetryOptions,
): Promise<Message> {
  return generateWithRuntimeRetry(provider, messages, tools, { ...options, logger });
}
