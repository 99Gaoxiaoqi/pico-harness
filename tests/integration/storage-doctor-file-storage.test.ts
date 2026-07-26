import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { commitFileTransactionSync } from "../../src/storage/local-file-storage.js";
import { RuntimeEventStore } from "../../src/storage/runtime-event-store.js";
import { StorageDoctor } from "../../src/storage/storage-doctor.js";
import { WORKSPACE_RUNTIME_TRANSACTION_OPTIONS } from "../../src/storage/workspace-storage-layout.js";
import { RuntimeStore } from "../../src/tasks/runtime-store.js";

test("StorageDoctor reports a stale manifest without mutating it and rebuilds it explicitly", async (context) => {
  const fixture = await createFixture("manifest");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const store = new RuntimeEventStore({ storageRoot: paths.workspace.root });
  const manifest = await store.initializeSession({
    sessionId: "doctor-session",
    workDir: fixture.workspace,
    now: () => new Date("2026-07-25T00:00:00.000Z"),
  });
  const manifestPath = join(
    paths.workspace.root,
    "sessions",
    createHash("sha256").update(manifest.sessionId).digest("hex"),
    "manifest.json",
  );
  await writeFile(manifestPath, "{malformed\n", { mode: 0o600 });

  const doctor = new StorageDoctor({
    workDir: fixture.workspace,
    picoHome: fixture.picoHome,
  });
  const report = await doctor.scan();
  assert.equal(
    report.findings.some((finding) => finding.code === "runtime_manifest_rebuild_required"),
    true,
  );
  assert.equal(await readFile(manifestPath, "utf8"), "{malformed\n");

  const repair = await doctor.repair({ rebuildRuntimeManifests: true });
  assert.equal(repair.rebuiltRuntimeManifests, true);
  assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")).manifest, manifest);
});

test("StorageDoctor manifest rebuild refuses to truncate an incomplete canonical tail", async (context) => {
  const fixture = await createFixture("manifest-tail");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const store = new RuntimeEventStore({ storageRoot: paths.workspace.root });
  const manifest = await store.initializeSession({
    sessionId: "doctor-tail-session",
    workDir: fixture.workspace,
  });
  const logPath = join(
    paths.workspace.root,
    "sessions",
    createHash("sha256").update(manifest.sessionId).digest("hex"),
    "session.jsonl",
  );
  await appendFile(logPath, '{"type":"event-batch"');
  const damaged = await readFile(logPath);
  const doctor = new StorageDoctor({
    workDir: fixture.workspace,
    picoHome: fixture.picoHome,
  });

  await assert.rejects(
    doctor.repair({ rebuildRuntimeManifests: true }),
    /incomplete final record/u,
  );
  assert.deepEqual(await readFile(logPath), damaged);
});

test("StorageDoctor reports pending commits and ignored legacy SQLite without recovering either", async (context) => {
  const fixture = await createFixture("pending");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  await mkdir(paths.workspace.root, { recursive: true });
  assert.throws(
    () =>
      commitFileTransactionSync(
        paths.workspace.root,
        {
          replacements: [
            {
              relativePath: "control/state.json",
              content: `${JSON.stringify(emptyRuntimeState())}\n`,
            },
          ],
        },
        {
          ...WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
          transactionId: "pending-doctor-transaction",
          onStage(stage) {
            if (stage === "commit-published") throw new Error("simulated crash");
          },
        },
      ),
    /simulated crash/u,
  );
  await mkdir(paths.workspace.memory, { recursive: true });
  const legacySqlitePaths = [
    join(paths.workspace.root, "runtime.sqlite"),
    join(paths.workspace.root, "runtime.sqlite-wal"),
    join(paths.workspace.root, "runtime.sqlite-shm"),
    join(paths.workspace.memory, "memory.sqlite"),
    join(paths.workspace.memory, "memory.sqlite-wal"),
    join(paths.workspace.memory, "memory.sqlite-shm"),
  ];
  const legacySqliteContents = new Map(
    legacySqlitePaths.map((path, index) => [path, `legacy-sqlite-${index}\n`] as const),
  );
  await Promise.all(
    [...legacySqliteContents].map(([path, content]) => writeFile(path, content, { mode: 0o600 })),
  );
  const legacyRuntimeFile = join(paths.workspace.legacyRuntime, "sessions", "legacy.jsonl");
  await mkdir(join(paths.workspace.legacyRuntime, "sessions"), { recursive: true });
  await writeFile(legacyRuntimeFile, '{"legacy":true}\n', { mode: 0o600 });
  await mkdir(paths.workspace.tasks, { recursive: true });
  const legacyTaskFile = join(paths.workspace.tasks, "legacy.json");
  await writeFile(legacyTaskFile, "{}\n", { mode: 0o600 });

  const report = await new StorageDoctor({
    workDir: fixture.workspace,
    picoHome: fixture.picoHome,
  }).scan();
  assert.equal(report.healthy, false);
  assert.equal(
    report.findings.some((finding) => finding.code === "runtime_commit_pending"),
    true,
  );
  assert.equal(
    report.findings.some((finding) => finding.code === "legacy_runtime_sqlite_ignored"),
    true,
  );
  assert.equal(
    report.findings.some((finding) => finding.code === "legacy_sqlite_file_ignored"),
    true,
  );
  assert.equal(
    report.findings.some((finding) => finding.code === "legacy_task_storage_ignored"),
    true,
  );
  assert.equal(
    report.findings.some((finding) => finding.code === "legacy_runtime_json_preserved"),
    true,
  );
  for (const path of legacySqlitePaths) {
    const expectedCode = path.endsWith("runtime.sqlite")
      ? "legacy_runtime_sqlite_ignored"
      : "legacy_sqlite_file_ignored";
    assert.equal(
      report.findings.some((finding) => finding.code === expectedCode && finding.path === path),
      true,
    );
    assert.equal(await readFile(path, "utf8"), legacySqliteContents.get(path));
  }
  assert.match(
    await readFile(paths.workspace.storageCommit, "utf8"),
    /pending-doctor-transaction/u,
  );
  assert.equal(await readFile(legacyRuntimeFile, "utf8"), '{"legacy":true}\n');
  assert.equal(await readFile(legacyTaskFile, "utf8"), "{}\n");
});

test("StorageDoctor validates commit markers, runtime ledgers, and Memory state", async (context) => {
  const fixture = await createFixture("schemas");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const control = join(paths.workspace.root, "control");
  await mkdir(control, { recursive: true });
  const state = emptyRuntimeState();
  state.nextRuntimeEventSequence = 3;
  await writeFile(join(control, "state.json"), `${JSON.stringify(state)}\n`, { mode: 0o600 });
  const event = {
    schemaVersion: 1,
    type: "runtime-event",
    txId: "tx",
    sequence: 1,
    event: {
      eventId: "duplicate",
      topic: "daemon.test",
      workspacePath: fixture.workspace,
      createdAt: 1,
    },
  };
  await writeFile(
    join(control, "daemon-events.jsonl"),
    `${JSON.stringify(event)}\n${JSON.stringify({
      ...event,
      sequence: 2,
    })}\n`,
    { mode: 0o600 },
  );
  const providerCall = {
    schemaVersion: 1,
    type: "provider-call",
    txId: "tx",
    record: {
      callId: "duplicate-call",
      purpose: "main",
      provider: "test",
      model: "test",
      status: "succeeded",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      createdAt: 1,
    },
  };
  await writeFile(
    join(control, "usage-ledger.jsonl"),
    `${JSON.stringify(providerCall)}\n${JSON.stringify(providerCall)}\n`,
    { mode: 0o600 },
  );
  await mkdir(paths.workspace.memory, { recursive: true });
  await writeFile(
    paths.workspace.memoryState,
    `${JSON.stringify({
      schemaVersion: 1,
      workspaceId: paths.workspace.id,
      revision: 0,
      settings: {},
      sources: {},
      facts: {},
      proposals: {},
      mutations: [],
      jobs: {},
      idempotency: {},
    })}\n`,
    { mode: 0o600 },
  );

  const report = await new StorageDoctor({
    workDir: fixture.workspace,
    picoHome: fixture.picoHome,
  }).scan();
  assert.equal(
    report.findings.some((finding) => finding.code === "runtime_event_ledger_invalid"),
    true,
  );
  assert.equal(
    report.findings.some((finding) => finding.code === "runtime_usage_ledger_invalid"),
    true,
  );
  assert.equal(
    report.findings.some((finding) => finding.code === "memory_state_invalid"),
    true,
  );
});

test("StorageDoctor distinguishes a corrupt commit marker without applying it", async (context) => {
  const fixture = await createFixture("invalid-commit");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  await mkdir(paths.workspace.storage, { recursive: true });
  await writeFile(paths.workspace.storageCommit, "{}\n", { mode: 0o600 });

  const report = await new StorageDoctor({
    workDir: fixture.workspace,
    picoHome: fixture.picoHome,
  }).scan();
  assert.equal(
    report.findings.some((finding) => finding.code === "runtime_commit_invalid"),
    true,
  );
  assert.equal(await readFile(paths.workspace.storageCommit, "utf8"), "{}\n");
});

test("StorageDoctor accepts a control-only runtime and reports exposed data modes", async (context) => {
  const fixture = await createFixture("control-only");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  new RuntimeStore({
    workDir: fixture.workspace,
    storageRoot: paths.workspace.root,
  }).close();

  const healthy = await new StorageDoctor({
    workDir: fixture.workspace,
    picoHome: fixture.picoHome,
  }).scan();
  assert.equal(
    healthy.findings.some((finding) => finding.code === "session_replay_failed"),
    false,
  );
  assert.equal(healthy.scanned.session, 0);

  const statePath = join(paths.workspace.root, "control", "state.json");
  if (process.platform !== "win32") await chmod(statePath, 0o644);
  const exposed = await new StorageDoctor({
    workDir: fixture.workspace,
    picoHome: fixture.picoHome,
  }).scan();
  assert.equal(
    exposed.findings.some(
      (finding) => finding.code === "storage_permissions_invalid" && finding.path === statePath,
    ),
    process.platform !== "win32",
  );
  if (process.platform !== "win32") {
    assert.throws(
      () =>
        new RuntimeStore({
          workDir: fixture.workspace,
          storageRoot: paths.workspace.root,
        }),
      /regular 0600 file/u,
    );
  }
});

test("StorageDoctor limits Runtime permission scans to sessions, control, and .storage", async (context) => {
  const fixture = await createFixture("runtime-scan-boundary");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  new RuntimeStore({
    workDir: fixture.workspace,
    storageRoot: paths.workspace.root,
  }).close();
  const unrelatedRoots = [
    paths.workspace.memory,
    paths.workspace.artifacts,
    paths.workspace.evidence,
    paths.workspace.traces,
    paths.workspace.tasks,
    paths.workspace.forkStaging,
    paths.workspace.storageOperations,
  ];
  await Promise.all(unrelatedRoots.map((path) => mkdir(path, { recursive: true, mode: 0o755 })));
  if (process.platform !== "win32") {
    await Promise.all(unrelatedRoots.map((path) => chmod(path, 0o755)));
  }

  const report = await new StorageDoctor({
    workDir: fixture.workspace,
    picoHome: fixture.picoHome,
  }).scan();
  assert.equal(
    report.findings.some(
      (finding) => finding.component === "runtime" && unrelatedRoots.includes(finding.path),
    ),
    false,
  );
});

test("StorageDoctor does not create a coordinator while scanning an empty workspace", async (context) => {
  const fixture = await createFixture("empty-read-only");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  await mkdir(paths.workspace.root, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(paths.workspace.root, 0o700);

  await new StorageDoctor({
    workDir: fixture.workspace,
    picoHome: fixture.picoHome,
  }).scan();

  await assert.rejects(stat(paths.workspace.storage), { code: "ENOENT" });
});

test("StorageDoctor rejects a coordinator symlink without writing through it", async (context) => {
  if (process.platform === "win32") {
    context.skip("symbolic-link setup requires elevated privileges on Windows");
    return;
  }
  const fixture = await createFixture("coordinator-link");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const target = join(fixture.root, "coordinator-target");
  await mkdir(paths.workspace.root, { recursive: true, mode: 0o700 });
  await mkdir(target, { mode: 0o700 });
  await symlink(target, paths.workspace.storage, "dir");

  const report = await new StorageDoctor({
    workDir: fixture.workspace,
    picoHome: fixture.picoHome,
  }).scan();

  assert.equal(
    report.findings.some(
      (finding) =>
        finding.code === "storage_symlink_rejected" && finding.path === paths.workspace.storage,
    ),
    true,
  );
  assert.deepEqual(await readdir(target), []);
});

test("StorageDoctor reports an exposed workspace storage root", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX mode checks do not apply on Windows");
    return;
  }
  const fixture = await createFixture("root-mode");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  await mkdir(paths.workspace.root, { recursive: true, mode: 0o700 });
  await chmod(paths.workspace.root, 0o755);

  const report = await new StorageDoctor({
    workDir: fixture.workspace,
    picoHome: fixture.picoHome,
  }).scan();

  assert.equal(
    report.findings.some(
      (finding) =>
        finding.code === "storage_permissions_invalid" && finding.path === paths.workspace.root,
    ),
    true,
  );
});

test("StorageDoctor fails closed for a complete malformed Session JSONL record", async (context) => {
  const fixture = await createFixture("jsonl");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const store = new RuntimeEventStore({ storageRoot: paths.workspace.root });
  const manifest = await store.initializeSession({
    sessionId: "corrupt-session",
    workDir: fixture.workspace,
  });
  const logPath = join(
    paths.workspace.root,
    "sessions",
    createHash("sha256").update(manifest.sessionId).digest("hex"),
    "session.jsonl",
  );
  await appendFile(logPath, "{}\n");

  const report = await new StorageDoctor({
    workDir: fixture.workspace,
    picoHome: fixture.picoHome,
  }).scan();
  assert.equal(report.healthy, false);
  assert.equal(
    report.findings.some((finding) => finding.code === "session_replay_failed"),
    true,
  );
});

async function createFixture(label: string): Promise<{
  readonly root: string;
  readonly picoHome: string;
  readonly workspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `pico-storage-doctor-${label}-`));
  const picoHome = join(root, "pico-home");
  const workspace = join(root, "workspace");
  await Promise.all([mkdir(picoHome, { recursive: true }), mkdir(workspace, { recursive: true })]);
  return { root, picoHome, workspace };
}

function emptyRuntimeState(): {
  schemaVersion: 1;
  revision: number;
  nextRuntimeEventSequence: number;
  jobs: Record<string, never>;
  attempts: Record<string, never>;
  leases: Record<string, never>;
  cronJobs: Record<string, never>;
  cronRuns: Record<string, never>;
  daemonCommands: Record<string, never>;
  daemonRuns: Record<string, never>;
  jobCommands: Record<string, never>;
  completions: Record<string, never>;
  mergeRequests: Record<string, never>;
} {
  return {
    schemaVersion: 1,
    revision: 0,
    nextRuntimeEventSequence: 1,
    jobs: {},
    attempts: {},
    leases: {},
    cronJobs: {},
    cronRuns: {},
    daemonCommands: {},
    daemonRuns: {},
    jobCommands: {},
    completions: {},
    mergeRequests: {},
  };
}
