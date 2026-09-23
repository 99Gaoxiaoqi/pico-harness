import {
  APICallError,
  InvalidResponseDataError,
  JSONParseError,
  StreamProviderError,
  TypeValidationError,
} from "ai";
import {
  LLMStatusError,
  ModelCommunicationError,
  type ModelCommunicationCategory,
  type ModelResponseDiagnostic,
} from "@pico/core";

/** Classify SDK errors without retaining their untrusted names, messages, data or causes. */
export function modelCommunicationError(
  error: unknown,
  diagnostic: ModelResponseDiagnostic,
  fallback: ModelCommunicationCategory,
): Error {
  let category = fallback;
  let sdkError: ModelResponseDiagnostic["sdkError"];
  let transportCode: ModelResponseDiagnostic["transportCode"];
  let sdkRetryable = false;
  // The SDK unwraps fetch TypeError into APICallError with the socket error as its cause.
  // Classify the safe cause code instead of the wrapper type; never return a raw TypeError.
  for (let cause: unknown = error, depth = 0; cause && depth < 8; depth++) {
    if (cause instanceof ModelCommunicationError || cause instanceof LLMStatusError) return cause;
    if (cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError"))
      return cause;
    const code = typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
    if (typeof code === "string" && isSafeTransportCode(code)) transportCode = code;
    if (JSONParseError.isInstance(cause) || cause instanceof SyntaxError) {
      category = "invalid_json";
      sdkError = JSONParseError.isInstance(cause) ? "JSONParseError" : (sdkError ?? "SyntaxError");
    } else if (TypeValidationError.isInstance(cause)) {
      category = "invalid_response";
      sdkError = "TypeValidationError";
    } else if (InvalidResponseDataError.isInstance(cause)) {
      category =
        cause.message === "Expected 'id' to be a string." ||
        cause.message === "Expected 'function.name' to be a string."
          ? "invalid_tool_call"
          : "invalid_response";
      sdkError = "InvalidResponseDataError";
    } else if (StreamProviderError.isInstance(cause)) {
      category = "stream_error";
      sdkError = "StreamProviderError";
    } else if (APICallError.isInstance(cause)) {
      sdkError ??= "APICallError";
      sdkRetryable ||= cause.isRetryable === true;
    }
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return new ModelCommunicationError(category, {
    ...diagnostic,
    ...(sdkError ? { sdkError } : {}),
    ...(sdkRetryable ? { sdkRetryable } : {}),
    ...(transportCode ? { transportCode } : {}),
  });
}

/** Whitelist only protocol identifiers; never persist an untrusted code verbatim. */
function isSafeTransportCode(
  code: string,
): code is NonNullable<ModelResponseDiagnostic["transportCode"]> {
  return (
    /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EPIPE|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)$/.test(
      code,
    ) || /^(?:UND_ERR|ERR_SSL|ERR_TLS)_[A-Z0-9_]{1,64}$/.test(code)
  );
}
