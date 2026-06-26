// 结构化错误类型:把 provider 抛裸 Error、status 埋字符串里的现状,
// 升级为可精确判定的类型,为"模型调用重试"与"溢出响应式压缩"两个特性铺路。
// 设计参考 kimi-code packages/kosong/src/errors.ts 的错误归一化思路。

/** HTTP 状态码错误,带 statusCode 便于上层精确判定 429 / 5xx 等。 */
export class LLMStatusError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "LLMStatusError";
    this.statusCode = statusCode;
  }
}

/**
 * 上下文超限错误。overflow 在不同厂商可能用 400 / 413 / 422 不同状态码返回,
 * 这里统一用子类表达"上下文超限"语义,供压缩层用 instanceof 精确识别并触发降级。
 * 真实状态码已写入 message,statusCode 字段仅占位以维持与父类契约一致。
 */
export class ContextOverflowError extends LLMStatusError {
  constructor(message: string) {
    super(400, message);
    this.name = "ContextOverflowError";
  }
}

/** 上下文溢出的消息特征正则集合(复用 kimi-code 的经验模式)。 */
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

/** 状态码在溢出白名单 [400,413,422] 且消息命中任一特征正则,判定为上下文溢出。 */
export function isContextOverflowStatus(statusCode: number, message: string): boolean {
  if (statusCode !== 400 && statusCode !== 413 && statusCode !== 422) return false;
  const lower = message.toLowerCase();
  return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(lower));
}

/** 判定是否为 fetch / AbortSignal.timeout 产生的中止错误。 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
