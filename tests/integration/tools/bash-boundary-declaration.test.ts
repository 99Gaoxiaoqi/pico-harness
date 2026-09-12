import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  managedProcessLauncher,
  SandboxViolationError,
  type ManagedSpawnRequest,
} from "../../../src/safety/process-sandbox/index.js";
import { compileRuntimeProcessSandbox } from "../../../src/safety/runtime-process-sandbox.js";
import {
  createManagedExecutionBoundary,
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
  type ManagedPermissionProfile,
} from "../../../src/safety/permission-profile.js";
import { BashTool } from "../../../src/tools/bash.js";
import {
  buildDefaultToolRegistry,
  type DefaultProcessSandboxDescriptor,
} from "../../../src/tools/default-registry.js";
import { WorkspaceRoots } from "../../../src/tools/workspace-roots.js";

test("Bash schema adds an explicit boundary declaration without changing legacy arguments", () => {
  const schema = new BashTool(process.cwd()).definition().inputSchema;
  const properties = schema["properties"] as Record<string, Record<string, unknown>>;

  assert.equal(properties["command"]?.["type"], "string");
  assert.equal(properties["background"]?.["type"], "boolean");
  assert.deepEqual(properties["boundary_intent"]?.["enum"], ["current", "expand"]);
  assert.equal(properties["boundary_intent"]?.["default"], "current");
  assert.equal(properties["required_boundary"]?.["type"], "object");
  assert.match(JSON.stringify(schema), /request_sandbox_boundary/u);
});

test("Bash expand preflights the live descriptor and never widens it itself", async (context) => {
  const root = await mkdtemp(join(process.cwd(), ".pico-bash-boundary-declaration-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const scratchRoot = join(root, "scratch");
  await mkdir(workspace);
  await mkdir(outside);
  const target = join(outside, "result.txt");
  const canonicalTarget = join(await realpath(outside), "result.txt");
  const roots = await WorkspaceRoots.create(workspace);

  let descriptor: DefaultProcessSandboxDescriptor = {
    profile: "workspace-write",
    config: { network: "deny" },
    scratchRoot,
    generation: 0,
  };
  let resolverCalls = 0;
  const registry = buildDefaultToolRegistry(workspace, {
    workspaceRoots: roots,
    deferWorkspaceBoundary: true,
    processSandbox: {
      ...descriptor,
      resolveSandbox: () => {
        resolverCalls++;
        return descriptor;
      },
    },
  });
  const bash = registry.getTool("bash");
  assert.ok(bash);

  const launches: ManagedSpawnRequest[] = [];
  context.mock.method(managedProcessLauncher, "launch", (request: ManagedSpawnRequest) => {
    launches.push(request);
    throw new Error("launch reached");
  });
  const requiredBoundary = {
    filesystem: {
      entries: [{ path: target, access: "write" as const, scope: "exact" as const }],
    },
    network: { enabled: true as const },
  };

  const rejected = await bash
    .execute(
      JSON.stringify({
        command: "echo blocked",
        boundary_intent: "expand",
        required_boundary: requiredBoundary,
      }),
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert.ok(rejected instanceof SandboxViolationError);
  assert.equal(rejected.code, "sandbox_boundary_required");
  assert.deepEqual(rejected.requiredExpansion, {
    filesystem: {
      entries: [
        {
          ...requiredBoundary.filesystem.entries[0]!,
          path: canonicalTarget,
        },
      ],
    },
    network: { enabled: true },
  });
  assert.match(rejected.message, /request_sandbox_boundary/u);
  assert.equal(launches.length, 0);
  await assert.rejects(stat(scratchRoot), { code: "ENOENT" });

  const currentResult = await bash.execute(
    JSON.stringify({
      command: "echo current",
      boundary_intent: "current",
      required_boundary: requiredBoundary,
    }),
  );
  assert.match(currentResult, /launch reached/u);
  assert.equal(launches.length, 1);
  assert.equal(launches[0]?.policy.network, "deny");
  assert.equal(launches[0]?.policy.writeFiles?.includes(target) ?? false, false);

  descriptor = {
    ...descriptor,
    config: { network: "allow" },
    writeFiles: [canonicalTarget],
    generation: 1,
  };
  const expandedResult = await bash.execute(
    JSON.stringify({
      command: `printf approved > "${canonicalTarget}"`,
      boundary_intent: "expand",
      required_boundary: requiredBoundary,
    }),
  );
  assert.match(expandedResult, /launch reached/u);
  assert.equal(launches.length, 2);
  assert.equal(launches[1]?.policy.network, "allow");
  assert.deepEqual(launches[1]?.policy.writeFiles, [canonicalTarget]);

  const legacyResult = await bash.execute(JSON.stringify({ command: "echo legacy" }));
  assert.match(legacyResult, /launch reached/u);
  assert.equal(launches.length, 3);

  descriptor = { ...descriptor, hasUnsupportedDenyEntries: true, generation: 2 };
  const denyFailure = await bash.execute(JSON.stringify({ command: "echo denied" })).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(denyFailure instanceof SandboxViolationError);
  assert.equal(denyFailure.code, "policy_compilation_failed");
  assert.match(denyFailure.message, /deny.*fail-closed/iu);
  assert.equal(launches.length, 3);

  descriptor = {
    profile: "read-only",
    config: { network: "allow" },
    scratchRoot,
    generation: 3,
  };
  const readonlyNetworkResult = await bash.execute(
    JSON.stringify({
      command: "curl https://example.com",
      boundary_intent: "expand",
      required_boundary: { network: { enabled: true } },
    }),
  );
  assert.match(readonlyNetworkResult, /launch reached/u);
  assert.equal(launches.length, 4);
  assert.equal(launches[3]?.policy.profile, "read-only");
  assert.equal(launches[3]?.policy.network, "allow");
  assert.equal(resolverCalls, 6);
});

test("runtime sandbox compiles profile capabilities instead of trusting its label", () => {
  const base = createWorkspaceWritePermissionProfile();
  const explicitDeny = {
    ...base,
    name: "custom" as const,
    fileSystem: {
      ...base.fileSystem,
      entries: [
        ...base.fileSystem.entries,
        {
          kind: "path" as const,
          access: "deny" as const,
          path: "/secrets",
          match: "subtree" as const,
        },
      ],
    },
  };
  const protectedMetadata = {
    ...base,
    name: "custom" as const,
    fileSystem: {
      ...base.fileSystem,
      protectedMetadata: { access: "deny_write" as const, names: [".git"] },
    },
  };

  for (const profile of [explicitDeny, protectedMetadata]) {
    assert.throws(
      () => compileDescriptor(profile),
      (error: unknown) =>
        error instanceof SandboxViolationError && error.code === "policy_compilation_failed",
    );
  }

  const mislabeledWorkspaceWriter = { ...base, name: "read-only" as const };
  assert.equal(compileDescriptor(mislabeledWorkspaceWriter).profile, "workspace-write");

  const readOnly = createReadOnlyPermissionProfile();
  const exactWriter = {
    ...readOnly,
    fileSystem: {
      ...readOnly.fileSystem,
      entries: [
        ...readOnly.fileSystem.entries,
        {
          kind: "path" as const,
          access: "write" as const,
          path: "/outside/write.txt",
          match: "exact" as const,
        },
      ],
    },
  };
  const exactWriterDescriptor = compileDescriptor(exactWriter);
  assert.equal(exactWriterDescriptor.profile, "read-only");
  assert.deepEqual(exactWriterDescriptor.writeFiles, ["/outside/write.txt"]);

  assert.throws(
    () =>
      compileDescriptor({
        ...base,
        name: "custom",
        fileSystem: { kind: "unrestricted", entries: [] },
        network: { kind: "restricted" },
      }),
    (error: unknown) =>
      error instanceof SandboxViolationError && error.code === "policy_compilation_failed",
  );
});

function compileDescriptor(profile: ManagedPermissionProfile) {
  return compileRuntimeProcessSandbox({
    collaborationMode: "agent",
    workspaceGeneration: 0,
    scratchRoot: "/tmp/pico-bash-boundary-restriction-test",
    executionBoundary: createManagedExecutionBoundary(profile),
  });
}
