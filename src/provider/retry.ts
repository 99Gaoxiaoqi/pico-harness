// 模型调用重试:在 Provider.generate 之上包裹指数退避 + 抖动,
// 把瞬时故障(429 限流、5xx 抖动、网络抖动)对上层 Main Loop 透明化。
//
// 设计参考 kimi-code packages/agent-core/src/loop/retry.ts 的 chatWithRetry,
// 关键差异:pico-harness 的 provider 多数尚未实现 isRetryableError,
// 因此即便 provider 没有自定义判定,也用 defaultIsRetryableError 兜底继续重试,
// 而非像 kimi-code 那样直接走单次快路径(默认兜底始终生效)。

import type { LLMProvider } from "./interface.js";
import type { Message, ToolDefinition } from "../schema/message.js";
import { ContextOverflowError, isAbortError, LLMStatusError } from "./errors.js";
import { logger } from "../observability/logger.js";

/** 默认最大尝试次数(含首次调用) */
export const DEFAULT_MAX_RETRY_ATTEMPTS = 3;

/** 退避参数:与 kimi-code 对齐 */
const RETRY_MIN_TIMEOUT_MS = 300;
const RETRY_MAX_TIMEOUT_MS = 5000;
const RETRY_FACTOR = 2;

/** 可重试的 HTTP 状态码白名单:限流 + 常见瞬时 5xx */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

export interface RetryOptions {
  /** 最大尝试次数(含首次),默认 3 */
  maxAttempts?: number;
  /** 可选中止信号:已 abort 时不再重试,sleep 期间也响应 abort */
  signal?: AbortSignal;
  /** 重试事件回调:每次决定重试时触发,供上层打点 / Tracing */
  onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
  /** 刚失败的尝试序号(1-based) */
  failedAttempt: number;
  /** 即将进行的下一次尝试序号 */
  nextAttempt: number;
  maxAttempts: number;
  /** 本次退避等待毫秒数 */
  delayMs: number;
  /** 触发重试的错误对象 */
  error: unknown;
  /** 错误携带的 HTTP 状态码(若有) */
  statusCode?: number;
}

/**
 * 在 Provider.generate 之上叠加指数退避重试。
 *
 * 判定优先级:provider 实现了 isRetryableError 时优先用其判定,
 * 否则用 defaultIsRetryableError 兜底(覆盖已改造与未改造 provider)。
 *
 * 不重试的硬性条件:
 * - abort 错误:永不重试(交给调用方处理);
 * - ContextOverflowError:永不重试(交给响应式压缩层降级);
 * - 达到 maxAttempts 上限:抛出最后一次错误。
 *
 * maxAttempts <= 1 走单次快路径(失败即抛,但仍记失败日志)。
 */
export async function generateWithRetry(
  provider: LLMProvider,
  messages: Message[],
  tools: ToolDefinition[],
  options?: RetryOptions,
): Promise<Message> {
  const maxAttempts = Math.max(options?.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS, 1);
  const signal = options?.signal;
  const onRetry = options?.onRetry;
  const hasCustomRetryable = typeof provider.isRetryableError === "function";

  // 快路径:只允许调用一次,失败即抛(兜底失败日志仍记录)
  if (maxAttempts <= 1) {
    try {
      return await provider.generate(messages, tools);
    } catch (error) {
      logRequestFailure(error, 1, maxAttempts, provider.modelName, signal);
      throw error;
    }
  }

  const delays = backoffDelays(maxAttempts);

  // 主循环:尝试 → 失败 → 判定可重试 → 退避 → 再尝试
  for (let attempt = 1; ; attempt++) {
    try {
      return await provider.generate(messages, tools);
    } catch (error) {
      const retryable = hasCustomRetryable
        ? provider.isRetryableError!(error)
        : defaultIsRetryableError(error);

      // 不可重试或已达上限:记失败日志后抛出
      if (attempt >= maxAttempts || !retryable) {
        logRequestFailure(error, attempt, maxAttempts, provider.modelName, signal);
        throw error;
      }

      const delayMs = delays[attempt - 1] ?? 0;

      // 三道防线之一:退避前检查 abort —— 已 abort 则直接抛,不再空等
      signal?.throwIfAborted();

      const info: RetryInfo = {
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
        error,
        statusCode: maybeStatusCode(error),
      };
      onRetry?.(info);

      // 三道防线之二、三:sleep 入睡前 throwIfAborted,sleep 期间可被 abort 唤醒
      await sleepForRetry(delayMs, signal);
    }
  }
}

/**
 * 默认可重试判定兜底(兼容未改造 provider):
 * - abort 错误:不重试(交给调用方)。
 * - ContextOverflowError:不重试(交给响应式压缩层)。
 * - LLMStatusError:statusCode ∈ 白名单则重试。
 * - TypeError:fetch 网络错误,重试。
 * - 裸 Error:从 message 正则提取 [数字] 状态码命中白名单则重试
 *   (兼容未抛 LLMStatusError、把状态码埋字符串里的 provider)。
 */
export function defaultIsRetryableError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof ContextOverflowError) return false;
  if (error instanceof LLMStatusError) {
    return RETRYABLE_STATUS_CODES.has(error.statusCode);
  }
  if (error instanceof Error) {
    // 网络错误:fetch 抛 TypeError("failed to fetch" / "fetch failed")
    if (error instanceof TypeError) return true;
    // 兜底:从 message 提取 [429] 这类状态码,兼容未改造 provider
    const match = /\[(\d{3})]/.exec(error.message);
    if (match && match[1] !== undefined) {
      const code = Number(match[1]);
      if (RETRYABLE_STATUS_CODES.has(code)) return true;
    }
  }
  return false;
}

/**
 * 计算指数退避序列(带抖动)。
 * 对齐 kimi-code 所用 retry 库的 randomize 行为:
 *   base = min(MAX, MIN * FACTOR^i);delay = round(base * Math.random()),clamp [MIN, MAX]。
 * 返回长度 = maxAttempts - 1,索引 i 对应第 i+1 次失败后的退避等待。
 */
export function backoffDelays(maxAttempts: number): number[] {
  const count = Math.max(maxAttempts - 1, 0);
  const delays: number[] = [];
  for (let i = 0; i < count; i++) {
    const base = Math.min(RETRY_MAX_TIMEOUT_MS, RETRY_MIN_TIMEOUT_MS * RETRY_FACTOR ** i);
    const jittered = Math.round(base * Math.random());
    delays.push(Math.max(RETRY_MIN_TIMEOUT_MS, Math.min(RETRY_MAX_TIMEOUT_MS, jittered)));
  }
  return delays;
}

/**
 * 退避 sleep:响应 abort 的三道防线。
 * 入睡前 throwIfAborted;sleep 期间通过监听 abort 事件立即唤醒并 reject。
 */
export async function sleepForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    signal?.throwIfAborted();
    return;
  }
  signal?.throwIfAborted();
  if (signal) {
    await abortableSleep(delayMs, signal);
  } else {
    await sleep(delayMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 可被 abort 唤醒的 sleep:abort 时立即 reject,不熬满整个 delay */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 失败日志:abort 不记 warn(降噪 —— 用户主动取消不该当失败) */
function logRequestFailure(
  error: unknown,
  attempt: number,
  maxAttempts: number,
  model: string | undefined,
  signal?: AbortSignal,
): void {
  if (isAbortError(error) || signal?.aborted) return;
  logger.warn(
    {
      attempt: `${attempt}/${maxAttempts}`,
      model,
      ...retryErrorFields(error),
    },
    `[Retry] 模型调用失败,不再重试`,
  );
}

interface RetryErrorFields {
  errorName: string;
  errorMessage: string;
  statusCode?: number;
}

function retryErrorFields(error: unknown): RetryErrorFields {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    statusCode: maybeStatusCode(error),
  };
}

function maybeStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}
