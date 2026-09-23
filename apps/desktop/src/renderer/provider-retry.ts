import type { RuntimeNotification } from "@pico/protocol";

export interface ProviderRetryNotice {
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly phase: "scheduled" | "started";
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly at: number;
  readonly errorCategory?: string;
  readonly httpStatus?: number;
  readonly transportCode?: string;
  readonly diagnosticId?: string;
}

export interface ProviderRetryState {
  readonly at: number;
  readonly notice?: ProviderRetryNotice;
  readonly lastFailure?: ProviderRetryNotice;
}

export type ProviderRetryStates = Readonly<Record<string, ProviderRetryState>>;

const MODEL_ERROR_TITLES: Readonly<Record<string, string>> = {
  request_failed: "模型连接失败",
  invalid_json: "模型响应解析失败",
  invalid_response: "模型响应格式错误",
  invalid_tool_call: "模型工具调用格式错误",
  stream_error: "模型响应流错误",
  incomplete_stream: "模型响应未完整结束",
  rejected_completion: "模型响应被拒绝",
  unknown: "模型通信失败",
};

/** Parse only Pico's locally generated safe error summary; never infer from remote text. */
export function modelCommunicationDiagnostic(
  raw: string,
): { readonly title: string; readonly diagnosticId: string } | undefined {
  const match =
    /^ModelCommunicationError category=([a-z_]+) diagnosticId=([A-Za-z0-9_-]+); detail omitted$/.exec(
      raw,
    );
  const title = match && MODEL_ERROR_TITLES[match[1]!];
  return title && match ? { title, diagnosticId: match[2]! } : undefined;
}

export function displayExecutionError(raw: string, includeDiagnostic = false): string {
  const diagnostic = modelCommunicationDiagnostic(raw);
  return diagnostic
    ? `${diagnostic.title}${includeDiagnostic ? ` · 诊断 ID：${diagnostic.diagnosticId}` : ""}`
    : raw;
}

export function providerRetryKey(workspacePath: string, runId: string): string {
  return JSON.stringify([workspacePath, runId]);
}

export function clearProviderRetry(
  states: ProviderRetryStates,
  workspacePath: string,
  runId: string,
  at: number,
  retainFailure = false,
): ProviderRetryStates {
  const key = providerRetryKey(workspacePath, runId);
  const previous = states[key];
  if (!previous || !previous.notice || at < previous.at) return states;
  return {
    ...states,
    [key]: {
      at,
      ...(retainFailure ? { lastFailure: previous.lastFailure } : {}),
    },
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function retryNotice(event: RuntimeNotification): ProviderRetryNotice | undefined {
  const payload = record(event.payload);
  const { workspacePath, sessionId, runId } = event.scope;
  if (
    !workspacePath ||
    !sessionId ||
    !runId ||
    (payload.phase !== "scheduled" && payload.phase !== "started") ||
    !positiveInteger(payload.failedAttempt) ||
    !positiveInteger(payload.nextAttempt) ||
    !positiveInteger(payload.maxAttempts) ||
    payload.nextAttempt <= payload.failedAttempt ||
    payload.nextAttempt > payload.maxAttempts ||
    typeof payload.delayMs !== "number" ||
    !Number.isFinite(payload.delayMs) ||
    payload.delayMs < 0 ||
    !Number.isFinite(event.at)
  )
    return undefined;
  return {
    workspacePath,
    sessionId,
    runId,
    phase: payload.phase,
    failedAttempt: payload.failedAttempt,
    nextAttempt: payload.nextAttempt,
    maxAttempts: payload.maxAttempts,
    delayMs: payload.delayMs,
    at: event.at,
    ...(typeof payload.errorCategory === "string" ? { errorCategory: payload.errorCategory } : {}),
    ...(positiveInteger(payload.httpStatus) ? { httpStatus: payload.httpStatus } : {}),
    ...(typeof payload.transportCode === "string" ? { transportCode: payload.transportCode } : {}),
    ...(typeof payload.diagnosticId === "string" ? { diagnosticId: payload.diagnosticId } : {}),
  };
}

function trim(states: Record<string, ProviderRetryState>): ProviderRetryStates {
  const entries = Object.entries(states);
  if (entries.length <= 100) return states;
  return Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, 100));
}

/** The last event timestamp is kept after clearing so a late retry cannot reopen its banner. */
export function applyProviderRetryNotification(
  states: ProviderRetryStates,
  event: RuntimeNotification,
): ProviderRetryStates {
  const { workspacePath, runId } = event.scope;
  if (!workspacePath || !runId || !Number.isFinite(event.at)) return states;
  const key = providerRetryKey(workspacePath, runId);
  const previous = states[key];
  if (event.topic === "run.providerRetry") {
    const notice = retryNotice(event);
    if (!notice || (previous && event.at < previous.at)) return states;
    // A clear at the same timestamp wins over delayed scheduled/started events.
    if (previous && event.at === previous.at && !previous.notice) return states;
    if (
      previous?.notice &&
      event.at === previous.at &&
      (notice.nextAttempt < previous.notice.nextAttempt ||
        (notice.nextAttempt === previous.notice.nextAttempt &&
          notice.phase === "scheduled" &&
          previous.notice.phase === "started"))
    )
      return states;
    return trim({ ...states, [key]: { at: event.at, notice, lastFailure: notice } });
  }
  const item = record(record(event.payload).item);
  const isOutput =
    event.topic === "run.timeline" &&
    ((item.eventType === "assistant.thinking" && record(item.data).active === true) ||
      item.eventType === "assistant.message" ||
      item.eventType === "tool.started");
  if (event.topic !== "run.finished" && !isOutput) return states;
  return clearProviderRetry(states, workspacePath, runId, event.at, event.topic === "run.finished");
}

export function providerFailureDescription(notice?: ProviderRetryNotice): string {
  if (notice?.httpStatus === 429 || notice?.errorCategory === "rate_limited")
    return "模型服务当前请求过多，任务内容已保留。";
  if (notice?.httpStatus && notice.httpStatus >= 500) return "模型服务暂时不可用，任务内容已保留。";
  if (notice?.errorCategory === "request_failed" || notice?.transportCode)
    return "暂时无法连接模型，任务内容已保留。";
  return "模型请求未能完成，任务内容已保留。";
}
