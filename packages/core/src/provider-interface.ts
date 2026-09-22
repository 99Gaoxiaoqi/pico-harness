// 大模型通信的稳定契约。具体协议翻译与网络实现属于外层 Provider 适配器。

import type { Message, ToolDefinition, Usage } from "./message.js";

export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;

/** A real HTTP dispatch, including compatibility downgrades; never a logical call. */
export interface ProviderPhysicalAttempt {
  readonly attemptId: string;
  readonly attempt: number;
  readonly provider: string;
  readonly model: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "succeeded" | "failed" | "cancelled" | "interrupted";
  readonly latencyMs: number;
  readonly timeToFirstTokenMs?: number;
  readonly httpStatus?: number;
  readonly finishReason?: string;
  readonly usage?: Usage;
  readonly usageBasis: "reported" | "partial" | "missing";
  readonly error?: string;
  readonly costCNY?: number;
  readonly costStatus?: "estimated" | "included" | "unknown";
}

/** Durable admission is prepared evidence, never proof that the server received a request. */
export interface ProviderAttemptLifecycleSnapshot {
  readonly physicalAttemptId: string;
  readonly revision: number;
  readonly attempt: number;
  readonly provider: string;
  readonly model: string;
  readonly startedAt: string;
  readonly status: "prepared" | "observed" | "succeeded" | "failed" | "cancelled" | "interrupted";
  readonly completedAt?: string;
  readonly latencyMs?: number;
  readonly timeToFirstTokenMs?: number;
  readonly httpStatus?: number;
  readonly finishReason?: string;
  readonly usage?: Usage;
  readonly usageBasis: "reported" | "partial" | "missing";
  readonly error?: string;
}

/** Harness facts frozen before dispatch; never inferred from later configuration. */
export interface RequestContextFacts {
  readonly version: 1;
  readonly routeId?: string;
  readonly connectionId?: string;
  readonly contextWindow?: number;
  readonly contextWindowSource?: string;
  readonly compaction?: {
    readonly checkpointId: string;
    readonly throughEventId: string;
    readonly coveredEventCount: number;
    readonly phase?: "pre_turn" | "mid_turn";
    readonly estimatedTokens?: number;
  };
}

export interface LLMProviderRequestOptions {
  readonly contextFacts?: RequestContextFacts;
  /** Harness identity, shared by every retry of one logical model step. */
  logicalCallId?: string;
  /** Must resolve before HTTP dispatch. Failure is local and must not be retried as a provider error. */
  onProviderAttemptStart?: (snapshot: ProviderAttemptLifecycleSnapshot) => Promise<void>;
  /** Observed and terminal revisions; sink failures must never cause another provider request. */
  onProviderAttemptUpdate?: (snapshot: ProviderAttemptLifecycleSnapshot) => Promise<void>;
  retryAttempt?: number;
  /** Secret-free, settled physical dispatch facts for the canonical event ledger. */
  onProviderAttempt?: (attempt: ProviderPhysicalAttempt) => void;
  /** 宿主中止信号。Provider 应将它与自身超时合并后传给网络请求。 */
  signal?: AbortSignal;
  /** 仅供已校验的宿主覆盖单次 Provider 硬超时；普通调用保持 120 秒默认值。 */
  timeoutMs?: number;
  /** 单次生成的输出 token 上限；Provider 取它与路线输出上限的较小值。 */
  maxOutputTokens?: number;
  /**
   * 禁止本次响应调用工具。支持该语义的 Provider 可保留工具 Schema，
   * 不支持的 Provider 必须由调用方通过 requestCapabilities 能力门控后传空工具集。
   */
  toolChoice?: "none";
  /**
   * Stable, opaque conversation digest used only to choose a configured prompt-cache key shard.
   * Callers must never pass raw prompt text, credentials, or a random Session ID here.
   */
  promptCacheShardSeed?: string;
  /** Route traffic threshold decision, fixed for one logical call and all of its retries. */
  promptCacheShardActive?: boolean;
  /** 仅供显式 Claude 预热请求；Provider 不得把它传播为未知 wire 字段。 */
  promptCachePrewarm?: boolean;
  /** 请求用途，供计费、审计与可观测层区分普通 Agent、预热与 Hook 判定。 */
  purpose?: "hook" | "prewarm";
  /** Provider 返回可展示的 reasoning/thinking 增量时调用；不得混入最终回答正文。 */
  onReasoningDelta?: (delta: string) => void;
  /**
   * Provider 完成协议翻译、即将序列化请求体时触发。
   *
   * 仅供 Harness 可观测层生成无明文的请求指纹；不得传入 headers、URL query
   * 或凭证，也不得在回调中修改 body。
   */
  onRequestPrepared?: (request: PreparedProviderRequest) => void;
}

/** 已完成协议翻译、但尚未发送的无凭证 Provider 请求体。 */
export interface PreparedProviderRequest {
  provider: "claude" | "openai" | "responses";
  model: string;
  body: Readonly<Record<string, unknown>>;
}

/** Provider 对请求级协议选项的显式支持；未声明一律按不支持处理。 */
export interface LLMProviderRequestCapabilities {
  /** Every actual dispatch, including internal compatibility retries, is observed. */
  readonly physicalAttempts?: boolean;
  /** 能否在保留工具 Schema 的同时，通过 wire 参数可靠禁止工具调用。 */
  readonly toolChoiceNoneWithTools: boolean;
  /** Secret-free route identity used for route-scoped prompt-cache traffic accounting. */
  readonly promptCacheRouteIdentity?: string;
  /** Record one logical route request and decide whether key sharding is active for it. */
  readonly preparePromptCacheSharding?: () => boolean;
}

/**
 * Minimal presentation port for a streamed Provider response.
 *
 * The full host Reporter carries tool and lifecycle events; this narrow contract keeps the
 * reusable Provider decorator independent from Terminal, Desktop and transcript implementations.
 */
export interface ProviderStreamReporter {
  onTextDelta?(delta: string): void;
  onReasoningDelta?(delta: string): void;
}

/**
 * 合并宿主中止与 Provider 硬超时，任一触发即取消请求。
 *
 * timeoutMs 是纯 wall-clock 整体超时，从请求发出开始计；长流式的 progress timeout
 * 仍是外层传输实现的后续演进项，不能在契约迁移中改变现有取消语义。
 */
export function providerRequestSignal(
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS,
): AbortSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Provider request timeout must be a positive integer");
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** 与大模型通信的统一契约。 */
export interface LLMProvider {
  /** 接收当前上下文历史与可用工具列表，发起一次大模型推理。 */
  generate(
    messages: Message[],
    availableTools: ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Promise<Message>;
  /** 可选：Provider 自治判定哪些错误可重试。 */
  isRetryableError?: ((error: unknown) => boolean) | undefined;
  /** 可选：模型名，供重试 / 计费日志打点。 */
  readonly modelName?: string | undefined;
  /** 可选：请求级协议能力；装饰器必须透明转发，未声明时调用方安全降级。 */
  readonly requestCapabilities?: LLMProviderRequestCapabilities | undefined;
  /** 可选流式生成；未实现时调用方可降级为 generate。 */
  generateStream?: (
    messages: Message[],
    availableTools: ToolDefinition[],
    onDelta: (delta: string) => void,
    options?: LLMProviderRequestOptions,
  ) => Promise<Message>;
}
