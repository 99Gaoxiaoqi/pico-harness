import {
  ContextOverflowError,
  isAbortError,
  isTimeoutError,
  LLMStatusError,
  ModelCommunicationError,
} from "@pico/core";

/** 可重试的 HTTP 状态码：限流与常见瞬时 5xx。 */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

// Only failures before any HTTP response are safe for transport recovery. DNS misses,
// refused connections and response-body failures are deliberately excluded.
const RETRYABLE_TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export type ProviderFailureStatus = "timed_out" | "cancelled" | "error";

export interface ProviderErrorClassification {
  status: ProviderFailureStatus;
  retryable: boolean;
}

/** 默认 Provider 重试判定：不重试取消与上下文溢出；受控 HTTP、响应前传输错误及外部 Provider TypeError 可重试。 */
export function defaultIsRetryableError(error: unknown): boolean {
  return classifyProviderError(error).retryable;
}

/** 把 Provider 错误统一分类，供 Runtime 与外层重试编排区分超时、取消和普通失败。 */
export function classifyProviderError(error: unknown): ProviderErrorClassification {
  if (isTimeoutError(error)) return { status: "timed_out", retryable: true };
  if (isAbortError(error)) return { status: "cancelled", retryable: false };
  if (error instanceof ContextOverflowError) return { status: "error", retryable: false };
  if (error instanceof LLMStatusError) {
    return { status: "error", retryable: RETRYABLE_STATUS_CODES.has(error.statusCode) };
  }
  if (error instanceof ModelCommunicationError) {
    return {
      status: "error",
      retryable:
        error.category === "request_failed" &&
        error.diagnostic.httpStatus === undefined &&
        error.diagnostic.headersMs === undefined &&
        error.diagnostic.transportCode !== undefined &&
        RETRYABLE_TRANSPORT_CODES.has(error.diagnostic.transportCode),
    };
  }
  return { status: "error", retryable: error instanceof TypeError };
}
