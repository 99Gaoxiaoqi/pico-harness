import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "../../apps/desktop/src/renderer/workbar/workbar-astryx.css";
import { createRoot } from "react-dom/client";
import type { RuntimeExecutionPage, RuntimeSessionContextSnapshot } from "@pico/protocol";
import { InspectorPanelController } from "../../apps/desktop/src/renderer/workbar-panels/InspectorPanelController.js";
import "../../apps/desktop/src/renderer/workbar-panels/ToolPanels.css";
const host = window as unknown as {
  pico: unknown;
  mount: (sessionId?: string) => void;
  update: (next: RuntimeExecutionPage) => void;
  page: RuntimeExecutionPage;
  requests: string[];
  refresh: () => void;
  delayQueries: boolean;
  pending: (() => void)[];
  failQueries: boolean;
};
const summary: RuntimeExecutionPage["summary"] = {
  scope: "session",
  modelCalls: 5,
  failedCalls: 1,
  meteredCalls: 5,
  unpricedCalls: 1,
  inputTokens: 30000,
  outputTokens: 1000,
  cachedInputTokens: 21000,
  reasoningTokens: 10,
  cacheCoverage: "complete",
  physicalAttempts: 5,
  retries: 0,
  toolCalls: 2,
  toolDurationMs: 500,
};
const model = (id: string) => ({
  id,
  eventId: `${id}-event`,
  turnId: "turn",
  kind: "model" as const,
  title: "模型请求",
  at: "2026-09-23T00:00:00Z",
  status: "completed" as const,
  providerId: "openai",
  modelId: `very-long-model-${"identifier-".repeat(14)}`,
  inputTokens: 1200,
  outputTokens: 200,
  cachedInputTokens: 1000,
  durationMs: 2000,
  costStatus: "unknown" as const,
});
host.page = {
  schemaVersion: 1,
  sessionId: "s",
  summary,
  coverage: {
    modelAttempts: "physical",
    oversizedRunIds: [],
    missingModelCallRunIds: [],
    incompleteRunIds: [],
  },
  runs: [
    {
      runId: "newest",
      invocationId: "i1",
      at: "2026-09-23T00:02:00Z",
      status: "completed",
      steps: [model("newest-model")],
    },
    {
      runId: "earlier",
      invocationId: "i2",
      at: "2026-09-23T00:01:00Z",
      status: "failed",
      reason: "工具读取失败",
      steps: [
        {
          id: "earlier-tool",
          eventId: "e",
          turnId: "turn",
          kind: "tool",
          title: "读取文件",
          at: "2026-09-23T00:01:00Z",
          status: "failed",
          input: `/${"long-path/".repeat(40)}`,
          error: `failure-${"details".repeat(50)}`,
        },
      ],
    },
    ...Array.from({ length: 30 }, (_, i) => ({
      runId: `empty-${i}`,
      invocationId: `ie-${i}`,
      at: "2026-09-23T00:00:00Z",
      status: "completed" as const,
      steps: [],
    })),
  ],
};
const context: RuntimeSessionContextSnapshot = {
  version: 3,
  sessionId: "s",
  generatedAt: 1,
  selectedRoute: {
    routeId: "p/m",
    providerId: "openai",
    modelId: "m",
    connectionId: "p",
    contextWindow: 20000,
  },
  latestRequest: {
    status: "available",
    source: "physical",
    providerCallId: "call",
    physicalAttemptId: "attempt",
    providerId: "openai",
    modelId: `very-long-model-${"identifier-".repeat(14)}`,
    routeId: "p/m",
    connectionId: "p",
    completedAt: 1,
    inputTokens: 12000,
    outputTokens: 200,
    contextWindow: 20000,
    cachedInputTokens: 8000,
    usageStatus: "reported",
    compositionStatus: "available",
    composition: {
      basis: "semantic_utf8_bytes",
      totalBytes: 10000,
      segments: [
        { kind: "system", bytes: 1000 },
        { kind: "tools", bytes: 3000 },
        { kind: "messages", bytes: 5990 },
        { kind: "other", bytes: 10 },
      ],
      tools: Array.from({ length: 6 }, (_, i) => ({
        label: `工具-${i}-${"long-name".repeat(12)}`,
        bytes: 500 - i * 10,
      })),
      remainingTools: { count: 1, bytes: 80 },
      unlabelledToolBytes: 70,
    },
  },
  modelHistory: {
    throughSequence: 100,
    messageCount: 12,
    estimatedTokens: 1000,
    estimationAlgorithm: "chars_v1",
    projection: "effective_model_history",
    compactedCount: 1,
    latestCompaction: { checkpointId: "checkpoint", throughEventId: "event", coveredEventCount: 8 },
  },
};
let currentSession = "s";
const listeners = new Set<(frame: unknown) => void>();
host.requests = [];
host.pending = [];
host.delayQueries = false;
host.failQueries = false;
const request = (method: string) => async (params: { sessionId: string }) => {
  host.requests.push(`${method}:${params.sessionId}`);
  const capturedPage = { ...host.page, sessionId: params.sessionId };
  const capturedContext = { ...context, sessionId: params.sessionId };
  if (host.delayQueries) await new Promise<void>((resolve) => host.pending.push(resolve));
  if (host.failQueries)
    return {
      ok: false,
      error: { code: "internal", message: "fixture temporary failure", retryable: true },
    };
  return {
    ok: true,
    value:
      method === "session.context.get"
        ? { context: capturedContext }
        : method === "session.execution.summary"
          ? summary
          : capturedPage,
  };
};
host.pico = {
  runtime: Object.fromEntries(
    ["session.context.get", "session.execution.summary", "session.execution.query"].map(
      (method) => [method, request(method)],
    ),
  ),
  sessionFrames: {
    subscribe(listener: (frame: unknown) => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  },
};
const root = createRoot(document.getElementById("root")!);
host.mount = (sessionId = "s") => {
  currentSession = sessionId;
  root.render(
    <InspectorPanelController
      workspacePath="/fixture"
      sessionId={sessionId}
      active
      kind="inspector"
      instanceId="test"
      readOnly={false}
    />,
  );
};
host.refresh = () => {
  for (const listener of listeners)
    listener({
      type: "subscription.resource_changed",
      sessionId: currentSession,
      resource: "trace",
    });
};
host.update = (page) => {
  host.page = page;
  host.refresh();
};
host.mount();
