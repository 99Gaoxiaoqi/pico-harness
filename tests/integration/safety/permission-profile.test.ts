import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_SANDBOX_BOUNDARY_FILESYSTEM_ENTRIES,
  PROTECTED_METADATA_NAMES,
  applyExecutionBoundaryExpansion,
  applySandboxBoundaryExpansion,
  assessSandboxBoundaryExpansion,
  canReadPath,
  canWritePath,
  compactSandboxBoundaryFilesystemEntries,
  compileRuntimePermissionProfile,
  createBypassExecutionBoundary,
  createDangerFullAccessPermissionProfile,
  createExternalExecutionBoundary,
  createManagedExecutionBoundary,
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
  executionBoundaryContains,
  isProtectedMetadataPath,
  sandboxBoundaryExpansionAllowsPath,
  validateSandboxBoundaryExpansion,
  type ManagedPermissionProfile,
  type SandboxBoundaryExpansion,
} from "../../../src/safety/permission-profile.js";

const context = {
  workspaceRoots: ["/workspace", "D:\\source"],
  tmpdir: "/private/tmp/session",
  slashTmp: "/tmp",
} as const;

test("runtime profile compiler gives Plan precedence and emits stable boundaries", () => {
  const plan = compileRuntimePermissionProfile({
    collaborationMode: "plan",
    permissionMode: "full-access",
    revision: 7,
  });
  assert.deepEqual(plan, {
    kind: "managed",
    revision: 7,
    profile: createReadOnlyPermissionProfile(),
  });

  for (const permissionMode of ["ask", "auto"] as const) {
    assert.deepEqual(
      compileRuntimePermissionProfile({ collaborationMode: "agent", permissionMode }),
      {
        kind: "managed",
        revision: 0,
        profile: createWorkspaceWritePermissionProfile(),
      },
    );
  }
  assert.deepEqual(
    compileRuntimePermissionProfile({ collaborationMode: "agent", permissionMode: "full-access" }),
    { kind: "bypass", revision: 0 },
  );
  assert.throws(
    () =>
      compileRuntimePermissionProfile({
        collaborationMode: "agent",
        permissionMode: "ask",
        revision: -1,
      }),
    /revision/u,
  );
});

test("standard profiles keep workspace writes and network inside the managed boundary", () => {
  const readOnly = createReadOnlyPermissionProfile();
  assert.equal(canReadPath(readOnly, "/workspace/README.md", context), true);
  assert.equal(canWritePath(readOnly, "/workspace/README.md", context), false);
  assert.equal(readOnly.network.kind, "restricted");

  const workspaceWrite = createWorkspaceWritePermissionProfile();
  assert.equal(canWritePath(workspaceWrite, "/workspace/src/main.ts", context), true);
  assert.equal(canWritePath(workspaceWrite, "/private/tmp/session/result", context), true);
  assert.equal(canWritePath(workspaceWrite, "/tmp/result", context), true);
  assert.equal(canWritePath(workspaceWrite, "/outside/result", context), false);
  assert.equal(workspaceWrite.network.kind, "restricted");
  assert.equal(workspaceWrite.fileSystem.protectedMetadata, undefined);

  const unrestricted = createDangerFullAccessPermissionProfile();
  assert.equal(unrestricted.fileSystem.kind, "unrestricted");
  assert.equal(unrestricted.network.kind, "enabled");
  assert.equal(canWritePath(unrestricted, "/workspace/.git/config", context), true);
});

test("custom protected metadata is readable but not writable on POSIX and Windows roots", () => {
  const workspaceWrite = createWorkspaceWritePermissionProfile();
  const profile: ManagedPermissionProfile = {
    ...workspaceWrite,
    name: "custom",
    fileSystem: {
      ...workspaceWrite.fileSystem,
      protectedMetadata: { access: "deny_write", names: PROTECTED_METADATA_NAMES },
    },
  };
  for (const path of [
    "/workspace/.git/config",
    "/workspace/packages/tool/.agents/rules.json",
    "/workspace/.codex/settings.json",
    "D:\\source\\.GIT\\config",
  ]) {
    assert.equal(isProtectedMetadataPath(path, context.workspaceRoots), true, path);
    assert.equal(canReadPath(profile, path, context), true, path);
    assert.equal(canWritePath(profile, path, context), false, path);
  }
  assert.equal(isProtectedMetadataPath("/outside/.git/config", context.workspaceRoots), false);
});

test("boundary expansion validation rejects malformed authority and compacts overlap", () => {
  assert.deepEqual(validateSandboxBoundaryExpansion({}), {
    ok: false,
    reason: "empty_expansion",
    message: "Sandbox boundary expansion must contain a permission.",
  });
  const relativePath = validateSandboxBoundaryExpansion({
    filesystem: { entries: [{ path: "relative", access: "read", scope: "exact" }] },
  });
  assert.equal(relativePath.ok, false);
  if (!relativePath.ok) assert.equal(relativePath.reason, "invalid_path");
  assert.equal(validateSandboxBoundaryExpansion({ network: { enabled: false } }).ok, false);
  assert.equal(
    validateSandboxBoundaryExpansion({ network: { enabled: true }, extra: true }).ok,
    false,
  );
  const tooManyEntries = validateSandboxBoundaryExpansion({
    filesystem: {
      entries: Array.from({ length: MAX_SANDBOX_BOUNDARY_FILESYSTEM_ENTRIES + 1 }, (_, index) => ({
        path: `/outside/${index}`,
        access: "read",
        scope: "exact",
      })),
    },
  });
  assert.equal(tooManyEntries.ok, false);
  if (!tooManyEntries.ok) assert.equal(tooManyEntries.reason, "too_many_entries");

  const validated = validateSandboxBoundaryExpansion({
    filesystem: {
      entries: [
        { path: "/outside/tree/file.txt", access: "read", scope: "exact" },
        { path: "/outside/tree", access: "read", scope: "subtree" },
        { path: "/outside/tree/file.txt", access: "write", scope: "exact" },
        { path: "/outside/tree/file.txt", access: "write", scope: "exact" },
      ],
    },
    network: { enabled: true },
  });
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  assert.deepEqual(validated.expansion, {
    filesystem: {
      entries: [
        { path: "/outside/tree", access: "read", scope: "subtree" },
        { path: "/outside/tree/file.txt", access: "write", scope: "exact" },
      ],
    },
    network: { enabled: true },
  });
});

test("exact and subtree expansions preserve read/write coverage semantics", () => {
  const entries = compactSandboxBoundaryFilesystemEntries([
    { path: "/data", access: "write", scope: "subtree" },
    { path: "/data/file", access: "read", scope: "exact" },
    { path: "/data/nested", access: "write", scope: "subtree" },
  ]);
  assert.deepEqual(entries, [{ path: "/data", access: "write", scope: "subtree" }]);

  const expansion: SandboxBoundaryExpansion = { filesystem: { entries } };
  assert.equal(sandboxBoundaryExpansionAllowsPath(expansion, "/data/file", "read"), true);
  assert.equal(sandboxBoundaryExpansionAllowsPath(expansion, "/data/file", "write"), true);
  assert.equal(sandboxBoundaryExpansionAllowsPath(expansion, "/database/file", "read"), false);

  const exact: SandboxBoundaryExpansion = {
    filesystem: {
      entries: [{ path: "/single/file", access: "read", scope: "exact" }],
    },
  };
  assert.equal(sandboxBoundaryExpansionAllowsPath(exact, "/single/file", "read"), true);
  assert.equal(sandboxBoundaryExpansionAllowsPath(exact, "/single/file/child", "read"), false);
  assert.equal(sandboxBoundaryExpansionAllowsPath(exact, "/single/file", "write"), false);
});

test("revisioned expansion applies once, then becomes a no-op, and rejects stale writers", () => {
  const initial = createManagedExecutionBoundary(createWorkspaceWritePermissionProfile(), 4);
  const expansion: SandboxBoundaryExpansion = {
    filesystem: {
      entries: [{ path: "/outside/report.txt", access: "write", scope: "exact" }],
    },
    network: { enabled: true },
  };
  const applied = applyExecutionBoundaryExpansion(initial, 4, expansion, context);
  assert.equal(applied.outcome, "applied");
  assert.equal(applied.boundary.revision, 5);
  assert.equal(applied.boundary.kind, "managed");
  if (applied.boundary.kind !== "managed") return;
  assert.equal(canWritePath(applied.boundary.profile, "/outside/report.txt", context), true);
  assert.equal(canWritePath(applied.boundary.profile, "/outside/other.txt", context), false);
  assert.equal(applied.boundary.profile.network.kind, "enabled");

  const noop = applyExecutionBoundaryExpansion(applied.boundary, 5, expansion, context);
  assert.equal(noop.outcome, "noop");
  assert.strictEqual(noop.boundary, applied.boundary);

  assert.deepEqual(applyExecutionBoundaryExpansion(applied.boundary, 4, expansion, context), {
    outcome: "conflict",
    reason: "stale_revision",
    boundary: applied.boundary,
  });
  const bypass = createBypassExecutionBoundary(5);
  assert.deepEqual(applyExecutionBoundaryExpansion(bypass, 5, expansion, context), {
    outcome: "conflict",
    reason: "not_managed",
    boundary: bypass,
  });
});

test("expansions cannot weaken protected metadata or explicit deny entries", () => {
  const workspaceWrite = createWorkspaceWritePermissionProfile();
  const profile: ManagedPermissionProfile = {
    ...workspaceWrite,
    name: "custom",
    fileSystem: {
      ...workspaceWrite.fileSystem,
      protectedMetadata: { access: "deny_write", names: PROTECTED_METADATA_NAMES },
    },
  };
  const protectedExpansion: SandboxBoundaryExpansion = {
    filesystem: {
      entries: [{ path: "/workspace/.git/config", access: "write", scope: "exact" }],
    },
  };
  assert.deepEqual(assessSandboxBoundaryExpansion(profile, protectedExpansion, context), {
    outcome: "conflict",
    reason: "explicit_deny",
  });

  const denied: ManagedPermissionProfile = {
    ...createReadOnlyPermissionProfile(),
    name: "custom",
    fileSystem: {
      ...createReadOnlyPermissionProfile().fileSystem,
      entries: [
        ...createReadOnlyPermissionProfile().fileSystem.entries,
        { kind: "path", access: "deny", path: "/secrets", match: "subtree" },
      ],
    },
  };
  const deniedExpansion: SandboxBoundaryExpansion = {
    filesystem: {
      entries: [{ path: "/secrets/token", access: "read", scope: "exact" }],
    },
  };
  assert.deepEqual(assessSandboxBoundaryExpansion(denied, deniedExpansion, context), {
    outcome: "conflict",
    reason: "explicit_deny",
  });
  assert.strictEqual(
    applySandboxBoundaryExpansion(denied, { network: { enabled: true } }).fileSystem.entries[1],
    denied.fileSystem.entries[1],
  );
});

test("execution boundary containment covers kind, network, paths, and protected metadata", () => {
  const readOnly = createManagedExecutionBoundary(createReadOnlyPermissionProfile(), 0);
  const workspaceWrite = createManagedExecutionBoundary(createWorkspaceWritePermissionProfile(), 0);
  const bypass = createBypassExecutionBoundary();
  const external = createExternalExecutionBoundary();

  assert.equal(executionBoundaryContains(workspaceWrite, readOnly), true);
  assert.equal(executionBoundaryContains(readOnly, workspaceWrite), false);
  assert.equal(executionBoundaryContains(bypass, workspaceWrite), true);
  assert.equal(executionBoundaryContains(bypass, external), true);
  assert.equal(executionBoundaryContains(external, external), true);
  assert.equal(executionBoundaryContains(external, readOnly), false);
  assert.equal(executionBoundaryContains(workspaceWrite, bypass), false);

  const networkEnabled = createManagedExecutionBoundary(
    applySandboxBoundaryExpansion(createReadOnlyPermissionProfile(), {
      network: { enabled: true },
    }),
  );
  assert.equal(executionBoundaryContains(readOnly, networkEnabled), false);

  const protectedWorkspace: ManagedPermissionProfile = {
    ...createWorkspaceWritePermissionProfile(),
    name: "custom",
    fileSystem: {
      ...createWorkspaceWritePermissionProfile().fileSystem,
      protectedMetadata: { access: "deny_write", names: PROTECTED_METADATA_NAMES },
    },
  };
  const missingProtection: ManagedPermissionProfile = {
    ...protectedWorkspace,
    fileSystem: { ...protectedWorkspace.fileSystem, protectedMetadata: undefined },
  };
  assert.equal(
    executionBoundaryContains(
      createManagedExecutionBoundary(protectedWorkspace),
      createManagedExecutionBoundary(missingProtection),
    ),
    false,
  );
});
