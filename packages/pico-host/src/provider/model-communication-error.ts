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
  for (let cause: unknown = error, depth = 0; cause && depth < 8; depth++) {
    if (cause instanceof ModelCommunicationError || cause instanceof LLMStatusError) return cause;
    if (cause instanceof TypeError) return new TypeError("模型网络请求失败；已省略连接及响应详情");
    if (cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError"))
      return cause;
    const code = typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
    if (
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN" ||
      code === "ETIMEDOUT" ||
      code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "UND_ERR_HEADERS_TIMEOUT" ||
      code === "UND_ERR_BODY_TIMEOUT" ||
      code === "UND_ERR_SOCKET"
    )
      transportCode = code;
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
    }
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return new ModelCommunicationError(category, {
    ...diagnostic,
    ...(sdkError ? { sdkError } : {}),
    ...(transportCode ? { transportCode } : {}),
  });
}
