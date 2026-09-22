import { randomUUID } from "node:crypto";
import {
  ContextOverflowError,
  isAbortError,
  isTimeoutError,
  type LLMProvider,
  type LLMProviderRequestOptions,
  type Message,
  type ToolDefinition,
} from "@pico/core";
import {
  classifyProviderError,
  type ProviderFailureStatus,
} from "./provider-failure-classification.js";
import { waitForAbortableDelay, waitForDelay } from "./deadline.js";

export const DEFAULT_MAX_RETRY_ATTEMPTS = 3;
const RETRY_MIN_TIMEOUT_MS = 300;
const RETRY_MAX_TIMEOUT_MS = 5_000;
const RETRY_FACTOR = 2;
const MAX_TIMEOUT_RETRIES = 1;

export type {
  ProviderErrorClassification,
  ProviderFailureStatus,
} from "./provider-failure-classification.js";
export {
  classifyProviderError,
  defaultIsRetryableError,
} from "./provider-failure-classification.js";

export interface RetryLogger {
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
  readonly toolChoice?: LLMProviderRequestOptions["toolChoice"];
  readonly promptCacheShardSeed?: LLMProviderRequestOptions["promptCacheShardSeed"];
  readonly promptCacheShardActive?: LLMProviderRequestOptions["promptCacheShardActive"];
  readonly onRetry?: (info: RetryInfo) => void;
  readonly onRateLimited?: (failure: RateLimitFailure) => LLMProvider | undefined;
  /** Observability belongs to composition; omission never changes retry decisions. */
  readonly logger?: RetryLogger;
}

export interface RateLimitFailure {
  readonly failedProvider: LLMProvider;
  readonly error: unknown;
  readonly failedCredential?: string;
  readonly failedRouteId?: string;
  readonly failedModel?: string;
}

export interface ProviderRequestIdentity {
  readonly provider: LLMProvider;
  readonly credential?: string;
  readonly routeId?: string;
  readonly model?: string;
}

export interface RetryInfo {
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly error: unknown;
  readonly statusCode?: number;
  readonly failureStatus: ProviderFailureStatus;
}

const providerRequestIdentities = new WeakMap<object, ProviderRequestIdentity>();

/** Bind the actual route to its request error so late 429 failures cannot rotate a newer key. */
export function registerProviderRequestIdentity(
  error: unknown,
  identity: ProviderRequestIdentity,
): void {
  if (typeof error === "object" && error !== null) providerRequestIdentities.set(error, identity);
}

/** Invoke a provider with bounded exponential backoff, abort handling, and optional 429 rotation. */
export async function generateWithRetry(
  provider: LLMProvider,
  messages: Message[],
  tools: ToolDefinition[],
  options?: RetryOptions,
): Promise<Message> {
  const maxAttempts = Math.max(options?.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS, 1);
  const signal = options?.signal;
  const requestOptions: LLMProviderRequestOptions = {
    logicalCallId: `logical_${randomUUID()}`,
    retryAttempt: 0,
    ...(signal ? { signal } : {}),
    ...(options?.toolChoice ? { toolChoice: options.toolChoice } : {}),
    ...(options?.promptCacheShardSeed
      ? { promptCacheShardSeed: options.promptCacheShardSeed }
      : {}),
    ...(options?.promptCacheShardActive !== undefined
      ? { promptCacheShardActive: options.promptCacheShardActive }
      : {}),
  };
  let timeoutRetries = 0;
  if (maxAttempts <= 1) {
    try {
      const result = await provider.generate(messages, tools, requestOptions);
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      logRequestFailure(error, 1, maxAttempts, provider.modelName, signal, options?.logger);
      throw error;
    }
  }

  const delays = backoffDelays(maxAttempts);
  let activeProvider = provider;
  for (let attempt = 1; ; attempt++) {
    try {
      if (attempt > 1) signal?.throwIfAborted();
      const result = await activeProvider.generate(messages, tools, {
        ...requestOptions,
        retryAttempt: attempt - 1,
      });
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      const classification = classifyProviderError(error);
      const retryable = isHardClassifiedError(error)
        ? classification.retryable
        : typeof activeProvider.isRetryableError === "function"
          ? activeProvider.isRetryableError(error)
          : classification.retryable;
      const timeoutLimitReached =
        classification.status === "timed_out" && timeoutRetries >= MAX_TIMEOUT_RETRIES;
      if (attempt >= maxAttempts || !retryable || timeoutLimitReached) {
        logRequestFailure(
          error,
          attempt,
          maxAttempts,
          activeProvider.modelName,
          signal,
          options?.logger,
        );
        throw error;
      }
      if (classification.status === "timed_out") timeoutRetries++;

      if (maybeStatusCode(error) === 429 && options?.onRateLimited) {
        const rotated = options.onRateLimited(buildRateLimitFailure(activeProvider, error));
        if (rotated && rotated !== activeProvider) {
          options.logger?.warn(
            { attempt: `${attempt}/${maxAttempts}`, keyRotated: true },
            "[Retry] 429 限流,已切换凭证重试",
          );
          activeProvider = rotated;
          continue;
        }
      }

      const delayMs = delays[attempt - 1] ?? 0;
      signal?.throwIfAborted();
      const statusCode = maybeStatusCode(error);
      options?.onRetry?.({
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
        error,
        ...(statusCode !== undefined ? { statusCode } : {}),
        failureStatus: classification.status,
      });
      await sleepForRetry(delayMs, signal);
    }
  }
}

export function backoffDelays(maxAttempts: number): number[] {
  const delays: number[] = [];
  for (let index = 0; index < Math.max(maxAttempts - 1, 0); index++) {
    const base = Math.min(RETRY_MAX_TIMEOUT_MS, RETRY_MIN_TIMEOUT_MS * RETRY_FACTOR ** index);
    delays.push(
      Math.max(
        RETRY_MIN_TIMEOUT_MS,
        Math.min(RETRY_MAX_TIMEOUT_MS, Math.round(base * Math.random())),
      ),
    );
  }
  return delays;
}

export async function sleepForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    signal?.throwIfAborted();
    return;
  }
  signal?.throwIfAborted();
  if (!signal) {
    await waitForDelay(delayMs);
    return;
  }
  await waitForAbortableDelay(delayMs, signal);
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

function logRequestFailure(
  error: unknown,
  attempt: number,
  maxAttempts: number,
  model: string | undefined,
  signal: AbortSignal | undefined,
  logger: RetryLogger | undefined,
): void {
  if (isAbortError(error) || signal?.aborted) return;
  logger?.warn(
    {
      attempt: `${attempt}/${maxAttempts}`,
      ...(model !== undefined ? { model } : {}),
      errorName: error instanceof Error ? error.name : typeof error,
      ...(maybeStatusCode(error) !== undefined ? { statusCode: maybeStatusCode(error) } : {}),
    },
    "[Retry] 模型调用失败,不再重试",
  );
}

function maybeStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}
