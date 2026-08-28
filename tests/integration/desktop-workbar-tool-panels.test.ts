import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  FilesWorkbarPanel,
  GraphWorkbarPanel,
  InspectorWorkbarPanel,
  ReviewWorkbarPanel,
  TasksWorkbarPanel,
  TerminalWorkbarPanel,
  artifactChunkProgress,
  contextUsagePercent,
  createTaskUpdateRequest,
  groupInspectorTraceItems,
  parseGraphDetail,
  reviewSelectionKey,
  shouldPollTerminalPanel,
  terminalGridFromBounds,
  tracePageView,
  type WorkbarArtifactContent,
  type WorkbarTaskItem,
} from "../../apps/desktop/src/renderer/workbar-panels/index.js";

test("Graph detail derives execution state from formal output and Runtime terminal facts", () => {
  const detail = parseGraphDetail({
    summary: {
      graphId: "graph-1",
      rootSessionId: "root-1",
      epoch: 1,
      phase: "finished",
      headRevision: 2,
      createdAt: 1,
      finishedAt: 2,
      counts: { operators: 1, intents: 3, claims: 3, records: 2, resources: 0, wakes: 1 },
    },
    operators: [{ operatorId: "operator-1", role: "explore", profile: {} }],
    intents: [
      { intentId: "intent-1", operatorId: "operator-1", instruction: "success" },
      { intentId: "intent-2", operatorId: "operator-1", instruction: "failure" },
      { intentId: "intent-3", operatorId: "operator-1", instruction: "running" },
    ],
    claims: [
      { claimId: "claim-1", intentId: "intent-1", state: "executing" },
      { claimId: "claim-2", intentId: "intent-2", state: "executing" },
      { claimId: "claim-3", intentId: "intent-3", state: "executing" },
    ],
    records: [
      { recordId: "record-1", claimId: "claim-1" },
      { recordId: "record-2", claimId: "claim-2" },
    ],
    runtimeClaims: [
      { claimId: "claim-1", status: "completed" },
      { claimId: "claim-2", status: "completed" },
      { claimId: "claim-3", status: "running" },
    ],
    outputs: [
      { recordId: "record-1", claimId: "claim-1", status: "success" },
      { recordId: "record-2", claimId: "claim-2", status: "failure" },
    ],
  });

  assert.equal(detail.claims[0]?.state, "completed");
  assert.equal(detail.claims[1]?.state, "failed");
  assert.equal(detail.claims[2]?.state, "running");
});

test("Inspector trace hides internal state and transcript-only commits", () => {
  const parsed = tracePageView([
    {
      sequence: 1,
      eventId: "state-1",
      kind: "session.state.committed",
      at: "2026-08-23T10:00:00.000Z",
      event: { kind: "session.state.committed", data: {} },
    },
    {
      sequence: 2,
      eventId: "message-1",
      kind: "message.committed",
      at: "2026-08-23T10:00:01.000Z",
      event: { kind: "message.committed", data: {} },
    },
  ]);

  assert.deepEqual(
    parsed.items.map((item) => item.id),
    [],
  );
});

test("Inspector trace folds runtime lifecycle facts into user-facing run groups", () => {
  const parsed = tracePageView([
    traceRecord(1, "run-start", "run.started", "run-1", {
      workDir: "/workspace",
    }),
    traceRecord(2, "message-1", "message.committed", "run-1", {
      message: { role: "user", content: "检查项目" },
    }),
    traceRecord(3, "model-start", "model.call.started", "run-1", {
      providerCallId: "provider-1",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      purpose: "turn",
    }),
    traceRecord(4, "model-settled", "model.call.settled", "run-1", {
      providerCallId: "provider-1",
      status: "succeeded",
      latencyMs: 1_250,
    }),
    traceRecord(
      5,
      "tool-start",
      "tool.started",
      "run-1",
      { toolName: "bash", argumentsHash: "hash" },
      { toolCallId: "tool-1" },
    ),
    traceRecord(
      6,
      "tool-result",
      "tool.result.recorded",
      "run-1",
      {
        toolName: "bash",
        status: "succeeded",
        projection: { text: "ok" },
      },
      { toolCallId: "tool-1" },
    ),
    traceRecord(7, "approval-requested", "approval.requested", "run-1", {
      approvalId: "approval-1",
      toolName: "bash",
    }),
    traceRecord(8, "approval-settled", "approval.settled", "run-1", {
      approvalId: "approval-1",
      decision: "approved",
    }),
    traceRecord(9, "run-terminal", "run.terminal", "run-1", {
      status: "completed",
    }),
  ]);

  assert.deepEqual(
    parsed.items.map(({ category, title, status, durationMs }) => ({
      category,
      title,
      status,
      durationMs,
    })),
    [
      { category: "run", title: "运行完成", status: "completed", durationMs: 8_000 },
      {
        category: "model",
        title: "deepseek-v4-flash",
        status: "completed",
        durationMs: 1_250,
      },
      { category: "tool", title: "bash", status: "completed", durationMs: 1_000 },
      {
        category: "approval",
        title: "批准 · bash",
        status: "completed",
        durationMs: 1_000,
      },
    ],
  );
  assert.equal(parsed.records.has("tool-start"), true);

  const groups = groupInspectorTraceItems(parsed.items);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.status, "completed");
  assert.deepEqual(
    groups[0]?.items.map((item) => item.category),
    ["model", "tool", "approval"],
  );
});

test("Workbar tool panel helpers preserve authority versions, chunks and active polling gates", () => {
  assert.equal(
    contextUsagePercent({
      version: 2,
      estimatedInputTokens: 2_500,
      inputBudgetTokens: 10_000,
    }),
    25,
  );
  assert.equal(contextUsagePercent({ version: 2, usedPercent: 120 }), 100);
  assert.equal(reviewSelectionKey({ source: "staged", path: "src/app.ts" }), "staged:src/app.ts");

  const task: WorkbarTaskItem = {
    id: "task-1",
    title: "接通面板",
    status: "pending",
    revision: 7,
  };
  assert.deepEqual(createTaskUpdateRequest(task, "in_progress", 12), {
    taskId: "task-1",
    status: "in_progress",
    expectedTaskRevision: 7,
    expectedLedgerRevision: 12,
  });

  const content: WorkbarArtifactContent = {
    artifactId: "artifact-1",
    encoding: "utf8",
    content: "partial",
    offset: 0,
    nextOffset: 32,
    totalSize: 128,
    complete: false,
  };
  assert.deepEqual(artifactChunkProgress(content), {
    loaded: 32,
    total: 128,
    percent: 25,
    complete: false,
    nextOffset: 32,
  });
  assert.deepEqual(terminalGridFromBounds(820, 376), { columns: 100, rows: 20 });
  assert.equal(shouldPollTerminalPanel(true, "terminal-1"), true);
  assert.equal(shouldPollTerminalPanel(false, "terminal-1"), false);
  assert.equal(shouldPollTerminalPanel(true), false);
});

function traceRecord(
  sequence: number,
  eventId: string,
  kind: string,
  runId: string,
  data: Record<string, unknown>,
  refs?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    sequence,
    eventId,
    kind,
    at: new Date(Date.UTC(2026, 7, 23, 10, 0, sequence - 1)).toISOString(),
    event: { kind, runId, data, ...(refs ? { refs } : {}) },
  };
}

test("Workbar tool panels render real authority snapshots with accessible detail regions", () => {
  Object.assign(globalThis, { React });
  const inspector = renderToStaticMarkup(
    React.createElement(InspectorWorkbarPanel, {
      context: {
        version: 2,
        routeId: "route-main",
        estimatedInputTokens: 4_000,
        inputBudgetTokens: 8_000,
        remainingTokens: 4_000,
        compactedCount: 1,
        sections: [{ id: "instructions", label: "Instructions", tokens: 900, state: "included" }],
      },
      trace: [
        {
          id: "trace-1",
          sequence: 9,
          createdAt: "2026-08-23T10:00:00.000Z",
          kind: "tool.completed",
          title: "读取文件",
          toolCallId: "call-1",
        },
      ],
      selectedTraceId: "trace-1",
      preview: { id: "preview-1", title: "读取文件", input: "src/app.ts", output: "ok" },
      loading: false,
      onRefresh: () => undefined,
      onSelectTrace: () => undefined,
    }),
  );
  assert.match(inspector, /aria-label="上下文使用率"/u);
  assert.match(inspector, /aria-label="工具详情预览"/u);
  assert.match(inspector, /aria-pressed="true"/u);

  const review = renderToStaticMarkup(
    React.createElement(ReviewWorkbarPanel, {
      snapshot: {
        revision: "git-2",
        branch: "feature/workbar",
        staged: [{ path: "src/app.ts", status: "modified", additions: 3, deletions: 1 }],
        unstaged: [],
      },
      selection: { source: "staged", path: "src/app.ts" },
      diff: {
        revision: "git-2",
        source: "staged",
        path: "src/app.ts",
        content: "+new line",
      },
      loading: false,
      onRefresh: () => undefined,
      onSelectFile: () => undefined,
    }),
  );
  assert.match(review, /feature\/workbar/u);
  assert.match(review, /aria-label="src\/app.ts 差异"/u);
  assert.match(review, /\+new line/u);

  const tasks = renderToStaticMarkup(
    React.createElement(TasksWorkbarPanel, {
      ledger: {
        revision: 12,
        tasks: [{ id: "task-1", title: "接通面板", status: "in_progress", revision: 7 }],
      },
      loading: false,
      onRefresh: () => undefined,
      onCreate: () => undefined,
      onUpdate: () => undefined,
    }),
  );
  assert.match(tasks, /已同步 1 项/u);
  assert.match(tasks, /task rev 7/u);
  assert.match(tasks, /更新“接通面板”状态/u);

  const files = renderToStaticMarkup(
    React.createElement(FilesWorkbarPanel, {
      artifacts: [
        {
          id: "artifact-1",
          name: "report.md",
          mimeType: "text/markdown",
          size: 128,
          createdAt: "2026-08-23T10:00:00.000Z",
        },
      ],
      selectedArtifactId: "artifact-1",
      content: {
        artifactId: "artifact-1",
        encoding: "utf8",
        content: "# Report",
        offset: 0,
        nextOffset: 32,
        totalSize: 128,
        complete: false,
      },
      loading: false,
      onRefresh: () => undefined,
      onSelectArtifact: () => undefined,
      onLoadChunk: () => undefined,
    }),
  );
  assert.match(files, /aria-label="文件读取进度"/u);
  assert.match(files, /继续读取/u);
  assert.match(files, /# Report/u);

  const terminal = renderToStaticMarkup(
    React.createElement(TerminalWorkbarPanel, {
      terminals: [
        {
          id: "terminal-1",
          title: "Shell 1",
          status: "running",
          attached: true,
          sequence: 18,
          capability: "pty",
          resizeSupported: true,
        },
      ],
      activeTerminalId: "terminal-1",
      output: { terminalId: "terminal-1", text: "$ npm test\npassed", sequence: 18 },
      active: true,
      loading: false,
      onCreate: () => undefined,
      onSelect: () => undefined,
      onAttach: () => undefined,
      onInput: () => undefined,
      onResize: () => undefined,
      onStop: () => undefined,
      onSetPollingActive: () => undefined,
    }),
  );
  assert.match(terminal, /role="tablist"/u);
  assert.match(terminal, /role="tabpanel"/u);
  assert.match(terminal, /role="log"/u);
  assert.match(terminal, /\$ npm test/u);

  const graph = renderToStaticMarkup(
    React.createElement(GraphWorkbarPanel, {
      graphs: [
        {
          graphId: "graph-1",
          epoch: 1,
          phase: "open",
          headRevision: 2,
          createdAt: 1,
          counts: { operators: 1, intents: 1, claims: 1, records: 1, resources: 2, wakes: 1 },
        },
      ],
      selectedGraphId: "graph-1",
      detail: {
        summary: {
          graphId: "graph-1",
          epoch: 1,
          phase: "open",
          headRevision: 2,
          createdAt: 1,
          counts: { operators: 1, intents: 1, claims: 1, records: 1, resources: 2, wakes: 1 },
        },
        operators: [{ operatorId: "operator-1", role: "Researcher", profileId: "explore" }],
        intents: [
          {
            intentId: "intent-1",
            operatorId: "operator-1",
            instruction: "核验实现",
          },
        ],
        claims: [{ claimId: "claim-1", intentId: "intent-1", state: "executing" }],
      },
      timeline: [{ id: "event-1", at: 1, kind: "record.committed", status: "agent_output" }],
      loading: false,
      onRefresh: () => undefined,
      onSelectGraph: () => undefined,
    }),
  );
  assert.match(graph, /aria-label="Graph 周期"/u);
  assert.match(graph, /Researcher/u);
  assert.match(graph, /正式产出/u);

  const waitingGraph = renderToStaticMarkup(
    React.createElement(GraphWorkbarPanel, {
      graphs: [
        {
          graphId: "graph-waiting",
          epoch: 1,
          phase: "open",
          headRevision: 0,
          createdAt: 1,
          counts: { operators: 0, intents: 0, claims: 0, records: 0, resources: 0, wakes: 0 },
        },
      ],
      selectedGraphId: "graph-waiting",
      detail: {
        summary: {
          graphId: "graph-waiting",
          epoch: 1,
          phase: "open",
          headRevision: 0,
          createdAt: 1,
          counts: { operators: 0, intents: 0, claims: 0, records: 0, resources: 0, wakes: 0 },
        },
        operators: [],
        intents: [],
        claims: [],
      },
      timeline: [],
      loading: false,
      onRefresh: () => undefined,
      onSelectGraph: () => undefined,
    }),
  );
  assert.match(waitingGraph, /Graph 已启动/u);
  assert.match(waitingGraph, /等待根 Agent 创建调度/u);

  const fallbackTerminal = renderToStaticMarkup(
    React.createElement(TerminalWorkbarPanel, {
      terminals: [
        {
          id: "terminal-pipe",
          title: "Shell fallback",
          status: "running",
          attached: true,
          sequence: 1,
          capability: "pipe",
          resizeSupported: false,
        },
      ],
      activeTerminalId: "terminal-pipe",
      active: true,
      loading: false,
      onCreate: () => undefined,
      onSelect: () => undefined,
      onAttach: () => undefined,
      onInput: () => undefined,
      onResize: () => undefined,
      onStop: () => undefined,
      onSetPollingActive: () => undefined,
    }),
  );
  assert.match(fallbackTerminal, /兼容管道/u);
  assert.match(fallbackTerminal, /不支持随面板调整尺寸/u);
});

test("Workbar tool panels expose honest loading, error and empty states", () => {
  const emptyFiles = renderToStaticMarkup(
    React.createElement(FilesWorkbarPanel, {
      artifacts: [],
      loading: false,
      onRefresh: () => undefined,
      onSelectArtifact: () => undefined,
      onLoadChunk: () => undefined,
    }),
  );
  assert.match(emptyFiles, /没有生成文件/u);

  const failedReview = renderToStaticMarkup(
    React.createElement(ReviewWorkbarPanel, {
      loading: false,
      error: "Git authority unavailable",
      onRefresh: () => undefined,
      onSelectFile: () => undefined,
    }),
  );
  assert.match(failedReview, /role="alert"/u);
  assert.match(failedReview, /Git authority unavailable/u);

  const loadingInspector = renderToStaticMarkup(
    React.createElement(InspectorWorkbarPanel, {
      trace: [],
      loading: true,
      onRefresh: () => undefined,
      onSelectTrace: () => undefined,
    }),
  );
  assert.match(loadingInspector, /role="status"/u);
  assert.match(loadingInspector, /正在加载追踪/u);
});
