import assert from "node:assert/strict";
import test from "node:test";
import type { MobileProjectId, WorkspaceStatusResult } from "@pico/protocol";
import {
  MobileProjectAccessError,
  MobileProjectAuthority,
  type MobileProjectAuthorityPort,
} from "../../src/mobile-gateway/project-authority.js";

const trustedPath = "/private/workspaces/pico-harness";
const untrustedPath = "/private/workspaces/untrusted";
const unregisteredPath = "/private/workspaces/not-registered";

test("mobile project authority exposes only opaque trusted registrations", async () => {
  const trust = new Map([
    [trustedPath, true],
    [untrustedPath, false],
    [unregisteredPath, true],
  ]);
  const trustChecks: string[] = [];
  const authority = new MobileProjectAuthority(
    createPort(trust, trustChecks),
    new Uint8Array(32).fill(7),
  );

  const projects = await authority.listProjects();

  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.name, "pico-harness");
  assert.ok(projects[0]?.projectId);
  assert.doesNotMatch(projects[0]?.projectId ?? "", /private|workspace|pico-harness/);
  assert.doesNotMatch(JSON.stringify(projects), /workspacePath|\/private\/workspaces/);
  assert.deepEqual(trustChecks.sort(), [trustedPath, untrustedPath].sort());
  assert.equal(await authority.resolveProjectPath(projects[0]!.projectId), trustedPath);
});

test("mobile project authority rechecks registration and trust on every resolution", async () => {
  const trust = new Map([[trustedPath, true]]);
  const authority = new MobileProjectAuthority(createPort(trust), new Uint8Array(32).fill(9));
  const [project] = await authority.listProjects();
  assert.ok(project);

  trust.set(trustedPath, false);

  await assert.rejects(
    () => authority.resolveProjectPath(project.projectId),
    (error: unknown) =>
      error instanceof MobileProjectAccessError && error.code === "PROJECT_NOT_FOUND",
  );
  await assert.rejects(
    () => authority.resolveProjectPath("fabricated" as MobileProjectId),
    (error: unknown) =>
      error instanceof MobileProjectAccessError && error.code === "PROJECT_NOT_FOUND",
  );
});

function createPort(
  trust: ReadonlyMap<string, boolean>,
  trustChecks: string[] = [],
): MobileProjectAuthorityPort {
  const workspaces = [
    workspaceStatus(trustedPath, true),
    workspaceStatus(untrustedPath, true),
    workspaceStatus(unregisteredPath, false),
  ];
  return {
    async listWorkspaces() {
      return workspaces;
    },
    async isWorkspaceTrusted(workspacePath) {
      trustChecks.push(workspacePath);
      return trust.get(workspacePath) ?? false;
    },
  };
}

function workspaceStatus(workspacePath: string, registered: boolean): WorkspaceStatusResult {
  return {
    workspacePath,
    registered,
    schedulerStatus: "unknown",
    mode: "git",
    branch: "main",
    capabilities: {
      foregroundRuns: true,
      fileHistory: true,
      isolatedWorktrees: true,
      branchMerge: true,
    },
  };
}
