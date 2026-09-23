/** HTTP 状态码错误，带 statusCode 供调用侧进行精确判定。 */
export class LLMStatusError extends Error {
  readonly statusCode: number;
  readonly retryAfterMs?: number;

  constructor(statusCode: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "LLMStatusError";
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 跨 Provider 的上下文超限语义；压缩层据此进行响应式降级。 */
export class ContextOverflowError extends LLMStatusError {
  constructor(message: string) {
    super(400, message);
    this.name = "ContextOverflowError";
  }
}

const COMMUNICATION_MESSAGES = {
  request_failed: "模型请求失败，未获得 HTTP 响应",
  invalid_json: "模型响应不是有效的 JSON",
  invalid_response: "模型响应格式不符合协议",
  invalid_tool_call: "模型返回的工具调用缺少必要标识或名称",
  stream_error: "模型服务在响应流中返回错误",
  incomplete_stream: "模型响应流未正常完成",
  rejected_completion: "模型响应以错误状态结束",
  unknown: "模型通信失败，原因尚未分类",
} as const;

export type ModelCommunicationCategory = keyof typeof COMMUNICATION_MESSAGES;

/** Locally produced metadata only: never include remote messages, bodies or arbitrary headers. */
export interface ModelResponseDiagnostic {
  readonly diagnosticId: string;
  readonly durationMs: number;
  readonly httpStatus?: number;
  readonly headersMs?: number;
  /** First SDK data/error event, not server TTFB; a local error can precede any HTTP response. */
  readonly firstChunkMs?: number;
  readonly rawFinishReason?:
    | "stop"
    | "length"
    | "tool_calls"
    | "content_filter"
    | "error"
    | "unknown";
  readonly finishReason?: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "other";
  readonly sdkError?:
    | "APICallError"
    | "JSONParseError"
    | "TypeValidationError"
    | "InvalidResponseDataError"
    | "StreamProviderError"
    | "SyntaxError";
  /** SDK's own transport retry verdict, used only before an HTTP response. */
  readonly sdkRetryable?: boolean;
  /** Any text, reasoning, or tool data already produced by this attempt. */
  readonly observableOutput?: boolean;
  readonly transportCode?:
    | "ECONNRESET"
    | "ECONNREFUSED"
    | "ECONNABORTED"
    | "EHOSTUNREACH"
    | "ENETUNREACH"
    | "EPIPE"
    | "ENOTFOUND"
    | "EAI_AGAIN"
    | "ETIMEDOUT"
    | "UND_ERR_CONNECT_TIMEOUT"
    | "UND_ERR_HEADERS_TIMEOUT"
    | "UND_ERR_BODY_TIMEOUT"
    | "UND_ERR_SOCKET"
    | `UND_ERR_${string}`
    | `ERR_SSL_${string}`
    | `ERR_TLS_${string}`;
}

/** Safe diagnostics retain enough transport facts for the explicit, bounded retry policy. */
export class ModelCommunicationError extends Error {
  readonly diagnostic: Readonly<ModelResponseDiagnostic>;

  constructor(
    readonly category: ModelCommunicationCategory,
    diagnostic: ModelResponseDiagnostic,
  ) {
    super(
      `${COMMUNICATION_MESSAGES[category]}；诊断编号 ${diagnostic.diagnosticId}（请求及响应内容已省略）`,
    );
    this.name = "ModelCommunicationError";
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

export type ModelCapabilityErrorCode = "context_window" | "vision" | "reasoning" | "tool_call";

/** A deterministic route mismatch detected before any provider network request. */
export class ModelCapabilityError extends Error {
  constructor(
    readonly routeId: string,
    readonly code: ModelCapabilityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelCapabilityError";
  }
}

/** 上下文超限的供应商错误文本特征。 */
export const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context[ _-]?length/,
  /(?:context[ _-]?window.*exceed|exceed.*context[ _-]?window)/,
  /maximum context/,
  /exceed(?:ed|s|ing)?\s+(?:the\s+)?max(?:imum)?\s+tokens?/,
  /(?:too many tokens.*(?:prompt|input|context)|(?:prompt|input|context).*too many tokens)/,
  /prompt is too long.*maximum/,
  /input token count.*exceeds?.*maximum number of tokens/,
  /request.*exceed(?:ed|s|ing)?.*model token limit/,
];

/** 状态码在溢出白名单 [400,413,422] 且消息命中任一特征时，判定为上下文溢出。 */
export function isContextOverflowStatus(statusCode: number, message: string): boolean {
  if (statusCode !== 400 && statusCode !== 413 && statusCode !== 422) return false;
  const lower = message.toLowerCase();
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(lower));
}

/** 判定是否为宿主主动取消产生的 AbortError。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** 判定是否为 Node.js AbortSignal.timeout() 产生的 TimeoutError。 */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}
