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
  type RuntimeMemoryItem,
} from "../../../packages/protocol/src/index.js";

const memoryMethods = [
  "memory.list",
  "memory.get",
  "memory.create",
  "memory.update",
  "memory.delete",
  "memory.settings.get",
  "memory.settings.update",
  "memory.context.preview",
] as const;

test("atomic Memory Item methods are explicit Desktop capabilities", () => {
  for (const method of memoryMethods) {
    assert.equal(RUNTIME_METHODS.includes(method), true);
    assert.equal(DESKTOP_RUNTIME_METHODS.includes(method), true);
    assert.equal(isRuntimeMethod(method), true);
  }
  for (const retired of ["memory.forget", "memory.review.list", "memory.review.resolve"]) {
    assert.equal(isRuntimeMethod(retired), false);
  }
});

test("Memory Item writes accept current fields and reject Fact compatibility fields", () => {
  assert.deepEqual(
    parseStrictRuntimeParams("memory.update", {
      workspacePath: "/workspace",
      itemId: "item-1",
      expectedVersion: 1,
      idempotencyKey: "request-1",
      content: "new body",
      kind: "knowledge",
    }),
    {
      workspacePath: "/workspace",
      itemId: "item-1",
      expectedVersion: 1,
      idempotencyKey: "request-1",
      content: "new body",
      kind: "knowledge",
    },
  );
  assert.deepEqual(
    parseStrictRuntimeParams("memory.update", {
      workspacePath: "/workspace",
      itemId: "item-1",
      expectedVersion: 1,
      idempotencyKey: "archive-1",
      lifecycleState: "archived",
    }),
    {
      workspacePath: "/workspace",
      itemId: "item-1",
      expectedVersion: 1,
      idempotencyKey: "archive-1",
      lifecycleState: "archived",
    },
  );
  for (const legacyPatch of [
    { factId: "fact-1", content: "old id" },
    { itemId: "item-1", state: "archived" },
    { itemId: "item-1", kind: "project_fact" },
    { itemId: "item-1", pinned: true },
  ]) {
    assertProtocolError(
      () =>
        parseStrictRuntimeParams("memory.update", {
          workspacePath: "/workspace",
          expectedVersion: 1,
          idempotencyKey: "legacy",
          ...legacyPatch,
        }),
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
    );
  }
});

test("memory settings expose only current extraction and recall switches", () => {
  const params = {
    workspacePath: "/workspace",
    expectedVersion: 1,
    idempotencyKey: "settings-1",
    enabled: true,
    autoExtract: false,
    recallEnabled: true,
  } as const;
  assert.deepEqual(parseStrictRuntimeParams("memory.settings.update", params), params);
  for (const alias of [
    { autoPropose: true },
    { autoCommit: false },
    { injectionEnabled: true },
    { reviewMode: "balanced" },
  ]) {
    assertProtocolError(
      () =>
        parseStrictRuntimeParams("memory.settings.update", {
          workspacePath: "/workspace",
          expectedVersion: 1,
          idempotencyKey: "legacy-settings",
          ...alias,
        }),
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
    );
  }

  const settings = { enabled: true, autoExtract: false, recallEnabled: true, version: 2 };
  assert.deepEqual(parseDesktopRuntimeResult("memory.settings.get", { settings }), { settings });
  assertProtocolError(
    () =>
      parseDesktopRuntimeResult("memory.settings.get", {
        settings: { ...settings, autoPropose: false },
      }),
    RUNTIME_ERROR_CODES.INVALID_REQUEST,
  );
  assertProtocolError(
    () => parseDesktopRuntimeResult("memory.settings.get", { settings, reviewBudget: {} }),
    RUNTIME_ERROR_CODES.INVALID_REQUEST,
  );
});

test("memory results expose direct atomic Items and reject legacy envelopes", () => {
  const item = runtimeItem();
  assert.deepEqual(parseDesktopRuntimeResult("memory.get", { item }), { item });
  assert.deepEqual(parseDesktopRuntimeResult("memory.list", { items: [item] }), {
    items: [item],
  });
  assert.deepEqual(
    parseDesktopRuntimeResult("memory.delete", { itemId: item.itemId, deleted: true }),
    { itemId: item.itemId, deleted: true },
  );
  assertProtocolError(
    () => parseDesktopRuntimeResult("memory.get", { fact: item }),
    RUNTIME_ERROR_CODES.INVALID_REQUEST,
  );
  assertProtocolError(
    () =>
      parseDesktopRuntimeResult("memory.get", {
        item: { ...item, atomic: { itemId: item.itemId } },
      }),
    RUNTIME_ERROR_CODES.INVALID_REQUEST,
  );
});

test("durable memory notifications use Item changed/deleted metadata only", () => {
  const changed = createRuntimeNotification({
    topic: "memory.changed",
    scope: { workspacePath: "/workspace" },
    resourceVersion: 2,
    at: 1,
    payload: {
      entityType: "item",
      entityId: "item-1",
      version: 2,
      change: "updated",
    },
  });
  const deleted = createRuntimeNotification({
    topic: "memory.deleted",
    scope: { workspacePath: "/workspace" },
    resourceVersion: 3,
    at: 2,
    payload: { itemId: "item-1", version: 3 },
  });
  assert.equal(isMemoryRuntimeNotification(changed), true);
  assert.equal(isMemoryRuntimeNotification(deleted), true);
  assert.equal(
    isMemoryRuntimeNotification({
      ...changed,
      payload: { ...changed.payload, content: "must not enter durable events" },
    }),
    false,
  );
  assert.equal(
    isMemoryRuntimeNotification({
      ...deleted,
      topic: "memory.forgotten",
      payload: { factId: "fact-1", version: 3 },
    }),
    false,
  );
});

function runtimeItem(): RuntimeMemoryItem {
  return {
    itemId: "item-1",
    version: 1,
    content: "Use npm run build",
    kind: "knowledge",
    statementType: "fact",
    temporalType: "undated",
    scopeType: "workspace",
    scopeKey: "workspace-key",
    eventStartedAt: null,
    eventEndedAt: null,
    observedAt: 1,
    lifecycleState: "active",
    origin: "agent_extracted",
    contentHash: "hash",
    createdAt: 1,
    updatedAt: 1,
    sources: [{ sessionId: "session-1", runId: "run-1", turnId: "turn-1", eventId: "event-1" }],
  };
}

function assertProtocolError(operation: () => unknown, code: string): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof RuntimeProtocolError);
    assert.equal(error.code, code);
    return true;
  });
}
