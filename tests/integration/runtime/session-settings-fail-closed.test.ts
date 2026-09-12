import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetSessionSettings,
  getOrCreateSessionSettings,
  normalizePermissionMode,
  setSessionPermissionMode,
} from "../../../src/input/session-settings.js";
import {
  createEmptyUsageSnapshot,
  SESSION_RUNTIME_STATE_VERSION,
  type PersistedSessionSettings,
  type SessionRuntimePersistence,
} from "../../../src/engine/session-runtime.js";
import {
  createManagedExecutionBoundary,
  createWorkspaceWritePermissionProfile,
  type ExecutionBoundary,
} from "../../../src/safety/permission-profile.js";

test("legacy permission names are not accepted as compatibility aliases", () => {
  for (const legacyMode of ["default", "yolo", "acceptedits", "bypasspermissions"]) {
    assert.equal(normalizePermissionMode(legacyMode), undefined);
  }
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
        collaborationMode: "agent",
        permissionMode: "ask",
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
