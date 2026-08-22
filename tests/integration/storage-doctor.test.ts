import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePicoPaths, workspaceIdForPath } from "../../src/paths/pico-paths.js";
import { StorageDoctor, type StorageDoctorFinding } from "../../src/storage/storage-doctor.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { SqliteMemoryRepository } from "../../src/storage/sqlite/sqlite-memory-repository.js";
import {
  closeAllOperationalDatabasesForTest,
  operationalDatabasePath,
} from "../../src/storage/sqlite/sqlite-database.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeEvent,
} from "../../src/engine/session-runtime-event.js";
import { createRuntimeEventId } from "../../src/storage/runtime-event-store-contracts.js";

/**
 * 票 09 验收:SQLite 纪元的 StorageDoctor。
 * 1) 干净扫描:pico.sqlite 纪元 workspace 无 finding;
 * 2) 空 workspace(库不存在)不初始化新库且健康;
 * 3) JSONL 纪元残留按 legacy 报告(不 fail、不迁移);
 * 4) 会话跨 workspace / memory 绑定错位 fail-closed。
 */

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly picoHome: string;
  readonly storageRoot: string;
}

function createFixture(prefix: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(picoHome, { recursive: true });
  const paths = resolvePicoPaths(workspace, { picoHome });
  return { root, workspace, picoHome, storageRoot: paths.workspace.root };
}

function cleanupFixture(fixture: Fixture): void {
  closeAllOperationalDatabasesForTest();
  rmSync(fixture.root, { recursive: true, force: true });
}

function userMessage(sessionId: string, content: string): RuntimeEvent {
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: createRuntimeEventId("doctor"),
    sessionId,
    invocationId: "inv-1",
    runId: "run-1",
    turnId: "turn-1",
    at: new Date().toISOString(),
    partial: false,
    visibility: "model",
    kind: "message.committed",
    data: { message: { role: "user", content } },
  };
}

test("doctor 扫描 SQLite 纪元 workspace 干净", async () => {
  const fixture = createFixture("pico-doctor-sqlite-clean-");
  try {
    const store = new SqliteRuntimeEventStore({ storageRoot: fixture.storageRoot });
    try {
      await store.initializeSession({
        sessionId: "doctor-clean-session",
        workDir: fixture.workspace,
      });
      await store.append(userMessage("doctor-clean-session", "hello"));
    } finally {
      store.close();
    }
    const report = await new StorageDoctor({
      workDir: fixture.workspace,
      picoHome: fixture.picoHome,
    }).scan();
    assert.deepEqual(
      report.findings,
      [],
      report.findings.map((finding) => finding.message).join("; "),
    );
    assert.equal(report.healthy, true);
    assert.equal(report.scanned.runtime, 1);
    assert.equal(report.scanned.session, 1);
    assert.equal(report.scanned.memory, 0);
  } finally {
    cleanupFixture(fixture);
  }
});

test("doctor 对空 workspace 不初始化新库且报告健康", async () => {
  const fixture = createFixture("pico-doctor-sqlite-empty-");
  try {
    const report = await new StorageDoctor({
      workDir: fixture.workspace,
      picoHome: fixture.picoHome,
    }).scan();
    assert.equal(existsSync(operationalDatabasePath(fixture.storageRoot)), false);
    assert.equal(report.healthy, true);
    assert.equal(report.scanned.runtime, 0);
    assert.equal(report.scanned.session, 0);
  } finally {
    cleanupFixture(fixture);
  }
});

test("doctor 把 JSONL 纪元残留报告为 legacy 而不阻塞扫描", async () => {
  const fixture = createFixture("pico-doctor-sqlite-legacy-");
  try {
    const store = new SqliteRuntimeEventStore({ storageRoot: fixture.storageRoot });
    try {
      await store.initializeSession({
        sessionId: "doctor-legacy-session",
        workDir: fixture.workspace,
      });
    } finally {
      store.close();
    }
    mkdirSync(join(fixture.storageRoot, ".storage"), { recursive: true });
    writeFileSync(join(fixture.storageRoot, ".storage", "layout.json"), "{}\n");
    mkdirSync(join(fixture.storageRoot, "sessions"), { recursive: true });
    writeFileSync(join(fixture.storageRoot, "todo.json"), "{}\n");
    const report = await new StorageDoctor({
      workDir: fixture.workspace,
      picoHome: fixture.picoHome,
    }).scan();
    const legacyFindings = report.findings.filter(
      (finding) => finding.code === "legacy_session_centric_storage_present",
    );
    assert.deepEqual(
      legacyFindings.map((finding) => finding.path),
      [
        join(fixture.storageRoot, ".storage"),
        join(fixture.storageRoot, "sessions"),
        join(fixture.storageRoot, "todo.json"),
      ].sort(),
    );
    // legacy 残留是 warning;混合状态下 store 构造器拒开,scope 行扫描跳过
    // (scanned.session=0),库级 PRAGMA 检查照常完成(runtime=1)。
    assert.equal(
      report.findings.some(
        (finding: StorageDoctorFinding) =>
          finding.severity === "error" || finding.severity === "critical",
      ),
      false,
    );
    assert.equal(report.scanned.session, 0);
    assert.equal(report.scanned.runtime, 1);
  } finally {
    cleanupFixture(fixture);
  }
});

test("doctor 对跨 workspace 会话与 memory 绑定错位 fail-closed", async () => {
  const fixture = createFixture("pico-doctor-sqlite-mismatch-");
  try {
    const store = new SqliteRuntimeEventStore({ storageRoot: fixture.storageRoot });
    try {
      // 会话属于另一个 workspace(同一存储根):投影可重放,但归属校验失败。
      await store.initializeSession({
        sessionId: "doctor-foreign-session",
        workDir: join(fixture.root, "another-workspace"),
      });
    } finally {
      store.close();
    }
    const foreignWorkspace = join(fixture.root, "memory-owner-workspace");
    mkdirSync(foreignWorkspace, { recursive: true });
    const repository = new SqliteMemoryRepository({
      storageRoot: fixture.storageRoot,
      workspaceId: workspaceIdForPath(foreignWorkspace),
    });
    repository.close();
    const report = await new StorageDoctor({
      workDir: fixture.workspace,
      picoHome: fixture.picoHome,
    }).scan();
    assert.equal(report.healthy, false);
    assert.ok(
      report.findings.some(
        (finding) => finding.code === "session_replay_failed" && finding.severity === "critical",
      ),
      report.findings.map((finding) => finding.code).join(","),
    );
    assert.ok(
      report.findings.some((finding) => finding.code === "memory_workspace_mismatch"),
      report.findings.map((finding) => finding.code).join(","),
    );
  } finally {
    cleanupFixture(fixture);
  }
});
