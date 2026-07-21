import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeNotification,
  DESKTOP_RUNTIME_METHODS,
  isMemoryRuntimeNotification,
  isRuntimeMethod,
  parseDesktopRuntimeResult,
  parseStrictRuntimeParams,
  RUNTIME_ERROR_CODES,
  RUNTIME_METHODS,
  RuntimeProtocolError,
  type RuntimeMemoryFact,
} from "../../packages/protocol/src/index.js";

const memoryMethods = [
  "memory.list",
  "memory.get",
  "memory.update",
  "memory.forget",
  "memory.review.list",
  "memory.review.resolve",
  "memory.settings.get",
  "memory.settings.update",
  "memory.context.preview",
] as const;

test("workspace memory methods are explicit Desktop capabilities with strict write contracts", () => {
  for (const method of memoryMethods) {
    assert.equal(RUNTIME_METHODS.includes(method), true);
    assert.equal(DESKTOP_RUNTIME_METHODS.includes(method), true);
    assert.equal(isRuntimeMethod(method), true);
  }
  assert.equal(isRuntimeMethod("memory.create"), false);

  assert.deepEqual(
    parseStrictRuntimeParams("memory.update", {
      workspacePath: "/workspace",
      factId: "fact-1",
      expectedVersion: 1,
      idempotencyKey: "request-1",
      content: "new body",
    }),
    {
      workspacePath: "/workspace",
      factId: "fact-1",
      expectedVersion: 1,
      idempotencyKey: "request-1",
      content: "new body",
    },
  );
  assertProtocolError(
    () =>
      parseStrictRuntimeParams("memory.update", {
        workspacePath: "/workspace",
        factId: "fact-1",
        expectedVersion: 1,
        content: "missing idempotency key",
      }),
    RUNTIME_ERROR_CODES.INVALID_PARAMS,
  );
  assert.deepEqual(
    parseStrictRuntimeParams("memory.settings.update", {
      workspacePath: "/workspace",
      expectedVersion: 1,
      idempotencyKey: "review-mode-balanced",
      reviewMode: "balanced",
    }),
    {
      workspacePath: "/workspace",
      expectedVersion: 1,
      idempotencyKey: "review-mode-balanced",
      reviewMode: "balanced",
    },
  );
  assertProtocolError(
    () =>
      parseStrictRuntimeParams("memory.settings.update", {
        workspacePath: "/workspace",
        expectedVersion: 1,
        idempotencyKey: "review-mode-invalid",
        reviewMode: "unlimited",
      }),
    RUNTIME_ERROR_CODES.INVALID_PARAMS,
  );
  assert.deepEqual(
    parseStrictRuntimeParams("memory.review.resolve", {
      workspacePath: "/workspace",
      proposalId: "proposal-1",
      resolution: "accepted",
      expectedVersion: 1,
      idempotencyKey: "review-1",
      patch: {
        kind: "project_fact",
        title: "Edited title",
        content: "Edited content",
        confidence: 0.95,
      },
    }),
    {
      workspacePath: "/workspace",
      proposalId: "proposal-1",
      resolution: "accepted",
      expectedVersion: 1,
      idempotencyKey: "review-1",
      patch: {
        kind: "project_fact",
        title: "Edited title",
        content: "Edited content",
        confidence: 0.95,
      },
    },
  );
  assertProtocolError(
    () =>
      parseStrictRuntimeParams("memory.review.resolve", {
        workspacePath: "/workspace",
        proposalId: "proposal-1",
        resolution: "rejected",
        expectedVersion: 1,
        idempotencyKey: "review-rejected-patch",
        patch: { content: "must not apply" },
      }),
    RUNTIME_ERROR_CODES.INVALID_PARAMS,
  );
  assertProtocolError(
    () =>
      parseStrictRuntimeParams("memory.settings.update", {
        workspacePath: "/workspace",
        expectedVersion: 1,
        idempotencyKey: "auto-commit-true",
        autoCommit: true,
      }),
    RUNTIME_ERROR_CODES.INVALID_PARAMS,
  );
  assertProtocolError(
    () =>
      parseStrictRuntimeParams("memory.settings.update", {
        workspacePath: "/workspace",
        expectedVersion: 1,
        idempotencyKey: "request-2",
        databasePath: "/private/memory.sqlite",
      }),
    RUNTIME_ERROR_CODES.INVALID_PARAMS,
  );
});

test("memory results reject undeclared storage fields", () => {
  const fact = runtimeFact();
  assert.deepEqual(parseDesktopRuntimeResult("memory.get", { fact }), { fact });
  assertProtocolError(
    () =>
      parseDesktopRuntimeResult("memory.get", {
        fact: { ...fact, databasePath: "/private/memory.sqlite" },
      }),
    RUNTIME_ERROR_CODES.INVALID_REQUEST,
  );
});

test("memory settings results strictly validate the rolling review budget", () => {
  const settings = {
    enabled: true,
    autoPropose: true,
    autoCommit: false,
    injectionEnabled: true,
    reviewMode: "balanced",
    version: 1,
    updatedAt: "2026-07-22T00:00:00.000Z",
  } as const;
  const reviewBudget = {
    mode: "balanced",
    allowed: false,
    reason: "budget-exhausted",
    calls: 8,
    inputTokens: 12_000,
    outputTokens: 1_000,
    costUsd: 0.08,
    maxCalls: 8,
    maxInputTokens: 16_000,
    maxOutputTokens: 2_000,
    maxCostUsd: 0.1,
    nextRecoveryAt: "2026-07-22T02:00:00.000Z",
  } as const;
  for (const method of ["memory.settings.get", "memory.settings.update"] as const) {
    assert.deepEqual(parseDesktopRuntimeResult(method, { settings, reviewBudget }), {
      settings,
      reviewBudget,
    });
    assertProtocolError(
      () => parseDesktopRuntimeResult(method, { settings }),
      RUNTIME_ERROR_CODES.INVALID_REQUEST,
    );
    assertProtocolError(
      () =>
        parseDesktopRuntimeResult(method, {
          settings,
          reviewBudget: { ...reviewBudget, calls: -1 },
        }),
      RUNTIME_ERROR_CODES.INVALID_REQUEST,
    );
    assertProtocolError(
      () =>
        parseDesktopRuntimeResult(method, {
          settings,
          reviewBudget: { ...reviewBudget, databasePath: "/private/memory.sqlite" },
        }),
      RUNTIME_ERROR_CODES.INVALID_REQUEST,
    );
  }
});

test("durable memory notifications accept metadata and reject bodies or evidence", () => {
  const valid = createRuntimeNotification({
    topic: "memory.changed",
    scope: { workspacePath: "/workspace" },
    resourceVersion: 2,
    at: 1,
    payload: {
      entityType: "fact",
      entityId: "fact-1",
      version: 2,
      change: "updated",
    },
  });
  assert.equal(isMemoryRuntimeNotification(valid), true);
  assert.equal(
    isMemoryRuntimeNotification({
      ...valid,
      payload: { ...valid.payload, content: "must not enter durable events" },
    }),
    false,
  );
  assert.equal(
    isMemoryRuntimeNotification({
      ...valid,
      payload: { ...valid.payload, evidence: { quote: "raw transcript" } },
    }),
    false,
  );
});

function runtimeFact(): RuntimeMemoryFact {
  return {
    factId: "fact-1",
    kind: "project_fact",
    title: "Build",
    content: "Use npm run build",
    confidence: 0.9,
    state: "active",
    pinned: false,
    version: 1,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function assertProtocolError(operation: () => unknown, code: string): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof RuntimeProtocolError);
    assert.equal(error.code, code);
    return true;
  });
}
