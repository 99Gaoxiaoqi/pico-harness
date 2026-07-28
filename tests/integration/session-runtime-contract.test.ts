import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  runtimeEventHasModelMessage,
} from "../../src/engine/session-runtime-event.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION as runtimeSchemaVersion,
  decodeRuntimeEvent,
  runtimeEventHasModelMessage as runtimeModelMessageGuard,
} from "../../src/storage/runtime-event.js";
import { materializeRuntimeHistoryEntries } from "../../src/engine/session-runtime-read-model.js";
import { materializeRuntimeHistoryEntries as runtimeMaterializeHistoryEntries } from "../../src/engine/session-runtime-read-model.js";
import {
  SESSION_RUNTIME_STATE_VERSION,
  normalizeSessionRuntimeStatePatch,
} from "../../src/engine/session-runtime.js";

test("Runtime adapters preserve the engine-owned durable Session contracts", () => {
  assert.equal(runtimeSchemaVersion, RUNTIME_EVENT_SCHEMA_VERSION);
  assert.strictEqual(runtimeModelMessageGuard, runtimeEventHasModelMessage);
  assert.strictEqual(runtimeMaterializeHistoryEntries, materializeRuntimeHistoryEntries);
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
