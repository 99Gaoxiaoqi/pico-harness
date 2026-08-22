import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { RuntimeEvent } from "../../src/engine/session-runtime-event.js";
import { Session } from "../../src/engine/session.js";
import { summaryFromRuntimeSession } from "../../src/engine/session-summary.js";
import { projectRuntimeSessionMessages } from "../../src/engine/session-runtime-projection.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { operationalDatabasePath } from "../../src/storage/sqlite/sqlite-database.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import {
  findCliSessionSummary,
  listCliSessionSummaries,
  resolveCliSession,
} from "../../src/cli/session-resolver.js";

/**
 * Ticket 03 acceptance: catalog/messages projections + assembly switch.
 * 1) incremental catalog fold equals the full fold (summaryFromRuntimeSession);
 * 2) keyset pagination (page 32 / cap 128 / limit+1) over activity_at DESC, id ASC;
 * 3) archive/pin live in the sessions table (desktop session-state.json retired);
 * 4) session_messages is a rebuildable projection of message.committed facts;
 * 5) corrupt fold_json self-heals through the full-rebuild valve;
 * 6) --continue / -S / --resume / --fork resolution against the SQLite catalog;
 * 7) Session.recover() reads the materialized messages directly.
 */

interface Fixture {
  readonly root: string;
  readonly storage: string;
  readonly workspace: string;
  readonly store: SqliteRuntimeEventStore;
}

function createFixture(prefix: string, withWorkspace = true): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const workspace = join(root, "workspace");
  if (withWorkspace) mkdirSync(workspace, { recursive: true });
  const storage = join(root, "storage");
  return { root, storage, workspace, store: new SqliteRuntimeEventStore({ storageRoot: storage }) };
}

function cleanupFixture(fixture: Fixture): void {
  fixture.store.close();
  rmSync(fixture.root, { recursive: true, force: true });
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

function assistantMessage(
  eventId: string,
  sessionId: string,
  at: string,
  content: string,
): RuntimeEvent {
  return {
    schemaVersion: 2,
    eventId,
    sessionId,
    invocationId: "inv-1",
    runId: "run-1",
    turnId: "turn-1",
    at,
    partial: false,
    visibility: "model",
    kind: "message.committed",
    data: { message: { role: "assistant", content } },
  } as RuntimeEvent;
}

/** Date 字段归一为 ISO 字符串后的摘要形态(避免 deepEqual 对 Date 实例身份敏感)。 */
function normalizedSummary(summary: {
  id: string;
  cwd: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount?: number;
  title?: string;
  firstMessage?: string;
  lastMessage?: string;
  forkFrom?: string;
  historySource?: string;
  logId?: string;
  parentLogId?: string;
  forkEventId?: string;
}): Record<string, unknown> {
  return {
    id: summary.id,
    cwd: summary.cwd,
    createdAt: summary.createdAt.toISOString(),
    updatedAt: summary.updatedAt.toISOString(),
    messageCount: summary.messageCount,
    title: summary.title,
    firstMessage: summary.firstMessage,
    lastMessage: summary.lastMessage,
    forkFrom: summary.forkFrom,
    historySource: summary.historySource,
    logId: summary.logId,
    parentLogId: summary.parentLogId,
    forkEventId: summary.forkEventId,
  };
}

const FULL_SETTINGS = {
  provider: "claude",
  model: "claude-sonnet-4",
  modelRouteId: "claude/claude-sonnet-4",
  mode: "default",
  thinkingEffort: "medium",
  thinkingEffortExplicit: false,
  additionalDirectories: [],
} as const;

test("sqlite catalog: incremental fold equals the full fold (title/settings/preview/count/watermark)", async () => {
  const fixture = createFixture("pico-sqlite-catalog-fold-");
  try {
    const id = "catalog-fold";
    const manifest = await fixture.store.initializeSession({
      sessionId: id,
      workDir: fixture.workspace,
    });

    // Round 1: user + assistant messages.
    await fixture.store.appendBatch([
      userMessage(`${id}-e1`, id, "2026-08-18T00:00:01.000Z", "first user message"),
      assistantMessage(`${id}-e2`, id, "2026-08-18T00:00:02.000Z", "assistant reply"),
      userMessage(`${id}-e3`, id, "2026-08-18T00:00:03.000Z", "middle user message"),
    ]);

    // Round 2: settings title replaces the firstMessage-derived title.
    await fixture.store.appendSessionState(id, {
      settings: { ...FULL_SETTINGS, title: "settings title" },
    });

    // Round 3: mutable partial state and a transcript-only message must NOT fold or
    // materialize; the long final message exercises the <=96 preview column.
    const longContent = `preview-source-${"x".repeat(200)}`;
    await fixture.store.upsertPartialSnapshot({
      sessionId: id,
      runId: "run-1",
      partialId: `${id}-draft`,
      kind: "assistant",
      expectedVersion: 0,
      payload: { text: "partial draft" },
      at: "2026-08-18T00:00:05.000Z",
    });
    await fixture.store.appendBatch([
      {
        ...userMessage(`${id}-e6`, id, "2026-08-18T00:00:06.000Z", "transcript only"),
        visibility: "transcript",
      },
      userMessage(`${id}-e7`, id, "2026-08-18T00:00:07.000Z", longContent),
    ] as RuntimeEvent[]);
    assert.equal((await fixture.store.readRunPartials(id, "run-1")).snapshots.length, 1);

    const entry = await fixture.store.findSessionCatalogEntry(id);
    assert.ok(entry, "catalog entry must exist");
    // Fold equality: the incrementally maintained summary equals summaryFromRuntimeSession.
    const entries = await fixture.store.readSessionEntries(id);
    const expected = summaryFromRuntimeSession(manifest, entries);
    assert.deepEqual(normalizedSummary(entry.summary), normalizedSummary(expected.summary));
    assert.equal(entry.summary.title, "settings title");
    assert.equal(entry.summary.firstMessage, "first user message");
    assert.equal(entry.summary.lastMessage, longContent);
    assert.equal(entry.summary.messageCount, expected.summary.messageCount);
    assert.equal(entry.summary.updatedAt.toISOString(), "2026-08-18T00:00:07.000Z");
    assert.equal(entry.fold.headSequence, 6);
    assert.equal(entry.activityAt, "2026-08-18T00:00:07.000Z");

    const db = new DatabaseSync(operationalDatabasePath(fixture.storage));
    try {
      const row = db
        .prepare(
          "SELECT title, last_message_preview, message_count, is_archived, is_pinned, head_sequence, event_count, storage_bytes FROM session_catalog_projection WHERE session_id = ?",
        )
        .get(id) as Record<string, unknown>;
      assert.equal(row["title"], "settings title");
      assert.equal(
        typeof row["last_message_preview"] === "string"
          ? (row["last_message_preview"] as string).length
          : 0,
        96,
        "preview is capped at 96 chars",
      );
      assert.equal(row["is_archived"], 0);
      assert.equal(row["is_pinned"], 0);
      assert.equal(row["head_sequence"], 6);
      assert.equal(row["event_count"], 6);
      assert.ok(typeof row["storage_bytes"] === "number" && row["storage_bytes"] > 0);

      // Materialized messages: exactly the model-visible, non-partial message events.
      const messages = await fixture.store.readSessionMessages(id);
      const projected = projectRuntimeSessionMessages(entries.map(({ event }) => event));
      assert.deepEqual(messages, projected);
      assert.deepEqual(
        messages.map((message) => message.content),
        ["first user message", "assistant reply", "middle user message", longContent],
      );
    } finally {
      db.close();
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("sqlite catalog: keyset pagination over activity_at DESC, session_id ASC", async () => {
  const fixture = createFixture("pico-sqlite-catalog-page-");
  try {
    // Three sessions with interleaved activity: b is the most recently active.
    const ids = ["page-a", "page-b", "page-c"];
    for (const [index, id] of ids.entries()) {
      await fixture.store.initializeSession({ sessionId: id, workDir: fixture.workspace });
      await fixture.store.appendBatch([
        userMessage(`${id}-e1`, id, `2026-08-18T00:0${index}:00.000Z`, "m"),
      ]);
    }
    await fixture.store.appendBatch([
      userMessage("page-b-e2", "page-b", "2026-08-18T00:09:00.000Z", "latest"),
    ]);

    const expectedOrder = ["page-b", "page-c", "page-a"];
    assert.deepEqual(
      (await fixture.store.listSessionCatalogEntries()).map((entry) => entry.summary.id),
      expectedOrder,
    );

    // limit+1 hasMore + cursor continuation.
    const firstPage = await fixture.store.readSessionCatalogPage({ limit: 2 });
    assert.deepEqual(
      firstPage.entries.map((entry) => entry.summary.id),
      ["page-b", "page-c"],
    );
    assert.equal(firstPage.hasMore, true);
    const secondPage = await fixture.store.readSessionCatalogPage({
      limit: 2,
      after: firstPage.nextCursor,
    });
    assert.deepEqual(
      secondPage.entries.map((entry) => entry.summary.id),
      ["page-a"],
    );
    assert.equal(secondPage.hasMore, false);

    // Hard cap: limit above 128 is refused; default page size is 32.
    await assert.rejects(
      () => fixture.store.readSessionCatalogPage({ limit: 129 }),
      /between 1 and 128/,
    );
    const defaultPage = await fixture.store.readSessionCatalogPage({});
    assert.equal(defaultPage.entries.length, 3);
  } finally {
    cleanupFixture(fixture);
  }
});

test("sqlite catalog: archive/pin live in sessions (session-state.json never written)", async () => {
  const fixture = createFixture("pico-sqlite-catalog-archive-");
  try {
    const id = "archive-target";
    await fixture.store.initializeSession({ sessionId: id, workDir: fixture.workspace });
    await fixture.store.appendBatch([
      userMessage(`${id}-e1`, id, "2026-08-18T00:00:01.000Z", "message"),
    ]);

    let entry = await fixture.store.findSessionCatalogEntry(id);
    assert.equal(entry?.isArchived, false);
    assert.equal(entry?.isPinned, false);

    // Idempotent set keeps the first timestamp; unset clears the column.
    const firstAt = 1_700_000_000_000;
    assert.equal(
      fixture.store.setSessionArchived(id, true, () => firstAt),
      true,
    );
    fixture.store.setSessionArchived(id, true, () => firstAt + 5_000);
    entry = await fixture.store.findSessionCatalogEntry(id);
    assert.equal(entry?.isArchived, true);

    const db = new DatabaseSync(operationalDatabasePath(fixture.storage));
    try {
      assert.equal(
        (
          db.prepare("SELECT archived_at FROM sessions WHERE session_id = ?").get(id) as Record<
            string,
            unknown
          >
        )["archived_at"],
        firstAt,
      );
    } finally {
      db.close();
    }

    fixture.store.setSessionPinned(id, true, () => firstAt);
    entry = await fixture.store.findSessionCatalogEntry(id);
    assert.equal(entry?.isPinned, true);

    fixture.store.setSessionArchived(id, false, () => firstAt);
    fixture.store.setSessionPinned(id, false, () => firstAt);
    entry = await fixture.store.findSessionCatalogEntry(id);
    assert.equal(entry?.isArchived, false);
    assert.equal(entry?.isPinned, false);

    // Unknown session: no throw, reported as not found.
    assert.equal(
      fixture.store.setSessionArchived("missing", true, () => firstAt),
      false,
    );

    // desktop session-state.json stays retired: nothing in the storage root beyond pico.sqlite*.
    assert.ok(!existsSync(join(fixture.root, "desktop", "session-state.json")));
  } finally {
    cleanupFixture(fixture);
  }
});

test("sqlite messages + catalog: full rebuild from events (disposable derived state)", async () => {
  const fixture = createFixture("pico-sqlite-catalog-rebuild-");
  try {
    const id = "rebuild-target";
    const manifest = await fixture.store.initializeSession({
      sessionId: id,
      workDir: fixture.workspace,
    });
    await fixture.store.appendBatch([
      userMessage(`${id}-e1`, id, "2026-08-18T00:00:01.000Z", "one"),
      assistantMessage(`${id}-e2`, id, "2026-08-18T00:00:02.000Z", "two"),
      userMessage(`${id}-e3`, id, "2026-08-18T00:00:03.000Z", "three"),
    ]);
    await fixture.store.appendSessionState(id, {
      settings: { ...FULL_SETTINGS, title: "before corruption" },
    });

    const before = await fixture.store.findSessionCatalogEntry(id);
    assert.ok(before, "catalog entry must exist before corruption");
    const messagesBefore = await fixture.store.readSessionMessages(id);

    // Simulate derived-state corruption: drop the messages and mangle the fold.
    const db = new DatabaseSync(operationalDatabasePath(fixture.storage));
    try {
      db.prepare("DELETE FROM session_messages WHERE session_id = ?").run(id);
      db.prepare(
        "UPDATE session_catalog_projection SET fold_json = '{not-json', title = 'corrupted' WHERE session_id = ?",
      ).run(id);
    } finally {
      db.close();
    }
    assert.deepEqual(await fixture.store.readSessionMessages(id), []);

    // Point read triggers the watermark/decode valve: rebuild then re-read.
    const healed = await fixture.store.findSessionCatalogEntry(id);
    assert.ok(healed);
    assert.equal(healed.summary.title, "before corruption");
    assert.equal(healed.fold.headSequence, before?.fold.headSequence);
    assert.deepEqual(normalizedSummary(healed.summary), normalizedSummary(before?.summary));
    assert.deepEqual(await fixture.store.readSessionMessages(id), messagesBefore);

    // Explicit rebuild is also exposed and equals the incremental result.
    assert.equal(await fixture.store.rebuildSessionCatalogRow(id), true);
    const entries = await fixture.store.readSessionEntries(id);
    const expected = summaryFromRuntimeSession(manifest, entries);
    const rebuilt = await fixture.store.findSessionCatalogEntry(id);
    assert.ok(rebuilt, "catalog entry must exist after explicit rebuild");
    assert.deepEqual(normalizedSummary(rebuilt.summary), normalizedSummary(expected.summary));
    assert.equal(await fixture.store.rebuildSessionCatalogRow("missing"), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("session resolver: list/find/--continue/-S/--resume/--fork against the SQLite catalog", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "pico-sqlite-resolver-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  mkdirSync(workDir, { recursive: true });
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const paths = resolvePicoPaths(workDir, { picoHome });
  const store = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  try {
    const older = "resolver-older";
    const newer = "resolver-newer";
    for (const [index, id] of [older, newer].entries()) {
      await store.initializeSession({ sessionId: id, workDir });
      await store.appendBatch([
        userMessage(`${id}-e1`, id, `2026-08-18T00:0${index}:00.000Z`, `message ${id}`),
      ]);
    }

    // Listing: newest activity first, publication filter passes plain sessions.
    const summaries = await listCliSessionSummaries(workDir, { picoHome });
    assert.deepEqual(
      summaries.map((summary) => summary.id),
      [newer, older],
    );
    assert.equal(summaries[0]?.title, "message resolver-newer");

    // Point find.
    const found = await findCliSessionSummary(workDir, older, { picoHome });
    assert.equal(found?.id, older);
    assert.equal(await findCliSessionSummary(workDir, "missing", { picoHome }), undefined);

    // --continue picks the most recently active session.
    const continued = await resolveCliSession({ workDir, picoHome, continueSession: true });
    assert.deepEqual(continued, { mode: "continue", sessionId: newer });

    // -S <id> / --resume <id>: published sessions resolve; missing sessions reject.
    const resumed = await resolveCliSession({ workDir, picoHome, session: older });
    assert.deepEqual(resumed, { mode: "resume", sessionId: older });
    const explicitResume = await resolveCliSession({ workDir, picoHome, resumeSession: newer });
    assert.deepEqual(explicitResume, { mode: "resume", sessionId: newer });
    await assert.rejects(
      () => resolveCliSession({ workDir, picoHome, session: "missing" }),
      /无法恢复 session missing: RuntimeEvent 日志中不存在/,
    );

    // --fork keeps the source and mints a new target id.
    const forked = await resolveCliSession({ workDir, picoHome, forkSession: older });
    assert.equal(forked.mode, "fork");
    assert.equal(forked.sourceSessionId, older);
    assert.notEqual(forked.sessionId, older);
  } finally {
    store.close();
  }
});

test("session recover: startup reads materialized messages + state events directly", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "pico-sqlite-recover-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  mkdirSync(workDir, { recursive: true });
  context.after(() => rmSync(root, { recursive: true, force: true }));

  const id = "recover-target";
  // Phase 1: a live Session initializes the durable session, then closes.
  const first = new Session(id, workDir, { persistence: true, picoHome });
  await first.recover();
  await first.close();

  // Phase 2: append facts through the workspace store (canonical writer path).
  const store = new SqliteRuntimeEventStore({
    storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
  });
  try {
    const ownerFence = await store.readOwnerFence(id);
    await store.appendBatch(
      [
        userMessage(`${id}-e1`, id, "2026-08-18T00:00:01.000Z", "user asks"),
        assistantMessage(`${id}-e2`, id, "2026-08-18T00:00:02.000Z", "assistant answers"),
        userMessage(`${id}-e3`, id, "2026-08-18T00:00:03.000Z", "user follows up"),
      ],
      { ownerFence },
    );
    await store.appendSessionState(
      id,
      {
        settings: { ...FULL_SETTINGS, title: "recovered title" },
      },
      { ownerFence },
    );
    const projected = projectRuntimeSessionMessages(
      (await store.readSessionEntries(id)).map(({ event }) => event),
    );

    // Phase 3: a fresh Session recovers from session_messages + state events
    // (no full ledger replay) and must land on the same in-memory state.
    const catalogEntry = await store.findSessionCatalogEntry(id);
    assert.ok(catalogEntry, "catalog entry must exist after append");
    const second = new Session(id, workDir, { persistence: true, picoHome });
    try {
      await second.recover();
      assert.deepEqual(second.getHistory(), projected);
      assert.equal(second.getRuntimeStateSnapshot().settings?.title, "recovered title");
      assert.equal(second.updatedAt.toISOString(), catalogEntry.activityAt);
    } finally {
      await second.close();
    }

    // The catalog row survived the recovery round trip.
    const entry = await store.findSessionCatalogEntry(id);
    assert.equal(entry?.summary.title, "recovered title");
    assert.equal(entry?.summary.messageCount, 3);
  } finally {
    store.close();
  }
});
