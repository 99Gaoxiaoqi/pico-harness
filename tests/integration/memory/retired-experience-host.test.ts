import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { MemoryRecallTrace } from "@pico/core";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { DesktopAtomicMemoryService } from "../../../packages/pico-host/src/desktop-atomic-memory-service.js";
import { querySessionExecution } from "../../../packages/pico-host/src/session-execution-query.js";
import { resolvePicoPaths } from "../../../packages/pico-host/src/pico-paths.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("retired deep links respect workspace receipts; recall projection removes sources without rewriting journal", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-retired-host-"));
  const picoHome = join(root, "home"),
    workDir = join(root, "workspace"),
    otherDir = join(root, "other");
  mkdirSync(workDir);
  mkdirSync(otherDir);
  mkdirSync(picoHome);
  const paths = resolvePicoPaths(workDir, { picoHome });
  const memoryPath = join(picoHome, "memory.sqlite");
  const memories = new SqliteMemoryItemStore(memoryPath);
  const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  const service = new DesktopAtomicMemoryService({ picoHome, publish() {} });
  try {
    const itemId = "retired-item";
    const identity = hash(JSON.stringify(["workspace", paths.workspace.id, itemId]));
    const db = new DatabaseSync(memoryPath);
    try {
      db.prepare("INSERT INTO memory_write_operations VALUES(?,'delete',?,'[]',?)").run(
        `retire-execution-lesson:v14:item:${identity}`,
        hash("retirement"),
        1,
      );
    } finally {
      db.close();
    }
    await assert.rejects(service.get(workDir, itemId, 2), /旧版经验已移除/);
    await assert.rejects(service.get(otherDir, itemId, 2), /当前工作区没有这条记忆/);
    await assert.rejects(service.get(workDir, "unrelated", 2), /当前工作区没有这条记忆/);

    await events.initializeSession({ sessionId: "session", workDir });
    const ownerFence = await events.advanceOwnerFence("session", 0);
    const source = { sessionId: "session", runId: "run", turnId: "turn", eventId: "user" };
    const trace: MemoryRecallTrace = {
      version: 1,
      mode: "automatic",
      workspaceKey: paths.workspace.id,
      queryHash: hash("query"),
      queryRef: { eventId: "user" },
      outcome: "selected",
      stages: { exact: 1, prefix: 0, content: 0, compound: 0, candidates: 1 },
      budget: { maxItems: 3, maxTokens: 320, usedItems: 1, usedTokens: 20, truncated: false },
      counts: { selected: 1, duplicate: 0, budget: 0, item_limit: 0 },
      selected: [
        {
          itemId,
          itemVersion: 1,
          contentHash: hash("body"),
          referenceHash: hash("reference"),
          range: { start: 0, end: 4, total: 4 },
          excerpt: false,
          match: "key",
          source: "execution-evidence",
          sourceCount: 1,
          sources: [source],
        },
      ],
      diagnostics: [],
      elapsedMs: 1,
      traceTruncated: false,
      omittedDiagnosticCount: 0,
      omittedSourceCount: 0,
    };
    const base = {
      schemaVersion: 2 as const,
      sessionId: "session",
      runId: "run",
      turnId: "turn",
      invocationId: "invocation",
      at: "2026-10-13T00:00:00Z",
      partial: false,
      visibility: "internal" as const,
    };
    await events.appendBatch(
      [
        {
          ...base,
          eventId: "start",
          kind: "run.started",
          data: { workDir, agentSwarmAuthorization: "none" },
        },
        {
          ...base,
          eventId: "user",
          kind: "message.committed",
          data: { message: { role: "user", content: "原始请求保留" } },
        },
        { ...base, eventId: "recall", kind: "memory.recall.recorded", data: trace },
        { ...base, eventId: "terminal", kind: "run.terminal", data: { status: "completed" } },
      ],
      { ownerFence },
    );
    const page = querySessionExecution(
      paths.workspace.root,
      { sessionId: "session" },
      { memoryDatabasePath: memoryPath, workspaceKey: paths.workspace.id },
    );
    const memory = page.runs[0]!.steps.find((step) => step.memory)!.memory!;
    assert.deepEqual(memory.items, [{ itemId, state: "deleted", linkAvailable: false }]);
    assert.deepEqual(memory.sources, []);
    assert.deepEqual(memory.trace.selected[0]!.sources, []);
    assert.equal(memory.trace.selected[0]!.sourceCount, 0);
    const original = await events.readSessionEvent("session", "recall");
    assert.equal(original?.event.kind, "memory.recall.recorded");
    if (original?.event.kind === "memory.recall.recorded")
      assert.deepEqual(original.event.data, trace);
  } finally {
    service.close();
    memories.close();
    await events.close();
    rmSync(root, { recursive: true, force: true });
  }
});
