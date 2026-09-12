import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionPermissionGrants } from "../../../src/approval/session-permissions.js";
import { compileRuntimeProcessSandbox } from "../../../src/safety/runtime-process-sandbox.js";
import {
  applyExecutionBoundaryExpansion,
  createManagedExecutionBoundary,
  createWorkspaceWritePermissionProfile,
} from "../../../src/safety/permission-profile.js";

const scratchRoot = "/tmp/pico-runtime-process-sandbox-test";

test("foreground modes compile to one authoritative process boundary", () => {
  for (const permissionMode of ["ask", "auto"] as const) {
    const descriptor = compileRuntimeProcessSandbox({
        collaborationMode: "agent",
        permissionMode,
        workspaceGeneration: 4,
        scratchRoot,
      });
    assert.equal(descriptor.profile, "workspace-write");
    assert.deepEqual(descriptor.config, { network: "deny" });
    assert.equal(descriptor.scratchRoot, scratchRoot);
    assert.equal(descriptor.generation, 34);
    assert.ok(descriptor.writeRoots?.includes("/tmp"));
  }

  assert.deepEqual(
    compileRuntimeProcessSandbox({
      collaborationMode: "agent",
      permissionMode: "full-access",
      workspaceGeneration: 4,
      scratchRoot,
    }),
    {
      profile: "danger-full-access",
      scratchRoot,
      generation: 35,
    },
  );
});

test("Plan remains read-only even when full access or a network grant is selected", () => {
  const descriptor = compileRuntimeProcessSandbox({
      collaborationMode: "plan",
      permissionMode: "full-access",
      workspaceGeneration: 4,
      scratchRoot,
      networkEnabled: true,
    });
  assert.deepEqual(descriptor, {
    profile: "read-only",
    config: { network: "deny" },
    scratchRoot,
    generation: 33,
  });
});

test("approved managed network expands the sandbox and changes its generation", () => {
  const restricted = compileRuntimeProcessSandbox({
    collaborationMode: "agent",
    permissionMode: "auto",
    workspaceGeneration: 7,
    scratchRoot,
  });
  const expanded = compileRuntimeProcessSandbox({
    collaborationMode: "agent",
    permissionMode: "auto",
    workspaceGeneration: 7,
    scratchRoot,
    networkEnabled: true,
  });

  assert.equal(restricted.profile, "workspace-write");
  assert.deepEqual(restricted.config, { network: "deny" });
  assert.equal(expanded.profile, "workspace-write");
  assert.deepEqual(expanded.config, { network: "allow" });
  assert.notEqual(expanded.generation, restricted.generation);
});

test("durable boundary paths compile without widening exact files to parent directories", () => {
  const initial = createManagedExecutionBoundary(createWorkspaceWritePermissionProfile(), 2);
  const applied = applyExecutionBoundaryExpansion(initial, 2, {
    filesystem: {
      entries: [
        { path: "/outside/read-tree", access: "read", scope: "subtree" },
        { path: "/outside/write-tree", access: "write", scope: "subtree" },
        { path: "/outside/read.txt", access: "read", scope: "exact" },
        { path: "/outside/write.txt", access: "write", scope: "exact" },
      ],
    },
    network: { enabled: true },
  });
  assert.equal(applied.outcome, "applied");
  const descriptor = compileRuntimeProcessSandbox({
    collaborationMode: "agent",
    permissionMode: "ask",
    workspaceGeneration: 0,
    scratchRoot,
    executionBoundary: applied.boundary,
  });
  assert.equal(descriptor.profile, "workspace-write");
  assert.deepEqual(descriptor.config, { network: "allow" });
  assert.ok(descriptor.readRoots?.includes("/outside/read-tree"));
  assert.ok(descriptor.writeRoots?.includes("/outside/write-tree"));
  assert.deepEqual(descriptor.readFiles, ["/outside/read.txt"]);
  assert.deepEqual(descriptor.writeFiles, ["/outside/write.txt"]);

  const plan = compileRuntimeProcessSandbox({
    collaborationMode: "plan",
    permissionMode: "full-access",
    workspaceGeneration: 0,
    scratchRoot,
    executionBoundary: applied.boundary,
  });
  assert.equal(plan.profile, "read-only");
  assert.deepEqual(plan.config, { network: "deny" });
  assert.equal(plan.readFiles, undefined);
  assert.equal(plan.writeFiles, undefined);
});

test("background jobs keep their frozen network boundary", () => {
  for (const networkPolicy of ["disabled", "allowlist"] as const) {
    assert.deepEqual(
      compileRuntimeProcessSandbox({
        collaborationMode: "agent",
        permissionMode: "full-access",
        workspaceGeneration: 2,
        scratchRoot,
        networkEnabled: true,
        backgroundNetworkPolicy: networkPolicy,
      }),
      {
        profile: "workspace-write",
        config: { network: "deny" },
        scratchRoot,
        generation: 20,
      },
    );
  }

  assert.deepEqual(
    compileRuntimeProcessSandbox({
      collaborationMode: "plan",
      permissionMode: "ask",
      workspaceGeneration: 2,
      scratchRoot,
      backgroundNetworkPolicy: "allow",
    }),
    {
      profile: "workspace-write",
      config: { network: "allow" },
      scratchRoot,
      generation: 21,
    },
  );
});

test("session network grants are scoped, one-shot, and fully revocable", () => {
  const grants = new SessionPermissionGrants();
  const picoHome = "/tmp/pico-home";
  const workDir = "/tmp/workspace-a";

  grants.authorizeNetworkOnce("session-a", workDir, "call-a", picoHome);
  assert.equal(
    grants.consumeNetworkAuthorization("session-a", workDir, "call-a", picoHome),
    true,
  );
  assert.equal(
    grants.consumeNetworkAuthorization("session-a", workDir, "call-a", picoHome),
    false,
  );
  assert.equal(
    grants.consumeNetworkAuthorization("session-b", workDir, "call-a", picoHome),
    false,
  );

  grants.addNetwork("session-a", workDir, picoHome);
  assert.equal(grants.allowsNetwork("session-a", workDir, picoHome), true);
  assert.equal(grants.allowsNetwork("session-a", "/tmp/workspace-b", picoHome), false);
  assert.equal(
    grants.consumeNetworkAuthorization("session-a", workDir, undefined, picoHome),
    true,
  );

  grants.authorizeNetworkOnce("session-a", workDir, "call-b", picoHome);
  grants.clear("session-a");
  assert.equal(grants.allowsNetwork("session-a", workDir, picoHome), false);
  assert.equal(
    grants.consumeNetworkAuthorization("session-a", workDir, "call-b", picoHome),
    false,
  );
});
