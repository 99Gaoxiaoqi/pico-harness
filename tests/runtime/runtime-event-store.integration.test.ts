import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../../src/runtime/runtime-event.js";
import { materializeRuntimeHistory } from "../../src/runtime/runtime-event-read-model.js";
import {
  RuntimeEventStore,
  RuntimeEventStoreIntegrityError,
} from "../../src/runtime/runtime-event-store.js";

describe("RuntimeEventStore", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "pico-runtime-events-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("initializes a versioned runtime session manifest without treating it as a mutable projection", async () => {
    const store = new RuntimeEventStore({ databasePath: join(baseDir, "runtime.sqlite") });

    const manifest = await store.initializeSession({
      sessionId: "session-a",
      workDir: "/workspace/a",
      now: () => new Date("2026-07-15T00:00:00.000Z"),
    });

    expect(manifest).toEqual({
      schemaVersion: 1,
      sessionId: "session-a",
      workDir: "/workspace/a",
      historySource: "runtime-event-v1",
      createdAt: "2026-07-15T00:00:00.000Z",
      activeBranchId: "main",
    });
    await expect(
      store.initializeSession({ sessionId: "session-a", workDir: "/workspace/b" }),
    ).rejects.toThrow("belongs to another workspace");
  });

  it("appends a canonical event exactly once and rejects divergent reuse of its id", async () => {
    const store = new RuntimeEventStore({ databasePath: join(baseDir, "runtime.sqlite") });
    const event = messageEvent("event-a", "run-a", "one");
    await store.initializeSession({ sessionId: "session-a", workDir: "/workspace/a" });

    expect((await store.append(event)).inserted).toBe(true);
    expect((await store.append(event)).inserted).toBe(false);
    await expect(
      store.append({ ...event, data: { message: { role: "user", content: "different" } } }),
    ).rejects.toBeInstanceOf(RuntimeEventStoreIntegrityError);

    await expect(store.readRun("session-a", "run-a")).resolves.toEqual([event]);
  });

  it("preserves one durable append order across runs", async () => {
    const store = new RuntimeEventStore({ databasePath: join(baseDir, "runtime.sqlite") });
    await store.initializeSession({ sessionId: "session-a", workDir: "/workspace/a" });
    await store.append(messageEvent("event-a", "run-a", "first", "2026-07-15T00:00:01.000Z"));
    await store.append(messageEvent("event-b", "run-b", "second", "2026-07-15T00:00:00.000Z"));

    expect((await store.readSession("session-a")).map((event) => event.eventId)).toEqual([
      "event-a",
      "event-b",
    ]);
  });

  it("rebuilds same-millisecond cross-run causality from durable append order", async () => {
    const databasePath = join(baseDir, "runtime.sqlite");
    const store = new RuntimeEventStore({ databasePath });
    await store.initializeSession({ sessionId: "session-a", workDir: "/workspace/a" });
    const message = messageEvent("event-message", "run-z", "keep this message");
    const rewind = historyRewoundEvent("event-rewind", "run-a", message.eventId);

    await store.append(message);
    await store.append(rewind);

    const restartedStore = new RuntimeEventStore({ databasePath });
    const events = await restartedStore.readSession("session-a");

    expect(events).toEqual([message, rewind]);
    expect(materializeRuntimeHistory(events)).toEqual([message.data.message]);
    expect(await restartedStore.readRun("session-a", "run-z")).toEqual([message]);
  });

  it("returns a stable durable cursor when the same event is retried after restart", async () => {
    const databasePath = join(baseDir, "runtime.sqlite");
    const store = new RuntimeEventStore({ databasePath });
    await store.initializeSession({ sessionId: "session-a", workDir: "/workspace/a" });
    const first = messageEvent("event-a", "run-a", "first");
    const committed = await store.append(first);
    const restarted = new RuntimeEventStore({ databasePath });
    const retried = await restarted.append(first);

    expect(retried).toEqual({ ...committed, inserted: false });
    expect(await restarted.getHeadCursor("session-a")).toEqual(committed.cursor);
  });

  it("rolls back every event when a later exact-once comparison conflicts", async () => {
    const store = new RuntimeEventStore({ databasePath: join(baseDir, "runtime.sqlite") });
    await store.initializeSession({ sessionId: "session-a", workDir: "/workspace/a" });
    const original = messageEvent("event-a", "run-a", "original");
    await store.append(original);

    const rewind = historyRewoundEvent("replacement:rewind", "session-history");
    const conflicting = messageEvent("event-a", "session-history", "replacement");
    await expect(store.appendBatch([rewind, conflicting])).rejects.toBeInstanceOf(
      RuntimeEventStoreIntegrityError,
    );

    await expect(store.readSession("session-a")).resolves.toEqual([original]);
    expect(await store.readSessionManifest("session-a")).toEqual(
      expect.objectContaining({ activeBranchId: "main" }),
    );
  });

  it("rolls back a history replacement when SQLite fails after the rewind insert", async () => {
    const databasePath = join(baseDir, "runtime.sqlite");
    const store = new RuntimeEventStore({ databasePath });
    await store.initializeSession({ sessionId: "session-a", workDir: "/workspace/a" });
    const original = messageEvent("event-a", "run-a", "original");
    await store.append(original);

    const database = new Database(databasePath);
    try {
      database.exec(`CREATE TRIGGER fail_replacement_message
        BEFORE INSERT ON agent_runtime_events
        WHEN NEW.event_id = 'replacement:message:0'
        BEGIN
          SELECT RAISE(ABORT, 'injected replacement failure');
        END;`);
    } finally {
      database.close();
    }

    const rewind = historyRewoundEvent("replacement:rewind", "session-history");
    const replacement = messageEvent("replacement:message:0", "session-history", "replacement");
    await expect(store.appendBatch([rewind, replacement])).rejects.toThrow(
      "injected replacement failure",
    );

    const events = await store.readSession("session-a");
    expect(events).toEqual([original]);
    expect(materializeRuntimeHistory(events)).toEqual([original.data.message]);
    expect(await store.readSessionManifest("session-a")).toEqual(
      expect.objectContaining({ activeBranchId: "main" }),
    );
  });

  it("retries an already committed batch exactly once per event", async () => {
    const store = new RuntimeEventStore({ databasePath: join(baseDir, "runtime.sqlite") });
    await store.initializeSession({ sessionId: "session-a", workDir: "/workspace/a" });
    const batch = [
      historyRewoundEvent("replacement:rewind", "session-history"),
      messageEvent("replacement:message:0", "session-history", "replacement"),
    ] as const;

    expect((await store.appendBatch(batch)).map(({ inserted }) => inserted)).toEqual([true, true]);
    expect((await store.appendBatch(batch)).map(({ inserted }) => inserted)).toEqual([
      false,
      false,
    ]);
    expect(materializeRuntimeHistory(await store.readSession("session-a"))).toEqual([
      batch[1].data.message,
    ]);
  });
});

function messageEvent(
  eventId: string,
  runId: string,
  content: string,
  at = "2026-07-15T00:00:00.000Z",
): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId,
    sessionId: "session-a",
    invocationId: "invocation-a",
    runId,
    turnId: "turn-a",
    at,
    partial: false,
    visibility: "model",
    kind: "message.committed",
    data: { message: { role: "user", content } },
  };
}

function historyRewoundEvent(
  eventId: string,
  runId: string,
  throughEventId?: string,
  at = "2026-07-15T00:00:00.000Z",
): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId,
    sessionId: "session-a",
    invocationId: "invocation-a",
    runId,
    turnId: "turn-a",
    at,
    partial: false,
    visibility: "model",
    kind: "history.rewound",
    data: { branchId: eventId, ...(throughEventId ? { throughEventId } : {}) },
  };
}
