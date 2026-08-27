import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetSessionSettings,
  getOrCreateFailClosedLegacySessionSettings,
  getOrCreateSessionSettings,
} from "../../src/input/session-settings.js";
import {
  createEmptyUsageSnapshot,
  SESSION_RUNTIME_STATE_VERSION,
  type PersistedSessionSettings,
  type PersistedSessionSettingsWrite,
  type SessionRuntimePersistence,
} from "../../src/engine/session-runtime.js";

test("legacy settings materialization publishes one complete fail-closed first fact", () => {
  const sessionId = "legacy-settings-first-fact";
  const cwd = "/tmp/pico-legacy-settings-first-fact";
  const picoHome = "/tmp/pico-legacy-settings-first-fact-home";
  const writes: PersistedSessionSettingsWrite[] = [];
  let durableSettings: PersistedSessionSettings | undefined;
  const persistence: SessionRuntimePersistence = {
    getRuntimeStateSnapshot() {
      return {
        stateVersion: SESSION_RUNTIME_STATE_VERSION,
        ...(durableSettings ? { settings: structuredClone(durableSettings) } : {}),
        usage: createEmptyUsageSnapshot(),
      };
    },
    updateRuntimeState(patch) {
      assert.ok(patch.settings);
      const settings = structuredClone(patch.settings) as PersistedSessionSettingsWrite;
      writes.push(settings);
      durableSettings = settings;
    },
  };

  // Simulate mutable process defaults already cached before the historical Session is opened.
  getOrCreateSessionSettings({
    sessionId,
    cwd,
    picoHome,
    provider: "openai",
    model: "mutable-model",
    modelRouteId: "mutable/mutable-model",
    mode: "yolo",
    orchestrationMode: "graph",
    additionalDirectories: ["/mutable/grant"],
  });

  const materialized = getOrCreateFailClosedLegacySessionSettings(
    {
      sessionId,
      sessionMode: "resume",
      cwd,
      picoHome,
      provider: "openai",
      model: "safe-model",
      modelRouteId: "safe/safe-model",
      mode: "yolo",
      orchestrationMode: "graph",
      additionalDirectories: ["/mutable/grant"],
    },
    { persistence },
  );

  assert.equal(writes.length, 1, "the first durable fact must be the complete safe snapshot");
  assert.deepEqual(writes[0], {
    provider: "openai",
    model: "safe-model",
    modelRouteId: "safe/safe-model",
    collaborationMode: "agent",
    orchestrationMode: "default",
    permissionMode: "default",
    thinkingEffort: "off",
    thinkingEffortExplicit: false,
    additionalDirectories: [],
  });
  assert.equal(materialized.collaborationMode, "agent");
  assert.equal(materialized.permissionMode, "default");
  assert.deepEqual(materialized.additionalDirectories, []);

  // Crash immediately after that first write, clear process memory, then resume under yolo defaults.
  forgetSessionSettings(sessionId, cwd, picoHome);
  const resumed = getOrCreateSessionSettings(
    {
      sessionId,
      sessionMode: "resume",
      cwd,
      picoHome,
      provider: "openai",
      model: "mutable-model",
      modelRouteId: "mutable/mutable-model",
      mode: "yolo",
    },
    { persistence },
  );
  assert.equal(resumed.collaborationMode, "agent");
  assert.equal(resumed.permissionMode, "default");
  assert.deepEqual(resumed.additionalDirectories, []);

  forgetSessionSettings(sessionId, cwd, picoHome);
});
