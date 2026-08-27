import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  runtimeEventHasModelMessage,
} from "../../src/engine/session-runtime-event.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION as runtimeSchemaVersion,
  RuntimeEventDecodeError,
  decodeRuntimeEvent,
  runtimeEventHasModelMessage as runtimeModelMessageGuard,
} from "../../src/storage/runtime-event.js";
import { materializeRuntimeHistoryEntries } from "../../src/engine/session-runtime-read-model.js";
import { materializeRuntimeHistoryEntries as runtimeMaterializeHistoryEntries } from "../../src/engine/session-runtime-read-model.js";
import {
  SESSION_RUNTIME_STATE_VERSION,
  normalizeSessionRuntimeStatePatch,
} from "../../src/engine/session-runtime.js";
import { Session } from "../../src/engine/session.js";

test("Runtime adapters preserve the engine-owned durable Session contracts", () => {
  assert.equal(runtimeSchemaVersion, RUNTIME_EVENT_SCHEMA_VERSION);
  assert.strictEqual(runtimeModelMessageGuard, runtimeEventHasModelMessage);
  assert.strictEqual(runtimeMaterializeHistoryEntries, materializeRuntimeHistoryEntries);
});

test("Graph v1 RuntimeEvent kinds are fully retired", () => {
  for (const kind of [
    "graph.work.added",
    "graph.work.dispatched",
    "graph.work.recorded",
    "graph.work.failed",
    "graph.closed",
  ]) {
    assert.throws(
      () =>
        decodeRuntimeEvent({
          schemaVersion: runtimeSchemaVersion,
          eventId: `retired-${kind}`,
          sessionId: "retired-graph-v1",
          invocationId: "retired-graph-v1",
          runId: "retired-graph-v1",
          turnId: "retired-graph-v1",
          at: "2026-08-27T00:00:00.000Z",
          partial: false,
          visibility: "internal",
          kind,
          data: {},
        }),
      (error: unknown) => error instanceof RuntimeEventDecodeError && error.code === "unknown_kind",
    );
  }
});

test("Session runtime state rejects pre-route settings and unknown persisted fields", () => {
  const settings = {
    provider: "openai" as const,
    model: "test-model",
    modelRouteId: "test/test-model",
    mode: "default" as const,
    thinkingEffort: "off",
    thinkingEffortExplicit: false,
    additionalDirectories: [],
  };
  assert.equal(
    normalizeSessionRuntimeStatePatch({
      settings: { ...settings, modelRouteId: undefined },
    }),
    undefined,
  );
  assert.equal(
    normalizeSessionRuntimeStatePatch({
      settings: { ...settings, legacyModel: "test-model" },
    }),
    undefined,
  );

  const event = {
    schemaVersion: runtimeSchemaVersion,
    eventId: "session-state-v2",
    sessionId: "session-v2",
    invocationId: "session:session-v2:state",
    runId: "session-state",
    turnId: "session-state",
    at: "2026-07-28T00:00:00.000Z",
    partial: false,
    visibility: "internal",
    kind: "session.state.committed",
    data: {
      stateVersion: SESSION_RUNTIME_STATE_VERSION,
      patch: { settings },
    },
  };
  assert.equal(decodeRuntimeEvent(event).kind, "session.state.committed");
  assert.throws(
    () =>
      decodeRuntimeEvent({
        ...event,
        data: { ...event.data, stateVersion: 1 },
      }),
    /session state version is invalid/u,
  );
  assert.throws(
    () =>
      decodeRuntimeEvent({
        ...event,
        data: {
          ...event.data,
          patch: { settings: { ...settings, modelRouteId: undefined } },
        },
      }),
    /session state patch is invalid/u,
  );
});

test("Session runtime state restores an opaque cache shard seed and drops legacy counters", () => {
  const shardSeed = "a".repeat(64);
  assert.deepEqual(
    normalizeSessionRuntimeStatePatch({
      promptCache: {
        stateVersion: 1,
        shardSeed,
        routeShardDecisions: { ["c".repeat(64)]: false },
      },
    }),
    {
      promptCache: {
        stateVersion: 1,
        shardSeed,
        routeShardDecisions: { ["c".repeat(64)]: false },
      },
    },
  );
  assert.deepEqual(
    normalizeSessionRuntimeStatePatch({
      promptCache: {
        stateVersion: 1,
        shardSeed,
        routeCallCounts: { ["b".repeat(64)]: 9 },
        activeRouteDigests: ["d".repeat(64)],
      },
    }),
    {
      promptCache: {
        stateVersion: 1,
        shardSeed,
        routeShardDecisions: { ["d".repeat(64)]: true },
      },
    },
  );
  assert.equal(
    normalizeSessionRuntimeStatePatch({
      promptCache: { stateVersion: 1, shardSeed: "raw-session-id" },
    }),
    undefined,
  );
});

test("Session cache shard identity and first route decision never drift", async () => {
  const session = new Session("cache-shard-stability", process.cwd(), { persistence: false });
  const first = session.preparePromptCacheSharding(
    "secret-free-route-a",
    [
      { role: "system", content: "stable system" },
      { role: "user", content: "first private request" },
    ],
    false,
  );
  const later = session.preparePromptCacheSharding(
    "secret-free-route-a",
    [
      { role: "system", content: "compacted system" },
      { role: "user", content: "different private request" },
    ],
    true,
  );

  assert.match(first.shardSeed ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(later.shardSeed, first.shardSeed);
  assert.equal(first.active, false);
  assert.equal(later.active, false);
  assert.doesNotMatch(first.shardSeed ?? "", /cache-shard-stability|private/u);
  await session.close();
});
