// 模型调用重试:在 Provider.generate 之上包裹指数退避 + 抖动,
// 把瞬时故障(429 限流、5xx 抖动、网络抖动)对上层 Main Loop 透明化。
//
// 设计参考 kimi-code packages/agent-core/src/loop/retry.ts 的 chatWithRetry,
// 关键差异:pico-harness 的 provider 多数尚未实现 isRetryableError,
// 因此即便 provider 没有自定义判定,也用 defaultIsRetryableError 兜底继续重试,
// 而非像 kimi-code 那样直接走单次快路径(默认兜底始终生效)。

import type { LLMProvider } from "./interface.js";
import type { Message, ToolDefinition } from "../schema/message.js";
import { ContextOverflowError, isAbortError, isTimeoutError, LLMStatusError } from "./errors.js";
import { logger } from "../observability/logger.js";

/** 默认最大尝试次数(含首次调用) */
export const DEFAULT_MAX_RETRY_ATTEMPTS = 3;

/** 退避参数:与 kimi-code 对齐 */
const RETRY_MIN_TIMEOUT_MS = 300;
const RETRY_MAX_TIMEOUT_MS = 5000;
const RETRY_FACTOR = 2;

/** Provider 内部超时代价较高，单次调用最多额外重试一次。 */
const MAX_TIMEOUT_RETRIES = 1;

/** 可重试的 HTTP 状态码白名单:限流 + 常见瞬时 5xx */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

export interface RetryOptions {
  /** 最大尝试次数(含首次),默认 3 */
  maxAttempts?: number;
  /** 可选中止信号:已 abort 时不再重试,sleep 期间也响应 abort */
  signal?: AbortSignal;
  /** 重试事件回调:每次决定重试时触发,供上层打点 / Tracing */
  onRetry?: (info: RetryInfo) => void;
  /**
   * 凭证轮换回调(可选):遇到 429 限流时触发,供上层标记当前 key 限流、
   * 切换到下一个 key 重建 provider。返回新的 provider(已切换 key),
   * 或返回 undefined 表示无多凭证可轮换(回退到同 key 指数退避)。
   * 仅当配置了多 key(CredentialPool)时由调用方注入。
   */
  onRateLimited?: (failure: RateLimitFailure) => LLMProvider | undefined;
}

export interface RateLimitFailure {
  /** 真正发出失败请求的 provider（可能不是当前已切换的全局 provider）。 */
  failedProvider: LLMProvider;
  /** 原始 429 错误。 */
  error: unknown;
  /** 发出失败请求的凭证；只用于轮换，不应写入日志。 */
  failedCredential?: string;
  /** 发出失败请求的路由。 */
  failedRouteId?: string;
  /** 发出失败请求的模型。 */
  failedModel?: string;
}

export interface ProviderRequestIdentity {
  provider: LLMProvider;
  credential?: string;
  routeId?: string;
  model?: string;
}

export type ProviderFailureStatus = "timed_out" | "cancelled" | "error";

export interface ProviderErrorClassification {
  status: ProviderFailureStatus;
  retryable: boolean;
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
  /** 统一失败分类，上层可据此区分超时与取消。 */
  failureStatus: ProviderFailureStatus;
}

const providerRequestIdentities = new WeakMap<object, ProviderRequestIdentity>();
let activeRateLimitFailure: RateLimitFailure | undefined;

/** @internal 将实际失败路由绑定到错误，避免并发轮换误用全局当前路由。 */
export function registerProviderRequestIdentity(
  error: unknown,
  identity: ProviderRequestIdentity,
): void {
  if (typeof error === "object" && error !== null) {
    providerRequestIdentities.set(error, identity);
  }
}

/**
 * @internal 兼容当前 Engine 的无参 rebuildProvider 桥接。
 * onRateLimited 是同步回调，因此栈式恢复可以保证并发调用不串路由。
 */
export function currentRateLimitFailure(): RateLimitFailure | undefined {
  return activeRateLimitFailure;
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
  const onRateLimited = options?.onRateLimited;
  let timeoutRetries = 0;

  // 快路径:只允许调用一次,失败即抛(兜底失败日志仍记录)
  if (maxAttempts <= 1) {
    try {
      const result = await provider.generate(messages, tools, { signal });
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      logRequestFailure(error, 1, maxAttempts, provider.modelName, signal);
      throw error;
    }
  }

  const delays = backoffDelays(maxAttempts);
  // 当前活跃 provider(凭证轮换时可能被替换);初始为传入的 provider
  let activeProvider = provider;

  // 主循环:尝试 → 失败 → 判定可重试 → 退避 → 再尝试
  for (let attempt = 1; ; attempt++) {
    try {
      if (attempt > 1) signal?.throwIfAborted();
      const result = await activeProvider.generate(messages, tools, { signal });
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      // Provider 可能不支持中途取消；若它在 abort 后才返回/抛错，
      // 优先恢复宿主的 AbortError 语义，不把它误判成普通重试失败。
      signal?.throwIfAborted();
      const classification = classifyProviderError(error);
      const retryable = isHardClassifiedError(error)
        ? classification.retryable
        : typeof activeProvider.isRetryableError === "function"
          ? activeProvider.isRetryableError(error)
          : classification.retryable;
      const timeoutRetryLimitReached =
        classification.status === "timed_out" && timeoutRetries >= MAX_TIMEOUT_RETRIES;

      // 不可重试或已达上限:记失败日志后抛出
      if (attempt >= maxAttempts || !retryable || timeoutRetryLimitReached) {
        logRequestFailure(error, attempt, maxAttempts, activeProvider.modelName, signal);
        throw error;
      }

      if (classification.status === "timed_out") timeoutRetries++;

      // 凭证轮换(429 限流特化):若错误是 429 且注入了 onRateLimited,
      // 标记当前 key 限流、切换到下一个可用 key 重建 provider 重试。
      // 切换成功后跳过退避(新 key 通常立即可用),直接重试;
      // 切换失败(无多 key / 全限流)→ 回退到同 key 指数退避。
      if (maybeStatusCode(error) === 429 && onRateLimited) {
        const rotated = invokeRateLimitHandler(
          onRateLimited,
          buildRateLimitFailure(activeProvider, error),
        );
        if (rotated && rotated !== activeProvider) {
          logger.warn(
            { attempt: `${attempt}/${maxAttempts}`, keyRotated: true },
            `[Retry] 429 限流,已切换凭证重试`,
          );
          activeProvider = rotated;
          continue; // 新 key 立即可用,跳过退避
        }
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
        failureStatus: classification.status,
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
  return classifyProviderError(error).retryable;
}

/** 把 Provider 错误统一分类，供上层区分超时、主动取消与普通失败。 */
export function classifyProviderError(error: unknown): ProviderErrorClassification {
  if (isTimeoutError(error)) return { status: "timed_out", retryable: true };
  if (isAbortError(error)) return { status: "cancelled", retryable: false };
  return { status: "error", retryable: isDefaultRetryableError(error) };
}

function isDefaultRetryableError(error: unknown): boolean {
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

function isHardClassifiedError(error: unknown): boolean {
  return isAbortError(error) || isTimeoutError(error) || error instanceof ContextOverflowError;
}

function buildRateLimitFailure(activeProvider: LLMProvider, error: unknown): RateLimitFailure {
  const identity =
    typeof error === "object" && error !== null ? providerRequestIdentities.get(error) : undefined;
  return {
    failedProvider: identity?.provider ?? activeProvider,
    error,
    ...(identity?.credential !== undefined ? { failedCredential: identity.credential } : {}),
    ...(identity?.routeId !== undefined ? { failedRouteId: identity.routeId } : {}),
    ...(identity?.model !== undefined ? { failedModel: identity.model } : {}),
  };
}

function invokeRateLimitHandler(
  handler: NonNullable<RetryOptions["onRateLimited"]>,
  failure: RateLimitFailure,
): LLMProvider | undefined {
  const previous = activeRateLimitFailure;
  activeRateLimitFailure = failure;
  try {
    return handler(failure);
  } finally {
    activeRateLimitFailure = previous;
  }
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
