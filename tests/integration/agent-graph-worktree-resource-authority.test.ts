import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { createBuiltinAgentGraphOperatorProfileCatalog } from "../../src/agent-graph/operator-profile-catalog.js";
import type { AgentGraphProfileSnapshot } from "../../src/agent-graph/core/contracts.js";
import { AgentGraphWorkspaceResourceAuthority } from "../../src/runtime/agent-graph-workspace-resource-authority.js";
import { SqliteAgentGraphControlStore } from "../../src/storage/sqlite/sqlite-agent-graph-control-store.js";
import { Session } from "../../src/engine/session.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";

const execFileAsync = promisify(execFile);

test("isolated Graph workspace is adopted after reopen and cleaned only when safe", async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), "pico-graph-worktree-authority-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const repoRoot = join(fixture, "repo");
  const storageRoot = join(fixture, "storage");
  await git(["init", repoRoot], fixture);
  await git(["config", "user.email", "pico@example.invalid"], repoRoot);
  await git(["config", "user.name", "Pico Test"], repoRoot);
  await writeFile(join(repoRoot, "README.md"), "root\n", "utf8");
  await git(["add", "README.md"], repoRoot);
  await git(["commit", "-m", "root"], repoRoot);

  const store = new SqliteAgentGraphControlStore({ storageRoot });
  context.after(() => store.close());
  const provision = seedIsolatedProvision(store);
  const firstAuthority = new AgentGraphWorkspaceResourceAuthority({ repoRoot, storageRoot, store });
  const first = await firstAuthority.resolve(provision);
  assert.equal(await realpath(first.sessionOptions?.runtimeStorageRoot ?? ""), store.storageRoot);
  assert.equal(
    (await git(["branch", "--show-current"], first.workDir)).stdout
      .trim()
      .startsWith("pico/graph-"),
    true,
  );

  const persisted = store.getWorkspaceResourceByProvision(provision.provisionId)!;
  assert.equal(persisted.state, "active");
  assert.equal(persisted.worktreePath, first.workDir);

  await first.release?.("host-shutdown");
  const reopened = new AgentGraphWorkspaceResourceAuthority({ repoRoot, storageRoot, store });
  await reopened.recover();
  const second = await reopened.resolve(provision);
  assert.equal(second.workDir, first.workDir);
  assert.equal(store.listWorkspaceResources().length, 1);

  await writeFile(join(second.workDir, "operator.txt"), "uncommitted\n", "utf8");
  await second.release?.("provision-stopped");
  assert.equal(store.getWorkspaceResource(persisted.resourceId)?.state, "retained");
  assert.equal(
    (await git(["status", "--porcelain"], second.workDir)).stdout.trim(),
    "?? operator.txt",
  );
  await rm(join(second.workDir, "operator.txt"));
  await reopened.cleanupProvision(provision.provisionId);
  assert.equal(store.getWorkspaceResource(persisted.resourceId)?.state, "cleaned");
  await assert.rejects(() => realpath(second.workDir), /ENOENT/u);
});

test("isolated Graph workspace recovers a materialized but unactivated resource", async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), "pico-graph-worktree-recovery-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const repoRoot = join(fixture, "repo");
  const storageRoot = join(fixture, "storage");
  await git(["init", repoRoot], fixture);
  await git(["config", "user.email", "pico@example.invalid"], repoRoot);
  await git(["config", "user.name", "Pico Test"], repoRoot);
  await writeFile(join(repoRoot, "README.md"), "root\n", "utf8");
  await git(["add", "README.md"], repoRoot);
  await git(["commit", "-m", "root"], repoRoot);
  const store = new SqliteAgentGraphControlStore({ storageRoot });
  context.after(() => store.close());
  const provision = seedIsolatedProvision(store);
  let interrupted = false;
  const crashing = new AgentGraphWorkspaceResourceAuthority({
    repoRoot,
    storageRoot,
    store,
    afterGitSideEffect: async (operation) => {
      if (operation === "add" && !interrupted) {
        interrupted = true;
        throw new Error("simulated crash after git add");
      }
    },
  });
  await assert.rejects(() => crashing.resolve(provision), /simulated crash/u);
  const requested = store.getWorkspaceResourceByProvision(provision.provisionId)!;
  assert.equal(requested.state, "requested");

  const recovered = new AgentGraphWorkspaceResourceAuthority({ repoRoot, storageRoot, store });
  await recovered.recover();
  assert.equal(store.getWorkspaceResource(requested.resourceId)?.state, "active");
  assert.equal(store.listWorkspaceResources().length, 1);
});

test("isolated Graph workspace finishes cleanup after process loss following git remove", async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), "pico-graph-worktree-remove-recovery-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const repoRoot = join(fixture, "repo");
  const storageRoot = join(fixture, "storage");
  await git(["init", repoRoot], fixture);
  await git(["config", "user.email", "pico@example.invalid"], repoRoot);
  await git(["config", "user.name", "Pico Test"], repoRoot);
  await writeFile(join(repoRoot, "README.md"), "root\n", "utf8");
  await git(["add", "README.md"], repoRoot);
  await git(["commit", "-m", "root"], repoRoot);
  const store = new SqliteAgentGraphControlStore({ storageRoot });
  context.after(() => store.close());
  const provision = seedIsolatedProvision(store);
  const authority = new AgentGraphWorkspaceResourceAuthority({ repoRoot, storageRoot, store });
  await authority.resolve(provision);
  let transitioned = store.transitionOperatorProvision({
    provisionId: provision.provisionId,
    expectedVersion: 1,
    from: "requested",
    to: "provisioned",
  }).record;
  transitioned = store.transitionOperatorProvision({
    provisionId: provision.provisionId,
    expectedVersion: transitioned.version,
    from: "provisioned",
    to: "stopping",
  }).record;
  store.transitionOperatorProvision({
    provisionId: provision.provisionId,
    expectedVersion: transitioned.version,
    from: "stopping",
    to: "stopped",
  });
  let interrupted = false;
  const crashing = new AgentGraphWorkspaceResourceAuthority({
    repoRoot,
    storageRoot,
    store,
    afterGitSideEffect: async (operation) => {
      if (operation === "remove" && !interrupted) {
        interrupted = true;
        throw new Error("simulated crash after git remove");
      }
    },
  });
  await assert.rejects(() => crashing.cleanupProvision(provision.provisionId), /simulated crash/u);
  assert.equal(store.getWorkspaceResourceByProvision(provision.provisionId)?.state, "active");

  const recovered = new AgentGraphWorkspaceResourceAuthority({ repoRoot, storageRoot, store });
  await recovered.recover();
  assert.equal(store.getWorkspaceResourceByProvision(provision.provisionId)?.state, "cleaned");
});

test("isolated Session keeps its durable authority in the root workspace", async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), "pico-graph-isolated-session-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const picoHome = join(fixture, "pico-home");
  const rootWorkDir = join(fixture, "root");
  const isolatedWorkDir = join(fixture, "isolated");
  await Promise.all([
    mkdir(rootWorkDir, { recursive: true }),
    mkdir(isolatedWorkDir, { recursive: true }),
  ]);
  const rootStorage = resolvePicoPaths(rootWorkDir, { picoHome }).workspace.root;
  const isolatedStorage = resolvePicoPaths(isolatedWorkDir, { picoHome }).workspace.root;
  const session = new Session("isolated-session", isolatedWorkDir, {
    persistence: true,
    picoHome,
    runtimeStorageRoot: rootStorage,
  });
  await session.recover();
  assert.equal(session.workDir, isolatedWorkDir);
  assert.equal(
    await realpath(session.runtimeEventStore?.storageRoot ?? ""),
    await realpath(rootStorage),
  );
  await assert.rejects(() => access(isolatedStorage), /ENOENT/u);
  await session.close();
});

function seedIsolatedProvision(store: SqliteAgentGraphControlStore) {
  store.createGraph({ graphId: "graph-isolated", rootSessionId: "root", epoch: 1 });
  store.commitScheduleRevision({
    graphId: "graph-isolated",
    expectedRevision: 0,
    operationId: "add-isolated",
    requestFingerprint: "schedule-fingerprint",
    kind: "add",
    command: { kind: "add" },
    sourceSessionId: "root",
    sourceTurnId: "root-turn",
    sourceRunId: "root-run",
    sourceToolCallId: "root-tool",
  });
  const record = store.ensureOperatorProvision({
    provisionId: "provision-isolated",
    graphId: "graph-isolated",
    operatorId: "implementer",
    generation: 1,
    scheduleRevision: 1,
    provisionFingerprint: "provision-fingerprint",
    childSessionId: "child-isolated",
    profileSnapshot: createBuiltinAgentGraphOperatorProfileCatalog().resolve({
      profileId: "implement",
      rootModelRouteId: "test-model",
    }),
    workspaceBinding: { kind: "isolated-worktree", baseRef: "HEAD" },
  }).record;
  return {
    provisionId: record.provisionId,
    graphId: record.graphId,
    operatorId: record.operatorId,
    operatorGeneration: record.generation,
    childSessionId: record.childSessionId,
    state: record.state,
    version: record.version,
    profileSnapshot: record.profileSnapshot as AgentGraphProfileSnapshot,
    workspaceBinding: record.workspaceBinding as { kind: "isolated-worktree"; baseRef: string },
    createdAt: record.createdAt,
  };
}

async function git(args: readonly string[], cwd: string) {
  return execFileAsync("git", [...args], { cwd, encoding: "utf8" });
}
