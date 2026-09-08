import type { RuntimeSessionContextSnapshot } from "@pico/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  InspectorWorkbarPanel,
  type InspectorContextSnapshot,
  type InspectorToolPreview,
  type InspectorTraceItem,
} from "./InspectorWorkbarPanel.js";
import { useResourceFrame } from "./useResourceFrame.js";
import type { WorkbarPanelHostProps } from "./workbar-panel-contract.js";
import { invokeWorkbarRuntime, workbarErrorMessage } from "./workbar-runtime.js";
import { numberField, recordField, stringField } from "./workbar-values.js";

const TRACE_QUERY_PAGE_SIZE = 250;

const TRACE_AUTO_LOAD_LIMIT = 2_000;

export function InspectorPanelController({
  workspacePath,
  sessionId,
  active,
}: WorkbarPanelHostProps) {
  const runtime = window.pico.runtime;
  const scope = useMemo(() => ({ workspacePath, sessionId }), [workspacePath, sessionId]);
  const [context, setContext] = useState<InspectorContextSnapshot>();
  const [trace, setTrace] = useState<readonly InspectorTraceItem[]>([]);
  const [traceRecords, setTraceRecords] = useState<ReadonlyMap<string, Record<string, unknown>>>(
    new Map(),
  );
  const [throughSequence, setThroughSequence] = useState(0);
  const [nextAfterSequence, setNextAfterSequence] = useState<number>();
  const [selectedTraceId, setSelectedTraceId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const requestRef = useRef(0);
  const contextRequestRef = useRef(0);
  const traceRequestRef = useRef(0);
  const contextGeneratedAtRef = useRef(0);
  const traceWatermarkRef = useRef(0);
  const traceEventsRef = useRef<readonly Record<string, unknown>[]>([]);

  const refreshContext = useCallback(async () => {
    const request = ++contextRequestRef.current;
    const value = await invokeWorkbarRuntime(runtime, "session.context.get", scope);
    if (request !== contextRequestRef.current) return;
    if (value.context.generatedAt < contextGeneratedAtRef.current) return;
    contextGeneratedAtRef.current = value.context.generatedAt;
    setContext(contextView(value.context));
  }, [runtime, scope]);

  const refreshTrace = useCallback(
    async (watermark?: number) => {
      const request = ++traceRequestRef.current;
      const incremental =
        watermark !== undefined &&
        traceWatermarkRef.current > 0 &&
        watermark >= traceWatermarkRef.current;
      const priorEvents = incremental ? traceEventsRef.current : [];
      let cursor = incremental ? traceWatermarkRef.current : 0;
      let throughSequence = watermark;
      let nextAfterSequence: number | undefined;
      const incoming: Record<string, unknown>[] = [];
      do {
        const page = await invokeWorkbarRuntime(runtime, "session.trace.query", {
          ...scope,
          afterSequence: cursor,
          limit: TRACE_QUERY_PAGE_SIZE,
          ...(throughSequence === undefined ? {} : { throughSequence }),
        });
        throughSequence = page.throughSequence;
        incoming.push(...page.events);
        nextAfterSequence = page.nextAfterSequence;
        if (nextAfterSequence === undefined) break;
        cursor = nextAfterSequence;
      } while (incoming.length < TRACE_AUTO_LOAD_LIMIT);
      if (request !== traceRequestRef.current) return;
      if (
        throughSequence === undefined ||
        (incremental && throughSequence < traceWatermarkRef.current)
      ) {
        return;
      }
      const source = [...priorEvents, ...incoming];
      const parsed = tracePageView(source);
      traceEventsRef.current = source;
      traceWatermarkRef.current = throughSequence;
      setTrace(parsed.items);
      setTraceRecords(parsed.records);
      setThroughSequence(throughSequence);
      setNextAfterSequence(nextAfterSequence);
      setSelectedTraceId((selected) =>
        selected && parsed.records.has(selected) ? selected : undefined,
      );
    },
    [runtime, scope],
  );

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      await Promise.all([refreshContext(), refreshTrace()]);
    } catch (cause) {
      if (request === requestRef.current) setError(workbarErrorMessage(cause));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [refreshContext, refreshTrace]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  useResourceFrame({ active, sessionId, resource: "context" }, refreshContext, setError);
  useResourceFrame(
    { active, sessionId, resource: "trace", watermark: throughSequence },
    refreshTrace,
    setError,
  );

  const loadMore = useCallback(async () => {
    if (!active || nextAfterSequence === undefined) return;
    const request = ++traceRequestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const page = await invokeWorkbarRuntime(runtime, "session.trace.query", {
        ...scope,
        throughSequence,
        afterSequence: nextAfterSequence,
        limit: 100,
      });
      if (request !== traceRequestRef.current) return;
      if (page.throughSequence !== throughSequence) {
        throw new Error("Trace 分页水位已经变化，请刷新后重试。");
      }
      const source = [...traceEventsRef.current, ...page.events];
      const parsed = tracePageView(source);
      traceEventsRef.current = source;
      setTrace(parsed.items);
      setTraceRecords(parsed.records);
      setNextAfterSequence(page.nextAfterSequence);
    } catch (cause) {
      setError(workbarErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [active, nextAfterSequence, runtime, scope, throughSequence]);

  const preview = useMemo<InspectorToolPreview | undefined>(() => {
    if (!selectedTraceId) return undefined;
    const record = traceRecords.get(selectedTraceId);
    return record ? tracePreview(record) : undefined;
  }, [selectedTraceId, traceRecords]);

  return (
    <InspectorWorkbarPanel
      context={context}
      trace={trace}
      selectedTraceId={selectedTraceId}
      preview={preview}
      loading={loading}
      error={error}
      hasMore={nextAfterSequence !== undefined}
      onRefresh={() => void refresh()}
      onSelectTrace={setSelectedTraceId}
      onOpenPreview={setSelectedTraceId}
      onLoadMore={() => void loadMore()}
    />
  );
}

function contextView(context: RuntimeSessionContextSnapshot): InspectorContextSnapshot {
  return {
    version: context.version,
    routeId: stringField(context, "routeId"),
    estimatedInputTokens: numberField(context, "estimatedInputTokens"),
    inputBudgetTokens: numberField(context, "inputBudgetTokens"),
    remainingTokens: numberField(context, "remainingTokens"),
    contextWindowTokens: numberField(context, "contextWindowTokens"),
    usedPercent: numberField(context, "usedPercent"),
    estimation: context["estimation"] === "estimated" ? "estimated" : "unknown",
  };
}

interface ParsedTracePage {
  readonly items: readonly InspectorTraceItem[];
  readonly records: ReadonlyMap<string, Record<string, unknown>>;
}

export function tracePageView(events: readonly Record<string, unknown>[]): ParsedTracePage {
  const items: InspectorTraceItem[] = [];
  const records = new Map<string, Record<string, unknown>>();
  const lifecycleIndexes = new Map<string, number>();
  for (const record of [...events].sort(
    (left, right) => (numberField(left, "sequence") ?? 0) - (numberField(right, "sequence") ?? 0),
  )) {
    const sequence = numberField(record, "sequence");
    const id = stringField(record, "eventId");
    if (sequence === undefined || !id) continue;
    const event = recordField(record, "event");
    const kind = stringField(record, "kind") ?? stringField(event, "kind") ?? "runtime.event";
    if (
      kind === "session.state.committed" ||
      kind === "transcript.event.recorded" ||
      kind === "message.committed"
    ) {
      continue;
    }
    const data = recordField(event, "data");
    const refs = recordField(event, "refs");
    const runId = stringField(event, "runId");
    const createdAt = stringField(record, "at") ?? stringField(event, "at") ?? "";

    if (kind === "run.started") {
      const index = items.length;
      items.push({
        id,
        sequence,
        createdAt,
        kind: "run",
        category: "run",
        ...(runId ? { runId } : {}),
        title: "运行中",
        status: "running",
      });
      if (runId) lifecycleIndexes.set(`run:${runId}`, index);
      records.set(id, record);
      continue;
    }
    if (kind === "run.terminal") {
      const status = terminalTraceStatus(stringField(data, "status"));
      const summary = stringField(data, "reason");
      const index = runId ? lifecycleIndexes.get(`run:${runId}`) : undefined;
      if (index !== undefined) {
        const current = items[index]!;
        items[index] = {
          ...current,
          title: runStatusTitle(status),
          ...(summary ? { summary } : {}),
          status,
          durationMs: elapsedMs(current.createdAt, createdAt),
        };
        records.set(current.id, mergeTraceRecords(records.get(current.id), record));
      } else {
        items.push({
          id,
          sequence,
          createdAt,
          kind: "run",
          category: "run",
          ...(runId ? { runId } : {}),
          title: runStatusTitle(status),
          ...(summary ? { summary } : {}),
          status,
        });
        records.set(id, record);
      }
      continue;
    }

    const toolCallId = stringField(refs, "toolCallId") ?? stringField(data, "toolCallId");
    if (kind === "tool.started") {
      const index = items.length;
      items.push({
        id,
        sequence,
        createdAt,
        kind: "tool.call",
        category: "tool",
        ...(runId ? { runId } : {}),
        title: stringField(data, "toolName") ?? "工具调用",
        summary: "正在执行",
        status: "running",
        ...(toolCallId ? { toolCallId } : {}),
      });
      if (toolCallId) lifecycleIndexes.set(`tool:${toolCallId}`, index);
      records.set(id, record);
      continue;
    }
    if (kind === "tool.result.recorded") {
      const status = resultTraceStatus(stringField(data, "status"));
      const index = toolCallId ? lifecycleIndexes.get(`tool:${toolCallId}`) : undefined;
      const title = stringField(data, "toolName") ?? "工具调用";
      const summary = toolStatusSummary(stringField(data, "status"));
      if (index !== undefined) {
        const current = items[index]!;
        items[index] = {
          ...current,
          title,
          summary,
          status,
          durationMs: elapsedMs(current.createdAt, createdAt),
        };
        records.set(current.id, mergeTraceRecords(records.get(current.id), record));
      } else {
        items.push({
          id,
          sequence,
          createdAt,
          kind: "tool.call",
          category: "tool",
          ...(runId ? { runId } : {}),
          title,
          summary,
          status,
          ...(toolCallId ? { toolCallId } : {}),
        });
        records.set(id, record);
      }
      continue;
    }

    const approvalId = stringField(data, "approvalId");
    if (kind === "approval.requested") {
      const index = items.length;
      items.push({
        id,
        sequence,
        createdAt,
        kind: "approval",
        category: "approval",
        ...(runId ? { runId } : {}),
        title: `批准 · ${stringField(data, "toolName") ?? "受保护操作"}`,
        summary: "等待批准",
        status: "pending",
      });
      if (approvalId) lifecycleIndexes.set(`approval:${approvalId}`, index);
      records.set(id, record);
      continue;
    }
    if (kind === "approval.settled") {
      const decision = stringField(data, "decision");
      const status = decision === "approved" ? "completed" : "failed";
      const index = approvalId ? lifecycleIndexes.get(`approval:${approvalId}`) : undefined;
      if (index !== undefined) {
        const current = items[index]!;
        items[index] = {
          ...current,
          summary: decision === "approved" ? "已批准" : "已拒绝",
          status,
          durationMs: elapsedMs(current.createdAt, createdAt),
        };
        records.set(current.id, mergeTraceRecords(records.get(current.id), record));
      } else {
        items.push({
          id,
          sequence,
          createdAt,
          kind: "approval",
          category: "approval",
          ...(runId ? { runId } : {}),
          title: "批准",
          summary: decision === "approved" ? "已批准" : "已拒绝",
          status,
        });
        records.set(id, record);
      }
      continue;
    }

    const providerCallId = stringField(data, "providerCallId");
    if (kind === "model.call.started") {
      const index = items.length;
      items.push({
        id,
        sequence,
        createdAt,
        kind: "model.call",
        category: "model",
        ...(runId ? { runId } : {}),
        title: stringField(data, "model") ?? stringField(data, "provider") ?? "模型调用",
        summary: "正在生成",
        status: "running",
      });
      if (providerCallId) lifecycleIndexes.set(`model:${providerCallId}`, index);
      records.set(id, record);
      continue;
    }
    if (kind === "model.call.settled") {
      const rawStatus = stringField(data, "status");
      const status = resultTraceStatus(rawStatus);
      const index = providerCallId ? lifecycleIndexes.get(`model:${providerCallId}`) : undefined;
      const durationMs = numberField(data, "latencyMs");
      if (index !== undefined) {
        const current = items[index]!;
        items[index] = {
          ...current,
          summary: modelStatusSummary(rawStatus),
          status,
          ...(durationMs === undefined ? {} : { durationMs }),
        };
        records.set(current.id, mergeTraceRecords(records.get(current.id), record));
      } else {
        items.push({
          id,
          sequence,
          createdAt,
          kind: "model.call",
          category: "model",
          ...(runId ? { runId } : {}),
          title: "模型调用",
          summary: modelStatusSummary(rawStatus),
          status,
          ...(durationMs === undefined ? {} : { durationMs }),
        });
        records.set(id, record);
      }
      continue;
    }

    const title =
      stringField(data, "title") ??
      stringField(data, "toolName") ??
      stringField(data, "name") ??
      traceKindLabel(kind);
    items.push({
      id,
      sequence,
      createdAt,
      kind,
      category: traceCategory(kind),
      ...(runId ? { runId } : {}),
      title,
      summary: traceSummary(data),
      status: traceStatus(data),
      ...(toolCallId ? { toolCallId } : {}),
    });
    records.set(id, record);
  }
  return { items, records };
}

function mergeTraceRecords(
  started: Record<string, unknown> | undefined,
  settled: Record<string, unknown>,
): Record<string, unknown> {
  if (!started) return settled;
  const startedEvent = recordField(started, "event");
  const settledEvent = recordField(settled, "event");
  const startedData = recordField(startedEvent, "data");
  const settledData = recordField(settledEvent, "data");
  const projection = recordField(settledData, "projection");
  return {
    ...settled,
    eventId: started["eventId"],
    event: {
      ...startedEvent,
      ...settledEvent,
      data: {
        ...startedData,
        ...settledData,
        input: startedData,
        output: stringField(projection, "text") ?? settledData,
      },
    },
  };
}

function elapsedMs(startedAt: string, settledAt: string): number | undefined {
  const start = Date.parse(startedAt);
  const end = Date.parse(settledAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}

function resultTraceStatus(status: string | undefined): InspectorTraceItem["status"] {
  if (status === "succeeded" || status === "completed") return "completed";
  if (status === "cancelled" || status === "interrupted") return "interrupted";
  return "failed";
}

function terminalTraceStatus(status: string | undefined): InspectorTraceItem["status"] {
  return resultTraceStatus(status);
}

function runStatusTitle(status: InspectorTraceItem["status"]): string {
  if (status === "completed") return "运行完成";
  if (status === "interrupted") return "运行中断";
  return "运行失败";
}

function toolStatusSummary(status: string | undefined): string {
  if (status === "succeeded") return "执行成功";
  if (status === "rejected") return "未获批准";
  if (status === "cancelled" || status === "interrupted") return "执行中断";
  return "执行失败";
}

function modelStatusSummary(status: string | undefined): string {
  if (status === "succeeded") return "生成完成";
  if (status === "cancelled") return "生成取消";
  return "生成失败";
}

function traceCategory(kind: string): NonNullable<InspectorTraceItem["category"]> {
  if (kind.startsWith("run.")) return "run";
  if (kind.startsWith("model.")) return "model";
  if (kind.startsWith("tool.")) return "tool";
  if (kind.startsWith("approval.")) return "approval";
  if (kind.startsWith("plan.")) return "plan";
  if (kind.startsWith("graph.")) return "graph";
  if (kind.startsWith("context.")) return "context";
  return "other";
}

function tracePreview(record: Record<string, unknown>): InspectorToolPreview {
  const event = recordField(record, "event");
  const data = recordField(event, "data");
  const id = stringField(record, "eventId") ?? "trace";
  const kind = stringField(record, "kind") ?? stringField(event, "kind") ?? "runtime.event";
  return {
    id,
    title: stringField(data, "title") ?? stringField(data, "toolName") ?? traceKindLabel(kind),
    subtitle: kind,
    input: printableField(data, ["input", "args", "arguments"]),
    output: printableField(data, ["output", "result", "message"]),
    error: printableField(data, ["error"]),
    truncated: Boolean(record["partial"]),
  };
}

function traceSummary(data: Record<string, unknown>): string | undefined {
  const direct = stringField(data, "summary") ?? stringField(data, "detail");
  if (direct) return direct;
  const message = recordField(data, "message");
  return stringField(message, "content");
}

function traceStatus(data: Record<string, unknown>): InspectorTraceItem["status"] {
  const status = stringField(data, "status");
  if (
    status === "pending" ||
    status === "running" ||
    status === "completed" ||
    status === "failed" ||
    status === "interrupted"
  ) {
    return status;
  }
  return "completed";
}

function traceKindLabel(kind: string): string {
  if (kind === "message.committed") return "消息已提交";
  if (kind.startsWith("tool.")) return "工具调用";
  if (kind.startsWith("run.")) return "运行状态";
  return kind;
}

function printableField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
    if (candidate !== undefined) {
      try {
        return JSON.stringify(candidate, null, 2);
      } catch {
        return String(candidate);
      }
    }
  }
  return undefined;
}
