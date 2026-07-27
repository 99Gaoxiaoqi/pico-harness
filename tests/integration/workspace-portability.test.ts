import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  buildWorkspacePortabilityPlanSync,
  WorkspacePortabilityPlanError,
} from "../../src/storage/workspace-portability.js";

test("workspace portability builds a deterministic allowlisted export plan", async (t) => {
  const fixture = await createFixture("pico-portability-plan-");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const portableFiles = new Map([
    ["sessions/aaa/session.jsonl", '{"type":"session"}\n'],
    ["task-runs/bbb/task.jsonl", '{"type":"task-run"}\n'],
    ["artifacts/report.md", "# report\n"],
    ["evidence/tool.json", '{"ok":true}\n'],
    ["traces/run.jsonl", '{"event":"finish"}\n'],
    ["memory/summaries/session.json", '{"summary":"done"}\n'],
  ]);
  const excludedFiles = new Map([
    [".storage/layout.json", '{"schemaVersion":2}\n'],
    ["control/state.json", '{"jobs":[]}\n'],
    ["runtime/lock/owner.json", '{"ownerId":"old"}\n'],
    ["tasks/legacy.json", '{"legacy":true}\n'],
    ["fork-staging/run/draft.json", '{"draft":true}\n'],
    ["storage-operations/op.json", '{"state":"pending"}\n'],
    ["memory/state.json", '{"fact":"local private text"}\n'],
    ["memory/commit.json", '{"transactionId":"tx"}\n'],
    ["todo.json", '{"items":[]}\n'],
    ["plugins.json", '{"plugins":[]}\n'],
    ["hooks-state.json", '{"hooks":[]}\n'],
    ["tui-debug.log", "private prompt\n"],
    ["artifacts/.env", "API_KEY=secret\n"],
    ["artifacts/runtime.sqlite", "not exported\n"],
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
  assert.equal(first.excludedFileCount, excludedFiles.size);
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
  assert.deepEqual(pickEntry(byPath, "artifacts/.env"), {
    classification: "protected",
    reason: "credential_or_secret_material",
    sha256: null,
  });
  assert.deepEqual(pickEntry(byPath, "artifacts/runtime.sqlite"), {
    classification: "protected",
    reason: "database_or_journal_file",
    sha256: null,
  });
  assert.deepEqual(pickEntry(byPath, ".storage/layout.json"), {
    classification: "host_bound",
    reason: "workspace_transaction_state",
    sha256: null,
  });
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

test("workspace portability rejects symbolic links instead of following path escapes", async (t) => {
  const fixture = await createFixture("pico-portability-symlink-");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const outside = join(fixture.root, "outside.txt");
  await writeFile(outside, "outside\n", { mode: 0o600 });
  await mkdir(join(fixture.storageRoot, "artifacts"), { mode: 0o700 });
  await symlink(outside, join(fixture.storageRoot, "artifacts", "escape"));

  assert.throws(
    () => buildWorkspacePortabilityPlanSync(fixture.storageRoot),
    (error: unknown) =>
      error instanceof WorkspacePortabilityPlanError &&
      error.code === "symbolic_link" &&
      error.relativePath === "artifacts/escape",
  );
});

test(
  "workspace portability rejects special files",
  { skip: process.platform === "win32" },
  async (t) => {
    const fixture = await createFixture("pico-portability-special-");
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const artifacts = join(fixture.storageRoot, "artifacts");
    const fifo = join(artifacts, "stream");
    await mkdir(artifacts, { mode: 0o700 });
    const result = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);

    assert.throws(
      () => buildWorkspacePortabilityPlanSync(fixture.storageRoot),
      (error: unknown) =>
        error instanceof WorkspacePortabilityPlanError &&
        error.code === "special_file" &&
        error.relativePath === "artifacts/stream",
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
  return { root, storageRoot };
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
):
  | "canonical_runtime_history"
  | "durable_task_history"
  | "portable_artifact"
  | "portable_evidence"
  | "portable_trace"
  | "portable_memory_summary" {
  if (relativePath.startsWith("sessions/")) return "canonical_runtime_history";
  if (relativePath.startsWith("task-runs/")) return "durable_task_history";
  if (relativePath.startsWith("artifacts/")) return "portable_artifact";
  if (relativePath.startsWith("evidence/")) return "portable_evidence";
  if (relativePath.startsWith("traces/")) return "portable_trace";
  return "portable_memory_summary";
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
