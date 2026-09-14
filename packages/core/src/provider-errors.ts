/** HTTP 状态码错误，带 statusCode 供调用侧进行精确判定。 */
export class LLMStatusError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "LLMStatusError";
    this.statusCode = statusCode;
  }
}

/** 跨 Provider 的上下文超限语义；压缩层据此进行响应式降级。 */
export class ContextOverflowError extends LLMStatusError {
  constructor(message: string) {
    super(400, message);
    this.name = "ContextOverflowError";
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
