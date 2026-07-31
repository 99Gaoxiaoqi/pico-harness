// 成本与耗时追踪:Harness 层无侵入式拦截大模型 Token 消耗与执行耗时。
//
// 解决痛点:Agent 部署到生产,月底老板拿着几万元账单质问"哪个任务消耗最多 Token"。
// 传统开发在每次 API 请求前后手动写计时代码,侵入性太强 —— 10 个地方调 Generate
// (含 Subagent)就得复制 10 次。
//
// 驾驭工程追求对上层业务绝对透明:用装饰器模式(Decorator)实现一个"假"的
// LLMProvider,内部包裹"真"的 Provider。Main Loop 根本不知道自己被监控了,
// 所有 Token 和耗时数据在 Tracker 中被截获记录。类似 AOP 面向切面编程。
//
// 算明经济账是落地的关键:衡量 Agent 优秀与否除看代码能否跑通,更看 Token 效率。
// 不把成本监控落到实处,就无法优化 System Prompt 长度,也无从判断上下文压缩是否省钱。

import { randomUUID } from "node:crypto";
import type {
  LLMProvider,
  LLMProviderRequestOptions,
  PreparedProviderRequest,
} from "../provider/interface.js";
import type { Message, ToolDefinition } from "../schema/message.js";
import type { Session } from "../engine/session.js";
import { isAbortError } from "../provider/errors.js";
import type { ProviderCallRecord } from "../tasks/runtime-types.js";
import { estimateCost, type BillingRoute } from "./pricing.js";
import { logger } from "./logger.js";
import { getProviderCallContext, type ProviderCallContext } from "./provider-call-context.js";
import { currentRuntimeRun } from "../runtime/runtime-run.js";
import { defaultIsRetryableError } from "../provider/retry.js";
import { normalizePromptCacheEndpoint } from "../provider/provider-endpoint.js";
import {
  capturePreparedProviderRequest,
  diagnosePreparedProviderRequest,
  parsePreparedRequestCapture,
  type PreparedRequestCapture,
  type PreparedRequestDiagnostic,
} from "./provider-request-diagnostics.js";

export interface ProviderCallLedger {
  recordProviderCall(record: Omit<ProviderCallRecord, "createdAt"> & { createdAt?: number }): {
    record: ProviderCallRecord;
    inserted: boolean;
  };
  /** 可选读接口：供新建 Tracker 从持久账本恢复上一份请求指纹。 */
  listProviderCalls?(filter?: {
    sessionId?: string;
    goalId?: string;
    jobId?: string;
  }): ProviderCallRecord[];
}

export interface CostTrackerOptions {
  ledger?: ProviderCallLedger;
  /** 每次请求前求值，使 conversation / goal 热切换后仍归入真实上下文。 */
  context?: ProviderCallContext | (() => ProviderCallContext);
  callId?: () => string;
}

/**
 * CostTracker:包装了真实 LLMProvider 的装饰器中间件。
 *
 * 实现了 LLMProvider 接口,可被无缝注入 Main Loop(Engine 毫不知情)。
 * 像安检门:数据必须先经过它,它盖上"时间戳"和"成本戳",再原封不动还给你。
 */
export class CostTracker implements LLMProvider {
  private readonly preparedRequests = new Map<string, PreparedRequestCapture>();

  constructor(
    private readonly next: LLMProvider,
    private readonly modelRoute: string | BillingRoute,
    private readonly session?: Session,
    private readonly options: CostTrackerOptions = {},
  ) {}

  /** 暴露模型名供重试/日志打点;计费路由可能是 BillingRoute 对象,取其 model 字段。 */
  get modelName(): string {
    return typeof this.modelRoute === "string" ? this.modelRoute : this.modelRoute.model;
  }

  get requestCapabilities() {
    return this.next.requestCapabilities;
  }

  isRetryableError(error: unknown): boolean {
    return this.next.isRetryableError?.(error) ?? defaultIsRetryableError(error);
  }

  async generate(
    messages: Message[],
    availableTools: ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    return this.track(
      (observeRequest) =>
        this.next.generate(messages, availableTools, withRequestObserver(options, observeRequest)),
      options?.signal,
      false,
      options?.purpose,
    );
  }

  /** 转发流式生成（透传 onDelta，同时用 generate 的成本追踪逻辑） */
  async generateStream(
    messages: Message[],
    availableTools: ToolDefinition[],
    onDelta: (delta: string) => void,
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    // 内部 provider 不支持流式时，降级到非流式 generate
    if (!this.next.generateStream) {
      return this.generate(messages, availableTools, options);
    }

    return this.track(
      (observeRequest) =>
        this.next.generateStream!(
          messages,
          availableTools,
          onDelta,
          withRequestObserver(options, observeRequest),
        ),
      options?.signal,
      true,
      options?.purpose,
    );
  }

  private async track(
    invoke: (observeRequest: (request: PreparedProviderRequest) => void) => Promise<Message>,
    signal?: AbortSignal,
    streaming = false,
    purpose?: LLMProviderRequestOptions["purpose"],
  ): Promise<Message> {
    const callId = this.options.callId?.() ?? `call_${randomUUID()}`;
    const context = this.resolveContext(purpose);
    const runtimeRun = this.requireMatchingRuntimeRun();
    const route = normalizeRoute(this.modelRoute);
    await runtimeRun?.recordModelCallStarted({
      providerCallId: callId,
      provider: route.provider,
      model: route.model,
      purpose: context.purpose,
    });
    let requestDiagnostic: PreparedRequestDiagnostic | undefined;
    const requestRoute = preparedRequestRoute(this.modelRoute);
    const logicalCallPriors = new Map<string, PreparedRequestCapture | undefined>();
    const observeRequest = (request: PreparedProviderRequest): void => {
      try {
        const current = capturePreparedProviderRequest(request);
        const key = preparedRequestKey(context, current, requestRoute);
        let prior: PreparedRequestCapture | undefined;
        if (logicalCallPriors.has(key)) {
          prior = logicalCallPriors.get(key);
        } else {
          prior =
            this.preparedRequests.get(key) ??
            this.restorePreparedRequest(context, current.provider, current.model, requestRoute);
          logicalCallPriors.set(key, prior);
        }
        requestDiagnostic = diagnosePreparedProviderRequest(current, prior);
        // 同一逻辑调用内的兼容降级始终对比调用开始时的 prior；全局 map 则更新为最后
        // 实际发出的 wire body，让下一逻辑调用不会继承已被端点拒绝的字段。
        this.preparedRequests.set(key, current);
      } catch (error) {
        // 可观测性必须 fail-open，不能因诊断序列化问题阻断模型请求。
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "[Tracker] Provider 请求指纹生成失败",
        );
      }
    };
    const start = Date.now();
    try {
      const response = await invoke(observeRequest);
      const latencyMs = Date.now() - start;
      const cost = response.usage ? estimateCost(this.modelRoute, response.usage) : undefined;
      await runtimeRun?.recordModelCallSettled({
        providerCallId: callId,
        status: "succeeded",
        latencyMs,
        ...(response.usage ? { usage: response.usage } : {}),
        ...(cost ? { costCNY: cost.costCNY } : {}),
        ...(cost ? { costStatus: cost.status } : {}),
      });
      this.recordSessionUsage(response, latencyMs, streaming);
      this.recordLedger(
        callId,
        context,
        "succeeded",
        response,
        latencyMs,
        undefined,
        requestDiagnostic,
      );
      return response;
    } catch (error) {
      const latencyMs = Date.now() - start;
      const status = signal?.aborted || isAbortError(error) ? "cancelled" : "failed";
      await runtimeRun?.recordModelCallSettled({
        providerCallId: callId,
        status,
        latencyMs,
        error: runtimeErrorSummary(error),
      });
      this.recordLedger(callId, context, status, undefined, latencyMs, error, requestDiagnostic);
      throw error;
    }
  }

  private restorePreparedRequest(
    context: ProviderCallContext,
    provider: PreparedProviderRequest["provider"],
    model: string,
    route: string | undefined,
  ): PreparedRequestCapture | undefined {
    const records = this.options.ledger?.listProviderCalls?.({
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.goalId ? { goalId: context.goalId } : {}),
      ...(context.jobId ? { jobId: context.jobId } : {}),
    });
    if (!records) return undefined;
    let latest: { record: ProviderCallRecord; capture: PreparedRequestCapture } | undefined;
    for (const record of records) {
      if (
        record.purpose !== context.purpose ||
        record.sessionId !== context.sessionId ||
        record.conversationId !== context.conversationId ||
        record.goalId !== context.goalId ||
        record.jobId !== context.jobId ||
        record.attemptId !== context.attemptId ||
        record.model !== model ||
        record.route !== route
      ) {
        continue;
      }
      const capture = parsePreparedRequestCapture(record.reported?.["requestDiagnostic"]);
      if (capture?.provider !== provider || capture.model !== model) continue;
      if (
        !latest ||
        record.createdAt > latest.record.createdAt ||
        (record.createdAt === latest.record.createdAt &&
          record.callId.localeCompare(latest.record.callId) > 0)
      ) {
        latest = { record, capture };
      }
    }
    return latest?.capture;
  }

  /** Durable Session calls must already be enclosed by the host's canonical RuntimeRun. */
  private requireMatchingRuntimeRun() {
    const runtimeRun = currentRuntimeRun();
    if (!this.session?.runtimeEventStore) return runtimeRun;
    if (
      !runtimeRun?.claimsSession(this.session) ||
      runtimeRun.runtimeEventWriteGuard !== this.session
    ) {
      throw new Error(
        `CostTracker requires a matching host-owned RuntimeRun for durable Session ${this.session.id}`,
      );
    }
    return runtimeRun;
  }

  private resolveContext(purpose?: LLMProviderRequestOptions["purpose"]): ProviderCallContext {
    const configured =
      typeof this.options.context === "function" ? this.options.context() : this.options.context;
    const scoped = getProviderCallContext();
    const context = { purpose: "main", ...configured, ...scoped } satisfies ProviderCallContext;
    return purpose ? { ...context, purpose } : context;
  }

  private recordSessionUsage(response: Message, latencyMs: number, streaming: boolean): void {
    if (!response.usage) {
      this.session?.recordMissingUsage();
      logger.warn({ latencyMs, streaming }, "[Tracker] API 完成但无 Usage 数据");
      return;
    }

    const { promptTokens, completionTokens } = response.usage;
    const cost = estimateCost(this.modelRoute, response.usage);
    this.session?.recordUsage(
      promptTokens,
      completionTokens,
      cost.costCNY,
      cost.usage,
      cost.status,
      response.usage.reportedFields,
    );
    logger.info(
      {
        latencyMs,
        streaming,
        promptTokens,
        completionTokens,
        cacheRead: cost.usage.cacheReadTokens,
        cacheWrite: cost.usage.cacheWriteTokens,
        reasoning: cost.usage.reasoningTokens,
        costStatus: cost.status,
        costCNY: cost.costCNY,
        sessionId: this.session?.id,
      },
      "[Tracker] API 完成",
    );
  }

  private recordLedger(
    callId: string,
    context: ProviderCallContext,
    status: ProviderCallRecord["status"],
    response: Message | undefined,
    latencyMs: number,
    error?: unknown,
    requestDiagnostic?: PreparedRequestDiagnostic,
  ): void {
    if (!this.options.ledger) return;
    const route = normalizeRoute(this.modelRoute);
    const usage = response?.usage;
    const cost = usage ? estimateCost(this.modelRoute, usage) : undefined;
    const cacheSupport =
      route.cacheSupported === true
        ? { cacheSupport: "supported" }
        : route.cacheSupported === false
          ? { cacheSupport: "unsupported" }
          : {};
    try {
      this.options.ledger.recordProviderCall({
        callId,
        ...context,
        provider: route.provider,
        model: route.model,
        ...(route.baseUrl ? { route: safeRouteBaseUrl(route.baseUrl) } : {}),
        status,
        inputTokens: cost?.usage.inputTokens ?? 0,
        // provider_calls 没有独立 reasoning 列；output 保留厂商 completion 总数，
        // reasoning 明细只放 reported，避免账本静默丢 Token。
        outputTokens: usage?.completionTokens ?? 0,
        cacheReadTokens: cost?.usage.cacheReadTokens ?? 0,
        cacheWriteTokens: cost?.usage.cacheWriteTokens ?? 0,
        cost: cost?.costCNY ?? 0,
        reported: usage
          ? {
              usageMetadata: "reported",
              reportedFields: [...(usage.reportedFields ?? ["prompt", "completion"])],
              reasoningTokens: cost?.usage.reasoningTokens ?? 0,
              costStatus: cost?.status ?? "unknown",
              latencyMs,
              ...cacheSupport,
              ...(requestDiagnostic ? { requestDiagnostic } : {}),
            }
          : {
              usageMetadata: "unknown",
              costStatus: "unknown",
              latencyMs,
              ...cacheSupport,
              ...(requestDiagnostic ? { requestDiagnostic } : {}),
              ...(error ? safeErrorMetadata(error) : {}),
            },
      });
    } catch (ledgerError) {
      // 模型响应已经产生时不能因观测存储故障丢弃结果；Session 聚合仍保留兼容兜底。
      logger.error(
        { callId, error: ledgerError instanceof Error ? ledgerError.message : String(ledgerError) },
        "[Tracker] provider_calls 写入失败",
      );
    }
  }
}

function normalizeRoute(route: string | BillingRoute): BillingRoute {
  return typeof route === "string" ? { provider: "unknown", model: route } : route;
}

function safeRouteBaseUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "[invalid-url]";
    parsed.username = "";
    parsed.password = "";
    return normalizePromptCacheEndpoint(parsed.toString());
  } catch {
    return "[invalid-url]";
  }
}

function withRequestObserver(
  options: LLMProviderRequestOptions | undefined,
  observeRequest: (request: PreparedProviderRequest) => void,
): LLMProviderRequestOptions {
  const upstream = options?.onRequestPrepared;
  return {
    ...options,
    onRequestPrepared: (request) => {
      observeRequest(request);
      upstream?.(request);
    },
  };
}

function preparedRequestKey(
  context: ProviderCallContext,
  capture: Pick<PreparedRequestCapture, "provider" | "model">,
  route: string | undefined,
): string {
  return JSON.stringify([
    context.purpose,
    context.sessionId,
    context.conversationId,
    context.goalId,
    context.jobId,
    context.attemptId,
    capture.provider,
    capture.model,
    route,
  ]);
}

function preparedRequestRoute(route: string | BillingRoute): string | undefined {
  const normalized = normalizeRoute(route);
  return normalized.baseUrl ? safeRouteBaseUrl(normalized.baseUrl) : undefined;
}

function runtimeErrorSummary(error: unknown): string {
  const metadata = safeErrorMetadata(error);
  return `${metadata.errorName}${metadata.statusCode === undefined ? "" : ` status=${metadata.statusCode}`}; detail omitted`;
}

function safeErrorMetadata(error: unknown): { errorName: string; statusCode?: number } {
  const errorName = error instanceof Error ? error.name : typeof error;
  if (typeof error !== "object" || error === null) return { errorName };
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return {
    errorName,
    ...(typeof statusCode === "number" ? { statusCode } : {}),
  };
}
