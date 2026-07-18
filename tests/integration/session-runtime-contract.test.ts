import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  runtimeEventHasModelMessage,
} from "../../src/engine/session-runtime-event.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION as runtimeSchemaVersion,
  runtimeEventHasModelMessage as runtimeModelMessageGuard,
} from "../../src/runtime/runtime-event.js";
import { materializeRuntimeHistoryEntries } from "../../src/engine/session-runtime-read-model.js";
import { materializeRuntimeHistoryEntries as runtimeMaterializeHistoryEntries } from "../../src/runtime/runtime-event-read-model.js";

test("Runtime adapters preserve the engine-owned durable Session contracts", () => {
  assert.equal(runtimeSchemaVersion, RUNTIME_EVENT_SCHEMA_VERSION);
  assert.strictEqual(runtimeModelMessageGuard, runtimeEventHasModelMessage);
  assert.strictEqual(runtimeMaterializeHistoryEntries, materializeRuntimeHistoryEntries);
});
