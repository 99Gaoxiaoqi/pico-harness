import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SideChatAuthority,
  SideChatNoSettledTurnError,
  latestCompletedTurnBoundary,
  readSideChatLeases,
} from "../../src/daemon/side-chat-authority.js";
import type { RuntimeEvent, RuntimeTerminalStatus } from "../../src/engine/session-runtime-event.js";
import { closeAllOperationalDatabasesForTest } from "../../src/storage/sqlite/sqlite-database.js";

function terminal(eventId: string, status: RuntimeTerminalStatus): RuntimeEvent {
  return {
    schemaVersion: 2,
    eventId,
    sessionId: "source",
    invocationId: `invocation-${eventId}`,
    runId: `run-${eventId}`,
    turnId: `turn-${eventId}`,
    at: "2026-08-23T00:00:00.000Z",
    partial: false,
    visibility: "internal",
    kind: "run.terminal",
    data: { status },
  };
}

test("side chat selects only the latest successfully completed turn", () => {
  const events = [terminal("completed-1", "completed"), terminal("failed", "failed")];
  assert.equal(latestCompletedTurnBoundary(events)?.eventId, "completed-1");
  assert.equal(latestCompletedTurnBoundary([terminal("failed", "failed")]), undefined);
});

test("side chat persists a recoverable lease and removes it only after cleanup succeeds", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-side-chat-"));
  context.after(async () => {
    closeAllOperationalDatabasesForTest();
    await rm(root, { recursive: true, force: true });
  });
  const forked: unknown[] = [];
  const marked: string[] = [];
  const removed: string[] = [];
  const authority = new SideChatAuthority({
    storageRoot: join(root, "storage"),
    now: () => new Date("2026-08-23T00:00:00.000Z"),
    fork: async (input) => void forked.push(input),
    markSideConversation: async (sessionId) => void marked.push(sessionId),
    removeSession: async (sessionId) => void removed.push(sessionId),
  });

  const lease = await authority.create({
    panelId: "panel-1",
    sourceSessionId: "source",
    targetSessionId: "side-1",
    sourceEvents: [terminal("completed", "completed"), terminal("failed", "failed")],
  });
  assert.equal(lease.state, "live");
  assert.deepEqual(forked, [
    { sourceSessionId: "source", targetSessionId: "side-1", throughEventId: "completed" },
  ]);
  assert.deepEqual(marked, ["side-1"]);
  assert.equal(readSideChatLeases(join(root, "storage")).length, 1);

  await authority.cleanup("side-1");
  assert.deepEqual(removed, ["side-1"]);
  assert.deepEqual(readSideChatLeases(join(root, "storage")), []);
});

test("side chat rejects creation when the parent has no completed turn", async () => {
  const authority = new SideChatAuthority({
    storageRoot: join(tmpdir(), `pico-side-chat-no-turn-${process.pid}`),
    fork: async () => undefined,
    markSideConversation: async () => undefined,
    removeSession: async () => undefined,
  });
  await assert.rejects(
    authority.create({
      panelId: "panel",
      sourceSessionId: "source",
      targetSessionId: "target",
      sourceEvents: [terminal("failed", "failed")],
    }),
    SideChatNoSettledTurnError,
  );
});

test("side chat live lease heartbeat postpones crash recovery cleanup", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-side-chat-heartbeat-"));
  context.after(async () => {
    closeAllOperationalDatabasesForTest();
    await rm(root, { recursive: true, force: true });
  });
  let now = new Date("2026-08-23T00:00:00.000Z");
  const removed: string[] = [];
  const authority = new SideChatAuthority({
    storageRoot: join(root, "storage"),
    now: () => now,
    liveLeaseTtlMs: 60_000,
    fork: async () => undefined,
    markSideConversation: async () => undefined,
    removeSession: async (sessionId) => void removed.push(sessionId),
  });

  await authority.create({
    panelId: "panel-1",
    sourceSessionId: "source",
    targetSessionId: "side-1",
    sourceEvents: [terminal("completed", "completed")],
  });
  now = new Date("2026-08-23T00:00:30.000Z");
  const refreshed = await authority.create({
    panelId: "panel-1",
    sourceSessionId: "source",
    targetSessionId: "unused-idempotent-target",
    sourceEvents: [terminal("completed", "completed")],
  });
  assert.equal(refreshed.targetSessionId, "side-1");
  assert.equal(refreshed.updatedAt, "2026-08-23T00:00:30.000Z");

  now = new Date("2026-08-23T00:01:15.000Z");
  await authority.recover();
  assert.deepEqual(removed, []);
  assert.equal(authority.list().length, 1);

  now = new Date("2026-08-23T00:01:31.000Z");
  await authority.recover();
  assert.deepEqual(removed, ["side-1"]);
  assert.deepEqual(authority.list(), []);
});
