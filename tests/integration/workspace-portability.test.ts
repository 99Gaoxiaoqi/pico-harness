import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildWorkspacePortabilityPlanSync,
  WorkspacePortabilityPlanError,
  type WorkspacePortabilityPlanEntry,
} from "../../src/storage/workspace-portability.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { closeAllOperationalDatabasesForTest } from "../../src/storage/sqlite/sqlite-database.js";

/**
 * 票 09 验收:SQLite 纪元的 workspace 导出计划。
 * 1) pico.sqlite = protected(memory 敏感语义落到库整体),不哈希、不进导出集;
 * 2) evidence blob 目录与 traces 是 portable 集(带 sha256);
 * 3) WAL/SHM 边车、fork-staging、plugins/hooks 态、恢复 intent 是 host_bound;
 * 4) 旧 JSONL 纪元条目按 legacy 归类;未知条目仍 fail-closed。
 */

interface Fixture {
  readonly root: string;
  readonly storageRoot: string;
}

function createFixture(prefix: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  return { root, storageRoot: join(root, "storage") };
}

function cleanupFixture(fixture: Fixture): void {
  closeAllOperationalDatabasesForTest();
  rmSync(fixture.root, { recursive: true, force: true });
}

function writeWorkspaceSurfaces(fixture: Fixture): void {
  mkdirSync(join(fixture.storageRoot, "evidence", "blobs", "sha256", "ab"), {
    recursive: true,
  });
  writeFileSync(
    join(fixture.storageRoot, "evidence", "blobs", "sha256", "ab", "a".repeat(64)),
    "evidence blob body",
  );
  mkdirSync(join(fixture.storageRoot, "traces"), { recursive: true });
  writeFileSync(join(fixture.storageRoot, "traces", "run.jsonl"), "trace body");
  mkdirSync(join(fixture.storageRoot, "fork-staging"), { recursive: true });
  writeFileSync(join(fixture.storageRoot, "fork-staging", "bundle.json"), "{}");
  mkdirSync(join(fixture.storageRoot, "agent-recovery-launch-intents"), { recursive: true });
  writeFileSync(
    join(fixture.storageRoot, "agent-recovery-launch-intents", "intent.json"),
    "{}",
  );
  writeFileSync(join(fixture.storageRoot, "plugins.json"), "{}");
  writeFileSync(join(fixture.storageRoot, "hooks-state.json"), "{}");
  writeFileSync(join(fixture.storageRoot, "tui-debug.log"), "debug");
}

function entryByPath(
  entries: readonly WorkspacePortabilityPlanEntry[],
  relativePath: string,
): WorkspacePortabilityPlanEntry {
  const entry = entries.find((candidate) => candidate.relativePath === relativePath);
  assert.ok(entry, `missing plan entry: ${relativePath}`);
  return entry;
}

test("pico.sqlite 归 protected,blob 目录与 traces 构成 portable 集", () => {
  const fixture = createFixture("pico-portability-sqlite-");
  try {
    // 初始化 sqlite 纪元存储(建库 + binding),随后关闭句柄。
    const store = new SqliteRuntimeEventStore({ storageRoot: fixture.storageRoot });
    store.close();
    writeWorkspaceSurfaces(fixture);
    const plan = buildWorkspacePortabilityPlanSync(fixture.storageRoot);

    const database = entryByPath(plan.entries, "pico.sqlite");
    assert.equal(database.classification, "protected");
    assert.equal(database.reason, "workspace_database_with_memory");
    assert.equal(database.sha256, null, "protected 条目不得持久化指纹");

    const evidence = entryByPath(
      plan.entries,
      `evidence/blobs/sha256/ab/${"a".repeat(64)}`,
    );
    assert.equal(evidence.classification, "portable");
    assert.equal(evidence.reason, "portable_evidence");
    assert.match(evidence.sha256 ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(evidence.size, "evidence blob body".length);

    const trace = entryByPath(plan.entries, "traces/run.jsonl");
    assert.equal(trace.classification, "portable");
    assert.equal(trace.reason, "portable_trace");
    assert.match(trace.sha256 ?? "", /^[a-f0-9]{64}$/u);

    const staging = entryByPath(plan.entries, "fork-staging/bundle.json");
    assert.equal(staging.classification, "host_bound");
    assert.equal(staging.reason, "ephemeral_fork_state");
    assert.equal(staging.sha256, null);

    const intents = entryByPath(plan.entries, "agent-recovery-launch-intents/intent.json");
    assert.equal(intents.classification, "host_bound");
    assert.equal(intents.reason, "agent_recovery_intent_state");

    for (const [name, reason] of [
      ["plugins.json", "workspace_plugin_state"],
      ["hooks-state.json", "workspace_hook_state"],
    ] as const) {
      const entry = entryByPath(plan.entries, name);
      assert.equal(entry.classification, "host_bound");
      assert.equal(entry.reason, reason);
    }
    const debugLog = entryByPath(plan.entries, "tui-debug.log");
    assert.equal(debugLog.classification, "protected");
    assert.equal(debugLog.reason, "debug_log_may_contain_sensitive_data");

    assert.equal(plan.schemaVersion, 2);
    assert.equal(plan.portableFileCount, 2);
    assert.equal(
      plan.portableBytes,
      "evidence blob body".length + "trace body".length,
    );
    assert.equal(plan.excludedFileCount, plan.entries.length - 2);
  } finally {
    cleanupFixture(fixture);
  }
});

test("WAL/SHM 边车按 database_or_journal_file 保护,legacy 条目按 legacy 归类", () => {
  const fixture = createFixture("pico-portability-legacy-");
  try {
    const store = new SqliteRuntimeEventStore({ storageRoot: fixture.storageRoot });
    store.close();
    writeFileSync(join(fixture.storageRoot, "pico.sqlite-wal"), "wal");
    writeFileSync(join(fixture.storageRoot, "pico.sqlite-shm"), "shm");
    mkdirSync(join(fixture.storageRoot, "sessions", "digest"), { recursive: true });
    writeFileSync(join(fixture.storageRoot, "sessions", "digest", "session.jsonl"), "[]");
    writeFileSync(join(fixture.storageRoot, "todo.json"), "{}");
    const plan = buildWorkspacePortabilityPlanSync(fixture.storageRoot);

    for (const name of ["pico.sqlite-wal", "pico.sqlite-shm"]) {
      const entry = entryByPath(plan.entries, name);
      assert.equal(entry.classification, "protected");
      assert.equal(entry.reason, "database_or_journal_file");
      assert.equal(entry.sha256, null);
    }
    const legacySession = entryByPath(plan.entries, "sessions/digest/session.jsonl");
    assert.equal(legacySession.classification, "host_bound");
    assert.equal(legacySession.reason, "legacy_runtime_history");
    const legacyTodo = entryByPath(plan.entries, "todo.json");
    assert.equal(legacyTodo.classification, "host_bound");
    assert.equal(legacyTodo.reason, "legacy_workspace_todo_state");
  } finally {
    cleanupFixture(fixture);
  }
});

test("缺少 pico.sqlite binding 与未知顶层条目均 fail-closed", () => {
  const unbound = createFixture("pico-portability-unbound-");
  try {
    mkdirSync(unbound.storageRoot, { recursive: true });
    assert.throws(
      () => buildWorkspacePortabilityPlanSync(unbound.storageRoot),
      (error: unknown) =>
        error instanceof WorkspacePortabilityPlanError &&
        error.code === "invalid_storage_root",
    );
  } finally {
    cleanupFixture(unbound);
  }

  const unknown = createFixture("pico-portability-unknown-");
  try {
    const store = new SqliteRuntimeEventStore({ storageRoot: unknown.storageRoot });
    store.close();
    mkdirSync(join(unknown.storageRoot, "brand-new-surface"), { recursive: true });
    assert.throws(
      () => buildWorkspacePortabilityPlanSync(unknown.storageRoot),
      (error: unknown) =>
        error instanceof WorkspacePortabilityPlanError &&
        error.code === "unknown_top_level_entry" &&
        error.relativePath === "brand-new-surface",
    );
  } finally {
    cleanupFixture(unknown);
  }
});
