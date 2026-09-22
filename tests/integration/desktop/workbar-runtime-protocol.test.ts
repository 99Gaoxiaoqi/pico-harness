import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_RUNTIME_METHODS,
  parseRuntimeResult,
  parseStrictRuntimeParams,
  RuntimeProtocolError,
} from "@pico/protocol";

test("workbar data methods reject unknown and oversized parameters", () => {
  assert.deepEqual(
    parseStrictRuntimeParams("session.tasks.command", {
      workspacePath: "/workspace",
      sessionId: "session",
      action: "create",
      expectedRevision: 0,
      idempotencyKey: "tool-call",
      title: "task",
    }),
    {
      workspacePath: "/workspace",
      sessionId: "session",
      action: "create",
      expectedRevision: 0,
      idempotencyKey: "tool-call",
      title: "task",
    },
  );
  assert.throws(
    () =>
      parseStrictRuntimeParams("session.artifacts.command", {
        workspacePath: "/workspace",
        sessionId: "session",
        action: "append",
        contentBase64: "a".repeat(48_001),
      }),
    RuntimeProtocolError,
  );
  assert.deepEqual(
    parseStrictRuntimeParams("session.graph.query", {
      workspacePath: "/workspace",
      sessionId: "session",
      action: "timeline",
      graphId: "graph-1",
      limit: 100,
    }),
    {
      workspacePath: "/workspace",
      sessionId: "session",
      action: "timeline",
      graphId: "graph-1",
      limit: 100,
    },
  );
  assert.ok(DESKTOP_RUNTIME_METHODS.includes("session.graph.query"));
  assert.deepEqual(
    parseStrictRuntimeParams("session.graph.retryWake", {
      workspacePath: "/workspace",
      sessionId: "session",
      graphId: "graph-1",
      wakeId: "wake-1",
    }),
    {
      workspacePath: "/workspace",
      sessionId: "session",
      graphId: "graph-1",
      wakeId: "wake-1",
    },
  );
  assert.deepEqual(parseRuntimeResult("session.graph.retryWake", { retried: true }), {
    retried: true,
  });
  assert.ok(DESKTOP_RUNTIME_METHODS.includes("session.graph.retryWake"));
  assert.throws(
    () =>
      parseStrictRuntimeParams("session.graph.retryWake", {
        workspacePath: "/workspace",
        sessionId: "session",
        graphId: "graph-1",
        wakeId: "wake-1",
        mutation: true,
      }),
    RuntimeProtocolError,
  );
  assert.throws(
    () =>
      parseStrictRuntimeParams("session.graph.query", {
        workspacePath: "/workspace",
        sessionId: "session",
        action: "timeline",
        graphId: "graph-1",
        mutation: true,
      }),
    RuntimeProtocolError,
  );
});

test("review, terminal and side chat contracts are renderer allowlisted and strictly decoded", () => {
  for (const method of [
    "git.review.snapshot",
    "git.review.diff",
    "terminal.create",
    "terminal.list",
    "terminal.attach",
    "terminal.input",
    "terminal.resize",
    "terminal.stop",
    "terminal.detach",
    "sideChat.create",
    "sideChat.close",
  ] as const) {
    assert.ok(DESKTOP_RUNTIME_METHODS.includes(method));
  }
  assert.equal(
    (DESKTOP_RUNTIME_METHODS as readonly string[]).includes("terminal.stopAll"),
    false,
    "全量释放仅允许 Electron 主进程调用",
  );
  assert.equal(
    (DESKTOP_RUNTIME_METHODS as readonly string[]).includes("terminal.resume"),
    false,
    "开启新代际仅允许 Electron 主进程调用",
  );
  assert.deepEqual(parseStrictRuntimeParams("terminal.stopAll", {}), {});
  assert.deepEqual(parseStrictRuntimeParams("terminal.resume", {}), {});
  assert.throws(
    () => parseStrictRuntimeParams("terminal.stopAll", { unexpected: true }),
    RuntimeProtocolError,
  );
  assert.throws(
    () => parseStrictRuntimeParams("terminal.resume", { unexpected: true }),
    RuntimeProtocolError,
  );

  parseStrictRuntimeParams("sideChat.create", {
    workspacePath: "/workspace",
    sourceSessionId: "source",
    panelId: "panel",
    idempotencyKey: "create-panel",
  });
  assert.throws(
    () =>
      parseStrictRuntimeParams("terminal.input", {
        workspacePath: "/workspace",
        sessionId: "session",
        terminalId: "terminal",
        resourceEpoch: "epoch",
        data: "x",
        unexpected: true,
      }),
    RuntimeProtocolError,
  );
  parseRuntimeResult("terminal.attach", {
    terminal: {
      terminalId: "terminal",
      workspacePath: "/workspace",
      sessionId: "session",
      resourceEpoch: "epoch",
      sequence: 2,
      status: "running",
      capability: "pty",
      resizeSupported: true,
      createdAt: 1,
      updatedAt: 2,
    },
    resourceEpoch: "epoch",
    sequence: 2,
    snapshot: "ready",
    truncated: false,
  });
  assert.throws(
    () =>
      parseRuntimeResult("terminal.attach", {
        terminal: {
          terminalId: "terminal",
          workspacePath: "/workspace",
          sessionId: "session",
          resourceEpoch: "epoch",
          sequence: 2,
          status: "running",
          capability: "pty",
          resizeSupported: true,
          createdAt: 1,
          updatedAt: 2,
        },
        resourceEpoch: "epoch",
        sequence: 2,
        snapshot: "x".repeat(256 * 1024 + 1),
        truncated: false,
      }),
    RuntimeProtocolError,
  );
});

test("execution trace crosses the desktop protocol with strict causal and coverage shapes", () => {
  assert.ok(DESKTOP_RUNTIME_METHODS.includes("session.execution.query"));
  assert.deepEqual(
    parseStrictRuntimeParams("session.execution.query", {
      workspacePath: "/workspace",
      sessionId: "session",
      cursor: "page-2",
    }),
    { workspacePath: "/workspace", sessionId: "session", cursor: "page-2" },
  );
  assert.throws(
    () =>
      parseStrictRuntimeParams("session.execution.query", {
        workspacePath: "/workspace",
        sessionId: "session",
        cursor: "x".repeat(2049),
      }),
    RuntimeProtocolError,
  );
  const page = {
    schemaVersion: 1,
    sessionId: "session",
    runs: [
      {
        runId: "run",
        invocationId: "invocation",
        at: "2026-09-22T00:00:00.000Z",
        status: "failed",
        reason: "provider unavailable",
        steps: [
          {
            id: "step",
            eventId: "event",
            turnId: "turn",
            kind: "model",
            title: "model",
            at: "2026-09-22T00:00:00.000Z",
            status: "failed",
            costStatus: "unknown",
            error: "provider unavailable",
          },
        ],
      },
    ],
    summary: { scope: "session", modelCalls: 1, failedCalls: 1, meteredCalls: 0, unpricedCalls: 1 },
    coverage: {
      oversizedRunIds: [],
      missingModelCallRunIds: [],
      incompleteRunIds: [],
      modelAttempts: "logical_only",
    },
  };
  assert.ok(DESKTOP_RUNTIME_METHODS.includes("session.execution.summary"));
  assert.deepEqual(
    parseStrictRuntimeParams("session.execution.summary", {
      workspacePath: "/workspace",
      sessionId: "session",
    }),
    { workspacePath: "/workspace", sessionId: "session" },
  );
  assert.deepEqual(
    parseRuntimeResult("session.execution.summary", {
      ...page.summary,
      physicalAttempts: 2,
      retries: 1,
      cacheCoverage: "partial",
    }),
    { ...page.summary, physicalAttempts: 2, retries: 1, cacheCoverage: "partial" },
  );
  assert.throws(
    () =>
      parseStrictRuntimeParams("session.execution.summary", {
        workspacePath: "/workspace",
        sessionId: "session",
        cursor: "invalid",
      }),
    RuntimeProtocolError,
  );
  assert.throws(
    () =>
      parseRuntimeResult("session.execution.summary", {
        ...page.summary,
        physicalAttempts: -1,
      }),
    RuntimeProtocolError,
  );
  assert.deepEqual(parseRuntimeResult("session.execution.query", page), page);
  assert.throws(
    () =>
      parseRuntimeResult("session.execution.query", {
        ...page,
        coverage: { ...page.coverage, modelAttempts: "invented" },
      }),
    RuntimeProtocolError,
  );
  assert.throws(
    () =>
      parseRuntimeResult("session.execution.query", {
        ...page,
        summary: { ...page.summary, costCNY: "unknown" },
      }),
    RuntimeProtocolError,
  );
});
