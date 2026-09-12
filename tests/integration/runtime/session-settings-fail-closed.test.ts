import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetSessionSettings,
  getOrCreateFailClosedLegacySessionSettings,
  getOrCreateSessionSettings,
  normalizeInteractionMode,
  setSessionPermissionMode,
} from "../../../src/input/session-settings.js";
import {
  createEmptyUsageSnapshot,
  SESSION_RUNTIME_STATE_VERSION,
  type PersistedSessionSettings,
  type PersistedSessionSettingsWrite,
  type SessionRuntimePersistence,
} from "../../../src/engine/session-runtime.js";
import {
  createManagedExecutionBoundary,
  createWorkspaceWritePermissionProfile,
  type ExecutionBoundary,
} from "../../../src/safety/permission-profile.js";

test("legacy permission names are not accepted as compatibility aliases", () => {
  for (const legacyMode of ["default", "yolo", "acceptedits", "bypasspermissions"]) {
    assert.equal(normalizeInteractionMode(legacyMode), undefined);
  }
});

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
    mode: "full-access",
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
      mode: "full-access",
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
    permissionMode: "ask",
    thinkingEffort: "off",
    thinkingEffortExplicit: false,
    additionalDirectories: [],
  });
  assert.equal(materialized.collaborationMode, "agent");
  assert.equal(materialized.permissionMode, "ask");
  assert.deepEqual(materialized.additionalDirectories, []);

  // Crash immediately after that first write, clear process memory, then resume under full-access defaults.
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
      mode: "full-access",
    },
    { persistence },
  );
  assert.equal(resumed.collaborationMode, "agent");
  assert.equal(resumed.permissionMode, "ask");
  assert.deepEqual(resumed.additionalDirectories, []);

  forgetSessionSettings(sessionId, cwd, picoHome);
});

test("persisted permission modes reconcile the durable execution boundary without losing managed grants", () => {
  const sessionId = "settings-execution-boundary";
  const cwd = "/tmp/pico-settings-execution-boundary";
  const picoHome = "/tmp/pico-settings-execution-boundary-home";
  let durableSettings: PersistedSessionSettings | undefined;
  let durableBoundary: ExecutionBoundary | undefined;
  const persistence: SessionRuntimePersistence = {
    getRuntimeStateSnapshot() {
      return {
        stateVersion: SESSION_RUNTIME_STATE_VERSION,
        ...(durableSettings ? { settings: durableSettings } : {}),
        ...(durableBoundary ? { boundary: durableBoundary } : {}),
        usage: createEmptyUsageSnapshot(),
      };
    },
    updateRuntimeState(patch) {
      if (patch.settings) durableSettings = structuredClone(patch.settings);
      if (patch.boundary) durableBoundary = structuredClone(patch.boundary);
    },
  };

  try {
    const settings = getOrCreateSessionSettings(
      {
        sessionId,
        cwd,
        picoHome,
        provider: "openai",
        model: "test",
        modelRouteId: "openai/test",
        mode: "ask",
      },
      { persistence },
    );

    assert.deepEqual(
      durableBoundary,
      createManagedExecutionBoundary(createWorkspaceWritePermissionProfile()),
      "the first settings fact must create a managed workspace genesis when no boundary exists",
    );

    const workspaceProfile = createWorkspaceWritePermissionProfile();
    const expanded = createManagedExecutionBoundary(
      {
        ...workspaceProfile,
        name: "custom",
        fileSystem: {
          ...workspaceProfile.fileSystem,
          entries: [
            ...workspaceProfile.fileSystem.entries,
            { kind: "path", access: "write", path: "/outside/reports", match: "subtree" },
          ],
        },
        network: { kind: "enabled" },
      },
      7,
    );
    durableBoundary = expanded;

    assert.equal(setSessionPermissionMode(settings, "auto").ok, true);
    assert.deepEqual(durableBoundary, expanded, "ask to auto must retain the expanded boundary");
    assert.equal(setSessionPermissionMode(settings, "ask").ok, true);
    assert.deepEqual(durableBoundary, expanded, "auto to ask must retain the expanded boundary");

    assert.equal(setSessionPermissionMode(settings, "full-access").ok, true);
    assert.deepEqual(durableBoundary, { kind: "bypass", revision: 8 });

    assert.equal(setSessionPermissionMode(settings, "ask").ok, true);
    assert.deepEqual(
      durableBoundary,
      createManagedExecutionBoundary(createWorkspaceWritePermissionProfile(), 9),
      "leaving full-access must rebuild a managed workspace boundary",
    );
  } finally {
    forgetSessionSettings(sessionId, cwd, picoHome);
  }
});
