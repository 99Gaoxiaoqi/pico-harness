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

import { createHash, randomUUID } from "node:crypto";
import type {
  LLMProvider,
  LLMProviderRequestOptions,
  PreparedProviderRequest,
  ProviderPhysicalAttempt,
  ProviderAttemptLifecycleSnapshot,
} from "@pico/core";
import type { Message, ToolDefinition } from "@pico/core";
import type { RuntimeProjectionSession } from "./runtime-projection-session.js";
import type { CanonicalUsage, UsageReportedField } from "@pico/core";
import type { CostStatus, CatalogPricingResolver } from "./pricing.js";

export interface CostTrackerSession extends RuntimeProjectionSession {
  /** Opaque presence marker; the tracker never accesses storage internals. */
  readonly runtimeEventStore?: object | undefined;
  recordMissingUsage(): void;
  recordUsage(
    promptTokens: number,
    completionTokens: number,
    costCNY: number,
    canonical?: CanonicalUsage,
    costStatus?: CostStatus,
    reportedFields?: readonly UsageReportedField[],
  ): void;
}
export interface CostTrackerDiagnostics {
  warn(bindings: Record<string, unknown>, message: string): void;
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}
import { isAbortError, ModelCommunicationError } from "@pico/core";
import type {
  PhysicalAttemptRecord,
  PhysicalAttemptFilter,
} from "@pico/storage/runtime-control-types";
import { estimateCost, getPricingEntry, type BillingRoute } from "@pico/runtime/pricing";
import { getProviderCallContext, type ProviderCallContext } from "@pico/runtime";
import { currentRuntimeRun } from "./runtime-run.js";
import { defaultIsRetryableError } from "@pico/runtime";
import { normalizePromptCacheEndpoint } from "@pico/runtime/provider-endpoint";
import {
  capturePreparedProviderRequest,
  diagnosePreparedProviderRequest,
  parsePreparedRequestCapture,
  type PreparedRequestCapture,
  type PreparedRequestDiagnostic,
} from "@pico/runtime/provider-request-diagnostics";

export interface ProviderCallLedger {
  beginPhysicalAttemptOwner?(): string;
  getAccountingRevision?(): number;
  recoverPhysicalAttempts?(): number;
  recordPhysicalAttempt?(record: PhysicalAttemptRecord): {
    record: PhysicalAttemptRecord;
    updated: boolean;
  };
  /** Restore request fingerprints from the native physical attempt ledger. */
  listPhysicalAttempts?(filter?: PhysicalAttemptFilter): PhysicalAttemptRecord[];
}

export interface CostTrackerOptions {
  onAccountingChanged?: (record: PhysicalAttemptRecord, revision: number) => void;
  catalogPricing?: CatalogPricingResolver;
  diagnostics?: CostTrackerDiagnostics;
  /** Independent background calls must not append events to an inherited foreground run. */
  recordRuntimeEvents?: boolean;
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
  private meterOwnerId: string | undefined;
  private readonly preparedRequests = new Map<string, PreparedRequestCapture>();

  constructor(
    private readonly next: LLMProvider,
    private readonly modelRoute: string | BillingRoute,
    private readonly session?: CostTrackerSession,
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
      (observeRequest, observeAttempt, lifecycle) =>
        this.next.generate(
          messages,
          availableTools,
          withRequestObserver({ ...options, ...lifecycle }, observeRequest, observeAttempt),
        ),
      options?.signal,
      false,
      options,
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
      (observeRequest, observeAttempt, lifecycle) =>
        this.next.generateStream!(
          messages,
          availableTools,
          onDelta,
          withRequestObserver({ ...options, ...lifecycle }, observeRequest, observeAttempt),
        ),
      options?.signal,
      true,
      options,
    );
  }

  private async track(
    invoke: (
      observeRequest: (request: PreparedProviderRequest) => void,
      observeAttempt: (attempt: ProviderPhysicalAttempt) => void,
      lifecycle: Pick<
        LLMProviderRequestOptions,
        "onProviderAttemptStart" | "onProviderAttemptUpdate"
      >,
    ) => Promise<Message>,
    signal?: AbortSignal,
    streaming = false,
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    const callId = this.options.callId?.() ?? `call_${randomUUID()}`;
    const context = this.resolveContext(options?.purpose);
    const logicalCallId = options?.logicalCallId ?? callId;
    const retryAttempt = options?.retryAttempt ?? 0;
    const attempts = new Map<string, ProviderPhysicalAttempt>();
    let attemptOverflow = false;
    const observeAttempt = (attempt: ProviderPhysicalAttempt): void => {
      if (attempts.size >= 16 && !attempts.has(attempt.attemptId)) {
        attemptOverflow = true;
        return;
      }
      let cost: ReturnType<typeof estimateCost> | undefined;
      try {
        if (attempt.usageBasis === "reported" && attempt.usage)
          cost = estimateCost(this.modelRoute, attempt.usage, this.options.catalogPricing);
      } catch {
        // Preserve the dispatch fact as unpriced when a custom resolver is unavailable.
      }
      attempts.set(attempt.attemptId, {
        ...attempt,
        ...(cost && cost.status !== "unknown"
          ? { costCNY: cost.costCNY, costStatus: cost.status }
          : { costStatus: "unknown" }),
      });
    };
    const attemptFacts = () =>
      this.next.requestCapabilities?.physicalAttempts === true || attempts.size > 0
        ? {
            attempts: [...attempts.values()],
            attemptCoverage:
              !attemptOverflow && this.next.requestCapabilities?.physicalAttempts === true
                ? ("complete" as const)
                : ("partial" as const),
          }
        : {};
    const runtimeRun = this.requireMatchingRuntimeRun();
    const route = normalizeRoute(this.modelRoute);
    const recordSettled = async (
      data: Parameters<NonNullable<typeof runtimeRun>["recordModelCallSettled"]>[0],
    ): Promise<void> => {
      try {
        await runtimeRun?.recordModelCallSettled(data);
      } catch (error) {
        this.options.diagnostics?.error(
          { callId, error: String(error) },
          "[Tracker] 模型结果已确定，运行事件计量写入失败",
        );
      }
    };
    await runtimeRun?.recordModelCallStarted({
      providerCallId: callId,
      logicalCallId,
      retryAttempt,
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
        this.options.diagnostics?.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "[Tracker] Provider 请求指纹生成失败",
        );
      }
    };
    let frozenPricing: ReturnType<typeof getPricingEntry> = null;
    try {
      frozenPricing = structuredClone(getPricingEntry(route, this.options.catalogPricing));
    } catch {
      /* Preserve unpriced admission. */
    }
    const pricingVersion = `route-v1:${createHash("sha256").update(JSON.stringify(frozenPricing)).digest("hex")}`;
    const ledger = this.options.ledger;
    const admissions = new Map<string, PhysicalAttemptRecord>();
    const publishAccounting = (record: PhysicalAttemptRecord): void => {
      try {
        this.options.onAccountingChanged?.(record, ledger?.getAccountingRevision?.() ?? Date.now());
      } catch (error) {
        this.options.diagnostics?.warn({ error: String(error) }, "[Tracker] 计量更新通知失败");
      }
    };
    const lifecycle: Pick<
      LLMProviderRequestOptions,
      "onProviderAttemptStart" | "onProviderAttemptUpdate"
    > = {};
    if (ledger?.beginPhysicalAttemptOwner && ledger.recordPhysicalAttempt) {
      if (!this.meterOwnerId) {
        this.meterOwnerId = ledger.beginPhysicalAttemptOwner();
        ledger.recoverPhysicalAttempts?.();
      }
      const ownerId = this.meterOwnerId;
      lifecycle.onProviderAttemptStart = async (snapshot) => {
        const record: PhysicalAttemptRecord = {
          ...snapshot,
          accountingVersion: 1,
          accountingSource: "physical",
          ownerId,
          providerCallId: callId,
          logicalCallId,
          retryAttempt,
          purpose: context.purpose,
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          ...(context.conversationId ? { conversationId: context.conversationId } : {}),
          ...(context.goalId ? { goalId: context.goalId } : {}),
          ...(context.jobId ? { jobId: context.jobId } : {}),
          ...(context.attemptId ? { jobAttemptId: context.attemptId } : {}),
          ...(runtimeRun
            ? {
                runId: runtimeRun.runId,
                turnId: runtimeRun.currentTurnId,
                workspacePath: runtimeRun.workDir,
              }
            : {}),
          ...(route.baseUrl ? { route: safeRouteBaseUrl(route.baseUrl) } : {}),
          ...(requestDiagnostic
            ? {
                requestDiagnostic: requestDiagnostic as unknown as Readonly<
                  Record<string, unknown>
                >,
              }
            : {}),
          costStatus: "unknown",
          pricingVersion,
          ...(frozenPricing
            ? { pricingBasis: { ...frozenPricing, currency: "USD", usdToCny: 7.2 } }
            : {}),
        };
        const written = ledger.recordPhysicalAttempt!(record);
        if (written.updated) publishAccounting(written.record);
        admissions.set(snapshot.physicalAttemptId, record);
        await options?.onProviderAttemptStart?.(snapshot);
      };
      lifecycle.onProviderAttemptUpdate = async (snapshot: ProviderAttemptLifecycleSnapshot) => {
        const admitted = admissions.get(snapshot.physicalAttemptId);
        if (!admitted) throw new Error("Physical attempt update lacks admission");
        let cost: ReturnType<typeof estimateCost> | undefined;
        try {
          if (snapshot.usageBasis === "reported" && snapshot.usage)
            cost = estimateCost({ ...route, pricing: frozenPricing }, snapshot.usage);
        } catch {
          /* Pricing failures keep the actual usage unpriced. */
        }
        const record: PhysicalAttemptRecord = {
          ...admitted,
          ...snapshot,
          ...(cost && cost.status !== "unknown"
            ? { costCNY: cost.costCNY, costStatus: cost.status }
            : { costStatus: "unknown" }),
        };
        try {
          const written = ledger.recordPhysicalAttempt!(record);
          if (written.updated) publishAccounting(written.record);
        } catch (error) {
          this.options.diagnostics?.error(
            { physicalAttemptId: snapshot.physicalAttemptId, error: String(error) },
            "[Tracker] 物理请求计量降级",
          );
          throw error; // Provider retries this local sink only; never repeats HTTP.
        }
        await options?.onProviderAttemptUpdate?.(snapshot);
      };
    }
    const start = Date.now();
    try {
      const response = await invoke(observeRequest, observeAttempt, lifecycle);
      const latencyMs = Date.now() - start;
      const cost = response.usage
        ? estimateCost(this.modelRoute, response.usage, this.options.catalogPricing)
        : undefined;
      await recordSettled({
        providerCallId: callId,
        logicalCallId,
        retryAttempt,
        ...attemptFacts(),
        status: "succeeded",
        latencyMs,
        ...(response.usage ? { usage: response.usage } : {}),
        ...(cost ? { costCNY: cost.costCNY } : {}),
        ...(cost ? { costStatus: cost.status } : {}),
      });
      this.recordSessionUsage(response, latencyMs, streaming);
      return response;
    } catch (error) {
      const latencyMs = Date.now() - start;
      const status = signal?.aborted || isAbortError(error) ? "cancelled" : "failed";
      await recordSettled({
        providerCallId: callId,
        logicalCallId,
        retryAttempt,
        ...attemptFacts(),
        status,
        latencyMs,
        error: runtimeErrorSummary(error),
      });
      throw error;
    }
  }

  private restorePreparedRequest(
    context: ProviderCallContext,
    provider: PreparedProviderRequest["provider"],
    model: string,
    route: string | undefined,
  ): PreparedRequestCapture | undefined {
    const records = this.options.ledger?.listPhysicalAttempts?.({
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.goalId ? { goalId: context.goalId } : {}),
      ...(context.jobId ? { jobId: context.jobId } : {}),
    });
    if (!records) return undefined;
    let latest: { record: PhysicalAttemptRecord; capture: PreparedRequestCapture } | undefined;
    for (const record of records) {
      if (
        record.purpose !== context.purpose ||
        record.sessionId !== context.sessionId ||
        record.conversationId !== context.conversationId ||
        record.goalId !== context.goalId ||
        record.jobId !== context.jobId ||
        record.jobAttemptId !== context.attemptId ||
        record.model !== model ||
        record.route !== route
      ) {
        continue;
      }
      const capture = parsePreparedRequestCapture(record.requestDiagnostic);
      if (capture?.provider !== provider || capture.model !== model) continue;
      if (
        !latest ||
        record.startedAt > latest.record.startedAt ||
        (record.startedAt === latest.record.startedAt &&
          record.physicalAttemptId.localeCompare(latest.record.physicalAttemptId) > 0)
      ) {
        latest = { record, capture };
      }
    }
    return latest?.capture;
  }

  /** Durable Session calls must already be enclosed by the host's canonical RuntimeRun. */
  private requireMatchingRuntimeRun() {
    if (this.options.recordRuntimeEvents === false) return undefined;
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
      this.options.diagnostics?.warn({ latencyMs, streaming }, "[Tracker] API 完成但无 Usage 数据");
      return;
    }

    const { promptTokens, completionTokens } = response.usage;
    const cost = estimateCost(this.modelRoute, response.usage, this.options.catalogPricing);
    this.session?.recordUsage(
      promptTokens,
      completionTokens,
      cost.costCNY,
      cost.usage,
      cost.status,
      response.usage.reportedFields,
    );
    this.options.diagnostics?.info(
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
  observeAttempt: (attempt: ProviderPhysicalAttempt) => void,
): LLMProviderRequestOptions {
  const upstream = options?.onRequestPrepared;
  return {
    ...options,
    onProviderAttempt: (attempt) => {
      observeAttempt(attempt);
      options?.onProviderAttempt?.(attempt);
    },
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
  if (error instanceof ModelCommunicationError)
    return `${metadata.errorName} category=${error.category} diagnosticId=${error.diagnostic.diagnosticId}; detail omitted`;
  return `${metadata.errorName}${metadata.statusCode === undefined ? "" : ` status=${metadata.statusCode}`}; detail omitted`;
}

function safeErrorMetadata(
  error: unknown,
): Record<string, unknown> & { errorName: string; statusCode?: number } {
  if (error instanceof ModelCommunicationError)
    return {
      errorName: "ModelCommunicationError",
      errorCategory: error.category,
      responseDiagnostic: error.diagnostic,
    };
  const errorName =
    error instanceof Error &&
    [
      "Error",
      "TypeError",
      "AbortError",
      "TimeoutError",
      "LLMStatusError",
      "ContextOverflowError",
      "ModelCapabilityError",
    ].includes(error.name)
      ? error.name
      : "Error";
  if (typeof error !== "object" || error === null) return { errorName };
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return {
    errorName,
    ...(typeof statusCode === "number" &&
    Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode <= 599
      ? { statusCode }
      : {}),
  };
}
