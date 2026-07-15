import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Session } from "../../src/engine/session.js";
import { FTS5Store } from "../../src/memory/fts5-store.js";
import { InMemorySearchStore } from "../../src/memory/in-memory-search-store.js";
import type { ConversationSearchStore } from "../../src/memory/memory-store.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { RuntimeEvent } from "../../src/runtime/runtime-event.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";

describe("runtime projection incremental performance", () => {
  let workDir: string;
  const sessions: Session[] = [];

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-runtime-projection-"));
  });

  afterEach(async () => {
    await Promise.allSettled(sessions.splice(0).map((session) => session.close()));
    await rm(resolvePicoPaths(workDir).workspace.root, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("uses one delta projection per long-session batch without repeated full replay or replace", async () => {
    const searchStore = new FTS5Store(workDir);
    expect(searchStore.status.state).toBe("healthy");
    const fullReplay = vi.spyOn(RuntimeEventStore.prototype, "readSessionProjection");
    const deltaRead = vi.spyOn(RuntimeEventStore.prototype, "readSessionProjectionDelta");
    const legacyFullRead = vi.spyOn(RuntimeEventStore.prototype, "readSessionEntries");
    const projectReplace = vi.spyOn(searchStore, "projectReplace");
    const projectAppend = vi.spyOn(searchStore, "projectAppend");
    const session = await openSession("long-session", searchStore);

    fullReplay.mockClear();
    deltaRead.mockClear();
    legacyFullRead.mockClear();
    projectReplace.mockClear();
    projectAppend.mockClear();

    const batchCount = 24;
    for (let index = 0; index < batchCount; index++) {
      await session.commitMessages(
        { role: "user", content: `request-${index}` },
        { role: "assistant", content: `response-${index}` },
      );
    }

    expect(session.length).toBe(batchCount * 2);
    expect(fullReplay).toHaveBeenCalledTimes(1);
    expect(projectReplace).toHaveBeenCalledTimes(1);
    expect(deltaRead).toHaveBeenCalledTimes(batchCount - 1);
    expect(projectAppend).toHaveBeenCalledTimes(batchCount - 1);
    expect(legacyFullRead).not.toHaveBeenCalled();
    expect(projectAppend.mock.calls.every((call) => call[2].length === 2)).toBe(true);
  });

  it("increments a complete tool-call batch once and preserves existing tool-result metadata", async () => {
    const searchStore = new InMemorySearchStore();
    const session = await openSession("tool-batch", searchStore);
    await session.commitMessages({ role: "user", content: "seed" });
    const fullReplay = vi.spyOn(RuntimeEventStore.prototype, "readSessionProjection");
    const projectReplace = vi.spyOn(searchStore, "projectReplace");
    const projectAppend = vi.spyOn(searchStore, "projectAppend");

    await session.commitMessages(
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-a", name: "read", arguments: "{}" },
          { id: "call-b", name: "grep", arguments: "{}" },
        ],
      },
      { role: "user", toolCallId: "call-a", content: "alpha result" },
      { role: "user", toolCallId: "call-b", content: "beta result" },
    );

    expect(projectAppend).toHaveBeenCalledOnce();
    expect(projectAppend.mock.calls[0]![2]).toHaveLength(3);
    expect(session.hasPendingToolResults()).toBe(false);
    expect([...session.getToolResultMeta().keys()]).toEqual(["call-a", "call-b"]);
    session.getModelContext();
    expect(session.getToolResultMeta().get("call-a")?.accessCount).toBe(1);
    expect(session.getToolResultMeta().get("call-b")?.accessCount).toBe(1);

    await session.commitMessages({ role: "user", content: "follow-up" });

    expect(fullReplay).not.toHaveBeenCalled();
    expect(projectReplace).not.toHaveBeenCalled();
    expect(projectAppend).toHaveBeenCalledTimes(2);
    expect(session.getToolResultMeta().get("call-a")?.accessCount).toBe(1);
    expect(session.search("alpha result")).toContainEqual(
      expect.objectContaining({ sessionId: session.id, turnIndex: 2, content: "alpha result" }),
    );
  });

  it("falls back to canonical replay for a duplicate exactly-once event ID", async () => {
    const searchStore = new InMemorySearchStore();
    const session = await openSession("exactly-once", searchStore);
    await session.commitMessages({ role: "user", content: "seed" });
    const fullReplay = vi.spyOn(RuntimeEventStore.prototype, "readSessionProjection");
    const deltaRead = vi.spyOn(RuntimeEventStore.prototype, "readSessionProjectionDelta");
    const projectReplace = vi.spyOn(searchStore, "projectReplace");
    const projectAppend = vi.spyOn(searchStore, "projectAppend");
    const message = { role: "assistant" as const, content: "stable completion" };

    const first = await session.commitMessageOnce("completion:stable", message);
    const retry = await session.commitMessageOnce("completion:stable", message);

    expect(first.inserted).toBe(true);
    expect(retry.inserted).toBe(false);
    expect(deltaRead).toHaveBeenCalledOnce();
    expect(projectAppend).toHaveBeenCalledOnce();
    expect(fullReplay).toHaveBeenCalledOnce();
    expect(projectReplace).toHaveBeenCalledOnce();
    expect(session.getHistory()).toEqual([{ role: "user", content: "seed" }, message]);
    expect(session.search("stable completion")).toHaveLength(1);
    const events = await session.runtimeEventStore!.readSession(session.id);
    expect(events.filter((event) => event.eventId === "completion:stable")).toHaveLength(1);
  });

  it("repairs a mismatched search cursor with one full canonical replay", async () => {
    const searchStore = new InMemorySearchStore();
    const session = await openSession("cursor-mismatch", searchStore);
    await session.commitMessages({ role: "user", content: "seed" });
    const canonicalCursor = searchStore.getProjectionCursor(session.id)!;
    searchStore.projectReplace(session.id, session.getHistory(), {
      ...canonicalCursor,
      eventId: "stale-index-cursor",
    });
    const fullReplay = vi.spyOn(RuntimeEventStore.prototype, "readSessionProjection");
    const deltaRead = vi.spyOn(RuntimeEventStore.prototype, "readSessionProjectionDelta");
    const projectReplace = vi.spyOn(searchStore, "projectReplace");
    const projectAppend = vi.spyOn(searchStore, "projectAppend");

    await session.commitMessages({ role: "assistant", content: "repaired" });

    expect(deltaRead).not.toHaveBeenCalled();
    expect(projectAppend).not.toHaveBeenCalled();
    expect(fullReplay).toHaveBeenCalledOnce();
    expect(projectReplace).toHaveBeenCalledOnce();
    expect(searchStore.getProjectionCursor(session.id)?.eventId).not.toBe("stale-index-cursor");
    expect(session.search("repaired")).toHaveLength(1);
  });

  it("catches up message and non-message facts appended by another store", async () => {
    const searchStore = new InMemorySearchStore();
    const session = await openSession("external-catch-up", searchStore);
    await session.commitMessages({ role: "user", content: "seed" });
    const independentStore = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
    });
    const externalCommits = await independentStore.appendBatch([
      externalMessageEvent(session.id, "between stores"),
      externalRunStartedEvent(session.id, workDir),
    ]);
    const fullReplay = vi.spyOn(RuntimeEventStore.prototype, "readSessionProjection");
    const deltaRead = vi.spyOn(RuntimeEventStore.prototype, "readSessionProjectionDelta");
    const projectReplace = vi.spyOn(searchStore, "projectReplace");
    const projectAppend = vi.spyOn(searchStore, "projectAppend");

    await session.commitMessages({ role: "assistant", content: "after external facts" });

    expect(deltaRead).toHaveBeenCalledOnce();
    expect(fullReplay).not.toHaveBeenCalled();
    expect(projectReplace).not.toHaveBeenCalled();
    expect(projectAppend).toHaveBeenCalledOnce();
    expect(projectAppend.mock.calls[0]![2].map((message) => message.content)).toEqual([
      "between stores",
      "after external facts",
    ]);
    expect(session.getHistory().map((message) => message.content)).toEqual([
      "seed",
      "between stores",
      "after external facts",
    ]);
    expect(session.search("between stores")).toContainEqual(
      expect.objectContaining({ turnIndex: 1, content: "between stores" }),
    );
    expect(session.search("after external facts")).toContainEqual(
      expect.objectContaining({ turnIndex: 2, content: "after external facts" }),
    );

    const entries = await independentStore.readSessionEntries(session.id);
    const target = entries.find(
      (entry) =>
        entry.event.kind === "message.committed" &&
        entry.event.data.message.content === "after external facts",
    );
    expect(target).toBeDefined();
    expect(searchStore.getProjectionCursor(session.id)).toEqual({
      logId: session.id,
      seq: target!.sequence,
      epoch: externalCommits.at(-1)!.cursor.epoch,
      eventId: target!.event.eventId,
    });
    expect(target!.sequence).toBeGreaterThan(externalCommits.at(-1)!.cursor.seq);
  });

  it("replays canonically when an external rewind changes the active branch", async () => {
    const searchStore = new InMemorySearchStore();
    const session = await openSession("external-rewind", searchStore);
    await session.commitMessages({ role: "user", content: "first" });
    await session.commitMessages({ role: "assistant", content: "discarded" });
    const store = session.runtimeEventStore!;
    const firstMessage = (await store.readSession(session.id)).find(
      (event) => event.kind === "message.committed" && event.data.message.content === "first",
    );
    expect(firstMessage).toBeDefined();
    await store.append(externalRewindEvent(session.id, firstMessage!.eventId));
    const fullReplay = vi.spyOn(RuntimeEventStore.prototype, "readSessionProjection");
    const deltaRead = vi.spyOn(RuntimeEventStore.prototype, "readSessionProjectionDelta");
    const projectReplace = vi.spyOn(searchStore, "projectReplace");
    const projectAppend = vi.spyOn(searchStore, "projectAppend");

    await session.commitMessages({ role: "user", content: "after rewind" });

    expect(deltaRead).toHaveBeenCalledOnce();
    expect(projectAppend).not.toHaveBeenCalled();
    expect(fullReplay).toHaveBeenCalledOnce();
    expect(projectReplace).toHaveBeenCalledOnce();
    expect(session.getHistory().map((message) => message.content)).toEqual([
      "first",
      "after rewind",
    ]);
    expect(session.search("discarded")).toEqual([]);
  });

  it("rebuilds once on restart and resumes with deltas", async () => {
    const firstStore = new InMemorySearchStore();
    const first = await openSession("restart", firstStore);
    await first.commitMessages({ role: "user", content: "before restart" });
    await first.commitMessages({ role: "assistant", content: "persisted answer" });
    await first.close();

    const restartedStore = new InMemorySearchStore();
    const fullReplay = vi.spyOn(RuntimeEventStore.prototype, "readSessionProjection");
    const deltaRead = vi.spyOn(RuntimeEventStore.prototype, "readSessionProjectionDelta");
    const projectReplace = vi.spyOn(restartedStore, "projectReplace");
    const projectAppend = vi.spyOn(restartedStore, "projectAppend");
    const restarted = await openSession("restart", restartedStore);

    await restarted.commitMessages({ role: "user", content: "after restart" });

    expect(fullReplay).toHaveBeenCalledOnce();
    expect(projectReplace).toHaveBeenCalledOnce();
    expect(deltaRead).toHaveBeenCalledOnce();
    expect(projectAppend).toHaveBeenCalledOnce();
    expect(restarted.getHistory().map((message) => message.content)).toEqual([
      "before restart",
      "persisted answer",
      "after restart",
    ]);
    expect(restarted.search("before restart")).toContainEqual(
      expect.objectContaining({ content: "before restart", turnIndex: 0 }),
    );
    expect(restarted.search("after restart")).toContainEqual(
      expect.objectContaining({ content: "after restart", turnIndex: 2 }),
    );
  });

  async function openSession(id: string, searchStore: ConversationSearchStore): Promise<Session> {
    const session = new Session(id, workDir, {
      persistence: true,
      memorySearchStore: searchStore,
    });
    sessions.push(session);
    await session.recover();
    return session;
  }
});

function externalRewindEvent(sessionId: string, throughEventId: string): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: "external-rewind:event",
    sessionId,
    invocationId: "external-rewind",
    runId: "external-rewind",
    turnId: "external-rewind",
    at: new Date().toISOString(),
    partial: false,
    visibility: "internal",
    kind: "history.rewound",
    data: { branchId: "external-rewind:branch", throughEventId },
  };
}

function externalMessageEvent(sessionId: string, content: string): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: "external-message:event",
    sessionId,
    invocationId: "external-message",
    runId: "external-message",
    turnId: "external-message",
    at: new Date().toISOString(),
    partial: false,
    visibility: "model",
    kind: "message.committed",
    data: { message: { role: "user", content } },
  };
}

function externalRunStartedEvent(sessionId: string, workDir: string): RuntimeEvent {
  return {
    schemaVersion: 1,
    eventId: "external-run-started:event",
    sessionId,
    invocationId: "external-run-started",
    runId: "external-run-started",
    turnId: "external-run-started",
    at: new Date().toISOString(),
    partial: false,
    visibility: "internal",
    kind: "run.started",
    data: { workDir },
  };
}
