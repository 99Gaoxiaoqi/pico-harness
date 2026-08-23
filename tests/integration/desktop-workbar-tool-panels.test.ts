import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  FilesWorkbarPanel,
  InspectorWorkbarPanel,
  ReviewWorkbarPanel,
  TasksWorkbarPanel,
  TerminalWorkbarPanel,
  artifactChunkProgress,
  contextUsagePercent,
  createTaskUpdateRequest,
  reviewSelectionKey,
  shouldPollTerminalPanel,
  terminalGridFromBounds,
  type WorkbarArtifactContent,
  type WorkbarTaskItem,
} from "../../apps/desktop/src/renderer/workbar-panels/index.js";

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
  assert.match(tasks, /rev 12/u);
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
