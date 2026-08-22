import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { RuntimeEvent } from "../../src/engine/session-runtime-event.js";
import {
  RuntimeEventStoreHighWaterConflictError,
  RuntimeEventStoreIntegrityError,
} from "../../src/storage/runtime-event-store-contracts.js";
import { operationalDatabasePath } from "../../src/storage/sqlite/sqlite-database.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { PLAN_EVENT_KINDS } from "../../src/plan/events.js";
import { projectPlanEntries } from "../../src/plan/reducer.js";
import { GRAPH_EVENT_KINDS, projectGraphEntries } from "../../src/graph/graph-reducer.js";

/**
 * Ticket 02 acceptance: SQLite session ledger (store-layer slice).
 * 1) initialize session -> multi-turn append -> readback projections match;
 * 2) same-tx batch replay does not double-write; eventId conflict with unequal
 *    deep comparison fails closed;
 * 3) fork target conflict detection and session.forked maintenance;
 * 4) sessions/ directory and manifest.json are never produced (only pico.sqlite
 *    plus its wal/shm sidecars).
 */

interface Fixture {
  readonly root: string;
  readonly storage: string;
  readonly workspace: string;
  readonly store: SqliteRuntimeEventStore;
}

function createFixture(prefix: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const storage = join(root, "storage");
  return { root, storage, workspace, store: new SqliteRuntimeEventStore({ storageRoot: storage }) };
}

function closeFixture(fixture: Fixture): void {
  fixture.store.close();
}

function cleanupFixture(fixture: Fixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

/** After close() returns the lease, the storage root may only hold pico.sqlite + wal/shm. */
function assertSqliteOnlyLayout(storage: string): void {
  const files = readdirSync(storage);
  assert.ok(files.includes("pico.sqlite"), `expected pico.sqlite, got ${files.join(",")}`);
  for (const file of files) {
    assert.ok(
      file === "pico.sqlite" || file === "pico.sqlite-wal" || file === "pico.sqlite-shm",
      `unexpected file in storage root: ${file}`,
    );
  }
}

function userMessage(
  eventId: string,
  sessionId: string,
  at: string,
  content: string,
  runId = "run-1",
): RuntimeEvent {
  return {
    schemaVersion: 2,
    eventId,
    sessionId,
    invocationId: "inv-1",
    runId,
    turnId: "turn-1",
    at,
    partial: false,
    visibility: "model",
    kind: "message.committed",
    data: { message: { role: "user", content } },
  } as RuntimeEvent;
}

function runStarted(eventId: string, sessionId: string, at: string, workDir: string): RuntimeEvent {
  return {
    schemaVersion: 2,
    eventId,
    sessionId,
    invocationId: "inv-1",
    runId: "run-1",
    turnId: "turn-1",
    at,
    partial: false,
    visibility: "internal",
    kind: "run.started",
    data: { workDir },
  } as RuntimeEvent;
}

function sessionForked(
  eventId: string,
  sessionId: string,
  at: string,
  parentSessionId: string,
): RuntimeEvent {
  return {
    schemaVersion: 2,
    eventId,
    sessionId,
    invocationId: "inv-fork",
    runId: "run-fork",
    turnId: "turn-fork",
    at,
    partial: false,
    visibility: "internal",
    kind: "session.forked",
    data: { parentSessionId },
  } as RuntimeEvent;
}

function sha256Fingerprint(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

test("sqlite sessions: initialize + multi-turn append + readback projections + sqlite-only layout", async () => {
  const fixture = createFixture("pico-sqlite-sessions-basic-");
  try {
    const id = "sqlite-basic";
    const manifest = await fixture.store.initializeSession({
      sessionId: id,
      workDir: fixture.workspace,
    });
    assert.equal(manifest.sessionId, id);
    assert.equal(manifest.historySource, "runtime-event-v2");
    // Duplicate initialization is idempotent: returns the existing manifest.
    assert.deepEqual(
      await fixture.store.initializeSession({ sessionId: id, workDir: fixture.workspace }),
      manifest,
    );

    // Three append rounds (run.started + messages; runs interleaved).
    const round1 = [
      runStarted(`${id}-e0`, id, "2026-08-18T00:00:00.000Z", fixture.workspace),
      userMessage(`${id}-e1`, id, "2026-08-18T00:00:01.000Z", "message one"),
      userMessage(`${id}-e2`, id, "2026-08-18T00:00:02.000Z", "message two"),
    ];
    const round2 = [
      userMessage(`${id}-e3`, id, "2026-08-18T00:00:03.000Z", "message three", "run-2"),
      userMessage(`${id}-e4`, id, "2026-08-18T00:00:04.000Z", "message four", "run-2"),
    ];
    const round3 = [userMessage(`${id}-e5`, id, "2026-08-18T00:00:05.000Z", "message five")];
    const allEvents = [...round1, ...round2, ...round3];

    const r1 = await fixture.store.appendBatch(round1);
    const r2 = await fixture.store.appendBatch(round2);
    const r3 = await fixture.store.appendBatch(round3);
    const expectedSeqs = [[1, 2, 3], [4, 5], [6]];
    for (const [results, seqs, events] of [
      [r1, expectedSeqs[0]!, round1],
      [r2, expectedSeqs[1]!, round2],
      [r3, expectedSeqs[2]!, round3],
    ] as const) {
      assert.deepEqual(
        results.map((result) => [result.inserted, result.cursor.seq, result.cursor.epoch]),
        seqs.map((seq) => [true, seq, 0]),
      );
      assert.deepEqual(
        results.map((result) => result.committedAt),
        events.map((event) => event.at),
      );
    }

    // Readback: deep-equal event stream, contiguous sequences.
    assert.deepEqual(await fixture.store.readSession(id), allEvents);
    const entries = await fixture.store.readSessionEntries(id);
    assert.deepEqual(
      entries.map((entry) => entry.sequence),
      [1, 2, 3, 4, 5, 6],
    );
    assert.deepEqual(
      entries.map((entry) => entry.event.eventId),
      allEvents.map((event) => event.eventId),
    );

    // Point read / head cursor / run view / run list.
    const one = await fixture.store.readSessionEvent(id, `${id}-e3`);
    assert.equal(one?.sequence, 4);
    assert.deepEqual(one?.event, round2[0]);
    assert.deepEqual(await fixture.store.getHeadCursor(id), {
      logId: id,
      seq: 6,
      epoch: 0,
      eventId: `${id}-e5`,
    });
    assert.deepEqual(await fixture.store.listRunIds(id), ["run-1", "run-2"]);
    assert.deepEqual(await fixture.store.readRun(id, "run-2"), [...round2]);

    // True keyset pagination.
    assert.deepEqual(
      (await fixture.store.readSessionEntriesPage(id, { afterSequence: 2, limit: 2 })).map(
        (entry) => entry.sequence,
      ),
      [3, 4],
    );
    assert.deepEqual(
      (await fixture.store.readSessionEntriesPage(id, { afterSequence: 4 })).map(
        (entry) => entry.sequence,
      ),
      [5, 6],
    );

    // Manifest surface + workspace batch read.
    assert.deepEqual(await fixture.store.readSessionManifest(id), manifest);
    assert.deepEqual(await fixture.store.listSessionManifests(), [manifest]);
    assert.deepEqual(await fixture.store.getSessionManifestScanUpperBound(), {
      createdAt: manifest.createdAt,
      sessionId: id,
    });
    assert.deepEqual(
      await fixture.store.listSessionManifestsPage({
        upperBound: { createdAt: manifest.createdAt, sessionId: id },
        limit: 5,
      }),
      [manifest],
    );
    const snapshots = await fixture.store.readWorkspaceSessions();
    assert.equal(snapshots.length, 1);
    assert.deepEqual(snapshots[0]?.manifest, manifest);
    assert.equal(snapshots[0]?.entries.length, 6);

    // Projection snapshot and delta (through must be the current head).
    const projection = await fixture.store.readSessionProjection(id);
    assert.deepEqual(projection?.manifest, manifest);
    assert.equal(projection?.entries.length, 6);
    assert.deepEqual(projection?.cursor, { logId: id, seq: 6, epoch: 0, eventId: `${id}-e5` });
    const delta = await fixture.store.readSessionProjectionDelta(
      id,
      { logId: id, seq: 2, epoch: 0, eventId: `${id}-e1` },
      { logId: id, seq: 6, epoch: 0, eventId: `${id}-e5` },
    );
    assert.deepEqual(
      delta?.entries.map((entry) => entry.sequence),
      [3, 4, 5, 6],
    );
    assert.deepEqual(delta?.cursor, { logId: id, seq: 6, epoch: 0, eventId: `${id}-e5` });

    // appendSessionState wrapper: the session-state run stays out of listRunIds.
    const fullSettings = {
      provider: "claude",
      model: "claude-sonnet-4",
      modelRouteId: "claude/claude-sonnet-4",
      mode: "default",
      thinkingEffort: "medium",
      thinkingEffortExplicit: false,
      additionalDirectories: [],
    } as const;
    const stateResult = await fixture.store.appendSessionState(id, {
      settings: { ...fullSettings, title: "title A" },
    });
    assert.equal(stateResult.inserted, true);
    assert.equal(stateResult.cursor.seq, 7);
    assert.deepEqual(await fixture.store.listRunIds(id), ["run-1", "run-2"]);
    assert.equal((await fixture.store.readRun(id, "session-state")).length, 1);

    // Watermark maintenance reconciled against runtime_events; one tx per batch.
    const db = new DatabaseSync(operationalDatabasePath(fixture.storage));
    try {
      const row = db
        .prepare(
          "SELECT last_event_seq, last_tx_id, event_count, storage_bytes, fork_parent_session_id FROM sessions WHERE session_id = ?",
        )
        .get(id) as Record<string, unknown>;
      assert.equal(row["last_event_seq"], 7);
      assert.equal(typeof row["last_tx_id"], "string");
      assert.equal(row["event_count"], 7);
      assert.equal(row["fork_parent_session_id"], null);
      assert.equal(
        (
          db
            .prepare(
              "SELECT (SELECT storage_bytes FROM sessions WHERE session_id = ?1) = (SELECT SUM(length(payload_json)) FROM runtime_events WHERE session_id = ?1) AS ok",
            )
            .get(id) as { ok: number }
        ).ok,
        1,
        "storage_bytes must equal sum(length(payload_json))",
      );
      assert.equal(
        (
          db
            .prepare("SELECT COUNT(DISTINCT tx_id) AS n FROM runtime_events WHERE session_id = ?")
            .get(id) as { n: number }
        ).n,
        4,
        "each appendBatch is one tx",
      );
    } finally {
      db.close();
    }

    // Layout: no sessions/ directory and no manifest.json in the storage root.
    assert.ok(!existsSync(join(fixture.storage, "sessions")));
    assert.ok(!existsSync(join(fixture.storage, "manifest.json")));
  } finally {
    closeFixture(fixture);
    assertSqliteOnlyLayout(fixture.storage);
    cleanupFixture(fixture);
  }
});

test("sqlite sessions: same-tx replay does not double-write + conflicting eventId fails closed", async () => {
  const fixture = createFixture("pico-sqlite-sessions-idem-");
  try {
    const id = "sqlite-idempotent";
    await fixture.store.initializeSession({ sessionId: id, workDir: fixture.workspace });
    const batch = [
      userMessage(`${id}-e1`, id, "2026-08-18T00:00:01.000Z", "message one"),
      userMessage(`${id}-e2`, id, "2026-08-18T00:00:02.000Z", "message two"),
      userMessage(`${id}-e3`, id, "2026-08-18T00:00:03.000Z", "message three"),
    ];
    const first = await fixture.store.appendBatch(batch);
    assert.deepEqual(
      first.map((result) => [result.inserted, result.cursor.seq]),
      [
        [true, 1],
        [true, 2],
        [true, 3],
      ],
    );

    const db = new DatabaseSync(operationalDatabasePath(fixture.storage));
    try {
      const readWatermark = () =>
        db
          .prepare(
            "SELECT last_tx_id, event_count, (SELECT COUNT(*) FROM runtime_events WHERE session_id = ?1) AS rows, (SELECT COUNT(DISTINCT tx_id) FROM runtime_events WHERE session_id = ?1) AS txs FROM sessions WHERE session_id = ?1",
          )
          .get(id) as Record<string, unknown>;
      const before = readWatermark();

      // Replay the whole batch (order shuffled): all idempotent, no new rows or txs.
      const replayBatch = [...batch].reverse();
      const replay = await fixture.store.appendBatch(replayBatch);
      assert.deepEqual(
        replay.map((result) => [result.inserted, result.cursor.seq, result.cursor.eventId]),
        replayBatch.map((event) => [
          false,
          batch.findIndex((candidate) => candidate.eventId === event.eventId) + 1,
          event.eventId,
        ]),
      );
      assert.deepEqual(
        replay.map((result) => result.committedAt),
        replayBatch.map((event) => event.at),
      );
      const after = readWatermark();
      assert.equal(after["rows"], 3);
      assert.equal(after["txs"], 1);
      assert.equal(after["event_count"], 3);
      assert.equal(after["last_tx_id"], before["last_tx_id"], "replay must not touch watermarks");

      // Same id, mutated payload: fail closed.
      const mutated = {
        ...batch[0]!,
        data: { message: { role: "user", content: "tampered" } },
      } as RuntimeEvent;
      await assert.rejects(
        () => fixture.store.appendBatch([mutated]),
        (error: unknown) =>
          error instanceof RuntimeEventStoreIntegrityError &&
          /already bound to another payload/.test(error.message),
      );

      // Two payloads for one id inside a single batch: fail closed.
      const fresh = userMessage(`${id}-e9`, id, "2026-08-18T00:00:09.000Z", "new message");
      await assert.rejects(
        () =>
          fixture.store.appendBatch([
            fresh,
            { ...fresh, data: { message: { role: "user", content: "different" } } } as RuntimeEvent,
          ]),
        /conflicting payloads in one append batch/,
      );

      // plan/graph CAS: exactly-once via the operation_id projection column.
      const fingerprint = sha256Fingerprint("op");
      const opEvent = {
        schemaVersion: 2,
        eventId: `${id}-graph-1`,
        sessionId: id,
        invocationId: "inv-1",
        runId: "run-graph",
        turnId: "turn-1",
        at: "2026-08-18T00:00:10.000Z",
        partial: false,
        visibility: "internal",
        kind: "graph.work.added",
        data: {
          operationId: "op-1",
          fingerprint,
          graphId: "graph-1",
          workId: "work-1",
          instruction: "do one thing",
          inputIds: [],
          mode: "worker",
        },
      } as RuntimeEvent;
      const opFirst = await fixture.store.appendPlanOperation([opEvent], {
        operationId: "op-1",
        fingerprint,
        expectedSessionSequence: 3,
      });
      assert.deepEqual(
        opFirst.map((result) => [result.inserted, result.cursor.seq]),
        [[true, 4]],
      );
      const opReplay = await fixture.store.appendPlanOperation([opEvent], {
        operationId: "op-1",
        fingerprint,
        expectedSessionSequence: 3,
      });
      assert.deepEqual(
        opReplay.map((result) => [result.inserted, result.cursor.seq]),
        [[false, 4]],
      );
      await assert.rejects(
        () =>
          fixture.store.appendPlanOperation([opEvent], {
            operationId: "op-1",
            fingerprint: sha256Fingerprint("other"),
            expectedSessionSequence: 4,
          }),
        (error: unknown) =>
          error instanceof RuntimeEventStoreIntegrityError &&
          /already bound to another fingerprint/.test(error.message),
      );
      // Cross-session replay under the plan CAS envelope: another session reusing
      // the bound eventId must fail closed in the replay branch too, not be
      // acknowledged as an idempotent replay of a foreign session's row.
      const otherSession = `${id}-cross`;
      await fixture.store.initializeSession({
        sessionId: otherSession,
        workDir: fixture.workspace,
      });
      await assert.rejects(
        () =>
          fixture.store.appendBatch(
            [opEvent, { ...opEvent, sessionId: otherSession } as RuntimeEvent],
            { planOperation: { operationId: "op-1", fingerprint } },
          ),
        (error: unknown) =>
          error instanceof RuntimeEventStoreIntegrityError &&
          /belongs to another session/.test(error.message),
      );
      await assert.rejects(
        () =>
          fixture.store.appendPlanOperation(
            [
              {
                ...opEvent,
                eventId: `${id}-graph-2`,
                data: { ...opEvent.data, operationId: "op-2" },
              } as RuntimeEvent,
            ],
            {
              operationId: "op-2",
              fingerprint,
              expectedSessionSequence: 0,
            },
          ),
        (error: unknown) =>
          error instanceof RuntimeEventStoreHighWaterConflictError &&
          /high-water changed/.test(error.message),
      );

      // In-batch duplicate of one event (same id, same payload): the later copy
      // must take the replay branch (inserted:false, first copy's sequence) —
      // e42d80e7 in-batch idempotence, not an event_id PK constraint failure.
      const dupEvent = userMessage(`${id}-d1`, id, "2026-08-18T00:00:11.000Z", "dup message");
      const otherNew = userMessage(`${id}-d2`, id, "2026-08-18T00:00:12.000Z", "other message");
      const dupResults = await fixture.store.appendBatch([dupEvent, otherNew, dupEvent]);
      assert.deepEqual(
        dupResults.map((result) => [result.inserted, result.cursor.seq]),
        [
          [true, 5],
          [true, 6],
          [false, 5],
        ],
      );

      // Every conflict path failed closed; duplicates did not double-write.
      const finalWatermark = readWatermark();
      assert.equal(finalWatermark["rows"], 6);
      assert.equal(finalWatermark["event_count"], 6);
    } finally {
      db.close();
    }
  } finally {
    closeFixture(fixture);
    cleanupFixture(fixture);
  }
});

test("sqlite sessions: partial RuntimeEvents never enter the canonical ledger", async () => {
  const fixture = createFixture("pico-sqlite-sessions-partial-lane-");
  try {
    const sessionId = "sqlite-partial-lane";
    await fixture.store.initializeSession({ sessionId, workDir: fixture.workspace });
    const partial = {
      ...userMessage(`${sessionId}-partial`, sessionId, "2026-08-18T00:00:01.000Z", "streaming"),
      partial: true,
    } as RuntimeEvent;

    await assert.rejects(
      () => fixture.store.append(partial),
      (error: unknown) =>
        error instanceof RuntimeEventStoreIntegrityError &&
        /use the mutable partial lane/u.test(error.message),
    );
    await assert.rejects(
      () => fixture.store.appendBatch([partial]),
      (error: unknown) =>
        error instanceof RuntimeEventStoreIntegrityError &&
        /use the mutable partial lane/u.test(error.message),
    );

    assert.equal(await fixture.store.getHeadCursor(sessionId), undefined);
    assert.deepEqual(await fixture.store.readSession(sessionId), []);
    const db = new DatabaseSync(operationalDatabasePath(fixture.storage));
    try {
      const row = db
        .prepare(
          "SELECT last_event_seq, event_count, storage_bytes, (SELECT COUNT(*) FROM runtime_events WHERE session_id = ?1) AS rows FROM sessions WHERE session_id = ?1",
        )
        .get(sessionId) as Record<string, unknown>;
      assert.deepEqual(
        { ...row },
        {
          last_event_seq: 0,
          event_count: 0,
          storage_bytes: 0,
          rows: 0,
        },
      );
    } finally {
      db.close();
    }
  } finally {
    closeFixture(fixture);
    cleanupFixture(fixture);
  }
});

test("sqlite sessions: fork target conflict detection and session.forked maintenance", async () => {
  const fixture = createFixture("pico-sqlite-sessions-fork-");
  try {
    const parent = "sqlite-fork-parent";
    const child = "sqlite-fork-child";
    await fixture.store.initializeSession({ sessionId: parent, workDir: fixture.workspace });
    await fixture.store.appendBatch([
      userMessage(`${parent}-e1`, parent, "2026-08-18T00:00:01.000Z", "parent message"),
    ]);

    const childManifest = await fixture.store.initializeSession({
      sessionId: child,
      workDir: fixture.workspace,
    });
    // Target occupied: same-workspace duplicate init is idempotent, foreign init refused.
    assert.deepEqual(
      await fixture.store.initializeSession({ sessionId: child, workDir: fixture.workspace }),
      childManifest,
    );
    await assert.rejects(
      () =>
        fixture.store.initializeSession({
          sessionId: child,
          workDir: join(fixture.root, "elsewhere"),
        }),
      /belongs to another workspace/,
    );

    // Publishing session.forked maintains fork_parent_session_id in the same tx.
    const forkEvent = sessionForked(`${child}-f1`, child, "2026-08-18T00:00:02.000Z", parent);
    const published = await fixture.store.appendBatch([forkEvent]);
    assert.deepEqual(
      published.map((result) => [result.inserted, result.cursor.seq]),
      [[true, 1]],
    );

    const db = new DatabaseSync(operationalDatabasePath(fixture.storage));
    try {
      const forkParentOf = (sessionId: string): unknown =>
        db
          .prepare("SELECT fork_parent_session_id AS p FROM sessions WHERE session_id = ?")
          .get(sessionId)?.p;
      assert.equal(forkParentOf(child), parent);
      assert.equal(forkParentOf(parent), null, "root session has no fork parent");

      // Replaying the same fork fact is idempotent; fork_parent stays.
      const replay = await fixture.store.appendBatch([forkEvent]);
      assert.equal(replay[0]?.inserted, false);
      assert.equal(replay[0]?.cursor.seq, 1);
      assert.equal(forkParentOf(child), parent);

      // Fork target conflict: declaring another parent on the same target is
      // refused and the transaction rolls back without residue.
      await assert.rejects(
        () =>
          fixture.store.appendBatch([
            sessionForked(`${child}-f2`, child, "2026-08-18T00:00:03.000Z", "sqlite-other"),
          ]),
        (error: unknown) =>
          error instanceof RuntimeEventStoreIntegrityError &&
          /already forked from another parent/.test(error.message),
      );
      assert.equal(forkParentOf(child), parent);
      assert.equal(
        (await fixture.store.readSessionEntries(child)).length,
        1,
        "conflicting fork append must roll back",
      );
      assert.deepEqual(await fixture.store.getHeadCursor(child), {
        logId: child,
        seq: 1,
        epoch: 0,
        eventId: `${child}-f1`,
      });
    } finally {
      db.close();
    }

    // Readback: the child session event stream contains the fork fact.
    assert.deepEqual(await fixture.store.readSession(child), [forkEvent]);
  } finally {
    closeFixture(fixture);
    cleanupFixture(fixture);
  }
});

test("sqlite sessions: kind slice + first/last of kind + run view 索引查询与全量口径等价(票 04)", async () => {
  const fixture = createFixture("pico-sqlite-kind-slice-");
  try {
    const id = "sqlite-kind-slice";
    await fixture.store.initializeSession({ sessionId: id, workDir: fixture.workspace });
    const events = [
      runStarted(`${id}-e0`, id, "2026-08-19T00:00:00.000Z", fixture.workspace),
      userMessage(`${id}-e1`, id, "2026-08-19T00:00:01.000Z", "message one"),
      userMessage(`${id}-e2`, id, "2026-08-19T00:00:02.000Z", "message two", "run-2"),
    ];
    await fixture.store.appendBatch(events);
    const full = await fixture.store.readSessionEntries(id);

    // kind 全集切片与全量读逐条相等,headSequence 为全会话水位。
    const mixed = await fixture.store.readSessionEntriesOfKinds(id, [
      "run.started",
      "message.committed",
    ]);
    assert.deepEqual(mixed.entries, full);
    assert.equal(mixed.headSequence, 3);

    // 子集切片:只含 message.committed,顺序保持 event_seq 升序。
    const messagesOnly = await fixture.store.readSessionEntriesOfKinds(id, ["message.committed"]);
    assert.deepEqual(
      messagesOnly.entries.map(({ sequence }) => sequence),
      [2, 3],
    );
    assert.equal(messagesOnly.headSequence, 3, "headSequence 不随切片收窄");

    // 首条/末条 by-kind 点查。
    assert.deepEqual(
      await fixture.store.readFirstSessionEntryOfKind(id, "message.committed"),
      full[1],
    );
    assert.deepEqual(
      await fixture.store.readLastSessionEntryOfKind(id, "message.committed"),
      full[2],
    );
    assert.equal(
      await fixture.store.readLastSessionEntryOfKind(id, "context.checkpoint.recorded"),
      undefined,
      "不存在的 kind 末条为 undefined",
    );

    // run 视图经 run 索引直查,等价于全量读过滤。
    assert.deepEqual(await fixture.store.readRun(id, "run-2"), [events[2]]);
    assert.deepEqual(await fixture.store.readRun(id, "run-1"), [events[0], events[1]]);

    // 参数校验 fail-closed。
    await assert.rejects(
      () => fixture.store.readSessionEntriesOfKinds(id, []),
      /requires non-empty event kinds/,
    );
    await assert.rejects(
      () => fixture.store.readSessionEntriesOfKinds(id, ["message.committed", "  "]),
      /requires non-empty event kinds/,
    );
  } finally {
    closeFixture(fixture);
    cleanupFixture(fixture);
  }
});

test("sqlite sessions: projection delta 校验窄化——锚点/头部点查 + (after, through] 窗口(票 04)", async () => {
  const fixture = createFixture("pico-sqlite-delta-window-");
  try {
    const id = "sqlite-delta-window";
    await fixture.store.initializeSession({ sessionId: id, workDir: fixture.workspace });
    const events = [
      ...[1, 2, 3, 4, 5].map((index) =>
        userMessage(`${id}-e${index}`, id, `2026-08-19T00:00:0${index}.000Z`, `message ${index}`),
      ),
    ];
    await fixture.store.appendBatch(events);

    const cursor = (seq: number, eventId: string) => ({
      logId: id,
      seq,
      epoch: 0,
      eventId,
    });

    // 命中:窗口 (2, 5] 逐条返回,游标为 through。
    const delta = await fixture.store.readSessionProjectionDelta(
      id,
      cursor(2, `${id}-e2`),
      cursor(5, `${id}-e5`),
    );
    assert.deepEqual(
      delta?.entries.map(({ sequence }) => sequence),
      [3, 4, 5],
    );
    assert.deepEqual(delta?.cursor, cursor(5, `${id}-e5`));

    // after 锚点 eventId 与库内不符 → undefined(不回退、不猜测)。
    assert.equal(
      await fixture.store.readSessionProjectionDelta(
        id,
        cursor(2, "tampered-event-id"),
        cursor(5, `${id}-e5`),
      ),
      undefined,
    );
    // after 锚点指向不存在的 sequence → undefined。
    assert.equal(
      await fixture.store.readSessionProjectionDelta(
        id,
        cursor(99, "absent"),
        cursor(100, "absent-too"),
      ),
      undefined,
    );
    // through 不是当前头部(库已前进)→ undefined,调用方须重放全量快照。
    assert.equal(
      await fixture.store.readSessionProjectionDelta(
        id,
        cursor(2, `${id}-e2`),
        cursor(4, `${id}-e4`),
      ),
      undefined,
    );
  } finally {
    closeFixture(fixture);
    cleanupFixture(fixture);
  }
});

test("sqlite sessions: plan/graph 投影 kind 切片 + 显式水位与全量读口径等价(票 04)", async () => {
  const fixture = createFixture("pico-sqlite-plan-graph-slice-");
  try {
    const id = "sqlite-plan-graph-slice";
    await fixture.store.initializeSession({ sessionId: id, workDir: fixture.workspace });
    const planEvent = {
      schemaVersion: 2,
      eventId: `${id}-p1`,
      sessionId: id,
      invocationId: "inv-1",
      runId: "run-1",
      turnId: "turn-1",
      at: "2026-08-19T00:00:01.000Z",
      partial: false,
      visibility: "internal",
      kind: "plan.proposed",
      data: {
        operationId: "op-proposal-1",
        fingerprint: sha256Fingerprint("plan-proposal-1"),
        proposal: {
          planId: "plan-1",
          revision: 1,
          title: "迁移验证",
          status: "pending",
          proposedAt: "2026-08-19T00:00:01.000Z",
          steps: [
            {
              id: "step-1",
              title: "切片查询",
              description: "plan/graph 投影等价验证",
              status: "pending",
            },
          ],
        },
      },
    } as RuntimeEvent;
    const graphEvent = {
      schemaVersion: 2,
      eventId: `${id}-g1`,
      sessionId: id,
      invocationId: "inv-1",
      runId: "run-1",
      turnId: "turn-1",
      at: "2026-08-19T00:00:02.000Z",
      partial: false,
      visibility: "internal",
      kind: "graph.work.added",
      data: {
        operationId: "graph-op-1",
        fingerprint: sha256Fingerprint("graph-op-1"),
        graphId: "graph-1",
        workId: "work-1",
        instruction: "explore the ledger",
        inputIds: [],
        mode: "explore",
      },
    } as RuntimeEvent;
    const events = [
      runStarted(`${id}-e0`, id, "2026-08-19T00:00:00.000Z", fixture.workspace),
      planEvent,
      userMessage(`${id}-e1`, id, "2026-08-19T00:00:03.000Z", "message one"),
      graphEvent,
      userMessage(`${id}-e2`, id, "2026-08-19T00:00:04.000Z", "message two"),
    ];
    await fixture.store.appendBatch(events);
    const full = await fixture.store.readSessionEntries(id);

    // plan 投影:kind 切片 + 显式 headSequence 与全量折叠逐字段相等
    // (sessionSequence 取全会话水位,而非切片末条)。
    const planSlice = await fixture.store.readSessionEntriesOfKinds(id, PLAN_EVENT_KINDS);
    assert.equal(planSlice.entries.length, 1);
    assert.deepEqual(
      projectPlanEntries(id, planSlice.entries, planSlice.headSequence),
      projectPlanEntries(id, full),
    );
    // 缺省水位回退切片末条(旧口径)仅用于兼容;显式水位才等于全量口径。
    assert.notEqual(
      projectPlanEntries(id, planSlice.entries).sessionSequence,
      projectPlanEntries(id, full).sessionSequence,
    );

    // graph 投影:同口径等价。
    const graphSlice = await fixture.store.readSessionEntriesOfKinds(id, GRAPH_EVENT_KINDS);
    assert.equal(graphSlice.entries.length, 1);
    assert.deepEqual(
      projectGraphEntries("graph-1", graphSlice.entries, graphSlice.headSequence),
      projectGraphEntries("graph-1", full),
    );
  } finally {
    closeFixture(fixture);
    cleanupFixture(fixture);
  }
});
