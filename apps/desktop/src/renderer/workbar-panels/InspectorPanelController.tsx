import type {
  RuntimeExecutionPage,
  RuntimeExecutionSummary,
  RuntimeSessionContextSnapshot,
} from "@pico/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  InspectorWorkbarPanel,
  type InspectorContextSnapshot,
  type InspectorTraceItem,
} from "./InspectorWorkbarPanel.js";
import type { WorkbarPanelHostProps } from "./workbar-panel-contract.js";
import { invokeWorkbarRuntime, workbarErrorMessage } from "./workbar-runtime.js";
import { numberField, recordField, stringField } from "./workbar-values.js";
import { readExecutionWindow, mergeExecutionPages } from "./execution-trace-window.js";

export function InspectorPanelController({
  workspacePath,
  sessionId,
  active,
}: WorkbarPanelHostProps) {
  const runtime = window.pico.runtime;
  const scope = useMemo(() => ({ workspacePath, sessionId }), [workspacePath, sessionId]);
  const [context, setContext] = useState<InspectorContextSnapshot>();
  const [pages, setPages] = useState<readonly RuntimeExecutionPage[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [summary, setSummary] = useState<RuntimeExecutionSummary>();
  const [summaryError, setSummaryError] = useState<string>();
  const [summaryLoading, setSummaryLoading] = useState(false);
  const summaryRequest = useRef(0);
  const [error, setError] = useState<string>();
  const [contextError, setContextError] = useState<string>();
  const generation = useRef(0);
  const traceRequest = useRef(0);
  const contextRequest = useRef(0);
  const pageCount = useRef(1);
  const enabled = useRef(active);
  enabled.current = active;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const refreshSummary = useCallback(async () => {
    if (!enabled.current) return;
    const epoch = generation.current;
    const request = ++summaryRequest.current;
    const current = () =>
      enabled.current &&
      scopeRef.current === scope &&
      epoch === generation.current &&
      request === summaryRequest.current;
    setSummaryLoading(true);
    try {
      const result = await invokeWorkbarRuntime(runtime, "session.execution.summary", scope);
      if (!current()) return;
      setSummary(result);
      setSummaryError(undefined);
    } catch (cause) {
      if (current()) setSummaryError(workbarErrorMessage(cause));
    } finally {
      if (current()) setSummaryLoading(false);
    }
  }, [runtime, scope]);

  const refreshContext = useCallback(async () => {
    if (!enabled.current) return;
    const epoch = generation.current;
    const request = ++contextRequest.current;
    const current = () =>
      enabled.current &&
      scopeRef.current === scope &&
      epoch === generation.current &&
      request === contextRequest.current;
    try {
      const result = await invokeWorkbarRuntime(runtime, "session.context.get", scope);
      if (!current()) return;
      setContext(contextView(result.context));
      setContextError(undefined);
    } catch (cause) {
      if (current()) setContextError(workbarErrorMessage(cause));
    }
  }, [runtime, scope]);

  const refreshTrace = useCallback(
    async (more = false) => {
      if (!enabled.current) return;
      const epoch = generation.current;
      const request = ++traceRequest.current;
      const current = () =>
        enabled.current &&
        scopeRef.current === scope &&
        epoch === generation.current &&
        request === traceRequest.current;
      setLoading(true);
      setLoadingEarlier(more);
      setError(undefined);
      try {
        // Re-read from the newest page with fresh cursors: new runs may shift every page.
        const result = await readExecutionWindow(
          (cursor) =>
            invokeWorkbarRuntime(runtime, "session.execution.query", {
              ...scope,
              ...(cursor ? { cursor } : {}),
            }),
          pageCount.current + (more ? 1 : 0),
          current,
        );
        if (!current() || !result) return;
        pageCount.current = result.length;
        setPages(result);
      } catch (cause) {
        if (current()) setError(workbarErrorMessage(cause));
      } finally {
        if (current()) {
          setLoading(false);
          setLoadingEarlier(false);
        }
      }
    },
    [runtime, scope],
  );

  useEffect(() => {
    generation.current += 1;
    pageCount.current = 1;
    setPages([]);
    setContext(undefined);
    setSelectedTraceId(undefined);
    setError(undefined);
    setContextError(undefined);
    setLoading(false);
    setSummary(undefined);
    setSummaryError(undefined);
    setSummaryLoading(false);
    setLoadingEarlier(false);
    return () => {
      generation.current += 1;
    };
  }, [scope]);

  useEffect(() => {
    if (!active) return;
    void refreshTrace();
    void refreshContext();
    void refreshSummary();
    let disposed = false;
    let running = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (disposed || running || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (disposed) return;
        running = true;
        dirty = false;
        void Promise.all([refreshTrace(), refreshContext(), refreshSummary()]).finally(() => {
          running = false;
          if (dirty) schedule();
        });
      }, 100);
    };
    const subscription = window.pico.sessionFrames.subscribe((frame) => {
      if (
        frame.type !== "subscription.resource_changed" ||
        frame.sessionId !== sessionId ||
        (frame.resource !== "trace" && frame.resource !== "context")
      )
        return;
      dirty = true;
      schedule();
    });
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      subscription.dispose();
    };
  }, [active, sessionId, refreshContext, refreshTrace, refreshSummary]);
  const execution = useMemo(() => mergeExecutionPages(pages), [pages]);
  return (
    <InspectorWorkbarPanel
      summary={summary}
      summaryLoading={summaryLoading}
      summaryError={summaryError}
      loadingEarlier={loadingEarlier}
      canHideEarlier={pages.length > 1}
      onHideEarlier={() => {
        traceRequest.current += 1;
        pageCount.current = 1;
        setPages((current) => current.slice(0, 1));
        setLoading(false);
        setLoadingEarlier(false);
        setSelectedTraceId(undefined);
      }}
      context={context}
      trace={[]}
      execution={execution}
      selectedTraceId={selectedTraceId}
      loading={loading}
      error={error}
      contextError={contextError}
      hasMore={Boolean(pages.at(-1)?.nextCursor)}
      onRefresh={() => {
        void refreshTrace();
        void refreshContext();
        void refreshSummary();
      }}
      onSelectTrace={setSelectedTraceId}
      onLoadMore={() => {
        if (!loading) void refreshTrace(true);
      }}
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
    reservedOutputTokens: numberField(context, "reservedOutputTokens"),
    safetyMarginTokens: numberField(context, "safetyMarginTokens"),
    usedPercent: numberField(context, "usedPercent"),
    compactedCount: numberField(context, "compactedCount"),
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
