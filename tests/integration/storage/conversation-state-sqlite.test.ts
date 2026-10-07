import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject } from "@pico/protocol";
import {
  FIRST_SEND_CLAIM_RETENTION_MS,
  normalizeWorkspacePath,
} from "../../../packages/pico-host/src/desktop-conversation-state.js";
import { closeAllOperationalDatabasesForTest } from "@pico/storage";
import { SqliteDesktopConversationStateStore } from "../../../packages/pico-host/src/sqlite-desktop-conversation-state-store.js";
import { ALL_WORKSPACE_SQLITE_SCOPES } from "../../../packages/storage/src/sqlite/workspace-scopes.js";
import { migrateOperationalDatabaseSync } from "../../../packages/storage/src/sqlite/sqlite-schema.js";

interface Fixture {
  readonly root: string;
  readonly picoHome: string;
  readonly workspaceA: string;
  readonly workspaceB: string;
}

function createFixture(prefix: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const picoHome = join(root, "pico-home");
  const workspaceA = join(root, "ws-a");
  const workspaceB = join(root, "ws-b");
  mkdirSync(workspaceA);
  mkdirSync(workspaceB);
  return { root, picoHome, workspaceA, workspaceB };
}

function cleanupFixture(root: string): void {
  closeAllOperationalDatabasesForTest();
  rmSync(root, { recursive: true, force: true });
}

test("sqlite conversation state isolates idempotency and rewind claims by workspace", async () => {
  const fixture = createFixture("pico-conversation-state-sqlite-idem-");
  try {
    const store = new SqliteDesktopConversationStateStore({ picoHome: fixture.picoHome });
    const claims = await Promise.all([
      store.claimRewind(
        fixture.workspaceA,
        "rewind-key",
        "source",
        "target-one",
        "operation-one",
        "fingerprint-one",
      ),
      store.claimRewind(
        fixture.workspaceA,
        "rewind-key",
        "source",
        "target-two",
        "operation-two",
        "fingerprint-two",
      ),
    ]);
    assert.deepEqual(claims[1], claims[0]);
    assert.equal(claims[0]?.targetSessionId, "target-one");
    assert.equal(await store.getIdempotent(fixture.workspaceA, "rewind-key"), undefined);

    await store.rememberIdempotent(fixture.workspaceA, "rewind-key", "fingerprint-one", {
      applied: true,
      sessionId: "target-one",
    });
    assert.equal(await store.getRewindClaim(fixture.workspaceA, "rewind-key"), undefined);
    assert.deepEqual(await store.getIdempotent(fixture.workspaceA, "rewind-key"), {
      requestFingerprint: "fingerprint-one",
      result: { applied: true, sessionId: "target-one" },
    });
    assert.equal(await store.getIdempotent(fixture.workspaceB, "rewind-key"), undefined);
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("sqlite conversation state supports queue and first-send claim lifecycle", async () => {
  const fixture = createFixture("pico-conversation-state-sqlite-queue-");
  try {
    let sequence = 0;
    let clock = 2_000;
    const store = new SqliteDesktopConversationStateStore({
      picoHome: fixture.picoHome,
      now: () => (clock += 10),
      generateId: () => `queue-${++sequence}`,
    });
    const canonical = normalizeWorkspacePath(fixture.workspaceA);

    await store.enqueue(fixture.workspaceA, "session-1", { kind: "text", text: "hello" });
    await store.enqueue(fixture.workspaceA, "session-1", {
      kind: "skill",
      name: "review",
      args: "focus",
    });
    await store.enqueue(fixture.workspaceA, "session-1", { kind: "text", text: "third" });
    await store.enqueue(fixture.workspaceA, "session-2", { kind: "text", text: "other session" });
    assert.deepEqual(await store.listQueued(fixture.workspaceA, "session-1"), [
      {
        queueId: "queue-1",
        workspacePath: canonical,
        sessionId: "session-1",
        input: { kind: "text", text: "hello" },
        createdAt: 2_010,
      },
      {
        queueId: "queue-2",
        workspacePath: canonical,
        sessionId: "session-1",
        input: { kind: "skill", name: "review", args: "focus" },
        createdAt: 2_020,
      },
      {
        queueId: "queue-3",
        workspacePath: canonical,
        sessionId: "session-1",
        input: { kind: "text", text: "third" },
        createdAt: 2_030,
      },
    ]);
    assert.deepEqual(await store.listQueued(fixture.workspaceB, "session-1"), []);

    assert.deepEqual(
      await store.updateQueued(fixture.workspaceA, "session-1", "queue-2", {
        kind: "agent",
        name: "reviewer",
        task: "review the diff",
      }),
      {
        queueId: "queue-2",
        workspacePath: canonical,
        sessionId: "session-1",
        input: { kind: "agent", name: "reviewer", task: "review the diff" },
        createdAt: 2_020,
      },
    );
    assert.equal(
      await store.updateQueued(fixture.workspaceA, "session-9", "queue-2", {
        kind: "text",
        text: "wrong session",
      }),
      undefined,
    );
    assert.equal(
      await store.removeQueuedForSession(fixture.workspaceA, "session-2", "queue-2"),
      false,
    );

    assert.deepEqual(
      (
        await store.reorderQueued(fixture.workspaceA, "session-1", [
          "queue-3",
          "queue-1",
          "queue-2",
        ])
      )?.map((item) => item.queueId),
      ["queue-3", "queue-1", "queue-2"],
    );
    assert.deepEqual(
      (await store.moveQueuedToNext(fixture.workspaceA, "session-1", "queue-2"))?.map(
        (item) => item.queueId,
      ),
      ["queue-2", "queue-3", "queue-1"],
    );
    assert.equal(
      await store.reorderQueued(fixture.workspaceA, "session-1", ["queue-1", "queue-2"]),
      undefined,
    );
    assert.equal(
      await store.removeQueuedForSession(fixture.workspaceA, "session-1", "queue-3"),
      true,
    );
    assert.equal(
      await store.removeQueuedForSession(fixture.workspaceA, "session-1", "queue-3"),
      false,
    );
    clock = 500;
    await store.enqueue(fixture.workspaceA, "session-1", { kind: "text", text: "appended" });
    assert.deepEqual(
      (await store.listQueued(fixture.workspaceA, "session-1")).map((item) => item.queueId),
      ["queue-2", "queue-1", "queue-5"],
    );

    closeAllOperationalDatabasesForTest();
    const reopenedStore = new SqliteDesktopConversationStateStore({ picoHome: fixture.picoHome });
    assert.deepEqual(
      (await reopenedStore.listQueued(fixture.workspaceA, "session-1")).map((item) => item.queueId),
      ["queue-2", "queue-1", "queue-5"],
    );

    await reopenedStore.removeQueued(fixture.workspaceA, "queue-4");
    assert.deepEqual(await reopenedStore.listQueued(fixture.workspaceA, "session-2"), []);
    await reopenedStore.clearQueued(fixture.workspaceA, "session-1");
    assert.deepEqual(await reopenedStore.listQueued(fixture.workspaceA, "session-1"), []);

    const claim = await reopenedStore.claimFirstSend(
      fixture.workspaceA,
      "claim-key",
      "session-1",
      "fp-1",
    );
    assert.deepEqual(
      await reopenedStore.claimFirstSend(fixture.workspaceA, "claim-key", "session-9", "fp-9"),
      claim,
    );
    await reopenedStore.rememberIdempotent(fixture.workspaceA, "claim-key", "fp-1", { ok: true });
    assert.equal(await reopenedStore.getFirstSendClaim(fixture.workspaceA, "claim-key"), undefined);
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("control schema v9 backfills queue order by timestamp and queue id per session", () => {
  const database = new DatabaseSync(":memory:");
  try {
    migrateOperationalDatabaseSync(database, ALL_WORKSPACE_SQLITE_SCOPES);
    database.exec(`
      DROP INDEX desktop_input_queue_by_session;
      ALTER TABLE desktop_input_queue DROP COLUMN queue_order;
      CREATE INDEX desktop_input_queue_by_session
        ON desktop_input_queue(workspace_path, session_id, created_at, queue_id);
      UPDATE operational_schema_migrations SET version = 8 WHERE scope = 'control';
      INSERT INTO desktop_input_queue
        (queue_id, workspace_path, session_id, input_json, created_at)
        VALUES
          ('queue-b', '/work', 'one', '{}', 20),
          ('queue-c', '/work', 'one', '{}', 10),
          ('queue-a', '/work', 'one', '{}', 10),
          ('queue-d', '/work', 'two', '{}', 1);
    `);
    assert.equal(migrateOperationalDatabaseSync(database, ALL_WORKSPACE_SQLITE_SCOPES), true);
    assert.deepEqual(
      database
        .prepare(
          `SELECT queue_id, queue_order FROM desktop_input_queue
           WHERE workspace_path = '/work' AND session_id = 'one'
           ORDER BY queue_order, queue_id`,
        )
        .all()
        .map((row) => {
          const result = row as { queue_id: string; queue_order: number };
          return { queue_id: result.queue_id, queue_order: result.queue_order };
        }),
      [
        { queue_id: "queue-a", queue_order: 0 },
        { queue_id: "queue-c", queue_order: 1 },
        { queue_id: "queue-b", queue_order: 2 },
      ],
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT queue_id, queue_order FROM desktop_input_queue
           WHERE workspace_path = '/work' AND session_id = 'two'`,
        )
        .all()
        .map((row) => {
          const result = row as { queue_id: string; queue_order: number };
          return { queue_id: result.queue_id, queue_order: result.queue_order };
        }),
      [{ queue_id: "queue-d", queue_order: 0 }],
    );
  } finally {
    database.close();
  }
});

test("workspace queue arbitration uses each session's reordered head", async () => {
  const fixture = createFixture("pico-conversation-state-sqlite-head-order-");
  try {
    let sequence = 0;
    let clock = 0;
    const store = new SqliteDesktopConversationStateStore({
      picoHome: fixture.picoHome,
      now: () => (clock += 10),
      generateId: () => `queue-${++sequence}`,
    });
    await store.enqueue(fixture.workspaceA, "session-a", { kind: "text", text: "a1" });
    await store.enqueue(fixture.workspaceA, "session-b", { kind: "text", text: "b1" });
    await store.enqueue(fixture.workspaceA, "session-a", { kind: "text", text: "a2" });

    await store.reorderQueued(fixture.workspaceA, "session-a", ["queue-3", "queue-1"]);
    assert.deepEqual(
      (await store.listWorkspaceQueued(fixture.workspaceA)).map((item) => item.queueId),
      ["queue-2", "queue-3"],
      "global scheduling considers only the current head of each session queue",
    );
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("sqlite conversation state rolls back a failed idempotency write", async () => {
  const fixture = createFixture("pico-conversation-state-sqlite-rollback-");
  try {
    const store = new SqliteDesktopConversationStateStore({
      picoHome: fixture.picoHome,
      now: () => 5_000,
    });
    const claim = await store.claimFirstSend(fixture.workspaceA, "key-1", "session-1", "fp-1");
    const poisoned = { big: 1n } as unknown as JsonObject;
    await assert.rejects(
      store.rememberIdempotent(fixture.workspaceA, "key-1", "fp-1", poisoned),
      /BigInt/u,
    );
    assert.deepEqual(await store.getFirstSendClaim(fixture.workspaceA, "key-1"), claim);
    assert.equal(await store.getIdempotent(fixture.workspaceA, "key-1"), undefined);
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("sqlite conversation state expires first-send claims", async () => {
  const fixture = createFixture("pico-conversation-state-sqlite-retention-");
  try {
    let clock = 1_000_000;
    const store = new SqliteDesktopConversationStateStore({
      picoHome: fixture.picoHome,
      now: () => clock,
    });
    await store.claimFirstSend(fixture.workspaceA, "expire-key", "session-1", "fp-1");
    clock += FIRST_SEND_CLAIM_RETENTION_MS + 1;
    assert.equal(await store.getFirstSendClaim(fixture.workspaceA, "expire-key"), undefined);
    const renewed = await store.claimFirstSend(
      fixture.workspaceA,
      "expire-key",
      "session-2",
      "fp-2",
    );
    assert.equal(renewed.sessionId, "session-2");
    assert.equal(renewed.requestFingerprint, "fp-2");
    assert.equal(renewed.createdAt, clock);
  } finally {
    cleanupFixture(fixture.root);
  }
});
