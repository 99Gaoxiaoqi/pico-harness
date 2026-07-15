import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const store = new RuntimeEventStore({ baseDir });

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
    const store = new RuntimeEventStore({ baseDir });
    const event = messageEvent("event-a", "run-a", "one");

    expect(await store.append(event)).toEqual({ inserted: true });
    expect(await store.append(event)).toEqual({ inserted: false });
    await expect(
      store.append({ ...event, data: { message: { role: "user", content: "different" } } }),
    ).rejects.toBeInstanceOf(RuntimeEventStoreIntegrityError);

    await expect(store.readRun("session-a", "run-a")).resolves.toEqual([event]);
  });

  it("orders a session replay deterministically across run logs", async () => {
    const store = new RuntimeEventStore({ baseDir });
    await store.append(messageEvent("event-b", "run-b", "second", "2026-07-15T00:00:01.000Z"));
    await store.append(messageEvent("event-a", "run-a", "first", "2026-07-15T00:00:00.000Z"));

    expect((await store.readSession("session-a")).map((event) => event.eventId)).toEqual([
      "event-a",
      "event-b",
    ]);
  });

  it("rebuilds same-millisecond cross-run causality from durable append order", async () => {
    const store = new RuntimeEventStore({ baseDir });
    const message = messageEvent("event-message", "run-z", "keep this message");
    const rewind = historyRewoundEvent("event-rewind", "run-a", message.eventId);

    await store.append(message);
    await store.append(rewind);

    const restartedStore = new RuntimeEventStore({ baseDir });
    const events = await restartedStore.readSession("session-a");

    expect(events).toEqual([message, rewind]);
    expect(materializeRuntimeHistory(events)).toEqual([message.data.message]);
    expect(
      JSON.parse((await readFile(store.runtimeEventsPath("session-a", "run-z"), "utf8")).trim()),
    ).toEqual(message);
  });

  it("repairs only a torn final line before the next durable append", async () => {
    const store = new RuntimeEventStore({ baseDir });
    const first = messageEvent("event-a", "run-a", "first");
    await store.append(first);
    const path = store.runtimeEventsPath("session-a", "run-a");
    await writeFile(path, `${JSON.stringify(first)}\n{"eventId":"partial`, "utf8");

    const second = messageEvent("event-b", "run-a", "second", "2026-07-15T00:00:01.000Z");
    await store.append(second);

    expect((await store.readRun("session-a", "run-a")).map((event) => event.eventId)).toEqual([
      "event-a",
      "event-b",
    ]);
    expect(await readFile(path, "utf8")).toContain("event-b");
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
  throughEventId: string,
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
    data: { branchId: "main", throughEventId },
  };
}
