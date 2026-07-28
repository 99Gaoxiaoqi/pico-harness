import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  commitFileTransactionSync,
  withFileLockSync,
} from "../../src/storage/local-file-storage.js";
import {
  buildWorkspacePortabilityPlanSync,
  WorkspacePortabilityPlanError,
} from "../../src/storage/workspace-portability.js";
import {
  prepareWorkspaceStorageLayoutSync,
  WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
  WORKSPACE_STORAGE_COMMIT_FILE,
  WORKSPACE_STORAGE_LOCK_DIRECTORY,
} from "../../src/storage/workspace-storage-layout.js";

test("workspace portability builds a deterministic allowlisted export plan", async (t) => {
  const fixture = await createFixture("pico-portability-plan-");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const sessionDigest = "a".repeat(64);
  const taskRunDigest = "b".repeat(64);
  const layoutMarker = await readFile(join(fixture.storageRoot, ".storage", "layout.json"), "utf8");
  const legacyFenceOwner = await readFile(
    join(fixture.storageRoot, "runtime", "lock", "owner.json"),
    "utf8",
  );

  const portableFiles = new Map([
    [`sessions/${sessionDigest}/session.jsonl`, '{"type":"session"}\n'],
    [`sessions/${sessionDigest}/manifest.json`, '{"sessionId":"session-1"}\n'],
    [`task-runs/${taskRunDigest}/task.jsonl`, '{"type":"task-run"}\n'],
    [`task-runs/${taskRunDigest}/manifest.json`, '{"taskRunId":"task-1"}\n'],
    ["evidence/tool.json", '{"ok":true}\n'],
    ["traces/run.jsonl", '{"event":"finish"}\n'],
  ]);
  const excludedFiles = new Map([
    [".storage/layout.json", layoutMarker],
    ["control/state.json", '{"jobs":[]}\n'],
    ["runtime/lock/owner.json", legacyFenceOwner],
    ["tasks/legacy.json", '{"legacy":true}\n'],
    ["fork-staging/run/draft.json", '{"draft":true}\n'],
    ["storage-operations/op.json", '{"state":"pending"}\n'],
    ["memory/state.json", '{"fact":"local private text"}\n'],
    ["memory/commit.json", '{"transactionId":"tx"}\n'],
    ["todo.json", '{"items":[]}\n'],
    ["plugins.json", '{"plugins":[]}\n'],
    ["hooks-state.json", '{"hooks":[]}\n'],
    ["tui-debug.log", "private prompt\n"],
    ["evidence/.env", "API_KEY=secret\n"],
    ["evidence/runtime.sqlite", "not exported\n"],
    ["evidence/evidence.sqlite-journal", "rollback journal\n"],
    ["traces/trace.db-journal", "rollback journal\n"],
    ["traces/run.sqlite-wal", "not exported either\n"],
  ]);
  for (const [relativePath, content] of [...portableFiles, ...excludedFiles]) {
    await writeFixtureFile(fixture.storageRoot, relativePath, content);
  }

  const first = buildWorkspacePortabilityPlanSync(fixture.storageRoot);
  const second = buildWorkspacePortabilityPlanSync(fixture.storageRoot);
  assert.deepEqual(second, first);
  assert.deepEqual(
    first.entries.map((entry) => entry.relativePath),
    first.entries.map((entry) => entry.relativePath).toSorted(),
  );
  assert.equal(first.portableFileCount, portableFiles.size);
  assert.equal(first.excludedFileCount, excludedFiles.size + 1);
  assert.equal(
    first.portableBytes,
    [...portableFiles.values()].reduce((total, content) => total + Buffer.byteLength(content), 0),
  );

  const byPath = new Map(first.entries.map((entry) => [entry.relativePath, entry]));
  for (const [relativePath, content] of portableFiles) {
    assert.deepEqual(byPath.get(relativePath), {
      relativePath,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      classification: "portable",
      reason: expectedPortableReason(relativePath),
    });
  }
  for (const relativePath of excludedFiles.keys()) {
    assert.equal(byPath.get(relativePath)?.sha256, null);
    assert.notEqual(byPath.get(relativePath)?.classification, "portable");
  }
  assert.deepEqual(pickEntry(byPath, "memory/state.json"), {
    classification: "protected",
    reason: "memory_state_may_contain_sensitive_data",
    sha256: null,
  });
  assert.deepEqual(pickEntry(byPath, "evidence/.env"), {
    classification: "protected",
    reason: "credential_or_secret_material",
    sha256: null,
  });
  assert.deepEqual(pickEntry(byPath, "evidence/runtime.sqlite"), {
    classification: "protected",
    reason: "database_or_journal_file",
    sha256: null,
  });
  for (const relativePath of ["evidence/evidence.sqlite-journal", "traces/trace.db-journal"]) {
    assert.deepEqual(pickEntry(byPath, relativePath), {
      classification: "protected",
      reason: "database_or_journal_file",
      sha256: null,
    });
  }
  assert.deepEqual(pickEntry(byPath, ".storage/layout.json"), {
    classification: "host_bound",
    reason: "workspace_transaction_state",
    sha256: null,
  });
  assert.deepEqual(pickEntry(byPath, ".storage/lock/owner.json"), {
    classification: "host_bound",
    reason: "lock_or_commit_state",
    sha256: null,
  });
});

test("workspace portability recovers one pending cross-Session transaction before hashing", async (t) => {
  const fixture = await createFixture("pico-portability-recovery-");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const leftDigest = "a".repeat(64);
  const rightDigest = "b".repeat(64);
  const leftPath = `sessions/${leftDigest}/session.jsonl`;
  const rightPath = `sessions/${rightDigest}/session.jsonl`;
  const leftHeader = '{"type":"session","sessionId":"left"}\n';
  const rightHeader = '{"type":"session","sessionId":"right"}\n';
  const leftBatch = '{"type":"event-batch","txId":"cross-session"}\n';
  const rightBatch = '{"type":"event-batch","txId":"cross-session"}\n';
  await writeFixtureFile(fixture.storageRoot, leftPath, leftHeader);
  await writeFixtureFile(fixture.storageRoot, rightPath, rightHeader);

  assert.throws(
    () =>
      withFileLockSync(
        join(fixture.storageRoot, WORKSPACE_STORAGE_LOCK_DIRECTORY),
        "workspace-portability-pending-transaction",
        () =>
          commitFileTransactionSync(
            fixture.storageRoot,
            {
              appends: [
                { relativePath: leftPath, content: leftBatch },
                { relativePath: rightPath, content: rightBatch },
              ],
            },
            {
              ...WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
              transactionId: "cross-session",
              onStage(stage) {
                if (stage === "commit-published") {
                  throw new Error("simulated cross-Session writer crash");
                }
              },
            },
          ),
      ),
    /simulated cross-Session writer crash/u,
  );

  await stat(join(fixture.storageRoot, WORKSPACE_STORAGE_COMMIT_FILE));
  const plan = buildWorkspacePortabilityPlanSync(fixture.storageRoot);
  const entries = new Map(plan.entries.map((entry) => [entry.relativePath, entry]));
  for (const [relativePath, content] of [
    [leftPath, leftHeader + leftBatch],
    [rightPath, rightHeader + rightBatch],
  ] as const) {
    assert.deepEqual(entries.get(relativePath), {
      relativePath,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      classification: "portable",
      reason: "canonical_runtime_history",
    });
  }
  assert.equal(entries.has(WORKSPACE_STORAGE_COMMIT_FILE), false);
  await assert.rejects(stat(join(fixture.storageRoot, WORKSPACE_STORAGE_COMMIT_FILE)), {
    code: "ENOENT",
  });
});

test("workspace portability waits for the shared writer lock before scanning", async (t) => {
  const fixture = await createFixture("pico-portability-lock-");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const evidencePath = join(fixture.storageRoot, "evidence", "concurrent.txt");
  await writeFixtureFile(fixture.storageRoot, "evidence/concurrent.txt", "before writer\n");
  const childScript = `
    import { writeFileSync } from "node:fs";
    import { withFileLockSync } from "./src/storage/local-file-storage.ts";
    withFileLockSync(process.env.TEST_LOCK_PATH, "portability-concurrent-writer", () => {
      console.log("locked");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      writeFileSync(process.env.TEST_EVIDENCE_PATH, "after writer\\n", { mode: 0o600 });
    });
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", childScript],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_EVIDENCE_PATH: evidencePath,
        TEST_LOCK_PATH: join(fixture.storageRoot, WORKSPACE_STORAGE_LOCK_DIRECTORY),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  let childStderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    childStderr += chunk;
  });
  const childExit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  await waitForOutput(child, "locked");

  const plan = buildWorkspacePortabilityPlanSync(fixture.storageRoot);
  const exitCode = await childExit;
  assert.equal(exitCode, 0, childStderr);
  const content = "after writer\n";
  assert.deepEqual(
    plan.entries.find((entry) => entry.relativePath === "evidence/concurrent.txt"),
    {
      relativePath: "evidence/concurrent.txt",
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      classification: "portable",
      reason: "portable_evidence",
    },
  );
});

test("workspace portability fails closed for unknown storage surfaces", async (t) => {
  const fixture = await createFixture("pico-portability-unknown-");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFixtureFile(fixture.storageRoot, "new-store/state.json", "{}\n");

  assert.throws(
    () => buildWorkspacePortabilityPlanSync(fixture.storageRoot),
    (error: unknown) =>
      error instanceof WorkspacePortabilityPlanError &&
      error.code === "unknown_top_level_entry" &&
      error.relativePath === "new-store",
  );

  await rm(join(fixture.storageRoot, "new-store"), { recursive: true, force: true });
  await writeFixtureFile(fixture.storageRoot, "artifacts/legacy.txt", "obsolete\n");
  assert.throws(
    () => buildWorkspacePortabilityPlanSync(fixture.storageRoot),
    (error: unknown) =>
      error instanceof WorkspacePortabilityPlanError &&
      error.code === "unknown_top_level_entry" &&
      error.relativePath === "artifacts",
  );

  await rm(join(fixture.storageRoot, "artifacts"), { recursive: true, force: true });
  await writeFixtureFile(fixture.storageRoot, "memory/unreviewed.json", "{}\n");
  assert.throws(
    () => buildWorkspacePortabilityPlanSync(fixture.storageRoot),
    (error: unknown) =>
      error instanceof WorkspacePortabilityPlanError &&
      error.code === "unknown_memory_entry" &&
      error.relativePath === "memory/unreviewed.json",
  );

  await rm(join(fixture.storageRoot, "memory"), { recursive: true, force: true });
  await writeFixtureFile(fixture.storageRoot, "sessions", "not a directory\n");
  assert.throws(
    () => buildWorkspacePortabilityPlanSync(fixture.storageRoot),
    (error: unknown) =>
      error instanceof WorkspacePortabilityPlanError &&
      error.code === "special_file" &&
      error.relativePath === "sessions",
  );
});

test("workspace portability rejects unknown Session and TaskRun ledger descendants", async (t) => {
  const fixture = await createFixture("pico-portability-ledger-shape-");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const sessionDigest = "a".repeat(64);
  await writeFixtureFile(
    fixture.storageRoot,
    `sessions/${sessionDigest}/session.jsonl`,
    '{"type":"session"}\n',
  );
  await writeFixtureFile(
    fixture.storageRoot,
    `sessions/${sessionDigest}/private-notes.txt`,
    "must not export\n",
  );

  assert.throws(
    () => buildWorkspacePortabilityPlanSync(fixture.storageRoot),
    (error: unknown) =>
      error instanceof WorkspacePortabilityPlanError &&
      error.code === "invalid_ledger_entry" &&
      error.relativePath === `sessions/${sessionDigest}/private-notes.txt`,
  );

  await rm(join(fixture.storageRoot, "sessions"), { recursive: true, force: true });
  await writeFixtureFile(
    fixture.storageRoot,
    "task-runs/not-a-sha256/task.jsonl",
    '{"type":"task-run"}\n',
  );
  assert.throws(
    () => buildWorkspacePortabilityPlanSync(fixture.storageRoot),
    (error: unknown) =>
      error instanceof WorkspacePortabilityPlanError &&
      error.code === "invalid_ledger_entry" &&
      error.relativePath === "task-runs/not-a-sha256",
  );
});

test("workspace portability rejects symbolic links instead of following path escapes", async (t) => {
  const fixture = await createFixture("pico-portability-symlink-");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const outside = join(fixture.root, "outside.txt");
  await writeFile(outside, "outside\n", { mode: 0o600 });
  await mkdir(join(fixture.storageRoot, "evidence"), { mode: 0o700 });
  await symlink(outside, join(fixture.storageRoot, "evidence", "escape"));

  assert.throws(
    () => buildWorkspacePortabilityPlanSync(fixture.storageRoot),
    (error: unknown) =>
      error instanceof WorkspacePortabilityPlanError &&
      error.code === "symbolic_link" &&
      error.relativePath === "evidence/escape",
  );
});

test(
  "workspace portability rejects special files",
  { skip: process.platform === "win32" },
  async (t) => {
    const fixture = await createFixture("pico-portability-special-");
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const evidence = join(fixture.storageRoot, "evidence");
    const fifo = join(evidence, "stream");
    await mkdir(evidence, { mode: 0o700 });
    const result = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);

    assert.throws(
      () => buildWorkspacePortabilityPlanSync(fixture.storageRoot),
      (error: unknown) =>
        error instanceof WorkspacePortabilityPlanError &&
        error.code === "special_file" &&
        error.relativePath === "evidence/stream",
    );
  },
);

async function createFixture(prefix: string): Promise<{
  readonly root: string;
  readonly storageRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const storageRoot = join(root, "workspace");
  await mkdir(storageRoot, { mode: 0o700 });
  prepareWorkspaceStorageLayoutSync(storageRoot);
  return { root, storageRoot };
}

async function waitForOutput(child: ReturnType<typeof spawn>, expected: string): Promise<void> {
  const stdout = child.stdout;
  if (!stdout) throw new Error("Child stdout pipe is unavailable");
  stdout.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for child output: ${expected}`)),
      5_000,
    );
    stdout.on("data", (chunk: string) => {
      output += chunk;
      if (!output.includes(expected)) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (output.includes(expected)) return;
      clearTimeout(timeout);
      reject(new Error(`Child exited with code ${String(code)} before output: ${expected}`));
    });
  });
}

async function writeFixtureFile(
  storageRoot: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const path = join(storageRoot, relativePath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
}

function expectedPortableReason(
  relativePath: string,
): "canonical_runtime_history" | "durable_task_history" | "portable_evidence" | "portable_trace" {
  if (relativePath.startsWith("sessions/")) return "canonical_runtime_history";
  if (relativePath.startsWith("task-runs/")) return "durable_task_history";
  if (relativePath.startsWith("evidence/")) return "portable_evidence";
  return "portable_trace";
}

function pickEntry(
  entries: ReadonlyMap<
    string,
    {
      readonly classification: string;
      readonly reason: string;
      readonly sha256: string | null;
    }
  >,
  relativePath: string,
): {
  readonly classification: string | undefined;
  readonly reason: string | undefined;
  readonly sha256: string | null | undefined;
} {
  const entry = entries.get(relativePath);
  return {
    classification: entry?.classification,
    reason: entry?.reason,
    sha256: entry?.sha256,
  };
}
