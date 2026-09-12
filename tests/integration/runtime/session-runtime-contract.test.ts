import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  runtimeEventHasModelMessage,
} from "../../../src/engine/session-runtime-event.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION as runtimeSchemaVersion,
  RuntimeEventDecodeError,
  decodeRuntimeEvent,
  runtimeEventHasModelMessage as runtimeModelMessageGuard,
} from "../../../src/storage/runtime-event.js";
import { materializeRuntimeHistoryEntries } from "../../../src/engine/session-runtime-read-model.js";
import { materializeRuntimeHistoryEntries as runtimeMaterializeHistoryEntries } from "../../../src/engine/session-runtime-read-model.js";
import {
  SESSION_RUNTIME_STATE_VERSION,
  createEmptyUsageSnapshot,
  normalizeSessionRuntimeStatePatch,
  normalizeSessionRuntimeStateWritePatch,
  normalizeSessionUsageSnapshot,
} from "../../../src/engine/session-runtime.js";
import { Session } from "../../../src/engine/session.js";
import {
  createManagedExecutionBoundary,
  decodeExecutionBoundary,
  type ExecutionBoundary,
} from "../../../src/safety/permission-profile.js";

test("Runtime adapters preserve the engine-owned durable Session contracts", () => {
  assert.equal(runtimeSchemaVersion, RUNTIME_EVENT_SCHEMA_VERSION);
  assert.strictEqual(runtimeModelMessageGuard, runtimeEventHasModelMessage);
  assert.strictEqual(runtimeMaterializeHistoryEntries, materializeRuntimeHistoryEntries);
});

test("retired RuntimeEvent kinds are rejected", () => {
  for (const kind of [
    "graph.work.added",
    "graph.work.dispatched",
    "graph.work.recorded",
    "graph.work.failed",
    "graph.closed",
    "history.rewound",
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
    collaborationMode: "agent" as const,
    permissionMode: "ask" as const,
    orchestrationMode: "default" as const,
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
    eventId: "session-state-v3",
    sessionId: "session-v3",
    invocationId: "session:session-v3:state",
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
        data: { ...event.data, stateVersion: 2 },
      }),
    /session state version is invalid/u,
  );
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

test("Session boundary codec round-trips complete snapshots and rejects malformed authority", () => {
  const boundary = testExecutionBoundary(4);
  const decoded = decodeExecutionBoundary(JSON.parse(JSON.stringify(boundary)) as unknown);
  assert.deepEqual(decoded, boundary);
  assert.notStrictEqual(decoded, boundary);
  assert.deepEqual(normalizeSessionRuntimeStatePatch({ boundary }), { boundary });
  assert.deepEqual(normalizeSessionRuntimeStateWritePatch({ boundary }), { boundary });

  for (const invalid of [
    { kind: "managed", revision: 0 },
    { kind: "bypass", revision: -1 },
    { kind: "external", revision: 1, profile: {} },
    { kind: "unknown", revision: 0 },
    {
      ...boundary,
      profile: { ...boundary.profile, unexpected: true },
    },
    {
      ...boundary,
      profile: {
        ...boundary.profile,
        fileSystem: {
          ...boundary.profile.fileSystem,
          entries: [{ kind: "path", access: "write", path: "relative" }],
        },
      },
    },
  ]) {
    assert.throws(() => decodeExecutionBoundary(invalid));
    assert.equal(normalizeSessionRuntimeStatePatch({ boundary: invalid }), undefined);
    assert.equal(normalizeSessionRuntimeStateWritePatch({ boundary: invalid }), undefined);
  }

  const oversized = {
    ...boundary,
    profile: {
      ...boundary.profile,
      fileSystem: {
        ...boundary.profile.fileSystem,
        entries: Array.from({ length: 300 }, (_, index) => ({
          kind: "path" as const,
          access: "read" as const,
          path: `/outside/${index}-${"x".repeat(3_900)}`,
          match: "exact" as const,
        })),
      },
    },
  };
  assert.throws(() => decodeExecutionBoundary(oversized), /serialized size limit/u);
  assert.equal(normalizeSessionRuntimeStateWritePatch({ boundary: oversized }), undefined);
});

test("Session boundary survives update, snapshot, and durable recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-boundary-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
  const boundary = testExecutionBoundary(6);

  try {
    const first = new Session("boundary-recovery", workDir, { persistence: true, picoHome });
    try {
      await first.recover();
      first.updateRuntimeState({ boundary });
      assert.deepEqual(first.getRuntimeStateSnapshot().boundary, boundary);
      await first.flushPersistence();
    } finally {
      await first.close();
    }

    const resumed = new Session("boundary-recovery", workDir, { persistence: true, picoHome });
    try {
      await resumed.recover();
      assert.deepEqual(resumed.getRuntimeStateSnapshot().boundary, boundary);
    } finally {
      await resumed.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable Session settings accept only v3 split axes", () => {
  const base = {
    provider: "openai",
    model: "test-model",
    modelRouteId: "test/test-model",
    orchestrationMode: "default" as const,
    thinkingEffort: "off",
    thinkingEffortExplicit: false,
    additionalDirectories: [],
  };
  for (const mode of ["default", "yolo", "ask", "plan", "auto", "full-access"] as const) {
    assert.equal(normalizeSessionRuntimeStatePatch({ settings: { ...base, mode } }), undefined);
    assert.equal(
      normalizeSessionRuntimeStateWritePatch({ settings: { ...base, mode } }),
      undefined,
    );
  }
  for (const settings of [
    base,
    { ...base, collaborationMode: "agent" },
    { ...base, permissionMode: "ask" },
    {
      ...base,
      collaborationMode: "agent",
      permissionMode: "ask",
      orchestrationMode: undefined,
    },
    { ...base, collaborationMode: "plan", permissionMode: "ask", prePlanMode: "auto" },
  ]) {
    assert.equal(normalizeSessionRuntimeStatePatch({ settings }), undefined);
  }
  assert.deepEqual(
    normalizeSessionRuntimeStateWritePatch({
      settings: { ...base, collaborationMode: "plan", permissionMode: "ask" },
    })?.settings,
    {
      ...base,
      collaborationMode: "plan",
      permissionMode: "ask",
    },
  );
});

test("Session usage requires the current cache-hit counter", () => {
  const usage = createEmptyUsageSnapshot();
  assert.deepEqual(normalizeSessionUsageSnapshot(usage), usage);
  const { totalCacheHitCalls: _removed, ...missingCounter } = usage;
  assert.equal(normalizeSessionUsageSnapshot(missingCounter), undefined);
});

test("Session runtime state accepts canonical cache sharding and rejects retired fields", () => {
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
  for (const retired of [
    { routeCallCounts: { ["b".repeat(64)]: 9 } },
    { activeRouteDigests: ["d".repeat(64)] },
  ]) {
    const patch = { promptCache: { stateVersion: 1, shardSeed, ...retired } };
    assert.equal(normalizeSessionRuntimeStatePatch(patch), undefined);
    assert.equal(normalizeSessionRuntimeStateWritePatch(patch), undefined);
  }
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

function testExecutionBoundary(revision: number): Extract<ExecutionBoundary, { kind: "managed" }> {
  const boundary = createManagedExecutionBoundary(
    {
      type: "managed",
      name: "custom",
      fileSystem: {
        kind: "restricted",
        entries: [
          { kind: "special", access: "write", special: ":workspace_roots" },
          { kind: "path", access: "read", path: "/outside/report.txt", match: "exact" },
        ],
        protectedMetadata: { access: "deny_write", names: [".git", ".codex"] },
      },
      network: { kind: "restricted" },
    },
    revision,
  );
  if (boundary.kind !== "managed") throw new Error("Expected managed execution boundary");
  return boundary;
}
