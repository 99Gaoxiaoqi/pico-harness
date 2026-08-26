import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { RuntimeEvent } from "../../src/engine/session-runtime-event.js";
import {
  RuntimeEventStoreIntegrityError,
  RuntimeEventStoreOwnerFenceError,
  RuntimeEventStoreRunSealedError,
  RuntimeEventStoreVersionConflictError,
  type RuntimeOwnerFence,
} from "../../src/storage/runtime-event-store-contracts.js";
import { operationalDatabasePath } from "../../src/storage/sqlite/sqlite-database.js";
import { SESSIONS_SCOPE } from "../../src/storage/sqlite/sessions-scope.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { prepareWorkspaceSqliteStorageSync } from "../../src/storage/sqlite/sqlite-workspace-storage.js";

interface Fixture {
  readonly root: string;
  readonly storage: string;
  readonly workspace: string;
  readonly store: SqliteRuntimeEventStore;
}

function fixture(prefix: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const storage = join(root, "storage");
  return { root, storage, workspace, store: new SqliteRuntimeEventStore({ storageRoot: storage }) };
}

function cleanup(value: Fixture): void {
  value.store.close();
  rmSync(value.root, { recursive: true, force: true });
}

async function initializeAndFence(value: Fixture, sessionId: string): Promise<RuntimeOwnerFence> {
  await value.store.initializeSession({ sessionId, workDir: value.workspace });
  return value.store.advanceOwnerFence(sessionId, 0);
}

function eventBase(eventId: string, sessionId: string, runId = "run-1") {
  return {
    schemaVersion: 2 as const,
    eventId,
    sessionId,
    invocationId: "inv-1",
    runId,
    turnId: "turn-1",
    at: `2026-08-22T00:00:${eventId.slice(-2).padStart(2, "0")}.000Z`,
    partial: false,
    visibility: "internal" as const,
  };
}

function started(eventId: string, sessionId: string, workDir: string): RuntimeEvent {
  return {
    ...eventBase(eventId, sessionId),
    kind: "run.started",
    data: { workDir },
  };
}

function message(eventId: string, sessionId: string, content: string): RuntimeEvent {
  return {
    ...eventBase(eventId, sessionId),
    visibility: "model",
    kind: "message.committed",
    data: { message: { role: "user", content } },
  };
}

function terminal(
  eventId: string,
  sessionId: string,
): Extract<RuntimeEvent, { kind: "run.terminal" }> {
  return {
    ...eventBase(eventId, sessionId),
    kind: "run.terminal",
    data: { status: "completed" },
  };
}

function toolStarted(
  eventId: string,
  sessionId: string,
  toolCallId: string,
): Extract<RuntimeEvent, { kind: "tool.started" }> {
  return {
    ...eventBase(eventId, sessionId),
    refs: { toolCallId, providerCallId: "provider-1" },
    kind: "tool.started",
    data: { toolName: "read", argumentsHash: "args-hash" },
  };
}

function toolResult(
  eventId: string,
  sessionId: string,
  toolCallId: string,
  content = "ok",
): Extract<RuntimeEvent, { kind: "tool.result.recorded" }> {
  const sha256 = createHash("sha256").update(content).digest("hex");
  return {
    ...eventBase(eventId, sessionId),
    visibility: "model",
    refs: { toolCallId },
    kind: "tool.result.recorded",
    data: {
      toolName: "read",
      status: "succeeded",
      body: { storage: "inline", content, sha256, sizeBytes: Buffer.byteLength(content) },
      projection: {
        version: 1,
        mode: "full",
        text: content,
        strategy: "inline",
        truncated: false,
      },
    },
  };
}

test("EventLog migration installs current projection tables without the retired transcript copy", () => {
  const value = fixture("pico-eventlog-schema-");
  try {
    const db = new DatabaseSync(operationalDatabasePath(value.storage));
    try {
      const rows = db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const names = new Set(rows.map(({ name }) => name));
      for (const name of [
        "runtime_owner_fences",
        "runtime_run_projection",
        "runtime_partial_snapshots",
        "runtime_partial_segments",
        "runtime_tool_operations",
        "runtime_tool_journal",
        "runtime_transcript_projection_state",
        "runtime_transcript_item_versions",
        "runtime_transcript_changes",
        "runtime_checkpoint_projection",
        "runtime_eventlog_metadata",
        "runtime_storage_assets",
      ]) {
        assert.ok(names.has(name), `${name} must exist`);
      }
      assert.equal(names.has("runtime_transcript_records"), false);
      assert.equal(names.has("runtime_transcript_chunks"), false);
      assert.equal(
        db
          .prepare("SELECT version FROM operational_schema_migrations WHERE scope = 'sessions'")
          .get()?.version,
        7,
      );
    } finally {
      db.close();
    }
  } finally {
    cleanup(value);
  }
});

test("sessions v5 to v6 migration creates a self-contained pre-upgrade backup", () => {
  const root = mkdtempSync(join(tmpdir(), "pico-eventlog-v6-backup-"));
  const storage = join(root, "storage");
  const v5Scope = {
    ...SESSIONS_SCOPE,
    migrations: new Map([...SESSIONS_SCOPE.migrations].filter(([version]) => version <= 5)),
  };
  try {
    prepareWorkspaceSqliteStorageSync(storage, [v5Scope]).lease.release();
    prepareWorkspaceSqliteStorageSync(storage, [SESSIONS_SCOPE]).lease.release();

    const backupPath = join(storage, "pico.sqlite.sessions-v5.bak");
    assert.equal(existsSync(backupPath), true);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(
        backup
          .prepare("SELECT version FROM operational_schema_migrations WHERE scope = 'sessions'")
          .get()?.version,
        5,
      );
      assert.equal(
        backup
          .prepare(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'runtime_transcript_projection_state'",
          )
          .get(),
        undefined,
      );
    } finally {
      backup.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sessions v6 to v7 migration backs up then removes the retired transcript copy", () => {
  const root = mkdtempSync(join(tmpdir(), "pico-eventlog-v7-backup-"));
  const storage = join(root, "storage");
  const v6Scope = {
    ...SESSIONS_SCOPE,
    migrations: new Map([...SESSIONS_SCOPE.migrations].filter(([version]) => version <= 6)),
  };
  try {
    const preparation = prepareWorkspaceSqliteStorageSync(storage, [v6Scope]);
    preparation.lease.database
      .prepare(
        `INSERT INTO sessions (session_id, work_dir, created_at, updated_at)
         VALUES ('legacy-session', '/workspace', '2026', '2026')`,
      )
      .run();
    preparation.lease.database
      .prepare(
        `INSERT INTO runtime_transcript_records
         VALUES ('legacy-record', 'legacy-session', 'event-1', 1, 'message', '{}', '2026')`,
      )
      .run();
    preparation.lease.database
      .prepare(
        `INSERT INTO runtime_transcript_chunks
         VALUES ('legacy-record', 0, 'legacy', 6)`,
      )
      .run();
    preparation.lease.release();

    prepareWorkspaceSqliteStorageSync(storage, [SESSIONS_SCOPE]).lease.release();

    const current = new DatabaseSync(operationalDatabasePath(storage), { readOnly: true });
    try {
      const names = new Set(
        (
          current.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<{
            name: string;
          }>
        ).map(({ name }) => name),
      );
      assert.equal(names.has("runtime_transcript_records"), false);
      assert.equal(names.has("runtime_transcript_chunks"), false);
      assert.equal(
        current
          .prepare("SELECT version FROM operational_schema_migrations WHERE scope = 'sessions'")
          .get()?.version,
        7,
      );
    } finally {
      current.close();
    }

    const backupPath = join(storage, "pico.sqlite.sessions-v6.bak");
    assert.equal(existsSync(backupPath), true);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(
        backup.prepare("SELECT text_value FROM runtime_transcript_chunks").get()?.text_value,
        "legacy",
      );
      assert.equal(
        backup
          .prepare("SELECT version FROM operational_schema_migrations WHERE scope = 'sessions'")
          .get()?.version,
        6,
      );
    } finally {
      backup.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner fence is epoch-zero compatible then rejects missing and stale owners", async () => {
  const value = fixture("pico-eventlog-fence-");
  try {
    const sessionId = "fenced-session";
    await value.store.initializeSession({ sessionId, workDir: value.workspace });
    assert.deepEqual(await value.store.readOwnerFence(sessionId), { sessionId, epoch: 0 });
    await value.store.append(started("e01", sessionId, value.workspace));

    const fence1 = await value.store.advanceOwnerFence(sessionId, 0);
    assert.deepEqual(fence1, { sessionId, epoch: 1 });
    await assert.rejects(
      () => value.store.append(message("e02", sessionId, "missing")),
      RuntimeEventStoreOwnerFenceError,
    );
    await assert.rejects(
      () =>
        value.store.append(message("e02", sessionId, "stale"), {
          ownerFence: { sessionId, epoch: 0 },
        }),
      RuntimeEventStoreOwnerFenceError,
    );
    await value.store.append(message("e02", sessionId, "current"), { ownerFence: fence1 });
    const fence2 = await value.store.advanceOwnerFence(sessionId, 1);
    await assert.rejects(
      () => value.store.append(message("e03", sessionId, "old owner"), { ownerFence: fence1 }),
      RuntimeEventStoreOwnerFenceError,
    );
    await value.store.append(message("e03", sessionId, "new owner"), { ownerFence: fence2 });
  } finally {
    cleanup(value);
  }
});

test("terminal is the immutable run tail with exact replay and run projection", async () => {
  const value = fixture("pico-eventlog-seal-");
  try {
    const sessionId = "sealed-session";
    const ownerFence = await initializeAndFence(value, sessionId);
    await value.store.append(started("e01", sessionId, value.workspace), { ownerFence });
    const tail = terminal("e02", sessionId);
    await assert.rejects(
      () =>
        value.store.appendBatch([tail, message("e03", sessionId, "same batch after tail")], {
          ownerFence,
        }),
      RuntimeEventStoreRunSealedError,
    );
    assert.equal(await value.store.readSessionEvent(sessionId, tail.eventId), undefined);
    assert.equal(await value.store.readSessionEvent(sessionId, "e03"), undefined);
    assert.equal((await value.store.sealRun(tail, { ownerFence })).inserted, true);
    assert.equal((await value.store.sealRun(tail, { ownerFence })).inserted, false);
    assert.deepEqual(await value.store.readRunProjection(sessionId, "run-1"), {
      sessionId,
      runId: "run-1",
      startedEventId: "e01",
      startedSequence: 1,
      terminalEventId: "e02",
      terminalSequence: 2,
      terminalStatus: "completed",
      lastEventSequence: 2,
    });
    await assert.rejects(
      () => value.store.append(message("e03", sessionId, "after tail"), { ownerFence }),
      RuntimeEventStoreRunSealedError,
    );
    await assert.rejects(
      () => value.store.sealRun(terminal("e04", sessionId), { ownerFence }),
      RuntimeEventStoreRunSealedError,
    );
  } finally {
    cleanup(value);
  }
});

test("partial snapshots use CAS, segments are idempotent, and terminal clears them", async () => {
  const value = fixture("pico-eventlog-partial-");
  try {
    const sessionId = "partial-session";
    const ownerFence = await initializeAndFence(value, sessionId);
    await value.store.append(started("e01", sessionId, value.workspace), { ownerFence });
    const first = await value.store.upsertPartialSnapshot({
      sessionId,
      runId: "run-1",
      partialId: "assistant-1",
      kind: "assistant",
      expectedVersion: 0,
      payload: { text: "a" },
      ownerFence,
    });
    assert.equal(first.version, 1);
    assert.equal(
      (
        await value.store.upsertPartialSnapshot({
          sessionId,
          runId: "run-1",
          partialId: "assistant-1",
          kind: "assistant",
          expectedVersion: 1,
          payload: { text: "ab" },
          ownerFence,
        })
      ).version,
      2,
    );
    await assert.rejects(
      () =>
        value.store.upsertPartialSnapshot({
          sessionId,
          runId: "run-1",
          partialId: "assistant-1",
          kind: "assistant",
          expectedVersion: 1,
          payload: { text: "stale" },
          ownerFence,
        }),
      RuntimeEventStoreVersionConflictError,
    );
    const segment = {
      sessionId,
      runId: "run-1",
      partialId: "assistant-1",
      segmentIndex: 0,
      payload: { delta: "b" },
      ownerFence,
    } as const;
    assert.equal((await value.store.appendPartialSegment(segment)).inserted, true);
    assert.equal((await value.store.appendPartialSegment(segment)).inserted, false);
    assert.equal((await value.store.readRunPartials(sessionId, "run-1")).segments.length, 1);
    await value.store.sealRun(terminal("e02", sessionId), { ownerFence });
    assert.deepEqual(await value.store.readRunPartials(sessionId, "run-1"), {
      snapshots: [],
      segments: [],
    });
    await assert.rejects(
      () =>
        value.store.upsertPartialSnapshot({
          ...segment,
          kind: "assistant",
          expectedVersion: 0,
          payload: { text: "late" },
        }),
      RuntimeEventStoreRunSealedError,
    );
  } finally {
    cleanup(value);
  }
});

test("tool T1/T2 atomically maintain canonical events, journal, and CAS projection", async () => {
  const value = fixture("pico-eventlog-tool-");
  try {
    const sessionId = "tool-session";
    const ownerFence = await initializeAndFence(value, sessionId);
    await value.store.append(started("e01", sessionId, value.workspace), { ownerFence });
    const dispatchEvent = toolStarted("e02", sessionId, "call-1");
    const prepared = await value.store.prepareToolOperation({
      dispatchEvent,
      toolCallId: "call-1",
      providerCallId: "provider-1",
      ownerFence,
    });
    assert.equal(prepared.operation.state, "prepared");
    assert.equal(prepared.operation.version, 1);
    assert.deepEqual(
      await value.store.readToolOperation(sessionId, "run-1", "call-1"),
      prepared.operation,
    );
    assert.deepEqual(await value.store.listRunToolOperations(sessionId, "run-1"), [
      prepared.operation,
    ]);
    assert.equal(
      (
        await value.store.prepareToolOperation({
          dispatchEvent,
          toolCallId: "call-1",
          providerCallId: "provider-1",
          ownerFence,
        })
      ).events[0]?.inserted,
      false,
    );
    const lateProviderEvent = {
      ...eventBase("e09", sessionId),
      refs: { providerCallId: "provider-late" },
      kind: "model.call.started",
      data: { providerCallId: "provider-late", purpose: "tool" },
    } as RuntimeEvent;
    await assert.rejects(
      () =>
        value.store.prepareToolOperation({
          providerEvents: [lateProviderEvent],
          dispatchEvent,
          toolCallId: "call-1",
          providerCallId: "provider-1",
          ownerFence,
        }),
      RuntimeEventStoreIntegrityError,
    );
    assert.equal(await value.store.readSessionEvent(sessionId, "e09"), undefined);
    const resultEvent = toolResult("e03", sessionId, "call-1");
    const settled = await value.store.settleToolOperation({
      resultEvent,
      toolCallId: "call-1",
      expectedVersion: 1,
      ownerFence,
    });
    assert.equal(settled.operation.state, "settled");
    assert.equal(settled.operation.version, 2);
    assert.deepEqual(await value.store.listRunToolOperations(sessionId, "run-1"), [
      settled.operation,
    ]);
    assert.equal(
      (
        await value.store.settleToolOperation({
          resultEvent,
          toolCallId: "call-1",
          expectedVersion: 1,
          ownerFence,
        })
      ).event.inserted,
      false,
    );
    await assert.rejects(
      () =>
        value.store.settleToolOperation({
          resultEvent: toolResult("e04", sessionId, "call-1", "different"),
          toolCallId: "call-1",
          expectedVersion: 2,
          ownerFence,
        }),
      RuntimeEventStoreIntegrityError,
    );
    const db = new DatabaseSync(operationalDatabasePath(value.storage));
    try {
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM runtime_tool_journal WHERE tool_call_id = 'call-1'",
          )
          .get()?.count,
        2,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM runtime_events WHERE event_id = 'e04'").get()
          ?.count,
        0,
      );
    } finally {
      db.close();
    }
  } finally {
    cleanup(value);
  }
});

test("Plan/Graph operation replay compares the full canonical payload", async () => {
  const value = fixture("pico-eventlog-operation-replay-");
  try {
    const sessionId = "operation-session";
    const ownerFence = await initializeAndFence(value, sessionId);
    const fingerprint = `sha256:${createHash("sha256").update("graph-op").digest("hex")}`;
    const graphEvent = {
      ...eventBase("e01", sessionId),
      kind: "graph.closed",
      data: { operationId: "graph-op", fingerprint, graphId: "graph-1", resultRecordIds: ["a"] },
    } as RuntimeEvent;
    await value.store.appendBatch([graphEvent], {
      planOperation: { operationId: "graph-op", fingerprint },
      ownerFence,
    });
    await assert.rejects(
      () =>
        value.store.appendBatch(
          [{ ...graphEvent, data: { ...graphEvent.data, resultRecordIds: ["b"] } } as RuntimeEvent],
          { planOperation: { operationId: "graph-op", fingerprint }, ownerFence },
        ),
      RuntimeEventStoreIntegrityError,
    );
  } finally {
    cleanup(value);
  }
});
