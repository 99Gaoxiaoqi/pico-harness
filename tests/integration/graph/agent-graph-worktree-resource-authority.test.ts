import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { createBuiltinAgentGraphOperatorProfileCatalog, GraphManagedGitTool } from "@pico/runtime";
import type { AgentGraphProfileSnapshot } from "@pico/core/agent-graph-contracts";
import { AgentGraphWorkspaceResourceAuthority } from "@pico/pico-host/agent-graph-workspace-resource-authority";
import { SqliteAgentGraphControlStore } from "@pico/storage/sqlite/agent-graph-control-store";
import { Session } from "@pico/pico-host/session";
import { resolvePicoPaths } from "@pico/pico-host";

const execFileAsync = promisify(execFile);

test("managed Graph Git commits only its registered branch without executing repository drivers", async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), "pico-graph-managed-git-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const repoRoot = join(fixture, "repo");
  const storageRoot = join(fixture, "storage");
  await git(["init", repoRoot], fixture);
  await git(["config", "user.email", "pico@example.invalid"], repoRoot);
  await git(["config", "user.name", "Pico Test"], repoRoot);
  await writeFile(join(repoRoot, "README.md"), "root\n");
  await git(["add", "README.md"], repoRoot);
  await git(["commit", "-m", "root"], repoRoot);
  const rootHead = (await git(["rev-parse", "HEAD"], repoRoot)).stdout.trim();
  const store = new SqliteAgentGraphControlStore({ storageRoot });
  context.after(() => store.close());
  const provision = seedIsolatedProvision(store);
  const authority = new AgentGraphWorkspaceResourceAuthority({ repoRoot, storageRoot, store });
  const workspace = await authority.resolve(provision);
  let active = true;
  const port = await authority.managedGitForSession(provision.childSessionId, async () => {
    if (!active) throw new Error("activation stopped");
  });
  const tool = new GraphManagedGitTool(port);
  assert.equal(tool.permissionCategory, "file_write");
  const marker = join(fixture, "driver-executed");
  const command = `touch '${marker}'`;
  const hooks = join(fixture, "hooks");
  await mkdir(hooks);
  for (const hook of ["pre-commit", "post-commit", "reference-transaction"]) {
    await writeFile(join(hooks, hook), `#!/bin/sh\n${command}\n`, { mode: 0o755 });
  }
  const included = join(fixture, "included.config");
  await writeFile(
    included,
    `[filter "hostile"]\nclean = ${command}\nprocess = ${command}\nrequired = true\n[diff "hostile"]\ncommand = ${command}\ntextconv = ${command}\n`,
  );
  await git(["config", "include.path", included], repoRoot);
  await git(["config", "core.hooksPath", hooks], repoRoot);
  await git(["config", "core.fsmonitor", command], repoRoot);
  await git(["config", "commit.gpgSign", "true"], repoRoot);
  await git(["config", "gpg.program", command], repoRoot);
  await writeFile(join(workspace.workDir, ".gitattributes"), "*.txt filter=hostile diff=hostile\n");
  await writeFile(join(workspace.workDir, "change.txt"), "scoped change\n");
  await writeFile(join(repoRoot, ".git", "info", "exclude"), "ignored-secret.txt\n");
  await writeFile(join(workspace.workDir, "ignored-secret.txt"), "must not be committed\n");
  const status = JSON.parse(await tool.execute('{"operation":"status"}'));
  assert.equal(status.head, rootHead);
  assert.match(status.branch, /^pico\/graph-/);
  assert.match(status.output, /change.txt/);
  assert.doesNotMatch(status.output, /ignored-secret/);
  const diff = await port.execute({ operation: "diff" });
  assert.match(diff.output, /scoped change/);
  const committed = await port.execute({
    operation: "commit",
    expected_head: status.head,
    message: "feat(测试): 隔离提交",
  });
  assert.notEqual(committed.head, rootHead);
  assert.equal(committed.branch, status.branch);
  assert.equal((await git(["rev-parse", "HEAD"], repoRoot)).stdout.trim(), rootHead);
  assert.equal((await git(["rev-parse", status.branch], repoRoot)).stdout.trim(), committed.head);
  assert.equal(
    (await git(["show", "-s", "--format=%an <%ae>", committed.head], repoRoot)).stdout.trim(),
    "Pico Test <pico@example.invalid>",
  );
  await assert.rejects(access(marker), /ENOENT/);
  // Disable the malicious read-side drivers before checking with ordinary Git.
  await git(["config", "--unset", "include.path"], repoRoot);
  assert.equal(
    (await git(["-c", "core.fsmonitor=false", "status", "--porcelain"], workspace.workDir)).stdout,
    "",
  );
  await assert.rejects(
    port.execute({ operation: "commit", expected_head: status.head, message: "repeat" }),
    /stale/,
  );
  await assert.rejects(
    port.execute({ operation: "commit", expected_head: committed.head, message: "empty" }),
    /no changes/,
  );
  await assert.rejects(tool.execute('{"operation":"status","cwd":"/"}'), /unexpected input/);
  active = false;
  await assert.rejects(port.execute({ operation: "status" }), /stopped/);
});

test("managed Graph Git rejects overlapping calls, identity tampering and cancellation before publication", async (context) => {
  const fixture = await mkdtemp(join(tmpdir(), "pico-graph-managed-git-fences-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  const repoRoot = join(fixture, "repo");
  const storageRoot = join(fixture, "storage");
  await git(["init", repoRoot], fixture);
  await git(["config", "user.email", "pico@example.invalid"], repoRoot);
  await git(["config", "user.name", "Pico Test"], repoRoot);
  await writeFile(join(repoRoot, "README.md"), "root\n");
  await git(["add", "."], repoRoot);
  await git(["commit", "-m", "root"], repoRoot);
  const store = new SqliteAgentGraphControlStore({ storageRoot });
  context.after(() => store.close());
  const provision = seedIsolatedProvision(store);
  const authority = new AgentGraphWorkspaceResourceAuthority({ repoRoot, storageRoot, store });
  const workspace = await authority.resolve(provision);
  let calls = 0;
  let stopAt = Infinity;
  const port = await authority.managedGitForSession(provision.childSessionId, async () => {
    if (++calls >= stopAt) throw new Error("activation stopped");
  });
  const head = (await port.execute({ operation: "status" })).head;
  await writeFile(join(workspace.workDir, "change.txt"), "change\n");
  const concurrent = await Promise.allSettled([
    port.execute({ operation: "status" }),
    port.execute({ operation: "status" }),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.match(
    String(
      (concurrent.find((result) => result.status === "rejected") as PromiseRejectedResult).reason,
    ),
    /already in progress|EEXIST/,
  );
  calls = 0;
  stopAt = 8;
  await assert.rejects(
    port.execute({ operation: "commit", expected_head: head, message: "cancelled" }),
    /stopped/,
  );
  assert.equal((await git(["rev-parse", "HEAD"], workspace.workDir)).stdout.trim(), head);
  stopAt = Infinity;
  const gitfile = join(workspace.workDir, ".git");
  const original = await readFile(gitfile, "utf8");
  await writeFile(gitfile, `gitdir: ${join(repoRoot, ".git")}\n`);
  await assert.rejects(port.execute({ operation: "status" }), /identity changed/);
  await writeFile(gitfile, original);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    port.execute(
      { operation: "commit", expected_head: head, message: "aborted" },
      controller.signal,
    ),
    /abort/i,
  );
});

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
