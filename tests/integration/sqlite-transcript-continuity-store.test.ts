import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { RuntimeEvent } from "../../src/engine/session-runtime-event.js";
import { RuntimeEventStoreIntegrityError } from "../../src/storage/runtime-event-store-contracts.js";
import { operationalDatabasePath } from "../../src/storage/sqlite/sqlite-database.js";
import {
  RuntimeTranscriptResetRequiredError,
  SqliteRuntimeEventStore,
} from "../../src/storage/sqlite/sqlite-runtime-event-store.js";

function eventBase(eventId: string, sessionId: string, runId = "run-1", turnId = "turn-1") {
  return {
    schemaVersion: 2 as const,
    eventId,
    sessionId,
    invocationId: "inv-1",
    runId,
    turnId,
    at: "2026-08-23T00:00:00.000Z",
    partial: false,
    visibility: "model" as const,
  };
}

function message(
  eventId: string,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  runId = "run-1",
  turnId = "turn-1",
): RuntimeEvent {
  return {
    ...eventBase(eventId, sessionId, runId, turnId),
    kind: "message.committed",
    data: { message: { role, content } },
  };
}

function toolResult(eventId: string, sessionId: string, toolCallId: string): RuntimeEvent {
  const content = "tool result";
  const sha256 = createHash("sha256").update(content).digest("hex");
  return {
    ...eventBase(eventId, sessionId),
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

test("transcript projection keeps fixed watermarks and advances from the change suffix", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-transcript-projection-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const store = new SqliteRuntimeEventStore({ storageRoot: join(root, "storage") });
  try {
    const sessionId = "projection-session";
    await store.initializeSession({ sessionId, workDir: workspace });
    const first = await store.append(message("user-event", sessionId, "user", "hello"));
    assert.equal(first.transcriptWatermark?.throughSequence, 1);
    const firstWatermark = first.transcriptWatermark!;

    const second = await store.append(
      message("assistant-event", sessionId, "assistant", "world", "run-a", "turn-a"),
    );
    const secondWatermark = second.transcriptWatermark!;
    assert.equal(secondWatermark.throughSequence, 2);
    assert.equal(secondWatermark.historyEpoch, firstWatermark.historyEpoch);

    const fixed = await store.readTranscriptProjectionPage({
      sessionId,
      through: firstWatermark,
      maxBytes: 16_384,
    });
    assert.deepEqual(
      fixed.items.map(({ itemId }) => itemId),
      ["message:user-event:user"],
    );

    const advance = await store.readTranscriptAdvancePage({
      sessionId,
      after: firstWatermark,
      through: secondWatermark,
      maxBytes: 16_384,
    });
    assert.deepEqual(
      advance.changes.map((change) =>
        change.op === "upsert" ? [change.op, change.record.itemId] : [change.op, change.itemId],
      ),
      [["upsert", "message:turn-a:assistant"]],
    );

    await assert.rejects(
      () =>
        store.readTranscriptProjectionPage({
          sessionId,
          through: { ...firstWatermark, historyEpoch: "stale-history" },
          maxBytes: 16_384,
        }),
      RuntimeTranscriptResetRequiredError,
    );
    await assert.rejects(
      () =>
        store.readTranscriptProjectionPage({
          sessionId,
          through: secondWatermark,
          maxBytes: 1,
        }),
      RuntimeEventStoreIntegrityError,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool projection updates one source-stable item revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-transcript-tool-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const store = new SqliteRuntimeEventStore({ storageRoot: join(root, "storage") });
  try {
    const sessionId = "tool-session";
    await store.initializeSession({ sessionId, workDir: workspace });
    const started = await store.appendTranscriptEvent(
      sessionId,
      {
        eventId: "transcript-tool-started",
        sequence: 1,
        createdAt: Date.parse("2026-08-23T00:00:00.000Z"),
        type: "tool.started",
        entryId: "entry-tool",
        toolCallId: "call-1",
        providerCallId: "provider-1",
        name: "read",
        args: '{"path":"README.md"}',
      },
      { eventId: "runtime-tool-started" },
    );
    const settled = await store.append(toolResult("runtime-tool-result", sessionId, "call-1"));
    const advance = await store.readTranscriptAdvancePage({
      sessionId,
      after: started.transcriptWatermark!,
      through: settled.transcriptWatermark!,
      maxBytes: 16_384,
    });
    assert.equal(advance.changes.length, 1);
    const change = advance.changes[0]!;
    assert.equal(change.op, "upsert");
    if (change.op === "upsert") {
      assert.equal(change.record.itemId, "tool:call-1");
      assert.equal(change.record.itemRevision, 2);
      assert.deepEqual(change.record.payload, {
        args: '{"path":"README.md"}',
        at: Date.parse("2026-08-23T00:00:00.000Z"),
        data: { toolCallId: "call-1", entryId: "entry-tool" },
        id: "tool:call-1",
        kind: "tool",
        name: "read",
        result: {
          deliveryTruncated: false,
          projection: {
            mode: "full",
            strategy: "inline",
            text: "tool result",
            truncated: false,
            version: 1,
          },
          rawSizeBytes: 11,
          sha256: createHash("sha256").update("tool result").digest("hex"),
          status: "succeeded",
          toolCallId: "call-1",
          toolName: "read",
          version: 1,
        },
        status: "success",
      });
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lazy rebuild rotates history and requires bootstrap from the rebuilt head", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-transcript-rebuild-"));
  const workspace = join(root, "workspace");
  const storage = join(root, "storage");
  mkdirSync(workspace, { recursive: true });
  let store = new SqliteRuntimeEventStore({ storageRoot: storage });
  try {
    const sessionId = "rebuild-session";
    await store.initializeSession({ sessionId, workDir: workspace });
    const appended = await store.append(message("old-event", sessionId, "user", "durable"));
    const oldWatermark = appended.transcriptWatermark!;
    store.close();

    const database = new DatabaseSync(operationalDatabasePath(storage));
    database
      .prepare("DELETE FROM runtime_transcript_projection_state WHERE session_id = ?")
      .run(sessionId);
    database.close();

    store = new SqliteRuntimeEventStore({ storageRoot: storage });
    const rebuilt = await store.readTranscriptProjectionPage({ sessionId, maxBytes: 16_384 });
    assert.notEqual(rebuilt.watermark.historyEpoch, oldWatermark.historyEpoch);
    assert.equal(rebuilt.watermark.throughSequence, 1);
    assert.deepEqual(
      rebuilt.items.map(({ itemId }) => itemId),
      ["message:old-event:user"],
    );
    await assert.rejects(
      () =>
        store.readTranscriptAdvancePage({
          sessionId,
          after: oldWatermark,
          through: rebuilt.watermark,
          maxBytes: 16_384,
        }),
      RuntimeTranscriptResetRequiredError,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("normal append and advance do not decode canonical full history", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-transcript-suffix-only-"));
  const workspace = join(root, "workspace");
  const storage = join(root, "storage");
  mkdirSync(workspace, { recursive: true });
  let store = new SqliteRuntimeEventStore({ storageRoot: storage });
  try {
    const sessionId = "suffix-session";
    await store.initializeSession({ sessionId, workDir: workspace });
    const first = await store.append(message("first-event", sessionId, "user", "first"));
    store.close();

    // Deliberately make the old canonical payload undecodable after its projection is current.
    // The suffix path must not touch it; a rebuild would fail closed on this same row.
    const database = new DatabaseSync(operationalDatabasePath(storage));
    database
      .prepare("UPDATE runtime_events SET payload_json = '{' WHERE event_id = ?")
      .run("first-event");
    database.close();

    store = new SqliteRuntimeEventStore({ storageRoot: storage });
    const second = await store.append(
      message("second-event", sessionId, "assistant", "second", "run-2", "turn-2"),
    );
    const advance = await store.readTranscriptAdvancePage({
      sessionId,
      after: first.transcriptWatermark!,
      through: second.transcriptWatermark!,
      maxBytes: 16_384,
    });
    assert.deepEqual(
      advance.changes.map((change) =>
        change.op === "upsert" ? change.record.itemId : change.itemId,
      ),
      ["message:turn-2:assistant"],
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
